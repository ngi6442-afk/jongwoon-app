'use strict';
// C240 판 A-2a — 휴가(col:leaves) 문서의 줄·칸을 서버가 가르는 규칙(gw-data handleGet·handleSave가 부른다).
//   근거 = 앱(index.html)이 비관리자 계정에서 실제로 읽고 쓰는 줄·칸 전수 표(09_조사_문서/서버권한_자료_20261120/막는판A_문서초안_1120.md ④ · 판 A 4578f04 rowguard.js의 휴가 부분을 옮김).
//   판 A 검토(11/20 판A_검토_1120)에서 확정된 두 뿌리를 같이 닫는다:
//     ㉮ '200인데 조용히 되돌림' — 서버가 받지 않은 본인 줄은 id를 돌려주고(kept) 앱이 다시 읽어 서버 값으로 그린다(낡은 화면 [철회]가 화면에서만 철회로 보이던 것)
//     ㉯ '줄인 사본을 받은 화면이 통째 저장' — 남의 줄은 표시(_view)를 달아 내려 주고, 누구의 저장이든 표시 달린 줄·빠진 줄은 서버 원본(직원 화면을 연 채 관리자가 된 경우)

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function sameRow(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) { const k = ka[i]; if (!hasOwn(b, k) || JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false; }
  return true;
}
// 칸 지키기 — b(보낸 줄)의 칸 순서를 따라 allow(k)인 칸은 보낸 값, 아닌 칸은 원본 값(원본에 없으면 뺌) · 보낸 줄에 없는 원본 칸은 allow가 아니면 원본 값으로 되살림
//   (정상 저장 = 보낸 줄이 원본 + 허용 칸 고침이라 결과가 보낸 줄과 글자째 같다 → kept 아님)
function keepFields(o, b, allow) {
  const out = {};
  Object.keys(b).forEach(function (k) { if (allow(k)) out[k] = b[k]; else if (hasOwn(o, k)) out[k] = o[k]; });
  Object.keys(o).forEach(function (k) { if (!hasOwn(out, k) && !allow(k)) out[k] = o[k]; });
  return out;
}
function noView(x) { if (!x || typeof x !== 'object' || !hasOwn(x, '_view')) return x; const s = Object.assign({}, x); delete s._view; return s; }

