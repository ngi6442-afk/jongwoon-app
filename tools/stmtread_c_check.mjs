// 29 판④ 부품 C 시험 — _lib/pdftext.js + _lib/stmtpdfmap.js(수양 거래명세서 · 오천 원장 전표별 · 오천 상품상세).
// 실행: node tools/stmtread_c_check.mjs   (실패 있으면 exit 1, 다 맞으면 '전 항목 통과')
// 결함 사본 확인용: 환경 변수 STMT_C_LIB = 고친 _lib 폴더 절대 경로(기본 = netlify/functions/_lib).
// 가짜 자료: tools/fixtures/stmt29/ (make_suyang_pdf.py = 엑셀 COM, make_ochun_pdf.py = PyMuPDF). 실물·개인정보 없음.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = process.env.STMT_C_LIB || path.join(HERE, '..', 'netlify', 'functions', '_lib');
const require = createRequire(import.meta.url);
const PT = require(path.join(LIB, 'pdftext.js'));
const M = require(path.join(LIB, 'stmtpdfmap.js'));
const FX = path.join(HERE, 'fixtures', 'stmt29');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('실패:', name); } }
function eq(a, b, name) { const s1 = JSON.stringify(a), s2 = JSON.stringify(b); ok(s1 === s2, name + (s1 === s2 ? '' : ' — 받음 ' + s1 + ' / 기대 ' + s2)); }
const fx = (f) => fs.readFileSync(path.join(FX, f));
const row = (date, vraw, item, kind, qty, unit, amt, vat) => ({ date, vraw, item, kind, qty, unit, amt, vat, note: '', how: 'file' });

// ── 1. 수양 거래명세서(엑셀 글자 PDF) ──
{
  const r = await M.readStmtPdf(fx('suyang_fake.pdf'));
  ok(r.ok && !r.textless, '수양: 읽기 성공');
  eq(r.src, 'pdf', '수양: src');
  eq(r.vendor, { name: '가짜개발', bn: '0000000000' }, '수양: 공급자 상호·번호');
  eq(r.ym_hint, '2026-10', '수양: 기간');
  eq(r.rows, [
    row('2026-10-02', '5288', '감속기뭉치, 체인', 'cover', 1, 450000, 450000, 45000),
    row('2026-10-15', '1234', '덮개판L, 덮개판R', 'cover', 2, 150000, 300000, 30000),
    row('2026-10-28', '80버5474', '레일L, 레일R', 'cover', 1, 450000, 450000, 45000),
  ], '수양: 줄 3개');
  eq(r.inv, null, '수양: 합계 줄은 inv 아님');
  eq(r.carry, null, '수양: carry 없음');
  eq(r.warn, [], '수양: 경고 없음');
  ok(r.check && r.check.sum_ok === true && r.check.lines === 3, '수양: 줄 합 = 합계 줄');
  ok(M.readPdf === M.readStmtPdf, 'readPdf = readStmtPdf(stmtread.js가 부르는 이름)');
}

// ── 2. 오천 거래처 원장 - 전표별 ──
{
  const r = await M.readStmtPdf(fx('ochun_ledger_fake.pdf'));
  ok(r.ok && !r.textless, '원장: 읽기 성공');
  eq(r.carry, { prev: 450000, month: 77000, paid: 500000, bal: 27000 }, '원장: carry');
  eq(r.rows, [], '원장: 줄은 만들지 않음');
  eq(r.vendor.name, '가짜공구상사', '원장: 매장 상호');
  eq(r.ym_hint, '2026-10', '원장: 기간(전표일자 끝)');
  eq(r.warn, [], '원장: 경고 없음');
  ok(r.check.sum_ok === true, '원장: 이월+매출−수금 = 잔액');
}

