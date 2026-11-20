// 29 판⑦ 메일 에이전트 시험 — 가짜 메일함·가짜 저장소로 _lib/stmtmail.run()을 돌린다(네트워크·메일 계정 없음). 실행: node tools/stmtmail_check.mjs  (실패 시 exit 1)
// 시험 자료는 가짜 값(tools/fixtures/stmt29). 메일 주소·이름·제목은 모두 지어낸 것.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'netlify', 'functions');
const LIB = join(FN, '_lib');
const FX = join(ROOT, 'tools', 'fixtures', 'stmt29');
let pass = 0, fail = 0;
function T(name, ok, info) { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' — ' + info : '')); } }

process.env.STMT_CORP_BN = '0000000001,0000000002';
const M = require(join(LIB, 'stmtmail.js'));
const RD = require(join(LIB, 'stmtread.js'));
const S = require(join(LIB, 'stmt.js'));
const VEND = S.seedVendors();

// ---- ① 귀속 월(20일부터 그 달 · 19일까지 앞달 · KST)
{
  const got = [M.ymOf(Date.parse('2026-12-03T09:00:00+09:00')), M.ymOf(Date.parse('2026-11-25T09:00:00+09:00')), M.ymOf(Date.parse('2027-01-05T09:00:00+09:00')), M.ymOf(Date.parse('2026-11-19T16:00:00Z')), M.ymOf(Date.parse('2026-11-19T14:00:00Z'))];
  T('① 귀속 월: 12/3→11월 · 11/25→11월 · 1/5→전년 12월 · UTC 11/19 16시(=KST 11/20 01시)→11월 · UTC 11/19 14시(=KST 11/19 23시)→10월', JSON.stringify(got) === JSON.stringify(['2026-11', '2026-11', '2026-12', '2026-11', '2026-10']), JSON.stringify(got));
}
// ---- ② 첨부 파트 고르기
{
  const bs = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
    { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: '10월 거래명세서.pdf' }, encoding: 'base64', size: 4000 },
    { part: '3', type: 'image/png', parameters: { name: 'logo.png' }, encoding: 'base64', size: 400 },
    { part: '4', type: 'text/plain', dispositionParameters: { filename: 'memo.txt' } },
    { part: '5', type: 'image/gif', disposition: 'inline' },
    { part: '6', type: 'application/vnd.ms-excel', parameters: { name: 'C:\\temp\\종운환경.xls' }, encoding: '7bit', size: 900 } ] };
  const a = M.attParts(bs);
  T('② 첨부 파트: pdf·png(이름 있는 것)·xls만 · 본문·txt·이름 없는 그림 뺌 · 경로 떼고 이름만 · base64 크기는 3/4로 어림', JSON.stringify(a) === JSON.stringify([{ part: '2', name: '10월 거래명세서.pdf', est: 3000 }, { part: '3', name: 'logo.png', est: 300 }, { part: '6', name: '종운환경.xls', est: 900 }]), JSON.stringify(a));
  T('② 명세처럼 보이는 이름·제목', M.looksStmt('NTS_eTaxInvoice_1.html') && M.looksStmt('11월분 청구') && M.looksStmt('거래명세서') && !M.looksStmt('견적서.pdf 안녕하세요') && !M.looksStmt('logo.png'));
  T('② 도메인만 · 주소 해시 20자(대소문자 같음)', M.domOf('Kim@Vendor-A.co.kr') === 'vendor-a.co.kr' && M.domOf('x') === '' && M.senderHash('A@b.kr') === M.senderHash(' a@B.kr ') && /^[a-f0-9]{20}$/.test(M.senderHash('a@b.kr')));
}
// ---- 가짜 저장소·메일함
function mkStore() { return { name: '', m: new Map() }; }
const io0 = { blobGet: async (st, k) => ({ ok: true, data: st.m.has(k) ? JSON.parse(st.m.get(k)) : null }), blobSet: async (st, k, v) => { st.m.set(k, JSON.stringify(v)); return { ok: true }; },
  blobList: async (st, p) => ({ ok: true, keys: Array.from(st.m.keys()).filter((k) => k.indexOf(p) === 0) }), blobDelete: async (st, k) => { st.m.delete(k); return { ok: true }; } };
