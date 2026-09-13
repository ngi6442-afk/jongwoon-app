'use strict';
// 홍보 사진 가리기(모자이크) — 사용자 API. v353(PM 2026-09-13 "모자이크 착수") · 적대 검증 반영(9/13 밤).
//   mask_start {promo_id, force?}  → 기록의 사진 전부 자동 감지·픽셀화(백그라운드 워커), 202+job. force = 자동 판만 다시(사람이 손본 판은 유지)
//   mask_job   {job}               → 진행 상황
//   mask_state {promo_id}          → 사진별 가림 상태 [{id, has, boxes, auto, human}] (검수 화면 배지) — 이미지 없이 maskmeta만 읽는다
//   mask_get   {att_id}            → 편집용: 원본 크기·상자 목록(원본 이미지는 gw-data att_get raw:true 로)
//   mask_apply {att_id, boxes}     → 사람이 정한 상자로 원본에서 다시 픽셀화(동기 — 한 장 1~3초). 상자 0개도 사람 판단(human:true)으로 보호
//   mask_clear {att_id}            → 가림 제거(원본 그대로 노출) — 홍보 do
// 권한은 gw-promo-ai와 같은 문(promo 'do'). 원본 첨부는 절대 바꾸지 않는다 — 가린 판은 gw_files 'mask:<att_id>', 상태는 'maskmeta:<att_id>'.
// 월 호출 상한(promomask:usage) — force 반복으로 과금이 새지 않게(적대 검증 #3).
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
const USAGE_KEY = 'promomask:usage';
const RE_JOB = /^pm_[a-z0-9_-]{1,60}$/i;
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const RE_ATT = /^att_[a-f0-9]{16}$/i;
const LOCK_TTL_MS = 15 * 60 * 1000;     // 워커 12분 예산 + 여유(워커가 사진마다 ts를 갱신한다)
const MAX_PHOTOS = 40;
const MONTH_CALL_CAP = 1000;            // 비전 호출 월 상한(사진 장수 기준 — 실사용 글 20편 × 20장 = 400)

function kstDate() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
function kstMonth() { return kstDate().slice(0, 7); }
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
function monthCalls(doc) { const m = (doc && doc.months && doc.months[kstMonth()]) || null; const n = Number(m && m.calls); return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0; }

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
async function lockAlive(st, promoId) {
  const lk = await blobGet(st, lockKey(promoId));
  return (lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < LOCK_TTL_MS) ? lk.data : null;
}

async function handleStart(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  if (!envReady()) return jr(400, { ok: false, code: 'ENV_MISSING', request_id: R });
  const promoId = String(d.promo_id || '').trim();
  if (!RE_REC_ID.test(promoId)) return jr(400, { ok: false, code: 'BAD_PROMO_ID', request_id: R });
  const ph = await promoPhotoIds(st, promoId);
  if (ph.err) return jr(ph.status || 500, { ok: false, code: ph.err, request_id: R });
  if (!ph.ids.length) return jr(400, { ok: false, code: 'NO_PHOTOS', request_id: R });
  const ur = await blobGet(st, USAGE_KEY);
  const used = ur.ok ? monthCalls(ur.data) : 0;
  if (used + ph.ids.length > MONTH_CALL_CAP) return jr(429, { ok: false, code: 'BUDGET_CAP', used: used, cap: MONTH_CALL_CAP, request_id: R });
  const alive = await lockAlive(st, promoId);
  if (alive) return jr(409, { ok: false, code: 'ALREADY_RUNNING', job: String(alive.job || ''), request_id: R });
  const job = newJobId();
  await blobSet(st, lockKey(promoId), { ts: Date.now(), job: job });
  // 동시 클릭 방어(적대 검증 #7): 쓰고 나서 다시 읽어 내 job이 아니면 남이 먼저 잡은 것
  const lk2 = await blobGet(st, lockKey(promoId));
  if (!(lk2.ok && lk2.data && lk2.data.job === job)) return jr(409, { ok: false, code: 'ALREADY_RUNNING', job: String((lk2.data && lk2.data.job) || ''), request_id: R });
  const base = { ts: Date.now(), by: c.member.name, promo_id: promoId, n: ph.ids.length, done: 0, photos: [] };
  await blobSet(st, jobKey(job), Object.assign({ status: 'queued' }, base));
  const k = await kickBackground(job, promoId, ph.ids, d.force === true);
  if (!k.ok) {
    await blobSet(st, jobKey(job), Object.assign({ status: 'fail', code: k.code }, base));
    try { await blobSet(st, lockKey(promoId), { ts: 0, job: '' }); } catch (e) {}
    return jr(500, { ok: false, code: k.code, request_id: R });
  }
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '사진가리기', id: job, t: promoId + ' · 사진 ' + ph.ids.length + '장' + (d.force === true ? ' (자동 판 다시)' : '') }] }); } catch (e) {}
  return jr(202, { ok: true, job: job, n: ph.ids.length, used: used, cap: MONTH_CALL_CAP, request_id: R });
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

