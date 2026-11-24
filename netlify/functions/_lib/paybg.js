// 66 급여 판1(원장 C236) — 급여 법령 근거 표(bg:pay:law:v1) 꼴 검사·요약·요율 고르기. 순수 함수(저장소·시각을 모름).
//   근거 표 = 자료 저장소 collectors/pay_bg.py 가 법제처 원문 인용을 대조해 만든 판. 값은 분수(n/d) · from~to = 급여 귀속 달(YYYY-MM · to 빈 값 = 다음 판까지).
//   간이세액표만 기준이 다르다: 귀속 달이 아니라 원천징수하는(지급하는) 달(소득세법 시행령 부칙 — '2026년 3월 1일 이후 원천징수하는 경우부터').
//   이 파일과 paycalc.js 에는 요율 숫자를 적지 않는다 — 값은 표에서만 온다. 승격 여부는 이 파일이 모른다(부르는 쪽이 승격본만 넘겨야 함).
'use strict';
const VER = /^[A-Za-z0-9_.-]{2,40}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const KEY = /^[a-z0-9_]{2,20}\.[a-z0-9_]{2,20}$/;
const ROWS_MAX = 500;
const SHA = /^[0-9a-f]{8,60}$/;   // 내용 지문 — PM 콘솔 인자 칸 길이(60) 안
// 계산이 꼭 읽는 키(자료 저장소 pay_bg.py NEED 와 같은 목록)
const NEED = ['pension.ee', 'pension.base_unit', 'pension.base_min', 'pension.base_max', 'health.rate', 'health.ee_share', 'health.prem_max', 'health.prem_min', 'care.rate', 'emp.ui_rate', 'emp.ee_share', 'tax.local', 'cut.pension', 'cut.health', 'cut.care', 'cut.local', 'cut.income', 'ot.ext', 'ot.night', 'ot.hol', 'ot.hol8'];
const OPT = ['cut.emp'];   // 없어도 되는 키(확인 필요로 남은 값) — 있으면 한 행만
const nat = function (x) { return Number.isInteger(x) && x >= 0; };
const pos = function (x) { return typeof x === 'number' && Number.isFinite(x) && x > 0; };

