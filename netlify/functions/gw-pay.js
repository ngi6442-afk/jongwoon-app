// 66 급여 판2(원장 C236 · PM 11/20 16:04 'ㄱ' — 시안 3판: 회계사무소 급여대장 꼴 + 하수준설 수당 내역) — 급여대장(달·회사)·한 사람 기준·단가 설정.
//   권한: 전 동작 = 로그인 → 앱 관리자(member.admin)만(서버가 판정 — 화면 숨김에 기대지 않음). 관리자에게 기기 승인 검사는 늘 통과(다른 함수와 같은 규칙)라
//         실제 관문은 관리자 세션 하나다. 급여에 더 센 관문(비밀번호 다시 확인 등)을 둘지는 PM 결정 거리로 남김.
//   저장: gw_data 의 pay:base:<회사>:<회원> · pay:month:<회사>:<YYYY-MM> · pay:conf (꼴 = _lib/payledger.js). 앱 안에서 이 키를 쓰는 곳은 이 파일뿐이고,
//         밖에서 쓰는 길은 봇 키 백업 복원의 재해 복원 모드(gw-data backupRestoreClass 'pay' — payledger.docOk 통과분만)뿐. 매일 백업은 이 키도 읽어 간다(설계 브리핑 6절 — PM 결정 대기).
//   읽기 실패와 '없음'을 가른다(getOpt) — 못 읽은 문서 위에 쓰지 않고 503. 고쳐 쓰기 = 문서마다 무작위 rev 낙관락(base = 읽은 rev) → 쓰고 나서 다시 읽어 내 rev 가 아니면 409 OVERWRITTEN.
//   계산은 승격된 요율 표(settings:pay = bg:pay:law:v1 의 ver·sha · 판정 = PAYBG.lawPick)로만. 요율·세액표는 그 달(ym = 급여를 주는 달) 것 — 지급 달 = 귀속 달(15일에 그 달 몫을 줌 · 기간은 설정).
//   감사 글에는 금액을 적지 않는다(동작·사람·달·바뀐 칸 이름만).
'use strict';
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet, blobList } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const tier = require('./_lib/tier');
const push = require('./_lib/push');
const PAYBG = require('./_lib/paybg');
const PAYCALC = require('./_lib/paycalc');
const PL = require('./_lib/payledger');
const DATA = 'gw_data';
const USERS = 'gw_users';
const LAW_KEY = 'bg:pay:law:v1', LAW_FLAG = 'settings:pay';   // 읽기만(승격 스위치 쓰기는 gw-data 의 승격 동작 한 곳)
const YM_MIN = '2020-01', YM_AHEAD = 12;   // 받는 달 범위 = 2020-01 ~ 이번 달 + 12달(오타로 먼 달이 굳지 않게)
const NOT_PAYEE = ['지입차주', '일용직'];   // 급여대장에 없는 고용 형태(받은 10월 급여대장에 없음 — 인사 집계와 같은 표식)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label, x-gw-enc', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function newRev() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS), body: JSON.stringify(body) }; }
function bad(code, R, extra) { return jr(400, Object.assign({ status: 'REJECTED', error_code: code, request_id: R }, extra || {})); }
function unread(code, R) { return jr(503, { status: 'ERROR', error_code: code, request_id: R }); }
function conflict(code, R) { return jr(409, { status: 'CONFLICT', error_code: code, request_id: R }); }

