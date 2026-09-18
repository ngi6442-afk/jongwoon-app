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

// 옛 판 재감지(v364): 게시 전 기록의 사진 중 maskmeta.model이 'facedet'로 시작하지 않는(=Claude 단독·v364 이전) 자동 판만 골라 그 사진들만 mask_start(force). 회차당 1건.
//   적대 검증(9/16) 반영: 사람 판(human)은 제외 · 옛 판 사진 id만 워커에(새 판·시간 초과 꼬리 재감지 낭비 없음) · 시도 수는 실제 기동 때만(REMASK_MAX회, 잠금·예산·기동 실패는 안 셈)
//   · 크론은 월 상한의 70%까지만(사람 몫 보호) · 옛 판이 없거나 상한에 닿은 기록은 promomask:remask:<id>.done 표식 → 기록이 바뀌기 전엔 maskmeta를 다시 안 읽는다(10분마다 전수 읽기 방지, 30초 제한)
const REMASK_MAX = 2, REMASK_CAP_RATIO = 0.7, REMASK_PHOTOS = 40;
const REMASK_PAUSE_MS = 6 * 3600000;   // 검출기 장애(det_down)·전역 거부(예산·설정·기동 실패) 뒤 쉬는 시간 — 검증 #6·#8·#12
const REMASK_GLOBAL_KEY = 'promomask:remask';   // 전역 중단 표식 {until, code}
const GLOBAL_CODES = { BUDGET_CAP: 1, ENV_MISSING: 1, NO_SITE_URL: 1, SERVER_CONFIG_MISSING: 1, KICKOFF_FAILED: 1 };
const LOCK_TTL_MS = 15 * 60 * 1000;
const RE_PROMO_ID = /^[A-Za-z0-9_-]{2,48}$/;
async function remaskOld(st, doc, now) {
  const { blobSet } = require('./_lib/blobs');
  const MK = require('./gw-promo-mask');
  if (!MK || typeof MK.startForCron !== 'function') return { skipped: 'no_start' };
  const g = await blobGet(st, REMASK_GLOBAL_KEY);
  if (g.ok && g.data && Number(g.data.until) > now) return { skipped: 'global', code: String(g.data.code || ''), until: Number(g.data.until) };   // 전역 거부 뒤 6시간은 ③ 전체를 쉰다(고아 job·읽기 낭비 방지)
  const fst = store('gw_files');
  const items = (doc.items || []).filter(function (r) { return r && r.del !== 1 && r.status !== 'posted' && Array.isArray(r.photos) && r.photos.length && RE_PROMO_ID.test(String(r.id || '')); });
  let capped = 0, scanned = 0;
  for (const r of items) {
    const tk = 'promomask:remask:' + r.id;
    const tr = await blobGet(st, tk);
    const td = (tr.ok && tr.data && typeof tr.data === 'object') ? tr.data : {};
    const upd = Math.max(Number(r.updated_ts) || 0, Number(r.updated) || 0, Number(r.ts) || 0);
    if (td.done && upd <= Number(td.done)) continue;   // 이미 새 판만(또는 상한) — 기록이 바뀌면 다시 본다
    if (td.det_down && now - Number(td.det_down) < REMASK_PAUSE_MS) continue;   // 검출기 장애 직후 — 6시간 뒤 다시(시도 수는 워커가 되돌려 둠)
    if ((Number(td.fails) || 0) >= REMASK_MAX) continue;   // 기동 실패 상한(기록별) — 기록이 바뀌어도 사람이 [자동 감지 실행]으로 푼다
    const lk = await blobGet(st, 'promomask:lock:' + r.id);
    if (lk.ok && lk.data && Number(lk.data.ts) && now - Number(lk.data.ts) < LOCK_TTL_MS) continue;   // 가리기 작업이 도는 중 — 판이 생기는 중이라 done 표식을 쓰면 안 된다(검증 #1)
    scanned++;
    const old = []; let seen = 0;
    for (const p of r.photos.slice(0, REMASK_PHOTOS)) {
      const id = String((p && p.id) || '');
      if (!id) continue;
      const m = await blobGet(fst, 'maskmeta:' + id);
      if (!m.ok || !m.data) continue;   // 판이 아직 없음 — 저장 뒤 자동 감지가 만든다
      seen++;
      if (m.data.human === true) continue;   // 사람 판은 그대로
      if (!/^facedet/.test(String(m.data.model || ''))) old.push(id);
    }
    const tries = Number(td.tries) || 0;
    const want = r.photos.slice(0, REMASK_PHOTOS).filter(function (p) { return p && p.id; }).length;
    if (!old.length || tries >= REMASK_MAX) {
      if (old.length) capped++;
      // done 표식은 사진마다 판이 다 있을 때(또는 상한)만 — 판이 아직 없는 사진은 다음 회차에 다시 본다(검증 #1: 첫 감지 전 회차에 done을 쓰면 폴백 판이 영영 안 걸린다)
      if (seen === want || tries >= REMASK_MAX) await blobSet(st, tk, Object.assign({}, td, { done: now, old: old.length }));
      continue;
    }
    const s = await MK.startForCron(st, { promoId: r.id, ids: old, force: true, by: '자동(검출기 교체 재감지)', capRatio: REMASK_CAP_RATIO });
    if (s.ok) await blobSet(st, tk, Object.assign({}, td, { ts: now, tries: tries + 1, job: s.job, old: old.length }));
    else if (s.code !== 'ALREADY_RUNNING') {
      if (GLOBAL_CODES[s.code] || /^KICKOFF_/.test(String(s.code))) await blobSet(st, REMASK_GLOBAL_KEY, { until: now + REMASK_PAUSE_MS, code: String(s.code), promo: r.id, ts: now });   // 전역 원인 — ③ 전체 6시간 중단(검증 #6·#12)
      else await blobSet(st, tk, Object.assign({}, td, { fails: (Number(td.fails) || 0) + 1, code: String(s.code), ts: now }));   // 기록 원인(사진 없음 등) — 기록별 상한
    }
    return { promo: r.id, old: old.length, seen: seen, ok: !!s.ok, code: s.code || '', job: s.job || '', tries: s.ok ? tries + 1 : tries, capped: capped, scanned: scanned };
  }
  return { promo: '', old: 0, capped: capped, scanned: scanned };
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
  // ③ v364: 사진 가리기 재감지 — 옛 검출기(Claude 비전 단독) 판이 남은 게시 전 기록을 회차당 1건씩 다시 감지(force=자동 판만, 사람 판 유지). 완료·표시는 maskmeta model에 남는다.
  let remask = null;
  try { remask = await remaskOld(st, doc, now); } catch (e) { remask = { error: (e && e.message) || 'ERR' }; }
  const out = { ok: true, at: new Date(now).toISOString(), applied: ap.applied, scanned: ap.scanned, candidates: cand0.length, started: started, failed: failed, remask: remask };
  console.log('[사진AI 크론] ' + JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