function mkBox(msgs, files) {
  const box = { calls: { list: 0, get: 0 }, msgs: msgs, files: files };
  box.list = async function (since) { box.calls.list++; box.since = since; if (box.err) throw box.err; return box.msgs.filter((m) => m.at >= since.getTime()); };
  box.get = async function (uid, part) { box.calls.get++; return box.files[uid + ':' + part]; };
  return box;
}
const suyang = readFileSync(join(FX, 'suyang_fake.pdf')), unknown = readFileSync(join(FX, 'unknown_fake.pdf')), images = readFileSync(join(FX, 'images_fake.pdf'));
const AT = Date.parse('2026-12-02T10:00:00+09:00'), OLD = Date.parse('2026-11-05T10:00:00+09:00');
const MSGS = [
  { uid: 1, key: 'k1', at: AT, from: { addr: 'boss@suyang.test', name: '김가짜' }, subject: '11월 명세', atts: [{ part: '2', name: '수양개발 명세.pdf', est: suyang.length }] },
  { uid: 2, key: 'k2', at: AT + 1, from: { addr: 'hello@shop.test', name: '광고' }, subject: '안녕하세요', atts: [{ part: '2', name: '견적서.pdf', est: unknown.length }] },
  { uid: 3, key: 'k3', at: AT + 2, from: { addr: 'who@nowhere.test', name: '이가짜' }, subject: '자료', atts: [{ part: '2', name: '11월 거래명세서.pdf', est: unknown.length }] },
  { uid: 4, key: 'k4', at: AT + 3, from: { addr: 'scan@learned.test', name: '박가짜' }, subject: '스캔', atts: [{ part: '2', name: 'scan.pdf', est: images.length }] },
  { uid: 5, key: 'k5', at: OLD, from: { addr: 'boss@suyang.test', name: '김가짜' }, subject: '10월 명세', atts: [{ part: '2', name: '종운 10월.pdf', est: suyang.length }] },
  { uid: 6, key: 'k6', at: AT + 4, from: { addr: 'boss@suyang.test', name: '김가짜' }, subject: '다시 보냄', atts: [{ part: '2', name: '수양개발 명세(재).pdf', est: suyang.length }] },
  { uid: 7, key: 'k7', at: AT + 5, from: { addr: 'big@x.test', name: '' }, subject: '명세서', atts: [{ part: '2', name: '큰 명세서.pdf', est: 9000000 }] },
];
const FILES = { '1:2': suyang, '2:2': unknown, '3:2': unknown, '4:2': images, '5:2': suyang, '6:2': suyang, '7:2': Buffer.alloc(1) };
let aiCalls = 0;
const realAi = RD.readByAi;
RD.readByAi = async function (buf, mode, ctx) { aiCalls++; return { ok: true, result: { src: 'vision', rows: [{ date: '2026-11-03', item: '가짜 품목', amt: 1000, vat: 100 }], warn: [], vendor: { name: ctx.vendor.name } }, usage: { in: 5, out: 3 } }; };
function mkIo(st, fst, box, over) {
  const audits = [], use = [];
  return Object.assign({}, io0, { st: st, fst: fst, mailbox: box, cfg: VEND, names: async () => ['김가짜'], usage: async (ym, r) => { use.push(ym); }, audit: async (op, id, t) => { audits.push(op + ' ' + id + ' ' + t); },
    now: () => Date.parse('2026-12-03T07:00:00+09:00'), budget: { total: 1e9, ai: 1e9 }, audits: audits, use: use }, over || {});
}
// ---- ③ 한 번 돌기
const st = mkStore(), fst = mkStore();
await io0.blobSet(st, M.SENDERS, { map: { [M.senderHash('scan@learned.test')]: { vk: 'v10', n: 1 } } });
const box = mkBox(MSGS, FILES), io = mkIo(st, fst, box);
const sum = await M.run(io);
const drops = Array.from(st.m.keys()).filter((k) => k.indexOf('stmtdrop:') === 0).map((k) => JSON.parse(st.m.get(k)));
const byName = (n) => drops.filter((d) => d.name === n)[0];
{
  const since = box.since && box.since.toISOString();
  T('③ 볼 기간 = 쿠팡 본문 시작일(11/1 KST)과 40일 전 중 늦은 쪽(판⑨ — 첨부는 11/20 전 것을 따로 거름)', since === new Date(Date.parse('2026-11-01T00:00:00+09:00')).toISOString(), since);
  T('③ 요약: 메일 6통(10월 것 뺌) · 새 원본 3 · 읽음 2(AI 1) · 고르기 1 · 같은 파일 1 · 건너뜀 2(명세 아님·너무 큼)', sum.ok && sum.msgs === 6 && sum.added === 3 && sum.read === 2 && sum.ai === 1 && sum.nov === 1 && sum.dup === 1 && sum.skip === 2 && sum.fail === 0, JSON.stringify(sum));
  const a = byName('수양개발 명세.pdf');
  T('③ 수양 메일 = 파일 이름으로 거래처(v02) · 바로 읽음 · 11월 목록(가짜 명세는 10월 날짜라 줄은 다른 달 경고로) · 넣은 이 = 메일 봇 · 원본 첨부 남김', a && a.vk === 'v02' && a.how === 'name' && a.state === 'read' && a.warn > 0 && a.ym === '2026-11' && a.by === M.BOT && fst.m.has('stmtfile:' + a.id), a && JSON.stringify({ vk: a.vk, how: a.how, st: a.state, n: a.n, ym: a.ym }));
  const c = byName('11월 거래명세서.pdf');
  T('③ 모르는 보낸 사람 + 명세처럼 보이는 이름 = 거래처 고르기(novendor) · 도메인만 표시', c && c.state === 'novendor' && !c.vk && c.mail && c.mail.dom === 'nowhere.test' && /^[a-f0-9]{20}$/.test(c.mail.fh), c && JSON.stringify(c.mail));
  const d = byName('scan.pdf');
  T('③ 사람이 고른 적 있는 보낸 사람(해시) = 그 거래처(v10 철탑) · 그림 PDF는 AI로 바로 읽음 · 사용량 기록', d && d.vk === 'v10' && d.how === 'mail' && d.state === 'read' && d.src === 'vision' && aiCalls === 1 && io.use.length === 1, d && JSON.stringify({ vk: d.vk, how: d.how, st: d.state }));
  T('③ 명세 아닌 메일(견적서·안녕하세요)·10월 메일·너무 큰 첨부는 저장 안 함 · 너무 큰 첨부는 내려받지도 않음', !byName('견적서.pdf') && !byName('종운 10월.pdf') && !byName('큰 명세서.pdf') && box.calls.get === 5, 'get=' + box.calls.get);
  const all = Array.from(st.m.values()).concat(Array.from(fst.m.keys())).join('\n') + io.audits.join('\n');
  const bare = all.replace(/"data":"[^"]*"/g, '');
  T('③ 저장·감사 어디에도 메일 주소(앞부분)·보낸 이 이름·제목이 없음(보낸 쪽 도메인만)', !/@|boss|scan@|who@|hello@|김가짜|이가짜|박가짜|안녕하세요|11월 명세|다시 보냄/.test(bare) && /"dom":"suyang\.test"/.test(bare), (bare.match(/@[^"]{0,20}|boss|김가짜|이가짜|박가짜|안녕하세요/) || [''])[0]);
  T('③ 감사 기록 3줄(새 원본마다)', io.audits.length === 3 && io.audits.every((t) => /^명세서원본 2026-11:/.test(t)), JSON.stringify(io.audits));
}
// ---- ④ 다시 돌기 = 멱등(처리한 첨부는 내려받지 않음) · 사람이 지운 원본도 다시 안 들어옴
{
  const a = byName('수양개발 명세.pdf');
  st.m.delete('stmtdrop:2026-11:' + a.id); fst.m.delete('stmtfile:' + a.id);
  const box2 = mkBox(MSGS, FILES), io2 = mkIo(st, fst, box2);
  const s2 = await M.run(io2);
  const n2 = Array.from(st.m.keys()).filter((k) => k.indexOf('stmtdrop:') === 0).length;
  T('④ 다시 돌기: 새 원본 0 · 내려받기 0 · 지운 원본 안 돌아옴', s2.ok && s2.added === 0 && box2.calls.get === 0 && n2 === 2, JSON.stringify(s2) + ' get=' + box2.calls.get + ' n=' + n2);
}
// ---- ⑤ AI 시간이 모자라면 배경 판독 맡김(맡긴 이 = 메일 봇) · 전체 시간이 모자라면 남김(다음 실행)
{
  const s3 = mkStore(), f3 = mkStore();
  await io0.blobSet(s3, M.SENDERS, { map: { [M.senderHash('scan@learned.test')]: { vk: 'v10', n: 1 } } });
  const before = aiCalls;
  const r = await M.run(mkIo(s3, f3, mkBox([MSGS[3]], FILES), { budget: { total: 1e9, ai: -1 } }));
  const d = Array.from(s3.m.keys()).filter((k) => k.indexOf('stmtdrop:') === 0).map((k) => JSON.parse(s3.m.get(k)))[0];
  const job = d && f3.m.get('stmtsrc:' + d.job);
  T('⑤ AI 시간 모자람: 읽는 중(reading) + 배경 판독 맡김(bid 메일 봇·첨부 키·목록 줄) · AI 안 부름', d && d.state === 'reading' && job && JSON.parse(job).bid === M.BOT && JSON.parse(job).file === 'stmtfile:' + d.id && JSON.parse(job).drop.id === d.id && aiCalls === before && r.read === 0, d && d.state);
  const s4 = mkStore(), f4 = mkStore();
  const r4 = await M.run(mkIo(s4, f4, mkBox(MSGS, FILES), { budget: { total: -1, ai: 1e9 } }));
  T('⑤ 전체 시간 모자람: 아무것도 안 넣고 남김(처리 표시도 안 함 → 다음 실행에)', r4.added === 0 && r4.left > 0 && !s4.m.has(M.SEEN), JSON.stringify(r4));
  const bg = readFileSync(join(FN, 'gw-stmt-read-background.js'), 'utf8');
  T('⑤ 배경 판독 함수가 메일 봇이 맡긴 판독을 수행 권한 누구나 부를 수 있게 함', /src\.data\.bid !== '__stmtmail__'/.test(bg));
}
// ---- ⑥ 보낸 사람 기억
{
  let d = M.learnSender(null, 'f1', 'v02');
  d = M.learnSender(d, 'f1', 'v02');
  T('⑥ 같은 거래처를 두 번 고름 = n 2', d.map.f1.vk === 'v02' && d.map.f1.n === 2);
  d = M.learnSender(d, 'f1', 'v03');
  T('⑥ 다른 거래처를 고름 = 여럿(빈 값) — 다시는 보낸 사람으로 정하지 않음', d.map.f1.vk === '' && d.map.f1.multi === 1);
  const s5 = mkStore(), f5 = mkStore();
  await io0.blobSet(s5, M.SENDERS, d);
  const r5 = await M.run(mkIo(s5, f5, mkBox([Object.assign({}, MSGS[2], { from: { addr: 'x', name: '' } })], FILES), {}));
  T('⑥ (정상 흐름) 기억 없는 보낸 사람 = 고르기', r5.nov === 1);
  const gs = readFileSync(join(FN, 'gw-stmt.js'), 'utf8');
  T('⑥ gw-stmt 거래처 고르기(stmt_drop_set)가 메일 원본이면 보낸 사람을 기억', /MAIL\.learnSender\(sg\.data, e\.mail\.fh, v\.vk\)/.test(gs) && /mail: e\.mail \? \{ at: Number\(e\.mail\.at\) \|\| 0, dom: String\(e\.mail\.dom \|\| ''\) \}/.test(gs));
}
// ---- ⑦ 메일 서버 오류·계정 없음
{
  const b = mkBox([], {}); b.err = Object.assign(new Error('Command failed'), { authenticationFailed: true });
  const r = await M.run(mkIo(mkStore(), mkStore(), b));
  T('⑦ 로그인 거부 = ok false · MAIL_LOGIN_FAILED', r.ok === false && r.code === 'MAIL_LOGIN_FAILED', JSON.stringify(r));
  T('⑦ 오류 이름: 주소 못 찾음·시간 초과·연결 거부·그 밖', M.errCode({ code: 'ENOTFOUND' }) === 'MAIL_HOST_NOT_FOUND' && M.errCode({ code: 'ETIMEDOUT' }) === 'MAIL_TIMEOUT' && M.errCode({ code: 'ECONNREFUSED' }) === 'MAIL_CONNECT_FAILED' && M.errCode(new Error('x')) === 'MAIL_FAILED');
  T('⑦ 계정 환경변수: 둘 다 있어야 · 기본 다음 메일 993', M.mailEnv({}) === null && M.mailEnv({ STMT_MAIL_USER: 'a' }) === null && JSON.stringify(M.mailEnv({ STMT_MAIL_USER: ' a ', STMT_MAIL_PASS: 'p' })) === JSON.stringify({ user: 'a', pass: 'p', host: 'imap.daum.net', port: 993, boxes: '' }));
}
// ---- ⑧ 묶음·설정: imapflow는 워커만 · 2.10.0 고정 · 예약 07:00 · 수동 킥 · 읽기 전용 열기
{
  const ml = readFileSync(join(LIB, 'stmtmail.js'), 'utf8'), im = readFileSync(join(LIB, 'stmtimap.js'), 'utf8'), wk = readFileSync(join(FN, 'gw-stmtmail-run-background.js'), 'utf8');
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8'), kick = readFileSync(join(FN, 'gw-cron-kick.js'), 'utf8');
  T('⑧ imapflow는 stmtimap.js만 부름(gw-stmt 묶음에 안 들어감)', !/imapflow/.test(ml.replace(/\/\/.*$/gm, '')) && /require\('imapflow'\)/.test(im) && /require\('\.\/_lib\/stmtimap'\)/.test(wk) && !/stmtimap/.test(readFileSync(join(FN, 'gw-stmt.js'), 'utf8')));
  T('⑧ 메일함은 읽기 전용으로 엶(readOnly) · 메일 지우기·표시 바꾸기 명령 없음', /mailboxOpen\(box, \{ readOnly: true \}\)/.test(im) && (im.match(/mailboxOpen\(/g) || []).length === 1 &&!/messageDelete|messageFlagsAdd|messageFlagsSet|messageMove|append\(/.test(im + ml));
  T('⑧ imapflow 2.10.0 정확히 고정', pj.dependencies.imapflow === '2.10.0');
  T('⑧ 예약 = 매일 UTC 22:00(KST 07:00) · 워커는 imapflow를 묶지 않고 실음', /\[functions\."gw-stmtmail-cron"\]\s*\n\s*schedule = "0 22 \* \* \*"/.test(toml) && /\[functions\."gw-stmtmail-run-background"\]\s*\n\s*external_node_modules = \["imapflow"\]/.test(toml));
  T('⑧ 수동 킥 target stmtmail', /target !== 'stmtmail'/.test(kick) && /'\.\/gw-stmtmail-cron'/.test(kick));
  T('⑧ 워커는 내부 토큰(__stmtmail__)만 · 겹침 잠금 · 끝에 요약(stmt:mail:last)', /v\.payload\.mid !== M\.BOT/.test(wk) && /stmt:mail:lock/.test(wk) && /blobSet\(st, M\.LAST, sum\)/.test(wk));
}
// ---- ⑨ 29 판⑨(PM 11/20): 폴더 3곳 · 쿠팡 주문 본문(가짜 본문 — 실물 쿠팡 메일 꼴: 주문 표·결제 정보·받는 사람 칸)
const CP = require(join(LIB, 'stmtcoupang.js'));
function cpHtml(o) {
  o = o || {};
  const items = o.items || [['가짜 생수 2L, 6개', '12,000원', '2', '24,000원', '쿠팡(주)'], ['가짜 작업장갑 10켤레', '9,900원', '1', '9,900원', '가짜상사']];
  return Buffer.from('<html><head><style>td{}</style></head><body><div>나*짜님, 쿠팡에서 주문하신 구매내역을 안내드립니다.</div>'
    + '<table><thead><tr><th>구매 상세내역</th><th>쿠팡가</th><th>수량</th><th>구매금액</th><th>판매자</th></tr></thead><tbody>'
    + items.map((r) => '<tr><td><span>' + r[0] + '</span></td><td>' + r[1] + '</td><td>' + r[2] + '</td><td><strong>' + r[3] + '</strong></td><td>' + r[4] + '</td></tr>').join('')
    + '</tbody></table><table><tr><td><div>결제 정보</div><table role="presentation"><tr><td>상품 가격</td><td>' + (o.goods || '33,900원') + '</td></tr>'
    + (o.disc ? '<tr><td>할인금액</td><td>' + o.disc + '</td></tr>' : '') + '<tr><td>배송비</td><td>' + (o.ship || '0원') + '</td></tr></table>'
    + '<table role="presentation"><tr><td>가짜은행 99988877766 / 무통장입금</td><td>' + (o.total || '33,900원') + '</td></tr><tr><td>총 결제금액</td><td>' + (o.total || '33,900원') + '</td></tr></table></td></tr>'
    + '<tr><td><div>받으시는 분</div><table><tr><td>받으시는 분</td><td>유*가짜</td></tr><tr><td>연락처</td><td>+8210****1234 010-9999-8888</td></tr><tr><td>주소</td><td>[37800] 가짜시 가짜로 12</td></tr></table></td></tr></table>'
    + '<p>쿠팡㈜ 사업자등록번호: 120-88-00000 coupang.com</p></body></html>', 'utf8');
}
{
  T('⑨ 폴더: 기본 = 받은편지함·청구서함·청구서 · env 쉼표(빈칸 뺌·8개까지)', JSON.stringify(M.mailBoxes('')) === JSON.stringify(['INBOX', '청구서함', '청구서']) && JSON.stringify(M.mailBoxes(' INBOX , 거래처 ,,')) === JSON.stringify(['INBOX', '거래처']) && M.mailBoxes('a,b,c,d,e,f,g,h,i').length === 8
    && JSON.stringify(M.mailEnv({ STMT_MAIL_USER: 'a', STMT_MAIL_PASS: 'p', STMT_MAIL_BOXES: 'INBOX,청구서' }).boxes) === JSON.stringify('INBOX,청구서'));
  T('⑨ 쿠팡 주문 메일 알아보기: 보낸 도메인 coupang.com(하위 포함)·제목 "주문하신 내역" · 멤버십·약관·다른 곳 = 아님', CP.isOrderMail('e.coupang.com', '[쿠팡] 나*운님 주문하신 내역을 확인해주세요.') && CP.isOrderMail('coupang.com', '주문하신 내역') && !CP.isOrderMail('coupang.com', '[쿠팡] 와우 멤버십 월회비가 결제되었습니다.') && !CP.isOrderMail('coupangpay.com', '주문하신 내역') && !CP.isOrderMail('fakecoupang.com.evil.test', '주문하신 내역'));
  const bp = M.bodyPart({ type: 'multipart/alternative', childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'text/html', encoding: 'base64', size: 400 }] }), bp1 = M.bodyPart({ type: 'text/html', encoding: 'quoted-printable', size: 900 });
  T('⑨ 본문 HTML 파트: 여러 파트면 text/html 파트 번호 · 한 파트면 "1" · base64 크기 3/4', bp && bp.part === '2' && bp.est === 300 && bp1 && bp1.part === '1' && bp1.est === 900 && M.bodyPart({ type: 'text/plain' }) === null, JSON.stringify([bp, bp1]));
  const raw = cpHtml({ items: [['가짜 생수 2L, 6개', '12,000원', '2', '24,000원', '쿠팡(주)'], ['가짜 작업장갑 10켤레', '9,900원', '1', '9,900원', '가짜상사']], goods: '33,900원', disc: '-1,000원', ship: '3,000원', total: '35,900원' });
  const at = Date.parse('2026-11-15T10:00:00+09:00');
  const oh = CP.orderHtml(raw, at), ohs = oh.toString('utf8');
  T('⑨ 남기는 원본 = 주문 표·결제 금액만 · 받는 사람·연락처·주소·계좌·쿠팡 사업자번호 없음 · 제목에 주문일', CP.isCoupangOrder(raw) && CP.isCoupangOrder(oh) && /<title>쿠팡 주문 2026-11-15<\/title>/.test(ohs) && /가짜 생수 2L/.test(ohs) && /총 결제금액/.test(ohs) && !/유\*가짜|8888|1234|가짜시|37800|99988877766|가짜은행|120-88/.test(ohs), ohs.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  const r = CP.readOrder(oh, '');
  const J = (x) => JSON.stringify(x);
  T('⑨ 읽기: 품목 2줄 + 할인 −1,000 + 배송비 3,000 = 4줄 · 날짜 = 주문일 · 수량·단가·금액(부가세 포함 — basis total·세액 칸 비움) · 판매자 = 비고 · 줄 합 = 총 결제금액(경고 0)',
    r.ok && r.src === 'coupang' && r.basis === 'total' && r.rows.length === 4 && r.rows.every((x) => x.date === '2026-11-15' && x.vat === null && x.how === 'file')
    && J(r.rows.map((x) => [x.item, x.qty, x.unit, x.amt, x.note])) === J([['가짜 생수 2L, 6개', 2, 12000, 24000, '판매자 쿠팡(주)'], ['가짜 작업장갑 10켤레', 1, 9900, 9900, '판매자 가짜상사'], ['할인금액', 1, -1000, -1000, ''], ['배송비', 1, 3000, 3000, '']])
    && r.warn.length === 0 && r.sum.total === 35900 && r.vendor.name === '쿠팡', J(r));
  const bad = CP.readOrder(CP.orderHtml(cpHtml({ total: '30,000원' }), at), '');
  T('⑨ 줄 합 ≠ 총 결제금액(쿠팡캐시 등) = 경고 · 주문 표 없음(멤버십 결제 메일) = 알아보지 않음', bad.ok && bad.warn.some((w) => /총 결제금액/.test(w)) && !CP.isCoupangOrder(Buffer.from('<html>[쿠팡] 와우 멤버십 월회비가 결제되었습니다. coupang</html>')), J(bad.warn));
  const rf = await RD.readFile(oh, '쿠팡 주문 2026-11-15.html', { ym: '2026-11', vk: 'v13', vendor: { name: '쿠팡', kind: 'tool', hint: ['쿠팡'] } });
  const rf2 = await RD.readFile(oh, 'x.html', { ym: '2026-12', vk: 'v13', vendor: { name: '쿠팡', kind: 'tool', hint: ['쿠팡'] } });
  T('⑨ 원본 읽기(readFile): 쿠팡 주문 HTML = AI 없이 바로(종류 기본 tool·거래처 대조 경고 없음) · 다른 달로 넣으면 줄 빼고 경고', rf.ok && !rf.ai && rf.result.src === 'coupang' && rf.result.rows.length === 4 && rf.result.rows[0].kind === 'tool' && !rf.result.vendor_mismatch
    && rf2.ok && rf2.result.rows.length === 0 && rf2.result.warn.some((w) => /그 달\(2026-12\) 밖/.test(w)), J(rf.result && rf.result.warn));
  const v13 = VEND.filter((v) => v.vk === 'v13')[0];
  T('⑨ 시드 거래처 v13 쿠팡(용구 묶음·작업용구·부가세 포함·잔액형 아님·낱말 쿠팡) · 시드 13곳', VEND.length === 13 && v13 && v13.name === '쿠팡' && v13.group === 'tool' && v13.kind === 'tool' && v13.basis === 'total' && v13.carry === false && J(v13.hint) === J(['쿠팡']), J(v13));
  // 한 번 돌기 — 폴더별 메일(가짜)
  const tax3 = readFileSync(join(FX, 'a_tax3.xml'));
  const NOW9 = Date.parse('2026-12-03T07:00:00+09:00');
  const M9 = [
    { uid: 11, box: '청구서함', key: 'c1', at: at, from: { addr: 'no-reply@e.coupang.com', name: '쿠팡' }, subject: '[쿠팡] 나*짜님 주문하신 내역을 확인해주세요.', atts: [{ part: '1', name: '쿠팡 주문 2026-11-15.html', est: raw.length, body: 'coupang' }] },
    { uid: 12, box: '청구서함', key: 'c2', at: at + 86400000, from: { addr: 'no-reply@coupang.com', name: '쿠팡' }, subject: '[쿠팡] 주문하신 내역 (표 없음 가짜)', atts: [{ part: '1', name: '쿠팡 주문 2026-11-16.html', est: 100, body: 'coupang' }] },
    { uid: 13, box: '청구서함', key: 'c3', at: Date.parse('2026-12-01T10:00:00+09:00'), from: { addr: 'boss@suyang.test', name: '김가짜' }, subject: '11월 명세', atts: [{ part: '2', name: '수양개발 명세.pdf', est: suyang.length }] },
    { uid: 14, box: '청구서', key: 'c4', at: Date.parse('2026-11-15T10:00:00+09:00'), from: { addr: 'x@hometax.test', name: '국세청' }, subject: '세금계산서', atts: [{ part: '2', name: 'NTS_x.xml', est: tax3.length }] },
    { uid: 15, box: '청구서', key: 'c5', at: Date.parse('2026-12-01T11:00:00+09:00'), from: { addr: 'x@hometax.test', name: '국세청' }, subject: '세금계산서', atts: [{ part: '2', name: 'NTS_y.xml', est: tax3.length }] },
    { uid: 16, box: '청구서함', key: 'c6', at: Date.parse('2026-10-30T10:00:00+09:00'), from: { addr: 'no-reply@e.coupang.com', name: '쿠팡' }, subject: '[쿠팡] 주문하신 내역', atts: [{ part: '1', name: '쿠팡 주문 2026-10-30.html', est: raw.length, body: 'coupang' }] },
  ];
  const F9 = { '11:1': raw, '12:1': Buffer.from('<html>멤버십 가짜</html>'), '13:2': suyang, '14:2': tax3, '15:2': tax3, '16:1': raw };
  const b9 = mkBox(M9, F9), gets = [];
  b9.get = async function (uid, part, bx) { b9.calls.get++; gets.push(uid + '@' + bx); return F9[uid + ':' + part]; };
  b9.missing = ['없는폴더'];
  const s9 = mkStore(), f9 = mkStore();
  const io9 = mkIo(s9, f9, b9, { now: () => NOW9 });
  const r9 = await M.run(io9);
  const d9 = Array.from(s9.m.keys()).filter((k) => k.indexOf('stmtdrop:') === 0).map((k) => JSON.parse(s9.m.get(k)));
  const cp9 = d9.filter((d) => d.vk === 'v13')[0], sy9 = d9.filter((d) => d.vk === 'v02')[0];
  const cpFile = cp9 && f9.m.get('stmtfile:' + cp9.id), cpTxt = cpFile ? Buffer.from(JSON.parse(cpFile).data, 'base64').toString('utf8') : '';
  T('⑨ 한 번 돌기: 청구서함 쿠팡 주문 = 11월(주문한 달 — 20일 규칙 아님) · 거래처 v13(파일 이름) · 바로 읽음 4줄 · 남긴 원본에 받는 사람·연락처·주소·계좌 없음',
    cp9 && cp9.ym === '2026-11' && cp9.how === 'name' && cp9.state === 'read' && cp9.n === 4 && cp9.src === 'coupang' && /구매 상세내역/.test(cpTxt) && !/유\*가짜|8888|가짜시|99988877766/.test(cpTxt), cp9 && J({ ym: cp9.ym, how: cp9.how, st: cp9.state, n: cp9.n }));
  T('⑨ 한 번 돌기: 청구서함 첨부(12/1 수양) = 11월 목록 v02 · 내려받을 때 그 폴더를 씀', sy9 && sy9.ym === '2026-11' && gets.indexOf('13@청구서함') >= 0 && gets.indexOf('11@청구서함') >= 0, J(gets));
  T('⑨ 주문 표 없는 쿠팡 본문 = 저장 안 함 · 11/20 전 첨부(청구서 11/15) = 내려받지 않음 · 10월 쿠팡 주문(11/1 전) = 안 봄 · 목록 밖 공급자의 계산서(가짜상용서비스) = 거래처 고르기로 올리지 않음(other)',
    d9.length === 2 && gets.indexOf('14@청구서') < 0 && gets.indexOf('16@청구서함') < 0 && gets.indexOf('15@청구서') >= 0 && r9.other === 1 && r9.skip === 1 && r9.nov === 0 && r9.nobox === 1, J(r9) + ' ' + J(gets));
  const all9 = Array.from(s9.m.values()).join('\n') + io9.audits.join('\n');
  T('⑨ 저장·감사에 보낸 이 주소·이름·제목 없음(도메인만)', !/no-reply|김가짜|나\*짜|주문하신 내역|없는폴더/.test(all9.replace(/"data":"[^"]*"/g, '')), (all9.match(/no-reply|김가짜|나\*짜|주문하신 내역|없는폴더/) || [''])[0]);
  const s9b = await M.run(mkIo(s9, f9, Object.assign(mkBox(M9, F9), { get: async () => { throw new Error('내려받으면 안 됨'); } }), { now: () => NOW9 }));
  T('⑨ 다시 돌기 = 새 원본 0(쿠팡 본문·건너뛴 것·목록 밖 계산서 모두 처리 표시)', s9b.ok && s9b.added === 0 && s9b.fail === 0, J(s9b));
  // 읽기 실패 ≠ 없음(C225): 처리 표시·보낸 사람을 못 읽으면 아무것도 안 씀 · 그 달 첨부 목록을 못 읽으면 넣지 않고 멈춤
  const rf9 = async (failKey, failList) => {
    const s = mkStore(), f = mkStore(); const writes = [];
    const io = mkIo(s, f, mkBox(M9, F9), { now: () => NOW9,
      blobGet: async (st, k) => (st === s && k === failKey) ? { ok: false, code: 'STORAGE_READ_FAILED' } : io0.blobGet(st, k),
      blobList: async (st, p) => failList ? { ok: false, code: 'STORAGE_LIST_FAILED' } : io0.blobList(st, p),
      blobSet: async (st, k, v) => { writes.push(k); return io0.blobSet(st, k, v); } });
    io.mailbox.get = async function (uid, part) { return F9[uid + ':' + part]; };
    const r = await M.run(io);
    return { r, writes };
  };
  const rfa = await rf9(M.SEEN), rfb = await rf9(M.SENDERS), rfc = await rf9('', true);
  T('⑨ 읽기 실패 ≠ 없음: 처리 표시·보낸 사람 못 읽음 = ok false STORAGE_READ_FAILED·쓰기 0 · 첨부 목록 못 읽음 = 멈춤·원본 0',
    rfa.r.ok === false && rfa.r.code === 'STORAGE_READ_FAILED' && rfa.writes.length === 0 && rfb.r.ok === false && rfb.writes.length === 0
    && rfc.r.ok === false && rfc.r.code === 'STORAGE_READ_FAILED' && !rfc.writes.some((k) => /^stmt(drop|file):/.test(k)), J([rfa.r.code, rfa.writes.length, rfb.writes.length, rfc.r.code, rfc.writes]));
  // 결함 사본 — 고친 자리를 되돌리면 시험이 잡는지
  const src9 = readFileSync(join(LIB, 'stmtmail.js'), 'utf8'), im9 = readFileSync(join(LIB, 'stmtimap.js'), 'utf8'), cps = readFileSync(join(LIB, 'stmtcoupang.js'), 'utf8');
  const MUT = [
    ['폴더 기본 받은편지함만', src9, "const BOXES = ['INBOX', '청구서함', '청구서'];", "const BOXES = ['INBOX'];", () => J(M.mailBoxes('')) === J(['INBOX', '청구서함', '청구서'])],
    ['내려받기 폴더 안 넘김', src9, 'io.mailbox.get(m.uid, a.part, m.box)', 'io.mailbox.get(m.uid, a.part)', null],
    ['쿠팡 원본 자르기 걷음', src9, 'buf = CP.orderHtml(buf, m.at);', '', null],
    ['쿠팡 귀속 20일 규칙', src9, "const ym = a.body ? kstDay(m.at).slice(0, 7) : ymOf(m.at)", 'const ym = ymOf(m.at)', null],
    ['목록 밖 계산서 거름 걷음', src9, "if (res && ((res.vendor && res.vendor.name) || res.buyer_other))", 'if (false)', null],
    ['첨부 시작일 걸음 걷음', src9, 'if (m.at < (body ? sinceBody : sinceAtt)) continue;', 'if (m.at < sinceBody) continue;', null],
    ['계좌 줄 그대로 남김', cps, "[/무통장|카드|계좌|페이|은행/.test(cells[0]) ? '결제' : cells[0], cells[1]]", 'cells', null],
    ['처리 표시 읽기 실패를 없음으로', src9, "if (!r || !r.ok) { const e = new Error('read'); e.readFail = true; throw e; }\n    return", 'return', 'rf'],
    ['첨부 목록 읽기 실패를 빈 목록으로', src9, "if (!l || !l.ok) { const e = new Error('list'); e.readFail = true; throw e; }", '', 'rf'],
    ['폴더 하나만 엶', im9,'for (const box of boxes) {', "for (const box of ['INBOX']) {", null],
  ];
  const caught = [];
  for (const [nm, src, a, b, kind] of MUT) {
    if (src.indexOf(a) < 0) { caught.push(nm + ':원문없음'); continue; }
    const mod = src.split(a).join(b);
    let bad = false;
    try {
      if (kind === 'rf') {
        const mm = { exports: {} };
        new Function('module', 'exports', 'require', mod)(mm, mm.exports, (p) => require(p.indexOf('./') === 0 ? join(LIB, p.slice(2)) : p));
        const one = async (failKey, failList) => {
          const s = mkStore(), f = mkStore(), writes = [];
          const io = mkIo(s, f, mkBox(M9, F9), { now: () => NOW9, blobGet: async (st, k) => (st === s && k === failKey) ? { ok: false } : io0.blobGet(st, k), blobList: async (st, p) => failList ? { ok: false } : io0.blobList(st, p), blobSet: async (st, k, v) => { writes.push(k); return io0.blobSet(st, k, v); } });
          io.mailbox.get = async function (uid, part) { return F9[uid + ':' + part]; };
          const r = await mm.exports.run(io);
          return { r, writes };
        };
        const x1 = await one(M.SEEN), x2 = await one('', true);
        if (!(x1.r.ok === false && x1.writes.length === 0 && x2.r.ok === false && !x2.writes.some((k) => /^stmt(drop|file):/.test(k)))) bad = true;
      } else if (src === src9) {
        const mm = { exports: {} };
        new Function('module', 'exports', 'require', mod)(mm, mm.exports, (p) => require(p.indexOf('./') === 0 ? join(LIB, p.slice(2)) : p));
        const Mx = mm.exports;
        if (J(Mx.mailBoxes('')) !== J(['INBOX', '청구서함', '청구서'])) bad = true;
        const sx = mkStore(), fx = mkStore(), gx = [];
        const bx = mkBox(M9, F9); bx.get = async function (uid, part, b2) { gx.push(uid + '@' + b2); return F9[uid + ':' + part]; };
        const rx = await Mx.run(mkIo(sx, fx, bx, { now: () => NOW9 }));
        const dx = Array.from(sx.m.keys()).filter((k) => k.indexOf('stmtdrop:') === 0).map((k) => JSON.parse(sx.m.get(k)));
        const cx = dx.filter((d) => d.vk === 'v13')[0];
        const tx = cx && fx.m.get('stmtfile:' + cx.id) ? Buffer.from(JSON.parse(fx.m.get('stmtfile:' + cx.id)).data, 'base64').toString('utf8') : '';
        if (!cx || cx.ym !== '2026-11' || /8888|99988877766/.test(tx) || dx.length !== 2 || rx.other !== 1 || gx.indexOf('13@청구서함') < 0 || gx.indexOf('14@청구서') >= 0) bad = true;
      } else if (src === cps) {
        const mm = { exports: {} };
        new Function('module', 'exports', 'require', mod)(mm, mm.exports, (p) => require(p.indexOf('./') === 0 ? join(LIB, p.slice(2)) : p));
        const t = mm.exports.orderHtml(raw, at).toString('utf8');
        if (/유\*가짜|8888|가짜시|99988877766|가짜은행/.test(t)) bad = true;
      } else if (src === im9) {
        bad = !/for \(const box of boxes\)/.test(mod);
      }
    } catch (e) { bad = true; }
    if (!bad) caught.push(nm);
  }
  T('⑨ 결함 사본 ' + MUT.length + '개(폴더 기본·내려받기 폴더·원본 자르기·귀속 달·목록 밖 계산서·첨부 시작일·계좌 줄·읽기 실패 둘·폴더 하나) = 모두 ✗', caught.length === 0, J(caught));
}
RD.readByAi = realAi;
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
