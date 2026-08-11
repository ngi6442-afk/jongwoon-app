'use strict';

// 화관법(화학물질관리법) 운반계획서 자동 제출 — 사용자 API.
// 제품 노선: 크론(gw-hwakwan-cron)이 매일 07:30 KST에 D+2분을 자동 제출.
// 폐기물 노선: 앱 UI 3단계 입력(차량→시나리오→시간) 후 이 API로 제출.
// 실제 제출은 15분 한도 백그라운드 워커(gw-hwakwan-run-background)가 수행하고,
// 이 함수는 검증·기동·조회만 한다(일반 함수 10초 한도 안에서 끝나는 일만).
// 자격증명은 Netlify 환경변수 GW_ICIS_ID / GW_ICIS_PW — 코드·저장소엔 절대 없다.
// 제출은 정부 규제 민원이라 되돌릴 수 없다 — 여기서 입력을 화이트리스트로 걸러 잘못된 기동 자체를 막는다.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { issueSession, verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const { SCENARIOS, WASTE_VEHICLES } = require('./_lib/icis');

const DATA = 'gw_data';
const USERS = 'gw_users';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function jobKey(id) { return `hwakwan:job:${id}`; }
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_JOB = /^hw_[a-z0-9_-]{1,60}$/i;
// 달력 왕복 검증 — 정규식만으로는 2026-02-30 같은 불가능 날짜가 통과해
// 하류(icis parseDt)에서 이월되거나 거부된다(V2 검토 2026-08-11). 여기서 조기 차단.
function validDay(s) {
  const p = String(s).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
}

// KST 일자 문자열(YYYY-MM-DD). offsetDays만큼 이동.
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }
function envReady() { return !!(process.env.GW_ICIS_ID && process.env.GW_ICIS_PW); }

// 퇴사자 차단 — gw-auth/gw-data와 동일 규칙: 퇴사일(leave_date)이 지나면 기존 세션도 거부
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
// 인가된 기기만 접근(gw-data와 동일). 관리자는 항상 허용.
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}

// 백그라운드 워커 기동 — 내부 토큰(mid='__hwakwan__')으로만 인증. 사용자 토큰은 워커에 넘기지 않는다.
async function kickBackground(job, mode, params) {
  const s = issueSession({ id: '__hwakwan__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-hwakwan-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: mode, params: params }),
    });
    // 백그라운드 함수는 즉시 202를 돌려준다 — 2xx/202 아니면 기동 실패
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'KICKOFF_FAILED' };
  }
}

function newJobId(kind) { return 'hw_' + kind + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }

// 크론과 같은 요일 규칙(월~목 [D+2], 금 [D+2,D+3,D+4]). 수동 실행이 주말에 눌리면 [D+2] 하나로.
function defaultTargetDays() {
  const day = new Date(Date.now() + 9 * 3600000).getUTCDay();   // KST 요일: 0=일 … 6=토
  const offs = (day === 5) ? [2, 3, 4] : [2];
  return offs.map(kstDate);
}

// 현황 — UI 상태 카드용. lastrun은 워커가 갱신하는 blob 그대로.
async function handleStatus(st, R) {
  const lr = await blobGet(st, 'hwakwan:lastrun');
  return jr(200, {
    ok: true,
    env_ready: envReady(),   // ID·PW 둘 다 있어야 실제 제출 가능
    lastrun: (lr.ok && lr.data) ? lr.data : null,
    scenarios: SCENARIOS,
    vehicles: WASTE_VEHICLES,
    request_id: R,
  });
}

