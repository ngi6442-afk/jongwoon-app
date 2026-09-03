'use strict';

// 웹푸시 — VAPID 키는 최초 사용 시 서버가 생성해 Blobs에 보관(환경변수 불필요).
// 구독은 push:subs 에 회원 id별로 저장. 만료(404/410) 구독은 발송 시 자동 제거.
const webpush = require('web-push');
const { store, blobGet, blobSet, blobList } = require('./blobs');

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

// 관리자 회원 id 목록(개찰결과 등 전사 알림 대상)
async function adminIds() {
  const st = store(USERS);
  const l = await blobList(st);
  if (!l.ok) return [];
  const out = [];
  for (const k of l.keys) {
    if (k.indexOf('member:') !== 0) continue;
    const r = await blobGet(st, k);
    if (r.ok && r.data && r.data.admin && r.data.del !== 1) out.push(r.data.id);
  }
  return out;
}

// payload: {title, body, url, tag} / opts: {primaryOnly}
// primaryOnly=true(결재 2차, 배치도 결정 ③ "알림=우선기기 1발"): 회원별로 primary 구독이 있으면
// 그 기기에만 보낸다. primary 미지정 회원은 전 구독 폴백 — 우선기기를 안 정한 사람이
// 알림을 아예 못 받는 사고 방지. 만료(404/410) 제거는 현행 유지.
async function sendTo(memberIds, payload, opts) {
  // 알림함(push:log) — 폰 팝업이 지나가면 다시 볼 곳이 없다는 PM 지적(2026-08-20).
  // 발송 전에 남기고(구독이 없어도 이력은 남게), 이력 실패가 발송을 막지 않는다. 최근 100건 링.
  try {
    const lr = await blobGet(store(DATA), 'push:log');
    const ldoc = (lr.ok && lr.data && Array.isArray(lr.data.items)) ? lr.data : { schema: 1, items: [] };
    ldoc.items.push({ ts: Date.now(), title: String(payload.title || ''), body: String(payload.body || ''),
      url: String(payload.url || ''), tag: String(payload.tag || ''), to: memberIds.slice(0, 30) });
    if (ldoc.items.length > 100) ldoc.items = ldoc.items.slice(-100);
    await blobSet(store(DATA), 'push:log', ldoc);
  } catch (e) {}
  const keys = await getKeys();
  webpush.setVapidDetails('mailto:ngi6442@gmail.com', keys.publicKey, keys.privateKey);
  const doc = await getSubs();
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0;
  for (const mid of memberIds) {
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
  return { sent, removed };
}

// 대표 회원 id — 클라 isBossMember와 같은 축(role '대표' 또는 이름 나종운, admin 한정). 운반일지 결재 라우팅 전용(9/3 PM 결정).
function isBoss(m) { return !!(m && m.admin && m.del !== 1 && (String(m.role || '') === '대표' || String(m.name || '') === '나종운')); }
async function bossIds() {
  const st = store(USERS);
  const l = await blobList(st);
  if (!l.ok) return [];
  const out = [];
  for (const k of l.keys) {
    if (k.indexOf('member:') !== 0) continue;
    const r = await blobGet(st, k);
    if (r.ok && r.data && isBoss(r.data)) out.push(r.data.id);
  }
  return out;
}
// 대표 전용 건의 결재 요청 수신자 — 대표가 없으면(계정 role 불일치 등) 관리자 전원으로 폴백해 결재가 끊기지 않게 한다
async function bossOrAdminIds() { const b = await bossIds(); return b.length ? b : await adminIds(); }

module.exports = { getKeys, getSubs, saveSubs, sendTo, adminIds, bossIds, bossOrAdminIds, isBoss };
