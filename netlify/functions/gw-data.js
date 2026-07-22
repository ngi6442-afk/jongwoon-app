'use strict';

// 그룹웨어 데이터 (서버측 권한 강제). Netlify Blobs.
// 'gw_data' 저장: col:tasks / col:vehicles / col:receivables / col:licenses / col:checklist
// 권한은 'gw_users'의 회원 레코드(perms)에서 확인. 관리자는 전부 허용.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit, auditKey, diffItems } = require('./_lib/audit');

const DATA = 'gw_data';
const USERS = 'gw_users';
// 컬렉션 → 권한키
const COL = { tasks: 'tasks', vehicles: 'veh', receivables: 'rec', licenses: 'lic', checklist: 'check', documents: 'doc', clients: 'cli', contracts: 'con', leaves: 'leaves' };
// 사용자별 비공개 컬렉션(본인만 접근, 회원 id로 분리 저장)
const PRIVATE_COL = { mytasks: true };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
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
// 인가된 기기만 데이터 접근. 관리자는 항상 허용.
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}

async function handleGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (PRIVATE_COL[d.collection]) {
    const pr = await blobGet(store(DATA), `priv:${c.member.id}:${d.collection}`);
    return jr(200, { status: 'OK', collection: d.collection, doc: (pr.ok && pr.data) ? pr.data : { schema: 1, items: [] }, can_write: true, request_id: R });
  }
  const col = d.collection;
  if (!COL[col]) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  const p = permOf(c.member, col);
  // tasks: 개인 인박스('내게 온 지시')·홈 미완료지시는 권한과 무관하게 노출해야 하므로 hide여도 읽기 허용.
  // 가시성(담당/전사/공개범위) 필터는 프런트에서. 쓰기는 여전히 'do' 필요.
  if (p === 'hide' && col !== 'tasks') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(DATA), colKey(col));
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  const doc = r.data || { schema: 1, items: [] };
  return jr(200, { status: 'OK', collection: col, doc, can_write: p === 'do', request_id: R });
}

async function handleSave(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (PRIVATE_COL[d.collection]) {
    if (!d.doc || typeof d.doc !== 'object') return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
    const pw = await blobSet(store(DATA), `priv:${c.member.id}:${d.collection}`, Object.assign({}, d.doc, { updated_at: Date.now() }));
    if (!pw.ok) return jr(500, { status: 'ERROR', error_code: pw.code, request_id: R });
    return jr(200, { status: 'OK', request_id: R });
  }
  const col = d.collection;
  if (!COL[col]) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  // tasks: 직원(권한 do 아님)도 '내게 온 지시'를 완료(→승인대기)/보류하려면 저장이 필요 → 승인제 성립.
  // tasks 쓰기는 인증·인가 회원이면 허용(프런트 canActTask로 자기 업무만 조작, UI 권한 구분이지 하드보안 아님).
  if (permOf(c.member, col) !== 'do' && col !== 'tasks' && col !== 'leaves') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  if (!d.doc || typeof d.doc !== 'object') return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
  // 감사 로그용 이전 문서(diff 원본) — 읽기 실패해도 저장은 진행
  let oldItems = [];
  try { const prev = await blobGet(store(DATA), colKey(col)); if (prev.ok && prev.data && Array.isArray(prev.data.items)) oldItems = prev.data.items; } catch (e) {}
  const doc = Object.assign({}, d.doc, { updated_by: c.member.id, updated_at: Date.now() });
  const w = await blobSet(store(DATA), colKey(col), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 감사 로그: 누가·언제·무엇을(이전값→새값). 서버측 기록이라 클라이언트 위변조 불가.
  try {
    const ev = diffItems(oldItems, Array.isArray(doc.items) ? doc.items : []);
    if (ev.length) await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: col, ev: ev });
  } catch (e) {}
  return jr(200, { status: 'OK', request_id: R });
}

// 감사 로그 조회(관리자 전용). month='YYYY-MM' 미지정 시 이번 달.
async function handleAudit(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const key = auditKey(d.month);
  const r = await blobGet(store(DATA), key);
  const doc = (r.ok && r.data) ? r.data : { schema: 1, items: [] };
  return jr(200, { status: 'OK', month: key.slice(6), doc: doc, request_id: R });
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { status: 'REJECTED', error_code: 'INVALID_JSON', request_id: R }); }
  try {
    if (d && d.action === 'get') return await handleGet(event, d, R);
    if (d && d.action === 'save') return await handleSave(event, d, R);
    if (d && d.action === 'audit') return await handleAudit(event, d, R);
    return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
