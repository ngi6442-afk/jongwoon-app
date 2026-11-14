'use strict';
// P1 판31 월 점검 크론 — netlify.toml schedule = "0 22 * * *"(UTC 22:00 = KST 07:00 매일 기동). 계산은 _lib/mchk.js run 한 곳.
// cron 5필드로는 'KST 매월 1일'을 한 줄로 못 써서(gw-appr-cron과 같은 까닭) 매일 기동하고 함수 안에서 KST 1~3일에만 전달(前月)을 대조한다 —
// 1일 기동이 빠져도 3일까지 잡고, 그달 문서('mchk:YYYY-MM')가 있으면 건너뛰므로 두 번 돌아도 문서는 1개. 월 점검은 새 푸시 알림 없음(PM 콘솔 카드만).
// P1 판22(11/14): 같은 기동에서 월 점검 **앞에** 기기·계정 자동 처리(_lib/devauto.js runDaily — 퇴사 다음 날 기기·구독 회수 · 승인 대기 7일 넘은 기기 개발자 1발)를 매일 돌린다.
//   새 크론을 만들지 않고 이 크론에 붙인 까닭: 매일 도는 전산 영역 크론이고(같은 IT 도메인·같은 흔적 키) 월 점검(1일)이 그날 아침 회수 결과를 보고 대기 기기·퇴사자 기기·구독을 판정하게 하려고.
//   기기 처리 실패(명부·기기·구독 못 읽음 등 — 쓰지 않고 다음 날 다시)는 흔적 ok:false로 남겨 appdata watch가 드러낸다. 월 점검 계산은 기기 처리 결과와 상관없이 돈다.
const { stamp } = require('./_lib/cronstamp');   // 실행 흔적 it:cron:gw-mchk-cron:last
const { setupBlobContext } = require('./_lib/blobs');
const MCHK = require('./_lib/mchk');
const DEVAUTO = require('./_lib/devauto');

exports.handler = async function (event) {
  try { setupBlobContext(event); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  await stamp('gw-mchk-cron', { state: 'start' });
  // 검토 11/14 ②: 기기 처리 전체에 시간 상한(DEVAUTO.CFG.runCapMs 15초 — 발송은 그 안에서 3초씩) — 넘거나 멈춰도 월 점검은 돈다(순서는 그대로: 회수가 먼저라 1일 점검이 그날 아침 결과를 봄) · 흔적 ok:false
  let dv;
  try { const c = await DEVAUTO.withCap(DEVAUTO.runDaily(Date.now()), DEVAUTO.CFG.runCapMs); dv = c.done ? c.v : { ok: false, code: 'TIMEOUT' }; } catch (e) { dv = { ok: false, code: 'EXCEPTION' }; }
  let r;
  try { r = await MCHK.runMonthly(Date.now()); } catch (e) { r = { ok: false, code: 'EXCEPTION' }; }
  const dvNote = dv.ok ? ('기기 회수 ' + (dv.revoked_devices || 0) + '·구독 ' + (dv.revoked_subs || 0) + '·7일 ' + (dv.stale_new || 0)) : ('기기 처리 실패 ' + String(dv.code || 'WRITE')).slice(0, 30);
  await stamp('gw-mchk-cron', { state: 'end', ok: !!r.ok && !!dv.ok, note: String(r.code || r.skipped || ('ok ' + (r.period || ''))).slice(0, 40) + ' · ' + dvNote });
  return { statusCode: r.ok && dv.ok ? 200 : 500, body: JSON.stringify(Object.assign({}, r, { devauto: dv })) };
};
