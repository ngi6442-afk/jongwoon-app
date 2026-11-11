'use strict';
// 월말명세서(체크 29 — 권민지 '명세표 정리': 거래처 12곳 월말 명세서 확인 → 사장님·나주임 전달 → 정리 파일) 서버 — 29 1단계 판①.
// 근거: 시안 v2(09_조사_문서/29_명세표정리_자료_20261110/시안v2_20261110.md) — PM 11/10 18:13 '추천대로 ㄱ'(D1 비전 꺼 둠 · D2 권민지 수행·나수진 보기 · D3 지입 표시만 · D4 45-1·56 뒤 배포).
// 저장(gw_data — 매일 Blobs 백업에 같이 들어감, 백업 내보내기·복원은 키 이름 없이 gw_data 전부):
//   stmt:cfg             거래처 목록(시드 12곳 = 브리핑 원문 P03·P13 — 저장 전엔 시드로 답함) · 낙관락 updated_at · prev 한 판 · 있던 거래처는 지우기·묶음 바꾸기 금지(끄기만)
//   stmt:<YYYY-MM>:<vk>  거래처·월 한 건 — rows(확정 판) + draft(앱이 처음 채운 판 — 간극 짝) + vsub(차량 소계) + checks(서버가 다시 셈) + status + prev(한 판 되돌리기 — draft·vsub 포함)
//   stmtidx:<YYYY-MM>    월 색인 — 거래처별 요약·차량별 종류 합(부가세 포함 한 기준). 문서에서 다시 만들 수 있는 파생 자료(stmt_reindex)
//   stmt:alias:veh       차량 별칭 사전 — 거래처가 쓰는 옛 번호·처음 보는 번호 → 차량 목록 item.id(사람이 한 번 고른 것, v2 §3-2 「덧대기」)
//   clog:stmt:<YYYY-MM>  간극 기록(이력) — 확정 때·확정 뒤 고칠 때 초안↔확정 칸 변경 수, 확정 풀 때 reopen(값 없음), 해시 체인(clog:<영역>:<월> 규약 — _lib/doneif clogAppend).
//                        월 요약(stmt_gap)은 이 기록이 아니라 문서(draft↔rows)에서 다시 센다 — 기록 한 줄이 빠져도 요약은 맞게(11/10 검토 L2·8)
// 권한(키 stmt): 관리자 수행 · 회원 perms.stmt(do 수행 / view 보기) · 값 없으면 숨김. 권한관리 표(레지스트리 13곳)에는 29 판②에서 탭과 함께 올린다 —
//   그 전엔 gw-auth cleanPerms가 stmt 값을 버리므로 관리자만 쓴다. 기본 숨김을 PERM_CLOSED가 아니라 여기서 정한다(등록 전에도 '보기'로 새지 않게).
//   차량 대조(stmt_match)는 차량 목록 id(= 'v'+등록 때 번호)를 돌려주므로 차량(veh) 권한도 본다 — gw-data permOf와 같은 규칙(관리자 do · perms.veh · 값 없으면 보기), 숨김이면 403.
// 받지 않는 것: 스캔·원본 파일 자체(이름·쪽 수·sha만 — 원본은 권민지 PC·종이, v2 §4), 사업자번호·계좌·전화·주민번호(piiScan 거절), 대표자·기사·작업자 이름(줄에 이름 칸 없음),
//   차량 목록에 없는 차량 id(줄·차량 소계·별칭 모두 목록으로 확인 — 지운 차 id는 받음).
// 비전 판독(D1)은 이 함수에 없다 — 켜는 판은 노무사 회신(원장 T464) 뒤 따로.
// 알려진 한계(gw-data settings 핸들러와 같은 꼴): 읽기 → 쓰기가 원자적이지 않다(@netlify/blobs 8.2.0 set에 조건부 쓰기 없음). 그래서 색인·간극 기록은 쓴 뒤 다시 읽어 확인하고(덧대기),
//   어긋나면 응답 idx:false·gap:false로 알린다(앱이 stmt_reindex로 색인을 다시 만듦).
const crypto = require('crypto');
const zlib = require('zlib');
const { setupBlobContext, store, blobGet, blobSet, blobList } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const tier = require('./_lib/tier');
const DONEIF = require('./_lib/doneif');   // clogAppend(해시 체인) 재사용
const S = require('./_lib/stmt');

