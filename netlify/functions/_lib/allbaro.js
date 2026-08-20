'use strict';

// 올바로(www.allbaro.or.kr) '인계서 진행상황' 수집 → 노선별 회수·수량 집계 코어.
// 로컬 파이썬 원본이 유일한 의미론 기준(2026-08-12 이식):
//   * 07_운반일지_자동화/allbaro_parse.py — (배출자, 처리자, 폐기물종류)별 건수 집계
//   * 07_운반일지_자동화/일지생성.py      — norm() / match_route() 노선 매칭 규칙
//   * 노선사전.json(routes 65) · 별칭사전.json(9) 을 아래에 그대로 임베드
//
// 2단계(CONTRACT_2단계.md A-1~A-5, 2026-08-12): 품목 별칭·차량 종류·수량·학습 사전 추가.
//   핵심은 A-3 — (상차지,하차지) 후보가 여럿인데 품목·차량으로도 못 좁히면
//   예전처럼 '먼저 나온 줄'에 조용히 넣지 않고 미매칭(AMBIGUOUS)으로 드러낸다.
// 세션·네트워크 계층은 검증된 _lib/icis.js 의 Session 구조를 그대로 따른다
// (쿠키 Map, 수동 리다이렉트, 4xx/5xx는 throw, POST 307/308은 중단, 빈 값 set-cookie는 삭제).
//
// 자격증명은 인자 creds={id,pw}로만 받는다(호출부가 GW_ALLBARO_ID/GW_ALLBARO_PW에서 읽어 전달).
// 아이디·비밀번호는 로그·반환값·예외 메시지 어디에도 넣지 않는다 — 요청 본문을 통째로 찍는 로그 금지.
// 조회 전용이다. 올바로에 쓰기(등록·수정·삭제) 요청을 보내는 함수는 이 파일에 없다.

const BASE = 'https://www.allbaro.or.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const LOGIN_PATH = '/main.login.do';
const SEARCH_PAGE = '/man/man100.searchManfProcessByEntn.do';           // 조회 화면(세션 맥락 + Referer)
const SEARCH_XML = '/man/man100.XML.searchManfProcessByEntn.do?exec';   // 실제 조회(XML 응답)

// 사업장 기본값 — 로그인 후 조회 화면의 hidden 값으로 덮어쓴다(사업장이 바뀌어도 따라간다).
const ENTN = '200520958';
const ENTN_NAME = '(유)종운환경';

// 한 번에 받아올 행 수(브라우저 실측값 그대로). TOTAL과 파싱 행 수가 다르면 searchManifests가 중단한다.
const ONE_PAGE_ROWS = '500';

// ---------- 노선사전(노선사전.json routes 65개 임베드) ----------
// 회수 기입: L측=E열(count_col 5), R측=K열(count_col 11).
const ROUTES = [
  { side: "L", row: 5, from: "거성산업", to: "네이처", item: "폐합성수지", count_col: 5 },
  { side: "L", row: 6, from: "동국제강", to: "베페사", item: "지정분진", count_col: 5 },
  { side: "L", row: 7, from: "동국제강", to: "황조", item: "지정분진", count_col: 5 },
  { side: "L", row: 8, from: "동일산업", to: "스틸싸이클㈜", item: "EAFD", count_col: 5 },
  { side: "L", row: 9, from: "동일산업", to: "건영환경", item: "폐주물사", count_col: 5 },
  { side: "L", row: 10, from: "동일산업", to: "대화산업", item: "분진", count_col: 5 },
  // L11·L12는 양식 원본의 하차지·품목 칸이 서로 뒤바뀌어 있던 것을 교정한 값(2026-08-19 PM 지시).
  // 양식(운반일지_양식_원본.xlsx)·로컬 노선사전.json도 같은 날 함께 교정 — L15~17 정상 패턴 기준.
  { side: "L", row: 11, from: "동일산업", to: "네이처", item: "폐유고상", count_col: 5 },
  { side: "L", row: 12, from: "동일산업", to: "네이처", item: "폐페인트", count_col: 5 },
  { side: "L", row: 13, from: "동일산업", to: "SP성보", item: "폐수오니", count_col: 5 },
  { side: "L", row: 14, from: "동일산업", to: "SP성보", item: "공정오니", count_col: 5 },
  { side: "L", row: 15, from: "동일산업(봉강)", to: "네이처", item: "폐페인트", count_col: 5 },
  { side: "L", row: 16, from: "동일산업(봉강)", to: "네이처", item: "폐합성수지", count_col: 5 },
  { side: "L", row: 17, from: "동일산업(봉강)", to: "네이처", item: "폐유고상", count_col: 5 },
  { side: "L", row: 18, from: "동일산업(봉강)", to: "포항그린", item: "폐수처리오니", count_col: 5 },
  { side: "L", row: 19, from: "동연스틸", to: "경일이앤티", item: "폐수처리오니", count_col: 5 },
  { side: "L", row: 20, from: "동연스틸 ㈜명례공장", to: "네이처(경주)", item: "하수처리오니", count_col: 5 },
  { side: "L", row: 21, from: "대성메탈", to: "거성산업㈜", item: "분진", count_col: 5 },
  { side: "L", row: 22, from: "대화산업", to: "네이처", item: "폐합성수지", count_col: 5 },
  { side: "L", row: 23, from: "베페사", to: "동일산업", item: "환원철", count_col: 5 },
  { side: "L", row: 24, from: "베페사(포항)", to: "베페사", item: "폐수오니", count_col: 5 },
  { side: "L", row: 25, from: "심팩", to: "베페사", item: "지정분진", count_col: 5 },
  { side: "L", row: 26, from: "스틸싸이클㈜", to: "포항그린", item: "광재", count_col: 5 },
  { side: "L", row: 27, from: "스틸싸이클㈜", to: "씨엔텍경주", item: "광재", count_col: 5 },
  { side: "L", row: 28, from: "스틸싸이클㈜", to: "(유)종운환경", item: "광재", count_col: 5 },
  { side: "L", row: 29, from: "스틸싸이클㈜", to: "영내작업", item: "영내작업", count_col: 5 },
  { side: "L", row: 30, from: "스틸싸이클㈜", to: "네이처이앤티㈜", item: "폐유성페인트", count_col: 5 },
  { side: "L", row: 31, from: "심팩리스텍비즈", to: "스틸싸이클", item: "분진", count_col: 5 },
  { side: "L", row: 32, from: "심팩포항1공장", to: "베페사", item: "분진", count_col: 5 },
  { side: "L", row: 33, from: "욱성화학", to: "포항그린", item: "비산재", count_col: 5 },
  { side: "L", row: 34, from: "케이에스피", to: "포항그린", item: "폐유리섬유", count_col: 5 },
  { side: "L", row: 35, from: "태광산업", to: "태흥산업", item: "석고", count_col: 5 },
  { side: "L", row: 36, from: "에코프로 씨엔지", to: "네이처(경주)", item: "폐광물류", count_col: 5 },
  { side: "L", row: 37, from: "㈜SMC", to: "렘코㈜ 재활용1공장", item: "광재", count_col: 5 },
  { side: "R", row: 5, from: "태웅제강", to: "스틸싸이클", item: "EAFD (BCT차량)", count_col: 11 },
  { side: "R", row: 6, from: "태웅제강", to: "스틸싸이클", item: "EAFD(덤프)", count_col: 11 },
  { side: "R", row: 7, from: "풍전비철", to: "스틸싸이클", item: "분진", count_col: 11 },
  { side: "R", row: 8, from: "(주)포스코", to: "구내운송", item: "EP 더스트 (레스코)", count_col: 11 },
  { side: "R", row: 9, from: "(주)포스코", to: "구내운송", item: "EP 더스트 (피앤알)", count_col: 11 },
  { side: "R", row: 10, from: "(주)포스코", to: "구내운송", item: "CIP", count_col: 11 },
  { side: "R", row: 11, from: "(주)포스코", to: "구내운송", item: "슬러지보관장", count_col: 11 },
  { side: "R", row: 12, from: "(주)포스코퓨처엠", to: "동양산업", item: "공정오니", count_col: 11 },
  { side: "R", row: 13, from: "(주)포스코퓨처엠", to: "동양산업", item: "폐석회", count_col: 11 },
  { side: "R", row: 14, from: "(주)포스코퓨처엠", to: "대화산업", item: "분진", count_col: 11 },
  { side: "R", row: 15, from: "㈜포스코퓨처엠 인조흑연음극재공장", to: "네이처(경주)", item: "분진", count_col: 11 },
  { side: "R", row: 16, from: "㈜포스코퓨처엠 인조흑연음극재공장", to: "네이처", item: "폐유고상", count_col: 11 },
  { side: "R", row: 17, from: "㈜포스코퓨처엠 포항양극재공장", to: "포스코HY 클린메탈㈜", item: "유해화학물질", count_col: 11 },
  { side: "R", row: 18, from: "(주)포스코퓨처엠 포항화학사업부", to: "HS효성첨단소재㈜울산공장", item: "공정오니", count_col: 11 },
  { side: "R", row: 19, from: "(주)포스코퓨처엠 포항화학사업부", to: "코스모화학", item: "공정오니", count_col: 11 },
  { side: "R", row: 20, from: "㈜한국특강", to: "스틸싸이클㈜", item: "EAFD (BCT차량)", count_col: 11 },
  { side: "R", row: 21, from: "㈜한국특강", to: "베페사", item: "EAFD (BCT차량)", count_col: 11 },
  { side: "R", row: 22, from: "한일철강제2공장", to: "거성산업", item: "분진", count_col: 11 },
  { side: "R", row: 23, from: "항성메탈", to: "베페사", item: "지정분진", count_col: 11 },
  { side: "R", row: 24, from: "현대종합금속", to: "거성산업", item: "공정오니", count_col: 11 },
  { side: "R", row: 25, from: "현대종합금속", to: "대화산업", item: "공정오니", count_col: 11 },
  { side: "R", row: 26, from: "현대종합금속", to: "주식회사 시온", item: "폐수처리오니", count_col: 11 },
  { side: "R", row: 27, from: "현대종합금속2공장", to: "거성산업", item: "폐수처리오니", count_col: 11 },
  { side: "R", row: 28, from: "현대종합금속2공장", to: "거성산업", item: "공정오니", count_col: 11 },
  { side: "R", row: 29, from: "현대종합금속2공장", to: "대화산업", item: "공정오니", count_col: 11 },
  { side: "R", row: 30, from: "현대종합금속2공장", to: "대화산업", item: "폐수처리오니", count_col: 11 },
  { side: "R", row: 31, from: "현대제철 포항1공장", to: "황조", item: "분진", count_col: 11 },
  { side: "R", row: 32, from: "YK스틸", to: "스틸싸이클㈜", item: "EAFD", count_col: 11 },
  { side: "R", row: 33, from: "TCC스틸", to: "성진kp", item: "폐수오니", count_col: 11 },
  { side: "R", row: 34, from: "TCC스틸", to: "포항그린", item: "폐수오니", count_col: 11 },
  { side: "R", row: 35, from: "안동댐 상류하천 양안 광물찌꺼기 처리사업", to: "포항그린", item: "광재", count_col: 11 },
];

