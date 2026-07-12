'use strict';

// 그룹웨어 인증 + 회원관리 (서버측). Netlify Blobs 'gw_users' 저장.
// 회원: member:<id> = {id,name,role,rank,dept,admin,perms,pin_salt,pin_hash,created,updated,del} — role=직책(권한), rank=직급, dept=부서
//       name:<lower> = id  (이름 인덱스)
// PIN은 scrypt 해시로만 저장(평문 저장 안 함). 세션은 HMAC 토큰.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { hashSecret, verifySecret } = require('./_lib/password');
const { issueSession, verifyToken, bearer } = require('./_lib/session');

const USERS = 'gw_users';
const MODULES = ['tasks', 'veh', 'rec', 'lic', 'check', 'con', 'cli', 'doc'];
const LOCK_THRESHOLD = 5;                 // 연속 실패 허용 횟수
const LOCK_MS = 15 * 60 * 1000;           // 잠금 시간(15분)
function lockKey(name) { return `lock:${String(name).trim().toLowerCase()}`; }
// 관리자는 8자 이상 비밀번호, 직원은 4자리+ 숫자 PIN
function validSecret(s, isAdmin) { s = String(s || '').trim(); return isAdmin ? s.length >= 8 : /^\d{4,}$/.test(s); }
function deviceKey(id) { return `device:${id}`; }
function deviceOf(event) {
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  let label = String(h['x-device-label'] || '');
  try { label = decodeURIComponent(label); } catch (e) {}
  return { id: id, label: label };
}
// 기기 등록/갱신. 관리자 기기는 자동 승인, 직원 새 기기는 대기. 상태 반환.
async function registerDevice(st, event, member) {
  const dv = deviceOf(event);
  if (!dv.id) return 'approved';   // 기기정보 없으면(구버전) 통과
  const now = Date.now();
  const dr = await blobGet(st, deviceKey(dv.id));
  const dev = (dr.ok && dr.data) ? dr.data : { id: dv.id, status: 'pending', created: now };
  if (dv.label) dev.label = dv.label;
  dev.member_name = member.name; dev.member_id = member.id; dev.last_seen = now;
  if (member.admin) dev.status = 'approved';
  await blobSet(st, deviceKey(dv.id), dev);
  return dev.status;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function memberKey(id) { return `member:${id}`; }
function nameKey(name) { return `name:${String(name).trim().toLowerCase()}`; }
function genId() { return 'u' + crypto.randomBytes(5).toString('hex'); }
function safeMember(m) { if (!m) return null; const { pin_salt, pin_hash, ...s } = m; return s; }
function cleanPerms(p) { const out = {}; MODULES.forEach(function (k) { out[k] = (p && (p[k] === 'do' || p[k] === 'view' || p[k] === 'hide')) ? p[k] : 'view'; }); return out; }

async function listMembers(st) {
  const { blobs } = await st.list({ prefix: 'member:' });
  const out = [];
  for (const b of (blobs || [])) {
    const r = await blobGet(st, b.key);
    if (r.ok && r.data && r.data.del !== 1) out.push(r.data);
  }
  // 연번(seq) 오름차순 → 없는 항목은 뒤로, 동률은 이름순
  out.sort(function (a, b) {
    const sa = (typeof a.seq === 'number') ? a.seq : 1e9;
    const sb = (typeof b.seq === 'number') ? b.seq : 1e9;
    if (sa !== sb) return sa - sb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return out;
}

// 세션 → 현재 회원(최신 perms 포함). { ok, member } 또는 { ok:false }
async function currentMember(st, event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(st, memberKey(v.payload.mid));
  if (!r.ok || !r.data || r.data.del === 1) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}

async function handleBootstrap(st, d, R) {
  // 회원이 하나도 없을 때만: 최초 관리자 생성(무인증). 이후엔 거부.
  const existing = await listMembers(st);
  if (existing.length > 0) return jr(409, { status: 'REJECTED', error_code: 'ALREADY_INITIALIZED', request_id: R });
  const name = (d.name || '').trim();
  const pin = (d.pin || '').trim();
  if (!name || !validSecret(pin, true)) return jr(400, { status: 'REJECTED', error_code: 'WEAK_SECRET', request_id: R });
  const { salt, hash } = hashSecret(pin);
  const m = { id: genId(), name, role: '대표', admin: true, perms: cleanPerms({ tasks: 'do', veh: 'do', rec: 'do', lic: 'do', check: 'do' }), pin_salt: salt, pin_hash: hash, created: Date.now(), updated: Date.now() };
  const w1 = await blobSet(st, memberKey(m.id), m);
  const w2 = await blobSet(st, nameKey(m.name), m.id);
  if (!w1.ok || !w2.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  const s = issueSession(m);
  return jr(200, { status: 'OK', token: s.token, expires_at: s.expires_at, member: safeMember(m), request_id: R });
}

async function handleLogin(st, d, R, event) {
  const GEN = () => jr(401, { status: 'UNAUTHORIZED', error_code: 'INVALID_CREDENTIALS', request_id: R });
  const name = (d.name || '').trim();
  const pin = (d.pin || '').trim();
  if (!name || !pin) return GEN();
  const now = Date.now();
  const lk = await blobGet(st, lockKey(name));
  if (lk.ok && lk.data && lk.data.until && lk.data.until > now) {
    return jr(429, { status: 'LOCKED', error_code: 'TOO_MANY_ATTEMPTS', retry_after: Math.ceil((lk.data.until - now) / 1000), request_id: R });
  }
  async function fail() {
    const fails = (lk.ok && lk.data && lk.data.fails ? lk.data.fails : 0) + 1;
    const rec = fails >= LOCK_THRESHOLD ? { fails: 0, until: now + LOCK_MS } : { fails: fails };
    await blobSet(st, lockKey(name), rec);
    return GEN();
  }
  const idx = await blobGet(st, nameKey(name));
  if (!idx.ok) return jr(500, { status: 'ERROR', error_code: idx.code, request_id: R });
  if (!idx.data) return fail();
  const mr = await blobGet(st, memberKey(idx.data));
  if (!mr.ok) return jr(500, { status: 'ERROR', error_code: mr.code, request_id: R });
  if (!mr.data || mr.data.del === 1) return fail();
  if (!verifySecret(pin, mr.data.pin_salt, mr.data.pin_hash)) return fail();
  if (lk.ok && lk.data) await blobSet(st, lockKey(name), null);  // 성공 → 잠금 해제
  const deviceStatus = await registerDevice(st, event, mr.data);
  const s = issueSession(mr.data);
  if (!s.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: s.code, request_id: R });
  return jr(200, { status: 'OK', token: s.token, expires_at: s.expires_at, member: safeMember(mr.data), device_status: deviceStatus, request_id: R });
}

async function handleVerify(st, event, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { valid: false, reason: c.reason, request_id: R });
  const device_status = await registerDevice(st, event, c.member);
  return jr(200, { valid: true, member: safeMember(c.member), device_status: device_status, request_id: R });
}

async function handleMemberList(st, event, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: 'NO_SESSION', request_id: R });
  // 회원 목록(이름·역할, pin 제외 safeMember)은 담당 배정 드롭다운용으로 로그인 회원 누구나 조회 가능
  const members = (await listMembers(st)).map(safeMember);
  return jr(200, { status: 'OK', members, request_id: R });
}