// ── 3. 오천 거래처 원장 - 상품상세 ──
{
  const r = await M.readStmtPdf(fx('ochun_detail_fake.pdf'));
  ok(r.ok && !r.textless, '상세: 읽기 성공');
  eq(r.rows, [
    row('2026-10-20', '', '장갑(10KG)* 100', 'tool', 1, 44000, 40000, 4000),
    row('2026-10-20', '', '마대*포대 5KG', 'tool', 1, 33000, 30000, 3000),
  ], '상세: 줄 2개');
  eq(r.carry, null, '상세: carry 없음');
  eq(r.warn, [], '상세: 경고 없음(단가 = 부가세 포함 허용)');
  ok(r.check.sum_ok === true && r.check.lines === 2, '상세: 줄 합 = 합계');
}

// ── 4. 그림 PDF·모르는 틀·잘못된 입력 ──
{
  const t = await M.readStmtPdf(fx('textless_fake.pdf'));
  eq({ ok: t.ok, textless: t.textless, src: t.src, pages: t.pages }, { ok: true, textless: true, src: 'pdf', pages: 1 }, '그림 PDF: textless');
  const u = await M.readStmtPdf(fx('unknown_fake.pdf'));
  eq({ ok: u.ok, code: u.code }, { ok: false, code: 'UNKNOWN_LAYOUT' }, '모르는 틀: UNKNOWN_LAYOUT');
  const n = await PT.pdfText(Buffer.from('hello world, not a pdf'));
  eq(n.code, 'NOT_PDF', '아닌 파일: NOT_PDF');
  const big = Buffer.alloc(PT.LIM.bytes + 1, 0x20); big.write('%PDF-1.4');
  eq((await PT.pdfText(big)).code, 'TOO_BIG', '8MB 넘음: TOO_BIG');
  const broken = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF');
  const b = await PT.pdfText(broken);
  ok(!b.ok && (b.code === 'PDF_BAD'), '깨진 PDF: PDF_BAD');
  eq((await PT.pdfText('x')).code, 'BAD_INPUT', '글 입력: BAD_INPUT');
  const pt = await PT.pdfText(fx('suyang_fake.pdf'));
  ok(pt.ok && pt.pages.length === 1 && pt.pages[0].w > 590 && pt.pages[0].items.every((i) => typeof i.x === 'number' && typeof i.y === 'number' && typeof i.w === 'number' && typeof i.str === 'string'), 'pdfText: 쪽·조각 꼴');
}

// ── 5. 유틸 ──
{
  const it = (x, y, w, str) => ({ x, y, w, h: 6, str });
  const ls = PT.groupLines([it(50, 101, 10, 'B'), it(10, 100, 10, 'A'), it(10, 110, 10, 'C')], 3);
  eq(ls.map((l) => l.text), ['A B', 'C'], 'groupLines: y 허용 오차로 묶고 x 순');
  const heads = [{ key: 'item', x: 100, w: 20 }, { key: 'qty', x: 200, w: 20 }, { key: 'amt', x: 260, w: 30 }];
  eq(PT.splitCols([it(80, 0, 60, '긴 품목 이름'), it(214, 0, 8, '3'), it(270, 0, 22, '1,000')], heads), { item: '긴 품목 이름', qty: '3', amt: '1,000' }, 'splitCols: 글=가운데, 숫자=오른쪽 끝');
  eq([PT.num('1,234'), PT.num('-50,000'), PT.num('(500)'), PT.num('\\ 1,000'), PT.num('12,34'), PT.num('abc'), PT.num('2.5')], [1234, -50000, -500, 1000, null, null, 2.5], 'num: 쉼표·음수·괄호·원 기호');
}

