'use strict';

// 올바로(allbaro.or.kr) 일일운반일지 — 사용자 API.
// 크론(gw-allbaro-cron)이 매일 KST 08:00에 최근 7일을 수집하고, 실제 수집은
// 15분 한도 백그라운드 워커(gw-allbaro-run-background)가 수행한다.
// 이 함수는 조회·입력검증·기동만 한다(일반 함수 10초 한도 안에서 끝나는 일만).
// 자격증명은 Netlify 환경변수 GW_ALLBARO_ID / GW_ALLBARO_PW — 코드·저장소·응답·로그 어디에도 값이 없다.
// 이 함수는 자격증명을 읽지도 않는다(존재 여부만 확인). 값은 워커만 env에서 직접 읽는다.
// 올바로는 조회 전용이다 — 이 경로로 등록·수정·삭제 요청을 보내는 코드는 없다.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { issueSession, verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const { ROUTES, normName, normItem } = require('./_lib/allbaro');   // 노선표(양식 줄) + 이름·품목 정규화(learnKey를 라이브러리 매칭과 같은 기준으로)

const DATA = 'gw_data';
const USERS = 'gw_users';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function jobKey(id) { return `allbaro:job:${id}`; }
function dayKey(day) { return `allbaro:day:${day}`; }
function manualKey(day) { return `allbaro:manual:${day}`; }   // 담당자 수동 추가분(올바로에 안 올라오는 운반)
const LEARNED_KEY = 'allbaro:learned';   // 사람이 지정한 (조합 → 양식 줄) 대응
const PRESETS_KEY = 'allbaro:presets';   // 단골 노선 카드(회사 공용)
const PRESETS_PREV_KEY = 'allbaro:presets:prev';   // 직전 단골 노선 1벌 — 통째 교체 실수 복구 근거(계약 B-major2)
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_JOB = /^ab_[a-z0-9_-]{1,60}$/i;
const RE_PRESET_ID = /^[A-Za-z0-9_-]{1,40}$/;
const STATUS_DAYS = 14;   // 상태 카드에 보여줄 최근 일수
const MAX_RUN_DAYS = 14;  // 한 번에 수집 요청 가능한 최대 날짜 수
const RUN_BACK_DAYS = 60; // 소급 허용 한도(오늘−60일)
const DEFAULT_RUN_DAYS = 7; // 기본 수집 창(오늘 포함 최근 7일) — 크론과 동일
// 2단계 상한(계약 B-2). 실사용 규모(노선 64줄·차량 수십 대)의 몇 배로 잡되, 무한 증식은 막는다.
const MAX_LEARNED = 500;        // 학습 지정 총 개수
const MAX_MANUAL_ITEMS = 100;   // 하루 수동 입력 줄 수
const MAX_PRESETS = 60;         // 단골 노선 카드 수
const MAX_STR = 80;             // 상차지·하차지·품목 등 이름 길이
const MAX_UNIT = 10;            // 단위 표기 길이
const MAX_MEMO = 200;           // 비고 길이
const MAX_N = 999;              // 하루 한 줄 회수 상한
const MAX_QTY_TON = 100000;     // 한 줄 톤 상한
const MANUAL_BACK_DAYS = 60;    // 수동 입력 소급 한도(수집 창과 동일)

// 달력 왕복 검증 — 정규식만으로는 2026-02-30 같은 불가능 날짜가 통과해
// blob 키·조회 파라미터로 그대로 흘러간다(화관법 V2 검토 2026-08-11과 같은 이유). 여기서 조기 차단.
function validDay(s) {
  const p = String(s).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
}
// KST 일자 문자열(YYYY-MM-DD). offsetDays만큼 이동.
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }
// 값이 아니라 존재 여부만 본다 — 값은 절대 읽어서 돌려주지 않는다.
function envReady() { return !!(process.env.GW_ALLBARO_ID && process.env.GW_ALLBARO_PW); }

