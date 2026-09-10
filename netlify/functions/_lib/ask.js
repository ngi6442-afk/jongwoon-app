'use strict';

// 질문창 공용 — 도구 정의·권한 통과·클로드 호출. 본편(gw-ask)과 계측기(gw-ask-meter)가 같이 쓴다.
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

const DATA = 'gw_data';

const PERM_CLOSED = { quote: 1, promo: 1, hr: 1, lic: 1 };   // gw-data와 같은 집합
const COL = { vehicles: 'veh', licenses: 'lic', asbestos: 'lic', contracts: 'con',
  clients: 'cli', documents: 'doc', bids: 'bid', tasks: 'tasks', workers: 'wk' };

const ROW_CAP = 25;          // 도구 한 번이 돌려주는 최대 행 — 원장을 통째로 보내지 않는다
const MAX_TURNS = 6;         // 도구 왕복 상한(무한 루프 방지)
const MAX_TOKENS = 1500;

function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) };
}
function permOf(member, col) {
  if (member.admin) return 'do';
  const key = COL[col];
  return (member.perms && member.perms[key]) || (PERM_CLOSED[key] ? 'hide' : 'view');
}
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
const S = (v) => String(v == null ? '' : v);
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
        const lim = new Date(Date.now() + a.due_within_days * 86400000).toISOString().slice(0, 10);
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
    description: '인허가·면허 조회. 종류·기관·번호·취득일·만기·등급. q로 이름을 거른다. 만기 임박만 보려면 due_within_days.',
    schema: { type: 'object', properties: { q: { type: 'string' }, due_within_days: { type: 'number' } } },
    run: async (a) => (await items('licenses'))
      .filter((l) => hit(l, a.q, ['name', 'org', 'no', 'kind']))
      .filter((l) => {
        if (a.due_within_days == null) return true;
        const lim = new Date(Date.now() + a.due_within_days * 86400000).toISOString().slice(0, 10);
        return l.due && l.due <= lim;
      })
      .slice(0, ROW_CAP)
      .map((l) => ({ 이름: l.name, 기관: l.org, 번호: l.no, 취득: l.got, 만기: l.due, 등급: l.grade })) },

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
    run: async (a) => (await items('clients'))
      .filter((c) => hit(c, a.q, ['name', 'biz_no', 'contact', 'phone']))
      .slice(0, ROW_CAP)
      .map((c) => ({ 상호: c.name, 사업자번호: c.biz_no, 담당자: c.contact, 연락처: c.phone, 메모: S(c.note).slice(0, 60) })) },

  { name: 'documents', col: 'documents',
    description: '문서함 검색. 문서번호·제목·분류·상태만 돌려준다. **첨부 본문은 돌려주지 않는다.** q로 제목·번호를 거른다.',
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    run: async (a) => (await items('documents'))
      .filter((d) => hit(d, a.q, ['title', 'id', 'cat', 'no']))
      .slice(0, ROW_CAP)
      .map((d) => ({ 번호: d.no || d.id, 제목: d.title, 분류: d.cat, 상태: d.status })) },

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
    description: '나에게 온 지시 조회. 제목·기한·상태. 남의 지시는 돌려주지 않는다.',
    schema: { type: 'object', properties: {} },
    run: async (a, member) => (await items('tasks'))
      .filter((t) => S(t.assignee_id) === S(member.id) || (Array.isArray(t.assignees) && t.assignees.indexOf(member.id) >= 0))
      .slice(0, ROW_CAP)
      .map((t) => ({ 제목: t.title, 기한: t.due, 상태: t.status })) },
];

