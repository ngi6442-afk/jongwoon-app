// 체크 29 판④ 부품 A 시험 — _lib/stmtnts.js(SEED·보안메일 풀기) + _lib/taxxml.js(전자세금계산서 XML·readNts)
// 실행: node tools/stmtread_a_check.mjs   (실패 시 종료 코드 1, 다 맞으면 '전 항목 통과')
// 절: ① SEED 공개 시험값(RFC 4269 부록 B = KISA 표준) ② CBC·PKCS7 ③ 가짜 fixture 보안 HTML 풀기 ④ XML·readNts 공통 꼴
//     ⑤ 거절 코드 ⑥ XML 파서 ⑦ 결함 사본(핵심 줄 하나 바꾼 사본이 실패해야 함) ⑧ 실물 확인(있을 때만 — 건수·일치만 찍음, 값 출력 없음)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import Module from 'module';
import { build, FAKE } from './fixtures/stmt29/make_a_fixtures.mjs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'netlify', 'functions', '_lib');
const FIX = join(ROOT, 'tools', 'fixtures', 'stmt29');

// 사본 모듈을 메모리에서 읽기(바꾼 글로) — 상대 require('./stmt')가 되도록 같은 폴더 이름으로 컴파일
function loadFrom(file, src, overrides) {
  const fn = join(LIB, file);
  const m = new Module(fn, null);
  m.filename = fn;
  m.paths = Module._nodeModulePaths(LIB);
  const realReq = m.require.bind(m);
  m.require = function (id) { return overrides && overrides[id] ? overrides[id] : realReq(id); };
  m._compile(src, fn);
  return m.exports;
}
function mutate(file, from, to) {
  const src = fs.readFileSync(join(LIB, file), 'utf8');
  if (src.includes('\r\n')) { from = from.replace(/\n/g, '\r\n'); to = to.replace(/\n/g, '\r\n'); }   // 작업 폴더 줄끝이 CRLF여도
  if (src.indexOf(from) < 0) throw new Error('결함 사본: 바꿀 줄을 못 찾음 — ' + file + ' / ' + from);
  return src.replace(from, to);
}