async function handleMemberUpsert(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const name = (d.name || '').trim();
  let m;
  if (d.id) {
    // 기존 회원: 부분 업데이트 허용. 전달된 필드만 갱신(name/role/admin 미전달 시 기존값 보존)
    const r = await blobGet(st, memberKey(d.id));
    if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
    m = r.data;
    if (name && m.name !== name) { await blobSet(st, nameKey(m.name), null); m.name = name; }
    if (d.role !== undefined) m.role = d.role || m.role || '직원';
    if (d.admin !== undefined) m.admin = !!d.admin;
  } else {
    // 신규 회원: 이름 필수, role/admin 기본값
    if (!name) return jr(400, { status: 'REJECTED', error_code: 'INVALID_INPUT', request_id: R });
    m = { id: genId(), name, created: Date.now() };
    m.role = (d.role || '직원');
    m.admin = !!d.admin;
  }
  if (d.rank !== undefined) m.rank = String(d.rank || '');
  if (d.dept !== undefined) m.dept = String(d.dept || '');
  if (d.annual_days !== undefined) { m.annual_days = (d.annual_days === null || isNaN(Number(d.annual_days))) ? null : Number(d.annual_days); }
  if (d.hire_date !== undefined) m.hire_date = String(d.hire_date || '');
  if (d.emp_type !== undefined) m.emp_type = String(d.emp_type || '');
  if (d.annual_basis !== undefined) m.annual_basis = (d.annual_basis === 'fiscal' ? 'fiscal' : 'hire');
  if (d.loa_days !== undefined) m.loa_days = isNaN(Number(d.loa_days)) ? 0 : Number(d.loa_days);
  if (d.leave_date !== undefined) m.leave_date = String(d.leave_date || '');
  if (d.annual_paid !== undefined) m.annual_paid = !!d.annual_paid;
  if (d.annual_base !== undefined) { m.annual_base = (d.annual_base === null || isNaN(Number(d.annual_base))) ? null : Number(d.annual_base); }
  if (d.annual_base_date !== undefined) m.annual_base_date = String(d.annual_base_date || '');
  if (d.seq !== undefined) { m.seq = (d.seq === null || isNaN(Number(d.seq))) ? null : Number(d.seq); }
  if (d.on_loa !== undefined) m.on_loa = !!d.on_loa;
  if (d.loa_start !== undefined) m.loa_start = String(d.loa_start || '');
  if (d.loa_end !== undefined) m.loa_end = String(d.loa_end || '');
  m.perms = cleanPerms(d.perms || m.perms);
  m.updated = Date.now();
  if (d.pin) {
    const pinStr = String(d.pin).trim();
    if (!validSecret(pinStr, m.admin)) return jr(400, { status: 'REJECTED', error_code: 'WEAK_SECRET', request_id: R });
    const h = hashSecret(pinStr); m.pin_salt = h.salt; m.pin_hash = h.hash;
  }
  const w1 = await blobSet(st, memberKey(m.id), m);
  const w2 = await blobSet(st, nameKey(m.name), m.id);
  if (!w1.ok || !w2.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  return jr(200, { status: 'OK', member: safeMember(m), request_id: R });
}

async function handleMemberDelete(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (!d.id || d.id === c.member.id) return jr(400, { status: 'REJECTED', error_code: 'INVALID_INPUT', request_id: R });
  const r = await blobGet(st, memberKey(d.id));
  if (r.ok && r.data) { r.data.del = 1; r.data.updated = Date.now(); await blobSet(st, memberKey(d.id), r.data); await blobSet(st, nameKey(r.data.name), null); }
  return jr(200, { status: 'OK', request_id: R });
}

async function handleSetPin(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: 'NO_SESSION', request_id: R });
  const targetId = d.id && c.member.admin ? d.id : c.member.id;  // 본인 또는 관리자가 지정
  const pin = (d.pin || '').trim();
  const r = await blobGet(st, memberKey(targetId));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  if (!validSecret(pin, !!r.data.admin)) return jr(400, { status: 'REJECTED', error_code: 'WEAK_SECRET', request_id: R });
  const h = hashSecret(pin);
  r.data.pin_salt = h.salt; r.data.pin_hash = h.hash; r.data.updated = Date.now();
  const w = await blobSet(st, memberKey(targetId), r.data);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  return jr(200, { status: 'OK', request_id: R });
}

