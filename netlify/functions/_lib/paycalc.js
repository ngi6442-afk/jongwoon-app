// 66 급여 판1(원장 C236) — 급여 계산(순수 함수). 요율·세액표는 전부 인자로 받는다(paybg.ratesFor 의 rates·tax) — 이 파일에 요율 숫자를 적지 않는다.
//   끝수: 국민연금·건강보험·장기요양·지방소득세의 버림 단위는 근거 표 cut.* 행에서 온다(국민연금법 117조 · 국민건강보험법 107조 · 노인장기요양보험법 64조 · 지방세기본법 59조 — 국고금 관리법 47조 준용). 소득세 끝수 단위도 표(cut.income — 국고금 관리법 47조①)에서 온다.
//         고용보험료만 끝수 조문을 찾지 못해(근거 표 cut.emp '확인 필요') 기본값 CUT(10원 미만 버림)을 쓴다. 어느 보험이든 공단 고지액 칸(fixed_ded)이 있으면 그 값이 우선.
//   통상임금에 어느 수당이 드는지, 어느 수당이 비과세인지는 이 파일이 정하지 않는다 — 줄마다 넣는 쪽이 정한 표시(ord·taxfree)만 읽는다(비과세 한도 적용도 넣는 쪽 몫).
//   입력 금액은 0 이상의 숫자만 받는다 — 글자·음수·NaN 은 0으로 바꾸지 않고 던진다(PAY_BAD_INPUT: 칸 이름). 빼는 금액은 ded 줄로 넣는다.
'use strict';
const CUT = 10;
function badRates(what) { const e = new Error('PAY_BAD_RATES: ' + what); e.code = 'PAY_BAD_RATES'; e.field = what; return e; }
function floorTo(v, unit) { if (!(Number.isInteger(unit) && unit > 0)) throw badRates('unit'); return Math.floor((v + 1e-6) / unit) * unit; }   // 단위가 없으면 조용히 1원 단위로 계산하지 않고 던진다
function bad(what) { const e = new Error('PAY_BAD_INPUT: ' + what); e.code = 'PAY_BAD_INPUT'; e.field = what; return e; }
function amt(v, what) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw bad(what); return Math.round(v) || 0; }   // || 0 = -0 을 0 으로
function hrs(v, what) { if (v === undefined || v === null) return 0; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(what); return v; }   // 시간 수는 반올림하지 않는다(소수 시간 그대로)
function colOf(x) { return x && typeof x.col === 'string' && /^[a-z]{2,8}$/.test(x.col) ? x.col : ''; }   // 66 판2 급여대장 칸 이름(base·allow·adj·bonus·meal·car) — 계산에는 안 쓰고 칸 나누기에만
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
  if (!(Number.isInteger(tax.cut) && tax.cut > 0)) throw badRates('tax.cut');   // 소득세 끝수 단위 — 근거 표 cut.income(paybg.ratesFor 가 세액표에 실어 줌)
  return floorTo(t * pct / 100, tax.cut);
}

