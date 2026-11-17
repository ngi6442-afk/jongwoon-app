'use strict';
// 29 판⑦ 메일 에이전트 예약 크론 — netlify.toml schedule = "0 22 * * *" (UTC 22:00 = KST 07:00 매일).
// 예약 함수는 30초 한도라 흔적 스탬프 + 15분 워커(gw-stmtmail-run-background) 기동만 한다(gw-brief-cron 꼴). 끝 스탬프는 워커가 찍는다.
// 수동 킥 = gw-cron-kick target 'stmtmail'(BIDS_INGEST_KEY) · 앱 [지금 받기] = gw-stmt stmt_mail_run(관리자).
const { setupBlobContext } = require('./_lib/blobs');
const { issueSession } = require('./_lib/session');
const { stamp } = require('./_lib/cronstamp');

async function kick(by) {
  const s = issueSession({ id: '__stmtmail__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-stmtmail-run-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ by: String(by || 'cron').slice(0, 40) }),
    });
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) { return { ok: false, code: 'KICKOFF_FAILED' }; }
}

exports.kick = kick;
exports.handler = async function (event) {
  try { setupBlobContext(event); } catch (e) { /* 스탬프만 못 찍음 */ }
  await stamp('gw-stmtmail-cron', { state: 'start' });
  const r = await kick('cron');
  if (!r.ok) { await stamp('gw-stmtmail-cron', { state: 'end', ok: false, note: r.code }); return { statusCode: 500, body: JSON.stringify(r) }; }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