function rowOk(r) {
  return !!(r && typeof r.id === 'string' && typeof r.key === 'string' && KEY.test(r.key) && (r.grade === '실측' || r.grade === '확인 필요') && typeof r.calc === 'boolean' && !(r.grade === '확인 필요' && r.calc !== false)
    && Number.isInteger(r.n) && Number.isInteger(r.d) && r.d > 0 && r.n >= 0 && typeof r.from === 'string' && YM.test(r.from) && (r.to === '' || (typeof r.to === 'string' && YM.test(r.to) && r.to >= r.from)));
}
function taxOk(t, m) {
  if (!(t && m && typeof m.from === 'string' && YM.test(m.from) && (m.to === undefined || m.to === '' || (typeof m.to === 'string' && YM.test(m.to) && m.to >= m.from)))) return false;
  if (!(Array.isArray(t.rows) && t.rows.length >= 100 && Array.isArray(t.top) && t.top.length === 11 && t.top.every(nat) && Array.isArray(t.over) && t.over.length >= 2 && t.child && nat(t.below))) return false;
  if (!(pos(t.child.one) && pos(t.child.two) && pos(t.child.more_each))) return false;
  let prev = t.below;
  for (const r of t.rows) { if (!(Array.isArray(r) && r.length === 13 && r.every(nat) && r[0] === prev && r[1] > r[0])) return false; prev = r[1]; }
  let gt = prev;   // 초과 산식: 표 끝에서 시작해 빈틈없이 이어지고 마지막 줄만 끝이 열림
  for (let i = 0; i < t.over.length; i++) {
    const o = t.over[i], last = i === t.over.length - 1;
    if (!(o && o.gt === gt && o.base === o.gt && nat(o.add) && pos(o.k) && pos(o.rate) && (last ? o.le === null : (nat(o.le) && o.le > o.gt)))) return false;
    gt = o.le;
  }
  return true;
}
function bgOk(x) {
  if (!(x && typeof x === 'object' && x.schema === 1 && x.domain === 'pay' && typeof x.ver === 'string' && VER.test(x.ver) && Array.isArray(x.rows) && x.rows.length && x.rows.length <= ROWS_MAX && typeof x.sha === 'string' && SHA.test(x.sha))) return false;
  const ids = {};
  for (const r of x.rows) { if (!rowOk(r) || ids[r.id]) return false; ids[r.id] = 1; }
  return taxOk(x.simptax, x.simptax_meta);
}
// 꼭 읽는 키 가운데 계산에 쓰는 행이 하나도 없는 키 — 이 목록이 비지 않은 표는 승격해도 어느 달도 계산하지 못한다(옛 꼴 표)
function missing(bg) { const have = Object.create(null); bg.rows.forEach(function (r) { if (r.calc === true) have[r.key] = 1; }); return NEED.filter(function (k) { return !have[k]; }); }
function bgSum(bg) {   // 서버가 행에서 다시 셈(판 머리의 n_* 를 믿지 않음)
  let ck = '';
  bg.rows.forEach(function (r) { const c = typeof r.checked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.checked) ? r.checked : ''; if (c > ck) ck = c; });
  return { ver: bg.ver, sha: bg.sha, checked: ck, n: bg.rows.length, n_pending: bg.rows.filter(function (r) { return r.grade === '확인 필요'; }).length, n_calc_false: bg.rows.filter(function (r) { return r.calc === false; }).length, tax_from: bg.simptax_meta.from, tax_rows: bg.simptax.rows.length, missing: missing(bg) };
}
// 요율 한 벌: ym = 급여 귀속 달(보험료·가산율) · payYm = 지급하는 달(간이세액표 — 안 주면 귀속 달과 같은 달로 봄).
//   꼭 읽는 키 가운데 그 달을 덮는 행이 없거나 둘 이상이면 계산하지 않는다({ ok:false, why, keys }).
function ratesFor(bg, ym, payYm) {
  if (!YM.test(String(ym || ''))) return { ok: false, why: 'BAD_YM', keys: [] };
  const pym = (payYm === undefined || payYm === null || payYm === '') ? ym : payYm;
  if (!YM.test(String(pym)) || pym < ym) return { ok: false, why: 'BAD_PAY_YM', keys: [] };   // 지급 달이 귀속 달보다 앞설 수 없음
  const hit = Object.create(null), miss = [], dup = [];
  bg.rows.forEach(function (r) { if (r.calc === true && r.from <= ym && (r.to === '' || ym <= r.to)) (hit[r.key] = hit[r.key] || []).push(r); });
  NEED.forEach(function (k) { const h = hit[k] || []; if (!h.length) miss.push(k); else if (h.length > 1) dup.push(k); });
  OPT.forEach(function (k) { if ((hit[k] || []).length > 1) dup.push(k); });
  if (miss.length) return { ok: false, why: 'NO_RATE', keys: miss };
  if (dup.length) return { ok: false, why: 'RATE_OVERLAP', keys: dup };
  const zero = NEED.filter(function (k) { return !(hit[k][0].n > 0); });   // 꼭 읽는 값이 0 이면 계산하지 않음(값 범위 전체는 수집기 게이트 몫)
  if (zero.length) return { ok: false, why: 'BAD_RATE', keys: zero };
  const m = bg.simptax_meta;
  if (!(m.from <= pym && (!m.to || pym <= m.to))) return { ok: false, why: 'NO_TAX_TABLE', keys: ['simptax'] };
  const v = function (k) { const r = hit[k][0]; return r.n / r.d; };
  const opt1 = function (k) { const h = hit[k]; return h && h.length === 1 ? h[0].n / h[0].d : null; };   // 없어도 되는 키 — 없으면 null(겹치면 위에서 RATE_OVERLAP)
  const used = {}; NEED.forEach(function (k) { used[k] = hit[k][0].id; }); OPT.forEach(function (k) { if (hit[k]) used[k] = hit[k][0].id; });
  return { ok: true, ym: ym, pay_ym: pym, ver: bg.ver, sha: bg.sha, used: used, tax: Object.assign({}, bg.simptax, { cut: v('cut.income') }),
    rates: { pension: { ee: v('pension.ee'), unit: v('pension.base_unit'), min: v('pension.base_min'), max: v('pension.base_max') },
      health: { rate: v('health.rate'), share: v('health.ee_share'), prem_max: v('health.prem_max'), prem_min: v('health.prem_min') },
      care: { rate: v('care.rate') }, emp: { ee: v('emp.ui_rate') * v('emp.ee_share') }, local: v('tax.local'),
      cut: { pension: v('cut.pension'), health: v('cut.health'), care: v('cut.care'), local: v('cut.local'), emp: opt1('cut.emp') },
      ot: { ext: v('ot.ext'), night: v('ot.night'), hol: v('ot.hol'), hol8: v('ot.hol8') } } };
}
// 66 판2 승격 판정(순수 — 저장소를 모름). gw-pay 가 쓰고, gw-data payBgState 와 같은 판정이다(servertest 가 같은 입력으로 두 판정을 대조).
//   fr = { ok, flag }(스위치 — 없음 = ok·{}) · br = { ok, bg }(근거 표 — 없음 = ok·null). 반환 { on:true, bg } 또는 { on:false, why }
function lawPick(fr, br) {
  if (!fr || fr.ok !== true || !fr.flag || typeof fr.flag !== 'object' || Array.isArray(fr.flag)) return { on: false, why: 'FLAG_READ_FAILED' };
  if (!br || br.ok !== true) return { on: false, why: 'BG_READ_FAILED' };
  const bg = br.bg, flag = fr.flag;
  if (!bg) return { on: false, why: 'NO_BG' };
  if (!bgOk(bg)) return { on: false, why: 'BAD_BG' };
  const ver = typeof flag.bg_ver === 'string' ? flag.bg_ver : '', sha = typeof flag.bg_sha === 'string' ? flag.bg_sha : '';
  if (!ver || ver !== bg.ver || !sha) return { on: false, why: 'NOT_PROMOTED' };
  if (sha !== bg.sha) return { on: false, why: 'SHA_CHANGED' };
  return { on: true, bg: bg };
}
// 그 달의 비과세 한도(원) — 식대·자가운전보조금. 그 달을 덮는 계산 행이 하나면 값, 없으면 빠짐(한도 모름), 둘 이상이면 overlap 에 키 이름(부르는 쪽이 계산을 멈춤)
const CAP_KEYS = { meal: 'taxfree.meal', car: 'taxfree.car' };
function capsFor(bg, ym) {
  const caps = {}, overlap = [];
  Object.keys(CAP_KEYS).forEach(function (k) {
    const hit = bg.rows.filter(function (r) { return r.key === CAP_KEYS[k] && r.calc === true && r.from <= ym && (r.to === '' || ym <= r.to); });
    if (hit.length === 1) caps[k] = hit[0].n / hit[0].d; else if (hit.length > 1) overlap.push(CAP_KEYS[k]);
  });
  return { caps: caps, overlap: overlap };
}
// 그 달 나이 문턱(가입 제외 제안용) — 행이 하나일 때만 값, 아니면 null(제안하지 않음)
function ageFor(bg, key, ym) {
  const hit = bg.rows.filter(function (r) { return r.key === key && r.calc === true && r.from <= ym && (r.to === '' || ym <= r.to); });
  return hit.length === 1 ? hit[0].n / hit[0].d : null;
}
module.exports = { VER: VER, SHA: SHA, NEED: NEED, ROWS_MAX: ROWS_MAX, missing: missing, bgOk: bgOk, bgSum: bgSum, ratesFor: ratesFor, lawPick: lawPick, capsFor: capsFor, ageFor: ageFor };
