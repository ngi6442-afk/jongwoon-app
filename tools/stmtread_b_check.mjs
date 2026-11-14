// 29 판④ 부품 B 시험 — _lib/xlsbiff.js(OLE2/CFB + BIFF8 읽개) · _lib/stmtsinil.js(신일 부품납품 대금청구서 → 공통 꼴).
// 실행: node tools/stmtread_b_check.mjs   → 실패 하나라도 있으면 exit 1, 모두 맞으면 '전 항목 통과'.
// 시험 자료: tools/fixtures/stmt29/sinil_fake.xls(가짜 값 — 생성: node tools/fixtures/stmt29/make_sinil_fake.mjs, 엑셀 필요).
// 결함 사본: 원본 코드에서 핵심 줄 하나씩 바꾼 사본을 임시 폴더에 두고 같은 시험을 돌려 '실패해야 통과'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'netlify', 'functions', '_lib');
const FIX = path.join(ROOT, 'tools', 'fixtures', 'stmt29', 'sinil_fake.xls');
const FIXBUF = fs.readFileSync(FIX);

// 생성 스크립트와 같은 긴 글(SST CONTINUE 확인용)
const LONG_KO = '가나다라마바사아자차카타파하'.repeat(429).slice(0, 6000);
const LONG_EN = 'ABCDEFGHIJ'.repeat(900);

