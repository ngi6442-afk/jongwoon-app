'use strict';
// 사진AI(블로그 초안·태그) 작업의 공용 층 — v360(PM 2026-09-16 "틀어막지 말고 근본적으로").
//
// 문제였던 구조: 생성 시작과 결과 적용을 "기록을 저장한 사람의 브라우저"가 했다(paKick → 폴링 → paApplyToRecord).
//   브라우저가 닫히거나(폰에서 등록 뒤 화면 끔), 대기열이 메모리에서 사라지거나(9/7), 서버의 모델 호출이 한 번 끊기면(9/16 08:58 NETWORK)
//   아무도 다시 하지 않고 카드에는 "사진AI 미생성"만 남았다. 세 번째 같은 사고.
// 바뀐 구조: ① 워커가 끝나면 결과를 **기록(col:promo)에 직접 쓴다**(브라우저 불필요) ② 실패·진행 상태를 기록의 ai_st에 남겨 카드가 말로 보여준다
//   ③ 크론(gw-promo-ai-cron, 10분)이 "사진은 있는데 초안이 없는 기록"을 찾아 서버가 다시 시작한다(재시도 4회, 10·30·120분 간격) ④ 완료됐는데 적용 안 된 옛 작업도 크론이 적용.
//   브라우저의 즉시 시작(paKick)은 빠른 길로 남긴다 — 없어도 크론이 끝까지 간다.
const crypto = require('crypto');
const { blobGet, blobSet } = require('./blobs');
const { issueSession } = require('./session');

const USAGE_KEY = 'promoai:usage';
const MAX_PHOTOS = 30;                     // 비용 상한(계약서 A절) — 초과분은 앞 30장만
const LOCK_TTL_MS = 5 * 60 * 1000;         // 같은 기록 동시 생성 잠금(워커가 죽어도 5분 뒤 만료)
const MONTH_CALL_CAP = 500;                // 월 호출 상한 — 넘으면 조용히 줄이지 않고 거부(사람이 볼 일)
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const RE_ATT = /^att_[a-f0-9]{16}$/i;
const RETRY_MIN = [0, 10, 30, 120];        // n번째 실패 뒤 다시 시도까지의 간격(분): 즉시 → 10분 → 30분 → 2시간
const MAX_TRIES = 4;                       // 그 뒤로는 사람이 카드에서 버튼으로(카드에 이유가 적혀 있다)
const RUNNING_STALE_MS = 15 * 60 * 1000;   // 'running'이 15분 넘게 그대로면 워커가 죽은 것으로 보고 다시 시도(워커 생성 상한 10분 + 여유)
const AUTO_STATUSES = { review: 1, rejected: 1, approved: 1 };   // 게시 완료(posted)는 손대지 않는다

