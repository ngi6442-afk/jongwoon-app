// 준공 정산 엔진 회귀 — 김천서부초 실물(최종본 99,188,000)을 원단위까지 재현하는지 검증
// 실행: node tools/settletest.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('var SETTLE_NO_CUT');
const b = html.indexOf('// ---- 정산 끝', a);
if (a < 0 || b < 0) throw new Error('settleCalc 추출 실패');
eval('(function(){' + html.slice(a, b) + '\nglobalThis.__s={settleCalc};})()');
const { settleCalc } = globalThis.__s;

// 김천서부초 다목적강당 석면해체·제거공사 (계약 108,239,210 / 최종 정산 99,188,000)
const IN = {
  mat: 12012868,          // 직접재료비
  labor: 44220246,        // 직접노무비
  mach: 347829,           // 기계경비
  waste: 6242374,         // 폐기물처리비
  items: [
    { key: 'sanjae', label: '산재보험료', base: 1840667, actual: 1840667, deductible: false },
    { key: 'goyong', label: '고용보험료', base: 502452, actual: 502452, deductible: false },
    { key: 'health', label: '국민건강보험료', base: 1813915, actual: 0, deductible: true },
    { key: 'pension', label: '국민연금보험료', base: 2302573, actual: 0, deductible: true },
    { key: 'care', label: '노인장기요양보험료', base: 232362, actual: 0, deductible: true },
    { key: 'retire', label: '퇴직공제부금비', base: 1176870, actual: 0, deductible: true },
    { key: 'safety', label: '산업안전보건관리비', base: 1906511, actual: 1060000, deductible: true },
    { key: 'env', label: '환경보전비', base: 196413, actual: 0, deductible: true },
    { key: 'etc', label: '기타경비', base: 4817330, actual: 4817330, deductible: false },
    { key: 'zero', label: '(0% 항목)', base: 0, actual: 0, deductible: false },
    { key: 'mach_bond', label: '건설기계대여금 지급보증수수료', base: 181059, actual: 0, deductible: true }
  ],
  origTotal: 108239210,   // 당초 도급액 = 계약금액(확정값 — 당초 이윤도 단수 조정된 값이라 재계산하지 않는다)
  target: 99188000        // 목표 정산액(발주처 합의 라운드 금액) → 이윤 조정 요율 역산
};

const r = settleCalc(IN);
const EXP = {
  expSub: 8568278,            // 경비 소계(정산)
  sum: 70328922,              // 계
  gm: 4219735.32,             // 일반관리비
  profit: 9379877.8,          // 이윤
  supply: 90170909.12,        // 공급가액
  vat: 9017090.91,            // 부가세
  total: 99188000,            // 도급액(정산)
  cut: 9051210,               // 총 감액(당초 108,239,210 − 99,188,000)
  rate: 0.149992155           // 역산된 이윤 조정 요율
};
const near = (x, y, tol) => Math.abs(x - y) <= tol;
const fails = [];
const chk = (name, got, exp, tol) => {
  const ok = near(got, exp, tol);
  const shown = (typeof got === 'number') ? (got < 1 ? got.toFixed(9) : got.toFixed(2)) : got;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + ': ' + shown + (ok ? '' : ' ≠ 기대 ' + exp));
  if (!ok) fails.push(name);
};
console.log('김천서부초 최종본(99,188,000) 재현 검증');
chk('경비 소계', r.expSub, EXP.expSub, 0.5);
chk('계(순공사원가)', r.sum, EXP.sum, 0.5);
chk('일반관리비', r.gm, EXP.gm, 0.5);
chk('이윤', r.profit, EXP.profit, 1);
chk('공급가액', r.supply, EXP.supply, 1);
chk('부가세', r.vat, EXP.vat, 1);
chk('도급액(정산)', r.total, EXP.total, 0.5);
chk('총 감액', r.cut, EXP.cut, 0.5);
chk('이윤 조정 요율', r.profitRate, EXP.rate, 0.0000005);
console.log('  감액 항목: ' + r.cutItems.map((c) => c.label + ' ' + c.cut.toLocaleString()).join(' / '));
console.log('  정산사유 문구: ' + r.reason);
if (r.warn.length) console.log('  경고: ' + r.warn.join(' | '));

// 법령 가드: 산재·고용을 감액 대상으로 잘못 체크하면 경고가 떠야 한다
const bad = JSON.parse(JSON.stringify(IN));
bad.items[0].deductible = true; bad.items[0].actual = 0;
const r2 = settleCalc(bad);
const hasWarn = r2.warn.some((w) => w.indexOf('산재') >= 0);
console.log((hasWarn ? '  ✓ ' : '  ✗ ') + '법령 가드(산재 감액 시 경고)');
if (!hasWarn) fails.push('법령 가드');

console.log(fails.length ? '\n실패: ' + fails.join(', ') : '\n전 항목 통과');
process.exit(fails.length ? 1 : 0);
