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

console.log(fails ? '\nUI 스모크 실패 ' + fails + '건' : '\nUI 스모크 전 항목 통과');
process.exit(fails ? 1 : 0);