// ── 6. 수양 틀 — 합성 쪽(연도 넘김·개인정보·합계 어긋남·차량 글) ──
function syPage(docDate, lines, tot) {
  const items = [];
  const put = (x, y, w, str) => items.push({ x, y, w, h: 8, str });
  put(250, 70, 70, '거래명세서');
  put(272, 94, 30, '등록번호'); put(330, 94, 47, '000-00-00000');
  put(272, 103, 17, '상 호'); put(330, 103, 30, '가짜개발'); put(420, 103, 17, '성 명');
  put(52, 123, 70, docDate);
  [[68, '일자', 15], [178, '품목', 15], [285, '차량번호', 29], [338, '수량', 15], [381, '단 가', 17]].forEach(([x, s, w]) => put(x, 177, w, s));
  put(436, 182, 29, '공급가액'); put(502, 182, 17, '세 액');
  lines.forEach((l, i) => { const y = 192 + i * 10; put(66, y, 19, l[0]); put(170, y, 40, l[1]); put(316 - l[2].length * 4, y, l[2].length * 4, l[2]); put(343, y, 4, l[3]); put(417 - l[4].length * 4, y, l[4].length * 4, l[4]); put(479 - l[5].length * 4, y, l[5].length * 4, l[5]); put(537 - l[6].length * 4, y, l[6].length * 4, l[6]); });
  const ty = 192 + lines.length * 10 + 10;
  put(178, ty, 15, '합계'); put(343, ty, 4, tot[0]); put(480 - tot[1].length * 4, ty, tot[1].length * 4, tot[1]); put(537 - tot[2].length * 4, ty, tot[2].length * 4, tot[2]);
  return [{ w: 595, h: 842, items }];
}
{
  const r = M.mapPages(syPage('2027 년 01 월 05 일', [['12/30', '덮개', '5288', '1', '100,000', '100,000', '10,000'], ['1/03', '레일', '80버5474', '1', '50,000', '50,000', '5,000']], ['2', '150,000', '15,000']));
  eq(r.rows.map((x) => x.date), ['2026-12-30', '2027-01-03'], '수양 합성: 문서 1월이면 12월 줄은 전년');
  eq(r.warn, [], '수양 합성: 경고 없음');
  const p = M.mapPages(syPage('2026 년 11 월 01 일', [['10/02', '연락 010-1234-5678', '5288', '1', '100,000', '100,000', '10,000'], ['10/03', '덮개', '12*34', '1', '50,000', '50,000', '5,000']], ['2', '150,000', '15,000']));
  eq([p.rows[0].item, p.rows[1].vraw], ['', ''], '수양 합성: 전화 꼴 품목·허용 밖 차량 글은 비움');
  const m = M.mapPages(syPage('2026 년 11 월 01 일', [['10/02', '덮개', '5288', '1', '100,000', '100,000', '10,000']], ['1', '120,000', '10,000']));
  ok(m.ok && m.check.sum_ok === false && m.warn.some((w) => /공급가액 줄 합/.test(w)), '수양 합성: 줄 합 ≠ 합계 줄이면 경고');
  const nd = M.mapPages(syPage('발행일 없음', [['10/02', '덮개', '5288', '1', '100,000', '100,000', '10,000']], ['1', '100,000', '10,000']));
  ok(nd.rows[0].date === '' && nd.warn.some((w) => /문서 날짜/.test(w)), '수양 합성: 문서 날짜 없으면 일자 비우고 경고');
  const other = syPage('2026 년 11 월 01 일', [], ['0', '0', '0']); other[0].items = other[0].items.filter((i) => i.str !== '차량번호');
  eq(M.mapPages(other).code, 'UNKNOWN_LAYOUT', '수양 합성: 머리 칸 모자라면(다른 업체 거래명세서) UNKNOWN_LAYOUT');
}

// ── 7. 오천 원장 — 합성 결함(잔액 어긋남) ──
{
  const pt = await PT.pdfText(fx('ochun_ledger_fake.pdf'));
  const pages = JSON.parse(JSON.stringify(pt.pages));
  const last = pages[0].items.filter((i) => i.str === '27,000')[0];
  last.str = '28,000';
  const r = M.mapPages(pages);
  ok(r.ok && r.check.sum_ok === false && r.warn.some((w) => /잔액과 다름/.test(w)), '원장 결함: 잔액이 안 맞으면 경고');
  const pages2 = JSON.parse(JSON.stringify(pt.pages));
  pages2[0].items.filter((i) => i.str === '77,000')[0].str = '70,000';
  const r2 = M.mapPages(pages2);
  ok(r2.warn.some((w) => /매출 줄 합/.test(w)), '원장 결함: 매출 줄 합 ≠ 합계면 경고');
}

