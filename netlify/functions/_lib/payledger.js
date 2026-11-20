// 66 급여 판2(원장 C236 · PM 11/20 16:04 'ㄱ' — 시안 3판 = 회계사무소 급여대장 꼴 + 하수준설 수당 내역) — 급여 자료의 꼴 검사·정리·한 사람 한 달 계산. 순수 함수(저장소·시각을 모름).
//   문서 세 가지(전부 gw_data · gw-pay 만 쓰고, 백업 복원은 재해 복원 모드에서 docOk 를 통과한 것만 — gw-data backupRestoreClass 'pay'):
//   ① pay:base:<회사>:<회원 id> 한 사람 기준 = { schema, rev, vers:[판], updated_at, updated_by } — 판 = 적용 시작 달(from)부터 쓰는 값 한 벌. 같은 from 은 고침, 새 from 은 새 판.
//      판을 자르지 않는다(상한에 닿으면 저장 거절 VERS_FULL) · 아직 오지 않은 달의 판은 지울 수 있다(gw-pay 가 이번 달과 견줌).
//   ② pay:month:<회사>:<YYYY-MM> 그 달 급여대장 = { schema, rev, corp, ym, state 'open'|'closed', rows:{ 회원 id: 그 달 넣은 값 }, frozen, updated_at, updated_by, closed_at, closed_by }
//      그 달 넣은 값은 '기준과 다를 때만' 덮어쓰는 칸 + 그 달에만 있는 칸(초과·차감 시간, 상여, 하수준설 날짜별 줄, 공제 직접 값, 비고).
//      확정(closed)하면 계산 결과를 frozen 에 얼린다 — 그 뒤 기준·요율이 바뀌어도 확정한 달 금액은 그대로.
//   ③ pay:conf 단가·기간 설정 = { schema, rev, dredge:{ day, ot_hour, free_days } | null, period_day, pay_day, updated_at, updated_by } — 숫자는 관리자가 넣는다(이 파일·화면 코드에 단가 숫자 없음).
//   하수준설 수당 규칙(받은 수당내역에서 읽음 · 판단은 노무사 몫): 기간 안 준설 근무일을 날짜 순서로 세어 free_days 까지는 기본급에 포함(추가 수당 없음),
//     넘는 날부터 하루 day(반일 0.5 = 반) · 연장은 시간당 ot_hour(포함 날에도 붙음) · 줄마다 '더한 금액'(단가로 풀리지 않는 금액) · 줄마다 '포함/지급' 나눔을 사람이 바꿀 수 있음.
'use strict';
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const REV = /^[0-9a-f]{16}$/;
const MID = /^[A-Za-z0-9_-]{1,40}$/;
const CORPS = ['env', 'con'];
const LIM = { money: 1000000000, vers: 120, rows: 200, lines: 62, note: 60, hours: 400, by: 40 };
const COLS = ['base', 'allow', 'adj', 'bonus', 'meal', 'car'];
const DED_FIX = ['pension', 'health', 'care', 'emp'];
const own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
const isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
const int = function (v, max) { return Number.isInteger(v) && v >= 0 && v <= max; };
const realDay = function (s) { if (!DAY_RE.test(String(s || ''))) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
// 0.5 단위 시간·일수(받은 자료가 0.5 단위) — 소수 둘째 자리 밑은 받지 않는다
const half = function (v, max) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max && Math.abs(v * 2 - Math.round(v * 2)) < 1e-9; };
// 금액에 원 미만 두 자리까지(받은 자료의 '더한 금액'에 원 미만이 있음)
const cents = function (v, max) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6; };
// 글 칸: 제어문자·꺾쇠 거절 · 엑셀 수식 머리 글자(= + - @)로 시작하면 거절(뒤 판의 엑셀 내려받기 대비)
function textOk(s, max) { return typeof s === 'string' && s.length <= max && !/[\u0000-\u001f\u007f<>]/.test(s) && !/^[=+\-@]/.test(s); }
function ymAdd(ym, n) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5)) - 1 + n; const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1; return yy + '-' + String(mm).padStart(2, '0'); }
function lastDay(ym) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5)); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
// 그 달 급여 기간: period_day = 1 이면 그 달 1일~말일, 아니면 전달 period_day 일 ~ 이달 period_day - 1 일(받은 수당내역 = 15일~다음 달 14일)
function periodOf(ym, periodDay) {
  const pd = int(periodDay, 28) && periodDay >= 1 ? periodDay : 1;
  if (pd === 1) return { from: ym + '-01', to: ym + '-' + String(lastDay(ym)).padStart(2, '0'), day: 1 };
  const pv = ymAdd(ym, -1);
  return { from: pv + '-' + String(pd).padStart(2, '0'), to: ym + '-' + String(pd - 1).padStart(2, '0'), day: pd };
}

