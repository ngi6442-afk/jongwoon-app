'use strict';

// 그룹웨어 데이터 (서버측 권한 강제). Netlify Blobs.
// 'gw_data' 저장: col:tasks / col:vehicles / col:receivables / col:licenses / col:checklist
// 권한은 'gw_users'의 회원 레코드(perms)에서 확인. 관리자는 전부 허용.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit, auditKey, diffItems } = require('./_lib/audit');

const DATA = 'gw_data';
const USERS = 'gw_users';
// 컬렉션 → 권한키
const COL = { tasks: 'tasks', vehicles: 'veh', receivables: 'rec', licenses: 'lic', checklist: 'check', documents: 'doc', clients: 'cli', contracts: 'con', leaves: 'leaves', bids: 'bid' };
// 사용자별 비공개 컬렉션(본인만 접근, 회원 id로 분리 저장)
const PRIVATE_COL = { mytasks: true };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function colKey(c) { return `col:${c}`; }

async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
function permOf(member, col) {
  if (member.admin) return 'do';
  const key = COL[col];
  return (member.perms && member.perms[key]) || 'view';
}
// 인가된 기기만 데이터 접근. 관리자는 항상 허용.
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}

async function handleGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (PRIVATE_COL[d.collection]) {
    const pr = await blobGet(store(DATA), `priv:${c.member.id}:${d.collection}`);
    return jr(200, { status: 'OK', collection: d.collection, doc: (pr.ok && pr.data) ? pr.data : { schema: 1, items: [] }, can_write: true, request_id: R });
  }
  const col = d.collection;
  if (!COL[col]) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  // 일감(bids)은 관리자 전용 — 개별 권한과 무관하게 서버측 강제
  if (col === 'bids' && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const p = permOf(c.member, col);
  // tasks: 개인 인박스('내게 온 지시')·홈 미완료지시는 권한과 무관하게 노출해야 하므로 hide여도 읽기 허용.
  // 가시성(담당/전사/공개범위) 필터는 프런트에서. 쓰기는 여전히 'do' 필요.
  if (p === 'hide' && col !== 'tasks') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(DATA), colKey(col));
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  const doc = r.data || { schema: 1, items: [] };
  return jr(200, { status: 'OK', collection: col, doc, can_write: p === 'do', request_id: R });
}

async function handleSave(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (PRIVATE_COL[d.collection]) {
    if (!d.doc || typeof d.doc !== 'object') return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
    const pw = await blobSet(store(DATA), `priv:${c.member.id}:${d.collection}`, Object.assign({}, d.doc, { updated_at: Date.now() }));
    if (!pw.ok) return jr(500, { status: 'ERROR', error_code: pw.code, request_id: R });
    return jr(200, { status: 'OK', request_id: R });
  }
  const col = d.collection;
  if (!COL[col]) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  // tasks: 직원(권한 do 아님)도 '내게 온 지시'를 완료(→승인대기)/보류하려면 저장이 필요 → 승인제 성립.
  // tasks 쓰기는 인증·인가 회원이면 허용(프런트 canActTask로 자기 업무만 조작, UI 권한 구분이지 하드보안 아님).
  if (col === 'bids' && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (permOf(c.member, col) !== 'do' && col !== 'tasks' && col !== 'leaves') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  if (!d.doc || typeof d.doc !== 'object') return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
  // 감사 로그용 이전 문서(diff 원본) — 읽기 실패해도 저장은 진행
  let oldItems = [];
  try { const prev = await blobGet(store(DATA), colKey(col)); if (prev.ok && prev.data && Array.isArray(prev.data.items)) oldItems = prev.data.items; } catch (e) {}
  const doc = Object.assign({}, d.doc, { updated_by: c.member.id, updated_at: Date.now() });
  const w = await blobSet(store(DATA), colKey(col), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 감사 로그: 누가·언제·무엇을(이전값→새값). 서버측 기록이라 클라이언트 위변조 불가.
  try {
    const ev = diffItems(oldItems, Array.isArray(doc.items) ? doc.items : []);
    if (ev.length) await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: col, ev: ev });
  } catch (e) {}
  return jr(200, { status: 'OK', request_id: R });
}