// ---------- 별칭사전(별칭사전.json 9개 임베드, _설명 키 제외) ----------
// 키=올바로 표기 일부, 값=회사 양식 표기.
const ALIAS = {
  '티씨씨스틸': 'TCC스틸',
  '성진케이피인터내셔널': '성진kp',
  '에이치에스효성첨단소재': 'HS효성첨단소재',
  '씨엔텍코리아': '씨엔텍경주',
  '피엔알': '피앤알',
  '와이케이스틸': 'YK스틸',
  '베페사징크코리아': '베페사',
  '동국제강': '동국제강',
  '코스모화학': '코스모화학',
};

// 별칭 치환 순서는 JSON 기재 순서(파이썬 dict 순회와 동일) — 문자열 키라 삽입 순서가 보존된다.
const ALIAS_PAIRS = Object.keys(ALIAS).map((k) => [k.replace(/ /g, ''), ALIAS[k].replace(/ /g, '')]);
// 법인격 표기 — 올바로는 '에이치에스효성첨단소재(주)울산공장', 양식은 'HS효성첨단소재㈜울산공장' 처럼
// 같은 회사를 다르게 적는다. 아래 표기를 모두 지우고 비교한다(일지생성.py norm과 동일 목록·순서).
const CORP_SUFFIX = ['㈜', '(주)', '주식회사', '(유)', '유한회사', '(合)'];

// ---------- 응답 XML의 TD 인덱스(0-based, 43열 실측 2026-08-12) ----------
// 주의: 계약서는 운반자 인수량을 20으로 적었으나, HAR 27행 전수 확인 결과
//   TD[20] = 운반자 운반일자(8자리 YYYYMMDD, 27/27),
//   TD[21] = 운반자 인수량(27/27 수량, 배출자 위탁량 TD[12]와 전부 일치)
// 이라 tranQty는 21을 쓴다. 나머지 인덱스는 계약서와 동일하다(집계에는 emis/trtm/wasteName/date만 쓴다).
const TD = {
  manf: 3,          // 인계서번호
  wasteCode: 4,     // 폐기물코드
  wasteName: 5,     // 폐기물종류
  state: 6,         // 처리상태
  emis: 8,          // 배출자(상차지)
  date: 9,          // 배출자 인계일자 YYYYMMDD — 조회·집계 기준일
  qty: 12,          // 배출자 위탁량
  qtyUnit: 13,      // 배출자 위탁량 단위코드
  emisVehicle: 14,  // 배출자 배출차량
  tranFirm: 17,     // 운반자 업체명
  tranQty: 21,      // 운반자 인수량
  tranUnit: 22,     // 운반자 인수량 단위코드
  tranVehicle: 23,  // 운반자 운반차량
  trtm: 25,         // 처리자(하차지)
  trtmQty: 28,      // 처리자 인수량
  writer: 41,       // 작성자명
  // 시각 필드(2026-08-13) — EP더스트 조업일 규칙(당일 06시~익일 06시, PM 지시)용.
  // 실측 형식 'YYYYMMDD HH:MM:SS'. 어느 시각이 실제 조업을 반영하는지는 inspect로 확인.
  reservedAt: 10,   // 배출자 예약등록일시
  confirmedAt: 11,  // 배출자 확정등록일시
  tranWorkAt: 19,   // 운반자 작업일시
  trtmWorkAt: 27,   // 처리자 인수작업일시
};
const TD_MIN = 43;  // 실측 열 수. 이보다 짧은 TR은 데이터 행이 아니다.

// 수량 단위 → 톤 환산 계수(A-4). 실측(8/10 27행)에서 단위 칸은 문자열이 아니라 코드였다:
//   '01' = Ton (한국특강 26.26), '02' = kg (동일산업 10620) — 27행 모두 TD13=TD22=TD29.
// 표기가 바뀌어 문자열('kg'/'Ton')로 와도 받도록 둘 다 넣는다.
// 여기에 없는 단위는 절대 0으로 만들지 않고 qty_unknown으로 센다(조용한 축소 금지).
const UNIT_FACTOR = {
  '01': 1, TON: 1, T: 1, '톤': 1,
  '02': 0.001, KG: 0.001, '킬로그램': 0.001, KILOGRAM: 0.001,
};

// ---------- 공용 유틸 ----------

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 'YYYY-MM-DD' 정규식 + 달력 왕복 검증. 2026-02-30 같은 값을 조용히 이월시키지 않는다.
function validDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso).trim());
  if (!m) return false;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// 'YYYY-MM-DD' -> 'YYYY/MM/DD'(올바로 조회 폼 형식). 형식 오류면 null.
function toSlash(iso) {
  if (!validDay(iso)) return null;
  return String(iso).trim().replace(/-/g, '/');
}