// ── ① 한 사람 기준 판 ────────────────────────────────────────────
// 판 한 벌 → { ok, ver } 또는 { ok:false, field }. 모르는 칸은 버린다.
function cleanVer(x) {
  const no = function (f) { return { ok: false, field: f }; };
  if (!isObj(x)) return no('ver');
  if (typeof x.from !== 'string' || !YM.test(x.from)) return no('from');
  if (!int(x.base, LIM.money) || x.base === 0) return no('base');
  for (const k of ['allow', 'meal', 'car']) if (!int(x[k], LIM.money)) return no(k);
  if (typeof x.allow_ord !== 'boolean') return no('allow_ord');   // 고정 수당이 통상임금에 드는지 — 넣는 사람이 정한 표시(코드가 정하지 않음 · 해석은 노무사 몫)
  if (!(typeof x.hours === 'number' && Number.isFinite(x.hours) && x.hours >= 1 && x.hours <= LIM.hours)) return no('hours');
  if (!int(x.fam, 20) || x.fam < 1) return no('fam');
  if (!int(x.kids, 19) || x.kids > x.fam - 1) return no('kids');
  if (x.pct !== 80 && x.pct !== 100 && x.pct !== 120) return no('pct');
  const optMoney = function (v) { return v === null || v === undefined ? null : (int(v, LIM.money) && v > 0 ? v : false); };
  const pb = optMoney(x.pension_base), hb = optMoney(x.health_base);
  if (pb === false) return no('pension_base');
  if (hb === false) return no('health_base');
  const s = x.skip === undefined ? {} : x.skip;
  if (!isObj(s)) return no('skip');
  for (const k of ['pension', 'health', 'emp']) if (s[k] !== undefined && typeof s[k] !== 'boolean') return no('skip.' + k);
  if (x.dredge !== undefined && typeof x.dredge !== 'boolean') return no('dredge');
  return { ok: true, ver: { from: x.from, base: x.base, allow: x.allow, allow_ord: x.allow_ord, meal: x.meal, car: x.car, hours: x.hours, fam: x.fam, kids: x.kids, pct: x.pct,
    pension_base: pb, health_base: hb, skip: { pension: !!s.pension, health: !!s.health, emp: !!s.emp }, dredge: !!x.dredge } };
}
// 저장된 기준 문서 꼴 — 읽기·쓰기·복원이 같은 판정을 쓴다. { ok, doc } 또는 { ok:false, field }
function cleanBaseDoc(d) {
  if (!isObj(d) || d.schema !== 1) return { ok: false, field: 'doc' };
  if (typeof d.rev !== 'string' || !REV.test(d.rev)) return { ok: false, field: 'rev' };
  if (!Array.isArray(d.vers) || d.vers.length > LIM.vers) return { ok: false, field: 'vers' };
  const vers = [];
  for (let i = 0; i < d.vers.length; i++) {
    const c = cleanVer(d.vers[i]);
    if (!c.ok) return { ok: false, field: 'vers[' + i + '].' + c.field };
    if (i && !(vers[i - 1].from < c.ver.from)) return { ok: false, field: 'vers[' + i + '].from' };   // 적용 달 오름차순·겹침 없음
    vers.push(c.ver);
  }
  if (!int(d.updated_at, Number.MAX_SAFE_INTEGER)) return { ok: false, field: 'updated_at' };
  if (!textOk(String(d.updated_by || ''), LIM.by)) return { ok: false, field: 'updated_by' };
  return { ok: true, doc: { schema: 1, rev: d.rev, vers: vers, updated_at: d.updated_at, updated_by: String(d.updated_by || '') } };
}
// 판 얹기: 같은 from = 고침(fix) · 없던 from = 새 판(new). 판은 자르지 않는다 — 상한이면 VERS_FULL.
function putVer(doc, ver) {
  const vers = (doc ? doc.vers : []).slice();
  const i = vers.findIndex(function (v) { return v.from === ver.from; });
  let kind = 'new', changed = [];
  if (i >= 0) {
    const old = vers[i];
    changed = Object.keys(ver).filter(function (k) { return JSON.stringify(old[k]) !== JSON.stringify(ver[k]); });
    if (!changed.length) return { ok: false, code: 'NO_CHANGE' };
    vers[i] = ver; kind = 'fix';
  } else {
    if (vers.length >= LIM.vers) return { ok: false, code: 'VERS_FULL' };
    vers.push(ver); vers.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    changed = Object.keys(ver);
  }
  return { ok: true, vers: vers, kind: kind, changed: changed };
}
function dropVer(doc, from) {
  const vers = (doc ? doc.vers : []).slice(), i = vers.findIndex(function (v) { return v.from === from; });
  if (i < 0) return { ok: false, code: 'NO_VER' };
  vers.splice(i, 1);
  return { ok: true, vers: vers };
}
// 그 달에 쓰는 판 = from 이 그 달 이하인 마지막 판 · 없으면 null
function verFor(doc, ym) { let hit = null; (doc ? doc.vers : []).forEach(function (v) { if (v.from <= ym) hit = v; }); return hit; }

