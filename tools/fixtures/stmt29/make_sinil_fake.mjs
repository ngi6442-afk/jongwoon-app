// 29 판④ 부품 B 시험 자료 생성 — 신일 '자동차 부품납품 및 대금청구서'와 같은 배치의 **가짜 값** 통합문서(sinil_fake.xls).
// 실행: node tools/fixtures/stmt29/make_sinil_fake.mjs   (Windows + 엑셀 필요 — make_sinil_fake.ps1을 엑셀 COM으로 돌려 FileFormat 56(.xls)로 저장)
// 배치는 11/14 실물에서 꼴만 익힌 열 위치(0·1·4·5·12·17·19·24·27·29·32열)를 따르되, 모든 값은 가짜(상호·번호·금액·날짜).
// 일부러 넣은 것: 쪽 2개(머리 반복 + 건의 부품 줄이 다음 쪽으로 넘어감) · SST가 CONTINUE로 갈리는 긴 글(한글 6000자·영문 9000자)
//   · 빈 칸이 ' '(공백 글)인 칸 · 총합계 = 수식(FORMULA 숫자 결과) · 연속 정수 칸(MULRK)·소수 칸 · 문자열 수식 결과(STRING) · 둘째 시트
//   · 10자리 숫자 부품번호·부품명(서버 piiScan /\d{10,}/에 걸리는 꼴) · 차번호 변경·전체 번호판·'1축/2번' 특이사항.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'sinil_fake.xls');
const LAYOUT = path.join(here, 'sinil_fake_layout.json');

const cells = [];   // { s: 시트 번호(1부터), r, c(0부터), t: 'text'|'num'|'formula', v }
const T = (r, c, v, s = 1) => cells.push({ s, r, c, t: 'text', v: String(v) });
const N = (r, c, v, s = 1) => cells.push({ s, r, c, t: 'num', v });
const F = (r, c, v, s = 1) => cells.push({ s, r, c, t: 'formula', v });
const colA = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const ref = (r, c) => colA(c) + (r + 1);

const TOTAL = '270,900';   // = 부품 합(실물과 같은 꼴 — 총금액 = 부품 합)
function head(r0, page, pages) {
  T(r0, 0, '자동차 부품납품 및 대금청구서');
  T(r0 + 1, 0, '구    분 :'); T(r0 + 1, 3, '매출'); T(r0 + 1, 8, '일반차량 :'); T(r0 + 1, 13, '포함'); T(r0 + 1, 16, '반품내역 :'); T(r0 + 1, 20, '포함안함');
  T(r0 + 2, 0, '업    체 :'); T(r0 + 2, 3, '0000-[(주)가짜운수]'); T(r0 + 2, 21, '상    호 :'); T(r0 + 2, 26, '가짜부품상사');
  T(r0 + 3, 0, '기    간 :'); T(r0 + 3, 3, '2026-10-01'); T(r0 + 3, 8, '~'); T(r0 + 3, 10, '2026-10-31'); T(r0 + 3, 21, '대표자명 :'); T(r0 + 3, 26, '○○○');
  T(r0 + 4, 0, '청 구 일 :'); T(r0 + 4, 3, '2026-11-01'); T(r0 + 4, 21, '전화번호 :'); T(r0 + 4, 26, '000-000-0000');
  T(r0 + 6, 0, '총금액'); T(r0 + 6, 2, TOTAL); T(r0 + 6, 7, '현금 '); N(r0 + 6, 10, 0); T(r0 + 6, 15, '카드'); N(r0 + 6, 17, 0); T(r0 + 6, 22, '외상'); T(r0 + 6, 25, TOTAL); T(r0 + 6, 30, '총잔고');
  const h1 = [[0, 'SEQ'], [1, '증표번호'], [4, '항목'], [5, '관련번호'], [12, '차량번호'], [17, '현금'], [19, '카드'], [24, '외상'], [27, '총합계'], [29, '판매일자'], [32, '특이사항']];
  const h2 = [[0, '세부명세'], [5, 'L'], [6, '부품번호'], [12, '부품명'], [17, '수량'], [19, '단가'], [24, '금액']];
  h1.forEach(([c, v]) => T(r0 + 8, c, v));
  h2.forEach(([c, v]) => T(r0 + 9, c, v));
  return r0 + 10;
}
function foot(r, page, pages) {
  T(r, 0, '출력자ID : X000000'); T(r, 14, 'PAGE : ' + page + '/' + pages); T(r, 23, '출력일시 : 2026-11-01 09:00:00');
}
function caseRow(r, seq, lines, amt, date, note, rel) {
  N(r, 0, seq); T(r, 1, '1-000000-0000' + seq); N(r, 4, lines);
  if (rel != null) N(r, 5, rel);
  N(r, 17, 0); N(r, 19, 0); N(r, 24, amt);
  F(r, 27, '=' + ref(r, 17) + '+' + ref(r, 19) + '+' + ref(r, 24));   // 총합계 = 수식(FORMULA)
  T(r, 29, date); T(r, 32, note);
}
function partRow(r, pn, name, qty, unit) {
  T(r, 0, ' '); T(r, 1, ' ');   // 실물처럼 빈 칸이 공백 글
  T(r, 5, pn); T(r, 12, name); N(r, 17, qty); N(r, 19, unit); N(r, 24, Math.round(qty * unit)); N(r, 27, 0); T(r, 29, ' ');
}

