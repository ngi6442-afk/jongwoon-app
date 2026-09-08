'use strict';

// 웹푸시 — VAPID 키는 최초 사용 시 서버가 생성해 Blobs에 보관(환경변수 불필요).
// 구독은 push:subs 에 회원 id별로 저장. 만료(404/410) 구독은 발송 시 자동 제거.
const webpush = require('web-push');
const { store, blobGet, blobSet, blobList } = require('./blobs');
const tier = require('./tier');   // 관리자 등급(v321) — tierCtx(bossIds·pmIds·adminIds·요청자 등급) 판정의 단일 원천

const DATA = 'gw_data';
const USERS = 'gw_users';

async function getKeys() {
  const r = await blobGet(store(DATA), 'push:keys');
  if (r.ok && r.data && r.data.publicKey && r.data.privateKey) return r.data;
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

// 회원 전수 로드(원본 레코드 — 재직·삭제 여부는 tier.ctxOf가 거른다). 스캔 1회로 등급 컨텍스트를 만드는 재료
async function loadMembers() {
  const st = store(USERS);
  const l = await blobList(st, 'member:');
  if (!l.ok) return [];
  const out = [];
  for (const k of l.keys) {
    if (k.indexOf('member:') !== 0) continue;
    const r = await blobGet(st, k);
    if (r.ok && r.data && r.data.id) out.push(r.data);
  }
  return out;
}
// 관리자 등급 컨텍스트(v321·9/6 검증 반영) — {members, bootstrap, tierOf(m), isBoss(m), isPm(m), bossIds, pmIds, adminIds}. _lib/tier.js ctxOf:
// 명시 tier만 신뢰, 재직 관리자 전원이 미지정일 때만 파생(부트스트랩), 퇴사(leave_date 경과)·삭제 회원 제외. 게이트(gw-data)는 이 컨텍스트 하나로 요청자 등급·수신자 목록을 함께 판정한다(스캔 1회)
async function tierCtx() { return tier.ctxOf(await loadMembers()); }
// 관리자 회원 id 목록(개찰결과 등 전사 알림 대상) — 재직 관리자만
async function adminIds() { return (await tierCtx()).adminIds; }
// 활성(재직·미삭제) 회원 id 집합 — 수신자 필터용. opts.ctx로 이미 만든 tierCtx를 넘기면 회원 재스캔을 하지 않는다.
async function activeIdSet(ctx) {
  const c = ctx || await tierCtx();
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
  let ids = asked, skipped = 0;
  if (asked.length) {
    const act = await activeIdSet(opts && opts.ctx);
    ids = asked.filter(function (id) { return !!act[id]; });
    skipped = asked.length - ids.length;
  }
  // 알림함(push:log) — 폰 팝업이 지나가면 다시 볼 곳이 없다는 PM 지적(2026-08-20).
  // 발송 전에 남기고(구독이 없어도 이력은 남게), 이력 실패가 발송을 막지 않는다. 최근 100건 링.
  try {
    const lr = await blobGet(store(DATA), 'push:log');
    const ldoc = (lr.ok && lr.data && Array.isArray(lr.data.items)) ? lr.data : { schema: 1, items: [] };
    const ent = { ts: Date.now(), title: String(payload.title || ''), body: String(payload.body || ''),
      url: String(payload.url || ''), tag: String(payload.tag || ''), to: ids.slice(0, 30) };
    if (skipped) ent.skipped = skipped;   // 가시화 — 퇴사자로 흘러가던 알림이 몇 건 끊겼는지 이력에 남는다
    ldoc.items.push(ent);
    if (ldoc.items.length > 100) ldoc.items = ldoc.items.slice(-100);
    await blobSet(store(DATA), 'push:log', ldoc);
  } catch (e) {}
  if (opts && opts.logOnly === true) return { sent: 0, removed: 0, skipped: skipped };
  if (!ids.length) return { sent: 0, removed: 0, skipped: skipped };
  const keys = await getKeys();
  webpush.setVapidDetails('mailto:ngi6442@gmail.com', keys.publicKey, keys.privateKey);
  const doc = await getSubs();
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
          await webpush.sendNotification(subs[i].sub, body, { TTL: 86400 });
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
  return { sent, removed, skipped };
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

module.exports = { getKeys, getSubs, saveSubs, sendTo, loadMembers, tierCtx, activeIdSet, adminIds, bossIds, bossOrAdminIds, pmIds, pmOrAdminIds };