// ── ③ 단가·기간 설정 ─────────────────────────────────────────────
function cleanConfIn(x) {
  const no = function (f) { return { ok: false, field: f }; };
  if (!isObj(x)) return no('conf');
  let dredge = null;
  if (x.dredge !== null && x.dredge !== undefined) {
    const d = x.dredge;
    if (!isObj(d)) return no('dredge');
    if (!int(d.day, LIM.money) || d.day === 0) return no('dredge.day');
    if (!int(d.ot_hour, LIM.money)) return no('dredge.ot_hour');
    if (!half(d.free_days, 31)) return no('dredge.free_days');
    dredge = { day: d.day, ot_hour: d.ot_hour, free_days: d.free_days };
  }
  if (!int(x.period_day, 28) || x.period_day < 1) return no('period_day');
  if (!(x.pay_day === null || (int(x.pay_day, 31) && x.pay_day >= 1))) return no('pay_day');
  return { ok: true, conf: { dredge: dredge, period_day: x.period_day, pay_day: x.pay_day } };
}
function cleanConfDoc(d) {
  if (!isObj(d) || d.schema !== 1) return { ok: false, field: 'doc' };
  if (typeof d.rev !== 'string' || !REV.test(d.rev)) return { ok: false, field: 'rev' };
  const c = cleanConfIn(d);
  if (!c.ok) return c;
  if (!int(d.updated_at, Number.MAX_SAFE_INTEGER)) return { ok: false, field: 'updated_at' };
  if (!textOk(String(d.updated_by || ''), LIM.by)) return { ok: false, field: 'updated_by' };
  return { ok: true, doc: Object.assign({ schema: 1, rev: d.rev }, c.conf, { updated_at: d.updated_at, updated_by: String(d.updated_by || '') }) };
}