// KST 기준 오늘(YYYY-MM-DD). 크론(UTC)에서 '오늘'을 계산할 때 쓴다.
function kstTodayISO() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 파이썬 " ".join(str(v).split()) 대응 — 앞뒤 공백 제거 + 내부 연속 공백 1칸으로.
function cleanText(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
}

// XML 엔티티 해제(픽스처엔 없지만 방어적으로). CDATA가 아닌 TD 값에만 적용한다.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isNaN(code)) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, body) ? XML_ENTITIES[body] : m;
  });
}

// HTML hidden input 값 하나 추출(로그인 성공 판정·사업장 확인용).
function hiddenValue(html, name) {
  const m = new RegExp('<input\\b[^>]*\\bname=["\']' + escRe(name) + '["\'][^>]*>', 'i').exec(String(html));
  if (!m) return null;
  const v = /\bvalue\s*=\s*("([^"]*)"|'([^']*)')/.exec(m[0]);
  if (!v) return null;
  return (v[2] !== undefined ? v[2] : v[3]).trim();
}

// ---------- 정규화·매칭(일지생성.py 이식, 픽스처 테스트 대상) ----------

// 공백 제거 + 별칭 치환(올바로 정식명 → 양식 약칭) + 법인격 표기 제거.
function normName(s) {
  let t = String(s == null ? '' : s).replace(/\s+/g, '');
  for (const [k, v] of ALIAS_PAIRS) {
    if (k && t.indexOf(k) >= 0) t = t.split(k).join(v);
  }
  for (const x of CORP_SUFFIX) t = t.split(x).join('');
  return t;
}

// 양방향 부분 문자열 포함(일지생성.py hit).
function hit(a, b) {
  return !!a && !!b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
}

// ---------- A-1. 품목 별칭·정규화 ----------

// 올바로 법정 분류명 ↔ 양식 현장 약칭. normName과 같은 방식(부분 문자열 치환)이되 품목에만 쓴다.
// 양쪽(올바로 품목·노선표 품목)에 똑같이 적용하므로 표기 방향은 상관없다.
// 추측 금지 — 8/10 실측 27건과 계약서 A-3 테스트 명세에서 확인된 것만 넣는다:
//   '분진(고상)' ↔ 'EAFD' 는 실측 3건(동일산업→스틸싸이클 L8 · 한국특강→베페사 R21 ·
//   YK스틸→스틸싸이클 R32)과 계약서의 태웅제강 R5/R6 단언이 같은 대응을 가리킨다.
const ITEM_ALIAS = {
  '그 밖의 공정오니(무기성)': '공정오니',
  '그 밖의 광재류': '광재',
  '그 밖의 분진': '분진',
  '제철공정분진': '분진',
  // 양식에 '폐수오니'와 '폐수처리오니' 두 표기가 다 있다 — 한쪽으로 모아 서로 매칭되게 한다.
  '폐수처리오니': '폐수오니',
  EAFD: '분진',
};
const ITEM_ALIAS_PAIRS = Object.keys(ITEM_ALIAS)
  .map((k) => [k.replace(/\s+/g, '').toUpperCase(), ITEM_ALIAS[k].replace(/\s+/g, '').toUpperCase()]);

// 품목 비교용 정규화. 원본 문자열(counts[].item)은 절대 바꾸지 않는다 — 비교값만 만든다.
// 공백 제거 → 대문자 → 별칭 치환 → 괄호 묶음 통째 제거('(고상)'·'(액상)'·'(BCT차량)'·'(덤프)'…).
function normItem(s) {
  let t = String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
  for (const [k, v] of ITEM_ALIAS_PAIRS) {
    if (k && t.indexOf(k) >= 0) t = t.split(k).join(v);
  }
  for (let i = 0; i < 3 && /\([^()]*\)/.test(t); i++) t = t.replace(/\([^()]*\)/g, '');
  return t.replace(/[()[\]]/g, '');
}

// 품목 양방향 부분 문자열 비교(별칭·상태 접미사 흡수). 한쪽이라도 비면 false.
function itemHit(a, b) { return hit(normItem(a), normItem(b)); }

// ---------- A-2. 차량 종류 판정 ----------

// 양식 품목칸에 병기된 차량 표기 → 허용되는 차량현황 type.
// 지금 걸리는 줄은 4개(R5·R6·R20·R21)뿐이지만 표기를 문자열에서 뽑는 일반 규칙으로 둔다.
// BCT차량 = 트랙터(전용 BOX/벌크 트레일러를 끈다) — 계약서 실측.
const VEHICLE_TAGS = [
  ['BCT', ['트랙터', 'BOX', '벌크']],
  ['벌크', ['트랙터', 'BOX', '벌크']],
  ['트랙터', ['트랙터', 'BOX', '벌크']],
  ['덤프', ['덤프']],
  ['암롤', ['암롤']],
  ['카고', ['카고']],
  ['탱크로리', ['탱크로리']],
];

// 품목 문자열에서 차량 표기 추출. 없으면 null(= 차량을 안 따지는 줄).
function vehicleTagOf(item) {
  const t = String(item == null ? '' : item).replace(/\s+/g, '').toUpperCase();
  for (const [tag] of VEHICLE_TAGS) {
    if (t.indexOf(tag.toUpperCase()) >= 0) return tag;
  }
  return null;
}

// 차량 표기(tag)가 차량현황 type을 받아들이는가.
function vehicleTagOk(tag, type) {
  const t = String(type == null ? '' : type).replace(/\s+/g, '').toUpperCase();
  if (!tag || !t) return false;
  for (const [k, allowed] of VEHICLE_TAGS) {
    if (k !== tag) continue;
    return allowed.some((a) => hit(t, a.toUpperCase()));
  }
  return false;
}

