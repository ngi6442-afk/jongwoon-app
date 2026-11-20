// 66 급여 판1(원장 C236) — 급여 계산 검산. 근거 표는 tools/pay_bg_fixture.json(자료 저장소 data/pay/bg_pay_v1.json 을 얼린 사본 — 가짜 사람·가짜 금액만 씀).
//   ① 근거 표 꼴·요율 고르기(귀속 달 · 세액표는 지급 달) ② 간이세액표 칸 되읽기·경계·초과 산식·자녀 공제·비율 ③ 한 달 손계산 대조 ④ 상·하한·제외·고지액 ⑤ 틀린 입력은 던짐 ⑥ 코드에 요율 숫자 없음 ⑦ 결함 사본
//   주의: ②의 칸 되읽기는 얼린 사본을 조회 함수로 다시 읽는 검사다(조회가 칸을 잘못 짚지 않는지) — 사본이 법령 원문과 같은지는 자료 저장소 초안 도구의 인용 대조와 독립 검토 몫.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'netlify', 'functions', '_lib');
const Module = require('module');
const SRC = { bg: readFileSync(join(LIB, 'paybg.js'), 'utf8'), calc: readFileSync(join(LIB, 'paycalc.js'), 'utf8') };
const load = (name, src) => { const f = join(LIB, name); const m = new Module(f); m.filename = f; m.paths = Module._nodeModulePaths(LIB); m._compile(src, f); return m.exports; };
const BG = JSON.parse(readFileSync(join(ROOT, 'tools', 'pay_bg_fixture.json'), 'utf8'));
let pass = 0, fail = 0;
const T = (name, ok, info) => { if (ok) pass++; else { fail++; console.log('  ✗ ' + name + (info ? ' — ' + info : '')); } };
const thr = (fn) => { try { fn(); return ''; } catch (e) { return e.code === 'PAY_BAD_INPUT' ? e.field : (e.code === 'PAY_BAD_RATES' ? 'rates:' + e.field : 'other:' + e.message); } };

