'use strict';
// 홍보 사진 가리기(모자이크) — 사용자 API. v354(PM 2026-09-13 "모자이크 착수").
//   mask_start {promo_id, force?}  → 기록의 사진 전부 자동 감지·픽셀화(백그라운드 워커), 202+job
//   mask_job   {job}               → 진행 상황
//   mask_state {promo_id}          → 사진별 가림 상태 [{id, has, boxes, auto, human}] (검수 화면 배지)
//   mask_get   {att_id}            → 편집용: 원본 크기·상자 목록(원본 이미지는 gw-data att_get raw:true 로)
//   mask_apply {att_id, boxes}     → 사람이 정한 상자로 원본에서 다시 픽셀화(동기 — 한 장 1~3초)
//   mask_clear {att_id}            → 가림 제거(원본 그대로 노출) — 관리자 또는 홍보 do
// 권한은 gw-promo-ai와 같은 문(promo 'do'). 원본 첨부는 절대 바꾸지 않는다 — 가린 판은 gw_files 'mask:<att_id>'.
// 공개 서빙(gw-promo-img)·검수 격자(att_get)·갤러리·AI 초안 워커는 mask가 있으면 mask를 먼저 본다(v354).
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet, blobDelete } = require('./_lib/blobs');
const { issueSession, verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const M = require('./_lib/promomask');

const DATA = 'gw_data';
const USERS = 'gw_users';
const FILES = 'gw_files';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function jobKey(id) { return `promomask:job:${id}`; }
function lockKey(promoId) { return `promomask:lock:${promoId}`; }
const RE_JOB = /^pm_[a-z0-9_-]{1,60}$/i;
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const RE_ATT = /^att_[a-f0-9]{16}$/i;
const LOCK_TTL_MS = 10 * 60 * 1000;
const MAX_PHOTOS = 40;

function kstDate() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
function retired(m) { const ld = m && m.leave_date; return !!ld && String(ld) < kstDate(); }
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}
function promoPerm(member) { if (member && member.admin) return 'do'; return (member && member.perms && member.perms.promo) || 'hide'; }
function newJobId() { return 'pm_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function envReady() { return !!process.env.GW_ANTHROPIC_KEY; }

async function kickBackground(job, promoId, ids, force) {
  const s = issueSession({ id: '__promomask__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-promo-mask-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, promo_id: promoId, ids: ids, force: !!force }),
    });
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) { return { ok: false, code: 'KICKOFF_FAILED' }; }
}

async function promoPhotoIds(st, promoId) {
  const pr = await blobGet(st, 'col:promo');
  if (!pr.ok) return { err: pr.code };
  const items = (pr.data && Array.isArray(pr.data.items)) ? pr.data.items : [];
  const rec = items.filter(function (it) { return it && it.id === promoId && it.del !== 1; })[0] || null;
  if (!rec) return { err: 'PROMO_NOT_FOUND', status: 404 };
  const seen = Object.create(null), ids = [];
  (Array.isArray(rec.photos) ? rec.photos : []).forEach(function (p) {
    const id = String((p && p.id) || '').trim();
    if (RE_ATT.test(id) && !seen[id]) { seen[id] = 1; ids.push(id); }
  });
  return { ids: ids.slice(0, MAX_PHOTOS), total: ids.length };
}

async function handleStart(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  if (!envReady()) return jr(400, { ok: false, code: 'ENV_MISSING', request_id: R });
  const promoId = String(d.promo_id || '').trim();
  if (!RE_REC_ID.test(promoId)) return jr(400, { ok: false, code: 'BAD_PROMO_ID', request_id: R });
  const ph = await promoPhotoIds(st, promoId);
  if (ph.err) return jr(ph.status || 500, { ok: false, code: ph.err, request_id: R });
  if (!ph.ids.length) return jr(400, { ok: false, code: 'NO_PHOTOS', request_id: R });
  const lk = await blobGet(st, lockKey(promoId));
  if (lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < LOCK_TTL_MS) return jr(409, { ok: false, code: 'ALREADY_RUNNING', job: String(lk.data.job || ''), request_id: R });
  const job = newJobId();
  await blobSet(st, lockKey(promoId), { ts: Date.now(), job: job });
  const base = { ts: Date.now(), by: c.member.name, promo_id: promoId, n: ph.ids.length, done: 0, photos: [] };
  await blobSet(st, jobKey(job), Object.assign({ status: 'queued' }, base));
  const k = await kickBackground(job, promoId, ph.ids, d.force === true);
  if (!k.ok) {
    await blobSet(st, jobKey(job), Object.assign({ status: 'fail', code: k.code }, base));
    try { await blobSet(st, lockKey(promoId), { ts: 0, job: '' }); } catch (e) {}
    return jr(500, { ok: false, code: k.code, request_id: R });
  }
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '사진가리기', id: job, t: promoId + ' · 사진 ' + ph.ids.length + '장' + (d.force === true ? ' (다시)' : '') }] }); } catch (e) {}
  return jr(202, { ok: true, job: job, n: ph.ids.length, request_id: R });
}

