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
const DD = require('./_lib/docdiff');

const FILES = 'gw_files';
const DATA = 'gw_data';
const USERS = 'gw_users';
const BOX_KINDS = { asbestos: 1, bldg: 1, biz: 1, contract: 1 };

// v424 표식 찾기 — 파일 안 번호가 그 계약 서류함의 AI 초안과 맞을 때만 믿는다(개인정보 파일명은 먼저 걸러진다)
async function boxMark(name, b64) {
  if (BJ.nameGuard(name)) return null;
  const ext = String((String(name || '').match(/\.([a-z0-9]+)$/i) || [0, ''])[1]).toLowerCase();
  if (ext !== 'xlsx' && ext !== 'hwpx') return null;
  const buf = Buffer.from(b64, 'base64'), mark = DD.genMarkOf(buf, ext), p = DD.genMarkParse(mark);
  if (!p) return null;
  const ix = await blobGet(store(DATA), 'recidx:' + p.cid);
  const item = (ix.ok && ix.data && Array.isArray(ix.data.items)) ? ix.data.items.find(function (x) { return x && x.kind === 'draft' && x.gen === mark && !x.purged; }) : null;
  if (!item) return null;
  // 지난 계약 파일을 복사해 새 계약 값으로 고친 파일 — 표식은 그대로라 내용이 많이 다르면 믿지 않고 보통 판단으로 보낸다(v424 검토)
  const key = 'cdoc:' + p.cid + ':S' + String(item.i).padStart(2, '0') + ':' + item.dk + ':' + item.n;
  const dr = await blobGet(store(FILES), key);
  if (dr.ok && dr.data) {
    const sc = DD.matchScore(dr.data, item.ext, ext, buf);
    if (sc !== null && sc < 0.5) return null;
  }
  const db = (dr.ok && dr.data && dr.data.data) ? Buffer.from(String(dr.data.data), 'base64') : null;
  return BJ.markJudge(ext, buf, { cid: p.cid, tpl: String(item.dk).slice(4), draftBuf: db });
}
async function boxUsage(res) {
  try {
    const key = 'usage:box:' + LN.ymOf(Date.now()), r = await blobGet(store(DATA), key);
    const u = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
    if (res && res.read === 'mark') { u.mark = (Number(u.mark) || 0) + 1; await blobSet(store(DATA), key, u); return; }   // 표식으로 찾은 파일 — 모델 호출 없음
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
    if (r.ok && r.data && r.data.kind === 'lic') return;   // P1 판28 인허가 수령본은 판독하지 않는다(판독 결과 parse:<id>는 계약 열람권으로 읽힌다)
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
      try { res = await boxMark(r.data.name, b64); } catch (e) { res = null; }
      if (!res) { try { res = await BJ.judgeBox({ name: r.data.name, b64: b64, ctx: (d.ctx && typeof d.ctx === 'object') ? d.ctx : {}, fixes: fixes }); } catch (e) { res = { error: 'PARSE_FAILED' }; } }
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
