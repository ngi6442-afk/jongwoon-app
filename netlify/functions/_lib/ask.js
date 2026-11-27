'use strict';

// 질문창 공용 — 도구 정의·권한 통과·클로드 호출. 본편(gw-ask·gw-ask-background)이 쓴다(임시 비용 계측기 gw-ask-meter는 T090에서 걷어 냄).
//
// 설계에서 안 바뀌는 것 셋(브리핑 2026-09-10):
//   ① 도구를 실행하는 것은 서버다. 클로드는 "무엇을 불러 달라"고 말할 뿐이고 열람 가부는 permOf가 정한다.
//   ② 읽기 전용. 쓰기·삭제·상신 없음.
//   ③ 원장을 통째로 보내지 않는다 — 질문에 걸린 행만 ROW_CAP까지.
// 도구에 아예 싣지 않는 것: 미수(PM 2026-09-10 결정), 근로자 생년월일·연락처, 급여·연차, 견적서, 첨부 본문, 자격증명.
//
// 비용(2026-09-10 실측 34문항): 1문항 평균 입력 4,930 · 출력 521 토큰 · 왕복 2.1 · 8.4초.
//   입력의 77%가 고정비(도구 설명서 8개 + 규칙이 왕복마다 재전송)라 **프롬프트 캐싱**을 건다.
const { store, blobGet } = require('./blobs');
const DS = require('./docscope');
const CLIBIZ = require('./clibiz');   // v456 거래처 사업자번호 칸 13자리 판정(원문·검색 제외)
const CL = require('./claude');       // C264 AI 실패 가르기 공통(잔액·키 → 관리자 확인 필요)

const DATA = 'gw_data';

const PERM_CLOSED = { quote: 1, promo: 1, hr: 1, lic: 1, site: 1, safety: 1, hw: 1, stmt: 1 };   // gw-data와 같은 집합(uismoke 대조 — v430 safety 추가, 물어보기 도구는 교육 기록 col:edu를 싣지 않는다 · v431 hw 화관법 추가, 물어보기 도구에 화관법 자료 없음 · 29 stmt 월말명세서 추가, 물어보기 도구에 명세서 자료 없음)
const COL = { vehicles: 'veh', licenses: 'lic', asbestos: 'site', contracts: 'con',
  clients: 'cli', documents: 'doc', bids: 'bid', tasks: 'tasks', workers: 'wk',
  receivables: 'rec' };   // C248 검토: 도구는 없음 — 지시 숨김(_lib/taskhide 기성 갈래)이 permOf(member, 'receivables')를 gw-data와 같은 키로 보게

const ROW_CAP = 25;          // 도구 한 번이 돌려주는 최대 행 — 원장을 통째로 보내지 않는다
const MAX_TURNS = 6;         // 도구 왕복 상한(무한 루프 방지)
const MAX_TOKENS = 1500;
const CALL_TIMEOUT_MS = 90000;   // C127 회차 하나의 AI 호출 상한 — 운영 13건 중 가장 긴 물어보기(여러 회차 합)가 18.9초

