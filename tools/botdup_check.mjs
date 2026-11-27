// C255(11/20) 봇 알림 되풀이 안전망 시험 — 실제 gw-data handler(bot_notify → handleBotNotify)와 실제 _lib/push.js sendTo를 그대로 부른다.
//   가짜는 둘뿐: 저장소(_lib/blobs.js — servertest와 같은 인메모리 꼴)와 푸시 전송(web-push = 네트워크). 시각은 Date.now를 바꿔 KST 날을 넘긴다.
//   실행: node tools/botdup_check.mjs [함수 폴더]   (인자 = netlify/functions 대신 볼 폴더 — 결함 사본 확인용. 실패 1건이라도 있으면 종료 1)
//   시험 자료는 전부 지어낸 값(회원 id a1·a2·a3·e1, 가짜 구독 끝점).
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'netlify', 'functions');
let pass = 0, fail = 0;
function T(name, ok, info) { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' — ' + info : '')); } }

process.env.GW_SESSION_SECRET = 'botdup-secret';
process.env.BIDS_INGEST_KEY = 'botdup-ingest-key';
process.env.URL = 'https://test.local';

// ---- 가짜 저장소(_lib/blobs.js 자리) · 가짜 전송(web-push 자리)
const mem = {};
const hooks = { failGetOnce: null };
const blobsMock = {
  setupBlobContext() {},
  store(n) { mem[n] = mem[n] || {}; return { name: n, toString() { return n; }, async list(o) { const pre = (o && o.prefix) || ''; return { blobs: Object.keys(mem[n] || {}).filter((k) => k.indexOf(pre) === 0).map((k) => ({ key: k })) }; } }; },
  async blobGet(st, k) { if (hooks.failGetOnce === k) { hooks.failGetOnce = null; return { ok: false, code: 'STORAGE_READ_FAILED' }; } const v = (mem[st] || {})[k]; return v === undefined ? { ok: false, code: 'NOT_FOUND' } : { ok: true, data: JSON.parse(JSON.stringify(v)) }; },
  async blobSet(st, k, v) { mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobDelete(st, k) { if (mem[st]) delete mem[st][k]; return { ok: true }; },
  async blobList(st) { return { ok: true, keys: Object.keys(mem[st] || {}) }; },
};
const SENT = [];   // 기기 발송 기록 { ep, tag, title, body }
const webpushMock = {
  generateVAPIDKeys() { return { publicKey: 'pubX', privateKey: 'privX' }; },
  setVapidDetails() {},
  async sendNotification(sub, body) { const p = JSON.parse(body); SENT.push({ ep: sub.endpoint, tag: p.tag, title: p.title, body: p.body, renotify: p.renotify }); return { statusCode: 201 }; },
};
{
  const rb = require.resolve(join(FN, '_lib/blobs.js'));
  require.cache[rb] = { id: rb, filename: rb, loaded: true, exports: blobsMock };
  const rw = require.resolve('web-push');
  require.cache[rw] = { id: rw, filename: rw, loaded: true, exports: webpushMock };
}
const gwd = require(join(FN, 'gw-data.js'));
const pushLib = require(join(FN, '_lib/push.js'));
T('준비: 푸시 모듈은 실제 _lib/push.js(sendTo가 알림함 줄을 남기는 그 코드)', typeof pushLib.sendTo === 'function' && pushLib.PUSH_LOG_MAX === 1000);

// ---- 가짜 자료: 관리자 3명(기기 1·2·1) + 일반 직원 1명(기기 1)
mem.gw_users = { 'member:a1': { id: 'a1', name: '가', admin: true, tier: 'boss' }, 'member:a2': { id: 'a2', name: '나', admin: true, tier: 'pm' },
  'member:a3': { id: 'a3', name: '다', admin: true, tier: 'admin' }, 'member:e1': { id: 'e1', name: '라', admin: false, perms: {} } };
mem.gw_data = { 'push:subs': { schema: 1, members: { a1: [{ sub: { endpoint: 'ep-a1' } }], a2: [{ sub: { endpoint: 'ep-a2-1' } }, { sub: { endpoint: 'ep-a2-2' } }], a3: [{ sub: { endpoint: 'ep-a3' } }], e1: [{ sub: { endpoint: 'ep-e1' } }] } } };
const realNow = Date.now;
let clock = Date.parse('2026-11-11T14:55:00+09:00');
Date.now = () => clock;
const at = (s) => { clock = Date.parse(s + '+09:00'); };
const logLen = () => ((mem.gw_data['push:log'] || {}).items || []).length;
async function bot(title, body, tag) {
  const s0 = SENT.length, l0 = logLen();
  const r = await gwd.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(Object.assign({ action: 'bot_notify', key: 'botdup-ingest-key', title: title, body: body }, tag === undefined ? {} : { tag: tag })) });
  const b = JSON.parse(r.body || '{}');
  return { code: r.statusCode, sent: b.sent, dup: b.dup, note: b.note || '', pushes: SENT.length - s0, eps: SENT.slice(s0).map((x) => x.ep).sort().join(), logs: logLen() - l0 };
}
const J = (x) => JSON.stringify(x);

