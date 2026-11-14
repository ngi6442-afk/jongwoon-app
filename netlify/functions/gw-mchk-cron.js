'use strict';
// P1 판31 월 점검 크론 — netlify.toml schedule = "0 22 * * *"(UTC 22:00 = KST 07:00 매일 기동). 계산은 _lib/mchk.js run 한 곳.
// cron 5필드로는 'KST 매월 1일'을 한 줄로 못 써서(gw-appr-cron과 같은 까닭) 매일 기동하고 함수 안에서 KST 1~3일에만 전달(前月)을 대조한다 —
// 1일 기동이 빠져도 3일까지 잡고, 그달 문서('mchk:YYYY-MM')가 있으면 건너뛰므로 두 번 돌아도 문서는 1개. 새 푸시 알림 없음(PM 콘솔 카드만).
const { stamp } = require('./_lib/cronstamp');   // 실행 흔적 it:cron:gw-mchk-cron:last
const { setupBlobContext } = require('./_lib/blobs');
const MCHK = require('./_lib/mchk');

exports.handler = async function (event) {
  try { setupBlobContext(event); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  await stamp('gw-mchk-cron', { state: 'start' });
  let r;
  try { r = await MCHK.runMonthly(Date.now()); } catch (e) { r = { ok: false, code: 'EXCEPTION' }; }
  await stamp('gw-mchk-cron', { state: 'end', ok: !!r.ok, note: String(r.code || r.skipped || ('ok ' + (r.period || ''))).slice(0, 40) });
  return { statusCode: r.ok ? 200 : 500, body: JSON.stringify(r) };
};
