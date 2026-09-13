'use strict';
// 홍보 사진 가리기 워커 — Netlify Background Function(15분 한도). v354(PM 2026-09-13 "모자이크 착수").
// gw-promo-mask(사용자 API)가 내부 토큰(mid='__promomask__')으로만 기동한다. 호출 즉시 202, 진행·결과는 blob 'promomask:job:<id>' → 앱이 mask_job으로 폴링.
// 사진마다: 원본(att_<id>, gw_files) 읽기 → Claude 비전 좌표 → jimp 픽셀화 → gw_files 'mask:<att_id>' 저장(원본 보존).
//   이미 사람이 손본 가림(by:'human' 상자가 있는 mask)은 자동으로 덮지 않는다(force가 아니면 건너뜀).
// API 키는 GW_ANTHROPIC_KEY 를 여기서만 읽어 detectBoxes 인자로만 흘린다 — 로그·blob·응답에 남기지 않는다(scrub 마지막 방어선).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const M = require('./_lib/promomask');

const DATA = 'gw_data';
const FILES = 'gw_files';
function jobKey(id) { return `promomask:job:${id}`; }
function lockKey(promoId) { return `promomask:lock:${promoId}`; }
const USAGE_KEY = 'promomask:usage';
const RE_JOB = /^pm_[a-z0-9_-]{1,60}$/i;
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const RE_ATT = /^att_[a-f0-9]{16}$/i;
const RE_B64 = /^[A-Za-z0-9+/=\r\n]+$/;
const MAX_PHOTOS = 40;
const MAX_PHOTO_B64 = 1600000;
const IMG_MIME = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
const MAX_LOG_CHARS = 300;

function makeScrub() {
  const secrets = [process.env.GW_ANTHROPIC_KEY].map(function (s) { return s == null ? '' : String(s); }).filter(function (s) { return s.length >= 8; });
  return function scrub(v) {
    let out = (v === null || v === undefined) ? '' : String(v);
    for (const sec of secrets) { if (out.indexOf(sec) >= 0) out = out.split(sec).join('***'); }
    return out.length > MAX_LOG_CHARS ? out.slice(0, MAX_LOG_CHARS) + '…' : out;
  };
}
function mimeOf(rec) {
  const t = String((rec && rec.type) || '').trim().toLowerCase();
  if (IMG_MIME[t]) return t;
  const n = String((rec && rec.name) || '').toLowerCase();
  if (/\.jpe?g$/.test(n)) return 'image/jpeg';
  if (/\.png$/.test(n)) return 'image/png';
  if (/\.webp$/.test(n)) return 'image/webp';
  return '';
}
function kstMonth() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7); }
async function bumpUsage(st, calls, usage) {
  try {
    const r = await blobGet(st, USAGE_KEY);
    const doc = (r.ok && r.data && r.data.months) ? r.data : { schema: 1, months: {} };
    const m = kstMonth();
    const cur = doc.months[m] || { calls: 0, input: 0, output: 0 };
    cur.calls += calls; cur.input += (usage && usage.input) || 0; cur.output += (usage && usage.output) || 0;
    doc.months[m] = cur;
    await blobSet(st, USAGE_KEY, doc);
  } catch (e) { /* 사용량 집계 실패는 본 작업을 바꾸지 않는다 */ }
}

exports.handler = async function (event, context) {
  let st = null, fst = null, job = '', promoId = '', rec = null;
  const scrub = makeScrub();
  const finish = async function (status, code, detail) {
    if (!st || !job || !rec) return;
    rec.status = status;
    if (code) rec.code = code;
    if (detail) rec.detail = scrub(detail);
    rec.ts = Date.now();
    try { await blobSet(st, jobKey(job), rec); } catch (e) {}
  };
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__promomask__') return;
    let d = {};
    try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    job = String(d.job || '').trim();
    promoId = String(d.promo_id || '').trim();
    const force = d.force === true;
    if (!RE_JOB.test(job) || !RE_REC_ID.test(promoId)) return;
    const ids = (Array.isArray(d.ids) ? d.ids : []).map(function (x) { return String(x || '').trim(); }).filter(function (x) { return RE_ATT.test(x); }).slice(0, MAX_PHOTOS);

    st = store(DATA); fst = store(FILES);
    rec = { ts: Date.now(), status: 'running', promo_id: promoId, n: ids.length, done: 0, photos: [] };
    await blobSet(st, jobKey(job), rec);
    if (!process.env.GW_ANTHROPIC_KEY) { await finish('fail', 'ENV_MISSING'); return; }
    const apiKey = process.env.GW_ANTHROPIC_KEY;   // detectBoxes 인자로만 흐른다
    if (!ids.length) { await finish('done', 'NO_PHOTOS'); return; }

    let calls = 0; const usage = { input: 0, output: 0 };
    for (const id of ids) {
      const item = { id: id, boxes: 0, st: '' };
      try {
        const r = await blobGet(fst, id);
        if (!r.ok || !r.data || r.data.kind !== 'promo') { item.st = 'skip:not_promo'; rec.photos.push(item); continue; }
        const mt = mimeOf(r.data), data = String(r.data.data || '');
        if (!mt || !data || !RE_B64.test(data) || data.length > MAX_PHOTO_B64) { item.st = 'skip:bad_image'; rec.photos.push(item); continue; }
        // 사람이 손본 가림은 자동으로 덮지 않는다
        const mr = await blobGet(fst, M.maskKey(id));
        const prev = (mr.ok && mr.data) ? mr.data : null;
        if (prev && !force && Array.isArray(prev.boxes) && prev.boxes.some(function (b) { return b && b.by === 'human'; })) {
          item.st = 'kept:human'; item.boxes = prev.boxes.length; rec.photos.push(item); continue;
        }
        if (prev && !force && prev.auto === true) { item.st = 'kept:auto'; item.boxes = prev.boxes.length; rec.photos.push(item); continue; }
        const det = await M.detectBoxes(apiKey, mt, data);
        calls += 1; if (det.usage) { usage.input += det.usage.input; usage.output += det.usage.output; }
        const boxes = det.boxes.map(function (b) { b.by = 'auto'; return b; });
        item.boxes = boxes.length;
        const buf = Buffer.from(data, 'base64');
        const out = boxes.length ? await M.applyBoxes(buf, boxes) : null;
        const size = await M.imageSize(buf);
        await blobSet(fst, M.maskKey(id), { schema: 1, src: id, name: r.data.name, type: 'image/jpeg', kind: 'promo', auto: true, boxes: boxes,
          w: size.w, h: size.h, data: out ? out.toString('base64') : '', model: det.model, by: '__promomask__', ts: Date.now() });
        item.st = boxes.length ? 'masked' : 'clear';
      } catch (e) {
        item.st = 'fail:' + scrub((e && e.message) || 'ERR');
      }
      rec.photos.push(item);
      rec.done = rec.photos.length;
      try { await blobSet(st, jobKey(job), rec); } catch (e2) {}
    }
    await bumpUsage(st, calls, usage);
    rec.calls = calls;
    await finish('done', '');
  } catch (e) {
    await finish('fail', 'WORKER_THREW', (e && e.message) || '');
  } finally {
    // 자기 job의 잠금만 해제
    try {
      if (st && promoId) {
        const lk = await blobGet(st, lockKey(promoId));
        if (lk.ok && lk.data && lk.data.job === job) await blobSet(st, lockKey(promoId), { ts: 0, job: '' });
      }
    } catch (e) {}
  }
};
