'use strict';

// 웹푸시 — VAPID 키는 최초 사용 시 서버가 생성해 Blobs에 보관(환경변수 불필요).
// 구독은 push:subs 에 회원 id별로 저장. 만료(404/410) 구독은 발송 시 자동 제거.
const webpush = require('web-push');
const { store, blobGet, blobSet, blobList } = require('./blobs');
const tier = require('./tier');   // 관리자 등급(v321) — tierCtx(bossIds·pmIds·adminIds·요청자 등급) 판정의 단일 원천

const DATA = 'gw_data';
const USERS = 'gw_users';
// P1 판24-② (보안 재감사 ⑤ — 재현됨: 100건 링 = 운영 11/14 백업 실측 11.8일 · 하루 8.5건 · 한 줄 292바이트 · 문서 29KB): 1000건으로 — 지금 속도로 약 4개월(118일) · 문서 약 0.3MB
//   (넷리파이 함수 요청·응답 6MB의 1/20 — 알림함 화면 push_log는 종전대로 끝 50건만 내보냄). 발신자(by)가 링에서 밀려나기 전에 분기 점검이 볼 수 있게. 그보다 옛 줄은 자료 저장소 일일 백업 스냅샷(git 이력)에 남는다
const PUSH_LOG_MAX = 1000;
// 받을 기기 없는 알림 가시화(원장 C253 · 11/20 전수 조사 확정 — 구독 기기가 0대인 받는 사람 앞 알림이 0발로 끝나는데 알림함에는 보낸 것처럼 남고 아무도 몰랐다).
//   「덧대기」 — 「원천」은 사람 일(그 기기에서 ⚙ › 🔔 '이 기기 알림 켜기' · 구독은 본인 기기의 브라우저 권한이라 코드로 못 켠다).
const NOTIFY_KEY = 'settings:notify';   // gw-data NOTIFY_KEY와 같은 키 — 여기서는 **읽기만**(쓰면 관리자 병행 7일 판정 시각이 새로 찍힌다 — gw-data notifyParallelOn)
const MISS_KEY = 'push:miss';           // { day(마지막으로 알린 KST 날) · n(그 뒤 쌓인 미도달) · who{회원 id: 건수} · last{ts, n, people} } — 설정 push_miss = dev_daily 일 때만 쓴다
const MISS_ON = 'dev_daily';            // gw-data NOTIFY_EVENTS.push_miss 의 켬 값(기본 off)
const MISS_BY = '알림 점검';

async function getKeys() {
  const r = await blobGet(store(DATA), 'push:keys');
  if (r.ok && r.data && r.data.publicKey && r.data.privateKey) return r.data;
  // C225 판 A: 못 읽음(읽기·파싱 실패)이면 새 키를 만들지 않는다 — 새 키로 덮이면 전 직원 기기 구독(옛 공개키로 맺음)이 끊겼다. 없음일 때만 만든다
  if (!r.ok && r.code !== 'NOT_FOUND') throw new Error('KEYS_READ_FAILED');
  const k = webpush.generateVAPIDKeys();
  const doc = { publicKey: k.publicKey, privateKey: k.privateKey, created: Date.now() };
  const w = await blobSet(store(DATA), 'push:keys', doc);
  if (!w.ok) throw new Error('PUSH_KEYS_WRITE_FAILED');
  return doc;
}

async function getSubs() {
  const r = await blobGet(store(DATA), 'push:subs');
  return (r.ok && r.data && r.data.members) ? r.data : { schema: 1, members: {} };
}
async function saveSubs(doc) { return blobSet(store(DATA), 'push:subs', doc); }
// P1 판22 검토 11/14 ⑧: 구독을 **고쳐 쓰는** 길(push_sub·push_unsub·push_primary 지정)은 이것으로 읽는다 — 못 읽음(ok:false)과 없음(빈 문서)을 가른다.
//   getSubs는 못 읽어도 빈 문서를 돌려줘, 그 위에 덧붙여 저장하면 전원 구독이 지워졌다(발송 쪽 getSubs는 그대로 — 못 읽으면 보낼 곳이 없을 뿐 저장하지 않음)
async function readSubs() {
  const r = await blobGet(store(DATA), 'push:subs');
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, doc: { schema: 1, members: {} } } : { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data == null) return { ok: true, doc: { schema: 1, members: {} } };
  if (typeof r.data !== 'object' || Array.isArray(r.data) || (r.data.members != null && (typeof r.data.members !== 'object' || Array.isArray(r.data.members)))) return { ok: false, code: 'SUBS_BAD_DOC' };
  if (!r.data.members) r.data.members = {};
  return { ok: true, doc: r.data };
}