function jobKey(id) { return `promoai:job:${id}`; }
function lockKey(promoId) { return `promoai:lock:${promoId}`; }
function kstDate(ts) { return new Date((ts || Date.now()) + 9 * 3600000).toISOString().slice(0, 10); }
function kstMonth(ts) { return kstDate(ts).slice(0, 7); }
function newJobId() { return 'pa_gen_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }

function monthUsage(doc, month) {
  const m = (doc && doc.months && doc.months[month]) || {};
  const n = function (v) { const x = Number(v); return (Number.isFinite(x) && x >= 0) ? Math.floor(x) : 0; };
  return { month: month, calls: n(m.calls), total: n(m.total) };
}

function pickPhotoIds(rec) {
  const raw = (rec && Array.isArray(rec.photos)) ? rec.photos : [];
  const seen = Object.create(null);
  const ids = [];
  for (const p of raw) {
    const id = String((p && p.id) || '').trim();
    if (!RE_ATT.test(id) || seen[id]) continue;
    seen[id] = 1;
    ids.push(id);
  }
  return { total: ids.length, use: ids.slice(0, MAX_PHOTOS) };
}

// 기록의 자동 생성 상태 — 카드가 읽어 말로 보여준다. running은 시도 횟수를 올린다(재시도 간격·상한의 기준).
function setAiState(rec, st, extra, now) {
  const prev = (rec && rec.ai_st && typeof rec.ai_st === 'object') ? rec.ai_st : {};
  const tries = Number(prev.tries) || 0;
  const o = { st: st, ts: now || Date.now(), tries: st === 'running' ? tries + 1 : tries };
  if (extra && extra.job) o.job = String(extra.job);
  if (extra && extra.code) o.code = String(extra.code).slice(0, 40);
  if (extra && extra.detail) o.detail = String(extra.detail).slice(0, 120);
  rec.ai_st = o;
  return o;
}

// 워커 결과를 기록에 적용(순수 함수) — 앱 paApplyToRecord와 같은 필드 규칙. 이미 적용된(ai 있음) 기록은 건드리지 않는다(멱등).
function applyResult(doc, promoId, res, now) {
  const items = (doc && Array.isArray(doc.items)) ? doc.items : [];
  const rec = items.filter(function (it) { return it && it.id === promoId && it.del !== 1; })[0] || null;
  if (!rec) return { changed: false, why: 'NOT_FOUND' };
  if (rec.ai) return { changed: false, why: 'ALREADY', rec: rec };
  const title = String((res && res.title) || ''), body = String((res && res.body) || '');
  if (!title || !body) return { changed: false, why: 'EMPTY', rec: rec };
  now = now || Date.now();
  if (!rec.pre_ai) rec.pre_ai = { title: String(rec.title || ''), body: String(rec.body || '') };
  rec.title = title;
  rec.body = body;
  const tk = res.tokens;
  rec.ai = { model: String(res.model || ''), tokens: (tk && typeof tk === 'object') ? (Number(tk.total) || 0) : (Number(tk) || 0), ts: now, tt: String(res.tt || ''), by: 'server' };
  if (Array.isArray(res.tags) && res.tags.length) rec.tags = res.tags.slice(0, 25).map(function (t) { return String(t).slice(0, 30); }).filter(Boolean);
  rec.updated = kstDate(now);
  rec.updated_ts = now;   // 앱 mergePromo는 updated_ts가 큰 쪽을 이긴다 — 브라우저의 낡은 사본이 이 적용을 덮지 못하게
  setAiState(rec, 'done', { job: res.job }, now);
  return { changed: true, rec: rec };
}

// 서버가 다시 시작할 기록 고르기(순수 함수). 사진은 있는데 초안이 없고, 게시 전이며, 잠금·진행 중·재시도 간격·상한에 걸리지 않는 것.
function pickCandidates(items, now, locks) {
  now = now || Date.now();
  locks = locks || {};
  const out = [];
  for (const rec of (items || [])) {
    if (!rec || rec.del === 1 || rec.ai) continue;
    if (!AUTO_STATUSES[String(rec.status || 'review')]) continue;
    if (!pickPhotoIds(rec).total) continue;
    const lk = locks[rec.id];
    if (lk && lk.ts && (now - lk.ts) < LOCK_TTL_MS) continue;          // 지금 돌고 있음
    const s = (rec.ai_st && typeof rec.ai_st === 'object') ? rec.ai_st : null;
    let why = 'never';
    if (s) {
      const tries = Number(s.tries) || 0;
      if (s.st === 'running') {
        if ((now - (Number(s.ts) || 0)) < RUNNING_STALE_MS) continue;   // 워커 진행 중
        why = 'stale_running';
      } else if (s.st === 'fail') {
        if (tries >= MAX_TRIES) continue;                                 // 자동 재시도 끝 — 카드에 이유가 적혀 있다
        const waitMin = RETRY_MIN[Math.min(tries, RETRY_MIN.length - 1)];
        if ((now - (Number(s.ts) || 0)) < waitMin * 60000) continue;    // 재시도 간격
        why = 'retry_' + tries;
      } else if (s.st === 'done') {
        why = 'done_not_applied';   // 결과가 기록에 안 실렸다(옛 워커) — 크론이 job에서 적용을 먼저 시도한다
      }
    }
    out.push({ rec: rec, why: why });
  }
  out.sort(function (a, b) { return (Number(a.rec.ts) || 0) - (Number(b.rec.ts) || 0); });
  return out;
}

// col:promo 읽기-수정-쓰기(짧은 창). 바뀐 게 없으면 쓰지 않는다.
async function updatePromo(st, promoId, fn, now) {
  const pr = await blobGet(st, 'col:promo');
  if (!pr.ok) return { ok: false, code: pr.code || 'PROMO_READ_FAILED' };
  const doc = (pr.data && typeof pr.data === 'object') ? pr.data : { schema: 1, items: [] };
  if (!Array.isArray(doc.items)) doc.items = [];
  const rec = doc.items.filter(function (it) { return it && it.id === promoId && it.del !== 1; })[0] || null;
  if (!rec) return { ok: false, code: 'PROMO_NOT_FOUND' };
  const before = JSON.stringify(rec);
  const r = fn(rec, doc) || {};
  if (JSON.stringify(rec) === before) return { ok: true, changed: false, result: r };
  doc.updated_at = now || Date.now();
  const w = await blobSet(st, 'col:promo', doc);
  if (!w.ok) return { ok: false, code: w.code || 'PROMO_WRITE_FAILED' };
  return { ok: true, changed: true, result: r };
}

async function kickBackground(job, promoId, contractId, maxPhotos) {
  const s = issueSession({ id: '__promoai__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-promo-ai-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: 'draft', promo_id: promoId, contract_id: contractId || '', max_photos: maxPhotos }),
    });
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'KICKOFF_FAILED' };
  }
}

