'use strict';

// 비용 실측 백그라운드 워커 — 30문항을 서버가 끝까지 돌린다(Netlify Background Function, 15분 한도).
//
// 왜 필요한가 — 종전엔 브라우저가 한 문항씩 돌렸는데, PM이 폰으로 눌러 놓고 화면이 꺼지자
// 4문항에서 멈췄다(2026-09-10 실측). 사람이 5분간 화면을 켜 두고 기다리게 만드는 설계가 틀렸다.
// 이제 한 번 누르면 서버가 끝까지 돌고, 결과는 blob 'meter:cost'에 쌓인다.
//
// 읽기 전용이다. 도구는 gw-ask-meter의 것을 그대로 쓰고 권한도 그대로 태운다.

const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const meter = require('./gw-ask-meter');

const DATA = 'gw_data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  setupBlobContext(event);
  const c = await meter.currentMember(event);
  if (!c.ok || !c.member.admin) return { statusCode: 403, headers: CORS, body: JSON.stringify({ ok: false, code: 'ADMIN_ONLY' }) };

  // 진행 상황을 같은 문서에 적어 앱이 폴링할 수 있게 한다(끝났는지 사람이 알아야 한다)
  const mark = async (state, done) => {
    try {
      const prev = await blobGet(store(DATA), 'meter:cost');
      const doc = (prev.ok && prev.data && Array.isArray(prev.data.rows)) ? prev.data : { schema: 1, rows: [] };
      doc.run = { state, done, total: meter.METER_Q.length, at: Date.now(), by: c.member.name };
      await blobSet(store(DATA), 'meter:cost', doc);
    } catch (e) { /* 진행 표시 실패가 측정을 막지는 않는다 */ }
  };

  await mark('running', 0);
  for (let i = 0; i < meter.METER_Q.length; i++) {
    const q = meter.METER_Q[i];
    const t0 = Date.now();
    let r;
    try { r = await meter.ask(q, c.member); } catch (e) { r = { error: 'ASK_THREW' }; }
    await meter.saveRow({ ok: !r.error, q, who: c.member.name, ms: Date.now() - t0, ts: Date.now() }, r);
    await mark('running', i + 1);
    if (r && r.error === 'NO_API_KEY') { await mark('no_api_key', i + 1); return { statusCode: 202, body: '' }; }
  }
  await mark('done', meter.METER_Q.length);
  return { statusCode: 202, body: '' };
};
