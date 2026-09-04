'use strict';

// 그룹웨어 데이터 (서버측 권한 강제). Netlify Blobs.
// 'gw_data' 저장: col:tasks / col:vehicles / col:receivables / col:licenses / col:checklist
// 권한은 'gw_users'의 회원 레코드(perms)에서 확인. 관리자는 전부 허용.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet, blobDelete, blobList } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit, auditKey, diffItems } = require('./_lib/audit');
const push = require('./_lib/push');

const DATA = 'gw_data';
const USERS = 'gw_users';
// 컬렉션 → 권한키
const COL = { tasks: 'tasks', vehicles: 'veh', receivables: 'rec', licenses: 'lic', checklist: 'check', documents: 'doc', clients: 'cli', contracts: 'con', leaves: 'leaves', bids: 'bid', onbid: 'bid', workers: 'wk', quotes: 'quote', promo: 'promo', family: 'fam', asbestos: 'lic', edu: 'hr' };  // onbid=공매·부동산(관리자 전용), workers=일용직 명부(wk), quotes=견적서 탭 독립 권한(영업 문서 — 계약 파이프라인의 견적 "서류" 생성은 별개로 con 권한), promo=홍보(현장 기록→블로그·갤러리), family=가족친화 실적 대장(혁신⑧ — bids처럼 관리자 전용 서버 강제), asbestos=석면 작업 이력 대장(인허가 탭 안에 두므로 lic 권한을 공유 — 산안법 30년 보존 + 안전성평가 전산화 항목)
// 사용자별 비공개 컬렉션(본인만 접근, 회원 id로 분리 저장)
const PRIVATE_COL = { mytasks: true };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function colKey(c) { return `col:${c}`; }

// 퇴사자 차단(S2-A) — gw-auth와 동일 규칙: 퇴사일(leave_date)이 지나면 기존 세션도 데이터 접근 불가
function retired(m) {
  const ld = m && m.leave_date;
  if (!ld) return false;
  return String(ld) < new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);   // KST 일자 비교
}
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
function permOf(member, col) {
  if (member.admin) return 'do';
  const key = COL[col];
  // 견적서·홍보는 기본 숨김(닫고 시작 — 명시 부여만). 다른 모듈 기본은 보기
  return (member.perms && member.perms[key]) || ((key === 'quote' || key === 'promo' || key === 'hr') ? 'hide' : 'view');   // hr(교육·건강진단 대장)은 인사 탭이 관리자 전용인데 서버가 view로 열려 있던 구멍(9/4 uismoke 실사고 조사) — 닫고 시작
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

// ---- 버전 링(시점 복구) ----
// 덮어쓰기 직전 문서를 ver:<col>:<ts>로 보존, 목록은 veridx:<col>. 리포 git 이력 기반이던 구 시점복구가
// Blobs 전환으로 무효가 된 자리를 대체. 정책: 최근 VER_RECENT개 전부 + 그보다 오래된 건 일 1개 × VER_DAYS일.
// 스냅샷 실패가 저장 본선을 막으면 안 된다(전체 try). priv(개인) 컬렉션은 대상 아님.
const VER_RECENT = 20, VER_DAYS = 30;
// 스냅샷 제외(2026-08-10 실측). 입찰·온비드가 저장의 89%(11.93MB 중 10.6MB)인데 내용은
// 수집봇이 다시 만들 수 있는 기계 데이터라 시점복구 가치가 낮다. 반면 카드 상태를 한 번 바꿀 때마다
// 전체 문서를 한 벌 더 쓰게 돼 최다 사용자(대표)의 체감 속도를 직접 깎았다.
// 단 '비우기' 같은 파괴적 작업은 force=true로 계속 남긴다 — 재수집으로 되돌릴 수 없는 사람 판단이 섞이므로.
const VER_SKIP = { bids: 1, onbid: 1 };
function verDay(ts) { return new Date(ts + 9 * 3600000).toISOString().slice(0, 10); }   // KST 일자
async function verSnapshot(col, prevDoc, byName, dailyOnly, force) {
  if (!prevDoc || typeof prevDoc !== 'object') return;
  if (VER_SKIP[col] && !force) return;
  try {
    const st = store(DATA);
    const ir = await blobGet(st, `veridx:${col}`);
    const idx = (ir.ok && ir.data && Array.isArray(ir.data.items)) ? ir.data.items : [];
    let now = Date.now();
    idx.forEach(function (e) { if (e && e.ts >= now) now = e.ts + 1; });   // 같은 ms 연속 저장 시 키 충돌 방지
    if (dailyOnly && idx.some(function (e) { return e && verDay(e.ts) === verDay(now); })) return;
    const items = Array.isArray(prevDoc.items) ? prevDoc.items : [];
    await blobSet(st, `ver:${col}:${now}`, { ts: now, by: byName || '', doc: prevDoc });
    idx.push({ ts: now, by: byName || '', day: verDay(now), tot: items.length, live: items.filter(function (x) { return x && x.del !== 1; }).length });
    idx.sort(function (a, b) { return b.ts - a.ts; });
    const keep = [], seenDay = {};
    for (let i = 0; i < idx.length; i++) {
      const e = idx[i];
      const fresh = i < VER_RECENT;
      const daily = !seenDay[e.day] && (now - e.ts) <= VER_DAYS * 86400000;
      if (fresh || daily) { keep.push(e); seenDay[e.day] = 1; continue; }
      await blobDelete(st, `ver:${col}:${e.ts}`);
    }
    await blobSet(st, `veridx:${col}`, { items: keep });
  } catch (e) {}
}

// 객체를 화이트리스트로 쓸 때의 프로토타입 키('constructor' 등) 우회 차단 — 문서함 분류·확장자·공개범위 표 공용(적대 검증 low5)
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
// 문서함 2층 분류(문서체계 설계안 v2 2026-09-04 §2·§6, v317) — 1층 대분류 = 업무 영역 12 + 99 미분류(앱 전용), 2층 중분류 = 문서 성격 6(전 대분류 공통).
// 라벨은 앱 DOC_MAJOR·DOC_MINOR와 동일(uismoke 대조). cat = 'AA-BB'(72) + '99' = 73키 화이트리스트. 구 2자리 cat('03' 등)은 키가 아니라 번호 파생으로 넘어간다(마이그레이션 §6.4 전 구건)
const DOC_MAJOR_LABEL = { '01': '01 법인·등기', '02': '02 경영·총무', '03': '03 영업·홍보', '04': '04 계약·공사', '05': '05 차량·장비', '06': '06 안전보건', '07': '07 인사·노무', '08': '08 인허가', '09': '09 인증·경영시스템', '10': '10 재무·세무', '11': '11 정보·시스템', '12': '12 기타', '99': '99 미분류' };
const DOC_MINOR_LABEL = { '01': '01 규정·기준', '02': '02 매뉴얼·가이드', '03': '03 양식·서식', '04': '04 관리표·대장', '05': '05 계획·조직', '06': '06 자료' };
const DOC_MAJOR_SET = Object.keys(DOC_MAJOR_LABEL).reduce(function (o, k) { o[k] = 1; return o; }, {});
const DOC_MINOR_SET = Object.keys(DOC_MINOR_LABEL).reduce(function (o, k) { o[k] = 1; return o; }, {});
// DOC_CAT_SET(73키)·DOC_CAT_LABEL(결재 카드 문구 '06-01 안전보건 · 규정·기준') — 앱 DOC_CATS와 같은 생성 규칙
const DOC_CAT_SET = {}, DOC_CAT_LABEL = {};
Object.keys(DOC_MAJOR_LABEL).forEach(function (maj) {
  if (maj === '99') { DOC_CAT_SET['99'] = 1; DOC_CAT_LABEL['99'] = DOC_MAJOR_LABEL['99']; return; }
  Object.keys(DOC_MINOR_LABEL).forEach(function (min) { const k = maj + '-' + min; DOC_CAT_SET[k] = 1; DOC_CAT_LABEL[k] = k + ' ' + DOC_MAJOR_LABEL[maj].slice(3) + ' · ' + DOC_MINOR_LABEL[min].slice(3); });
});
// 분류 파생 — cat 화이트리스트 우선, 아니면 문서번호 JW-AA-BB-NNN[-SS|-YYYY]의 앞 두 마디. 구형식 JW-05-001·번호 없음·구 분류 텍스트 → 99(텍스트 폴백 삭제 — 오배정 대신 미분류). 클라 docCatOf와 같은 규칙 유지 필수(uismoke가 정규식 동률 대조)
function docCatOf(it) {
  if (!it) return '99';
  // cat은 화이트리스트만 신뢰 — 무효값을 그대로 분류로 삼으면 01 보호를 폴스루로 빠져나간다(클라와 동일 규칙)
  if (it.cat && hasOwn(DOC_CAT_SET, String(it.cat))) return String(it.cat);
  const s = String(it.no || '') + ' ' + String(it.title || '');
  const m = s.match(/JW-?(\d{2})-(\d{2})-\d{3}/i);   // 4층 번호의 앞 두 마디(별지 -SS·연도판 -YYYY도 앞 두 마디) — 앱과 동일 정규식
  if (m && hasOwn(DOC_CAT_SET, m[1] + '-' + m[2])) return m[1] + '-' + m[2];
  return '99';
}
// 대분류 2자리 — 01 하드차단 판정·공개범위 설정 조회 공용(설정 키 = 대분류). 구 2자리 cat '01'은 번호 파생이 실패해도 01(마이그레이션 전 법인 문서가 99로 풀려 문서 scope로 노출되지 않게 — 클라 동일)
function docMajorOf(it) {
  const c = docCatOf(it);
  if (c !== '99') return c.slice(0, 2);
  return (it && String(it.cat) === '01') ? '01' : '99';
}
function docCanSee01(m) { return !!(m && (m.admin || String(m.dept || '') === '관리부')); }

// ---- 문서함 공개범위·등재 결재(v314, PM 지시 9/4 "문서함 일단 다 올리고 등재결재랑 공개범위 만들어라 내가 선택하게" + "비공개로 다 올리라고") ----
// 공개범위(scope): 문서 항목 scope = 'all'(전원) | 'mgmt'(관리부+관리자 — docCanSee01과 같은 축) | 'admin'(관리자만) | {ids:[회원id…]}(지정 직원+관리자).
// 미지정 문서는 분류 기본값(settings:documents.scope_default) — 초기값은 전 분류 'admin'(전부 비공개, PM 9/4 추가 지시).
// 공개는 PM이 설정 화면에서 분류별로 열거나 문서별 scope를 줄 때만. 01 법인은 하드차단(관리부+관리자) 유지·설정 대상 아님.
// 등재 결재(register_gate): 'staff'(기본 — 비관리자 등재는 status '대기' + 결재함 '문서함 등재' 카드 자동 상신, 승인 시 '등재') | 'none'(즉시 등재).
// 관리자 등재는 항상 즉시 '등재'(등급표 ① PM 전결 — PM·관리자가 올리면 그 자체가 결재). status 없는 구건(18건)은 '등재'로 취급.
const DOC_SETTINGS_KEY = 'settings:documents';
const DOC_SCOPE_CATS = ['02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '99'];   // 설정 키 = 대분류 2자리(v317 2층 분류 — 중분류 단위 설정 없음, 'AA-BB' 키는 BAD_CAT). 01 법인은 설정 불가(하드차단). 미저장 대분류는 기본 비공개
const DOC_SCOPE_VALS = { all: 1, mgmt: 1, admin: 1 };
const DOC_SETTINGS_DEFAULTS = { scope_default: DOC_SCOPE_CATS.reduce(function (o, cat) { o[cat] = 'admin'; return o; }, {}), register_gate: 'staff' };
// 읽기 실패는 기본표(전부 관리자만) 폴백 = 가장 닫힌 쪽(fail-closed). 등급표(apprGrades)와 같은 병합 규칙 — 저장본이 기본표 위에 얹힌다
async function docSettings(st) {
  const out = { scope_default: Object.assign({}, DOC_SETTINGS_DEFAULTS.scope_default), register_gate: DOC_SETTINGS_DEFAULTS.register_gate, updated_at: 0, updated_by: '', read_failed: false };
  try {
    const r = await blobGet(st, DOC_SETTINGS_KEY);
    if (r.ok && r.data) {
      const sd = r.data.scope_default;
      if (sd && typeof sd === 'object') DOC_SCOPE_CATS.forEach(function (cat) { if (typeof sd[cat] === 'string' && hasOwn(DOC_SCOPE_VALS, sd[cat])) out.scope_default[cat] = sd[cat]; });
      if (r.data.register_gate === 'none' || r.data.register_gate === 'staff') out.register_gate = r.data.register_gate;
      out.updated_at = r.data.updated_at || 0; out.updated_by = r.data.updated_by || '';
    } else if (!r.ok && r.code !== 'NOT_FOUND') out.read_failed = true;
  } catch (e) { out.read_failed = true; }
  return out;
}
// scope 정규화 — 화이트리스트 밖 값은 버린다(무효값이 "미지정=분류 기본"으로 떨어지게). ids는 문자열만·중복 제거·상한 50
function docScopeNorm(s) {
  if (typeof s === 'string') return hasOwn(DOC_SCOPE_VALS, s) ? s : null;
  if (s && typeof s === 'object' && Array.isArray(s.ids)) {
    const seen = {}, ids = [];
    s.ids.forEach(function (x) { if (typeof x === 'string' && x && !seen[x] && ids.length < 50) { seen[x] = 1; ids.push(x); } });
    return { ids: ids };
  }
  return null;
}
function docStatusOf(it) { return (it && (it.status === '대기' || it.status === '반려')) ? it.status : '등재'; }
// 재상신 멱등키 — 첫 상신 'docreg-<id>', 반려 후 재상신은 reg_n을 올려 'docreg-<id>-<n>'(닫힌 구 카드의 cid 멱등에 걸리지 않게)
function docRegCid(it) { const n = Number(it && it.reg_n) || 1; return 'docreg-' + it.id + (n > 1 ? '-' + n : ''); }
function docScopeMatch(sc, m) {
  if (!m) return false;
  if (m.admin) return true;
  if (sc === 'all') return true;
  if (sc === 'mgmt') return docCanSee01(m);
  if (sc && typeof sc === 'object' && Array.isArray(sc.ids)) return sc.ids.indexOf(m.id) >= 0;
  return false;   // 'admin'·미지정
}
// 유효 공개범위: 문서 scope > 분류 기본값. 01은 기본 'mgmt'(하드차단과 동일 축 — 문서 scope로 더 좁힐 수는 있어도 넓힐 수는 없다)
function docScopeOf(it, settings) {
  const own = docScopeNorm(it && it.scope);
  if (own) return own;
  const maj = docMajorOf(it);   // 분류 기본값은 대분류 단위(v317)
  if (maj === '01') return 'mgmt';
  return (settings && settings.scope_default && typeof settings.scope_default[maj] === 'string' && hasOwn(DOC_SCOPE_VALS, settings.scope_default[maj])) ? settings.scope_default[maj] : 'admin';
}
// 열람 판정(서버 하드차단 — get 필터·save 재구성 공용). 관리자 무제한. '대기'·'반려'는 등재한 본인만.
// 등재한 본인(by.id)은 자기 문서를 항상 본다 — 자기가 올린 문서가 승인 뒤 사라지는 혼란 방지(정보 유출 없음: 본인이 쓴 내용)
function docVisible(m, it, settings) {
  if (!it || !m) return false;
  if (m.admin) return true;
  if (docMajorOf(it) === '01' && !docCanSee01(m)) return false;   // 01 하드차단(대분류 판정, v317)이 본인 예외보다 앞 — 관리자가 직원 문서를 01로 옮기면 그 직원도 못 본다(적대 검증 low6)
  const mine = !!(it.by && it.by.id === m.id);
  if (docStatusOf(it) !== '등재') return mine;
  if (mine) return true;
  return docScopeMatch(docScopeOf(it, settings), m);
}
// DOC_CAT_LABEL은 위 2층 분류 표에서 생성(v317)
const DOC_SCOPE_LABEL = { all: '전원', mgmt: '관리부+관리자', admin: '관리자만' };
function docScopeText(it, settings) {
  const own = docScopeNorm(it && it.scope);
  if (own && typeof own === 'object') return '지정 ' + own.ids.length + '명';
  if (own) return DOC_SCOPE_LABEL[own];
  return '분류 기본(' + (DOC_SCOPE_LABEL[docScopeOf(it, settings)] || '관리자만') + ')';
}
// 결재 카드 본문 — PM이 카드만 보고 판단할 수 있게 번호·분류·공개범위·링크·메모
function docRegBody(it, settings) {
  return [it.no ? '문서번호 ' + it.no : '', '분류 ' + (DOC_CAT_LABEL[docCatOf(it)] || '미분류'), '공개범위 ' + docScopeText(it, settings),
    it.url ? '링크 ' + it.url : '', it.note ? '메모 ' + it.note : ''].filter(Boolean).join(' · ').slice(0, 500);
}
// 첨부 메타(v315) — files:[{n,name,size,mime,ts,by}]는 doc_att_put/doc_att_del(·doc_bulk_put)로만 바뀐다. save 재구성은 서버 원본을 이월(관리자·비관리자 공통 —
// 비관리자의 위조·삭제 차단 + 낡은 사본 저장이 첨부 목록을 지우는 사고 차단). 바이트는 gw_files 'docatt:<docId>:<n>'
function docFilesFix(s, o) {
  if (o && Array.isArray(o.files) && o.files.length) s.files = o.files; else delete s.files;
  if (o && Number(o.att_seq) > 0) s.att_seq = Number(o.att_seq); else delete s.att_seq;   // 첨부 번호 카운터도 서버 원본(low4·low7 — 클라 사본이 카운터를 되돌려 번호 재사용을 만들지 않게)
}
// 결재 결과 → 문서 상태 반영(승인='등재'·반려='반려'). approval_decide 훅과 approvals_list 폴(재시도)이 같은 함수를 탄다 — 멱등:
//  ① 카드 cid가 문서의 현재 등재 cid와 같을 때만(재상신된 문서에 구 카드가 손대지 않게) ② 문서가 '대기'일 때만(이미 관리자가 직접 등재한 건은 그대로).
// 문서 블롭은 여기서만 결재 경로로 바뀐다 — 순서는 결재 상태 저장이 먼저, 이 반영은 그 뒤(실패해도 결재 결과는 확정, 다음 폴에서 재시도).
async function docRegisterApply(st, aps, by) {
  const targets = (aps || []).filter(function (a) { return a && a.kind === '문서함 등재' && (a.status === '승인' || a.status === '반려') && String(a.ref || '').indexOf('doc:') === 0 && a.cid; });
  if (!targets.length) return { ok: true, applied: 0 };
  const r = await blobGet(st, colKey('documents'));
  if (!r.ok) return { ok: false, code: r.code };
  const doc = (r.data && Array.isArray(r.data.items)) ? r.data : null;
  if (!doc) return { ok: true, applied: 0, skipped: 'no-doc' };
  const prevDoc = JSON.parse(JSON.stringify(doc));   // 스냅샷은 변형 전 상태여야 한다(아래에서 it을 제자리 수정)
  const changed = [];
  targets.forEach(function (a) {
    const id = String(a.ref).slice(4);
    const it = doc.items.find(function (x) { return x && x.id === id; });
    if (!it || docRegCid(it) !== a.cid || docStatusOf(it) !== '대기') return;
    const nowIso = new Date().toISOString();
    if (a.status === '승인') {
      it.status = '등재'; it.registered_by = a.decided_by || { id: by.id, name: by.name }; it.registered_at = a.decided_at || nowIso; delete it.reject_reason; delete it.rejected_at;   // 재상신 승인 시 반려 잔존 정리
    } else {
      it.status = '반려'; it.reject_reason = String(a.reason || '').slice(0, 300); it.rejected_at = a.decided_at || nowIso;
    }
    it.updated_ts = Date.now(); it.updated = verDay(it.updated_ts);
    changed.push({ id: id, status: it.status, title: String(it.title || '').slice(0, 40) });
  });
  if (!changed.length) return { ok: true, applied: 0 };
  await verSnapshot('documents', prevDoc, by.name + '(결재 반영)', false);   // 사람 저장과 같은 시점 보존(변형 전 문서)
  doc.updated_by = by.id; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('documents'), doc);
  if (!w.ok) return { ok: false, code: w.code };
  // 동시 저장(관리자 문서 편집)의 덮어쓰기가 이 전환을 되돌릴 수 있다 — 재확인 후 1회 재적용(approvals 자가복구와 같은 패턴).
  // 재적용은 문서가 여전히 '대기'(같은 cid)일 때만 — 그 사이 관리자가 직접 등재한 문서를 뒤늦은 반려가 '반려'로 뒤집지 않게(적대 검증 low7)
  try {
    const chk = await blobGet(st, colKey('documents'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items)) {
      let drift = false;
      changed.forEach(function (ch) {
        const cur = chk.data.items.find(function (x) { return x && x.id === ch.id; });
        const src = doc.items.find(function (x) { return x && x.id === ch.id; });
        if (cur && src && cur.status !== ch.status && docStatusOf(cur) === '대기' && docRegCid(cur) === docRegCid(src)) {
          cur.status = src.status; cur.registered_by = src.registered_by; cur.registered_at = src.registered_at;
          if (src.reject_reason != null) cur.reject_reason = src.reject_reason; else delete cur.reject_reason;
          if (src.rejected_at != null) cur.rejected_at = src.rejected_at; else delete cur.rejected_at;
          cur.updated_ts = src.updated_ts; cur.updated = src.updated; drift = true;
        }
      });
      if (drift) { chk.data.updated_by = by.id; chk.data.updated_at = Date.now(); await blobSet(st, colKey('documents'), chk.data); }
    }
  } catch (e) {}
  try { await appendAudit({ ts: Date.now(), by: by.name, bid: by.id, col: 'documents', ev: changed.map(function (ch) { return { op: ch.status === '등재' ? '등재' : '등재반려', id: ch.id, t: ch.title }; }) }); } catch (e) {}
  return { ok: true, applied: changed.length };
}

async function handleGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (Object.prototype.hasOwnProperty.call(PRIVATE_COL, d.collection)) {   // 'constructor' 등 상속 키 우회 방지
    const pr = await blobGet(store(DATA), `priv:${c.member.id}:${d.collection}`);
    return jr(200, { status: 'OK', collection: d.collection, doc: (pr.ok && pr.data) ? pr.data : { schema: 1, items: [] }, can_write: true, request_id: R });
  }
  const col = d.collection;
  if (!Object.prototype.hasOwnProperty.call(COL, col)) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  // 일감(bids)·공매(onbid)·가족친화 대장(family)은 관리자 전용 — 개별 권한과 무관하게 서버측 강제
  if ((col === 'bids' || col === 'onbid' || col === 'family') && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const p = permOf(c.member, col);
  // tasks: 개인 인박스('내게 온 지시')·홈 미완료지시는 권한과 무관하게 노출해야 하므로 hide여도 읽기 허용.
  // 가시성(담당/전사/공개범위) 필터는 프런트에서. 쓰기는 여전히 'do' 필요.
  if (p === 'hide' && col !== 'tasks') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(DATA), colKey(col));
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  let doc = r.data || { schema: 1, items: [] };
  // 차량 취득가액·무자료금액은 관리자 전용 — 비관리자에겐 서버에서 제거(클라이언트 숨김이 아닌 하드 차단)
  if (col === 'vehicles' && !c.member.admin && Array.isArray(doc.items)) {
    doc = Object.assign({}, doc, { items: doc.items.map(function (v) {
      if (!v || (v.acq_price == null && v.nodoc_amt == null)) return v;
      const s = Object.assign({}, v); delete s.acq_price; delete s.nodoc_amt; return s;
    }) });
  }
  // 문서함(v314): 비관리자는 (문서 scope 또는 분류 기본값)에 맞고 '등재'된 문서만 — 01 법인 하드차단(2026-09-02)·'대기'·'반려'(등재 본인만)까지
  // docVisible 한 규칙으로 서버 하드 차단. del:1 항목도 규칙만 맞으면 그대로 내려간다(소프트 삭제·복구는 클라 몫 — 임시 숨김 hidden_tmp 건 포함)
  if (col === 'documents' && !c.member.admin && Array.isArray(doc.items)) {
    const ds = await docSettings(store(DATA));
    doc = Object.assign({}, doc, { items: doc.items.filter(function (it) { return docVisible(c.member, it, ds); }) });
  }
  return jr(200, { status: 'OK', collection: col, doc, can_write: p === 'do', request_id: R });
}

