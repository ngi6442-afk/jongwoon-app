'use strict';

// 관리자 등급(v321, PM 9/6 ㄱ) — 회원 tier: 'boss'(대표) | 'pm'(PM) | 'admin'(관리자). 관리자(admin)가 아닌 회원은 등급 없음('').
// 명시 tier가 없으면 파생: role '대표' 또는 이름 나종운 → boss / dev(개발자) 또는 이름 나경일 → pm / 그 외 관리자 → admin.
// 마이그레이션 없이 동작(기존 회원 데이터 그대로). 클라 index.html tierOfMember와 같은 규칙 — 바꾸면 동시에(uismoke가 등급 키·파생 이름을 대조).
// 서버 게이트: ① 전결(self_decide·PM 큐 결재·② 1단계)=pm만 / ③ 대표 전결·전결 총정리 확인=boss만 / admin=모듈 do·문서함 관리·회원 관리 등 기존 관리자 기능만(결재 전결 없음).
// 종전 push.isBoss(role 대표 또는 이름 나종운, admin 한정) 규칙은 파생값으로 포함되므로 v308~v315 결재 라우팅과 호환.
const TIERS = { boss: 1, pm: 1, admin: 1 };
const TIER_LABEL = { boss: '대표', pm: 'PM', admin: '관리자' };
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function validTier(t) { return typeof t === 'string' && hasOwn(TIERS, t); }
function tierOf(m) {
  if (!m || !m.admin || m.del === 1) return '';
  if (validTier(m.tier)) return m.tier;
  if (String(m.role || '') === '대표' || String(m.name || '') === '나종운') return 'boss';
  if (m.dev || String(m.name || '') === '나경일') return 'pm';
  return 'admin';
}
function isBoss(m) { return tierOf(m) === 'boss'; }
function isPm(m) { return tierOf(m) === 'pm'; }

module.exports = { TIERS, TIER_LABEL, tierOf, isBoss, isPm, validTier };