// 시험 묶음 — N = stmtnts 모듈, T = taxxml 모듈. 실패 목록을 돌려준다(quiet면 찍지 않음)
function suite(N, T, quiet) {
  const bad = [];
  let n = 0;
  const ok = (cond, name) => { n++; if (!cond) { bad.push(name); if (!quiet) console.log('  실패:', name); } };
  const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name);
  const H = (s) => Buffer.from(s, 'hex');
  const run = (name, f) => { try { f(); } catch (e) { ok(false, name + ' — 예외 ' + (e && e.message)); } };

  // ① SEED 공개 시험값(RFC 4269 부록 B — 키·평문·암호문)
  run('SEED 시험값', () => {
    const V = [
      ['00000000000000000000000000000000', '000102030405060708090a0b0c0d0e0f', '5ebac6e0054e166819aff1cc6d346cdb'],
      ['000102030405060708090a0b0c0d0e0f', '00000000000000000000000000000000', 'c11f22f20140505084483597e4370f43'],
      ['4706480851e61be85d74bfb3fd956185', '83a2f8a288641fb9a4e9a5cc2f131c7d', 'ee54d13ebcae706d226bc3142cd40d4a'],
      ['28dbc3bc49ffd87dcfa509b11d422be7', 'b41e6be2eba84a148e2eed84593c5ec7', '9b9b7bfcd1813cb95d0b3618f40f5122']
    ];
    V.forEach(([k, p, c], i) => {
      eq(N.seedEncryptBlock(H(k), H(p)).toString('hex'), c, 'SEED 암호 B.' + (i + 1));
      eq(N.seedDecryptBlock(H(k), H(c)).toString('hex'), p, 'SEED 복호 B.' + (i + 1));
    });
  });
  // ② CBC·PKCS7 — 길이 0~40 왕복, 패딩 틀림 거절
  run('CBC', () => {
    const key = H('0f0e0d0c0b0a09080706050403020100');
    let all = true;
    for (let L = 0; L <= 40; L++) {
      const p = Buffer.alloc(L); for (let i = 0; i < L; i++) p[i] = (i * 37 + L) & 0xff;
      const c = N.seedCbcEncrypt(key, p);
      if (c.length !== (Math.floor(L / 16) + 1) * 16 || !N.seedCbcDecrypt(key, c).equals(p)) all = false;
      const a = N.aesCbcEncrypt(key, p);
      if (!N.aesCbcDecrypt(key, a).equals(p)) all = false;
    }
    ok(all, 'CBC 왕복 0~40바이트(SEED·AES)');
    // CBC 사슬: 같은 블록 두 번이 다른 암호문
    const c2 = N.seedCbcEncrypt(key, Buffer.alloc(32, 7));
    ok(!c2.subarray(0, 16).equals(c2.subarray(16, 32)), 'CBC 사슬(같은 평문 블록 → 다른 암호문)');
    let threw = false;
    try { N.seedCbcDecrypt(H('00000000000000000000000000000001'), N.seedCbcEncrypt(key, Buffer.from('가짜 글'))); } catch (e) { threw = true; }
    ok(threw, '틀린 키 → 패딩 거절');
  });

  // ③ 가짜 보안 HTML 풀기
  const fx = build();
  run('보안 HTML 풀기', () => {
    const r = N.decryptNts(fx['a_nts_seed.html'], ['000-00-00099', '000-00-00001']);
    ok(r.ok && r.alg === 'SEED' && r.bnIdx === 1, 'SEED 보안 HTML — 후보 2번째가 맞음');
    ok(r.ok && r.files.length === 1 && r.files[0].name.endsWith('.xml') && r.files[0].buf.equals(fx['a_tax3.xml']), 'SEED 첨부 = 원래 XML 바이트');
    ok(r.ok && r.body.indexOf('가짜 계산서 보기 화면') >= 0, 'SEED 본문 글');
    ok(r.ok && !('bn' in r) && JSON.stringify(Object.keys(r)) === JSON.stringify(['ok', 'alg', 'bnIdx', 'body', 'files']), '결과에 번호 값 없음');
    const a = N.decryptNts(fx['a_nts_aes.html'], [FAKE.buyerA, FAKE.buyerB]);
    ok(a.ok && a.alg === 'AES' && a.bnIdx === 1 && a.files[0].buf.equals(fx['a_tax1.xml']), 'AES 보안 HTML — 첨부 일치');
    const h = N.parseHeader(N.hiddenValues(fx['a_nts_seed.html'].toString('latin1')).idCriHeader);
    ok(h && h.ContentEncryptionAlgorithm === '2' && h.AttachFileCount === '1' && !!h.HashKey && !!h.HintKey && !!h.AttachFileTagID && !!h.AttachFileSize, '머리 키 이름(실물과 같은 꼴)');
  });
  // ④ XML·readNts → 공통 꼴
  run('readNts SEED', () => {
    const r = T.readNts(fx['a_nts_seed.html'], [FAKE.buyerB, FAKE.buyerA]);
    ok(r.ok && r.src === 'nts' && r.bnIdx === 1, 'readNts src nts·후보 순번');
    if (!r.ok) return;
    eq(r.vendor, { name: '가짜상용서비스', bn: FAKE.vendor3 }, '공급자 상호·번호');
    eq(r.buyer_bn, FAKE.buyerA, '받는 쪽 번호');
    eq(r.ym_hint, '2026-10', 'ym_hint');
    eq(r.inv, { date: '2026-10-30', supply: 1001500, vat: 100150, total: 1101650 }, 'inv(천 단위 쉼표 포함 금액)');
    eq(r.carry, null, 'carry null');
    eq(r.rows.length, 3, '줄 3');
    eq(r.rows[0], { date: '2026-10-05', vraw: '80가1234', item: '가짜 타이어', kind: '', qty: 4, unit: 200000, amt: 800000, vat: 80000, note: '315/80R22.5 · 80가 1234 앞바퀴', how: 'file' }, '줄 1(규격·비고·차량)');
    eq(r.rows[1], { date: '2026-10-12', vraw: '', item: '가짜 요소수', kind: '', qty: 2.5, unit: 600, amt: 1500, vat: 150, note: '', how: 'file' }, '줄 2(소수 수량)');
    eq([r.rows[2].note, r.rows[2].amt], ['', 200000], '줄 3 — 전화 꼴 비고는 비움');
    ok(r.warn.length === 1 && /전화/.test(r.warn[0]), '경고 = 비운 곳 1건만(검산은 맞음)');
    ok(!/0000000001|0000000013/.test(JSON.stringify(r.rows) + JSON.stringify(r.warn)), '줄·경고에 번호 없음');
  });
  run('readNts AES·XML 직접', () => {
    const r = T.readNts(fx['a_nts_aes.html'], [FAKE.buyerB]);
    ok(r.ok && r.bnIdx === 0 && r.buyer_bn === FAKE.buyerB, 'AES readNts');
    if (r.ok) {
      eq(r.vendor.name, '가짜&타이어 <시험>', '엔티티 풀린 상호');
      eq(r.rows.map((x) => [x.date, x.item, x.qty, x.unit, x.amt, x.vat]), [['2026-10-31', '10월분 정비 & 부품', null, null, 123450, 12345]], 'CDATA·접두어 줄');
      eq(r.inv, { date: '2026-10-31', supply: 123450, vat: 12345, total: 135795 }, 'AES inv');
      eq(r.warn, [], 'AES 경고 없음');
    }
    const x = T.readTaxXml(fx['a_tax3.xml']);
    ok(x.ok && x.src === 'xml' && x.rows.length === 3 && !('bnIdx' in x), 'readTaxXml src xml');
    // 검산 어긋남 → 경고
    const y = T.readTaxXml(fx['a_tax3.xml'].toString('utf8').replace('<GrandTotalAmount>1101650<', '<GrandTotalAmount>1101651<').replace('<InvoiceAmount>1500<', '<InvoiceAmount>1600<'));
    ok(y.ok && y.warn.some((w) => /합계와 다릅니다/.test(w)) && y.warn.some((w) => /품목 공급가액 합/.test(w)), '검산 어긋남 경고');
    const z = T.readTaxXml(fx['a_tax3.xml'].toString('utf8').replace('<TypeCode>0101</TypeCode>', '<TypeCode>0201</TypeCode>'));
    ok(z.ok && z.warn.some((w) => /수정/.test(w)), '수정 세금계산서 경고');
  });
  // ⑤ 거절 코드
  run('거절', () => {
    const code = (r) => (r && !r.ok ? r.code : 'OK');
    eq(code(N.decryptNts(fx['a_nts_seed.html'], ['0000000099'])), 'NO_KEY', '번호 안 맞음 NO_KEY');
    eq(code(N.decryptNts(fx['a_nts_seed.html'], [])), 'NO_KEY', '후보 없음 NO_KEY');
    eq(code(N.decryptNts(Buffer.from('<html><body>보통 메일</body></html>'), [FAKE.buyerA])), 'NO_HEADER', '보통 HTML NO_HEADER');
    eq(code(N.decryptNts(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), [FAKE.buyerA])), 'TOO_BIG', '8MB 넘음 TOO_BIG');
    eq(code(N.decryptNts('글', [FAKE.buyerA])), 'BAD_INPUT', 'Buffer 아님');
    const aria = N.encryptNtsForTest({ algNo: 3, bn: FAKE.buyerA, files: [] });
    eq(code(N.decryptNts(aria, [FAKE.buyerA])), 'ALG_UNSUPPORTED', 'ARIA(3) ALG_UNSUPPORTED');
    const six = N.encryptNtsForTest({ alg: 'SEED', bn: FAKE.buyerA, files: [0, 1, 2, 3, 4, 5].map((i) => ({ name: 'f' + i + '.txt', buf: Buffer.from('x' + i) })) });
    eq(code(N.decryptNts(six, [FAKE.buyerA])), 'TOO_MANY_FILES', '첨부 6개 TOO_MANY_FILES');
    const two = N.decryptNts(N.encryptNtsForTest({ alg: 'SEED', bn: FAKE.buyerA, files: [{ name: 'a.txt', buf: Buffer.from('하나') }, { name: 'b.xml', buf: fx['a_tax1.xml'] }] }), [FAKE.buyerA]);
    ok(two.ok && two.files.length === 2 && two.files[0].name === 'a.txt' && two.files[1].buf.equals(fx['a_tax1.xml']), '첨부 2개(이름 | 구분) 풀기');
    const noXml = T.readNts(N.encryptNtsForTest({ alg: 'SEED', bn: FAKE.buyerA, files: [{ name: 'a.pdf', buf: Buffer.from('%PDF-1.4 가짜') }] }), [FAKE.buyerA]);
    eq(code(noXml), 'NO_XML', 'XML 첨부 없음 NO_XML');
    eq(code(T.readTaxXml('<Other/>')), 'NOT_TAXINVOICE', '다른 XML NOT_TAXINVOICE');
    eq(code(T.readTaxXml('<TaxInvoice><a></b></TaxInvoice>')), 'BAD_XML', '짝 안 맞는 태그 BAD_XML');
  });
  // ⑥ XML 파서
  run('XML 파서', () => {
    const p = T.parseXml('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "펑">]><p:r xmlns:p="u" a=\'1&amp;2\' p:b="x>y"><!-- 주석 --><c>&lt;&#65;&#x42;&quot;&apos;&x;</c><c><![CDATA[<raw>&amp;]]></c><d/></p:r>');
    ok(p.ok, 'XML 파서 읽힘');
    if (p.ok) {
      eq(p.root.name, 'r', '접두어 버림');
      eq([p.root.attrs.a, p.root.attrs.b], ['1&2', 'x>y'], '속성(엔티티·따옴표 안 >)');
      eq(p.root.kids.map((k) => k.name), ['c', 'c', 'd'], '자식·빈 태그');
      eq(p.root.kids[0].text, '<AB"\'&x;', '엔티티(사용자 정의는 풀지 않음)');
      eq(p.root.kids[1].text, '<raw>&amp;', 'CDATA 그대로');
    }
    let deep = ''; for (let i = 0; i < 70; i++) deep += '<a>'; for (let i = 0; i < 70; i++) deep += '</a>';
    eq(T.parseXml(deep).code, 'TOO_DEEP', '깊이 상한');
  });
  return { n, bad };
}

