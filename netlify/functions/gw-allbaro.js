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

const DATA = 'gw_data';
const USERS = 'gw_users';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function jobKey(id) { return `allbaro:job:${id}`; }
function dayKey(day) { return `allbaro:day:${day}`; }
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_JOB = /^ab_[a-z0-9_-]{1,60}$/i;
const STATUS_DAYS = 14;   // 상태 카드에 보여줄 최근 일수
const MAX_RUN_DAYS = 14;  // 한 번에 수집 요청 가능한 최대 날짜 수
const RUN_BACK_DAYS = 60; // 소급 허용 한도(오늘−60일)
const DEFAULT_RUN_DAYS = 7; // 기본 수집 창(오늘 포함 최근 7일) — 크론과 동일

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
    request_id: R,
  });
}

// 날짜 상세 — blob allbaro:day:<YYYY-MM-DD> 그대로. 조회 전용이라 권한 게이트 없음(전 직원).
async function handleDay(st, d, R) {
  const day = String(d.day || '').trim();
  if (!RE_DATE.test(day) || !validDay(day)) return jr(400, { ok: false, code: 'BAD_DAY', request_id: R });
  const r = await blobGet(st, dayKey(day));
  if (!r.ok) return jr(500, { ok: false, code: r.code, request_id: R });
  if (!r.data) return jr(404, { ok: false, code: 'DAY_NOT_FOUND', request_id: R });
  return jr(200, Object.assign({ ok: true, request_id: R }, r.data));
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
      default: return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    // 예외 문구를 그대로 돌려주지 않는다 — 하류 라이브러리 메시지에 요청 정보가 섞일 수 있다.
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