try {
  // ---- ① 같은 꼬리표·제목·본문 3번(같은 날 14:55·20:22·23:56) → 기기 발송은 첫 번만, 알림함은 3줄
  const W = ['입찰 안내', '입찰 어댑터 1회 실패(가짜)', 'watch-warn-입찰-2026-11-11'];
  at('2026-11-11T14:55:00'); const r1 = await bot(...W);
  at('2026-11-11T20:22:00'); const r2 = await bot(...W);
  at('2026-11-11T23:56:00'); const r3 = await bot(...W);
  T('① 같은 날 같은 알림 3번: 기기 발송 4·0·0(관리자 기기 4대) · 알림함 줄 1·1·1', r1.pushes === 4 && r2.pushes === 0 && r3.pushes === 0 && r1.logs === 1 && r2.logs === 1 && r3.logs === 1, J([r1, r2, r3]));
  T('① 응답: 첫 번 sent 4(dup 없음) · 되풀이는 200 · sent 0 · dup 1 · 알림함에만 남김 문구', r1.code === 200 && r1.sent === 4 && r1.dup === undefined && r2.code === 200 && r2.sent === 0 && r2.dup === 1 && /알림함에만/.test(r2.note) && r3.dup === 1, J([r1, r2, r3]));
  T('① 일반 직원 기기로는 안 감(받는 사람 범위 그대로)', r1.eps === 'ep-a1,ep-a2-1,ep-a2-2,ep-a3');
  const last = mem.gw_data['push:log'].items.slice(-1)[0];
  T('① 되풀이 줄도 알림함에 같은 꼴(제목·본문·꼬리표·받는 사람)로 남음', last.title === W[0] && last.body === W[1] && last.tag === W[2] && last.to.join() === 'a1,a2,a3');

  // ---- ② 하나라도 다르면 그대로 보냄 — 본문 · 제목 · 꼬리표
  at('2026-11-11T23:57:00');
  const b1 = await bot(W[0], W[1] + ' 2', W[2]), b2 = await bot('⚠ 입찰 감시 경보', W[1], W[2]), b3 = await bot(W[0], W[1], 'watch-입찰-2026-11-11');
  T('② 본문이 다름 → 보냄 · 제목이 다름 → 보냄 · 꼬리표가 다름(안내 → 경보) → 보냄', b1.pushes === 4 && b2.pushes === 4 && b3.pushes === 4 && !b1.dup && !b2.dup && !b3.dup, J([b1, b2, b3]));
  const b4 = await bot(W[0], W[1] + ' 2', W[2]);
  T('② 바뀐 본문도 같은 날 다시 오면 그때는 되풀이', b4.pushes === 0 && b4.dup === 1, J(b4));

  // ---- ③ 날(KST)이 바뀌면 같은 글도 보냄 — 이 안전망은 '그날'만 본다(판정일을 넘긴 되풀이는 보내는 쪽 watch.py가 막음)
  at('2026-11-12T00:47:00'); const c1 = await bot(...W);
  at('2026-11-12T08:59:00'); const c2 = await bot(...W);
  T('③ 다음 날 00:47 같은 글 → 보냄(날이 바뀜) · 그날 08:59 또 → 되풀이', c1.pushes === 4 && !c1.dup && c2.pushes === 0 && c2.dup === 1, J([c1, c2]));
  at('2026-11-12T23:59:59'); const c3 = await bot('경계', 'x', 'edge-tag');
  at('2026-11-13T00:00:00'); const c4 = await bot('경계', 'x', 'edge-tag');
  T('③ KST 자정 경계: 23:59:59 보냄 → 00:00:00 다시 보냄', c3.pushes === 4 && c4.pushes === 4 && !c4.dup, J([c3, c4]));

  // ---- ④ 개찰 API 경보 꼴 — 본문이 연속 횟수만 달라도 다른 본문이라 안전망은 안 막음(원천 = awards.py 하루 1번)
  at('2026-11-13T09:22:00'); let d = [];
  for (let n = 3; n <= 7; n++) d.push(await bot('⚠ 조달청 개찰 API 이상', '전국 개찰 응답 0건이 ' + n + '회 연속입니다.', 'api-dead'));
  T('④ 본문 숫자만 다른 5번 → 5번 다 보냄(안전망 범위 밖)', d.every((x) => x.pushes === 4 && !x.dup), J(d.map((x) => x.pushes)));

  // ---- ⑤ 뺀 꼬리표 auto-due('정기업무 n건') — 같은 글이 같은 날 또 와도 그대로 보냄
  at('2026-11-13T10:00:00'); const e1 = await bot('정기업무 1건', '가짜 지시', 'auto-due'), e2 = await bot('정기업무 1건', '가짜 지시', 'auto-due');
  T('⑤ auto-due 같은 글 2번 → 둘 다 보냄(안전망에서 뺌)', e1.pushes === 4 && e2.pushes === 4 && !e2.dup, J([e1, e2]));

  // ---- ⑥ 받는 사람이 늘면 되풀이가 아님 — bid_fail=assignee로 바뀐 뒤 같은 watch-입찰 경보는 담당 포함 전원에게
  at('2026-11-13T11:00:00'); const BW = ['⚠ 입찰 감시 경보', '가짜 경보', 'watch-입찰-2026-11-13'];
  const f1 = await bot(...BW);
  mem.gw_data['settings:notify'] = { schema: 1, events: { bid_fail: 'assignee' }, prev: null, updated_at: clock, updated_by: 'a2' };
  mem.gw_data['settings:assign'] = { schema: 1, rules: { 'bid:': { who_id: 'e1' } } };
  const f2 = await bot(...BW), f3 = await bot(...BW);
  T('⑥ 담당이 받는 사람에 새로 들면 전원에게 다시 보냄(5대) · 그다음 같은 것은 되풀이', f1.pushes === 4 && f2.pushes === 5 && /ep-e1/.test(f2.eps) && !f2.dup && f3.pushes === 0 && f3.dup === 1, J([f1, f2, f3]));
  delete mem.gw_data['settings:notify']; delete mem.gw_data['settings:assign'];

  // ---- ⑦ 알림함을 못 읽으면 거르지 않고 보냄
  at('2026-11-13T12:00:00'); const g1 = await bot('읽기 실패', 'x', 'read-fail');
  hooks.failGetOnce = 'push:log'; const g2 = await bot('읽기 실패', 'x', 'read-fail');
  T('⑦ 알림함 읽기 실패 → 같은 글이어도 보냄(삼키지 않음)', g1.pushes === 4 && g2.pushes === 4 && !g2.dup && hooks.failGetOnce === null, J([g1, g2]));

  // ---- ⑧ 꼬리표 없는 호출(기본 bot-notify)·긴 글(제목 60·본문 300·꼬리표 30자로 잘린 꼴끼리 견줌)
  at('2026-11-13T13:00:00'); const h1 = await bot('꼬리표 없음', 'x'), h2 = await bot('꼬리표 없음', 'x');
  const longB = '긴 본문 ' + '가'.repeat(400), longT = '긴 제목 ' + '나'.repeat(80), longG = 'watch-warn-' + '다'.repeat(30);
  const h3 = await bot(longT, longB, longG), h4 = await bot(longT, longB, longG);
  T('⑧ 꼬리표 없는 같은 글 → 두 번째는 되풀이 · 잘리는 긴 글도 두 번째는 되풀이', h1.pushes === 4 && h2.dup === 1 && h3.pushes === 4 && h4.dup === 1 && h4.pushes === 0, J([h1, h2, h3, h4]));

  // ---- ⑨ 종전 갈래 그대로 — 잘못된 키 403 · 구독 기기 없음(알림함 줄도 없음 · dup 표시 없음)
  const bad = await gwd.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'bot_notify', key: 'wrong', title: 'x' }) });
  const savedSubs = mem.gw_data['push:subs']; mem.gw_data['push:subs'] = { schema: 1, members: {} };
  const n1 = await bot(...W), n2 = await bot(...W);
  mem.gw_data['push:subs'] = savedSubs;
  T('⑨ 잘못된 키 403 · 구독 기기 없음: sent 0 · 알림함 줄 0 · dup 없음(두 번 다)', bad.statusCode === 403 && n1.sent === 0 && n1.logs === 0 && n1.dup === undefined && /구독 기기 없음/.test(n1.note) && n2.dup === undefined && n2.logs === 0, J([bad.statusCode, n1, n2]));

  // ---- ⑩ 봇 알림은 되풀이를 매번 울리게 만들지 않는다 — C324(11/27): 종전 '‘renotify’ 글자 없음'은 T750(v557)이 경보에만 일부러 넣은 다시 울림을 막아 늘 실패.
  //   지키려던 것 = 봇 알림(같은 꼬리표 자리 덮기)이 소리 없이 바뀌는 것. 그래서 ⓐ 실제 sw.js push 처리기를 돌려 다시 울림이 '보낸 쪽 renotify + 꼬리표'일 때만 켜지는지
  //   ⓑ 이 시험에서 봇 알림(bot_notify)이 실제로 보낸 내용에 renotify가 하나도 없는지를 본다. 결함 사본: 늘 다시 울림 · 꼬리표 없이도 · 봇 알림에 renotify 실음 = 모두 ✗
  const fs = require('node:fs'), vm = require('node:vm');
  const sw = fs.readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const swShow = (src, payloads) => {   // sw.js를 가짜 self 위에서 돌려 push 처리기가 만든 알림 옵션을 모음
    const L = {}, shown = [];
    const self = { addEventListener(t, f) { L[t] = f; }, registration: { showNotification(t, o) { shown.push(o); return Promise.resolve(); } }, skipWaiting() {}, clients: { claim() {}, matchAll: async () => [], openWindow: async () => null }, location: { origin: 'https://test.local' } };
    const ctx = { self, caches: { open: async () => ({ addAll: async () => {}, put: async () => {}, match: async () => null }), keys: async () => [], delete: async () => true, match: async () => null }, clients: self.clients, URL, Request: function () {}, Response: function () {}, fetch: async () => ({}), console, setTimeout, clearTimeout, importScripts() {} };
    vm.runInNewContext(src, ctx, { filename: 'sw.js' });
    for (const p of payloads) L.push({ data: { json: () => p }, waitUntil() {} });
    return shown.map((o) => o.renotify === true);
  };
  const swOk = (src) => { try { const r = swShow(src, [{ title: 'a', tag: 'bot-x' }, { title: 'b', renotify: true }, { title: 'c', tag: 'alarm-x', renotify: true }, { title: 'd' }]); return JSON.stringify(r) === '[false,false,true,false]'; } catch (e) { return false; } };
  const botOk = (sent) => sent.length > 0 && sent.every((s) => !s.renotify);
  const M10 = [swOk(sw.replace(/renotify:[^\n,]*,/, 'renotify: true,')), swOk(sw.replace(/renotify:[^\n,]*,/, 'renotify: !!d.renotify,')), botOk(SENT.concat([{ tag: 'bot-x', renotify: true }]))];
  T('⑩ 봇 알림 다시 울림 없음(C324): sw.js 다시 울림 = 보낸 쪽 renotify + 꼬리표일 때만(봇 꼴·꼬리표 없음·빈 값 = 안 울림 · 경보 꼴 = 울림) · 이 시험의 봇 알림 발송 ' + SENT.length + '건 renotify 0 · 결함 사본 ' + M10.length + '개 = 모두 ✗',
    swOk(sw) && botOk(SENT) && M10.every((v) => v === false), J({ sw: swOk(sw), bot: botOk(SENT), n: SENT.length, mut: M10 }));
} finally { Date.now = realNow; }

console.log(fail ? '봇 알림 되풀이 안전망 시험 실패 ' + fail + '건 (통과 ' + pass + ')' : '봇 알림 되풀이 안전망 시험 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