let fail = 0;
const N0 = require(join(LIB, 'stmtnts.js')), T0 = require(join(LIB, 'taxxml.js'));
console.log('절 ①~⑥ 본 모듈');
const main = suite(N0, T0, false);
console.log('  ' + (main.n - main.bad.length) + '/' + main.n + ' 통과');
if (main.bad.length) fail++;

// fixture 파일이 생성기와 같은지(손으로 바꾼 자료 막기)
const fx = build();
for (const [k, v] of Object.entries(fx)) {
  const p = join(FIX, k);
  if (!fs.existsSync(p) || !fs.readFileSync(p).equals(v)) { console.log('  실패: fixture 파일이 생성기와 다름 —', k, '(node tools/fixtures/stmt29/make_a_fixtures.mjs)'); fail++; }
}

// ⑦ 결함 사본 — 하나라도 시험을 통과하면 시험이 약한 것
console.log('절 ⑦ 결함 사본');
const MUT = [
  ['XOR 상수 0x6b→0x6a', 'stmtnts.js', 'const XOR = 0x6b;', 'const XOR = 0x6a;'],
  ['SEED 라운드 키 B-D → B+D', 'stmtnts.js', 'rk[2 * i + 1] = G((B - D + KC[i]) >>> 0);', 'rk[2 * i + 1] = G((B + D + KC[i]) >>> 0);'],
  ['SEED 키 회전 >>> 8 → >>> 7', 'stmtnts.js', 'A = ((A >>> 8) | (B << 24)) >>> 0;', 'A = ((A >>> 7) | (B << 25)) >>> 0;'],
  ['SEED F 함수 덧셈 하나 빠짐', 'stmtnts.js', 'T0 = (T0 + T1) >>> 0;\n    const nR0', 'T0 = T1;\n    const nR0'],
  ['HashKey 비교 hex → base64', 'stmtnts.js', "got.toLowerCase() === k.toString('hex')", "got === k.toString('base64')"],
  ['XML 날짜 월·일 뒤바뀜', 'taxxml.js', "const d = m[1] + '-' + m[2] + '-' + m[3];", "const d = m[1] + '-' + m[3] + '-' + m[2];"],
  ['XML &amp; 안 풂', 'taxxml.js', "if (e === 'amp') return '&';", "if (e === 'amp') return '&amp;';"],
  ['줄 세액 칸 잘못 읽음', 'taxxml.js', "vat: won(txt(it, 'TotalTax/CalculatedAmount'))", "vat: won(txt(it, 'CalculatedAmount'))"]
];
for (const [name, file, from, to] of MUT) {
  let r;
  try {
    const src = mutate(file, from, to);
    let Nm = N0, Tm = T0;
    if (file === 'stmtnts.js') { Nm = loadFrom(file, src); Tm = loadFrom('taxxml.js', fs.readFileSync(join(LIB, 'taxxml.js'), 'utf8'), { './stmtnts': Nm }); }
    else Tm = loadFrom(file, src);
    r = suite(Nm, Tm, true);
  } catch (e) { console.log('  실패: 결함 사본 준비 못 함 —', name, e.message); fail++; continue; }
  if (r.bad.length) console.log('  잡힘:', name, '(' + r.bad.length + '건 실패)');
  else { console.log('  실패: 결함 사본이 시험을 통과함 —', name); fail++; }
}