// ── ② 그 달 넣은 값 ──────────────────────────────────────────────
// period = 그 달 급여 기간(하수준설 날짜가 그 안이어야 함). { ok, row } 또는 { ok:false, field }
function cleanRowIn(x, period) {
  const no = function (f) { return { ok: false, field: f }; };
  if (!isObj(x)) return no('row');
  const row = {};
  for (const k of ['base', 'allow', 'meal', 'car']) {   // 기준과 다를 때만 그 달 값(빈 칸 = 기준 값)
    if (x[k] === null || x[k] === undefined) continue;
    if (!int(x[k], LIM.money)) return no(k);
    row[k] = x[k];
  }
  if (x.bonus !== undefined && x.bonus !== null) { if (!int(x.bonus, LIM.money)) return no('bonus'); if (x.bonus) row.bonus = x.bonus; }
  if (x.prorate !== undefined && x.prorate !== null) {   // 입사·퇴사 달 일할 = 월액 ÷ of × days(기본급·고정 수당·식대·자가운전 중 그 달 값을 넣지 않은 칸에)
    const p = x.prorate;
    if (!isObj(p) || !int(p.of, 31) || p.of < 28 || !int(p.days, 31) || p.days < 1 || p.days > p.of) return no('prorate');
    row.prorate = { days: p.days, of: p.of };
  }
  if (x.ot !== undefined && x.ot !== null) {
    if (!isObj(x.ot)) return no('ot');
    const ot = {};
    for (const k of ['ext', 'night', 'hol', 'hol8']) { const v = x.ot[k]; if (v === undefined || v === null || v === 0) continue; if (!half(v, LIM.hours)) return no('ot.' + k); ot[k] = v; }
    if (Object.keys(ot).length) row.ot = ot;
  }
  if (x.minus_hours !== undefined && x.minus_hours !== null && x.minus_hours !== 0) { if (!half(x.minus_hours, LIM.hours)) return no('minus_hours'); row.minus_hours = x.minus_hours; }
  if (x.adj_amt !== undefined && x.adj_amt !== null && x.adj_amt !== 0) { if (!Number.isInteger(x.adj_amt) || Math.abs(x.adj_amt) > LIM.money) return no('adj_amt'); row.adj_amt = x.adj_amt; }
  if (x.ded_fix !== undefined && x.ded_fix !== null) {   // 공제를 계산 대신 이 값으로(회계사무소·공단 금액을 따르기로 한 칸)
    if (!isObj(x.ded_fix)) return no('ded_fix');
    const f = {};
    for (const k of Object.keys(x.ded_fix)) { if (DED_FIX.indexOf(k) < 0) return no('ded_fix'); const v = x.ded_fix[k]; if (v === null || v === undefined) continue; if (!int(v, LIM.money)) return no('ded_fix.' + k); f[k] = v; }
    if (Object.keys(f).length) row.ded_fix = f;
  }
  if (x.dredge !== undefined && x.dredge !== null) {
    if (!Array.isArray(x.dredge) || x.dredge.length > LIM.lines) return no('dredge');
    const seen = new Set(), lines = [];
    for (let i = 0; i < x.dredge.length; i++) {
      const l = x.dredge[i], f = 'dredge[' + i + ']';
      if (!isObj(l)) return no(f);
      if (!realDay(l.d) || seen.has(l.d)) return no(f + '.d');
      if (period && (l.d < period.from || l.d > period.to)) return no(f + '.d');
      seen.add(l.d);
      if (l.days !== 1 && l.days !== 0.5) return no(f + '.days');
      const ot = l.ot === undefined || l.ot === null ? 0 : l.ot;
      if (!half(ot, 24)) return no(f + '.ot');
      const add = l.add === undefined || l.add === null ? 0 : l.add;
      if (!cents(add, LIM.money)) return no(f + '.add');
      const side = l.side === undefined || l.side === null ? '' : l.side;
      if (side !== '' && side !== 'in' && side !== 'out') return no(f + '.side');
      lines.push({ d: l.d, days: l.days, ot: ot, add: add, side: side });
    }
    lines.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    if (lines.length) row.dredge = lines;
  }
  if (x.note !== undefined && x.note !== null && x.note !== '') { if (!textOk(x.note, LIM.note)) return no('note'); row.note = x.note; }
  if (x.off !== undefined && x.off !== null && x.off !== false) { if (x.off !== true) return no('off'); row.off = true; }   // 이 달 이 대장에서 뺌(두 회사 재적·급여 없는 달)
  return { ok: true, row: row };
}
function cleanMonthDoc(d, key) {
  if (!isObj(d) || d.schema !== 1) return { ok: false, field: 'doc' };
  if (typeof d.rev !== 'string' || !REV.test(d.rev)) return { ok: false, field: 'rev' };
  if (CORPS.indexOf(d.corp) < 0 || !YM.test(String(d.ym || ''))) return { ok: false, field: 'corp' };
  if (key && key !== monthKey(d.corp, d.ym)) return { ok: false, field: 'key' };
  if (d.state !== 'open' && d.state !== 'closed') return { ok: false, field: 'state' };
  if (!isObj(d.rows) || Object.keys(d.rows).length > LIM.rows) return { ok: false, field: 'rows' };
  const rows = {};
  for (const mid of Object.keys(d.rows)) {
    if (!MID.test(mid)) return { ok: false, field: 'rows' };
    const c = cleanRowIn(d.rows[mid], null);
    if (!c.ok) return { ok: false, field: 'rows.' + mid + '.' + c.field };
    rows[mid] = c.row;
  }
  if (d.state === 'closed' && !isObj(d.frozen)) return { ok: false, field: 'frozen' };
  if (d.frozen !== null && d.frozen !== undefined) { const fz = frozenOk(d.frozen); if (!fz.ok) return fz; }
  if (!int(d.updated_at, Number.MAX_SAFE_INTEGER)) return { ok: false, field: 'updated_at' };
  return { ok: true, doc: Object.assign({}, d, { rows: rows, frozen: d.frozen || null }) };
}
// 얼린 계산(확정 때) 꼴 — 화면이 그대로 그리는 칸만 본다(복원으로 들어온 틀린 꼴이 대장 화면을 멈추지 않게)
function frozenOk(f) {
  const num = function (v) { return typeof v === 'number' && Number.isFinite(v); };
  const numN = function (v) { return v === null || num(v); };
  if (!isObj(f) || !isObj(f.rows) || Object.keys(f.rows).length > LIM.rows) return { ok: false, field: 'frozen' };
  if (typeof f.law_ver !== 'string' || !int(f.at, Number.MAX_SAFE_INTEGER)) return { ok: false, field: 'frozen' };
  if (!isObj(f.period) || !realDay(f.period.from) || !realDay(f.period.to)) return { ok: false, field: 'frozen.period' };
  for (const mid of Object.keys(f.rows)) {
    const r = f.rows[mid], bad = { ok: false, field: 'frozen.rows.' + mid };
    if (!MID.test(mid) || !isObj(r) || !isObj(r.cols) || !isObj(r.ded)) return bad;
    if (!COLS.every(function (c) { return num(r.cols[c]); }) || !['pension', 'health', 'care', 'emp', 'income', 'local'].every(function (k) { return numN(r.ded[k]); })) return bad;
    if (!['taxable', 'gross', 'ded_total', 'net'].every(function (k) { return num(r[k]); }) || !Array.isArray(r.lines) || !Array.isArray(r.notes)) return bad;
    for (const k of ['name', 'rank', 'hire_date', 'emp_no']) if (!textOk(String(r[k] || ''), 60)) return bad;
  }
  return { ok: true };
}
function monthKey(corp, ym) { return 'pay:month:' + corp + ':' + ym; }
function baseKey(corp, mid) { return 'pay:base:' + corp + ':' + mid; }
const CONF_KEY = 'pay:conf';
// 백업 복원·꼴 점검 한 곳 — 키 모양으로 문서 종류를 고른다. 모르는 pay: 키는 거절
function docOk(key, data) {
  const k = String(key || '');
  let m = /^pay:base:(env|con):([A-Za-z0-9_-]{1,40})$/.exec(k);
  if (m) return cleanBaseDoc(data);
  m = /^pay:month:(env|con):(\d{4}-(0[1-9]|1[0-2]))$/.exec(k);
  if (m) return cleanMonthDoc(data, k);
  if (k === CONF_KEY) return cleanConfDoc(data);
  return { ok: false, field: 'key' };
}