const EXPECT_ROWS = [
  ['2026-10-02', '1111', '오일필터', 2, 15000, 30000, '100001AA001 · 포항모터스'],
  ['2026-10-02', '1111', '에어필터(참조)', 1, 42000, 42000, '포항모터스'],
  ['2026-10-05', '3333', '브레이크 패드', 1, 88000, 88000, '200002BB002 · 차번호 변경 2222 · 포항모터스'],
  ['2026-10-09', '경북12가3456', '벨트', 1, 25000, 25000, '300003CC003 · 포항모터스 PHMTS26PO123456'],
  ['2026-10-09', '경북12가3456', '텐셔너', 2, 31500, 63000, '300004CC004 · 포항모터스 PHMTS26PO123456'],
  ['2026-10-09', '경북12가3456', '그리스', 1.5, 4000, 6000, '300005CC005 · 포항모터스 PHMTS26PO123456'],
  ['2026-10-20', '4444', '타이어 밸브', 4, 2500, 10000, '400006DD006 · 포항모터스 1축/2번'],
  ['2026-10-31', '5555', '전구', 3, 1200, 3600, '500007EE007 · 포항모터'],
  ['2026-10-31', '5555', '퓨즈', 10, 330, 3300, '500008EE008 · 포항모터'],
].map(([date, vraw, item, qty, unit, amt, note]) => ({ date, vraw, item, kind: 'part', qty, unit, amt, vat: null, note, how: 'xlsx' }));
const EXPECT_WARN = ['부품번호가 긴 숫자라 메모에서 뺌: 1줄', '개인정보 꼴 숫자를 줄 글에서 뺌: 1칸'];
const FAKE_PRIVATE = ['○○○', '000-000-0000', '가짜운수', '0000-[', '1234567890', '9876543210', 'X000000'];

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 시험 묶음 — mods = { xls, sinil, stmt }. 반환: 실패 목록
function suite(mods) {
  const { xls, sinil, stmt } = mods;
  const fails = [];
  const t = (name, fn) => { let ok; try { ok = fn(); } catch (e) { ok = false; name += ' (예외: ' + String(e && e.message).slice(0, 60) + ')'; } if (!ok) fails.push(name); };

  // ---- 1. 읽개(xlsbiff) ----
  const x = xls.readXls(FIXBUF);
  t('readXls ok·시트 2개 이름', () => x.ok && eq(x.sheets.map((s) => s.name), ['Sheet1', '메모시트']));
  const c = x.ok ? x.sheets[0].cells : [];
  const findCell = (pred) => { for (const row of c) for (const v of row || []) if (pred(v)) return v; return undefined; };
  t('SST CONTINUE — 한글 6000자 그대로', () => findCell((v) => typeof v === 'string' && v.length === 6000) === LONG_KO);
  t('SST CONTINUE — 영문 압축 9000자 그대로', () => findCell((v) => typeof v === 'string' && v.length === 9000) === LONG_EN);
  t('CONTINUE 뒤 문자열도 맞음', () => findCell((v) => typeof v === 'string' && v.startsWith('끝글자')) === '끝글자' + LONG_KO.slice(0, 50));
  t('MULRK 정수 7,8,9,-3', () => c.some((row) => row && eq(row.slice(34, 38), [7, 8, 9, -3])));
  t('RK×100·실수 0.01,123456.78,3.14159', () => c.some((row) => row && eq(row.slice(34, 37), [0.01, 123456.78, 3.14159])));
  t('FORMULA 문자열 결과(STRING)', () => findCell((v) => v === '수식글') === '수식글');
  t('FORMULA 숫자 결과(총합계 칸 27)', () => c.some((row) => row && row[0] === 2 && row[27] === 88000));
  t('둘째 시트 값', () => x.ok && x.sheets[1].cells[2][1] === 42 && x.sheets[1].cells[1][0] === '메모');
  t('날짜 글 그대로', () => c.some((row) => row && row[29] === '2026-10-31'));
  // 시험 자료가 실제로 CONTINUE·MULRK·FORMULA 레코드를 품고 있는지(자료가 바뀌어 시험이 헛돌지 않게)
  t('자료에 SST CONTINUE·MULRK·FORMULA 레코드', () => {
    const ws = xls.readCfb(FIXBUF).streams.Workbook; const seen = new Set(); let o = 0, prev = 0;
    while (o + 4 <= ws.length) { const ty = ws.readUInt16LE(o), n = ws.readUInt16LE(o + 2); if (ty === 0x3c && prev === 0xfc) seen.add('cont'); if (ty !== 0x3c) prev = ty; seen.add(ty); o += 4 + n; }
    return seen.has('cont') && seen.has(0xbd) && seen.has(0x06) && seen.has(0x207);
  });
  // 손으로 만든 SST 조각: 글자 중간에서 CONTINUE로 갈리며 압축(Latin-1) → UTF-16으로 바뀌는 꼴 + 리치 런·확장 자료가 조각을 넘는 꼴
  t('SST 조각 경계에서 압축↔UTF-16 전환·런 건너뛰기', () => {
    const s1 = Buffer.concat([Buffer.from([2, 0, 0, 0, 2, 0, 0, 0]), Buffer.from([5, 0, 0x08, 1, 0]), Buffer.from('AB', 'latin1')]);   // 'AB…'(5자, 리치 런 1개) 앞 2자
    const s2 = Buffer.concat([Buffer.from([1]), Buffer.from('가나다', 'utf16le'), Buffer.from([0, 0])]);   // 깃발 1 + 남은 3자 + 런 앞 2바이트
    const s3 = Buffer.concat([Buffer.from([0, 0]), Buffer.from([3, 0, 0]), Buffer.from('xyz', 'latin1')]);   // 런 뒤 2바이트 + 다음 글 'xyz'
    return eq(xls.readSst([s1, s2, s3]), ['AB가나다', 'xyz']);
  });
  t('rkValue: 정수·×100·실수', () => xls.rkValue((123 << 2) | 2) === 123 && xls.rkValue((12345 << 2) | 3) === 123.45 && xls.rkValue(0x3ff00000) === 1 && xls.rkValue(((-5 << 2) | 2) >>> 0) === -5);
  t('Buffer 아님 → BAD_INPUT', () => xls.readXls('abc').code === 'BAD_INPUT');
  t('OLE 서명 아님 → NOT_OLE', () => xls.readXls(Buffer.alloc(1024, 7)).code === 'NOT_OLE');
  t('8MB 넘음 → TOO_BIG', () => xls.readXls(Buffer.alloc(8 * 1024 * 1024 + 1)).code === 'TOO_BIG');
  t('잘린 파일 → 예외 없이 실패', () => { const r = xls.readXls(FIXBUF.subarray(0, 2048)); return r.ok === false && typeof r.code === 'string'; });
  t('FAT 순환 → 예외·멈춤 없이 실패', () => {
    const b = Buffer.from(FIXBUF); const shift = b.readUInt16LE(0x1e); const fat0 = b.readUInt32LE(0x4c);
    const dir = b.readUInt32LE(0x30); b.writeUInt32LE(dir, (fat0 + 1) * (1 << shift) + dir * 4);   // 디렉터리 섹터가 자기 자신을 가리키게
    const r = xls.readXls(b); return r.ok === false;
  });
  t('셀 상한 → TOO_MANY_CELLS', () => { const keep = xls.LIM.cells; xls.LIM.cells = 50; try { return xls.readXls(FIXBUF).code === 'TOO_MANY_CELLS'; } finally { xls.LIM.cells = keep; } });
  t('시트 상한 → TOO_MANY_SHEETS', () => { const keep = xls.LIM.sheets; xls.LIM.sheets = 1; try { return xls.readXls(FIXBUF).code === 'TOO_MANY_SHEETS'; } finally { xls.LIM.sheets = keep; } });
  t('BIFF8 아닌 OLE(Workbook 없음) → NO_WORKBOOK', () => {
    const b = Buffer.from(FIXBUF); const shift = b.readUInt16LE(0x1e); const o = (b.readUInt32LE(0x30) + 1) * (1 << shift);
    for (let k = 0; k < 4; k++) { const e = o + k * 128; if (b.toString('utf16le', e, e + 16) === 'Workbook') b.write('Xorkbook', e, 'utf16le'); }
    return xls.readXls(b).code === 'NO_WORKBOOK';
  });

  // ---- 2. 신일 틀(stmtsinil) ----
  const sheets0 = () => (x.ok ? x.sheets : []);
  const r = sinil.parseSinil(FIXBUF);
  t('readSinilXls = parseSinil(stmtread.js가 부르는 이름)', () => sinil.readSinilXls === sinil.parseSinil);
  t('xls지만 다른 양식 → UNKNOWN_LAYOUT', () => { const s = clone(sheets0()); s[0].cells[0][0] = '거래명세서'; for (const row of s[0].cells) if (row && typeof row[0] === 'string' && row[0].includes('대금청구서')) row[0] = '거래명세서'; return sinil.sinilFromSheets(s).code === 'UNKNOWN_LAYOUT'; });
  t('parseSinil ok·공통 꼴 머리', () => r.ok === true && r.src === 'xls' && r.inv === null && r.carry === null && r.buyer_bn === '' && eq(r.vendor, { name: '가짜부품상사', bn: '' }) && r.ym_hint === '2026-10');
  t('줄 = 부품 하나 — 9줄 그대로(쪽 넘김 포함)', () => eq(r.rows, EXPECT_ROWS));
  t('meta 총금액·합·건·쪽', () => eq(r.meta, { total: 270900, sum: 270900, total_basis: 'same', cases: 5, pages: 2 }));
  t('warn 정확히', () => eq(r.warn, EXPECT_WARN));
  t('개인정보 꼴 없음(piiScan 통과)', () => stmt.piiScan(r.rows.map((z) => [z.item, z.note, z.vraw])) === '' && stmt.piiScan([r.vendor.name]) === '');
  t('대표자·전화·업체 칸 값이 출력에 없음', () => { const s = JSON.stringify(r); return FAKE_PRIVATE.every((p) => !s.includes(p)); });
  t('vraw 꼴 /^[가-힣A-Za-z0-9 ()-]+$/', () => r.rows.every((z) => z.vraw === '' || /^[가-힣A-Za-z0-9 ()-]+$/.test(z.vraw)));
  t('stmt.cleanRows가 줄을 받음', () => { const k = stmt.cleanRows(r.rows.map((z) => ({ date: z.date, vraw: z.vraw, item: z.item, kind: z.kind, qty: z.qty, unit: z.unit, amt: z.amt, vat: z.vat, note: z.note, how: z.how })), r.ym_hint); return !!k.rows && k.rows.length === 9; });

  const sheets = x.ok ? x.sheets : [];
  const headTotal = (sh, v) => { for (const row of sh[0].cells) if (row && row[0] === '총금액') row[2] = v; };
  t('총금액 = 합×1.1 → total_basis x1.1·warn 없음', () => { const s = clone(sheets); headTotal(s, '297,990'); const k = sinil.sinilFromSheets(s); return k.meta.total_basis === 'x1.1' && eq(k.warn, EXPECT_WARN); });
  t('총금액 어긋남 → warn', () => { const s = clone(sheets); headTotal(s, '300,000'); const k = sinil.sinilFromSheets(s); return k.meta.total_basis === null && k.warn.some((w) => w.startsWith('총금액이 부품 합')); });
  t('쪽마다 총금액 다름 → warn', () => { const s = clone(sheets); let n = 0; for (const row of s[0].cells) if (row && row[0] === '총금액' && n++ === 1) row[2] = '1'; return sinil.sinilFromSheets(s).warn.includes('쪽마다 총금액이 다름'); });
  t('건 금액 ≠ 부품 합 → warn(SEQ)', () => { const s = clone(sheets); for (const row of s[0].cells) if (row && row[0] === 2) { row[24] = 87000; row[27] = 87000; } return sinil.sinilFromSheets(s).warn.some((w) => w.startsWith('건 금액 ≠ 그 건 부품 합: 1건(SEQ 2)')); });
  t('항목 수 ≠ 부품 줄 → warn', () => { const s = clone(sheets); for (const row of s[0].cells) if (row && row[0] === 5) row[4] = 3; return sinil.sinilFromSheets(s).warn.includes('항목 수 ≠ 부품 줄 수: 1건'); });
  t('열이 밀려도 칸 이름으로 같은 결과', () => { const s = clone(sheets); s[0].cells = s[0].cells.map((row) => ['', ''].concat(row || [])); const k = sinil.sinilFromSheets(s); return eq(k.rows, EXPECT_ROWS) && eq(k.meta, r.meta); });
  t('신일 틀 아님(짧은 표) → UNKNOWN_LAYOUT', () => sinil.sinilFromSheets([{ name: 'a', cells: [['거래명세서'], ['품목', '금액']] }]).code === 'UNKNOWN_LAYOUT');
  t('특이사항에 전화 꼴 → 그 글에서 빠짐', () => { const s = clone(sheets); for (const row of s[0].cells) if (row && row[0] === 4) row[32] = '4444호 010-1234-5678 연락'; const k = sinil.sinilFromSheets(s); return k.rows.every((z) => !/010/.test(z.note)) && stmt.piiScan(k.rows.map((z) => [z.item, z.note, z.vraw])) === ''; });
  t('splitNote 꼴', () => eq(sinil.splitNote('1234호 포항 모터스'), { vraw: '1234', rest: ['포항모터스'] })
    && eq(sinil.splitNote('123나4567호 포항모터스'), { vraw: '123나4567', rest: ['포항모터스'] })
    && eq(sinil.splitNote('포항 모터스포5678PHMTS26PO123456'), { vraw: '5678', rest: ['포항모터스포 PHMTS26PO123456'] })
    && eq(sinil.splitNote(''), { vraw: '', rest: [] }));
  return fails;
}