// ---- 일감 수집 공통 ----
// 병합 원칙: 새 id만 추가(status=new). 기존 항목은 원천 메타만 갱신, 앱이 관리하는 status는 절대 보존. 삭제 없음.
function mergeBidItems(doc, items) {
  const byId = {};
  doc.items.forEach(function (it) { if (it && it.id) byId[it.id] = it; });
  const today = new Date().toISOString().slice(0, 10);
  let added = 0, updated = 0;
  for (const n of (items || [])) {
    if (!n || !n.id) continue;
    const cur = byId[n.id];
    if (!cur) {
      doc.items.push({ id: n.id, source: n.source || '', kind: n.kind || '입찰', title: n.title || '', org: n.org || '',
        region: n.region || '', due: n.due || '', budget: n.budget || 0, url: n.url || '',
        matched: Array.isArray(n.matched) ? n.matched : [], status: 'new', created: today, updated: today });
      byId[n.id] = doc.items[doc.items.length - 1];
      added++;
    } else {
      let ch = false;
      ['title', 'org', 'region', 'due', 'budget', 'url'].forEach(function (k) { if (n[k] && n[k] !== cur[k]) { cur[k] = n[k]; ch = true; } });
      if (ch) { cur.updated = today; updated++; }
    }
  }
  return { added: added, updated: updated };
}
async function saveBidsDoc(st, doc, by, added, updated, R) {
  doc.updated_by = by; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('bids'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: by, bid: 'bot', col: 'bids', ev: [{ op: '수집', id: '', t: '신규 ' + added + ' · 갱신 ' + updated }] }); } catch (e) {}
  return null;
}