const DATA = 'gw_data';
const USERS = 'gw_users';
const CFG_KEY = 'stmt:cfg';
const ALIAS_KEY = 'stmt:alias:veh';
const VEH_KEY = 'col:vehicles';
const GZ_MAX_OUT = 6 * 1024 * 1024;   // 로그인 전에 푸는 gzip 본문 상한(동기 함수 요청 한도와 같은 6MB — 작은 압축 폭탄으로 메모리를 키우지 않게)
function docKey(ym, vk) { return 'stmt:' + ym + ':' + vk; }
function idxKey(ym) { return 'stmtidx:' + ym; }
function clogKey(ym) { return 'clog:stmt:' + ym; }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label, x-gw-enc', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function bad(code, R, extra) { return jr(400, Object.assign({ status: 'REJECTED', error_code: code, request_id: R }, extra || {})); }
function fail(code, R) { return jr(500, { status: 'ERROR', error_code: code || 'STORAGE_FAILED', request_id: R }); }
function stale(R) { return jr(409, { status: 'CONFLICT', error_code: 'STMT_STALE', request_id: R }); }

async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), 'member:' + v.payload.mid);
  if (!r.ok || !r.data || r.data.del === 1 || tier.retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
async function deviceApproved(event, member) {   // gw-data와 같은 규칙 — 관리자는 늘 허용
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), 'device:' + id);
  return !!(r.ok && r.data && r.data.status === 'approved');
}
function stmtPerm(member) {
  if (member && member.admin) return 'do';
  const v = member && member.perms && member.perms.stmt;
  return (v === 'do' || v === 'view') ? v : 'hide';
}
function vehPerm(member) {   // gw-data permOf('vehicles')와 같은 규칙 — veh는 기본 숨김 표(PERM_CLOSED)에 없어 값 없으면 보기
  if (member && member.admin) return 'do';
  const v = member && member.perms && member.perms.veh;
  return (v === 'do' || v === 'view' || v === 'hide') ? v : 'view';
}
function parseBody(event) {   // gw-data parseBody와 같은 꼴(앱 gwCall이 1MB 넘는 본문을 gzip으로 보낼 때) + 푼 크기 상한
  const h = (event && event.headers) || {};
  const enc = String(h['x-gw-enc'] || h['X-GW-Enc'] || '').toLowerCase();
  let txt = event.body || '';
  if (enc === 'gzip') txt = zlib.gunzipSync(Buffer.from(txt, event.isBase64Encoded ? 'base64' : 'binary'), { maxOutputLength: GZ_MAX_OUT }).toString('utf8');
  else if (event.isBase64Encoded) txt = Buffer.from(txt, 'base64').toString('utf8');
  return JSON.parse(txt || '{}');
}
// 없는 키 = { ok:true, data:null }. 실 Blobs는 없는 키를 ok·null로 주고, 저장 모의(servertest)는 NOT_FOUND(ok:false)로 준다 — gw-data 학습·서류함 읽기와 같은 꼴로 둘 다 '없음'.
// 그 밖의 실패(STORAGE_READ_FAILED 등)는 실패 그대로 — 빈 문서로 위조해 덮어쓰지 않게.
async function getOpt(st, key) {
  const r = await blobGet(st, key);
  if (!r.ok && r.code === 'NOT_FOUND') return { ok: true, data: null };
  return r;
}
async function audit(c, op, id, t) {
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'stmt', ev: [{ op: op, id: id, t: String(t || '').slice(0, 300) }] }); return true; } catch (e) { return false; }
}
function tail4(s) { return '…' + (S.plateLast4(s) || '?'); }   // 감사 글의 번호·차량 id는 끝 4자리만

// ---- 차량 목록(읽기만) ----
async function vehRead(st) {
  const r = await getOpt(st, VEH_KEY);
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  return { ok: true, ix: S.vehIndex((r.data && Array.isArray(r.data.items)) ? r.data.items : []) };
}
function vehKnown(ix, id) { return id === S.VEH_COMMON || !!ix.ids[id]; }

