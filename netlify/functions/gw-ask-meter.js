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
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const tier = require('./_lib/tier');

const DATA = 'gw_data';
const USERS = 'gw_users';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// 도구·권한·클로드 호출은 _lib/ask.js 한 곳에 있다(본편 gw-ask와 공용). 여기는 측정 껍데기다.
const A = require('./_lib/ask');
const { TOOLS, SYSTEM, METER_Q, ROW_CAP, MAX_TURNS, toolDefs, runTool, permOf, ask } = A;


async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || tier.retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}

// 측정값을 서버에 남긴다 — 브라우저 화면에만 있으면 창을 닫는 순간 사라진다(2026-09-10 실사고).
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

module.exports.METER_Q = METER_Q;
module.exports.ask = ask;
module.exports.saveRow = saveRow;
module.exports.currentMember = currentMember;

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
  const row = Object.assign({ ok: !r.error, q, who: member.name, ms: Date.now() - t0, ts: Date.now() }, r);
  await saveRow(row, r);
  return jr(200, row);
};