// ── 계산 ─────────────────────────────────────────────────────────
// 하수준설 날짜별 줄 → 줄마다 지급 일수·금액과 합계. conf = { day, ot_hour, free_days }
function dredgeCalc(lines, conf) {
  let acc = 0, paidDays = 0, otSum = 0, addSum = 0, total = 0, days = 0;
  const out = (lines || []).map(function (l) {
    let paid;
    if (l.side === 'out') paid = l.days;   // 사람이 '지급'으로 바꾼 날 — 포함 일수를 세지 않음
    else if (l.side === 'in') { paid = 0; acc += l.days; }   // 사람이 '포함'으로 바꾼 날
    else { const left = Math.max(0, conf.free_days - acc); const inFree = Math.min(l.days, left); paid = l.days - inFree; acc += l.days; }
    const amt = paid * conf.day + l.ot * conf.ot_hour + l.add;
    days += l.days; paidDays += paid; otSum += l.ot; addSum += l.add; total += amt;
    return { d: l.d, days: l.days, ot: l.ot, add: l.add, side: l.side, paid: paid, auto: l.side === '' ? (paid === 0 ? 'in' : (paid === l.days ? 'out' : 'part')) : l.side, amt: Math.round(amt * 100) / 100 };
  });
  return { lines: out, days: days, in_days: Math.min(acc, conf.free_days), paid_days: paidDays, ot: otSum, add: Math.round(addSum * 100) / 100, total: Math.round(total) };   // 합계는 원 미만 반올림(줄 금액은 두 자리까지 보임)
}
// 한 사람 한 달 계산 입력 만들기. ver = 그 달 기준 판 · row = 그 달 넣은 값(없으면 {}) · conf = 설정(하수준설 단가 · 없으면 null) · capsRes = PAYBG.capsFor 결과
//   반환 { ok:true, inp, cols, dredge, notes } 또는 { ok:false, why, keys }
function buildInput(ver, row, conf, capsRes) {
  row = row || {};
  if (!ver) return { ok: false, why: 'NO_BASE', keys: [] };
  if (capsRes.overlap.length) return { ok: false, why: 'RATE_OVERLAP', keys: capsRes.overlap };
  const notes = [];
  const pr = row.prorate || null;
  const take = function (k) { if (own(row, k)) return row[k]; return pr ? Math.round(ver[k] * pr.days / pr.of) : ver[k]; };
  const base = take('base'), allow = take('allow'), meal = take('meal'), car = take('car');
  if (pr) notes.push('일할 ' + pr.days + '/' + pr.of + ' — 그 달 값을 넣지 않은 기본급·수당·식대·자가운전에 월액 ÷ ' + pr.of + ' × ' + pr.days + '(원 미만 반올림)');
  let dr = null;
  if (row.dredge && row.dredge.length) {
    if (!conf || !conf.dredge) return { ok: false, why: 'NO_DREDGE_CONF', keys: ['dredge'] };
    dr = dredgeCalc(row.dredge, conf.dredge);
    if (!ver.dredge) notes.push('하수준설 수당 대상이 아닌 사람에게 준설 날짜가 들어 있음 — 기준의 대상 표시 확인');
  }
  const fixed = [];
  if (allow) fixed.push({ n: '수당', amt: allow, taxfree: false, ord: ver.allow_ord, col: 'allow' });
  if (dr && dr.total) fixed.push({ n: '하수준설 수당', amt: dr.total, taxfree: false, ord: false, col: 'allow' });
  if (row.bonus) fixed.push({ n: '상여금', amt: row.bonus, taxfree: false, ord: false, col: 'bonus' });
  const tf = function (k, n, v) {
    if (!v) return;
    const cap = capsRes.caps[k];
    if (!(cap > 0)) { fixed.push({ n: n, amt: v, taxfree: false, ord: false, col: k }); notes.push(n + ': 비과세 한도를 근거 표에서 찾지 못해 과세로 계산'); return; }
    const free = Math.min(v, cap);
    fixed.push({ n: n, amt: free, taxfree: true, ord: false, col: k });
    if (v > free) { fixed.push({ n: n + '(한도 초과분)', amt: v - free, taxfree: false, ord: false, col: k }); notes.push(n + ': 비과세 한도를 넘는 금액은 과세'); }
  };
  tf('meal', '식대', meal); tf('car', '자가운전보조금', car);
  const ordMonth = ver.base + (ver.allow_ord ? ver.allow : 0);   // 통상시급은 기준 월액으로(일할·그 달 값으로 줄어든 달에도 시급이 낮아지지 않게)
  if ((row.ot || row.minus_hours) && (pr || own(row, 'base') || (ver.allow_ord && own(row, 'allow')))) notes.push('통상시급은 기준 월액(기본급' + (ver.allow_ord ? ' + 통상임금에 넣은 수당' : '') + ') ÷ 월 소정근로시간으로 계산');
  const inp = { base: base, hours: ver.hours, fixed: fixed, ot: row.ot || {}, fam: ver.fam, kids: ver.kids, pct: ver.pct, skip: ver.skip, fixed_ded: row.ded_fix || {}, ord_month: ordMonth };
  if (row.minus_hours) inp.minus_hours = row.minus_hours;
  if (row.adj_amt) inp.adj_amt = row.adj_amt;
  if (ver.pension_base) inp.pension_base = ver.pension_base;
  if (ver.health_base) inp.health_base = ver.health_base;
  return { ok: true, inp: inp, dredge: dr, notes: notes };
}
// calcMonth 결과 → 급여대장 칸(기본급·수당·초과/차감·상여·식대·자가운전 · 적용총액 · 지급총액 · 공제 여섯 · 공제합계 · 차인지급액)
function toCols(m) {
  const cols = {}; COLS.forEach(function (c) { cols[c] = 0; });
  m.lines.forEach(function (l) { const c = COLS.indexOf(l.col) >= 0 ? l.col : 'adj'; cols[c] += l.amt; });
  const d = {}; m.deds.forEach(function (x) { d[x.n] = x.amt; });
  return { cols: cols, taxable: m.taxable, gross: m.gross, ded: { pension: own(d, '국민연금') ? d['국민연금'] : null, health: own(d, '건강보험') ? d['건강보험'] : null, care: own(d, '장기요양보험') ? d['장기요양보험'] : null, emp: own(d, '고용보험') ? d['고용보험'] : null, income: d['소득세'], local: d['지방소득세'] }, ded_total: m.ded_total, net: m.net, hourly: m.hourly, lines: m.lines, notes: m.notes };
}
module.exports = { YM: YM, REV: REV, MID: MID, CORPS: CORPS, LIM: LIM, COLS: COLS, CONF_KEY: CONF_KEY, monthKey: monthKey, baseKey: baseKey, ymAdd: ymAdd, periodOf: periodOf, realDay: realDay, textOk: textOk,
  cleanVer: cleanVer, cleanBaseDoc: cleanBaseDoc, putVer: putVer, dropVer: dropVer, verFor: verFor, cleanConfIn: cleanConfIn, cleanConfDoc: cleanConfDoc, cleanRowIn: cleanRowIn, cleanMonthDoc: cleanMonthDoc, docOk: docOk,
  dredgeCalc: dredgeCalc, buildInput: buildInput, toCols: toCols, frozenOk: frozenOk };
