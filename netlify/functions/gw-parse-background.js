'use strict';
// 석면조사서 백그라운드 판독 — Netlify Background Function(-background 접미사, 15분 한도).
// 호출 즉시 202 반환, 완료 시 blob 'parse:<attId>'에 결과 저장 → 앱이 att_parse_status로 폴링.
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { claudeExtractAsbestos } = require('./_lib/asbestos');

const FILES = 'gw_files';
const USERS = 'gw_users';

exports.handler = async function (event, context) {
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok) return;
    const m = await blobGet(store(USERS), `member:${v.payload.mid}`);
    if (!m.ok || !m.data || m.data.del === 1) return;
    let d = {};
    try { d = JSON.parse(event.body || '{}'); } catch (e) {}
    const id = String(d.id || '');
    if (!id || id.indexOf('att_') !== 0) return;
    const r = await blobGet(store(FILES), id);
    if (!r.ok || !r.data) { await blobSet(store(FILES), 'parse:' + id, { ts: Date.now(), result: { error: 'NOT_FOUND' } }); return; }
    let parsed = null;
    try { parsed = await claudeExtractAsbestos(Buffer.from(r.data.data, 'base64'), r.data.name, r.data.type); }
    catch (e) { parsed = { error: 'PARSE_FAILED' }; }
    await blobSet(store(FILES), 'parse:' + id, { ts: Date.now(), result: parsed });
  } catch (e) { /* 백그라운드 — 응답 무의미 */ }
};