async function handleDeviceList(st, event, R) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const { blobs } = await st.list({ prefix: 'device:' });
  const out = [];
  for (const b of (blobs || [])) { const r = await blobGet(st, b.key); if (r.ok && r.data) out.push(r.data); }
  return jr(200, { status: 'OK', devices: out, request_id: R });
}
async function handleDeviceSet(st, event, d, R, status) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const id = String(d.device || '').trim();
  if (!id) return jr(400, { status: 'REJECTED', error_code: 'INVALID_INPUT', request_id: R });
  if (status === null) { await blobSet(st, deviceKey(id), null); return jr(200, { status: 'OK', request_id: R }); }
  const r = await blobGet(st, deviceKey(id));
  const dev = (r.ok && r.data) ? r.data : { id: id, created: Date.now() };
  dev.status = status; dev.updated = Date.now();
  await blobSet(st, deviceKey(id), dev);
  return jr(200, { status: 'OK', request_id: R });
}

// 데이터 리셋(테스트 정리용). env GW_ALLOW_RESET='1' 일 때만. gw_users + gw_data 전체 삭제.
async function handleReset(R) {
  if (process.env.GW_ALLOW_RESET !== '1') return jr(403, { status: 'FORBIDDEN', error_code: 'RESET_DISABLED', request_id: R });
  const { blobDelete } = require('./_lib/blobs');
  let n = 0;
  for (const storeName of [USERS, 'gw_data']) {
    const st = store(storeName);
    const { blobs } = await st.list();
    for (const b of (blobs || [])) { await blobDelete(st, b.key); n++; }
  }
  return jr(200, { status: 'OK', deleted: n, request_id: R });
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { status: 'REJECTED', error_code: 'INVALID_JSON', request_id: R }); }
  const st = store(USERS);
  try {
    switch (d && d.action) {
      case 'reset': return await handleReset(R);
      case 'bootstrap': return await handleBootstrap(st, d, R);
      case 'names': { const ms = await listMembers(st); return jr(200, { status: 'OK', names: ms.map(function (m) { return m.name; }), count: ms.length, request_id: R }); }
      case 'login': return await handleLogin(st, d, R, event);
      case 'verify': return await handleVerify(st, event, R);
      case 'device_list': return await handleDeviceList(st, event, R);
      case 'device_approve': return await handleDeviceSet(st, event, d, R, 'approved');
      case 'device_revoke': return await handleDeviceSet(st, event, d, R, 'pending');
      case 'device_delete': return await handleDeviceSet(st, event, d, R, null);
      case 'member_list': return await handleMemberList(st, event, R);
      case 'member_upsert': return await handleMemberUpsert(st, event, d, R);
      case 'member_delete': return await handleMemberDelete(st, event, d, R);
      case 'set_pin': return await handleSetPin(st, event, d, R);
      default: return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
