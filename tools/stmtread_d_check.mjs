// 29 판④ 원본 읽기 — 나누기(stmtread)·AI 판독(stmtvision) 시험. 실행: node tools/stmtread_d_check.mjs  (실패 시 exit 1)
// Claude 호출은 require 캐시에 가짜 _lib/claude.js를 넣어 대신한다(네트워크 없음). 시험 자료는 가짜 값(tools/fixtures/stmt29).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'netlify', 'functions', '_lib');
const FX = join(ROOT, 'tools', 'fixtures', 'stmt29');
let pass = 0, fail = 0;
function T(name, ok, info) { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' — ' + info : '')); } }

process.env.STMT_CORP_BN = '0000000001,0000000002';   // 가짜 받는 쪽(1 = 종운환경 자리, 2 = 다른 회사 자리)
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// ---- 가짜 Claude: 마지막 요청을 기억하고 정해 둔 글을 돌려줌
const claudePath = require.resolve(join(LIB, 'claude.js'));
const realClaude = require(claudePath);
const fake = { last: null, reply: '{}', throwErr: null };
require.cache[claudePath].exports = Object.assign({}, realClaude, {
  callApiStream: async function (key, body) { fake.last = body; if (fake.throwErr) throw fake.throwErr; return { content: [{ type: 'text', text: fake.reply }], usage: { input_tokens: 11, output_tokens: 7 } }; }
});
const V = require(join(LIB, 'stmtvision.js'));
const RD = require(join(LIB, 'stmtread.js'));

