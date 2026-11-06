'use strict';
// 첨부 백그라운드 판독 — Netlify Background Function(-background 접미사, 15분 한도).
// 호출 즉시 202 반환, 완료 시 blob 'parse:<attId>'에 결과 저장 → 앱이 att_parse_status로 폴링.
// v423 넣기 박스: {box:1, ctx} = 종류 판단(_lib/boxjudge) · {box:1, kind} = 판단 뒤 전용 판독(석면조사서·사업자등록증 등 — 앞선 판단은 judge로 보존).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { parseAttachment } = require('./_lib/asbestos');
const BF = require('./_lib/boxfile');
const BJ = require('./_lib/boxjudge');
const LN = require('./_lib/learn');

const FILES = 'gw_files';
const DATA = 'gw_data';
const USERS = 'gw_users';
const BOX_KINDS = { asbestos: 1, bldg: 1, biz: 1, contract: 1 };

async function boxUsage(res) {
  try {
    const key = 'usage:box:' + LN.ymOf(Date.now()), r = await blobGet(store(DATA), key);
    const u = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
    u.calls = (Number(u.calls) || 0) + 1;
    u.in = (Number(u.in) || 0) + (Number(res && res.usage && res.usage.in) || 0);
    u.out = (Number(u.out) || 0) + (Number(res && res.usage && res.usage.out) || 0);
    if (res && res.error) u.err = (Number(u.err) || 0) + 1;
    await blobSet(store(DATA), key, u);
  } catch (e) { /* 사용량 기록 실패가 판독을 막지 않는다 */ }
}

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
    const isBox = d.box === 1 || d.box === true;
    if (!r.ok || !r.data) {
      if (isBox) return;   // v423 이미 버렸거나 서류함으로 들어간 파일 — 판단 원본을 덮지 않는다
      await blobSet(store(FILES), 'parse:' + id, { ts: Date.now(), result: { error: 'NOT_FOUND' } });
      return;
    }
    if (r.data.kind === 'box') {
      if (r.data.bid !== m.data.id && !m.data.admin) return;   // 올린 사람(또는 관리자)만 판독 요금을 쓴다
      if (!m.data.admin && !(m.data.perms && m.data.perms.con === 'do')) return;
      const owner = r.data.bid;
      const save = async function (rec) {   // 판단 중 카드를 버렸으면 결과를 쓰지 않는다
        const still = await blobGet(store(FILES), id);
        if (!still.ok || !still.data) return false;
        await blobSet(store(FILES), 'parse:' + id, Object.assign({ ts: Date.now(), bid: owner }, rec));
        return true;
      };
      let b64 = '';
      try { b64 = await BF.attReadB64(store(FILES), id, r.data); }
      catch (e) { await save({ result: { error: 'PART_MISSING' } }); return; }
      const want = String(d.kind || '');
      if (BOX_KINDS[want] === 1) {   // 전용 판독 — 앞선 종류 판단은 지우지 않는다. 개인정보 파일명은 여기서도 모델에 보내지 않는다
        const prev = await blobGet(store(FILES), 'parse:' + id);
        if (BJ.nameGuard(r.data.name)) { await save({ result: { error: 'PII_NAME' }, judge: (prev.ok && prev.data) ? prev.data.result : null }); return; }
        let parsed = null;
        try { parsed = await parseAttachment({ name: r.data.name, kind: want, type: r.data.type, data: b64 }); } catch (e) { parsed = { error: 'PARSE_FAILED' }; }
        await save({ result: parsed || { error: 'UNSUPPORTED_TYPE' }, judge: (prev.ok && prev.data) ? prev.data.result : null });
        return;
      }
      let fixes = [];
      try { const fr = await blobGet(store(DATA), 'box:fixes'); if (fr.ok && fr.data && Array.isArray(fr.data.items)) fixes = fr.data.items; } catch (e) {}
      let res = null;
      try { res = await BJ.judgeBox({ name: r.data.name, b64: b64, ctx: (d.ctx && typeof d.ctx === 'object') ? d.ctx : {}, fixes: fixes }); } catch (e) { res = { error: 'PARSE_FAILED' }; }
      await save({ result: res });
      if (!res || res.read !== 'none') await boxUsage(res);
      return;
    }
    if (isBox) return;
    let parsed = null;
    try { parsed = await parseAttachment(r.data); }
    catch (e) { parsed = { error: 'PARSE_FAILED' }; }
    await blobSet(store(FILES), 'parse:' + id, { ts: Date.now(), result: parsed });
  } catch (e) { /* 백그라운드 — 응답 무의미 */ }
};
