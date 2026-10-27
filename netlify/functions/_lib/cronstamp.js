'use strict';
// 크론 실행 흔적 스탬프(공통 기반 14 · infra D0 · 착수 브리핑 A7, v398).
// Netlify 예약 함수가 시작 때 it:cron:<fn>:last 에 {state:'start'}, 끝에 {state:'end', ok, note}를 남긴다(한 문서에 덧씀).
// 저장 실패는 전부 삼킨다 — 흔적이 본 작업을 막으면 안 된다. appdata watch.py가 cron_map evidence type 'stamp'로 신선도를 판정한다.
// 화관법·올바로 크론은 기존 작업 블롭(hwakwan:job:hw_cron_·allbaro:job:ab_cron_)이 흔적이라 여기 안 붙인다.
const { store, blobGet, blobSet } = require('./blobs');

async function stamp(fn, patch) {
  try {
    const st = store('gw_data');
    const key = 'it:cron:' + String(fn) + ':last';
    const r = await blobGet(st, key);
    const cur = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
    const ts = Date.now();
    const doc = Object.assign({ fn: String(fn), runs: 0 }, cur, patch || {}, { ts: ts, day: new Date(ts + 9 * 3600000).toISOString().slice(0, 10) });
    if (patch && patch.state === 'start') { doc.start_ts = ts; doc.ok = null; doc.note = ''; doc.runs = (Number(cur.runs) || 0) + 1; }
    await blobSet(st, key, doc);
  } catch (e) { /* no-op */ }
}

module.exports = { stamp };
