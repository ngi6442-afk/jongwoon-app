'use strict';
// 아침 음성 브리핑 워커(체크 38 D1, v416) — Netlify Background Function(15분 한도).
// gw-brief-cron(예약)·gw-data brief_run(관리자 [지금 1회 생성])이 내부 토큰(mid='__brief__')으로만 기동한다. 즉시 202, 결과는 brief:job:last·brief:day:<날짜>.
// 키는 _lib/brief.js가 환경변수에서 읽어 헤더로만 보낸다 — 여기 로그·잡 블롭에 값이 남지 않는다.
const { setupBlobContext, store, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { stamp } = require('./_lib/cronstamp');
const BRIEF = require('./_lib/brief');

const DATA = 'gw_data';
const RE_JOB = /^brief_[a-z0-9_-]{1,60}$/i;

exports.handler = async function (event, context) {
  const v = verifyToken(bearer(event));
  if (!v.ok || v.payload.mid !== '__brief__') return;
  let d = {};
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
  const job = String(d.job || '').trim();
  if (!RE_JOB.test(job)) return;
  const by = String(d.by || 'cron').slice(0, 40);
  const force = d.force === true;
  let st;
  try { setupBlobContext(event, context); st = store(DATA); } catch (e) { return; }
  const rec = { ts: Date.now(), job: job, by: by, force: force, status: 'running' };
  await blobSet(st, 'brief:job:last', rec);
  try {
    const r = await BRIEF.generate(st, { force: force, by: by });
    rec.status = r.ok ? 'done' : 'fail'; rec.ts = Date.now();
    rec.skipped = r.skipped || ''; rec.code = r.code || '';
    if (r.doc) rec.summary = { date: r.doc.date, mode: r.doc.mode, reason: r.doc.reason, len: r.doc.len, mp3: !!(r.doc.mp3 && r.doc.mp3.ok), mp3_reason: (r.doc.mp3 && r.doc.mp3.reason) || '', ms: r.doc.ms || 0 };
    await blobSet(st, 'brief:job:last', rec);
    if (by === 'cron') await stamp('gw-brief-cron', { state: 'end', ok: r.ok, note: (r.skipped ? 'skipped ' + r.skipped : (rec.summary ? (rec.summary.mode + (rec.summary.mp3 ? ' · mp3' : ' · mp3 없음(' + rec.summary.mp3_reason + ')')) : (r.code || ''))).slice(0, 80) });
  } catch (e) {
    rec.status = 'fail'; rec.ts = Date.now(); rec.code = String((e && e.message) || e).slice(0, 60);
    try { await blobSet(st, 'brief:job:last', rec); } catch (e2) {}
    if (by === 'cron') await stamp('gw-brief-cron', { state: 'end', ok: false, note: rec.code });
  }
};
