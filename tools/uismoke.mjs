// UI 정적 스모크(P8) — 브라우저 없이 잡을 수 있는 배선 결함을 push 전에 전수 대조.
// (진짜 헤드리스 브라우저는 앱 저장소의 no-node_modules 원칙과 충돌 — 이 세션들에서 실제 결함을
//  잡아온 검증들을 자동화한 것: ID 배선·탭 배선·앱/서버 레지스트리 일치·sw 버전업 누락)
// 실행: node tools/uismoke.mjs
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createRequire } from 'module';   // v433 서버 순수 함수(_lib/siteedu.js)를 앱 규칙과 같은 표본에서 실행해 대조
import { execSync } from 'child_process';
import { createHash } from 'crypto';   // v439 옛 그리기 본문·홈·내 업무 행 함수를 v438(43e61b0) 원문 해시와 대조
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const gwd = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8') + '\n' + readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'docscope.js'), 'utf8');   // v424 문서함 판정은 _lib/docscope.js로 옮김
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

// 4) 권한 레지스트리: gw-auth MODULES == gw-data COL 값 − {leaves(전원 저장 설계), bid·fam(관리자 고정 — 서버 ADMIN_ONLY)}
//    — 'wk' 누락으로 일용직 권한이 저장마다 증발했던 실사고의 재발 방지
//    (v430 정정: 종전 예외 hr의 주석 'edu는 서버가 비관리자에게 본인분만'은 코드에 없던 말이다 — 서버는 edu를 hr 기본 숨김으로 통째 막았고,
//     v430부터 COL edu = 'safety'(권한관리 '안전' 열)라 hr은 COL 값에 없다. 예외에서 빼서 hr이 COL 값으로 되돌아오면 여기서 걸린다)
const mods = new Set((auth.match(/const MODULES = \[([^\]]+)\]/) || [])[1].match(/'(\w+)'/g).map((s) => s.replace(/'/g, '')));
const colSeg = (gwd.match(/const COL = \{([^}]+)\}/) || [])[1];
const colVals = new Set([...colSeg.matchAll(/:\s*'(\w+)'/g)].map((m) => m[1]));
colVals.delete('leaves'); colVals.delete('bid'); colVals.delete('fam');
//    예외 hw 하나만(v431 등록 — v434 4-2 뒤에도 남는 예외: '저장 데이터 없는 키'). 화관법 자료(제출 작업·자동 현황 블롭)는 gw-hwakwan이 직접 다뤄 gw-data 컬렉션이 아니라 COL 값이 될 수 없다.
//    'auth 잉여'에서 hw만 빼고, 다른 키는 그대로 잉여로 잡힌다. v434: 예외가 아무도 강제하지 않는 키(죽은 권한)를 감추지 않게, hw를 실제로 강제하는 쪽 — gw-hwakwan.js
//    hwPerm(관리자 do · 회원 perms.hw · 값 없으면 hide)과 로그인·기기 승인 뒤 hp 계산·hw_waste_submit 앞 수행 검사(403 NO_WRITE) — 를 함께 대조한다(그 강제가 빠지면 여기서도 걸림).
const NO_COL_KEY = 'hw';
const hwk4 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-hwakwan.js'), 'utf8');
const hwEnf4 = /function hwPerm\(member\) \{\s*if \(member && member\.admin\) return 'do';\s*return \(member && member\.perms && member\.perms\.hw\) \|\| 'hide';\s*\}/.test(hwk4)
  && /\n  const hp = hwPerm\(c\.member\);/.test(hwk4)
  && /case 'hw_waste_submit': if \(hp !== 'do'\) return jr\(403, \{ ok: false, code: 'NO_WRITE', error: HW_ERR_NO_WRITE, request_id: R \}\); return await handleWasteSubmit\(st, c, d, R\);/.test(hwk4)   // v434 검토: 몸체에 사람 말 error(옛 앱 안내용 — code 그대로)
  && /\nconst HW_ERR_NO_WRITE = '화관법 수행 권한이 없어 제출하지 않았습니다 — [^'\n]*이 요청은 정부에 제출되지 않았습니다\.';\n/.test(hwk4);
const dm = [...colVals].filter((v) => !mods.has(v)), dx = [...mods].filter((v) => !colVals.has(v) && v !== NO_COL_KEY);
T('권한 레지스트리 auth↔data 일치(예외 hw = 저장 데이터 없는 키 — gw-auth MODULES에 있고 gw-data COL 값에는 없음 · 강제는 gw-hwakwan.js: hwPerm이 perms.hw를 읽고 폐기물 제출 앞 수행 검사 NO_WRITE, v434)', !dm.length && !dx.length && mods.has(NO_COL_KEY) && !colVals.has(NO_COL_KEY) && hwEnf4, 'auth 누락: ' + dm + ' / auth 잉여: ' + dx + ' / hw MODULES ' + mods.has(NO_COL_KEY) + '·COL ' + colVals.has(NO_COL_KEY) + ' / gw-hwakwan hw 강제 ' + hwEnf4);

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
  T('화면이 결과 tt를 저장(paResults.tt + p.ai.tt 3곳(v361 posted 갈래 포함))하고 사람이 제목을 바꾸면 라벨을 지움', /tt:String\(blob\.title_type\|\|r\.title_type\|\|""\)/.test(idx) && (idx.match(/ts:Date\.now\(\), tt:String\(r\.tt\|\|""\)/g) || []).length === 3 && /p\.ai\.tt=""/.test(idx), '');
  const libCodes = [...((lib.match(/var TITLE_TYPES = \[([\s\S]*?)\n\];/) || ['', ''])[1]).matchAll(/\{ code: '([A-Z])'/g)].map((m) => m[1]);
  const uiCodes = [...((idx.match(/var PA_TITLE_TYPE_NAMES=\{([^}]+)\}/) || ['', ''])[1]).matchAll(/([A-Z]):"/g)].map((m) => m[1]);
  T('제목 원형 코드 11종 라이브러리 = 화면 이름표(' + libCodes.join('') + ')', libCodes.length === 11 && libCodes.join('') === uiCodes.join(''), '라이브러리 ' + libCodes.join('') + ' / 화면 ' + uiCodes.join(''));
  T('출력 스키마 title_type enum·required + 제목 규칙 절 4자리 숫자 없음', /title_type: \{ type: 'string', enum: TITLE_CODES/.test(lib) && /required: \['title', 'body', 'tags', 'title_type'\]/.test(lib) && !/\d{4,}/.test(((lib.match(/var TITLE_TYPES = \[([\s\S]*?)\n\];/) || ['', ''])[1]).replace(/[,\s]/g, '')), '');
  // v352(PM 9/11 #31ⓒ "태그 생성이 빠졌다"): 실사고는 태그 코드 상실이 아니라 자동 생성 누락(다른 기록 생성 중 등록 → 버려짐)이었다.
  //   그래도 태그 사슬 8고리(v267 신설·v271 parseDraft 증발 수리 — 두 번 깨진 사슬)는 검사가 없었다 — 어느 고리가 빠져도 push 전에 잡는다.
  T('태그 사슬(v267·v271): 프롬프트 절·스키마 tags·parseDraft 통과·generateDraft 반환·워커 rec.tags·화면 paFinish/paApply 3곳(v361 posted 갈래 포함)/태그 상자',
    /## 해시태그 \(tags 값\)/.test(lib) && /tags: \{ type: 'array'/.test(lib) && /tags: tags, title_type: tt/.test(lib) && /tags: draft\.tags \|\| \[\]/.test(lib)
    && /rec\.tags = r\.tags\.slice\(0, 25\)/.test(wk) && /tags:\(Array\.isArray\(blob\.tags\)\?blob\.tags:\(r\.tags\|\|\[\]\)\)/.test(idx)
    && (idx.match(/p\.tags=r\.tags\.slice\(0,25\)/g) || []).length === 3 && /id="tags" readonly/.test(idx),
    '어느 고리가 빠졌는지 promoai.js 해시태그 절·schema·parseDraft·generateDraft / 워커 rec.tags / index.html paFinish·paApply·태그 상자 대조');
  T('v352 자동 생성 대기열: paAutoQueue·paDrainAuto · paKick 생성 중이면 auto는 줄 세움 · 배수 5곳(실패·네트워크·초과·완료 + 정의) · 카드 문구는 promoAiLine(v360 — 서버 상태 ai_st 기반)/"태그 n개" · 검수 문구 태그 수',
    /var paAutoQueue=\[\];/.test(idx) && /function paDrainAuto\(\)\{ if\(paJob\.polling\) return; var next=paAutoQueue\.shift\(\); if\(next\) paKick\(next, true\); \}/.test(idx)
    && /if\(auto\)\{ if\(paAutoQueue\.indexOf\(promoId\)<0\) paAutoQueue\.push\(promoId\); \}/.test(idx) && (idx.match(/paDrainAuto\(\);/g) || []).length === 4
    && /promoAiLine\(p\)/.test(idx) && /' · 태그 '\+\(\(p\.tags\|\|\[\]\)\.length\)\+'개'/.test(idx) && /" · 태그 "\+\(\(r\.tags&&r\.tags\.length\)\|\|0\)\+"개"/.test(idx), '');
  // v352(PM 9/11 #31ⓑ — 직원 수정본 5편 실측): 담당자 포장 = 가운데 정렬·20자 개행·소제목 굵게+구분선·물음표·정화조/저수조 삭제
  const bp = (idx.match(/function promoBuildPostHtml\(title, body, imgs, tags, prof\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];   // v394: prof 인자
  const abl366 = readFileSync(join(ROOT, 'netlify/functions/_lib/allbaro.js'), 'utf8'), abw366 = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro-run-background.js'), 'utf8');
  {
    const ct = (idx.match(/\/\/ @ct-radar-start([\s\S]*?)\/\/ @ct-radar-end/) || ['', ''])[1];
    const api = new Function('todayStr', 'esc', ct + '\nreturn { ctRadar: ctRadar, ctChipHtml: ctChipHtml, ctAddYears: ctAddYears, ctAgeAt: ctAgeAt };')(() => '2026-09-21', (x) => String(x));
    const r1 = api.ctRadar({ emp_type: '계약직', hire_date: '2025-09-01', birth: '1964-08-07' }, '2026-09-21');
    const r2 = api.ctRadar({ emp_type: '계약직', hire_date: '2025-12-29', birth: '1978-01-09' }, '2026-09-21');
    const r3 = api.ctRadar({ emp_type: '계약직', hire_date: '2026-09-17' }, '2026-09-21');
    const r4 = api.ctRadar({ emp_type: '계약직', hire_date: '2024-02-29', birth: '1990-01-01' }, '2026-09-21');
    T('v368 무기계약직 레이더(ctRadar 실행): 박국진(입사 시 61세) exempt · 정수현 due D-464(2027-12-29) · 정재욱 생년월일 없음 unknown · 윤년 입사 2024-02-29 → 2026-02-28 over 205일 · 정규직 null · 칩 문구',
      r1 && r1.state === 'exempt' && r1.age === 61 && r2 && r2.state === 'due' && r2.days === 464 && r2.conv === '2027-12-29' && r3 && r3.state === 'unknown' && r4 && r4.state === 'over' && r4.days === -205 && api.ctRadar({ emp_type: '정규직', hire_date: '2020-01-01' }, '2026-09-21') === null
      && /55세 이상 예외/.test(api.ctChipHtml({ emp_type: '계약직', hire_date: '2025-09-01', birth: '1964-08-07' }, '2026-09-21')) && /무기계약 전환 D-464 \(2027-12-29\)/.test(api.ctChipHtml({ emp_type: '계약직', hire_date: '2025-12-29', birth: '1978-01-09' }, '2026-09-21')) && /무기계약 간주 — 2년 초과 205일/.test(api.ctChipHtml({ emp_type: '계약직', hire_date: '2024-02-29', birth: '1990-01-01' }, '2026-09-21'))
      && /chips \+= ctChipHtml\(m, todayStr\(\)\);/.test(idx) && /function contractPlan\(members, sentDoc, today\)/.test(readFileSync(join(ROOT, 'netlify/functions/gw-duty-cron.js'), 'utf8')), JSON.stringify([r1, r2, r3, r4]));
  }
  T('v366 운반일지 재발방지: AB_PEND_HINT·전부 잠정 칸 붉은 숫자(ab-n-pend, "?")·문구 "예약 미실행 가능" 3곳 · abVariantHtml 칩(표기 변형)+[별도 줄로 나누기](abCanLearn) · abVariantSplit=ab_route_add(from=원문, to·item=줄 값)→loadAbStatus+abOpenDay · data-ab-split 배선 · 서버 matchRouteEx variant·aggregate variants·rematch 갱신 · 워커 notifyPendingAndVariants(운영부+PM, (day,manf)/(이름) 1회)',
    /var AB_PEND_HINT = "/.test(idx) && /class="ab-n-pend" title="' \+ esc\(AB_PEND_HINT/.test(idx) && /n \+ '\?<\/span>'/.test(idx) && (idx.match(/예약 미실행 가능/g) || []).length >= 3
    && /function abVariantHtml\(c, r\)/.test(idx) && /표기 변형 ' \+ esc\(names\.join/.test(idx) && /if \(abCanLearn\(\)\) h \+= '<button type="button" class="ab-hide-btn" data-ab-split=/.test(idx)
    && /function abVariantSplit\(side, row, name\)/.test(idx) && /action: "ab_route_add", from: name, to: rt\.t, item: rt\.i, side: sd/.test(idx) && /loadAbStatus\(\); if \(abDay\.day\) abOpenDay\(abDay\.day\);\s*\}\)\.catch/.test(idx) && /querySelectorAll\("\[data-ab-split\]"\)/.test(idx)
    && /variant: f !== c\.nr\.f && f\.indexOf\(c\.nr\.f\) >= 0/.test(abl366) && /if \(dec\.variant\) c\.variants = \[g\.from\];/.test(abl366) && /if \(dec\.variant\) c\.variants = \[c\.from\]; else delete c\.variants;/.test(abl366)
    && /async function notifyPendingAndVariants\(st, dayDocs, tcIn\)/.test(abw366) && /String\(m\.dept \|\| ''\) === '운영부'/.test(abw366) && /dd\.day >= today\) continue;/.test(abw366) && /tag: 'allbaro-pend-' \+ day/.test(abw366), '');
  // ---- v370: 차량 시트형(A안) + 폰 2단(C안) — 순수 함수 실행(PM 9/22 "25. ㄱ") ----
  try {
    const fn370 = (name) => { const i = idx.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < idx.length; j++) { const ch = idx[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return idx.slice(i, j + 1); } } throw new Error(name); };
    const cols370 = (idx.match(/var VEH_COLS = \[[\s\S]*?\n  \];/) || [''])[0];
    if (!cols370) throw new Error('VEH_COLS 없음');
    const api = new Function([
      'var todayStr = function(){ return "2026-09-22"; }; var esc = function(s){ return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };',
      cols370, fn370('isGreyState'), fn370('vehDday'), fn370('vehNearest'), fn370('vehDueCell'), fn370('vehNearInfo'), fn370('vehSortVal'), fn370('vehSheetSortRows'), fn370('vehSheetPass'), fn370('vehEnumValues'), fn370('vehColCls'),
      'return { VEH_COLS: VEH_COLS, vehDueCell: vehDueCell, vehNearInfo: vehNearInfo, vehSheetSortRows: vehSheetSortRows, vehSheetPass: vehSheetPass, vehEnumValues: vehEnumValues, vehColCls: vehColCls };'].join('\n'))();
    const V = [
      { id: 'a', no: '82수1111', type: '준설차', own: '직영', state: '운행', insp_due: '2026-09-10', ins_due: '2027-03-01', driver: '김호태', insurer: 'DB' },          // 검사 경과 12일
      { id: 'b', no: '12가2222', type: '암롤', own: '지입', state: '운행', insp_due: '2026-10-10', ins_due: '2026-09-30', driver: '', insurer: 'KB' },                 // 보험 D-8(가까움)
      { id: 'c', no: '33나3333', type: '준설차', own: '직영', state: '매각', insp_due: '2026-09-01', ins_due: null, driver: '박국진', insurer: 'DB' },                   // 회색(매각) — 경과지만 뒤로
      { id: 'd', no: '44다4444', type: '카고', own: '직영', state: '정비', insp_due: '2027-01-15', ins_due: '2027-02-01', driver: '이홍식', insurer: '' },              // 멀다
      { id: 'e', no: '55라5555', type: '암롤', own: '지입', state: '운행', insp_due: null, ins_due: null, driver: '허성관', insurer: 'KB' }                               // 만기 없음
    ];
    const c1 = api.vehDueCell('2026-09-10', false), c2 = api.vehDueCell('2026-09-30', false), c3 = api.vehDueCell('2027-01-15', false), c4 = api.vehDueCell('2026-09-01', true), c5 = api.vehDueCell('', false);
    const n1 = api.vehNearInfo(V[1]), n2 = api.vehNearInfo(V[4]);
    const sDue = api.vehSheetSortRows(V, 'due', 1).map(x => x.id).join(''), sDueDesc = api.vehSheetSortRows(V, 'due', -1).map(x => x.id).join(''), sNo = api.vehSheetSortRows(V, 'no', 1).map(x => x.id).join(''), sInsp = api.vehSheetSortRows(V, 'insp_due', 1).map(x => x.id).join('');
    const pOver = V.filter(v => api.vehSheetPass(v, {}, 'over')).map(x => x.id).join(''), p30 = V.filter(v => api.vehSheetPass(v, {}, 'due30')).map(x => x.id).join(''), pJi = V.filter(v => api.vehSheetPass(v, {}, 'jiip')).map(x => x.id).join(''), pStop = V.filter(v => api.vehSheetPass(v, {}, 'stop')).map(x => x.id).join('');
    const pEnum = V.filter(v => api.vehSheetPass(v, { type: '준설차' }, '')).map(x => x.id).join(''), pText = V.filter(v => api.vehSheetPass(v, { no: '가22' }, '')).map(x => x.id).join(''), pBoth = V.filter(v => api.vehSheetPass(v, { insurer: 'KB' }, 'jiip')).map(x => x.id).join('');
    const en = api.vehEnumValues(V, 'insurer').join(',');
    const colsOk = api.VEH_COLS.length === 12 && api.VEH_COLS[0].k === 'no' && api.VEH_COLS.filter(c => c.ph).length === 1 && api.VEH_COLS.filter(c => c.hs).length === 9 && api.vehColCls(api.VEH_COLS[2]) === ' vs-ph' && api.vehColCls(api.VEH_COLS[3]) === 'vs-hs' && api.vehColCls(api.VEH_COLS[1]) === '';
    T('v370 차량 시트형(실행): 만기 칸 3단계(경과 12일=vs-dan·D-8=vs-warn·먼 것 색 없음·회색 상태 색 없음·빈 값 "-") · 폰 만기=가까운 것(보험 D-8) · 정렬 due(경과 먼저·회색 뒤: a b d e c)/역순(e d b a c)/차번호/검사만기 · 칩 over·due30·jiip·stop · 필터 enum·text·enum+칩 · enum 값 정렬 · 열 정의(12열·폰 1·PC 전용 9)',
      c1.cls === 'vs-dan' && c1.level === 2 && /경과 12일/.test(c1.html) && c2.cls === 'vs-warn' && c2.level === 1 && /D-8/.test(c2.html) && c3.cls === '' && c3.level === 0 && c4.cls === '' && /D\+21/.test(c4.html) && c5.level === 0 && /-<\/span>/.test(c5.html)
      && n1 && n1.t === '보험' && n1.diff === 8 && n2 === null
      && sDue === 'abdec' && sDueDesc === 'edbac' && sNo === 'bcdea' && sInsp === 'cabde'
      && pOver === 'ac' && p30 === 'abc' && pJi === 'be' && pStop === 'cd'
      && pEnum === 'ac' && pText === 'b' && pBoth === 'be' && en === 'DB,KB' && colsOk,
      JSON.stringify({ c1, c2, n1, sDue, sDueDesc, sNo, sInsp, pOver, p30, pJi, pStop, pEnum, pText, pBoth, en, colsOk }));
    T('v370 구조: @veh-sheet 구간 · #vehDetailCard · 옛 카드형(vehRowHtml·vehDdayLine) 제거 · 표 고정 규칙(머리 sticky top·첫 열 sticky left·합계 sticky bottom) · 폰 859px 규칙(vs-hs 숨김·상세 카드 표시·표 안 펼침 숨김) · PC 860px(vs-ph 숨김) · 열 폭·정렬 저장 키 · 대시보드 .veh-item 유지 · 재그리기 포커스 복원',
      /\/\/ @veh-sheet-start/.test(idx) && /\/\/ @veh-sheet-end/.test(idx) && /id="vehDetailCard"/.test(idx) && !/vehRowHtml\(/.test(idx) && !/vehDdayLine\(/.test(idx)
      && /\.vs thead th\{position:sticky;top:0;z-index:3;/.test(idx) && /\.vs th:first-child,\.vs td:first-child\{position:sticky;left:0;z-index:2;\}/.test(idx) && /\.vs tfoot td\{position:sticky;bottom:0;z-index:4;/.test(idx)
      && /@media \(max-width:859px\)\{[\s\S]{0,240}?\.vs\{min-width:0;width:100%;table-layout:fixed;\}/.test(idx) && /\.vs th\.vs-hs,\.vs td\.vs-hs\{display:none;\}/.test(idx) && /#vehDetailCard\{display:block;margin-top:8px;\}/.test(idx) && /\.vs tr\.vs-det\{display:none;\}/.test(idx)
      && /@media \(min-width:860px\)\{\s*\.vs th\.vs-ph,\.vs td\.vs-ph\{display:none;\}/.test(idx)
      && /var VEH_SHEET_KEY = "jw_veh_sheet";/.test(idx) && /class="item veh-item"/.test(idx) && /\.veh-item\{display:flex;/.test(idx)
      && /var act = document\.activeElement, focusKey = /.test(idx) && /fe\.setSelectionRange\(caret, caret\)/.test(idx) && /renderDeletedList\("veh", "vehDeletedToggle", "vehDeletedList", showDeletedVeh, "차량", delLabel\)/.test(idx), '');
  } catch (e) { console.log('  (v370 검사 생략 — ' + e.message + ')'); fails++; }
  // ---- v373: 차량 탭 폰 3열 넘침 수리(PM 10/1 폰 스샷 — 만기 열 잘림) ----
  T('v373 폰 차량 표: 고정 배치 + 열 클래스 폭(차번호 46%·차종 22%·만기 32%, 숨긴 열 0) · colgroup 열 클래스 · 폰 만기 칸 D 표기("경과 n일" 없음) · 합계줄 축약',
    /\.vs col\{width:0 !important;\}\s*\.vs col\.vs-c-no\{width:46% !important;\}\s*\.vs col\.vs-c-type\{width:22% !important;\}\s*\.vs col\.vs-c-due\{width:32% !important;\}/.test(idx)
    && !/\.vs td:first-child,\.vs th:first-child\{width:40%;\}/.test(idx) && /'<col class="vs-c-' \+ c\.k \+ '" style="width:' \+ vehColW\(c\) \+ 'px">'/.test(idx)
    && /near\.t \+ ' ' \+ \(near\.diff < 0 \? 'D\+' \+ \(-near\.diff\) : 'D-' \+ near\.diff\) \+ '<\/td>'/.test(idx) && !/'경과 ' \+ \(-near\.diff\) \+ '일'/.test(idx)
    && /t = '임박 ' \+ nSoon \+ '·경과 ' \+ nOver;/.test(idx), '');
  // ---- v374: PC 열 폭 끌기 수리(PM 10/1 "열간격 조정 안 됨") ----
  T('v374 차량 표 고정 배치: .vs width:1px(표 폭=열 폭 합) · 보이는 열만 colgroup(vehPhoneMode·visCols) · colspan=nVis 2곳 · 끌기 col은 열 키 · 경계 넘으면 다시 그리기 · 기본 열 폭(v375: 수리 전 실측 185/146/138) · matchMedia change',
    /\.vs\{border-collapse:separate;border-spacing:0;table-layout:fixed;width:1px;min-width:1160px;/.test(idx) && /function vehPhoneMode\(\)\{ try \{ return window\.matchMedia\("\(max-width:859px\)"\)\.matches; \}/.test(idx)
    && /visCols = VEH_COLS\.filter\(function\(c\)\{ return phoneMode \? !c\.hs : !c\.ph; \}\), nVis = visCols\.length;/.test(idx) && (idx.match(/colspan="' \+ nVis \+ '"/g) || []).length === 2 && !/colspan="' \+ VEH_COLS\.length \+ '"/.test(idx)
    && /col = host\.querySelector\("col\.vs-c-" \+ k\)/.test(idx) && !/cols = host\.querySelectorAll\("col"\)/.test(idx) && /window\.addEventListener\("resize", vehOnBreak\);/.test(idx) && /function vehOnBreak\(\)\{ var p = vehPhoneMode\(\); if \(vehLastPhone !== null && p !== vehLastPhone\)/.test(idx)
    && /h:"차번호",   w:185,/.test(idx) && /vehMql\.addEventListener\("change", vehOnBreak\)/.test(idx) && /h:"검사만기", w:146,/.test(idx) && /h:"보험만기", w:138,/.test(idx), '');
  // ---- v377: 종운환경 유한회사→주식회사 조직변경(PM 10/8) — 표시 문자열에 옛 법인격 잔존 금지, 매칭 정규화 목록은 유지 ----
  T('v377 상호 변경: index.html에 "(유)종운환경"·"유한회사 종운환경"·띄어쓰기 변형 0곳 · XG_CO/CD_CO/AD_CO/JW_CO/env 표시 = 주식회사 · CORP 정규화 목록에 (유)·유한회사 유지(옛 자료 매칭)',
    !/\(유\)종운환경|유한회사 종운환경|유 한 회 사 종 운 환 경/.test(idx) && /no:"\(주\)종운환경", a2:"주 식 회 사 종 운 환 경"/.test(idx) && /var CD_CO=\{ env:\{name:"주식회사 종운환경"/.test(idx) && /var JW_CO = \{ name:"\(주\)종운환경"/.test(idx)
    && /\["㈜", "\(주\)", "주식회사", "\(유\)", "유한회사", "\(合\)"\]/.test(idx), '');

  // ---- v378: 열 폭 저장 폐지(PM 10/8 "열폭초기화 기능 왜 만든거? 그냥 새로고침하면 돼야지") — 끌기는 이 화면에서만, 새로고침=기본 폭(v375 실측값 유지), 저장 키 2종 삭제, [열 폭 초기화] 칩·바인딩 제거 ----
  T('v378 열 폭: 기본값 11열 185/130/230/60/100/55/67/146/138/80/153 유지 · VEH_COLW_KEY·vehColwSave·data-vs-colreset 없음 · 옛 키 jw_veh_colw·jw_veh_colw2 삭제',
    /w:185, f:"text", b:1/.test(idx) && /h:"차종",     w:130,/.test(idx) && /h:"상세",     w:230,/.test(idx) && /h:"소유",     w:60,/.test(idx) && /h:"기사",     w:55,/.test(idx) && /h:"상태",     w:67,/.test(idx) && /h:"보험사",   w:80,/.test(idx) && /h:"비고",     w:153,/.test(idx)
    && !/VEH_COLW_KEY/.test(idx) && !/vehColwSave/.test(idx) && !/data-vs-colreset/.test(idx) && !/열 폭 초기화/.test(idx) && /localStorage\.removeItem\("jw_veh_colw"\); localStorage\.removeItem\("jw_veh_colw2"\);/.test(idx) && /var up = function\(\)\{ document\.removeEventListener\("mousemove", mv\); document\.removeEventListener\("mouseup", up\); \};/.test(idx), '');
  // ---- v378: 큰 본문 양방향 gzip + 입찰 불러오기 실패 가시화(10/8 실사고: col:bids 6.69MB > 함수 응답 한도 6MB → "수집된 공고가 없습니다") ----
  T('v378 gwCall gzip: GW_GZ_MIN 1MB · CompressionStream("gzip") · octet-stream+X-GW-Enc · 미지원·실패 시 평문 폴백',
    /var GW_GZ_MIN = 1024 \* 1024;/.test(idx) && /new CompressionStream\("gzip"\)/.test(idx) && /h\["X-GW-Enc"\] = "gzip";/.test(idx) && /if \(!buf\) return gwSend\(fn, txt, gwHeaders\("application\/json"\)\);/.test(idx) && /typeof CompressionStream !== "function"/.test(idx), '');
  T('v378 입찰 불러오기 실패 가시화: loadBids catch→bidsLoadErr+renderBids · 붉은 배너(수집·재수집 누르지 마십시오)+[다시 불러오기] · 빈 상태 문구 분리 · 머리줄에 자동 수집 시각',
    /var bidsLoadErr = null;/.test(idx) && /catch\(function\(e\)\{ bidsLoadErr=\{ msg:String\(\(e&&e\.message\)\|\|e\|\|"오류"\), ts:Date\.now\(\) \}; renderBids\(\); \}\);/.test(idx) && /id="bidReloadBtn"/.test(idx) && /수집·재수집을 누르지 마십시오/.test(idx) && /bidsLoadErr\?'불러오기 실패 — 위 안내의 \[다시 불러오기\]'/.test(idx) && /var hts=\(bidsHealth&&bidsHealth\.ts\)/.test(idx) && /bidsLoadErr=null; renderBids\(\); renderDashboard\(\);/.test(idx), '');
  // ---- v371: 번호판 전용 경로(차량 검출기 COCO-SSD → 조각 확대 → Claude 좌표 → 자기검증) — 동봉·배선·출처 규칙(PM 9/23 "차번호 덜/안 가려짐" → "ㄱ") ----
  try {
    const fs371 = readFileSync;
    const MD = join(ROOT, 'netlify/functions/_models');
    const need = ['cocossd/model.json', 'cocossd/group1-shard1of5', 'cocossd/group1-shard2of5', 'cocossd/group1-shard3of5', 'cocossd/group1-shard4of5', 'cocossd/group1-shard5of5'];
    const missing = need.filter((p) => { try { return fs371(join(MD, p)).length < 1000; } catch (e) { return true; } });
    const pd = fs371(join(ROOT, 'netlify/functions/_lib/platedet.js'), 'utf8'), pm = fs371(join(ROOT, 'netlify/functions/_lib/promomask.js'), 'utf8'), wk = fs371(join(ROOT, 'netlify/functions/gw-promo-mask-background.js'), 'utf8'), cr = fs371(join(ROOT, 'netlify/functions/gw-promo-ai-cron.js'), 'utf8');
    const pkg = JSON.parse(fs371(join(ROOT, 'package.json'), 'utf8')), toml = fs371(join(ROOT, 'netlify.toml'), 'utf8');
    T('v371 동봉·의존: cocossd 6파일(1KB 이상) · package.json @tensorflow-models/coco-ssd · netlify.toml included_files _models/**(cocossd 포함) · platedet.js는 OCR·번호판 전용 모델을 싣지 않고 번호 문자열을 저장하지 않는다(프롬프트 "번호 문자열은 적지 마세요" 2곳)',
      missing.length === 0 && !!pkg.dependencies['@tensorflow-models/coco-ssd'] && /included_files = \["netlify\/functions\/_models\/\*\*"\]/.test(toml) && /lite_mobilenet_v2/.test(pd) && !/ocr|OCR|easyocr|paddle|hyperlpr|yolo/i.test(pd) && (pm.match(/번호 문자열은 적지 마세요/g) || []).length === 2, missing.join(','));
    T('v371·v372 배선: 워커 P.detectPlates(plates·verify·whole 주입)·model platedet2+·차량 검출기 못 실리면 종전 번호판 경로(MODELS_MISSING·WASM만)·비전 오류는 fail: · 재감지 새 판 판정 /platedet/ · 크론 옛 판 = platedet 없음 · promomask askVision·detectPlatesInCrop·verifyPlate(full/partial/none) 내보냄',
      /P\.detectPlates\(raw, \{/.test(wk) && /model: 'platedet2\+' \+ M\.MODEL/.test(wk) && /code !== 'MODELS_MISSING' && code !== 'WASM_BACKEND_FAILED'\) throw e;/.test(wk) && /prev && onlyOld && \/platedet2\/\.test\(String\(prev\.model \|\| ''\)\)/.test(wk) && /if \(!\/platedet2\/\.test\(String\(m\.data\.model \|\| ''\)\)\) old\.push\(id\);/.test(cr)
      && /async function askVision\(apiKey, mediaType, b64, system, question, schema, maxTokens\)/.test(pm) && /async function detectPlatesInCrop\(apiKey, mediaType, b64\)/.test(pm) && /async function verifyPlate\(apiKey, mediaType, b64\)/.test(pm) && /enum: \['full', 'partial', 'none'\]/.test(pm) && /detectBoxes, askVision, detectPlatesInCrop, verifyPlate, applyBoxes/.test(pm), '');
  } catch (e) { console.log('  (v371 검사 생략 — ' + e.message + ')'); fails++; }
  T('v369 문서함 [열기] 직원 표시: .view.readonly .mini-btn 숨김의 예외로 [data-doc-att-open] 버튼은 남는다(보기 권한 열람 통로) · 행 렌더의 열기 버튼이 그 속성을 갖는다',
    /\.view\.readonly \.mini-btn\[data-doc-att-open\]\{display:inline-block !important;\}/.test(idx) && /class="mini-btn" style="[^"]*" data-doc-att-open="' \+ esc\(d\.id\) \+ '\|' \+ Number\(f\.n\) \+ '">열기<\/button>/.test(idx)
    && idx.indexOf('.view.readonly .mini-btn[data-doc-att-open]') > idx.indexOf('.view.readonly .link-btn{display:none !important;}'), '');
  // v430 검토: perms 비교가 저장 글자(JSON.stringify)에서 실효값(permsSameEff — 실행 검사는 v430 묶음 ⑪-2)으로 바뀌었다 — 이 줄은 비교 4가지(perms·admin·dev·tier)가 한 식에 다 있는지를 본다
  T('v365 권한 재확인: refreshMemberPerms(5분 간격·verify·perms(v430부터 실효값 permsSameEff)/admin/dev/tier 비교·바뀌면 토스트+새로고침) · visibilitychange 배선', /function refreshMemberPerms\(\)/.test(idx) && /permRefreshAt < 5 \* 60 \* 1000/.test(idx) && /var changed = !permsSameEff\(cur, nm\) \|\| !!cur\.admin !== !!nm\.admin \|\| !!cur\.dev !== !!nm\.dev \|\| String\(cur\.tier \|\| ""\) !== String\(nm\.tier \|\| ""\);/.test(idx) && /function permsSameEff\(a, b\)\{/.test(idx) && /gwToast\("권한이 바뀌었습니다 — 화면을 새로 고칩니다"/.test(idx) && /if \(!document\.hidden\) refreshMemberPerms\(\);/.test(idx), '');
  const wrapSrc = (idx.match(/\/\/ @promo-wrap-start([\s\S]*?)\/\/ @promo-wrap-end/) || ['', ''])[1];
  T('v363·v367 복사 HTML 서식(직원판): 줄나눔 구간(@promo-wrap) 12~26자·promoLinesOf·뒤보기 없음 · pushText=한 줄=한 <p>(margin:0) · 소제목 앞 pushBlank · 사진 묶음 위아래 pushBlank·캡션 없음 · 고정 머리(PROMO_HEAD_SIG 3줄+PROMO_GREET env/con)+빈 줄 · 꼬리 promoTailHtml(org)+promoTagsHtml(5개씩) · 호출부 p.tags · 제목 h2 가운데 · 꼬리 5곳 가운데',
    /var PROMO_WRAP_LO=12, PROMO_WRAP_HI=26;/.test(wrapSrc) && /function promoWrapSense\(t, lo, hi, commaFirst\)/.test(wrapSrc) && /function promoLinesOf\(t\)/.test(wrapSrc) && !/\(\?<[=!]/.test(wrapSrc)
    && /function promoIsSubhead\(t\)\{ return t\.length<=45 && \/\[\?？\]\$\/\.test\(t\)/.test(bp) && /function pushLine\(l, bold\)\{ out\.push\('<p style="margin:0;line-height:1\.8;text-align:center;">'\+\(bold\? '<b>'\+promoEscHtml\(l\)\+'<\/b>' : promoEscHtml\(l\)\)\+'<\/p>'\); \}/.test(bp)
    && /function pushBlank\(\)\{ if\(out\.length && out\[out\.length-1\]!==PROMO_BLANK\) out\.push\(PROMO_BLANK\); \}/.test(bp) && /if\(promoIsSubhead\(t\)\)\{[\s\S]{0,300}?pushBlank\(\);[\s\S]{0,200}?pushLine\(t, useP && \(P\.head_bold_ratio\|\|0\)>=0\.5\);[\s\S]{0,40}?return;/.test(bp) && /promoLinesOf\(t\)\.forEach\(function\(l\)\{ pushLine\(l,false\); \}\);/.test(bp)
    && /if\(tags\.length\)\{ pushBlank\(\); tags\.forEach\(function\(t\)\{ out\.push\(t\); \}\); pushBlank\(\); \}/.test(bp) && !/color:#777;font-size:13px/.test(bp) && /headLines\.forEach\(function\(l\)\{ pushLine\(l, \(gbold\[l\]\|\|0\)>=0\.5\); \}\); pushBlank\(\);/.test(bp) && /\(useP && \(P\.sig_kept_ratio\|\|0\)<0\.3\) \? PROMO_GREET\[org==="con"\?"con":"env"\] : promoHeadLines\(org\)/.test(bp)
    && /promoTailHtml\(org\)\+promoTagsHtml\(tags\)/.test(bp) && !/promoWrap20/.test(idx) && !/<hr /.test(bp) && !/font-weight:700/.test(bp) && !/margin:12px 0/.test(bp)
    && /var PROMO_HEAD_SIG = \["종운환경·종운건설 \| 포항 준설·폐기물·철거·석면"/.test(idx) && /var PROMO_GREET = \{/.test(idx) && /"\(주\)종운환경 입니다\."\]/.test(idx) && /"\(주\)종운건설 입니다\."\]/.test(idx)
    && /function promoTagsHtml\(tags\)/.test(idx) && /t\.slice\(i,i\+5\)/.test(idx) && /function promoTailHtml\(orgIn\)/.test(idx) && /promoBuildPostHtml\(title, body, webImgs, p\.tags\)/.test(idx) && /promoBuildPostHtml\(title, body, got, p\.tags\)/.test(idx)
    && /<h2 style="font-size:20px;margin:0 0 16px;text-align:center;">/.test(bp)
    && (idx.match(/function promoTailHtml\(orgIn\)\{([\s\S]*?)\n  \}/) || ['', ''])[1].split('text-align:center').length === 6, '');
  T('v352 프롬프트: 소제목 물음표 강제 · 정화조/저수조 업무 제외(회사 절·FACILITY_WORDS·예시 제목에서 제거)',
    /질문형이므로 반드시 물음표\(\?\)로 끝냅니다/.test(lib) && /정화조·저수조는 종운환경의 업무가 아닙니다/.test(lib)
    && !/\(우수받이·빗물받이·맨홀·관로·집수정·정화조/.test(lib) && !/'정화조', '오수관로'/.test(lib) && !/'저수조', '물탱크'/.test(lib) && !/ex: \['정화조 문제인 줄/.test(lib), '');
} catch (e) { console.log('  (사진 상한 대조 생략 — 파일 읽기 실패: ' + e.message + ')'); fails++; }

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
  const cronFiles = ['gw-hwakwan-cron', 'gw-allbaro-cron', 'gw-todo-cron', 'gw-appr-cron', 'gw-brief-cron'];   // v416 아침 음성 브리핑 06:30
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
    && /function abBindHideToggle\(host\)/.test(html) && (html.match(/abBindHideToggle\(host\);/g) || []).length === 2 && /if \(!fr\.h && fempty && abHideEmpty\)\{ emptyN\+\+; continue; \}/.test(html), '');   // v353 후속: 반반 나누기 전에 거른다
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
    /case 'ab_route_hide': return await handleRouteHide\(st, c, d, R\);/.test(ab) && /const HIDDEN_KEY = 'allbaro:routes_hidden';/.test(ab) && /if \(!canLearn\(c\.member\)\) \{[\s\S]{0,400}op: '노선숨김거부'[\s\S]{0,300}return jr\(403, \{ ok: false, code: 'FORBIDDEN'/.test(hideFn) && !/c\.member\.admin\) return jr\(403, \{ ok: false, code: 'ADMIN_ONLY'/.test(hideFn)
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
    /function routesVerOf\(list\) \{\s*return crypto\.createHash\('sha1'\)/.test(lib) && /\.digest\('hex'\)\.slice\(0, 12\);/.test(lib) && /function rematchDoc\(doc, opts\)/.test(lib) && /get ROUTES_VER\(\) \{ return ROUTES_VER; \}/.test(libExports) && /rematchDoc,/.test(libExports)
    && /async function rematchDays\(st, days, learned, o\)/.test(ab) && /out\.rematched = \{ days: rd\.days, changed: rd\.changed, left: rd\.left \};/.test(ab) && /stale_days: staleDays/.test(ab) && /extra\.rematched = \{ changed: rd\.changed \}/.test(ab) && /extra\.stale = true/.test(ab)
    && /const REMATCH_BUDGET_MS = 6000;/.test(ab) && /const STATUS_REMATCH_MAX = 7;/.test(ab) && /const STATUS_REMATCH_BUDGET_MS = 4000;/.test(ab) && /routes_ver: AB\.routesVer\(\), ts: Date\.now\(\), job: job/.test(wk), '');
  const learnSeg = (html.match(/function abLearnGo\(key, val(?:, noConfirm)?\)\{([\s\S]*?)\n  \}/) || ['', ''])[1];   // v351: noConfirm 인자 추가
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
    const DTM = (html.match(/var DECIDE_TO_METHOD=\{[^}]*\};/) || [''])[0];
    const bidLwltState = new Function([DTM, fnSrc('methodKindOf'), fnSrc('bidMethodEff'), fnSrc('bidLwltState'), 'return bidLwltState;'].join('\n'))();
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
      // v341 — 낙찰방법 자리에 낙찰방법이 아닌 값이 들어온 건과, 진짜 낙찰방법인 건을 갈라 둔다(원장 실측 기준).
      ['소액전자·B3202602609', {}, 'method_unknown', '수자원 ctrmthdCdNm(계약방법) — 낙찰방법이 아니다(원장 58건 전부 ext.cntrct와 동일)'],
      ['규격가격동시입찰', {}, 'unread', 'ext.cntrct가 제한경쟁이라 sucsfbidMthdNm에서 온 진짜 낙찰방법 — 미상으로 밀지 않는다'],
      ['일괄입찰', {}, 'unread', '위와 같은 이유 — 가격 부분에 하한이 실재하므로 공고문을 열라는 지시가 맞다'],
      ['협상에의한계약', { lwlt: '85' }, 'none', 'v341: 하한율 개념이 없는 갈래는 판독값이 있어도 none — 그 85%는 다른 백분율의 오독이다'],
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

  // ---- ⑤ v334 — 사람이 값을 넣으면 경고가 걷히도록 ----
  //     v333의 미판독 경고·참고줄은 openBidCalc에서 1회만 그려졌다. 그래서 "위 칸에 직접 입력하세요"대로
  //     사람이 하한율을 넣어도 "⚠ 낙찰하한율 미판독"이 그대로 남아 거짓이 된다(적대검증 2026-09-09).
  T('v334 사람이 하한율·사정률을 직접 넣으면 미판독 경고·참고줄이 다시 그려진다',
    /var bcRefArgs=null;/.test(html) && /bcRefArgs=\[pre\.org\|\|""/.test(html)
    && /\["bcLwlt","bcLow","bcHigh"\]\.forEach\(function\(id\)\{ document\.getElementById\(id\)\.addEventListener\("input", function\(\)\{ if\(bcRefArgs\) bcRefLines\.apply\(null, bcRefArgs\); \}\); \}\);/.test(html), '');
} catch (e) { console.log('  (v333 검사 생략 — ' + e.message + ')'); fails++; }

// 37) v336 — 석면 저장 사고의 진짜 원인과 재설계(v355: 검사 대상을 renderAsb → renderSites로 이관 — 옛 석면 블록은 v350에서 제거, 현장 탭이 같은 대장을 그린다)(PM 2026-09-10 "저장됐으면 저장됐다고만 나오게, 갱신은 실패할 수 없게").
//     원인: 9/2 일괄 입력분 130건이 member_ids·worker_ids를 배열이 아니라 문자열 "[]"로 들고 있었다.
//     "[]"는 truthy라 (r.member_ids || []) 가 걸러주지 못하고 .forEach에서 TypeError → renderSites(당시 renderAsb)가 통째로 죽는다.
//     목록이 안 그려지고, 같은 문장에 이어 붙은 closeAsb()까지 못 가 창이 안 닫혔다 → 사람이 17번 다시 눌렀다.
//     v335는 try/catch로 덮었을 뿐이므로, v336은 ①모양(asList) ②순서(닫기·토스트 먼저) ③시점(다음 프레임)으로 다시 짰다.
//     아래는 index.html 실제 소스에서 렌더 함수를 뽑아 실행하는 재현 테스트다 — 회귀하면 여기서 잡힌다.
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
  const ASB_STATUS_SRC = 'var ASB_STATUS = ' + (html.match(/var ASB_STATUS = (\{[^}]*\});/) || [])[1] + ';';
  // v435: renderSites가 '지난 자료' 묶음 선언(상수 SITE_OLD_BEFORE·펼침 기억 siteOldOpen)과 siteYear를 읽는다 — 소스에서 그대로 뽑는다(없으면 ReferenceError로 아래 검사가 ✗)
  const SITE_OLD_SRC = (html.match(/var SITE_OLD_BEFORE = \d+;/) || ['/* SITE_OLD_BEFORE 없음 */'])[0] + ' ' + (html.match(/var siteOldOpen = false;/) || ['/* siteOldOpen 없음 */'])[0];
  const mkEl = (id) => ({ id, innerHTML: '', textContent: '', querySelectorAll: () => [] });
  const build = (items) => {
    const DOM = { siteList: mkEl('siteList'), siteHead: mkEl('siteHead') };
    const api = new Function('__items', '__DOM', [
      'var document = { getElementById: function(id){ return __DOM[id] || null; } };',
      'var asb = __items; var workers = []; var members = []; var edu = [];',
      fnSrc('pad'), fnSrc('fmtDate'), fnSrc('todayStr'), fnSrc('esc'), fnSrc('addDays'), fnSrc('isDate'), fnSrc('asList'),
      'function findMember(id){ for(var i=0;i<members.length;i++){ if(members[i].id===id) return members[i]; } return null; }',
      'function memberName(id){ if(!id) return ""; var m=findMember(id); return m?m.name:""; }',
      'function dispName(n){ return n||""; }',
      'function liveEdu(){ return edu.filter(function(r){ return r && r.del!==1; }); }',
      fnSrc('eduLatest'), fnSrc('eduHasValidSpecial'), ASB_STATUS_SRC,
      fnSrc('liveAsb'), fnSrc('normAsbRow'), fnSrc('asbNotifyDue'), fnSrc('asbKeepUntil'),
      'var SITE_KIND = { asbestos:"석면", demolition:"철거", dredge:"준설" }; var siteFilter = "", siteQ = "";',
      SITE_OLD_SRC,
      'function renderSiteFilter(){} function canDo(){ return false; } function fmtAmount(v){ return String(v); } function openAsb(){} function openSiteWorkers(){}',
      fnSrc('siteKind'), fnSrc('liveSites'), fnSrc('siteLabel'), fnSrc('siteYear'),
      // v433: renderSites의 특별교육 줄 = siteEduLine — 안전 권한형(canSee 참)이면 종전처럼 asbNoSpecial로 그린다(이 재현의 강도 그대로). 안전 권한 없는 쪽은 v433 묶음 ②가 본다
      'function canSee(){ return true; } var siteEduGap = null, siteEduGapSig = {};', fnSrc('siteGapSig'), fnSrc('siteEduLine'),
      fnSrc('asbWorkerNames'), fnSrc('asbNoSpecial'), fnSrc('sheetRow'), fnSrc('bindFold'), fnSrc('renderSites'),
      'return { renderSites: renderSites, normAsbRow: normAsbRow, asList: asList };',
    ].join('\n'))(items, DOM);
    return { api, DOM };
  };

  // ---- ① 사고 당시 모양(문자열 "[]")을 그대로 넣고 렌더 — 종전엔 여기서 TypeError가 났다 ----
  {
    const accident = [
      { id: 'a1', title: '임고면 축사 철거', client: '개인', site: '임고면', start: '2013-10-07', end: '2013-10-15',
        material: '슬레이트', area: '370', status: 'done', conc: '', waste_no: '', note: '', member_ids: '[]', worker_ids: '[]' },
      { id: 'a2', title: '남성초', client: '포항교육지원청', site: '', start: '2026-09-09', end: '2026-09-20',
        material: '', area: '', status: 'plan', conc: '', waste_no: '', note: '', member_ids: ['u1'], worker_ids: [] },
    ];
    const { api, DOM } = build(accident);
    let err = null;
    try { api.renderSites(); } catch (e) { err = e; }
    T('v336 재현: member_ids가 문자열 "[]"인 기록이 섞여도 renderSites가 던지지 않는다(9/9 사고 지점)',
      !err, err && (err.constructor.name + ': ' + err.message));
    T('v336 재현: 그 상태에서도 목록이 실제로 그려진다(종전엔 innerHTML이 비어 "목록에 안 뜬다"였다)',
      DOM.siteList.innerHTML.indexOf('남성초') >= 0 && DOM.siteList.innerHTML.indexOf('임고면 축사 철거') >= 0,
      'len=' + DOM.siteList.innerHTML.length);
    T('v336 재현: 총 건수 머리글도 정상(v435: 2013년 줄은 지난 자료 묶음 — 총 건수는 그대로 + "(지난 자료 1건 접힘)")', DOM.siteHead.textContent === '총 2건 (지난 자료 1건 접힘)', DOM.siteHead.textContent);
  }

  // ---- ② 적대 데이터: 배열 자리에 들어올 수 있는 모든 모양 + 레코드 자체가 이상한 경우 ----
  {
    const hostile = [
      { id: 'h1', title: 'JSON 문자열', member_ids: '["u1","u2"]', worker_ids: '["w1"]', start: '2026-01-02', end: '2026-01-03', status: 'run' },
      { id: 'h2', title: '쉼표 문자열', member_ids: 'u1, u2', worker_ids: 'w1', status: 'done' },
      { id: 'h3', title: '숫자·불리언', member_ids: 7, worker_ids: true, start: '2026-02-30', end: '9999-99-99' },
      { id: 'h4', title: '객체', member_ids: { a: 1 }, worker_ids: { b: 2 } },
      { id: 'h5', title: 'null', start: null, end: undefined, status: null, area: null, conc: null, member_ids: null, worker_ids: undefined },
      { id: 'h6' },
      { id: 'h7', title: '깨진 JSON', member_ids: '[u1,', worker_ids: '[' },
      { id: 'h8', title: '<script>alert(1)</script>', site: '"><img src=x>', member_ids: [], worker_ids: [] },
      'not-an-object', null,
    ];
    const { api, DOM } = build(hostile);
    let err = null;
    try { api.renderSites(); } catch (e) { err = e; }
    T('v336 적대 데이터 10종(문자열·숫자·객체·null·깨진 JSON·비객체 레코드)에도 renderSites가 던지지 않는다',
      !err, err && (err.constructor.name + ': ' + err.message));
    T('v336 적대 데이터에서도 목록이 그려지고 스크립트는 이스케이프된다',
      DOM.siteList.innerHTML.length > 0 && DOM.siteList.innerHTML.indexOf('<script>') < 0, 'len=' + DOM.siteList.innerHTML.length);
  }

  // ---- ③ asList·normAsbRow 단위 ----
  {
    const { api } = build([]);
    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    T('v336 asList: "[]"→[] / JSON 문자열→배열 / 쉼표 문자열→배열 / 배열→원본',
      eq(api.asList('[]'), []) && eq(api.asList('["u1","u2"]'), ['u1', 'u2'])
      && eq(api.asList('u1, u2'), ['u1', 'u2']) && eq(api.asList(['x']), ['x']), '');
    T('v336 asList: null·undefined·숫자·객체·깨진 JSON 어떤 것도 던지지 않고 배열을 돌려준다',
      eq(api.asList(null), []) && eq(api.asList(undefined), []) && eq(api.asList(7), [])
      && eq(api.asList({}), []) && Array.isArray(api.asList('[u1,')), '');
    const row = { id: 'x', member_ids: '[]', worker_ids: '["w1"]' };
    api.normAsbRow(row);
    T('v336 normAsbRow: 입구에서 모양을 교정한다(다음 저장 때 서버 기록도 배열로 정리된다)',
      Array.isArray(row.member_ids) && row.member_ids.length === 0 && row.worker_ids[0] === 'w1', JSON.stringify(row));
    T('v336 loadAsb가 로드 직후 normAsbRow를 돌린다(교정을 화면이 아니라 입구에서 한다)',
      /asb\.forEach\(normAsbRow\)/.test(fnSrc('loadAsb')), '');
  }

  // ---- ④ 저장 뒤 닫힘 보장: 닫기·토스트가 렌더보다 먼저, 렌더는 다음 프레임 ----
  {
    [['saveAsb', 'closeAsb'], ['deleteAsb', 'closeAsb'], ['saveEdu', 'closeEdu'], ['deleteEdu', 'closeEdu']].forEach(([fn, closer]) => {
      const b = fnSrc(fn);
      const ci = b.lastIndexOf(closer + '()'), ri = b.indexOf('afterSave(');
      T('v336 ' + fn + ': ' + closer + '()가 화면 갱신(afterSave)보다 먼저 — 렌더가 죽어도 창은 닫힌다', ci > 0 && ri > 0 && ci < ri, 'close@' + ci + ' render@' + ri);
    });
    T('v336 afterSave는 렌더를 다음 프레임으로 미룬다(rAF, 없으면 setTimeout)',
      /requestAnimationFrame\(run\); else setTimeout\(run, 0\)/.test(fnSrc('afterSave')), '');
    T('v336 afterSave의 실패는 콘솔·err_log 텔레메트리로만 남는다 — 사용자에게 오류 문구를 던지지 않는다',
      /reportErr\(/.test(fnSrc('afterSave')) && !/gwToast/.test(fnSrc('afterSave')), '');
    T('v336 성공 토스트는 "저장했습니다" 한 줄뿐 — v335의 실패 문구·부가 안내는 제거됐다',
      /gwToast\("저장했습니다"\)/.test(html) && html.indexOf('저장은 됐지만 화면 갱신에 실패했습니다') < 0
      && html.indexOf('목록 맨 위에서 확인하세요') < 0, '');
    T('v336 v335 safeRender는 정의·호출 모두 남아 있지 않다(덮는 층을 걷어낸 자리)',
      html.indexOf('function safeRender') < 0 && html.indexOf('safeRender([') < 0, '');
  }

  // ---- ⑤ 전수: 모달을 닫는 저장 경로는 전부 "닫기 먼저" 여야 한다 ----
  //      한 곳이라도 렌더가 닫기보다 앞서면 같은 사고(창이 안 닫혀 사람이 다시 누름 → 중복 저장)가 재현된다.
  {
    const fnBlocks = [];
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(html))) {
      let d = 0, started = false, end = -1;
      for (let j = m.index; j < html.length; j++) {
        const ch = html[j];
        if (ch === '{') { d++; started = true; }
        else if (ch === '}') { d--; if (started && d === 0) { end = j + 1; break; } }
      }
      if (end > 0) fnBlocks.push({ name: m[1], body: html.slice(m.index, end) });
    }
    const bad = [];
    fnBlocks.forEach((f) => {
      if (f.body.length > 14000) return;
      if (!/\b(schedule\w*Save|save\w*Cache|doSave\w*|saveDocuments|saveClients)\s*\(/.test(f.body)) return;   // 저장하는 함수만
      const closeRe = /\b(close[A-Z]\w*\s*\(\s*\)|classList\.remove\(\s*"show"\s*\))/g;
      const renderRe = /\brender[A-Z]\w*\s*\(/g;
      let lastClose = -1, lastRender = -1, x;
      while ((x = closeRe.exec(f.body))) lastClose = x.index;
      while ((x = renderRe.exec(f.body))) lastRender = x.index;
      if (lastClose < 0 || lastRender < 0) return;
      if (lastRender < lastClose) bad.push(f.name);
    });
    T('v336 전수: 저장하며 모달을 닫는 경로 어디에도 "렌더 뒤에 닫기"가 남아 있지 않다(' + fnBlocks.length + '개 함수 대조)',
      bad.length === 0, '렌더가 닫기를 막을 수 있는 함수: ' + bad.join(', '));
  }
} catch (e) { console.log('  (v336 검사 생략 — ' + e.message + ')'); fails++; }

// 38) v337 — v336 적대검증(9/10)에서 나온 반례. asList는 member_ids만 못 박았고 **정렬 비교자**는
//     start·next가 문자열이라고 그대로 믿고 있었다. 9/2 일괄 입력분이 배열 자리에 문자열을 넣었듯
//     같은 경로가 날짜 자리에 숫자(20260901)를 넣으면 (b.start||"").localeCompare 가 없어 렌더가 통째로 죽는다.
//     → 사고 재발 조건이 그대로 남아 있었다는 뜻이다. String()으로 못 박고 여기서 회귀를 잡는다.
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
  const ASB_STATUS_SRC = 'var ASB_STATUS = ' + (html.match(/var ASB_STATUS = (\{[^}]*\});/) || [])[1] + ';';
  // v435: '지난 자료' 묶음 선언(소스 그대로) — v336 하네스와 같은 방식
  const SITE_OLD_SRC = (html.match(/var SITE_OLD_BEFORE = \d+;/) || ['/* SITE_OLD_BEFORE 없음 */'])[0] + ' ' + (html.match(/var siteOldOpen = false;/) || ['/* siteOldOpen 없음 */'])[0];
  const mkEl = (id) => ({ id, innerHTML: '', textContent: '', querySelectorAll: () => [] });
  const COMMON = [
    fnSrc('pad'), fnSrc('fmtDate'), fnSrc('todayStr'), fnSrc('esc'), fnSrc('addDays'), fnSrc('isDate'), fnSrc('asList'),
    'function findMember(id){ for(var i=0;i<members.length;i++){ if(members[i].id===id) return members[i]; } return null; }',
    'function memberName(id){ if(!id) return ""; var m=findMember(id); return m?m.name:""; }',
    'function dispName(n){ return n||""; }',
    'function liveMembers(){ return members.filter(function(m){ return m && m.del!==1; }); }',
    'function memberRetired(m){ return false; }',
  ];

  // ---- ① 석면: start가 문자열이 아니어도 목록이 그려진다 ----
  {
    const DOM = { siteList: mkEl('siteList'), siteHead: mkEl('siteHead') };
    const api = new Function('__items', '__DOM', [
      'var document = { getElementById: function(id){ return __DOM[id] || null; } };',
      'var asb = __items; var workers = []; var members = []; var edu = [];',
      ...COMMON,
      'function liveEdu(){ return edu.filter(function(r){ return r && r.del!==1; }); }',
      fnSrc('eduLatest'), fnSrc('eduHasValidSpecial'), ASB_STATUS_SRC,
      fnSrc('liveAsb'), fnSrc('normAsbRow'), fnSrc('asbNotifyDue'), fnSrc('asbKeepUntil'),
      'var SITE_KIND = { asbestos:"석면", demolition:"철거", dredge:"준설" }; var siteFilter = "", siteQ = "";',
      SITE_OLD_SRC,
      'function renderSiteFilter(){} function canDo(){ return false; } function fmtAmount(v){ return String(v); } function openAsb(){} function openSiteWorkers(){}',
      fnSrc('siteKind'), fnSrc('liveSites'), fnSrc('siteLabel'), fnSrc('siteYear'),
      'function canSee(){ return true; } var siteEduGap = null, siteEduGapSig = {};', fnSrc('siteGapSig'), fnSrc('siteEduLine'),   // v433 특별교육 줄(안전 권한형 = 종전 화면)
      fnSrc('asbWorkerNames'), fnSrc('asbNoSpecial'), fnSrc('sheetRow'), fnSrc('bindFold'), fnSrc('renderSites'),
      'return { renderSites: renderSites };',
    ].join('\n'))([
      { id: 's1', title: '정상 문자열', start: '2026-05-01', end: '2026-05-10', member_ids: [], worker_ids: [] },
      { id: 's2', title: '숫자 날짜', start: 20260101, end: 20260115, member_ids: '[]', worker_ids: '[]' },
      { id: 's3', title: '객체 날짜', start: {}, end: [], member_ids: [], worker_ids: [] },
      { id: 's4', title: 'null 날짜', start: null, end: null, member_ids: [], worker_ids: [] },
      { id: 's5', title: '뒤쪽 정상', start: '2026-03-01', end: '2026-03-05', member_ids: [], worker_ids: [] },
    ], DOM);
    let err = null;
    try { api.renderSites(); } catch (e) { err = e; }
    T('v337 반례: start가 숫자·객체·null이어도 renderSites가 던지지 않는다(정렬 비교자 String 고정)',
      !err, err && (err.constructor.name + ': ' + err.message));
    T('v337 반례: 그 상태에서도 5건이 실제로 그려진다(빈 목록으로 죽지 않는다 — v435: 객체·null 날짜 2건은 날짜 없음이지만 상태 칸이 없어(카드 "예정") 종결이 아니므로 지난 자료 묶음에 넣지 않는다, 검토 반영 — 머리 "총 5건"·묶음 없음)',
      DOM.siteHead.textContent === '총 5건' && DOM.siteList.innerHTML.indexOf('숫자 날짜') >= 0 && DOM.siteList.innerHTML.indexOf('뒤쪽 정상') >= 0 && DOM.siteList.innerHTML.indexOf('data-site-old-fold') < 0,
      'head=' + DOM.siteHead.textContent + ' len=' + DOM.siteList.innerHTML.length);
  }

  // ---- ② 교육 이력: next가 문자열이 아니어도 목록이 그려진다(같은 부류 — 저장 경로가 v336에서 함께 바뀐 자리) ----
  {
    const DOM = { L: mkEl('L'), H: mkEl('H') };
    const kIdx = html.indexOf('var EDU_KINDS');
    const EDU_KINDS_SRC = html.slice(kIdx, html.indexOf('];', kIdx) + 2);
    const api = new Function('__items', '__DOM', [
      'var document = { getElementById: function(id){ return __DOM[id] || null; } };',
      'var edu = __items; var workers = []; var members = [];',
      ...COMMON, EDU_KINDS_SRC,
      fnSrc('eduKindDef'), fnSrc('eduKindLabel'), fnSrc('eduPersonName'), fnSrc('liveEdu'), fnSrc('renderEduInto'),
      'return { renderEduInto: renderEduInto };',
    ].join('\n'))([
      { id: 'n0', ptype: 'member', pid: 'u1', kind: 'special', date: '2026-05-01', next: '2026-05-01' },
      { id: 'n1', ptype: 'member', pid: 'u1', kind: 'regular', date: '2026-01-01', next: 20260101 },
      { id: 'n2', ptype: 'member', pid: 'u1', kind: 'regular', date: '2026-03-01', next: '2026-03-01' },
      { id: 'n3', ptype: 'member', pid: 'u1', kind: 'regular', date: '2026-01-15', next: '2026-01-15' },
      { id: 'n4', ptype: 'member', pid: 'u1', kind: 'regular', date: '2026-02-02', next: '2026-02-02' },
    ], DOM);
    let err = null;
    try { api.renderEduInto('L', 'H', 'member'); } catch (e) { err = e; }
    T('v337 반례: next가 문자열이 아니어도 renderEduInto가 던지지 않는다', !err, err && (err.constructor.name + ': ' + err.message));
    T('v337 반례: 교육 이력 5건이 실제로 그려진다', DOM.H.textContent.indexOf('총 5건') === 0, 'head=' + DOM.H.textContent);
  }

  // ---- ③ 정적: 레코드 필드에 거는 localeCompare는 전부 String()으로 감싼다 ----
  {
    const bare = [];
    const re = /\(\s*[ab]\.\w+\s*\|\|\s*"[^"]*"\s*\)\.localeCompare/g;
    let m; while ((m = re.exec(html))) bare.push(html.slice(Math.max(0, m.index - 60), m.index + m[0].length).replace(/\s+/g, ' '));
    T('v337: 석면·교육 렌더 정렬이 String()으로 못 박혀 있다',
      /String\(b\.start\|\|""\)\.localeCompare\(String\(a\.start\|\|""\)\)/.test(html.replace(/\s+/g, ''))
      && /String\(a\.next\|\|"9999"\)\.localeCompare\(String\(b\.next\|\|"9999"\)\)/.test(html.replace(/\s+/g, '')), '');
    // 남은 맨 localeCompare는 리포트만 한다(석면·교육 밖 — 이번 갈래가 아니다)
    if (bare.length) console.log('  (참고: String() 없이 필드에 거는 localeCompare ' + bare.length + '곳 남음 — 휴가·기성 등 다른 갈래)');
  }

  // ---- ④ 409 병합도 입구다: 재저장 경로가 normAsbRow를 다시 건다 ----
  {
    const src = fnSrc('doSaveAsb').replace(/\s+/g, ' ');
    T('v337: 409 충돌 병합 뒤에도 normAsbRow를 다시 걸어 문자열 "[]"가 서버로 되돌아가지 않는다',
      /mergeAsb\(asb,\s*Array\.isArray\(doc\.items\)\s*\?\s*doc\.items\s*:\s*\[\]\s*\);\s*asb\.forEach\(normAsbRow\);/.test(src), src.slice(0, 200));
  }
} catch (e) { console.log('  (v337 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v351(PM 9/11): 노선표 기본표 앱↔서버 일치(R40 포함) · [노선 지정] 드롭다운 맨 위 "＋ 새 노선으로 추가…" · 인라인 폼 → ab_route_add → 바로 지정 · 서버·워커·엑셀 봇이 같은 추가분(routes_extra)을 본다 ----
try {
  const lib = readFileSync(join(ROOT, 'netlify/functions/_lib/allbaro.js'), 'utf8');
  const ab = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro.js'), 'utf8');
  const wk = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro-run-background.js'), 'utf8');
  const appR = [...html.matchAll(/\{s:"([LR])",r:(\d+),f:"([^"]*)",t:"([^"]*)",i:"([^"]*)"\}/g)].map((m) => m.slice(1).join('|'));
  const svrR = [...lib.slice(lib.indexOf('const BASE_ROUTES'), lib.indexOf('const EXTRA_ROW_MIN')).matchAll(/\{ side: "([LR])", row: (\d+), from: "([^"]*)", to: "([^"]*)", item: "([^"]*)"/g)].map((m) => m.slice(1).join('|'));
  T('노선표 기본표 앱 AB_ROUTES ↔ 서버 BASE_ROUTES 71줄 완전 일치 · R40 한라티씨→거성산업 분진 · 예비 행 40~49',
    appR.length === 71 && appR.length === svrR.length && appR.every((x, i) => x === svrR[i]) && appR.indexOf('R|40|한라티씨|거성산업|분진') >= 0 && /const EXTRA_ROW_MIN = 40, EXTRA_ROW_MAX = 49;/.test(lib),
    '앱 ' + appR.length + ' / 서버 ' + svrR.length + (appR.length === svrR.length ? ' 첫 불일치 ' + (appR.findIndex((x, i) => x !== svrR[i])) : ''));
  T('서버: 요청 시작에 추가분 합침(loadExtraRoutes) · ab_route_add 분기 · findRoute가 현재 표를 본다 · ROUTE_LIST/ROUTE_INDEX 스냅샷 없음 · hidden export에 routes_extra · 워커도 합친 뒤 매칭',
    /await loadExtraRoutes\(store\(DATA\)\);/.test(ab) && /case 'ab_route_add': return await handleRouteAdd\(st, c, d, R\);/.test(ab) && /function findRoute\(side, row\) \{\s*const list = AB\.routes\(\);/.test(ab)
    && !/ROUTE_LIST|ROUTE_INDEX/.test(ab) && /routes_extra: extra, request_id: R/.test(ab) && /AB\.setExtraRoutes\(\(ex\.ok && ex\.data && Array\.isArray\(ex\.data\.items\)\) \? ex\.data\.items : \[\]\);/.test(wk), '');
  const i0 = html.indexOf('function abRouteOptsHtml(');
  const opts = html.slice(i0, html.indexOf('\n  }', i0));
  T('앱 드롭다운: 첫 항목 "— 양식 줄 선택 —" 바로 다음(맨 위)에 "＋ 새 노선으로 추가…"(value __new__)', /— 양식 줄 선택 —<\/option>' \+\s*'<option value="__new__">＋ 새 노선으로 추가…<\/option>'/.test(opts), opts.slice(0, 200));
  T('앱 새 노선 폼·저장: abNewRouteFormHtml(상차지·하차지·품목 프리필, L/R 기본 = 먼저 비는 열) · abRouteAddGo → ab_route_add → 성공 시 abLearnGo(noConfirm) 바로 지정 · 취소·날짜 이동·로그아웃에 abLearnNew 초기화 · ROWS_FULL 문구',
    ['abFreeReserve', 'abNewRouteFormHtml', 'abRouteAddGo'].every((f) => new RegExp('function ' + f + '\\(').test(html)) && /action: "ab_route_add", from: from, to: to, item: item, side: side/.test(html)
    && /abLearnGo\(key, sd \+ "\|" \+ rw, true\);/.test(html) && /function abLearnGo\(key, val, noConfirm\)/.test(html) && /if \(!noConfirm && !confirm\("이 조합을 아래 줄로 지정할까요\?/.test(html)
    && (html.match(/abLearnNew = "";/g) || []).length >= 4 && /ROWS_FULL: "양식 예비 줄\(40~49행\)이 다 찼습니다/.test(html) && /if \(abLearnNew === key\) abRouteAddGo\(key, host\);/.test(html), '');
} catch (e) { console.log('  (v351 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v352(PM 9/11 #33): 숨김·노선 변경 뒤 엑셀 재생성 요청(dispatch) + 내려받기 stale 경고 ----
try {
  const ab = readFileSync(join(ROOT, 'netlify/functions/gw-allbaro.js'), 'utf8'), rg = readFileSync(join(ROOT, 'netlify/functions/_lib/xlsx_regen.js'), 'utf8');
  T('서버(v385 _lib/xlsx_regen): requestXlsxRegen(디바운스 2분·토큰 3후보·6초 타임아웃·204 접수·소급 9~60) — gw-allbaro 7곳(숨김/해제·노선 추가·노선 지정·재정렬 2·직접 추가·내려받기 재시도) · handleXlsx가 stale/why/changed_at/covered/regen 동봉',
    /const REGEN_KEY = 'allbaro:xlsx_regen';/.test(rg) && /const REGEN_DEBOUNCE_MS = 120000;/.test(rg) && /process\.env\.GW_APPDATA_GITHUB_TOKEN \|\| process\.env\.GW_GALLERY_GITHUB_TOKEN \|\| process\.env\.MEMBER_RELAY_GITHUB_TOKEN/.test(rg)
    && /\/actions\/workflows\/' \+ REGEN_WORKFLOW \+ '\/dispatches'/.test(rg) && /require\('\.\/_lib\/xlsx_regen'\)/.test(ab) && !/async function requestXlsxRegen/.test(ab) && (ab.match(/await requestXlsxRegen\(st, /g) || []).length === 7
    && /const stale = why\.length > 0;/.test(ab) && /src_at: base \|\| null, total: r\.data\.total, stale: stale, why: why, changed_at: changedAt \|\| null, covered: covered, regen: stale \? regen : null/.test(ab) && /if \(covers && now - disp < REGEN_STALE_MS\) state = 'in_flight';/.test(ab) && /cover_from = kstDayMinus\(db - 1\)/.test(rg) && /days_back: String\(db \+ 1\)/.test(rg), '');
  T('앱: 내려받기 전 stale이면 abXlsxStaleOk 확인창(생성 시각·놓친 변경·재생성 상태·60일 밖·토큰 실패 안내)',
    /if\(res\.body\.stale && !abXlsxStaleOk\(res\.body\)\) return;/.test(html) && /function abXlsxStaleOk\(b\)\{/.test(html) && /GW_APPDATA_GITHUB_TOKEN/.test(html) && /자동 재생성 범위\(최근 59일\) 밖/.test(html), '');
} catch (e) { console.log('  (v352 엑셀 재생성 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v353(PM 9/13): ① 운반내역 표 가나다 반반(엑셀 generate.py와 같은 규칙) ② 홍보 사진 모자이크(가리기) 배선·소비처 4곳 mask 우선 ----
try {
  const seg = (html.match(/function abSheetTableHtml\(rl, rows\)\{([\s\S]*?)\n  function abSortKey/) || ['', ''])[1];
  T('운반내역 표: 보이는 노선을 abSortKey(한글 먼저·법인격 제거)로 정렬해 앞 절반 왼쪽·뒤 절반 오른쪽 · 숨김은 표에서 뺌 · side 필터 렌더 없음',
    /var half = Math\.ceil\(vis\.length \/ 2\), halves = \[vis\.slice\(0, half\), vis\.slice\(half\)\];/.test(seg) && /table\(halves\[0\], "L"\) \+ table\(halves\[1\], "R"\)/.test(seg)
    && /if \(fr\.h && fempty\)\{ hiddenN\+\+; continue; \}/.test(seg) && /if \(!fr\.h && fempty && abHideEmpty\)\{ emptyN\+\+; continue; \}/.test(seg) && !/if \(empty && abHideEmpty\)\{ emptyN\+\+; continue; \}/.test(seg) && !/rl\.filter\(function\(r\)\{ return r\.s === side; \}\)/.test(seg)
    && /function abSortKey\(name\)\{/.test(html) && /\["㈜", "\(주\)", "주식회사", "\(유\)", "유한회사", "\(合\)"\]/.test(html), '');
  const img = readFileSync(join(ROOT, 'netlify/functions/gw-promo-img.js'), 'utf8');
  const gal = readFileSync(join(ROOT, 'netlify/functions/gw-gallery-relay.js'), 'utf8');
  const feed = readFileSync(join(ROOT, 'netlify/functions/gw-gallery-feed.js'), 'utf8');
  const pw = readFileSync(join(ROOT, 'netlify/functions/gw-promo-ai-run-background.js'), 'utf8');
  const mk = readFileSync(join(ROOT, 'netlify/functions/gw-promo-mask.js'), 'utf8');
  const mw = readFileSync(join(ROOT, 'netlify/functions/gw-promo-mask-background.js'), 'utf8');
  const ml = readFileSync(join(ROOT, 'netlify/functions/_lib/promomask.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  T('모자이크 서버: jimp 의존성 · _lib/promomask(detectBoxes·applyBoxes·cleanBoxes·PAD 0.2) · 워커 내부 토큰 __promomask__ · 디스패처 6액션 · API 키는 env에서만',
    !!(pkg.dependencies && pkg.dependencies.jimp) && /async function detectBoxes\(apiKey, mediaType, b64\)/.test(ml) && /async function applyBoxes\(buf, boxes\)/.test(ml) && /const PAD = 0\.20;/.test(ml)
    && /v\.payload\.mid !== '__promomask__'/.test(mw) && ['mask_start', 'mask_job', 'mask_state', 'mask_get', 'mask_apply', 'mask_clear'].every((a) => new RegExp("case '" + a + "'").test(mk))
    && !/process\.env\.GW_ANTHROPIC_KEY/.test(ml) && /process\.env\.GW_ANTHROPIC_KEY/.test(mw), '');
  T('소비처 5곳 mask 우선: 공개 서빙·검수 격자 att_get(raw:true는 홍보 do+승인 기기+감사)·갤러리 릴레이·갤러리 실경로(feed index/img)·사진AI 워커 · att_del이 mask·maskmeta 동반 삭제 · 캐시 5분',
    /blobGet\(store\(FILES\), 'mask:' \+ ids\[i\]\)/.test(img) && /max-age=300/.test(img) && /blobGet\(store\(FILES\), 'mask:' \+ String\(d\.id \|\| ''\)\)/.test(gwd) && /if \(d\.raw !== true\) \{/.test(gwd) && /if \(permOf\(c\.member, 'promo'\) !== 'do'\) return jr\(403/.test(gwd) && /op: '원본열람'/.test(gwd)
    && /blobGet\(store\(FILES\), 'mask:' \+ id\)/.test(gal) && (feed.match(/blobGet\(store\(FILES\), 'mask:' \+ (id|att)\)/g) || []).length === 2 && /max-age=300/.test(feed) && /blobGet\(fst, 'mask:' \+ id\)/.test(pw)
    && /\['mask:' \+ String\(d\.id \|\| ''\), 'maskmeta:' \+ String\(d\.id \|\| ''\)\]/.test(gwd), '');
  T('적대 검증 반영: 비전 stop_reason 검사(REFUSAL·TRUNCATED)·parseBoxes null·MAX_TOKENS 4096·effort low·cleanBoxes 클램프·PAD_MIN · 워커 force=자동 판만(human 보호)·저장 직전 재확인·12분 예산·maskmeta · 디스패처 월 상한·잠금 재확인·apply 검사 · 앱 좌표 클램프·다시 확인창',
    /stop === 'refusal'/.test(ml) && /stop === 'max_tokens'/.test(ml) && /if \(boxes === null\) throw new Error\('PARSE'\)/.test(ml) && /const MAX_TOKENS = 4096;/.test(ml) && /effort: 'low'/.test(ml) && /const x0 = Math\.max\(0, x\), y0 = Math\.max\(0, y\), x1 = Math\.min\(1, x \+ w\), y1 = Math\.min\(1, y \+ h\);/.test(ml) && /const PAD_MIN = 0\.01;/.test(ml)
    && /if \(prev && isHuman\(prev\)\)/.test(mw) && /const again = await blobGet\(fst, M\.maskKey\(id\)\);/.test(mw) && /const BUDGET_MS = 12 \* 60 \* 1000;/.test(mw) && /M\.metaKey\(id\), M\.metaOf\(rec\)/.test(mw)
    && /const MONTH_CALL_CAP = 1000;/.test(mk) && /const lk2 = await blobGet\(st, lockKey\(promoId\)\);/.test(mk) && /const chk = M\.checkImageRec\(r\.data\);/.test(mk) && /human: true, boxes: boxes/.test(mk)
    && /return \{ x:Math\.max\(0,Math\.min\(cv\.width,x\)\), y:Math\.max\(0,Math\.min\(cv\.height,y\)\) \};/.test(html) && /if\(again && !confirm\("자동 판을 다시 감지합니다/.test(html), '');
  T('앱: 격자 배지(data-mask-badge)·상태줄·maskKick(새 기록 저장 뒤 자동)·편집 창(maskCanvas·끌어서 추가·탭 삭제·적용 human)·완성본 열기 전 미확인 경고',
    /data-mask-badge=/.test(html) && /id="promoMaskLine"/.test(html) && /if\(maskAutoWait\)\{ var mw=maskAutoWait; maskAutoWait=""; maskKick\(mw, false\); \}/.test(html) && /maskAutoWait=item\.id;/.test(html)
    && ['maskRefreshState', 'maskKick', 'maskOpenEditor', 'maskDraw', 'maskApply', 'maskPaintBadges'].every((f) => new RegExp('function ' + f + '\\(').test(html))
    && /action:"mask_apply",att_id:maskEd\.id,boxes:boxes/.test(html) && /by:"human"/.test(html) && /action:"att_get",id:attId,raw:true/.test(html)
    && /가리기 확인이 안 된 사진 "\+un\+"장이 있습니다/.test(html) && /id="maskCanvas"/.test(html), '');
} catch (e) { console.log('  (v353 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v339: 기본 숨김 모듈 집합이 앱·서버에서 갈라지면 권한 구멍이 된다(9/4 hr·9/10 lic 실사고) ----
try {
  const same = (a, b) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
  const keys = (src, re) => [...((src.match(re) || ['', ''])[1]).matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
  const appC = keys(html, /var PERM_CLOSED = \{([^}]+)\}/);
  const svrC = keys(gwd, /const PERM_CLOSED = \{([^}]+)\}/);
  const askS = readFileSync(join(ROOT, 'netlify/functions/_lib/ask.js'), 'utf8');
  T('v424 검토 물어보기 권한: 기본 숨김 집합 = 서버와 같음 · 석면 도구 = 현장 권한(gw-data COL과 같음)', keys(askS, /const PERM_CLOSED = \{([^}]+)\}/).join() === svrC.join() && /asbestos: 'site'/.test(askS) && /asbestos: *'site'/.test(gwd), '');
  T('기본 숨김 집합(PERM_CLOSED) 앱↔서버 일치 + lic·site·safety·hw 포함(인허가=면허 · site=현장 대장, 둘 다 관리부·운영부만 · safety=안전 › 교육·검진, v430 명시 부여만 · hw=화관법, v431 관리+운영만) — 7개',
    appC.length === 7 && same(appC, svrC) && appC.indexOf('lic') >= 0 && appC.indexOf('site') >= 0 && appC.indexOf('safety') >= 0 && appC.indexOf('hw') >= 0,
    '앱 [' + appC.join(',') + '] / 서버 [' + svrC.join(',') + ']');
  T('앱 permOf·pmVal 둘 다 PERM_CLOSED를 쓴다(집합이 함수마다 따로 놀지 않게)',
    /return \(m\.perms && m\.perms\[mod\]\) \|\| \(PERM_CLOSED\[mod\] \? "hide" : "view"\);/.test(html)
    && (html.match(/PERM_CLOSED\[mod\] \? "hide" : "view"/g) || []).length === 2, '');
} catch (e) { console.log('  (PERM_CLOSED 대조 생략 — ' + e.message + ')'); fails++; }

// ---- v357: 잠정 건 가시화(인계번호·경과일·3일+ 미확정) — PM 9/14 "9/11 동일→스틸 1대인데 앱 2대". 계수 규칙은 그대로(n_pending 포함) ----
try {
  const ab = readFileSync(join(ROOT, 'netlify/functions/_lib/allbaro.js'), 'utf8');
  T('서버: pending 행에 date(인계일자) 동봉 · 앱: abPendList/Age/Info/Badge · 3일+ 미확정 붉은 배지 · 표 셀·합계줄 표시 · 계수 규칙(pendN 포함) 불변',
    /pending\.push\(\{ manf: [^}]*state: state, date: d \}\)/.test(ab)
    && ['abPendList', 'abPendAge', 'abPendInfo', 'abPendBadge'].every((f) => new RegExp('function ' + f + '\\(').test(html))
    && /var AB_PEND_STALE_DAYS = 3;/.test(html) && /class="dday red" title="' \+ esc\(base \+ \(pi\.title/.test(html) && !/dday amber" title="' \+ esc\(base/.test(html)
    && /abInt\(c\.n_pending\) \? abPendBadge\(c\) : ''/.test(html) && /sub \+= "잠정 " \+ np \+ "\(예약 미실행 가능 · 미확정"/.test(html)
    && /var ps = abPendInfo\(null\)\.stale;/.test(html) && /pendN \+= abInt\(c\.n_pending\);/.test(html), '');
  // 경과일 계산·배지 분기 실행(순수 함수만 떼어 실행)
  const fn = (name) => { const i = html.indexOf('function ' + name + '('); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
  const api = new Function('__pend', '__today', [
    'var abDay = { data: { pending: __pend } }; function todayStr(){ return __today; } function abInt(v){ return Number(v) || 0; }',
    'function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }',
    'var AB_PEND_STALE_DAYS = 3;', fn('abPendList'), fn('abPendAge'), fn('abPendInfo'), fn('abPendBadge'),
    'return { info: abPendInfo, badge: abPendBadge };'].join('\n'));
  const P = [{ manf: '2609524417', from: '동일산업(주)', to: '(주)스틸싸이클', item: '분진(고상)', state: '운반중', date: '20260911' },
             { manf: '2609564886', from: '동일산업(주)', to: '(주)스틸싸이클', item: '분진(고상)', state: '운반중', date: '20260911' },
             { manf: '2609500001', from: '(주)스틸싸이클', to: '씨엔텍', item: '분진(고상)', state: '운반중', date: '20260914' }];
  const a = api(P, '2026-09-15');
  const c1 = { from: '동일산업(주)', to: '(주)스틸싸이클', item: '분진(고상)', n_pending: 2 };
  const c2 = { from: '(주)스틸싸이클', to: '씨엔텍', item: '분진(고상)', n_pending: 1 };
  const i1 = a.info(c1), b1 = a.badge(c1), b2 = a.badge(c2), i0 = a.info(null);
  T('실행(v358): 4일 경과 2건 → 붉은 "잠정 2 · 예약 미실행 가능 · 3일+ 2"·인계번호 둘 다 title에 · 1일 경과 건도 붉은 "잠정 1 · 예약 미실행 가능"(3일+ 없음) (v366 문구) · 전체 stale 2',
    i1.n === 2 && i1.stale === 2 && /dday red/.test(b1) && /잠정 2 · 예약 미실행 가능 · 3일\+ 2</.test(b1) && /2609524417/.test(b1) && /2609564886/.test(b1) && /4일 경과/.test(b1)
    && /dday red/.test(b2) && /잠정 1 · 예약 미실행 가능</.test(b2) && !/3일\+/.test(b2) && !/dday amber/.test(b2) && i0.stale === 2 && i0.n === 3, b1 + ' / ' + b2);
} catch (e) { console.log('  (v357 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v359: 입찰 2-E — 불일치는 공고문 기준(PM 9/16) · 낙찰방법 판독 3상태 노출 ----
try {
  const fn = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
  const DTM = (html.match(/var DECIDE_TO_METHOD=\{[^}]*\};/) || [''])[0];
  const api = new Function([DTM, fn('methodKindOf'), fn('bidMethodEff'), fn('bidLwltState'), fn('bidDecideState'), 'return { eff: bidMethodEff, st: bidLwltState, ds: bidDecideState, kind: methodKindOf };'].join('\n'))();
  const mm = { method: '소액수의견적', docs: [{ n: '공고문.hwpx' }], ext: { mmis: 1, decide: '적격심사', dsrc: 'doc', dctx: 'STRONG:적격심사를실시합니다' } };
  const neg = { method: '적격심사제', docs: [{ n: '공고문.pdf' }], ext: { mmis: 1, dneg: 1 } };
  const ok = { method: '소액수의견적', docs: [{ n: '공고문.hwpx' }], ext: { mmis: 0, decide: '소액수의(견적)', lwlt: '88' } };
  const un = { method: '적격심사제', docs: [{ n: '공고문.hwpx' }], ext: { mmis: 0 } };
  const nd = { method: '적격심사제', docs: [{ n: '내역서.xlsx' }], ext: {} };
  T('v359 bidMethodEff: 불일치+공고문 적격심사 → 적격심사제(doc) · 부정 명시 → 미상(neg) · 일치 → API 그대로',
    api.eff(mm).m === '적격심사제' && api.eff(mm).src === 'doc' && api.kind(api.eff(mm).m) === 'qual' && api.eff(neg).m === '' && api.eff(neg).src === 'neg' && api.eff(ok).m === '소액수의견적' && api.eff(ok).src === 'api', JSON.stringify([api.eff(mm), api.eff(neg)]));
  T('v359 bidLwltState는 실효 낙찰방법으로 판정: 불일치 적격(하한율 없음) → unread · 부정 명시 → method_unknown · 일치 소액수의 88 → read',
    api.st(mm) === 'unread' && api.st(neg) === 'method_unknown' && api.st(ok) === 'read', [api.st(mm), api.st(neg), api.st(ok)].join('/'));
  T('v359 bidDecideState 4상태: mismatch / read / unread / nodoc', api.ds(mm) === 'mismatch' && api.ds(ok) === 'read' && api.ds(un) === 'unread' && api.ds(nd) === 'nodoc', [api.ds(mm), api.ds(ok), api.ds(un), api.ds(nd)].join('/'));
  T('v359 화면: 카드 불일치 칩(공고문 기준 · API)·미판독 칩 · 상세 "낙찰방법 판독"·"산정 출처" 행 · 계산기 pre.method가 실효값 · 석면 통과선에 적용 세부기준 라벨 · 결정방식 행 제거',
    /\(공고문 기준 · API '\+esc\(me\.api\)\+'\)/.test(html) && />낙찰방법 미판독</.test(html) && /\["낙찰방법 판독", \(function\(\)/.test(html) && /\["산정 출처", \(function\(\)/.test(html)
    && /method: bidMethodEff\(b\)\.m\|\|"", budget: b\.budg/.test(html) && /적용 세부기준: 경북교육청 석면해체 2023 등록 기준/.test(html) && !/\["결정방식", /.test(html)
    && /var k=methodKindOf\(bidMethodEff\(b\)\.m\);/.test(html), '');
} catch (e) { console.log('  (v359 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v360: 사진AI 자동 생성 상태 문구(서버 ai_st) — "사진AI 미생성" 문구 제거 ----
try {
  const fn = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
  const api = new Function([fn('pad'), fn('esc'), fn('paFailShort'), fn('promoAiLine'), 'return promoAiLine;'].join('\n'))();
  const ph = [{ id: 'att_0000000000000001' }];
  T('v360 카드 문구: ai 있음 → 태그 N개 · 사진 없음 → 빈 문자열 · 상태 없음 → 대기(서버 10분) · running → 생성 중 · fail 1회 → 이유+재시도 · fail 4회 → 재시도 끝',
    /태그 3개/.test(api({ ai: {}, tags: [1, 2, 3], photos: ph })) && api({ photos: [] }) === '' && /자동 생성 대기\(서버가 10분 안에 시작\)/.test(api({ photos: ph }))
    && /자동 생성 중\(/.test(api({ photos: ph, ai_st: { st: 'running', ts: Date.now() } })) && /자동 생성 실패 1회\(네트워크 끊김/.test(api({ photos: ph, ai_st: { st: 'fail', tries: 1, code: 'NETWORK', ts: Date.now() } })) && /서버가 잠시 뒤 다시 시도/.test(api({ photos: ph, ai_st: { st: 'fail', tries: 1, code: 'NETWORK', ts: Date.now() } }))
    && /자동 재시도 끝/.test(api({ photos: ph, ai_st: { st: 'fail', tries: 4, code: 'TIMEOUT', ts: Date.now() } })), '');
  T('v361 게시 완료 카드: 태그 없으면 "태그 없이 게시됨 — 서버가 태그만 생성 중" · 태그만 채워지면 "(게시 뒤 태그만 생성…)" · paApplyToRecord는 posted면 제목·본문 안 바꿈',
    /태그 없이 게시됨/.test(api({ photos: ph, status: 'posted' })) && /게시 뒤 태그만 생성/.test(api({ photos: ph, status: 'posted', ai: { tags_only: 1 }, tags: ['a'] }))
    && /if\(p\.status==="posted"\)\{\s*if\(r\.tags&&r\.tags\.length\)\{ p\.tags=r\.tags\.slice\(0,25\); p\.ai=\{[^}]*tags_only:1 \}; \}/.test(html), '');
  T('v360 "사진AI 미생성" 문구가 앱에 없다 · 크론 등록(netlify.toml gw-promo-ai-cron */10) · 공용 층 존재',
    !/사진AI 미생성/.test(html) && /\[functions\."gw-promo-ai-cron"\]\s*\r?\n\s*schedule = "\*\/10 \* \* \* \*"/.test(readFileSync(join(ROOT, 'netlify.toml'), 'utf8'))
    && /PJ\.applyResult\(doc, promoId/.test(readFileSync(join(ROOT, 'netlify/functions/gw-promo-ai-run-background.js'), 'utf8')) && /PJ\.startJob\(st, \{ promoId/.test(readFileSync(join(ROOT, 'netlify/functions/gw-promo-ai.js'), 'utf8')), '');
} catch (e) { console.log('  (v360 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v381: 계약 시트형(A안) + 펼침 4탭 — 설계 브리핑 10/12 ㄱ ----
try {
  const seg = html.slice(html.indexOf('// @con-sheet-start'), html.indexOf('// @con-sheet-end'));
  const cols = [...seg.matchAll(/\{ k:"(\w+)",\s+h:"/g)].map((m) => m[1]);
  T('v381 시트 블록: CON_COLS 8열(발주처·현장·종류·사급/관급·계약액·단계·준공·담당) · 폰 숨김 4열(kind/pub/amount/who) · 칩 6 · 상태 키 jw_con_sheet',
    cols.join(',') === 'client,site,kind,pub,amount,stage,end,who' && (seg.match(/hs:1/g) || []).length === 4 && /CON_CHIPS = \[\["", "전체"\], \["active"/.test(seg) && /CON_SHEET_KEY = "jw_con_sheet"/.test(seg), cols.join(','));
  T('v381 배선: renderContracts가 시트 블록 안 · 종전 카드형은 renderContractsCards로 보존 · 펼침 4탭(ov/st/doc/lk) · 행/정렬/필터/칩/초기화/폭끌기/탭/닫기/단계서류 핸들러 · colspan=csN 2곳 · 폰 상세 카드 id',
    /function renderContracts\(\)\{/.test(seg) && !/function renderContractsCards\(\)\{/.test(html) && /\[\["ov", "개요"\], \["st", "단계·서류"\], \["lk", "연결"\]\]/.test(seg)   // v427 단계·서류 한 탭
    && seg.indexOf('querySelectorAll("tr.vs-r")') >= 0 && seg.indexOf('th[data-cs-sort]') >= 0 && seg.indexOf('querySelector("[data-cs-reset]")') >= 0
    && ['data-cf', 'data-cs-chip', 'data-cs-rs', 'data-cs-tab', 'data-cs-close', 'data-cs-sdoc'].every((a) => seg.indexOf('querySelectorAll("[' + a + ']")') >= 0)
    && (seg.match(/colspan="' \+ csN \+ '"/g) || []).length === 2 && ids.has('conDetailCard') && /#conDetailCard\{display:none;\}/.test(html) && /#conDetailCard\{display:block;margin-top:8px;\}/.test(html), '');
  T('v381 종전 행 버튼·첨부 배선(data-con-del/doc/xlsx/bldg · data-catt-del/rev, v423 올리기는 넣기 박스 cbxBind)이 펼침 안에서 그대로 묶인다',
    ['data-con-del', 'data-con-doc', 'data-con-xlsx', 'data-con-bldg', 'data-catt-del', 'data-catt-rev'].every((a) => seg.indexOf('querySelectorAll("[' + a + ']")') >= 0) && seg.indexOf('cbxBind(root)') >= 0, '');
  T('v381 CSS: .cs-stg 단계 카드(done/cur) · .cs-bar 진행 막대 · 폰 열 폭 4(cs-c-client/site/stage/end) · 시트 블록의 저장 호출은 v382 단계 입력·작업현황(새 키 vals/work_log/settle_amount) 7함수뿐(v401 csDocAfter 포함)',
    /\.cs-stg\.done\{/.test(html) && /\.cs-stg\.cur\{/.test(html) && /\.cs-bar i\{/.test(html) && ['client', 'site', 'stage', 'end'].every((k) => new RegExp('\\.vs col\\.cs-c-' + k + '\\{width:\\d+% !important;\\}').test(html))
    && (seg.match(/scheduleContractSave\(\)/g) || []).length === (seg.match(/function (csSkipStage|csUnskipStage|csJumpStage|csSaveFields|csWlAdd|csWlDel|csDocAfter|csChgAdd|csRowAct)\(/g) || []).length, '');   // v401 csDocAfter(서류 체크리스트) · v427 csRowAct(묶음·패킷 줄, 새 키 pkst)
} catch (e) { console.log('  (v381 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v382: 시나리오 조립(종류 × 사급/관급 → 단계 목록, PM 원문) · 선택 단계 · 작업현황 · 정산액 · 카드형 제거 ----
try {
  const sc = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const lists = {}; for (const m of sc.matchAll(/"(\w+:(?:pub|pri))": \[([^\]]*)\]/g)) lists[m[1]] = (m[2].match(/"/g) || []).length / 2;
  const want = { 'asbestos:pri': 8, 'asbestos:pub': 10, 'demolition:pri': 8, 'demolition:pub': 10, 'combo:pri': 9, 'combo:pub': 11, 'waste:pri': 6, 'waste:pub': 6, 'dredge:pub': 8, 'dredge:pri': 5 };
  T('v382 CON_SCEN 10목록(석면 8/10 · 철거 8/10 · 혼합 9/11 · 운반 6/6 · 준설 8/5) · 괄호 = 선택 단계 판정 · 적격심사 낙찰건은 맨 앞',
    Object.keys(want).every((k) => lists[k] === want[k]) && /function conIsOptName\(n\)\{ return \/\^\\\(\.\+\\\)\$\//.test(sc) && /if \(extra && extra\.qual\) out\.unshift\(\{ name:"적격심사"/.test(sc), JSON.stringify(lists));
  T('v382 옛 요소 체크 UI 제거(conElems·renderConElems·conElemChecked·conBuildStages 0) · 모달 conCombo/conScenPreview · 종류·사급/관급·혼합 change → renderConScen · 카드형 renderContractsCards 제거',
    !/conElems\b/.test(html) && !/renderConElems|conElemChecked|conBuildStages/.test(html) && ids.has('conCombo') && ids.has('conScenPreview') && ids.has('conComboWrap')
    && /getElementById\("conDoc"\)\.addEventListener\("change", renderConScen\)/.test(html) && /getElementById\("conCombo"\)\.addEventListener\("change", renderConScen\)/.test(html) && !/function renderContractsCards/.test(html) && !/CON_ELEMS\b/.test(html) && /var CON_ELEM_LABEL = \{/.test(html), '');
  T('v382 엔진: materializeStage가 skipped 단계를 지나감 · 지시 상세 stageDocsFor · startProcess가 {name,opt}·scen·doneFirst 수용 · 견적 승격은 견적 단계 완료 · 낙찰 유입 2곳이 renderConScen',
    /while\(pipe\.cur < pipe\.stages\.length && pipe\.stages\[pipe\.cur\]\.status==="skipped"\) pipe\.cur\+\+;/.test(html) && /detail:\(stageDocsOf\(s\)\|\|""\)/.test(html)
    && /opt:\(o\.opt\?1:0\)/.test(html) && /scen:opts\.scen\|\|null,/.test(html) && /if\(opts\.doneFirst && pipes\[0\]\.stages\.length>1\)/.test(html) && /doneFirst:qdf/.test(html)
    && (html.match(/cbs\.checked=!!\(sug\.asb&&sug\.demo\); renderConScen\(\);/g) || []).length === 2, '');
  T('v382 서류 라우팅이 PM 원문을 받는다: 노동부\\s*신고 · 해체\\s*완료\\s*신고 → demo_report · 정산액 conAmtEff(시트 금액 3곳·기성 1곳) · 단계 카드 버튼 6종 · 작업현황 표(CS_WL_COLS 8열) · 단계 입력 칸 15묶음',
    /if\(\/노동부\\s\*신고\/\.test\(s\) && !\/완료\/\.test\(s\)\) return "asb_plan";/.test(html) && /해체\\s\*완료\\s\*신고\/\.test\(s\)\) return "demo_report"/.test(html)
    && /function conAmtEff\(c\)/.test(html) && (html.match(/conAmtEff\(c\)/g) || []).length >= 4
    && ['data-cs-done', 'data-cs-skip', 'data-cs-unskip', 'data-cs-jump', 'data-cs-fsave'].every((a) => html.indexOf('csAct("' + a + '"') >= 0) && ['data-cs-wladd', 'data-cs-wldel', 'data-cs-stg'].every((a) => html.indexOf('querySelectorAll("[' + a + ']")') >= 0)
    && (html.match(/\["(\w+)","[^"]+","(?:date|text|num)"\]/g) || []).length >= 8 && (sc.match(/\[\/[^\]]+\/, \[\[/g) || []).length === 15, '');
} catch (e) { console.log('  (v382 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v382 적대 검토 반영(확정 21 = 12묶음) ----
try {
  T('v382 검토: advanceProc 가드(skipped·되감기) · materializeStage 중복 지시 금지 · completeStageNow pipeKey+review 재요청 금지 · 입금→수금확인 제안은 열린 단계일 때만 · 견적 승격 안내 분기 · 접기 버튼으로만 · 입력값 보존(csSnapInputs/csRestoreInputs) · 승인 게이트(csCanCloseCur) · 청구 건너뜀 경고',
    /if\(!s \|\| s\.status==="done" \|\| s\.status==="skipped" \|\| t\.stage_i < pipe\.cur\) return;/.test(html) && /if\(s\.status==="open" && s\.task_id && findTask\(s\.task_id\)\) return;/.test(html)
    && /function completeStageNow\(c, pat, pipeKey\)\{/.test(html) && /if\(pipeKey && p\.key!==pipeKey\) continue;/.test(html) && /if\(t\.status==="review"\) return "review";/.test(html)
    && /var ccOpen = !!\(cc && cc\.status !== "done"/.test(html) && /completeStageNow\(cc, \/수금확인\|입금확인\/\)/.test(html) && /qdf=\/견적\/\.test/.test(html)
    && /csStgSet\(c, p, i, !csStgIsOpen\(c, p, i\)\); renderContracts\(\);/.test(html) && /function csSnapInputs\(root\)/.test(html)   // v427 머리 줄·[접기] 버튼으로만 펼침/접힘 && /csRestoreInputs\(host, snap\); csRestoreInputs\(dcard, snap\);/.test(html)
    && /function csCanCloseCur\(c, p\)/.test(html) && /청구 단계를 건너뛰면 기성\(미수\) 등록이 생기지 않습니다/.test(html) && /if \(p\.stages\[i\]\.status === "skipped"\)\{ p\.stages\[i\]\.status = "pending";/.test(html)
    && /completeStageNow\(c, csExactRe\(s\.name\), p\.key\)/.test(html) && /\[\/면적\/,"석면조사"\]/.test(html), '');
} catch (e) { console.log('  (v382 검토 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v383: 서류 4종 패킷(생성 ✓ · 첨부 ◻ · 빈칸 ✗) ----
try {
  const sc = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const pks = [...sc.matchAll(/\{ k:"(con|start|complete|bill)", h:"[^"]+ 패킷"/g)].map((m) => m[1]);
  T('v383 CON_PACKETS 4(계약·착공·준공·청구) · gen 키는 TPL_LABELS 또는 가상 키(con_docs·quote·html_contract) · tpl_list 캐시(csLoadTpl) · 서류 탭에 csPacketsHtml + 첨부함 · [생성] 배선(html_contract → 계약서 툴, 그 외 openXlsxGen)',
    pks.join(',') === 'con,start,complete,bill'
    && [...sc.matchAll(/t:"gen", k:"(\w+)"/g)].map((m) => m[1]).every((k) => ['con_docs', 'quote', 'html_contract', 'safety_pack'].includes(k) || new RegExp('\\b' + k + ':"').test(html.slice(html.indexOf('var TPL_LABELS='), html.indexOf('var TPL_LABELS=') + 900)))
    && /gwCall\("gw-data", \{ action:"tpl_list" \}\)/.test(sc) && /h \+= csStagesHtml\(c\); h \+= cbxEtcHtml\(c\) \+ csMoreHtml\(c\) \+ conAttBoxHtml\(c\) \+ cdocTrashHtml\(c\);/.test(html) && /ev = csPkEval\(c, pk, it0, X\)/.test(html) && /querySelectorAll\("\[data-cs-gen\]"\)/.test(html) && /openDocFromContract\(p\[0\]\); else openXlsxGen\(p\[0\], csGenKind/.test(html)   // v427 패킷 항목은 단계·서류 줄로(같은 판정 csPkEval)
    && /\.cs-pk \.st\.gap\{/.test(html), pks.join(','));
  T('v383 검토 반영: tpl_list 실패는 캐시 null 유지 + csTplErr 쿨다운(30초) · 비200 불신 · then 2인자 · tpl_put 성공·관리 목록 수신 → csTplInvalidate/csTplSet · 모달 닫기 재그리기 · 첨부 claim 1회 + ex 제외 · 정규식 좁힘(사업자 제외 등록증·세금계산서·4대보험)',
    /if \(csTplErr && Date\.now\(\) - csTplErr < 30000\) return;/.test(sc) && /if \(!\(res && res\.status === 200 && res\.body && res\.body\.templates\)\)\{ csTplErr = Date\.now\(\);/.test(sc) && /\}, function\(\)\{ csTplLoading = false; csTplErr = Date\.now\(\); renderContracts\(\); \}\);/.test(sc)
    && /cbxDiscard\(it\); if \(csTplKeys\) csTplKeys\[key\] = 1;/.test(html) && /typeof csTplSet==="function"\) csTplSet\(t\);/.test(html) && /\$\("tplBackdrop"\)\.classList\.remove\("show"\); if\(typeof renderContracts==="function"\) renderContracts\(\); \}\);/.test(html)
    && /if \(!X\.claimed\[ai\] && it\.re\.test\(n\) && !\(it\.ex && it\.ex\.test\(n\)\)\)\{ X\.claimed\[ai\] = 1; hit\.push\(n\); \}/.test(sc) && /k:"reg", h:"건설업·폐기물 등록증", re:\/\(건설업\|해체\|폐기물\|수집운반\|운반업\)/.test(sc) && /k:"invoice", h:"세금계산서", re:\/세금계산서\//.test(sc) && /k:"ins", h:"4대보험 완납증명", re:\/4대보험/.test(sc) && !/re:\/보험\|완납\//.test(sc), '');
} catch (e) { console.log('  (v383 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v384: 결재 2종 배선 + 현장 대장 연결 (10/13 적대 검토 1·2차 반영) ----
try {
  const sc = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const gradeKeys = (gwd.match(/const APPR_GRADE_DEFAULTS = \{([\s\S]*?)\};/) || ['', ''])[1];
  T('v384 결재: CON_APPR_KINDS 2종 = 서버 등급표 키(계약 단계=/계약서/·청구 검수) · 상신 큐(ref con:) + 지시 review 잠금 · 적용 전 서버 계약본(csFetchServerContract, sha 불변) → csSyncFromServer 접목(앞섬 판정 없음) · cid 전용 매칭 · 60초 폴(미전송 2분·결정 20초 유예) · 결정 훅(토스트·즉시 저장 csSaveNow) · 4xx 폐기 → csApprDropped · loadTasks → csAlignTasksAll · advanceProc 잠금(미상신 포함, false) · completeStageNow locked · approveTask 푸시는 진행 뒤',
    /\[\/청구\|입금\/, "청구 검수"\], \[\/계약서\/, "계약 단계"\]/.test(sc) && /'계약 단계'/.test(gradeKeys) && /'청구 검수'/.test(gradeKeys)
    && /apprPendingCreates\.push\(\{ cid: cid, mid: myId\(\), kind: kind, title: \("\[계약\] "/.test(sc) && /t\.status = "review"; t\.done_at = todayStr\(\); t\.done_by = "결재함 상신\("/.test(sc)
    && /function csFetchServerContract\(id\)/.test(sc) && !/contractSha = json\.sha/.test(sc) && /function csSyncFromServer\(c, sc\)/.test(sc) && !/csAdoptIfAhead/.test(html) && /var localAhead = \(lq\.cur \|\| 0\) > \(q\.cur \|\| 0\), base = localAhead \? lq : q/.test(sc) && /if \(csEmpty\(m\.vals\) && !csEmpty\(o\.vals\)\) m\.vals = o\.vals;/.test(sc)
    && /if \(s\.appr\.cid\)\{ if \(x\.cid === s\.appr\.cid\) it = x; return; \}/.test(sc) && /c = findProc\(id\) \|\| c;   \/\/ 응답 대기 중/.test(sc) && /s\.appr\.status = "미전송"; changed = true;/.test(sc) && /Date\.now\(\) - \(Date\.parse\(it\.decided_at\) \|\| 0\) < 20000\) return;/.test(sc)
    && /function csSaveNow\(\)/.test(sc) && /c\.updated = todayStr\(\); csSaveNow\(\); renderContracts\(\);/.test(sc) && /apprToastShow\("계약을 이 기기에서 찾지 못했습니다/.test(sc) && /function csApprDropped\(ref, cid\)/.test(sc) && /typeof csApprDropped === "function"\)\{ try \{ csApprDropped\(p\.ref, p\.cid\); \}/.test(html)
    && /function csAlignTasksAll\(\)/.test(sc) && /if \(typeof csAlignTasksAll === "function"\)\{ try \{ csAlignTasksAll\(\); \}/.test(html)
    && /if\(c\.scen && csApprKindOf\(c, s\) && !\(s\.appr && s\.appr\.status==="승인"\)\)\{/.test(html) && /return adv===false \? "locked" : "done";/.test(html) && /var adv = advanceProc\(t\);   \/\/ v384 2차 F5/.test(html)
    && /indexOf\("con:"\) === 0\)\{   \/\/ v384/.test(html) && /indexOf\("con:"\) === 0 && typeof csApprOnDecided === "function"\)\{ try \{ csApprOnDecided\(it\); \}/.test(html) && /csApprSync\(c\); h \+= csStagesHtml\(c\);/.test(html) && /csApprSync\(c, true\); return; \}/.test(html) && /data-cs-done="' \+ esc\(c\.id\) \+ '\|' \+ esc\(key\) \+ '">' \+ esc\(ak\) \+ ' 상신</.test(html), '');
  T('v384 대장: csLinkSiteLater(미로드·로컬에 없는 대장 → 현장 열람 권한(site — v429) 있으면 loadAsb+큐) · csLinkSite(asbLoaded 가드·자기 con_id 행 재연결·삭제 대장 재연결·종결 대장 제외·공사명 또는 발주처+현장·none 해제·옛 계약은 연결만) · startProcess → csLinkSiteLater · csOnDone(scen, task_hook) · csSiteDone(scen, site_hook, 없음≠삭제) · loadAsb/loadContracts → csSiteHooksRetry · 연결 탭 안내 + [대장 연결] · 서버 변경 없음',
    /function csLinkSiteLater\(c\)/.test(sc) && /if \(!loaded \|\| \(c\.site_id && !findAsb\(c\.site_id\)\)\)\{/.test(sc) && /csSiteLinkQueue\[c\.id\] = 1; if \(typeof loadAsb === "function"\) loadAsb\(\); return "wait";/.test(sc)
    && /if \(typeof asbLoaded !== "undefined" && !asbLoaded\) return null;/.test(sc) && /var hit = liveSites\(\)\.filter\(function\(r\)\{ return r\.con_id === c\.id; \}\)\[0\] \|\| null;/.test(sc) && /\|\| r\.con_id \|\| r\.status === "done"\) return;/.test(sc) && /\(sameClient && st && \(rs === st \|\| rt === st\)\)\) hit = r;/.test(sc) && !/r\.start === c\.start/.test(sc)
    && /if \(c\.site_hook === "none"\) delete c\.site_hook;/.test(sc) && /if \(c\.scen && c\.status === "done"\) csSiteDone\(c\);/.test(sc)
    && /if\(opts\.scen\)\{ try \{ csLinkSiteLater\(c\); \} catch\(e\)\{\} \}/.test(html) && /if\(c\.status==="done"\) csOnDone\(c\);/.test(html) && /if \(c\.status === "done"\) csOnDone\(c\); \}/.test(html)
    && /function csOnDone\(c\)\{\s+if \(!c \|\| !c\.scen \|\| c\.status !== "done"\) return;/.test(sc) && /c\.task_hook = todayStr\(\);/.test(sc) && /if \(!c \|\| !c\.scen \|\| \(c\.site_hook && c\.site_hook !== "none"\) \|\| !c\.site_id/.test(sc) && /if \(!r\) return false;   \/\/ 로컬에 없음/.test(sc) && /c\.site_hook = todayStr\(\);/.test(sc) && !/done_hook/.test(html)
    // v432: loadAsb의 보류 훅 줄에 현황 읽기 예외(opt.noHooks)가 붙었다 — 그 밖의 부름(현장 칸·계약 쪽)은 종전대로 훅을 돌린다(실행 검사는 v432 묶음 ⑧)
    && /asbBase = doc\.updated_at\|\|0; asbLoaded = true;\s+if \(!\(opt && opt\.noHooks\) && typeof csSiteHooksRetry === "function"\)\{ try \{ csSiteHooksRetry\(\); \}/.test(html) && /asbLoaded && typeof csSiteHooksRetry === "function"\)\{ try \{ csSiteHooksRetry\(\); \}/.test(html) && /title = "실적신고\(2\/15\) — "/.test(sc)
    && /querySelectorAll\("\[data-cs-site\]"\)/.test(html) && /var r = csLinkSiteLater\(c\); alert\(typeof r === "object"/.test(html) && /현장 대장 열람 권한 필요/.test(html) && !/approval_apply|task_done_by_approval/.test(gwd), '');
} catch (e) { console.log('  (v384 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v385: 운반일지 엑셀 놓친 변경 안내(서버 why·changed_at) ----
try {
  T('v385 엑셀 안내: AB_XLSX_WHY 3종(collect·manual·route) · 확인창은 b.why·b.changed_at · 범위 60일 · 옛 "08:25 생성본에 반영" 문구 제거',
    /var AB_XLSX_WHY = \{ collect: "올바로 수집분 갱신", manual: "직접 추가 변경", route: "숨김·노선 변경" \};/.test(html) && /chg=b\.changed_at\? new Date\(b\.changed_at\)/.test(html) && /자동 재생성 범위\(최근 59일\)/.test(html) && /else if\(stt==="skipped"\)[\s\S]{0,200}else if\(stt==="requested"\|\|stt==="in_flight"\)[\s\S]{0,200}else if\(stt==="gave_up"\)/.test(html) && /made=\(b\.src_at\|\|b\.ts\)/.test(html) && !/다음 날 08:25 생성본에 반영됩니다/.test(html)
    && /stale: stale, why: why, changed_at: changedAt \|\| null, covered: covered/.test(readFileSync(join(ROOT, 'netlify', 'functions', 'gw-allbaro.js'), 'utf8')), '');
} catch (e) { console.log('  (v385 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v386(PM 10/14 "운영부까지 숨김·해제 다 열어"): 노선 숨김·해제·복구 = 관리자 + 운영부(abCanLearn) ----
try {
  const seg = (html.match(/function abSheetTableHtml\(rl, rows\)\{([\s\S]*?)\n  function abSortKey/) || ['', ''])[1];
  T('v386 숨김 권한: abRouteHide 가드 abCanLearn · 숨긴 노선 [복구] abCanLearn · 표의 [숨김]/[해제] admin = abCanLearn() · 비대상은 "(관리자·운영부가 해제)" · 403 FORBIDDEN은 숨김 전용 문구 · isAdmin 잔존 없음',
    /function abRouteHide\(side, row, hide\)\{[\s\S]{0,120}if \(!abCanLearn\(\)\)\{ alert\(AB_HIDE_FORBIDDEN\); return; \}/.test(html) && /\(abCanLearn\(\) \? ' <button type="button" class="mini-btn" data-ab-unhide=/.test(html)
    && /admin = abCanLearn\(\), emptyN = 0/.test(seg) && /\(관리자·운영부가 해제\)/.test(seg) && !/isAdmin\(\)/.test(seg) && /var AB_HIDE_FORBIDDEN = "노선 숨김·해제는 관리자와 운영부\(공무\)만 할 수 있습니다\.";/.test(html)
    && /res\.body\.code === "FORBIDDEN"\)\{ alert\(AB_HIDE_FORBIDDEN\); return; \}/.test(html) && !/노선 숨김은 관리자만 할 수 있습니다/.test(html), '');
} catch (e) { console.log('  (v386 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v387(PM 10/15): 주기별 업무 체크리스트 = 정본 JW-02-04-001 v3 (KOITA·위험성평가 인정·v2 미반영분) ----
try {
  const seg = html.slice(html.indexOf('var GROUPS = ['), html.indexOf('var TYPE_LABEL'));
  const sud = html.slice(html.indexOf('var SUDSI = ['), html.indexOf('// ---- 상태 ----'));
  const ids = [...seg.matchAll(/\{id:"([a-z0-9]+)"/g)].map((m) => m[1]);
  const need = ['w1', 'm1', 'm2', 'm3', 'm4', 'q1', 'q2', 'q3', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7', 'y8', 'y9', 'y10', 'y11', 'y12', 'y13', 'y14', 'y15', 'y16', 'y17', 'y18'];
  T('v387 체크리스트 정의: 항목 33개 id 순서 그대로(기존 id 보존 + h7·y11~y18) · 중복 없음 · 수시 su1~su6 · 퇴사자(김혁) 담당 없음 · KOITA 조사표 4월 30일·위험성평가 인정 사후점검·재인정 3개월 문구 · 정본 v3 주석',
    JSON.stringify(ids) === JSON.stringify(need) && new Set(ids).size === ids.length
    && ['su1', 'su2', 'su3', 'su4', 'su5', 'su6'].every((k) => sud.includes('{id:"' + k + '"')) && !/김혁/.test(seg)
    && /KOITA 연구개발활동조사표 제출 — 전년도분, 4월 30일까지/.test(seg) && /위험성평가 인정 사후점검 수검/.test(seg) && /재인정 신청 \(만료 3개월 전부터\)/.test(seg) && /30일 이내 KOITA 변경신고/.test(sud)
    && /JW-02-04-001 주기별 업무 체크리스트 v3/.test(html), JSON.stringify(ids));
} catch (e) { console.log('  (v387 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v388(PM 10/19 "33. ㄱ지금"): 문서함 직원 출력·권한 — 열람용 PDF·[보기·인쇄]·원본 권한(클라=서버 규칙)·열람 이력 ----
try {
  const cli = html.slice(html.indexOf('var DOC_ORIG_EXT ='), html.indexOf('var docAttBusy = false;'));
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v388 문서함 출력: 클라 DOC_ORIG_EXT 5형식 = 서버 · docOrigAllowed 4축(admin·관리부·03·orig_dl) · docViewFile · [보기·인쇄]/[원본]/"원본은 관리부·관리자"/"열람용 PDF 준비 중" · 모달 docOrigDl(관리자만) · 설정 열람 이력(doc_log_get) · 서버 ORIG_FORBIDDEN·doclog·doc_log_get · sw v388',
    /var DOC_ORIG_EXT = \{ docx:1, xlsx:1, pptx:1, hwp:1, hwpx:1 \}/.test(cli) && /const DOC_ORIG_EXT = \{ docx: 1, xlsx: 1, pptx: 1, hwp: 1, hwpx: 1 \}/.test(gwd)
    && /if \(m\.admin\) return true; if \(String\(m\.dept \|\| ""\) === "관리부"\) return true; if \(docMinorOf\(d\) === "03"\) return true; return d\.orig_dl === "all";/.test(cli)
    && /function docViewFile\(d\)/.test(html) && html.indexOf('>보기·인쇄</button>') > 0 && html.indexOf('"원본" : "열기"') > 0 && html.indexOf('원본은 관리부·관리자') > 0 && html.indexOf('열람용 PDF 준비 중') > 0
    && html.indexOf('id="docOrigDl"') > 0 && /odw\.style\.display = isAdmin\(\) \? "block" : "none"/.test(html) && /action: "doc_log_get"/.test(html) && html.indexOf('id="docLogCard"') > 0 && /function docLogRender\(month\)/.test(html)
    && /error_code: 'ORIG_FORBIDDEN'/.test(gwd) && /'doclog:' \+ month/.test(gwd) && /d\.action === 'doc_log_get'/.test(gwd) && /if \(s\.orig_dl !== 'all'\) delete s\.orig_dl;/.test(gwd) && /'scope', 'orig_dl'\]/.test(gwd)
    && /jw-shell-v(3(8[89]|9\d)|4\d\d)/.test(swv));   // v388 이후 판도 통과(sw 버전은 최신 블록이 정확히 본다)
} catch (e) { console.log('  (v388 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v389(PM 10/19 "니가 아니라 모델이 학습 — 초안↔직원 수정본 차이를 학습"): 블로그 자동 학습 루프 — 초안 보존·짝 블롭·학습 워커·규칙 창고 주입·관리자 카드. 모자이크 코드 불변 ----
try {
  const plsrc = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'promolearn.js'), 'utf8');
  const lw = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-learn-background.js'), 'utf8');
  const pai = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'promoai.js'), 'utf8');
  const papi = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-ai.js'), 'utf8');
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const mask = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-mask-background.js'), 'utf8');
  T('v389 자동 학습: 라이브러리(규칙 25·예시 1,500자·간극 편집거리·pickPending) · 워커(내부 토큰·LEAK_BLOCKED·NO_DRAFT·잠금 해제) · buildPrompt 주입 블록 2 · pl_get/pl_set(관리자) · 카드(promoLearnCard·renderPromoLearn·끄기·삭제·짝 지정·재시도) · switchTab promo 훅 · 모자이크 워커 facedet/platedet 호출 그대로 · sw v389',
    /MAX_RULES = 25/.test(plsrc) && /EXEMPLAR_CHARS = 1500/.test(plsrc) && /function levenshtein/.test(plsrc) && /function pickPending/.test(plsrc) && /function kickLearnWorker/.test(plsrc)
    && /v\.payload\.mid !== '__promoai__'/.test(lw) && /'LEAK_BLOCKED'/.test(lw) && /'NO_DRAFT'/.test(lw) && /PL\.LOCK_KEY, \{ ts: 0, pair: '' \}/.test(lw)
    && /\[직원이 고치는 패턴 — 자동 학습 /.test(pai) && /\[참고 완성본 — 직원이 다듬어 실제 게시한 글의 앞부분\]/.test(pai) && /inp\.lessons/.test(pai) && /inp\.exemplar/.test(pai)
    && /case 'pl_get'/.test(papi) && /case 'pl_set'/.test(papi) && /ADMIN_ONLY/.test(papi) && /op: '블로그학습'/.test(papi)
    && html.indexOf('id="promoLearnCard"') > 0 && /function renderPromoLearn\(\)/.test(html) && /action: "pl_get"/.test(html) && /action: "pl_set"/.test(html) && /data-pl-off/.test(html) && /data-pl-del/.test(html) && /data-pl-assign/.test(html) && /data-pl-retry/.test(html)
    && /if \(name === "promo"\)\{ renderPromo\(\); loadPromo\(\); renderPromoLearn\(\); promoLoadLayoutProf\(\); \}/.test(html)
    && /detectFaces|facedet/.test(mask) && /detectPlates|platedet/.test(mask)
    && /jw-shell-v(39[4-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v389 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v392(PM 10/20 "자동으로 학습해서 반영되게 · 줄간격·정렬도 포함"): D1 포장 측정 프로필 — 수집기 promoai:layout → pl_get layout → 카드 "포장 측정"(승인 버튼 없음) ----
try {
  const plsrc = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'promolearn.js'), 'utf8');
  const papi = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-ai.js'), 'utf8');
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v392 포장 측정 프로필: LAYOUT_KEY promoai:layout · pl_get layout(profile·posts 12, 없으면 null) · 카드 "포장 측정 — 실제 게시글" 가운데/한 줄/간격/구분선/굵게/해시태그 + 편별 표 · 승인 버튼 없음 · sw v392',
    /LAYOUT_KEY = 'promoai:layout'/.test(plsrc) && /LAYOUT_KEY,/.test(plsrc) && /blobGet\(st, PL\.LAYOUT_KEY\)/.test(papi) && /layout: layout, request_id: R/.test(papi) && /\.slice\(0, 12\)/.test(papi)
    && html.indexOf('포장 측정 — 실제 게시글') > 0 && /pf\.center_ratio/.test(html) && /pf\.len_med/.test(html) && /pf\.gap_default/.test(html) && /pf\.hr_per_post/.test(html) && /pf\.bold_ratio/.test(html) && /pf\.tags_med/.test(html) && /lay\.posts\.map/.test(html)
    && html.indexOf('data-pl-approve') < 0 && /jw-shell-v(39[4-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v392 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v393: 포장 프로필 2판 — 모듈 순서(사진 i·구분선 h)·서명 유지·인사말 줄별 굵게·소제목 굵게/앞 구분선/앞 빈 줄·자주 쓰는 해시태그 → 카드 표시 ----
try {
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v393 포장 프로필 2판 카드: 서명 유지·인사말 굵게·소제목 굵게/앞 구분선/앞 빈 줄·사진 뒤 구분선·자주 쓰는 해시태그 · sw v393',
    /pf\.sig_kept_ratio/.test(html) && /pf\.greet_bold/.test(html) && /pf\.head_bold_ratio/.test(html) && /pf\.head_hr_ratio/.test(html) && /pf\.head_blank_ratio/.test(html) && /pf\.hr_after_img_ratio/.test(html) && /pf\.tags_top/.test(html) && /jw-shell-v(39[4-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v393 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v394(D3): 복사 출력에 포장 프로필 자동 적용(서명 삭제·인사말/소제목 굵게·소제목 앞 구분선·문단 경계 빈 줄) · pl_layout(홍보 권한) · copy_save → 워커 포장 간극 → 카드 ----
try {
  const plsrc = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'promolearn.js'), 'utf8');
  const papi = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-ai.js'), 'utf8');
  const lw = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-learn-background.js'), 'utf8');
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v394 복사 출력 자동 포장: @promo-post 구간 · promoLayoutProf · promoBuildPostHtml(prof) 5가지(sig_kept·greet_bold·head_bold·head_hr·blank_per_para) · pushHr · promoPlanOfHtml · pl_layout/copy_save 호출 · 홍보 탭 훅 promoLoadLayoutProf · 서버 pl_layout(NO_PERMISSION)·copy_save(600줄·c/b/i/h) · 워커 layoutGap · 카드 포장 % · sw v394',
    /\/\/ @promo-post-start/.test(html) && /\/\/ @promo-post-end/.test(html) && /var promoLayoutProf=null;/.test(html) && /function promoBuildPostHtml\(title, body, imgs, tags, prof\)/.test(html)
    && /P\.sig_kept_ratio\|\|0\)<0\.3/.test(html) && /gbold\[l\]\|\|0\)>=0\.5/.test(html) && /P\.head_bold_ratio\|\|0\)>=0\.5/.test(html) && /P\.head_hr_ratio\|\|0\)>=0\.5/.test(html) && /P\.blank_per_para\|\|0\)>=0\.15/.test(html)
    && /function pushHr\(\)/.test(html) && /function promoPlanOfHtml\(html\)/.test(html) && /action:"pl_layout"/.test(html) && /action:"copy_save"/.test(html) && /promoLoadLayoutProf\(\); \}/.test(html) && /p\.gap\.layout\.line_match/.test(html)
    && /case 'pl_layout'/.test(papi) && /case 'copy_save'/.test(papi) && /COPY_MAX_LINES = 600/.test(papi) && /replace\(\/\[\^cbih\]\/g, ''\)/.test(papi) && /code: 'NO_PERMISSION'/.test(papi)
    && /function layoutGap\(copyLines, finalLines\)/.test(plsrc) && /COPY_PREFIX = 'promoai:copy:'/.test(plsrc) && /PL\.layoutGap\(cp\.data\.lines, pair\.final_layout\)/.test(lw) && /jw-shell-v(39[4-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v394 검사 생략 — ' + e.message + ')'); fails++; }


// ---- v395(10/27 착수 브리핑 A2 · 공통 기반 1 첫 시범): 자동 지시 배정표 settings:assign — 접두어 앱↔서버 동률 · 카드·호출·배지·액션 배선 · sw ----
try {
  const svrSeg = (gwd.match(/const ASSIGN_PREFIXES = \{([\s\S]*?)\};/) || ['', ''])[1];
  const svrP = new Set([...svrSeg.matchAll(/'([a-z]+:)'\s*:/g)].map((m) => m[1]));
  const appSeg = (html.match(/var ASSIGN_PREFIX_ORDER = \[([^\]]+)\]/) || ['', ''])[1];
  const appP = new Set([...appSeg.matchAll(/"([a-z]+:)"/g)].map((m) => m[1]));
  const appTxt = (html.match(/var ASSIGN_PREFIX_TXT = \{([^}]+)\}/) || ['', ''])[1];
  const onlyS = [...svrP].filter((k) => !appP.has(k)), onlyA = [...appP].filter((k) => !svrP.has(k));
  T('v395 배정표 접두어 앱↔서버 일치(' + svrP.size + '종 — v417 site:·wk: 포함 7) · 라벨 표에도 전부', svrP.size === 7 && !onlyS.length && !onlyA.length && [...appP].every((k) => appTxt.indexOf('"' + k + '"') >= 0), '서버만: ' + onlyS.join(',') + ' / 앱만: ' + onlyA.join(','));
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v395 배선: 카드 id·렌더·호출·assign_get/set/revert 액션·담당 없음 배지·서버 핸들러 3·ingest/save 채움·sw',
    html.indexOf('id="assignCard"') > 0 && /function renderAssignCard\(\)/.test(html) && /renderApprGrades\(\);[^\n]*\n\s*renderAssignCard\(\);/.test(html)
    && /action: "assign_get"/.test(html) && /"assign_set"/.test(html) && /"assign_revert"/.test(html) && /담당 없음<\/span>/.test(html) && /t\.auto_key && !t\.who_id && !t\.who/.test(html)
    && /async function handleAssignGet/.test(gwd) && /async function handleAssignSet/.test(gwd) && /async function handleAssignRevert/.test(gwd)
    && /action === 'assign_get'/.test(gwd) && /action === 'assign_set'/.test(gwd) && /action === 'assign_revert'/.test(gwd)
    && /function assignFill\(items, rules, names\)/.test(gwd) && (gwd.match(/assignFill\(doc\.items/g) || []).length === 2 && /who_by === 'assign'/.test(gwd)
    && /'MEMBERS_UNAVAILABLE'/.test(gwd) && /'BAD_PREFIX'/.test(gwd) && /'BAD_MEMBER'/.test(gwd) && /'ASSIGN_STALE'/.test(gwd) && /'NO_PREV'/.test(gwd)
    && /jw-shell-v(39[5-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v395 검사 생략 — ' + e.message + ')'); fails++; }


// ---- v396(10/27 착수 브리핑 A3 · 공통 기반 3 첫 시범): 지시 알림 설정 settings:notify — 이벤트 키 앱↔서버 동률 · 카드·호출·액션·push_send 정책·크론 요약 · sw ----
try {
  const svrSeg = (gwd.match(/const NOTIFY_EVENTS = \{([\s\S]*?)\n\};/) || ['', ''])[1];
  const svrK = new Set([...svrSeg.matchAll(/^\s*([a-z_]+):\s*\{\s*label/gm)].map((m) => m[1]));
  const appSeg = (html.match(/var NOTIFY_EVENT_ORDER = \[([^\]]+)\]/) || ['', ''])[1];
  const appK = new Set([...appSeg.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const onlyS = [...svrK].filter((k) => !appK.has(k)), onlyA = [...appK].filter((k) => !svrK.has(k));
  T('v396 알림 이벤트 키 앱↔서버 일치(' + svrK.size + '종)', svrK.size >= 3 && !onlyS.length && !onlyA.length, '서버만: ' + onlyS.join(',') + ' / 앱만: ' + onlyA.join(','));
  const todo = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-todo-cron.js'), 'utf8');
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v396 배선: 카드 id·렌더·호출·notify_get/set/revert·서버 핸들러 3·push_send 정책(삼킴·승인권자)·save/ingest notifyAutoCreated·크론 요약·sw',
    html.indexOf('id="notifyCard"') > 0 && /function renderNotifyCard\(\)/.test(html) && /renderAssignCard\(\);[^\n]*\n\s*renderNotifyCard\(\);/.test(html)
    && /action: "notify_get"/.test(html) && /"notify_set"/.test(html) && /"notify_revert"/.test(html)
    && /async function handleNotifyGet/.test(gwd) && /async function handleNotifySet/.test(gwd) && /async function handleNotifyRevert/.test(gwd)
    && /action === 'notify_get'/.test(gwd) && /action === 'notify_set'/.test(gwd) && /action === 'notify_revert'/.test(gwd)
    && /suppressed: 'task_auto_create'/.test(gwd) && /task_review === 'issuer_approver'/.test(gwd) && (gwd.match(/await notifyAutoCreated\(/g) || []).length === 2
    && /due_digest === 'summary'/.test(todo) && /task-digest-/.test(todo)
    && /jw-shell-v(39[6-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v396 검사 생략 — ' + e.message + ')'); fails++; }


// ---- A4(10/27 착수 브리핑 · 공통 기반 14): 크론 지도 대조 — netlify.toml의 예약 함수가 전부 ../jongwoon-appdata/data/cron_map.json에 where=netlify·expr 동일로 등재. 지도 파일 없으면 생략 ----
try {
  const cmPath = join(ROOT, '..', 'jongwoon-appdata', 'data', 'cron_map.json');
  if (existsSync(cmPath)) {
    const cm = JSON.parse(readFileSync(cmPath, 'utf8')); const byId = {}; (cm.crons || []).forEach((c) => { byId[c.id] = c; });
    const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
    const decl = [...toml.matchAll(/\[functions\."([^"]+)"\]\s*\r?\n\s*schedule\s*=\s*"([^"]+)"/g)].map((m) => ({ fn: m[1], cron: m[2] }));
    const bad = decl.filter((d) => !byId[d.fn] || byId[d.fn].where !== 'netlify' || !byId[d.fn].schedule || byId[d.fn].schedule.expr !== d.cron);
    T('A4 크론 지도: netlify 예약 함수 ' + decl.length + '개 전부 등재·표현식 일치', decl.length >= 5 && bad.length === 0, '불일치: ' + bad.map((d) => d.fn + '=' + d.cron).join(','));
  } else console.log('  (A4 크론 지도 대조 생략 — appdata 클론 없음)');
} catch (e) { console.log('  (A4 크론 지도 대조 생략 — ' + e.message + ')'); }


// ---- v397(10/27 착수 브리핑 A5 · 공통 기반 2 첫 시범): 공통 done_if 워커 — 라이브러리·크론·toml 등재·설정 액션·save 보호·일괄 승인·반려 신호 끔·카드 행·sw ----
try {
  const dl = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'doneif.js'), 'utf8');
  const dc = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-doneif-cron.js'), 'utf8');
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v397 done_if 배선: 라이브러리(parseKey·signalFor 3신호·eligible·plan·apply·clogAppend 해시 체인) · 크론(dry-run on=false·스냅샷·clog·감사 앱기준전환·승인권자 1발) · toml */10 · doneif_get/set · save 보호 · [오늘 승인 일괄] · 반려 doneif_off · 카드 행 · sw',
    /function parseKey/.test(dl) && /function signalFor/.test(dl) && /insp_due/.test(dl) && /expiry/.test(dl) && /rec\.paid/.test(dl) && /function eligible/.test(dl) && /doneif_off/.test(dl) && /function clogAppend/.test(dl) && /createHash\('sha256'\)/.test(dl)
    && /D\.DONEIF_KEY/.test(dc) && /sr\.data\.on === true/.test(dc) && /ver:tasks:appbase:/.test(dc) && /clog:appr:/.test(dc) && /op: '앱기준전환'/.test(dc) && /task-appbase-/.test(dc) && /it:doneif:last|DONEIF_LAST/.test(dc)
    && /\[functions\."gw-doneif-cron"\]\s*\r?\n\s*schedule = "\*\/10 \* \* \* \*"/.test(toml)
    && /action === 'doneif_get'/.test(gwd) && /action === 'doneif_set'/.test(gwd) && /o\.done_by === '앱 기준' && t\.status === 'open' && !t\.doneif_off/.test(gwd)
    && html.indexOf('id="taskBulkApprove"') > 0 && /t\.done_by === "앱 기준" && canApproveTask\(t\)/.test(html) && /if \(t\.done_by === "앱 기준"\) t\.doneif_off = 1;/.test(html) && /function renderDoneifRow\(\)/.test(html) && /action: "doneif_get"/.test(html) && /action: "doneif_set"/.test(html)
    && /jw-shell-v(39[7-9]|4\d\d)/.test(swv));
} catch (e) { console.log('  (v397 검사 생략 — ' + e.message + ')'); fails++; }


// ---- v398(10/27 A7 1일차 · 공통 기반 14): 크론 흔적 스탬프 — 4 예약 함수 시작 스탬프 + todo/appr/doneif 끝 스탬프 · cron_map evidence stamp · sw ----
try {
  const fns = ['gw-todo-cron', 'gw-appr-cron', 'gw-doneif-cron', 'gw-promo-ai-cron'];
  const srcs = {}; fns.forEach((f) => { srcs[f] = readFileSync(join(ROOT, 'netlify', 'functions', f + '.js'), 'utf8'); });
  const lib = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'cronstamp.js'), 'utf8');
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const okStart = fns.every((f) => new RegExp("await stamp\\('" + f + "', \\{ state: 'start' \\}\\)").test(srcs[f]) && /require\('\.\/_lib\/cronstamp'\)/.test(srcs[f]));
  const okEnd = ['gw-todo-cron', 'gw-appr-cron', 'gw-doneif-cron'].every((f) => new RegExp("await stamp\\('" + f + "', \\{ state: 'end'").test(srcs[f]));
  let okMap = true;
  const cmPath = join(ROOT, '..', 'jongwoon-appdata', 'data', 'cron_map.json');
  if (existsSync(cmPath)) { const cm = JSON.parse(readFileSync(cmPath, 'utf8')); okMap = fns.every((f) => (cm.crons || []).some((c) => c.id === f && c.evidence && c.evidence.type === 'stamp' && c.evidence.key === 'it:cron:' + f + ':last' && c.watch === true)); }
  T('v398 크론 흔적: cronstamp.js(it:cron:<fn>:last, 저장 실패 삼킴) · 4 함수 시작 스탬프 · 3 함수 끝 스탬프 · cron_map stamp 편입 · sw',
    /it:cron:/.test(lib) && /catch \(e\) \{ \/\* no-op \*\/ \}/.test(lib) && okStart && okEnd && okMap && /jw-shell-v(39[8-9]|4\d\d)/.test(swv), 'start ' + okStart + ' end ' + okEnd + ' map ' + okMap);
} catch (e) { console.log('  (v398 검사 생략 — ' + e.message + ')'); fails++; }


// ---- v399(10/27 A7 2일차 · 공통 기반 14): 감시 경보 라벨 — 카드·액션·서버 핸들러·감시 id 목록 = cron_map watch=true · sw ----
try {
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const appIds = new Set([...((html.match(/var ALERT_WATCH_IDS = \[([^\]]+)\]/) || ['', ''])[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  let okMap = true, mapTxt = '';
  const cmPath = join(ROOT, '..', 'jongwoon-appdata', 'data', 'cron_map.json');
  if (existsSync(cmPath)) { const cm = JSON.parse(readFileSync(cmPath, 'utf8')); const w = (cm.crons || []).filter((c) => c.watch === true).map((c) => c.id); okMap = w.length === appIds.size && w.every((id) => appIds.has(id)); mapTxt = '지도 ' + w.join(',') + ' / 앱 ' + [...appIds].join(','); }
  T('v399 경보 라벨: 카드 id·렌더·호출·alerts_get/set·서버 핸들러(level warn|alert|mute, mute until 7일, 감사 경보라벨)·감시 id 목록 = cron_map watch · sw',
    html.indexOf('id="alertsCard"') > 0 && /function renderAlertsCard\(\)/.test(html) && /renderNotifyCard\(\);[^\n]*\n\s*renderAlertsCard\(\);/.test(html) && /action: "alerts_get"/.test(html) && /action: "alerts_set"/.test(html)
    && /async function handleAlertsGet/.test(gwd) && /async function handleAlertsSet/.test(gwd) && /action === 'alerts_get'/.test(gwd) && /action === 'alerts_set'/.test(gwd) && /const ALERT_LEVELS = \{ warn: 1, alert: 1, mute: 1 \}/.test(gwd) && /op: '경보라벨'/.test(gwd)
    && appIds.size >= 6 && okMap && /jw-shell-v(399|4\d\d)/.test(swv), mapTxt);
} catch (e) { console.log('  (v399 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v400(10/28 계약 D1 2일차): 계약 골조·목록 거울 — 로더(제자리 덮어쓰기·검증·폴백)·afterLogin 호출·관리자 카드·서버 액션 2종·dredge 접두형·appdata 거울 파일 2층·신설 제안 전부 비활성 · sw ----
try {
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const adir = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract');
  let okAdd = false, okBlob = false, addTxt = '';
  const addPath = join(adir, 'proc_added_v1.json');
  if (existsSync(addPath)) { const ad = JSON.parse(readFileSync(addPath, 'utf8')); const all = [...(ad.stages || []), ...(ad.lists || [])]; okAdd = ad.schema === 2 && all.length >= 6 && (ad.status === 'pending' ? all.every((s) => s.active === false) : (ad.status === 'applied' && !!ad.applied && typeof ad.applied.at === 'string')); /* v402 완화: 11/4 데이터 전환(applied) 뒤에도 푸시가 막히지 않게 */ addTxt = 'added ' + all.length + '건 비활성 ' + okAdd; }
  const bp = join(adir, 'blob_proc_contract_v1.json'), bl = join(adir, 'blob_list_contract.json');
  if (existsSync(bp) && existsSync(bl)) { const p = JSON.parse(readFileSync(bp, 'utf8')), l = JSON.parse(readFileSync(bl, 'utf8')); okBlob = p.layer === 'proc' && l.layer === 'list' && p.proc_ver === 'v1' && l.proc_ver === 'v1' && Object.keys(p.consts).length === 4 && Object.keys(l.consts).length === 3 && p.consts.CON_SITE_CORP.dredge === '주식회사 종운환경' && Object.keys(p.consts.CON_SCEN).length === 10; addTxt += ' · 거울 2층 ' + okBlob; }
  T('v400 계약 거울: 로더 4함수·afterLogin 호출·카드 id·렌더·액션 2종·서버 핸들러 2종(CON_PROC_KEYS·MIRROR_MISSING·CON_PROC_STALE·감사 계약골조)·dredge 접두형·옛 표기 0·appdata added 비활성·거울 파일 2층·sw',
    /function conProcLoad\(\)/.test(html) && /function conProcApplyInPlace\(/.test(html) && /function conProcValid\(/.test(html) && /function conProcRevive\(/.test(html) && /loadMembers\(\);[^\n]*\n\s*conProcLoad\(\);/.test(html)
    && html.indexOf('id="conProcCard"') > 0 && /function renderConProcCard\(\)/.test(html) && /renderAlertsCard\(\);[^\n]*\n\s*renderConProcCard\(\);/.test(html) && /action: "con_proc_get"/.test(html) && /action: "con_proc_flag_set"/.test(html)
    && /dredge:"주식회사 종운환경"/.test(html) && html.indexOf('종운환경 주식회사') < 0 && /var elems=conModalElems\(type, false\);/.test(html) && html.indexOf('{asb:1,labor:1,wst:1}:{dredge:1}') < 0
    && /async function handleConProcGet/.test(gwd) && /async function handleConProcFlagSet/.test(gwd) && /action === 'con_proc_get'/.test(gwd) && /action === 'con_proc_flag_set'/.test(gwd) && /const CON_PROC_KEYS = \{ proc: 'proc:contract:v1', list: 'list:contract', flag: 'settings:contract'/.test(gwd) && /MIRROR_MISSING/.test(gwd) && /CON_PROC_STALE/.test(gwd) && /op: '계약골조'/.test(gwd)
    && okAdd && okBlob && /jw-shell-v(400|4\d\d)/.test(swv), addTxt);
} catch (e) { console.log('  (v400 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v401(10/29 계약 D1 3일차): 골조·목록 편집 clog:contract(관리자 카드 편집 4절·서버 con_proc_edit op 6종·재생 유효 층) · 건별 서류 체크리스트 stage.docs[](☑·해당없음·추가, con_clog_add 월 키) · STAGE_DOCS 2줄 표기 정정(·→/) · sw ----
try {
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const seg401 = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const sheet401 = html.slice(html.indexOf('// @con-sheet-start'), html.indexOf('  function renderContracts(){'));
  T('v401 서류 항목화: csSplitTop·csParseStageDocs·csStageDocItems(@con-scen) · 단계 카드 csStageDocsHtml 호출 · 체크리스트 6함수 · 배선 4(dchk/dna/ddel/dadd) · 입력 보존(dpanel/dnew) · CSS .cs-docs/.cs-doc · con_clog_add 호출 · STAGE_DOCS 완료신고·청구 "/" 표기',
    /function csSplitTop\(/.test(seg401) && /function csParseStageDocs\(/.test(seg401) && /function csStageDocItems\(/.test(seg401)
    && /h \+= csStageDocsHtml\(c, p, i, key, can, fm\);/.test(sheet401) && ['csStageDocsHtml', 'csDocsOf', 'csDocFind', 'csDocLog', 'csDocToggle', 'csDocNa', 'csDocAdd', 'csDocDel'].every((f) => sheet401.indexOf('function ' + f + '(') >= 0)
    && ['data-cs-dchk', 'data-cs-dna', 'data-cs-ddel', 'data-cs-dadd'].every((a) => html.indexOf('csAct("' + a + '"') >= 0) && sheet401.indexOf('[data-cs-fld], [data-cs-wl], [data-cs-dnew]') >= 0 && sheet401.indexOf('e.getAttribute("data-cs-dpanel")') >= 0
    && /\.cs-docs\{/.test(html) && /\.cs-doc\.na \.nm\{/.test(html) && /action: "con_clog_add"/.test(sheet401)
    && seg401.indexOf('"완료신고":"[작성] 석면해체/제거 완료신고(노동부)"') >= 0 && seg401.indexOf('[수령] 국세/지방세 납세증명·4대보험 완납증명·하도급지킴이') >= 0 && html.indexOf('석면해체·제거 완료신고') < 0, '');
  T('v401 관리자 편집 카드: conProcEditHtml 4절(docs/scen/map/log) · 배선 conProcBindEdit(dedit/dsave/ddel/dadd/sdel/mdel/madd/revert) · conProcEdit(head 낙관락·STALE 안내) · 거울 꺼짐 안내 · 로더 edits 표식',
    /function conProcEditHtml\(b\)/.test(html) && ['docs', 'scen', 'map', 'log'].every((id) => html.indexOf('det("' + id + '"') >= 0) && /function conProcBindEdit\(host, b\)/.test(html)
    && ['data-conproc-dedit', 'data-conproc-dsave', 'data-conproc-ddel', 'data-conproc-dadd', 'data-conproc-sdel', 'data-conproc-mdel', 'data-conproc-madd', 'data-conproc-revert'].every((a) => html.indexOf('all("[' + a + ']"') >= 0)
    && /function conProcEdit\(body, msg, then\)/.test(html) && /body\.action = "con_proc_edit"; body\.head = conProcHead;/.test(html) && html.indexOf('ec === "CON_PROC_STALE"') >= 0 && html.indexOf('거울이 꺼져 있어 편집은 쌓이기만') >= 0 && /CON_PROC_SRC\.edits = Number\(b\.proc\.edits \|\| 0\)/.test(html), '');
  T('v401 서버: CON_CLOG_KEY/OPS 6종/STAGE_ACTS 5종 · conClogHash·conClogChainOk·conProcReplay·conProcEffOk · handleConProcGet 유효 층+clog+edit_state · handleConProcEdit(BAD_OP·MIRROR_MISSING·CON_PROC_STALE·CLOG_FULL·WOULD_BREAK·BAD_RE·감사 계약골조편집) · handleConClogAdd(permOf contracts do·월 키) · 디스패치 2 · sw',
    /const CON_CLOG_KEY = 'clog:contract';/.test(gwd) && /const CON_CLOG_OPS = \{ docs_set: 1, docs_del: 1, map_add: 1, map_del: 1, scen_del: 1, revert: 1 \}/.test(gwd) && /const CON_STAGE_ACTS = \{ done: 1, undo: 1, na: 1, add: 1, del: 1 \}/.test(gwd)
    && ['conClogHash', 'conClogChainOk', 'conProcReplay', 'conProcEffOk', 'conClogMonthKey'].every((f) => gwd.indexOf('function ' + f + '(') >= 0) && /async function conClogRead\(st, key\)/.test(gwd)
    && /async function handleConProcGet/.test(gwd) && /edit_state: state/.test(gwd) && /async function handleConProcEdit/.test(gwd) && ['BAD_OP', 'CLOG_FULL', 'WOULD_BREAK', 'BAD_RE'].every((c) => gwd.indexOf("'" + c + "'") >= 0) && /op: '계약골조편집'/.test(gwd)
    && /async function handleConClogAdd/.test(gwd) && /permOf\(c\.member, 'contracts'\) !== 'do'\) return jr\(403, \{ status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R \}\);\s*\n\s*const cid/.test(gwd)
    && /action === 'con_proc_edit'/.test(gwd) && /action === 'con_clog_add'/.test(gwd) && (gwd.match(/async function handleConProcGet/g) || []).length === 1 && Number((swv.match(/jw-shell-v(\d+)/) || ['', '0'])[1]) >= 401, '');   // v402: sw 숫자 비교
} catch (e) { console.log('  (v401 검사 생략 — ' + e.message + ')'); fails++; }


// ---- v402(10/30 계약 D1 4일차): 카드 9 신설 엔진(added, 스위치 끈 채) — 엔진 함수·훅 · 호출처(지시 상세·결재 판정·계약 단계 main 고정·로더·태그) · 시트(chg 줄·버튼·[켜기]·서류 버튼 숨김) · 관리자 카드(미리보기 격리·카드 9 행·예시) · appdata 원천·거울 빌드 일치 · sw ----
try {
  const swv = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const sc402 = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const sh402 = html.slice(html.indexOf('// @con-sheet-start'), html.indexOf('  function renderContracts(){'));
  const fns = ['conScenRk', 'conIsArr', 'conAddedRe', 'conRouteKey', 'conAddedAt', 'conChgWindow', 'conAddedPrep', 'conAddedApply', 'conAddedClear', 'conAddedUse', 'conAddedHasChg', 'conScenTag', 'conModalExtra', 'conAddedPreviewHtml', 'stageDocsOf', 'csStageFieldsOf', 'csStageLabel', 'csStageNew', 'csStageTag', 'csNum', 'csChgLastAmt', 'csChgAmtChanged', 'csApprKindOf', 'conChgItemOf', 'csChgCan', 'csChgOpenAt', 'csChgRank', 'csChgMerge', 'csChgBase', 'csTaskChg'];
  const missFn = fns.filter((f) => sc402.indexOf('function ' + f + '(') < 0);
  T('v402 엔진: CON_ADDED 기본 빈 값 리터럴 · 신설 함수 ' + fns.length + '종 @con-scen · conScenStages 훅(적격 unshift 유지) · csSyncFromServer chg 병합 분기 · R5 두 층 status',
    /var CON_ADDED = \{ stages: \[\], lists: \[\], bad: \[\], src: "", keys: \[\] \};/.test(sc402) && missFn.length === 0 && /if \(extra && extra\.qual\) out\.unshift\(\{ name:"적격심사", opt:0 \}\);\r?\n    if \(CON_ADDED\.stages\.length \|\| CON_ADDED\.lists\.length\) out = conAddedApply\(out, conScenRk\(type, pub, combo\), type, combo, extra \|\| \{\}, CON_ADDED\);/.test(sc402)
    && /if \(q\.key === "chg"\)\{ var mr = csChgMerge\(c, lq, q\); if \(mr\)\{ changed = true; if \(mr === 2\) chgPush = true; \} return; \}/.test(sc402) && /if \(chgPush\)\{ c\.updated = todayStr\(\); scheduleContractSave\(\); \}/.test(sc402) && /status: \(pa\.status === la\.status\) \? pa\.status : "mismatch"/.test(html) && /if \(raw\.status !== "applied"\)/.test(sc402), missFn.join(','));
  const ci = html.indexOf('function conProcLoad()'), cThen = html.indexOf('.then(function(res){', ci);
  T('v402 호출처: 지시 상세 stageDocsOf · csApprKind(s.name) 1회(csApprKindOf 안) · 계약 단계 완료 main 고정 2곳 · 로더 then 첫 문장 conAddedClear · conAddedUse 호출 1회(거울 적용 뒤) · 새 계약 2곳 conScenTag · 모달 적격 수동 체크·리스너·리셋',
    /detail:\(stageDocsOf\(s\)\|\|""\)/.test(html) && (html.match(/csApprKind\(s\.name\)/g) || []).length === 1 && (html.match(/completeStageNow\(cc?, \/계약\/, "main"\)/g) || []).length === 2 && !/completeStageNow\(cc?, \/계약\/\)/.test(html)
    && /^\s*conAddedClear\(\); CON_PROC_SRC\.added_applied = 0;/.test(html.slice(cThen + 20, cThen + 120)) && (html.match(/conAddedUse\(/g) || []).length - (html.match(/function conAddedUse\(/g) || []).length === 1 && html.indexOf('conAddedUse(ad, ') > html.indexOf('conProcApplyInPlace(CON_PACKETS')
    && /scen:conScenTag\(\{type:type, pub:pub, combo:combo, ver:1\}, stages\)/.test(html) && /scen:conScenTag\(\{type:type, pub:true, combo:false, ver:1\}, qst\)/.test(html) && ids.has('conQualWrap') && ids.has('conQualMan') && /getElementById\("conQualMan"\)\.addEventListener\("change", renderConScen\)/.test(html) && /var qm0=document\.getElementById\("conQualMan"\); if\(qm0\) qm0\.checked=false;/.test(html), '');
  T('v402 시트: csChgAdd(@con-sheet)·버튼 배선 data-cs-chgadd · pipeLabel chg · csUnskipStage delete s.off · [켜기] 라벨 · R1 csDocsLost(굳히지 않음) · R3 본 줄 잠금(advanceProc·csDoneStage) · R4 변경계약 서류 버튼 숨김(단계 카드·지시 탭) · R15 완료 전 입력 칸 저장',
    sh402.indexOf('function csChgAdd(') >= 0 && html.indexOf('querySelectorAll("[data-cs-chgadd]")') >= 0 && /k==="chg" \? "변경계약" : "본"/.test(html) && /s\.status = "pending"; s\.done_at = null; delete s\.off;/.test(sh402) && sh402.indexOf("(s.off ? '켜기' : '선택 복구')") >= 0
    && sh402.indexOf("var cls = (isSkip ? ' skip' : (isDone ? ' done' : (isCur ? ' cur' : ''))) + (opt ? ' opt' : '') + (open ? ' open' : '');") >= 0 && /function csDocsLost\(s\)/.test(sh402) && /if \(csDocsLost\(s\)\)\{ alert\(/.test(sh402) && /var chgN = c\.scen \? csChgOpenAt\(c, pipe, t\.stage_i\) : 0;/.test(html) && /var chgN = csChgOpenAt\(c, p, i\); if \(chgN\)\{ alert\(/.test(sh402)
    && sh402.indexOf('if (s.aid !== "change_contract" && p.key !== "chg"){ if (!csStgGenCovered(c, s, rows)) act += \'<button type="button" class="vs-chip" data-cs-sdoc=') >= 0 && html.indexOf('var docBtn = (t.proc_id && canDo("con") && t.pipe !== "chg" && !csTaskChg(t)) ?') >= 0 && /fp = \(s0 && s0\.aw === "amt"\) \? root\.querySelector/.test(html)
    && ['var chgA = csChgOpenAt(c, p, i); if (chgA)', 'if(s.aid==="change_contract" && pat.source==="계약") continue;', 'var chgJ = csChgOpenAt(c, p, i); if (chgJ)', 'if (s.aw === "amt" && (csNum((s.vals || {}).chg_amt) || (s.vals || {}).chg_end || s.appr))', 'hold = !!(cs && cs.appr && /대기|보류|승인/.test(cs.appr.status || "")', 'if (!tl || tl.status === "done"){ csApprApply(c, p, i);'].every((x) => html.indexOf(x) >= 0), '');   // v402 적대 검토 반영 리터럴
  T('v402 관리자 카드: 미리보기 try/catch 격리(R6) · 카드 9 목록 읽기 전용 행·같은 키 docs_set 확인창(R11) · 편집 예시 해 없는 값(완료신고_석면·노동부|석면 예시 0)',
    /var pv = ""; if \(has\)\{ try \{ pv = conAddedPreviewHtml\(b\); \} catch\(e\)\{/.test(html) && /\+ pv \+ \(has \? conProcEditHtml\(b\) : ''\);/.test(html) && html.indexOf('카드 9 · ') >= 0 && /은 카드 9 목록 키와 같은 이름입니다/.test(html)
    && html.indexOf('placeholder="키(예: 실적보고_추가)"') >= 0 && html.indexOf('placeholder="키(예: 완료신고_석면)"') < 0 && html.indexOf('예: 노동부|석면)') < 0, '');
  const adir = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract'), addPath = join(adir, 'proc_added_v1.json');
  let okData = false, okBuilt = false, dTxt = 'appdata 없음';
  if (existsSync(addPath)) {
    const ad = JSON.parse(readFileSync(addPath, 'utf8')), all = [...(ad.stages || []), ...(ad.lists || [])], idset = all.map((x) => x.id).sort().join(',');
    okData = ad.schema === 2 && ['pending', 'applied'].includes(ad.status) && all.every((x) => typeof x.active === 'boolean') && (ad.status === 'pending' ? all.every((x) => x.active === false) : !!(ad.applied && ad.applied.at)) && idset === 'change_contract,complete_asb,complete_demo,pri_complete,pri_start,qual_manual';
    const p = JSON.parse(readFileSync(join(adir, 'blob_proc_contract_v1.json'), 'utf8')), l = JSON.parse(readFileSync(join(adir, 'blob_list_contract.json'), 'utf8'));
    const norm = (xs) => JSON.stringify((xs || []).map((x) => Object.assign({}, x, { active: x.active === undefined ? false : x.active })));
    okBuilt = norm(ad.stages) === JSON.stringify(p.added.stages) && norm(ad.lists) === JSON.stringify(l.added.lists) && p.added.status === ad.status && l.added.status === ad.status && p.added.schema === ad.schema && JSON.stringify(p.added.applied) === JSON.stringify(ad.applied);
    dTxt = 'schema ' + ad.schema + ' · ' + ad.status + ' · ' + idset + ' · 데이터 ' + okData + ' · 거울 빌드 일치 ' + okBuilt;
  }
  const swN = Number((swv.match(/jw-shell-v(\d+)/) || ['', '0'])[1]);
  T('v402 데이터·sw: proc_added_v1 스키마 2·status pending|applied·active는 bool·pending이면 전부 비활성·id 6개 고정 · R16 거울 파일 added = 원천(빌드 누락 없음) · sw ≥ 402(숫자 비교)', okData && okBuilt && swN >= 402, dTxt + ' · sw ' + swN);
} catch (e) { console.log('  (v402 검사 생략 — ' + e.message + ')'); fails++; }
// ---- v419(11/4 측정 결함 수리): 채움 맵 실제 형태(시트별 객체)를 세 곳이 처리 · 평면 고정값 재발 방지 — 실제 빌더를 실행해 객체 형태를 단언하고, 시험이 실제 빌더를 거치는지까지 본다 · 허용 칸 상한 ----
try {
  const sw419 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gw419 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), lw419 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-learn-background.js'), 'utf8'), dd419 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'docdiff.js'), 'utf8'), st419 = readFileSync(join(ROOT, 'tools', 'servertest.mjs'), 'utf8'), cs419 = readFileSync(join(ROOT, 'tools', 'consheet_check.mjs'), 'utf8');
  const fn419 = (name) => { const i = html.indexOf('  function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
  const b419 = new Function(`var els = {}; var document = { getElementById: function(id){ return els[id] || (els[id] = { value: "" }); }, querySelectorAll: function(){ return []; } }; var workers = []; function alert(){} function todayStr(){ return "2026-11-04"; } ${fn419('xgBuildEdits') + fn419('koAmount') + fn419('dateSerial') + fn419('wkLabel') + fn419('findWk')} return xgBuildEdits;`)();
  const shapes419 = ['work_start', 'work_complete', 'asb_plan', 'demo_report', 'waste_report'].map((k) => b419(k, { type: 'dredge', asb_survey: { rows: [] }, bldg_info: {}, owner_info: {} }));
  T('v419 실제 xgBuildEdits 산출(원문 실행)은 5양식 모두 시트별 객체 — 배열로 바뀌면 이 단언과 세 곳을 같이 본다', shapes419.every((e) => e && !Array.isArray(e) && Object.keys(e).some((s) => Array.isArray(e[s]) && Array.isArray(e[s][0]))));
  T('v419 세 곳이 평면화·시트별 처리 경유: docdiff flattenEdits 한 곳 · 짝 생성·워커가 호출 · Array.isArray(…fill.edits) 재등장 금지 · xgApplyLearned는 xgMergeLearned(시트별)·(edits||[]).map 재등장 금지 · 실패는 reportErr로 원인 남김',
    /function flattenEdits\(edits\)/.test(dd419) && /flattenEdits \}|, flattenEdits\b/.test(dd419) && gw419.indexOf('DD.flattenEdits(dr.data.fill.edits)') > 0 && lw419.indexOf('DD.flattenEdits(dr.data.fill.edits)') > 0 && gw419.indexOf('Array.isArray(dr.data.fill.edits)') < 0 && lw419.indexOf('Array.isArray(dr.data.fill.edits)') < 0
    && html.indexOf('function xgMergeLearned(edits, dfl)') > 0 && html.indexOf('return xgMergeLearned(edits,') > 0 && html.indexOf('(edits || []).map') < 0 && fn419('xgApplyLearned').indexOf('reportErr(') > 0 && fn419('xgMergeLearned').indexOf('"__drop_drawings__"') > 0);
  T('v419 평면 고정값 재발 방지: servertest 절 68이 index.html의 xgBuildEdits 원문을 실행해 짝·워커·주입·fillXlsxTemplate까지 · consheet 초안 훅 고정값도 실제 빌더 산출 · 옛 평면 고정값 [{ s: "A1" 금지',
    st419.indexOf("fnOf68('xgBuildEdits')") > 0 && st419.indexOf("fill: { tpl: 'work_start', at: '2026-11-04', edits: ED68 }") > 0 && st419.indexOf("cut68('async function fillXlsxTemplate'") > 0 && cs419.indexOf("fnOf('xgBuildEdits')") > 0 && cs419.indexOf('api.csCdocDraft(c7, \'asb_plan\', edAsb)') > 0 && cs419.indexOf("[{ s: 'A1', v: 'x' }]") < 0);
  T('v419 허용 칸 상한: LEARN_ALLOW_MAX 200 · 범위 표기(~) 거부 · 칸 이름 40자 유지 · 옛 30 상한 재등장 금지 · sw ≥ 419',
    /const LEARN_ALLOW_MAX = 200;/.test(gw419) && gw419.indexOf('v.length > LEARN_ALLOW_MAX') > 0 && gw419.indexOf("f.indexOf('~') >= 0") > 0 && gw419.indexOf('f.length > 40') > 0 && gw419.indexOf('v.length > 30') < 0 && Number((sw419.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 419);
} catch (e) { console.log('  (v419 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v418(11/4 카드 9 PM 회신 "금액변동 시 + 계약기간 변동 시"): 상신 조건 확장 — 함수·기준일 굳힘·결재 본문·건너뜀 가드·확인창 문구, aw "amt" 값 유지 ----
try {
  const sc418 = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const fns418 = ['csChgLastEnd', 'csChgAmtMoved', 'csChgTermMoved', 'csChgAmtChanged', 'csChgApprBody'];
  const miss418 = fns418.filter((f) => sc418.indexOf('function ' + f + '(') < 0);
  T('v418 계약기간 변동 상신: 함수 ' + fns418.length + '종 @con-scen · csChgAmtChanged = 금액 또는 기간 · materializeStage term0 굳힘 · 결재 본문 csChgApprBody · 확인창 문구 · appr_when 검증은 amt 그대로',
    miss418.length === 0 && /function csChgAmtChanged\(c, s\)\{ return csChgAmtMoved\(c, s\) \|\| csChgTermMoved\(s\); \}/.test(sc418)
    && /if\(s\.aw==="amt" && s\.term0==null\) s\.term0 = csChgLastEnd\(c\)\|\|csEnd\(c\);/.test(html) && /body: \(s\.aw === "amt" \? csChgApprBody\(c, s\) : ""\)/.test(html)
    && html.indexOf('금액·계약기간이 그대로인 변경(물량 등)이면 [확인] — 결재 없이 완료합니다.') > 0 && html.indexOf('금액이 그대로인 변경(기간·물량 등)') < 0 && /if \(s\.appr_when && s\.appr_when !== "amt"\) return bad\(s\.id, "결재 조건 불량"\);/.test(html), miss418.join(','));
} catch (e) { console.log('  (v418 검사 생략 — ' + e.message + ')'); fails++; }
// ---- v404(10/31 계약 D2): 기한 엔진 — 엔진 함수·materializeStage 훅(켜짐일 때만, 새 키만)·단계 카드 meta 훅·관리자 카드 배경 행+승격 버튼·서버 con_proc_bg_set·4층 키·sw ≥404
try {
  const swv4 = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const gwd4 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8');
  const sc404 = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const fns4 = ['conDueClear', 'conDueUse', 'conDueOn', 'conMapRow', 'conStageVal', 'conBaseDate', 'conDaysSince', 'conAnnualNext', 'conStageDue'];
  const miss4 = fns4.filter((f) => sc404.indexOf('function ' + f + '(') < 0);
  T('v404 엔진: 함수 ' + fns4.length + '종 @con-scen · CON_MAP/CON_BG 전역 · 배지 4종 문구 · materializeStage 훅(conDueOn 뒤, 새 키 due_src·due_badge) · 단계 카드 meta 훅 · 로더 conDueClear/conDueUse',
    miss4.length === 0 && /var CON_MAP = \{ ok:false/.test(sc404) && ['기산일 필요', '확인 필요', '근거 미승격', '재확인 필요'].every((w) => sc404.indexOf('"' + w + '"') > 0)
    && /if\(!due && c\.scen && conDueOn\(\)\)\{ var dd = conStageDue\(s, c, pipe\);/.test(html) && /s\.due_src = dd\.src; else delete s\.due_src;/.test(html)
    && /if \(!isSkip && !isDone && \(s\.due_badge \|\| s\.due_src\)\) meta \+=/.test(html) && /CON_PROC_SRC\.flag = b\.flag \|\| null; conDueClear\(\);/.test(html) && /try \{ conDueUse\(b\); \} catch\(e\)\{ conDueClear\(\); \}/.test(html));
  T('v404 카드·서버: 관리자 카드 배경 행·data-conproc-bg 버튼·conProcBgSet · gw-data con_proc_bg_set 분기·handleConProcBgSet·4층 키·BG_MISSING·flag_set이 bg_ver 보존 · sw ≥ 404',
    html.indexOf('["배경 bg:law(D2)"') > 0 && html.indexOf('data-conproc-bg=') > 0 && html.indexOf('function conProcBgSet(ver, base)') > 0
    && /action === 'con_proc_bg_set'/.test(gwd4) && /async function handleConProcBgSet/.test(gwd4) && /map: 'map:contract:v1', bg: 'bg:contract:law:v1'/.test(gwd4) && /BG_MISSING/.test(gwd4) && /bg_ver: cur\.bg_ver \|\| '', annual_override: cur\.annual_override \|\| \{\}, updated_by: c\.member\.id/.test(gwd4)
    && Number((swv4.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 404);
} catch (e) { console.log('  (v404 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v405(10/31 계약 D2 3일차): lawwatch ↔ bg 재확인 — gw-lawwatch bg_recheck 보관 · con_proc_get lawwatch 동봉 · 엔진 recheck 배지 · 카드 개정 감지 · appdata lawwatch ③ 블록 · sw ≥405
try {
  const swv5 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd5 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), lw5 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-lawwatch.js'), 'utf8');
  const lwpy = join(ROOT, '..', 'jongwoon-appdata', 'collectors', 'lawwatch', 'lawwatch.py');
  const py5 = existsSync(lwpy) ? readFileSync(lwpy, 'utf8') : '';
  T('v405 lawwatch 연동: gw-lawwatch bg_recheck 보관 · gw-data lawwatch 동봉(heavy) · 엔진 CON_BG.recheck·배지 \'재확인 필요(개정 감지)\' · 카드 개정 감지 · appdata ③ 계약 배경 검사(bg_recheck 동봉) · sw ≥ 405',
    /bg_recheck: bgRecheck/.test(lw5) && /lawwatch: lawwatch, clog: clogOut/.test(gwd5) && /CON_BG\.recheck = rk;/.test(html) && html.indexOf('"재확인 필요(개정 감지)"') > 0 && html.indexOf('개정 감지 \' + b.lawwatch.bg_recheck.length') > 0
    && (!py5 || (/③ 계약 배경\(bg:law\) 재확인 감시/.test(py5) && /'bg_recheck': bg_recheck/.test(py5))) && Number((swv5.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 405);
} catch (e) { console.log('  (v405 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v406(11/1 계약 D3 1일차): 서버 계약 서류함 cdoc — 7액션·RECORD_NOT_FOR_GIT·reclog·audit 반환값 · sw ≥406(앱 화면 변화 0, 2일차에 버튼)
try {
  const swv6 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd6 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), au6 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'audit.js'), 'utf8');
  T('v406 cdoc 서버: dispatch 7액션+rec_log_get · 표준 이름 정규식·RECORD_NOT_FOR_GIT(doc_att_put·doc_bulk_put) · reclog · appendAudit 반환값 · sw ≥ 406',
    ['cdoc_put', 'cdoc_list', 'cdoc_get', 'cdoc_del', 'cdoc_restore', 'cdoc_cur', 'cdoc_purge', 'rec_log_get'].every((a) => gwd6.indexOf("d.action === '" + a + "'") > 0)
    && (gwd6.match(/RECORD_NOT_FOR_GIT/g) || []).length >= 3 && /const CDOC_STD_RE = /.test(gwd6) && /function appendRecLog/.test(gwd6) && /if \(w && w\.ok\) return true;   \/\/ v406/.test(au6)
    && Number((swv6.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 406);
} catch (e) { console.log('  (v406 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v407(11/1 계약 D3 2일차): 계약 서류함 화면 — 단계 서류 행 [최종본↑]·[수령↑]·pii 선택·기록물 줄 · 패킷 메타 우선 판정·[⬆ 올리기] · 생성 훅 초안 보존 2곳 · 이벤트 연결 · sw ≥407
try {
  const swv7 = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v407 계약 서류함 화면(v423 올리기는 넣기 박스로): cdoc 함수군(cdocDocKey·cdocPkHit·cdocRowsHtml·csCdocOpen/Mark/Draft) · 패킷 cdocPkHit 우선 · 생성 훅 csCdocDraft 2곳 · 바인딩 4종 · CSS · sw ≥ 407',
    ['function cdocDocKey', 'function cdocPkHit', 'function cdocRowsHtml', 'function cdocLoad', 'function csCdocOpen', 'function csCdocMark', 'function csCdocDraft'].every((s) => html.indexOf(s) > 0)
    && html.indexOf('var hm = cdocPkHit(c, pk, it), hit = [], hm2 = null;') > 0 && (html.match(/xgOut\(c, kind, [^\n]*\{ edits: ed, learned: al\.learned, tpl: res\.body\.data/g) || []).length === 2
    && ['data-cs-cmove', 'data-cs-copen', 'data-cs-ccur', 'data-cs-cdel'].every((a) => html.indexOf('querySelectorAll("[' + a + ']")') > 0 || html.indexOf('csAct("' + a + '"') > 0)
    && html.indexOf('.cs-cdoc-r{') > 0 && Number((swv7.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 407);
} catch (e) { console.log('  (v407 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v408(11/1 계약 D3 3일차): 관리자 보관함 — cdoc_list all:true(서버 관리자 한정) · 서류 탭 cdocTrashHtml · [복구]·[영구 삭제] 바인딩 · sw ≥408
try {
  const swv8 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd8 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8');
  T('v408 보관함: 서버 all 플래그 관리자 한정 · cdocTrashHtml·csCdocPurge · 서류 탭 호출 · data-cs-crestore/cpurge 바인딩 · cdocLoad all:isAdmin() · sw ≥ 408',
    /const all = d\.all === true && !!c\.member\.admin;/.test(gwd8) && html.indexOf('function cdocTrashHtml') > 0 && html.indexOf('function csCdocPurge') > 0 && html.indexOf('+ cdocTrashHtml(c);') > 0
    && html.indexOf('querySelectorAll("[data-cs-crestore]")') > 0 && html.indexOf('querySelectorAll("[data-cs-cpurge]")') > 0 && html.indexOf('action: "cdoc_list", cid: c.id, all: isAdmin()') > 0
    && Number((swv8.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 408);
} catch (e) { console.log('  (v408 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v409(11/1 Phase 0 C1-1 인사 D-H7): 도움말 구문구·사이드바 4묶음 정합 · MANUAL 20절 휴가 안내 1장 · sw ≥409
try {
  const swv9 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), man9 = readFileSync(join(ROOT, 'MANUAL.html'), 'utf8');
  T('v409 도움말: "이름 선택 + PIN" 0 · 아이디 + PIN · 4묶음(관리·수주·업무·개인) · 휴가 한 줄 · MANUAL 1절 아이디·20절 신청 4단계/철회/취소 요청/연차 계산/사직 · sw ≥ 409',
    html.indexOf('이름 선택 + PIN') < 0 && html.indexOf('<b>아이디 + PIN</b>') > 0
    && ['<b>관리</b>: 지시 / 기성·수금', '<b>수주</b>: 입찰 / 계약', '<b>업무</b>: 캘린더 / 차량', '<b>개인</b>: 물어보기'].every(function (t) { return html.indexOf(t) > 0; })   // v428 개인 순서 = 사이드바(물어보기 / 내 업무 / 휴가)
    && html.indexOf('<b>+ 휴가 신청</b>(유형·기간·사유 필수)') > 0
    && man9.indexOf('이름을 고르고 PIN') < 0 && man9.indexOf('아이디와 PIN을 입력합니다') > 0
    && ['[+ 휴가 신청]', '<b>[철회]</b>', '<b>[취소 요청]</b>', '최대 25일', '사직 면담 신청', '승인·반려되면 알림 켠 기기로 알림이 옵니다'].every(function (t) { return man9.indexOf(t) > 0; })
    && Number((swv9.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 409);
} catch (e) { console.log('  (v409 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v410(11/1 계약 D4 1·2일차): 학습 코어 승격(claude.js·learn.js·docdiff.js) · promoai 재수출 · cdoc_put final 훅 · learn_* 3액션 · sw ≥410
try {
  const swv10 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd10 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), pa10 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'promoai.js'), 'utf8'), pl10 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'promolearn.js'), 'utf8');
  const has10 = (n) => { try { readFileSync(join(ROOT, 'netlify', 'functions', '_lib', n), 'utf8'); return true; } catch (e) { return false; } };
  T('v410 학습 코어: _lib/claude.js·learn.js·docdiff.js 존재 · promoai→claude 재수출 · promolearn→learn 래퍼 · gw-data cdocLearnPair+final 훅 · learn_settings_get/set·learn_pairs_get 디스패치 · 검진·명단 제외 정규식 · sw ≥ 410',
    has10('claude.js') && has10('learn.js') && has10('docdiff.js') && /require\('\.\/claude'\)/.test(pa10) && /require\('\.\/learn'\)/.test(pl10)
    && gwd10.indexOf('async function cdocLearnPair(') > 0 && gwd10.indexOf("if (kind === 'final') { try { learn = await cdocLearnPair(") > 0
    && ['learn_settings_get', 'learn_settings_set', 'learn_pairs_get'].every((a) => gwd10.indexOf("d.action === '" + a + "'") > 0)
    && /forbid_re: \/검진\|건강\|명단\|명부\|신분증/.test(readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'learn.js'), 'utf8'))
    && Number((swv10.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 410);
} catch (e) { console.log('  (v410 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v411(11/1 계약 D4 3일차): 학습 워커 gw-learn-background · 크론 ④ 교대 kickLearnContract · learn_defaults_get · 앱 xgApplyLearned(공란에만)·fill.learned · 관리자 카드 conLearnCard · sw ≥411
try {
  const swv11 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd11 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), cr11 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-ai-cron.js'), 'utf8'), lw11 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-learn-background.js'), 'utf8');
  T('v411 학습 워커: 워커(내부 토큰·NOT_ALLOWED·LEAK_BLOCKED·USAGE_CAP·잠금 해제) · 크론 교대(블로그 미기동 회차만) · learn_defaults_get · xgApplyLearned 공란 전용+생성 2곳 · csCdocDraft learned · 카드 renderConLearnCard+스위치 · sw ≥ 411',
    /v\.payload\.mid !== '__promoai__'/.test(lw11) && /'NOT_ALLOWED'/.test(lw11) && /'LEAK_BLOCKED'/.test(lw11) && /'USAGE_CAP'/.test(lw11) && /T\.lock_key, \{ ts: 0, pair: '' \}/.test(lw11) && /LN\.piiScan\(pp\.user\)/.test(lw11)
    && /if \(!learn \|\| !learn\.started\)/.test(cr11) && /async function kickLearnContract\(/.test(cr11) && /LN\.kickWorker\('gw-learn-background'/.test(cr11)
    && gwd11.indexOf("d.action === 'learn_defaults_get'") > 0 && gwd11.indexOf('LN.fieldDefaults(') > 0
    && html.indexOf('function xgApplyLearned(kind, edits)') > 0 && (html.match(/xgApplyLearned\(kind, ed\)\.then\(/g) || []).length === 2 && html.indexOf('if (v === undefined || e[2] !== "b") return e;') > 0
    && html.indexOf('function csCdocDraft(c, kind, edits, learned, file, tries)') > 0 && html.indexOf('fill.learned = learned') > 0
    && html.indexOf('id="conLearnCard"') > 0 && html.indexOf('function renderConLearnCard()') > 0 && html.indexOf('action: "learn_pairs_get"') > 0 && html.indexOf('data-cl-on') > 0
    && Number((swv11.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 411);
} catch (e) { console.log('  (v411 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v412(11/1 계약 D4 4일차): 기준선 동결 freezeBaseline · 일몰 sunsetCheck · 크론 sunsetSweep(하루 1회) · learn_tpl_set · 카드 양식별 끄기/켜기 data-cl-tpl · sw ≥412
try {
  const swv12 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd12 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), cr12 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-promo-ai-cron.js'), 'utf8'), ln12 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'learn.js'), 'utf8'), lw12 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-learn-background.js'), 'utf8');
  T('v412 일몰·기준선: learn.js freezeBaseline·sunsetCheck(28일·10건) · 짝 생성·워커 병합 뒤 동결 · 크론 sunsetSweep 하루 1회 스탬프 · learn_tpl_set(관리자) · 카드 기준선·일몰 칸+양식별 버튼 · sw ≥ 412',
    /function freezeBaseline\(L, now\)/.test(ln12) && /function sunsetCheck\(L0, now\)/.test(ln12) && /SUNSET_DAYS = 28, SUNSET_BASE_N = 10/.test(ln12)
    && gwd12.indexOf('LN.freezeBaseline(L, now)') > 0 && lw12.indexOf('LN.freezeBaseline(merged') > 0
    && /async function sunsetSweep\(st, now, pairs\)/.test(cr12) && /sr\.data\.day === day\) return \{ skipped: 'done_today' \}/.test(cr12) && cr12.indexOf('sunset = await sunsetSweep(st, now, pairs)') > 0
    && gwd12.indexOf("d.action === 'learn_tpl_set'") > 0 && /async function handleLearnTplSet\(/.test(gwd12) && gwd12.indexOf('delete L.baseline;') > 0
    && html.indexOf('function conLearnSunsetTxt(L)') > 0 && html.indexOf('data-cl-tpl') > 0 && html.indexOf('action: "learn_tpl_set"') > 0 && html.indexOf('<th>기준선·일몰</th>') > 0
    && Number((swv12.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 412);
} catch (e) { console.log('  (v412 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v413(11/1 C2-1): [내 것 아님] task_notmine · save 보호 · clog:appr 행 · _lib/apprlearn.js tally · 배정표 카드 delta · sw ≥413
try {
  const swv13 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd13 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), al13 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'apprlearn.js'), 'utf8');
  T('v413 내 것 아님: 서버 task_notmine(NOT_AUTO·NOT_ASSIGNEE)·save 보호(who_by edit 통과)·clog 행(who_id·due d·del)·apprlearn tally(RECARD 3/2인) · 앱 버튼 2곳(지시 탭·내게 온 지시)+taskNotMine(_colBase 갱신)·모달 who_by edit·배정표 카드 lessons · sw ≥ 413',
    gwd13.indexOf("d.action === 'task_notmine'") > 0 && /async function handleTaskNotmine\(/.test(gwd13) && /'NOT_AUTO'/.test(gwd13) && /'NOT_ASSIGNEE'/.test(gwd13) && gwd13.indexOf("o.who_by === 'notmine' && t.who_id && t.who_by !== 'edit'") > 0 && gwd13.indexOf("f: 'due'") > 0 && gwd13.indexOf("f: 'del'") > 0 && /async function apprClogAppend\(/.test(gwd13)
    && /const RECARD_N = 3;/.test(al13) && /const RECARD_WHO = 2;/.test(al13) && /function tally\(rows, ym\)/.test(al13)
    && html.indexOf('function taskNotMineBtn(t)') > 0 && html.indexOf('function taskNotMine(id)') > 0 && (html.match(/taskNotMineBtn\(t\)/g) || []).length >= 3 && html.indexOf('action: "task_notmine"') > 0 && html.indexOf('_colBase["tasks"] = b.updated_at') < 0 && html.indexOf('t.who_by = "edit"') > 0 && html.indexOf('R1 재카드') > 0 && html.indexOf('var ls = res.body.lessons || null;') > 0
    && Number((swv13.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 413);
} catch (e) { console.log('  (v413 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v414(11/2 C2-3·C3-1): MANUAL 4절 4단계·내 것 아님 · 도움말 지시 1줄 · NOTIFY_EVENT_ORDER 5 · gw-data notifyLeaves · todo-cron 레이더 이식 · sw ≥414
try {
  const swv14 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd14 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), man14 = readFileSync(join(ROOT, 'MANUAL.html'), 'utf8'), td14 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-todo-cron.js'), 'utf8');
  const ord14 = (html.match(/var NOTIFY_EVENT_ORDER = \[([^\]]+)\]/) || ['', ''])[1].replace(/["\s]/g, '');
  T('v414 안내·휴가 알림·레이더: MANUAL 4절 4단계+내 것 아님 · 19절 · 도움말 4절 · NOTIFY_EVENT_ORDER 5(휴가 2종) · gw-data leave_request/leave_result+notifyLeaves · todo-cron contractPlan 이식(duty:sent) · sw ≥ 414',
    man14.indexOf('받은 지시는 이렇게 끝납니다') > 0 && (man14.match(/내 것 아님/g) || []).length >= 2 && html.indexOf('📖 사용 안내 4절') > 0
    && ord14.indexOf('task_auto_create,task_review,due_digest,leave_request,leave_result') === 0 && gwd14.indexOf("leave_request: {") > 0 && gwd14.indexOf("leave_result: {") > 0 && /async function notifyLeaves\(/.test(gwd14) && gwd14.indexOf('await notifyLeaves(store(DATA), oldItems, doc.items, c.member)') > 0
    && td14.indexOf("require('./gw-duty-cron')") > 0 && td14.indexOf("blobGet(st, 'duty:sent')") > 0 && /DC\.contractPlan\(/.test(td14)
    && Number((swv14.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 414);
} catch (e) { console.log('  (v414 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v415(11/2 C3-2): 입찰 알림 bid_result/bid_fail · bidNotifyIds · todo-cron 유찰 요약 · NOTIFY_EVENT_ORDER 7 · sw ≥415
try {
  const swv15 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), gwd15 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), td15 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-todo-cron.js'), 'utf8');
  const ord15 = (html.match(/var NOTIFY_EVENT_ORDER = \[([^\]]+)\]/) || ['', ''])[1].replace(/["\s]/g, '');
  T('v415 입찰 알림: bid_result each|award · bid_fail admins|assignee · bidNotifyIds(담당+PM) · bids_results award 분기(primaryOnly) · bot_notify watch-입찰 담당 추가 · todo-cron bids-lost 요약 · NOTIFY_EVENT_ORDER 7 · sw ≥ 415',
    gwd15.indexOf("bid_result: {") > 0 && gwd15.indexOf("bid_fail: {") > 0 && /async function bidNotifyIds\(/.test(gwd15) && gwd15.indexOf("nfB.events.bid_result === 'award'") > 0 && gwd15.indexOf("tag: 'bids-award'") > 0 && gwd15.indexOf("/^watch-입찰/.test(tag)") > 0
    && td15.indexOf("events.bid_result === 'award'") > 0 && td15.indexOf("tag: 'bids-lost-' + today") > 0
    && ord15 === 'task_auto_create,task_review,due_digest,leave_request,leave_result,bid_result,bid_fail'
    && Number((swv15.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 415);
} catch (e) { console.log('  (v415 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v421(11/4 카드 6 재발 방지): 적격 지시는 적격심사 없는 낙찰방법으로 확인된 낙찰엔 안 만듦 · 반복 값 none은 다음 회차 안 만듦 · sw ≥421
try {
  const fn21 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
  const DTM21 = (html.match(/var DECIDE_TO_METHOD=\{[^}]*\};/) || [''])[0];
  const fmt21 = 'function fmtDate(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}';
  const q21 = new Function([DTM21, fn21('methodKindOf'), fn21('bidMethodEff'), fn21('bidNoQualMethod'), fn21('addDaysStr'), fn21('runBidQualGen'), fmt21,
    'var tasks=[], pushed=[], n=0, __bids=[], autoGenReady={tasks:true};',
    'function isAdmin(){return true;} function todayStr(){return "2026-11-05";} function isDate(s){return /^\\d{4}-\\d{2}-\\d{2}$/.test(s||"");}',
    'function genId(p){n++;return p+n;} function saveTasksCache(){} function scheduleTasksSave(){} function renderTasks(){} function renderSummary(){} function renderDashboard(){}',
    'function pushNotify(a,b){pushed.push(b);} function liveBids(){return __bids;}',
    'return { no:bidNoQualMethod, run:function(list){ __bids=list; runBidQualGen(); return {tasks:tasks,pushed:pushed}; } };'].join('\n'))();
  const yes21 = [{ method: '소액수의견적' }, { method: '소액수의(공사)' }, { method: '협상에의한계약' }, { method: '종합평가낙찰제' }, { method: '종합심사낙찰제(공사)' }, { method: '매각 (최고가)' }, { method: '제한적최저가(낙찰하한율)' }, { method: '최저가낙찰제' }, { method: '적격심사제', ext: { mmis: 1, decide: '소액수의(견적)' } }, { source: '나라장터', method: '소액수의견적', ext: { decide: '소액수의(견적)' } }, { source: '나라장터', method: '협상에의한계약' }, { source: '누리장터', method: '소액수의견적' }];
  const no21 = [{ method: '적격심사제' }, { method: '적격심사 낙찰제(공사)' }, { method: '' }, {}, { method: '제한경쟁' }, { method: '소액전자' }, { method: '규격가격동시입찰' }, { method: '소액수의견적', ext: { mmis: 1, decide: '적격심사' } }, { method: '적격심사제', ext: { mmis: 1, dneg: 1 } }, { source: '나라장터', method: '소액수의견적' }, { source: '나라장터', method: '최저가낙찰제' }];
  T('v421 bidNoQualMethod: 수의·협상·종합심사·매각·최저가 = 안 만듦 / 적격·모름·낙찰방법 아닌 라벨 = 만듦 / 판정은 공고문 기준',
    yes21.every((b) => q21.no(b) === true) && no21.every((b) => q21.no(b) === false), JSON.stringify([yes21.filter((b) => q21.no(b) !== true), no21.filter((b) => q21.no(b) !== false)]));
  const r1 = q21.run([{ id: 'a', status: '낙찰', method: '소액수의견적', title: '수의' }, { id: 'b', status: '낙찰', method: '적격심사제', title: '적격', result: { checked: '2026-11-01' } }, { id: 'c', status: '낙찰', method: '', title: '미상' }, { id: 'd', status: '검토', method: '적격심사제', title: '검토' }]);
  const keys21 = r1.tasks.map((t) => t.auto_key).join(',');
  T('v421 runBidQualGen: 적격·모름 낙찰만 생성(수의·낙찰 전 제외) · 기한 = 낙찰 확인 +7일 · 푸시 1회 2건',
    keys21 === 'bid:b:qual,bid:c:qual' && r1.tasks[0].due === '2026-11-08' && r1.tasks[1].due === '2026-11-12' && r1.pushed.length === 1 && /낙찰 2건/.test(r1.pushed[0]), keys21 + ' / ' + r1.pushed.join('|'));
  const r2 = q21.run([{ id: 'b', status: '낙찰', method: '적격심사제', title: '적격' }, { id: 'e', status: '낙찰', method: '협상에의한계약', title: '협상' }]);
  T('v421 runBidQualGen: 다시 돌려도 중복 없음 · 건너뛰는 낙찰만 있으면 푸시 없음', r2.tasks.length === 2 && r2.pushed.length === 1, r2.tasks.length + '/' + r2.pushed.length);
  const rc21 = new Function([fn21('advanceRecur'), fn21('spawnNextRecur'), fmt21, 'var tasks=[]; function liveTasks(){return tasks;} function isDate(s){return /^\\d{4}-\\d{2}-\\d{2}$/.test(s||"");} function todayStr(){return "2026-11-05";} function genId(p){return p+tasks.length;}', 'return function(t){ spawnNextRecur(t); return tasks; };'].join('\n'))();
  const n0 = rc21({ id: 'x', title: '세팅', due: '2026-11-05', recur: 'none', status: 'done' }).length;
  const m1 = rc21({ id: 'y', title: '매월', due: '2026-11-05', recur: 'monthly', status: 'done' });
  T('v421 spawnNextRecur: 반복 값 none = 다음 회차 없음 · monthly = 한 달 뒤 1건', n0 === 0 && m1.length === 1 && m1[0].due === '2026-12-05' && m1[0].recur === 'monthly', n0 + '/' + JSON.stringify(m1));
  const swv21 = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v421 홈 낙찰 카드: 지시를 안 만드는 낙찰은 계약 시작 대기로 표시', html.indexOf("(bidNoQualMethod(b)?' · 계약 시작 대기':' · 적격심사 기한 '+due+' ('+dd.text+')')") > 0);
  T('v421 지시 저장: 첫 GET 실패 기기는 base 0으로 보내 409 병합 · [내 것 아님] 뒤 base를 올리지 않음', html.indexOf('var saveBase = (col === "tasks" && _colBase[col] === undefined) ? 0 : _colBase[col];') > 0 && html.indexOf('base: saveBase }') > 0 && html.indexOf('_colBase["tasks"] = b.updated_at') < 0);
  T('v421 🔁 칩은 none에 안 뜸 · sw ≥421', html.indexOf('if (t.recur && t.recur !== "none") metaBits.push') > 0 && Number((swv21.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 421);
} catch (e) { console.log('  (v421 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v422(11/5 체크 31): 준설 실물 양식 4항목 — 선택지·라벨·확장자·서버 키 일치 · gap 항목에 gen을 곁들여 옛 화면·거울과 호환 · 양식 파일에 개인정보를 넣지 않는 안내 · sw ≥422
try {
  const K22 = ['safety_plan', 'safety_risk', 'safety_rule', 'safety_emerg', 'safety_ppe', 'safety_cost', 'labor_split'], H22 = ['safety_plan', 'safety_rule', 'safety_emerg', 'safety_ppe', 'labor_split'];
  const lab22 = (html.match(/var TPL_LABELS=\{[^\r\n]*\};/) || [''])[0], ext22 = (html.match(/var TPL_EXT=\{[^\r\n]*\};/) || [''])[0], srv22 = (gwd.match(/const TPL_KEYS = \{[^\r\n]*\};/) || [''])[0];
  const has22 = (str, k) => new RegExp('\\b' + k + ':').test(str);
  T('v422 양식 키 7: 앱 라벨·서버 키 모두 있음 · hwpx 5종만 확장자 예외(xlsx 2종은 기본값) · 라벨 키 ⊂ 서버 키', K22.every((k) => has22(lab22, k) && has22(srv22, k)) && H22.every((k) => has22(ext22, k + '')) && !has22(ext22, 'safety_risk') && !has22(ext22, 'safety_cost')
    && [...lab22.matchAll(/\b(\w+):"/g)].every((m) => has22(srv22, m[1])), lab22.slice(0, 200));
  T('v422 생성 창: 선택지 4종 · 안전보건관리비 칸 · 묶음 표(XG_SAFE_FILES) · 사용내역서는 일반 xlsx 경로(xgBuildEdits)', ['safety_plan', 'safety_pack', 'safety_cost', 'labor_split'].every((k) => html.indexOf('<option value="' + k + '">') > 0) && html.indexOf('id="xgSafeFee"') > 0 && /var XG_SAFE_FILES=\{ safety_plan:\["safety_plan"\], labor_split:\["labor_split"\], safety_pack:\["safety_risk","safety_rule","safety_emerg","safety_ppe"\] \}/.test(html) && html.indexOf('if(kind==="safety_cost"){   // v422') > 0 && html.indexOf('if(XG_SAFE_FILES[kind]){') > 0 && html.indexOf('if(XG_SAFE_FILES[kind]){') < html.indexOf('// 하드리딩 원칙: 원문(계약서·조사서·대장)에서 못 채운 값만')
    && /document\.getElementById\("xgSafeWrap"\)\.style\.display = \(k==="safety_plan"\|\|k==="safety_cost"\)/.test(html) && /document\.getElementById\("xgSafeRecvWrap"\)\.style\.display = \(k==="labor_split"\)/.test(html));
  T('v422 검토 반영(v424 사용내역서 초안 복구): 이월 차단(XG_RESET_IDS에 대리인 3칸·금액·수신처) · 사용내역서 제외 분기 없음 · 착공계 초안에 주민번호 칸 뺌 · 패킷 zip · tpl 읽기 실패 비200', /var XG_RESET_IDS=\["xgAgent","xgAgentRrn","xgAgentLic","xgSafeFee","xgSafeRecv",/.test(html) && html.indexOf('if(kind!=="safety_cost") csCdocDraft') < 0 && html.indexOf('if (kind === "work_start") return { "현장대리인계":["F13"], "재직증명서":["I6"] }') > 0 && html.indexOf('downloadBlob(name+"_안전 패킷.zip", zipStore(fs))') > 0 && /error_code: 'TPL_READ_FAILED'/.test(gwd) && /if \(!r\.ok && r\.code !== 'NOT_FOUND'\) return jr\(500, \{ status: 'ERROR', error_code: r\.code \|\| 'STORAGE_READ_FAILED'/.test(gwd));
  const sc22 = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  T('v422 패킷: ✗ 4항목은 t:"gap"을 유지하고 gen(준설 한정)을 곁들임(옛 판은 ✗ 그대로) · 줄 그릴 때 gen 우선', ['safety_plan', 'safety_pack', 'safety_cost', 'labor_split'].every((k) => new RegExp('t:"gap"[^\\n]*gen:\\{ t:"gen", k:"' + k + '"[^\\n]*when:"dredge" \\}').test(sc22)) && sc22.indexOf('var it = (it0.gen && csPkWhen(c, it0.gen.when)) ? it0.gen : it0;') > 0);
  const swv22 = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v422 tpl_list 동시 읽기(키 21개) · 응답 키 순서는 TPL_KEYS 그대로 · sw ≥422', /await Promise\.all\(Object\.keys\(TPL_KEYS\)\.map\(async \(key\) =>/.test(gwd) && /for \(const key of Object\.keys\(TPL_KEYS\)\) templates\[key\] = out\[key\];/.test(gwd) && Number((swv22.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 422);
} catch (e) { console.log('  (v422 검사 생략 — ' + e.message + ')'); fails++; }

// ---- (11/2) Blob 컨텍스트 전수: netlify/functions/*.js 중 store(·blobGet(·blobSet(·blobList(를 쓰는 함수는 setupBlobContext( 호출 필수 — gw-lawwatch가 빠져 첫 실제 경보가 502(11/2)
// ---- v423(11/6 체크 31): 넣기 박스 — 입구 하나 · 계약 시작 맨 바깥 두 갈래 · 옛 입구 제거 · 서버 액션 · 판단 모듈 ----
try {
  const srv23 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), pb23 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-parse-background.js'), 'utf8');
  T('v423 맨 바깥 두 갈래: 넣기 박스(data-cbx-drop="top") + [직접 생성](conStartBtn) · + 계약 시작 문구 없음 · + 양식 등록 버튼 없음(관리자 양식 목록만) · 그대로인 버튼 서류 출력·실적 다운로드',
    ids.has('conBox') && ids.has('conBoxCards') && html.indexOf('data-cbx-drop="top"') > 0 && />직접 생성<\/button>/.test(html) && html.indexOf('>+ 계약 시작<') < 0 && html.indexOf('>+ 양식 등록<') < 0 && />양식 목록<\/button>/.test(html) && ids.has('docGenBtn') && ids.has('conPerfBtn') && html.indexOf('[+ 양식 등록]') < 0, '');
  T('v423 옛 입구 제거: 양식 등록 버튼·증빙 올리기·📎 첨부·끌어놓기·최종본↑·수령↑·⬆ 올리기·개인정보 선택 칸이 화면 코드에 없음',
    ['data-tpl-up', 'proofUpBtn', 'proofFile', 'data-catt-add', 'data-catt-drop', 'data-cs-cup', 'data-cs-cpk', 'data-cs-pii', 'function csCdocPick', 'function csCdocUpload', 'function conAddAttach', 'function conPickAttach', 'function asbBgParse', 'function proofUpload'].every((s) => html.indexOf(s) < 0), '');
  T('v423 박스 함수군: 올리기(조각)·판단·카드·새 계약·서류함 넣기·옮기기·양식·증빙 · 계약 안 박스(csDetailHtml) · 그 밖의 서류 · 판 밖 드롭 방지 · 초기화 · CSS',
    ['function cbxAdd', 'function cbxUpload', 'function cbxJudge', 'function cbxApply', 'function cbxStart', 'function cbxPlace', 'function cbxMoveGo', 'function cbxTplGo', 'function cbxProofGo', 'function cbxCardHtml', 'function cbxBind', 'function cbxInit'].every((s) => html.indexOf(s) > 0)
    && html.indexOf('h += cbxBoxHtml(c);') > 0 && html.indexOf('cbxInit();') > 0 && /window\.addEventListener\("drop"/.test(html) && html.indexOf('.cbx-drop{') > 0 && html.indexOf('.cbx-card{') > 0, '');
  T('v423 큰 파일: 조각 상수 앱·서버 일치(4,400,000자·4의 배수) · 25MB ≤ 8조각 · 열기 조각 받기(part)',
    /CBX_PART = 4400000/.test(html) && /BOX_PART_B64 = 4400000/.test(srv23) && 4400000 % 4 === 0 && Math.ceil(25 * 1024 * 1024 * 4 / 3 / 4400000) <= 8 && /BOX_MAX_PARTS = 8/.test(srv23) && /part: j \}\)\.then/.test(html), '');
  T('v423 서버 액션 4종 라우팅 · 공통 저장 cdocCommit(cdoc_put·cdoc_attach) · 백그라운드 판단·전용 판독',
    ['box_put', 'cdoc_attach', 'cdoc_move', 'box_fix'].every((a) => srv23.indexOf("d.action === '" + a + "'") > 0) && (srv23.match(/return cdocCommit\(/g) || []).length === 2 && /BJ\.judgeBox\(/.test(pb23) && /r\.data\.bid !== m\.data\.id/.test(pb23), '');
  T('v423 넣다 만 파일: 서버 box_pending·표식 boxp · 앱 cbxRestore · 판독 조회 권한 · 판 밖 드롭은 파일 칸 제외 · 옛 계약서 판독 분기 없음',
    /d\.action === 'box_pending'/.test(srv23) && /function boxMarkKey/.test(srv23) && html.indexOf('function cbxRestore') > 0 && /NOT_OWNER/.test(srv23) && html.indexOf('var fileInput = function(e)') > 0 && html.indexOf('계약서 판독 완료') < 0, '');
  T('v423 서버 확장자표는 문서함과 같고 xls만 박스 추가', /function boxExtOk\(ext\) \{ return docAttExtOk\(ext\) \|\| ext === 'xls'; \}/.test(srv23) && /ext !== "xls"/.test(html), '');
} catch (e) { console.log('  (v423 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v424(11/6 체크 31 브리핑 1단계 + 물어보기): 생성 결과 파일째 저장·표식·단계 칸 값·물어보기 공개범위 ----
try {
  const srv24 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-data.js'), 'utf8'), ask24 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'ask.js'), 'utf8'), ds24 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'docscope.js'), 'utf8'), dd24 = readFileSync(join(ROOT, 'netlify', 'functions', '_lib', 'docdiff.js'), 'utf8'), pb24 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-parse-background.js'), 'utf8'), lw24 = readFileSync(join(ROOT, 'netlify', 'functions', 'gw-learn-background.js'), 'utf8'), sw24 = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  T('v424 물어보기: 문서 도구가 docVisible을 거침 · 판정 한 곳(_lib/docscope.js, gw-data는 가져다 씀) · sw ≥ 424', /DS\.docVisible\(member, d, ds\)/.test(ask24) && /function docVisible\(m, it, settings\)/.test(ds24) && !/function docVisible\(/.test(srv24) && /require\('\.\/_lib\/docscope'\)/.test(srv24) && Number((sw24.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 424);
  const dl24 = [...html.matchAll(/downloadBlob\(([^\n]{0,60})/g)].map((m) => m[1]).filter((x) => !/^"(?:차량목록|전체백업|실적목록|세무)/.test(x) && !/^r2\.body\.file/.test(x) && !/^res\.body\.name/.test(x) && !/^name, /.test(x) && !/^name\+"_안전 패킷/.test(x) && !/^name, blob\)\{/.test(x));
  T('v424 생성 경로: 양식으로 만든 파일은 전부 xgOut을 거침(직접 내려받기 없음) · 생성 12경로', dl24.length === 0 && (html.match(/xgOut\(/g) || []).length >= 13 && ['"qual_packet"', '"contract_pledge"', '"seal_reg"', '"bond_waiver"', '"labor_exempt"', '"settle_doc"', '"adv_pay"', '"bid_rate"', 'qtKey'].every((k) => html.indexOf('xgOut(c, ' + k) > 0), JSON.stringify(dl24));
  T('v426 착공계 주민번호: 창 문구에 "양식 기본값" 없음 · 비우면 확인요망 · 서버가 주민번호 꼴 양식을 거부 · 앱이 쉬운 말로 알림 · 백업 흔적 통로', html.indexOf('양식 기본값 유지') < 0 && html.indexOf('현장대리인 주민등록번호(양식에 넣어 두지 않습니다') > 0 && /BJ\.rrnScan\(Buffer\.from\(b64, 'base64'\)\)/.test(gwd) && html.indexOf('tplCode === "TPL_HAS_RRN"') > 0 && /action === 'backup_stamp'/.test(gwd));
  T('v425 최종본 연결: 넣기가 초안 없으면 xgDraftMake 먼저(내려받기·값 저장·확인창 없음) · 창과 같은 토큰 함수 · 파일이 들어오면 단계 체크 · 사람이 쓰는 창은 안 건드림', /prep = xgDraftMake\(c, tpl\)/.test(html) && /o = \{ noDownload: true, noBack: true, wait: true, late: true \}/.test(html) && /var cdT=xgConTok\(c\)/.test(html) && /var qtT=xgQuoteTok\(\)/.test(html) && /var adT=xgAdvTok\(\)/.test(html) && /dd\.st = "done"; dd\.auto = 1/.test(html) && /back\.classList\.contains\("show"\)\) \|\| xgLateOn/.test(html));
  T('v424 표식: 앱 번호 형식 = 서버 번호 형식 · 서버 사본은 주민번호 가림(genStoreCopy) · 착공계는 칸 비운 사본(xgNoRrn)', dd24.indexOf('JWG1\\\\.[A-Za-z0-9_-]{1,40}\\\\.[a-z0-9_]{1,30}\\\\.[a-z0-9]{6,16}') > 0 && html.indexOf('JWG1\\.[A-Za-z0-9_-]{1,40}\\.[a-z0-9_]{1,30}\\.[a-z0-9]{6,16}') > 0 && html.indexOf('genStoreCopy(b, kind === "work_start")') > 0 && html.indexOf('fillXlsxTemplate(o.tpl, xgNoPerson(edits, cells))') > 0);
  T('v424 짝: 표식 → 이름 → 내용 일치율 순 · hwpx 문단 비교 · 모델은 칸 비교만 · 워커 가드 · 판단 표식(모델 호출 없음)', /how = byMark \? 'mark' : ''/.test(srv24) && /DD\.matchScore\(/.test(srv24) && /DD\.hwpxParaDiff\(db, fb\)/.test(srv24) && /kind === 'xlsx_cell' && learnAllowed/.test(srv24) && /NO_CELL_MAP/.test(lw24) && /BJ\.markJudge\(/.test(pb24));
  T('v424 단계 칸 값: 생성 창이 xgAuto로 읽음 · 종류를 바꾸면 사람이 안 고친 칸만 · 새로 친 값은 빈 칸에 저장(xgSaveBack) · AI↔직원 줄이 서류 탭에', html.indexOf('xgAutoApply(c, document.getElementById("xgKind").value, true)') > 0 && html.indexOf('xgAutoApply(c0, $("xgKind").value, false)') > 0 && html.indexOf('if (!o.noBack) xgSaveBack(c);') > 0 && html.indexOf('var L = cdocGenLine(c, tpl, fm.G)') > 0 && html.indexOf('return h + cdocGenHtml(c, fm.shown);') > 0);   // v427 AI↔직원 줄은 서류 줄 안 · 줄에 없는 양식만 아래 칸
} catch (e) { console.log('  (v424 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v427(11/9 체크 31 시안 ①②③ ㄱ): 계약 펼침 단계·서류 한 탭 — 묶음 한 줄 · 지금 단계만 펼침 · 5단계 계량증명서만 · 같은 서류 한 줄 · 저장 그대로 ----
try {
  const sw27 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), sh27 = html.slice(html.indexOf('// @con-sheet-start'), html.indexOf('  function renderContracts(){')), sc27 = html.slice(html.indexOf('// @con-scen-start'), html.indexOf('// @con-scen-end'));
  const bks = [...sh27.matchAll(/\{ k:"(\w+)", pri:"[^"]+", h:"/g)].map((m) => m[1]);
  T('v427 ① 묶음 4(착공계·준공계·청구서·계약서류 4종) · 대표 서류가 없으면 안 묶음 · 관급만', bks.join(',') === 'work_start,work_complete,bill_doc,con_docs' && /if \(!mem\.some\(function\(d\)\{ return csDocBase\(d\.n\) === b\.pri; \}\)\) return;/.test(sh27) && /if \(pub && p\.key !== "chg"\) CS_BUNDLES\.forEach/.test(sh27) && /if \(p\.key === "chg"\) return;/.test(sh27), bks.join(','));   // 검토 반영: 변경계약 줄은 묶음·합치기 없음
  T('v427 ② 지금 단계만 펼침(누른 단계는 계약마다 기억) · 머리 줄 버튼(aria-expanded) · CSS 세로 목록', /return i === p\.cur && c\.status !== "done"; \}/.test(sh27) && /class="cs-sh" data-cs-stg="/.test(sh27) && /aria-expanded="' \+ \(open \? 'true' : 'false'\)/.test(sh27) && /\.cs-stages\{display:flex;flex-direction:column;/.test(html) && /\.cs-sh\{all:unset;/.test(html), '');
  const iK = sc27.indexOf('[/계량|반입/,"계량"]'), iJ = sc27.indexOf('[/준공|계량|반입/,"준공"]');
  T('v427 ③ 준설토 계량·반입 = 계량증명서(STAGE_DOCS 계량 · 매핑이 준공보다 앞) · 패킷 계량증명서는 그 단계 줄로', /"계량":"\[수령\] 계량증명서"/.test(sc27) && iK > 0 && iJ > iK && /"complete\|weigh":\{ m:\/\^계량증명서\$\/, st:\/계량\|반입\/ \}/.test(sh27), '');
  T('v427 저장 그대로: 줄 체크는 종전 csDocToggle/csDocNa 또는 csRowAct(stage.docs 값·패킷 줄 c.pkst) · doc_key 함수 안 바뀜 · 상자에 주는 목록(cbxDocList) 안 바뀜 · 배선 data-cs-rchk/rna',
    /function cdocDocKey\(p, d\)\{ return cdocSan\(\(p && p\.key\) \|\| "main", 12\) \+ "\." \+ cdocSan\(d && d\.k, 27\); \}/.test(html) && /\(c\.pkst = c\.pkst \|\| \{\}\)\[e0\.ik\] = to;/.test(sh27) && /querySelectorAll\("\[data-cs-rchk\], \[data-cs-rna\]"\)/.test(html) && /csAct\("data-cs-dchk"/.test(html) && /CON_PACKETS\.filter\(function\(pk\)\{ return csPkWhen\(c, pk\.when\); \}\)\.forEach\(function\(pk\)\{\s*pk\.items\.filter\(function\(it\)\{ return it\.t === "att" && csPkWhen\(c, it\.when\); \}\)/.test(html), '');
  T('v427 탭 3개 · [생성]은 서류 줄(단계 📄 서류는 그 양식이 줄에 없을 때만) · 아래쪽 [생성][서류] → 다른 서류 만들기 · sw ≥ 427',
    /var tab = conDetTab === "doc" \? "st" : conDetTab;/.test(sh27) && /function csStgGenCovered\(c, s, rows\)/.test(sh27) && /function csMoreHtml\(c\)/.test(sh27) && !/data-con-xlsx="' \+ esc\(c\.id\) \+ '">생성<\/button><button class="mini-btn" data-con-doc=/.test(html) && Number((sw27.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 427, '');
  T('v427 직접 생성 계약금액(PM 11/9 "직접생성은 다 계약금액이 들어가야지"): 창에 금액 칸·미정 체크 · 비우면 시작 안 함 · 낙찰 두 길 모두 낙찰 금액 미리 · 계약 정보 amount 저장 · 개요 미정 표시',
    ids.has('conAmount') && ids.has('conAmtTbd') && /if\(!amt && !amtTbd\)\{ alert\("계약금액\(원\)을 입력하세요/.test(html) && /function conAmtFromBid\(b\)/.test(html) && (html.match(/conAmtFromBid\(b\);/g) || []).length === 2
    && /if\(amt\)\{ if\(bcinfo\) bcinfo\.amount=amt; else bcinfo=\{ title:"", amount:amt,/.test(html) && /c\.amount_tbd \? "미정\(견적 전, "/.test(html) && /var am0=document\.getElementById\("conAmount"\); if\(am0\) am0\.value="";/.test(html), '');
} catch (e) { console.log('  (v427 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v428(11/9 메뉴 56 1단계, PM "56. ㄱ"): 탭 자리 옮기기 — 현장 → 안전 › 현장 칸 · 교육 이력 한 목록(안전 › 교육·검진) · 부동산 → 입찰 › 부동산 칸.
//      데이터·권한 키(MODULES·COL)·서버는 그대로. 옛 id를 지우고 배선을 남기면 부팅이 멈춘다(null.addEventListener) — 옛 이름 0개부터 보고,
//      칸 판정·별칭·캘린더 이동·교육 한 목록은 index.html에서 함수를 뽑아 실제로 돌려 본다.
try {
  const sw28 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), man28 = readFileSync(join(ROOT, 'MANUAL.html'), 'utf8');
  const fn28 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const sec28 = (id) => { const i = html.indexOf('<section class="view" id="' + id + '">'); if (i < 0) throw new Error('뷰 없음: ' + id); return html.slice(i, html.indexOf('</section>', i)); };
  // 여는 태그부터 div 짝이 닫히는 곳까지(문자열 구간이 아니라 실제 포함 관계 — 칸 밖으로 밀려난 요소를 잡는다)
  const divBlock28 = (src, openTag) => { const i = src.indexOf(openTag); if (i < 0) return ''; const re = /<div\b|<\/div>/g; re.lastIndex = i; let d = 0, m; while ((m = re.exec(src))) { d += m[0] === '</div>' ? -1 : 1; if (d === 0) return src.slice(i, m.index + 6); } return ''; };
  const once28 = (id) => html.split('id="' + id + '"').length === 2;

  // ① 옛 이름 0
  const OLD28 = ['id="view-site"', 'id="view-onbid"', 'tabSiteBtn', 'tabOnbidBtn', 'data-tab="site"', 'data-tab="onbid"', 'switchTab("site")', 'switchTab("onbid")', '"view-site"', '"view-onbid"', 'eduHrList', 'eduHrHead', 'eduHrAddBtn', 'eduWkList', 'eduWkHead', 'eduWkAddBtn', 'eduWkSec'];
  const left28 = OLD28.filter((s) => html.indexOf(s) >= 0);
  T('v428 옛 이름 0: 뷰 view-site·view-onbid · 탭 버튼 tabSiteBtn·tabOnbidBtn · data-tab site·onbid · switchTab("site"/"onbid") · 인사 두 화면 교육 목록 id 7종 — 남은 것 없음 · renderEduInto 호출은 한 목록 1곳(eduList·eduHead·고른 대상)',
    left28.length === 0 && (html.match(/renderEduInto\(/g) || []).length === 2 && html.indexOf('renderEduInto("eduList","eduHead",eduViewScope)') > 0, '남음: ' + left28.join(', '));

  // ② 사이드바 순서·칸 수
  const nav28 = html.slice(html.indexOf('<nav class="tabbar" id="tabbar">'), html.indexOf('</nav>'));
  const tabs28 = [...nav28.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const WANT28 = 'dash,tasks,rec,cli,hr,workers,progress,bid,con,quote,promo,cal,veh,hwakwan,allbaro,safety,lic,doc,ask,check,leave';
  const ia28 = tabs28.indexOf('allbaro');
  T('v428 사이드바 21칸(관리자 22 → 21, 부동산 빠짐) 순서 그대로 · 업무 묶음 운반일지 → 안전 → 인허가(옛 현장 자리) · 안전 버튼 tabSafetyBtn = 처음엔 숨김(perm-hidden)·글자 "안전"',
    tabs28.join(',') === WANT28 && tabs28.length === 21 && ia28 > 0 && tabs28[ia28 + 1] === 'safety' && tabs28[ia28 + 2] === 'lic'
    && /<button class="tab-btn perm-hidden" data-tab="safety" id="tabSafetyBtn">안전<\/button>/.test(nav28), tabs28.join(','));

  // ③ 칸 구조 — 현장 id 5개가 view-safety의 현장 칸 안 · 교육 칸 · 입찰 칸
  const vs28 = sec28('view-safety'), vb28 = sec28('view-bid');
  const bar28 = divBlock28(vs28, '<div class="lsub-bar" id="sfSubBar">'), pSite28 = divBlock28(vs28, '<div class="sf-pane" id="sfPaneSite">'), pEdu28 = divBlock28(vs28, '<div class="sf-pane" id="sfPaneEdu" style="display:none;">');
  const SITE5 = ['siteHead', 'siteAddBtn', 'siteFilterBar', 'siteSearch', 'siteList'];
  T('v428 안전 탭 칸: 칩 줄 sfSubBar(현장 sfChipSite · 교육·검진 sfChipEdu, .lsub-btn) · 현장 칸 sfPaneSite(.sf-pane) 안에 현장 id 5개(siteHead·siteAddBtn·siteFilterBar·siteSearch·siteList, 각 1번) · 교육 칸 sfPaneEdu(.sf-pane, 처음 숨김) 안에 eduHead·eduAddBtn·대상 칩(eduScopeBar 직원 member/일용직 worker)·eduList',
    /<button class="lsub-btn active" data-lsub="site" id="sfChipSite">현장<\/button>/.test(bar28) && /<button class="lsub-btn" data-lsub="edu" id="sfChipEdu">교육·검진<\/button>/.test(bar28)
    && /<div class="sf-pane" id="sfPaneSite">/.test(vs28) && /<div class="sf-pane" id="sfPaneEdu" style="display:none;">/.test(vs28)
    && SITE5.every((id) => pSite28.indexOf('id="' + id + '"') >= 0 && once28(id))
    && ['eduHead', 'eduAddBtn', 'eduScopeBar', 'eduList'].every((id) => pEdu28.indexOf('id="' + id + '"') >= 0 && once28(id))
    && /data-edu-scope="member">직원</.test(pEdu28) && /data-edu-scope="worker">일용직</.test(pEdu28), SITE5.filter((id) => pSite28.indexOf('id="' + id + '"') < 0 || !once28(id)).join(','));
  const bBar28 = divBlock28(vb28, '<div class="lsub-bar" id="bidSubBar">'), bList28 = divBlock28(vb28, '<div id="bidLayerList">'), bOb28 = divBlock28(vb28, '<div id="bidLayerOnbid" style="display:none;">');
  T('v428 입찰 탭 칸: 칩 줄 bidSubBar(공고 list · 부동산 onbid) · 감싸개 bidLayerList 안 bidSection·bidList · bidLayerOnbid(처음 숨김) 안 onbidSection·obHead·obList·obFilterBar·obSearch·obMoreBtn(옛 부동산 화면, 각 1번)',
    /<button class="lsub-btn active" data-lsub="list" id="bidChipList">공고<\/button>/.test(bBar28) && /<button class="lsub-btn" data-lsub="onbid" id="bidChipOnbid">부동산<\/button>/.test(bBar28)
    && bList28.indexOf('id="bidSection"') >= 0 && bList28.indexOf('id="bidList"') >= 0 && once28('bidSection') && once28('bidList') && /<div id="bidLayerOnbid" style="display:none;">/.test(vb28)
    && ['onbidSection', 'obHead', 'obList', 'obFilterBar', 'obSearch', 'obMoreBtn'].every((id) => bOb28.indexOf('id="' + id + '"') >= 0 && once28(id)), '');

  {
    const bChips = [{ a: 'list' }, { a: 'onbid' }].map((x) => { const s = new Set(); return { getAttribute: () => x.a, classList: { toggle: (c, on) => { if (on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c) } }; });
    const BD = { bidSubBar: { querySelectorAll: () => bChips }, bidLayerList: { style: {} }, bidLayerOnbid: { style: {} } };
    const blog = [];
    const bapi = new Function('__D', '__log', ['var document = { getElementById: function(id){ return __D[id] || null; } }; var bidLayer = "list";',
      'function renderBids(){ __log.push("bids"); } function renderOnbid(){ __log.push("onbid"); }', fn28('setBidLayer'), 'return { set: setBidLayer, layer: function(){ return bidLayer; } };'].join('\n'))(BD, blog);
    const bst = () => [bapi.layer(), BD.bidLayerList.style.display === '' ? 'L+' : 'L-', BD.bidLayerOnbid.style.display === '' ? 'O+' : 'O-', bChips[0].classList.contains('active') ? 'c1' : '', bChips[1].classList.contains('active') ? 'c2' : '', blog[blog.length - 1]].join(',');
    bapi.set(''); const b1 = bst(); bapi.set('onbid'); const b2 = bst(); bapi.set('zz'); const b3 = bst();
    T('v428 입찰 칸 전환(setBidLayer 실행): 칸 없음·모르는 칸 = 공고(목록 그림) · onbid = 부동산(온비드 그림) · 칩 active가 따라감 — 사이드바 입찰은 늘 공고부터, 옛 부동산 길은 부동산 칸',
      b1 === 'list,L+,O-,c1,,bids' && b2 === 'onbid,L-,O+,,c2,onbid' && b3 === 'list,L+,O-,c1,,bids', [b1, b2, b3].join(' / '));
  }

  // ④ switchTab 별칭 — tabRoute를 뽑아 실제로 돌린다
  const TA28 = (html.match(/var TAB_ALIAS = \{[^\n]*\};/) || [''])[0];
  const route28 = new Function([TA28, fn28('tabRoute'), 'return tabRoute;'].join('\n'))();
  const R28 = (n) => { const r = route28(n); return r.tab + '|' + r.layer; };
  const cases28 = [['site', 'safety|site'], ['onbid', 'bid|onbid'], ['safety:edu', 'safety|edu'], ['safety:edu:worker', 'safety|edu:worker'], ['safety', 'safety|'], ['site:edu', 'safety|edu'], ['onbid:list', 'bid|list'], ['bid', 'bid|'], ['lic', 'lic|'], ['', 'dash|'], [undefined, 'dash|'], ['constructor', 'constructor|'], ['toString', 'toString|']];
  const bad28 = cases28.filter((c) => R28(c[0]) !== c[1]);
  const swt28 = fn28('switchTab');
  T('v428 switchTab 별칭(tabRoute 실행): site → 안전·현장 · onbid → 입찰·부동산 · "탭:칸" · 적은 칸이 별칭 칸보다 우선 · 빈 값 → 홈 · 객체 원형 이름은 별칭 아님 / switchTab이 맨 앞(currentTab보다 먼저)에서 풀고 안전·입찰은 칸으로 넘김 · 볼 칸 없으면 홈 · 인사 탭에서 교육 목록을 그리지 않음',
    TA28.length > 0 && bad28.length === 0
    && swt28.indexOf('var rt = tabRoute(name);') > 0 && swt28.indexOf('var rt = tabRoute(name);') < swt28.indexOf('currentTab = name;')
    && swt28.indexOf('if (name === "safety" && !safetyPanes().length) name = "dash";') > 0 && swt28.indexOf('if (name === "safety" && !safetyPanes().length) name = "dash";') < swt28.indexOf('currentTab = name;')
    && swt28.indexOf('getElementById("view-safety").classList.toggle("active", name === "safety")') > 0
    && swt28.indexOf('if (name === "safety") setSafetyLayer(rt.layer);') > 0 && swt28.indexOf('if (name === "bid") setBidLayer(rt.layer);') > 0 && swt28.indexOf('renderEdu()') < 0,
    JSON.stringify(bad28.map((c) => [c[0], R28(c[0])])));

  // ⑤ 이동 대상이 전부 실재 — 길 안내 버튼(data-go-tab)·캘린더 go·옛 이름이 있는 뷰와 그 탭의 칸으로 풀린다
  const layers28 = { safety: [...bar28.matchAll(/data-lsub="(\w+)"/g)].map((m) => m[1]), bid: [...bBar28.matchAll(/data-lsub="(\w+)"/g)].map((m) => m[1]) };
  const eduScopes28 = [...pEdu28.matchAll(/data-edu-scope="(\w+)"/g)].map((m) => m[1]);
  // '탭:칸'(+ 교육·검진은 ':대상') 하나가 있는 뷰·그 탭의 칸·교육 대상 칩으로 풀리는지
  const goOk28 = (g) => { const r = route28(g); if (!ids.has('view-' + r.tab)) return false; if (!r.layer) return true; const p = r.layer.split(':'); if ((layers28[r.tab] || []).indexOf(p[0]) < 0) return false; if (p.length === 1) return true; return r.tab === 'safety' && p[0] === 'edu' && p.length === 2 && eduScopes28.indexOf(p[1]) >= 0; };
  const cal28 = fn28('calEvents');
  // v428 검토: '탭:칸' 글자는 기존 2번 검사(switchTab("이름") → view-이름, [\w-]+)에 안 걸린다 — switchTab 글자 호출(" ' 둘 다)과
  //   data-home-go·data-inbox-go·data-cal-go 속성의 칸 형식도 여기서 함께 푼다(11/9 기준 0건 — 앞으로 생기면 safety:sites 같은 오타를 잡는다)
  const colonSw28 = [...html.matchAll(/switchTab\((["'])(\w+:[\w:]+)\1\)/g)].map((m) => m[2]);
  const colonGo28 = [...html.matchAll(/data-(?:home|inbox|cal)-go="(\w+:[\w:]+)"/g)].map((m) => m[1]);
  const goT28 = [...new Set([...[...html.matchAll(/data-go-tab="([\w:]+)"/g)].map((m) => m[1]), ...[...cal28.matchAll(/"(\w+:\w+)"\)/g)].map((m) => m[1]), ...colonSw28, ...colonGo28, 'site', 'onbid'])];
  const badGo28 = goT28.filter((g) => !goOk28(g));
  T('v428 이동 대상 ' + goT28.length + '개(길 안내 data-go-tab·캘린더 go·옛 이름 site/onbid·switchTab 글자와 data-home/inbox/cal-go의 \'탭:칸\' ' + (colonSw28.length + colonGo28.length) + '개)가 전부 있는 뷰·그 탭의 칸·교육 대상 칩으로 풀림 · 길 안내 버튼 3개(인허가 → 안전 › 현장, 인사·직원 → 교육·검진 직원, 인사·일용직 → 교육·검진 일용직, 교육 안내 줄은 처음 숨김 · 인허가 석면 안내는 글 줄이 처음부터 보이고 버튼만 감싸개 asbMovedGo 안) · 일부러 틀린 대상은 안 풀림 · 옛 교육 이력 제목 없음',
    goT28.length >= 5 && badGo28.length === 0 && layers28.safety.join() === 'now,site,edu' && layers28.bid.join() === 'list,onbid' && eduScopes28.join() === 'member,worker'   // v432 안전 칸 = 현황(맨 앞)·현장·교육·검진
    && ['safety:nope', 'safety:edu:boss', 'safety:site:worker', 'safety:now:member', 'nowhere', 'bid:edu'].every((g) => !goOk28(g))
    && /<div class="hw-note" id="asbMovedNote" style="margin-top:22px;">[^<]*<b>안전 › 현장<\/b>[^<]*<span id="asbMovedGo"><button class="mini-btn" id="asbMovedBtn" data-go-tab="safety:site" style="margin-left:6px;">안전 › 현장 열기<\/button><\/span><\/div>/.test(sec28('view-lic'))
    && /id="eduMovedHrBtn" data-go-tab="safety:edu:member"/.test(sec28('view-hr')) && /id="eduMovedWkBtn" data-go-tab="safety:edu:worker"/.test(sec28('view-workers'))
    && /querySelectorAll\("\[data-go-tab\]"\), function\(b\)\{\s*b\.addEventListener\("click", function\(\)\{ switchTab\(b\.getAttribute\("data-go-tab"\)\); \}\);/.test(html)
    && /<div class="hw-note" id="eduMovedHr" style="[^"]*display:none;">/.test(html) && /<div class="hw-note" id="eduMovedWk" style="[^"]*display:none;">/.test(html)
    && sec28('view-hr').indexOf('<h2>교육·건강진단 이력') < 0 && sec28('view-workers').indexOf('<h2>교육·건강진단 이력') < 0,
    '안 풀림: ' + badGo28.join(', ') + ' / 칸 ' + JSON.stringify(layers28));

  // ⑥ 캘린더 이동 대상 — calEvents를 뽑아 실제로 돌린다
  const calApi28 = new Function([
    'var vehicles = [{ no:"12가3456", insp_due:"2026-12-01", ins_due:"2026-12-02", history:[{ kind:"현장", date:"2026-11-20" }] }], licenses = [{ name:"석면해체업", expiry:"2027-01-01", edu_due:"2026-12-10" }], tasks = [{ title:"지시", due:"2026-11-30", status:"open" }], receivables = [{ client:"갑", billed:"2026-11-15", amount:1000 }];',
    'function canSee(){ return true; } function isAdmin(){ return true; } function licVisible(){ return true; } function taskVisible(){ return true; } function recVisible(){ return true; }',
    'function isDate(s){ return /^\\d{4}-\\d{2}-\\d{2}$/.test(s||""); } function fmtAmount(v){ return String(v); } function dispName(n){ return n||""; } function dispNameById(){ return ""; } function memberName(){ return "홍"; }',
    'function liveAsb(){ return [{ title:"남성초", start:"2026-11-20", end:"2026-11-25", status:"plan", site:"포항" }]; } function asbNotifyDue(){ return "2026-11-13"; }',
    'function liveEdu(){ return [{ ptype:"member", pid:"u1", kind:"regular", date:"2026-06-01", next:"2026-12-01" }, { ptype:"worker", pid:"w1", kind:"spec_med", date:"2026-04-01", next:"2027-04-01" }]; } function eduPersonName(){ return "홍"; } function eduKindLabel(){ return "정기교육(근로자)"; }',
    'function liveLeaves(){ return [{ type:"annual", status:"approved", member_id:"u1", start:"2026-11-26", end:"2026-11-26" }]; } function isPartialLeave(){ return false; } function leaveCalVisible(){ return true; } function leaveTypeLabel(){ return "연차"; }',
    fn28('pad'), fn28('fmtDate'), fn28('eachDate'), cal28, 'return calEvents;'].join('\n'))();
  const ev28 = calApi28();
  const isAsb28 = (e) => /🦺|⚠|🧪/.test(e.label);
  const asbEv28 = ev28.filter(isAsb28), eduEv28 = ev28.filter((e) => e.mod === 'hr'), licEv28 = ev28.filter((e) => e.mod === 'lic' && !isAsb28(e));
  T('v428 캘린더 이동(calEvents 실행): 석면 일정 4건(착수·종료·신고 마감·농도측정) go = safety:site · 교육 예정 mod hr go = safety:edu:대상(직원 member·일용직 worker — 그 목록으로 열림) · 그 밖(인허가 2·차량·지시·기성·휴가)은 go 없음(mod 탭) · go 전부 풀림 · 날짜 칸 줄 data-cal-go = go||mod',
    asbEv28.length === 4 && asbEv28.every((e) => e.mod === 'lic' && e.go === 'safety:site') && eduEv28.length === 2 && eduEv28.map((e) => e.go).join() === 'safety:edu:member,safety:edu:worker'
    && licEv28.length === 2 && ev28.filter((e) => e.mod !== 'hr' && !isAsb28(e)).every((e) => e.go === '') && ev28.length === 14 && ev28.filter((e) => e.go).every((e) => goOk28(e.go))
    && fn28('renderCalDay').indexOf('data-cal-go="\'+esc(e.go||e.mod)+\'"') > 0, JSON.stringify(ev28.map((e) => e.mod + ':' + (e.go || '-'))));

  // ⑦ CAL_LABEL이 calEvents의 mod 전부를 덮는다(정적 + 실행) · mod마다 칩·점 색
  const LBL28 = (html.match(/var CAL_LABEL = \{([^}]*)\}/) || ['', ''])[1];
  const labKeys28 = [...LBL28.matchAll(/(\w+)\s*:\s*"/g)].map((m) => m[1]);
  const addMods28 = [...new Set([...cal28.matchAll(/\badd\((?:[^()]|\([^()]*\))*?,\s*"(\w+)"\s*,/g)].map((m) => m[1]))].sort();
  const runMods28 = [...new Set(ev28.map((e) => e.mod))].sort();
  const noLbl28 = [...new Set(addMods28.concat(runMods28))].filter((m) => labKeys28.indexOf(m) < 0);
  const noCss28 = addMods28.filter((m) => !new RegExp('\\.ev-' + m + '\\{background:#[0-9a-fA-F]{6};\\}').test(html) || !new RegExp('\\.dot-' + m + '\\{background:#[0-9a-fA-F]{6};\\}').test(html));
  T('v428 CAL_LABEL이 calEvents의 mod 전부(' + addMods28.join('·') + ')를 덮음 — 교육 hr "교육"(배지 "undefined" 수리) · mod마다 .ev-·.dot- 색(흰 글씨 칩이 안 보이던 것)',
    addMods28.join(',') === 'hr,leave,lic,rec,tasks,veh' && runMods28.join(',') === addMods28.join(',') && noLbl28.length === 0 && /\bhr:"교육"/.test(LBL28) && noCss28.length === 0,
    '라벨 없음: ' + noLbl28.join(',') + ' / 색 없음: ' + noCss28.join(',') + ' / add ' + addMods28.join(',') + ' / 실행 ' + runMods28.join(','));

  // ⑧ CSS — 칸 readonly·칩 숨김·이동 버튼 예외 · 기존 895~899행 묶음과 600행 그대로
  T('v428 CSS: .sf-pane.readonly가 .view.readonly와 같은 5종(add-row·del-x·mini-btn·link-btn·sec-hd-add)을 숨김 · .lsub-btn.perm-hidden · 이동 버튼(data-go-tab)은 보기 권한 화면에서도 보임 · 교육 대상 칩(#eduScopeBar) 켜짐은 옅은 선택 표시(칸 칩 진한 초록과 위계 구분 — 시안 .mchip.on), 공용 .vs-chip.on은 그대로 · 기존 895~899행 묶음(v369 예외 순서 포함)·600행 그대로',
    /\.sf-pane\.readonly \.add-row,\r?\n  \.sf-pane\.readonly \.del-x,\r?\n  \.sf-pane\.readonly \.mini-btn,\r?\n  \.sf-pane\.readonly \.link-btn,\r?\n  \.sf-pane\.readonly \.sec-hd-add\{display:none !important;\}/.test(html)
    && /\.lsub-btn\.perm-hidden\{display:none !important;\}/.test(html) && /\.view\.readonly \.mini-btn\[data-go-tab\]\{display:inline-block !important;\}/.test(html)
    && /\n  #eduScopeBar \.vs-chip\.on\{background:#EAF3EF;color:var\(--brand-dark\);border-color:var\(--brand\);font-weight:700;\}/.test(html) && /\n  \.vs-chip\.on\{background:var\(--brand\);color:#fff;border-color:var\(--brand\);\}/.test(html)
    && /<div class="vs-tools" id="eduScopeBar">/.test(html)
    && /  \.view\.readonly \.add-row,\r?\n  \.view\.readonly \.del-x,\r?\n  \.view\.readonly \.mini-btn,\r?\n  \.view\.readonly \.link-btn\{display:none !important;\}\r?\n  \.view\.readonly \.mini-btn\[data-doc-att-open\]\{display:inline-block !important;\}/.test(html)
    && /\.view\.readonly \.sec-hd-add\{display:none !important;\}/.test(html), '');

  // ⑨ 레지스트리 — site는 칩·칸을 가리키고, MODULES 키마다 탭·뷰 id가 실재
  const MT28 = (html.match(/var MODULE_TAB = \{([^}]+)\}/) || ['', ''])[1], MV28 = (html.match(/var MODULE_VIEW = \{([^}]+)\}/) || ['', ''])[1];
  const modsReg28 = ((html.match(/var MODULES = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, ''));
  const mt28 = {}, mv28 = {};
  [...MT28.matchAll(/(\w+):"(\w+)"/g)].forEach((m) => { mt28[m[1]] = m[2]; });
  [...MV28.matchAll(/(\w+):"([\w-]+)"/g)].forEach((m) => { mv28[m[1]] = m[2]; });
  //   v434(메뉴 56 4-2) hw도 예외 없이 — v431 4-1 동안 두던 'hw는 두 표에 아직 없음' 예외를 걷었다: MODULE_TAB.hw = 사이드바 화관법 탭 버튼(tabHwakwanBtn), MODULE_VIEW.hw = 화관법 화면(view-hwakwan)
  const regBad28 = modsReg28.filter((k) => !ids.has(mt28[k]) || !ids.has(mv28[k]));
  T('v428 레지스트리: MODULE_TAB.site = 현장 칩(sfChipSite) · MODULE_VIEW.site = 현장 칸(sfPaneSite — readonly는 칸에만, 바깥 view-safety엔 안 검) · tabSafetyBtn은 레지스트리 밖 · MODULES ' + modsReg28.length + '키마다 탭·뷰 id 실재(예외 없음 — v434 hw = 화관법 탭 버튼 tabHwakwanBtn·화면 view-hwakwan)',
    mt28.site === 'sfChipSite' && mv28.site === 'sfPaneSite' && MV28.indexOf('view-safety') < 0 && MT28.indexOf('tabSafetyBtn') < 0 && modsReg28.length >= 14 && regBad28.length === 0
    && mt28.hw === 'tabHwakwanBtn' && mv28.hw === 'view-hwakwan',
    '없는 id: ' + regBad28.map((k) => k + '→' + mt28[k] + '/' + mv28[k]).join(', ') + ' / hw ' + mt28.hw + '/' + mv28.hw);

  // ⑩ 안전 탭 칸 판정 — safetyPanes·applySafetyPerms·setSafetyLayer를 뽑아 사람 유형별로 돌린다(권한 키: 현장 = site, 교육·검진 = safety — v430 3단계, 1단계엔 hr)
  //    v430: 두 칩(MODULE_TAB site=sfChipSite·safety=sfChipEdu)은 applyPerms의 MODULES 루프가 숨긴다 — 그 루프 원문을 뽑아 applySafetyPerms 앞에 같이 돌린다(applyPerms와 같은 순서)
  const ap28src = fn28('applyPerms'), ml28i = ap28src.indexOf('MODULES.forEach(function(mod){');
  let ml28j = -1; { let d = 0, st = false; for (let j = ml28i; ml28i >= 0 && j < ap28src.length; j++) { const ch = ap28src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) { ml28j = j; break; } } } }
  if (ml28i < 0 || ml28j < 0 || ap28src.slice(ml28j + 1, ml28j + 3) !== ');') throw new Error('applyPerms MODULES 루프를 못 뽑음');
  const modLoop28 = ap28src.slice(ml28i, ml28j + 1) + ');';
  const regStmt28 = ['var MODULES = \\[[^\\]]+\\];', 'var MODULE_TAB = \\{[^}]+\\};', 'var MODULE_VIEW = \\{[^}]+\\};'].map((re) => { const m = html.match(new RegExp(re)); if (!m) throw new Error('레지스트리 문장 없음: ' + re); return m[0]; });
  const mkC28 = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); return s.has(c); }, contains: (c) => s.has(c) }; };
  const mkE28 = (id, attrs) => ({ id, attrs: attrs || {}, classList: mkC28(), style: {}, getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; }, querySelectorAll: () => [] });
  //    v432: 현황 칩(sfChipNow — 맨 앞, 안전 권한, MODULE_TAB 밖이라 applySafetyPerms가 숨김)·칸(sfPaneNow)을 시험 틀에 싣고, 현황을 열 때 부르는 sfNowOpen은 기록만 하는 가짜(본체 실행은 v432 묶음)
  const runSf28 = (perm, cur, layer) => {
    const chips = [mkE28('sfChipNow', { 'data-lsub': 'now' }), mkE28('sfChipSite', { 'data-lsub': 'site' }), mkE28('sfChipEdu', { 'data-lsub': 'edu' })];
    const D = { tabSafetyBtn: mkE28('tabSafetyBtn'), sfChipNow: chips[0], sfChipSite: chips[1], sfChipEdu: chips[2], sfSubBar: mkE28('sfSubBar'), asbMovedNote: mkE28('asbMovedNote'), asbMovedGo: mkE28('asbMovedGo'), eduMovedHr: mkE28('eduMovedHr'), eduMovedWk: mkE28('eduMovedWk'), sfPaneNow: mkE28('sfPaneNow'), sfPaneSite: mkE28('sfPaneSite'), sfPaneEdu: mkE28('sfPaneEdu') };
    D.sfSubBar.querySelectorAll = () => chips;
    const log = [], pend = [];   // pend = 명부 읽기(loadWorkers)가 끝났을 때 부를 콜백 — 시험이 도착 시점을 고른다
    const api = new Function('__D', '__perm', '__log', '__cur', '__layer', '__pend', [
      'var document = { getElementById: function(id){ return __D[id] || null; } };',
      'var currentTab = __cur, safetyLayer = __layer, eduViewScope = "member";',
      'function permOf(m){ return __perm[m] || "hide"; } function canSee(m){ return permOf(m) !== "hide"; }',
      'function switchTab(n){ __log.push("switch:" + n); }',
      'function renderSites(){ __log.push("renderSites"); } function loadAsb(){ __log.push("loadAsb"); } function loadEdu(){ __log.push("loadEdu"); } function loadWorkers(){ __log.push("loadWorkers"); return { then: function(f){ __pend.push(f); } }; } function renderEdu(){ __log.push("renderEdu:" + eduViewScope); } function sfNowOpen(){ __log.push("sfNowOpen"); }',
      regStmt28.join('\n'), 'function modLoop(){', modLoop28, '}',
      fn28('safetyPanes'), fn28('setSafetyLayer'), fn28('applySafetyPerms'),
      'return { panes: safetyPanes, apply: function(){ modLoop(); applySafetyPerms(); }, set: setSafetyLayer, layer: function(){ return safetyLayer; }, scope: function(){ return eduViewScope; }, cur: function(t){ currentTab = t; } };'].join('\n'))(D, perm, log, cur, layer, pend);
    return { D, log, api, chips, pend };
  };
  // S = 인허가 석면 안내 버튼(감싸개 asbMovedGo) — 글 줄(asbMovedNote)은 따로 본다 · N = 현황 칩(v432)
  const st28 = (r) => (r.D.tabSafetyBtn.classList.contains('perm-hidden') ? 'T-' : 'T+') + (r.D.sfChipNow.classList.contains('perm-hidden') ? 'N-' : 'N+') + (r.D.sfChipEdu.classList.contains('perm-hidden') ? 'E-' : 'E+') + (r.D.sfSubBar.style.display === 'none' ? 'B-' : 'B+')
    + (r.D.asbMovedGo.style.display === 'none' ? 'S-' : 'S+') + ((r.D.eduMovedHr.style.display === 'none' && r.D.eduMovedWk.style.display === 'none') ? 'H-' : ((r.D.eduMovedHr.style.display === '' && r.D.eduMovedWk.style.display === '') ? 'H+' : 'H?'));
  const paneSt28 = (r) => ['sfPaneNow', 'sfPaneSite', 'sfPaneEdu'].map((id) => (r.D[id].style.display === '' ? '+' : '-')).join('') + ' ' + r.chips.map((c) => (c.classList.contains('active') ? '*' : '.')).join('');
  const A28 = runSf28({ site: 'do', safety: 'do', wk: 'do' }, 'dash', 'site'); A28.api.apply();
  const J28 = runSf28({ site: 'do', lic: 'view', wk: 'do' }, 'dash', 'site'); J28.api.apply();
  const K28 = runSf28({ site: 'hide', lic: 'view', wk: 'view' }, 'safety', 'site'); K28.api.apply();
  const A3_28 = runSf28({ site: 'do', safety: 'do' }, 'safety', 'gone'); A3_28.api.apply();
  const A2_28 = runSf28({ site: 'do', safety: 'do' }, 'safety', 'site'); A2_28.api.set('edu');
  const J2_28 = runSf28({ site: 'do' }, 'safety', 'site'); J2_28.api.set('edu');
  const W28 = runSf28({ site: 'do', safety: 'do' }, 'safety', 'site'); W28.api.set('edu:worker');
  const J3_28 = runSf28({ site: 'do' }, 'safety', 'site'); J3_28.api.set('edu:worker');
  const M28 = runSf28({ safety: 'do', lic: 'view', wk: 'view' }, 'safety', 'site'); M28.api.apply();   // v432 권민지형 — 현장 칸에 있었으면 첫 칸(현황)으로
  const A0_28 = runSf28({ site: 'do', safety: 'do' }, 'safety', 'site'); A0_28.api.set('');   // v432 사이드바로 열면(칸 안 고름) 첫 칸 = 현황
  const J0_28 = runSf28({ site: 'do' }, 'safety', 'site'); J0_28.api.set('now');   // v432 현장만 보는 사람이 현황 길로 와도 현장 칸
  const ap28 = fn28('applyPerms');
  T('v428 안전 탭 칸 판정(실행 — v430부터 교육·검진 = safety, 칩은 MODULES 루프 · v432 현황 칩·칸 맨 앞): 관리자 = 탭·현황·교육 칩·칩 줄·안내 전부 · 현장 권한만(김정아·정재욱형) = 탭 보임·현황·교육 칩·칩 줄 숨김(옛 현장 화면 그대로)·교육 안내 숨김, 현황 길로 와도 현장 칸 · 권민지형(안전만) = 탭·현황·교육 칩·칩 줄(칩 2개) 보임·석면 안내 버튼 숨김, 현장 칸에 있었으면 현황으로 · 둘 다 없음(김호태·현장 8명형) = 탭·인허가 석면 안내 버튼 숨김(글 줄은 그대로 — 510ed20과 같음), 안전 탭이면 홈 · 없는 칸·칸 안 고름이면 첫 칸(안전 권한이면 현황 — 현황 칸만 보이고 칩 현황만 켜짐·sfNowOpen 1번) · 교육 칸 요청도 못 보면 현장 칸 · "edu:worker"면 교육 칸 일용직 목록(못 보면 대상도 안 바꿈) / applyPerms가 빈 묶음 숨김보다 먼저 부름 · 부동산 탭 줄 없음',
    JSON.stringify(A28.api.panes()) === '["now","site","edu"]' && st28(A28) === 'T+N+E+B+S+H+'
    && JSON.stringify(J28.api.panes()) === '["site"]' && st28(J28) === 'T+N-E-B-S+H-'
    && JSON.stringify(K28.api.panes()) === '[]' && st28(K28) === 'T-N-E-B-S-H-' && K28.log.indexOf('switch:dash') >= 0
    && JSON.stringify(M28.api.panes()) === '["now","edu"]' && st28(M28) === 'T+N+E+B+S-H+' && M28.api.layer() === 'now' && M28.log.filter((x) => x === 'sfNowOpen').length === 1 && M28.log.indexOf('switch:dash') < 0 && paneSt28(M28) === '+-- *..'
    && [A28, J28, K28, M28].every((r) => r.D.asbMovedNote.style.display !== 'none') && fn28('applySafetyPerms').indexOf('asbMovedNote') < 0
    && A3_28.api.layer() === 'now' && A3_28.log.indexOf('sfNowOpen') >= 0 && A3_28.log.indexOf('renderSites') < 0 && A3_28.log.indexOf('switch:dash') < 0 && paneSt28(A3_28) === '+-- *..'
    && A0_28.api.layer() === 'now' && A0_28.log.join(',') === 'sfNowOpen' && paneSt28(A0_28) === '+-- *..'
    && J0_28.api.layer() === 'site' && J0_28.log.indexOf('sfNowOpen') < 0 && J0_28.log.indexOf('renderSites') >= 0 && paneSt28(J0_28) === '-+- .*.'
    && A2_28.api.layer() === 'edu' && paneSt28(A2_28) === '--+ ..*' && A2_28.log.indexOf('renderEdu:member') >= 0 && A2_28.log.indexOf('loadEdu') >= 0 && A2_28.log.indexOf('sfNowOpen') < 0
    && J2_28.api.layer() === 'site' && paneSt28(J2_28) === '-+- .*.' && J2_28.log.indexOf('renderSites') >= 0 && J2_28.log.indexOf('loadAsb') >= 0
    && W28.api.layer() === 'edu' && W28.api.scope() === 'worker' && W28.log.indexOf('renderEdu:worker') >= 0
    && J3_28.api.layer() === 'site' && J3_28.api.scope() === 'member' && J3_28.log.indexOf('renderSites') >= 0
    && ap28.indexOf('applySafetyPerms();') > 0 && ap28.indexOf('applySafetyPerms();') < ap28.indexOf('빈 그룹 숨김') && ap28.indexOf('"onbid"') < 0 && ap28.indexOf('if (currentTab === "bid" && !isAdmin()) switchTab("dash");') > 0,
    [st28(A28), st28(J28), st28(K28), st28(M28), K28.log.join(','), A3_28.api.layer(), A0_28.api.layer(), J0_28.api.layer(), A2_28.api.layer(), J2_28.api.layer(), paneSt28(A3_28), paneSt28(A2_28)].join(' / '));

  // ⑩-2 (v428 검토) 명부가 교육 기록보다 늦게 오는 경합 — 도착 시점을 시험이 골라 setSafetyLayer를 돌린다
  const nR28 = (r, s) => r.log.filter((x) => x === s).length;
  const fire28 = (r) => r.pend.splice(0).forEach((f) => f());
  const WK1_28 = runSf28({ site: 'do', safety: 'do', wk: 'do' }, 'safety', 'site'); WK1_28.api.set('edu:worker');
  const wk1a28 = nR28(WK1_28, 'renderEdu:worker'), wk1p28 = WK1_28.pend.length; fire28(WK1_28); const wk1b28 = nR28(WK1_28, 'renderEdu:worker');
  const WK2_28 = runSf28({ site: 'do', safety: 'do', wk: 'do' }, 'safety', 'site'); WK2_28.api.set('edu'); WK2_28.api.cur('dash'); fire28(WK2_28);
  const WK3_28 = runSf28({ site: 'do', safety: 'do', wk: 'do' }, 'safety', 'site'); WK3_28.api.set('edu'); WK3_28.api.set('site'); fire28(WK3_28);
  const WK4_28 = runSf28({ site: 'do', safety: 'do' }, 'safety', 'site'); WK4_28.api.set('edu');
  const WK5_28 = runSf28({ site: 'do', wk: 'do' }, 'safety', 'site'); WK5_28.api.set('site');
  T('v428 검토 수리 — 명부가 교육 기록보다 늦게 와도 교육·검진 일용직 이름을 다시 그림(setSafetyLayer 실행, 도착 시점을 시험이 고름): 안전 › 교육·검진(일용직)을 열면 그리고 → 명부 읽기 → 명부가 오면 아직 그 칸이라 한 번 더 그림(\'(삭제된 일용직)\' 잔상 없음) · 그 사이 다른 탭이나 현장 칸으로 갔으면 안 그림 · 일용직 권한 없으면 명부를 안 읽음 · 현장 칸 읽기는 옛 현장 탭 그대로(명부 기다리지 않음)',
    wk1a28 === 1 && wk1p28 === 1 && wk1b28 === 2 && WK1_28.log.indexOf('loadEdu') >= 0
    && nR28(WK2_28, 'renderEdu:member') === 1 && nR28(WK3_28, 'renderEdu:member') === 1 && WK3_28.api.layer() === 'site'
    && WK4_28.log.indexOf('loadWorkers') < 0 && WK4_28.pend.length === 0 && nR28(WK4_28, 'renderEdu:member') === 1
    && WK5_28.log.indexOf('loadWorkers') >= 0 && WK5_28.pend.length === 0 && nR28(WK5_28, 'renderSites') === 1,
    [wk1a28, wk1p28, wk1b28, nR28(WK2_28, 'renderEdu:member'), nR28(WK3_28, 'renderEdu:member'), WK4_28.log.join(','), WK5_28.pend.length].join(' / '));

  // ⑪ 교육·검진 한 목록 — renderEdu를 뽑아 대상 칩별로 돌린다
  const kIdx28 = html.indexOf('var EDU_KINDS'), EDU28 = html.slice(kIdx28, html.indexOf('];', kIdx28) + 2);
  const mkL28 = () => ({ innerHTML: '', textContent: '', querySelectorAll: () => [] });
  const eChips28 = [mkE28('m', { 'data-edu-scope': 'member' }), mkE28('w', { 'data-edu-scope': 'worker' })];
  const ED28 = { eduList: mkL28(), eduHead: mkL28(), eduScopeBar: { querySelectorAll: () => eChips28 } };
  const eduApi28 = new Function('__D', [
    'var document = { getElementById: function(id){ return __D[id] || null; } };',
    'var edu = [{ id:"e1", ptype:"member", pid:"u1", kind:"regular", date:"2026-06-01", next:"2099-12-01" }, { id:"e2", ptype:"worker", pid:"w1", kind:"special", date:"2026-05-01", next:"" }, { id:"e3", ptype:"worker", pid:"w1", kind:"spec_med", date:"2026-04-01", next:"2099-04-01" }];',
    'var workers = [{ id:"w1", name:"김일용" }], members = [{ id:"u1", name:"홍직원" }], eduViewScope = "member";',
    fn28('pad'), fn28('fmtDate'), fn28('todayStr'), fn28('esc'), fn28('addDays'), fn28('isDate'),
    'function findMember(id){ for(var i=0;i<members.length;i++){ if(members[i].id===id) return members[i]; } return null; }',
    'function memberName(id){ var m=findMember(id); return m?m.name:""; } function dispName(n){ return n||""; }',
    EDU28, fn28('eduKindDef'), fn28('eduKindLabel'), fn28('eduPersonName'), fn28('liveEdu'), fn28('renderEduInto'), fn28('renderEdu'),
    'return { render: renderEdu, scope: function(s){ eduViewScope = s; } };'].join('\n'))(ED28);
  eduApi28.render();
  const mH28 = ED28.eduHead.textContent, mL28 = ED28.eduList.innerHTML, mOn28 = eChips28[0].classList.contains('on') && !eChips28[1].classList.contains('on');
  eduApi28.scope('worker'); eduApi28.render();
  const wH28 = ED28.eduHead.textContent, wL28 = ED28.eduList.innerHTML, wOn28 = eChips28[1].classList.contains('on') && !eChips28[0].classList.contains('on');
  T('v428 교육·검진 한 목록(renderEdu 실행): 대상 칩 직원 = 직원 이력만(총 1건) · 일용직 = 일용직 이력만(총 2건) · 칩 on이 따라감 · [+ 이력 추가]는 고른 대상으로(openEdu(null, eduViewScope)) · 칩 배선 · renderEduInto(hostId, headId, scope) 모양 그대로',
    mH28 === '총 1건' && mL28.indexOf('홍직원') >= 0 && mL28.indexOf('김일용') < 0 && mOn28
    && wH28 === '총 2건' && wL28.indexOf('김일용') >= 0 && wL28.indexOf('홍직원') < 0 && wOn28
    && /function renderEduInto\(hostId, headId, scope\)\{/.test(html) && /getElementById\("eduAddBtn"\)\.addEventListener\("click", function\(\)\{ openEdu\(null, eduViewScope\); \}\);/.test(html)
    && /querySelectorAll\("#eduScopeBar \[data-edu-scope\]"\)/.test(html) && /querySelectorAll\("#sfSubBar \.lsub-btn"\)/.test(html) && /querySelectorAll\("#bidSubBar \.lsub-btn"\)/.test(html),
    [mH28, wH28, mOn28, wOn28].join(' / '));

  // ⑫ 도움말·MANUAL 1절 4묶음 = 사이드바(라벨을 사이드바에서 뽑아 대조) · 옛 위치 문장 0 · sw ≥ 428
  const grp28 = {}; let g28 = '';
  nav28.split('\n').forEach((ln) => { const gm = ln.match(/<div class="nav-group">([^<]+)<\/div>/); if (gm) { g28 = gm[1]; grp28[g28] = []; return; } const bm = ln.match(/<button class="tab-btn[^"]*" data-tab="[\w-]+" id="\w+">([^<]+?)\s*(?:<span|<\/button>)/); if (bm && g28) grp28[g28].push(bm[1].trim()); });
  const help28 = html.slice(html.indexOf('<div class="modal-backdrop" id="helpBackdrop">'), html.indexOf('id="helpClose"'));
  const man1_28 = man28.slice(man28.indexOf('<h2 id="s1">'), man28.indexOf('<h2 id="s2">'));
  const helpLn28 = (g) => { const m = help28.match(new RegExp('<b>' + g + '</b>: ([^<]+)<br>')); return m ? m[1].replace(/\([^)]*\)/g, '').trim() : ''; };
  const manLn28 = (g) => { const m = man1_28.match(new RegExp('<li><b>' + g + '</b> — ([^<]+)</li>')); return m ? m[1].trim() : ''; };
  const G4_28 = ['관리', '수주', '업무', '개인'];
  const helpBad28 = G4_28.filter((g) => !grp28[g] || helpLn28(g) !== grp28[g].join(' / ')), manBad28 = G4_28.filter((g) => !grp28[g] || manLn28(g) !== grp28[g].join(' / '));
  const OLDMAN28 = ['온비드 물건은 부동산 탭에 따로 모입니다', '현장 탭에 <b>미이수</b>', '인사·직원 탭(직원 대상)과 인사·일용직 탭(일용직 대상) 아래에 있습니다', '<h2 id="s12">12. 부동산', '<h2 id="s28">28. 현장', '홍보 / 부동산', '운반일지 / 현장 /', '>부동산 (온비드)</a>', '>현장 — 석면·철거·준설 대장</a>'];
  const oldMan28 = OLDMAN28.filter((s) => man28.indexOf(s) >= 0);
  T('v428 도움말·MANUAL 1절 4묶음 = 사이드바 라벨 그대로(관리 6 · 수주 4 · 업무 7 · 개인 3 — 수주 입찰/계약/견적서/홍보 · 업무 …/운반일지/안전/인허가/문서함 · 개인 물어보기/내 업무/휴가) · 탭 안 칸 안내(입찰 = 공고/부동산, 안전 = 현장/교육·검진) · MANUAL 12·28·21-9절 새 자리 · 옛 위치 문장 0 · sw ≥ 428',
    G4_28.map((g) => (grp28[g] || []).length).join(',') === '6,4,7,3' && grp28['수주'].join('/') === '입찰/계약/견적서/홍보' && grp28['업무'].join('/') === '캘린더/차량/화관법/운반일지/안전/인허가/문서함' && grp28['개인'].join('/') === '물어보기/내 업무/휴가'
    && helpBad28.length === 0 && manBad28.length === 0 && help28.indexOf('<b>입찰</b> = 공고 / 부동산, <b>안전</b> = 현황 / 현장 / 교육·검진') > 0 && man1_28.indexOf('<b>입찰</b> = 공고 / 부동산, <b>안전</b> = 현황 / 현장 / 교육·검진') > 0   // v432 안전 칸에 현황(맨 앞)
    && help28.indexOf('홍보 / 부동산') < 0 && help28.indexOf('운반일지 / 현장 /') < 0 && oldMan28.length === 0
    && man28.indexOf('<h2 id="s12">12. 입찰 › 부동산 (온비드)') > 0 && man28.indexOf('<h2 id="s28">28. 안전 › 현장 — 석면·철거·준설 대장') > 0 && man28.indexOf('<h3>21-9. 교육·건강진단 이력 (안전 › 교육·검진)</h3>') > 0
    && Number((sw28.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 428,
    '도움말 어긋남: ' + helpBad28.map((g) => g + '[' + helpLn28(g) + ' ≠ ' + (grp28[g] || []).join(' / ') + ']').join(' ') + ' / MANUAL 어긋남: ' + manBad28.join(',') + ' / MANUAL 옛 문장: ' + oldMan28.join(' | '));
} catch (e) { console.log('  (v428 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v429(11/9 메뉴 56 2단계, PM "56. ㄱ"): 작은 정리 — 직원 화면 변화 없음. 권한 키 등록·서버 동작은 그대로(3·4단계 일).
//      ① 현장 대장 판정 canSee('lic') 6곳 → canSee('site')(서버 col:asbestos = site라 이미 403) — 캘린더 석면 일정의 배지·점(mod lic)은 그대로(PM 시안 결정 대기)
//      ② 권한 열 순서 한 벌(PERM_ORDER = 사이드바 순서 — 인사 카드 숨김 블록의 두 번째 순서 permOrder를 지우고 permModList) ③ 쓰지 않는 TAB_LABELS 삭제
//      ④ 관리자 홈 KPI '결재 대기' → '승인 대기'(값은 approvalInboxItems 수 그대로). 판정은 index.html에서 함수를 뽑아 권한별로 실제로 돌려 본다.
//      검토 반영(같은 커밋): csSiteDone 쓰기 판정 = 현장 수행(canDo site) · 그대로 둘 인허가 판정 3줄 고정 · [대장 연결] 안내 '(현장)' · 열 순서 엄격 증가(같은 탭 짝은 3단계 safety>site만) · MANUAL 15·28절 문장
try {
  const fn29 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const sw29 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), man29 = readFileSync(join(ROOT, 'MANUAL.html'), 'utf8');
  const LIC29 = /canSee\(\s*["']lic["']\s*\)/g, SITE29 = /canSee\(\s*["']site["']\s*\)/g;
  const cnt29 = (s, re) => (s.match(re) || []).length;
  const permStub29 = 'function canSee(m){ return (__perm[m] || "hide") !== "hide"; } function canDo(m){ return __perm[m] === "do"; }';

  // ① 현장 대장 판정 6곳 — 네 함수에 canSee('lic') 0 · canSee('site') 자리 수 그대로 · 캘린더는 석면 블록만 site(인허가 만료·교육 줄은 lic 그대로)
  const SITE6_29 = { csLinkSiteLater: 1, csSiteDone: 1, csLinksHtml: 2, loadAsb: 1 };
  const siteBad29 = Object.keys(SITE6_29).filter((f) => { const s = fn29(f); return cnt29(s, LIC29) !== 0 || cnt29(s, SITE29) !== SITE6_29[f]; });
  const cal29 = fn29('calEvents');
  const calAsbOk29 = /if \(canSee\("site"\)\) liveAsb\(\)\.forEach\(function\(r\)\{/.test(cal29) && /if \(canSee\("lic"\)\) licenses\.forEach\(/.test(cal29) && cnt29(cal29, LIC29) === 1 && cnt29(cal29, SITE29) === 1;
  // 파일 전체: canSee('lic')가 남은 줄은 인허가 줄뿐 — 현장 대장 낱말(asb·Asb·Sites·site_id·현장 대장)과 같은 줄에 없음
  //   v432: 안전 › 현황 구간(// @safety-now-start ~ end)의 블록 권한 줄(sfNowSee — ③ 의무 대장·⑤ 인정·평가 = 인허가 권한)은 v432 묶음 ①-2가 따로 센다(구간 안 1줄·현장 대장 낱말 0).
  //   여기 '3줄'은 구간 밖만 센다 — 낱말 검사(licLeak29)는 종전대로 파일 전체 줄을 본다
  const sfn29a = html.indexOf('// @safety-now-start'), sfn29b = html.indexOf('// @safety-now-end');
  const html29x = (sfn29a >= 0 && sfn29b > sfn29a) ? html.slice(0, sfn29a) + html.slice(sfn29b) : html;
  const licLines29 = html29x.split('\n').filter((ln) => /canSee\(\s*["']lic["']\s*\)/.test(ln));
  const licLeak29 = html.split('\n').filter((ln) => /canSee\(\s*["']lic["']\s*\)/.test(ln)).filter((ln) => /asb|Asb|Sites|site_id|현장 대장/.test(ln));
  // 그대로 둘 인허가 판정 3줄 = 캘린더 인허가 만료·교육 · 홈 만기(seeLic) · 전역 검색 인허가 — lic → site 바꾸기가 너무 넓게 번지는 실수를 막는다(v429 검토)
  const licKeep29 = /seeLic = canSee\("lic"\)/.test(fn29('renderDashboard')) && /add\("lic","인허가",canSee\("lic"\)/.test(html);
  // [대장 연결] 안내의 noperm 문구도 현장 권한으로(지금은 닿지 않는 갈래 — csLinkSiteLater가 canDo("site")를 먼저 본다)
  const alert29 = html.indexOf('현장 대장 열람 권한(인허가)') < 0 && html.indexOf('"현장 대장 열람 권한(현장)이 없어 연결할 수 없습니다."') > 0;
  T('v429 현장 대장 판정 6곳(calEvents 석면 일정 · csLinkSiteLater · csSiteDone · csLinksHtml 문구·[대장 연결] · loadAsb) = canSee("site"), canSee("lic") 0곳(서버 col:asbestos = site) · 캘린더 인허가 만료·교육 줄만 lic 그대로 · 파일 전체 lic 판정 3줄(캘린더 인허가 · 홈 seeLic · 전역 검색 인허가 — 지금 ' + licLines29.length + '줄)에 현장 대장 낱말 0 · [대장 연결] 안내 "열람 권한(현장)"',
    siteBad29.length === 0 && calAsbOk29 && licLeak29.length === 0 && licLines29.length === 3 && licKeep29 && alert29,
    '어긋난 함수: ' + siteBad29.join(',') + ' / 캘린더 ' + calAsbOk29 + ' / lic 줄 ' + licLines29.length + ' · 그대로 둘 줄 ' + licKeep29 + ' / 안내 ' + alert29 + ' / 새는 줄: ' + licLeak29.map((s) => s.trim().slice(0, 90)).join(' | '));

  // ① 실행 — calEvents·loadAsb를 뽑아 권한별로 돌린다(현장 보기만 / 인허가만 / 둘 다 / 없음)
  const calRun29 = (perm) => new Function('__perm', [
    'var vehicles = [], tasks = [], receivables = [], licenses = [{ name:"석면해체업", expiry:"2027-01-01", edu_due:"2026-12-10" }];',
    permStub29, 'function isAdmin(){ return false; } function licVisible(){ return true; } function taskVisible(){ return true; } function recVisible(){ return true; }',
    'function isDate(s){ return /^\\d{4}-\\d{2}-\\d{2}$/.test(s||""); } function fmtAmount(v){ return String(v); } function dispName(n){ return n||""; } function dispNameById(){ return ""; } function memberName(){ return ""; }',
    'function liveAsb(){ return [{ title:"남성초", start:"2026-11-20", end:"2026-11-25", status:"plan", site:"포항" }]; } function asbNotifyDue(){ return "2026-11-13"; }',
    'function liveEdu(){ return []; } function eduPersonName(){ return ""; } function eduKindLabel(){ return ""; }',
    'function liveLeaves(){ return []; } function isPartialLeave(){ return false; } function leaveCalVisible(){ return false; } function leaveTypeLabel(){ return ""; }',
    fn29('pad'), fn29('fmtDate'), fn29('eachDate'), cal29, 'return calEvents();'].join('\n'))(perm);
  const isAsb29 = (e) => /🦺|⚠|🧪/.test(e.label);
  const nAsb29 = (ev) => ev.filter(isAsb29).length, nLic29 = (ev) => ev.filter((e) => e.mod === 'lic' && !isAsb29(e)).length;
  const cS29 = calRun29({ site: 'view' }), cL29 = calRun29({ lic: 'do' }), cB29 = calRun29({ site: 'do', lic: 'view' }), cN29 = calRun29({});
  const asbLoad29 = (perm) => { const calls = []; new Function('__perm', '__calls', [permStub29,
    'function gwCall(fn, body){ __calls.push(fn + ":" + body.action + ":" + body.collection); return { then: function(){ return { catch: function(){} }; } }; }',
    fn29('loadAsb'), 'loadAsb();'].join('\n'))(perm, calls); return calls.join(','); };
  const la29 = [asbLoad29({ site: 'view' }), asbLoad29({ lic: 'do' }), asbLoad29({ site: 'hide', lic: 'view' }), asbLoad29({ site: 'do', lic: 'hide' })];
  T('v429 현장 대장 판정 실행(calEvents·loadAsb를 뽑아 권한별로 돌림): 현장 보기만·인허가 숨김(1단계 남은 걱정 "안전 › 현장 목록이 비어 보임"의 사람) = 대장을 읽고(gw-data get asbestos) 석면 일정 4건 · 인허가만(권민지형) = 대장을 안 읽고 석면 일정 0·인허가 일정 2 · 둘 다(김정아·정재욱형) = 4+2, 석면 배지·점 mod lic·이동 safety:site 그대로 · 없음 = 0',
    nAsb29(cS29) === 4 && nLic29(cS29) === 0 && nAsb29(cL29) === 0 && nLic29(cL29) === 2 && nAsb29(cB29) === 4 && nLic29(cB29) === 2 && cN29.length === 0
    && cB29.filter(isAsb29).every((e) => e.mod === 'lic' && e.go === 'safety:site')
    && la29[0] === 'gw-data:get:asbestos' && la29[1] === '' && la29[2] === '' && la29[3] === 'gw-data:get:asbestos',
    JSON.stringify({ cal: [cS29, cL29, cB29, cN29].map((ev) => nAsb29(ev) + '+' + nLic29(ev)), load: la29 }));

  // ① 실행 — 계약 연결 탭(csLinkSiteLater·csSiteDone·csLinksHtml): 대장을 못 받은 기기에서 현장 권한이면 받아서 연결
  const csl29 = (perm) => { const log = []; const r = new Function('__perm', '__log', ['var asbLoaded = false, csSiteLinkQueue = {};', permStub29,
    'function csSiteKindOf(){ return "asbestos"; } function findAsb(){ return null; } function loadAsb(){ __log.push("loadAsb"); } function csLinkSite(){ __log.push("link"); return null; }',
    fn29('csLinkSiteLater'), 'return csLinkSiteLater({ id:"c1", type:"asbestos" });'].join('\n'))(perm, log); return r + (log.length ? '+' + log.join('+') : ''); };
  const csd29 = (perm) => { const log = []; const r = new Function('__perm', '__log', ['var asbLoaded = false;', permStub29,
    'function findAsb(){ return null; } function loadAsb(){ __log.push("loadAsb"); }',
    fn29('csSiteDone'), 'return csSiteDone({ id:"c1", scen:"asbestos:pub", site_id:"a1", status:"done" });'].join('\n'))(perm, log); return r + (log.length ? '+' + log.join('+') : ''); };
  const clh29 = (perm) => new Function('__perm', ['var asbLoaded = false;', permStub29,
    'function csRec(){ return null; } function fmtAmount(v){ return String(v); } function findAsb(){ return null; } function csSiteKindOf(){ return "asbestos"; }',
    fn29('esc'), fn29('csLinksHtml'), 'return csLinksHtml({ id:"c1", type:"asbestos", pipes:[] });'].join('\n'))(perm);
  const cl29 = [csl29({ site: 'do' }), csl29({ site: 'do', lic: 'do' }), csl29({ lic: 'do' }), csl29({ site: 'view', lic: 'do' })];
  const cd29 = [csd29({ site: 'do' }), csd29({ site: 'view' }), csd29({ lic: 'do' })];
  const hS29 = clh29({ site: 'do' }), hL29 = clh29({ site: 'view', lic: 'do' });
  T('v429 계약 연결 탭 실행(csLinkSiteLater·csSiteDone·csLinksHtml): 대장을 아직 못 받은 기기 — 현장 수행·인허가 숨김이어도 대장을 받아 연결 큐에("wait", 종전 lic 판정이면 "noperm") · 종결 훅도 대장을 받으러 감 · 연결 탭 "대장을 아직 불러오지 않음" + [대장 연결] / 현장 권한이 수행이 아니면 건너뜀·버튼 없음·"현장 권한 필요"',
    cl29.join(',') === 'wait+loadAsb,wait+loadAsb,skip,skip' && cd29.join(',') === 'false+loadAsb,false+loadAsb,false'
    && hS29.indexOf('대장을 아직 불러오지 않음') >= 0 && hS29.indexOf('data-cs-site="c1"') >= 0 && hL29.indexOf('연결 없음(현장 권한 필요)') >= 0 && hL29.indexOf('data-cs-site=') < 0,
    JSON.stringify({ link: cl29, done: cd29, html: [hS29.indexOf('data-cs-site="c1"') >= 0, hL29.indexOf('현장 권한 필요') >= 0] }));

  // ① 실행(v429 검토) — csSiteDone 쓰기 판정: 대장을 받은 기기(①로 현장 보기만 있어도 받는다)에서 행을 찾았을 때 대장 종결·실적 초안·site_hook은 현장 수행만
  const csdW29 = (perm, del) => { const log = [], row = { id: 'a1', kind: 'asbestos', title: '남성초', status: 'run' }, c = { id: 'c1', type: 'asbestos', scen: 'asbestos:pub', site_id: 'a1', status: 'done' };
    if (del) row.del = 1;
    const r = new Function('__perm', '__log', '__row', '__c', ['var asbLoaded = true;', permStub29,
      'var CON_SITE_BIZ = { asbestos:"비계ㆍ구조물해체공사업" }, CON_SITE_CORP = { asbestos:"주식회사 종운건설" };',
      'function findAsb(){ return __row; } function loadAsb(){ __log.push("loadAsb"); } function conAmtEff(){ return 1000; } function csSiteKindOf(){ return "asbestos"; } function todayStr(){ return "2026-11-09"; }',
      'function scheduleAsbSave(){ __log.push("asbSave"); } function scheduleContractSave(){ __log.push("conSave"); }',
      fn29('csSiteDone'), 'return csSiteDone(__c);'].join('\n'))(perm, log, row, c);
    return [r, row.status, c.site_hook || '-', (row.ks && row.ks.draft) ? 'draft' : '-', log.join('+') || '-'].join('/'); };
  const cw29 = [csdW29({ site: 'do', con: 'do' }), csdW29({ site: 'view', con: 'do' }), csdW29({ site: 'view', con: 'do' }, true), csdW29({ site: 'do', con: 'do' }, true)];
  T('v429 검토 csSiteDone 쓰기 판정(대장을 받은 기기에서 실행): 현장 수행 = 대장 종결·실적 초안·site_hook(대장·계약 저장) · 현장 보기 + 계약 수행 = 아무것도 안 씀(서버는 보기 권한의 대장 저장을 NO_WRITE로 거절 — 계약에만 site_hook이 남아 다시 안 도는 어긋남 차단, 현장 수행 기기가 loadAsb 뒤 csSiteHooksRetry로 처리) · 삭제된 대장의 "none" 표식도 현장 수행만',
    cw29.join(',') === 'true/done/2026-11-09/draft/asbSave+conSave,false/run/-/-/-,false/run/-/-/-,false/run/none/-/conSave',
    JSON.stringify(cw29));

  // ② 권한 열 순서 한 벌 = 사이드바 순서 — 모듈마다 사이드바 탭으로 풀어(site는 안전 탭 안 현장 칩) 순서를 대조, 인사 카드 숨김 블록은 뽑아서 돌림
  const nav29 = html.slice(html.indexOf('<nav class="tabbar" id="tabbar">'), html.indexOf('</nav>'));
  const navBtn29 = [...nav29.matchAll(/data-tab="([\w-]+)" id="(\w+)"/g)].map((m) => ({ tab: m[1], id: m[2] }));
  const MT29 = {}; [...((html.match(/var MODULE_TAB = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+):"(\w+)"/g)].forEach((m) => { MT29[m[1]] = m[2]; });
  const views29 = [...html.matchAll(/<section class="view" id="view-([\w-]+)">/g)].map((m) => m[1]);
  const secOf29 = (t) => { const i = html.indexOf('<section class="view" id="view-' + t + '">'); return html.slice(i, html.indexOf('</section>', i)); };
  //   v434(메뉴 56 4-2): hw도 다른 키처럼 MODULE_TAB(tabHwakwanBtn)으로 사이드바 자리를 푼다 — v431 4-1 동안 두던 'hw는 화관법 탭으로 직접 풀이' 줄은 걷었다(MODULE_TAB이 없는 키는 '' → 자리 -1로 실패)
  const tabOf29 = (k) => { const id = MT29[k]; if (!id) return ''; const b = navBtn29.find((x) => x.id === id); if (b) return b.tab; return views29.find((t) => secOf29(t).indexOf('id="' + id + '"') >= 0) || ''; };
  const PO29 = ((html.match(/var PERM_ORDER = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, ''));
  const pos29 = PO29.map((k) => navBtn29.findIndex((x) => x.tab === tabOf29(k)));
  // 사이드바 자리는 엄격히 증가 — 같은 탭으로 풀리는 열은 허용한 짝만(v429 검토: 종전 '같은 탭 1쌍 허용'은 아무 짝이나 통과시켜, 인허가가 안전 탭으로 풀리는 결함도 놓쳤다).
  //   허용 짝 = 3단계 계획(코드 지도 code.steps[2]): 안전(safety — MODULE_TAB sfChipEdu)·현장(site — sfChipSite) 열은 둘 다 안전 탭 안 칩이라 같은 자리로 풀린다 — 안전 열이 현장 열 바로 앞
  const SAME29 = { 'safety>site': 1 };
  const same29 = pos29.map((p, i) => (i > 0 && p >= 0 && p === pos29[i - 1]) ? PO29[i - 1] + '>' + PO29[i] : '').filter(Boolean);
  const mono29 = pos29.every((p, i) => p >= 0 && (i === 0 || p > pos29[i - 1] || (p === pos29[i - 1] && SAME29[PO29[i - 1] + '>' + PO29[i]] === 1)));
  const codeOnly29 = html.split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');
  const ome29 = fn29('openMemberEdit');
  const pI29 = ome29.indexOf('var manageMods'), pJ29 = ome29.indexOf('}).join("");', pI29);
  const permSnip29 = (pI29 >= 0 && pJ29 > pI29) ? ome29.slice(pI29, pJ29 + '}).join("");'.length) : '';
  const stmt29 = (re) => (html.match(re) || [''])[0];
  const D29 = { mePerms: { innerHTML: '' } };
  new Function('__D', ['var document = { getElementById: function(id){ return __D[id] || null; } };',
    stmt29(/var MODULES = \[[^\]]+\];/), stmt29(/var PERM_ORDER = \[[^\]]+\];/), stmt29(/var MOD_LABEL = \{[^}]+\};/), fn29('permModList'),
    'var perms = {};', permSnip29].join('\n'))(D29);
  const meRows29 = [...D29.mePerms.innerHTML.matchAll(/<div class="perm-divider"><\/div>|data-perm="(\w+)"/g)].map((m) => m[1] || '|');
  const mg29 = nav29.slice(nav29.indexOf('<div class="nav-group">관리</div>'), nav29.indexOf('<div class="nav-divider">'));
  const mgTabs29 = [...mg29.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const mgMods29 = PO29.filter((k) => mgTabs29.indexOf(tabOf29(k)) >= 0);
  const wantRows29 = mgMods29.concat(['|'], PO29.filter((k) => mgMods29.indexOf(k) < 0));
  const ML29 = {}; [...stmt29(/var MOD_LABEL = \{[^}]+\};/).matchAll(/(\w+):"([^"]+)"/g)].forEach((m) => { ML29[m[1]] = m[2]; });
  const manCols29 = PO29.map((k) => ML29[k]).join(' / ');
  T('v429 권한 열 순서 한 벌 = 사이드바 순서(' + PO29.join('·') + '): 모듈마다 사이드바 탭으로 풀리고(site = 안전 탭 안 현장 칩) 사이드바 자리가 엄격히 증가(같은 탭 짝은 3단계 safety>site만 — 지금 ' + (same29.join('·') || '0') + ') · PERM_ORDER를 쓰는 코드는 permModList 하나(권한관리 표·인사 카드) · 인사 카드 숨김 블록(openMemberEdit 실행) = 같은 순서 + 관리 묶음(' + mgMods29.join('·') + ') 뒤 구분선 1개 · MANUAL 21-2 열 목록 = 같은 순서',
    PO29.length >= 12 && mono29 && same29.every((s) => SAME29[s] === 1) && new Set(pos29).size === PO29.length - same29.length && (codeOnly29.match(/\bPERM_ORDER\b/g) || []).length === 2 && /function permModList\(\)\{ return PERM_ORDER\.filter\(/.test(html)
    && /var mods = permModList\(\);/.test(fn29('renderPermMgmt')) && /getElementById\("mePerms"\)\.innerHTML = permModList\(\)\.map\(/.test(ome29)
    && meRows29.join(',') === wantRows29.join(',') && mgMods29.join(',') === 'tasks,rec,cli,wk' && man29.indexOf('표의 열은 사이드바 순서와 같습니다 — ' + manCols29 + '.') > 0,
    'PERM_ORDER ' + PO29.join(',') + ' → 사이드바 자리 ' + pos29.join(',') + ' (같은 탭 짝 ' + (same29.join(',') || '없음') + ') / 인사 카드 ' + meRows29.join(',') + ' (기대 ' + wantRows29.join(',') + ') / MANUAL 열 ' + manCols29);

  T('v429 쓰지 않는 상수·두 번째 순서 0곳: TAB_LABELS(부동산 onbid 잔재 포함) · permOrder 없음',
    html.indexOf('TAB_LABELS') < 0 && !/\bpermOrder\b/.test(html) && !/onbid:"부동산"/.test(html), '');

  // ④ 관리자 홈 KPI 이름 — 값은 그대로(승인 대기함과 같은 수)
  const rd29 = fn29('renderDashboard');
  T('v429 관리자 홈 KPI 이름 "승인 대기"(종전 "결재 대기") — 값은 그대로 approvalInboxItems 수(아래 승인 대기함 머리 숫자와 같음) · 대표 결재함 배지(🧾 aria-label 결재 대기)는 그대로',
    /tiles \+= '<div class="stat-tile"><div class="lbl">승인 대기<\/div><div class="val">' \+ reviewCount \+ '<span class="unit">건<\/span><\/div><\/div>';/.test(rd29)
    && /var inbox = approvalInboxItems\(\);\s*\n\s*var reviewCount = inbox\.length;/.test(rd29) && /승인 대기함 <span class="cnt">' \+ inbox\.length/.test(rd29)
    && html.indexOf('<div class="lbl">결재 대기</div>') < 0 && /aria-label="결재 대기"/.test(html), '');

  T('v429 주석 정리: CSS "폰(859px 이하)=☰ 세로 목록, PC=좌측 사이드바"(옛 "모바일=상단 탭" 없음) · gw-data COL 주석 asbestos = 현장 대장(안전 › 현장, site 권한, 30년 보존), "lic 권한을 공유" 없음 · 매핑 asbestos:\'site\' 그대로 · sw ≥ 429',
    html.indexOf('/* 반응형: 폰(859px 이하)=☰ 세로 목록, PC=좌측 사이드바 */') > 0 && html.indexOf('모바일=상단 탭') < 0
    && gwd.indexOf('asbestos=현장 대장(안전 › 현장, site 권한, 30년 보존') > 0 && gwd.indexOf('lic 권한을 공유') < 0 && /asbestos: 'site'/.test((gwd.match(/const COL = \{([^}]+)\}/) || ['', ''])[1])
    && Number((sw29.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 429, '');

  // MANUAL 15·28절 — 캘린더 현장 일정 = 현장 권한(①로 옛 문장 "인허가 권한이 있는 분에게만"이 틀린 말이 되어 고침 — 되돌림 방지, v429 검토). 15절 괄호는 목록 머리(네 일정 모두)에
  const man15_29 = man29.slice(man29.indexOf('<h2 id="s15">'), man29.indexOf('<h2 id="s16">'));
  const man28_29 = man29.slice(man29.indexOf('<h2 id="s28">'), man29.indexOf('<h2 id="s29">'));
  T('v429 MANUAL 15·28절 캘린더 현장 일정 = 현장 권한: 15절 "작업 일정(현장 권한이 있는 분만) — 착수·종료 · 작업신고 마감 · 농도측정"(괄호가 네 일정 모두에 걸림) · 28절 "캘린더 표시도 이 칸과 같은 현장 권한으로 정해지고(인허가 권한과 따로)" · 옛 문장 "캘린더 표시는 인허가 권한이 있는 분에게만" 0',
    man15_29.indexOf('<li>현장 대장(안전 › 현장)의 작업 일정(현장 권한이 있는 분만) — 착수·종료 🦺, 작업신고 마감 ⚠, 농도측정 🧪</li>') > 0
    && man28_29.indexOf('캘린더 표시도 이 칸과 같은 현장 권한으로 정해지고(인허가 권한과 따로), 캘린더에서 누르면 이 칸이 열립니다.') > 0
    && man29.indexOf('캘린더 표시는 인허가 권한이 있는 분에게만') < 0, '');
} catch (e) { console.log('  (v429 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v430(11/9 메뉴 56 3단계, PM "56. ㄱ"): 새 권한 '안전'(safety) 등록 — 앱 7곳·서버 6곳 한 커밋, 교육 기록(col:edu) 키 hr → safety.
//      기본 숨김 자리가 빠지면 직원 건강진단 날짜가 열린다(gw-data PERM_CLOSED = 키 없는 회원(배포 직후 전원)의 읽기가 바로 · gw-auth CLOSED_DEFAULT = 저장 때 cleanPerms가 '보기'를 채움, 9/10 site 선례) — 자리끼리 대조하고,
//      판정(applyPerms 전체·calEvents·loadEdu·교육 쓰기 3함수·doSaveEdu·pmVal·gw-auth cleanPerms)은 원문을 뽑아 사람 유형별로 실제로 돌린다.
try {
  const fn30 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const sw30 = readFileSync(join(ROOT, 'sw.js'), 'utf8'), man30 = readFileSync(join(ROOT, 'MANUAL.html'), 'utf8'), cl30 = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const ask30 = readFileSync(join(ROOT, 'netlify/functions/_lib/ask.js'), 'utf8'), gd30 = readFileSync(join(ROOT, 'netlify/functions/gw-data.js'), 'utf8');
  const keys30 = (src, re) => { const m = src.match(re); return m ? [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]).sort() : []; };
  const list30 = (src, re, q) => { const m = src.match(re); return m ? (m[1].match(new RegExp(q + '(\\w+)' + q, 'g')) || []).map((s) => s.split(q).join('')) : []; };
  const regStmt30 = ['var MODULES = \\[[^\\]]+\\];', 'var MODULE_TAB = \\{[^}]+\\};', 'var MODULE_VIEW = \\{[^}]+\\};'].map((re) => { const m = html.match(new RegExp(re)); if (!m) throw new Error('레지스트리 문장 없음: ' + re); return m[0]; });

  // ① 기본 숨김 4곳 = 같은 집합(safety 포함) — 종전 대조는 3곳뿐이었고 cleanPerms가 실제로 쓰는 gw-auth CLOSED_DEFAULT가 빠져 있었다
  const c4_30 = { '앱 PERM_CLOSED': keys30(html, /var PERM_CLOSED = \{([^}]+)\}/), 'gw-data PERM_CLOSED': keys30(gd30, /const PERM_CLOSED = \{([^}]+)\}/), 'gw-auth CLOSED_DEFAULT': keys30(auth, /const CLOSED_DEFAULT = \{([^}]+)\}/), '_lib/ask.js PERM_CLOSED': keys30(ask30, /const PERM_CLOSED = \{([^}]+)\}/) };
  const c4v30 = Object.values(c4_30).map((a) => a.join(','));
  T('v430 기본 숨김 4곳(앱 PERM_CLOSED · gw-data PERM_CLOSED · gw-auth CLOSED_DEFAULT(cleanPerms가 저장 때 쓰는 곳) · _lib/ask.js PERM_CLOSED) = 같은 집합 · safety·site·lic·hw(v431) 포함',
    c4v30.every((s) => s.length > 0 && s === c4v30[0]) && c4_30['앱 PERM_CLOSED'].indexOf('safety') >= 0 && c4_30['앱 PERM_CLOSED'].indexOf('site') >= 0 && c4_30['앱 PERM_CLOSED'].indexOf('lic') >= 0 && c4_30['앱 PERM_CLOSED'].indexOf('hw') >= 0,
    JSON.stringify(c4_30));

  // ② 앱 MODULES = gw-auth MODULES(순서까지 — cleanPerms가 저장하는 키 목록·순서) · safety 끝 · MOD_LABEL · PERM_ORDER safety 바로 뒤 site
  const am30 = list30(html, /var MODULES = \[([^\]]+)\]/, '"'), gm30 = list30(auth, /const MODULES = \[([^\]]+)\]/, "'");
  const ML30 = {}; [...((html.match(/var MOD_LABEL = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+):"([^"]+)"/g)].forEach((m) => { ML30[m[1]] = m[2]; });
  const PO30 = list30(html, /var PERM_ORDER = \[([^\]]+)\]/, '"');
  T('v430 앱 MODULES = gw-auth MODULES(순서까지 — cleanPerms가 저장하는 키) · safety 다음 hw(v431)가 둘 다 끝 · MOD_LABEL safety "안전"·hw "화관법"(키마다 라벨) · PERM_ORDER에서 safety 바로 뒤 site(같은 안전 탭 칩 짝)·veh 바로 뒤 hw(사이드바 차량 다음 화관법)',
    am30.length >= 14 && am30.join(',') === gm30.join(',') && am30.slice(-2).join(',') === 'safety,hw' && ML30.safety === '안전' && ML30.hw === '화관법' && am30.every((k) => !!ML30[k])
    && PO30.indexOf('safety') >= 0 && PO30[PO30.indexOf('safety') + 1] === 'site' && PO30.indexOf('veh') >= 0 && PO30[PO30.indexOf('veh') + 1] === 'hw',
    '앱 ' + am30.join(',') + ' / auth ' + gm30.join(',') + ' / PERM_ORDER ' + PO30.join(','));

  // ③ 직책 프리셋 — 앱 ROLE_PRESET 6직책 키 = MODULES · 일반 3직책 = gw-auth ROLE_OPEN_PERMS 키·값 · safety 관리 3직책 수행 / 일반 3직책 숨김(PM ② — 팀장도)
  const pre30 = {}; [...html.matchAll(/"(개발자|대표|관리자|팀장|직원|현장직)":\s*\{admin:(?:true|false),\s*(?:dev:true,\s*)?perms:\{([^}]*)\}/g)].forEach((m) => { const o = {}; [...m[2].matchAll(/(\w+):"(\w+)"/g)].forEach((x) => { o[x[1]] = x[2]; }); pre30[m[1]] = o; });
  const open30 = {}; [...auth.matchAll(/'(팀장|직원|현장직)':\s*\{([^}]*)\}/g)].forEach((m) => { const o = {}; [...m[2].matchAll(/(\w+):\s*'(\w+)'/g)].forEach((x) => { o[x[1]] = x[2]; }); open30[m[1]] = o; });
  const kv30 = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
  const R6_30 = ['개발자', '대표', '관리자', '팀장', '직원', '현장직'], R3_30 = ['팀장', '직원', '현장직'];
  const preKeys30 = R6_30.every((r) => pre30[r] && Object.keys(pre30[r]).sort().join(',') === am30.slice().sort().join(','));
  const openEq30 = R3_30.every((r) => open30[r] && kv30(pre30[r]) === kv30(open30[r]));
  T('v430 직책 프리셋: 앱 ROLE_PRESET 6직책 키 = MODULES · 일반 3직책(팀장·직원·현장직) = 서버 gw-auth ROLE_OPEN_PERMS 키·값(관리자 등록분 권한이 화면과 같게) · safety·hw(v431) = 관리 3직책 수행 / 일반 3직책 숨김(PM ②·③ — 팀장도 숨김) · 직원 줄 맨 끝 safety·hw(servertest가 직원 줄 글자를 서버 표와 대조)',
    Object.keys(pre30).length === 6 && Object.keys(open30).length === 3 && preKeys30 && openEq30
    && ['개발자', '대표', '관리자'].every((r) => pre30[r].safety === 'do' && pre30[r].hw === 'do') && R3_30.every((r) => pre30[r].safety === 'hide' && open30[r].safety === 'hide' && pre30[r].hw === 'hide' && open30[r].hw === 'hide')
    && Object.keys(pre30['직원']).slice(-2).join(',') === 'safety,hw' && Object.keys(open30['직원']).slice(-2).join(',') === 'safety,hw',
    JSON.stringify({ app: R6_30.map((r) => r + ':' + (pre30[r] ? pre30[r].safety + '/' + pre30[r].hw : '-')), srv: R3_30.map((r) => r + ':' + (open30[r] ? open30[r].safety + '/' + open30[r].hw : '-')), keys: preKeys30, same: openEq30 }));

  // ④ 서버 COL edu = safety · hr은 COL 값에 없음 · gw-auth cleanPerms를 뽑아 실제로 돌린다(safety 없는 perms → hide)
  const colMap30 = {}; [...((gd30.match(/const COL = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+):\s*'(\w+)'/g)].forEach((m) => { colMap30[m[1]] = m[2]; });
  const cleanP30 = new Function([(auth.match(/const MODULES = \[[^\]]+\];/) || [''])[0], (auth.match(/const CLOSED_DEFAULT = \{[^}]+\};/) || [''])[0], (auth.match(/function cleanPerms\(p\) \{[^\n]*\}/) || [''])[0], 'return cleanPerms;'].join('\n'))();
  const cpA30 = cleanP30({ tasks: 'do', site: 'do' }), cpB30 = cleanP30({ safety: 'do' }), cpC30 = cleanP30({ safety: 'admin' }), cpD30 = cleanP30(undefined);
  const cpH30 = cleanP30({ hw: 'do' }), cpV30 = cleanP30({ hw: 'view' }), cpX30 = cleanP30({ hw: 'admin' });   // v431 hw(화관법) — 수행·보기는 그대로, 없거나 이상한 값은 숨김
  T('v430 서버: gw-data COL edu = "safety"(종전 hr — 권한관리 \'안전\' 열과 같은 키) · COL 값에 hr 없음 · asbestos = site 그대로 · gw-auth cleanPerms 실행 — safety·hw(v431) 없이 저장(권한관리 칸·구버전 앱) → "hide"로 굳음, 이상한 값도 "hide", 받은 "do"·"view"는 그대로 · 저장 키 = gw-auth MODULES',
    colMap30.edu === 'safety' && Object.values(colMap30).indexOf('hr') < 0 && colMap30.asbestos === 'site'
    && cpA30.safety === 'hide' && cpA30.tasks === 'do' && cpA30.site === 'do' && cpB30.safety === 'do' && cpC30.safety === 'hide' && cpD30.safety === 'hide' && cpD30.lic === 'hide' && cpD30.tasks === 'view'
    && cpA30.hw === 'hide' && cpD30.hw === 'hide' && cpH30.hw === 'do' && cpV30.hw === 'view' && cpX30.hw === 'hide' && cpH30.safety === 'hide'
    && Object.keys(cpA30).join(',') === gm30.join(','),
    JSON.stringify({ edu: colMap30.edu, a: cpA30.safety, b: cpB30.safety, c: cpC30.safety, d: cpD30.safety, hw: [cpA30.hw, cpD30.hw, cpH30.hw, cpV30.hw, cpX30.hw] }));

  // ⑤ 앱 hr 권한 판정 0곳 · 교육 기록 읽기 = canSee("safety") 자리 · 교육을 안 보여 주는 화면의 loadEdu 0
  const hrLeft30 = (html.match(/(?:canSee|canDo|permOf)\(\s*["']hr["']\s*\)/g) || []).length;
  const swt30 = fn30('switchTab'), sfl30 = fn30('setSafetyLayer');
  const swLn30 = (t) => swt30.split('\n').filter((ln) => ln.indexOf('if (name === "' + t + '")') >= 0)[0] || '';
  T('v430 앱 hr 권한 판정 0곳(canSee·canDo·permOf("hr")) · 교육 기록 읽기 = canSee("safety") — loadEdu 첫 줄 · calEvents 교육 일정 · safetyPanes 교육 칸 · 캘린더를 열 때(switchTab의 loadEdu는 이 1곳) · 안전 › 현장 칸은 안전 권한일 때만 · 인허가·인사·일용직 화면은 loadEdu 0(교육을 안 보여 줌)',
    hrLeft30 === 0
    && /function loadEdu\(\)\{\s*\n\s*if\(!canSee\("safety"\)\) return;/.test(html)
    && /if \(canSee\("safety"\)\) liveEdu\(\)\.forEach\(/.test(fn30('calEvents')) && /if \(canSee\("safety"\)\) out\.push\("edu"\);/.test(fn30('safetyPanes'))
    && (swt30.match(/loadEdu\(/g) || []).length === 1 && swLn30('cal').indexOf('if (name === "cal"){ renderCalendar(); if (canSee("safety")) loadEdu(); }') >= 0
    && ['lic', 'hr', 'workers'].every((t) => swLn30(t) && swLn30(t).indexOf('loadEdu') < 0)
    && /if \(name === "site"\)\{ renderSites\(\); loadAsb\(\); if \(canSee\("safety"\)\) loadEdu\(\);/.test(sfl30),
    'hr 판정 ' + hrLeft30 + '곳 / switchTab loadEdu ' + (swt30.match(/loadEdu\(/g) || []).length);

  // ⑥ 교육 쓰기 3함수 첫 줄 canDo("safety") 가드 — 실행: 수행이 아니면 알리고 아무것도 안 함 / 수행이면 그대로 진행
  const guard30 = (name) => { const b = fn30(name); return b.slice(b.indexOf('{') + 1).trim().indexOf('if(!canDo("safety")){ alert(EDU_NO_WRITE); return; }') === 0; };
  const eduRun30 = (perm, which) => {
    const log = [], els = {};
    const el = (id) => els[id] || (els[id] = { id, value: '', textContent: '', innerHTML: '', style: {}, classList: { add: () => log.push('show:' + id), remove: () => {} } });
    const api = new Function('__perm', '__log', '__el', [
      'var document = { getElementById: function(id){ return __el(id); } };',
      'function canDo(m){ return __perm[m] === "do"; } function canSee(m){ return (__perm[m] || "hide") !== "hide"; } function alert(s){ __log.push("alert:" + s); } function confirm(){ __log.push("confirm"); return true; }',
      'var edu = [{ id:"e1", ptype:"member", pid:"u1", kind:"regular", date:"2026-06-01", next:"2026-12-01", updated:"2026-06-01" }], eduEditId = null, eduScope = "member";',
      (html.match(/var EDU_NO_WRITE = "[^"\n]*";/) || [''])[0],
      'function findEdu(id){ for(var i=0;i<edu.length;i++){ if(edu[i].id===id) return edu[i]; } return null; }',
      'var EDU_KINDS = []; function eduFillPersons(){ __log.push("fill"); } function eduUpdateNotes(){} function isDate(s){ return /^\\d{4}-\\d{2}-\\d{2}$/.test(s||""); } function genId(){ return "e9"; } function todayStr(){ return "2026-11-09"; } function esc(s){ return String(s); }',
      'function scheduleEduSave(){ __log.push("save"); } function closeEdu(){ __log.push("close"); } function gwToast(){ __log.push("toast"); } function afterSave(){ __log.push("render"); }',
      'function renderEdu(){} function renderCalendar(){} function renderSites(){}',
      fn30('openEdu'), fn30('saveEdu'), fn30('deleteEdu'),
      'return { open: function(){ openEdu(null, "member"); }, save: function(){ eduEditId = "e1"; document.getElementById("eduPerson").value = "member:u1"; document.getElementById("eduDate").value = "2026-06-02"; saveEdu(); }, del: function(){ eduEditId = "e1"; deleteEdu(); }, edu: function(){ return edu; } };'].join('\n'))(perm, log, el);
    api[which]();
    return { log, edu: api.edu() };
  };
  const onlyAlert30 = (r) => r.log.length === 1 && r.log[0].indexOf('alert:교육·검진 기록을 추가·수정·삭제할 권한이 없습니다') === 0;
  const eo1 = eduRun30({ safety: 'view' }, 'open'), eo2 = eduRun30({ safety: 'do' }, 'open'), eo3 = eduRun30({ hr: 'do' }, 'open');
  const es1 = eduRun30({ safety: 'view' }, 'save'), es2 = eduRun30({ safety: 'do' }, 'save'), es3 = eduRun30({ hr: 'do' }, 'save');
  const ed1 = eduRun30({ safety: 'view' }, 'del'), ed2 = eduRun30({ safety: 'do' }, 'del'), ed3 = eduRun30({}, 'del');
  T('v430 교육 쓰기 3함수(openEdu·saveEdu·deleteEdu) 첫 줄 canDo("safety") 가드(실행): 안전 보기·옛 hr 수행·권한 없음 = 알림 1번뿐(창 안 열림·저장 예약 0·기록 그대로·삭제 확인도 안 물음) / 안전 수행 = 창 열림·저장(닫기·토스트·다시 그림)·삭제 표시 그대로',
    ['openEdu', 'saveEdu', 'deleteEdu'].every(guard30)
    && [eo1, eo3, es1, es3, ed1, ed3].every(onlyAlert30) && es1.edu[0].date === '2026-06-01' && ed1.edu[0].del === undefined
    && eo2.log.indexOf('show:eduBackdrop') >= 0 && eo2.log.every((x) => x.indexOf('alert') !== 0)
    && es2.log.join(',') === 'save,close,toast,render' && es2.edu[0].date === '2026-06-02'
    && ed2.log.join(',') === 'confirm,save,close,render' && ed2.edu[0].del === 1,
    JSON.stringify({ open: [eo1.log, eo2.log.slice(-1)], save: [es1.log, es2.log], del: [ed1.log, ed2.log] }));

  // ⑦ doSaveEdu — 서버 거절(403 NO_WRITE)을 알린다(종전엔 조용히 삼켜 '저장했습니다'만 남았다)·보류 해제 / 200은 조용히
  //    v430 검토: 같은 403이라도 기기 승인 취소(DEVICE_NOT_APPROVED — 서버 handleSave가 권한보다 먼저 본다)는 기기 안내 + 보류 유지(로컬 변경을 버리지 않음)
  const dse30 = (status, code) => { const log = []; const api = new Function('__st', '__code', '__log', ['var edu = [], eduBase = 0, eduPending = true;',
    'function gwCall(fn, body){ __log.push(fn + ":" + body.action + ":" + body.collection); return { then: function(f){ f({ status: __st, body: __code ? { error_code: __code } : {} }); return { catch: function(){} }; } }; }',
    'function gwToast(m, w){ __log.push("toast:" + (w ? "warn:" : "") + m); } function mergeEdu(a){ return a; }',
    fn30('doSaveEdu'), 'doSaveEdu(); return { pending: function(){ return eduPending; } };'].join('\n'))(status, code, log); return { log, pending: api.pending() }; };
  const ds403_30 = dse30(403, 'NO_WRITE'), ds403n_30 = dse30(403), ds403d_30 = dse30(403, 'DEVICE_NOT_APPROVED'), ds200_30 = dse30(200), ds500_30 = dse30(500);
  const noWr30 = (r) => r.log.length === 2 && r.log[0] === 'gw-data:save:edu' && r.log[1].indexOf('toast:warn:교육·검진 기록 저장 권한이 없어 서버가 이 변경을 받지 않았습니다') === 0 && r.pending === false;
  T('v430 doSaveEdu: 서버 거절 403 NO_WRITE(안전 수행이 아님 — 이유 코드가 없는 403도)면 경고 토스트 "교육·검진 기록 저장 권한이 없어 서버가 이 변경을 받지 않았습니다"·보류 해제(다음 읽기 때 서버 값) / 403 DEVICE_NOT_APPROVED(기기 승인 취소)면 "승인되지 않은 기기입니다" 안내·권한 문구 없음·보류 유지 / 200은 토스트 없음 / 그 밖의 오류는 종전대로(보류 유지)',
    noWr30(ds403_30) && noWr30(ds403n_30)
    && ds403d_30.log.length === 2 && ds403d_30.log[1].indexOf('toast:warn:승인되지 않은 기기입니다 — 관리자에게 기기 승인을 요청하세요.') === 0 && ds403d_30.log[1].indexOf('저장 권한이 없어') < 0 && ds403d_30.pending === true
    && ds200_30.log.join(',') === 'gw-data:save:edu' && ds200_30.pending === false && ds500_30.log.join(',') === 'gw-data:save:edu' && ds500_30.pending === true,
    JSON.stringify({ a: ds403_30, n: ds403n_30, d: ds403d_30, b: ds200_30, c: ds500_30 }));

  // ⑧ 레지스트리 자리(정적) — 칩·칸 · 안전 탭 버튼은 MODULE_TAB 값에 없음 · view-safety도 MODULE_VIEW 값에 없음
  const MT30 = {}, MV30 = {};
  [...((html.match(/var MODULE_TAB = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+):"([\w-]+)"/g)].forEach((m) => { MT30[m[1]] = m[2]; });
  [...((html.match(/var MODULE_VIEW = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+):"([\w-]+)"/g)].forEach((m) => { MV30[m[1]] = m[2]; });
  const vs30 = (() => { const i = html.indexOf('<section class="view" id="view-safety">'); return i < 0 ? '' : html.slice(i, html.indexOf('</section>', i)); })();
  const bar30 = (() => { const i = vs30.indexOf('<div class="lsub-bar" id="sfSubBar">'); return i < 0 ? '' : vs30.slice(i, vs30.indexOf('</div>', i)); })();
  T('v430 레지스트리 자리(정적): MODULE_TAB.safety = 교육·검진 칩(sfChipEdu — 안전 탭 칩 줄 sfSubBar 안 .lsub-btn) · MODULE_VIEW.safety = 교육·검진 칸(sfPaneEdu — .sf-pane, 보기 readonly는 칸에만) · 안전 탭 버튼 tabSafetyBtn은 MODULE_TAB 값에 없음 · view-safety도 MODULE_VIEW 값에 없음(걸면 현장 칸 버튼까지 숨는다) · 두 표 키 = MODULES',
    MT30.safety === 'sfChipEdu' && MV30.safety === 'sfPaneEdu' && Object.values(MT30).indexOf('tabSafetyBtn') < 0 && Object.values(MV30).indexOf('view-safety') < 0
    && bar30.indexOf('<button class="lsub-btn" data-lsub="edu" id="sfChipEdu">교육·검진</button>') > 0 && /<div class="sf-pane" id="sfPaneEdu" style="display:none;">/.test(vs30)
    // v434(메뉴 56 4-2): 두 표 키 = MODULES 그대로(예외 없음 — v431 4-1 동안 빼던 hw도 이제 두 표에 있다)
    && Object.keys(MT30).sort().join(',') === am30.slice().sort().join(',') && Object.keys(MV30).sort().join(',') === am30.slice().sort().join(',') && am30.indexOf('hw') >= 0,
    JSON.stringify({ tab: MT30.safety, view: MV30.safety, keys: Object.keys(MT30).length + '/' + Object.keys(MV30).length + ' vs MODULES ' + am30.length }));

  // ⑨ applyPerms 전체 실행 — 사람 유형별(실제 원문: MODULES 루프 → 일반 강제 이동 → applySafetyPerms)
  const mkCl30 = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); return s.has(c); }, contains: (c) => s.has(c) }; };
  const mkEl30 = (id, attrs) => ({ id, attrs: attrs || {}, classList: mkCl30(), style: {}, getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; }, querySelectorAll: () => [] });
  //    v432: 현황 칩(sfChipNow — applySafetyPerms가 안전 권한으로 숨김)·칸(sfPaneNow)을 싣고 sfNowOpen은 기록만 하는 가짜. 서명에 N(현황 칩) 추가
  const runAp30 = (who, perm, cur, layer) => {
    const chips = [mkEl30('sfChipNow', { 'data-lsub': 'now' }), mkEl30('sfChipSite', { 'data-lsub': 'site' }), mkEl30('sfChipEdu', { 'data-lsub': 'edu' })];
    const D = { tabSafetyBtn: mkEl30('tabSafetyBtn'), sfChipNow: chips[0], sfChipSite: chips[1], sfChipEdu: chips[2], sfSubBar: mkEl30('sfSubBar'), sfPaneNow: mkEl30('sfPaneNow'), sfPaneSite: mkEl30('sfPaneSite'), sfPaneEdu: mkEl30('sfPaneEdu'), asbMovedNote: mkEl30('asbMovedNote'), asbMovedGo: mkEl30('asbMovedGo'), eduMovedHr: mkEl30('eduMovedHr'), eduMovedWk: mkEl30('eduMovedWk'), tabLicBtn: mkEl30('tabLicBtn'), 'view-lic': mkEl30('view-lic') };
    D.sfSubBar.querySelectorAll = () => chips;
    const log = [];
    const st = new Function('__D', '__who', '__perm', '__log', '__cur', '__layer', [
      'var document = { getElementById: function(id){ return __D[id] || null; }, querySelectorAll: function(){ return []; } };',
      'var currentTab = __cur, safetyLayer = __layer, eduViewScope = "member";',
      'function isAdmin(){ return __who === "admin"; } function permOf(m){ return isAdmin() ? "do" : (__perm[m] || "hide"); } function canSee(m){ return permOf(m) !== "hide"; } function canDo(m){ return permOf(m) === "do"; }',
      'function switchTab(n){ __log.push("switch:" + n); currentTab = n; } function updateUserChip(){} function updateApprovalBadges(){}',
      'function renderSites(){ __log.push("renderSites"); } function loadAsb(){} function loadEdu(){ __log.push("loadEdu"); } function loadWorkers(){ return { then: function(){} }; } function renderEdu(){ __log.push("renderEdu"); } function sfNowOpen(){ __log.push("sfNowOpen"); }',
      regStmt30.join('\n'), fn30('safetyPanes'), fn30('setSafetyLayer'), fn30('applySafetyPerms'), fn30('applyPerms'),
      'applyPerms(); return { cur: currentTab, layer: safetyLayer };'].join('\n'))(D, who, perm, log, cur, layer);
    const hid = (id) => D[id].classList.contains('perm-hidden'), ro = (id) => D[id].classList.contains('readonly');
    const H = D.eduMovedHr.style.display, W = D.eduMovedWk.style.display;
    return { D, log, st, home: log.indexOf('switch:dash') >= 0,
      sig: (hid('tabSafetyBtn') ? 'T-' : 'T+') + (hid('sfChipNow') ? 'N-' : 'N+') + (hid('sfChipSite') ? 'S-' : 'S+') + (hid('sfChipEdu') ? 'E-' : 'E+') + (D.sfSubBar.style.display === 'none' ? 'B-' : 'B+') + (ro('sfPaneSite') ? 'r' : '') + (ro('sfPaneEdu') ? 'R' : '') + (ro('sfPaneNow') ? 'X' : '') + (H === '' && W === '' ? 'H+' : (H === 'none' && W === 'none' ? 'H-' : 'H?')) };
  };
  const A30 = runAp30('admin', {}, 'safety', 'site');
  const K30 = runAp30('staff', { safety: 'do', site: 'hide', lic: 'view', wk: 'view', veh: 'do', con: 'do' }, 'safety', 'site');   // 권민지형(PM 부여 뒤)
  const J30 = runAp30('staff', { site: 'do', lic: 'do', wk: 'do', veh: 'do' }, 'safety', 'site');   // 김정아형
  const Jw30 = runAp30('staff', { site: 'do', lic: 'view', wk: 'do', veh: 'do' }, 'safety', 'site');   // 정재욱형
  const V30 = runAp30('staff', { safety: 'view', site: 'do' }, 'safety', 'edu');   // 가상형(안전 보기·현장 수행)
  const V2_30 = runAp30('staff', { safety: 'do', site: 'view' }, 'safety', 'site');
  const N30 = runAp30('staff', { veh: 'view', check: 'do', doc: 'view', wk: 'view' }, 'safety', 'site');   // 김호태·현장형
  const O30 = runAp30('staff', { hr: 'do', site: 'hide' }, 'safety', 'site');   // 옛 키 hr만
  T('v430 applyPerms 실행(실제 원문 — MODULES 루프·일반 강제 이동·applySafetyPerms · v432 현황 칩 N): 관리자 = 탭·현황·현장·교육 칩·칩 줄·교육 안내 · 권민지형(안전 수행·현장 숨김) = 탭·현황·교육 칩(칩 줄 보임 — 칩 2개, v432)·현장 칸에 있었으면 첫 칸 현황으로 옮겨 읽음(sfNowOpen)·교육 안내 보임·홈으로 안 감 · 김정아·정재욱형(현장 수행·안전 없음) = 탭·현장 칩만(현황 칩 없음), 안전 탭에 있어도 홈으로 안 튕김(일반 강제 이동에서 safety 제외) · 가상형 안전 보기 = 교육 칸만 읽기 전용(현장 칸 버튼 그대로·현황 칸은 읽기 전용 표시 없음 — 버튼이 없다) · 현장 보기 = 현장 칸만 읽기 전용 · 둘 다 없음·옛 hr 키만 = 탭·현황 칩 숨김·홈 · 칩 숨김은 MODULES 루프 한 곳(applySafetyPerms에 sfChipEdu 없음)',
    A30.sig === 'T+N+S+E+B+H+' && !A30.home && A30.st.layer === 'site' && A30.log.indexOf('sfNowOpen') < 0
    && K30.sig === 'T+N+S-E+B+H+' && !K30.home && K30.st.layer === 'now' && K30.log.filter((x) => x === 'sfNowOpen').length === 1 && K30.D.sfPaneNow.style.display === '' && K30.D.sfPaneEdu.style.display === 'none' && K30.D['view-lic'].classList.contains('readonly')
    && J30.sig === 'T+N-S+E-B-H-' && !J30.home && J30.st.cur === 'safety' && J30.st.layer === 'site' && Jw30.sig === 'T+N-S+E-B-H-' && !Jw30.home
    && V30.sig === 'T+N+S+E+B+RH+' && !V30.home && V30.st.layer === 'edu' && V2_30.sig === 'T+N+S+E+B+rH+' && !V2_30.home
    && N30.sig === 'T-N-S-E-B-H-' && N30.home && O30.sig === 'T-N-S-E-B-H-' && O30.home
    && fn30('applySafetyPerms').indexOf('sfChipEdu') < 0,
    [A30, K30, J30, Jw30, V30, V2_30, N30, O30].map((r) => r.sig + (r.home ? '→홈' : '') + '@' + r.st.layer).join(' / '));

  // ⑩ 캘린더 교육 일정·loadEdu 실행 — 안전 보기·수행이면 보이고 읽음 / 옛 hr 수행·현장 수행·없음 = 0·안 읽음(서버 col:edu도 safety라 읽으면 403)
  const calE30 = (perm) => new Function('__perm', ['var vehicles = [], tasks = [], receivables = [], licenses = [];',
    'function canSee(m){ return (__perm[m] || "hide") !== "hide"; } function canDo(m){ return __perm[m] === "do"; } function isAdmin(){ return false; } function licVisible(){ return true; } function taskVisible(){ return true; } function recVisible(){ return true; }',
    'function isDate(s){ return /^\\d{4}-\\d{2}-\\d{2}$/.test(s||""); } function fmtAmount(v){ return String(v); } function dispName(n){ return n||""; } function dispNameById(){ return ""; } function memberName(){ return ""; }',
    'function liveAsb(){ return []; } function asbNotifyDue(){ return ""; }',
    'function liveEdu(){ return [{ ptype:"member", pid:"u1", kind:"regular", date:"2026-06-01", next:"2026-12-01" }, { ptype:"worker", pid:"w1", kind:"spec_med", date:"2026-04-01", next:"2027-04-01" }]; } function eduPersonName(){ return "홍"; } function eduKindLabel(){ return "정기"; }',
    'function liveLeaves(){ return []; } function isPartialLeave(){ return false; } function leaveCalVisible(){ return false; } function leaveTypeLabel(){ return ""; }',
    fn30('pad'), fn30('fmtDate'), fn30('eachDate'), fn30('calEvents'), 'return calEvents().filter(function(e){ return e.mod === "hr"; }).length;'].join('\n'))(perm);
  const le30 = (perm) => { const calls = []; new Function('__perm', '__calls', ['function canSee(m){ return (__perm[m] || "hide") !== "hide"; } function canDo(m){ return __perm[m] === "do"; }',
    'function gwCall(fn, body){ __calls.push(fn + ":" + body.action + ":" + body.collection); return { then: function(){ return { catch: function(){} }; } }; }',
    fn30('loadEdu'), 'loadEdu();'].join('\n'))(perm, calls); return calls.join(','); };
  const ce30 = [calE30({ safety: 'view' }), calE30({ safety: 'do' }), calE30({ hr: 'do' }), calE30({ site: 'do' }), calE30({})];
  const lo30 = [le30({ safety: 'view' }), le30({ safety: 'do' }), le30({ hr: 'do' }), le30({ site: 'do' }), le30({})];
  T('v430 캘린더 교육 일정·loadEdu 실행: 안전 보기·수행 = 교육 예정 2건·gw-data get edu / 옛 hr 수행만·현장 수행만·권한 없음 = 0건·읽지 않음',
    ce30.join(',') === '2,2,0,0,0' && lo30.join('|') === 'gw-data:get:edu|gw-data:get:edu|||',
    JSON.stringify({ cal: ce30, load: lo30 }));

  // ⑪ 권한관리 표 안전 칸 — 값이 없는 직원은 숨김으로 보이고 한 번 누르면 수행(PM이 권민지 칸 1번 — 브리핑 deploy) · 머리 열 … 차량 / 안전 / 현장 / 인허가 …
  const pm30 = new Function([(html.match(/var PERM_CLOSED = \{[^}]+\};/) || [''])[0], (html.match(/var PM_TXT = \{[^}]+\};/) || [''])[0], (html.match(/var PM_NEXT = \{[^}]+\};/) || [''])[0], fn30('pmVal'),
    'return { v: pmVal, next: PM_NEXT, txt: PM_TXT };'].join('\n'))();
  const kmj30 = { perms: { tasks: 'hide', veh: 'do', site: 'hide', lic: 'view', wk: 'view' } };
  T('v430 권한관리 표 안전 칸(pmVal 실행): 안전 값이 없는 직원은 "숨김"으로 보이고 한 번 누르면 "수행"(PM이 권민지 칸 1번) · 두 번이면 "보기" · 머리 열 순서 … 차량 / 화관법(v431) / 안전 / 현장 / 인허가 …',
    pm30.v(kmj30, 'safety') === 'hide' && pm30.next[pm30.v(kmj30, 'safety')] === 'do' && pm30.txt[pm30.next.hide] === '수행' && pm30.next[pm30.next.hide] === 'view'
    && PO30.map((k) => ML30[k]).join(' / ').indexOf('차량 / 화관법 / 안전 / 현장 / 인허가') >= 0,
    pm30.v(kmj30, 'safety') + ' → ' + pm30.next[pm30.v(kmj30, 'safety')] + ' / ' + PO30.map((k) => ML30[k]).join(' / '));

  // ⑪-2 (v430 검토) 권한 재확인(refreshMemberPerms) = 실효값 비교 — 권한과 무관한 회원 저장(인사 카드·휴직·사직 승인·복직)도 서버 cleanPerms가 빈 safety를 '숨김'으로 채우고
  //      키 순서를 MODULES 순으로 바꾼다. 저장 글자 비교면 배포 뒤 첫 저장 때 그 직원 앱이 '권한이 바뀌었습니다' 새로고침(입력 중 창 유실) — 실제 gw-auth cleanPerms 출력(④ cleanP30)으로 돌린다
  //      v431: permsSameEff가 MODULE_TAB(연결 전 키 hw 판정)도 읽어 시험 틀에 레지스트리 두 문장(MODULES·MODULE_TAB)을 같이 싣는다 — 단언은 그대로(hw 쪽은 v431 묶음)
  const rmp30 = (cur, nm) => { const log = []; new Function('__cur', '__nm', '__log', [regStmt30[0], regStmt30[1], (html.match(/var PERM_CLOSED = \{[^}]+\};/) || [''])[0], fn30('pmVal'), fn30('permsSameEff'),
    'var curMemberObj = __cur, permRefreshAt = 0, localStorage = { setItem: function(){} }, location = { reload: function(){ __log.push("reload"); } };',
    'function gwToken(){ return "tok"; } function curMember(){ return curMemberObj; } function setTimeout(f){ f(); } function gwToast(m){ __log.push("toast:" + m); }',
    'function gwCall(fn, body){ __log.push(fn + ":" + body.action); return { then: function(f){ f({ status: 200, body: { valid: true, member: __nm } }); return { catch: function(){} }; } }; }',
    fn30('refreshMemberPerms'), 'refreshMemberPerms();'].join('\n'))(cur, nm, log); return log; };
  const kja30 = { tasks: 'hide', veh: 'do', rec: 'hide', lic: 'do', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'do', quote: 'hide', promo: 'hide', site: 'do' };   // 김정아형 저장값 모양(site가 끝, safety 없음)
  const kjaSv30 = cleanP30(kja30);   // 권한과 무관한 저장(인사 카드 등) 뒤 서버 저장값 — safety 'hide' 채움·MODULES 순
  const mem30 = (perms, extra) => Object.assign({ id: 'u1', name: '직원', admin: false, perms: perms }, extra || {});
  const rA30 = rmp30(mem30(kja30), mem30(kjaSv30)), rG30 = rmp30(mem30({}), mem30(cleanP30({})));
  const rB30 = rmp30(mem30(kjaSv30), mem30(Object.assign({}, kjaSv30, { safety: 'do' }))), rC30 = rmp30(mem30(kja30), mem30(Object.assign({}, kjaSv30, { safety: 'do' })));
  const rD30 = rmp30(mem30(kja30), mem30(Object.assign({}, kjaSv30, { safety: 'view' }))), rE30 = rmp30(mem30(kjaSv30), mem30(kjaSv30, { tier: 'admin' }));
  const rF30 = rmp30(mem30(Object.assign({ bid: 'do' }, kja30)), mem30(kjaSv30));   // 옛 기록에만 남은 키(실효 수행 → 기본 보기)가 저장 때 지워짐
  const rel30 = (l) => l.indexOf('reload') >= 0 && l.some((x) => x.indexOf('toast:권한이 바뀌었습니다') === 0);
  T('v430 검토 권한 재확인 실효 비교(refreshMemberPerms 실행 — 서버 cleanPerms 출력 그대로): 권한과 무관한 회원 저장(빈 safety → 숨김·키 순서 바뀜)·값이 하나도 없던 회원이 기본값으로 굳음 = 새로고침 없음 · 안전 숨김/값 없음 → 수행·보기 = "권한이 바뀌었습니다" 새로고침 · 등급만 바뀜·옛 기록에만 남은 키의 실효값이 바뀜 = 새로고침(종전 그대로)',
    JSON.stringify(kja30) !== JSON.stringify(kjaSv30) && kjaSv30.safety === 'hide'
    && rA30.join(',') === 'gw-auth:verify' && rG30.join(',') === 'gw-auth:verify' && [rB30, rC30, rD30, rE30, rF30].every(rel30),
    JSON.stringify({ a: rA30, g: rG30, b: rB30, c: rC30, d: rD30, e: rE30, f: rF30 }));

  // ⑫ 문서 — MANUAL 15·21-2·21-9·28절 · CLAUDE.md 예외 줄이 실제 등록 상태 · sw ≥ 430
  const sec30 = (a, b) => { const i = man30.indexOf(a); return i < 0 ? '' : man30.slice(i, man30.indexOf(b, i + a.length)); };
  const m15_30 = sec30('<h2 id="s15">', '<h2 id="s16">'), m212_30 = sec30('<h3>21-2. 권한관리</h3>', '<h3>21-3.'), m219_30 = sec30('<h3>21-9.', '<h3>21-10.'), m28_30 = sec30('<h2 id="s28">', '<h2 id="s29">');
  T('v430 문서: MANUAL 15절 교육 일정 "(안전 권한이 있는 분만" · 21-2 "\'안전\' 열이 안전 › 교육·검진 칸"·기본 숨김(팀장도)·관리자 수행 고정·한 번 누르면 수행 · 21-9·28절·14절 교육·검진 = 안전 권한(관리자 전용 문장 0) · CLAUDE.md "3단계 전까지 레지스트리 밖" 0·등록 13곳·MODULE_TAB.safety · sw ≥ 430',
    m15_30.indexOf('<li>교육·건강진단 다음 예정일 📚(안전 권한이 있는 분만, <b>교육</b> 배지)</li>') > 0 && m15_30.indexOf('📚(관리자만') < 0
    && m212_30.indexOf("'안전' 열이 안전 › 교육·검진 칸") > 0 && m212_30.indexOf('<b>안전</b>(교육·검진·현황)도 기본 숨김입니다(새 회원은 팀장도 숨김, 관리자 행은 수행 고정)') > 0 && m212_30.indexOf('숨김 칸을 <b>한 번</b> 누르면 수행') > 0   // v432 검토: 목록 항목에도 현황 칸(같은 안전 열) — 같은 강도로 새 글자
    && m219_30.indexOf('권한관리 <b>안전</b> 열(21-2)') > 0 && m219_30.indexOf('칸에 있습니다(관리자)') < 0
    && m28_30.indexOf('교육·검진 칸은 안전 권한을 받은 분에게만') > 0 && man30.indexOf('교육·검진 칸은 관리자에게만') < 0 && man30.indexOf('(관리자, 21-9)') < 0
    && cl30.indexOf('3단계 전까지 레지스트리 밖') < 0 && cl30.indexOf('등록 13곳') > 0 && cl30.indexOf('`MODULE_TAB.safety = sfChipEdu`') > 0
    && Number((sw30.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 430, '');
  // ⑫-2 (v430 검토) 한 층만 고친 문서 — FEATURES §1 업무 줄 · MANUAL 21절 도입(관리자 전용 절이지만 21-9는 안전 권한 직원에게도) · 28절 → 21-9 · CLAUDE.md 기본 숨김 자리별로 터지는 곳
  const ft30 = readFileSync(join(ROOT, 'FEATURES.md'), 'utf8');
  const ft1_30 = ft30.split('\n').filter((ln) => ln.indexOf('- **업무**:') === 0)[0] || '';
  const m21i_30 = sec30('<h2 id="s21">', '<h3>21-1.');
  T('v430 검토 문서: FEATURES §1 업무 줄 교육·검진 = "안전 권한"("교육·건강진단 이력, 관리자" 0곳) · MANUAL 21절 도입이 21-9 예외(안전 열을 받은 직원에게도 보임)를 말함 · 28절 안내가 교육·검진 칸 쓰는 법 21-9로 이음 · CLAUDE.md 기본 숨김 4곳 = 자리별(gw-data 빠짐 = 키 없는 회원 읽기가 바로 열림 · gw-auth 빠짐 = 저장 때 cleanPerms) — "한 곳이라도 빠지면 cleanPerms가" 한 기전 문장 0',
    ft1_30.indexOf('**교육·검진**(교육·건강진단 이력, 안전 권한') > 0 && ft30.indexOf('교육·건강진단 이력, 관리자') < 0
    && m21i_30.indexOf('<b>21-9 교육·건강진단 이력</b>은 권한관리 <b>안전</b> 열을 받은 직원에게도 보입니다') > 0
    && m28_30.indexOf('교육·검진 칸 쓰는 법은 21-9에 있습니다') > 0
    && cl30.indexOf('gw-data `PERM_CLOSED`가 빠지면 그 키 값이 없는 회원(새 키 배포 직후 전원)의 서버 읽기가 저장을 기다리지 않고 바로') > 0 && cl30.indexOf('gw-auth `CLOSED_DEFAULT`가 빠지면 회원 저장 때 `cleanPerms`가') > 0
    && cl30.indexOf("이 한 곳이라도 빠지면 모든 회원 저장이 거치는 `cleanPerms`가 '보기'를 채워 전원에게 열린다") < 0,
    JSON.stringify({ f1: ft1_30.slice(0, 40), m21: m21i_30.length, m28: m28_30.length }));
} catch (e) { console.log('  (v430 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v431(11/9 메뉴 56 4-1, PM "56. ㄱ"): 화관법 권한 키(hw) 등록 — 권한 목록·기본 숨김. v434(11/10 4-2)에서 탭 연결·서버 제출 검사를 켜며 이 묶음의 4-1 상태 검사를 같은 강도로 뒤집었다.
//      화관법 탭 내부 이름이 hwakwan이라 키 등록만으로는 탭이 숨지 않는다 — 4-1 동안은 MODULE_TAB·MODULE_VIEW·applyPerms 전용 줄·서버 제출 검사가 없어야 했고(PM 부여 전 김정아 님 제출 보호),
//      4-2(운영 저장값 김정아 do·권민지·정재욱 view 확인 뒤)부터는 그것들이 정해진 자리에 꼭 있어야 한다. 정적(① 등록 자리 ② 4-2 연결) + 실제 원문을 뽑아 사람 유형별로 돌리는 실행
//      (③ applyPerms — 숨김은 탭 숨김·홈 · 보기는 탭 보임·화면 읽기 전용 · ④ 권한관리 표·칸 누름 · ⑤ 권한 재확인 — 화관법 칸만 바뀌어도 새로고침, 값 없음 → 숨김은 없음) + 문서(⑥·⑥-2 — 4-2 상태 글).
//      v434가 걷은 4-1 예외 4곳(앞 묶음 4번 auth↔data — '저장 데이터 없는 키' 예외는 남기고 gw-hwakwan 강제를 대조 · v428 ⑨ · v429 ② · v430 ⑧)은 v434 묶음 ⓐ가 표식 글이 남지 않았는지 본다.
//      검토 반영(11/10): ①-2 리터럴 밖 등록 금지(4-2 뒤에도 그대로 — ①·③·⑤와 v428 ⑨·v430 ⑧이 리터럴만 읽음) · ⑥ TESTLIST v431 칸 전부 AI 몫('PM 몫' 글자만으로는 못 잡음) · ⑥-2 한 층만 고친 문서.
try {
  const fn31 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const rd31 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const sw31 = rd31('sw.js'), man31 = rd31('MANUAL.html'), cl31 = rd31('CLAUDE.md'), ft31 = rd31('FEATURES.md'), tl31 = rd31('TESTLIST.md');
  const gd31 = rd31('netlify/functions/gw-data.js'), ask31 = rd31('netlify/functions/_lib/ask.js');
  const hwk31 = rd31('netlify/functions/gw-hwakwan.js'), hwc31 = rd31('netlify/functions/gw-hwakwan-cron.js'), hwb31 = rd31('netlify/functions/gw-hwakwan-run-background.js');
  const stmt31 = (re) => { const m = html.match(re); if (!m) throw new Error('문장 없음: ' + re); return m[0]; };
  const obj31 = (re) => { const o = {}; [...((html.match(re) || ['', ''])[1]).matchAll(/(\w+):"([^"]+)"/g)].forEach((m) => { o[m[1]] = m[2]; }); return o; };
  const own31 = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const MT31 = obj31(/var MODULE_TAB = \{([^}]+)\}/), MV31 = obj31(/var MODULE_VIEW = \{([^}]+)\}/), ML31 = obj31(/var MOD_LABEL = \{([^}]+)\}/);
  const am31 = ((html.match(/var MODULES = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, ''));
  const pc31 = [...((html.match(/var PERM_CLOSED = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  const colV31 = (src) => [...(((src.match(/const COL = \{([^}]+)\}/) || ['', ''])[1]).matchAll(/:\s*'(\w+)'/g))].map((m) => m[1]);
  const MT_STMT31 = stmt31(/var MODULE_TAB = \{[^}]+\};/), MV_STMT31 = stmt31(/var MODULE_VIEW = \{[^}]+\};/), MOD_STMT31 = stmt31(/var MODULES = \[[^\]]+\];/);

  // ① 등록 자리 — hw는 MODULES 끝·라벨 '화관법'·기본 숨김 · v434(4-2) MODULE_TAB.hw = 사이드바 화관법 탭 버튼(nav 안 data-tab "hwakwan" 버튼 — 다른 키 값에는 없음) ·
  //    MODULE_VIEW.hw = 화관법 화면 section(view-hwakwan) · 저장 데이터 없는 키(gw-data·물어보기 COL 값에 hw·hwakwan 없음 — 앞 묶음 4번 예외의 근거)
  const nav31 = html.slice(html.indexOf('<nav class="tabbar" id="tabbar">'), html.indexOf('</nav>'));
  T('v431 등록 자리(v434 4-2 연결): 앱 MODULES 끝 hw · MOD_LABEL.hw "화관법" · 앱 PERM_CLOSED에 hw · MODULE_TAB.hw = tabHwakwanBtn(사이드바 업무 묶음 화관법 탭 버튼, data-tab "hwakwan") · MODULE_VIEW.hw = view-hwakwan(화관법 화면 section) · 두 id는 hw 키에만 · gw-data·물어보기 COL 값에 hw·hwakwan 없음(저장 데이터 없는 키)',
    am31[am31.length - 1] === 'hw' && ML31.hw === '화관법' && pc31.indexOf('hw') >= 0
    && MT31.hw === 'tabHwakwanBtn' && MV31.hw === 'view-hwakwan'
    && Object.keys(MT31).filter((k) => MT31[k] === 'tabHwakwanBtn').join(',') === 'hw' && Object.keys(MV31).filter((k) => MV31[k] === 'view-hwakwan').join(',') === 'hw'
    && nav31.indexOf('<button class="tab-btn" data-tab="hwakwan" id="tabHwakwanBtn">화관법</button>') > nav31.indexOf('<div class="nav-group">업무</div>') && nav31.indexOf('<div class="nav-group">업무</div>') > 0
    && (html.match(/<section class="view" id="view-hwakwan">/g) || []).length === 1
    && colV31(gd31).length > 10 && colV31(ask31).length > 5 && colV31(gd31).concat(colV31(ask31)).every((v) => v !== 'hw' && v !== 'hwakwan'),
    JSON.stringify({ last: am31[am31.length - 1], label: ML31.hw, closed: pc31.indexOf('hw') >= 0, tab: MT31.hw, view: MV31.hw }));

  // ①-2 (v431 검토) 리터럴 밖 등록 금지 — ①과 ③·⑤ 시험 틀, v428 ⑨·v430 ⑧은 두 표의 '리터럴'만 읽는다. 리터럴 밖에서 MODULE_TAB.hw = …·MODULE_TAB["hw"] = …·
  //    Object.assign(MODULE_TAB, …)·별칭·재선언·재대입으로 이으면 어떤 검사도 못 보고(검토 실측 — 대입 한 줄로 hw 값 없는 직원의 화관법 탭이 숨음) 4-1이 막으려던 사고가 난다.
  //    두 표는 선언 리터럴 2곳(var … = {)에서만 채운다. 주석 속 설명('MODULE_TAB.site=sfChipSite' 등)은 뺀다 — 같은 줄 앞 //, 4000자 안의 열린 /* … 나 <!-- …
  //    4-2에서 hw 예외를 지운 뒤에도 남겨 둔다(4-2 등록도 리터럴 안에). Object.keys(MODULE_TAB) 같은 읽기는 막지 않는다.
  const cmt31 = (src, i) => { const ls = src.lastIndexOf('\n', i - 1) + 1; if (/(^|[^:])\/\//.test(src.slice(ls, i))) return true; const w = src.slice(Math.max(0, i - 4000), i); return w.lastIndexOf('/*') > w.lastIndexOf('*/') || w.lastIndexOf('<!--') > w.lastIndexOf('-->'); };
  const code31 = (re) => [...html.matchAll(re)].filter((m) => !cmt31(html, m.index)).map((m) => html.slice(0, m.index).split('\n').length + ':' + m[0].trim());
  const regAsg31 = code31(/\bMODULE_(?:TAB|VIEW)\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]\n]*\])\s*(?:\|\||&&|\?\?)?=(?!=)/g);   // 속성 대입(점·대괄호 — 값이 글자든 변수든)
  const regMut31 = code31(/\b(?:Object\.(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\.(?:set|defineProperty))\(\s*MODULE_(?:TAB|VIEW)\b/g);   // 표를 바꾸는 도구의 첫 인자
  const regAli31 = code31(/(?:^|[^=!<>])=\s*MODULE_(?:TAB|VIEW)\b(?!\s*\[)/gm);   // 별칭(var t = MODULE_TAB → t.hw = …)
  const regDecl31 = code31(/\bMODULE_(?:TAB|VIEW)\s*=(?!=)/g), regVar31 = code31(/\bvar MODULE_(?:TAB|VIEW) = \{/g);   // 선언·재대입 = var 리터럴 선언 2곳뿐
  T('v431 검토 리터럴 밖 등록 금지: MODULE_TAB·MODULE_VIEW는 선언 리터럴 2곳(var … = {)에서만 채움 — 코드에 속성 대입(점·대괄호 — 값이 글자든 변수든) 0 · Object.assign·defineProperty 등으로 표를 바꾸는 곳 0 · 별칭 0 · 재선언·재대입 0(주석 속 설명은 뺌 · 4-2 뒤에도 유지)',
    regAsg31.length === 0 && regMut31.length === 0 && regAli31.length === 0 && regDecl31.length === 2 && regVar31.length === 2
    && regVar31.some((s) => /:var MODULE_TAB = \{$/.test(s)) && regVar31.some((s) => /:var MODULE_VIEW = \{$/.test(s)),
    JSON.stringify({ asg: regAsg31, mut: regMut31, ali: regAli31, decl: regDecl31 }));

  // ② 4-2 연결(정적, v434 — 4-1 경계를 뒤집음) — 앱 hw 판정은 정해진 4곳뿐(정확히): switchTab 길 막기(tabRoute 풀이 뒤·화면 켜기 앞) · applyPerms 전용 줄(빈 묶음 숨김 앞) ·
  //    renderHwWaste 첫 갈래 보기 안내(제출 칸 그리기 앞) · hwSubmitWaste 첫 줄 가드 — 그리고 hwFailText 첫 줄 NO_WRITE = HW_NO_WRITE ·
  //    화관법 입구 = 코드의 "hwakwan" 글자 5곳뿐(사이드바 버튼 · switchTab 길 막기·켜기·그리기 · applyPerms 전용 줄 — 바로가기·캘린더·전역 검색·홈·인박스·별칭 0) · tabHwakwanBtn 직접 읽기 0(MODULE_TAB으로만) ·
  //    gw-hwakwan.js: 로그인 → 기기 승인 → hp = hwPerm → 조회(hw_status·hw_job) 숨김 403 NO_ACCESS · 제출 수행 아님 403 NO_WRITE(handleWasteSubmit 호출 앞 — 호출은 그 1곳) · hp는 그 셋만(지금 실행 줄 0) ·
  //    제품 자동 제출 크론(gw-hwakwan-cron)·워커(run-background)는 권한 검사 없음(그대로 — 브리핑 steps[3].tests)
  const hwCalls31 = (html.match(/(?:canSee|canDo|permOf)\(\s*["']hw["']\s*\)/g) || []).length;
  const ap31 = fn31('applyPerms'), swt31 = fn31('switchTab'), rhw31 = fn31('renderHwWaste'), hsw31 = fn31('hwSubmitWaste'), hft31 = fn31('hwFailText');
  const body31 = (src) => src.slice(src.indexOf('{') + 1).replace(/^\s+/, '');
  //   applyPerms 전용 줄(v434 검토 반영): 숨김이면 홈, 볼 수 있으면 화관법 화면을 다시 그림(로그인 창 '전환'은 새로고침 없이 applyPerms만 돈다 — 실행은 ③·v434 ⓒ-2)
  const SW_G31 = 'if (name === "hwakwan" && !canSee("hw")) name = "dash";', AP_G31 = 'if (currentTab === "hwakwan"){ if (!canSee("hw")) switchTab("dash"); else renderHwakwan(); }';
  const swOk31 = swt31.split(SW_G31).length === 2 && swt31.indexOf('name = rt.tab;') > 0 && swt31.indexOf(SW_G31) > swt31.indexOf('name = rt.tab;') && swt31.indexOf(SW_G31) < swt31.indexOf('currentTab = name;') && swt31.indexOf(SW_G31) < swt31.indexOf('getElementById("view-hwakwan")');
  const apOk31 = ap31.split(AP_G31).length === 2 && ap31.indexOf(AP_G31) < ap31.indexOf('빈 그룹 숨김') && ap31.indexOf(AP_G31) > ap31.indexOf('MODULES.forEach(');
  const rhwB31 = rhw31.slice(rhw31.indexOf('if (!host) return;') + 'if (!host) return;'.length).replace(/^\s+/, '');
  const rhwOk31 = rhw31.indexOf('if (!host) return;') > 0 && rhwB31.indexOf('if (!canDo("hw")){') === 0 && rhwB31.indexOf('보기 권한 — 제출은 수행 권한자만') > 0 && rhwB31.indexOf('return;') < rhwB31.indexOf('hwSubmitBtn') && rhwB31.indexOf('보기 권한 — 제출은 수행 권한자만') < rhwB31.indexOf('return;');
  const hswOk31 = body31(hsw31).indexOf('if (!canDo("hw")){ alert(HW_NO_WRITE); return; }') === 0, hftOk31 = body31(hft31).indexOf('if (code === "NO_WRITE") return HW_NO_WRITE;') === 0;
  const hwq31 = code31(/["']hwakwan(?::[\w:]*)?["']/g);
  const srvFn31 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } return ''; };
  const hH31 = srvFn31(hwk31, 'handler');
  const ord31 = ['const c = await currentMember(event);', "if (!(await deviceApproved(event, c.member))) return jr(403, { ok: false, code: 'DEVICE_NOT_APPROVED', request_id: R });", 'const hp = hwPerm(c.member);',
    "case 'hw_status': if (hp === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', error: HW_ERR_NO_ACCESS, request_id: R }); return await handleStatus(st, R);",
    "case 'hw_waste_submit': if (hp !== 'do') return jr(403, { ok: false, code: 'NO_WRITE', error: HW_ERR_NO_WRITE, request_id: R }); return await handleWasteSubmit(st, c, d, R);",
    "case 'hw_run_now': return await handleRunNow(st, c, d, R);",
    "case 'hw_job': if (hp === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', error: HW_ERR_NO_ACCESS, request_id: R }); return await handleJob(st, d, R);"].map((s) => hH31.indexOf(s));
  const ordOk31 = ord31.every((p, i) => p > 0 && (i === 0 || p > ord31[i - 1]));
  //   (v434 검토) 거절 몸체의 사람 말 error — 상수 두 개는 handler 밖 한 번씩 선언(옛 앱이 이 글을 괄호 안·현황 카드에 보여 준다: 제출 글 = 수행 권한 없음·정부에 제출되지 않음, 조회 글 = 화관법 권한 없음)
  const errNW31 = (hwk31.match(/\nconst HW_ERR_NO_WRITE = '([^'\n]+)';\n/) || [])[1] || '', errNA31 = (hwk31.match(/\nconst HW_ERR_NO_ACCESS = '([^'\n]+)';\n/) || [])[1] || '';
  const errOk31 = errNW31.indexOf('화관법 수행 권한이 없어 제출하지 않았습니다') === 0 && errNW31.indexOf('이 요청은 정부에 제출되지 않았습니다.') > 0 && errNA31.indexOf('화관법 권한이 없습니다') === 0
    && (hwk31.replace(/\/\/[^\n]*/g, '').match(/\bHW_ERR_NO_WRITE\b/g) || []).length === 2 && (hwk31.replace(/\/\/[^\n]*/g, '').match(/\bHW_ERR_NO_ACCESS\b/g) || []).length === 3;   // 선언 1 + 쓰는 곳(제출 1·조회 2) — 주석 속 언급은 세지 않음
  const hwPermOk31 = /function hwPerm\(member\) \{\s*if \(member && member\.admin\) return 'do';\s*return \(member && member\.perms && member\.perms\.hw\) \|\| 'hide';\s*\}/.test(hwk31);
  const hpN31 = (hH31.match(/\bhp\b/g) || []).length, hwsN31 = (hwk31.match(/handleWasteSubmit\(/g) || []).length;
  T('v431 → v434 4-2 연결(정적): 앱 hw 판정 정확히 4곳 — switchTab 길 막기(tabRoute 풀이 뒤·화면 켜기 앞)·applyPerms 전용 줄(MODULES 루프 뒤·빈 묶음 숨김 앞 — 숨김이면 홈·볼 수 있으면 renderHwakwan 다시 그림)·renderHwWaste 첫 갈래 보기 안내(제출 칸 앞에서 return)·hwSubmitWaste 첫 줄 가드 · hwFailText 첫 줄 NO_WRITE = HW_NO_WRITE · 코드의 "hwakwan" 글자 5곳(사이드바 버튼·switchTab 셋·applyPerms 하나 — 바로가기·캘린더·전역 검색·홈·인박스·별칭 0) · tabHwakwanBtn 직접 읽기 0·view-hwakwan은 switchTab 켜기 1곳 · gw-hwakwan: 로그인 → 기기 승인 → hwPerm(관리자 do·perms.hw·없으면 hide) → 조회 숨김 NO_ACCESS·제출 수행 아님 NO_WRITE(handleWasteSubmit 호출 앞·호출 1곳 — 몸체 error = 사람 말 상수 HW_ERR_NO_ACCESS·HW_ERR_NO_WRITE)·hp는 그 셋만(지금 실행 0) · 크론·워커 권한 검사 없음',
    hwCalls31 === 4 && swOk31 && apOk31 && rhwOk31 && hswOk31 && hftOk31 && hwq31.length === 5
    && html.indexOf('getElementById("tabHwakwanBtn")') < 0 && (html.match(/getElementById\("view-hwakwan"\)/g) || []).length === 1 && /document\.getElementById\("view-hwakwan"\)\.classList\.toggle\("active", name === "hwakwan"\);/.test(html)
    && hwPermOk31 && ordOk31 && errOk31 && hpN31 === 4 && hwsN31 === 2
    && [hwc31, hwb31].every((s) => s.length > 500 && !/\bperms\b|permOf|canDo|NO_WRITE|NO_ACCESS|hwPerm/.test(s)),
    JSON.stringify({ calls: hwCalls31, sw: swOk31, ap: apOk31, rhw: rhwOk31, hsw: hswOk31, hft: hftOk31, hwq: hwq31, perm: hwPermOk31, ord: ord31, err: errOk31, hp: hpN31, hws: hwsN31 }));

  // ③ applyPerms 실행(실제 원문 — v434 4-2로 기대값을 뒤집음) — hw도 MODULES 루프를 탄다(getElementById(undefined) 호출 0 — 가짜 문서에 id "undefined" 요소를 두어 잘못 건드리면 보이게) ·
  //    관리자·김정아형(수행)·가상형(수행 + 차량 숨김) = 화관법 탭 보임·화면 읽기 전용 아님·화관법 탭에 둔 채 다시 로그인해도(afterLogin → applyPerms) 그대로 ·
  //    권민지·정재욱형(보기) = 탭 보임·화관법 화면 읽기 전용(제출 칸 대신 안내는 renderHwWaste — v434 묶음)·그대로 · 김호태형(숨김)·현장형(값 없음 — 기본 숨김) = 탭 숨김·화관법 탭에 있었으면 홈(다른 탭이면 그대로) ·
  //    (v434 검토) 화관법 탭에 있던 볼 수 있는 사람(수행·보기·관리자)은 renderHwakwan 다시 그림 정확히 1번(로그인 창 '전환'이 새로고침 없이 applyPerms만 돌림 — 그림 결과는 v434 ⓒ-2) ·
  //    숨김은 다시 그림 0(홈으로만) · 다른 탭(차량)에 있으면 누구도 다시 그림 0 · 다른 키는 그대로 판정(루프가 통째로 꺼지지 않았는지)
  const mkCl31 = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); return s.has(c); }, contains: (c) => s.has(c) }; };
  const mkEl31 = (id) => ({ id, classList: mkCl31(), style: {}, getAttribute: () => null, querySelectorAll: () => [] });
  const runAp31 = (who, perm, cur) => {
    const D = {}, calls = [], log = [];
    Object.values(MT31).concat(Object.values(MV31), ['tabHwakwanBtn', 'view-hwakwan', 'tabSafetyBtn', 'sfSubBar', 'undefined']).forEach((id) => { D[id] = mkEl31(id); });
    const st = new Function('__D', '__who', '__perm', '__log', '__calls', '__cur', [
      'var document = { getElementById: function(id){ __calls.push(id); return Object.prototype.hasOwnProperty.call(__D, String(id)) ? __D[String(id)] : null; }, querySelectorAll: function(){ return []; } };',
      'var currentTab = __cur, safetyLayer = "site", eduViewScope = "member";',
      'function isAdmin(){ return __who === "admin"; } function permOf(m){ return isAdmin() ? "do" : (__perm[m] || "hide"); } function canSee(m){ return permOf(m) !== "hide"; } function canDo(m){ return permOf(m) === "do"; }',
      'function switchTab(n){ __log.push("switch:" + n); currentTab = n; } function updateUserChip(){} function updateApprovalBadges(){}',
      'function renderHwakwan(){ __log.push("render:hw@" + currentTab); }',   // v434 검토 — 전용 줄의 다시 그림(누가·어느 탭에서)
      'function renderHwWaste(){ __log.push("renderHwWaste@" + currentTab); }',   // 다시 그림을 폐기물 칸만으로 줄이는 결함(▶ 지금 실행이 안 바뀜)이 ReferenceError로 묶음 '검사 생략'이 아니라 이 검사 ✗로 보이게
      'function renderSites(){} function loadAsb(){} function loadEdu(){} function loadWorkers(){ return { then: function(){} }; } function renderEdu(){}',
      MOD_STMT31, MT_STMT31, MV_STMT31, fn31('safetyPanes'), fn31('setSafetyLayer'), fn31('applySafetyPerms'), ap31,
      'applyPerms(); return { cur: currentTab };'].join('\n'))(D, who, perm, log, calls, cur);
    return { D, log, calls, st };
  };
  const P31 = {
    admin: ['admin', {}],
    kja: ['staff', { hw: 'do', site: 'do', lic: 'do', veh: 'do', wk: 'do', con: 'do', check: 'do', doc: 'view', promo: 'do' }],   // 김정아형(PM 부여 뒤)
    kmj: ['staff', { hw: 'view', safety: 'do', veh: 'do', lic: 'view', wk: 'view', con: 'do', check: 'do', doc: 'view', promo: 'do' }],   // 권민지형
    jjw: ['staff', { hw: 'view', site: 'do', veh: 'do', lic: 'view', wk: 'do', con: 'do', check: 'do', doc: 'view', tasks: 'view' }],   // 정재욱형
    kht: ['staff', { hw: 'hide', veh: 'view', check: 'do', doc: 'view', wk: 'view' }],   // 김호태형(hw 숨김)
    fld: ['staff', { veh: 'view', check: 'do', doc: 'view' }],   // 현장 8명형(hw 값 없음 — 배포 직후 전원)
    vh: ['staff', { hw: 'do', veh: 'hide', check: 'do' }],   // 가상형 — 차량 숨김(다른 키 판정이 살아 있는지)
  };
  const R31 = {}; Object.keys(P31).forEach((k) => { R31[k] = runAp31(P31[k][0], P31[k][1], 'hwakwan'); });
  const khtV31 = runAp31(P31.kht[0], P31.kht[1], 'veh');   // 숨김인 사람이 다른 탭(차량)에 있으면 전용 줄은 움직이지 않는다
  const kmjV31 = runAp31(P31.kmj[0], P31.kmj[1], 'veh'), kjaV31 = runAp31(P31.kja[0], P31.kja[1], 'veh');   // (v434 검토) 보기·수행인 사람도 다른 탭에 있으면 화관법 다시 그림 0
  const hid31 = (r, id) => r.D[id].classList.contains('perm-hidden'), ro31 = (r, id) => r.D[id].classList.contains('readonly');
  const clean31 = (r) => !r.calls.some((x) => x === undefined || x === 'undefined') && !r.D.undefined.classList.contains('perm-hidden') && !r.D.undefined.classList.contains('readonly');
  const sig31 = (r) => (hid31(r, 'tabHwakwanBtn') ? 'T-' : 'T+') + (ro31(r, 'view-hwakwan') ? 'R' : '') + (r.log.indexOf('switch:dash') >= 0 ? '→홈' : '') + '@' + r.st.cur;
  T('v431 applyPerms 실행(실제 원문 — v434 4-2): hw도 MODULES 루프를 탐(getElementById(undefined) 호출 0·가짜 "undefined" 요소 그대로) · 관리자·김정아형(수행)·가상형(수행 + 차량 숨김) = 화관법 탭 보임·읽기 전용 아님·화관법 탭에 둔 채 다시 로그인하면 그 탭에서 화관법 화면 다시 그림 1번(홈 이동 0) · 권민지·정재욱형(보기) = 탭 보임·화관법 화면 읽기 전용·다시 그림 1번 · 김호태형(숨김)·현장형(값 없음) = 탭 숨김·화관법 탭에 있었으면 홈(다시 그림 0 — 차량 탭에 있었으면 그대로) · 보기·수행이어도 차량 탭에 있으면 다시 그림 0 · 다른 키는 그대로(차량 숨김 = 차량 탭 숨김, 차량 보기 = 차량 화면 읽기 전용, 홍보 숨김 = 홍보 탭 숨김)',
    Object.keys(R31).every((k) => clean31(R31[k])) && clean31(khtV31) && clean31(kmjV31) && clean31(kjaV31)
    && ['admin', 'kja', 'vh'].every((k) => sig31(R31[k]) === 'T+@hwakwan' && R31[k].log.join(',') === 'render:hw@hwakwan') && ['kmj', 'jjw'].every((k) => sig31(R31[k]) === 'T+R@hwakwan' && R31[k].log.join(',') === 'render:hw@hwakwan')
    && ['kht', 'fld'].every((k) => sig31(R31[k]) === 'T-→홈@dash' && R31[k].log.join(',') === 'switch:dash') && sig31(khtV31) === 'T-@veh' && khtV31.log.length === 0
    && sig31(kmjV31) === 'T+R@veh' && kmjV31.log.length === 0 && sig31(kjaV31) === 'T+@veh' && kjaV31.log.length === 0
    && hid31(R31.vh, 'tabVehBtn') && !hid31(R31.kht, 'tabVehBtn') && ro31(R31.kht, 'view-veh') && !ro31(R31.kja, 'view-veh') && hid31(R31.kht, 'tabPromoBtn') && !hid31(R31.kja, 'tabPromoBtn')
    && !Object.keys(MT31).some((k) => hid31(R31.admin, MT31[k])),
    Object.keys(R31).map((k) => k + ':' + sig31(R31[k]) + '[' + R31[k].log.join('+') + ']' + (clean31(R31[k]) ? '' : '·undefined 호출')).join(' · ') + ' · khtV:' + sig31(khtV31) + ' · kmjV:' + sig31(kmjV31) + '[' + kmjV31.log.join('+') + '] · kjaV:' + sig31(kjaV31) + '[' + kjaV31.log.join('+') + ']');

  // ④ 권한관리 표(renderPermMgmt 실행) + 칸 누름(pmCycle·pmSave 실행) — '화관법' 열이 차량 다음, 값 없는 직원은 '숨김', 관리자 행은 고정 /
  //    PM 순서: 김정아 1번 → 수행·1초 뒤 저장 1번(hw "do") · 권민지 2번 연달아 → 보기·저장 1번(hw "view" — 첫 예약은 취소) · 정재욱 2번을 띄워서 → 저장 2번(do 뒤 view) · 다른 열(차량)과 같은 순환·같은 1초
  const mem31 = [
    { id: 'a1', name: '관리자', role: '관리자', admin: true, perms: {} },
    { id: 'k1', name: '김정아형', role: '팀장', dept: '운영부', admin: false, perms: { tasks: 'hide', veh: 'do', site: 'do', lic: 'do', safety: 'hide' } },
    { id: 'k2', name: '권민지형', role: '직원', dept: '운영부', admin: false, perms: { tasks: 'hide', veh: 'do', safety: 'do', lic: 'view' } },
    { id: 'k3', name: '정재욱형', role: '직원', dept: '운영부', admin: false, perms: { veh: 'do', site: 'do', safety: 'hide', hw: 'hide' } }];
  const timers31 = [], sent31 = [], stat31 = {}, D31 = { permRoster: { innerHTML: '', querySelectorAll: () => [] }, permTotal: { textContent: '' } };
  const pmApi31 = new Function('__D', '__mem', '__timers', '__sent', '__stat', [
    'var members = __mem; var pmSaveTimers = {};',
    'var document = { getElementById: function(id){ if (String(id).indexOf("pmstat-") === 0) return (__stat[id] = __stat[id] || { textContent: "" }); return __D[id] || null; } };',
    'function isAdmin(){ return true; } function switchTab(){} function liveMembers(){ return members; } function memberRetired(){ return false; } function isBossMember(){ return false; } function esc(s){ return String(s); } function tierBadgeHtml(){ return ""; } function tierOfMember(){ return "admin"; }',
    'var TIER_TXT = { admin: "관리자" }; var ROLE_ORDER = ["개발자","대표","관리자","팀장","직원","현장직"];',
    'function findMember(id){ for (var i = 0; i < members.length; i++){ if (members[i].id === id) return members[i]; } return null; }',
    'function setTimeout(f, ms){ __timers.push({ f: f, ms: ms }); return __timers.length; } function clearTimeout(t){ if (__timers[t - 1]) __timers[t - 1].f = null; }',
    'function gwCall(fn, body){ __sent.push({ fn: fn, body: JSON.parse(JSON.stringify(body)) }); return { then: function(){ return { catch: function(){} }; } }; }',
    'function renderApprGrades(){} function renderAssignCard(){} function renderNotifyCard(){} function renderAlertsCard(){} function renderConProcCard(){} function renderConLearnCard(){} function renderBriefCard(){} function renderAutoRulesCard(){} function renderDocSettings(){} function saveUsersCache(){} function render(){}',
    MOD_STMT31, stmt31(/var PERM_CLOSED = \{[^}]+\};/), stmt31(/var MOD_LABEL = \{[^}]+\};/), stmt31(/var PERM_ORDER = \[[^\]]+\];/), stmt31(/var PM_TXT = \{[^}]+\};/), stmt31(/var PM_NEXT = \{[^}]+\};/),
    fn31('pmVal'), fn31('permModList'), fn31('renderPermMgmt'), fn31('pmCycle'), fn31('pmSave'),
    'return { render: function(){ renderPermMgmt(); return __D.permRoster.innerHTML; }, click: function(id, mod){ var b = { className: "", textContent: "" }; pmCycle(id, mod, b); return b.className + "|" + b.textContent; }, member: findMember };'].join('\n'))(D31, JSON.parse(JSON.stringify(mem31)), timers31, sent31, stat31);
  const fire31 = () => { const fs = timers31.filter((t) => t.f).map((t) => t.f); timers31.forEach((t) => { t.f = null; }); fs.forEach((f) => f()); return fs; };   // 살아 있는 예약(1초 뒤 저장)을 지금 돌린다
  const html31 = pmApi31.render();
  const heads31 = [...html31.matchAll(/<th(?: class="pm-nm")?>([^<]+)<\/th>/g)].map((m) => m[1]);
  const cell31 = (id, mod) => { const m = html31.match(new RegExp('class="pm-cell pm-(\\w+)" data-pm-cyc="' + id + ':' + mod + '">([^<]+)<')); return m ? m[1] + '|' + m[2] : '-'; };
  const PO31 = ((html.match(/var PERM_ORDER = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, ''));
  const c1 = pmApi31.click('k1', 'hw'), t1 = timers31.filter((t) => t.f).map((t) => t.ms); const f1 = fire31().length, s1 = sent31.slice();
  const c2a = pmApi31.click('k2', 'hw'), c2b = pmApi31.click('k2', 'hw'), live2 = timers31.filter((t) => t.f).length; fire31(); const s2 = sent31.slice(s1.length);
  const c3a = pmApi31.click('k3', 'hw'); fire31(); const c3b = pmApi31.click('k3', 'hw'); fire31(); const s3 = sent31.slice(s1.length + s2.length);
  const cv1 = pmApi31.click('k1', 'veh'), cv2 = pmApi31.click('k1', 'veh'), tv = timers31.filter((t) => t.f).map((t) => t.ms); fire31();
  const hwOf31 = (s) => s.map((x) => x.fn + ':' + x.body.action + ':' + x.body.id + ':' + (x.body.perms || {}).hw).join(',');
  T('v431 권한관리 표(renderPermMgmt·pmCycle·pmSave 실행): 머리 열 = 이름 + PERM_ORDER 라벨(… 차량 / 화관법 / 안전 …) · 값 없는 직원(김정아·권민지형)·명시 숨김(정재욱형) 화관법 칸 = "숨김" · 관리자 행 "모든 권한 고정"(열 ' + PO31.length + '칸 묶음) / 김정아 1번 → "수행"·1초 뒤 저장 1번(perms 전체 + hw do, 다른 칸 그대로) · 권민지 2번 연달아 → "보기"·저장 1번(hw view — 첫 예약 취소) · 정재욱 2번 띄워서 → 저장 2번(do → view) · 차량 열도 같은 순환(수행 → 보기)·같은 1초',
    heads31.join('/') === ['이름'].concat(PO31.map((k) => ML31[k])).join('/') && heads31.join(' / ').indexOf('차량 / 화관법 / 안전') > 0
    && cell31('k1', 'hw') === 'hide|숨김' && cell31('k2', 'hw') === 'hide|숨김' && cell31('k3', 'hw') === 'hide|숨김' && cell31('a1', 'hw') === '-'
    && html31.indexOf('<td colspan="' + PO31.length + '" class="pm-admin">관리자(관리자) — 모든 권한 고정') > 0
    && c1 === 'pm-cell pm-do|수행' && t1.join(',') === '1000' && f1 === 1 && hwOf31(s1) === 'gw-auth:member_upsert:k1:do' && s1[0].body.perms.veh === 'do' && s1[0].body.perms.site === 'do' && s1[0].body.perms.safety === 'hide' && Object.keys(s1[0].body).sort().join(',') === 'action,id,perms'
    && c2a === 'pm-cell pm-do|수행' && c2b === 'pm-cell pm-view|보기' && live2 === 1 && hwOf31(s2) === 'gw-auth:member_upsert:k2:view'
    && c3a === 'pm-cell pm-do|수행' && c3b === 'pm-cell pm-view|보기' && hwOf31(s3) === 'gw-auth:member_upsert:k3:do,gw-auth:member_upsert:k3:view'
    && cv1 === 'pm-cell pm-view|보기' && cv2 === 'pm-cell pm-hide|숨김' && tv.join(',') === '1000',
    JSON.stringify({ heads: heads31.slice(7, 12), cells: [cell31('k1', 'hw'), cell31('k2', 'hw'), cell31('k3', 'hw')], c1, t1, s1: hwOf31(s1), c2: [c2a, c2b, live2, hwOf31(s2)], c3: [c3a, c3b, hwOf31(s3)], veh: [cv1, cv2, tv] }));

  // ⑤ 권한 재확인(refreshMemberPerms 실행 — v434 4-2로 기대값을 뒤집음) — MODULE_TAB.hw가 생겨 화관법 칸만 바뀐 저장도 '권한이 바뀌었습니다' 새로고침(탭·제출 칸이 바뀐다 —
  //    PM이 대신 제출을 맡기거나(보기 → 수행) 되돌릴 때 그 직원 앱이 화면 복귀 때 새로 고침) · 값 없음 → 숨김(인사 카드 저장 등에서 cleanPerms가 굳힘)은 같은 실효값이라 새로고침 없음 ·
  //    연결된 다른 키는 종전대로 · 키만 먼저 등록하는 단계 흉내(MODULE_TAB에서 hw를 뺌 — v431 4-1 모양) = 화관법 칸만 바뀌면 새로고침 없음(permsSameEff 건너뛰기 안전장치가 살아 있음)
  const rmp31 = (cur, nm, mtStmt) => { const log = []; new Function('__cur', '__nm', '__log', [MOD_STMT31, mtStmt || MT_STMT31, stmt31(/var PERM_CLOSED = \{[^}]+\};/), fn31('pmVal'), fn31('permsSameEff'),
    'var curMemberObj = __cur, permRefreshAt = 0, localStorage = { setItem: function(){} }, location = { reload: function(){ __log.push("reload"); } };',
    'function gwToken(){ return "tok"; } function curMember(){ return curMemberObj; } function setTimeout(f){ f(); } function gwToast(m){ __log.push("toast:" + m); }',
    'function gwCall(fn, body){ __log.push(fn + ":" + body.action); return { then: function(f){ f({ status: 200, body: { valid: true, member: __nm } }); return { catch: function(){} }; } }; }',
    fn31('refreshMemberPerms'), 'refreshMemberPerms();'].join('\n'))(cur, nm, log); return log; };
  const kja31 = { tasks: 'hide', veh: 'do', rec: 'hide', lic: 'do', site: 'do', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'do', quote: 'hide', promo: 'hide', safety: 'hide' };   // v430 뒤 김정아 저장값 모양(hw 없음)
  const mm31 = (perms) => ({ id: 'u1', name: '직원', admin: false, perms });
  const w31 = (o) => Object.assign({}, kja31, o);
  const mt41_31 = MT_STMT31.replace(', hw:"tabHwakwanBtn"', '');   // 키만 먼저 등록하는 단계 흉내(v431 4-1 모양) — MODULE_TAB에 hw가 없으면
  const q1 = rmp31(mm31(kja31), mm31(w31({ hw: 'do' }))), q2 = rmp31(mm31(w31({ hw: 'do' })), mm31(w31({ hw: 'view' }))), q3 = rmp31(mm31(w31({ hw: 'view' })), mm31(w31({ hw: 'hide' })));
  const q4 = rmp31(mm31(kja31), mm31(w31({ hw: 'do', veh: 'view' }))), q5 = rmp31(mm31(kja31), mm31(w31({ safety: 'do' }))), q6 = rmp31(mm31(kja31), mm31(w31({ hw: 'do' })), mt41_31);
  const q7 = rmp31(mm31(kja31), mm31(w31({ hw: 'hide' }))), q8 = rmp31(mm31(w31({ hw: 'view' })), mm31(w31({ hw: 'do' })));   // 값 없음 → 숨김(같은 실효값) · 대신 제출 맡김(보기 → 수행)
  const rel31 = (l) => l.indexOf('reload') >= 0 && l.some((x) => x.indexOf('toast:권한이 바뀌었습니다') === 0);
  T('v431 권한 재확인(refreshMemberPerms 실행 — v434 4-2): 화관법 칸만 바뀐 저장(값 없음 → 수행 · 수행 → 보기 · 보기 → 숨김 · 대신 제출 맡김 보기 → 수행) = "권한이 바뀌었습니다" 새로고침(탭·제출 칸이 바뀜) · 값 없음 → 숨김(cleanPerms가 굳힘 — 같은 실효값) = 새로고침 없음 · 차량·안전 칸이 바뀐 저장 = 종전대로 새로고침 · 키만 먼저 등록하는 단계 흉내(MODULE_TAB에서 hw를 뺌) = 화관법 칸만 바뀌면 새로고침 없음(건너뛰기 안전장치)',
    [q1, q2, q3, q8].every(rel31) && rel31(q4) && rel31(q5) && q6.join(',') === 'gw-auth:verify' && q7.join(',') === 'gw-auth:verify' && mt41_31 !== MT_STMT31,
    JSON.stringify({ q1, q2, q3, q4, q5, q6, q7, q8 }));

  // ⑥ 문서 — MANUAL 21-2 '화관법' 열·27절 안내(v434 4-2 상태로 — 적용 뒤 숨김·보기·수행, '아직 적용 전' 글 0) · FEATURES 기준·v431 절·§8 열 순서 · CLAUDE.md 화관법 줄(v434 연결 상태) ·
  //    TESTLIST v431 절(운영 확인·16명 칸이 AI 몫, PM 몫 칸 없음 — 지난 판 기록이라 그대로) · sw ≥ 431
  const sec31 = (a, b) => { const i = man31.indexOf(a); return i < 0 ? '' : man31.slice(i, man31.indexOf(b, i + a.length)); };
  const m212_31 = sec31('<h3>21-2. 권한관리</h3>', '<h3>21-3.'), m27_31 = sec31('<h2 id="s27">', '<h2 id="s28">');
  const tlv31 = (() => { const i = tl31.indexOf('\n## v431'); if (i < 0) return ''; const j = tl31.indexOf('\n## ', i + 5); return tl31.slice(i, j < 0 ? tl31.length : j); })();
  const ft8_31 = ft31.split('\n').filter((ln) => ln.indexOf('- **권한관리 매트릭스**') === 0)[0] || '';
  //   (v431 검토) TESTLIST에는 'PM 몫'이라는 글자가 한 곳도 없다 — 사람 몫 칸은 '(관리자)'·'(기기마다 앱을 완전히 닫고 다시 열기)'·표식 없는 '- [ ] …' 꼴이라
  //   글자 검사만으로는 못 잡는다. v431 절 체크 칸(들여쓴 칸·[x] 포함) 전부가 '(AI'로 시작해야 한다(6칸 이상 — 빈 절이 통과하지 않게, 칸을 [x]로 닫아도 그대로 통과).
  const cb31 = tlv31.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi31 = cb31.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l));
  T('v431 문서(v434 4-2 상태): MANUAL 21-2 \'화관법\' 열(기본 숨김·관리자 수행 고정·적용 v434 — 숨김 = 탭 없음·보기 = 안내·수행만 제출·서버도 막음·한 번 수행·두 번 보기·한 분씩·대신 제출 27절 — "아직 화면·제출에 적용되지 않습니다" 0) · 27절(권한 필요 표시·적용 안내 — "아직 적용되지 않습니다"·"열 값과 관계없이" 0) · FEATURES 기준 ≥ v431·v431 절·§8 열 순서 차량·화관법·안전·§8 화관법 열 적용 글 · CLAUDE.md 화관법 줄(v434 4-2 연결 — MODULE_TAB.hw·MODULE_VIEW.hw, "넣지 않는다" 0) · TESTLIST v431 절(김정아·권민지·정재욱 운영 저장값·16명 칸, 체크 칸 전부 AI 몫 — PM·관리자·표식 없는 칸 0) · sw ≥ 431',
    m212_31.indexOf('<li><b>화관법</b> 열도 기본 숨김입니다(새 회원은 팀장도 숨김, 관리자 행은 수행 고정, 2026-11 v431 · 화면·제출 적용 v434). <b>숨김</b>이면 사이드바에 화관법 탭이 없고, <b>보기</b>면 탭과 제품 자동 현황만 보이며 폐기물 칸 자리에 \'보기 권한 — 제출은 수행 권한자만\' 안내가 나오고, <b>수행</b>인 분만 폐기물 운반계획서를 냅니다(서버도 막습니다).') > 0
    && m212_31.indexOf('숨김 칸을 <b>한 번</b> 누르면 수행, 두 번 누르면 보기입니다 — 부서 단위로 한꺼번에 주지 말고 한 분씩 주세요. 김정아 님이 없을 때 대신 제출하는 법(보기 칸을 2번 눌러 수행, 끝나면 1번 눌러 보기)은 27절에 있습니다.') > 0
    && m212_31.indexOf('아직 화면·제출에 적용되지 않습니다') < 0 && m212_31.indexOf('적용은 다음 단계에서') < 0
    && m27_31.indexOf('<h2 id="s27">27. 화관법 — 유해화학물질 운반계획서 <span class="tag ad">권한 필요</span>') === 0
    // (v434 검토) 27절 안내는 문단 전체를 고정한다 — 옛 4-1 조건이 4-1 문장 전체를 고정했던 강도 그대로(첫 문장만 보면 '숨김이면 그대로 있고'·'지금 실행은 이 열이 수행인 분만'·'보기·숨김 제출도 정부에 나감' 같은 틀린 글이 통과)
    && m27_31.indexOf('<div class="note">이 탭은 권한관리 표의 <b>\'화관법\' 열</b>을 따릅니다(2026-11 v434). <b>숨김</b>이면 사이드바에 화관법이 없고, <b>보기</b>면 탭과 제품 자동 현황(↻ 새로고침 포함)은 보이지만 폐기물 칸 자리에 <b>보기 권한 — 제출은 수행 권한자만</b> 안내가 나옵니다. 폐기물 운반계획서는 <b>수행</b>인 분과 관리자만 냅니다 — 보기·숨김 권한으로 보낸 제출은 서버가 거절하고 정부에 나가지 않습니다. 제품 자동 제출(평일 07:30)과 관리자의 <span class="btn">▶ 지금 실행</span>은 이 열과 관계없이 그대로입니다. 열 값 정하는 법은 21-2에 있습니다.</div>') > 0
    && m27_31.indexOf('아직 적용되지 않습니다') < 0 && m27_31.indexOf('열 값과 관계없이 로그인한 모든 분') < 0
    && Number((ft31.match(/기준: v(\d+) /) || [0, 0])[1]) >= 431 && ft31.indexOf('\n### v431 (11/10)') > 0 && ft8_31.indexOf('차량·화관법·안전·현장·인허가·문서함') > 0   // v432: 기준은 다음 판으로 올라간다 — '= sw 판'은 맨 앞 검사가 본다
    && ft8_31.indexOf("'화관법' 열(hw — v431 메뉴 56 4-1 등록, v434 4-2 적용)이 화관법 탭의 권한") > 0 && ft8_31.indexOf('아직 화면·제출에 적용 전') < 0
    && cl31.indexOf('- **화관법(hw) 키**(v431 메뉴 56 4-1 등록 · v434 4-2 연결') >= 0 && cl31.indexOf('`MODULE_TAB.hw = tabHwakwanBtn`·`MODULE_VIEW.hw = view-hwakwan`') > 0
    && cl31.indexOf('**`MODULE_TAB`·`MODULE_VIEW`에 넣지 않는다**') < 0 && cl31.indexOf('예외: 화관법 hw는 gw-data에 저장 데이터가 없어 `COL`에 없다') > 0
    && tlv31.indexOf('김정아 hw=do') > 0 && tlv31.indexOf('권민지 hw=view') > 0 && tlv31.indexOf('정재욱 hw=view') > 0 && tlv31.indexOf('16명') > 0 && tlv31.indexOf('PM 몫') < 0
    && cb31.length >= 6 && cbNotAi31.length === 0
    && Number((sw31.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 431,
    JSON.stringify({ m212: m212_31.length, m27: m27_31.length, tl: tlv31.length, ft8: ft8_31.length, cl: cl31.indexOf('**화관법(hw) 키**'), cb: cb31.length, notAi: cbNotAi31.map((l) => l.slice(0, 40)) }));

  // ⑥-2 (v431 검토) 한 층만 고친 문서 — FEATURES v431 '배포 뒤 PM'·TESTLIST 운영 칸의 누르는 때(배포 전부터 열린 옛 v430 앱은 hw를 기본 숨김으로 몰라 첫 저장이 '수행'이면
  //      화면 복귀 때 새로고침 한 번 — 김정아 님 제출 창 입력 유실 — 지난 판 기록이라 그대로) · MANUAL 21-2 첫 문단 '서버가 강제' 문장(v434: 4-1 동안 붙였던 화관법 열 예외를 걷어 냄 — 이제 서버가 hw를 강제) ·
  //      21-3 감사로그 키 범례 hw · CLAUDE.md '지금 실행' = hw 검사를 더하지 않음(관리자·개발자 검사 ADMIN_ONLY는 그대로 — gw-hwakwan handleRunNow)
  const ftv31 = (() => { const i = ft31.indexOf('\n### v431 (11/10)'); if (i < 0) return ''; const j = ft31.indexOf('\n### ', i + 5); return ft31.slice(i, j < 0 ? ft31.length : j); })();
  const ftPm31 = ftv31.split('\n').filter((ln) => ln.indexOf('- **배포 뒤 PM**') === 0)[0] || '';
  const tlOp31 = cb31.filter((l) => l.indexOf('(AI가 운영 저장값으로 확인') >= 0)[0] || '';
  const m212p31 = (m212_31.match(/<p>[\s\S]*?<\/p>/) || [''])[0], m213_31 = sec31('<h3>21-3.', '<h3>21-4.');
  const fnSrc31 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } return ''; };
  T('v431 검토 문서: FEATURES v431 \'배포 뒤 PM\'·TESTLIST 운영 칸 = 누르는 때(권장 배포 다음 날 아침 이후 —옛 v430 앱은 hw를 기본 숨김으로 몰라 첫 저장이 수행이면 새로고침 한 번)·권민지·정재욱 1초 안에 2번 · MANUAL 21-2 첫 문단 "서버가 강제" 문장(v434 — 4-1 화관법 열 예외 걷어 냄, "아직 적용 전" 0) · 21-3 감사로그 키 범례에 hw · CLAUDE.md \'지금 실행\' = hw 검사를 더하지 않음(ADMIN_ONLY 그대로 — "권한 검사 없이 그대로" 0)',
    ftPm31.indexOf('**누르는 때(권장) = 배포 다음 날 아침 이후**') > 0 && ftPm31.indexOf('1초 안에') > 0 && ftPm31.indexOf('옛 앱(v430)은 hw를 기본 숨김으로 몰라') > 0
    && tlOp31.indexOf('배포 다음 날 아침 이후(권장') > 0 && tlOp31.indexOf('1초 안에') > 0
    && m212p31.indexOf('지시를 뺀 나머지 탭은 서버가 강제하므로 화면 조작으로 우회할 수 없습니다.') > 0 && m212p31.indexOf('아직 적용 전') < 0
    && m213_31.indexOf('hw = 화관법 열(2026-11 v431)') > 0
    && cl31.indexOf("'지금 실행'에는 hw 권한 검사를 더하지 않는다(지금 실행의 관리자·개발자 검사 ADMIN_ONLY는 종전대로)") > 0 && cl31.indexOf("'지금 실행'은 권한 검사 없이 그대로") < 0
    && /if \(!\(c\.member\.admin \|\| c\.member\.dev\)\) return jr\(403, \{ ok: false, code: 'ADMIN_ONLY'/.test(fnSrc31(hwk31, 'handleRunNow')),
    JSON.stringify({ pm: ftPm31.length, op: tlOp31.length, p: m212p31.length, a: m213_31.length }));
} catch (e) { console.log('  (v431 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v432(11/10 메뉴 56 5단계, PM 11/9 "56. ㄱ"): 안전 › 현황(읽기 전용, 앱만) — 브리핑 steps[4]·코드 지도 code.steps[5](지도에서는 6단계).
//      ① 상수 대조(안전 항목 26개 id · 의무 대장 번호 · 계약 안전 서류 키) ①-2 구간 안 인허가 판정 줄 ② 읽기 전용(구간에 저장 호출·서버 직접 호출·원장 대입·완료 조작·완료 버튼·입력 0,
//      구간이 부르는 바깥 함수 = 허용 목록, 읽기 로더는 get만, 관리자 홈 변경도 저장 0) ③ 칩·칸 정적 + 칩 3개 줄(폰 375px 폭·flex-wrap) + 칩 줄 표시 규칙 실행
//      ④ renderSafetyNow 실행 — 관리자형·권민지형(가상 safety 수행)·현장만형(김정아형)·블록 권한 가상형·읽기 실패형·기다림형·블록 오류형 ⑤ 이동(sfNowGo 실행)
//      ⑥ 읽기(sfNowOpen·loadEdu·loadAsb 실행 — 현황을 열 때만, 현황 읽기는 보류 훅 없이) ⑦ 관리자 홈 만기 목록(교육·검진 줄 합침, 새 타일 없음) ⑧ 문서·sw
//      v432 검토 반영(지적 28건 재확인 뒤): ①-3 중처법 쌍 · ②-2 간접 저장 길·noHooks 1곳·계약 표 상태 · ③-2 폰 줄 배치 CSS · ④-2 실패 안내 · ④-3 타이머 실제 실행 · ④-4 날짜 갈래 · ④-5 빈 자료 · ④-6 의무 대장 회사 잇기 · ⑧-2 문서 내용
//      + 표본에 30일 경계 현장 4·교육 옛 이력·퇴사자·지운 일용직, ⑤ 수시 줄·도착 자리·계약 칩 풀기·폰 상세 카드, ⑥ 30초 안 다시 열기·force 없음·홈일 때만, ⑦ 명부 1번 읽기
let SFNOW32 = null;   // v436: 이 묶음의 현황 시험 틀(run32 — 구간 원문을 실제 판정 함수와 함께 실행)·표본(base32)·자르기 도구를 v436 묶음이 다시 쓴다(없으면 v436 묶음은 '검사 생략' = 실패)
try {
  const fn32 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const rd32 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const sw32 = rd32('sw.js'), man32 = rd32('MANUAL.html'), cl32 = rd32('CLAUDE.md'), ft32 = rd32('FEATURES.md'), tl32 = rd32('TESTLIST.md');
  const stmt32 = (src, re) => { const m = src.match(re); if (!m) throw new Error('문장 없음: ' + re); return m[0]; };
  const sA32 = html.indexOf('// @safety-now-start'), sB32 = html.indexOf('// @safety-now-end');
  if (sA32 < 0 || sB32 < sA32 || html.indexOf('// @safety-now-start', sA32 + 5) >= 0 || html.indexOf('// @safety-now-end', sB32 + 5) >= 0) throw new Error('@safety-now 구간 표식이 없거나 두 번');
  const sec32 = html.slice(sA32, sB32);
  const code32 = sec32.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');   // 주석을 뺀 코드

  // ① 상수 — 안전 항목 26개(GROUPS·SUDSI id — 문구는 거기서 읽음) · 의무 대장 번호(duties_seed no, 61 없음) · 계약 안전 서류 키(CON_PACKETS 항목 키)
  const ids32 = ((sec32.match(/var SF_NOW_CHECK = \[([^\]]+)\]/) || ['', ''])[1].match(/"(\w+)"/g) || []).map((s) => s.replace(/"/g, ''));
  const WANT32 = 'w1,m1,m3,q1,h1,h2,h3,h4,h5,h6,h7,y1,y2,y3,y4,y5,y6,y11,y15,y16,y17,y18,su1,su3,su5,su6';
  const grpSrc32 = html.slice(html.indexOf('var GROUPS = ['), html.indexOf('var TYPE_LABEL = '));
  const sudSrc32 = html.slice(html.indexOf('var SUDSI = ['), html.indexOf('];', html.indexOf('var SUDSI = [')) + 2);
  const itemRe32 = /\{id:"(\w+)", title:"([^"]+)"/g;
  const gItems32 = [...grpSrc32.matchAll(itemRe32)].map((m) => [m[1], m[2]]), sItems32 = [...sudSrc32.matchAll(itemRe32)].map((m) => [m[1], m[2]]);
  const known32 = new Map(gItems32.concat(sItems32));
  const miss32 = ids32.filter((id) => !known32.has(id)), dupT32 = ids32.filter((id) => known32.has(id) && sec32.indexOf(known32.get(id)) >= 0);
  T('v432 ① 안전 항목 26개(SF_NOW_CHECK) = 코드 지도 목록 그대로(w1·m1·m3·q1·h1~h7·y1~y6·y11·y15~y18·su1·su3·su5·su6) · 전부 GROUPS(' + gItems32.length + ')·SUDSI(' + sItems32.length + ')에 실재 · 겹침 0 · 제목을 구간에 다시 적지 않음(sfNowItem이 GROUPS·SUDSI에서 읽음 — 문구 그대로)',
    ids32.join(',') === WANT32 && new Set(ids32).size === 26 && miss32.length === 0 && dupT32.length === 0 && gItems32.length >= 30 && sItems32.length === 6
    && /if \(GROUPS\[i\]\.items\[j\]\.id === id\)/.test(fn32('sfNowItem')) && /if \(SUDSI\[k\]\.id === id\)/.test(fn32('sfNowItem')),
    '없음: ' + miss32.join(',') + ' / 제목 다시 적음: ' + dupT32.join(',') + ' / ' + ids32.join(','));
  const seedNo32 = new Set((JSON.parse(rd32('data/duties_seed.json')).items || []).map((d) => d.no));
  const dM32 = sec32.match(/var SF_NOW_DUTY = \{ cycle: \[([^\]]+)\], event: \[([^\]]+)\], na: \[([^\]]+)\] \};/);
  const nums32 = (s) => String(s || '').split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x));
  const dC32 = dM32 ? nums32(dM32[1]) : [], dE32 = dM32 ? nums32(dM32[2]) : [], dN32 = dM32 ? nums32(dM32[3]) : [], dAll32 = dC32.concat(dE32, dN32);
  // ③ 꼬리말 표기(브리핑 그대로 '4·14·15·16~24·…' — 인허가별로 끊음)를 펼친 번호 = 주기 문구 + 따로 판정 상수(어긋나면 화면 안내와 실제 줄이 다르다)
  const footM32 = sec32.match(/의무 대장 안전 행 = ([\d·~]+)행\(61행 제외, 62행 '해당 없음'\)/);
  const footNos32 = footM32 ? footM32[1].split('·').reduce((a, p) => { const q = p.split('~').map(Number); if (q.length === 2) { for (let n = q[0]; n <= q[1]; n++) a.push(n); } else a.push(q[0]); return a; }, []) : [];
  T('v432 ① 의무 대장 번호(SF_NOW_DUTY): 주기 문구 23행(4·14·15·16~24·27~30·51~53·55~57·59) + 따로 판정 32 + 해당 없음 62 = 전부 data/duties_seed.json no에 실재 · 61 없음(시드에는 있음) · 겹침 0 · ③ 꼬리말 표기(' + (footM32 ? footM32[1] : '없음') + ')를 펼친 번호 = 주기 문구 + 32',
    !!dM32 && dC32.join(',') === '4,14,15,16,17,18,19,20,21,22,23,24,27,28,29,30,51,52,53,55,56,57,59' && dE32.join(',') === '32' && dN32.join(',') === '62'
    && dAll32.every((n) => seedNo32.has(n)) && dAll32.indexOf(61) < 0 && new Set(dAll32).size === dAll32.length && seedNo32.has(61)
    && footNos32.slice().sort((x, y) => x - y).join(',') === dC32.concat(dE32).sort((x, y) => x - y).join(','),
    JSON.stringify({ c: dC32, e: dE32, n: dN32, notSeed: dAll32.filter((n) => !seedNo32.has(n)), foot: footNos32 }));
  const cpSrc32 = html.slice(html.indexOf('  var CON_PACKETS = ['), html.indexOf('  function csPkWhen('));
  const pkApi32 = new Function([cpSrc32, fn32('csPkIk'), 'return { P: CON_PACKETS, ik: csPkIk };'].join('\n'))();
  const iks32 = []; pkApi32.P.forEach((pk) => pk.items.forEach((it0) => iks32.push(pkApi32.ik(pk, it0))));
  const conM32 = [...stmt32(sec32, /var SF_NOW_CON = \[[^\n]*\];/).matchAll(/\{ k: "([^"]+)", s: "([^"]+)" \}/g)].map((m) => [m[1], m[2]]);
  T('v432 ① 계약 안전 서류 키(SF_NOW_CON) 4개 = con|safety_plan · start|safety_pack · complete|safety_cost · complete|석면 완료보고서(별지 77호) — 전부 v427 패킷 항목 키(csPkIk)로 실재',
    conM32.map((x) => x[0]).join(',') === 'con|safety_plan,start|safety_pack,complete|safety_cost,complete|석면 완료보고서(별지 77호)' && conM32.every((x) => iks32.indexOf(x[0]) >= 0) && iks32.length > 20,
    JSON.stringify(conM32) + ' / 패킷 키 ' + iks32.length);
  // ①-3 (v432 검토) 중처법 줄 ↔ 내 업무 항목 매핑을 쌍으로 못 박는다(코드 지도 code.steps[5]·브리핑 steps[4]) — 3호↔7호(h2↔h1)처럼 같은 반기 항목끼리 바꿔도 알약이 같아 실행 검사로는 안 잡혔다.
  //      GROUPS 제목의 '(4조N호)' 표식(h1 (중처법 4조7호)·h2 (4조3호)·h3 (4조5호)·h4 (4조8호)·h5 (4조9호))과도 교차 대조
  const jcbSrc32 = stmt32(sec32, /var SF_NOW_JCB = \[[\s\S]*?\n  \];/);
  const jcbP32 = [...jcbSrc32.matchAll(/\{ no: "([^"]+)", t: "[^"]+", id: "(\w*)"/g)].map((m) => [m[1], m[2]]);
  const jcbMark32 = jcbP32.filter((x) => /^\d호$/.test(x[0]) && x[1]).map((x) => { const t = known32.get(x[1]) || ''; const mk = (t.match(/4조(\d)호/) || [])[1]; return mk ? (mk + '호' === x[0] ? 'ok' : x[0] + '≠' + x[1] + '(' + mk + '호)') : 'none:' + x[1]; });
  T('v432 ①-3 중처법 줄 ↔ 항목 쌍(SF_NOW_JCB) = 1호:y2 · 3호:h2 · 4호:y3 · 5호:h3 · 7호:h1 · 8호:h4 · 9호:h5 · 5조②3·4:h7 · 5조②1·2:(없음) · 2·6호:(없음) — 순서 그대로 · 제목에 (4조N호) 표식이 있는 항목(h1~h5)은 표식 번호 = 줄 번호, 표식 없는 y2·y3는 쌍 글자로만',
    jcbP32.map((x) => x.join(':')).join(',') === '1호:y2,3호:h2,4호:y3,5호:h3,7호:h1,8호:h4,9호:h5,5조②3·4:h7,5조②1·2:,2·6호:'
    && jcbMark32.filter((s) => s === 'ok').length === 5 && jcbMark32.filter((s) => s !== 'ok').join(',') === 'none:y2,none:y3',
    JSON.stringify({ pairs: jcbP32, mark: jcbMark32 }));
  // ①-2 구간 안 인허가 판정 = 블록 권한 줄 sfNowSee 1줄(③ 의무 대장·⑤ 인정·평가) — v429의 '파일 전체 3줄'은 구간 밖만 센다(현장 대장 낱말 검사는 파일 전체 그대로)
  const licIn32 = sec32.split('\n').filter((ln) => /canSee\(\s*["']lic["']\s*\)/.test(ln));
  T('v432 ①-2 구간 안 인허가 판정 = 블록 권한 줄 sfNowSee 1줄뿐(check·lic·con·site·doc 다섯 키) · 그 줄에 현장 대장 낱말 0',
    licIn32.length === 1 && /function sfNowSee\(\)\{ return \{ check: canSee\("check"\), lic: canSee\("lic"\), con: canSee\("con"\), site: canSee\("site"\), doc: canSee\("doc"\) \}; \}/.test(licIn32[0]) && !/asb|Asb|Sites|site_id|현장 대장/.test(licIn32[0]),
    licIn32.map((s) => s.trim().slice(0, 80)).join(' | '));

  // ② 읽기 전용 — 구간 코드(주석 뺌)에 저장 호출·서버 직접 호출·저장소·원장 대입·완료 조작 0, 마크업에 완료 버튼·체크·입력 0 · 구간이 부르는 바깥 함수 = 허용 목록(읽기·그리기·이동) · 읽기 로더는 get만
  const saveHits32 = code32.match(/\b(?:schedule\w*Save|doSave\w*|save\w*|\w+Save)\s*\(/g) || [];
  const gw32 = code32.match(/\b(?:gwCall|fetch|_rawFetch|XMLHttpRequest|sendBeacon)\b/g) || [];
  const store32 = code32.match(/\b(?:localStorage|sessionStorage|indexedDB)\b/g) || [];
  const ledgerAsg32 = code32.match(/(?<![.\w$])(?:records|customItems|checkScopes|checkAssignee|checkReview|licenses|duties|contracts|asb|edu|workers|documents|members|tasks|CDOC)\s*(?:\[[^\]\n]*\]|\.\w+)*\s*(?:=(?!=)|\+\+|--|\+=|-=)/g) || [];
  const propAsg32 = code32.match(/\.(?:pkst|status|st|del|docs|scope|assignee|items|next|date|done_at|updated|conc|worker_ids|member_ids)\s*(?:=(?!=)|\+\+|--)/g) || [];
  const mut32 = code32.match(/\b(?:toggleItem|approveCheck|rejectCheck|toggleTaskDone|csRowAct|csDocToggle|csDocNa|csDocAdd|csDocDel|csDoneStage|csSkipStage|csJumpStage|csUnskipStage|saveEdu|deleteEdu|saveAsb|deleteAsb|openEdu|openAsb|openLicModal|saveLicFromModal|deleteLicFromModal|hardDelete|bulkDelete|bulkRestore|reportErr|csSiteHooksRetry|csSiteDone|csLinkSite)\s*\(/g) || [];
  const ctl32 = sec32.match(/data-cs-(?:done|rchk|dchk|rna|dna|skip|jump|gen)|data-chk-(?:approve|reject)|data-mytask|data-home-check|data-todo-toggle|data-scope-id|appr-btn|type="checkbox"|<input|<select|<textarea|>\s*완료\s*</g) || [];
  const defs32 = new Set([...code32.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const locals32 = new Set([...code32.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*function/g)].map((m) => m[1]).concat(['fn']));   // fn = sfNowLoad가 받는 로더
  const KW32 = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new']);
  //   허용 목록의 renderContracts(그리기)에는 알려진 간접 저장 길이 1개 있다(v432 검토 — v432 전부터 계약 탭 동작): 계약 탭에 '단계·서류'로 펼쳐 둔 계약이 있으면
  //   renderContracts → csDetailHtml → csApprSync(계약당 60초 1회 — 결재 결과 동기화) → 결재가 바뀌었을 때만 scheduleContractSave. cdocLoad 응답도 renderContracts를 부른다.
  //   현황 구간이 내는 직접 저장은 0이고, 이 길은 아래 ②-2가 모양을 못 박고 문서(FEATURES·TESTLIST·CLAUDE.md)가 예외로 적는다 — 길이 늘거나 바뀌면 ②-2가 터진다
  //   v436: isAdmin = ⑤ [고치기] 버튼 글을 관리자에게만 그리는 판정(읽기만 — 누름 배선·창·저장은 구간 밖 @safety-set, v436 묶음 ⑦이 지킴)
  const ALLOW32 = ['canSee', 'checkItemVisible', 'scopeNames', 'getReview', 'todayStr', 'addDays', 'isDate', 'vehDday', 'esc', 'liveEdu', 'eduPersonName', 'eduKindLabel', 'eduLatest', 'findMember', 'memberRetired', 'liveLic', 'licVisible', 'liveDuties', 'liveSites', 'siteKind', 'siteLabel', 'asbNotifyDue', 'asbKeepUntil', 'asbNoSpecial',
    'csPkWhen', 'csPkIk', 'csFlow', 'csRowState', 'liveContracts', 'csSiteText', 'csKind', 'csPass', 'findProc', 'switchTab', 'setLicLayer', 'renderContracts', 'renderDocuments', 'loadEdu', 'loadAsb', 'loadWorkers', 'cdocLoad', 'isAdmin', 'String', 'Number', 'setTimeout', 'clearTimeout'];
  const calls32 = [...new Set([...code32.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].filter((n) => !KW32.has(n) && !defs32.has(n) && !locals32.has(n));
  const outside32 = calls32.filter((n) => ALLOW32.indexOf(n) < 0);
  const getOnly32 = (name, act) => { const b = fn32(name); return (b.indexOf('action:"' + act + '"') >= 0 || b.indexOf('action: "' + act + '"') >= 0) && !/action:\s*"(?:save|[a-z_]*(?:put|upsert|del|set|add|purge|restore|cur|mark))"/.test(b) && !/\b(?:schedule\w*Save|doSave\w*)\s*\(/.test(b); };
  const rdb32 = fn32('renderDashboard');
  const homeNew32 = rdb32.slice(rdb32.indexOf('var eduHome = '), rdb32.indexOf("html += dueMix.map(") + 60) + (rdb32.match(/\n[^\n]*sfNowHomeEduAsked[^\n]*/) || [''])[0];
  T('v432 ② 읽기 전용(정적): @safety-now 구간에 저장 호출 ' + saveHits32.length + ' · 서버 직접 호출 ' + gw32.length + ' · 저장소 ' + store32.length + ' · 원장 대입 ' + (ledgerAsg32.length + propAsg32.length) + ' · 완료 조작 호출 ' + mut32.length + ' · 완료 버튼·체크·입력 칸 ' + ctl32.length + ' = 전부 0 · 구간이 부르는 바깥 함수 ' + calls32.length + '개 = 읽기·그리기·이동 허용 목록 안 · 읽기 로더 5개(loadEdu·loadAsb·loadWorkers·cdocLoad · v436 loadSafetySet)는 get·cdoc_list·safety_settings_get만 · 현황 읽기의 loadAsb는 보류 훅 없이({ noHooks: true }) · 관리자 홈 변경 줄도 저장 0',
    saveHits32.length === 0 && gw32.length === 0 && store32.length === 0 && ledgerAsg32.length === 0 && propAsg32.length === 0 && mut32.length === 0 && ctl32.length === 0 && outside32.length === 0 && calls32.length >= 20
    && getOnly32('loadEdu', 'get') && getOnly32('loadAsb', 'get') && getOnly32('loadWorkers', 'get') && getOnly32('cdocLoad', 'cdoc_list') && getOnly32('loadSafetySet', 'safety_settings_get')
    && /sfNowLoad\("asb", loadAsb, \{ noHooks: true \}\)/.test(code32) && (code32.match(/loadAsb/g) || []).length === 1
    && homeNew32.length > 200 && !/\b(?:schedule\w*Save|doSave\w*|save\w*|\w+Save|gwCall)\s*\(/.test(homeNew32),
    JSON.stringify({ save: saveHits32, gw: gw32, store: store32, asg: ledgerAsg32.concat(propAsg32), mut: mut32, ctl: ctl32, outside: outside32 }));
  // ②-2 (v432 검토) ① 알려진 간접 저장 길(renderContracts → csDetailHtml → csApprSync → scheduleContractSave)의 모양 그대로 — 단계·서류 칸에서만·60초 1회·바뀐 때만 저장, cdocLoad 응답은 renderContracts만
  //      ② 보류 훅 우회(noHooks)는 파일 전체에서 현황의 loadAsb 부름 1곳뿐이고 opt.noHooks는 loadAsb 안에서만 읽는다(다른 읽기 경로가 계약 연결·종결 훅을 조용히 끄지 않게)
  //      ③ 현황이 바꾸는 계약 표 상태는 sfNowGo 계약 이동의 '칩·필터 풀기' 한 줄뿐(기기 저장 conSheetSave 0)
  const csd32 = fn32('csDetailHtml'), cas32 = fn32('csApprSync'), cdl32 = fn32('cdocLoad');
  const pathOk32 = (csd32.match(/csApprSync\(/g) || []).length === 1 && /if \(tab === "st"\)\{ csApprSync\(c\);/.test(csd32)
    && /if \(!force && csApprSyncAt\[c\.id\] && now - csApprSyncAt\[c\.id\] < 60000\) return;/.test(cas32) && (cas32.match(/scheduleContractSave\(\)/g) || []).length === 1 && /if \(changed\)\{ c\.updated = todayStr\(\); scheduleContractSave\(\); renderContracts\(\); \}/.test(cas32)
    && (cdl32.match(/renderContracts\(\)/g) || []).length === 2 && !/\b(?:schedule\w*Save|doSave\w*|csApprSync)\s*\(/.test(cdl32);
  const htmlNC32 = html.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');   // 줄 주석을 뺀 파일 전체(설명 글의 낱말은 세지 않는다)
  const noHookN32 = (htmlNC32.match(/noHooks\s*:/g) || []).length, optNH32 = (htmlNC32.match(/\.noHooks\b/g) || []).length, optNHin32 = (fn32('loadAsb').match(/opt\.noHooks/g) || []).length;
  const conAsg32 = code32.match(/conSheet(?:\.\w+|\[[^\]\n]*\])?\s*(?:=(?!=)|\+\+|--)/g) || [];
  //      ④ 허용 목록 함수를 부르는 자리도 고정 — 이동·그리기(switchTab·setLicLayer·renderContracts·renderDocuments)는 sfNowGo 안에서만, 로더(loadEdu·loadAsb·loadWorkers)는 sfNowOpen 1곳씩,
  //         서류함(cdocLoad)은 sfNowOpen·sfNowCons 1곳씩 — 허용 함수라도 다시 그림·그리기 길에 새로 끼우면(예: sfNowRefresh가 renderContracts를 늘 부름 → 결재 동기화 길이 매초) 터진다
  const nc32 = (s) => s.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
  const goB32 = nc32(fn32('sfNowGo')), openB32 = nc32(fn32('sfNowOpen')), consB32 = nc32(fn32('sfNowCons'));
  const cnt32 = (src, nm) => (src.match(new RegExp('(?<![.\\w$])' + nm + '\\s*\\(', 'g')) || []).length;   // 부름
  const ref32 = (src, nm) => (src.match(new RegExp('(?<![.\\w$])' + nm + '\\b', 'g')) || []).length;      // 부름 + 넘김(sfNowLoad("edu", loadEdu))
  //   v436: 안전 설정 로더 loadSafetySet도 같은 규칙(구간 안 1곳 = sfNowOpen — 다시 그림·그리기 길에서 읽지 않음)
  const siteCalls32 = ['switchTab', 'setLicLayer', 'renderContracts', 'renderDocuments'].map((nm) => nm + ':' + cnt32(code32, nm) + '/' + cnt32(goB32, nm))
    .concat(['loadEdu', 'loadAsb', 'loadWorkers', 'loadSafetySet'].map((nm) => nm + ':' + ref32(code32, nm) + '/' + ref32(openB32, nm)), ['cdocLoad:' + cnt32(code32, 'cdocLoad') + '/' + cnt32(openB32, 'cdocLoad') + '+' + cnt32(consB32, 'cdocLoad')]);
  const siteOk32 = ['switchTab', 'setLicLayer', 'renderContracts', 'renderDocuments'].every((nm) => cnt32(code32, nm) > 0 && cnt32(code32, nm) === cnt32(goB32, nm))
    && ['loadEdu', 'loadAsb', 'loadWorkers', 'loadSafetySet'].every((nm) => ref32(code32, nm) === 1 && ref32(openB32, nm) === 1)
    && cnt32(code32, 'cdocLoad') === 2 && cnt32(openB32, 'cdocLoad') === 1 && cnt32(consB32, 'cdocLoad') === 1;
  T('v432 ②-2 간접 저장 길·훅 우회·계약 표 상태·부르는 자리: renderContracts의 알려진 저장 길 1개 그대로(csDetailHtml이 단계·서류 칸에서만 csApprSync · 60초 1회 · 바뀐 때만 scheduleContractSave 1곳 · cdocLoad 응답은 renderContracts 2곳만) · "noHooks: true" 파일 전체 ' + noHookN32 + '곳(현황 loadAsb 부름만) · opt.noHooks는 loadAsb 안 ' + optNHin32 + '/' + optNH32 + ' · 현황이 바꾸는 계약 표 상태 = sfNowGo의 칩·필터 풀기 2개(기기 저장 0) · 이동·그리기 함수는 sfNowGo 안에서만·로더(v436 안전 설정 loadSafetySet 포함)는 sfNowOpen 1곳씩·서류함은 sfNowOpen·sfNowCons 1곳씩',
    pathOk32 && noHookN32 === 1 && /sfNowLoad\("asb", loadAsb, \{ noHooks: true \}\)/.test(htmlNC32) && optNH32 === optNHin32 && optNHin32 === 1
    && conAsg32.length === 2 && /if \(!csPass\(c, conSheet\.f, conSheet\.chip\)\)\{ conSheet\.f = \{\}; conSheet\.chip = ""; \}/.test(fn32('sfNowGo')) && !/conSheetSave/.test(code32)
    && siteOk32,
    JSON.stringify({ path: pathOk32, noHooks: noHookN32, opt: [optNHin32, optNH32], conAsg: conAsg32, site: siteCalls32 }));

  // ③ 칩·칸(정적) — 칩 줄 [현황 | 현장 | 교육·검진](현황 맨 앞) · 현황 칸(처음 숨김, sfNowHost·sfNowHead) · 현황 칩·칸은 레지스트리 밖(안전 권한 — applySafetyPerms가 숨김) · safetyPanes 맨 앞 now
  //    폰 375px(#app 좌우 16px → 343px): 칩 3개 폭(글꼴 13px — 큰 글자 1.3배까지)이 한 줄에 들고, 넘쳐도 .lsub-bar flex-wrap:wrap이라 가로로 밀리지 않음
  const divBlock32 = (src, openTag) => { const i = src.indexOf(openTag); if (i < 0) return ''; const re = /<div\b|<\/div>/g; re.lastIndex = i; let d = 0, m; while ((m = re.exec(src))) { d += m[0] === '</div>' ? -1 : 1; if (d === 0) return src.slice(i, m.index + 6); } return ''; };
  const vs32 = (() => { const i = html.indexOf('<section class="view" id="view-safety">'); return i < 0 ? '' : html.slice(i, html.indexOf('</section>', i)); })();
  const bar32 = divBlock32(vs32, '<div class="lsub-bar" id="sfSubBar">'), pNow32 = divBlock32(vs32, '<div class="sf-pane" id="sfPaneNow" style="display:none;">');
  const chips32 = [...bar32.matchAll(/<button class="lsub-btn(?: active)?" data-lsub="(\w+)" id="(\w+)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2], m[3]]);
  const cssBar32 = (html.match(/\.lsub-bar\{([^}]*)\}/) || ['', ''])[1], cssBtn32 = (html.match(/\.lsub-btn\{([^}]*)\}/) || ['', ''])[1];
  const fs32 = Number((cssBtn32.match(/font-size:(\d+(?:\.\d+)?)px/) || [0, 0])[1]), pd32 = (cssBtn32.match(/padding:(\d+)px (\d+)px/) || [0, 0, 0]).map(Number), gap32 = Number((cssBar32.match(/gap:(\d+)px/) || [0, 0])[1]);
  const wTxt32 = (t, f) => [...t].reduce((s, ch) => s + (/[가-힣]/.test(ch) ? f : (ch === '·' ? f * 0.45 : f * 0.6)), 0);
  const wBar32 = (f) => chips32.reduce((s, c) => s + wTxt32(c[2], f) + pd32[2] * 2 + 2, 0) + gap32 * (chips32.length - 1);
  const appPad32 = Number(((html.match(/#app\{[^}]*padding:(\d+)px (\d+)px/) || [0, 0, 0])[2])), avail32 = 375 - appPad32 * 2;
  const MT32 = (html.match(/var MODULE_TAB = \{([^}]+)\}/) || ['', ''])[1], MV32 = (html.match(/var MODULE_VIEW = \{([^}]+)\}/) || ['', ''])[1];
  T('v432 ③ 칩·칸(정적): 칩 줄 = 현황 sfChipNow(맨 앞) · 현장 · 교육·검진 · 현황 칸 sfPaneNow(.sf-pane, 처음 숨김) 안에 sfNowHead·sfNowHost·읽기 전용 안내 · 현황 칩·칸은 MODULE_TAB·MODULE_VIEW 밖 · safetyPanes 맨 앞 now(안전 권한)·applySafetyPerms가 현황 칩을 안전 권한으로 숨김 · 폰 375px 칩 줄 폭 ' + Math.round(wBar32(fs32)) + 'px(큰 글자 1.3배 ' + Math.round(wBar32(fs32 * 1.3)) + 'px) ≤ ' + avail32 + 'px · .lsub-bar flex-wrap:wrap · 칩 flex:none',
    chips32.map((c) => c.join(':')).join(',') === 'now:sfChipNow:현황,site:sfChipSite:현장,edu:sfChipEdu:교육·검진'
    && pNow32.indexOf('id="sfNowHost"') > 0 && pNow32.indexOf('id="sfNowHead"') > 0 && pNow32.indexOf('읽기 전용입니다') > 0 && html.split('id="sfPaneNow"').length === 2 && html.split('id="sfNowHost"').length === 2
    && MT32.indexOf('sfChipNow') < 0 && MV32.indexOf('sfPaneNow') < 0
    && /var out = \[\];\s+if \(canSee\("safety"\)\) out\.push\("now"\);\s+if \(canSee\("site"\)\) out\.push\("site"\);/.test(fn32('safetyPanes'))
    && /var nowChip = document\.getElementById\("sfChipNow"\);[^\n]*\n\s+if \(nowChip\) nowChip\.classList\.toggle\("perm-hidden", panes\.indexOf\("now"\) < 0\);/.test(fn32('applySafetyPerms'))
    && /document\.getElementById\("sfPaneNow"\)\.style\.display = \(name === "now"\) \? "" : "none";/.test(fn32('setSafetyLayer')) && /if \(name === "now"\) sfNowOpen\(\);/.test(fn32('setSafetyLayer'))
    && /flex-wrap:wrap/.test(cssBar32) && /flex:none/.test(cssBtn32) && fs32 === 13 && pd32[2] === 14 && appPad32 === 16 && wBar32(fs32 * 1.3) <= avail32 && /\.sfn-row \.item-meta\{white-space:normal;/.test(html),
    JSON.stringify({ chips: chips32, w: [wBar32(fs32), wBar32(fs32 * 1.3)], avail: avail32 }));
  // ③-2 (v432 검토) 폰 줄 배치(CSS 값 — 화면 실측은 TESTLIST 375px 칸): 공용 640px 규칙(.item 줄바꿈 + 본문 기준폭 62%)을 현황 줄만 덮어 알약이 늘 오른쪽(.sfn-row nowrap · 본문 flex:1 1 0 — 공용 .item-body 62%보다 구체적),
  //      줄 없는 카드의 공용 자동 여백(.card:not(:has(> .item)) — 특정도 0,3,0)을 같은 특정도 + 뒤 순서로 0 · 블록 머리 숫자가 넘치면 제목 아래로(h2 flex-wrap)
  const cssAt32 = (sel) => { const i = html.indexOf(sel + '{'); return i < 0 ? { i: -1, b: '' } : { i, b: html.slice(i + sel.length + 1, html.indexOf('}', i)) }; };
  const cRow32 = cssAt32('  .sfn-row'), cBody32 = cssAt32('  .sfn-row .item-body'), cCard32 = cssAt32('  .dash-sec.sfn-blk > .card'), cH2_32 = cssAt32('  .sfn-blk > h2'), cAuto32 = html.indexOf('.card:not(:has(> .item)):not(:has(> .add-row)){padding:12px 14px;}'), cMq32 = html.indexOf('    .item-body{flex:1 1 62%;}');
  T('v432 ③-2 폰 줄 배치(CSS): .sfn-row flex-wrap:nowrap · .sfn-row .item-body flex:1 1 0(공용 640px 규칙 뒤) · .dash-sec.sfn-blk > .card padding:0(공용 자동 여백 규칙 뒤) · .sfn-blk > h2 flex-wrap:wrap',
    /flex-wrap:nowrap/.test(cRow32.b) && /align-items:flex-start/.test(cRow32.b) && /^flex:1 1 0;?$/.test(cBody32.b) && cBody32.i > cMq32 && cMq32 > 0
    && /^padding:0;?$/.test(cCard32.b) && cCard32.i > cAuto32 && cAuto32 > 0 && /flex-wrap:wrap/.test(cH2_32.b) && cH2_32.i > html.indexOf('  .dash-sec h2{'),
    JSON.stringify({ row: cRow32.b, body: cBody32.b, card: cCard32.b, h2: cH2_32.b }));
  // ③ 실행 — 칩 줄 표시 규칙(safetyPanes·applySafetyPerms·setSafetyLayer 실제 원문, 칩 숨김 루프는 v428 ⑩이 같이 봄): 관리자(칩 3) 줄 보임·현황 칩 보임 / 권민지형(칩 2 — 현황·교육) 줄 보임 / 김정아형(칩 1) 줄 숨김·현황 칩 숨김
  const mkC32 = () => { const s = new Set(); return { toggle: (c, on) => { if (on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c) }; };
  const bar3_32 = (perm) => {
    const el = (id, a) => ({ id, attrs: a || {}, classList: mkC32(), style: {}, getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; }, querySelectorAll: () => [] });
    const D = { tabSafetyBtn: el('tabSafetyBtn'), sfSubBar: el('sfSubBar'), sfChipNow: el('sfChipNow', { 'data-lsub': 'now' }), asbMovedGo: el('asbMovedGo'), eduMovedHr: el('eduMovedHr'), eduMovedWk: el('eduMovedWk') };
    new Function('__D', '__perm', ['var document = { getElementById: function(id){ return __D[id] || null; } }; var currentTab = "dash", safetyLayer = "site";',
      'function canSee(m){ return (__perm[m] || "hide") !== "hide"; }', fn32('safetyPanes'), fn32('applySafetyPerms'), 'applySafetyPerms();'].join('\n'))(D, perm);
    return (D.sfSubBar.style.display === 'none' ? 'B-' : 'B+') + (D.sfChipNow.classList.contains('perm-hidden') ? 'N-' : 'N+') + (D.tabSafetyBtn.classList.contains('perm-hidden') ? 'T-' : 'T+');
  };
  const b3a32 = bar3_32({ safety: 'do', site: 'do' }), b3k32 = bar3_32({ safety: 'do' }), b3v32 = bar3_32({ safety: 'view' }), b3j32 = bar3_32({ site: 'do' }), b3n32 = bar3_32({});
  T('v432 ③ 칩 줄 표시 규칙(실행): 관리자형(칩 3) = 줄·현황 칩·탭 보임 · 권민지형(안전 수행 — 칩 2) = 줄·현황 칩 보임 · 안전 보기(가상) = 현황 칩 보임(읽기 전용 화면) · 김정아형(현장만 — 칩 1) = 줄 숨김(옛 현장 화면 그대로)·현황 칩 숨김 · 둘 다 없음 = 탭 숨김',
    b3a32 === 'B+N+T+' && b3k32 === 'B+N+T+' && b3v32 === 'B+N+T+' && b3j32 === 'B-N-T+' && b3n32 === 'B-N-T-', [b3a32, b3k32, b3v32, b3j32, b3n32].join(' / '));

  // ④ renderSafetyNow 실행 — 구간 원문 + 앱 원문 판정 함수(checkItemVisible·licVisible·asbNoSpecial·csPkWhen …)를 그대로 싣고, csFlow·csRowState만 표본(계약 판정의 같은 결과는 consheet가 본다)
  const SRC32 = {
    groups: stmt32(html, /var GROUPS = \[[\s\S]*?\n  \];/), sudsi: stmt32(html, /var SUDSI = \[[\s\S]*?\n  \];/), typeLabel: stmt32(html, /var TYPE_LABEL = \{[^}]*\};/), rank: stmt32(html, /var RANK_LIST = \[[^\]]*\];/),
    eduKinds: stmt32(html, /var EDU_KINDS = \[[\s\S]*?\n  \];/), siteKind: stmt32(html, /var SITE_KIND = \{[^}]*\};/), conKind: stmt32(html, /var CON_KIND_LABEL = \{[^}]*\};/), docMajor: stmt32(html, /var DOC_MAJOR = \{[^}]*\};/), packets: cpSrc32,
  };
  const seedBy32 = {}; (JSON.parse(rd32('data/duties_seed.json')).items || []).forEach((d) => { seedBy32[d.no] = d; });
  const TODAY32 = '2026-11-10';
  // v432 검토: r1 = 퇴사자형(교육 기록 e7은 기한 줄에서 빠져야 함)
  const mem32 = [{ id: 'a1', name: '관리자1', admin: true }, { id: 'a2', name: '관리자2', admin: true }, { id: 'a3', name: '관리자3', admin: true }, { id: 'k2', name: '권민지형', dept: '운영부', rank: '사원' }, { id: 'j1', name: '김정아형', dept: '운영부', rank: '대리' }, { id: 'r1', name: '퇴사자형', dept: '운영부', retired: true }];
  // 주기 키 — 앱 periodKeys와 같은 규칙(오늘을 바꿔 상반기·월요일·기한 달 갈래도 돌린다, v432 검토)
  const ck32 = (t) => { const d = new Date(t + 'T00:00:00'), p = (n) => (n < 10 ? '0' : '') + n, wd = d.getDay(), mon = new Date(d); mon.setDate(d.getDate() + (wd === 0 ? -6 : 1 - wd)); const y = d.getFullYear(), m = d.getMonth() + 1; return { weekly: mon.getFullYear() + '-' + p(mon.getMonth() + 1) + '-' + p(mon.getDate()), monthly: y + '-' + p(m), quarterly: y + '-Q' + Math.ceil(m / 3), half: y + '-H' + (m <= 6 ? 1 : 2), yearly: '' + y }; };
  const base32 = (over, today) => {
    const TD = today || TODAY32, ck = ck32(TD);
    const o = {
      today: TD, admin: true, perm: {}, me: { id: 'a1', admin: true }, members: mem32, workers: [{ id: 'w1', name: '김일용' }, { id: 'w2', name: '지운일용', del: 1 }],
      records: { weekly: {}, monthly: {}, quarterly: { [ck.quarterly]: { q1: '2026-10-05' } }, half: { [ck.half]: { h4: '2026-11-02' } }, yearly: { [ck.yearly]: { y2: '2026-01-20', y11: '2026-01-15' } } },
      review: { monthly: { [ck.monthly]: { m1: { by: '권민지형', date: '2026-11-08' } } } }, assignee: { w1: 'k2', m1: 'k2' }, scopes: { h3: ['a1', 'a2', 'a3'], h6: ['a1'], y5: ['dept:운영부'] },
      // e6 = 같은 사람·같은 종류의 옛 이수(다음 예정 지남 — e2가 최근이라 빠져야 함) · e7 퇴사자 · e8 명부에서 지운 일용직 · e9 명부에 없는 일용직 — 넷 다 기한 줄 없음(v432 검토)
      edu: [{ id: 'e1', ptype: 'worker', pid: 'w1', kind: 'special', date: '2026-09-01', next: '' }, { id: 'e2', ptype: 'member', pid: 'k2', kind: 'regular', date: '2026-05-20', next: '2026-11-20' }, { id: 'e3', ptype: 'worker', pid: 'w1', kind: 'spec_med', date: '2025-10-01', next: '2026-11-01' }, { id: 'e4', ptype: 'member', pid: 'a2', kind: 'super', date: '2026-01-01', next: '2027-01-01' }, { id: 'e5', ptype: 'member', pid: 'k2', kind: 'regular', date: '2026-05-01', next: '2026-11-15', del: 1 },
        { id: 'e6', ptype: 'member', pid: 'k2', kind: 'regular', date: '2025-11-12', next: '2026-05-12' }, { id: 'e7', ptype: 'member', pid: 'r1', kind: 'spec_med', date: '2025-11-15', next: '2026-11-15' }, { id: 'e8', ptype: 'worker', pid: 'w2', kind: 'spec_med', date: '2025-11-18', next: '2026-11-18' }, { id: 'e9', ptype: 'worker', pid: 'w9', kind: 'regular', date: '2026-05-19', next: '2026-11-19' },
        // e10 = 검토 지적 그대로의 꼴: 옛 이수(다음 예정 지남)가 있고 새 이수(e4)의 다음 예정은 30일 밖 — 옛 줄도 새 줄도 없어야 함
        { id: 'e10', ptype: 'member', pid: 'a2', kind: 'super', date: '2025-01-01', next: '2026-01-01' }],
      asb: [{ id: 's1', kind: 'asbestos', title: '남성초 석면', status: 'plan', start: '2026-11-20', end: '2026-11-25', member_ids: ['k2'], worker_ids: ['w1'] },
        { id: 's2', kind: 'asbestos', title: '영일만 슬레이트', status: 'done', start: '2026-10-20', end: '2026-10-31', conc: '', member_ids: [], worker_ids: [] },
        { id: 's3', kind: 'asbestos', title: '구룡포 옛 현장', status: 'done', start: '1996-11-01', end: '1996-11-20', conc: '0.001', member_ids: [], worker_ids: [] },
        { id: 's4', kind: 'dredge', title: '형산강 준설 현장', status: 'run', member_ids: [], worker_ids: [] },
        { id: 's5', kind: 'asbestos', title: '지운 현장', status: 'plan', start: '2026-11-15', del: 1 },
        { id: 's6', kind: 'asbestos', title: '진행중 석면', status: 'run', start: '2026-11-01', end: '2026-12-01', member_ids: [], worker_ids: [] },
        // 30일 경계(v432 검토): s7 예정·마감 지남(보여야 함) · s8 예정·마감 30일 밖 · s9 종료 30일 넘은 농도 미입력 · s10 보존 이미 만료 — s8~s10은 줄 없음
        { id: 's7', kind: 'asbestos', title: '경계 예정 지남', status: 'plan', start: '2026-11-12', member_ids: [], worker_ids: [] },
        { id: 's8', kind: 'asbestos', title: '경계 먼 예정', status: 'plan', start: '2027-01-30', member_ids: [], worker_ids: [] },
        { id: 's9', kind: 'asbestos', title: '경계 오래된 종료', status: 'done', start: '2026-07-20', end: '2026-08-01', conc: '', member_ids: [], worker_ids: [] },
        { id: 's10', kind: 'asbestos', title: '경계 보존 지난 현장', status: 'done', start: '1994-12-01', end: '1995-01-01', conc: '0.001', member_ids: [], worker_ids: [] }],
      licenses: [{ id: 'lseed13', name: '석면해체·제거업', scope: ['a1'] }, { id: 'lseed07', name: '화물자동차 운송사업' }, { id: 'lseed11', name: '발전사업 허가(태양광)' }, { id: 'lseed08', name: '유해화학물질 운반업' }],
      duties: [4, 16, 32, 61, 62].map((n) => seedBy32[n]),
      contracts: [{ id: 'c1', type: 'dredge', docType: 'public', status: 'run', client: '포항시<img src=x>', site: '형산강', title: '형산강 하천 정비', start: '2026-10-01', pipes: [] },
        { id: 'c2', type: 'asbestos', docType: 'public', elems: { asb: 1 }, status: 'run', client: '교육청', site: '남성초', start: '2026-11-05', pipes: [] },
        { id: 'c3', type: 'waste', docType: 'private', status: 'run', client: '사급 고객', start: '2026-08-01', pipes: [] },
        { id: 'c4', type: 'dredge', docType: 'public', status: 'done', client: '끝난 계약', start: '2026-07-01', pipes: [] },
        { id: 'c5', type: 'demolition', docType: 'public', status: 'run', client: '시청', start: '2026-09-01', pipes: [] },
        { id: 'c6', type: 'dredge', docType: 'public', status: 'run', client: '깨진 계약', __throw: 1, pipes: [] }],
      cdoc: { c1: { loaded: true, busy: false, err: '' }, c5: { loaded: false, busy: false, err: '500' }, c6: { loaded: true, busy: false, err: '' } },
      flows: { c1: { st: { 'main|0': [{ id: 'p~con~safety_plan', pk: [{ ik: 'con|safety_plan' }], refs: [], __st: 'done' }], 'main|1': [{ id: 'p~start~safety_pack', pk: [{ ik: 'start|safety_pack' }], refs: [], __st: 'todo' }, { id: 's~x', pk: [], refs: [{}], __st: 'done' }] }, loose: [{ id: 'p~complete~safety_cost', pk: [{ ik: 'complete|safety_cost' }], refs: [], __st: 'na' }] } },
      licOk: true, offline: false, colBase: { checklist: 1, contracts: 1, licenses: 1 }, st: { edu: 'ok', asb: 'ok', set: 'ok' }, ticks: 0, dutyThrow: false,
      // v436 안전 설정(settings:safety — @safety-set 구간의 상태 sfSet·sfSetDay·sfSetBy) — 기본 = 받았고 저장값 없음(운영 지금 상태 '미인정(입력 전)'). st.set을 안 준 표본은 'ok'(종전 표본은 설정과 무관)
      set: null, setDay: '', setBy: '',
    };
    return Object.assign(o, over || {});
  };
  // v432 검토: 타이머 콜백을 모아 실제로 돌린다(runTimers — 다시 그림이 틱을 세고 끝나는지, 그 사이 로더를 부르지 않는지) · cdocLoad는 기록하고 앱처럼 바로 자리(busy)를 만든다(늦게 온 계약 읽기)
  //   로더(loadEdu·loadAsb·loadWorkers)는 기록만 — 현황 그리기·다시 그림은 이것들을 부르면 안 된다(열 때 sfNowOpen만)
  const run32 = (o) => {
    const host = { innerHTML: '', querySelectorAll: () => { calls.qsa++; return []; } }, head = { textContent: '' }, timers = [], calls = { flow: [], state: [], cdoc: [], load: [], qsa: 0 };   // qsa = 칸을 갈아끼우고 줄을 다시 묶은 횟수 × 2
    const D = { sfNowHost: host, sfNowHead: head };
    const api = new Function('__o', '__D', '__timers', '__calls', [
      'var document = { getElementById: function(id){ return __D[id] || null; }, querySelectorAll: function(){ return []; } }; var console = { warn: function(){} };',
      'var __perm = __o.perm || {}, __admin = !!__o.admin, __me = __o.me || null, __cbs = [], __tid = 0;',
      'function isAdmin(){ return __admin; } function permOf(m){ return __admin ? "do" : (__perm[m] || "hide"); } function canSee(m){ return permOf(m) !== "hide"; } function canDo(m){ return permOf(m) === "do"; }',
      'function curMember(){ return __me; } function getMemberId(){ return __me && __me.id; }',
      'var members = __o.members, workers = __o.workers, records = __o.records, checkReview = __o.review, checkAssignee = __o.assignee, checkScopes = __o.scopes;',
      'var edu = __o.edu, asb = __o.asb, licenses = __o.licenses, duties = __o.duties, contracts = __o.contracts, CDOC = __o.cdoc, licRemoteOk = !!__o.licOk, isOffline = !!__o.offline, _colBase = __o.colBase;',
      'function findMember(id){ for (var i = 0; i < members.length; i++){ if (members[i].id === id) return members[i]; } return null; } function dispName(n){ return n || ""; } function isBossMember(){ return false; }',
      'function todayStr(){ return __o.today; } function setTimeout(f, ms){ __timers.push(ms); var id = ++__tid; __cbs.push({ id: id, f: f }); return id; } function clearTimeout(id){ for (var i = 0; i < __cbs.length; i++){ if (__cbs[i].id === id){ __cbs.splice(i, 1); return; } } }',
      'function cdocLoad(c, force){ __calls.cdoc.push(c.id + (force === undefined ? "" : ":" + force)); if (!CDOC[c.id]) CDOC[c.id] = { items: [], at: 0, busy: true, err: "", loaded: false }; }',
      'function loadEdu(){ __calls.load.push("edu"); } function loadAsb(){ __calls.load.push("asb"); } function loadWorkers(){ __calls.load.push("wk"); }',
      'function csFlow(c){ __calls.flow.push(c.id); if (c.__throw) throw new Error("깨진 계약"); return __o.flows[c.id] || { st: {}, loose: [] }; }',
      'function csRowState(c, r, fm){ __calls.state.push([c.id, r.__st, fm === __o.flows[c.id]]); return r.__st; }',
      __o_dutyFn32(o),
      SRC32.groups, SRC32.sudsi, SRC32.typeLabel, SRC32.rank, SRC32.eduKinds, SRC32.siteKind, SRC32.conKind, SRC32.docMajor, SRC32.packets,
      fn32('pad'), fn32('fmtDate'), fn32('mondayOfWeek'), fn32('periodKeys'), 'var CURRENT_KEYS = periodKeys(new Date(__o.today + "T00:00:00"));',
      fn32('esc'), fn32('isDate'), fn32('addDays'), fn32('vehDday'), fn32('asList'), fn32('memberName'), fn32('memberRetired'), fn32('scopeIncludes'), fn32('checkItemVisible'), fn32('getReview'), fn32('scopeNames'),
      fn32('liveEdu'), fn32('eduKindDef'), fn32('eduKindLabel'), fn32('eduPersonName'), fn32('eduLatest'), fn32('eduHasValidSpecial'),
      fn32('liveSites'), fn32('siteKind'), fn32('siteLabel'), fn32('asbNotifyDue'), fn32('asbKeepUntil'), fn32('asbNoSpecial'),
      fn32('liveLic'), fn32('licVisible'), fn32('liveContracts'), fn32('csPkWhen'), fn32('csPkIk'), fn32('csTitle'), fn32('csSiteText'), fn32('csKind'), fn32('findProc'),
      'var currentTab = "safety", safetyLayer = "now";',
      'var sfSet = __o.set === undefined ? null : __o.set, sfSetDay = __o.setDay || "", sfSetBy = __o.setBy || "";', stmt32(html, /var QUAL_DEF=\{[\s\S]*?\} \};/),   // v436 ⑤ — 안전 설정 상태(구간 밖 @safety-set 선언)·적격 계수(앱 등급 글)
      sec32,
      'sfNowSt.edu = __o.st.edu; sfNowSt.asb = __o.st.asb; sfNowSt.set = (__o.st.set === undefined ? "ok" : __o.st.set); sfNowTicks = __o.ticks || 0;',
      'return { render: function(){ renderSafetyNow(); return __D.sfNowHost.innerHTML; }, setTicks: function(n){ sfNowTicks = n; }, max: function(){ return SF_NOW_TICK_MAX; }, eduDue: sfNowEduDue, homeRow: sfNowHomeEduRow, ck: function(){ return CURRENT_KEYS; },',
      '  runTimers: function(n){ var k = 0; while (__cbs.length && k < n){ var t = __cbs.shift(); t.f(); k++; } return k; }, pending: function(){ return __cbs.length; }, ticks: function(){ return sfNowTicks; }, html: function(){ return __D.sfNowHost.innerHTML; },',
      '  setCons: function(cs){ contracts = cs; _colBase.contracts = 1; }, cdocSet: function(id, p){ var e = CDOC[id] || (CDOC[id] = {}); for (var k in p) e[k] = p[k]; }, setWorkers: function(w){ workers = w; } };'].join('\n'))(o, D, timers, calls);
    return { out: api.render(), head: head.textContent, timers, calls, api };
  };
  function __o_dutyFn32(o) { return o.dutyThrow ? 'function liveDuties(){ throw new Error("깨진 의무 대장"); }' : fn32('liveDuties'); }
  const blk32 = (out, k) => { const i = out.indexOf('data-sfn-blk="' + k + '"'); if (i < 0) return ''; const j = out.indexOf('data-sfn-blk="', i + 10); return out.slice(i, j < 0 ? out.length : j); };
  const order32 = (out) => [...out.matchAll(/data-sfn-blk="(\w+)"/g)].map((m) => m[1]).join(',');
  const rowIds32 = (s) => [...s.matchAll(/<span class="sfn-id">([^<]*)<\/span>/g)].map((m) => m[1]);
  const pillOf32 = (s, id) => { const m = s.match(new RegExp('<span class="sfn-id">' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<\\/span>[\\s\\S]*?<span class="sfn-pill([^"]*)">([^<]*)<\\/span><\\/div>')); return m ? (m[1].trim() || '-') + ':' + m[2] : ''; };
  const gos32 = (out) => [...out.matchAll(/data-sfn-go="([^"]+)"/g)].map((m) => m[1]);
  const goOk32 = (g) => /^check:(w1|m1|m3|q1|h[1-7]|y[1-6]|y11|y1[5-8]|su[1356])$/.test(g) || /^(site|duty|doc06|edu:member|edu:worker)$/.test(g) || /^con:c\d$/.test(g);
  SFNOW32 = { run32, base32, blk32, order32, rowIds32, pillOf32, gos32, goOk32, seedBy32, mem32 };

  const A32 = run32(base32());
  const aChk32 = blk32(A32.out, 'check'), aJcb32 = blk32(A32.out, 'jcb'), aDue32 = blk32(A32.out, 'due'), aCon32 = blk32(A32.out, 'con'), aCf32 = blk32(A32.out, 'confirm');
  const aHead32 = rowIds32(aChk32.slice(0, aChk32.indexOf('<details')));
  T('v432 ④ renderSafetyNow 관리자형(실행): 블록 순서 ①②③④⑤⑥ · ① 26줄(머리 숫자 완료 4·미완 7·지남 4·예정 7·수시 4 — 내 업무와 같은 이번 주기 records·승인 대기 review) · 앞 6줄 = 지남(w1 월요일 지남·y1 상반기·y3·y15 1월) → 미완(m1 승인 대기·m3), 나머지 20개는 펼침 안 · h3(공개범위 관리자 3명)도 보임 · 문구 = GROUPS 원문 · 머리 "기준 날짜"',
    order32(A32.out) === 'check,jcb,due,con,eval,confirm' && aChk32.indexOf('<span class="cnt">완료 4 · 미완 7 · 지남 4 · 예정 7 · 수시 4</span>') > 0 && rowIds32(aChk32).length === 26
    && aHead32.join(',') === 'w1,y1,y3,y15,m1,m3' && aChk32.indexOf('나머지 20개 펼치기') > 0
    && pillOf32(aChk32, 'w1') === 'bad:지남' && pillOf32(aChk32, 'm1') === 'am:승인 대기' && pillOf32(aChk32, 'q1') === 'ok:완료' && pillOf32(aChk32, 'h2') === '-:12월' && pillOf32(aChk32, 'y4') === '-:12월' && pillOf32(aChk32, 'y5') === 'am:미완' && pillOf32(aChk32, 'su1') === '-:수시'
    && aChk32.indexOf('>h3<') > 0 && aChk32.indexOf(known32.get('h3')) > 0 && aChk32.indexOf(known32.get('w1').replace(/\(/g, '(')) > 0 && aChk32.indexOf('담당 권민지형') > 0 && A32.head === '2026-11-10 기준',
    order32(A32.out) + ' / ' + aHead32.join(',') + ' / ' + (aChk32.match(/<span class="cnt">[^<]*<\/span>/) || [''])[0]);
  T('v432 ④ 관리자형 ② 중처법 반기 점검: 2026 하반기 · 10줄(1호 y2 완료 · 3호 h2 12월 · 4호 y3 지남 · 5호 h3 · 7호 h1 · 8호 h4 완료 · 9호 h5 · 5조②3·4 h7 · 5조②1·2 항목 없음(빨강, 누를 곳 없음) · 2·6호 현재 대상 아님) · 줄 메타 = 맞춘 항목 id + GROUPS 원문',
    aJcb32.indexOf('<span class="cnt">2026 하반기</span>') > 0 && rowIds32(aJcb32).join(',') === '1호,3호,4호,5호,7호,8호,9호,5조②3·4,5조②1·2,2·6호'
    && pillOf32(aJcb32, '1호') === 'ok:완료' && pillOf32(aJcb32, '3호') === '-:12월' && pillOf32(aJcb32, '4호') === 'bad:지남' && pillOf32(aJcb32, '8호') === 'ok:완료' && pillOf32(aJcb32, '5조②1·2') === 'bad:항목 없음' && pillOf32(aJcb32, '2·6호') === '-:현재 대상 아님'
    && aJcb32.indexOf('y2 ' + known32.get('y2')) > 0 && aJcb32.indexOf('data-sfn-go="check:y2"') > 0 && !/data-sfn-go="[^"]*"[^>]*>\s*<span class="sfn-id">5조②1·2/.test(aJcb32),
    rowIds32(aJcb32).join(','));
  const dueIds32 = rowIds32(aDue32.slice(0, aDue32.indexOf('<details')));
  T('v432 ④ 관리자형 ③ 30일 기한: 7건 날짜순(교육 기한 경과 D+9 → 예정 현장의 지난 작업신고 마감(지남) → 석면 작업신고 마감 D-3(예정 현장, 7일 안 빨강) → 보존 만료 D-10(1996 종료 + 30년) → 교육 D-10) 다음 특별교육 미이수 1명(권민지형 — 일용직은 이수)·완료 후 농도 미입력(10/31 종료) · 지운 현장·진행 중 현장의 지난 신고 마감·준설 현장·지운 교육·30일 밖 교육 없음 · 30일 경계(v432 검토): 마감 30일 밖 예정 현장·종료 30일 넘은 농도 미입력·보존 이미 만료 = 줄 없음 · 교육 이력(v432 검토): 같은 사람·같은 종류의 옛 이수(다음 예정 지남)·퇴사자·명부에서 지운 일용직·명부에 없는 일용직 = 줄 없음 · 의무 대장 펼침(4·16행 주기 문구 2개 · 32행 따로 판정 · 62행 해당 없음 · 61행 없음) · 출처 = 현장 대장 · 교육·검진 · 인허가 의무 대장',
    aDue32.indexOf('<span class="cnt">7건</span>') > 0 && aDue32.indexOf('<div class="sfn-src">현장 대장 · 교육·검진 · 인허가 의무 대장</div>') > 0
    && dueIds32.join(',') === '교육,현장,현장,현장,교육,현장,현장' && /기한 경과[\s\S]*경계 예정 지남 · 석면 작업신고 마감[\s\S]*남성초 석면 · 석면 작업신고 마감[\s\S]*기록 보존 만료[\s\S]*정기교육\(근로자\)[\s\S]*특별교육 미이수[\s\S]*완료 후 석면농도 미입력/.test(aDue32)
    && aDue32.indexOf('<span class="sfn-pill bad">D-3</span>') > 0 && aDue32.indexOf('<span class="sfn-pill bad">기한 경과</span>') > 0 && aDue32.indexOf('구룡포 옛 현장 · 기록 보존 만료') > 0 && aDue32.indexOf('<span class="sfn-pill am">1명</span>') > 0 && aDue32.indexOf('권민지형 — 배치 전 이수 필요') > 0
    && /경계 예정 지남 · 석면 작업신고 마감<\/div><div class="item-meta">착수 2026-11-12 7일 전 신고 · 마감 2026-11-05<\/div><\/div><span class="sfn-pill bad">지남<\/span>/.test(aDue32)
    && ['경계 먼 예정', '경계 오래된 종료', '경계 보존 지난 현장'].every((t) => aDue32.indexOf(t) < 0)
    && ['2026-05-12', '퇴사자형', '지운일용', '2026-11-18', '2026-11-19', '2026-01-01', '정기교육(관리감독자)', '(삭제된 일용직)', '(퇴사자)'].every((t) => A32.out.indexOf(t) < 0) && (aDue32.slice(0, aDue32.indexOf('<details')).match(/정기교육\(근로자\)/g) || []).length === 1
    && aDue32.indexOf('지운 현장') < 0 && aDue32.indexOf('진행중 석면 · 석면 작업신고') < 0 && aDue32.indexOf('형산강 준설 현장') < 0 && aDue32.indexOf('2027-01-01') < 0 && aDue32.indexOf('2026-11-15') < 0
    && aDue32.indexOf('의무 대장 안전 행 2개') > 0 && rowIds32(aDue32).filter((x) => /행$/.test(x)).join(',') === '4행,16행,32행,62행' && aDue32.indexOf('61행 제외') > 0 && aDue32.indexOf('>61행<') < 0
    && pillOf32(aDue32, '32행') === '-:따로 판정' && pillOf32(aDue32, '62행') === '-:해당 없음' && pillOf32(aDue32, '16행') === '-:주기 문구',
    dueIds32.join(',') + ' / ' + (aDue32.match(/<span class="cnt">[^<]*<\/span>/) || [''])[0]);
  T('v432 ④ 관리자형 ④ 계약 안전 서류: 진행 계약만(끝난 계약 빼고) 시작일 최근 순 · 관급 준설 = 안전보건관리계획서 ✓ · 안전 패킷 ✗ · 산업안전보건관리비 사용내역서 해당없음 → 1/2(csFlow 줄을 패킷 키로 찾아 csRowState 판정 그대로, 같은 fm) · 관급 석면 = 서류함 받기 전이라 "확인 중"(석면 완료보고서 포함 4종 — csPkWhen) · 서류함 오류 = "확인 실패" · 계약 한 건이 깨져도 그 줄만 "확인 실패" · 사급(안전 서류 줄 없음)은 꼬리말 건수 · csFlow는 서류함을 받은 계약만 · 발주처 글자는 이스케이프',
    aCon32.indexOf('<span class="cnt">진행 4건 · 빠짐 1</span>') > 0 && rowIds32(aCon32).join(',') === '석면,준설,철거,준설'
    && aCon32.indexOf('안전보건관리계획서 ✓ · 안전 패킷 ✗ · 산업안전보건관리비 사용내역서 해당없음 · 단계·서류 ›') > 0 && aCon32.indexOf('<span class="sfn-pill am">1/2</span>') > 0
    && aCon32.indexOf('안전보건관리계획서 · 안전 패킷 · 산업안전보건관리비 사용내역서 · 석면 완료보고서 — 서류함 확인 중') > 0 && aCon32.indexOf('<span class="sfn-pill">확인 중</span>') > 0
    && (aCon32.match(/<span class="sfn-pill bad">확인 실패<\/span>/g) || []).length === 2 && aCon32.indexOf('안전 서류 줄이 없는 진행 계약 1건') > 0 && aCon32.indexOf('끝난 계약') < 0
    && A32.calls.flow.join(',') === 'c1,c6' && A32.calls.state.length === 3 && A32.calls.state.every((x) => x[0] === 'c1' && x[2] === true) && A32.out.indexOf('<img') < 0 && aCon32.indexOf('포항시&lt;img src=x&gt;') > 0,
    rowIds32(aCon32).join(',') + ' / flow ' + A32.calls.flow.join(',') + ' / ' + (aCon32.match(/<span class="cnt">[^<]*<\/span>/) || [''])[0]);
  //   v436: ⑤ 자리 안내('7단계에서 채움')가 7단계 줄 셋으로 바뀌었다 — 버튼은 문서함 바로가기 + 관리자 ⑤ [고치기](data-sfn-set — 이동 data-sfn-go 아님) 2개(줄 내용은 v436 묶음 ①~⑥)
  T('v432 ④ 관리자형 ⑤⑥·통째: ⑤ 인정·평가 = v436 줄 셋(KOSHA · 석면 · 등록 — 이 표본은 의무 대장 17·18행 없음)·"7단계에서 채움" 0 · ⑥ 확인 필요 6줄(하도급·밀폐·폭염·장비·지입·작업 — 조문만, 누를 곳 없음) + 문서함 › 06 안전보건 열기 · 화면 전체에 완료 버튼·체크·입력 칸 0(버튼은 문서함 바로가기 1개 + v436 ⑤ [고치기] 1개 — 관리자) · 줄 이동 대상 전부 알려진 자리 · 읽는 중(석면 계약 서류함)이라 1초 뒤 다시 그림 1번',
    rowIds32(blk32(A32.out, 'eval')).join(',') === 'KOSHA,석면,등록' && A32.out.indexOf('7단계에서 채움') < 0 && rowIds32(aCf32).join(',') === '하도급,밀폐,폭염,장비,지입,작업' && (aCf32.match(/data-sfn-go=/g) || []).length === 1 && aCf32.indexOf('data-sfn-go="doc06">문서함 › 06 안전보건 열기 ›</button>') > 0
    && (A32.out.match(/<button/g) || []).length === 2 && (blk32(A32.out, 'eval').match(/<button type="button" class="sfn-go" data-sfn-set="1">고치기<\/button>/g) || []).length === 1 && !/<input|<select|<textarea|type="checkbox"|data-cs-|data-chk-|완료<\/button>/.test(A32.out)
    && gos32(A32.out).length > 20 && gos32(A32.out).every(goOk32) && A32.timers.join(',') === '1000',
    JSON.stringify({ gos: gos32(A32.out).filter((g) => !goOk32(g)), timers: A32.timers }));

  // 권민지형(가상 safety 수행 — PM 부여 뒤): 공개범위 걸린 h3(관리자 3명)·h6(관리자 1명)는 ①에도 ②(5호)에도 없고, 운영부 공개 y5는 보임 · 현장 권한 없음 → ③에 현장 줄·출처 없음 · 인허가 행 공개범위(석면해체·제거업 = 관리자만) → 16행 빠짐
  const K32 = run32(base32({ admin: false, me: { id: 'k2', dept: '운영부', rank: '사원' }, perm: { safety: 'do', check: 'do', lic: 'view', con: 'do', site: 'hide', doc: 'view', wk: 'view' } }));
  const kChk32 = blk32(K32.out, 'check'), kJcb32 = blk32(K32.out, 'jcb'), kDue32 = blk32(K32.out, 'due');
  T('v432 ④ 권민지형(실행 — 안전 수행·현장 숨김·인허가 보기): 공개범위가 걸린 h3(안전보건 담당자 업무수행 평가 — 관리자 3명)·h6가 ① 줄·② 5호·화면 어디에도 없음(id·문구 0) · 운영부 공개 y5와 본인 담당 w1·m1은 보임 · ① 24줄(예정 5) · 현장 블록 줄·출처 없음(현장 권한) · 의무 대장 16행(인허가 행 공개범위 밖) 빠지고 4·32·62행만 · ④⑤⑥·문서함 바로가기 그대로',
    order32(K32.out) === 'check,jcb,due,con,eval,confirm' && K32.out.indexOf('>h3<') < 0 && K32.out.indexOf(known32.get('h3')) < 0 && K32.out.indexOf('>h6<') < 0 && K32.out.indexOf(known32.get('h6')) < 0 && K32.out.indexOf('check:h3') < 0
    && kJcb32.indexOf('>5호<') < 0 && rowIds32(kJcb32).length === 9 && kChk32.indexOf('>y5<') > 0 && kChk32.indexOf('>w1<') > 0 && rowIds32(kChk32).length === 24 && kChk32.indexOf('예정 5 · 수시 4') > 0
    && kDue32.indexOf('<div class="sfn-src">교육·검진 · 인허가 의무 대장</div>') > 0 && rowIds32(kDue32).indexOf('현장') < 0 && kDue32.indexOf('석면') < 0
    && rowIds32(kDue32).filter((x) => /행$/.test(x)).join(',') === '4행,32행,62행' && kDue32.indexOf('의무 대장 안전 행 1개') > 0
    && blk32(K32.out, 'con').indexOf('1/2') > 0 && K32.out.indexOf('data-sfn-go="doc06"') > 0,
    order32(K32.out) + ' / ① ' + rowIds32(kChk32).length + ' / ③ ' + rowIds32(kDue32).join(','));
  const J32 = run32(base32({ admin: false, me: { id: 'j1', dept: '운영부' }, perm: { site: 'do', lic: 'do', check: 'do', con: 'do', doc: 'view', wk: 'do' } }));
  const V32 = run32(base32({ admin: false, me: { id: 'k2', dept: '운영부' }, perm: { safety: 'do', site: 'do' } }));
  //   v436: ⑤는 원천이 안전 설정이라 현황을 보는 사람 모두에게(종전 v432 자리 표시는 인허가 권한) — 인허가 권한이 없으면 ⑤ 안의 의무 대장 글만 빠진다('의무 대장' 낱말 0 그대로)
  T('v432 ④ 현장만형(김정아형 — 안전 권한 없음) = 현황을 그리지 않음(빈 칸·타이머 0) · 블록 권한 가상형(안전·현장만, 체크·인허가·계약·문서함 숨김) = ①②④ 블록째 없음("0건" 아님)·③ 현장·교육 줄만(의무 대장·꼬리말 없음)·⑤ 인정·평가는 보임(v436 — 의무 대장 글 없음)·⑥ 문서함 바로가기 없음',
    J32.out === '' && J32.timers.length === 0
    && order32(V32.out) === 'due,eval,confirm' && V32.out.indexOf('0건') < 0 && blk32(V32.out, 'due').indexOf('석면 작업신고 마감') > 0 && V32.out.indexOf('의무 대장') < 0 && V32.out.indexOf('doc06') < 0 && blk32(V32.out, 'due').indexOf('<div class="sfn-src">현장 대장 · 교육·검진</div>') > 0,
    'J ' + J32.out.length + ' / V ' + order32(V32.out));
  const E32 = run32(base32({ st: { edu: 'fail', asb: 'fail' }, colBase: { checklist: 1 }, offline: true, contracts: [], duties: [], licOk: false }));
  const F32 = run32(base32({ st: { edu: 'wait', asb: 'ok' }, colBase: { checklist: 1, licenses: 1 }, contracts: [] }));
  const f1_32 = F32.out, f1t32 = F32.timers.length; F32.api.setTicks(F32.api.max()); const f2_32 = F32.api.render();
  const C32 = run32(base32()), c1_32 = blk32(C32.out, 'con'), c1t32 = C32.timers.length; C32.api.setTicks(C32.api.max()); const c2_32 = blk32(C32.api.render(), 'con');   // 서류함 기다림(석면 계약)도 90번이면 '확인 실패'
  const G32 = run32(base32({ dutyThrow: true }));
  T('v432 ④ 읽기 실패·기다림(실행): 교육·현장 대장 읽기 실패·오프라인 = 그 블록 줄에만 "불러오지 못함"(③ 현장 대장·교육·검진 기록·인허가 의무 대장, ④ 계약 목록) — ①②⑤⑥은 그대로 · 아직 읽는 중 = "불러오는 중…"·1초 뒤 다시 그림 1번 · 기다림이 다하면(90번) "불러오지 못함"·더 안 그림 · 블록 안에서 오류가 나면 그 블록만 "불러오지 못함"(①④는 그대로)',
    /현장 대장[\s\S]{0,140}불러오지 못함/.test(blk32(E32.out, 'due')) && /교육·검진 기록[\s\S]{0,140}불러오지 못함/.test(blk32(E32.out, 'due')) && /인허가 의무 대장[\s\S]{0,140}불러오지 못함/.test(blk32(E32.out, 'due')) && /계약 목록[\s\S]{0,140}불러오지 못함/.test(blk32(E32.out, 'con'))
    && order32(E32.out) === 'check,jcb,due,con,eval,confirm' && rowIds32(blk32(E32.out, 'check')).length === 26 && E32.timers.length === 0
    && /계약 목록[\s\S]{0,100}불러오는 중…/.test(blk32(f1_32, 'con')) && /교육·검진 기록[\s\S]{0,100}불러오는 중…/.test(blk32(f1_32, 'due')) && f1t32 === 1
    && /계약 목록[\s\S]{0,140}불러오지 못함/.test(blk32(f2_32, 'con')) && /교육·검진 기록[\s\S]{0,140}불러오지 못함/.test(blk32(f2_32, 'due')) && F32.timers.length === 1
    && c1t32 === 1 && c1_32.indexOf('<span class="sfn-pill">확인 중</span>') > 0 && c2_32.indexOf('확인 중') < 0 && (c2_32.match(/<span class="sfn-pill bad">확인 실패<\/span>/g) || []).length === 3 && C32.timers.length === 1
    && blk32(G32.out, 'due').indexOf('불러오지 못함') > 0 && blk32(G32.out, 'due').indexOf('석면 작업신고 마감') < 0 && rowIds32(blk32(G32.out, 'check')).length === 26 && blk32(G32.out, 'con').indexOf('1/2') > 0,
    JSON.stringify({ e: order32(E32.out), f: [f1t32, F32.timers.length], g: order32(G32.out) }));
  // ④-2 (v432 검토) 실패 안내가 읽는 곳에 맞음 — 교육·현장 대장(현황이 읽음) = '현황 칸을 다시 열면 새로 읽습니다' · 주기 체크·인허가·계약 목록(앱이 처음 한 번 읽는 원장) = '앱을 새로고침하면 다시 읽습니다'
  const E2_32 = run32(base32({ st: { edu: 'fail', asb: 'fail' }, colBase: {}, records: {}, offline: true, contracts: [], duties: [], licOk: false }));
  const msg32 = (out, k, title) => { const m = blk32(out, k).match(new RegExp('<div class="sfn-t">' + title + '</div><div class="item-meta">([^<]*)</div></div><span class="sfn-pill bad">불러오지 못함</span>')); return m ? m[1] : ''; };
  const msgs32 = [msg32(E2_32.out, 'due', '현장 대장'), msg32(E2_32.out, 'due', '교육·검진 기록'), msg32(E2_32.out, 'check', '주기 체크 기록'), msg32(E2_32.out, 'jcb', '주기 체크 기록'), msg32(E2_32.out, 'due', '인허가 의무 대장'), msg32(E2_32.out, 'con', '계약 목록')];
  T('v432 ④-2 실패 안내 = 읽는 곳대로: 현장 대장·교육·검진 기록 "현황 칸을 다시 열면 새로 읽습니다" · 주기 체크(①②)·인허가 의무 대장·계약 목록 "앱을 새로고침하면 다시 읽습니다"(현황이 다시 읽지 않는 원장) · 옛 문구 "다시 열면 새로 읽습니다"만 쓰는 줄 0',
    msgs32.join('|') === '현황 칸을 다시 열면 새로 읽습니다|현황 칸을 다시 열면 새로 읽습니다|앱을 새로고침하면 다시 읽습니다|앱을 새로고침하면 다시 읽습니다|앱을 새로고침하면 다시 읽습니다|앱을 새로고침하면 다시 읽습니다'
    && !/<div class="item-meta">다시 열면 새로 읽습니다<\/div>/.test(E2_32.out), msgs32.join(' | '));
  // ④-3 (v432 검토) 다시 그림 타이머를 실제로 돌린다(모은 콜백 실행 — 종전 시험 틀은 콜백을 버렸다)
  //   Q: 교육 기다림 + 서류함 기다림(관급 석면) = 1초마다 틱이 늘고 90번에서 '불러오지 못함'·'확인 실패'로 끝나며 타이머가 멈춤 · 그 사이 로더(교육·현장 대장·명부) 0번 · 서류함 읽기는 그리기 첫 번에 1번(60초 캐시 — force 없음)
  //   R: 계약 목록이 현황을 연 뒤 50번째 틱에 도착 = 그때 진행 계약 4건의 서류함을 1번씩 읽고(종전엔 0번 — 90초 뒤 거짓 '확인 실패') 기다림을 그때부터 센다 —
  //      100번째 틱에도 받지 못한 계약은 '확인 중'(90을 넘었지만 시작+90 전), 받은 계약은 판정(1/2), 141번째 틱에 나머지 '확인 실패'로 끝남 · 로더 0번
  const Q32 = run32(base32({ st: { edu: 'wait', asb: 'ok' } }));
  const qRun32 = Q32.api.runTimers(400), qOut32 = Q32.api.html();
  const R32 = run32(base32({ colBase: { checklist: 1, licenses: 1 }, contracts: [], cdoc: {} }));
  const r0_32 = blk32(R32.out, 'con'), rRun1_32 = R32.api.runTimers(50), rCdoc0_32 = R32.calls.cdoc.join(',');
  R32.api.setCons(base32().contracts); const rRun2_32 = R32.api.runTimers(9); const rCdoc1_32 = R32.calls.cdoc.join(',');
  R32.api.cdocSet('c1', { loaded: true, busy: false }); const rRun3_32 = R32.api.runTimers(40); const r100_32 = blk32(R32.api.html(), 'con'), rT100_32 = R32.api.ticks();
  const rRun4_32 = R32.api.runTimers(400), rEnd32 = blk32(R32.api.html(), 'con');
  T('v432 ④-3 다시 그림 타이머(실행 — 콜백을 실제로 돌림): 기다림 = 틱 ' + Q32.api.ticks() + '번에서 멈춤(교육 "불러오지 못함"·석면 계약 "확인 실패", 남은 타이머 0) · 다시 그림 중 로더 0번·서류함 읽기는 첫 그림 1번(force 없음)·칸 갈아끼우기는 글이 바뀐 2번뿐 / 늦게 온 계약 = 도착 틱에 서류함 4건 1번씩 · 100번째 틱에도 "확인 중"·받은 계약은 1/2 · 141번째 틱에 "확인 실패" 3건으로 끝 · 로더 0번',
    qRun32 === 90 && Q32.api.ticks() === 90 && Q32.api.pending() === 0 && /교육·검진 기록[\s\S]{0,140}불러오지 못함/.test(blk32(qOut32, 'due')) && (blk32(qOut32, 'con').match(/<span class="sfn-pill bad">확인 실패<\/span>/g) || []).length === 3 && blk32(qOut32, 'con').indexOf('확인 중') < 0
    && Q32.calls.load.length === 0 && Q32.calls.cdoc.join(',') === 'c2' && Q32.calls.qsa === 4   // 91번 그렸어도 칸을 갈아끼운 것은 글이 바뀐 2번(처음·90번째)뿐
    && /계약 목록[\s\S]{0,100}불러오는 중…/.test(r0_32) && rRun1_32 === 50 && rCdoc0_32 === '' && rRun2_32 === 9 && rCdoc1_32 === 'c2,c1,c5,c6'
    && rRun3_32 === 40 && rT100_32 === 99 && (r100_32.match(/<span class="sfn-pill">확인 중<\/span>/g) || []).length === 3 && r100_32.indexOf('<span class="sfn-pill am">1/2</span>') > 0
    && R32.api.ticks() === 141 && R32.api.pending() === 0 && (rEnd32.match(/<span class="sfn-pill bad">확인 실패<\/span>/g) || []).length === 3 && rEnd32.indexOf('확인 중') < 0 && rEnd32.indexOf('1/2') > 0
    && R32.calls.cdoc.join(',') === 'c2,c1,c5,c6' && R32.calls.load.length === 0 && rRun4_32 === 42,
    JSON.stringify({ q: [qRun32, Q32.api.ticks(), Q32.api.pending(), Q32.calls.load, Q32.calls.cdoc], r: [rRun1_32, rCdoc0_32, rRun2_32, rCdoc1_32, rRun3_32, rT100_32, rRun4_32, R32.api.ticks(), R32.api.pending(), R32.calls.load] }));
  // ④-4 (v432 검토) 다른 날짜 갈래 — 상반기·월요일(2027-03-08): h* 알약 "6월"·② 머리 "2027 상반기"·w1 "오늘"·y1 (상반기) "6월"·y3 (1월) 지남 · 기한 달(2026-12-02): y4 (12월)·h* "이번 달"·w1 지남(화요일 뒤)
  const D1_32 = run32(base32({}, '2027-03-08')), D2_32 = run32(base32({}, '2026-12-02'));
  const d1c32 = blk32(D1_32.out, 'check'), d1j32 = blk32(D1_32.out, 'jcb'), d2c32 = blk32(D2_32.out, 'check'), d2j32 = blk32(D2_32.out, 'jcb');
  T('v432 ④-4 날짜 갈래(실행): 2027-03-08(월·상반기) = w1 오늘 · h2 6월 · h4 완료 · y1 6월 · y3 지남 · m1 승인 대기 · ② 2027 상반기·3호 6월·8호 완료 / 2026-12-02(수·12월) = y4 이번 달 · h2 이번 달 · w1 지남 · ② 2026 하반기·3호 이번 달',
    pillOf32(d1c32, 'w1') === 'am:오늘' && pillOf32(d1c32, 'h2') === '-:6월' && pillOf32(d1c32, 'h4') === 'ok:완료' && pillOf32(d1c32, 'y1') === '-:6월' && pillOf32(d1c32, 'y3') === 'bad:지남' && pillOf32(d1c32, 'm1') === 'am:승인 대기'
    && d1j32.indexOf('<span class="cnt">2027 상반기</span>') > 0 && pillOf32(d1j32, '3호') === '-:6월' && pillOf32(d1j32, '8호') === 'ok:완료' && D1_32.head === '2027-03-08 기준'
    && pillOf32(d2c32, 'y4') === 'am:이번 달' && pillOf32(d2c32, 'h2') === 'am:이번 달' && pillOf32(d2c32, 'w1') === 'bad:지남' && d2j32.indexOf('<span class="cnt">2026 하반기</span>') > 0 && pillOf32(d2j32, '3호') === 'am:이번 달',
    [pillOf32(d1c32, 'w1'), pillOf32(d1c32, 'h2'), pillOf32(d1c32, 'y1'), pillOf32(d1c32, 'y3'), (d1j32.match(/<span class="cnt">[^<]*<\/span>/) || [''])[0], pillOf32(d2c32, 'y4'), pillOf32(d2c32, 'h2'), pillOf32(d2c32, 'w1')].join(' / '));
  // ④-5 (v432 검토) 빈 자료 갈래 — 교육 기록 0건(운영 col:edu 지금 상태) = 투입 인원이 있는 진행 석면 현장은 '특별교육 · 기록 없음'(미이수 경보 아님) + '교육·검진 다음 예정 · 기록 없음' 2줄 ·
  //      체크 권한은 있는데 볼 항목 0개 = ① 블록째 없음('0건' 아님, ②는 조문 줄 2개만) · 명부를 아직 못 받았으면 일용직 줄 이름 '일용직'('(삭제된 일용직)' 아님)
  const E0_32 = run32(base32({ edu: [] })), e0Due32 = blk32(E0_32.out, 'due');
  const allScope32 = {}; WANT32.split(',').forEach((id) => { allScope32[id] = ['a1']; });
  const Z0_32 = run32(base32({ admin: false, me: { id: 'j1', dept: '운영부' }, perm: { safety: 'do', check: 'do' }, assignee: {}, scopes: allScope32 }));
  const W0_32 = run32(base32({ workers: [] })), w0Due32 = blk32(W0_32.out, 'due'), w0Ed32 = W0_32.api.eduDue(30), w0Row32 = w0Ed32.length ? W0_32.api.homeRow(w0Ed32[0]) : '';
  T('v432 ④-5 빈 자료(실행): 교육 기록 0건 = "기록 없음" 2줄(남성초 석면 · 특별교육 — 투입 2명 이수 여부 미확인 · 교육·검진 다음 예정)·"특별교육 미이수" 0 · 볼 체크 항목 0개 = ① 블록 없음·"0건" 0·② 조문 줄 2개 · 명부 없음 = 일용직 줄 "일용직 · 특수건강진단"(현황 ③·관리자 홈 줄 모두 "(삭제된 일용직)" 0)',
    (e0Due32.match(/<span class="sfn-pill">기록 없음<\/span>/g) || []).length === 2 && e0Due32.indexOf('남성초 석면 · 특별교육</div><div class="item-meta">교육·검진 기록이 0건이라 투입 2명 모두 이수 여부 미확인') > 0 && e0Due32.indexOf('특별교육 미이수') < 0 && e0Due32.indexOf('교육·검진 다음 예정</div>') > 0
    && order32(Z0_32.out) === 'jcb,due,eval,confirm' && Z0_32.out.indexOf('0건') < 0 && rowIds32(blk32(Z0_32.out, 'jcb')).join(',') === '5조②1·2,2·6호'   // v436 ⑤는 안전 권한이면 보임(인허가 권한 없음 — 의무 대장 글 없이)
    && W0_32.out.indexOf('(삭제된 일용직)') < 0 && w0Due32.indexOf('일용직 · 특수건강진단') > 0 && w0Ed32.length > 0 && w0Ed32[0].r.id === 'e3' && w0Row32.indexOf('<div class="item-title">일용직 · 특수건강진단</div>') > 0,
    JSON.stringify({ e0: (e0Due32.match(/<span class="sfn-pill">기록 없음<\/span>/g) || []).length, z: order32(Z0_32.out), w0: w0Ed32.map((x) => x.r.id) }));
  // ④-6 (v432 검토) 의무 대장 → 인허가 행 잇기에 회사를 본다 — 같은 이름 인허가가 두 회사에 따로 있고 한쪽만 공개범위면: 의무 줄 글의 회사 행으로 판정(종운건설 행만 닫힘 → 16행 빠짐), 회사로 못 고르면 모두 볼 때만
  const lic2_32 = (scopeOn) => [{ id: 'lA', name: '석면해체·제거업', org: '종운환경' }, { id: 'lB', name: '석면해체·제거업', org: '종운건설', scope: scopeOn === 'B' ? ['a1'] : undefined }, { id: 'lseed07', name: '화물자동차 운송사업' }, { id: 'lseed11', name: '발전사업 허가(태양광)' }, { id: 'lseed08', name: '유해화학물질 운반업' }].map((l) => { if (scopeOn === 'A' && l.id === 'lA') l.scope = ['a1']; return l; });
  const kOrg32 = (s) => rowIds32(blk32(run32(base32({ admin: false, me: { id: 'k2', dept: '운영부', rank: '사원' }, perm: { safety: 'do', lic: 'view' }, licenses: lic2_32(s) })).out, 'due')).filter((x) => /행$/.test(x)).join(',');
  const kB32 = kOrg32('B'), kA32 = kOrg32('A'), kN32 = kOrg32('');
  // 회사가 없는 의무 줄(4행 '화물자동차 운송사업 허가(확인요)')에 같은 이름 인허가가 둘이고 둘째만 공개범위면 — 모두 볼 때만(좁은 쪽, 처음 맞는 행만 보던 종전이면 보임)
  const kC32 = rowIds32(blk32(run32(base32({ admin: false, me: { id: 'k2', dept: '운영부', rank: '사원' }, perm: { safety: 'do', lic: 'view' }, licenses: [{ id: 'lA', name: '석면해체·제거업', org: '종운환경' }, { id: 'lB', name: '석면해체·제거업', org: '종운건설' }, { id: 'lT1', name: '화물자동차 운송사업', org: '종운환경' }, { id: 'lT2', name: '화물자동차 운송사업', org: '종운건설', scope: ['a1'] }, { id: 'lseed11', name: '발전사업 허가(태양광)' }, { id: 'lseed08', name: '유해화학물질 운반업' }] })).out, 'due')).filter((x) => /행$/.test(x)).join(',');
  T('v432 ④-6 의무 대장 ↔ 인허가 행(회사): 같은 이름 두 회사 — 종운건설 행만 공개범위 = 16행(석면해체·제거업 등록(종운건설)) 빠짐 · 종운환경 행만 공개범위 = 16행 보임 · 공개범위 없음 = 보임 · 회사 없는 줄(4행 화물)에 같은 이름 둘·둘째만 공개범위 = 빠짐(모두 볼 때만)',
    kB32 === '4행,32행,62행' && kA32 === '4행,16행,32행,62행' && kN32 === '4행,16행,32행,62행' && kC32 === '16행,32행,62행', [kB32, kA32, kN32, kC32].join(' / '));

  // ⑤ 이동 — sfNowGo 실행(완료·저장 없이 원래 자리로): 내 업무(그 항목으로 굴림) · 안전 › 현장·교육·검진(대상) · 인허가 의무 대장 · 계약 단계·서류(그 계약 펼침) · 문서함 06 서랍
  //    v432 검토: 도착 자리로 굴림(못 찾으면 맨 위 'top' — 앱은 탭을 바꿔도 창 스크롤을 그대로 둔다) · 수시 줄은 내 업무 '수시' 칸의 그 줄(제목)로, 없으면 그 칸 머리로 ·
  //    계약 줄 = 표 칩·필터가 그 계약을 거르면 이번 이동만 풀고 그림(기기 저장 없음) · 폰(860px 밑)은 표 아래 상세 카드로 · 문서함 06 = 06 서랍 머리로(block start)
  const goRun32 = (v, opt) => {
    const o = Object.assign({ w: 1200, chip: '', f: {} }, opt || {});
    const log = [], scrolled = [];
    const el = (attrs, title) => ({ getAttribute: (n) => attrs[n], scrollIntoView: (so) => scrolled.push(JSON.stringify(attrs) + '@' + ((so && so.block) || '')), querySelector: (s) => (s === '.item-title' && title != null ? { textContent: title } : null) });
    const sud = [el({ sudsi: 'su1' }, known32.get('su1')), el({ sudsi: 'su3' }, known32.get('su3'))];
    const api = new Function('__log', '__el', '__sud', '__w', '__chip', '__f', [
      'var conOpenId = null, conDetTab = "ov", docOpenCats = {}, contracts = [{ id: "c1", status: "run", docType: "public", client: "포항시" }], conSheet = { k: "stage", d: 1, f: __f, chip: __chip };',
      'function findProc(id){ for (var i = 0; i < contracts.length; i++){ if (contracts[i].id === id) return contracts[i]; } return null; }',
      'function csPass(c, f, chip){ __log.push("csPass:" + (chip || "-") + (f && Object.keys(f).length ? "+f" : "")); if (chip === "done") return c.status === "done"; if (chip === "pri") return c.docType !== "public"; if (f && f.client) return String(c.client || "").indexOf(f.client) >= 0; return true; }',
      'function switchTab(n){ __log.push("switch:" + n); } function setLicLayer(n){ __log.push("lic:" + n); } function renderContracts(){ __log.push("renderContracts:" + conOpenId + ":" + conDetTab + ":" + conSheet.chip); } function renderDocuments(){ __log.push("renderDocuments:" + !!docOpenCats["06"]); }',
      'var document = { querySelectorAll: function(sel){ __log.push("qsa:" + sel); if (sel === "#listHost .item") return [__el({ "data-id": "m1" }), __el({ "data-id": "w1" })]; if (sel === "[data-cs-row]") return [__el({ "data-cs-row": "c1" })]; if (sel === "#sudsiHost .item") return __sud; if (sel === "[data-doc-acc]") return [__el({ "data-doc-acc": "05" }), __el({ "data-doc-acc": "06" })]; return []; },',
      '  getElementById: function(id){ __log.push("gid:" + id); return id === "conDetailCard" ? __el({ card: "conDetailCard" }) : (id === "sudsiHost" ? { parentNode: __el({ group: "sudsi" }) } : null); } };',
      'var window = { innerWidth: __w, scrollTo: function(){ __log.push("top"); } };',
      SRC32.groups, SRC32.sudsi, fn32('sfNowItem'), fn32('sfNowGo'), fn32('sfNowScrollTo'), fn32('sfNowScrollSudsi'), fn32('sfNowTop'),
      'return { go: sfNowGo, st: function(){ return [conOpenId, conDetTab, !!docOpenCats["06"], conSheet.chip, JSON.stringify(conSheet.f)].join("|"); } };'].join('\n'))(log, el, sud, o.w, o.chip, o.f);
    api.go(v);
    return log.join(',') + ' #' + scrolled.join('') + ' #' + api.st();
  };
  const TA32 = stmt32(html, /var TAB_ALIAS = \{[^\n]*\};/), route32 = new Function([TA32, fn32('tabRoute'), 'return tabRoute;'].join('\n'))();
  const goTabs32 = ['safety:site', 'safety:edu:worker', 'safety:edu:member', 'check', 'lic', 'con', 'doc'];
  const tabsOk32 = goTabs32.every((g) => { const r = route32(g); if (!ids.has('view-' + r.tab)) return false; if (r.tab !== 'safety') return !r.layer; const p = r.layer.split(':'); return ['now', 'site', 'edu'].indexOf(p[0]) >= 0 && (p.length === 1 || (p[0] === 'edu' && ['member', 'worker'].indexOf(p[1]) >= 0)); });
  const gr32 = { chk: goRun32('check:w1'), su1: goRun32('check:su1'), su5: goRun32('check:su5'), chkX: goRun32('check:zz'), site: goRun32('site'), ew: goRun32('edu:worker'), em: goRun32('edu:member'), eb: goRun32('edu:boss'), duty: goRun32('duty'),
    con: goRun32('con:c1'), conPri: goRun32('con:c1', { chip: 'pri' }), conF: goRun32('con:c1', { f: { client: '시청' } }), conOk: goRun32('con:c1', { chip: 'pub' }), conPh: goRun32('con:c1', { w: 375 }), conX: goRun32('con:zz'), doc: goRun32('doc06'), none: goRun32('zz') };
  const N32 = ' #|ov|false||{}';
  T('v432 ⑤ 이동(sfNowGo 실행): 체크 줄 → 내 업무 + 그 항목으로 굴림 · 수시 줄(su1·su3·su5·su6) → 내 업무 "수시" 칸의 그 줄(제목으로 — #listHost 밖·data-id 없음), 숨은 항목이면 그 칸 머리로 · 못 찾은 항목은 맨 위 · 현장 줄 → 안전 › 현장 · 교육 줄 → 안전 › 교육·검진 그 대상(모르는 대상은 직원) · 의무 대장 → 인허가 › 의무 대장(셋 다 맨 위에서) · 계약 줄 → 계약 탭에서 그 계약 펼침(단계·서류 칸) + PC는 그 줄로·폰(375px)은 표 아래 상세 카드로 굴림 · 표 칩(사급)·필터(검색어)가 그 계약을 거르면 이번만 풀고(칩 전체·필터 빔 — 그린 뒤 상태) 거르지 않는 칩(관급)은 그대로 · 없는 계약은 아무것도 안 함 · 문서함 06 → 06 서랍 펼친 채 그 서랍 머리로 · 모르는 값은 아무것도 안 함 · 이동 대상 탭·칸 전부 실재(tabRoute)',
    gr32.chk === 'switch:check,qsa:#listHost .item #{"data-id":"w1"}@center' + N32
    && gr32.su1 === 'switch:check,qsa:#listHost .item,qsa:#sudsiHost .item #{"sudsi":"su1"}@center' + N32 && gr32.su5 === 'switch:check,qsa:#listHost .item,qsa:#sudsiHost .item,gid:sudsiHost #{"group":"sudsi"}@start' + N32
    && gr32.chkX === 'switch:check,qsa:#listHost .item,top #' + N32
    && gr32.site === 'switch:safety:site,top #' + N32 && gr32.ew === 'switch:safety:edu:worker,top #' + N32 && gr32.em === 'switch:safety:edu:member,top #' + N32 && gr32.eb === gr32.em
    && gr32.duty === 'switch:lic,lic:duty,top #' + N32
    && gr32.con === 'csPass:-,switch:con,renderContracts:c1:st:,qsa:[data-cs-row] #{"data-cs-row":"c1"}@center #c1|st|false||{}'
    && gr32.conPri === 'csPass:pri,switch:con,renderContracts:c1:st:,qsa:[data-cs-row] #{"data-cs-row":"c1"}@center #c1|st|false||{}'
    && gr32.conF === 'csPass:-+f,switch:con,renderContracts:c1:st:,qsa:[data-cs-row] #{"data-cs-row":"c1"}@center #c1|st|false||{}'
    && gr32.conOk === 'csPass:pub,switch:con,renderContracts:c1:st:pub,qsa:[data-cs-row] #{"data-cs-row":"c1"}@center #c1|st|false|pub|{}'
    && gr32.conPh === 'csPass:-,switch:con,renderContracts:c1:st:,gid:conDetailCard #{"card":"conDetailCard"}@start #c1|st|false||{}'
    && gr32.conX === ' #' + N32 && gr32.doc === 'switch:doc,renderDocuments:true,qsa:[data-doc-acc] #{"data-doc-acc":"06"}@start #|ov|true||{}' && gr32.none === ' #' + N32 && tabsOk32,
    JSON.stringify(gr32));

  // ⑥ 읽기 — sfNowOpen 실행(현황 칸을 열 때만): 교육(안전) · 현장 대장(현장 권한 — { noHooks: true }) · 명부(일용직 권한) · 서류함은 안전 서류가 걸리는 진행 계약만 → 결과를 적고 그 칸이면 다시 그림
  //    v432 검토: 가짜 cdocLoad가 두 번째 인자(force)를 기록 — 현황 읽기는 60초 캐시를 쓴다(force 없음) · 시계(Date.now)를 시험이 정해 30초 안 다시 열기 = 받은 로더를 다시 안 부름(SF_NOW_FRESH)
  const openRun32 = (perm, admin) => {
    const log = [], thens = [];
    const th = (name) => ({ then: (ok, ng) => { thens.push({ name, ok, ng }); } });
    const api = new Function('__perm', '__admin', '__log', '__th', '__cons', [
      'function isAdmin(){ return __admin; } function canSee(m){ return __admin || (__perm[m] || "hide") !== "hide"; }',
      'var __now = 1000000; var Date = { now: function(){ return __now; } };',
      'var contracts = __cons, currentTab = "safety", safetyLayer = "now", workers = [{ id: "w1", name: "김일용" }];',
      SRC32.packets, fn32('csPkWhen'), fn32('csPkIk'), fn32('liveContracts'), stmt32(sec32, /var SF_NOW_CON = \[[^\n]*\];/),
      stmt32(sec32, /var SF_NOW_TICK_MAX = \d+;/), stmt32(sec32, /var SF_NOW_FRESH = \d+;/), 'var sfNowSt = { edu: "", asb: "", set: "" }, sfNowTicks = 5, sfNowAt = {}, sfNowCdocT0 = { c9: 3 };',
      'function loadEdu(a){ __log.push("loadEdu:" + JSON.stringify(a === undefined ? null : a)); return __th("edu"); }',
      'function loadAsb(a){ __log.push("loadAsb:" + JSON.stringify(a === undefined ? null : a)); return __th("asb"); }',
      'function loadWorkers(){ __log.push("loadWorkers"); return __th("wk"); } function cdocLoad(c, force){ __log.push("cdocLoad:" + c.id + (force === undefined ? "" : ":" + force)); } function renderSafetyNow(){ __log.push("render"); }',
      'function loadSafetySet(a){ __log.push("loadSafetySet:" + JSON.stringify(a === undefined ? null : a)); return __th("set"); }',   // v436 안전 설정 읽기(현황을 열 때 — 교육 다음)
      fn32('sfNowConKeys'), fn32('sfNowLoad'), fn32('sfNowRefresh'), fn32('sfNowOpen'),
      'sfNowOpen(); return { st: function(){ return sfNowSt.edu + "/" + sfNowSt.asb + "/" + sfNowSt.set + "/" + sfNowTicks + "/" + JSON.stringify(sfNowCdocT0); }, leave: function(){ currentTab = "dash"; }, back: function(){ currentTab = "safety"; },',
      '  again: function(ms){ __now += ms; __log.length = 0; sfNowOpen(); return __log.join(","); } };'].join('\n'))(perm, admin, log, th, base32().contracts);
    return { log, thens, api };
  };
  const oA32 = openRun32({}, true), oA0_32 = oA32.log.join(','), oA0st32 = oA32.api.st();
  const fire32 = (r, name, v) => { const t = r.thens.filter((x) => x.name === name)[0]; if (t) t.ok(v); return !!t; };   // 그 로더를 안 불렀으면 false — 아래 단언이 ✗로 잡는다(시험 틀이 터지지 않게)
  const fE32 = fire32(oA32, 'edu', true), fS32 = fire32(oA32, 'asb', false), fT32 = fire32(oA32, 'set', true); const oA1st32 = oA32.api.st(), oA1n32 = oA32.log.filter((x) => x === 'render').length;   // v436 안전 설정(set)도 받음
  oA32.api.leave(); const fW32 = fire32(oA32, 'wk'); const oA2n32 = oA32.log.filter((x) => x === 'render').length;
  oA32.api.back();
  const oAg1_32 = oA32.api.again(10000), oAg2_32 = oA32.api.again(25000);   // 10초 뒤(받은 교육·안전 설정·명부는 다시 안 읽음, 실패한 현장 대장은 다시) · 그 뒤 25초(받은 지 35초 — 다시 읽음)
  const oK32 = openRun32({ safety: 'do', con: 'do', wk: 'view' }, false), oN32 = openRun32({ safety: 'do' }, false);
  const ldRun32 = (name, status, opt, admin, tab) => {
    const log = [];
    const api = new Function('__log', '__status', '__admin', '__tab', [
      'function canSee(){ return true; } function isAdmin(){ return __admin; } var currentTab = __tab || "dash";',
      'var asb = [], asbBase = 0, asbPending = false, asbLoaded = false, edu = [], eduBase = 0, eduPending = false;',
      'function gwCall(fn, body){ __log.push(fn + ":" + body.action + ":" + body.collection); var res = { status: __status, body: { doc: { items: [{ id: "x1" }], updated_at: 5 } } }; return { then: function(f){ var v; try { v = f(res); } catch(e){ return { catch: function(g){ return g(e); } }; } return { catch: function(){ return v; } }; } }; }',
      'function mergeAsb(a){ return a; } function normAsbRow(r){ return r; } function mergeEdu(a){ return a; }',
      'function csSiteHooksRetry(){ __log.push("hooks"); } function renderSites(){ __log.push("renderSites"); } function renderCalendar(){ __log.push("renderCalendar"); } function renderWorkers(){ __log.push("renderWorkers"); } function renderEdu(){ __log.push("renderEdu"); } function renderDashboard(){ __log.push("renderDashboard"); }',
      fn32('loadAsb'), fn32('loadEdu'), 'return { asb: loadAsb, edu: loadEdu };'].join('\n'))(log, status, admin, tab);
    const v = api[name](opt);
    return v + ':' + log.join(',');
  };
  const la32 = [ldRun32('asb', 200, { noHooks: true }), ldRun32('asb', 200), ldRun32('asb', 500, { noHooks: true }), ldRun32('edu', 200, undefined, true), ldRun32('edu', 200, undefined, false), ldRun32('edu', 403, undefined, true), ldRun32('edu', 200, undefined, true, 'safety'), ldRun32('edu', 200, undefined, true, 'cal')];
  T('v432 ⑥ 읽기(sfNowOpen·loadAsb·loadEdu 실행): 현황을 열면 교육 읽기 · v436 안전 설정 읽기(loadSafetySet — 교육 다음, 안전 권한) · 현장 대장 읽기({ noHooks: true } — 보류된 계약 연결·종결 훅은 안 돎, 현장 칸·계약 쪽 읽기는 종전대로 훅) · 명부 · 서류함은 안전 서류가 걸리는 진행 계약만(관급 진행 4건 — 사급·끝난 계약 빼고, 60초 캐시 — force 없음) → 그리기 1번 · 열 때 서류함 기다림 시작 틱 초기화 · 결과(성공 true·실패 false)를 적고 그 칸이면 다시 그림 · 다른 데로 가면 안 그림 · 30초 안에 다시 열면 받은 교육·안전 설정·명부는 다시 안 읽고 실패한 현장 대장만 다시(35초 뒤엔 모두) · 권민지형(현장 숨김) = 현장 대장·훅 없음 · 계약 숨김 = 서류함 안 읽음 · 로더는 성공 true·실패 false를 돌려주고 관리자가 홈에 있을 때만 교육 도착 때 홈(만기 목록)도 다시 그림(안전 탭·캘린더면 안 그림)',
    oA0_32 === 'loadEdu:null,loadSafetySet:null,loadAsb:{"noHooks":true},loadWorkers,cdocLoad:c1,cdocLoad:c2,cdocLoad:c5,cdocLoad:c6,render' && oA0st32 === 'wait/wait/wait/0/{}' && fE32 && fS32 && fT32 && fW32 && oA1st32 === 'ok/fail/ok/0/{}' && oA1n32 === 4 && oA2n32 === 4
    && oAg1_32 === 'loadAsb:{"noHooks":true},cdocLoad:c1,cdocLoad:c2,cdocLoad:c5,cdocLoad:c6,render' && oAg2_32 === 'loadEdu:null,loadSafetySet:null,loadAsb:{"noHooks":true},loadWorkers,cdocLoad:c1,cdocLoad:c2,cdocLoad:c5,cdocLoad:c6,render'
    && oK32.log.join(',') === 'loadEdu:null,loadSafetySet:null,loadWorkers,cdocLoad:c1,cdocLoad:c2,cdocLoad:c5,cdocLoad:c6,render' && oK32.api.st() === 'wait//wait/0/{}' && oN32.log.join(',') === 'loadEdu:null,loadSafetySet:null,render'
    && la32[0] === 'true:gw-data:get:asbestos,renderSites,renderCalendar,renderWorkers' && la32[1] === 'true:gw-data:get:asbestos,hooks,renderSites,renderCalendar,renderWorkers' && la32[2] === 'false:gw-data:get:asbestos'
    && la32[3] === 'true:gw-data:get:edu,renderEdu,renderCalendar,renderSites,renderDashboard' && la32[4] === 'true:gw-data:get:edu,renderEdu,renderCalendar,renderSites' && la32[5] === 'false:gw-data:get:edu'
    && la32[6] === 'true:gw-data:get:edu,renderEdu,renderCalendar,renderSites' && la32[7] === 'true:gw-data:get:edu,renderEdu,renderCalendar,renderSites',
    JSON.stringify({ open: [oA0_32, oA0st32, oA1st32, oA1n32, oA2n32, oAg1_32, oAg2_32], k: oK32.log, n: oN32.log, load: la32 }));

  // ⑦ 관리자 홈 만기 목록 — 교육·검진 다음 예정 30일 줄(sfNowEduDue·sfNowHomeEduRow 실행)이 인허가 줄과 같은 형식으로 한 목록에(새 타일 없음 — KPI·이번 주 기한 숫자 그대로) · 누르면 안전 › 교육·검진 그 대상 목록
  const ed32 = A32.api.eduDue(30), hr3 = ed32.length ? A32.api.homeRow(ed32[0]) : '', hr2 = ed32.length > 1 ? A32.api.homeRow(ed32[1]) : '';
  const licRow32 = (rdb32.match(/return \{ d: x\.dd\.diff, h: '<div class="item veh-item">' \+/) || [''])[0];
  const tiles32 = rdb32.slice(rdb32.indexOf("var tiles = '';"), rdb32.indexOf('var html = \'<div class="dash-date">\''));
  const inGo32 = [hr3, hr2].map((h) => (h.match(/data-inbox-go="([^"]+)"/) || ['', ''])[1]);
  T('v432 ⑦ 관리자 홈 만기 목록(실행 + 정적): 교육·검진 다음 예정이 오늘+30일 안(지난 것 포함, 지운 기록·날짜 없음·30일 밖·같은 사람·같은 종류의 옛 이수·퇴사자·지운 일용직 빼고) = 2줄 날짜순 · 교육 도착 때 홈 다시 그림은 홈일 때만 · 일용직 줄이 있고 명부가 비었으면 명부 1번 읽고 홈일 때만 다시 그림(이름 sfNowEduName) · 줄 = 인허가 줄과 같은 형식(.item.veh-item · .item-title · .item-meta · .task-ctrl .dday D-day 색) + 누르면 안전 › 교육·검진 그 대상(data-inbox-go — 홈의 기존 이동 배선) · renderDashboard: 인허가·보수교육 만기 목록에 합쳐 날짜순(머리 "· 교육·검진")·안전 권한일 때만 · 관리자 홈을 처음 그릴 때 교육 1번 읽음 · 타일(새 타일 0·이번 주 기한 숫자)에 교육 없음',
    ed32.map((x) => x.r.id).join(',') === 'e3,e2' && hr3.indexOf('<div class="item veh-item" data-inbox-go="safety:edu:worker" style="cursor:pointer;">') === 0 && hr3.indexOf('<div class="item-title">김일용 · 특수건강진단</div>') > 0 && hr3.indexOf('<span class="dday red">D+9</span>') > 0
    && hr2.indexOf('data-inbox-go="safety:edu:member"') > 0 && hr2.indexOf('<span class="dday orange">D-10</span>') > 0 && hr2.indexOf('<div class="item-meta"><span>다음 예정 2026-11-20</span>') > 0
    && inGo32.every((g) => { const r = route32(g); return ids.has('view-' + r.tab) && r.tab === 'safety' && /^edu:(member|worker)$/.test(r.layer); })
    && licRow32.length > 0 && /var eduHome = canSee\("safety"\) \? sfNowEduDue\(30\) : \[\];/.test(rdb32) && /if \(urgentLic\.length \|\| eduHome\.length\)\{/.test(rdb32)
    && /\}\)\.concat\(eduHome\.map\(function\(x\)\{ return \{ d: x\.dd\.diff, h: sfNowHomeEduRow\(x\) \}; \}\)\);/.test(rdb32) && /dueMix\.sort\(function\(a, b\)\{ return a\.d - b\.d; \}\);/.test(rdb32) && /<h2>인허가·보수교육 만기' \+ \(eduHome\.length \? ' · 교육·검진' : ''\) \+ ' <span class="cnt">' \+ dueMix\.length/.test(rdb32)
    && rdb32.indexOf('if (canSee("safety") && !sfNowHomeEduAsked){ sfNowHomeEduAsked = true; loadEdu(); }') > rdb32.indexOf('renderStaffHome(host); return; }') && /querySelectorAll\("\[data-inbox-go\]"\)/.test(rdb32)
    && tiles32.length > 300 && !/edu|교육/.test(tiles32) && !/eduHome/.test(rdb32.slice(rdb32.indexOf('var week7 = '), rdb32.indexOf('var tiles = '))) && /if \(isAdmin\(\) && currentTab === "dash"\) renderDashboard\(\);/.test(fn32('loadEdu'))
    // v432 검토: 일용직 줄이 있고 명부가 비었으면 명부를 1번 읽고 도착하면 홈일 때만 다시 그림(이름 — 받기 전은 sfNowEduName의 '일용직')
    && /if \(!sfNowHomeWkAsked && !workers\.length && canSee\("wk"\) && eduHome\.some\(function\(x\)\{ return x\.r\.ptype === "worker"; \}\)\)\{ sfNowHomeWkAsked = true; var wkp = loadWorkers\(\); if \(wkp && typeof wkp\.then === "function"\) wkp\.then\(function\(\)\{ if \(currentTab === "dash"\) renderDashboard\(\); \}\); \}/.test(rdb32)
    && rdb32.indexOf('sfNowHomeWkAsked = true') > rdb32.indexOf('var eduHome = ') && rdb32.indexOf('sfNowHomeWkAsked = true') < rdb32.indexOf('if (urgentLic.length || eduHome.length){') && /esc\(sfNowEduName\(r\)\)/.test(fn32('sfNowHomeEduRow')) && fn32('sfNowHomeEduRow').indexOf('eduPersonName') < 0,
    JSON.stringify({ ed: ed32.map((x) => x.r.id), go: inGo32, tiles: tiles32.length }));

  // ⑧ 문서 — FEATURES 기준·v432 절·§1·§7 · MANUAL 1절(칸 목록)·3절(관리자 홈 만기 목록)·21-2(안전 열 = 현황 칸도)·28절 안내·28-1(현황 — 읽기 전용, 완료는 제자리) · CLAUDE.md 안전 탭 줄 · TESTLIST v432(체크 칸 전부 AI 몫 — 화면 4종·게이트) · sw ≥ 432
  const sec32m = (a, b) => { const i = man32.indexOf(a); return i < 0 ? '' : man32.slice(i, man32.indexOf(b, i + a.length)); };
  const m28_32 = sec32m('<h2 id="s28">', '<h2 id="s29">'), m281_32 = sec32m('<h3 id="s28-1">', '<!-- 29 -->'), m3_32 = sec32m('<h2 id="s3">', '<h2 id="s4">'), m212_32 = sec32m('<h3>21-2. 권한관리</h3>', '<h3>21-3.');
  const tlv32 = (() => { const i = tl32.indexOf('\n## v432'); if (i < 0) return ''; const j = tl32.indexOf('\n## ', i + 5); return tl32.slice(i, j < 0 ? tl32.length : j); })();
  const cb32 = tlv32.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi32 = cb32.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l));
  const ftv32 = (() => { const i = ft32.indexOf('\n### v432 (11/10)'); if (i < 0) return ''; const j = ft32.indexOf('\n### ', i + 5); return ft32.slice(i, j < 0 ? ft32.length : j); })();
  const ft1_32 = ft32.split('\n').filter((ln) => ln.indexOf('- **업무**:') === 0)[0] || '', ft7_32 = ft32.split('\n').filter((ln) => ln.indexOf('- **안전**(v428') === 0)[0] || '';
  T('v432 ⑧ 문서: FEATURES 기준 v432·v432 절(읽기 전용·블록 6개·현황을 열 때만 읽음·관리자 홈 교육 줄·검사)·§1 업무 줄·§7 안전 줄에 현황 · MANUAL 1절 칸 목록 "현황 / 현장 / 교육·검진"·3절 관리자 홈 만기 목록에 교육·검진·21-2 안전 열 = 현황 칸도·28절 안내에 현황 칸·28-1 현황(현황은 읽기 전용, 완료는 제자리 · 블록 6개 · 공개범위) · CLAUDE.md 안전 탭 줄(현황 칸 sfChipNow·sfPaneNow, @safety-now 구간, 레지스트리 밖) · TESTLIST v432 체크 칸 전부 AI 몫(관리자형·권민지형·김정아형·375px·게이트, PM 몫 0) · sw ≥ 432',
    Number((ft32.match(/기준: v(\d+) /) || [0, 0])[1]) >= 432 && ftv32.indexOf('읽기 전용') > 0 && ftv32.indexOf('sfNowOpen') > 0 && ftv32.indexOf('관리자 홈') > 0 && ftv32.indexOf('uismoke v432') > 0 && ft1_32.indexOf('**현황**') > 0 && ft7_32.indexOf('**현황**') > 0
    && man32.indexOf('<b>안전</b> = 현황 / 현장 / 교육·검진') > 0 && m3_32.indexOf('교육·검진 다음 예정') > 0 && m212_32.indexOf('현황 칸') > 0 && m28_32.indexOf('현황 칸') > 0
    && m281_32.indexOf('현황은 읽기 전용') > 0 && m281_32.indexOf('완료') > 0 && m281_32.indexOf('원래 자리') > 0 && m281_32.indexOf('공개범위') > 0 && man32.indexOf('<a href="#s28">안전 › 현장 — 석면·철거·준설 대장 · 현황(28-1)</a>') > 0
    && cl32.indexOf('`sfChipNow`') > 0 && cl32.indexOf('`sfPaneNow`') > 0 && cl32.indexOf('@safety-now') > 0
    && tlv32.indexOf('관리자형') > 0 && tlv32.indexOf('권민지형') > 0 && tlv32.indexOf('김정아형') > 0 && tlv32.indexOf('375px') > 0 && tlv32.indexOf('PM 몫') < 0 && cb32.length >= 5 && cbNotAi32.length === 0 && cb32.some((l) => /^- \[x\] \(AI\) `uismoke`/.test(l))
    && Number((sw32.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 432,
    JSON.stringify({ ftv: ftv32.length, m281: m281_32.length, tl: tlv32.length, cb: cb32.length, notAi: cbNotAi32.map((l) => l.slice(0, 40)) }));
  // ⑧-2 (v432 검토) 문서를 낱말 몇 개가 아니라 내용으로 — MANUAL 28-1 여섯 묶음 이름(목록 머리)·① 상태 '오늘'·'이번 달'·⑤ 7단계('다음 단계에서' 0)·실패 안내 둘(다시 열면 / 새로고침)·간접 동기화 예외·교육 최근 이수분 ·
  //      21-2 목록 항목(교육·검진·현황) · FEATURES v432 절(h3 공개범위·checkItemVisible·licVisible·csApprSync 예외·eduLatest·오늘/이번 달·회사 잇기·30초·서류함 시작 틱)·§8 안전 열 = 현황 칸 ·
  //      CLAUDE.md(noHooks 1곳·csApprSync 예외·conSheetSave 없음) · TESTLIST v432 체크 칸에 'PM' 0(사람 몫 칸 없음)·저장 예외·수시 줄·옛 이력 줄
  const m281li32 = [...m281_32.matchAll(/<li><b>([^<]+)<\/b> — /g)].map((m) => m[1]).join(',');
  const ft8_32 = ft32.split('\n').filter((ln) => ln.indexOf('- **권한관리 매트릭스**') === 0)[0] || '';
  const cbPM32 = cb32.filter((l) => /PM/.test(l));
  //      화면 칸은 칸마다 본다(게이트 칸에도 같은 낱말이 있어 절 전체 낱말 검사는 칸 하나가 지워져도 통과했다 — 결함 심기 3회차)
  const cbOf32 = (key) => cb32.filter((l) => l.indexOf(key) >= 0 && /^- \[[ x]\] \(AI 시험 화면 대상/.test(l))[0] || '';   // 11/10: AI가 시험 뒤 [x]로 닫아도 같은 내용 검사(열린 칸만 보면 닫는 순간 실패)
  const tlMove32 = cbOf32('관리자형 이동'), tlHome32 = cbOf32('관리자 홈:'), tlPhone32 = cbOf32('폰 375px(큰 글자 포함)');
  T('v432 ⑧-2 문서 내용: MANUAL 28-1 묶음 6개 이름 그대로·① 오늘·이번 달·지남(화요일)·⑤ 7단계(v436 — KOSHA 인정 줄 설명, 옛 자리 글 0)·실패 안내 2갈래·결재 결과 맞추기 예외·가장 최근 이수 기록 · 21-2 목록 (교육·검진·현황) · FEATURES v432 절 h3·checkItemVisible·licVisible·csApprSync·eduLatest·sfNowDutyLics·SF_NOW_FRESH·sfNowCdocT0·오늘·이번 달 · §8 안전 열 = 현황 칸 · CLAUDE.md noHooks·csApprSync·conSheetSave · TESTLIST v432 체크 칸 PM 0 · 화면 칸마다(이동 칸 = 저장 예외 csApprSync·수시 줄·폰 상세 카드 · 관리자 홈 칸 = 옛 줄 없음·(삭제된 일용직) 없음 · 375px 칸 = 알약 늘 오른쪽)',
    m281li32 === '이번 주기 안전 점검,중처법 반기 점검,다가오는 기한 30일,계약 안전 서류,인정·평가,확인 필요'
    && /<b>오늘<\/b>은 매주\(월요일\) 항목의 월요일 당일/.test(m281_32) && /<b>이번 달<\/b>은 기한 달/.test(m281_32) && /화요일이 되도록 아직/.test(m281_32) && m281_32.indexOf('다음 단계에서 채웁니다') < 0
    // v436: ⑤ 자리 안내('(7단계 — 인정·평가 칸에서 채웁니다)')가 7단계 실제 줄 설명으로 바뀌었다 — 옛 자리 글 0 + ⑤ 항목이 KOSHA 인정으로 시작(내용 고정은 v436 묶음 ⑨)
    && m281_32.indexOf('인정·평가 칸에서 채웁니다') < 0 && /<li><b>인정·평가<\/b> — KOSHA 위험성평가 인정 단계/.test(m281_32)
    && m281_32.indexOf('현황 칸을 다시 열면 새로 읽고') > 0 && m281_32.indexOf('<b>앱을 새로고침</b>해야 다시 읽습니다') > 0 && m281_32.indexOf('칸을 다시 열면 새로 읽습니다.</li>') < 0 && m281_32.indexOf('결재 결과 맞추기') > 0 && m281_32.indexOf('<b>가장 최근 이수 기록</b>만') > 0 && m281_32.indexOf("내 업무 아래 '수시' 칸의 그 줄로") > 0
    && m212_32.indexOf('<li><b>안전</b>(교육·검진·현황)도 기본 숨김') > 0 && m212_32.indexOf('교육·검진 목록과 현황 칸만') > 0
    && ['h3(안전보건 담당자 업무수행 평가, 공개범위 관리자 3명)는 권민지 현황의 ①에도 ② 5호에도 없다', '`checkItemVisible`', '`licVisible`', '`csApprSync`', '`eduLatest`', '`sfNowDutyLics`', '`SF_NOW_FRESH`', '`sfNowCdocT0`', '오늘(매주 항목 — 월요일 당일)', '이번 달(기한 달', '폰(860px 밑)은 표 아래 상세 카드'].every((w) => ftv32.indexOf(w) > 0)
    && ft8_32.indexOf('안전 › 현황 칸(v432') > 0
    && ['noHooks', 'csApprSync', 'conSheetSave'].every((w) => cl32.indexOf(w) > 0)
    && cbPM32.length === 0
    && tlMove32.indexOf("예외: 계약 탭에 '단계·서류'로 펼쳐 둔 계약이 있으면") > 0 && tlMove32.indexOf('csApprSync') > 0 && tlMove32.indexOf("'수시' 칸의 그 줄") > 0 && tlMove32.indexOf('폰은 표 아래 상세 카드로 굴림') > 0
    && tlHome32.indexOf('옛 줄이 없음') > 0 && tlHome32.indexOf("'(삭제된 일용직)'로 보이지 않음") > 0 && tlPhone32.indexOf('알약이 늘 줄 오른쪽') > 0,
    JSON.stringify({ li: m281li32, pm: cbPM32.map((l) => l.slice(0, 60)), ft8: ft8_32.length, tl: [tlMove32.length, tlHome32.length, tlPhone32.length] }));
} catch (e) { console.log('  (v432 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v433(11/10 메뉴 56 6단계, PM 11/9 "56. ㄱ" — 확인 항목 기본안 '이름으로'): 현장 대장 '특별교육 미이수' 표시 바로잡기(앱·서버) — 브리핑 steps[5]·코드 지도 code.steps[4]
//      (지도에서는 5단계 — 브리핑이 순서를 바꿨고, 지도의 '인원수만'은 PM ㄱ으로 이름). 안전 권한 없는 현장 권한자(김정아·정재욱)는 교육 기록을 못 읽어 투입 인원 전원이 '미이수'로 그려졌다
//      → 서버 site_edu_gap이 현장별 '유효한 특별교육 기록이 없는 투입 인원 이름'만(교육 기록 자체·건강진단·이수일은 안 보냄).
//      ① 앱·서버 규칙 대조(실행) — index.html asbNoSpecial·eduHasValidSpecial·eduLatest·asList·memberName·findMember·dispName·tierOfMember를 뽑아 서버 _lib/siteedu.js와 같은 표본·같은 사람·같은 순서
//      ② 특별교육 줄 넷(siteEduLine 실행) ③ 서버 응답에 이름 밖 값 없음 ④ 읽기(loadAsb·loadSiteEduGap·doSaveAsb 실행 — 안전 권한자는 새 액션을 안 부름) ⑤ 정적(서버 분기·검사 순서·앱 자리) ⑥ 문서
try {
  const fn33 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const fnIn33 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } return ''; };
  const rd33 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const req33 = createRequire(import.meta.url);
  const SE33 = req33(join(ROOT, 'netlify', 'functions', '_lib', 'siteedu.js')), tier33 = req33(join(ROOT, 'netlify', 'functions', '_lib', 'tier.js'));
  const lib33 = rd33('netlify/functions/_lib/siteedu.js'), gd33 = rd33('netlify/functions/gw-data.js');
  const TIERTXT33 = (html.match(/var TIER_TXT = \{[^}]*\};/) || [''])[0];
  if (!TIERTXT33) throw new Error('TIER_TXT 없음');

  // ① 표본 — 서버는 회원 레코드 전부(지운 회원 포함, 순서 섞임), 앱은 member_list(지운 회원 빼고 seq 순 — 손으로 적음: 서버 정렬과 독립)
  const M33 = [
    { id: 'mDup', name: '나종운', seq: 50, admin: false, role: '직원' },                 // 대표와 이름이 같은 직원 — 앱 dispName은 이름으로 명부의 첫 회원(seq 1 대표)을 찾아 '대표님'
    { id: 'm1', name: '갑돌', seq: 10, admin: false, role: '직원' },
    { id: 'mDel', name: '지운사람', seq: 11, admin: false, del: 1 },                      // 지운 회원 — member_list에 없음 → 빠짐
    { id: 'mBoss', name: '나종운', seq: 1, admin: true, role: '대표', tier: 'boss' },
    { id: 'm2', name: '을순', seq: 12, admin: false },
    { id: 'mRet', name: '퇴사자', seq: 13, admin: false, leave_date: '2020-01-31' },     // 퇴사자 — member_list에 남음(이름 나옴)
    { id: 'mOut', name: '외부인', seq: 14, admin: false },                                // 어느 현장에도 없음
    { id: 'mNoName', seq: 15, admin: false },                                              // 이름 없음 → 빠짐
    { id: 'wSame', name: '김일용', seq: 16, admin: false },                                // 일용직 김일용과 이름 같은 직원(다른 사람)
  ];
  const MLIST33 = ['mBoss', 'm1', 'm2', 'mRet', 'mOut', 'mNoName', 'wSame', 'mDup'].map((id) => M33.find((m) => m.id === id));
  const W33 = [
    { id: 'w1', name: '일용하나' }, { id: 'w2', name: '지운일용', del: 1 }, { id: 'w3', name: '김일용' }, { id: 'w4', name: '김일용' },
    { id: 'w5', name: '박일용' }, { id: 'w6', name: '' }, { id: 'w7', name: '옛이름', del: 1 }, { id: 'w7', name: '새이름' }, { id: 'w8', name: '이수일용' },
  ];
  const E33 = [
    { id: 'e1', ptype: 'member', pid: 'm2', kind: 'special', date: '2026-03-02', next: '' },
    { id: 'e2', ptype: 'member', pid: 'm1', kind: 'special', date: '2026-03-03', next: '', del: 1 },     // 지운 기록 → 갑돌 미이수
    { id: 'e3', ptype: 'member', pid: 'm1', kind: 'regular', date: '2026-04-01', next: '2026-10-01' },   // special 아닌 기록
    { id: 'e4', ptype: 'worker', pid: 'w3', kind: 'special', date: '2025-01-05', next: '' },
    { id: 'e5', ptype: 'worker', pid: 'w3', kind: 'special', date: '2026-02-05', next: '' },             // 기록 여러 건
    { id: 'e6', ptype: 'member', pid: 'w5', kind: 'special', date: '2026-05-05', next: '' },             // 대상(ptype)이 다름 → 일용직 w5 미이수
    { id: 'e7', ptype: 'worker', pid: 'w8', kind: 'special', date: '2026-06-06', next: '' },
    { id: 'e8', ptype: 'worker', pid: 'w1', kind: 'pre_med', date: '2026-06-07', next: '' },             // 건강진단 → 미이수
    { id: 'e9', ptype: 'member', pid: 'mRet', kind: 'spec_med', date: '2026-06-08', next: '2027-06-08' },
  ];
  const S33 = [
    { id: 's1', kind: 'asbestos', status: 'run', member_ids: ['m1', 'm2', 'mDel', 'mRet', 'mBoss', 'mDup', 'mNoName', '__all__', 'dept:관리부', 'wSame'], worker_ids: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'wX'] },
    { id: 's2', kind: 'asbestos', status: 'done', member_ids: ['m1'], worker_ids: ['w1'] },
    { id: 's3', kind: 'asbestos', status: 'run', del: 1, member_ids: ['m1'], worker_ids: ['w1'] },
    { id: 's4', status: 'plan', member_ids: '["m1"]', worker_ids: 'w1, w4' },
    { id: 's5', kind: 'dredge', status: 'run', member_ids: [], worker_ids: ['w1'] },
    { id: 's6', kind: 'demolition', status: 'plan', member_ids: [], worker_ids: [] },
    { id: 's7', kind: 'asbestos', member_ids: '[]', worker_ids: '[w1,' },
    { id: 's8', kind: 'asbestos', status: 'run', member_ids: ['m2'], worker_ids: ['w3', 'w8'] },
  ];
  const proj33 = (m) => ({ id: m.id, name: m.name, role: m.role, rank: m.rank, dept: m.dept, seq: m.seq, admin: m.admin, dev: m.dev, tier: m.tier, on_loa: m.on_loa, del: m.del, retired: tier33.retired(m) });   // 비관리자(권민지형) member_list 투영 — gw-auth handleMemberList 칸
  const noTier33 = (m) => { const x = Object.assign({}, m); delete x.tier; return x; };
  const appApi33 = (members, workers, edu) => new Function('__m', '__w', '__e', [
    'var members = __m, workers = __w, edu = __e;',
    fn33('pad'), fn33('fmtDate'), fn33('todayStr'), fn33('asList'), TIERTXT33,
    fn33('memberRetired'), fn33('tierBootstrap'), fn33('tierOfMember'), fn33('isBossMember'), fn33('dispName'),
    fn33('liveMembers'), fn33('findMember'), fn33('memberName'),
    fn33('liveEdu'), fn33('eduLatest'), fn33('eduHasValidSpecial'), fn33('asbNoSpecial'), fn33('asbWorkerNames'), fn33('normAsbRow'),
    'return { gap: asbNoSpecial, names: asbWorkerNames, norm: normAsbRow };'].join('\n'))(members, workers, edu);
  const appGaps33 = (sites, members, workers, edu) => { const a = appApi33(members, workers, edu); const out = {}; JSON.parse(JSON.stringify(sites)).forEach((r) => { if (!r || r.del === 1 || r.status === 'done') return; a.norm(r); out[r.id] = a.gap(r); }); return out; };   // 앱 = renderSites가 그리는 줄(지운 줄 뺌) · siteEduLine 종결 건너뜀 · 입구 normAsbRow
  const V33 = [
    { n: '관리자형', app: MLIST33, svr: M33, edu: E33 },
    { n: '권민지형 투영', app: MLIST33.map(proj33), svr: M33, edu: E33 },
    { n: '교육 0건', app: MLIST33, svr: M33, edu: [] },
    { n: '지운 기록만', app: MLIST33, svr: M33, edu: E33.map((e) => Object.assign({}, e, { del: 1 })) },
    { n: '부트스트랩(명시 등급 없음)', app: MLIST33.map(noTier33), svr: M33.map(noTier33), edu: E33 },
  ];
  const cmp33 = V33.map((v) => { const a = appGaps33(S33, v.app, W33, v.edu), s = SE33.siteEduGaps(S33, v.edu, W33, v.svr); return { n: v.n, same: JSON.stringify(a) === JSON.stringify(s.gaps), keys: Object.keys(s.gaps).join(','), has: s.has_edu, a, s: s.gaps }; });
  const EXP_S1_33 = '갑돌,퇴사자,대표님,대표님,전사,김일용,일용하나,김일용,박일용,새이름';
  const EXP_ALL33 = '갑돌,을순,퇴사자,대표님,대표님,전사,김일용,일용하나,김일용,김일용,박일용,새이름,이수일용';
  T('v433 ① 앱·서버 규칙 대조(실행 — index.html asbNoSpecial·eduHasValidSpecial·eduLatest·asList·memberName·dispName·tierOfMember ↔ _lib/siteedu.js siteEduGaps, 같은 표본 5벌: 관리자형·권민지형 투영(retired 불리언)·교육 0건·지운 기록만·명시 등급 없음): 현장마다 같은 사람·같은 순서 · 지운·종결 대장 없음(s1·s4~s8) · 준설·철거·문자열 칸·깨진 JSON 칸 그대로 · 지운 회원·지운 일용직·이름 없음·토큰·없는 id 빠짐 · 지운 기록·special 아닌 기록·다른 대상 기록은 이수 아님 · 기록 여러 건·동명이인 · 대표(같은 이름 직원도 명부 첫 회원으로) 대표님 · 퇴사자 이름 · __all__ 전사 · has_edu(교육 0건·지운 기록만 = false)',
    cmp33.every((c) => c.same && c.keys === 's1,s4,s5,s6,s7,s8')
    && cmp33[0].s.s1.join(',') === EXP_S1_33 && cmp33[0].s.s4.join(',') === '갑돌,일용하나,김일용' && cmp33[0].s.s5.join(',') === '일용하나' && cmp33[0].s.s6.length === 0 && cmp33[0].s.s7.length === 0 && cmp33[0].s.s8.length === 0
    && cmp33[0].has === true && cmp33[1].has === true && cmp33[2].has === false && cmp33[3].has === false && cmp33[4].has === true
    && cmp33[1].s.s1.join(',') === EXP_S1_33 && cmp33[2].s.s1.join(',') === EXP_ALL33 && cmp33[3].s.s1.join(',') === EXP_ALL33 && cmp33[4].s.s1.join(',') === EXP_S1_33,
    JSON.stringify(cmp33.map((c) => ({ n: c.n, same: c.same, keys: c.keys, has: c.has, app: c.a.s1, svr: c.s.s1 }))));
  // ①-2 일용직 권한 숨김(opts.workerNames false — 일용직 권한 wk가 숨김인 사람, v433 검토): 이름은 직원만, 일용직은 현장별 수만(wk_n) —
  //      앱 asbNoSpecial에 직원 칸만·일용직 칸만 넣어 돌린 결과와 같다(같은 표본 5벌) · 기본(이름)에는 wk_n 키 없음
  const hid33 = V33.map((v) => {
    const a = appApi33(v.app, W33, v.edu), s = SE33.siteEduGaps(S33, v.edu, W33, v.svr, { workerNames: false }), mo = {}, wc = {};
    JSON.parse(JSON.stringify(S33)).forEach((r) => { if (!r || r.del === 1 || r.status === 'done') return; a.norm(r); mo[r.id] = a.gap(Object.assign({}, r, { worker_ids: [] })); wc[r.id] = a.gap(Object.assign({}, r, { member_ids: [] })).length; });
    return { n: v.n, keys: Object.keys(s).join(','), same: JSON.stringify(s.gaps) === JSON.stringify(mo) && JSON.stringify(s.wk_n) === JSON.stringify(wc), s };
  });
  const hasWk33 = (o) => Object.prototype.hasOwnProperty.call(o, 'wk_n');
  T('v433 ①-2 일용직 권한 숨김(siteEduGaps opts.workerNames false — 일용직 권한이 숨김인 사람): 같은 표본 5벌에서 이름 = 앱이 직원 칸만으로 낸 사람 · wk_n = 앱이 일용직 칸만으로 낸 사람 수(지운 일용직·이름 없음·없는 id·이수자는 안 셈) · 결과 키 has_edu·gaps·wk_n · 기본(이름)은 wk_n 키 없음',
    hid33.every((h) => h.same && h.keys === 'has_edu,gaps,wk_n') && !hasWk33(SE33.siteEduGaps(S33, E33, W33, M33)) && !hasWk33(SE33.siteEduGaps(S33, E33, W33, M33, { workerNames: true })) && !hasWk33(SE33.siteEduGaps(S33, E33, W33, M33, {}))
    && hid33[0].s.gaps.s1.join(',') === '갑돌,퇴사자,대표님,대표님,전사,김일용' && hid33[0].s.wk_n.s1 === 4 && hid33[0].s.wk_n.s4 === 2 && hid33[0].s.wk_n.s5 === 1 && hid33[0].s.wk_n.s6 === 0 && hid33[2].s.wk_n.s1 === 6,
    JSON.stringify(hid33.map((h) => ({ n: h.n, same: h.same, keys: h.keys, gaps: h.s.gaps.s1, wk: h.s.wk_n }))));
  // ①-3 서명 줄 고르기 = 서버 판정 줄(v433 검토 — 같은 id 두 줄에서 앞 줄 사람 이름이 뒤 줄에 그려졌다): 앱 siteGapSigs가 서명을 남기는 줄과 서버 gaps의 키가 같고,
  //      같은 id가 두 줄이면 지운·종결 줄을 뺀 뒤 첫 줄
  const sigApi33 = new Function([fn33('asList'), fn33('siteGapSig'), fn33('siteGapSigs'), 'return { one: siteGapSig, all: siteGapSigs };'].join('\n'))();
  const DUP33 = S33.concat([
    { id: 's8', status: 'run', member_ids: ['m1'], worker_ids: [] },                                                // s8 두 번째 줄 — 앞 줄만
    { id: 'dd', status: 'done', member_ids: ['m2'] }, { id: 'dd', status: 'run', member_ids: ['m1'] },              // 종결 줄 뒤의 같은 id — 진행 줄
    { id: 'dz', del: 1, status: 'run', member_ids: ['m2'] }, { id: 'dz', status: 'plan', member_ids: ['mRet'] },     // 지운 줄 뒤의 같은 id — 뒤 줄
    { id: '__proto__', status: 'run', member_ids: ['m1'] }, { status: 'run', member_ids: ['m1'] }, { id: 7, status: 'run', member_ids: ['m2'], worker_ids: ['w1'] },
  ]);
  const dSig33 = sigApi33.all(JSON.parse(JSON.stringify(DUP33))), dSvr33 = SE33.siteEduGaps(DUP33, E33, W33, M33);
  T('v433 ①-3 서명 줄 고르기(앱 siteGapSigs ↔ 서버 siteEduGaps): 서명이 있는 줄 = 서버가 판정한 줄(지운·종결·id 없음·__proto__ 빼고) · 같은 id 두 줄은 앞 줄(s8 = 원래 줄) · 종결·지운 줄 뒤의 같은 id는 뒤 줄(dd·dz) · 숫자 id는 글자 키 · 서명 = 그 줄의 member_ids·worker_ids(문자열 칸도 같은 서명)',
    Object.keys(dSig33).join(',') === Object.keys(dSvr33.gaps).join(',') && Object.keys(dSig33).join(',') === '7,s1,s4,s5,s6,s7,s8,dd,dz'
    && dSig33.s8 === JSON.stringify([['m2'], ['w3', 'w8']]) && dSvr33.gaps.s8.length === 0 && dSig33.dd === JSON.stringify([['m1'], []]) && dSvr33.gaps.dd.join(',') === '갑돌'
    && dSig33.dz === JSON.stringify([['mRet'], []]) && dSvr33.gaps.dz.join(',') === '퇴사자' && dSig33['7'] === JSON.stringify([['m2'], ['w1']]) && dSvr33.gaps['7'].join(',') === '일용하나' && !Object.prototype.hasOwnProperty.call(dSig33, '__proto__')
    && dSig33.s4 === JSON.stringify([['m1'], ['w1', 'w4']]) && dSig33.s4 === sigApi33.one({ member_ids: ['m1'], worker_ids: ['w1', 'w4'] }),
    JSON.stringify({ sig: Object.keys(dSig33), svr: Object.keys(dSvr33.gaps), s8: dSig33.s8, dd: dSig33.dd, dz: dSig33.dz }));

  // ② 특별교육 줄 — siteEduLine 실행(권한·서버 응답·서명별). 투입 인원 = '참여 근로자' 줄과 같은 풀이(asbWorkerNames — 지운·없는 사람·토큰은 사람 아님, v433 검토),
  //    일용직 권한이 없으면(명부 안 읽음) worker_ids만 있어도 사람이 있는 것으로 · 서버 wk_n = 이름 없는 일용직 수
  const sig33 = (r) => JSON.stringify([Array.isArray(r.member_ids) ? r.member_ids : [], Array.isArray(r.worker_ids) ? r.worker_ids : []]);
  const L33 = [
    { id: 'L1', status: 'run', member_ids: ['m1'], worker_ids: ['w1'] },
    { id: 'L0', status: 'plan', member_ids: [], worker_ids: [] },
    { id: 'LD', status: 'done', member_ids: ['m1'], worker_ids: [] },
    { id: 'LX', status: 'run', member_ids: ['m1'], worker_ids: [] },
    { id: 'LS', status: 'run', member_ids: ['m1'], worker_ids: ['w1'] },
    { id: 'LE', status: 'run', member_ids: ['m1'], worker_ids: [] },
    { id: 'LH', status: 'plan', member_ids: [], worker_ids: ['w1'] },
    { id: 'LG', status: 'run', member_ids: ['mGone', 'dept:관리부'], worker_ids: ['wD', 'wGone'] },   // 지운·없는 사람·토큰뿐 = 참여 근로자 '미지정' → 줄 없음
    { id: 'LW', status: 'run', member_ids: [], worker_ids: ['w2'] },
  ];
  const G33 = { has_edu: true, gaps: { L1: ['갑돌', '일용하나'], L0: [], LD: ['갑돌'], LS: ['갑돌'], LE: [], LH: ['<img src=x>'], LG: [], LW: [] } };
  const GS33 = {}; L33.forEach((r) => { GS33[r.id] = sig33(r); }); GS33.LS = JSON.stringify([['m1'], []]);   // LS = 답이 판정한 뒤 화면에서 일용직을 넣은 줄(서명 다름)
  const lineApi33 = (perm, gap, sig, edu, wk) => new Function('__perm', '__asb', '__gap', '__sig', '__edu', '__wk', [
    'function canSee(m){ return (__perm[m] || "hide") !== "hide"; }',
    'var asb = __asb, workers = __wk || [{ id: "w1", name: "일용하나" }, { id: "w2", name: "일용둘" }, { id: "wD", name: "지운일용", del: 1 }], members = [{ id: "m1", name: "갑돌" }], edu = __edu || [];',
    fn33('esc'), fn33('asList'), fn33('sheetRow'),
    'function findMember(id){ for(var i=0;i<members.length;i++){ if(members[i].id===id) return members[i]; } return null; }',
    fn33('memberName'), 'function dispName(n){ return n||""; }',
    fn33('liveEdu'), fn33('eduLatest'), fn33('eduHasValidSpecial'), fn33('asbNoSpecial'), fn33('asbWorkerNames'),
    'var siteEduGap = __gap, siteEduGapSig = __sig;', fn33('siteGapSig'), fn33('siteEduLine'), fn33('liveSites'), fn33('siteEduLines'),
    'return { line: function(id){ for (var i = 0; i < asb.length; i++){ if (asb[i] && asb[i].id === id) return siteEduLine(asb[i]); } return null; }, lines: siteEduLines };'].join('\n'))(perm, JSON.parse(JSON.stringify(L33)), gap, sig, edu, wk);
  const KJA33 = { site: 'do', lic: 'do', wk: 'do' }, KJAH33 = { site: 'do', wk: 'hide' }, SAFE33 = { safety: 'do', site: 'do', wk: 'do' };
  const ln33 = (perm, gap, sig, edu, wk) => { const a = lineApi33(perm, gap, sig, edu, wk); const o = {}; L33.forEach((r) => { o[r.id] = a.line(r.id); }); return o; };
  const row33 = (v, cls) => '<tr><th>특별교육</th><td' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td></tr>';
  const NAMES2_33 = '<tr><th>특별교육</th><td class="warn"><b>미이수 2명</b> — 갑돌, 일용하나 (배치 전 이수 필요)</td></tr>';
  const UNK33 = '<tr><th>특별교육</th><td class="warn">확인 못 함 — 현장 칸을 다시 열면 다시 확인합니다</td></tr>';
  const DIRTY33 = '<tr><th>특별교육</th><td class="warn">확인 못 함 — 바뀐 투입 인원은 저장된 뒤 다시 확인합니다</td></tr>';
  const WAIT33 = '<tr><th>특별교육</th><td>확인 중</td></tr>';
  const NOEDU33 = '<tr><th>특별교육</th><td class="warn">교육 기록 없음 — 이수 여부 미확인</td></tr>';
  const NONE33 = '<tr><th>특별교육</th><td>미이수 없음</td></tr>';
  const kOk33 = ln33(KJA33, G33, GS33), kWait33 = ln33(KJA33, undefined, {}), kNull33 = ln33(KJA33, null, {}), kNoEdu33 = ln33(KJA33, { has_edu: false, gaps: {} }, {});
  const sApp33 = ln33(SAFE33, { has_edu: true, gaps: { L1: ['다른사람'] } }, GS33), sNull33 = ln33(SAFE33, null, {});
  const sDone33 = ln33(SAFE33, null, {}, [{ id: 'x1', ptype: 'member', pid: 'm1', kind: 'special', date: '2026-01-01' }, { id: 'x2', ptype: 'worker', pid: 'w1', kind: 'special', date: '2026-01-01' }, { id: 'x3', ptype: 'worker', pid: 'w2', kind: 'special', date: '2026-01-01' }]);
  // 일용직 권한 숨김(명부를 안 읽어 workers 빈 배열): 서버 wk_n을 '일용직 n명'으로 · 이상한 wk_n(글자·음수·NaN·무한)은 0 · 소수는 내림
  const GH33 = { has_edu: true, gaps: { L1: ['갑돌'], LX: ['갑돌'], LS: [], LE: [], LH: [], LG: [], LW: [] }, wk_n: { L1: 1, LX: 0, LH: 0, LG: 0, LW: 1, LE: 0 } };
  const kH33 = ln33(KJAH33, GH33, GS33, [], []), kHodd33 = ln33(KJAH33, { has_edu: true, gaps: GH33.gaps, wk_n: { L1: '3', LW: -1, LE: NaN, LH: Infinity, LX: 2.7 } }, GS33, [], []);
  const kLines33 = lineApi33(KJA33, null, {}).lines(), kLines0_33 = new Function('__s', '__k', [   // 투입 인원 0명뿐인 대장(지금 운영 — 진행·예정 2건)이면 어떤 응답(첫 답 전 포함)에서도 보이는 특별교육 줄 0
    'function canSee(m){ return (__k[m] || "hide") !== "hide"; } var asb = __s, workers = [], members = [];', fn33('esc'), fn33('asList'), fn33('sheetRow'), 'function asbNoSpecial(){ return []; }',
    'function findMember(){ return null; }', fn33('memberName'), 'function dispName(n){ return n||""; }', fn33('asbWorkerNames'),
    'var siteEduGap, siteEduGapSig = {};', fn33('siteGapSig'), fn33('siteEduLine'), fn33('liveSites'), fn33('siteEduLines'),
    'var w = siteEduLines(); siteEduGap = null; var a = siteEduLines(); siteEduGap = { has_edu: false, gaps: {} }; var b = siteEduLines(); siteEduGap = { has_edu: true, gaps: { o1: [], o2: [] }, wk_n: null }; return [w, a, b, siteEduLines()];'].join('\n'))([{ id: 'o1', status: 'plan', member_ids: [], worker_ids: [] }, { id: 'o2', status: 'run', member_ids: '[]', worker_ids: '[]' }], KJA33);
  T('v433 ② 특별교육 줄(siteEduLine 실행): 김정아형(안전 없음·일용직 수행) — 서버 이름 "미이수 2명 — 갑돌, 일용하나 (배치 전 이수 필요)" · 이름 없음 "미이수 없음"(warn 아님) · 이 세션 첫 답 전(undefined) "확인 중"(warn 아님) · 물음 실패(null)·그 대장이 답에 없음 = "확인 못 함 — 현장 칸을 다시 열면 다시 확인합니다" · 답이 판정한 대장과 투입 인원이 다른 줄(서명 다름) = "확인 못 함 — 바뀐 투입 인원은 저장된 뒤 다시 확인합니다"(어느 쪽도 전원을 미이수로 그리지 않음) · 교육 기록 0건(has_edu false) = "교육 기록 없음 — 이수 여부 미확인"(서명이 달라도) · 투입 0명·종결·지운·없는 사람·토큰뿐(참여 근로자 미지정) = 줄 없음 · 이름은 이스케이프 / 일용직 권한 숨김 — 서버 wk_n을 "갑돌 외 일용직 1명"·"일용직 1명"으로, 이상한 wk_n은 0·소수는 내림, worker_ids만 있어도 줄 / 안전 권한형 — 서버 응답과 무관하게 앱 판정(asbNoSpecial) 이름, 모두 이수면 줄 없음(종전) · 투입 0명 대장뿐이면 어떤 응답(첫 답 전 포함)에서도 줄 0',
    kOk33.L1 === NAMES2_33 && kOk33.L0 === '' && kOk33.LD === '' && kOk33.LX === UNK33 && kOk33.LS === DIRTY33 && kOk33.LE === NONE33 && kOk33.LG === '' && kOk33.LW === NONE33
    && kOk33.LH.indexOf('&lt;img src=x&gt;') > 0 && kOk33.LH.indexOf('<img') < 0 && kOk33.LH.indexOf('<b>미이수 1명</b>') > 0
    && ['L1', 'LX', 'LS', 'LE', 'LH', 'LW'].every((k) => kWait33[k] === WAIT33) && kWait33.L0 === '' && kWait33.LD === '' && kWait33.LG === ''
    && kNull33.L1 === UNK33 && kNull33.LE === UNK33 && kNull33.LS === UNK33 && kNull33.L0 === '' && kNull33.LD === '' && kNull33.LG === '' && [kNull33, kWait33].every((o) => Object.keys(o).every((k) => (o[k] || '').indexOf('<b>미이수') < 0))
    && kNoEdu33.L1 === NOEDU33 && kNoEdu33.LS === NOEDU33 && kNoEdu33.LX === NOEDU33 && kNoEdu33.L0 === '' && kNoEdu33.LD === '' && kNoEdu33.LG === ''
    && kH33.L1 === row33('<b>미이수 2명</b> — 갑돌 외 일용직 1명 (배치 전 이수 필요)', 'warn') && kH33.LX === row33('<b>미이수 1명</b> — 갑돌 (배치 전 이수 필요)', 'warn') && kH33.LW === row33('<b>미이수 1명</b> — 일용직 1명 (배치 전 이수 필요)', 'warn')
    && kH33.LS === DIRTY33 && kH33.LE === NONE33 && kH33.LH === NONE33 && kH33.LG === NONE33 && kH33.L0 === '' && kH33.LD === ''
    && kHodd33.L1 === row33('<b>미이수 1명</b> — 갑돌 (배치 전 이수 필요)', 'warn') && kHodd33.LW === NONE33 && kHodd33.LE === NONE33 && kHodd33.LH === NONE33 && kHodd33.LX === row33('<b>미이수 3명</b> — 갑돌 외 일용직 2명 (배치 전 이수 필요)', 'warn')
    && sApp33.L1 === NAMES2_33 && sApp33.L0 === '' && sApp33.LD === '' && sApp33.LG === '' && sApp33.LE === '<tr><th>특별교육</th><td class="warn"><b>미이수 1명</b> — 갑돌 (배치 전 이수 필요)</td></tr>' && sApp33.LW === row33('<b>미이수 1명</b> — 일용둘 (배치 전 이수 필요)', 'warn') && sNull33.L1 === NAMES2_33
    && sDone33.L1 === '' && sDone33.LE === '' && sDone33.LH === '' && sDone33.LW === ''
    && kLines33.split('\n').length === L33.length && kLines33.indexOf(UNK33) >= 0 && kLines0_33.every((s) => s === '\n'),
    JSON.stringify({ k: kOk33, wait: kWait33, null: kNull33, noedu: kNoEdu33, wkh: kH33, odd: kHodd33, safe: sApp33, safeDone: sDone33, zero: kLines0_33 }));

  // ③ 서버 응답에 이름 밖 값 없음 — 순수 함수 결과 키 = has_edu·gaps, gaps 값 = 이름(문자열) 배열만, 이름은 그 현장 투입 인원(앱 asbWorkerNames 다중집합) 안에서만,
  //    교육 기록 값(이수일·종류·다음 예정·pid·ptype)·투입 인원 밖 이름(외부인)·지운 회원·지운 일용직·이수자 이름 없음 / 핸들러 200 응답 글자 = status·ok·has_edu·gaps·request_id(교육 0건이면 gaps {})
  const o33 = SE33.siteEduGaps(S33, E33, W33, M33), oj33 = JSON.stringify(o33);
  const sub33 = (arr, pool) => { const p = pool.slice(); return arr.every((n) => { const i = p.indexOf(n); if (i < 0) return false; p.splice(i, 1); return true; }); };
  const appA33 = appApi33(MLIST33, W33, E33);
  const inPool33 = Object.keys(o33.gaps).every((id) => sub33(o33.gaps[id], appA33.names(JSON.parse(JSON.stringify(S33.find((x) => x.id === id))))));
  const leak33 = ['2026-', '2025-', 'special', 'regular', 'pre_med', 'spec_med', '"next"', '"date"', '"pid"', '"ptype"', '"kind"', '"del"', '"status"', '"member_ids"', '외부인', '지운사람', '지운일용', '이수일용', '을순', '옛이름'].filter((w) => oj33.indexOf(w) >= 0);
  const hSrc33 = fnIn33(gd33, 'handleSiteEduGap');
  const res200_33 = (hSrc33.match(/return jr\(200, [^\n]*\);/g) || []);
  // 일용직 권한 숨김(opts.workerNames false): 결과 키 has_edu·gaps·wk_n · wk_n = 현장별 0 이상 정수(gaps와 같은 현장) · 일용직에게만 있는 이름(일용하나·박일용·새이름·이수일용·지운일용·옛이름) 0
  const oh33 = SE33.siteEduGaps(S33, E33, W33, M33, { workerNames: false }), ohj33 = JSON.stringify(oh33);
  const leakH33 = ['일용하나', '박일용', '새이름', '이수일용', '지운일용', '옛이름', '2026-', 'special', '"pid"', '"date"', '"next"', '외부인', '지운사람'].filter((w) => ohj33.indexOf(w) >= 0);
  T('v433 ③ 서버 응답에 이름 밖 값 없음: 결과 키 has_edu·gaps · gaps 값 = 이름 문자열 배열 · 이름은 그 현장 투입 인원 안(다중집합) · 교육 기록 값(이수일·종류·next·pid·ptype)·외부인·지운 회원·지운 일용직·이수자 이름 0 · 일용직 권한 숨김 결과 = has_edu·gaps·wk_n(현장별 0 이상 정수)·일용직 이름 0 · 핸들러 200 응답 1곳 = status·ok·has_edu·gaps(교육 0건이면 {})·일용직 권한 숨김이면 wk_n(교육 0건이면 {})·request_id',
    Object.keys(o33).join(',') === 'has_edu,gaps' && Object.keys(o33.gaps).every((k) => Array.isArray(o33.gaps[k]) && o33.gaps[k].every((n) => typeof n === 'string' && n.length > 0))
    && inPool33 && leak33.length === 0
    && Object.keys(oh33).join(',') === 'has_edu,gaps,wk_n' && Object.keys(oh33.wk_n).join(',') === Object.keys(oh33.gaps).join(',') && Object.keys(oh33.wk_n).every((k) => Number.isInteger(oh33.wk_n[k]) && oh33.wk_n[k] >= 0) && leakH33.length === 0
    && res200_33.length === 1 && res200_33[0] === "return jr(200, Object.assign({ status: 'OK', ok: true, has_edu: out.has_edu, gaps: out.has_edu ? out.gaps : {} }, wkSee ? {} : { wk_n: out.has_edu ? out.wk_n : {} }, { request_id: R }));",
    JSON.stringify({ keys: Object.keys(o33), pool: inPool33, leak: leak33, hidKeys: Object.keys(oh33), leakH: leakH33, res: res200_33 }));

  // ④ 읽기 — loadAsb·loadSiteEduGap·doSaveAsb 실행(진짜 Promise, 응답은 시험이 정함): 김정아형·현장 보기형 = 대장을 받은 뒤 site_edu_gap 1번(서명 = 받은 대장) · 관리자·안전 권한형 = 0번 ·
  //    권민지형(현장 숨김) = 아무것도 안 읽음 · 줄이 바뀐 때만 다시 그림(투입 0명뿐이면 다시 그림 0) · 첫 답 전 '확인 중' · 실패·이상한 응답 = 확인 못 함 · 늦게 온 옛 응답 무시 ·
  //    저장 서명 = 보낸 대장(응답 전에 또 고친 줄은 '저장된 뒤' — v433 검토) · 저장 실패로 저장 대기가 남아도 다시 열면 손대지 않은 줄은 이름 · 일용직 권한 숨김 = 서버 wk_n
  const flush33 = () => new Promise((r) => setTimeout(r, 0));
  const settle33 = (p) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r('timeout'), 50))]);   // 결함으로 끝나지 않는 약속이 시험 틀을 멈추지 않게
  const GAPDECL33 = (html.match(/var siteEduGap\b[^;\n]*;/) || [''])[0];   // 앱의 첫 상태 선언을 그대로(첫 답 전 = undefined — 바꾸면 아래 '확인 중'이 ✗)
  const loadApi33 = (perm, resp, wk) => { const log = []; const api = new Function('__perm', '__log', '__resp', '__wk', [
    'function canSee(m){ return (__perm[m] || "hide") !== "hide"; }',
    'var asb = [], asbBase = 0, asbPending = false, asbLoaded = false, asbSaveTimer = null;',
    'var members = [{ id: "m1", name: "갑돌" }, { id: "m2", name: "을순" }], workers = __wk || [{ id: "w1", name: "일용하나" }];',
    'function findMember(id){ for(var i=0;i<members.length;i++){ if(members[i].id===id) return members[i]; } return null; } function dispName(n){ return n||""; } function mergeDel(){ return 1; }',
    'function gwCall(fn, body){ var k = body.action + (body.collection ? ":" + body.collection : ""); __log.push(k); var r = __resp[k]; if (typeof r === "function") r = r(); if (r instanceof Error) return Promise.reject(r); return (r && typeof r.then === "function") ? r : Promise.resolve(r || { status: 500, body: {} }); }',
    'function csSiteHooksRetry(){ __log.push("hooks"); } function renderSites(){ __log.push("renderSites"); } function renderCalendar(){} function renderWorkers(){}',
    'function asbNoSpecial(){ return ["(앱 판정)"]; }',
    fn33('asList'), fn33('memberName'), fn33('asbWorkerNames'), fn33('mergeAsb'), fn33('normAsbRow'), fn33('liveAsb'), fn33('liveSites'), fn33('esc'), fn33('sheetRow'),
    GAPDECL33, 'var siteEduGapSig = {}, siteEduGapSeq = 0;',
    fn33('siteGapSig'), fn33('siteGapSigs'), fn33('siteEduLine'), fn33('siteEduLines'), fn33('loadSiteEduGap'), fn33('loadAsb'), fn33('doSaveAsb'),
    'return { load: loadAsb, save: doSaveAsb, gap: loadSiteEduGap, sigs: function(){ return siteGapSigs(asb); }, st: function(){ return { g: siteEduGap, s: siteEduGapSig, seq: siteEduGapSeq }; }, line: function(id){ for (var i = 0; i < asb.length; i++){ if (asb[i].id === id) return siteEduLine(asb[i]); } return null; },',
    '  edit: function(id, mids){ for (var i = 0; i < asb.length; i++){ if (asb[i].id === id) asb[i].member_ids = mids; } }, setPending: function(p){ asbPending = p; }, pending: function(){ return asbPending; } };'].join('\n'))(perm, log, resp, wk); return { api, log }; };
  const A_ASB33 = () => ({ status: 200, body: { doc: { items: [{ id: 'a1', status: 'run', member_ids: ['m1'], worker_ids: ['w1'] }, { id: 'a2', status: 'plan', member_ids: [], worker_ids: [] }, { id: 'a3', status: 'run', member_ids: ['m2'], worker_ids: [] }], updated_at: 7 } } });
  const A_GAP33 = () => ({ status: 200, body: { status: 'OK', ok: true, has_edu: true, gaps: { a1: ['갑돌'], a2: [], a3: ['을순'] } } });
  const k33 = loadApi33(KJA33, { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33 }); const kv33 = await k33.api.load(); await flush33();
  const kSt33 = k33.api.st(), kLog33 = k33.log.join(','), kL1_33 = k33.api.line('a1');
  const v33 = loadApi33({ site: 'view' }, { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33 }); await v33.api.load(); await flush33();
  const s33 = loadApi33(SAFE33, { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33, 'save:asbestos': { status: 200, body: { updated_at: 9 } } }); const sv33 = await s33.api.load(); await flush33(); const sGap33 = s33.api.gap(); s33.api.setPending(true); await s33.api.save(); await flush33();
  const adm33 = loadApi33({ safety: 'do', site: 'do', lic: 'do', con: 'do', wk: 'do' }, { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33 }); await adm33.api.load(); await flush33();
  const p33 = loadApi33({ safety: 'do' }, { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33 }); const pv33 = p33.api.load(); const pGap33 = p33.api.gap(); await flush33();
  // 지금 운영 모양(진행·예정 2건 모두 투입 0명, 교육 0건) — 응답이 와도 다시 그림 0
  const z33 = loadApi33(KJA33, { 'get:asbestos': () => ({ status: 200, body: { doc: { items: [{ id: 'o1', status: 'plan', member_ids: [], worker_ids: [] }, { id: 'o2', status: 'run', member_ids: '[]', worker_ids: '[]' }, { id: 'o3', status: 'done', member_ids: ['m1'] }], updated_at: 3 } } }), site_edu_gap: () => ({ status: 200, body: { status: 'OK', ok: true, has_edu: false, gaps: {} } }) });
  await z33.api.load(); await flush33();
  // 이 세션 첫 답 전 = '확인 중'(경고 아님 — 요청 전부터 '확인 못 함'이 경고색으로 뜨던 것, v433 검토) → 답이 오면 이름(그 줄이 바뀌어 다시 그림 1번)
  const wq33 = []; const w33 = loadApi33(KJA33, { 'get:asbestos': A_ASB33, site_edu_gap: () => new Promise((res) => { wq33.push(res); }) }); await w33.api.load(); await flush33();
  const wA1_33 = w33.api.line('a1'), wA2_33 = w33.api.line('a2'), wLog0_33 = w33.log.join(','), wG0_33 = w33.api.st().g;
  if (typeof wq33[0] === 'function') wq33[0](A_GAP33()); await flush33();
  const wLog1_33 = w33.log.join(','), wA1b_33 = w33.api.line('a1');
  // 실패·이상한 응답 → 응답 없음(확인 못 함) — 받은 이름을 지우고 그 줄이 바뀌었으니 다시 그림 · 이미 응답 없음이면 다시 그림 없음 · 서명 없이 물으면(부르는 쪽 결함) 이름을 그리지 않음
  const f33r = { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33 }, f33 = loadApi33(KJA33, f33r); await f33.api.load(); await flush33(); f33.log.length = 0;
  f33r.site_edu_gap = () => new Error('net'); const fr0_33 = await f33.api.gap(f33.api.sigs()); const fSt0_33 = f33.api.st(), fLog0_33 = f33.log.join(','), fL0_33 = f33.api.line('a1'); f33.log.length = 0;   // 받은 이름 → 네트워크 실패(catch 갈래)
  f33r.site_edu_gap = A_GAP33; await f33.api.gap(f33.api.sigs()); const fBack33 = f33.api.line('a1'); f33.log.length = 0;                                                                           // 다시 받음
  f33r.site_edu_gap = () => ({ status: 500, body: { status: 'ERROR', error_code: 'STORAGE_READ_FAILED' } }); const fr1_33 = await f33.api.gap(f33.api.sigs()); const fSt1_33 = f33.api.st(), fLog1_33 = f33.log.join(','), fL1_33 = f33.api.line('a1'); f33.log.length = 0;   // 받은 이름 → 500(then 갈래)
  f33r.site_edu_gap = () => new Error('net'); const fr2_33 = await f33.api.gap(f33.api.sigs()); const fLog2_33 = f33.log.join(','); f33.log.length = 0;                                     // 이미 응답 없음 → 또 실패 = 다시 그림 0
  f33r.site_edu_gap = A_GAP33; await f33.api.gap(); const fNoSig33 = f33.api.line('a1'), fNoSigS33 = JSON.stringify(f33.api.st().s); f33.log.length = 0;                       // 서명 없이 물음 → 받아도 모든 줄 '저장된 뒤'
  const odd33 =[{ status: 200, body: { status: 'OK', has_edu: true, gaps: { a1: [] } } }, { status: 200, body: { ok: true, has_edu: true, gaps: [] } }, { status: 403, body: { status: 'FORBIDDEN', error_code: 'NO_ACCESS', ok: true, has_edu: true, gaps: { a1: [] } } }].map((x) => { const o = loadApi33(KJA33, { 'get:asbestos': A_ASB33, site_edu_gap: () => x }); return o; });
  for (const o of odd33) { await o.api.load(); await flush33(); }
  // 늦게 온 옛 응답 — 두 번 묻고 둘째가 먼저 오면 첫째는 버린다
  const pend33 = []; const h33 = loadApi33(KJA33, { 'get:asbestos': A_ASB33, site_edu_gap: () => new Promise((res) => { pend33.push(res); }) }); await h33.api.load(); const hq2_33 = h33.api.gap(); await flush33();
  const hN33 = pend33.length, hRes33 = (i, v) => { if (typeof pend33[i] === 'function') pend33[i](v); };   // 물은 횟수가 어긋나도(결함) 시험 틀이 터지지 않고 아래 단언이 ✗로 잡게
  hRes33(1, { status: 200, body: { ok: true, has_edu: true, gaps: { a1: ['새답'], a2: [], a3: [] } } }); await flush33(); hRes33(0, { status: 200, body: { ok: true, has_edu: true, gaps: { a1: ['옛답'], a2: [], a3: [] } } }); await flush33();
  for (let i = 2; i < pend33.length; i++) hRes33(i, { status: 500, body: {} }); await flush33();
  const hSt33 = h33.api.st(), hq2v33 = await Promise.race([Promise.resolve(hq2_33), flush33().then(() => 'timeout')]);
  // 화면에서 투입 인원을 바꾼 줄 = '저장된 뒤'(다른 줄은 이름 그대로)
  const e33r = { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33 }, e33 = loadApi33(KJA33, e33r); await e33.api.load(); await flush33();
  e33.api.edit('a1', ['m1', 'm9']); e33.api.setPending(true); const eA1_33 = e33.api.line('a1'), eA3_33 = e33.api.line('a3'); e33.log.length = 0;
  // 저장 응답 전에 또 고침(v433 검토): 첫 저장(m1·m9)이 200이어도 그 뒤 고친 a1(m1·m9·m2)은 '저장된 뒤' — 서명 = 보낸 대장(화면 대장이 아님), 손대지 않은 a3은 이름 그대로
  const svq33 = [], svRes33 = (i, v) => { if (typeof svq33[i] === 'function') svq33[i](v); };
  e33r['save:asbestos'] = () => new Promise((res) => { svq33.push(res); });
  e33r.site_edu_gap = () => ({ status: 200, body: { ok: true, has_edu: true, gaps: { a1: ['갑돌', '신입'], a2: [], a3: ['을순'] } } });   // 서버 = 첫 저장본(m1·m9)을 판정
  const eP1_33 = e33.api.save(); await flush33();
  e33.api.edit('a1', ['m1', 'm9', 'm2']); e33.api.setPending(true);
  svRes33(0, { status: 200, body: { updated_at: 11 } }); await settle33(eP1_33); await flush33();
  const eA1c_33 = e33.api.line('a1'), eSig1_33 = e33.api.st().s.a1, eA3c_33 = e33.api.line('a3'), eLog1_33 = e33.log.join(','); e33.log.length = 0;
  // 다음 저장(타이머 몫 — 여기선 직접) 성공 → 보낸 대장으로 다시 확인해 새 이름
  e33r.site_edu_gap = () => ({ status: 200, body: { ok: true, has_edu: true, gaps: { a1: ['갑돌', '신입', '을순'], a2: [], a3: ['을순'] } } });
  const eP2_33 = e33.api.save(); await flush33(); svRes33(1, { status: 200, body: { updated_at: 12 } }); await settle33(eP2_33); await flush33();
  const eLog33 = e33.log.join(','), ePend33 = e33.api.pending(), eA1b_33 = e33.api.line('a1');
  // 저장 실패로 저장 대기가 남은 채 현장 칸을 다시 열기(v433 검토): 서명 = 받은 대장 → 손대지 않은 줄은 이름, 고친 줄만 '저장된 뒤'(종전엔 모든 줄이 계속 '확인 못 함')
  const x33 = loadApi33(KJA33, { 'get:asbestos': A_ASB33, site_edu_gap: A_GAP33, 'save:asbestos': () => new Error('net') }); await x33.api.load(); await flush33();
  x33.api.edit('a1', ['m1', 'm2']); x33.api.setPending(true); await settle33(x33.api.save()); await flush33(); x33.log.length = 0;
  const xv33 = await settle33(x33.api.load()); await flush33();
  const xLog33 = x33.log.join(','), xPend33 = x33.api.pending(), xA1_33 = x33.api.line('a1'), xA3_33 = x33.api.line('a3'), xSig33 = x33.api.st().s.a1;
  // 일용직 권한 숨김(명부를 안 읽어 workers 빈 배열): 서버 wk_n을 받아 '갑돌 외 일용직 1명'
  const wh33 = loadApi33({ site: 'do', wk: 'hide' }, { 'get:asbestos': A_ASB33, site_edu_gap: () => ({ status: 200, body: { status: 'OK', ok: true, has_edu: true, gaps: { a1: ['갑돌'], a2: [], a3: ['을순'] }, wk_n: { a1: 1, a2: 0, a3: 0 } } }) }, []); await wh33.api.load(); await flush33();
  const whA1_33 = wh33.api.line('a1'), whG33 = wh33.api.st().g, whLog33 = wh33.log.join(',');
  const NAMEA3_33 = '<tr><th>특별교육</th><td class="warn"><b>미이수 1명</b> — 을순 (배치 전 이수 필요)</td></tr>';
  T('v433 ④ 읽기(loadAsb·loadSiteEduGap·doSaveAsb 실행): 김정아형(현장 수행·안전 없음) = 대장 → 훅 → 그림 → site_edu_gap 1번(서명 = 받은 대장) → 그 줄이 바뀌어 다시 그림 1번(a1 "미이수 1명 — 갑돌") · 현장 보기형도 같음 · 안전 권한형·관리자형 = site_edu_gap 0번(대장 읽기·저장 뒤에도, 직접 불러도) · 권민지형(현장 숨김) = 아무것도 안 읽음 · 지금 운영 모양(투입 0명뿐·교육 0건) = 응답이 와도 다시 그림 0 · 첫 답 전 "확인 중"(앱 첫 상태 선언 그대로) → 답 오면 이름 · 500·네트워크 실패·ok 없음·gaps 배열·403 = 응답 없음(받은 이름 지움 → 확인 못 함, 이미 없음이면 다시 그림 0) · 서명 없이 물으면 이름 안 그림 · 늦게 온 옛 응답 버림 · 투입 인원을 바꾼 줄만 "저장된 뒤" · 저장 응답 전에 또 고친 줄은 저장 200 뒤에도 "저장된 뒤"(서명 = 보낸 대장) → 다음 저장 성공 뒤 새 이름 · 저장 실패로 저장 대기가 남아도 다시 열면 손대지 않은 줄은 이름 · 일용직 권한 숨김 = wk_n "갑돌 외 일용직 1명"',
    kv33 === true && kLog33 === 'get:asbestos,hooks,renderSites,site_edu_gap,renderSites' && kSt33.g && kSt33.g.has_edu === true && kSt33.g.gaps.a1.join(',') === '갑돌' && kSt33.s.a1 === JSON.stringify([['m1'], ['w1']]) && kSt33.seq === 1
    && kL1_33 === '<tr><th>특별교육</th><td class="warn"><b>미이수 1명</b> — 갑돌 (배치 전 이수 필요)</td></tr>'
    && v33.log.join(',') === 'get:asbestos,hooks,renderSites,site_edu_gap,renderSites'
    && sv33 === true && sGap33 === undefined && s33.log.join(',') === 'get:asbestos,hooks,renderSites,save:asbestos' && s33.api.st().seq === 0 && s33.api.pending() === false
    && adm33.log.join(',') === 'get:asbestos,hooks,renderSites' && adm33.api.st().seq === 0
    && pv33 === undefined && pGap33 === undefined && p33.log.length === 0
    && z33.log.join(',') === 'get:asbestos,hooks,renderSites,site_edu_gap' && z33.api.st().g && z33.api.st().g.has_edu === false
    && GAPDECL33 === 'var siteEduGap;' && wA1_33 === WAIT33 && wA2_33 === '' && wG0_33 === undefined && wLog0_33 === 'get:asbestos,hooks,renderSites,site_edu_gap' && wLog1_33 === wLog0_33 + ',renderSites' && wA1b_33 === kL1_33
    && fr0_33 === false && fSt0_33.g === null && JSON.stringify(fSt0_33.s) === '{}' && fLog0_33 === 'site_edu_gap,renderSites' && fL0_33 === UNK33 && fBack33 === kL1_33
    && fr1_33 === false && fSt1_33.g === null && JSON.stringify(fSt1_33.s) === '{}' && fLog1_33 === 'site_edu_gap,renderSites' && fL1_33 === UNK33
    && fr2_33 === false && fLog2_33 === 'site_edu_gap' && fNoSig33 === DIRTY33 && fNoSigS33 === '{}'
    && odd33.every((o) => o.api.st().g === null && o.log.join(',') === 'get:asbestos,hooks,renderSites,site_edu_gap,renderSites' && o.api.line('a1') === UNK33)
    && hN33 === 2 && hSt33.g && hSt33.g.gaps.a1.join(',') === '새답' && hSt33.seq === 2 && hq2v33 === true
    && eA1_33 === DIRTY33 && eA3_33 === NAMEA3_33
    && eA1c_33 === DIRTY33 && eSig1_33 === JSON.stringify([['m1', 'm9'], ['w1']]) && eA3c_33 === NAMEA3_33 && eLog1_33 === 'save:asbestos,site_edu_gap'
    && eLog33 === 'save:asbestos,site_edu_gap,renderSites' && ePend33 === false && eA1b_33 === '<tr><th>특별교육</th><td class="warn"><b>미이수 3명</b> — 갑돌, 신입, 을순 (배치 전 이수 필요)</td></tr>'
    && xv33 === true && xPend33 === true && xLog33 === 'get:asbestos,hooks,renderSites,site_edu_gap' && xA1_33 === DIRTY33 && xA3_33 === NAMEA3_33 && xSig33 === JSON.stringify([['m1'], ['w1']])
    && whA1_33 === '<tr><th>특별교육</th><td class="warn"><b>미이수 2명</b> — 갑돌 외 일용직 1명 (배치 전 이수 필요)</td></tr>' && whG33 && whG33.wk_n && whG33.wk_n.a1 === 1 && whLog33 === 'get:asbestos,hooks,renderSites,site_edu_gap,renderSites',
    JSON.stringify({ k: [kv33, kLog33, kSt33.seq, kL1_33], v: v33.log, s: [sv33, sGap33, s33.log], adm: adm33.log, p: [pv33, pGap33, p33.log], z: z33.log, w: [GAPDECL33, wA1_33, wA2_33, wLog0_33, wLog1_33, wA1b_33], f: [fr0_33, fLog0_33, fL0_33, fBack33, fr1_33, fLog1_33, fr2_33, fLog2_33, fL1_33, fNoSig33, fNoSigS33], odd: odd33.map((o) => [o.log.join(','), o.api.st().g]), h: [hN33, hSt33.seq, hSt33.g && hSt33.g.gaps.a1, hq2v33], e: [eA1_33, eA3_33, eA1c_33, eSig1_33, eA3c_33, eLog1_33, eLog33, ePend33, eA1b_33], x: [xv33, xPend33, xLog33, xA1_33, xA3_33, xSig33], wh: [whA1_33, whG33 && whG33.wk_n, whLog33] }));

  // ⑤ 정적 — 서버: 분기 1곳·검사 순서(로그인 → 기기 승인 → 현장 숨김 NO_ACCESS → 읽기)·읽기 실패·회원 명부 미가용 500·쓰기·감사·알림 0·판정은 _lib/siteedu.js만(저장소·네트워크 없음)
  //           앱: renderSites의 특별교육 줄 = siteEduLine(asbNoSpecial 직접 부름 0) · site_edu_gap 부르는 곳 = loadSiteEduGap 1곳 · loadAsb·doSaveAsb 200 갈래만 부름(안전 권한 아닐 때) · 현황 구간(@safety-now)은 손대지 않음
  const htmlNC33 = html.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
  const iCm33 = hSrc33.indexOf('currentMember(event)'), iDev33 = hSrc33.indexOf("error_code: 'DEVICE_NOT_APPROVED'"), iAcc33 = hSrc33.indexOf("if (permOf(c.member, 'asbestos') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });"), iWk33 = hSrc33.indexOf("const wkSee = permOf(c.member, 'workers') !== 'hide';"), iRd33 = hSrc33.indexOf('blobGet(');
  const hNC33 = hSrc33.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
  const sfA33 = html.indexOf('// @safety-now-start'), sfB33 = html.indexOf('// @safety-now-end'), sfSec33 = (sfA33 >= 0 && sfB33 > sfA33) ? html.slice(sfA33, sfB33) : '';
  const rs33 = fn33('renderSites'), la33 = fn33('loadAsb'), ds33 = fn33('doSaveAsb'), sel33 = fn33('siteEduLine'), lg33 = fn33('loadSiteEduGap');
  T('v433 ⑤ 정적: gw-data 분기 site_edu_gap 1곳 → handleSiteEduGap · 검사 순서 로그인 → 기기 승인(DEVICE_NOT_APPROVED) → permOf(member,"asbestos") 숨김 403 NO_ACCESS → 일용직 권한(permOf workers) → 읽기 · 대장·교육·명부·회원 명부를 함께 읽음(Promise.all 1번 — 차례 읽기 await 0) · 대장·교육·명부 읽기 실패 500 · 회원 명부 미가용 500 MEMBERS_UNAVAILABLE · 핸들러에 쓰기·감사·알림 0 · 판정 = SITEEDU.siteEduGaps 1번(workerNames: wkSee) · _lib/siteedu.js는 저장소·네트워크·환경 변수 0(순수) · 앱 renderSites = siteEduLine(r)(asbNoSpecial 직접 0) · siteEduLine의 asbNoSpecial은 안전 권한 갈래에만 · 투입 인원 = asbWorkerNames(일용직 권한 없으면 worker_ids) · 첫 상태 선언 var siteEduGap;(undefined) · site_edu_gap 글자 = loadSiteEduGap 1곳 · loadSiteEduGap은 화면 대장으로 서명하지 않음(부르는 쪽이 넘김) · loadAsb는 그림 뒤 안전 권한이 아닐 때만 받은 대장 서명으로 · doSaveAsb는 보내기 전 서명 → 200 갈래에서만 그 서명으로 · 현황 구간에 siteEdu 0',
    (gd33.match(/d\.action === 'site_edu_gap'/g) || []).length === 1 && /if \(d && d\.action === 'site_edu_gap'\) return await handleSiteEduGap\(event, d, R\);/.test(gd33)
    && iCm33 > 0 && iDev33 > iCm33 && iAcc33 > iDev33 && iWk33 > iAcc33 && iRd33 > iWk33
    && /if \(bad\) return jr\(500, \{ status: 'ERROR', error_code: bad\.code \|\| 'STORAGE_READ_FAILED', request_id: R \}\);/.test(hSrc33) && /const bad = \[ra, re, rw\]\.filter\(function \(x\) \{ return !x\.ok; \}\)\[0\];/.test(hSrc33)
    && /const got = await Promise\.all\(\[blobGet\(st, colKey\('asbestos'\)\), blobGet\(st, colKey\('edu'\)\), blobGet\(st, colKey\('workers'\)\), push\.loadMembers\(\)\]\);/.test(hSrc33) && /const ra = got\[0\], re = got\[1\], rw = got\[2\], ms = got\[3\];/.test(hSrc33)
    && (hNC33.match(/\bawait\b/g) || []).length === 3 && (hNC33.match(/blobGet\(/g) || []).length === 3 && (hNC33.match(/loadMembers\(/g) || []).length === 1
    && /if \(!Array\.isArray\(ms\) \|\| ms\.unavailable\) return jr\(500, \{ status: 'ERROR', error_code: 'MEMBERS_UNAVAILABLE', request_id: R \}\);/.test(hSrc33)
    && !/blobSet|blobDelete|appendAudit|sendTo|verSnapshot/.test(hSrc33) && (hSrc33.match(/SITEEDU\.siteEduGaps\(/g) || []).length === 1 && /SITEEDU\.siteEduGaps\(items\(ra\), items\(re\), items\(rw\), ms, \{ workerNames: wkSee \}\)/.test(hSrc33) && /const SITEEDU = require\('\.\/_lib\/siteedu'\);/.test(gd33)
    && !/require\('\.\/(?:blobs|push|audit|session|claude)'\)|fetch\(|process\.env|blobGet|blobSet/.test(lib33) && /require\('\.\/tier'\)/.test(lib33)
    && /\+ siteEduLine\(r\)/.test(rs33) && rs33.indexOf('asbNoSpecial(') < 0 && /if \(canSee\("safety"\)\) names = asbNoSpecial\(r\);/.test(sel33) && (sel33.match(/asbNoSpecial\(/g) || []).length === 1
    && /if \(!asbWorkerNames\(r\)\.length && !\(!canSee\("wk"\) && asList\(r\.worker_ids\)\.length\)\) return "";/.test(sel33)
    && (html.match(/var siteEduGap\b[^;\n]*;/g) || []).join('|') === 'var siteEduGap;'
    && (htmlNC33.match(/site_edu_gap/g) || []).length === 1 && lg33.indexOf('gwCall("gw-data", { action: "site_edu_gap" })') > 0 && /if \(canSee\("safety"\) \|\| !canSee\("site"\)\) return;/.test(lg33) && !/liveAsb\(|liveSites\(\)\.forEach|asbPending/.test(lg33)
    && /renderSites\(\); renderCalendar\(\); renderWorkers\(\);[^\n]*\n\s*if \(!canSee\("safety"\)\) loadSiteEduGap\(siteGapSigs\(ri\)\);/.test(la33) && (la33.match(/loadSiteEduGap\(/g) || []).length === 1
    && /function doSaveAsb\(\)\{\n\s*var sent = canSee\("safety"\) \? null : siteGapSigs\(asb\);[^\n]*\n\s*return gwCall\("gw-data",\{action:"save",collection:"asbestos",doc:\{schema:1,items:asb\},base:asbBase\}\)/.test(ds33)
    && /if\(res\.status===200\)\{ asbBase=\(res\.body&&res\.body\.updated_at\)\|\|Date\.now\(\); asbPending=false; if\(!canSee\("safety"\)\) loadSiteEduGap\(sent\); \}/.test(ds33) && (ds33.match(/loadSiteEduGap\(/g) || []).length === 1
    && (htmlNC33.match(/loadSiteEduGap\(/g) || []).length === 3 && (htmlNC33.match(/siteGapSigs\(/g) || []).length === 3 && sfSec33.length > 1000 && !/siteEdu|site_edu_gap|siteGapSig/.test(sfSec33),
    JSON.stringify({ order: [iCm33, iDev33, iAcc33, iWk33, iRd33], awaits: (hNC33.match(/\bawait\b/g) || []).length, callers: (htmlNC33.match(/loadSiteEduGap\(/g) || []).length, sigs: (htmlNC33.match(/siteGapSigs\(/g) || []).length, gapStr: (htmlNC33.match(/site_edu_gap/g) || []).length }));

  // ⑥ 문서 — MANUAL 28절 특별교육 줄(안전 권한 쪽과 현장 칸만 보는 쪽을 나눔 — 셋째·넷째 줄이 대상 없이 적혀 관리자 화면과 어긋났다, v433 검토) · 21-9 안내 ·
  //      FEATURES 기준·v433 절·§7 · TESTLIST v433(체크 칸 전부 AI 몫 — 화면 칸은 '(AI 시험 화면 대상', PM 0, 닫힌 [x]도 같은 내용 검사) · CLAUDE.md · sw ≥ 433
  //      낱말이 아니라 문장으로 고정한다(종전 '이름만'은 28절의 다른 문장 '이름만 넣어'에 늘 걸렸고, 뜻을 뒤집어도 낱말이 남아 통과했다)
  const man33 = rd33('MANUAL.html'), ft33 = rd33('FEATURES.md'), tl33 = rd33('TESTLIST.md'), cl33 = rd33('CLAUDE.md'), sw33 = rd33('sw.js');
  const secM33 = (a, b) => { const i = man33.indexOf(a); return i < 0 ? '' : man33.slice(i, man33.indexOf(b, i + a.length)); };
  const m28_33 = secM33('<h2 id="s28">', '<h3 id="s28-1">'), m219_33 = secM33('<h3>21-9.', '<h3>21-10.');
  const liOf33 = (src, head) => { const i = src.indexOf(head); if (i < 0) return ''; let d = 0; const re = /<li\b|<\/li>/g; re.lastIndex = i; let m; while ((m = re.exec(src))) { if (m[0] === '</li>') { d--; if (d === 0) return src.slice(i, m.index + 5); } else d++; } return ''; };   // head에서 시작하는 li 하나(안쪽 목록 포함)
  const liSafe33 = liOf33(m28_33, '<li>안전 권한이 있는 분'), liSite33 = liOf33(m28_33, '<li>안전 권한 없이 현장 칸만 보는 분'), out28_33 = liSite33 ? m28_33.split(liSite33).join('') : m28_33;
  const M28SITE33 = ['기록이 없는 사람의 <b>이름만</b> 골라 보내 줍니다(교육 종류·이수일·건강진단은 오지 않습니다).', '모두 이수했으면 <b>미이수 없음</b>입니다.', '일용직 권한이 없는 분에게는 일용직이 이름 없이 <b>일용직 n명</b>으로만 나옵니다',
    '<li><b>교육 기록 없음 — 이수 여부 미확인</b> — 교육·검진 기록이 아직 한 건도 없을 때입니다(전원을 미이수로 그리지 않습니다).', '<li><b>확인 중</b> — 현장 칸을 처음 열어 서버 답을 기다리는 잠깐입니다.</li>',
    '<li><b>확인 못 함 — 현장 칸을 다시 열면 다시 확인합니다</b> — 서버에서 답을 받지 못했을 때입니다.</li>', '<li><b>확인 못 함 — 바뀐 투입 인원은 저장된 뒤 다시 확인합니다</b> — 근로자를 넣거나 뺀 뒤 저장이 끝나기 전입니다(저장되면 저절로 바뀝니다).', '앱을 새로고침(F5)한 뒤 근로자를 다시 넣어 주세요.'];
  const m28miss33 = M28SITE33.filter((s) => liSite33.indexOf(s) < 0);
  const tlv33 = (() => { const i = tl33.indexOf('\n## v433'); if (i < 0) return ''; const j = tl33.indexOf('\n## ', i + 5); return tl33.slice(i, j < 0 ? tl33.length : j); })();
  const cb33 = tlv33.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi33 = cb33.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l)), cbPM33 = cb33.filter((l) => /PM/.test(l));
  const cbOf33 = (key) => cb33.filter((l) => l.indexOf(key) >= 0 && /^- \[[ x]\] \(AI 시험 화면 대상/.test(l))[0] || '';   // AI가 시험 뒤 [x]로 닫아도 같은 내용 검사
  const tlK33 = cbOf33('김정아·정재욱형'), tlR33 = cbOf33('시험 교육 기록'), tlF33 = cbOf33('서버 응답 실패'), tlA33 = cbOf33('관리자형'), tlW33 = cbOf33('일용직 숨김형'), tlS33 = cbOf33('저장 실패 뒤 다시 열기');
  const ftv33 = (() => { const i = ft33.indexOf('\n### v433 (11/10)'); if (i < 0) return ''; const j = ft33.indexOf('\n### ', i + 5); return ft33.slice(i, j < 0 ? ft33.length : j); })();
  const ft7_33 = ft33.split('\n').filter((ln) => ln.indexOf('- **안전**(v428') === 0)[0] || '';
  T('v433 ⑥ 문서: MANUAL 28절 특별교육 줄(안전 권한 li = 앱 계산 이름·없으면 줄 없음·기록 0건이면 전원 미이수, 그 li에 "교육 기록 없음"·"확인 못 함" 없음 / 안전 권한 없이 현장 칸만 li = 서버가 고른 이름만(종류·이수일·건강진단 안 옴 — 문장 그대로)·"미이수 없음"·일용직 n명 · 하위 목록 "교육 기록 없음 — 이수 여부 미확인"(전원을 미이수로 그리지 않습니다 — 문장 그대로)·"확인 중"·"확인 못 함" 둘(새로고침 안내) — 이 넷은 그 li 밖에 없음 · 투입 0명은 줄 없음) · 21-9 안내 · FEATURES 기준 ≥ v433·v433 절(site_edu_gap·_lib/siteedu.js·has_edu·wk_n·siteGapSigs·확인 중·알려진 한계·uismoke v433·servertest 78)·§7 안전 줄 · TESTLIST v433 체크 칸 전부 AI 몫(화면 칸 6 = 김정아·정재욱형·시험 교육 기록·서버 응답 실패·관리자형·일용직 숨김형·저장 실패 뒤 다시 열기 — 열린 [ ]·닫힌 [x] 모두 같은 내용 검사, PM 0) · CLAUDE.md(site_edu_gap·_lib/siteedu.js·siteGapSigs·wk_n·알려진 한계·두 벌) · sw ≥ 433',
    m28_33.indexOf('보는 분의 권한에 따라 이렇게 나옵니다') > 0 && m28_33.indexOf('<b>미이수 n명 — 이름</b>으로 보여 줍니다') > 0 && m28_33.indexOf('투입 인원이 없는 현장은 이 줄이 없습니다') > 0
    && liSafe33.indexOf('미이수자가 없으면 줄이 없습니다') > 0 && liSafe33.indexOf('교육·검진 기록이 아직 한 건도 없으면 투입 인원 전원이 미이수로 나옵니다') > 0 && liSafe33.indexOf('교육 기록 없음') < 0 && liSafe33.indexOf('확인 못 함') < 0 && liSafe33.indexOf('<ul>') < 0
    && liSite33.length > 0 && m28miss33.length === 0 && liSite33.indexOf('<ul>') > 0
    && out28_33.indexOf('교육 기록 없음') < 0 && out28_33.indexOf('확인 못 함') < 0 && out28_33.indexOf('<b>확인 중</b>') < 0 && out28_33.indexOf('일용직 n명') < 0
    && m219_33.indexOf('서버가 기록이 없는 사람의 이름만 골라') > 0 && m219_33.indexOf('(28절)') > 0
    && Number((ft33.match(/기준: v(\d+) /) || [0, 0])[1]) >= 433 && ['`site_edu_gap`', '`_lib/siteedu.js`', '`has_edu`', '`wk_n`', '`siteGapSigs`', '교육 기록 없음 — 이수 여부 미확인', '확인 못 함 — 바뀐 투입 인원은 저장된 뒤 다시 확인합니다', "'확인 중'", '미이수 없음', 'uismoke v433', 'servertest 78', '`siteEduLine`', '`loadSiteEduGap', '**알려진 한계', '투입 인원(member_ids·worker_ids)을 바꿔 저장한 뒤'].every((w) => ftv33.indexOf(w) > 0)
    && ft7_33.indexOf('특별교육 줄') > 0 && ft7_33.indexOf('v433') > 0
    && tlv33.length > 0 && cb33.length >= 7 && cbNotAi33.length === 0 && cbPM33.length === 0 && tlv33.indexOf('PM 몫') < 0 && cb33.some((l) => /^- \[x\] \(AI\) `uismoke`/.test(l))
    && tlK33.indexOf('투입 인원 0명') > 0 && tlK33.indexOf('교육 기록 없음 — 이수 여부 미확인') > 0 && tlK33.indexOf('375px') > 0
    && tlR33.indexOf('미이수 없음') > 0 && tlR33.indexOf("'확인 중'") > 0 && tlR33.indexOf('확인 못 함 — 바뀐 투입 인원은 저장된 뒤 다시 확인합니다') > 0 && tlR33.indexOf('지운 일용직') > 0 && tlR33.indexOf("참여 근로자 '미지정'") > 0
    && tlF33.indexOf('확인 못 함') > 0 && tlF33.indexOf('전원을 미이수로 그리지 않음') > 0
    && tlA33.indexOf('site_edu_gap 요청 0건') > 0 && tlA33.indexOf('권민지형') > 0
    && tlW33.indexOf('일용직 n명') > 0 && tlW33.indexOf('일용직 이름 0') > 0 && tlW33.indexOf('wk_n') > 0 && tlS33.indexOf('손대지 않은 다른 현장 줄은 서버 이름 그대로') > 0 && tlS33.indexOf('저장된 뒤') > 0
    && ['`site_edu_gap`', '`_lib/siteedu.js`', 'uismoke v433', '`siteGapSigs`', '`wk_n`', '알려진 한계'].every((w) => cl33.indexOf(w) > 0)
    && Number((sw33.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 433,
    JSON.stringify({ m28: m28_33.length, liSafe: liSafe33.length, liSite: liSite33.length, m28miss: m28miss33.map((s) => s.slice(0, 30)), m219: m219_33.length, ftv: ftv33.length, ft7: ft7_33.length, tl: tlv33.length, cb: cb33.length, notAi: cbNotAi33.map((l) => l.slice(0, 40)), pm: cbPM33.map((l) => l.slice(0, 40)), tlc: [tlK33.length, tlR33.length, tlF33.length, tlA33.length, tlW33.length, tlS33.length] }));
} catch (e) { console.log('  (v433 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v434(11/10 메뉴 56 4-2, PM 11/9 "56. ㄱ" — 확인 항목 기본안 권민지·정재욱 보기): 화관법 탭 숨김·서버 폐기물 제출 수행 검사(앱·서버) — 브리핑 steps[3]의 4-2·코드 지도 code.steps[3] 중 탭 연결·제출 검사.
//      선행 확인: 11/10 운영 gw_users 김정아 hw=do · 권민지 hw=view · 정재욱 hw=view(그 밖 기본 숨김). v431 묶음 ①②③⑤⑥⑥-2는 4-2 상태로 뒤집었고, 이 묶음은 새로 생긴 동작을 본다:
//      ⓐ 4-1 예외 표식 글이 코드에 0 ⓑ 사람별 사이드바 칸 수(실제 nav·permOf·applyPerms·applySafetyPerms 실행 — 4-1 흉내와 비교해 바뀐 칸은 화관법 하나) ⓒ renderHwWaste 실행(보기 = 안내 · 수행 = 제출 칸)
//      ⓒ-2(검토 반영) 한 기기 사람 전환 실행(실제 applyPerms·renderHwakwan·renderHwWaste — 로그인 창 '전환'은 새로고침 없이 applyPerms만 돈다: 수행 → 보기 = 안내로 바뀜·앞사람 결과 안 보임, 보기 → 수행 = 제출 칸, 관리자 → 수행 = ▶ 지금 실행 숨김, 숨김 = 홈)
//      ⓓ hwSubmitWaste·hwFailText·loadHwStatus 실행(보기 = 알림만·요청 0 · 수행 = 요청 · 서버 NO_WRITE = 같은 글 · 옛 앱 흉내는 서버 몸체 error로 거절 이유를 봄) ⓔ switchTab 실행(숨김 = 어떤 길로 와도 홈) ⓕ 보기 권한 ↻ 새로고침 CSS 예외
//      ⓖ 문서(MANUAL 27 대신 제출 카드 전체 — 칸 누름 횟수 = PM_NEXT 실행 · FEATURES v434 서버·사람별 문장 · TESTLIST v434 칸 전부 AI 몫·콘솔 꼴·push 직전 재대조 · CLAUDE.md 제출 거절 규약 · sw). 서버 쪽 실행은 servertest 77⑥(뒤집음)·79.
try {
  const fn34 = (name) => { const i = html.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const rd34 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const stmt34 = (re) => { const m = html.match(re); if (!m) throw new Error('문장 없음: ' + re); return m[0]; };
  const sw34 = rd34('sw.js'), man34 = rd34('MANUAL.html'), cl34 = rd34('CLAUDE.md'), ft34 = rd34('FEATURES.md'), tl34 = rd34('TESTLIST.md');
  const mkCl34 = (init) => { const s = new Set(init || []); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); return s.has(c); }, contains: (c) => s.has(c) }; };

  // ⓐ 4-1 예외 표식 — v431이 hw만 통과시키며 4곳(4번 auth↔data · v428 ⑨ · v429 ② · v430 ⑧)에 달아 둔 표식 글(MARK34)이 코드에 남지 않았는지(이 검사 글자는 둘로 쪼개 스스로 걸리지 않게)
  const MARK34 = '4-2에서 ' + '해제';
  const fdir34 = join(ROOT, 'netlify', 'functions');
  const files34 = ['index.html', 'sw.js', 'tools/uismoke.mjs', 'tools/servertest.mjs'].concat(
    readdirSync(fdir34).filter((f) => /\.js$/.test(f)).map((f) => 'netlify/functions/' + f),
    readdirSync(join(fdir34, '_lib')).filter((f) => /\.js$/.test(f)).map((f) => 'netlify/functions/_lib/' + f));
  const marked34 = files34.filter((p) => rd34(p).indexOf(MARK34) >= 0);
  T('v434 ⓐ 4-1 예외 표식 글 0곳 — 앱·sw·서버 함수·_lib·uismoke·servertest ' + files34.length + '파일(걷은 예외: v428 ⑨·v429 ②·v430 ⑧은 예외 없음, 4번 auth↔data는 "저장 데이터 없는 키"로 남기고 gw-hwakwan의 hw 강제를 함께 대조)',
    files34.length > 30 && marked34.length === 0, '남은 파일: ' + marked34.join(', '));

  // ⓑ 사람별 사이드바 칸 수 — 실제 nav(21칸·처음 class 그대로)·실제 permOf/PERM_CLOSED·applyPerms·applySafetyPerms를 돌린다. 권한 = 브리핑 people(11/9 명부) + 11/10 hw 저장값.
  //    4-1 흉내(v433 모양 — 두 표에서 hw를 빼고 applyPerms 화관법 전용 줄을 지움)와 비교해 바뀐 칸이 화관법 하나뿐인지(안전 탭 등 다른 칸 그대로)
  const nav34 = html.slice(html.indexOf('<nav class="tabbar" id="tabbar">'), html.indexOf('</nav>'));
  const navEls34 = [...nav34.matchAll(/<(button|div) class="([^"]+)"(?: data-tab="([\w-]+)")?(?: id="(\w+)")?/g)].map((m) => ({ cls: m[2].split(/\s+/), tab: m[3] || '', id: m[4] || '' }));
  const REG42_34 = [stmt34(/var MODULES = \[[^\]]+\];/), stmt34(/var MODULE_TAB = \{[^}]+\};/), stmt34(/var MODULE_VIEW = \{[^}]+\};/)];
  const AP42_34 = fn34('applyPerms');
  const REG41_34 = [REG42_34[0], REG42_34[1].replace(', hw:"tabHwakwanBtn"', ''), REG42_34[2].replace(', hw:"view-hwakwan"', '')];
  const AP41_34 = AP42_34.replace(/\n[ \t]*if \(currentTab === "hwakwan"\)\{ if \(!canSee\("hw"\)\) switchTab\("dash"\); else renderHwakwan\(\); \}[^\n]*/, '');
  const runNav34 = (m, reg, ap) => {
    const els = navEls34.map((e) => ({ id: e.id, tab: e.tab, classList: mkCl34(e.cls), style: {}, getAttribute: (n) => (n === 'data-tab' ? e.tab : null), querySelectorAll: () => [] }));
    els.forEach((el, i) => { el.previousElementSibling = i > 0 ? els[i - 1] : null; });
    const byId = {}, other = {}, log = []; let undef = 0; els.forEach((el) => { if (el.id) byId[el.id] = el; });
    const doc = { getElementById: (id) => { if (id === undefined || id === null || String(id) === 'undefined') undef++; if (id === 'tabbar') return { children: els }; if (byId[id]) return byId[id]; return other[id] || (other[id] = { id, classList: mkCl34(), style: {}, getAttribute: () => null, querySelectorAll: () => [] }); }, querySelectorAll: () => [] };
    new Function('__doc', '__m', '__log', [
      'var document = __doc; var currentTab = "dash", safetyLayer = "site", eduViewScope = "member";',
      'function curMember(){ return __m; }', stmt34(/var PERM_CLOSED = \{[^}]+\};/), fn34('permOf'), fn34('canDo'), fn34('canSee'), fn34('isAdmin'),
      'function switchTab(n){ __log.push("switch:" + n); currentTab = n; } function updateUserChip(){} function updateApprovalBadges(){}',
      'function renderHwakwan(){ __log.push("render:hw"); }',   // (v434 검토) 홈에서 돌린 applyPerms는 화관법을 다시 그리지 않는다(아래 b.log 0) — 다른 탭에서도 그리는 결함이 '검사 생략'이 아니라 이 검사 ✗로
      'function renderSites(){} function loadAsb(){} function loadEdu(){} function loadWorkers(){ return { then: function(){} }; } function renderEdu(){} function sfNowOpen(){}',
      reg.join('\n'), fn34('safetyPanes'), fn34('setSafetyLayer'), fn34('applySafetyPerms'), ap, 'applyPerms();'].join('\n'))(doc, m, log);
    return { vis: els.filter((el) => el.classList.contains('tab-btn') && !el.classList.contains('perm-hidden')).map((el) => el.id), log, undef };
  };
  const KMJ34 = { tasks: 'hide', veh: 'do', rec: 'hide', lic: 'view', site: 'hide', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'view', quote: 'view', promo: 'do', safety: 'hide', hw: 'view' };
  const P34 = {
    admin: { id: 'a', admin: true, perms: { tasks: 'do', veh: 'do', rec: 'do', lic: 'do', check: 'do', con: 'view', cli: 'view', doc: 'view', wk: 'view', quote: 'view', promo: 'view' } },   // 관리자 3명 모양(나경일)
    kja: { id: 'k1', perms: { tasks: 'hide', veh: 'do', rec: 'hide', lic: 'do', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'do', quote: 'view', promo: 'do', site: 'do', safety: 'hide', hw: 'do' } },   // 김정아
    kmj: { id: 'k2', perms: KMJ34 },   // 권민지(안전 부여 전)
    kmjS: { id: 'k2', perms: Object.assign({}, KMJ34, { safety: 'do' }) },   // 권민지(안전 부여 뒤 — 브리핑 ②)
    jjw: { id: 'k3', perms: { tasks: 'view', veh: 'do', rec: 'hide', lic: 'view', site: 'do', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'do', quote: 'hide', promo: 'hide', safety: 'hide', hw: 'view' } },   // 정재욱
    kht: { id: 'k4', perms: { tasks: 'hide', veh: 'view', rec: 'hide', lic: 'hide', check: 'do', con: 'hide', cli: 'hide', doc: 'view', wk: 'view', quote: 'view', promo: 'view', hw: 'hide' } },   // 김호태(명시 숨김)
    fld: { id: 'k5', perms: { tasks: 'hide', veh: 'view', rec: 'hide', lic: 'hide', site: 'hide', check: 'do', con: 'hide', cli: 'hide', doc: 'view', wk: 'hide', quote: 'hide', promo: 'hide' } },   // 현장 8명(값 없음 = 기본 숨김)
    dmy: { id: 'k6', perms: { tasks: 'do', veh: 'do', rec: 'view', lic: 'view', site: 'do', check: 'do', con: 'hide', cli: 'view', doc: 'view', wk: 'do', quote: 'hide', promo: 'hide' } },   // 더미(값 없음)
  };
  const WANT34 = { admin: [21, 21], kja: [15, 15], kmj: [14, 14], kmjS: [15, 15], jjw: [14, 14], kht: [12, 11], fld: [9, 8], dmy: [15, 14] };   // [4-1 흉내(v433), v434]
  const R34 = {}; Object.keys(P34).forEach((k) => { R34[k] = { a: runNav34(P34[k], REG41_34, AP41_34), b: runNav34(P34[k], REG42_34, AP42_34) }; });
  const diff34 = (r) => r.a.vis.filter((id) => r.b.vis.indexOf(id) < 0).concat(r.b.vis.filter((id) => r.a.vis.indexOf(id) < 0).map((id) => '+' + id));
  const okN34 = Object.keys(WANT34).every((k) => R34[k].a.vis.length === WANT34[k][0] && R34[k].b.vis.length === WANT34[k][1]);
  const okD34 = Object.keys(WANT34).every((k) => { const d = diff34(R34[k]); return WANT34[k][0] === WANT34[k][1] ? d.length === 0 : (d.length === 1 && d[0] === 'tabHwakwanBtn'); });
  const hwVis34 = Object.keys(P34).filter((k) => R34[k].b.vis.indexOf('tabHwakwanBtn') >= 0).join(',');
  T('v434 ⓑ 사람별 사이드바 칸 수(실제 nav 21칸·permOf·applyPerms·applySafetyPerms 실행 — 11/9 명부 권한 + 11/10 hw 저장값): 관리자 21 · 김정아(수행) 15 · 권민지(보기) 14(안전 부여 뒤 15) · 정재욱(보기) 14 · 김호태(숨김) 12 → 11 · 현장 8명형(값 없음) 9 → 8 · 더미(값 없음) 15 → 14 — 4-1 흉내(두 표에 hw 없음·전용 줄 없음)와 비교해 바뀐 칸은 화관법 하나뿐(안전 탭 등 그대로) · 화관법이 보이는 사람 = 관리자·김정아·권민지·정재욱 · 4-1 흉내에서도 getElementById(undefined) 0(applyPerms "MODULE_TAB 없는 키 건너뜀" 안전장치가 남아 있음) · 흉내가 실제로 전용 줄·두 표 hw를 지웠는지 · 홈에서 돌린 applyPerms는 홈 이동·화관법 다시 그림 0',
    navEls34.filter((e) => e.cls.indexOf('tab-btn') >= 0).length === 21 && AP41_34 !== AP42_34 && REG41_34[1] !== REG42_34[1] && REG41_34[2] !== REG42_34[2]
    && okN34 && okD34 && hwVis34 === 'admin,kja,kmj,kmjS,jjw' && Object.keys(R34).every((k) => R34[k].b.log.length === 0 && R34[k].a.undef === 0 && R34[k].b.undef === 0),
    Object.keys(P34).map((k) => k + ' ' + R34[k].a.vis.length + '→' + R34[k].b.vis.length + (diff34(R34[k]).length ? '(' + diff34(R34[k]).join('·') + ')' : '')).join(' · '));

  // ⓒ renderHwWaste 실행 — 보기·숨김 = 폐기물 칸 대신 안내 한 줄(#hwViewOnly) · 수행·관리자 = 종전 제출 칸
  const rhw34 = (perm) => {
    const host = { innerHTML: '', querySelectorAll: () => [] };
    new Function('__host', '__perm', [
      'var document = { getElementById: function(id){ return id === "hwWasteCard" ? __host : null; } };',
      'function canDo(m){ return __perm === "admin" || (m === "hw" && __perm === "do"); } function canSee(m){ return __perm === "admin" || (m === "hw" ? __perm !== "hide" : true); }',   // canSee도 두어 갈래를 canSee로 약화하면 보기에게 제출 칸이 그려져 ✗(멈춤 아님)
      'var HW_DRIVERS = { "경북98사5749": "강문철" }; var hwSel = { vehicleNo: "", scenario: "", date: "2026-11-13", time: "" }; var hwJob = { polling: false, kind: "" }; var hwWasteResult = null;',
      'function hwScenarios(){ return { yk: { label: "YK스틸 → 스틸싸이클", from: "YK스틸", to: "스틸싸이클" } }; } function hwVehicles(){ return ["경북98사5749"]; }',
      'function esc(s){ return String(s == null ? "" : s); } function todayStr(){ return "2026-11-10"; } function hwPlusDays(){ return "2026-11-24"; } function hwFormReady(){ return false; } function hwEnvReady(){ return true; }',
      'function hwSubmitWaste(){} function hwSyncPreview(){}',
      fn34('renderHwWaste'), 'renderHwWaste();'].join('\n'))(host, perm);
    return host.innerHTML;
  };
  const hV34 = rhw34('view'), hH34 = rhw34('hide'), hD34 = rhw34('do'), hA34 = rhw34('admin');
  const form34 = (h) => h.indexOf('id="hwSubmitBtn"') > 0 && h.indexOf('data-hw-veh=') > 0 && h.indexOf('data-hw-scen=') > 0 && h.indexOf('id="hwDate"') > 0 && h.indexOf('보기 권한') < 0;
  const note34 = (h) => h.indexOf('<div class="hw-note" id="hwViewOnly"') === 0 && h.indexOf('<b>보기 권한 — 제출은 수행 권한자만</b> 할 수 있습니다.') > 0
    && ['hwSubmitBtn', 'data-hw-veh', 'data-hw-scen', 'hwDate', 'hwTime', 'hw-submit'].every((w) => h.indexOf(w) < 0);
  T('v434 ⓒ renderHwWaste 실행: 보기(권민지·정재욱형)·숨김 = 폐기물 칸 대신 안내 한 줄 "보기 권한 — 제출은 수행 권한자만 할 수 있습니다"(#hwViewOnly — 차량·경로 버튼·날짜·시간 칸·[운반계획서 제출] 0) · 수행(김정아형)·관리자 = 종전 제출 칸(① 차량 ② 경로 ③ 날짜·시간·[운반계획서 제출], 안내 0)',
    note34(hV34) && note34(hH34) && form34(hD34) && form34(hA34),
    JSON.stringify({ v: hV34.slice(0, 90), d: hD34.length, a: hA34.length }));

  // ⓒ-2 (v434 검토 반영) 한 기기 사람 전환 — 사용자 칩 → 로그인 창 '전환'은 새로고침 없이 afterLogin → applyPerms만 돈다(render()에는 화관법이 없다).
  //    실제 applyPerms(MODULES 루프·화관법 전용 줄·applySafetyPerms)·renderHwakwan·renderHwWaste를 한 화면 상태에서 차례로 돌려, 앞사람 권한으로 그려 둔 화관법 화면이
  //    지금 사람 권한으로 바뀌는지 본다(.view.readonly CSS는 .hw-opt·.hw-submit을 못 숨기므로 다시 그림이 없으면 보기 회원에게 제출 칸이 남는다)
  const sw2_34 = () => {
    const els = {}, log = [];
    const el = (id) => els[id] || (els[id] = { id, classList: mkCl34(), style: {}, innerHTML: '', textContent: '', getAttribute: () => null, querySelectorAll: () => [], addEventListener: () => {} });
    const api = new Function('__el', '__log', [
      'var document = { getElementById: function(id){ id = String(id); if (id === "tabbar" || id === "hwDate" || id === "hwTime" || id === "hwSubmitBtn") return null; return __el(id); }, querySelectorAll: function(){ return []; } };',
      'var __m = null; function curMember(){ return __m; }',
      'var currentTab = "hwakwan", safetyLayer = "site", eduViewScope = "member";',
      stmt34(/var PERM_CLOSED = \{[^}]+\};/), fn34('permOf'), fn34('canDo'), fn34('canSee'), fn34('isAdmin'), fn34('isDev'),
      'function switchTab(n){ __log.push("switch:" + n); currentTab = n; } function updateUserChip(){} function updateApprovalBadges(){}',
      'function renderSites(){} function loadAsb(){} function loadEdu(){} function loadWorkers(){ return { then: function(){} }; } function renderEdu(){} function sfNowOpen(){}',
      'var HW_DRIVERS = { "경북98사5749": "강문철" }; var hwStatus = { ok: true }, hwStatusLoading = false; var hwJob = { polling: false, kind: "" };',
      'var hwSel = { vehicleNo: "경북98사5749", scenario: "yk", date: "2026-11-13", time: "09:00" };',
      'var hwWasteResult = { kind: "ok", sn: "W6009-TEST34", label: "YK스틸 → 스틸싸이클", row: "" };',   // 앞사람(수행)이 낸 접수 결과가 화면에 있는 상태
      'function hwScenarios(){ return { yk: { label: "YK스틸 → 스틸싸이클", from: "YK스틸", to: "스틸싸이클" } }; } function hwVehicles(){ return ["경북98사5749"]; }',
      'function esc(s){ return String(s == null ? "" : s); } function todayStr(){ return "2026-11-10"; } function hwPlusDays(){ return "2026-11-24"; } function hwFormReady(){ return true; } function hwEnvReady(){ return true; }',
      'function hwSubmitWaste(){} function hwSyncPreview(){} function renderHwAuto(){ __log.push("draw"); } function loadHwStatus(){ __log.push("load"); }',
      stmt34(/var MODULES = \[[^\]]+\];/), stmt34(/var MODULE_TAB = \{[^}]+\};/), stmt34(/var MODULE_VIEW = \{[^}]+\};/),
      fn34('safetyPanes'), fn34('setSafetyLayer'), fn34('applySafetyPerms'), fn34('applyPerms'), fn34('renderHwWaste'), fn34('renderHwakwan'),
      'return { open: function(m){ __m = m; renderHwakwan(); }, login: function(m){ __m = m; applyPerms(); }, cur: function(){ return currentTab; } };'].join('\n'))(el, log);
    return { api, log, card: () => el('hwWasteCard').innerHTML, run: () => el('hwRunNowBtn').style.display, ro: () => el('view-hwakwan').classList.contains('readonly'), hid: () => el('tabHwakwanBtn').classList.contains('perm-hidden') };
  };
  const mA34 = { id: 'a', admin: true, perms: {} }, mD34 = { id: 'k1', perms: { hw: 'do', veh: 'do', site: 'do' } }, mV34 = { id: 'k2', perms: { hw: 'view', veh: 'do', safety: 'do' } }, mH34 = { id: 'k4', perms: { hw: 'hide', veh: 'view' } };
  const formC34 = (h) => h.indexOf('id="hwSubmitBtn"') > 0 && h.indexOf('data-hw-veh=') > 0 && h.indexOf('id="hwViewOnly"') < 0;
  const noteC34 = (h) => h.indexOf('<div class="hw-note" id="hwViewOnly"') === 0 && h.indexOf('hwSubmitBtn') < 0 && h.indexOf('data-hw-veh') < 0 && h.indexOf('W6009-TEST34') < 0 && h.indexOf('경북98사5749') < 0;
  const x1 = sw2_34(); x1.api.open(mD34); const c1a = x1.card(), r1a = x1.ro(); x1.api.login(mV34); const c1b = x1.card(), r1b = x1.ro(), t1b = x1.api.cur(); x1.api.login(mD34); const c1c = x1.card(), r1c = x1.ro();
  const x2 = sw2_34(); x2.api.open(mA34); const n2a = x2.run(); x2.api.login(mD34); const n2b = x2.run(), c2b = x2.card();
  const x3 = sw2_34(); x3.api.open(mD34); x3.api.login(mH34); const t3 = x3.api.cur(), h3 = x3.hid();
  T('v434 ⓒ-2 한 기기 사람 전환(실제 applyPerms·renderHwakwan·renderHwWaste — 로그인 창 \'전환\'은 새로고침 없이 applyPerms만): 수행(김정아형 — 앞사람 접수 결과가 화면에 있음) → 보기(권민지형) = 폐기물 칸이 곧바로 보기 안내 한 줄로(차량·제출 칸·앞사람 접수번호 0)·화면 읽기 전용·탭 그대로 · 다시 수행 = 제출 칸·읽기 전용 풀림 · 관리자 → 수행 = ▶ 지금 실행 숨김·제출 칸 · 수행 → 숨김(김호태형) = 홈(다시 그림 0·탭 숨김) · 다시 그림은 사람이 바뀔 때 1번씩',
    formC34(c1a) && c1a.indexOf('W6009-TEST34') > 0 && !r1a && noteC34(c1b) && r1b && t1b === 'hwakwan' && formC34(c1c) && !r1c && x1.log.join(',') === 'draw,draw,draw'
    && n2a === '' && n2b === 'none' && formC34(c2b) && x2.log.join(',') === 'draw,draw'
    && t3 === 'dash' && h3 && x3.log.join(',') === 'draw,switch:dash',
    JSON.stringify({ c1b: c1b.slice(0, 60), r: [r1a, r1b, r1c], t1b, log1: x1.log, run: [n2a, n2b], log2: x2.log, t3, h3, log3: x3.log }));

  // ⓓ hwSubmitWaste·hwFailText 실행 — 보기 = 알림 1번(HW_NO_WRITE)뿐·확인창·요청 0 · 수행 = 확인창 → 요청 → 작업 폴링 · 서버 403 NO_WRITE(옛 캐시·권한이 막 바뀐 앱) = 결과 줄 같은 글
  const HWNW34 = stmt34(/var HW_NO_WRITE = "[^"\n]*";/);
  const hsw34 = (perm, resp) => {
    const log = [];
    const api = new Function('__perm', '__log', '__resp', [
      'var document = { getElementById: function(id){ return id === "hwDate" ? { value: "2026-11-13" } : (id === "hwTime" ? { value: "09:00" } : null); } };',
      'function canDo(m){ return __perm === "admin" || (m === "hw" && __perm === "do"); } function canSee(m){ return __perm === "admin" || (m === "hw" ? __perm !== "hide" : true); }',
      'function alert(s){ __log.push("alert:" + s); } function confirm(){ __log.push("confirm"); return true; }',
      'var HW_DRIVERS = { "경북98사5749": "강문철" }; var hwSel = { vehicleNo: "경북98사5749", scenario: "yk", date: "", time: "" }; var hwJob = { polling: false, kind: "" }; var hwWasteResult = null;',
      'function hwScenarios(){ return { yk: { label: "YK스틸 → 스틸싸이클" } }; } function hwEnvReady(){ return true; } function hwDateOk(){ return true; }',
      'function renderHwakwan(){ __log.push("render"); } function hwStartPoll(id){ __log.push("poll:" + id); } function onSessionInvalid(){ __log.push("401"); }',
      'function gwCall(fn, body){ __log.push("call:" + fn + ":" + body.action); return { then: function(f){ f(__resp); return { catch: function(){} }; } }; }',
      HWNW34, fn34('hwFailText'), fn34('hwSubmitWaste'),
      'hwSubmitWaste(); return { res: function(){ return hwWasteResult; }, nw: HW_NO_WRITE, fail: hwFailText };'].join('\n'))(perm, log, resp);
    return { log, api };
  };
  //    (v434 검토) 서버 거절 몸체에는 사람 말 error가 있다(HW_ERR_NO_WRITE·HW_ERR_NO_ACCESS — 서버 원문에서 읽음). 새 앱은 code로 판정해 같은 글 ·
  //    옛 앱 흉내(hwFailText에서 NO_WRITE 줄을 뺀 v433 모양)는 몸체 error를 괄호 안에 보여 거절 이유·'정부에 제출되지 않았습니다'가 보인다('HTTP 403' 아님) ·
  //    loadHwStatus 실행(v433과 같은 줄) — 조회 403 NO_ACCESS면 현황 카드 글 = 서버 error('NO_ACCESS' 글자만이 아님)
  const hwSrc34 = rd34('netlify/functions/gw-hwakwan.js');
  const SNW34 = (hwSrc34.match(/\nconst HW_ERR_NO_WRITE = '([^'\n]+)';\n/) || [])[1] || '', SNA34 = (hwSrc34.match(/\nconst HW_ERR_NO_ACCESS = '([^'\n]+)';\n/) || [])[1] || '';
  const sV34 = hsw34('view', { status: 200, body: { ok: true, job: 'hw_waste_x' } }), sD34 = hsw34('do', { status: 200, body: { ok: true, job: 'hw_waste_x' } });
  const sR34 = hsw34('do', { status: 403, body: { ok: false, code: 'NO_WRITE', error: SNW34 } });
  const NW34 = sV34.api.nw, rR34 = sR34.api.res();
  const OLDFT34 = fn34('hwFailText').replace(/\n[ \t]*if \(code === "NO_WRITE"\) return HW_NO_WRITE;[^\n]*/, '');
  const oldR34 = new Function([OLDFT34, 'return hwFailText;'].join('\n'))()('NO_WRITE', SNW34);   // 옛 앱 hwSubmitWaste: hwFailText(code, res.body.error || "HTTP " + status)
  const lhs34 = (resp) => new Function('__resp', ['var hwStatus = null, hwStatusLoading = false;', 'function renderHwakwan(){} function onSessionInvalid(){}',
    'function gwCall(){ return { then: function(f){ f(__resp); return { catch: function(){} }; } }; }', fn34('loadHwStatus'), 'loadHwStatus(); return hwStatus;'].join('\n'))(resp);
  const stA34 = lhs34({ status: 403, body: { ok: false, code: 'NO_ACCESS', error: SNA34 } });
  T('v434 ⓓ hwSubmitWaste·hwFailText·loadHwStatus 실행: 보기 = 알림 1번(HW_NO_WRITE "보기 권한 — 제출은 수행 권한자만 할 수 있습니다 … 정부에 제출되지 않았습니다")뿐 — 확인창·서버 요청 0 · 수행 = 확인창 → gw-hwakwan hw_waste_submit 1번 → 작업 폴링 · 서버가 403 NO_WRITE(몸체 error 포함)로 거절하면 결과 줄 = 같은 글(종전 "접수내역부터 확인" 문구 아님) · 다른 실패 코드는 종전 글 · (검토) 옛 앱 흉내(NO_WRITE 줄 없는 hwFailText)는 괄호 안에 서버 error "화관법 수행 권한이 없어 제출하지 않았습니다 … 정부에 제출되지 않았습니다"("HTTP 403" 아님) · 조회 403 NO_ACCESS의 현황 카드 글 = 서버 error "화관법 권한이 없습니다 …"',
    sV34.log.length === 1 && sV34.log[0] === 'alert:' + NW34 && NW34.indexOf('보기 권한 — 제출은 수행 권한자만 할 수 있습니다') === 0 && NW34.indexOf('정부에 제출되지 않았습니다') > 0
    && sD34.log.join(',') === 'confirm,render,call:gw-hwakwan:hw_waste_submit,poll:hw_waste_x'
    && !!rR34 && rR34.kind === 'err' && rR34.text === NW34 && NW34.indexOf('접수내역') < 0 && sR34.log.indexOf('poll:hw_waste_x') < 0
    && sD34.api.fail('NO_WRITE', 'HTTP 403') === NW34 && sD34.api.fail('BAD_VEHICLE', 'HTTP 400').indexOf('화관법민원24 접수내역에서 접수 여부를 먼저 확인') >= 0 && sD34.api.fail('NO_TEMPLATE').indexOf('과거 제출본이 없습니다') > 0
    && SNW34.indexOf('화관법 수행 권한이 없어 제출하지 않았습니다') === 0 && SNW34.indexOf('이 요청은 정부에 제출되지 않았습니다.') > 0 && SNA34.indexOf('화관법 권한이 없습니다') === 0
    && OLDFT34 !== fn34('hwFailText') && oldR34.indexOf('(' + SNW34 + ')') > 0 && oldR34.indexOf('HTTP 403') < 0
    && !!stA34 && stA34.error === SNA34,
    JSON.stringify({ v: sV34.log, d: sD34.log, r: rR34, rl: sR34.log, old: oldR34.slice(-60), st: stA34 }));

  // ⓔ switchTab 실행 — 화관법 숨김이면 어떤 길(사이드바 밖 바로가기·"hwakwan:칸" 꼴)로 와도 홈: 화관법 화면 안 켜짐·renderHwakwan 0(서버 hw_status 403을 부르지 않음) · 보기·수행·관리자 = 켜짐
  const swr34 = (perm, name) => {
    const log = [], els = {};
    const el = (id) => els[id] || (els[id] = { id, classList: mkCl34(), style: {} });
    const cur = new Function('__perm', '__log', '__el', [
      'var document = { getElementById: function(id){ return __el(id); }, querySelectorAll: function(){ return []; } };',
      'var currentTab = "veh";',
      'function canSee(m){ return __perm === "admin" || (m === "hw" ? __perm !== "hide" : true); }',
      'function canDo(m){ return __perm === "admin" || (m === "hw" && __perm === "do"); }',   // (v434 검토) ⓒ·ⓓ 틀처럼 canDo도 둔다 — 길 막기를 canDo로 바꾸는 결함(보기 권한자가 홈으로 튕김)이 ReferenceError로 묶음 전체 '검사 생략'이 아니라 이 검사 ✗로 보이게
      'function safetyPanes(){ return ["site"]; } function closeNav(){} function updateNavToggle(){}',
      'function renderHwakwan(){ __log.push("renderHwakwan"); } function renderDashboard(){ __log.push("renderDashboard"); }',
      stmt34(/var TAB_ALIAS = \{[^}]*\};/), fn34('tabRoute'), fn34('switchTab'),
      'switchTab(' + JSON.stringify(name) + '); return currentTab;'].join('\n'))(perm, log, el);
    return { cur, log, act: !!(els['view-hwakwan'] && els['view-hwakwan'].classList.contains('active')), dash: !!(els['view-dash'] && els['view-dash'].classList.contains('active')) };
  };
  const wH34 = swr34('hide', 'hwakwan'), wHx34 = swr34('hide', 'hwakwan:waste'), wV34 = swr34('view', 'hwakwan'), wD34 = swr34('do', 'hwakwan'), wA34 = swr34('admin', 'hwakwan');
  T('v434 ⓔ switchTab 실행: 화관법 숨김이면 어떤 길로 와도("hwakwan"·"hwakwan:칸" 꼴) 홈 — 화관법 화면 안 켜짐·renderHwakwan 0(서버 hw_status를 부르지 않음)·홈을 그림 · 보기·수행·관리자 = 화관법 화면 켜짐·renderHwakwan 1번',
    [wH34, wHx34].every((r) => r.cur === 'dash' && !r.act && r.dash && r.log.join(',') === 'renderDashboard')
    && [wV34, wD34, wA34].every((r) => r.cur === 'hwakwan' && r.act && !r.dash && r.log.join(',') === 'renderHwakwan'),
    JSON.stringify([wH34, wHx34, wV34, wD34, wA34].map((r) => [r.cur, r.act, r.log.join('+')])));

  // ⓕ CSS — 보기 권한 화면(.view.readonly)은 .mini-btn을 숨기므로 ↻ 새로고침(읽기뿐)만 예외로 남긴다. ▶ 지금 실행은 예외 없음(관리자·개발자만)
  T('v434 ⓕ CSS: 보기 권한 화관법 화면(.view.readonly)에서도 ↻ 새로고침(#hwRefreshBtn — hw_status 읽기, 서버도 보기 허용)은 보임 · ▶ 지금 실행(#hwRunNowBtn)은 읽기 전용 예외 없음 · 두 버튼 .mini-btn 그대로',
    /\n  \.view\.readonly #hwRefreshBtn\{display:inline-block !important;\}/.test(html) && !/readonly[^{\n]*#hwRunNowBtn/.test(html)
    && /<button class="mini-btn" id="hwRefreshBtn">↻ 새로고침<\/button>/.test(html) && /<button class="mini-btn" id="hwRunNowBtn" style="display:none;"/.test(html), '');

  // ⓖ 문서 — MANUAL 27 대신 제출(칸 누름 횟수는 실제 칸 순환 PM_NEXT와 같아야 함) · FEATURES v434 · TESTLIST v434(체크 칸 전부 AI 몫) · CLAUDE.md 화관법 줄 · sw ≥ 434
  const sec34 = (a, b) => { const i = man34.indexOf(a); return i < 0 ? '' : man34.slice(i, man34.indexOf(b, i + a.length)); };
  const m27_34 = sec34('<h2 id="s27">', '<h2 id="s28">');
  const pmNext34 = new Function([stmt34(/var PM_NEXT = \{[^}]+\};/), 'return PM_NEXT;'].join('\n'))();
  const tlv34 = (() => { const i = tl34.indexOf('\n## v434'); if (i < 0) return ''; const j = tl34.indexOf('\n## ', i + 5); return tl34.slice(i, j < 0 ? tl34.length : j); })();
  const cb34 = tlv34.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi34 = cb34.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l));
  const ftv34 = (() => { const i = ft34.indexOf('\n### v434 (11/10)'); if (i < 0) return ''; const j = ft34.indexOf('\n### ', i + 5); return ft34.slice(i, j < 0 ? ft34.length : j); })();
  const clHw34 = cl34.split(/\r?\n/).filter((l) => l.indexOf('- **화관법(hw) 키**') === 0)[0] || '';
  //   (v434 검토) 낱말 검사만으로는 '보기·숨김이면 NO_ACCESS'·'22칸'·'관리자 계정도 칸이 수행이어야' 같은 틀린 글이 통과했다 — 21-2 li처럼 문장째 고정한다:
  //   MANUAL 27절 대신 제출 카드 전체 · FEATURES v434 서버 거절 문장·무검사 문장·사람별 줄 전체·applyPerms 전용 줄·몸체 error 문장 · CLAUDE.md 제출 거절 규약·조회 거절·applyPerms 다시 그림·몸체 error
  const CARD34 = '<div class="card">\n<p><b>김정아 님이 없을 때 — 대신 제출</b><br>지금 \'화관법\' 열은 김정아 님 <b>수행</b>, 권민지·정재욱 님 <b>보기</b>입니다(관리자는 늘 수행).</p>\n<ol>\n'
    + '<li><b>관리자가 직접 냅니다</b> — 관리자 계정은 칸과 관계없이 위 세 단계(① 차량 ② 경로 ③ 날짜·시간)로 바로 낼 수 있습니다. 가장 간단합니다.</li>\n'
    + '<li><b>권민지·정재욱 님 중 한 분에게 맡깁니다</b> — PM이 인사·직원 탭 <span class="btn">🔑 권한관리</span> 표의 <b>\'화관법\' 열</b>에서 그분 칸(지금 \'보기\')을 <b>2번 연달아</b>(1초 안에) 누릅니다. 칸은 보기 → 숨김 → 수행으로 바뀌므로 2번이면 <b>수행</b>입니다. 1초 뒤 "저장됨 ✓"과 표의 \'수행\'을 확인합니다.</li>\n'
    + '<li>그분 앱은 화면에 돌아올 때(5분에 한 번) 권한을 다시 읽어 "권한이 바뀌었습니다"로 새로 고친 뒤 폐기물 칸이 열립니다. 바로 안 바뀌면 앱을 완전히 닫았다가 다시 열면 됩니다.</li>\n'
    + '<li>일이 끝나면 같은 칸을 <b>1번</b> 눌러 <b>보기</b>로 되돌립니다(수행 → 보기). 표에 \'보기\'가 찍혔는지 확인합니다.</li>\n</ol>\n'
    + '<p>필요한 한 분만 바꿨다가 되돌려 주세요(부서 단위로 한꺼번에 주지 않습니다). 바뀐 칸은 감사로그(21-3)에 <b>권한: hw:view → hw:do</b>처럼 남습니다.</p>\n</div>';
  const FT_PINS34 = [
    '`hw_status`·`hw_job`은 숨김이면 403 NO_ACCESS(보기·수행은 종전대로), `hw_waste_submit`은 수행이 아니면 403 NO_WRITE(숨김·보기 모두 — gw-data 저장의 `!== \'do\'` → NO_WRITE 규약 그대로, `handleWasteSubmit` 호출 앞이라 입력 검사·작업 기록·워커 기동·감사 로그보다 먼저)',
    '`hw_run_now`(관리자·개발자 ADMIN_ONLY 그대로)·제품 자동 제출 크론(gw-hwakwan-cron → 내부 토큰으로 워커 직행)·워커(내부 토큰만)에는 hw 검사를 더하지 않았다(사람 요청만)',
    '\n- **사람별**(운영 저장값 11/10 기준 — 시험 서버 화면 확인은 TESTLIST v434 칸): 관리자 3명 그대로(21칸) · 김정아(수행) 화면·제출 그대로(15칸) · 권민지·정재욱(보기) 화관법 탭 보임 + 폐기물 칸 대신 \'보기 권한 — 제출은 수행 권한자만\' 안내 + 서버 제출 403 NO_WRITE(칸 수 그대로 — 권민지 14, 안전 부여 뒤 15 · 정재욱 14) · 김호태(숨김) 12 → 11 · 현장 8명(값 없음) 9 → 8 · 더미(값 없음) 15 → 14 — 사이드바에서 화관법만 빠짐(안전 탭 등 다른 칸 그대로, uismoke v434 ⓑ가 실제 nav로 셈).\n',
    'applyPerms `if (currentTab === "hwakwan"){ if (!canSee("hw")) switchTab("dash"); else renderHwakwan(); }`',
    '몸체는 이 함수의 종전 꼴 `{ ok: false, code, request_id }`에 사람 말 `error`를 더했다'];
  const CL_PINS34 = [
    '`hw_waste_submit`은 `handleWasteSubmit` 호출 앞(입력 검사보다 먼저)에서 수행이 아니면 403 NO_WRITE(숨김·보기 모두 — gw-data 저장 규약).',
    '로그인·기기 승인 뒤 `hw_status`·`hw_job`은 숨김이면 403 NO_ACCESS,',
    'applyPerms(currentTab이 hwakwan이면 `canSee("hw")`가 아닐 때 홈, 볼 수 있으면 `renderHwakwan()`으로 다시 그림',
    '거절 몸체에는 code와 함께 사람 말 `error`(`HW_ERR_NO_WRITE`·`HW_ERR_NO_ACCESS`'];
  const ftv34n = ftv34.replace(/\r\n/g, '\n'), m27_34n = m27_34.replace(/\r\n/g, '\n');
  const ftMiss34 = FT_PINS34.filter((s) => ftv34n.indexOf(s) < 0), clMiss34 = CL_PINS34.filter((s) => clHw34.indexOf(s) < 0);
  //   (v434 검토) TESTLIST v434 — 콘솔 칸은 실행 가능한 꼴(앱 코드는 즉시실행 함수 안이라 콘솔에서 switchTab·gwCall을 못 부름: 숨은 탭 버튼 .click()·fetch에 토큰·기기 머리 — 앱 상수와 같은 키) ·
  //   push 직전 운영 저장값 재대조 칸(AI) · 한 기기 사람 전환 칸(AI 시험 화면)
  const tlOp34 = cb34.filter((l) => /^- \[[ xX]\] \(AI가 운영 저장값으로 확인 — push 직전\)/.test(l))[0] || '', tlSw34 = cb34.filter((l) => l.indexOf("로그인 창으로 '전환'") >= 0)[0] || '';
  const tlCon34 = tlv34.indexOf('\n> 콘솔 요청 꼴(아래 칸 공통') > 0 && tlv34.indexOf('`document.getElementById("tabHwakwanBtn").click()`') > 0
    && tlv34.indexOf('fetch("/.netlify/functions/gw-hwakwan", {method:"POST", headers:{"Content-Type":"application/json", "Authorization":"Bearer " + (sessionStorage.getItem("jw_gw_token") || localStorage.getItem("jw_gw_token")), "X-Device-Id":localStorage.getItem("jw_device_id")}') > 0
    && tlv34.indexOf('콘솔 switchTab(') < 0 && tlv34.indexOf('콘솔로 hw_') < 0
    && html.indexOf('var GW_TOKEN_KEY = "jw_gw_token";') > 0 && html.indexOf('var DEVICE_KEY = "jw_device_id";') > 0 && html.indexOf('"X-Device-Id": deviceId()') > 0
    && /\n\(function\(\)\{\n  "use strict";/.test(html) && !/\bwindow\.(?:switchTab|gwCall)\s*=/.test(html);
  T('v434 ⓖ 문서: MANUAL 27절 대신 제출 카드 전체 고정(관리자 직접 · 권민지·정재욱 칸 2번 연달아 = 보기 → 숨김 → 수행 · 끝나면 1번 = 수행 → 보기 — 칸 순환 PM_NEXT 실행과 같음 · 관리자는 칸과 관계없이 · 5분 재확인) · FEATURES 기준 ≥ v434·v434 절(MODULE_TAB.hw·hwPerm·NO_WRITE·NO_ACCESS·지금 실행·사람별 칸 수·보기 안내 + 문장 고정 5: 서버 거절·무검사·사람별 줄·applyPerms 전용 줄·몸체 error) · TESTLIST v434 절(체크 칸 전부 AI 몫 — 사람별 칸 수·보기 안내·김정아 제출 그대로, PM 0, 게이트 칸 [x] · 콘솔 꼴 = 탭 버튼 .click()·fetch 토큰·기기 머리(앱 상수와 같은 키, 콘솔 switchTab 글 0) · push 직전 운영 저장값 재대조 칸 · 한 기기 사람 전환 칸) · CLAUDE.md 화관법 줄(hwPerm·NO_WRITE·NO_ACCESS·#hwRefreshBtn·MANUAL 27절 + 문장 고정 4: 제출 거절 규약·조회 거절·applyPerms 다시 그림·몸체 error) · sw ≥ 434',
    m27_34.indexOf('<b>김정아 님이 없을 때 — 대신 제출</b>') > 0 && m27_34.indexOf('<b>관리자가 직접 냅니다</b>') > 0 && m27_34.indexOf('<b>2번 연달아</b>(1초 안에)') > 0
    && m27_34n.indexOf(CARD34) > 0 && ftMiss34.length === 0 && clMiss34.length === 0 && tlCon34
    && tlOp34.indexOf('김정아 hw=do · 권민지 hw=view · 정재욱 hw=view') > 0 && tlOp34.indexOf('"do"·"view"인 사람 0명') > 0 && tlOp34.indexOf('push하지 않고') > 0
    && tlSw34.indexOf("곧바로 '보기 권한 — 제출은 수행 권한자만' 안내로 바뀜") > 0 && tlSw34.indexOf('곧바로 제출 칸이 열림') > 0 && tlSw34.indexOf('▶ 지금 실행이 사라짐') > 0
    && m27_34.indexOf('칸은 보기 → 숨김 → 수행으로 바뀌므로 2번이면 <b>수행</b>입니다.') > 0 && m27_34.indexOf('같은 칸을 <b>1번</b> 눌러 <b>보기</b>로 되돌립니다(수행 → 보기).') > 0
    && pmNext34.view === 'hide' && pmNext34[pmNext34.view] === 'do' && pmNext34.do === 'view'
    && Number((ft34.match(/기준: v(\d+) /) || [0, 0])[1]) >= 434 && ftv34.length > 0
    && ['`MODULE_TAB.hw = "tabHwakwanBtn"`', '`hwPerm', 'NO_WRITE', 'NO_ACCESS', 'hw_run_now', '12 → 11', '9 → 8', '15 → 14', '보기 권한 — 제출은 수행 권한자만'].every((w) => ftv34.indexOf(w) > 0)
    && tlv34.length > 0 && cb34.length >= 6 && cbNotAi34.length === 0 && tlv34.indexOf('PM 몫') < 0 && cb34.some((l) => /^- \[x\] \(AI\) `uismoke`/.test(l))
    && ['12 → 11', '9 → 8', '15 → 14', '보기 권한 — 제출은 수행 권한자만', '김정아'].every((w) => tlv34.indexOf(w) > 0)
    && ['`hwPerm`', 'NO_WRITE', 'NO_ACCESS', '`.view.readonly #hwRefreshBtn`', 'MANUAL 27절'].every((w) => clHw34.indexOf(w) > 0)
    && Number((sw34.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 434,
    JSON.stringify({ m27: m27_34.length, card: m27_34n.indexOf(CARD34) > 0, next: pmNext34, ftv: ftv34.length, ftMiss: ftMiss34.map((s) => s.slice(0, 40)), tl: tlv34.length, cb: cb34.length, notAi: cbNotAi34.map((l) => l.slice(0, 40)), con: tlCon34, op: tlOp34.length, sw: tlSw34.length, cl: clHw34.length, clMiss: clMiss34.map((s) => s.slice(0, 40)) }));
} catch (e) { console.log('  (v434 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v435(11/10 PM 새 지시 '56. ⓒ 현장탭 25년 이전 자료 전체 접을 수 있게' — 브리핑 밖·앱만, 09_조사_문서/메뉴안전탭_자료_20261109/단계지시_v435_c현장접기.json):
//      안전 › 현장 목록(renderSites)에서 siteYear(시작일 앞 네 자리 → 없으면 종료일 → 둘 다 없으면 0 = 날짜 없음)가 SITE_OLD_BEFORE(2025 — PM '25년 이전')보다 이르거나 날짜 없음인 줄을
//      목록 맨 아래 '지난 자료' 한 묶음(기본 접힘)으로. v336·v337·v433 하네스(renderSites를 소스에서 뽑아 실행 — 특별교육 줄은 안전 권한형)를 재사용하되,
//      펼치기를 실제로 누르려고 innerHTML을 풀어 요소(속성·class·style.display·click 리스너)를 만드는 작은 DOM을 쓴다(다시 그리면 요소가 새로 생긴다 — 실제 innerHTML과 같음).
//      검토 반영(11/10): 묶음은 종결(done) 줄만 — 종결 아닌 줄(예정·작업중·상태 칸 없음 = 카드 '예정')은 연도·날짜 없음과 상관없이 밖(②-3), 묶음 안은 같은 연도끼리 안정 정렬(②-4),
//      카드 글은 v434(c1cc9b1)에서 뽑아 고정한 3장과 글자째(②-2 고정 — 종전 ②-2는 같은 소스의 두 화면끼리라 siteCard 글이 바뀌어도 통과했다)
//      ① siteYear 판정 ② 기본 접힘(밖/안·머리 건수·연도 구분 줄·맨 아래·지금 정렬) ②-2 카드 글 그대로(검색 화면 카드와 글자째)·버튼 ②-2 고정(v434 카드 3장) ②-3 진행 줄은 접지 않음 ②-4 묶음 안 같은 연도끼리
//      ③ 펼치기(bindFold·펼침 기억·누를 때 다시 그리지 않음·안쪽 카드·다시 접기·새 앱 접힘)
//      ④ 검색어 = 접힘 없음 ⑤ 종류 거르기 = 거른 뒤 건수 ⑥ 지난 자료만 = 묶음 머리만·빈 목록 그대로 ⑦ 운영 분포 흉내(11/10 백업 실측 — 135건 접힘) ⑧ 상수 2026 사본 = 2025년도 묶음
//      ⑨ 정적(상수 2025·펼침 기억은 메모리만·renderSites 밖 무변·bindFold 순서·CSS) ⑩ 문서(MANUAL 28절 한 줄·FEATURES v435·§7·TESTLIST v435 AI 몫·CLAUDE.md·sw)
try {
  const fn35 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const rd35 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const own35 = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const same35 = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  // 작은 DOM — host.innerHTML을 넣으면 여는 태그마다 요소(속성 그대로·class·style.display·click 리스너)를 새로 만든다. getElementById = siteList·siteHead·풀린 id.
  const mkDom35 = () => {
    const els = [], byId = {};
    const host = { id: 'siteList', _h: '', querySelectorAll: (sel) => { const m = /^\[([\w-]+)\]$/.exec(sel); if (!m) throw new Error('시험 DOM이 모르는 선택자: ' + sel); return els.filter((e) => own35(e.attrs, m[1])); } };
    Object.defineProperty(host, 'innerHTML', { get: () => host._h, set: (v) => {
      host._h = String(v); els.length = 0; Object.keys(byId).forEach((k) => { delete byId[k]; });
      for (const t of host._h.matchAll(/<([a-zA-Z][\w-]*)([^<>]*)>/g)) {
        const attrs = {};
        for (const a of t[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2];
        const el = { tag: t[1].toLowerCase(), attrs, className: attrs.class || '', style: { display: /display:\s*none/.test(attrs.style || '') ? 'none' : '' }, on: [] };
        el.getAttribute = (n) => (own35(el.attrs, n) ? el.attrs[n] : null);
        el.setAttribute = (n, val) => { el.attrs[n] = String(val); };
        el.addEventListener = (ty, f) => { if (ty === 'click') el.on.push(f); };
        el.click = () => { el.on.slice().forEach((f) => f({ stopPropagation() {} })); };
        els.push(el); if (attrs.id) byId[attrs.id] = el;
      }
    } });
    const head = { id: 'siteHead', textContent: '' };
    return { host, head, els, byId, doc: { getElementById: (id) => (id === 'siteList' ? host : id === 'siteHead' ? head : (byId[id] || null)) } };
  };
  const ASB35 = 'var ASB_STATUS = ' + (html.match(/var ASB_STATUS = (\{[^}]*\});/) || [])[1] + ';';
  //   지난 자료 선언은 소스 글 그대로 가져온다(값은 아래 검사가 본다 — 선언이 없으면 묶음 전체 '검사 생략' ✗)
  const decl35 = (src) => { const a = src.match(/\n  var SITE_OLD_BEFORE = ([^;\n]+);\n/), b = src.match(/\n  var siteOldOpen = ([^;\n]+);\n/); if (!a || !b) throw new Error('지난 자료 선언(SITE_OLD_BEFORE·siteOldOpen) 없음'); return 'var SITE_OLD_BEFORE = ' + a[1] + '; var siteOldOpen = ' + b[1] + ';'; };
  const build35 = (items, opt) => {
    opt = opt || {}; const src = opt.src || html, D = mkDom35(), log = [];
    const api = new Function('__items', '__doc', '__can', '__log', '__mem', '__wk', [
      'var document = __doc;',
      'var asb = __items; var workers = __wk; var members = __mem; var edu = [];',   // 명부는 opt.members·opt.workers(없으면 빈 명부 — 종전과 같음)
      fn35(src, 'pad'), fn35(src, 'fmtDate'), fn35(src, 'todayStr'), fn35(src, 'esc'), fn35(src, 'addDays'), fn35(src, 'isDate'), fn35(src, 'asList'),
      'function findMember(id){ for(var i=0;i<members.length;i++){ if(members[i].id===id) return members[i]; } return null; }',
      'function memberName(id){ if(!id) return ""; var m=findMember(id); return m?m.name:""; }',
      'function dispName(n){ return n||""; }',
      'function liveEdu(){ return edu.filter(function(r){ return r && r.del!==1; }); }',
      fn35(src, 'eduLatest'), fn35(src, 'eduHasValidSpecial'), ASB35,
      fn35(src, 'liveAsb'), fn35(src, 'normAsbRow'), fn35(src, 'asbNotifyDue'), fn35(src, 'asbKeepUntil'),
      'var SITE_KIND = { asbestos:"석면", demolition:"철거", dredge:"준설" }; var siteFilter = "", siteQ = "";', decl35(src),
      'function renderSiteFilter(){} function canDo(m){ return m === "site" && __can; } function fmtAmount(v){ return String(v); }',
      'function openAsb(id){ __log.push("edit:" + id); } function openSiteWorkers(id){ __log.push("wk:" + id); }',
      fn35(src, 'siteKind'), fn35(src, 'liveSites'), fn35(src, 'siteLabel'), fn35(src, 'siteYear'),
      'function canSee(){ return true; } var siteEduGap = null, siteEduGapSig = {};', fn35(src, 'siteGapSig'), fn35(src, 'siteEduLine'),
      fn35(src, 'asbWorkerNames'), fn35(src, 'asbNoSpecial'), fn35(src, 'sheetRow'), fn35(src, 'bindFold'), fn35(src, 'renderSites'),
      'return { render: renderSites, year: siteYear, setQ: function(v){ siteQ = v; }, setF: function(v){ siteFilter = v; }, isOpen: function(){ return siteOldOpen; } };',
    ].join('\n'))(items, D.doc, !!opt.can, log, opt.members || [], opt.workers || []);
    return Object.assign({ api, log }, D);
  };
  // 표본 — 경계(2024-12-31·2025-01-01)·종료일만·'2025.03'·숫자 날짜·시작일 우선(2024 시작·2025 종료)·'?'·날짜 칸 없음·객체 날짜·지운 줄. 공사명마다 '현장'(검색 한 낱말로 전부 맞게)
  //   묶음 쪽 7줄은 모두 종결(done) — 종결 아닌 줄은 연도와 상관없이 밖이다(검토 반영, ②-3). 'on'(날짜 칸 없음)도 종결로 둔다(상태 칸까지 없는 줄은 카드 '예정' = 진행이라 ②-3이 본다)
  const S35 = [
    { id: 'n26', title: '현장 새 26', kind: 'asbestos', start: '2026-03-01', end: '2026-03-10', status: 'plan', member_ids: [], worker_ids: [] },
    { id: 'n25', title: '현장 경계 25', kind: 'demolition', start: '2025-01-01', end: '2025-02-01', status: 'done', member_ids: [], worker_ids: [] },
    { id: 'n25e', title: '현장 종료일만 25', kind: 'dredge', start: '', end: '2025-02-01', status: 'done' },
    { id: 'n25d', title: '현장 점 꼴 25', start: '2025.03', end: '', status: 'done' },
    { id: 'n26n', title: '현장 숫자 26', start: 20260101, end: 20260115, status: 'done' },
    { id: 'o24', title: '현장 경계 24', kind: 'asbestos', start: '2024-12-31', end: '2025-01-10', status: 'done', member_ids: [], worker_ids: [] },
    { id: 'o24e', title: '현장 시작 없음 24', kind: 'demolition', start: null, end: '2024-06-01', status: 'done' },
    { id: 'o23', title: '현장 옛 23', kind: 'asbestos', start: '2023-05-05', end: '2023-05-09', status: 'done' },
    { id: 'o13', title: '현장 아주 옛 13', kind: 'asbestos', start: '2013-10-07', end: '2013-10-15', status: 'done' },
    { id: 'oq', title: '현장 물음표', start: '?', end: '?', status: 'done' },
    { id: 'on', title: '현장 날짜 없음', status: 'done' },
    { id: 'oo', title: '현장 객체 날짜', start: {}, end: [], status: 'done' },
    { id: 'odel', title: '현장 지운 옛 줄', start: '2020-01-01', del: 1 },
  ];
  const YEAR35 = { n26: 2026, n25: 2025, n25e: 2025, n25d: 2025, n26n: 2026, o24: 2024, o24e: 2024, o23: 2023, o13: 2013, oq: 0, on: 0, oo: 0 };
  const OUT35 = ['n26', 'n25', 'n25e', 'n25d', 'n26n'], IN35 = ['o24', 'o24e', 'o23', 'o13', 'oq', 'on', 'oo'];
  const cmp35 = (a, b) => String(b.start || b.end || '').localeCompare(String(a.start || a.end || ''));   // 앱 정렬 비교자와 같은 식 — '지금 정렬 그대로' 대조용
  const live35 = (items) => items.filter((r) => r && r.del !== 1);
  const cardIds35 = (h) => [...h.matchAll(/data-site-fold="([^"]*)"/g)].map((m) => m[1]);
  const split35 = (h) => { const g = h.indexOf('data-site-old-fold='); return g < 0 ? { out: cardIds35(h), inn: [], g } : { out: cardIds35(h.slice(0, g)), inn: cardIds35(h.slice(g)), g }; };
  const toks35 = (h) => { const b = h.indexOf('id="siteOldBd-past"'); if (b < 0) return []; return [...h.slice(b).matchAll(/<div class="site-yr">([^<]*)<\/div>|data-site-fold="([^"]*)"/g)].map((m) => (m[1] !== undefined ? '#' + m[1] : m[2])); };
  const expToks35 = (items, ids, yr) => { const out = []; let p = null; live35(items).filter((r) => ids.indexOf(r.id) >= 0).sort(cmp35).forEach((r) => { const y = yr[r.id]; if (y !== p) { out.push('#' + (y ? y + '년' : '날짜 없음')); p = y; } out.push(r.id); }); return out; };
  const GRP35 = /<div class="item asb-item site-old" style="display:block;padding:0;"><button type="button" class="asb-hd(?: open)?" data-site-old-fold="past" aria-expanded="(?:true|false)" aria-controls="siteOldBd-past"><span class="asb-t">지난 자료 · \d{4}년까지 \d+건<\/span><span class="sec-caret">▾<\/span><\/button><div id="siteOldBd-past"(?: style="display:none;")?>/;
  const strip35 = (h) => h.replace(GRP35, '').replace(/<div class="site-yr">[^<]*<\/div>/g, '').replace(/<\/div><\/div>$/, '');   // 묶음 머리·연도 줄·묶음 닫기를 걷으면 카드만 남는다
  const CARD0_35 = '<div class="item asb-item" style="display:block;padding:0;"><button type="button" class="asb-hd" data-site-fold="';
  const grpBtn35 = (X) => X.els.filter((e) => own35(e.attrs, 'data-site-old-fold'));

  // ① siteYear 판정 — 시작일 → 종료일 → 0(날짜 없음), 글자·숫자만(객체·배열·null·함수는 0, 던지지 않음)
  const Y35 = build35([]);
  const yv35 = S35.filter((r) => r.del !== 1).map((r) => [r.id, Y35.api.year(r)]);
  let yThrow35 = null; const yOdd35 = [];
  try {
    yOdd35.push(Y35.api.year({ start: '?', end: '2023-01-01' }), Y35.api.year({ start: '25.03.01', end: '' }), Y35.api.year({ start: ' 2019-03-02' }), Y35.api.year({ start: 2025.03 }),
      Y35.api.year({ start: Object.create(null), end: { toString() { throw new Error('x'); } } }), Y35.api.year({ start: () => 2020 }), Y35.api.year(null), Y35.api.year('2020-01-01'), Y35.api.year({ start: '0000-01-01', end: '2022-02-02' }), Y35.api.year({ start: '2024년 3월' }),
      Y35.api.year({ start: '03/05/2019', end: '2023-01-01' }), Y35.api.year({ start: '공사 2019-03-02' }));   // 검토 반영: 네 자리가 맨 앞이 아니면 그 칸은 없음(앞 고정 ^\s* — '25.03.01'만으로는 앞 고정을 지워도 0이라 못 잡았다)
  } catch (e) { yThrow35 = e; }
  T('v435 ① siteYear 판정(실행): 시작일 앞 네 자리 → 없으면 종료일 → 둘 다 없으면 0(날짜 없음) — 표본 12줄 연도(경계 2024-12-31·2025-01-01·종료일만·"2025.03"·숫자 20260101·시작 2024/종료 2025는 2024·"?"·칸 없음·객체 날짜는 0) · "?"면 종료일 · "25.03.01"은 0 · 앞 공백 허용 · 숫자 2025.03 · 객체·함수·null·글자 레코드는 0(던지지 않음) · "0000"은 다음 칸 · "2024년 3월"은 2024 · 네 자리가 맨 앞이 아니면 그 칸은 없음("03/05/2019" → 종료일 2023, "공사 2019-03-02" → 0)',
    !yThrow35 && yv35.every(([id, y]) => y === YEAR35[id]) && JSON.stringify(yOdd35) === JSON.stringify([2023, 0, 2019, 2025, 0, 0, 0, 0, 2022, 2024, 2023, 0]),
    JSON.stringify({ err: yThrow35 && yThrow35.message, yv: yv35, odd: yOdd35 }));

  // ② 기본 접힘 — 밖 = 2025·2026(지금 정렬 그대로), 안 = 2024 이하·날짜 없음(같은 정렬 + 연도 바뀌는 곳마다 구분 줄), 묶음은 맨 아래 하나, 머리 건수
  const A35 = build35(S35); A35.api.render();
  const h0_35 = A35.host.innerHTML, sp0_35 = split35(h0_35), g0_35 = grpBtn35(A35), bd0_35 = A35.byId['siteOldBd-past'];
  const lastOut35 = h0_35.lastIndexOf('data-site-fold="' + sp0_35.out[sp0_35.out.length - 1] + '"');
  T('v435 ② 기본 접힘(renderSites 실행, 표본 12줄 + 지운 줄): 머리 "총 12건 (지난 자료 7건 접힘)" · 밖 5줄(2025·2026 — 지금 정렬 그대로) · 묶음 안 7줄(2024 이하·"?"·칸 없음·객체 날짜) = 같은 정렬 + 연도가 바뀌는 곳마다 구분 줄(2024년·2023년·2013년·날짜 없음) · 묶음 머리 1개(.asb-hd · aria-expanded false · aria-controls · "지난 자료 · 2024년까지 7건" + ▾ 화살표 칸) · 몸통 처음 숨김 · 묶음은 밖 카드 뒤(맨 아래) · 지운 줄 없음 · 빈 줄 문구 없음',
    A35.head.textContent === '총 12건 (지난 자료 7건 접힘)' && same35(sp0_35.out, OUT35) && same35(sp0_35.inn, IN35)
    && JSON.stringify(sp0_35.out) === JSON.stringify(live35(S35).filter((r) => OUT35.indexOf(r.id) >= 0).sort(cmp35).map((r) => r.id))
    && JSON.stringify(toks35(h0_35)) === JSON.stringify(expToks35(S35, IN35, YEAR35))
    && g0_35.length === 1 && g0_35[0].tag === 'button' && g0_35[0].className === 'asb-hd' && g0_35[0].getAttribute('aria-expanded') === 'false' && g0_35[0].getAttribute('aria-controls') === 'siteOldBd-past'
    && h0_35.indexOf('<span class="asb-t">지난 자료 · 2024년까지 7건</span><span class="sec-caret">▾</span></button>') > 0
    && !!bd0_35 && bd0_35.style.display === 'none' && (h0_35.match(/id="siteOldBd-past"/g) || []).length === 1 && (h0_35.match(/class="item asb-item site-old"/g) || []).length === 1
    && lastOut35 >= 0 && h0_35.indexOf('<div class="item asb-item site-old"') > lastOut35 && cardIds35(h0_35).indexOf('odel') < 0 && h0_35.indexOf('empty-line') < 0,
    JSON.stringify({ head: A35.head.textContent, out: sp0_35.out, inn: sp0_35.inn, toks: toks35(h0_35), grp: g0_35.map((e) => [e.className, e.attrs['aria-expanded']]), bd: bd0_35 && bd0_35.style.display }));

  // ②-2 카드 글 그대로 — 묶음 머리·연도 줄·묶음 닫기를 걷으면 검색 화면(접힘 없음)의 카드와 글자째 같다(밖·안 같은 카드) · 수행 권한이면 묶음 안 카드에도 [근로자 추가]·[수정]이 있고 눌림
  const Q0_35 = build35(S35); Q0_35.api.setQ('현장'); Q0_35.api.render();
  const hs35 = Q0_35.host.innerHTML, st35 = strip35(h0_35), pS35 = hs35.split(CARD0_35), pF35 = st35.split(CARD0_35);
  const C35 = build35(S35, { can: true }); C35.api.render();
  const cEd35 = C35.els.filter((e) => own35(e.attrs, 'data-asb-edit')), cWk35 = C35.els.filter((e) => own35(e.attrs, 'data-site-wk'));
  const cIn35 = split35(C35.host.innerHTML).inn;
  (cEd35.filter((e) => e.attrs['data-asb-edit'] === 'o13')[0] || { click() {} }).click(); (cWk35.filter((e) => e.attrs['data-site-wk'] === 'o13')[0] || { click() {} }).click();
  T('v435 ②-2 카드 글 그대로: 묶음 머리·연도 줄·묶음 닫기를 걷으면 남는 글 = 카드 12장, 검색 화면(접힘 없음) 카드 12장과 글자째 같음(밖·안 같은 카드 — 특별교육 줄·표 칸 그대로) · 현장 수행 권한이면 [수정]·[근로자 추가]가 12줄 모두(묶음 안 7줄 포함)에 있고 묶음 안 카드 버튼이 openAsb·openSiteWorkers를 부름',
    pS35.length === 13 && pF35.length === 13 && pS35[0] === '' && pF35[0] === '' && JSON.stringify(pS35.slice(1).sort()) === JSON.stringify(pF35.slice(1).sort()) && st35 !== h0_35
    && cEd35.length === 12 && cWk35.length === 12 && same35(cIn35, IN35) && C35.log.join(',') === 'edit:o13,wk:o13',
    JSON.stringify({ s: pS35.length, f: pF35.length, f0: pF35[0].slice(0, 80), ed: cEd35.length, wk: cWk35.length, log: C35.log }));

  // ②-2 고정(v435 검토 — 위 ②-2는 같은 소스의 두 화면끼리라 siteCard 글이 바뀌면 양쪽이 함께 바뀌어 통과했다): v434(c1cc9b1) renderSites로 뽑아 고정한 카드 3장과 글자째 대조.
  //   표본 PIN35 = 카드 칸을 될 수 있는 대로 모두 지나는 3줄(현장 수행 권한 — 버튼 포함): 석면 작업중 2099(작업신고 마감·참여 근로자 직원+일용직·특별교육 줄·농도·인계번호·키스콘·계약액·발주자 승인 취소(warn)·보존 만료·메모 줄바꿈·이스케이프) /
  //   철거 종결 2024(발주처 —·소재지 미입력·미지정 — 묶음 안) / 준설 상태 칸 없음·날짜 없음((공사명 없음)·기간 미상·? ~ ? — 종결 아님이라 밖). 날짜는 오늘과 무관(2099·2024 — 신고 D-n 칩 없음).
  //   고정 글 = git show c1cc9b1:index.html의 renderSites를 이 하네스와 같은 대역(명부 홍길동·일용 갑, 교육 기록 0, 안전 권한형)으로 돌린 목록 글(v434는 접힘이 없다). 카드 글을 일부러 바꿀 때만 이 고정 글을 함께 고친다
  const PIN35 = [
    { id: 'pA', seq: 7, title: '현장 고정 석면 <b>', kind: 'asbestos', client: '포항시 & 교육청', site: '포항시 남구', start: '2099-05-01', end: '2099-06-30', material: '천장텍스', area: '120.5', status: 'run', conc: '0.002', waste_no: 'W-1', note: '첫 줄\n둘째 줄', member_ids: ['u1'], worker_ids: ['w1'], ks: { no: 'K-9', year: 2099, biz: '석면해체', amount: 12345678, done_amount: 2000000, approve: '승인 취소' } },
    { id: 'pB', title: '현장 고정 철거', kind: 'demolition', client: '', site: '', start: '2024-03-02', end: '2024-03-09', status: 'done', member_ids: [], worker_ids: [] },
    { id: 'pC', title: '', kind: 'dredge', site: '현장 준설 구역', start: '', end: '', member_ids: [], worker_ids: [] },
  ];
  const PIN_OPT35 = { can: true, members: [{ id: 'u1', name: '홍길동' }], workers: [{ id: 'w1', name: '일용 갑' }] };
  const PIN_V434_35 = [
    '<div class="item asb-item" style="display:block;padding:0;"><button type="button" class="asb-hd" data-site-fold="pA" aria-expanded="false"><span class="asb-seq">석면 #7</span><span class="asb-t">현장 고정 석면 &lt;b&gt;</span><span class="asb-end">2099-06-30</span><span class="sec-caret">▾</span></button><div class="asb-bd" id="siteBd-pA" style="display:none;"><div class="jw-sheet-wrap"><table class="jw-sheet"><tr><th>종류·상태</th><td>석면 · 작업중</td></tr><tr><th>발주처</th><td>포항시 &amp; 교육청</td></tr><tr><th>소재지</th><td>포항시 남구</td></tr><tr><th>기간</th><td><span class="num">2099-05-01 ~ 2099-06-30</span></td></tr><tr><th>자재·면적</th><td>천장텍스 · <span class="num">120.5㎡</span></td></tr><tr><th>작업신고 마감</th><td class="warn"><span class="num">2099-04-24</span> (착수 7일 전)</td></tr><tr><th>참여 근로자</th><td><b class="num">2명</b> · 홍길동, 일용 갑 <button class="mini-btn" data-site-wk="pA" style="margin-left:6px;">근로자 추가</button></td></tr><tr><th>특별교육</th><td class="warn"><b>미이수 2명</b> — 홍길동, 일용 갑 (배치 전 이수 필요)</td></tr><tr><th>공기 중 농도</th><td><span class="num">0.002</span> 개/㎤</td></tr><tr><th>폐기물 인계번호</th><td>W-1</td></tr><tr><th>키스콘 신고</th><td><span class="num">K-9</span> · 2099년 · 석면해체</td></tr><tr><th>계약액</th><td><span class="num">12345678원</span> · 기성 <span class="num">2000000원</span></td></tr><tr><th>발주자 승인</th><td class="warn">승인 취소</td></tr><tr><th>기록 보존 만료</th><td><span class="num">2129-06-30</span></td></tr><tr><th>메모</th><td>첫 줄<br>둘째 줄</td></tr></table></div><button class="link-btn" data-asb-edit="pA" style="text-align:left;width:auto;padding:2px 0 0;">수정</button></div></div>',
    '<div class="item asb-item" style="display:block;padding:0;"><button type="button" class="asb-hd" data-site-fold="pB" aria-expanded="false"><span class="asb-seq">철거</span><span class="asb-t">현장 고정 철거</span><span class="asb-end">2024-03-09</span><span class="sec-caret">▾</span></button><div class="asb-bd" id="siteBd-pB" style="display:none;"><div class="jw-sheet-wrap"><table class="jw-sheet"><tr><th>종류·상태</th><td>철거 · 종결</td></tr><tr><th>발주처</th><td>—</td></tr><tr><th>소재지</th><td class="warn"><b>미입력</b></td></tr><tr><th>기간</th><td><span class="num">2024-03-02 ~ 2024-03-09</span></td></tr><tr><th>참여 근로자</th><td class="warn"><b>미지정</b> <button class="mini-btn" data-site-wk="pB" style="margin-left:6px;">근로자 추가</button></td></tr><tr><th>기록 보존 만료</th><td><span class="num">2054-03-09</span></td></tr></table></div><button class="link-btn" data-asb-edit="pB" style="text-align:left;width:auto;padding:2px 0 0;">수정</button></div></div>',
    '<div class="item asb-item" style="display:block;padding:0;"><button type="button" class="asb-hd" data-site-fold="pC" aria-expanded="false"><span class="asb-seq">준설</span><span class="asb-t">(공사명 없음)</span><span class="asb-end">기간 미상</span><span class="sec-caret">▾</span></button><div class="asb-bd" id="siteBd-pC" style="display:none;"><div class="jw-sheet-wrap"><table class="jw-sheet"><tr><th>종류·상태</th><td>준설 · 예정</td></tr><tr><th>발주처</th><td>—</td></tr><tr><th>소재지</th><td>현장 준설 구역</td></tr><tr><th>기간</th><td><span class="num">? ~ ?</span></td></tr><tr><th>참여 근로자</th><td class="warn"><b>미지정</b> <button class="mini-btn" data-site-wk="pC" style="margin-left:6px;">근로자 추가</button></td></tr></table></div><button class="link-btn" data-asb-edit="pC" style="text-align:left;width:auto;padding:2px 0 0;">수정</button></div></div>',
  ];
  const PS35 = build35(JSON.parse(JSON.stringify(PIN35)), PIN_OPT35); PS35.api.setQ('현장'); PS35.api.render();
  const PF35 = build35(JSON.parse(JSON.stringify(PIN35)), PIN_OPT35); PF35.api.render();
  const pfCards35 = strip35(PF35.host.innerHTML).split(CARD0_35).slice(1).map((s) => CARD0_35 + s), pfSp35 = split35(PF35.host.innerHTML);
  const pinAt35 = (() => { const a = PS35.host.innerHTML, b = PIN_V434_35.join(''); if (a === b) return -1; let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; })();
  T('v435 ②-2 고정 카드 글 = v434(c1cc9b1 renderSites로 뽑은 카드 3장, 현장 수행 권한 — 검토 반영): 검색 화면(접힘 없음) 목록 글이 고정 글과 글자째 같음·머리 "총 3건" · 접힘 화면에서 묶음 머리·연도 줄을 걷은 카드 3장도 고정 카드와 글자째 같음(종결 2024 철거는 묶음 안, 작업중 2099 석면·상태 칸 없는 날짜 없음 준설은 밖)·머리 "총 3건 (지난 자료 1건 접힘)"',
    pinAt35 === -1 && PS35.head.textContent === '총 3건'
    && pfCards35.length === 3 && JSON.stringify(pfCards35.slice().sort()) === JSON.stringify(PIN_V434_35.slice().sort())
    && JSON.stringify(pfSp35.out) === '["pA","pC"]' && JSON.stringify(pfSp35.inn) === '["pB"]' && PF35.head.textContent === '총 3건 (지난 자료 1건 접힘)',
    JSON.stringify({ at: pinAt35, got: pinAt35 < 0 ? '' : PS35.host.innerHTML.slice(Math.max(0, pinAt35 - 40), pinAt35 + 60), want: pinAt35 < 0 ? '' : PIN_V434_35.join('').slice(Math.max(0, pinAt35 - 40), pinAt35 + 60), head: PS35.head.textContent, fold: [pfCards35.length, pfSp35.out, pfSp35.inn, PF35.head.textContent] }));

  // ②-3 진행 줄은 접지 않는다(v435 검토 — 저장은 공사명만 필수·상태 기본 '예정'이라 날짜 칸을 비우고 저장한 새 현장이 '2024년까지' 묶음에 숨었고, 2024년 이전 시작·작업중 줄과
  //   현황 ③(종결 아닌 줄의 특별교육 미이수·작업신고 마감)이 가리키는 현장도 접힘 안에 있었다): 종결(done)이 아닌 줄(예정·작업중·상태 칸 없음 = 카드 '예정')은 연도·날짜 없음과 상관없이 밖(지금 정렬 그대로),
  //   묶음은 종결 줄만. 종류 거르기에도 같은 규칙 · 진행 줄뿐이면 묶음·빈 줄 문구 없음 · 지운 진행 줄은 어디에도 없음
  const ACT35 = [
    { id: 'aN26', title: '진행 표본 26 종결', start: '2026-01-05', end: '', status: 'done' },
    { id: 'aNP', title: '진행 표본 날짜 없음 예정', kind: 'asbestos', start: '', end: '', status: 'plan', member_ids: [], worker_ids: [] },
    { id: 'aNR', title: '진행 표본 날짜 없음 작업중', kind: 'dredge', status: 'run' },
    { id: 'aNS', title: '진행 표본 날짜 없음 상태 없음', kind: 'demolition' },
    { id: 'aR19', title: '진행 표본 2019 작업중', kind: 'dredge', start: '2019-04-01', end: '', status: 'run' },
    { id: 'aP24', title: '진행 표본 2024 예정', kind: 'asbestos', start: '2024-12-31', end: '', status: 'plan' },
    { id: 'aD20', title: '진행 표본 2020 종결', kind: 'asbestos', start: '2020-05-05', end: '2020-05-09', status: 'done' },
    { id: 'aDN', title: '진행 표본 날짜 없음 종결', kind: 'asbestos', status: 'done' },
    { id: 'aDel', title: '진행 표본 지운 줄', start: '', status: 'plan', del: 1 },
  ];
  const ACT_OUT35 = ['aN26', 'aNP', 'aNR', 'aNS', 'aR19', 'aP24'], ACT_IN35 = ['aD20', 'aDN'];
  const AC35 = build35(ACT35); AC35.api.render();
  const ac1_35 = { sp: split35(AC35.host.innerHTML), head: AC35.head.textContent, toks: toks35(AC35.host.innerHTML), txt: AC35.host.innerHTML.indexOf('<span class="asb-t">지난 자료 · 2024년까지 2건</span>') > 0, del: cardIds35(AC35.host.innerHTML).indexOf('aDel') < 0 };
  AC35.api.setF('dredge'); AC35.api.render(); const ac2_35 = { sp: split35(AC35.host.innerHTML), head: AC35.head.textContent };
  AC35.api.setF('asbestos'); AC35.api.render(); const ac3_35 = { sp: split35(AC35.host.innerHTML), head: AC35.head.textContent };
  const AO35 = build35(ACT35.filter((r) => r.status !== 'done' && r.del !== 1)); AO35.api.render(); const ao_35 = { sp: split35(AO35.host.innerHTML), head: AO35.head.textContent, h: AO35.host.innerHTML };
  T('v435 ②-3 진행 줄은 접지 않음(검토 반영): 종결 아닌 줄(날짜 없는 예정·작업중·상태 칸 없음, 2019 작업중, 2024-12-31 예정)은 밖 — 지금 정렬 그대로 · 묶음은 종결 줄만(2020 종결·날짜 없는 종결) "지난 자료 · 2024년까지 2건"·머리 "총 8건 (지난 자료 2건 접힘)" · 지운 진행 줄 없음 · 준설만 = 진행 2줄 밖·묶음 없음·"총 2건" · 석면(kind 없는 줄 포함) = 밖 3줄·안 2줄 · 진행 줄뿐이면 묶음·빈 줄 문구 없음·"총 5건"',
    ac1_35.head === '총 8건 (지난 자료 2건 접힘)' && JSON.stringify(ac1_35.sp.out) === JSON.stringify(live35(ACT35).filter((r) => ACT_OUT35.indexOf(r.id) >= 0).sort(cmp35).map((r) => r.id))
    && JSON.stringify(ac1_35.toks) === '["#2020년","aD20","#날짜 없음","aDN"]' && ac1_35.txt && ac1_35.del
    && ac2_35.head === '총 2건' && ac2_35.sp.g < 0 && same35(ac2_35.sp.out, ['aNR', 'aR19'])
    && ac3_35.head === '총 5건 (지난 자료 2건 접힘)' && same35(ac3_35.sp.out, ['aN26', 'aNP', 'aP24']) && same35(ac3_35.sp.inn, ACT_IN35)
    && ao_35.sp.g < 0 && ao_35.h.indexOf('empty-line') < 0 && same35(ao_35.sp.out, ['aNP', 'aNR', 'aNS', 'aR19', 'aP24']) && ao_35.head === '총 5건',
    JSON.stringify({ a1: [ac1_35.head, ac1_35.sp.out, ac1_35.toks, ac1_35.txt, ac1_35.del], a2: [ac2_35.head, ac2_35.sp.out], a3: [ac3_35.head, ac3_35.sp.out, ac3_35.sp.inn], ao: [ao_35.head, ao_35.sp.out] }));

  // ②-4 묶음 안 같은 연도끼리(v435 검토 — 정렬 키는 시작일 원문, 연도는 siteYear라 시작일이 날짜 꼴이 아닌 글이면 같은 연도 구분 줄이 두 번 나오고 제 연도 칸 밖에 놓였다):
  //   '?' + 종료일 2020 · 앞 공백 ' 2020-09-01' · '미정' · 'TBD' + 종료일 2021 → 연도 줄은 연도마다 한 번(내림차순, 날짜 없음 맨 끝), 같은 연도 안은 지금 정렬 순서.
  //   표본이 실제로 그 자리를 지나는지(지금 정렬 그대로 늘어놓으면 같은 연도 줄이 두 번)도 함께 본다 — 데이터가 YYYY-MM-DD·빈칸뿐이면 순서는 ②·⑦ 그대로
  const ODD35 = [
    { id: 'q22', title: '연도 표본 22', start: '2022-02-02', end: '2022-02-03', status: 'done' },
    { id: 'q20', title: '연도 표본 20', start: '2020-03-03', end: '2020-03-04', status: 'done' },
    { id: 'q14', title: '연도 표본 14', start: '2014-05-05', status: 'done' },
    { id: 'qQ20', title: '연도 표본 물음표 20', start: '?', end: '2020-08-01', status: 'done' },
    { id: 'qS20', title: '연도 표본 앞 공백 20', start: ' 2020-09-01', end: '', status: 'done' },
    { id: 'qMJ', title: '연도 표본 미정', start: '미정', end: '', status: 'done' },
    { id: 'qTB', title: '연도 표본 TBD 21', start: 'TBD', end: '2021-06-01', status: 'done' },
    { id: 'qNO', title: '연도 표본 날짜 없음', status: 'done' },
    { id: 'q26', title: '연도 표본 26', start: '2026-02-02', status: 'done' },
  ];
  const ODD_Y35 = { q22: 2022, q20: 2020, q14: 2014, qQ20: 2020, qS20: 2020, qMJ: 0, qTB: 2021, qNO: 0, q26: 2026 };
  const oddOld35 = live35(ODD35).sort(cmp35).filter((r) => r.id !== 'q26');   // 지금 정렬 순서(묶음 쪽 8줄)
  const tokOf35 = (rows) => { const out = []; let p = null; rows.forEach((o) => { if (o.y !== p) { out.push('#' + (o.y ? o.y + '년' : '날짜 없음')); p = o.y; } out.push(o.id); }); return out; };
  const naive35 = tokOf35(oddOld35.map((r) => ({ id: r.id, y: ODD_Y35[r.id] })));
  const want35 = tokOf35(oddOld35.map((r, i) => ({ id: r.id, y: ODD_Y35[r.id], i })).sort((a, b) => (b.y - a.y) || (a.i - b.i)));
  const OD35 = build35(ODD35); OD35.api.render();
  const od_35 = { toks: toks35(OD35.host.innerHTML), out: split35(OD35.host.innerHTML).out, head: OD35.head.textContent };
  const odY35 = od_35.toks.filter((t) => t[0] === '#'), nvY35 = naive35.filter((t) => t[0] === '#');
  T('v435 ②-4 묶음 안 같은 연도끼리(검토 반영 — 시작일이 "?"·앞 공백·"미정"·"TBD" 같은 글): 연도 줄은 연도마다 한 번 · 내림차순(2022 → 2021 → 2020 → 2014 → 날짜 없음 맨 끝) · 같은 연도 안은 지금 정렬 순서 · 밖은 2026 1줄·머리 "총 9건 (지난 자료 8건 접힘)" · (표본 확인: 지금 정렬 그대로 늘어놓으면 같은 연도 줄이 두 번 나오는 표본·연도 판정이 표와 같음)',
    JSON.stringify(od_35.toks) === JSON.stringify(want35) && new Set(odY35).size === odY35.length && JSON.stringify(odY35) === '["#2022년","#2021년","#2020년","#2014년","#날짜 없음"]'
    && JSON.stringify(od_35.out) === '["q26"]' && od_35.head === '총 9건 (지난 자료 8건 접힘)'
    && new Set(nvY35).size < nvY35.length && live35(ODD35).every((r) => OD35.api.year(r) === ODD_Y35[r.id]),
    JSON.stringify({ toks: od_35.toks, want: want35, naive: naive35, out: od_35.out, head: od_35.head }));

  // ③ 펼치기 — 머리를 누르면 bindFold가 몸통·class·aria를 바꾸고 펼침을 기억(siteOldOpen), 머리 건수에서 '접힘'이 빠짐. 누를 때 다시 그리지 않는다(밖에 펼쳐 둔 카드가 그대로).
  //    안쪽 카드도 접기·펴기 · 다시 그려도 펼친 채(안쪽 카드는 종전처럼 다시 접힘) · 다시 누르면 접힘 · 새 앱(새로 켬)은 접힘
  const oc35 = A35.els.filter((e) => e.attrs['data-site-fold'] === 'n26')[0]; oc35.click();
  const g1_35 = grpBtn35(A35)[0]; g1_35.click();
  const bd1_35 = A35.byId['siteOldBd-past'];
  const s1_35 = { cls: g1_35.className, aria: g1_35.getAttribute('aria-expanded'), disp: bd1_35 ? bd1_35.style.display : 'x', open: A35.api.isOpen(), head: A35.head.textContent, outCard: (A35.byId['siteBd-n26'] || { style: {} }).style.display, same: bd1_35 === bd0_35 };
  const ib35 = A35.els.filter((e) => e.attrs['data-site-fold'] === 'o23')[0], ibd35 = A35.byId['siteBd-o23'];
  ib35.click(); const s2_35 = { cls: ib35.className, disp: ibd35.style.display };
  ib35.click(); const s3_35 = { cls: ib35.className, disp: ibd35.style.display };
  ib35.click();   // 펼쳐 둔 채 다시 그림 → 안쪽 카드는 다시 접힘(종전 bindFold 규칙)
  A35.api.render();
  const g4_35 = grpBtn35(A35)[0], s4_35 = { cls: g4_35.className, aria: g4_35.getAttribute('aria-expanded'), disp: A35.byId['siteOldBd-past'].style.display, head: A35.head.textContent, inner: A35.byId['siteBd-o23'].style.display, html: /<div id="siteOldBd-past">/.test(A35.host.innerHTML) };
  g4_35.click(); const s5_35 = { open: A35.api.isOpen(), disp: A35.byId['siteOldBd-past'].style.display, head: A35.head.textContent, cls: g4_35.className, aria: g4_35.getAttribute('aria-expanded') };
  const B35 = build35(S35); B35.api.render();
  const s6_35 = { open: B35.api.isOpen(), disp: B35.byId['siteOldBd-past'].style.display, head: B35.head.textContent, aria: grpBtn35(B35)[0].getAttribute('aria-expanded') };
  T('v435 ③ 펼치기(실제 bindFold): 묶음 머리를 누르면 class "asb-hd open"·aria true·몸통 보임·siteOldOpen true·머리 "총 12건"(접힘 글 빠짐) · 누를 때 목록을 다시 그리지 않음(같은 몸통 요소·밖에 펼쳐 둔 카드 그대로) · 묶음 안 카드도 접기·펴기(bindFold가 안쪽에도 붙음) · 다시 그려도 묶음은 펼친 채(앱 켜 있는 동안 기억 — 안쪽 카드는 종전처럼 다시 접힘) · 다시 누르면 접힘·"(지난 자료 7건 접힘)" · 새 앱은 접힘',
    s1_35.cls === 'asb-hd open' && s1_35.aria === 'true' && s1_35.disp === '' && s1_35.open === true && s1_35.head === '총 12건' && s1_35.outCard === '' && s1_35.same === true
    && s2_35.cls === 'asb-hd open' && s2_35.disp === '' && s3_35.cls === 'asb-hd' && s3_35.disp === 'none'
    && s4_35.cls === 'asb-hd open' && s4_35.aria === 'true' && s4_35.disp === '' && s4_35.head === '총 12건' && s4_35.inner === 'none' && s4_35.html === true
    && s5_35.open === false && s5_35.disp === 'none' && s5_35.head === '총 12건 (지난 자료 7건 접힘)' && s5_35.cls === 'asb-hd' && s5_35.aria === 'false'
    && s6_35.open === false && s6_35.disp === 'none' && s6_35.head === '총 12건 (지난 자료 7건 접힘)' && s6_35.aria === 'false',
    JSON.stringify({ s1: s1_35, s2: s2_35, s3: s3_35, s4: s4_35, s5: s5_35, s6: s6_35 }));

  // ④ 검색어 — 있으면 접지 않고 맞는 것을 모두 종전처럼(묶음·연도 줄 없음, 머리 '총 n건'), 지우면 묶음이 돌아옴(펼쳐 뒀으면 펼친 채)
  const Q35 = build35(S35);
  Q35.api.render(); grpBtn35(Q35)[0].click();
  Q35.api.setQ('현장'); Q35.api.render(); const q1_35 = { ids: cardIds35(Q35.host.innerHTML), head: Q35.head.textContent, grp: Q35.host.innerHTML.indexOf('data-site-old-fold') < 0 && Q35.host.innerHTML.indexOf('site-yr') < 0 };
  Q35.api.setQ(' 아주 옛 '); Q35.api.render(); const q2_35 = { ids: cardIds35(Q35.host.innerHTML), head: Q35.head.textContent, grp: Q35.host.innerHTML.indexOf('data-site-old-fold') < 0, disp: (Q35.byId['siteBd-o13'] || { style: {} }).style.display };
  Q35.api.setQ('옛'); Q35.api.render(); const q3_35 = { ids: cardIds35(Q35.host.innerHTML), head: Q35.head.textContent, grp: Q35.host.innerHTML.indexOf('data-site-old-fold') < 0 };
  Q35.api.setQ('없는말'); Q35.api.render(); const q4_35 = { h: Q35.host.innerHTML, head: Q35.head.textContent };
  Q35.api.setQ(''); Q35.api.render(); const q5_35 = { head: Q35.head.textContent, aria: (grpBtn35(Q35)[0] || { getAttribute: () => null }).getAttribute('aria-expanded'), disp: (Q35.byId['siteOldBd-past'] || { style: {} }).style.display };
  T('v435 ④ 검색어: 있으면 접지 않음 — "현장"(모두 맞음) 12줄 지금 정렬·머리 "총 12건"·묶음·연도 줄 없음 · " 아주 옛 "(2013년 한 줄) 바로 보임·머리 "총 1건" · "옛" 2024 이하 2줄만 · 맞는 것 없음 = 종전 빈 줄 문구·머리 비움 · 검색어를 지우면 묶음이 돌아오고 펼쳐 둔 상태 그대로',
    JSON.stringify(q1_35.ids) === JSON.stringify(live35(S35).sort(cmp35).map((r) => r.id)) && q1_35.head === '총 12건' && q1_35.grp
    && JSON.stringify(q2_35.ids) === '["o13"]' && q2_35.head === '총 1건' && q2_35.grp && q2_35.disp === 'none'
    && same35(q3_35.ids, ['o23', 'o13']) && q3_35.head === '총 2건' && q3_35.grp
    && q4_35.h === '<div class="empty-line">해당하는 현장이 없습니다.</div>' && q4_35.head === ''
    && q5_35.head === '총 12건' && q5_35.aria === 'true' && q5_35.disp === '',
    JSON.stringify({ q1: q1_35, q2: q2_35, q3: q3_35, q4: q4_35, q5: q5_35 }));

  // ⑤ 종류 거르기만 — 접힘 유지, 묶음 머리·머리 건수는 거른 뒤 건수. 거른 뒤 지난 자료가 없으면 묶음 없음. 거르기 + 검색어 = 접힘 없음
  const F35 = build35(S35);
  F35.api.setF('demolition'); F35.api.render(); const f1_35 = { sp: split35(F35.host.innerHTML), head: F35.head.textContent, txt: F35.host.innerHTML.indexOf('<span class="asb-t">지난 자료 · 2024년까지 1건</span>') > 0 };
  F35.api.setF('dredge'); F35.api.render(); const f2_35 = { sp: split35(F35.host.innerHTML), head: F35.head.textContent };
  F35.api.setF('asbestos'); F35.api.render(); const f3_35 = { sp: split35(F35.host.innerHTML), head: F35.head.textContent };
  F35.api.setF('demolition'); F35.api.setQ('시작없음'); F35.api.render(); const f4_35 = { sp: split35(F35.host.innerHTML), head: F35.head.textContent };
  T('v435 ⑤ 종류 거르기만: 철거 = 머리 "총 2건 (지난 자료 1건 접힘)"·밖 2025 1줄·묶음 "지난 자료 · 2024년까지 1건" · 준설(2025 1줄뿐) = 묶음 없음·"총 1건" · 석면(kind 없는 옛 기록 포함) = "총 9건 (지난 자료 6건 접힘)" · 거르기 + 검색어 = 접힘 없음',
    f1_35.head === '총 2건 (지난 자료 1건 접힘)' && JSON.stringify(f1_35.sp.out) === '["n25"]' && JSON.stringify(f1_35.sp.inn) === '["o24e"]' && f1_35.txt
    && f2_35.head === '총 1건' && f2_35.sp.g < 0 && JSON.stringify(f2_35.sp.out) === '["n25e"]'
    && f3_35.head === '총 9건 (지난 자료 6건 접힘)' && same35(f3_35.sp.out, ['n26', 'n25d', 'n26n']) && same35(f3_35.sp.inn, ['o24', 'o23', 'o13', 'oq', 'on', 'oo'])
    && f4_35.head === '총 1건' && f4_35.sp.g < 0 && JSON.stringify(f4_35.sp.out) === '["o24e"]',
    JSON.stringify({ f1: [f1_35.head, f1_35.sp.out, f1_35.sp.inn], f2: [f2_35.head, f2_35.sp.out], f3: [f3_35.head, f3_35.sp.out, f3_35.sp.inn], f4: [f4_35.head, f4_35.sp.out] }));

  // ⑥ 지난 자료만 — 빈 줄 문구 대신 묶음 머리만(밖 카드 0, 목록 첫머리가 묶음) · 줄이 하나도 없으면 종전 빈 줄 문구 그대로
  const O35 = build35(S35.filter((r) => IN35.indexOf(r.id) >= 0)); O35.api.render();
  const o1_35 = { h: O35.host.innerHTML, head: O35.head.textContent, sp: split35(O35.host.innerHTML) };
  const E35 = build35([]); E35.api.render(); const E2_35 = build35([{ id: 'x', title: '지운 옛 줄', start: '2013-01-01', del: 1 }]); E2_35.api.render();
  T('v435 ⑥ 지난 자료만: 빈 줄 문구 없이 묶음 머리만("지난 자료 · 2024년까지 7건", 접힘) · 머리 "총 7건 (지난 자료 7건 접힘)" · 밖 카드 0 · 목록 첫머리가 묶음 · 줄이 하나도 없으면(빈 대장·지운 줄뿐) 종전 "해당하는 현장이 없습니다."·머리 비움',
    o1_35.h.indexOf('empty-line') < 0 && o1_35.h.indexOf('<div class="item asb-item site-old"') === 0 && o1_35.sp.out.length === 0 && same35(o1_35.sp.inn, IN35)
    && o1_35.h.indexOf('<span class="asb-t">지난 자료 · 2024년까지 7건</span>') > 0 && o1_35.head === '총 7건 (지난 자료 7건 접힘)' && O35.byId['siteOldBd-past'].style.display === 'none'
    && E35.host.innerHTML === '<div class="empty-line">해당하는 현장이 없습니다.</div>' && E35.head.textContent === ''
    && E2_35.host.innerHTML === '<div class="empty-line">해당하는 현장이 없습니다.</div>' && E2_35.head.textContent === '',
    JSON.stringify({ h: o1_35.h.slice(0, 120), head: o1_35.head, out: o1_35.sp.out, e: E35.host.innerHTML, e2: E2_35.host.innerHTML }));

  // ⑦ 운영 분포 흉내 — 11/10 08:15 운영 백업 실측(읽기만): 살아있는 159줄 = 2013 3·2014 20·2015 10·2016 15·2017 13·2018 18·2019 14·2020 8·2021 13·2022 8·2023 9·2024 3(= 134)·2025 21·2026 3·날짜 없음 1, 지운 줄 20
  //    (단계지시 파일 단계지시_v435_c현장접기.json도 135(134 + 1) — 구현에 전달된 계산 글만 136(135 + 1)이었고 합이 160이라 살아있는 159와 맞지 않는다, FEATURES v435)
  //    표본은 모두 종결(done) — 운영 11/9 08:54 백업 실측도 접히는 135줄·날짜 없는 1줄이 모두 종결이라 종결 규칙(②-3)을 더해도 135/24 그대로
  const DIST35 = { 2013: 3, 2014: 20, 2015: 10, 2016: 15, 2017: 13, 2018: 18, 2019: 14, 2020: 8, 2021: 13, 2022: 8, 2023: 9, 2024: 3, 2025: 21, 2026: 3 };
  const P35 = [];
  Object.keys(DIST35).forEach((y) => { for (let i = 0; i < DIST35[y]; i++) P35.push({ id: 'p' + y + '_' + i, title: '운영 흉내 ' + y + '-' + i, kind: ['asbestos', 'demolition', 'dredge'][i % 3], start: y + '-' + String((i % 12) + 1).padStart(2, '0') + '-' + String((i % 27) + 1).padStart(2, '0'), end: '', status: 'done' }); });
  P35.push({ id: 'pnone', title: '운영 흉내 날짜 없음', status: 'done' });
  for (let i = 0; i < 20; i++) P35.push({ id: 'pdel' + i, title: '지운 줄', start: '2026-01-0' + ((i % 9) + 1), del: 1 });
  const W35 = build35(P35); W35.api.render();
  const w1_35 = { head: W35.head.textContent, sp: split35(W35.host.innerHTML), yr: toks35(W35.host.innerHTML).filter((t) => t[0] === '#') };
  T('v435 ⑦ 운영 분포 흉내(11/10 백업 실측 — 살아있는 159줄·지운 20줄): 머리 "총 159건 (지난 자료 135건 접힘)" · 묶음 "지난 자료 · 2024년까지 135건" · 보이는 줄 24(2025년 21 + 2026년 3) · 묶음 안 연도 줄 13개(2024년 → 2013년 → 날짜 없음, 같은 연도 두 번 없음)',
    w1_35.head === '총 159건 (지난 자료 135건 접힘)' && w1_35.sp.out.length === 24 && w1_35.sp.inn.length === 135 && W35.host.innerHTML.indexOf('<span class="asb-t">지난 자료 · 2024년까지 135건</span>') > 0
    && JSON.stringify(w1_35.yr) === JSON.stringify(['#2024년', '#2023년', '#2022년', '#2021년', '#2020년', '#2019년', '#2018년', '#2017년', '#2016년', '#2015년', '#2014년', '#2013년', '#날짜 없음'])
    && w1_35.sp.out.every((id) => /^p202[56]_/.test(id)) && w1_35.sp.inn.indexOf('pnone') === 134,
    JSON.stringify({ head: w1_35.head, out: w1_35.sp.out.length, inn: w1_35.sp.inn.length, yr: w1_35.yr }));

  // ⑧ 상수 하나 — 소스 사본에서 SITE_OLD_BEFORE를 2026으로 바꾸면 2025년 줄도 묶음으로 가고 머리가 '2025년까지'(경계는 이 상수 하나뿐인지)
  const src26_35 = html.replace(/\n  var SITE_OLD_BEFORE = \d+;\n/, '\n  var SITE_OLD_BEFORE = 2026;\n');
  const K35 = build35(S35, { src: src26_35 }); K35.api.render();
  const k1_35 = { head: K35.head.textContent, sp: split35(K35.host.innerHTML), yr: toks35(K35.host.innerHTML).filter((t) => t[0] === '#') };
  T('v435 ⑧ 상수 하나(소스 사본 SITE_OLD_BEFORE 2026 실행): 2025년 줄(시작일·종료일만·"2025.03")도 묶음 — 머리 "총 12건 (지난 자료 10건 접힘)"·묶음 "지난 자료 · 2025년까지 10건"·밖은 2026년 2줄 · 연도 줄 2025년이 맨 앞 · (사본은 실제로 바뀐 글)',
    src26_35 !== html && k1_35.head === '총 12건 (지난 자료 10건 접힘)' && same35(k1_35.sp.out, ['n26', 'n26n']) && same35(k1_35.sp.inn, ['n25', 'n25e', 'n25d'].concat(IN35))
    && K35.host.innerHTML.indexOf('<span class="asb-t">지난 자료 · 2025년까지 10건</span>') > 0 && k1_35.yr[0] === '#2025년' && k1_35.yr.length === 5,
    JSON.stringify(k1_35));

  // ⑨ 정적 — 상수는 2025(PM '25년 이전') 한 곳 · 펼침 기억은 메모리(선언 false · renderSites 밖에서 안 씀 · 저장소 0) · 세 이름은 renderSites 밖에서 안 씀(현황·캘린더·계약 연결·전역 검색 무변)
  //    · bindFold 순서(카드 → 묶음 → 펼침 기억·머리 건수) · 검색어가 있으면 가르지 않는 갈래 · CSS(묶음 화살표 ▸/▾·감싸개 :active·연도 줄)
  //    세는 글은 주석을 걷은 글(v433 htmlNC33과 같은 줄 주석 규칙 + <style> 안 /* */) — 주석 속 이름 언급은 쓰임이 아니다
  const ncJs35 = (s) => s.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
  const stEnd35 = html.indexOf('</style>');
  const htmlNC35 = html.slice(0, stEnd35).replace(/\/\*[\s\S]*?\*\//g, '') + ncJs35(html.slice(stEnd35));
  const rs35 = fn35(html, 'renderSites'), rsNC35 = ncJs35(rs35), out35 = htmlNC35.split(rsNC35).join('');
  const cnt35 = (s, re) => (s.match(re) || []).length;
  const iB1_35 = rs35.indexOf('bindFold(host, "data-site-fold", "siteBd-");'), iB2_35 = rs35.indexOf('bindFold(host, "data-site-old-fold", "siteOldBd-");'), iL_35 = rs35.indexOf('siteOldOpen = b.getAttribute("aria-expanded")==="true";');
  const CSS35 = ['\n  .site-old:active{background:transparent;}\n', '\n  .asb-hd[data-site-old-fold] .sec-caret{transform:rotate(-90deg);}\n', '\n  .asb-hd.open[data-site-old-fold] .sec-caret{transform:none;}\n', '\n  .site-yr{'];
  T('v435 ⑨ 정적: var SITE_OLD_BEFORE = 2025 한 곳 · var siteOldOpen = false 한 곳 · SITE_OLD_BEFORE·siteOldOpen은 선언 밖에서 renderSites만, siteYear( 는 정의 밖에서 renderSites만(현황·캘린더·계약 연결 무변) · renderSites에 저장소·저장·서버 호출 0 · 검색어 있으면 가르지 않는 갈래 · bindFold 카드 → 묶음 → 펼침 기억·머리 건수 순 · CSS 4줄(감싸개 :active 끔·접힘 ▸ rotate(-90deg)·펼침 ▾·연도 줄)',
    cnt35(html, /\n  var SITE_OLD_BEFORE = 2025;\n/g) === 1 && cnt35(html, /\bvar SITE_OLD_BEFORE\b/g) === 1 && cnt35(html, /\n  var siteOldOpen = false;\n/g) === 1 && cnt35(html, /\bvar siteOldOpen\b/g) === 1
    && htmlNC35.indexOf(rsNC35) > 0 && cnt35(out35, /\bSITE_OLD_BEFORE\b/g) === 1 && cnt35(out35, /\bsiteOldOpen\b/g) === 1 && cnt35(out35, /\bsiteYear\(/g) === 1 && cnt35(rsNC35, /\bsiteYear\(/g) === 2
    && !/localStorage|sessionStorage|schedule\w*Save|doSave\w*\(|gwCall\(/.test(rsNC35)
    && /\n    if\(!q\)\{ cur=\[\];/.test(rs35) && cnt35(rsNC35, /\bcur=\[\]/g) === 1
    && iB1_35 > 0 && iB2_35 > iB1_35 && iL_35 > iB2_35 && rsNC35.indexOf('renderSites(', 10) < 0
    && CSS35.every((s) => html.indexOf(s) > 0) && html.indexOf('.asb-hd.open .sec-caret{transform:rotate(180deg);}') > 0,
    JSON.stringify({ decl: cnt35(html, /\bvar SITE_OLD_BEFORE\b/g), outC: cnt35(out35, /\bSITE_OLD_BEFORE\b/g), outO: cnt35(out35, /\bsiteOldOpen\b/g), outY: cnt35(out35, /\bsiteYear\(/g), b: [iB1_35, iB2_35, iL_35], css: CSS35.map((s) => html.indexOf(s) > 0) }));

  // ⑩ 문서 — MANUAL 28절 '자주 하는 일' 1번 한 줄(문장 고정) · FEATURES 기준 ≥ v435·v435 절·§7 안전 줄 · TESTLIST v435(체크 칸 전부 AI 몫 — 화면 칸 '(AI 시험 화면 대상', PM 0, 게이트 칸 [x]) · CLAUDE.md 안전 탭 줄 · sw ≥ 435
  const man35 = rd35('MANUAL.html'), ft35 = rd35('FEATURES.md'), tl35 = rd35('TESTLIST.md'), cl35 = rd35('CLAUDE.md'), sw35 = rd35('sw.js');
  const m28_35 = (() => { const i = man35.indexOf('<h2 id="s28">'); return i < 0 ? '' : man35.slice(i, man35.indexOf('<h3 id="s28-1">', i)); })();
  const MAN35 = '<li>위쪽 <b>전체 / 석면 / 철거 / 준설</b> 버튼과 검색칸(공사명·발주처·소재지)으로 현장을 찾습니다. <b>지난 자료(2024년까지)</b> 묶음은 기본으로 접혀 있습니다 — 종결된 현장 중 시작일(없으면 종료일)이 2024년까지이거나 날짜가 없는 현장은 목록 맨 아래 한 줄로 모이고(예정·작업중 현장은 날짜와 상관없이 위에 그대로), 그 줄을 누르면 펼쳐집니다(앱을 다시 켜면 다시 접힘). 찾을 때는 검색칸에 넣으면 접힘 없이 모두 나옵니다(2026-11 v435).</li>';
  const ftv35 = (() => { const i = ft35.indexOf('\n### v435 (11/10)'); if (i < 0) return ''; const j = ft35.indexOf('\n### ', i + 5); return ft35.slice(i, j < 0 ? ft35.length : j); })();
  const ft7_35 = ft35.split('\n').filter((ln) => ln.indexOf('- **안전**(v428') === 0)[0] || '';
  const tlv35 = (() => { const i = tl35.indexOf('\n## v435'); if (i < 0) return ''; const j = tl35.indexOf('\n## ', i + 5); return tl35.slice(i, j < 0 ? tl35.length : j); })();
  const cb35 = tlv35.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi35 = cb35.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l)), cbPM35 = cb35.filter((l) => /PM/.test(l));
  const cbScr35 = cb35.filter((l) => /^- \[[ x]\] \(AI 시험 화면 대상/.test(l));
  const clSafe35 = cl35.split(/\r?\n/).filter((l) => l.indexOf('- **안전(safety) 탭**') === 0)[0] || '';
  //   낱말만 보면 다른 문장에 남은 같은 낱말로 통과한다(결함 심기에서 실측 숫자 135 → 136·CLAUDE.md 문장 지움이 낱말 검사를 지났다) — 실측 문장·규칙 문장을 통째 고정
  //   검토 반영(11/10): FEATURES v435 절은 낱말 9개·실측 문장 1개만 보아 동작을 거꾸로 적어도(기본 펼침·기기에 저장·검색어 있어도 접음·거르기면 접힘 풀림) 통과했고,
  //   TESTLIST는 화면 칸 '3개 이상'만 보아 칸 하나를 지우거나 순서를 뒤집어도, CLAUDE.md는 '세 이름 밖 0' 규칙 문장을 지워도 통과했다 — 동작 문장·화면 칸 머리·칸 수·규칙 문장을 문장째 고정
  const FT_PINS35 = [
    '살아있는 159줄 = 2013~2024 134 + 날짜 없음 1 → **135건 접힘**, 2025년 21 + 2026년 3 = 24줄 보임',
    "경계는 상수 `SITE_OLD_BEFORE = 2025` 하나 — **종결(done)된 줄** 중 이 해보다 이른 연도와 날짜 없음이 '지난 자료'",
    "종결이 아닌 줄(예정·작업중 — 상태 칸이 없으면 카드도 '예정')은 연도·날짜 없음과 상관없이 위에 그대로 둔다",
    '기본 접힘, 누르면 펼쳐 지금과 같은 현장 카드가 나온다',
    '묶음 안은 지금 정렬(최신 먼저) 그대로 같은 연도끼리 모으고',
    '펼침은 `siteOldOpen`(메모리만 — 앱을 켜 있는 동안은 다시 그려도 펼친 채, 저장하지 않아 앱을 다시 켜면 접힘)',
    '묶음 머리를 누를 때는 목록을 다시 그리지 않고 머리 건수만 고친다',
    '검색어(siteQ)가 있으면 가르지 않고 맞는 것을 모두 종전처럼 보인다',
    '종류 거르기(siteFilter)만 있으면 접힘 유지·건수는 거른 뒤',
    "단계지시 파일은 '135건(2013~2024 134 + 날짜 없음 1)'이고, 구현에 전달된 계산 글만 '136건(2013~2024 135 + 날짜 없음 1)'이었다",
    '②-2 고정이 v434(c1cc9b1) renderSites로 뽑아 고정한 카드 3장',
  ];
  const FT7_PIN35 = "v435부터 종결된 줄 중 시작일(없으면 종료일)이 2024년까지이거나 날짜 없는 줄은 목록 맨 아래 '지난 자료' 한 묶음에 기본 접힘(예정·작업중은 위에 그대로), 검색어가 있으면 접지 않음";
  //   TESTLIST 화면 칸 6개 — 이 순서로 칸마다 머리 하나(김정아는 11/10부터 안전 보기라 정재욱(안전 없음)과 따로 — 검토 반영)
  const TL_HEADS35 = ['관리자형:', '검색·종류 칩:', '김정아·권민지형(안전 보기/수행 + 현장 수행', '정재욱형(현장 수행·안전 없음):', '진행 현장은 접지 않음:', '다른 곳 그대로: 현황 ③'];
  const TL_PINS35 = ['2024년 → 2013년 → 날짜 없음 순으로', "'지난 자료 · 2024년까지 135건'", "'총 159건 (지난 자료 135건 접힘)'", '375px', '특별교육 줄은 앱이 교육 기록으로 판정(asbNoSpecial', "날짜 칸을 비운 '예정' 현장을 저장하면"];
  const CL_PINS35 = ['종결(done)된 줄 중 `siteYear`(시작일 앞 네 자리 → 없으면 종료일 → 둘 다 없으면 0 = 날짜 없음)가 `SITE_OLD_BEFORE`(2025 — 경계는 이 상수 하나)보다 이르거나 0인 줄을 목록 맨 아래 한 묶음',
    "종결이 아닌 줄(예정·작업중·상태 칸 없음 — 카드 '예정', 특별교육 줄·현황 ③도 같은 판정)은 연도와 상관없이 위에 둔다",
    '펼침 `siteOldOpen`은 메모리만(저장 금지 — 앱을 다시 켜면 접힘, 머리를 누를 때는 다시 그리지 않음), 검색어가 있으면 가르지 않는다.',
    '세 이름은 renderSites 밖에서 쓰지 않는다(현황·캘린더·계약 연결 무변 — uismoke v435 ⑨)',
    '②-2 고정이 v434(c1cc9b1)에서 뽑아 고정한 카드 3장과 글자째 대조'];
  const tlHeadOk35 = cbScr35.length === TL_HEADS35.length && TL_HEADS35.every((h, i) => cbScr35[i].indexOf(h) > 0 && cbScr35.filter((l) => l.indexOf(h) > 0).length === 1);
  T('v435 ⑩ 문서: MANUAL 28절 "자주 하는 일" 1번 = 찾기 문장 + 지난 자료(2024년까지) 기본 접힘·종결된 현장만·예정·작업중은 위에 그대로·맨 아래 한 줄·다시 켜면 접힘·찾을 때 검색칸(문장 고정) · FEATURES 기준 ≥ v435·v435 절(낱말 + 문장 11 고정 — 실측 159줄 = 134 + 1 → 135건 접힘·24줄 보임 / 종결 줄만·진행 줄은 위 / 기본 접힘 / 같은 연도끼리 / 펼침 메모리만 / 누를 때 다시 그리지 않음 / 검색어면 가르지 않음 / 거르기는 접힘 유지·거른 뒤 건수 / 건수 메모 135·136 / ②-2 고정)·§7 안전 줄(문장 고정) · TESTLIST v435 체크 칸 전부 AI 몫(화면 칸 정확히 6개 — 관리자형·검색·종류 칩·김정아·권민지형·정재욱형·진행 현장·다른 곳 그대로 순, PM 0, 게이트 칸 [x] uismoke, 연도 순서 문장 고정) · CLAUDE.md 안전 탭 줄(규칙 문장 5 고정 — 종결 줄만 판정·진행 줄은 위·펼침 메모리만·세 이름 renderSites 밖 0·②-2 고정) · sw ≥ 435',
    m28_35.indexOf(MAN35) > 0
    && Number((ft35.match(/기준: v(\d+) /) || [0, 0])[1]) >= 435 && ftv35.length > 0
    && ['`siteYear(r)`', '`SITE_OLD_BEFORE = 2025`', '`siteOldOpen`', "'지난 자료 · 2024년까지 n건'", "' (지난 자료 m건 접힘)'", '검색어', '135건 접힘', 'uismoke v435', '`renderSites`'].every((w) => ftv35.indexOf(w) > 0) && FT_PINS35.every((s) => ftv35.indexOf(s) > 0)
    && ft7_35.indexOf(FT7_PIN35) > 0
    && tlv35.length > 0 && cb35.length >= 7 && cbNotAi35.length === 0 && cbPM35.length === 0 && tlv35.indexOf('PM 몫') < 0 && tlHeadOk35 && cb35.some((l) => /^- \[x\] \(AI\) `uismoke`/.test(l))
    && TL_PINS35.every((w) => tlv35.indexOf(w) > 0)
    && ['v435', '`SITE_OLD_BEFORE`', '`siteOldOpen`', 'uismoke v435'].every((w) => clSafe35.indexOf(w) > 0) && CL_PINS35.every((s) => clSafe35.indexOf(s) > 0)
    && Number((sw35.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 435,
    JSON.stringify({ m28: m28_35.length, man: m28_35.indexOf(MAN35), ftv: ftv35.length, ftMiss: FT_PINS35.filter((s) => ftv35.indexOf(s) < 0).map((s) => s.slice(0, 30)), ft7: ft7_35.indexOf(FT7_PIN35), tl: tlv35.length, cb: cb35.length, notAi: cbNotAi35.map((l) => l.slice(0, 40)), pm: cbPM35.map((l) => l.slice(0, 40)), scr: cbScr35.map((l) => l.slice(0, 50)), tlMiss: TL_PINS35.filter((w) => tlv35.indexOf(w) < 0), clMiss: CL_PINS35.filter((s) => clSafe35.indexOf(s) < 0).map((s) => s.slice(0, 30)) }));
} catch (e) { console.log('  (v435 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v436(11/10 메뉴 56 7단계 '인정·평가 칸과 회사 구분' — PM 11/10 08:19 ⓐ '45방식이랑 별개 방식임. 계약탭처럼 따로 설계된거임' = 안전 설정 따로(인허가 kosha_cert 행 안 씀),
//      09_조사_문서/메뉴안전탭_자료_20261109/단계지시_v436_7인정평가.json · 브리핑 steps[6] · 코드 지도 code.steps[6]):
//      현황 ⑤ 인정·평가 = KOSHA 위험성평가 인정(안전 설정 settings:safety) · 석면 안전성평가 'B 71.6 · 앱 반영 대기' · 등록기준 줄 + 맨 위 회사 구분(회사별 상시근로자 수 두 칸이 다 있을 때만) · 관리자만 [고치기]
//      ① 설정 없음(운영 지금) ② 회사 구분 문턱 ③ KOSHA 단계·날짜·만료 경고 ④ 석면·등록기준·의무 대장 줄(권한·공개범위·교육 이수자 수) ⑤ 설정 읽기 상태(기다림·실패) — ①~⑤는 v432 현황 시험 틀(run32) 그대로
//      ⑥ @safety-set 실행(읽기·창·저장·409 새로 읽기·값 검사·연타·네트워크) ⑦ 정적(현황 구간 저장·서버 호출 0 그대로 · [고치기] 배선은 구간 밖 위임 · 인허가 코드에 kosha_cert 0 · settings:safety를 읽는 서버 경로는 두 핸들러뿐 ·
//      서버 검사 순서·permKey · 앱↔서버 단계·한도 같음) ⑧ CSS·창 마크업·감사 라벨 ⑨ 문서(MANUAL 28-1·FEATURES v436·§7·TESTLIST v436 AI 몫·CLAUDE.md·sw)
try {
  if (!SFNOW32) throw new Error('v432 현황 시험 틀(SFNOW32) 없음');
  const H36 = SFNOW32, rd36 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const fn36 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  //   한 줄 = 그 줄 머리 <div class="item …">(누를 곳 data-sfn-go가 여기) ~ 다음 줄 머리 앞
  const row36 = (s, id) => { const k = '<span class="sfn-id">' + id + '</span>', R = '<div class="item sfn-row'; const i = s.indexOf(k); if (i < 0) return ''; const a = s.lastIndexOf(R, i), j = s.indexOf(R, i); return s.slice(a < 0 ? i : a, j < 0 ? s.length : j); };
  const pills36 = (s, id) => [...row36(s, id).matchAll(/<span class="sfn-pill([^"]*)">([^<]*)<\/span>/g)].map((m) => (m[1].trim() || '-') + ':' + m[2]).join('|');
  const meta36 = (s, id) => (row36(s, id).match(/<div class="item-meta">([^<]*)<\/div>/) || ['', ''])[1];
  const title36 = (s, id) => (row36(s, id).match(/<div class="sfn-t">([\s\S]*?)<\/div>/) || ['', ''])[1];
  const addD36 = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const TD36 = '2026-11-10', seed36 = H36.seedBy32, dut36 = [4, 16, 17, 18, 32, 61, 62].map((n) => seed36[n]);
  const EQUIP36 = 'HEPA 음압기 · 음압기록장치 · HEPA 진공청소기 · 위생설비 · 송기마스크·전동식 호흡보호구 · 습윤장치';
  const KS36 = (o) => Object.assign({ stage: 'none', apply_no: '', applied_on: '', review_on: '', decided_on: '', expires_on: '', rate_year: '', checks: [] }, o || {});
  const SET36 = (k, h) => ({ kosha: KS36(k), headcount: Object.assign({ env: '', con: '' }, h || {}) });
  const ev36 = (o) => { const r = H36.run32(H36.base32(Object.assign({ duties: dut36 }, o || {}))); return { r, out: r.out, ev: H36.blk32(r.out, 'eval'), corp: H36.blk32(r.out, 'corp') }; };
  const STEPS36 = (on) => '<span class="sfn-steps">' + [['none', '미인정'], ['applied', '접수'], ['review', '심사'], ['certified', '인정']].map((s) => '<i' + (s[0] === on ? ' class="on"' : '') + '>' + s[1] + '</i>').join('') + '</span>';
  const SET_BTN36 = '<button type="button" class="sfn-go" data-sfn-set="1">고치기</button>';
  const HINT36 = '회사 구분(맨 위)은 회사별 상시근로자 수 두 칸을 다 넣은 뒤에 켜집니다.';

  // ① 설정 없음(운영 지금 — settings:safety 키가 없다) — 관리자형
  const A36 = ev36();
  T('v436 ① 설정 없음(운영 지금 — 저장값 없음, 관리자): ⑤ 줄 = KOSHA · 석면 · 등록 · 17행 · 18행 · KOSHA "위험성평가 인정" + 단계 표시(미인정만 칠함)·알약 "미인정(입력 전)"·"관리자가 단계·날짜를 넣기 전입니다" · 회사 구분 블록 없음(블록 순서 그대로 ①부터) · 석면 알약 "B 71.6 · 앱 반영 대기"(2026 결과 · 앱 적격 계산 등급 D · 다음 평가 시기 = 의무 대장 16행 문구 · 누르면 의무 대장) · 등록기준 "관리자교육 0/2명"·장비 6종 문구 · 17·18행 = 의무 대장 글(누르면 의무 대장) · 출처 "안전 설정 · 입력은 관리자" · 꼬리 회사 구분 안내 + [고치기] 1개',
    H36.rowIds32(A36.ev).join(',') === 'KOSHA,석면,등록,17행,18행' && title36(A36.ev, 'KOSHA') === '위험성평가 인정 ' + STEPS36('none') && pills36(A36.ev, 'KOSHA') === '-:미인정(입력 전)' && meta36(A36.ev, 'KOSHA') === '관리자가 단계·날짜를 넣기 전입니다'
    && H36.order32(A36.out) === 'check,jcb,due,con,eval,confirm' && A36.corp === ''
    && pills36(A36.ev, '석면') === 'am:B 71.6 · 앱 반영 대기' && title36(A36.ev, '석면') === '석면 안전성평가(종운건설) — 2026 결과'
    && meta36(A36.ev, '석면') === '앱 적격 계산 등급은 아직 D · 통보서를 반영할 때 입찰 카드·의무 대장 16행까지 한 번에 고칩니다 · 다음 평가 시기(의무 대장 16행): ' + seed36[16].cycle && row36(A36.ev, '석면').indexOf('data-sfn-go="duty"') > 0
    && pills36(A36.ev, '등록') === 'am:관리자교육 0/2명' && meta36(A36.ev, '등록').indexOf(' · 장비 6종: ' + EQUIP36 + ' — 인력이 바뀌면 다시 확인') > 0
    && title36(A36.ev, '17행') === seed36[17].duty && title36(A36.ev, '18행') === seed36[18].duty && pills36(A36.ev, '17행') === '-:주기 문구' && row36(A36.ev, '18행').indexOf('data-sfn-go="duty"') > 0
    && A36.ev.indexOf('<div class="sfn-src">안전 설정 · 입력은 관리자</div>') > 0 && A36.ev.indexOf(HINT36) > 0 && (A36.ev.match(/data-sfn-set=/g) || []).length === 1 && A36.ev.indexOf(SET_BTN36) > 0,
    JSON.stringify({ ids: H36.rowIds32(A36.ev), kp: pills36(A36.ev, 'KOSHA'), kt: title36(A36.ev, 'KOSHA'), sp: pills36(A36.ev, '석면'), sm: meta36(A36.ev, '석면'), rp: pills36(A36.ev, '등록'), order: H36.order32(A36.out) }));

  // ② 회사 구분 — 두 칸이 다 있을 때만 맨 위 · 문턱 배지(5명 · 종운환경 20명)
  const K36base = { admin: false, me: { id: 'k2', dept: '운영부', rank: '사원' }, perm: { safety: 'do', check: 'do', lic: 'view', con: 'do', site: 'hide', doc: 'view', wk: 'view' } };
  const C36 = (env, con, o) => ev36(Object.assign({ set: SET36({}, { env: env, con: con }) }, o || {}));
  const c1 = C36(18, ''), c2 = C36('', 4), c3 = C36(18, 4), c4 = C36(20, 5), c5 = C36(50, 49), c6 = C36(0, 0), c7 = C36(19, 4), c8 = C36('18', 4), c9 = C36(18, 4, { st: { edu: 'ok', asb: 'ok', set: 'fail' } }), c10 = C36(18, 4, K36base);
  //   알약은 짧게(폰 375px — 알약은 줄바꿈 없음), 뜻·조문은 메타 줄
  const M5a36 = '중대재해처벌법·정기교육 적용(상시 5명 이상)', M5b36 = '중대재해처벌법·정기교육 제외(상시 5명 미만 — 특별교육은 적용)', M20a36 = '안전보건관리담당자 선임 대상(폐기물 수집·운반업 20~49명)', M20b36 = '안전보건관리담당자는 20명부터(폐기물 수집·운반업)', M50_36 = '50명 이상 — 안전관리 인력 선임 기준 다시 확인';
  T('v436 ② 회사 구분(맨 위 — 회사별 상시근로자 수 두 칸이 다 있을 때만): 한 칸만(18·빈칸 / 빈칸·4)·숫자 글("18")·설정 읽기 실패 = 블록 없음(⑤ 꼬리에 켜는 안내 — 읽기 실패면 두 칸 옛 값이 있어도) · 두 칸(18·4) = 맨 위 블록(순서 corp → ① …)·줄 종운환경·종운건설 "상시근로자 n명" · 문턱 배지(짧은 알약 + 메타 뜻): 5명(중처법·정기교육) 이상 am "5명↑ 중처법 적용"·미만 회색 "5명 미만" / 종운환경만 20명(안전보건관리담당자) — 19까지 알약 없이 메타 "20명부터"·20~49 am "20명↑ 담당자 선임"·50 이상 bad "50명↑ 기준 확인" / 0·0도 켜짐 · 켜지면 ⑤ 꼬리 안내 없음 · 근거 조문 꼬리 · 권민지형(비관리자)도 같은 블록',
    [c1, c2, c8, c9].every((x) => x.corp === '' && H36.order32(x.out).indexOf('corp') < 0) && c1.ev.indexOf(HINT36) > 0 && c9.ev.indexOf(HINT36) > 0
    && H36.order32(c3.out) === 'corp,check,jcb,due,con,eval,confirm' && H36.rowIds32(c3.corp).join(',') === '종운환경,종운건설' && title36(c3.corp, '종운환경') === '상시근로자 18명' && title36(c3.corp, '종운건설') === '상시근로자 4명'
    && pills36(c3.corp, '종운환경') === 'am:5명↑ 중처법 적용' && meta36(c3.corp, '종운환경') === M5a36 + ' · ' + M20b36 && pills36(c3.corp, '종운건설') === '-:5명 미만' && meta36(c3.corp, '종운건설') === M5b36 && c3.ev.indexOf(HINT36) < 0
    && pills36(c4.corp, '종운환경') === 'am:5명↑ 중처법 적용|am:20명↑ 담당자 선임' && meta36(c4.corp, '종운환경') === M5a36 + ' · ' + M20a36 && pills36(c4.corp, '종운건설') === 'am:5명↑ 중처법 적용' && meta36(c4.corp, '종운건설') === M5a36
    && pills36(c5.corp, '종운환경') === 'am:5명↑ 중처법 적용|bad:50명↑ 기준 확인' && meta36(c5.corp, '종운환경') === M5a36 + ' · ' + M50_36 && pills36(c5.corp, '종운건설') === 'am:5명↑ 중처법 적용'
    && pills36(c6.corp, '종운환경') === '-:5명 미만' && meta36(c6.corp, '종운환경') === M5b36 + ' · ' + M20b36 && title36(c6.corp, '종운건설') === '상시근로자 0명'
    && pills36(c7.corp, '종운환경') === 'am:5명↑ 중처법 적용' && meta36(c7.corp, '종운환경') === M5a36 + ' · ' + M20b36
    && c10.corp === c3.corp && c3.corp.indexOf('산업안전보건법 시행령 제24조') > 0 && c3.corp.indexOf('중대재해처벌법 제3조') > 0 && c3.corp.indexOf('<div class="sfn-src">안전 설정의 회사별 상시근로자 수</div>') > 0,
    JSON.stringify({ order: H36.order32(c3.out), p: [pills36(c3.corp, '종운환경'), pills36(c4.corp, '종운환경'), pills36(c5.corp, '종운환경'), pills36(c6.corp, '종운환경')], m: [meta36(c3.corp, '종운환경'), meta36(c3.corp, '종운건설')], off: [c1, c2, c8, c9].map((x) => x.corp.length) }));

  // ③ KOSHA 인정 줄 — 단계·날짜·만료 90일 경고(오늘 2026-11-10)
  const k1 = ev36({ set: SET36({ stage: 'none' }) });
  const k2 = ev36({ set: SET36({ stage: 'applied', apply_no: 'K-2026-0001', applied_on: '2026-11-12' }) });
  const k3 = ev36({ set: SET36({ stage: 'review', applied_on: '2026-11-12', review_on: '2026-12-01' }) });
  const k4 = ev36({ set: SET36({ stage: 'certified', decided_on: '2024-01-09', expires_on: addD36(TD36, 60), checks: [{ date: '2025-03-01', note: '적합' }, { date: '2026-03-02', note: '' }], rate_year: '2027' }), setDay: '2026-11-10', setBy: 'a2' });
  const k5 = ev36({ set: SET36({ stage: 'certified', expires_on: addD36(TD36, 90) }) }), k6 = ev36({ set: SET36({ stage: 'certified', expires_on: addD36(TD36, 91) }) });
  const k7 = ev36({ set: SET36({ stage: 'certified', expires_on: '2026-11-01' }) }), k8 = ev36({ set: SET36({ stage: 'certified' }) });
  const k9 = ev36({ set: SET36({ stage: 'applied', apply_no: '<b>x</b>', expires_on: addD36(TD36, 30) }) });   // 재인정 접수 중에도 옛 인정 만료 경고 · 접수번호 글자는 이스케이프
  //   (v436 검토 반영) 만료 당일(D-0)은 아직 인정(ok)·경고 am · 만료가 지난 인정은 단계 알약을 초록으로 두지 않음(am) · 결정일 글은 인정일 때만 '인정', 그 밖(불인정 뒤 미인정·심사 중)은 '결정'
  const k10 = ev36({ set: SET36({ stage: 'certified', expires_on: TD36 }) }), k11 = ev36({ set: SET36({ stage: 'none', decided_on: '2026-12-01' }) }), k12 = ev36({ set: SET36({ stage: 'review', decided_on: '2026-12-01', expires_on: '2026-11-01' }) });
  T('v436 ③ KOSHA 인정 줄: 저장한 미인정 = "미인정"(입력 전 아님) · 접수 = am "접수"·접수번호·접수일 · 심사 = am "심사"·접수일·심사일 · 인정 = ok "인정" + 만료 60일 "만료 D-60"(am)·90일 "만료 D-90"·91일 경고 없음·만료 당일 "만료 D-0"(인정 ok 그대로)·지남 = 인정 am(초록 아님) + "만료 지남"(bad)·만료일 없음 "만료일 미입력" · 결정일 = 인정이면 "인정 날짜"·미인정·심사면 "결정 날짜"(검토 반영) · 사후점검 2회(최근 날짜)·요율 반영 연도 · 단계 표시는 그 단계만 칠함 · 접수 중에도 만료 경고 · 글자 이스케이프 · 출처에 마지막 고침 날·사람',
    pills36(k1.ev, 'KOSHA') === '-:미인정' && title36(k1.ev, 'KOSHA') === '위험성평가 인정 ' + STEPS36('none') && meta36(k1.ev, 'KOSHA') === ''
    && pills36(k2.ev, 'KOSHA') === 'am:접수' && title36(k2.ev, 'KOSHA') === '위험성평가 인정 ' + STEPS36('applied') && meta36(k2.ev, 'KOSHA') === '접수번호 K-2026-0001 · 접수 2026-11-12'
    && pills36(k3.ev, 'KOSHA') === 'am:심사' && title36(k3.ev, 'KOSHA') === '위험성평가 인정 ' + STEPS36('review') && meta36(k3.ev, 'KOSHA') === '접수 2026-11-12 · 심사 2026-12-01'
    && pills36(k4.ev, 'KOSHA') === 'ok:인정|am:만료 D-60' && title36(k4.ev, 'KOSHA') === '위험성평가 인정 ' + STEPS36('certified') && meta36(k4.ev, 'KOSHA') === '인정 2024-01-09 · 만료 ' + addD36(TD36, 60) + ' · 사후점검 2회(최근 2026-03-02) · 요율 반영 2027년'
    && pills36(k5.ev, 'KOSHA') === 'ok:인정|am:만료 D-90' && pills36(k6.ev, 'KOSHA') === 'ok:인정' && pills36(k7.ev, 'KOSHA') === 'am:인정|bad:만료 지남' && pills36(k8.ev, 'KOSHA') === 'ok:인정' && meta36(k8.ev, 'KOSHA') === '만료일 미입력'
    && pills36(k9.ev, 'KOSHA') === 'am:접수|am:만료 D-30' && k9.ev.indexOf('&lt;b&gt;x&lt;/b&gt;') > 0 && k9.ev.indexOf('<b>x</b>') < 0
    && pills36(k10.ev, 'KOSHA') === 'ok:인정|am:만료 D-0' && meta36(k10.ev, 'KOSHA') === '만료 ' + TD36
    && pills36(k11.ev, 'KOSHA') === '-:미인정' && meta36(k11.ev, 'KOSHA') === '결정 2026-12-01' && pills36(k12.ev, 'KOSHA') === 'am:심사|bad:만료 지남' && meta36(k12.ev, 'KOSHA') === '결정 2026-12-01 · 만료 2026-11-01'
    && k4.ev.indexOf('<div class="sfn-src">안전 설정 · 마지막 고침 2026-11-10 관리자2 · 입력은 관리자</div>') > 0,
    JSON.stringify([k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12].map((x) => pills36(x.ev, 'KOSHA') + ' / ' + meta36(x.ev, 'KOSHA'))));

  // ④ 석면·등록기준·의무 대장 줄 — 사람별(의무 대장 글은 인허가 권한 + 그 행 공개범위) · 관리자교육 이수자 수
  const KJ36 = { admin: false, me: { id: 'j1', dept: '운영부' }, perm: { safety: 'view', site: 'do', lic: 'do', check: 'do', con: 'do', doc: 'view', wk: 'do' }, licenses: [{ id: 'lseed13', name: '석면해체·제거업' }, { id: 'lseed07', name: '화물자동차 운송사업' }, { id: 'lseed11', name: '발전사업 허가(태양광)' }, { id: 'lseed08', name: '유해화학물질 운반업' }] };
  //   p3 = 안전만(인허가 권한 없음) + 공개범위 없는 인허가 행 — 공개범위가 아니라 인허가 권한 판정으로 의무 대장 글이 빠지는지(공개범위 걸린 표본이면 권한 판정을 빼도 숨어 못 잡는다 — 결함 심기 1회차)
  const p1 = ev36(K36base), p2 = ev36(KJ36), p3 = ev36({ admin: false, me: { id: 'k2' }, perm: { safety: 'do' }, licenses: KJ36.licenses });
  const p4 = ev36({ licOk: false, colBase: { checklist: 1, contracts: 1 }, duties: [] }), p5 = ev36({ dutyThrow: true });
  const MG36 = [{ id: 'g1', ptype: 'member', pid: 'a2', kind: 'manager', date: '2020-05-01', next: '' }, { id: 'g2', ptype: 'member', pid: 'a2', kind: 'manager', date: '2021-05-01', next: '' }, { id: 'g3', ptype: 'member', pid: 'k2', kind: 'manager', date: '2022-05-01', next: '' },
    { id: 'g4', ptype: 'member', pid: 'r1', kind: 'manager', date: '2019-05-01', next: '' }, { id: 'g5', ptype: 'worker', pid: 'w2', kind: 'manager', date: '2019-05-01', next: '' }, { id: 'g6', ptype: 'member', pid: 'j1', kind: 'manager', date: '2019-05-01', next: '', del: 1 }, { id: 'g7', ptype: 'member', pid: 'j1', kind: 'special', date: '2019-05-01', next: '' }];
  const g2 = ev36({ edu: MG36 }), g1 = ev36({ edu: MG36.filter((x) => x.pid === 'a2') }), g0 = ev36({ edu: [] }), gw = ev36({ st: { edu: 'wait', asb: 'ok', set: 'ok' } }), gf = ev36({ st: { edu: 'fail', asb: 'ok', set: 'ok' } });
  //   (v436 검토 반영) 명부에 있는 일용직(w1 김일용)의 관리자교육 기록 — n/2명(ok 판정)은 직원만, 일용직은 메타에 '세지 않음'(직원 1 + 일용직 1이 '2/2명' ok로 보이지 않게)
  const GW36 = { id: 'g8', ptype: 'worker', pid: 'w1', kind: 'manager', date: '2020-01-01', next: '' }, GW2_36 = { id: 'g9', ptype: 'worker', pid: 'w1', kind: 'manager', date: '2021-01-01', next: '' };
  const g1w = ev36({ edu: MG36.filter((x) => x.pid === 'a2').concat([GW36, GW2_36]) }), g2w = ev36({ edu: MG36.concat([GW36]) });
  const MGM36 = '교육·검진의 석면해체·제거관리자교육 이수 직원(사람 수 — 자격 요건은 따로 확인)', MGW36 = ' · 일용직 이수자 1명은 세지 않음(전담 인력에 넣을지는 따로 확인)';
  T('v436 ④ 석면·등록기준·의무 대장 줄: 권민지형(안전 수행·인허가 보기 — 석면해체·제거업 행이 관리자 공개범위) = ⑤ 줄 KOSHA·석면·등록뿐·"의무 대장"·"다음 평가 시기" 0·석면 줄 누를 곳 없음·[고치기] 0 · 김정아형(안전 보기·인허가 수행·공개범위 없음) = 16행 다음 평가 시기·17·18행 보임·[고치기] 0 · 안전만(인허가 없음) = 의무 대장 글 0 · 인허가 아직 못 받음 = 17·18행 없음 · 의무 대장이 깨져도 ⑤ KOSHA·석면·등록 줄 그대로 · 관리자교육 이수자 = 직원 사람 수(같은 사람 기록 둘 = 1명 · 퇴사자·지운 일용직·지운 기록·다른 종류 빼고) 2 → "2/2명" ok · 1 → "1/2명" am · 직원 1 + 명부 일용직 1(기록 둘) = "1/2명" am(ok 아님)·메타 "일용직 이수자 1명은 세지 않음" · 직원 2 + 일용직 1 = "2/2명" ok·같은 메타 · 일용직 없으면 그 글 없음 · 기록 0건 "기록 없음" · 교육 읽는 중 "확인 중" · 실패 "불러오지 못함"(bad)',
    H36.rowIds32(p1.ev).join(',') === 'KOSHA,석면,등록' && p1.ev.indexOf('의무 대장') < 0 && p1.ev.indexOf('다음 평가 시기') < 0 && row36(p1.ev, '석면').indexOf('data-sfn-go') < 0 && p1.ev.indexOf('data-sfn-set') < 0 && meta36(p1.ev, '석면') === '앱 적격 계산 등급은 아직 D · 통보서를 반영할 때 함께 고칩니다'
    && H36.rowIds32(p2.ev).join(',') === 'KOSHA,석면,등록,17행,18행' && meta36(p2.ev, '석면').indexOf(' · 다음 평가 시기(의무 대장 16행): ' + seed36[16].cycle) > 0 && p2.ev.indexOf('data-sfn-set') < 0
    && H36.rowIds32(p3.ev).join(',') === 'KOSHA,석면,등록' && p3.ev.indexOf('의무 대장') < 0 && p3.ev.indexOf('data-sfn-set') < 0
    && H36.rowIds32(p4.ev).join(',') === 'KOSHA,석면,등록' && H36.rowIds32(p5.ev).join(',') === 'KOSHA,석면,등록' && p5.ev.indexOf('불러오지 못함') < 0
    && pills36(g2.ev, '등록') === 'ok:관리자교육 2/2명' && pills36(g1.ev, '등록') === 'am:관리자교육 1/2명' && pills36(g0.ev, '등록') === '-:기록 없음' && meta36(g0.ev, '등록').indexOf('교육·검진 기록을 넣기 전에는 이수자를 셀 수 없습니다') === 0
    && pills36(gw.ev, '등록') === '-:확인 중' && pills36(gf.ev, '등록') === 'bad:불러오지 못함'
    && meta36(g2.ev, '등록').indexOf(MGM36 + ' · 장비 6종: ') === 0 && meta36(g2.ev, '등록').indexOf('일용직') < 0
    && pills36(g1w.ev, '등록') === 'am:관리자교육 1/2명' && meta36(g1w.ev, '등록').indexOf(MGM36 + MGW36 + ' · 장비 6종: ') === 0
    && pills36(g2w.ev, '등록') === 'ok:관리자교육 2/2명' && meta36(g2w.ev, '등록').indexOf(MGM36 + MGW36 + ' · 장비 6종: ') === 0,
    JSON.stringify({ p1: H36.rowIds32(p1.ev), p2: H36.rowIds32(p2.ev), p4: H36.rowIds32(p4.ev), p5: H36.rowIds32(p5.ev), g: [pills36(g2.ev, '등록'), pills36(g1.ev, '등록'), pills36(g0.ev, '등록'), pills36(gw.ev, '등록'), pills36(gf.ev, '등록'), pills36(g1w.ev, '등록'), pills36(g2w.ev, '등록')], gm: [meta36(g1w.ev, '등록').slice(0, 90), meta36(g2.ev, '등록').slice(0, 60)] }));

  // ⑤ 설정 읽기 상태 — 기다림(다시 그림)·실패·기다림이 다함
  const W036 = { contracts: [], colBase: { checklist: 1, contracts: 1, licenses: 1 } };   // 계약 서류함 기다림 없음 — ⑤만 기다리게
  const s1 = ev36(Object.assign({ st: { edu: 'ok', asb: 'ok', set: 'wait' }, set: SET36({}, { env: 18, con: 4 }) }, W036)), s0 = ev36(W036);
  const s2 = ev36({ st: { edu: 'ok', asb: 'ok', set: 'fail' }, set: SET36({ stage: 'certified' }, { env: 18, con: 4 }) });
  const s3 = H36.run32(H36.base32(Object.assign({ duties: dut36, st: { edu: 'ok', asb: 'ok', set: 'wait' } }, W036))); s3.api.setTicks(s3.api.max()); const s3ev = H36.blk32(s3.api.render(), 'eval');
  T('v436 ⑤ 설정 읽기 상태: 읽는 중 = KOSHA 줄 "불러오는 중…"·1초 뒤 다시 그림(기다리는 것이 ⑤뿐인 표본 — 다 받으면 타이머 0)·회사 구분 없음(두 칸이 있어도)·[고치기] 없음 · 실패 = KOSHA 줄 "불러오지 못함"·"현황 칸을 다시 열면 새로 읽습니다"·회사 구분·[고치기] 없음(관리자여도) · 기다림이 다하면(90번) 실패와 같음 · 석면·등록 줄은 그대로',
    pills36(s1.ev, 'KOSHA') === '-:불러오는 중…' && s1.r.timers.join(',') === '1000' && s0.r.timers.length === 0 && s1.corp === '' && s1.ev.indexOf('data-sfn-set') < 0 && H36.rowIds32(s1.ev).join(',') === 'KOSHA,석면,등록,17행,18행'
    && pills36(s2.ev, 'KOSHA') === 'bad:불러오지 못함' && meta36(s2.ev, 'KOSHA') === '현황 칸을 다시 열면 새로 읽습니다' && s2.corp === '' && s2.ev.indexOf('data-sfn-set') < 0 && title36(s2.ev, 'KOSHA') === 'KOSHA 위험성평가 인정(안전 설정)'
    && pills36(s3ev, 'KOSHA') === 'bad:불러오지 못함' && pills36(s2.ev, '석면') === 'am:B 71.6 · 앱 반영 대기' && pills36(s2.ev, '등록') === 'am:관리자교육 0/2명',
    JSON.stringify({ s1: [pills36(s1.ev, 'KOSHA'), s1.r.timers, s0.r.timers], s2: pills36(s2.ev, 'KOSHA'), s3: pills36(s3ev, 'KOSHA') }));

  // ⑥ @safety-set 실행 — 구간 원문을 가짜 문서·gwCall(동기 약속)로 돌린다: 읽기 · 창 채우기 · 저장(200·409 새로 읽기·NO_CHANGE·값 오류·연타·네트워크) · 창 값 검사(서버와 같은 규칙)
  const ssA36 = html.indexOf('// @safety-set-start'), ssB36 = html.indexOf('// @safety-set-end');
  if (ssA36 < 0 || ssB36 < ssA36 || html.indexOf('// @safety-set-start', ssA36 + 5) >= 0 || html.indexOf('// @safety-set-end', ssB36 + 5) >= 0) throw new Error('@safety-set 구간 표식이 없거나 두 번');
  const ssSec36 = html.slice(ssA36, ssB36);
  const runSet36 = (o) => {
    const log = [], els = {};
    const el = (id) => { if (!els[id]) { const s = new Set(); els[id] = { id, value: '', textContent: '', classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) } }; } return els[id]; };
    const api = new Function('__o', '__log', '__el', [
      'var document = { getElementById: function(id){ return __el(id); } }; var __resp = (__o.resp || []).slice();',
      'function isAdmin(){ return !!__o.admin; } function canSee(m){ return m === "safety" ? __o.see !== false : true; }',
      'function alert(m){ __log.push("alert:" + m); } function gwToast(m, w){ __log.push("toast:" + m + (w ? ":warn" : "")); } function sfNowRefresh(){ __log.push("refresh"); }',
      'function __ok(v){ return { then: function(f){ var r = f(v); return (r && typeof r.then === "function") ? r : __ok(r); }, catch: function(){ return this; } }; }',
      'function __ng(e){ return { then: function(){ return __ng(e); }, catch: function(g){ return __ok(g(e)); } }; }',
      'function gwCall(fn, body){ __log.push("call:" + JSON.stringify(body)); var r = __resp.shift() || { status: 500, body: {} }; if (r.hang) return { then: function(){ return { catch: function(){} }; } }; if (r.net) return __ng(new Error("net")); return __ok(r); }',
      fn36(html, 'pad'), fn36(html, 'fmtDate'), fn36(html, 'isDate'),
      ssSec36,
      'return { load: loadSafetySet, open: sfSetOpen, save: sfSetSave, read: sfSetRead, st: function(){ return { set: sfSet, base: sfSetBase, day: sfSetDay, by: sfSetBy, saving: sfSetSaving }; } };'].join('\n'))(o, log, el);
    return { api, log, el, shown: () => el('sfSetBackdrop').classList.contains('show'), calls: () => log.filter((x) => x.indexOf('call:') === 0).map((x) => JSON.parse(x.slice(5))) };
  };
  const T1_36 = 1762700000000, T3_36 = 1762800000000, dayOf36 = (ms) => { const d = new Date(ms), p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const S1_36 = SET36({ stage: 'certified', apply_no: 'K-1', applied_on: '2023-10-01', review_on: '2023-11-01', decided_on: '2024-01-09', expires_on: '2027-01-08', rate_year: '2025', checks: [{ date: '2025-03-01', note: '적합' }, { date: '2026-03-02', note: '' }] }, { env: 18, con: 4 });
  const S3_36 = SET36({ stage: 'review', applied_on: '2026-11-12' }, { env: 30, con: 6 });
  const G1_36 = { status: 200, body: { status: 'OK', settings: S1_36, updated_at: T1_36, updated_by: 'a2', prev: null } };
  const x0 = runSet36({ admin: true, see: false }), xl0 = x0.api.load();
  const x1 = runSet36({ admin: true, resp: [G1_36, { status: 200, body: { status: 'OK', settings: S3_36, updated_at: T1_36 + 5, updated_by: 'a1' } }] });
  let xr1 = null; x1.api.load().then((v) => { xr1 = v; }); const xs1 = x1.api.st(); x1.api.open();
  const xf1 = ['sfSetStage', 'sfSetApplyNo', 'sfSetApplied', 'sfSetReview', 'sfSetDecided', 'sfSetExpires', 'sfSetRateYear', 'sfSetChecks', 'sfSetHeadEnv', 'sfSetHeadCon'].map((id) => x1.el(id).value).join('|');
  const xstamp1 = x1.el('sfSetStamp').textContent, xshow1 = x1.shown();
  x1.el('sfSetHeadEnv').value = '20'; x1.el('sfSetChecks').value = '2025-03-01 적합\n\n  2026-03-02   \n'; x1.api.save();
  const xc1 = x1.calls(), xs1b = x1.api.st();
  const WANT1_36 = { action: 'safety_settings_set', base: T1_36, kosha: { stage: 'certified', apply_no: 'K-1', applied_on: '2023-10-01', review_on: '2023-11-01', decided_on: '2024-01-09', expires_on: '2027-01-08', rate_year: '2025', checks: [{ date: '2025-03-01', note: '적합' }, { date: '2026-03-02', note: '' }] }, headcount: { env: 20, con: 4 } };
  const x2 = runSet36({ admin: true, resp: [G1_36, { status: 409, body: { status: 'CONFLICT', error_code: 'SAFETY_STALE' } }, { status: 200, body: { status: 'OK', settings: S3_36, updated_at: T3_36, updated_by: 'a3' } }] });
  x2.api.load(); x2.api.open(); x2.el('sfSetHeadEnv').value = '25'; x2.api.save();
  const x3 = runSet36({ admin: true, resp: [G1_36, { status: 409, body: { error_code: 'SAFETY_STALE' } }, { status: 500, body: {} }] }); x3.api.load(); x3.api.open(); x3.api.save();
  const x4 = runSet36({ admin: true, resp: [G1_36, { status: 400, body: { error_code: 'NO_CHANGE' } }] }); x4.api.load(); x4.api.open(); x4.api.save();
  const x5 = runSet36({ admin: true, resp: [G1_36, { status: 400, body: { error_code: 'BAD_DATE' } }] }); x5.api.load(); x5.api.open(); x5.api.save();
  const x6 = runSet36({ admin: false, resp: [G1_36] }); x6.api.load(); x6.api.open(); const x6show = x6.shown(); x6.api.save();
  const x8 = runSet36({ admin: true, resp: [G1_36, { hang: true }] }); x8.api.load(); x8.api.open(); x8.api.save(); x8.api.save();
  const x9 = runSet36({ admin: true, resp: [G1_36, { net: true }] }); x9.api.load(); x9.api.open(); x9.api.save();
  const NOW36 = '안전 설정은 관리자만 고칩니다(현황은 읽기 전용).';
  T('v436 ⑥ @safety-set 실행(읽기·창·저장): 안전 권한 없음 = 읽기 안 부름 · 읽기 200 = true·값·낙관락 토큰(updated_at)·마지막 고친 날·사람 · [고치기] 창 = 관리자만 열림·지금 값으로 채움(사후점검 한 줄에 "날짜 메모")·"마지막 고침 날" · 저장 = safety_settings_set 1번(base = 받은 updated_at · 빈 줄·앞뒤 공백 정리 · 인원 숫자) → 200이면 값·토큰 갱신·창 닫힘·"저장했습니다"·현황 다시 그림 · 409 = 새로 읽기(get) → 창을 새 값으로 채움·"다른 곳에서 먼저 고쳤습니다 — 새로 읽었습니다"(경고)·현황 다시 그림·창 그대로 · 409 뒤 새로 읽기 실패 = 알림 · NO_CHANGE = 창 닫힘·"바뀐 것이 없습니다" · 400 값 오류 = 이유 알림·창 그대로 · 비관리자 = 창 안 열림·저장 0 · 응답 기다리는 중 두 번째 저장 0 · 네트워크 실패 = 알림·저장 중 풀림',
    xl0 === undefined && x0.calls().length === 0
    && xr1 === true && JSON.stringify(xs1.set) === JSON.stringify(S1_36) && xs1.base === T1_36 && xs1.day === dayOf36(T1_36) && xs1.by === 'a2' && x1.calls()[0].action === 'safety_settings_get' && Object.keys(x1.calls()[0]).length === 1
    && xshow1 && xf1 === 'certified|K-1|2023-10-01|2023-11-01|2024-01-09|2027-01-08|2025|2025-03-01 적합\n2026-03-02|18|4' && xstamp1 === '마지막 고침 ' + dayOf36(T1_36)
    && xc1.length === 2 && JSON.stringify(xc1[1]) === JSON.stringify(WANT1_36) && JSON.stringify(xs1b.set) === JSON.stringify(S3_36) && xs1b.base === T1_36 + 5 && xs1b.by === 'a1' && !x1.shown() && x1.log.indexOf('toast:저장했습니다') >= 0 && x1.log.indexOf('refresh') >= 0 && xs1b.saving === false
    && x2.calls().map((c) => c.action).join(',') === 'safety_settings_get,safety_settings_set,safety_settings_get' && x2.calls()[1].base === T1_36 && x2.calls()[1].headcount.env === 25
    && x2.shown() && x2.el('sfSetStage').value === 'review' && x2.el('sfSetHeadEnv').value === '30' && x2.el('sfSetHeadCon').value === '6' && x2.api.st().base === T3_36 && x2.log.indexOf('toast:다른 곳에서 먼저 고쳤습니다 — 새로 읽었습니다:warn') >= 0 && x2.log.indexOf('refresh') >= 0
    && x3.log.indexOf('alert:다른 곳에서 먼저 고쳤는데 새 값을 읽지 못했습니다 — 창을 닫고 현황 칸을 다시 열어 주세요.') >= 0 && !x3.log.some((l) => l.indexOf('toast:') === 0) && x3.api.st().base === T1_36
    && !x4.shown() && x4.log.indexOf('toast:바뀐 것이 없습니다') >= 0
    && x5.shown() && x5.log.indexOf('alert:안전 설정 저장 실패 (날짜가 맞지 않습니다)') >= 0
    && !x6show && x6.log.filter((l) => l === 'alert:' + NOW36).length === 2 && x6.calls().length === 1
    && x8.calls().length === 2 && x8.api.st().saving === true
    && x9.log.indexOf('alert:안전 설정 저장 실패(네트워크) — 다시 시도해 주세요.') >= 0 && x9.api.st().saving === false,
    JSON.stringify({ xs1: [xr1, xs1.base, xs1.day, xs1.by], xf1, xstamp1, xc1, x2: [x2.calls().map((c) => c.action), x2.el('sfSetHeadEnv').value, x2.log], x3: x3.log, x4: x4.log, x5: x5.log, x6: [x6show, x6.log], x8: x8.calls().length, x9: x9.log }));
  //   ⑥-3 (v436 검토 반영) 409(새로 읽기 성공·실패)·400 값 오류·NO_CHANGE 뒤에도 다시 저장이 나가는지(저장 중 표시가 풀림 — MANUAL '새 값을 확인하고 다시 고쳐 저장하세요'·TESTLIST 낙관락 칸의 그 흐름)
  //        · 첫 읽기 실패(401 · 403 NO_ACCESS · 403 기기 미승인 · 500 · 몸체 없음 · 네트워크) = false·값 없음·토큰 0(성공으로 적으면 현황이 '미인정(입력 전)'과 [고치기]를 그린다) · 저장값 0명은 창에 '0'(빈칸 아님)
  const OK2_36 = (at) => ({ status: 200, body: { status: 'OK', settings: S3_36, updated_at: at, updated_by: 'a1' } });
  const r409_36 = runSet36({ admin: true, resp: [G1_36, { status: 409, body: { status: 'CONFLICT', error_code: 'SAFETY_STALE' } }, { status: 200, body: { status: 'OK', settings: S3_36, updated_at: T3_36, updated_by: 'a3' } }, OK2_36(T3_36 + 7)] });
  r409_36.api.load(); r409_36.api.open(); r409_36.el('sfSetHeadEnv').value = '25'; r409_36.api.save(); const r409s36 = r409_36.api.st().saving; r409_36.el('sfSetHeadEnv').value = '31'; r409_36.api.save();
  const r409f36 = runSet36({ admin: true, resp: [G1_36, { status: 409, body: { error_code: 'SAFETY_STALE' } }, { status: 500, body: {} }, OK2_36(T1_36 + 9)] });
  r409f36.api.load(); r409f36.api.open(); r409f36.api.save(); const r409fs36 = r409f36.api.st().saving; r409f36.api.save();
  const r400_36 = runSet36({ admin: true, resp: [G1_36, { status: 400, body: { error_code: 'BAD_DATE' } }, OK2_36(T1_36 + 3)] });
  r400_36.api.load(); r400_36.api.open(); r400_36.api.save(); const r400s36 = r400_36.api.st().saving; r400_36.api.save();
  const rNC36 = runSet36({ admin: true, resp: [G1_36, { status: 400, body: { error_code: 'NO_CHANGE' } }, OK2_36(T1_36 + 4)] });
  rNC36.api.load(); rNC36.api.open(); rNC36.api.save(); const rNCs36 = rNC36.api.st().saving; rNC36.api.open(); rNC36.el('sfSetHeadCon').value = '5'; rNC36.api.save();
  const lr36 = (resp) => { const x = runSet36({ admin: true, resp: [resp] }); let v = 'none'; const p = x.api.load(); if (p && typeof p.then === 'function') p.then((r) => { v = r; }); const s = x.api.st(); return v === false && s.set === null && s.base === 0 && s.day === '' && s.by === '' && x.calls().length === 1; };
  const LR36 = [['401', { status: 401, body: { status: 'UNAUTHORIZED', error_code: 'NO_SESSION' } }], ['403 NO_ACCESS', { status: 403, body: { status: 'FORBIDDEN', error_code: 'NO_ACCESS' } }], ['403 기기', { status: 403, body: { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED' } }],
    ['500', { status: 500, body: { status: 'ERROR', error_code: 'SETTINGS_INVALID' } }], ['몸체 없음', { status: 200, body: null }], ['네트워크', { net: true }]];
  const lrRes36 = LR36.map((x) => lr36(x[1]));
  const z36 = runSet36({ admin: true, resp: [{ status: 200, body: { status: 'OK', settings: SET36({}, { env: 0, con: '' }), updated_at: T1_36, updated_by: 'a2' } }] }); z36.api.load(); z36.api.open();
  T('v436 ⑥-3 다시 저장·첫 읽기 실패·0명(검토 반영): 409 → 새로 읽음 → 값을 고쳐 다시 저장 = 네 번째 요청 safety_settings_set(base = 새로 읽은 updated_at · 고친 인원)·"저장했습니다"·창 닫힘 · 409 뒤 새로 읽기 실패·400 값 오류·NO_CHANGE 뒤에도 저장 중 표시가 풀려 다시 저장 요청이 나감 · 첫 읽기 401·403 NO_ACCESS·403 기기 미승인·500·몸체 없음·네트워크 = false·sfSet null·토큰 0·마지막 고침 없음 · 저장값 0명 = 창에 "0"(빈칸 아님)·빈칸은 빈칸',
    r409s36 === false && r409_36.calls().map((c) => c.action).join(',') === 'safety_settings_get,safety_settings_set,safety_settings_get,safety_settings_set' && r409_36.calls()[3].base === T3_36 && r409_36.calls()[3].headcount.env === 31 && r409_36.calls()[3].headcount.con === 6
    && r409_36.log.indexOf('toast:저장했습니다') >= 0 && !r409_36.shown() && r409_36.api.st().saving === false && r409_36.api.st().base === T3_36 + 7
    && r409fs36 === false && r409f36.calls().length === 4 && r409f36.calls()[3].action === 'safety_settings_set' && r409f36.calls()[3].base === T1_36 && r409f36.log.indexOf('toast:저장했습니다') >= 0
    && r400s36 === false && r400_36.calls().length === 3 && r400_36.calls()[2].action === 'safety_settings_set' && r400_36.log.indexOf('toast:저장했습니다') >= 0
    && rNCs36 === false && rNC36.calls().length === 3 && rNC36.calls()[2].action === 'safety_settings_set' && rNC36.calls()[2].headcount.con === 5 && rNC36.log.indexOf('toast:저장했습니다') >= 0
    && lrRes36.every(Boolean) && z36.el('sfSetHeadEnv').value === '0' && z36.el('sfSetHeadCon').value === '',
    JSON.stringify({ s: [r409s36, r409fs36, r400s36, rNCs36], c409: r409_36.calls().map((c) => c.action + (c.base ? ':' + c.base : '')), n: [r409f36.calls().length, r400_36.calls().length, rNC36.calls().length], lr: LR36.map((x, i) => x[0] + ':' + lrRes36[i]), z: [z36.el('sfSetHeadEnv').value, z36.el('sfSetHeadCon').value] }));
  //   창 값 검사 — 서버 safetyClean과 같은 규칙(서버가 다시 본다): 하나씩 틀리게 넣으면 그 이유 알림·저장 요청 0
  const bad36 = [['sfSetHeadEnv', '-1', '상시근로자 수는 0~999 사이 정수로 넣거나 비워 두세요.'], ['sfSetHeadCon', '1000', '상시근로자 수는 0~999 사이 정수로 넣거나 비워 두세요.'], ['sfSetHeadEnv', '3.5', '상시근로자 수는 0~999 사이 정수로 넣거나 비워 두세요.'], ['sfSetHeadCon', 'abc', '상시근로자 수는 0~999 사이 정수로 넣거나 비워 두세요.'],
    ['sfSetRateYear', '27', '요율 반영 연도는 네 자리(예: 2027)로 넣거나 비워 두세요.'], ['sfSetRateYear', '1999', '요율 반영 연도는 네 자리(예: 2027)로 넣거나 비워 두세요.'], ['sfSetApplyNo', 'x'.repeat(41), '접수번호는 40자까지입니다.'],
    ['sfSetApplied', '2026-02-30', '날짜는 달력에서 고르거나 YYYY-MM-DD로 넣어 주세요.'], ['sfSetExpires', '20271108', '날짜는 달력에서 고르거나 YYYY-MM-DD로 넣어 주세요.'], ['sfSetStage', 'approved', '인정 단계를 고르세요.'],
    ['sfSetChecks', '공단 점검', "사후점검 이력은 한 줄에 '날짜 메모'(예: 2027-03-15 공단 사후점검 적합)로 넣어 주세요."], ['sfSetChecks', '2027-02-30 점검', "사후점검 이력은 한 줄에 '날짜 메모'(예: 2027-03-15 공단 사후점검 적합)로 넣어 주세요."],
    ['sfSetChecks', '2027-03-15 ' + 'x'.repeat(101), '사후점검 메모는 한 줄 100자까지입니다.'], ['sfSetChecks', Array.from({ length: 11 }, (_, i) => '2027-03-' + String(i + 10) + ' 점검').join('\n'), '사후점검 이력은 10건까지입니다.']];
  const badRes36 = bad36.map((b) => { const x = runSet36({ admin: true, resp: [G1_36] }); x.api.load(); x.api.open(); x.el(b[0]).value = b[1]; x.api.save(); return x.log.indexOf('alert:' + b[2]) >= 0 && x.calls().length === 1 && x.shown(); });
  const okE36 = runSet36({ admin: true, resp: [G1_36, { hang: true }] }); okE36.api.load(); okE36.api.open(); okE36.el('sfSetHeadEnv').value = ''; okE36.el('sfSetHeadCon').value = '0'; okE36.el('sfSetChecks').value = Array.from({ length: 10 }, (_, i) => '2027-03-' + String(i + 10) + ' 점검').join('\n'); okE36.api.save();
  const okC36 = okE36.calls()[1] || {};
  T('v436 ⑥-2 창 값 검사(서버와 같은 규칙 — 서버 safetyClean이 다시 봄): 인원 -1·1000·3.5·abc · 요율 연도 27·1999 · 접수번호 41자 · 날짜 2026-02-30·20271108 · 단계 approved · 사후점검 날짜 없는 줄·없는 날짜·메모 101자·11줄 = 그 이유 알림·저장 요청 0·창 그대로 / 빈칸·0명·10줄은 보냄(env "" · con 0 · checks 10)',
    badRes36.every(Boolean) && okC36.action === 'safety_settings_set' && okC36.headcount && okC36.headcount.env === '' && okC36.headcount.con === 0 && okC36.kosha.checks.length === 10,
    JSON.stringify({ bad: bad36.map((b, i) => b[0] + '=' + b[1].slice(0, 12) + ':' + badRes36[i]), ok: okC36.headcount }));

  // ⑥-4 (v436 검토 반영) 한 기기 사람 전환 — 로그인 창 '전환'은 새로고침 없이 afterLogin → applyPerms → applySafetyPerms만 돈다(render()에 현황이 없다).
  //      실제 safetyPanes·setSafetyLayer·applySafetyPerms를 돌려, 현황 칸에 있었고 다음 사람도 현황을 볼 수 있으면 현황을 다시 여는지(sfNowOpen 1번 — 관리자 [고치기]·공개범위 줄이 앞사람 권한으로 남지 않게)
  const mkCl36 = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); return s.has(c); }, contains: (c) => s.has(c) }; };
  const swRun36 = (perm, cur, layer) => {
    const els = {}, log = [];
    const el = (id) => els[id] || (els[id] = { id, classList: mkCl36(), style: {}, getAttribute: () => null, querySelectorAll: () => [] });
    new Function('__el', '__perm', '__log', '__cur', '__layer', [
      'var document = { getElementById: function(id){ return __el(id); } };',
      'var currentTab = __cur, safetyLayer = __layer, eduViewScope = "member";',
      'function canSee(m){ return __perm === "admin" || (__perm[m] || "hide") !== "hide"; }',
      'function switchTab(n){ __log.push("switch:" + n); currentTab = n; }',
      'function renderSites(){ __log.push("renderSites"); } function loadAsb(){} function loadEdu(){} function loadWorkers(){ return { then: function(){} }; } function renderEdu(){ __log.push("renderEdu"); } function sfNowOpen(){ __log.push("sfNowOpen"); }',
      fn36(html, 'safetyPanes'), fn36(html, 'setSafetyLayer'), fn36(html, 'applySafetyPerms'),
      'applySafetyPerms(); __log.push("at:" + safetyLayer + "@" + currentTab);'].join('\n'))(el, perm, log, cur, layer);
    return log.join(',');
  };
  const swK36 = swRun36({ safety: 'do', lic: 'view' }, 'safety', 'now'), swA36 = swRun36('admin', 'safety', 'now'), swV36 = swRun36({ safety: 'view', site: 'do' }, 'safety', 'now');
  const swE36 = swRun36({ safety: 'do' }, 'safety', 'edu'), swS36 = swRun36('admin', 'safety', 'site'), swD36 = swRun36({ safety: 'do' }, 'dash', 'now'), swJ36 = swRun36({ site: 'do' }, 'safety', 'now'), swN36 = swRun36({ veh: 'view' }, 'safety', 'now');
  T('v436 ⑥-4 한 기기 사람 전환(실제 applySafetyPerms — 검토 반영): 현황 칸에 있었고 다음 사람이 현황을 볼 수 있으면(권민지형·관리자·김정아형 안전 보기) 현황을 다시 엶(sfNowOpen 1번 · 칸 그대로) · 교육·현장 칸이면 다시 열지 않음 · 홈이면 0 · 현황을 못 보는 사람(현장만) = 현장 칸으로(종전) · 아무 칸도 없음 = 홈(종전)',
    swK36 === 'sfNowOpen,at:now@safety' && swA36 === 'sfNowOpen,at:now@safety' && swV36 === 'sfNowOpen,at:now@safety'
    && swE36 === 'at:edu@safety' && swS36 === 'at:site@safety' && swD36 === 'at:now@dash' && swJ36 === 'renderSites,at:site@safety' && swN36 === 'switch:dash,at:now@dash',
    [swK36, swA36, swV36, swE36, swS36, swD36, swJ36, swN36].join(' | '));

  // ⑦ 정적 — 앱: 현황 구간은 저장·서버 호출 0 그대로([고치기]는 버튼 글만 — 관리자·읽기 ok일 때) · 누름 배선은 구간 밖 #sfNowHost 위임 1곳 · 서버 액션 글자는 @safety-set 구간에만 · 창·저장 함수 첫 줄 관리자 가드
  //          서버: 분기 1곳씩 · 읽기 검사 순서(로그인 → 기기 승인 → permKey 'safety' 숨김 NO_ACCESS → 읽기) · 쓰기 순서(로그인 → 관리자 → 값 검사 → 읽기 → 낙관락 → 같은 값 → 저장 → 감사) · permKey = permOf와 같은 규칙(safety 기본 숨김)
  //          범위: 인허가 코드(앱·서버·물어보기·브리핑·크론)에 kosha_cert 0 · settings:safety 글자는 gw-data.js 한 곳(코드 1줄 — 이 키 이름을 쓰는 서버 코드는 safetyRead·쓰기 핸들러뿐, 백업 내보내기·복원은 키 이름 없이 gw_data 키 전부를 다룸) · 인허가 소비처에 안전 설정 흔적 0 · 앱↔서버 단계·한도 같음
  const nc36 = (s) => s.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
  const htmlNC36 = nc36(html), gd36 = rd36('netlify/functions/gw-data.js'), gdNC36 = nc36(gd36);
  const sA36 = html.indexOf('// @safety-now-start'), sB36 = html.indexOf('// @safety-now-end'), secNC36 = nc36(html.slice(sA36, sB36)), ssNC36 = nc36(ssSec36);
  const walk36 = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? (d.name === 'node_modules' || d.name === '_models' ? [] : walk36(join(dir, d.name))) : (/\.(js|mjs|ts)$/.test(d.name) ? [join(dir, d.name)] : []));
  const srv36 = walk36(join(ROOT, 'netlify'));
  const kc36 = [join(ROOT, 'index.html')].concat(srv36).filter((p) => readFileSync(p, 'utf8').indexOf('kosha_cert') >= 0).map((p) => p.slice(ROOT.length + 1));
  const ssKey36 = srv36.filter((p) => readFileSync(p, 'utf8').indexOf('settings:safety') >= 0).map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'));
  const hG36 = fn36(gd36, 'handleSafetySettingsGet'), hS36 = fn36(gd36, 'handleSafetySettingsSet'), sR36 = fn36(gd36, 'safetyRead'), pK36 = fn36(gd36, 'permKey');
  const ix36 = (s, t) => s.indexOf(t);
  const ordG36 = [ix36(hG36, 'await currentMember(event)'), ix36(hG36, "error_code: 'DEVICE_NOT_APPROVED'"), ix36(hG36, "if (permKey(c.member, 'safety') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });"), ix36(hG36, 'await safetyRead(store(DATA))')];
  const ordS36 = [ix36(hS36, 'await currentMember(event)'), ix36(hS36, "if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });"), ix36(hS36, 'const nv = safetyClean(d);'), ix36(hS36, 'const cur = await safetyRead(st);'),
    ix36(hS36, "if (d.base === undefined || Number(d.base) !== cur.at) return jr(409, { status: 'CONFLICT', error_code: 'SAFETY_STALE', request_id: R });"), ix36(hS36, "error_code: 'NO_CHANGE'"), ix36(hS36, 'await blobSet(st, SAFETY_KEY, doc)'), ix36(hS36, "col: 'safety', ev: [{ op: '안전설정'")];
  const inc36 = (a) => a.every((v, i) => v > 0 && (i === 0 || v > a[i - 1]));
  const srvStages36 = (gd36.match(/const SAFETY_STAGES = \[([^\]]+)\];/) || ['', ''])[1].replace(/\s/g, ''), appStages36 = (html.match(/var SF_SET_STAGES = \[([^\]]+)\];/) || ['', ''])[1].replace(/\s/g, '').replace(/"/g, "'");
  const kosha36 = [...(html.match(/var SF_NOW_KOSHA = \[([^;]+)\];/) || ['', ''])[1].matchAll(/\["(\w+)", "([^"]+)"\]/g)].map((m) => m[1] + ':' + m[2]).join(',');
  const lim36 = (gd36.match(/const SAFETY_LIMIT = \{ apply_no: (\d+), note: (\d+), checks: (\d+), head: (\d+) \};/) || []).slice(1).join(',');
  const rdF36 = fn36(html, 'sfSetRead'), opF36 = fn36(html, 'sfSetOpen'), svF36 = fn36(html, 'sfSetSave'), ldF36 = fn36(html, 'loadSafetySet');
  const licFns36 = ['renderLicenses', 'calEvents', 'licVisible', 'liveLic', 'renderDashboard'].map((f) => fn36(html, f)).join('\n');
  const deleg36 = (htmlNC36.match(/document\.getElementById\("sfNowHost"\)\.addEventListener\("click", function\(e\)\{\n\s*var t = e\.target;\n\s*while \(t && t !== this\)\{ if \(t\.getAttribute && t\.getAttribute\("data-sfn-set"\) !== null\)\{ sfSetOpen\(\); return; \} t = t\.parentNode; \}\n\s*\}\);/g) || []).length;
  T('v436 ⑦ 정적: 현황 구간 = 저장·서버 호출·창 함수 부름·안전 설정 상태 대입 0 · 첫 상태(sfNowSt.set "" · sfSet null · base 0) · [고치기]는 버튼 글 1곳(설정 읽기 ok + 관리자일 때만) · 누름 배선 = 구간 밖 #sfNowHost 위임 1곳(sfSetOpen) · 저장·취소 버튼 배선 · 서버 액션 글자(safety_settings_get·set)는 @safety-set 구간에만 1번씩 · sfSetOpen·sfSetSave 첫 줄 관리자 가드·저장은 base 동봉 · 읽기는 안전 권한만 / 서버: 분기 1곳씩 · 읽기 순서 로그인 → 기기 승인 → 안전 숨김 NO_ACCESS → 읽기 · 쓰기 순서 로그인 → 관리자 → 값 검사 → 읽기 → 낙관락(base 없음도 409) → 같은 값 → 저장 → 감사(col safety) · permKey = permOf 규칙(safety 기본 숨김) · 이 키는 safetyRead(읽기)·쓰기 핸들러(저장)에서만 / 범위: kosha_cert 0(앱·netlify 전부) · settings:safety = gw-data.js 한 곳(코드 1줄) · 인허가 소비처(renderLicenses·calEvents·licVisible·liveLic·renderDashboard)에 안전 설정 흔적 0 · 단계 앱 = 서버 = 현황 표시 · 한도 40·100·10·999 앱 = 서버',
    !/\bgwCall\b|\bsfSet(?:Open|Save|Close|Fill|Read|Apply)\b|\bsfSet(?:Base|Day|By|Saving)?\s*=(?!=)|safety_settings_/.test(secNC36) && (secNC36.match(/data-sfn-set/g) || []).length === 1 && /\(ss === "ok" && isAdmin\(\) \? ' <button type="button" class="sfn-go" data-sfn-set="1">고치기<\/button>' : ""\)/.test(secNC36)
    && deleg36 === 1 && (htmlNC36.match(/data-sfn-set/g) || []).length === 2 && (htmlNC36.match(/(?<!function )\bsfSetOpen\(\)/g) || []).length === 1
    && /document\.getElementById\("sfSetSave"\)\.addEventListener\("click", sfSetSave\);/.test(htmlNC36) && /document\.getElementById\("sfSetCancel"\)\.addEventListener\("click", sfSetClose\);/.test(htmlNC36)
    && (htmlNC36.match(/safety_settings_get/g) || []).length === 1 && (htmlNC36.match(/safety_settings_set/g) || []).length === 1 && (ssNC36.match(/safety_settings_(?:get|set)/g) || []).length === 2
    && /^function sfSetOpen\(\)\{\n\s*if \(!isAdmin\(\)\)\{ alert\(SF_SET_NO_WRITE\); return; \}/.test(opF36) && /^function sfSetSave\(\)\{\n\s*if \(!isAdmin\(\)\)\{ alert\(SF_SET_NO_WRITE\); return; \}/.test(svF36) && /action: "safety_settings_set", base: sfSetBase, kosha: f\.v\.kosha, headcount: f\.v\.headcount/.test(svF36)
    && /^function loadSafetySet\(\)\{\n\s*if \(!canSee\("safety"\)\) return;/.test(ldF36)
    && /var sfNowSt = \{ edu: "", asb: "", set: "" \}/.test(secNC36) && /var sfSet = null, sfSetBase = 0, sfSetDay = "", sfSetBy = "", sfSetSaving = false;/.test(ssNC36)   // 첫 상태 = 아직 안 읽음(""→ 기다림) — "ok"로 시작하면 읽기 전에 '미인정(입력 전)'을 그린다(시험 틀은 상태를 덮어써 실행으로는 못 잡음)
    && (gd36.match(/d\.action === 'safety_settings_get'\) return await handleSafetySettingsGet\(event, d, R\);/g) || []).length === 1 && (gd36.match(/d\.action === 'safety_settings_set'\) return await handleSafetySettingsSet\(event, d, R\);/g) || []).length === 1
    && inc36(ordG36) && inc36(ordS36) && !/blobSet|appendAudit/.test(hG36)
    && /if \(member\.admin\) return 'do';\s*return \(member\.perms && member\.perms\[key\]\) \|\| \(PERM_CLOSED\[key\] \? 'hide' : 'view'\);/.test(pK36) && /const PERM_CLOSED = \{[^}]*\bsafety: 1\b/.test(gd36)
    && (gdNC36.match(/SAFETY_KEY/g) || []).length === 4 && /blobGet\(st, SAFETY_KEY\)/.test(sR36) && (gdNC36.match(/blobGet\(st, SAFETY_KEY\)/g) || []).length === 1 && (gdNC36.match(/blobSet\(st, SAFETY_KEY, doc\)/g) || []).length === 1 && (gdNC36.match(/\bsafetyRead\(/g) || []).length === 3
    && kc36.length === 0 && ssKey36.join(',') === 'netlify/functions/gw-data.js' && (gdNC36.match(/settings:safety/g) || []).length === 1
    && !/sfSet|safety_settings|settings:safety|kosha/i.test(licFns36)
    && srvStages36 === "'none','applied','review','certified'" && appStages36 === srvStages36 && kosha36 === 'none:미인정,applied:접수,review:심사,certified:인정' && lim36 === '40,100,10,999'
    && /k\.apply_no\.length > 40/.test(rdF36) && /lines\.length > 10/.test(rdF36) && /\.length > 100\)/.test(rdF36) && /\/\^\\d\{1,3\}\$\//.test(rdF36),
    JSON.stringify({ deleg: deleg36, set: (htmlNC36.match(/data-sfn-set/g) || []).length, ordG: ordG36, ordS: ordS36, keyN: (gdNC36.match(/SAFETY_KEY/g) || []).length, kc: kc36, ssKey: ssKey36, st: [srvStages36, appStages36, kosha36], lim: lim36 }));

  // ⑧ CSS·창 마크업·감사 라벨
  const divB36 = (src, openTag) => { const i = src.indexOf(openTag); if (i < 0) return ''; const re = /<div\b|<\/div>/g; re.lastIndex = i; let d = 0, m; while ((m = re.exec(src))) { d += m[0] === '</div>' ? -1 : 1; if (d === 0) return src.slice(i, m.index + 6); } return ''; };
  const mod36 = divB36(html, '<div class="modal-backdrop" id="sfSetBackdrop">');
  const opts36 = [...(mod36.match(/<select id="sfSetStage">([\s\S]*?)<\/select>/) || ['', ''])[1].matchAll(/<option value="(\w+)">([^<]+)<\/option>/g)].map((m) => m[1] + ':' + m[2]).join(',');
  //   (v436 검토 반영) 감사 기록 화면의 바뀐 칸 라벨 — 앱 AUDIT_FIELD_LABEL의 kosha.*·headcount.* 10개 = 서버 SAFETY_FIELD_LABEL(같은 순서·같은 글). 없으면 감사 화면에 영어 경로가 그대로 나왔다
  const srvLab36 = [...((gd36.match(/const SAFETY_FIELD_LABEL = \{([\s\S]*?)\};/) || ['', ''])[1]).matchAll(/'((?:kosha|headcount)\.\w+)': '([^']+)'/g)].map((m) => m[1] + '=' + m[2]);
  const appLab36 = [...((html.match(/var AUDIT_FIELD_LABEL = \{([^;]*?)\};/) || ['', ''])[1]).matchAll(/"((?:kosha|headcount)\.\w+)":"([^"]+)"/g)].map((m) => m[1] + '=' + m[2]);
  const flatKeys36 = [...((fn36(gd36, 'safetyFlat').match(/return \{([\s\S]*?)\};/) || ['', ''])[1]).matchAll(/'((?:kosha|headcount)\.\w+)':/g)].map((m) => m[1]);
  T('v436 ⑧ CSS·창: .sfn-pills(알약 여럿 세로 — 오른쪽 정렬)·.sfn-steps(단계 표시, 지금 단계만 칠함) · 창 #sfSetBackdrop(.modal-backdrop — 1개) = 단계 고르기 미인정·접수·심사·인정 · 접수번호 40자 · 날짜 4칸(type=date — 접수·심사·인정·만료) · 요율 연도 4자 · 사후점검 여러 줄 · 인원 두 칸(3자·숫자 자판) · 저장·취소 · 마지막 고침 줄 · 감사 기록 화면 라벨 safety = 안전 설정 · 바뀐 칸 라벨 10개 앱 = 서버(검토 반영 — 서버 감사 칸 = safetyFlat 칸과도 같음)',
    html.indexOf('  .sfn-pills{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:3px;}') > 0 && html.indexOf('  .sfn-steps i.on{background:var(--brand);color:#fff;}') > 0 && html.indexOf('  .sfn-steps{display:inline-flex;flex-wrap:wrap;') > 0
    && mod36.length > 500 && html.split('id="sfSetBackdrop"').length === 2 && opts36 === 'none:미인정,applied:접수,review:심사,certified:인정'
    && /<input type="text" id="sfSetApplyNo"[^>]*maxlength="40"/.test(mod36) && ['sfSetApplied', 'sfSetReview', 'sfSetDecided', 'sfSetExpires'].every((id) => new RegExp('<input type="date" id="' + id + '">').test(mod36))
    && /<input type="text" id="sfSetRateYear"[^>]*maxlength="4"/.test(mod36) && /<textarea id="sfSetChecks"/.test(mod36) && ['sfSetHeadEnv', 'sfSetHeadCon'].every((id) => new RegExp('<input type="text" id="' + id + '"[^>]*inputmode="numeric" maxlength="3"').test(mod36))
    && /<button class="primary" id="sfSetSave">저장<\/button>/.test(mod36) && /<button class="secondary" id="sfSetCancel">취소<\/button>/.test(mod36) && /id="sfSetStamp"/.test(mod36)
    && /var AUDIT_COL_LABEL = \{[^}]*safety:"안전 설정"\}/.test(html)
    && srvLab36.length === 10 && appLab36.join('|') === srvLab36.join('|') && flatKeys36.join(',') === srvLab36.map((s) => s.split('=')[0]).join(','),
    JSON.stringify({ mod: mod36.length, opts: opts36, srv: srvLab36, app: appLab36, flat: flatKeys36 }));

  // ⑨ 문서 — MANUAL 28-1(⑤ 줄 설명·회사 구분·관리자 [고치기] 절차·주의 — 문장 고정) · FEATURES 기준 ≥ v436·v436 절(문장 고정)·§7 안전 줄 · TESTLIST v436(체크 칸 전부 AI 몫 — 화면 칸 '(AI 시험 화면 대상' 정확히 6개·순서, PM 0, 게이트 칸 [x]) · CLAUDE.md 안전 탭 줄(규칙 문장 고정) · 자리 글(GATES_·GATE_) 0 · sw ≥ 436
  const man36 = rd36('MANUAL.html'), ft36 = rd36('FEATURES.md'), tl36 = rd36('TESTLIST.md'), cl36 = rd36('CLAUDE.md'), sw36 = rd36('sw.js');
  const m281_36 = (() => { const i = man36.indexOf('<h3 id="s28-1">'); return i < 0 ? '' : man36.slice(i, man36.indexOf('<!-- 29 -->', i)); })();
  const MAN_PINS36 = ['<b>관리자만</b> 이 칸 ⑤ 인정·평가의 <span class="btn">고치기</span>로 넣습니다(2026-11 v436',
    '<li><b>인정·평가</b> — KOSHA 위험성평가 인정 단계(미인정 · 접수 · 심사 · 인정 — 지금 단계에 색이 칠해짐)와 접수번호·날짜·사후점검 횟수·요율 반영 연도, 석면 안전성평가 <b>B 71.6 · 앱 반영 대기</b>',
    '석면해체·제거업 등록기준(전담 인력 2명 — 교육·검진에 넣은 석면해체·제거관리자교육 이수 직원 수 <b>관리자교육 n/2명</b> · 장비 6종) 세 줄입니다',
    "일용직의 이수 기록은 이 수에 넣지 않고 '일용직 이수자 n명은 세지 않음'으로 따로 적습니다(전담 인력에 넣을지는 따로 확인)",   // v436 검토 반영 — 직원만 셈
    '인허가 권한이 있고 그 인허가 행(석면해체·제거업)의 공개 대상이기도 한 분에게만 의무 대장 16행(다음 평가 시기)·17·18행 글도 함께 나오고',   // v436 검토 반영 — 공개범위 조건(옛 '인허가 권한이 있으면'은 아래 0번 대조)
    "아직 아무도 넣지 않았으면 KOSHA 줄은 <b>미인정(입력 전)</b>입니다. 인정 만료가 90일 안이면 <b>만료 D-n</b>, 지나면 <b>만료 지남</b> 경고가 붙습니다(만료가 지나면 '인정' 표시도 초록이 아닌 주황입니다). 재인정·사후점검 할 일 알림은 지금처럼 내 업무 y15~y18이 합니다",
    '<p><b>회사 구분(맨 위)</b><br>회사별 상시근로자 수(종운환경·종운건설) 두 칸을 다 넣은 뒤에만 현황 맨 위에 나옵니다. 처음에는 꺼져 있고, 한 칸이라도 비우면 다시 꺼집니다.',
    '<p><b>관리자 — 안전 설정 넣기(KOSHA 인정 상태 · 회사별 인원)</b></p>', '관리자에게만 보입니다(안전 권한만 있는 분은 읽기만 합니다).', "사후점검 이력(한 줄에 '날짜 메모', 예: 2027-03-15 공단 사후점검 적합 — 10건까지)",
    '회사별 상시근로자 수(종운환경 · 종운건설)를 0~999 사이 숫자로 넣습니다. 두 칸을 다 넣으면 현황 맨 위 회사 구분이 켜집니다.', '<b>다른 곳에서 먼저 고쳤습니다 — 새로 읽었습니다</b>가 뜨고 창이 새 값으로 바뀝니다',
    '현황은 아무것도 저장하지 않습니다(관리자의 ⑤ <span class="btn">고치기</span> 창만 안전 설정을 저장합니다).'];
  const ftv36 = (() => { const i = ft36.indexOf('\n### v436 (11/10)'); if (i < 0) return ''; const j = ft36.indexOf('\n### ', i + 5); return ft36.slice(i, j < 0 ? ft36.length : j); })();
  const ft7_36 = ft36.split('\n').filter((ln) => ln.indexOf('- **안전**(v428') === 0)[0] || '';
  const FT_PINS36 = ['인허가 목록(col:licenses)에 행으로 넣지 않고 새 설정 블롭 `settings:safety` 하나에 둔다(PM ⓐ)', "판정은 새 `permKey(member,'safety')`", 'base 없음도 409, 새 액션이라 base를 안 보내는 옛 앱이 없다',
    '**⑤는 현황을 보는 사람 모두**', '회사별 상시근로자 수 두 칸이 다 있을 때만(처음엔 꺼짐', '설계 시안의 회사 칩 거르기(전체·종운환경·종운건설)와 공사금액 문턱(2천만·4천만·1억·20억·50억)은 넣지 않았다',
    '**[고치기]는 관리자에게만**', '`// @safety-set-start ~ end` 구간', "만료 90일 안이면 '만료 D-n'(am)·지나면 '만료 지남'(bad) 경고 칩", "알약 'B 71.6 · 앱 반영 대기'", '사람 단위 — 같은 사람 기록 여럿은 1명',
    // v436 검토 반영 — 같은 값 판정·사후점검 감사 글·동시 저장 한계·직원만 셈·만료 지난 인정·결정일·사람 전환·백업 경로
    '같은 값 400 NO_CHANGE(정규화한 값째 비교', "사후점검은 줄 목록으로 비교해 'n건 · 뺌 …' → 'm건 · 더함 …'", '동시 저장은 마지막 쓰기가 이긴다', '이수 직원 수 \'관리자교육 n/2명\'(직원만 센다',
    '인정인데 만료가 지났으면 am', "단계가 인정이 아니면 '결정'", '`applySafetyPerms`가 현황을 다시 연다', '키 이름 없이 gw_data 키 전부를 다루므로'];
  const FT7_PIN36 = "v436부터 ⑤ 인정·평가 = KOSHA 위험성평가 인정 단계·석면 안전성평가 'B 71.6 · 앱 반영 대기'·등록기준 줄(원천 = 안전 설정 settings:safety — 인허가 목록에 넣지 않음, 고치기는 관리자만 ⑤ [고치기]) · 맨 위 회사 구분은 회사별 상시근로자 수 두 칸을 다 넣은 뒤에만";
  const tlv36 = (() => { const i = tl36.indexOf('\n## v436'); if (i < 0) return ''; const j = tl36.indexOf('\n## ', i + 5); return tl36.slice(i, j < 0 ? tl36.length : j); })();
  const cb36 = tlv36.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi36 = cb36.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l)), cbPM36 = cb36.filter((l) => /PM/.test(l));
  const cbScr36 = cb36.filter((l) => /^- \[[ x]\] \(AI 시험 화면 대상/.test(l));
  const TL_HEADS36 = ['관리자형 설정 없음(운영 지금):', '관리자 [고치기]:', '낙관락:', '권민지형(안전 수행 · 인허가 보기', '김정아형(안전 보기 + 현장·인허가 수행', '다른 곳 그대로:'];
  const tlHeadOk36 = cbScr36.length === TL_HEADS36.length && TL_HEADS36.every((h, i) => cbScr36[i].indexOf(h) > 0 && cbScr36.filter((l) => l.indexOf(h) > 0).length === 1);
  //   (v436 검토 반영) 화면 칸의 기대 글 = 실제 화면 글 — [고치기] 칸이 인용하는 회사 구분 알약·메타·알림 글은 index.html에도 그대로 있어야 한다(폰 폭 때문에 알약을 줄이기 전 글이 남아 AI 시험 화면이 거짓 실패하던 것) ·
  //   인원 칸은 3자까지라 '1000'은 칠 수 없음 → '-1' · 알약 둘(세로) 확인은 설정 없음 칸이 아니라 [고치기] 칸의 만료 D-60 뒤 · 권민지형 칸에 한 기기 전환
  const TL_PINS36 = ['5명↑ 중처법 적용', '중대재해처벌법·정기교육 적용(상시 5명 이상)', '안전보건관리담당자는 20명부터(폐기물 수집·운반업)', "'5명 미만'", '중대재해처벌법·정기교육 제외(상시 5명 미만 — 특별교육은 적용)', '상시근로자 수는 0~999 사이 정수로 넣거나 비워 두세요.', '바뀐 것이 없습니다', '저장했습니다', '아직 저장한 적 없음'];
  const tlLine36 = (h) => cbScr36.filter((l) => l.indexOf(h) > 0)[0] || '';
  const tlFix36 = tlLine36('관리자 [고치기]:');
  const tlPinOk36 = TL_PINS36.every((s) => tlFix36.indexOf(s) > 0 && html.indexOf(s.replace(/^'|'$/g, '')) > 0) && tlFix36.indexOf("인원 '1000'") < 0 && tlFix36.indexOf("인원 '-1'") > 0 && tlFix36.indexOf("'만료 D-60' 칩 — 폰 375px에서 알약 둘(인정·만료 D-60)이 오른쪽에 세로로") > 0
    && tlLine36('관리자형 설정 없음(운영 지금):').indexOf('알약 둘이 오른쪽에 세로로') < 0 && tlLine36('권민지형(안전 수행 · 인허가 보기').indexOf("로그인 창 '전환'으로 권민지형 로그인 → 새로고침 없이 현황이 다시 그려져 [고치기] 없음") > 0;   // 11/10 시험 서버 실측: 운영 석면해체·제거업 행(lseed13)은 공개범위 칸이 없어 권민지형에게도 17·18행이 보임 — '16~18행 없음' 문구를 걷어 냄
  const clSafe36 = cl36.split(/\r?\n/).filter((l) => l.indexOf('- **안전(safety) 탭**') === 0)[0] || '';
  const CL_PINS36 = ['**현황 ⑤ 인정·평가·회사 구분**(v436', '**안전 설정 `settings:safety`**', '인허가 코드에 kosha_cert·면허 판정 함수를 만들지 않는다', "키 이름 판정은 `permKey`(같은 규칙)로 — `permOf(member,'safety')`는 COL에 없어 기본 '보기'가 된다",
    '**`// @safety-set-start ~ end` 구간**', '누름은 `#sfNowHost` 위임 배선 한 곳',
    // v436 검토 반영 — 백업 경로 문구 · 같은 값 판정 · 직원만 셈 · 사람 전환 다시 열기
    '이 키 이름을 쓰는 서버 코드는 두 핸들러뿐임을 지킴', '같은 값 판정(NO_CHANGE)은 정규화한 값째', "등록기준 '관리자교육 n/2명'은 직원만 센다", '`applySafetyPerms`가 `setSafetyLayer("now")`로 다시 연다'];
  T('v436 ⑨ 문서: MANUAL 28-1 = 관리자만 ⑤ [고치기] 예외 · ⑤ 줄 설명(단계 표시·B 71.6 · 앱 반영 대기·관리자교육 n/2명 = 이수 직원 수(일용직은 세지 않음 — 검토 반영)·의무 대장 글은 인허가 권한 + 그 행 공개 대상(옛 \'인허가 권한이 있으면\' 0 — 검토 반영)·미인정(입력 전)·만료 D-n/지남(지나면 인정 주황)·y15~y18) · 회사 구분(맨 위 — 두 칸 다 넣은 뒤에만) · 관리자 안전 설정 넣기 절차(관리자에게만·사후점검 한 줄 날짜 메모·0~999·409 안내) · 주의(고치기 창만 저장) — 문장 고정 · 묶음 이름 6개 그대로 · FEATURES 기준 ≥ v436·v436 절(문장 고정)·§7 안전 줄(문장 고정) · TESTLIST v436 체크 칸 전부 AI 몫(화면 칸 정확히 6개 — 관리자형·[고치기]·낙관락·권민지형·김정아형·다른 곳 순, PM 0, 게이트 칸 [x] uismoke)·화면 칸 기대 글 = 실제 화면 글(TL_PINS36 — [고치기] 칸 회사 구분 알약·메타·알림이 index.html에도, \'1000\' 대신 \'-1\', 알약 둘은 만료 D-60 뒤, 권민지형 칸 한 기기 전환 — 검토 반영) · CLAUDE.md 안전 탭 줄(규칙 문장 고정) · 자리 글(GATES_V436·GATE_) 0 · sw ≥ 436',
    MAN_PINS36.every((s) => m281_36.indexOf(s) > 0) && [...m281_36.matchAll(/<li><b>([^<]+)<\/b> — /g)].map((m) => m[1]).join(',') === '이번 주기 안전 점검,중처법 반기 점검,다가오는 기한 30일,계약 안전 서류,인정·평가,확인 필요'
    && m281_36.indexOf('인허가 권한이 있으면 의무 대장 16행') < 0 && m281_36.indexOf('석면해체·제거관리자교육 이수자 수 <b>') < 0
    && Number((ft36.match(/기준: v(\d+) /) || [0, 0])[1]) >= 436 && ftv36.length > 0 && FT_PINS36.every((s) => ftv36.indexOf(s) > 0) && ft7_36.indexOf(FT7_PIN36) > 0 && ftv36.indexOf('GATES_V436') < 0
    && tlv36.length > 0 && cb36.length >= 7 && cbNotAi36.length === 0 && cbPM36.length === 0 && tlv36.indexOf('PM 몫') < 0 && tlHeadOk36 && tlPinOk36 && cb36.some((l) => /^- \[x\] \(AI\) `uismoke`/.test(l)) && !/GATE_/.test(tlv36)
    && CL_PINS36.every((s) => clSafe36.indexOf(s) > 0) && Number((sw36.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 436,
    JSON.stringify({ man: MAN_PINS36.filter((s) => m281_36.indexOf(s) < 0).map((s) => s.slice(0, 30)), ft: FT_PINS36.filter((s) => ftv36.indexOf(s) < 0).map((s) => s.slice(0, 30)), ft7: ft7_36.indexOf(FT7_PIN36), gates: [ftv36.indexOf('GATES_V436'), /GATE_/.test(tlv36)], cb: cb36.length, notAi: cbNotAi36.map((l) => l.slice(0, 40)), pm: cbPM36.map((l) => l.slice(0, 40)), scr: cbScr36.map((l) => l.slice(0, 40)), tl: [tlPinOk36, TL_PINS36.filter((s) => tlFix36.indexOf(s) < 0 || html.indexOf(s.replace(/^'|'$/g, '')) < 0)], cl: CL_PINS36.filter((s) => clSafe36.indexOf(s) < 0).map((s) => s.slice(0, 30)) }));
} catch (e) { console.log('  (v436 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v437(11/10 체크 45 C026 — 게이트 보고 5-2 1-a '앱 경로 병행 빈틈', 09_조사_문서/45_밀린몫_자료_20261110/45_게이트보고_20261110.md · 서버만):
//      자동 지시 생성 알림 '담당자 본인' 전환 뒤 첫 7일 관리자 병행을 앱 경로(handlePushSend)에도 — 봇 경로(handleBotNotify)와 같은 판정 함수 notifyParallelOn 한 곳(동작은 servertest 50·81절)
//      ① 정적(서버) — 판정 함수·상수 한 곳 · 두 핸들러가 같이 부름 · 핸들러 안에 7일 식 0 · 삼킴 응답·봇 생략 안내 그대로 · 병행 중 받는 사람 = 종전 규칙(보낸 사람 제외) · 담당자 1발은 병행을 안 봄
//      ② 문서 — FEATURES 기준 ≥ v437·v437 절(문장 고정) · TESTLIST v437(체크 칸 둘 다 AI 몫 — 화면 칸 없음 · 게이트 칸 [x] · 운영 적용 뒤 확인 칸 · PM 0) · MANUAL 21-12 '지시 알림 설정' 한 줄 · 자리 글(GATES_V437) 0 · sw ≥ 437
//         검토 반영(11/10): 앱 카드 안내 글 한계·운영 적용 방법(배포 먼저·적용 시각·병합 쓰기·다른 칸 확인)·삼킴 판정 방법 문장 · MANUAL 한계 괄호 · TESTLIST v396 메모(같은 시각까지 — '8일째' 0)
try {
  const rd37 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const nc37 = (s) => s.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
  const fn37 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const gd37 = rd37('netlify/functions/gw-data.js'), gdNC37 = nc37(gd37);
  const bot37 = nc37(fn37(gd37, 'handleBotNotify')), app37 = nc37(fn37(gd37, 'handlePushSend')), auto37 = nc37(fn37(gd37, 'notifyAutoCreated')), par37 = nc37(fn37(gd37, 'notifyParallelOn'));
  T('v437 ① 정적(서버): notifyParallelOn = 지금 − updated_at(없음·0 → 0) ≤ NOTIFY_PARALLEL_MS 한 줄 · 상수 NOTIFY_PARALLEL_MS = 7 * 86400000 한 줄(쓰는 곳은 이 함수뿐) · 호출 2곳 = 봇 handleBotNotify(auto-due 생략 조건)·앱 handlePushSend(삼킴 조건) · 두 핸들러 안에 updated_at·86400000 0 · 삼킴 응답 {sent 0, suppressed task_auto_create}·봇 생략 안내 글 그대로 · 병행 중 받는 사람 = 관리자 전원에서 보낸 사람 제외(종전) · notifyAutoCreated는 병행 판정을 안 봄',
    par37 === 'function notifyParallelOn(nf) { return (Date.now() - Number((nf && nf.updated_at) || 0)) <= NOTIFY_PARALLEL_MS; }'
    && (gdNC37.match(/\nconst NOTIFY_PARALLEL_MS = 7 \* 86400000;[ \t]*\n/g) || []).length === 1 && (gdNC37.match(/\bNOTIFY_PARALLEL_MS\b/g) || []).length === 2
    && (gdNC37.match(/\bnotifyParallelOn\(/g) || []).length === 3 && (bot37.match(/\bnotifyParallelOn\(/g) || []).length === 1 && (app37.match(/\bnotifyParallelOn\(/g) || []).length === 1
    && bot37.indexOf("if (nfA.events.task_auto_create === 'assignee' && !notifyParallelOn(nfA))\n          return jr(200, { status: 'OK', sent: 0, admins: ids.length, devices: 0, note: 'task_auto_create=assignee — 관리자 푸시 생략(담당자 본인 1발은 ingest가 보냄)', request_id: R });") > 0
    && app37.indexOf("if (nfP && nfP.events.task_auto_create === 'assignee' && /^(auto-due|rec-over|bid-qual)$/.test(tagP) && !notifyParallelOn(nfP)) return jr(200, { status: 'OK', sent: 0, suppressed: 'task_auto_create', request_id: R });") > 0
    && app37.indexOf('ids = tc.adminIds.filter(function (id) { return id !== c.member.id; });') > 0
    && !/updated_at|86400000/.test(bot37) && !/updated_at|86400000/.test(app37) && auto37.length > 100 && !/notifyParallelOn|NOTIFY_PARALLEL_MS/.test(auto37),
    JSON.stringify({ par: par37, n: (gdNC37.match(/\bnotifyParallelOn\(/g) || []).length, bot: (bot37.match(/\bnotifyParallelOn\(/g) || []).length, app: (app37.match(/\bnotifyParallelOn\(/g) || []).length, inline: [/updated_at|86400000/.test(bot37), /updated_at|86400000/.test(app37)] }));

  const ft37 = rd37('FEATURES.md'), tl37 = rd37('TESTLIST.md'), man37 = rd37('MANUAL.html'), sw37 = rd37('sw.js');
  const ftv37 = (() => { const i = ft37.indexOf('\n### v437 (11/10)'); if (i < 0) return ''; const j = ft37.indexOf('\n### ', i + 5); return ft37.slice(i, j < 0 ? ft37.length : j); })();
  const FT_PINS37 = ['**판정 한 곳**: gw-data `notifyParallelOn(nf)`', '상수 `NOTIFY_PARALLEL_MS = 7 * 86400000` 한 줄', 'updated_at이 없거나 0이면 병행 끝(종전 봇 경로와 같음)', '봇 경로·앱 경로가 같은 함수를 부른다',
    '병행 중이면 삼키지 않고 종전처럼 관리자 전원에게 보낸다(보낸 사람 제외 규칙 그대로', '병행이 끝나면 종전처럼 삼킨다', '**담당자 1발 그대로**', '`notifyAutoCreated`', '병행을 보지 않는다',
    '**알려진 한계**', '다른 칸(완료 요청·만기 임박·휴가·개찰·수집 실패)을 바꾸거나 [되돌리기]를 눌러도 updated_at이 새로 찍혀 병행 7일이 다시 시작된다', '11/13(금) R1', 'TESTLIST v437 칸에 적는다',
    // 검토 반영(11/10): 한계 동작 고정(servertest 81 ⑨) · 앱 카드 안내 글(index.html renderNotifyCard)은 첫 7일 병행을 말하지 않음(다음 앱 판) · 운영 적용 방법(배포 먼저 · 적용 시각 · 병합 쓰기) · 삼킴 판정 방법
    'servertest 81 ⑨가 이 동작을 고정', '앱 카드 안내 글(index.html `renderNotifyCard`', '도 같은 판에서 고쳤다', '11/13~11/20 사이 관리자 폰에 만기·미수·적격 푸시가 계속 와도 정상 병행이다',   // 11/10 코디네이터: 카드 안내 글을 같은 판에서 고침(아래 CARD_PIN37도 index.html에서 고정)
    '적용은 v437이 운영에 배포된 뒤', '블롭을 직접 써도 updated_at은 적용 시각(ms 정수)으로 새로 찍는다', '적용 뒤 읽은 updated_at이 적용 시각이 아니면(예: 11/4 10:21 그대로) 병행이 걸리지 않은 것이므로 바로 다시 쓴다',
    'events를 고정값으로 통째 덮지 않는다', '삼킴은 push:log·감사에 흔적이 남지 않는다'];
  const tlv37 = (() => { const i = tl37.indexOf('\n## v437'); if (i < 0) return ''; const j = tl37.indexOf('\n## ', i + 5); return tl37.slice(i, j < 0 ? tl37.length : j); })();
  const cb37 = tlv37.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l)), cbNotAi37 = cb37.filter((l) => !/^\s*[-*+] \[[ xX]\] \(AI[ 가)]/.test(l)), cbPM37 = cb37.filter((l) => /PM/.test(l));
  const TL_OPS37 = ['settings:notify', 'updated_at', '병행이 끝나는 때(updated_at + 7일)', '담당자 1발', '병행 7일이 다시 시작',
    // 검토 반영(11/10): 배포 먼저 · 적용 시각(ms)으로 새로 찍기 · 고정값 통째 덮기 금지 · 다른 칸 그대로 확인 · 옛 시각 그대로면 다시 씀 · 끝나는 때 = 11/20 적용 시각 · 삼킴 판정 방법(흔적 없음 → push:log)
    'v437이 운영에 배포된 뒤인지 확인', 'updated_at은 적용 시각(ms 정수)으로 새로 찍고', 'events를 고정값으로 통째 덮지 않음', '다른 칸 그대로인지',
    '적용 전 값(11/4 10:21) 그대로면 병행이 안 걸린 것이므로 바로 다시 씀', '끝나는 때 = 11/20 적용 시각과 같은 시각', '삼킴은 push:log·감사에 흔적이 남지 않으므로',
    "같은 지시의 관리자 발송(auto-due·rec-over·bid-qual · 봇 '정기업무 n건')은 없는지로 판정"];
  const row37 = (() => { const i = man37.indexOf('<h3>21-12.'); if (i < 0) return ''; const k = man37.indexOf('<tr><td><b>지시 알림 설정</b></td>', i); if (k < 0) return ''; return man37.slice(k, man37.indexOf('</tr>', k)); })();
  const MAN_PIN37 = '자동 지시 생성 알림을 담당자 본인으로 바꾼 뒤 첫 7일은 관리자에게도 같이 갑니다';
  const CARD_PIN37 = '관리자 전원에게 가던 만기·미수·적격 푸시는 바꾼 뒤 첫 7일(이 카드의 다른 알림을 바꾸면 그때부터 7일) 동안은 같이 가다가 그 뒤 멈춥니다';   // 앱 '지시 알림 설정' 카드 안내 글(index.html renderNotifyCard) — 옛 '푸시가 멈추고, 담당자에게 우선기기 1발만' 0
  const html37 = rd37('index.html');
  const MAN_LIM37 = '(이 카드의 다른 알림을 바꾸거나 되돌려도 그때부터 7일이 다시 시작됩니다, 2026-11 v437)';   // 알려진 한계(servertest 81 ⑨가 동작 고정) — 검토 반영
  //   TESTLIST v396 '담당자 본인' 칸 메모: 병행은 저장 시각 + 7×24시간(같은 시각)까지 — '8일째부터'처럼 날짜로 끊지 않는다(8일째 아침 정상 병행을 실패로 볼 수 있음, 검토 반영)
  const tl396_37 = (() => { const i = tl37.indexOf('\n## v396 '); if (i < 0) return ''; const j = tl37.indexOf('\n## ', i + 5); return tl37.slice(i, j < 0 ? tl37.length : j); })();
  const tl396Row37 = tl396_37.split(/\r?\n/).filter((l) => l.indexOf('"담당자 본인"으로 바꾸면') >= 0);
  const TL396_PIN37 = '(v437부터 바꾼 시각부터 7일 — 11/13 적용이면 11/20 같은 시각까지 — 관리자 폰에도 같이 옴, 그 뒤부터 안 옴)';
  T('v437 ② 문서: FEATURES 기준 ≥ v437·v437 절(판정 한 곳·상수 한 줄·없음/0 = 끝·같은 함수·앱 경로 병행 중 보냄/끝나면 삼킴·담당자 1발 그대로·알려진 한계(다른 칸·되돌리기 = 7일 다시)·11/13 R1 적용 때 TESTLIST 칸 — 문장 고정)·자리 글 GATES_V437 0 · TESTLIST v437 체크 칸 둘 다 AI 몫(게이트 칸 [x] servertest·uismoke·consheet_check·proctpl_check·settletest · 운영 적용 뒤 확인 칸 settings:notify updated_at·끝나는 때·담당자 1발·다시 시작 · 화면 칸 없음 · PM 0) · MANUAL 21-12 지시 알림 설정 줄에 \'담당자 본인으로 바꾼 뒤 첫 7일은 관리자에게도 같이 갑니다\' · sw ≥ 437 · 검토 반영 고정: FEATURES 한계 동작 고정(81 ⑨)·앱 카드 안내 글 한계·운영 적용 방법(배포 먼저·적용 시각·병합 쓰기)·삼킴 판정 / TESTLIST 운영 칸 같은 뜻 8 / MANUAL 한계 괄호 / TESTLIST v396 메모(같은 시각까지 · 8일째 0)',
    Number((ft37.match(/기준: v(\d+) /) || [0, 0])[1]) >= 437 && ftv37.length > 0 && FT_PINS37.every((s) => ftv37.indexOf(s) > 0) && ftv37.indexOf('GATES_V437') < 0
    && html37.indexOf(CARD_PIN37) > 0 && html37.indexOf('만기·미수·적격 푸시가 멈추고, 담당자에게 우선기기 1발만 갑니다') < 0
    && tlv37.length > 0 && cb37.length === 2 && cbNotAi37.length === 0 && cbPM37.length === 0 && tlv37.indexOf('PM 몫') < 0 && tlv37.indexOf('GATES_V437') < 0 && cb37.every((l) => l.indexOf('(AI 시험 화면 대상') < 0)
    && /^- \[x\] \(AI\) `servertest`\(/.test(cb37[0]) && ['`uismoke`', '`consheet_check`', '`proctpl_check`', '`settletest`'].every((g) => cb37[0].indexOf(g) > 0)
    && /^- \[[ x]\] \(AI 운영 적용 뒤 확인 — 11\/13\(금\) R1/.test(cb37[1]) && TL_OPS37.every((s) => cb37[1].indexOf(s) > 0)
    && row37.indexOf(MAN_PIN37) > 0 && row37.indexOf(MAN_LIM37) > row37.indexOf(MAN_PIN37) && Number((sw37.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 437
    && tl396Row37.length === 1 && tl396Row37[0].indexOf(TL396_PIN37) > 0 && tl396Row37[0].indexOf('8일째') < 0,
    JSON.stringify({ ft: FT_PINS37.filter((s) => ftv37.indexOf(s) < 0).map((s) => s.slice(0, 30)), gates: [ftv37.indexOf('GATES_V437'), tlv37.indexOf('GATES_V437')], cb: cb37.length, notAi: cbNotAi37.map((l) => l.slice(0, 40)), pm: cbPM37.map((l) => l.slice(0, 40)), ops: cb37[1] ? TL_OPS37.filter((s) => cb37[1].indexOf(s) < 0).map((s) => s.slice(0, 30)) : 'none', man: [row37.indexOf(MAN_PIN37), row37.indexOf(MAN_LIM37)], tl396: tl396Row37.map((l) => [l.indexOf(TL396_PIN37), l.indexOf('8일째')]), sw: (sw37.match(/jw-shell-v(\d+)/) || [0, 0])[1] }));
} catch (e) { console.log('  (v437 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v438(11/10 PM '45-1. #1.①ㄱ' — 09_조사_문서/표형탭_시안_자료_20261110/단계지시_v438_공통부품_폭.json · 엑셀형탭_명세_20261110.json common · 착수브리핑_20261110.md):
//      엑셀형 표 공통 부품(vsSheet — index.html // @vs-sheet 구간) + PC 화면 폭(#app·사이드바·간격 단계 · 넓히는 화면은 id로만). 이번 판에는 부품을 쓰는 탭이 없어(탭 옮기기는 v439부터)
//      이 하네스에 가짜 정의(명세 지시 표 모양 — 열 10개 · 단계별 열 합 696/944/1174)를 넣어 부품을 실제로 돌린다. 작은 DOM: host.innerHTML을 넣으면 여는 태그마다 요소(속성·value·checked·style·리스너)를
//      새로 만든다(v435 하네스와 같은 방식 — 다시 그리면 요소가 새로 생김). 창 폭은 가짜 matchMedia가 env.width로 판정, 시계·타이머·rAF·ResizeObserver도 가짜.
//      ① 화면 폭(head <style>을 읽어 계산 — 창 폭 − 스크롤바 17 = 명세 width_plan.table) ② 단계별 colgroup 열 수·CSS 숨김 ③ 칩 AND·모집단 칩·칩 건수·건수 글 ④ 정렬 ▲▼·빈 값·rank·칩별 기본 정렬·정렬 별칭
//      ⑤ 거르기 150ms·한글 조합·칸마다 따로 기다림·enum 바로 ⑥ 폭 끌기(pointer)·끈 뒤 남는 열 ≥ 최소 폭·40~600·리스너 해제·끈 폭 저장 안 함 ⑦ localStorage 키 이름·저장 모양·옛 기억 거르기
//      ⑧ 다시 그릴 때 펼침·입력값(data-keep)·포커스·커서·스크롤 ⑨ 폰 갈래(legacy = 옛 그리기 함수 그대로 · sheet = 폰 열·--pw·상세 카드)·경계 넘을 때 한 번만·숨은 표는 보일 때(ResizeObserver)
//      ⑩ 골라 쓰기(선택 — 보이는 행만·숨은 선택 · 묶음 행 · 더보기 · 검색칸) ⑪ 날짜 칸 규칙·정의 검사 ⑫ 정적(계약·차량 ResizeObserver 한 줄·부품을 쓰는 탭 0·pointer·CSS) ⑬ 문서
try {
  const rd38 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const own38 = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fn38 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  // ① 화면 폭 — head <style>의 규칙을 읽어(주석 빼고, @media 안팎) 창 폭마다 마지막으로 이기는 값을 고른다(같은 선택자끼리 — 이 검사가 보는 선택자는 다른 선택자와 겹쳐 이기지 않는다)
  const css38 = (() => { const i = html.indexOf('<style>'), j = html.indexOf('</style>', i); if (i < 0 || j < 0) throw new Error('head <style> 없음'); return html.slice(i + 7, j).replace(/\/\*[\s\S]*?\*\//g, ''); })();
  const rules38 = [];
  const parse38 = (src, media) => {
    let i = 0;
    while (i < src.length) {
      const ob = src.indexOf('{', i); if (ob < 0) break;
      const head = src.slice(i, ob).trim();
      let d = 1, j = ob + 1; for (; j < src.length && d > 0; j++) { if (src[j] === '{') d++; else if (src[j] === '}') d--; }
      const body = src.slice(ob + 1, j - 1);
      if (/^@media/.test(head)) parse38(body, head.slice(6).trim());
      else if (!/^@/.test(head)) { const decl = {}; body.split(';').forEach((p) => { const k = p.indexOf(':'); if (k > 0) decl[p.slice(0, k).trim()] = p.slice(k + 1).trim(); }); rules38.push({ media, sels: head.split(',').map((s) => s.trim().replace(/\s*>\s*/g, '>').replace(/\s+/g, ' ')), decl }); }
      i = j;
    }
  };
  parse38(css38, null);
  const mq38 = (q, w) => { if (q == null) return true; if (/print/.test(q)) return false; const a = /\(min-width:\s*(\d+)px\)/.exec(q), b = /\(max-width:\s*(\d+)px\)/.exec(q); if (!a && !b) return false; return (!a || w >= +a[1]) && (!b || w <= +b[1]); };
  const decl38 = (w, sel, prop) => { let v = null; rules38.forEach((r) => { if (mq38(r.media, w) && r.sels.indexOf(sel) >= 0 && own38(r.decl, prop)) v = r.decl[prop]; }); return v; };
  const SB38 = 17;   // 세로 스크롤바 — html{scrollbar-gutter:stable}라 늘 비켜 둔다(명세 width_plan 표가 이 값으로 계산)
  const padLR38 = (v) => { const p = String(v || '0px').trim().split(/\s+/).map((x) => parseFloat(x) || 0); const r = p.length === 1 ? p[0] : p[1]; return [p.length === 4 ? p[3] : r, r]; };
  //   ★퀴즈 1번 대안(index.html v438 CSS 주석 — 860 묶음 #app 줄에 margin-left 하나, 1600 묶음 1680 상한은 남김)을 쓰게 되면 body38의 appW를 min(W − margin-left, max-width)로(margin-left = max(0, (W − 1060) / 2)) 고치고
  //     WT38 기대값 9개 중 8개를 대안 값으로 함께 고친다: 1024 791(그대로) · 1100 856 · 1280 910 · 1366 953 · 1440 990 · 1536 1038 · 1600 1070 · 1920 1230 · 2560 1428 — MANUAL 1절·FEATURES v438·CLAUDE.md 폭 숫자도 같은 변경에서
  const body38 = (win) => { const W = win - SB38, mx = decl38(win, '#app', 'max-width'), appW = (!mx || mx === 'none') ? W : Math.min(W, parseFloat(mx)), lr = padLR38(decl38(win, '#app', 'padding')); return appW - lr[0] - lr[1] - (parseFloat(decl38(win, '.tabbar', 'width')) || 0) - (parseFloat(decl38(win, '.layout', 'gap')) || 0); };
  const viewW38 = (win, id) => { const b = body38(win), own = decl38(win, '#view-' + id, 'max-width'), base = decl38(win, '.views>.view', 'max-width'), mx = own != null ? own : base; return (!mx || mx === 'none') ? b : Math.min(b, parseFloat(mx)); };
  //   명세 width_plan.table(창 → 본문, 스크롤바 17 포함): 1024 791 · 1100 867 · 1280 1011 · 1366 1097 · 1440 1171 · 1536 1267 · 1600 1331 · 1920·2560 1428
  const WT38 = { 1024: 791, 1100: 867, 1280: 1011, 1366: 1097, 1440: 1171, 1536: 1267, 1600: 1331, 1920: 1428, 2560: 1428 };
  const WIDE38 = ['tasks', 'con', 'veh', 'perm'];   // 명세 reading_width 9개 중 v438은 계약·차량·권한관리 · v439에 지시(#view-tasks — 표로 바꾼 판) — 기성·거래처·일용직·입찰은 각 탭 판(v440~v443), 안전(#view-safety)은 56 판(v445)에서 더한다
  const views38 = [...html.matchAll(/<(?:section|div) class="view(?: active)?" id="view-([a-z]+)">/g)].map((m) => m[1]);
  const SECS38 = ['tasks', 'veh', 'hwakwan', 'allbaro', 'rec', 'cal', 'lic', 'bid', 'con', 'cli', 'doc', 'hr', 'progress', 'ask', 'safety', 'quote', 'promo', 'workers', 'perm', 'fam', 'leave'];
  const secs38 = [...html.matchAll(/<section class="view" id="view-([a-z]+)">/g)].map((m) => m[1]);
  const wBad38 = Object.keys(WT38).filter((w) => Math.abs(body38(+w) - WT38[w]) > 2);
  const vBad38 = [1366, 1920].map((w) => views38.filter((id) => viewW38(w, id) !== (WIDE38.indexOf(id) >= 0 ? body38(w) : 808)).join('/')).join('|') + '|' + views38.filter((id) => viewW38(1024, id) !== body38(1024)).join('/');
  const perm38 = decl38(1366, '#view-perm>:not(#permRoster)', 'max-width') === '808px' && decl38(1920, '#view-perm>:not(#permRoster)', 'max-width') === '808px' && decl38(1920, '#permRoster', 'max-width') == null && decl38(1920, '#sfPaneNow', 'max-width') === '808px';
  const phone38 = decl38(859, '#app', 'max-width') === '560px' && padLR38(decl38(859, '#app', 'padding')).join() === '16,16' && decl38(859, '.views>.view', 'max-width') == null && decl38(375, '.tabbar', 'width') == null && decl38(859, '.layout', 'gap') == null;
  T('v438 ① 화면 폭(head <style>을 읽어 계산 — 창 폭 − 스크롤바 17): 본문 = 명세 width_plan.table(±2px) 1024 791 · 1100 867 · 1280 1011 · 1366 1097 · 1440 1171 · 1536 1267 · 1600 1331 · 1920·2560 1428 · 넓히는 화면 id 4개(지시·계약·차량·권한관리 — v439에 지시를 더함, 기성·거래처·일용직·입찰은 각 탭 판 v440~v443, 안전은 v445)만 1366·1920에서 본문 폭, 그 밖 화면(안전 포함)은 808 · 1024 창은 모두 본문 폭(791 < 808) · 권한관리는 권한 표(#permRoster)만 넓고 그 밖 카드·안전 현황(#sfPaneNow) 808 · 859px 이하 틀 그대로(#app 최대 560·여백 16, 간격·사이드바 폭·읽기 폭 규칙 없음) · section 태그 21개 class="view" 그대로(class 더하지 않음)',
    wBad38.length === 0 && vBad38 === '||' && views38.length === 23 && perm38 && phone38 && JSON.stringify(secs38) === JSON.stringify(SECS38) && !/<section class="view [^"]*" id=/.test(html),
    JSON.stringify({ body: Object.keys(WT38).map((w) => w + ':' + body38(+w)), viewBad: vBad38, views: views38.length, perm38, phone38, secs: secs38.length }));

  // ② 이후 — 부품 하네스
  const blk38 = (() => { const i = html.indexOf('// @vs-sheet-start'), j = html.indexOf('// @vs-sheet-end'); if (i < 0 || j < i) throw new Error('@vs-sheet 구간 없음'); return html.slice(i, j); })();
  const unesc38 = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const mk38 = (o) => {
    o = o || {};
    const env = { width: o.width || 1366, mql: [], store: Object.assign({}, o.store || {}), sets: [], timers: [], now: 100000, log: [], raf: [], ro: [], roCb: null, paints: 0, cw: 1048 };   // cw = 요소 clientWidth(창 크기 바뀜 흉내)
    const doc = { activeElement: null, L: {}, byId: {} };
    doc.getElementById = (id) => doc.byId[id] || null;
    doc.addEventListener = (t, f) => { (doc.L[t] = doc.L[t] || []).push(f); };
    doc.removeEventListener = (t, f) => { doc.L[t] = (doc.L[t] || []).filter((g) => g !== f); };
    const mkEl = (tag, attrs) => {
      const el = { tagName: tag.toUpperCase(), attrs, L: {}, scrollLeft: 0, scrollTop: 0, parentNode: null };
      Object.defineProperty(el, 'clientWidth', { get: () => env.cw });
      el.getAttribute = (n) => (own38(attrs, n) ? unesc38(attrs[n]) : null);
      el.setAttribute = (n, v) => { attrs[n] = String(v); };
      el.hasAttribute = (n) => own38(attrs, n);
      el.type = attrs.type || '';
      el.value = own38(attrs, 'value') ? unesc38(attrs.value) : '';
      el.checked = own38(attrs, 'checked');
      const sp = {}; String(attrs.style || '').split(';').forEach((p) => { const k = p.indexOf(':'); if (k > 0) sp[p.slice(0, k).trim()] = p.slice(k + 1).trim(); });
      el.style = { sp, setProperty: (k, v) => { sp[k] = String(v); }, getPropertyValue: (k) => sp[k] || '' };
      Object.defineProperty(el.style, 'width', { get: () => sp.width || '', set: (v) => { sp.width = String(v); } });
      const cls = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
      el.classList = { toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) };
      el.addEventListener = (t, f) => { (el.L[t] = el.L[t] || []).push(f); };
      el.fire = (t, ev) => { const e = Object.assign({ target: el, type: t, stopped: false }, ev || {}); e.stopPropagation = () => { e.stopped = true; }; e.preventDefault = () => {}; (el.L[t] || []).slice().forEach((f) => f(e)); return e; };
      el.focus = () => { doc.activeElement = el; };
      el.selectionStart = el.tagName === 'INPUT' ? el.value.length : null;
      el.setSelectionRange = (a) => { el.selectionStart = a; env.log.push('caret:' + a); };
      el.scrollIntoView = () => { env.log.push('into:' + (el.getAttribute('data-vs-detcard') || '')); };
      return el;
    };
    const match = (el, sel) => {
      let m = /^\[([\w-]+)\]$/.exec(sel); if (m) return el.hasAttribute(m[1]);
      m = /^\[([\w-]+)="((?:[^"\\]|\\.)*)"\]$/.exec(sel); if (m) return el.getAttribute(m[1]) === m[2].replace(/\\(.)/g, '$1');
      m = /^\.([\w-]+)$/.exec(sel); if (m) return el.classList.contains(m[1]);
      throw new Error('시험 DOM이 모르는 선택자: ' + sel);
    };
    env.mkHost = (id) => {
      const host = { id, attrs: {}, _h: '', els: [], visible: true };
      host.getAttribute = (n) => (own38(host.attrs, n) ? host.attrs[n] : null);
      host.setAttribute = (n, v) => { host.attrs[n] = String(v); };
      host.getClientRects = () => (host.visible ? [{}] : []);
      host.contains = (el) => host.els.indexOf(el) >= 0;
      host.querySelectorAll = (sel) => host.els.filter((e) => match(e, sel));
      host.querySelector = (sel) => host.els.find((e) => match(e, sel)) || null;
      Object.defineProperty(host, 'innerHTML', { get: () => host._h, set: (v) => {
        host._h = String(v); host.els = [];
        for (const t of host._h.matchAll(/<([a-zA-Z][\w-]*)((?:[^<>"]|"[^"]*")*)>/g)) { const attrs = {}; for (const a of t[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2]; host.els.push(mkEl(t[1], attrs)); }
        env.paints++;
      } });
      doc.byId[id] = host;
      return host;
    };
    const win = { get innerWidth() { return env.width; }, matchMedia: (q) => ({ media: q, get matches() { return mq38(q, env.width); }, addEventListener: (t, f) => { env.mql.push(f); } }), requestAnimationFrame: (f) => { env.raf.push(f); } };
    const ls = o.throwStore ? { getItem: () => { throw new Error('저장소 막힘'); }, setItem: () => { throw new Error('저장소 막힘'); }, removeItem: () => { throw new Error('저장소 막힘'); } }   // 개인 창·저장소 차단 흉내
      : { getItem: (k) => (own38(env.store, k) ? env.store[k] : null), setItem: (k, v) => { env.sets.push(k); env.store[k] = String(v); }, removeItem: (k) => { delete env.store[k]; } };
    const stF = (f, ms) => { const t = { id: env.timers.length + 1, f, at: env.now + ms, done: false }; env.timers.push(t); return t.id; };
    const ctF = (id) => { env.timers.forEach((t) => { if (t.id === id) t.done = true; }); };
    class FD extends Date { static now() { return env.now; } }
    function RO(cb) { env.roCb = cb; this.observe = (t) => { env.ro.push(t); }; }
    const api = new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'Date', 'ResizeObserver', [
      fn38(html, 'esc'), 'function todayStr(){ return "2026-11-10"; }', fn38(html, 'vehDday'), blk38,
      'return { render: vsSheetRender, inst: vsInst, filter: vsSheetFilter, setQ: vsSheetSetQ, reset: vsSheetReset, paneObs: vsPaneObserve, cols: vsSheetCols, minW: vsSheetMinW, check: vsSheetCheckDef, date: vsDateCell, KEYS: VS_SHEET_KEYS, BUDGET: VS_STAGE_BUDGET };'].join('\n'))(win, doc, ls, stF, ctF, FD, RO);
    env.tick = (ms) => { env.now += ms; let t; while ((t = env.timers.filter((x) => !x.done && x.at <= env.now).sort((a, b) => a.at - b.at)[0])) { t.done = true; t.f(); } };
    env.flushRaf = () => { env.raf.splice(0).forEach((f) => f()); };
    env.breakAll = () => { env.mql.slice().forEach((f) => f({})); };
    return { api, env, doc };
  };
  // 가짜 정의 — 명세 지시 표 모양(열 10개: 지시 내용 남는 폭 최소 220·폰 52% / 구분 108 lv2 / 계약 단계 160 lv3 / 담당 76 lv2 / 기한 144 폰 24% / 상태 88 폰 24% / 등록일 88 lv3 / 공개 110 lv4 / 완료 120 lv4 / 처리 60 lv2 정렬 없음)
  const TODAY38 = '2026-11-10';
  const C38 = () => [
    { k: 't', h: '지시 내용', f: 'text', fill: 1, min: 220, pw: 52 }, { k: 'kind', h: '구분', w: 108, f: 'enum', lv: 2 }, { k: 'stage', h: '계약 단계', w: 160, f: 'text', lv: 3 },
    { k: 'who', h: '담당', w: 76, f: 'enum', lv: 2 }, { k: 'due', h: '기한', w: 144, f: 'none', pw: 24 }, { k: 'st', h: '상태', w: 88, f: 'enum', pw: 24 },
    { k: 'reg', h: '등록일', w: 88, f: 'none', lv: 3 }, { k: 'scope', h: '공개', w: 110, f: 'text', lv: 4 }, { k: 'done', h: '완료', w: 120, f: 'none', lv: 4 },
    { k: 'act', h: '처리', w: 60, f: 'none', lv: 2, nosort: 1 }];
  const ROWS38 = [
    { id: 'a', t: '가 준설 착공계 제출', kind: '일반', stage: '3/9 착공', who: '김', due: '2026-11-05', st: '진행', reg: '2026-11-01', scope: '', done: '' },
    { id: 'b', t: '나 차량 정기검사', kind: '자동', stage: '', who: '이', due: '2026-11-12', st: '대기', reg: '2026-10-13', scope: '관리부', done: '' },
    { id: 'c', t: '다 준설토 성분분석', kind: '계약', stage: '4/9 폐기물', who: '김', due: '', st: '진행', reg: '2026-11-03', scope: '', done: '' },
    { id: 'd', t: '라 사진대지 양식', kind: '일반', stage: '', who: '박', due: '2026-11-01', st: '보류', reg: '2026-10-20', scope: '', done: '' },
    { id: 'e', t: '마 보험 갱신 검토', kind: '일반', stage: '', who: '이', due: '2026-10-01', st: '완료', reg: '2026-09-15', scope: '', done: '2026-11-03' },
    { id: 'f', t: '바 증명서 발급', kind: '자동', stage: '', who: '김', due: '2026-09-01', st: '완료', reg: '2026-08-29', scope: '', done: '2026-11-08' },
    { id: 'g', t: '사 옛 공고 검토', kind: '일반', stage: '', who: '박', due: '2026-10-20', st: '진행', reg: '2026-10-01', scope: '', done: '', old: 1 }];
  const CH38 = () => [
    { g: 'st', items: [{ k: '', h: '진행 중', test: (r) => r.st !== '완료' }, { k: 'over', h: '기한 경과', warn: 1, test: (r) => r.st !== '완료' && !!r.due && r.due < TODAY38 }, { k: 'done', h: '완료', test: (r) => r.st === '완료', sort: { k: 'done', d: -1 } }, { k: 'all', h: '전체', pc: 1 }] },
    { g: 'kd', items: [{ k: '', h: '구분 전체' }, { k: 'auto', h: '자동', test: (r) => r.kind === '자동' }] }];
  const def38 = (o, log) => Object.assign({
    key: 'jw_task_sheet', host: 'vsT', unit: '건', none: '지시가 없습니다.', empty: '조건에 맞는 지시가 없습니다.', cols: C38(), rows: () => ROWS38, id: (r) => r.id, val: (r, k) => r[k],
    cell: (r, c) => (c.k === 'act' ? '<button type="button" class="mini-btn" data-x-done="' + r.id + '">완료</button>' : null), rowCls: (r) => (r.st === '보류' ? 'grey' : ''),
    chips: CH38(), sort: { k: 'due', d: 1 }, rank: (r) => (r.st === '보류' ? 1 : 0),
    foot: (rows) => ({ due: '경과 ' + rows.filter((r) => r.due && r.due < TODAY38 && r.st !== '완료').length }),
    detail: (r, ctx) => '<div class="vs-dh"><b>' + r.t + '</b>' + ctx.close + '</div><input type="text" data-keep="memo" value=""><button type="button" class="mini-btn" data-x-edit="' + r.id + '">수정</button>',
    bind: (root, r) => { if (log) log.push('bind:' + r.id); }, legacy: () => { if (log) log.push('legacy'); },
  }, o || {});
  const order38 = (h) => [...h.matchAll(/data-vs-row="([^"]*)"/g)].map((m) => m[1]).join('');
  const cg38 = (h) => ((h.match(/<colgroup>([\s\S]*?)<\/colgroup>/) || ['', ''])[1].match(/<col /g) || []).length;
  const th38 = (h) => ((h.match(/<thead><tr>([\s\S]*?)<\/tr>/) || ['', ''])[1].match(/<th[ >]/g) || []).length;
  const arrows38 = (h) => [...h.matchAll(/data-vs-sort="(\w+)"[^>]*>[^<]*<span class="vs-ar">(▲|▼)<\/span>/g)].map((m) => m[1] + m[2]).join(',') || '-';
  const cnt38 = (h) => (/<span class="vs-count">([^<]*)<\/span>/.exec(h) || ['', ''])[1];
  const chipTxt38 = (h, gk) => (new RegExp('data-vs-chip="' + gk.replace('|', '\\|') + '"[^>]*>([^<]*)</button>').exec(h) || ['', '?'])[1];
  const click38 = (host, sel, ev) => { const el = host.querySelector(sel); if (!el) throw new Error('시험 표에 없음: ' + sel); return el.fire('click', ev); };
  const minw38 = (h) => Number((/--vs-minw:(\d+)px/.exec(h) || [0, 0])[1]);

  // ② 단계별 colgroup 열 수(그 단계에 보이는 열만 — v374 교훈) · 머리 칸 수 · --vs-minw = 명세 단계별 열 합 · CSS 숨김 class · 처리 열(정렬 없음) · 남는 폭 열에 끌기 손잡이 없음
  const stg38 = [1000, 1366, 1920].map((w) => { const X = mk38({ width: w }), h = X.env.mkHost('vsT'); X.api.render(def38()); return { cg: cg38(h._h), th: th38(h._h), minw: minw38(h._h), h: h._h }; });
  const P38 = mk38({ width: 375 }), hP38 = P38.env.mkHost('vsT'); P38.api.render(def38({ phone: 'sheet' }));
  const h4_38 = stg38[2].h;
  T('v438 ② 단계별 colgroup·CSS 숨김: 열 수 860~1279 6 · 1280~1599 8 · 1600~ 10 · 폰 표 3(머리 칸 수도 같음) · 표 최소 폭(--vs-minw) = 명세 단계별 열 합 696 · 944 · 1174(남는 폭 열은 최소 220) · 칸 class lv2 vs-hs · lv3 vs-hs vs-l3 · lv4 vs-hs vs-l4 · lv1 없음 · 처리 열 = 정렬 없음(vs-ns, data-vs-sort 없음) · 남는 폭 열(지시 내용)에는 끌기 손잡이 없음 · CSS: 1279 이하 .vs .vs-l3 숨김·1280부터 보임 / 1599 이하 .vs .vs-l4 숨김·1600부터 보임',
    stg38.map((s) => s.cg + '/' + s.th + '/' + s.minw).join(',') === '6/6/696,8/8/944,10/10/1174' && cg38(hP38._h) === 3 && th38(hP38._h) === 3
    && /<th class="vs-hs" data-vs-sort="kind" title="누르면 정렬">구분/.test(h4_38) && /<th class="vs-hs vs-l3" data-vs-sort="stage"/.test(h4_38) && /<th class="vs-hs vs-l4" data-vs-sort="scope"/.test(h4_38) && /<th data-vs-sort="t" title="누르면 정렬">지시 내용<\/th>/.test(h4_38)
    && /<th class="vs-hs vs-ns">처리<span class="vs-rs" data-vs-rs="act"/.test(h4_38) && !/data-vs-sort="act"/.test(h4_38) && !/data-vs-rs="t"/.test(h4_38) && /<col data-vs-col="t" style="">/.test(h4_38)
    && decl38(1279, '.vs .vs-l3', 'display') === 'none' && decl38(1280, '.vs .vs-l3', 'display') == null && decl38(1599, '.vs .vs-l4', 'display') === 'none' && decl38(1600, '.vs .vs-l4', 'display') == null,
    JSON.stringify({ stg: stg38.map((s) => s.cg + '/' + s.th + '/' + s.minw), phone: cg38(hP38._h) + '/' + th38(hP38._h) }));

  // ③ 칩 — 묶음 안 하나·묶음끼리 AND · 건수 글 '보이는 n건 / 전체 m건' · 0건 글 · 모집단 칩(pop — 켜지지 않았으면 그 칩 행을 모든 칩에서 뺌) · 칩 건수(chipCount = 그 칩을 누르면 보일 건수)
  const A38 = mk38({ width: 1366 }), hA38 = A38.env.mkHost('vsT'), dA38 = def38(); A38.api.render(dA38);
  const ch38 = [[order38(hA38._h), cnt38(hA38._h)]];
  click38(hA38, '[data-vs-chip="st|over"]'); ch38.push([order38(hA38._h), cnt38(hA38._h)]);
  click38(hA38, '[data-vs-chip="kd|auto"]'); ch38.push([order38(hA38._h), cnt38(hA38._h), /<td colspan="8" class="vs-none">조건에 맞는 지시가 없습니다\.<\/td>/.test(hA38._h)]);
  click38(hA38, '[data-vs-chip="st|"]'); ch38.push([order38(hA38._h)]);
  click38(hA38, '[data-vs-chip="st|done"]'); ch38.push([order38(hA38._h)]);
  click38(hA38, '[data-vs-chip="st|all"]'); ch38.push([order38(hA38._h)]);
  click38(hA38, '[data-vs-chip="kd|"]'); ch38.push([order38(hA38._h), cnt38(hA38._h)]);
  const onCls38 = /class="vs-chip on" data-vs-chip="st\|all"/.test(hA38._h) && /class="vs-chip warn" data-vs-chip="st\|over"/.test(hA38._h) && /class="vs-chip on" data-vs-chip="kd\|"/.test(hA38._h);
  const popCh38 = () => [{ g: 'st', items: [{ k: '', h: '진행 중', test: (r) => r.st !== '완료' }, { k: 'old', h: '지남', pop: 1, warn: 1, test: (r) => !!r.old }, { k: 'all', h: '전체' }] }, CH38()[1]];
  const B38 = mk38({ width: 1366 }), hB38 = B38.env.mkHost('vsT'), dB38 = def38({ chips: popCh38(), chipCount: 1 }); B38.api.render(dB38);
  const pop38 = [order38(hB38._h), cnt38(hB38._h), ['st|', 'st|old', 'st|all', 'kd|', 'kd|auto'].map((k) => chipTxt38(hB38._h, k)).join(',')];
  click38(hB38, '[data-vs-chip="st|old"]'); pop38.push(order38(hB38._h), cnt38(hB38._h));
  click38(hB38, '[data-vs-chip="kd|auto"]'); pop38.push(order38(hB38._h), ['st|', 'st|old', 'st|all', 'kd|', 'kd|auto'].map((k) => chipTxt38(hB38._h, k)).join(','));
  //   칩 건수 = 그 칩을 실제로 눌렀을 때 '보이는 n건'(같은 시험 틀에서 눌러 보고 원래 칩으로 되돌림 — 기본·거르기 줄·검색어+전체 세 상태에서 칩 5개 모두) · 건수가 안 바뀌는 누름(행 펼침·닫기·정렬)은 칩 판정을 다시 안 부름(직전 건수 — v438 검토 '누를 때마다 칩 판정 수만 번')
  const num38 = (h, k) => Number((new RegExp('data-vs-chip="' + k.replace('|', '\\|') + '"[^>]*>[^<]* (\\d+)</button>').exec(h) || [0, -1])[1]);
  const vis38 = (h) => Number((/<span class="vs-count">보이는 (\d+)/.exec(h) || [0, -1])[1]);
  const onOf38 = (h, g) => (new RegExp('class="vs-chip[^"]* on" data-vs-chip="(' + g + '\\|[^"]*)"').exec(h) || [0, ''])[1];
  const eqCnt38 = (host) => { const bad = []; ['st|', 'st|old', 'st|all', 'kd|', 'kd|auto'].forEach((k) => { const shown = num38(host._h, k), back = onOf38(host._h, k.split('|')[0]); click38(host, '[data-vs-chip="' + k + '"]'); const got = vis38(host._h); if (shown !== got) bad.push(k + ':' + shown + '≠' + got); click38(host, '[data-vs-chip="' + back + '"]'); }); return bad.join(','); };
  let tc38 = 0;
  const cntCh38 = () => [popCh38()[0], { g: 'kd', items: [{ k: '', h: '구분 전체' }, { k: 'auto', h: '자동', test: (r) => { tc38++; return r.kind === '자동'; } }] }];
  const E38 = mk38({ width: 1366 }), hE38 = E38.env.mkHost('vsT'), dE38 = def38({ chips: cntCh38(), chipCount: 1, search: { text: (r) => r.t } }); E38.api.render(dE38);
  const eq38 = [eqCnt38(hE38)];
  E38.api.filter(dE38, 'who', '김'); eq38.push(eqCnt38(hE38));
  E38.api.setQ(dE38, '준설'); click38(hE38, '[data-vs-chip="st|all"]'); eq38.push(eqCnt38(hE38), order38(hE38._h));
  tc38 = 0; click38(hE38, '[data-vs-row="a"]'); click38(hE38, '[data-vs-close]'); click38(hE38, '[data-vs-sort="who"]'); const tcKeep38 = tc38;
  tc38 = 0; E38.api.filter(dE38, 'who', ''); const tcNew38 = tc38;
  T('v438 ③ 칩: 기본(진행 중) gabcd "보이는 5건 / 전체 7건" · 기한 경과 gad "보이는 3건" · 경과 AND 자동 = 0건(빈 줄 "조건에 맞는 지시가 없습니다.") · 진행 중 AND 자동 b · 완료 AND 자동 f · 전체 AND 자동 fb · 전체 7건 fegabcd · 켜진 칩만 on·빨강 칩 warn · 모집단 칩(지남 pop): 기본은 지남 행(g)을 빼고 abcd "보이는 4건 / 전체 6건"·칩 건수 "진행 중 4·지남 1·전체 6·구분 전체 4·자동 1" → 지남 g "보이는 1건 / 전체 1건" → 지남 AND 자동 0건·칩 건수 "진행 중 1·지남 0·전체 2·구분 전체 1·자동 0" · 칩 건수 = 그 칩을 눌렀을 때 보이는 건수(기본·담당 김·검색 "준설"+전체 세 상태 × 칩 5개) · 행 펼침·닫기·정렬 때 안 켜진 칩 판정 0번(직전 건수) · 거르기를 바꾸면 다시 셈',
    JSON.stringify(ch38) === JSON.stringify([['gabcd', '보이는 5건 / 전체 7건'], ['gad', '보이는 3건 / 전체 7건'], ['', '보이는 0건 / 전체 7건', true], ['b'], ['f'], ['fb'], ['fegabcd', '보이는 7건 / 전체 7건']]) && onCls38
    && JSON.stringify(pop38) === JSON.stringify(['abcd', '보이는 4건 / 전체 6건', '진행 중 4,지남 1,전체 6,구분 전체 4,자동 1', 'g', '보이는 1건 / 전체 1건', '', '진행 중 1,지남 0,전체 2,구분 전체 1,자동 0'])
    && JSON.stringify(eq38) === JSON.stringify(['', '', '', 'ac']) && tcKeep38 === 0 && tcNew38 > 0,
    JSON.stringify({ ch38, onCls38, pop38, eq38, tcKeep38, tcNew38 }));

  // ④ 정렬 — 머리 누름 ▲▼(같은 열은 방향만) · 빈 값(기한 없는 c)은 방향과 상관없이 뒤 · rank(보류 d)는 방향과 상관없이 맨 뒤 · 처리 열은 정렬 없음 · 칩별 기본 정렬(완료 = 완료일 최근 먼저, 사람 정렬은 그 칩으로 가거나 나올 때만 풀림)
  //   · 정렬 별칭(경과 = 등록일 반대 — sortAs·sortRev: 경과 머리 ▲·등록일 머리 ▼) · 1600 이상에서 완료 칩 = 완료 머리 ▼
  const S38 = mk38({ width: 1366 }), hS38 = S38.env.mkHost('vsT'), dS38 = def38(); S38.api.render(dS38);
  const so38 = [[order38(hS38._h), arrows38(hS38._h)]];
  click38(hS38, '[data-vs-sort="due"]'); so38.push([order38(hS38._h), arrows38(hS38._h)]);
  click38(hS38, '[data-vs-sort="due"]'); so38.push([order38(hS38._h), arrows38(hS38._h)]);
  click38(hS38, '[data-vs-sort="who"]'); so38.push([order38(hS38._h), arrows38(hS38._h)]);
  click38(hS38, '[data-vs-chip="st|done"]'); so38.push([order38(hS38._h), arrows38(hS38._h)]);
  click38(hS38, '[data-vs-chip="st|"]'); so38.push([order38(hS38._h), arrows38(hS38._h)]);
  click38(hS38, '[data-vs-sort="who"]'); click38(hS38, '[data-vs-chip="st|over"]'); so38.push([order38(hS38._h), arrows38(hS38._h)]);
  const S4_38 = mk38({ width: 1920 }), hS4_38 = S4_38.env.mkHost('vsT'), dS4_38 = def38(); S4_38.api.render(dS4_38); click38(hS4_38, '[data-vs-chip="st|done"]');
  const al38 = mk38({ width: 1366 }), hAl38 = al38.env.mkHost('vsT'), dAl38 = def38({ cols: C38().concat([{ k: 'age', h: '경과', w: 64, f: 'none', lv: 2, sortAs: 'reg', sortRev: 1 }]) }); al38.api.render(dAl38);
  click38(hAl38, '[data-vs-sort="age"]'); const alias38 = [order38(hAl38._h), arrows38(hAl38._h)]; click38(hAl38, '[data-vs-sort="age"]'); alias38.push(order38(hAl38._h), arrows38(hAl38._h));
  //   1920에서 고른 lv4 열(공개) 정렬은 1366으로 좁히면 안 보이는 열이라 기본 정렬(기한 ▲)로 · 기억(st.k)은 남아 다시 넓히면 공개 ▲(v438 검토 — 안 보이는 열로 정렬된 채 ▲▼가 어디에도 없던 것)
  const HS38 = mk38({ width: 1920 }), hHS38 = HS38.env.mkHost('vsT'), dHS38 = def38(); HS38.api.render(dHS38); click38(hHS38, '[data-vs-sort="scope"]');
  const hs38 = [order38(hHS38._h), arrows38(hHS38._h)]; HS38.env.width = 1366; HS38.env.breakAll(); hs38.push(order38(hHS38._h), arrows38(hHS38._h), HS38.api.inst(dHS38).st.k);
  click38(hHS38, '[data-vs-sort="due"]'); hs38.push(arrows38(hHS38._h)); HS38.env.width = 1920; HS38.env.breakAll(); hs38.push(arrows38(hHS38._h));
  const HS2_38 = mk38({ width: 1920 }), hHS2_38 = HS2_38.env.mkHost('vsT'), dHS2_38 = def38(); HS2_38.api.render(dHS2_38); click38(hHS2_38, '[data-vs-sort="scope"]'); HS2_38.env.width = 1366; HS2_38.env.breakAll(); HS2_38.env.width = 1920; HS2_38.env.breakAll(); hs38.push(order38(hHS2_38._h), arrows38(hHS2_38._h));
  T('v438 ④ 정렬: 기본 기한 ▲ gabcd(빈 기한 c는 뒤·보류 d는 맨 뒤) → 기한 머리 ▼ bagcd(c·d 그대로 뒤) → ▲ gabcd → 담당 ▲ acgbd · 완료 칩(칩별 기본 정렬 완료일 ↓ — 사람 정렬 풀림) fe → 진행 중으로 나오면 정의 기본 기한 ▲ gabcd → 담당 정렬 뒤 기한 경과 칩(기본 정렬 없는 칩)은 담당 ▲ 그대로 agd · 1600 이상 완료 칩 = 완료 머리 ▼ · 정렬 별칭 경과(= 등록일 반대): 누르면 등록일 최근 먼저 cabgd·경과 ▲·등록일 ▼ → 다시 누르면 gbacd·경과 ▼·등록일 ▲ · 1920에서 공개(lv4) ▲ bacgd → 1366이면 안 보이는 열이라 기본 기한 ▲ gabcd(기억 scope 남음) → 기한 머리 = 기본 기한 ▼로 뒤집힘 → 1920으로 넓히면 기한 ▼ 그대로 / 공개 ▲ 뒤 좁혔다 넓히면 공개 ▲ 되살림',
    JSON.stringify(so38) === JSON.stringify([['gabcd', 'due▲'], ['bagcd', 'due▼'], ['gabcd', 'due▲'], ['acgbd', 'who▲'], ['fe', '-'], ['gabcd', 'due▲'], ['agd', 'who▲']])
    && order38(hS4_38._h) === 'fe' && arrows38(hS4_38._h) === 'done▼' && JSON.stringify(alias38) === JSON.stringify(['cabgd', 'reg▼,age▲', 'gbacd', 'reg▲,age▼'])
    && JSON.stringify(hs38) === JSON.stringify(['bacgd', 'scope▲', 'gabcd', 'due▲', 'scope', 'due▼', 'due▼', 'bacgd', 'scope▲']),
    JSON.stringify({ so38, s4: [order38(hS4_38._h), arrows38(hS4_38._h)], alias38, hs38 }));

  // ⑤ 거르기 줄 — 글자 칸은 마지막 입력 150ms 뒤 한 번만(149ms엔 안 그림) · 한글 조합 중(compositionstart~end — isComposing 없이 오는 input도)엔 안 그리고 compositionend 뒤 150ms · 칸마다 따로 기다림(다른 칸을 쳐도 앞 칸 글이 안 사라짐) · 고르기(enum)는 바로 · 칩과 AND
  const F38 = mk38({ width: 1366 }), hF38 = F38.env.mkHost('vsT'), dF38 = def38(); F38.api.render(dF38);
  const pf38 = F38.env.paints, fr38 = [];
  let ti38 = hF38.querySelector('[data-vf="t"]'); ti38.value = '준설'; ti38.fire('input', {});
  fr38.push(F38.env.paints - pf38); F38.env.tick(149); fr38.push(F38.env.paints - pf38); F38.env.tick(1); fr38.push(F38.env.paints - pf38, order38(hF38._h));
  ti38 = hF38.querySelector('[data-vf="t"]'); ti38.fire('compositionstart'); ti38.value = '성'; ti38.fire('input', { isComposing: true }); ti38.fire('input', {}); F38.env.tick(300); fr38.push(F38.env.paints - pf38);
  ti38.fire('compositionend'); F38.env.tick(149); fr38.push(F38.env.paints - pf38); F38.env.tick(1); fr38.push(F38.env.paints - pf38, order38(hF38._h));
  F38.api.reset(dF38);
  const ta38 = hF38.querySelector('[data-vf="t"]'), tb38 = hF38.querySelector('[data-vf="stage"]');
  ta38.value = '착공'; ta38.fire('input', {}); F38.env.tick(50); tb38.value = '/9'; tb38.fire('input', {}); F38.env.tick(150); fr38.push(order38(hF38._h));
  F38.api.reset(dF38); const pe38 = F38.env.paints; const se38 = hF38.querySelector('[data-vf="who"]'); se38.value = '박'; se38.fire('change'); fr38.push(F38.env.paints - pe38, order38(hF38._h), cnt38(hF38._h));
  //   두 음절(한글은 음절마다 앞 음절 compositionend → 곧바로 다음 compositionstart — v438 검토 '준서ㄹ'): '준' 확정 뒤 '서' 조합 중 300ms = 0번·같은 요소(앞 음절이 건 150ms를 compositionstart가 지움 — 포커스 없이 봄)
  //   → 마지막 compositionend 뒤 149ms 0번·150ms 1번, 걸린 거르기 "준서"
  F38.api.reset(dF38); F38.doc.activeElement = null; const p2_38 = F38.env.paints, t2_38 = hF38.querySelector('[data-vf="t"]');
  t2_38.fire('compositionstart'); t2_38.value = '준'; t2_38.fire('input', { isComposing: true }); t2_38.fire('compositionend'); t2_38.fire('compositionstart'); t2_38.value = '준서'; t2_38.fire('input', { isComposing: true }); F38.env.tick(300);
  const syl38 = [F38.env.paints - p2_38, hF38.querySelector('[data-vf="t"]') === t2_38];
  t2_38.fire('compositionend'); F38.env.tick(149); syl38.push(F38.env.paints - p2_38); F38.env.tick(1); syl38.push(F38.env.paints - p2_38, F38.api.inst(dF38).st.f.t || '');
  //   조합 중인 칸에 포커스가 있을 때 다른 일(자료 갱신·다른 칸 거르기)로 다시 그리면 미룸 = 0번·같은 요소 → 그 칸의 compositionend 뒤 150ms에 1번(담당 김 AND "준설" = ac)
  F38.api.reset(dF38); const p3_38 = F38.env.paints, t3_38 = hF38.querySelector('[data-vf="t"]');
  t3_38.focus(); t3_38.fire('compositionstart'); t3_38.value = '준설'; t3_38.fire('input', { isComposing: true }); F38.api.render(dF38); F38.api.filter(dF38, 'who', '김');
  const dfr38 = [F38.env.paints - p3_38, hF38.querySelector('[data-vf="t"]') === t3_38];
  t3_38.fire('compositionend'); F38.env.tick(150); dfr38.push(F38.env.paints - p3_38, order38(hF38._h));
  //   치던 중 [필터 초기화] = 기다리던 150ms도 지움(초기화 뒤 옛 글이 다시 걸리지 않음)
  F38.api.reset(dF38); F38.doc.activeElement = null; const t4_38 = hF38.querySelector('[data-vf="t"]'); t4_38.value = '준설'; t4_38.fire('input', {}); F38.env.tick(50); F38.api.reset(dF38); const p4_38 = F38.env.paints; F38.env.tick(300);
  const rst38 = [F38.env.paints - p4_38, JSON.stringify(F38.api.inst(dF38).st.f), order38(hF38._h)];
  T('v438 ⑤ 거르기 줄: 글자 칸 "준설" → 바로 0번·149ms 0번·150ms 1번 그림(ac) · 한글 조합 중 input(isComposing·없음 둘 다) 300ms 지나도 0번 → compositionend 뒤 149ms 0번·150ms 1번(c) · 칸마다 따로 기다림: 지시 내용 "착공" 50ms 뒤 계약 단계 "/9" = 둘 다 걸려 a(앞 칸 글이 사라지면 ac) · 담당 고르기 "박"은 바로 1번 = gd "보이는 2건 / 전체 7건"(칩 진행 중과 AND) · 두 음절 "준서": 둘째 음절 조합 중 300ms 0번·같은 요소 → 마지막 compositionend 뒤 149ms 0번·150ms 1번("준서") · 조합 중 다른 일로 그림 = 미룸(0번·같은 요소) → compositionend 뒤 1번(ac) · 치던 중 필터 초기화 = 기다리던 거르기도 지움(초기화 뒤 0번·거르기 없음·gabcd)',
    JSON.stringify(fr38) === JSON.stringify([0, 0, 1, 'ac', 1, 1, 2, 'c', 'a', 1, 'gd', '보이는 2건 / 전체 7건'])
    && JSON.stringify(syl38) === JSON.stringify([0, true, 0, 1, '준서']) && JSON.stringify(dfr38) === JSON.stringify([0, true, 1, 'ac']) && JSON.stringify(rst38) === JSON.stringify([0, '{}', 'gabcd']),
    JSON.stringify({ fr38, syl38, dfr38, rst38 }));

  // ⑥ 폭 끌기 — pointer 이벤트(pointerdown은 손잡이, pointermove·pointerup·pointercancel은 document — 놓으면 셋 다 해제) · 40~600 · 끌기 중 --vs-minw = 끈 폭을 반영한 고정 열 합 + 남는 열 최소 폭
  //   → 표 칸 742·1048·1065에서 남는 열(지시 내용) = max(표 칸, --vs-minw) − 고정 열 합 ≥ 220 · 놓은 직후 머리 누름은 정렬 안 함(400ms) · 다시 그려도 끈 폭 유지(메모리) · 끈 폭은 기기 저장 안 함 · 오른쪽 단추는 끌기 아님
  const G38 = mk38({ width: 1366 }), hG38 = G38.env.mkHost('vsT'), dG38 = def38(); G38.api.render(dG38);
  hG38.querySelector('[data-vs-rs="stage"]').fire('pointerdown', { button: 0, clientX: 500 });
  const lisOn38 = (G38.doc.L.pointermove || []).length === 1 && (G38.doc.L.pointerup || []).length === 1 && (G38.doc.L.pointercancel || []).length === 1;
  G38.doc.L.pointermove[0]({ clientX: 800 });
  const colSt38 = hG38.querySelector('[data-vs-col="stage"]').style.width, tblW38 = hG38.querySelector('[data-vs-table]').style.getPropertyValue('--vs-minw');
  const fixed38 = 108 + 460 + 76 + 144 + 88 + 88 + 60, fill38 = [742, 1048, 1065].map((w) => Math.max(w, parseFloat(tblW38)) - fixed38);
  G38.doc.L.pointerup[0]({});
  const lisOff38 = !(G38.doc.L.pointermove || []).length && !(G38.doc.L.pointerup || []).length && !(G38.doc.L.pointercancel || []).length;
  hG38.querySelector('[data-vs-rs="kind"]').fire('pointerdown', { button: 0, clientX: 0 }); G38.doc.L.pointermove[0]({ clientX: -1000 });
  const kMin38 = hG38.querySelector('[data-vs-col="kind"]').style.width; G38.doc.L.pointermove[0]({ clientX: 5000 }); const kMax38 = hG38.querySelector('[data-vs-col="kind"]').style.width; G38.doc.L.pointerup[0]({});
  click38(hG38, '[data-vs-sort="kind"]'); const noSort38 = arrows38(hG38._h) === 'due▲';
  G38.env.now += 500; click38(hG38, '[data-vs-sort="kind"]'); const sorted38 = arrows38(hG38._h) === 'kind▲';
  const keepW38 = /<col data-vs-col="stage" style="width:460px;">/.test(hG38._h) && /<col data-vs-col="kind" style="width:600px;">/.test(hG38._h) && minw38(hG38._h) === 220 + 600 + 460 + 76 + 144 + 88 + 88 + 60;
  const stored38 = G38.env.store.jw_task_sheet || '';
  hG38.querySelector('[data-vs-rs="kind"]').fire('pointerdown', { button: 2, clientX: 0 }); const rb38 = !(G38.doc.L.pointermove || []).length;
  //   끌기를 시작한 포인터 하나만(v438 검토): 다른 손가락(pointerId 2)의 이동·놓기 무시 → 시작한 손가락 이동만 반영·놓으면 끝 · 보조 포인터(isPrimary false)는 시작 안 함
  //   · 마우스 단추 없이 움직이면(창 밖에서 놓쳐 pointerup이 안 옴) 끌기 끝·폭 그대로 · 끄는 중 다른 일로 다시 그려도 새 표의 col·--vs-minw가 손을 따라감
  const GP38 = mk38({ width: 1366 }), hGP38 = GP38.env.mkHost('vsT'), dGP38 = def38(); GP38.api.render(dGP38);
  const kw38 = () => hGP38.querySelector('[data-vs-col="kind"]').style.width, nmv38 = () => (GP38.doc.L.pointermove || []).length;
  const pmv38 = (ev) => { (GP38.doc.L.pointermove || []).slice().forEach((f) => f(ev)); }, pup38 = (ev) => { (GP38.doc.L.pointerup || []).slice().forEach((f) => f(ev)); };   // 리스너가 없으면 아무 일 없음(결함이면 이 검사가 ✗ — 시험 틀이 멈추지 않게)
  hGP38.querySelector('[data-vs-rs="kind"]').fire('pointerdown', { button: 0, clientX: 0, pointerId: 1, pointerType: 'touch', isPrimary: true });
  pmv38({ clientX: 50, pointerId: 2, pointerType: 'touch' }); const pid38 = [kw38()];
  pup38({ pointerId: 2, pointerType: 'touch' }); pid38.push(nmv38());
  pmv38({ clientX: 30, pointerId: 1, pointerType: 'touch' }); pid38.push(kw38());
  pup38({ pointerId: 1, pointerType: 'touch' }); pid38.push(nmv38());
  hGP38.querySelector('[data-vs-rs="kind"]').fire('pointerdown', { button: 0, clientX: 0, pointerId: 3, pointerType: 'touch', isPrimary: false }); pid38.push(nmv38());
  hGP38.querySelector('[data-vs-rs="kind"]').fire('pointerdown', { button: 0, clientX: 0, pointerId: 4, pointerType: 'mouse', buttons: 1 });
  pmv38({ clientX: 200, pointerId: 4, pointerType: 'mouse', buttons: 0 }); pid38.push(nmv38(), kw38());
  pup38({}); GP38.doc.L.pointermove = []; GP38.doc.L.pointerup = []; GP38.doc.L.pointercancel = [];   // 앞 단계가 깨졌을 때 남은 리스너를 치워 아래 '끄는 중 다시 그림'만 따로 봄
  hGP38.querySelector('[data-vs-rs="kind"]').fire('pointerdown', { button: 0, clientX: 0 }); GP38.api.render(dGP38); pmv38({ clientX: 100 });
  pid38.push(kw38(), hGP38.querySelector('[data-vs-table]').style.getPropertyValue('--vs-minw')); pup38({}); pid38.push(nmv38());
  T('v438 ⑥ 폭 끌기(pointer): 손잡이 pointerdown → document pointermove·pointerup·pointercancel 1개씩 · 계약 단계 +300 = col 460px·--vs-minw 1244px(= 944 + 300) · 표 칸 742/1048/1065에서 남는 열 ' + fill38.join('/') + ' ≥ 최소 220 · 놓으면 리스너 0 · 40~600(−1000 → 40px · +5000 → 600px) · 놓은 직후 머리 누름은 정렬 안 함·500ms 뒤 정렬 · 다시 그려도 끈 폭(460·600)과 --vs-minw 유지 · 기기 저장에 끈 폭 없음 · 오른쪽 단추는 끌기 아님 · 다른 손가락 이동(108px 그대로)·놓기(리스너 남음) 무시 → 시작한 손가락 +30 = 138px → 놓으면 0 · 보조 포인터는 시작 안 함 · 마우스 단추 없이 움직이면 끝(리스너 0·138px 그대로) · 끄는 중 다시 그려도 새 표 col 238px·--vs-minw 1074px(= 944 + 130)',
    lisOn38 && colSt38 === '460px' && tblW38 === '1244px' && fill38.every((x) => x >= 220) && lisOff38 && kMin38 === '40px' && kMax38 === '600px' && noSort38 && sorted38 && keepW38
    && stored38.length > 0 && stored38.indexOf('460') < 0 && stored38.indexOf('600') < 0 && stored38.indexOf('colw') < 0 && rb38
    && JSON.stringify(pid38) === JSON.stringify(['108px', 1, '138px', 0, 0, 0, '138px', '238px', '1074px', 0]),
    JSON.stringify({ lisOn38, colSt38, tblW38, fill38, lisOff38, kMin38, kMax38, noSort38, sorted38, keepW38, stored38, rb38, pid38 }));

  // ⑦ 기기 기억(localStorage) — 저장 이름은 명세 common.memory 8개(jw_*_sheet)뿐 · 저장은 def.key 하나에 {k,d,f,chip}만(끈 폭·검색어·펼침 없음) · 옛 기억은 정의에 있는 열·칩·값만 받아들임 · 깨진 기억이면 빈 상태로(던지지 않음)
  const K38 = mk38({ width: 1366, store: { jw_task_sheet: JSON.stringify({ k: 'who', d: -1, f: { t: '준설', bogus: 'x', due: 'y' }, chip: { st: 'over', kd: 'nope', zz: 'q' }, colw: { t: 500 } }) } });
  const hK38 = K38.env.mkHost('vsT'), dK38 = def38(); K38.api.render(dK38);
  const kst38 = K38.api.inst(dK38).st, kld38 = [kst38.k, kst38.d, JSON.stringify(kst38.f), JSON.stringify(kst38.chip), Object.keys(K38.api.inst(dK38).colw).length, order38(hK38._h), arrows38(hK38._h)];
  click38(hK38, '[data-vs-chip="kd|auto"]');
  const ksv38 = JSON.parse(K38.env.store.jw_task_sheet);
  const K2_38 = mk38({ width: 1366, store: { jw_task_sheet: '{깨짐' } }); K2_38.env.mkHost('vsT'); const kr2_38 = K2_38.api.render(def38()), kb2_38 = JSON.stringify(K2_38.api.inst(def38()).st);
  //   저장소가 던지면(개인 창·사이트 데이터 차단 — getItem·setItem 모두) 그리기·칩 누름·거르기가 오류 없이 되고 상태는 메모리에 남음(v438 검토)
  let thr38 = '';
  try { const K3_38 = mk38({ width: 1366, throwStore: 1 }), hK3_38 = K3_38.env.mkHost('vsT'), dK3_38 = def38(); thr38 = K3_38.api.render(dK3_38); click38(hK3_38, '[data-vs-chip="kd|auto"]'); K3_38.api.filter(dK3_38, 'who', '이'); thr38 += ':' + order38(hK3_38._h) + ':' + JSON.stringify(K3_38.api.inst(dK3_38).st.chip) + JSON.stringify(K3_38.api.inst(dK3_38).st.f); } catch (e) { thr38 = '던짐 ' + e.message; }
  T('v438 ⑦ 기기 기억: 저장 이름 = 명세 8개(jw_task_sheet·jw_rec_sheet·jw_cli_sheet·jw_wk_sheet·jw_bid_sheet·jw_ob_sheet·jw_site_sheet·jw_edu_sheet — 계약·차량 키 아님) · 옛 기억 읽기 = 정렬 담당 ▼·거르기는 정의에 있는 글자/고르기 열만(모르는 열·거르기 없음 열 버림)·칩은 있는 값만·끈 폭은 안 읽음 → 기한 경과 AND "준설" = a · 칩을 누르면 jw_task_sheet 한 곳에만 저장·키는 k,d,f,chip 넷뿐 · 깨진 기억은 빈 상태로 그림 · 저장소가 던져도(읽기·쓰기) 그리기·칩·거르기 오류 없음(자동 AND 담당 이 = b, 상태는 메모리)',
    JSON.stringify(K38.api.KEYS) === JSON.stringify(['jw_task_sheet', 'jw_rec_sheet', 'jw_cli_sheet', 'jw_wk_sheet', 'jw_bid_sheet', 'jw_ob_sheet', 'jw_site_sheet', 'jw_edu_sheet'])
    && JSON.stringify(kld38) === JSON.stringify(['who', -1, '{"t":"준설"}', '{"st":"over"}', 0, 'a', 'who▼'])
    && K38.env.sets.length >= 1 && K38.env.sets.every((k) => k === 'jw_task_sheet') && Object.keys(ksv38).join() === 'k,d,f,chip' && ksv38.chip.kd === 'auto' && ksv38.chip.st === 'over' && ksv38.f.t === '준설'
    && kr2_38 === 'sheet' && kb2_38 === '{"k":"","d":1,"f":{},"chip":{}}' && thr38 === 'sheet:b:{"kd":"auto"}{"who":"이"}',
    JSON.stringify({ kld38, sets: K38.env.sets, ksv38, kr2_38, kb2_38, thr38 }));

  // ⑧ 다시 그릴 때(자료 갱신·폴링 같은 다른 일로) — 펼친 행 · 펼침 안 입력값(data-keep) · 거르기 칸 포커스·치던 글·커서 · 표 칸 스크롤(가로·세로) 그대로 · 행 안 버튼 누름은 펼침으로 안 번짐 · [닫기 ▲] · 거르기로 빠진 펼친 행은 닫힘 · 펼침 배선(bind) 불림
  const lg8 = [], R38 = mk38({ width: 1366 }), hR38 = R38.env.mkHost('vsT'), dR38 = def38({}, lg8); R38.api.render(dR38);
  click38(hR38, '[data-vs-row="a"]');
  const o1_38 = /<tr class="vs-r open" data-vs-row="a">/.test(hR38._h) && /data-vs-det="a"/.test(hR38._h) && lg8.indexOf('bind:a') >= 0;
  hR38.querySelector('[data-keep="memo"]').value = '적던 글';
  const w0_38 = hR38.querySelector('[data-vs-wrap]'); w0_38.scrollLeft = 120; w0_38.scrollTop = 33;
  const f0_38 = hR38.querySelector('[data-vf="t"]'); f0_38.value = '가 준'; f0_38.focus(); f0_38.selectionStart = 2;
  const pr38 = R38.env.paints; R38.api.render(dR38);
  const f1_38 = hR38.querySelector('[data-vf="t"]'), w1_38 = hR38.querySelector('[data-vs-wrap]');
  const o2_38 = R38.env.paints === pr38 + 1 && hR38.querySelector('[data-keep="memo"]').value === '적던 글' && /data-vs-det="a"/.test(hR38._h) && w1_38 !== w0_38 && w1_38.scrollLeft === 120 && w1_38.scrollTop === 33
    && R38.doc.activeElement === f1_38 && f1_38 !== f0_38 && f1_38.value === '가 준' && R38.env.log.indexOf('caret:2') >= 0;
  const trB38 = hR38.querySelector('[data-vs-row="b"]'); trB38.fire('click', { target: { tagName: 'BUTTON', parentNode: trB38 } });
  const o3_38 = !/data-vs-det="b"/.test(hR38._h) && /data-vs-det="a"/.test(hR38._h);
  click38(hR38, '[data-vs-close]'); const o4_38 = !/data-vs-det=/.test(hR38._h) && R38.api.inst(dR38).open === null;
  click38(hR38, '[data-vs-row="b"]'); const o5a38 = /data-vs-det="b"/.test(hR38._h); R38.api.filter(dR38, 'who', '김'); const o5_38 = o5a38 && !/data-vs-det=/.test(hR38._h) && R38.api.inst(dR38).open === null && order38(hR38._h) === 'ac';
  //   data-keep은 같은 행이 펼쳐져 있을 때만(v438 검토 — A를 연 채 B를 누르면 A에 적던 글이 B 칸에 들어가 B로 저장): a 펼침 메모 칸에 포커스·"A에 적던 글"·커서 3 → 다른 일로 다시 그림 = 같은 칸에 포커스·커서 3·글 그대로
  //   → b 행 누름 = b 칸은 b 값 "B메모"·포커스는 b 칸으로 안 감 · 라디오(data-keep 같은 이름 둘)는 value 그대로·고른 것 유지 · 다른 자리(다른 표·창)에 있는 포커스는 가져오지 않음
  const dK8 = (detail) => def38({ detail }), mem8 = (r, ctx) => '<div class="vs-dh"><b>' + r.t + '</b>' + ctx.close + '</div><input type="text" data-keep="memo" value="' + (r.id === 'b' ? 'B메모' : '') + '">';
  const R2_38 = mk38({ width: 1366 }), hR2_38 = R2_38.env.mkHost('vsT'), dR2_38 = dK8(mem8); R2_38.api.render(dR2_38); click38(hR2_38, '[data-vs-row="a"]');
  let m8 = hR2_38.querySelector('[data-keep="memo"]'); m8.value = 'A에 적던 글'; m8.focus(); m8.selectionStart = 3; R2_38.env.log.length = 0; R2_38.api.render(dR2_38);
  const m8b = hR2_38.querySelector('[data-keep="memo"]'), o6_38 = m8b !== m8 && m8b.value === 'A에 적던 글' && R2_38.doc.activeElement === m8b && R2_38.env.log.indexOf('caret:3') >= 0;
  click38(hR2_38, '[data-vs-row="b"]'); const m8c = hR2_38.querySelector('[data-keep="memo"]'), o7_38 = /data-vs-det="b"/.test(hR2_38._h) && m8c.value === 'B메모' && R2_38.doc.activeElement !== m8c;
  const R3_38 = mk38({ width: 1366 }), hR3_38 = R3_38.env.mkHost('vsT'), dR3_38 = dK8(() => '<input type="radio" name="pk" data-keep="pick" value="1" checked><input type="radio" name="pk" data-keep="pick" value="2">'); R3_38.api.render(dR3_38); click38(hR3_38, '[data-vs-row="a"]');
  let rd8 = hR3_38.querySelectorAll('[data-keep="pick"]'); rd8[0].checked = false; rd8[1].checked = true; R3_38.api.render(dR3_38); rd8 = hR3_38.querySelectorAll('[data-keep="pick"]');
  const o8_38 = rd8.map((e) => e.value + ':' + e.checked).join() === '1:false,2:true';
  const R4_38 = mk38({ width: 1366 }), hR4_38 = R4_38.env.mkHost('vsT'), hO38 = R4_38.env.mkHost('vsOther'); R4_38.api.render(def38()); hO38.innerHTML = '<input type="text" data-vf="t" value="다른 표">';
  const oe38 = hO38.querySelector('[data-vf="t"]'); oe38.focus(); R4_38.api.render(def38()); const o9_38 = R4_38.doc.activeElement === oe38;
  T('v438 ⑧ 다시 그릴 때 유지: 행 누름 = 한 건 펼침(open·data-vs-det·펼침 배선 bind) · 다른 일로 다시 그려도 펼친 행·펼침 안 입력값 "적던 글"(data-keep)·거르기 칸 포커스(새 요소)·치던 글 "가 준"·커서 2·표 칸 스크롤 120/33 그대로 · 행 안 버튼 누름은 펼침으로 안 번짐 · [닫기 ▲]로 접힘 · 펼친 행이 거르기로 빠지면 닫힘 · 펼침 칸(data-keep) 포커스·커서 3·글 유지 → 다른 행 누르면 그 행 값(B메모)·포커스 안 옮김 · 라디오 value·고른 것 유지 · 다른 자리 포커스는 안 가져옴',
    o1_38 && o2_38 && o3_38 && o4_38 && o5_38 && o6_38 && o7_38 && o8_38 && o9_38, JSON.stringify({ o1_38, o2_38, o3_38, o4_38, o5_38, o6_38, o7_38, o8_38, o9_38, log: R38.env.log }));

  // ⑨ 폰 갈래 — legacy(기본): 859px 이하면 탭의 지금 그리기 함수를 인자 없이 그대로 부르고 그 자리 글은 옛 함수 몫(부품이 덧쓰지 않음) · PC 표가 있던 자리면 먼저 비움 · 경계 넘을 때 한 번만(같은 단계 안·같은 경계 두 번째는 다시 안 그림)
  //   sheet: 폰 열(lv1) 3·--pw 52/24/24·끌기 손잡이 없음·PC 전용 칩은 vs-pc·누른 행 상세는 표 아래 .vs-detcard(표 안 펼침 없음)+화면 안으로 · PC로 넘어가면 표 안 펼침 · 숨은 표는 경계 때 stale만, 보일 때 ResizeObserver 콜백 → 다음 그림(rAF)에 한 번
  const lq38 = [], Q38 = mk38({ width: 375 }), hQ38 = Q38.env.mkHost('vsT');
  const dQ38 = def38({ legacy: function () { lq38.push('legacy:' + arguments.length); hQ38.innerHTML = '<div class="item">옛 화면</div>'; } });
  const rq38 = Q38.api.render(dQ38);
  const q1_38 = rq38 === 'legacy' && lq38.join() === 'legacy:0' && hQ38._h === '<div class="item">옛 화면</div>' && hQ38.getAttribute('data-vs-mode') === 'legacy' && Q38.env.paints === 1;
  const lq2_38 = [], Q2_38 = mk38({ width: 1366 }), hQ2_38 = Q2_38.env.mkHost('vsT');
  const dQ2_38 = def38({ legacy: () => { lq2_38.push(hQ2_38._h.indexOf('data-vs-wrap') >= 0 ? 'legacy:표 남음' : 'legacy:빈 자리'); } });
  Q2_38.api.render(dQ2_38); const pq38 = Q2_38.env.paints;
  Q2_38.env.width = 375; Q2_38.env.breakAll(); Q2_38.env.breakAll();
  const q2_38 = lq2_38.join() === 'legacy:빈 자리' && hQ2_38._h === '' && Q2_38.env.paints === pq38 + 1 && Q2_38.env.mql.length === 3;
  Q2_38.env.width = 1366; Q2_38.env.breakAll(); Q2_38.env.breakAll();
  const q3_38 = /data-vs-wrap/.test(hQ2_38._h) && lq2_38.length === 1 && Q2_38.env.paints === pq38 + 2;
  const Q3_38 = mk38({ width: 1366 }), hQ3_38 = Q3_38.env.mkHost('vsT'), dQ3_38 = def38(); Q3_38.api.render(dQ3_38); const pq3_38 = Q3_38.env.paints;
  Q3_38.env.width = 1700; Q3_38.env.breakAll(); const q4a38 = Q3_38.env.paints === pq3_38 + 1 && cg38(hQ3_38._h) === 10; Q3_38.env.width = 1710; Q3_38.env.breakAll();
  const q4_38 = q4a38 && Q3_38.env.paints === pq3_38 + 1;
  const SP38 = mk38({ width: 375 }), hSP38 = SP38.env.mkHost('vsT'), dSP38 = def38({ phone: 'sheet' }); const rs38 = SP38.api.render(dSP38);
  const s1_38 = rs38 === 'sheet' && cg38(hSP38._h) === 3 && (hSP38._h.match(/--pw:\d+%/g) || []).join() === '--pw:52%,--pw:24%,--pw:24%' && !/data-vs-rs=/.test(hSP38._h) && /class="vs-chip vs-pc" data-vs-chip="st\|all"/.test(hSP38._h) && SP38.api.check(dSP38).length === 0;
  click38(hSP38, '[data-vs-row="b"]');
  const s2_38 = /<div class="vs-detcard" data-vs-detcard="b">/.test(hSP38._h) && !/class="vs-det"/.test(hSP38._h) && SP38.env.log.indexOf('into:b') >= 0;
  SP38.env.width = 1366; SP38.env.breakAll();
  const s3_38 = /data-vs-det="b"/.test(hSP38._h) && !/data-vs-detcard/.test(hSP38._h) && cg38(hSP38._h) === 8;
  const H38 = mk38({ width: 1366 }), hH38 = H38.env.mkHost('vsT'), dH38 = def38(); H38.api.render(dH38);
  hH38.visible = false; const ph38 = H38.env.paints; H38.env.width = 1000; H38.env.breakAll();
  const h1_38 = H38.env.paints === ph38 && H38.api.inst(dH38).stale === true && H38.env.ro.length === 1 && H38.env.ro[0] === hH38 && hH38.getAttribute('data-vs-host') === 'jw_task_sheet';
  hH38.visible = true; H38.env.roCb([{ target: hH38 }]); const h2_38 = H38.env.paints === ph38;
  H38.env.flushRaf(); const h3_38 = H38.env.paints === ph38 + 1 && cg38(hH38._h) === 6 && H38.api.inst(dH38).stale === false;
  H38.env.roCb([{ target: hH38 }]); H38.env.flushRaf(); const h4_38b = H38.env.paints === ph38 + 1 && hH38.querySelector('.vs-wrap').style.getPropertyValue('--vs-panew') === '1048px';
  //   경계값(v438 검토 — 859/860 · 1279/1280 · 1599/1600): sheet 정의 colgroup 열 수 3·6·6·8·8·10 · 갈래가 정해질 때마다 onMode(375 legacy → 옛 함수 → 1366 sheet)
  //   · legacy가 갈래 함수를 다시 부르는 잘못된 정의(새 입구를 넘김)도 한 번만 부르고 멈추지 않음 · 숨은 동안 ResizeObserver 콜백이 와도 안 그림 · 같은 단계 안 경계 알림(1366 → 1300)은 stale을 안 붙여 보여도 다시 안 그림
  const bnd38 = [859, 860, 1279, 1280, 1599, 1600].map((w) => { const X = mk38({ width: w }), h = X.env.mkHost('vsT'); X.api.render(def38({ phone: 'sheet' })); return cg38(h._h); }).join(',');
  const om38 = [], OM38 = mk38({ width: 375 }); OM38.env.mkHost('vsT'); const dOM38 = def38({ onMode: (m) => om38.push(m), legacy: () => om38.push('옛 함수') }); OM38.api.render(dOM38); OM38.env.width = 1366; OM38.env.breakAll();
  let rec38 = 0, recE38 = ''; const RC38 = mk38({ width: 375 }); RC38.env.mkHost('vsT'); const dRC38 = def38({ legacy: () => { rec38++; if (rec38 > 20) throw new Error('끝나지 않음'); RC38.api.render(dRC38); } });
  try { RC38.api.render(dRC38); } catch (e) { recE38 = e.message; }
  const H2_38 = mk38({ width: 1366 }), hH2_38 = H2_38.env.mkHost('vsT'), dH2_38 = def38(); H2_38.api.render(dH2_38);
  hH2_38.visible = false; const ph2_38 = H2_38.env.paints; H2_38.env.width = 1000; H2_38.env.breakAll(); H2_38.env.roCb([{ target: hH2_38 }]); H2_38.env.flushRaf();
  const hid38 = [H2_38.env.paints - ph2_38, H2_38.api.inst(dH2_38).stale];
  const H3_38 = mk38({ width: 1366 }), hH3_38 = H3_38.env.mkHost('vsT'), dH3_38 = def38(); H3_38.api.render(dH3_38);
  hH3_38.visible = false; const ph3_38 = H3_38.env.paints; H3_38.env.width = 1300; H3_38.env.breakAll(); hid38.push(H3_38.api.inst(dH3_38).stale); hH3_38.visible = true; H3_38.env.roCb([{ target: hH3_38 }]); H3_38.env.flushRaf(); hid38.push(H3_38.env.paints - ph3_38);
  T('v438 ⑨ 폰 갈래·경계: legacy(기본) 375px = 옛 그리기 함수를 인자 없이 1번·그 자리 글 그대로(부품이 덧쓰지 않음) · PC 표 → 375px 경계(matchMedia 3개 각 두 번) = 표를 먼저 비우고 옛 함수 1번만 → 1366 = 표 1번만 · 1366 → 1700 = 1번(10열)·1710 = 다시 안 그림 · sheet 375px = 폰 열 3·--pw 52/24/24·끌기 손잡이 없음·PC 전용 칩 vs-pc·정의 검사 통과 → 행 누름 = 표 아래 .vs-detcard(표 안 펼침 없음)·화면 안으로 → 1366 = 표 안 펼침(8열) · 숨은 표: 경계 때 다시 안 그리고 stale·ResizeObserver는 자리(host)에 한 번·data-vs-host → 보일 때 콜백 안에서는 안 그리고 다음 그림(rAF)에 1번(6열) → 같은 단계면 다시 안 그림·--vs-panew = 칸 폭 · 경계값 859/860/1279/1280/1599/1600 열 수 3·6·6·8·8·10 · onMode legacy→옛 함수→sheet · legacy 재진입 1번(멈추지 않음) · 숨은 동안 RO 콜백 0번 · 같은 단계 안 경계 알림은 stale 없음·다시 안 그림',
    q1_38 && q2_38 && q3_38 && q4_38 && s1_38 && s2_38 && s3_38 && h1_38 && h2_38 && h3_38 && h4_38b
    && bnd38 === '3,6,6,8,8,10' && om38.join() === 'legacy,옛 함수,sheet' && rec38 === 1 && recE38 === '' && JSON.stringify(hid38) === JSON.stringify([0, true, false, 0]),
    JSON.stringify({ q1_38, q2_38, q3_38, q4_38, s1_38, s2_38, s3_38, h1_38, h2_38, h3_38, h4_38b, lq38, lq2_38, bnd38, om38, rec38, recE38, hid38 }));

  // ⑩ 골라 쓰기 — 선택(보이는 행만 체크·전체선택은 보이는 행만·칩을 바꾸면 숨은 선택 풂/keep이면 '숨은 선택 n'·동작은 행 원천에 있는 선택 id) · 묶음 행(기본 접힘·누르면 펼침·글자 거르기면 저절로) · 더보기(page씩·건수·합계는 전체) · 표 위 검색칸(id·150ms·초기화·저장 안 함)
  const sel38 = {}, ran38 = [], SL38 = mk38({ width: 1366 }), hSL38 = SL38.env.mkHost('vsT');
  const dSL38 = def38({ sel: { set: () => sel38, can: () => true, acts: [{ h: '선택 삭제', danger: 1, run: (ids) => ran38.push(ids.slice().sort().join('')) }] } }); SL38.api.render(dSL38);
  const se0_38 = /전체선택\(보이는 5건\)/.test(hSL38._h) && (hSL38._h.match(/data-vs-sel="/g) || []).length === 5 && /data-vs-selact="0" disabled/.test(hSL38._h) && /<td class="vs-b" title="사 옛 공고 검토"><input type="checkbox" class="sel-box" data-vs-sel="g">사 옛 공고 검토<\/td>/.test(hSL38._h);
  const sa38 = hSL38.querySelector('[data-vs-selall]'); sa38.checked = true; sa38.fire('change');
  const se1_38 = Object.keys(sel38).sort().join('') === 'abcdg' && /선택 삭제 \(5\)/.test(hSL38._h);
  click38(hSL38, '[data-vs-chip="kd|auto"]'); const se2_38 = Object.keys(sel38).join('') === 'b';
  click38(hSL38, '[data-vs-selact="0"]'); const se3_38 = ran38.join() === 'b';
  const cb38 = hSL38.querySelector('[data-vs-sel="b"]'); cb38.checked = false; cb38.fire('change'); const se4_38 = Object.keys(sel38).length === 0;
  const selK38 = {}, SK38 = mk38({ width: 1366 }), hSK38 = SK38.env.mkHost('vsT'), dSK38 = def38({ sel: { set: () => selK38, can: () => true, keep: 1, acts: [{ h: '이력 추가', run: () => {} }] } }); SK38.api.render(dSK38);
  const sk38 = hSK38.querySelector('[data-vs-selall]'); sk38.checked = true; sk38.fire('change'); click38(hSK38, '[data-vs-chip="kd|auto"]');
  const se5_38 = Object.keys(selK38).length === 5 && /· 숨은 선택 4/.test(hSK38._h) && /이력 추가 \(5\)/.test(hSK38._h) && /전체선택\(보이는 1건\)/.test(hSK38._h);
  const GR38 = mk38({ width: 1366 }), hGR38 = GR38.env.mkHost('vsT'), dGR38 = def38({ group: { of: (r) => (r.old ? 'old' : ''), label: () => '지난 자료', auto: (s) => !!(s.q || Object.keys(s.f).some((k) => s.f[k])) } }); GR38.api.render(dGR38);
  const gr38 = [order38(hGR38._h), /<tr class="vs-grp" data-vs-grp="old"><td colspan="8"><div class="vs-grp-in"><span class="car">▸<\/span>지난 자료<span class="n">1건<\/span>/.test(hGR38._h)];
  click38(hGR38, '[data-vs-grp="old"]'); gr38.push(order38(hGR38._h), /<tr class="vs-grp open" data-vs-grp="old">/.test(hGR38._h));
  click38(hGR38, '[data-vs-grp="old"]'); gr38.push(order38(hGR38._h));
  GR38.api.filter(dGR38, 't', '옛'); gr38.push(order38(hGR38._h));
  const MO38 = mk38({ width: 1366 }), hMO38 = MO38.env.mkHost('vsT'), dMO38 = def38({ page: 2 }); MO38.api.render(dMO38);
  const mo38 = [order38(hMO38._h), /data-vs-more="1">2건 더 보기<\/button><span class="n">남은 3건<\/span>/.test(hMO38._h), cnt38(hMO38._h), /<td>합계 5건<\/td>/.test(hMO38._h)];
  click38(hMO38, '[data-vs-more]'); mo38.push(order38(hMO38._h), /남은 1건/.test(hMO38._h));
  click38(hMO38, '[data-vs-chip="st|all"]'); mo38.push(order38(hMO38._h));
  const SQ38 = mk38({ width: 1366 }), hSQ38 = SQ38.env.mkHost('vsT'), dSQ38 = def38({ search: { id: 'taskSearch', ph: '지시 검색', text: (r) => r.t + ' ' + r.who } }); SQ38.api.render(dSQ38);
  const sq38 = [/<input type="search" class="vs-q" id="taskSearch" data-vs-q="1" value="" placeholder="지시 검색" autocomplete="off">/.test(hSQ38._h)];
  const qi38 = hSQ38.querySelector('[data-vs-q]'); qi38.value = '성분'; qi38.fire('input', {}); SQ38.env.tick(149); sq38.push(order38(hSQ38._h)); SQ38.env.tick(1); sq38.push(order38(hSQ38._h), cnt38(hSQ38._h));
  click38(hSQ38, '[data-vs-reset]'); sq38.push(order38(hSQ38._h), hSQ38.querySelector('[data-vs-q]').value, (SQ38.env.store.jw_task_sheet || '').indexOf('성분') < 0);
  //   전체선택 = 그린 행만(v438 검토 — 명세 ⓗ '보이는 행만' · 사람별 의무 '접힘 + 선택 이력 추가'·기성 '선택 삭제 + 더보기'): 접힌 묶음 g 빠짐 abcd "(보이는 4건)"·"(4)" → 묶음을 펼쳐도 g는 안 고른 채(전체선택 체크 풀림·숨은 선택 없음)
  //   / 더보기(page 2) = 그린 ga만 "(보이는 2건)" → 더 보기 뒤 새로 그린 b·c는 안 고름
  const selg38 = [], sg38 = {}, SG38 = mk38({ width: 1366 }), hSG38 = SG38.env.mkHost('vsT'), dSG38 = def38({ sel: { set: () => sg38, can: () => true, acts: [{ h: '선택 삭제', run: () => {} }] }, group: { of: (r) => (r.old ? 'old' : ''), label: () => '지난 자료' } }); SG38.api.render(dSG38);
  const sga38 = hSG38.querySelector('[data-vs-selall]'); sga38.checked = true; sga38.fire('change'); selg38.push(Object.keys(sg38).sort().join(''), /전체선택\(보이는 4건\)/.test(hSG38._h), /선택 삭제 \(4\)/.test(hSG38._h));
  click38(hSG38, '[data-vs-grp="old"]'); selg38.push(order38(hSG38._h), /data-vs-selall="1" checked/.test(hSG38._h), /숨은 선택/.test(hSG38._h));
  const sp38 = {}, SPg38 = mk38({ width: 1366 }), hSPg38 = SPg38.env.mkHost('vsT'), dSPg38 = def38({ page: 2, sel: { set: () => sp38, can: () => true, acts: [{ h: '선택 삭제', run: () => {} }] } }); SPg38.api.render(dSPg38);
  const spa38 = hSPg38.querySelector('[data-vs-selall]'); spa38.checked = true; spa38.fire('change'); const selp38 = [Object.keys(sp38).sort().join(''), /전체선택\(보이는 2건\)/.test(hSPg38._h)];
  click38(hSPg38, '[data-vs-more]'); selp38.push(order38(hSPg38._h), /data-vs-selall="1" checked/.test(hSPg38._h), Object.keys(sp38).sort().join(''));
  //   행 원천에서 사라진 선택(다른 사람이 지움)은 '숨은 선택'·(n)에 안 셈 = 동작에 넘어가는 수와 같음 · 거르기 줄·검색어를 바꿔도 숨은 행 선택 풂(칩과 같음) · can() 없는 sel은 선택 칸을 안 그림
  const sv38 = { a: 1, b: 1 }, svRan38 = [], rowsV38 = { v: ROWS38 }, SV38 = mk38({ width: 1366 }), hSV38 = SV38.env.mkHost('vsT'), dSV38 = def38({ rows: () => rowsV38.v, sel: { set: () => sv38, can: () => true, acts: [{ h: '선택 삭제', run: (ids) => svRan38.push(ids.join('')) }] } }); SV38.api.render(dSV38);
  rowsV38.v = ROWS38.filter((r) => r.id !== 'b'); SV38.api.render(dSV38); click38(hSV38, '[data-vs-selact="0"]'); const selv38 = [/숨은 선택/.test(hSV38._h), /선택 삭제 \(1\)/.test(hSV38._h), svRan38.join()];
  const sf38 = {}, SF38 = mk38({ width: 1366 }), hSF38 = SF38.env.mkHost('vsT'), dSF38 = def38({ search: { text: (r) => r.t }, sel: { set: () => sf38, can: () => true, acts: [{ h: '선택 삭제', run: () => {} }] } }); SF38.api.render(dSF38);
  const sfa38 = hSF38.querySelector('[data-vs-selall]'); sfa38.checked = true; sfa38.fire('change'); SF38.api.filter(dSF38, 'who', '김'); const self38 = [Object.keys(sf38).sort().join('')]; SF38.api.setQ(dSF38, '착공'); self38.push(Object.keys(sf38).sort().join(''));
  const NC38 = mk38({ width: 1366 }), hNC38 = NC38.env.mkHost('vsT'); NC38.api.render(def38({ sel: { set: () => ({}), acts: [{ h: '선택 삭제', run: () => {} }] } })); const selc38 = !/data-vs-sel/.test(hNC38._h);
  //   bindRows 뿌리 = 그릴 때마다 새로 생기는 표 칸(.vs-wrap — 자리 host 아님, 위임 배선이 쌓이지 않게) · 더보기 한도 뒤 묶음 머리는 그리지 않고 남은 행(접힌 묶음 안 포함)만 셈 · 정렬을 바꾸면 더보기는 처음 page
  const brs38 = [], BR38 = mk38({ width: 1366 }), hBR38 = BR38.env.mkHost('vsT'), dBR38 = def38({ bindRows: (root) => { brs38.push(root); } }); BR38.api.render(dBR38); BR38.api.render(dBR38);
  const br38 = brs38.length === 2 && brs38[0] !== hBR38 && brs38[0] !== brs38[1] && brs38.every((r) => r.getAttribute('data-vs-wrap') === '1');
  const RG38 = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'r' + i, t: 'x' + i, due: '2026-12-0' + (i + 1), st: '진행' })).concat([{ id: 'p', t: 'p', due: '2026-12-20', st: '진행', grp: 'A' }, { id: 'q', t: 'q', due: '2026-12-21', st: '진행', grp: 'B' }]);
  const seq38 = (h) => [...h.matchAll(/data-vs-(row|grp|more)="([^"]*)"/g)].map((m) => (m[1] === 'row' ? m[2] : (m[1] === 'grp' ? '[' + m[2] + ']' : '+'))).join(' ') + ' 남은 ' + ((/남은 (\d+)/.exec(h) || [0, 0])[1]);
  const mg38 = [];
  const more38 = (h) => { const el = h.querySelector('[data-vs-more]'); if (el) el.fire('click', {}); };   // 더 보기가 없으면 누르지 않음(결함이면 이 검사가 ✗ — 시험 틀이 멈추지 않게)
  [true, false].forEach((au) => { const X = mk38({ width: 1366 }), h = X.env.mkHost('vsT'); X.api.render(def38({ rows: () => RG38, page: 3, group: { of: (r) => r.grp || '', label: (g) => '묶음 ' + g, auto: () => au } })); mg38.push(seq38(h._h)); more38(h); mg38.push(seq38(h._h)); more38(h); mg38.push(seq38(h._h)); });
  const MS38 = mk38({ width: 1366 }), hMS38 = MS38.env.mkHost('vsT'), dMS38 = def38({ page: 2 }); MS38.api.render(dMS38); click38(hMS38, '[data-vs-more]'); const ms38 = [order38(hMS38._h)]; click38(hMS38, '[data-vs-sort="who"]'); ms38.push(order38(hMS38._h));
  T('v438 ⑩ 골라 쓰기: 선택 — 체크는 보이는 5행만·첫 칸 굵게·동작 버튼은 선택 0이면 막힘 → 전체선택 = 보이는 행만(완료 e·f 빠짐) abcdg "(5)" → 칩을 바꾸면 숨은 행 선택 풂(b만) → 동작은 b → 체크 풀면 0 · keep 정의는 남기고 "· 숨은 선택 4"·"(5)" / 묶음 행 — 기본 접힘 abcd + "▸ 지난 자료 1건" → 누르면 abcdg(open) → 다시 접힘 → 글자 거르기면 저절로 펼침 g / 더보기(page 2) — ga + "2건 더 보기 · 남은 3건"·건수·합계는 5건 → gabc·남은 1건 → 칩을 바꾸면 처음 page fe / 검색칸 — id taskSearch·149ms 그대로·150ms c "보이는 1건 / 전체 7건" → 필터 초기화로 검색어도 지움·검색어는 저장 안 함 · 전체선택 = 그린 행만(접힌 묶음 g 빠짐 abcd "(보이는 4건)"·"(4)" → 펼쳐도 g 안 고름 / 더보기 ga "(보이는 2건)" → 더 보기 뒤 b·c 안 고름) · 사라진 행 선택은 숨은 선택·(n)에 안 셈(동작 a) · 거르기 줄·검색어를 바꿔도 숨은 선택 풂(ac → a) · can 없는 sel은 선택 칸 없음 · bindRows 뿌리 = 매번 새 표 칸 · 더보기 한도 뒤 묶음 머리 안 그림·남은 행(접힌 묶음 포함) · 정렬하면 더보기 처음 page',
    se0_38 && se1_38 && se2_38 && se3_38 && se4_38 && se5_38
    && JSON.stringify(gr38) === JSON.stringify(['abcd', true, 'abcdg', true, 'abcd', 'g'])
    && JSON.stringify(mo38) === JSON.stringify(['ga', true, '보이는 5건 / 전체 7건', true, 'gabc', true, 'fe'])
    && JSON.stringify(sq38) === JSON.stringify([true, 'gabcd', 'c', '보이는 1건 / 전체 7건', 'gabcd', '', true])
    && JSON.stringify(selg38) === JSON.stringify(['abcd', true, true, 'abcdg', false, false]) && JSON.stringify(selp38) === JSON.stringify(['ag', true, 'gabc', false, 'ag'])
    && JSON.stringify(selv38) === JSON.stringify([false, true, 'a']) && JSON.stringify(self38) === JSON.stringify(['ac', 'a']) && selc38 && br38
    && JSON.stringify(mg38) === JSON.stringify(['r0 r1 r2 + 남은 5', 'r0 r1 r2 r3 r4 r5 + 남은 2', 'r0 r1 r2 r3 r4 r5 [A] p [B] q 남은 0', 'r0 r1 r2 + 남은 5', 'r0 r1 r2 r3 r4 r5 + 남은 2', 'r0 r1 r2 r3 r4 r5 [A] [B] 남은 0'])
    && JSON.stringify(ms38) === JSON.stringify(['gabc', 'ac']),
    JSON.stringify({ se: [se0_38, se1_38, se2_38, se3_38, se4_38, se5_38], gr38, mo38, sq38, selg38, selp38, selv38, self38, selc38, br38, mg38, ms38 }));

  // ⑪ 날짜 칸 규칙 하나(명세 glossary — 오늘 2026-11-10) · 정의 검사(vsSheetCheckDef — 다음 판 탭 정의가 지킬 것)
  const DC38 = mk38({}).api, dc38 = [DC38.date('2026-11-05', { wide: 1 }), DC38.date('2026-11-05'), DC38.date('2026-11-05', { phone: 1 }), DC38.date('2026-11-12'), DC38.date('2026-11-12', { wide: 1 }), DC38.date('2026-11-20', { wide: 1 }),
    DC38.date('2026-11-15', { red: 7, soon: 30 }), DC38.date('2026-11-25', { red: 7, soon: 30 }), DC38.date('2026-12-20', { red: 7, soon: 30 }), DC38.date('2026-11-05', { grey: 1, wide: 1 }), DC38.date(''), DC38.date('2026/11/05')];
  const dOk38 = dc38[0].html === '2026-11-05 경과 5일' && dc38[0].cls === 'vs-dan' && dc38[0].sv === -5 && dc38[0].title === '2026-11-05 경과 5일' && dc38[1].html === '경과 5일' && dc38[1].title === '2026-11-05' && dc38[2].html === 'D+5' && dc38[2].cls === 'vs-dan'
    && dc38[3].html === 'D-2' && dc38[3].cls === 'vs-warn' && dc38[4].html === '2026-11-12 D-2' && dc38[4].cls === 'vs-warn' && dc38[5].cls === '' && dc38[5].html === '2026-11-20 <span style="color:var(--sub);">D-10</span>'
    && dc38[6].html === 'D-5' && dc38[6].cls === 'vs-dan' && dc38[7].html === 'D-15' && dc38[7].cls === 'vs-warn' && dc38[8].cls === '' && dc38[9].cls === '' && dc38[9].html === '2026-11-05 <span style="color:#9AA09C;">D+5</span>'
    && dc38[10].sv === null && dc38[10].html === '<span style="color:#9AA09C;">-</span>' && dc38[11].sv === null;
  const ck38 = (o) => DC38.check(def38(o)).join(',');
  const cks38 = [ck38({}), ck38({ key: 'jw_veh_sheet' }), ck38({ sort: { k: 'reg', d: 1 } }), ck38({ phone: 'sheet', cols: C38().map((c) => (c.k === 'st' ? Object.assign({}, c, { pw: 30 }) : c)) }), ck38({ legacy: null }),
    ck38({ cols: C38().concat([{ k: 'x', h: 'x', w: 200, lv: 2 }]) }), ck38({ cols: C38().concat([{ k: 't', h: '겹침', w: 10 }]) }), ck38({ cols: C38().concat([{ k: 'y', h: 'y', w: 10, f: 'date' }]) }),
    ck38({ cols: C38().concat([{ k: 'z', h: 'z', w: 10, lv: 5 }]) }), ck38({ cols: C38().concat([{ k: 'p', h: 'p', w: 10, ph: 1, lv: 2 }]) }), ck38({ cols: C38().concat([{ k: 'f2', h: 'f2', fill: 1, min: 10 }]) }), ck38({ phone: 'card' })];
  //   임박 기본 3일 경계(용어표 '지시·입찰 3일'): D-3 노랑 · D-4 색 없음 / 정의 검사 더함(v438 검토): 칩별 기본 정렬 키 오타 · sortAs가 없는 열 · sel.set 함수 아님 · sel.can 없음 · group.of 함수 아님 · 모집단 칩 test 없음 · 맞는 sel·group·칩 정렬은 통과
  const dc2_38 = [DC38.date('2026-11-13'), DC38.date('2026-11-14')].map((x) => x.cls + ':' + x.html.replace(/<[^>]+>/g, '')).join(',');
  const cks2_38 = [ck38({ chips: [{ g: 'st', items: [{ k: '', h: '진행 중', test: (r) => r.st !== '완료' }, { k: 'done', h: '완료', test: (r) => r.st === '완료', sort: { k: 'donee', d: -1 } }] }] }),
    ck38({ cols: C38().map((c) => (c.k === 'reg' ? Object.assign({}, c, { sortAs: 'regi' }) : c)) }), ck38({ sel: { set: {}, can: () => true } }), ck38({ sel: { set: () => ({}) } }), ck38({ group: { of: 'old' } }),
    ck38({ chips: [{ g: 'st', items: [{ k: '', h: '진행 중', test: (r) => r.st !== '완료' }, { k: 'old', h: '지남', pop: 1 }] }] }), ck38({ sel: { set: () => ({}), can: () => true }, group: { of: () => '' } })];
  T('v438 ⑪ 날짜 칸 규칙(오늘 11-10): 지남 넓은 칸 "2026-11-05 경과 5일"(vs-dan · title도 같은 글 — v439 검토)·좁은 칸 "경과 5일"(날짜는 title)·폰 "D+5" · 임박(기본 3일) 좁은 "D-2"·넓은 "2026-11-12 D-2"(vs-warn)·D-3 노랑·D-4 색 없음 · 그 밖 날짜 + 회색 D-10 · 현장 신고형(red 7·soon 30) D-5 빨강·D-15 노랑·D-40 색 없음 · grey는 색 없이 · 빈 값·다른 꼴 "-"(정렬 값 없음) / 정의 검사: 가짜 지시 정의 통과 · 계약·차량 키 · 기본 정렬이 1280 열 · 폰 % 합 106 · legacy 함수 없음 · 열 합 초과(860 896·1280 1144·1600 1374) · 열 키 겹침 · 거르기 종류 · lv 5 · 폰 전용인데 lv2 · 남는 폭 열 둘 · phone 값 · 칩 정렬 키 오타 · sortAs 없는 열 · sel.set · sel.can · group.of · 모집단 칩 test · 맞는 sel·group 통과',
    dOk38 && JSON.stringify(cks38) === JSON.stringify(['', 'key', 'sort', 'pw:106', 'legacy', 'sum2:896,sum3:1144,sum4:1374', 'col:t', 'f:y', 'lv:z', 'ph:p', 'fill', 'phone'])
    && dc2_38 === 'vs-warn:D-3,:D-4' && JSON.stringify(cks2_38) === JSON.stringify(['chipsort:st|done', 'sortAs:reg', 'sel', 'sel.can', 'group', 'pop:st|old', '']),
    JSON.stringify({ dc: dc38.map((x) => x.cls + ':' + x.html), cks38, dc2_38, cks2_38 }));

  // ⑫ 정적 — 계약·차량 표는 ResizeObserver 한 줄씩(vsPaneObserve(host) — 그리기마다 불러도 자리에 한 번만 걸림) 말고 무변 · 부품을 쓰는 탭 1개(v439 지시 — 기성 v440부터 탭 판마다 이 줄을 고친다) · pointer(마우스 이벤트 없음) · 150ms·조합
  //   · 저장은 한 곳(def.key에 k,d,f,chip) · ResizeObserver 하나·콜백은 rAF · 경계 matchMedia 3개 · 새 CSS(.vs.vs-fit 폭·폰 --pw·.vs-detcard·td.num·옅은 칩) · 기존 .vs 규칙(min-width 1160·폰 0) 그대로
  //   v439 '부품을 쓰는 탭 0' → '지시 1개'(같은 강도): 부품을 부르는 곳은 @task-sheet 구간 하나(vsSheetRender 1번·정의 key "jw_task_sheet" 1개·host "taskList")이고 두 구간 밖은 vsSheet*·vsDateCell·VS_INST 0,
  //     부품 저장 이름 8개 중 @vs-sheet 구간 밖에 나오는 이름은 jw_task_sheet 하나(그 구간 안 1번)
  const outside38 = html.slice(0, html.indexOf('// @vs-sheet-start')) + html.slice(html.indexOf('// @vs-sheet-end'));
  const tsb38 = (() => { const i = html.indexOf('// @task-sheet-start'), j = html.indexOf('// @task-sheet-end'); return (i < 0 || j < i) ? '' : html.slice(i, j); })();
  const outside2_38 = tsb38 ? outside38.replace(tsb38, '') : outside38;
  const keysOut38 = ['jw_task_sheet', 'jw_rec_sheet', 'jw_cli_sheet', 'jw_wk_sheet', 'jw_bid_sheet', 'jw_ob_sheet', 'jw_site_sheet', 'jw_edu_sheet'].filter((k) => outside38.indexOf(k) >= 0);
  const use38 = tsb38.length > 0 && (outside2_38.match(/\bvsSheet\w*\(|\bvsDateCell\(|\bVS_INST\b/g) || []).length === 0
    && (tsb38.match(/\bvsSheetRender\(/g) || []).length === 1 && (tsb38.match(/key: "jw_task_sheet"/g) || []).length === 1 && (tsb38.match(/\bhost: "taskList"/g) || []).length === 1
    && JSON.stringify(keysOut38) === '["jw_task_sheet"]' && (outside38.match(/jw_task_sheet/g) || []).length === 1;
  const rv38 = fn38(html, 'renderVehicles'), rc38 = fn38(html, 'renderContracts');
  const V38 = mk38({ width: 1366 }), vh38 = V38.env.mkHost('vehList'); vh38.innerHTML = '<div class="vs-wrap"><table class="vs"></table></div>';
  V38.api.paneObs(vh38); V38.api.paneObs(vh38); V38.env.roCb([{ target: vh38 }]); V38.env.flushRaf();
  const ro38a = vh38.querySelector('.vs-wrap').style.getPropertyValue('--vs-panew');
  V38.env.cw = 900; V38.env.roCb([{ target: vh38 }]); const ro38b = vh38.querySelector('.vs-wrap').style.getPropertyValue('--vs-panew'); V38.env.flushRaf();   // 창을 줄이면 다시 잼(명세 ⓔ의 뜻 — 첫 값만이 아니라) · 콜백 안에서는 안 바꾸고 다음 그림에
  const ro38 = V38.env.ro.length === 1 && ro38a === '1048px' && ro38b === '1048px' && vh38.querySelector('.vs-wrap').style.getPropertyValue('--vs-panew') === '900px' && vh38.getAttribute('data-vs-host') == null;
  const st38 = (rv38.match(/\bvsPaneObserve\(host\);/g) || []).length === 1 && (rc38.match(/\bvsPaneObserve\(host\);/g) || []).length === 1 && (outside38.match(/\bvsPaneObserve\(/g) || []).length === 2
    && use38
    && /addEventListener\("pointerdown"/.test(blk38) && /document\.addEventListener\("pointermove", mv\); document\.addEventListener\("pointerup", up\); document\.addEventListener\("pointercancel", up\);/.test(blk38) && !/mousedown|mousemove|mouseup/.test(blk38)
    && /var VS_TYPE_MS = 150;/.test(blk38) && /"compositionstart"/.test(blk38) && /"compositionend"/.test(blk38) && /e\.isComposing/.test(blk38)
    && (blk38.match(/localStorage\.setItem\(/g) || []).length === 1 && /localStorage\.setItem\(def\.key, JSON\.stringify\(\{ k: st\.k, d: st\.d, f: st\.f, chip: st\.chip \}\)\)/.test(blk38)
    && (blk38.match(/new ResizeObserver\(/g) || []).length === 1 && /vsRaf\(function\(\)\{/.test(blk38) && /\["\(max-width:859px\)", "\(min-width:1280px\)", "\(min-width:1600px\)"\]\.forEach/.test(blk38);
  const css2_38 = decl38(1000, '.vs.vs-fit', 'width') === '100%' && decl38(1000, '.vs.vs-fit', 'min-width') === 'var(--vs-minw,0px)' && decl38(859, '.vs.vs-fit', 'min-width') == null
    && decl38(375, '.vs.vs-fit col', 'width') === 'var(--pw,0) !important' && decl38(860, '.vs.vs-fit col', 'width') == null && decl38(1000, '.vs-detcard', 'display') === 'none' && decl38(859, '.vs-detcard', 'display') === 'block'
    && decl38(1000, '.vs.vs-fit td.num', 'text-align') === 'right' && decl38(1000, '.vs-tools.vs-light .vs-chip.on', 'background') === '#EAF3EF'
    && decl38(1000, '.vs', 'min-width') === '1160px' && decl38(375, '.vs', 'min-width') === '0' && decl38(375, '.vs col', 'width') === '0 !important';
  //   v438 검토 반영 CSS: 계약·차량 펼침 폭 상한(.vs tr.vs-det>td>.vs-det-in max-width 100% — 넓은 창에서 표 칸이 표보다 넓어 [닫기 ▲]가 잘림) · 숫자 칸·체크 상자는 새 표만(.vs td.num·.vs td .sel-box 없음 — 차량 번호 칸 체크 v437 모양)
  //   · 선택 막대는 .sel-bar.vs-selbar(뒤쪽 .sel-bar를 이김 — 여백 2/2/8·줄바꿈) · 터치 기기 손잡이 14px
  const css3_38 = decl38(1920, '.vs tr.vs-det>td>.vs-det-in', 'max-width') === '100%' && decl38(1920, '.vs-det-in', 'width') === 'var(--vs-panew,100%)'
    && decl38(1000, '.vs td.num', 'text-align') == null && decl38(1000, '.vs td .sel-box', 'margin-right') == null && decl38(1000, '.vs td .sel-box', 'vertical-align') == null && decl38(1000, '.vs.vs-fit td .sel-box', 'margin-right') === '6px'
    && decl38(375, '.sel-bar.vs-selbar', 'flex-wrap') === 'wrap' && decl38(375, '.sel-bar.vs-selbar', 'padding') === '2px 2px 8px' && decl38(375, '.vs-selbar', 'padding') == null
    && /@media \(pointer:coarse\)\{ \.vs\.vs-fit \.vs-rs\{width:14px;\} \}/.test(css38);
  T('v438 ⑫ 정적: 계약·차량 그리기에 vsPaneObserve(host) 한 줄씩(파일에서 이 둘뿐 — 여러 번 불러도 자리에 한 번 걸림·--vs-panew = 칸 폭·창을 줄이면 다음 그림에 다시 잼 1048 → 900·data-vs-host 없음) · 부품을 쓰는 탭 1개 — v439 지시(@task-sheet 구간 하나: vsSheetRender 1번·정의 key jw_task_sheet 1개·host taskList · 두 구간 밖 vsSheet*·vsDateCell·VS_INST 0 · 부품 저장 이름은 jw_task_sheet만) · 끌기는 pointer(document pointermove·pointerup·pointercancel — mouse 이벤트 0) · 150ms·compositionstart/end·isComposing · 저장 한 곳(def.key에 k,d,f,chip) · ResizeObserver 하나·콜백은 rAF · 경계 matchMedia 3개 · CSS .vs.vs-fit(860~ 폭 100%·최소 --vs-minw)·폰 col --pw·.vs-detcard(PC 숨김·폰 보임)·.vs.vs-fit td.num 오른쪽·옅은 칩 · 기존 .vs(min-width 1160·폰 0·폰 col 0) 그대로 · 검토 반영: 펼침 폭 상한 max-width 100%(계약·차량 [닫기 ▲] 잘림) · .vs td.num·.vs td .sel-box 규칙 없음(새 표만) · .sel-bar.vs-selbar 줄바꿈·여백 · 터치 손잡이 14px',
    ro38 && st38 && css2_38 && css3_38, JSON.stringify({ ro38, ro38a, ro38b, st38, use38, keysOut38, css2_38, css3_38 }));

  // ⑬ 문서 — FEATURES 기준 v438·v438 절(문장 고정)·자리 글 GATES_V438 0 · TESTLIST v438 체크 칸 = 화면 칸 4개 '[ ] (AI 시험 화면 대상' + 게이트 칸 '[x] (AI)' 5종(PM 몫 0) · MANUAL 1절 화면 폭 한 줄 · CLAUDE.md 폭·부품 줄 · sw v438 이상
  const ft38 = rd38('FEATURES.md'), tl38 = rd38('TESTLIST.md'), man38 = rd38('MANUAL.html'), cl38 = rd38('CLAUDE.md'), sw38 = rd38('sw.js');
  const sec38 = (src, head) => { const i = src.indexOf(head); if (i < 0) return ''; const j = src.indexOf(head.slice(0, head.indexOf(' ') + 1), i + head.length); return src.slice(i, j < 0 ? src.length : j); };
  const ftv38 = sec38(ft38, '\n### v438 (11/10)'), tlv38 = sec38(tl38, '\n## v438 ');
  const FT_PINS38 = ['860~1279 = `#app` 최대 폭 없음·여백 16·사이드바 168·간격 16(본문 = 창 − 233)', '1600 이상 = `#app` 최대 1,680(본문 최대 1,428)', '**안전(`#view-safety`)은 56 판(v445)에서**',
    '`margin:0 0 0 max(0px, calc((100% - 1060px) / 2));`', '`vsSheetRender(def)` 하나로 그린다', '끈 열 폭·검색어·펼침은 메모리만', '`phone:"legacy"`(기본) = 그 탭의 지금 그리기 함수(def.legacy)를 그대로 부름',
    '`vsPaneObserve(host)` 한 줄씩만', '**이번 판에서 보이는 변화는 PC 폭뿐**', 'ResizeObserver 콜백은 다음 그림(rAF)에 고친다', '그래서 이 다섯 화면은 이번 판에서 808 그대로이고, 표로 바뀌는 판에서 넓어진다',
    // 검토 반영(11/10) 문장 — 대안 주석·펼침 폭·전체선택·한글 조합·data-keep·sel.can·bindRows 뿌리
    '1600 묶음 `#app{max-width:1680px;}`는 남긴다', '9개 중 8개가 바뀌므로', '**전체선택은 그린 행만**', '`.vs tr.vs-det>td>.vs-det-in{max-width:100%}`', 'compositionstart가 그 칸의 150ms를 지우고',
    '같은 행이 펼쳐져 있을 때만 값·포커스를 되살림', '`sel.can()`이 있고 참일 때만 선택 칸을 그림', '`bindRows(root)`의 root는 그릴 때마다 새로 생기는 표 칸'];
  const CL_PINS38 = ['**PC 화면 폭(v438 — 45-1 첫 판)**', '**엑셀형 표 공통 부품(vsSheet, v438)**', '`vsSheetCheckDef(def)`', '`#view-con·#view-veh·#view-perm`',
    '1600 묶음 1,680 상한은 남김', '`.vs tr.vs-det>td>.vs-det-in{max-width:100%}`', '`sel`은 `can()` 필수', '`bindRows(root)`의 root는 매번 새 표 칸'];
  const tcb38 = tlv38.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l));
  const cbScr38 = tcb38.filter((l) => /^- \[[ x]\] \(AI 시험 화면 대상[,) —]/.test(l)), cbGate38 = tcb38.filter((l) => /^- \[x\] \(AI\) `uismoke`\(/.test(l));
  const man1_38 = (() => { const i = man38.indexOf('<h2 id="s1">'), j = man38.indexOf('<h2 id="s2">'); return i < 0 || j < i ? '' : man38.slice(i, j); })();
  T('v438 ⑬ 문서: FEATURES 기준 ≥ v438·v438 절(폭 단계·안전은 v445·퀴즈 1번 대안 CSS·vsSheetRender 하나·기억 범위·폰 legacy·계약·차량 한 줄·보이는 변화는 PC 폭뿐·rAF·다섯 화면은 각 탭 판에서 넓힘 + 검토 반영 8문장(1680 상한 남김·바뀌는 값 8개·전체선택 그린 행만·펼침 폭 상한·compositionstart·data-keep 같은 행·sel.can·bindRows 뿌리) — 문장 고정)·자리 글 GATES_V438 0 · TESTLIST v438 체크 칸 = 화면 칸 4개 "[ ]/[x] (AI 시험 화면 대상"(v435·v436과 같은 꼴 — 시험 화면으로 닫으면 [x])(계약·차량 펼침 [닫기 ▲]·한글 두 음절 포함) + 게이트 칸 1개 "[x] (AI) `uismoke`"(consheet_check·proctpl_check·settletest·servertest·결함 심기) · PM 0 · MANUAL 1절 "넓은 모니터에서는 … (2026-11 v438)" · CLAUDE.md 폭·부품 줄(vsSheetCheckDef·검토 반영 4) · sw ≥ 438',
    Number((ft38.match(/기준: v(\d+) /) || [0, 0])[1]) >= 438 && ftv38.length > 0 && FT_PINS38.every((s) => ftv38.indexOf(s) > 0) && ftv38.indexOf('GATES_V438') < 0
    && tlv38.length > 0 && tcb38.length === 5 && cbScr38.length === 4 && cbGate38.length === 1 && tcb38.every((l) => l.indexOf('PM') < 0) && tlv38.indexOf('GATES_V438') < 0
    && ['`consheet_check`', '`proctpl_check`', '`settletest`', '`servertest`', '결함 심기'].every((g) => cbGate38[0].indexOf(g) > 0)
    && cbScr38.some((l) => l.indexOf('[닫기 ▲]') > 0 && l.indexOf('1536') > 0) && cbScr38.some((l) => l.indexOf('두 음절') > 0)
    && /<p><b>넓은 모니터에서는<\/b> 표로 보는 화면 — 지시 · 기성·수금 · 거래처 · 인사·일용직 · 입찰 · 계약 · 차량 · 권한관리\(권한 표\) — 이 창 폭에 맞춰 넓어져 옆으로 끌 일이 줄어듭니다/.test(man1_38) && man1_38.indexOf('휴대폰 화면은 바뀌지 않습니다(2026-11 v438)') > 0
    && CL_PINS38.every((s) => cl38.indexOf(s) > 0)
    && Number((sw38.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 438,
    JSON.stringify({ ft: FT_PINS38.filter((s) => ftv38.indexOf(s) < 0).map((s) => s.slice(0, 30)), cl: CL_PINS38.filter((s) => cl38.indexOf(s) < 0).map((s) => s.slice(0, 30)), gates: [ftv38.indexOf('GATES_V438'), tlv38.indexOf('GATES_V438')], cb: tcb38.length, scr: cbScr38.length, gate: cbGate38.length, pm: tcb38.filter((l) => l.indexOf('PM') >= 0).map((l) => l.slice(0, 40)), man: man1_38.indexOf('넓은 모니터'), sw: (sw38.match(/jw-shell-v(\d+)/) || [0, 0])[1] }));
} catch (e) { console.log('  (v438 검사 생략 — ' + e.message + ')'); fails++; }

// ---- v439(11/10 — 45-1 둘째 판: 관리 › 지시 탭을 엑셀형 표로 · PM 11/10 15:56·17:40 결정 ① 자동 지시를 '진행 중'에 같이 · ② 행 끝 처리 버튼은 지시 표에만 —
//      09_조사_문서/표형탭_시안_자료_20261110/단계지시_v439_지시.json · 엑셀형탭_명세_20261110.json sections[key=tasks]):
//      시험 틀 = v438 하네스와 같은 작은 DOM(innerHTML을 넣으면 여는 태그마다 요소를 새로 만듦 · 창 폭은 가짜 matchMedia) + index.html의 실제 함수를 그대로 돌린다 —
//      지시 판정·처리(taskVisible·taskForMe·canActTask·canApproveTask·toggleTaskDone·approveTask·rejectTask·setTaskStatus·spawnNextRecur) · 옛 목록(renderTasksLegacy·taskRowHtml·bindTaskHandlers)
//      · 선택 삭제·복구(renderSelBar·renderDeletedList·bulkRestore·hardDelete) · @vs-sheet 구간 · @task-sheet 구간. 저장·푸시·계약 진행(advanceProc)·모달·서류·[내 것 아님] 서버 호출은 기록만 남기는 대역. 오늘 = 2026-11-10.
//      ① 정의 ② 자동 지시 '진행 중'에 같이·'자동' 칩·구분 거르기·칸 글 ③ 처리 버튼 권한별(관리자·지시 수행 직원) ④ 처리·펼침 동작(누름이 행 펼침으로 안 번짐) ⑤ 보기 권한 ⑥ 완료 칩
//      ⑦ 전체선택·선택 삭제(보이는 행만) ⑧ 폰 legacy(옛 본문 해시·실행·경계) ⑨ 폰 sheet 준비 ⑩ 홈·내 업무 행 함수 무변(해시) ⑪ 제목·합계·오늘 승인 일괄·삭제된 지시 ⑫ 넓힘·CSS·전역 검색·검색칸·정적 ⑬ 문서
try {
  const rd39 = (p) => readFileSync(join(ROOT, p), 'utf8');
  const own39 = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fn39 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < src.length; j++) { const ch = src[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return src.slice(i, j + 1); } } throw new Error('중괄호 짝 안 맞음: ' + name); };
  const line39 = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error('줄 없음: ' + head); return src.slice(i, src.indexOf('\n', i)); };
  const blkOf39 = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < i) throw new Error(a + ' 구간 없음'); return html.slice(i, j); };
  const body39 = (name) => fn39(html, name).replace(/^function [\w$]+/, '').replace(/\r\n/g, '\n');   // 이름 뒤 '(' 부터 — 줄끝(CRLF)은 LF로 맞춰 셈
  const sha39 = (s) => createHash('sha256').update(s).digest('hex');
  const blk39 = blkOf39('// @vs-sheet-start', '// @vs-sheet-end'), tsb39 = blkOf39('// @task-sheet-start', '// @task-sheet-end');
  const unesc39 = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const mq39 = (q, w) => { if (q == null) return true; if (/print/.test(q)) return false; const a = /\(min-width:\s*(\d+)px\)/.exec(q), b = /\(max-width:\s*(\d+)px\)/.exec(q); if (!a && !b) return false; return (!a || w >= +a[1]) && (!b || w <= +b[1]); };
  // 사람(권한 실측 꼴): 관리자 · 지시 수행 비관리자(직원B — 계약 수행) · 지시 보기(직원C — .view.readonly) · 대표
  const MEM39 = [{ id: 'm0', name: '나종운', role: '대표', admin: true }, { id: 'm1', name: '관리자A', admin: true }, { id: 'm2', name: '직원B', perms: { tasks: 'do', con: 'do' } }, { id: 'm3', name: '직원C', perms: { tasks: 'view' } }];
  const U39 = { A: MEM39[1], B: MEM39[2], C: MEM39[3] };
  const PROC39 = [{ id: 'c1', label: '준설', site: '○○동 하천', title: '○○동 하천 준설공사', client: '포항시' }];
  // 지시 표본(오늘 11-10) — a 일반 경과 · b 자동(차량) 앱 기준 승인 대기 · c 계약 단계 기한 없음 · d 보류(직원B 지시) · g 자동(적격) 담당 없음 3일 내 · h 반복 매월 승인 대기(직원B 지시)
  //   · i 공개 관리자A만 · l 입금확인 · n 직원C 담당 · p 자동(인허가) 직원B 담당 · j·k 지운 지시(k는 관리자 전용) · e·f 완료 · z1~z22 완료(관리자 전용 — 완료 24건 > 옛 목록 20건)
  const FIX39 = () => {
    const T0 = (o) => Object.assign({ title: '', detail: '', who_id: '', who: '', scope: [], from: '관리자A', from_id: 'm1', by: '관리자A', due: '', status: 'open', done_at: null, done_by: null, created: '2026-11-01', updated: '2026-11-01' }, o);
    const L = [
      T0({ id: 'a', title: '가 안전점검 결과 정리', detail: '1행 상세\n2행 상세', who_id: 'm2', who: '직원B', due: '2026-11-05' }),
      T0({ id: 'b', title: '나 차량 정기검사 예약', who_id: 'm2', who: '직원B', who_by: 'assign', from: '자동', from_id: '', by: '자동', auto_key: 'veh:v1:insp:2026-11-12', due: '2026-11-12', status: 'review', done_at: '2026-11-10', done_by: '앱 기준', created: '2026-10-13' }),
      T0({ id: 'c', title: '다 준설토 성분분석', who_id: 'm2', who: '직원B', proc_id: 'c1', proc_label: '준설', pipe: 'main', stage_i: 3, stage_total: 9, stage_name: '폐기물 처리', created: '2026-11-03' }),
      T0({ id: 'd', title: '라 사진대지 양식', who_id: 'm3', who: '직원C', from: '직원B', from_id: 'm2', by: '직원B', due: '2026-11-01', status: 'hold', created: '2026-10-20' }),
      T0({ id: 'g', title: '사 적격심사 서류 제출', from: '자동', from_id: '', by: '자동', auto_key: 'bid:b9:qual', due: '2026-11-12', created: '2026-11-06' }),
      T0({ id: 'h', title: '아 소방시설 점검 섭외', who_id: 'm3', who: '직원C', from: '직원B', from_id: 'm2', by: '직원B', recur: 'monthly', recur_root: 'h', due: '2026-11-11', status: 'review', done_at: '2026-11-09', done_by: '직원C', created: '2026-10-26' }),
      T0({ id: 'i', title: '자 관리자 전용 지시', who_id: 'm1', who: '관리자A', scope: ['m1'], due: '2026-11-20', created: '2026-11-02' }),
      T0({ id: 'l', title: '차 입금확인: 포항시', who_id: 'm1', who: '관리자A', from: '기성', rec_id: 'r1', due: '2026-11-15', created: '2026-11-04' }),
      T0({ id: 'n', title: '카 직원C 담당 진행', who_id: 'm3', who: '직원C', due: '2026-11-25', created: '2026-11-07' }),
      T0({ id: 'p', title: '하 인허가 갱신', who_id: 'm2', who: '직원B', who_by: 'assign', from: '자동', from_id: '', by: '자동', auto_key: 'lic:l1:exp:2026-12-01', due: '2026-12-01', created: '2026-11-08' }),
      T0({ id: 'j', title: '타 지운 지시', who_id: 'm2', who: '직원B', del: 1 }),
      T0({ id: 'k', title: '파 지운 관리자 지시', who_id: 'm1', who: '관리자A', scope: ['m1'], del: 1 }),
      T0({ id: 'e', title: '마 보험 갱신 검토', who_id: 'm2', who: '직원B', due: '2026-10-01', status: 'done', done_at: '2026-11-03', done_by: '직원B', approved_by: '관리자A', approved_at: '2026-11-04' }),
      T0({ id: 'f', title: '바 증명서 발급', who_id: 'm2', who: '직원B', from: '자동', from_id: '', by: '자동', auto_key: 'cert:c15', due: '2026-09-01', status: 'done', done_at: '2026-11-08', done_by: '직원B', approved_by: '관리자A', approved_at: '2026-11-09' })];
    for (let q = 1; q <= 22; q++) { const dd = '2026-10-' + String(q).padStart(2, '0'); L.push(T0({ id: 'z' + q, title: '완료 ' + q, who_id: 'm1', who: '관리자A', scope: ['m1'], status: 'done', done_at: dd, done_by: '관리자A', approved_by: '관리자A', approved_at: dd })); }
    return L;
  };
  const REAL39 = ['esc', 'isDate', 'vehDday', 'ddayInfo', 'pad', 'fmtDate', 'liveTasks', 'findTask', 'taskForMe', 'taskVisible', 'canActTask', 'canApproveTask', 'toggleTaskDone', 'approveTask', 'rejectTask', 'setTaskStatus',
    'advanceRecur', 'spawnNextRecur', 'taskNotMineBtn', 'procChipHtml', 'taskRowHtml', 'bindTaskHandlers', 'selCount', 'selBoxHtml', 'bindSelBoxes', 'renderSelBar', 'hardDelete', 'bulkDelete', 'bulkRestore', 'renderDeletedList',
    'moduleArr', 'moduleLive', 'moduleDeleted', 'moduleCan', 'moduleFind', 'saveModule', 'scheduleModuleSave', 'renderModuleList', 'renderModule', 'renderTasksLegacy', 'csTitle', 'csSiteText'];
  const VARS39 = ['  var SHOW_TASK_ISSUER = ', '  var RECUR_LABEL = ', '  var ASSIGN_PREFIX_TXT = '].map((h) => line39(html, h));
  const PRE39 = [
    'var tasks = ENV.fixture, contracts = ENV.procs, members = ENV.members, vehicles = [], receivables = [];',
    'var showTaskDone = false, showTaskAuto = false, showDeletedTasks = false;',
    'var selSets = { tasks:{}, veh:{}, rec:{} }, delSelSets = { tasks:{}, veh:{}, rec:{} };',
    'function todayStr(){ return "2026-11-10"; }',
    'function genId(p){ ENV.gid++; return p + "N" + ENV.gid; }',
    'function curMember(){ return ENV.user; } function myId(){ return ENV.user ? ENV.user.id : ""; } function myName(){ return ENV.user ? ENV.user.name : ""; } function getUser(){ return myName(); }',
    'function isAdmin(){ return !!(ENV.user && ENV.user.admin); }',
    'function permOf(mod){ var u = ENV.user; if (!u) return "hide"; if (u.admin) return "do"; return (u.perms && u.perms[mod]) || "hide"; }',
    'function canDo(mod){ return permOf(mod) === "do"; } function canSee(mod){ return permOf(mod) !== "hide"; }',
    'function findMember(id){ for (var i = 0; i < members.length; i++){ if (members[i].id === id) return members[i]; } return null; }',
    'function memberName(id){ if (!id) return ""; if (id === "__all__") return "전사"; var m = findMember(id); return m ? m.name : ""; }',
    'function dispName(n){ return n === "나종운" ? "대표님" : (n || ""); }',
    'function scopeIncludes(scope, m){ if (!scope || !scope.length) return true; if (!m) return false; return scope.indexOf(m.id) >= 0; }',
    'function scopeNames(tk){ return (tk || []).map(function(id){ var m = findMember(id); return m ? m.name : null; }).filter(Boolean).join(", "); }',
    'function findProc(id){ for (var i = 0; i < contracts.length; i++){ if (contracts[i].id === id) return contracts[i]; } return null; }',
    'function csTaskChg(t){ return !!(t && t.chg_stub); }',
    'function confirm(msg){ ENV.log.push("confirm:" + msg); return ENV.confirmAns !== false; }',
    'function pushNotify(to, title){ ENV.log.push("push:" + to + ":" + title); }',
    'function advanceProc(t){ ENV.log.push("advance:" + t.id); }',
    'function apprToastShow(m){ ENV.log.push("toast:" + m); }',
    'function saveTasksCache(){ ENV.log.push("saveCache"); } function scheduleTasksSave(){ ENV.log.push("schedSave"); }',
    'function saveVehiclesCache(){} function saveRecCache(){} function scheduleVehSave(){} function scheduleRecSave(){} function renderVehicles(){} function renderReceivables(){} function fillRecSort(){}',
    'function renderSummary(){ ENV.log.push("summary"); } function renderDashboard(){ ENV.log.push("dash"); } function renderMyTasks(){ ENV.log.push("mytasks"); } function updateTaskBadge(){ ENV.log.push("badge"); } function bindCalHandlers(){}',
    'function openTaskModal(id){ if (!canDo("tasks")) return; ENV.log.push("edit:" + id); } function openStageDoc(pid, sn){ ENV.log.push("doc:" + pid + ":" + sn); } function taskNotMine(id){ ENV.log.push("notmine:" + id); }',
    'function findVeh(){ return null; } function findRec(){ return null; } function removeRecTask(){}'].join('\n');
  const SRC39 = [PRE39].concat(REAL39.map((n) => fn39(html, n)), VARS39, [blk39, tsb39,
    'return { render: renderTasks, def: taskSheetDef, vs: vsSheetRender, inst: vsInst, filter: vsSheetFilter, setQ: vsSheetSetQ, check: vsSheetCheckDef, minW: vsSheetMinW, cols: vsSheetCols, legacy: renderTasksLegacy, act: taskSheetAct, del: taskSheetDelete, fromGs: taskSheetFromGs, sText: taskSheetSearchText,'
    + ' tasks: function(){ return tasks; }, sel: function(){ return selSets; }, delSel: function(){ return delSelSets; }, setShowDel: function(v){ showDeletedTasks = v; }, setShowAuto: function(v){ showTaskAuto = v; } };']).join('\n');
  const mk39 = (o) => {
    o = o || {};
    const env = { width: o.width || 1366, user: o.user || U39.A, fixture: o.fixture || FIX39(), procs: PROC39.map((c) => Object.assign({}, c)), members: MEM39, mql: [], store: {}, timers: [], now: 100000, log: [], raf: [], ro: [], roCb: null, cw: 1048, confirmAns: true, gid: 0 };
    const doc = { activeElement: null, byId: {} };
    doc.getElementById = (id) => doc.byId[id] || null;
    doc.addEventListener = () => {}; doc.removeEventListener = () => {};
    const mkEl = (tag, attrs) => {
      const el = { tagName: tag.toUpperCase(), attrs, L: {}, scrollLeft: 0, scrollTop: 0, parentNode: null };
      Object.defineProperty(el, 'clientWidth', { get: () => env.cw });
      el.getAttribute = (n) => (own39(attrs, n) ? unesc39(attrs[n]) : null);
      el.setAttribute = (n, v) => { attrs[n] = String(v); };
      el.hasAttribute = (n) => own39(attrs, n);
      el.type = attrs.type || '';
      el.value = own39(attrs, 'value') ? unesc39(attrs.value) : '';
      el.checked = own39(attrs, 'checked');
      const sp = {}; String(attrs.style || '').split(';').forEach((p) => { const k = p.indexOf(':'); if (k > 0) sp[p.slice(0, k).trim()] = p.slice(k + 1).trim(); });
      el.style = { sp, setProperty: (k, v) => { sp[k] = String(v); }, getPropertyValue: (k) => sp[k] || '' };
      const cls = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
      el.classList = { toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) };
      el.addEventListener = (t, f) => { (el.L[t] = el.L[t] || []).push(f); };
      el.fire = (t, ev) => { const e = Object.assign({ target: el, type: t, stopped: false }, ev || {}); e.stopPropagation = () => { e.stopped = true; }; e.preventDefault = () => {}; (el.L[t] || []).slice().forEach((f) => f(e)); return e; };
      el.focus = () => { doc.activeElement = el; };
      el.selectionStart = el.tagName === 'INPUT' ? el.value.length : null;
      el.setSelectionRange = (a) => { el.selectionStart = a; };
      el.scrollIntoView = () => {};
      return el;
    };
    env.mkEl = mkEl;
    const match = (el, sel) => {
      let m = /^\[([\w-]+)\]$/.exec(sel); if (m) return el.hasAttribute(m[1]);
      m = /^\[([\w-]+)="((?:[^"\\]|\\.)*)"\]$/.exec(sel); if (m) return el.getAttribute(m[1]) === m[2].replace(/\\(.)/g, '$1');
      m = /^\.([\w-]+)$/.exec(sel); if (m) return el.classList.contains(m[1]);
      throw new Error('시험 DOM이 모르는 선택자: ' + sel);
    };
    env.mkHost = (id) => {
      const host = { id, attrs: {}, _h: '', _t: '', els: [], visible: true, onclick: null, style: { display: '' } };
      host.getAttribute = (n) => (own39(host.attrs, n) ? host.attrs[n] : null);
      host.setAttribute = (n, v) => { host.attrs[n] = String(v); };
      host.getClientRects = () => (host.visible ? [{}] : []);
      host.contains = (el) => host.els.indexOf(el) >= 0;
      host.querySelectorAll = (sel) => host.els.filter((e) => match(e, sel));
      host.querySelector = (sel) => host.els.find((e) => match(e, sel)) || null;
      host.addEventListener = (t) => { env.log.push('host-listener:' + id + ':' + t); };   // 자리(host)에 위임 배선을 걸면 기록(v438 규칙 — 표 칸 root에만)
      host.classList = { toggle: () => {}, contains: () => false };
      Object.defineProperty(host, 'innerHTML', { get: () => host._h, set: (v) => {
        host._h = String(v); host.els = [];
        for (const t of host._h.matchAll(/<([a-zA-Z][\w-]*)((?:[^<>"]|"[^"]*")*)>/g)) { const attrs = {}; for (const a of t[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2]; host.els.push(mkEl(t[1], attrs)); }
      } });
      Object.defineProperty(host, 'textContent', { get: () => host._t, set: (v) => { host._t = String(v); } });
      doc.byId[id] = host;
      return host;
    };
    env.host = (id) => doc.byId[id];
    ['taskList', 'taskHead', 'taskBulkTop', 'taskBulkApprove', 'taskAutoToggle', 'taskAutoList', 'taskDoneToggle', 'taskDoneList', 'tasksSelBar', 'taskDeletedToggle', 'taskDeletedList'].forEach((id) => env.mkHost(id));
    const win = { get innerWidth() { return env.width; }, matchMedia: (q) => ({ media: q, get matches() { return mq39(q, env.width); }, addEventListener: (t, f) => { env.mql.push(f); } }), requestAnimationFrame: (f) => { env.raf.push(f); } };
    const ls = { getItem: (k) => (own39(env.store, k) ? env.store[k] : null), setItem: (k, v) => { env.store[k] = String(v); }, removeItem: (k) => { delete env.store[k]; } };
    const stF = (f, ms) => { const t = { id: env.timers.length + 1, f, at: env.now + ms, done: false }; env.timers.push(t); return t.id; };
    const ctF = (id) => { env.timers.forEach((t) => { if (t.id === id) t.done = true; }); };
    function RO(cb) { env.roCb = cb; this.observe = (t) => { env.ro.push(t); }; }
    class FD extends Date { static now() { return env.now; } }   // 가짜 시계(v439 검토 — 처리 버튼 연속 누름 막기 0.5초를 시험 시계로 본다. press39·pressDet39는 누르기 전에 1초씩 감)
    const api = new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'ResizeObserver', 'ENV', 'Date', SRC39)(win, doc, ls, stF, ctF, RO, env, FD);
    env.tick = (ms) => { env.now += ms; let t; while ((t = env.timers.filter((x) => !x.done && x.at <= env.now).sort((a, b) => a.at - b.at)[0])) { t.done = true; t.f(); } };
    env.breakAll = () => { env.mql.slice().forEach((f) => f({})); };
    return { api, env, doc, host: env.host('taskList') };
  };
  const order39 = (h) => [...h.matchAll(/data-vs-row="([^"]*)"/g)].map((m) => m[1]).join(',');
  const cnt39 = (h) => (/<span class="vs-count">([^<]*)<\/span>/.exec(h) || ['', ''])[1];
  const rowSeg39 = (h, id) => (new RegExp('<tr class="vs-r[^"]*" data-vs-row="' + id + '">([\\s\\S]*?)</tr>').exec(h) || ['', ''])[1];
  const cells39 = (h, id) => [...rowSeg39(h, id).matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((m) => [m[1], m[2]]);
  const acts39 = (h) => [...h.matchAll(/<tr class="vs-r[^"]*" data-vs-row="([^"]*)">([\s\S]*?)<\/tr>/g)].map((m) => m[1] + ':' + (((/data-tsk-act="(\w+)"/.exec(m[2]) || [])[1]) || '-')).join(',');
  const detActs39 = (h) => { const m = /<div class="vs-act">([\s\S]*?)<\/div>/.exec(h); return m ? [...m[1].matchAll(/data-tsk-act="(\w+)"/g)].map((x) => x[1]).join(',') : '(펼침 없음)'; };
  const kvKeys39 = (h) => [...h.matchAll(/<div class="k">([^<]*)<\/div>/g)].map((m) => m[1]).join('·');
  const kvVal39 = (h, k) => (new RegExp('<div class="k">' + k + '</div><div class="v">([\\s\\S]*?)</div></div>').exec(h) || ['', '?'])[1];
  //   누르기 전에 가짜 시계 1초(연속 누름 막기 0.5초 밖 — 따로 누른 것) · o.fast = 시계 그대로(바로 뒤 누름) · o.detail = 더블클릭 둘째 누름 흉내(e.detail)
  const ev39 = (X, b, o) => { o = o || {}; if (!o.fast) X.env.now += 1000; return o.detail ? { target: b, detail: o.detail } : { target: b }; };
  const press39 = (X, act, id, o) => {   // 실제 누름 흉내: 버튼 → 행(행 토글 리스너 — 버튼 누름은 건너뜀) → 표 칸(처리 열 위임 배선)
    const host = X.host, b = host.els.find((e) => e.getAttribute('data-tsk-act') === act && e.getAttribute('data-tsk-id') === id);
    if (!b) throw new Error('처리 버튼 없음: ' + act + ':' + id);
    const row = host.querySelector('[data-vs-row="' + id + '"]'), wrap = host.querySelector('[data-vs-wrap]'), had = host._h.indexOf('data-vs-det=') >= 0, ev = ev39(X, b, o);
    row.fire('click', ev);
    if (host.querySelector('[data-vs-row="' + id + '"]') !== row || (host._h.indexOf('data-vs-det=') >= 0) !== had) throw new Error('처리 버튼 누름이 행 펼침으로 번짐: ' + id);
    wrap.fire('click', ev);
  };
  const pressDet39 = (X, act, id, o) => {   // 펼침 안 버튼 → 펼침 칸(위임 배선)
    const host = X.host, det = host.querySelector('[data-vs-det]') || host.querySelector('[data-vs-detcard]'), L = host.els.filter((e) => e.getAttribute('data-tsk-act') === act && e.getAttribute('data-tsk-id') === id), b = L[L.length - 1];
    if (!det || !b) throw new Error('펼침 버튼 없음: ' + act + ':' + id);
    det.fire('click', ev39(X, b, o));
  };
  const openRow39 = (X, id) => { const row = X.host.querySelector('[data-vs-row="' + id + '"]'); if (!row) throw new Error('행 없음: ' + id); row.fire('click', { target: row }); };
  const chip39 = (X, k) => { const el = X.host.querySelector('[data-vs-chip="st|' + k + '"]'); if (!el) throw new Error('칩 없음: ' + k); el.fire('click'); };
  const tk39 = (X, id) => X.api.tasks().find((t) => t.id === id) || {};
  const ADMIN_ORDER39 = 'a,h,b,g,l,i,n,p,c,d';

  // ① 정의 — vsSheetCheckDef 통과(폰 legacy·폰 sheet 둘 다) · 열 10(명세 순서·폭·거르기·단계·폰 %, 기한만 160) · 단계별 열 합 712/960/1190 · 칩 8 · 저장 이름·자리·검색칸 id·page 1000 · legacy = 옛 본문 함수
  const X1 = mk39(), d1 = X1.api.def();
  const ck1 = X1.api.check(d1), ck1s = X1.api.check(Object.assign({}, d1, { phone: 'sheet' }));
  const cols1 = d1.cols.map((c) => [c.k, c.h, c.w || 0, c.f, c.lv || 1, c.pw || 0, c.fill ? 'fill' + c.min : '', c.nosort ? 'ns' : ''].join(':')).join('|');
  const COLS39 = 't:지시 내용:0:text:1:52:fill220:|kind:구분:108:enum:2:0::|stage:계약 단계:160:text:3:0::|who:담당:76:enum:2:0::|due:기한:160:none:1:24::|st:상태:88:enum:1:24::|reg:등록일:88:none:3:0::|scope:공개:110:text:4:0::|done:완료:120:none:4:0::|act:처리:60:none:2:0::ns';
  const sums1 = [2, 3, 4].map((s) => X1.api.minW({ colw: {} }, X1.api.cols(d1, s))).join('/');
  const chips1 = d1.chips.length + '|' + d1.chips[0].items.map((it) => it.k + ':' + it.h + (it.warn ? '!' : '') + (it.pc ? '@pc' : '') + (it.sort ? '>' + it.sort.k + it.sort.d : '')).join('|');
  T('v439 ① 지시 표 정의: vsSheetCheckDef 통과(phone legacy·sheet 둘 다 — 폰 열 %합 100) · 열 10 = 명세 순서(지시 내용 남는 폭 최소 220·폰 52 / 구분 108 lv2 enum / 계약 단계 160 lv3 / 담당 76 lv2 enum / 기한 160·폰 24 / 상태 88·폰 24 enum / 등록일 88 lv3 / 공개 110 lv4 / 완료 120 lv4 / 처리 60 lv2 정렬 없음) · 단계별 열 합 712/960/1190 · 칩 한 묶음 8개(진행 중 기본·기한 경과 빨강·승인 대기·보류·자동·계약 단계·완료(완료일 ↓)·전체 — 자동·계약 단계·전체는 PC 전용) · key jw_task_sheet · host taskList · 검색칸 taskSearch · page 1000 · 기본 정렬 기한 ▲ · phone legacy · legacy = renderTasksLegacy · sel.can 있음',
    ck1.length === 0 && ck1s.length === 0 && cols1 === COLS39 && sums1 === '712/960/1190' && chips1 === '1|:진행 중|over:기한 경과!|review:승인 대기|hold:보류|auto:자동@pc|proc:계약 단계@pc|done:완료>done-1|all:전체@pc'
    && d1.key === 'jw_task_sheet' && d1.host === 'taskList' && d1.search && d1.search.id === 'taskSearch' && d1.page === 1000 && d1.sort.k === 'due' && d1.sort.d === 1 && d1.phone === 'legacy' && d1.legacy === X1.api.legacy
    && typeof d1.onMode === 'function' && d1.sel && typeof d1.sel.can === 'function' && typeof d1.bindRows === 'function' && typeof d1.bind === 'function' && X1.api.def() === d1,
    JSON.stringify({ ck1, ck1s, cols1: cols1 === COLS39 ? 'ok' : cols1, sums1, chips1 }));

  // ② 자동 지시가 '진행 중'에 같이(결정 ①) · '자동' 칩 · 구분 거르기 · 칸 글(구분 짧은 이름 + '자동' 칩 + 배정표 이름 title · 담당 없음 · 계약 단계 막대 · 기한 입력 · 경과 빨강 · 3일 내 노랑 · 보류 색 없음)
  const X2 = mk39(); X2.api.render(); const h2 = () => X2.host._h;
  const o2 = [order39(h2()), cnt39(h2())];
  const cb2 = cells39(h2(), 'b'), cg2 = cells39(h2(), 'g'), cc2 = cells39(h2(), 'c'), ca2 = cells39(h2(), 'a'), cd2 = cells39(h2(), 'd'), ch2 = cells39(h2(), 'h'), cl2 = cells39(h2(), 'l');
  const kOpts2 = ((/<select data-vf="kind">([\s\S]*?)<\/select>/.exec(h2()) || ['', ''])[1].match(/<option value="[^"]*"/g) || []).map((s) => s.slice(15, -1)).join('|');
  const cellOk2 = cb2[1] && cb2[1][0] === ' class="vs-hs" title="배정표 이름: 차량 만기(정기검사·보험)"' && cb2[1][1] === '<span class="review-chip">자동</span> 차량 만기'
    && cg2[1][1] === '<span class="review-chip">자동</span> 적격심사' && /^<span class="hold-chip" title="배정표\(권한관리\)에 이 접두어의 담당이 없습니다[^"]*">담당 없음<\/span>$/.test(cg2[3][1])
    && cc2[2][1] === '<span class="cs-bar"><i style="width:44%"></i></span>4/9 · 폐기물 처리' && cc2[4][1] === '<span class="need-due">기한 입력</span>' && cc2[1][1] === '계약 단계'
    && ca2[4][0] === ' class="vs-dan" title="2026-11-05 경과 5일"' && ca2[4][1] === '2026-11-05 경과 5일' && cg2[4][0] === ' class="vs-warn" title="2026-11-12"' && cg2[4][1] === '2026-11-12 D-2'
    && cd2[4][0] === ' title="2026-11-01"' && cd2[4][1] === '2026-11-01 <span style="color:#9AA09C;">D+9</span>' && cd2[5][1] === '<span class="hold-chip">보류</span>'
    && ch2[1][1] === '반복 · 매월' && ch2[5][1] === '<span class="review-chip">승인 대기</span>' && cl2[1][1] === '입금확인' && ca2[1][1] === '일반' && /<input type="checkbox" class="sel-box" data-vs-sel="a">가 안전점검 결과 정리$/.test(ca2[0][1]);
  chip39(X2, 'auto'); o2.push(order39(h2()), cnt39(h2()));
  chip39(X2, ''); X2.api.filter(X2.api.def(), 'kind', '자동 · 적격심사'); o2.push(order39(h2()));
  X2.api.filter(X2.api.def(), 'kind', '계약 단계'); o2.push(order39(h2()));
  X2.api.filter(X2.api.def(), 'kind', ''); chip39(X2, 'done'); X2.api.filter(X2.api.def(), 'kind', '자동 · 증명서'); o2.push(order39(h2()));
  T('v439 ② 자동 지시 = 기본 화면(진행 중)에 같이(PM 결정 ①): 진행 중 = 완료 전 전부 "' + ADMIN_ORDER39 + '"(자동 b·g·p 포함 · 기한 ▲ · 기한 없음 c 뒤 · 보류 d 맨 뒤) "보이는 10건 / 전체 34건" · \'자동\' 칩 = b,g,p · 구분 거르기 "자동 · 적격심사" = g · "계약 단계" = c · 완료 AND "자동 · 증명서" = f · 구분 고르기 목록 = 계약 단계|반복|일반|입금확인|자동 · 인허가|자동 · 적격심사|자동 · 증명서|자동 · 차량 만기(자동끼리 모임) · 칸 글: 구분 \'자동\' 칩 + 짧은 이름(차량 만기·적격심사)·title 배정표 이름 / 계약 단계·입금확인·반복 · 매월·일반 · 담당 없음 칩 · 계약 단계 막대 44% "4/9 · 폐기물 처리" · 기한 입력 · 경과 빨강 "2026-11-05 경과 5일"(title도 같은 글 — 칸이 좁아 잘려도 일수, 검토 반영) · 3일 내 노랑 "2026-11-12 D-2" · 보류는 색 없이 회색 D+9 · 상태 칩(승인 대기·보류) · 첫 칸 선택 체크 + 제목',
    o2[0] === ADMIN_ORDER39 && o2[1] === '보이는 10건 / 전체 34건' && o2[2] === 'b,g,p' && o2[3] === '보이는 3건 / 전체 34건' && o2[4] === 'g' && o2[5] === 'c' && o2[6] === 'f'
    && kOpts2 === '|계약 단계|반복|일반|입금확인|자동 · 인허가|자동 · 적격심사|자동 · 증명서|자동 · 차량 만기' && cellOk2,
    JSON.stringify({ o2, kOpts2, cellOk2, b: cb2.slice(1, 2), g: [cg2[1], cg2[3], cg2[4]], c: [cc2[2], cc2[4]], a: [ca2[0], ca2[4]], d: [cd2[4], cd2[5]] }));

  // ③ 처리 버튼 권한별(결정 ②) — 행 끝 처리 열 하나: 승인 대기 = [승인](canApproveTask) · 보류 = [재개](canDo) · 진행 = [완료](canActTask) · 완료 = 없음 / 펼침 버튼 = 지금 규칙
  //   관리자(전부) · 지시 수행 비관리자 직원B(관리자 전용 i 안 보임 · 자기가 지시한 h만 [승인] · 앱 기준 자동 b는 승인 못 함 · 자기 담당 자동 p에 [내 것 아님])
  const X3 = mk39(); X3.api.render();
  const a3 = acts39(X3.host._h);
  const det3 = {}; ['b', 'c', 'd', 'p'].forEach((id) => { openRow39(X3, id); det3[id] = detActs39(X3.host._h); });
  const Y3 = mk39({ user: U39.B }); Y3.api.render();
  const b3 = [order39(Y3.host._h), cnt39(Y3.host._h), acts39(Y3.host._h)];
  const detB3 = {}; ['b', 'h', 'p', 'c'].forEach((id) => { openRow39(Y3, id); detB3[id] = detActs39(Y3.host._h); });
  T('v439 ③ 처리 버튼 권한별: 관리자 처리 열 a 완료·h 승인·b 승인·g 완료·l 완료·i 완료·n 완료·p 완료·c 완료·d 재개 · 펼침 b(승인 대기) 승인·반려·완료취소·삭제 / c(계약 단계) 완료·📄 서류·보류·수정·삭제 / d(보류) 완료·재개·수정·삭제 / p(남의 자동) 완료·보류·수정·삭제 · 직원B(지시 수행) 행 = a,h,b,g,l,n,p,c,d(관리자 전용 i 빠짐) "보이는 9건 / 전체 11건" · 처리 열 b 없음(앱 기준 자동은 승인권자 아님)·h 승인(자기가 지시)·d 재개 · 펼침 b 완료취소·삭제 / h 승인·반려·완료취소·삭제 / p(자기 담당 자동) 완료·보류·수정·내 것 아님·삭제 / c 완료·📄 서류(계약 수행)·보류·수정·삭제',
    a3 === 'a:done,h:approve,b:approve,g:done,l:done,i:done,n:done,p:done,c:done,d:resume'
    && det3.b === 'approve,reject,cancel,del' && det3.c === 'done,doc,hold,edit,del' && det3.d === 'done,resume,edit,del' && det3.p === 'done,hold,edit,del'
    && b3[0] === 'a,h,b,g,l,n,p,c,d' && b3[1] === '보이는 9건 / 전체 11건' && b3[2] === 'a:done,h:approve,b:-,g:done,l:done,n:done,p:done,c:done,d:resume'
    && detB3.b === 'cancel,del' && detB3.h === 'approve,reject,cancel,del' && detB3.p === 'done,hold,edit,notmine,del' && detB3.c === 'done,doc,hold,edit,del',
    JSON.stringify({ a3, det3, b3, detB3 }));

  // ④ 처리·펼침 버튼 동작(관리자) — 처리 열 누름은 행 펼침으로 번지지 않음(같은 행 요소·펼침 없음) · [완료] = 승인 대기(완료 요청자·승인권자 푸시) · [승인] = 완료 + 반복 다음 회차(한 달 뒤) / 계약 단계 진행(advanceProc)
  //   · [재개] · 펼침 [📄 서류]·[반려](앱 기준이면 완료 신호 끔)·[보류]·[수정]·[삭제](확인 — 휴지통)·[되돌리기] · 확인 창 취소면 그대로 · 보기 권한 흉내 누름은 무시
  const X4 = mk39(), L4 = X4.env.log; X4.api.render();
  press39(X4, 'done', 'a'); const s4a = [tk39(X4, 'a').status, tk39(X4, 'a').done_by, L4.indexOf('push:__admins__:승인요청: 가 안전점검 결과 정리') >= 0, /data-vs-row="a">[\s\S]*?data-tsk-act="approve" data-tsk-id="a"/.test(X4.host._h)];
  openRow39(X4, 'a'); s4a.push(detActs39(X4.host._h)); pressDet39(X4, 'cancel', 'a'); s4a.push(tk39(X4, 'a').status, tk39(X4, 'a').done_by);   // 펼침 [완료취소] = 다시 진행(완료 요청 지움)
  press39(X4, 'approve', 'h'); const nx4 = X4.api.tasks().filter((t) => t.recur_root === 'h' && t.id !== 'h');
  const s4h = [tk39(X4, 'h').status, tk39(X4, 'h').approved_by, L4.indexOf('advance:h') >= 0, L4.indexOf('push:m3:승인됨: 아 소방시설 점검 섭외') >= 0, nx4.length, nx4[0] && nx4[0].due, nx4[0] && nx4[0].status, nx4[0] && nx4[0].recur];
  openRow39(X4, 'c'); pressDet39(X4, 'doc', 'c'); const s4doc = L4.indexOf('doc:c1:폐기물 처리') >= 0;
  press39(X4, 'done', 'c'); press39(X4, 'approve', 'c'); const s4c = [tk39(X4, 'c').status, L4.indexOf('advance:c') >= 0];
  press39(X4, 'resume', 'd'); const s4d = tk39(X4, 'd').status;
  openRow39(X4, 'b'); const s4b0 = /data-vs-det="b"/.test(X4.host._h); pressDet39(X4, 'reject', 'b'); const s4b = [s4b0, tk39(X4, 'b').status, tk39(X4, 'b').doneif_off, tk39(X4, 'b').done_by];
  openRow39(X4, 'g'); pressDet39(X4, 'hold', 'g'); const s4g = [tk39(X4, 'g').status, detActs39(X4.host._h)]; pressDet39(X4, 'edit', 'g'); s4g.push(L4.indexOf('edit:g') >= 0);
  X4.env.confirmAns = false; openRow39(X4, 'n'); pressDet39(X4, 'del', 'n'); const s4n = [tk39(X4, 'n').del, L4.indexOf('confirm:이 지시를 삭제할까요? (나중에 복구 가능)') >= 0]; X4.env.confirmAns = true;
  openRow39(X4, 'l'); pressDet39(X4, 'del', 'l'); const s4l = [tk39(X4, 'l').del, order39(X4.host._h).split(',').indexOf('l')];
  chip39(X4, 'done'); openRow39(X4, 'e'); const s4e0 = detActs39(X4.host._h); pressDet39(X4, 'reopen', 'e'); const s4e = [s4e0, tk39(X4, 'e').status, tk39(X4, 'e').approved_by];
  //   보기 권한 흉내: 직원C로 바꾸고 화면에 없는 버튼을 만들어 누름 → 누름 길의 지금 규칙(canDo)이 막음. 대상은 직원C 담당 지시(n 진행·d 보류·h 완료) — 아래 함수(setTaskStatus·toggleTaskDone)는
  //   담당 본인이면 canActTask로 통과시키므로, 누름 길의 canDo 검사가 빠지면 여기서 바뀐다(결함 심기 1회차에서 남의 지시를 대상으로 해 놓친 3종 보강) · [삭제]·[📄 서류]·[수정]은 남의 지시 p·c
  chip39(X4, ''); tk39(X4, 'd').status = 'hold'; X4.env.user = U39.C; X4.api.render();
  const fake4 = (act, id) => { const b = X4.env.mkEl('button', { type: 'button', class: 'mini-btn', 'data-tsk-act': act, 'data-tsk-id': id }); X4.host.querySelector('[data-vs-wrap]').fire('click', ev39(X4, b)); };
  fake4('hold', 'n'); fake4('resume', 'd'); fake4('reopen', 'h'); fake4('del', 'p'); fake4('doc', 'c'); fake4('edit', 'p');
  const s4v = [tk39(X4, 'n').status, tk39(X4, 'd').status, tk39(X4, 'h').status, tk39(X4, 'p').del, L4.filter((l) => l === 'doc:c1:폐기물 처리').length, L4.filter((l) => l === 'edit:p').length];
  T('v439 ④ 처리·펼침 동작(관리자): 처리 열 [완료] 누름 = 행 펼침으로 안 번짐 → a 승인 대기·완료 요청 관리자A·승인권자 푸시(__admins__)·처리 열이 [승인]으로 → 펼침 승인·반려·완료취소·삭제 → [완료취소] = 다시 진행 · h [승인] = 완료·승인자·푸시(담당)·반복 다음 회차 1건(due 2026-12-11·open·monthly) · c 펼침 [📄 서류] = openStageDoc(c1, 폐기물 처리) · c [완료] → [승인] = 완료 + 계약 단계 진행(advanceProc) · d [재개] = open · b 펼침 [반려] = open·완료 신호 끔(doneif_off 1)·완료 요청 지움 · g [보류] = hold·펼침 버튼 재개로 · [수정] = 수정 창 · [삭제] 확인 취소 = 그대로 / 확인 = del 1·행 빠짐 · 완료 e [되돌리기] = open·승인 지움 · 보기 권한(직원C)으로 바꾼 뒤 누른 [보류](자기 담당 n)·[재개](자기 담당 d)·[되돌리기](자기 담당 h)·[삭제]·[📄 서류]·[수정] = 무시(누름 길이 canDo를 다시 봄)',
    JSON.stringify(s4a) === '["review","관리자A",true,true,"approve,reject,cancel,del","open",null]' && JSON.stringify(s4h) === '["done","관리자A",true,true,1,"2026-12-11","open","monthly"]' && s4doc
    && JSON.stringify(s4c) === '["done",true]' && s4d === 'open' && JSON.stringify(s4b) === '[true,"open",1,null]' && JSON.stringify(s4g) === '["hold","done,resume,edit,del",true]'
    && JSON.stringify(s4n) === '[null,true]' && JSON.stringify(s4l) === '[1,-1]' && JSON.stringify(s4e) === '["reopen,del","open",null]' && JSON.stringify(s4v) === '["open","hold","done",null,1,0]',
    JSON.stringify({ s4a, s4h, s4doc, s4c, s4d, s4b, s4g, s4n, s4l, s4e, s4v }).replace(/null/g, 'x'));

  // ⑤ 보기 권한(직원C — 지시 'view' → .view.readonly): 선택 칸·선택 막대 없음 · 그린 버튼은 전부 .vs-chip(읽기 토글) 아니면 .mini-btn(보기 권한 CSS가 숨김) · 처리 버튼은 자기 담당 n의 [완료] 하나뿐
  //   · CSS .view.readonly .mini-btn·.add-row·.link-btn 숨김 · 제목 [오늘 승인 일괄]도 .mini-btn · 삭제된 지시 링크는 수행 권한만
  const X5 = mk39({ user: U39.C }); X5.api.render(); openRow39(X5, 'n');
  const h5 = X5.host._h, btn5 = [...h5.matchAll(/<button([^>]*)>/g)].map((m) => (/class="([^"]*)"/.exec(m[1]) || ['', ''])[1]);
  const css5 = (() => { const i = html.indexOf('<style>'), j = html.indexOf('</style>', i); return html.slice(i + 7, j).replace(/\/\*[\s\S]*?\*\//g, ''); })();
  const ro5 = /\.view\.readonly \.add-row,\s*\.view\.readonly \.del-x,\s*\.view\.readonly \.mini-btn,\s*\.view\.readonly \.link-btn\{display:none !important;\}/.test(css5);
  openRow39(X5, 'c'); const c5 = detActs39(X5.host._h);   // 남의 계약 단계 지시 펼침 = 버튼 0(📄 서류는 계약 수행 · 보류·수정·삭제는 지시 수행)
  T('v439 ⑤ 보기 권한(직원C — .view.readonly): 선택 칸(sel-box)·선택 막대 없음 · 표·펼침의 버튼 ' + btn5.length + '개 전부 vs-chip 또는 mini-btn(보기 권한 CSS가 mini-btn을 숨김 — 칩·필터 초기화·[닫기 ▲]만 보임) · 처리 열 버튼은 자기 담당 n [완료] 하나(mini-btn — 숨김) · 펼침 버튼 n 완료 하나 · 남의 계약 단계 지시 c 펼침 버튼 0 · CSS .view.readonly .add-row·.mini-btn·.link-btn{display:none !important} · 제목 [오늘 승인 일괄](taskBulkTop)도 mini-btn · 삭제된 지시 링크 숨김(수행 권한만)',
    h5.indexOf('sel-box') < 0 && h5.indexOf('data-vs-selbar') < 0 && btn5.length >= 10 && btn5.every((c) => /(^| )(vs-chip|mini-btn)( |$)/.test(c))
    && acts39(h5).split(',').filter((x) => !/:-$/.test(x)).join(',') === 'n:done' && detActs39(h5) === 'done' && c5 === '' && ro5
    && /<button type="button" class="mini-btn" id="taskBulkTop"/.test(html) && X5.env.host('taskDeletedToggle').style.display === 'none',
    JSON.stringify({ btn: btn5.filter((c) => !/(^| )(vs-chip|mini-btn)( |$)/.test(c)), sel: h5.indexOf('sel-box'), acts: acts39(h5), det: detActs39(h5), c5, ro5, del: X5.env.host('taskDeletedToggle').style.display }));

  // ⑥ 완료 칩 — 자르지 않음(24건 > 옛 목록 20건) · 완료일 최근 먼저(f 11-08 · e 11-03 · z22 10-22 … z1 10-01) · 1920에서는 완료 머리에 ▼
  const X6 = mk39(); X6.api.render(); chip39(X6, 'done');
  const o6 = [order39(X6.host._h), cnt39(X6.host._h), acts39(X6.host._h).split(',').every((x) => /:-$/.test(x))];   // 완료 줄 처리 열 = 버튼 없음([완료]를 그리면 누름이 되돌리기가 됨 — [되돌리기]는 펼침에만)
  const Z6 = 'f,e,' + Array.from({ length: 22 }, (_, i) => 'z' + (22 - i)).join(',');
  const X6b = mk39({ width: 1920 }); X6b.api.render(); chip39(X6b, 'done');
  const ar6 = [...X6b.host._h.matchAll(/data-vs-sort="(\w+)"[^>]*>[^<]*<span class="vs-ar">(▲|▼)<\/span>/g)].map((m) => m[1] + m[2]).join(',');
  T('v439 ⑥ 완료 칩: 자르기 없이 24건(옛 목록은 20건) "보이는 24건 / 전체 34건" · 완료일 최근 먼저 f,e,z22…z1 · 완료 줄 처리 열 버튼 0 · 1920(완료 열 보임)에서 정렬 표시 = 완료 ▼',
    o6[0] === Z6 && o6[1] === '보이는 24건 / 전체 34건' && o6[2] === true && order39(X6b.host._h) === Z6 && ar6 === 'done▼',
    JSON.stringify({ o6: o6[0].slice(0, 40), c: o6[1], ar6 }));

  // ⑦ 전체선택 = 그린 행만 · 칩을 바꾸면 숨은 선택 풂 · 선택 삭제 = 보이는 행만(확인 — 휴지통) · 직원B: 보이지 않는 지시(i)를 미리 골라 둬도 셈·삭제에 안 들어감
  const X7 = mk39(); X7.api.render();
  const sa7 = X7.host.querySelector('[data-vs-selall]'); sa7.checked = true; sa7.fire('change');
  const s7a = Object.keys(X7.api.sel().tasks).sort().join(','), bar7 = (/전체선택\(보이는 (\d+)건\)/.exec(X7.host._h) || [0, ''])[1];
  chip39(X7, 'done'); const s7b = Object.keys(X7.api.sel().tasks).length;
  chip39(X7, '');
  ['a', 'i'].forEach((id) => { const cb = X7.host.querySelector('[data-vs-sel="' + id + '"]'); cb.checked = true; cb.fire('change'); });
  const btn7 = (/data-vs-selact="0"[^>]*>([^<]*)<\/button>/.exec(X7.host._h) || [0, ''])[1];
  X7.host.querySelector('[data-vs-selact="0"]').fire('click');
  const s7c = [tk39(X7, 'a').del, tk39(X7, 'i').del, X7.env.log.indexOf('confirm:2건을 삭제할까요? (나중에 복구 가능)') >= 0, Object.keys(X7.api.sel().tasks).length, order39(X7.host._h)];
  const Y7 = mk39({ user: U39.B }); Y7.api.sel().tasks.i = 1; Y7.api.render();
  const cbA7 = Y7.host.querySelector('[data-vs-sel="a"]'); cbA7.checked = true; cbA7.fire('change');
  const yb7 = [(/data-vs-selact="0"[^>]*>([^<]*)<\/button>/.exec(Y7.host._h) || [0, ''])[1], Y7.host._h.indexOf('숨은 선택') < 0];
  Y7.host.querySelector('[data-vs-selact="0"]').fire('click');
  const s7d = [tk39(Y7, 'a').del, tk39(Y7, 'i').del, Y7.env.log.indexOf('confirm:1건을 삭제할까요? (나중에 복구 가능)') >= 0];
  Y7.api.del(['i', 'g'], false); s7d.push(tk39(Y7, 'i').del, tk39(Y7, 'g').del);   // 삭제 함수를 직접 불러도 행 원천(보이는 지시) 밖 id는 버림
  T('v439 ⑦ 전체선택·선택 삭제: 전체선택 = 그린 행 10건(진행 중 — 완료 24건 빠짐) "전체선택(보이는 10건)" · 완료 칩으로 바꾸면 숨은 선택 풂(0) · a·i 골라 [선택 삭제 (2)] = 확인 "2건을 삭제할까요? (나중에 복구 가능)" → del 1·선택 비움·행 빠짐 · 직원B: 안 보이는 i를 미리 골라 둬도 [선택 삭제 (1)]·숨은 선택 없음 → a만 지움(i 그대로) · 삭제 함수를 i·g로 직접 불러도 g만',
    s7a === 'a,b,c,d,g,h,i,l,n,p' && bar7 === '10' && s7b === 0 && btn7 === '선택 삭제 (2)' && JSON.stringify(s7c) === '[1,1,true,0,"h,b,g,l,n,p,c,d"]'
    && JSON.stringify(yb7) === '["선택 삭제 (1)",true]' && JSON.stringify(s7d) === '[1,null,true,null,1]',
    JSON.stringify({ s7a, bar7, s7b, btn7, s7c, yb7, s7d }).replace(/null/g, 'x'));

  // ⑧ 폰 legacy(859px 이하 — 퀴즈 2번 답 확인 중이라 지금 화면 그대로): 옛 본문 renderTasksLegacy = v438(43e61b0) renderTasks 본문 글자째(해시) · 실행 = 옛 카드 목록(자동 만기 접이식·완료 보기 20건·오늘 승인 일괄 링크·선택 막대)
  //   · 표 전용 제목 글·일괄 버튼 없음 · 1366으로 넓히면(경계 한 번) 표 + 옛 요소 숨김 + 제목 건수 · 다시 375면 옛 목록·[완료 보기] 되살림
  const LEG_SHA39 = '182f2805c9b7114bc0545942aee2d4e4dcf501439edf489e1bbca96d4bcd6276';
  const X8 = mk39({ width: 375 }), E8 = X8.env; const r8 = X8.api.render();
  const H8 = (id) => E8.host(id);
  const s8a = [r8 === undefined, (X8.host._h.match(/class="item task-item/g) || []).length, X8.host._h.indexOf('data-vs-') < 0, H8('taskAutoToggle').style.display, H8('taskAutoToggle').textContent, (H8('taskAutoList')._h.match(/class="item task-item/g) || []).length,
    H8('taskDoneToggle').textContent, H8('taskDoneToggle').style.display, H8('taskBulkApprove').style.display, H8('taskBulkApprove').textContent, H8('tasksSelBar').style.display, H8('taskHead').textContent, H8('taskBulkTop').style.display, E8.log.indexOf('badge') >= 0 && E8.log.indexOf('mytasks') >= 0];
  E8.width = 1366; E8.breakAll();
  const s8b = [X8.host._h.indexOf('data-vs-table') > 0, ['taskAutoToggle', 'taskBulkApprove', 'taskAutoList', 'taskDoneToggle', 'taskDoneList', 'tasksSelBar'].map((id) => H8(id).style.display).join(','), H8('taskHead').textContent, H8('taskBulkTop').style.display, H8('taskBulkTop').textContent, order39(X8.host._h)];
  E8.width = 375; E8.breakAll();
  const s8c = [(X8.host._h.match(/class="item task-item/g) || []).length, X8.host._h.indexOf('data-vs-') < 0, H8('taskDoneToggle').style.display, H8('taskHead').textContent, H8('taskBulkTop').style.display];
  const leg8 = sha39(body39('renderTasksLegacy'));
  T('v439 ⑧ 폰 legacy(375): 옛 본문 renderTasksLegacy = v438 renderTasks 본문 글자째(sha256 ' + LEG_SHA39.slice(0, 12) + '…) · 실행 = 옛 카드 7장(진행 일반·계약·보류·반복·입금확인 — 자동 b·g·p는 접이식) · 표 글 0 · [자동 만기 보기 (3)] 보임·접이식 카드 3장 · [완료 보기 (20)](24건 중 20 — 옛 자르기 그대로) · [오늘 승인 일괄 (1)] 링크 · 선택 막대 flex · 탭 배지·내 업무 다시 그림 · 제목 글 없음·taskBulkTop 숨김 → 1366(경계 한 번) = 표 + 옛 요소 6개 숨김 + 제목 "진행 중 10 · 기한 경과 1" + [오늘 승인 일괄 (1)] → 다시 375 = 옛 카드 7장·[완료 보기] 되살림·제목 글·일괄 버튼 걷음',
    leg8 === LEG_SHA39 && JSON.stringify(s8a) === '[true,7,true,"block","자동 만기 보기 (3)",3,"완료 보기 (20)","","inline-block","오늘 승인 일괄 (1)","flex","","none",true]'
    && JSON.stringify(s8b) === '[true,"none,none,none,none,none,none","진행 중 10 · 기한 경과 1","inline-block","오늘 승인 일괄 (1)","' + ADMIN_ORDER39 + '"]'
    && JSON.stringify(s8c) === '[7,true,"","","none"]',
    JSON.stringify({ leg: leg8.slice(0, 12), s8a, s8b, s8c }));

  // ⑨ 폰 sheet 준비(퀴즈 2번 답이 '폰도 새 표'면 정의 phone 한 줄만 "sheet"): 폰 열 3(지시 내용 52·기한 24·상태 24 %) · 상태 칸 = 처리 버튼(할 수 있는 분) · 폰 기한 D±n · 폰 합계 '합계 · 경과 · 대기' · 자동·계약 단계·전체 칩 PC 전용 · 행 누름 = 표 아래 상세 카드
  const X9 = mk39({ width: 375 }), d9 = Object.assign({}, X9.api.def(), { phone: 'sheet' }); X9.api.vs(d9);
  const h9 = X9.host._h, cg9 = [...h9.matchAll(/<col data-vs-col="(\w+)" style="([^"]*)">/g)].map((m) => m[1] + '=' + m[2]).join(',');
  const ca9 = cells39(h9, 'a'), cd9 = cells39(h9, 'd'), cb9 = cells39(h9, 'b');
  const ft9 = ((/<tfoot><tr>([\s\S]*?)<\/tr><\/tfoot>/.exec(h9) || ['', ''])[1].match(/<td[^>]*>([^<]*)<\/td>/g) || []).map((s) => s.replace(/<[^>]+>/g, '')).join('|');
  const pc9 = ['auto', 'proc', 'all'].every((k) => new RegExp('class="vs-chip vs-pc" data-vs-chip="st\\|' + k + '"').test(h9)) && /class="vs-chip on" data-vs-chip="st\|"/.test(h9);
  openRow39(X9, 'a'); const dc9 = [/<div class="vs-detcard" data-vs-detcard="a">/.test(X9.host._h), X9.host._h.indexOf('<tr class="vs-det">') < 0, detActs39(X9.host._h)];
  //   보기 권한(직원C — 자기 담당 n 진행·d 보류·h 승인 대기): 상태 칸 = 상태 글(처리 버튼은 지시 수행 권한만 — 보기 권한 CSS가 버튼을 숨겨 칸이 비지 않게, v439 검토) · 표에 처리 버튼 0
  const X9c = mk39({ width: 375, user: U39.C }), d9c = Object.assign({}, X9c.api.def(), { phone: 'sheet' }); X9c.api.vs(d9c);
  const st9c = ['n', 'd', 'h'].map((id) => (cells39(X9c.host._h, id)[2] || ['', '(없음)'])[1]).join('|'), ta9c = (X9c.host._h.match(/data-tsk-act=/g) || []).length;
  T('v439 ⑨ 폰 sheet 준비(phone 한 줄만 바꾸면 되게): 정의 검사 통과 · 열 3 = t --pw 52%·due 24%·st 24% · a 기한 "D+5"(빨강)·상태 칸 [완료] · d 상태 칸 [재개] · b 상태 칸 [승인] · 합계 "합계 10건|경과 1|대기 2" · 자동·계약 단계·전체 칩 vs-pc(폰 숨김) · 행 누름 = 표 아래 상세 카드(표 안 펼침 없음)·버튼 완료·보류·수정·삭제 · 보기 권한(직원C) 상태 칸 = 상태 글 n 진행·d 보류 칩·h 승인 대기 칩(처리 버튼 0 — 검토 반영)',
    X9.api.check(d9).length === 0 && cg9 === 't=--pw:52%;,due=--pw:24%;,st=--pw:24%;' && ca9[1][0] === ' class="vs-dan" title="2026-11-05"' && ca9[1][1] === 'D+5' && /data-tsk-act="done" data-tsk-id="a"/.test(ca9[2][1])
    && /data-tsk-act="resume" data-tsk-id="d"/.test(cd9[2][1]) && /data-tsk-act="approve" data-tsk-id="b"/.test(cb9[2][1]) && ft9 === '합계 10건|경과 1|대기 2' && pc9 && JSON.stringify(dc9) === '[true,true,"done,hold,edit,del"]'
    && st9c === '진행|<span class="hold-chip">보류</span>|<span class="review-chip">승인 대기</span>' && ta9c === 0,
    JSON.stringify({ cg9, a: ca9.slice(1, 3), ft9, pc9, dc9, st9c, ta9c }));

  // ⑩ 홈·내 업무 행 함수 무변 — taskRowHtml·myTaskRowHtml·bindTaskHandlers·renderMyTasks·myOpenTasks = v438(43e61b0) 원문 글자째(해시) · 표 구간이 이 함수들을 다시 정의하지 않음
  const ROWSHA39 = { taskRowHtml: '7551762e4f45f494ca6c5b613d7298e0c7a80e4e8b2521d919e7e90dc870f068', myTaskRowHtml: '6ca787b55b82ea05024badf543c00e1ab70bbf8e08a13ffe5fbe6df22f90347f', bindTaskHandlers: '0b30c25b5b80cb79b12adafdd60d85c24574d1f5088e95ce366d70f9cfca531e',
    renderMyTasks: 'e97e59dd3ce324be31863f0f572f3b5e1912e8eafabd3e038c3a996f9d61c88f', myOpenTasks: 'fb2988cb6985492ae6103c7c5a7da5e7b739d3224ff0ad19596fac7d786ed8dc' };
  const rowBad39 = Object.keys(ROWSHA39).filter((n) => sha39(body39(n)) !== ROWSHA39[n] || (html.match(new RegExp('function ' + n + '\\(', 'g')) || []).length !== 1);
  T('v439 ⑩ 홈·내 업무 행 함수 무변: taskRowHtml·myTaskRowHtml·bindTaskHandlers·renderMyTasks·myOpenTasks = v438(43e61b0) 원문 글자째(sha256) · 파일에 한 번씩만 정의(표 구간은 칸·펼침 함수를 새로 씀)',
    rowBad39.length === 0 && ['taskRowHtml', 'myTaskRowHtml', 'bindTaskHandlers'].every((n) => tsb39.indexOf('function ' + n + '(') < 0), '바뀜: ' + rowBad39.join(','));

  // ⑪ 제목·합계·오늘 승인 일괄·삭제된 지시 — 제목 '진행 중 n · 기한 경과 m'(보이는 행) · 합계 줄(1366: 자동·계약·경과·3일 내·대기·보류 / 1000: 구분 칸에 '자동 n · 계약 n') · [오늘 승인 일괄 (n)] = 앱 기준 자동 승인 대기(승인권자만)
  //   · 삭제된 지시 = 보이는 지시만(직원B j만 · 관리자 j·k) · [영구삭제] 관리자만(버튼·누름 길 둘 다) · 고른 것 중 안 보이는 id는 그릴 때 풂
  const X11 = mk39(); X11.api.render(); const E11 = X11.env;
  const ft11 = ((/<tfoot><tr>([\s\S]*?)<\/tr><\/tfoot>/.exec(X11.host._h) || ['', ''])[1].match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((s) => s.replace(/^<td[^>]*>|<\/td>$/g, '')).join('|');
  const X11b = mk39({ width: 1000 }); X11b.api.render();
  const ft11b = ((/<tfoot><tr>([\s\S]*?)<\/tr><\/tfoot>/.exec(X11b.host._h) || ['', ''])[1].match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((s) => s.replace(/^<td[^>]*>|<\/td>$/g, '')).join('|');
  const t11 = [E11.host('taskHead').textContent, E11.host('taskBulkTop').style.display, E11.host('taskBulkTop').textContent];
  E11.host('taskBulkTop').onclick(); const t11b = [tk39(X11, 'b').status, E11.log.indexOf('advance:b') >= 0, E11.log.indexOf('toast:자동 지시 1건 승인(앱 기준)') >= 0, E11.host('taskBulkTop').style.display, E11.host('taskHead').textContent];
  const Y11 = mk39({ user: U39.B }); Y11.api.delSel().tasks.k = 1; Y11.api.render();
  const yt11 = [Y11.env.host('taskHead').textContent, Y11.env.host('taskBulkTop').style.display, Y11.env.host('taskDeletedToggle').style.display, Y11.env.host('taskDeletedToggle').textContent, Object.keys(Y11.api.delSel().tasks).join(',')];
  Y11.api.setShowDel(true); Y11.api.render(); const yl11 = Y11.env.host('taskDeletedList')._h;
  const yd11 = [Y11.env.host('taskDeletedToggle').textContent, (yl11.match(/data-selid="(\w+)"/g) || []).join(','), yl11.indexOf('delpurge-btn') < 0, yl11.indexOf('delrestore-btn') > 0];
  const Z11 = mk39(); Z11.api.setShowDel(true); Z11.api.render(); const zl = () => Z11.env.host('taskDeletedList');
  const zd11 = [Z11.env.host('taskDeletedToggle').textContent, (zl()._h.match(/data-selid="(\w+)"/g) || []).join(','), zl()._h.indexOf('delpurge-btn') > 0];
  const kb11 = zl().querySelector('[data-selid="k"]'); kb11.checked = true; kb11.fire('change');
  Z11.env.user = U39.B; zl().querySelector('.delpurge-btn').fire('click'); zd11.push(Z11.api.tasks().some((t) => t.id === 'k'));   // 관리자 화면에 남은 [영구삭제]를 직원B가 누름 = 무시
  Z11.env.user = U39.A; Z11.api.render(); zl().querySelector('.delpurge-btn').fire('click'); zd11.push(Z11.api.tasks().some((t) => t.id === 'k'), Z11.env.log.indexOf('confirm:선택한 1건을 영구 삭제합니다.\n복구 불가! 계속할까요?') >= 0);
  T('v439 ⑪ 제목·합계·일괄·삭제된 지시: 제목 "진행 중 10 · 기한 경과 1" · 1366 합계 "합계 10건|자동 3|계약 1|보류 1|경과 1 · 3일 내 1|대기 2|(등록일)|(처리)"(보류는 담당 칸 — 상태 칸 88px에 \'대기 n · 보류 n\'이 안 들어가 잘리던 것, 검토 반영) · 1000 합계 구분 칸 "자동 3 · 계약 1"(title)·담당 칸 "보류 1" · [오늘 승인 일괄 (1)] 보임 → 누름 = 확인 → b 완료·계약 진행 호출·알림 → 버튼 숨김·제목 "진행 중 9" · 직원B: 제목 "진행 중 9 · 기한 경과 1"·일괄 숨김(승인권자 아님) · 삭제된 지시 보기 (1)(j만 — 관리자 전용 k 빠짐)·미리 고른 k 풂·[선택 복구]만([영구삭제] 없음) · 관리자: (2) j·k·[영구삭제] → 직원B로 바뀐 뒤 누름 = 무시(k 남음) → 관리자 누름 = 확인 → k 영구 삭제',
    JSON.stringify(t11) === '["진행 중 10 · 기한 경과 1","inline-block","오늘 승인 일괄 (1)"]' && ft11 === '합계 10건|자동 3|계약 1|보류 1|경과 1 · 3일 내 1|대기 2||'
    && ft11b === '합계 10건|<span title="자동 3건 · 계약 단계 1건">자동 3 · 계약 1</span>|보류 1|경과 1 · 3일 내 1|대기 2|' && JSON.stringify(t11b) === '["done",true,true,"none","진행 중 9 · 기한 경과 1"]'
    && JSON.stringify(yt11) === '["진행 중 9 · 기한 경과 1","none","block","삭제된 지시 보기 (1)",""]' && JSON.stringify(yd11) === '["삭제된 지시 숨기기","data-selid=\\"j\\"",true,true]'
    && JSON.stringify(zd11) === '["삭제된 지시 숨기기","data-selid=\\"j\\",data-selid=\\"k\\"",true,true,false,true]',
    JSON.stringify({ t11, ft11, ft11b, t11b, yt11, yd11, zd11 }));

  // ⑫ 넓힘·CSS·전역 검색·검색칸·정적 — #view-tasks 넓힘(1024 791 · 1366 1,097 · 1920 1,428 — 스크롤바 17 포함) · 입력 카드 1280 이상 한 줄(1279·폰 그대로) · 상세 글 760
  //   · 전역 검색 지시 = taskVisible + searchId taskSearch · 검색칸 taskSearch 150ms · 자리(host)에 위임 배선 0 · 배선은 표 칸·펼침 칸 root 하나(taskSheetBindAct)
  const rules12 = [];
  const parse12 = (src, media) => { let i = 0; while (i < src.length) { const ob = src.indexOf('{', i); if (ob < 0) break; const head = src.slice(i, ob).trim(); let d = 1, j = ob + 1; for (; j < src.length && d > 0; j++) { if (src[j] === '{') d++; else if (src[j] === '}') d--; } const body = src.slice(ob + 1, j - 1); if (/^@media/.test(head)) parse12(body, head.slice(6).trim()); else if (!/^@/.test(head)) { const decl = {}; body.split(';').forEach((p) => { const k = p.indexOf(':'); if (k > 0) decl[p.slice(0, k).trim()] = p.slice(k + 1).trim(); }); rules12.push({ media, sels: head.split(',').map((s) => s.trim().replace(/\s*>\s*/g, '>').replace(/\s+/g, ' ')), decl }); } i = j; } };
  parse12(css5, null);
  const decl12 = (w, sel, prop) => { let v = null; rules12.forEach((r) => { if (mq39(r.media, w) && r.sels.indexOf(sel) >= 0 && own39(r.decl, prop)) v = r.decl[prop]; }); return v; };
  const pad12 = (v) => { const p = String(v || '0px').trim().split(/\s+/).map((x) => parseFloat(x) || 0); const r = p.length === 1 ? p[0] : p[1]; return [p.length === 4 ? p[3] : r, r]; };
  const bodyW12 = (win) => { const W = win - 17, mx = decl12(win, '#app', 'max-width'), appW = (!mx || mx === 'none') ? W : Math.min(W, parseFloat(mx)), lr = pad12(decl12(win, '#app', 'padding')); return appW - lr[0] - lr[1] - (parseFloat(decl12(win, '.tabbar', 'width')) || 0) - (parseFloat(decl12(win, '.layout', 'gap')) || 0); };
  const viewW12 = (win, id) => { const b = bodyW12(win), own = decl12(win, '#view-' + id, 'max-width'), base = decl12(win, '.views>.view', 'max-width'), mx = own != null ? own : base; return (!mx || mx === 'none') ? b : Math.min(b, parseFloat(mx)); };
  const w12 = [1024, 1366, 1920].map((w) => Math.round(viewW12(w, 'tasks')));
  const css12 = decl12(1280, '#view-tasks>.card.scope-host', 'display') === 'flex' && decl12(1279, '#view-tasks>.card.scope-host', 'display') == null && decl12(375, '#view-tasks>.card.scope-host', 'display') == null
    && decl12(1280, '#view-tasks>.card.scope-host>.add-row', 'padding') === '10px 14px 10px 0 !important' && decl12(1280, '#view-tasks>.card.scope-host #taskWho', 'width') === '120px'
    && decl12(1366, '.vs-dtxt', 'max-width') === '760px' && decl12(1366, '.vs-dtxt', 'white-space') === 'pre-wrap' && decl12(1366, '#view-tasks', 'max-width') === 'none' && decl12(859, '#view-tasks', 'max-width') == null
    // 검토 반영: 표 줄 칸 안 칩만 여백 4px(구분 '자동' 칩 + '미수 45일'·담당 '담당 없음'이 명세 폭 108·76에 들어가게) — 칩 기본(8px)·펼침 칸 칩은 그대로
    && decl12(1366, '.vs.vs-fit tr.vs-r td .review-chip', 'padding') === '1px 4px' && decl12(1366, '.vs.vs-fit tr.vs-r td .hold-chip', 'padding') === '1px 4px' && decl12(1366, '.review-chip', 'padding') === '1px 8px'
    && decl12(1366, '.vs .review-chip', 'padding') == null && decl12(1366, '.vs-kv .review-chip', 'padding') == null;
  const gs12 = /add\("tasks","지시",canSee\("tasks"\),function\(\)\{return tasks\.filter\(function\(t\)\{return t&&t\.del!==1&&t\.status!=="done"&&taskVisible\(t\);\}\);\},function\(x\)\{return x\.title\|\|"";\},function\(x\)\{return \(x\.who\|\|""\)\+\(x\.due\?" · 기한 "\+x\.due:""\);\},"taskSearch"\);/.test(html);
  const X12 = mk39(); X12.api.render(); const q12 = X12.host.querySelector('[data-vs-q]');
  const qa12 = [q12 && q12.getAttribute('id'), q12 && q12.getAttribute('placeholder')];
  q12.value = '준설'; q12.fire('input', {}); X12.env.tick(149); qa12.push(order39(X12.host._h)); X12.env.tick(1); qa12.push(order39(X12.host._h), cnt39(X12.host._h));
  const hostL12 = [X1, X2, X3, X4, X5, X6, X7, X8, X9, X11, X12, Y3, Y7, Y11, Z11].some((X) => X.env.log.some((l) => /^host-listener:/.test(l)));
  const ael12 = (tsb39.match(/addEventListener\(/g) || []).length, root12 = (tsb39.match(/root\.addEventListener\("click"/g) || []).length;
  T('v439 ⑫ 넓힘·CSS·전역 검색·검색칸·정적: #view-tasks 본문 폭 1024 ' + w12[0] + ' · 1366 ' + w12[1] + ' · 1920 ' + w12[2] + '(명세 791 · 1,097 · 1,428 ±2 — 860부터 max-width none, 859 이하 규칙 없음) · 입력 카드 1280 이상 한 줄(flex·둘째 줄 여백 !important·담당 120px)·1279·폰 그대로 · 상세 글 .vs-dtxt 760px·pre-wrap · 표 줄 칸 안 칩 여백 4px(검토 반영) · 전역 검색 지시 = taskVisible + searchId taskSearch · 검색칸 id taskSearch·placeholder "지시 검색 — 지시 내용·상세·담당·기한·계약 단계"·149ms 그대로·150ms "준설" = c "보이는 1건 / 전체 34건" · 자리(host)에 리스너 0(모든 시험 틀) · @task-sheet 구간 addEventListener = 표·펼침 칸 root 하나 + 삭제된 지시 3(전체선택·복구·영구삭제)',
    Math.abs(w12[0] - 791) <= 2 && Math.abs(w12[1] - 1097) <= 2 && Math.abs(w12[2] - 1428) <= 2 && css12 && gs12
    && JSON.stringify(qa12) === '["taskSearch","지시 검색 — 지시 내용·상세·담당·기한·계약 단계","' + ADMIN_ORDER39 + '","c","보이는 1건 / 전체 34건"]' && !hostL12 && ael12 === 4 && root12 === 1,
    JSON.stringify({ w12, css12, gs12, qa12, hostL12, ael12, root12 }));

  // ⑬ 문서 — FEATURES 기준 ≥ v439·v439 절(문장 고정)·자리 글 GATES_V439 0 · TESTLIST v439 = 화면 칸 '[ ] (AI 시험 화면 대상'(PM 몫 0) + 게이트 칸 '[x] (AI) `uismoke`'(5종·결함 심기) · TESTLIST v438 칸 4 그대로(종운환경3 몫)
  //   · MANUAL 4절·32절(PC 표·칩·처리 버튼·넓은 화면·폰 그대로) · CLAUDE.md 지시 표 줄 · sw ≥ 439 (TESTLIST v439 화면 칸·v438 칸 4는 시험 화면으로 닫으면 [x] — 두 상태 모두 받음)
  const ft13 = rd39('FEATURES.md'), tl13 = rd39('TESTLIST.md'), man13 = rd39('MANUAL.html'), cl13 = rd39('CLAUDE.md'), sw13 = rd39('sw.js');
  const sec13 = (src, head) => { const i = src.indexOf(head); if (i < 0) return ''; const j = src.indexOf(head.slice(0, head.indexOf(' ') + 1), i + head.length); return src.slice(i, j < 0 ? src.length : j); };
  const ftv13 = sec13(ft13, '\n### v439 (11/10)'), tlv13 = sec13(tl13, '\n## v439 '), tlv38_13 = sec13(tl13, '\n## v438 ');
  const FT_PINS39 = ['**자동 지시는 기본 화면(\'진행 중\' 칩)에 같이**', '**처리 열**', '[완료]/[승인]/[재개]', '**완료 칩은 자르지 않는다**', '**행 원천 = 보이는 지시**', '**폰(859px 이하)은 지금 화면 그대로**', '`phone:"legacy"`',
    '`#view-tasks`', '`renderTasksLegacy`', '**홈 `taskRowHtml`·내 업무 `myTaskRowHtml`은 그대로**', '**삭제된 지시**', '[영구삭제]는 관리자만', '`taskSearch`', '부품을 쓰는 탭 0', '지시 1개',
    // 검토 반영(11/10) 문장 — 연속 누름·합계 보류·칸 안 칩·날짜 title·검색 글·찾아가기·보는 사람 바뀜·폰 sheet 상태 칸·폰 옛 목록 선택(전체선택이 공개범위 밖까지)
    '**처리 버튼 연속 누름 막기**', '**더블클릭의 둘째 누름**', '**합계 줄 \'보류 n\'은 담당 칸**', '**표 줄 칸 안 칩은 여백 4px**', '**title도 \'YYYY-MM-DD 경과 n일\'**', '**검색칸 글 앞머리 = 전역 검색이 보는 글**',
    '`vsSheetSeek`', '**보는 사람이 바뀌면 부품 메모리를 비운다**', '**폰 sheet 준비 갈래의 상태 칸**', '옛 선택 막대의 전체선택이 공개범위 밖 지시까지 골라(moduleLive)'];
  const CL_PINS39 = ['**지시 탭 표(v439 — 45-1 둘째 판)**', '`renderTasksLegacy`', '`// @task-sheet-start ~ end`', '`#view-tasks`', '`taskSheetAct`', '정의의 phone 한 줄만', '`TASK_ACT_GAP`', '`taskSheetFromGs` → `vsSheetSeek`', '찾아가기 `vsSheetSeek(def, q)`', '`vsSheetViewer`'];
  const tcb13 = tlv13.split(/\r?\n/).filter((l) => /^\s*[-*+] \[[ xX]\]/.test(l));
  const cbScr13 = tcb13.filter((l) => /^- \[[ x]\] \(AI 시험 화면 대상[,) —]/.test(l)), cbGate13 = tcb13.filter((l) => /^- \[x\] \(AI\) `uismoke`\(/.test(l));
  const man4 = (() => { const i = man13.indexOf('<h2 id="s4">'), j = man13.indexOf('<h2 id="s5">'); return i < 0 || j < i ? '' : man13.slice(i, j); })();
  const man32 = (() => { const i = man13.indexOf('<h2 id="s32">'), j = man13.indexOf('<h2 id="s33">'); return i < 0 || j < i ? '' : man13.slice(i, j); })();
  const MAN_PINS39 = ['PC(넓은 화면)에서는 자동 지시도 표의 <b>진행 중</b>에 같이 보이고', '휴대폰 목록에서는'];
  const MAN32_PINS39 = ['<b>PC(넓은 화면) — 표</b>', '<span class="btn">진행 중</span>', '행 끝 <b>처리</b> 칸', '<span class="btn">완료</span> · <span class="btn">승인</span> · <span class="btn">재개</span>', '<b>휴대폰 — 목록</b>', '영구삭제는 관리자만', '(2026-11 v439)',
    '빠르게 두 번 누른 두 번째(0.5초 안)는 무시됩니다', '검색칸(지시 내용·상세·담당·기한·계약 단계)', '그때만 처음 상태로 돌아가 찾은 지시가 보입니다', '로그인한 사람이 바뀌면 지워집니다'];   // 뒤 넷은 검토 반영
  T('v439 ⑬ 문서: FEATURES 기준 ≥ v439·v439 절(자동 지시 같이·처리 열·완료 칩·행 원천·폰 legacy·넓힘·옛 본문·홈·내 업무 그대로·삭제된 지시·전역 검색·v438 ⑫ 고침 + 검토 반영 10문장(연속 누름·더블클릭·합계 보류·칸 안 칩·날짜 title·검색 글·vsSheetSeek·보는 사람 바뀜·폰 sheet 상태 칸·폰 옛 전체선택) — 문장 고정)·자리 글 GATES_V439 0 · TESTLIST v439 = 화면 칸 "[ ] (AI 시험 화면 대상"(≥4 — 1366·1920 표·처리 버튼·폰 375 옛 목록·보기 권한·검토 반영 칸 글 잘림·더블클릭·계정 전환) + 게이트 칸 1개 "[x] (AI) `uismoke`"(consheet_check·proctpl_check·settletest·servertest·결함 심기) · PM 0 · TESTLIST v438 칸 4(공통 부품 실물 — 이 판 시험 화면에서 닫는 칸) 그대로 있음 · MANUAL 4절(PC 표에 자동 지시 같이·휴대폰은 접이식)·32절(PC 표·칩·처리 칸·폰 목록·영구삭제 관리자 + 검토 반영: 두 번째 누름 무시·검색 기한·전역 검색 때 칩 풀림·사람 바뀌면 검색어 지움) · CLAUDE.md 지시 표 줄(+ TASK_ACT_GAP·taskSheetFromGs → vsSheetSeek)·부품 줄(찾아가기·vsSheetViewer) · sw ≥ 439',
    Number((ft13.match(/기준: v(\d+) /) || [0, 0])[1]) >= 439 && ftv13.length > 0 && FT_PINS39.every((s) => ftv13.indexOf(s) > 0) && ftv13.indexOf('GATES_V439') < 0
    && tlv13.length > 0 && cbScr13.length >= 4 && cbGate13.length === 1 && tcb13.length === cbScr13.length + 1 && tcb13.every((l) => l.indexOf('PM') < 0) && tlv13.indexOf('GATES_V439') < 0
    && ['`consheet_check`', '`proctpl_check`', '`settletest`', '`servertest`', '결함 심기'].every((g) => cbGate13[0].indexOf(g) > 0)
    && cbScr13.some((l) => l.indexOf('1366') > 0 && l.indexOf('1920') > 0) && cbScr13.some((l) => l.indexOf('375') > 0) && cbScr13.some((l) => l.indexOf('보기 권한') > 0)
    && cbScr13.some((l) => l.indexOf('검토 반영') > 0 && l.indexOf('더블클릭') > 0 && l.indexOf('말줄임') > 0 && l.indexOf('전환') > 0)   // 검토 반영 화면 칸(칸 글 잘림·연속 누름·전역 검색·계정 전환)
    && (tlv38_13.split(/\r?\n/).filter((l) => /^- \[[ x]\] \(AI 시험 화면 대상 — 시험 화면에 가짜 정의 표를 띄워/.test(l))).length === 1
    && MAN_PINS39.every((s) => man4.indexOf(s) > 0) && MAN32_PINS39.every((s) => man32.indexOf(s) > 0) && man4.indexOf('받은 지시는 이렇게 끝납니다') > 0
    && CL_PINS39.every((s) => cl13.indexOf(s) > 0) && Number((sw13.match(/jw-shell-v(\d+)/) || [0, 0])[1]) >= 439,
    JSON.stringify({ ft: FT_PINS39.filter((s) => ftv13.indexOf(s) < 0).map((s) => s.slice(0, 30)), cl: CL_PINS39.filter((s) => cl13.indexOf(s) < 0), man4: MAN_PINS39.filter((s) => man4.indexOf(s) < 0), man32: MAN32_PINS39.filter((s) => man32.indexOf(s) < 0), cb: tcb13.length, scr: cbScr13.length, gate: cbGate13.length, pm: tcb13.filter((l) => l.indexOf('PM') >= 0).map((l) => l.slice(0, 40)), sw: (sw13.match(/jw-shell-v(\d+)/) || [0, 0])[1] }));
  // ⑭ 연속 누름 막기(v439 검토 med) — 누름 하나가 표를 그 자리에서 다시 그려(행 높이 고정) 같은 줄에 다음 버튼이 놓인다(h 승인 → 2번째 줄 b [승인] · a 완료 → 1번째 줄 a [승인] · d 재개 → 맨 끝 줄 c [완료])
  //   · 처리 뒤 0.5초 안 누름은 버림(가짜 시계 — 0ms·499ms 버림, 500ms 통과) · 더블클릭 둘째 누름(detail 2)은 1초 뒤라도 버림 · 따로 누른 것은 그대로 · 펼침 버튼도 같은 배선 · 시계가 뒤로 가면 막지 않음 · 버린 누름은 계약 진행·알림 0
  const X14 = mk39(), L14 = X14.env.log, s14 = []; X14.api.render();
  const at14 = (i) => acts39(X14.host._h).split(',')[i], nA14 = (id) => L14.filter((l) => l === 'advance:' + id).length;
  //   버튼·행이 없으면 멈추지 않고 표시만(결함이 이 검사를 '검사 생략'으로 끝내 뒤 검사까지 건너뛰지 않게 — ⑭~⑯ 공통)
  const p14 = (act, id, o) => { try { press39(X14, act, id, o); } catch (e) { s14.push('!' + act + ':' + id); } }, pd14 = (act, id, o) => { try { pressDet39(X14, act, id, o); } catch (e) { s14.push('!펼침 ' + act + ':' + id); } };
  p14('approve', 'h'); s14.push(tk39(X14, 'h').status, at14(1));
  p14('approve', 'b', { fast: true }); s14.push(tk39(X14, 'b').status);
  X14.env.now += 499; p14('approve', 'b', { fast: true }); s14.push(tk39(X14, 'b').status, nA14('b'));
  X14.env.now += 1; p14('approve', 'b', { fast: true }); s14.push(tk39(X14, 'b').status, nA14('b'));
  p14('done', 'a'); s14.push(tk39(X14, 'a').status, at14(0));
  p14('approve', 'a', { detail: 2 }); s14.push(tk39(X14, 'a').status, nA14('a'), L14.filter((l) => /^push:m2:승인됨: 가/.test(l)).length);
  p14('approve', 'a'); s14.push(tk39(X14, 'a').status, nA14('a'));
  const i14 = acts39(X14.host._h).split(',').findIndex((x) => /^d:/.test(x));
  p14('resume', 'd'); const n14 = at14(i14) || '-:-'; s14.push(tk39(X14, 'd').status, n14);
  p14(n14.split(':')[1], n14.split(':')[0], { fast: true }); s14.push(tk39(X14, n14.split(':')[0]).status);
  try { openRow39(X14, 'g'); } catch (e) { s14.push('!행 g'); }
  pd14('done', 'g'); s14.push(tk39(X14, 'g').status, detActs39(X14.host._h));
  pd14('approve', 'g', { fast: true }); s14.push(tk39(X14, 'g').status);
  X14.env.now -= 60000; pd14('approve', 'g', { fast: true }); s14.push(tk39(X14, 'g').status);
  T('v439 ⑭ 연속 누름 막기(검토 반영 — 누름 하나가 표를 다시 그려 같은 자리에 다음 버튼): h [승인] 뒤 2번째 줄 = b [승인] → 바로(0ms)·499ms 누름 버림(b 승인 대기·계약 진행 0) → 500ms 누름 통과 · a [완료] 뒤 1번째 줄 = a [승인] → 1초 뒤라도 더블클릭 둘째 누름(detail 2) 버림(진행·승인 알림 0) → 따로 누른 [승인]은 통과 · d [재개] 뒤 같은 줄 = c [완료] → 바로 누름 버림 · 펼침 [완료] 뒤 바로 누른 펼침 [승인] 버림 · 시계가 뒤로 가면 막지 않음 · 자리(host)에 리스너 0',
    JSON.stringify(s14) === '["done","b:approve","review","review",0,"done",1,"review","a:approve","review",0,0,"done",1,"open","c:done","open","review","approve,reject,cancel,del","review","done"]' && !L14.some((l) => /^host-listener:/.test(l)),
    JSON.stringify(s14));

  // ⑮ 전역 검색 → 표(v439 검토): 검색칸 글 앞머리 = 전역 검색(gsSources 지시 항목 · gsRun의 hay)이 보는 글 — 전역 검색 적중은 표에도 걸림(담당 원래 이름 '나종운'(표시는 대표님)·'11-12'·'기한'·'직원B · 기한')
  //   · 이어받기(taskSheetFromGs → 부품 vsSheetSeek) = 기억된 '완료' 칩·구분 거르기를 이번만 풀고(기기 기억은 이 부름에서 그대로) 펼침 닫고 검색어 · 폰 legacy = false·검색어 안 넣음 · gsRun은 taskSearch면 이어받기(폰이면 옛 길)
  const FX15 = FIX39().concat([{ id: 'q', title: '거 대표 보고', detail: '', who_id: 'm0', who: '나종운', scope: [], from: '관리자A', from_id: 'm1', by: '관리자A', due: '2026-11-12', status: 'open', done_at: null, done_by: null, created: '2026-11-09', updated: '2026-11-09' }]);
  const X15 = mk39({ fixture: FX15 }); X15.api.render(); const d15 = X15.api.def();
  const gsHay15 = (t) => (String(t.title || '') + ' ' + ((t.who || '') + (t.due ? ' · 기한 ' + t.due : '')) + ' ' + (t.detail || '') + ' ' + (t.site || '')).toLowerCase();   // gsRun hay(제목 + sub + 상세 + 현장) — gsSources 지시 줄은 ⑫ gs12가 글자째 고정
  const gsHits15 = (q) => X15.api.tasks().filter((t) => t.del !== 1 && t.status !== 'done' && gsHay15(t).indexOf(q.toLowerCase()) >= 0).map((t) => t.id).sort().join(',');
  const r15 = ['나종운', '11-12', '기한', '직원B · 기한', '2026-11-05', '안전점검'].map((q) => { const ok = X15.api.fromGs(q); return q + '=' + ok + ':' + gsHits15(q) + '/' + order39(X15.host._h).split(',').filter(Boolean).sort().join(','); });
  const o15 = (id, out) => { try { openRow39(X15, id); } catch (e) { out.push('!행 ' + id); } };   // 행이 없으면 멈추지 않고 표시만(⑭와 같은 까닭)
  X15.api.setQ(d15, ''); chip39(X15, 'done'); X15.api.filter(d15, 'kind', '자동 · 증명서'); const pre15 = []; o15('f', pre15);
  const mem15 = X15.env.store.jw_task_sheet; pre15.push(order39(X15.host._h), /data-vs-det="f"/.test(X15.host._h));
  const s15 = [X15.api.fromGs('안전점검'), order39(X15.host._h), /class="vs-chip on" data-vs-chip="st\|"/.test(X15.host._h), ((/<select data-vf="kind">[\s\S]*?<\/select>/.exec(X15.host._h) || [''])[0]).indexOf(' selected') < 0,
    X15.host.querySelector('[data-vs-q]').value, X15.host._h.indexOf('data-vs-det=') < 0, X15.env.store.jw_task_sheet === mem15];
  const s15b = []; o15('a', s15b); s15b.push(/data-vs-det="a"/.test(X15.host._h)); X15.api.fromGs('정리'); s15b.push(order39(X15.host._h), X15.host._h.indexOf('data-vs-det=') < 0);   // 펼친 행이 결과에 남아도 닫음
  const Y15 = mk39({ width: 375, fixture: FX15 }); Y15.api.render();
  const y15 = [Y15.api.fromGs('안전점검'), Y15.api.inst(Y15.api.def()).q, Y15.host._h.indexOf('data-vs-') < 0, (Y15.host._h.match(/class="item task-item/g) || []).length > 0];
  const gsRun15 = /if\(sid==="taskSearch" && taskSheetFromGs\(gq\)\) return;/.test(fn39(html, 'gsRun')) && /function taskSheetFromGs\(q\)\{ return vsSheetSeek\(taskSheetDef\(\), q\); \}/.test(tsb39)
    && /if \(vsStage\(\) <= 1 && def\.phone !== "sheet"\) return false;/.test(fn39(blk39, 'vsSheetSeek')) && fn39(blk39, 'vsSheetSeek').indexOf('vsSheetSave(') < 0;
  T('v439 ⑮ 전역 검색 → 표(검토 반영): 검색칸 글 앞머리 = 전역 검색이 보는 글 — 전역 검색 적중 = 표에 걸리는 지시(나종운 = q(표시 대표님) · 11-12 = b·g·q · 기한 = 기한 있는 진행 10건 · "직원B · 기한" = a·b·p · 2026-11-05 = a · 안전점검 = a) · 이어받기 = 완료 칩·구분 거르기 "자동 · 증명서"·펼친 f를 풀고 진행 중 칩·검색칸 "안전점검" → a(기기 기억은 그대로) · 펼친 a가 결과("정리" = a)에 남아도 닫음 · 폰 375 legacy = false·검색어 안 넣음·옛 카드 · gsRun은 taskSearch면 taskSheetFromGs(→ vsSheetSeek — 폰 legacy면 false·저장 안 함)',
    JSON.stringify(r15) === JSON.stringify(['나종운=true:q/q', '11-12=true:b,g,q/b,g,q', '기한=true:a,b,d,g,h,i,l,n,p,q/a,b,d,g,h,i,l,n,p,q', '직원B · 기한=true:a,b,p/a,b,p', '2026-11-05=true:a/a', '안전점검=true:a/a'])
    && JSON.stringify(pre15) === '["f",true]' && JSON.stringify(s15) === '[true,"a",true,true,"안전점검",true,true]' && JSON.stringify(s15b) === '[true,"a",true]' && JSON.stringify(y15) === '[false,"",true,true]' && gsRun15 && !X15.env.log.some((l) => /^host-listener:/.test(l)),
    JSON.stringify({ r15, pre15, s15, s15b, y15, gsRun15 }));

  // ⑯ 보는 사람이 바뀌면 부품 메모리를 비움(v439 검토 — 로그인 창 '전환'은 새로고침 없이 afterLogin → render): 검색어·검색칸 글·펼친 행·선택·치던 글 타이머 · 정렬·칩·거르기(기기 기억)는 그대로 · 같은 사람이 다시 그리면 그대로
  const X16 = mk39(); X16.api.render(); const d16 = X16.api.def();
  chip39(X16, 'review'); X16.api.setQ(d16, '섭외'); const s16a = [];
  try { openRow39(X16, 'h'); const cb16 = X16.host.querySelector('[data-vs-sel="h"]'); cb16.checked = true; cb16.fire('change'); } catch (e) { s16a.push('!행 h'); }   // 멈추지 않고 표시만(⑭와 같은 까닭)
  X16.api.render();
  s16a.push(X16.api.inst(d16).q, X16.host.querySelector('[data-vs-q]').value, /data-vs-det="h"/.test(X16.host._h), Object.keys(X16.api.sel().tasks).join(','));
  const q16 = X16.host.querySelector('[data-vs-q]'); q16.value = '소방'; q16.fire('input', {});   // 치던 글(150ms 기다리는 중)에 사람이 바뀜
  const mem16 = X16.env.store.jw_task_sheet;
  X16.env.user = U39.B; X16.api.render(); X16.env.tick(200);
  const s16b = [X16.api.inst(d16).q, X16.host.querySelector('[data-vs-q]').value, X16.host._h.indexOf('data-vs-det=') < 0, Object.keys(X16.api.sel().tasks).length, order39(X16.host._h), /class="vs-chip on" data-vs-chip="st\|review"/.test(X16.host._h), X16.env.store.jw_task_sheet === mem16];
  T('v439 ⑯ 보는 사람이 바뀌면(로그인 창 \'전환\' — 새로고침 없음) 부품 메모리를 비움(검토 반영): 관리자A가 승인 대기 칩·검색어 "섭외"·h 펼침·h 선택 → 같은 사람이 다시 그리면 그대로 → 직원B로 바뀌어 그리면 검색어·검색칸 글·펼침·선택 비움·치던 글 "소방"(150ms 기다리던 것) 안 들어감 · 승인 대기 칩(기기 기억)은 그대로 = h,b · 기기 저장 안 바뀜',
    JSON.stringify(s16a) === '["섭외","섭외",true,"h"]' && JSON.stringify(s16b) === '["","",true,0,"h,b",true,true]',
    JSON.stringify({ s16a, s16b }));
} catch (e) { console.log('  (v439 검사 생략 — ' + e.message + ')'); fails++; }

try {
  const fdir = join(ROOT, 'netlify', 'functions');
  const miss = readdirSync(fdir).filter((f) => /^gw-.*\.js$/.test(f)).filter((f) => { const t = readFileSync(join(fdir, f), 'utf8'); return /\b(store|blobGet|blobSet|blobList|blobDelete)\(/.test(t) && !/setupBlobContext\(/.test(t); });
  T('Blob 컨텍스트 전수: Blob을 쓰는 gw-*.js 전부 setupBlobContext 호출(누락 0)', miss.length === 0, '누락: ' + miss.join(', '));
} catch (e) { console.log('  (Blob 컨텍스트 검사 생략 — ' + e.message + ')'); fails++; }

console.log(fails ? '\nUI 스모크 실패 ' + fails + '건' : '\nUI 스모크 전 항목 통과');
process.exit(fails ? 1 : 0);