// 작업 시작 — 버튼(gw-promo-ai pa_generate)·크론 공용. 검증 → 월 상한 → 잠금 → job 선기록 → 워커 기동.
// 반환 {ok:true, job, photo_n, photo_total, photo_capped} | {ok:false, code, status(HTTP), ...}
async function startJob(st, opts) {
  const promoId = String((opts && opts.promoId) || '').trim();
  const contractId = String((opts && opts.contractId) || '').trim();
  const by = String((opts && opts.by) || '').slice(0, 40);
  if (!RE_REC_ID.test(promoId)) return { ok: false, status: 400, code: 'BAD_PROMO_ID' };
  if (contractId && !RE_REC_ID.test(contractId)) return { ok: false, status: 400, code: 'BAD_CONTRACT_ID' };
  let items = opts && Array.isArray(opts.promoItems) ? opts.promoItems : null;
  if (!items) {
    const pr = await blobGet(st, 'col:promo');
    if (!pr.ok) return { ok: false, status: 500, code: pr.code || 'PROMO_READ_FAILED' };
    items = (pr.data && Array.isArray(pr.data.items)) ? pr.data.items : [];
  }
  const rec = items.filter(function (it) { return it && it.id === promoId && it.del !== 1; })[0] || null;
  if (!rec) return { ok: false, status: 404, code: 'PROMO_NOT_FOUND' };
  const ph = pickPhotoIds(rec);
  if (!ph.use.length) return { ok: false, status: 400, code: 'NO_PHOTOS' };
  if (contractId) {
    const cr = await blobGet(st, 'col:contracts');
    if (!cr.ok) return { ok: false, status: 500, code: cr.code || 'CONTRACT_READ_FAILED' };
    const citems = (cr.data && Array.isArray(cr.data.items)) ? cr.data.items : [];
    if (!citems.some(function (it) { return it && it.id === contractId && it.del !== 1; })) return { ok: false, status: 404, code: 'CONTRACT_NOT_FOUND' };
  }
  const ur = await blobGet(st, USAGE_KEY);
  if (ur.ok) {
    const mu = monthUsage(ur.data, kstMonth());
    if (mu.calls >= MONTH_CALL_CAP) return { ok: false, status: 429, code: 'BUDGET_CAP', usage: mu, month_cap: MONTH_CALL_CAP };
  }
  const lk = await blobGet(st, lockKey(promoId));
  if (lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < LOCK_TTL_MS) {
    return { ok: false, status: 409, code: 'ALREADY_RUNNING', job: String(lk.data.job || '') };
  }
  const job = newJobId();
  await blobSet(st, lockKey(promoId), { ts: Date.now(), job: job });
  const base = { ts: Date.now(), mode: 'draft', by: by, promo_id: promoId, contract_id: contractId,
    photo_n: ph.use.length, photo_total: ph.total, photo_capped: ph.total > ph.use.length };
  await blobSet(st, jobKey(job), Object.assign({ status: 'queued' }, base));
  const k = await kickBackground(job, promoId, contractId, MAX_PHOTOS);
  if (!k.ok) {
    await blobSet(st, jobKey(job), Object.assign({ status: 'fail', code: k.code }, base));
    try { await blobSet(st, lockKey(promoId), { ts: 0, job: '' }); } catch (e) {}
    return { ok: false, status: 500, code: k.code, job: job };
  }
  return { ok: true, job: job, photo_n: ph.use.length, photo_total: ph.total, photo_capped: ph.total > ph.use.length };
}

module.exports = {
  USAGE_KEY, MAX_PHOTOS, LOCK_TTL_MS, MONTH_CALL_CAP, RE_REC_ID, RE_ATT, RETRY_MIN, MAX_TRIES, RUNNING_STALE_MS,
  jobKey, lockKey, kstDate, kstMonth, newJobId, monthUsage, pickPhotoIds, setAiState, applyResult, pickCandidates, updatePromo, kickBackground, startJob,
};
