'use strict';

// 그룹웨어 인증 + 회원관리 (서버측). Netlify Blobs 'gw_users' 저장.
// 회원: member:<id> = {id,name,role,rank,dept,admin,perms,pin_salt,pin_hash,created,updated,del} — role=직책(권한), rank=직급, dept=부서
//       name:<lower> = id  (이름 인덱스)
// PIN은 scrypt 해시로만 저장(평문 저장 안 함). 세션은 HMAC 토큰.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { hashSecret, verifySecret } = require('./_lib/password');
const { issueSession, verifyToken, bearer } = require('./_lib/session');
const { appendAudit, short } = require('./_lib/audit');

const USERS = 'gw_users';
const MODULES = ['tasks', 'veh', 'rec', 'lic', 'check', 'con', 'cli', 'doc', 'wk', 'quote', 'promo'];   // wk(일용직) 누락으로 cleanPerms가 매 저장마다 버려 숨김·수행 설정이 불가능했음(프런트 레지스트리와 일치 필수). quote=견적서·promo=홍보(둘 다 기본 숨김 — 명시 부여만)
const LOCK_THRESHOLD = 5;                 // 연속 실패 허용 횟수
const LOCK_MS = 15 * 60 * 1000;           // 잠금 시간(15분)
function lockKey(name) { return `lock:${String(name).trim().toLowerCase()}`; }
// 관리자는 8자 이상 비밀번호, 직원은 4자리+ 숫자 PIN
function validSecret(s, isAdmin) { s = String(s || '').trim(); return isAdmin ? s.length >= 8 : /^\d{4,}$/.test(s); }
function deviceKey(id) { return `device:${id}`; }
function deviceOf(event) {
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  let label = String(h['x-device-label'] || '');
  try { label = decodeURIComponent(label); } catch (e) {}
  return { id: id, label: label };
}
// 기기 등록/갱신. 관리자 기기는 자동 승인, 직원 새 기기는 대기. 상태 반환.
async function registerDevice(st, event, member) {
  const dv = deviceOf(event);
  if (!dv.id) return 'approved';   // 기기정보 없으면(구버전) 통과
  const now = Date.now();
  const dr = await blobGet(st, deviceKey(dv.id));
  const dev = (dr.ok && dr.data) ? dr.data : { id: dv.id, status: 'pending', created: now };
  if (dv.label) dev.label = dv.label;
  dev.member_name = member.name; dev.member_id = member.id; dev.last_seen = now;
  if (member.admin) dev.status = 'approved';
  await blobSet(st, deviceKey(dv.id), dev);
  return dev.status;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function memberKey(id) { return `member:${id}`; }
// 입력 정리: 한글 조합형(NFD)·제로폭문자 때문에 "같아 보이는데 키가 다른" 사고가 난다.
// 드롭다운 시절엔 저장된 문자열을 그대로 넘겨 안 드러났지만, 직접 타이핑하면 로그인이 실패했다(2026-08-09 실측).
function cleanText(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')                      // 조합형 → 완성형 통일
    .replace(/[​-‍﻿]/g, '')  // 제로폭 공백·조이너·BOM 제거
    .trim();
}
function nameKey(name) { return `name:${cleanText(name).toLowerCase()}`; }
function nameKeyRaw(name) { return `name:${String(name).trim().toLowerCase()}`; }  // 구 색인 조회용(하위호환)

// ── 개발자 등급(계정·기기·권한 = 시스템 영역) ──────────────────────────
// 업무 서열(대표>관리자)과 별개 축이다. 관리자는 업무 데이터를, 개발자는 시스템을 맡는다.
// 개발자 전용: 회원 생성·삭제, 관리자 지정, 타인 PIN/아이디 재설정, 기기 승인, 권한(perms) 편집.
function isDev(m) { return !!(m && m.dev); }
// 아직 아무도 개발자가 아니면 관리자를 개발자로 인정한다(첫 지정 전 잠김 방지).
// 개발자가 한 명이라도 생기는 순간 이 통로는 닫힌다 — 배포 직후 아무도 못 들어가는 사고를 막는 자기부팅 장치.
async function devAllowed(st, member) {
  if (isDev(member)) return true;
  if (!member || !member.admin) return false;
  const all = await listMembers(st);
  return !all.some(isDev);
}
// ── 계정 분리 이사 스위치 ───────────────────────────────────────────────
// true  = 아이디·이름 둘 다로 로그인(이사 기간). 아이디 미발급자도 못 잠긴다.
// false = 아이디로만 로그인. 이름 목록(names) 조회도 막힌다.
// **전원 아이디 발급·첫 로그인 확인 후 false 로 바꾸고 배포하면 "완전 이사" 완료.**
// (환경변수 GW_ALLOW_NAME_LOGIN=off 로도 즉시 차단 가능 — 코드 수정 없이 잠글 때)
const ALLOW_NAME_LOGIN = String(process.env.GW_ALLOW_NAME_LOGIN || '').toLowerCase() !== 'off';

// 개인 아이디 로그인(계정 분리, 2026-08-09). 이름 드롭다운을 대체하며 이사 기간엔 이름 로그인과 병행.
function uidKey(uid) { return `uid:${normUid(uid)}`; }
function normUid(uid) { return cleanText(uid).toLowerCase(); }
// 영문소문자·숫자·._- 만 4~20자. 한글 금지 — 이름 형태를 아이디로 못 잡게 해 이름 색인 가로채기를 원천 차단.
function validUid(uid) { return /^[a-z0-9._-]{4,20}$/.test(normUid(uid)); }
function genId() { return 'u' + crypto.randomBytes(5).toString('hex'); }
function safeMember(m) { if (!m) return null; const { pin_salt, pin_hash, ...s } = m; return s; }
function cleanPerms(p) { const out = {}; MODULES.forEach(function (k) { out[k] = (p && (p[k] === 'do' || p[k] === 'view' || p[k] === 'hide')) ? p[k] : 'view'; }); return out; }

async function listMembers(st) {
  const { blobs } = await st.list({ prefix: 'member:' });
  const out = [];
  for (const b of (blobs || [])) {
    const r = await blobGet(st, b.key);
    if (r.ok && r.data && r.data.del !== 1) out.push(r.data);
  }
  // 연번(seq) 오름차순 → 없는 항목은 뒤로, 동률은 이름순
  out.sort(function (a, b) {
    const sa = (typeof a.seq === 'number') ? a.seq : 1e9;
    const sb = (typeof b.seq === 'number') ? b.seq : 1e9;
    if (sa !== sb) return sa - sb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return out;
}

// 퇴사자 차단(S2-A) — 퇴사일(leave_date)이 지난 계정은 로그인·기존 세션 모두 거부. 퇴사일 당일까지는 허용.
// del=1(삭제)과 별개: 인사 기록(연차·근속)은 남기고 접근만 끊는다.
function retired(m) {
  const ld = m && m.leave_date;
  if (!ld) return false;
  return String(ld) < new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);   // KST 일자 비교
}

// 세션 → 현재 회원(최신 perms 포함). { ok, member } 또는 { ok:false }
async function currentMember(st, event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(st, memberKey(v.payload.mid));
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}

async function handleBootstrap(st, d, R) {
  // 회원이 하나도 없을 때만: 최초 관리자 생성(무인증). 이후엔 거부.
  const existing = await listMembers(st);
  if (existing.length > 0) return jr(409, { status: 'REJECTED', error_code: 'ALREADY_INITIALIZED', request_id: R });
  const name = cleanText(d.name);
  const pin = (d.pin || '').trim();
  if (!name || !validSecret(pin, true)) return jr(400, { status: 'REJECTED', error_code: 'WEAK_SECRET', request_id: R });
  const { salt, hash } = hashSecret(pin);
  const m = { id: genId(), name, role: '대표', admin: true, perms: cleanPerms({ tasks: 'do', veh: 'do', rec: 'do', lic: 'do', check: 'do' }), pin_salt: salt, pin_hash: hash, created: Date.now(), updated: Date.now() };
  const w1 = await blobSet(st, memberKey(m.id), m);
  const w2 = await blobSet(st, nameKey(m.name), m.id);
  if (!w1.ok || !w2.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  const s = issueSession(m);
  return jr(200, { status: 'OK', token: s.token, expires_at: s.expires_at, member: safeMember(m), request_id: R });
}

async function handleLogin(st, d, R, event) {
  const GEN = () => jr(401, { status: 'UNAUTHORIZED', error_code: 'INVALID_CREDENTIALS', request_id: R });
  // 계정 분리(2026-08-09): 입력칸 하나로 아이디 우선, 없으면 이름으로 해석(이사 기간 병행).
  // 전원 아이디 발급이 끝나면 ALLOW_NAME_LOGIN=false 로 이름 경로를 닫는다.
  const ident = (d.uid || d.name || '').trim();
  const pin = (d.pin || '').trim();
  if (!ident || !pin) return GEN();
  const name = ident;   // 잠금 카운터 키는 입력값 기준(아래 lockKey에서 사용)
  const now = Date.now();
  const lk = await blobGet(st, lockKey(name));
  if (lk.ok && lk.data && lk.data.until && lk.data.until > now) {
    return jr(429, { status: 'LOCKED', error_code: 'TOO_MANY_ATTEMPTS', retry_after: Math.ceil((lk.data.until - now) / 1000), request_id: R });
  }
  async function fail() {
    const fails = (lk.ok && lk.data && lk.data.fails ? lk.data.fails : 0) + 1;
    const rec = fails >= LOCK_THRESHOLD ? { fails: 0, until: now + LOCK_MS } : { fails: fails };
    await blobSet(st, lockKey(name), rec);
    // Blobs엔 원자적 증가가 없어 병렬 대량 시도가 잠금 카운터를 우회한다 — 실패마다 고정 지연으로 완전탐색 비용을 올림
    await new Promise(function (r) { setTimeout(r, 600); });
    return GEN();
  }
  // ① 아이디 색인 우선 → ② (이사 기간에 한해) 이름 색인.
  // 순서가 중요: 아이디는 영문·숫자만 허용하므로 한글 이름을 아이디로 선점해 남의 로그인을 가로챌 수 없다.
  // 이름은 정리키(NFC) → 원문키 순으로 조회 — 예전에 저장된 색인이 조합형일 수 있어 하위호환이 필요하다.
  let idx = { ok: true, data: null };
  let healName = null;   // 구 색인으로 찾았을 때 새 키를 만들어 스스로 고침
  let viaName = false;   // 이름으로 찾았는지 — 아이디 보유자의 이름 로그인을 막기 위해 표시
  if (validUid(ident)) idx = await blobGet(st, uidKey(ident));
  if (idx.ok && !idx.data && ALLOW_NAME_LOGIN) {
    idx = await blobGet(st, nameKey(ident));
    if (idx.ok && !idx.data && nameKeyRaw(ident) !== nameKey(ident)) {
      idx = await blobGet(st, nameKeyRaw(ident));
      if (idx.ok && idx.data) healName = ident;
    }
    if (idx.ok && idx.data) viaName = true;
  }
  if (!idx.ok) return jr(500, { status: 'ERROR', error_code: idx.code, request_id: R });
  if (!idx.data) return fail();
  const mr = await blobGet(st, memberKey(idx.data));
  if (!mr.ok) return jr(500, { status: 'ERROR', error_code: mr.code, request_id: R });
  if (!mr.data || mr.data.del === 1 || retired(mr.data)) return fail();
  // 이름 로그인은 이사 기간(ALLOW_NAME_LOGIN) 동안 **아이디 보유자에게도 열어 둔다.**
  // 종전엔 아이디가 있으면 이름 경로를 막았는데(v245), 아이디를 잊는 순간 본인도 관리자도
  // 풀 수 없는 잠금이 됐다(2026-08-11 PM 실사고 — 개발자가 1명이라 대신 풀어줄 사람도 없음).
  // 명단 노출 차단이라는 원래 목적은 드롭다운 제거로 이미 달성됐고, 이름 차단은 그 목적에
  // 기여하지 않으면서 복구 불가 위험만 만들었다. 전원 폐쇄는 ALLOW_NAME_LOGIN=off 하나로 한다.
  // 대신 로그인 성공 시 본인 아이디를 돌려줘 다음부터 아이디를 쓰도록 안내한다(아래 uid_hint).
  if (!verifySecret(pin, mr.data.pin_salt, mr.data.pin_hash)) return fail();
  if (lk.ok && lk.data) await blobSet(st, lockKey(name), null);  // 성공 → 잠금 해제
  // 구 색인으로 들어온 경우 정리키 색인을 추가로 심어 다음부터는 타이핑으로도 바로 찾히게 한다(자가 치유).
  if (healName) { try { await blobSet(st, nameKey(healName), idx.data); } catch (e) {} }
  const deviceStatus = await registerDevice(st, event, mr.data);
  const s = issueSession(mr.data);
  if (!s.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: s.code, request_id: R });
  // 감사 로그: 로그인 이력(본인성 보강)
  try { await appendAudit({ ts: Date.now(), by: mr.data.name, bid: mr.data.id, col: 'login', ev: [{ op: '로그인', id: mr.data.id, t: mr.data.name + (viaName ? '(이름)' : '(아이디)') }] }); } catch (e) {}
  // 이름으로 들어왔는데 아이디가 있으면 그 아이디를 알려준다 — 아이디를 잊어 못 들어오던 상황의 해소책.
  // 본인 인증(PIN)을 통과한 뒤에만 나가므로 아이디가 외부로 새지 않는다.
  const uidHint = (viaName && mr.data.uid) ? mr.data.uid : undefined;
  return jr(200, { status: 'OK', token: s.token, expires_at: s.expires_at, member: safeMember(mr.data), device_status: deviceStatus, uid_hint: uidHint, request_id: R });
}

async function handleVerify(st, event, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { valid: false, reason: c.reason, request_id: R });
  const device_status = await registerDevice(st, event, c.member);
  return jr(200, { valid: true, member: safeMember(c.member), device_status: device_status, request_id: R });
}

async function handleMemberList(st, event, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: 'NO_SESSION', request_id: R });
  // 회원 목록은 담당 배정 드롭다운용 — 비관리자에겐 표시용 필드만(입사일·연차·휴직 등 인사정보는 관리자와 본인 것만.
  // 종전엔 safeMember 전체가 나가 현장직 계정으로 전사 입사일·연차 조회가 가능했다)
  const members = (await listMembers(st)).map(function (m) {
    if (c.member.admin || m.id === c.member.id) return safeMember(m);
    return { id: m.id, name: m.name, role: m.role, rank: m.rank, dept: m.dept, seq: m.seq, admin: m.admin, on_loa: m.on_loa, del: m.del };
  });
  return jr(200, { status: 'OK', members, request_id: R });
}

