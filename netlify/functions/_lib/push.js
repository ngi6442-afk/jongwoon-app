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

// payload: {title, body, url, tag}
async function sendTo(memberIds, payload) {
  const keys = await getKeys();
  webpush.setVapidDetails('mailto:ngi6442@gmail.com', keys.publicKey, keys.privateKey);
  const doc = await getSubs();
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0;
  for (const mid of memberIds) {
    const subs = doc.members[mid] || [];
    for (let i = subs.length - 1; i >= 0; i--) {
      try {
        await webpush.sendNotification(subs[i].sub, body, { TTL: 3600 });
        sent++;
      } catch (e) {
        const sc = e && e.statusCode;
        if (sc === 404 || sc === 410) { subs.splice(i, 1); removed++; }
      }
    }
    if (subs.length) doc.members[mid] = subs; else delete doc.members[mid];
  }
  if (removed) { try { await saveSubs(doc); } catch (e) {} }
  return { sent, removed };
}

module.exports = { getKeys, getSubs, saveSubs, sendTo, adminIds };
