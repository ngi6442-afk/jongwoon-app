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
  T('③ 볼 기간 = 시작일(11/20 KST)과 40일 전 중 늦은 쪽', since === new Date(Date.parse('2026-11-20T00:00:00+09:00')).toISOString(), since);
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
  T('⑦ 계정 환경변수: 둘 다 있어야 · 기본 다음 메일 993', M.mailEnv({}) === null && M.mailEnv({ STMT_MAIL_USER: 'a' }) === null && JSON.stringify(M.mailEnv({ STMT_MAIL_USER: ' a ', STMT_MAIL_PASS: 'p' })) === JSON.stringify({ user: 'a', pass: 'p', host: 'imap.daum.net', port: 993 }));
}
// ---- ⑧ 묶음·설정: imapflow는 워커만 · 2.10.0 고정 · 예약 07:00 · 수동 킥 · 읽기 전용 열기
{
  const ml = readFileSync(join(LIB, 'stmtmail.js'), 'utf8'), im = readFileSync(join(LIB, 'stmtimap.js'), 'utf8'), wk = readFileSync(join(FN, 'gw-stmtmail-run-background.js'), 'utf8');
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8'), kick = readFileSync(join(FN, 'gw-cron-kick.js'), 'utf8');
  T('⑧ imapflow는 stmtimap.js만 부름(gw-stmt 묶음에 안 들어감)', !/imapflow/.test(ml.replace(/\/\/.*$/gm, '')) && /require\('imapflow'\)/.test(im) && /require\('\.\/_lib\/stmtimap'\)/.test(wk) && !/stmtimap/.test(readFileSync(join(FN, 'gw-stmt.js'), 'utf8')));
  T('⑧ 메일함은 읽기 전용으로 엶(readOnly) · 메일 지우기·표시 바꾸기 명령 없음', /mailboxOpen\('INBOX', \{ readOnly: true \}\)/.test(im) && !/messageDelete|messageFlagsAdd|messageFlagsSet|messageMove|append\(/.test(im + ml));
  T('⑧ imapflow 2.10.0 정확히 고정', pj.dependencies.imapflow === '2.10.0');
  T('⑧ 예약 = 매일 UTC 22:00(KST 07:00) · 워커는 imapflow를 묶지 않고 실음', /\[functions\."gw-stmtmail-cron"\]\s*\n\s*schedule = "0 22 \* \* \*"/.test(toml) && /\[functions\."gw-stmtmail-run-background"\]\s*\n\s*external_node_modules = \["imapflow"\]/.test(toml));
  T('⑧ 수동 킥 target stmtmail', /target !== 'stmtmail'/.test(kick) && /'\.\/gw-stmtmail-cron'/.test(kick));
  T('⑧ 워커는 내부 토큰(__stmtmail__)만 · 겹침 잠금 · 끝에 요약(stmt:mail:last)', /v\.payload\.mid !== M\.BOT/.test(wk) && /stmt:mail:lock/.test(wk) && /blobSet\(st, M\.LAST, sum\)/.test(wk));
}
RD.readByAi = realAi;
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