async function handleSave(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (Object.prototype.hasOwnProperty.call(PRIVATE_COL, d.collection)) {   // 'constructor' 등 상속 키 우회 방지
    if (!d.doc || typeof d.doc !== 'object') return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
    const pw = await blobSet(store(DATA), `priv:${c.member.id}:${d.collection}`, Object.assign({}, d.doc, { updated_at: Date.now() }));
    if (!pw.ok) return jr(500, { status: 'ERROR', error_code: pw.code, request_id: R });
    return jr(200, { status: 'OK', request_id: R });
  }
  const col = d.collection;
  if (!Object.prototype.hasOwnProperty.call(COL, col)) return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R });
  // tasks: 직원(권한 do 아님)도 '내게 온 지시'를 완료(→승인대기)/보류하려면 저장이 필요 → 승인제 성립.
  // tasks 쓰기는 인증·인가 회원이면 허용(프런트 canActTask로 자기 업무만 조작, UI 권한 구분이지 하드보안 아님).
  if ((col === 'bids' || col === 'onbid' || col === 'family') && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (permOf(c.member, col) !== 'do' && col !== 'tasks' && col !== 'leaves') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  if (!d.doc || typeof d.doc !== 'object') return jr(400, { status: 'REJECTED', error_code: 'INVALID_DOC', request_id: R });
  // 감사 로그용 이전 문서(diff 원본) — 읽기 실패해도 저장은 진행
  let oldItems = [], prevDoc = null, prevReadFailed = false;
  try { const prev = await blobGet(store(DATA), colKey(col)); if (prev.ok) { if (prev.data) { prevDoc = prev.data; if (Array.isArray(prev.data.items)) oldItems = prev.data.items; } } else prevReadFailed = true; } catch (e) { prevReadFailed = true; }
  // 낙관적 락: 클라이언트가 로드했던 문서 시각(base)과 서버 현재가 다르면 409 → 프런트의 기존 충돌 병합 경로가 재조회·병합·재시도.
  // 종전엔 감지 자체가 없어 두 관리자 동시 저장 시 늦은 쪽이 앞선 수정을 통째로 덮었다. base 미전송(구버전 캐시)·첫 저장은 종전대로.
  if (d.base !== undefined && prevDoc && prevDoc.updated_at && Number(d.base) !== Number(prevDoc.updated_at))
    return jr(409, { status: 'CONFLICT', error_code: 'STALE_BASE', request_id: R });
  const doc = Object.assign({}, d.doc, { updated_by: c.member.id, updated_at: Date.now() });
  // items형 컬렉션 정규화 — items가 배열이 아니면(콘솔 우회 등) 아래 재구성 가드들이 통째로 건너뛰어진다(리뷰 지적)
  if (col !== 'checklist' && !Array.isArray(doc.items)) doc.items = [];
  // 휴가: 신청 저장은 전 직원 필요하지만, 비관리자 저장은 서버가 재구성 — 타인 항목은 서버 원본 유지(클라이언트 사본으로 못 덮음),
  // 본인 항목만 반영, 승인 상태는 스스로 못 올림. (종전엔 전면 면제라 임의 직원이 전사 휴가 문서를 통째로 조작할 수 있었다.
  // 거부(403) 방식이 아니라 재구성인 이유: 낡은 사본으로 저장해도 타인 신청이 유실되지 않게)
  if (col === 'leaves' && !c.member.admin && Array.isArray(doc.items)) {
    const mine = c.member.id;
    const others = oldItems.filter(function (o) { return o && o.member_id !== mine; });
    const oldBy = {}; oldItems.forEach(function (o) { if (o && o.id) oldBy[o.id] = o; });
    const own = doc.items.filter(function (x) { return x && x.member_id === mine; }).map(function (b) {
      const a = oldBy[b.id];
      if (b.status === 'approved' && !(a && a.status === 'approved')) { b = Object.assign({}, b); b.status = a ? a.status : 'pending'; }
      return b;
    });
    doc.items = others.concat(own);
  }
  // 인허가 3층(2026-09-02): duties(의무 대장)는 ①구버전 클라·구형 캐시가 모르는 필드라 빠지거나 비어 오면
  // 저장 한 번에 95행+확정 이력이 통째로 증발한다(리뷰 high) — 서버가 원본을 이월. ②등재·확정 전환은 관리자 전용.
  if (col === 'licenses') {
    // 직전 문서를 못 읽으면 이월 판단 자체가 불가 — fail-open이면 원 결함(증발)이 그대로 재발하므로 licenses만 저장 거부(리뷰 med)
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    const prevDuties = (prevDoc && Array.isArray(prevDoc.duties)) ? prevDoc.duties : [];
    if (!c.member.admin || !Array.isArray(doc.duties) || (doc.duties.length === 0 && prevDuties.length > 0)) doc.duties = prevDuties;
  }
  // 문서함(v314 공개범위·등재 결재):
  //  관리자 = 무제한. scope는 정규화만, 신규 항목은 status 없으면 즉시 '등재'(PM 전결 — 관리자가 올리면 그 자체가 결재).
  //  비관리자 = 서버 재구성. ①못 보는 문서(docVisible 거짓 — 분류 기본값·scope 밖·타인의 대기/반려)와 01 법인은 서버 원본 유지
  //    (판정은 "서버 기준 id" — 못 보는 문서를 지우거나 cat·scope를 바꿔 내보내는 탈취·열람 필터로 빠진 사본의 저장이 남의 문서를 지우는 사고 차단)
  //  ②기존 문서의 status·by·등재 기록은 서버 원본 고정(status를 '등재'로 올리는 시도 원복) — 단 본인 반려 건의 재상신(반려→대기·reg_n+1)만 허용
  //  ③신규 문서는 서버가 등재자(by) 스탬프 + 게이트(register_gate): 'staff'=대기(아래 결재함 자동 상신) / 'none'=즉시 등재
  let docPending = [], docSet = null, docDropped = [];
  if (col === 'documents') {
    // 직전 문서를 못 읽으면 이월 판단(비관리자=못 보는 문서 / 관리자·비관리자 공통=첨부 메타 files) 자체가 불가 — fail-open이면 저장 한 번에 숨은 문서·첨부 목록이 통째로 증발
    // (licenses duties와 같은 원칙). 관리자도 예외 없음(적대 검증 med2: 관리자 저장이 files 전량 삭제·스냅샷 없이 덮던 경로)
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    if (Array.isArray(doc.items)) doc.items = doc.items.filter(function (x) { return x && typeof x === 'object'; });
    if (c.member.admin) {
      const oldDocBy = {}; oldItems.forEach(function (o) { if (o && o.id) oldDocBy[o.id] = o; });
      const nowIso = new Date().toISOString();
      doc.items = doc.items.map(function (x) {
        const s = Object.assign({}, x);
        const sc = docScopeNorm(s.scope); if (sc) s.scope = sc; else delete s.scope;
        if (!(s.id && oldDocBy[s.id]) && s.status !== '등재') { s.status = '등재'; s.registered_by = { id: c.member.id, name: c.member.name }; s.registered_at = nowIso; delete s.reject_reason; }
        if (!(s.id && oldDocBy[s.id]) && !s.by) s.by = { id: c.member.id, name: c.member.name };
        docFilesFix(s, s.id ? oldDocBy[s.id] : null);   // 첨부 메타(v315)는 첨부 액션으로만 — 관리자 저장도 서버 원본 이월(낡은 사본이 첨부 목록을 지우지 않게)
        return s;
      });
    } else {
      docSet = await docSettings(store(DATA));
      const oldDocBy = {}; oldItems.forEach(function (o) { if (o && o.id) oldDocBy[o.id] = o; });
      const keep = [], keepIds = {};
      oldItems.forEach(function (o) { if (o && (docMajorOf(o) === '01' || !docVisible(c.member, o, docSet))) { keep.push(o); if (o.id) keepIds[o.id] = 1; } });
      const nowIso = new Date().toISOString(), me = { id: c.member.id, name: c.member.name };
      const out = [], seenOut = {};
      doc.items.forEach(function (x) {
        if (x.id && (keepIds[x.id] || seenOut[x.id])) return;   // 서버 원본 유지 / 같은 id 중복 전송은 첫 건만
        const o = x.id ? oldDocBy[x.id] : null;
        const s = Object.assign({}, x);
        if (o) {
          // 기존 문서(보이는 것): 내용 편집만 허용. 분류·공개범위·문서번호·구 분류 텍스트는 서버 원본 고정 — 관리부원이 mgmt→all·ids 확장·05→02 갈아타기로
          // 무결재 노출을 만들거나(적대 검증 med1), cat '01'로 보내 소실시키는(med3) 경로를 닫는다. cat은 원본 파생값을 명시 고정(no·title 편집으로 분류가 흔들리지 않게)
          s.cat = docCatOf(o);
          ['no', 'category', 'scope'].forEach(function (k) { if (o[k] != null) s[k] = o[k]; else delete s[k]; });
          // 상태·등재자·등재 기록도 원본 고정 — 재상신은 "본인 반려 건 + 클라가 reg_n을 정확히 +1로 보냄"만 명시 신호로 인정(low4: 낡은 '대기' 사본 편집이 재상신으로 오판되지 않게)
          const resubmit = docStatusOf(o) === '반려' && !!(o.by && o.by.id === me.id) && Number(x.reg_n) === (Number(o.reg_n) || 1) + 1;
          ['status', 'by', 'registered_by', 'registered_at', 'reject_reason', 'rejected_at', 'reg_n'].forEach(function (k) { if (o[k] != null) s[k] = o[k]; else delete s[k]; });
          if (resubmit) { s.status = '대기'; s.reg_n = (Number(o.reg_n) || 1) + 1; delete s.reject_reason; delete s.rejected_at; }
          docFilesFix(s, o);   // 첨부 메타 원본 고정(v315) — 비관리자가 files를 위조·삭제해 보내도 첨부 액션(doc_att_put/del)으로만 바뀐다
        } else {
          if (docMajorOf(x) === '01') { docDropped.push(x); return; }   // 신규 01 법인(대분류 판정)은 관리자만(2026-09-02 규칙) — 폐기 + 감사로그 '제거'
          const sc = docScopeNorm(s.scope); if (sc) s.scope = sc; else delete s.scope;
          s.by = me; delete s.registered_by; delete s.registered_at; delete s.reject_reason; delete s.rejected_at; delete s.reg_n;
          docFilesFix(s, null);   // 신규 문서는 첨부 0으로 시작(id 확정 뒤 doc_att_put)
          if (docSet.register_gate === 'none') { s.status = '등재'; s.registered_by = me; s.registered_at = nowIso; }
          else s.status = '대기';
        }
        if (s.status === '대기') docPending.push(s);
        if (s.id) seenOut[s.id] = 1;
        out.push(s);
      });
      doc.items = out.concat(keep);
    }
  }
  // 기성 돈 상태 3종(입금 paid·검수 reviewed·발행 invoice)은 관리자 전용 — 비관리자 저장은 서버가 기존값 강제 복원.
  // 분장 근거(용어집 v1): 공무는 청구 등록·수정까지, 상태 전환은 관리부. 화면 숨김은 안내일 뿐, 여기가 하드 차단(콘솔 우회 무력화)
  if (col === 'receivables' && !c.member.admin && Array.isArray(doc.items)) {
    const oldRecById = {};
    oldItems.forEach(function (o) { if (o && o.id) oldRecById[o.id] = o; });
    doc.items = doc.items.map(function (x) {
      if (!x) return x;
      const o = x.id ? oldRecById[x.id] : null;
      const s = Object.assign({}, x);
      if (o) { s.paid = (o.paid != null) ? o.paid : null; s.invoice = !!o.invoice; if (o.reviewed) s.reviewed = o.reviewed; else delete s.reviewed; }
      else { s.paid = null; s.invoice = false; delete s.reviewed; }   // 신규 청구는 항상 미입금·미발행·미검수로 시작
      return s;
    });
  }
  // 차량 관리자 전용 필드 보존 — 비관리자는 값을 받은 적이 없으므로(get에서 제거) 저장 시 기존값 복원
  if (col === 'vehicles' && !c.member.admin && Array.isArray(doc.items)) {
    const oldById = {};
    oldItems.forEach(function (o) { if (o && o.id) oldById[o.id] = o; });
    doc.items = doc.items.map(function (v) {
      const o = v && v.id ? oldById[v.id] : null;
      if (!o) return v;
      const s = Object.assign({}, v);
      if (o.acq_price != null) s.acq_price = o.acq_price;
      if (o.nodoc_amt != null) s.nodoc_amt = o.nodoc_amt;
      return s;
    });
  }
  await verSnapshot(col, prevDoc, c.member.name, false);   // 사람 저장은 매번 직전 상태 보존(시점 복구용)
  const w = await blobSet(store(DATA), colKey(col), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 감사 로그: 누가·언제·무엇을(이전값→새값). 서버측 기록이라 클라이언트 위변조 불가.
  try {
    let ev;
    if (col === 'checklist') {
      // checklist는 {records,custom} 스키마라 diffItems가 항상 빈 배열 — 체크 개수 변화라도 남긴다(M0 운영 모듈 무기록 방지)
      const cnt = function (dc) { let n = 0; const rec = (dc && dc.records) || {}; Object.keys(rec).forEach(function (t) { const ks = rec[t] || {}; Object.keys(ks).forEach(function (k) { n += Object.keys(ks[k] || {}).length; }); }); return n; };
      const c0 = cnt(prevDoc), c1 = cnt(doc);
      ev = (c0 === c1) ? [] : [{ op: '체크저장', id: '-', t: '체크 ' + c0 + '→' + c1 }];
    } else {
      ev = diffItems(oldItems, Array.isArray(doc.items) ? doc.items : []);
    }
    if (ev.length) await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: col, ev: ev });
  } catch (e) {}
  // 문서함 등재 결재 훅(v314): 비관리자의 '대기' 문서마다 결재함에 '문서함 등재' 카드를 서버가 대신 기안(by=등재한 직원, ref 'doc:'+id, cid 멱등).
  // 문서 저장이 먼저(사용자 본선), 상신은 그 뒤 — 상신 실패는 감사로그로 남기고 이 직원의 다음 문서 저장 때 같은 cid로 다시 시도(멱등이라 중복 0).
  // 재상신(reg_n) 건도 같은 경로. 정정 상신(dupOpenRef)은 'ab:' 전용이라 doc: 중복은 cid 멱등에만 의존한다.
  let regWarn = 0;
  if (col === 'documents' && !c.member.admin && docDropped.length) {
    try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: docDropped.map(function (x) { return { op: '제거', id: String(x.id || '-'), t: '01 법인 신규는 관리자만 · ' + String(x.title || '').slice(0, 40) }; }) }); } catch (e) {}
  }
  if (col === 'documents' && !c.member.admin && docPending.length) {
    try {
      const st = store(DATA);
      const ar = await approvalsDoc(st);
      const have = {};
      if (ar.ok) ar.doc.items.forEach(function (a) { if (a && a.cid) have[a.cid] = 1; });
      for (const p of docPending) {
        if (!p.id) continue;
        const cid = docRegCid(p);
        if (have[cid]) continue;
        const cr = await apprCreateItem(st, c.member, { kind: '문서함 등재', title: String(p.title || '(제목없음)').slice(0, 120), body: docRegBody(p, docSet), ref: 'doc:' + p.id, cid: cid });
        if (!cr.ok) { regWarn++; try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: [{ op: '등재상신실패', id: p.id, t: String(cr.code || '') + ' · ' + String(p.title || '').slice(0, 40) }] }); } catch (e) {} }
      }
    } catch (e) { regWarn++; }
  }
  const okOut = { status: 'OK', updated_at: doc.updated_at, request_id: R };
  if (regWarn) okOut.register_warn = regWarn;
  return jr(200, okOut);
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
  await verSnapshot(target, doc, '수집봇', true);   // 병합이 doc를 제자리 변형하므로 반드시 병합 전에(봇은 일 1개)
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
    aw.cats = {};
    if (a.cats && typeof a.cats === 'object') {   // 관심 공종(석면·준설·철거·해체) 분포
      Object.keys(a.cats).slice(0, 8).forEach(function (k) {
        const o = a.cats[k] || {};
        aw.cats[String(k).slice(0, 12)] = { n: Number(o.n) || 0, q1: Number(o.q1) || 0, med: Number(o.med) || 0, q3: Number(o.q3) || 0 };
      });
    }
    // 경북권 분포·슬레이트 기준선 — 전국 중앙값은 우리 참여 가능 물량과 다르다(실측)
    aw.gb = {};
    if (a.gb && typeof a.gb === 'object') {
      Object.keys(a.gb).slice(0, 8).forEach(function (k) {
        const o = a.gb[k] || {};
        aw.gb[String(k).slice(0, 12)] = { n: Number(o.n) || 0, q1: Number(o.q1) || 0, med: Number(o.med) || 0, q3: Number(o.q3) || 0 };
      });
    }
    if (a.slate && typeof a.slate === 'object') {
      aw.slate = {};
      ['all', 'gb'].forEach(function (k) {
        const o = a.slate[k];
        if (o && typeof o === 'object') aw.slate[k] = { n: Number(o.n) || 0, q1: Number(o.q1) || 0, med: Number(o.med) || 0, q3: Number(o.q3) || 0 };
      });
    }
    aw.gb_orgs = {};
    if (a.gb_orgs && typeof a.gb_orgs === 'object') {
      Object.keys(a.gb_orgs).slice(0, 30).forEach(function (org) {
        const o = a.gb_orgs[org] || {}, cats = {};
        if (o.cats && typeof o.cats === 'object') Object.keys(o.cats).slice(0, 4).forEach(function (c) { cats[String(c).slice(0, 8)] = Number(o.cats[c]) || 0; });
        aw.gb_orgs[String(org).slice(0, 40)] = { n: Number(o.n) || 0, q1: Number(o.q1) || 0, med: Number(o.med) || 0, q3: Number(o.q3) || 0, cats: cats };
      });
    }
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

