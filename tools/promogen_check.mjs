// 블로그 품질 고리 2단계(생성 개선) 게이트 — 체크 10 · PM 11/10 18:26 '2단계 ㄱ'(기존 글은 그대로). 근거 work/09_조사_문서/10_블로그완성도_자료_20261110/03_학습설계안 §5 A~E.
//   E(C061) 실패 경로: 잔액 부족 판정·시도 횟수 미소진·한 시간에 한 건 재시도 · 옛 기록(이미 게시된 BAD_REQUEST)은 다시 해석 안 함 · 앱: 사진AI 초안 없는 예비 글 승인·완성본 막기
//   (B·C·D·A는 아래 절 — 프롬프트 개정·계절 규칙·사진 판독표·현장 사실 자동 채움)
// 실행: node tools/promogen_check.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'netlify', 'functions');
process.env.GW_SESSION_SECRET = 'promogen-check-secret';
const mem = {};
const blobsMock = {
  setupBlobContext() {}, store(n) { mem[n] = mem[n] || {}; return n; },
  async blobGet(st, k) { const s = mem[st] || {}; return (k in s) ? { ok: true, data: JSON.parse(JSON.stringify(s[k])) } : { ok: false, code: 'NOT_FOUND' }; },
  async blobSet(st, k, v) { mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobList(st, pre) { return { ok: true, keys: Object.keys(mem[st] || {}).filter((k) => !pre || k.indexOf(pre) === 0) }; },
};
{ const rp = require.resolve(join(FN, '_lib/blobs.js')); require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: blobsMock }; }
const PJ = require(join(FN, '_lib/promoai_job.js'));
const idx = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
let fails = 0, pass = 0;
const T = (name, ok, detail) => { if (ok) pass++; else fails++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + String(detail).slice(0, 400))); };
const MIN = 60000, NOW = Date.UTC(2026, 10, 10, 10, 0, 0);
const CREDIT_MSG = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

