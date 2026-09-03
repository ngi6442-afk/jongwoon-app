'use strict';
// 진척도(관리자 전용, 2026-09-03) — 레포에 번들된 진척도 HTML을 세션+관리자 검증 후 JSON으로 돌려준다.
// 왜 함수인가: publish="."라 레포 파일은 전부 정적으로 열린다(실측). 벽지용 /w/ 무인증 경로와 달리 이 문서는
// 직원명·금액·계획을 담으므로 로그인 뒤에만 나가야 한다. 원본 _lib/progress.json은 정적 require로 esbuild가 인라인
// 번들한다(gw-data.js의 bjd.json과 같은 경로). /netlify/* 정적 경로는 netlify.toml의 force 재작성으로 막는다.
// 갱신: 00_진척도/진척도_빌드.js가 progress.json을 다시 쓰고 커밋·푸시하면 배포된다.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const PROG = require('./_lib/progress.json');

const USERS = 'gw_users';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS), body: JSON.stringify(body) }; }
function kstDate() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
function retired(m) { const ld = m && m.leave_date; return ld ? String(ld) < kstDate() : false; }

// 회원 재조회로 삭제·퇴사를 매 호출 반영(gw-hwakwan·gw-data와 동일). 토큰 payload.admin은 인가에 쓰지 않는다.
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return jr(400, { ok: false, code: 'INVALID_JSON', request_id: R }); }
  try {
    const c = await currentMember(event);
    if (!c.ok) return jr(401, { ok: false, code: c.reason || 'NO_SESSION', request_id: R });
    if (!(c.member.admin || c.member.dev)) return jr(403, { ok: false, code: 'ADMIN_ONLY', request_id: R });
    const action = String(d.action || 'html');
    if (action === 'status') return jr(200, { ok: true, updated: PROG.updated || '', overall: PROG.overall, bytes: (PROG.html || '').length, request_id: R });
    if (action !== 'html') return jr(400, { ok: false, code: 'BAD_ACTION', request_id: R });
    if (!PROG.html) return jr(404, { ok: false, code: 'NO_DOC', request_id: R });
    try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'progress', ev: [{ op: '열람', id: String(PROG.updated || ''), t: '진척도' }] }); } catch (e) {}
    return jr(200, { ok: true, updated: PROG.updated || '', overall: PROG.overall, html: PROG.html, request_id: R });
  } catch (e) {
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
};