// 정기업무 봇 ingest(autotask 크론 전용) — S1 단일 원천 이후 리포 tasks.json이 스테일 미러가 되어
// 크론 생성 지시(만기·미수·증명서)가 앱에 도달하지 않던 사고(2026-08-04 발견)의 수리.
// auto_key로 중복 방지 병합(앱 생성분과 동일 키 체계), hide_keys=자기정정(회색 차량 등) 숨김.
async function handleAutotaskIngest(event, d, R) {
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  if (!secret || String(d.key || '').trim() !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const items = Array.isArray(d.items) ? d.items : [];
  const hideKeys = Array.isArray(d.hide_keys) ? d.hide_keys.map(String) : [];
  const st = store(DATA);
  const r = await blobGet(st, colKey('tasks'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  await verSnapshot('tasks', doc, '정기봇', true);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const have = {};
  doc.items.forEach(function (t) { if (t && t.auto_key) have[t.auto_key] = t; });
  let made = 0, fixed = 0;
  for (const n of items.slice(0, 100)) {
    const k = String((n && n.auto_key) || '');
    if (!k || have[k]) continue;
    doc.items.push({ id: 't' + crypto.randomBytes(6).toString('hex'), title: String(n.title || '').slice(0, 120),
      detail: String(n.detail || '').slice(0, 500), who_id: '', who: '', scope: [],
      from: '자동', from_id: '', by: '자동', due: String(n.due || '').slice(0, 10), status: 'open',
      done_at: null, done_by: null, auto_key: k, created: today, updated: today });
    have[k] = doc.items[doc.items.length - 1];
    made++;
  }
  hideKeys.slice(0, 200).forEach(function (k) {
    const t = have[k];
    if (t && t.del !== 1) { t.del = 1; t.updated = today; fixed++; }
  });
  if (made || fixed) {
    doc.updated_by = '정기봇'; doc.updated_at = Date.now();
    const w = await blobSet(st, colKey('tasks'), doc);
    if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
    try { await appendAudit({ ts: Date.now(), by: '정기봇', bid: 'bot', col: 'tasks', ev: [{ op: '정기업무', id: '', t: '신규 ' + made + ' · 정정 ' + fixed }] }); } catch (e) {}
  }
  return jr(200, { status: 'OK', made: made, fixed: fixed, request_id: R });
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
  await verSnapshot('bids', doc, c.member.name, true);   // 수동 수집도 병합 전 보존(일 1개)
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
  await verSnapshot('bids', doc, c.member.name, false, true);   // 비우기는 파괴적 — 제외 대상이어도 강제 보존
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
  await verSnapshot('bids', doc, '수집봇', true);   // 결과 반영이 항목을 제자리 변형하므로 변형 전에(일 1개)
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
        pre: Number(n.result.pre) || 0, bss: Number(n.result.bss) || 0,   // 예정가격·기초금액(낙찰 건, 적격심사 프리필용)
        bidders: Number(n.result.bidders) || 0, checked: today };
    }
    if ((n.status === '낙찰' || n.status === '유찰') && (cur.status === '응찰' || cur.status === '참여')) {
      cur.status = n.status;
      ev.push({ op: '개찰결과', id: cur.id, t: String(cur.title||'').slice(0,30) + ' → ' + n.status });
    }
    cur.updated = today; applied++;
  }
  if (applied) {
    doc.updated_by = '수집봇'; doc.updated_at = Date.now();
    const w = await blobSet(st, colKey('bids'), doc);
    if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
    if (ev.length) { try { await appendAudit({ ts: Date.now(), by: '수집봇', bid: 'bot', col: 'bids', ev: ev }); } catch (e) {} }
    // 낙찰/유찰 확정 → 관리자 웹푸시(실패해도 수신 처리는 성공으로)
    if (ev.length) {
      try {
        const ids = await push.adminIds();
        if (ids.length) await push.sendTo(ids, { title: '개찰결과 ' + ev.length + '건',
          body: ev.map(function (x) { return x.t; }).join('\n').slice(0, 300), url: './', tag: 'bids-result' });
      } catch (e) {}
    }
  }
  return jr(200, { status: 'OK', applied: applied, request_id: R });
}

// 봇 알림(정기업무 크론 전용) — 공유 시크릿 인증. 관리자 접속과 무관하게 만기·미수 알림이 나가야 한다.
async function handleBotNotify(event, d, R) {
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  if (!secret || String(d.key || '').trim() !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const title = String(d.title || '알림').slice(0, 60);
  const body = String(d.body || '').slice(0, 300);
  const tag = String(d.tag || 'bot-notify').slice(0, 30);
  // 반환값은 실제 발송 결과(sent=성공한 기기 수). 관리자 수와 혼동하면 안 된다(과거 오보 원인).
  try {
    const ids = await push.adminIds();
    const subs = await push.getSubs();
    const devices = ids.reduce(function (n, id) { return n + ((subs.members[id] || []).length); }, 0);
    if (!ids.length) return jr(200, { status: 'OK', sent: 0, admins: 0, devices: 0, note: '관리자 없음', request_id: R });
    if (!devices) return jr(200, { status: 'OK', sent: 0, admins: ids.length, devices: 0, note: '구독 기기 없음 — 각 기기에서 [알림 켜기] 필요', request_id: R });
    const r = await push.sendTo(ids, { title: title, body: body, url: './', tag: tag });
    return jr(200, { status: 'OK', sent: r.sent, removed: r.removed, admins: ids.length, devices: devices, request_id: R });
  } catch (e) {
    return jr(200, { status: 'OK', sent: 0, note: 'push 예외: ' + String(e && e.message || e).slice(0, 80), request_id: R });
  }
}

// ---- 적격심사 증빙 보관함: 반복 제출하는 고정 증빙(등기부·확인서·등록증 등)을 서버 보관, 생성 시 일괄 다운로드 ----
function proofSlug(s) { return String(s || '').replace(/[^0-9A-Za-z가-힣._-]/g, '_').slice(0, 80); }
async function handleProofPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const name = proofSlug(d.name);
  const b64 = String(d.data || '');
  if (!name || name === '__index__' || !b64 || b64.length > ATT_MAX) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });   // __index__ 이름 충돌 시 색인 자기파괴 방지
  const st = store(FILES);
  const w = await blobSet(st, 'proof:' + name, { name: String(d.name || '').slice(0, 120), data: b64, by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '증빙등록', id: name.slice(0, 40), t: '' }] }); } catch (e) {}
  const idx = await blobGet(st, 'proof:__index__');
  const list = (idx.ok && idx.data && Array.isArray(idx.data.names)) ? idx.data.names : [];
  if (list.indexOf(name) < 0) list.push(name);
  await blobSet(st, 'proof:__index__', { names: list });
  return jr(200, { status: 'OK', name: name, request_id: R });
}
async function handleProofList(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const st = store(FILES);
  const idx = await blobGet(st, 'proof:__index__');
  const names = (idx.ok && idx.data && Array.isArray(idx.data.names)) ? idx.data.names : [];
  const out = [];
  for (const n of names) {
    const r = await blobGet(st, 'proof:' + n);
    if (r.ok && r.data) out.push({ name: n, file: r.data.name, ts: r.data.ts, size: (r.data.data || '').length });
  }
  return jr(200, { status: 'OK', items: out, request_id: R });
}
async function handleProofGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const r = await blobGet(store(FILES), 'proof:' + proofSlug(d.name));
  if (!r.ok || !r.data) return jr(404, { status: 'NOT_FOUND', request_id: R });
  return jr(200, { status: 'OK', file: r.data.name, data: r.data.data, request_id: R });
}
async function handleProofDel(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const name = proofSlug(d.name);
  if (!name || name === '__index__') return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  const st = store(FILES);
  await blobDelete(st, 'proof:' + name);
  const idx = await blobGet(st, 'proof:__index__');
  const list = ((idx.ok && idx.data && Array.isArray(idx.data.names)) ? idx.data.names : []).filter(function (n) { return n !== name; });
  await blobSet(st, 'proof:__index__', { names: list });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '증빙삭제', id: name.slice(0, 40), t: '' }] }); } catch (e) {}
  return jr(200, { status: 'OK', request_id: R });
}

// ---- 오류 텔레메트리: 클라이언트 오류를 서버에 축적(최근 200건), 관리자 조회 ----
async function handleErrLog(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const st = store(DATA);
  const r = await blobGet(st, 'err:log');
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  doc.items.push({ ts: Date.now(), by: c.member.name, msg: String(d.msg || '').slice(0, 300),
    src: String(d.src || '').slice(0, 200), stack: String(d.stack || '').slice(0, 600), ua: String(d.ua || '').slice(0, 120) });
  if (doc.items.length > 200) doc.items = doc.items.slice(-200);
  await blobSet(st, 'err:log', doc);
  return jr(200, { status: 'OK', request_id: R });
}
async function handleErrList(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const r = await blobGet(store(DATA), 'err:log');
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  return jr(200, { status: 'OK', items: items.slice(-100).reverse(), request_id: R });
}