// 앱 LEAVE_PARTIAL(반차·반반차)과 같은 키 — uismoke 'C240 A-2a'가 앱 표와 대조
const LEAVE_PARTIAL = { half_am: 1, half_pm: 1, quarter_am: 1, quarter_pm: 1 };
// 남의 줄에서 앱이 쓰는 칸(캘린더 calEvents — 같은 부서의 승인된 연차·반차·휴직의 기간·이름) — 종류 칸은 연차·반차·휴직만 오므로 병가·사직 같은 종류는 남에게 가지 않는다
const LEAVE_VIEW_FIELDS = ['id', 'member_id', 'member_name', 'type', 'status', 'start', 'end'];
// 읽기: 본인 줄 = 통째(지운 줄 포함) · 남의 줄 = 앱 캘린더가 그리는 줄(지우지 않음·승인·연차/반차/휴직·같은 부서 — 앱 leaveCalVisible과 같은 판정, 부서는 서버 회원 레코드)만 위 칸 + _view 1 · 그 밖은 뺌
//   members = 회원 레코드 전부(push.loadMembers) — 지운 회원(del 1)은 앱 회원 목록에 없어 앱이 그리지 않으므로 같이 뺀다 · members가 null(못 읽음)이면 본인 줄만
function leavesView(me, items, members) {
  const dept = Object.create(null);
  (members || []).forEach(function (m) { if (m && m.id && m.del !== 1) dept[m.id] = m.dept; });
  const myDept = me && me.dept;
  const out = [];
  (items || []).forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    if (me && me.id && x.member_id === me.id) { out.push(noView(x)); return; }
    if (!members) return;
    if (x.del === 1 || x.status !== 'approved') return;
    if (!(x.type === 'annual' || hasOwn(LEAVE_PARTIAL, x.type) || x.type === 'loa')) return;
    if (!myDept || !hasOwn(dept, x.member_id) || dept[x.member_id] !== myDept) return;
    const s = {};
    LEAVE_VIEW_FIELDS.forEach(function (k) { if (hasOwn(x, k)) s[k] = x[k]; });
    s._view = 1;
    out.push(s);
  });
  return out;
}
// 관리자만 쓰는 칸(앱 setLeaveStatus·면담완료·취소 승인/반려가 쓰는 칸 + 신청자·이름) — 본인 대기 줄에서도 서버 원본
const LEAVE_ADMIN_F = { status: 1, stage: 1, approver: 1, approved_at: 1, interview_at: 1, interviewer: 1, cancel_approver: 1, cancel_req: 1, cancel_req_at: 1, applied_at: 1, member_id: 1, member_name: 1, _view: 1 };
// 본인 줄 하나 지키기(a = 서버 원본 · b = 보낸 줄). 앱이 본인에게 허용하는 고침(전수 표 ㉠)만 보낸 값:
//   승인 줄 = [취소 요청](cancel_req true·cancel_req_at·updated — 아직 취소 요청 전이고 지운 줄이 아닐 때) 말고는 원본 · 반려 줄 = 원본
//   사직·휴직 대기 줄이 면담 신청(interview_req) 다음 단계로 간 것(승인 절차 진행) = [취소](del 1·updated)·면담완료 → 본신청(stage resign_req·applied_at·updated) 말고는 원본
//   그 밖 대기 줄 = 관리자 칸(LEAVE_ADMIN_F)만 원본(상태를 스스로 못 바꿈) — 철회(del 1) 등 나머지는 보낸 값
function leaveOwnGuard(a, b) {
  let allow;
  if (a.status === 'approved') {
    const cx = a.del !== 1 && !a.cancel_req && b.cancel_req === true;
    allow = function (k) { return cx && (k === 'cancel_req' || k === 'cancel_req_at' || k === 'updated'); };
  } else if (a.status === 'rejected') {
    allow = function () { return false; };
  } else if ((a.type === 'resign' || a.type === 'loa') && (a.stage || 'resign_req') !== 'interview_req') {
    const wd = a.del !== 1 && b.del === 1;
    const ap = a.del !== 1 && a.stage === 'interview_done' && b.stage === 'resign_req';
    allow = function (k) { return (wd && k === 'del') || (ap && (k === 'stage' || k === 'applied_at')) || ((wd || ap) && k === 'updated'); };
  } else {
    allow = function (k) { return !hasOwn(LEAVE_ADMIN_F, k); };
  }
  return keepFields(a, b, allow);
}
// 비관리자 저장 재구성: 남의 줄 = 서버 원본 그대로(보낸 사본은 안 씀) · 본인 줄 = 서버 원본의 주인으로 가름(보낸 member_id가 아니라)
//   · 같은 id의 서버 줄이 남의 것이면 보낸 줄은 버림 · 서버에 없는 새 id = 보낸 member_id가 본인일 때만(종전) · 승인으로 보내면 대기로(종전) · 이름 칸은 서버의 회원 이름
//   · 같은 id 두 줄 = 앞 줄만 · 본인 서버 줄이 보낸 목록에서 빠지면 서버 원본 이월(앱은 줄을 빼지 않고 del 1로 지움)
//   kept = 서버가 보낸 값을 받지 않은 줄 id(되돌린 본인 줄 · 버린 줄 · 고친 새 줄) — 응답 leave_kept로 앱이 다시 읽음(㉮)
function leavesRebuild(me, oldItems, items) {
  const mine = me.id;
  const others = (oldItems || []).filter(function (o) { return o && o.member_id !== mine; });
  const ownOld = Object.create(null), otherBy = Object.create(null);   // id 표는 프로토타입 없는 객체(좁은 확인: id '__proto__' 줄이 {}에서는 칸이 안 돼 이월·가드를 건너뜀)
  (oldItems || []).forEach(function (o) {
    if (!o || o.id == null || o.id === '') return;
    const k = String(o.id);
    if (o.member_id === mine) { if (!hasOwn(ownOld, k)) ownOld[k] = o; } else if (!hasOwn(otherBy, k)) otherBy[k] = o;
  });
  const seen = Object.create(null), own = [], kept = [];
  const keep = function (b) { const id = (b && b.id != null) ? String(b.id).slice(0, 60) : ''; if (kept.indexOf(id) < 0) kept.push(id); };
  (items || []).forEach(function (b) {
    if (!b || typeof b !== 'object') return;
    const k = (b.id == null || b.id === '') ? null : String(b.id);
    const a = k !== null && hasOwn(ownOld, k) ? ownOld[k] : null;
    // 남의 줄 — 서버 원본이 others로 들어감. 내려 준 _view 사본이거나 서버 원본과 글자째 같은 사본(이 판 전에 받은 통째 사본)은 고친 시도가 아님 · 다르면 kept
    if (!a && k !== null && hasOwn(otherBy, k)) { if (!b._view && !sameRow(otherBy[k], b)) keep(b); return; }
    if (!a && b.member_id !== mine) { if (!b._view) keep(b); return; }
    if (k !== null) { if (hasOwn(seen, k)) { keep(b); return; } seen[k] = 1; }
    if (a) { const g = leaveOwnGuard(a, b); if (!sameRow(g, b)) keep(b); own.push(g); return; }
    let s = noView(b);
    if (s.status === 'approved') s = Object.assign({}, s, { status: 'pending' });
    if (hasOwn(s, 'member_name') && s.member_name !== String(me.name || '')) s = Object.assign({}, s, { member_name: String(me.name || '') });
    if (!sameRow(s, b)) keep(b);
    own.push(s);
  });
  const carried = [];
  Object.keys(ownOld).forEach(function (k) { if (!hasOwn(seen, k)) carried.push(ownOld[k]); });
  return { items: others.concat(own, carried), carried: carried.length, kept: kept };
}
// 관리자 저장: 표시(_view) 달린 줄 = 서버 원본(서버에 없으면 버림) · 서버에 있는데 보낸 목록에서 빠진 줄 = 서버 원본 이월(앱은 휴가 줄을 빼지 않고 del 1로 지움)
//   — 직원으로 받은 줄인 사본을 든 채 관리자가 된 화면의 저장이 전사 휴가를 줄이지 않게(㉯). 표시 달린 줄이 있었으면 kept로 그 화면이 다시 읽게 한다
function leavesAdminFix(oldItems, items) {
  const oldBy = Object.create(null);
  (oldItems || []).forEach(function (o) { if (o && o.id != null && o.id !== '' && !hasOwn(oldBy, String(o.id))) oldBy[String(o.id)] = o; });
  const seen = Object.create(null), out = [], kept = [];
  (items || []).forEach(function (b) {
    if (!b || typeof b !== 'object') { out.push(b); return; }
    const k = (b.id == null || b.id === '') ? null : String(b.id);
    if (k !== null) seen[k] = 1;
    if (!hasOwn(b, '_view')) { out.push(b); return; }
    if (kept.indexOf(String(k).slice(0, 60)) < 0) kept.push(String(k).slice(0, 60));
    if (k !== null && hasOwn(oldBy, k)) out.push(oldBy[k]);
  });
  let carried = 0;
  (oldItems || []).forEach(function (o) { if (o && o.id != null && o.id !== '' && !hasOwn(seen, String(o.id))) { seen[String(o.id)] = 1; out.push(o); carried++; } });
  return { items: out, carried: carried, kept: kept };
}

module.exports = { LEAVE_PARTIAL, LEAVE_VIEW_FIELDS, LEAVE_ADMIN_F, leavesView, leaveOwnGuard, leavesRebuild, leavesAdminFix, keepFields, sameRow };