// 사진별 가림 상태 — 검수 화면 배지용. maskmeta(작은 문서)만 읽는다(적대 검증 #12: 이미지 blob 40장 읽기 금지).
async function handleState(st, c, d, R) {
  if (promoPerm(c.member) === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', request_id: R });
  const promoId = String(d.promo_id || '').trim();
  if (!RE_REC_ID.test(promoId)) return jr(400, { ok: false, code: 'BAD_PROMO_ID', request_id: R });
  const ph = await promoPhotoIds(st, promoId);
  if (ph.err) return jr(ph.status || 500, { ok: false, code: ph.err, request_id: R });
  const fst = store(FILES), out = [];
  for (const id of ph.ids) {
    const r = await blobGet(fst, M.metaKey(id));
    if (r.ok && r.data && r.data.has) out.push({ id: id, has: true, boxes: Number(r.data.n) || 0, human: r.data.human === true, auto: r.data.auto === true, ts: r.data.ts || 0 });
    else out.push({ id: id, has: false, boxes: 0, human: false, auto: false, ts: 0 });
  }
  const alive = await lockAlive(st, promoId);
  const ur = await blobGet(st, USAGE_KEY);
  return jr(200, { ok: true, items: out, running: !!alive, job: alive ? String(alive.job || '') : '', used: ur.ok ? monthCalls(ur.data) : null, cap: MONTH_CALL_CAP, request_id: R });
}

async function handleGet(st, c, d, R) {
  if (promoPerm(c.member) === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', request_id: R });
  const id = String(d.att_id || '').trim();
  if (!RE_ATT.test(id)) return jr(400, { ok: false, code: 'BAD_ID', request_id: R });
  const r = await blobGet(store(FILES), M.maskKey(id));
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  if (!r.data) return jr(200, { ok: true, has: false, boxes: [], w: 0, h: 0, request_id: R });
  return jr(200, { ok: true, has: true, boxes: M.cleanBoxes(r.data.boxes), w: Number(r.data.w) || 0, h: Number(r.data.h) || 0, auto: r.data.auto === true, human: r.data.human === true || M.metaOf(r.data).human, request_id: R });
}

// 사람이 정한 상자로 원본에서 다시 픽셀화. 상자 0개 = '가릴 것 없음'도 사람 판단(human:true)이라 자동이 다시 덮지 않는다.
async function handleApply(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const id = String(d.att_id || '').trim();
  if (!RE_ATT.test(id)) return jr(400, { ok: false, code: 'BAD_ID', request_id: R });
  if (!Array.isArray(d.boxes)) return jr(400, { ok: false, code: 'BAD_BOXES', request_id: R });
  const boxes = M.cleanBoxes(d.boxes).map(function (b) { b.by = 'human'; return b; });
  const fst = store(FILES);
  const r = await blobGet(fst, id);
  if (!r.ok || !r.data) return jr(404, { ok: false, code: 'NOT_FOUND', request_id: R });
  const chk = M.checkImageRec(r.data);   // 워커와 같은 검사(kind·형식·용량 — 적대 검증 #4)
  if (chk.err) return jr(chk.err === 'not_promo' ? 403 : 400, { ok: false, code: chk.err.toUpperCase(), request_id: R });
  let out = null;
  try { out = await M.applyBoxes(Buffer.from(chk.data, 'base64'), boxes); } catch (e) { return jr(500, { ok: false, code: 'PIXELATE_FAILED', request_id: R }); }
  const rec = { schema: 1, src: id, name: r.data.name, type: 'image/jpeg', kind: 'promo', auto: false, human: true, boxes: boxes,
    w: out.w, h: out.h, data: out.buf ? out.buf.toString('base64') : '', by: c.member.name, ts: Date.now() };
  const w = await blobSet(fst, M.maskKey(id), rec);
  if (!w.ok) return jr(500, { ok: false, code: w.code, request_id: R });
  await blobSet(fst, M.metaKey(id), M.metaOf(rec));
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '가리기수정', id: id.slice(0, 30), t: '상자 ' + boxes.length + '개' + (boxes.length ? '' : ' (가릴 것 없음)') }] }); } catch (e) {}
  return jr(200, { ok: true, boxes: boxes.length, masked: !!out.buf, request_id: R });
}

async function handleClear(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const id = String(d.att_id || '').trim();
  if (!RE_ATT.test(id)) return jr(400, { ok: false, code: 'BAD_ID', request_id: R });
  const fst = store(FILES);
  const r = await blobGet(fst, M.maskKey(id));
  if (!(r.ok && r.data)) return jr(200, { ok: true, existed: false, request_id: R });   // 없던 것을 지웠다고 기록하지 않는다(적대 검증 #6)
  await blobDelete(fst, M.maskKey(id));
  await blobDelete(fst, M.metaKey(id));
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '가리기해제', id: id.slice(0, 30), t: '원본 노출' }] }); } catch (e) {}
  return jr(200, { ok: true, existed: true, request_id: R });
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