// 실측 질문 30개 — 실제 업무에서 뽑았다(공무 배차·만기 7 · 계약 4 · 인허가 3 · 석면 6 · 거래처 3 · 입찰 4 · 문서함 2 · 내 지시 1).
// 종전엔 브라우저가 들고 한 문항씩 돌렸는데, 폰 화면이 꺼지면 브라우저가 멈춰 4문항에서 끊겼다(2026-09-10 실측).
// 그래서 목록을 서버로 옮기고 백그라운드 함수가 끝까지 돈다.
const METER_Q = [
  '84수6457 검사 언제까지야',
  '검사만기 30일 안 남은 차 몇 대야',
  '보험 만기 지난 차 있어?',
  '지입차 몇 대야',
  '환경 허가 차량하고 건설 허가 차량 각각 몇 대야',
  '암롤차 기사 누구야',
  '휴차 중인 차 알려줘',
  '지금 진행 중인 계약 뭐 있어',
  '포항시 발주 계약 있어?',
  '계약금액 제일 큰 건 뭐야',
  '준설 계약 몇 건이야',
  '인허가 만기 60일 안 남은 거 알려줘',
  '폐기물 수집운반업 허가 만기 언제야',
  '우리 면허 몇 개야',
  '작년에 석면 현장 몇 건 했어',
  '석면 800제곱미터 넘는 현장 알려줘',
  '남성초 석면 공사 언제 했어',
  '슬레이트 철거 현장 최근 것 5개',
  '2024년 석면 현장 다 알려줘',
  '석면 현장 중에 포항 아닌 데 있어?',
  '포스코 거래처 연락처 알려줘',
  '거래처 몇 곳이야',
  '그린바이로 담당자 누구야',
  '오늘 마감 안 지난 입찰 몇 건이야',
  '적격심사 입찰 중에 하한율 못 읽은 거 몇 건이야',
  '경북 지역 입찰 알려줘',
  '기초금액 5억 넘는 공고 있어?',
  '문서함에서 취업규칙 찾아줘',
  '안전보건 관련 문서 뭐 있어',
  '내게 온 지시 뭐 있어',
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

  while (turns < MAX_TURNS) {
    turns++;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, tools, messages }),
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status, detail: (await resp.text()).slice(0, 300), turns, in: inTok, out: outTok };
    const j = await resp.json();
    inTok += (j.usage && j.usage.input_tokens) || 0;
    outTok += (j.usage && j.usage.output_tokens) || 0;
    cWrite += (j.usage && j.usage.cache_creation_input_tokens) || 0;
    cRead += (j.usage && j.usage.cache_read_input_tokens) || 0;
    const blocks = j.content || [];
    answer = (blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || answer);
    const calls = blocks.filter((b) => b.type === 'tool_use');
    if (!calls.length || j.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const c of calls) {
      const out = await runTool(c.name, c.input, member);
      used.push({ name: c.name, args: c.input, rows: out.count == null ? out.error : out.count });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer, turns, in: inTok, out: outTok, cw: cWrite, cr: cRead, tools: used, tool_count: tools.length };
}

// 측정값을 서버에 남긴다 — 종전엔 브라우저 화면에만 있어 창을 닫으면 사라졌다(2026-09-10 실사고).
async function saveRow(row, r) {
  try {
    const prev = await blobGet(store(DATA), 'meter:cost');
    const doc = (prev.ok && prev.data && Array.isArray(prev.data.rows)) ? prev.data : { schema: 1, rows: [] };
    doc.rows.push({ ts: row.ts, who: row.who, q: row.q, turns: r.turns || 0, in: r.in || 0, out: r.out || 0,
                    ms: row.ms, tools: (r.tools || []).map((t) => t.name + '(' + t.rows + ')').join(' '),
                    err: r.error || '', answer: String(r.answer || '').slice(0, 400) });
    doc.rows = doc.rows.slice(-300);
    doc.updated_at = Date.now();
    await blobSet(store(DATA), 'meter:cost', doc);
  } catch (e) { /* 기록 실패가 측정 자체를 막지는 않는다 */ }
}


module.exports = { TOOLS, SYSTEM, METER_Q, ROW_CAP, MAX_TURNS, toolDefs, runTool, permOf, ask };