// ---- 웹푸시: 구독 관리 + 발송(지시 배정 등 클라이언트 트리거) ----
async function handlePushPubkey(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  try {
    const k = await push.getKeys();
    return jr(200, { status: 'OK', publicKey: k.publicKey, request_id: R });
  } catch (e) { return jr(500, { status: 'ERROR', error_code: 'PUSH_KEYS_FAILED', request_id: R }); }
}
async function handlePushSub(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const s = d.sub;
  if (!s || typeof s !== 'object' || !s.endpoint || String(s.endpoint).length > 1000) return jr(400, { status: 'REJECTED', error_code: 'INVALID_SUB', request_id: R });
  const doc = await push.getSubs();
  const old = doc.members[c.member.id] || [];
  // 같은 endpoint 재등록 시 primary(우선기기, 결재 2차) 보존 — filter로 지우고 다시 넣는 구조라 그냥 두면 지정이 소실된다
  const prev = old.find(function (x) { return x && x.sub && x.sub.endpoint === s.endpoint; });
  const mine = old.filter(function (x) { return x && x.sub && x.sub.endpoint !== s.endpoint; });
  const entry = { sub: { endpoint: s.endpoint, expirationTime: s.expirationTime || null, keys: s.keys || {} }, ts: Date.now() };
  if (prev && prev.primary) entry.primary = 1;
  mine.push(entry);
  let kept = mine.slice(-5);   // 기기 5개까지
  // 우선기기 지정 구독은 한도에서 밀려나지 않게 보호 — 말없이 탈락하면 사용자가 알 길이 없다(리뷰 low)
  const prim = mine.find(function (x) { return x && x.primary; });
  if (prim && kept.indexOf(prim) < 0) kept = [prim].concat(kept.slice(1));
  doc.members[c.member.id] = kept;
  const w = await push.saveSubs(doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  return jr(200, { status: 'OK', devices: doc.members[c.member.id].length, request_id: R });
}
async function handlePushUnsub(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const ep = String(d.endpoint || '');
  const doc = await push.getSubs();
  const mine = (doc.members[c.member.id] || []).filter(function (x) { return x && x.sub && x.sub.endpoint !== ep; });
  if (mine.length) doc.members[c.member.id] = mine; else delete doc.members[c.member.id];
  await push.saveSubs(doc);
  return jr(200, { status: 'OK', request_id: R });
}
// 우선기기 1발(결재 2차, 배치도 결정 ③) — 본인 구독 중 endpoint 하나에 primary 표식, 나머지는 제거.
// 같은 endpoint 재호출이면 해제(토글). d.get=1이면 조회만(클라가 부팅 시 버튼 문구를 그리는 용도).
async function handlePushPrimary(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const doc = await push.getSubs();
  const mine = doc.members[c.member.id] || [];
  function curPrimary() {
    const p = mine.find(function (x) { return x && x.primary; });
    return (p && p.sub && p.sub.endpoint) || null;
  }
  if (d.get) return jr(200, { status: 'OK', primary: curPrimary(), request_id: R });
  const ep = String(d.endpoint || '');
  const target = mine.find(function (x) { return x && x.sub && x.sub.endpoint === ep; });
  if (!target) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_SUB', request_id: R });
  const wasPrimary = !!target.primary;
  for (const x of mine) { if (x) delete x.primary; }
  if (!wasPrimary) target.primary = 1;   // 이미 우선기기였으면 해제만(토글)
  const w = await push.saveSubs(doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  return jr(200, { status: 'OK', primary: curPrimary(), request_id: R });
}
async function handlePushSend(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const to = String(d.to || '');
  if (!to && d.self !== true) return jr(400, { status: 'REJECTED', error_code: 'NO_TARGET', request_id: R });
  const payload = { title: String(d.title || '알림').slice(0, 60), body: String(d.body || '').slice(0, 200),
    url: './', tag: String(d.tag || '').slice(0, 40) || undefined };
  try {
    let ids;
    if (d.self === true) ids = [c.member.id];
    else if (to === '__admins__') ids = (await push.adminIds()).filter(function (id) { return id !== c.member.id; });   // 본인 행동 알림은 본인 제외
    else ids = [to];
    if (!ids.length) return jr(200, { status: 'OK', sent: 0, request_id: R });
    const rres = await push.sendTo(ids, payload);
    return jr(200, { status: 'OK', sent: rres.sent, request_id: R });
  } catch (e) { return jr(500, { status: 'ERROR', error_code: 'PUSH_SEND_FAILED', request_id: R }); }
}

// 알림함 — 발송 이력 조회. 관리자·개발자는 전체, 일반 직원은 자기 앞으로 온 것만.
async function handlePushLog(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const lr = await blobGet(store('gw_data'), 'push:log');
  const items = (lr.ok && lr.data && Array.isArray(lr.data.items)) ? lr.data.items : [];
  const wide = !!(c.member.admin || c.member.dev);
  const mine = items.filter(function (it) {
    return wide || (Array.isArray(it.to) && it.to.indexOf(c.member.id) >= 0);
  });
  // 최신이 위로, to(수신자 목록)는 노출하지 않는다(명단 최소화).
  const out = mine.slice(-50).reverse().map(function (it) {
    return { ts: it.ts, title: it.title, body: it.body, tag: it.tag };
  });
  return jr(200, { status: 'OK', items: out, request_id: R });
}

// ---- 결재함(C안, 2026-09-01): 전용 화면 없이 뱃지→한 장씩 처리 ----
// 저장은 col:approvals 규격이지만 COL 맵엔 등록하지 않는다 — 일반 get/save를 열면
// 임의 직원이 타인 상신을 읽거나 결정 필드(status·decided_by)를 클라 사본으로 덮을 수 있어
// 전용 액션 3종으로만 접근한다(목록=본인분 필터, 결정=관리자 + 반려 사유 서버 검증).
// 대표 전용 건(9/3 PM 결정: 운반일지 결재=대표, 다른 관리자는 확인만) — to 필드 우선, 필드 없는 구건(9/2 이전)은 종류로 판정(하위호환).
// 같은 규칙이 워커(to 스탬프)·index.html(apprBossOnly)에도 있다 — 바꾸면 3곳 동시에.
function apprBossOnly(it) { return !!it && (it.to === 'boss' || (it.to == null && it.kind === '운반일지')); }

// ---- 결재 3차(업무별 등급, 명세 20260903): kind → ①PM 전결 / ②결재라인(PM→대표) / ③대표 전결 ----
// 등급은 "기안 시점 스냅샷"으로 항목(grade)에 박힌다 — 등급표를 나중에 바꿔도 진행 중 건의 경로는 안 바뀐다(§3.1).
// grade 없는 항목(구건·등급표 밖 kind) = 현행 동작 그대로(관리자 전원 목록·admin 게이트) — 하위호환 §6.
const APPR_GRADES_KEY = 'settings:approvals';
// §2 배정표 — 9/3 PM 전량 확정(① 11종 · ② 사직·휴직 · ③ 운반일지·지입료). 기존 결재 종류 5종은 라이브 kind 문자열
// 그대로, 나머지는 각 모듈에 결재 생성 훅이 붙을 때 이 키와 같은 kind로 상신해야 등급이 먹는다(§3.3).
const APPR_GRADE_DEFAULTS = {
  '운반일지': 3, '지입료': 3,
  '사직·휴직': 2,
  '지시': 1, '사규': 1, '매뉴얼': 1, '가족친화': 1, '휴가': 1, '계약 단계': 1,
  '청구 검수': 1, '문서함 등재': 1, '견적': 1, '인허가 등재': 1, '조기퇴근': 1,
};
// 병합 규칙: 저장본(관리 화면 변경분)이 기본표 위에 얹힌다. 값 0 = "현행(등급 미정)"으로 되돌린 것.
// 읽기 실패는 기본표 폴백 — 상신 자체를 막는 것보다 §2 확정표대로 가는 쪽이 안전(변경분 유실은 일시적, 표 변경은 드묾).
async function apprGrades(st) {
  try {
    const r = await blobGet(st, APPR_GRADES_KEY);
    if (r.ok && r.data && r.data.grades && typeof r.data.grades === 'object')
      return Object.assign({}, APPR_GRADE_DEFAULTS, r.data.grades);
  } catch (e) {}
  return Object.assign({}, APPR_GRADE_DEFAULTS);
}
async function handleApprGradesGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const grades = await apprGrades(st);
  let meta = {};
  try { const r = await blobGet(st, APPR_GRADES_KEY); if (r.ok && r.data) meta = { updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '' }; } catch (e) {}
  return jr(200, { status: 'OK', grades: grades, defaults: APPR_GRADE_DEFAULTS, updated_at: meta.updated_at || 0, updated_by: meta.updated_by || '', request_id: R });
}
async function handleApprGradesSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });   // PM=admin만 변경(명세 §3.2)
  const kind = String(d.kind || '').trim().slice(0, 20);
  const grade = Number(d.grade);
  if (!kind || kind === '전결총정리') return jr(400, { status: 'REJECTED', error_code: 'BAD_KIND', request_id: R });
  if (grade !== 0 && grade !== 1 && grade !== 2 && grade !== 3) return jr(400, { status: 'REJECTED', error_code: 'BAD_GRADE', request_id: R });
  const st = store(DATA);
  // 등록 가능한 kind = 기본표 키 + 이미 저장된 키(임의 문자열로 표가 오염되지 않게)
  let stored = {}, curAt = 0;
  try { const r = await blobGet(st, APPR_GRADES_KEY); if (r.ok && r.data) { if (r.data.grades && typeof r.data.grades === 'object') stored = r.data.grades; curAt = r.data.updated_at || 0; } } catch (e) {}
  // 낙관락 — 두 관리자 동시 변경의 lost-update 방지(리뷰 low). base 미전송(구클라)은 종전대로 last-write
  if (d.base !== undefined && Number(d.base) !== Number(curAt))
    return jr(409, { status: 'CONFLICT', error_code: 'GRADES_STALE', request_id: R });
  if (!Object.prototype.hasOwnProperty.call(APPR_GRADE_DEFAULTS, kind) && !Object.prototype.hasOwnProperty.call(stored, kind))
    return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_KIND', request_id: R });
  const before = Object.prototype.hasOwnProperty.call(stored, kind) ? stored[kind] : APPR_GRADE_DEFAULTS[kind];
  stored[kind] = grade;
  const doc = { schema: 1, grades: stored, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, APPR_GRADES_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 변경 감사로그(명세 §2) — 진행 중 건은 스냅샷이라 영향 없음(항목 grade가 이미 박혀 있다)
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'approvals', ev: [{ op: '등급변경', id: kind, t: kind + ' ' + before + '→' + grade + (grade === 0 ? '(현행)' : '') }] }); } catch (e) {}
  return jr(200, { status: 'OK', grades: Object.assign({}, APPR_GRADE_DEFAULTS, stored), updated_at: doc.updated_at, request_id: R });
}
// ---- 문서함 설정(v314): 분류별 기본 공개범위 + 등재 결재 게이트. 관리자 전용·감사로그·낙관락(등급표 패턴) ----
async function handleDocSettingsGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const s = await docSettings(store(DATA));
  return jr(200, { status: 'OK', settings: { scope_default: s.scope_default, register_gate: s.register_gate }, defaults: DOC_SETTINGS_DEFAULTS, updated_at: s.updated_at, updated_by: s.updated_by, request_id: R });
}
async function handleDocSettingsSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });   // PM=admin만 변경
  const st = store(DATA);
  const cur = await docSettings(st);
  // 읽기 실패 위에 쓰면 저장돼 있던 다른 분류의 설정이 기본표로 되돌아간다 — 거부
  if (cur.read_failed) return jr(500, { status: 'ERROR', error_code: 'SETTINGS_READ_FAILED', request_id: R });
  // 낙관락 — 두 관리자 동시 변경의 lost-update 방지(등급표 GRADES_STALE와 동일). base 미전송(구클라)은 last-write
  if (d.base !== undefined && Number(d.base) !== Number(cur.updated_at))
    return jr(409, { status: 'CONFLICT', error_code: 'DOC_SETTINGS_STALE', request_id: R });
  let evText = '';
  if (d.cat !== undefined) {
    const cat = String(d.cat || ''), scope = String(d.scope || '');
    if (DOC_SCOPE_CATS.indexOf(cat) < 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_CAT', request_id: R });   // 설정 키는 대분류 2자리만('AA-BB' 중분류 키·표 밖·01 법인 전부 BAD_CAT — 01은 하드차단이라 설정 대상 아님)
    if (!hasOwn(DOC_SCOPE_VALS, scope)) return jr(400, { status: 'REJECTED', error_code: 'BAD_SCOPE', request_id: R });
    evText = '기본 공개범위 ' + cat + ' ' + cur.scope_default[cat] + '→' + scope;
    cur.scope_default[cat] = scope;
  } else if (d.register_gate !== undefined) {
    const g = String(d.register_gate || '');
    if (g !== 'staff' && g !== 'none') return jr(400, { status: 'REJECTED', error_code: 'BAD_GATE', request_id: R });
    evText = '등재 결재 ' + cur.register_gate + '→' + g;
    cur.register_gate = g;
  } else return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const docS = { schema: 1, scope_default: cur.scope_default, register_gate: cur.register_gate, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, DOC_SETTINGS_KEY, docS);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: [{ op: '문서함설정', id: '-', t: evText }] }); } catch (e) {}
  return jr(200, { status: 'OK', settings: { scope_default: docS.scope_default, register_gate: docS.register_gate }, updated_at: docS.updated_at, request_id: R });
}
async function approvalsDoc(st) {
  const r = await blobGet(st, colKey('approvals'));
  // 읽기 실패를 빈 문서로 위조하면 다음 쓰기가 대장 전체를 1건짜리로 덮는다(클라 shim과 같은 원칙) — 실패는 실패로 반환
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, doc: (r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] } };
}
async function handleApprovalsList(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const rd = await approvalsDoc(store(DATA));
  if (!rd.ok) return jr(500, { status: 'ERROR', error_code: rd.code, request_id: R });
  const doc = rd.doc;
  // 문서함 등재 재시도(v314): decide 시점에 문서 반영이 실패한 건을 관리자 폴이 멱등으로 주워 담는다 — 최근 7일 결정분만 후보(문서 블롭 1회 읽기),
  // 이미 반영된 건은 docRegisterApply가 '대기' 아님·cid 불일치로 건너뛴다. 실패는 조용히(다음 폴).
  let docFresh = doc;
  if (c.member.admin) {
    try {
      const since = Date.now() - 7 * 86400000;
      const cands = doc.items.filter(function (a) { return a && a.kind === '문서함 등재' && (a.status === '승인' || a.status === '반려') && a.cid && String(a.ref || '').indexOf('doc:') === 0 && (Date.parse(a.decided_at || '') || 0) >= since; });
      if (cands.length) await docRegisterApply(store(DATA), cands, c.member);
      // 반대 방향(적대 검증 med2): '대기' 문서인데 현재 cid의 카드가 없으면(저장 시 자동 상신 실패 고착) 관리자 폴이 등재자 명의로 대신 기안 — cid 멱등
      const made = await docRegisterReconcileCreate(store(DATA), doc.items);
      if (made) { const rd3 = await approvalsDoc(store(DATA)); if (rd3.ok) docFresh = rd3.doc; }   // 방금 만든 카드가 이 응답에 바로 실리게
    } catch (e) {}
  }
  const items = c.member.admin ? docFresh.items : doc.items.filter(function (it) { return it && it.by && it.by.id === c.member.id; });
  // base = 낙관락 토큰. decide가 이 값을 들고 와야 하며 불일치면 409 APPR_STALE(관리자 2인 동시 결재 유실 방지)
  // boss_present — 대표 계정 존재 여부(클라 apprCanDecide 폴백용: 대표가 없으면 관리자 전원이 대표 전용 건을 결재). 관리자에게만 계산(회원 블롭 스캔)
  // pm_present — 비대표 관리자 존재 여부(결재 3차: ①·② 1단계는 비대표 관리자 전용인데, 없으면 대표에게 연다 — 서버 PM_ONLY 게이트와 같은 축)
  const bossN = c.member.admin ? (await push.bossIds()).length : 0;
  const pmN = c.member.admin ? (await push.pmIds()).length : 0;
  // grades — 현재 등급표 스냅샷(v315 기안 화면의 등급·흐름 미리보기용). 정책표라 비관리자에게도 내려간다(appr_grades_get은 관리 화면 전용 admin 게이트 유지).
  // 기안 시 진짜 등급은 서버 apprCreateItem이 다시 표를 읽어 스탬프한다 — 이 값은 표시용
  const grades = await apprGrades(store(DATA));
  return jr(200, { status: 'OK', items: items, base: docFresh.updated_at || 0, boss_present: bossN > 0, pm_present: pmN > 0, grades: grades, request_id: R });
}
// '대기' 문서 ↔ 카드 반대 방향 재시도(med2): 문서 블롭 1회 읽기, 현재 cid(docreg-<id>[-n])의 카드가 어떤 상태로도 없을 때만 생성(결정된 카드가 있으면 정방향 반영 몫).
// 기안자=문서 등재자(by) 명의 — 상신 규칙(등급 스냅샷·푸시)은 apprCreateItem 그대로. 삭제(del:1) 문서는 제외. 반환=생성 건수
async function docRegisterReconcileCreate(st, apItems) {
  const r = await blobGet(st, colKey('documents'));
  if (!r.ok || !r.data || !Array.isArray(r.data.items)) return 0;
  const pend = r.data.items.filter(function (it) { return it && it.id && it.del !== 1 && docStatusOf(it) === '대기' && it.by && it.by.id; });
  if (!pend.length) return 0;
  const have = {}; (apItems || []).forEach(function (a) { if (a && a.cid) have[a.cid] = 1; });
  const todo = pend.filter(function (it) { return !have[docRegCid(it)]; });
  if (!todo.length) return 0;
  const ds = await docSettings(st);
  let made = 0;
  for (const p of todo) {
    const cr = await apprCreateItem(st, { id: p.by.id, name: p.by.name || '' }, { kind: '문서함 등재', title: String(p.title || '(제목없음)').slice(0, 120), body: docRegBody(p, ds), ref: 'doc:' + p.id, cid: docRegCid(p) });
    if (cr.ok && !cr.dedup) { made++; try { await appendAudit({ ts: Date.now(), by: '서버', bid: '__system__', col: 'documents', ev: [{ op: '등재상신복구', id: p.id, t: String(p.title || '').slice(0, 40) + ' (관리자 결재함 조회 시 대신 기안)' }] }); } catch (e) {} }
  }
  return made;
}
// 전결 종결이 불가한 종류(v315) — 각각 전용 경로가 있다: 운반일지(③·올바로 자동 기안), 문서함 등재(문서함 게이트 훅 — 문서 '등재'와 사규 '결재'는 별개 행위),
// 휴가(휴가 모듈 승인·총정리 읽기 합산), 전결총정리(크론). 기안 화면(index APPR_DRAFT_EXCLUDE)과 같은 목록이어야 한다(uismoke 대조).
const APPR_SELF_DECIDE_EXCLUDE = { '지시': 1, '운반일지': 1, '문서함 등재': 1, '휴가': 1, '전결총정리': 1 };   // 지시는 지시 탭 전용(담당 완료→승인 흐름·ref=지시 id) — 기안 화면·전결 대상 아님(low8)
async function handleApprovalCreate(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const title = String(d.title || '').trim().slice(0, 120);
  if (!title) return jr(400, { status: 'REJECTED', error_code: 'NO_TITLE', request_id: R });
  const kind0 = String(d.kind || '일반').slice(0, 20);
  if (kind0 === '전결총정리') return jr(400, { status: 'REJECTED', error_code: 'SYSTEM_KIND', request_id: R });   // 크론 전용 kind — 사용자 기안 불가(§3.3)
  // 전결 종결(v315, PM 9/4 "사규·가족친화 결재는 어딨노"): 기안자가 비대표 관리자(PM)이고 ① 등급이면 기안=결재 —
  // 카드 생성과 '승인' 기록을 한 번의 쓰기로(create+decide 두 번 왕복 금지, 결재 큐에 잠깐이라도 뜨지 않게).
  // 거부는 전부 400(클라가 [상신]으로 되돌리게): 비관리자·대표(대표는 기안 대상 아님) / ②·③·미정 등급 / 전용 경로가 있는 종류
  const selfDecide = !!d.self_decide;
  if (selfDecide) {
    if (!c.member.admin || push.isBoss(c.member)) return jr(400, { status: 'REJECTED', error_code: 'SELF_DECIDE_PM_ONLY', request_id: R });
    if (APPR_SELF_DECIDE_EXCLUDE[kind0]) return jr(400, { status: 'REJECTED', error_code: 'SELF_DECIDE_KIND', request_id: R });
  }
  const r = await apprCreateItem(store(DATA), c.member, { kind: kind0, title: title, body: d.body, ref: d.ref, cid: d.cid, boss_up: !!d.boss_up, self_decide: selfDecide });
  if (!r.ok) return jr(r.http === 400 ? 400 : 500, { status: r.http === 400 ? 'REJECTED' : 'ERROR', error_code: r.code, request_id: R });
  const out = { status: 'OK', id: r.id, request_id: R };
  if (r.dedup) out.dedup = true;
  if (r.updated) out.updated = true;
  if (r.self_decided) out.decided = '승인';   // 전결 종결(또는 그 재시도의 cid 멱등 흡수) — 클라가 "전결 종결"로 표시
  return jr(200, out);
}
// 상신 본체 — 사용자 기안(handleApprovalCreate)과 서버 내부 훅(문서함 등재 자동 상신, v314)이 같은 규칙을 탄다:
// cid 멱등·dupOpenRef(ab: 정정)·등급 스냅샷·자가복구·감사로그·푸시 라우팅. 두 벌로 갈라지면 등급표·통지가 한쪽만 바뀌는 사고가 난다.
// 입력 검증(title 비어있음·시스템 kind)은 호출자 몫. member = 기안자(훅에서는 등재한 직원). 반환 {ok,id,dedup|updated} / {ok:false,code}
async function apprCreateItem(st, member, o) {
  const title = String(o.title || '').trim().slice(0, 120);
  const kind0 = String(o.kind || '일반').slice(0, 20);
  const rd = await approvalsDoc(st);
  if (!rd.ok) return { ok: false, code: rd.code };
  const doc = rd.doc;
  // 멱등키(cid): 클라 재시도(응답 유실)로 같은 상신이 2건 생기는 것을 서버에서 흡수
  const cid = String(o.cid || '').slice(0, 48);
  if (cid) {
    const dup = doc.items.find(function (x) { return x && x.cid === cid; });
    if (dup) return { ok: true, id: dup.id, dedup: true, self_decided: dup.self_decided === true };
  }
  // 운반일지(ref ab:날짜)는 자동 기안(워커)과 수동 상신이 같은 날짜에 겹친다 — 열린(대기·보류) 동일 ref는
  // 새 카드를 만들지 않고 기존 카드를 정정본으로 갱신한다(아래 fresh 단계). 조용한 흡수는 자동 기안(자동수집분만)의
  // body를 수기 포함본으로 고칠 통로를 없앤다(리뷰 med). 승인·반려 종결 건은 통과 → 재상신 경로 보존.
  // 비관리자는 목록에서 타인·시스템 상신을 못 보므로 클라 중복 검사만으론 못 막는다 — 여기가 최후 방어선
  const refIn = String(o.ref || '').slice(0, 60);
  function dupOpenRef(items) {
    if (refIn.indexOf('ab:') !== 0) return null;
    return items.find(function (x) { return x && x.ref === refIn && (x.status === '대기' || x.status === '보류'); }) || null;
  }
  // 등급 스탬프(결재 3차 §4.3) — to·grade는 서버가 종류로 정한다(클라 값 불신). 기안 시점 스냅샷이라 이후 표 변경에 영향 없음.
  // 스냅샷 쓰기보다 앞에서 읽는다 — 전결 종결(v315)의 등급 거부가 복구 링에 빈 스냅샷을 남기지 않게
  const grades = await apprGrades(st);
  let grade = grades[kind0];
  if (grade !== 1 && grade !== 2 && grade !== 3) grade = 0;   // 0·미등재 = 등급 미정(현행)
  let escalated = false;
  if (grade === 1 && o.boss_up) { grade = 2; escalated = true; }   // "대표 상신" 토글 = ① 건별 ② 격상(§1)
  // 전결 종결(v315): ① 등급 + 비대표 관리자 기안일 때만(격상 ②·③·미정은 거부 — 클라는 [상신]으로 되돌린다). 호출자(handleApprovalCreate)도 같은 검사를 하지만
  // 본체가 최후 방어선(서버 내부 훅이 실수로 self_decide를 넘겨도 열리지 않게)
  const selfDecide = !!o.self_decide;
  if (selfDecide) {
    if (!(member.admin && !push.isBoss(member))) return { ok: false, code: 'SELF_DECIDE_PM_ONLY', http: 400 };
    if (grade !== 1) return { ok: false, code: 'SELF_DECIDE_GRADE1_ONLY', http: 400 };
    if (refIn.indexOf('ab:') === 0) return { ok: false, code: 'SELF_DECIDE_KIND', http: 400 };   // 운반일지 ref는 정정 흡수 경로(dupOpenRef) — 전결과 섞이지 않게
  }
  await verSnapshot('approvals', doc, member.name, false);   // 쓰기 전 시점 보존(복구 링 — 다른 컬렉션과 동일)
  // 레이스 창 축소: verSnapshot 왕복 사이 착지한 동시 결재/상신을 덮지 않게 쓰기 직전 신선본에 얹는다(3차=항목별 키 분리)
  const rd2 = await approvalsDoc(st);
  const fresh = rd2.ok ? rd2.doc : doc;
  if (cid) {
    const dup2 = fresh.items.find(function (x) { return x && x.cid === cid; });
    if (dup2) return { ok: true, id: dup2.id, dedup: true, self_decided: dup2.self_decided === true };
  }
  const dr2 = dupOpenRef(fresh.items);
  if (dr2) {
    dr2.title = title;
    dr2.body = String(o.body || '').slice(0, 500);
    dr2.by = { id: member.id, name: member.name };   // 정정자가 새 기안자 — 결재 결과 통지·'내 상신'도 이 사람 기준
    if (apprBossOnly(dr2) && dr2.to == null) dr2.to = 'boss';   // 구건 승격 — 판정 규칙이 나중에 to 필드만 보게 바뀌어도 열리지 않게
    dr2.updated = new Date().toISOString();
    fresh.updated_by = member.id; fresh.updated_at = Date.now();
    const uw = await blobSet(st, colKey('approvals'), fresh);
    if (!uw.ok) return { ok: false, code: uw.code };
    // 동시 create·decide의 본선쓰기가 이 정정(내용)을 되돌릴 수 있다 — 재확인 후 1회 재적용(자가복구, 리뷰 low).
    // 그 사이 결정이 붙었으면(대기·보류 아님) 재적용하지 않는다 — 결재된 카드의 근거를 사후 변조하지 않게
    try {
      const chk2 = await blobGet(st, colKey('approvals'));
      if (chk2.ok && chk2.data && Array.isArray(chk2.data.items)) {
        const cur2 = chk2.data.items.find(function (x) { return x && x.id === dr2.id; });
        if (cur2 && cur2.updated !== dr2.updated && (cur2.status === '대기' || cur2.status === '보류')) {
          cur2.title = dr2.title; cur2.body = dr2.body; cur2.by = dr2.by; cur2.updated = dr2.updated; if (dr2.to) cur2.to = dr2.to;
          chk2.data.updated_by = member.id; chk2.data.updated_at = Date.now();
          await blobSet(st, colKey('approvals'), chk2.data);
        }
      }
    } catch (e) {}
    try { await appendAudit({ ts: Date.now(), by: member.name, bid: member.id, col: 'approvals', ev: [{ op: '상신정정', id: dr2.id, t: (dr2.kind + ' · ' + title).slice(0, 80) }] }); } catch (e) {}
    try {
      // 대표 전용 건은 대표에게만(없으면 관리자 폴백). sendTo는 수신자가 없어도 알림함 이력을 남긴다(관리자 확인용)
      const uids = (apprBossOnly(dr2) ? await push.bossOrAdminIds() : await push.adminIds()).filter(function (id) { return id !== member.id; });
      await push.sendTo(uids, { title: '결재 요청(정정): ' + title.slice(0, 40), body: '[' + dr2.kind + '] 정정 ' + member.name, url: './', tag: 'appr-' + dr2.id },
        dr2.kind === '운반일지' ? null : { primaryOnly: true });
    } catch (e) {}
    return { ok: true, id: dr2.id, updated: true };
  }
  const item = { id: 'ap' + crypto.randomBytes(6).toString('hex'), cid: cid || undefined, kind: kind0, to: (kind0 === '운반일지' ? 'boss' : undefined),
    title: title, body: String(o.body || '').slice(0, 500), ref: refIn,
    by: { id: member.id, name: member.name }, created: new Date().toISOString(), status: '대기' };
  if (grade) {
    item.grade = grade;
    item.to = (grade === 3) ? 'boss' : 'pm';   // ①·② 1단계는 PM 큐, ③은 즉시 대표 큐(v308 운반일지 하드코딩의 일반화)
    item.chain = [];
    if (escalated) item.escalated = true;
    // PM(비대표 관리자) 자기 기안 ②는 PM 단계 자동통과(§1·§4.3) — 자기 결재 단계를 없애고 chain에 명시(감사 논란 방지, §11)
    if (grade === 2 && member.admin && !push.isBoss(member)) {
      item.chain.push({ by: { id: member.id, name: member.name }, decision: '자동통과', at: item.created });
      item.to = 'boss';
    }
    // 전결 종결(v315): 생성과 동시에 '승인' — decide와 같은 최종 필드(status·decided_*·chain)를 한 쓰기로 박는다.
    // to는 'pm'(① 큐 표기) 그대로 두되 status가 '승인'이라 어느 큐·뱃지에도 잡히지 않는다. 총정리 크론은 grade1+승인+decided_at(전월)로 집계 → 자동 포함
    if (selfDecide) {
      item.status = '승인';
      item.decided_by = { id: member.id, name: member.name };
      item.decided_at = item.created;
      item.reason = '';
      item.self_decided = true;   // 카드·내 상신 "전결 종결 · M/D" 표기용(감사로그와 별도)
      item.chain.push({ by: { id: member.id, name: member.name }, decision: '전결', at: item.created });
    }
  }
  fresh.items.push(item);
  fresh.updated_by = member.id; fresh.updated_at = Date.now();
  const w = await blobSet(st, colKey('approvals'), fresh);
  if (!w.ok) return { ok: false, code: w.code };
  // 저장소가 조건부 쓰기를 지원하지 않아(무조건 덮어쓰기) 동시 쓰기에 내 항목이 밀릴 수 있다 — 재확인 후 1회 자가복구
  try {
    const chk = await blobGet(st, colKey('approvals'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items) && !chk.data.items.some(function (x) { return x && x.id === item.id; })) {
      chk.data.items.push(item);
      chk.data.updated_by = member.id; chk.data.updated_at = Date.now();
      await blobSet(st, colKey('approvals'), chk.data);
    }
  } catch (e) {}
  // 전결 종결은 감사로그 '전결' 1건(상신+결재를 한 행위로 기록) · 푸시 없음(본인 결재 — 결재 요청도 결과 통지도 받을 사람이 없다)
  if (selfDecide) {
    try { await appendAudit({ ts: Date.now(), by: member.name, bid: member.id, col: 'approvals', ev: [{ op: '전결', id: item.id, t: (item.kind + ' · ' + title).slice(0, 80) }] }); } catch (e) {}
    return { ok: true, id: item.id, self_decided: true };
  }
  try { await appendAudit({ ts: Date.now(), by: member.name, bid: member.id, col: 'approvals', ev: [{ op: '상신', id: item.id, t: (item.kind + ' · ' + title).slice(0, 80) }] }); } catch (e) {}
  // 결재 요청 웹푸시 — 기안자 본인만 제외(push_send __admins__ 관례와 동일). 발송 실패가 상신을 막지 않는다.
  // 수신자(결재 3차 §4.3): 대표 큐(③·자동통과 ②·구건 운반일지)=대표(없으면 관리자 폴백) / ①·② 1단계=비대표 관리자(없으면 관리자 폴백) / 구건=관리자 전원(현행).
  // 운반일지만 전 기기(배치도 결정 ① 명시 예외 — 오피스PC 팝업+폰 병행), 그 외 종류는 우선기기 1발(결정 ③).
  // ③건의 PM 몫은 별도 발송 없음 — 대표행 발송이 push:log(알림함)에 남고 관리자는 알림함 전체를 보므로 그 줄이 "확인" 줄이 된다(v308 방식).
  try {
    const ids = (apprBossOnly(item) ? await push.bossOrAdminIds()
      : (item.grade ? await push.pmOrAdminIds() : await push.adminIds())).filter(function (id) { return id !== member.id; });
    await push.sendTo(ids, { title: '결재 요청: ' + title.slice(0, 40), body: '[' + item.kind + '] 기안 ' + member.name, url: './', tag: 'appr-' + item.id },
      item.kind === '운반일지' ? null : { primaryOnly: true });
  } catch (e) {}
  return { ok: true, id: item.id };
}
async function handleApprovalDecide(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const decision = String(d.decision || '');
  if (decision !== '승인' && decision !== '반려' && decision !== '보류' && decision !== '확인') return jr(400, { status: 'REJECTED', error_code: 'BAD_DECISION', request_id: R });
  const reason = String(d.reason || '').trim().slice(0, 300);
  if (decision === '반려' && !reason) return jr(400, { status: 'REJECTED', error_code: 'REASON_REQUIRED', request_id: R });
  const st = store(DATA);
  const rd = await approvalsDoc(st);
  if (!rd.ok) return jr(500, { status: 'ERROR', error_code: rd.code, request_id: R });
  // 낙관락(handleSave의 STALE_BASE와 같은 원칙): 목록을 본 시점 이후 문서가 바뀌었으면 늦은 결재를 세운다
  if (d.base != null && Number(d.base) !== Number(rd.doc.updated_at || 0))
    return jr(409, { status: 'CONFLICT', error_code: 'APPR_STALE', base: rd.doc.updated_at || 0, request_id: R });
  const pre = rd.doc.items.find(function (x) { return x && x.id === String(d.id || ''); });
  if (!pre) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_APPROVAL', request_id: R });
  // 승인·반려는 종결(재결정 불가). '보류'만 대기 성격을 유지해 재결정 가능 — 이 검사가 BOSS_ONLY보다 앞이어야 구 캐시 클라가 409(건너뜀)를 받는다
  if (pre.status === '승인' || pre.status === '반려') return jr(409, { status: 'CONFLICT', error_code: 'ALREADY_DECIDED', base: rd.doc.updated_at || 0, request_id: R });
  // 대표 전용 건의 승인·반려는 대표만(서버 하드 게이트 — 클라 숨김은 UI일 뿐). 보류는 관리자 누구나(대표 부재 시 대기 유지 통로).
  // 대표 계정이 하나도 없으면(role 불일치 등) 관리자 전원에게 연다 — 푸시 폴백(bossOrAdminIds)·클라 boss_present와 같은 축(교착 방지, v310)
  if (apprBossOnly(pre) && decision !== '보류' && !push.isBoss(c.member) && (await push.bossIds()).length) return jr(403, { status: 'FORBIDDEN', error_code: 'BOSS_ONLY', request_id: R });
  // ---- 결재 3차 등급 게이트(명세 §4.1) — 위 BOSS_ONLY(대표 큐)와 함께 게이트 표를 이룬다. 구건(grade 없음)은 여기 전부 통과(현행 admin) ----
  const preGrade = (pre.grade === 1 || pre.grade === 2 || pre.grade === 3) ? pre.grade : ((pre.to === 'boss' && pre.kind === '운반일지') ? 3 : 0);   // v308 구건 운반일지=③ 간주(§6)
  const preQ = pre.to || 'pm';
  // [확인]은 전결총정리 전용(§5 — 승인과 같은 처리·"열람 확인" 성격), 전결총정리는 [확인]만(반려·보류 버튼 없음)
  if (decision === '확인' && pre.kind !== '전결총정리') return jr(400, { status: 'REJECTED', error_code: 'CONFIRM_ONLY_SUMMARY', request_id: R });
  if (pre.kind === '전결총정리' && decision !== '확인') return jr(400, { status: 'REJECTED', error_code: 'SUMMARY_CONFIRM_ONLY', request_id: R });
  // ①·② 1단계(PM 큐)=비대표 관리자만 — 대표는 건별 관여 없음(① 정의). 비대표 관리자가 0명이면 대표에게 연다(교착 방지, BOSS_ONLY 폴백과 대칭)
  if (preGrade && preQ === 'pm' && push.isBoss(c.member) && (await push.pmIds()).length) return jr(403, { status: 'FORBIDDEN', error_code: 'PM_ONLY', request_id: R });
  // ②라인 PM 단계는 보류 없음(§12-6 PM 동의) — 미룰 이유가 있으면 반려로 되돌리는 게 빠르다는 판단
  if (preGrade === 2 && preQ === 'pm' && decision === '보류') return jr(400, { status: 'REJECTED', error_code: 'HOLD_NOT_ALLOWED', request_id: R });
  await verSnapshot('approvals', rd.doc, c.member.name, false);   // 변형 전 시점 보존(복구 링)
  // 레이스 창 축소(리뷰 [A-잔여]): verSnapshot이 블롭 왕복을 끼워 첫 읽기→쓰기 간격이 수백ms로 벌어지고,
  // 그 사이 착지한 동시 상신을 본선 쓰기가 지울 수 있다 — 쓰기 직전 신선본을 다시 읽어 그 위에 결정을 얹는다.
  // 완전 폐쇄는 항목별 키 분리(appr:item:<id>)로만 가능 — 결재 3차 TODO.
  const rd2 = await approvalsDoc(st);
  const doc = rd2.ok ? rd2.doc : rd.doc;
  const it = doc.items.find(function (x) { return x && x.id === String(d.id || ''); });
  if (!it) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_APPROVAL', request_id: R });
  if (it.status === '승인' || it.status === '반려') return jr(409, { status: 'CONFLICT', error_code: 'ALREADY_DECIDED', base: doc.updated_at || 0, request_id: R });
  // 신선본에서 큐가 이미 넘어갔으면(PM이 방금 승인해 to:'boss') 낡은 결정을 세운다 — 낙관락과 같은 취지의 마지막 방어
  if ((it.to || 'pm') !== preQ) return jr(409, { status: 'CONFLICT', error_code: 'APPR_STALE', base: doc.updated_at || 0, request_id: R });
  const nowIso = new Date().toISOString();
  const itGrade = (it.grade === 1 || it.grade === 2 || it.grade === 3) ? it.grade : ((it.to === 'boss' && it.kind === '운반일지') ? 3 : 0);
  // ② 1단계 승인 = 종결이 아니라 단계 전환(§4.2): to:'boss'로 넘기고 status는 '대기' 유지, 최종 결과 필드(decided_*)는 비워 둔다
  const isPmStep = (itGrade === 2 && (it.to || 'pm') === 'pm' && decision === '승인');
  if (itGrade) {   // 등급 건은 단계별 기록(chain — 카드 표시용, 감사로그는 별도로 계속)
    if (!Array.isArray(it.chain)) it.chain = [];
    const ce = { by: { id: c.member.id, name: c.member.name }, decision: decision, at: nowIso };
    if (reason) ce.reason = reason;
    it.chain.push(ce);
  }
  if (isPmStep) {
    it.to = 'boss'; it.status = '대기';
  } else {
    it.status = (decision === '확인') ? '승인' : decision;   // [확인]=승인과 같은 처리(§5)
    it.decided_by = { id: c.member.id, name: c.member.name };
    it.decided_at = nowIso;
    it.reason = reason;
  }
  doc.updated_by = c.member.id; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('approvals'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 동시 create의 덮어쓰기가 이 결정을 되돌릴 수 있다 — 재확인 후 1회 재적용(자가복구)
  let newBase = doc.updated_at;
  try {
    const chk = await blobGet(st, colKey('approvals'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items)) {
      const cur = chk.data.items.find(function (x) { return x && x.id === it.id; });
      // 되돌림 판정: ② 1단계 전환은 to로, 그 외는 최종 status로(전환은 status가 '대기' 그대로라 status 비교만으론 못 잡는다)
      const drifted = cur && (isPmStep ? cur.to !== 'boss' : cur.status !== it.status);
      if (drifted) {
        cur.status = it.status; cur.decided_by = it.decided_by; cur.decided_at = it.decided_at; cur.reason = it.reason;
        if (it.to) cur.to = it.to;
        if (Array.isArray(it.chain)) cur.chain = it.chain;
        chk.data.updated_by = c.member.id; chk.data.updated_at = Date.now();
        await blobSet(st, colKey('approvals'), chk.data);
        newBase = chk.data.updated_at;
      } else if (chk.data.updated_at) newBase = chk.data.updated_at;
    }
  } catch (e) {}
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'approvals', ev: [{ op: '결재', id: it.id, t: ((isPmStep ? '승인→대표' : (decision === '확인' ? '열람 확인' : decision)) + (reason ? ' — ' + reason.slice(0, 40) : '') + ' · ' + String(it.title || '').slice(0, 40)) }] }); } catch (e) {}
  // 문서함 등재 훅(v314): 최종 승인='등재'·반려='반려'를 문서 블롭에 반영. 결재 상태(위 쓰기)가 먼저 확정된 뒤라 여기 실패는 결재를 되돌리지 않는다 —
  // 감사로그 '등재반영실패'만 남기고 다음 결재함 조회(approvals_list 폴)에서 같은 함수가 멱등으로 재시도한다. ② 1단계 전환·보류는 문서 무변경.
  let docReg = null;
  if (it.kind === '문서함 등재' && !isPmStep && (it.status === '승인' || it.status === '반려')) {
    try { docReg = await docRegisterApply(st, [it], c.member); } catch (e) { docReg = { ok: false, code: 'EXC' }; }
    if (!docReg.ok) { try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: [{ op: '등재반영실패', id: String(it.ref || '').slice(4), t: String(docReg.code || '') + ' · ' + String(it.title || '').slice(0, 40) + ' (다음 결재함 조회에서 재시도)' }] }); } catch (e) {} }
  }
  // 통지 라우팅(결재 3차 §4.2):
  //  ② 1단계 승인 → 대표 우선기기 1발(결재 요청) + 기안자는 알림함 줄만(푸시 없음 — 담당이 할 일이 없다)
  //  전결총정리 [확인] → 푸시 없음(§5 — 기안자가 시스템)
  //  그 외 최종 결과 → 기안자 1발(현행). 자동 기안(__system__)은 구독이 없어 관리자 전원 라우팅(리뷰 med).
  try {
    if (isPmStep) {
      const bIds = (await push.bossOrAdminIds()).filter(function (id) { return id !== c.member.id; });
      await push.sendTo(bIds, { title: '결재 요청: ' + String(it.title || '').slice(0, 40),
        body: '[' + it.kind + '] PM 승인 완료 → 대표 (2/2)', url: './', tag: 'appr-' + it.id }, { primaryOnly: true });
      if (it.by && it.by.id && it.by.id !== c.member.id && it.by.id !== '__system__')
        await push.sendTo([it.by.id], { title: '결재 진행: ' + String(it.title || '').slice(0, 40),
          body: 'PM 승인 완료 · 대표 대기', url: './', tag: 'appr-' + it.id }, { logOnly: true });
    } else if (it.kind !== '전결총정리') {
      const isSys = !!(it.by && it.by.id === '__system__');
      const toIds = isSys
        ? (await push.adminIds()).filter(function (id) { return id !== c.member.id; })
        : ((it.by && it.by.id && it.by.id !== c.member.id) ? [it.by.id] : []);
      if (toIds.length || isSys)   // 자동상신은 대상이 없어도(1인 관리자) 호출 — sendTo가 알림함 이력(push:log)은 남긴다
        await push.sendTo(toIds, { title: '결재 ' + decision + ': ' + String(it.title || '').slice(0, 40) + (isSys ? ' (자동상신)' : ''),
          body: reason ? '사유: ' + reason.slice(0, 150) : (decision === '승인' ? '승인되었습니다' : ''), url: './', tag: 'appr-' + it.id },
          (isSys || itGrade) ? { primaryOnly: true } : null);   // 등급 건·자동상신 결과는 우선기기 1발(결정 ③), 구건은 현행(전 기기)
    }
  } catch (e) {}
  return jr(200, { status: 'OK', id: it.id, decided: it.status, to: it.to, base: newBase, request_id: R });
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