// ---- ① 꼴 알아보기
{
  const pdf = Buffer.from('%PDF-1.4\n...'), xls = Buffer.from('d0cf11e0a1b11ae1' + '00'.repeat(8), 'hex'), jpg = Buffer.from('ffd8ffe000104a46', 'hex'), png = Buffer.from('89504e470d0a1a0a', 'hex'), zip = Buffer.from('504b030414000000', 'hex');
  const nts = readFileSync(join(FX, 'a_nts_seed.html')), xml = readFileSync(join(FX, 'a_tax3.xml'));
  const html = Buffer.from('<html><body><table><tr><td>가짜</td></tr></table></body></html>'), txt = Buffer.from('그냥 글입니다 12345678');
  const got = [RD.sniff(pdf), RD.sniff(xls), RD.sniff(jpg), RD.sniff(png), RD.sniff(zip), RD.sniff(nts), RD.sniff(xml), RD.sniff(html), RD.sniff(txt), RD.sniff(Buffer.alloc(3))];
  T('① 꼴 알아보기: pdf·xls·image·image·xlsx·nts·xml·html·""·""', JSON.stringify(got) === JSON.stringify(['pdf', 'xls', 'image', 'image', 'xlsx', 'nts', 'xml', 'html', '', '']), JSON.stringify(got));
}
// ---- ② 마무리: 거래처 대조·받는 회사·그 달 밖 줄·공급자 번호 안 냄
{
  const ctx = { ym: '2026-10', vk: 'v01', vendor: { name: '스피드타이어', kind: 'tire', group: 'veh', hint: ['스피드타이어', '스피드'] } };
  const base = { ok: true, src: 'xml', vendor: { name: '가짜상사', bn: '0000000099' }, buyer_bn: '0000000002', ym_hint: '2026-10',
    rows: [{ date: '2026-10-03', item: 'a', kind: '' }, { date: '2026-09-30', item: 'b' }, { date: '', item: 'c' }], inv: null, carry: null, warn: ['원래 경고'] };
  const f = RD.finish(base, ctx);
  T('② 마무리: 다른 거래처(공급자 이름이 거래처 낱말과 안 맞음) 경고·vendor_mismatch · 받는 회사가 2번(다른 회사) 경고·buyer_other · 9월 줄 1개 뺌(경고) · 날짜 없는 줄은 둠 · 종류 빈칸 = 거래처 기본(tire) · 공급자 번호·buyer_bn 안 냄 · 원래 경고 이어 감',
    f.vendor_mismatch === true && f.buyer_other === true && f.rows.length === 2 && f.rows[0].kind === 'tire' && f.rows[1].item === 'c' && !('bn' in f.vendor) && !('buyer_bn' in f)
    && f.warn.some((w) => /다른 거래처/.test(w)) && f.warn.some((w) => /우리 회사가 아닌|다른 회사/.test(w)) && f.warn.some((w) => /밖 줄 1개/.test(w)) && f.warn.indexOf('원래 경고') >= 0, JSON.stringify(f));
  const g = RD.finish(Object.assign({}, base, { vendor: { name: '(주)스피드타이어 본점' }, buyer_bn: '0000000001' }), ctx);
  T('② 마무리: 공급자 이름에 거래처 낱말이 있으면 경고 없음 · 받는 쪽 1번(종운환경 자리)이면 경고 없음', !g.vendor_mismatch && !g.buyer_other && !g.warn.some((w) => /거래처 서류|받는 회사/.test(w)), JSON.stringify(g.warn));
}
// ---- ③ 글자로 읽히는 것: 보안 계산서 HTML(부품 A)·옛 엑셀(부품 B)은 바로 결과, 그림·모르는 HTML은 AI
{
  const ctx = { ym: '2026-10', vk: 'v09', vendor: { name: '현대상용서비스센터', kind: '', group: 'veh', hint: ['현대상용'] } };
  const r1 = await RD.readFile(readFileSync(join(FX, 'a_nts_seed.html')), 'a.html', ctx);
  T('③ 보안 계산서 HTML → 바로 결과(src nts · 계산서 inv 있음 · 받는 쪽 번호 안 냄)', r1.ok && !r1.ai && r1.result.src === 'nts' && !!r1.result.inv && !('buyer_bn' in r1.result), JSON.stringify(r1).slice(0, 300));
  const r2 = await RD.readFile(Buffer.from('ffd8ffe000104a46' + '00'.repeat(20), 'hex'), 'p.jpg', ctx);
  const r3 = await RD.readFile(Buffer.from('<html><table><tr><td>가짜 정비</td></tr></table></html>'), 'x.htm', ctx);
  const r4 = await RD.readFile(Buffer.from('504b030414000000' + '00'.repeat(20), 'hex'), 'x.xlsx', ctx);
  const r5 = await RD.readFile(Buffer.from('아무 글'), 'x.txt', ctx);
  T('③ 그림 = ai image · 모르는 HTML = ai html · xlsx = UNKNOWN_LAYOUT · 그 밖 = UNSUPPORTED_TYPE', r2.ok && r2.ai === 'image' && r3.ok && r3.ai === 'html' && !r4.ok && r4.code === 'UNKNOWN_LAYOUT' && !r5.ok && r5.code === 'UNSUPPORTED_TYPE', JSON.stringify([r2, r3, r4, r5]));
  const ctx3 = { ym: '2026-10', vk: 'v03', vendor: { name: '신일상사', kind: 'part', group: 'veh', hint: ['신일상사', '신일'] } };
  const r6 = await RD.readFile(readFileSync(join(FX, 'sinil_fake.xls')), 's.xls', ctx3);
  T('③ 옛 엑셀(신일 틀) → 바로 결과(src xls · 줄 있음 · how xlsx · 줄 금액 기준 basis 알림)', r6.ok && !r6.ai && r6.result.src === 'xls' && r6.result.rows.length > 0 && r6.result.rows.every((x) => x.how === 'xlsx') && (r6.result.basis === 'total' || r6.result.basis === 'supply'), JSON.stringify(r6).slice(0, 300));
}
// ---- ④ 가림 칸·계산서 쪽
{
  const W = 200, H = 280;
  const mk = (fill) => { const d = Buffer.alloc(W * H * 4); for (let p = 0; p < d.length; p += 4) { d[p] = fill[0]; d[p + 1] = fill[1]; d[p + 2] = fill[2]; d[p + 3] = 255; } return d; };
  const at = (d, x, y) => { const p = (y * W + x) * 4; return [d[p], d[p + 1], d[p + 2]]; };
  const r08 = V.maskRects('v08', 0, W, H), r06a = V.maskRects('v06', 0, W, H), r06b = V.maskRects('v06', 1, W, H), r05 = V.maskRects('v05', 0, W, H), r01l = V.maskRects('v01', 0, 400, 280);
  T('④ 가림 칸: 모든 쪽 머리·바닥 띠 2 · 포항모터스 +3(소유자·전화·공급자 칸) · 영남 첫 쪽만 이름 열 · 대송 띠만 · 스피드 가로 쪽은 가로 칸', r08.length === 5 && r06a.length === 3 && r06b.length === 2 && r05.length === 2 && r01l.length === 3 && r01l[2][0] === Math.floor(0.04 * 400) && r01l[2][1] === Math.floor(0.6 * 280), JSON.stringify([r08.length, r06a.length, r06b.length, r05.length, r01l]));
  const d = mk([10, 10, 10]); V.paintWhite(d, W, H, V.maskRects('v08', 0, W, H));
  const own = at(d, Math.floor(0.5 * W), Math.floor(0.135 * H)), plate = at(d, Math.floor(0.3 * W), Math.floor(0.115 * H)), sup = at(d, Math.floor(0.5 * W), Math.floor(0.19 * H)), table = at(d, Math.floor(0.5 * W), Math.floor(0.26 * H)), foot = at(d, 5, H - 2);
  T('④ 포항모터스 칠하기: 소유자 줄·공급자 칸·바닥 띠 = 흰색 · 차량번호 줄(11.5%)·표(26%) = 그대로', own[0] === 255 && sup[0] === 255 && foot[0] === 255 && plate[0] === 10 && table[0] === 10, JSON.stringify([own, plate, sup, table, foot]));
  const inv = mk([255, 255, 255]); for (let y = 10; y < 120; y++) for (let x = 5; x < 95; x++) { if (x % 6 === 0 || y % 9 === 0) { const p = (y * W + x) * 4; inv[p] = 230; inv[p + 1] = 60; inv[p + 2] = 90; } }
  for (let y = 10; y < 120; y++) for (let x = 105; x < 195; x++) { if (x % 6 === 0 || y % 9 === 0) { const p = (y * W + x) * 4; inv[p] = 40; inv[p + 1] = 90; inv[p + 2] = 200; } }
  const plain = mk([255, 255, 255]); for (let y = 30; y < 250; y += 7) for (let x = 20; x < 180; x++) { const p = (y * W + x) * 4; plain[p] = 0; plain[p + 1] = 0; plain[p + 2] = 0; }
  const redTxt = mk([255, 255, 255]); for (let y = 30; y < 250; y += 7) for (let x = 20; x < 60; x++) { const p = (y * W + x) * 4; redTxt[p] = 220; redTxt[p + 1] = 30; redTxt[p + 2] = 30; }
  T('④ 계산서 쪽 판정: 빨강·파랑 테두리 = 계산서 · 검은 표 = 아님 · 빨강 글만(영남 소계) = 아님 · 회색 스캔이라도 글자층 "전자세금계산서…승인번호" = 계산서',
    V.isInvoicePage(V.colorStats(inv, W, H), '') && !V.isInvoicePage(V.colorStats(plain, W, H), '') && !V.isInvoicePage(V.colorStats(redTxt, W, H), '') && V.isInvoicePage(V.colorStats(plain, W, H), '전자 세금계산서 승인번호'),
    JSON.stringify([V.colorStats(inv, W, H), V.colorStats(plain, W, H), V.colorStats(redTxt, W, H)]));
  const prep = await V.prepareImages('v08', [{ w: W, h: H, data: inv, text: '' }, { w: W, h: H, data: plain, text: '' }, { w: W, h: H, data: plain, text: '' }]);
  T('④ 쪽 준비: 계산서 쪽은 빼고(skipped invoice) 나머지 2쪽만 JPEG · 원본 그림 버퍼는 안 칠함(사본)', prep.images.length === 2 && prep.skipped.length === 1 && prep.skipped[0].why === 'invoice' && prep.images.every((x) => x.buf[0] === 0xff && x.buf[1] === 0xd8) && plain[(Math.floor(0.19 * H) * W + 100) * 4] === 255 && plain[(30 * W + 100) * 4] === 0,
    JSON.stringify({ n: prep.images.length, sk: prep.skipped }));
}
// ---- ⑤ AI 결과 걸러내기·지시문·호출
{
  const vendor = { name: '가온상사(요소수)', kind: 'urea', group: 'veh' };
  fake.reply = '설명 글 ```json\n' + JSON.stringify({ rows: [
    { date: '10/2', vraw: '6441호', item: '요소수 홍길동 010-1234-5678', qty: '13', unit: '1,500', amt: '17,727', vat: '1,773', note: '계좌 110-068-387914' },
    { date: '2026-09-30', vraw: '5474', item: '요소수', qty: 7, unit: 1500, amt: 9545, vat: 955, note: '' },
    { date: '2026.10.26', vraw: '49가2121', item: '요소수', qty: 8, unit: 1500, amt: 10909, vat: 1091, note: 'jongwoon@fake.test' },
    { date: '', vraw: '', item: '', qty: null, unit: null, amt: null, vat: null, note: '' },
    { date: '10/31', vraw: '', item: '9012345678901', qty: 1, unit: 100, amt: 100, vat: 10, note: '' }
  ], sum: { supply: '28,736', vat: 2874, total: 31610 }, carry: null, unread_pages: 1 }) + '\n```';
  const r = await V.readVision([{ buf: Buffer.from([0xff, 0xd8, 0xff]), w: 10, h: 10, i: 0 }], vendor, '2026-10', ['홍길동']);
  const rows = r.ok ? r.result.rows : [];
  const sent = fake.last || {}, content = (sent.messages && sent.messages[0] && sent.messages[0].content) || [];
  T('⑤ AI 판독: 모델 claude-opus-5-5 · 그림 1 + 지시문 · 지시문에 "사람 이름, 전화·팩스 번호, 계좌번호" 금지·소계 빼기·2026-10',
    r.ok && sent.model === 'claude-opus-5-5' && content.length === 2 && content[0].type === 'image' && /사람 이름, 전화·팩스 번호, 계좌번호/.test(content[1].text) && /소계·합계/.test(content[1].text) && /2026-10/.test(content[1].text), JSON.stringify({ ok: r.ok, model: sent.model, n: content.length }));
  T('⑤ 걸러내기: 이름·전화·계좌·메일 지움 · "10/2" → 2026-10-02 · "6441호" → 6441 · 9월 줄 뺌 · 빈 줄 뺌 · 13자리 숫자 품목 = 지우고 확인 필요 · 쉼표 숫자 → 수 · how vision · 종류 = 거래처 기본(urea)',
    rows.length === 3 && rows[0].item === '요소수' && rows[0].note === '계좌' && rows[0].date === '2026-10-02' && rows[0].vraw === '6441' && rows[0].unit === 1500 && rows[0].amt === 17727
    && rows[1].date === '2026-10-26' && rows[1].note === '' && rows[2].item === '' && /확인 필요/.test(rows[2].note) && rows.every((x) => x.how === 'vision' && x.kind === 'urea')
    && JSON.stringify(rows).indexOf('010-') < 0 && JSON.stringify(rows).indexOf('홍길동') < 0 && JSON.stringify(rows).indexOf('@') < 0, JSON.stringify(rows));
  T('⑤ 경고: 다른 달 줄 1개 · 읽지 못한 줄 1개 · 읽지 못한 쪽 1장 · 문서 합계 = sum(쉼표 숫자 → 수)', r.result.warn.some((w) => /다른 달 줄 1개/.test(w)) && r.result.warn.some((w) => /읽지 못한 줄 1개/.test(w)) && r.result.warn.some((w) => /읽지 못한 쪽 1장/.test(w)) && r.result.sum.supply === 28736 && r.usage.in === 11,
    JSON.stringify(r.result.warn));
  fake.reply = '죄송합니다 읽을 수 없습니다';
  const r2 = await V.readVision([{ buf: Buffer.from([0xff, 0xd8]), w: 1, h: 1, i: 0 }], vendor, '2026-10', []);
  fake.throwErr = new realClaude.ApiError('TIMEOUT', 'x', false);
  const r3 = await V.readVision([{ buf: Buffer.from([0xff, 0xd8]), w: 1, h: 1, i: 0 }], vendor, '2026-10', []);
  fake.throwErr = null;
  const r4 = await V.readVision([], vendor, '2026-10', []);
  T('⑤ 실패: JSON 없음 = NO_JSON · 시간 초과 = CLAUDE_TIMEOUT · 쪽 없음 = NO_PAGES', !r2.ok && r2.code === 'NO_JSON' && !r3.ok && r3.code === 'CLAUDE_TIMEOUT' && !r4.ok && r4.code === 'NO_PAGES', JSON.stringify([r2, r3, r4]));
  fake.reply = JSON.stringify({ rows: [{ date: '10/5', vraw: '06너6441', item: '정비 공임', qty: 1, unit: 50000, amt: 50000, vat: 5000, note: '' }], sum: null, carry: null });
  const t = await RD.readByAi(Buffer.from('<html><body><table><tr><td>정비 홍길동 010-9999-8888</td><td>50,000</td></tr></table></body></html>'), 'html', { ym: '2026-10', vk: 'v08', vendor: { name: '포항모터스', kind: '', group: 'veh', hint: ['포항모터스'] }, names: ['홍길동'] });
  const sentTxt = JSON.stringify(fake.last);
  T('⑤ 모르는 HTML → 글로 판독(그림 아님) · 보내는 글에서 이름·전화 미리 지움 · 결과 1줄', t.ok && t.result.rows.length === 1 && sentTxt.indexOf('홍길동') < 0 && sentTxt.indexOf('010-9999') < 0 && sentTxt.indexOf('"type":"image"') < 0, JSON.stringify(t).slice(0, 200));
}
// ---- ⑥ 결함 사본(코드 한 줄 바꾼 사본을 메모리에서 돌려 시험이 깨지는지)
{
  const srcV = readFileSync(join(LIB, 'stmtvision.js'), 'utf8');
  const Mod = require('node:module');
  const load = (src) => { const m = new Mod(join(LIB, 'stmtvision.js'), null); m.filename = join(LIB, 'stmtvision.js'); m.paths = Mod._nodeModulePaths(LIB); m._compile(src, m.filename); return m.exports; };
  const muts = [
    ['가림 칸 안 칠함', srcV.replace('rgba[p] = 255; rgba[p + 1] = 255;', 'rgba[p] = rgba[p]; rgba[p + 1] = 255;')],
    ['계산서 쪽 안 뺌', srcV.replace("if (isInvoicePage(colorStats(rgba, p.w, p.h), p.text)) { skipped.push({ i: i, why: 'invoice' }); continue; }", '')],
    ['다른 달 줄 안 뺌', srcV.replace("if (date && date.slice(0, 7) !== ym) { other++; return; }", '')],
    ['회원 이름 안 지움', srcV.replace("(names || []).forEach(function (n) { if (n && n.length >= 2) t = t.split(n).join(' '); });", '')]
  ];
  const W = 100, H = 100;
  const mkp = () => { const d = Buffer.alloc(W * H * 4); d.fill(0); for (let p = 3; p < d.length; p += 4) d[p] = 255; return d; };
  const invP = () => { const d = Buffer.alloc(W * H * 4, 255); for (let y = 5; y < 60; y++) for (let x = 2; x < 98; x++) if (x % 4 === 0) { const p = (y * W + x) * 4; if (x < 50) { d[p] = 230; d[p + 1] = 50; d[p + 2] = 80; } else { d[p] = 30; d[p + 1] = 80; d[p + 2] = 210; } } return d; };
  const results = [];
  for (const [name, src] of muts) {
    if (src === srcV) { results.push(name + ':바꿀 줄 못 찾음'); continue; }
    const M = load(src);
    let caught = false;
    const d = mkp(); M.paintWhite(d, W, H, M.maskRects('v08', 0, W, H)); if (d[(Math.floor(0.19 * H) * W + 50) * 4] !== 255) caught = true;
    const pr = await M.prepareImages('v05', [{ w: W, h: H, data: invP(), text: '' }]); if (pr.images.length !== 0) caught = true;
    const tr = M.toResult({ rows: [{ date: '2026-09-01', item: 'x', amt: 1 }, { date: '2026-10-01', item: '홍길동 부품', amt: 2 }] }, { ym: '2026-10', vendor: {}, names: ['홍길동'] });
    if (tr.rows.length !== 1 || tr.rows[0].item !== '부품') caught = true;
    results.push(name + ':' + (caught ? '잡힘' : '못 잡음'));
  }
  T('⑥ 결함 사본 4개(가림 안 칠함·계산서 쪽 안 뺌·다른 달 줄 안 뺌·회원 이름 안 지움) = 모두 잡힘', results.every((x) => /잡힘$/.test(x)), results.join(' | '));
}
console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n원본 읽기(나누기·AI 판독) 시험 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