// 차량번호 정규화 — 차량현황의 no에는 '006나5907(구2870…', '86로 5923' 처럼
// 괄호 주석·공백이 섞여 있다. 괄호 이후는 잘라내고 공백을 지운다.
function normVehNo(no) {
  let s = String(no == null ? '' : no);
  const i = s.search(/[(（[]/);
  if (i >= 0) s = s.slice(0, i);
  return s.replace(/\s+/g, '').toUpperCase();
}

// [{no,type}] → Map(정규화번호 → type). 같은 번호에 다른 종류가 있으면 판정 불가('')로 둔다.
function buildVehicleIndex(list) {
  const m = new Map();
  for (const v of Array.isArray(list) ? list : []) {
    if (!v) continue;
    const no = normVehNo(v.no);
    const type = cleanText(v.type);
    if (!no || !type) continue;
    if (!m.has(no)) m.set(no, type);
    else if (m.get(no) !== type) m.set(no, '');
  }
  return m;
}

// 차량번호 → 종류. 차량현황에 없거나 충돌이면 null(= 차량 판정 불가 → 애매하면 미매칭).
function vehicleTypeOf(vehicles, no) {
  const idx = (vehicles instanceof Map) ? vehicles : buildVehicleIndex(vehicles);
  const k = normVehNo(no);
  if (!k) return null;
  const t = idx.get(k);
  return t ? t : null;
}

// ---------- A-5. 학습 사전(사람이 지정한 대응) ----------

// [{from,to,item,side,row}] → 비교용 목록. 노선표에 없는 줄을 가리키면 버리고 notes에 남긴다.
function prepLearned(list, notes) {
  const out = [];
  for (const l of Array.isArray(list) ? list : []) {
    if (!l) continue;
    const r = ROUTES.find((x) => x.side === l.side && Number(x.row) === Number(l.row));
    if (!r) {
      if (notes) notes.push('[학습] 노선표에 없는 줄 무시: ' + String(l.side) + String(l.row));
      continue;
    }
    out.push({ f: normName(l.from), t: normName(l.to), i: normItem(l.item), route: r });
  }
  return out;
}

// ---------- A-3. 노선 매칭(조용한 오배정 차단) ----------

// 노선사전을 미리 정규화해 둔다(ALIAS·ROUTES가 상수라 결과는 항상 동일 — 의미 변화 없음).
const NORM_ROUTES = ROUTES.map((r) => ({
  route: r, f: normName(r.from), t: normName(r.to), i: normName(r.item),
  ni: normItem(r.item), veh: vehicleTagOf(r.item),
}));

// (상차지,하차지)로 후보 줄을 모은다. viaItem = 하차지를 양식 품목칸에서 찾은 경우(포스코 구내운송).
function routeCandidates(f, t) {
  const out = [];
  for (const nr of NORM_ROUTES) {
    // 상차지·하차지가 노선의 정체다 — 둘 다 맞아야 같은 노선으로 본다.
    // (품목만 같고 상차지가 다른 건을 붙이면 엉뚱한 칸에 회수가 들어간다 — 실측 오매칭 사고)
    if (!hit(f, nr.f)) continue;
    let toOk = hit(t, nr.t);
    let viaItem = false;
    if (!toOk && hit(t, nr.i)) {
      // 포스코 구내운송처럼 양식은 하차지를 '구내운송'으로 적고 실제 도착처를
      // 품목 칸에 병기한다(예: 'EP 더스트 (피앤알)') — 그 경우도 하차지 일치로 본다.
      toOk = true; viaItem = true;
    }
    if (!toOk) continue;
    out.push({ nr: nr, viaItem: viaItem });
  }
  return out;
}

function candBrief(list) {
  return list.map((c) => ({ side: c.nr.route.side, row: c.nr.route.row, item: c.nr.route.item }));
}

// 매칭 결과 상세. row는 {from,to,item} 또는 파싱된 인계서 행({emis,trtm,wasteName}).
// opts = { vehicleType:'덤프'|'트랙터'…, vehicle:'차량번호', vehicles:[{no,type}], learned:[{from,to,item,side,row}] }
// 반환 { route, weak, learned, reason, needVehicle, candidates }
//   reason: null(배정됨) | 'NO_ROUTE'(상차지·하차지가 노선표에 없음) | 'AMBIGUOUS'(후보 여럿, 못 좁힘)
//   weak  : 후보가 1개뿐이라 품목이 달라도 배정한 경우(사람이 눈으로 확인하라는 표시)
function matchRouteEx(row, opts) {
  const src = row || {};
  const o = opts || {};
  const rawFrom = src.from !== undefined ? src.from : src.emis;
  const rawTo = src.to !== undefined ? src.to : src.trtm;
  const rawItem = src.item !== undefined ? src.item : src.wasteName;
  const f = normName(rawFrom);
  const t = normName(rawTo);

  // 0) 학습 사전이 최우선 — 사람이 지정한 대응은 무조건 그 줄로 간다.
  //    단, 같은 (상차지·하차지·품목)에 서로 다른 줄이 지정돼 있으면(A-major) 첫 항목을
  //    조용히 고르지 않고 충돌로 드러내 배정하지 않는다(reason 'AMBIGUOUS').
  const learned = o.learnedIndex || prepLearned(o.learned, null);
  if (learned.length) {
    const i = normItem(rawItem);
    const hits = learned.filter((l) => l.f === f && l.t === t && l.i === i);
    if (hits.length) {
      const distinct = [];
      for (const h of hits) {
        if (!distinct.some((r) => r.side === h.route.side && Number(r.row) === Number(h.route.row))) distinct.push(h.route);
      }
      if (distinct.length === 1) {
        return { route: hits[0].route, weak: false, learned: true, reason: null, needVehicle: false, candidates: [] };
      }
      // 충돌 — 사람이 다시 정하도록 미매칭으로 남긴다.
      if (o.notes) {
        o.notes.push('[학습] 충돌: ' + cleanText(rawFrom) + ' → ' + cleanText(rawTo) + ' · ' + cleanText(rawItem)
          + ' → ' + distinct.map((r) => r.side + r.row).join(',') + ' (여러 줄 지정, 배정 보류)');
      }
      return { route: null, weak: false, learned: false, reason: 'AMBIGUOUS', needVehicle: false, candidates: candBrief(routeCandidates(f, t)) };
    }
  }

  const cands = routeCandidates(f, t);
  const brief = candBrief(cands);
  const miss = (reason, needVehicle) => ({
    route: null, weak: false, learned: false, reason: reason,
    needVehicle: !!needVehicle, candidates: brief,
  });
  const take = (c) => ({
    route: c.nr.route, learned: false, reason: null, needVehicle: false, candidates: brief,
    // 구내운송처럼 품목칸이 도착처인 줄은 품목 비교 자체가 성립하지 않으므로 weak를 달지 않는다.
    weak: !c.viaItem && !itemHit(rawItem, c.nr.route.item),
  });

  if (!cands.length) return miss('NO_ROUTE', false);
  // 후보가 1개뿐이면 품목이 달라도 배정한다(안전) — 대신 weak로 표시한다.
  if (cands.length === 1) return take(cands[0]);

  // 후보 2개 이상 — 여기서부터는 '먼저 나온 줄'을 고르지 않는다.
  const itemPool = cands.filter((c) => c.viaItem || itemHit(rawItem, c.nr.route.item));
  if (itemPool.length === 1) return take(itemPool[0]);
  // 품목이 어느 후보와도 안 맞으면(itemPool 비었으면) 차량으로도 배정하지 않는다(A-minor1).
  // 품목 불일치 허용은 후보 1개일 때만(위 cands.length===1 경로). 여기선 미매칭으로 드러낸다.
  if (itemPool.length === 0) return miss('AMBIGUOUS', false);
  const pool = itemPool;

  // 차량 표기로 갈리는 후보(R5 BCT차량 / R6 덤프 같은 줄)라면 차량 종류로 좁힌다.
  const needVehicle = pool.some((c) => c.nr.veh);
  if (needVehicle) {
    // 차량 종류는 opts로 직접 받거나(집계가 행을 묶어 넘길 때) 행의 차량번호를 차량현황에서 찾아 정한다.
    let vt = cleanText(o.vehicleType || src.vehicleType) || null;
    if (!vt) {
      const no = o.vehicle || src.vehicle || src.tranVehicle || src.emisVehicle;
      if (no) vt = vehicleTypeOf(o.vehicles, no);
    }
    if (vt) {
      const narrowed = pool.filter((c) => !c.nr.veh || vehicleTagOk(c.nr.veh, vt));
      if (narrowed.length === 1) return take(narrowed[0]);
    }
    // 차량번호가 차량현황에 없으면 판정 불가 — 여기서 임의로 고르지 않는다.
    return miss('AMBIGUOUS', true);
  }
  return miss('AMBIGUOUS', false);
}

// (상차지, 하차지, 품목) 매칭 — 배정된 노선 또는 null. 기존 호출부 호환(1인자).
function matchRoute(row, opts) {
  return matchRouteEx(row, opts).route;
}

// ---------- 응답 파싱(픽스처 테스트 대상) ----------

// <TD> 한 칸의 값. CDATA로 감싸인 경우와 아닌 경우가 섞여 있다(실측).
function cellText(raw) {
  const v = String(raw).trim();
  const c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (c) return c[1].trim();
  return unescapeXml(v).trim();
}

// <DATA TOTAL="27"> 의 TOTAL. 없으면 null(=SHEET XML이 아님).
function sheetTotal(xml) {
  const m = /<DATA\b[^>]*\bTOTAL\s*=\s*["'](\d+)["']/i.exec(String(xml == null ? '' : xml));
  return m ? parseInt(m[1], 10) : null;
}

// 조회 응답 XML -> 인계서 행 배열.
function parseSheetXml(xml) {
  const out = [];
  const raw = String(xml == null ? '' : xml);
  // <DATA> 구간 밖의 TR(합계행·템플릿행 등)이 섞이면 회수가 조용히 늘어난다 — 구간을 먼저 자른다.
  const dm = raw.match(/<DATA\b[^>]*>([\s\S]*?)<\/DATA>/);
  const s = dm ? dm[1] : raw;
  for (const m of s.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/g)) {
    const td = [];
    for (const c of m[1].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/g)) td.push(cellText(c[1]));
    // 정확히 43열만 데이터 행으로 인정한다. '이상'으로 받으면 열이 하나라도 늘어난 응답에서
    // 인덱스가 통째로 밀린 채 조용히 통과하고(TOTAL 검사도 통과) 그날 집계가 0건이 된다 — 실측 재현됨.
    if (td.length !== TD_MIN) continue;
    out.push({
      manf: td[TD.manf],
      wasteCode: td[TD.wasteCode],
      wasteName: td[TD.wasteName],
      state: td[TD.state],
      emis: td[TD.emis],
      date: td[TD.date],
      qty: td[TD.qty],
      qtyUnit: td[TD.qtyUnit],
      emisVehicle: td[TD.emisVehicle],
      tranFirm: td[TD.tranFirm],
      tranQty: td[TD.tranQty],
      tranUnit: td[TD.tranUnit],
      tranVehicle: td[TD.tranVehicle],
      trtm: td[TD.trtm],
      trtmQty: td[TD.trtmQty],
      writer: td[TD.writer],
      // 시각 4종 — EP더스트 조업일 판정·inspect용
      reservedAt: td[TD.reservedAt],
      confirmedAt: td[TD.confirmedAt],
      tranWorkAt: td[TD.tranWorkAt],
      trtmWorkAt: td[TD.trtmWorkAt],
    });
  }
  return out;
}

// ---------- 집계(allbaro_parse.py 이식, 픽스처 테스트 대상) ----------

// 파이썬 sorted(dict.items()) 재현 — 로케일 무관 코드 단위 비교(회사명은 BMP 문자뿐이라 코드포인트 순서와 동일).
function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

// ---------- A-4. 수량 ----------

// 수량 문자열 -> 숫자. 빈 값·숫자 아님·음수는 null(조용히 0으로 만들지 않는다).
function qtyNum(v) {
  const s = String(v == null ? '' : v).replace(/[,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// 단위 -> 톤 환산 계수. 모르는 단위는 null(= qty_unknown으로 센다).
function unitFactor(u) {
  const k = String(u == null ? '' : u).replace(/\s+/g, '').toUpperCase();
  if (!k) return null;
  return Object.prototype.hasOwnProperty.call(UNIT_FACTOR, k) ? UNIT_FACTOR[k] : null;
}

// 한 행의 수량(톤). 운반자 인수량(TD21/22)이 원칙, '비어 있을 때만' 배출자 위탁량(TD12/13)으로 대체.
// 반환 { ton: 숫자|null, src: 'tran'|'emis'|null, sub: bool } — ton이 null이면 합산하지 않고 미상으로 센다.
// 인수량이 '빈 값'이면 위탁량으로 대체하지만, 값이 있는데 숫자가 아니거나 음수면 조용히 대체하지 않고
// 미상(qty_unknown)으로 남긴다(A-minor2) — 잘못된 인수량을 위탁량으로 덮어 오집계하는 것을 막는다.
// sub=true는 '인수량이 비어 위탁량으로 대체했다'는 표시(대체 성사 여부는 호출부가 ton으로 판정).
function measureRow(r) {
  // 빈 값 판정을 먼저 한다 — qtyNum은 빈 값·비숫자·음수를 모두 null로 뭉개므로 여기선 구별한다.
  const tranEmpty = String(r.tranQty == null ? '' : r.tranQty).replace(/[,\s]/g, '') === '';
  let src;
  let v;
  let u;
  if (tranEmpty) { src = 'emis'; v = qtyNum(r.qty); u = r.qtyUnit; }        // 인수량이 비었을 때만 대체
  else { src = 'tran'; v = qtyNum(r.tranQty); u = r.tranUnit; }             // 값이 있으면 그 값만 쓴다(대체 금지)
  if (v === null) return { ton: null, src: null, sub: tranEmpty };
  const f = unitFactor(u);
  if (f === null) return { ton: null, src: src, sub: tranEmpty };
  return { ton: v * f, src: src, sub: tranEmpty };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// rows(파싱된 인계서 행) -> 상차지·하차지·품목별 건수·수량 + 노선 배정.
// day='YYYY-MM-DD'면 그 인계일자만. opts = { vehicles:[{no,type}], learned:[{from,to,item,side,row}] }
// (기존 2인자 호출도 그대로 동작한다 — opts 생략 시 차량·학습 없이 매칭한다.)
// 포스코 조업일 판정 — 배출자가 포스코면 품목 불문 조업일 기준(PM 지시 2026-08-20:
// "포스코는 배출자 확정등록일자 기준, 6시~익일 6시" — 종전 EP더스트 한정·처리인수시각 기준을 대체).
// 확정등록일시는 배출자 확정 시점에 채워져 처리인수(며칠 지연)를 기다리지 않는다.
function isPosco(from) {
  return String(from || '').indexOf('포스코') >= 0;
}

// 'YYYYMMDD HH:MM:SS' 시각 → 조업일 'YYYYMMDD'. 06시 이전은 전날로 당긴다
// (06시~익일06시 = 당일). 시각이 없으면 빈 문자열('') — 아직 그 단계 전이라 어느 날에도 안 잡힌다.
function opDayFromTrtm(t) {
  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return '';
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 6 * 3600000;
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return '' + dt.getUTCFullYear() + p(dt.getUTCMonth() + 1) + p(dt.getUTCDate());
}

function aggregate(rows, day, opts) {
  // 형식이 틀린 기준일을 조용히 0건으로 넘기면 그날 일지가 통째로 비어 버린다 — 시끄럽게 중단한다.
  if (day != null && day !== '' && !validDay(day)) throw new Error('집계 기준일 형식 오류: ' + String(day));
  const o = opts || {};
  const notes = [];
  const vehIdx = buildVehicleIndex(o.vehicles);
  // notes를 넘겨 matchRouteEx가 학습 충돌(A-major)을 이 배열에 기록하게 한다.
  const mopts = { learnedIndex: prepLearned(o.learned, notes), notes: notes };
  const dayKey = day ? String(day).replace(/-/g, '') : null;
  const map = new Map();
  const excluded = [];   // 계수에서 뺀 행(타사 운반·미실행) — 조용한 제외 금지, 일지에서 사람이 본다
  let total = 0;
  let totalSubstituted = 0;   // 인수량이 비어 위탁량으로 '실제 대체된' 행 수(A-minor2 카운터)
  for (const r of rows || []) {
    const from = cleanText(r.emis);
    const to = cleanText(r.trtm);
    const item = cleanText(r.wasteName);
    if (!from || !to) continue;                       // 배출자·처리자 둘 다 있어야 한 건(파이썬 동일)
    // 조업일 기준(PM 지시 2026-08-20): 포스코 배출분은 '배출자 확정등록일시'의
    // 06시~익일06시를 하루로 본다(24시간 조업). 그 외 배출자는 인계일자(PM 재확인 8/20).
    const d = isPosco(from)
      ? opDayFromTrtm(r.confirmedAt)
      : String(r.date == null ? '' : r.date).slice(0, 8);
    if (dayKey && d !== dayKey) continue;
    // 실행되지 않은·남의 인계서 계수 금지(2026-08-19 실사고: 피앤알 3건 "아예 안 했는데 올라옴",
    // 동일산업 2회 했는데 3회 — 처리상태·운반자를 안 보고 전 행을 실적으로 세고 있었다).
    // ① 운반자 업체명이 있는데 종운이 아니면 남의 운반(포스코 구내운송처럼 여러 사가 뛰는 배출처).
    // ② 미실행 판정은 처리상태로만 한다: 예약·확정(운반자 인수 전)·취소만 제외.
    //    '운반중'은 운반자가 인수해 실행된 건 — 인수량·작업일시는 다음날에야 채워지므로
    //    공란 기준을 쓰면 어제 일지가 통째로 0건이 된다(2026-08-20 실사고: 19일 26건 전멸).
    // 제외는 조용히 버리지 않고 excluded에 인계번호·사유·상태를 남긴다(일지에서 사람이 확인).
    const tranFirm = cleanText(r.tranFirm);
    const state = cleanText(r.state);
    if (tranFirm && tranFirm.indexOf('종운') < 0) {
      excluded.push({ manf: String(r.manf == null ? '' : r.manf), from: from, to: to, item: item,
        why: '타사 운반(' + tranFirm + ')', state: state });
      continue;
    }
    if (state === '예약' || state === '확정' || state.indexOf('취소') >= 0) {
      excluded.push({ manf: String(r.manf == null ? '' : r.manf), from: from, to: to, item: item,
        why: '미실행(' + state + ')', state: state });
      continue;
    }
    const key = JSON.stringify([from, to, item]);   // 충돌 없는 합성 키
    let v = map.get(key);
    if (!v) { v = { from: from, to: to, item: item, rows: [] }; map.set(key, v); }
    const q = measureRow(r);
    // 인수량이 비어 위탁량으로 대체됐고 그 값이 실제로 합산에 쓰인 행만 센다.
    if (q.sub && q.ton !== null) totalSubstituted += 1;
    // 운반차량이 비면 배출차량으로 대체한다(실측 27/27 동일 번호).
    v.rows.push({
      manf: String(r.manf == null ? '' : r.manf),
      vtype: vehicleTypeOf(vehIdx, r.tranVehicle || r.emisVehicle),
      q: q,
    });
    total += 1;
  }

  // 한 묶음(같은 상차지·하차지·품목)을 결과 한 줄로 만든다.
  const counts = [];
  let rawTotal = 0;
  let totalUnknown = 0;
  const emit = (g, list, dec, vtype) => {
    let ton = 0;
    let unknown = 0;
    let fromEmis = false;
    const manfNums = [];
    for (const row of list) {
      manfNums.push(row.manf);
      if (row.q.ton === null) unknown += 1;
      else { ton += row.q.ton; if (row.q.src === 'emis') fromEmis = true; }
    }
    rawTotal += ton;
    totalUnknown += unknown;
    const c = {
      from: g.from, to: g.to, item: g.item, n: list.length, manf_nums: manfNums,
      qty_ton: round3(ton), qty_unknown: unknown, qty_src: fromEmis ? 'emis' : 'tran',
      route: dec.route
        ? { side: dec.route.side, row: dec.route.row, count_col: dec.route.count_col, item: dec.route.item }
        : null,
      weak: !!dec.weak,
    };
    if (vtype) c.vehicle_type = vtype;
    if (dec.learned) c.learned = true;
    if (!dec.route) { c.reason = dec.reason; c.candidates = dec.candidates; }
    counts.push(c);
  };

  for (const g of map.values()) {
    // 차량 분리 여부는 학습·차량 정보와 무관하게 '후보 구조'로 정한다(A-crit).
    // (상차지,하차지)로 모은 후보 중 차량 태그가 붙은 줄이 2개 이상이면, 학습 사전보다 먼저
    // vtype로 쪼갠다. 예전엔 dec.needVehicle로 판단했는데, 학습이 0단계에서 먼저 걸리면
    // needVehicle:false가 되어 차량 분리가 사라지고 트랙터 건까지 학습 줄로 끌려갔다.
    const cands = routeCandidates(normName(g.from), normName(g.to));
    const vehTagged = cands.filter((c) => c.nr.veh).length;

    if (vehTagged < 2) {
      // 차량으로 갈리지 않는 묶음 — 학습 사전을 포함해 한 번에 판정한다.
      emit(g, g.rows, matchRouteEx({ from: g.from, to: g.to, item: g.item }, mopts), null);
      continue;
    }

    // 차량으로 갈리는 묶음(태웅제강 BCT/덤프처럼 같은 조합이 서로 다른 줄로 간다):
    // 차량 종류별로 쪼갠 뒤, '차량으로 1개로 좁혀진 서브그룹'은 차량이 이기고(학습 무시),
    // '차량으로 안 좁혀지는 서브그룹(vtype 미상·차량 판정 실패)'에만 학습 사전을 적용한다.
    const subs = new Map();
    for (const row of g.rows) {
      const k = row.vtype || '';
      if (!subs.has(k)) subs.set(k, []);
      subs.get(k).push(row);
    }
    const keys = Array.from(subs.keys()).sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || cmpStr(a, b));
    for (const k of keys) {
      let d2;
      if (k) {
        // 차량 종류가 있으면 먼저 '학습 없이' 차량만으로 좁혀 본다 — 차량이 학습을 이긴다.
        d2 = matchRouteEx({ from: g.from, to: g.to, item: g.item }, { vehicleType: k });
        // 차량으로 1개로 안 좁혀졌으면(미매칭) 그때만 학습 사전으로 재판정한다.
        if (!d2.route) {
          d2 = matchRouteEx({ from: g.from, to: g.to, item: g.item },
            { learnedIndex: mopts.learnedIndex, notes: notes, vehicleType: k });
        }
      } else {
        // 차량 종류 미상 — 학습 사전만으로 판정(있으면 학습, 없으면 미매칭).
        d2 = matchRouteEx({ from: g.from, to: g.to, item: g.item }, mopts);
      }
      emit(g, subs.get(k), d2, k || null);
    }
  }

  // 파이썬 sorted(dict.items()) 재현 + 차량으로 쪼갠 줄은 노선 순서로 안정화(미매칭은 뒤).
  const rowKey = (c) => (c.route ? c.route.side + String(c.route.row).padStart(3, '0') : '~');
  counts.sort((a, b) => cmpStr(a.from, b.from) || cmpStr(a.to, b.to) || cmpStr(a.item, b.item)
    || cmpStr(rowKey(a), rowKey(b)) || cmpStr(a.vehicle_type || '', b.vehicle_type || ''));

  const unmatched = [];
  for (const c of counts) {
    if (c.route) continue;
    const u = { from: c.from, to: c.to, item: c.item, n: c.n, reason: c.reason, candidates: c.candidates };
    if (c.vehicle_type) u.vehicle_type = c.vehicle_type;
    unmatched.push(u);
  }
  return {
    day: day || null,
    total: total,
    total_qty_ton: round3(rawTotal),
    // 단위·수량을 못 읽어 합산에서 빠진 행 수. 워커(gw-allbaro-run-background)가 qty_unknown으로 읽으므로
    // 같은 값을 두 이름으로 싣는다(total_qty_unknown = 일자 합계라는 뜻).
    qty_unknown: totalUnknown,
    total_qty_unknown: totalUnknown,
    // 인수량이 비어 위탁량으로 대체된 행 수(조용한 대체를 드러내는 카운터, A-minor2).
    qty_substituted: totalSubstituted,
    // 계수에서 뺀 행(타사 운반·미실행 예약건) — 2026-08-19 실사고 후 신설. 인계번호·사유 포함.
    excluded: excluded,
    counts: counts,
    unmatched: unmatched,
    notes: notes,
  };
}

// ---------- 세션·네트워크 (테스트 금지 — 리뷰로만 검증. 개발 중 외부 호출 금지) ----------

// fetch는 쿠키를 저장하지 않으므로 수동 관리한다. icis.js Session 구조 복제.
class Session {
  constructor(creds) {
    this.creds = creds || {};
    this.cookies = new Map();
    this.entn = ENTN;
    this.entnName = ENTN_NAME;
  }

  _storeCookies(res) {
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
    else { const sc = res.headers.get('set-cookie'); if (sc) list = [sc]; }
    for (const c of list) {
      const seg = String(c).split(';')[0];
      const i = seg.indexOf('=');
      if (i > 0) {
        const name = seg.slice(0, i).trim();
        const val = seg.slice(i + 1).trim();
        // 빈 값 = 서버의 쿠키 삭제 신호(cookiejar 동작 재현)
        if (val === '') this.cookies.delete(name);
        else this.cookies.set(name, val);
      }
    }
  }

  // 수동 리다이렉트(쿠키 수집을 위해) — 301/302/303은 GET으로 재요청.
  async _request(method, path, body, headers, timeoutMs) {
    let target = /^https?:/.test(path) ? path : BASE + path;
    let m = method;
    let b = body;
    const h = Object.assign({}, headers);
    for (let hop = 0; hop < 5; hop++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let redirectTo = null;
      let text;
      try {
        const hh = Object.assign({ 'User-Agent': UA }, h);
        if (this.cookies.size) {
          hh.Cookie = Array.from(this.cookies, ([k, v]) => k + '=' + v).join('; ');
        }
        const res = await fetch(target, { method: m, body: b, headers: hh, redirect: 'manual', signal: ctl.signal });
        this._storeCookies(res);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (loc) {
            // POST의 307/308은 자동 재전송 없이 중단(본문 재전송 금지 — 시끄러운 실패가 낫다)
            if (m === 'POST' && (res.status === 307 || res.status === 308)) {
              if (res.body) { try { res.body.cancel(); } catch (e) { /* 무시 */ } }
              throw new Error('POST ' + res.status + ' 리다이렉트 — 중단: ' + target);
            }
            if (res.body) { try { res.body.cancel(); } catch (e) { /* 무시 */ } }
            redirectTo = new URL(loc, target).toString();
          }
        }
        if (!redirectTo) {
          // 4xx/5xx는 throw — 에러 페이지가 파서에 들어가 '0건'으로 오인되는 일을 막는다.
          if (res.status >= 400) {
            if (res.body) { try { res.body.cancel(); } catch (e) { /* 무시 */ } }
            throw new Error('HTTP ' + res.status + ': ' + target);
          }
          // 본문 읽기까지 타임아웃 보호 안에 둔다 — 헤더만 주고 본문을 안 흘리는 서버에서
          // 타이머를 미리 해제하면 백그라운드 한도까지 무한 대기한다.
          text = await res.text();
        }
      } finally {
        clearTimeout(timer);
      }
      if (redirectTo) {
        target = redirectTo;
        m = 'GET'; b = null; delete h['Content-Type'];
        continue;
      }
      return text;
    }
    throw new Error('리다이렉트 한도 초과: ' + target);
  }

  get(path) {
    return this._request('GET', path, null, {}, 40000);
  }

  // opts: {xhr=true, referer=null, timeoutMs=60000}
  // data는 [key,value] 쌍 배열(순서 보존 — 브라우저 폼 순서를 그대로 복제한다) 또는 객체.
  // 주의: 본문에 로그인 비밀번호가 들어갈 수 있다 — 여기서도 호출부에서도 본문을 로그에 찍지 말 것.
  post(path, data, opts) {
    const o = opts || {};
    const xhr = o.xhr === undefined ? true : !!o.xhr;
    const sp = new URLSearchParams();
    const pairs = Array.isArray(data) ? data : Object.entries(data || {});
    for (const [k, v] of pairs) {
      if (Array.isArray(v)) for (const vv of v) sp.append(k, String(vv));
      else sp.append(k, String(v == null ? '' : v));
    }
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: o.referer || (BASE + '/'),
      Origin: BASE,
    };
    if (xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    return this._request('POST', path, sp.toString(), headers, o.timeoutMs || 60000);
  }

  // 브라우저 흐름 복제(HAR 실측): ① GET / (세션 쿠키) → ② POST /main.login.do
  //  → ③ GET 조회 페이지(세션 맥락 + 로그인 성공 판정) → 이후 조회 POST.
  // 공동인증서 불필요(signed_data 빈 값).
  async login() {
    const id = this.creds.id;
    const pw = this.creds.pw;
    if (!id || !pw) throw new Error('자격증명 없음(GW_ALLBARO_ID/GW_ALLBARO_PW 확인)');
    await this.get('/');
    // 필드 순서까지 HAR 그대로. usid/uspw 외에는 전부 빈 문자열.
    await this.post(LOGIN_PATH, [
      ['signed_data', ''], ['retn', ''], ['exec', 'Y'], ['goURL', 'MAIN'], ['name', ''],
      ['ceo_year', ''], ['ceo_month', ''], ['ceo_day', ''], ['ceo_day1', ''],
      ['ceo_day2', ''], ['ceo_day3', ''], ['hp1', ''], ['hp2', ''], ['hp3', ''],
      ['usty', ''], ['work_gb', ''], ['first_login_yn', ''],
      ['usid', id], ['uspw', pw],
    ], { xhr: false, referer: BASE + '/' });
    // 로그인 실패 시에도 200 HTML이 온다 — 조회 화면의 사업장 hidden 값으로 성공을 판정한다.
    const page = await this.get(SEARCH_PAGE);
    const entn = hiddenValue(page, 'entn');
    const name = hiddenValue(page, 'entn_name');
    if (!/^\d+$/.test(entn || '')) {
      throw new Error('로그인 실패 — 조회 화면에 사업장 정보가 없습니다(아이디·비밀번호 또는 세션 확인)');
    }
    this.entn = entn;
    this.entnName = name || ENTN_NAME;
    return true;
  }
}

function createSession(creds) { return new Session(creds); }

// 조회 폼(HAR 엔트리 244 전체 키·순서 복제). 나머지는 전부 빈 문자열.
function searchForm(entn, entnName, sSlash, eSlash) {
  return [
    ['entn', entn], ['entn_name', entnName],
    ['S_CONTROLLER', ''], ['S_METHOD', 'search'], ['S_SAVENAME', ''], ['S_FORWARD', ''], ['S_TREECOL', ''],
    ['cls_yn', ''], ['agency_yn', ''], ['agency_entn', ''], ['agency_firm_name', ''],
    ['err', ''], ['myPage', ''], ['showTabLevel', '0'],
    ['start_date', sSlash], ['end_date', eSlash], ['search_agency_yn', ''],
    ['wste_name_1', ''], ['wste_code_1', ''], ['manf_type_1', '2'], ['rfid_yn_1', ''], ['manf_nums_1', ''],
    ['emis_firm_name', ''], ['emis_chrg', ''],
    ['tran_firm_name', entnName], ['tran_chrg', entn],
    ['trtm_firm_name', ''], ['trtm_chrg', ''],
    ['emis_vehc_nums_1', ''], ['tran_vehc_nums_1', ''], ['trtm_vehc_nums_1', ''],
    ['ibTabTop1', ''], ['editpage1', ''], ['ibTabBottom1', ''],
    ['ibTabTop2', ''], ['editpage2', ''], ['ibTabBottom2', ''],
    ['ibTabTop3', ''], ['editpage3', ''], ['ibTabBottom3', ''],
    ['pageNum', '1'], ['pageNo', '1'], ['onePageRows', ONE_PAGE_ROWS],
  ];
}

// 운반자(우리) 기준 인계서 진행상황 조회. sDate/eDate='YYYY-MM-DD'.
// 올바로 화면 안내: 배출자 인계일자 기준, 최대 조회기간 30일.
async function searchManifests(S, sDate, eDate) {
  const s = toSlash(sDate);
  const e = toSlash(eDate);
  if (!s) throw new Error('시작일 형식 오류: ' + String(sDate));
  if (!e) throw new Error('종료일 형식 오류: ' + String(eDate));
  const entn = (S && S.entn) || ENTN;
  const entnName = (S && S.entnName) || ENTN_NAME;
  const xml = await S.post(SEARCH_XML, searchForm(entn, entnName, s, e),
    { xhr: true, referer: BASE + SEARCH_PAGE });
  const total = sheetTotal(xml);
  if (total === null) {
    // 세션이 끊기면 XML 대신 로그인 HTML이 온다 — 조용히 0건으로 넘기면 안 된다.
    throw new Error('조회 응답이 SHEET XML이 아닙니다(세션 만료 의심, ' + String(xml).length + '바이트)');
  }
  const rows = parseSheetXml(xml);
  // 양방향 검사 — 적으면 누락(페이지 초과·열 구조 변경), 많으면 데이터 행이 아닌 것이 섞인 것.
  // 어느 쪽이든 조용히 넘기면 하루 회수가 틀린 채로 저장된다.
  if (total !== rows.length) {
    throw new Error('조회 행수 불일치: TOTAL=' + total + ' · 파싱 ' + rows.length + '행'
      + (total > rows.length ? ' (누락 — 열 구조 변경 또는 500건 초과 의심)' : ' (초과 — 비데이터 행 혼입 의심)'));
  }
  return rows;
}

// 날짜 목록 수집 → 날짜별 집계. days=['YYYY-MM-DD', ...]
// opts = { vehicles:[{no,type}], learned:[{from,to,item,side,row}] } — aggregate에 그대로 넘긴다.
// 실패는 예외로 터뜨리지 않고 {ok:false, code, detail}로 돌려준다(워커가 job에 기록).
// EP더스트 지연분을 잡기 위한 인계일자 소급 일수(처리인수 지연 실측 최대 +2일 → 여유 4일).
const EP_WINDOW_BACK = 4;   // 인계일자가 조업일보다 이른 경우(배출자 확정을 늦게 등록) 소급 조회
const CONFIRM_WINDOW_FWD = 2; // 인계일자가 조업일보다 늦은 경우(확정등록이 이름, 8/20 규칙) 선행 조회

// 'YYYY-MM-DD' − n일 → 'YYYY-MM-DD'
function dayMinus(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return day;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

async function collectDays(creds, days, opts) {
  const log = [];
  const out = [];
  const fail = (code, detail) => {
    log.push('[실패] ' + code + ': ' + detail);
    return { ok: false, code: code, detail: detail, days: out, log: log };
  };
  const list = Array.isArray(days) ? days.slice() : [];
  if (!list.length) return fail('NO_DAYS', '수집할 날짜가 없습니다.');
  for (const d of list) {
    if (!validDay(d)) return fail('BAD_DAY', '날짜 형식 오류: ' + String(d));
  }
  let S;
  try {
    S = createSession(creds);
    await S.login();
    log.push('[로그인] OK · 사업장 ' + S.entnName);
  } catch (err) {
    return fail('LOGIN_FAILED', String((err && err.message) || err));
  }
  // 날짜별로 따로 잡는다 — 한 날짜가 실패해도 나머지는 수집한다.
  // (한 try로 묶으면 특정 날짜가 결정적으로 실패할 때 그 뒤 날짜가 매 실행마다 영구 누락된다)
  const badDays = [];
  for (const day of list) {
    try {
      // 조업일(포스코=확정등록 06시 기준)과 인계일자는 양방향으로 어긋날 수 있다:
      // 확정을 늦게 등록하면 인계<조업일 조회 필요(소급 4일), 확정이 이르면 인계>조업일(전방 2일 —
      // 8/20 규칙 개정 때 전방 조회가 없어 9건이 어느 날짜에도 안 잡히는 사고 실측).
      // 인계일자 [day-4, day+2] 창을 긁고 aggregate가 조업일==day 행만 골라낸다(넓게 긁고 정확히 거른다).
      const wideFrom = dayMinus(day, EP_WINDOW_BACK);
      const wideTo = dayMinus(day, -CONFIRM_WINDOW_FWD);
      const rows = await searchManifests(S, wideFrom, wideTo);
      const agg = aggregate(rows, day, opts);
      // 열이 밀리면(로그인 만료·응답 구조 변경) 날짜 칸이 회사명 등으로 깨진다 — 직접 탐지한다.
      // (창 조회라 '집계 0'만으론 판단 불가: 명절 등 그날 실적이 0이면 정상적으로 0이다.)
      const malformed = rows.filter((r) => !/^\d{8}/.test(String(r.date == null ? '' : r.date).trim())).length;
      if (rows.length >= 5 && malformed > rows.length / 2) {
        throw new Error('날짜 칸 ' + malformed + '/' + rows.length + '행 손상 — 응답 열 구조 변경 의심');
      }
      out.push(agg);
      log.push('[' + day + '] ' + agg.total + '건 · ' + agg.total_qty_ton + '톤 · 노선 '
        + agg.counts.length + '종 · 미매칭 ' + agg.unmatched.length + '건'
        + (agg.total_qty_unknown ? ' · 수량 미상 ' + agg.total_qty_unknown + '건' : '')
        + (agg.qty_substituted ? ' · 위탁량 대체 ' + agg.qty_substituted + '건' : ''));
      for (const u of agg.unmatched) {
        log.push('   미매칭(' + (u.reason === 'NO_ROUTE' ? '노선표에 없음' : '어느 줄인지 모호') + '): '
          + u.from + ' → ' + u.to + ' · ' + u.item + ' · ' + u.n + '건');
      }
      for (const w of agg.counts) {
        if (w.weak) log.push('   품목 불일치(후보 1개라 배정): ' + w.from + ' → ' + w.to + ' · ' + w.item);
      }
      for (const nt of agg.notes) log.push('   ' + nt);
    } catch (err) {
      badDays.push(day);
      log.push('[' + day + '] 실패: ' + String((err && err.message) || err));
    }
    await sleep(500);   // 연속 조회 간 예의상 간격
  }
  if (badDays.length) {
    // 성공한 날짜의 집계는 그대로 돌려준다 — 워커가 그것만 저장하고 실패는 알림으로 드러난다.
    log.push('[실패] DAY_FAILED: ' + badDays.join(', '));
    return { ok: false, code: 'DAY_FAILED', detail: '수집 실패 날짜: ' + badDays.join(', '),
      days: out, log: log };
  }
  return { ok: true, days: out, log: log };
}

// 월별 정산 참고 합산(혁신②, 2026-08-20) — 일자 집계 문서들을 (상차지,하차지,품목)으로 묶어
// 건수·톤을 합친다. 읽기 전용 참고용이라 돈 상태(paid·reviewed·invoice)와는 완전히 무관하다.
// 못 읽은 날은 조용히 0으로 뭉개지 않고 days_failed로 센다(무음 축소 금지 — 계약 B-major1과 같은 원칙).
function mergeMonthCounts(dayDocs) {
  const map = new Map();
  let totalN = 0, totalTon = 0, unmatchedN = 0, excludedN = 0, daysN = 0;
  for (const doc of dayDocs || []) {
    if (!doc || !Array.isArray(doc.counts)) continue;
    daysN += 1;
    for (const c of doc.counts) {
      const key = JSON.stringify([c.from || '', c.to || '', c.item || '']);
      let v = map.get(key);
      if (!v) { v = { from: c.from || '', to: c.to || '', item: c.item || '', n: 0, ton: 0, ton_unknown: 0 }; map.set(key, v); }
      const n = Number(c.n) || 0;
      const t = Number(c.qty_ton) || 0;
      v.n += n; v.ton += t;
      v.ton_unknown += Number(c.qty_unknown) || 0;
      totalN += n; totalTon += t;
    }
    for (const u of (doc.unmatched || [])) unmatchedN += Number(u.n) || 0;
    excludedN += (doc.excluded || []).length;
  }
  const rows = Array.from(map.values()).map(function (v) { v.ton = Math.round(v.ton * 1000) / 1000; return v; });
  rows.sort(function (a, b) { return b.ton - a.ton || b.n - a.n || (a.from < b.from ? -1 : 1); });
  return { rows: rows, total_n: totalN, total_ton: Math.round(totalTon * 1000) / 1000, unmatched_n: unmatchedN, excluded_n: excludedN, days_n: daysN };
}

module.exports = {
  // 상수
  ROUTES, ALIAS, ITEM_ALIAS, VEHICLE_TAGS, UNIT_FACTOR, BASE, ENTN, ENTN_NAME, TD,
  // 순수 함수(픽스처 테스트 대상)
  normName, normItem, itemHit, matchRoute, matchRouteEx,
  vehicleTagOf, vehicleTagOk, normVehNo, buildVehicleIndex, vehicleTypeOf,
  parseSheetXml, sheetTotal, aggregate, validDay, toSlash, kstTodayISO,
  isPosco, opDayFromTrtm, dayMinus, mergeMonthCounts,
  // 세션·네트워크(테스트 금지 — 리뷰로만 검증)
  createSession, searchManifests, collectDays,
};