// ---- 거래처 목록 ----
// { ok, vendors, at, by, stored } — 읽기 실패·깨진 저장값은 ok:false(시드로 덮어 그리지 않게). 저장 전 = 시드(at 0)
async function cfgRead(st) {
  const r = await getOpt(st, CFG_KEY);
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, vendors: S.seedVendors(), at: 0, by: '', stored: false };
  const c = (typeof r.data === 'object' && !Array.isArray(r.data)) ? S.cleanVendors(r.data.vendors) : { code: 'CFG_INVALID' };
  if (!c.v) return { ok: false, code: 'CFG_INVALID' };
  return { ok: true, vendors: c.v, at: Number(r.data.updated_at) || 0, by: String(r.data.updated_by || ''), stored: true };
}
function vendorOf(cfg, vk) { for (const v of cfg.vendors) if (v.vk === vk) return v; return null; }
function cfgOut(cfg, R) {
  return jr(200, { status: 'OK', vendors: cfg.vendors, updated_at: cfg.at, updated_by: cfg.by, seeded: !cfg.stored,
    kinds: S.KIND_LABEL, uses: S.USE_LABEL, tire_acts: S.TIRE_ACT_LABEL, request_id: R });
}
async function handleCfgGet(st, c, d, R) {
  const cfg = await cfgRead(st);
  if (!cfg.ok) return fail(cfg.code, R);
  return cfgOut(cfg, R);
}
// 있던 거래처: 지우기 금지(지난달 문서 키가 가리킴 — active:false로 끔) · 묶음(차량/용구) 바꾸기 금지(지난 문서 판정·전달처가 바뀜 — 새 거래처로) · 이름 바꾸면 감사에 'a→b'
async function handleCfgSet(st, c, d, R) {
  const nv = S.cleanVendors(d.vendors);
  if (!nv.v) return bad(nv.code, R);
  const cur = await cfgRead(st);
  if (!cur.ok) return fail('CFG_READ_FAILED', R);   // 읽기 실패 위에 쓰면 거래처 목록이 사라진다 — 거부
  if (d.base === undefined || Number(d.base) !== cur.at) return stale(R);
  const nk = S.dict(); nv.v.forEach(function (v) { nk[v.vk] = v; });
  if (cur.vendors.some(function (v) { return !nk[v.vk]; })) return bad('VENDOR_REMOVED', R);
  if (cur.vendors.some(function (v) { return nk[v.vk].group !== v.group; })) return bad('GROUP_LOCKED', R);
  if (JSON.stringify(cur.vendors) === JSON.stringify(nv.v)) return bad('NO_CHANGE', R);
  const doc = { schema: 1, vendors: nv.v, prev: cur.stored ? { vendors: cur.vendors, updated_at: cur.at, updated_by: cur.by } : null,
    updated_at: Math.max(Date.now(), cur.at + 1), updated_by: c.member.id };
  const w = await blobSet(st, CFG_KEY, doc);
  if (!w.ok) return fail(w.code, R);
  const ck = S.dict(); cur.vendors.forEach(function (v) { ck[v.vk] = v; });
  const added = nv.v.filter(function (v) { return !ck[v.vk]; }).map(function (v) { return v.vk + ' ' + v.name; });
  const off = nv.v.filter(function (v) { return ck[v.vk] && ck[v.vk].active && !v.active; }).map(function (v) { return v.vk; });
  const on = nv.v.filter(function (v) { return ck[v.vk] && !ck[v.vk].active && v.active; }).map(function (v) { return v.vk; });
  const ren = nv.v.filter(function (v) { return ck[v.vk] && ck[v.vk].name !== v.name; }).map(function (v) { return v.vk + ' ' + ck[v.vk].name + '→' + v.name; });
  const other = nv.v.filter(function (v) { const o = ck[v.vk]; return o && (o.kind !== v.kind || o.basis !== v.basis || o.carry !== v.carry || JSON.stringify(o.hint) !== JSON.stringify(v.hint)); }).map(function (v) { return v.vk; });
  await audit(c, '명세서거래처', CFG_KEY, '거래처 ' + nv.v.length + '곳' + (added.length ? ' · 더함 ' + added.join(', ') : '') + (off.length ? ' · 끔 ' + off.join(',') : '') + (on.length ? ' · 켬 ' + on.join(',') : '')
    + (ren.length ? ' · 이름 ' + ren.join(', ') : '') + (other.length ? ' · 기본값 ' + other.join(',') : ''));
  return cfgOut({ vendors: nv.v, at: doc.updated_at, by: doc.updated_by, stored: true }, R);
}

