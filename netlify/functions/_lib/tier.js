'use strict';

// 관리자 등급(v321, PM 9/6 ㄱ) — 회원 tier: 'boss'(대표) | 'pm'(PM) | 'admin'(관리자). 관리자(admin)가 아닌 회원·삭제(del)·퇴사(leave_date 경과) 회원은 등급 없음('').
// 결재 게이트용 판정은 **명시 tier만** 신뢰한다(9/6 검증 S1 — 관리자가 자기 role '대표'·이름 변경으로 boss·pm을 취득하던 파생 경로 폐쇄).
//   명시 tier 없는 관리자 = 'admin'(최하 등급 — 결재 전결 권한 없음. admin 플래그는 개발자만 바꾸므로 상승 경로가 아니다).
// 부트스트랩 예외: 재직 관리자 중 명시 tier가 **한 명도 없을 때만**(배포 직후·등급 지정 전) 종전 파생 규칙으로 임시 판정 —
//   role '대표' 또는 이름 나종운 → boss / dev(개발자) 또는 이름 나경일 → pm / 그 외 관리자 → admin. 명시 tier가 하나라도 생기면 파생 중단(그 뒤로는 명시값만).
//   부트스트랩 여부는 회원 전수를 본 쪽(push.tierCtx / gw-auth 회원 저장 / 앱 tierOfMember)이 isBootstrap으로 판정해 tierOf(m, bootstrap)에 넘긴다.
//   배포 직후 절차: 회원 3인 명시 등급 지정(대표 boss·나경일 pm·나수진 admin — 코디네이터 블롭 작업, FEATURES §4.10) — 지정 전엔 파생으로 돌고, 지정 뒤엔 명시값만.
// 클라 index.html tierOfMember와 같은 규칙 — 바꾸면 동시에(uismoke가 등급 키·파생 이름·부트스트랩 게이트를 대조).
// 서버 게이트: ① 전결(self_decide·PM 큐 결재·② 1단계)=pm만 / ③ 대표 전결·전결 총정리 확인=boss만(boss 0명이면 폴백 없이 잠김 — S2) / admin=모듈 do·문서함 관리·회원 관리 등 기존 관리자 기능만.
const TIERS = { boss: 1, pm: 1, admin: 1 };
const TIER_LABEL = { boss: '대표', pm: 'PM', admin: '관리자' };
// 예약 이름(부트스트랩 파생의 근거) — 회원 저장에서 이 이름으로의 변경·role '대표' 지정은 tier boss 또는 개발자만(gw-auth NAME_RESERVED·ROLE_BOSS_ONLY)
const RESERVED_NAMES = { '나종운': 'boss', '나경일': 'pm' };
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function validTier(t) { return typeof t === 'string' && hasOwn(TIERS, t); }
// 퇴사자(leave_date < 오늘 KST) — gw-auth·gw-data retired와 동일식(두 파일이 이 함수를 쓴다). 등급·pmIds·bossIds·adminIds 전부 재직자만
function retired(m) {
  const ld = m && m.leave_date;
  if (!ld) return false;
  return String(ld) < new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}
function active(m) { return !!(m && m.del !== 1 && !retired(m)); }
// 부트스트랩 = 재직 관리자 중 명시 tier가 하나도 없음(퇴사·삭제 회원의 명시 tier는 세지 않는다)
function isBootstrap(members) {
  return !(members || []).some(function (x) { return active(x) && !!x.admin && validTier(x.tier); });
}
function tierOf(m, bootstrap) {
  if (!m || !m.admin || m.del === 1 || retired(m)) return '';
  if (validTier(m.tier)) return m.tier;
  if (bootstrap !== true) return 'admin';   // 명시 없음 = 최하 등급(role·이름·dev 불신)
  if (String(m.role || '') === '대표' || String(m.name || '') === '나종운') return 'boss';
  if (m.dev || String(m.name || '') === '나경일') return 'pm';
  return 'admin';
}
// 회원 전수 → 판정 컨텍스트 {members(재직), bootstrap, tierOf(m), isBoss(m), isPm(m), bossIds, pmIds, adminIds} — push.tierCtx·gw-auth 회원 저장·servertest mock 공용(스캔 1회)
function ctxOf(members) {
  const ms = (members || []).filter(active);
  const bootstrap = isBootstrap(ms);
  const ctx = { members: ms, bootstrap: bootstrap, bossIds: [], pmIds: [], adminIds: [] };
  ctx.tierOf = function (m) { return tierOf(m, bootstrap); };
  ctx.isBoss = function (m) { return ctx.tierOf(m) === 'boss'; };
  ctx.isPm = function (m) { return ctx.tierOf(m) === 'pm'; };
  ms.forEach(function (m) {
    const t = tierOf(m, bootstrap);
    if (!t) return;
    ctx.adminIds.push(m.id);
    if (t === 'boss') ctx.bossIds.push(m.id); else if (t === 'pm') ctx.pmIds.push(m.id);
  });
  return ctx;
}

module.exports = { TIERS, TIER_LABEL, RESERVED_NAMES, validTier, retired, active, isBootstrap, tierOf, ctxOf };
