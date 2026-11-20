// 66 급여 판1(원장 C236) — 급여 계산(순수 함수). 요율·세액표는 전부 인자로 받는다(paybg.ratesFor 의 rates·tax) — 이 파일에 요율 숫자를 적지 않는다.
//   끝수: 보험료는 10원 미만 버림(CUT)을 기본으로 쓴다 — 공단 보험료에 국고금 관리법 47조가 그대로 적용되는지는 근거 표 '확인 필요' 행(pay.cut)이라, 공단 고지액 칸(fixed_ded)이 있으면 그 값이 우선.
//   통상임금에 어느 수당이 드는지, 어느 수당이 비과세인지는 이 파일이 정하지 않는다 — 줄마다 넣는 쪽이 정한 표시(ord·taxfree)만 읽는다(비과세 한도 적용도 넣는 쪽 몫).
//   입력 금액은 0 이상의 숫자만 받는다 — 글자·음수·NaN 은 0으로 바꾸지 않고 던진다(PAY_BAD_INPUT: 칸 이름). 빼는 금액은 ded 줄로 넣는다.
'use strict';
const CUT = 10;
function floorTo(v, unit) { unit = unit > 0 ? unit : 1; return Math.floor((v + 1e-6) / unit) * unit; }
function bad(what) { const e = new Error('PAY_BAD_INPUT: ' + what); e.code = 'PAY_BAD_INPUT'; e.field = what; return e; }
function amt(v, what) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(what); return Math.round(v); }
function opt(v, what) { return (v === undefined || v === null) ? null : amt(v, what); }   // 빈 칸 = null · 있으면 0 이상의 숫자

// 근로소득 간이세액(소득세법 시행령 별표 2): taxable = 그 달 과세 급여(원 — 비과세·학자금 제외) · fam = 공제대상가족 수(본인 포함) · kids = 8세 이상 20세 이하 자녀 수 · pct = 80|100|120
function simpTax(tax, taxable, fam, kids, pct) {
  taxable = amt(taxable, 'taxable');
  fam = (fam === undefined || fam === null) ? 1 : fam; kids = (kids === undefined || kids === null) ? 0 : kids; pct = (pct === undefined || pct === null) ? 100 : pct;
  if (!Number.isInteger(fam) || fam < 1) throw bad('fam');
  if (!Number.isInteger(kids) || kids < 0 || kids > fam - 1) throw bad('kids');   // 자녀는 본인을 뺀 가족 수를 넘지 못함
  if (pct !== 80 && pct !== 100 && pct !== 120) throw bad('pct');
  const k = taxable / 1000;
  const col = function (arr, off) {   // 11명 초과 = 별표 2 제4호(11명 세액 − (10명 세액 − 11명 세액) × 초과 인원)
    if (fam <= 11) return arr[off + fam - 1];
    const t11 = arr[off + 10], t10 = arr[off + 9];
    return Math.max(0, t11 - (t10 - t11) * (fam - 11));
  };
  let t;
  if (k < tax.below) t = 0;
  else if (k < 10000) {
    let lo = 0, hi = tax.rows.length - 1, r = null;
    while (lo <= hi) { const m = (lo + hi) >> 1, x = tax.rows[m]; if (k < x[0]) hi = m - 1; else if (k >= x[1]) lo = m + 1; else { r = x; break; } }
    if (!r) throw new Error('SIMPTAX_NO_ROW');
    t = col(r, 2);
  } else {
    t = col(tax.top, 0);
    if (k > 10000) {
      const o = tax.over.filter(function (x) { return k > x.gt && (x.le == null || k <= x.le); })[0];
      if (!o) throw new Error('SIMPTAX_NO_OVER');
      t = t + o.add + (taxable - o.base * 1000) * o.k * o.rate;
    }
  }
  if (kids === 1) t -= tax.child.one; else if (kids === 2) t -= tax.child.two; else if (kids >= 3) t -= tax.child.two + (kids - 2) * tax.child.more_each;
  if (!Number.isFinite(t)) throw new Error('SIMPTAX_BAD_TABLE');
  if (t < 0) t = 0;
  return floorTo(t * pct / 100, 10);
}