async function handleMemberUpsert(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  // 시스템 영역(계정 생성·관리자 지정·개발자 지정·권한 편집)은 개발자만.
  // 인사 정보(연차·입사일 등) 수정은 종전대로 관리자도 가능 — 경리·인사 업무가 막히지 않게.
  const canDev = await devAllowed(st, c.member);
  const touchesSystem = (!d.id) || d.admin !== undefined || d.dev !== undefined || d.perms !== undefined || d.uid !== undefined;
  if (touchesSystem && !canDev) return jr(403, { status: 'FORBIDDEN', error_code: 'DEV_ONLY', request_id: R });
  const name = cleanText(d.name);   // 저장 시점에 NFC 통일 — 타이핑 로그인이 깨지지 않게
  let m;
  let before = null;   // 감사 로그용 변경 전 스냅샷
  if (d.id) {
    // 기존 회원: 부분 업데이트 허용. 전달된 필드만 갱신(name/role/admin 미전달 시 기존값 보존)
    const r = await blobGet(st, memberKey(d.id));
    if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
    m = r.data;
    before = JSON.parse(JSON.stringify(m));
    if (name && m.name !== name) { await blobSet(st, nameKey(m.name), null); m.name = name; }
    if (d.role !== undefined) m.role = d.role || m.role || '직원';
    if (d.admin !== undefined) m.admin = !!d.admin;
    if (d.dev !== undefined) {
      // 마지막 개발자는 스스로 강등할 수 없다 — 시스템을 아무도 못 만지는 상태 방지
      if (!d.dev && isDev(m)) {
        const devs = (await listMembers(st)).filter(isDev);
        if (devs.length <= 1) return jr(409, { status: 'REJECTED', error_code: 'LAST_DEV', request_id: R });
      }
      m.dev = !!d.dev;
      if (m.dev) m.admin = true;   // 개발자는 관리자 권한을 포함한다
    }
  } else {
    // 신규 회원: 이름 필수, role/admin 기본값
    if (!name) return jr(400, { status: 'REJECTED', error_code: 'INVALID_INPUT', request_id: R });
    m = { id: genId(), name, created: Date.now() };
    m.role = (d.role || '직원');
    m.admin = !!d.admin;
  }
  // 아이디(계정 분리) — 관리자가 인사 카드에서 발급/변경. 중복·이름충돌은 거부.
  // **빈 문자열은 '변경 없음'으로 본다.** 종전엔 '지워라'로 해석해서, 화면이 낡은 목록으로
  // 아이디 칸을 비운 채 저장하면 로그인 아이디가 통째로 날아갔다(2026-08-11 PM 실제 사고).
  // 아이디를 정말 회수할 때만 uid_clear:true를 명시한다.
  if (d.uid_clear === true) {
    if (m.uid) { await blobSet(st, uidKey(m.uid), null); delete m.uid; }
  } else if (d.uid !== undefined && normUid(d.uid) !== '') {
    const nu = normUid(d.uid);
    if (!validUid(nu)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_UID', request_id: R });
    const dup = await uidTaken(st, nu, m.id);
    if (dup) return jr(409, { status: 'REJECTED', error_code: dup, request_id: R });
    if (m.uid && normUid(m.uid) !== nu) await blobSet(st, uidKey(m.uid), null);
    m.uid = nu;
  }
  if (d.rank !== undefined) m.rank = String(d.rank || '');
  if (d.dept !== undefined) m.dept = String(d.dept || '');
  if (d.annual_days !== undefined) { m.annual_days = (d.annual_days === null || isNaN(Number(d.annual_days))) ? null : Number(d.annual_days); }
  if (d.hire_date !== undefined) m.hire_date = String(d.hire_date || '');
  if (d.emp_type !== undefined) m.emp_type = String(d.emp_type || '');
  if (d.annual_basis !== undefined) m.annual_basis = (d.annual_basis === 'fiscal' ? 'fiscal' : 'hire');
  if (d.loa_days !== undefined) m.loa_days = isNaN(Number(d.loa_days)) ? 0 : Number(d.loa_days);
  if (d.leave_date !== undefined) m.leave_date = String(d.leave_date || '');
  if (d.annual_paid !== undefined) m.annual_paid = !!d.annual_paid;
  if (d.annual_base !== undefined) { m.annual_base = (d.annual_base === null || isNaN(Number(d.annual_base))) ? null : Number(d.annual_base); }
  if (d.annual_base_date !== undefined) m.annual_base_date = String(d.annual_base_date || '');
  if (d.seq !== undefined) { m.seq = (d.seq === null || isNaN(Number(d.seq))) ? null : Number(d.seq); }
  if (d.on_loa !== undefined) m.on_loa = !!d.on_loa;
  if (d.loa_start !== undefined) m.loa_start = String(d.loa_start || '');
  if (d.loa_end !== undefined) m.loa_end = String(d.loa_end || '');
  m.perms = cleanPerms(d.perms || m.perms);
  m.updated = Date.now();
  if (d.pin) {
    const pinStr = String(d.pin).trim();
    if (!validSecret(pinStr, m.admin)) return jr(400, { status: 'REJECTED', error_code: 'WEAK_SECRET', request_id: R });
    const h = hashSecret(pinStr); m.pin_salt = h.salt; m.pin_hash = h.hash;
  }
  const w1 = await blobSet(st, memberKey(m.id), m);
  const w2 = await blobSet(st, nameKey(m.name), m.id);
  if (m.uid) await blobSet(st, uidKey(m.uid), m.id);   // 아이디 색인 유지
  if (!w1.ok || !w2.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  // 감사 로그: 회원 필드 변경(이전값→새값). PIN은 값 미기록('변경'만), 해시·비밀값 제외.
  try {
    const f = {};
    const AUD_FIELDS = ['name','uid','role','admin','dev','rank','dept','annual_days','hire_date','emp_type','annual_basis','loa_days','leave_date','annual_paid','annual_base','annual_base_date','seq','on_loa','loa_start','loa_end'];
    const b = before || {};
    for (const k of AUD_FIELDS) {
      const a = b[k], v = m[k];
      if ((typeof a === 'object' ? JSON.stringify(a) : a) !== (typeof v === 'object' ? JSON.stringify(v) : v) && !(a == null && v == null)) f[k] = [short(a), short(v)];
    }
    if (before && JSON.stringify(before.perms || {}) !== JSON.stringify(m.perms || {})) f.perms = [short(before.perms), short(m.perms)];
    if (d.pin) f.PIN = ['', '변경'];
    if (!before || Object.keys(f).length) {
      await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'member',
        ev: [{ op: (before ? '수정' : '추가'), id: m.id, t: m.name, f: (Object.keys(f).length ? f : undefined) }] });
    }
  } catch (e) {}
  return jr(200, { status: 'OK', member: safeMember(m), request_id: R });
}