// 회원 전수 로드(원본 레코드 — 재직·삭제 여부는 tier.ctxOf가 거른다). 스캔 1회로 등급 컨텍스트를 만드는 재료.
// **못 읽은 것과 없는 것은 다르다**: gw_users list가 한 번 튀면 종전엔 빈 명부를 돌려줘 sendTo의 활성 필터가
// 수신자를 전원 '퇴사'로 판정하고 그 시간대 알림(결재·운반일지·화관법·개찰·할 일 크론)이 통째로 무음 차단됐다(200 OK / sent:0).
// 그래서 실패를 out.unavailable로 표시해 위층(activeIdSet)이 필터를 아예 걸지 않도록(fail-open) 한다 —
// 로그인·세션·데이터 차단은 gw-auth/gw-data의 retired 게이트가 이미 하므로 이 필터는 2차 방어다.
async function loadMembers() {
  const st = store(USERS);
  const l = await blobList(st, 'member:');
  if (!l.ok) { const bad = []; bad.unavailable = true; return bad; }
  const out = [];
  let miss = 0;
  for (const k of l.keys) {
    if (k.indexOf('member:') !== 0) continue;
    const r = await blobGet(st, k);
    if (r.ok && r.data && r.data.id) out.push(r.data); else miss++;   // 개별 읽기 실패도 '없는 사람'으로 굳히지 않는다
  }
  if (miss) out.unavailable = true;
  return out;
}
// 관리자 등급 컨텍스트(v321·9/6 검증 반영) — {members, bootstrap, tierOf(m), isBoss(m), isPm(m), bossIds, pmIds, adminIds}. _lib/tier.js ctxOf:
// 명시 tier만 신뢰, 재직 관리자 전원이 미지정일 때만 파생(부트스트랩), 퇴사(leave_date 경과)·삭제 회원 제외. 게이트(gw-data)는 이 컨텍스트 하나로 요청자 등급·수신자 목록을 함께 판정한다(스캔 1회)
async function tierCtx() { const ms = await loadMembers(); const c = tier.ctxOf(ms); if (ms.unavailable) c.unavailable = true; return c; }   // 미가용 표시는 ctxOf가 거르므로 여기서 다시 얹는다
// 관리자 회원 id 목록(개찰결과 등 전사 알림 대상) — 재직 관리자만
async function adminIds() { return (await tierCtx()).adminIds; }
// 활성(재직·미삭제) 회원 id 집합 — 수신자 필터용. opts.ctx로 이미 만든 tierCtx를 넘기면 회원 재스캔을 하지 않는다.
// 명부를 못 읽었으면 **null**(= 판정 불가)을 돌려준다. 호출자는 null이면 거르지 않는다 — 빈 집합과 구분되어야 무음 전멸이 안 난다.
async function activeIdSet(ctx) {
  const c = ctx || await tierCtx();
  if (c && c.unavailable) return null;
  const s = Object.create(null);
  (c.members || []).forEach(function (m) { if (m && m.id) s[m.id] = 1; });
  return s;
}