// ---- 거래처·월 문서 ----
// { ok, doc|null, at } — 읽기 실패·깨진 값은 ok:false(빈 문서로 위조해 덮지 않게)
async function docRead(st, ym, vk) {
  const r = await getOpt(st, docKey(ym, vk));
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, doc: null, at: 0 };
  if (typeof r.data !== 'object' || Array.isArray(r.data) || !Array.isArray(r.data.rows)) return { ok: false, code: 'DOC_INVALID' };
  return { ok: true, doc: r.data, at: Number(r.data.updated_at) || 0 };
}
// 색인 — 없으면 빈 색인, 깨진 값이면 ok:false(빈 달로 그리거나 한 줄로 덮지 않게 — stmt_reindex가 다시 만듦)
async function idxRead(st, ym) {
  const r = await getOpt(st, idxKey(ym));
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, doc: { schema: 1, ym: ym, vendors: {} } };
  if (typeof r.data !== 'object' || Array.isArray(r.data) || !r.data.vendors || typeof r.data.vendors !== 'object' || Array.isArray(r.data.vendors)) return { ok: false, code: 'IDX_INVALID' };
  return { ok: true, doc: r.data };
}
// 문서 저장 뒤 색인 한 줄 — 쓴 뒤 다시 읽어 내 줄(at)이 남았는지 확인(두 거래처 거의 동시 저장 때 마지막 쓰기가 다른 줄을 옛 값으로 덮는 경합을 알림).
// 실패·어긋남이면 false — 문서 저장은 끝난 일, 앱이 stmt_reindex로 다시 만든다
async function idxPut(st, ym, vk, doc, chk) {
  try {
    const ix = await idxRead(st, ym);
    if (!ix.ok) return false;
    ix.doc.vendors[vk] = S.vendorSummary(doc, chk);
    ix.doc.updated_at = Date.now();
    const w = await blobSet(st, idxKey(ym), ix.doc);
    if (!w.ok) return false;
    const back = await idxRead(st, ym);
    return !!(back.ok && back.doc.vendors[vk] && back.doc.vendors[vk].at === doc.updated_at);
  } catch (e) { return false; }
}
function ymVk(d, R) {
  if (typeof d.ym !== 'string' || !S.RE_YM.test(d.ym)) return { res: bad('BAD_YM', R) };
  if (typeof d.vk !== 'string' || !S.RE_VK.test(d.vk)) return { res: bad('BAD_VK', R) };
  return { ym: d.ym, vk: d.vk };
}
async function handleMonth(st, c, d, R) {
  if (typeof d.ym !== 'string' || !S.RE_YM.test(d.ym)) return bad('BAD_YM', R);
  const [cfg, ix] = await Promise.all([cfgRead(st), idxRead(st, d.ym)]);
  if (!cfg.ok) return fail(cfg.code, R);
  if (!ix.ok) return fail(ix.code, R);
  return jr(200, { status: 'OK', ym: d.ym, vendors: ix.doc.vendors, idx_at: Number(ix.doc.updated_at) || 0, cfg: cfg.vendors, cfg_at: cfg.at, request_id: R });
}
async function handleGet(st, c, d, R) {
  const k = ymVk(d, R); if (k.res) return k.res;
  const cfg = await cfgRead(st);
  if (!cfg.ok) return fail(cfg.code, R);
  const v = vendorOf(cfg, k.vk);
  if (!v) return bad('UNKNOWN_VENDOR', R);
  const cur = await docRead(st, k.ym, k.vk);
  if (!cur.ok) return fail(cur.code, R);
  return jr(200, { status: 'OK', vendor: v, doc: cur.doc, checks: cur.doc ? S.checkDoc(cur.doc, v) : null, request_id: R });
}
// 저장 — 낙관락(base = 저장된 updated_at, 새 문서는 0) · 줄·계산서·잔액·차량 소계 정리 · 차량 id는 차량 목록에 있는 것만 · 서버가 검산을 다시 셈
//   status를 빼면 지금 상태 그대로(새 문서는 doing). 확정(done)·전달(sent)은 검산 통과만(v2 §3-1) — 확정된 문서를 검산 실패 판으로 바꾸려면 status:'doing'을 명시(확정 풀기 = 기록 reopen)
//   draft_rows: 앱이 판독·자동 대조로 처음 채운 판 — 작성 중 저장에서만 받는다(확정 요청·확정된 문서에서 초안을 바꾸면 간극이 0으로 숨는다 — 11/10 검토 7). 문서에 초안이 있으면 redraft:true(다시 읽은 파일)
//   간극 기록: 확정으로 들어갈 때와 확정 상태에서 줄이 바뀔 때마다 1줄(값 없이 칸 수만)
async function handleSave(st, c, d, R) {
  const k = ymVk(d, R); if (k.res) return k.res;
  const cfg = await cfgRead(st);
  if (!cfg.ok) return fail(cfg.code, R);
  const v = vendorOf(cfg, k.vk);
  if (!v) return bad('UNKNOWN_VENDOR', R);
  const rows = S.cleanRows(d.rows, k.ym, false);
  if (!rows.rows) return bad(rows.code, R, rows.at !== undefined ? { at: rows.at } : null);
  const inv = S.cleanInv(d.inv); if (inv.code) return bad(inv.code, R);
  const carry = S.cleanCarry(d.carry); if (carry.code) return bad(carry.code, R);
  const vsub = S.cleanVsub(d.vsub); if (vsub.code) return bad(vsub.code, R);
  const src = S.cleanSrc(d.src); if (src.code) return bad(src.code, R);
  const stated = S.money(d.stated, true);
  if (stated === undefined) return bad('BAD_STATED', R);
  const basis = (d.basis === undefined || d.basis === null) ? v.basis : d.basis;
  if (S.BASES.indexOf(basis) < 0) return bad('BAD_BASIS', R);
  if (d.status !== undefined && d.status !== null && S.STATUSES.indexOf(d.status) < 0) return bad('BAD_STATUS', R);
  let draftIn = null;
  if (d.draft_rows !== undefined && d.draft_rows !== null) {
    const dr = S.cleanRows(d.draft_rows, k.ym, true);
    if (!dr.rows) return bad('DRAFT_' + dr.code, R, dr.at !== undefined ? { at: dr.at } : null);
    draftIn = dr.rows;
  }
  const vr = await vehRead(st);
  if (!vr.ok) return fail('VEH_READ_FAILED', R);
  const unknown = rows.rows.concat(draftIn || []).map(function (x) { return x.veh; }).concat(vsub.v ? Object.keys(vsub.v) : [])
    .filter(function (id) { return id && !vehKnown(vr.ix, id); });
  if (unknown.length) return bad('UNKNOWN_VEH', R);
  const cur = await docRead(st, k.ym, k.vk);
  if (!cur.ok) return fail('DOC_READ_FAILED', R);   // 읽기 실패 위에 쓰면 그 달 그 거래처 줄이 사라진다 — 거부
  if (d.base === undefined || Number(d.base) !== cur.at) return stale(R);
  const wasFinal = !!(cur.doc && S.FINAL[cur.doc.status]);
  const status = (d.status === undefined || d.status === null) ? (cur.doc ? cur.doc.status : 'doing') : d.status;
  let draft = cur.doc ? (cur.doc.draft || null) : null;
  if (draftIn) {
    if (S.FINAL[status] || wasFinal) return bad('DRAFT_ON_FINAL', R);
    if (draft && d.redraft !== true) return bad('DRAFT_EXISTS', R);
    const how = {}; draftIn.forEach(function (x) { how[x.how] = (how[x.how] || 0) + 1; });
    draft = { rows: draftIn, at: Date.now(), by: c.member.id, how: how };
  }
  const now = Math.max(Date.now(), cur.at + 1);
  const doc = { schema: 1, ym: k.ym, vk: k.vk, group: (cur.doc && cur.doc.group) || v.group, basis: basis, src: src.v, inv: inv.v, stated: stated, carry: carry.v, vsub: vsub.v, rows: rows.rows,
    draft: draft, status: status, updated_at: now, updated_by: c.member.id,
    prev: cur.doc ? { rows: cur.doc.rows, status: cur.doc.status, basis: cur.doc.basis, src: cur.doc.src || [], inv: cur.doc.inv || null, stated: (cur.doc.stated === undefined ? null : cur.doc.stated),
      carry: cur.doc.carry || null, vsub: cur.doc.vsub || null, draft: cur.doc.draft || null, updated_at: cur.at, updated_by: String(cur.doc.updated_by || '') } : null };
  const chk = S.checkDoc(doc, v);
  if (S.FINAL[status] && !chk.ok) return bad('NOT_BALANCED', R, { checks: chk });   // 검산 통과 전 확정·전달 금지(v2 §3-1)
  doc.checks = { ok: chk.ok, bad: chk.bad.length, issues: chk.issues };
  const w = await blobSet(st, docKey(k.ym, k.vk), doc);
  if (!w.ok) return fail(w.code, R);
  const idxOk = await idxPut(st, k.ym, k.vk, doc, chk);
  let gapOk = null;
  const rowsChanged = !cur.doc || JSON.stringify(cur.doc.rows) !== JSON.stringify(doc.rows);
  if (S.FINAL[status] && draft && (!wasFinal || rowsChanged)) {
    const g = S.gapCount(draft.rows, doc.rows);
    gapOk = await clogPut(st, k.ym, { ts: Date.now(), by: c.member.id, op: 'final', vk: k.vk, filled: g.filled, changed: g.changed, rows: g.rows });
  } else if (wasFinal && !S.FINAL[status]) {
    gapOk = await clogPut(st, k.ym, { ts: Date.now(), by: c.member.id, op: 'reopen', vk: k.vk });
  }
  await audit(c, '명세서저장', docKey(k.ym, k.vk), v.name + ' ' + k.ym + ' 줄 ' + doc.rows.length + '건 · ' + status + (chk.ok ? ' · 검산 통과' : ' · 붉은 ' + (chk.bad.length + chk.issues.length)));
  return jr(200, { status: 'OK', doc: doc, checks: chk, idx: idxOk, gap: gapOk, request_id: R });
}
// 간극 기록 한 줄 — 깨진 기록은 덮지 않고 false(손댄 흔적을 새 체인으로 지우지 않게) · 쓴 뒤 다시 읽어 내 줄이 남았는지 확인, 동시 확정으로 빠졌으면 한 번 다시 붙임
async function clogPut(st, ym, entry) {
  try {
    for (let i = 0; i < 2; i++) {
      const r = await getOpt(st, clogKey(ym));
      if (!r.ok) return false;
      if (r.data !== null && r.data !== undefined && (typeof r.data !== 'object' || !Array.isArray(r.data.items))) return false;
      const doc = r.data ? { schema: 1, items: r.data.items, head: r.data.head || '' } : { schema: 1, items: [], head: '' };
      DONEIF.clogAppend(doc, entry);
      const h = doc.head;
      doc.updated_at = Date.now();
      const w = await blobSet(st, clogKey(ym), doc);
      if (!w.ok) return false;
      const back = await getOpt(st, clogKey(ym));
      if (back.ok && back.data && Array.isArray(back.data.items) && back.data.items.some(function (x) { return x && x.h === h; })) return true;
    }
    return false;
  } catch (e) { return false; }
}
// 한 판 되돌리기(직전 저장 판으로 — 초안·차량 소계까지) — 낙관락 · 되돌린 판의 검산을 다시 세어 통과 못 하면 상태는 작성 중으로(확정이 풀리면 기록 reopen)
async function handleRevert(st, c, d, R) {
  const k = ymVk(d, R); if (k.res) return k.res;
  const cfg = await cfgRead(st);
  if (!cfg.ok) return fail(cfg.code, R);
  const v = vendorOf(cfg, k.vk);
  if (!v) return bad('UNKNOWN_VENDOR', R);
  const cur = await docRead(st, k.ym, k.vk);
  if (!cur.ok) return fail('DOC_READ_FAILED', R);
  if (d.base === undefined || Number(d.base) !== cur.at) return stale(R);
  if (!cur.doc || !cur.doc.prev) return bad('NO_PREV', R);
  const p = cur.doc.prev;
  const doc = Object.assign({}, cur.doc, { rows: p.rows || [], status: p.status || 'doing', basis: p.basis || v.basis, src: p.src || [], inv: p.inv || null, stated: (p.stated === undefined ? null : p.stated),
    carry: p.carry || null, vsub: p.vsub || null, draft: (p.draft !== undefined ? p.draft : cur.doc.draft) || null, prev: null, updated_at: Math.max(Date.now(), cur.at + 1), updated_by: c.member.id });
  const chk = S.checkDoc(doc, v);
  if (!chk.ok && doc.status !== 'doing') doc.status = 'doing';
  doc.checks = { ok: chk.ok, bad: chk.bad.length, issues: chk.issues };
  const w = await blobSet(st, docKey(k.ym, k.vk), doc);
  if (!w.ok) return fail(w.code, R);
  const idxOk = await idxPut(st, k.ym, k.vk, doc, chk);
  let gapOk = null;
  if (S.FINAL[cur.doc.status] && !S.FINAL[doc.status]) gapOk = await clogPut(st, k.ym, { ts: Date.now(), by: c.member.id, op: 'reopen', vk: k.vk });
  await audit(c, '명세서되돌리기', docKey(k.ym, k.vk), v.name + ' ' + k.ym + ' 줄 ' + doc.rows.length + '건 · ' + doc.status);
  return jr(200, { status: 'OK', doc: doc, checks: chk, idx: idxOk, gap: gapOk, request_id: R });
}
// 그 달 문서 목록(접두어로 거르고 거래처 키 꼴만) — 모의 blobList는 접두어를 무시하므로 여기서도 거른다
async function monthDocs(st, ym, cfg) {
  const pre = 'stmt:' + ym + ':';
  const ls = await blobList(st, pre);
  if (!ls.ok) return { ok: false, code: ls.code };
  const out = [];
  for (const key of ls.keys) {
    if (typeof key !== 'string' || key.indexOf(pre) !== 0) continue;
    const vk = key.slice(pre.length);
    if (!S.RE_VK.test(vk)) continue;
    const v = vendorOf(cfg, vk);
    if (!v) continue;
    const cur = await docRead(st, ym, vk);
    if (!cur.ok) return { ok: false, code: 'DOC_READ_FAILED' };   // 한 곳이라도 못 읽으면 반쪽 결과를 쓰지 않는다
    if (cur.doc) out.push({ vk: vk, v: v, doc: cur.doc });
  }
  return { ok: true, docs: out };
}
// 월 색인 다시 만들기(파생 자료 — 응답 idx:false·IDX_INVALID 때 앱이 부름)
async function handleReindex(st, c, d, R) {
  if (typeof d.ym !== 'string' || !S.RE_YM.test(d.ym)) return bad('BAD_YM', R);
  const cfg = await cfgRead(st);
  if (!cfg.ok) return fail(cfg.code, R);
  const md = await monthDocs(st, d.ym, cfg);
  if (!md.ok) return fail(md.code, R);
  const vendors = {};
  md.docs.forEach(function (x) { vendors[x.vk] = S.vendorSummary(x.doc, S.checkDoc(x.doc, x.v)); });
  const doc = { schema: 1, ym: d.ym, vendors: vendors, updated_at: Date.now() };
  const w = await blobSet(st, idxKey(d.ym), doc);
  if (!w.ok) return fail(w.code, R);
  return jr(200, { status: 'OK', ym: d.ym, vendors: vendors, idx_at: doc.updated_at, request_id: R });
}
// 차량 하나의 달별 이력(차량 탭 상세 — v2 ⓒ) — 색인만 읽는다(줄 값 없이 종류별 건수·부가세 포함 금액). 합 = 확정·검산 통과 거래처만, 작성 중은 pending
async function handleVeh(st, c, d, R) {
  if (!S.okVeh(d.veh)) return bad('BAD_VEH', R);
  const n = (d.n === undefined) ? 12 : d.n;
  if (!Number.isInteger(n) || n < 1 || n > 24) return bad('BAD_N', R);
  const to = (d.to === undefined) ? S.kstYm() : d.to;
  if (typeof to !== 'string' || !S.RE_YM.test(to)) return bad('BAD_YM', R);
  const yms = []; for (let i = 0; i < n; i++) yms.push(S.ymShift(to, -i));
  const reads = await Promise.all(yms.map(function (ym) { return idxRead(st, ym).then(function (x) { return { ym: ym, ok: x.ok, doc: x.doc }; }); }));
  const failed = reads.filter(function (x) { return !x.ok; }).map(function (x) { return x.ym; });
  return jr(200, { status: 'OK', veh: d.veh, months: S.vehMonths(reads.filter(function (x) { return x.ok; }), d.veh), failed: failed, request_id: R });
}