async function handleJob(st, c, d, R) {
  if (promoPerm(c.member) === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', request_id: R });
  const job = String(d.job || '').trim();
  if (!RE_JOB.test(job)) return jr(400, { ok: false, code: 'BAD_JOB', request_id: R });
  const r = await blobGet(st, jobKey(job));
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  if (!r.data) return jr(404, { ok: false, code: 'JOB_NOT_FOUND', request_id: R });
  return jr(200, Object.assign({ ok: true, request_id: R }, r.data));
}

// 사진별 가림 상태 — 검수 화면 배지용. 이미지 데이터는 싣지 않는다(가벼운 조회).
async function handleState(st, c, d, R) {
  if (promoPerm(c.member) === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', request_id: R });
  const promoId = String(d.promo_id || '').trim();
  if (!RE_REC_ID.test(promoId)) return jr(400, { ok: false, code: 'BAD_PROMO_ID', request_id: R });
  const ph = await promoPhotoIds(st, promoId);
  if (ph.err) return jr(ph.status || 500, { ok: false, code: ph.err, request_id: R });
  const fst = store(FILES), out = [];
  for (const id of ph.ids) {
    const r = await blobGet(fst, M.maskKey(id));
    if (r.ok && r.data) {
      const boxes = Array.isArray(r.data.boxes) ? r.data.boxes : [];
      out.push({ id: id, has: true, boxes: boxes.length, human: boxes.some(function (b) { return b && b.by === 'human'; }), auto: r.data.auto === true, ts: r.data.ts || 0 });
    } else out.push({ id: id, has: false, boxes: 0, human: false, auto: false, ts: 0 });
  }
  const lk = await blobGet(st, lockKey(promoId));
  const running = !!(lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < LOCK_TTL_MS);
  return jr(200, { ok: true, items: out, running: running, job: running ? String(lk.data.job || '') : '', request_id: R });
}

async function handleGet(st, c, d, R) {
  if (promoPerm(c.member) === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', request_id: R });
  const id = String(d.att_id || '').trim();
  if (!RE_ATT.test(id)) return jr(400, { ok: false, code: 'BAD_ID', request_id: R });
  const r = await blobGet(store(FILES), M.maskKey(id));
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  if (!r.data) return jr(200, { ok: true, has: false, boxes: [], w: 0, h: 0, request_id: R });
  return jr(200, { ok: true, has: true, boxes: M.cleanBoxes(r.data.boxes), w: Number(r.data.w) || 0, h: Number(r.data.h) || 0, auto: r.data.auto === true, request_id: R });
}

// 사람이 정한 상자로 원본에서 다시 픽셀화. 상자가 0개면 '가릴 것 없음'으로 저장(자동이 다시 덮지 않게 human 표시 유지).
async function handleApply(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const id = String(d.att_id || '').trim();
  if (!RE_ATT.test(id)) return jr(400, { ok: false, code: 'BAD_ID', request_id: R });
  if (!Array.isArray(d.boxes)) return jr(400, { ok: false, code: 'BAD_BOXES', request_id: R });
  const boxes = M.cleanBoxes(d.boxes).map(function (b) { b.by = 'human'; return b; });
  const fst = store(FILES);
  const r = await blobGet(fst, id);
  if (!r.ok || !r.data) return jr(404, { ok: false, code: 'NOT_FOUND', request_id: R });
  if (r.data.kind !== 'promo') return jr(403, { ok: false, code: 'NOT_PROMO', request_id: R });
  let buf;
  try { buf = Buffer.from(String(r.data.data || ''), 'base64'); } catch (e) { return jr(400, { ok: false, code: 'BAD_IMAGE', request_id: R }); }
  let out = null, size = { w: 0, h: 0 };
  try { size = await M.imageSize(buf); out = boxes.length ? await M.applyBoxes(buf, boxes) : null; } catch (e) { return jr(500, { ok: false, code: 'PIXELATE_FAILED', request_id: R }); }
  const w = await blobSet(fst, M.maskKey(id), { schema: 1, src: id, name: r.data.name, type: 'image/jpeg', kind: 'promo', auto: false, boxes: boxes,
    w: size.w, h: size.h, data: out ? out.toString('base64') : '', by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { ok: false, code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '가리기수정', id: id.slice(0, 30), t: '상자 ' + boxes.length + '개' }] }); } catch (e) {}
  return jr(200, { ok: true, boxes: boxes.length, masked: !!out, request_id: R });
}

async function handleClear(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const id = String(d.att_id || '').trim();
  if (!RE_ATT.test(id)) return jr(400, { ok: false, code: 'BAD_ID', request_id: R });
  await blobDelete(store(FILES), M.maskKey(id));
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '가리기해제', id: id.slice(0, 30), t: '' }] }); } catch (e) {}
  return jr(200, { ok: true, request_id: R });
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { ok: false, code: 'INVALID_JSON', request_id: R }); }
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { ok: false, code: c.reason || 'NO_SESSION', request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { ok: false, code: 'DEVICE_NOT_APPROVED', request_id: R });
  const st = store(DATA);
  try {
    switch (d && d.action) {
      case 'mask_start': return await handleStart(st, c, d, R);
      case 'mask_job': return await handleJob(st, c, d, R);
      case 'mask_state': return await handleState(st, c, d, R);
      case 'mask_get': return await handleGet(st, c, d, R);
      case 'mask_apply': return await handleApply(st, c, d, R);
      case 'mask_clear': return await handleClear(st, c, d, R);
      default: return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