async function handleMemberDelete(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (!(await devAllowed(st, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEV_ONLY', request_id: R });
  if (!d.id || d.id === c.member.id) return jr(400, { status: 'REJECTED', error_code: 'INVALID_INPUT', request_id: R });
  const r = await blobGet(st, memberKey(d.id));
  // 마지막 개발자 계정은 삭제 불가 — 시스템 관리 주체가 사라지는 것 방지
  if (r.ok && r.data && isDev(r.data)) {
    const devs = (await listMembers(st)).filter(isDev);
    if (devs.length <= 1) return jr(409, { status: 'REJECTED', error_code: 'LAST_DEV', request_id: R });
  }
  if (r.ok && r.data) {
    r.data.del = 1; r.data.updated = Date.now();
    await blobSet(st, memberKey(d.id), r.data); await blobSet(st, nameKey(r.data.name), null);
    if (r.data.uid) await blobSet(st, uidKey(r.data.uid), null);   // 아이디 색인도 회수 — 안 지우면 그 아이디가 영구 점유된다
    try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'member', ev: [{ op: '삭제', id: d.id, t: r.data.name }] }); } catch (e) {}
  }
  return jr(200, { status: 'OK', request_id: R });
}

// 아이디 설정 — 본인(현재 PIN 확인) 또는 관리자(타인 지정).
// 계정 분리 이사에서 직원이 스스로 아이디를 정하는 경로.
async function handleSetUid(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: 'NO_SESSION', request_id: R });
  // 타인 아이디 지정도 개발자만 — 아이디는 로그인 식별자라 계정 탈취로 이어질 수 있다.
  const wantOtherUid = !!(d.id && d.id !== c.member.id);
  if (wantOtherUid && !(await devAllowed(st, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEV_ONLY', request_id: R });
  const targetId = wantOtherUid ? d.id : c.member.id;
  const uid = normUid(d.uid);
  if (!validUid(uid)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_UID', request_id: R });

  const r = await blobGet(st, memberKey(targetId));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });

  // 본인 변경은 현재 PIN 확인 — 토큰 탈취만으로 아이디를 바꿔 계정을 흔드는 통로 차단(set_pin과 동일 원칙)
  if (targetId === c.member.id) {
    const cur = (d.cur || '').trim();
    if (!cur) return jr(400, { status: 'REJECTED', error_code: 'NEED_CURRENT_PIN', request_id: R });
    if (!verifySecret(cur, r.data.pin_salt, r.data.pin_hash)) {
      await new Promise(function (rr) { setTimeout(rr, 600); });
      return jr(403, { status: 'FORBIDDEN', error_code: 'PIN_MISMATCH', request_id: R });
    }
  }

  const dup = await uidTaken(st, uid, targetId);
  if (dup) return jr(409, { status: 'REJECTED', error_code: dup, request_id: R });

  const prev = normUid(r.data.uid);
  if (prev && prev !== uid) await blobSet(st, uidKey(prev), null);   // 옛 아이디 색인 회수
  r.data.uid = uid; r.data.updated = Date.now();
  const w1 = await blobSet(st, memberKey(targetId), r.data);
  const w2 = await blobSet(st, uidKey(uid), targetId);
  if (!w1.ok || !w2.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'login', ev: [{ op: '아이디설정', id: targetId, t: uid }] }); } catch (e) {}
  return jr(200, { status: 'OK', uid: uid, request_id: R });
}