// 문자열 입력 정리 — 제어문자 제거 + 앞뒤 공백 제거. 길이 초과는 여기서 자르지 않고 호출부가 거부한다:
// 조용히 잘라 저장하면 사람이 넣은 값과 다른 값이 일지에 남는다(회사 원칙: 애매하면 드러낸다).
function cleanStr(v) { return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); }
// 유한한 0 이상 숫자만 통과(빈 문자열·undefined는 0). 그 외는 null → 호출부가 400.
function num0(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }

// 노선표 인덱스 — 학습 지정이 실재하는 줄을 가리키는지 검증한다(계약 B-2 BAD_ROUTE).
// 프로토타입 오염 없는 사전(Object.create(null))으로 'constructor' 같은 키 우회를 원천 차단.
const ROUTE_LIST = Array.isArray(ROUTES) ? ROUTES : [];
const ROUTE_INDEX = Object.create(null);
ROUTE_LIST.forEach(function (r) {
  if (r && (r.side === 'L' || r.side === 'R') && Number.isInteger(r.row)) ROUTE_INDEX[r.side + ':' + r.row] = r;
});
function findRoute(side, row) { return ROUTE_INDEX[side + ':' + row] || null; }
// UI [노선 지정] 목록용 — 양식 좌표(side,row)와 표시용 텍스트만. count_col 등 내부 열 정보는 내보내지 않는다.
function routeList() {
  return ROUTE_LIST.map(function (r) { return { side: r.side, row: r.row, from: r.from, to: r.to, item: r.item }; });
}
// 학습 지정 중복 판정 키 — 같은 (상차지,하차지,품목)이면 덮어쓴다.
// 라이브러리 매칭(normName/normItem)과 '똑같은' 기준으로 비교한다(계약 B-crit). 공백만 지우면
// '스틸싸이클㈜'≠'스틸싸이클'로 갈라져 중복 판정이 실패하고, 두 항목이 공존해 matchRouteEx가
// 첫 항목만 집어 오배정한다. 저장 레코드의 원문(from/to/item)은 그대로 두고 비교값만 정규화한다.
// 구분자(U+0001)는 유지 — 없으면 서로 다른 경계의 문자열이 뭉개진다.
function learnKey(from, to, item) {
  return normName(from) + '\u0001' + normName(to) + '\u0001' + normItem(item);
}

// 운반일지 입력 권한(계약 B-2) — 관리자·개발자가 아니어도 되지만 로그인·기기승인은 필수.
// 핸들러 진입 전에 세션·퇴사·기기승인을 이미 통과한 회원만 여기 온다. 운반일지 탭은 전 직원 공개이고
// 별도 perms 키가 없으므로 게이트는 여기 한 곳뿐이다 — 누가 무엇을 바꿨는지는 appendAudit가 남긴다.
function canEdit(member) { return !!(member && member.id); }

// 미매칭 '건수' 합. aggregate의 unmatched=[{from,to,item,n}] — n이 비면 1건으로 센다(과소집계 방지).
function unmatchedCount(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce(function (a, u) {
    const v = Number(u && u.n);
    return a + (Number.isFinite(v) && v > 0 ? v : 1);
  }, 0);
}

// 퇴사자 차단 — gw-auth/gw-data/gw-hwakwan과 동일 규칙: 퇴사일이 지나면 기존 세션도 거부
function retired(m) {
  const ld = m && m.leave_date;
  if (!ld) return false;
  return String(ld) < kstDate(0);
}
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
// 인가된 기기만 접근(gw-data·gw-hwakwan과 동일). 관리자는 항상 허용.
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}

// 백그라운드 워커 기동 — 내부 토큰(mid='__allbaro__')으로만 인증. 사용자 토큰은 워커에 넘기지 않는다.
async function kickBackground(job, days) {
  const s = issueSession({ id: '__allbaro__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-allbaro-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: 'collect', days: days }),
    });
    // 백그라운드 함수는 즉시 202를 돌려준다 — 2xx/202 아니면 기동 실패
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'KICKOFF_FAILED' };
  }
}

