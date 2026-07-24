'use strict';

// 그룹웨어 데이터 (서버측 권한 강제). Netlify Blobs.
// 'gw_data' 저장: col:tasks / col:vehicles / col:receivables / col:licenses / col:checklist
// 권한은 'gw_users'의 회원 레코드(perms)에서 확인. 관리자는 전부 허용.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet, blobDelete } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit, auditKey, diffItems } = require('./_lib/audit');

const DATA = 'gw_data';
const USERS = 'gw_users';
// 컬렉션 → 권한키
const COL = { tasks: 'tasks', vehicles: 'veh', receivables: 'rec', licenses: 'lic', checklist: 'check', documents: 'doc', clients: 'cli', contracts: 'con', leaves: 'leaves', bids: 'bid', onbid: 'bid' };  // onbid=공매·부동산(관리자 전용)
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
  // 일감(bids)·공매(onbid)는 관리자 전용 — 개별 권한과 무관하게 서버측 강제
  if ((col === 'bids' || col === 'onbid') && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
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
  if ((col === 'bids' || col === 'onbid') && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
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
        matched: Array.isArray(n.matched) ? n.matched : [], method: n.method || '', rgn_ref: !!n.rgn_ref, appr: n.appr || 0,
        no: n.no || '', posted: n.posted || '', docs: Array.isArray(n.docs) ? n.docs : [], ext: (n.ext && typeof n.ext === 'object') ? n.ext : {},
        status: (n.status === '패스' ? '패스' : 'new'), auto_pass: !!n.auto_pass, created: today, updated: today });
      byId[n.id] = doc.items[doc.items.length - 1];
      added++;
    } else {
      let ch = false;
      ['title', 'org', 'region', 'due', 'budget', 'url', 'method', 'appr', 'kind', 'no', 'posted'].forEach(function (k) { if (n[k] && n[k] !== cur[k]) { cur[k] = n[k]; ch = true; } });
      if (Array.isArray(n.docs) && n.docs.length && JSON.stringify(n.docs) !== JSON.stringify(cur.docs || [])) { cur.docs = n.docs; ch = true; }
      if (n.ext && typeof n.ext === 'object' && Object.keys(n.ext).length) {
        const mergedExt = Object.assign({}, cur.ext || {}, n.ext);   // 키 단위 병합 — 공고문 파싱값 보존
        if (JSON.stringify(mergedExt) !== JSON.stringify(cur.ext || {})) { cur.ext = mergedExt; ch = true; }
      }
      if (cur.rgn_ref && n.rgn_ref === false) { cur.rgn_ref = false; ch = true; }   // 공고서 판독 확인 반영
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
  const target = (d.col === 'onbid') ? 'onbid' : 'bids';
  const st = store(DATA);
  const r = await blobGet(st, colKey(target));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const m = mergeBidItems(doc, d.items);
  // 수집 헬스(실패 어댑터·마지막 실행시각) — 변경 없어도 항상 갱신해 앱 배너가 최신을 보게
  let hasHealth = false;
  if (target === 'bids' && d.health && typeof d.health === 'object' && Array.isArray(d.health.adapters)) {
    doc.health = { ts: Number(d.health.ts) || Date.now(),
      adapters: d.health.adapters.slice(0, 20).map(function (a) {
        return { name: String(a.name || '').slice(0, 30), ok: !!a.ok, count: Number(a.count) || 0, error: String(a.error || '').slice(0, 160) };
      }) };
    hasHealth = true;
  }
  // 낙찰 투찰률 실측 통계(계산기 참고선) — 용역/공사 사분위 + 기관별 중앙값
  let hasAwards = false;
  if (target === 'bids' && d.awards && typeof d.awards === 'object') {
    const a = d.awards, aw = { ts: Number(a.ts) || Date.now(), basis: String(a.basis || '').slice(0, 80) };
    ['servc', 'cnstwk'].forEach(function (k) {
      if (a[k] && typeof a[k] === 'object') aw[k] = { n: Number(a[k].n) || 0, q1: Number(a[k].q1) || 0, med: Number(a[k].med) || 0, q3: Number(a[k].q3) || 0 };
    });
    aw.orgs = {};
    if (a.orgs && typeof a.orgs === 'object') {
      Object.keys(a.orgs).slice(0, 80).forEach(function (org) {
        const o = a.orgs[org] || {};
        aw.orgs[String(org).slice(0, 40)] = { n: Number(o.n) || 0, med: Number(o.med) || 0 };
      });
    }
    aw.lwlt = {};
    if (a.lwlt && typeof a.lwlt === 'object') {   // 명기 하한율 최빈값(유형·금액구간별)
      Object.keys(a.lwlt).slice(0, 20).forEach(function (k) {
        const o = a.lwlt[k] || {};
        aw.lwlt[String(k).slice(0, 20)] = { mode: String(o.mode || '').slice(0, 8), n: Number(o.n) || 0 };
      });
    }
    doc.awards = aw; hasAwards = true;
  }
  if (m.added || m.updated || hasHealth || hasAwards) {
    doc.updated_by = '수집봇'; doc.updated_at = Date.now();
    const w = await blobSet(st, colKey(target), doc);
    if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
    if (m.added || m.updated) { try { await appendAudit({ ts: Date.now(), by: '수집봇', bid: 'bot', col: target, ev: [{ op: '수집', id: '', t: '신규 ' + m.added + ' · 갱신 ' + m.updated }] }); } catch (e) {} }
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
  // 함수 시간제한(10s) 대비 — 모든 G2B 호출을 병렬로 실행
  async function g2bFetch(op, page) {
    const q = new URLSearchParams({ serviceKey: key, inqryDiv: '1', type: 'json', inqryBgnDt: bgn, inqryEndDt: end, pageNo: String(page), numOfRows: '999' });
    const resp = await fetch(G2B_BASE + op + '?' + q.toString());
    if (!resp.ok) throw new Error('G2B HTTP ' + resp.status);
    const j = await resp.json();
    const body = ((j || {}).response || {}).body || {};
    let items = body.items || [];
    if (items && items.item) items = items.item;
    if (!Array.isArray(items)) items = items ? [items] : [];
    return { items: items, total: Number(body.totalCount || 0) };
  }
  async function g2bAll(op, maxPages) {
    const first = await g2bFetch(op, 1);
    let items = first.items;
    const pages = Math.min(maxPages, Math.ceil(first.total / 999));
    const rest = [];
    for (let p = 2; p <= pages; p++) rest.push(g2bFetch(op, p));
    (await Promise.all(rest)).forEach(function (r) { items = items.concat(r.items); });
    return items;
  }
  // 공동주택(K-apt) — 사이트 목록 직접 조회(공식 API는 2024-02에서 멈춘 폐물). 경북 소재, 최근 3일.
  async function kaptFetch() {
    const LIST = 'https://www.k-apt.go.kr/bid/bidList.do';
    const r1 = await fetch(LIST, { headers: { 'User-Agent': 'Mozilla/5.0 (jongwoon-app)' } });
    const html1 = await r1.text();
    const mc = html1.match(/name="_csrf" content="([^"]+)"/);
    if (!mc) return [];
    const setc = (typeof r1.headers.getSetCookie === 'function') ? r1.headers.getSetCookie() : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
    const cookie = setc.map((s) => String(s).split(';')[0]).join('; ');
    const iso = (t) => { const dt = new Date(t); const p = (n) => String(n).padStart(2, '0'); return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()); };
    const body = new URLSearchParams({ pageSelect: '100', searchBidGb: 'bid_gb_1', bidTitle: '', aptName: '',
      searchDateGb: 'reg', dateStart: iso(now - 3 * 86400000), dateEnd: iso(now), dateArea: '3',
      bidState: '', codeAuth: '', codeWay: '', codeAuthSub: '', codeSucWay: '',
      codeClassifyType1: '', codeClassifyType2: '', codeClassifyType3: '',
      pageNo: '1', type: '4', bidArea: '47', bidNum: '', bidNo: '', mainKaptCode: '', aptCode: '', _csrf: mc[1] });
    const r2 = await fetch(LIST, { method: 'POST', body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRF-TOKEN': mc[1], 'Cookie': cookie, 'Referer': LIST, 'User-Agent': 'Mozilla/5.0 (jongwoon-app)' } });
    const html2 = await r2.text();
    const out = [];
    const trRe = /<tr[^>]*class="notice-row"[^>]*dataId="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g;
    const today = iso(now);
    let m;
    while ((m = trRe.exec(html2))) {
      const tds = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g; let t;
      while ((t = tdRe.exec(m[2]))) tds.push(t[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
      if (tds.length < 8) continue;
      const title = tds[3].replace(/^\[[^\]]+\]\s*/, '');
      const due = (tds[4] || '').slice(0, 10);
      if (due && due < today) continue;
      const flat = title.replace(/ /g, '');
      const kw = BID_KEYWORDS.filter((k) => flat.indexOf(k) >= 0);
      if (!kw.length) continue;
      if (!mthdEligible(tds[2], '')) continue;
      out.push({ id: 'kapt-' + m[1], source: '공동주택', kind: '공사·용역', title: title, org: tds[6],
        region: '경북(소재)', due: due, budget: 0,
        url: 'https://www.k-apt.go.kr/bid/bidDetail.do?type=4&bidNum=' + encodeURIComponent(m[1]),
        matched: kw, method: tds[2] + (tds[5] ? '·' + tds[5] : ''), rgn_ref: false,
        no: m[1], posted: (tds[7] || '').slice(0, 10) });
    }
    return out;
  }
  const [rgnRows, licAllRows, servcItems, cnstwkItems, kaptItems, bsisServc, bsisCnstwk] = await Promise.all([
    g2bAll('getBidPblancListInfoPrtcptPsblRgn', 4),
    g2bAll('getBidPblancListInfoLicenseLimit', 4),
    g2bAll('getBidPblancListInfoServc', 3),
    g2bAll('getBidPblancListInfoCnstwk', 3),
    kaptFetch().catch(function () { return []; }),   // K-apt 실패해도 나라장터 수집은 계속
    g2bAll('getBidPblancListInfoServcBsisAmount', 2).catch(function () { return []; }),
    g2bAll('getBidPblancListInfoCnstwkBsisAmount', 2).catch(function () { return []; }),
  ]);
  // 기초금액·예가범위 맵(상세 표시용)
  const bsisMap = {};
  for (const it of bsisServc.concat(bsisCnstwk)) {
    const k = (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '');
    const b = String(it.rsrvtnPrceRngBgnRate || '').trim(), e2 = String(it.rsrvtnPrceRngEndRate || '').trim();
    let aamt = 0;
    if (String(it.bidPrceCalclAYn || '') === 'Y') {
      const fs = ['npnInsrprm', 'mrfnHealthInsrprm', 'odsnLngtrmrcprInsrprm', 'rtrfundNon', 'sftyMngcst', 'sftyChckMngcst', 'envCnsrvcst', 'scontrctPayprcePayGrntyFee'];
      if (String(it.qltyMngcstAObjYn || '') === 'Y') fs.push('qltyMngcst');   // 품질관리비는 별도 플래그
      fs.forEach(function (f) { aamt += Math.floor(Number(it[f] || 0)) || 0; });
    }
    bsisMap[k] = { bss: Math.floor(Number(it.bssamt || 0)) || 0, rng: (b || e2) ? (b + '% ~ ' + e2 + '%') : '', aamt: aamt };
  }
  // 참가가능지역 맵(행 없음=전국)
  const rgnMap = {};
  for (const it of rgnRows) {
    const k = (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '');
    (rgnMap[k] = rgnMap[k] || []).push(it.prtcptPsblRgnNm || '');
  }
  function rgnEligible(names) {
    // 반환 {ok, ref, lbl} — lbl=실제 지역제한 내용(전국/경상북도/포항/공고서 참조)
    if (!names || !names.length) return { ok: true, ref: false, lbl: '전국' };
    let ref = false;
    for (let nm of names) {
      nm = String(nm || '').trim();
      if (!nm) continue;
      if (nm.indexOf('참조') >= 0 || nm.indexOf('공고서') >= 0) { ref = true; continue; }
      if (nm.indexOf('전국') >= 0 || nm.indexOf('제한없음') >= 0) return { ok: true, ref: false, lbl: '전국' };
      if (nm.indexOf('포항') >= 0) return { ok: true, ref: false, lbl: '포항' };
      const flat = nm.replace(/ /g, '');
      if (flat === '경상북도' || flat === '경북') return { ok: true, ref: false, lbl: '경상북도' };
    }
    return ref ? { ok: true, ref: true, lbl: '공고서 참조' } : { ok: false, ref: false, lbl: '' };
  }
  // 낙찰방법: 수의시담·다자간수의시담·지명경쟁은 지명업체 전용 → 제외
  function mthdEligible(a, b) {
    for (const nm of [a, b]) { const s = String(nm || ''); if (s.indexOf('시담') >= 0 || s.indexOf('지명') >= 0) return false; }
    return true;
  }
  // 업종(면허)제한 — 종운 보유 9종 대조. 제한 있는데 우리 업종 없으면 참가 불가.
  const OUR_LIC = [['1226','폐기물수집운반'],['1227','폐기물수집운반'],['1229','폐기물수집운반(지정)'],['4996','상하수도설비'],['6728','건설폐기물수운'],['6786','폐기물종합재활용'],['0012','구조물해체비계'],['4995','구조물해체비계'],['5652','석면해체제거']];
  const LIC_KEYS = ['폐기물수집','상하수도설비','건설폐기물','폐기물종합재활용','구조물해체','비계','석면해체'];
  function licMatch(names) {
    const hits = [];
    for (const nm of (names || [])) {
      const raw = String(nm || '');
      const flat = raw.replace(/[·ㆍ•. ]/g, '');
      for (const [code, label] of OUR_LIC) { if (raw.indexOf('/' + code) >= 0 && hits.indexOf(label) < 0) hits.push(label); }
      for (const k of LIC_KEYS) { if (flat.indexOf(k) >= 0 && hits.indexOf(k) < 0) hits.push(k); }
    }
    return hits;
  }
  // 면허제한 맵
  const licMap = {};
  for (const it of licAllRows) {
    const k = (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '');
    (licMap[k] = licMap[k] || []).push(String(it.lcnsLmtNm || '') + ' ' + String(it.permsnIndstrytyList || ''));
  }
  const found = [];
  {
    {
      const items = servcItems.concat(cnstwkItems);
      for (const it of items) {
        const nm = it.bidNtceNm || '';
        const org = it.ntceInsttNm || it.dminsttNm || '';
        const flat = nm.replace(/ /g, '');
        const kw = BID_KEYWORDS.filter((k) => flat.indexOf(k) >= 0);
        const bkey = (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '');
        const licRows = licMap[bkey];
        const licHits = licMatch(licRows);
        if (licRows && licRows.length && !licHits.length) continue;   // 업종제한 미해당 → 참가 불가
        if (!kw.length && !licHits.length) continue;                   // 키워드 OR 우리 업종 제한
        const rgnChk = rgnEligible(rgnMap[bkey]);
        if (!rgnChk.ok) continue;   // 지역제한 미해당 제외('공고서 참조'는 수집+표시)
        if (!mthdEligible(it.sucsfbidMthdNm, it.cntrctCnclsMthdNm)) continue;   // 시담·지명 제외
        let budget = 0; const bp = Number(it.presmptPrce || 0); if (!isNaN(bp)) budget = Math.floor(bp);
        const mlbl = String(it.sucsfbidMthdNm || '').split('-')[0].trim() || String(it.cntrctCnclsMthdNm || '').trim();
        const docs = [];
        for (let di = 1; di <= 10; di++) {
          const du = it['ntceSpecDocUrl' + di], dn = String(it['ntceSpecFileNm' + di] || '').trim();
          if (du && dn && docs.length < 5) docs.push({ n: dn, u: du });
        }
        const bs = bsisMap[bkey] || {};
        const ext = {};
        const put = function (k, v) { if (v) ext[k] = v; };
        put('ref', String(it.refNo || ''));
        put('kind_n', String(it.ntceKindNm || ''));
        put('cntrct', String(it.cntrctCnclsMthdNm || ''));
        put('rgns', (rgnMap[bkey] || []).filter(Boolean).join(' / ').slice(0, 120));
        put('lics', (licMap[bkey] || []).map(function (s) { return String(s).trim(); }).filter(Boolean).slice(0, 4).join(' / ').slice(0, 160));
        put('begin', String(it.bidBeginDt || '').slice(0, 16));
        put('close', String(it.bidClseDt || '').slice(0, 16));
        put('openg', String(it.opengDt || '').slice(0, 16));
        put('openg_p', String(it.opengPlce || ''));
        put('reg_due', String(it.bidQlfctRgstDt || '').slice(0, 16));
        put('site', String(it.cnstrtsiteRgnNm || ''));
        put('joint', String(it.cmmnSpldmdMethdNm || ''));
        if (bs.bss) ext.bss = bs.bss;
        put('rng', bs.rng);
        if (bs.aamt) ext.aamt = bs.aamt;   // 후보 금액만 — 적용(a)은 공고문 명기 확인 시
        put('lwlt', String(it.sucsfbidLwltRt || ''));
        put('prc_m', String(it.prearngPrceDcsnMthdNm || ''));
        put('dmin', String(it.dminsttNm || ''));
        put('ofcl', String(it.ntceInsttOfclNm || ''));
        put('tel', String(it.ntceInsttOfclTelNo || ''));
        found.push({ id: 'g2b-' + (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || ''), source: '나라장터', kind: '입찰',
          title: nm, org: org, region: rgnChk.lbl, due: String(it.bidClseDt || '').slice(0, 10).replace(/[./]/g, '-'),
          budget: budget, url: it.bidNtceUrl || it.bidNtceDtlUrl || '', matched: kw.concat(licHits.slice(0, 2).map((h) => '면허:' + h)), method: mlbl, rgn_ref: !!rgnChk.ref,
          no: (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || ''), posted: String(it.bidNtceDt || '').slice(0, 10).replace(/[./]/g, '-'), docs: docs, ext: ext });
      }
    }
  }
  for (const it of kaptItems) found.push(it);
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
  // 관리자 세션 또는 수집봇 시크릿(BIDS_INGEST_KEY)로 허용 — 봇의 데이터 정비용
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  const botOk = secret && String(d.key || '').trim() === secret;
  let c = { member: { id: 'bot', name: '수집봇' } };
  if (!botOk) {
    c = await currentMember(event);
    if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
    if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  }
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

// 일감 이력 export(수집봇) — 학습 필터용(패스 패턴). 경량 필드만 반환.
async function handleBidsExport(event, d, R) {
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  if (!secret || String(d.key || '').trim() !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const r = await blobGet(store(DATA), colKey('bids'));
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const lite = items.map(function (it) { return { id: it.id, status: it.status, title: it.title, org: it.org, source: it.source, auto_pass: !!it.auto_pass, no: it.no || '', due: it.due || '', url: it.url || '' }; });
  return jr(200, { status: 'OK', items: lite, request_id: R });
}

// 개찰결과 수신(수집봇 전용) — 응찰 건의 낙찰/유찰 결과를 카드에 반영.
// status는 현재 응찰(구 참여)일 때만 자동 변경 — 사람이 정한 다른 상태는 건드리지 않는다.
async function handleBidsResults(event, d, R) {
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  if (!secret || String(d.key || '').trim() !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  if (!Array.isArray(d.results)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_RESULTS', request_id: R });
  const st = store(DATA);
  const r = await blobGet(st, colKey('bids'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const byId = {};
  doc.items.forEach(function (it) { if (it && it.id) byId[it.id] = it; });
  const today = new Date().toISOString().slice(0, 10);
  let applied = 0;
  const ev = [];
  for (const n of d.results.slice(0, 100)) {
    const cur = n && n.id ? byId[n.id] : null;
    if (!cur) continue;
    if (n.result && typeof n.result === 'object') {
      cur.result = { state: String(n.result.state || '').slice(0, 20), winner: String(n.result.winner || '').slice(0, 60),
        amt: Number(n.result.amt) || 0, rate: String(n.result.rate || '').slice(0, 12),
        bidders: Number(n.result.bidders) || 0, checked: today };
    }
    if ((n.status === '낙찰' || n.status === '유찰') && (cur.status === '응찰' || cur.status === '참여')) {
      cur.status = n.status;
      ev.push({ op: '개찰결과', id: cur.id, t: cur.title.slice(0, 30) + ' → ' + n.status });
    }
    cur.updated = today; applied++;
  }
  if (applied) {
    doc.updated_by = '수집봇'; doc.updated_at = Date.now();
    const w = await blobSet(st, colKey('bids'), doc);
    if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
    if (ev.length) { try { await appendAudit({ ts: Date.now(), by: '수집봇', bid: 'bot', col: 'bids', ev: ev }); } catch (e) {} }
  }
  return jr(200, { status: 'OK', applied: applied, request_id: R });
}

// ---- 계약 첨부파일(석면조사서 등) — Blobs 저장 + 서버측 텍스트 추출 ----
// 파일 바이트는 별도 스토어(gw_files)에 base64로, 메타는 계약(con)에 저장(목록 로드 시 바이트 미포함).
const FILES = 'gw_files';
const ATT_MAX = 8 * 1024 * 1024;   // 8MB(base64 기준)

// PDF 텍스트 근사 추출 — 라이브러리 없이 스트림의 BT..ET / Tj·TJ 텍스트만 긁는다.
function pdfExtractText(buf) {
  let s = buf.toString('latin1');
  const out = [];
  // FlateDecode 스트림은 복원 불가(무압축 텍스트만) — (…)Tj, [(…)…]TJ 패턴 수집
  const re = /\(((?:\\.|[^()\\])*)\)\s*T[jJ]/g;
  let m;
  while ((m = re.exec(s)) && out.length < 20000) {
    const t = m[1].replace(/\\([()\\])/g, '$1').replace(/\\n/g, ' ');
    if (t.trim()) out.push(t);
  }
  return out.join(' ');
}

// HWPX(zip+xml) 텍스트 — zlib inflate로 Contents/*.xml 태그 제거. HWP(구형 OLE)는 미지원.
function hwpxExtractText(buf) {
  try {
    const zlib = require('zlib');
    let s = '';
    // 로컬 파일 헤더(PK\x03\x04) 순회 — Deflate(방법8)만 처리
    let i = 0;
    const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (sig < 0) return '';
    // 간이 파서: 각 로컬헤더에서 압축크기·이름·데이터 오프셋 계산
    let p = 0;
    while (p + 30 <= buf.length) {
      if (buf.readUInt32LE(p) !== 0x04034b50) break;
      const method = buf.readUInt16LE(p + 8);
      const compSize = buf.readUInt32LE(p + 18);
      const nameLen = buf.readUInt16LE(p + 26);
      const extraLen = buf.readUInt16LE(p + 28);
      const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
      const dataStart = p + 30 + nameLen + extraLen;
      const data = buf.slice(dataStart, dataStart + compSize);
      if (/Contents\/.*\.xml$/i.test(name) || /section\d+\.xml$/i.test(name)) {
        try {
          const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
          s += ' ' + xml.replace(/<[^>]+>/g, ' ');
        } catch (e) {}
      }
      p = dataStart + compSize;
      if (compSize === 0) break;
    }
    return s.replace(/\s+/g, ' ');
  } catch (e) { return ''; }
}

function extractAttText(name, buf) {
  const ext = (name || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return pdfExtractText(buf);
  if (ext === 'hwpx') return hwpxExtractText(buf);
  if (ext === 'txt') return buf.toString('utf8');
  return '';
}

const { claudeExtractAsbestos } = require('./_lib/asbestos');

async function handleAttPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const name = String(d.name || '').slice(0, 120);
  const b64 = String(d.data || '');
  if (!name || !b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  if (b64.length > ATT_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', request_id: R });
  const id = 'att_' + crypto.randomBytes(8).toString('hex');
  const w = await blobSet(store(FILES), id, { name: name, type: String(d.type || ''), data: b64, by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 판독은 백그라운드 함수(gw-parse-background)에서 — 첨부는 즉시 완료(타임아웃 방지)
  const wantParse = (d.kind === 'asbestos' || /석면|사전조사|조사서/.test(name));
  return jr(200, { status: 'OK', id: id, name: name, size: b64.length, parse_pending: wantParse, request_id: R });
}

// 동기 판독 폴백(작은 파일·백그라운드 미지원 시) — 타임아웃 위험 있음
async function handleAttParse(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const id = String(d.id || '');
  const r = await blobGet(store(FILES), id);
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  let parsed = null;
  try { parsed = await claudeExtractAsbestos(Buffer.from(r.data.data, 'base64'), r.data.name, r.data.type); } catch (e) { parsed = { error: 'PARSE_FAILED' }; }
  await blobSet(store(FILES), 'parse:' + id, { ts: Date.now(), result: parsed });
  return jr(200, { status: 'OK', parsed: parsed, request_id: R });
}

// 백그라운드 판독 결과 조회(폴링)
async function handleAttParseStatus(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const r = await blobGet(store(FILES), 'parse:' + String(d.id || ''));
  if (!r.ok || !r.data) return jr(200, { status: 'PENDING', request_id: R });
  return jr(200, { status: 'OK', parsed: r.data.result, request_id: R });
}

// ---- 서류 양식(템플릿) 보관 — 관리자 등록, 영구 보관. 생성 시 원본 복사라 오염 없음 ----
const TPL_KEYS = { asb_plan: '석면해체계획서', work_start: '착공계', work_complete: '준공계' };
async function handleTplPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const key = String(d.key || '');
  if (!TPL_KEYS[key]) return jr(400, { status: 'REJECTED', error_code: 'BAD_TPL_KEY', request_id: R });
  const b64 = String(d.data || '');
  if (!b64 || b64.length > ATT_MAX) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  const w = await blobSet(store(FILES), 'tpl:' + key, { name: String(d.name || '').slice(0, 120), data: b64, by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  return jr(200, { status: 'OK', key: key, request_id: R });
}
async function handleTplGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(FILES), 'tpl:' + String(d.key || ''));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  return jr(200, { status: 'OK', name: r.data.name, data: r.data.data, request_id: R });
}
async function handleTplList(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const out = {};
  for (const key of Object.keys(TPL_KEYS)) {
    const r = await blobGet(store(FILES), 'tpl:' + key);
    out[key] = (r.ok && r.data) ? { name: r.data.name, ts: r.data.ts, by: r.data.by } : null;
  }
  return jr(200, { status: 'OK', templates: out, labels: TPL_KEYS, request_id: R });
}

async function handleAttGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(FILES), String(d.id || ''));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  return jr(200, { status: 'OK', name: r.data.name, type: r.data.type, data: r.data.data, request_id: R });
}

async function handleAttDel(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  await blobDelete(store(FILES), String(d.id || ''));
  await blobDelete(store(FILES), 'parse:' + String(d.id || ''));
  return jr(200, { status: 'OK', request_id: R });
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
    if (d && d.action === 'bids_export') return await handleBidsExport(event, d, R);
    if (d && d.action === 'bids_results') return await handleBidsResults(event, d, R);
    if (d && d.action === 'tpl_put') return await handleTplPut(event, d, R);
    if (d && d.action === 'tpl_get') return await handleTplGet(event, d, R);
    if (d && d.action === 'tpl_list') return await handleTplList(event, d, R);
    if (d && d.action === 'att_put') return await handleAttPut(event, d, R);
    if (d && d.action === 'att_parse') return await handleAttParse(event, d, R);
    if (d && d.action === 'att_parse_status') return await handleAttParseStatus(event, d, R);
    if (d && d.action === 'att_get') return await handleAttGet(event, d, R);
    if (d && d.action === 'att_del') return await handleAttDel(event, d, R);
    return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