// 아이디 중복 검사. 남의 아이디는 물론 **남의 이름과도 겹치면 거부** — 이사 기간에 이름 로그인을 가로채는 것을 막는다.
async function uidTaken(st, uid, selfId) {
  const hit = await blobGet(st, uidKey(uid));
  if (hit.ok && hit.data && hit.data !== selfId) return 'UID_TAKEN';
  const nm = await blobGet(st, nameKey(uid));
  if (nm.ok && nm.data && nm.data !== selfId) return 'UID_TAKEN';
  return null;
}

async function handleSetPin(st, event, d, R) {
  const c = await currentMember(st, event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: 'NO_SESSION', request_id: R });
  // 타인 PIN 재설정은 개발자만(계정 탈취 통로). 본인 변경은 누구나 가능.
  const wantOther = !!(d.id && d.id !== c.member.id);
  if (wantOther && !(await devAllowed(st, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEV_ONLY', request_id: R });
  const targetId = wantOther ? d.id : c.member.id;
  const pin = (d.pin || '').trim();
  const r = await blobGet(st, memberKey(targetId));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  // 본인 변경은 현재 PIN 검증 필수 — 세션 토큰 탈취만으로 계정을 영구 장악하는 통로 차단(관리자의 타인 재설정은 예외)
  if (targetId === c.member.id) {
    const cur = (d.cur || '').trim();
    if (!cur) return jr(400, { status: 'REJECTED', error_code: 'NEED_CURRENT_PIN', request_id: R });
    if (!verifySecret(cur, r.data.pin_salt, r.data.pin_hash)) {
      await new Promise(function (rr) { setTimeout(rr, 600); });
      return jr(403, { status: 'FORBIDDEN', error_code: 'PIN_MISMATCH', request_id: R });
    }
  }
  if (!validSecret(pin, !!r.data.admin)) return jr(400, { status: 'REJECTED', error_code: 'WEAK_SECRET', request_id: R });
  const h = hashSecret(pin);
  r.data.pin_salt = h.salt; r.data.pin_hash = h.hash; r.data.updated = Date.now();
  const w = await blobSet(st, memberKey(targetId), r.data);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: 'STORAGE_WRITE_FAILED', request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'login', ev: [{ op: 'PIN변경', id: targetId, t: targetId === c.member.id ? '본인' : '관리자 재설정' }] }); } catch (e) {}
  return jr(200, { status: 'OK', request_id: R });
}