// ---- 차량 별칭 사전 ----
async function aliasRead(st) {
  const r = await getOpt(st, ALIAS_KEY);
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, map: {}, at: 0 };
  if (typeof r.data !== 'object' || !r.data.map || typeof r.data.map !== 'object' || Array.isArray(r.data.map)) return { ok: false, code: 'ALIAS_INVALID' };
  return { ok: true, map: r.data.map, at: Number(r.data.updated_at) || 0 };
}
async function handleAliasGet(st, c, d, R) {
  const a = await aliasRead(st);
  if (!a.ok) return fail(a.code, R);
  return jr(200, { status: 'OK', map: a.map, updated_at: a.at, request_id: R });
}
async function handleAliasSet(st, c, d, R) {
  if (typeof d.raw !== 'string' || d.raw.length > 40) return bad('BAD_RAW', R);
  const key = S.normPlate(d.raw);
  if (!key || S.piiScan(d.raw)) return bad('BAD_RAW', R);
  const veh = (d.veh === undefined || d.veh === null) ? '' : d.veh;
  if (veh !== '' && !S.okVeh(veh)) return bad('BAD_VEH', R);
  if (veh !== '') {
    const vr = await vehRead(st);
    if (!vr.ok) return fail('VEH_READ_FAILED', R);
    if (veh === S.VEH_COMMON || !vr.ix.ids[veh]) return bad('UNKNOWN_VEH', R);   // 별칭은 실제 차량으로만(공용 '_common'은 줄에서 고름)
  }
  const cur = await aliasRead(st);
  if (!cur.ok) return fail('ALIAS_READ_FAILED', R);
  if (d.base === undefined || Number(d.base) !== cur.at) return stale(R);
  const map = Object.assign(S.dict(), cur.map);
  const before = Object.prototype.hasOwnProperty.call(cur.map, key) ? cur.map[key] : '';
  if (before === veh) return bad('NO_CHANGE', R);
  if (veh === '') delete map[key]; else map[key] = veh;
  if (Object.keys(map).length > S.LIMIT.alias) return bad('ALIAS_FULL', R);
  const doc = { schema: 1, map: map, updated_at: Math.max(Date.now(), cur.at + 1), updated_by: c.member.id };
  const w = await blobSet(st, ALIAS_KEY, doc);
  if (!w.ok) return fail(w.code, R);
  await audit(c, '명세서차량별칭', ALIAS_KEY, tail4(key) + ' → ' + (veh ? '차량 ' + tail4(veh) : '(지움)'));   // 번호·차량 id는 끝 4자리만(id = 'v'+전체 번호)
  return jr(200, { status: 'OK', map: map, updated_at: doc.updated_at, request_id: R });
}