function newJobId(kind) { return 'ab_' + kind + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }

// 기본 수집 창 = 오늘(KST) 포함 최근 7일. 오래된 날짜부터.
// 올바로는 처리자 인수 등록이 며칠 늦게 올라와 과거 날짜 집계가 뒤늦게 바뀐다 → 창을 두고 덮어쓴다.
function defaultDays() {
  const out = [];
  for (let i = DEFAULT_RUN_DAYS - 1; i >= 0; i--) out.push(kstDate(-i));
  return out;
}

// 현황 — UI 상태 카드용. 최근 14일 요약은 각 날짜 blob에서 병렬로 읽는다(10초 한도 안).
async function handleStatus(st, R) {
  const wanted = [];
  for (let i = 0; i < STATUS_DAYS; i++) wanted.push(kstDate(-i));   // 오늘 → 13일 전
  const reads = await Promise.all(
    [blobGet(st, 'allbaro:lastrun')].concat(wanted.map(function (day) { return blobGet(st, dayKey(day)); }))
  );
  const lr = reads[0];
  const days = [];
  for (let i = 0; i < wanted.length; i++) {
    const r = reads[i + 1];
    if (!r || !r.ok || !r.data) continue;   // 아직 수집 안 된 날은 목록에서 뺀다(0건과 구분되게)
    days.push({
      day: wanted[i],
      total: Number(r.data.total) || 0,
      unmatched_n: unmatchedCount(r.data.unmatched),
    });
  }
  return jr(200, {
    ok: true,
    env_ready: envReady(),   // ID·PW 둘 다 있어야 수집 가능(값은 노출하지 않는다)
    lastrun: (lr && lr.ok && lr.data) ? lr.data : null,
    days: days,              // 최신 날짜부터
    routes: routeList(),     // 미매칭 [노선 지정] 목록용 — UI가 노선표를 따로 들고 있으면 반드시 어긋난다
    request_id: R,
  });
}

// 날짜 상세 — blob allbaro:day:<YYYY-MM-DD> 그대로 + 그날 수동분 + 학습 건수(계약 B-2).
// 조회 전용이라 권한 게이트 없음(전 직원). UI가 일지 한 장을 한 번의 왕복으로 그리게 한다.
async function handleDay(st, d, R) {
  const day = cleanStr(d.day);
  if (!RE_DATE.test(day) || !validDay(day)) return jr(400, { ok: false, code: 'BAD_DAY', request_id: R });
  const reads = await Promise.all([blobGet(st, dayKey(day)), blobGet(st, manualKey(day)), blobGet(st, LEARNED_KEY)]);
  const r = reads[0], mr = reads[1], lr = reads[2];
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  // 수동분·학습 blob 읽기 실패를 조용히 '없음'으로 뭉개지 않는다(계약 B-major1).
  // 읽기 실패 시: learned_n=null, manual 필드는 아예 빼고 manual_error를 세워
  // UI가 '없다'와 '못 읽었다'를 구분하게 한다(handleManualGet의 500과 같은 원칙).
  const mdoc = (mr.ok && mr.data && Array.isArray(mr.data.items)) ? mr.data : null;
  const extra = {
    learned_n: lr.ok ? ((lr.data && Array.isArray(lr.data.items)) ? lr.data.items.length : 0) : null,
  };
  if (mr.ok) {
    extra.manual = mdoc ? mdoc.items : [];
    extra.manual_by = mdoc ? String(mdoc.by || '') : '';
    extra.manual_ts = mdoc ? (Number(mdoc.ts) || 0) : 0;
  } else {
    extra.manual_error = true;   // manual 필드 자체를 빼서 '수동분 없음'과 뒤섞이지 않게
  }
  if (!r.data) {
    // 아직 수집 전. 수동분을 정상적으로 읽었을 때만 '있으면 그리고, 없으면 404' 판단이 가능하다.
    if (mr.ok) {
      // 둘 다 없을 때만 종전대로 404(기존 UI의 '아직 수집된 기록이 없습니다' 경로 유지).
      if (!(mdoc && mdoc.items.length)) return jr(404, { ok: false, code: 'DAY_NOT_FOUND', request_id: R });
      return jr(200, Object.assign({ ok: true, request_id: R, day: day, collected: false, total: 0, total_qty_ton: 0, counts: [], unmatched: [] }, extra));
    }
    // 수동분을 못 읽었으면 '아무것도 없다'고 단정할 수 없다 → 404 대신 읽기 실패를 드러낸다.
    return jr(500, { ok: false, code: mr.code, request_id: R });
  }
  return jr(200, Object.assign({ ok: true, request_id: R }, r.data, { collected: true }, extra));
}