function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) };
}
function permOf(member, col) {
  if (member.admin) return 'do';
  const key = COL[col];
  return (member.perms && member.perms[key]) || (PERM_CLOSED[key] ? 'hide' : 'view');
}
// C248 검토: 서버가 화면에 내려 주지 않는 지시(기성 연동·입·퇴사)는 물어보기에서도 뺀다 — gw-data 읽기와 같은 함수(_lib/taskhide)
const TH = require('./taskhide').make(permOf);
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || tier.retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
async function items(col) {
  const r = await blobGet(store(DATA), `col:${col}`);
  const doc = (r.ok && r.data) ? r.data : { items: [] };
  return (doc.items || []).filter((x) => x && x.del !== 1);
}
// 승인 기기만(v424 검토) — gw-data와 같은 판정. 화면은 승인 대기 화면으로 막지만 토큰은 이미 받은 상태라 서버에서도 닫는다
async function deviceApproved(event, member) {
  if (member && member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store('gw_users'), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}
const S = (v) => String(v == null ? '' : v);
// 인허가 공개 대상(앱 scopeIncludes와 같은 규칙) — 비어 있으면 전체, 관리자 통과, 모르는 토큰은 닫힌 쪽
const RANKS = ['대표', '이사', '부장', '차장', '과장', '대리', '주임', '사원'];
function scopeHas(scope, m) {
  if (m && m.admin) return true;
  return scopeIncl(scope, m);
}
// 앱 scopeIncludes와 같은 판정(관리자 자동 통과 없음) — 지시 scope처럼 '누구에게 온 것인가'를 볼 때(C248). 공개 범위(인허가)는 위 scopeHas
//   C248 검토: 배열 아닌 값도 앱처럼(!scope || !scope.length = 전체 · 아니면 scope[i]를 length까지) — 종전 Array.isArray 판정은 글자 꼴 범위를 전체 공개로 봐 화면보다 넓었다
function scopeIncl(scope, m) {
  if (!scope || !scope.length) return true;
  if (!m) return false;
  for (let i = 0; i < scope.length; i++) {
    const tk = scope[i];
    if (typeof tk !== 'string') continue;
    if (tk === m.id) return true;
    if (tk.indexOf('dept:') === 0) { if (m.dept && m.dept === tk.slice(5)) return true; }
    else if (tk.indexOf('rank:') === 0) { const ti = RANKS.indexOf(tk.slice(5)), mi = RANKS.indexOf(m.rank); if (ti >= 0 && mi >= 0 && mi <= ti) return true; }
  }
  return false;
}
// 나에게 온 지시(C248) — 앱 index.html taskForMe와 같은 규칙: 전사(who_id '__all__') · 본인 담당(who_id) · scope에 본인 포함 · 옛 자료(who_id 없이 이름).
//   종전엔 앱에 없는 칸(assignee_id·assignees)으로 걸러 누구에게나 0건이었다. 바꾸면 앱 taskForMe와 동시에(servertest C248)
function taskForMe(t, m) {
  if (!t || !m) return false;
  if (t.who_id === '__all__') return true;
  if (m.id) {
    if (t.who_id === m.id) return true;
    if (t.scope && t.scope.length && scopeIncl(t.scope, m)) return true;
  }
  if (!t.who_id && m.name && S(t.who).trim() === m.name) return true;
  return false;
}
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
// 'n일 안' 끝날 = 한국 날짜 기준(C248 검토 — 종전 UTC라 한국 00~09시엔 D-n 줄이 빠졌다) · 차량·인허가 만기 거르기가 같이 씀
const dueLimit = (days) => new Date(Date.now() + 9 * 3600000 + days * 86400000).toISOString().slice(0, 10);
const hit = (row, q, fields) => {
  if (!q) return true;
  const t = S(q).toLowerCase().replace(/\s+/g, '');
  return fields.some((f) => S(row[f]).toLowerCase().replace(/\s+/g, '').indexOf(t) >= 0);
};

// ── 도구 정의 ───────────────────────────────────────────────────────────────
// description은 클로드가 읽는 유일한 설명서다. 무엇을 돌려주고 무엇은 안 돌려주는지 여기에 못 박는다.
const TOOLS = [
  { name: 'vehicles', col: 'vehicles',
    description: '회사 차량 조회. 차번호·차종·소유(자차/지입)·허가(건설/환경)·기사·검사만기·보험만기·보험사·상태. 취득가액 같은 금액은 돌려주지 않는다. q에 차번호 일부나 차종을 넣으면 걸러진다.',
    schema: { type: 'object', properties: { q: { type: 'string', description: '차번호·차종·기사 일부(비우면 전체)' }, due_within_days: { type: 'number', description: '검사·보험 만기가 이 일수 안이거나 이미 지난 차만' } } },
    run: async (a) => (await items('vehicles'))
      .filter((v) => hit(v, a.q, ['no', 'type', 'kind', 'driver', 'own', 'permit', 'state']))
      .filter((v) => {
        if (a.due_within_days == null) return true;
        const lim = dueLimit(a.due_within_days);
        return (v.insp_due && v.insp_due <= lim) || (v.ins_due && v.ins_due <= lim);
      })
      .slice(0, ROW_CAP)
      .map((v) => ({ 차번호: v.no, 차종: v.kind || v.type, 소유: v.own, 허가: v.permit, 기사: v.driver, 검사만기: v.insp_due, 보험만기: v.ins_due, 보험사: v.insurer, 상태: v.state })) },

  { name: 'contracts', col: 'contracts',
    description: '계약 조회. 발주처·현장·공사명·구분·시작일·상태·담당·계약금액. q로 발주처나 현장을 거른다.',
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    run: async (a) => (await items('contracts'))
      .filter((c) => hit(c, a.q, ['client', 'site', 'title', 'label']))
      .slice(0, ROW_CAP)
      .map((c) => ({ 공사명: c.title, 발주처: c.client, 현장: c.site, 구분: c.label, 시작일: c.start, 상태: c.status, 담당: c.who, 계약금액: (c.contract_info || {}).amount })) },

  { name: 'licenses', col: 'licenses',
    description: '인허가·면허 조회. 이름·기관·번호·취득일·만기(만기 없는 것은 "해당없음"). q로 이름·기관·번호를 거른다. 만기 임박만 보려면 due_within_days.',
    schema: { type: 'object', properties: { q: { type: 'string' }, due_within_days: { type: 'number' } } },
    // C248 같은 줄기: 앱 인허가 줄의 칸(saveLicFromModal) = license_no·issued·expiry — 종전 no·got·due·kind·grade는 앱에 없는 칸이라 만기 임박이 늘 0건·번호/취득/만기가 늘 빈 값이었다
    run: async (a, member) => (await items('licenses'))
      .filter((l) => scopeHas(l.scope, member))   // v424 검토: 화면 licVisible과 같은 판정 — 자르기 전에
      .filter((l) => hit(l, a.q, ['name', 'org', 'license_no']))
      .filter((l) => {
        if (a.due_within_days == null) return true;
        const lim = dueLimit(a.due_within_days);
        return isDay(l.expiry) && l.expiry <= lim;
      })
      .slice(0, ROW_CAP)
      // 만기 칸은 날짜·'해당없음'만 그대로(화면은 그 밖의 값을 '만료 미정'으로만 보임 — 원값을 내지 않음)
      .map((l) => ({ 이름: l.name, 기관: l.org, 번호: l.license_no, 취득: l.issued, 만기: (isDay(l.expiry) || l.expiry === '해당없음') ? l.expiry : '' })) },

  { name: 'asbestos', col: 'asbestos',
    description: '석면 작업 이력 대장(산안법 30년 보존). 연번·공사명·발주처·소재지·기간·자재·면적·투입 인원수. 근로자 **이름과 생년월일은 돌려주지 않는다**(인원수만). q로 공사명·소재지를 거르고, year로 연도를 거른다.',
    schema: { type: 'object', properties: { q: { type: 'string' }, year: { type: 'string', description: '연도 4자리' }, min_area: { type: 'number', description: '석면 면적 하한(㎡)' } } },
    run: async (a) => (await items('asbestos'))
      .filter((r) => hit(r, a.q, ['title', 'site', 'client', 'material']))
      .filter((r) => !a.year || S(r.start).slice(0, 4) === S(a.year) || S(r.end).slice(0, 4) === S(a.year))
      .filter((r) => a.min_area == null || Number(r.area) >= a.min_area)
      .slice(0, ROW_CAP)
      .map((r) => ({ 연번: r.seq, 공사명: r.title, 발주처: r.client, 소재지: r.site, 시작: r.start, 종료: r.end, 자재: r.material, 면적: r.area, 투입인원: (r.worker_ids || []).length + (r.member_ids || []).length })) },

  { name: 'clients', col: 'clients',
    description: '거래처 조회. 상호·사업자번호·담당자·연락처·메모. **미수 금액은 돌려주지 않는다**(PM 결정 2026-09-10). q로 상호를 거른다.',
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    // v456(원장 C080): 사업자번호 칸의 13자리(주민·법인등록번호 꼴 — _lib/clibiz.js, 앱 cliBiz13과 같은 규칙)는 원문을 내지 않고 검색(q)에도 쓰지 않는다
    //   (번호를 넣어 물어 맞는지 확인하는 길도 막음) — 사업자번호 칸은 '13자리(숨김)'만. 앱 표·검색 글과 같은 원칙(v441).
    run: async (a) => (await items('clients'))
      .map((c) => (c && CLIBIZ.biz13(c.biz_no)) ? Object.assign({}, c, { biz_no: '', _b13: true }) : c)
      .filter((c) => hit(c, a.q, ['name', 'biz_no', 'contact', 'phone']))
      .slice(0, ROW_CAP)
      .map((c) => ({ 상호: c.name, 사업자번호: c._b13 ? '13자리(숨김)' : c.biz_no, 담당자: c.contact, 연락처: c.phone, 메모: S(c.note).slice(0, 60) })) },

  { name: 'documents', col: 'documents',
    description: '문서함 검색. 이 사람이 문서함 화면에서 볼 수 있는 문서만, 문서번호·제목·분류·상태를 돌려준다. **첨부 본문은 돌려주지 않는다.** q로 제목·번호를 거른다.',
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    // v424 문서함 화면과 같은 판정(공개범위·01 법인·남의 대기·반려) — 자르기 전에 거른다. 설정을 못 읽으면 가장 닫힌 쪽
    run: async (a, member) => { const ds = await DS.docSettings(store(DATA)); return (await items('documents'))
      .filter((d) => DS.docVisible(member, d, ds))
      .filter((d) => hit(d, a.q, ['title', 'id', 'cat', 'no']))
      .slice(0, ROW_CAP)
      .map((d) => ({ 번호: d.no || d.id, 제목: d.title, 분류: d.cat, 상태: d.status })); } },

  { name: 'bids', col: 'bids', admin_only: true,
    description: '입찰 공고 조회(관리자 전용). 공고명·기관·마감·기초금액·낙찰방법·하한율 판독 상태. q로 공고명·기관을 거른다.',
    schema: { type: 'object', properties: { q: { type: 'string' }, open_only: { type: 'boolean', description: '마감 미도래만' } } },
    run: async (a) => {
      const today = new Date().toISOString().slice(0, 10);
      return (await items('bids'))
        .filter((b) => hit(b, a.q, ['title', 'org', 'method', 'region']))
        .filter((b) => !a.open_only || S(b.due).slice(0, 10) >= today)
        .slice(0, ROW_CAP)
        .map((b) => ({ 공고명: S(b.title).slice(0, 60), 기관: b.org, 마감: b.due, 기초금액: b.budget, 낙찰방법: b.method, 하한율: (b.ext || {}).lwlt || '미판독' }));
    } },

  { name: 'my_tasks', col: 'tasks',
    description: '나에게 온 지시 조회(나에게 지정된 것 · 공개 대상에 내가 든 것 · 전 직원 대상). 제목·기한·상태. 남의 지시는 돌려주지 않는다.',
    schema: { type: 'object', properties: {} },
    run: async (a, member) => (await items('tasks'))
      .filter((t) => !TH.taskHiddenFor(member, t) && taskForMe(t, member))   // C248 서버 읽기 숨김(gw-data와 같은 함수) 다음 앱 taskForMe와 같은 규칙
      .slice(0, ROW_CAP)
      .map((t) => ({ 제목: t.title, 기한: t.due, 상태: t.status })) },
];

const SYSTEM = [
  '너는 종운환경(폐기물·준설)·종운건설(철거·석면)의 사내 그룹웨어 안에서 직원 질문에 답한다.',
  '규칙:',
  '1. 도구로 받은 데이터에 있는 것만 말한다. 없으면 "원장에 없습니다"라고 답한다. 짐작해서 채우지 않는다.',
  '2. 도구가 권한 없음을 돌려주면 그 사실을 그대로 전한다. 우회하거나 다른 도구로 같은 것을 캐내려 하지 않는다.',
  '3. 숫자는 도구가 준 값을 그대로 쓴다. 직접 계산이 필요하면 계산 과정을 밝힌다.',
  '4. 한국어로, 짧게. 표가 필요하면 표로.',
  '5. 근로자 개인정보(생년월일·연락처)와 금액 중 미수는 도구에 없다 — 물어보면 "이 창에서는 못 본다"고 답한다.',
  '6. 네게 보이는 도구가 전부가 아니다. 회사에는 네가 못 보는 자료(인허가·석면 대장·입찰·급여 등)가 더 있고, 그건 이 사람의 권한이 없어서 안 보이는 것이다.',
  '   그러니 도구로 못 찾은 것을 "회사에 없다"고 단정하지 마라. "이 창에서는 조회 권한이 없거나 없는 자료입니다"라고 답한다.',
].join('\n');

function toolDefs(member) {
  return TOOLS
    .filter((t) => !(t.admin_only && !member.admin))
    .filter((t) => permOf(member, t.col) !== 'hide')
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

async function runTool(name, args, member) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { error: '없는 도구' };
  if (t.admin_only && !member.admin) return { error: '권한 없음 — 관리자만 볼 수 있습니다' };
  if (permOf(member, t.col) === 'hide') return { error: '권한 없음 — 이 사람은 이 자료를 볼 수 없습니다' };
  try {
    const rows = await t.run(args || {}, member);
    return { count: rows.length, capped: rows.length >= ROW_CAP, rows };
  } catch (e) {
    return { error: 'TOOL_FAILED' };
  }
}

// ── 한 질문을 끝까지 돌리고 토큰을 센다 ───────────────────────────────────
async function ask(question, member) {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.GW_ANTHROPIC_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY' };
  const model = (process.env.GW_ASK_MODEL || 'claude-sonnet-5').trim();
  // 프롬프트 캐싱 — 도구 설명서와 규칙은 질문마다 같은 값인데 왕복마다 다시 나간다(실측: 입력의 77%).
  // 마지막 도구에 cache_control을 달면 그 앞의 tools+system이 통째로 캐시된다(5분 TTL, 같은 사람이 이어 물으면 재사용).
  const tools = toolDefs(member);
  if (tools.length) tools[tools.length - 1] = Object.assign({}, tools[tools.length - 1], { cache_control: { type: 'ephemeral' } });
  const system = [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: question }];
  const used = [];
  let inTok = 0, outTok = 0, turns = 0, answer = '', cWrite = 0, cRead = 0;
  let lastStop = '', lastText = '', exhausted = true;   // C264 마지막 회차 판정용

  while (turns < MAX_TURNS) {
    turns++;
    let resp;
    try {
      resp = await CL.fetchTimed('https://api.anthropic.com/v1/messages', CALL_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, tools, messages }),
      });
    } catch (e) {
      if (e && e.code === 'TIMEOUT') return { error: 'TIMEOUT', turns, in: inTok, out: outTok };   // C127 — 실패(차감 없음 · 화면 '잠시 뒤 다시')
      throw e;   // 망 오류는 종전대로(호출부 ASK_FAILED)
    }
    if (!resp.ok) {   // C264: 잔액 부족·키 거부는 공통 코드(CREDIT_LOW·AUTH)로 — 나머지는 종전 'CLAUDE_' + 상태 번호
      const et = await resp.text();
      return { error: CL.httpFailCode(resp.status, et), detail: et.slice(0, 300), turns, in: inTok, out: outTok };
    }
    const j = await resp.json();
    inTok += (j.usage && j.usage.input_tokens) || 0;
    outTok += (j.usage && j.usage.output_tokens) || 0;
    cWrite += (j.usage && j.usage.cache_creation_input_tokens) || 0;
    cRead += (j.usage && j.usage.cache_read_input_tokens) || 0;
    const blocks = j.content || [];
    lastStop = String(j.stop_reason || '');
    lastText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    answer = (lastText || answer);
    const calls = blocks.filter((b) => b.type === 'tool_use');
    if (!calls.length || j.stop_reason !== 'tool_use') { exhausted = false; break; }
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const c of calls) {
      const out = await runTool(c.name, c.input, member);
      used.push({ name: c.name, args: c.input, rows: out.count == null ? out.error : out.count });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  // C264: 글 없는 답·잘린 답은 실패 — 성공으로 두면 '(빈 답)'·끊긴 글이 정상 답처럼 보이고 하루 횟수·월 토큰·감사 줄이 차감됐다(호출부는 r.error면 차감하지 않는다).
  //   잘림 = 마지막 회차 stop_reason max_tokens(글이 조금 있어도) · 회차 소진 = 도구만 부르다 MAX_TURNS를 다 씀 · 빈 답 = 마지막 회차에 글이 없음(앞 회차의 '찾아보겠습니다' 같은 글은 답이 아님)
  const cut = lastStop === 'max_tokens' ? 'MAX_TOKENS' : (exhausted ? 'MAX_TURNS' : (!String(lastText).trim() ? 'EMPTY' : ''));
  if (cut) return { error: cut, turns, in: inTok, out: outTok, cw: cWrite, cr: cRead, tools: used, tool_count: tools.length };
  return { answer, turns, in: inTok, out: outTok, cw: cWrite, cr: cRead, tools: used, tool_count: tools.length };
}

// C264: 실패 코드별 직원 화면 글(gw-ask-background·gw-ask 공용) — 잔액·키는 '관리자 확인 필요', 끊긴 답·빈 답은 그 이유, 나머지(과부하·속도 제한·서버·네트워크)만 '잠시 뒤 다시'
function failAnswer(code) {
  if (CL.adminFail(code)) return '지금은 답할 수 없습니다 — ' + CL.ADMIN_FAIL_TEXT;
  if (code === 'MAX_TOKENS' || code === 'MAX_TURNS') return '답이 길어 끊겼습니다 — 질문을 좁혀 다시 물어보세요.';
  if (code === 'EMPTY') return '답을 만들지 못했습니다 — 다시 물어보세요.';
  return '지금은 답할 수 없습니다. 잠시 뒤 다시 물어보세요.';
}

module.exports = { TOOLS, SYSTEM, ROW_CAP, MAX_TURNS, toolDefs, runTool, permOf, ask, failAnswer, deviceApproved, scopeHas, taskForMe, scopeIncl };   // scopeIncl: gw-data 기성 공개범위(C296)도 같은 판정
