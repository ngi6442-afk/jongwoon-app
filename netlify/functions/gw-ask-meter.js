'use strict';

// 질문창 1단계 — **비용 계측기**(제품 아님). PM 2026-09-10 "추정으로 시작하지 않는다"에 따라
// 실제 업무 질문을 진짜 원장에 물려 돌려 보고 토큰을 잰다. 그 결과를 보고 PM이 GO/STOP을 정한다.
//
// 왜 별도 함수인가 — 이 파일은 화면도 없고 쓰기도 없고 관리자만 부를 수 있다. 측정이 끝나면 지운다.
// 다만 여기서 만든 도구 정의·권한 통과 방식이 그대로 본편(gw-ask)의 뼈대가 된다. 두 번 만들지 않는다.
//
// 지키는 것(브리핑 3장 그대로):
//   · 도구를 실행하는 것은 서버다. 클로드는 "무엇을 불러 달라"고 말할 뿐이고 열람 가부는 permOf가 정한다.
//   · 읽기 전용. 쓰기·삭제·상신 없음.
//   · 도구는 질문에 걸린 행만, 상한까지만 돌려준다(원장을 통째로 보내지 않는다).
//   · 근로자 생년월일·연락처, 급여·연차, 견적서, 첨부 본문, 미수는 도구에 아예 싣지 않는다.
//     (미수 제외 = PM 2026-09-10 "미수는 빼도 될 듯 — 자동으로 띄우는 형태가 아니기 때문")

const crypto = require('crypto');
const { setupBlobContext, store, blobGet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const tier = require('./_lib/tier');

const DATA = 'gw_data';
const USERS = 'gw_users';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
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

const SYSTEM = [
  '너는 종운환경(폐기물·준설)·종운건설(철거·석면)의 사내 그룹웨어 안에서 직원 질문에 답한다.',
  '규칙:',
  '1. 도구로 받은 데이터에 있는 것만 말한다. 없으면 "원장에 없습니다"라고 답한다. 짐작해서 채우지 않는다.',
  '2. 도구가 권한 없음을 돌려주면 그 사실을 그대로 전한다. 우회하거나 다른 도구로 같은 것을 캐내려 하지 않는다.',
  '3. 숫자는 도구가 준 값을 그대로 쓴다. 직접 계산이 필요하면 계산 과정을 밝힌다.',
  '4. 한국어로, 짧게. 표가 필요하면 표로.',
  '5. 근로자 개인정보(생년월일·연락처)와 금액 중 미수는 도구에 없다 — 물어보면 "이 창에서는 못 본다"고 답한다.',
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
  const tools = toolDefs(member);
  const messages = [{ role: 'user', content: question }];
  const used = [];
  let inTok = 0, outTok = 0, turns = 0, answer = '';

  while (turns < MAX_TURNS) {
    turns++;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, tools, messages }),
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status, detail: (await resp.text()).slice(0, 300), turns, in: inTok, out: outTok };
    const j = await resp.json();
    inTok += (j.usage && j.usage.input_tokens) || 0;
    outTok += (j.usage && j.usage.output_tokens) || 0;
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
  return { answer, turns, in: inTok, out: outTok, tools: used, tool_count: tools.length };
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return jr(400, { ok: false, code: 'INVALID_JSON', request_id: R }); }
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { ok: false, code: c.reason || 'NO_SESSION', request_id: R });
  if (!c.member.admin) return jr(403, { ok: false, code: 'ADMIN_ONLY', request_id: R });

  // as: 다른 직원의 권한으로 같은 질문을 돌려 본다(권한 통과 확인용). 그 사람 자격으로 데이터를 읽을 뿐 세션은 만들지 않는다.
  let member = c.member;
  if (d.as) {
    const r = await blobGet(store(USERS), `member:${d.as}`);
    if (!r.ok || !r.data) return jr(404, { ok: false, code: 'NO_SUCH_MEMBER', request_id: R });
    member = r.data;
  }
  if (d.action === 'tools') return jr(200, { ok: true, who: member.name, admin: !!member.admin, tools: toolDefs(member).map((t) => t.name), request_id: R });
  const q = String(d.q || '').slice(0, 500);
  if (!q) return jr(400, { ok: false, code: 'NO_QUESTION', request_id: R });
  const t0 = Date.now();
  const r = await ask(q, member);
  return jr(200, Object.assign({ ok: !r.error, q, who: member.name, ms: Date.now() - t0, request_id: R }, r));
};