async function handleDeviceList(st, event, R) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const { blobs } = await st.list({ prefix: 'device:' });
  const out = [];
  for (const b of (blobs || [])) { const r = await blobGet(st, b.key); if (r.ok && r.data) out.push(r.data); }
  return jr(200, { status: 'OK', devices: out, request_id: R });
}
async function handleDeviceSet(st, event, d, R, status) {
  const c = await currentMember(st, event);
  if (!c.ok || !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  // 기기 승인·해제·삭제는 시스템 영역 — 개발자만. (승인된 기기 = 데이터 접근 열쇠)
  if (!(await devAllowed(st, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEV_ONLY', request_id: R });
  const id = String(d.device || '').trim();
  if (!id) return jr(400, { status: 'REJECTED', error_code: 'INVALID_INPUT', request_id: R });
  if (status === null) { await blobSet(st, deviceKey(id), null); try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'login', ev: [{ op: '기기삭제', id: id.slice(0, 20), t: '' }] }); } catch (e) {} return jr(200, { status: 'OK', request_id: R }); }
  const r = await blobGet(st, deviceKey(id));
  const dev = (r.ok && r.data) ? r.data : { id: id, created: Date.now() };
  dev.status = status; dev.updated = Date.now();
  await blobSet(st, deviceKey(id), dev);
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'login', ev: [{ op: status === 'approved' ? '기기승인' : '기기승인취소', id: id.slice(0, 20), t: String(dev.label || dev.member_name || '') }] }); } catch (e) {}
  return jr(200, { status: 'OK', request_id: R });
}