// payload: {title, body, url, tag} / opts: {primaryOnly, logOnly}
// primaryOnly=true(결재 2차, 배치도 결정 ③ "알림=우선기기 1발"): 회원별로 primary 구독이 있으면
// 그 기기에만 보낸다. primary 미지정 회원은 전 구독 폴백 — 우선기기를 안 정한 사람이
// 알림을 아예 못 받는 사고 방지. 만료(404/410) 제거는 현행 유지.
// logOnly=true(결재 3차, 명세 §4.2 "알림함만"): push:log 이력만 남기고 웹푸시는 발사하지 않는다 —
// ②라인 중간 단계(PM 승인 완료)처럼 담당이 할 일이 없는 통지는 기기를 깨우지 않는다는 결정.
// 수신자 활성 필터(v329) — 회원 레코드가 없거나 삭제(del)·퇴사(leave_date 경과)한 id는 발송에서도 알림함(push:log)에서도 뺀다.
// push:subs는 퇴사해도 회수되지 않으므로(구독은 그 사람 폰에 살아 있다) id가 수신자 목록에 들기만 하면 알림이 그대로 닿았다.
// gw-todo-cron(무인 08시)·gw-data handlePushSend(담당 지정)·결재 결과 통지가 전부 이 함수를 지나므로 여기 한 곳이 공통 관문이다.
async function sendTo(memberIds, payload, opts) {
  const asked = Array.isArray(memberIds) ? memberIds : [];
  let ids = asked, skipped = 0, filterOff = false;
  if (asked.length) {
    const act = await activeIdSet(opts && opts.ctx);
    if (act) {
      ids = asked.filter(function (id) { return !!act[id]; });
      skipped = asked.length - ids.length;
    } else filterOff = true;   // 명부 미가용 — 거르지 않고 보낸다(퇴사자 1건이 새는 것보다 회사 전체가 무음이 되는 쪽이 나쁘다)
  }
  // C253 ①: 실제로 보내는 줄(받는 사람 1명 이상 · logOnly 아님)은 구독을 **알림함 줄을 쓰기 전에** 읽어, 같은 쓰기에 '보낼 기기 수'(devices)와 '기기가 없는 받는 사람 수'(no_device)를 싣는다.
  //   줄은 종전대로 발송 전에 1번만 쓴다(읽기·쓰기 횟수 그대로 — 구독 읽기 1번의 자리만 앞으로). devices = 발송 직전 구독 기준 겨눈 기기 수(우선기기 반영 — aimCount):
  //   만료(404/410)·푸시 서비스 오류로 실제 도착이 더 적을 수 있다(만료 구독은 이 발송에서 걷혀 다음 줄부터 반영). 구독 문서를 못 읽었으면 수 대신 subs_unavailable(기기 없음으로 읽히지 않게)
  const live = ids.length > 0 && !(opts && opts.logOnly === true);
  let doc = null, subsBad = false, devices = 0, noDevice = 0;
  if (live) {
    let sr; try { sr = await subsForSend(); } catch (e) { sr = { doc: { schema: 1, members: {} }, bad: true }; }
    doc = sr.doc; subsBad = sr.bad;
    ids.forEach(function (rid) { const k = aimCount(doc.members[rid], !!(opts && opts.primaryOnly === true)); devices += k; if (!k) noDevice++; });
  }
  // 알림함(push:log) — 폰 팝업이 지나가면 다시 볼 곳이 없다는 PM 지적(2026-08-20).
  // 발송 전에 남기고(구독이 없어도 이력은 남게), 이력 실패가 발송을 막지 않는다. 최근 PUSH_LOG_MAX건 링(P1 판24-②: 100 → 1000).
  // C225 판 A: 이력을 못 읽으면 빈 이력 위에 쓰지 않는다(_lib/blobs.js 층 1도 막음) — 이번 한 줄을 못 남긴 것은 돌려주는 값 log_failed로 드러낸다(발송은 종전대로)
  let logFailed = false;
  try {
    const lr = await blobGet(store(DATA), 'push:log');
    if (!lr.ok && lr.code !== 'NOT_FOUND') throw new Error('LOG_READ_FAILED');
    const ldoc = (lr.ok && lr.data && Array.isArray(lr.data.items)) ? lr.data : { schema: 1, items: [] };
    const ent = { ts: Date.now(), title: String(payload.title || ''), body: String(payload.body || ''),
      url: String(payload.url || ''), tag: String(payload.tag || ''), to: ids.slice(0, 30) };
    if (skipped) ent.skipped = skipped;   // 가시화 — 퇴사자로 흘러가던 알림이 몇 건 끊겼는지 이력에 남는다
    if (filterOff) ent.filter_unavailable = true;   // 회원 명부를 못 읽어 필터를 건너뛴 발송(감지 — 조용히 지나가지 않게)
    if (opts && opts.by) ent.by = String(opts.by).slice(0, 40);   // 발신자(push_send는 임의 제목·본문을 실을 수 있다 — 최소한 누가 쐈는지는 남는다)
    // C253 ①: 새 칸 — 읽는 쪽(gw-data push_log는 ts·title·body·tag만 내보냄 · mchk 경보 수는 ts·title만)은 칸이 늘어도 그대로. '알림함만' 줄은 log_only(월 점검이 '못 간 알림'으로 세지 않게)
    if (live && subsBad) ent.subs_unavailable = true;
    else if (live) { ent.devices = devices; if (noDevice) ent.no_device = noDevice; }
    if (opts && opts.logOnly === true) ent.log_only = true;
    ldoc.items.push(ent);
    if (ldoc.items.length > PUSH_LOG_MAX) ldoc.items = ldoc.items.slice(-PUSH_LOG_MAX);
    const lw = await blobSet(store(DATA), 'push:log', ldoc);
    if (!(lw && lw.ok)) logFailed = true;
  } catch (e) { logFailed = true; }
  const lf = logFailed ? { log_failed: true } : {};
  if (opts && opts.logOnly === true) return Object.assign({ sent: 0, removed: 0, skipped: skipped }, lf);
  if (!ids.length) return Object.assign({ sent: 0, removed: 0, skipped: skipped }, lf);
  let keys;
  try { keys = await getKeys(); } catch (e) {
    if (e && e.message === 'KEYS_READ_FAILED') return Object.assign({ sent: 0, removed: 0, skipped: skipped, why: 'KEYS_READ_FAILED' }, lf);   // C225: 키를 못 읽은 회차는 보내지 않음(새 키로 덮지 않음)
    throw e;
  }
  webpush.setVapidDetails('mailto:ngi6442@gmail.com', keys.publicKey, keys.privateKey);
  // 구독 문서(doc)는 위에서 읽었다(C253 ① — 알림함 줄에 수를 싣느라 읽는 자리만 앞으로. 내용·못 읽었을 때 빈 문서인 것은 getSubs와 같다)
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0;
  for (const mid of ids) {
    const subs = doc.members[mid] || [];
    const wantPrimary = !!(opts && opts.primaryOnly === true) && subs.some(function (x) { return x && x.primary; });
    // pass 0 = primary 기기만. 한 발도 못 나가면(만료 제거 등) pass 1에서 나머지 구독 폴백 —
    // 죽은 primary가 그 회원의 알림 1발을 통째로 삼키지 않게(리뷰 low). primary 미지정이면 pass 0에서 전 기기.
    let mSent = 0;
    for (let pass = 0; pass < 2; pass++) {
      const primaryPass = wantPrimary && pass === 0;
      for (let i = subs.length - 1; i >= 0; i--) {
        const isPrim = !!(subs[i] && subs[i].primary);
        if (wantPrimary && (primaryPass ? !isPrim : isPrim)) continue;
        try {
          // TTL 24시간(감시 2단계, 2026-08-19) — 1시간이던 시절엔 밤새 꺼둔 폰이 아침 경보를
          // 통째로 놓쳤다(09시 발송 → 10시 폐기). 기기가 하루 안에만 켜지면 경보가 닿는다.
          // opts.timeoutMs(P1 판22 검토 11/14 ① — 판22 발송만 넘김): 푸시 서비스 요청 시간 상한. 안 넘기면 종전 그대로(다른 알림 동작 무변)
          await webpush.sendNotification(subs[i].sub, body, (opts && opts.timeoutMs > 0) ? { TTL: 86400, timeout: opts.timeoutMs } : { TTL: 86400 });
          sent++; mSent++;
        } catch (e) {
          const sc = e && e.statusCode;
          if (sc === 404 || sc === 410) { subs.splice(i, 1); removed++; }
        }
      }
      if (!wantPrimary || mSent > 0) break;
    }
    if (subs.length) doc.members[mid] = subs; else delete doc.members[mid];
  }
  if (removed) { try { await saveSubs(doc); } catch (e) {} }
  // C253 ③: **한 사람에게만 가는** 알림이 받을 기기가 없어(구독 0 · 또는 만료로 다 걷힘) 0발로 끝남 → noteMiss(설정이 꺼져 있으면 설정 읽기 1번뿐 — 쓰기·발송 없음).
  //   푸시 서비스 오류로 0발(구독은 남음)·구독 문서를 못 읽음은 '기기 없음'이 아니라 세지 않는다. 이 알림 자신(opts.missNote === false)도 세지 않는다(되풀이 방지). 실패는 삼킨다(본 발송 결과 무변)
  if (ids.length === 1 && sent === 0 && !subsBad && !(opts && opts.missNote === false) && !((doc.members[ids[0]] || []).length)) {
    try { await noteMiss(ids[0], opts); } catch (e) {}
  }
  if (logFailed) return { sent, removed, skipped, log_failed: true };   // C225 판 A
  return { sent, removed, skipped };
}