// 노선 지정(학습) — 미매칭 조합을 사람이 양식의 어느 줄인지 찍어준다. 다음 수집부터 그 줄로 간다.
// 관리자·개발자가 아니어도 되지만(계약 B-2) 로그인·기기승인은 필수이고, 감사 로그에 남는다.
async function handleLearn(st, c, d, R) {
  if (!canEdit(c.member)) return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const from = cleanStr(d.from), to = cleanStr(d.to), item = cleanStr(d.item);
  const side = cleanStr(d.side).toUpperCase();
  const row = Number(d.row);
  if (!from || !to) return jr(400, { ok: false, code: 'BAD_INPUT', request_id: R });
  if (from.length > MAX_STR || to.length > MAX_STR || item.length > MAX_STR) return jr(400, { ok: false, code: 'STR_TOO_LONG', request_id: R });
  // 노선표에 실재하는 줄만 — 없는 (side,row)를 학습시키면 그 조합이 영영 어디에도 안 실린다
  if ((side !== 'L' && side !== 'R') || !Number.isInteger(row)) return jr(400, { ok: false, code: 'BAD_ROUTE', request_id: R });
  const rt = findRoute(side, row);
  if (!rt) return jr(400, { ok: false, code: 'BAD_ROUTE', request_id: R });

  const r = await blobGet(st, LEARNED_KEY);
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  const items = (r.data && Array.isArray(r.data.items)) ? r.data.items.slice() : [];
  const key = learnKey(from, to, item);
  const rec = { from: from, to: to, item: item, side: side, row: row, by: c.member.name, ts: Date.now() };
  let idx = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && learnKey(it.from, it.to, it.item) === key) { idx = i; break; }
  }
  // 덮어쓰기 대상이 '다른 줄'을 가리키면 이전 지정을 응답에 함께 알린다(계약 B-crit) — 사람이
  // 무심코 남의(또는 자기 예전) 지정을 다른 줄로 갈아끼우는 걸 조용히 넘기지 않고 드러낸다.
  let previous = null;
  if (idx >= 0) {
    const old = items[idx];
    if (old && (old.side !== side || Number(old.row) !== row)) {
      previous = { side: old.side, row: Number(old.row) || old.row, by: String(old.by || ''), ts: Number(old.ts) || 0 };
    }
    items[idx] = rec;                                 // 같은 조합 재지정 → 덮어씀
  } else {
    // 상한 초과 시 오래된 지정을 지우지 않고 거부한다 — 예전에 사람이 찍어둔 대응이 조용히 풀리면
    // 그 조합이 다음 수집부터 말없이 미매칭(또는 다른 줄)으로 돌아간다.
    if (items.length >= MAX_LEARNED) return jr(400, { ok: false, code: 'LEARN_FULL', request_id: R });
    items.push(rec);
  }
  const w = await blobSet(st, LEARNED_KEY, { schema: 1, items: items, updated_at: Date.now() });
  if (!w.ok) return jr(500, { ok: false, code: w.code, request_id: R });
  try {
    const prevNote = previous ? ' (이전 ' + previous.side + previous.row + ' 대체)' : '';
    await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'allbaro',
      ev: [{ op: '노선지정', id: side + row, t: from + ' → ' + to + (item ? ' · ' + item : '') + ' ⇒ ' + side + row + ' ' + rt.item + prevNote }] });
  } catch (e) {}
  const out = { ok: true, learned_n: items.length, route: { side: rt.side, row: rt.row, from: rt.from, to: rt.to, item: rt.item }, request_id: R };
  if (previous) out.previous = previous;   // UI가 '다른 줄을 덮었다'를 사람에게 확인시키게
  return jr(200, out);
}

