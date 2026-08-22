'use strict';

// 법령 워치 알림 수신 — appdata의 lawwatch.py(주간 크론)가 개정·선임 경보를 POST한다.
// 인증: 수집봇 공유 시크릿(BIDS_INGEST_KEY, gw-data ingest와 동일 계열) — 헤더 x-ingest-key 또는 body.key.
// 동작: 전문을 lawwatch:last 에 보관(추후 화면용) + 관리자 전원 푸시(알림함은 sendTo가 자동 기록).
const push = require('./_lib/push');
const { store, blobSet } = require('./_lib/blobs');

const jr = (code, obj) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jr(405, { status: 'METHOD_NOT_ALLOWED' });
  let d = {};
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return jr(400, { status: 'BAD_JSON' }); }

  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  const got = String((event.headers && (event.headers['x-ingest-key'] || event.headers['X-Ingest-Key'])) || d.key || '').trim();
  if (!secret || got !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY' });

  const alerts = Array.isArray(d.alerts) ? d.alerts.map((a) => String(a)).filter(Boolean) : [];
  if (!alerts.length) return jr(400, { status: 'NO_ALERTS' });

  try {
    await blobSet(store('gw_data'), 'lawwatch:last', {
      schema: 1, date: String(d.date || ''), alerts: alerts.slice(0, 50), ts: Date.now(),
    });
  } catch (e) {}

  const nLaw = alerts.filter((a) => a.indexOf('[법령 개정 감지]') === 0 || a.indexOf('[포털 변동 감지]') === 0).length;
  const nStaff = alerts.filter((a) => a.indexOf('[선임 의무]') === 0 || a.indexOf('[문턱 접근 예고]') === 0).length;
  const title = '법령 워치 — ' + (nLaw ? '개정 ' + nLaw + '건' : '') + (nLaw && nStaff ? ' · ' : '') + (nStaff ? '선임 ' + nStaff + '건' : '') || '경보';
  const body = alerts.slice(0, 3).join('\n').slice(0, 280) + (alerts.length > 3 ? ' 외 ' + (alerts.length - 3) + '건' : '');

  const ids = await push.adminIds();
  if (!ids.length) return jr(200, { status: 'OK', sent: 0, note: 'NO_ADMIN_SUBS' });
  const r = await push.sendTo(ids, { title, body, url: './', tag: 'lawwatch' });
  return jr(200, { status: 'OK', sent: r.sent });
};
