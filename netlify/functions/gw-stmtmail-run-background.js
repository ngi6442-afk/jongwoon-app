'use strict';
// 29 판⑦ 메일 에이전트 워커 — Netlify Background Function(15분). gw-stmtmail-cron·gw-stmt stmt_mail_run이 내부 토큰(mid='__stmtmail__')으로만 기동한다.
// 할 일은 _lib/stmtmail.js run() — 메일함 읽기 전용 · 첨부만 · 월 목록 첨부(stmtdrop)로. 결과 요약 = gw_data stmt:mail:last(숫자·코드만).
// 겹쳐 돌지 않게 stmt:mail:lock(14분) — 예약과 [지금 받기]가 겹치면 뒤엣것은 그냥 끝남.
const { setupBlobContext, store, blobGet, blobSet, blobList, blobDelete } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const { stamp } = require('./_lib/cronstamp');
const S = require('./_lib/stmt');
const M = require('./_lib/stmtmail');
const IMAP = require('./_lib/stmtimap');

const DATA = 'gw_data', FILES = 'gw_files', USERS = 'gw_users';
const LOCK = 'stmt:mail:lock', LOCK_MS = 14 * 60 * 1000;
const BUDGET = { total: 12 * 60 * 1000, ai: 10 * 60 * 1000 };

async function vendors(st) {
  const r = await blobGet(st, 'stmt:cfg');
  if (!r.ok) return null;
  if (r.data === null || r.data === undefined) return S.seedVendors();
  const c = (typeof r.data === 'object' && !Array.isArray(r.data)) ? S.cleanVendors(r.data.vendors) : {};
  return c.v || null;
}
async function memberNames() {   // gw-stmt-read-background와 같은 규칙 — 판독 출력에서 회원 이름을 걸러냄
  try {
    const l = await blobList(store(USERS), 'member:');
    const keys = (l.ok && Array.isArray(l.keys)) ? l.keys.slice(0, 200) : [];
    const out = [];
    for (const k of keys) { const r = await blobGet(store(USERS), k); if (r.ok && r.data && r.data.name) out.push(String(r.data.name).trim()); }
    return out.filter(function (n) { return n.length >= 2; });
  } catch (e) { return []; }
}
async function usage(ym, res) {
  try {
    const key = 'usage:stmt:' + ym, r = await blobGet(store(DATA), key);
    const u = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
    u.calls = (Number(u.calls) || 0) + 1;
    u.in = (Number(u.in) || 0) + (Number(res && res.usage && res.usage.in) || 0);
    u.out = (Number(u.out) || 0) + (Number(res && res.usage && res.usage.out) || 0);
    if (!res || !res.ok) u.err = (Number(u.err) || 0) + 1;
    await blobSet(store(DATA), key, u);
  } catch (e) {}
}

exports.handler = async function (event, context) {
  const v = verifyToken(bearer(event));
  if (!v.ok || v.payload.mid !== M.BOT) return;
  let d = {};
  try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
  const by = String(d.by || 'cron').slice(0, 40);
  let st;
  try { setupBlobContext(event, context); st = store(DATA); } catch (e) { return; }
  const end = async function (sum) {
    sum.by = by;
    await blobSet(st, M.LAST, sum);
    if (by === 'cron') await stamp('gw-stmtmail-cron', { state: 'end', ok: !!sum.ok, note: (sum.ok ? ('새 ' + (sum.added || 0) + ' · 읽음 ' + (sum.read || 0) + ' · 고르기 ' + (sum.nov || 0) + (sum.fail ? ' · 실패 ' + sum.fail : '')) : sum.code).slice(0, 80) });
  };
  const env = M.mailEnv();
  if (!env) { await end({ at: Date.now(), ok: false, code: 'MAIL_NOT_SET' }); return; }
  const lk = await blobGet(st, LOCK);
  if (lk.ok && lk.data && Date.now() - (Number(lk.data.at) || 0) < LOCK_MS) return;
  await blobSet(st, LOCK, { at: Date.now(), by: by });
  let mb = null;
  try {
    const cfg = await vendors(st);
    if (!cfg) { await end({ at: Date.now(), ok: false, code: 'CFG_INVALID' }); return; }
    try { mb = await IMAP.openImap(env); } catch (e) { await end({ at: Date.now(), ok: false, code: M.errCode(e) }); return; }
    const sum = await M.run({
      st: st, fst: store(FILES), blobGet: blobGet, blobSet: blobSet, blobList: blobList, blobDelete: blobDelete, mailbox: mb, cfg: cfg,
      names: memberNames, usage: usage, now: Date.now, budget: BUDGET,
      audit: async function (op, id, t) { try { await appendAudit({ ts: Date.now(), by: '메일 에이전트', bid: M.BOT, col: 'stmt', ev: [{ op: op, id: id, t: t }] }); } catch (e) {} },
    });
    await end(sum);
  } catch (e) {
    try { console.log('[gw-stmtmail] ' + String((e && e.message) || e).slice(0, 200)); } catch (e2) {}
    await end({ at: Date.now(), ok: false, code: 'MAIL_RUN_FAILED' });
  } finally {
    if (mb) await mb.close();
    try { await blobDelete(st, LOCK); } catch (e) {}
  }
};