// 수동 입력 항목 검증 — 통과한 값만 새 객체로 다시 만든다(클라이언트가 보낸 여분 필드는 저장하지 않는다).
// 실패는 코드로 되돌려 UI가 어느 규칙에 걸렸는지 사람에게 보여줄 수 있게 한다.
function parseManualItems(raw) {
  if (!Array.isArray(raw)) return { ok: false, code: 'BAD_ITEMS' };
  if (raw.length > MAX_MANUAL_ITEMS) return { ok: false, code: 'TOO_MANY_ITEMS' };
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, code: 'BAD_ITEM' };
    const pid = cleanStr(x.route_id);
    if (pid && !RE_PRESET_ID.test(pid)) return { ok: false, code: 'BAD_ROUTE_ID' };
    const from = cleanStr(x.from), to = cleanStr(x.to), item = cleanStr(x.item), memo = cleanStr(x.memo);
    if (!from || !to) return { ok: false, code: 'BAD_ITEM' };
    if (from.length > MAX_STR || to.length > MAX_STR || item.length > MAX_STR || memo.length > MAX_MEMO) return { ok: false, code: 'STR_TOO_LONG' };
    const n = num0(x.n);
    // 회수는 정수만 — 2.5회 같은 값을 반올림해 저장하면 사람이 넣은 값과 일지가 달라진다(거부해 드러낸다)
    if (n === null || !Number.isInteger(n) || n > MAX_N) return { ok: false, code: 'BAD_N' };
    const q = num0(x.qty_ton);
    if (q === null || q > MAX_QTY_TON) return { ok: false, code: 'BAD_QTY' };
    out.push({ route_id: pid, from: from, to: to, item: item, n: n, qty_ton: round3(q), memo: memo });
  }
  return { ok: true, items: out };
}

// 수동 추가분 조회 — 없으면 빈 목록(404 아님). 조회 전용이라 권한 게이트 없음.
async function handleManualGet(st, d, R) {
  const day = cleanStr(d.day);
  if (!RE_DATE.test(day) || !validDay(day)) return jr(400, { ok: false, code: 'BAD_DAY', request_id: R });
  const r = await blobGet(st, manualKey(day));
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  const doc = (r.data && Array.isArray(r.data.items)) ? r.data : null;
  return jr(200, { ok: true, day: day, items: doc ? doc.items : [], by: doc ? String(doc.by || '') : '', ts: doc ? (Number(doc.ts) || 0) : 0, request_id: R });
}

