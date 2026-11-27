'use strict';
// C289(11/27) 오래 참조 없는 첨부 정리 — 연습 방식 예약 크론. netlify.toml schedule = "0 18 * * 0" (UTC 일 18:00 = KST 월 03:00, 주 1회).
// 예약 함수는 30초 한도라 기동만 한다(gw-brief-cron 방식). 판정·보고는 gw-attorphan-background(15분 한도). 지우는 동작은 어디에도 없다.
const { setupBlobContext } = require('./_lib/blobs');
const { issueSession } = require('./_lib/session');
const { stamp } = require('./_lib/cronstamp');

// 예약 실행 표시가 있는 것만 지나간다(gw-audit-fold-cron과 같은 꼴) — 머리 X-NF-Event: schedule 또는 본문 { next_run }. 바깥 HTTP 호출은 404.
function scheduledRun(event) {
  const h = (event && event.headers) || {};
  let v = '';
  Object.keys(h).forEach(function (k) { if (String(k).toLowerCase() === 'x-nf-event') v = String(h[k] || ''); });
  if (v.toLowerCase() === 'schedule') return true;
  let b = event && event.body;
  try { if (event && event.isBase64Encoded && typeof b === 'string') b = Buffer.from(b, 'base64').toString('utf8'); } catch (e) { b = ''; }
  let j = null;
  try { j = typeof b === 'string' && b ? JSON.parse(b) : null; } catch (e) { j = null; }
  return !!j && typeof j === 'object' && !Array.isArray(j) && typeof j.next_run === 'string' && j.next_run.length > 0;
}

exports.handler = async function (event) {
  if (event && (event.httpMethod || event.headers) && !scheduledRun(event)) return { statusCode: 404, body: JSON.stringify({ ok: false, code: 'NOT_SCHEDULED' }) };
  try { setupBlobContext(event); } catch (e) {}
  await stamp('gw-attorphan-cron', { state: 'start' });
  const s = issueSession({ id: '__attorphan__', role: 'system' });
  if (!s.ok) { await stamp('gw-attorphan-cron', { state: 'end', ok: false, note: s.code || 'SERVER_CONFIG_MISSING' }); return { statusCode: 500, body: JSON.stringify({ ok: false, code: s.code || 'SERVER_CONFIG_MISSING' }) }; }
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) { await stamp('gw-attorphan-cron', { state: 'end', ok: false, note: 'NO_SITE_URL' }); return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_SITE_URL' }) }; }
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-attorphan-background', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token }, body: '{}' });
    if (!resp.ok && resp.status !== 202) { await stamp('gw-attorphan-cron', { state: 'end', ok: false, note: 'KICKOFF_HTTP_' + resp.status }); return { statusCode: 502, body: JSON.stringify({ ok: false, code: 'KICKOFF_HTTP_' + resp.status }) }; }
  } catch (e) {
    await stamp('gw-attorphan-cron', { state: 'end', ok: false, note: 'KICKOFF_FAILED' });
    return { statusCode: 502, body: JSON.stringify({ ok: false, code: 'KICKOFF_FAILED' }) };
  }
  return { statusCode: 202, body: JSON.stringify({ ok: true, started: true }) };
};
