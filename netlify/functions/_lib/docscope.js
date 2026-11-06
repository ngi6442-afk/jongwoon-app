'use strict';
// 문서함 분류·공개범위 판정 한 곳(v424) — gw-data(문서함 화면·첨부)와 물어보기(_lib/ask.js)가 같은 함수를 쓴다.
// PM 11/6 "두개 한번에": 물어보기 문서 도구가 공개범위를 거치지 않아 비공개·01 법인 문서의 번호·제목이 답에 나올 수 있던 구멍을 막으려고 옮겼다. 규칙 자체는 그대로다.
const { blobGet } = require('./blobs');

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

module.exports = { DOC_MAJOR_LABEL, DOC_MINOR_LABEL, DOC_MAJOR_SET, DOC_MINOR_SET, DOC_CAT_SET, DOC_CAT_LABEL, docCatOf, docMajorOf, docCanSee01, DOC_SETTINGS_KEY, DOC_SCOPE_CATS, DOC_SCOPE_VALS, DOC_SETTINGS_DEFAULTS, docSettings, docScopeNorm, docStatusOf, docScopeMatch, docScopeOf, docVisible };
