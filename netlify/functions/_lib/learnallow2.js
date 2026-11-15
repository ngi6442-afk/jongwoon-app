'use strict';
// 계약 학습 허용 칸 추천 2차(P1 판16 · 원장 T396) — 한글(hwpx) 토큰 양식 + 준공 정산합의서(settle_doc xlsx).
// 1차(xlsx 칸 — 카드_학습허용사전R2, 11/8 무응답 = 추천값 저장)와 같은 틀: 허용 사전 settings:learn.contract.allow[양식] = [칸…]에 들어간 칸만 모델이 값을 보고,
// 근거 2건이 쌓인 칸은 다음 생성 때 '빈 칸에만' 미리 채워진다. 이 파일은 추천값(어느 칸을 넣을지)과 주입 잠금(넣으면 안 되는 칸)만 정한다 — 저장은 기존 learn_settings_set 길.
// 추천값은 양식 칸 목록에서 규칙으로 뽑는다(운영 저장소를 읽지 않음): 돈(금액·요율·점수)·날짜·건마다 다른 값(계약명·수신처·번호…)·개인정보·연락처·계좌 칸은 뺀다.
// 칸 목록은 index.html의 토큰 만드는 곳(xgConTok·xgAdvTok·xgQuoteTok·적격심사 qTokens)과 같아야 한다 — servertest 판16이 두 곳을 대조한다(앱에서 칸을 더하면 여기도).
const VER = '20261115';
const TOKENS = {
  qual_packet: ['공고명', '수요기관', '수신처', '공고번호', '입찰일', '제출기한', '공사기간', '입찰금액', '예정가격', '제출일', '제출일자', '점수계', '점수소계', '점수실적', '점수경영', '점수신인도', '점수입찰가', '점수안전'],
  contract_pledge: ['계약명', '보증기간', '업체명', '연락처', '사업자번호', '금액한글', '금액숫자', '보증금률', '보증금액', '작성일', '수신처'],
  seal_reg: ['작성일', '업체명', '주소'],
  bond_waiver: ['계약명', '계약기간', '작성일', '업체명', '주소', '수신처'],
  quote_env: ['견적번호', '견적일자', '수신처', '용역명', '금액한글', '금액숫자', '부가세구분', '품명', '성상', '구분', '단위', '수량', '단가', '금액'],
  quote_con: ['견적번호', '견적일자', '수신처', '용역명', '금액한글', '금액숫자', '부가세구분', '품명', '성상', '구분', '단위', '수량', '단가', '금액'],
  adv_pay: ['발주기관', '수신', '참조', '문서번호', '시행일자', '작성일', '담당자', '이메일', '전화', '팩스', '계약건명', '상호', '주소', '대표자', '계약기간', '계약일', '착공일', '준공예정일',
    '계약금액한글', '계약금액', '선금신청액한글', '선금신청액', '잔액한글', '잔액', '직접노무비한글', '직접노무비', '차액한글', '차액', '적용요율', '노무비', '재료비', '사급자재', '경비', '소계', '부가세',
    '은행명', '예금종류', '계좌번호'],
};
// 준공 정산합의서 — 앱 채움 맵(index.html XST_ITEMS의 F열 실지급액 + L26 조정 이윤율)이 전부 settleCalc 돈 계산 칸이라 추천 0·주입 금지.
const SETTLE_SHEET = '원가계산서 (정산)';
const SETTLE_CELLS = ['F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F22', 'L26'].map(function (r) { return SETTLE_SHEET + '!' + r; });
const NO_INJECT = { settle_doc: 1 };   // 학습 주입 대상이 아닌 양식(돈 계산 결과를 덮어쓸 수 있는 칸뿐)
// 칸 이름 → 뺄 까닭('' = 추천). 차례: 개인정보·연락처 → 돈 → 날짜 → 건마다 다른 값
const RE_PII = /주민|생년|성명|이름|대표자|담당자|주소|전화|연락처|팩스|이메일|메일|계좌|은행|예금|사업자/;
const RE_MONEY = /금액|액$|액한글|가격|단가|수량|요율|률$|비$|비한글$|비용|소계|부가세$|잔액|차액|점수|노무비|재료비|경비|자재/;
const RE_DATE = /일$|일자|일시|기간|기한|날짜/;
const RE_CASE = /계약명|공고명|용역명|건명|공사명|품명|기관|수신|참조|번호|현장/;
function why(name) {
  const s = String(name || '');
  if (RE_PII.test(s)) return 'pii';
  if (RE_MONEY.test(s)) return 'money';
  if (RE_DATE.test(s)) return 'date';
  if (RE_CASE.test(s)) return 'case';
  return '';
}
// 추천값 — {양식: [칸…]} (추천 칸이 없는 양식은 넣지 않는다: 허용 사전의 빈 배열은 '허용 안 함'과 같고 저장만 늘린다)
function rec() {
  const out = {};
  Object.keys(TOKENS).forEach(function (t) { const a = TOKENS[t].filter(function (n) { return !why(n); }); if (a.length) out[t] = a; });
  return out;
}
// 카드에 보일 요약 — 양식별 추천 칸·뺀 칸 수(까닭별). 값은 없다(칸 이름은 양식의 이름표).
function card() {
  const tpls = {}, dropped = { money: 0, date: 0, case: 0, pii: 0 };
  Object.keys(TOKENS).forEach(function (t) {
    const d = { money: 0, date: 0, case: 0, pii: 0 }, r = [];
    TOKENS[t].forEach(function (n) { const w = why(n); if (w) { d[w]++; dropped[w]++; } else r.push(n); });
    tpls[t] = { rec: r, n: TOKENS[t].length, drop: d };
  });
  tpls.settle_doc = { rec: [], n: SETTLE_CELLS.length, drop: { money: SETTLE_CELLS.length, date: 0, case: 0, pii: 0 }, no_inject: true };
  dropped.money += SETTLE_CELLS.length;
  return { ver: VER, tpls: tpls, dropped: dropped };
}
// 주입 잠금 — learn_defaults_get이 내보내기 전에 거른다. 정산합의서 = 전부 뺌 · 한글 양식 = 추천 규칙에 걸리는 칸(돈·날짜·건마다 다른 값·개인정보)은 허용 사전에 들어 있어도 뺌 · 그 밖 양식(1차 xlsx) = 그대로.
function injectFilter(tpl, defaults) {
  const d = (defaults && typeof defaults === 'object') ? defaults : {};
  if (NO_INJECT[tpl]) return {};
  if (!Object.prototype.hasOwnProperty.call(TOKENS, tpl)) return d;
  const out = {};
  Object.keys(d).forEach(function (k) { if (TOKENS[tpl].indexOf(k) >= 0 && !why(k)) out[k] = d[k]; });
  return out;
}
module.exports = { VER, TOKENS, SETTLE_CELLS, NO_INJECT, why, rec, card, injectFilter };