// 데이터 리셋(테스트 정리용). env GW_ALLOW_RESET='1' 일 때만. gw_users + gw_data 전체 삭제.
async function handleReset(R) {
  if (process.env.GW_ALLOW_RESET !== '1') return jr(403, { status: 'FORBIDDEN', error_code: 'RESET_DISABLED', request_id: R });
  const { blobDelete } = require('./_lib/blobs');
  let n = 0;
  for (const storeName of [USERS, 'gw_data']) {
    const st = store(storeName);
    const { blobs } = await st.list();
    for (const b of (blobs || [])) { await blobDelete(st, b.key); n++; }
  }
  return jr(200, { status: 'OK', deleted: n, request_id: R });
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { status: 'REJECTED', error_code: 'INVALID_JSON', request_id: R }); }
  const st = store(USERS);
  try {
    switch (d && d.action) {
      case 'reset': return await handleReset(R);
      case 'bootstrap': return await handleBootstrap(st, d, R);
      // 이사 완료(ALLOW_NAME_LOGIN=false) 후엔 이름 목록을 아예 내주지 않는다 — 로그인 화면에서 전 직원 명단이 보이던 노출을 닫는 것이 이번 변경의 목적.
      case 'names': {
        if (!ALLOW_NAME_LOGIN) return jr(200, { status: 'OK', names: [], count: 0, migrated: true, request_id: R });
        const ms = (await listMembers(st)).filter(function (m) { return !retired(m); });
        return jr(200, { status: 'OK', names: ms.map(function (m) { return m.name; }), count: ms.length, migrated: false, request_id: R });
      }
      case 'set_uid': return await handleSetUid(st, event, d, R);
      case 'login': return await handleLogin(st, d, R, event);
      case 'verify': return await handleVerify(st, event, R);
      case 'device_list': return await handleDeviceList(st, event, R);
      case 'device_approve': return await handleDeviceSet(st, event, d, R, 'approved');
      case 'device_revoke': return await handleDeviceSet(st, event, d, R, 'pending');
      case 'device_delete': return await handleDeviceSet(st, event, d, R, null);
      case 'member_list': return await handleMemberList(st, event, R);
      case 'member_upsert': return await handleMemberUpsert(st, event, d, R);
      case 'member_delete': return await handleMemberDelete(st, event, d, R);
      case 'set_pin': return await handleSetPin(st, event, d, R);
      default: return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
    }
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