// ---- 차량 대조(명세서 번호 글 → 차량 목록 id) — 별칭 사전 → 현재 번호 → 옛 번호 → 끝 4자리 순, 여러 대·처음 보는 번호는 사람이 고름(v2 §3-2) ----
// 차량 목록은 읽기만(고치지 않음). 차량(veh) 보기 권한이 있어야 한다 — 고르기 목록 id가 'v'+등록 때 전체 번호라서(그 밖 칸은 끝 4자리·차종·자차/지입·상태만)
async function handleMatch(st, c, d, R) {
  if (vehPerm(c.member) === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_VEH_ACCESS', request_id: R });
  const raws = d.raws;
  if (!Array.isArray(raws) || raws.length > S.LIMIT.rows || raws.some(function (x) { return typeof x !== 'string' || x.length > 40; })) return bad('BAD_RAWS', R);
  const [vr, al] = await Promise.all([vehRead(st), aliasRead(st)]);
  if (!vr.ok) return fail(vr.code, R);
  if (!al.ok) return fail(al.code, R);
  return jr(200, { status: 'OK', matches: raws.map(function (r) { return Object.assign({ raw: r }, S.matchPlate(r, vr.ix, al.map)); }), vehicles: vr.ix.list, alias_at: al.at, request_id: R });
}

// ---- 간극 요약(월 1회 보고용 — v2 §8) — 문서(초안↔확정)에서 다시 센다(확정·전달 문서만). 기록(clog)은 체인 확인·줄 수만 ----
async function handleGap(st, c, d, R) {
  if (typeof d.ym !== 'string' || !S.RE_YM.test(d.ym)) return bad('BAD_YM', R);
  const cfg = await cfgRead(st);
  if (!cfg.ok) return fail(cfg.code, R);
  const md = await monthDocs(st, d.ym, cfg);
  if (!md.ok) return fail(md.code, R);
  const vendors = {};
  md.docs.forEach(function (x) {
    if (!S.FINAL[x.doc.status] || !x.doc.draft || !Array.isArray(x.doc.draft.rows)) return;
    const g = S.gapCount(x.doc.draft.rows, x.doc.rows);
    vendors[x.vk] = { at: x.doc.updated_at, filled: g.filled, changed: g.changed, rows: g.rows };
  });
  const r = await getOpt(st, clogKey(d.ym));
  if (!r.ok) return fail(r.code, R);
  let items = [], chain = true;
  if (r.data !== null && r.data !== undefined) {
    if (typeof r.data !== 'object' || !Array.isArray(r.data.items)) chain = false;
    else {
      items = r.data.items;
      let prev = '';   // gw-data conClogChainOk와 같은 식(끊김 = 누가 기록을 고쳤거나 잘림)
      for (const it of items) { const e = Object.assign({}, it); delete e.h; delete e.p; const h = crypto.createHash('sha256').update(prev + '|' + JSON.stringify(e)).digest('hex').slice(0, 16); if (!it || it.p !== prev || it.h !== h) { chain = false; break; } prev = it.h; }
      if (chain && prev !== (r.data.head || '')) chain = false;
    }
  }
  return jr(200, { status: 'OK', ym: d.ym, vendors: vendors, n: items.length, chain_ok: chain, request_id: R });
}

const READ = { stmt_cfg_get: handleCfgGet, stmt_month: handleMonth, stmt_get: handleGet, stmt_veh: handleVeh, stmt_alias_get: handleAliasGet, stmt_gap: handleGap, stmt_match: handleMatch };
const WRITE = { stmt_cfg_set: handleCfgSet, stmt_save: handleSave, stmt_revert: handleRevert, stmt_reindex: handleReindex, stmt_alias_set: handleAliasSet };
async function handler(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = parseBody(event); } catch (e) { return bad('INVALID_JSON', R); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return bad('INVALID_JSON', R);
  const act = typeof d.action === 'string' ? d.action : '';
  const isRead = Object.prototype.hasOwnProperty.call(READ, act), isWrite = Object.prototype.hasOwnProperty.call(WRITE, act);
  if (!isRead && !isWrite) return bad('UNKNOWN_ACTION', R);
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const p = stmtPerm(c.member);
  if (p === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  if (isWrite && p !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  try {
    return await (isRead ? READ[act] : WRITE[act])(store(DATA), c, d, R);
  } catch (e) {
    try { console.log('[gw-stmt] ' + act + ' 실패 ' + String((e && e.message) || e).slice(0, 200)); } catch (e2) {}
    return fail('HANDLER_FAILED', R);
  }
}

exports.handler = handler;