// ⑧ 실물 확인(있을 때만) — 번호·이름·금액 값은 찍지 않는다. 건수·일치만.
const REAL = 'C:/Users/user/OneDrive/work/27_월말명세서';
const IDX = join(ROOT, 'index.html');
if (fs.existsSync(REAL) && fs.existsSync(IDX) && !process.argv.includes('--no-real')) {
  console.log('절 ⑧ 실물(값 출력 없음)');
  const idx = fs.readFileSync(IDX, 'utf8');
  const bns = new Set();
  for (const m of idx.matchAll(/\d{3}-\d{2}-\d{5}/g)) {
    if (idx.slice(Math.max(0, m.index - 200), m.index + 200).includes('종운')) bns.add(m[0].replace(/-/g, ''));
  }
  const files = fs.readdirSync(REAL).filter((x) => /^NTS_eTaxInvoice.*\.html$/.test(x)).sort();
  const counts = [];
  let opened = 0, matched = 0, rowSum = 0, rowOk = 0, buyerHit = 0, dateOk = 0;
  for (const f of files) {
    const r = T0.readNts(fs.readFileSync(join(REAL, f)), [...bns]);
    if (!r.ok) { counts.push('X(' + r.code + ')'); continue; }
    opened++;
    counts.push(r.rows.length);
    if (r.inv && r.inv.supply + r.inv.vat === r.inv.total) matched++;
    if (r.inv && r.rows.reduce((a, x) => a + (x.amt || 0), 0) === r.inv.supply) rowSum++;
    if (r.inv && r.rows.every((x) => x.vat != null) && r.rows.reduce((a, x) => a + x.vat, 0) === r.inv.vat) rowOk++;
    if (bns.has(r.buyer_bn)) buyerHit++;
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.inv && r.inv.date) && r.rows.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date))) dateOk++;
  }
  console.log('  후보 ' + bns.size + '개 · 파일 ' + files.length + ' · 열림 ' + opened + ' · 줄 수 ' + counts.slice().sort().join('·') +
    ' · 공급+세액=합계 ' + matched + ' · 줄 공급가 합=공급 ' + rowSum + ' · 줄 세액 합=세액 ' + rowOk + ' · 받는 쪽 번호=후보 ' + buyerHit + ' · 날짜 꼴 ' + dateOk);
  if (opened !== files.length || matched !== opened || rowSum !== opened || buyerHit !== opened) { console.log('  실패: 실물 확인'); fail++; }
}

if (fail) { console.log('실패 ' + fail + '묶음'); process.exit(1); }
console.log('전 항목 통과');
