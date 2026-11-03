'use strict';
// 아침 음성 브리핑 예약 크론(체크 38 D1, v416) — netlify.toml schedule = "30 21 * * *" (UTC 21:30 = KST 06:30 매일).
// 예약 함수는 30초 한도라 여기서는 흔적 스탬프 + 오늘 생성본 유무 확인 + 15분 한도 워커(gw-brief-run-background) 기동만 한다
// (gw-hwakwan-cron 방식). 오늘 생성본(brief:day:<오늘>)이 이미 있으면 다시 만들지 않는다 — 같은 날 두 판·유료 호출 2회 방지(브리핑 §3 D3 폴백 규칙).
// 끝 스탬프(state:'end')는 워커가 찍는다 — 시작만 있고 끝이 없으면 appdata watch.py가 '실행 중 죽음 의심'으로 띄운다.
// 수동 킥 = gw-cron-kick(target 'brief', BIDS_INGEST_KEY) — GitHub Actions 크론 백업층·감시 자동 복구층이 쓴다.
const { setupBlobContext, store, blobGet } = require('./_lib/blobs');
const { issueSession } = require('./_lib/session');
const { stamp } = require('./_lib/cronstamp');

const DATA = 'gw_data';
function kstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

exports.handler = async function (event) {
  const today = kstToday();
  // force(gw-cron-kick 경유 {target:'brief', force:true}) — 오늘 생성본이 있어도 다시 만든다(배포 검증·Claude 400 원인 확인용, BIDS_INGEST_KEY 인증 뒤에만 도달). 예약 실행은 body가 없어 false.
  let force = false;
  try { const d = JSON.parse((event && event.body) || '{}'); force = d && d.force === true; } catch (e) { force = false; }
  let st = null;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { st = null; }
  await stamp('gw-brief-cron', { state: 'start' });
  if (st && !force) {
    try {
      const r = await blobGet(st, 'brief:day:' + today);
      if (r.ok && r.data && r.data.text) {
        await stamp('gw-brief-cron', { state: 'end', ok: true, note: 'exists ' + today });
        return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'exists', date: today }) };
      }
    } catch (e) { /* 확인 실패 — 워커가 다시 확인한다 */ }
  }
  const s = issueSession({ id: '__brief__', role: 'system' });
  if (!s.ok) { await stamp('gw-brief-cron', { state: 'end', ok: false, note: s.code || 'SERVER_CONFIG_MISSING' }); return { statusCode: 500, body: JSON.stringify({ ok: false, code: s.code || 'SERVER_CONFIG_MISSING' }) }; }
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) { await stamp('gw-brief-cron', { state: 'end', ok: false, note: 'NO_SITE_URL' }); return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_SITE_URL' }) }; }
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-brief-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: 'brief_cron_' + today + (force ? '_f' + Date.now().toString(36) : ''), by: 'cron', force: force }),
    });
    if (!resp.ok && resp.status !== 202) { await stamp('gw-brief-cron', { state: 'end', ok: false, note: 'KICKOFF_HTTP_' + resp.status }); return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_HTTP_' + resp.status }) }; }
    return { statusCode: 200, body: JSON.stringify({ ok: true, date: today, job: 'brief_cron_' + today }) };
  } catch (e) {
    await stamp('gw-brief-cron', { state: 'end', ok: false, note: 'KICKOFF_FAILED' });
    return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_FAILED' }) };
  }
};
