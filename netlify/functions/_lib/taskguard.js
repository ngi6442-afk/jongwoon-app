'use strict';
// C240 판 A-2b — 비관리자 지시(col:tasks) 저장에서 서버가 줄·칸을 가르는 규칙(gw-data handleSave가 부른다 · 관리자는 거치지 않음).
//   근거 = 앱(index.html)이 비관리자에게 여는 지시 동작 전수 표(막는판A_문서초안_1120.md ④ · 판 A 4578f04 rowguard.js tasksGuard를 옮김) + 판 A 검토(11/20) 지적 넷:
//     ① 같은 id 둘째 줄이 지시 수행 계정에는 통과 → 누구든 버림  ② 지시자 칸(from_id·from·by)을 먼저 바꿔 승인 건너뜀 → 있던 줄의 지시자 칸은 서버 원본
//     ③ 200인데 조용히 되돌림 → 받지 않은 줄 id(kept)를 응답 task_kept로(앱이 다시 읽고 알림)  ④ 지움 직후 [영구삭제]면 살아 있는 줄이 되살아남 → 수행 계정이 뺀 살아 있는 줄은 지움 표시로 이월
//   막지 않는 것(지금 화면이 여는 동작 — 줄이는 것은 PM 결정 C321): 지시 수행 계정의 남의 지시 수정·지움 · 새 id 줄(자동 생성·반복 다음 회차 등 만드는 길이 여럿) · 연결 지시(계약 단계·기성)

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function sameRow(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) { const k = ka[i]; if (!hasOwn(b, k) || JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false; }
  return true;
}
function keepFields(o, b, allow) {
  const out = {};
  Object.keys(b).forEach(function (k) { if (allow(k)) out[k] = b[k]; else if (hasOwn(o, k)) out[k] = o[k]; });
  Object.keys(o).forEach(function (k) { if (!hasOwn(out, k) && !allow(k)) out[k] = o[k]; });
  return out;
}
// 앱 RANK_LIST와 같은 순서(상위 → 하위) — uismoke 'C240 A-2b'가 대조
const RANK_LIST = ['대표', '이사', '부장', '차장', '과장', '대리', '주임', '사원'];
// 앱 scopeIncludes와 같은 판정
function scopeIncludes(scope, m) {
  if (!scope || !scope.length) return true;
  if (!m) return false;
  for (let i = 0; i < scope.length; i++) {
    const tk = scope[i];
    if (typeof tk !== 'string') continue;
    if (tk === m.id) return true;
    if (tk.indexOf('dept:') === 0) { if (m.dept && m.dept === tk.slice(5)) return true; }
    else if (tk.indexOf('rank:') === 0) {
      const ti = RANK_LIST.indexOf(tk.slice(5)), mi = RANK_LIST.indexOf(m.rank);
      if (ti >= 0 && mi >= 0 && mi <= ti) return true;
    }
  }
  return false;
}
// 앱 taskForMe(담당 = 본인 · 전사 · 공개 범위에 본인 · 옛 이름 담당) — 서버 원본 줄로 판정
function taskForMe(me, t) {
  if (!t) return false;
  if (t.who_id === '__all__') return true;
  if (me.id) {
    if (t.who_id === me.id) return true;
    if (t.scope && t.scope.length && scopeIncludes(t.scope, me)) return true;
  }
  if (!t.who_id && me.name && String(t.who || '').trim() === me.name) return true;
  return false;
}
// 앱 canApproveTask의 비관리자 갈래(지시자 id · 옛 이름 지시자 by||from) — 서버 원본 줄로 판정
function taskIsFrom(me, t) {
  if (!t) return false;
  if (t.from_id && me.id && t.from_id === me.id) return true;
  return !!(me.name && me.name === (t.by || t.from));
}
// 상태 한 덩어리(앱 mergeTasks grp와 같은 칸 + 반려가 쓰는 doneif_off)
const TASK_GROUP = { status: 1, done_at: 1, done_by: 1, done_src: 1, approved_by: 1, approved_at: 1, doneif_off: 1 };
// 지시자 칸 — 있던 줄에서는 서버 원본(앱은 있던 지시의 지시자 칸을 바꾸는 길이 없음 — 판 A 검토 index.html 대입 전수)
const TASK_FROM_F = { from_id: 1, from: 1, by: 1 };
// 다른 탭이 연결 지시를 대신 고치는 길(전수 표 ㉡ — 막지 않음): 계약 단계 지시(proc_id) = 계약 보기 이상 · 기성 연결 지시(rec_id · 미수 키 rec:) = 기성 수행
function taskLinkedFree(o, perm) {
  if (o.proc_id && perm.con !== 'hide') return true;
  if ((o.rec_id || /^rec:[^:]+:/.test(String(o.auto_key || ''))) && perm.rec === 'do') return true;
  return false;
}
// 상태 바꿈 표(지시 수행이 아닌 계정 — 앱 toggleTaskDone·approveTask·rejectTask):
//   담당: 진행·보류 → 승인 대기 · 승인 대기 → 진행(요청 취소) · 완료 → 진행(완료 되돌리기) / 지시자: 승인 대기 → 완료(승인)·진행(반려)
function statusOk(mineT, fromT, st0, st1) {
  if (st0 === st1) return false;
  if (mineT && (((st0 === 'open' || st0 === 'hold') && st1 === 'review') || (st0 === 'review' && st1 === 'open') || (st0 === 'done' && st1 === 'open'))) return true;
  if (fromT && st0 === 'review' && (st1 === 'done' || st1 === 'open')) return true;
  return false;
}
// 저장(비관리자): perm = { tasks, con, rec } · today = 'YYYY-MM-DD'(지움 표시 이월의 updated)
//   지시 수행(do)이 아닌 계정(보기·숨김 — 지입차주·숨김 직원 등):
//     · 자기와 무관한 서버 줄(담당·전사·공개 범위·지시자 어디에도 본인 없음)을 바꾸면 그 줄 통째 서버 원본
//     · 자기와 관련된 줄은 위 상태 표의 바꿈만 상태 덩어리를 보낸 값으로 — 그 밖 칸(제목·담당·기한·공개 범위·지움 등 — 앱은 수행 권한에게만 엶)은 서버 원본 · updated는 보낸 값
//     · 보낸 목록에서 빠진 서버 줄은 서버 원본 이월(앱은 이 계정에 영구 삭제를 열지 않음 — 받은 사본 없는 빈 목록 저장이 지시를 지우던 길)
//   지시 수행(do) 계정: 지시자가 아니면서 완료(done)로 바꾼 줄은 상태 덩어리만 서버 원본(승인 단계 건너뜀) · 빠진 서버 줄 = 지운 줄(del 1 — 삭제 목록의 [영구삭제])은 빠지고, 살아 있는 줄은 지움 표시로 이월
//   공통: 같은 id 둘째 줄은 버림 · 있던 줄의 지시자 칸은 서버 원본 · 새 id 줄과 연결 지시는 손대지 않음
//   돌려줌: items · kept(보낸 값을 받지 않은 줄 id — 이월만 된 줄은 넣지 않음) · ev(수)
function tasksGuard(me, oldItems, items, perm, today) {
  const guarded = perm.tasks !== 'do';
  const oldBy = Object.create(null);
  (oldItems || []).forEach(function (o) { if (o && typeof o === 'object' && o.id != null && o.id !== '' && !hasOwn(oldBy, String(o.id))) oldBy[String(o.id)] = o; });
  const seen = Object.create(null), seenNew = Object.create(null), out = [], kept = [], ev = { revert: 0, field: 0, dup: 0, carried: 0, done: 0, softdel: 0, from: 0 };
  const keep = function (k) { const s = String(k).slice(0, 60); if (kept.indexOf(s) < 0) kept.push(s); };
  (items || []).forEach(function (t) {
    const k = (t && typeof t === 'object' && t.id != null && t.id !== '') ? String(t.id) : null;
    const o = k !== null && hasOwn(oldBy, k) ? oldBy[k] : null;
    if (!o) {
      if (k !== null) { if (hasOwn(seenNew, k)) { ev.dup++; keep(k); return; } seenNew[k] = 1; }
      out.push(t); return;
    }
    if (hasOwn(seen, k)) { ev.dup++; keep(k); return; }
    seen[k] = 1;
    if (!t || typeof t !== 'object') { ev.revert++; keep(k); out.push(o); return; }
    if (sameRow(o, t) || taskLinkedFree(o, perm)) { out.push(t); return; }
    const mineT = taskForMe(me, o), fromT = taskIsFrom(me, o);
    const st0 = o.status || 'open', st1 = t.status || 'open';
    if (guarded) {
      // 무관한 줄 · 지운 줄(휴지통 — 앱은 이 계정에 지운 줄 동작을 열지 않음: 좁은 확인 — 낡은 화면 [완료]가 지운 줄을 승인 대기로 만들던 것) = 통째 서버 원본
      if ((!mineT && !fromT) || o.del === 1) { ev.revert++; keep(k); out.push(o); return; }
      const okT = statusOk(mineT, fromT, st0, st1);
      const r = keepFields(o, t, function (f) { return f === 'updated' || (okT && hasOwn(TASK_GROUP, f)); });
      if (!sameRow(r, t)) { ev.field++; keep(k); }
      out.push(r); return;
    }
    let r = keepFields(o, t, function (f) { return !hasOwn(TASK_FROM_F, f); });
    if (!sameRow(r, t)) ev.from++;
    if (st1 === 'done' && st0 !== 'done' && !fromT) { ev.done++; r = keepFields(o, r, function (f) { return !hasOwn(TASK_GROUP, f); }); }
    if (!sameRow(r, t)) keep(k);
    out.push(r);
  });
  Object.keys(oldBy).forEach(function (k) {
    if (hasOwn(seen, k)) return;
    const o = oldBy[k];
    if (guarded) { ev.carried++; out.push(o); return; }
    if (o.del === 1) return;   // 지운 줄의 [영구삭제] — 종전대로 빠짐
    ev.softdel++; keep(k); out.push(Object.assign({}, o, { del: 1, updated: today || o.updated }));
  });
  return { items: out, kept: kept, ev: ev };
}

module.exports = { tasksGuard, taskForMe, taskIsFrom, scopeIncludes, statusOk, RANK_LIST, TASK_GROUP, TASK_FROM_F, sameRow };
