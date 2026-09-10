'use strict';

// 물어보기 백그라운드 워커 — 질문 하나를 끝까지 돌려 결과를 blob 'ask:job:<회원>:<id>'에 쓴다.
//
// 왜 백그라운드인가 — 실측(2026-09-10 34문항)에서 평균 8.4초·최대 20.5초였고, 실사용 첫날(9/11) 김호태 계정에서
// **504(함수 시간 초과)**가 실제로 났다. 동기 함수는 답을 다 만들 때까지 붙잡고 있어야 해서 긴 질문이 그대로 죽는다.
// 이제 즉시 202를 돌려주고 서버가 끝까지 돈다. 화면은 1.5초마다 gw-ask {action:'poll'}로 결과를 가져온다.
//
// 상한·감사·권한은 gw-ask(동기)와 같은 규칙이다 — 상한 검사는 여기서도 다시 한다(돈이 나가는 문은 여기다).

const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const tier = require('./_lib/tier');
const A = require('./_lib/ask');

const DATA = 'gw_data';
const USERS = 'gw_users';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const USAGE_KEY = 'ask:usage';
const DAY_MAX = Number(process.env.GW_ASK_DAY_MAX || 40);
const MONTH_TOKENS = Number(process.env.GW_ASK_MONTH_TOKENS || 12000000);
const RE_JOB = /^[a-z0-9]{6,32}$/;

function kstDay(t) { return new Date((t || Date.now()) + 9 * 3600000).toISOString().slice(0, 10); }
function jobKey(mid, id) { return 'ask:job:' + mid + ':' + id; }

async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || tier.retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
async function readUsage() {
  const r = await blobGet(store(DATA), USAGE_KEY);
  const d = (r.ok && r.data) ? r.data : {};
  return { day: d.day || {}, month: d.month || {}, updated_at: d.updated_at || 0 };
}
async function bumpUsage(memberId, tokens) {
  const u = await readUsage();
  const day = kstDay(), mon = day.slice(0, 7), dk = day + '|' + memberId;
  u.day = Object.keys(u.day).reduce(function (o, k) { if (k.slice(0, 10) >= day) o[k] = u.day[k]; return o; }, {});
  u.day[dk] = (u.day[dk] || 0) + 1;
  u.month[mon] = (u.month[mon] || 0) + tokens;
  u.updated_at = Date.now();
  await blobSet(store(DATA), USAGE_KEY, u);
  return u.day[dk];
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: '' }; }
  const c = await currentMember(event);
  if (!c.ok) return { statusCode: 401, headers: CORS, body: '' };
  const member = c.member;
  const id = String(d.job || '');
  const q = String(d.q || '').trim().slice(0, 500);
  if (!RE_JOB.test(id) || !q) return { statusCode: 400, headers: CORS, body: '' };
  const key = jobKey(member.id, id);
  const t0 = Date.now();
  const put = (doc) => blobSet(store(DATA), key, Object.assign({ q, who: member.name, ts: t0 }, doc));

  await put({ state: 'running' });

  const u = await readUsage();
  const day = kstDay(), mon = day.slice(0, 7);
  const mine = u.day[day + '|' + member.id] || 0;
  if (mine >= DAY_MAX) {
    await put({ state: 'done', ok: false, code: 'DAY_LIMIT', answer: '오늘 물어볼 수 있는 횟수(' + DAY_MAX + '회)를 다 썼습니다. 내일 다시 물어보세요.', day_used: mine, day_max: DAY_MAX });
    return { statusCode: 202, body: '' };
  }
  if ((u.month[mon] || 0) >= MONTH_TOKENS) {
    await put({ state: 'done', ok: false, code: 'MONTH_LIMIT', answer: '이번 달 사용 한도에 걸렸습니다. 관리자에게 알려 주세요.' });
    return { statusCode: 202, body: '' };
  }
  if (!A.toolDefs(member).length) {
    await put({ state: 'done', ok: false, code: 'NO_TOOLS', answer: '조회할 수 있는 자료가 없습니다 — 권한을 받은 뒤에 물어보세요.' });
    return { statusCode: 202, body: '' };
  }

  let r;
  try { r = await A.ask(q, member); } catch (e) { r = { error: 'ASK_FAILED' }; }
  if (r.error) {
    await put({ state: 'done', ok: false, code: r.error, answer: '지금은 답할 수 없습니다. 잠시 뒤 다시 물어보세요.' });
    return { statusCode: 202, body: '' };
  }
  const used = await bumpUsage(member.id, (r.in || 0) + (r.out || 0));
  try {
    await appendAudit({ ts: Date.now(), by: member.name, bid: member.id, col: 'ask',
      ev: [{ op: '질문', id: id, t: q.slice(0, 80), n: (r.tools || []).map(function (t) { return t.name; }).join(',') }] });
  } catch (e) { /* 로그 실패가 답을 막지는 않는다 */ }
  await put({
    state: 'done', ok: true, answer: r.answer || '', turns: r.turns, ms: Date.now() - t0,
    tools: (r.tools || []).map(function (t) { return { name: t.name, rows: t.rows }; }),
    usage: { in: r.in, out: r.out, cache_read: r.cr || 0, cache_write: r.cw || 0 },
    day_used: used, day_max: DAY_MAX,
  });
  return { statusCode: 202, body: '' };
};