// 요청자: 토큰 → 회원. 회원 레코드를 못 읽음(일시 장애)은 503, 없음·삭제·퇴사는 401
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, status: 401, reason: v.reason };
  let r; try { r = await blobGet(store(USERS), 'member:' + v.payload.mid); } catch (e) { return { ok: false, status: 503, reason: 'MEMBER_READ_FAILED' }; }
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: false, status: 401, reason: 'NO_MEMBER' } : { ok: false, status: 503, reason: 'MEMBER_READ_FAILED' };
  if (!r.data || r.data.del === 1 || tier.retired(r.data)) return { ok: false, status: 401, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
// 없는 키 = { ok:true, data:null } · 그 밖의 실패는 실패 그대로(빈 문서로 보고 덮어쓰지 않게)
async function getOpt(st, key) {
  let r; try { r = await blobGet(st, key); } catch (e) { return { ok: false, code: 'STORAGE_READ_FAILED' }; }
  if (!r.ok && r.code === 'NOT_FOUND') return { ok: true, data: null };
  if (r.ok && (r.data === undefined || r.data === null)) return { ok: true, data: null };
  return r;
}
async function audit(c, op, id, t) {
  try { return (await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'pay', ev: [{ op: op, id: id, t: String(t || '').slice(0, 300) }] })) !== false; } catch (e) { return false; }
}
function ymNow() { const d = new Date(Date.now() + 9 * 3600000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }   // KST 이번 달
function ymOk(ym) { return typeof ym === 'string' && PL.YM.test(ym) && ym >= YM_MIN && ym <= PL.ymAdd(ymNow(), YM_AHEAD); }
function corpOk(c) { return PL.CORPS.indexOf(c) >= 0; }

// 승격된 요율 표 — PAYBG.lawPick(gw-data payBgState 와 같은 판정)
async function lawState(st) {
  const fr = await getOpt(st, LAW_FLAG);
  const br = await getOpt(st, LAW_KEY);
  return PAYBG.lawPick(fr.ok ? { ok: true, flag: fr.data === null ? {} : fr.data } : { ok: false }, br.ok ? { ok: true, bg: br.data } : { ok: false });
}
// 화면 요율 줄에 쓸 값(그 달) — 숫자는 근거 표에서 온 것만
function lawOut(ls, ym) {
  if (!ls.on) return { on: false, why: ls.why };
  const rf = PAYBG.ratesFor(ls.bg, ym, ym);
  const out = { on: true, ver: ls.bg.ver, checked: PAYBG.bgSum(ls.bg).checked };
  if (rf.ok) out.rates = { pension: rf.rates.pension.ee, health: rf.rates.health.rate * rf.rates.health.share, care_ratio: rf.rates.care.rate / rf.rates.health.rate, emp: rf.rates.emp.ee, local: rf.rates.local, cut: rf.rates.cut.pension };
  else { out.off = rf.why; out.keys = rf.keys || []; }
  return out;
}
// 한 사람 한 달 계산 — { ok:true, calc } 또는 { ok:false, why, keys }. 던지지 않는다
function calcRow(ls, ym, ver, row, conf) {
  if (!ls.on) return { ok: false, why: ls.why, keys: [] };
  const rf = PAYBG.ratesFor(ls.bg, ym, ym);
  if (!rf.ok) return { ok: false, why: rf.why, keys: rf.keys || [] };
  const bi = PL.buildInput(ver, row, conf, PAYBG.capsFor(ls.bg, ym));
  if (!bi.ok) return bi;
  try {
    const m = PAYCALC.calcMonth(rf.rates, rf.tax, bi.inp);
    const t = PL.toCols(m);
    t.notes = bi.notes.concat(t.notes);
    t.dredge = bi.dredge;
    t.law_ver = rf.ver; t.law_sha = rf.sha; t.ym = ym;
    return { ok: true, calc: t };
  } catch (e) { return { ok: false, why: e && e.code === 'PAY_BAD_INPUT' ? 'BAD_INPUT' : (e && e.code === 'PAY_BAD_RATES' ? 'BAD_RATE' : 'CALC_FAILED'), keys: e && e.field ? [e.field] : [] }; }
}
// 가입 제외 제안(사람이 정함) — 근거 표의 나이 문턱으로. 생년월일·입사일 꼴이 아니면 제안 없음
function ageAt(birth, day) {
  if (!PL.realDay(birth) || !PL.realDay(day)) return null;
  let a = Number(day.slice(0, 4)) - Number(birth.slice(0, 4));
  if (day.slice(5) < birth.slice(5)) a--;
  return a;
}
function suggestOf(bg, m, ym) {
  const out = {};
  if (!bg) return out;
  const pa = PAYBG.ageFor(bg, 'age.pension_max', ym), ea = PAYBG.ageFor(bg, 'age.emp_hire_max', ym);
  const a1 = ageAt(m.birth, ym + '-01'), a2 = ageAt(m.birth, m.hire_date);
  if (pa != null && a1 != null && a1 >= pa) out.pension = true;
  if (ea != null && a2 != null && a2 >= ea) out.emp = true;
  return out;
}
function memberOut(m) { return { id: m.id, name: String(m.name || ''), rank: String(m.rank || ''), dept: String(m.dept || ''), corp: String(m.corp || ''), emp_type: String(m.emp_type || ''), hire_date: String(m.hire_date || ''), leave_date: String(m.leave_date || ''), emp_no: String(m.emp_no || '') }; }
// 그 달 급여대장 사람: 삭제·시험 계정·지입차주·일용직 아님 · 그 회사(both 는 두 회사) · 기간 안에 재직(입사일 ≤ 기간 끝 · 퇴사일 없음 또는 ≥ 기간 시작)
function payeeIn(m, corp, period) {
  if (!m || !m.id || m.del === 1 || m.test_acct) return false;
  if (NOT_PAYEE.indexOf(String(m.emp_type || '')) >= 0) return false;
  if (!(m.corp === corp || m.corp === 'both')) return false;
  if (m.hire_date && PL.realDay(m.hire_date) && m.hire_date > period.to) return false;
  if (m.leave_date && String(m.leave_date) < period.from) return false;
  return true;
}
async function readConf(st) {
  const r = await getOpt(st, PL.CONF_KEY);
  if (!r.ok) return { ok: false };
  if (r.data === null) return { ok: true, conf: null };
  const c = PL.cleanConfDoc(r.data);
  return c.ok ? { ok: true, conf: c.doc } : { ok: false, bad: true };
}
async function readBase(st, corp, mid) {   // { ok, doc|null } · 꼴 틀림 = ok false·bad
  const r = await getOpt(st, PL.baseKey(corp, mid));
  if (!r.ok) return { ok: false };
  if (r.data === null) return { ok: true, doc: null };
  const c = PL.cleanBaseDoc(r.data);
  return c.ok ? { ok: true, doc: c.doc } : { ok: false, bad: true, field: c.field };
}
async function readMonth(st, corp, ym) {
  const r = await getOpt(st, PL.monthKey(corp, ym));
  if (!r.ok) return { ok: false };
  if (r.data === null) return { ok: true, doc: null };
  const c = PL.cleanMonthDoc(r.data, PL.monthKey(corp, ym));
  return c.ok ? { ok: true, doc: c.doc } : { ok: false, bad: true, field: c.field };
}
// 쓰기: 읽은 rev 와 지금 rev 가 같을 때만 → 쓰고 다시 읽어 내 rev 인지 확인
async function writeChecked(st, key, readFn, baseRev, doc) {
  const now = await readFn();
  if (!now.ok) return { res: 'unread' };
  const curRev = now.doc ? now.doc.rev : '';
  if ((baseRev || '') !== curRev) return { res: 'stale' };
  const w = await blobSet(st, key, doc);
  if (!w.ok) return { res: 'fail', code: w.code };
  const back = await readFn();
  if (!back.ok) return { res: 'unsure' };
  if (!back.doc || back.doc.rev !== doc.rev) return { res: 'overwritten' };
  return { res: 'ok' };
}
function writeErr(w, R) {
  if (w.res === 'unread') return unread('PAY_READ_FAILED', R);
  if (w.res === 'stale') return conflict('PAY_STALE', R);
  if (w.res === 'overwritten') return conflict('OVERWRITTEN', R);
  if (w.res === 'unsure') return jr(503, { status: 'ERROR', error_code: 'WRITE_UNCONFIRMED', request_id: R });
  return jr(500, { status: 'ERROR', error_code: w.code || 'STORAGE_FAILED', request_id: R });
}
async function readTarget(mid, R) {   // 대상 회원 레코드(삭제·시험 계정 아님). { m } 또는 { res }
  if (typeof mid !== 'string' || !PL.MID.test(mid)) return { res: bad('BAD_MID', R) };
  let r; try { r = await blobGet(store(USERS), 'member:' + mid); } catch (e) { return { res: unread('MEMBER_READ_FAILED', R) }; }
  if (!r.ok) return { res: r.code === 'NOT_FOUND' ? jr(404, { status: 'REJECTED', error_code: 'NO_TARGET', request_id: R }) : unread('MEMBER_READ_FAILED', R) };
  if (!r.data || r.data.del === 1 || r.data.test_acct || NOT_PAYEE.indexOf(String(r.data.emp_type || '')) >= 0) return { res: jr(404, { status: 'REJECTED', error_code: 'NO_TARGET', request_id: R }) };
  return { m: r.data };
}

// ── 급여대장 한 장 ───────────────────────────────────────────────
async function handleMonthGet(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (!ymOk(d.ym)) return bad('BAD_YM', R);
  const corp = d.corp, ym = d.ym;
  const cf = await readConf(st);
  if (!cf.ok) return unread(cf.bad ? 'PAY_CONF_BAD' : 'PAY_READ_FAILED', R);
  const conf = cf.conf;
  const period = PL.periodOf(ym, conf ? conf.period_day : 1);
  const mo = await readMonth(st, corp, ym);
  if (!mo.ok) return unread(mo.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  const ms = await push.loadMembers();
  if (!Array.isArray(ms) || ms.unavailable) return unread('MEMBERS_UNAVAILABLE', R);
  const lst = await blobList(st, 'pay:base:' + corp + ':');
  if (!lst.ok) return unread('PAY_READ_FAILED', R);
  const byId = {}; ms.forEach(function (m) { if (m && m.id) byId[m.id] = m; });
  const doc = mo.doc, frozen = doc && doc.state === 'closed' ? doc.frozen : null;
  const ids = new Set();
  ms.forEach(function (m) { if (payeeIn(m, corp, period)) ids.add(m.id); });
  lst.keys.forEach(function (k) { const pre = 'pay:base:' + corp + ':'; if (String(k).indexOf(pre) !== 0) return; const mid = k.slice(pre.length); if (PL.MID.test(mid) && byId[mid] && byId[mid].del !== 1) ids.add(mid); });   // 기준이 있는 사람(회사 표식이 달라도 대장에 남김)
  if (doc) Object.keys(doc.rows).forEach(function (mid) { ids.add(mid); });
  if (frozen && frozen.rows) Object.keys(frozen.rows).forEach(function (mid) { ids.add(mid); });
  const ls = await lawState(st);
  const out = [];
  for (const mid of ids) {
    const m = byId[mid] || null;
    const o = { mid: mid, member: m ? memberOut(m) : null, row: doc && doc.rows[mid] ? doc.rows[mid] : null };
    if (frozen) { o.calc = frozen.rows && frozen.rows[mid] ? frozen.rows[mid] : null; o.frozen = true; out.push(o); continue; }
    const br = await readBase(st, corp, mid);
    if (!br.ok) { o.state = br.bad ? 'bad' : 'unread'; out.push(o); continue; }
    const ver = PL.verFor(br.doc, ym);
    o.ver = ver; o.base_rev = br.doc ? br.doc.rev : '';
    o.next_from = br.doc ? (br.doc.vers.filter(function (v) { return v.from > ym; }).map(function (v) { return v.from; })[0] || '') : '';
    if (m) { const sg = suggestOf(ls.on ? ls.bg : null, m, ym); if (ver && ((sg.pension && !ver.skip.pension) || (sg.emp && !ver.skip.emp))) o.suggest = sg; }
    if (!ver) { o.state = 'no_base'; out.push(o); continue; }
    const k = calcRow(ls, ym, ver, o.row, conf);
    if (k.ok) { o.state = 'ok'; o.calc = k.calc; } else { o.state = 'off'; o.off = { why: k.why, keys: k.keys || [] }; }
    out.push(o);
  }
  // 대장 순서: 사원번호(숫자 먼저) → 입사일 → 이름
  out.sort(function (a, b) {
    const ma = a.member || {}, mb = b.member || {}, na = Number(ma.emp_no), nb = Number(mb.emp_no);
    const ka = (ma.emp_no && Number.isFinite(na) ? String(na).padStart(8, '0') : 'z') + String(ma.hire_date || '9999') + String(ma.name || a.mid);
    const kb = (mb.emp_no && Number.isFinite(nb) ? String(nb).padStart(8, '0') : 'z') + String(mb.hire_date || '9999') + String(mb.name || b.mid);
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  // 회사 표식이 비어 있어 어느 대장에도 안 들어간 재직 직원(사람이 '이 대장에 넣기'로 고름 — 이름만)
  const loose = ms.filter(function (m) { return m && m.id && m.del !== 1 && !m.test_acct && !m.corp && NOT_PAYEE.indexOf(String(m.emp_type || '')) < 0 && (!m.leave_date || String(m.leave_date) >= period.from) && !ids.has(m.id); }).map(function (m) { return { mid: m.id, name: String(m.name || ''), rank: String(m.rank || '') }; });
  return jr(200, { status: 'OK', corp: corp, ym: ym, period: period, pay_day: conf ? conf.pay_day : null, conf: conf ? { dredge: conf.dredge, period_day: conf.period_day, pay_day: conf.pay_day, rev: conf.rev } : null,
    state: doc ? doc.state : 'open', rev: doc ? doc.rev : '', closed_at: doc && doc.closed_at || 0, closed_by: doc && doc.closed_by || '', frozen_law: frozen ? { ver: frozen.law_ver || '', at: frozen.at || 0 } : null,
    law: lawOut(ls, ym), rows: out, loose: loose, request_id: R });
}
// 그 달 넣은 값 저장(한 사람) — 확정한 달은 못 고침
async function handleRowSave(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (!ymOk(d.ym)) return bad('BAD_YM', R);
  if (typeof d.rev !== 'string') return bad('NEED_BASE', R);
  const t = await readTarget(d.mid, R); if (t.res) return t.res;
  const cf = await readConf(st);
  if (!cf.ok) return unread(cf.bad ? 'PAY_CONF_BAD' : 'PAY_READ_FAILED', R);
  const period = PL.periodOf(d.ym, cf.conf ? cf.conf.period_day : 1);
  let row = null;
  if (d.row !== null) { const cl = PL.cleanRowIn(d.row, period); if (!cl.ok) return bad('BAD_ROW', R, { field: cl.field }); row = cl.row; }
  const key = PL.monthKey(d.corp, d.ym), rd = function () { return readMonth(st, d.corp, d.ym); };
  const mo = await rd();
  if (!mo.ok) return unread(mo.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  if (mo.doc && mo.doc.state === 'closed') return conflict('MONTH_CLOSED', R);
  const rows = Object.assign({}, mo.doc ? mo.doc.rows : {});
  const before = rows[t.m.id] || null;
  if (row === null || !Object.keys(row).length) delete rows[t.m.id]; else rows[t.m.id] = row;
  if (Object.keys(rows).length > PL.LIM.rows) return bad('ROWS_FULL', R);
  if (JSON.stringify(before) === JSON.stringify(rows[t.m.id] || null)) return bad('NO_CHANGE', R);
  const doc = { schema: 1, rev: newRev(), corp: d.corp, ym: d.ym, state: 'open', rows: rows, frozen: null, updated_at: Date.now(), updated_by: c.member.id, closed_at: 0, closed_by: '' };
  const w = await writeChecked(st, key, rd, d.rev, doc);
  if (w.res !== 'ok') return writeErr(w, R);
  const changed = Object.keys(Object.assign({}, before || {}, rows[t.m.id] || {})).filter(function (k) { return JSON.stringify((before || {})[k]) !== JSON.stringify((rows[t.m.id] || {})[k]); });
  const au = await audit(c, '급여대장', d.corp + ':' + d.ym + ':' + t.m.id, '그 달 값 · 바뀐 칸 [' + changed.join(',') + ']');
  return jr(200, { status: 'OK', rev: doc.rev, audit: au, request_id: R });
}
// 저장 전 계산(쓰지 않음) — 그 달 값 창·하수준설 창이 넣는 동안 금액을 보임
async function handleRowPreview(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (!ymOk(d.ym)) return bad('BAD_YM', R);
  const t = await readTarget(d.mid, R); if (t.res) return t.res;
  const cf = await readConf(st);
  if (!cf.ok) return unread(cf.bad ? 'PAY_CONF_BAD' : 'PAY_READ_FAILED', R);
  const period = PL.periodOf(d.ym, cf.conf ? cf.conf.period_day : 1);
  const cl = PL.cleanRowIn(d.row || {}, period);
  if (!cl.ok) return bad('BAD_ROW', R, { field: cl.field });
  let ver;
  if (d.ver !== undefined && d.ver !== null) { const cv = PL.cleanVer(d.ver); if (!cv.ok) return bad('BAD_VER', R, { field: cv.field }); ver = cv.ver; }   // 기준 창: 저장 전 판으로 계산
  else { const br = await readBase(st, d.corp, t.m.id); if (!br.ok) return unread(br.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R); ver = PL.verFor(br.doc, d.ym); }
  const ls = await lawState(st);
  const k = calcRow(ls, d.ym, ver, cl.row, cf.conf);
  return jr(200, { status: 'OK', ym: d.ym, period: period, law: lawOut(ls, d.ym), calc: k.ok ? k.calc : null, off: k.ok ? null : { why: k.why, keys: k.keys || [] }, request_id: R });
}
// 이 달 확정 — 사람 줄 전부 계산되어야 함(못 하는 줄이 있으면 409 + 그 사람 id) · 계산 결과를 얼림
async function handleClose(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (!ymOk(d.ym)) return bad('BAD_YM', R);
  if (typeof d.rev !== 'string') return bad('NEED_BASE', R);
  const g = await handleMonthGet(st, c, { corp: d.corp, ym: d.ym }, R);
  if (g.statusCode !== 200) return g;
  const b = JSON.parse(g.body);
  if (b.state === 'closed') return conflict('MONTH_CLOSED', R);
  if (b.rev !== d.rev) return conflict('PAY_STALE', R);
  if (!b.law.on) return conflict('LAW_OFF', R);
  const notOk = b.rows.filter(function (r) { return r.state !== 'ok'; });
  if (notOk.length) return jr(409, { status: 'CONFLICT', error_code: 'ROWS_NOT_READY', mids: notOk.map(function (r) { return r.mid; }), request_id: R });
  if (!b.rows.length) return conflict('NO_ROWS', R);
  const rows = {};
  b.rows.forEach(function (r) { rows[r.mid] = Object.assign({}, r.calc, { name: r.member ? r.member.name : '', rank: r.member ? r.member.rank : '', hire_date: r.member ? r.member.hire_date : '', emp_no: r.member ? r.member.emp_no : '', from: r.ver ? r.ver.from : '' }); });
  const rd = function () { return readMonth(st, d.corp, d.ym); };
  const mo = await rd();
  if (!mo.ok) return unread(mo.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  const now = Date.now();
  const doc = { schema: 1, rev: newRev(), corp: d.corp, ym: d.ym, state: 'closed', rows: mo.doc ? mo.doc.rows : {}, updated_at: now, updated_by: c.member.id, closed_at: now, closed_by: c.member.id,
    frozen: { at: now, by: c.member.id, law_ver: b.law.ver, period: b.period, pay_day: b.pay_day, conf: b.conf ? { dredge: b.conf.dredge, period_day: b.conf.period_day, pay_day: b.conf.pay_day } : null, rows: rows } };
  const w = await writeChecked(st, PL.monthKey(d.corp, d.ym), rd, d.rev, doc);
  if (w.res !== 'ok') return writeErr(w, R);
  const au = await audit(c, '급여대장 확정', d.corp + ':' + d.ym, b.rows.length + '명 · 요율 표 ' + b.law.ver);
  return jr(200, { status: 'OK', rev: doc.rev, audit: au, request_id: R });
}
// 확정 풀기 — 얼린 값은 지우고 다시 계산하는 상태로(감사 남김)
async function handleReopen(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (!ymOk(d.ym)) return bad('BAD_YM', R);
  if (typeof d.rev !== 'string') return bad('NEED_BASE', R);
  const rd = function () { return readMonth(st, d.corp, d.ym); };
  const mo = await rd();
  if (!mo.ok) return unread(mo.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  if (!mo.doc || mo.doc.state !== 'closed') return conflict('NOT_CLOSED', R);
  const doc = Object.assign({}, mo.doc, { rev: newRev(), state: 'open', frozen: null, updated_at: Date.now(), updated_by: c.member.id, closed_at: 0, closed_by: '' });
  const w = await writeChecked(st, PL.monthKey(d.corp, d.ym), rd, d.rev, doc);
  if (w.res !== 'ok') return writeErr(w, R);
  const au = await audit(c, '급여대장 확정 풀기', d.corp + ':' + d.ym, '확정 ' + new Date((mo.doc.closed_at || 0) + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' 을 풂');
  return jr(200, { status: 'OK', rev: doc.rev, audit: au, request_id: R });
}

// ── 한 사람 기준 ─────────────────────────────────────────────────
async function handleBaseGet(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  const t = await readTarget(d.mid, R); if (t.res) return t.res;
  const br = await readBase(st, d.corp, t.m.id);
  if (!br.ok) return unread(br.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  const ym = ymOk(d.ym) ? d.ym : ymNow();
  const ls = await lawState(st);
  return jr(200, { status: 'OK', member: memberOut(t.m), doc: br.doc, ym: ym, now_ym: ymNow(), suggest: suggestOf(ls.on ? ls.bg : null, t.m, ym), law: lawOut(ls, ym), request_id: R });
}
async function handleBaseSave(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (typeof d.rev !== 'string') return bad('NEED_BASE', R);
  const t = await readTarget(d.mid, R); if (t.res) return t.res;
  const cv = PL.cleanVer(d.ver);
  if (!cv.ok) return bad('BAD_VER', R, { field: cv.field });
  if (!ymOk(cv.ver.from)) return bad('BAD_VER', R, { field: 'from' });
  const rd = function () { return readBase(st, d.corp, t.m.id); };
  const br = await rd();
  if (!br.ok) return unread(br.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  if ((br.doc ? br.doc.rev : '') !== d.rev) return conflict('PAY_STALE', R);
  const pv = PL.putVer(br.doc, cv.ver);
  if (!pv.ok) return bad(pv.code, R);
  if (d.kind !== undefined && d.kind !== pv.kind) return conflict('KIND_MISMATCH', R);   // 화면이 '새 판'/'고침' 가운데 무엇을 하려는지 같이 보냄 — 다르면 쓰지 않음(소급 고침을 모르고 하지 않게)
  const doc = { schema: 1, rev: newRev(), vers: pv.vers, updated_at: Date.now(), updated_by: c.member.id };
  const w = await writeChecked(st, PL.baseKey(d.corp, t.m.id), rd, d.rev, doc);
  if (w.res !== 'ok') return writeErr(w, R);
  const au = await audit(c, '급여기준', d.corp + ':' + t.m.id, (pv.kind === 'new' ? '새 판' : '고침') + ' · 적용 ' + cv.ver.from + ' · 바뀐 칸 [' + pv.changed.join(',') + ']');
  return jr(200, { status: 'OK', kind: pv.kind, rev: doc.rev, audit: au, request_id: R });
}
// 판 지우기 — 아직 오지 않은 달(이번 달보다 뒤)의 판만(지난 달 판을 지우면 열린 달 금액이 조용히 바뀜 — 고치기로)
async function handleBaseDrop(st, c, d, R) {
  if (!corpOk(d.corp)) return bad('BAD_CORP', R);
  if (typeof d.rev !== 'string') return bad('NEED_BASE', R);
  if (typeof d.from !== 'string' || !PL.YM.test(d.from)) return bad('BAD_FROM', R);
  if (!(d.from > ymNow())) return conflict('VER_IN_USE', R);
  const t = await readTarget(d.mid, R); if (t.res) return t.res;
  const rd = function () { return readBase(st, d.corp, t.m.id); };
  const br = await rd();
  if (!br.ok) return unread(br.bad ? 'PAY_DOC_BAD' : 'PAY_READ_FAILED', R);
  if ((br.doc ? br.doc.rev : '') !== d.rev) return conflict('PAY_STALE', R);
  const dv = PL.dropVer(br.doc, d.from);
  if (!dv.ok) return bad(dv.code, R);
  const doc = { schema: 1, rev: newRev(), vers: dv.vers, updated_at: Date.now(), updated_by: c.member.id };
  const w = await writeChecked(st, PL.baseKey(d.corp, t.m.id), rd, d.rev, doc);
  if (w.res !== 'ok') return writeErr(w, R);
  const au = await audit(c, '급여기준 판 지움', d.corp + ':' + t.m.id, '적용 ' + d.from + ' 판 지움');
  return jr(200, { status: 'OK', rev: doc.rev, audit: au, request_id: R });
}

// ── 단가·기간 설정 ───────────────────────────────────────────────
async function handleConfGet(st, c, d, R) {
  const cf = await readConf(st);
  if (!cf.ok) return unread(cf.bad ? 'PAY_CONF_BAD' : 'PAY_READ_FAILED', R);
  return jr(200, { status: 'OK', conf: cf.conf, request_id: R });
}
async function handleConfSave(st, c, d, R) {
  if (typeof d.rev !== 'string') return bad('NEED_BASE', R);
  const cl = PL.cleanConfIn(d.conf);
  if (!cl.ok) return bad('BAD_CONF', R, { field: cl.field });
  const rd = async function () { const r = await readConf(st); return r.ok ? { ok: true, doc: r.conf } : { ok: false }; };
  const cur = await rd();
  if (!cur.ok) return unread('PAY_READ_FAILED', R);
  if ((cur.doc ? cur.doc.rev : '') !== d.rev) return conflict('PAY_STALE', R);
  const old = cur.doc || {};
  const changed = ['dredge', 'period_day', 'pay_day'].filter(function (k) { return JSON.stringify(old[k]) !== JSON.stringify(cl.conf[k]); });
  if (!changed.length) return bad('NO_CHANGE', R);
  const doc = Object.assign({ schema: 1, rev: newRev() }, cl.conf, { updated_at: Date.now(), updated_by: c.member.id });
  const w = await writeChecked(st, PL.CONF_KEY, rd, d.rev, doc);
  if (w.res !== 'ok') return writeErr(w, R);
  const au = await audit(c, '급여 설정', 'pay:conf', '바뀐 칸 [' + changed.join(',') + ']');
  return jr(200, { status: 'OK', rev: doc.rev, audit: au, request_id: R });
}

const ACTS = { pay_month_get: handleMonthGet, pay_row_save: handleRowSave, pay_row_preview: handleRowPreview, pay_month_close: handleClose, pay_month_reopen: handleReopen,
  pay_base_get: handleBaseGet, pay_base_save: handleBaseSave, pay_base_drop: handleBaseDrop, pay_conf_get: handleConfGet, pay_conf_save: handleConfSave };
async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try {
    const h = event.headers || {};
    // 앱 gwCall 은 1MB 넘는 본문만 gzip 으로 보낸다 — 급여 요청은 그보다 작아야 정상이라 풀되 크기를 묶는다
    if (String(h['x-gw-enc'] || h['X-GW-Enc'] || '').toLowerCase() === 'gzip') d = JSON.parse(require('zlib').gunzipSync(Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'binary'), { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8'));
    else d = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}'));
  } catch (e) { return bad('INVALID_JSON', R); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return bad('INVALID_JSON', R);
  const act = typeof d.action === 'string' ? d.action : '';
  if (!Object.prototype.hasOwnProperty.call(ACTS, act)) return bad('UNKNOWN_ACTION', R);
  const c = await currentMember(event);
  if (!c.ok) return jr(c.status, { status: c.status === 401 ? 'UNAUTHORIZED' : 'ERROR', error_code: c.reason, request_id: R });
  if (c.member.admin !== true) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  try {
    return await ACTS[act](store(DATA), c, d, R);
  } catch (e) {
    try { console.log('[gw-pay] ' + act + ' 실패 ' + String((e && e.message) || e).slice(0, 120)); } catch (e2) {}
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}
exports.handler = handler;
