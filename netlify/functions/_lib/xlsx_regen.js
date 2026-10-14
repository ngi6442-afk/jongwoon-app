'use strict';
// 운반일지 엑셀 재생성 요청 — appdata logsheet.yml을 workflow_dispatch로 한 번 더 돌린다(2분 디바운스).
// v352에서 gw-allbaro 안에 있던 것을 v385에서 공용으로 뺐다: 수집 워커(gw-allbaro-run-background)도 수집이 끝나면 부른다.
//
// v385 배경(10/14 권민지 "엑셀 내려받기 수량이 화면과 다름" — 12·13일): 엑셀은 GitHub 예약 실행(KST 08:25)이 만드는데,
//   실측 결과 그 예약이 매일 10:58~12:38에야 시작됐다(10/2~10/14 13회 전부 2.5~4시간 지연 — GitHub 예약 실행은 지연·생략이 정상 동작).
//   그래서 오전에 받는 엑셀은 '전날 아침(전날 올바로 반영 전)'으로 만든 파일이었다. 앱 화면은 08:01 수집본이라 맞았다.
//   → 수집이 끝나면 바로 dispatch(예약은 예비로만), 내려받을 때 '파일이 놓친 변경(수집·직접 추가·숨김/노선)'을 알리고 다시 요청.
//
// 블롭 allbaro:xlsx_regen 필드:
//   requested_at·reason·by·days_back = 마지막 요청(디바운스로 보류된 것 포함)
//   dispatched_at·cover_from = 마지막으로 '접수(204)'된 실행의 시각과 그 실행이 덮는 가장 오래된 날짜(KST) — 보류·실패 요청은 바꾸지 않는다
//   dispatch_code·dispatch_err = 마지막 시도 결과, skipped = 마지막 요청이 디바운스로 보류됨
//   route_at = 숨김·노선 지정·노선 추가·재정렬 요청 시각(다른 요청이 덮어써도 유지 — '노선 변경을 놓친 파일' 판정 기준)
// 토큰 없음·권한 없음이면 코드만 남긴다(주 동작은 막지 않는다).
const { blobGet, blobSet } = require('./blobs');

const REGEN_KEY = 'allbaro:xlsx_regen';
const REGEN_DEBOUNCE_MS = 120000;
const REGEN_REPO = 'ngi6442-afk/jongwoon-appdata';
const REGEN_WORKFLOW = 'logsheet.yml';
const REGEN_DAYS_BACK = 9;    // 수집 창(gw-allbaro-cron WINDOW_DAYS 9)과 같게 — 수집이 다시 쓴 날짜는 전부 다시 만든다(종전 7이면 8·9일 전 파일이 영영 낡은 채)
const REGEN_MAX_DAYS = 59;    // 요청 상한 — 워크플로에는 하루 여유(+1)를 붙여 보내므로 logsheet_daily.py 상한 60과 맞는다
const REGEN_STALE_MS = 15 * 60000;   // 접수 뒤 이 안에 반영본이 없으면 그 실행은 그 날짜를 못 만든 것으로 본다(잡 한도 10분 + 대기)
const REGEN_GIVEUP_RETRY_MS = 60 * 60000;   // 못 만든 날짜는 1시간에 한 번만 다시 요청(내려받기마다 반복 dispatch 방지)
const ROUTE_REASONS = { hide: 1, unhide: 1, learn: 1, route_add: 1, rematch: 1 };

// 노선 변경 시각 — route_at이 없으면(v385 이전 블롭) 마지막 요청이 노선류(또는 이유 없음)일 때 그 요청 시각
function routeAtOf(g) {
  if (!g || typeof g !== 'object') return 0;
  if (Number(g.route_at)) return Number(g.route_at);
  return (!g.reason || ROUTE_REASONS[g.reason]) ? (Number(g.requested_at) || 0) : 0;
}

function kstDayMinus(n) { return new Date(Date.now() + 9 * 3600000 - (n || 0) * 86400000).toISOString().slice(0, 10); }

function clampDays(n) {
  const v = Math.floor(Number(n) || 0);
  return Math.max(REGEN_DAYS_BACK, Math.min(REGEN_MAX_DAYS, v || REGEN_DAYS_BACK));
}