// ── 8. 오천 상세 — 합성 결함(줄 합계 어긋남) ──
{
  const pt = await PT.pdfText(fx('ochun_detail_fake.pdf'));
  const pages = JSON.parse(JSON.stringify(pt.pages));
  pages[0].items.filter((i) => i.str === '3,000')[0].str = '3,500';
  const r = M.mapPages(pages);
  ok(r.check.sum_ok === false && r.warn.some((w) => /합계금액과 다른 줄/.test(w)) && r.warn.some((w) => /부가세 줄 합/.test(w)), '상세 결함: 부가세 바뀌면 줄·합계 경고');
}

// ── 9. 그림 PDF → 쪽 그림(pdfPageImages, canvas 없이 pdfjs가 푼 그림) ──
{
  const r = await PT.pdfPageImages(fx('images_fake.pdf'));
  ok(r.ok && r.pages.length === 5, '쪽 그림: 5쪽');
  const px = (p, x, y) => Array.from(p.data.subarray((y * p.w + x) * 4, (y * p.w + x) * 4 + 4));
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  const [g, rgb, jpg, txt, pred] = r.pages;
  eq([g.w, g.h, g.data.length], [200, 100, 200 * 100 * 4], '쪽 그림 1: 회색 Flate — 가장 큰 그림(작은 녹색 그림 무시)·RGBA 길이');
  ok(near(px(g, 10, 50), [0, 0, 0, 255]) && near(px(g, 150, 50), [255, 255, 255, 255]), '쪽 그림 1: 왼쪽 검정·오른쪽 흰색');
  ok(rgb.w === 120 && rgb.h === 80 && near(px(rgb, 60, 40), [255, 0, 0, 255]), '쪽 그림 2: RGB Flate 빨강');
  ok(jpg.w === 160 && jpg.h === 120 && near(px(jpg, 80, 60), [0, 0, 255, 255]) && jpg.text === '가짜 OCR', '쪽 그림 3: JPEG 파랑 + 글자층 글');
  eq([txt.w, txt.h, txt.data, txt.text], [0, 0, null, '글자만 있는 쪽'], '쪽 그림 4: 그림 없는 쪽은 w0·h0·data null');
  ok(pred.w === 64 && near(px(pred, 5, 5), [0, 0, 0, 255]) && near(px(pred, 5, 25), [255, 255, 255, 255]), '쪽 그림 5: Flate + PNG 예측자 풀림');
  eq((await PT.pdfPageImages(fx('images_fake.pdf'), 4)).code, 'TOO_MANY_PAGES', '쪽 그림: maxPages 넘으면 TOO_MANY_PAGES');
  eq((await PT.pdfPageImages(Buffer.from('not pdf'))).code, 'NOT_PDF', '쪽 그림: 아닌 파일 NOT_PDF');
  const b1 = PT.toRGBA({ width: 9, height: 1, kind: 1, data: Uint8Array.from([0x80, 0x80]) });
  eq([b1.length, b1[0], b1[4], b1[32]], [36, 255, 0, 255], 'toRGBA: 1비트 회색(줄 바이트 맞춤, 1 = 흰색)');
  eq(PT.toRGBA({ width: 2, height: 2, kind: 2, data: new Uint8Array(3) }), null, 'toRGBA: 바이트 모자라면 null');
}

console.log('통과 ' + pass + ' · 실패 ' + fail);
if (fail) process.exit(1);
console.log('전 항목 통과');