// 한 사람 한 달. inp:
//   base 기본급 · hours 월 소정근로시간 · fixed [{n, amt, taxfree, ord}] 고정 수당(ord = 통상임금에 넣기로 정한 수당) · extra [{n, amt, taxfree}] 그 달 수당
//   ot {ext, night, hol, hol8} 시간 수 · ded [{n, amt}] 그 달 공제 · fam · kids · pct
//   pension_base(기준소득월액) · health_base(보수월액) — 공단 신고 금액. 없으면 그 달 과세 급여로 계산하고 안내를 붙인다
//   skip {pension, health, emp} 가입 제외 표시 · fixed_ded {pension, health, care, emp} 공단 고지액(있으면 계산 대신 그 값)
function calcMonth(rates, tax, inp) {
  // 끝수 단위·기준소득월액 단위는 근거 표에서 온 값이어야 한다 — 빠졌으면 다른 단위로 조용히 계산하지 않고 던진다(PAY_BAD_RATES: 칸 이름). 고용보험만 표에 값이 없으면(확인 필요) 기본값 CUT
  const cut = (rates && rates.cut) || {};
  [['cut.pension', cut.pension], ['cut.health', cut.health], ['cut.care', cut.care], ['cut.local', cut.local], ['pension.unit', rates && rates.pension && rates.pension.unit]].forEach(function (p) { if (!(Number.isInteger(p[1]) && p[1] > 0)) throw badRates(p[0]); });
  const cutEmp = (cut.emp === undefined || cut.emp === null) ? CUT : cut.emp;
  if (!(Number.isInteger(cutEmp) && cutEmp > 0)) throw badRates('cut.emp');
  const lines = [], notes = [];
  const fixed = Array.isArray(inp.fixed) ? inp.fixed : [], extra = Array.isArray(inp.extra) ? inp.extra : [], ot = inp.ot || {};
  const base = amt(inp.base, 'base'), hours = hrs(inp.hours, 'hours');
  lines.push({ n: '기본급', amt: base, taxfree: false, col: 'base' });
  let ord = base;
  fixed.forEach(function (x, i) { const a = amt(x && x.amt, 'fixed[' + i + ']'); if (x.ord) ord += a; lines.push({ n: String(x.n || ''), amt: a, taxfree: !!x.taxfree, col: colOf(x) }); });
  // 통상시급 = 통상임금 ÷ 월 소정근로시간, 원 미만 올림(가산임금이 '이상'이 되도록) — 명세서 계산식 글과 금액이 같은 시급을 쓴다
  const hourly = hours > 0 ? (Math.ceil(ord / hours - 1e-9) || 0) : 0;   // || 0 = 통상임금 0일 때 -0 이 글에 찍히지 않게
  if (!Number.isFinite(hourly)) throw bad('hours');   // 0에 아주 가까운 시간 수
  const OT = [['ext', '연장근로수당', 1 + rates.ot.ext], ['night', '야간근로 가산', rates.ot.night], ['hol', '휴일근로수당', 1 + rates.ot.hol], ['hol8', '휴일근로수당(8시간 초과)', 1 + rates.ot.hol8]];
  let otHours = 0;
  OT.forEach(function (d) {
    const h = hrs(ot[d[0]], 'ot.' + d[0]);
    if (!h) return;
    otHours += h;
    const a = Math.ceil(hourly * h * d[2] - 1e-6) || 0;
    if (!Number.isFinite(a) || a > Number.MAX_SAFE_INTEGER) throw bad('ot.' + d[0]);
    lines.push({ n: d[1], amt: a, taxfree: false, hours: h, how: '통상시급 ' + hourly.toLocaleString('ko-KR') + '원 × ' + h + '시간 × ' + d[2], col: 'adj' });
  });
  if (otHours > 0 && !(hours > 0)) notes.push('월 소정근로시간이 비어 시간 수당을 계산하지 못함');
  extra.forEach(function (x, i) { lines.push({ n: String((x && x.n) || ''), amt: amt(x && x.amt, 'extra[' + i + ']'), taxfree: !!(x && x.taxfree), col: colOf(x) }); });
  // 66 판2 결근·조퇴 차감(시간) = 통상시급 × 시간(원 미만 올림)을 뺀다 · 직접 넣는 초과/차감 금액(정수, 음수 가능) — 둘 다 급여대장의 '초과/차감 수당' 칸
  const mh = hrs(inp.minus_hours, 'minus_hours');
  if (mh) { if (!(hours > 0)) throw bad('minus_hours'); const a = Math.ceil(hourly * mh - 1e-6) || 0; if (!Number.isFinite(a) || a > Number.MAX_SAFE_INTEGER) throw bad('minus_hours'); lines.push({ n: '결근·조퇴 차감', amt: -a, taxfree: false, hours: mh, how: '통상시급 ' + hourly.toLocaleString('ko-KR') + '원 × ' + mh + '시간', col: 'adj' }); }
  if (inp.adj_amt !== undefined && inp.adj_amt !== null) { if (!Number.isInteger(inp.adj_amt) || Math.abs(inp.adj_amt) > Number.MAX_SAFE_INTEGER) throw bad('adj_amt'); if (inp.adj_amt) lines.push({ n: '초과/차감(직접 넣음)', amt: inp.adj_amt, taxfree: false, col: 'adj' }); }
  const gross = lines.reduce(function (s, x) { return s + x.amt; }, 0);
  const taxable = lines.filter(function (x) { return !x.taxfree; }).reduce(function (s, x) { return s + x.amt; }, 0);
  const skip = inp.skip || {}, fd = inp.fixed_ded || {}, deds = [];
  const fx = { pension: opt(fd.pension, 'fixed_ded.pension'), health: opt(fd.health, 'fixed_ded.health'), care: opt(fd.care, 'fixed_ded.care'), emp: opt(fd.emp, 'fixed_ded.emp') };
  const pbIn = opt(inp.pension_base, 'pension_base'), hbIn = opt(inp.health_base, 'health_base');
  if (!skip.pension) {
    let a = fx.pension;
    if (a == null) {
      if (!pbIn) notes.push('국민연금: 기준소득월액 칸이 비어 그 달 과세 급여로 계산 — 공단 고지액과 다를 수 있음');
      // 기준소득월액 = 소득월액에서 천원 미만을 버린 금액(국민연금법 시행령 5조① — 단위는 근거 표 pension.base_unit)을 하한·상한 안으로
      a = floorTo(Math.min(Math.max(floorTo(pbIn || taxable, rates.pension.unit), rates.pension.min), rates.pension.max) * rates.pension.ee, rates.cut.pension);
    }
    deds.push({ n: '국민연금', amt: a });
  }
  if (!skip.health) {
    if (!hbIn && (fx.health == null || fx.care == null)) notes.push((fx.health == null ? '건강보험' : '장기요양보험') + ': 보수월액 칸이 비어 그 달 과세 급여로 계산 — 공단 고지액과 다를 수 있음');
    const prem = Math.min(Math.max((hbIn || taxable) * rates.health.rate, rates.health.prem_min), rates.health.prem_max);   // 회사 몫 포함 월 보험료(상·하한 안)
    deds.push({ n: '건강보험', amt: fx.health != null ? fx.health : floorTo(prem * rates.health.share, rates.cut.health) });
    deds.push({ n: '장기요양보험', amt: fx.care != null ? fx.care : floorTo(prem * (rates.care.rate / rates.health.rate) * rates.health.share, rates.cut.care) });   // 건강보험료 × (장기요양보험료율 ÷ 건강보험료율)
  }
  if (!skip.emp) deds.push({ n: '고용보험', amt: fx.emp != null ? fx.emp : floorTo(taxable * rates.emp.ee, cutEmp) });
  const it = simpTax(tax, taxable, inp.fam, inp.kids, inp.pct);
  deds.push({ n: '소득세', amt: it });
  deds.push({ n: '지방소득세', amt: floorTo(it * rates.local, rates.cut.local) });
  (Array.isArray(inp.ded) ? inp.ded : []).forEach(function (x, i) { deds.push({ n: String((x && x.n) || ''), amt: amt(x && x.amt, 'ded[' + i + ']') }); });
  const dsum = deds.reduce(function (s, x) { return s + x.amt; }, 0);
  if (dsum > gross) notes.push('공제 합계가 지급 합계보다 큼 — 세후가 0보다 작음(보험료 하한·그 달 공제 확인)');
  return { lines: lines, gross: gross, taxable: taxable, hourly: hourly, deds: deds, ded_total: dsum, net: gross - dsum, notes: notes };
}
module.exports = { simpTax: simpTax, calcMonth: calcMonth, floorTo: floorTo, CUT: CUT };
