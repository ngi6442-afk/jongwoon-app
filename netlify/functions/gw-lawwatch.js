'use strict';

// 법령 워치 알림 수신 — appdata의 lawwatch.py(주간 크론)가 개정·선임 경보를 POST한다.
// 인증: 수집봇 공유 시크릿(BIDS_INGEST_KEY, gw-data ingest와 동일 계열) — 헤더 x-ingest-key 또는 body.key.
// 동작: 전문을 lawwatch:last 에 보관(추후 화면용) + 관리자 전원 푸시(알림함은 sendTo가 자동 기록).
//   P1 판7: 법령 개정 감지 누적 목록 = 별도 키 lawwatch:changed(_lib/lawchg — 읽기 성공 때만 합쳐 씀). lawwatch:last 꼴·푸시 제목·본문·받는 사람은 종전 그대로.
const push = require('./_lib/push');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { botKeyOk } = require('./_lib/keymatch');
const LAWCHG = require('./_lib/lawchg');   // P1 판7(원장 C102) 법령 개정 감지 목록(law_changed) 쌓기 — 인허가 의무 대장 '근거 재확인 필요' 표시 재료

const jr = (code, obj) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

async function lawChangedKeep(d, alerts) {   // P1 판7 — 반환 'written'|'same'|'read_failed'
  const st = store('gw_data'), today = LAWCHG.kstToday();
  let cr;
  try { cr = await blobGet(st, LAWCHG.CHANGED_KEY); } catch (e) { cr = { ok: false }; }
  if (!cr.ok && cr.code !== 'NOT_FOUND') return 'read_failed';
  let prevLast = null;
  try { const pr = await blobGet(st, 'lawwatch:last'); if (pr && pr.ok) prevLast = pr.data; } catch (e) {}
  const base = LAWCHG.merge([LAWCHG.itemsOf(cr.ok ? cr.data : null)], today);
  const next = LAWCHG.merge([base, LAWCHG.fromDoc({ date: prevLast && prevLast.date, alerts: prevLast && prevLast.alerts }), LAWCHG.fromDoc({ date: LAWCHG.isDay(d.date) ? d.date : today, alerts: alerts, law_changed: d.law_changed })], today);
  if (LAWCHG.sameList(base, next)) return 'same';
  await blobSet(st, LAWCHG.CHANGED_KEY, { schema: 1, items: next, ts: Date.now() });
  return 'written';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jr(405, { status: 'METHOD_NOT_ALLOWED' });
  // 11/2 수리: Blob 컨텍스트 설정이 빠져 있었다(다른 함수 29/32는 호출). 첫 실제 경보(11/2 산안법)에서 tierCtx → getStore가 던져 502 — 보관·푸시 둘 다 0건.
  try { setupBlobContext(event); } catch (e) {}
  let d = {};
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return jr(400, { status: 'BAD_JSON' }); }

  // v456(원장 C108): 상수시간 비교(_lib/keymatch botKeyOk — gw-data와 같은 규칙, 종전 '!==')
  const got = (event.headers && (event.headers['x-ingest-key'] || event.headers['X-Ingest-Key'])) || d.key || '';
  if (!botKeyOk(got)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY' });

  const alerts = Array.isArray(d.alerts) ? d.alerts.map((a) => String(a)).filter(Boolean) : [];
  if (!alerts.length) return jr(400, { status: 'NO_ALERTS' });

  try {
    const bgRecheck = Array.isArray(d.bg_recheck) ? d.bg_recheck.slice(0, 100).map((x) => ({ id: String((x && x.id) || '').slice(0, 40), law: String((x && x.law) || '').slice(0, 60), mst: Number(x && x.mst) || 0 })).filter((x) => x.id) : [];   // v405 D2: 계약 배경 재확인 행
    // P1 판7: 감지 목록은 별도 키(LAWCHG.CHANGED_KEY)에 쌓는다 — 이 키 읽기에 성공했을 때만(없음 = 빈 목록) 합쳐 쓰고, 못 읽으면 쓰지 않는다(누적을 덮지 않음).
    //   합칠 것 = 이번 회차(수집기 law_changed + 경보 글) + 덮기 전 앞 판 lawwatch:last 경보 글(이 키에 못 들어간 회차분 주워 담기). 합친 결과가 저장본과 같으면 안 씀(감지 없는 회차 = 무변).
    try { await lawChangedKeep(d, alerts); } catch (e) {}
    await blobSet(store('gw_data'), 'lawwatch:last', {
      schema: 1, date: String(d.date || ''), alerts: alerts.slice(0, 50), bg_recheck: bgRecheck, ts: Date.now(),
    });
  } catch (e) {}

  const nLaw = alerts.filter((a) => a.indexOf('[법령 개정 감지]') === 0 || a.indexOf('[포털 변동 감지]') === 0).length;
  const nStaff = alerts.filter((a) => a.indexOf('[선임 의무]') === 0 || a.indexOf('[문턱 접근 예고]') === 0).length;
  const autoTitle = '법령 워치 — ' + (nLaw ? '개정 ' + nLaw + '건' : '') + (nLaw && nStaff ? ' · ' : '') + (nStaff ? '선임 ' + nStaff + '건' : '') || '경보';
  const title = d.title ? String(d.title).slice(0, 60) : autoTitle; // 수집기 공용화(adwatch 등)
  const body = alerts.slice(0, 3).join('\n').slice(0, 280) + (alerts.length > 3 ? ' 외 ' + (alerts.length - 3) + '건' : '');

  try {
    const tcL2 = await push.tierCtx();   // 스캔 1회 — adminIds와 sendTo 활성 필터 공용
    const ids = tcL2.adminIds;
    if (!ids.length) return jr(200, { status: 'OK', sent: 0, note: 'NO_ADMIN_SUBS' });
    const r = await push.sendTo(ids, { title, body, url: './', tag: 'lawwatch' }, { ctx: tcL2 });
    return jr(200, { status: 'OK', sent: r.sent });
  } catch (e) {
    // 푸시가 죽어도 보관(lawwatch:last)은 끝났으니 200 — 수집기가 '전송 실패'로 오판해 다음 주까지 묻히지 않게. 사유는 응답에.
    return jr(200, { status: 'OK', sent: 0, note: 'PUSH_FAILED: ' + String(e && e.message || e).slice(0, 80) });
  }
};