const { parseAttachment, claudeExtractGrade } = require('./_lib/asbestos');

// 등급확인서 판독(P5c) — 관리자 전용, 저장 없음(결과만 반환 — 인허가 반영은 클라이언트에서 사람 확인 후)
async function handleGradeParse(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const b64 = String(d.data || '');
  if (!b64 || b64.length > ATT_MAX) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  const out = await claudeExtractGrade(Buffer.from(b64, 'base64'), String(d.name || ''));
  if (!out) return jr(400, { status: 'REJECTED', error_code: 'UNSUPPORTED_TYPE', request_id: R });
  if (out.error) return jr(200, { status: 'OK', error: out.error, request_id: R });
  return jr(200, { status: 'OK', result: out, request_id: R });
}

async function handleAttPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do' && permOf(c.member, 'promo') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const name = String(d.name || '').slice(0, 120);
  const b64 = String(d.data || '');
  if (!name || !b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  if (b64.length > ATT_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', request_id: R });
  const id = 'att_' + crypto.randomBytes(8).toString('hex');
  const kind = ['asbestos', 'contract', 'bldg', 'biz', 'promo'].indexOf(String(d.kind || '')) >= 0 ? String(d.kind) : '';
  const w = await blobSet(store(FILES), id, { name: name, type: String(d.type || ''), kind: kind, data: b64, by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '첨부등록', id: id, t: name.slice(0, 60) }] }); } catch (e) {}
  // 판독은 백그라운드 함수(gw-parse-background)에서 — 첨부는 즉시 완료(타임아웃 방지). promo(현장 사진)는 판독 대상 아님
  const wantParse = (!!kind && kind !== 'promo') || (kind !== 'promo' && /석면|사전조사|조사서|계약서|대장|등록증|신분증|면허증/.test(name));
  return jr(200, { status: 'OK', id: id, name: name, size: b64.length, parse_pending: wantParse, request_id: R });
}

