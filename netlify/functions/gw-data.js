'use strict';

// 그룹웨어 데이터 (서버측 권한 강제). Netlify Blobs.
// 'gw_data' 저장: col:tasks / col:vehicles / col:receivables / col:licenses / col:checklist
// 권한은 'gw_users'의 회원 레코드(perms)에서 확인. 관리자는 전부 허용.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');

const DATA = 'gw_data';
const USERS = 'gw_users';
// 컬렉션 → 권한키
const COL = { tasks: 'tasks', vehicles: 'veh', receivables: 'rec', licenses: 'lic', checklist: 'check' };

function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function colKey(c) { return `col:${c}`; }

async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
function permOf(member, col) {
  if (member.admin) return 'do';
  const key = COL[col];
  return (member.perms && member.perms[key]) || 'view';
}

async function handleGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const col = d.collection;
  if (!COL[col]) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  if (permOf(c.member, col) === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(DATA), colKey(col));
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  const doc = r.data || { schema: 1, items: [] };
  return jr(200, { status: 'OK', collection: col, doc, can_write: permOf(c.member, col) === 'do', request_id: R });
}

async function handleSave(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const col = d.collection;
  if (!COL[col]) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  if (permOf(c.member, col) !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  if (!d.doc || !Array.isArray(d.doc.items)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
  const doc = { schema: d.doc.schema || 1, items: d.doc.items, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(store(DATA), colKey(col), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  return jr(200, { status: 'OK', request_id: R });
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { Allow: 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { status: 'REJECTED', error_code: 'INVALID_JSON', request_id: R }); }
  try {
    if (d && d.action === 'get') return await handleGet(event, d, R);
    if (d && d.action === 'save') return await handleSave(event, d, R);
    return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