// 발송용 구독 읽기 — 문서는 getSubs와 같고(못 읽으면 빈 문서 = 보낼 곳 없음), 못 읽음(bad)과 없음을 가른다(없는 키: 실 Blobs = ok·null · servertest 가짜 저장소 = NOT_FOUND)
async function subsForSend() {
  const r = await blobGet(store(DATA), 'push:subs');
  if (r.ok && r.data && r.data.members) return { doc: r.data, bad: false };
  return { doc: { schema: 1, members: {} }, bad: !r.ok && r.code !== 'NOT_FOUND' };
}
// 한 회원에게 겨눈 기기 수 — sendTo 첫 바퀴(pass 0)와 같은 규칙: primaryOnly이고 우선기기가 있으면 우선기기만, 아니면 구독 전부
function aimCount(subs, primaryOnly) {
  const list = Array.isArray(subs) ? subs : [];
  if (primaryOnly && list.some(function (x) { return x && x.primary; })) return list.filter(function (x) { return x && x.primary; }).length;
  return list.length;
}
// C253 ③ 받을 기기 없음 알림 — 알림 설정(settings:notify) push_miss = dev_daily 일 때만. 기본 off(새 알림이라 켜는 것은 PM 결정).
//   받는 사람 = 재직 개발자, 없으면 관리자 전원(판22 새 기기 승인 대기 알림의 받는 사람과 같은 규칙 — 그 파일이 이 파일을 부르므로 거꾸로 부르지 않고 같은 두 줄을 둔다) · 우선기기 1발.
//   하루(KST) 한 번: 그날 첫 미도달 때 표식(push:miss day)을 **먼저** 쓰고(못 쓰면 보내지 않음) 지난 알림 뒤 쌓인 수를 실어 보낸다 · 같은 날 뒤 미도달은 수만 쌓여 다음 알림에 실린다.
//   명부를 못 읽었거나 받는 사람이 0명이면 수만 쌓는다. 본문에는 기기 없는 사람 이름 3명까지(누구 기기에서 켜야 하는지 — 알림 내용은 싣지 않는다).
async function noteMiss(mid, opts, nowMs) {
  const st = store(DATA);
  const nr = await blobGet(st, NOTIFY_KEY);
  if (!(nr.ok && nr.data && nr.data.events && typeof nr.data.events === 'object' && nr.data.events.push_miss === MISS_ON)) return false;
  const mr = await blobGet(st, MISS_KEY);
  if (!mr.ok && mr.code !== 'NOT_FOUND') return false;   // 못 읽으면 건드리지 않는다(쌓인 수를 0 위에 덮지 않게)
  const isO = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };
  const cur = (mr.ok && isO(mr.data)) ? mr.data : {};
  const now = nowMs || Date.now(), today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const who = {}; if (isO(cur.who)) Object.keys(cur.who).forEach(function (k) { who[k] = Number(cur.who[k]) || 0; });
  if (Object.prototype.hasOwnProperty.call(who, mid) || Object.keys(who).length < 30) who[mid] = (who[mid] || 0) + 1;
  const n = (Number(cur.n) || 0) + 1;
  const keep = function () { return blobSet(st, MISS_KEY, Object.assign({}, cur, { schema: 1, n: n, who: who, updated_at: now })); };
  if (cur.day === today) { await keep(); return false; }
  const ctx = (opts && opts.ctx) || await tierCtx();
  if (!ctx || ctx.unavailable) { await keep(); return false; }
  const devs = (ctx.members || []).filter(function (m) { return m && m.dev; }).map(function (m) { return m.id; });
  const to = devs.length ? devs : (ctx.adminIds || []).slice();
  if (!to.length) { await keep(); return false; }
  const ppl = Object.keys(who);
  const w = await blobSet(st, MISS_KEY, { schema: 1, day: today, n: 0, who: {}, last: { ts: now, n: n, people: ppl.length }, updated_at: now });
  if (!w || !w.ok) return false;
  const nameOf = {}; (ctx.members || []).forEach(function (m) { if (m && m.id) nameOf[m.id] = String(m.name || '').slice(0, 10); });
  const names = ppl.map(function (id) { return nameOf[id] || ''; }).filter(Boolean);
  const body = (names.length ? names.slice(0, 3).join(', ') + (ppl.length > 3 ? ' 외 ' + (ppl.length - 3) + '명' : '') : ppl.length + '명') + ' — 그 사람 기기에서 ⚙ › 🔔 [이 기기 알림 켜기]';
  const o = { ctx: ctx, primaryOnly: true, by: MISS_BY, missNote: false };
  if (opts && opts.timeoutMs > 0) o.timeoutMs = opts.timeoutMs;
  await sendTo(to, { title: '받을 기기 없음 — 미도달 ' + n + '건', body: body.slice(0, 200), url: './', tag: 'push-miss-' + today }, o);
  return true;
}

