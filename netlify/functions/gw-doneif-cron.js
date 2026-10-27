'use strict';
// 공통 done_if 워커(공통 기반 2, v397) — netlify.toml schedule "*/10 * * * *". 도메인별 10분 크론 신설 금지(이 함수 하나가 공용).
// settings:doneif.on=false(기본) → 계획만 it:doneif:last에 기록(dry-run, 데이터 불변). on=true → review 전환 + 전환 전 일일 스냅샷 1회 +
// clog:appr 해시 체인 + 감사 '앱기준전환' + 승인권자 1발(배정표 approver_id, 없으면 관리자 전원). 되돌리기 = 지시 카드 [완료요청 취소]/[반려](반려는 신호 끔).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const push = require('./_lib/push');
const audit = require('./_lib/audit');
const D = require('./_lib/doneif');

const DATA = 'gw_data';
function kstToday(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }

async function run(st, nowMs) {
  const today = kstToday(nowMs);
  const sr = await blobGet(st, D.DONEIF_KEY);
  const on = !!(sr.ok && sr.data && sr.data.on === true);
  const tr = await blobGet(st, 'col:tasks');
  const tdoc = (tr.ok && tr.data && Array.isArray(tr.data.items)) ? tr.data : null;
  if (!tdoc) return { ok: false, code: 'NO_TASKS' };
  // 필요한 레코드 컬렉션만 읽는다(자격 있는 자동 지시의 접두어 기준)
  const need = {};
  tdoc.items.forEach(function (t) { if (!D.eligible(t)) return; const k = D.parseKey(t.auto_key); if (k) need[k.col] = true; });
  const recs = {};
  for (const col of Object.keys(need)) {
    const r = await blobGet(st, 'col:' + col);
    recs[col] = D.byId((r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : []);
  }
  const p = D.plan(tdoc.items, recs);
  const last = { ts: nowMs, today: today, on: on, scanned: p.scanned, candidates: p.candidates.slice(0, 50), moved: 0, notified: 0 };
  if (on && p.candidates.length) {
    try {   // 전환 전 문서 일일 스냅샷 1회(ver 링과 별도 키, 되돌리기 재료)
      const sk = 'ver:tasks:appbase:' + today;
      const ex = await blobGet(st, sk);
      if (!ex.ok) await blobSet(st, sk, { ts: nowMs, by: '앱 기준', doc: tdoc });
    } catch (e) {}
    last.moved = D.apply(tdoc.items, p.candidates, today);
    tdoc.updated_by = '앱 기준'; tdoc.updated_at = nowMs;
    const w = await blobSet(st, 'col:tasks', tdoc);
    if (!w.ok) return { ok: false, code: w.code || 'SAVE_FAILED' };
    try {
      const ck = 'clog:appr:' + today.slice(0, 7);
      const cr = await blobGet(st, ck);
      let cd = (cr.ok && cr.data) ? cr.data : null;
      p.candidates.forEach(function (c) { cd = D.clogAppend(cd, { ts: nowMs, id: c.id, f: 'status', from: 'open', to: 'review', why: 'data:' + c.why, by: '앱 기준' }); });
      await blobSet(st, ck, cd);
    } catch (e) {}
    try { await audit.appendAudit({ ts: nowMs, by: '앱 기준', bid: 'bot', col: 'tasks', ev: [{ op: '앱기준전환', id: '', t: '승인 대기 ' + last.moved + '건' }] }); } catch (e) {}
    try {   // 승인권자 1발 — 자동 지시의 승인 축은 배정표 approver_id(없으면 관리자 전원), 우선기기
      const ar = await blobGet(st, 'settings:assign');
      const apv = (ar.ok && ar.data && ar.data.approver_id) ? String(ar.data.approver_id) : '';
      const tc = await push.tierCtx();
      const to = apv ? [apv] : ((tc && tc.adminIds) || []);
      if (to.length) {
        const body = p.candidates.slice(0, 3).map(function (c) { return c.title.slice(0, 28); }).join(' · ') + (p.candidates.length > 3 ? ' 외 ' + (p.candidates.length - 3) + '건' : '') + ' — 지시함 [오늘 승인 일괄]';
        await push.sendTo(to, { title: '승인 대기 ' + last.moved + '건(앱 기준)', body: body.slice(0, 200), url: './', tag: 'task-appbase-' + today }, { ctx: tc, primaryOnly: true, by: '앱 기준' });
        last.notified = to.length;
      }
    } catch (e) {}
  }
  try { await blobSet(st, D.DONEIF_LAST, last); } catch (e) {}
  return Object.assign({ ok: true }, last);
}

exports.run = run;
exports.handler = async function (event) {
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  const r = await run(st, Date.now());
  return { statusCode: r.ok ? 200 : 500, body: JSON.stringify(r) };
};
