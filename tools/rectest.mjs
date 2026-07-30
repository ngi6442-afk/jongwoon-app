// 세금계산서 목록(.xlsx) 파서 회귀 — 앱 엔진(index.html에서 추출)으로 실물 파일 파싱 검증
// 실행: node tools/rectest.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const cut = (from, to) => {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('추출 실패: ' + from);
  return html.slice(a, b);
};
const src = [
  cut('function dataUrlToBytes', 'async function readXlsx'),
  cut('async function readXlsx', '  // b64 양식 + 시트별 편집'),
  cut('function recImportMap', 'function recImportPlan'),
].join('\n');
eval('(function(){' + src + '\nglobalThis.__r={readXlsx,recImportMap};})()');
const { readXlsx, recImportMap } = globalThis.__r;

const FILE = 'C:/Users/user/Desktop/작업/세금계산서목록.xlsx';
const b64 = readFileSync(FILE).toString('base64');
const sheets = await readXlsx('x,' + b64);
console.log('시트: ' + sheets.map((s) => s.name + '(' + s.grid.length + '행)').join(', '));
const rows = sheets[0].grid;
const recs = recImportMap(rows);
console.log('파싱 건수: ' + recs.length);

const fails = [];
if (!recs.length) fails.push('0건 파싱');
const co = { env: 0, con: 0, '': 0 };
let sumTotal = 0, badAmt = 0, badDate = 0, sales = 0;
for (const r of recs) {
  co[r.co || ''] = (co[r.co || ''] || 0) + 1;
  sumTotal += r.amount;
  if (r.amount !== r.supply + r.tax) badAmt++;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.billed)) badDate++;
  if (r.io === '매출' || !r.io) sales++;
}
console.log('회사 자동판별: 환경 ' + co.env + ' / 건설 ' + co.con + ' / 미판별 ' + (co[''] || 0));
console.log('합계액 총액: ' + sumTotal.toLocaleString() + '원');
console.log('공급가액+세액 불일치: ' + badAmt + '건 / 작성일자 형식오류: ' + badDate + '건');
console.log('샘플 3건:');
recs.slice(0, 3).forEach((r) => console.log('  ' + [r.billed, r.co, r.client, r.desc.slice(0, 20), r.amount.toLocaleString(), r.nts.slice(0, 12)].join(' | ')));

if (badAmt) fails.push('금액 정합 불일치 ' + badAmt + '건');
if (badDate) fails.push('날짜 형식오류 ' + badDate + '건');
if ((co[''] || 0) === recs.length) fails.push('회사 자동판별 전부 실패');
console.log(fails.length ? '\n실패: ' + fails.join(' / ') : '\n전 항목 통과');
process.exit(fails.length ? 1 : 0);
