'use strict';

// 홍보 기록 사진 → AI 초안 생성(계약서 B절) — 사용자 API.
// 실제 생성(사진 업로드·모델 호출)은 15분 한도 백그라운드 워커(gw-promo-ai-run-background)가 하고,
// 이 함수는 조회·입력검증·기동만 한다(일반 함수 10초 한도 안에서 끝나는 일만).
// 화관법·올바로와 같은 골격: 내부 토큰(mid='__promoai__') · job blob · UI 폴링.
//
// API 키는 Netlify 환경변수 GW_ANTHROPIC_KEY — 이 함수는 값을 읽지 않는다(존재 여부만 확인).
// 값은 워커만 env에서 직접 읽고, 로그·응답·blob 어디에도 남기지 않는다.
//
// 계약 세부정보 차단(계약서 '절대 규칙') — 이 파일의 몫:
//   이 함수는 계약 레코드에서 **id 외의 어떤 필드도 읽지 않는다**(존재 확인만 한다).
//   금액·발주처·입찰번호·단계·기한은 여기서 어떤 변수·객체·응답에도 담기지 않으므로
//   워커로 넘어갈 경로 자체가 없다. 프롬프트에 "말하지 마라"라고 쓰는 방식은 쓰지 않는다.
//   공종·시설 화이트리스트 추출(contractPublicView)은 워커에서 한 번만 일어난다.
//
// 결과는 promo 레코드에 직접 쓰지 않는다 — job blob에만 담고 UI가 검수 화면에 채운다(사람 승인 전 저장 금지).
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { issueSession, verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');

const DATA = 'gw_data';
const USERS = 'gw_users';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function jobKey(id) { return `promoai:job:${id}`; }
function lockKey(promoId) { return `promoai:lock:${promoId}`; }
const USAGE_KEY = 'promoai:usage';        // 월 누적 사용량(예산 감시용) — 워커가 쓰고, 여기선 읽기만
const RE_JOB = /^pa_[a-z0-9_-]{1,60}$/i;
// 레코드 id는 genId(prefix)=prefix+base36 시각+난수 5자. promo_id는 잠금 blob 키가 되므로
// 경로·제어문자가 섞이지 못하게 문자 집합을 좁힌다(계약 id는 배열 조회에만 쓰인다).
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;

const MAX_PHOTOS = 10;                    // 비용 상한(계약서 A절) — 초과분은 앞 10장만, 사유를 job에 남긴다
const LOCK_TTL_MS = 5 * 60 * 1000;        // 같은 기록 동시 생성 잠금(5분 뒤 자동 만료 — 워커가 죽어도 영구 잠금 없음)
// 월 호출 상한 — 유료 API라 무한 증식을 막는다(올바로 MAX_LEARNED와 같은 취지).
// 실사용(주 3~5건)의 몇 배로 잡되, 사고성 반복 호출은 여기서 멈춘다. 넘으면 조용히 줄이지 않고 거부한다.
const MONTH_CALL_CAP = 500;
const RE_ATT = /^att_[a-f0-9]{16}$/i;     // gw-data att_put이 만드는 첨부 id 형식

// KST 일자·월 문자열
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }
function kstMonth() { return kstDate(0).slice(0, 7); }
// 값이 아니라 존재 여부만 본다 — 값은 절대 읽어서 돌려주지 않는다.
function envReady() { return !!process.env.GW_ANTHROPIC_KEY; }

// 퇴사자 차단 — gw-auth/gw-data/gw-hwakwan/gw-allbaro와 동일 규칙
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
// 인가된 기기만 접근(gw-data·gw-hwakwan·gw-allbaro와 동일). 관리자는 항상 허용.
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}
// 홍보 권한 — gw-data permOf와 같은 규칙(홍보는 기본 숨김, 명시 부여만). 생성은 'do'만.
function promoPerm(member) {
  if (member && member.admin) return 'do';
  return (member && member.perms && member.perms.promo) || 'hide';
}