// ---- 본 시험 ----
const req = createRequire(import.meta.url);
const real = { xls: req(path.join(LIB, 'xlsbiff.js')), sinil: req(path.join(LIB, 'stmtsinil.js')), stmt: req(path.join(LIB, 'stmt.js')) };
const fails = suite(real);
let bad = fails.length;
fails.forEach((f) => console.log('실패:', f));
console.log('본 시험:', fails.length ? fails.length + '건 실패' : '통과');

// ---- 결함 사본(핵심 줄 하나씩 바꿈 → 시험이 실패해야 함) ----
const MUTANTS = [
  ['xlsbiff.js', 'CONTINUE 첫 바이트 깃발 무시(앞 깃발 유지)', 'high = this.segs[this.i][this.o++] & 1;', 'this.o++;'],
  ['xlsbiff.js', 'CONTINUE 첫 바이트 안 건너뜀', 'high = this.segs[this.i][this.o++] & 1;', 'high = high;'],
  ['xlsbiff.js', 'RK ×100 깃발 무시', 'return (rk & 1) ? v / 100 : v;', 'return v;'],
  ['xlsbiff.js', 'MULRK 열 번호 안 늘림', 'ok = put(row, col++, rkValue', 'ok = put(row, col, rkValue'],
  ['stmtsinil.js', '건 부품 합 안 셈', 'if (cur) { cur.sum += a; cur.n++; }', 'if (cur) { cur.n++; }'],
  ['stmtsinil.js', 'L값 안 뗌', 'if (tok.length >= 2 && tok[0].length <= 2) pn = tok.slice(1).join(\' \');', ''],
  ['stmtsinil.js', '긴 숫자 부품번호를 메모에 둠', 'if (pn && piiScan(pn)) { pn = \'\'; pnDrop++; }', ''],
  ['stmtsinil.js', '부품 줄이 다음 쪽 앞에서 끊김(쪽 머리에서 건 초기화)', '{ cm = headerMap(row, CASE_NAMES); continue; }', '{ cm = headerMap(row, CASE_NAMES); cur = null; continue; }'],
];
let caught = 0;
for (const [file, label, from, to] of MUTANTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmtb-'));
  try {
    for (const f of ['xlsbiff.js', 'stmtsinil.js', 'stmt.js']) {
      let src = fs.readFileSync(path.join(LIB, f), 'utf8');
      if (f === file) {
        if (!src.includes(from)) { console.log('결함 사본 준비 실패(원문 줄 없음):', label); bad++; continue; }
        src = src.replace(from, to);
      }
      fs.writeFileSync(path.join(dir, f), src);
    }
    const mreq = createRequire(path.join(dir, 'x.js'));
    let mf;
    try { mf = suite({ xls: mreq('./xlsbiff.js'), sinil: mreq('./stmtsinil.js'), stmt: mreq('./stmt.js') }); } catch (e) { mf = ['로드 예외']; }
    if (mf.length) { caught++; console.log('결함 사본 잡음:', label, '—', mf.length + '건 실패'); }
    else { bad++; console.log('결함 사본 못 잡음:', label); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log('결함 사본:', caught + '/' + MUTANTS.length, '잡음');
if (bad) { console.log('실패 있음'); process.exit(1); }
console.log('전 항목 통과');