// ---- E(C061) 서버: 잔액 부족 판정·횟수·재시도 ----
{
  T('E 판정: BAD_REQUEST + 잔액 문구 → CREDIT_LOW · 다른 400 문구·다른 코드는 그대로', PJ.failCode('BAD_REQUEST', CREDIT_MSG) === 'CREDIT_LOW' && PJ.failCode('BAD_REQUEST', 'messages: too many images') === 'BAD_REQUEST' && PJ.failCode('NETWORK', CREDIT_MSG) === 'NETWORK');
  const r = { id: 'e1' };
  PJ.setAiState(r, 'running', { job: 'pa_1' }, NOW); PJ.setAiState(r, 'fail', { code: 'BAD_REQUEST', detail: CREDIT_MSG, job: 'pa_1' }, NOW + 1);
  PJ.setAiState(r, 'running', { job: 'pa_2' }, NOW + 2); PJ.setAiState(r, 'fail', { code: 'BAD_REQUEST', detail: CREDIT_MSG, job: 'pa_2' }, NOW + 3);
  T('E 잔액 부족 두 번 → code CREDIT_LOW · 시도 횟수 0(running 때 올린 1을 되돌림)', r.ai_st.code === 'CREDIT_LOW' && r.ai_st.tries === 0, JSON.stringify(r.ai_st));
  PJ.setAiState(r, 'running', { job: 'pa_3' }, NOW + 4); PJ.setAiState(r, 'fail', { code: 'NETWORK', detail: 'fetch failed', job: 'pa_3' }, NOW + 5);
  T('E 다른 실패는 종전대로 횟수 1', r.ai_st.code === 'NETWORK' && r.ai_st.tries === 1, JSON.stringify(r.ai_st));
  const P = (id, ts, st) => ({ id, ts, status: 'review', photos: [{ id: 'att_0123456789abcdef' }], ai_st: st });
  const old = { st: 'fail', code: 'CREDIT_LOW', tries: 0 };
  let c = PJ.pickCandidates([P('a', 200, Object.assign({}, old, { ts: NOW - 70 * MIN })), P('b', 100, Object.assign({}, old, { ts: NOW - 80 * MIN })), P('n', 300, { st: 'fail', code: 'NETWORK', tries: 1, ts: NOW - 15 * MIN })], NOW, {});
  T('E 잔액 부족 두 건(마지막 실패 70분 전) → 가장 오래된 기록 한 건만(credit_retry) · 다른 실패(NETWORK 1회·15분 전)는 종전대로', c.length === 2 && c.filter((x) => x.why === 'credit_retry').length === 1 && c.some((x) => x.rec.id === 'b' && x.why === 'credit_retry') && c.some((x) => x.rec.id === 'n' && x.why === 'retry_1'), JSON.stringify(c.map((x) => [x.rec.id, x.why])));
  c = PJ.pickCandidates([P('a', 200, Object.assign({}, old, { ts: NOW - 30 * MIN })), P('b', 100, Object.assign({}, old, { ts: NOW - 80 * MIN }))], NOW, {});
  T('E 마지막 잔액 부족이 30분 전이면 아무것도 안 함(한 시간 간격)', c.length === 0, JSON.stringify(c.map((x) => [x.rec.id, x.why])));
  c = PJ.pickCandidates([P('a', 200, Object.assign({}, old, { ts: NOW - 90 * MIN })), P('r', 300, { st: 'running', ts: NOW - 5 * MIN, tries: 1 })], NOW, {});
  T('E 도는 생성이 있으면(5분 전 running) 잔액 부족 재시도는 기다림', c.length === 0, JSON.stringify(c.map((x) => [x.rec.id, x.why])));
  const posted = { id: 'p', ts: 50, status: 'posted', tags: ['포항'], photos: [{ id: 'att_0123456789abcdef' }], ai_st: { st: 'fail', code: 'BAD_REQUEST', detail: CREDIT_MSG, tries: 4, ts: NOW - 10 * 24 * 60 * MIN } };
  const postedNoTag = Object.assign({}, posted, { id: 'q', tags: [] });
  c = PJ.pickCandidates([posted, postedNoTag], NOW, {});
  T('E 옛 기록(이미 게시·code BAD_REQUEST·4회)은 다시 해석하지 않음 — 후보 0(기존 글 그대로)', c.length === 0, JSON.stringify(c.map((x) => [x.rec.id, x.why])));
}