// 백그라운드 워커 기동 — 내부 토큰(mid='__promoai__')으로만 인증. 사용자 토큰은 워커에 넘기지 않는다.
// 본문에는 id 2개와 상한만 싣는다 — promo·계약 레코드 내용은 워커가 blob에서 직접 읽는다(경로 최소화).
async function kickBackground(job, promoId, contractId, maxPhotos) {
  const s = issueSession({ id: '__promoai__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-promo-ai-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: 'draft', promo_id: promoId, contract_id: contractId || '', max_photos: maxPhotos }),
    });
    // 백그라운드 함수는 즉시 202를 돌려준다 — 2xx/202 아니면 기동 실패
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'KICKOFF_FAILED' };
  }
}

function newJobId() { return 'pa_gen_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }

// 이번 달 사용량 — 예산 감시 카드용. 값이 없으면 0으로 본다(집계 실패와 구분이 필요하면 ok로 판단).
function monthUsage(doc, month) {
  const m = (doc && doc.months && typeof doc.months === 'object') ? doc.months[month] : null;
  const n = function (v) { const x = Number(v); return (Number.isFinite(x) && x >= 0) ? Math.floor(x) : 0; };
  return { month: month, calls: n(m && m.calls), input: n(m && m.input), output: n(m && m.output), total: n(m && m.total) };
}

// 현황 — UI가 [사진으로 다시 쓰기] 버튼을 안내로 바꿀지 판단하는 근거.
// env_ready=false면 앱은 기존 변형 생성기로 그대로 동작한다(계약서 C절 '예비로 유지').
async function handleStatus(st, R) {
  const u = await blobGet(st, USAGE_KEY);
  return jr(200, {
    ok: true,
    env_ready: envReady(),               // 키 존재 여부만(값은 노출하지 않는다)
    usage: u.ok ? monthUsage(u.data, kstMonth()) : null,   // 읽기 실패는 null — '0건'과 구분되게
    month_cap: MONTH_CALL_CAP,
    max_photos: MAX_PHOTOS,
    request_id: R,
  });
}

// 사진 목록 정리 — 형식이 맞는 첨부 id만, 중복 제거, 앞 MAX_PHOTOS장.
// 실제 첨부 존재·종류(kind='promo')·용량 검증은 워커가 한다(여기서 gw_files를 10번 읽으면 10초 한도가 위태롭다).
function pickPhotoIds(rec) {
  const raw = (rec && Array.isArray(rec.photos)) ? rec.photos : [];
  const seen = Object.create(null);
  const ids = [];
  for (const p of raw) {
    const id = String((p && p.id) || '').trim();
    if (!RE_ATT.test(id) || seen[id]) continue;
    seen[id] = 1;
    ids.push(id);
  }
  return { total: ids.length, use: ids.slice(0, MAX_PHOTOS) };
}

// 생성 기동 — pa_generate {promo_id, contract_id?}
async function handleGenerate(st, c, d, R) {
  if (promoPerm(c.member) !== 'do') return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });
  if (!envReady()) return jr(400, { ok: false, code: 'ENV_MISSING', request_id: R });   // 빠른 실패 — 워커도 재차 방어

  const promoId = String(d.promo_id || '').trim();
  const contractId = String(d.contract_id || '').trim();
  if (!RE_REC_ID.test(promoId)) return jr(400, { ok: false, code: 'BAD_PROMO_ID', request_id: R });
  if (contractId && !RE_REC_ID.test(contractId)) return jr(400, { ok: false, code: 'BAD_CONTRACT_ID', request_id: R });

  // 홍보 기록 — 사진 목록만 여기서 본다(본문·지역 등은 워커가 읽는다).
  const pr = await blobGet(st, 'col:promo');
  if (!pr.ok) return jr(500, { ok: false, code: pr.code, request_id: R });
  const promoItems = (pr.data && Array.isArray(pr.data.items)) ? pr.data.items : [];
  const rec = promoItems.filter(function (it) { return it && it.id === promoId && it.del !== 1; })[0] || null;
  if (!rec) return jr(404, { ok: false, code: 'PROMO_NOT_FOUND', request_id: R });
  const ph = pickPhotoIds(rec);
  if (!ph.use.length) return jr(400, { ok: false, code: 'NO_PHOTOS', request_id: R });

  // 계약 참조는 '있다/없다'만 확인한다 — 레코드에서 읽는 필드는 id 하나뿐이다.
  // (금액·발주처·입찰번호·단계는 이 함수의 어떤 변수에도 들어오지 않는다.)
  if (contractId) {
    const cr = await blobGet(st, 'col:contracts');
    if (!cr.ok) return jr(500, { ok: false, code: cr.code, request_id: R });
    const citems = (cr.data && Array.isArray(cr.data.items)) ? cr.data.items : [];
    const exists = citems.some(function (it) { return it && it.id === contractId && it.del !== 1; });
    if (!exists) return jr(404, { ok: false, code: 'CONTRACT_NOT_FOUND', request_id: R });
  }

  // 월 예산 상한 — 넘으면 조용히 줄이지 않고 거부한다(사람이 보고 판단할 일).
  const ur = await blobGet(st, USAGE_KEY);
  if (ur.ok) {
    const mu = monthUsage(ur.data, kstMonth());
    if (mu.calls >= MONTH_CALL_CAP) return jr(429, { ok: false, code: 'BUDGET_CAP', usage: mu, month_cap: MONTH_CALL_CAP, request_id: R });
  }

  // 같은 기록 동시 생성 잠금 — 두 사람이 같은 카드에서 버튼을 누르면 같은 사진으로 두 번 과금된다.
  // 5분 뒤 자동 만료(워커가 죽어도 영구 잠금 없음). 워커는 '자기 job의 잠금'일 때만 해제한다.
  const lk = await blobGet(st, lockKey(promoId));
  if (lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < LOCK_TTL_MS) {
    return jr(409, { ok: false, code: 'ALREADY_RUNNING', job: String(lk.data.job || ''), request_id: R });
  }

  const job = newJobId();
  await blobSet(st, lockKey(promoId), { ts: Date.now(), job: job });
  // 기동 전 'queued' 선기록 — 워커 기동 직후 UI 폴링이 404를 보지 않게
  const base = { ts: Date.now(), mode: 'draft', by: c.member.name, promo_id: promoId, contract_id: contractId,
    photo_n: ph.use.length, photo_total: ph.total, photo_capped: ph.total > ph.use.length };
  await blobSet(st, jobKey(job), Object.assign({ status: 'queued' }, base));
  const k = await kickBackground(job, promoId, contractId, MAX_PHOTOS);
  if (!k.ok) {
    await blobSet(st, jobKey(job), Object.assign({ status: 'fail', code: k.code }, base));
    try { await blobSet(st, lockKey(promoId), { ts: 0, job: '' }); } catch (e) {}   // 기동 실패면 잠금 즉시 해제
    return jr(500, { ok: false, code: k.code, request_id: R });
  }
  // 감사 로그 — 유료 외부 호출을 유발하는 작업이라 누가 눌렀는지 남긴다(실패해도 본 작업 계속).
  // 계약 참조는 '있음'만 남긴다 — 감사 로그도 계약 세부정보를 옮기는 통로가 되지 않게.
  try {
    await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo',
      ev: [{ op: '사진AI초안', id: job, t: promoId + ' · 사진 ' + ph.use.length + '장' + (ph.total > ph.use.length ? '(총 ' + ph.total + '장 중 앞 ' + MAX_PHOTOS + '장)' : '') + (contractId ? ' · 계약 참조 있음' : '') }] });
  } catch (e) {}
  return jr(200, { ok: true, job: job, photo_n: ph.use.length, photo_total: ph.total, photo_capped: ph.total > ph.use.length, request_id: R });
}

// 작업 조회 — blob promoai:job:<id> 그대로(UI가 2초 간격 폴링).
// 결과 제목·본문이 여기 실려 오고, 저장은 사람이 검수 화면에서 확인한 뒤에만 한다.
async function handleJob(st, c, d, R) {
  if (promoPerm(c.member) === 'hide') return jr(403, { ok: false, code: 'NO_ACCESS', request_id: R });
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
      case 'pa_status': return await handleStatus(st, R);
      case 'pa_generate': return await handleGenerate(st, c, d, R);
      case 'pa_job': return await handleJob(st, c, d, R);
      default: return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    // 예외 문구를 그대로 돌려주지 않는다 — 하류 라이브러리 메시지에 요청 정보가 섞일 수 있다.
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