// 수동 추가분 저장 — 그날 목록 통째 교체(UI가 카드 상태 전체를 보낸다). 빈 배열은 '그날 수동분 없음'.
async function handleManualPut(st, c, d, R) {
  if (!canEdit(c.member)) return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const day = cleanStr(d.day);
  if (!RE_DATE.test(day) || !validDay(day)) return jr(400, { ok: false, code: 'BAD_DAY', request_id: R });
  // 범위 — 미래 날짜와 60일 이전은 막는다(blob 키 무한 증식·오타 방지). 수집 창과 같은 폭.
  if (day < kstDate(-MANUAL_BACK_DAYS) || day > kstDate(0)) return jr(400, { ok: false, code: 'DAY_RANGE', request_id: R });
  const p = parseManualItems(d.items);
  if (!p.ok) return jr(400, { ok: false, code: p.code, request_id: R });
  // 경합 보호(계약 B-major2) — 그날 목록을 '통째 교체'하므로, UI가 읽은 뒤 다른 사람이 저장했다면
  // 이 저장은 남의 편집을 통째로 지운다. 저장 전에 현재 문서를 읽어 base_ts와 대조한다.
  const cur = await blobGet(st, manualKey(day));
  if (!cur.ok) return jr(500, { ok: false, code: cur.code, request_id: R });
  const curDoc = (cur.data && Array.isArray(cur.data.items)) ? cur.data : null;
  const curTs = curDoc ? (Number(curDoc.ts) || 0) : 0;
  if (d.base_ts !== undefined && d.base_ts !== null) {
    // base_ts가 현재 ts와 다르면(누군가 먼저 저장) 덮지 말고 409 — UI가 다시 읽고 재시도한다.
    if (Number(d.base_ts) !== curTs) return jr(409, { ok: false, code: 'CONFLICT', ts: curTs, request_id: R });
  }
  const prevN = curDoc ? curDoc.items.length : 0;
  const doc = { schema: 1, day: day, items: p.items, by: c.member.name, bid: c.member.id, ts: Date.now() };
  const w = await blobSet(st, manualKey(day), doc);
  if (!w.ok) return jr(500, { ok: false, code: w.code, request_id: R });
  try {
    const n = p.items.reduce(function (a, it) { return a + it.n; }, 0);
    // 줄 수가 줄었으면(삭제 발생) 감사 로그에 이전→현재를 남겨 '무엇이 지워졌는지' 드러낸다.
    const shrink = (prevN > p.items.length) ? ' · 이전 ' + prevN + '줄→' + p.items.length + '줄' : '';
    await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'allbaro',
      ev: [{ op: '수동입력', id: day, t: day + ' · ' + p.items.length + '줄 · ' + n + '회' + shrink }] });
  } catch (e) {}
  return jr(200, { ok: true, day: day, n: p.items.length, ts: doc.ts, request_id: R });
}

// 단골 노선 카드 검증 — id는 UI가 준 값을 쓰되 형식을 강제하고, 없으면 서버가 만든다.
function parsePresetItems(raw) {
  if (!Array.isArray(raw)) return { ok: false, code: 'BAD_ITEMS' };
  if (raw.length > MAX_PRESETS) return { ok: false, code: 'TOO_MANY_ITEMS' };
  const out = [];
  const seen = Object.create(null);   // 프로토타입 없는 사전 — '__proto__' 같은 id로 우회 불가
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, code: 'BAD_ITEM' };
    let id = cleanStr(x.id);
    if (!id) id = 'p_' + crypto.randomBytes(6).toString('hex');
    if (!RE_PRESET_ID.test(id)) return { ok: false, code: 'BAD_PRESET_ID' };
    if (seen[id]) return { ok: false, code: 'DUP_PRESET_ID' };   // 같은 id 두 장이면 수동분이 어느 카드 것인지 흐려진다
    seen[id] = 1;
    const from = cleanStr(x.from), to = cleanStr(x.to), item = cleanStr(x.item), unit = cleanStr(x.unit);
    if (!from || !to) return { ok: false, code: 'BAD_ITEM' };
    if (from.length > MAX_STR || to.length > MAX_STR || item.length > MAX_STR || unit.length > MAX_UNIT) return { ok: false, code: 'STR_TOO_LONG' };
    out.push({ id: id, from: from, to: to, item: item, unit: unit });
  }
  return { ok: true, items: out };
}

// 단골 노선 카드 조회 — 회사 공용. 조회는 전 직원.
async function handlePresetsGet(st, R) {
  const r = await blobGet(st, PRESETS_KEY);
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  const doc = (r.data && Array.isArray(r.data.items)) ? r.data : null;
  return jr(200, { ok: true, items: doc ? doc.items : [], by: doc ? String(doc.by || '') : '', ts: doc ? (Number(doc.ts) || 0) : 0, request_id: R });
}