// 동기 판독 폴백(작은 파일·백그라운드 미지원 시) — 타임아웃 위험 있음
async function handleAttParse(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const id = String(d.id || '');
  // att_ 프리픽스 강제(att_get/att_del과 동일) — 없으면 같은 스토어의 docatt:(문서함 첨부)·tpl:/proof: 키를 계약 권한으로 판독·parse: 캐시 생성할 수 있다(적대 검증 low6)
  if (id.indexOf('att_') !== 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const r = await blobGet(store(FILES), id);
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  let parsed = null;
  try { parsed = await parseAttachment(r.data); } catch (e) { parsed = { error: 'PARSE_FAILED' }; }
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

// ---- 건축물대장 자동 조회(건축HUB) — 주소 → 법정동코드 → 표제부. 키는 data.go.kr 계정 공용(G2B_API_KEY) ----
const BJD = require('./_lib/bjd.json');   // 법정동명 → 10자리 코드(행정표준코드 전체자료, 현존만)
const SIDO_ALIAS = { '서울': '서울특별시', '부산': '부산광역시', '대구': '대구광역시', '인천': '인천광역시', '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시', '세종': '세종특별자치시', '경기': '경기도', '강원': '강원특별자치도', '강원도': '강원특별자치도', '충북': '충청북도', '충남': '충청남도', '전북': '전북특별자치도', '전라북도': '전북특별자치도', '전남': '전라남도', '경북': '경상북도', '경남': '경상남도', '제주': '제주특별자치도', '제주도': '제주특별자치도' };
const SIDO_FULL = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도', '전라남도', '경상북도', '경상남도', '제주특별자치도'];
function bldgMatchBjd(a) {
  let best = '', bestCode = '';
  for (const name in BJD) {
    if (a.indexOf(name) === 0 && name.length > best.length) { best = name; bestCode = BJD[name]; }
  }
  return bestCode ? { best, bestCode, a } : null;
}
function bldgParseAddr(addr) {
  let a = String(addr || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  const first = a.split(' ')[0];
  if (SIDO_ALIAS[first]) a = SIDO_ALIAS[first] + a.slice(first.length);
  // 가장 긴 법정동명 접두 일치 — 시도 생략 주소("영천시 …")는 시도를 붙여 재시도
  let hit = bldgMatchBjd(a);
  if (!hit) {
    for (const sd of SIDO_FULL) {
      hit = bldgMatchBjd(sd + ' ' + a);
      if (hit) break;
    }
  }
  if (!hit) return null;
  const rest = hit.a.slice(hit.best.length);
  const m = rest.match(/^\s*(산)?\s*(\d{1,4})(?:-(\d{1,4}))?/);
  return { name: hit.best, code: hit.bestCode, san: !!(m && m[1]), bun: m ? m[2] : '', ji: (m && m[3]) || '' };
}
async function handleBldgLookup(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const key = (process.env.BLDG_API_KEY || process.env.G2B_API_KEY || '').trim();
  if (!key) return jr(500, { status: 'ERROR', error_code: 'NO_BLDG_KEY', request_id: R });
  const p = bldgParseAddr(d.addr);
  if (!p) return jr(200, { status: 'REJECTED', error_code: 'ADDR_PARSE_FAILED', hint: '지번 주소(예: 경북 안동시 풍산읍 하리리 247)로 입력하세요', request_id: R });
  const pad4 = function (s) { return String(s || '0').replace(/^0+/, '').padStart(4, '0'); };
  const q = 'serviceKey=' + encodeURIComponent(key)
    + '&sigunguCd=' + p.code.slice(0, 5) + '&bjdongCd=' + p.code.slice(5)
    + (p.bun ? ('&platGbCd=' + (p.san ? 1 : 0) + '&bun=' + pad4(p.bun) + '&ji=' + pad4(p.ji)) : '')
    + '&numOfRows=50&pageNo=1&_type=json';
  try {
    const resp = await fetch('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?' + q, { headers: { 'Accept': 'application/json' } });
    const j = await resp.json();
    const body = ((j || {}).response || {}).body || {};
    let items = (body.items || {}).item || [];
    if (!Array.isArray(items)) items = [items];
    const rows = items.map(function (it) {
      return { dong: String(it.dongNm || '').trim(), bldg_name: String(it.bldNm || '').trim(),
        use: String(it.mainPurpsCdNm || '').trim(), struct: String(it.strctCdNm || '').trim(),
        total_floor: Number(it.totArea) || 0, area_bldg: Number(it.archArea) || 0,
        floors: '지상' + (Number(it.grndFlrCnt) || 0) + (Number(it.ugrndFlrCnt) ? '/지하' + Number(it.ugrndFlrCnt) : ''),
        approved: String(it.useAprDay || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        site: String(it.platPlc || '').trim() };
    });
    return jr(200, { status: 'OK', parsed: p, total: Number(body.totalCount) || rows.length, rows: rows, request_id: R });
  } catch (e) { return jr(500, { status: 'ERROR', error_code: 'BLDG_API_FAILED', request_id: R }); }
}

// ---- 홍보: 사진 GPS 좌표 → 동 단위 지역명 (OSM Nominatim 역지오코딩, 좌표는 숫자만 통과 — SSRF 차단) ----
async function handlePromoGeo(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'promo') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const lat = Number(d.lat), lon = Number(d.lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return jr(400, { status: 'REJECTED', error_code: 'BAD_COORD', request_id: R });
  try {
    const ac = new AbortController();
    const tm = setTimeout(function () { ac.abort(); }, 6000);
    const resp = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=json&accept-language=ko&zoom=14',
      { headers: { 'User-Agent': 'jongwoon-app/1.0 (promo; contact ngi6442@gmail.com)' }, signal: ac.signal });
    clearTimeout(tm);
    if (!resp.ok) return jr(502, { status: 'ERROR', error_code: 'GEO_' + resp.status, request_id: R });
    const j = await resp.json();
    const a = (j && j.address) || {};
    const dong = String(a.suburb || a.quarter || a.village || a.town || a.borough || '').trim();
    const city = String(a.city || a.county || '').trim();
    return jr(200, { status: 'OK', dong: dong, city: city, full: String(j.display_name || '').slice(0, 200), request_id: R });
  } catch (e) { return jr(502, { status: 'ERROR', error_code: 'GEO_FAILED', request_id: R }); }
}

// ---- 공고 첨부 내역서 가져오기 — 낙찰 연동 계약의 낙찰률 적용용(URL은 서버 저장 공고 데이터에서만 — SSRF 차단) ----
async function handleBidSheet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const r = await blobGet(store(DATA), colKey('bids'));
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const b = items.find(function (it) { return it && it.id === String(d.bid_id || ''); });
  if (!b) return jr(404, { status: 'REJECTED', error_code: 'BID_NOT_FOUND', request_id: R });
  const docs = (b.docs || []).filter(function (x) { return /내역|물량/.test(x.n || ''); });
  if (!docs.length) return jr(200, { status: 'NONE', request_id: R });
  const doc = docs.find(function (x) { return /\.xlsx$/i.test(x.n || ''); }) || docs[0];
  try {
    const resp = await fetch(doc.u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return jr(502, { status: 'ERROR', error_code: 'DOC_FETCH_' + resp.status, request_id: R });
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return jr(413, { status: 'REJECTED', error_code: 'DOC_TOO_LARGE', request_id: R });
    return jr(200, { status: 'OK', name: String(doc.n || '내역서'), data: buf.toString('base64'), request_id: R });
  } catch (e) { return jr(502, { status: 'ERROR', error_code: 'DOC_FETCH_FAILED', request_id: R }); }
}

// ---- 백업 내보내기 — appdata GitHub Actions(cron)가 서버 시크릿으로 호출, git에 스냅샷 보관 ----
const BACKUP_STORES = { gw_data: 1, gw_users: 1, gw_files: 1 };
function backupAuthed(d) {
  const secret = (process.env.BIDS_INGEST_KEY || '').trim();
  return !!secret && String(d.secret || '') === secret;
}
async function handleBackupList(event, d, R) {
  if (!backupAuthed(d)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_SECRET', request_id: R });
  const sn = String(d.store || '');
  if (!BACKUP_STORES[sn]) return jr(400, { status: 'REJECTED', error_code: 'BAD_STORE', request_id: R });
  const r = await blobList(store(sn));
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  return jr(200, { status: 'OK', keys: r.keys, request_id: R });
}
async function handleBackupGet(event, d, R) {
  if (!backupAuthed(d)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_SECRET', request_id: R });
  const sn = String(d.store || '');
  if (!BACKUP_STORES[sn]) return jr(400, { status: 'REJECTED', error_code: 'BAD_STORE', request_id: R });
  const key = String(d.key || '');
  // 민감키 반출 금지 — 백업 인증이 수집키(BIDS_INGEST_KEY) 겸용이라, 키 유출 = VAPID 개인키·PIN 해시 유출로 번지던 것 차단
  if (sn === 'gw_data' && key === 'push:keys') return jr(403, { status: 'FORBIDDEN', error_code: 'SENSITIVE_KEY', request_id: R });
  const r = await blobGet(store(sn), key);
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  let data = r.data;
  if (sn === 'gw_users' && data && typeof data === 'object' && !Array.isArray(data)) {
    // PIN 해시·salt는 백업에 싣지 않는다(git 스냅샷에 매일 커밋되던 것 포함 차단) — 복원 시엔 서버가 기존 값을 보존한다
    data = Object.assign({}, data); delete data.pin_salt; delete data.pin_hash;
  }
  return jr(200, { status: 'OK', key: key, data: data, request_id: R });
}

// 백업 복원 — 백업 스냅샷(gw_backup.json)의 한 키를 Blobs로 되돌린다.
// git 이력 시점복구가 못 덮는 영역(양식 템플릿·증빙 보관함·푸시 구독·입찰 데이터·오류 로그)이 대상.
// 사람 확인 원칙: dry=true로 먼저 미리보기(현재 vs 복원본 건수), confirm=true 없으면 쓰지 않는다.
function _bkCount(v) {
  if (!v || typeof v !== 'object') return null;
  if (Array.isArray(v)) return { kind: 'array', n: v.length };
  if (Array.isArray(v.items)) return { kind: 'items', n: v.items.length };
  return { kind: 'object', n: Object.keys(v).length };
}
async function handleBackupPut(event, d, R) {
  let ok = backupAuthed(d);
  if (!ok) { const c = await currentMember(event); ok = c.ok && !!c.member.admin; }
  if (!ok) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_OR_SECRET_ONLY', request_id: R });
  const sn = String(d.store || '');
  if (!BACKUP_STORES[sn]) return jr(400, { status: 'REJECTED', error_code: 'BAD_STORE', request_id: R });
  const key = String(d.key || '');
  if (!key) return jr(400, { status: 'REJECTED', error_code: 'NO_KEY', request_id: R });
  if (d.data === undefined || d.data === null) return jr(400, { status: 'REJECTED', error_code: 'NO_DATA', request_id: R });
  if (sn === 'gw_data' && key === 'push:keys') return jr(403, { status: 'FORBIDDEN', error_code: 'SENSITIVE_KEY', request_id: R });
  const cur = await blobGet(store(sn), key);
  const preview = { exists: !!cur.ok, current: _bkCount(cur.ok ? cur.data : null), restore: _bkCount(d.data) };
  if (d.dry) return jr(200, { status: 'OK', dry: true, store: sn, key: key, preview: preview, request_id: R });
  if (d.confirm !== true) return jr(400, { status: 'REJECTED', error_code: 'NEED_CONFIRM', preview: preview, request_id: R });
  let payload = d.data;
  if (sn === 'gw_users' && key.indexOf('member:') === 0 && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    // 회원 복원이 권한 상승 통로가 되지 않게 — PIN·admin은 백업본으로 못 덮는다.
    // 기존 레코드 있으면 그 값 보존(복원 후에도 로그인 그대로), 없으면 admin 해제·PIN 없음(관리자가 member_upsert로 재설정)
    payload = Object.assign({}, payload);
    const prev = (cur.ok && cur.data && typeof cur.data === 'object' && !Array.isArray(cur.data)) ? cur.data : null;
    if (prev) { payload.pin_salt = prev.pin_salt; payload.pin_hash = prev.pin_hash; payload.admin = prev.admin; }
    else { delete payload.pin_salt; delete payload.pin_hash; payload.admin = false; }
  }
  const w = await blobSet(store(sn), key, payload);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: '복원', bid: 'restore', col: sn, ev: [{ op: '백업복원', id: key, t: JSON.stringify(preview).slice(0, 120) }] }); } catch (e) {}
  return jr(200, { status: 'OK', store: sn, key: key, preview: preview, request_id: R });
}

// ---- 서류 양식(템플릿) 보관 — 관리자 등록, 영구 보관. 생성 시 원본 복사라 오염 없음 ----
const TPL_KEYS = { asb_plan: '석면해체계획서', work_start: '착공계', work_complete: '준공계', demo_report: '해체신고서(완료신고 포함)', waste_report: '폐기물배출신고서(수탁확인 포함)', qual_packet: '적격심사 패킷(신청서·심사표·각서·확약서 hwpx)', contract_pledge: '계약이행 통합서약서(hwpx)', seal_reg: '사용인감계(hwpx)', bond_waiver: '지역개발채권 포기각서(hwpx)', labor_exempt: '노무비 적용제외 신청서(hwpx·수기서식)', quote_env: '견적서 — (유)종운환경(hwpx)', quote_con: '견적서 — ㈜종운건설(hwpx)', adv_pay: '선금지급신청 세트(공문+별첨2~5, hwpx)', settle_doc: '준공 정산합의서(사후정산, xlsx)' };
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
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '양식등록', id: key, t: String(d.name || '').slice(0, 60) }] }); } catch (e) {}   // 양식 교체=서류 위조 벡터 — 무기록 금지
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
  // att_ 프리픽스 강제 — 없으면 같은 스토어의 tpl:/proof: 키를 이 완화된 가드로 읽어 관리자 전용(proof_get/tpl_put) 우회가 된다
  if (String(d.id || '').indexOf('att_') !== 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const r = await blobGet(store(FILES), String(d.id || ''));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  return jr(200, { status: 'OK', name: r.data.name, type: r.data.type, data: r.data.data, request_id: R });
}