// 한 사람 한 달. inp:
//   base 기본급 · hours 월 소정근로시간 · fixed [{n, amt, taxfree, ord}] 고정 수당(ord = 통상임금에 넣기로 정한 수당) · extra [{n, amt, taxfree}] 그 달 수당
//   ot {ext, night, hol, hol8} 시간 수 · ded [{n, amt}] 그 달 공제 · fam · kids · pct
//   pension_base(기준소득월액) · health_base(보수월액) — 공단 신고 금액. 없으면 그 달 과세 급여로 계산하고 안내를 붙인다
//   skip {pension, health, emp} 가입 제외 표시 · fixed_ded {pension, health, care, emp} 공단 고지액(있으면 계산 대신 그 값)
function calcMonth(rates, tax, inp) {
  const lines = [], notes = [];
  const fixed = Array.isArray(inp.fixed) ? inp.fixed : [], extra = Array.isArray(inp.extra) ? inp.extra : [], ot = inp.ot || {};
  const base = amt(inp.base, 'base'), hours = opt(inp.hours, 'hours') || 0;
  lines.push({ n: '기본급', amt: base, taxfree: false });
  let ord = base;
  fixed.forEach(function (x, i) { const a = amt(x && x.amt, 'fixed[' + i + ']'); if (x.ord) ord += a; lines.push({ n: String(x.n || ''), amt: a, taxfree: !!x.taxfree }); });
  // 통상시급 = 통상임금 ÷ 월 소정근로시간, 원 미만 올림(가산임금이 '이상'이 되도록) — 명세서 계산식 글과 금액이 같은 시급을 쓴다
  const hourly = hours > 0 ? Math.ceil(ord / hours - 1e-9) : 0;
  const OT = [['ext', '연장근로수당', 1 + rates.ot.ext], ['night', '야간근로 가산', rates.ot.night], ['hol', '휴일근로수당', 1 + rates.ot.hol], ['hol8', '휴일근로수당(8시간 초과)', 1 + rates.ot.hol8]];
  let otHours = 0;
  OT.forEach(function (d) {
    const h = ot[d[0]] === undefined || ot[d[0]] === null ? 0 : ot[d[0]];
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) throw bad('ot.' + d[0]);
    if (!h) return;
    otHours += h;
    lines.push({ n: d[1], amt: Math.ceil(hourly * h * d[2] - 1e-6), taxfree: false, hours: h, how: '통상시급 ' + hourly.toLocaleString('ko-KR') + '원 × ' + h + '시간 × ' + d[2] });
  });
  if (otHours > 0 && !(hours > 0)) notes.push('월 소정근로시간이 비어 시간 수당을 계산하지 못함');
  extra.forEach(function (x, i) { lines.push({ n: String((x && x.n) || ''), amt: amt(x && x.amt, 'extra[' + i + ']'), taxfree: !!(x && x.taxfree) }); });
  const gross = lines.reduce(function (s, x) { return s + x.amt; }, 0);
  const taxable = lines.filter(function (x) { return !x.taxfree; }).reduce(function (s, x) { return s + x.amt; }, 0);
  const skip = inp.skip || {}, fd = inp.fixed_ded || {}, deds = [];
  const fx = { pension: opt(fd.pension, 'fixed_ded.pension'), health: opt(fd.health, 'fixed_ded.health'), care: opt(fd.care, 'fixed_ded.care'), emp: opt(fd.emp, 'fixed_ded.emp') };
  const pbIn = opt(inp.pension_base, 'pension_base'), hbIn = opt(inp.health_base, 'health_base');
  if (!skip.pension) {
    let a = fx.pension;
    if (a == null) {
      if (!pbIn) notes.push('국민연금: 기준소득월액 칸이 비어 그 달 과세 급여로 계산 — 공단 고지액과 다를 수 있음');
      a = floorTo(Math.min(Math.max(pbIn || taxable, rates.pension.min), rates.pension.max) * rates.pension.ee, CUT);
    }
    deds.push({ n: '국민연금', amt: a });
  }
  if (!skip.health) {
    if (!hbIn && (fx.health == null || fx.care == null)) notes.push((fx.health == null ? '건강보험' : '장기요양보험') + ': 보수월액 칸이 비어 그 달 과세 급여로 계산 — 공단 고지액과 다를 수 있음');
    const prem = Math.min(Math.max((hbIn || taxable) * rates.health.rate, rates.health.prem_min), rates.health.prem_max);   // 회사 몫 포함 월 보험료(상·하한 안)
    deds.push({ n: '건강보험', amt: fx.health != null ? fx.health : floorTo(prem * rates.health.share, CUT) });
    deds.push({ n: '장기요양보험', amt: fx.care != null ? fx.care : floorTo(prem * (rates.care.rate / rates.health.rate) * rates.health.share, CUT) });   // 건강보험료 × (장기요양보험료율 ÷ 건강보험료율)
  }
  if (!skip.emp) deds.push({ n: '고용보험', amt: fx.emp != null ? fx.emp : floorTo(taxable * rates.emp.ee, CUT) });
  const it = simpTax(tax, taxable, inp.fam, inp.kids, inp.pct);
  deds.push({ n: '소득세', amt: it });
  deds.push({ n: '지방소득세', amt: floorTo(it * rates.local, 10) });
  (Array.isArray(inp.ded) ? inp.ded : []).forEach(function (x, i) { deds.push({ n: String((x && x.n) || ''), amt: amt(x && x.amt, 'ded[' + i + ']') }); });
  const dsum = deds.reduce(function (s, x) { return s + x.amt; }, 0);
  return { lines: lines, gross: gross, taxable: taxable, hourly: hourly, deds: deds, ded_total: dsum, net: gross - dsum, notes: notes };
}
module.exports = { simpTax: simpTax, calcMonth: calcMonth, floorTo: floorTo, CUT: CUT };