// KST 기준 오늘에서 day(YYYY-MM-DD)까지 며칠 전인지(오늘 0). 형식 오류면 0.
function daysAgoKst(day) {
  const a = Date.parse(kstDayMinus(0) + 'T00:00:00Z'), b = Date.parse(String(day) + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return 0;
  return Math.max(0, Math.round((a - b) / 86400000));
}
// 날짜 목록 중 가장 오래된 날짜까지 덮는 소급 일수(빈 목록이면 기본)
function backFor(days) {
  return (days || []).reduce(function (m, d) { return Math.max(m, daysAgoKst(d) + 1); }, REGEN_DAYS_BACK);
}

async function requestXlsxRegen(st, reason, who, daysBack) {
  let cur = {};
  try { const r = await blobGet(st, REGEN_KEY); if (r.ok && r.data && typeof r.data === 'object') cur = r.data; } catch (e) {}
  const now = Date.now();
  const db = clampDays(daysBack);
  const doc = Object.assign({ schema: 1 }, cur, { requested_at: now, reason: reason, by: who || '', days_back: db });
  if (ROUTE_REASONS[reason]) doc.route_at = now;
  else { const ra = routeAtOf(cur); if (ra) doc.route_at = ra; }
  if (Number(cur.dispatched_at) && now - Number(cur.dispatched_at) < REGEN_DEBOUNCE_MS) {
    // 방금 보낸 실행이 이 변경을 못 읽었을 수 있다 — 내려받기(gw-allbaro handleXlsx)가 '놓친 변경 뒤 접수된 실행 없음'을 보고 2분 뒤 다시 보낸다
    doc.skipped = true;
    try { await blobSet(st, REGEN_KEY, doc); } catch (e) {}
    return doc;
  }
  delete doc.skipped;
  const token = process.env.GW_APPDATA_GITHUB_TOKEN || process.env.GW_GALLERY_GITHUB_TOKEN || process.env.MEMBER_RELAY_GITHUB_TOKEN || '';
  if (!token) { doc.dispatch_code = 0; doc.dispatch_err = 'NO_TOKEN'; }
  else {
    const ac = new AbortController(); const tm = setTimeout(function () { ac.abort(); }, 6000);
    try {
      // 하루 여유(+1): 자정 직전 요청이 자정 뒤에 시작되면 생성기의 '오늘'이 하루 밀려 가장 오래된 날짜가 빠진다
      const res = await fetch('https://api.github.com/repos/' + REGEN_REPO + '/actions/workflows/' + REGEN_WORKFLOW + '/dispatches', {
        method: 'POST', signal: ac.signal,
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gw-allbaro', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { days_back: String(db + 1) } }),
      });
      doc.dispatch_code = res.status;   // 204 = 접수
      if (res.status === 204) { doc.dispatched_at = now; doc.cover_from = kstDayMinus(db - 1); delete doc.dispatch_err; } else doc.dispatch_err = 'HTTP_' + res.status;
    } catch (e) { doc.dispatch_code = -1; doc.dispatch_err = (e && e.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK'; }
    clearTimeout(tm);
  }
  try { await blobSet(st, REGEN_KEY, doc); } catch (e) {}
  return doc;
}

// 이번 요청의 결과 상태(앱 문구·워커 로그용) — 보류가 직전 204를 물려받아 '접수'로 읽히지 않게 skipped를 먼저 본다
function requestState(doc) {
  if (!doc) return 'failed';
  if (doc.skipped) return 'skipped';
  return (doc.dispatch_code === 204 && Number(doc.dispatched_at) === Number(doc.requested_at)) ? 'requested' : 'failed';
}

module.exports = { requestXlsxRegen, requestState, routeAtOf, daysAgoKst, backFor, kstDayMinus, REGEN_KEY, REGEN_DEBOUNCE_MS, REGEN_DAYS_BACK, REGEN_MAX_DAYS, REGEN_STALE_MS, REGEN_GIVEUP_RETRY_MS, ROUTE_REASONS };
