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
const thr = (fn) => { try { fn(); return ''; } catch (e) { return e.code === 'PAY_BAD_INPUT' ? e.field : 'other:' + e.message; } };

function run(B, C) {
  const R = {};
  const clone = () => JSON.parse(JSON.stringify(BG));
  const mk = (f) => { const x = clone(); f(x); return x; };
  // ① 꼴·요율 고르기
  const r11 = B.ratesFor(BG, '2026-11'), r06 = B.ratesFor(BG, '2026-06'), r27 = B.ratesFor(BG, '2027-01');
  const BADS = [mk((x) => { x.rows.find((r) => r.id === 'pay.minwage').calc = true; }), mk((x) => { x.simptax.rows.splice(50, 1); }), mk((x) => { x.domain = 'hr'; }), null,
    mk((x) => { x.simptax.over = [{ gt: 10000, le: null, add: 0, base: 10000, k: 1, rate: 0.1 }]; }), mk((x) => { x.simptax.over[2].gt = 27000; }), mk((x) => { x.simptax.over[5].le = 99000; }),
    mk((x) => { x.simptax.top = x.simptax.top.map(String); }), mk((x) => { x.simptax.rows[300][4] = null; }), mk((x) => { x.rows.push(JSON.parse(JSON.stringify(x.rows[0]))); }),
    mk((x) => { x.simptax_meta.to = '2026-01'; }), mk((x) => { x.simptax.rows[10][3] = -1; })];
  R.shape = B.bgOk(BG) && BADS.every((x) => !B.bgOk(x))
    && JSON.stringify(B.bgSum(BG)) === JSON.stringify({ ver: BG.ver, sha: BG.sha, checked: '2026-11-20', n: 32, n_pending: 2, n_calc_false: 2, tax_from: '2026-03', tax_rows: 646 });
  R.pick = r11.ok && r11.rates.pension.ee === 475 / 10000 && r11.rates.pension.min === 410000 && r11.rates.pension.max === 6590000 && r11.used['pension.ee'] === 'pay.pension.ee.2026'
    && r06.ok && r06.rates.pension.min === 400000 && r06.rates.pension.max === 6370000
    && r27.ok && r27.rates.pension.ee === 500 / 10000 && r27.used['pension.ee'] === 'pay.pension.ee.2027' && B.ratesFor(BG, '2026-12').rates.pension.ee === 475 / 10000
    && r11.rates.health.rate === 719 / 10000 && r11.rates.health.share === 0.5 && r11.rates.care.rate === 9448 / 1000000 && r11.rates.emp.ee === 18 / 1000 / 2 && r11.rates.local === 0.1
    && r11.rates.ot.ext === 0.5 && r11.rates.ot.hol8 === 1 && r11.ver === BG.ver && r11.sha === BG.sha && r11.pay_ym === '2026-11';
  const dup = mk((x) => { x.rows.push(Object.assign({}, x.rows.find((r) => r.id === 'pay.health.rate'), { id: 'pay.health.rate.x' })); });
  const n1 = B.ratesFor(BG, '2026-02'), n2 = B.ratesFor(BG, '2027-07'), n3 = B.ratesFor(BG, '2025-12'), n4 = B.ratesFor(BG, '2026-13'), n5 = B.ratesFor(dup, '2026-11');
  R.refuse = !n1.ok && n1.why === 'NO_TAX_TABLE' && !n2.ok && n2.why === 'NO_RATE' && n2.keys.join() === 'pension.base_min,pension.base_max' && !n3.ok && n3.why === 'NO_RATE' && n3.keys.length === 13
    && !n4.ok && n4.why === 'BAD_YM' && !n5.ok && n5.why === 'RATE_OVERLAP' && n5.keys.join() === 'health.rate';
  // 세액표는 지급하는 달 기준: 2월 귀속분을 3월에 지급하면 새 표 · 지급 달이 귀속 달보다 앞서면 거절
  const p1 = B.ratesFor(BG, '2026-02', '2026-03'), p2 = B.ratesFor(BG, '2026-03', '2026-02'), p3 = B.ratesFor(BG, '2026-11', '2026-12'), p4 = B.ratesFor(BG, '2026-11', 'x');
  R.payym = p1.ok && p1.ym === '2026-02' && p1.pay_ym === '2026-03' && p1.rates.pension.ee === 475 / 10000 && !p2.ok && p2.why === 'BAD_PAY_YM' && p3.ok && p3.pay_ym === '2026-12' && p3.rates.pension.ee === 475 / 10000 && !p4.ok && p4.why === 'BAD_PAY_YM'
    && BG.simptax_meta.basis === 'pay';
  // 확인 필요 행(calc false)은 그 달을 덮어도 요율로 뽑히지 않는다
  const pend = mk((x) => { const h = x.rows.find((r) => r.id === 'pay.health.rate'); h.grade = '확인 필요'; h.calc = false; h.why = '시험'; });
  const n6 = B.ratesFor(pend, '2026-11');
  R.pending = B.bgOk(pend) && !n6.ok && n6.why === 'NO_RATE' && n6.keys.join() === 'health.rate';
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
    && cm({ pension_base: '3000000' }) === 'pension_base' && cm({ pct: '80' }) === 'pct' && cm({ hours: '209' }) === 'hours' && cm({}) === '';
  const brk = mk((x) => { x.simptax.rows[448][2] = undefined; });
  R.strict = R.strict && /SIMPTAX_BAD_TABLE/.test(thr(() => C.simpTax(brk.simptax, brk.simptax.rows[448][0] * 1000, 1, 0, 100)));
  return R;
}
const B0 = require(join(LIB, 'paybg.js')), C0 = require(join(LIB, 'paycalc.js'));
const R0 = run(B0, C0);
T('66 판1 ① 근거 표 꼴: 확인 필요 행이 계산에 쓰임 · 세액표 구간 끊김 · 다른 영역 표 · 초과 산식 줄이 모자람·구간이 안 이어짐·끝이 안 열림 · 세액 칸이 글자·빈 값·음수 · 행 id 중복 · 세액표 끝 달이 시작 달보다 앞 = 거절 · 요약(행 32 · 확인 필요 2 · 세액표 646구간 · 2026-03부터)', R0.shape, '');
T('66 판1 ① 귀속 달 요율: 2026-11·2026-12 = 연금 1만분의 475·기준소득월액 41만~659만 · 2026-06 = 40만~637만 · 2027-01 = 1만분의 500 · 건강 1만분의 719 반씩 · 장기요양 100만분의 9,448 · 고용 1천분의 18의 반 · 지방소득세 10% · 쓴 행 id·판 지문 동봉', R0.pick, '');
T('66 판1 ① 계산 거부: 세액표 시행 전 달 NO_TAX_TABLE · 고시가 아직 없는 달 NO_RATE(빠진 키) · 표 앞 달 NO_RATE · 달 꼴 BAD_YM · 같은 달을 두 행이 덮음 RATE_OVERLAP · 확인 필요 행은 요율로 안 뽑힘 · 세액표는 지급하는 달 기준(2월 귀속·3월 지급 = 새 표 · 보험 요율은 귀속 달 그대로 · 지급 달이 귀속 달보다 앞·꼴 틀림 BAD_PAY_YM)', R0.refuse && R0.pending && R0.payym, JSON.stringify({ refuse: R0.refuse, pending: R0.pending, payym: R0.payym }));
T('66 판1 ② 간이세액표 칸(646구간 × 11열 × 구간 양 끝) 되읽기 — 조회가 구간·열을 잘못 짚지 않음', R0.cells, '');
T('66 판1 ② 경계(77만 원 미만 0 · 1,000만 원 칸 · 표본 칸 · 가족·자녀·비율 빈 값 = 1명·0명·100%) · 1,000만 원 초과 산식 손계산·구간 이음새 · 자녀 공제 1·2·3명·음수면 0 · 80·120% · 가족 13명', R0.edge && R0.over && R0.kids, JSON.stringify({ edge: R0.edge, over: R0.over, kids: R0.kids }));
T('66 판1 ③ 한 달 손계산: 통상시급 원 미만 올림 · 연장수당 = 통상시급 × 시간 × 1.5(계산식 글과 금액이 같은 시급 · 금액은 올림) · 4대보험 4줄 · 장기요양 = 건강보험료 × 요율 비율 · 소득세 = 세액표 칸 · 지방소득세 10% · 세후 = 지급 − 공제 · 야간 0.5·휴일 1.5·휴일 8시간 초과 2.0', R0.month && R0.ot && R0.how, JSON.stringify({ month: R0.month, ot: R0.ot, how: R0.how }));
T('66 판1 ④ 기준소득월액 상·하한 · 건강보험료 상·하한(반) · 가입 제외 표시 · 공단 고지액 우선 · 빈 칸 안내 2줄 · 건강보험 고지액만 있으면 장기요양 추정 안내 · 소정근로시간 없으면 시간 수당 0 + 안내 · 그 달 수당(비과세)·공제 줄', R0.caps && R0.opts && R0.extra, JSON.stringify({ caps: R0.caps, opts: R0.opts, extra: R0.extra }));
T('66 판1 ⑤ 틀린 입력은 던짐(0으로 바꾸지 않음): 과세 급여 NaN·빈 값·음수·글자 · 비율 90·글자 · 가족 0·소수 · 자녀가 본인 뺀 가족 수 초과 · 기본급 글자·빈 값 · 음수 수당 · 글자 수당·고지액·기준소득월액·시간 · NaN 공제 · 음수·글자 연장 시간 · 세액 칸이 빈 표 = SIMPTAX_BAD_TABLE', R0.strict, '');
// ⑥ 코드에 요율 숫자 없음 — 계산 파일 두 개에서 주석·글자열을 걷어 낸 뒤 남는 숫자는 끝수 단위·천원 환산·열 수·비율 선택지·정규식 길이뿐이어야 한다
const bare = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/'[^'\n]*'/g, "''");
const nums = (s) => (bare(s).match(/\b\d+(?:\.\d+)?(?:e-?\d+)?\b/g) || []).filter((x) => !['0', '1', '2', '3', '4', '8', '9', '10', '11', '13', '20', '40', '80', '100', '120', '1000', '10000', '1e-6', '1e-9'].includes(x));
T('66 판1 ⑥ 계산 파일에 요율 숫자 없음(값은 근거 표에서만) · 두 파일은 저장소·시각·다른 모듈을 부르지 않음', nums(SRC.calc).length === 0 && nums(SRC.bg).length === 0 && !/require\(|Date\.|process\.env|getStore/.test(bare(SRC.calc) + bare(SRC.bg)), JSON.stringify({ calc: nums(SRC.calc), bg: nums(SRC.bg) }));
// ⑦ 결함 사본 — 한 곳을 바꾼 사본에서는 위 검사 가운데 하나가 깨져야 한다
const MUT = [
  ['calc', '    if (fam <= 11) return arr[off + fam - 1];', '    if (fam <= 11) return arr[off + fam];'],
  ['calc', '  if (k < tax.below) t = 0;', '  if (false) t = 0;'],
  ['calc', '      t = t + o.add + (taxable - o.base * 1000) * o.k * o.rate;', '      t = t + o.add + (taxable - o.base * 1000) * o.rate;'],
  ['calc', '  if (t < 0) t = 0;\n', ''],
  ['calc', "  if (pct !== 80 && pct !== 100 && pct !== 120) throw bad('pct');\n", ''],
  ['calc', "  if (!Number.isInteger(kids) || kids < 0 || kids > fam - 1) throw bad('kids');", "  if (!Number.isInteger(kids) || kids < 0) throw bad('kids');"],
  ['calc', "  if (!Number.isFinite(t)) throw new Error('SIMPTAX_BAD_TABLE');\n", ''],
  ['calc', "function amt(v, what) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(what); return Math.round(v); }", 'function amt(v, what) { v = Number(v); return v > 0 ? Math.round(v) : 0; }'],
  ['calc', "function amt(v, what) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(what);", "function amt(v, what) { v = Number(v); if (!Number.isFinite(v) || v < 0) throw bad(what);"],
  ['calc', "    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) throw bad('ot.' + d[0]);\n", '    if (!(h > 0)) return;\n'],
  ['calc', "['night', '야간근로 가산', rates.ot.night]", "['night', '야간근로 가산', 1 + rates.ot.night]"],
  ['calc', '  const hourly = hours > 0 ? Math.ceil(ord / hours - 1e-9) : 0;', '  const hourly = hours > 0 ? ord / hours : 0;'],
  ['calc', '  const hourly = hours > 0 ? Math.ceil(ord / hours - 1e-9) : 0;', '  const hourly = hours > 0 ? Math.floor(ord / hours) : 0;'],
  ['calc', 'amt: Math.ceil(hourly * h * d[2] - 1e-6), taxfree: false, hours: h,', 'amt: Math.floor(hourly * h * d[2]), taxfree: false, hours: h,'],
  ['calc', '      a = floorTo(Math.min(Math.max(pbIn || taxable, rates.pension.min), rates.pension.max) * rates.pension.ee, CUT);', '      a = floorTo((pbIn || taxable) * rates.pension.ee, CUT);'],
  ['calc', '    const prem = Math.min(Math.max((hbIn || taxable) * rates.health.rate, rates.health.prem_min), rates.health.prem_max);', '    const prem = (hbIn || taxable) * rates.health.rate;'],
  ['calc', 'floorTo(prem * (rates.care.rate / rates.health.rate) * rates.health.share, CUT) });', 'floorTo(prem * rates.care.rate * rates.health.share, CUT) });'],
  ['calc', "    if (!hbIn && (fx.health == null || fx.care == null)) notes.push(", "    if (!hbIn && fx.health == null) notes.push("],
  ['calc', '  const taxable = lines.filter(function (x) { return !x.taxfree; })', '  const taxable = lines.filter(function (x) { return true; })'],
  ['calc', "  if (!skip.emp) deds.push({ n: '고용보험',", "  deds.push({ n: '고용보험',"],
  ['calc', '    let a = fx.pension;', '    let a = null;'],
  ['calc', "  deds.push({ n: '지방소득세', amt: floorTo(it * rates.local, 10) });", "  deds.push({ n: '지방소득세', amt: Math.round(it * rates.local) });"],
  ['calc', 'if (x.ord) ord += a; ', ''],
  ['bg', "if (r.calc === true && r.from <= ym && (r.to === '' || ym <= r.to))", 'if (r.calc === true && r.from <= ym)'],
  ['bg', 'if (r.calc === true && r.from <= ym', 'if (r.from <= ym'],
  ['bg', "  if (dup.length) return { ok: false, why: 'RATE_OVERLAP', keys: dup };\n", ''],
  ['bg', "  if (!(m.from <= pym && (!m.to || pym <= m.to))) return { ok: false, why: 'NO_TAX_TABLE', keys: ['simptax'] };\n", ''],
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