let r = head(0, 1, 2);
caseRow(r++, 1, 2, 72000, '2026-10-02', '1111호 포항 모터스');
partRow(r++, 'H 100001AA001', '오일필터', 2, 15000);
partRow(r++, '1 1234567890', '에어필터(참조=9876543210)', 1, 42000);
caseRow(r++, 2, 1, 88000, '2026-10-05', '2222=3333호로 차번호변경됨 /  포항모터스');
partRow(r++, 'K 200002BB002', '브레이크 패드', 1, 88000);
caseRow(r++, 3, 3, 94000, '2026-10-09', '경북12가3456 포항모터스 PHMTS26PO123456', 100000000001);
partRow(r++, 'H 300003CC003', '벨트', 1, 25000);
r++;
foot(r++, 1, 2);
r = head(r, 2, 2);
partRow(r++, 'H 300004CC004', '텐셔너', 2, 31500);          // 건 3의 부품이 다음 쪽으로 넘어감
partRow(r++, 'H 300005CC005', '그리스', 1.5, 4000);
caseRow(r++, 4, 1, 10000, '2026-10-20', '4444호  포항 모터스   1축/2번');
partRow(r++, 'T 400006DD006', '타이어 밸브', 4, 2500);
caseRow(r++, 5, 2, 6900, '2026-10-31', '5555/포항모터');
partRow(r++, 'H 500007EE007', '전구', 3, 1200);
partRow(r++, 'H 500008EE008', '퓨즈', 10, 330);
r++;
foot(r++, 2, 2);

// 읽개 시험용 칸(틀 밖 34열 이후 — 틀은 무시해야 함)
const LONG_KO = '가나다라마바사아자차카타파하'.repeat(429).slice(0, 6000);   // UTF-16 12000바이트 → SST CONTINUE
const LONG_EN = 'ABCDEFGHIJ'.repeat(900);                                  // 압축 9000바이트 → CONTINUE
T(r + 2, 34, LONG_KO);
T(r + 3, 34, LONG_EN);
T(r + 4, 34, '끝글자' + LONG_KO.slice(0, 50));
N(r + 5, 34, 7); N(r + 5, 35, 8); N(r + 5, 36, 9); N(r + 5, 37, -3);      // MULRK
N(r + 6, 34, 0.01); N(r + 6, 35, 123456.78); N(r + 6, 36, 3.14159);    // RK(×100) · NUMBER
F(r + 7, 34, '="수식"&"글"');                                              // FORMULA 문자열 결과 → STRING
T(1, 0, '메모', 2); N(2, 1, 42, 2);                                         // 둘째 시트

fs.writeFileSync(LAYOUT, JSON.stringify({ out: OUT, sheet2: '메모시트', cells }, null, 0), 'utf8');
if (process.argv.includes('--layout-only')) { console.log('layout', LAYOUT, cells.length, '칸'); process.exit(0); }
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'make_sinil_fake.ps1'), '-Layout', LAYOUT], { stdio: 'inherit' });
fs.unlinkSync(LAYOUT);
console.log('만듦', OUT, fs.statSync(OUT).size, '바이트');