// 대표 회원 id — 관리자 등급(v321, _lib/tier.js) tier boss(명시 tier·부트스트랩 규칙은 tierCtx). 클라 isBossMember와 같은 축. 운반일지 결재 라우팅·BOSS_ONLY 게이트 전용(9/3 PM 결정).
// 종전 동기 isBoss(m)·isPm(m)·tierOf(m)는 제거 — 회원 한 명만 보고는 부트스트랩 여부를 알 수 없어 게이트가 파생값을 믿게 된다(9/6 검증 S1). 게이트는 tierCtx().tierOf(m)로
async function bossIds() { return (await tierCtx()).bossIds; }
// 대표 전용 건의 결재 **요청 알림** 수신자 — 대표가 0명이면 관리자 전원에게 알려 대표 부재를 드러낸다(알림 전용 — 결재 게이트 BOSS_ONLY는 폴백 없이 대표만, S2).
async function bossOrAdminIds() { const b = await bossIds(); return b.length ? b : await adminIds(); }
// PM id 목록 — 관리자 등급(v321) tier pm만(관리자 등급 admin은 ① 전결·PM 큐 결재 권한이 없다). 결재 3차 ①·② 1단계 라우팅·PM_ONLY 게이트·pm_present 전용.
async function pmIds() { return (await tierCtx()).pmIds; }
// ①·② 1단계 결재 요청 수신자 — tier pm이 없으면(1인 관리자=대표뿐 등) 관리자 전원 폴백(교착 방지 — PM 큐 게이트도 pm 0명이면 관리자 전원에게 열린다, 종전 유지)
async function pmOrAdminIds() { const p = await pmIds(); return p.length ? p : await adminIds(); }

module.exports = { PUSH_LOG_MAX, getKeys, getSubs, saveSubs, readSubs, sendTo, loadMembers, tierCtx, activeIdSet, adminIds, bossIds, bossOrAdminIds, pmIds, pmOrAdminIds };