// ---- E(C061) 앱: 예비 글 승인·완성본 막기(정적 + 함수 실행) ----
{
  const grab = (re) => (idx.match(re) || [''])[0];
  const src = grab(/function paFailShort\(code\)\{[^\n]*\n/) + grab(/function promoNoAiDraft\(p\)\{[^\n]*\n/) + grab(/function promoNoAiText\(p\)\{[\s\S]*?\n  \}\n/);
  const F = new Function(src + '\nreturn { paFailShort: paFailShort, promoNoAiDraft: promoNoAiDraft, promoNoAiText: promoNoAiText };')();
  const rec = { photos: [{ id: 'x' }], ai_st: { st: 'fail', code: 'CREDIT_LOW' } };
  T('E 앱 판정: 사진 있고 ai 없음 = 예비 글(막음) · ai 있음·사진 없음은 아님 · 문구에 잔액 부족·승인·게시 안 함', F.promoNoAiDraft(rec) && !F.promoNoAiDraft({ photos: [{ id: 'x' }], ai: { ts: 1 } }) && !F.promoNoAiDraft({ photos: [] }) && /API 잔액 부족/.test(F.promoNoAiText(rec)) && /승인·게시하지 않습니다/.test(F.promoNoAiText(rec)) && F.paFailShort('CREDIT_LOW') === 'API 잔액 부족', F.promoNoAiText(rec));
  T('E 앱 배선: 승인 버튼 표시 조건에 !promoNoAiDraft · 승인 누름 첫 줄 가드(alert) · 완성본 만들기 가드(게시 완료는 열림) · 검수 창 상태 줄 · 카드 잔액 부족 문구 · 탭 경고 줄',
    /promoApproveBtn"\)\.style\.display=\(isAdmin\(\)&&st==="review"&&!promoNoAiDraft\(p\)\)/.test(idx)
    && /if\(!p\|\|!isAdmin\(\)\) return;\n    if\(promoNoAiDraft\(p\)\)\{ alert\(promoNoAiText\(p\)\); return; \}/.test(idx)
    && /if\(promoNoAiDraft\(p\) && p\.status!=="posted"\)\{ alert\(promoNoAiText\(p\)\); return; \}/.test(idx)
    && /if\(promoNoAiDraft\(p\) && st!=="posted"\) paStat\(promoNoAiText\(p\), true\);/.test(idx)
    && /s\.st==="fail" && s\.code==="CREDIT_LOW"\) return ' · <span/.test(idx)
    && /var credN=livePromo\(\)\.filter/.test(idx));
}

// ---- B 프롬프트 개정 · C 게시 시점 계절 · D 사진 판독표 · A 현장 사실 자동 채움 · B⑤ 최근 소제목 ----
const L = require(join(FN, '_lib/promoai.js'));
{
  const sp = L.SYSTEM_PROMPT;
  const forb = L.contractForbidden({ contract_info: { amount: 20000000, guarantee: 2600000 }, client: '포항시 맑은물사업소', bid_id: 'R26BK01752009', id: 'cmabcdef', lic_id: 'lseed13' });
  T('B 프롬프트 판 p2 · 시스템 프롬프트에 네 자리 이상 숫자 0 · 계약 금지 문자열 검사 통과(금액·발주처·입찰번호)', /^p2-/.test(L.PROMPT_VER) && !(sp.match(/[0-9]{4,}/g) || []).length && L.scrubPayload({ system: sp }, forb).ok === true);
  T('B 개정 문구: 현장 근거·장비 정확한 이름·셀 수 있는 대수·판독표 근거·무엇을·무엇으로·어떻게·왜·문장 길이 섞기(육십 자·절 넷 금지)·현장 사례형 틀 5·회사 절차 블록(등록·허가 이름·번호는 안 씀)·최근 소제목 회피·출력 다섯 값', [
    '독자가 가장 믿는 근거는 이 현장에서 실제로 한 일입니다', '정확한 이름으로 부릅니다', '셀 수 있는 대수·인원·지점 수는 세어서 한글 수사로', '판독표에 없는 장비·대수·인원은 본문에 쓰지 않고',
    '무엇을·무엇으로·어떻게 했는지와 그 이유를 이어서 씁니다', '문장 길이를 섞습니다', '육십 자 안팎', '한 문장에 절을 넷 이상 넣지 않습니다', '5) 현장 사례형', '다섯 가지 틀 중 하나를 고릅니다',
    '마지막 두 문단의 회사 이야기에는', '등록·허가의 이름과 번호, 실적 건수는 입력으로 주어지지 않으므로 쓰지 않습니다', '[최근 글 소제목]이 오면', '## 사진 판독표(scenes)', '다섯 값만 출력합니다', '계절 언급: 하지 않음',
  ].every((s) => sp.indexOf(s) >= 0) && sp.indexOf('문장은 짧게 끊습니다. 한 문장에 절을 셋 이상 넣지 않고') < 0 && sp.indexOf('네 가지 틀 중 하나를 고릅니다') < 0, '');
  // C 계절
  const far = L.seasonPlan('2026-04-07 15:29', '2026-11-10'), near = L.seasonPlan('2026-10-20', '2026-11-10'), yr = L.seasonPlan('2026-12-20', '2027-01-10'), none = L.seasonPlan('', '2026-11-10');
  T('C 계절 판정: 4월 촬영·11월 게시 = 일곱 달(언급 안 함) · 10월→11월 = 가능 · 12월→다음 해 1월 = 한 달(가능) · 촬영일 없음 = 안 함', !far.ok && far.why === 'far' && far.gap === 7 && near.ok && near.gap === 1 && yr.ok && yr.gap === 1 && !none.ok && none.why === 'none', JSON.stringify([far, near, yr, none].map((x) => [x.ok, x.why, x.gap])));
  const base = { region: '포항 두호동', facility: '상가 하수구', problem: '역류', photoCount: 6 };
  const pf = L.buildPrompt(Object.assign({}, base, { shot_at: '2026-04-07 15:29', post_date: '2026-11-10' }));
  const pn = L.buildPrompt(Object.assign({}, base, { shot_at: '2026-10-20 10:00', post_date: '2026-11-10' }));
  let sFar = 0, sNear = 0;
  for (let k = 0; k < 40; k++) {
    const a = L.buildPrompt(Object.assign({}, base, { shot_at: '2026-04-07 15:29', post_date: '2026-11-10', seed: 'x' + k })).title_plan;
    const b = L.buildPrompt(Object.assign({}, base, { shot_at: '2026-10-20 10:00', post_date: '2026-11-10', seed: 'x' + k })).title_plan;
    if ((a.primary && a.primary.code === 'S') || (a.backup && a.backup.code === 'S')) sFar++;
    if ((b.primary && b.primary.code === 'S') || (b.backup && b.backup.code === 'S')) sNear++;
  }
  T('C 요청: 두 달 넘게 떨어지면 "계절 언급: 하지 않음"·제목 원형 S 0회(40씨앗)·제목 경고 재료 shot_at 빈칸·season far / 가까우면 "계절 언급: 가능"·S가 고를 수 있는 원형으로 남음',
    pf.user.indexOf('계절 언급: 하지 않음') > 0 && pf.user.indexOf('촬영과 일곱 달 차이') > 0 && sFar === 0 && pf.title_ctx.shot_at === '' && pf.title_ctx.season === 'far'
    && pn.user.indexOf('계절 언급: 가능') > 0 && sNear > 0 && pn.title_ctx.season === 'ok', JSON.stringify({ sFar: sFar, sNear: sNear, ctx: pf.title_ctx.season }));
  const wFar = L.draftWarnings({ title: '겨울철에 더 심해지는 상가 하수구 막힘의 이유', body: '[사진 1 : 입구]\n벚꽃이 핀 도로변의 우수받이입니다.', tags: ['봄철도로정비'], title_type: 'O', scenes: [] }, 1, pf.title_ctx);
  const wNear = L.draftWarnings({ title: '가을 낙엽이 쌓인 우수받이를 비운 기록입니다', body: '[사진 1 : 입구]\n낙엽이 쌓였습니다.', tags: [], title_type: 'O', scenes: [] }, 1, pn.title_ctx);
  T('C 경고: 언급 안 함인데 제목 "겨울철"·본문 "벚꽃"·태그 "봄철…" → 경고 2(사람 판단용) · 언급 가능이면 계절 경고 없음', wFar.some((x) => /제목에 계절·시기 표현이 있습니다\(촬영과 게시 시점이 두 달 넘게 떨어짐\)/.test(x)) && wFar.some((x) => /본문·태그에 계절·시기 말\(.*벚꽃/.test(x)) && !wNear.some((x) => /계절/.test(x)), JSON.stringify([wFar, wNear]));
  // D 판독표
  const req = L.buildRequest([{ media_type: 'image/jpeg', data: 'A'.repeat(200) }, { media_type: 'image/jpeg', data: 'B'.repeat(200) }], Object.assign({}, base, { photoCount: 2 }));
  const sch = req.output_config.format.schema;
  T('D 출력 스키마: scenes가 맨 앞·필수 · 항목 n·scene·equip·act·state·count·conf 필수 · conf = 높음/보통/낮음 · 추가 칸 금지', Object.keys(sch.properties)[0] === 'scenes' && sch.required.join() === 'scenes,title,body,tags,title_type' && sch.properties.scenes.items.required.join() === 'n,scene,equip,act,state,count,conf' && sch.properties.scenes.items.properties.conf.enum.join() === '높음,보통,낮음' && sch.properties.scenes.items.additionalProperties === false, JSON.stringify(Object.keys(sch.properties)));
  const pd = L.parseDraft(JSON.stringify({ scenes: [{ n: 1, scene: '맨홀 뚜껑 둘레 퇴적물', equip: '', act: '', state: '흰 가루가 번짐', count: '', conf: '높음' }, { n: '2', scene: '흡입호스 투입', equip: '준설차 흡입호스', act: '작업자가 호스를 밀어 넣음', state: '', count: '작업자 두 명', conf: '애매함' }, 'junk'], title: '제목', body: '본문', tags: ['포항'], title_type: 'O' }));
  const pdOld = L.parseDraft(JSON.stringify({ title: '제목', body: '본문', tags: [], title_type: 'Q' }));
  T('D 응답 읽기: 판독표 두 항목(번호 정수화·확신 값 밖이면 빈칸·문자열 찌꺼기 버림) · 옛 응답 모양(판독표 없음)도 그대로 받음(빈 배열)', pd && pd.scenes.length === 2 && pd.scenes[1].n === 2 && pd.scenes[1].conf === '' && pd.scenes[0].conf === '높음' && pd.scenes[1].count === '작업자 두 명' && pdOld && pdOld.scenes.length === 0 && pdOld.title === '제목', JSON.stringify(pd && pd.scenes));
  const wSc = L.draftWarnings({ title: '포항 두호동 상가 하수구에서 확인한 침전물', body: '[사진 1 : 입구]\n본문입니다.\n[사진 2 : 작업]\n본문입니다.', tags: [], title_type: 'O', scenes: [{ n: 1 }] }, 2, pn.title_ctx);
  T('D 경고: 판독표가 사진 수보다 적으면 "사진 판독표 1장 — 사진 2장 중…"', wSc.some((x) => /사진 판독표 1장 — 사진 2장 중/.test(x)), JSON.stringify(wSc));
  // A 자동 현장 사실
  const af = L.autoFacts([{ name: '1.해안로243-2 작업전.jpg', shot: '2026-04-07 15:29' }, { name: '2 작업중.jpg', shot: '2026-04-07 15:51' }, { name: '3.jpg', shot: '2026-04-07 16:40' }, { name: '4 준설후.jpg', shot: '2026-04-07 17:05' }]);
  const af2 = L.autoFacts([{ name: 'a.jpg', shot: '2026-04-07 09:00' }, { name: 'b.jpg', shot: '2026-04-08 10:00' }]);
  T('A 자동 현장 사실: 같은 날 15:29~17:05 → "오후 세 시대부터 다섯 시대까지(첫 장과 마지막 장 사이 약 두 시간)" · 단계 낱말 작업 전=1·작업 중=2·작업 후=4 · 파일 이름 글자(주소·번지)는 안 나감 · 여러 날 = "이틀에 걸쳐 촬영" · 아무것도 없으면 null',
    af && af.span === '오후 세 시대부터 다섯 시대까지(첫 장과 마지막 장 사이 약 두 시간)' && JSON.stringify(af.stages) === JSON.stringify([{ label: '작업 전', nums: [1] }, { label: '작업 중', nums: [2] }, { label: '작업 후', nums: [4] }]) && JSON.stringify(af).indexOf('해안로') < 0 && JSON.stringify(af).indexOf('243') < 0
    && af2 && af2.span === '이틀에 걸쳐 촬영' && L.autoFacts([{ name: 'x.jpg', shot: '' }]) === null, JSON.stringify([af, af2]));
  const pa = L.buildPrompt(Object.assign({}, base, { shot_at: '2026-04-07 15:29', post_date: '2026-11-10', auto_facts: af, recent_heads: L.recentHeads(['왜 막혔을까요?\n본문입니다. 끝?\n[사진 1 : 입구]\n그대로 두면 어떻게 될까요?\n이 문장은 앱 복사 창이 소제목으로 보는 마흔다섯 자를 훌쩍 넘기도록 일부러 아주 길게 늘여 쓴 질문 문장이라서 소제목이 아닐까요?', '왜 막혔을까요?\n누가 관리하는 걸까요?']) }));
  T('A·B⑤ 요청: [현장 정보]에 자동 채운 현장 사실 두 줄 · [최근 글 소제목] 세 줄(중복·긴 줄·문장 속 물음표 뺌)이 "이번 글의 필수 조건" 앞 · 금지 문자열 검사 통과',
    pa.user.indexOf('자동으로 채운 현장 사실') > 0 && pa.user.indexOf('촬영 시각(사진 기록 기준): 오후 세 시대부터') > 0 && pa.user.indexOf('작업 전 = 사진 1 / 작업 중 = 사진 2 / 작업 후 = 사진 4') > 0
    && pa.user.indexOf('[최근 글 소제목]') > 0 && pa.user.indexOf('- 왜 막혔을까요?') > 0 && pa.user.indexOf('- 그대로 두면 어떻게 될까요?') > 0 && pa.user.indexOf('- 누가 관리하는 걸까요?') > 0 && pa.user.split('- 왜 막혔을까요?').length === 2 && pa.user.indexOf('훌쩍 넘기는') < 0
    && pa.user.indexOf('[최근 글 소제목]') < pa.user.indexOf('이번 글의 필수 조건') && L.scrubPayload({ user: pa.user }, forb).ok, pa.user.slice(pa.user.indexOf('[최근 글'), pa.user.indexOf('[최근 글') + 160));
}

// ---- 워커 통합(가짜 모델 — 네트워크 없음): 입력에 게시 시점·자동 현장 사실·최근 소제목이 실리고, 판독표·프롬프트 판이 잡·초안·기록에 남는다 ----
{
  const { issueSession } = require(join(FN, '_lib/session.js'));
  const worker = require(join(FN, 'gw-promo-ai-run-background.js'));
  const realGen = L.generateDraft;
  let captured = null;
  L.generateDraft = async function (key, photos, input) {
    captured = { input: input, n: photos.length };
    const draft = { title: '맨홀 둘레로 번진 흰 퇴적물, 포항 두호동 상가 하수구 확인', body: '[사진 1 : 입구]\n본문입니다.\n[사진 2 : 흡입]\n본문입니다.', tags: ['포항'], title_type: 'O', scenes: [{ n: 1, scene: '맨홀 뚜껑 둘레', equip: '', act: '', state: '흰 퇴적물', count: '', conf: '높음' }, { n: 2, scene: '흡입', equip: '준설차 흡입호스', act: '호스 투입', state: '', count: '작업자 한 명', conf: '보통' }] };
    return Object.assign({ ok: true }, draft, { prompt_ver: L.PROMPT_VER, used_tokens: { input: 1, output: 1, total: 2 }, model: 'mock', warn: [] });
  };
  try {
    process.env.GW_ANTHROPIC_KEY = 'dummy-offline-test-key-not-real';
    const tokSys = issueSession({ id: '__promoai__', role: 'system' }).token;
    mem.gw_files = {};
    const A1 = 'att_00000000000000a1', A2 = 'att_00000000000000a2';
    mem.gw_files[A1] = { kind: 'promo', type: 'image/jpeg', name: '1.해안로243-2 작업전.jpg', data: 'A'.repeat(200) };
    mem.gw_files[A2] = { kind: 'promo', type: 'image/jpeg', name: '2 작업후.jpg', data: 'B'.repeat(200) };
    mem.gw_data = {
      'col:promo': { schema: 1, updated_at: 1, items: [
        { id: 'wk1', title: '예비 제목', body: '예비 본문', status: 'review', ts: Date.now(), region: '포항 두호동', facility: '상가하수구', problem: '역류', shot_at: '2026-04-07 15:29', photos: [{ id: A1, name: '1.해안로243-2 작업전.jpg', shot: '2026-04-07 15:29' }, { id: A2, name: '2 작업후.jpg', shot: '2026-04-07 16:31' }] },
        { id: 'old1', title: '포항 장량동 상가 하수구, 냄새와 역류는 왜 함께 올까요', body: '도입입니다.\n\n왜 냄새와 역류가 같이 올까요?\n\n본문입니다.\n\n그대로 두면 어떻게 될까요?\n\n본문입니다.', status: 'posted', posted_at: '2026-10-14', ts: Date.now() - 86400000, ai: { ts: Date.now() - 86400000 }, region: '포항 장량동', photos: [] },
      ] },
    };
    await worker.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokSys }, body: JSON.stringify({ job: 'pa_gen_t1', promo_id: 'wk1', contract_id: '', mode: 'draft', max_photos: 30 }) }, {});
    const job = mem.gw_data['promoai:job:pa_gen_t1'], rec = mem.gw_data['col:promo'].items[0], dr = mem.gw_data['promoai:draft:wk1'];
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    T('워커: 입력에 게시 시점(오늘 KST)·자동 현장 사실(촬영 시각·단계 작업 전 1·작업 후 2 — 파일 이름 주소는 안 실림)·최근 소제목(최근 기록 질문 두 줄)',
      captured && captured.input.post_date === today && captured.input.auto_facts && /오후 세 시대부터 네 시대까지/.test(captured.input.auto_facts.span) && JSON.stringify(captured.input.auto_facts.stages) === JSON.stringify([{ label: '작업 전', nums: [1] }, { label: '작업 후', nums: [2] }])
      && JSON.stringify(captured.input).indexOf('해안로') < 0 && JSON.stringify(captured.input.recent_heads) === JSON.stringify(['왜 냄새와 역류가 같이 올까요?', '그대로 두면 어떻게 될까요?']), JSON.stringify(captured && { pd: captured.input.post_date, af: captured.input.auto_facts, rh: captured.input.recent_heads }));
    T('워커: 잡 blob에 판독표 2·프롬프트 판 · 초안 보존본에 판독표·판 · 기록 ai.pv = p2(본문 적용 — 새 기록)', job && job.status === 'done' && Array.isArray(job.scenes) && job.scenes.length === 2 && job.prompt_ver === L.PROMPT_VER && dr && dr.items[0].scenes && dr.items[0].scenes.length === 2 && dr.items[0].pv === L.PROMPT_VER && rec.ai && rec.ai.pv === L.PROMPT_VER && rec.body.indexOf('[사진 1') === 0, JSON.stringify({ st: job && job.status, code: job && job.code, sc: job && job.scenes && job.scenes.length, pv: rec.ai && rec.ai.pv }));
    T('워커 로그: [현장 사실] 자동 채움 줄', job && job.log.some((l) => /\[현장 사실\] 자동 채움 촬영 시각 · 단계 2 · 최근 소제목 2줄/.test(l)), JSON.stringify(job && job.log));
  } finally { L.generateDraft = realGen; delete process.env.GW_ANTHROPIC_KEY; }
  const cron = fs.readFileSync(join(FN, 'gw-promo-ai-cron.js'), 'utf8');
  T('크론 ①(끝났는데 안 실린 결과 적용)도 프롬프트 판·판독표를 넘김', /pv: j\.prompt_ver \}, now\)/.test(cron) && /\{ scenes: j\.scenes, pv: j\.prompt_ver \}/.test(cron));
}

console.log(fails ? '\n생성 개선 게이트 실패 ' + fails + ' / 통과 ' + pass : '\n생성 개선 게이트 전 항목 통과 (' + pass + ')');
process.exit(fails ? 1 : 0);
