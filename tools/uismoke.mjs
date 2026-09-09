// UI 정적 스모크(P8) — 브라우저 없이 잡을 수 있는 배선 결함을 push 전에 전수 대조.
// (진짜 헤드리스 브라우저는 앱 저장소의 no-node_modules 원칙과 충돌 — 이 세션들에서 실제 결함을
//  잡아온 검증들을 자동화한 것: ID 배선·탭 배선·앱/서버 레지스트리 일치·sw 버전업 누락)
// 실행: node tools/uismoke.mjs
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const gwd = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8');
const auth = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-auth.js'), 'utf8');

let fails = 0;
const T = (name, ok, note) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : ' — ' + note)); if (!ok) fails++; };

// 1) getElementById 리터럴 참조 ↔ id 존재 (동적 생성분은 JS 문자열 안의 id="..."로 함께 잡힘)
const ids = new Set([...html.matchAll(/id="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
const refs = new Set([...html.matchAll(/getElementById\(\s*"([A-Za-z][\w-]*)"\s*\)/g)].map((m) => m[1]));
const missing = [...refs].filter((r) => !ids.has(r));
T('getElementById 참조 ' + refs.size + '개 전부 존재', missing.length === 0, '없는 ID: ' + missing.join(', '));

// 2) 탭 배선: data-tab / switchTab("...") → view-X 존재
const tabRefs = new Set([
  ...[...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/switchTab\("([\w-]+)"\)/g)].map((m) => m[1]),
]);
const badTabs = [...tabRefs].filter((t) => !ids.has('view-' + t));
T('탭 ' + tabRefs.size + '개 전부 view 존재', badTabs.length === 0, 'view 없음: ' + badTabs.join(', '));

// 3) 양식 키: 앱 TPL_LABELS ↔ 서버 TPL_KEYS 완전 일치
const grabKeys = (src, anchor) => {
  const i = src.indexOf(anchor); const seg = src.slice(i, src.indexOf('};', i));
  return new Set([...seg.matchAll(/(\w+)\s*:\s*['"]/g)].map((m) => m[1]));
};
const appTpl = grabKeys(html, 'var TPL_LABELS='), svrTpl = grabKeys(gwd, 'const TPL_KEYS = {');
const onlyApp = [...appTpl].filter((k) => !svrTpl.has(k)), onlySvr = [...svrTpl].filter((k) => !appTpl.has(k));
T('양식 키 앱↔서버 일치(' + appTpl.size + '종)', !onlyApp.length && !onlySvr.length, '앱만: ' + onlyApp + ' / 서버만: ' + onlySvr);

// 4) 권한 레지스트리: gw-auth MODULES == gw-data COL 값 − {leaves(전원 저장 설계), bid·fam(관리자 고정 — 서버 ADMIN_ONLY)·hr(인사 탭 관리자 전용 — edu는 서버가 비관리자에게 본인분만)}
//    — 'wk' 누락으로 일용직 권한이 저장마다 증발했던 실사고의 재발 방지
const mods = new Set((auth.match(/const MODULES = \[([^\]]+)\]/) || [])[1].match(/'(\w+)'/g).map((s) => s.replace(/'/g, '')));
const colSeg = (gwd.match(/const COL = \{([^}]+)\}/) || [])[1];
const colVals = new Set([...colSeg.matchAll(/:\s*'(\w+)'/g)].map((m) => m[1]));
colVals.delete('leaves'); colVals.delete('bid'); colVals.delete('fam'); colVals.delete('hr');
const dm = [...colVals].filter((v) => !mods.has(v)), dx = [...mods].filter((v) => !colVals.has(v));
T('권한 레지스트리 auth↔data 일치', !dm.length && !dx.length, 'auth 누락: ' + dm + ' / auth 잉여: ' + dx);

// 4a) 권한관리 화면 열 목록(PERM_ORDER)도 앱 MODULES와 일치해야 한다 —
//     wk(일용직)·promo(홍보) 누락으로 매트릭스에 열이 안 떠 권한 부여가 불가능했던 실사고 2회의 재발 방지
{
  const po = new Set(((html.match(/var PERM_ORDER = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, '')));
  const am = new Set(((html.match(/var MODULES = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, '')));
  const pm = [...am].filter((v) => !po.has(v)), px = [...po].filter((v) => !am.has(v));
  T('권한관리 열(PERM_ORDER)↔MODULES 일치', !pm.length && !px.length, 'PERM_ORDER 누락: ' + pm + ' / 잉여: ' + px);
}

// 4b) 저장 경로 완전성: 앱이 선언한 data/*.json 경로는 전부 fetch 인터셉터(_urlCollection)에 매핑되고,
//     매핑된 컬렉션은 서버(COL·PRIVATE_COL)가 알아야 한다 — quotes 누락으로 견적 탭이 GitHub 직행(401)해
//     개설 이래 저장 0건이던 실사고의 재발 방지.
{
  const LEGACY_UNMAPPED = new Set();
  const declared = [...html.matchAll(/var \w+_PATH = "data\/([\w.]+)"/g)].map((m) => m[1]);
  const segIC = html.slice(html.indexOf('function _urlCollection'), html.indexOf('return null;', html.indexOf('function _urlCollection')));
  const mapped = {};   // 파일명 → 컬렉션명
  [...segIC.matchAll(/indexOf\("([\w.]+)"\)\s*>=\s*0\)\s*return\s*"(\w+)"/g)].forEach((m) => { mapped[m[1]] = m[2]; });
  const unmapped = declared.filter((f) => !(f in mapped) && !LEGACY_UNMAPPED.has(f));
  T('데이터 경로 ' + declared.length + '개 전부 인터셉터 매핑', unmapped.length === 0, 'GitHub 직행(저장 유실 위험): ' + unmapped.join(', '));
  const colSeg2 = (gwd.match(/const COL = \{([^}]+)\}/) || ['', ''])[1];
  const svrCols = new Set([...colSeg2.matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
  const privSeg = (gwd.match(/const PRIVATE_COL = \{([^}]+)\}/) || ['', ''])[1];
  [...privSeg.matchAll(/(\w+)\s*:/g)].forEach((m) => svrCols.add(m[1]));
  const unknown = Object.values(mapped).filter((c) => !svrCols.has(c));
  T('인터셉터 컬렉션 전부 서버 등록', unknown.length === 0, '서버가 모르는 컬렉션(UNKNOWN_COLLECTION 유발): ' + unknown.join(', '));
}

// 5) sw 버전업 누락 감지: index.html이 변경됐는데 sw.js가 그대로면 실패(둘 다 clean이면 통과)
try {
  const st = execSync('git status --porcelain -- index.html sw.js', { cwd: ROOT, encoding: 'utf8' });
  const dirtyIdx = /index\.html/.test(st), dirtySw = /sw\.js/.test(st);
  T('sw.js 버전업(index 변경 시)', !dirtyIdx || dirtySw, 'index.html 수정됨 + sw.js 미수정 — SHELL_CACHE 버전업 필요');
} catch (e) { console.log('  (git 상태 확인 불가 — sw 검사 생략)'); }

// 6) TESTLIST 자동 대조(리포트 — 실패 아님): 버전별 사람 미테스트 항목 집계
try {
  const tl = readFileSync(join(ROOT, 'TESTLIST.md'), 'utf8');
  const secs = tl.split(/^## /m).slice(1);
  let un = 0, done = 0; const pend = [];
  secs.forEach((s) => {
    const title = s.split('\n')[0].trim();
    const u = (s.match(/- \[ \]/g) || []).length, d = (s.match(/- \[x\]/gi) || []).length;
    un += u; done += d;
    if (u) pend.push(title.split(' — ')[0] + '(' + u + ')');
  });
  console.log('  ℹ TESTLIST: 사람 테스트 미완 ' + un + '건 / 완료 ' + done + '건 — ' + (pend.length ? '미완 버전: ' + pend.slice(0, 12).join(' ') + (pend.length > 12 ? ' 외' : '') : '전부 완료'));
} catch (e) { console.log('  (TESTLIST 읽기 실패)'); }

// 7) 화면 안내 문구가 서버 상한과 어긋나지 않는지 — 서버를 올려놓고 화면만 옛말을 하던 사고 재발 방지(2026-08-14).
//    디스패처(gw-promo-ai.js)가 빠져 있어 워커에 max_photos:10을 넘기는 바람에 상한을 30으로
//    올리고도 모델이 앞 10장만 받던 실사고(2026-08-15)의 재발 방지 — 네 파일 전부 대조한다.
try {
  const idx = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const lib = readFileSync(join(ROOT, 'netlify/functions/_lib/promoai.js'), 'utf8');
  const wk = readFileSync(join(ROOT, 'netlify/functions/gw-promo-ai-run-background.js'), 'utf8');
  const dsp = readFileSync(join(ROOT, 'netlify/functions/gw-promo-ai.js'), 'utf8');
  const num = (s, re) => { const m = s.match(re); return m ? parseInt(m[1], 10) : NaN; };
  const nLib = num(lib, /const MAX_PHOTOS = (\d+)/);
  const nWk = num(wk, /const MAX_PHOTOS = (\d+)/);
  const nUi = num(idx, /var PA_MAX_PHOTOS\s*=\s*(\d+)/);
  const nDsp = num(dsp, /const MAX_PHOTOS = (\d+)/);
  T('사진 상한 일치(화면·라이브러리·워커·디스패처)', nLib === nUi && nLib === nWk && nLib === nDsp,
    `라이브러리 ${nLib} / 워커 ${nWk} / 화면 ${nUi} / 디스패처 ${nDsp} — 네 값이 같아야 모델이 전부 받는다`);
  T('사진 장수를 화면에 하드코딩하지 않음', !/앞 10장만|Math\.min\(n,\s*10\)/.test(idx),
    'index.html에 사진 장수가 숫자로 박혀 있다 — PA_MAX_PHOTOS를 쓸 것');

  // 7a) 마커 문법 동률: 앱(PROMO_MARK_RE·PROMO_MARK_NB_RE) ↔ 서버(RE_MARK_BR·RE_MARK_NB).
  //     서버 경고(draftWarnings)는 앱과 같은 문법을 봐야 사실을 말한다 — 마커 형식 3연속 변형
  //     사고(2026-08-15) 때 두 벌을 손으로 맞췄는데, 한쪽만 고치는 편집을 여기서 잡는다.
  const rx = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
  const cBr = rx(idx, /var PROMO_MARK_RE=(\/.+?\/g);/);
  const cNb = rx(idx, /var PROMO_MARK_NB_RE=(\/.+?\/);/);
  const sBr = rx(lib, /const RE_MARK_BR = (\/.+?\/g);/);
  const sNb = rx(lib, /const RE_MARK_NB = (\/.+?\/);/);
  T('마커 정규식 앱↔서버 동률', !!cBr && !!cNb && cBr === sBr && cNb === sNb,
    `대괄호: 앱 ${cBr} vs 서버 ${sBr} / 무괄호: 앱 ${cNb} vs 서버 ${sNb}`);

  // 7b) 제목 원형 사슬(v320) — 라이브러리 exports ↔ 워커 loadLib 필수 목록 ↔ 워커의 이력 blob 키(promoai:hist:)·잡 blob title_type 기록 ↔
  //     화면의 tt 저장(paResults.tt·p.ai.tt)·원형 이름표. 한 고리가 빠지면 라벨이 안 흐르고 추정으로만 돈다(9/4 반박 검증이 지적한 결함).
  const chain = ['pickTitleType', 'recentTitleCandidates', 'recentTitleInfo', 'ownTitleInfo'];
  const expSeg = (lib.match(/module\.exports = \{([\s\S]*?)\};/) || ['', ''])[1];
  const needSeg = (wk.match(/const need = \[([\s\S]*?)\]/) || ['', ''])[1];
  T('제목 원형 사슬: 라이브러리 exports ↔ 워커 필수 목록(' + chain.join('·') + ')', chain.every((f) => new RegExp('\\b' + f + '\\b').test(expSeg) && needSeg.indexOf("'" + f + "'") >= 0),
    'exports 누락: ' + chain.filter((f) => !new RegExp('\\b' + f + '\\b').test(expSeg)).join(',') + ' / need 누락: ' + chain.filter((f) => needSeg.indexOf("'" + f + "'") < 0).join(','));
  T('워커가 이력 blob(promoai:hist:<기록id>)과 잡 blob title_type을 기록하고 input에 own_titles·seed·attempt를 배선', /promoai:hist:\$\{promoId\}/.test(wk) && /rec\.title_type = cleanStr\(r\.title_type/.test(wk) && /blobSet\(st, histKey\(promoId\)/.test(wk) && /own_titles: own/.test(wk) && /seed: promoId/.test(wk) && /attempt: attempt/.test(wk), '');
  T('화면이 결과 tt를 저장(paResults.tt + p.ai.tt 2곳)하고 사람이 제목을 바꾸면 라벨을 지움', /tt:String\(blob\.title_type\|\|r\.title_type\|\|""\)/.test(idx) && (idx.match(/ts:Date\.now\(\), tt:String\(r\.tt\|\|""\)/g) || []).length === 2 && /p\.ai\.tt=""/.test(idx), '');
  const libCodes = [...((lib.match(/var TITLE_TYPES = \[([\s\S]*?)\n\];/) || ['', ''])[1]).matchAll(/\{ code: '([A-Z])'/g)].map((m) => m[1]);
  const uiCodes = [...((idx.match(/var PA_TITLE_TYPE_NAMES=\{([^}]+)\}/) || ['', ''])[1]).matchAll(/([A-Z]):"/g)].map((m) => m[1]);
  T('제목 원형 코드 11종 라이브러리 = 화면 이름표(' + libCodes.join('') + ')', libCodes.length === 11 && libCodes.join('') === uiCodes.join(''), '라이브러리 ' + libCodes.join('') + ' / 화면 ' + uiCodes.join(''));
  T('출력 스키마 title_type enum·required + 제목 규칙 절 4자리 숫자 없음', /title_type: \{ type: 'string', enum: TITLE_CODES/.test(lib) && /required: \['title', 'body', 'tags', 'title_type'\]/.test(lib) && !/\d{4,}/.test(((lib.match(/var TITLE_TYPES = \[([\s\S]*?)\n\];/) || ['', ''])[1]).replace(/[,\s]/g, '')), '');
} catch (e) { console.log('  (사진 상한 대조 생략 — 파일 읽기 실패)'); }

// 8) 크론 등록 ↔ 함수 파일 대조 — 감시 설계 1단계(2026-08-19). netlify.toml의 schedule 선언과
//    실제 *-cron.js 파일이 어긋나면(파일 개명·블록 삭제·오타) 크론이 소리 없이 사라진다.
//    Netlify는 프로덕션 배포의 netlify.toml만 읽으므로, 배포 전에 여기서 잡는 게 마지막 방어선이다.
try {
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  const declared = [...toml.matchAll(/\[functions\."([\w-]+)"\]\s*\r?\n\s*schedule\s*=\s*"([^"]+)"/g)]
    .map((m) => ({ fn: m[1], cron: m[2] }));
  const missing = declared.filter((d) => {
    try { readFileSync(join(ROOT, 'netlify', 'functions', d.fn + '.js'), 'utf8'); return false; }
    catch (e) { return true; }
  });
  T('스케줄 선언 ' + declared.length + '건 전부 함수 파일 존재', missing.length === 0,
    '선언만 있고 파일 없음: ' + missing.map((d) => d.fn).join(', '));
  const cronFiles = ['gw-hwakwan-cron', 'gw-allbaro-cron', 'gw-todo-cron', 'gw-appr-cron'];
  const undeclared = cronFiles.filter((f) => !declared.some((d) => d.fn === f));
  T('크론 함수 전부 스케줄 선언됨', undeclared.length === 0,
    '파일은 있는데 netlify.toml 선언 없음(크론 미등록): ' + undeclared.join(', '));
  T('크론 표현식 5필드 형식', declared.every((d) => d.cron.trim().split(/\s+/).length === 5),
    '깨진 표현식: ' + declared.filter((d) => d.cron.trim().split(/\s+/).length !== 5).map((d) => d.fn + '=' + d.cron).join(', '));
} catch (e) { console.log('  (크론 대조 생략 — netlify.toml 읽기 실패)'); }

// 9) 결재 등급표 동률(결재 3차) — 서버 기본표(APPR_GRADE_DEFAULTS) 키 ↔ 앱 관리 화면 순서 목록(APPR_GRADE_ORDER).
//    한쪽에만 종류를 추가하면 화면에서 편집 불가(또는 유령 행)가 된다 — 마커 정규식 동률 검사와 같은 취지.
try {
  const svrSeg = (gwd.match(/const APPR_GRADE_DEFAULTS = \{([\s\S]*?)\};/) || ['', ''])[1];
  const svrKinds = new Set([...svrSeg.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]));
  const appSeg = (html.match(/var APPR_GRADE_ORDER = \[([^\]]+)\]/) || ['', ''])[1];
  const appKinds = new Set([...appSeg.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const onlyS = [...svrKinds].filter((k) => !appKinds.has(k)), onlyA = [...appKinds].filter((k) => !svrKinds.has(k));
  T('결재 등급표 종류 앱↔서버 일치(' + svrKinds.size + '종)', svrKinds.size > 0 && !onlyS.length && !onlyA.length,
    '서버만: ' + onlyS.join(',') + ' / 앱만: ' + onlyA.join(','));
} catch (e) { console.log('  (결재 등급표 대조 생략 — 파싱 실패)'); }

// 10) v315 동률 검사 — ① 전결 종결 제외 목록(앱 APPR_DRAFT_EXCLUDE ↔ 서버 APPR_SELF_DECIDE_EXCLUDE: 한쪽만 바뀌면 화면이 허용한 종류를 서버가 400으로 튕기거나 반대)
//    ② 문서함 첨부 확장자(앱 DOC_ATT_EXT ↔ 서버 DOC_ATT_EXT: 파일 선택창이 허용한 형식을 서버가 거부하는 사고)
//    ③ 기안 화면 폴백 등급표(APPR_GRADE_DEFAULTS_APP) = 서버 기본표(값까지 — 표를 못 받았을 때 화면이 다른 경로를 말하지 않게)
try {
  const setOf = (seg, re) => new Set([...String(seg || '').matchAll(re)].map((m) => m[1]));
  const eq = (a, b) => a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x));
  const appEx = setOf((html.match(/var APPR_DRAFT_EXCLUDE = \[([^\]]+)\]/) || ['', ''])[1], /"([^"]+)"/g);
  const svrEx = setOf((gwd.match(/const APPR_SELF_DECIDE_EXCLUDE = \{([^}]+)\}/) || ['', ''])[1], /'([^']+)'\s*:/g);
  T('전결 종결 제외 종류 앱↔서버 일치(' + svrEx.size + '종)', eq(appEx, svrEx), '앱: ' + [...appEx].join(',') + ' / 서버: ' + [...svrEx].join(','));
  const appExt = setOf((html.match(/var DOC_ATT_EXT = \[([^\]]+)\]/) || ['', ''])[1], /"([^"]+)"/g);
  const svrExt = setOf((gwd.match(/const DOC_ATT_EXT = \{([^}]+)\}/) || ['', ''])[1], /(\w+)\s*:/g);
  T('문서함 첨부 확장자 앱↔서버 일치(' + svrExt.size + '종)', eq(appExt, svrExt), '앱: ' + [...appExt].join(',') + ' / 서버: ' + [...svrExt].join(','));
  const tbl = (seg) => { const o = {}; [...String(seg || '').matchAll(/["']([^"']+)["']\s*:\s*(\d)/g)].forEach((m) => { o[m[1]] = Number(m[2]); }); return o; };
  const appTbl = tbl((html.match(/var APPR_GRADE_DEFAULTS_APP = \{([^}]+)\}/) || ['', ''])[1]);
  const svrTbl = tbl((gwd.match(/const APPR_GRADE_DEFAULTS = \{([\s\S]*?)\};/) || ['', ''])[1]);
  const ka = Object.keys(appTbl), ks = Object.keys(svrTbl);
  T('기안 화면 폴백 등급표 = 서버 기본표(값 포함)', ks.length > 0 && ka.length === ks.length && ks.every((k) => appTbl[k] === svrTbl[k]),
    '차이: ' + ks.filter((k) => appTbl[k] !== svrTbl[k]).concat(ka.filter((k) => !(k in svrTbl))).join(','));
} catch (e) { console.log('  (v315 동률 검사 생략 — 파싱 실패)'); }

// 11) 문서함 2층 분류(문서체계 설계안 v2 2026-09-04 §6 #25, v317) + 첨부 mime 고정표 동률 — 한쪽만 바꾸면 새 분류가 서버에서 99로 강등되거나 화면에 서랍이 없다.
//    ① 대분류: 앱 DOC_MAJOR = DOC_MAJOR_ORDER = 서버 DOC_MAJOR_LABEL(라벨 텍스트까지, 13종) / 중분류: 앱 DOC_MINOR = DOC_MINOR_ORDER = 서버 DOC_MINOR_LABEL(6종) → 조합 12×6+1 = 73
//    ② 설정 대상 분류: 앱 DOC_SCOPE_CATS = 서버 DOC_SCOPE_CATS = 대분류 − 01
//    ③ docCatOf JW 번호 정규식 앱↔서버 동률 + 의미 검사(4층 번호 → 앞 두 마디, 구형식·구 하위번호는 불일치)
//    ④ 문서 모달 2단 select: 정적 #docCat 없음, #docCatMajor·#docCatMinor 존재, 생성·조회 함수 존재  ⑤ mime 고정표 키 = 확장자 화이트리스트(앱·서버 각각) + 앱 DOC_ATT_MIME = 서버 DOC_ATT_MIME(값까지)
try {
  // 키 순서는 소스 등장 순서로 비교(Object.keys는 "10"·"99" 같은 정수형 키를 앞으로 올린다 — 순서 검증이 목적이라 matchAll로 뽑는다)
  const kv = (seg, re) => { const o = { keys: [], val: {} }; [...String(seg || '').matchAll(re)].forEach((m) => { o.keys.push(m[1]); o.val[m[1]] = m[2]; }); return o; };
  const same = (a, b) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
  const arr = (seg) => [...String(seg || '').matchAll(/"(\d{2})"/g)].map((m) => m[1]);
  const appMajor = kv((html.match(/var DOC_MAJOR = \{([^}]+)\}/) || ['', ''])[1], /"(\d{2})"\s*:\s*"([^"]+)"/g);
  const appMajorOrder = arr((html.match(/var DOC_MAJOR_ORDER = \[([^\]]+)\]/) || ['', ''])[1]);
  const appMinor = kv((html.match(/var DOC_MINOR = \{([^}]+)\}/) || ['', ''])[1], /"(\d{2})"\s*:\s*"([^"]+)"/g);
  const appMinorOrder = arr((html.match(/var DOC_MINOR_ORDER = \[([^\]]+)\]/) || ['', ''])[1]);
  const svrMajor = kv((gwd.match(/const DOC_MAJOR_LABEL = \{([^}]+)\}/) || ['', ''])[1], /'(\d{2})'\s*:\s*'([^']+)'/g);
  const svrMinor = kv((gwd.match(/const DOC_MINOR_LABEL = \{([^}]+)\}/) || ['', ''])[1], /'(\d{2})'\s*:\s*'([^']+)'/g);
  const diffLbl = (a, b) => a.keys.filter((k) => a.val[k] !== b.val[k]).map((k) => k + ' 앱=' + a.val[k] + ' 서버=' + b.val[k]).join(' / ');
  T('문서함 대분류 키·순서·라벨 앱 DOC_MAJOR = DOC_MAJOR_ORDER = 서버 DOC_MAJOR_LABEL (' + appMajor.keys.length + '종)', same(appMajor.keys, appMajorOrder) && same(appMajor.keys, svrMajor.keys) && appMajor.keys.every((k) => appMajor.val[k] === svrMajor.val[k]),
    'DOC_MAJOR ' + appMajor.keys.join(',') + ' / ORDER ' + appMajorOrder.join(',') + ' / 서버 ' + svrMajor.keys.join(',') + ' / 라벨 차이 ' + diffLbl(appMajor, svrMajor));
  T('문서함 중분류 키·순서·라벨 앱 DOC_MINOR = DOC_MINOR_ORDER = 서버 DOC_MINOR_LABEL (' + appMinor.keys.length + '종)', same(appMinor.keys, appMinorOrder) && same(appMinor.keys, svrMinor.keys) && appMinor.keys.every((k) => appMinor.val[k] === svrMinor.val[k]),
    'DOC_MINOR ' + appMinor.keys.join(',') + ' / ORDER ' + appMinorOrder.join(',') + ' / 서버 ' + svrMinor.keys.join(',') + ' / 라벨 차이 ' + diffLbl(appMinor, svrMinor));
  T('문서함 분류 조합 = 대분류 12 × 중분류 6 + 99 = 73 (설계 v2 §6 #1·#9)', appMajor.keys.length === 13 && appMajor.keys[12] === '99' && appMinor.keys.length === 6 && (appMajor.keys.length - 1) * appMinor.keys.length + 1 === 73,
    '대분류 ' + appMajor.keys.length + ' / 중분류 ' + appMinor.keys.length);
  const appScope = arr((html.match(/var DOC_SCOPE_CATS = \[([^\]]+)\]/) || ['', ''])[1]);
  const svrScope = [...((gwd.match(/const DOC_SCOPE_CATS = \[([^\]]+)\]/) || ['', ''])[1]).matchAll(/'(\d{2})'/g)].map((m) => m[1]);
  T('문서함 설정 대상 분류 앱↔서버 일치 = 대분류 − 01 (12행)', same(appScope, svrScope) && same(appScope, appMajor.keys.filter((k) => k !== '01')), '앱 ' + appScope.join(',') + ' / 서버 ' + svrScope.join(','));
  const reApp = (html.match(/s\.match\((\/JW.*?\/i)\);/) || ['', ''])[1], reSvr = (gwd.match(/s\.match\((\/JW.*?\/i)\);/) || ['', ''])[1];
  T('docCatOf JW 번호 정규식 앱↔서버 동률', !!reApp && reApp === reSvr, '앱 ' + reApp + ' / 서버 ' + reSvr);
  const re = new Function('return ' + reApp)();
  const m1 = 'JW-06-01-004-01'.match(re), m2 = 'JW-06-05-001-2026'.match(re), m3 = 'jw06-01-004'.match(re);
  T('docCatOf 정규식 의미: 4층 번호(별지·연도판·하이픈 생략)는 앞 두 마디, 구형식 JW-05-001·구 하위번호 JW-03-016-01·JW-2026는 불일치',
    !!m1 && m1[1] === '06' && m1[2] === '01' && !!m2 && m2[1] === '06' && m2[2] === '05' && !!m3 && m3[1] === '06' && !'JW-05-001'.match(re) && !'JW-03-016-01'.match(re) && !'JW-2026 사업계획'.match(re),
    JSON.stringify([m1 && m1.slice(1), m2 && m2.slice(1), m3 && m3.slice(1), !!'JW-05-001'.match(re), !!'JW-03-016-01'.match(re)]));
  T('문서 모달 2단 분류 select: 정적 #docCat 없음 + #docCatMajor·#docCatMinor 존재 + docCatSelectsInit/docCatSelectSet/docCatSelectGet/docCatSelectLock 정의 + docMajorOf 앱·서버 정의',
    !/<select id="docCat"/.test(html) && ids.has('docCatMajor') && ids.has('docCatMinor') && ['docCatSelectsInit', 'docCatSelectSet', 'docCatSelectGet', 'docCatSelectLock', 'docMajorOf'].every((f) => new RegExp('function ' + f + '\\(').test(html)) && /function docMajorOf\(/.test(gwd),
    'html 정의: ' + ['docCatSelectsInit', 'docCatSelectSet', 'docCatSelectGet', 'docCatSelectLock', 'docMajorOf'].filter((f) => !new RegExp('function ' + f + '\\(').test(html)).join(','));
  T('구 1층 12분류 잔재 없음(앱 DOC_CATS 리터럴·서버 DOC_CAT_SET 리터럴·구 텍스트 폴백·구 번호 정규식)',
    !/var DOC_CATS = \{ "01"/.test(html) && !/const DOC_CAT_SET = \{ '01'/.test(gwd) && !/\/법인\/\.test\(c\)/.test(html) && !/\/법인\/\.test\(c\)/.test(gwd) && !/\(0\[1-9\]\|1\[0-2\]\)\(\?!\\d\)/.test(html) && !/\(0\[1-9\]\|1\[0-2\]\)\(\?!\\d\)/.test(gwd), '');
  const appMime = kv((html.match(/var DOC_ATT_MIME = \{([\s\S]*?)\};/) || ['', ''])[1], /(\w+)\s*:\s*"([^"]+)"/g);
  const svrMime = kv((gwd.match(/const DOC_ATT_MIME = \{([\s\S]*?)\};/) || ['', ''])[1], /(\w+)\s*:\s*'([^']+)'/g);
  const appExtL = [...((html.match(/var DOC_ATT_EXT = \[([^\]]+)\]/) || ['', ''])[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const svrExtL = [...((gwd.match(/const DOC_ATT_EXT = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
  const mk = appMime.keys.slice().sort(), sk = svrMime.keys.slice().sort();
  T('첨부 mime 고정표 키 = 확장자 화이트리스트(앱·서버) + 값 앱↔서버 일치', same(mk, appExtL) && same(sk, svrExtL) && same(mk, sk) && mk.every((k) => appMime.val[k] === svrMime.val[k]),
    '앱 mime ' + mk.join(',') + ' / 서버 mime ' + sk.join(',') + ' / 값 차이 ' + mk.filter((k) => appMime.val[k] !== svrMime.val[k]).join(','));
} catch (e) { console.log('  (2층 분류·mime 동률 검사 생략 — 파싱 실패: ' + e.message + ')'); fails++; }

// 12) v321 — ① index.html 인라인 스크립트 ES5 검사(let/const·화살표·템플릿 리터럴·class·spread/rest·for-of — 문자열·주석·정규식 리터럴을 걷어낸 뒤 대조. 구형 안드로이드·아이폰 웹뷰 호환 원칙)
//    ② sw.js SHELL_CACHE 버전 = FEATURES.md 기준 버전(기능 대장을 올리고 sw 버전업을 빠뜨리는 사고) ③ 기안 참조 문서 검색 DOM(#apprDraftRefSearch·#apprDraftRefSel·#apprDraftRefList + 숨은 #apprDraftRef, 구 <select> 없음, 렌더·선택·초기화 함수)
//    ④ 관리자 등급 판정 앱 tierOfMember ↔ 서버 _lib/tier.js 동률(등급 키 3종·파생 이름 2종·role 대표·dev·부트스트랩 게이트·명시 없음=admin·퇴사 제외) + 서버 게이트가 등급 컨텍스트(tierCtx)를 쓰는지·BOSS_ONLY 폴백 없음·gw-auth 회원 저장 게이트(9/6 검증) + 앱 apprCanDecide·오류 문구·applyRolePreset·mergeDocs
//    ⑤ 휴지통 클라 함수·서버 액션·삭제 확인 존재 + hidden_tmp 복구만·스탬프 서버 강제·부활 차단·누락 보존·docop 정리(9/6 검증)
try {
  const s0 = html.indexOf('<script>'), s1 = html.lastIndexOf('</script>');
  const src = html.slice(s0 + 8, s1);
  const startLine = html.slice(0, s0).split('\n').length;
  const stripJs = (src) => {
    let out = '', i = 0; const n = src.length;
    const reStart = (prev) => prev === '' || /[(,=:\[!&|?{};+\-*%<>~^]$/.test(prev) || /(^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else)$/.test(prev);
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; } i += 2; continue; }
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; out += q + q; continue; }
      if (c === '/') { const prev = out.replace(/\s+$/, '').slice(-12); if (reStart(prev)) { i++; let cls = false; while (i < n) { const ch = src[i]; if (ch === '\\') { i += 2; continue; } if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break; else if (ch === '\n') break; i++; } i++; while (i < n && /[a-z]/.test(src[i])) i++; out += '/re/'; continue; } }
      out += c; i++;
    }
    return out;
  };
  const code = stripJs(src);
  const es6 = [
    ['let/const', /(^|[^\w$.])(let|const)\s+[A-Za-z_$\[{]/],
    ['화살표 함수 =>', /=>/],
    ['템플릿 리터럴 (백틱)', /`/],
    ['class', /(^|[^\w$.])class\s+([A-Za-z_$][\w$]*\s*)?(\{|extends\b)/],
    ['spread/rest ...', /\.\.\.\s*[A-Za-z_$\[(]/],
    ['for-of', /(^|[^\w$.])for\s*\(\s*(var\s+)?[\w$]+\s+of\s/],
  ];
  const hits = es6.map(([name, re]) => { const m = code.match(re); return m ? name + '@' + (startLine + code.slice(0, m.index).split('\n').length - 1) + ' ' + JSON.stringify(code.slice(m.index, m.index + 40)) : null; }).filter(Boolean);
  T('index.html 인라인 스크립트 ES5(let/const·=>·백틱·class·spread·for-of 없음, ' + code.split('\n').length + '줄 검사)', code.length > 100000 && hits.length === 0, hits.join(' / '));
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const swV = (sw.match(/SHELL_CACHE = 'jw-shell-v(\d+)'/) || ['', ''])[1];
  const ftV = (readFileSync(join(ROOT, 'FEATURES.md'), 'utf8').match(/기준: v(\d+)/) || ['', ''])[1];
  T('sw.js SHELL_CACHE 버전(v' + swV + ') = FEATURES.md 기준 버전(v' + ftV + ')', !!swV && swV === ftV, 'sw v' + swV + ' / FEATURES v' + ftV);
  T('기안 참조 문서 검색 DOM: 구 <select id="apprDraftRef"> 없음 + 숨은 #apprDraftRef + #apprDraftRefSearch·#apprDraftRefSel·#apprDraftRefList + 렌더·선택·초기화 함수 + 검색 input 배선',
    !/<select id="apprDraftRef"/.test(html) && /<input type="hidden" id="apprDraftRef"/.test(html) && ['apprDraftRefSearch', 'apprDraftRefSel', 'apprDraftRefList'].every((id) => ids.has(id))
    && ['apprDraftRefRender', 'apprDraftRefPick', 'apprDraftFillRef', 'apprDraftRefMatch'].every((f) => new RegExp('function ' + f + '\\(').test(html)) && /getElementById\("apprDraftRefSearch"\)\.addEventListener\("input"/.test(html) && /var ref = refId \? "doc:" \+ refId : "";/.test(html), '');
  const tierSvr = readFileSync(join(ROOT, 'netlify/functions/_lib/tier.js'), 'utf8');
  const pushSvr = readFileSync(join(ROOT, 'netlify/functions/_lib/push.js'), 'utf8');
  const cronSvr = readFileSync(join(ROOT, 'netlify/functions/gw-appr-cron.js'), 'utf8');
  const keysApp = [...((html.match(/var TIER_TXT = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  const keysSvr = [...((tierSvr.match(/const TIERS = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  const fnApp = (html.match(/function tierOfMember\(m\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];
  const fnSvr = (tierSvr.match(/function tierOf\(m, bootstrap\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
  const namesOf = (s) => [...s.matchAll(/["']([가-힣]{2,4})["']/g)].map((m) => m[1]).sort().join(',');
  T('관리자 등급 앱↔서버 동률(9/6 S1): 등급 키(' + keysSvr.join('/') + ') · 파생 이름(' + namesOf(fnSvr) + ') · role 대표·dev 규칙 · 명시 tier 우선 · 부트스트랩 게이트(앱 tierBootstrap()/서버 bootstrap !== true) 뒤에만 파생 · 명시 없음=admin · 퇴사 제외',
    keysApp.length === 3 && keysApp.join() === keysSvr.join() && namesOf(fnApp) === namesOf(fnSvr) && namesOf(fnSvr) === '나경일,나종운,대표' && /role[^\n]*대표/.test(fnApp) && /role[^\n]*대표/.test(fnSvr) && /m\.dev/.test(fnApp) && /m\.dev/.test(fnSvr)
    && /if \(!tierBootstrap\(\)\) return "admin";/.test(fnApp) && /if \(bootstrap !== true\) return 'admin';/.test(fnSvr) && fnApp.indexOf('tierBootstrap()') < fnApp.indexOf('"대표"') && fnSvr.indexOf('bootstrap !== true') < fnSvr.indexOf("'대표'")
    && /memberRetired\(m\)\) return "";/.test(fnApp) && /retired\(m\)\) return '';/.test(fnSvr) && /function tierBootstrap\(\)/.test(html) && /function memberRetired\(m\)/.test(html) && /function isBootstrap\(members\)/.test(tierSvr) && /function ctxOf\(members\)/.test(tierSvr),
    '앱 ' + keysApp.join() + ' ' + namesOf(fnApp) + ' / 서버 ' + keysSvr.join() + ' ' + namesOf(fnSvr));
  T('서버 게이트가 등급 컨텍스트(push.tierCtx=tier.ctxOf)를 쓴다: self_decide·PM 큐 decide·② 자동통과=tc.tierOf, BOSS_ONLY 폴백 없음(S2), push.js 동기 isBoss/isPm/tierOf 없음, 총정리 크론 boss 0명 스킵, gw-auth SELF_CHANGE_FORBIDDEN·NAME_TAKEN·NAME_RESERVED·ROLE_BOSS_ONLY·LAST_PM(pmLost)·TIER_PM_OR_BOSS_ONLY',
    /if \(myT !== 'pm'\) return apprSelfDecideDeny\(myT, R\)/.test(gwd) && /preQ === 'pm' && myT !== 'pm' && tc\.pmIds\.length/.test(gwd) && /grade === 2 && memberT === 'pm'/.test(gwd) && /const memberT = tc\.tierOf\(member\)/.test(gwd)
    && /decision !== '보류' && myT !== 'boss'\) return jr\(403, \{ status: 'FORBIDDEN', error_code: 'BOSS_ONLY'/.test(gwd) && !/bossIds\(\)\)\.length\) return jr\(403/.test(gwd) && !/push\.isBoss\(/.test(gwd) && !/tier\.isPm\(|tier\.tierOf\(|tier\.isBoss\(/.test(gwd)
    && /async function tierCtx\(\) \{ const ms = await loadMembers\(\); const c = tier\.ctxOf\(ms\);/.test(pushSvr) && !/isBoss:|isPm:|tierOf:|function isBoss\(/.test(pushSvr)
    && ['SELF_CHANGE_FORBIDDEN', 'NAME_TAKEN', 'NAME_RESERVED', 'ROLE_BOSS_ONLY', 'LAST_PM', 'TIER_PM_OR_BOSS_ONLY'].every((c) => auth.indexOf("'" + c + "'") >= 0) && /function pmLost\(tcBefore, allAfter\)/.test(auth) && /if \(pmLost\(tcBefore, allAfter\)\) return jr\(409/.test(auth)
    && /const bossIds = tcS\.bossIds;\s*\n\s*if \(!bossIds\.length\)/.test(cronSvr) && /const tcS = await push\.tierCtx\(\);/.test(cronSvr) && /skipped: 'no-boss'/.test(cronSvr), '');
  T('앱 결재 버튼 게이트(apprCanDecide): 대표 큐=isB만(boss_present 폴백 제거, S2) · PM 큐 pm 0명 폴백 유지 · 앱 오류 문구 SELF_CHANGE_FORBIDDEN·NAME_TAKEN·NAME_RESERVED·ROLE_BOSS_ONLY · applyRolePreset이 tierOfMember(em0) 유지(R8) · mergeDocs 부활 차단(R1)',
    /if \(\(it\.to \|\| "pm"\) === "boss"\) return isB;/.test(html) && /if \(!g\) return !apprBossOnly\(it\) \|\| isB;/.test(html) && !/return isB \|\| !apprBossPresent/.test(html) && /return isP \|\| !apprPmPresent;/.test(html)
    && ['SELF_CHANGE_FORBIDDEN', 'NAME_TAKEN', 'NAME_RESERVED', 'ROLE_BOSS_ONLY'].every((c) => html.indexOf('ec === "' + c + '"') >= 0) && /var t0 = em0 \? tierOfMember\(em0\) : ""; tSel0\.value = t0 \|\| tierDefaultForRole/.test(html)
    && /if \(it && it\.del === 1 && !remoteIds\[id\]\) return; out\.push\(it\);/.test(html), '');  T('문서함 휴지통: 클라 함수(docTrashHtml·docRestore·docPurge·docDeletedTs) + 서버 액션(doc_restore·doc_purge)·30일 상수 동률(' + ((gwd.match(/const DOC_PURGE_DAYS = (\d+)/) || ['', '?'])[1]) + '일) + 삭제 확인 창(제목·번호)',
    ['docTrashHtml', 'docRestore', 'docPurge', 'docDeletedTs', 'docTrashBind'].every((f) => new RegExp('function ' + f + '\\(').test(html)) && /d\.action === 'doc_restore'/.test(gwd) && /d\.action === 'doc_purge'/.test(gwd)
    && (html.match(/var DOC_PURGE_DAYS = (\d+)/) || ['', ''])[1] === (gwd.match(/const DOC_PURGE_DAYS = (\d+)/) || ['', '?'])[1] && /confirm\("이 문서를 삭제할까요\?/.test(html) && /prompt\("정말 영구 삭제하려면/.test(html)
    && /error_code: 'HIDDEN_TMP'/.test(gwd) && /d\.hidden_tmp \? ' disabled/.test(html) && /if \(d\.hidden_tmp\)\{ alert\(/.test(html) && /code === "HIDDEN_TMP"/.test(html)   // v314 임시 숨김은 복구만(9/6 R3) — 서버 400·앱 버튼 비활성·안내
    && /function docDelStamp\(s, o, member, nowIso\) \{/.test(gwd) && !/trustClient/.test(gwd) && /async function docOpSweep\(st\)/.test(gwd)   // 삭제 스탬프 서버 강제(S4 — trustClient 분기 없음)·docop 정리(R6)
    && /if \(s\.id && !oldDocBy\[s\.id\] && s\.del === 1\) \{ docDropped\.push/.test(gwd) && /if \(s\.del === 1\) \{ docDropped\.push/.test(gwd) && /!keepIds\[o\.id\] && !seenOut\[o\.id\]\) \{ out\.push\(o\)/.test(gwd) && /else if \(s\.del === 1 && !\(o\.by && o\.by\.id === me\.id\)\) delete s\.del;/.test(gwd), '');   // 부활 차단 양 경로(R1)·누락 보존·타인 del 무시(S5)
  T('화관법 실패 안내: 로컬 폴백(김과장 PC) 문구 없음 + 자동 복구(08:20)·관리자 확인 문구(앱 카드·워커 푸시)', !/김과장 PC|로컬 폴백으로|김과장에게/.test(html.replace(/\/\/[^\n]*/g, '')) && /그룹웨어 자동 복구\(08:20\)/.test(html) && /그룹웨어 자동 복구\(08:20\) 또는 관리자 확인/.test(readFileSync(join(ROOT, 'netlify/functions/gw-hwakwan-run-background.js'), 'utf8')), '');
} catch (e) { console.log('  (v321 검사 생략 — ' + e.message + ')'); fails++; }

// 13) v323(PM 9/7 #9·#10·#12·#13) — ① 운반일지 빈 줄 토글 DOM(#abHideEmptyChk + localStorage try/catch 기억) ② 로그아웃 버튼(#memberLogoutBtn·gwLogout·gwLogoutCore·clearSessionData·devPendLogout 재사용·잠금 PIN 미삭제)
//     ③ 노선 지정 안내 문구 = 서버 상한(MAX_STR·MAX_ITEM·MAX_MEMO — 서버만 올리고 화면이 옛말을 하던 사고 재발 방지) ④ 노선 지정 권한 앱↔서버 동률('운영부') ⑤ ab_route_hide 서버 액션·앱 배선·숨김 blob 키
try {
  const ab = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro.js'), 'utf8');
  T('운반일지 빈 줄 숨기기 토글: #abHideEmptyChk 렌더 + change 배선(abBindHideToggle) + localStorage jw_ab_hide_empty 기억(읽기·쓰기 try/catch) + abRowEmpty + abSheetTableHtml 반환 {html,hiddenN,emptyN}',
    /id="abHideEmptyChk"/.test(html) && /var AB_HIDE_EMPTY_KEY = "jw_ab_hide_empty";/.test(html) && /try\{ abHideEmpty = localStorage\.getItem\(AB_HIDE_EMPTY_KEY\) === "1"; \}catch\(e\)\{\}/.test(html)
    && /try\{ localStorage\.setItem\(AB_HIDE_EMPTY_KEY, abHideEmpty \? "1" : "0"\); \}catch\(e\)\{\}/.test(html) && /function abRowEmpty\(c\)/.test(html) && /return \{ html: '<div class="ab-sheet">'/.test(html)
    && /function abBindHideToggle\(host\)/.test(html) && (html.match(/abBindHideToggle\(host\);/g) || []).length === 2 && /if \(empty && abHideEmpty\)\{ emptyN\+\+; continue; \}/.test(html), '');
  const coreSeg = (html.match(/function gwLogoutCore\(\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];
  const clearSeg = (html.match(/function clearSessionData\(\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];
  const logoutSeg = (html.match(/function gwLogout\(\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];
  const arrays = ['tasks', 'vehicles', 'receivables', 'licenses', 'documents', 'clients', 'contracts', 'leaves', 'bids', 'onbids', 'quotes', 'promoItems', 'myTodos', 'members', 'apprItems', 'myApprItems', 'fam', 'edu'];
  T('로그아웃: #memberLogoutBtn(로그인 모달·로그인 상태만 표시) + gwLogout(confirm→gwLogoutCore→리로드) + gwLogoutCore(setGwToken(null)·curMemberObj=null·jw_member_cache 제거·clearSessionData) + 잠금 PIN 키 미삭제 + devPendLogout이 gwLogoutCore 재사용 + clearSessionData가 컬렉션 ' + arrays.length + '개 배열·records 비움(전부 같은 스코프 var)',
    ids.has('memberLogoutBtn') && /getElementById\("memberLogoutBtn"\)\.style\.display = cm \? "block" : "none";/.test(html)
    && /getElementById\("memberLogoutBtn"\)\.addEventListener\("click", gwLogout\)/.test(html) && /getElementById\("devPendLogout"\)\.addEventListener\("click", function\(\)\{ gwLogoutCore\(\);/.test(html)
    && /setGwToken\(null\); curMemberObj = null;/.test(coreSeg) && /removeItem\("jw_member_cache"\)/.test(coreSeg) && /clearSessionData\(\);/.test(coreSeg) && !/lockPinKey|jw_lock_pin|lockClearState/.test(coreSeg + logoutSeg)
    && /if \(!confirm\(/.test(logoutSeg) && /gwLogoutCore\(\);/.test(logoutSeg) && /location\.reload\(\)/.test(logoutSeg)
    && arrays.every((a) => new RegExp('(^|[^\\w])' + a + ' = \\[\\]').test(clearSeg) && new RegExp('\\n  var ' + a + '\\b').test(html)) && /records = \{\};/.test(clearSeg), '누락: ' + arrays.filter((a) => !new RegExp('(^|[^\\w])' + a + ' = \\[\\]').test(clearSeg) || !new RegExp('\\n  var ' + a + '\\b').test(html)).join(','));
  const n1 = (s, re) => { const m = s.match(re); return m ? m[1] : '?'; };
  const mStr = n1(ab, /const MAX_STR = (\d+)/), mItem = n1(ab, /const MAX_ITEM = (\d+)/), mMemo = n1(ab, /const MAX_MEMO = (\d+)/);
  const msg = n1(html, /STR_TOO_LONG: "([^"]+)"/);
  T('운반일지 길이 안내 문구 = 서버 상한(상차지·하차지 ' + mStr + ' / 품목 ' + mItem + ' / 비고 ' + mMemo + ') · 품목 400·상차지 120(PM 9/7 #10)', msg.indexOf('각 ' + mStr + '자') >= 0 && msg.indexOf('품목은 ' + mItem + '자') >= 0 && msg.indexOf('비고는 ' + mMemo + '자') >= 0 && mItem === '400' && mStr === '120', msg + ' / 서버 ' + mStr + '·' + mItem + '·' + mMemo);
  T('서버가 품목 상한을 MAX_ITEM으로 검사(학습·수동·단골 3곳, MAX_STR 잔존 없음) + 학습 저장 레코드는 원문(cleanStr만·절단 없음)', (ab.match(/item\.length > MAX_ITEM/g) || []).length === 3 && !/item\.length > MAX_STR/.test(ab) && /const rec = \{ from: from, to: to, item: item, side: side, row: row, by: c\.member\.name, ts: Date\.now\(\) \};/.test(ab) && !/item\.slice\(0, MAX/.test(ab), '');
  const svrDept = n1(ab, /const LEARN_DEPT = '([^']+)'/), appDept = n1(html, /var AB_LEARN_DEPT = "([^"]+)"/);
  T('노선 지정 권한 앱↔서버 동률(관리자 또는 부서 ' + svrDept + ', PM 9/7 #13): 서버 canLearn 게이트 403 FORBIDDEN + 거부 감사로그 노선지정거부 · 앱 abCanLearn 버튼 게이트·abLearnGo 가드·FORBIDDEN 문구',
    svrDept === '운영부' && svrDept === appDept && /function canLearn\(member\) \{ return !!\(member && member\.id && \(member\.admin \|\| String\(member\.dept \|\| ''\) === LEARN_DEPT\)\); \}/.test(ab)
    && /if \(!canLearn\(c\.member\)\) \{/.test(ab) && /code: 'FORBIDDEN'/.test(ab) && /op: '노선지정거부'/.test(ab)
    && /function abCanLearn\(\)\{ var m = curMember\(\); return !!\(m && \(m\.admin \|\| String\(m\.dept \|\| ""\) === AB_LEARN_DEPT\)\); \}/.test(html) && /\} else if \(abCanLearn\(\)\)\{/.test(html) && /if \(!abCanLearn\(\)\)\{ alert\(AB_CODE_TEXT\.FORBIDDEN\); return; \}/.test(html) && /FORBIDDEN: "/.test(html), '서버 ' + svrDept + ' / 앱 ' + appDept);
  const hideFn = (ab.match(/async function handleRouteHide\([\s\S]*?\n\}/) || [''])[0];
  T('노선 숨김(PM 9/7 #9): 서버 ab_route_hide(관리자 ADMIN_ONLY·BAD_INPUT 불리언·BAD_ROUTE 실재 줄·blob allbaro:routes_hidden·감사 노선숨김/해제·changed:false 멱등) + ab_status routes hidden 병합·hidden_error + 앱 abRouteHide/abApplyHidden/abHiddenListHtml/abHiddenRoutes + 숨김·해제·목록 버튼 배선 + 셀렉트 "(숨김)" 그룹 + "숨김 해제 필요" 배지',
    /case 'ab_route_hide': return await handleRouteHide\(st, c, d, R\);/.test(ab) && /const HIDDEN_KEY = 'allbaro:routes_hidden';/.test(ab) && /if \(!c\.member\.admin\) return jr\(403, \{ ok: false, code: 'ADMIN_ONLY'/.test(hideFn)
    && /typeof d\.hide !== 'boolean'/.test(hideFn) && /code: 'BAD_ROUTE'/.test(hideFn) && /changed: false/.test(hideFn) && /op: d\.hide \? '노선숨김' : '노선숨김해제'/.test(hideFn)
    && /routes: routeList\(hiddenMap\(hr\.ok \? hr\.data : null\)\)/.test(ab) && /hidden_error: !hr\.ok/.test(ab)
    && ['abRouteHide', 'abApplyHidden', 'abHiddenListHtml', 'abHiddenRoutes'].every((f) => new RegExp('function ' + f + '\\(').test(html)) && /action: "ab_route_hide"/.test(html)
    && /querySelectorAll\("\[data-ab-hide\]"\)/.test(html) && /querySelectorAll\("\[data-ab-unhide\]"\)/.test(html) && /querySelectorAll\("\[data-ab-hidden-toggle\]"\)/.test(html)
    && /\(숨김\)<\/option>/.test(html) && /숨김 해제 필요/.test(html) && /h: !!r\.hidden, hb: String\(r\.hidden_by \|\| ""\), ht: Number\(r\.hidden_ts\) \|\| 0/.test(html), '');
} catch (e) { console.log('  (v323 검사 생략 — ' + e.message + ')'); fails++; }

// 14) v327(PM 9/8) — 운반일지 자동 재정렬: 서버(lib ROUTES_VER·rematchDoc, gw-allbaro rematchDays·ab_learn rematched·ab_status stale_days·ab_day 재정렬, 워커 routes_ver 스탬프)
//     ↔ 앱([노선 지정] 요청에 day 동봉·"재정렬 n건" 토스트·응답 후 그날 재조회·표 위 stale_days 안내·"다음 수집부터" 문구 회수·새 버튼 없음)
try {
  const ab = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro.js'), 'utf8');
  const lib = readFileSync(join(ROOT, 'netlify/functions/_lib/allbaro.js'), 'utf8');
  const wk = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro-run-background.js'), 'utf8');
  const libExports = lib.slice(lib.indexOf('module.exports'));
  T('서버 재정렬 배선: lib ROUTES_VER(sha1 12자)·rematchDoc export · gw-allbaro rematchDays·ab_learn rematched{days,changed,left}·ab_status stale_days·ab_day rematched/stale·시간 가드 상수(6초·7일·4초) · 워커 저장에 routes_ver 스탬프',
    /const ROUTES_VER = crypto\.createHash\('sha1'\)/.test(lib) && /\.digest\('hex'\)\.slice\(0, 12\);/.test(lib) && /function rematchDoc\(doc, opts\)/.test(lib) && /ROUTES_VER,/.test(libExports) && /rematchDoc,/.test(libExports)
    && /async function rematchDays\(st, days, learned, o\)/.test(ab) && /out\.rematched = \{ days: rd\.days, changed: rd\.changed, left: rd\.left \};/.test(ab) && /stale_days: staleDays/.test(ab) && /extra\.rematched = \{ changed: rd\.changed \}/.test(ab) && /extra\.stale = true/.test(ab)
    && /const REMATCH_BUDGET_MS = 6000;/.test(ab) && /const STATUS_REMATCH_MAX = 7;/.test(ab) && /const STATUS_REMATCH_BUDGET_MS = 4000;/.test(ab) && /routes_ver: ROUTES_VER, ts: Date\.now\(\), job: job/.test(wk), '');
  const learnSeg = (html.match(/function abLearnGo\(key, val\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];
  T('앱 [노선 지정]: ab_learn에 day 동봉 · 토스트 "재정렬 n건" · 응답 후 그날 재조회(abOpenDay) · "다음 수집부터" 문구 없음 · 표 위 "노선표 변경 뒤 재정렬 대기 n일(열면 자동 정리)" · 열면 stale_days에서 제거 · 새 버튼 없음',
    /action: "ab_learn", from: u\.from, to: u\.to, item: u\.item, side: side, row: row, day: learnDay/.test(learnSeg) && /var learnDay = abDay\.day \|\| "";/.test(learnSeg)
    && /apprToastShow\("노선 지정 " \+ side \+ row \+ \(rm \? " · 재정렬 " \+ abInt\(rm\.changed\) \+ "건"/.test(learnSeg) && /if \(learnDay && abDay\.day === learnDay\) abOpenDay\(learnDay\);/.test(learnSeg)
    && !/다음 수집부터/.test(html) && /노선표 변경 뒤 재정렬 대기 ' \+ stl \+ '일\(열면 자동 정리\)/.test(html) && /abStatus\.stale_days = abStatus\.stale_days\.filter\(function\(x\)\{ return x !== day; \}\);/.test(html)
    && !/data-ab-rematch|abRematch|재정렬<\/button>/.test(html), '');
} catch (e) { console.log('  (v327 검사 생략 — ' + e.message + ')'); fails++; }

// 15) 직원 등록 권한 v328(PM 9/8) — 직책 옵션 게이트·계약직·개발자만 admin/dev/uid 전송
try {
  const ga = auth;   // 상단에서 이미 읽은 gw-auth.js
  const h2 = html.replace(/'/g, '"');
  T('앱: 대표·관리자 옵션은 개발자에게만(이미 그 직책인 회원은 표시) · 고용형태 계약직 · admin/dev/uid는 개발자만 전송 · 신규 perms도 개발자만',
    /\["대표", "관리자"\]\.forEach\(function \(rv\)\{/.test(h2) && /op\.hidden = !\(isDev\(\) \|\| \(m && String\(m\.role \|\| ""\) === rv\)\);/.test(h2)
    && /<option value="계약직">계약직<\/option>/.test(html)
    && /if \(isDev\(\)\)\{[\s\S]{0,80}payload\.admin = admin; payload\.dev = devRole; payload\.uid = uidRaw;/.test(html)
    && /else if \(isDev\(\) && ROLE_PRESET\[role\]\) payload\.perms/.test(html), '');
  T('서버: ROLE_OPEN 3직책 · 등록분 perms 서버 프리셋 강제 · 관리자 등록분 admin false',
    /const ROLE_OPEN = \{ "팀장": 1, "직원": 1, "현장직": 1 \};/.test(ga.replace(/'/g, '"')) && /const ROLE_OPEN_PERMS = \{/.test(ga)
    && /m\.perms = cleanPerms\(forcedPerms \|\| d\.perms \|\| m\.perms\);/.test(ga)
    && /if \(!canDev\) \{ m\.admin = false; delete m\.dev; \}/.test(ga), '');
} catch (e) { console.log('  (v328 검사 생략 — ' + e.message + ')'); fails++; }

// 16) v329(PM 9/8) — 퇴사직원 분류: 인사 탭 재직/퇴사 분리(그룹·정렬·총원·칩·근속 정지) + 담당·공개범위·교육 대상 앞단 필터(기존 지정은 유지) + 서버 3곳(member_list retired 파생·push.sendTo 활성 필터·todo 크론 게이트)
try {
  const push329 = readFileSync(join(ROOT, 'netlify/functions/_lib/push.js'), 'utf8');
  const todo329 = readFileSync(join(ROOT, 'netlify/functions/gw-todo-cron.js'), 'utf8');
  const has = (t) => html.indexOf(t) >= 0;
  // ① 판정식 단일화 — 인사 탭·권한관리 모두 memberRetired 하나만. 종전 pmRetired(<=, 서버와 하루 어긋남)는 소멸
  T('퇴사 판정식 단일화: memberRetired 하나(서버 파생 불리언 retired도 수용) · 권한관리 지역 pmRetired(<=) 소멸 · 인사 탭에 새 판정식 없음',
    has('function memberRetired(m){ if(!m) return false; if(m.retired === true) return true; return !!(m.leave_date && String(m.leave_date) < todayStr()); }')
    && !/var pmRetired|pmRetired\(/.test(html) && has('var ra = memberRetired(a) ? 1 : 0, rb = memberRetired(b) ? 1 : 0;') && has('var ret = memberRetired(m);')
    && !/leave_date\s*<=\s*todayStr\(\)/.test(html), '');
  // ② liveMembers는 무변경(과거 기록 이름 해석·인사/권한관리 렌더가 여기 걸려 있다) + activeMembers 신설
  T('activeMembers() 신설 · liveMembers()는 퇴사 필터 없이 그대로(과거 지시·기성·계약 담당자 이름 해석 findMember/scopeNames 보호) · 가족친화 3개 기간 필터 무변경',
    has('function liveMembers(){ return members.filter(function(m){ return m && m.del !== 1; }); }')
    && has('function activeMembers(){ return liveMembers().filter(function(m){ return !memberRetired(m); }); }')
    && has('var m = findMember(tk); return m ? (isBossMember(m) ? "대표님" : m.name) : null;')
    && has('if(m.leave_date && m.leave_date < y0) return;') && has('return !(m.leave_date && m.leave_date < r.start);') && has('return !m.leave_date || m.leave_date>=todayStr();'), '');
  // ③ 인사 탭 분류 — 그룹 DOM·접이식 버튼·aria·정렬·총원 문구·칩·근속 정지·연차 잔여 생략
  const drawSeg = (html.match(/function drawHrRoster\(reopenId\)\{[\s\S]*?\n  \}/) || ['', ''])[0];
  const rowSeg = (html.match(/function hrRowHtml\(m, isRet\)\{[\s\S]*?\n  \}/) || ['', ''])[0];
  T('인사 탭: 재직/퇴사 분리(퇴사자는 맨 아래 별도 그룹) · 부서 그룹·부서 카운트는 재직자만 · 퇴사자 정렬 = 퇴사일 내림차순 → 연번',
    drawSeg.indexOf('mem.forEach(function(m){ if (memberRetired(m)) ret.push(m); else act.push(m); });') >= 0
    && drawSeg.indexOf('act.forEach(function(m){ var d = (m.dept && DEPT_LIST.indexOf(m.dept) >= 0) ? m.dept : "미지정"; groups[d].push(m); });') >= 0
    && drawSeg.indexOf("'<div class=\"hr-dept hr-ret\">'") >= 0
    && drawSeg.indexOf('if (la !== lb) return la < lb ? 1 : -1;') >= 0
    && drawSeg.indexOf('ret.forEach(function(m){ html += hrRowHtml(m, true); });') >= 0, drawSeg ? '' : 'drawHrRoster 파싱 실패');
  T('퇴사자 그룹 헤더: <button type="button"> + aria-expanded/aria-controls="hrRetBody" + 인원수 + 안내줄(서버 차단·기록 보존·카드 열어 수정) · 펼침 기억(jw_hr_ret_open, try/catch)',
    drawSeg.indexOf('\'<button type="button" class="hr-dept-h hr-ret-h\'') >= 0 && drawSeg.indexOf('aria-expanded="\' + (openRet ? "true" : "false") + \'"') >= 0
    && drawSeg.indexOf('aria-controls="hrRetBody"') >= 0 && drawSeg.indexOf('퇴사자 <span class="cnt">') >= 0
    && drawSeg.indexOf('로그인·데이터 접근은 서버가 차단 중입니다 — 인사 기록 보존용(퇴사일 정정·연차 정산은 카드를 열어 수정).') >= 0
    && has('var HR_RET_OPEN_KEY = "jw_hr_ret_open";') && has('try{ hrRetOpen = localStorage.getItem(HR_RET_OPEN_KEY) === "1"; }catch(e){}')
    && has('try{ localStorage.setItem(HR_RET_OPEN_KEY, hrRetOpen ? "1" : "0"); }catch(e){}')
    && has('var retBtn = document.getElementById("hrRetToggle"); if (retBtn) retBtn.addEventListener("click", hrRetToggle);'), '');
  T('총원 표기: 퇴사자 있으면 "총 N명 (재직 A · 퇴사 B)" — 권한관리(#permTotal "총 N명")와 같은 수를 말한다(두 관리자 화면 불일치 해소) · 없으면 "총 N명" · 재직 0명이면 폴백 줄',
    drawSeg.indexOf('total.textContent = ret.length ? ("총 " + mem.length + "명 (재직 " + act.length + " · 퇴사 " + ret.length + ")") : ("총 " + act.length + "명")') >= 0
    && drawSeg.indexOf('if (!act.length && ret.length) html += \'<div class="empty-line">재직 중인 직원이 없습니다.</div>\';') >= 0
    && /permTotal"\); if \(t\) t\.textContent = "총 " \+ mem\.length/.test(html), '');
  T('퇴사예정(미래 leave_date)은 재직 그룹 + 노란 칩 · 퇴사자 행은 근속을 퇴사일에 정지(serviceInfo asOf) · 연차 잔여도 **퇴사일 기준으로 표시**(정산 근거 — severanceAnnual은 annual_paid 전용이라 일반 퇴사자는 한 줄도 안 남았다) · 부서를 메타 앞머리에',
    rowSeg.indexOf('if(!isRet && m.leave_date) chips += \' <span class="review-chip">퇴사예정 \' + esc(m.leave_date) + \'</span>\';') >= 0
    && rowSeg.indexOf('var si=serviceInfo(m, isRet ? m.leave_date : null);') >= 0
    && rowSeg.indexOf('var lr=leaveRemaining(m.id, isRet ? m.leave_date : null);') >= 0
    && rowSeg.indexOf('(isRet ? "퇴사일 기준 연차 잔여 " : "연차 잔여 ")') >= 0
    && /function leaveRemaining\(memberId, asOf\)\{/.test(html) && /function annualExpired\(memberId, asOf\)\{/.test(html)
    && /var per=annualPeriod\(m, asOf\);\s*\n\s*var today=asOf\|\|todayStr\(\);/.test(html)
    && rowSeg.indexOf('var sev = severanceAnnual(m);') > rowSeg.indexOf('연차 잔여 ')
    && rowSeg.indexOf('var meta = [(isRet && m.dept) ? m.dept : "", m.role || "", m.rank || ""]') >= 0, rowSeg ? '' : 'hrRowHtml 파싱 실패');
  T('퇴사자 행 표기 정리: 퇴사일은 퇴사자에게만(재직 퇴사예정은 칩 하나 — 같은 날짜가 두 라벨로 겹치지 않게) · 휴직 칩은 퇴사자면 "휴직 중 퇴사" · 👑은 재직 관리자만(tierBadgeHtml이 ""라 왕관만 남던 행)',
    rowSeg.indexOf('if(isRet && m.leave_date) hr.push("퇴사 " + m.leave_date);') >= 0
    && rowSeg.indexOf('(isRet ? "휴직 중 퇴사" : "휴직중")') >= 0
    && rowSeg.indexOf("esc(nm) + ((m.admin && !isRet) ? ' 👑' + tierBadgeHtml(m) : '') + chips") >= 0, rowSeg ? '' : 'hrRowHtml 파싱 실패');
  T('폼 파괴 방어: 카드를 연 채 [퇴사자] 헤더를 누르거나 탭을 다시 열면 innerHTML이 #memberEditForm(앱 전체 1개)을 지운다 → **재직·퇴사 가리지 않고** 먼저 hrCollapse · hrToggle/hrCollapse/hrCloseNew 널가드(퇴사자 한정 가드는 재직 카드를 연 채 한 번 누르면 인사 탭을 먹통으로 만들었다)',
    /if \(hrOpenId != null\) hrCollapse\(\);\s*\n\s*hrRetOpen = !hrRetOpen;/.test(html)
    && has('if (hrOpenId != null) hrCollapse();   // 카드가 열려 있으면 폼을 먼저 홀더로')
    && !/if \(hrOpenId && memberRetired\(findMember\(hrOpenId\)\)\) hrCollapse\(\);/.test(html)
    && (html.match(/var form = document\.getElementById\("memberEditForm"\); if \(!form\) return;/g) || []).length === 2
    && (html.match(/if \(form\)\{ form\.classList\.remove\("hr-inline"\); document\.getElementById\("memberEditBackdrop"\)\.appendChild\(form\); \}/g) || []).length === 2, '');
  T('저장 후 재오픈이 실제로 발화한다: closeMemberEdit이 hrOpenId를 비우므로 saveMemberEdit이 미리 잡아 drawHrRoster(keep)로 넘긴다 → 퇴사자면 그룹 강제 펼침(종전엔 reopen이 항상 null이라 죽은 코드였다)',
    has('var keep = hrOpenId;') && has('drawHrRoster(keep);')
    && has('var reopen = (reopenId != null) ? reopenId : hrOpenId;')
    && has('var openRet = hrRetOpen || !!(reopen && memberRetired(findMember(reopen)));'), '');
  T('퇴사자 그룹 CSS(권한관리 구분선·흐림과 같은 언어): .hr-ret-h(border-top 2px·button 초기화·font-family:inherit) · 흐림은 요약줄만(.hr-ret .hr-item>.hr-head) · .hr-ret-note',
    has('.hr-ret-h{display:flex;') && has('border-top:2px solid rgba(128,148,138,.35);') && has('font-family:inherit;')
    && has('.hr-ret .hr-item>.hr-head .mname{opacity:.6;}') && !/\.hr-ret \.hr-item>\.hr-head\{opacity/.test(html)   // 요약줄(퇴사일·퇴직 연차수당)까지 흐리면 인라인 .9와 곱해져 대비 2.25:1
    && has('padding:14px 2px 12px;') && has('.hr-ret-note{') && has('.hr-ret-h.open .hr-caret{transform:rotate(180deg);}'), '');
  // ④ 앞단(담당 배정·알림·공개범위·교육) — 재직자만 + 이미 지정된 퇴사자는 유지
  T('담당 셀렉트 5종(taskWho·teWho·conWho·reAssignee·csAssignee): 재직자만 + 이미 지정된 퇴사자는 "(퇴사)"로 옵션 유지(지우면 구건 저장 시 담당이 소리 없이 지워진다)',
    has('function assignableMembers(selId){') && has('var out = activeMembers();')
    && has('out = out.slice(0, pos).concat([m], out.slice(pos));') && has('var sq = (typeof m.seq === "number") ? m.seq : 1e9, pos = out.length;')
    && has('function memberOptLabel(m){ return (isBossMember(m) ? "대표님" : m.name) + (memberRetired(m) ? " (퇴사)" : ""); }')
    && has('html += assignableMembers(cur).map(function(m){') && has('sel.value = cur;')
    && has("sel.innerHTML = '<option value=\"\">(담당 없음)</option>' + assignableMembers(csCur).map(")
    && has('["taskWho","conWho","reAssignee","teWho"].forEach(function(idn){ var s=document.getElementById(idn); if(s) fillMemberSelect(s, s.value); });'), '');
  T('담당 수정 모달(지시 teWho · 기성 reAssignee): populateMemberNames() 뒤 .value= 대입 금지 — fillMemberSelect에 **대상 id**를 넘긴다(옵션 없는 값은 규격상 ""로 떨어져 구건을 열었다 저장하면 담당이 지워졌고, 기성은 연결된 지시 담당까지 지웠다) · fillMemberSelect 마지막 방어(없는 옵션 생성)',
    has('fillMemberSelect(document.getElementById("teWho"), t.who_id || memberIdByName(t.who) || "");')
    && has('fillMemberSelect(document.getElementById("reAssignee"), r.assignee || "");')
    && !/getElementById\("teWho"\)\.value = /.test(html) && !/getElementById\("reAssignee"\)\.value = /.test(html)
    && has('if (cur && sel.value !== cur){ var mm0 = findMember(cur);'), '');
  T('공개범위·문서함·교육 대상: 퇴사자는 새 지정에서 제외하되 이미 체크·선택된 퇴사자는 보존(저장 시 scope 탈락 방지) — scopeCheckboxesHtml 한 곳이 6개 패널 공용',
    has('var ms = liveMembers().filter(function(m){ return !memberRetired(m) || sel.indexOf(m.id) >= 0; });')
    && has('var ms = liveMembers().filter(function(m){ return !m.admin && (!memberRetired(m) || selIds.indexOf(m.id) >= 0); });')
    && has('liveMembers().filter(function(m){ return !memberRetired(m) || sel==="member:"+m.id; }).forEach(function(m){')
    && has('box(m.id, memberOptLabel(m), m.role||"")'), '');
  // ⑤ 서버 3곳
  T('서버 gw-auth: member_list 비관리자 투영에 파생 불리언 retired 추가 · 날짜(leave_date)는 여전히 안 나간다(S7 유지) · 목록에서 퇴사자를 빼지 않는다(인사 화면이 그린다)',
    /retired: retired\(m\) \};/.test(auth)
    && ((auth.match(/return \{ id: m\.id[^;]*\};/) || [''])[0].indexOf('leave_date') < 0)
    && /const members = \(await listMembers\(st\)\)\.map\(function \(m\) \{/.test(auth)
    && /const ms = \(await listMembers\(st\)\)\.filter\(function \(m\) \{ return !retired\(m\); \}\);/.test(auth), '');   // 로그인 이름목록은 종전대로 퇴사자 제외(S2-A) — 바뀐 건 member_list 투영뿐
  T('서버 _lib/push sendTo: 발송·알림함 기록 **전에** 수신자에서 회원 없음·삭제·퇴사 제거(activeIdSet, opts.ctx 재사용) · push:log to도 필터된 목록 · skipped 반환·이력 노출 · 루프 대상도 필터본',
    /async function activeIdSet\(ctx\)/.test(push329) && /const act = await activeIdSet\(opts && opts\.ctx\);/.test(push329)
    && /ids = asked\.filter\(function \(id\) \{ return !!act\[id\]; \}\);/.test(push329) && /to: ids\.slice\(0, 30\)/.test(push329)
    && /if \(skipped\) ent\.skipped = skipped;/.test(push329) && /for \(const mid of ids\) \{/.test(push329)
    && /return \{ sent, removed, skipped \};/.test(push329) && /activeIdSet,/.test(push329.slice(push329.indexOf('module.exports'))), '');
  T('서버 _lib/push: "명부를 못 읽었다"와 "그 회원이 퇴사했다"를 구분 — gw_users list/get 실패는 unavailable로 표시하고 activeIdSet이 null을 돌려 sendTo가 필터를 건너뛴다(fail-open). 종전엔 빈 명부 = 전원 퇴사 판정이라 그 시간대 알림이 통째로 무음 차단됐다(200 OK / sent:0) · push:log filter_unavailable 가시화 · 발신자 by 기록',
    /if \(!l\.ok\) \{ const bad = \[\]; bad\.unavailable = true; return bad; \}/.test(push329)
    && /if \(miss\) out\.unavailable = true;/.test(push329)
    && /if \(ms\.unavailable\) c\.unavailable = true;/.test(push329)
    && /if \(c && c\.unavailable\) return null;/.test(push329)
    && /\} else filterOff = true;/.test(push329) && /if \(filterOff\) ent\.filter_unavailable = true;/.test(push329)
    && /if \(opts && opts\.by\) ent\.by = String\(opts\.by\)/.test(push329), '');
  {   // 회원 전수 재스캔 제거 — 서버의 모든 push.sendTo 호출이 이미 만든 tierCtx를 넘긴다(결재 1건에 blob 읽기 36회가 붙던 자리)
    const argsOf = (src, needle) => { const out = []; let i = 0;
      while ((i = src.indexOf(needle, i)) >= 0) { let d = 0, j = i + needle.length - 1;
        for (; j < src.length; j++) { const ch = src[j]; if (ch === '(') d++; else if (ch === ')') { d--; if (!d) break; } }
        out.push(src.slice(i, j + 1)); i = j + 1; } return out; };
    const noCtx = [];
    let nCalls = 0;
    ['gw-data.js', 'gw-todo-cron.js', 'gw-appr-cron.js', 'gw-allbaro-run-background.js', 'gw-hwakwan-run-background.js', 'gw-lawwatch.js'].forEach((f) => {
      argsOf(readFileSync(join(ROOT, 'netlify/functions', f), 'utf8'), 'push.sendTo(').forEach((call) => { nCalls++; if (call.indexOf('ctx:') < 0) noCtx.push(f); });
    });
    T('서버 push.sendTo 호출 ' + nCalls + '곳 전부 tierCtx 전달(opts.ctx) — 수신자 목록을 뽑을 때 이미 회원을 스캔했으므로 sendTo 안에서 다시 돌 이유가 없다(재스캔은 위 fail-open 창도 호출당 배로 넓힌다)',
      noCtx.length === 0, 'ctx 미전달: ' + [...new Set(noCtx)].join(', '));
  }
  T('서버 gw-todo-cron: 무인 08시 루프 진입 전 활성 게이트(tierCtx 1회) — 퇴사자는 todo:sent 쓰기·발송 전에 건너뛴다(skipped 응답) · sendTo에 ctx 전달(재스캔 없음) · ctx 실패 시 통과(최종 관문은 sendTo)',
    /let ctx = null;/.test(todo329) && /try \{ ctx = await push\.tierCtx\(\); \} catch \(e\) \{ ctx = null; \}/.test(todo329)
    && /const gateOn = !!\(ctx && !ctx\.unavailable && \(ctx\.members \|\| \[\]\)\.length\);/.test(todo329)
    && /if \(gateOn && !activeSet\[mid\]\) \{ skipped\+\+; continue; \}/.test(todo329) && /ctx \? \{ ctx: ctx \} : null\);/.test(todo329)
    && /fails: fails, skipped: skipped/.test(todo329)
    && /const rres = await push\.sendTo\(ids, payload, \{ ctx: tc, by: c\.member\.id \}\);/.test(gwd), '');
} catch (e) { console.log('  (v329 검사 생략 — ' + e.message + ')'); fails++; }

// 34) v331 — 주기업무 공개범위 저장 롤백 수리(2026-09-08 PM 실사고 "공개범위를 고치면 다시 롤백된다").
//     ① 병합기 mergeStamped를 index.html 실제 소스로 뽑아 실행: 키 삭제 전파(툼스톤) · 최신 편집 승 · 동률이면 원격 승
//     ② scopeCheckboxesHtml ↔ getCheckedMembers 짝: 화면에 상자가 안 그려지는 기존 지정(삭제회원·구 부서/직급·명부 미로딩)이 저장 시 탈락하지 않는가
//     ③ 저장·캐시 본문에 편집시각 사이드카가 함께 실리는가 + 구 Object.assign 병합이 남아 있지 않은가 ④ 서버 비관리자 재구성 가드 존재
try {
  // index.html에서 함수 하나를 이름으로 잘라낸다(중괄호 짝맞춤) — 실제로 배포되는 소스를 그대로 돌리기 위해
  const fnSrc = (name) => {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('함수 없음: ' + name);
    let d = 0, started = false;
    for (let j = i; j < html.length; j++) {
      const ch = html[j];
      if (ch === '{') { d++; started = true; }
      else if (ch === '}') { d--; if (started && d === 0) return html.slice(i, j + 1); }
    }
    throw new Error('중괄호 짝 안 맞음: ' + name);
  };

  // ---- ① 병합기 ----
  const mergeCtx = new Function([
    fnSrc('hasOwnKey'), fnSrc('mergeStamped'), 'return mergeStamped;',
  ].join('\n'))();
  {
    // 관리자가 q2를 지우고(툼스톤 ts=200) 저장한 서버 vs 그 키를 아직 들고 있는 낡은 탭(ts 없음)
    const r1 = mergeCtx({ q2: ['uA'], m1: ['uOLD'] }, {}, { m1: ['uNEW'] }, { q2: 200, m1: 200 });
    T('v331 병합: 관리자가 지운 공개범위 키가 낡은 사본에서 부활하지 않는다(툼스톤 전파)', !('q2' in r1.map) && r1.ts.q2 === 200, JSON.stringify(r1.map));
    T('v331 병합: 낡은 사본의 값이 서버 최신값을 덮지 않는다(원격 승) + 밀린 키를 세어 화면에 알린다',
      JSON.stringify(r1.map.m1) === JSON.stringify(['uNEW']) && r1.overridden.indexOf('m1') >= 0, JSON.stringify([r1.map, r1.overridden]));
    // 반대 방향 — 내가 방금 만든 편집(ts 큰 쪽)은 낡은 서버값에 밀리지 않는다
    const r2 = mergeCtx({ m1: ['uMINE'] }, { m1: 900 }, { m1: ['uOLD'] }, { m1: 100 });
    T('v331 병합: 내 최신 편집(ts 큰 쪽)이 이긴다', JSON.stringify(r2.map.m1) === JSON.stringify(['uMINE']) && r2.overridden.length === 0, JSON.stringify(r2.map));
    // 아직 서버에 못 올린 로컬 전용 키는 동률(둘 다 ts 없음)이어도 지켜야 한다 — 원격 우선 규칙의 예외
    const r3 = mergeCtx({ solo: ['uA'] }, {}, {}, {});
    T('v331 병합: 원격에 없는 로컬 전용 키는 동률이어도 유실되지 않는다', JSON.stringify(r3.map.solo) === JSON.stringify(['uA']), JSON.stringify(r3.map));
    // 내가 지웠는데(ts 큼) 서버엔 아직 있는 경우 → 삭제가 이긴다
    const r4 = mergeCtx({}, { m1: 900 }, { m1: ['uOLD'] }, { m1: 100 });
    T('v331 병합: 내 삭제(ts 큰 쪽)가 서버의 옛 값을 이긴다', !('m1' in r4.map) && r4.ts.m1 === 900, JSON.stringify(r4.map));
  }

  // ---- ② 렌더 ↔ 수거 짝 ----
  {
    const scopeHtml = new Function('__members', [
      'var DEPT_LIST = ["관리부","공무부"], RANK_LIST = ["부장","사원"];',
      'var members = __members;',
      'function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/\x27/g,"&#39;"); }',
      'function liveMembers(){ return members.filter(function(m){ return m && m.del !== 1; }); }',
      'function memberRetired(m){ return !!(m && m.retired); }',
      'function isBossMember(){ return false; }',
      'function findMember(id){ for (var i=0;i<members.length;i++){ if (members[i].id === id) return members[i]; } return null; }',
      'function memberOptLabel(m){ return m.name + (memberRetired(m) ? " (퇴사)" : ""); }',
      fnSrc('hasOwnKey'), fnSrc('scopeCheckboxesHtml'), 'return scopeCheckboxesHtml;',
    ].join('\n'))([
      { id: 'uA', name: '재직자A' }, { id: 'uR', name: '퇴사자R', retired: true }, { id: 'uD', name: '삭제회원D', del: 1 },
    ]);
    // getCheckedMembers가 실제로 쓰는 셀렉터([data-scope],[data-mid])와 같은 축으로 수거
    const collect = (h) => [...h.matchAll(/data-(?:scope|mid)="([^"]*)"([^>]*)>/g)].filter((m) => / checked/.test(m[2]))
      .map((m) => m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const sel = ['uA', 'uR', 'uD', 'dept:없는부서', 'rank:없는직급', 'uGHOST'];
    const got = collect(scopeHtml(sel));
    T('v331 공개범위: 화면에 상자가 없는 기존 지정(삭제회원·구 부서/직급·명부에 없는 id)도 저장 시 전부 왕복 — 종전엔 조용히 탈락해 공개범위가 저절로 넓어졌다',
      got.length === sel.length && sel.every((t) => got.includes(t)), '수거: ' + got.join(',') + ' / 탈락: ' + sel.filter((t) => !got.includes(t)).join(','));
    // 명부 로딩 전 다이얼로그를 열어 저장 — 개별 직원이 통째로 탈락하던 경로
    const scopeHtml0 = new Function('__members', [
      'var DEPT_LIST = ["관리부"], RANK_LIST = ["사원"];', 'var members = __members;',
      'function esc(s){ return String(s==null?"":s); }',
      'function liveMembers(){ return members.filter(function(m){ return m && m.del !== 1; }); }',
      'function memberRetired(m){ return !!(m && m.retired); }', 'function isBossMember(){ return false; }',
      'function findMember(id){ for (var i=0;i<members.length;i++){ if (members[i].id === id) return members[i]; } return null; }',
      'function memberOptLabel(m){ return m.name; }',
      fnSrc('hasOwnKey'), fnSrc('scopeCheckboxesHtml'), 'return scopeCheckboxesHtml;',
    ].join('\n'))([]);
    const sel0 = ['uA', 'uB', 'dept:관리부'];
    const got0 = collect(scopeHtml0(sel0));
    T('v331 공개범위: 회원 명부가 아직 로드되기 전에 저장해도 개별 직원 지정이 살아남는다',
      got0.length === sel0.length && sel0.every((t) => got0.includes(t)), '수거: ' + got0.join(','));
  }

  // ---- ③ 저장·캐시 본문 + 구 병합 잔재 ----
  T('v331·v332 저장 본문에 편집시각 사이드카(scope_ts·assignee_ts·review_ts) 동봉 — 없으면 삭제가 다른 기기로 전파되지 않는다',
    /scopes: checkScopes, assignee: checkAssignee, review: checkReview, scope_ts: checkScopeTs, assignee_ts: checkAssigneeTs, review_ts: checkReviewTs\}\);/.test(html), '');
  T('v331 로컬 캐시도 사이드카 동반 저장(오프라인 부팅 뒤 첫 저장이 삭제를 되돌리지 않게)',
    /CACHE_KEY, JSON\.stringify\(\{sha: currentSha[^)]*scope_ts: checkScopeTs, assignee_ts: checkAssigneeTs, review_ts: checkReviewTs\}\)/.test(html), '');
  T('v331 구 병합(Object.assign로 scopes·assignee 로컬 무조건 승)이 남아 있지 않다 — 3곳 전부 applyScopeMerge',
    !/Object\.assign\(\{\}, *(?:remoteParsed|parsed|cache)\.(?:scopes|assignee)/.test(html)
    && (html.match(/applyScopeMerge\(/g) || []).length >= 3, '');
  T('v331 공개범위·담당 편집에 시각 스탬프(삭제 포함) — 스탬프가 없으면 낡은 사본이 지운 키를 반드시 되살린다',
    /checkScopeTs\[editingCheckItem\] = nowTs;/.test(html) && /checkAssigneeTs\[editingCheckItem\] = nowTs;/.test(html), '');
  T('v331 가시화: 저장 실패·권한 거부·남에게 밀림을 화면 토스트로 알린다(#gwToast) — 조용한 롤백 금지(9/3 PM 원칙)',
    /id="gwToast"/.test(html) && /function gwToast\(/.test(html)
    && /gwToast\("주기업무 저장에 실패했습니다/.test(html) && /json\.write_denied/.test(html)
    && /write_denied: 1/.test(html) && /if \(lost\) gwToast\(/.test(html), '');
  T('v331 디바운스 유실 차단: pagehide에서 밀린 주기업무 저장을 즉시 발사',
    /addEventListener\("pagehide"[\s\S]{0,240}?if \(pendingSave\)\{[\s\S]{0,120}?doSave\(\);/.test(html), '');

  // ---- ④ 서버 가드 ----
  T('v331 서버: 비관리자 checklist 저장은 scopes·assignee(+사이드카)를 서버 원본으로 이월 — 직원의 낡은 사본이 관리자 편집을 되돌리지 못한다',
    /if \(col === 'checklist' && !c\.member\.admin\)/.test(gwd)
    && /\['scopes', 'assignee', 'scope_ts', 'assignee_ts'\]\.forEach/.test(gwd)
    && /col === 'checklist'[\s\S]{0,400}?prevReadFailed\) return jr\(500/.test(gwd), '');
  T('v331 서버: 공개범위·담당 변경과 이월 차단이 감사로그에 남는다(종전엔 한 줄도 없어 버전 링을 뒤져야 규명됐다)',
    /op: '공개범위'/.test(gwd) && /op: '담당'/.test(gwd) && /op: '공개범위 보호'/.test(gwd) && /function scopeMapSame\(/.test(gwd), '');
} catch (e) { console.log('  (v331 검사 생략 — ' + e.message + ')'); fails++; }

// 35) v332 — v331이 "미확정"으로 남긴 2건을 판정해 고친 자리.
//     ① 주기업무 완료요청(review) 병합: 종전 Object.assign({}, 원격.review, 로컬.review)은 '타입' 한 층만 얕게 합쳐 두 방향 모두 데이터를 잃었다.
//        부활 = 관리자가 승인·반려로 지운 요청이 낡은 탭의 다음 저장에 되살아난다 / 증발 = 같은 타입에서 남이 방금 올린 요청이 내 저장 한 번에 사라진다.
//        3층 mergeReview를 index.html 실제 소스에서 뽑아 실행해 두 방향을 모두 재현한다.
//     ② 석면 투입 근로자 명단(asbMembers): 공개범위 상자(dept:·rank:)를 그리면 member_ids에 사람 아닌 토큰이 저장되는데
//        소비자(asbWorkerNames·asbNoSpecial → memberName=findMember)가 못 풀어 명단과 배치 전 특별교육 점검에서 조용히 빠진다.
try {
  const fnSrc = (name) => {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('함수 없음: ' + name);
    let d = 0, started = false;
    for (let j = i; j < html.length; j++) {
      const ch = html[j];
      if (ch === '{') { d++; started = true; }
      else if (ch === '}') { d--; if (started && d === 0) return html.slice(i, j + 1); }
    }
    throw new Error('중괄호 짝 안 맞음: ' + name);
  };

  // ---- ① 완료요청 3층 병합(실제 배포 소스를 그대로 실행) ----
  {
    const mergeReview = new Function([
      fnSrc('hasOwnKey'), fnSrc('mergeStamped'), fnSrc('unionKeys'), fnSrc('mergeReview'), 'return mergeReview;',
    ].join('\n'))();
    const REQ = { by: '직원', date: '2026-09-09' };
    // 관리자가 m1을 반려(review에서 삭제, 툼스톤 ts=200)한 서버 vs 그 요청을 아직 들고 있는 낡은 탭(스탬프 없음)
    const r1 = mergeReview(
      { monthly: { '2026-09': { m1: REQ } } }, {},
      { monthly: { '2026-09': {} } }, { monthly: { '2026-09': { m1: 200 } } });
    T('v332 완료요청: 관리자가 승인·반려로 지운 요청이 낡은 사본에서 부활하지 않는다(3층 툼스톤 전파) — 종전 Object.assign은 타입 덩어리째 되살렸다',
      !(r1.map.monthly && r1.map.monthly['2026-09'] && ('m1' in r1.map.monthly['2026-09']))
      && r1.ts.monthly['2026-09'].m1 === 200 && r1.overridden.length === 1, JSON.stringify([r1.map, r1.overridden]));
    // 같은 타입·같은 기간에 남이 방금 올린 요청(x9) — 내 낡은 덩어리엔 없다
    const r2 = mergeReview(
      { monthly: { '2026-09': { m1: REQ } } }, { monthly: { '2026-09': { m1: 100 } } },
      { monthly: { '2026-09': { m1: REQ, x9: REQ } } }, { monthly: { '2026-09': { m1: 100, x9: 300 } } });
    T('v332 완료요청: 같은 타입에서 남이 방금 올린 요청이 내 저장에 증발하지 않는다 — 종전엔 로컬 타입 덩어리가 통째로 이겨 사라졌다',
      !!(r2.map.monthly['2026-09'].x9 && r2.map.monthly['2026-09'].m1), JSON.stringify(r2.map));
    // 내가 방금 만든 요청(ts 큼)은 서버 옛 상태에 밀리지 않는다 + 다른 타입·기간은 서로 건드리지 않는다
    const r3 = mergeReview(
      { monthly: { '2026-09': { m1: REQ } }, weekly: { '2026-09-07': { w1: REQ } } }, { monthly: { '2026-09': { m1: 900 } } },
      { monthly: { '2026-09': {} }, quarterly: { '2026-Q3': { q1: REQ } } }, { monthly: { '2026-09': { m1: 100 } } });
    T('v332 완료요청: 내 최신 요청(ts 큰 쪽)이 이기고, 다른 타입·기간의 요청은 그대로 살아남는다',
      !!r3.map.monthly['2026-09'].m1 && !!r3.map.weekly['2026-09-07'].w1 && !!r3.map.quarterly['2026-Q3'].q1
      && r3.overridden.length === 0, JSON.stringify(r3.map));
    // 내가 지운 것(승인·반려, ts 큼)은 서버의 옛 요청을 이긴다 — 빈 층은 결과에서 아예 사라진다
    const r4 = mergeReview(
      { monthly: { '2026-09': {} } }, { monthly: { '2026-09': { m1: 900 } } },
      { monthly: { '2026-09': { m1: REQ } } }, { monthly: { '2026-09': { m1: 100 } } });
    T('v332 완료요청: 내 승인·반려(ts 큰 쪽)가 서버의 옛 요청을 이긴다',
      !r4.map.monthly && r4.ts.monthly['2026-09'].m1 === 900, JSON.stringify([r4.map, r4.ts]));
  }
  T('v332 완료요청: 구 얕은 병합(Object.assign로 review 타입 한 층만)이 사라지고 applyScopeMerge 안 mergeReview로 대체',
    !/Object\.assign\(\{\}, *(?:remoteParsed|parsed|cache)\.review/.test(html)
    && /var c = mergeReview\(checkReview, checkReviewTs, remoteParsed\.review \|\| \{\}, remoteParsed\.review_ts \|\| \{\}\);/.test(html), '');
  T('v332 완료요청: 요청·승인·반려·요청취소 모두 시각 스탬프(삭제 포함) + 로드·오프라인 부팅에서 사이드카를 받는다',
    /function reviewStamp\(type, key, id\)\{/.test(html)
    && /todayStr\(\) \}; reviewStamp\(type, key, id\); \}/.test(html)
    && /if \(had\) reviewStamp\(type, key, id\);/.test(html)
    && /checkReviewTs = parsed\.review_ts \|\| \{\};/.test(html)
    && /checkReviewTs = cache\.review_ts \|\| \{\};/.test(html), '');
  T('v332 서버: review_ts(완료요청 툼스톤)도 사이드카 보존 대상 — 3층이라 재귀 최댓값 병합(tsMax)',
    /\['scope_ts', 'assignee_ts', 'review_ts'\]\.forEach/.test(gwd) && /const tsMax = function \(pv, inc\)/.test(gwd), '');
  T('v332 서버: review 본체는 비관리자 이월 대상이 아니다 — 완료요청은 직원이 정상적으로 쓰는 필드(툼스톤만 보호)',
    /\['scopes', 'assignee', 'scope_ts', 'assignee_ts'\]\.forEach/.test(gwd)
    && !/\['scopes', 'assignee', 'review'/.test(gwd), '');

  // ---- ② 석면 투입 근로자 명단은 '사람'만 ----
  {
    const pick = new Function('__members', [
      'var members = __members;',
      'function esc(s){ return String(s==null?"":s); }',
      'function liveMembers(){ return members.filter(function(m){ return m && m.del !== 1; }); }',
      'function memberRetired(m){ return !!(m && m.retired); }',
      'function isBossMember(){ return false; }',
      'function findMember(id){ for (var i=0;i<members.length;i++){ if (members[i].id === id) return members[i]; } return null; }',
      'function memberOptLabel(m){ return m.name + (memberRetired(m) ? " (퇴사)" : ""); }',
      fnSrc('hasOwnKey'), fnSrc('memberPickHtml'), 'return memberPickHtml;',
    ].join('\n'))([
      { id: 'uA', name: '재직자A' }, { id: 'uAdm', name: '관리자M', admin: true },
      { id: 'uR', name: '퇴사자R', retired: true }, { id: 'uD', name: '삭제회원D', del: 1 },
    ]);
    // getCheckedMembers가 실제로 쓰는 축([data-scope],[data-mid])과 같게 수거
    const collect = (h) => [...h.matchAll(/data-(?:scope|mid)="([^"]*)"([^>]*)>/g)].filter((m) => / checked/.test(m[2])).map((m) => m[1]);
    const boxes = (h) => [...h.matchAll(/data-(?:scope|mid)="([^"]*)"/g)].map((m) => m[1]);
    const h0 = pick([]);
    T('v332 석면 명단: 부서·직급 토큰 상자를 아예 그리지 않는다 — 체크하면 member_ids에 사람 아닌 값이 저장돼 투입 근로자 명단·특별교육 점검에서 조용히 빠졌다',
      !/data-scope=/.test(h0) && !boxes(h0).some((t) => /^(dept|rank):/.test(t)), boxes(h0).join(','));
    T('v332 석면 명단: 관리자도 투입 대상으로 고를 수 있다(공개범위 상자와 다른 점 — 명단은 사람 단위)',
      boxes(h0).indexOf('uAdm') >= 0, boxes(h0).join(','));
    T('v332 석면 명단: 퇴사자·삭제회원은 새 지정 목록에 뜨지 않는다',
      boxes(h0).indexOf('uR') < 0 && boxes(h0).indexOf('uD') < 0, boxes(h0).join(','));
    // 이미 저장된 값은 자동으로 지우지 않는다 — 상자가 없으면 저장 시 조용히 탈락한다(공개범위 v331과 같은 이유)
    const sel = ['uA', 'uR', 'dept:관리부', 'rank:과장', 'uGHOST'];
    const got = collect(pick(sel));
    T('v332 석면 명단: 기존 지정(구 부서·직급 토큰·퇴사자·명부에 없는 id)은 저장 시 전부 왕복 — 자동 삭제 금지, 사람이 판단',
      got.length === sel.length && sel.every((t) => got.includes(t)), '수거: ' + got.join(',') + ' / 탈락: ' + sel.filter((t) => !got.includes(t)).join(','));
    T('v332 석면 명단: 남아 있는 토큰은 "명단에 반영되지 않습니다" 경고와 함께 뜬다(조용한 무시 금지)',
      /부서 지정은 명단에 반영되지 않습니다/.test(pick(sel)) && /직급 지정은 명단에 반영되지 않습니다/.test(pick(sel)), '');
  }
  T('v332 석면 작업 모달만 사람 전용 렌더러를 쓴다(asbMembers=renderMemberPicks) · 공개범위 4패널은 종전대로 부서·직급 상자',
    /renderMemberPicks\("asbMembers"/.test(html) && !/renderMemberChecks\("asbMembers"/.test(html)
    && (html.match(/renderMemberPicks\("/g) || []).length === 1
    && /renderMemberChecks\("teScope"/.test(html) && /renderMemberChecks\("csScope"/.test(html)
    && /renderMemberChecks\("licScope"/.test(html) && /renderMemberChecks\("reScope"/.test(html), '');
} catch (e) { console.log('  (v332 검사 생략 — ' + e.message + ')'); fails++; }

// 36) v333 — 미판독 건 화면 표시(PM 2026-09-09 ㄱ · 입찰에이전트 진화설계 v2.1 확인1 안 ㄴ).
//     사고 형태: 하한율을 공고문에서 읽지 못한 건에 "공사/용역·금액구간" 최빈값을 값 칸에 써 넣어
//     화면에 숫자가 떴다. 실측 2026-09-09 원장 2,292건 = 820건이 그렇게 떴고, 그중 적격심사제 261건에
//     들어간 값은 소액수의견적이 만든 88%였다(설계 §2-3: 적격심사제 실제값은 85.495~87.745로 갈린다).
//     그대로 투찰하면 하한 미달(무효)이거나 적격 탈락이다. 그래서 통계 대입 경로를 전부 끊고
//     값 칸은 그 공고문에서 읽은 값으로만 채우며, 통계는 "참고(산정 미사용)" 줄로만 남긴다.
try {
  const fnSrc = (name) => {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('함수 없음: ' + name);
    let d = 0, started = false;
    for (let j = i; j < html.length; j++) {
      const ch = html[j];
      if (ch === '{') { d++; started = true; }
      else if (ch === '}') { d--; if (started && d === 0) return html.slice(i, j + 1); }
    }
    throw new Error('중괄호 짝 안 맞음: ' + name);
  };

  // ---- ① 값 경로에 통계가 다시 들어오지 못하게(이름·대입문 감시) ----
  T('v333 통계 최빈값 함수는 참고 전용 이름(lwltRefMode)만 남는다 — 구 이름 lwltMode가 되살아나면 값 경로 재유입 신호',
    !/\blwltMode\s*\(/.test(html) && /function lwltRefMode\(/.test(html), '');
  {
    const openSrc = fnSrc('openBidCalc');
    T('v333 계산기 값 칸은 그 공고의 판독값(ext.lwlt·ext.rng)으로만 채운다 — openBidCalc가 통계(bidsAwards.lwlt·bcModeRng)를 아예 읽지 않는다',
      !/bidsAwards/.test(openSrc) && !/bcModeRng/.test(openSrc)
      && (openSrc.match(/getElementById\("bcLwlt"\)\.value\s*=/g) || []).length === 1
      && /if\(pre\.lwlt\) document\.getElementById\("bcLwlt"\)\.value=parseFloat\(pre\.lwlt\)\|\|"";/.test(openSrc),
      openSrc.slice(0, 200));
  }
  T('v333 남은 자동 채움은 같은 공고의 추정가격→기초금액 하나뿐(다른 공고를 모은 값이 아니다)',
    /bcAutoSrc\.push\("기초금액=이 공고 추정가격"\)/.test(html)
    && (html.match(/bcAutoSrc\.push\(/g) || []).length === 1, '');

  // ---- ② bidFloorRange: 판독값이 있을 때만 숫자를 낸다(실제 배포 소스를 그대로 실행) ----
  {
    const bidFloorRange = new Function([fnSrc('bidFloorRange'), 'return bidFloorRange;'].join('\n'))();
    const rng = '-2% ~ +2%';
    const read = bidFloorRange({ kind: '용역', title: '폐기물 처리', ext: { bss: 100000000, rng: rng, lwlt: 87.745 } });
    T('v333 투찰범위: 그 공고문에서 읽은 하한율이 있으면 종전대로 계산한다',
      !!read && read.lwlt === 87.745 && read.lo === Math.round(98000000 * 0.87745), JSON.stringify(read));
    const unread = bidFloorRange({ kind: '용역', title: '폐기물 처리', ext: { bss: 100000000, rng: rng } });
    T('v333 투찰범위: 하한율 미판독이면 null — 유사공고 최빈값을 끌어와 "≈"로 띄우지 않는다(P5)',
      unread === null, JSON.stringify(unread));
    T('v333 투찰범위 반환에 est(추정) 플래그가 없다 — 화면 3곳(카드·상세·파이프라인)이 이 플래그로 "≈"를 찍었다',
      !!read && !('est' in read) && !/fr\.est/.test(html), Object.keys(read || {}).join(','));
  }

  // ---- ③ 미판독을 상태로 드러낸다(숨기지 않는다) ----
  {
    const bidLwltState = new Function([fnSrc('methodKindOf'), fnSrc('bidLwltState'), 'return bidLwltState;'].join('\n'))();
    const cases = [
      ['적격심사제', { lwlt: 87.745 }, 'read', '판독값이 있으면 read'],
      ['적격심사제', {}, 'unread', '적격심사제인데 못 읽었으면 unread(사람이 공고문을 열어야 한다)'],
      ['소액수의견적', {}, 'unread', '소액수의견적도 하한율이 있으므로 unread'],
      ['협상에의한계약', {}, 'none', '협상은 하한율 개념이 없어 미판독이라 부르지 않는다'],
      ['매각 (최고가)', {}, 'none', '매각은 최고가 — 하한 개념이 반대'],
      ['종합심사낙찰제', {}, 'none', '종합심사는 별도 산식'],
      ['제한경쟁·B5202602263', {}, 'method_unknown', '참가자격+공고번호 문자열은 낙찰방법이 아니다(수자원 형태)'],
      ['전자입찰·E26S077000', {}, 'method_unknown', '입찰방식+공고번호도 낙찰방법이 아니다(한수원 형태)'],
      ['공개구매·6663047', {}, 'method_unknown', '포스코는 구매유형만 있고 낙찰방법이 없다'],
      ['공고게시', {}, 'method_unknown', '철도공단은 처리상태가 들어와 있었다'],
      ['최저 낙찰·신규공고', {}, 'unread', '공동주택 "최저 낙찰"은 진짜 낙찰방법 — 상태가 붙어 있어도 하한율 대상'],
      ['최저 낙찰·재공고', {}, 'unread', '꼬리 "재공고"가 낙찰방법 판정을 이기면 안 된다(2026-09-09 원장 2건이 그렇게 미상으로 떨어졌다)'],
      ['적격심사 낙찰제(구매,용역)', {}, 'unread', '한수원 실제 낙찰방법 — 수집기 수리 후 들어오는 값'],
      ['55-1. 폐기물처리용역 (2억미만)', {}, 'unread', '철도공단 상세의 낙찰자 선정방법(하한율 대상)'],
      ['43-1. 100억이상(종합심사낙찰제)', {}, 'none', '철도공단 종합심사 — 하한율 개념 없음'],
      ['제한경쟁 시설·2026-10655', {}, 'method_unknown', '국방 형태(계약방법+업무구분+공고번호)'],
      ['', {}, 'method_unknown', '빈 낙찰방법'],
    ];
    let bad = [];
    cases.forEach((c) => { const got = bidLwltState({ method: c[0], ext: c[1] }); if (got !== c[2]) bad.push(c[0] + '→' + got + '(기대 ' + c[2] + ')'); });
    T('v333 하한율 판독 상태 4종(read/unread/none/method_unknown)이 낙찰방법별로 갈린다 — ' + cases.length + '케이스', !bad.length, bad.join(' · '));
  }
  T('v333 카드에 "하한율 미판독"·"낙찰방법 미상" 칩이 뜬다 — 미판독을 숨기면 사람이 몇 건인지 셀 수 없다',
    /하한율 미판독</.test(html) && /낙찰방법 미상</.test(html) && /bidLwltState\(b\)==="unread"/.test(html), '');
  T('v333 상세표 낙찰하한율·투찰범위 칸이 미판독을 말한다(빈칸으로 숨기지 않는다)',
    /미판독 — 공고문 확인/.test(html) && /산정 안 함 — /.test(html), '');
  T('v333 하한율은 읽었는데 기초금액·예가범위가 없어 못 내는 경우를 "미판독"이라 부르지 않는다 — 철도공단 상세는 하한율만 주고 사정률 범위를 안 준다',
    /if\(s==="read"\)\{/.test(html) && /miss\.push\("기초금액"\)/.test(html) && /miss\.push\("예가범위"\)/.test(html)
    && /는 판독됨 — 계산기에서 기초금액·예가범위를 넣으면 나옵니다/.test(html), '');

  // ---- ④ 통계는 "참고(산정 미사용)" 줄로만 ----
  T('v333 계산기 참고선에 "참고(산정 미사용)" 배너와 미판독 경고가 붙는다(PM 확인1 안 ㄴ)',
    /참고\(산정 미사용\)<\/b> — 아래는 <b>다른 공고들을 모은 통계<\/b>/.test(html)
    && /낙찰하한율 미판독<\/b> — 이 공고문에서 하한율을 읽지 못했습니다/.test(html), '');
  T('v333 하한율·사정률 참고 줄은 "값 칸에 넣지 않았습니다"를 명시한다 — 참고를 값으로 오독하지 않게',
    (html.match(/값 칸에 넣지 않았습니다/g) || []).length >= 2, '');
  T('v333 기관 칩·상세 기관 행이 "참고(산정 미사용)"로 재라벨된다 — 종전 "📊 기관실측 88.5%"는 이 공고 하한율처럼 읽혔다',
    /참고 기관개찰 /.test(html) && !/📊 기관실측 /.test(html) && /\["참고·기관개찰"/.test(html), '');
} catch (e) { console.log('  (v333 검사 생략 — ' + e.message + ')'); fails++; }

console.log(fails ? '\nUI 스모크 실패 ' + fails + '건' : '\nUI 스모크 전 항목 통과');
process.exit(fails ? 1 : 0);