// 단골 노선 카드 저장 — 목록 통째 교체. 공용 자산이라 누가 바꿨는지 감사 로그에 남긴다.
async function handlePresetsPut(st, c, d, R) {
  if (!canEdit(c.member)) return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  const p = parsePresetItems(d.items);
  if (!p.ok) return jr(400, { ok: false, code: p.code, request_id: R });
  // 경합 보호(계약 B-major2) — 공용 카드를 '통째 교체'하므로, UI가 읽은 뒤 다른 사람이 저장했다면
  // 이 저장은 남의 편집을 통째로 지운다. 저장 전에 현재 문서를 읽어 base_ts와 대조한다.
  const cur = await blobGet(st, PRESETS_KEY);
  if (!cur.ok) return jr(500, { ok: false, code: cur.code, request_id: R });
  const curDoc = (cur.data && Array.isArray(cur.data.items)) ? cur.data : null;
  const curTs = curDoc ? (Number(curDoc.ts) || 0) : 0;
  if (d.base_ts !== undefined && d.base_ts !== null) {
    // base_ts가 현재 ts와 다르면(누군가 먼저 저장) 덮지 말고 409 — UI가 다시 읽고 재시도한다.
    if (Number(d.base_ts) !== curTs) return jr(409, { ok: false, code: 'CONFLICT', ts: curTs, request_id: R });
  }
  // 제거되는 카드 id 산출 — 감사 로그에 남겨 '누가 무엇을 지웠는지' 드러낸다.
  const nextIds = Object.create(null);
  p.items.forEach(function (it) { nextIds[it.id] = 1; });
  const removed = (curDoc ? curDoc.items : []).map(function (it) { return String((it && it.id) || ''); })
    .filter(function (id) { return id && !nextIds[id]; });
  const doc = { schema: 1, items: p.items, by: c.member.name, bid: c.member.id, ts: Date.now() };
  // 직전 문서 1벌 보존 — 통째 교체가 실수였을 때 사람이 복구할 근거. 실패해도 본 저장은 계속.
  if (curDoc) { try { await blobSet(st, PRESETS_PREV_KEY, curDoc); } catch (e) {} }
  const w = await blobSet(st, PRESETS_KEY, doc);
  if (!w.ok) return jr(500, { ok: false, code: w.code, request_id: R });
  try {
    const rmNote = removed.length ? ' · 제거 ' + removed.length + '개(' + removed.slice(0, 10).join(', ') + (removed.length > 10 ? '…' : '') + ')' : '';
    await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'allbaro',
      ev: [{ op: '단골노선', id: 'presets', t: p.items.length + '개 저장' + rmNote }] });
  } catch (e) {}
  return jr(200, { ok: true, n: p.items.length, items: p.items, ts: doc.ts, request_id: R });
}

