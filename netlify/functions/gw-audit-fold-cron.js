'use strict';
// C251 감사 줄 열쇠 접기 크론(설계 01_설계_전수표.md §7) — netlify.toml schedule = "10 3,8,18 * * *"(UTC 03:10·08:10·18:10 = KST 12:10·17:10·03:10 하루 3번).
//   그달 + 전달(서버 달)의 줄 열쇠(audit:YYYY-MM:e:…) 가운데 쓴 지 20분 넘은 것을 접은 문서(audit:YYYY-MM:f:<묶음 마지막 꼬리>) 1개에 묶어 한 번 쓰고,
//   다시 읽어 쓴 그대로일 때만 그 줄 열쇠를 지운다 · 이미 접은 꼬리의 찌꺼기 줄 열쇠는 지운다. 계산은 _lib/audit.js foldRun 한 곳(감사 화면·월 점검이 읽는 readMonth와 같은 파일).
//   주소로 부른 HTTP 요청은 아무것도 하지 않는다(404 NOT_SCHEDULED — v520 gw-duty-cron과 같은 꼴). 다만 예약 실행도 Netlify가 POST로 넣으므로(netlify-cli lib/functions/server.js:
//   "In production, scheduled functions always receive POST requests" — 머리 X-NF-Event: schedule) 그 표시가 있는 실행만 지나간다. 표시는 흉내 낼 수 있으나
//   접기는 몇 번 겹쳐 돌아도 줄이 빠지지 않게 짜여 있어(읽는 쪽이 꼬리로 한 번만 셈) 흉내 낸 호출이 할 수 있는 것은 '접기 한 번 더'뿐이다.
const { stamp } = require('./_lib/cronstamp');   // 실행 흔적 it:cron:gw-audit-fold-cron:last
const { setupBlobContext } = require('./_lib/blobs');
const AUDIT = require('./_lib/audit');

function scheduledRun(event) {
  const h = (event && event.headers) || {};
  let v = '';
  Object.keys(h).forEach(function (k) { if (String(k).toLowerCase() === 'x-nf-event') v = String(h[k] || ''); });
  return v.toLowerCase() === 'schedule';
}

exports.handler = async function (event) {
  if (event && (event.httpMethod || event.headers) && !scheduledRun(event)) return { statusCode: 404, body: JSON.stringify({ ok: false, code: 'NOT_SCHEDULED' }) };
  try { setupBlobContext(event); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  await stamp('gw-audit-fold-cron', { state: 'start' });
  let r;
  try { r = await AUDIT.foldRun(Date.now()); } catch (e) { r = { ok: false, code: 'EXCEPTION', months: [] }; }
  const note = (r.months || []).map(function (x) { return x.month + ' ' + (x.ok ? ('접음 ' + x.folded + '·남음 ' + x.left + (x.code ? '·' + x.code : '')) : ('실패 ' + x.code)); }).join(' · ') || String(r.code || '');
  await stamp('gw-audit-fold-cron', { state: 'end', ok: !!r.ok, note: note.slice(0, 120) });
  return { statusCode: r.ok ? 200 : 500, body: JSON.stringify(r) };
};
exports.scheduledRun = scheduledRun;