// 일감 수집 ingest(수집봇 전용) — 공유 시크릿(BIDS_INGEST_KEY) 인증, 세션 불필요.
async function handleBidsIngest(event, d, R) {
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  if (!secret || String(d.key || '').trim() !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  if (!Array.isArray(d.items)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_ITEMS', request_id: R });
  const st = store(DATA);
  const r = await blobGet(st, colKey('bids'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const m = mergeBidItems(doc, d.items);
  if (m.added || m.updated) {
    const err = await saveBidsDoc(st, doc, '수집봇', m.added, m.updated, R);
    if (err) return err;
  }
  return jr(200, { status: 'OK', added: m.added, updated: m.updated, total: doc.items.length, request_id: R });
}

// 지금 수집(관리자 버튼) — 서버가 나라장터 API를 직접 조회해 병합. G2B_API_KEY(Netlify env) 필요. 10분 쿨다운.
const BID_KEYWORDS = ["준설","퇴적토","하상","관로","관거","차집","맨홀","상수도","하수","급수","배수지","정수장","취수","가압장","누수",
  "CCTV조사","불명수","석면","슬레이트","해체","철거","폐기물","수집운반","운반"];
const BID_REGIONS = ["포항","경북","경상북도","경주","영덕","울진","대구","경산","영천","구미","안동","김천","문경","상주",
  "의성","청송","영양","봉화","예천","성주","칠곡","고령","청도","울릉"];
const G2B_BASE = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/";
const G2B_OPS = ["getBidPblancListInfoServc", "getBidPblancListInfoCnstwk"];   // 용역, 공사
async function handleBidsRefresh(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const key = (process.env.G2B_API_KEY || '').trim();
  if (!key) return jr(400, { status: 'REJECTED', error_code: 'NO_G2B_KEY', request_id: R });
  const st = store(DATA);
  const now = Date.now();
  const COOLDOWN = 10 * 60 * 1000;
  const cd = await blobGet(st, 'bids:lastfetch');
  if (cd.ok && cd.data && cd.data.ts && (now - cd.data.ts) < COOLDOWN) {
    return jr(429, { status: 'COOLDOWN', retry_after: Math.ceil((COOLDOWN - (now - cd.data.ts)) / 1000), request_id: R });
  }
  await blobSet(st, 'bids:lastfetch', { ts: now });
  // 최근 1일(버튼은 당일 신규 확인용 — 3일 창은 아침 cron이 커버). 함수 시간제한 대비 페이지 상한.
  function fmt(t) { const dt = new Date(t); const p = (n) => String(n).padStart(2, '0'); return '' + dt.getFullYear() + p(dt.getMonth() + 1) + p(dt.getDate()); }
  const bgn = fmt(now - 1 * 86400000) + '0000', end = fmt(now) + '2359';
  // 참가가능지역 맵(행 없음=전국). 우리(경북 포항) 자격 있는 공고만 수집.
  const rgnMap = {};
  {
    let page = 1;
    while (page <= 4) {
      const q = new URLSearchParams({ serviceKey: key, inqryDiv: '1', type: 'json', inqryBgnDt: bgn, inqryEndDt: end, pageNo: String(page), numOfRows: '999' });
      const resp = await fetch(G2B_BASE + 'getBidPblancListInfoPrtcptPsblRgn?' + q.toString());
      if (!resp.ok) break;
      const j = await resp.json();
      const body = ((j || {}).response || {}).body || {};
      let items = body.items || [];
      if (items && items.item) items = items.item;
      if (!Array.isArray(items)) items = items ? [items] : [];
      for (const it of items) {
        const k = (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '');
        (rgnMap[k] = rgnMap[k] || []).push(it.prtcptPsblRgnNm || '');
      }
      if (page * 999 >= Number(body.totalCount || 0)) break;
      page++;
    }
  }
  function rgnEligible(names) {
    if (!names || !names.length) return true;   // 지역 행 없음 = 전국
    for (let nm of names) {
      nm = String(nm || '').trim();
      if (!nm) continue;
      if (nm.indexOf('전국') >= 0 || nm.indexOf('제한없음') >= 0) return true;
      if (nm.indexOf('포항') >= 0) return true;
      const flat = nm.replace(/ /g, '');
      if (flat === '경상북도' || flat === '경북') return true;   // 도 단위 제한(타 시군 제한은 제외)
    }
    return false;
  }
  const found = [];
  for (const op of G2B_OPS) {
    let page = 1;
    while (page <= 3) {
      const q = new URLSearchParams({ serviceKey: key, inqryDiv: '1', type: 'json', inqryBgnDt: bgn, inqryEndDt: end, pageNo: String(page), numOfRows: '999' });
      const resp = await fetch(G2B_BASE + op + '?' + q.toString());
      if (!resp.ok) throw new Error('G2B HTTP ' + resp.status);
      const j = await resp.json();
      const body = ((j || {}).response || {}).body || {};
      let items = body.items || [];
      if (items && items.item) items = items.item;
      if (!Array.isArray(items)) items = items ? [items] : [];
      for (const it of items) {
        const nm = it.bidNtceNm || '';
        const org = it.ntceInsttNm || it.dminsttNm || '';
        const flat = nm.replace(/ /g, '');
        const kw = BID_KEYWORDS.filter((k) => flat.indexOf(k) >= 0);
        if (!kw.length) continue;
        if (!rgnEligible(rgnMap[(it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '')])) continue;   // 지역제한 미해당 제외
        const regTxt = org + ' ' + (it.rgnLmtBidLocplcNm || '');
        const reg = BID_REGIONS.find((g) => regTxt.indexOf(g) >= 0) || '';
        let budget = 0; const bp = Number(it.presmptPrce || 0); if (!isNaN(bp)) budget = Math.floor(bp);
        found.push({ id: 'g2b-' + (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || ''), source: '나라장터', kind: '입찰',
          title: nm, org: org, region: reg, due: String(it.bidClseDt || '').slice(0, 10).replace(/[./]/g, '-'),
          budget: budget, url: it.bidNtceUrl || it.bidNtceDtlUrl || '', matched: kw });
      }
      const total = Number(body.totalCount || 0);
      if (page * 999 >= total) break;
      page++;
    }
  }
  const r = await blobGet(st, colKey('bids'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const m = mergeBidItems(doc, found);
  if (m.added || m.updated) {
    const err = await saveBidsDoc(st, doc, c.member.name, m.added, m.updated, R);
    if (err) return err;
  }
  return jr(200, { status: 'OK', scanned: found.length, added: m.added, updated: m.updated, total: doc.items.length, request_id: R });
}

// 일감 비우기(관리자) — mode:'new'=미검토(new)만 제거(검토/참여/패스 보존), 'all'=전체 제거. 재수집용.
async function handleBidsPurge(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const r = await blobGet(st, colKey('bids'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const before = doc.items.length;
  doc.items = (d.mode === 'all') ? [] : doc.items.filter(function (it) { return it && it.status && it.status !== 'new'; });
  const removed = before - doc.items.length;
  doc.updated_by = c.member.id; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('bids'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 쿨다운도 해제해 바로 재수집 가능하게
  try { await blobSet(st, 'bids:lastfetch', { ts: 0 }); } catch (e) {}
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'bids', ev: [{ op: '비우기', id: '', t: (d.mode === 'all' ? '전체' : '미검토') + ' ' + removed + '건 제거' }] }); } catch (e) {}
  return jr(200, { status: 'OK', removed: removed, total: doc.items.length, request_id: R });
}

// 감사 로그 조회(관리자 전용). month='YYYY-MM' 미지정 시 이번 달.
async function handleAudit(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const key = auditKey(d.month);
  const r = await blobGet(store(DATA), key);
  const doc = (r.ok && r.data) ? r.data : { schema: 1, items: [] };
  return jr(200, { status: 'OK', month: key.slice(6), doc: doc, request_id: R });
}

async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { status: 'REJECTED', error_code: 'INVALID_JSON', request_id: R }); }
  try {
    if (d && d.action === 'get') return await handleGet(event, d, R);
    if (d && d.action === 'save') return await handleSave(event, d, R);
    if (d && d.action === 'audit') return await handleAudit(event, d, R);
    if (d && d.action === 'bids_ingest') return await handleBidsIngest(event, d, R);
    if (d && d.action === 'bids_refresh') return await handleBidsRefresh(event, d, R);
    if (d && d.action === 'bids_purge') return await handleBidsPurge(event, d, R);
    return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