// 수동 수집 — 관리자 또는 개발자만. 날짜는 정규식+달력 왕복 검증, 오늘−60일~오늘, 최대 14개.
async function handleRunNow(st, c, d, R) {
  if (!(c.member.admin || c.member.dev)) return jr(403, { ok: false, code: 'ADMIN_ONLY', request_id: R });
  if (!envReady()) return jr(400, { ok: false, code: 'ENV_MISSING', request_id: R });   // 빠른 실패 — 워커도 재차 방어
  let days;
  if (d.days !== undefined) {
    if (!Array.isArray(d.days) || !d.days.length || d.days.length > MAX_RUN_DAYS) return jr(400, { ok: false, code: 'BAD_DAYS', request_id: R });
    const lo = kstDate(-RUN_BACK_DAYS), hi = kstDate(0);
    const seen = Object.create(null);
    days = [];
    for (const raw of d.days) {
      const s = String(raw || '').trim();
      if (!RE_DATE.test(s) || !validDay(s)) return jr(400, { ok: false, code: 'BAD_DAYS', request_id: R });
      if (s < lo || s > hi) return jr(400, { ok: false, code: 'DAYS_RANGE', request_id: R });   // 미래·60일 이전 금지
      if (seen[s]) continue;   // 중복 제거 — 같은 날을 두 번 긁을 이유가 없다
      seen[s] = 1;
      days.push(s);
    }
    days.sort();
  } else {
    days = defaultDays();
  }
  // 동시 실행 잠금 — 같은 올바로 계정으로 워커 둘이 붙으면 뒤 세션이 앞 세션을 무효화해
  // 멀쩡한 수집이 '실패'로 뜬다(허위 알림 + 불필요한 외부 부하). 10분 뒤 자동 해제(워커가 죽어도 영구 잠금 없음).
  const lk = await blobGet(st, 'allbaro:lock');
  if (lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < 10 * 60 * 1000) {
    return jr(409, { ok: false, code: 'ALREADY_RUNNING', job: String(lk.data.job || ''), request_id: R });
  }
  const job = newJobId('run');
  await blobSet(st, 'allbaro:lock', { ts: Date.now(), job: job });
  // 기동 전 'queued' 선기록 — 워커 기동 직후 UI 폴링이 404를 보지 않게
  await blobSet(st, jobKey(job), { ts: Date.now(), status: 'queued', mode: 'collect', by: c.member.name, days_req: days });
  const k = await kickBackground(job, days);
  if (!k.ok) {
    await blobSet(st, jobKey(job), { ts: Date.now(), status: 'fail', mode: 'collect', by: c.member.name, code: k.code, days_req: days });
    try { await blobSet(st, 'allbaro:lock', { ts: 0, job: '' }); } catch (e) {}   // 기동 실패면 잠금 즉시 해제
    return jr(500, { ok: false, code: k.code, request_id: R });
  }
  // 감사 로그 — 외부 사이트 접속을 유발하는 작업이라 누가 눌렀는지 남긴다(실패해도 본 작업 계속)
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'allbaro', ev: [{ op: '수동수집', id: job, t: days.join(', ') }] }); } catch (e) {}
  return jr(200, { ok: true, job: job, days: days, request_id: R });
}

// 작업 조회 — blob allbaro:job:<id> 그대로(UI가 2초 간격 폴링).
async function handleJob(st, d, R) {
  const job = String(d.job || '').trim();
  if (!RE_JOB.test(job)) return jr(400, { ok: false, code: 'BAD_JOB', request_id: R });
  const r = await blobGet(st, jobKey(job));
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  if (!r.data) return jr(404, { ok: false, code: 'JOB_NOT_FOUND', request_id: R });
  return jr(200, Object.assign({ ok: true, request_id: R }, r.data));
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { ok: false, code: 'INVALID_JSON', request_id: R }); }
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { ok: false, code: c.reason || 'NO_SESSION', request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { ok: false, code: 'DEVICE_NOT_APPROVED', request_id: R });
  const st = store(DATA);
  try {
    switch (d && d.action) {
      case 'ab_status': return await handleStatus(st, R);
      case 'ab_day': return await handleDay(st, d, R);
      case 'ab_run_now': return await handleRunNow(st, c, d, R);
      case 'ab_job': return await handleJob(st, d, R);
      case 'ab_learn': return await handleLearn(st, c, d, R);
      case 'ab_manual_get': return await handleManualGet(st, d, R);
      case 'ab_manual_put': return await handleManualPut(st, c, d, R);
      case 'ab_presets_get': return await handlePresetsGet(st, R);
      case 'ab_presets_put': return await handlePresetsPut(st, c, d, R);
      default: return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    // 예외 문구를 그대로 돌려주지 않는다 — 하류 라이브러리 메시지에 요청 정보가 섞일 수 있다.
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