function run(B, C) {
  const R = {};
  const clone = () => JSON.parse(JSON.stringify(BG));
  const mk = (f) => { const x = clone(); f(x); return x; };
  // ① 꼴·요율 고르기
  const r11 = B.ratesFor(BG, '2026-11'), r06 = B.ratesFor(BG, '2026-06'), r27 = B.ratesFor(BG, '2027-01');
  const BADS = [mk((x) => { x.rows.find((r) => r.id === 'pay.minwage').calc = true; }), mk((x) => { x.simptax.rows.splice(50, 1); }), mk((x) => { x.domain = 'hr'; }), null,
    mk((x) => { x.simptax.over = [{ gt: 10000, le: null, add: 0, base: 10000, k: 1, rate: 0.1 }]; }), mk((x) => { x.simptax.over[2].gt = 27000; }), mk((x) => { x.simptax.over[5].le = 99000; }),
    mk((x) => { x.simptax.top = x.simptax.top.map(String); }), mk((x) => { x.simptax.rows[300][4] = null; }), mk((x) => { x.rows.push(JSON.parse(JSON.stringify(x.rows[0]))); }),
    mk((x) => { x.simptax_meta.to = '2026-01'; }), mk((x) => { x.simptax.rows[10][3] = -1; }), mk((x) => { x.rows[0].key = '__proto__'; }), mk((x) => { x.rows[1].key = 'Pension.EE'; }), mk((x) => { x.rows[1].key = 'pension.ee.2026'; }), mk((x) => { x.rows[1].key = ' pension.ee'; }),
    mk((x) => { x.sha = 'zzzz000011112222'; }), mk((x) => { x.sha = 'ab'.repeat(32); }), mk((x) => { x.sha = 'ABCDEF0123456789'; }),
    mk((x) => { for (let i = 0; i < 480; i++) x.rows.push(Object.assign({}, x.rows[0], { id: 'pay.pad.' + i, key: 'pad.k' + (i % 9) + 'x', calc: false, grade: '실측' })); })];
  const pad = (n) => mk((x) => { for (let i = x.rows.length; i < n; i++) x.rows.push(Object.assign({}, x.rows[0], { id: 'pay.pad.' + i, key: 'pad.k' + (i % 9) + 'x', calc: false, grade: '실측' })); });
  R.shape = B.bgOk(BG) && BADS.every((x) => !B.bgOk(x)) && B.bgOk(pad(500)) && !B.bgOk(pad(501)) && B.ROWS_MAX === 500
    && JSON.stringify(B.bgSum(BG)) === JSON.stringify({ ver: BG.ver, sha: BG.sha, checked: '2026-11-20', n: 40, n_pending: 2, n_calc_false: 2, tax_from: '2026-03', tax_rows: 646, missing: [] });
  R.pick = r11.ok && JSON.stringify(r11.rates.cut) === '{"pension":10,"health":10,"care":10,"local":10,"emp":null}' && r11.used['cut.health'] === 'pay.cut.health' && r11.tax.cut === 10 && r11.used['cut.income'] === 'pay.cut.income' && !('cut.emp' in r11.used) && !('cut' in BG.simptax) && r11.rates.pension.unit === 1000 && r11.rates.pension.ee === 475 / 10000 && r11.rates.pension.min === 410000 && r11.rates.pension.max === 6590000 && r11.used['pension.ee'] === 'pay.pension.ee.2026'
    && r06.ok && r06.rates.pension.min === 400000 && r06.rates.pension.max === 6370000
    && r27.ok && r27.rates.pension.ee === 500 / 10000 && r27.used['pension.ee'] === 'pay.pension.ee.2027' && B.ratesFor(BG, '2026-12').rates.pension.ee === 475 / 10000
    && r11.rates.health.rate === 719 / 10000 && r11.rates.health.share === 0.5 && r11.rates.care.rate === 9448 / 1000000 && r11.rates.emp.ee === 18 / 1000 / 2 && r11.rates.local === 0.1
    && r11.rates.ot.ext === 0.5 && r11.rates.ot.hol8 === 1 && r11.ver === BG.ver && r11.sha === BG.sha && r11.pay_ym === '2026-11';
  const dup = mk((x) => { x.rows.push(Object.assign({}, x.rows.find((r) => r.id === 'pay.health.rate'), { id: 'pay.health.rate.x' })); });
  const n1 = B.ratesFor(BG, '2026-02'), n2 = B.ratesFor(BG, '2027-07'), n3 = B.ratesFor(BG, '2025-12'), n4 = B.ratesFor(BG, '2026-13'), n5 = B.ratesFor(dup, '2026-11');
  R.refuse = !n1.ok && n1.why === 'NO_TAX_TABLE' && !n2.ok && n2.why === 'NO_RATE' && n2.keys.join() === 'pension.base_min,pension.base_max' && !n3.ok && n3.why === 'NO_RATE' && n3.keys.length === 19
    && !n4.ok && n4.why === 'BAD_YM' && !n5.ok && n5.why === 'RATE_OVERLAP' && n5.keys.join() === 'health.rate';
  // 세액표는 지급하는 달 기준: 2월 귀속분을 3월에 지급하면 새 표 · 지급 달이 귀속 달보다 앞서면 거절
  const p1 = B.ratesFor(BG, '2026-02', '2026-03'), p2 = B.ratesFor(BG, '2026-03', '2026-02'), p3 = B.ratesFor(BG, '2026-11', '2026-12'), p4 = B.ratesFor(BG, '2026-11', 'x');
  R.payym = p1.ok && p1.ym === '2026-02' && p1.pay_ym === '2026-03' && p1.rates.pension.ee === 475 / 10000 && !p2.ok && p2.why === 'BAD_PAY_YM' && p3.ok && p3.pay_ym === '2026-12' && p3.rates.pension.ee === 475 / 10000 && !p4.ok && p4.why === 'BAD_PAY_YM'
    && BG.simptax_meta.basis === 'pay';
  // 확인 필요 행(calc false)은 그 달을 덮어도 요율로 뽑히지 않는다
  const pend = mk((x) => { const h = x.rows.find((r) => r.id === 'pay.health.rate'); h.grade = '확인 필요'; h.calc = false; h.why = '시험'; });
  const n6 = B.ratesFor(pend, '2026-11');
  R.pending = B.bgOk(pend) && !n6.ok && n6.why === 'NO_RATE' && n6.keys.join() === 'health.rate';
  // 표의 키 이름이 객체 내장 이름이어도 요율 고르기가 던지지 않는다(꼴 검사를 거치지 않은 표가 넘어와도)
  const odd = mk((x) => { x.rows.push(Object.assign({}, x.rows[0], { id: 'pay.odd', key: '__proto__' })); x.rows.push(Object.assign({}, x.rows[0], { id: 'pay.odd2', key: 'constructor' })); });
  let oddOk = false; try { oddOk = B.ratesFor(odd, '2026-11').ok === true; } catch (e) { oddOk = false; }
  R.pending = R.pending && oddOk;
  const z0 = B.ratesFor(mk((x) => { x.rows.find((r) => r.id === 'pay.pension.unit').n = 0; }), '2026-11'), z1 = B.ratesFor(mk((x) => { x.rows.find((r) => r.id === 'pay.emp.ui').n = 0; }), '2026-11');
  R.pending = R.pending && !z0.ok && z0.why === 'BAD_RATE' && z0.keys.join() === 'pension.base_unit' && !z1.ok && z1.keys.join() === 'emp.ui_rate';
  // 꼭 읽는 키가 빠진 표(옛 꼴): 꼴 검사는 지나지만 요약의 missing 에 드러나고 어느 달도 계산하지 않음
  const old = mk((x) => { x.rows = x.rows.filter((r) => r.key !== 'cut.pension' && r.key !== 'pension.base_unit'); });
  const hid = mk((x) => { const r = x.rows.find((q) => q.id === 'pay.cut.care'); r.grade = '확인 필요'; r.calc = false; r.why = '시험'; });
  R.miss = B.bgOk(old) && B.bgSum(old).missing.join() === 'pension.base_unit,cut.pension' && B.missing(BG).length === 0 && B.ratesFor(old, '2026-11').why === 'NO_RATE' && B.bgSum(hid).missing.join() === 'cut.care';
  // 끝수 단위는 키마다 제 행에서: 표 값을 서로 다르게 바꾼 사본으로 배선을 고정 · 고용보험(없어도 되는 키)은 계산에 쓰는 행이 생기면 그 값, 두 행이면 계산 거부
  const setN = (x, id, n) => { x.rows.find((r) => r.id === id).n = n; };
  const dif = B.ratesFor(mk((x) => { setN(x, 'pay.cut.pension', 20); setN(x, 'pay.cut.health', 30); setN(x, 'pay.cut.care', 40); setN(x, 'pay.cut.local', 50); setN(x, 'pay.cut.income', 60); }), '2026-11');
  const empOn = (x) => { const r = x.rows.find((q) => q.id === 'pay.cut.emp'); r.grade = '실측'; r.calc = true; r.n = 70; delete r.why; };
  const e1 = B.ratesFor(mk(empOn), '2026-11'), e2 = B.ratesFor(mk((x) => { empOn(x); x.rows.push(Object.assign({}, x.rows.find((q) => q.id === 'pay.cut.emp'), { id: 'pay.cut.emp.x' })); }), '2026-11');
  R.wire = dif.ok && JSON.stringify(dif.rates.cut) === '{"pension":20,"health":30,"care":40,"local":50,"emp":null}' && dif.tax.cut === 60 && e1.ok && e1.rates.cut.emp === 70 && e1.used['cut.emp'] === 'pay.cut.emp' && !e2.ok && e2.why === 'RATE_OVERLAP' && e2.keys.join() === 'cut.emp';
  if (!r11.ok) return R;
  const tax = r11.tax, rates = r11.rates;
  // ② 간이세액표
  let cells = 0, cellBad = 0;
  tax.rows.forEach((r) => { for (let f = 1; f <= 11; f++) { cells += 2; if (C.simpTax(tax, r[0] * 1000, f, 0, 100) !== r[1 + f]) cellBad++; if (C.simpTax(tax, r[1] * 1000 - 1, f, 0, 100) !== r[1 + f]) cellBad++; } });
  R.cells = cells === 646 * 22 && cellBad === 0;
  const st = (a, f, k, p) => C.simpTax(tax, a, f, k, p);
  R.edge = st(769999, 1, 0, 100) === 0 && st(0, 1) === 0 && st(10000000, 1, 0, 100) === tax.top[0] && st(3000000, 1, 0, 100) === 74350 && st(5000000, 3, 0, 100) === 237850 && st(3000000) === 74350;
  R.over = st(12000000, 1, 0, 100) === tax.top[0] + 25000 + 686000 && st(14000000, 2, 0, 100) === tax.top[1] + 25000 + 1372000 && st(20000000, 1, 0, 100) === tax.top[0] + 1397000 + 2234400
    && st(40000000, 1, 0, 100) === tax.top[0] + 7394600 + 4000000 && [14000000, 28000000, 30000000, 45000000, 87000000].every((x) => Math.abs(st(x + 1, 1, 0, 100) - st(x, 1, 0, 100)) <= 10);
  R.kids = st(5000000, 3, 1, 100) === 237850 - 20830 && st(5000000, 4, 2, 100) === 219100 - 45830 && st(5000000, 5, 3, 100) === 200350 - 45830 - 33330 && st(3000000, 4, 2, 100) === 0
    && st(3000000, 1, 0, 80) === 59480 && st(3000000, 1, 0, 120) === 89220 && st(5000000, 13, 0, 100) === 87850 - (106600 - 87850) * 2;
  // ③ 한 달 손계산(가짜 사람): 기본급 300만 · 식대 20만(비과세·통상임금에 넣기로 표시) · 209시간 · 연장 10시간 · 가족 1
  //   통상시급 = 3,200,000 ÷ 209 = 15,311.004… → 원 미만 올림 15,312 · 연장 = 15,312 × 10 × 1.5 = 229,680
  const m = C.calcMonth(rates, tax, { base: 3000000, hours: 209, fixed: [{ n: '식대', amt: 200000, taxfree: true, ord: true }], ot: { ext: 10 }, fam: 1, kids: 0, pct: 100, pension_base: 3000000, health_base: 3000000 });
  const d = {}; m.deds.forEach((x) => { d[x.n] = x.amt; });
  const row = tax.rows.find((x) => x[0] <= 3229.68 && 3229.68 < x[1]);
  R.month = m.hourly === 15312 && m.lines[2].amt === 229680 && m.lines[2].hours === 10 && m.lines[2].how === '통상시급 15,312원 × 10시간 × 1.5' && m.gross === 3429680 && m.taxable === 3229680
    && d['국민연금'] === 142500 && d['건강보험'] === 107850 && d['장기요양보험'] === 14170 && d['고용보험'] === 29060 && d['소득세'] === row[2] && d['지방소득세'] === Math.floor(row[2] * 0.1 / 10) * 10
    && m.ded_total === Object.values(d).reduce((s, x) => s + x, 0) && m.net === m.gross - m.ded_total && m.notes.length === 0;
  // 가산율: 야간은 가산분만(0.5) · 휴일 1.5 · 휴일 8시간 초과 2.0
  const o = C.calcMonth(rates, tax, { base: 2090000, hours: 209, ot: { night: 4, hol: 8, hol8: 2 }, fam: 1, pension_base: 2090000, health_base: 2090000 });
  R.ot = o.hourly === 10000 && o.lines[1].amt === 20000 && o.lines[2].amt === 120000 && o.lines[3].amt === 40000;
  // 계산식 글과 금액이 같은 시급을 쓴다 · 금액은 통상임금 ÷ 시간 × 가산율 이상(올림)
  const f7 = C.calcMonth(rates, tax, { base: 2090100, hours: 209, ot: { ext: 7 }, fam: 1, pension_base: 2090100, health_base: 2090100 });
  R.how = f7.hourly === 10001 && f7.lines[1].how === '통상시급 10,001원 × 7시간 × 1.5' && f7.lines[1].amt === 105011 && f7.lines[1].amt >= 2090100 / 209 * 7 * 1.5;
  // 소수 시간은 반올림하지 않는다(주 35시간 = 182.5시간): 통상시급 = ceil(2,000,000 ÷ 182.5) = 10,959 · 연장 10시간 = 164,385 ≥ 2,000,000 ÷ 182.5 × 10 × 1.5
  const h1 = C.calcMonth(rates, tax, { base: 2000000, hours: 182.5, ot: { ext: 10 }, fam: 1, pension_base: 2000000, health_base: 2000000 });
  const h2 = C.calcMonth(rates, tax, { base: 2000000, hours: 209.4, ot: { ext: 2.5 }, fam: 1, pension_base: 2000000, health_base: 2000000 });
  const h3 = C.calcMonth(rates, tax, { base: 2000000, hours: 0.4, ot: { ext: 1 }, fam: 1, pension_base: 2000000, health_base: 2000000 });
  R.hours = h1.hourly === 10959 && h1.lines[1].amt === 164385 && h1.lines[1].amt >= 2000000 / 182.5 * 10 * 1.5 && h2.hourly === Math.ceil(2000000 / 209.4) && h2.lines[1].hours === 2.5 && h2.lines[1].amt >= 2000000 / 209.4 * 2.5 * 1.5 && h3.notes.length === 0 && h3.hourly === 5000000;
  // 국민연금: 소득월액에서 천원 미만을 버린 뒤 요율(2,000,999 → 2,000,000 × 475/10000 = 95,000) — 기준소득월액 칸이 비어 과세 급여로 셀 때도 같음
  const pd = (inp) => C.calcMonth(rates, tax, Object.assign({ hours: 209, fam: 1, health_base: 2000000 }, inp)).deds[0].amt;
  R.punit = pd({ base: 2000999, pension_base: 2000999 }) === 95000 && pd({ base: 2000999 }) === 95000 && pd({ base: 2000000, pension_base: 2000000 }) === 95000 && pd({ base: 300000, pension_base: 409999 }) === Math.floor(410000 * 0.0475 / 10) * 10 && pd({ base: 9000000, pension_base: 6590999 }) === Math.floor(6590000 * 0.0475 / 10) * 10;
  // 끝수 단위(근거 표 cut.*) — 끝수가 실제로 남는 표본: 기본급 3,001,234 · 기준소득월액·보수월액 2,222,222
  //   국민연금 2,222,000 × 475/10000 = 105,545 → 105,540 · 건강보험 2,222,222 × 719/10000 ÷ 2 = 79,888.8… → 79,880 · 장기요양 2,222,222 × 9448/1000000 ÷ 2 = 10,497.7… → 10,490
  //   고용보험 3,001,234 × 0.009 = 27,011.1… → 27,010(조문 미확인 — 기본값) · 소득세 74,350(3,000~3,020천원 칸) → 지방소득세 7,435 → 7,430. 단위를 1로 바꾼 요율로는 끝수가 그대로 남아야 한다
  const CIN = { base: 3001234, hours: 209, fam: 1, pension_base: 2222222, health_base: 2222222 };
  const cu = C.calcMonth(rates, tax, CIN), dc = {}; cu.deds.forEach((x) => { dc[x.n] = x.amt; });
  const r1 = JSON.parse(JSON.stringify(rates)); r1.cut = { pension: 1, health: 1, care: 1, local: 1, emp: 1 };
  const c1 = C.calcMonth(r1, tax, CIN), d1 = {}; c1.deds.forEach((x) => { d1[x.n] = x.amt; });
  R.cut = dc['국민연금'] === 105540 && dc['건강보험'] === 79880 && dc['장기요양보험'] === 10490 && dc['고용보험'] === 27010 && dc['소득세'] === 74350 && dc['지방소득세'] === 7430
    && d1['국민연금'] === 105545 && d1['건강보험'] === 79888 && d1['장기요양보험'] === 10497 && d1['고용보험'] === 27011 && d1['지방소득세'] === 7435;
  const r2u = JSON.parse(JSON.stringify(rates)); r2u.pension.unit = 10000;   // 단위를 만원으로 바꾼 요율: 2,009,999 → 2,000,000 → 95,000
  R.punit = R.punit && C.calcMonth(r2u, tax, { base: 2009999, hours: 209, fam: 1, health_base: 2000000, pension_base: 2009999 }).deds[0].amt === 95000 && C.calcMonth(rates, tax, { base: 2009999, hours: 209, fam: 1, health_base: 2000000, pension_base: 2009999 }).deds[0].amt === 95420;
  // 이상값: 통상임금 0 이어도 '-0' 이 글·금액에 찍히지 않음 · 0에 아주 가까운 시간 = hours 로 던짐 · 끝없는 시간 수 = 그 칸으로 던짐 · 공제 > 지급 = 안내
  const z = C.calcMonth(rates, tax, { base: 0, hours: 209, ot: { ext: 1 }, fam: 1 }), zh = C.calcMonth(rates, tax, { base: 2000000, hours: 0, ot: { ext: 1 }, fam: 1, pension_base: 2000000, health_base: 2000000 });
  R.odd = Object.is(z.hourly, 0) && Object.is(z.lines[1].amt, 0) && z.lines[1].how === '통상시급 0원 × 1시간 × 1.5' && z.net < 0 && z.notes.some((n) => /^공제 합계가 지급 합계보다 큼/.test(n)) && Object.is(zh.lines[1].amt, 0)
    && thr(() => C.calcMonth(rates, tax, { base: 2000000, hours: 5e-324, fam: 1 })) === 'hours' && thr(() => C.calcMonth(rates, tax, { base: 2000000, hours: 5e-324, ot: { ext: 1 }, fam: 1 })) === 'hours'
    && thr(() => C.calcMonth(rates, tax, { base: 2000000, hours: 209, ot: { ext: 1e306 }, fam: 1 })) === 'ot.ext' && !C.calcMonth(rates, tax, { base: 3000000, hours: 209, fam: 1, pension_base: 3000000, health_base: 3000000 }).notes.length;
  // 보험별로 제 단위만 읽는지: 한 키씩만 1로 바꾼 요율 5벌 — 그 줄만 끝수가 남고 나머지는 10원 미만 버림 그대로
  const W10 = { pension: ['국민연금', 105540, 105545], health: ['건강보험', 79880, 79888], care: ['장기요양보험', 10490, 10497], emp: ['고용보험', 27010, 27011], local: ['지방소득세', 7430, 7435] };
  R.cut = R.cut && Object.keys(W10).every((k) => { const rk = JSON.parse(JSON.stringify(rates)); rk.cut[k] = 1; const dk = {}; C.calcMonth(rk, tax, CIN).deds.forEach((x) => { dk[x.n] = x.amt; }); return Object.keys(W10).every((j) => dk[W10[j][0]] === W10[j][j === k ? 2 : 1]); });
  // 소득세 끝수(근거 표 cut.income → 세액표 cut): 2,000,000원·1명 = 19,520 → 80% 15,616 → 15,610 · 120% 23,424 → 23,420 · 단위를 1로 바꾼 표로는 끝수가 남음
  const tax1 = Object.assign({}, tax, { cut: 1 });
  R.tcut = st(2000000, 1, 0, 100) === 19520 && st(2000000, 1, 0, 80) === 15610 && st(2000000, 1, 0, 120) === 23420 && C.simpTax(tax1, 2000000, 1, 0, 80) === 15616 && C.simpTax(tax1, 2000000, 1, 0, 120) === 23424;
  // 요율 꼴: 끝수 단위·기준소득월액 단위가 빠진 요율은 다른 단위로 조용히 계산하지 않고 던짐(PAY_BAD_RATES: 칸 이름) · 고용보험만 빈 값이면 기본값
  const rr = (f) => { const x = JSON.parse(JSON.stringify(rates)); f(x); return x; }, NORM = { base: 3000000, hours: 209, fam: 1, pension_base: 3000000, health_base: 3000000 };
  const noCutTax = Object.assign({}, tax); delete noCutTax.cut;
  R.rshape = thr(() => C.calcMonth(rr((x) => { delete x.cut; }), tax, NORM)) === 'rates:cut.pension' && thr(() => C.calcMonth(rr((x) => { x.cut.health = 0; }), tax, NORM)) === 'rates:cut.health' && thr(() => C.calcMonth(rr((x) => { x.cut.care = 2.5; }), tax, NORM)) === 'rates:cut.care'
    && thr(() => C.calcMonth(rr((x) => { delete x.cut.local; }), tax, NORM)) === 'rates:cut.local' && thr(() => C.calcMonth(rr((x) => { delete x.pension.unit; }), tax, NORM)) === 'rates:pension.unit' && thr(() => C.calcMonth(rr((x) => { x.cut.emp = 0; }), tax, NORM)) === 'rates:cut.emp'
    && thr(() => C.calcMonth(rr((x) => { delete x.cut.emp; }), tax, NORM)) === '' && thr(() => C.calcMonth(rates, noCutTax, NORM)) === 'rates:tax.cut' && thr(() => C.simpTax(noCutTax, 3000000, 1, 0, 100)) === 'rates:tax.cut' && thr(() => C.floorTo(100, 0)) === 'rates:unit' && C.floorTo(1239, 10) === 1230;
  // 금액 상한·-0: 안전한 정수 범위를 넘는 금액·수당은 칸 이름으로 던짐 · -0 은 0 으로
  R.bound = thr(() => C.calcMonth(rates, tax, Object.assign({}, NORM, { base: 2 ** 53 + 2 }))) === 'base' && thr(() => C.calcMonth(rates, tax, Object.assign({}, NORM, { ot: { ext: 1e300 } }))) === 'ot.ext' && Object.is(C.calcMonth(rates, tax, Object.assign({}, NORM, { extra: [{ n: '가', amt: -0 }] })).lines[1].amt, 0);
  // ④ 상·하한 · 제외 · 고지액 · 빈 칸 안내
  const hi = C.calcMonth(rates, tax, { base: 9000000, hours: 209, fam: 1, pension_base: 9000000, health_base: 200000000 }), dh = {}; hi.deds.forEach((x) => { dh[x.n] = x.amt; });
  const lo = C.calcMonth(rates, tax, { base: 300000, hours: 60, fam: 1, pension_base: 300000, health_base: 100000 }), dl = {}; lo.deds.forEach((x) => { dl[x.n] = x.amt; });
  R.caps = dh['국민연금'] === Math.floor(6590000 * 0.0475 / 10) * 10 && dh['건강보험'] === Math.floor(9183480 / 2 / 10) * 10 && dl['국민연금'] === Math.floor(410000 * 0.0475 / 10) * 10 && dl['건강보험'] === 10080;
  const sk = C.calcMonth(rates, tax, { base: 3000000, hours: 209, fam: 1, skip: { pension: true, emp: true }, health_base: 3000000 });
  const fx = C.calcMonth(rates, tax, { base: 3000000, hours: 209, fam: 1, fixed_ded: { pension: 111110, health: 99990, care: 12340, emp: 5 } }), df = {}; fx.deds.forEach((x) => { df[x.n] = x.amt; });
  const em = C.calcMonth(rates, tax, { base: 2500000, hours: 209, fam: 1 }), noH = C.calcMonth(rates, tax, { base: 2500000, hours: 0, ot: { ext: 3 }, fam: 1, pension_base: 2500000, health_base: 2500000 });
  // 건강보험 고지액만 있고 장기요양 고지액·보수월액이 없으면 장기요양이 추정이라는 안내가 붙는다
  const hOnly = C.calcMonth(rates, tax, { base: 3000000, hours: 209, fam: 1, pension_base: 3000000, fixed_ded: { health: 50000 } });
  R.opts = sk.deds.map((x) => x.n).join() === '건강보험,장기요양보험,소득세,지방소득세' && df['국민연금'] === 111110 && df['건강보험'] === 99990 && df['장기요양보험'] === 12340 && df['고용보험'] === 5 && fx.notes.length === 0
    && em.notes.length === 2 && /^국민연금: 기준소득월액 칸이 비어/.test(em.notes[0]) && /^건강보험: 보수월액 칸이 비어.*공단 고지액과 다를 수 있음$/.test(em.notes[1]) && noH.notes.length === 1 && /월 소정근로시간이 비어/.test(noH.notes[0]) && noH.lines[1].amt === 0
    && hOnly.deds[1].amt === 50000 && hOnly.notes.length === 1 && /^장기요양보험: 보수월액 칸이 비어/.test(hOnly.notes[0]);
  // 그 달 수당·공제 줄과 합계
  const ex = C.calcMonth(rates, tax, { base: 2000000, hours: 209, fam: 2, extra: [{ n: '상여', amt: 500000 }, { n: '보육수당', amt: 200000, taxfree: true }], ded: [{ n: '건강보험 정산', amt: 12340 }], pension_base: 2000000, health_base: 2000000 });
  R.extra = ex.gross === 2700000 && ex.taxable === 2500000 && ex.deds[ex.deds.length - 1].amt === 12340 && ex.net === ex.gross - ex.ded_total && ex.lines.length === 3;
  // ⑤ 틀린 입력은 0으로 바꾸지 않고 던진다(칸 이름)
  const cm = (inp) => thr(() => C.calcMonth(rates, tax, Object.assign({ base: 3000000, hours: 209, fam: 1, pension_base: 3000000, health_base: 3000000 }, inp)));
  R.strict = thr(() => st(NaN, 1, 0, 100)) === 'taxable' && thr(() => st(undefined, 1, 0, 100)) === 'taxable' && thr(() => st(-1, 1, 0, 100)) === 'taxable' && thr(() => st('3000000', 1, 0, 100)) === 'taxable'
    && thr(() => st(3000000, 1, 0, 90)) === 'pct' && thr(() => st(3000000, 1, 0, '80')) === 'pct' && thr(() => st(3000000, 0, 0, 100)) === 'fam' && thr(() => st(3000000, 1.5, 0, 100)) === 'fam'
    && thr(() => st(3000000, 1, 1, 100)) === 'kids' && thr(() => st(3000000, 3, 3, 100)) === 'kids' && thr(() => st(3000000, 3, 2, 100)) === ''
    && cm({ base: '3000000' }) === 'base' && cm({ base: undefined }) === 'base' && cm({ extra: [{ n: '결근 공제', amt: -100000 }] }) === 'extra[0]' && cm({ fixed: [{ n: '식대', amt: '200000' }] }) === 'fixed[0]'
    && cm({ fixed_ded: { pension: '111110' } }) === 'fixed_ded.pension' && cm({ ded: [{ n: 'x', amt: NaN }] }) === 'ded[0]' && cm({ ot: { ext: -1 } }) === 'ot.ext' && cm({ ot: { ext: '3' } }) === 'ot.ext'
    && cm({ pension_base: '3000000' }) === 'pension_base' && cm({ pct: '80' }) === 'pct' && cm({ hours: '209' }) === 'hours' && cm({ hours: -1 }) === 'hours' && cm({ hours: NaN }) === 'hours' && cm({ ot: { night: Infinity } }) === 'ot.night' && cm({}) === '';
  const brk = mk((x) => { x.simptax.rows[448][2] = undefined; });
  R.strict = R.strict && /SIMPTAX_BAD_TABLE/.test(thr(() => C.simpTax(brk.simptax, brk.simptax.rows[448][0] * 1000, 1, 0, 100)));
  return R;
}
const B0 = require(join(LIB, 'paybg.js')), C0 = require(join(LIB, 'paycalc.js'));
const R0 = run(B0, C0);
T('66 판1 ① 근거 표 꼴: 확인 필요 행이 계산에 쓰임 · 세액표 구간 끊김 · 다른 영역 표 · 초과 산식 줄이 모자람·구간이 안 이어짐·끝이 안 열림 · 세액 칸이 글자·빈 값·음수 · 행 id 중복 · 세액표 끝 달이 시작 달보다 앞 = 거절 · 요약(행 40 · 확인 필요 2 · 세액표 646구간 · 2026-03부터) · 지문 꼴(16진 8~60자) · 키 이름 꼴(앞뒤 고정) · 행 수 상한(500 통과 · 501 거절)', R0.shape, '');
T('66 판1 ① 귀속 달 요율: 2026-11·2026-12 = 연금 1만분의 475·기준소득월액 41만~659만 · 2026-06 = 40만~637만 · 2027-01 = 1만분의 500 · 건강 1만분의 719 반씩 · 장기요양 100만분의 9,448 · 고용 1천분의 18의 반 · 지방소득세 10% · 쓴 행 id·판 지문 동봉', R0.pick, '');
T('66 판1 ① 계산 거부: 세액표 시행 전 달 NO_TAX_TABLE · 고시가 아직 없는 달 NO_RATE(빠진 키) · 표 앞 달 NO_RATE · 달 꼴 BAD_YM · 같은 달을 두 행이 덮음 RATE_OVERLAP · 확인 필요 행은 요율로 안 뽑힘 · 세액표는 지급하는 달 기준(2월 귀속·3월 지급 = 새 표 · 보험 요율은 귀속 달 그대로 · 지급 달이 귀속 달보다 앞·꼴 틀림 BAD_PAY_YM) · 꼭 읽는 키가 빠진 표는 요약 missing 에 드러남 · 끝수 단위는 키마다 제 행 · 없어도 되는 키(고용보험 끝수)는 한 행이면 그 값·두 행이면 거부', R0.refuse && R0.pending && R0.payym && R0.miss && R0.wire, JSON.stringify({ refuse: R0.refuse, pending: R0.pending, payym: R0.payym, miss: R0.miss, wire: R0.wire }));
T('66 판1 ② 간이세액표 칸(646구간 × 11열 × 구간 양 끝) 되읽기 — 조회가 구간·열을 잘못 짚지 않음', R0.cells, '');
T('66 판1 ② 경계(77만 원 미만 0 · 1,000만 원 칸 · 표본 칸 · 가족·자녀·비율 빈 값 = 1명·0명·100%) · 1,000만 원 초과 산식 손계산·구간 이음새 · 자녀 공제 1·2·3명·음수면 0 · 80·120% · 가족 13명', R0.edge && R0.over && R0.kids, JSON.stringify({ edge: R0.edge, over: R0.over, kids: R0.kids }));
T('66 판1 ③ 한 달 손계산: 통상시급 원 미만 올림 · 연장수당 = 통상시급 × 시간 × 1.5(계산식 글과 금액이 같은 시급 · 금액은 올림) · 4대보험 4줄 · 장기요양 = 건강보험료 × 요율 비율 · 소득세 = 세액표 칸 · 지방소득세 10% · 세후 = 지급 − 공제 · 야간 0.5·휴일 1.5·휴일 8시간 초과 2.0 · 소수 시간은 반올림하지 않음(182.5시간 — 가산이 법정 이상) · 국민연금은 소득월액 천원 미만을 버린 뒤 요율 · 끝수 단위는 근거 표 cut.* 에서(고용보험만 기본값) · 통상임금 0 에서 -0 안 찍힘 · 끝없는 시급·수당은 칸 이름으로 던짐 · 공제 > 지급 안내 · 소득세 끝수도 표(80·120% 뒤 끝수 표본) · 보험별 끝수 배선 · 단위가 빠진 요율은 던짐 · 금액 상한', R0.month && R0.ot && R0.how && R0.hours && R0.punit && R0.cut && R0.odd && R0.tcut && R0.rshape && R0.bound, JSON.stringify({ month: R0.month, ot: R0.ot, how: R0.how, hours: R0.hours, punit: R0.punit, cut: R0.cut, odd: R0.odd, tcut: R0.tcut, rshape: R0.rshape, bound: R0.bound }));
T('66 판1 ④ 기준소득월액 상·하한 · 건강보험료 상·하한(반) · 가입 제외 표시 · 공단 고지액 우선 · 빈 칸 안내 2줄 · 건강보험 고지액만 있으면 장기요양 추정 안내 · 소정근로시간 없으면 시간 수당 0 + 안내 · 그 달 수당(비과세)·공제 줄', R0.caps && R0.opts && R0.extra, JSON.stringify({ caps: R0.caps, opts: R0.opts, extra: R0.extra }));
T('66 판1 ⑤ 틀린 입력은 던짐(0으로 바꾸지 않음): 과세 급여 NaN·빈 값·음수·글자 · 비율 90·글자 · 가족 0·소수 · 자녀가 본인 뺀 가족 수 초과 · 기본급 글자·빈 값 · 음수 수당 · 글자 수당·고지액·기준소득월액·시간 · NaN 공제 · 음수·글자 연장 시간 · 세액 칸이 빈 표 = SIMPTAX_BAD_TABLE', R0.strict, '');
// ⑥ 코드에 요율 숫자 없음 — 계산 파일 두 개에서 주석·글자열을 걷어 낸 뒤 남는 숫자는 끝수 단위·천원 환산·열 수·비율 선택지·정규식 길이뿐이어야 한다
const bare = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/'[^'\n]*'/g, "''");
const BGN = SRC.bg.replace('const ROWS_MAX = 500;', '').replace("const SHA = /^[0-9a-f]{8,60}$/;", '');   // 상한·지문 꼴 두 상수 줄만 걷고 셈(그 밖의 500·60 은 걸림)
const nums = (s) => (bare(s).match(/\b\d+(?:\.\d+)?(?:e-?\d+)?\b/g) || []).filter((x) => !['0', '1', '2', '3', '4', '8', '9', '10', '11', '13', '20', '40', '80', '100', '120', '1000', '10000', '1e-6', '1e-9'].includes(x));
T('66 판1 ⑥ 계산 파일에 요율 숫자 없음(값은 근거 표에서만) · 두 파일은 저장소·시각·다른 모듈을 부르지 않음', nums(SRC.calc).length === 0 && nums(BGN).length === 0 && SRC.bg.split('const ROWS_MAX = 500;').length === 2 && !/require\(|Date\.|process\.env|getStore/.test(bare(SRC.calc) + bare(SRC.bg)), JSON.stringify({ calc: nums(SRC.calc), bg: nums(BGN) }));
// ⑦ 결함 사본 — 한 곳을 바꾼 사본에서는 위 검사 가운데 하나가 깨져야 한다
const MUT = [
  ['calc', '    if (fam <= 11) return arr[off + fam - 1];', '    if (fam <= 11) return arr[off + fam];'],
  ['calc', '  if (k < tax.below) t = 0;', '  if (false) t = 0;'],
  ['calc', '      t = t + o.add + (taxable - o.base * 1000) * o.k * o.rate;', '      t = t + o.add + (taxable - o.base * 1000) * o.rate;'],
  ['calc', '  if (t < 0) t = 0;\n', ''],
  ['calc', "  if (pct !== 80 && pct !== 100 && pct !== 120) throw bad('pct');\n", ''],
  ['calc', "  if (!Number.isInteger(kids) || kids < 0 || kids > fam - 1) throw bad('kids');", "  if (!Number.isInteger(kids) || kids < 0) throw bad('kids');"],
  ['calc', "  if (!Number.isFinite(t)) throw new Error('SIMPTAX_BAD_TABLE');\n", ''],
  ['calc', "function amt(v, what) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw bad(what); return Math.round(v) || 0; }", 'function amt(v, what) { v = Number(v); return v > 0 ? Math.round(v) : 0; }'],
  ['calc', "function amt(v, what) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw bad(what);", "function amt(v, what) { v = Number(v); if (!Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw bad(what);"],
  ['calc', ' || v > Number.MAX_SAFE_INTEGER) throw bad(what); return Math.round(v) || 0; }', ') throw bad(what); return Math.round(v) || 0; }'],
  ['calc', 'throw bad(what); return Math.round(v) || 0; }', 'throw bad(what); return Math.round(v); }'],
  ['calc', "function floorTo(v, unit) { if (!(Number.isInteger(unit) && unit > 0)) throw badRates('unit'); return", 'function floorTo(v, unit) { unit = unit > 0 ? unit : 1; return'],
  ['calc', "forEach(function (p) { if (!(Number.isInteger(p[1]) && p[1] > 0)) throw badRates(p[0]); });", 'forEach(function (p) {});'],
  ['calc', "  if (!(Number.isInteger(cutEmp) && cutEmp > 0)) throw badRates('cut.emp');", ''],
  ['calc', "  if (!(Number.isInteger(tax.cut) && tax.cut > 0)) throw badRates('tax.cut');", ''],
  ['calc', '  return floorTo(t * pct / 100, tax.cut);', '  return floorTo(t * pct / 100, 10);'],
  ['calc', "    const h = hrs(ot[d[0]], 'ot.' + d[0]);\n", '    const h = Number(ot[d[0]]) > 0 ? Number(ot[d[0]]) : 0;\n'],
  ['calc', "const base = amt(inp.base, 'base'), hours = hrs(inp.hours, 'hours');", "const base = amt(inp.base, 'base'), hours = opt(inp.hours, 'hours') || 0;"],
  ['calc', 'Math.min(Math.max(floorTo(pbIn || taxable, rates.pension.unit), rates.pension.min), rates.pension.max)', 'Math.min(Math.max(pbIn || taxable, rates.pension.min), rates.pension.max)'],
  ['calc', "['night', '야간근로 가산', rates.ot.night]", "['night', '야간근로 가산', 1 + rates.ot.night]"],
  ['calc', 'const hourly = hours > 0 ? (Math.ceil(ord / hours - 1e-9) || 0) : 0;', 'const hourly = hours > 0 ? ord / hours : 0;'],
  ['calc', 'const hourly = hours > 0 ? (Math.ceil(ord / hours - 1e-9) || 0) : 0;', 'const hourly = hours > 0 ? (Math.floor(ord / hours) || 0) : 0;'],
  ['calc', 'const hourly = hours > 0 ? (Math.ceil(ord / hours - 1e-9) || 0) : 0;', 'const hourly = hours > 0 ? Math.ceil(ord / hours - 1e-9) : 0;'],
  ['calc', "  if (!Number.isFinite(hourly)) throw bad('hours');", ''],
  ['calc', 'const a = Math.ceil(hourly * h * d[2] - 1e-6) || 0;', 'const a = Math.floor(hourly * h * d[2]) || 0;'],
  ['calc', 'const a = Math.ceil(hourly * h * d[2] - 1e-6) || 0;', 'const a = Math.ceil(hourly * h * d[2] - 1e-6);'],
  ['calc', "    if (!Number.isFinite(a) || a > Number.MAX_SAFE_INTEGER) throw bad('ot.' + d[0]);\n", ''],
  ['calc', "if (!Number.isFinite(a) || a > Number.MAX_SAFE_INTEGER) throw bad('ot.' + d[0]);", "if (!Number.isFinite(a)) throw bad('ot.' + d[0]);"],
  ['calc', "  if (dsum > gross) notes.push(", '  if (false) notes.push('],
  ['calc', 'floorTo(pbIn || taxable, rates.pension.unit)', 'floorTo(pbIn || taxable, 1000)'],
  ['calc', 'a = floorTo(Math.min(Math.max(floorTo(pbIn || taxable, rates.pension.unit), rates.pension.min), rates.pension.max) * rates.pension.ee, rates.cut.pension);', 'a = floorTo(floorTo(pbIn || taxable, rates.pension.unit) * rates.pension.ee, rates.cut.pension);'],
  ['calc', '    const prem = Math.min(Math.max((hbIn || taxable) * rates.health.rate, rates.health.prem_min), rates.health.prem_max);', '    const prem = (hbIn || taxable) * rates.health.rate;'],
  ['calc', 'floorTo(prem * (rates.care.rate / rates.health.rate) * rates.health.share, rates.cut.care) });', 'floorTo(prem * rates.care.rate * rates.health.share, rates.cut.care) });'],
  ['calc', 'rates.pension.max) * rates.pension.ee, rates.cut.pension);', 'rates.pension.max) * rates.pension.ee, CUT);'],
  ['calc', 'floorTo(prem * rates.health.share, rates.cut.health) });', 'floorTo(prem * rates.health.share, CUT) });'],
  ['calc', '* rates.health.share, rates.cut.care) });', '* rates.health.share, CUT) });'],
  ['calc', 'floorTo(taxable * rates.emp.ee, cutEmp) });', 'floorTo(taxable * rates.emp.ee, CUT) });'],
  ['calc', 'amt: floorTo(it * rates.local, rates.cut.local) });', 'amt: floorTo(it * rates.local, CUT) });'],
  ['bg', "cut: { pension: v('cut.pension'), health: v('cut.health'), care: v('cut.care'), local: v('cut.local'), emp: opt1('cut.emp') },", "cut: { pension: v('cut.pension'), health: v('cut.pension'), care: v('cut.care'), local: v('cut.local'), emp: opt1('cut.emp') },"],
  ['bg', "care: v('cut.care'), local: v('cut.local'), emp: opt1('cut.emp') },", "care: v('cut.local'), local: v('cut.care'), emp: opt1('cut.emp') },"],
  ['bg', "emp: opt1('cut.emp') },", 'emp: null },'],
  ['bg', "tax: Object.assign({}, bg.simptax, { cut: v('cut.income') }),", 'tax: bg.simptax,'],
  ['bg', "tax: Object.assign({}, bg.simptax, { cut: v('cut.income') }),", "tax: Object.assign({}, bg.simptax, { cut: v('cut.local') }),"],
  ['bg', '  OPT.forEach(function (k) { if ((hit[k] || []).length > 1) dup.push(k); });\n', ''],
  ['bg', 'tax_rows: bg.simptax.rows.length, missing: missing(bg) };', 'tax_rows: bg.simptax.rows.length, missing: [] };'],
  ['bg', "bg.rows.forEach(function (r) { if (r.calc === true) have[r.key] = 1; });", 'bg.rows.forEach(function (r) { have[r.key] = 1; });'],
  ['bg', ' OPT.forEach(function (k) { if (hit[k]) used[k] = hit[k][0].id; });', ''],
  ['calc', "    if (!hbIn && (fx.health == null || fx.care == null)) notes.push(", "    if (!hbIn && fx.health == null) notes.push("],
  ['calc', '  const taxable = lines.filter(function (x) { return !x.taxfree; })', '  const taxable = lines.filter(function (x) { return true; })'],
  ['calc', "  if (!skip.emp) deds.push({ n: '고용보험',", "  deds.push({ n: '고용보험',"],
  ['calc', '    let a = fx.pension;', '    let a = null;'],
  ['calc', "  deds.push({ n: '지방소득세', amt: floorTo(it * rates.local, rates.cut.local) });", "  deds.push({ n: '지방소득세', amt: Math.round(it * rates.local) });"],
  ['calc', 'if (x.ord) ord += a; ', ''],
  ['bg', "if (r.calc === true && r.from <= ym && (r.to === '' || ym <= r.to))", 'if (r.calc === true && r.from <= ym)'],
  ['bg', 'if (r.calc === true && r.from <= ym', 'if (r.from <= ym'],
  ['bg', "  if (dup.length) return { ok: false, why: 'RATE_OVERLAP', keys: dup };\n", ''],
  ['bg', "  if (!(m.from <= pym && (!m.to || pym <= m.to))) return { ok: false, why: 'NO_TAX_TABLE', keys: ['simptax'] };\n", ''],
  ['bg', "typeof x.sha === 'string' && SHA.test(x.sha))) return false;", "typeof x.sha === 'string' && x.sha.length >= 8)) return false;"],
  ['bg', '  if (zero.length) return {', '  if (false) return {'],
  ['bg', 'x.rows.length <= ROWS_MAX && typeof x.sha', 'x.rows.length <= ROWS_MAX + 1 && typeof x.sha'],
  ['bg', 'const KEY = /^[a-z0-9_]{2,20}\\.[a-z0-9_]{2,20}$/;', 'const KEY = /[a-z0-9_]{2,20}\\.[a-z0-9_]{2,20}/;'],
  ['bg', '  const hit = Object.create(null), miss = [], dup = [];', '  const hit = {}, miss = [], dup = [];'],
  ['bg', " && KEY.test(r.key) && (r.grade", ' && (r.grade'],
  ['bg', ' && x.rows.length <= ROWS_MAX && typeof x.sha', ' && typeof x.sha'],
  ['bg', "  const pym = (payYm === undefined || payYm === null || payYm === '') ? ym : payYm;", '  const pym = ym;'],
  ['bg', "  if (!YM.test(String(pym)) || pym < ym) return { ok: false, why: 'BAD_PAY_YM', keys: [] };", "  if (!YM.test(String(pym))) return { ok: false, why: 'BAD_PAY_YM', keys: [] };"],
  ['bg', " && !(r.grade === '확인 필요' && r.calc !== false)\n", '\n'],
  ['bg', "emp: { ee: v('emp.ui_rate') * v('emp.ee_share') }", "emp: { ee: v('emp.ui_rate') }"],
  ['bg', ' && r.every(nat) && r[0] === prev && r[1] > r[0])) return false; prev = r[1]; }', ' && r.every(nat))) return false; prev = r[1]; }'],
  ['bg', 'r.length === 13 && r.every(nat) && r[0] === prev', 'r.length === 13 && r[0] === prev'],
  ['bg', '  for (const r of x.rows) { if (!rowOk(r) || ids[r.id]) return false; ids[r.id] = 1; }', '  for (const r of x.rows) { if (!rowOk(r)) return false; ids[r.id] = 1; }'],
  ['bg', "    if (!(o && o.gt === gt && o.base === o.gt && nat(o.add) && pos(o.k) && pos(o.rate) && (last ? o.le === null : (nat(o.le) && o.le > o.gt)))) return false;", '    if (!o) return false;'],
  ['bg', ' && t.top.every(nat) && Array.isArray(t.over) && t.over.length >= 2', ' && Array.isArray(t.over) && t.over.length >= 2'],
  ['bg', " && (m.to === undefined || m.to === '' || (typeof m.to === 'string' && YM.test(m.to) && m.to >= m.from))", ''],
];
const alive = [];
for (const [which, from, to] of MUT) {
  if (SRC[which].split(from).length !== 2) { alive.push('자리 ' + (SRC[which].split(from).length - 1) + ': ' + from.trim().slice(0, 50)); continue; }
  let broken;
  try {
    const B = which === 'bg' ? load('paybg.js', SRC.bg.replace(from, () => to)) : B0, C = which === 'calc' ? load('paycalc.js', SRC.calc.replace(from, () => to)) : C0;
    broken = !Object.values(run(B, C)).every((v) => v === true);
  } catch (e) { broken = true; }
  if (!broken) alive.push(from.trim().slice(0, 60) + ' 안 깨짐');
}
T('66 판1 ⑦ 결함 사본 ' + MUT.length + '개(가족 열 밀림 · 77만 원 미만 0 걷음 · 초과 산식 98% 빠짐 · 음수 0 걷음 · 비율 검사 걷음 · 자녀 수 검사 느슨 · 빈 세액 칸 통과 · 틀린 금액을 0으로 · 글자 금액 받음 · 음수 시간 무시 · 야간 1.5배 · 시급 안 올림(글과 금액 어긋남) · 시급 버림 · 수당 버림 · 연금 상·하한 걷음 · 건강보험료 상·하한 걷음 · 장기요양을 보수월액 × 요율로 · 장기요양 추정 안내 빠짐 · 비과세도 과세 · 고용보험 제외 무시 · 고지액 무시 · 지방소득세 끝수 · 통상임금에 수당 안 넣음 · 끝난 요율 계속 씀 · 확인 필요 행을 계산에 · 겹침 통과 · 세액표 시행 전 통과 · 지급 달 무시 · 지급 달이 앞서도 통과 · 확인 필요 calc 검사 걷음 · 고용보험 반 안 나눔 · 구간 끊김 통과 · 빈·음수 칸 통과 · id 중복 통과 · 초과 산식 꼴 안 봄 · 1,000만 원 칸 글자 통과 · 세액표 끝 달 안 봄) = 모두 ✗', alive.length === 0, alive.join(' | '));
console.log(fail ? '\npaycalc 검산 실패 ' + fail + ' / 통과 ' + pass : '\npaycalc 검산 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
