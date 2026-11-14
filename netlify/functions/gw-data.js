'use strict';

// 그룹웨어 데이터 (서버측 권한 강제). Netlify Blobs.
// 'gw_data' 저장: col:tasks / col:vehicles / col:receivables / col:licenses / col:checklist
// 권한은 'gw_users'의 회원 레코드(perms)에서 확인. 관리자는 전부 허용.
const crypto = require('crypto');
const zlib = require('zlib');   // v378 큰 본문 gzip(응답·요청) — 10/8 실사고(col:bids 6.69MB > 동기 함수 한도 6MB)
const { setupBlobContext, store, blobGet, blobSet, blobDelete, blobList } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit, auditKey, diffItems, MAX_PER_MONTH: AUDIT_MAX_PER_MONTH } = require('./_lib/audit');
const { badBlobKey } = require('./_lib/blobkey');   // v453 Blobs 키 이름 검사(backup_get·backup_put 400 BAD_KEY — blobs.js도 같은 검사로 SDK 앞에서 막음)
const AL = require('./_lib/apprlearn');   // v413 결재 학습 신호(clog:appr → lessons:appr, 모델 없음)
const DONEIF = require('./_lib/doneif');   // v413 clogAppend(해시 체인) 재사용
const push = require('./_lib/push');
const tier = require('./_lib/tier');   // 관리자 등급(v321) — retired 판정식 공용. 게이트는 push.tierCtx()(명시 tier·부트스트랩·퇴사 제외, 9/6 검증 S1)
const BRIEF = require('./_lib/brief');   // v416 아침 음성 브리핑(체크 38 D1) — 설정·조회·기동(생성은 워커)
const AR = require('./_lib/autorules');  // v417 자동 지시 서버 규칙 3건(카드 10) — 집계(autotask_facts)·완료 신호 공용
const CLIBIZ = require('./_lib/clibiz');   // v456 거래처 사업자번호 칸 13자리 판정(앱 cliBiz13과 같은 규칙 — uismoke v456 대조)
const DUTY = require('./_lib/duty');   // P1 판28 인허가 '이번 달' 회차 계산(앱 DUTY_SHARED 구간과 같은 본문 — uismoke P1 판28이 글자째 대조)
const SITEEDU = require('./_lib/siteedu');   // v433 현장 대장 '특별교육 미이수' 판정(앱 asbNoSpecial·eduHasValidSpecial과 같은 규칙 — uismoke v433 대조)

const DATA = 'gw_data';
const USERS = 'gw_users';
// 컬렉션 → 권한키
const COL = { tasks: 'tasks', vehicles: 'veh', receivables: 'rec', licenses: 'lic', checklist: 'check', documents: 'doc', clients: 'cli', contracts: 'con', leaves: 'leaves', bids: 'bid', onbid: 'bid', workers: 'wk', quotes: 'quote', promo: 'promo', family: 'fam', asbestos: 'site', edu: 'safety' };  // onbid=공매·부동산(관리자 전용), workers=일용직 명부(wk), quotes=견적서 탭 독립 권한(영업 문서 — 계약 파이프라인의 견적 "서류" 생성은 별개로 con 권한), promo=홍보(현장 기록→블로그·갤러리), family=가족친화 실적 대장(혁신⑧ — bids처럼 관리자 전용 서버 강제), asbestos=현장 대장(안전 › 현장, site 권한, 30년 보존 — 석면·철거·준설, 2026-09-10 인허가 lic에서 분리 · 안전성평가 전산화 항목), edu=직원·일용직 교육·건강진단 기록(안전 › 교육·검진, safety 권한 — v430 메뉴 56 3단계, 종전 hr 관리자 전용)
// 사용자별 비공개 컬렉션(본인만 접근, 회원 id로 분리 저장)
const PRIVATE_COL = { mytasks: true };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label, x-gw-enc', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }
function colKey(c) { return `col:${c}`; }

// 퇴사자 차단(S2-A) — gw-auth와 동일 규칙: 퇴사일(leave_date)이 지나면 기존 세션도 데이터 접근 불가
function retired(m) { return tier.retired(m); }   // 판정식은 _lib/tier.js 한 곳(KST 일자 비교) — 등급·pmIds·bossIds도 같은 식으로 재직자만
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
// 기본 숨김 모듈(닫고 시작 — 명시 부여만). 앱 index.html의 PERM_CLOSED와 같은 집합이어야 하고 uismoke가 대조한다.
//   quote 견적서 = 영업 직렬에게만
//   promo  홍보  = 홍보 담당에게만
//   hr     인사 = 인사 탭은 관리자 전용 — 교육·건강진단 대장이 view로 열려 있던 구멍(9/4 uismoke 실사고 조사)에서 닫았다. 그 대장은 v430부터 safety 키(아래), hr은 남겨 둔다
//   safety 안전 › 교육·검진(col:edu — 직원 교육·건강진단 날짜) = v430(PM 11/9 ② 권민지 1명) 명시 부여만. 여기서 빠지면 safety 값이 없는 회원(배포 직후 전원)의
//          읽기가 저장을 기다리지 않고 바로 '보기'로 열린다(저장 때 '보기'를 채우는 쪽은 gw-auth CLOSED_DEFAULT — 둘 다 uismoke v430 4곳 대조)
//   site   현장 대장(석면·철거·준설) = 2026-09-10 인허가에서 분리. 관리부·운영부만(PM 결정).
//          면허 만기 관리(lic)와 현장 이력은 보는 사람도 쓰는 사람도 갈라질 일이라 키를 나눴다.
//   lic    인허가·면허 = PM 2026-09-10 "인허가 석면은 운영 및 관리부만".
//          기본이 view라 명시적으로 닫지 않은 현장 직원 4명에게 근로자 인적사항(30년 보존 대장)이 열려 있었다.
//   hw     화관법 = v431(메뉴 56 4-1, PM 11/9 ③ "관리+운영만") 등록. gw-data에는 화관법 컬렉션이 없어 COL 값에 없다(아래 permOf가 hw를 볼 일 없음) —
//          권한 강제는 v434(4-2)부터 gw-hwakwan(hwPerm — 폐기물 제출 수행·조회 숨김 거절)이 hw로 한다. 기본 숨김 4곳을 같은 집합으로 두려고 여기에도 둔다(uismoke v430 4곳 대조).
//   stmt   월말명세서 = 29 판②(PM 11/10 D2 권민지 수행·나수진 보기). hw와 같은 꼴 — gw-data 컬렉션 없음, 강제는 gw-stmt(stmtPerm — 값 없음 = 숨김). 4곳 같은 집합이라 여기에도.
const PERM_CLOSED = { quote: 1, promo: 1, hr: 1, lic: 1, site: 1, safety: 1, hw: 1, stmt: 1 };
function permOf(member, col) {
  if (member.admin) return 'do';
  const key = COL[col];
  return (member.perms && member.perms[key]) || (PERM_CLOSED[key] ? 'hide' : 'view');
}
// v464(C078 ① PM 11/13 '추천대로'): 기성 연동 지시(입금확인 rec_id · 미수 45일 자동 auto_key 'rec:<기성 id>:…' — 제목에 거래처·금액)는 기성 숨김 직원에게 서버가 내려 주지 않는다.
//   담당(본인·전사 __all__)·공개범위에 이름·지시자(from_id·from)인 사람은 그대로(앱 taskVisible·taskForMe와 같은 줄 — 넓히지 않고 좁히기만).
//   그 직원이 지시를 저장하면 빠진 지시는 서버 원본 이월(지워지지 않게), 낡은 사본에 남은 같은 id도 서버 원본으로.
function taskRecHiddenFor(member, t) {
  if (!member || member.admin || !t) return false;
  const rid = t.rec_id || ((/^rec:([^:]+):/.exec(String(t.auto_key || '')) || [])[1]) || '';
  if (!rid || permOf(member, 'receivables') !== 'hide') return false;
  if (t.who_id === '__all__' || (member.id && t.who_id === member.id)) return false;
  if (Array.isArray(t.scope) && member.id && t.scope.indexOf(member.id) >= 0) return false;
  if ((t.from_id && t.from_id === member.id) || (t.from && t.from === member.name)) return false;
  return true;
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
// 주기업무 공개범위·담당 지도({항목id: [대상토큰...]} / {항목id: 회원id}) 동일성 비교(v331) —
// 키 순서·배열 순서에 흔들리지 않게. 비관리자 재구성 판정과 감사로그가 함께 쓴다.
function scopeMapSame(a, b) {
  a = (a && typeof a === 'object') ? a : {};
  b = (b && typeof b === 'object') ? b : {};
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  for (const k of ka) {
    const va = a[k], vb = b[k];
    if (Array.isArray(va) || Array.isArray(vb)) {
      if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
      const sa = va.map(String).sort(), sb = vb.map(String).sort();
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    } else if (String(va) !== String(vb)) return false;
  }
  return true;
}
// 문서함 분류·공개범위 판정은 _lib/docscope.js 한 곳(v424 — 물어보기가 같은 판정을 쓴다)
const { DOC_MAJOR_LABEL, DOC_MINOR_LABEL, DOC_MAJOR_SET, DOC_MINOR_SET, DOC_CAT_SET, DOC_CAT_LABEL, docCatOf, docMajorOf, docCanSee01, DOC_SETTINGS_KEY, DOC_SCOPE_CATS, DOC_SCOPE_VALS, DOC_SETTINGS_DEFAULTS, docSettings, docScopeNorm, docStatusOf, docScopeMatch, docScopeOf, docVisible } = require('./_lib/docscope');

// 재상신 멱등키 — 첫 상신 'docreg-<id>', 반려 후 재상신은 reg_n을 올려 'docreg-<id>-<n>'(닫힌 구 카드의 cid 멱등에 걸리지 않게)
function docRegCid(it) { const n = Number(it && it.reg_n) || 1; return 'docreg-' + it.id + (n > 1 ? '-' + n : ''); }
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
// 삭제 스탬프(v321 휴지통·9/6 검증 S4) — del:1로 **새로 전환**되는 저장은 관리자·비관리자 모두 서버 시각·서버 by를 강제(클라 deleted_at/deleted_by 폐기 — 삭제일 위조로 30일 시계를 당기거나 삭제자를 바꿔치지 못하게).
// 이미 삭제된 원본은 서버 원본의 스탬프만 이월(낡은 사본 저장이 삭제일을 지우지 않게 — 30일 계산의 근거. 원본에 없으면 클라 값도 버린다 → docDeletedTs가 updated_ts를 삭제일로 간주), 삭제가 풀린 항목은 스탬프 제거
function docDelStamp(s, o, member, nowIso) {
  if (s.del === 1) {
    if (o && o.del === 1) {
      if (o.deleted_at) s.deleted_at = o.deleted_at; else delete s.deleted_at;
      if (o.deleted_by) s.deleted_by = o.deleted_by; else delete s.deleted_by;
    } else {
      s.deleted_at = nowIso;
      s.deleted_by = { id: member.id, name: member.name };
    }
  } else { delete s.deleted_at; delete s.deleted_by; }
}
// 삭제일(ms): deleted_at(v321) → 없으면 updated_ts(구건 del:1 — 삭제 저장이 updated_ts를 찍는다, v314 low5) → updated 일자 → 0(미상, 영구 삭제 fail-closed). 클라 docDeletedTs와 같은 규칙
function docDeletedTs(it) {
  const t = Date.parse((it && it.deleted_at) || '');
  if (!isNaN(t)) return t;
  if (it && Number(it.updated_ts) > 0) return Number(it.updated_ts);
  const t2 = Date.parse((it && it.updated) || '');
  return isNaN(t2) ? 0 : t2;
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

// v456(원장 C082 ①): 일용직 명부의 옛 건강진단 값(exam)을 볼 수 있는 사람 = 관리자 또는 안전 권한(permKey 'safety' 숨김 아님 — col:edu 읽기와 같은 키).
//   그 밖 사람에게는 handleGet이 exam 칸을 빼고 내리고, handleSave가 서버 값을 이월한다(운영 exam 값 0건 — 11/13 · v442 앱은 이 칸을 고치지 않음).
function wkExamSee(member) { return !!(member && (member.admin || permKey(member, 'safety') !== 'hide')); }
// 현장 대장 id 목록 펴기(앱 asList와 같은 꼴) — 배열 · 문자열 ''·'[]' → [] · '['로 시작하면 JSON 배열 · 그 밖 쉼표 글. 원소는 글자로(빈 값 뺌)
function asbIdList(v) {
  let a = [];
  if (Array.isArray(v)) a = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (s && s !== '[]') {
      let p = null;
      if (s.charAt(0) === '[') { try { p = JSON.parse(s); } catch (e) { p = null; } }
      a = Array.isArray(p) ? p : s.split(',').map(function (x) { return x.trim(); });
    }
  }
  return a.filter(function (x) { return x !== null && x !== undefined && x !== ''; }).map(function (x) { return String(x); });
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
  // v456(원장 C082 ①) 명부 옛 건강진단 값(exam)은 안전 권한에게만 — 그 밖 사람에게는 칸째 뺀다(저장 때 서버 값 이월 — handleSave)
  if (col === 'workers' && !wkExamSee(c.member) && Array.isArray(doc.items)) {
    doc = Object.assign({}, doc, { items: doc.items.map(function (w) {
      if (!w || typeof w !== 'object' || !Object.prototype.hasOwnProperty.call(w, 'exam')) return w;
      const s = Object.assign({}, w); delete s.exam; return s;
    }) });
  }
  // 문서함(v314): 비관리자는 (문서 scope 또는 분류 기본값)에 맞고 '등재'된 문서만 — 01 법인 하드차단(2026-09-02)·'대기'·'반려'(등재 본인만)까지
  // docVisible 한 규칙으로 서버 하드 차단. del:1 항목도 규칙만 맞으면 그대로 내려간다(소프트 삭제·복구는 클라 몫 — 임시 숨김 hidden_tmp 건 포함)
  if (col === 'documents' && !c.member.admin && Array.isArray(doc.items)) {
    const ds = await docSettings(store(DATA));
    doc = Object.assign({}, doc, { items: doc.items.filter(function (it) { return docVisible(c.member, it, ds); }) });
  }
  if (col === 'tasks' && !c.member.admin && Array.isArray(doc.items)) {   // v464 C078 ①: 기성 숨김 직원에게 기성 연동 지시 빼고
    doc = Object.assign({}, doc, { items: doc.items.filter(function (t) { return !taskRecHiddenFor(c.member, t); }) });
  }
  return jr(200, { status: 'OK', collection: col, doc, can_write: p === 'do', request_id: R });
}

// v433(메뉴 56 6단계 — PM 11/9 "56. ㄱ", 확인 항목 기본안 '이름으로'): 현장 대장 '특별교육 미이수'(읽기 전용).
//   안전 권한(col:edu 읽기)이 없는 현장 권한자는 교육 기록을 못 읽어 종전엔 투입 인원 전원이 '미이수'로 그려졌다.
//   현장 대장을 볼 수 있으면(permOf(member,'asbestos') = site가 숨김 아님) 현장(대장 id)마다 '투입 인원 중 유효한 특별교육 기록이 없는 사람 이름'만 돌려준다:
//   { ok, has_edu, gaps: { 대장id: [이름…] } } — 교육 기록 자체(종류·이수일·다음 예정·건강진단)·투입 인원 밖의 이름은 보내지 않는다.
//   판정 = _lib/siteedu.js(앱 asbNoSpecial과 같은 규칙). 특별교육(special) 기록이 0건이면 이름을 보내지 않는다(앱은 '특별교육 기록 없음 — 이수 여부 미확인'만 그림 — v447).
//   일용직 권한(col:workers = wk)이 숨김인 사람에게는 일용직 이름 대신 현장별 수만 wk_n으로(v433 검토 — 그 사람은 명부 읽기가 403이고 v433 전 화면에도 일용직 이름이 없었다).
//   대장·교육·명부·회원 명부 중 하나라도 못 읽으면 500 — 빈 결과로 '미이수 없음'을 그리지 않게(앱은 '확인 못 함'). 감사 로그 없음(읽기).
//   알려진 한계(PM ② '이름으로'와 같은 정보 등급으로 받아들임 — 막으려면 PM 결정): 현장 수행 권한자는 진행·예정 줄의 투입 인원을 바꿔 저장한 뒤 물으면
//   그 사람들의 석면 특별교육 기록 유무를 알 수 있다(이수일·종류·건강진단은 안 옴 — 그 저장은 감사 로그·버전 링에 남는다).
async function handleSiteEduGap(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'asbestos') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const wkSee = permOf(c.member, 'workers') !== 'hide';   // 일용직 명부 권한(wk) — 숨김이면 일용직은 이름 대신 수만
  const st = store(DATA);
  // 넷을 함께 읽는다(v433 검토 — 차례로 읽으면 답이 늦어 앱의 '확인 중'이 길어진다). 회원 레코드는 전부(지운 회원 포함 — siteedu가 앱 member_list와 같은 범위로 거른다)
  const got = await Promise.all([blobGet(st, colKey('asbestos')), blobGet(st, colKey('edu')), blobGet(st, colKey('workers')), push.loadMembers()]);
  const ra = got[0], re = got[1], rw = got[2], ms = got[3];
  const bad = [ra, re, rw].filter(function (x) { return !x.ok; })[0];
  if (bad) return jr(500, { status: 'ERROR', error_code: bad.code || 'STORAGE_READ_FAILED', request_id: R });
  if (!Array.isArray(ms) || ms.unavailable) return jr(500, { status: 'ERROR', error_code: 'MEMBERS_UNAVAILABLE', request_id: R });
  const items = function (x) { return (x.data && Array.isArray(x.data.items)) ? x.data.items : []; };   // 없는 키(실 Blobs ok·data null — 운영 col:edu 지금 상태) = 0건
  const out = SITEEDU.siteEduGaps(items(ra), items(re), items(rw), ms, { workerNames: wkSee });
  // v454(원장 C086): 현장 종류별 — 석면 = 석면 특별교육(has_edu) · 철거 = 해체 특별교육(has_demo) · 준설 = 판정 안 함. 그 종류 기록이 0건인 현장은 이름·수를 비운다
  //   (앱은 '기록 없음 — 이수 여부 미확인'만 그림 — 전원을 미이수로 내보내지 않게. 종전엔 has_edu 하나로 통째 비웠다)
  const liveKind = function (id) { const k = out.kinds[id]; return k === 'special' ? out.has_edu : (k === 'special_demo' ? out.has_demo : false); };
  const gapsOut = {}, wkOut = {};
  Object.keys(out.gaps).forEach(function (id) { const on = liveKind(id); gapsOut[id] = on ? out.gaps[id] : []; if (!wkSee) wkOut[id] = on ? out.wk_n[id] : 0; });
  return jr(200, Object.assign({ status: 'OK', ok: true, has_edu: out.has_edu, has_demo: out.has_demo, gaps: gapsOut }, wkSee ? {} : { wk_n: wkOut }, { request_id: R }));
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
  // v456(원장 C079): 저장된 문서의 updated_at이 유한한 숫자가 아니면(바깥 도구·스크립트가 글자 시각으로 쓴 경우 등) base 비교를 건너뛴다(종전 첫 저장처럼) —
  //   종전엔 Number(글자) = NaN이라 어떤 base도 맞지 않아 매번 409 → 앱이 다시 읽기·병합·재시도를 끝없이 되풀이했다(시험 서버에서 몇 분에 요청 3,000건+).
  //   아래 저장이 updated_at을 Date.now()(숫자)로 고쳐 쓰므로 다음 저장부터 낙관락이 다시 걸린다. 감사 줄은 아래 diffItems 그대로(값 고침은 따로 안 적음).
  if (d.base !== undefined && prevDoc && prevDoc.updated_at && Number.isFinite(Number(prevDoc.updated_at)) && Number(d.base) !== Number(prevDoc.updated_at))
    return jr(409, { status: 'CONFLICT', error_code: 'STALE_BASE', request_id: R });
  // v456 검토: 숫자가 아닌 updated_at 앞에서도 base 0(목록 GET을 못 받고 캐시로 부팅한 기기 — 지시 v421·문서함 T502의 가드)은 409로 병합 경로에 보낸다
  //   (건너뛰면 빈 목록 기기가 원장을 통째로 덮음). 서버 문서를 받은 기기는 base로 그 글자를 보내므로(Number = NaN) 되풀이 409는 없다.
  if (d.base !== undefined && prevDoc && prevDoc.updated_at && !Number.isFinite(Number(prevDoc.updated_at)) && Number(d.base) === 0)
    return jr(409, { status: 'CONFLICT', error_code: 'STALE_BASE', request_id: R });
  const doc = Object.assign({}, d.doc, { updated_by: c.member.id, updated_at: Date.now() });
  // items형 컬렉션 정규화 — items가 배열이 아니면(콘솔 우회 등) 아래 재구성 가드들이 통째로 건너뛰어진다(리뷰 지적)
  if (col !== 'checklist' && !Array.isArray(doc.items)) doc.items = [];
  // v456(원장 C080): 거래처 사업자번호 칸의 13자리(주민·법인등록번호 꼴 — _lib/clibiz.js, 앱 cliBiz13과 같은 규칙)는 '이번에 새로 들어오거나 바뀐 항목'만 400 CLI_BIZ13(저장 안 함 · 값은 응답에 없음).
  //   v441 앱은 수정 창에서 이미 막는다 — 이 서버 벌은 v441 전 캐시 앱·콘솔 길. 서버에 이미 있던 13자리 값(운영 0건 — 11/10 사본)이 그대로 오는 줄은 막지 않는다(옛 값 하나가 모든 저장을 막지 않게).
  //   직전 문서를 못 읽었으면(prevReadFailed) 모든 줄을 새 줄로 본다(더 닫힌 쪽).
  if (col === 'clients') {
    const oldCli = {}; oldItems.forEach(function (o) { if (o && o.id != null) oldCli[String(o.id)] = o; });
    const biz13N = doc.items.filter(function (x) {
      if (!x || typeof x !== 'object' || !CLIBIZ.biz13(x.biz_no)) return false;
      const o = x.id != null ? oldCli[String(x.id)] : null;
      return !o || String(o.biz_no == null ? '' : o.biz_no) !== String(x.biz_no == null ? '' : x.biz_no);
    }).length;
    if (biz13N) return jr(400, { status: 'REJECTED', error_code: 'CLI_BIZ13', n: biz13N, request_id: R });
  }
  // v456(원장 C082 ②): 현장 대장(asbestos) 저장 — 이번에 새로 들어온 투입 일용직 id(worker_ids)가 명부(col:workers)에 없으면 400 ORPHAN_WORKER(저장 안 함 · 수만).
  //   옛 캐시 앱·콘솔이 명부에 없는 id를 넣던 길(v442 앱은 명부에서만 고름). 서버 대장 그 줄에 이미 있던 id는 명부에 없어도 막지 않는다(옛 데이터가 저장을 막지 않게 — 30년 보존 대장).
  //   새 id가 있을 때만 명부를 읽는다 — 못 읽으면 500 WORKERS_READ_FAILED(빈 명부로 보고 거절하거나 통과시키지 않게). 직전 대장을 못 읽었으면 모든 id를 새 id로 본다.
  //   id 모양은 앱 asList와 같게 편다(배열 · 문자열 "[]"·JSON 배열 글·쉼표 글 — v336 사고 꼴).
  if (col === 'asbestos') {
    const oldAsb = {}; oldItems.forEach(function (o) { if (o && o.id != null) oldAsb[String(o.id)] = o; });
    const fresh = {};
    doc.items.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      const o = r.id != null ? oldAsb[String(r.id)] : null, had = {};
      asbIdList(o && o.worker_ids).forEach(function (i) { had[i] = 1; });
      asbIdList(r.worker_ids).forEach(function (i) { if (!had[i]) fresh[i] = 1; });
    });
    const freshIds = Object.keys(fresh);
    if (freshIds.length) {
      const rw = await blobGet(store(DATA), colKey('workers'));
      if (!rw.ok && rw.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: 'WORKERS_READ_FAILED', request_id: R });
      const known = {}; ((rw.ok && rw.data && Array.isArray(rw.data.items)) ? rw.data.items : []).forEach(function (w) { if (w && w.id != null) known[String(w.id)] = 1; });
      // v456 2차 검토: 고아 id 목록(ids — 앞 50개·각 40자)도 돌려준다 — 명부 저장이 사라진 기기(로그인 창 '전환'·권한이 바뀐 명부 저장 403)는 그 id를 대장 메모리에 남긴 채
      //   어느 줄을 고쳐도 계속 400이었다(새로고침 전까지 못 풂). 앱은 두 번째 400에서 이 id만 대장에서 빼고 다시 저장한다. id는 'w…' 무작위 글(이름·번호 아님)이고 보낸 사람에게 되돌려 줄 뿐
      const orphans = freshIds.filter(function (i) { return !known[i]; });
      if (orphans.length) return jr(400, { status: 'REJECTED', error_code: 'ORPHAN_WORKER', n: orphans.length, ids: orphans.slice(0, 50).map(function (i) { return String(i).slice(0, 40); }), request_id: R });
    }
  }
  // v456(원장 C082 ①): 명부 옛 건강진단 값(exam)은 안전 권한(wkExamSee)에게만 내린다(handleGet) — 그래서 그 밖 사람의 저장은 exam을 서버 값으로 이월한다(빠진 칸이 지워지지 않게 · 보낸 값은 버림).
  //   직전 명부를 못 읽으면 이월 판단이 안 되므로 저장 거부(licenses duties와 같은 원칙 — fail-open이면 저장 한 번에 exam이 증발).
  if (col === 'workers' && !wkExamSee(c.member)) {
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    const oldWk = {}; oldItems.forEach(function (o) { if (o && o.id != null) oldWk[String(o.id)] = o; });
    doc.items = doc.items.map(function (x) {
      if (!x || typeof x !== 'object') return x;
      const o = x.id != null ? oldWk[String(x.id)] : null, s = Object.assign({}, x);
      if (o && Object.prototype.hasOwnProperty.call(o, 'exam')) s.exam = o.exam; else delete s.exam;
      return s;
    });
  }
  // P1 판1 투찰 잠금(settings:corp_reg gate — 기본 꺼짐): 응찰로 바꾼 줄이 없으면 설정도 읽지 않음(종전과 같음) · 켜져 있고 잠겼으면 저장 통째 거절(400 GATE_CORP_REG + blocked — 앱이 그 줄만 되돌려 다시 저장)
  if (col === 'bids') {
    const gq = await corpRegGate(store(DATA), oldItems, doc.items, prevReadFailed, R);
    if (gq) {
      if (gq.body.error_code === 'GATE_CORP_REG') { try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'bids', ev: [{ op: '투찰잠금', id: gq.body.blocked.map(function (x) { return x.id; }).join(',').slice(0, 200), t: '투찰 전환 ' + gq.body.blocked.length + '건 거절(' + gq.body.why + ')' }] }); } catch (e) {} }
      return jr(gq.http, gq.body);
    }
  }
  // v380(검토 발견): 정리 전에 열려 있던 관리자 탭이 상태 하나만 바꿔 저장해도(409 병합 = 로컬 우선 합집합) 정리된 공고가 되살아나지 않게 서버가 다시 거른다
  if (col === 'bids' && Array.isArray(doc.items)) purgeExpiredBids(doc, bidsCutDate());
  // v444 부동산 — 설정 settings:onbid가 켜졌을 때만 같은 줄(기본 꺼짐 — 꺼져 있으면 아무것도 거르지 않음). 서버 문서에 있던 줄을 지우게 되면(켠 날 수집보다 저장이 먼저 오는 경우 등)
  //   저장 전 문서를 스냅샷으로 남기고(VER_SKIP을 넘어 — 아래 verSnapshot) 감사에 '정리' 1줄. 되살린 줄(서버에 이미 없는 줄)만 걸렀으면 스냅샷·감사 없음
  let obPurged = 0;
  if (col === 'onbid' && Array.isArray(doc.items) && await onbidPurgeOn(store(DATA))) {
    const cutO = bidsCutDate(), had = {};
    oldItems.forEach(function (o) { if (o && o.id) had[o.id] = 1; });
    obPurged = doc.items.filter(function (it) { return it && it.id && had[it.id] && bidPurgeable(it, cutO); }).length;
    purgeExpiredBids(doc, cutO);
  }
  // v395 배정표(기반 1·9): 자동 지시의 서버 배정 who_id(who_by 'assign')는 클라 사본이 공란으로 올려도 이월 + 남은 공란은 배정표로 채움
  if (col === 'tasks' && !c.member.admin && Array.isArray(doc.items) && permOf(c.member, 'receivables') === 'hide') {
    // v464 C078 ①: 이 직원은 기성 연동 지시를 받지 않았다 — 빠진 지시는 서버 원본 이월, 사본에 남은 같은 id(받기 전 캐시)도 서버 원본으로. 못 읽었으면 지시가 지워질 수 있어 저장 거부
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    const hidOld = {}; oldItems.forEach(function (o) { if (o && o.id && taskRecHiddenFor(c.member, o)) hidOld[o.id] = o; });
    const seenT = {};
    doc.items = doc.items.map(function (t) { if (t && t.id && hidOld[t.id]) { seenT[t.id] = 1; return hidOld[t.id]; } return t; })
      .filter(function (t) { return !(t && taskRecHiddenFor(c.member, t) && !(t.id && hidOld[t.id])); });   // 서버에 없던 기성 연동 지시를 이 직원이 새로 만들 길은 없음(입금확인·미수 45일은 관리자·기성 화면에서) — 버림
    Object.keys(hidOld).forEach(function (id) { if (!seenT[id]) doc.items.push(hidOld[id]); });
  }
  if (col === 'tasks' && Array.isArray(doc.items)) {
    const oldByA = {}; oldItems.forEach(function (o) { if (o && o.id) oldByA[o.id] = o; });
    doc.items.forEach(function (t) { if (!t || !t.auto_key || t.who_id) return; const o = oldByA[t.id]; if (o && o.who_id && o.who_by === 'assign') { t.who_id = o.who_id; t.who = o.who || ''; t.who_by = 'assign'; } });
    // v397 앱 기준 review 보호: 서버가 올린 review('앱 기준')를 클라 사본이 open으로 보내면 반려(doneif_off=1)가 아닌 한 서버 값을 이월(낡은 사본·로컬 우선 병합 방지). 승인(done)은 통과
    doc.items.forEach(function (t) {
      if (!t || !t.auto_key) return;
      const o = oldByA[t.id];
      if (o && o.status === 'review' && o.done_by === '앱 기준' && t.status === 'open' && !t.doneif_off) { t.status = 'review'; t.done_at = o.done_at; t.done_by = o.done_by; t.done_src = o.done_src; }
    });
    // v413 [내 것 아님] 보호 + 학습 신호: 서버가 비운 담당(who_by notmine)을 낡은 사본이 같은 사람으로 다시 올리면 비운 채 유지(관리자 모달 재지정 who_by 'edit'은 통과).
    //   자동 지시의 사람 손 변경(담당·기한·삭제)은 clog:appr 1행(필드명·표식·일수만, 값 없음) → lessons:appr 재집계(모델 없음).
    const clogRows = [];
    doc.items.forEach(function (t) {
      if (!t || !t.auto_key) return; const o = oldByA[t.id]; if (!o) return;
      if (o.who_by === 'notmine' && t.who_id && t.who_by !== 'edit' && o.notmine && t.who_id === o.notmine.prev) { t.who_id = ''; t.who = ''; t.who_by = 'notmine'; t.notmine = o.notmine; }
      const p = AL.prefixOf(t.auto_key); if (!p) return;
      if ((o.who_id || '') !== (t.who_id || '') && t.who_by !== 'notmine') clogRows.push({ id: t.id, f: 'who_id', from: o.who_id ? 'set' : '', to: t.who_id ? 'set' : '', why: 'edit', p: p, by: c.member.id });
      if ((o.due || '') !== (t.due || '')) { const row = { id: t.id, f: 'due', from: o.due ? 'set' : '', to: t.due ? 'set' : '', why: 'edit', p: p, by: c.member.id }; const dd = AL.dayDiff(o.due, t.due); if (dd !== null) row.d = dd; clogRows.push(row); }
      if (t.del === 1 && o.del !== 1) clogRows.push({ id: t.id, f: 'del', from: '', to: '1', why: 'edit', p: p, by: c.member.id });
    });
    if (clogRows.length) { try { await apprClogAppend(store(DATA), clogRows, Date.now()); } catch (e) {} }
    const blankBeforeS = {}; doc.items.forEach(function (t) { if (t && t.auto_key && !t.who_id) blankBeforeS[t.id] = 1; });
    try { const at = await assignRead(store(DATA)); if (Object.keys(at.rules || {}).length) { const ms = await assignMembers(); if (ms) assignFill(doc.items, at.rules, assignNames(ms)); } } catch (e) {}
    // v396 알림: 클라 생성기(runAutoTaskGen·recOverdueGen·runBidQualGen)가 만든 새 자동 지시 + 이번에 채워진 공란 → 담당자 본인 1발(설정 assignee일 때만)
    const newAutoS = doc.items.filter(function (t) { return t && t.auto_key && t.who_id && (!oldByA[t.id] || blankBeforeS[t.id]); });
    if (newAutoS.length) await notifyAutoCreated(store(DATA), newAutoS, c.member.name);
  }
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
  // v414 휴가 알림 2종(C3-1): 새 신청 → 관리자 우선기기 1발 · pending→approved/rejected → 신청자 1발. 설정으로 끌 수 있다. 실패해도 저장은 그대로.
  if (col === 'leaves' && Array.isArray(doc.items)) { try { await notifyLeaves(store(DATA), oldItems, doc.items, c.member); } catch (e) {} }
  // 인허가 3층(2026-09-02): duties(의무 대장)는 ①구버전 클라·구형 캐시가 모르는 필드라 빠지거나 비어 오면
  // 저장 한 번에 95행+확정 이력이 통째로 증발한다(리뷰 high) — 서버가 원본을 이월. ②등재·확정 전환은 관리자 전용.
  let licKept = [];   // P1 판28 검토 2: 관리자 통째 저장에서 담당 단추 기준일을 지킨 행 번호(응답 lic_kept)
  if (col === 'licenses') {
    // 직전 문서를 못 읽으면 이월 판단 자체가 불가 — fail-open이면 원 결함(증발)이 그대로 재발하므로 licenses만 저장 거부(리뷰 med)
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    const prevDuties = (prevDoc && Array.isArray(prevDoc.duties)) ? prevDoc.duties : [];
    if (!c.member.admin || !Array.isArray(doc.duties) || (doc.duties.length === 0 && prevDuties.length > 0)) doc.duties = prevDuties;
    else licKept = licNarrowGuard(prevDuties, doc.duties);   // P1 판28: '이번 달' 단추 칸(완료 기록·정정·해당 없음)은 lic_duty_set으로만 — 관리자 통째 저장은 서버 값 이월
  }
  // 주기업무 공개범위·담당 보호(v331 — 2026-09-08 PM 실사고 '공개범위를 고치면 다시 롤백된다'):
  //  scopes·assignee는 앱에서 관리자만 편집한다(openCheckScope의 isAdmin 게이트 — 비관리자에겐 편집 UI 자체가 없다).
  //  그런데 checklist 저장은 문서 통째 PUT이라, 직원이 체크박스 하나만 눌러도 그 브라우저가 로드했던 낡은 scopes/assignee 지도가 함께 올라온다.
  //  실측(ver:checklist 09-08 17:27~17:34, 20회 저장): 비관리자 저장 2건이 관리자의 공개범위 삭제 6건을 전부 되살려 라이브가 8/11 상태로 회귀했다.
  //  → leaves·licenses·documents와 같은 '서버 재구성' 원칙. 거부(403)가 아니라 이월인 이유: 낡은 사본으로 체크를 눌러도 체크 자체는 저장돼야 한다.
  //  review(완료 요청)는 직원이 정상적으로 쓰는 필드라 제외. records·custom도 종전대로 — 항목 단위 병합기가 프런트에 있다.
  let chkGuard = 0;
  if (col === 'checklist' && !c.member.admin) {
    // 직전 문서를 못 읽으면 이월 판단 자체가 불가 — fail-open이면 원 결함(롤백)이 그대로 재발하므로 저장을 거부한다(licenses·documents와 같은 원칙).
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    const pv = prevDoc || {};
    if (!scopeMapSame(doc.scopes, pv.scopes)) chkGuard++;
    if (!scopeMapSame(doc.assignee, pv.assignee)) chkGuard++;
    ['scopes', 'assignee', 'scope_ts', 'assignee_ts'].forEach(function (f) {   // 편집시각 사이드카(v331 툼스톤)도 함께 이월 — 지도만 되돌리면 다음 병합이 다시 어긋난다
      if (pv[f] !== undefined) doc[f] = pv[f]; else delete doc[f];
    });
  }
  // 편집시각 사이드카(툼스톤)는 서버에서 절대 줄이지 않는다(v331): 구버전 앱(v330 이하)은 이 맵의 존재를 모르고,
  // v331이어도 오프라인 캐시로 부팅한 사본은 빈 맵을 올린다. 그때 서버가 그대로 받아쓰면 '지웠음' 기록이 통째로 사라져
  // 다음 저장에서 낡은 사본이 다시 키를 되살린다(= 이번 사고의 재발). 값은 더 최신 스탬프만 갱신. 항목 수만큼만 자라므로 누적 부담이 없다.
  // v332: review_ts(완료요청 툼스톤)도 같은 보호. scope_ts·assignee_ts는 평면{키:ms}, review_ts는 review와 같은 3층{타입:{기간키:{항목:ms}}}이라 재귀로 최댓값 병합.
  if (col === 'checklist' && prevDoc) {
    const tsMax = function (pv, inc) {
      const out = Object.assign({}, pv);
      Object.keys(inc || {}).forEach(function (k) {
        const a = out[k], b = inc[k];
        if (b && typeof b === 'object') out[k] = tsMax((a && typeof a === 'object') ? a : {}, b);
        else if (a && typeof a === 'object') { /* 층이 어긋난 입력(구조 파손·조작)은 서버 원본을 유지 */ }
        else if (!(Number(a) > Number(b))) out[k] = b;
      });
      return out;
    };
    ['scope_ts', 'assignee_ts', 'review_ts'].forEach(function (f) {
      const pv = (prevDoc[f] && typeof prevDoc[f] === 'object') ? prevDoc[f] : null;
      if (!pv) return;
      doc[f] = tsMax(pv, (doc[f] && typeof doc[f] === 'object') ? doc[f] : {});
    });
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
        // 부활 차단(9/6 검증 R1): 서버 원본에 없는 id가 del:1로 오면 영구 삭제된 문서의 낡은 사본(휴지통 항목 캐시) — 폐기(감사로그 '제거'). 관리자도 예외 없음
        if (s.id && !oldDocBy[s.id] && s.del === 1) { docDropped.push({ x: x, why: '영구 삭제된 문서의 낡은 사본(부활 차단)' }); return null; }
        const sc = docScopeNorm(s.scope); if (sc) s.scope = sc; else delete s.scope;
        if (s.orig_dl !== 'all') delete s.orig_dl;   // v388 원본 다운로드 예외는 'all'만(관리자 저장) — 그 밖 값은 기본(관리부·관리자·양식)
        const o01 = s.id ? oldDocBy[s.id] : null;   // 01 법인 문서는 대분류를 벗어나게 저장하지 않는다(리뷰 확정: 구 2자리 cat 구건을 관리자가 열어 저장하면 99로 덮여 하드차단이 풀렸다)
        if (o01 && docMajorOf(o01) === '01' && docMajorOf(s) !== '01') { s.cat = o01.cat; s.no = o01.no; }   // cat·no를 함께 바꿔 보내는 조작도 원본으로(9/6 재검증)
        if (!(s.id && oldDocBy[s.id]) && s.status !== '등재') { s.status = '등재'; s.registered_by = { id: c.member.id, name: c.member.name }; s.registered_at = nowIso; delete s.reject_reason; }
        if (!(s.id && oldDocBy[s.id]) && !s.by) s.by = { id: c.member.id, name: c.member.name };
        docDelStamp(s, s.id ? oldDocBy[s.id] : null, c.member, nowIso);   // 삭제 스탬프(v321 휴지통·S4) — 신규 del 전환은 서버 시각·서버 by 강제(관리자 값도 폐기), 구 스탬프는 서버 원본만 이월
        docFilesFix(s, s.id ? oldDocBy[s.id] : null);   // 첨부 메타(v315)는 첨부 액션으로만 — 관리자 저장도 서버 원본 이월(낡은 사본이 첨부 목록을 지우지 않게)
        return s;
      }).filter(Boolean);
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
          ['no', 'category', 'scope', 'orig_dl'].forEach(function (k) { if (o[k] != null) s[k] = o[k]; else delete s[k]; });   // orig_dl(v388 원본 범위)도 서버 원본 고정
          // 상태·등재자·등재 기록도 원본 고정 — 재상신은 "본인 반려 건 + 클라가 reg_n을 정확히 +1로 보냄"만 명시 신호로 인정(low4: 낡은 '대기' 사본 편집이 재상신으로 오판되지 않게)
          const resubmit = docStatusOf(o) === '반려' && !!(o.by && o.by.id === me.id) && Number(x.reg_n) === (Number(o.reg_n) || 1) + 1;
          ['status', 'by', 'registered_by', 'registered_at', 'reject_reason', 'rejected_at', 'reg_n'].forEach(function (k) { if (o[k] != null) s[k] = o[k]; else delete s[k]; });
          if (resubmit) { s.status = '대기'; s.reg_n = (Number(o.reg_n) || 1) + 1; delete s.reject_reason; delete s.rejected_at; }
          if (o.del === 1) s.del = 1;   // 비관리자는 복구 불가(v321 — 복구는 관리자 휴지통 doc_restore). 낡은 사본 저장이 삭제를 되살리지 않게
          else if (s.del === 1 && !(o.by && o.by.id === me.id)) delete s.del;   // 삭제(del:1) 전송은 본인 등재 문서만(9/6 검증 S5) — 타인 문서의 del은 무시(내용 편집만 반영, 원본 유지)
          docDelStamp(s, o, c.member, nowIso);   // 삭제 스탬프는 서버가(클라 값 폐기 — 삭제자 위조·삭제일 조작으로 30일 시계를 당기지 못하게)
          docFilesFix(s, o);   // 첨부 메타 원본 고정(v315) — 비관리자가 files를 위조·삭제해 보내도 첨부 액션(doc_att_put/del)으로만 바뀐다
        } else {
          if (s.del === 1) { docDropped.push({ x: x, why: '영구 삭제된 문서의 낡은 사본(부활 차단)' }); return; }   // R1: 서버 원본에 없는 id의 del:1 = 지워진 문서의 사본 — '대기'·등재 카드로 부활시키지 않는다
          if (docMajorOf(x) === '01') { docDropped.push({ x: x, why: '01 법인 신규는 관리자만' }); return; }   // 신규 01 법인(대분류 판정)은 관리자만(2026-09-02 규칙) — 폐기 + 감사로그 '제거'
          const sc = docScopeNorm(s.scope); if (sc) s.scope = sc; else delete s.scope;
          delete s.orig_dl;   // v388 원본 다운로드 예외는 관리자만 지정
          s.by = me; delete s.registered_by; delete s.registered_at; delete s.reject_reason; delete s.rejected_at; delete s.reg_n;
          docDelStamp(s, null, c.member, nowIso);   // 신규는 del 없이 온다(위에서 걸렀다) — 삭제 필드 제거
          docFilesFix(s, null);   // 신규 문서는 첨부 0으로 시작(id 확정 뒤 doc_att_put)
          if (docSet.register_gate === 'none') { s.status = '등재'; s.registered_by = me; s.registered_at = nowIso; }
          else s.status = '대기';
        }
        if (s.status === '대기') docPending.push(s);
        if (s.id) seenOut[s.id] = 1;
        out.push(s);
      });
      // 누락 보존(9/6 검증 S5): 보이는 기존 문서가 페이로드에 없으면 서버 원본 유지 — 낡은 목록(열람 필터·검색 결과·부분 로드)으로 저장해도 남의 문서가 즉시 소실되지 않는다. 삭제는 del:1 명시 전송(본인 문서)으로만
      oldItems.forEach(function (o) { if (o && o.id && !keepIds[o.id] && !seenOut[o.id]) { out.push(o); seenOut[o.id] = 1; } });
      doc.items = out.concat(keep);
    }
  }
  // 기성 돈 상태 3종(입금 paid·검수 reviewed·발행 invoice)은 관리자 전용 — 비관리자 저장은 서버가 기존값 강제 복원.
  // 분장 근거(용어집 v1): 공무는 청구 등록·수정까지, 상태 전환은 관리부. 화면 숨김은 안내일 뿐, 여기가 하드 차단(콘솔 우회 무력화)
  let recDelKept = 0;
  if (col === 'receivables' && !c.member.admin && Array.isArray(doc.items)) {
    // v464(C078 ⑤ PM 11/13 '추천대로'): 처리된 줄(입금·발행·검수 — recProcessed) 지우기도 관리자만 — 앱 펼침 [삭제]·선택 삭제가 막는 것(v440 recSheetDelOk)을 서버도.
    //   비관리자 저장이 처리된 줄에 del:1을 붙이면 지우지 않은 원본 상태로, 처리된 줄을 빼고 보내면 서버 원본을 이월(좁히기만 — 거부 아님, 같은 저장의 다른 고침은 반영)
    //   직전 문서를 못 읽으면 처리 여부를 판정할 수 없어 저장 거부(documents·licenses와 같은 원칙 — fail-open이면 지우기가 그대로 통과)
    if (prevReadFailed) return jr(500, { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R });
    const oldRecById = {}, seenRec = {};
    const recProcessed = function (o) { return !!(o && (o.paid || o.invoice || o.reviewed)); };
    oldItems.forEach(function (o) { if (o && o.id) oldRecById[o.id] = o; });
    doc.items = doc.items.map(function (x) {
      if (!x) return x;
      const o = x.id ? oldRecById[x.id] : null;
      const s = Object.assign({}, x);
      if (o) { s.paid = (o.paid != null) ? o.paid : null; s.invoice = !!o.invoice; if (o.reviewed) s.reviewed = o.reviewed; else delete s.reviewed; }
      else { s.paid = null; s.invoice = false; delete s.reviewed; }   // 신규 청구는 항상 미입금·미발행·미검수로 시작
      if (o && recProcessed(o) && o.del !== 1 && s.del === 1) { if (o.del == null) delete s.del; else s.del = o.del; recDelKept++; }   // 처리된 줄 지우기 = 원본 상태로
      if (x.id) seenRec[x.id] = 1;
      return s;
    });
    oldItems.forEach(function (o) { if (o && o.id && !seenRec[o.id] && recProcessed(o) && o.del !== 1) { doc.items.push(o); recDelKept++; } });   // 처리된 줄을 빼고 보냄 = 서버 원본 이월
  }
  // P1 판2 검토(S1): 지시 완료 창(veh_due_set)이 바꾼 만기일 보호 — 앱 vehDueMergeKeep와 같은 규칙(옛 캐시 앱·같은 날 로컬 우선 병합으로 올라온 낡은 사본의 마지막 문)
  let vehDueKept = 0;
  if (col === 'vehicles' && Array.isArray(doc.items)) vehDueKept = vehDueGuard(oldItems, doc.items);
  if (col === 'vehicles' && Array.isArray(doc.items)) vehLogKeep(oldItems, doc.items);   // P1 판27 검토: 검사 갱신 기록 합집합(낡은 사본이 지우지 않게)
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
  await verSnapshot(col, prevDoc, c.member.name, false, obPurged > 0);   // 사람 저장은 매번 직전 상태 보존(시점 복구용) · v444 부동산 정리가 서버 줄을 지우는 저장은 VER_SKIP이어도 보존
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
      // v331: 공개범위·담당 변경은 종전에 감사로그에 한 줄도 남지 않아, 9/8 롤백을 버전 링(ver:checklist)을 뒤져서야 규명할 수 있었다.
      const nk = function (o) { return Object.keys((o && typeof o === 'object') ? o : {}).length; };
      if (!scopeMapSame(prevDoc && prevDoc.scopes, doc.scopes)) ev.push({ op: '공개범위', id: '-', t: '주기업무 공개범위 ' + nk(prevDoc && prevDoc.scopes) + '→' + nk(doc.scopes) + '건' });
      if (!scopeMapSame(prevDoc && prevDoc.assignee, doc.assignee)) ev.push({ op: '담당', id: '-', t: '주기업무 담당 ' + nk(prevDoc && prevDoc.assignee) + '→' + nk(doc.assignee) + '건' });
      if (chkGuard) ev.push({ op: '공개범위 보호', id: '-', t: '비관리자 저장이 공개범위·담당(' + chkGuard + '종)을 되돌리려 해 서버가 원본을 이월했습니다 — 그 사람의 앱 화면이 낡은 사본입니다' });
    } else {
      ev = diffItems(oldItems, Array.isArray(doc.items) ? doc.items : []);
    }
    if (recDelKept) ev.push({ op: '삭제 보호', id: '-', t: '비관리자 저장이 처리된(입금·발행·검수) 기성 ' + recDelKept + '건을 지우려 해 서버가 원본을 남겼습니다(v464 — 지우기는 관리자만)' });
    if (obPurged) ev.push({ op: '정리', id: '', t: '부동산 정리 ' + obPurged + '건(마감 ' + BIDS_KEEP_DAYS + '일 경과 신규·패스 — 저장 때)' });   // v444
    if (vehDueKept) ev.push({ op: '만기일 보호', id: '-', t: '낡은 사본이 지시 완료 창 만기일 ' + vehDueKept + '칸을 바꾸기 전 날짜로 되돌리려 해 서버 값을 지켰습니다 — 그 사람의 앱 화면이 낡은 사본입니다' });   // P1 판2 검토(S1)
    if (ev.length) await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: col, ev: ev });
  } catch (e) {}
  // 문서함 등재 결재 훅(v314): 비관리자의 '대기' 문서마다 결재함에 '문서함 등재' 카드를 서버가 대신 기안(by=등재한 직원, ref 'doc:'+id, cid 멱등).
  // 문서 저장이 먼저(사용자 본선), 상신은 그 뒤 — 상신 실패는 감사로그로 남기고 이 직원의 다음 문서 저장 때 같은 cid로 다시 시도(멱등이라 중복 0).
  // 재상신(reg_n) 건도 같은 경로. 정정 상신(dupOpenRef)은 'ab:' 전용이라 doc: 중복은 cid 멱등에만 의존한다.
  let regWarn = 0;
  if (col === 'documents' && docDropped.length) {   // 폐기 감사로그 '제거' — 비관리자 01 신규 / 관리자·비관리자 공통 부활 차단(R1)
    try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'documents', ev: docDropped.slice(0, 30).map(function (e) { return { op: '제거', id: String(e.x.id || '-'), t: e.why + ' · ' + String(e.x.title || '').slice(0, 40) }; }) }); } catch (e) {}
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
  if (licKept.length) okOut.lic_kept = licKept;
  return jr(200, okOut);
}

// ---- 일감 수집 공통 ----
// 병합 원칙: 새 id만 추가(status=new). 기존 항목은 원천 메타만 갱신, 앱이 관리하는 status는 절대 보존. 삭제 없음.
// v380(10/11, PM "마감 14일 보관"): 마감이 14일 넘게 지난 공고 가운데 사람이 손대지 않은 것(new·패스)만 정리한다.
// 검토·응찰·참여·낙찰·유찰은 이력이라 남긴다. 수집봇은 원장 전건을 매일 보내므로 들어오는 쪽도 같은 규칙으로 걸러 되살아나지 않게 한다.
// due가 YYYY-MM-DD가 아니면(빈 값·다른 표기) 만료로 보지 않는다 — 모르면 지우지 않는다.
const BIDS_KEEP_DAYS = 14;
const BIDS_PURGEABLE = { 'new': 1, '패스': 1 };
function bidsCutDate(keepDays) {
  return new Date(Date.now() + 9 * 3600000 - (keepDays || BIDS_KEEP_DAYS) * 86400000).toISOString().slice(0, 10);
}
function bidExpired(it, cut) {
  const due = String((it && it.due) || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(due) && due < cut;
}
function bidPurgeable(it, cut) { return !!(it && bidExpired(it, cut) && BIDS_PURGEABLE[it.status || 'new']); }
function purgeExpiredBids(doc, cut) {
  const before = doc.items.length;
  doc.items = doc.items.filter(function (it) { return !bidPurgeable(it, cut); });
  return before - doc.items.length;
}
// v444(45-1 일곱째 판 — PM 11/10 15:56 결정 ⑥ '마감 지난 부동산 물건도 공고와 같은 규칙'): 부동산(온비드 col:onbid)도 마감 + BIDS_KEEP_DAYS(14일) 지난 'new'·'패스'만 정리하고
//   검토·참여·그 밖 사람이 정한 상태는 보존한다. 날짜 경계·대상 판정은 공고와 한 벌(bidsCutDate·bidPurgeable·purgeExpiredBids — 부동산용을 따로 만들지 않는다).
//   ★기본 꺼짐: 설정 settings:onbid의 purge가 true일 때만 정리한다(키 없음·읽기 실패·true가 아닌 값 = 끔 — 모르면 지우지 않는다).
//   켜기 전에 지워질 건수를 세어 PM께 보고(onbid_purge dry — 관리자, 쓰기 0) → 켜기·끄기 onbid_purge_set(관리자 — 감사 1줄·prev 1판).
//   켜져 있으면 정리 자리는 공고와 같다: ① 수집 ingest(평일 아침 — 정리가 있는 날은 VER_SKIP을 넘어 하루 1벌 스냅샷) ② 앱 저장 save(409 병합이 되살린 만료 줄을 다시 거름 —
//   서버 문서에 있던 줄을 지우게 되면(켠 뒤 첫 정리가 수집보다 먼저 오는 날 등) 저장 전 문서를 스냅샷으로 남기고 감사에 '정리' 1줄) ③ 되살림 방지(ingest가 원장에 없는 만료 new·패스를 받지 않음).
const ONBID_SET_KEY = 'settings:onbid';
async function onbidPurgeOn(st) {
  try { const r = await blobGet(st, ONBID_SET_KEY); return !!(r.ok && r.data && r.data.purge === true); } catch (e) { return false; }
}
function mergeBidItems(doc, items) {
  const byId = {};
  doc.items.forEach(function (it) { if (it && it.id) byId[it.id] = it; });
  const today = new Date().toISOString().slice(0, 10);
  // v444 검토: 새 줄의 created(부동산 펼침 '수집일')는 KST 날짜 — 평일 아침 수집(KST 07:23 = UTC 전날 22:23)이 하루 앞 날짜(일요일 등)로 찍히던 것.
  //   updated는 종전 그대로(UTC 날짜 — 앱 mergeBidsLocal이 날짜 단위로 견주는 축이라 바꾸지 않는다). 이미 저장된 줄의 created는 그대로(옛 UTC 날짜)
  const kstDay = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  let added = 0, updated = 0;
  for (const n of (items || [])) {
    if (!n || !n.id) continue;
    const cur = byId[n.id];
    if (!cur) {
      doc.items.push({ id: n.id, source: n.source || '', kind: n.kind || '입찰', title: n.title || '', org: n.org || '',
        region: n.region || '', due: n.due || '', budget: n.budget || 0, url: n.url || '',
        matched: Array.isArray(n.matched) ? n.matched : [], method: n.method || '', rgn_ref: !!n.rgn_ref, appr: n.appr || 0,
        no: n.no || '', posted: n.posted || '', docs: Array.isArray(n.docs) ? n.docs : [], ext: (n.ext && typeof n.ext === 'object') ? n.ext : {},
        status: (n.status === '패스' ? '패스' : 'new'), auto_pass: !!n.auto_pass, created: kstDay, updated: today });
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
// v444 검토(데이터 삭제 안전 — 공고·부동산 공통): ① 원장을 못 읽으면(읽기·파싱 실패) 빈 원장에 받은 줄만 다시 쓰지 않고 500 — 사람 상태(검토·참여·패스)가 모두 사라지고
//   정리가 켜져 있으면 마감 지난 검토·참여 줄까지 줄째 빠지던 길(키 없음 = 빈 원장으로 시작은 그대로 · 수집기 ingest_push는 3번 다시 보내고 그래도 실패면 잡 실패 → watch 경보)
//   ② 읽은 뒤 쓰기 전까지(정리하는 날은 정리 전 스냅샷 쓰기까지 몇 초) 관리자 저장이 끼면 그 저장을 409 없이 덮었다(정리가 켜져 있으면 그사이 신규 → 검토로 바꾼 만료 줄이 줄째 지워짐) —
//   쓰기 직전에 원장을 다시 읽어 updated_at이 처음 읽은 값과 다르면 받은 줄 그대로 처음부터 다시(attempt — 모두 3번까지, 셋째 번은 다시 읽지 않고 씀 ·
//   조건부 쓰기가 없는 @netlify/blobs 8.2.0이라 다시 읽어 견줌 — 다시 읽은 뒤 쓰기까지의 짧은 틈은 남음)
async function handleBidsIngest(event, d, R, attempt) {
  attempt = attempt || 1;
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });   // v453 상수시간
  if (!Array.isArray(d.items)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_ITEMS', request_id: R });
  const target = (d.col === 'onbid') ? 'onbid' : 'bids';
  const st = store(DATA);
  const r = await blobGet(st, colKey(target));
  if (!r.ok && r.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: r.code || 'STORAGE_READ_FAILED', request_id: R });   // v444 검토 ①
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const at0 = (r.ok && r.data) ? r.data.updated_at : undefined, inItems = d.items;   // v444 검토 ② 처음 읽은 원장 시각 · 받은 줄(되살림 방지가 d.items를 거른 사본으로 바꾸므로 다시 할 때 되돌림)
  const cut = bidsCutDate();
  const purgeOn = target === 'bids' || (target === 'onbid' && await onbidPurgeOn(st));   // v444 부동산은 설정 settings:onbid가 켜졌을 때만(기본 꺼짐) — 공고는 종전대로 늘
  // v380(검토 발견): 정리가 있는 날은 VER_SKIP(bids)을 넘어 강제 보존 — 매일 정리는 재수집으로 못 되돌리는 삭제라 하루 1벌은 남긴다(v444 부동산도 같음)
  const willPurge = purgeOn && doc.items.some(function (it) { return bidPurgeable(it, cut); });
  await verSnapshot(target, doc, '수집봇', true, willPurge);   // 병합이 doc를 제자리 변형하므로 반드시 병합 전에(봇은 일 1개)
  let skipped = 0;
  if (purgeOn) {   // v380 되살림 방지 — 원장이 더 오래 들고 있는 만료 공고(new·패스)는 앱에 없으면 받지 않는다(v444 부동산도 켜졌으면 같음)
    const have = {}; doc.items.forEach(function (it) { if (it && it.id) have[it.id] = 1; });
    d.items = d.items.filter(function (n) { const drop = n && n.id && !have[n.id] && bidPurgeable(n, cut); if (drop) skipped++; return !drop; });
  }
  const m = mergeBidItems(doc, d.items);
  const purged = purgeOn ? purgeExpiredBids(doc, cut) : 0;   // v380 기존 만료 new·패스 정리(사람이 정한 상태는 보존)
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
  if (m.added || m.updated || hasHealth || hasAwards || purged) {
    if (attempt < 3) {   // v444 검토 ② 쓰기 직전 다시 읽기 — 그사이 누가 썼으면(updated_at이 다름) 받은 줄 그대로 새 원장으로 처음부터
      const r2 = await blobGet(st, colKey(target));
      if (!r2.ok && r2.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: r2.code || 'STORAGE_READ_FAILED', request_id: R });
      if (((r2.ok && r2.data) ? r2.data.updated_at : undefined) !== at0) { d.items = inItems; return handleBidsIngest(event, d, R, attempt + 1); }
    }
    doc.updated_by = '수집봇'; doc.updated_at = Date.now();
    const w = await blobSet(st, colKey(target), doc);
    if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
    if (m.added || m.updated || purged) { try { await appendAudit({ ts: Date.now(), by: '수집봇', bid: 'bot', col: target, ev: [{ op: '수집', id: '', t: '신규 ' + m.added + ' · 갱신 ' + m.updated + (purged ? ' · 정리 ' + purged + '건(마감 ' + BIDS_KEEP_DAYS + '일 경과)' : '') }] }); } catch (e) {} }
  }
  return jr(200, { status: 'OK', added: m.added, updated: m.updated, purged: purged, skipped: skipped, total: doc.items.length, request_id: R });
}

// 정기업무 봇 ingest(autotask 크론 전용) — S1 단일 원천 이후 리포 tasks.json이 스테일 미러가 되어
// 크론 생성 지시(만기·미수·증명서)가 앱에 도달하지 않던 사고(2026-08-04 발견)의 수리.
// auto_key로 중복 방지 병합(앱 생성분과 동일 키 체계), hide_keys=자기정정(회색 차량 등) 숨김.
// v453(보안 재감사 ② — 자동 지시 live 전 · 원장 C093): 서버도 규칙 스위치(settings:autotask)를 본다 — 종전엔 live 판정이 봇(autotask.py)에만 있어
//   봇 버그 때 dry·off 규칙 항목이 실제 지시로 들어갔다. 새 규칙 3건의 키 꼴(autotaskRuleOf)이면 스위치가 'live'일 때만 만들고,
//   아니면(dry·off·스위치 읽기 실패 = 기본 dry) 만들지 않고 blocked로 센다(다른 항목·hide_keys는 그대로 · 막힌 것이 있으면 감사 1줄). 기존 4규칙(D-30 차량·인허가·미수·증명서)은 스위치와 무관.
//   키 꼴은 허용 목록(AUTOTASK_KEY_RE — 봇 collectors/autotask.py와 앱이 쓰는 7꼴, 날짜·월은 엄격, 끝 공백 없음)이다 — 어느 꼴에도 맞지 않는 auto_key는
//   만들지 않고 blocked_rules.unknown으로 센다('site:missing-2026-11'·'wk:Missing:…'·'veh:X:insp:<날> '처럼 꼴만 살짝 바꿔 스위치를 비켜 가던 길 · v453 검토).
//   (봇 키가 새면 이 판정만으로는 못 막는다 — 키를 가진 쪽은 맞는 꼴로 보낼 수 있다. 이 판정이 막는 것은 봇 버그·꼴 어긋남.)
const AUTOTASK_ID = "[^:\\s\\x00-\\x1f\\x7f]{1,80}";   // 차량 id는 'v' + 번호판(한글 포함) — 콜론·공백·제어문자만 뺀다
const AUTOTASK_DATE = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';
const AUTOTASK_MONTH = '\\d{4}-(?:0[1-9]|1[0-2])';
const AUTOTASK_KEY_RE = {
  veh: new RegExp('^veh:' + AUTOTASK_ID + ':(insp|ins):(' + AUTOTASK_DATE + ')$'),
  lic: new RegExp('^lic:' + AUTOTASK_ID + ':(?:exp|edu):' + AUTOTASK_DATE + '$'),
  rec: new RegExp('^rec:' + AUTOTASK_ID + ':over45$'),
  cert: /^cert:c\d{1,6}$/,
  site: new RegExp('^site:missing:' + AUTOTASK_MONTH + '$'),
  wk: new RegExp('^wk:missing:' + AUTOTASK_MONTH + '$'),
};
// 돌려주는 값: 'site_missing'·'wk_missing'·'veh_insp90'(스위치 대상) · ''(기존 4규칙 — 스위치 무관) · 'unknown'(허용 목록 밖 — 늘 막음)
function autotaskRuleOf(autoKey, today) {
  const k = typeof autoKey === 'string' ? autoKey : '';
  if (AUTOTASK_KEY_RE.site.test(k)) return 'site_missing';
  if (AUTOTASK_KEY_RE.wk.test(k)) return 'wk_missing';
  // veh:<id>:insp:<만료일>은 기존 D-30과 같은 키 꼴 — 만료일이 오늘(KST)부터 31일 이상이면 D-90 규칙(autorules VEH90_MIN · autotask.py DUE_WINDOW 30과 같은 경계)
  const m = AUTOTASK_KEY_RE.veh.exec(k);
  if (m) {
    if (m[1] !== 'insp') return '';
    const dd = AR.dayDiff(m[2], today);
    if (dd === null) return 'unknown';
    return dd >= AR.VEH90_MIN ? 'veh_insp90' : '';
  }
  if (AUTOTASK_KEY_RE.lic.test(k) || AUTOTASK_KEY_RE.rec.test(k) || AUTOTASK_KEY_RE.cert.test(k)) return '';
  return 'unknown';
}
async function handleAutotaskIngest(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });   // v453 상수시간
  const items = Array.isArray(d.items) ? d.items : [];
  const hideKeys = Array.isArray(d.hide_keys) ? d.hide_keys.map(String) : [];
  const st = store(DATA);
  const r = await blobGet(st, colKey('tasks'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  await verSnapshot('tasks', doc, '정기봇', true);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const sw = await autotaskRead(st);   // v453 규칙 스위치 — 키 없음·읽기 실패면 기본 dry(막음)
  const have = {}, have0 = {};
  doc.items.forEach(function (t) { if (t && t.auto_key) { have[t.auto_key] = t; have0[t.auto_key] = 1; } });
  let made = 0, fixed = 0, blocked = 0;
  const blockedBy = {};
  for (const n of items.slice(0, 100)) {
    const k = String((n && n.auto_key) || '');
    if (!k || have[k]) continue;
    const rule = autotaskRuleOf(k, today);
    if (rule && (rule === 'unknown' || sw.rules[rule] !== 'live')) { blocked++; blockedBy[rule] = (blockedBy[rule] || 0) + 1; continue; }   // v453
    doc.items.push({ id: 't' + crypto.randomBytes(6).toString('hex'), title: String(n.title || '').slice(0, 120),
      detail: String(n.detail || '').slice(0, 500), who_id: '', who: '', scope: [],
      from: '자동', from_id: '', by: '자동', due: String(n.due || '').slice(0, 10), status: 'open',
      done_at: null, done_by: null, auto_key: k, created: today, updated: today });
    have[k] = doc.items[doc.items.length - 1];
    made++;
  }
  // P1 판2(원장 T693·T364): 차량 만기 '다시 지시' — 기존 D-30 차량 규칙(스위치 무관)의 갈래. 봇이 보낸 항목이 아니라 서버가 지금 차량·지시로 센다(_lib/autorules vehRedo — 앱 runAutoTaskGen과 같은 규칙).
  //   만료일이 지났는데 그 만료일 지시가 완료된 채 날짜가 그대로인 차 → 'veh:<id>:<insp|ins>:<만료일>:re:<YYYY-MM>'(달마다 한 번). 담당은 아래 배정표 채움(veh: 접두어)·알림은 기존 길 그대로. 차량을 못 읽으면 건너뜀.
  //   검토 P1-4: 이 갈래는 봇이 ingest를 부를 때만 돈다 — 지금 봇(appdata collectors/autotask.py)은 새 항목도 숨길 키도 없으면 ingest를 부르지 않으므로 매일 돈다는 보장이 없다.
  //     주 경로는 관리자 앱 접속(runAutoTaskGen — 세션 1회), 이 갈래는 보조. 봇이 매일 부르게 하는 것은 appdata 쪽 일(이 판 밖).
  let redo = 0;
  try {
    const rvh = await blobGet(st, colKey('vehicles'));
    if (rvh.ok && rvh.data && Array.isArray(rvh.data.items)) {
      AR.vehRedo(rvh.data.items, doc.items, today).forEach(function (n) {
        if (have[n.auto_key]) return;
        doc.items.push({ id: 't' + crypto.randomBytes(6).toString('hex'), title: String(n.title).slice(0, 120), detail: String(n.detail).slice(0, 500), who_id: '', who: '', scope: [],
          from: '자동', from_id: '', by: '자동', due: n.due, status: 'open', done_at: null, done_by: null, auto_key: n.auto_key, created: today, updated: today });
        have[n.auto_key] = doc.items[doc.items.length - 1];
        made++; redo++;
      });
    }
  } catch (e) {}
  hideKeys.slice(0, 200).forEach(function (k) {
    const t = have[k];
    if (t && t.del !== 1) { t.del = 1; t.updated = today; fixed++; }
  });
  // v395 배정표: 새 항목과 기존 공란 자동 지시에 담당 채움(사람 지정분 불변) — 매일 아침 ingest가 곧 일일 backfill
  let assigned = 0;
  const blankBefore = {}; doc.items.forEach(function (t) { if (t && t.auto_key && !t.who_id) blankBefore[t.id] = 1; });
  try { const at = await assignRead(st); if (Object.keys(at.rules || {}).length) { const ms = await assignMembers(); if (ms) assigned = assignFill(doc.items, at.rules, assignNames(ms)); } } catch (e) {}
  // v396 알림: 이번에 생긴 항목 + 이번에 담당이 채워진 항목 → 담당자 본인 1발(설정 assignee일 때만)
  const notifyItems = doc.items.filter(function (t) { return t && t.auto_key && t.who_id && (t.created === today && !have0[t.auto_key] || blankBefore[t.id]); });
  let notified = 0;
  if (notifyItems.length) notified = await notifyAutoCreated(st, notifyItems, '정기봇');
  const blockTxt = blocked ? ' · 스위치 막음 ' + blocked + '(' + Object.keys(blockedBy).map(function (k) { return k + ' ' + blockedBy[k] + ' — ' + (k === 'unknown' ? '허용 꼴 밖' : sw.rules[k]); }).join(', ') + ')' : '';   // v453 규칙 이름·건수·스위치 값만(키·본문 없음)
  if (made || fixed || assigned) {
    doc.updated_by = '정기봇'; doc.updated_at = Date.now();
    const w = await blobSet(st, colKey('tasks'), doc);
    if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
    try { await appendAudit({ ts: Date.now(), by: '정기봇', bid: 'bot', col: 'tasks', ev: [{ op: '정기업무', id: '', t: '신규 ' + made + (redo ? '(차량 다시 지시 ' + redo + ')' : '') + ' · 정정 ' + fixed + (assigned ? ' · 배정 ' + assigned : '') + blockTxt }] }); } catch (e) {}
  } else if (blocked) {
    try { await appendAudit({ ts: Date.now(), by: '정기봇', bid: 'bot', col: 'tasks', ev: [{ op: '정기업무', id: '', t: '신규 0' + blockTxt }] }); } catch (e) {}   // v453 쓴 것은 없어도 막힌 것은 남김
  }
  return jr(200, { status: 'OK', made: made, redo: redo, fixed: fixed, assigned: assigned, notified: notified, blocked: blocked, blocked_rules: blockedBy, request_id: R });
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
  const botOk = botKeyOk(d.key);   // v453 상수시간
  let c = { member: { id: 'bot', name: '수집봇' } };
  if (!botOk) {
    c = await currentMember(event);
    if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
    if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  }
  const st = store(DATA);
  const r = await blobGet(st, colKey('bids'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
  const cutP = bidsCutDate();
  const dryRun = d.dry === true || d.dry === 'true' || d.dry === 1;   // 관용(검토 발견: 문자열 'true'로 실제 정리가 돌지 않게)
  if (d.mode === 'expired' && dryRun) {   // v380 — 세기만(스냅샷·저장 없음): 정리 전 PM 보고용
    const would = doc.items.filter(function (it) { return bidPurgeable(it, cutP); }).length;
    return jr(200, { status: 'OK', dry: true, would_remove: would, total: doc.items.length, cut: cutP, keep_days: BIDS_KEEP_DAYS, request_id: R });
  }
  await verSnapshot('bids', doc, c.member.name, false, true);   // 비우기는 파괴적 — 제외 대상이어도 강제 보존
  const before = doc.items.length;
  if (d.mode === 'expired') purgeExpiredBids(doc, cutP);   // v380 마감 14일 경과 new·패스만
  else doc.items = (d.mode === 'all') ? [] : doc.items.filter(function (it) { return it && it.status && it.status !== 'new'; });
  const removed = before - doc.items.length;
  doc.updated_by = c.member.id; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('bids'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  // 쿨다운도 해제해 바로 재수집 가능하게
  try { await blobSet(st, 'bids:lastfetch', { ts: 0 }); } catch (e) {}
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'bids', ev: [{ op: '비우기', id: '', t: (d.mode === 'all' ? '전체' : d.mode === 'expired' ? '마감 ' + BIDS_KEEP_DAYS + '일 경과' : '미검토') + ' ' + removed + '건 제거' }] }); } catch (e) {}
  return jr(200, { status: 'OK', removed: removed, total: doc.items.length, request_id: R });
}

// v444 부동산 정리 세기(dry-run — PM 11/10 결정 ⑥ '적용 전 지워질 건수를 먼저 세어 보고'): 관리자 세션만(비관리자 403 ADMIN_ONLY · 봇 키 없음). 쓰기 0(스냅샷·저장·감사 없음).
//   설정이 꺼져 있어도 센다(켜기 전 보고용). dry가 참이 아니면 400 DRY_ONLY — 이 액션으로는 지우지 않는다(실제 정리는 설정을 켠 뒤 수집·저장에서만).
//   would_remove = 공고 정리와 같은 판정(bidPurgeable — 마감 < bidsCutDate() · new·패스) · by_status = 그중 신규·패스 · kept_expired = 마감 14일이 지났지만 사람이 정한 상태라 남는 줄 ·
//   no_due = 마감이 YYYY-MM-DD가 아니라 지우지 않는 줄 · no_url = 지울 줄 중 원문 링크 없는 줄(같은 규칙으로 지움) · on = 지금 설정
async function handleOnbidPurge(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const dryRun = d.dry === true || d.dry === 'true' || d.dry === 1;   // bids_purge와 같은 관용
  if (!dryRun) return jr(400, { status: 'REJECTED', error_code: 'DRY_ONLY', request_id: R });
  const st = store(DATA);
  const r = await blobGet(st, colKey('onbid'));
  if (!r.ok && r.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: r.code || 'STORAGE_READ_FAILED', request_id: R });   // 못 읽은 원장을 '0건'으로 보고하지 않게
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const cut = bidsCutDate();
  let would = 0, byNew = 0, byPass = 0, keptExp = 0, noDue = 0, noUrl = 0;
  items.forEach(function (it) {
    if (!it) return;
    if (bidPurgeable(it, cut)) { would++; if ((it.status || 'new') === '패스') byPass++; else byNew++; if (!it.url) noUrl++; return; }
    if (bidExpired(it, cut)) keptExp++;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it.due || '').slice(0, 10))) noDue++;
  });
  return jr(200, { status: 'OK', dry: true, on: await onbidPurgeOn(st), would_remove: would, by_status: { 'new': byNew, '패스': byPass }, kept_expired: keptExp, no_due: noDue, no_url: noUrl,
    total: items.length, cut: cut, keep_days: BIDS_KEEP_DAYS, request_id: R });
}
// v444 부동산 정리 켜기·끄기(settings:onbid — 기본 꺼짐): 관리자 세션만(403 ADMIN_ONLY) · on은 참·거짓만(400 BAD_VALUE) · base가 오면 지금 updated_at과 같아야(409 ONBID_STALE — 없는 설정은 0) ·
//   같은 값 400 NO_CHANGE · 설정을 못 읽으면 500(덮어쓰지 않음) · prev 1판 · 감사 1줄(col onbid '정리설정'). 켠 다음 정리는 다음 수집(평일 아침)이나 관리자의 부동산 저장 때 일어난다.
//   알려진 한계(settings:safety 등 기존 설정 핸들러와 같은 꼴): 읽기 → base 검사 → 쓰기가 원자적이지 않다(동시 저장은 마지막 쓰기가 이김)
async function handleOnbidPurgeSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (typeof d.on !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
  const st = store(DATA);
  const r = await blobGet(st, ONBID_SET_KEY);
  if (!r.ok && r.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: r.code || 'STORAGE_READ_FAILED', request_id: R });
  const cur = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
  const curOn = cur.purge === true, curAt = Number(cur.updated_at) || 0;
  if (d.base !== undefined && Number(d.base) !== curAt) return jr(409, { status: 'CONFLICT', error_code: 'ONBID_STALE', request_id: R });
  if (curOn === d.on) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const doc = { schema: 1, purge: d.on, keep_days: BIDS_KEEP_DAYS, prev: { purge: curOn, updated_at: curAt, updated_by: String(cur.updated_by || '') }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, ONBID_SET_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'onbid', ev: [{ op: '정리설정', id: '', t: '부동산 마감 ' + BIDS_KEEP_DAYS + '일 정리 ' + (curOn ? '켬' : '끔') + '→' + (d.on ? '켬' : '끔') }] }); } catch (e) {}
  return jr(200, { status: 'OK', on: d.on, updated_at: doc.updated_at, request_id: R });
}

// ---- 법인 등기 날짜 settings:corp_reg(P1 판1 — 원장 T462·T461·T388 · 업무별 설계 C6 corp_reg) ----
// 값 = { reg_on(조직변경 등기 접수일), biz_fix_on(사업자등록 정정일), g2b_on(나라장터 변경등록 완료일) — YYYY-MM-DD 또는 빈칸, gate(입찰 투찰 잠금 스위치 — 참·거짓, 기본 꺼짐) }
//   + updated_at·updated_by·prev(직전 1판). 등본 파일은 앱에 올리지 않는다(사무실 문서함 — 문서관리규정). 입력은 나수진(관리자) — 앱 관리자는 전 탭 수행이라 관리자만으로 묶는다.
//   읽기 corp_reg_get = 로그인 → 기기 승인(403 DEVICE_NOT_APPROVED) → 관리자만(403 ADMIN_ONLY — 입찰도 관리자 전용). 저장값이 없으면 settings null·updated_at 0.
//   쓰기 corp_reg_set = 로그인 → 관리자만(403 ADMIN_ONLY) → 값 검사(400 BAD_DATE — 달력에 없는 날·꼴 틀림 · BAD_FUTURE — 오늘(KST) 뒤 · BAD_VALUE — gate가 참·거짓이 아님)
//     → 직전 읽기(실패 500 SETTINGS_READ_FAILED) → 낙관락(base가 저장된 updated_at과 다르면 409 CORP_REG_STALE — base 없음도 409) → 같은 값 400 NO_CHANGE
//     → 저장(prev = 직전 1판) → 감사 1줄(col corp_reg · op 법인등기 · 바뀐 칸 f). 빈칸으로 보내면 그 날짜를 지운다.
//   투찰 잠금(공고 저장 save bids — corpRegGate): gate가 켜져 있고 잠김(corpRegLock — 나라장터 변경등록 완료일이 비었거나 등기 접수일보다 이름)일 때만,
//     응찰(구 참여)·낙찰·유찰이 아니던 줄(또는 서버에 없던 줄)을 응찰로 바꿔 올린 저장을 400 GATE_CORP_REG(+ blocked [{id, from}] · why)로 거절하고 감사 1줄(col bids · op 투찰잠금).
//     낙찰·유찰 → 응찰 되돌리기와 이미 응찰인 줄은 막지 않는다. 바꾼 줄이 없으면 설정을 읽지도 않는다(꺼짐·키 없음 = 종전과 같음 — servertest 86 회귀).
//     바꾼 줄이 있는데 설정을 못 읽으면 503 CORP_REG_READ_FAILED(모르면 열지 않음), 잠긴 채 직전 공고 문서를 못 읽었으면 500 PREV_READ_FAILED.
//   알려진 한계(기존 settings 핸들러와 같은 꼴): 읽기 → base 검사 → 쓰기가 원자적이지 않다(동시 저장은 마지막 쓰기가 이김).
const CORP_REG_KEY = 'settings:corp_reg';
const CORP_REG_DATES = ['reg_on', 'biz_fix_on', 'g2b_on'];
const CORP_REG_LABEL = { reg_on: '조직변경 등기 접수일', biz_fix_on: '사업자등록 정정일', g2b_on: '나라장터 변경등록 완료일', gate: '투찰 잠금' };
function kstDayNow() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
// 요청 몸체(또는 저장값) → { v } | { code }. today가 오면 그 날 뒤 날짜는 BAD_FUTURE(저장값 읽기는 today 없이)
function corpRegClean(d, today) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { code: 'BAD_VALUE' };
  const v = {};
  for (const k of CORP_REG_DATES) {
    const dv = safetyDate(d[k]);
    if (dv === null) return { code: 'BAD_DATE' };
    if (dv && today && dv > today) return { code: 'BAD_FUTURE' };
    v[k] = dv;
  }
  if (d.gate === undefined && !today) v.gate = false;   // 저장값에 칸이 없으면 꺼짐
  else if (typeof d.gate !== 'boolean') return { code: 'BAD_VALUE' };
  else v.gate = d.gate;
  return { v: v };
}
// { ok, doc|null, v|null, at, by } — 없는 키(실 Blobs ok·data null · mock NOT_FOUND) = 입력 전 · 읽기 실패·모양이 깨진 저장값 = ok:false
async function corpRegRead(st) {
  const r = await blobGet(st, CORP_REG_KEY);
  if (!r.ok && r.code === 'NOT_FOUND') return { ok: true, doc: null, v: null, at: 0, by: '' };
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, doc: null, v: null, at: 0, by: '' };
  const c = corpRegClean(r.data, '');
  if (!c.v) return { ok: false, code: 'SETTINGS_INVALID' };
  return { ok: true, doc: r.data, v: c.v, at: Number(r.data.updated_at) || 0, by: String(r.data.updated_by || '') };
}
// 잠김 이유 — '' = 안 잠김(스위치 꺼짐 포함) · G2B_EMPTY = 완료일 빔 · G2B_BEFORE_REG = 완료일이 등기 접수일보다 이름(다음 변경). 앱 corpRegLockOf와 같은 규칙(uismoke 대조)
function corpRegLock(v) {
  if (!v || v.gate !== true) return '';
  if (!v.g2b_on) return 'G2B_EMPTY';
  if (v.reg_on && v.g2b_on < v.reg_on) return 'G2B_BEFORE_REG';
  return '';
}
function corpRegOut(s, R) {
  const p = s.doc && s.doc.prev;
  return jr(200, { status: 'OK', settings: s.v, updated_at: s.at, updated_by: s.by, lock: corpRegLock(s.v), prev: p ? { updated_at: Number(p.updated_at) || 0, updated_by: String(p.updated_by || '') } : null, request_id: R });
}
const BID_GATE_KEEP = { '응찰': 1, '참여': 1, '낙찰': 1, '유찰': 1 };   // 이 상태에서 응찰로 오는 것은 새 투찰이 아님(되돌리기·그대로)
function bidGateTurns(oldItems, items) {
  const old = {};
  (oldItems || []).forEach(function (o) { if (o && o.id) old[o.id] = o; });
  return (items || []).filter(function (t) {
    if (!t || t.del === 1 || (t.status !== '응찰' && t.status !== '참여')) return false;
    const o = old[t.id];
    return !(o && o.del !== 1 && BID_GATE_KEEP[o.status]);
  }).map(function (t) { const o = old[t.id]; return { id: String(t.id || ''), from: o ? String(o.status || 'new') : '' }; });
}
// 공고 저장의 투찰 잠금 — null = 통과 · { http, body } = 거절
async function corpRegGate(st, oldItems, items, prevReadFailed, R) {
  const turns = bidGateTurns(oldItems, items);
  if (!turns.length) return null;
  const s = await corpRegRead(st);
  if (!s.ok) return { http: 503, body: { status: 'ERROR', error_code: 'CORP_REG_READ_FAILED', request_id: R } };
  const why = corpRegLock(s.v);
  if (!why) return null;
  if (prevReadFailed) return { http: 500, body: { status: 'ERROR', error_code: 'PREV_READ_FAILED', request_id: R } };
  return { http: 400, body: { status: 'REJECTED', error_code: 'GATE_CORP_REG', why: why, blocked: turns, request_id: R } };
}
async function handleCorpRegGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const s = await corpRegRead(store(DATA));
  if (!s.ok) return jr(500, { status: 'ERROR', error_code: s.code, request_id: R });
  return corpRegOut(s, R);
}
async function handleCorpRegSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const nv = corpRegClean(d, kstDayNow());
  if (!nv.v) return jr(400, { status: 'REJECTED', error_code: nv.code, request_id: R });
  const st = store(DATA);
  const cur = await corpRegRead(st);
  if (!cur.ok) return jr(500, { status: 'ERROR', error_code: 'SETTINGS_READ_FAILED', request_id: R });   // 읽기 실패 위에 쓰면 저장돼 있던 값이 사라진다 — 거부
  if (d.base === undefined || Number(d.base) !== cur.at) return jr(409, { status: 'CONFLICT', error_code: 'CORP_REG_STALE', request_id: R });
  const was = cur.v || { reg_on: '', biz_fix_on: '', g2b_on: '', gate: false };
  if (cur.v && JSON.stringify(cur.v) === JSON.stringify(nv.v)) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const chg = {};
  CORP_REG_DATES.forEach(function (k) { if (was[k] !== nv.v[k]) chg[k] = [was[k], nv.v[k]]; });
  if (was.gate !== nv.v.gate) chg.gate = [was.gate ? '켬' : '끔', nv.v.gate ? '켬' : '끔'];
  if (!cur.v && !Object.keys(chg).length) chg.gate = ['(입력 전)', '끔'];   // 처음 저장이 빈 값 그대로여도 감사 1줄은 남김
  const doc = Object.assign({ schema: 1 }, nv.v, { prev: cur.doc ? Object.assign({}, cur.v, { updated_at: cur.at, updated_by: cur.by }) : null,
    updated_by: c.member.id, updated_at: Math.max(Date.now(), cur.at + 1) });   // 같은 ms 두 저장도 낙관락 토큰이 달라지게
  const w = await blobSet(st, CORP_REG_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  const t = Object.keys(chg).map(function (k) { return CORP_REG_LABEL[k] + ' ' + (chg[k][0] || '—') + '→' + (chg[k][1] || '—'); }).join(' · ').slice(0, 300);
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'corp_reg', ev: [{ op: '법인등기', id: CORP_REG_KEY, t: t, f: chg }] }); } catch (e) {}
  return corpRegOut({ doc: doc, v: nv.v, at: doc.updated_at, by: doc.updated_by }, R);
}

// 일감 이력 export(수집봇) — 학습 필터용(패스 패턴). 경량 필드만 반환.
async function handleBidsExport(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const r = await blobGet(store(DATA), colKey('bids'));
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const lite = items.map(function (it) { return { id: it.id, status: it.status, title: it.title, org: it.org, source: it.source, auto_pass: !!it.auto_pass, no: it.no || '', due: it.due || '', url: it.url || '' }; });
  return jr(200, { status: 'OK', items: lite, request_id: R });
}

// 개찰결과 수신(수집봇 전용) — 응찰 건의 낙찰/유찰 결과를 카드에 반영.
// status는 현재 응찰(구 참여)일 때만 자동 변경 — 사람이 정한 다른 상태는 건드리지 않는다.
async function handleBidsResults(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
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
    // 낙찰/유찰 확정 → 웹푸시(실패해도 수신 처리는 성공으로). v415: settings:notify bid_result=award면 낙찰만 즉시(입찰 담당+PM 우선기기), 유찰은 gw-todo-cron 아침 요약.
    if (ev.length) {
      try {
        const tcB = await push.tierCtx();   // 스캔 1회 — 수신자 목록과 sendTo 활성 필터에 같은 컨텍스트를 쓴다
        const nfB = await notifyRead(st);
        if (nfB.events.bid_result === 'award') {
          const aw = ev.filter(function (x) { return / → 낙찰$/.test(String(x.t || '')); });
          if (aw.length) { const to = await bidNotifyIds(st, tcB); if (to.length) await push.sendTo(to, { title: '낙찰 ' + aw.length + '건', body: aw.map(function (x) { return x.t; }).join('\n').slice(0, 300), url: './', tag: 'bids-award' }, { ctx: tcB, primaryOnly: true }); }
        } else {
          const ids = tcB.adminIds;
          if (ids.length) await push.sendTo(ids, { title: '개찰결과 ' + ev.length + '건',
            body: ev.map(function (x) { return x.t; }).join('\n').slice(0, 300), url: './', tag: 'bids-result' }, { ctx: tcB });
        }
      } catch (e) {}
    }
  }
  return jr(200, { status: 'OK', applied: applied, request_id: R });
}

// v415 입찰 알림 수신자 — 배정표 bid: 담당(나수진 고정, PM 10/26) + PM(tier pm, 없으면 관리자). 중복 제거.
async function bidNotifyIds(st, tc) {
  const out = [];
  try { const a = await assignRead(st); const w = a.rules && a.rules['bid:'] && a.rules['bid:'].who_id; if (w) out.push(String(w)); } catch (e) {}
  const pm = (tc && Array.isArray(tc.pmIds) && tc.pmIds.length) ? tc.pmIds : ((tc && tc.adminIds) || []);
  pm.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
  return out;
}
// 봇 알림(정기업무 크론 전용) — 공유 시크릿 인증. 관리자 접속과 무관하게 만기·미수 알림이 나가야 한다.
async function handleBotNotify(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const title = String(d.title || '알림').slice(0, 60);
  const body = String(d.body || '').slice(0, 300);
  const tag = String(d.tag || 'bot-notify').slice(0, 30);
  // 반환값은 실제 발송 결과(sent=성공한 기기 수). 관리자 수와 혼동하면 안 된다(과거 오보 원인).
  try {
    const tcN = await push.tierCtx();   // 스캔 1회 — adminIds와 sendTo 활성 필터 공용
    const ids = tcN.adminIds.slice();
    // v417 카드 10 공통 바탕 ⑥: 서버 봇 '정기업무 n건'(태그 auto-due)도 알림 설정 task_auto_create를 따른다 — 담당자 본인 1발이면 관리자 전원 푸시 생략.
    // 단 설정 전환 뒤 첫 1주는 병행(설정 updated_at 기준 7일 — 브리핑 §7 '첫 1주 PM 병행'). v437부터 판정은 notifyParallelOn 한 곳 — 앱 경로 handlePushSend와 같은 함수.
    if (tag === 'auto-due') {
      try {
        const nfA = await notifyRead(store(DATA));
        if (nfA.events.task_auto_create === 'assignee' && !notifyParallelOn(nfA))
          return jr(200, { status: 'OK', sent: 0, admins: ids.length, devices: 0, note: 'task_auto_create=assignee — 관리자 푸시 생략(담당자 본인 1발은 ingest가 보냄)', request_id: R });
      } catch (e) {}
    }
    // v415 bid_fail=assignee: watch.py 입찰 감시 경보(태그 watch-입찰-날짜)는 입찰 담당(배정표 bid:)에게도 1발
    try { const nfN = await notifyRead(store(DATA)); if (nfN.events.bid_fail === 'assignee' && /^watch-입찰/.test(tag)) { const a = await assignRead(store(DATA)); const w = a.rules && a.rules['bid:'] && a.rules['bid:'].who_id; if (w && ids.indexOf(String(w)) < 0) ids.push(String(w)); } } catch (e) {}
    const subs = await push.getSubs();
    const devices = ids.reduce(function (n, id) { return n + ((subs.members[id] || []).length); }, 0);
    if (!ids.length) return jr(200, { status: 'OK', sent: 0, admins: 0, devices: 0, note: '관리자 없음', request_id: R });
    if (!devices) return jr(200, { status: 'OK', sent: 0, admins: ids.length, devices: 0, note: '구독 기기 없음 — 각 기기에서 [알림 켜기] 필요', request_id: R });
    const r = await push.sendTo(ids, { title: title, body: body, url: './', tag: tag }, { ctx: tcN });
    return jr(200, { status: 'OK', sent: r.sent, removed: r.removed, admins: ids.length, devices: devices, request_id: R });
  } catch (e) {
    return jr(200, { status: 'OK', sent: 0, note: 'push 예외: ' + String(e && e.message || e).slice(0, 80), request_id: R });
  }
}

// 홈페이지 문의 알림(v380, PM 10/10 "앱 푸시로 연결") — jongwoon-website의 inquiry 함수가 저장 직후 공유 비밀키(INQUIRY_PUSH_KEY)로 부른다.
// 받는 사람 = PM 등급(없으면 관리자). 문의 내용은 외부 입력이라 길이·제어문자만 정리해 본문에 싣고 제목에는 섞지 않는다.
// 키가 설정돼 있지 않으면 전부 403 — 열린 문을 두지 않는다.
const INQUIRY_ADMIN_URL = 'https://www.jongwoon.co.kr/member-admin.html';
const INQUIRY_RL_WINDOW = 10 * 60 * 1000, INQUIRY_RL_MAX = 6;
function keyMatch(given, secret) {   // 상수시간 비교(검토 발견 low) — 길이가 다르면 바로 false, 같으면 timingSafeEqual
  const a = Buffer.from(String(given || '').trim(), 'utf8'), b = Buffer.from(String(secret || ''), 'utf8');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}   // 10분 6건 — 홈페이지 쪽 IP 제한(5건/10분)을 뚫어도 PM 폰·알림함(push:log 100건 링)을 밀어내지 못하게
// v453 봇 키(BIDS_INGEST_KEY) 비교 한 곳 — 상수시간(keyMatch: 길이가 다르면 거부, 같으면 timingSafeEqual) · env가 비면 늘 거부(기본 개방 금지).
//   이 파일의 봇 경로(bids_ingest·autotask_ingest·bids_purge 봇 갈래·bids_export·bids_results·bot_notify·autotask_facts·autotask_dry_put·backup_*·settings_apply)는 전부 이것만 쓴다(종전 '!==' 비교 — 보안 재감사 ②).
function botKeyOk(given) { return keyMatch(given, (process.env.BIDS_INGEST_KEY || '').trim()); }
async function handleInquiryNotify(event, d, R) {
  const secret = (process.env.INQUIRY_PUSH_KEY || '').trim();
  if (!secret || !keyMatch(d.key, secret)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INQUIRY_KEY', request_id: R });
  try {   // 속도 제한(검토 발견 10/11): 창 안 건수가 상한이면 발송 없이 OK — 접수 자체는 홈페이지에 이미 저장돼 있다
    const now = Date.now();
    const rl = await blobGet(store(DATA), 'inquiry:rl');
    const ts = ((rl.ok && rl.data && Array.isArray(rl.data.ts)) ? rl.data.ts : []).filter(function (t) { return now - t < INQUIRY_RL_WINDOW; });
    if (ts.length >= INQUIRY_RL_MAX) return jr(200, { status: 'OK', sent: 0, note: 'rate-limited', window_count: ts.length, request_id: R });
    ts.push(now);
    await blobSet(store(DATA), 'inquiry:rl', { ts: ts.slice(-50) });
  } catch (e) {}
  const clean = function (v, n) { return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); };
  const name = clean(d.name, 40), contact = clean(d.contact, 60), service = clean(d.service, 30), region = clean(d.region, 40), msg = clean(d.message, 120), id = clean(d.id, 40);
  const title = '홈페이지 문의 접수' + (service ? ' · ' + service : '');
  const body = [name + (contact ? ' (' + contact + ')' : ''), region, msg].filter(Boolean).join('\n').slice(0, 300);
  try {
    const tc = await push.tierCtx();
    const ids = (tc.pmIds && tc.pmIds.length) ? tc.pmIds : tc.adminIds;
    if (!ids.length) return jr(200, { status: 'OK', sent: 0, note: '수신자 없음', request_id: R });
    const r = await push.sendTo(ids, { title: title, body: body, url: INQUIRY_ADMIN_URL, tag: 'inquiry' + (id ? ':' + id : '') }, { ctx: tc, by: '홈페이지 문의' });
    return jr(200, { status: 'OK', sent: r.sent, removed: r.removed, to: ids.length, request_id: R });
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
    const tc = await push.tierCtx();   // 회원 스캔 1회 — __admins__ 목록과 수신자 활성 필터(push.sendTo opts.ctx)에 함께 쓴다(v329)
    // v396 알림 설정: ① 자동 지시 생성이 '담당자 본인'이면 클라의 관리자 전원 푸시(auto-due·rec-over·bid-qual)는 서버가 삼킨다(서버가 save 때 담당자에게 보냄)
    //                    v437: 단 전환 뒤 첫 7일(notifyParallelOn — 봇 경로와 같은 함수)은 삼키지 않고 종전처럼 관리자 전원(보낸 사람 제외)에게 보낸다(병행). 담당자 1발은 병행 중에도 save·ingest가 보냄
    //                 ② 완료 요청이 '지시자·승인권자'이면 __admins__ 대신 배정표 승인권자 1인에게만(승인권자 비면 종전대로)
    const tagP = String(payload.tag || '');
    const nfP = (to === '__admins__') ? await notifyRead(store(DATA)) : null;
    if (nfP && nfP.events.task_auto_create === 'assignee' && /^(auto-due|rec-over|bid-qual)$/.test(tagP) && !notifyParallelOn(nfP)) return jr(200, { status: 'OK', sent: 0, suppressed: 'task_auto_create', request_id: R });
    if (d.self === true) ids = [c.member.id];
    else if (to === '__admins__') {
      ids = tc.adminIds.filter(function (id) { return id !== c.member.id; });   // 본인 행동 알림은 본인 제외
      if (nfP && nfP.events.task_review === 'issuer_approver' && /^task-rv-/.test(tagP)) {
        const atP = await assignRead(store(DATA));
        if (atP.approver_id && atP.approver_id !== c.member.id) ids = [atP.approver_id];
      }
    }
    else ids = [to];
    if (!ids.length) return jr(200, { status: 'OK', sent: 0, request_id: R });
    const rres = await push.sendTo(ids, payload, { ctx: tc, by: c.member.id });   // 퇴사·삭제 회원 id로는 발사되지 않는다(v329) · 발신자는 알림함 이력에 남긴다
    return jr(200, { status: 'OK', sent: rres.sent, skipped: rres.skipped || 0, request_id: R });
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
// 29 판⑤(PM 11/12 23:41 · 11/13): 월말명세서 = 차량 거래처 사장님 보고 — 운반일지와 같은 ③ 대표 전결(작업용구 거래처는 결재 없이 나수진 주임 담당 지시)
const APPR_GRADE_DEFAULTS = {
  '운반일지': 3, '지입료': 3, '월말명세서': 3,
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
// ---- v413 결재 학습 신호 clog:appr → lessons:appr (C2-1) ----
// clog 행 추가(해시 체인, 월 키) 뒤 그 달 행 전체를 집계해 lessons:appr를 다시 쓴다(모델 없음). 실패해도 지시 저장은 영향 없음.
const APPR_LESSONS_KEY = 'lessons:appr';
async function apprClogAppend(st, rows, nowMs) {
  const ym = new Date(nowMs + 9 * 3600000).toISOString().slice(0, 7);
  const ck = 'clog:appr:' + ym; const cr = await blobGet(st, ck);
  let cd = (cr.ok && cr.data && Array.isArray(cr.data.items)) ? cr.data : null;
  rows.forEach(function (r) { cd = DONEIF.clogAppend(cd, Object.assign({ ts: nowMs }, r)); });
  const w = await blobSet(st, ck, cd); if (!w.ok) return { ok: false, code: w.code };
  const L = AL.tally(cd.items, ym); L.updated_at = nowMs;
  await blobSet(st, APPR_LESSONS_KEY, L);
  return { ok: true, lessons: L };
}
async function apprLessonsRead(st) { try { const r = await blobGet(st, APPR_LESSONS_KEY); if (r.ok && r.data && r.data.prefixes) return r.data; } catch (e) {} return null; }
// [내 것 아님](담당자 본인, 자동 지시만): 담당 비움 + who_by 'notmine' + 배지. PM 1줄 아님 — 배정표 delta로 집계(설계 A5). 수동 지시는 지시자에게(NOT_AUTO).
async function handleTaskNotmine(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const id = String(d.id || '').slice(0, 60); if (!id) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA); const r = await blobGet(st, colKey('tasks'));
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : null;
  const t = doc ? doc.items.find(function (x) { return x && x.id === id && x.del !== 1; }) : null;
  if (!t) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_TASK', request_id: R });
  if (!t.auto_key) return jr(400, { status: 'REJECTED', error_code: 'NOT_AUTO', request_id: R });
  if (t.status === 'done') return jr(400, { status: 'REJECTED', error_code: 'TASK_DONE', request_id: R });
  if (!t.who_id || t.who_id !== c.member.id) return jr(403, { status: 'FORBIDDEN', error_code: 'NOT_ASSIGNEE', request_id: R });
  const now = Date.now(); const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10); const prev = t.who_id;
  t.who_id = ''; t.who = ''; t.who_by = 'notmine'; t.notmine = { by: c.member.id, ts: now, prev: prev }; t.updated = today;
  doc.updated_by = c.member.id; doc.updated_at = now;
  const w = await blobSet(st, colKey('tasks'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  const p = AL.prefixOf(t.auto_key); let L = null;
  try { const cl = await apprClogAppend(st, [{ id: t.id, f: 'who_id', from: 'set', to: '', why: 'notmine', p: p, by: c.member.id }], now); if (cl.ok) L = cl.lessons; } catch (e) {}
  try { await appendAudit({ ts: now, by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '내것아님', id: t.id, t: String(t.title || '').slice(0, 80) }] }); } catch (e) {}
  const px = (L && L.prefixes && L.prefixes[p]) ? L.prefixes[p] : null;
  return jr(200, { status: 'OK', updated_at: doc.updated_at, task: { id: t.id, who_id: '', who: '', who_by: 'notmine', notmine: t.notmine, updated: today }, signal: px ? { prefix: p, notmine: px.notmine, who_n: px.notmine_who_n, recard: px.recard } : null, request_id: R });
}
// ---- P1 판2(원장 T693·T364) 차량 지시 완료 창의 새 만기일 → 차량 한 줄의 한 칸만 고침(veh_due_set) ----
// 권한(둘 중 하나 — 나머지는 403 NO_WRITE, why로 갈래):
//   ① 차량 수행(permOf vehicles = do · 관리자 포함) — 그 지시 키가 가리키는 차량의 그 칸.
//   ② 지시 담당 — 세 조건 모두: 그 지시의 who_id = 로그인 회원 · 배정표(settings:assign)의 그 키 담당(가장 긴 접두어 — 지금 'veh:')도 그 회원 · 차량의 그 칸 지금 값 = 지시 키의 만료일
//      (그 지시가 다루는 그 날짜 칸 하나 — 다른 칸·다른 날짜로 이미 바뀐 칸은 못 고침).
//   근거: 지시 컬렉션 저장(save tasks)은 로그인 회원 누구나 되는 길이라(화면 canActTask만 — 서버 하드 보안 아님) who_id만 믿으면 아무나 자기를 담당으로 적고 차량 날짜를 고칠 수 있다.
//     배정표는 관리자(assign_set)와 봇 키(settings_apply target assign — v453, 감사 '설정적용' 1줄·updated_by 'bot:<표식>')만 고치고 감사가 남는 서버 설정이라 '담당'의 근거로 쓴다(why NOT_ASSIGNEE · NOT_ASSIGN_TABLE · DATE_MOVED). 배정표를 못 읽으면 빈 표 = ② 거절(fail-closed).
//     검토 S3: 봇 키를 가진 쪽(appdata 스크립트·Actions 비밀값)은 veh: 담당을 아무 재직 회원으로 바꿔 그 회원이 ② 갈래로 차량 만기일을 고치게 할 수 있다 — 봇 키는 신뢰 경계 안이라 받아들임.
//       막으려면 settings_apply assign에서 veh: 접두어를 빼거나 ② 갈래가 배정표 updated_by 'bot:'를 거절(정책 결정 — PM).
//   일반 저장(save vehicles)은 종전대로 veh do만 — 담당자에게 차량 문서 통째 쓰기를 열지 않고, 이 액션은 칸을 지시 키에서만 정한다(값으로 받지 않음).
//   알려진 한계: 배정표 차량 담당은 지시 줄을 손으로 꾸며(키를 다른 차·지금 날짜로) 다른 차의 같은 칸도 바꿀 수 있다 — 차량 갱신 담당의 몫 안이고 감사·버전 링에 남는다.
// 거절: 401 · 403 DEVICE_NOT_APPROVED · 404 NO_TASK(없음·지움) · 400 NOT_VEH_TASK(차량 자동 지시 키 꼴 아님 — 사람이 만든 지시) · 400 TASK_DONE · 403 NO_WRITE ·
//   400 BAD_DATE(달력에 없는 날·꼴 틀림·2000~2099 밖) · 404 NO_VEHICLE · 409 VEH_DUE_STALE(base_due가 지금 값과 다름 — 그 사이 누가 고침) · 400 NO_CHANGE(같은 날).
// 저장: 차량 문서를 읽어 그 줄의 그 칸·updated만 바꿔 씀(줄 단위 — 문서 통째 받지 않음) · 직전 문서 버전 링(verSnapshot) · 감사 1줄(col vehicles · op 수정 · f {칸: [이전, 새]} — 저장 감사와 같은 꼴, 되돌리기용 이전 값).
//   날짜를 지금보다 앞으로 넣는 것은 막지 않는다(앱이 확인 문구) · 차량 updated_at이 바뀌므로 다른 탭의 다음 차량 저장은 409 → 기존 병합 길.
//   검토 S1: 그 병합은 같은 날이면 로컬 줄이 이기므로(mergeVeh) 그 줄에 표식 due_set{칸: {prev, at}}을 남기고, 앱 vehDueMergeKeep·서버 vehDueGuard(save vehicles)가 표식을 모르는 사본의 '바꾸기 전 날짜'를 걸러 서버 값을 지킨다.
//   검토 S2: 버전 링 스냅샷 뒤 쓰기 직전 차량 문서를 다시 읽어, 그 사이 일반 저장이 끝났으면 새 문서에 적용(그 칸이 바뀌었으면 409).
const VEH_TASK_KEY_RE = new RegExp('^veh:(' + AUTOTASK_ID + '):(insp|ins):(' + AUTOTASK_DATE + ')(?::re:' + AUTOTASK_MONTH + ')?$');
// 검토 S1: 차량 저장(save vehicles)의 만기일 보호. veh_due_set은 그 줄에 표식 due_set{칸: {prev: 바꾸기 전 값, at: ms}}을 남긴다.
//   들어온 줄이 서버 줄의 표식을 모르고(at 다름·없음) 그 칸이 prev 그대로면(= 바꾸기 전 사본) 서버 값을 지킨다 · 다른 값이면 사람 편집이라 받음 · 표식은 늘 서버 것을 이어 감.
//   앱 mergeVeh의 vehDueMergeKeep와 같은 규칙(uismoke P1 판2 검토 대조). 알려진 한계: 낡은 사본으로 일부러 prev 날짜로 되돌리면 지켜진다(새로고침 뒤 고치면 됨). 반환 = 지킨 칸 수
function vehDueGuard(oldItems, items) {
  const oldById = {};
  (oldItems || []).forEach(function (o) { if (o && o.id && o.due_set && typeof o.due_set === 'object') oldById[o.id] = o; });
  const nz = function (s) { return s == null ? '' : String(s); };
  let n = 0;
  (items || []).forEach(function (t) {
    const o = (t && typeof t === 'object' && t.id) ? oldById[t.id] : null;
    if (!o) return;
    const ds = (t.due_set && typeof t.due_set === 'object') ? Object.assign({}, t.due_set) : {};
    ['insp_due', 'ins_due'].forEach(function (f) {
      const mk = o.due_set[f], tm = ds[f];
      if (!mk || typeof mk !== 'object' || (tm && tm.at === mk.at)) return;
      if (nz(t[f]) === nz(mk.prev) && nz(o[f]) !== nz(t[f])) { t[f] = o[f]; n++; }
      ds[f] = mk;
    });
    t.due_set = ds;
  });
  return n;
}
function vehDueDate(v) {   // 'YYYY-MM-DD'(달력에 있음 · 2000~2099) → 그 글 · 아니면 null
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v)) return null;
  const t = new Date(v + 'T00:00:00Z');
  return (!isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v) ? v : null;
}
async function handleVehDueSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const id = String(d.task_id || '').slice(0, 60); if (!id) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA);
  const rt = await blobGet(st, colKey('tasks'));
  if (!rt.ok && rt.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: rt.code || 'STORAGE_READ_FAILED', request_id: R });
  const t = (rt.ok && rt.data && Array.isArray(rt.data.items)) ? rt.data.items.find(function (x) { return x && x.id === id && x.del !== 1; }) : null;
  if (!t) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_TASK', request_id: R });
  const m = VEH_TASK_KEY_RE.exec(String(t.auto_key || ''));
  if (!m) return jr(400, { status: 'REJECTED', error_code: 'NOT_VEH_TASK', request_id: R });
  if (t.status === 'done') return jr(400, { status: 'REJECTED', error_code: 'TASK_DONE', request_id: R });
  const vehDo = permOf(c.member, 'vehicles') === 'do';
  if (!vehDo) {
    if (!(t.who_id && t.who_id === c.member.id)) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'NOT_ASSIGNEE', request_id: R });
    const ar = assignFor(t.auto_key, (await assignRead(st)).rules);
    if (!(ar && ar.who_id === c.member.id)) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'NOT_ASSIGN_TABLE', request_id: R });
  }
  const date = vehDueDate(d.date);
  if (!date) return jr(400, { status: 'REJECTED', error_code: 'BAD_DATE', request_id: R });
  const vid = m[1], field = AR.VEH_DUE_KIND[m[2]].f;
  const rv = await blobGet(st, colKey('vehicles'));
  if (!rv.ok && rv.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: rv.code || 'STORAGE_READ_FAILED', request_id: R });
  const doc = (rv.ok && rv.data && Array.isArray(rv.data.items)) ? rv.data : null;
  const v = doc ? doc.items.find(function (x) { return x && x.id === vid && x.del !== 1; }) : null;
  if (!v) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_VEHICLE', request_id: R });
  const cur = v[field] == null ? '' : String(v[field]);
  if (!vehDo && cur !== m[3]) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'DATE_MOVED', cur: cur, request_id: R });   // 담당 갈래는 그 지시의 그 날짜 칸만
  if (d.base_due !== undefined && String(d.base_due == null ? '' : d.base_due) !== cur) return jr(409, { status: 'CONFLICT', error_code: 'VEH_DUE_STALE', cur: cur, request_id: R });
  if (cur === date) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  await verSnapshot('vehicles', rv.data, c.member.name, false);
  // 검토 S2: 스냅샷(블롭 읽기·쓰기 여러 번) 사이에 끝난 일반 차량 저장을 덮지 않게 쓰기 직전 다시 읽는다 — 문서가 바뀌었으면 새 문서의 그 줄에 적용(그 칸이 그 사이 바뀌었으면 409 · 줄이 없어졌으면 404).
  //   조건부 쓰기가 없어 다시 읽기와 쓰기 사이 창은 남는다(handleSave와 같은 알려진 한계 — 창만 좁힘)
  let wdoc = doc, wv = v;
  const rv2 = await blobGet(st, colKey('vehicles'));
  if (!rv2.ok) return jr(500, { status: 'ERROR', error_code: rv2.code || 'STORAGE_READ_FAILED', request_id: R });
  if (Number((rv2.data && rv2.data.updated_at) || 0) !== Number(doc.updated_at || 0)) {
    wdoc = (rv2.data && Array.isArray(rv2.data.items)) ? rv2.data : null;
    wv = wdoc ? wdoc.items.find(function (x) { return x && x.id === vid && x.del !== 1; }) : null;
    if (!wv) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_VEHICLE', request_id: R });
    const cur2 = wv[field] == null ? '' : String(wv[field]);
    if (cur2 !== cur) return jr(409, { status: 'CONFLICT', error_code: 'VEH_DUE_STALE', cur: cur2, request_id: R });
  }
  const now = Date.now(), today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  wv[field] = date; wv.updated = today;
  wv.due_set = Object.assign({}, (wv.due_set && typeof wv.due_set === 'object') ? wv.due_set : {}); wv.due_set[field] = { prev: cur, at: now };   // 검토 S1: 낡은 사본 되돌림 보호 표식(vehDueGuard·앱 vehDueMergeKeep)
  const lawLog = (field === 'insp_due' && d.law && (await vehBgState(st)).on) ? vehLawLog(d.law, cur, date, today, c.member.id, 'task') : null;   // P1 판27: 법정 검사 제안이 켜진 앱이 보낸 제안 날짜와 확정 날짜(검사 칸만 · 승격일 때만 — 검토 반영, 못 읽으면 기록 안 함 · 표시 기록, 값 판정 없음)
  if (lawLog) wv.insp_log = (Array.isArray(wv.insp_log) ? wv.insp_log : []).concat([lawLog]).slice(-VEH_LOG_MAX);
  wdoc.updated_by = c.member.id; wdoc.updated_at = now;
  const w = await blobSet(st, colKey('vehicles'), wdoc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  const f = {}; f[field] = [cur, date];
  const au = await appendAudit({ ts: now, by: c.member.name, bid: c.member.id, col: 'vehicles', ev: [{ op: '수정', id: wv.id, t: String(wv.no || wv.id).slice(0, 40) + ' · 지시 완료 창(' + (vehDo ? '차량 수행' : '배정 담당') + ' · 지시 ' + t.id + ')', f: f }] });
  return jr(200, Object.assign({ status: 'OK', vehicle: { id: wv.id, field: field, value: date, prev: cur, updated: today }, updated_at: now, audit: au !== false, request_id: R }, lawLog ? { law_log: lawLog } : {}));   // P1 판27: 앱이 로컬 줄에도 같은 기록을 붙임(다음 통째 저장이 지우지 않게)
}
// ---- P1 판26·27(원장 T476·T451 · 시안 판3 ① · PM 11/13 18:14 '45. 판3 ㄱ') 차량 법정 검사 제안 ----
//   근거 표 bg:veh:law:v1(차량 법령 근거 — 판13 초안·11/20 승격 카드 ②)은 settings:veh.bg_ver 가 그 판 ver 와 같을 때만 '승격'(계약 bg:contract:law:v1 · settings:contract.bg_ver 와 같은 꼴).
//   승격 전·근거 없음·꼴 틀림 = on false → 앱은 제안 열·칩·기록을 그리지 않는다(종전 화면 그대로). 이 판은 읽기만 — 승격 스위치를 쓰는 길은 만들지 않았다(카드는 판 13·29 몫).
//   제안 계산은 앱(vehLawCalc — 표시만, 운영부 날짜 덮지 않음). 서버는 근거 표를 내려 주고, 지시 완료 창(veh_due_set)이 받은 제안·확정 날짜를 차량 줄 insp_log 에 남기기만 한다.
const VEH_BG_KEYS = { bg: 'bg:veh:law:v1', flag: 'settings:veh' };
const VEH_LOG_MAX = 12;   // 차량 한 줄의 검사 갱신 기록(insp_log) 최근 12개 — 앱 VEH_LOG_MAX 와 같은 값
function vehBgOk(x) { return !!(x && typeof x === 'object' && x.schema === 1 && typeof x.ver === 'string' && x.ver.length >= 2 && Array.isArray(x.rows) && typeof x.sha === 'string' && x.sha.length >= 8); }
// 갱신 기록 1줄 { at, prev, confirmed, proposed, rule, diff, by, src } — proposed '' = 그때 '기준 없음'(비교 불가 — 0으로 세지 않음). 꼴이 틀리면 null(기록 안 함 · 저장은 그대로)
function vehLawLog(law, prev, confirmed, today, by, src) {
  if (!law || typeof law !== 'object' || Array.isArray(law)) return null;
  const p = law.proposed == null ? '' : law.proposed;
  if (p !== '' && !vehDueDate(p)) return null;
  const rule = typeof law.rule === 'string' ? law.rule : '';
  if (rule.length > 60 || /[\u0000-\u001f\u007f]/.test(rule)) return null;
  const days = p ? Math.round((Date.parse(confirmed + 'T00:00:00Z') - Date.parse(p + 'T00:00:00Z')) / 86400000) : null;
  return { at: today, prev: prev || '', confirmed: confirmed, proposed: p, rule: p ? rule : '', diff: days, by: String(by || '').slice(0, 40), src: src };
}
// 승격 판정 한 곳(읽기·기록 같이 씀): 근거 표 꼴 맞음 ∧ settings:veh.bg_ver = 그 판 ver. 어느 쪽이든 못 읽으면 on false(기록 안 함 — fail-closed)
async function vehBgState(st) {
  let flag = null, bg = null;
  try { const rf = await blobGet(st, VEH_BG_KEYS.flag); if (rf.ok && rf.data && typeof rf.data === 'object') flag = rf.data; } catch (e) {}
  try { const rb = await blobGet(st, VEH_BG_KEYS.bg); if (rb.ok && rb.data) bg = rb.data; } catch (e) {}
  const ver = flag && typeof flag.bg_ver === 'string' ? flag.bg_ver : '';
  if (!vehBgOk(bg)) return { on: false, why: bg ? 'BAD_BG' : 'NO_BG' };
  if (!ver || ver !== bg.ver) return { on: false, why: 'NOT_PROMOTED' };
  return { on: true, bg: bg };
}
// P1 판27 검토: 차량 저장(save vehicles)이 서버 줄의 검사 갱신 기록을 지우지 않게 — 들어온 줄과 서버 줄의 insp_log 합집합(앱 mergeVeh와 같은 규칙 · vehDueGuard 바로 다음에 부름)
function vehLogUnion(a, b) {
  const seen = {}, out = [];
  [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : []).forEach(function (e) { if (!e || typeof e !== 'object') return; const k = [e.at, e.confirmed, e.src].join('|'); if (seen[k]) return; seen[k] = 1; out.push(e); });
  out.sort(function (p, q) { const x = String(p.at || ''), y = String(q.at || ''); return x < y ? -1 : (x > y ? 1 : 0); });
  return out.slice(-VEH_LOG_MAX);
}
function vehLogKeep(oldItems, items) {
  const oldById = {};
  (oldItems || []).forEach(function (o) { if (o && o.id && Array.isArray(o.insp_log) && o.insp_log.length) oldById[o.id] = o; });
  (items || []).forEach(function (t) { const o = (t && typeof t === 'object' && t.id) ? oldById[t.id] : null; if (o) t.insp_log = vehLogUnion(o.insp_log, t.insp_log); });
}
async function handleVehBgGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin && permOf(c.member, 'vehicles') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const s = await vehBgState(store(DATA));
  if (!s.on) return jr(200, { status: 'OK', on: false, why: s.why, request_id: R });
  const bg = s.bg;
  return jr(200, { status: 'OK', on: true, ver: bg.ver, rows: bg.rows.slice(0, 300), attr: (bg.attr && typeof bg.attr === 'object' && !Array.isArray(bg.attr)) ? bg.attr : null, request_id: R });
}
// ---- P1 판28(원장 T165·T179·T478 · 시안 판3 ② 'PM 11/13 18:14 45. 판3 ㄱ') 인허가 '이번 달' 탭 — 읽기 lic_month_get · 쓰기 lic_duty_set(단추 네 가지만) ----
// 원천: 자동 회차 행 = 인허가 근거 승격본 bg:lic:law:v1(status 'promoted')의 auto 행(주기 칸 — duty.js sched 꼴 그대로) · 완료 기록·기준일 = col:licenses duties[no] · 허가일 = col:licenses items.
//   계산 = _lib/duty.js dutyCur(앱 DUTY_SHARED 구간과 같은 본문). 이 탭은 의무 대장 문장·조문·주기 값을 바꾸지 않는다(읽어서 계산만).
// lic_duty_set 권한(나머지 403 NO_WRITE · why로 갈래): 관리자 = 전부(종전 의무 대장 저장 길도 그대로) · 관리자 아님 = 인허가 수행(lic do) + 그 행의 담당 —
//   배정표(settings:assign)에서 키 'lic:<허가증 id>:duty:<번호>'의 가장 긴 접두어(지금은 'lic:' 한 줄)의 담당 = 로그인 회원. 배정표를 못 읽으면 503 ASSIGN_UNAVAILABLE(fail-closed — 빈 표로 보지 않음),
//   줄이 없으면 NOT_ASSIGN_TABLE · 다른 사람이면 NOT_ASSIGNEE. [해당 없음 되돌리기](na_undo)는 관리자만(403 ADMIN_ONLY).
//   근거: 배정표는 관리자(assign_set)·봇 키(settings_apply)만 고치고 감사가 남는 서버 설정(v453 · 판2 veh_due_set과 같은 근거). 봇 키 쪽 한계도 판2 검토 S3과 같음.
// 허용 칸만: 본문 키 action·no·op·base·v 밖 = 400 BAD_FIELD · v 안은 op별 표(LIC_OPS) 밖 = 400 BAD_FIELD — 그 밖 칸(문장·주기·확정·선행확인 등)은 이 길로 못 바꾼다.
// 값: 날짜 = 'YYYY-MM-DD' 달력에 있는 날 2000~2099(BAD_DATE) · 제출한 날·기준일은 오늘(KST) 뒤 금지(BAD_FUTURE) · 사유 유형 6가지(BAD_REASON) · 글 길이(TOO_LONG) ·
//   완료는 접수번호나 수령본 하나 필수(NEED_PROOF) · 수령본 = att_put kind 'lic'로 올린 파일(본인 것 — 관리자는 누구 것이든, BAD_ATT) · 해당 없음 사유 필수(NEED_REASON).
// 낙관락: base = 그 행 updated_ts(없으면 0) — 다르거나 없으면 409 DUTY_STALE. 완료·정정은 그 회차(due = 계산 기한)가 지금 계산과 같아야(409 DUE_STALE).
// 저장: 그 행만(문서 통째 받지 않음) · 직전 값 lic_prev 1판(완료 기록·정정·해당 없음·기준일) + 버전 링(verSnapshot) · 감사 1줄(col licenses). 행을 지우는 길은 없다.
//   [해당 없음]은 na{on} 표식만(행·근거·완료 기록 그대로) — 관리자가 na_undo로 되돌림.
// 알려진 한계(판2와 같음): 읽기 → base 검사 → 쓰기가 원자적이지 않다(쓰기 직전 다시 읽어 창만 좁힘 — 조건부 쓰기 없음).
const LIC_BG_KEY = 'bg:lic:law:v1';
const LIC_OPS = { done: ['due', 'done_at', 'ref', 'att', 'memo'], fix: ['due', 'to', 'reason', 'memo'], na: ['reason'], base: ['date', 'what', 'memo'], na_undo: ['reason'] };
const LIC_TOP = { action: 1, no: 1, op: 1, base: 1, v: 1 };
const LIC_FIX_REASONS = ['기산일 오류', '유예 누락', '공고 연장', '대행 계약', '기관 통지', '기타'];   // 업무별 설계 3-8 A6 '사유 유형 필수' 6가지(시안 그대로)
const LIC_ATT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };   // 수령본 확장자 → mime 고정(보낸 mime은 쓰지 않음 — 문서함 DOC_ATT_MIME과 같은 원칙)
const LIC_NAR_FIELDS = ['runs', 'due_fix', 'na', 'lic_prev', 'nar_ts', 'base_what', 'base_by', 'base_at', 'base_memo'];   // lic_duty_set만 쓰는 칸
function licDutyKey(no, licId) { return 'lic:' + (licId || '-') + ':duty:' + no; }
function licKstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
// 관리자 통째 저장(save licenses)의 이월 — 단추 칸은 늘 서버 값(보낸 값은 버림). 기준일(base_date)은 관리자 선행확인 창도 쓰는 칸이라
//   서버 줄에 단추 표식(nar_ts)이 있고 들어온 줄 표식이 다르면(= 단추 저장을 모르는 사본) 서버 값을 지킨다. 반환 = 기준일을 지킨 행 번호 목록(저장 응답 lic_kept — 앱이 다시 읽고 알림, 검토 2)
//   행 updated_ts는 서버 값과 들어온 값 중 큰 쪽(낡은 사본이 행 시각을 되돌려 다음 단추 저장의 낙관락·병합 순서를 흐리지 않게 — 검토 5)
function licNarrowGuard(prevDuties, duties) {
  const old = {}; (prevDuties || []).forEach(function (o) { if (o && o.no != null) old[String(o.no)] = o; });
  const kept = [];
  (duties || []).forEach(function (t) {
    if (!t || typeof t !== 'object' || t.no == null) return;
    const o = old[String(t.no)];
    const stale = !!(o && o.nar_ts && t.nar_ts !== o.nar_ts);
    LIC_NAR_FIELDS.forEach(function (f) { if (o && o[f] !== undefined) t[f] = o[f]; else delete t[f]; });
    if (stale && String(t.base_date == null ? '' : t.base_date) !== String(o.base_date == null ? '' : o.base_date)) { if (o.base_date != null) t.base_date = o.base_date; else delete t.base_date; kept.push(Number(t.no)); }
    if (o && Number(o.updated_ts) > 0 && !(Number(t.updated_ts) >= Number(o.updated_ts))) t.updated_ts = Number(o.updated_ts);
  });
  return kept;
}
async function licBgRead(st) {   // 승격본만 — 승격 전·없음 = 행 0(빈 탭) · 못 읽음 = ok false
  try {
    const r = await blobGet(st, LIC_BG_KEY);
    if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, ver: '', rows: [] } : { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
    const b = r.data;
    if (!b || typeof b !== 'object' || b.status !== 'promoted' || !Array.isArray(b.rows)) return { ok: true, ver: '', rows: [] };
    return { ok: true, ver: String(b.ver || ''), rows: b.rows.filter(function (x) { return x && typeof x === 'object' && x.auto === true && Number.isInteger(Number(x.no)); }) };
  } catch (e) { return { ok: false, code: 'STORAGE_READ_FAILED' }; }
}
async function licAssignStrict(st) {   // 배정표 — 못 읽으면 ok false(빈 표로 보지 않음 · assignRead는 실패를 빈 표로 삼킨다)
  try {
    const r = await blobGet(st, ASSIGN_KEY);
    if (r.ok) return { ok: true, rules: (r.data && r.data.rules && typeof r.data.rules === 'object') ? r.data.rules : {} };
    return r.code === 'NOT_FOUND' ? { ok: true, rules: {} } : { ok: false };
  } catch (e) { return { ok: false }; }
}
// 단추 권한(lic_duty_set·att_put kind 'lic' 공용) — 관리자 또는 (lic do + 그 행 배정 담당). 반환 null = 통과 · 아니면 jr 응답
async function licDutyGate(st, member, br, R) {
  if (member.admin) return null;
  if (permOf(member, 'licenses') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'NO_LIC_DO', request_id: R });
  const as = await licAssignStrict(st);
  if (!as.ok) return jr(503, { status: 'ERROR', error_code: 'ASSIGN_UNAVAILABLE', request_id: R });
  const ar = assignFor(licDutyKey(Number(br.no), br.lic_id), as.rules);
  if (!ar || !ar.who_id) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'NOT_ASSIGN_TABLE', request_id: R });
  if (ar.who_id !== member.id) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'NOT_ASSIGNEE', request_id: R });
  return null;
}
function licBgOut(x) {   // 앱에 내리는 칸 — 주기 칸 + 표시 글(이름·인허가·주기 문장·배지·법령 이름)
  const ci = Array.isArray(x.cites) && x.cites[0] && typeof x.cites[0] === 'object' ? x.cites[0] : {};
  const o = { no: Number(x.no), duty: String(x.duty || ''), lic: String(x.lic || ''), lic_id: String(x.lic_id || ''), unit: String(x.unit || ''), cycle: String(x.cycle || ''), badge: String(x.badge || ''), law: String(ci.law || '') };
  ['type', 'every_n', 'every_unit', 'fixed_month', 'fixed_day', 'fixed2_month', 'fixed2_day', 'base', 'grace_days', 'auto', 'needs_manual_date'].forEach(function (k) { o[k] = x[k] === undefined ? null : x[k]; });
  return o;
}
async function handleLicMonthGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'licenses') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const st = store(DATA);
  const bg = await licBgRead(st);
  if (!bg.ok) return jr(500, { status: 'ERROR', error_code: 'BG_READ_FAILED', request_id: R });
  const as = await licAssignStrict(st);
  const ms = as.ok ? await assignMembers() : null;
  const gen = as.ok ? assignFor('lic:', as.rules) : null;   // 화면 안내 '담당 ○○(배정표)' — 행별 담당은 act로
  const act = [];
  bg.rows.forEach(function (x) {
    const no = Number(x.no);
    if (c.member.admin) { act.push(no); return; }
    if (!as.ok || permOf(c.member, 'licenses') !== 'do') return;
    const ar = assignFor(licDutyKey(no, x.lic_id), as.rules);
    if (ar && ar.who_id === c.member.id) act.push(no);
  });
  return jr(200, { status: 'OK', ver: bg.ver, rows: bg.rows.map(licBgOut), act: act, assign_ok: as.ok, who: gen && gen.who_id ? { id: gen.who_id, name: (ms && ms[gen.who_id] && ms[gen.who_id].name) || '' } : null, today: licKstToday(), request_id: R });
}
function licDateOk(v) { return vehDueDate(v); }
function licTextOk(v, n, need) {   // null = 틀림(꼴) · '' 허용(need 아니면) · 길이 넘침 = false
  if (v === undefined || v === null) return need ? null : '';
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > n) return false;
  if (need && !s) return null;
  return s;
}
async function handleLicDutySet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const op = String(d.op || '');
  if (!hasOwn(LIC_OPS, op)) return jr(400, { status: 'REJECTED', error_code: 'BAD_OP', request_id: R });
  const no = Number(d.no);
  if (!Number.isInteger(no) || no < 1 || no > 9999) return jr(400, { status: 'REJECTED', error_code: 'BAD_NO', request_id: R });
  if (op === 'na_undo' && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const bg = await licBgRead(st);
  if (!bg.ok) return jr(500, { status: 'ERROR', error_code: 'BG_READ_FAILED', request_id: R });
  const br = bg.rows.find(function (x) { return Number(x.no) === no; });
  if (!br) return jr(400, { status: 'REJECTED', error_code: 'NOT_AUTO', request_id: R });   // 승격본 자동 회차 행이 아님(사건형·상시·개인·차량 — 의무 대장에서만)
  const gate = await licDutyGate(st, c.member, br, R);
  if (gate) return gate;
  // 허용 칸만
  const badTop = Object.keys(d).filter(function (k) { return !hasOwn(LIC_TOP, k); });
  const v = (d.v && typeof d.v === 'object' && !Array.isArray(d.v)) ? d.v : null;
  if (badTop.length || !v) return jr(400, { status: 'REJECTED', error_code: 'BAD_FIELD', field: badTop.length ? String(badTop[0]).slice(0, 40) : 'v', request_id: R });
  const badV = Object.keys(v).filter(function (k) { return LIC_OPS[op].indexOf(k) < 0; });
  if (badV.length) return jr(400, { status: 'REJECTED', error_code: 'BAD_FIELD', field: String(badV[0]).slice(0, 40), request_id: R });
  // 값 검사(꼴)
  const today = licKstToday(), bad = function (code) { return jr(400, { status: 'REJECTED', error_code: code, request_id: R }); };
  const val = {};
  const txt = function (k, n, need) { const s = licTextOk(v[k], n, need); if (s === false) return 'TOO_LONG'; if (s === null) return need ? (k === 'reason' && op !== 'fix' ? 'NEED_REASON' : 'BAD_VALUE') : 'BAD_VALUE'; val[k] = s; return ''; };
  let e = '';
  if (op === 'done') {
    if (!(val.due = licDateOk(v.due))) return bad('BAD_DATE');
    if (!(val.done_at = licDateOk(v.done_at))) return bad('BAD_DATE');
    if (val.done_at > today) return bad('BAD_FUTURE');
    if ((e = txt('ref', 60, false)) || (e = txt('memo', 200, false))) return bad(e);
    if (v.att !== undefined && v.att !== null && v.att !== '') { if (typeof v.att !== 'string' || !/^att_[a-f0-9]{16}$/.test(v.att)) return bad('BAD_ATT'); val.att = v.att; }
    if (!val.ref && !val.att) return bad('NEED_PROOF');
  } else if (op === 'fix') {
    if (!(val.due = licDateOk(v.due)) || !(val.to = licDateOk(v.to))) return bad('BAD_DATE');
    if (typeof v.reason !== 'string' || LIC_FIX_REASONS.indexOf(v.reason) < 0) return bad('BAD_REASON');
    val.reason = v.reason;
    if ((e = txt('memo', 200, false))) return bad(e);
  } else if (op === 'na' || op === 'na_undo') {
    if ((e = txt('reason', 200, op === 'na'))) return bad(e);
  } else if (op === 'base') {
    if (!(val.date = licDateOk(v.date))) return bad('BAD_DATE');
    if (val.date > today) return bad('BAD_FUTURE');
    if ((e = txt('what', 40, false)) || (e = txt('memo', 200, false))) return bad(e);
  }
  // 읽기 · 낙관락 · 상태
  const rl = await blobGet(st, colKey('licenses'));
  if (!rl.ok && rl.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: rl.code || 'STORAGE_READ_FAILED', request_id: R });
  const doc = (rl.ok && rl.data && Array.isArray(rl.data.duties)) ? rl.data : null;
  const row = doc ? doc.duties.find(function (x) { return x && Number(x.no) === no; }) : null;
  if (!row) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_DUTY', request_id: R });
  const baseTs = Number(row.updated_ts || 0);
  if (d.base === undefined || d.base === null || Number(d.base) !== baseTs) return jr(409, { status: 'CONFLICT', error_code: 'DUTY_STALE', cur: baseTs, request_id: R });
  const lic = (Array.isArray(doc.items) ? doc.items : []).find(function (x) { return x && x.id === br.lic_id && x.del !== 1; }) || null;
  const merged = Object.assign({}, row, { sched: br });
  const isNa = !!(row.na && row.na.on);
  if (op === 'na_undo') { if (!isNa) return bad('NO_CHANGE'); }
  else if (isNa) return bad('IS_NA');
  let cur = null;
  if (op === 'done' || op === 'fix') {
    cur = DUTY.dutyCur(merged, lic, today);
    if (!cur || !cur.due) return bad('NO_DUE');   // 기준일 없음 — [기준일 입력]부터
    if (val.due !== cur.orig) return jr(409, { status: 'CONFLICT', error_code: 'DUE_STALE', cur: cur.orig, request_id: R });
    if (op === 'fix' && val.to === cur.due) return bad('NO_CHANGE');
    // 검토 3(조정 담당이 정한 안전 기본값): 정정 날짜 = 계산 기한 앞뒤 1년 안 · 제출일 = 그 회차 기한 1년 전 이후(오늘 뒤는 위 BAD_FUTURE)
    //   — 2099로 정정해 행이 탭에서 사라지거나, 2000년 제출일로 다음 회차가 2001년이 되는 것을 막음(앱 lmRangeWhy와 같은 값)
    if (op === 'fix' && (val.to < DUTY.dutyAddMonths(cur.orig, -12) || val.to > DUTY.dutyAddMonths(cur.orig, 12))) return jr(400, { status: 'REJECTED', error_code: 'BAD_RANGE', from: DUTY.dutyAddMonths(cur.orig, -12), to: DUTY.dutyAddMonths(cur.orig, 12), request_id: R });
    if (op === 'done' && val.done_at < DUTY.dutyAddMonths(cur.orig, -12)) return jr(400, { status: 'REJECTED', error_code: 'BAD_RANGE', from: DUTY.dutyAddMonths(cur.orig, -12), to: today, request_id: R });
  }
  if (op === 'base') {
    if (String(row.base_date || '') === val.date) return bad('NO_CHANGE');
    if (!c.member.admin) { const cb = DUTY.dutyCur(merged, lic, today); if (!(cb && cb.missing === 'base')) return bad('NOT_NEEDED'); }   // 담당은 기준일 없는 행만(시안 — 그 밖 행은 [기한 정정])
  }
  if (val.att) {
    let fa = null; try { fa = await blobGet(store(FILES), val.att); } catch (e2) { fa = null; }
    if (!fa || !fa.ok || !fa.data || fa.data.kind !== 'lic' || Number(fa.data.no) !== no || (!c.member.admin && fa.data.bid !== c.member.id)) return bad('BAD_ATT');
  }
  // 저장 — 버전 링 뒤 다시 읽어 그 사이 저장을 덮지 않게(판2 veh_due_set 검토 S2와 같은 꼴)
  await verSnapshot('licenses', rl.data, c.member.name, false);
  let wdoc = doc, wrow = row;
  const rl2 = await blobGet(st, colKey('licenses'));
  if (!rl2.ok) return jr(500, { status: 'ERROR', error_code: rl2.code || 'STORAGE_READ_FAILED', request_id: R });
  if (Number((rl2.data && rl2.data.updated_at) || 0) !== Number(doc.updated_at || 0)) {
    wdoc = (rl2.data && Array.isArray(rl2.data.duties)) ? rl2.data : null;
    wrow = wdoc ? wdoc.duties.find(function (x) { return x && Number(x.no) === no; }) : null;
    if (!wrow) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_DUTY', request_id: R });
    if (Number(wrow.updated_ts || 0) !== baseTs) return jr(409, { status: 'CONFLICT', error_code: 'DUTY_STALE', cur: Number(wrow.updated_ts || 0), request_id: R });
  }
  const now = Date.now(), me = c.member.id, cp = function (x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); };
  const prev = { at: now, by: me, op: op, runs: cp(wrow.runs), due_fix: cp(wrow.due_fix), na: cp(wrow.na), base_date: wrow.base_date == null ? null : wrow.base_date, base_what: wrow.base_what == null ? null : wrow.base_what };
  const nRuns = Array.isArray(wrow.runs) ? wrow.runs.length : 0;
  const head = no + '. ' + String(br.duty || wrow.duty || '').slice(0, 40);
  let ev;
  if (op === 'done') {
    const run = { due: cur.orig, done_at: val.done_at, by: me, by_name: c.member.name, ts: now };
    if (val.ref) run.ref = val.ref;
    if (val.att) run.att = val.att;
    if (val.memo) run.memo = val.memo;
    if (cur.fixed) run.due_fixed = cur.due;
    wrow.runs = (Array.isArray(wrow.runs) ? wrow.runs.slice() : []).concat([run]);
    ev = { op: '의무완료', id: 'duty:' + no, t: head + ' · ' + cur.orig + ' 회차 완료(제출 ' + val.done_at + (val.ref ? ' · 접수번호' : '') + (val.att ? ' · 수령본' : '') + ')', f: { runs: [nRuns + '건', (nRuns + 1) + '건'] } };
  } else if (op === 'fix') {
    const fm = (wrow.due_fix && typeof wrow.due_fix === 'object' && !Array.isArray(wrow.due_fix)) ? Object.assign({}, wrow.due_fix) : {};
    fm[cur.orig] = { to: val.to, from: cur.due, days: DUTY.dutyDiffDays(val.to, cur.orig), reason: val.reason, memo: val.memo || '', by: me, by_name: c.member.name, at: now };
    wrow.due_fix = fm;
    ev = { op: '기한정정', id: 'duty:' + no, t: head + ' · ' + cur.orig + ' 회차 · ' + val.reason + ' · ' + fm[cur.orig].days + '일', f: { due: [cur.due, val.to] } };
  } else if (op === 'na') {
    wrow.na = { on: true, reason: val.reason, by: me, by_name: c.member.name, at: now };
    ev = { op: '해당없음', id: 'duty:' + no, t: head + ' · ' + val.reason.slice(0, 80), f: { na: ['켜짐', '꺼짐'] } };
  } else if (op === 'na_undo') {
    wrow.na = { on: false, reason: val.reason || '', by: me, by_name: c.member.name, at: now };
    ev = { op: '해당없음되돌림', id: 'duty:' + no, t: head, f: { na: ['꺼짐', '켜짐'] } };
  } else {
    wrow.base_date = val.date; wrow.base_what = val.what || ''; wrow.base_by = me; wrow.base_at = now;
    if (val.memo) wrow.base_memo = val.memo; else delete wrow.base_memo;
    ev = { op: '기준일', id: 'duty:' + no, t: head + (val.what ? ' · ' + val.what : ''), f: { base_date: [prev.base_date || '', val.date] } };
  }
  wrow.lic_prev = prev; wrow.nar_ts = now; wrow.updated = today; wrow.updated_ts = now;
  wdoc.updated_by = me; wdoc.updated_at = now;
  const w = await blobSet(st, colKey('licenses'), wdoc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  let lau = false; try { lau = await appendAudit({ ts: now, by: c.member.name, bid: me, col: 'licenses', ev: [ev] }); } catch (e3) { lau = false; }
  const out = { no: no };
  ['runs', 'due_fix', 'na', 'base_date', 'base_what', 'base_by', 'base_at', 'base_memo', 'lic_prev', 'nar_ts', 'updated', 'updated_ts'].forEach(function (k) { if (wrow[k] !== undefined) out[k] = wrow[k]; });
  return jr(200, { status: 'OK', duty: out, updated_at: now, audit: lau !== false, request_id: R });
}
// 수령본 내용 검사(검토 6) — 파일 앞머리(PDF '%PDF-' · JPEG FF D8 FF · PNG 89 50 4E 47 0D 0A 1A 0A)가 확장자와 맞고, 풀어낸 크기가 LIC_ATT_MIN 바이트 이상
const LIC_ATT_MIN = 100;
function licAttMagicOk(ext, b64) {
  let head, size;
  try { const s = String(b64).replace(/[\r\n]/g, ''); head = Buffer.from(s.slice(0, 24), 'base64'); size = Math.floor(s.length * 3 / 4) - (s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0)); } catch (e) { return false; }
  if (!(size >= LIC_ATT_MIN)) return false;
  const h = function (arr) { return arr.every(function (b, i) { return head[i] === b; }); };
  if (ext === 'pdf') return h([0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (ext === 'jpg' || ext === 'jpeg') return h([0xff, 0xd8, 0xff]);
  if (ext === 'png') return h([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return false;
}
// 수령본 올리기 — 계약 첨부와 같은 저장소·같은 액션(att_put)의 좁은 갈래(kind 'lic'). 권한 = 단추와 같은 licDutyGate(그 행 번호 no) · pdf·jpg·jpeg·png만 · 6MB(base64) · 지우는 길 없음(att_del 거절).
async function handleLicAttPut(event, d, R, c) {
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const no = Number(d.no);
  if (!Number.isInteger(no) || no < 1 || no > 9999) return jr(400, { status: 'REJECTED', error_code: 'BAD_NO', request_id: R });
  const st = store(DATA);
  const bg = await licBgRead(st);
  if (!bg.ok) return jr(500, { status: 'ERROR', error_code: 'BG_READ_FAILED', request_id: R });
  const br = bg.rows.find(function (x) { return Number(x.no) === no; });
  if (!br) return jr(400, { status: 'REJECTED', error_code: 'NOT_AUTO', request_id: R });
  const gate = await licDutyGate(st, c.member, br, R);
  if (gate) return gate;
  const name = String(d.name || '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 120);
  const ext = (name.toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
  if (!hasOwn(LIC_ATT_MIME, ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', request_id: R });
  const b64 = typeof d.data === 'string' ? d.data : '';
  if (!b64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  if (b64.length > DOC_ATT_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', request_id: R });
  if (!licAttMagicOk(ext, b64)) return jr(400, { status: 'REJECTED', error_code: 'BAD_FILE', request_id: R });   // 검토 6: 앞머리가 확장자와 맞고 최소 크기 이상만
  const id = 'att_' + crypto.randomBytes(8).toString('hex');
  const w = await blobSet(store(FILES), id, { name: name, type: LIC_ATT_MIME[ext], kind: 'lic', no: no, data: b64, by: c.member.name, bid: c.member.id, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '첨부등록', id: id, t: '인허가 ' + no + '행 수령본 · ' + name.slice(0, 50) }] }); } catch (e) {}
  return jr(200, { status: 'OK', id: id, name: name, size: b64.length, request_id: R });
}
// ---- 배정표 settings:assign (v395 — 공통 기반 1 첫 시범. 업무별 최적화 설계 3-14 appr A1 · 착수 브리핑 A2) ----
// 자동 지시(auto_key 접두어 veh:·lic:·cert:·rec:·bid:) → 담당 who_id. 기본표 = 빈 표: 배정 없는 접두어는 '담당 없음' 배지(관리자 폴백 금지).
// 서버가 채운 담당은 who_by='assign' — 클라 사본이 공란으로 올려도 handleSave가 이월한다(기반 9). 사람이 지정한 who_id는 건드리지 않는다.
// 변경 전 표는 prev에 1판 보존(R1 되돌리기 1클릭). 변경은 관리자만·감사로그·낙관락(등급표 패턴). 승인권자 1인(approver_id)은 저장만(승인 라우팅 연결은 A5 done_if 때).
const ASSIGN_KEY = 'settings:assign';
const ASSIGN_PREFIXES = { 'veh:': '차량 만기(정기검사·보험)', 'lic:': '인허가 만기·보수교육', 'cert:': '증명서 갱신(20일 주기)', 'rec:': '미수 장기화(45일)', 'bid:': '적격심사 검토',
  'site:': '현장 대장 미입력(월 1회)', 'wk:': '일용직 인적사항 미입력(월 1회)' };   // v417 카드 10 공통 바탕 ④ — site:·wk: 행 추가(담당은 결정 2, R1 D-3 뒤)
function assignEmpty() { return { schema: 1, rules: {}, approver_id: '', prev: null, updated_at: 0, updated_by: '' }; }
async function assignRead(st) {
  try { const r = await blobGet(st, ASSIGN_KEY); if (r.ok && r.data && r.data.rules && typeof r.data.rules === 'object') return Object.assign(assignEmpty(), r.data); } catch (e) {}
  return assignEmpty();
}
function assignFor(autoKey, rules) {   // 가장 긴 접두어 일치
  const k = String(autoKey || ''); let best = null;
  Object.keys(rules || {}).forEach(function (p) { if (k.indexOf(p) === 0 && (!best || p.length > best.length)) best = p; });
  return best ? rules[best] : null;
}
function assignFill(items, rules, names) {   // 공란(who_id '')인 자동 지시만 채움. 바뀐 수 반환
  let n = 0;
  (items || []).forEach(function (t) {
    if (!t || !t.auto_key || t.who_id || t.del === 1 || t.status === 'done') return;
    const r = assignFor(t.auto_key, rules); if (!r || !r.who_id) return;
    if (t.who_by === 'notmine' && t.notmine && r.who_id === t.notmine.prev) return;   // v413 [내 것 아님]은 같은 사람으로 되채우지 않음(배정표가 바뀌면 채움)
    t.who_id = r.who_id; t.who = names[r.who_id] || t.who || ''; t.who_by = 'assign'; n++;
  });
  return n;
}
async function assignMembers() {   // 재직 회원 id → {name}. 명부를 못 읽으면 null(저장은 fail-closed, 채움은 건너뜀)
  try { const tc = await push.tierCtx(); if (!tc || tc.unavailable) return null; const o = {}; (tc.members || []).forEach(function (m) { if (m && m.id) o[m.id] = { name: m.name || '' }; }); return o; } catch (e) { return null; }
}
function assignNames(members) { const o = {}; Object.keys(members || {}).forEach(function (id) { o[id] = members[id].name || ''; }); return o; }
async function handleAssignGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const a = await assignRead(store(DATA));
  const ls = await apprLessonsRead(store(DATA));   // v413 이달 delta(내 것 아님·담당/기한 변경·재카드 신호)
  return jr(200, { status: 'OK', rules: a.rules, approver_id: a.approver_id || '', prefixes: ASSIGN_PREFIXES, lessons: ls ? { ym: ls.ym, prefixes: ls.prefixes, rules: ls.rules } : null,
    prev: a.prev ? { updated_at: a.prev.updated_at || 0, updated_by: a.prev.updated_by || '' } : null,
    updated_at: a.updated_at || 0, updated_by: a.updated_by || '', request_id: R });
}
async function handleAssignSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const hasPrefix = d.prefix !== undefined, hasApv = d.approver_id !== undefined;
  if (!hasPrefix && !hasApv) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const st = store(DATA);
  const a = await assignRead(st);
  if (d.base !== undefined && Number(d.base) !== Number(a.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'ASSIGN_STALE', request_id: R });
  const members = await assignMembers();
  if (!members) return jr(503, { status: 'ERROR', error_code: 'MEMBERS_UNAVAILABLE', request_id: R });   // 명부 없이 저장하면 퇴사자·오타 id가 배정될 수 있다 → 거부
  const okId = function (id) { return id === '' || Object.prototype.hasOwnProperty.call(members, id); };
  const nm = function (id) { return id ? ((members[id] || {}).name || id) : ''; };
  const next = JSON.parse(JSON.stringify(a.rules || {})); let apv = a.approver_id || ''; const evs = [];
  if (hasPrefix) {
    const p = String(d.prefix || '');
    if (!Object.prototype.hasOwnProperty.call(ASSIGN_PREFIXES, p)) return jr(400, { status: 'REJECTED', error_code: 'BAD_PREFIX', request_id: R });
    const who = String(d.who_id || '').slice(0, 40);
    if (!okId(who)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MEMBER', request_id: R });
    const before = (next[p] || {}).who_id || '';
    if (who) next[p] = { who_id: who }; else delete next[p];
    evs.push({ op: '배정변경', id: p, t: ASSIGN_PREFIXES[p] + ' ' + (nm(before) || '없음') + '→' + (nm(who) || '없음') });
  }
  if (hasApv) {
    const w = String(d.approver_id || '').slice(0, 40);
    if (!okId(w)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MEMBER', request_id: R });
    evs.push({ op: '배정변경', id: 'approver', t: '자동 지시 승인권자 ' + (nm(apv) || '관리자 전원') + '→' + (nm(w) || '관리자 전원') });
    apv = w;
  }
  const doc = { schema: 1, rules: next, approver_id: apv, prev: { rules: a.rules || {}, approver_id: a.approver_id || '', updated_at: a.updated_at || 0, updated_by: a.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, ASSIGN_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: evs }); } catch (e) {}
  return jr(200, { status: 'OK', rules: next, approver_id: apv, updated_at: doc.updated_at, request_id: R });
}
async function handleAssignRevert(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const a = await assignRead(st);
  if (!a.prev) return jr(400, { status: 'REJECTED', error_code: 'NO_PREV', request_id: R });
  if (d.base !== undefined && Number(d.base) !== Number(a.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'ASSIGN_STALE', request_id: R });
  const doc = { schema: 1, rules: a.prev.rules || {}, approver_id: a.prev.approver_id || '', prev: { rules: a.rules || {}, approver_id: a.approver_id || '', updated_at: a.updated_at || 0, updated_by: a.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, ASSIGN_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '배정되돌림', id: '', t: '배정표 직전 판으로' }] }); } catch (e) {}
  return jr(200, { status: 'OK', rules: doc.rules, approver_id: doc.approver_id, updated_at: doc.updated_at, request_id: R });
}
// ---- 알림 설정 settings:notify (v396 — 공통 기반 3 첫 시범. 착수 브리핑 A3 · 카드 1-4 R1) ----
// 지시 이벤트 3종의 수신자·방식을 설정값으로. 기본값(블롭 없음) = 현행(관리자 전원·생성 때마다). R1: D-3 예고 뒤 추천값 적용, prev 1판·되돌리기 1클릭.
//  task_auto_create: 자동 지시 생성 → admins(현행, 클라 push_send __admins__) | assignee(담당자 본인 1발·우선기기, 서버가 save·ingest 때 발송, 클라 관리자 푸시는 서버가 삼킴 — 단 전환 뒤 첫 7일은 관리자 병행, v437 notifyParallelOn)
//  task_review: 완료 요청 → admins(현행: 지시자 없으면 관리자 전원) | issuer_approver(지시자 · 자동 지시는 배정표 승인권자 1인)
//  due_digest: 만기 임박 → each(현행: 생성 때마다 관리자 전원) | summary(아침 크론 요약 1줄 — 승인권자 1인, 없으면 관리자)
const NOTIFY_KEY = 'settings:notify';
const NOTIFY_EVENTS = {
  task_auto_create: { label: '자동 지시 생성 알림', options: { admins: '관리자 전원(현행)', assignee: '담당자 본인 1발(우선기기)' }, def: 'admins', rec: 'assignee' },
  task_review: { label: '완료 요청(승인 대기) 알림', options: { admins: '지시자, 없으면 관리자 전원(현행)', issuer_approver: '지시자 · 자동 지시는 배정 승인권자 1인' }, def: 'admins', rec: 'issuer_approver' },
  due_digest: { label: '만기 임박 알림 방식', options: { each: '생성 때마다 관리자 전원(현행)', summary: '아침 요약 1줄(승인권자 1인, 없으면 관리자)' }, def: 'each', rec: 'summary' },
  // v414 C3-1 휴가 2종 — 그룹웨어규정 §11②·결재규정 §11③(신청·결과 통지)에 맞추는 것이라 기본값=켬(R0 규정 정합). 끄는 선택만 둔다.
  leave_request: { label: '휴가 신청 알림', options: { admins: '승인자(관리자) 우선기기 1발', off: '없음(종전)' }, def: 'admins', rec: 'admins' },
  leave_result: { label: '휴가 승인·반려 알림', options: { applicant: '신청자 본인 1발', off: '없음(종전)' }, def: 'applicant', rec: 'applicant' },
  // v415 C3-2 입찰 2종(설계 3-1 안착 ③: 개찰 전건 관리자 푸시 → 낙찰·수집 실패만 즉시, 나머지 아침 요약). 기본=현행, 추천=★(R1 D-3 → 11/4 적용 예약). 게이트 잠금 위반 알림은 C6(변경등록 게이트) 뒤.
  bid_result: { label: '개찰 결과 알림', options: { each: '개찰 결과마다 관리자 전원(현행)', award: '낙찰만 즉시(입찰 담당+PM 우선기기) · 유찰은 아침 요약' }, def: 'each', rec: 'award' },
  bid_fail: { label: '입찰 수집 실패 경보 수신', options: { admins: '관리자 전원(현행)', assignee: '입찰 담당 + 관리자' }, def: 'admins', rec: 'assignee' },
};
function notifyDefaults() { const o = {}; Object.keys(NOTIFY_EVENTS).forEach(function (k) { o[k] = NOTIFY_EVENTS[k].def; }); return o; }
function notifyValid(k, v) { return Object.prototype.hasOwnProperty.call(NOTIFY_EVENTS, k) && Object.prototype.hasOwnProperty.call(NOTIFY_EVENTS[k].options, String(v)); }
async function notifyRead(st) {
  try {
    const r = await blobGet(st, NOTIFY_KEY);
    if (r.ok && r.data && r.data.events && typeof r.data.events === 'object') {
      const ev = notifyDefaults();
      Object.keys(r.data.events).forEach(function (k) { if (notifyValid(k, r.data.events[k])) ev[k] = r.data.events[k]; });
      return { events: ev, prev: r.data.prev || null, updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '' };
    }
  } catch (e) {}
  return { events: notifyDefaults(), prev: null, updated_at: 0, updated_by: '' };
}
// v437 자동 지시 생성 알림 '담당자 본인' 전환 뒤 첫 7일 관리자 병행 — 판정 한 곳(게이트 ③ '1주 병행' · 브리핑 §7 '첫 1주 PM 병행').
//   봇 경로 handleBotNotify(태그 auto-due '정기업무 n건')와 앱 경로 handlePushSend(__admins__ · 태그 auto-due·rec-over·bid-qual)가 이 함수 하나를 같이 쓴다:
//   task_auto_create가 assignee여도 병행 중이면 관리자 전원 푸시를 삼키지 않고, 병행이 끝나면 삼킨다. 담당자 1발(notifyAutoCreated — save·ingest)은 병행과 상관없이 나간다.
//   기준 = settings:notify의 updated_at(설정을 마지막으로 저장한 시각): 지금 − updated_at ≤ 7일이면 병행 중. updated_at이 없거나 0이면 병행 끝(종전 봇 경로와 같음).
//   알려진 한계: updated_at은 칸별 시각이 아니라 settings:notify 한 벌의 시각이라 다른 칸(완료 요청·만기 임박·휴가·개찰·수집 실패)을 바꾸거나 되돌려도 새로 찍혀
//   병행 7일이 다시 시작된다(봇 경로도 같은 동작 — 칸별 시각은 v437 범위 밖).
const NOTIFY_PARALLEL_MS = 7 * 86400000;
function notifyParallelOn(nf) { return (Date.now() - Number((nf && nf.updated_at) || 0)) <= NOTIFY_PARALLEL_MS; }
function notifyPublic(nf) {
  const meta = {}; Object.keys(NOTIFY_EVENTS).forEach(function (k) { meta[k] = { label: NOTIFY_EVENTS[k].label, options: NOTIFY_EVENTS[k].options, def: NOTIFY_EVENTS[k].def, rec: NOTIFY_EVENTS[k].rec }; });
  return { events: nf.events, meta: meta, prev: nf.prev ? { updated_at: nf.prev.updated_at || 0, updated_by: nf.prev.updated_by || '' } : null, updated_at: nf.updated_at || 0, updated_by: nf.updated_by || '' };
}
async function handleNotifyGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const nf = await notifyRead(store(DATA));
  return jr(200, Object.assign({ status: 'OK', request_id: R }, notifyPublic(nf)));
}
async function handleNotifySet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const k = String(d.event || ''), v = String(d.value || '');
  if (!notifyValid(k, v)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EVENT', request_id: R });
  const st = store(DATA);
  const nf = await notifyRead(st);
  if (d.base !== undefined && Number(d.base) !== Number(nf.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'NOTIFY_STALE', request_id: R });
  if (nf.events[k] === v) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const next = Object.assign({}, nf.events); next[k] = v;
  const doc = { schema: 1, events: next, prev: { events: nf.events, updated_at: nf.updated_at || 0, updated_by: nf.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, NOTIFY_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '알림변경', id: k, t: NOTIFY_EVENTS[k].label + ' ' + (NOTIFY_EVENTS[k].options[nf.events[k]] || nf.events[k]) + '→' + NOTIFY_EVENTS[k].options[v] }] }); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, notifyPublic({ events: next, prev: doc.prev, updated_at: doc.updated_at, updated_by: doc.updated_by })));
}
async function handleNotifyRevert(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const nf = await notifyRead(st);
  if (!nf.prev || !nf.prev.events) return jr(400, { status: 'REJECTED', error_code: 'NO_PREV', request_id: R });
  if (d.base !== undefined && Number(d.base) !== Number(nf.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'NOTIFY_STALE', request_id: R });
  const ev = notifyDefaults(); Object.keys(nf.prev.events).forEach(function (k) { if (notifyValid(k, nf.prev.events[k])) ev[k] = nf.prev.events[k]; });
  const doc = { schema: 1, events: ev, prev: { events: nf.events, updated_at: nf.updated_at || 0, updated_by: nf.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, NOTIFY_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '알림되돌림', id: '', t: '알림 설정 직전 판으로' }] }); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, notifyPublic({ events: ev, prev: doc.prev, updated_at: doc.updated_at, updated_by: doc.updated_by })));
}
// 자동 지시 생성·배정 → 담당자 본인 1발(우선기기). save·ingest 공용. 담당 없는 항목은 발송 없음(배지만). 같은 사람은 하루 한 묶음(tag로 치환).
// v414 휴가 신청·결과 알림(C3-1). 본문에 사유·기간을 싣지 않는다(알림함 이력은 관리자 전원이 본다 — §14③ 사적 내용 금지). 반환 {req, res}=발송 수신자 수.
async function notifyLeaves(st, oldItems, newItems, member) {
  const nf = await notifyRead(st); const out = { req: 0, res: 0 };
  const oldBy = {}; (oldItems || []).forEach(function (o) { if (o && o.id) oldBy[o.id] = o; });
  const fresh = (newItems || []).filter(function (x) { return x && x.id && x.status === 'pending' && x.del !== 1 && !oldBy[x.id]; });
  const decided = (newItems || []).filter(function (x) { const o = x && x.id && oldBy[x.id]; return o && o.status === 'pending' && (x.status === 'approved' || x.status === 'rejected') && x.member_id; });
  if (!fresh.length && !decided.length) return out;
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const tc = await push.tierCtx();
  if (nf.events.leave_request === 'admins' && fresh.length) {
    const to = ((tc && tc.adminIds) || []).filter(function (id) { return id !== (member && member.id); });
    if (to.length) { const names = fresh.map(function (x) { return String(x.member_name || '').slice(0, 10); }).filter(Boolean); await push.sendTo(to, { title: '휴가 신청 ' + fresh.length + '건', body: (names.slice(0, 3).join(' · ') || '신청') + ' — 휴가 탭 승인 대기', url: './', tag: 'leave-req-' + today }, { ctx: tc, primaryOnly: true, by: (member && member.name) || '' }); out.req = to.length; }
  }
  if (nf.events.leave_result === 'applicant' && decided.length) {
    for (const x of decided) { try { await push.sendTo([String(x.member_id)], { title: '휴가 ' + (x.status === 'approved' ? '승인됨' : '반려됨'), body: '휴가 탭에서 확인하세요.', url: './', tag: 'leave-res-' + x.id }, { ctx: tc, primaryOnly: true, by: (member && member.name) || '' }); out.res++; } catch (e) {} }
  }
  return out;
}
async function notifyAutoCreated(st, items, by) {
  try {
    const nf = await notifyRead(st); if (nf.events.task_auto_create !== 'assignee') return 0;
    const byWho = {};
    (items || []).forEach(function (t) { if (t && t.who_id && t.who_id !== '__all__' && t.del !== 1 && t.status !== 'done') (byWho[t.who_id] = byWho[t.who_id] || []).push(t); });
    const whos = Object.keys(byWho); if (!whos.length) return 0;
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const tc = await push.tierCtx();
    let n = 0;
    for (const who of whos) {
      const list = byWho[who];
      const body = list.slice(0, 3).map(function (t) { return String(t.title || '').slice(0, 30) + (t.due ? ' ~' + t.due : ''); }).join(' · ') + (list.length > 3 ? ' 외 ' + (list.length - 3) + '건' : '');
      await push.sendTo([who], { title: '자동 지시 ' + list.length + '건', body: body.slice(0, 200), url: './', tag: 'auto-new-' + who + '-' + today }, { ctx: tc, primaryOnly: true, by: by || '자동' });
      n++;
    }
    return n;
  } catch (e) { return 0; }
}
// ---- 완료 신호 자동 전환 settings:doneif (v397 — 공통 기반 2 첫 시범, 착수 브리핑 A5 · 카드 1-5 추천안 'review까지 자동') ----
// 워커는 gw-doneif-cron(*/10)·라이브러리 _lib/doneif.js. 여기는 관리자 스위치(on/off, 기본 off=dry-run)와 마지막 점검 조회만.
const DONEIF_KEY = 'settings:doneif';
async function handleDoneifGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  let on = false, updated_at = 0, prev = null;
  try { const r = await blobGet(st, DONEIF_KEY); if (r.ok && r.data) { on = r.data.on === true; updated_at = r.data.updated_at || 0; prev = r.data.prev || null; } } catch (e) {}
  let last = null;
  try { const l = await blobGet(st, 'it:doneif:last'); if (l.ok && l.data) last = { ts: l.data.ts || 0, today: l.data.today || '', on: !!l.data.on, scanned: l.data.scanned || 0, candidates: (l.data.candidates || []).slice(0, 20), moved: l.data.moved || 0, notified: l.data.notified || 0 }; } catch (e) {}
  return jr(200, { status: 'OK', on: on, updated_at: updated_at, prev: prev, last: last, request_id: R });
}
async function handleDoneifSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (typeof d.on !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
  const st = store(DATA);
  let cur = { on: false, updated_at: 0, updated_by: '' };
  try { const r = await blobGet(st, DONEIF_KEY); if (r.ok && r.data) cur = { on: r.data.on === true, updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '' }; } catch (e) {}
  if (d.base !== undefined && Number(d.base) !== Number(cur.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'DONEIF_STALE', request_id: R });
  if (cur.on === d.on) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const doc = { schema: 1, on: d.on, prev: { on: cur.on, updated_at: cur.updated_at, updated_by: cur.updated_by }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, DONEIF_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '앱기준설정', id: '', t: '완료 신호 자동 전환 ' + (cur.on ? '켬' : '끔') + '→' + (d.on ? '켬' : '끔') }] }); } catch (e) {}
  return jr(200, { status: 'OK', on: d.on, updated_at: doc.updated_at, request_id: R });
}
// ---- v453 서버 설정 적용 settings_apply(봇 키 — 보안 재감사 ③ · 원장 C094) ----
// R1 같은 서버 설정 변경을 넷리파이 CLI 직접 쓰기(앱 감사 로그 0줄 — 11/4·11/10·11/13 C025) 대신 이 길로 한다. 앞으로 R1 적용 스크립트는 이것만 쓴다(CLAUDE.md 보안 줄).
//   대상 허용 목록 3종 notify·assign·doneif — 값 검사·저장 모양은 앱 관리자 카드 핸들러와 같다(notifyValid · ASSIGN_PREFIXES + 재직 명부 · boolean),
//   prev 1판(앱 카드 [되돌리기]가 그대로 되돌림) · updated_at = 지금 · updated_by = 'bot:' + mark(회원 id가 아님 — 앱 밖 적용 표식) · applied_via 'settings_apply'.
//   changes에 적지 않은 칸은 지금 값 그대로(3칸 고정 덮어쓰기 금지 — v437 검토 지적) · 지금과 같은 값만이면 400 NO_CHANGE · base가 다르면 409 SETTINGS_STALE(쓰기에는 base 필수 — 없으면 400 NEED_BASE) ·
//   대상 키를 못 읽으면(읽기 실패·깨진 값) 503 SETTINGS_READ_FAILED(기본값 위에 얹어 쓰지 않음).
//   감사 1줄 op '설정적용'(by '설정봇(<mark>)' · bid 'bot' · 칸 이름과 전→후 · ref) — 감사 쓰기가 실패하면 응답 audit:false(설정은 이미 바뀜 → 스크립트가 멈추고 사람이 확인).
//   dry=true면 쓰지 않고 바뀔 칸만 돌려준다(봇 키라 notify_get 같은 관리자 조회를 못 쓰므로 미리보기 겸 base 얻기) · 쓰기는 confirm:true가 따로 있어야(없으면 400 NEED_CONFIRM) ·
//   dry가 true·false·없음 밖의 값(1·'true' 등)이면 400 BAD_DRY(미리보기로 알고 보낸 요청이 실제로 쓰지 않게).
//   자동 지시 스위치(settings:autotask)는 허용 목록 밖 — live 전환은 앱 관리자 카드로(누가 켰는지 회원으로 남게 · 재감사 ② 절차). 그 밖 settings:*도 이 길로 못 쓴다.
const SETTINGS_APPLY_TARGETS = { notify: 1, assign: 1, doneif: 1 };
const SETTINGS_APPLY_MARK = /^[a-z0-9][a-z0-9._-]{2,39}$/;
async function handleSettingsApply(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const target = String(d.target || '');
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_APPLY_TARGETS, target)) return jr(400, { status: 'REJECTED', error_code: 'BAD_TARGET', request_id: R });
  const mark = String(d.mark || '');
  if (!SETTINGS_APPLY_MARK.test(mark)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MARK', request_id: R });
  // v453 검토: 미리보기·쓰기 2단(backup_put과 같은 꼴) — dry는 true·false·없음만(dry:1·'true'를 미리보기로 알고 보냈는데 실제로 쓰던 길) · 쓰기는 confirm:true 따로
  if (d.dry !== undefined && d.dry !== true && d.dry !== false) return jr(400, { status: 'REJECTED', error_code: 'BAD_DRY', request_id: R });
  const ch = d.changes;
  if (!ch || typeof ch !== 'object' || Array.isArray(ch) || !Object.keys(ch).length) return jr(400, { status: 'REJECTED', error_code: 'BAD_CHANGES', request_id: R });
  const ref = String(d.ref || '').replace(/[^0-9A-Za-z가-힣._\- ]/g, '').slice(0, 40);
  const st = store(DATA), by = 'bot:' + mark, now = Date.now();
  // v453 검토: 대상 키를 먼저 직접 읽는다 — notifyRead·assignRead·doneif 읽기는 블롭 읽기가 실패해도(없음이 아니라 읽기 실패·깨진 값) 기본값을 돌려주므로,
  //   그 위에 changes만 얹어 쓰면 사람 눈 없는 봇 경로가 다른 칸의 운영 값을 기본값으로 되돌리고 prev에도 기본값을 남긴다 → 503 SETTINGS_READ_FAILED로 쓰지 않음(fail-closed).
  //   (실 blobGet은 없음 = ok:true·data null · servertest mock은 없음 = NOT_FOUND — 둘 다 '없음'.) 깨진 설정은 재해 복원(backup_put)으로 고친 뒤 다시.
  const pre = await blobGet(st, target === 'notify' ? NOTIFY_KEY : (target === 'assign' ? ASSIGN_KEY : DONEIF_KEY));
  if (!pre.ok && pre.code !== 'NOT_FOUND') return jr(503, { status: 'ERROR', error_code: 'SETTINGS_READ_FAILED', request_id: R });
  const own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const stale = function (u) { return d.base !== undefined && Number(d.base) !== Number(u || 0); };
  let key, doc, curAt, ev = [], pub;
  if (target === 'notify') {
    const nf = await notifyRead(st);
    if (stale(nf.updated_at)) return jr(409, { status: 'CONFLICT', error_code: 'SETTINGS_STALE', request_id: R });
    const next = Object.assign({}, nf.events);
    for (const k of Object.keys(ch)) {
      const v = String(ch[k]);
      if (!notifyValid(k, v)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EVENT', field: String(k).slice(0, 40), request_id: R });
      if (next[k] !== v) { ev.push({ id: k, t: NOTIFY_EVENTS[k].label + ' ' + (NOTIFY_EVENTS[k].options[next[k]] || next[k]) + '→' + NOTIFY_EVENTS[k].options[v] }); next[k] = v; }
    }
    key = NOTIFY_KEY; curAt = nf.updated_at;
    doc = { schema: 1, events: next, prev: { events: nf.events, updated_at: nf.updated_at || 0, updated_by: nf.updated_by || '' }, updated_by: by, updated_at: now, applied_via: 'settings_apply' };
    pub = { events: next };
  } else if (target === 'assign') {
    const a = await assignRead(st);
    if (stale(a.updated_at)) return jr(409, { status: 'CONFLICT', error_code: 'SETTINGS_STALE', request_id: R });
    const members = await assignMembers();
    if (!members) return jr(503, { status: 'ERROR', error_code: 'MEMBERS_UNAVAILABLE', request_id: R });   // 명부 없이 쓰면 퇴사자·오타 id가 배정될 수 있다(assign_set과 같음)
    const okId = function (id) { return id === '' || own(members, id); };
    const nm = function (id) { return id ? ((members[id] || {}).name || id) : ''; };
    const rules = JSON.parse(JSON.stringify(a.rules || {})); let apv = a.approver_id || '';
    for (const k of Object.keys(ch)) {
      const who = String(ch[k] == null ? '' : ch[k]).slice(0, 40);
      if (!okId(who)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MEMBER', field: String(k).slice(0, 40), request_id: R });
      if (k === 'approver_id') {
        if (who !== apv) { ev.push({ id: 'approver', t: '자동 지시 승인권자 ' + (nm(apv) || '관리자 전원') + '→' + (nm(who) || '관리자 전원') }); apv = who; }
        continue;
      }
      if (!own(ASSIGN_PREFIXES, k)) return jr(400, { status: 'REJECTED', error_code: 'BAD_PREFIX', field: String(k).slice(0, 40), request_id: R });
      const before = (rules[k] || {}).who_id || '';
      if (before === who) continue;
      if (who) rules[k] = { who_id: who }; else delete rules[k];
      ev.push({ id: k, t: ASSIGN_PREFIXES[k] + ' ' + (nm(before) || '없음') + '→' + (nm(who) || '없음') });
    }
    key = ASSIGN_KEY; curAt = a.updated_at;
    doc = { schema: 1, rules: rules, approver_id: apv, prev: { rules: a.rules || {}, approver_id: a.approver_id || '', updated_at: a.updated_at || 0, updated_by: a.updated_by || '' }, updated_by: by, updated_at: now, applied_via: 'settings_apply' };
    pub = { rules: rules, approver_id: apv };
  } else {   // doneif
    if (Object.keys(ch).length !== 1 || !own(ch, 'on') || typeof ch.on !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
    let cur = { on: false, updated_at: 0, updated_by: '' };
    try { const r = await blobGet(st, DONEIF_KEY); if (r.ok && r.data) cur = { on: r.data.on === true, updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '' }; } catch (e) {}
    if (stale(cur.updated_at)) return jr(409, { status: 'CONFLICT', error_code: 'SETTINGS_STALE', request_id: R });
    if (cur.on !== ch.on) ev.push({ id: 'on', t: '완료 신호 자동 전환 ' + (cur.on ? '켬' : '끔') + '→' + (ch.on ? '켬' : '끔') });
    key = DONEIF_KEY; curAt = cur.updated_at;
    doc = { schema: 1, on: ch.on, prev: { on: cur.on, updated_at: cur.updated_at, updated_by: cur.updated_by }, updated_by: by, updated_at: now, applied_via: 'settings_apply' };
    pub = { on: ch.on };
  }
  if (!ev.length) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', updated_at: curAt || 0, request_id: R });
  if (d.dry === true) return jr(200, { status: 'OK', dry: true, target: target, changes: ev, updated_at: curAt || 0, request_id: R });
  if (d.confirm !== true) return jr(400, { status: 'REJECTED', error_code: 'NEED_CONFIRM', changes: ev, updated_at: curAt || 0, request_id: R });
  // v453 검토: 쓰기에는 base 필수 — dry 응답의 updated_at을 base로 보내는 2단 꼴을 강제(같은 실패를 겪은 dry의 0을 그대로 보내도 위 직접 읽기가 먼저 막음)
  if (d.base === undefined) return jr(400, { status: 'REJECTED', error_code: 'NEED_BASE', changes: ev, updated_at: curAt || 0, request_id: R });
  const w = await blobSet(st, key, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  let au = false;
  try { au = await appendAudit({ ts: now, by: '설정봇(' + mark + ')', bid: 'bot', col: 'tasks', ev: ev.map(function (e) { return { op: '설정적용', id: target + ':' + e.id, t: e.t + ' · ' + mark + (ref ? ' · ' + ref : '') }; }) }) !== false; } catch (e) { au = false; }
  return jr(200, Object.assign({ status: 'OK', target: target, changes: ev, updated_at: now, updated_by: by, audit: au, request_id: R }, pub));
}
// ---- 아침 음성 브리핑 settings:brief · 오늘 생성본 · 사용량(체크 38 D1, v416 — 브리핑 §3 D1 관리자 카드) ----
// 관리자만(서버 강제). 생성은 워커(gw-brief-run-background, 내부 토큰 __brief__)가 하고 여기는 설정(기본값·prev 1판·되돌리기·감사로그·낙관락)·조회·기동·목소리 확인·mp3 꺼내기만.
// 키 값은 어떤 응답에도 싣지 않는다 — env는 있음/없음만(brief_get.env).
async function briefAdmin(event, R) {
  const c = await currentMember(event);
  if (!c.ok) return { res: jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R }) };
  if (!c.member.admin) return { res: jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R }) };
  return { c: c };
}
function briefDocPublic(doc) {
  if (!doc) return null;
  return { date: doc.date, ts: doc.ts, by: doc.by, mode: doc.mode, reason: doc.reason, text: doc.text, len: doc.len, facts: doc.facts, cols_missing: doc.cols_missing || [],
    provider: doc.provider, voice: doc.voice, rate: doc.rate, mp3: doc.mp3, claude: doc.claude, ms: doc.ms, log: doc.log || [] };
}
async function handleBriefGet(event, d, R) {
  const a = await briefAdmin(event, R); if (a.res) return a.res;
  const st = store(DATA); const today = BRIEF.kstToday();
  const s = await BRIEF.settingsRead(st);
  let doc = null, job = null, voices = null;
  try { const r = await blobGet(st, 'brief:day:' + today); if (r.ok && r.data) doc = r.data; } catch (e) {}
  try { const r = await blobGet(st, 'brief:job:last'); if (r.ok && r.data) job = r.data; } catch (e) {}
  try { const r = await blobGet(st, 'brief:voices'); if (r.ok && r.data) voices = r.data; } catch (e) {}
  const usage = await BRIEF.usageRead(st, today);
  const env = BRIEF.azureEnv();
  return jr(200, Object.assign({ status: 'OK', request_id: R, today: today, doc: briefDocPublic(doc), job: job, voices: voices,
    usage: Object.assign(usage, BRIEF.capState(usage), { cap_azure: BRIEF.CAP_AZURE_CHARS, cap_claude: BRIEF.CAP_CLAUDE_TOKENS }),
    env: { azure: env.ok, azure_region: env.region, elevenlabs: !!String(process.env.ELEVENLABS_API_KEY || '').trim(), claude: !!String(process.env.GW_ANTHROPIC_KEY || '').trim() },
    log: await BRIEF.logRead(st, 7), admin_runs_per_day: BRIEF.ADMIN_RUNS_PER_DAY, model: BRIEF.MODEL }, BRIEF.settingsPublic(s)));
}
async function handleBriefSet(event, d, R) {
  const a = await briefAdmin(event, R); if (a.res) return a.res; const c = a.c;
  const field = String(d.field || '');
  const value = (field === 'on') ? (d.value === true) : String(d.value == null ? '' : d.value).trim();
  if (!BRIEF.settingsValid(field, value)) return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
  const st = store(DATA); const s = await BRIEF.settingsRead(st);
  if (d.base !== undefined && Number(d.base) !== Number(s.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'BRIEF_STALE', request_id: R });
  if (s.values[field] === value) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const next = Object.assign({}, s.values); next[field] = value;
  const doc = { schema: 1, values: next, prev: { values: s.values, updated_at: s.updated_at || 0, updated_by: s.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, BRIEF.SETTINGS_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '브리핑설정', id: field, t: field + ' ' + String(s.values[field]) + '→' + String(value) }] }); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, BRIEF.settingsPublic({ values: next, prev: doc.prev, updated_at: doc.updated_at, updated_by: doc.updated_by })));
}
async function handleBriefRevert(event, d, R) {
  const a = await briefAdmin(event, R); if (a.res) return a.res; const c = a.c;
  const st = store(DATA); const s = await BRIEF.settingsRead(st);
  if (!s.prev || !s.prev.values) return jr(400, { status: 'REJECTED', error_code: 'NO_PREV', request_id: R });
  if (d.base !== undefined && Number(d.base) !== Number(s.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'BRIEF_STALE', request_id: R });
  const vals = BRIEF.settingsNormalize(s.prev.values);
  const doc = { schema: 1, values: vals, prev: { values: s.values, updated_at: s.updated_at || 0, updated_by: s.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, BRIEF.SETTINGS_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '브리핑되돌림', id: '', t: '브리핑 설정 직전 판으로' }] }); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, BRIEF.settingsPublic({ values: vals, prev: doc.prev, updated_at: doc.updated_at, updated_by: doc.updated_by })));
}
// [지금 1회 생성] — 오늘 생성본이 있어도 다시 만든다(force). 유료 호출이라 하루 상한(ADMIN_RUNS_PER_DAY). 워커 기동만(202) — 결과는 brief_get.job.
async function handleBriefRun(event, d, R) {
  const a = await briefAdmin(event, R); if (a.res) return a.res; const c = a.c;
  const st = store(DATA); const today = BRIEF.kstToday();
  const recent = await BRIEF.logRead(st, 60);
  const n = recent.filter(function (x) { return x && x.date === today && /^admin:/.test(String(x.by || '')); }).length;
  if (n >= BRIEF.ADMIN_RUNS_PER_DAY) return jr(429, { status: 'REJECTED', error_code: 'DAILY_CAP', runs: n, request_id: R });
  const s = require('./_lib/session').issueSession({ id: '__brief__', role: 'system' });
  if (!s.ok) return jr(500, { status: 'ERROR', error_code: s.code || 'SERVER_CONFIG_MISSING', request_id: R });
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return jr(500, { status: 'ERROR', error_code: 'NO_SITE_URL', request_id: R });
  const job = 'brief_admin_' + today + '_' + Date.now().toString(36);
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-brief-run-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, by: 'admin:' + c.member.id, force: true }),
    });
    if (!resp.ok && resp.status !== 202) return jr(500, { status: 'ERROR', error_code: 'KICKOFF_HTTP_' + resp.status, request_id: R });
  } catch (e) { return jr(500, { status: 'ERROR', error_code: 'KICKOFF_FAILED', request_id: R }); }
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '브리핑생성', id: today, t: '[지금 1회 생성] 요청 ' + job }] }); } catch (e) {}
  return jr(200, { status: 'OK', queued: true, job: job, today: today, request_id: R });
}
// [목소리 확인] — Azure voices/list(실호출, 무료)에서 ko-KR 목소리와 선히 유무. 결과는 brief:voices에 보관(이름만).
async function handleBriefVoices(event, d, R) {
  const a = await briefAdmin(event, R); if (a.res) return a.res;
  const st = store(DATA);
  let v;
  try { v = await BRIEF.azureVoices(); } catch (e) { v = { ok: false, code: String((e && e.message) || e).slice(0, 40) }; }
  if (!v.ok) return jr(502, { status: 'ERROR', error_code: v.code || 'AZURE_FAILED', request_id: R });
  const doc = { schema: 1, ts: Date.now(), region: v.region, total: v.total, ko: (v.ko || []).slice(0, 40), ko_count: (v.ko || []).length, sunhi: v.sunhi };
  try { await blobSet(st, 'brief:voices', doc); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, doc));
}
// [미리 듣기] — 그날 mp3 base64(관리자만). 브리핑 토큰 경로는 D2.
async function handleBriefMp3(event, d, R) {
  const a = await briefAdmin(event, R); if (a.res) return a.res;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : BRIEF.kstToday();
  const st = store(DATA);
  let r = null; try { r = await blobGet(st, 'brief:mp3:' + date); } catch (e) { r = null; }
  if (!r || !r.ok || !r.data || !r.data.b64) return jr(404, { status: 'NOT_FOUND', error_code: 'NO_MP3', date: date, request_id: R });
  return jr(200, { status: 'OK', request_id: R, date: date, fmt: r.data.fmt || 'audio/mpeg', bytes: r.data.bytes || 0, b64: r.data.b64 });
}
// ---- 자동 지시 서버 규칙 3건(카드 10, v417 — 착수브리핑_카드10_자동지시_20261102.md §3 공통 바탕 ①~④) ----
// 등록표는 appdata data/appr/autotask_rules.json(규칙 추가 = 행 1개, R3 브리핑). 여기는 ② 규칙별 스위치 settings:autotask(dry·live·off, prev 1판·되돌리기·감사·낙관락),
// 집계 autotask_facts(봇 키 — appdata autotask.py가 매일 08:10 호출, id·수만), ③ dry 결과 보관 it:autotask:dry(봇 키, PII 가드), 관리자 조회. 생성은 autotask_ingest(기존)로만.
const AUTOTASK_KEY = 'settings:autotask';
const AUTOTASK_RULES = {
  site_missing: { label: '현장 대장 미입력 월 1회', key: 'site:missing:<YYYY-MM>', prefix: 'site:' },
  veh_insp90: { label: '차량 정기검사 지시 D-90(기존 D-30 앞당김)', key: 'veh:<id>:insp:<만료일>', prefix: 'veh:' },
  wk_missing: { label: '일용직 인적사항 미입력 월 1회', key: 'wk:missing:<YYYY-MM>', prefix: 'wk:' },
};
const AUTOTASK_MODES = ['dry', 'live', 'off'];
function autotaskDefaults() { const o = {}; Object.keys(AUTOTASK_RULES).forEach(function (k) { o[k] = 'dry'; }); return o; }
function autotaskValid(rule, mode) { return Object.prototype.hasOwnProperty.call(AUTOTASK_RULES, rule) && AUTOTASK_MODES.indexOf(String(mode)) >= 0; }
async function autotaskRead(st) {
  try {
    const r = await blobGet(st, AUTOTASK_KEY);
    if (r.ok && r.data && r.data.rules && typeof r.data.rules === 'object') {
      const rules = autotaskDefaults();
      Object.keys(r.data.rules).forEach(function (k) { if (autotaskValid(k, r.data.rules[k])) rules[k] = r.data.rules[k]; });
      return { rules: rules, prev: r.data.prev || null, updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '' };
    }
  } catch (e) {}
  return { rules: autotaskDefaults(), prev: null, updated_at: 0, updated_by: '' };
}
function autotaskPublic(a) {
  const meta = {}; Object.keys(AUTOTASK_RULES).forEach(function (k) { meta[k] = AUTOTASK_RULES[k]; });
  return { rules: a.rules, meta: meta, modes: AUTOTASK_MODES, prev: a.prev ? { updated_at: a.prev.updated_at || 0, updated_by: a.prev.updated_by || '' } : null, updated_at: a.updated_at || 0, updated_by: a.updated_by || '' };
}
function prevMonthOf(today) { const t = String(today).split('-'); const d = new Date(Date.UTC(+t[0], +t[1] - 1, 1) - 86400000); return d.toISOString().slice(0, 7); }
async function autotaskFacts(st) {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const get = async function (name) { try { const r = await blobGet(st, colKey(name)); return (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : []; } catch (e) { return []; } };
  const asb = await get('asbestos'), wk = await get('workers'), veh = await get('vehicles'), tasks = await get('tasks');
  const keys = tasks.filter(function (t) { return t && t.auto_key && t.del !== 1; }).map(function (t) { return String(t.auto_key); });
  const openKeys = {}; tasks.forEach(function (t) { if (t && t.auto_key && t.del !== 1 && (t.status === 'open' || t.status === 'hold' || t.status === 'review')) openKeys[t.auto_key] = 1; });
  const pm = prevMonthOf(today);
  return { today: today, site: AR.siteMissing(asb), veh90: AR.veh90(veh, today, keys), wk: AR.wkMissing(wk, asb),
    keys: { site: AR.siteKey(today), wk: AR.wkKey(today) },
    exists: { site: keys.indexOf(AR.siteKey(today)) >= 0, wk: keys.indexOf(AR.wkKey(today)) >= 0 },
    prev_open: { site: !!openKeys['site:missing:' + pm], wk: !!openKeys['wk:missing:' + pm] } };
}
async function handleAutotaskFacts(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const st = store(DATA);
  const f = await autotaskFacts(st);
  const pii = AR.piiScan(f);
  if (pii) return jr(500, { status: 'ERROR', error_code: 'PII_' + pii, request_id: R });
  const a = await autotaskRead(st);
  return jr(200, Object.assign({ status: 'OK', request_id: R, rules: a.rules }, f));
}
async function handleAutotaskDryPut(event, d, R) {
  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });
  const dry = (d.dry && typeof d.dry === 'object') ? d.dry : null;
  if (!dry) return jr(400, { status: 'REJECTED', error_code: 'BAD_DRY', request_id: R });
  const pii = AR.piiScan(dry);
  if (pii) return jr(400, { status: 'REJECTED', error_code: 'PII_' + pii, request_id: R });
  const s = JSON.stringify(dry); if (s.length > 60000) return jr(400, { status: 'REJECTED', error_code: 'TOO_BIG', request_id: R });
  const st = store(DATA);
  const a = await autotaskRead(st);
  const doc = { schema: 1, ts: Date.now(), day: String(d.day || '').slice(0, 10), by: '정기봇', run: String(d.run || '').slice(0, 40), modes: a.rules, rules: dry };
  const w = await blobSet(st, 'it:autotask:dry', doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  return jr(200, { status: 'OK', request_id: R, ts: doc.ts });
}
async function handleAutotaskGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const a = await autotaskRead(st);
  let dry = null; try { const r = await blobGet(st, 'it:autotask:dry'); if (r.ok && r.data) dry = r.data; } catch (e) {}
  // veh 결과 카드의 차량번호·만료일은 id로 대장에서 불러 보인다(관리자 전용 응답 — 브리핑 공통 바탕 ③)
  let veh_items = [];
  try {
    const items = (dry && dry.rules && dry.rules.veh_insp90 && Array.isArray(dry.rules.veh_insp90.items)) ? dry.rules.veh_insp90.items : [];
    if (items.length) { const r = await blobGet(st, colKey('vehicles')); const by = {}; ((r.ok && r.data && r.data.items) || []).forEach(function (v) { if (v && v.id) by[v.id] = v; });
      veh_items = items.slice(0, 60).map(function (it) { const v = by[it.id] || {}; return { id: it.id, no: String(v.no || ''), due: it.due, days: it.days, state: String(v.state || ''), kind: String(v.kind || '').slice(0, 20) }; }); }
  } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R, dry: dry, veh_items: veh_items }, autotaskPublic(a)));
}
async function handleAutotaskSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const rule = String(d.rule || ''), mode = String(d.mode || '');
  if (!autotaskValid(rule, mode)) return jr(400, { status: 'REJECTED', error_code: 'BAD_RULE', request_id: R });
  const st = store(DATA);
  const a = await autotaskRead(st);
  if (d.base !== undefined && Number(d.base) !== Number(a.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'AUTOTASK_STALE', request_id: R });
  if (a.rules[rule] === mode) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const next = Object.assign({}, a.rules); next[rule] = mode;
  const doc = { schema: 1, rules: next, prev: { rules: a.rules, updated_at: a.updated_at || 0, updated_by: a.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, AUTOTASK_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '자동지시규칙', id: rule, t: AUTOTASK_RULES[rule].label + ' ' + a.rules[rule] + '→' + mode }] }); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, autotaskPublic({ rules: next, prev: doc.prev, updated_at: doc.updated_at, updated_by: doc.updated_by })));
}
async function handleAutotaskRevert(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const a = await autotaskRead(st);
  if (!a.prev || !a.prev.rules) return jr(400, { status: 'REJECTED', error_code: 'NO_PREV', request_id: R });
  if (d.base !== undefined && Number(d.base) !== Number(a.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'AUTOTASK_STALE', request_id: R });
  const rules = autotaskDefaults(); Object.keys(a.prev.rules).forEach(function (k) { if (autotaskValid(k, a.prev.rules[k])) rules[k] = a.prev.rules[k]; });
  const doc = { schema: 1, rules: rules, prev: { rules: a.rules, updated_at: a.updated_at || 0, updated_by: a.updated_by || '' }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, AUTOTASK_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '자동지시규칙되돌림', id: '', t: '규칙 스위치 직전 판으로' }] }); } catch (e) {}
  return jr(200, Object.assign({ status: 'OK', request_id: R }, autotaskPublic({ rules: rules, prev: doc.prev, updated_at: doc.updated_at, updated_by: doc.updated_by })));
}
// ---- 감시 경보 라벨 it:alerts (v399 — 공통 기반 14 · 착수 브리핑 A7 2일차). 감시 항목(크론 지도 id)별 라벨 {level, until, by, ts}.
// level: 'warn'(기본 — 편입 뒤 1주는 경보를 안내로 낮춤) · 'alert'(승격 1클릭 — 즉시 경보) · 'mute'(7일 무음, until). IT 운영 책임자(관리자) 전용·감사로그.
const ALERTS_KEY = 'it:alerts';
const ALERT_LEVELS = { warn: 1, alert: 1, mute: 1 };
async function handleAlertsGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  let labels = {}, updated_at = 0;
  try { const r = await blobGet(store(DATA), ALERTS_KEY); if (r.ok && r.data) { labels = (r.data.labels && typeof r.data.labels === 'object') ? r.data.labels : {}; updated_at = r.data.updated_at || 0; } } catch (e) {}
  return jr(200, { status: 'OK', labels: labels, updated_at: updated_at, request_id: R });
}
async function handleAlertsSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const id = String(d.id || '').trim().slice(0, 60), level = String(d.level || '');
  if (!/^[A-Za-z0-9가-힣 _.-]{2,60}$/.test(id)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });   // v427: cron_map 로컬 예약 작업 id("JW 첨부백업")는 한글·띄어쓰기
  if (!Object.prototype.hasOwnProperty.call(ALERT_LEVELS, level)) return jr(400, { status: 'REJECTED', error_code: 'BAD_LEVEL', request_id: R });
  const st = store(DATA);
  let doc = { schema: 1, labels: {}, updated_at: 0 };
  try { const r = await blobGet(st, ALERTS_KEY); if (r.ok && r.data && r.data.labels && typeof r.data.labels === 'object') doc = r.data; } catch (e) {}
  const before = (doc.labels[id] || {}).level || 'warn';
  const today = new Date(Date.now() + 9 * 3600000);
  const until = level === 'mute' ? new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10) : '';
  doc.labels[id] = { level: level, until: until, by: c.member.id, ts: Date.now() };
  doc.updated_at = Date.now(); doc.updated_by = c.member.id;
  const w = await blobSet(st, ALERTS_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'tasks', ev: [{ op: '경보라벨', id: id, t: id + ' ' + before + '→' + level + (until ? '(~' + until + ')' : '') }] }); } catch (e) {}
  return jr(200, { status: 'OK', labels: doc.labels, updated_at: doc.updated_at, request_id: R });
}
// ---- 계약 골조·목록 거울 (v400 — 계약 D1 2일차). Blobs proc:contract:v1(골조 층: CON_TYPE_ELEMS·CON_SCEN·CON_STAGE_FIELDS·CON_SITE_CORP + added.stages)·list:contract(목록 층: STAGE_DOCS·STAGE_DOC_MAP·CON_PACKETS + added.lists)는
//      appdata collectors/contract_mirror.py 가 쓴다(코드 상수 export + proc_added_v1 제안). 앱은 settings:contract.use_blob 가 true 일 때만 로그인 뒤 상수 자리에 거울을 덮어 쓴다(기본 false = 배포 무변화).
//      켜기·끄기는 관리자 1클릭(prev 보존 = 되돌리기), 거울 두 층이 검증(proc_ver v1·layer·sha)을 못 넘으면 켤 수 없다(MIRROR_MISSING). 단계 이름은 어느 쪽이든 PM 원문 불변.
const CON_PROC_KEYS = { proc: 'proc:contract:v1', list: 'list:contract', flag: 'settings:contract', map: 'map:contract:v1', bg: 'bg:contract:law:v1' };   // v404 D2: map(두 층 매핑·due_rule, contract_map.py)·bg(법령 배경 승격본, contract_bg.py)
function conProcMapOk(x) { return !!(x && typeof x === 'object' && x.schema === 1 && x.proc_ver === 'v1' && x.scen && typeof x.scen === 'object' && typeof x.sha === 'string' && x.sha.length >= 8); }
function conProcBgOk(x) { return !!(x && typeof x === 'object' && x.schema === 1 && typeof x.ver === 'string' && x.ver.length >= 2 && Array.isArray(x.rows) && typeof x.sha === 'string' && x.sha.length >= 8); }
function conProcLayerOk(x, layer) { return !!(x && typeof x === 'object' && x.proc_ver === 'v1' && x.layer === layer && x.consts && typeof x.consts === 'object' && typeof x.sha === 'string' && x.sha.length >= 8); }
async function conProcReadFlag(st) {
  let flag = { use_blob: false, updated_at: 0, updated_by: '', prev: null, bg_ver: '', annual_override: {}, bg_fp: '', bg_auto: false, bg_carry: null, bg_chk: '' };
  try { const r = await blobGet(st, CON_PROC_KEYS.flag); if (r.ok && r.data) flag = { use_blob: r.data.use_blob === true, updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '', prev: r.data.prev || null, bg_ver: typeof r.data.bg_ver === 'string' ? r.data.bg_ver : '', annual_override: (r.data.annual_override && typeof r.data.annual_override === 'object') ? r.data.annual_override : {}, bg_fp: typeof r.data.bg_fp === 'string' ? r.data.bg_fp : '', bg_auto: r.data.bg_auto === true, bg_carry: (r.data.bg_carry && typeof r.data.bg_carry === 'object') ? r.data.bg_carry : null, bg_chk: typeof r.data.bg_chk === 'string' ? r.data.bg_chk : '' }; } catch (e) {}   // v404: bg_ver(배경 승격본 판)·annual_override(연 1회 기한 override) · P1 판4: bg_fp(승격본의 확인일 뺀 지문)·bg_auto(자동 이월 스위치, 기본 꺼짐)·bg_carry(마지막 자동 이월) · 검토 P1-3: bg_chk(승격본 행 확인일 중 가장 늦은 날)
  return flag;
}
// P1 판4 — 계약 법령 기준표(bg:contract:law:v1) '확인일만 바뀐 판' 판정. 지문 = 행마다 checked 칸만 뺀 나머지 전부(행 id 순 정렬, 키 정렬 JSON)의 sha256 앞 16자.
//      판 메타(ver·built_at·source·sha·n_*)는 지문 밖. 행 수·행 id·나머지 모든 칸(law·art·mst·eff·days·base·kind·text·grade·note·referenced …)이 같아야 같은 지문. 판정은 서버 이 한 곳(앱·gw-lawwatch에는 없음).
function conBgCanon(v) { if (Array.isArray(v)) return '[' + v.map(conBgCanon).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + conBgCanon(v[k])).join(',') + '}'; return JSON.stringify(v === undefined ? null : v); }
function conBgFp(bg) {
  if (!conProcBgOk(bg)) return '';
  const rows = bg.rows.map((r) => { const o = Object.assign({}, r); delete o.checked; return o; }).sort((a, b) => (String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0)));
  return crypto.createHash('sha256').update(conBgCanon(rows)).digest('hex').slice(0, 16);
}
// 검토 P1-3: 판 행 확인일(checked)의 가장 이른 날·가장 늦은 날 — 날짜 꼴이 아닌 행이 하나라도 있으면 lo ''(이월 안 함)
function conBgChk(bg) {
  if (!conProcBgOk(bg) || !bg.rows.length) return { lo: '', hi: '' };
  let lo = null, hi = '';
  bg.rows.forEach(function (r) { const c = (r && typeof r.checked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.checked)) ? r.checked : ''; if (lo === null || c < lo) lo = c; if (c > hi) hi = c; });
  return { lo: lo || '', hi: hi };
}
function conFlagKeep(cur) { return { bg_fp: cur.bg_fp || '', bg_auto: cur.bg_auto === true, bg_carry: cur.bg_carry || null, bg_chk: cur.bg_chk || '' }; }   // 스위치·승격 저장이 판4 칸을 지우지 않게
// 자동 이월: 스위치 켜짐 ∧ 승격본 있음(bg_ver) ∧ 기준 지문 있음 ∧ 올라온 판 ver 가 다름 ∧ 지문 같음 ∧ 올라온 판 행 확인일이 모두 기준 확인일(bg_chk) 뒤(검토 P1-3) → 승격 없이 bg_ver 를 새 판으로(감사 1줄·bg_carry). 해제(bg_ver '') 상태에선 하지 않음.
async function conBgAutoCarry(st, flag, bg) {
  if (!flag || !flag.bg_auto || !flag.bg_ver || !flag.bg_fp || !conProcBgOk(bg) || bg.ver === flag.bg_ver) return null;
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(bg.ver) || conBgFp(bg) !== flag.bg_fp) return null;
  // 검토 P1-3: 새 판이어야 함 — 올라온 판의 모든 행 확인일이 승격본(또는 마지막 이월본)의 가장 늦은 확인일보다 뒤일 때만(옛 판을 다시 올리면 같은 지문이어도 이월 안 함 · 기준 날짜가 없으면 이월 안 함)
  const ck = conBgChk(bg);
  if (!flag.bg_chk || !ck.lo || !(ck.lo > flag.bg_chk)) return null;
  const cur = await conProcReadFlag(st);   // 쓰기 직전 다시 읽음(동시 조회 두 번째는 여기서 멈춤)
  if (!cur.bg_auto || cur.bg_ver !== flag.bg_ver || cur.bg_fp !== flag.bg_fp || cur.bg_chk !== flag.bg_chk) return null;
  const now = Date.now();
  const doc = { schema: 1, use_blob: cur.use_blob, prev: { use_blob: cur.use_blob, updated_at: cur.updated_at, updated_by: cur.updated_by, bg_ver: cur.bg_ver || '', bg_fp: cur.bg_fp || '', bg_chk: cur.bg_chk || '' }, bg_ver: bg.ver, annual_override: cur.annual_override || {}, bg_fp: cur.bg_fp, bg_auto: true, bg_carry: { from: cur.bg_ver, to: bg.ver, at: now }, bg_chk: ck.hi, updated_by: 'auto-carry', updated_at: now };
  const w = await blobSet(st, CON_PROC_KEYS.flag, doc);
  if (!w.ok) return null;
  try { await appendAudit({ ts: now, by: '자동 이월', bid: '__system__', col: 'contracts', ev: [{ op: '계약배경', id: '', t: '확인일만 바뀐 판 자동 이월 ' + cur.bg_ver + '→' + bg.ver + ' (지문 ' + cur.bg_fp + ' · 확인일 ' + cur.bg_chk + '→' + ck.hi + ')' }] }); } catch (e) {}
  return { use_blob: doc.use_blob, updated_at: now, updated_by: doc.updated_by, prev: doc.prev, bg_ver: doc.bg_ver, annual_override: doc.annual_override, bg_fp: doc.bg_fp, bg_auto: true, bg_carry: doc.bg_carry, bg_chk: doc.bg_chk };
}
async function conProcReadLayers(st) {
  let proc = null, list = null;
  try { const p = await blobGet(st, CON_PROC_KEYS.proc); if (p.ok && conProcLayerOk(p.data, 'proc')) proc = p.data; } catch (e) {}
  try { const l = await blobGet(st, CON_PROC_KEYS.list); if (l.ok && conProcLayerOk(l.data, 'list')) list = l.data; } catch (e) {}
  let map = null, bg = null;   // v404 D2 — 없으면 null(앱은 없음 = 기한 엔진 꺼짐). 두 층과 독립(불량이어도 proc·list에 영향 없음)
  try { const m = await blobGet(st, CON_PROC_KEYS.map); if (m.ok && conProcMapOk(m.data)) map = m.data; } catch (e) {}
  try { const g = await blobGet(st, CON_PROC_KEYS.bg); if (g.ok && conProcBgOk(g.data)) bg = g.data; } catch (e) {}
  return { proc: proc, list: list, map: map, bg: bg };
}
async function handleConProcFlagSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (typeof d.use_blob !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
  const st = store(DATA);
  const cur = await conProcReadFlag(st);
  if (d.base !== undefined && Number(d.base) !== Number(cur.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'CON_PROC_STALE', request_id: R });
  if (cur.use_blob === d.use_blob) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  if (d.use_blob) { const L = await conProcReadLayers(st); if (!L.proc || !L.list) return jr(409, { status: 'CONFLICT', error_code: 'MIRROR_MISSING', request_id: R }); }
  const doc = Object.assign({ schema: 1, use_blob: d.use_blob, prev: { use_blob: cur.use_blob, updated_at: cur.updated_at, updated_by: cur.updated_by, bg_ver: cur.bg_ver || '' }, bg_ver: cur.bg_ver || '', annual_override: cur.annual_override || {} }, conFlagKeep(cur), { updated_by: c.member.id, updated_at: Date.now() });   // v404: 스위치 토글이 bg_ver·override를 지우지 않음(prev에도 기록 — 검토 N5) · 판4 칸도 보존
  const w = await blobSet(st, CON_PROC_KEYS.flag, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'contracts', ev: [{ op: '계약골조', id: '', t: '골조·목록 거울 ' + (cur.use_blob ? '켬' : '끔') + '→' + (d.use_blob ? '켬' : '끔') }] }); } catch (e) {}
  return jr(200, { status: 'OK', use_blob: d.use_blob, updated_at: doc.updated_at, request_id: R });
}
// v404 D2 — 배경 승격·연 1회 override. bg_ver = 거울 4층 bg:contract:law:v1 의 ver 와 같을 때만 앱 기한 엔진이 켜진다(R2 승격 카드의 [승격] 버튼). '' = 해제(엔진 끔, 기존 계약 기한 불변·소급 없음).
//      annual_override = { law_id: 'YYYY-MM-DD' } — 연 1회 고정일(실적신고 2/15 등)의 그해 연장 고시 대응, bg 행은 안 바꿈. 되돌리기 = 같은 액션으로 ''.
async function handleConProcBgSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA);
  const cur = await conProcReadFlag(st);
  if (d.base !== undefined && Number(d.base) !== Number(cur.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'CON_PROC_STALE', request_id: R });
  const doc = Object.assign({ schema: 1, use_blob: cur.use_blob, prev: { use_blob: cur.use_blob, updated_at: cur.updated_at, updated_by: cur.updated_by, bg_ver: cur.bg_ver || '', bg_fp: cur.bg_fp || '', bg_auto: cur.bg_auto === true, bg_chk: cur.bg_chk || '' }, bg_ver: cur.bg_ver || '', annual_override: Object.assign({}, cur.annual_override || {}) }, conFlagKeep(cur), { updated_by: c.member.id, updated_at: Date.now() });
  const changed = [];
  let Lbg = null;
  if (d.bg_ver !== undefined) {
    const v = String(d.bg_ver || '');
    if (v && !/^[A-Za-z0-9_.-]{2,40}$/.test(v)) return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
    if (v) { const L = await conProcReadLayers(st); if (!L.bg || L.bg.ver !== v) return jr(409, { status: 'CONFLICT', error_code: 'BG_MISSING', request_id: R }); Lbg = L.bg; }
    if (v !== (cur.bg_ver || '')) {
      doc.bg_ver = v; changed.push('배경 ' + (cur.bg_ver || '없음') + '→' + (v || '없음'));
      doc.bg_fp = v ? conBgFp(Lbg) : ''; doc.bg_carry = null;   // P1 판4: 승격 = 그 판의 확인일 뺀 지문을 비교 기준으로 · 해제 = 기준도 비움(자동 이월 안 함)
      doc.bg_chk = v ? conBgChk(Lbg).hi : '';   // 검토 P1-3: 승격본의 가장 늦은 확인일 — 이월은 이보다 뒤에 확인한 판만
      if (v) changed.push('기준 지문 ' + doc.bg_fp);
    }
  }
  if (d.bg_auto !== undefined) {   // P1 판4: 확인일만 바뀐 판 자동 이월 스위치(기본 꺼짐, 관리자)
    if (typeof d.bg_auto !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
    if (d.bg_auto !== (cur.bg_auto === true)) { doc.bg_auto = d.bg_auto; changed.push('확인일만 바뀐 판 자동 이월 ' + (cur.bg_auto ? '켬' : '끔') + '→' + (d.bg_auto ? '켬' : '끔')); }
    if (d.bg_auto && doc.bg_ver && !doc.bg_fp) {   // 판4 이전에 승격된 판(지문 없음): 올라온 판이 승격본 그대로면 지금 지문을 기준으로
      if (!Lbg) { const L = await conProcReadLayers(st); Lbg = L.bg; }
      if (Lbg && Lbg.ver === doc.bg_ver) { doc.bg_fp = conBgFp(Lbg); doc.bg_chk = conBgChk(Lbg).hi; if (doc.bg_fp) changed.push('기준 지문 ' + doc.bg_fp + '(승격본 ' + doc.bg_ver + ')'); }
    }
  }
  if (d.annual_override && typeof d.annual_override === 'object') {
    for (const k of Object.keys(d.annual_override)) {
      if (!/^[a-z][a-z0-9_.-]{1,40}$/.test(k)) return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
      const v = d.annual_override[k];
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
      const before = doc.annual_override[k] || '';
      if (v) doc.annual_override[k] = String(v); else delete doc.annual_override[k];
      if ((doc.annual_override[k] || '') !== before) changed.push('연 1회 override ' + k + ' ' + (before || '없음') + '→' + (v || '없음'));   // 검토 S5: 실제 바뀐 키만
    }
  }
  if (!changed.length) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const w = await blobSet(st, CON_PROC_KEYS.flag, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'contracts', ev: [{ op: '계약배경', id: '', t: changed.join(' · ') }] }); } catch (e) {}
  return jr(200, { status: 'OK', bg_ver: doc.bg_ver, annual_override: doc.annual_override, bg_fp: doc.bg_fp, bg_auto: doc.bg_auto, updated_at: doc.updated_at, request_id: R });
}
// ---- 계약 골조·목록 편집 기록 clog:contract (v401 — 계약 D1 3일차). 거울 두 층(contract_mirror.py 출력)은 그대로 두고, 관리자 편집을 append-only 해시 체인 clog:contract 에 쌓아
//      읽을 때마다 base 위에 재생(replay)한 "유효 층"을 돌려준다 — --push/--verify 는 base 만 보므로 편집이 지워지지도, 변환 diff 0 게이트가 깨지지도 않는다. 앱 로더(conProcLoad)는 유효 층을 받는다.
//      op: docs_set(서류 목록 글 수정·새 키) · docs_del(소프트 삭제) · map_add(이름→서류 키 매핑, 맨 앞에 끼움) · map_del(소프트 삭제) · scen_del(시나리오에서 단계 소프트 삭제 — 새 계약부터, 기존 계약 불변) · revert(앞 항목 되돌리기).
//      단계 이름 재작성·추가·순서 재배치는 없다(PM 원문 불변 · 신설은 카드 9 added, 4일차). 값은 골조 상수 글뿐(개인정보 없음). 건별 stage.docs[] 사건은 월 키 clog:contract:YYYY-MM(con_clog_add, 값 없이 종류만).
const CON_CLOG_KEY = 'clog:contract';
const CON_CLOG_MAX = 2000;
const CON_CLOG_MONTH_MAX = 5000;
const CON_CLOG_OPS = { docs_set: 1, docs_del: 1, map_add: 1, map_del: 1, scen_del: 1, revert: 1 };
const CON_STAGE_ACTS = { done: 1, undo: 1, na: 1, add: 1, del: 1 };
function conClogHash(prev, entry) { return crypto.createHash('sha256').update(prev + '|' + JSON.stringify(entry)).digest('hex').slice(0, 16); }
function conClogChainOk(doc) { let prev = ''; for (const it of (doc.items || [])) { const e = Object.assign({}, it); delete e.h; delete e.p; if (it.p !== prev || conClogHash(prev, e) !== it.h) return false; prev = it.h; } return prev === (doc.head || ''); }
async function conClogRead(st, key) {
  let doc = { schema: 1, items: [], head: '' };
  try { const r = await blobGet(st, key || CON_CLOG_KEY); if (r.ok && r.data && Array.isArray(r.data.items)) { doc = { schema: 1, items: r.data.items, head: r.data.head || '' }; if (Array.isArray(r.data.restored)) doc.restored = r.data.restored; } } catch (e) {}
  return doc;
}
// v453 검토: 재해 복원(backup_put)이 남긴 되살린 범위 restored[{ts,from,to,bk,added,rechained}]를 다음 기록 쓰기가 지우지 않게 — 쓰는 두 곳이 이것으로 문서를 만든다
function conClogDoc(doc, extra) { return Object.assign({ schema: 1, items: doc.items, head: doc.head }, extra, Array.isArray(doc.restored) ? { restored: doc.restored } : {}); }
// 재생: base 두 층 + clog → 유효 두 층(깊은 복사) + 편집 상태(카드의 '편집됨'·'삭제됨' 표시와 [복구] 버튼의 h)
function conProcReplay(proc, list, clog) {
  const P = JSON.parse(JSON.stringify(proc)), L = JSON.parse(JSON.stringify(list));
  const items = (clog && clog.items) || [];
  const reverted = {}; items.forEach((it) => { if (it.op === 'revert' && it.of) reverted[it.of] = it.h; });
  const state = { docs_set: {}, docs_del: {}, map_add: [], map_del: {}, scen_del: {}, applied: 0, reverted: Object.keys(reverted).length };
  for (const it of items) {
    if (it.op === 'revert' || reverted[it.h]) continue;
    state.applied++;
    if (it.op === 'docs_set') { L.consts.STAGE_DOCS[it.key] = it.value; state.docs_set[it.key] = it.h; delete state.docs_del[it.key]; }
    else if (it.op === 'docs_del') { state.docs_del[it.key] = it.h; }
    else if (it.op === 'map_add') { state.map_add.unshift({ re: it.re, flags: it.flags || '', key: it.key, h: it.h }); delete state.map_del[it.re]; }   // 검토 1: 삭제 뒤 같은 정규식 추가 = 되살림
    else if (it.op === 'map_del') { state.map_del[it.re] = it.h; state.map_add = state.map_add.filter((m) => m.re !== it.re); }
    else if (it.op === 'scen_del') { state.scen_del[it.scen + '|' + it.i] = { h: it.h, name: it.name }; }
  }
  Object.keys(state.docs_del).forEach((k) => { delete L.consts.STAGE_DOCS[k]; });
  L.consts.STAGE_DOC_MAP = state.map_add.map((m) => [{ $re: m.re, $flags: m.flags }, m.key]).concat(L.consts.STAGE_DOC_MAP || []).filter((p) => !(p && p[0] && state.map_del[p[0].$re]));
  Object.keys(P.consts.CON_SCEN || {}).forEach((sk) => { P.consts.CON_SCEN[sk] = (P.consts.CON_SCEN[sk] || []).filter((n, i) => !state.scen_del[sk + '|' + i]); });
  const head = (clog && clog.head) || '';
  P.base_sha = proc.sha; L.base_sha = list.sha; P.edits = state.applied; L.edits = state.applied; P.clog_head = head; L.clog_head = head;
  return { proc: P, list: L, state: state };
}
// 유효 층 문턱 — 앱 conProcValid 가 폴백하는 조건과 같은 축(깨질 편집은 서버가 거부 = WOULD_BREAK)
function conProcEffOk(P, L) {
  const scen = (P.consts && P.consts.CON_SCEN) || {};
  for (const k of Object.keys(scen)) if (!Array.isArray(scen[k]) || !scen[k].length) return 'CON_SCEN ' + k + ' 단계 0';
  if (Object.keys((L.consts && L.consts.STAGE_DOCS) || {}).length < 10) return 'STAGE_DOCS 10 미만';
  if (!Array.isArray(L.consts.STAGE_DOC_MAP) || L.consts.STAGE_DOC_MAP.length < 10) return 'STAGE_DOC_MAP 10 미만';
  return '';
}
async function handleConProcGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const st = store(DATA);
  let flag = await conProcReadFlag(st);
  const L = await conProcReadLayers(st);
  try { const cf = await conBgAutoCarry(st, flag, L.bg); if (cf) flag = cf; } catch (e) {}   // P1 판4: 확인일만 바뀐 판이면 승격 없이 이월(스위치 켜짐일 때만)
  const clog = await conClogRead(st);
  let proc = L.proc, list = L.list, state = null;
  if (proc && list) { const eff = conProcReplay(proc, list, clog); proc = eff.proc; list = eff.list; state = eff.state; }
  const clogOut = { n: clog.items.length, head: clog.head || '', applied: state ? state.applied : 0, reverted: state ? state.reverted : 0, chain_ok: conClogChainOk(clog), items: clog.items.slice(-30), reverted_of: clog.items.filter((x) => x.op === 'revert' && x.of).map((x) => x.of) };
  const heavy = !!(flag.use_blob || c.member.admin);   // v404 검토 S4: 꺼짐이면 직원에게 map·bg(약 100KB) 안 보냄(앱은 null = 엔진 꺼짐)
  let lawwatch = null;   // v405 D2: lawwatch 주간 크론이 남긴 재확인 행(bg_recheck) — 엔진이 그 행을 '재확인 필요(개정 감지)'로
  if (heavy) { try { const lw = await blobGet(st, 'lawwatch:last'); if (lw.ok && lw.data) lawwatch = { date: String(lw.data.date || ''), ts: lw.data.ts || 0, bg_recheck: Array.isArray(lw.data.bg_recheck) ? lw.data.bg_recheck.slice(0, 100) : [] }; } catch (e) {} }
  return jr(200, { status: 'OK', flag: flag, proc: proc, list: list, map: heavy ? L.map : null, bg: heavy ? L.bg : null, lawwatch: lawwatch, clog: clogOut, edit_state: state, request_id: R });   // v404: map·bg 층 동봉(없으면 null)
}
async function handleConProcEdit(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const op = String(d.op || '');
  if (!Object.prototype.hasOwnProperty.call(CON_CLOG_OPS, op)) return jr(400, { status: 'REJECTED', error_code: 'BAD_OP', request_id: R });
  const st = store(DATA);
  const L0 = await conProcReadLayers(st);
  if (!L0.proc || !L0.list) return jr(409, { status: 'CONFLICT', error_code: 'MIRROR_MISSING', request_id: R });
  const clog = await conClogRead(st);
  if (d.head !== undefined && String(d.head) !== String(clog.head || '')) return jr(409, { status: 'CONFLICT', error_code: 'CON_PROC_STALE', request_id: R });
  if (clog.items.length >= CON_CLOG_MAX) return jr(409, { status: 'CONFLICT', error_code: 'CLOG_FULL', request_id: R });
  const cur = conProcReplay(L0.proc, L0.list, clog);
  const SD = cur.list.consts.STAGE_DOCS, MAP = cur.list.consts.STAGE_DOC_MAP;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const str = (v, max) => { const s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim(); return (s.length && s.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\n]/.test(s)) ? s : null; };
  const bad = (code, detail) => jr(400, Object.assign({ status: 'REJECTED', error_code: code, request_id: R }, detail ? { detail: detail } : {}));
  const entry = { ts: Date.now(), by: c.member.id, op: op };
  let t = '';
  if (op === 'docs_set') {
    const key = str(d.key, 40), value = str(d.value, 2000);
    if (!key || !value || /[\[\]{}"\\|]/.test(key) || key === '__proto__') return bad('BAD_VALUE', '키 1~40자(괄호·따옴표 제외)·값 1~2000자 한 줄');
    if (SD[key] === value) return bad('NO_CHANGE');
    entry.key = key; entry.value = value; t = '서류 목록 ' + key + (has(SD, key) ? ' 수정' : ' 추가');
  } else if (op === 'docs_del') {
    const key = str(d.key, 40);
    if (!key || !has(SD, key)) return bad('BAD_VALUE', '없는 서류 키');
    entry.key = key; t = '서류 목록 ' + key + ' 삭제';
  } else if (op === 'map_add') {
    const re = str(d.re, 120), key = str(d.key, 40), flags = String(d.flags || '');
    if (!re || !key || !/^i?$/.test(flags)) return bad('BAD_VALUE', '정규식 1~120자·키·flags(i만)');
    try { new RegExp(re, flags); } catch (e) { return bad('BAD_RE', String(e.message || '').slice(0, 80)); }
    if (!has(SD, key)) return bad('BAD_VALUE', '매핑 대상 서류 키가 없음: ' + key);
    if (MAP.some((p) => p && p[0] && p[0].$re === re)) return bad('NO_CHANGE', '같은 정규식 매핑이 이미 있음');
    entry.re = re; entry.flags = flags; entry.key = key; t = '매핑 /' + re + '/ → ' + key + ' 추가';
  } else if (op === 'map_del') {
    const re = str(d.re, 120);
    if (!re || !MAP.some((p) => p && p[0] && p[0].$re === re)) return bad('BAD_VALUE', '없는 매핑');
    entry.re = re; t = '매핑 /' + re + '/ 삭제';
  } else if (op === 'scen_del') {
    const scen = str(d.scen, 40), i = Number(d.i), name = str(d.name, 120);
    const base = scen ? L0.proc.consts.CON_SCEN[scen] : null;
    if (!scen || !Array.isArray(base) || !Number.isInteger(i) || i < 0 || i >= base.length || base[i] !== name) return bad('BAD_VALUE', '시나리오·번호·이름이 base 와 다름');
    if (cur.state.scen_del[scen + '|' + i]) return bad('NO_CHANGE');
    entry.scen = scen; entry.i = i; entry.name = name; t = '단계 ' + scen + ' #' + (i + 1) + ' ' + name + ' 삭제(새 계약부터)';
  } else {   // revert
    const of = str(d.of, 16); const target = of ? clog.items.find((x) => x.h === of) : null;
    if (!of || !target || target.op === 'revert') return bad('BAD_VALUE', '되돌릴 항목이 없거나 되돌리기 항목');
    if (clog.items.some((x) => x.op === 'revert' && x.of === of)) return bad('NO_CHANGE', '이미 되돌림');
    entry.of = of; t = '되돌리기 ' + target.op + ' ' + (target.key || target.re || (target.scen ? target.scen + ' #' + (target.i + 1) : ''));
  }
  const trial = { items: clog.items.concat([Object.assign({ h: '-', p: clog.head || '' }, entry)]), head: '-' };
  const eff = conProcReplay(L0.proc, L0.list, trial);
  const brk = conProcEffOk(eff.proc, eff.list);
  if (brk) return bad('WOULD_BREAK', brk);
  const h = conClogHash(clog.head || '', entry);
  clog.items.push(Object.assign({ h: h, p: clog.head || '' }, entry)); clog.head = h;
  const w = await blobSet(st, CON_CLOG_KEY, conClogDoc(clog, { updated_at: Date.now(), updated_by: c.member.id }));
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'contracts', ev: [{ op: '계약골조편집', id: h, t: t }] }); } catch (e) {}
  return jr(200, { status: 'OK', head: h, n: clog.items.length, edits: eff.state.applied, item: clog.items[clog.items.length - 1], request_id: R });
}
// 건별 단계 서류 사건(stage.docs[] ☑·해당없음·추가·삭제) — 계약 do 권한. 값(서류 이름)은 적지 않고 종류·좌표만(지표 ② 서류 목록 delta의 재료). 월 키, 해시 체인, 상한 5,000/월
function conClogMonthKey(ts) { return 'clog:contract:' + new Date((ts || Date.now()) + 9 * 3600000).toISOString().slice(0, 7); }
async function handleConClogAdd(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const cid = String(d.cid || ''), pipe = String(d.pipe || ''), i = Number(d.i), k = String(d.k || ''), act = String(d.act || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid) || !/^[A-Za-z0-9_-]{1,20}$/.test(pipe) || !Number.isInteger(i) || i < 0 || i > 99 || !/^[A-Za-z0-9가-힣_:.-]{1,60}$/.test(k) || !Object.prototype.hasOwnProperty.call(CON_STAGE_ACTS, act)) return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
  const st = store(DATA), key = conClogMonthKey();
  const doc = await conClogRead(st, key);
  if (doc.items.length >= CON_CLOG_MONTH_MAX) return jr(409, { status: 'CONFLICT', error_code: 'CLOG_FULL', request_id: R });
  const entry = { ts: Date.now(), by: c.member.id, op: 'stage_docs', cid: cid, pipe: pipe, i: i, k: k, act: act };
  const h = conClogHash(doc.head || '', entry);
  doc.items.push(Object.assign({ h: h, p: doc.head || '' }, entry)); doc.head = h;
  const w = await blobSet(st, key, conClogDoc(doc, { updated_at: Date.now() }));
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  return jr(200, { status: 'OK', key: key, n: doc.items.length, head: h, request_id: R });
}

// ---- 계약 서류함 cdoc(v406, 계약 D3 1일차 · 설계안 10/22 §4-1 Stored 1안) — 기록물은 Blobs만(git 경로 없음), append-only, 새 버전=새 키, 소프트 삭제 → 30일 뒤 관리자 confirm 영구 삭제(R3) ----
// 바이트: gw_files 'cdoc:<cid>:S<nn>:<doc_key>:<n>' {name(표준 파일명), orig(올린 이름), type(확장자 고정표), kind, data|fill, by, ts, sha}
// 색인:  gw_data  'recidx:<cid>' {schema, cid, seq, items:[{n,i,dk,kind,ver,cur,name,orig,ext,size,sha,pii,by,ts,del?,del_by?,purged?,gc?}]} — 항목은 지우지 않는다(표식만)
// 열람 기록: gw_data 'reclog:YYYY-MM'(doclog 패턴) · 감사: col 'contracts' op 기록물등록/기록물보관/기록물복구/기록물현재/기록물영구삭제 — 실패 시 응답 audit:false
// 표준 파일명(설계 §4-1 명명): C<cid>_S<nn>_<doc_key>_v<N>_<YYYYMMDD>[_종운환경|_종운건설].<ext> — 회사는 거울 map:contract:v1 단계 co(env/con)로 서버가 정한다. 발주처명·금액은 이름에 넣지 않는다
// pii 0=없음(기본) 1=근로자 명단·위임장·신분증 등(contracts 'do' 또는 관리자만 열람) 2=건강진단 결과표 등 민감정보(관리자·관리부만 + 열람 사유 필수, 학습·주입 제외)
const CDOC_KINDS = { draft: 1, final: 1, received: 1 };
const CDOC_MAX = 6 * 1024 * 1024;                // 문서함 DOC_ATT_MAX와 같은 6MB(base64 — 그 상수는 뒤에 선언돼 직접 참조 불가) — 넷리파이 동기 함수 본문 한도. 초과는 채움 맵(fill)만 올리고 파일은 오프라인 메타(FILE_TOO_LARGE 응답에 안내)
const CDOC_FILL_MAX = 200 * 1024;                // 채움 맵 JSON 상한(문자열 길이)
const CDOC_PER_CON = 400;                        // 계약당 색인 항목 상한
const CDOC_DRAFT_KEEP = 3;                       // 같은 (단계·doc_key) 초안은 최근 3판만 바이트 보존(색인 항목은 gc 표식으로 남김)
const CDOC_TRASH_DAYS = 30;                      // 소프트 삭제 뒤 영구 삭제 가능까지
const CDOC_DK_RE = /^[A-Za-z0-9가-힣_.-]{1,40}$/;
const CDOC_STD_RE = /^C[A-Za-z0-9_-]{1,40}_S\d{2}_[A-Za-z0-9가-힣_.-]{1,40}_v\d+_\d{8}(_종운환경|_종운건설)?\.[a-z0-9]{1,6}$/;   // 기록물 표준 이름 — 문서함(git 경로)엔 못 들어간다(RECORD_NOT_FOR_GIT)
const CDOC_CORP_NAME = { env: '종운환경', con: '종운건설' };
const RECLOG_MAX = 5000;
function cdocIdxKey(cid) { return 'recidx:' + cid; }
function cdocKey(cid, i, dk, n) { return 'cdoc:' + cid + ':S' + String(i).padStart(2, '0') + ':' + dk + ':' + n; }
function cdocStdName(cid, i, dk, ver, ts, corp, ext) {
  const d = new Date(ts + 9 * 3600 * 1000);
  const ymd = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  return 'C' + cid + '_S' + String(i).padStart(2, '0') + '_' + dk + '_v' + ver + '_' + ymd + (CDOC_CORP_NAME[corp] ? '_' + CDOC_CORP_NAME[corp] : '') + '.' + ext;
}
function docAttRecordName(name) { return CDOC_STD_RE.test(String(name || '')); }
function recLogKey(month) {
  if (month && /^\d{4}-\d{2}$/.test(month)) return 'reclog:' + month;
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return 'reclog:' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
async function appendRecLog(st, entry) {
  try {
    const key = recLogKey();
    const r = await blobGet(st, key);
    const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
    doc.items.push(entry);
    if (doc.items.length > RECLOG_MAX) doc.items = doc.items.slice(-RECLOG_MAX);
    const w = await blobSet(st, key, doc);
    return !!(w && w.ok);
  } catch (e) { return false; }
}
// ---- 학습 짝(v410, 계약 D4 2일차 — 설계 §5 "같은 (계약·단계)의 final 업로드 즉시 learn:contract:in 생성") ----
// 최종본이 올라오면 같은 단계의 현재 초안(생성 훅 gen.<양식> fill, 또는 draft 파일)과 짝을 만들고 셀·문단 단위 차이와 간극을 그 자리에서 잰다(모델 호출 없음).
// 모델 학습(규칙 뽑기)은 settings:learn.contract.on && allow[양식]이 있을 때만 pending으로 두고 워커(3일차)가 집는다 — 허용 사전(R2) 전엔 fail-closed.
// 짝 블롭엔 좌표·횟수·비율만 들어간다(셀 값·개인정보 없음 — docdiff 반환 구조가 그렇다). 건강진단·명단 유형은 짝 자체를 만들지 않는다.
const LN = require('./_lib/learn');
const DD = require('./_lib/docdiff');
const BF = require('./_lib/boxfile');   // v423 넣기 박스 조각
const BJ = require('./_lib/boxjudge');   // v424 검토 파일명 제외를 입구와 같은 기준으로
const LEARN_KEY = LN.TYPES.contract.settings_key;
const LEARN_ALLOW_MAX = 200;   // 양식당 허용 칸 상한
async function learnSettings(st) {
  let d = {};
  try { const r = await blobGet(st, LEARN_KEY); if (r.ok && r.data && typeof r.data === 'object') d = r.data; } catch (e) {}
  const c = (d.contract && typeof d.contract === 'object') ? d.contract : {};
  return { contract: { on: c.on === true, allow: (c.allow && typeof c.allow === 'object' && !Array.isArray(c.allow)) ? c.allow : {} }, updated_at: Number(d.updated_at) || 0, updated_by: String(d.updated_by || '') };
}
function learnAllowed(s, tpl) { const a = s.contract.allow[tpl]; return s.contract.on === true && Array.isArray(a) && a.length > 0; }
function learnDiffPublic(diff) {
  if (!diff) return null;
  const o = {};
  ['ok', 'code', 'kind', 'compared', 'changed', 'uncomparable', 'blank_both', 'ratio', 'n_draft', 'n_final', 'same', 'added', 'removed', 'outside_changed', 'refs_outside'].forEach(function (k) { if (diff[k] !== undefined) o[k] = diff[k]; });
  o.refs_changed = Array.isArray(diff.refs_changed) ? diff.refs_changed : [];
  o.refs_uncomparable = Array.isArray(diff.refs_uncomparable) ? diff.refs_uncomparable : [];
  return o;
}
// v424 짝 찾는 순서(브리핑 1단계): ① 파일 안 표식 ② 서류 이름으로 정한 양식(pair_tpl) ③ 내용 일치율 ④ 비교할 수 없는 형식(hwp·pdf)은 같은 단계 초안 하나일 때만.
// 직원에게 고르라고 하지 않는다. 일치율이 비슷한 초안이 둘 이상일 때만 미매칭으로 남긴다.
const PAIR_MATCH_MIN = 0.5;    // 이 이상이면 그 초안의 수정본으로 본다
const PAIR_MATCH_GAP = 0.05;   // 1등과 2등 차이가 이보다 작으면 정하지 않는다
const PAIR_STAGE_MIN = 0.2;    // 같은 단계 초안이 하나뿐이면 많이 고친 것으로 보는 하한
const PAIR_SCAN_MAX = 12;      // 내용을 대조할 초안 수 상한(동기 함수 시간)
async function cdocLearnPair(st, member, ref, idx, item, ext, b64, orig, d) {
  const T = LN.TYPES.contract, now = Date.now(), files = store(FILES);
  const live = function (x) { return x && x.kind === 'draft' && !x.del && !x.gc && !x.purged && typeof x.dk === 'string' && x.dk.indexOf('gen.') === 0; };
  const isDraft = function (x) { return live(x) && x.cur === 1; };
  const fb = b64 ? Buffer.from(b64, 'base64') : null;
  const mark = fb ? DD.genMarkOf(fb, ext) : '';
  let byMark = mark ? (idx.items.filter(function (x) { return live(x) && x.gen === mark; })[0] || null) : null;
  if (byMark) {   // 표식은 그대로인데 내용이 많이 다르면(지난 파일을 복사해 고친 경우) 믿지 않는다. 잴 수 없으면 표식을 따른다
    const mr = await blobGet(files, cdocKey(ref.cid, byMark.i, byMark.dk, byMark.n));
    const ms = (mr.ok && mr.data) ? DD.matchScore(mr.data, byMark.ext, ext, fb) : null;
    if (ms !== null && ms < PAIR_MATCH_MIN) byMark = null;
  }
  // 유형 제외: 민감정보 등급·서류 자리, 파일명은 입구와 같은 기준(서류 이름 단위 — '주민센터 철거공사'·'건강보험 완납증명'은 걸리지 않고 명단·검진·신분증은 표식이 있어도 제외)
  if (Number(item.pii) === 2 || T.forbid_re.test(String(ref.dk || '')) || BJ.nameGuard(orig)) return { ok: false, code: 'TYPE_EXCLUDED' };
  const drafts = idx.items.filter(function (x) { return isDraft(x) && x.i === ref.i; });
  const all = idx.items.filter(isDraft);
  const want = (d && typeof d.pair_tpl === 'string') ? d.pair_tpl.trim().slice(0, 40) : '';
  let pick = byMark, how = byMark ? 'mark' : '', match = null;
  // v423 넣기 박스: 서류 이름으로 양식이 정해지면(pair_tpl) 초안이 다른 단계에서 만들어졌어도 그 초안과 짝을 맺는다
  if (!pick && want) {
    pick = drafts.filter(function (x) { return x.dk === 'gen.' + want; })[0] || all.filter(function (x) { return x.dk === 'gen.' + want; }).sort(function (a, b) { return b.n - a.n; })[0] || null;
    const fam = { xlsx: 1, hwpx: 1, docx: 1 };
    if (pick && fam[ext] && fam[pick.ext] && ext !== pick.ext) pick = null;   // 이름은 맞는데 형식이 다르다(hwpx 수정본 ↔ xlsx 초안) — 비교할 수 없으니 내용으로 다시 찾는다. 스캔 pdf·hwp는 이름 짝 유지
    if (pick) how = 'name';
  }
  const base = { cid: ref.cid, i: ref.i, dk: ref.dk, final_n: item.n, ts: now, by: member.id, tries: 0 };
  const unmatched = async function (list) {
    const id = LN.newPairId('contract', ref.cid + ':' + item.n);
    const pair = Object.assign({ id: id, tpl: '', draft_n: 0, kind: 'none', status: 'unmatched', candidates: list.map(function (x) { return { n: x.n, tpl: x.dk.slice(4) }; }) }, base);
    const w = await blobSet(st, LN.pairKey('contract', id), pair);
    return { ok: w.ok, id: id, status: 'unmatched', candidates: pair.candidates, code: w.ok ? '' : w.code };
  };
  if (!pick) {
    if (!all.length) return { ok: false, code: 'NO_DRAFT' };
    // 비교되는 형식이면 형식이 맞는 초안만, 이 단계 먼저·최근 판 먼저 대조한다. 형식이 맞는 초안이 없으면 다른 서류
    const fam = { xlsx: 1, hwpx: 1, docx: 1 }, cmp = !!fam[ext], fmtOk = function (x) { return ext === 'xlsx' ? (x.ext === 'xlsx' || x.ext === 'json') : x.ext === ext; };
    const pool = cmp ? drafts.filter(fmtOk).concat(all.filter(function (x) { return x.i !== ref.i && fmtOk(x); }).sort(function (a, b) { return b.n - a.n; })) : [];
    if (cmp && !pool.length) return { ok: false, code: 'NO_MATCH' };
    const order = pool.slice(0, PAIR_SCAN_MAX), scored = [];
    if (fb) {
      for (const x of order) {
        const dr0 = await blobGet(files, cdocKey(ref.cid, x.i, x.dk, x.n));
        if (!dr0.ok || !dr0.data) continue;
        const sc = DD.matchScore(dr0.data, x.ext, ext, fb);
        if (sc !== null) scored.push({ x: x, sc: sc });
      }
      scored.sort(function (a, b) { return b.sc - a.sc; });
    }
    const top = scored[0], next = scored[1];
    if (top && top.sc >= PAIR_MATCH_MIN) {
      const tied = (next && top.sc - next.sc < PAIR_MATCH_GAP) ? scored.filter(function (y) { return top.sc - y.sc < PAIR_MATCH_GAP; }).map(function (y) { return y.x; }) : [top.x];
      const oneTpl = tied.every(function (y) { return y.dk === tied[0].dk; });   // 같은 양식을 두 단계에서 만든 경우 = 최근 판과 짝
      if (!oneTpl) return unmatched(tied);
      pick = tied.slice().sort(function (a, b) { return b.n - a.n; })[0]; how = 'content'; match = Math.round(top.sc * 1000) / 1000;
    } else if (scored.length) {
      // 비교는 됐는데 맞는 초안이 없다 — 같은 단계 초안이 하나뿐이고 어느 정도 겹치면 많이 고친 수정본, 아니면 다른 서류
      const lone = drafts.length === 1 ? scored.filter(function (y) { return y.x === drafts[0]; })[0] : null;
      if (lone && lone.sc >= PAIR_STAGE_MIN) { pick = drafts[0]; how = 'stage'; match = Math.round(lone.sc * 1000) / 1000; }
      else return { ok: false, code: 'NO_MATCH' };
    } else {
      if (cmp) return { ok: false, code: 'NO_MATCH' };   // 비교되는 형식인데 잴 재료가 없다 — 단계로 묶지 않는다
      // 비교할 수 없는 형식(hwp·날인 스캔 pdf) — 내용으로 못 가린다
      if (!drafts.length) return { ok: false, code: 'NO_DRAFT' };
      if (drafts.length > 1) return unmatched(drafts);
      pick = drafts[0]; how = 'stage';
    }
  }
  const tpl = pick.dk.slice(4);
  const dr = await blobGet(files, cdocKey(ref.cid, pick.i, pick.dk, pick.n));
  if (!dr.ok || !dr.data) return { ok: false, code: 'DRAFT_READ_FAILED' };
  let diff = null, kind = 'none';
  const fillFlat = dr.data.fill ? DD.flattenEdits(dr.data.fill.edits) : null;   // v419 실제 초안은 시트별 객체 — 옛 평면 배열도 받는다
  const db = dr.data.data ? Buffer.from(String(dr.data.data), 'base64') : null;
  const blanked = Array.isArray(dr.data.blank) ? dr.data.blank : [];   // 서버 사본에서 일부러 비운 사람 칸 — 비교에서 뺀다
  if (fb && ext === 'xlsx') {
    if (fillFlat && fillFlat.length) {
      diff = DD.xlsxCellDiff(fillFlat, fb); kind = 'xlsx_cell';
      if (db && pick.ext === 'xlsx' && diff.ok) { const o = DD.xlsxFileDiff(db, fb, fillFlat.map(function (e) { return e[0]; }).concat(blanked)); if (o.ok) { diff.outside_changed = o.changed; diff.refs_outside = o.refs_changed.slice(0, 100); } }   // AI가 안 채운 칸을 직원이 얼마나 채웠나(간극 값에는 안 넣는다)
    } else if (db && pick.ext === 'xlsx') { diff = DD.xlsxFileDiff(db, fb, blanked); kind = 'xlsx_file'; }
  } else if (fb && db && ext === 'docx' && pick.ext === 'docx') { diff = DD.docxParaDiff(db, fb); kind = 'docx_para'; }
  else if (fb && db && ext === 'hwpx' && pick.ext === 'hwpx') { diff = DD.hwpxParaDiff(db, fb); kind = 'hwpx_para'; }
  const gap = DD.gapScore(diff, null, 0);
  const s = await learnSettings(st);
  const status = (kind === 'xlsx_cell' && learnAllowed(s, tpl)) ? 'pending' : 'done_nomodel';   // 모델 학습은 칸 비교만(허용 사전이 칸 단위) — 문단 비교는 간극만
  const id = LN.newPairId('contract', ref.cid + ':' + item.n);
  const pair = Object.assign({ id: id, tpl: tpl, draft_n: pick.n, draft_i: pick.i, kind: kind, how: how, status: status, diff: learnDiffPublic(diff), gap: gap }, base);
  if (match !== null) pair.match = match;
  if (pick.late) pair.late = 1;
  const w = await blobSet(st, LN.pairKey('contract', id), pair);
  if (!w.ok) return { ok: false, code: w.code || 'PAIR_WRITE_FAILED' };
  try {
    const lk = T.lessons_key(tpl); const lr = await blobGet(st, lk);
    if (lr.ok || lr.code === 'NOT_FOUND') {   // 읽기 실패를 빈 창고로 보고 규칙·기준선·끔 표시를 덮어쓰지 않는다(v424 검토) — 이번 간극 1줄만 빠진다
      const L = LN.pushGap(lr.ok ? lr.data : null, { pair: id, promo_id: ref.cid, ratio: gap.cell_ratio, score: gap.score, kind: kind, changed: diff ? diff.changed : 0, compared: diff ? diff.compared : 0, uncomparable: diff ? diff.uncomparable : 0, comparable: gap.comparable, late: pick.late ? 1 : 0, gv: LN.GAP_VER }, now);   // v456 검토(T427): 간극 식 판(xlsx_cell은 같은 판만 기준선·일몰에 — learn.numericGaps)
      LN.freezeBaseline(L, now);   // v412 첫 10건 평균 = 기준선(일몰 비교 축)
      await blobSet(st, lk, L);
    }
  } catch (e) {}
  return { ok: true, id: id, status: status, tpl: tpl, kind: kind, how: how, draft_n: pick.n, gap: gap, changed: diff ? diff.changed : null, compared: diff ? diff.compared : null, uncomparable: diff ? diff.uncomparable : null, outside: (diff && Number(diff.outside_changed)) || 0, late: !!pick.late };
}
async function handleLearnSettingsGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const s = await learnSettings(store(DATA));
  return jr(200, { status: 'OK', settings: s, cap: LN.TYPES.contract.monthly_cap, request_id: R });
}
async function handleLearnSettingsSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA); const cur = await learnSettings(st);
  const next = { on: cur.contract.on, allow: Object.assign({}, cur.contract.allow) };
  let changed = 0;
  if (d.on !== undefined) { if (typeof d.on !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R }); if (next.on !== d.on) { next.on = d.on; changed++; } }
  if (d.allow !== undefined) {
    if (!d.allow || typeof d.allow !== 'object' || Array.isArray(d.allow)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ALLOW', request_id: R });
    const keys = Object.keys(d.allow); if (keys.length > 20) return jr(400, { status: 'REJECTED', error_code: 'ALLOW_TOO_MANY', request_id: R });
    const al = {};
    for (const k of keys) {
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) return jr(400, { status: 'REJECTED', error_code: 'BAD_TPL', request_id: R });
      // v419 상한 30 → 200: 허용 칸은 채움 맵의 부분집합이고 가장 큰 채움 맵은 asb_plan 140칸(카드 추천값 최대 demo_report 68칸). 칸 이름 길이 40·범위 표기 금지(A5~H14는 cellRows가 인식 못 해 조용히 빠진다 — 펼쳐서 넣는다)
      const v = d.allow[k]; if (!Array.isArray(v) || v.length > LEARN_ALLOW_MAX || v.some(function (f) { return typeof f !== 'string' || !f.trim() || f.length > 40 || f.indexOf('~') >= 0; })) return jr(400, { status: 'REJECTED', error_code: 'BAD_FIELDS', request_id: R });
      al[k] = v.map(function (f) { return f.trim(); });
    }
    if (JSON.stringify(al) !== JSON.stringify(next.allow)) { next.allow = al; changed++; }
  }
  if (!changed) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  if (d.base !== undefined && Number(d.base) !== Number(cur.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'LEARN_STALE', request_id: R });
  const doc = { schema: 1, contract: next, prev: { contract: cur.contract, updated_at: cur.updated_at, updated_by: cur.updated_by }, updated_by: c.member.id, updated_at: Date.now() };
  const w = await blobSet(st, LEARN_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  await cdocAudit(c.member, '학습설정', '', '계약 학습 ' + (next.on ? '켬' : '끔') + ' · 허용 양식 ' + Object.keys(next.allow).length + '종');
  return jr(200, { status: 'OK', settings: { contract: next, updated_at: doc.updated_at }, request_id: R });
}
// v412 양식별 학습 끄기/켜기(관리자) — 일몰(자동 끔) 되돌리기 포함. 켜면 sunset 기록은 남기고(reset_ts) 기준선을 비워 4주 시계를 다시 센다. 규칙은 어느 쪽도 지우지 않는다.
async function handleLearnTplSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const tpl = String(d.tpl || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(tpl)) return jr(400, { status: 'REJECTED', error_code: 'BAD_TPL', request_id: R });
  if (typeof d.off !== 'boolean') return jr(400, { status: 'REJECTED', error_code: 'BAD_VALUE', request_id: R });
  const st = store(DATA); const lk = LN.TYPES.contract.lessons_key(tpl); const lr = await blobGet(st, lk);
  if (!lr.ok && lr.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: lr.code || 'STORAGE_READ_FAILED', request_id: R });   // 읽기 실패로 규칙을 비우지 않는다
  const L = LN.normLessons(lr.ok ? lr.data : null);
  if (L.off === d.off) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const now = Date.now();
  L.off = d.off;
  if (d.off) L.sunset = { ts: now, by: c.member.id, manual: true };
  else { if (L.sunset) L.sunset = Object.assign({}, L.sunset, { reset_ts: now, reset_by: c.member.id }); delete L.baseline; }
  L.updated_at = now;
  const w = await blobSet(st, lk, L);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  await cdocAudit(c.member, '학습설정', '', '양식 ' + tpl + (d.off ? ' 학습 끔' : ' 학습 켬(기준선 재시작)'));
  return jr(200, { status: 'OK', tpl: tpl, off: L.off, sunset: L.sunset || null, baseline: L.baseline || null, request_id: R });
}
// v411 생성 주입 — 양식의 학습된 칸 기본값(field_default 규칙 중 허용 사전 안·근거 2건↑). 계약 처리 권한이면 조회. 허용 사전이 비면 빈 객체(=주입 없음).
async function handleLearnDefaultsGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const tpl = String(d.tpl || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(tpl)) return jr(400, { status: 'REJECTED', error_code: 'BAD_TPL', request_id: R });
  const st = store(DATA); const s = await learnSettings(st);
  if (!learnAllowed(s, tpl)) return jr(200, { status: 'OK', tpl: tpl, defaults: {}, on: false, request_id: R });
  const r = await blobGet(st, LN.TYPES.contract.lessons_key(tpl));
  const defaults = LN.fieldDefaults(r.ok ? r.data : null, s.contract.allow[tpl]);
  return jr(200, { status: 'OK', tpl: tpl, defaults: defaults, on: true, request_id: R });
}
const LEARN_LIST_MAX = 60;
async function handleLearnPairsGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const st = store(DATA); const pre = LN.TYPES.contract.pair_prefix;
  const l = await blobList(st, pre);
  if (!l.ok) return jr(500, { status: 'ERROR', error_code: l.code, request_id: R });
  const allKeys = (l.keys || []).filter(function (k) { return k.indexOf(pre) === 0; }).sort();   // 짝 번호 앞 8자리가 시각 — 정렬이 곧 시간순
  const keys = allKeys.slice(-LEARN_LIST_MAX);
  const pairs = [];
  for (const k of keys) { const r = await blobGet(st, k); if (r.ok && r.data && typeof r.data === 'object') pairs.push(r.data); }
  pairs.sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
  const tpls = {}; pairs.forEach(function (p) { if (p.tpl) tpls[p.tpl] = 1; });
  try { const ll = await blobList(st, 'lessons:contract:'); if (ll.ok) (ll.keys || []).forEach(function (k) { const t = String(k).slice('lessons:contract:'.length); if (t) tpls[t] = 1; }); } catch (e) {}   // 양식 표는 최근 짝에 든 양식만이 아니라 전부
  const lessons = {};
  for (const t of Object.keys(tpls)) { const r = await blobGet(st, LN.TYPES.contract.lessons_key(t)); const L = LN.normLessons(r.ok ? r.data : null); lessons[t] = { off: L.off, rules_n: L.rules.length, pairs: L.stats.pairs, calls: L.stats.calls, gap: LN.gapSummary(L), sunset: L.sunset || null, baseline: L.baseline || null }; }   // v412 일몰·기준선
  const s = await learnSettings(st);
  let usage = null; try { const ur = await blobGet(st, 'usage:box:' + LN.ymOf(Date.now())); if (ur.ok && ur.data) usage = ur.data; } catch (e) {}   // 이번 달 짝 경로(표식·이름·내용·단계·못 찾음) — 표식이 실제로 살아남는지 본다
  return jr(200, { status: 'OK', pairs: pairs, total: allKeys.length, lessons: lessons, settings: s, usage: usage, request_id: R });
}
async function cdocAudit(member, op, cid, t) {
  try { const r = await appendAudit({ ts: Date.now(), by: member.name, bid: member.id, col: 'contracts', ev: [{ op: op, id: cid, t: String(t || '').slice(0, 80) }] }); return r !== false; } catch (e) { return false; }
}
// 계약 항목(삭제 제외) — col:contracts
async function conLoadItem(st, cid) {
  const r = await blobGet(st, colKey('contracts'));
  if (!r.ok && r.code !== 'NOT_FOUND') return { ok: false, http: 500, code: r.code };
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const c = items.find(function (x) { return x && x.id === cid; });
  if (!c || c.del === 1) return { ok: false, http: 404, code: 'NO_CONTRACT' };
  return { ok: true, c: c };
}
// 단계 회사(env/con) — 거울 map:contract:v1의 scen[c.scen][i].co. 거울이 없거나 단계가 없으면 ''(파일명에 회사 접미 없음)
async function cdocCorpOf(st, c, i) {
  try {
    const r = await blobGet(st, CON_PROC_KEYS.map);
    const sc = (r.ok && r.data && r.data.scen && c && c.scen && Array.isArray(r.data.scen[c.scen])) ? r.data.scen[c.scen] : null;
    const s = sc ? sc.find(function (x) { return x && Number(x.i) === i; }) : null;
    return (s && (s.co === 'env' || s.co === 'con')) ? s.co : '';
  } catch (e) { return ''; }
}
async function cdocIdxRead(st, cid) {
  const r = await blobGet(st, cdocIdxKey(cid));
  if (!r.ok && r.code !== 'NOT_FOUND') return { ok: false, code: r.code };
  const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, cid: cid, seq: 0, items: [] };
  doc.seq = Number(doc.seq) || 0; doc.cid = cid;
  return { ok: true, doc: doc };
}
function cdocParseRef(d) {
  const cid = String(d.cid || ''), i = Number(d.i), dk = String(d.doc_key || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid)) return { err: 'BAD_CID' };
  if (!Number.isInteger(i) || i < 0 || i > 99) return { err: 'BAD_STAGE' };
  if (!CDOC_DK_RE.test(dk) || dk === 'constructor' || dk === '__proto__') return { err: 'BAD_DOC_KEY' };
  return { cid: cid, i: i, dk: dk };
}
function cdocPublic(it) { const o = Object.assign({}, it); delete o.sha_full; delete o.att0; return o; }   // v423 att0(판단 원본 번호)는 밖으로 내주지 않는다
async function handleCdocPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const ref = cdocParseRef(d); if (ref.err) return jr(400, { status: 'REJECTED', error_code: ref.err, request_id: R });
  const kind = String(d.kind || '');
  if (!hasOwn(CDOC_KINDS, kind)) return jr(400, { status: 'REJECTED', error_code: 'BAD_KIND', request_id: R });
  const pii = (d.pii === undefined || d.pii === null || d.pii === '') ? 0 : Number(d.pii);
  if (!(pii === 0 || pii === 1 || pii === 2)) return jr(400, { status: 'REJECTED', error_code: 'BAD_PII', request_id: R });
  const orig = String(d.name || '').trim().slice(0, 120);
  const b64 = String(d.data || '');
  let fill = null, ext = '';
  if (kind === 'draft' && d.fill && typeof d.fill === 'object' && !Array.isArray(d.fill)) {
    // 채움 맵 JSON — v424부터 파일과 함께 온다(칸 비교용). 파일 없이 오면 채움 맵만(6MB 초과 폴백). 값에 개인정보가 섞일 수 있어 pii는 호출자가 지정(기본 0)
    let s; try { s = JSON.stringify(d.fill); } catch (e) { return jr(400, { status: 'REJECTED', error_code: 'BAD_FILL', request_id: R }); }
    if (!s || s.length > CDOC_FILL_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILL_TOO_LARGE', request_id: R });
    fill = JSON.parse(s); ext = 'json';
  }
  if (!fill || b64) {
    if (!orig || !b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
    ext = docAttExt(orig);
    if (!docAttExtOk(ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', request_id: R });
    if (b64.length > CDOC_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', hint: '파일은 오프라인 보관, 채움 맵(fill)만 올리기', request_id: R });
    if (!docAttMagicOk(ext, b64)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MAGIC', request_id: R });
  }
  return cdocCommit(c, d, R, ref, kind, pii, orig, ext, b64, fill, null);
}
// 서류함에 넣는 공통 끝부분 — cdoc_put(본문 바이트)·cdoc_attach(넣기 박스, 이미 올라온 att). att={id,rec}: 작은 파일은 바이트를 옮기고 att를 지운다, 조각 파일은 조각을 그대로 두고 참조한다
async function cdocCommit(c, d, R, ref, kind, pii, orig, ext, b64, fill, att) {
  const st = store(DATA);
  const ld = await conLoadItem(st, ref.cid);
  if (!ld.ok) return jr(ld.http, { status: ld.http === 500 ? 'ERROR' : 'REJECTED', error_code: ld.code, request_id: R });
  const ix = await cdocIdxRead(st, ref.cid);
  if (!ix.ok) return jr(500, { status: 'ERROR', error_code: ix.code, request_id: R });
  const idx = ix.doc;
  if (idx.items.filter(function (x) { return x && !x.gc && !x.purged; }).length >= CDOC_PER_CON) return jr(409, { status: 'CONFLICT', error_code: 'RECIDX_FULL', request_id: R });   // 바이트가 지워진 옛 초안(gc)은 세지 않는다 — 자동 초안이 직원 최종본을 막지 않게
  const sha = crypto.createHash('sha256').update(b64 ? Buffer.from(b64, 'base64') : Buffer.from(JSON.stringify(fill), 'utf8')).digest('hex');
  // sha256 중복 = 같은 계약 안의 살아 있는 항목과 바이트가 같음 → 상단 노출 뒤 사람 선택(allow_dup:true로 재요청). 자동 거부·자동 병합 없음
  // v424 AI 초안과 바이트가 같은 최종본은 중복이 아니다(직원이 고치지 않고 그대로 넣은 파일 = 간극 0)
  const dup = idx.items.filter(function (x) { return x && x.sha === sha.slice(0, 16) && !x.del && !x.purged && (kind === 'draft' || x.kind !== 'draft'); }).map(cdocPublic);
  if (dup.length && d.allow_dup !== true) return jr(409, { status: 'CONFLICT', error_code: 'DUP_BYTES', dup: dup, request_id: R });
  const same = idx.items.filter(function (x) { return x && x.i === ref.i && x.dk === ref.dk && x.kind === kind && !x.purged; });
  const ver = same.length + 1;
  const n = idx.seq + 1;
  const now = Date.now();
  const corp = await cdocCorpOf(st, ld.c, ref.i);
  const std = cdocStdName(ref.cid, ref.i, ref.dk, ver, now, corp, ext);
  const fkey = cdocKey(ref.cid, ref.i, ref.dk, n);
  const rec = { name: std, orig: orig, type: (fill && !b64) ? 'application/json' : (DOC_ATT_MIME[ext] || 'application/octet-stream'), kind: kind, cid: ref.cid, i: ref.i, dk: ref.dk, n: n, ver: ver, pii: pii, by: c.member.name, bid: c.member.id, ts: now, sha: sha };
  if (fill) rec.fill = fill;
  if (att && att.rec.parts) { rec.att = att.id; rec.parts = att.rec.parts; }   // v423 큰 파일: 조각은 attp:에 그대로
  else if (b64) rec.data = b64;
  // v424 AI 초안의 표식 — 파일 안 문서 정보에 같은 번호가 들어 있다. 계약·서류가 맞을 때만 받는다
  const genP = (kind === 'draft' && typeof d.gen === 'string') ? DD.genMarkParse(d.gen) : null;
  const gen = (genP && genP.cid === ref.cid && 'gen.' + genP.tpl === ref.dk) ? d.gen : '';
  if (gen) rec.gen = gen;
  if (kind === 'draft' && d.late === true) rec.late = 1;   // v425 최종본을 올릴 때 자동으로 만든 초안(직원이 받아서 고친 것이 아니다 — 간극 해석이 다르다)
  if (kind === 'draft' && Array.isArray(d.blank)) { const bl = d.blank.filter(function (x) { return typeof x === 'string' && /^[^!]{1,40}![A-Z]{1,3}\d{1,5}$/.test(x); }).slice(0, 400); if (bl.length) rec.blank = bl; }   // 서버 사본에서 비운 사람 칸(좌표만)
  const fw = await blobSet(store(FILES), fkey, rec);
  if (!fw.ok) return jr(500, { status: 'ERROR', error_code: fw.code, request_id: R });
  same.forEach(function (x) { if (x.cur) x.cur = 0; });
  const item = { n: n, i: ref.i, dk: ref.dk, kind: kind, ver: ver, cur: 1, name: std, orig: orig || std, ext: ext, size: (fill && !b64) ? JSON.stringify(fill).length : b64Bytes(b64), sha: sha.slice(0, 16), pii: pii, corp: corp, by: { id: c.member.id, name: c.member.name }, ts: now };
  if (gen) item.gen = gen;
  if (rec.late) item.late = 1;
  if (typeof d.note === 'string' && d.note.trim()) item.note = d.note.trim().slice(0, 120);
  if (att) { item.att0 = att.id; if (att.rec.parts) item.parts = att.rec.parts; }   // v423 AI 판단 원본 parse:<att0>과 잇는 번호
  idx.items.push(item); idx.seq = n;
  // 초안 보존 상한: 같은 (단계·doc_key) 초안이 3판을 넘으면 가장 오래된 것의 바이트만 지우고 색인엔 gc 표식(append-only 유지)
  const gcd = [];
  if (kind === 'draft') {
    const drafts = idx.items.filter(function (x) { return x.i === ref.i && x.dk === ref.dk && x.kind === 'draft' && !x.gc && !x.purged; }).sort(function (a, b) { return a.n - b.n; });
    while (drafts.length > CDOC_DRAFT_KEEP) { const old = drafts.shift(); await blobDelete(store(FILES), cdocKey(ref.cid, old.i, old.dk, old.n)); old.gc = now; old.cur = 0; gcd.push(old.n); }
  }
  idx.updated_at = now; idx.updated_by = c.member.id;
  const w = await blobSet(st, cdocIdxKey(ref.cid), idx);
  if (!w.ok) { await blobDelete(store(FILES), fkey); return jr(500, { status: 'ERROR', error_code: w.code, request_id: R }); }
  const audit = await cdocAudit(c.member, '기록물등록', ref.cid, std + (dup.length ? ' · 중복 허용' : ''));
  if (att) {
    try {
      if (att.rec.parts) await blobSet(store(FILES), att.id, Object.assign({}, att.rec, { taken: { cid: ref.cid, n: n } }));   // 같은 파일을 두 번 넣지 못하게 표식(조각은 서류함이 참조)
      else await blobDelete(store(FILES), att.id);
      await blobDelete(store(FILES), boxMarkKey(att.id));
    } catch (e) {}
    await boxUsageAdd(st, 'placed', 1);
  }
  // v410 학습 짝 — 최종본이면 같은 단계의 현재 초안과 짝을 만들고 차이·간극을 잰다(실패해도 올리기는 성공, learn에 사유만)
  let learn = null;
  if (kind === 'final') { try { learn = await cdocLearnPair(st, c.member, ref, idx, item, ext, b64, orig, d); } catch (e) { learn = { ok: false, code: 'LEARN_THREW' }; } }
  if (learn) { cdocPairMeta(item, learn); await cdocIdxSetPair(st, ref.cid, n, learn); await boxUsageAdd(st, 'pair_' + String(learn.how || learn.status || learn.code || 'x').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 20), 1); }   // v423 옮기면 이 짝을 무효로 돌린다 · v424 화면용 양식·간극, 못 맺은 사유, 이번 달 경로 건수
  return jr(200, { status: 'OK', cid: ref.cid, n: n, ver: ver, name: std, item: cdocPublic(item), dup: dup, gc: gcd, audit: audit, learn: learn, request_id: R });
}
// ---- v423 넣기 박스(체크 31, PM 11/5 "서류 등록 채널 하나" · 11/6 "저장 설계는 Blobs 그대로") — 파일을 먼저 gw_files에 받고(box_put), 에이전트가 종류를 판단한 뒤(gw-parse-background), 다시 보내지 않고 서류함에 넣는다(cdoc_attach)
const BOX_PART_B64 = 4400000;      // 조각 1개 base64 상한(4의 배수 — 이어 붙이면 원본 base64). 동기 함수 본문 6MB 안쪽
const BOX_MAX_PARTS = 8;           // 8조각 ≈ 원본 26MB
const BOX_FIX_KEY = 'box:fixes';   // 사람이 고친 판단(다음 판단 프롬프트에 들어간다) — 파일 이름·개인정보 없이 종류·자리만
const BOX_FIX_MAX = 60;
function boxMarkKey(id) { return 'boxp:' + id; }   // 넣다 만 파일 표식 — 넣거나 버리면 지운다(화면을 닫아도 다시 찾을 수 있게, 자동 삭제 없음)
// 색인의 짝 정보 — 번호·양식·간극·초안 번호(좌표·비율뿐, 값 없음). 서류함 화면의 [AI 생성본 ↔ 직원 최종본] 줄이 읽는다
function cdocPairMeta(x, L) {
  if (!L.id) { x.plearn = String(L.code || ''); return; }   // 못 맺은 사유 — 서류 줄이 '짝 없음(사유)'로 보여 준다
  delete x.plearn;
  x.pair = L.id;
  if (L.tpl) x.ptpl = L.tpl;
  x.pgap = (L.gap && typeof L.gap.cell_ratio === 'number') ? L.gap.cell_ratio : null;
  if (L.kind) x.pkind = L.kind;
  if (L.draft_n) x.pdn = L.draft_n;
  if (L.how) x.phow = L.how;
  if (L.outside) x.pout = L.outside; else delete x.pout;
}
function cdocPairClear(x) { if (x.ptpl) x.pwas = x.ptpl; delete x.pair; delete x.ptpl; delete x.pgap; delete x.pkind; delete x.pdn; delete x.phow; delete x.pout; delete x.plearn; }
// 짝 정보만 다시 읽어 고쳐 쓴다 — 첫 저장과 짝 만들기 사이에 다른 사람이 쓴 색인을 덮지 않게
async function cdocIdxSetPair(st, cid, n, L) {
  try {
    const ix = await cdocIdxRead(st, cid);
    if (!ix.ok) return;
    const x = ix.doc.items.find(function (y) { return y && Number(y.n) === n; });
    if (x) { cdocPairMeta(x, L); await blobSet(st, cdocIdxKey(cid), ix.doc); }
  } catch (e) {}
}
function boxExtOk(ext) { return docAttExtOk(ext) || ext === 'xls'; }   // xls는 옛 📎 첨부가 받던 형식이라 유지
function boxMagicOk(ext, b64) {
  if (ext !== 'xls') return docAttMagicOk(ext, b64);
  try { const h = Buffer.from(String(b64 || '').slice(0, 8), 'base64'); return h[0] === 0xD0 && h[1] === 0xCF && h[2] === 0x11 && h[3] === 0xE0; } catch (e) { return false; }
}
async function boxUsageAdd(st, field, n) {
  try {
    const key = 'usage:box:' + LN.ymOf(Date.now()), r = await blobGet(st, key);
    const u = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
    u[field] = (Number(u[field]) || 0) + n;
    await blobSet(st, key, u);
  } catch (e) {}
}
async function boxFixAppend(st, row) {
  try {
    const r = await blobGet(st, BOX_FIX_KEY);
    const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
    doc.items.push(Object.assign({ ts: Date.now() }, row));
    if (doc.items.length > BOX_FIX_MAX) doc.items = doc.items.slice(-BOX_FIX_MAX);
    await blobSet(st, BOX_FIX_KEY, doc);
  } catch (e) {}
}
async function handleBoxPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const name = String(d.name || '').trim().slice(0, 120), b64 = String(d.data || ''), k = Number(d.k), j = Number(d.j);
  if (!name || !b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  if (!Number.isInteger(k) || k < 1 || k > BOX_MAX_PARTS || !Number.isInteger(j) || j < 0 || j >= k) return jr(400, { status: 'REJECTED', error_code: 'BAD_PART', request_id: R });
  if (b64.length > BOX_PART_B64) return jr(413, { status: 'REJECTED', error_code: 'PART_TOO_LARGE', request_id: R });
  const ext = docAttExt(name);
  if (!boxExtOk(ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', request_id: R });
  if (j === 0 && !boxMagicOk(ext, b64)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MAGIC', request_id: R });
  const files = store(FILES), now = Date.now();
  let id = String(d.id || ''), main = null;
  if (j === 0) id = 'att_' + crypto.randomBytes(8).toString('hex');
  else {
    if (!/^att_[a-f0-9]{16}$/i.test(id)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
    const mr = await blobGet(files, id);
    if (!mr.ok || !mr.data || mr.data.kind !== 'box' || mr.data.bid !== c.member.id || Number(mr.data.parts) !== k) return jr(409, { status: 'CONFLICT', error_code: 'BAD_UPLOAD', request_id: R });
    if (!mr.data.open) {
      if (j === k - 1) return jr(200, { status: 'OK', id: id, j: j, k: k, done: true, request_id: R });   // 마지막 조각 재전송(응답을 못 받은 경우) — 이미 끝남
      return jr(409, { status: 'CONFLICT', error_code: 'BAD_UPLOAD', request_id: R });
    }
    main = mr.data;
  }
  const head = { name: name, type: DOC_ATT_MIME[ext] || 'application/octet-stream', kind: 'box', by: c.member.name, bid: c.member.id, ts: now, size: Number(d.size) > 0 ? Math.round(Number(d.size)) : b64Bytes(b64) };
  if (k === 1) {
    const w1 = await blobSet(files, id, Object.assign(head, { data: b64 }));
    if (!w1.ok) return jr(500, { status: 'ERROR', error_code: w1.code, request_id: R });
  } else {
    const wp = await blobSet(files, BF.attPartKey(id, j), { bid: c.member.id, data: b64 });
    if (!wp.ok) return jr(500, { status: 'ERROR', error_code: wp.code, request_id: R });
    if (j === 0 || j === k - 1) {
      const m2 = Object.assign({}, main || head, { parts: k });
      if (j === k - 1) delete m2.open; else m2.open = 1;
      const wm = await blobSet(files, id, m2);
      if (!wm.ok) return jr(500, { status: 'ERROR', error_code: wm.code, request_id: R });
    }
  }
  const done = j === k - 1;
  if (j === 0) { try { await blobSet(files, boxMarkKey(id), { id: id, name: name, size: head.size, by: c.member.name, bid: c.member.id, ts: now }); } catch (e) {} }
  if (done) { try { await appendAudit({ ts: now, by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '첨부등록', id: id, t: name.slice(0, 60) }] }); } catch (e) {} }
  return jr(200, { status: 'OK', id: id, j: j, k: k, done: done, request_id: R });
}
async function handleCdocAttach(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const ref = cdocParseRef(d); if (ref.err) return jr(400, { status: 'REJECTED', error_code: ref.err, request_id: R });
  const kind = String(d.kind || '');
  if (kind !== 'final' && kind !== 'received') return jr(400, { status: 'REJECTED', error_code: 'BAD_KIND', request_id: R });
  const pii = (d.pii === undefined || d.pii === null || d.pii === '') ? 0 : Number(d.pii);
  if (!(pii === 0 || pii === 1 || pii === 2)) return jr(400, { status: 'REJECTED', error_code: 'BAD_PII', request_id: R });
  const id = String(d.att || '');
  if (!/^att_[a-f0-9]{16}$/i.test(id)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const ar = await blobGet(store(FILES), id);
  if (!ar.ok && ar.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: ar.code || 'STORAGE_READ_FAILED', request_id: R });
  if (!ar.ok || !ar.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  if (ar.data.kind !== 'box') return jr(400, { status: 'REJECTED', error_code: 'NOT_BOX', request_id: R });
  if (ar.data.taken) return jr(409, { status: 'CONFLICT', error_code: 'ALREADY_TAKEN', taken: ar.data.taken, request_id: R });
  const orig = String(ar.data.name || '').slice(0, 120), ext = docAttExt(orig);
  if (!boxExtOk(ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', request_id: R });
  let b64 = '';
  try { b64 = await BF.attReadB64(store(FILES), id, ar.data); } catch (e) { return jr(409, { status: 'CONFLICT', error_code: 'PART_MISSING', request_id: R }); }
  if (!b64) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  return cdocCommit(c, d, R, ref, kind, pii, orig, ext, b64, null, { id: id, rec: ar.data });
}
// 옮기기 — 판단이 틀렸을 때 다른 서류·종류로. 바이트 키를 새 자리로 옮기고, 옛 자리 현재본을 되돌리고, 옛 짝을 무효로 돌린 뒤, 고친 내용을 다음 판단 재료로 남긴다
async function cdocPairVoid(st, it) {
  if (!it.pair) return;
  try {
    const k = LN.pairKey('contract', it.pair), r = await blobGet(st, k);
    if (r.ok && r.data) {
      const tpl = r.data.tpl;
      r.data.status = 'superseded'; r.data.ts = Date.now();
      await blobSet(st, k, r.data);
      if (tpl) {
        const lk = LN.TYPES.contract.lessons_key(tpl), lr = await blobGet(st, lk);
        if (lr.ok && lr.data && Array.isArray(lr.data.gaps)) {
          const before = lr.data.gaps.length;
          lr.data.gaps = lr.data.gaps.filter(function (g) { return g && g.pair !== it.pair; });
          if (lr.data.gaps.length !== before) {
            if (lr.data.stats) lr.data.stats.pairs = Math.max(0, (Number(lr.data.stats.pairs) || 0) - 1);
            const bl = lr.data.baseline;   // 얼린 기준선에 든 짝이면 남은 간극으로 다시 잰다(잘못 묶인 값이 일몰 판단에 남지 않게)
            if (bl && Array.isArray(bl.pairs) && bl.pairs.indexOf(it.pair) >= 0) { delete lr.data.baseline; LN.freezeBaseline(lr.data, Date.now()); }
            await blobSet(st, lk, lr.data);
          }
        }
      }
    }
  } catch (e) {}
  cdocPairClear(it);
}
async function handleCdocMove(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const ref = cdocParseRef(d); if (ref.err) return jr(400, { status: 'REJECTED', error_code: ref.err, request_id: R });
  const n = Number(d.n), kind = String(d.kind || '');
  if (!(n >= 1)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  if (kind !== 'final' && kind !== 'received') return jr(400, { status: 'REJECTED', error_code: 'BAD_KIND', request_id: R });
  const st = store(DATA), files = store(FILES);
  const ld = await conLoadItem(st, ref.cid);
  if (!ld.ok) return jr(ld.http, { status: ld.http === 500 ? 'ERROR' : 'REJECTED', error_code: ld.code, request_id: R });
  const ix = await cdocIdxRead(st, ref.cid);
  if (!ix.ok) return jr(500, { status: 'ERROR', error_code: ix.code, request_id: R });
  const idx = ix.doc, it = idx.items.find(function (x) { return x && Number(x.n) === n; });
  if (!it || it.purged || it.gc || it.del) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  if (it.kind === 'draft') return jr(400, { status: 'REJECTED', error_code: 'BAD_KIND', request_id: R });
  if (!cdocCanRead(c.member, it)) return jr(403, { status: 'FORBIDDEN', error_code: it.pii === 2 ? 'PII2_FORBIDDEN' : 'PII_FORBIDDEN', request_id: R });
  const piiNew = (d.pii === undefined || d.pii === null || d.pii === '') ? (Number(it.pii) || 0) : Number(d.pii);
  if (!(piiNew === 0 || piiNew === 1 || piiNew === 2)) return jr(400, { status: 'REJECTED', error_code: 'BAD_PII', request_id: R });
  const sameSlot = it.i === ref.i && it.dk === ref.dk && it.kind === kind;
  if (sameSlot && piiNew === (Number(it.pii) || 0)) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
  const oldKey = cdocKey(ref.cid, it.i, it.dk, n), newKey = cdocKey(ref.cid, ref.i, ref.dk, n), sameKey = oldKey === newKey;   // 키에 종류·등급이 없어 종류만 바꾸면 같은 키다
  const r = await blobGet(files, oldKey);
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  const same = idx.items.filter(function (x) { return x !== it && x.i === ref.i && x.dk === ref.dk && x.kind === kind && !x.purged; });
  const ver = sameSlot ? it.ver : same.length + 1, corp = await cdocCorpOf(st, ld.c, ref.i), ts = Number(it.ts) || Date.now();
  const std = sameSlot ? it.name : cdocStdName(ref.cid, ref.i, ref.dk, ver, ts, corp, it.ext);
  const rec = Object.assign({}, r.data, { name: std, kind: kind, i: ref.i, dk: ref.dk, ver: ver, pii: piiNew });
  const fw = await blobSet(files, newKey, rec);
  if (!fw.ok) return jr(500, { status: 'ERROR', error_code: fw.code, request_id: R });
  if (!sameSlot) {
    const wasCur = it.cur === 1;
    const sibOld = idx.items.filter(function (x) { return x !== it && x.i === it.i && x.dk === it.dk && x.kind === it.kind && !x.del && !x.purged && !x.gc; }).sort(function (a, b) { return b.n - a.n; });
    if (wasCur && sibOld[0]) sibOld[0].cur = 1;
    same.forEach(function (x) { if (x.cur) x.cur = 0; });
    await cdocPairVoid(st, it);
    it.i = ref.i; it.dk = ref.dk; it.kind = kind; it.ver = ver; it.cur = 1; it.name = std; it.corp = corp; it.moved = Date.now();
  } else if (piiNew === 2 && it.pair) await cdocPairVoid(st, it);   // 등급만 2로 올려도 짝을 무효로(민감정보는 짝을 만들지 않는다)
  it.pii = piiNew;
  idx.updated_at = Date.now(); idx.updated_by = c.member.id;
  const w = await blobSet(st, cdocIdxKey(ref.cid), idx);
  if (!w.ok) {
    if (sameKey) await blobSet(files, oldKey, r.data); else await blobDelete(files, newKey);   // 같은 키면 지우지 말고 되돌린다
    return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  }
  if (!sameKey) await blobDelete(files, oldKey);
  const audit = await cdocAudit(c.member, sameSlot ? '기록물등급변경' : '기록물옮김', ref.cid, std);
  let learn = null;
  if (!sameSlot) {
    const fix = (d.fix && typeof d.fix === 'object') ? d.fix : {};
    const docNm = String(fix.doc || '').slice(0, 40);
    const fixSan = function (s) { const t = String(s || '').slice(0, 60); return LN.piiScan(t).ok ? t : ''; };
    await boxFixAppend(st, { k: 'doc', doc: LN.piiScan(docNm).ok ? docNm : '', from: fixSan(fix.from), to: fixSan(fix.to) });   // 파일 이름은 넣지 않는다(사람 이름이 섞일 수 있다) · 라벨도 연락처 꼴이면 뺀다
    await boxUsageAdd(st, 'moved', 1);
    if (kind === 'final') {
      try {
        const b64 = rec.att ? await BF.attReadB64(files, rec.att, (await blobGet(files, rec.att)).data) : String(rec.data || '');
        learn = await cdocLearnPair(st, c.member, ref, idx, it, it.ext, b64, it.orig, d);
        if (learn && learn.id) { cdocPairMeta(it, learn); await cdocIdxSetPair(st, ref.cid, n, learn); }
      } catch (e) { learn = { ok: false, code: 'LEARN_THREW' }; }
    }
  }
  return jr(200, { status: 'OK', cid: ref.cid, n: n, item: cdocPublic(it), learn: learn, audit: audit, request_id: R });
}
// 계약 시작 카드에서 사람이 판단을 그대로 뒀는지(ok) 고쳤는지 — 고친 것만 box:fixes에 쌓는다. 값은 유형·사급관급 같은 분류뿐
async function handleBoxFix(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const st = store(DATA), ok = d.ok === true;
  const san = function (o) { const out = {}; ['type', 'pub', 'combo', 'cls'].forEach(function (k) { if (o && typeof o === 'object' && o[k] !== undefined && o[k] !== null) out[k] = String(o[k]).slice(0, 20); }); return out; };
  await boxUsageAdd(st, ok ? 'ok' : 'fixed', 1);
  const title = String(d.title || '').slice(0, 60);
  if (!ok) await boxFixAppend(st, { k: 'contract', title: LN.piiScan(title).ok ? title : '', from: san(d.from), to: san(d.to) });   // 공사명은 관급 계약만 앱이 보낸다(사급은 개인 이름이 섞일 수 있다)
  return jr(200, { status: 'OK', request_id: R });
}
// 넣다 만 파일 — 판단 중 화면을 닫았거나 넣기 전에 멈춘 파일. 본인 것(관리자는 하루 지난 남의 것까지)을 돌려줘 카드로 다시 잇는다. 자동 삭제 없음
async function handleBoxPending(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  const files = store(FILES), l = await blobList(files, 'boxp:');
  if (!l.ok) return jr(500, { status: 'ERROR', error_code: l.code, request_id: R });
  const now = Date.now(), out = [];
  for (const k of l.keys.filter(function (x) { return x.indexOf('boxp:') === 0; }).slice(0, 200)) {
    const r = await blobGet(files, k);
    if (!r.ok || !r.data) continue;
    const m = r.data, mine = m.bid === c.member.id;
    if (!mine && !(c.member.admin && now - Number(m.ts) > 86400000)) continue;
    const ar = await blobGet(files, m.id);
    if (!ar.ok || !ar.data) { await blobDelete(files, k); continue; }   // 본 파일이 이미 없으면 표식만 정리
    if (ar.data.open) { out.push({ id: m.id, name: m.name, size: m.size, by: m.by, ts: m.ts, open: 1 }); continue; }   // 조각이 덜 온 파일 — 버리기만 가능
    const pr = await blobGet(files, 'parse:' + m.id);
    out.push({ id: m.id, name: m.name, size: m.size, by: m.by, ts: m.ts, parsed: (pr.ok && pr.data) ? pr.data.result : null });
  }
  return jr(200, { status: 'OK', items: out, request_id: R });
}
async function handleCdocList(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const cid = String(d.cid || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid)) return jr(400, { status: 'REJECTED', error_code: 'BAD_CID', request_id: R });
  if (d.trash === true && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });   // 보관함은 관리자만(열기와 같은 기준)
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const ix = await cdocIdxRead(store(DATA), cid);
  if (!ix.ok) return jr(500, { status: 'ERROR', error_code: ix.code, request_id: R });
  const all = d.all === true && !!c.member.admin;   // v408: 관리자는 보관 항목까지 한 번에(보관함 화면) — 직원은 플래그 무시
  // 열람 권한이 없는 항목은 올린 이름을 내주지 않는다(파일명에 사람 이름이 섞인다) — 표준 이름만
  const items = ix.doc.items.filter(function (x) { return x && !x.purged && (all || (d.trash === true ? !!x.del : !x.del)); }).map(function (x) { const o = cdocPublic(x); if (!cdocCanRead(c.member, x)) o.orig = o.name; return o; });
  return jr(200, { status: 'OK', cid: cid, seq: ix.doc.seq, items: items, updated_at: ix.doc.updated_at || 0, request_id: R });
}
function cdocCanRead(m, it) {
  if (!m || !it) return false;
  if (m.admin) return true;
  const p = permOf(m, 'contracts');
  if (it.pii === 2) return String(m.dept || '') === '관리부';
  if (it.pii === 1) return p === 'do';
  return p !== 'hide';
}
async function handleCdocGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const cid = String(d.cid || ''), n = Number(d.n);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid) || !(n >= 1)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA);
  const ix = await cdocIdxRead(st, cid);
  if (!ix.ok) return jr(500, { status: 'ERROR', error_code: ix.code, request_id: R });
  const it = ix.doc.items.find(function (x) { return x && Number(x.n) === n; });
  if (!it || it.purged || it.gc) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  if (it.del && !c.member.admin) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });   // 보관함(휴지통)은 관리자만 연다
  if (!cdocCanRead(c.member, it)) return jr(403, { status: 'FORBIDDEN', error_code: it.pii === 2 ? 'PII2_FORBIDDEN' : 'PII_FORBIDDEN', request_id: R });
  const reason = typeof d.reason === 'string' ? d.reason.trim().slice(0, 80) : '';
  if (it.pii === 2 && reason.length < 2) return jr(400, { status: 'REJECTED', error_code: 'REASON_REQUIRED', request_id: R });   // 민감정보 열람 사유 필수(개인정보보호법 23조 — 열람 기록)
  const r = await blobGet(store(FILES), cdocKey(cid, it.i, it.dk, n));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  if (r.data.att) {   // v423 큰 파일 — 첫 호출은 조각 수만, 열람 기록은 첫 조각에서(민감정보는 조각마다, fail-closed)
    if (d.part === undefined || d.part === null) return jr(200, { status: 'OK', cid: cid, n: n, name: it.name, orig: it.orig, kind: it.kind, pii: it.pii, type: docAttMime(it.name), parts: r.data.parts, request_id: R });
    const j = Number(d.part);
    if (!Number.isInteger(j) || j < 0 || j >= Number(r.data.parts)) return jr(400, { status: 'REJECTED', error_code: 'BAD_PART', request_id: R });
    if (j === 0 || it.pii === 2) {
      const lg = await appendRecLog(st, { ts: Date.now(), bid: c.member.id, by: String(c.member.name || ''), dept: String(c.member.dept || ''), cid: cid, n: n, i: it.i, dk: it.dk, kind: it.kind, pii: it.pii, name: String(it.name || '').slice(0, 80), reason: reason });
      if (it.pii === 2 && !lg) return jr(500, { status: 'ERROR', error_code: 'RECLOG_FAILED', request_id: R });
    }
    const pr = await blobGet(store(FILES), BF.attPartKey(r.data.att, j));
    if (!pr.ok || !pr.data) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
    return jr(200, { status: 'OK', cid: cid, n: n, part: j, parts: r.data.parts, data: pr.data.data, request_id: R });
  }
  const logged = await appendRecLog(st, { ts: Date.now(), bid: c.member.id, by: String(c.member.name || ''), dept: String(c.member.dept || ''), cid: cid, n: n, i: it.i, dk: it.dk, kind: it.kind, pii: it.pii, name: String(it.name || '').slice(0, 80), reason: reason });
  if (it.pii === 2 && !logged) return jr(500, { status: 'ERROR', error_code: 'RECLOG_FAILED', request_id: R });   // 민감정보는 기록 없이는 내주지 않는다(fail-closed)
  const out = { status: 'OK', cid: cid, n: n, name: it.name, orig: it.orig, kind: it.kind, pii: it.pii, type: (r.data.fill && !r.data.data) ? 'application/json' : docAttMime(it.name), logged: logged, request_id: R };
  if (r.data.data) out.data = r.data.data; else if (r.data.fill) out.fill = r.data.fill;   // v424 초안은 파일이 먼저(옛 초안은 채움 맵만)
  return jr(200, out);
}
// 소프트 삭제·복구·현재 포인터 — contracts 'do'. 바이트는 그대로(append-only), 색인 표식만
async function cdocMark(event, d, R, mode) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (mode === 'restore' && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });   // 복구 화면은 관리자 보관함뿐 — 복구로 '보관함은 관리자만'을 넘지 않게
  const cid = String(d.cid || ''), n = Number(d.n);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid) || !(n >= 1)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA);
  const ix = await cdocIdxRead(st, cid);
  if (!ix.ok) return jr(500, { status: 'ERROR', error_code: ix.code, request_id: R });
  const idx = ix.doc, it = idx.items.find(function (x) { return x && Number(x.n) === n; });
  if (!it || it.purged || it.gc) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  const now = Date.now();
  const sib = function () { return idx.items.filter(function (x) { return x.i === it.i && x.dk === it.dk && x.kind === it.kind && !x.del && !x.purged && !x.gc; }); };
  let op = '';
  if (mode === 'del') {
    if (it.del) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
    it.del = now; it.del_by = c.member.id; const wasCur = it.cur === 1; it.cur = 0;
    if (wasCur) { const s = sib().sort(function (a, b) { return b.n - a.n; }); if (s[0]) s[0].cur = 1; }   // 현재본을 보관하면 바로 앞 판이 현재
    if (it.pair) await cdocPairVoid(st, it);   // 잘못 들어간 파일의 간극·학습 대기가 남지 않게
    op = '기록물보관';
  } else if (mode === 'restore') {
    if (!it.del) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
    delete it.del; delete it.del_by;
    if (!sib().some(function (x) { return x.cur === 1 && x.n !== it.n; })) it.cur = 1;
    op = '기록물복구';
  } else if (mode === 'cur') {
    if (it.del) return jr(400, { status: 'REJECTED', error_code: 'IN_TRASH', request_id: R });
    if (it.cur === 1) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });
    sib().forEach(function (x) { x.cur = 0; }); it.cur = 1;
    op = '기록물현재';
  }
  idx.updated_at = now; idx.updated_by = c.member.id;
  const w = await blobSet(st, cdocIdxKey(cid), idx);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  const audit = await cdocAudit(c.member, op, cid, it.name);
  let learn = null;
  if (mode === 'restore' && it.kind === 'final') {   // 복구하면 짝을 다시 찾는다(직전 양식 우선)
    try {
      const fr = await blobGet(store(FILES), cdocKey(cid, it.i, it.dk, n));
      if (fr.ok && fr.data) {
        const b64 = fr.data.att ? await BF.attReadB64(store(FILES), fr.data.att, (await blobGet(store(FILES), fr.data.att)).data) : String(fr.data.data || '');
        learn = await cdocLearnPair(st, c.member, { cid: cid, i: it.i, dk: it.dk }, idx, it, it.ext, b64, it.orig, { pair_tpl: it.pwas || '' });
        if (learn) { cdocPairMeta(it, learn); await cdocIdxSetPair(st, cid, n, learn); }
      }
    } catch (e) { learn = { ok: false, code: 'LEARN_THREW' }; }
  }
  return jr(200, { status: 'OK', cid: cid, n: n, item: cdocPublic(it), audit: audit, learn: learn, request_id: R });
}
async function handleCdocDel(event, d, R) { return cdocMark(event, d, R, 'del'); }
async function handleCdocRestore(event, d, R) { return cdocMark(event, d, R, 'restore'); }
async function handleCdocCur(event, d, R) { return cdocMark(event, d, R, 'cur'); }
// 영구 삭제 — 관리자 + confirm:true + 보관 30일 경과(등급표 '삭제=PM 전용' R3). 바이트 제거, 색인은 purged 표식(복구 불능)
async function handleCdocPurge(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  if (d.confirm !== true) return jr(400, { status: 'REJECTED', error_code: 'CONFIRM_REQUIRED', request_id: R });
  const cid = String(d.cid || ''), n = Number(d.n);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid) || !(n >= 1)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const st = store(DATA);
  const ix = await cdocIdxRead(st, cid);
  if (!ix.ok) return jr(500, { status: 'ERROR', error_code: ix.code, request_id: R });
  const idx = ix.doc, it = idx.items.find(function (x) { return x && Number(x.n) === n; });
  if (!it || it.purged) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  if (!it.del) return jr(409, { status: 'CONFLICT', error_code: 'NOT_IN_TRASH', request_id: R });
  if (Date.now() - Number(it.del) < CDOC_TRASH_DAYS * 86400000) return jr(409, { status: 'CONFLICT', error_code: 'TOO_EARLY', days: CDOC_TRASH_DAYS, request_id: R });
  const pr0 = await blobGet(store(FILES), cdocKey(cid, it.i, it.dk, n));
  if (pr0.ok && pr0.data && pr0.data.att) {   // v423 큰 파일은 조각과 본 레코드까지
    const am = await blobGet(store(FILES), pr0.data.att);
    if (am.ok && am.data) await BF.attDeleteParts(store(FILES), pr0.data.att, am.data);
    await blobDelete(store(FILES), pr0.data.att);
  }
  if (it.att0) await blobDelete(store(FILES), 'parse:' + it.att0);   // v423 판독값도 함께(개인정보 항목의 값이 남지 않게)
  await blobDelete(store(FILES), cdocKey(cid, it.i, it.dk, n));
  it.purged = Date.now(); it.purged_by = c.member.id; it.cur = 0;
  idx.updated_at = Date.now(); idx.updated_by = c.member.id;
  const w = await blobSet(st, cdocIdxKey(cid), idx);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  const audit = await cdocAudit(c.member, '기록물영구삭제', cid, it.name);
  return jr(200, { status: 'OK', cid: cid, n: n, audit: audit, request_id: R });
}
async function handleRecLogGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const month = (typeof d.month === 'string' && /^\d{4}-\d{2}$/.test(d.month)) ? d.month : '';
  const key = recLogKey(month);
  const r = await blobGet(store(DATA), key);
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const limit = Math.min(500, Math.max(1, parseInt(d.limit, 10) || 200));
  return jr(200, { status: 'OK', month: key.slice(7), total: items.length, items: items.slice(-limit).reverse(), request_id: R });
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

// ---- 안전 설정 settings:safety(v436 — 메뉴 56 7단계 '인정·평가 칸과 회사 구분', PM 11/10 08:19 ⓐ '45방식이랑 별개 방식임. 계약탭처럼 따로 설계된거임' = 안전 설정 따로) ----
// 안전 › 현황 ⑤ 인정·평가·회사 구분이 읽는 값 한 벌. KOSHA 위험성평가 인정은 인허가 목록(col:licenses)에 행으로 넣지 않는다 — 인허가 행을 읽는 앱·서버 소비처(자동 지시·캘린더·검색·브리핑·물어보기·크론)는 무변.
//   값 = { kosha: { stage: none(미인정)·applied(접수)·review(심사)·certified(인정), apply_no(접수번호 40자), applied_on·review_on·decided_on·expires_on(YYYY-MM-DD 또는 빈칸),
//                   rate_year(요율 반영 연도 네 자리 또는 빈칸), checks: [{ date(필수), note(100자) }](사후점검 이력, 10건 상한) },
//          headcount: { env, con }(회사별 상시근로자 수 — 정수 0~999 또는 빈칸, 둘 다 있어야 현황 회사 구분이 켜짐) } + updated_at·updated_by·prev(직전 1판).
//   읽기 safety_settings_get = 로그인 → 기기 승인(403 DEVICE_NOT_APPROVED) → 관리자 또는 안전 권한(permKey 'safety' — 현황 칸·col:edu와 같은 키)이 숨김이 아니면 200, 숨김이면 403 NO_ACCESS.
//     저장값이 없으면 settings null·updated_at 0. 읽기 실패·모양이 깨진 저장값은 500(빈 값으로 '미인정(입력 전)'을 그리지 않게).
//   쓰기 safety_settings_set = 로그인 → 관리자만(403 ADMIN_ONLY — 안전 수행도 거절, 현황은 읽기 전용) → 값 검사(400 BAD_VALUE·BAD_STAGE·BAD_TEXT·BAD_DATE·BAD_YEAR·BAD_CHECKS·BAD_HEADCOUNT)
//     → 직전 읽기(실패 500 SETTINGS_READ_FAILED) → 낙관락(base가 저장된 updated_at과 다르면 409 SAFETY_STALE — base 없음도 409: 새 액션이라 base를 안 보내는 옛 앱이 없다)
//     → 같은 값 400 NO_CHANGE(정규화한 값째 비교 — 감사용 납작한 글로 비교하면 사후점검 1건 'A / B'와 2건 A·B가 같은 글이 돼 고친 것이 막힌다, v436 검토)
//     → 저장(prev = 직전 1판) → 감사 1줄(col safety · op 안전설정 · 바뀐 칸 f — 사후점검은 'n건 · 뺌 …' → 'm건 · 더함 …'). 이 키 이름을 쓰는 서버 코드는 이 두 핸들러뿐(uismoke v436 대조) —
//     백업 내보내기·복원(backup_list·backup_get·backup_put)은 키 이름 없이 gw_data 키 전부를 다룬다(복원한 값도 safetyRead가 다시 검사해 깨졌으면 500 · v453부터 settings:*는 재해 복원 모드에서만 복원).
//   알려진 한계(기존 settings:assign·notify·문서함 설정 핸들러와 같은 꼴): 읽기 → base 검사 → 쓰기가 원자적이지 않아, 두 관리자가 같은 base로 거의 동시에 저장하면 둘 다 200이고 마지막 쓰기가 이긴다
//     (먼저 쓴 값은 prev에도 안 남고 감사 2줄로만 드러남 — @netlify/blobs 8.2.0에 조건부 쓰기가 없다. 원자화는 조건부 쓰기를 들일 때 settings 핸들러 전체를 함께).
const SAFETY_KEY = 'settings:safety';
const SAFETY_STAGES = ['none', 'applied', 'review', 'certified'];
const SAFETY_STAGE_LABEL = { none: '미인정', applied: '접수', review: '심사', certified: '인정' };
const SAFETY_DATES = ['applied_on', 'review_on', 'decided_on', 'expires_on'];
const SAFETY_LIMIT = { apply_no: 40, note: 100, checks: 10, head: 999 };
const SAFETY_FIELD_LABEL = { 'kosha.stage': 'KOSHA 단계', 'kosha.apply_no': '접수번호', 'kosha.applied_on': '접수일', 'kosha.review_on': '심사일', 'kosha.decided_on': '인정일(결정일)', 'kosha.expires_on': '만료일',
  'kosha.rate_year': '요율 연도', 'kosha.checks': '사후점검', 'headcount.env': '상시근로자 종운환경', 'headcount.con': '상시근로자 종운건설' };
// 키 이름으로 권한 — permOf는 컬렉션 이름을 받는다(COL에 없는 'safety'를 넘기면 기본 '보기'가 돼 숨김이 새어 나간다). 규칙은 permOf와 같다(관리자 do · perms[키] · 값 없으면 기본 숨김 표 PERM_CLOSED)
function permKey(member, key) {
  if (member.admin) return 'do';
  return (member.perms && member.perms[key]) || (PERM_CLOSED[key] ? 'hide' : 'view');
}
function safetyDate(v) {   // 빈칸 또는 달력에 있는 날짜 YYYY-MM-DD → 그 글 · 아니면 null
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = new Date(v + 'T00:00:00Z');
  return (!isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v) ? v : null;
}
function safetyText(v, max) {   // 빈칸 허용 글(앞뒤 공백 정리) — 글이 아니거나 너무 길면 null
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > max ? null : s;
}
function safetyHead(v) {   // 상시근로자 수 — 정수 0~999(숫자 또는 숫자 글) 또는 빈칸('') · 아니면 null
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') { const s = v.trim(); return /^\d{1,3}$/.test(s) ? Number(s) : null; }
  return (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SAFETY_LIMIT.head) ? v : null;
}
function safetyYear(v) {   // 요율 반영 연도 — 네 자리(2000~2100) 또는 빈칸 · 아니면 null
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return (y >= 2000 && y <= 2100) ? s : null;
}
// 요청 몸체(또는 저장값) → { v } | { code } — 알려진 칸만 다시 만든다(모르는 칸은 버림)
function safetyClean(d) {
  const k = d && d.kosha, h = d && d.headcount;
  if (!k || typeof k !== 'object' || Array.isArray(k) || !h || typeof h !== 'object' || Array.isArray(h)) return { code: 'BAD_VALUE' };
  if (typeof k.stage !== 'string' || SAFETY_STAGES.indexOf(k.stage) < 0) return { code: 'BAD_STAGE' };
  const kosha = { stage: k.stage };
  const no = safetyText(k.apply_no, SAFETY_LIMIT.apply_no);
  if (no === null) return { code: 'BAD_TEXT' };
  kosha.apply_no = no;
  for (const dk of SAFETY_DATES) { const dv = safetyDate(k[dk]); if (dv === null) return { code: 'BAD_DATE' }; kosha[dk] = dv; }
  const ry = safetyYear(k.rate_year);
  if (ry === null) return { code: 'BAD_YEAR' };
  kosha.rate_year = ry;
  const cs = (k.checks === undefined || k.checks === null) ? [] : k.checks;
  if (!Array.isArray(cs) || cs.length > SAFETY_LIMIT.checks) return { code: 'BAD_CHECKS' };
  kosha.checks = [];
  for (const x of cs) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { code: 'BAD_CHECKS' };
    const cd = safetyDate(x.date), cn = safetyText(x.note, SAFETY_LIMIT.note);
    if (!cd || cn === null) return { code: 'BAD_CHECKS' };   // 사후점검 줄은 날짜 필수
    kosha.checks.push({ date: cd, note: cn });
  }
  const env = safetyHead(h.env), con = safetyHead(h.con);
  if (env === null || con === null) return { code: 'BAD_HEADCOUNT' };
  return { v: { kosha: kosha, headcount: { env: env, con: con } } };
}
// { ok, doc|null, v|null, at, by } — 읽기 실패·모양이 깨진 저장값은 ok:false(빈 값으로 덮거나 '입력 전'으로 그리지 않게). 없는 키(실 Blobs ok·data null) = 입력 전
async function safetyRead(st) {
  const r = await blobGet(st, SAFETY_KEY);
  if (!r.ok) return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, doc: null, v: null, at: 0, by: '' };
  if (typeof r.data !== 'object' || Array.isArray(r.data)) return { ok: false, code: 'SETTINGS_INVALID' };
  const c = safetyClean(r.data);
  if (!c.v) return { ok: false, code: 'SETTINGS_INVALID' };
  return { ok: true, doc: r.data, v: c.v, at: Number(r.data.updated_at) || 0, by: String(r.data.updated_by || '') };
}
function safetyOut(s, R) {   // 읽기·쓰기 응답 같은 꼴 — 앱 sfSetApply가 그대로 받는다
  const p = s.doc && s.doc.prev;
  return jr(200, { status: 'OK', settings: s.v, updated_at: s.at, updated_by: s.by, prev: p ? { updated_at: Number(p.updated_at) || 0, updated_by: String(p.updated_by || '') } : null, request_id: R });
}
// 사후점검 한 건 = 줄 글 '날짜 메모'(날짜는 늘 YYYY-MM-DD 10자 · 메모는 앞뒤 공백을 정리해 둠 — 줄 글과 한 건이 1:1)
function safetyCheckLines(v) {
  const cs = (v && v.kosha && Array.isArray(v.kosha.checks)) ? v.kosha.checks : [];
  return cs.map(function (x) { return x.date + (x.note ? ' ' + x.note : ''); });
}
function safetyFlat(v) {   // 감사 줄 비교용 납작한 글 — 저장값이 없으면 단계 '(입력 전)' · 사후점검은 건수만(바뀐 줄은 safetyDiff가 줄 목록으로)
  const k = (v && v.kosha) || {}, h = (v && v.headcount) || {};
  return { 'kosha.stage': v ? (SAFETY_STAGE_LABEL[k.stage] || '') : '(입력 전)', 'kosha.apply_no': k.apply_no || '', 'kosha.applied_on': k.applied_on || '', 'kosha.review_on': k.review_on || '',
    'kosha.decided_on': k.decided_on || '', 'kosha.expires_on': k.expires_on || '', 'kosha.rate_year': k.rate_year || '',
    'kosha.checks': safetyCheckLines(v).length + '건',
    'headcount.env': (h.env === '' || h.env === undefined) ? '' : String(h.env), 'headcount.con': (h.con === '' || h.con === undefined) ? '' : String(h.con) };
}
// { 칸: [이전, 새] } — 감사 로그 ev.f 규약(값 80자 절단). 사후점검은 줄 목록으로 비교: 'n건 · 뺌 …' → 'm건 · 더함 …'(같은 줄 여럿은 개수까지 — 다중 집합 차이),
//   뺀 줄·더한 줄이 없으면 '순서만 바뀜'. 이어 붙인 한 글을 80자에서 자르면 긴 이력의 뒤쪽 줄을 고쳐도 이전·새 값이 같게 찍혔다(v436 검토)
function safetyDiff(a, b) {
  const fa = safetyFlat(a), fb = safetyFlat(b), la = safetyCheckLines(a), lb = safetyCheckLines(b), out = {};
  Object.keys(fb).forEach(function (k) {
    if (k === 'kosha.checks') {
      if (JSON.stringify(la) === JSON.stringify(lb)) return;
      const added = lb.slice(), gone = [];
      la.forEach(function (x) { const i = added.indexOf(x); if (i >= 0) added.splice(i, 1); else gone.push(x); });
      out[k] = [(fa[k] + (gone.length ? ' · 뺌 ' + gone.join(' / ') : '')).slice(0, 80),
        (fb[k] + (added.length ? ' · 더함 ' + added.join(' / ') : (gone.length ? '' : ' · 순서만 바뀜'))).slice(0, 80)];
      return;
    }
    if (fa[k] !== fb[k]) out[k] = [fa[k].slice(0, 80), fb[k].slice(0, 80)];
  });
  return out;
}
async function handleSafetySettingsGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (permKey(c.member, 'safety') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const s = await safetyRead(store(DATA));
  if (!s.ok) return jr(500, { status: 'ERROR', error_code: s.code, request_id: R });
  return safetyOut(s, R);
}
async function handleSafetySettingsSet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });   // 안전 수행(권민지)도 거절 — 현황은 읽기 전용, 고치기는 관리자
  const nv = safetyClean(d);
  if (!nv.v) return jr(400, { status: 'REJECTED', error_code: nv.code, request_id: R });
  const st = store(DATA);
  const cur = await safetyRead(st);
  if (!cur.ok) return jr(500, { status: 'ERROR', error_code: 'SETTINGS_READ_FAILED', request_id: R });   // 읽기 실패 위에 쓰면 저장돼 있던 값이 사라진다 — 거부
  if (d.base === undefined || Number(d.base) !== cur.at) return jr(409, { status: 'CONFLICT', error_code: 'SAFETY_STALE', request_id: R });
  if (cur.v && JSON.stringify(cur.v) === JSON.stringify(nv.v)) return jr(400, { status: 'REJECTED', error_code: 'NO_CHANGE', request_id: R });   // 정규화한 값째(safetyClean이 칸 순서를 고정) — 감사 글은 판정에 안 씀
  const chg = safetyDiff(cur.v, nv.v);
  const doc = { schema: 1, kosha: nv.v.kosha, headcount: nv.v.headcount, prev: cur.doc ? { kosha: cur.v.kosha, headcount: cur.v.headcount, updated_at: cur.at, updated_by: cur.by } : null,
    updated_by: c.member.id, updated_at: Math.max(Date.now(), cur.at + 1) };   // 같은 ms 두 저장도 낙관락 토큰이 달라지게
  const w = await blobSet(st, SAFETY_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  const t = Object.keys(chg).map(function (k) { return SAFETY_FIELD_LABEL[k] + ' ' + (chg[k][0] || '—') + '→' + (chg[k][1] || '—'); }).join(' · ').slice(0, 300);
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'safety', ev: [{ op: '안전설정', id: SAFETY_KEY, t: t, f: chg }] }); } catch (e) {}
  return safetyOut({ doc: doc, v: nv.v, at: doc.updated_at, by: doc.updated_by }, R);
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
  // boss_present — 대표(tier boss) 존재 여부(표시용 — 9/6 검증 S2로 결재 폴백은 없다: 대표 0명이면 ③·총정리는 잠기고 클라도 버튼을 열지 않는다). 관리자에게만 계산(회원 블롭 스캔 1회)
  // pm_present — tier pm 존재 여부(①·② 1단계는 pm 전용인데, 0명이면 관리자 전원에게 연다 — 서버 PM_ONLY 게이트와 같은 축)
  const tcL = c.member.admin ? await push.tierCtx() : null;
  const bossN = tcL ? tcL.bossIds.length : 0;
  const pmN = tcL ? tcL.pmIds.length : 0;
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
// 휴가(휴가 모듈 승인·총정리 읽기 합산), 전결총정리(크론), 월말명세서(29 판⑤ — 월말명세서 탭 월 보드 [대표 결재 상신]). 기안 화면(index APPR_DRAFT_EXCLUDE)과 같은 목록이어야 한다(uismoke 대조).
const APPR_SELF_DECIDE_EXCLUDE = { '지시': 1, '운반일지': 1, '문서함 등재': 1, '휴가': 1, '전결총정리': 1, '월말명세서': 1 };   // 지시는 지시 탭 전용(담당 완료→승인 흐름·ref=지시 id) — 기안 화면·전결 대상 아님(low8)
// 전결 거부 응답(v321 관리자 등급) — 관리자 등급(admin, 예: 관리부)은 403 PM_ONLY(권한 없음·클라는 [전결 종결] 버튼 자체를 숨긴다), 직원·대표는 종전 400 SELF_DECIDE_PM_ONLY(전결 대상 아님)
function apprSelfDecideDeny(myTier, R) {   // myTier = push.tierCtx().tierOf(요청자) — 명시 tier 기준(9/6 검증 S1)
  if (myTier === 'admin') return jr(403, { status: 'FORBIDDEN', error_code: 'PM_ONLY', request_id: R });
  return jr(400, { status: 'REJECTED', error_code: 'SELF_DECIDE_PM_ONLY', request_id: R });
}
// 등급 컨텍스트 기반 **알림** 수신자: 대표 큐=대표(0명이면 관리자 전원에게 알려 부재를 드러냄 — 결재 게이트는 폴백 없음) / PM 큐=pm(0명이면 관리자 전원 — 게이트 폴백과 같은 축)
function tcBossOrAdmin(tc) { return tc.bossIds.length ? tc.bossIds : tc.adminIds; }
function tcPmOrAdmin(tc) { return tc.pmIds.length ? tc.pmIds : tc.adminIds; }
async function handleApprovalCreate(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
  const title = String(d.title || '').trim().slice(0, 120);
  if (!title) return jr(400, { status: 'REJECTED', error_code: 'NO_TITLE', request_id: R });
  const kind0 = String(d.kind || '일반').slice(0, 20);
  if (kind0 === '전결총정리') return jr(400, { status: 'REJECTED', error_code: 'SYSTEM_KIND', request_id: R });   // 크론 전용 kind — 사용자 기안 불가(§3.3)
  // 29 판⑤ 월말명세서 사장님 보고: 월말명세서 수행 권한자만(gw-stmt stmtPerm과 같은 규칙 — 관리자 수행 · perms.stmt · 값 없음 = 숨김) · ref는 'stmt:달:veh' 꼴만.
  //   거꾸로 stmt: ref는 이 종류만 — 아래 정정 흡수(dupOpenRef)가 같은 ref의 열린 카드를 고쳐 쓰므로, 다른 종류가 그 ref로 사장님 보고 카드를 덮지 못하게
  const refRaw = String(d.ref || '');
  if (kind0 === '월말명세서') {
    const sp = c.member.admin ? 'do' : ((c.member.perms && c.member.perms.stmt) || 'hide');
    if (sp !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
    if (!c.member.admin && c.member.perms && c.member.perms.veh === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_VEH_ACCESS', request_id: R });   // gw-stmt와 같은 규칙(차량 숨김이면 명세서 동작 전부 거절 — 보고 카드도)
    if (!/^stmt:20\d{2}-(0[1-9]|1[0-2]):veh$/.test(refRaw)) return jr(400, { status: 'REJECTED', error_code: 'BAD_REF', request_id: R });   // 달 꼴 = _lib/stmt RE_YM
  } else if (refRaw.indexOf('stmt:') === 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_REF', request_id: R });
  // 전결 종결(v315, PM 9/4 "사규·가족친화 결재는 어딨노"): 기안자가 비대표 관리자(PM)이고 ① 등급이면 기안=결재 —
  // 카드 생성과 '승인' 기록을 한 번의 쓰기로(create+decide 두 번 왕복 금지, 결재 큐에 잠깐이라도 뜨지 않게).
  // 거부는 전부 400(클라가 [상신]으로 되돌리게): 비관리자·대표(대표는 기안 대상 아님) / ②·③·미정 등급 / 전용 경로가 있는 종류
  const selfDecide = !!d.self_decide;
  const tc = await push.tierCtx();   // 관리자 등급 컨텍스트(명시 tier·부트스트랩·퇴사 제외) — 전결 게이트·apprCreateItem 자동통과·수신자 판정에 같은 스캔을 쓴다
  const myT = tc.tierOf(c.member);
  if (selfDecide) {
    if (myT !== 'pm') return apprSelfDecideDeny(myT, R);   // 전결 = tier pm만(v321, 명시 등급 기준)
    if (APPR_SELF_DECIDE_EXCLUDE[kind0]) return jr(400, { status: 'REJECTED', error_code: 'SELF_DECIDE_KIND', request_id: R });
  }
  const r = await apprCreateItem(store(DATA), c.member, { kind: kind0, title: title, body: d.body, ref: d.ref, cid: d.cid, boss_up: !!d.boss_up, self_decide: selfDecide, tc: tc });
  if (!r.ok) return jr((r.http === 400 || r.http === 403) ? r.http : 500, { status: r.http === 400 ? 'REJECTED' : (r.http === 403 ? 'FORBIDDEN' : 'ERROR'), error_code: r.code, request_id: R });
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
  // 29 판⑤: 월말명세서 보고(ref stmt:달:veh)도 같은 길 — 결재 대기·보류 중에 늦게 온 거래처를 확정해 다시 올리면 새 카드가 아니라 그 카드를 고친 판으로(대표 결재함에 같은 달 카드 두 장 금지).
  //   stmt:는 같은 종류(월말명세서)만 흡수(ab:는 종전 그대로)
  function dupOpenRef(items) {
    const isAb = refIn.indexOf('ab:') === 0, isStmt = refIn.indexOf('stmt:') === 0;
    if (!isAb && !isStmt) return null;
    return items.find(function (x) { return x && x.ref === refIn && (x.status === '대기' || x.status === '보류') && (isAb || x.kind === kind0); }) || null;
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
  const tc = o.tc || await push.tierCtx();   // 호출자가 넘긴 등급 컨텍스트(handleApprovalCreate) 또는 여기서 1회 스캔(서버 내부 훅) — 명시 tier 기준(9/6 검증 S1)
  const memberT = tc.tierOf(member);
  if (selfDecide) {
    if (memberT !== 'pm') return (memberT === 'admin') ? { ok: false, code: 'PM_ONLY', http: 403 } : { ok: false, code: 'SELF_DECIDE_PM_ONLY', http: 400 };   // 전결 = tier pm만(v321)
    if (grade !== 1) return { ok: false, code: 'SELF_DECIDE_GRADE1_ONLY', http: 400 };
    if (refIn.indexOf('ab:') === 0 || refIn.indexOf('stmt:') === 0) return { ok: false, code: 'SELF_DECIDE_KIND', http: 400 };   // 운반일지·월말명세서(29 판⑤) ref는 정정 흡수 경로(dupOpenRef) — 전결과 섞이지 않게
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
      const uids = (apprBossOnly(dr2) ? tcBossOrAdmin(tc) : tc.adminIds).filter(function (id) { return id !== member.id; });
      await push.sendTo(uids, { title: '결재 요청(정정): ' + title.slice(0, 40), body: '[' + dr2.kind + '] 정정 ' + member.name, url: './', tag: 'appr-' + dr2.id },
        dr2.kind === '운반일지' ? { ctx: tc } : { ctx: tc, primaryOnly: true });
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
    // PM(tier pm) 자기 기안 ②는 PM 단계 자동통과(§1·§4.3) — 자기 결재 단계를 없애고 chain에 명시(감사 논란 방지, §11).
    // 관리자 등급(admin)의 ② 기안은 자동통과 없이 PM 큐로(v321 — PM 단계 결재 권한이 없으므로 건너뛸 자기 단계가 없다)
    if (grade === 2 && memberT === 'pm') {
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
    const ids = (apprBossOnly(item) ? tcBossOrAdmin(tc)
      : (item.grade ? tcPmOrAdmin(tc) : tc.adminIds)).filter(function (id) { return id !== member.id; });
    await push.sendTo(ids, { title: '결재 요청: ' + title.slice(0, 40), body: '[' + item.kind + '] 기안 ' + member.name, url: './', tag: 'appr-' + item.id },
      item.kind === '운반일지' ? { ctx: tc } : { ctx: tc, primaryOnly: true });
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
  // 대표(tier boss) 0명이어도 폴백 없음(9/6 검증 S2 — 종전 v310 폴백은 boss가 비는 순간 관리자 전원에게 ③·총정리를 열었다). 대표가 비면 ③은 보류만 가능하고 회원 등급 지정(tier boss)으로 푼다
  const tc = await push.tierCtx();   // 명시 tier·부트스트랩·퇴사 제외 — 요청자 등급·pm 수·통지 수신자를 한 스캔으로
  const myT = tc.tierOf(c.member);
  if (apprBossOnly(pre) && decision !== '보류' && myT !== 'boss') return jr(403, { status: 'FORBIDDEN', error_code: 'BOSS_ONLY', request_id: R });
  // ---- 결재 3차 등급 게이트(명세 §4.1) — 위 BOSS_ONLY(대표 큐)와 함께 게이트 표를 이룬다. 구건(grade 없음)은 여기 전부 통과(현행 admin) ----
  const preGrade = (pre.grade === 1 || pre.grade === 2 || pre.grade === 3) ? pre.grade : ((pre.to === 'boss' && pre.kind === '운반일지') ? 3 : 0);   // v308 구건 운반일지=③ 간주(§6)
  const preQ = pre.to || 'pm';
  // [확인]은 전결총정리 전용(§5 — 승인과 같은 처리·"열람 확인" 성격), 전결총정리는 [확인]만(반려·보류 버튼 없음)
  if (decision === '확인' && pre.kind !== '전결총정리') return jr(400, { status: 'REJECTED', error_code: 'CONFIRM_ONLY_SUMMARY', request_id: R });
  if (pre.kind === '전결총정리' && decision !== '확인') return jr(400, { status: 'REJECTED', error_code: 'SUMMARY_CONFIRM_ONLY', request_id: R });
  // ①·② 1단계(PM 큐)=tier pm만(v321 — 대표는 건별 관여 없음(① 정의), 관리자 등급 admin은 결재 전결 권한 없음). tier pm이 0명이면 관리자 전원에게 연다(교착 방지, BOSS_ONLY 폴백과 대칭)
  if (preGrade && preQ === 'pm' && myT !== 'pm' && tc.pmIds.length) return jr(403, { status: 'FORBIDDEN', error_code: 'PM_ONLY', request_id: R });
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
      const bIds = tcBossOrAdmin(tc).filter(function (id) { return id !== c.member.id; });
      await push.sendTo(bIds, { title: '결재 요청: ' + String(it.title || '').slice(0, 40),
        body: '[' + it.kind + '] PM 승인 완료 → 대표 (2/2)', url: './', tag: 'appr-' + it.id }, { ctx: tc, primaryOnly: true });
      if (it.by && it.by.id && it.by.id !== c.member.id && it.by.id !== '__system__')
        await push.sendTo([it.by.id], { title: '결재 진행: ' + String(it.title || '').slice(0, 40),
          body: 'PM 승인 완료 · 대표 대기', url: './', tag: 'appr-' + it.id }, { ctx: tc, logOnly: true });
    } else if (it.kind !== '전결총정리') {
      const isSys = !!(it.by && it.by.id === '__system__');
      const toIds = isSys
        ? tc.adminIds.filter(function (id) { return id !== c.member.id; })
        : ((it.by && it.by.id && it.by.id !== c.member.id) ? [it.by.id] : []);
      if (toIds.length || isSys)   // 자동상신은 대상이 없어도(1인 관리자) 호출 — sendTo가 알림함 이력(push:log)은 남긴다
        await push.sendTo(toIds, { title: '결재 ' + decision + ': ' + String(it.title || '').slice(0, 40) + (isSys ? ' (자동상신)' : ''),
          body: reason ? '사유: ' + reason.slice(0, 150) : (decision === '승인' ? '승인되었습니다' : ''), url: './', tag: 'appr-' + it.id },
          (isSys || itGrade) ? { ctx: tc, primaryOnly: true } : { ctx: tc });   // 등급 건·자동상신 결과는 우선기기 1발(결정 ③), 구건은 현행(전 기기). ctx 재사용 — 결재 1건에 회원 전수 재스캔이 2~3회 붙던 것 제거
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
    let s = '';
    // 로컬 파일 헤더(PK\x03\x04) 순회 — Deflate(방법8)만 처리(풀기는 docdiff zipBudget 한 곳)
    let i = 0;
    const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (sig < 0) return '';
    // 간이 파서: 각 로컬헤더에서 압축크기·이름·데이터 오프셋 계산
    let p = 0, cnt = 0;
    const bud = DD.zipBudget();   // v456 검토: 파일 하나에서 푸는 총량·항목 수 상한(docdiff zipEntries와 같은 예산 — 항목당 상한만이면 64MB 항목 여럿이 s에 계속 이어 붙었다)
    while (p + 30 <= buf.length && cnt++ < DD.ZIP_ENTRIES_MAX && bud.left() > 0) {
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
          const raw = method === 8 ? bud.inflate(data) : bud.take(data);   // v456 C066 항목당 64MB(DD.ZIP_ENTRY_MAX) + 검토: 총량 예산(넘는 항목은 null — 건너뜀)
          if (raw) s += ' ' + raw.toString('utf8').replace(/<[^>]+>/g, ' ');
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
  if (String(d.kind || '') === 'lic') return await handleLicAttPut(event, d, R, c);   // P1 판28 인허가 수령본 — 좁은 갈래(권한·확장자·크기는 그 함수)
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
  if (r.data.kind === 'lic') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });   // P1 판28 검토 1: 인허가 수령본은 판독하지 않는다(판독 결과가 계약 권한으로 읽힘)
  let parsed = null;
  try { parsed = await parseAttachment(r.data); } catch (e) { parsed = { error: 'PARSE_FAILED' }; }
  await blobSet(store(FILES), 'parse:' + id, { ts: Date.now(), result: parsed });
  return jr(200, { status: 'OK', parsed: parsed, request_id: R });
}

// 백그라운드 판독 결과 조회(폴링)
async function handleAttParseStatus(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  if (/^att_[a-f0-9]{16}$/i.test(String(d.id || ''))) {   // P1 판28 검토 1: 인허가 수령본 id면 판독 결과(옛 캐시 포함)를 내주지 않는다
    const fr = await blobGet(store(FILES), String(d.id));
    if (fr.ok && fr.data && fr.data.kind === 'lic') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  }
  const r = await blobGet(store(FILES), 'parse:' + String(d.id || ''));
  if (!r.ok || !r.data) return jr(200, { status: 'PENDING', request_id: R });
  if (r.data.bid && r.data.bid !== c.member.id && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'NOT_OWNER', request_id: R });   // v423 넣기 박스 판독값은 올린 사람·관리자만
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
  return botKeyOk(d.secret);   // v453 상수시간(종전 '===' — 앞뒤 공백은 다른 봇 경로처럼 걷음)
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
  // v453 키 이름 검사 — 'x/../push:keys'·'../site:gw_users/member:<id>'가 SDK URL 정리로 민감키·다른 스토어로 접혀 아래 반출 차단·PIN 지우기를 비켜 가던 길(_lib/blobkey.js)
  if (badBlobKey(key)) return jr(400, { status: 'REJECTED', error_code: 'BAD_KEY', request_id: R });
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

// v426 PC 예약 작업 흔적 — 첨부 증분 백업(collectors/files_backup.py)이 끝나면 남긴다. watch.py가 cron_map 'stamp'로 신선도를 본다(PC가 꺼져 있어도 경보가 나게)
const BACKUP_STAMP_FN = { files_backup: 1 };
async function handleBackupStamp(event, d, R) {
  if (!backupAuthed(d)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_SECRET', request_id: R });
  const fn = String(d.fn || '');
  if (!BACKUP_STAMP_FN[fn]) return jr(400, { status: 'REJECTED', error_code: 'BAD_FN', request_id: R });
  await require('./_lib/cronstamp').stamp(fn, { state: 'end', ok: d.ok === true, note: String(d.note || '').slice(0, 120), n: Number(d.n) || 0, bytes: Number(d.bytes) || 0 });
  return jr(200, { status: 'OK', request_id: R });
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
// v453(보안 재감사 ⑧ — 원장 C093 · 그룹웨어 규정 15조 '감사 로그 수정·삭제 금지'): 종전 backup_put은 관리자 세션·봇 키로 gw_users·gw_data 아무 키나 덮었다 —
//   ① 회원 복원이 PIN·admin만 지켜 관리자가 자기 레코드에 dev:true·tier를 넣으면 개발자·boss가 됐고(gw-auth SELF_CHANGE_FORBIDDEN·DEV_ONLY 우회)
//   ② 감사 로그 키(audit:YYYY-MM)를 통째로 덮을 수 있었고 ③ 전용 함수·감사가 있는 설정 키(settings:* — autotask·notify·assign·doneif 등)를 감사 없이 바꿀 수 있었다.
//   지금: 이 갈래(gw_users 전부 · gw_data 기록 키 audit:*·doclog:*·reclog:*·clog:*(contract·appr) · gw_data settings:*)는 '재해 복원 모드'(봇 키 + restore:true + confirm)에서만 쓴다 —
//     관리자 세션이나 봇 키만으로는 403 RESTORE_MODE_ONLY. 키 이름은 먼저 badBlobKey로 거른다(400 BAD_KEY — 'x/../settings:autotask' 같은 키가 SDK URL 정리로 접히던 길).
//     · 회원(member:*): 지금 레코드가 있으면 권한 칸(BACKUP_MEMBER_AUTH — PIN 두 칸·admin·dev·tier·perms)은 늘 지금 값(없던 칸은 없게),
//       신원 칸(BACKUP_MEMBER_IDENT — name·uid·role·dept)은 지금 값이 있으면 지금 값·없을 때만(부분 레코드) 백업 값, id는 지금 id 또는 키,
//       leave_date는 지금 값이 있으면 지금 값·없을 때 백업 값은 오늘(KST) 이후만, del은 해제만(실수로 지운 회원 되살리기 — 감사 note 'del 해제' · 이름·uid 색인 name:·uid:도
//       같은 묶음으로 복원해야 로그인된다) · 결과 명부 개발자 0·유효 pm 0이면 409 LAST_DEV·LAST_PM — 그래서 봇 키로도 재직 회원을 끄거나 권한을 올리지 못한다.
//       지금 레코드가 있을 때 admin·dev·tier·perms는 올라가지 않는다(바꿀 것은 member_upsert로). 지금 레코드가 없으면 PIN 없음·admin·dev false·tier 없음·id는 키에서,
//       perms는 백업 값(재해 복구에 필요 — 감사 note에 칸·값을 남김 · admin false라 PIN을 세우고 관리자를 켤 때 함께 본다).
//     · 기록 키는 붙이기만(backupLogMerge): 지금 줄은 지우거나 고치지 않고 백업에만 있는 줄(restored 칸을 뺀 JSON이 같으면 같은 줄)을 더하며, 더한 줄마다 서버가 restored:<복원 시각>을 붙인다
//       (되살린 줄을 진짜 기록과 구별 — 위조 줄도 이 표식을 벗지 못한다) · 합친 줄은 ts로 안정 정렬(내용·줄 수 그대로) · 미래 시각 줄·꼴이 틀린 줄은 400 ·
//       합쳐서 월 상한(audit = _lib/audit.js MAX_PER_MONTH · doclog DOCLOG_MAX · reclog RECLOG_MAX)을 넘으면 400 AUDIT_FULL — 이번 달 감사 키(auditKey())는 이 핸들러가 뒤이어 쓰는
//       '재해복원' 1줄 자리를 남긴다(상한 꽉 채우면 그 1줄이 가장 오래된 진짜 줄을 밀어내므로).
//       알려진 한계: 읽기 → 병합 → 쓰기 사이에 앱의 appendAudit이 같은 달 키에 쓴 줄은 덮일 수 있다(appendAudit도 같은 읽고-쓰기 — 조건부 쓰기가 없는 SDK). 재해 복원은 앱 사용이 없는 때에.
//     · clog:*(해시 체인 — clog:contract·clog:contract:YYYY-MM은 첫 줄 p '' 엄격, clog:appr:YYYY-MM은 상한에서 앞이 잘려 시작 p 허용 · 상한 CON_CLOG_MAX·CON_CLOG_MONTH_MAX·DONEIF.CLOG_MAX):
//       백업 체인이 온전해야(아니면 400 CLOG_CHAIN_BAD) · 지금 체인 뒤를 잇는 백업이면 그 뒤 줄만 붙이고, 백업이 같거나 짧으면 400 CLOG_NOT_AHEAD,
//       갈라졌거나 지금 체인이 깨졌으면 지금 줄을 버리지 않고 다시 잇는다(backupClogMerge — rechained 표식 · 문서 restored 범위 · 감사 from/to) · 상한 넘으면 400 CLOG_FULL.
//     · settings:autotask는 스위치를 live로 올리지 않는다(백업 live → 지금이 live가 아니면 dry · 감사 '스위치 live 복원 안 함').
//     · 지금 값 일시 읽기 실패는 500(덮지 않음) · 깨진 지금 값(STORAGE_PARSE_FAILED)은 교체(감사 '깨진 지금 값 교체').
//     · 재해 복원 모드 쓰기는 감사 op '재해복원' 1줄(키·건수 · 회원이면 바뀐 칸·지킨 칸 이름 — 값 없음 · 기록 키면 붙인 줄 수).
//   그 밖 키(allbaro:xlsx:* 운반일지 엑셀 — logsheet_daily 봇 · tpl:*·proof:*·col:* 등)는 봇 키 + confirm('백업복원' 1줄) — v456(C107)부터 관리자 세션은 미리보기만(쓰기 403 BOT_KEY_ONLY). push:keys는 늘 거부.
//   dry 미리보기는 누구에게나 — restore_only로 재해 복원 모드가 필요한 키인지 알려 주고, 이 갈래는 쓰기와 같은 판정을 돌려 preview.merge·preview.member·would_error(거절 코드)를 준다(쓰지 않음).
//   호출처(v453 전수 — 앱 index.html에는 없음): appdata collectors/restore.py(재해 복원 --key/--confirm · --selftest 'restore:selftest') · collectors/logsheet_daily.py(allbaro:xlsx:<날>만) · tools/servertest.mjs.
//     restore.py가 restore:true를 보내야 위 갈래 재해 복원이 열린다(appdata 쪽 수정 = v453 배포 전 조건 — TESTLIST v453).
const BACKUP_MEMBER_AUTH = ['pin_salt', 'pin_hash', 'admin', 'dev', 'tier', 'perms'];
const BACKUP_MEMBER_IDENT = ['name', 'uid', 'role', 'dept'];
function backupRestoreClass(sn, key) {
  if (sn === 'gw_users') return 'users';
  if (sn !== 'gw_data') return '';
  if (key.indexOf('audit:') === 0) return 'audit';
  if (key.indexOf('doclog:') === 0) return 'doclog';
  if (key.indexOf('reclog:') === 0) return 'reclog';
  if (key.indexOf('clog:') === 0) return 'clog';   // v453 검토: 해시 체인 기록 전부(clog:contract* · 결재 학습 신호 clog:appr:YYYY-MM — 규약 clog:<domain>:<YYYY-MM>)
  if (key.indexOf('settings:') === 0) return 'settings';
  return '';
}
// clog 상한·시작 검사: clog:contract(앱이 상한에서 409로 멈춤 — 첫 줄 p '' 엄격) · clog:contract:YYYY-MM(같음) · 그 밖(clog:appr:* — DONEIF.clogAppend가 상한에서 앞을 잘라 첫 줄 p가 ''가 아닐 수 있음 → 시작 p 허용)
function backupClogMax(key) { return key === CON_CLOG_KEY ? CON_CLOG_MAX : (key.indexOf(CON_CLOG_KEY + ':') === 0 ? CON_CLOG_MONTH_MAX : DONEIF.CLOG_MAX); }
function backupClogStrict(key) { return key === CON_CLOG_KEY || key.indexOf(CON_CLOG_KEY + ':') === 0; }
function backupClogChainOk(doc, strict) {
  const its = doc.items || [];
  if (strict) return conClogChainOk(doc);
  let prev = its.length ? String(its[0].p == null ? '' : its[0].p) : '';
  for (const it of its) { const e = Object.assign({}, it); delete e.h; delete e.p; if (it.p !== prev || conClogHash(prev, e) !== it.h) return false; prev = it.h; }
  return prev === (doc.head || '');
}
function backupLogMax(cls) { return cls === 'audit' ? AUDIT_MAX_PER_MONTH : (cls === 'doclog' ? DOCLOG_MAX : RECLOG_MAX); }
function backupLogLine(e) { if (!Object.prototype.hasOwnProperty.call(e, 'restored')) return JSON.stringify(e); const o = Object.assign({}, e); delete o.restored; return JSON.stringify(o); }
// reserve = 이 키에 뒤이어 쓸 줄 수(이번 달 감사 키면 '재해복원' 1줄) · now = 되살린 줄에 붙일 restored 값
function backupLogMerge(curDoc, bkDoc, max, reserve, now) {
  const curOk = curDoc && typeof curDoc === 'object' && !Array.isArray(curDoc) && Array.isArray(curDoc.items);
  const cur = curOk ? curDoc.items : [];
  if (!bkDoc || typeof bkDoc !== 'object' || Array.isArray(bkDoc) || !Array.isArray(bkDoc.items)) return { err: 'BAD_AUDIT_DOC' };
  const lim = Date.now() + 10 * 60000;   // 시계 차 10분까지
  const seen = {}; cur.forEach(function (e) { if (e && typeof e === 'object') seen[backupLogLine(e)] = 1; });
  const add = [];
  for (const e of bkDoc.items) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !Number.isFinite(Number(e.ts))) return { err: 'BAD_AUDIT_ITEM' };
    if (Number(e.ts) > lim) return { err: 'AUDIT_FUTURE_TS' };
    const s = backupLogLine(e); if (seen[s]) continue; seen[s] = 1; add.push(Object.assign({}, e, { restored: now }));
  }
  if (cur.length + add.length + (reserve || 0) > max) return { err: 'AUDIT_FULL' };
  const tsOf = function (e) { return (e && Number.isFinite(Number(e.ts))) ? Number(e.ts) : 0; };
  const items = add.concat(cur).sort(function (a, b) { return tsOf(a) - tsOf(b); });   // 안정 정렬 — 같은 시각이면 되살린 줄이 앞, 지금 줄끼리는 원래 순서
  return { doc: Object.assign({ schema: 1 }, curOk ? curDoc : {}, { items: items }), added: add.length, kept: cur.length };
}
// v453 검토: 해시 체인 병합 — 지금 줄은 버리지 않는다.
//   ① 지금 체인이 온전하고 지금 head가 백업 안에 있으면 그 뒤 백업 줄만 잇는다(백업 줄 그대로 — h가 appdata 백업 git 이력과 맞음) · 더할 줄이 없으면(백업 head가 지금 체인 안 = 백업이 같거나 짧음) 400 CLOG_NOT_AHEAD.
//   ② 갈라졌거나(키를 잃은 뒤 앱이 ''부터 새 체인을 쌓은 경우 등) 지금 체인이 깨졌으면 다시 잇는다: 백업 체인 뒤에, 백업에 없는 지금 줄(h·p·rechained를 뺀 내용으로 비교)을
//      지금 순서대로 붙이고 p·h를 백업 head부터 다시 계산 — 다시 이은 줄에는 rechained:<복원 시각>(해시에 들어감), 되돌리기 줄(revert)의 of는 옛 h → 새 h로 고친다.
//      키 없는 sha256 체인이라 서버가 다시 이어도 신뢰 수준은 같다(줄 위조는 봇 키 + 재해 복원 모드에서만 가능 — 아래 restored 범위·감사 from/to로 대조).
//   문서에는 restored[{ts, from(지금 head), to(새 head), bk(백업 head), added, rechained}](최근 20) — 다음 기록 쓰기도 남긴다(conClogDoc·DONEIF.clogAppend).
function backupClogMerge(curDoc, bkDoc, max, strict, now) {
  const isObj = function (e) { return !!e && typeof e === 'object' && !Array.isArray(e); };
  if (!isObj(bkDoc) || !Array.isArray(bkDoc.items)) return { err: 'BAD_CLOG_DOC' };
  const bk = { items: bkDoc.items, head: String(bkDoc.head || '') };
  if (!bk.items.every(isObj) || !backupClogChainOk(bk, strict)) return { err: 'CLOG_CHAIN_BAD' };
  if (bk.items.length > max) return { err: 'CLOG_FULL' };
  const curOk = isObj(curDoc) && Array.isArray(curDoc.items);
  const curItems = curOk ? curDoc.items.filter(isObj) : [];
  const cur = { items: curItems, head: curOk ? String(curDoc.head || '') : '' };
  const curChain = curOk && curItems.length === curDoc.items.length && backupClogChainOk(cur, strict);
  const base = Object.assign({ schema: 1 }, curOk ? curDoc : {});
  const own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const done = function (items, head, added, kept, rechained, mode) {
    if (items.length > max) return { err: 'CLOG_FULL' };
    const rs = (Array.isArray(base.restored) ? base.restored : []).concat([{ ts: now, from: cur.head, to: head, bk: bk.head, added: added, rechained: rechained }]).slice(-20);
    return { doc: Object.assign(base, { items: items, head: head, restored: rs }), added: added, kept: kept, rechained: rechained, mode: mode, from: cur.head, to: head };
  };
  if (!cur.items.length) return done(bk.items, bk.head, bk.items.length, 0, 0, curOk && curDoc.items.length ? 'broken' : 'empty');
  if (curChain) {
    const at = {}; bk.items.forEach(function (e, i) { at[e.h] = i; });
    if (own(at, cur.head)) {
      const add = bk.items.slice(at[cur.head] + 1);
      if (!add.length) return { err: 'CLOG_NOT_AHEAD' };
      return done(cur.items.concat(add), bk.head, add.length, cur.items.length, 0, 'extend');
    }
    if (!bk.items.length || cur.items.some(function (e) { return e.h === bk.head; })) return { err: 'CLOG_NOT_AHEAD' };   // 백업이 지금 체인의 앞부분
  }
  const line = function (e) { const o = Object.assign({}, e); delete o.h; delete o.p; delete o.rechained; return JSON.stringify(o); };
  const inBk = {}; bk.items.forEach(function (e) { inBk[line(e)] = e.h; });
  const remap = {}, extra = [];
  cur.items.forEach(function (e) { const s = line(e); if (own(inBk, s)) { if (typeof e.h === 'string') remap[e.h] = inBk[s]; } else extra.push(e); });
  const items = bk.items.slice(); let head = bk.head;
  extra.forEach(function (e) {
    const o = Object.assign({}, e), oldH = o.h; delete o.h; delete o.p;
    if (typeof o.of === 'string' && own(remap, o.of)) o.of = remap[o.of];
    o.rechained = now;
    const h = conClogHash(head, o);
    items.push(Object.assign({ h: h, p: head }, o));
    if (typeof oldH === 'string') remap[oldH] = h;
    head = h;
  });
  return done(items, head, bk.items.length - (cur.items.length - extra.length), cur.items.length, extra.length, curChain ? 'diverged' : 'broken');
}
// v453 검토: 재해 복원으로 settings:autotask를 쓸 때 스위치를 지금보다 live로 올리지 않는다(백업 값이 live인 규칙은 지금이 live가 아니면 dry로) — 복원 뒤 live는 앱 관리자 카드로 다시 켠다(누가 켰는지 회원으로).
//   지금 값을 못 읽으면 기본 dry로 본다(올리지 않는 쪽).
function backupAutotaskClamp(curData, payload) {
  const isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
  if (!isObj(payload) || !isObj(payload.rules)) return { payload: payload, lowered: [] };
  const now = autotaskDefaults();
  if (isObj(curData) && isObj(curData.rules)) Object.keys(curData.rules).forEach(function (k) { if (autotaskValid(k, curData.rules[k])) now[k] = curData.rules[k]; });
  const rules = Object.assign({}, payload.rules), lowered = [];
  Object.keys(rules).forEach(function (k) { if (rules[k] === 'live' && now[k] !== 'live') { rules[k] = 'dry'; lowered.push(k); } });
  return { payload: Object.assign({}, payload, { rules: rules }), lowered: lowered };
}
// 재해 복원 모드 쓰기 계획 — {payload, note} 또는 {status, body}(거절). dry와 쓰기가 같은 것을 쓴다. preview에 merge·member를 얹는다(값 없음).
async function backupRestorePlan(sn, key, cls, cur, data, preview) {
  const now = Date.now();
  const isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
  const isMember = cls === 'users' && key.indexOf('member:') === 0;
  // v453 검토: 지금 값 읽기 — 일시 읽기 실패(STORAGE_READ_FAILED 등)만 500으로 막는다(지금 줄·PIN을 '없음'으로 보고 덮지 않게).
  //   깨진 JSON(STORAGE_PARSE_FAILED)은 '깨진 지금 값'으로 보고 교체한다(재해 복구의 가장 흔한 경우 — 회원은 지금 레코드 없음 규칙, 기록 키는 지금 줄 0, 감사 note '깨진 지금 값 교체').
  //   지금 값을 병합·칸 지키기에 쓰지 않는 키(settings:* — autotask는 못 읽으면 기본 dry로 보고 올리지 않음 · gw_users의 member 밖 name:·uid:·device:·lock:)는 이 검사를 건너뛴다.
  //   (실 blobGet은 없음 = ok:true·data null · servertest mock은 없음 = NOT_FOUND — 둘 다 '없음'.)
  const corrupt = !cur.ok && cur.code === 'STORAGE_PARSE_FAILED';
  const needCur = isMember || cls === 'audit' || cls === 'doclog' || cls === 'reclog' || cls === 'clog';
  if (needCur && !cur.ok && !corrupt && cur.code !== 'NOT_FOUND') return { status: 500, body: { status: 'ERROR', error_code: cur.code || 'STORAGE_READ_FAILED' } };
  const curData = cur.ok ? cur.data : null;
  let payload = data, note = corrupt ? ' · 깨진 지금 값 교체' : '';
  if (isMember && isObj(payload)) {
    // 회원 복원이 권한 상승·회원 끄기 통로가 되지 않게(v453) — 지금 레코드가 있으면 권한 칸(BACKUP_MEMBER_AUTH)은 늘 지금 값(없던 칸은 없게),
    // 신원 칸(BACKUP_MEMBER_IDENT)은 지금 값이 있으면 지금 값·없을 때만 백업 값(부분 레코드 고치기) · id = 지금 id 또는 키 ·
    // v453 검토: del은 해제만(지금 del 1 + 백업에 del 없음 = 지운 회원 되살리기 — 재직 회원에게 del을 넣는 길은 없음) · leave_date는 지금 값이 있으면 지금 값,
    //   없을 때 백업 값은 오늘(KST) 이후일 때만(지난 날짜 = 복원으로 퇴사 처리하는 길 — tier.retired와 같은 식) · 결과 명부에서 개발자·유효 pm이 0명이 되면 409 LAST_DEV·LAST_PM(gw-auth 회원 삭제·저장과 같은 판정).
    // 없으면 PIN 없음·admin·dev false·tier 없음(개발자가 member_upsert·PIN 재설정으로 다시 세움) · perms는 백업 값(재해 복구에 필요 — 감사 note에 칸·값). 바뀐 칸·지킨 칸 이름만 감사에(값 없음 · PIN 칸은 이름도 안 적음).
    payload = Object.assign({}, payload);
    const prev = isObj(curData) ? curData : null;
    const own = function (o, f) { return Object.prototype.hasOwnProperty.call(o, f); };
    const has = function (o, f) { return own(o, f) && o[f] !== null && o[f] !== undefined; };
    const kept = [];
    if (prev) {
      BACKUP_MEMBER_AUTH.forEach(function (f) {
        if (f.indexOf('pin_') !== 0 && JSON.stringify(prev[f]) !== JSON.stringify(payload[f])) kept.push(f);
        if (own(prev, f)) payload[f] = prev[f]; else delete payload[f];
      });
      BACKUP_MEMBER_IDENT.forEach(function (f) {
        if (!has(prev, f)) return;   // 지금 값이 없을 때만 백업 값
        if (JSON.stringify(prev[f]) !== JSON.stringify(payload[f])) kept.push(f);
        payload[f] = prev[f];
      });
      if (has(prev, 'leave_date')) { if (JSON.stringify(prev.leave_date) !== JSON.stringify(payload.leave_date)) kept.push('leave_date'); payload.leave_date = prev.leave_date; }
      else if (has(payload, 'leave_date') && tier.retired({ leave_date: payload.leave_date })) { kept.push('leave_date'); delete payload.leave_date; }   // 지난 퇴사일은 받지 않음
      if (prev.del === 1) { if (payload.del !== 1) delete payload.del; }   // 해제만 받음
      else { if (own(payload, 'del') && JSON.stringify(payload.del) !== JSON.stringify(prev.del)) kept.push('del'); if (own(prev, 'del')) payload.del = prev.del; else delete payload.del; }
      const idNow = has(prev, 'id') ? prev.id : key.slice('member:'.length);
      if (JSON.stringify(idNow) !== JSON.stringify(payload.id)) kept.push('id');
      payload.id = idNow;
      // 마지막 개발자·마지막 PM(gw-auth handleMemberDelete LAST_DEV · member_upsert S3 LAST_PM과 같은 판정) — 결과 명부로 다시 계산
      const all = (await push.loadMembers()).filter(function (m) { return isObj(m); });
      const after = all.filter(function (m) { return m.id !== idNow && m.id !== prev.id; }).concat([payload]);
      const devN = function (ms) { return ms.filter(function (m) { return tier.active(m) && !!m.dev; }).length; };
      if (devN(all) > 0 && devN(after) === 0) return { status: 409, body: { status: 'REJECTED', error_code: 'LAST_DEV' } };
      if (tier.ctxOf(all).pmIds.length > 0 && tier.ctxOf(after).pmIds.length === 0) return { status: 409, body: { status: 'REJECTED', error_code: 'LAST_PM' } };
      const changed = Object.keys(Object.assign({}, prev, payload)).filter(function (f) { return f.indexOf('pin_') !== 0 && JSON.stringify(prev[f]) !== JSON.stringify(payload[f]); });
      preview.member = { changed: changed, kept: kept };
      note += ' · 바뀐 칸 [' + changed.join(',').slice(0, 120) + '] · 지킨 칸 [' + kept.join(',') + ']' + (prev.del === 1 && payload.del !== 1 ? ' · del 해제' : '');
    } else {
      delete payload.pin_salt; delete payload.pin_hash; delete payload.tier; payload.admin = false; payload.dev = false; payload.id = key.slice('member:'.length);
      const pk = isObj(payload.perms) ? Object.keys(payload.perms).map(function (k) { return String(k).slice(0, 12) + ':' + String(payload.perms[k]).slice(0, 4); }).join(',') : '';
      preview.member = { created: true, perms: pk.slice(0, 160) };
      note += ' · 새 회원 레코드(PIN 없음·admin·dev false·tier 없음)' + (pk ? ' · perms [' + pk.slice(0, 120) + ']' : '');
    }
  } else if (cls === 'audit' || cls === 'doclog' || cls === 'reclog') {
    // v453 기록 키는 붙이기만 — 이번 달 감사 키면 뒤이어 쓸 '재해복원' 1줄 자리를 남긴다
    const mg = backupLogMerge(curData, payload, backupLogMax(cls), (cls === 'audit' && key === auditKey()) ? 1 : 0, now);
    if (mg.err) return { status: 400, body: { status: 'REJECTED', error_code: mg.err } };
    payload = mg.doc; preview.merge = { added: mg.added, kept: mg.kept };
    note += ' · 붙임 ' + mg.added + '줄 · 지금 줄 ' + mg.kept + ' 그대로';
  } else if (cls === 'clog') {
    const mg = backupClogMerge(curData, payload, backupClogMax(key), backupClogStrict(key), now);   // v453 해시 체인 — 잇기 · 갈라짐·깨짐은 다시 잇기(지금 줄 버리지 않음)
    if (mg.err) return { status: 400, body: { status: 'REJECTED', error_code: mg.err } };
    payload = mg.doc; preview.merge = { added: mg.added, kept: mg.kept, rechained: mg.rechained, mode: mg.mode };
    note += ' · 체인 ' + mg.mode + ' · 백업 줄 ' + mg.added + ' · 지금 줄 ' + mg.kept + (mg.rechained ? ' · 다시 이음 ' + mg.rechained + '줄' : '') + ' · from ' + (mg.from || '-') + ' → to ' + (mg.to || '-');
  } else if (cls === 'settings' && key === AUTOTASK_KEY) {
    const cl = backupAutotaskClamp(curData, payload);
    payload = cl.payload;
    if (cl.lowered.length) { preview.autotask_lowered = cl.lowered; note += ' · 스위치 live 복원 안 함 [' + cl.lowered.join(',') + '] — 앱 카드로 다시 켬'; }
  }
  return { payload: payload, note: note };
}
async function handleBackupPut(event, d, R) {
  const bot = backupAuthed(d);
  let ok = bot;
  if (!ok) { const c = await currentMember(event); ok = c.ok && !!c.member.admin; }
  if (!ok) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_OR_SECRET_ONLY', request_id: R });
  const sn = String(d.store || '');
  if (!BACKUP_STORES[sn]) return jr(400, { status: 'REJECTED', error_code: 'BAD_STORE', request_id: R });
  const key = String(d.key || '');
  if (!key) return jr(400, { status: 'REJECTED', error_code: 'NO_KEY', request_id: R });
  if (badBlobKey(key)) return jr(400, { status: 'REJECTED', error_code: 'BAD_KEY', request_id: R });   // v453 접두 검사를 비켜 가는 키(점 경로·백슬래시·%·제어문자·앞뒤 공백) — 아래 갈래 판정보다 먼저
  if (d.data === undefined || d.data === null) return jr(400, { status: 'REJECTED', error_code: 'NO_DATA', request_id: R });
  if (sn === 'gw_data' && key === 'push:keys') return jr(403, { status: 'FORBIDDEN', error_code: 'SENSITIVE_KEY', request_id: R });
  const cls = backupRestoreClass(sn, key), restore = bot && d.restore === true;   // v453 재해 복원 모드 = 봇 키 + restore:true
  const cur = await blobGet(store(sn), key);
  const preview = { exists: !!cur.ok, current: _bkCount(cur.ok ? cur.data : null), restore: _bkCount(d.data) };
  // v453 검토: 재해 복원 갈래는 dry에서도 쓰기와 같은 판정(관문·지금 값 읽기·병합·회원 칸·마지막 PM)을 돌려 preview.merge·preview.member·would_error로 미리 보여 준다(쓰지 않음)
  let plan = null;
  if (cls && !restore) plan = { status: 403, body: { status: 'FORBIDDEN', error_code: 'RESTORE_MODE_ONLY', restore_only: cls } };   // v453 관리자 세션·봇 키만으로는 못 씀
  else if (cls) plan = await backupRestorePlan(sn, key, cls, cur, d.data, preview);
  // v456(원장 C107): 쓰기는 봇 키만 — 관리자 세션은 미리보기(dry)까지(그 밖 키 col:*·tpl:*·proof:* 등도 — 예: col:tasks를 통째로 덮으면 저장 경로의 서버 재구성(돈 상태 차단 등)을 건너뛰었다).
  //   호출처 전수(v456): appdata restore.py·logsheet_daily.py = 봇 키 · 앱 index.html·도구 = 0 · servertest. 재해 복원 갈래 거절(RESTORE_MODE_ONLY)이 먼저(종전 응답 그대로), 그다음 BOT_KEY_ONLY.
  if (d.dry) return jr(200, { status: 'OK', dry: true, store: sn, key: key, preview: preview, restore_only: !!cls, would_error: (plan && plan.status) ? plan.body.error_code : (bot ? '' : 'BOT_KEY_ONLY'), request_id: R });
  if (plan && plan.status === 403) return jr(403, Object.assign(plan.body, { request_id: R }));
  if (!bot) return jr(403, { status: 'FORBIDDEN', error_code: 'BOT_KEY_ONLY', request_id: R });
  if (d.confirm !== true) return jr(400, { status: 'REJECTED', error_code: 'NEED_CONFIRM', preview: preview, request_id: R });
  if (plan && plan.status) return jr(plan.status, Object.assign(plan.body, { request_id: R }));
  const payload = plan ? plan.payload : d.data, note = plan ? plan.note : '';
  const w = await blobSet(store(sn), key, payload);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: '복원', bid: 'restore', col: sn, ev: [{ op: restore ? '재해복원' : '백업복원', id: key, t: (JSON.stringify(preview).slice(0, 120) + note).slice(0, 300) }] }); } catch (e) {}
  return jr(200, { status: 'OK', store: sn, key: key, preview: preview, restore: restore, request_id: R });
}

// ---- 서류 양식(템플릿) 보관 — 관리자 등록, 영구 보관. 생성 시 원본 복사라 오염 없음 ----
const TPL_KEYS = { asb_plan: '석면해체계획서', work_start: '착공계', work_complete: '준공계', demo_report: '해체신고서(완료신고 포함)', waste_report: '폐기물배출신고서(수탁확인 포함)', qual_packet: '적격심사 패킷(신청서·심사표·각서·확약서 hwpx)', contract_pledge: '계약이행 통합서약서(hwpx)', seal_reg: '사용인감계(hwpx)', bond_waiver: '지역개발채권 포기각서(hwpx)', labor_exempt: '노무비 적용제외 신청서(hwpx·수기서식)', quote_env: '견적서 — (주)종운환경(hwpx)', quote_con: '견적서 — ㈜종운건설(hwpx)', adv_pay: '선금지급신청 세트(공문+별첨2~5, hwpx)', settle_doc: '준공 정산합의서(사후정산, xlsx)', safety_plan: '안전보건관리계획서(준설, hwpx)', safety_risk: '위험성평가표(준설, xlsx)', safety_rule: '준설 작업 안전 수칙(hwpx)', safety_emerg: '비상상황 대응체계(준설, hwpx)', safety_ppe: '안전보호구 지급 대장(준설, hwpx)', safety_cost: '산업안전보건관리비 사용내역서(준설, xlsx)', labor_split: '노무비 구분관리 서식1~7(hwpx)' };
async function handleTplPut(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const key = String(d.key || '');
  if (!TPL_KEYS[key]) return jr(400, { status: 'REJECTED', error_code: 'BAD_TPL_KEY', request_id: R });
  const b64 = String(d.data || '');
  if (!b64 || b64.length > ATT_MAX) return jr(400, { status: 'REJECTED', error_code: 'INVALID_FILE', request_id: R });
  // v426 양식에 주민등록번호 값을 넣지 않는다(PM 11/6 "착공계양식주민번호빼") — 옛 파일을 다시 등록해도 값이 돌아오지 않게
  if (BJ.rrnScan(Buffer.from(b64, 'base64'))) return jr(400, { status: 'REJECTED', error_code: 'TPL_HAS_RRN', request_id: R });
  const w = await blobSet(store(FILES), 'tpl:' + key, { name: String(d.name || '').slice(0, 120), data: b64, by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '양식등록', id: key, t: String(d.name || '').slice(0, 60) }] }); } catch (e) {}   // 양식 교체=서류 위조 벡터 — 무기록 금지
  return jr(200, { status: 'OK', key: key, request_id: R });
}
// 사람 정보가 든 양식(착공계의 주민번호·자격증 그림, 석면 계획서의 연락처 등) — 만드는 사람(처리 권한 + 승인 기기)만 받고 기록을 남긴다(v424 검토). 견적·서약서 등 나머지는 그대로
const TPL_PERSON = { work_start: 1, work_complete: 1, asb_plan: 1, demo_report: 1, waste_report: 1, safety_plan: 1, labor_split: 1 };
async function handleTplGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  const tplKey = String(d.key || '');
  if (hasOwn(TPL_PERSON, tplKey)) {
    if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
    if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
    await appendRecLog(store(DATA), { ts: Date.now(), bid: c.member.id, by: String(c.member.name || ''), dept: String(c.member.dept || ''), cid: '', n: 0, i: -1, dk: 'tpl.' + tplKey, kind: 'tpl', pii: 1, name: tplKey, reason: '' });
  }
  const r = await blobGet(store(FILES), 'tpl:' + tplKey);
  if (!r.ok && r.code !== 'NOT_FOUND') return jr(500, { status: 'ERROR', error_code: r.code || 'STORAGE_READ_FAILED', request_id: R });   // v422: 읽기 실패 ≠ 미등록
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  return jr(200, { status: 'OK', name: r.data.name, data: r.data.data, request_id: R });
}
async function handleTplList(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  const out = {};
  let readFailed = false;
  await Promise.all(Object.keys(TPL_KEYS).map(async (key) => {   // v422: 키가 21개라 동시에 읽는다(응답 키 순서는 뒤에서 고정)
    let r = await blobGet(store(FILES), 'tpl:' + key);
    if (!r.ok && r.code !== 'NOT_FOUND') r = await blobGet(store(FILES), 'tpl:' + key);   // 한 번 더
    if (!r.ok && r.code !== 'NOT_FOUND') { readFailed = true; return; }
    out[key] = (r.ok && r.data) ? { name: r.data.name, ts: r.data.ts, by: r.data.by } : null;
  }));
  if (readFailed) return jr(503, { status: 'ERROR', error_code: 'TPL_READ_FAILED', request_id: R });   // v422: 읽기 실패를 미등록(null)으로 돌려주지 않는다 — 앱은 "확인 실패, 잠시 뒤 재시도"로 처리
  const templates = {};
  for (const key of Object.keys(TPL_KEYS)) templates[key] = out[key];
  return jr(200, { status: 'OK', templates: templates, labels: TPL_KEYS, request_id: R });
}

async function handleAttGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  // P1 판28: 인허가 수령본(kind 'lic')은 인허가를 볼 수 있는 사람(+ 기기 승인)에게 — 확장자로 고정한 mime. 그 밖 파일은 아래 종전 길 그대로
  if (d.raw !== true && permOf(c.member, 'licenses') !== 'hide' && /^att_[a-f0-9]{16}$/.test(String(d.id || ''))) {
    const lr = await blobGet(store(FILES), String(d.id));
    if (lr.ok && lr.data && lr.data.kind === 'lic') {
      if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
      const lx = (String(lr.data.name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
      return jr(200, { status: 'OK', name: lr.data.name, type: LIC_ATT_MIME[lx] || 'application/octet-stream', data: lr.data.data, request_id: R });
    }
  }
  // 입장: 계약 첨부 열람권 또는 홍보 열람권(v353 후속 — 홍보만 있는 회원도 검수 격자 사진을 봐야 한다)
  if (permOf(c.member, 'contracts') === 'hide' && permOf(c.member, 'promo') === 'hide') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });
  // att_ 프리픽스 강제 — 없으면 같은 스토어의 tpl:/proof: 키를 이 완화된 가드로 읽어 관리자 전용(proof_get/tpl_put) 우회가 된다
  if (!/^att_[a-f0-9]{16}$/i.test(String(d.id || ''))) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  // v353 모자이크: 홍보 사진에 가린 판(mask:<id>)이 있으면 기본으로 그것을 준다(검수 격자·완성본 창이 가린 사진을 본다).
  //   raw:true 는 가리기 편집 화면이 원본 위에 상자를 그릴 때만 — 홍보 'do' + 승인 기기, 감사로그(원본열람).
  if (d.raw !== true) {
    const mr = await blobGet(store(FILES), 'mask:' + String(d.id || ''));
    if (mr.ok && mr.data && String(mr.data.data || '')) return jr(200, { status: 'OK', name: mr.data.name, type: mr.data.type || 'image/jpeg', data: mr.data.data, masked: true, request_id: R });
  } else {
    if (permOf(c.member, 'promo') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
    if (!(await deviceApproved(event, c.member))) return jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R });
    try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo', ev: [{ op: '원본열람', id: String(d.id || '').slice(0, 30), t: '가리기 편집' }] }); } catch (e) {}
  }
  const r = await blobGet(store(FILES), String(d.id || ''));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  if (r.data.kind === 'lic') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_ACCESS', request_id: R });   // P1 판28 인허가 수령본은 위 갈래(인허가 열람권)로만
  return jr(200, { status: 'OK', name: r.data.name, type: r.data.type, data: r.data.data, request_id: R });
}

async function handleAttDel(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (permOf(c.member, 'contracts') !== 'do') return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', request_id: R });
  // att_ 프리픽스 강제 — 없으면 tpl:/proof:(proof:__index__ 포함)를 비관리자가 삭제할 수 있다(gw-parse-background와 동일 검사)
  if (String(d.id || '').indexOf('att_') !== 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });
  const am0 = await blobGet(store(FILES), String(d.id || ''));
  if (am0.ok && am0.data && am0.data.taken) return jr(409, { status: 'CONFLICT', error_code: 'ALREADY_TAKEN', request_id: R });
  if (am0.ok && am0.data && am0.data.kind === 'lic') return jr(409, { status: 'CONFLICT', error_code: 'LIC_ATT_KEEP', request_id: R });   // P1 판28 인허가 수령본(완료 기록 근거)은 지우는 길 없음   // v423 서류함이 참조하는 조각은 여기서 지우지 않는다(서류함 보관·영구 삭제 경로로)
  if (am0.ok && am0.data && am0.data.parts) await BF.attDeleteParts(store(FILES), String(d.id || ''), am0.data);
  if (am0.ok && am0.data && am0.data.kind === 'box') await blobDelete(store(FILES), boxMarkKey(String(d.id || '')));
  await blobDelete(store(FILES), String(d.id || ''));
  await blobDelete(store(FILES), 'parse:' + String(d.id || ''));
  // v353: 가린 판·상태 동반 삭제 — 실패를 삼키지 않는다(고아 mask가 att_get으로 되살아나지 않게 감사에 남긴다)
  for (const k of ['mask:' + String(d.id || ''), 'maskmeta:' + String(d.id || '')]) {
    try { const dr = await blobDelete(store(FILES), k); if (dr && dr.ok === false) throw new Error(dr.code || 'DELETE_FAILED'); }
    catch (e) { try { await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'files', ev: [{ op: '가림삭제실패', id: k.slice(0, 40), t: String((e && e.message) || '').slice(0, 60) }] }); } catch (e2) {} }
  }
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
function docAttCanPut(m, it) { if (!m || !it) return false; if (docMajorOf(it) === '01' && !m.admin) return false; return !!(m.admin || (it.by && it.by.id === m.id && permOf(m, 'documents') === 'do')); }   // 01 법인 문서 첨부는 관리자만(v318 — 하드차단을 첨부 경로에도)
// ---- v388 직원 출력(PM 10/19 ㄱ): 열람·인쇄(PDF·이미지)와 편집 원본(docx·xlsx·pptx·hwp·hwpx) 분리 + 열람 기록 ----
// 원본 내려받기 = 관리자 · 관리부 · 중분류 03 양식·서식(직원이 채워 써야 함) · 문서별 orig_dl:'all'. 열람·인쇄는 종전 공개범위(docVisible) 그대로.
// 서버가 판정한다(화면 숨김만이 아님) — 직원이 주소를 알아도 원본은 못 받는다. 첨부 메타 view:1 = 열람용 PDF(로컬 변환 도구가 붙임).
const DOC_ORIG_EXT = { docx: 1, xlsx: 1, pptx: 1, hwp: 1, hwpx: 1 };
function docMinorOf(it) { const c = docCatOf(it); return (c && c.length === 5) ? c.slice(3, 5) : ''; }
function docOrigAllowed(m, it) {
  if (!m || !it) return false;
  if (m.admin) return true;
  if (docCanSee01(m)) return true;   // 관리부(01 하드차단과 같은 축)
  if (docMinorOf(it) === '03') return true;
  return it.orig_dl === 'all';
}
// 열람 기록 — 월 블롭 doclog:YYYY-MM(KST), 감사로그와 같은 방식(실패는 삼킴 — 기록이 열람을 막지 않는다). 상한 5,000건/월
const DOCLOG_MAX = 5000;
function docLogKey(month) {
  if (month && /^\d{4}-\d{2}$/.test(month)) return 'doclog:' + month;
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return 'doclog:' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
async function appendDocLog(st, entry) {
  try {
    const key = docLogKey();
    const r = await blobGet(st, key);
    const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
    doc.items.push(entry);
    if (doc.items.length > DOCLOG_MAX) doc.items = doc.items.slice(-DOCLOG_MAX);
    await blobSet(st, key, doc);
  } catch (e) { /* no-op */ }
}
async function handleDocLogGet(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
  const month = (typeof d.month === 'string' && /^\d{4}-\d{2}$/.test(d.month)) ? d.month : '';
  const key = docLogKey(month);
  const r = await blobGet(store(DATA), key);
  const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  const limit = Math.min(500, Math.max(1, parseInt(d.limit, 10) || 200));
  return jr(200, { status: 'OK', month: key.slice(7), total: items.length, items: items.slice(-limit).reverse(), request_id: R });
}
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
  if (docAttRecordName(name)) { await cdocAudit(c.member, '기록물차단', docId, name); return jr(403, { status: 'FORBIDDEN', error_code: 'RECORD_NOT_FOR_GIT', request_id: R }); }   // v406: 계약 기록물은 문서함(정본·git 경로)에 못 들어간다 — 설계 §4-1 분기 차단
  const ext = docAttExt(name);
  if (!docAttExtOk(ext)) return jr(400, { status: 'REJECTED', error_code: 'BAD_EXT', request_id: R });
  if (b64.length > DOC_ATT_MAX) return jr(413, { status: 'REJECTED', error_code: 'FILE_TOO_LARGE', request_id: R });
  if (!docAttMagicOk(ext, b64)) return jr(400, { status: 'REJECTED', error_code: 'BAD_MAGIC', request_id: R });   // 확장자와 내용 불일치(위장 파일)
  const st = store(DATA);
  const ld = await docAttLoad(st, docId);
  if (!ld.ok) return jr(ld.http, { status: ld.http === 500 ? 'ERROR' : 'REJECTED', error_code: ld.code, request_id: R });
  if (!docAttCanPut(c.member, ld.it)) return jr(403, { status: 'FORBIDDEN', error_code: (docMajorOf(ld.it) === '01' && !c.member.admin) ? 'BLOCKED_01' : 'NOT_OWNER', request_id: R });
  if ((ld.it.files || []).length >= DOC_ATT_PER_DOC) return jr(400, { status: 'REJECTED', error_code: 'TOO_MANY_FILES', request_id: R });
  const n = docAttNextN(ld.it);
  const mime = DOC_ATT_MIME[ext];   // 클라 mime 폐기 — 확장자 고정표만(high1)
  const now = Date.now();
  const fw = await blobSet(store(FILES), docAttKey(docId, n), { name: name, type: mime, kind: 'doc', doc: docId, n: n, data: b64, by: c.member.name, ts: now });
  if (!fw.ok) return jr(500, { status: 'ERROR', error_code: fw.code, request_id: R });
  const files = (ld.it.files || []).slice();
  const fm = { n: n, name: name, size: b64Bytes(b64), mime: mime, ts: now, by: { id: c.member.id, name: c.member.name } };
  // v388 열람용 표식 — 관리자가 pdf를 view:1로 올리면 [보기·인쇄]가 그 파일을 연다(src_n·src_hash는 변환 도구의 재변환 판정용)
  if ((d.view === 1 || d.view === '1') && c.member.admin && ext === 'pdf') {
    fm.view = 1;
    if (Number(d.src_n) >= 1) fm.src_n = Number(d.src_n);
    if (typeof d.src_hash === 'string' && /^[0-9a-f]{8,40}$/.test(d.src_hash)) fm.src_hash = d.src_hash;
  }
  files.push(fm);
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
  // v388: 편집 원본(docx·xlsx·pptx·hwp·hwpx)은 docOrigAllowed만 — 열람용 PDF·이미지는 종전대로 docVisible이면 됨
  const ext = docAttExt(meta.name || '');
  const isOrig = !!DOC_ORIG_EXT[ext];
  if (isOrig && !docOrigAllowed(c.member, ld.it)) return jr(403, { status: 'FORBIDDEN', error_code: 'ORIG_FORBIDDEN', request_id: R });
  const r = await blobGet(store(FILES), docAttKey(docId, n));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  // 열람 기록(v388) — 누가·언제·어느 문서·어느 파일·원본/열람용. 관리자 열람도 남긴다(유출 추적은 전원)
  await appendDocLog(st, { ts: Date.now(), bid: c.member.id, by: String(c.member.name || ''), dept: String(c.member.dept || ''), doc: docId, no: String(ld.it.no || ''), title: String(ld.it.title || '').slice(0, 60), n: n, name: String(meta.name || '').slice(0, 80), kind: meta.view === 1 ? 'view' : (isOrig ? 'orig' : 'file') });
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
      if (docAttRecordName(name)) return jr(403, { status: 'FORBIDDEN', error_code: 'RECORD_NOT_FOR_GIT', index: i, file: j, request_id: R });   // v406
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

// ---- 문서함 휴지통(v321, PM 9/6 ㄱ): 소프트 삭제(del:1) 항목의 복구·영구 삭제. 관리자 전용, 낙관락(base=STALE_BASE)·cid 멱등('docop:<cid>' 블롭), 자동 영구 삭제 없음 ----
// 삭제일 = docDeletedTs(deleted_at → 구건 updated_ts → updated). 영구 삭제는 DOC_PURGE_DAYS(30일) 경과 건만(PURGE_TOO_EARLY·days_left), confirm:true 필수(클라 2단 확인의 서버 몫),
// 첨부 블롭(docatt:<id>:files n + 1..att_seq — 삭제 실패로 남은 고아 포함)까지 제거. 문서 항목은 영구 삭제 직전 버전 링에 남지만 첨부 바이트는 복구 불가.
const DOC_PURGE_DAYS = 30;
async function docOpDedup(st, cid) { if (!cid) return null; const p = await blobGet(st, 'docop:' + cid); return (p.ok && p.data && p.data.body) ? p.data.body : null; }
const DOC_OP_TTL_MS = 7 * 86400000;   // 멱등 블롭 보존 기간(9/6 검증 R6) — 재시도 창은 초 단위라 7일이면 충분, 그 뒤엔 정리
async function docOpMark(st, cid, body) {
  if (!cid) return;
  try { await blobSet(st, 'docop:' + cid, { ts: Date.now(), body: body }); } catch (e) {}
  try { await docOpSweep(st); } catch (e) {}
}
// 7일 지난 docop:<cid> 정리(R6 — 종전엔 휴지통 작업마다 1키씩 영구 누적) — list 후 ts 확인·삭제, 실패는 무시(본 작업을 막지 않는다), 회당 100키 상한
async function docOpSweep(st) {
  const l = await blobList(st, 'docop:');
  if (!l.ok) return;
  const cut = Date.now() - DOC_OP_TTL_MS;
  let n = 0;
  for (const k of l.keys) {
    if (k.indexOf('docop:') !== 0) continue;
    if (++n > 100) break;
    const r = await blobGet(st, k);
    if (r.ok && r.data && Number(r.data.ts) > 0 && Number(r.data.ts) < cut) await blobDelete(st, k);
  }
}
// 공통 앞단: 관리자·id·cid 형식·멱등·문서 읽기·항목 존재·낙관락. 반환 {res}(즉시 응답) 또는 {st,doc,it,id,cid,member}
async function docTrashPre(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return { res: jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R }) };
  if (!c.member.admin) return { res: jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R }) };
  const id = String(d.id || '').slice(0, 40);
  if (!id) return { res: jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R }) };
  const cid = String(d.cid || '').trim().slice(0, 48);
  if (cid && !/^[A-Za-z0-9_.-]+$/.test(cid)) return { res: jr(400, { status: 'REJECTED', error_code: 'BAD_CID', request_id: R }) };
  const st = store(DATA);
  const dup = await docOpDedup(st, cid);
  if (dup) return { res: jr(200, Object.assign({}, dup, { dedup: true, request_id: R })) };   // 같은 cid 재요청(응답 유실 재시도) = 첫 결과 그대로
  const r = await blobGet(st, colKey('documents'));
  if (!r.ok) return { res: jr(500, { status: 'ERROR', error_code: r.code, request_id: R }) };
  const doc = (r.data && Array.isArray(r.data.items)) ? r.data : null;
  const it = doc ? doc.items.find(function (x) { return x && x.id === id; }) : null;
  if (!it) return { res: jr(404, { status: 'REJECTED', error_code: 'NO_DOC', request_id: R }) };
  // 낙관락(handleSave STALE_BASE와 동일) — 목록을 본 뒤 남이 바꿨으면 세운다(클라는 재조회 뒤 다시)
  if (d.base !== undefined && doc.updated_at && Number.isFinite(Number(doc.updated_at)) && Number(d.base) !== Number(doc.updated_at)) return { res: jr(409, { status: 'CONFLICT', error_code: 'STALE_BASE', request_id: R }) };   // v456(C079) 숫자가 아닌 updated_at은 비교 안 함(handleSave와 같음 — 아래 쓰기가 숫자로 고침)
  if (d.base !== undefined && doc.updated_at && !Number.isFinite(Number(doc.updated_at)) && Number(d.base) === 0) return { res: jr(409, { status: 'CONFLICT', error_code: 'STALE_BASE', request_id: R }) };   // v456 검토: 그래도 base 0(목록을 못 받은 기기)은 409 — handleSave와 같음
  return { st: st, doc: doc, it: it, id: id, cid: cid, member: c.member };
}
async function handleDocRestore(event, d, R) {
  const p = await docTrashPre(event, d, R);
  if (p.res) return p.res;
  const st = p.st, doc = p.doc, it = p.it, me = { id: p.member.id, name: p.member.name };
  if (it.del !== 1) return jr(200, { status: 'OK', id: p.id, already: true, updated_at: doc.updated_at || 0, request_id: R });   // 이미 살아 있음(재시도·동시 복구) — 멱등
  const prevDoc = JSON.parse(JSON.stringify(doc));
  const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();
  const restore = function (x) { delete x.del; delete x.hidden_tmp; delete x.deleted_at; delete x.deleted_by; x.restored_at = nowIso; x.restored_by = me; x.updated_ts = nowMs; x.updated = verDay(nowMs); };
  restore(it);
  await verSnapshot('documents', prevDoc, me.name + '(복구)', false);   // 사람 저장과 같은 시점 보존
  doc.updated_by = me.id; doc.updated_at = Date.now();
  const w = await blobSet(st, colKey('documents'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  let at = doc.updated_at;
  try {   // 무조건 덮어쓰기 저장소 — 동시 저장이 복구를 되돌렸으면 1회 재적용(첨부·결재 반영과 같은 패턴)
    const chk = await blobGet(st, colKey('documents'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items)) {
      const cur = chk.data.items.find(function (x) { return x && x.id === p.id; });
      if (cur && cur.del === 1) { restore(cur); chk.data.updated_by = me.id; chk.data.updated_at = Date.now(); await blobSet(st, colKey('documents'), chk.data); at = chk.data.updated_at; }
      else if (chk.data.updated_at) at = chk.data.updated_at;
    }
  } catch (e) {}
  try { await appendAudit({ ts: Date.now(), by: me.name, bid: me.id, col: 'documents', ev: [{ op: '복구', id: p.id, t: String(it.title || '').slice(0, 60) }] }); } catch (e) {}
  const body = { status: 'OK', id: p.id, updated_at: at };
  await docOpMark(st, p.cid, body);
  return jr(200, Object.assign({}, body, { request_id: R }));
}
async function handleDocPurge(event, d, R) {
  const p = await docTrashPre(event, d, R);
  if (p.res) return p.res;
  const st = p.st, doc = p.doc, it = p.it, me = { id: p.member.id, name: p.member.name };
  if (d.confirm !== true) return jr(400, { status: 'REJECTED', error_code: 'NEED_CONFIRM', request_id: R });   // backup_put과 같은 명시 확인 게이트
  if (it.del !== 1) return jr(400, { status: 'REJECTED', error_code: 'NOT_DELETED', request_id: R });   // 살아 있는 문서는 영구 삭제 불가 — 먼저 삭제(휴지통)로
  if (it.hidden_tmp) return jr(400, { status: 'REJECTED', error_code: 'HIDDEN_TMP', request_id: R });   // v314 임시 숨김(마이그레이션 전 보류 18건)은 복구만(9/6 검증 R3) — 삭제 의사가 없던 항목을 영구 삭제로 잃지 않게. 클라도 버튼 비활성
  const delTs = docDeletedTs(it);
  if (!delTs) return jr(400, { status: 'REJECTED', error_code: 'PURGE_DATE_UNKNOWN', request_id: R });   // 삭제일을 알 수 없으면 fail-closed
  const ageDays = (Date.now() - delTs) / 86400000;
  if (ageDays < DOC_PURGE_DAYS) return jr(400, { status: 'REJECTED', error_code: 'PURGE_TOO_EARLY', days_left: Math.ceil(DOC_PURGE_DAYS - ageDays), request_id: R });
  const prevDoc = JSON.parse(JSON.stringify(doc));
  await verSnapshot('documents', prevDoc, me.name + '(영구 삭제)', false);   // 마지막 시점 보존 — 항목은 복구 링에서만 되살릴 수 있다(첨부 바이트는 복구 불가)
  const drop = function (dc) { dc.items = dc.items.filter(function (x) { return !(x && x.id === p.id); }); dc.updated_by = me.id; dc.updated_at = Date.now(); };
  drop(doc);
  const w = await blobSet(st, colKey('documents'), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  let at = doc.updated_at;
  try {
    const chk = await blobGet(st, colKey('documents'));
    if (chk.ok && chk.data && Array.isArray(chk.data.items)) {
      if (chk.data.items.some(function (x) { return x && x.id === p.id; })) { drop(chk.data); await blobSet(st, colKey('documents'), chk.data); at = chk.data.updated_at; }
      else if (chk.data.updated_at) at = chk.data.updated_at;
    }
  } catch (e) {}
  // 첨부 블롭 제거 — files 메타의 n + 1..att_seq(삭제 실패로 남은 고아 포함). 항목은 이미 제거됐으므로 실패분은 고아 블롭(열기 불가·무해) — 응답·감사로그에 남긴다
  const ns = {};
  ((it.files) || []).forEach(function (f) { if (f && Number(f.n) > 0) ns[Number(f.n)] = 1; });
  for (let n = 1; n <= (Number(it.att_seq) || 0); n++) ns[n] = 1;
  let purged = 0, failed = 0;
  for (const k of Object.keys(ns)) { try { const dr = await blobDelete(store(FILES), docAttKey(p.id, Number(k))); if (dr && dr.ok === false) failed++; else purged++; } catch (e) { failed++; } }
  try { await appendAudit({ ts: Date.now(), by: me.name, bid: me.id, col: 'documents', ev: [{ op: '영구삭제', id: p.id, t: (String(it.title || '').slice(0, 50) + ' · 삭제 ' + verDay(delTs) + ' · 첨부 블롭 ' + purged + (failed ? ' · 실패 ' + failed : '')).slice(0, 100) }] }); } catch (e) {}
  const body = { status: 'OK', id: p.id, purged_files: purged, failed_files: failed, updated_at: at };
  await docOpMark(st, p.cid, body);
  return jr(200, Object.assign({}, body, { request_id: R }));
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
  // 복구 직전 현재 상태도 보존 — 복구 자체를 되돌릴 수 있게(v444 검토: force — 스냅샷 제외 VER_SKIP 컬렉션(입찰·부동산)도. 종전엔 이 보존이 말없이 건너뛰어져
  //   부동산 정리를 되돌리는 복구가 정리 뒤 바뀐 상태·새 물건을 스냅샷 없이 덮었다)
  const cur = await blobGet(store(DATA), colKey(col));
  if (cur.ok && cur.data) await verSnapshot(col, cur.data, g.c.member.name + '(복구 전 자동보존)', false, true);
  const doc = Object.assign({}, vr.data.doc, { updated_by: g.c.member.id, updated_at: Date.now() });
  const w = await blobSet(store(DATA), colKey(col), doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code, request_id: R });
  try {
    const when = new Date(vr.data.ts + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
    await appendAudit({ ts: Date.now(), by: g.c.member.name, bid: g.c.member.id, col: col, ev: [{ op: '시점복구', id: '-', t: '← ' + when + ' (전체 ' + verCnt(vr.data.doc).tot + '건)' }] });
  } catch (e) {}
  return jr(200, { status: 'OK', updated_at: doc.updated_at, request_id: R });
}

// ---- P1 판29 PM 콘솔 — 누른 기록 status:decide (착수설명서 판29 · 업무별 설계 3-17 self_decide · 시안 11/13 18:14 PM ㄱ) ----
// 콘솔은 권한관리 카드 7종(배정표·알림 설정·완료 판정·자동 지시 규칙·계약 학습·브리핑 설정·근거 승격)의 '정할 것'을 한 화면에 모은 목록이고,
// 값을 바꾸는 일은 **기존 핸들러를 그대로 부른다**(값 검사·낙관락(set_base)·prev 1판·감사 줄·updated_by = 누른 회원 — 콘솔이 봇 표식으로 대신 쓰지 않음).
// 이 블록이 더하는 것은 '누른 기록' 한 곳뿐: status:decide = { schema, log:[기록], folded:{n,from,to}, marks:{줄 id:{st hold|keep, ts, by, why}}, updated_at, updated_by }.
//   읽기 pmcon_get = 로그인 → 기기 승인 → 관리자(읽기) · 쓰기 pmcon_decide = 로그인 → 기기 승인 → 관리자 → PM(명시 tier pm — _lib/tier.js, 결재 전결과 같은 판정·명부 못 읽으면 503)
//   → 값 검사 400 → 기록 읽기(실패 = 503 PMCON_READ_FAILED, 기본값 위에 쓰지 않음) → 낙관락 409 PMCON_STALE(base 필수) → 기존 핸들러(실패면 그 응답 그대로·기록 0) → 기록 1줄 → 감사 1줄(col pmcon).
//   자동 적용(무응답이면 추천값)은 이 판에 없다 — 무응답 적용일·추천값은 화면 표시뿐이고 적용은 사람이 누를 때만(스위치·크론 신설 없음).
//   상한: 기록 PMCON_LOG_MAX줄 — 넘치면 오래된 것부터 접어 folded(건수·처음·끝 시각)만 남김 · 표시 marks PMCON_MARK_MAX개(오래된 것부터 버림).
const PMCON_KEY = 'status:decide';
const PMCON_LOG_MAX = 400, PMCON_MARK_MAX = 60, PMCON_GET_MAX = 200;
const PMCON_KINDS = {   // 줄 종류 → 등급(서버 표 — 보낸 등급이 다르면 400 BAD_GRADE) · 부르는 기존 핸들러 · 넘기는 칸(그 밖의 칸은 400 BAD_ARGS) · 칸 꼴 · 값에서 줄 id 다시 만들기
  // 판29 검토(11/13): 줄 id(row)를 서버가 kind·args에서 다시 만들어 보낸 row와 다르면 400 BAD_ROW — 한 줄을 눌러 다른 설정이 바뀌고 기록이 엉뚱한 줄로 남지 않게.
  //   켬·끔 칸은 참·거짓만(글자 'true'는 기존 핸들러에서 끔으로 읽힘 — 브리핑은 콘솔이 켬·끔 칸(on)만 다룬다, 다른 칸은 400 BAD_ARGS).
  assign: { label: '배정표', grade: 'R1', fn: handleAssignSet, args: { prefix: 's', who_id: 's' }, row: function (a) { return 'assign:' + a.prefix.replace(/:$/, ''); } },
  notify: { label: '알림 설정', grade: 'R1', fn: handleNotifySet, args: { event: 's', value: 's' }, row: function (a) { return 'notify:' + a.event + ':' + a.value; } },
  doneif: { label: '완료 판정', grade: 'R1', fn: handleDoneifSet, args: { on: 'b' }, row: function (a) { return 'doneif:' + (a.on ? 'on' : 'off'); } },
  autotask: { label: '자동 지시 규칙', grade: 'R1', fn: handleAutotaskSet, args: { rule: 's', mode: 's' }, row: function (a) { return 'autotask:' + a.rule + ':' + a.mode; } },
  learn: { label: '계약 학습', grade: 'R2', fn: handleLearnSettingsSet, args: { on: 'b' }, row: function (a) { return 'learn:' + (a.on ? 'on' : 'off'); } },
  brief: { label: '브리핑 설정', grade: 'R1', fn: handleBriefSet, args: { field: 'on', value: 'b' }, row: function (a) { return 'brief:' + (a.value ? 'on' : 'off'); } },
  bg: { label: '근거 승격', grade: 'R2', fn: handleConProcBgSet, args: { bg_ver: 's' }, row: function (a) { return 'bg:' + a.bg_ver; } },
};
const PMCON_CHOICES = { ok: 'ㄱ', 'default': '기본값', hold: '보류', reopen: '다시 열기' };
const PMCON_ROW = /^[a-z]{2,10}:[0-9A-Za-z_.:-]{0,80}$/;
const PMCON_DATE = /^20\d{2}-\d{2}-\d{2}$/;
function pmconEmpty() { return { schema: 1, log: [], folded: { n: 0, from: 0, to: 0 }, marks: {}, updated_at: 0, updated_by: '' }; }
async function pmconRead(st) {   // { ok, doc } — 없음 = 빈 기록 · 읽기 실패·깨진 값 = ok false(그 위에 쓰지 않음)
  const r = await blobGet(st, PMCON_KEY);
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, doc: pmconEmpty() } : { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  if (r.data === null || r.data === undefined) return { ok: true, doc: pmconEmpty() };   // 실 blobs.js의 '없음'
  const x = r.data;
  if (!x || typeof x !== 'object' || !Array.isArray(x.log) || (x.marks && (typeof x.marks !== 'object' || Array.isArray(x.marks)))) return { ok: false, code: 'PMCON_BAD_DOC' };
  return { ok: true, doc: Object.assign(pmconEmpty(), x, { folded: Object.assign({ n: 0, from: 0, to: 0 }, x.folded || {}), marks: Object.assign({}, x.marks || {}) }) };
}
function pmconFold(doc) {   // 상한 넘친 오래된 기록을 접음(지우는 대신 건수·기간)
  const over = doc.log.length - PMCON_LOG_MAX;
  if (over > 0) {
    const gone = doc.log.splice(0, over);
    doc.folded = { n: (Number(doc.folded.n) || 0) + gone.length, from: Number(doc.folded.from) || Number(gone[0].ts) || 0, to: Number(gone[gone.length - 1].ts) || 0 };
  }
}
// 판29 검토(11/13): 표시(보류·그대로)를 더할 자리 — 60개가 차면 지금 화면에 줄이 없는 표시(live 목록 밖)부터 오래된 순으로 버리고,
//   그래도 차면 false(새 표시를 400 PMCON_MARKS_FULL로 거절 — 가장 오래된 보류가 말없이 풀려 '정할 것'으로 돌아오지 않게).
//   live = 화면이 지금 그린 줄 id 전부(정할 것 + 보류함). 화면이 조회 하나라도 못 읽었으면 live를 보내지 않는다 → 아무것도 버리지 않음.
function pmconMarkRoom(doc, row, live) {
  if (Object.prototype.hasOwnProperty.call(doc.marks, row)) return true;
  const ks = Object.keys(doc.marks);
  if (ks.length < PMCON_MARK_MAX) return true;
  if (!live) return false;
  const gone = ks.filter(function (k) { return !live[k]; }).sort(function (a, b) { return (Number(doc.marks[a].ts) || 0) - (Number(doc.marks[b].ts) || 0); });
  const need = ks.length - PMCON_MARK_MAX + 1;
  if (gone.length < need) return false;
  gone.slice(0, need).forEach(function (k) { delete doc.marks[k]; });
  return true;
}
function pmconTxt(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function pmconArgs(kind, a) {   // 넘길 칸만 꼴 검사 — 값 자체(허용 선택지·재직 명부·판 존재)는 기존 핸들러가 본다. null = 거절
  const spec = PMCON_KINDS[kind].args;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const ks = Object.keys(a);
  if (ks.length !== Object.keys(spec).length || ks.some(function (k) { return !Object.prototype.hasOwnProperty.call(spec, k); })) return null;
  const out = {};
  for (const k of ks) {
    const t = spec[k], v = a[k];
    if (t === 'b') { if (typeof v !== 'boolean') return null; }
    else if (t !== 's') { if (v !== t) return null; }   // 고정 글자 칸(브리핑 field = 'on'만)
    else if (typeof v !== 'string' || v.length > 60) return null;
    out[k] = v;
  }
  return out;
}
async function pmconGate(event, R, write) {   // 로그인 → 기기 승인 → 관리자 → (쓰기) PM. { c, isPm } 또는 { res }
  const c = await currentMember(event);
  if (!c.ok) return { res: jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R }) };
  if (!(await deviceApproved(event, c.member))) return { res: jr(403, { status: 'FORBIDDEN', error_code: 'DEVICE_NOT_APPROVED', request_id: R }) };
  if (!c.member.admin) return { res: jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R }) };
  let tc = null; try { tc = await push.tierCtx(); } catch (e) { tc = null; }
  const known = !!(tc && !tc.unavailable);
  const isPm = known && tc.tierOf(c.member) === 'pm';
  if (write) {
    if (!known) return { res: jr(503, { status: 'ERROR', error_code: 'MEMBERS_UNAVAILABLE', request_id: R }) };   // 명부 없이는 PM인지 모름 — 쓰지 않음
    if (!isPm) return { res: jr(403, { status: 'FORBIDDEN', error_code: 'PM_ONLY', request_id: R }) };
  }
  return { c: c, isPm: isPm, known: known, pmN: known ? tc.pmIds.length : 0 };
}
async function handlePmconGet(event, d, R) {
  const g = await pmconGate(event, R, false); if (g.res) return g.res;
  const s = await pmconRead(store(DATA));
  if (!s.ok) return jr(503, { status: 'ERROR', error_code: 'PMCON_READ_FAILED', request_id: R });
  const log = s.doc.log.slice(-PMCON_GET_MAX).reverse();   // 최근 것부터
  return jr(200, { status: 'OK', log: log, total: s.doc.log.length, folded: s.doc.folded, marks: s.doc.marks, updated_at: Number(s.doc.updated_at) || 0,
    can_write: g.isPm, pm_known: g.known, pm_present: g.pmN > 0, request_id: R });
}
async function handlePmconDecide(event, d, R) {
  const g = await pmconGate(event, R, true); if (g.res) return g.res; const c = g.c;
  const kind = String(d.kind || ''), choice = String(d.choice || ''), row = String(d.row || '');
  if (!Object.prototype.hasOwnProperty.call(PMCON_KINDS, kind)) return jr(400, { status: 'REJECTED', error_code: 'BAD_KIND', request_id: R });
  if (!Object.prototype.hasOwnProperty.call(PMCON_CHOICES, choice)) return jr(400, { status: 'REJECTED', error_code: 'BAD_CHOICE', request_id: R });
  if (!PMCON_ROW.test(row) || row.indexOf(kind + ':') !== 0) return jr(400, { status: 'REJECTED', error_code: 'BAD_ROW', request_id: R });
  const grade = String(d.grade || '');
  if (grade !== PMCON_KINDS[kind].grade) return jr(400, { status: 'REJECTED', error_code: 'BAD_GRADE', request_id: R });
  const due = d.due === undefined || d.due === null ? '' : String(d.due);
  if (due && !PMCON_DATE.test(due)) return jr(400, { status: 'REJECTED', error_code: 'BAD_DUE', request_id: R });
  if (d.why !== undefined && (typeof d.why !== 'string' || d.why.length > 200)) return jr(400, { status: 'REJECTED', error_code: 'BAD_WHY', request_id: R });
  // 고칠 값: ㄱ = 반드시 있음 · 기본값 = 있거나(그 값 적용) 없음(무응답 기본값이 '그대로' — 기록만) · 보류·다시 열기 = 없음(설정을 바꾸지 않음)
  const hasArgs = d.args !== undefined && d.args !== null;
  let live = null;   // 화면이 지금 그린 줄 id(표시 자리 낼 때만 씀)
  if (d.live !== undefined) {
    if (!Array.isArray(d.live) || d.live.length > 300 || d.live.some(function (x) { return typeof x !== 'string' || !PMCON_ROW.test(x); })) return jr(400, { status: 'REJECTED', error_code: 'BAD_LIVE', request_id: R });
    live = {}; d.live.forEach(function (x) { live[x] = 1; });
  }
  if ((choice === 'ok' && !hasArgs) || ((choice === 'hold' || choice === 'reopen') && hasArgs)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ARGS', request_id: R });
  let args = null;
  if (hasArgs) {
    args = pmconArgs(kind, d.args);
    if (!args) return jr(400, { status: 'REJECTED', error_code: 'BAD_ARGS', request_id: R });
    if (PMCON_KINDS[kind].row(args) !== row) return jr(400, { status: 'REJECTED', error_code: 'BAD_ROW', request_id: R });   // 누른 줄과 바꾸는 값이 다름
    if (typeof d.set_base !== 'number' || !isFinite(d.set_base)) return jr(400, { status: 'REJECTED', error_code: 'NEED_SET_BASE', request_id: R });   // 기존 핸들러는 base가 없으면 낙관락을 건너뛴다 — 콘솔 길은 늘 싣게
  }
  const st = store(DATA);
  const s0 = await pmconRead(st);
  if (!s0.ok) return jr(503, { status: 'ERROR', error_code: 'PMCON_READ_FAILED', request_id: R });
  if (d.base === undefined || Number(d.base) !== Number(s0.doc.updated_at || 0)) return jr(409, { status: 'CONFLICT', error_code: 'PMCON_STALE', request_id: R });
  let applied = null;
  if (args) {   // 기존 핸들러 그대로 — 같은 요청(같은 회원·기기)으로 부르므로 updated_by·감사 줄이 누른 회원으로 남는다
    const inner = await PMCON_KINDS[kind].fn(event, Object.assign({}, args, { base: d.set_base }), R);
    if (!inner || inner.statusCode !== 200) return inner;   // 거절(값 검사 400·낙관락 409·권한 403 …)은 그 응답 그대로 — 기록 0
    applied = { kind: kind, args: args };
  }
  const now = Date.now();
  const rec = { ts: now, by: c.member.id, name: pmconTxt(c.member.name, 20), row: row, kind: kind, choice: choice, grade: grade, due: due,
    q: pmconTxt(d.q, 160), rec: pmconTxt(d.rec, 80), val: pmconTxt(d.val, 80), match: choice === 'ok' ? !!applied : (choice === 'default' ? (d.def_is_rec === true && !!applied) : null),   // '추천대로'는 실제 적용과 묶어서만 참
    why: pmconTxt(d.why, 200), applied: !!applied, via: 'console' };
  // 쓰기 직전 다시 읽기 — 기존 핸들러를 부르는 사이 다른 기록이 들어왔으면 그 위에 덧붙인다(기록은 덧붙이기만 하므로 합쳐도 잃는 것 없음)
  const s1 = await pmconRead(st);
  if (!s1.ok) return jr(500, { status: 'ERROR', error_code: 'PMCON_WRITE_FAILED', applied: !!applied, request_id: R });
  const doc = s1.doc;
  const addMark = choice === 'hold' || (choice === 'default' && !applied);
  if (addMark && !pmconMarkRoom(doc, row, live)) return jr(400, { status: 'REJECTED', error_code: 'PMCON_MARKS_FULL', max: PMCON_MARK_MAX, request_id: R });   // 값 바꾸기 없는 선택만 여기 옴(기존 핸들러 안 부름)
  doc.log.push(rec);
  if (choice === 'hold') doc.marks[row] = { st: 'hold', ts: now, by: c.member.id, why: rec.why };
  else if (choice === 'default' && !applied) doc.marks[row] = { st: 'keep', ts: now, by: c.member.id, why: rec.why };
  else delete doc.marks[row];   // ㄱ·값 적용·다시 열기 = 표시 지움
  pmconFold(doc);
  doc.schema = 1; doc.updated_by = c.member.id; doc.updated_at = Math.max(now, (Number(s1.doc.updated_at) || 0) + 1);   // 같은 ms 두 기록도 낙관락 토큰이 달라지게
  const w = await blobSet(st, PMCON_KEY, doc);
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: 'PMCON_WRITE_FAILED', applied: !!applied, request_id: R });
  let pmAu = false;
  try { pmAu = await appendAudit({ ts: now, by: c.member.name, bid: c.member.id, col: 'pmcon', ev: [{ op: 'PM콘솔', id: row, t: PMCON_KINDS[kind].label + ' · ' + PMCON_CHOICES[choice] + (applied ? ' · 적용' : '') + ' · ' + grade + (rec.q ? ' · ' + rec.q.slice(0, 80) : '') }] }) !== false; } catch (e) { pmAu = false; }
  return jr(200, { status: 'OK', record: rec, applied: !!applied, marks: doc.marks, updated_at: doc.updated_at, audit: pmAu, request_id: R });
}
// P1 판30 계약 서류 목록 분기 점검(PM 콘솔 점검 카드) — 계산·핸들러는 _lib/conchk.js 한 곳. 읽기 = pmconGate(관리자) · [확인] = pmconGate(PM) + 누른 기록 1줄(row conchk:<분기>)
const CONCHK = require('./_lib/conchk').handlers({ gate: pmconGate, read: pmconRead, fold: pmconFold, key: PMCON_KEY, store: function () { return store(DATA); }, blobGet, blobSet, blobList, appendAudit, LN, colKey, jr });

// v378 큰 본문 양방향 gzip(2026-10-08 실사고): col:bids가 9/11 3.94MB(2,462건)에서 10/8 07:52 분할 전송 수신 뒤 6.69MB(3,953건)로 자라
// Netlify 동기 함수 응답 한도 6MB(6,291,456B)를 넘자 get이 실패했고, 앱은 그 실패를 삼켜 "수집된 공고가 없습니다"로 보였다(PM "기존거 다 날라갔나").
// 저장(save) 본문도 같은 6MB 요청 한도라 상태 변경이 조용히 유실될 자리였다.
//   ① 응답: 본문이 GZ_MIN을 넘고 클라가 gzip을 받으면 gzip+base64(isBase64Encoded) — 한도는 함수가 돌려주는 바이트로 센다(6.69MB → 약 1.2MB)
//   ② 요청: 앱 gwCall이 1MB 넘는 본문을 CompressionStream으로 gzip해 application/octet-stream + X-GW-Enc: gzip 으로 보낸다(base64·binary 모두 수용)
// 무손실·모든 액션 공통. 자라는 데이터의 근본 상한(보관 기간)은 PM 결정으로 남긴다(FEATURES v378).
const GZ_MIN = 1024 * 1024;
const GZ_MAX_B64 = 6000000;   // Lambda가 거부하는 응답 상한(6,291,556B) 아래 — 압축해도 넘으면 502 대신 명시적 오류
// v379(10/8 15:57 실사고): v378은 accept-encoding에 gzip이 있을 때만 압축했는데, 브라우저 요청에서 함수가 받은 헤더에는 gzip이 없었다
// (curl 탐침에는 보였음) → 평문 6.78MB → LAMBDA_RUNTIME 413 "Exceeded maximum allowed payload size" → 앱에 502. 모든 브라우저·node fetch가
// gzip을 푸므로 헤더를 보지 않고 1MB 초과면 무조건 압축한다. 로그 한 줄로 크기·시간·헤더값을 남긴다(가시화).
function gzipOut(event, res) {
  try {
    if (!res || typeof res.body !== 'string' || res.body.length < GZ_MIN || res.isBase64Encoded) return res;
    const h = (event && event.headers) || {};
    const ae = String(h['accept-encoding'] || h['Accept-Encoding'] || '');
    const t0 = Date.now();
    const raw = Buffer.from(res.body, 'utf8');
    const gz = zlib.gzipSync(raw, { level: 6 });
    const b64 = gz.toString('base64');
    console.log('[gzipOut] raw ' + raw.length + 'B → gz ' + gz.length + 'B (b64 ' + b64.length + 'B) ' + (Date.now() - t0) + 'ms · accept-encoding="' + ae.slice(0, 60) + '"');
    if (b64.length > GZ_MAX_B64) return jr(500, { status: 'ERROR', error_code: 'PAYLOAD_TOO_LARGE', raw_bytes: raw.length, gz_bytes: gz.length, request_id: rid() });
    return { statusCode: res.statusCode, headers: Object.assign({}, res.headers, { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'X-GW-Raw-Bytes': String(raw.length) }), body: b64, isBase64Encoded: true };
  } catch (e) { console.log('[gzipOut] 실패 ' + String(e && e.message)); return res; }
}
// v456(원장 C066): 요청 본문 gzip 풀기 상한 — 로그인 확인보다 먼저 풀리므로 6MB 안의 압축 본문이 수백 MB로 풀려 그 호출이 메모리 초과로 죽던 길(데이터 손상·다른 요청 영향은 없었음).
//   지금 가장 큰 정상 요청 = 일감 저장(풀린 크기 약 6.7MB) — 32MB면 다섯 배 여유. 넘으면 zlib이 ERR_BUFFER_TOO_LARGE를 던지고 handlerInner가 413 BODY_TOO_LARGE로 돌려준다(종전 400 INVALID_JSON으로 뭉뚱그림).
const BODY_GZ_MAX = 32 * 1024 * 1024;
function parseBody(event) {
  const h = (event && event.headers) || {};
  const enc = String(h['x-gw-enc'] || h['X-GW-Enc'] || '').toLowerCase();
  let txt = event.body || '';
  if (enc === 'gzip') txt = zlib.gunzipSync(Buffer.from(txt, event.isBase64Encoded ? 'base64' : 'binary'), { maxOutputLength: BODY_GZ_MAX }).toString('utf8');
  else if (event.isBase64Encoded) txt = Buffer.from(txt, 'base64').toString('utf8');
  return JSON.parse(txt || '{}');
}
async function handler(event) {
  const res = await handlerInner(event);
  return gzipOut(event, res);
}
async function handlerInner(event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { status: 'REJECTED', error_code: 'METHOD_NOT_ALLOWED', request_id: R });
  setupBlobContext(event);
  let d;
  try { d = parseBody(event); } catch (e) {
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') return jr(413, { status: 'REJECTED', error_code: 'BODY_TOO_LARGE', request_id: R });   // v456 C066 — 풀린 본문이 BODY_GZ_MAX를 넘음
    return jr(400, { status: 'REJECTED', error_code: 'INVALID_JSON', request_id: R });
  }
  try {
    // 비용 실측 결과 조회(임시, 2026-09-10) — 관리자 전용. 계측기를 지울 때 이 분기도 함께 지운다.
    if (d && d.action === 'meter') {
      const cm = await currentMember(event);
      if (!cm.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: cm.reason, request_id: R });
      if (!cm.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });
      const mr = await blobGet(store(DATA), 'meter:cost');
      return jr(200, { status: 'OK', doc: (mr.ok && mr.data) ? mr.data : { schema: 1, rows: [] }, request_id: R });
    }
    if (d && d.action === 'get') return await handleGet(event, d, R);
    if (d && d.action === 'site_edu_gap') return await handleSiteEduGap(event, d, R);   // v433 현장 대장 특별교육 미이수(이름만 — 안전 권한 없는 현장 권한자용)
    if (d && d.action === 'save') return await handleSave(event, d, R);
    if (d && d.action === 'veh_due_set') return await handleVehDueSet(event, d, R);   // P1 판2 차량 지시 완료 창 새 만기일(차량 한 줄 한 칸)
    if (d && d.action === 'veh_bg_get') return await handleVehBgGet(event, d, R);   // P1 판27 차량 법령 근거(승격본만 — 아니면 on false)
    if (d && d.action === 'lic_month_get') return await handleLicMonthGet(event, d, R);   // P1 판28 인허가 '이번 달' 탭 읽기(승격본 자동 회차 행·내가 누를 수 있는 행)
    if (d && d.action === 'lic_duty_set') return await handleLicDutySet(event, d, R);   // P1 판28 '이번 달' 단추 네 가지(완료·기한 정정·해당 없음·기준일) + 관리자 해당 없음 되돌리기
    if (d && d.action === 'audit') return await handleAudit(event, d, R);
    if (d && d.action === 'ver_list') return await handleVerList(event, d, R);
    if (d && d.action === 'ver_get') return await handleVerGet(event, d, R);
    if (d && d.action === 'ver_restore') return await handleVerRestore(event, d, R);
    if (d && d.action === 'ver_purge') return await handleVerPurge(event, d, R);
    if (d && d.action === 'bids_ingest') return await handleBidsIngest(event, d, R);
    if (d && d.action === 'autotask_ingest') return await handleAutotaskIngest(event, d, R);
    if (d && d.action === 'settings_apply') return await handleSettingsApply(event, d, R);   // v453 봇 키 서버 설정 적용(R1 — CLI 직접 쓰기 대신, 감사 '설정적용')
    if (d && d.action === 'bot_notify') return await handleBotNotify(event, d, R);
    if (d && d.action === 'inquiry_notify') return await handleInquiryNotify(event, d, R);
    if (d && d.action === 'bids_refresh') return await handleBidsRefresh(event, d, R);
    if (d && d.action === 'bids_purge') return await handleBidsPurge(event, d, R);
    if (d && d.action === 'onbid_purge') return await handleOnbidPurge(event, d, R);   // v444 부동산 정리 세기(dry만 — 관리자)
    if (d && d.action === 'onbid_purge_set') return await handleOnbidPurgeSet(event, d, R);   // v444 부동산 정리 켜기·끄기(관리자 — 기본 꺼짐)
    if (d && d.action === 'bids_export') return await handleBidsExport(event, d, R);
    if (d && d.action === 'bids_results') return await handleBidsResults(event, d, R);
    if (d && d.action === 'bldg_lookup') return await handleBldgLookup(event, d, R);
    if (d && d.action === 'promo_geo') return await handlePromoGeo(event, d, R);
    if (d && d.action === 'bid_sheet') return await handleBidSheet(event, d, R);
    if (d && d.action === 'backup_list') return await handleBackupList(event, d, R);
    if (d && d.action === 'backup_get') return await handleBackupGet(event, d, R);
    if (d && d.action === 'backup_stamp') return await handleBackupStamp(event, d, R);
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
    if (d && d.action === 'assign_get') return await handleAssignGet(event, d, R);
    if (d && d.action === 'task_notmine') return await handleTaskNotmine(event, d, R);   // v413 [내 것 아님](담당자)
    if (d && d.action === 'assign_set') return await handleAssignSet(event, d, R);
    if (d && d.action === 'assign_revert') return await handleAssignRevert(event, d, R);
    if (d && d.action === 'notify_get') return await handleNotifyGet(event, d, R);
    if (d && d.action === 'notify_set') return await handleNotifySet(event, d, R);
    if (d && d.action === 'notify_revert') return await handleNotifyRevert(event, d, R);
    if (d && d.action === 'doneif_get') return await handleDoneifGet(event, d, R);
    if (d && d.action === 'doneif_set') return await handleDoneifSet(event, d, R);
    if (d && d.action === 'brief_get') return await handleBriefGet(event, d, R);   // v416 아침 음성 브리핑(체크 38 D1)
    if (d && d.action === 'brief_set') return await handleBriefSet(event, d, R);
    if (d && d.action === 'brief_revert') return await handleBriefRevert(event, d, R);
    if (d && d.action === 'brief_run') return await handleBriefRun(event, d, R);
    if (d && d.action === 'brief_voices') return await handleBriefVoices(event, d, R);
    if (d && d.action === 'brief_mp3') return await handleBriefMp3(event, d, R);
    if (d && d.action === 'autotask_facts') return await handleAutotaskFacts(event, d, R);   // v417 카드 10(봇 키)
    if (d && d.action === 'autotask_dry_put') return await handleAutotaskDryPut(event, d, R);
    if (d && d.action === 'autotask_get') return await handleAutotaskGet(event, d, R);
    if (d && d.action === 'autotask_set') return await handleAutotaskSet(event, d, R);
    if (d && d.action === 'autotask_revert') return await handleAutotaskRevert(event, d, R);
    if (d && d.action === 'alerts_get') return await handleAlertsGet(event, d, R);
    if (d && d.action === 'alerts_set') return await handleAlertsSet(event, d, R);
    if (d && d.action === 'con_proc_get') return await handleConProcGet(event, d, R);
    if (d && d.action === 'con_proc_flag_set') return await handleConProcFlagSet(event, d, R);
    if (d && d.action === 'con_proc_bg_set') return await handleConProcBgSet(event, d, R);   // v404
    if (d && d.action === 'con_proc_edit') return await handleConProcEdit(event, d, R);
    if (d && d.action === 'con_clog_add') return await handleConClogAdd(event, d, R);
    if (d && d.action === 'box_put') return await handleBoxPut(event, d, R);   // v423 넣기 박스
    if (d && d.action === 'cdoc_attach') return await handleCdocAttach(event, d, R);
    if (d && d.action === 'cdoc_move') return await handleCdocMove(event, d, R);
    if (d && d.action === 'box_fix') return await handleBoxFix(event, d, R);
    if (d && d.action === 'box_pending') return await handleBoxPending(event, d, R);
    if (d && d.action === 'cdoc_put') return await handleCdocPut(event, d, R);   // v406 계약 서류함(D3)
    if (d && d.action === 'cdoc_list') return await handleCdocList(event, d, R);
    if (d && d.action === 'cdoc_get') return await handleCdocGet(event, d, R);
    if (d && d.action === 'cdoc_del') return await handleCdocDel(event, d, R);
    if (d && d.action === 'cdoc_restore') return await handleCdocRestore(event, d, R);
    if (d && d.action === 'cdoc_cur') return await handleCdocCur(event, d, R);
    if (d && d.action === 'cdoc_purge') return await handleCdocPurge(event, d, R);
    if (d && d.action === 'rec_log_get') return await handleRecLogGet(event, d, R);
    if (d && d.action === 'learn_settings_get') return await handleLearnSettingsGet(event, d, R);   // v410 계약 학습 스위치·허용 사전(관리자)
    if (d && d.action === 'learn_settings_set') return await handleLearnSettingsSet(event, d, R);
    if (d && d.action === 'learn_pairs_get') return await handleLearnPairsGet(event, d, R);
    if (d && d.action === 'learn_defaults_get') return await handleLearnDefaultsGet(event, d, R);   // v411 생성 주입(학습된 칸 기본값)
    if (d && d.action === 'learn_tpl_set') return await handleLearnTplSet(event, d, R);   // v412 양식별 끄기/켜기(일몰 되돌리기)
    if (d && d.action === 'doc_settings_get') return await handleDocSettingsGet(event, d, R);
    if (d && d.action === 'doc_settings_set') return await handleDocSettingsSet(event, d, R);
    if (d && d.action === 'safety_settings_get') return await handleSafetySettingsGet(event, d, R);   // v436 안전 설정(현황 ⑤ 인정·평가·회사 구분) — 안전 권한 읽기
    if (d && d.action === 'safety_settings_set') return await handleSafetySettingsSet(event, d, R);   // v436 관리자만
    if (d && d.action === 'corp_reg_get') return await handleCorpRegGet(event, d, R);   // P1 판1 법인 등기 날짜·투찰 잠금(settings:corp_reg) — 관리자만
    if (d && d.action === 'corp_reg_set') return await handleCorpRegSet(event, d, R);
    if (d && d.action === 'pmcon_get') return await handlePmconGet(event, d, R);   // P1 판29 PM 콘솔 누른 기록(status:decide) — 관리자 읽기
    if (d && d.action === 'pmcon_decide') return await handlePmconDecide(event, d, R);   // P1 판29 [ㄱ]/[보류]/[기본값] — PM만 · 값 바꾸기는 기존 핸들러
    if (d && d.action === 'conchk_get') return await CONCHK.get(event, d, R);   // P1 판30 계약 서류 분기 점검 카드 — 관리자 읽기
    if (d && d.action === 'conchk_confirm') return await CONCHK.confirm(event, d, R);   // P1 판30 [확인] 분기 1회 — PM만 · 누른 기록 1줄
    if (d && d.action === 'doc_att_put') return await handleDocAttPut(event, d, R);
    if (d && d.action === 'doc_att_get') return await handleDocAttGet(event, d, R);
    if (d && d.action === 'doc_att_del') return await handleDocAttDel(event, d, R);
    if (d && d.action === 'doc_log_get') return await handleDocLogGet(event, d, R);   // v388 열람 이력(관리자)
    if (d && d.action === 'doc_bulk_put') return await handleDocBulkPut(event, d, R);
    if (d && d.action === 'doc_restore') return await handleDocRestore(event, d, R);
    if (d && d.action === 'doc_purge') return await handleDocPurge(event, d, R);
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