async function handleAttDel(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  // att_ 프리픽스 강제 — 없으면 tpl:/proof:(proof:__index__ 포함)를 비관리자가 삭제할 수 있다(gw-parse-background와 동일 검사)
  if (String(d.id || '').indexOf('att_') !== 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  await blobDelete(store(FILES), String(d.id || ''));
  await blobDelete(store(FILES), 'parse:' + String(d.id || ''));
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '첨부삭제', id: String(d.id || '').slice(0, 30), t: '' }] }); } catch (e) {}
  return jr(200, { status: 'OK', request_id: R });
}

// ---- 문서함 파일 첨부(v315, PM 9/4 "실물 없는 포인터 목록") — 계약 첨부 저장소(gw_files) 재사용 ----
// 바이트는 gw_files 'docatt:<docId>:<n>'(문서당 여러 파일, n은 문서 안에서 단조 증가), 메타는 문서 항목 files:[{n,name,size,mime,ts,by}].
// 권한: 올리기=관리자 또는 등재 본인(doc 수행 — '대기' 문서에도 본인은 첨부 가능) / 열기=docVisible 통과자(공개범위 하드차단과 같은 축, 관리자 무제한) / 삭제=관리자.
// save 재구성은 files를 서버 원본으로 고정(docFilesFix) — 첨부 메타는 여기 액션으로만 바뀐다.
const DOC_ATT_EXT = { pdf: 1, docx: 1, xlsx: 1, pptx: 1, hwp: 1, hwpx: 1, jpg: 1, jpeg: 1, png: 1 };   // 확장자 화이트리스트 — 앱 DOC_ATT_EXT와 동일해야 한다(uismoke 대조)
// 확장자 → mime 고정표(적대 검증 high1): 클라가 보낸 mime은 저장·반환 어디에도 쓰지 않는다 — text/html 등으로 위장한 첨부가 앱 오리진 Blob URL로 실행되는 저장형 XSS 차단.
// 키 집합은 DOC_ATT_EXT와 같아야 한다(uismoke 대조). 앱 DOC_ATT_MIME도 같은 표(응답 type은 무시하고 확장자로만 연다)
const DOC_ATT_MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwp: 'application/x-hwp', hwpx: 'application/hwp+zip', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const DOC_ATT_MAX = 6 * 1024 * 1024;            // 문서 첨부 base64 상한 6MB(원본 ≈4.5MB — Netlify 동기 함수 본문 한도 ~6MB, 적대 검증 med3). 계약 첨부 ATT_MAX(8MB)는 별개·불변
const DOC_ATT_PER_DOC = 20;                     // 문서당 첨부 상한(무한 누적 방지)
const DOC_BULK_MAX_ITEMS = 100;                 // 일괄 등재 요청당 항목 상한
const DOC_BULK_MAX_TOTAL = Math.floor(5.5 * 1024 * 1024);   // 일괄 등재 요청당 첨부 base64 합계 상한 5.5MB(JSON 오버헤드 포함 본문 6MB 안쪽)
function docAttKey(docId, n) { return 'docatt:' + docId + ':' + n; }
function docAttExt(name) { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
function docAttExtOk(ext) { return !!ext && hasOwn(DOC_ATT_EXT, ext); }
function docAttMime(name) { const e = docAttExt(name); return hasOwn(DOC_ATT_MIME, e) ? DOC_ATT_MIME[e] : 'application/octet-stream'; }
// 매직바이트 최소 검증(high1) — 확장자만 믿지 않는다: pdf %PDF / png 89 50 4E 47 0D 0A 1A 0A / jpg FF D8 FF / zip 계열(docx·xlsx·pptx·hwpx) PK 03 04|05 06|07 08 / hwp OLE D0 CF 11 E0 또는 3.x 텍스트 머리 "HWP Document File"
function docAttMagicOk(ext, b64) {
  let head;
  try { head = Buffer.from(String(b64 || '').slice(0, 32), 'base64'); } catch (e) { return false; }
  if (!head || head.length < 4) return false;
  const h = function (i) { return head[i]; };
  if (ext === 'pdf') return head.toString('latin1').indexOf('%PDF') >= 0;   // 앞 24바이트 안 어디든 — BOM·공백 접두 PDF 허용(리뷰 low)
  if (ext === 'png') return h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4E && h(3) === 0x47 && head.length >= 8 && h(4) === 0x0D && h(5) === 0x0A && h(6) === 0x1A && h(7) === 0x0A;
  if (ext === 'jpg' || ext === 'jpeg') return h(0) === 0xFF && h(1) === 0xD8 && h(2) === 0xFF;
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'hwpx') return h(0) === 0x50 && h(1) === 0x4B && ((h(2) === 0x03 && h(3) === 0x04) || (h(2) === 0x05 && h(3) === 0x06) || (h(2) === 0x07 && h(3) === 0x08));
  if (ext === 'hwp') return (h(0) === 0xD0 && h(1) === 0xCF && h(2) === 0x11 && h(3) === 0xE0) || head.slice(0, 17).toString('latin1') === 'HWP Document File';
  return false;
}
// 첨부 번호 = 문서의 att_seq 카운터(단조 증가·삭제 후 재사용 없음, low4·low7). 카운터 없는 구건은 기존 files 최대 n에서 이어간다
function docAttNextN(it) {
  let n = Number(it && it.att_seq) || 0;
  ((it && it.files) || []).forEach(function (f) { if (f && Number(f.n) > n) n = Number(f.n); });
  return n + 1;
}
function b64Bytes(b64) { const L = b64.length; return Math.floor(L * 3 / 4) - (L && b64.charAt(L - 1) === '=' ? (L > 1 && b64.charAt(L - 2) === '=' ? 2 : 1) : 0); }   // base64 → 원 바이트 수(디코드 없이)
function docAttCanPut(m, it) { return !!(m && it && (m.admin || (it.by && it.by.id === m.id && permOf(m, 'documents') === 'do'))); }
// 문서 블롭 읽기 + 항목 찾기(삭제 문서 제외). 반환 {ok, doc, it} / {ok:false, http, code}
async function docAttLoad(st, docId) {
  if (!docId) return { ok: false, http: 400, code: 'BAD_ID' };
  const r = await blobGet(st, colKey('documents'));
  if (!r.ok) return { ok: false, http: 500, code: r.code };
  const doc = (r.data && Array.isArray(r.data.items)) ? r.data : null;
  const it = doc ? doc.items.find(function (x) { return x && x.id === docId; }) : null;
  if (!it || it.del === 1) return { ok: false, http: 404, code: 'NO_DOC' };
  return { ok: true, doc: doc, it: it };
}
// 첨부 메타 변경 쓰기 — 사람 저장과 같은 시점 보존 + 쓰기 후 1회 자가복구(동시 문서 저장이 files 변경을 덮었으면 재적용 — save는 원본 files를 이월하므로 창은 좁다)
// seq = 이번 쓰기의 att_seq(첨부 추가 시 새 n, 삭제 시 원값 유지 — 카운터는 절대 줄지 않는다).
// 쓰기 후 재확인(low7): 동시 doc_att_put이 같은 n으로 착지했으면(신선본의 n 항목이 내 것이 아님) 되돌리지 않고 conflict로 알린다 —
// 블롭 키가 같아 바이트도 뒤에 쓴 쪽이 이겼을 수 있어, 조용한 재적용은 남의 파일에 내 이름표를 붙이는 셈. 호출자는 409(클라 재시도=새 n)
async function docAttWrite(st, doc, it, filesNew, seq, by, mineN) {
  const prevDoc = JSON.parse(JSON.stringify(doc));
  if (filesNew.length) it.files = filesNew; else delete it.files;
  it.att_seq = Math.max(Number(it.att_seq) || 0, Number(seq) || 0);
  it.updated_ts = Date.now(); it.updated = verDay(it.updated_ts);
  doc.updated_by = by.id; doc.updated_at = Date.now();
  await verSnapshot('documents', prevDoc, by.name + '(첨부)', false);
  const w = await blobSet(st, colKey('documents'), doc);
  if (!w.ok) return { ok: false, code: w.code };
  try {
    const chk = await blobGet(st, colKey('documents'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items)) {
      const cur = chk.data.items.find(function (x) { return x && x.id === it.id; });
      if (cur && mineN) {
        const mine = (it.files || []).find(function (f) { return f && Number(f.n) === mineN; });
        const theirs = (cur.files || []).find(function (f) { return f && Number(f.n) === mineN; });
        if (mine && theirs && (theirs.ts !== mine.ts || !theirs.by || theirs.by.id !== mine.by.id)) return { ok: false, code: 'ATT_CONFLICT', http: 409 };
      }
      if (cur && (JSON.stringify(cur.files || []) !== JSON.stringify(it.files || []) || (Number(cur.att_seq) || 0) < it.att_seq)) {
        if (it.files) cur.files = it.files; else delete cur.files;
        cur.att_seq = Math.max(Number(cur.att_seq) || 0, it.att_seq);
        cur.updated_ts = it.updated_ts; cur.updated = it.updated;
        chk.data.updated_by = by.id; chk.data.updated_at = Date.now();
        await blobSet(st, colKey('documents'), chk.data);
        return { ok: true, updated_at: chk.data.updated_at };
      }
      if (chk.data.updated_at) return { ok: true, updated_at: chk.data.updated_at };
    }
  } catch (e) {}
  return { ok: true, updated_at: doc.updated_at };
}
async function handleDocAttPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'documents') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const docId = String(d.id || '').slice(0, 40);
  const name = String(d.name || '').trim().slice(0, 120);
  const b64 = String(d.data || '');
  if (!docId || !name || !b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  const ext = docAttExt(name);
  if (!docAttExtOk(ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', request_id: R });
  if (b64.length > DOC_ATT_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', request_id: R });
  if (!docAttMagicOk(ext, b64)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MAGIC', request_id: R });   // 확장자와 내용 불일치(위장 파일)
  const st = store(DATA);
  const ld = await docAttLoad(st, docId);
  if (!ld.ok) return jr(ld.http, { status: ld.http === 500 ? 'ERROR' : 'REJECTED', error_code: ld.code, request_id: R });
  if (!docAttCanPut(c.member, ld.it)) return jr(403, { status: 'FORBIDDEN', error_code: 'NOT_OWNER', request_id: R });
  if ((ld.it.files || []).length >= DOC_ATT_PER_DOC) return jr(400, { status: 'REJECTED', error_code: 'TOO_MANY_FILES', request_id: R });
  const n = docAttNextN(ld.it);
  const mime = DOC_ATT_MIME[ext];   // 클라 mime 폐기 — 확장자 고정표만(high1)
  const now = Date.now();
  const fw = await blobSet(store(FILES), docAttKey(docId, n), { name: name, type: mime, kind: 'doc', doc: docId, n: n, data: b64, by: c.member.name, ts: now });
  if (!fw.ok) return jr(500, { status: 'ERROR', error_code: fw.code, request_id: R });
  const files = (ld.it.files || []).slice();
  files.push({ n: n, name: name, size: b64Bytes(b64), mime: mime, ts: now, by: { id: c.member.id, name: c.member.name } });
  const w = await docAttWrite(st, ld.doc, ld.it, files, n, c.member, n);
  if (!w.ok) {
    if (w.http === 409) return jr(409, { status: 'CONFLICT', error_code: 'ATT_CONFLICT', request_id: R });   // 동시 첨부가 같은 번호를 잡음 — 클라 재시도(새 n). 바이트·메타는 이긴 쪽 것
    await blobDelete(store(FILES), docAttKey(docId, n)); return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  }
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: [{ op: '첨부', id: docId, t: (name + ' · ' + String(ld.it.title || '')).slice(0, 80) }] }); } catch (e) {}
  return jr(200, { status: 'OK', id: docId, n: n, files: files, updated_at: w.updated_at, request_id: R });
}
async function handleDocAttGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'documents') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const docId = String(d.id || '').slice(0, 40), n = Number(d.n);
  if (!docId || !(n >= 1)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA);
  const ld = await docAttLoad(st, docId);
  if (!ld.ok) return jr(ld.http, { status: ld.http === 500 ? 'ERROR' : 'REJECTED', error_code: ld.code, request_id: R });
  // 열람 판정 = get 필터와 같은 docVisible(공개범위·01 하드차단·대기/반려는 본인만). 못 보는 문서는 존재 자체를 안 알린다(404 NO_DOC — 관리자 무제한)
  if (!c.member.admin) { const ds = await docSettings(st); if (!docVisible(c.member, ld.it, ds)) return jr(404, { status: 'REJECTED', error_code: 'NO_DOC', request_id: R }); }
  const meta = (ld.it.files || []).find(function (f) { return f && Number(f.n) === n; });
  if (!meta) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  const r = await blobGet(store(FILES), docAttKey(docId, n));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  // type은 저장값이 아니라 확장자 고정표(high1) — 저장 시점에 위장값이 들어갔더라도 응답은 표의 값만
  return jr(200, { status: 'OK', name: r.data.name, type: docAttMime(r.data.name || meta.name), data: r.data.data, request_id: R });
}
async function handleDocAttDel(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const docId = String(d.id || '').slice(0, 40), n = Number(d.n);
  if (!docId || !(n >= 1)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA);
  const ld = await docAttLoad(st, docId);
  if (!ld.ok) return jr(ld.http, { status: ld.http === 500 ? 'ERROR' : 'REJECTED', error_code: ld.code, request_id: R });
  const meta = (ld.it.files || []).find(function (f) { return f && Number(f.n) === n; });
  if (!meta) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  const files = (ld.it.files || []).filter(function (f) { return !(f && Number(f.n) === n); });
  const w = await docAttWrite(st, ld.doc, ld.it, files, Number(ld.it.att_seq) || 0, c.member, 0);   // 메타 제거가 먼저 — 바이트 삭제 실패 시에도 목록에서 사라져 열기 404(고아 블롭은 무해). att_seq는 유지(번호 재사용 없음)
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  await blobDelete(store(FILES), docAttKey(docId, n));
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: [{ op: '첨부삭제', id: docId, t: (String(meta.name || '') + ' · ' + String(ld.it.title || '')).slice(0, 80) }] }); } catch (e) {}
  return jr(200, { status: 'OK', id: docId, files: files, updated_at: w.updated_at, request_id: R });
}
// 일괄 등재(관리자 전용, 스크립트용 — 정본 61건+증빙): items:[{title,cat,no,version,revised,scope?,url?,note?,files:[{name,mime,data(base64)}]}]
// 항목당 첨부 1~3 · 요청당 첨부 합계 6MB · 항목 100 · cid 멱등(같은 cid 재요청=첫 결과 그대로, 'docbulk:<cid>' 블롭).
// 전량 검증 뒤에만 쓴다(하나라도 틀리면 전체 거부 — 반쯤 등재된 상태를 만들지 않는다). 관리자 등재=전결 즉시 '등재', scope 미지정=분류 기본(비공개).
async function handleDocBulkPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const cid = String(d.cid || '').trim().slice(0, 48);
  if (!cid || !/^[A-Za-z0-9_.-]+$/.test(cid)) return jr(400, { status: 'REJECTED', error_code: 'NO_CID', request_id: R });
  const st = store(DATA);
  const prev = await blobGet(st, 'docbulk:' + cid);
  if (prev.ok && prev.data && Array.isArray(prev.data.items)) return jr(200, { status: 'OK', dedup: true, count: prev.data.count, items: prev.data.items, updated_at: prev.data.updated_at, request_id: R });
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return jr(400, { status: 'REJECTED', error_code: 'NO_ITEMS', request_id: R });
  if (items.length > DOC_BULK_MAX_ITEMS) return jr(400, { status: 'REJECTED', error_code: 'TOO_MANY_ITEMS', request_id: R });
  let total = 0;
  const norm = [];
  for (let i = 0; i < items.length; i++) {
    const x = (items[i] && typeof items[i] === 'object') ? items[i] : {};
    const title = String(x.title || '').trim().slice(0, 120);
    if (!title) return jr(400, { status: 'REJECTED', error_code: 'NO_TITLE', index: i, request_id: R });
    const cat = hasOwn(DOC_CAT_SET, String(x.cat || '')) ? String(x.cat) : '99';   // 2층 분류 화이트리스트 73키('AA-BB'·'99', 프로토타입 키 차단) — 구 2자리·표 밖이면 99로 강등
    const files = Array.isArray(x.files) ? x.files : [];
    if (files.length < 1 || files.length > 3) return jr(400, { status: 'REJECTED', error_code: 'BAD_FILE_COUNT', index: i, request_id: R });
    const fl = [];
    for (let j = 0; j < files.length; j++) {
      const f = (files[j] && typeof files[j] === 'object') ? files[j] : {};
      const name = String(f.name || '').trim().slice(0, 120), b64 = String(f.data || '');
      if (!name || !b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', index: i, file: j, request_id: R });
      const ext = docAttExt(name);
      if (!docAttExtOk(ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', index: i, file: j, request_id: R });
      if (b64.length > DOC_ATT_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', index: i, file: j, request_id: R });
      if (!docAttMagicOk(ext, b64)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MAGIC', index: i, file: j, request_id: R });
      total += b64.length;
      if (total > DOC_BULK_MAX_TOTAL) return jr(413, { status: 'REJECTED', error_code: 'BULK_TOO_LARGE', index: i, request_id: R });
      fl.push({ name: name, mime: DOC_ATT_MIME[ext], data: b64 });   // mime은 확장자 고정표(클라 값 폐기)
    }
    norm.push({ title: title, cat: cat, no: String(x.no || '').trim().slice(0, 40), version: String(x.version || '').trim().slice(0, 40),
      revised: /^\d{4}-\d{2}-\d{2}$/.test(String(x.revised || '')) ? String(x.revised) : '', url: String(x.url || '').trim().slice(0, 500),
      note: String(x.note || '').trim().slice(0, 500), scope: docScopeNorm(x.scope), files: fl });
  }
  const r = await blobGet(st, colKey('documents'));
  if (!r.ok) return jr(500, { status: 'ERROR', error_code: r.code, request_id: R });
  const doc = (r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const prevDoc = JSON.parse(JSON.stringify(doc));
  const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString(), day = verDay(nowMs), me = { id: c.member.id, name: c.member.name };
  const made = [], added = [], written = [];
  async function cleanup() { for (const k of written) { try { await blobDelete(store(FILES), k); } catch (e) {} } }
  for (const x of norm) {
    const id = 'doc' + nowMs.toString(36) + crypto.randomBytes(3).toString('hex');
    const metas = [];
    for (let j = 0; j < x.files.length; j++) {
      const f = x.files[j], n = j + 1;
      const fw = await blobSet(store(FILES), docAttKey(id, n), { name: f.name, type: f.mime, kind: 'doc', doc: id, n: n, data: f.data, by: me.name, ts: nowMs });
      if (!fw.ok) { await cleanup(); return jr(500, { status: 'ERROR', error_code: fw.code, request_id: R }); }
      written.push(docAttKey(id, n));
      metas.push({ n: n, name: f.name, size: b64Bytes(f.data), mime: f.mime, ts: nowMs, by: me });
    }
    const it = { id: id, title: x.title, cat: x.cat, created: day, updated: day, updated_ts: nowMs, status: '등재', by: me, registered_by: me, registered_at: nowIso, bulk_cid: cid, files: metas, att_seq: metas.length };
    if (x.no) it.no = x.no; if (x.version) it.version = x.version; if (x.revised) it.revised = x.revised; if (x.url) it.url = x.url; if (x.note) it.note = x.note;
    if (x.scope) it.scope = x.scope;
    doc.items.push(it); added.push(it); made.push({ id: id, title: x.title, files: metas.length });
  }
  await verSnapshot('documents', prevDoc, me.name + '(일괄 등재)', false);
  doc.updated_by = me.id; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('documents'), doc);
  if (!w.ok) { await cleanup(); return jr(500, { status: 'ERROR', error_code: w.code, request_id: R }); }
  // 무조건 덮어쓰기 저장소 — 동시 저장에 밀린 항목은 1회 자가복구
  try {
    const chk = await blobGet(st, colKey('documents'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items)) {
      const have = {}; chk.data.items.forEach(function (x) { if (x && x.id) have[x.id] = 1; });
      const miss = added.filter(function (x) { return !have[x.id]; });
      if (miss.length) { miss.forEach(function (x) { chk.data.items.push(x); }); chk.data.updated_by = me.id; chk.data.updated_at = Date.now(); await blobSet(st, colKey('documents'), chk.data); doc.updated_at = chk.data.updated_at; }
    }
  } catch (e) {}
  const result = { count: made.length, items: made, updated_at: doc.updated_at, cid: cid, ts: Date.now() };
  try { await blobSet(st, 'docbulk:' + cid, result); } catch (e) {}   // 멱등 표식 실패는 등재를 되돌리지 않는다(재요청 시 중복 가능 — 스크립트가 응답 유실 시 목록으로 확인)
  try {
    const ev = made.slice(0, 30).map(function (m) { return { op: '일괄등재', id: m.id, t: (m.title + ' · 첨부 ' + m.files).slice(0, 80) }; });
    if (made.length > 30) ev.push({ op: '생략', id: '', t: '이후 ' + (made.length - 30) + '건 생략(상한)' });
    await appendAudit({ ts: Date.now(), by: me.name, bid: me.id, col: 'documents', ev: ev });
  } catch (e) {}
  return jr(200, { status: 'OK', count: made.length, items: made, updated_at: doc.updated_at, request_id: R });
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

// ---- 시점 복구(관리자 전용): 버전 목록 / 미리보기 카운트 / 되돌리기 ----
async function verGate(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return { err: jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R }) };
  if (!c.member.admin) return { err: jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R }) };
  if (!Object.prototype.hasOwnProperty.call(COL, d.collection)) return { err: jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_COLLECTION', request_id: R }) };
  return { c };
}
function verCnt(dc) { const it = (dc && Array.isArray(dc.items)) ? dc.items : []; return { tot: it.length, live: it.filter(function (x) { return x && x.del !== 1; }).length }; }
async function handleVerList(event, d, R) {
  const g = await verGate(event, d, R); if (g.err) return g.err;
  const ir = await blobGet(store(DATA), `veridx:${d.collection}`);
  return jr(200, { status: 'OK', items: (ir.ok && ir.data && Array.isArray(ir.data.items)) ? ir.data.items : [], request_id: R });
}
// 제외 컬렉션(입찰·온비드)에 이미 쌓인 스냅샷 청소. 규칙만 바꾸면 앞으로만 안 쌓일 뿐,
// 지금 저장의 89%를 먹고 있는 과거분은 그대로 남는다. 관리자가 1회 실행해 회수한다.
async function handleVerPurge(event, d, R) {
  const g = await verGate(event, d, R); if (g.err) return g.err;
  const col = String(d.collection || '');
  if (!VER_SKIP[col]) return jr(400, { status: 'REJECTED', error_code: 'NOT_PURGEABLE', request_id: R });
  const st = store(DATA);
  const ir = await blobGet(st, `veridx:${col}`);
  const items = (ir.ok && ir.data && Array.isArray(ir.data.items)) ? ir.data.items : [];
  // 가장 최근 1개는 남긴다 — 되돌릴 여지를 완전히 없애지 않기 위해
  const sorted = items.slice().sort(function (a, b) { return b.ts - a.ts; });
  const keep = sorted.slice(0, 1), drop = sorted.slice(1);
  let removed = 0;
  for (const e of drop) {
    const r = await blobDelete(st, `ver:${col}:${e.ts}`);
    if (r && r.ok !== false) removed++;
  }
  await blobSet(st, `veridx:${col}`, { items: keep });
  try { await appendAudit({ ts: Date.now(), by: g.c.member.name, bid: g.c.member.id, col: 'admin', ev: [{ op: '스냅샷정리', id: col, t: removed + '건 삭제' }] }); } catch (e) {}
  return jr(200, { status: 'OK', collection: col, removed, kept: keep.length, request_id: R });
}
async function handleVerGet(event, d, R) {
  const g = await verGate(event, d, R); if (g.err) return g.err;
  const ts = Number(d.ts) || 0;
  const vr = await blobGet(store(DATA), `ver:${d.collection}:${ts}`);
  if (!vr.ok || !vr.data || !vr.data.doc) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_VERSION', request_id: R });
  const cur = await blobGet(store(DATA), colKey(d.collection));
  return jr(200, { status: 'OK', ver: Object.assign({ ts: vr.data.ts, by: vr.data.by }, verCnt(vr.data.doc)), cur: verCnt(cur.ok ? cur.data : null), request_id: R });
}
async function handleVerRestore(event, d, R) {
  const g = await verGate(event, d, R); if (g.err) return g.err;
  const col = d.collection, ts = Number(d.ts) || 0;
  const vr = await blobGet(store(DATA), `ver:${col}:${ts}`);
  if (!vr.ok || !vr.data || !vr.data.doc) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_VERSION', request_id: R });
  // 복구 직전 현재 상태도 보존 — 복구 자체를 되돌릴 수 있게
  const cur = await blobGet(store(DATA), colKey(col));
  if (cur.ok && cur.data) await verSnapshot(col, cur.data, g.c.member.name + '(복구 전 자동보존)', false);
  const doc = Object.assign({}, vr.data.doc, { updated_by: g.c.member.id, updated_at: Date.now() });
  const w = await blobSet(store(DATA), colKey(col), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try {
    const when = new Date(vr.data.ts + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
    await appendAudit({ ts: Date.now(), by: g.c.member.name, bid: g.c.member.id, col: col, ev: [{ op: '시점복구', id: '-', t: '← ' + when + ' (전체 ' + verCnt(vr.data.doc).tot + '건)' }] });
  } catch (e) {}
  return jr(200, { status: 'OK', updated_at: doc.updated_at, request_id: R });
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
    if (d && d.action === 'ver_list') return await handleVerList(event, d, R);
    if (d && d.action === 'ver_get') return await handleVerGet(event, d, R);
    if (d && d.action === 'ver_restore') return await handleVerRestore(event, d, R);
    if (d && d.action === 'ver_purge') return await handleVerPurge(event, d, R);
    if (d && d.action === 'bids_ingest') return await handleBidsIngest(event, d, R);
    if (d && d.action === 'autotask_ingest') return await handleAutotaskIngest(event, d, R);
    if (d && d.action === 'bot_notify') return await handleBotNotify(event, d, R);
    if (d && d.action === 'bids_refresh') return await handleBidsRefresh(event, d, R);
    if (d && d.action === 'bids_purge') return await handleBidsPurge(event, d, R);
    if (d && d.action === 'bids_export') return await handleBidsExport(event, d, R);
    if (d && d.action === 'bids_results') return await handleBidsResults(event, d, R);
    if (d && d.action === 'bldg_lookup') return await handleBldgLookup(event, d, R);
    if (d && d.action === 'promo_geo') return await handlePromoGeo(event, d, R);
    if (d && d.action === 'bid_sheet') return await handleBidSheet(event, d, R);
    if (d && d.action === 'backup_list') return await handleBackupList(event, d, R);
    if (d && d.action === 'backup_get') return await handleBackupGet(event, d, R);
    if (d && d.action === 'backup_put') return await handleBackupPut(event, d, R);
    if (d && d.action === 'tpl_put') return await handleTplPut(event, d, R);
    if (d && d.action === 'tpl_get') return await handleTplGet(event, d, R);
    if (d && d.action === 'tpl_list') return await handleTplList(event, d, R);
    if (d && d.action === 'att_put') return await handleAttPut(event, d, R);
    if (d && d.action === 'att_parse') return await handleAttParse(event, d, R);
    if (d && d.action === 'att_parse_status') return await handleAttParseStatus(event, d, R);
    if (d && d.action === 'att_get') return await handleAttGet(event, d, R);
    if (d && d.action === 'att_del') return await handleAttDel(event, d, R);
    if (d && d.action === 'proof_put') return await handleProofPut(event, d, R);
    if (d && d.action === 'proof_list') return await handleProofList(event, d, R);
    if (d && d.action === 'proof_get') return await handleProofGet(event, d, R);
    if (d && d.action === 'proof_del') return await handleProofDel(event, d, R);
    if (d && d.action === 'err_log') return await handleErrLog(event, d, R);
    if (d && d.action === 'err_list') return await handleErrList(event, d, R);
    if (d && d.action === 'grade_parse') return await handleGradeParse(event, d, R);
    if (d && d.action === 'push_pubkey') return await handlePushPubkey(event, d, R);
    if (d && d.action === 'push_sub') return await handlePushSub(event, d, R);
    if (d && d.action === 'push_unsub') return await handlePushUnsub(event, d, R);
    if (d && d.action === 'push_primary') return await handlePushPrimary(event, d, R);
    if (d && d.action === 'push_send') return await handlePushSend(event, d, R);
    if (d && d.action === 'push_log') return await handlePushLog(event, d, R);
    if (d && d.action === 'approvals_list') return await handleApprovalsList(event, d, R);
    if (d && d.action === 'approval_create') return await handleApprovalCreate(event, d, R);
    if (d && d.action === 'approval_decide') return await handleApprovalDecide(event, d, R);
    if (d && d.action === 'appr_grades_get') return await handleApprGradesGet(event, d, R);
    if (d && d.action === 'appr_grades_set') return await handleApprGradesSet(event, d, R);
    if (d && d.action === 'doc_settings_get') return await handleDocSettingsGet(event, d, R);
    if (d && d.action === 'doc_settings_set') return await handleDocSettingsSet(event, d, R);
    if (d && d.action === 'doc_att_put') return await handleDocAttPut(event, d, R);
    if (d && d.action === 'doc_att_get') return await handleDocAttGet(event, d, R);
    if (d && d.action === 'doc_att_del') return await handleDocAttDel(event, d, R);
    if (d && d.action === 'doc_bulk_put') return await handleDocBulkPut(event, d, R);
    return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    // 서버 예외도 오류 로그에 축적(클라 err_log와 같은 저장소) — 기록 실패는 무시
    try {
      const st = store(DATA);
      const r0 = await blobGet(st, 'err:log');
      const doc = (r0.ok && r0.data && Array.isArray(r0.data.items)) ? r0.data : { schema: 1, items: [] };
      doc.items.push({ ts: Date.now(), by: '서버', msg: 'action=' + ((d && d.action) || '?') + ' : ' + String((e && e.message) || e).slice(0, 200),
        src: 'gw-data', stack: String((e && e.stack) || '').slice(0, 600), ua: '' });
      if (doc.items.length > 200) doc.items = doc.items.slice(-200);
      await blobSet(st, 'err:log', doc);
    } catch (e2) {}
    return jr(500, { status: 'ERROR', error_code: 'HANDLER_FAILED', request_id: R });
  }
}

exports.handler = handler;