// 폐기물 노선 제출 — 차량·시나리오는 화이트리스트, 날짜는 KST 오늘~+14일, 시간은 HH:MM만.
async function handleWasteSubmit(st, c, d, R) {
  const vehicleNo = String(d.vehicleNo || '').trim();
  const scenario = String(d.scenario || '').trim();
  const date = String(d.date || '').trim();
  const time = String(d.time || '').trim();
  if (WASTE_VEHICLES.indexOf(vehicleNo) < 0) return jr(400, { ok: false, code: 'BAD_VEHICLE', request_id: R });
  if (!Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) return jr(400, { ok: false, code: 'BAD_SCENARIO', request_id: R });
  if (!RE_DATE.test(date) || !validDay(date)) return jr(400, { ok: false, code: 'BAD_DATE', request_id: R });
  if (date < kstDate(0) || date > kstDate(14)) return jr(400, { ok: false, code: 'DATE_RANGE', request_id: R });   // 과거·15일 이후 금지
  if (!RE_TIME.test(time)) return jr(400, { ok: false, code: 'BAD_TIME', request_id: R });
  if (!envReady()) return jr(400, { ok: false, code: 'ENV_MISSING', request_id: R });   // 빠른 실패 — 워커도 재차 방어
  const job = newJobId('waste');
  const params = { vehicleNo: vehicleNo, scenario: scenario, date: date, time: time };
  // 기동 전 'queued' 선기록 — 워커 기동 직후 UI 폴링이 404를 보지 않게
  await blobSet(st, jobKey(job), { ts: Date.now(), status: 'queued', mode: 'waste', by: c.member.name, params: params });
  const k = await kickBackground(job, 'waste', params);
  if (!k.ok) {
    await blobSet(st, jobKey(job), { ts: Date.now(), status: 'fail', mode: 'waste', by: c.member.name, code: k.code, params: params });
    return jr(500, { ok: false, code: k.code, request_id: R });
  }
  // 감사 로그 — 정부 민원 제출 요청은 누가 눌렀는지 남긴다(실패해도 본 작업 계속)
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'hwakwan', ev: [{ op: '폐기물제출요청', id: job, t: vehicleNo + ' · ' + (SCENARIOS[scenario] && SCENARIOS[scenario].label || scenario) + ' · ' + date + ' ' + time }] }); } catch (e) {}
  return jr(200, { ok: true, job: job, request_id: R });
}

// 제품 노선 수동 실행 — 관리자 또는 개발자만.
async function handleRunNow(st, c, d, R) {
  if (!(c.member.admin || c.member.dev)) return jr(403, { ok: false, code: 'ADMIN_ONLY', request_id: R });
  if (!envReady()) return jr(400, { ok: false, code: 'ENV_MISSING', request_id: R });
  let days;
  if (d.days !== undefined) {
    if (!Array.isArray(d.days) || !d.days.length || d.days.length > 7) return jr(400, { ok: false, code: 'BAD_DAYS', request_id: R });
    days = d.days.map(function (s) { return String(s || '').trim(); });
    for (const s of days) {
      if (!RE_DATE.test(s) || !validDay(s)) return jr(400, { ok: false, code: 'BAD_DAYS', request_id: R });
      if (s < kstDate(0) || s > kstDate(30)) return jr(400, { ok: false, code: 'DAYS_RANGE', request_id: R });
    }
  } else {
    days = defaultTargetDays();
  }
  const job = newJobId('run');
  const params = { targetDays: days };
  await blobSet(st, jobKey(job), { ts: Date.now(), status: 'queued', mode: 'daily', by: c.member.name, params: params });
  const k = await kickBackground(job, 'daily', params);
  if (!k.ok) {
    await blobSet(st, jobKey(job), { ts: Date.now(), status: 'fail', mode: 'daily', by: c.member.name, code: k.code, params: params });
    return jr(500, { ok: false, code: k.code, request_id: R });
  }
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'hwakwan', ev: [{ op: '수동실행', id: job, t: days.join(', ') }] }); } catch (e) {}
  return jr(200, { ok: true, job: job, days: days, request_id: R });
}

// 작업 조회 — blob hwakwan:job:<id> 그대로(UI가 2초 간격 폴링).
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
      case 'hw_status': return await handleStatus(st, R);
      case 'hw_waste_submit': return await handleWasteSubmit(st, c, d, R);
      case 'hw_run_now': return await handleRunNow(st, c, d, R);
      case 'hw_job': return await handleJob(st, d, R);
      default: return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
