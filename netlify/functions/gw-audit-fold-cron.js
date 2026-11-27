'use strict';
// C251 감사 줄 열쇠 접기 크론(설계 01_설계_전수표.md §7) — netlify.toml schedule = "10 3,8,18 * * *"(UTC 03:10·08:10·18:10 = KST 12:10·17:10·03:10 하루 3번).
//   그달 + 전달(서버 달)의 줄 열쇠(audit:YYYY-MM:e:…) 가운데 쓴 지 20분 넘은 것을 접은 문서(audit:YYYY-MM:f:<묶음 마지막 꼬리>-<무작위 8자리> — 실행마다 고유한 이름) 1개에
//   한 번 쓰고, 다시 읽어 쓴 그대로일 때만 그 줄 열쇠를 지운다 · 이미 접은 꼬리의 찌꺼기 줄 열쇠는 지운다. 계산은 _lib/audit.js foldRun 한 곳(감사 화면·월 점검이 읽는 readMonth와 같은 파일).
//   주소로 부른 HTTP 요청은 아무것도 하지 않는다(404 NOT_SCHEDULED · 흔적도 안 남김 — v520 gw-duty-cron과 같은 꼴). 다만 예약 실행도 Netlify가 HTTP 꼴(POST)로 넣으므로
//   예약 실행 표시가 있는 것만 지나간다: 공식 문서의 본문 { next_run } JSON 또는 머리 X-NF-Event: schedule(netlify-cli lib/functions/server.js가 운영을 흉내 내는 꼴).
//   표시는 흉내 낼 수 있으나 접기는 몇 번 겹쳐 돌아도 줄이 빠지지 않게 짜여 있어(실행마다 고유한 이름 · 읽는 쪽이 꼬리로 한 번만 셈) 흉내 낸 호출이 할 수 있는 것은 '접기 한 번 더'뿐이다.
const { stamp } = require('./_lib/cronstamp');   // 실행 흔적 it:cron:gw-audit-fold-cron:last
const { setupBlobContext, store } = require('./_lib/blobs');
const AUDIT = require('./_lib/audit');
// C304(11/27): 같은 실행에서 열람 기록 2종(doclog·reclog — _lib/linelog.js foldRun · 그달 + 전달 KST)도 접는다 — 감사 접기 뒤에, 이 실행 시작부터 같은 시간 상한(FOLD_RUN_CAP_MS) 안에서만 새 묶음을 시작.
//   접기 꼴·겹친 실행 안전(실행마다 고유한 이름 · 읽는 쪽 꼬리로 한 번만 셈)은 감사와 같다. 응답 logs · 흔적 note 뒤에 'doclog 접음 n·남음 m · reclog …'.
const LINELOG = require('./_lib/linelog');
const LINELOG_PREFIXES = ['doclog', 'reclog'];

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
  try { setupBlobContext(event); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  await stamp('gw-audit-fold-cron', { state: 'start' });
  const t0 = Date.now();
  let r;
  try { r = await AUDIT.foldRun(Date.now()); } catch (e) { r = { ok: false, code: 'EXCEPTION', months: [] }; }
  let lg;
  try { lg = await LINELOG.foldRun(store('gw_data'), LINELOG_PREFIXES, Date.now(), t0 + LINELOG.FOLD_RUN_CAP_MS); } catch (e) { lg = { ok: false, code: 'EXCEPTION', logs: [] }; }
  const note = (r.months || []).map(function (x) { return x.month + ' ' + (x.ok ? ('접음 ' + x.folded + '·남음 ' + x.left + (x.code ? '·' + x.code : '')) : ('실패 ' + x.code)); }).join(' · ') || String(r.code || '');
  // 열람 기록 — 접두어마다 두 달 합(접음·남음) · 실패한 달이 있으면 그 접두어는 '실패 <코드>'
  const lnote = LINELOG_PREFIXES.map(function (p) {
    const ms = (lg.logs || []).filter(function (x) { return x.head.indexOf(p + ':') === 0; });
    const bad = ms.find(function (x) { return !x.ok; });
    if (bad || !ms.length) return p + ' 실패 ' + (bad ? bad.code : String(lg.code || ''));
    return p + ' 접음 ' + ms.reduce(function (s, x) { return s + x.folded; }, 0) + '·남음 ' + ms.reduce(function (s, x) { return s + Math.max(0, x.left); }, 0) + (ms.some(function (x) { return x.code; }) ? '·TIME_CAP' : '');
  }).join(' · ');
  const ok = !!r.ok && !!lg.ok;
  // 실패한 갈래를 맨 앞에(감시 watch.py가 note 앞 60자만 보임 — 좁은 확인 11/27): 실패가 없으면 note는 종전 꼴 그대로
  const failed = [];
  if (!r.ok) failed.push('audit');
  LINELOG_PREFIXES.forEach(function (p) { if (lnote.indexOf(p + ' 실패') >= 0) failed.push(p); });
  const head = failed.length ? '[실패 ' + failed.join('/') + '] ' : '';
  await stamp('gw-audit-fold-cron', { state: 'end', ok: ok, note: (head + note + ' · ' + lnote).slice(0, 120) });
  return { statusCode: ok ? 200 : 500, body: JSON.stringify(Object.assign({}, r, { ok: ok, audit_ok: !!r.ok, logs: lg.logs || [], logs_ok: !!lg.ok })) };
};
exports.scheduledRun = scheduledRun;
