'use strict';

// 질문창 1단계 — 직원이 앱에서 물으면 회사 원장을 근거로 답한다. 읽기 전용.
// PM 승인 2026-09-10(비용 실측 34문항 뒤 GO).
//
// 지키는 것(브리핑 3장):
//   · 도구 실행은 서버가 한다 — 클로드는 "무엇을 불러 달라"고 말할 뿐이고 열람 가부는 permOf가 정한다.
//     권한이 없는 도구는 목록에서 아예 빠지고, 불러도 "권한 없음"이 돌아간다.
//   · 쓰기·삭제·상신 없음. 원장을 통째로 보내지 않는다(질문에 걸린 행만).
//   · 질문·쓴 도구·답 요약을 감사로그에 남긴다.
//   · 상한 — 1인 하루 질문 수와 월 전체 토큰. 넘으면 답하지 않고 한도라고 말한다.
//
// 상한을 왜 서버에 두나 — 화면에서 막으면 구버전 앱·직접 호출로 새어 나간다. 돈이 나가는 문은 서버에서 닫는다.

const crypto = require('crypto');
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
const DAY_MAX = Number(process.env.GW_ASK_DAY_MAX || 40);          // 1인 하루 질문 수
const MONTH_TOKENS = Number(process.env.GW_ASK_MONTH_TOKENS || 12000000);  // 월 전체 입력+출력 토큰
// 12,000,000 토큰 ≈ 실측 1문항 5,451토큰 기준 2,200문항 — 사무실 5명이 하루 20문항씩 22일 쓰는 양이다.

function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) };
}
function kstDay(t) { return new Date((t || Date.now()) + 9 * 3600000).toISOString().slice(0, 10); }

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
// 쓰기는 질문이 끝난 뒤 한 번. 브라우저가 한 번에 한 질문만 보내므로 경합은 사실상 없다.
async function bumpUsage(memberId, tokens) {
  const u = await readUsage();
  const day = kstDay(), mon = day.slice(0, 7);
  const dk = day + '|' + memberId;
  u.day = Object.keys(u.day).reduce(function (o, k) { if (k.slice(0, 10) >= day) o[k] = u.day[k]; return o; }, {});   // 어제 것은 버린다
  u.day[dk] = (u.day[dk] || 0) + 1;
  u.month[mon] = (u.month[mon] || 0) + tokens;
  u.updated_at = Date.now();
  await blobSet(store(DATA), USAGE_KEY, u);
  return u;
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
  const member = c.member;

  const u = await readUsage();
  const day = kstDay(), mon = day.slice(0, 7);
  const mine = u.day[day + '|' + member.id] || 0;
  const monthTok = u.month[mon] || 0;

  if (d.action === 'status') {
    return jr(200, {
      ok: true, who: member.name, tools: A.toolDefs(member).map(function (t) { return t.name; }),
      day_used: mine, day_max: DAY_MAX, month_tokens: monthTok, month_max: MONTH_TOKENS, request_id: R,
    });
  }

  const q = String(d.q || '').trim().slice(0, 500);
  if (!q) return jr(400, { ok: false, code: 'NO_QUESTION', request_id: R });
  if (mine >= DAY_MAX) {
    return jr(200, { ok: false, code: 'DAY_LIMIT', answer: '오늘 물어볼 수 있는 횟수(' + DAY_MAX + '회)를 다 썼습니다. 내일 다시 물어보세요.', request_id: R });
  }
  if (monthTok >= MONTH_TOKENS) {
    return jr(200, { ok: false, code: 'MONTH_LIMIT', answer: '이번 달 사용 한도에 걸렸습니다. 관리자에게 알려 주세요.', request_id: R });
  }
  if (!A.toolDefs(member).length) {
    return jr(200, { ok: false, code: 'NO_TOOLS', answer: '조회할 수 있는 자료가 없습니다 — 권한을 받은 뒤에 물어보세요.', request_id: R });
  }

  const t0 = Date.now();
  let r;
  try { r = await A.ask(q, member); } catch (e) { r = { error: 'ASK_FAILED' }; }
  if (r.error) {
    return jr(200, { ok: false, code: r.error, answer: '지금은 답할 수 없습니다. 잠시 뒤 다시 물어보세요.', request_id: R });
  }
  const total = (r.in || 0) + (r.out || 0);
  await bumpUsage(member.id, total);

  // 감사로그 — 질문·쓴 도구·답 앞머리. 답 전문은 남기지 않는다(원장 내용이 로그로 새지 않게).
  try {
    await appendAudit({
      ts: Date.now(), by: member.name, bid: member.id, col: 'ask',
      ev: [{ op: '질문', id: R, t: q.slice(0, 80), n: (r.tools || []).map(function (t) { return t.name; }).join(',') }],
    });
  } catch (e) { /* 로그 실패가 답을 막지는 않는다 */ }

  return jr(200, {
    ok: true, answer: r.answer || '', turns: r.turns, ms: Date.now() - t0,
    tools: (r.tools || []).map(function (t) { return { name: t.name, rows: t.rows }; }),
    usage: { in: r.in, out: r.out, cache_read: r.cr || 0, cache_write: r.cw || 0 },
    day_used: mine + 1, day_max: DAY_MAX, request_id: R,
  });
};
