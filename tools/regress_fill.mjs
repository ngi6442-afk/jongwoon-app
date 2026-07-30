// 회귀테스트 1단계: 앱 엔진(index.html에서 추출)으로 로컬 원본들을 채워 out/ 에 생성
// 실행: node tools/regress_fill.mjs   (이후 tools/regress.ps1 이 COM 검증)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'out');
mkdirSync(OUT, { recursive: true });
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const cut = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));
let src = [
  cut('function dataUrlToBytes', 'async function readXlsx'),
  cut('var CRC_T=', 'function xmlEsc'),
  cut('function xmlEsc', '// b64 양식 + 시트별 편집'),
  cut('async function fillXlsxTemplate', 'function downloadBlob'),
  cut('async function fillHwpxTemplate', '// ---- 적격심사 점수'),
  cut('async function bidRateApply', '\n  // 정밀 안착'),
].join('\n');
eval('(function(){' + src + '\nglobalThis.__e={fillXlsxTemplate,fillHwpxTemplate,bidRateApply};})()');
const { fillXlsxTemplate, fillHwpxTemplate, bidRateApply } = globalThis.__e;

const DATA = 'C:/Users/user/Desktop/작업';
const b64of = (p) => readFileSync(p).toString('base64');
const save = async (name, blob) => writeFileSync(join(OUT, name), Buffer.from(await blob.arrayBuffer()));

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([name, 'FILL-OK']); }
  catch (e) { results.push([name, '실패: ' + (e && e.message || e)]); }
}

// 1) 착공계(공정표 포함) — 최신 생성 로직의 대표 편집 재현
await run('착공계+공정표', async () => {
  const edits = { '공사예정공정표': [
    ['C14', '가설·보양 및 구조물 해체', 's'], ['C15', '폐기물 반출·정리', 's'], ['C16', '', 'b'], ['C17', '', 'b'],
    ['F14', '08.01 ~ 08.03', 's'], ['F15', '08.04 ~ 08.05', 's']
  ], '__drop_drawings__': ['공사예정공정표'],
  '착공계': [['B16', '2026년 8월   일', 's']] };
  await save('R_착공계.xlsx', await fillXlsxTemplate(b64of(DATA + '/테스트 철거공사_착공계.xlsx'), edits));
});
// 2) 폐기물배출신고서 — 허브 값 채움
await run('폐기물배출신고서', async () => {
  const edits = { '신고서': [['E8', '회귀테스트상호', 's'], ['E16', '회귀 용역명', 's'], ['E20', 2.95, 'n'], ['E21', 0.05, 'n']] };
  await save('R_폐기물신고서.xlsx', await fillXlsxTemplate(b64of(DATA + '/6. 자료/폐기물배출 신고서.xlsx'), edits));
});
// 2.5) 해체신고서 — 허브 시트 채움(생성 로직과 동일 좌표)
await run('해체신고서', async () => {
  const edits = { '건축물해체신고서': [['C7', '회귀테스트소유자', 's'], ['C21', '회귀 테스트 지번', 's'], ['F39', '2099년01월   일', 's']] };
  await save('R_해체신고서.xlsx', await fillXlsxTemplate(b64of(DATA + '/건축물 해체 및 해체 완료 신고.xlsx'), edits));
});
// 3) 낙찰률 v2 — 철강공단 원본, 실물 rate
await run('낙찰률적용', async () => {
  const bytes = new Uint8Array(readFileSync(DATA + '/준설분석/내역_원본.xlsx'));
  const r = await bidRateApply(bytes, 19525000 / 21500000);
  if (!r.changed) throw new Error('단가 조정 0개');
  await save('R_낙찰률.xlsx', r.blob);
});
// 4~6) hwpx 3종
await run('적격심사패킷', async () => {
  await save('R_적격패킷.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/적격심사분석/적격심사패킷_템플릿.hwpx'),
    { '공고명': '회귀테스트 석면철거공사', '수요기관': '경상북도교육청 테스트교육지원청', '수신처': '테스트교육지원청(분임)재무관',
      '공고번호': '20990101999-00', '입찰일': '2099.1.1', '제출기한': '2099.1.', '공사기간': '착공일로부터 30일',
      '입찰금액': '123,456,789', '예정가격': '134,567,890', '제출일': '2099. 1. 2.', '제출일자': '2099년 1월 2일',
      '점수계': '95.5', '점수소계': '9.5', '점수실적': '4', '점수경영': '4.5', '점수신인도': '+0.5', '점수입찰가': '85', '점수안전': '-4' }));
});
await run('계약이행서약서', async () => {
  await save('R_서약서.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/계약서류분석/계약이행서약서_템플릿.hwpx'),
    { '계약명': '회귀테스트 준설공사', '보증기간': '2099.01.01.~2099.02.01.', '업체명': '유한회사 종운환경', '연락처': '054-291-1204',
      '사업자번호': '506-81-48535', '금액한글': '일금일천만원', '금액숫자': '10,000,000', '보증금률': '5%', '보증금액': '500,000',
      '작성일': '2099.01.01.', '수신처': '포항시 맑은물사업본부 관리자(기업출납원)' }));
});
await run('사용인감계', async () => {
  await save('R_인감계.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/계약서류분석/사용인감계_템플릿.hwpx'),
    { '작성일': '2099년  01월    일', '업체명': '주식회사 종운건설', '주소': '포항시 남구 정몽주로 823-10' }));
});
await run('채권포기각서', async () => {
  await save('R_포기각서.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/계약서류분석/채권포기각서_템플릿.hwpx'),
    { '계약명': '회귀테스트 준설공사', '계약기간': '2099.01.01.~2099.02.01.', '작성일': '2099년 01월 01일',
      '업체명': '유한회사 종운환경', '주소': '경북 포항시 남구 서원재로 1', '수신처': '포항시 맑은물사업본부 관리자(기업출납원)' }));
});
await run('노무비제외신청서', async () => {
  await save('R_노무비신청서.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/계약서류분석/노무비제외신청서_템플릿.hwpx'), {}));
});
const QT = { '견적번호': '209901-01', '견적일자': '2099년 01월 01일', '수신처': '포항시 맑은물사업본부',
  '용역명': '회귀테스트 하수관로 준설공사', '금액한글': '일천만', '금액숫자': '10,000,000', '부가세구분': '부가세 포함',
  '품명': '회귀테스트 하수박스 준설공사', '성상': '고상', '구분': '일반', '단위': '식', '수량': '1', '단가': '10,000,000', '금액': '10,000,000' };
await run('견적서(환경)', async () => {
  await save('R_견적서_환경.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/계약서류분석/견적서_템플릿_환경.hwpx'), QT));
});
await run('견적서(건설)', async () => {
  await save('R_견적서_건설.hwpx', await fillHwpxTemplate(b64of(DATA + '/6. 자료/계약서류분석/견적서_템플릿_건설.hwpx'), QT));
});

console.log(JSON.stringify(results));
