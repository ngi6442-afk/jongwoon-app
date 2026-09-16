'use strict';
// 사진AI(블로그 초안·태그) 자동 생성 감독 크론 — netlify.toml schedule = "*/10 * * * *" (10분마다). v360(PM 2026-09-16 "근본적으로").
// 하는 일(모두 서버, 브라우저 없이):
//   ① 끝났는데 기록에 안 실린 작업(옛 워커·브라우저 닫힘)을 job blob에서 찾아 기록에 적용
//   ② 사진은 있는데 초안이 없는 게시 전 기록을 골라 다시 시작(잠금·진행 중·재시도 간격 10/30/120분·상한 4회 준수, 회차당 최대 3건)
// 상태는 기록의 ai_st(running/fail/done, tries, code)로 남겨 카드가 말로 보여준다. 게시 완료 기록은 손대지 않는다.
const { setupBlobContext, store, blobGet, blobList } = require('./_lib/blobs');
const PJ = require('./_lib/promoai_job');

const DATA = 'gw_data';
const MAX_KICKS = 3;          // 회차당 시작 상한(비용·동시성)
const MAX_JOB_SCAN = 80;      // job blob 훑기 상한

async function applyDoneJobs(st, doc, now) {
  // 기록별 최신 done job을 찾아 적용(ai 없는 기록만). job blob은 promoai:job:pa_gen_<base36 ts>_<hex> — 키의 ts로 최신순.
  const items = Array.isArray(doc.items) ? doc.items : [];
  const need = Object.create(null);
  for (const r of items) { if (r && r.del !== 1 && !r.ai && PJ.pickPhotoIds(r).total) need[r.id] = 1; }
  if (!Object.keys(need).length) return { applied: 0, scanned: 0 };
  const l = await blobList(st, 'promoai:job:');
  if (!l.ok) return { applied: 0, scanned: 0, error: l.code || 'LIST_FAILED' };
  const keys = (l.keys || []).filter(function (k) { return k.indexOf('promoai:job:') === 0; }).sort().reverse().slice(0, MAX_JOB_SCAN);
  let applied = 0, scanned = 0;
  const seen = Object.create(null);
  for (const k of keys) {
    const r = await blobGet(st, k);
    scanned++;
    if (!r.ok || !r.data) continue;
    const j = r.data;
    const pid = String(j.promo_id || '');
    if (!need[pid] || seen[pid]) continue;
    if (j.status !== 'done' || !j.title || !j.body) continue;
    seen[pid] = 1;
    const a = PJ.applyResult(doc, pid, { title: j.title, body: j.body, tags: j.tags, model: j.model, tokens: j.used_tokens, tt: j.title_type, job: k.slice('promoai:job:'.length) }, now);
    if (a.changed) applied++;
  }
  return { applied: applied, scanned: scanned };
}

exports.handler = async function (event) {
  const now = Date.now();
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  const pr = await blobGet(st, 'col:promo');
  if (!pr.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: pr.code || 'PROMO_READ_FAILED' }) };
  const doc = (pr.data && typeof pr.data === 'object') ? pr.data : { schema: 1, items: [] };
  if (!Array.isArray(doc.items)) doc.items = [];

  // ① 끝났는데 안 실린 결과 적용 — 바뀐 게 있으면 한 번에 저장
  const ap = await applyDoneJobs(st, doc, now);
  if (ap.applied) {
    doc.updated_at = now;
    const { blobSet } = require('./_lib/blobs');
    const w = await blobSet(st, 'col:promo', doc);
    if (!w.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: w.code || 'PROMO_WRITE_FAILED', applied: ap.applied }) };
  }

  // ② 다시 시작할 기록 — 잠금은 기록마다 읽는다(후보만)
  const cand0 = PJ.pickCandidates(doc.items, now, {});
  const locks = {};
  for (const c of cand0) {
    const lk = await blobGet(st, PJ.lockKey(c.rec.id));
    if (lk.ok && lk.data) locks[c.rec.id] = lk.data;
  }
  const cands = PJ.pickCandidates(doc.items, now, locks).slice(0, MAX_KICKS);
  const started = [], failed = [];
  for (const c of cands) {
    const s = await PJ.startJob(st, { promoId: c.rec.id, contractId: c.rec.contract_id || '', by: '자동(서버 재시도 ' + c.why + ')', promoItems: doc.items });
    if (s.ok) started.push({ id: c.rec.id, job: s.job, why: c.why });
    else {
      failed.push({ id: c.rec.id, code: s.code, why: c.why });
      // 기동 자체가 실패하면(사이트 URL·세션 설정·월 상한) 기록에 남겨 카드가 이유를 보이게 — 재시도 간격도 이 ts부터 센다
      try { await PJ.updatePromo(st, c.rec.id, function (r) { PJ.setAiState(r, 'fail', { code: s.code }, now); return {}; }, now); } catch (e) {}
      if (s.code === 'BUDGET_CAP') break;   // 상한이면 더 볼 것 없다
    }
  }
  const out = { ok: true, at: new Date(now).toISOString(), applied: ap.applied, scanned: ap.scanned, candidates: cand0.length, started: started, failed: failed };
  console.log('[사진AI 크론] ' + JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
