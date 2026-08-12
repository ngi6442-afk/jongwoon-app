'use strict';

// 올바로(www.allbaro.or.kr) '인계서 진행상황' 수집 → 노선별 회수 집계 코어.
// 로컬 파이썬 원본이 유일한 의미론 기준(2026-08-12 이식):
//   * 07_운반일지_자동화/allbaro_parse.py — (배출자, 처리자, 폐기물종류)별 건수 집계
//   * 07_운반일지_자동화/일지생성.py      — norm() / match_route() 노선 매칭 규칙
//   * 노선사전.json(routes 65) · 별칭사전.json(9) 을 아래에 그대로 임베드
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
  { side: 'L', row: 5, from: '거성산업', to: '네이처', item: '폐합성수지', count_col: 5 },
  { side: 'L', row: 6, from: '동국제강', to: '베페사', item: '지정분진', count_col: 5 },
  { side: 'L', row: 7, from: '동국제강', to: '황조', item: '지정분진', count_col: 5 },
  { side: 'L', row: 8, from: '동일산업', to: '스틸싸이클㈜', item: 'EAFD', count_col: 5 },
  { side: 'L', row: 9, from: '동일산업', to: '건영환경', item: '폐주물사', count_col: 5 },
  { side: 'L', row: 10, from: '동일산업', to: '대화산업', item: '분진', count_col: 5 },
  { side: 'L', row: 11, from: '동일산업', to: '폐유고상', item: '네이처', count_col: 5 },
  { side: 'L', row: 12, from: '동일산업', to: '폐페인트', item: '네이처', count_col: 5 },
  { side: 'L', row: 13, from: '동일산업', to: 'SP성보', item: '폐수오니', count_col: 5 },
  { side: 'L', row: 14, from: '동일산업', to: 'SP성보', item: '공정오니', count_col: 5 },
  { side: 'L', row: 15, from: '동일산업(봉강)', to: '네이처', item: '폐페인트', count_col: 5 },
  { side: 'L', row: 16, from: '동일산업(봉강)', to: '네이처', item: '폐합성수지', count_col: 5 },
  { side: 'L', row: 17, from: '동일산업(봉강)', to: '네이처', item: '폐유고상', count_col: 5 },
  { side: 'L', row: 18, from: '동일산업(봉강)', to: '포항그린', item: '페수처리오니', count_col: 5 },
  { side: 'L', row: 19, from: '동연스틸', to: '경일이앤티', item: '폐수처리오니', count_col: 5 },
  { side: 'L', row: 20, from: '동연스틸 ㈜명례공장', to: '네이처(경주)', item: '하수처리오니', count_col: 5 },
  { side: 'L', row: 21, from: '대성메탈', to: '거성산업㈜', item: '분진', count_col: 5 },
  { side: 'L', row: 22, from: '대화산업', to: '네이처', item: '폐합성수지', count_col: 5 },
  { side: 'L', row: 23, from: '베페사', to: '동일산업', item: '환원철', count_col: 5 },
  { side: 'L', row: 24, from: '베페사(포항)', to: '베페사', item: '폐수오니', count_col: 5 },
  { side: 'L', row: 25, from: '심팩', to: '베페사', item: '지정분진', count_col: 5 },
  { side: 'L', row: 26, from: '스틸싸이클㈜', to: '포항그린', item: '광재', count_col: 5 },
  { side: 'L', row: 27, from: '스틸싸이클㈜', to: '씨엔텍경주', item: '광재', count_col: 5 },
  { side: 'L', row: 28, from: '스틸싸이클㈜', to: '(유)종운환경', item: '광재', count_col: 5 },
  { side: 'L', row: 29, from: '스틸싸이클㈜', to: '영내작업', item: '영내작업', count_col: 5 },
  { side: 'L', row: 30, from: '스틸싸이클㈜', to: '네이처이앤티㈜', item: '폐유성페인트', count_col: 5 },
  { side: 'L', row: 31, from: '심팩리스텍비즈', to: '스틸싸이클', item: '분진', count_col: 5 },
  { side: 'L', row: 32, from: '심팩포항1공장', to: '베페사', item: '분진', count_col: 5 },
  { side: 'L', row: 33, from: '욱성화학', to: '포항그린', item: '비산재', count_col: 5 },
  { side: 'L', row: 34, from: '케이에스피', to: '포항그린', item: '폐유리섬유', count_col: 5 },
  { side: 'L', row: 35, from: '태광산업', to: '태흥산업', item: '석고', count_col: 5 },
  { side: 'L', row: 36, from: '에코프로 씨엔지', to: '네이처(경주)', item: '폐광물류', count_col: 5 },
  { side: 'L', row: 37, from: '㈜SMC', to: '렘코㈜ 재활용1공장', item: '광재', count_col: 5 },
  { side: 'R', row: 5, from: '태웅제강', to: '스틸싸이클', item: 'EAFD (BCT차량)', count_col: 11 },
  { side: 'R', row: 6, from: '태웅제강', to: '스틸싸이클', item: 'EAFD(덤프)', count_col: 11 },
  { side: 'R', row: 7, from: '풍전비철', to: '스틸싸이클', item: '분진', count_col: 11 },
  { side: 'R', row: 8, from: '(주)포스코', to: '구내운송', item: 'EP 더스트 (레스코)', count_col: 11 },
  { side: 'R', row: 9, from: '(주)포스코', to: '구내운송', item: 'EP 더스트 (피앤알)', count_col: 11 },
  { side: 'R', row: 10, from: '(주)포스코', to: '구내운송', item: 'CIP', count_col: 11 },
  { side: 'R', row: 11, from: '(주)포스코', to: '구내운송', item: '슬러지보관장', count_col: 11 },
  { side: 'R', row: 12, from: '(주)포스코퓨처엠', to: '동양산업', item: '공정오니', count_col: 11 },
  { side: 'R', row: 13, from: '(주)포스코퓨처엠', to: '동양산업', item: '폐석회', count_col: 11 },
  { side: 'R', row: 14, from: '(주)포스코퓨처엠', to: '대화산업', item: '분진', count_col: 11 },
  { side: 'R', row: 15, from: '㈜포스코퓨처엠 인조흑연음극재공장', to: '네이처(경주)', item: '분진', count_col: 11 },
  { side: 'R', row: 16, from: '㈜포스코퓨처엠 인조흑연음극재공장', to: '네이처', item: '폐유고상', count_col: 11 },
  { side: 'R', row: 17, from: '㈜포스코퓨처엠 포항양극재공장', to: '포스코HY 클린메탈㈜', item: '유해화학물질', count_col: 11 },
  { side: 'R', row: 18, from: '(주)포스코퓨처엠 포항화학사업부', to: 'HS효성첨단소재㈜울산공장', item: '공정오니', count_col: 11 },
  { side: 'R', row: 19, from: '(주)포스코퓨처엠 포항화학사업부', to: '코스모화학', item: '공정오니', count_col: 11 },
  { side: 'R', row: 20, from: '㈜한국특강', to: '스틸싸이클㈜', item: 'EAFD (BCT차량)', count_col: 11 },
  { side: 'R', row: 21, from: '㈜한국특강', to: '베페사', item: 'EAFD (BCT차량)', count_col: 11 },
  { side: 'R', row: 22, from: '한일철강제2공장', to: '거성산업', item: '분진', count_col: 11 },
  { side: 'R', row: 23, from: '항성메탈', to: '베페사', item: '지정분진', count_col: 11 },
  { side: 'R', row: 24, from: '현대종합금속', to: '거성산업', item: '공정오니', count_col: 11 },
  { side: 'R', row: 25, from: '현대종합금속', to: '대화산업', item: '공정오니', count_col: 11 },
  { side: 'R', row: 26, from: '현대종합금속', to: '주식회사 시온', item: '폐수처리오니', count_col: 11 },
  { side: 'R', row: 27, from: '현대종합금속2공장', to: '거성산업', item: '페수처리오니', count_col: 11 },
  { side: 'R', row: 28, from: '현대종합금속2공장', to: '거성산업', item: '공정오니', count_col: 11 },
  { side: 'R', row: 29, from: '현대종합금속2공장', to: '대화산업', item: '공정오니', count_col: 11 },
  { side: 'R', row: 30, from: '현대종합금속2공장', to: '대화산업', item: '폐수처리오니', count_col: 11 },
  { side: 'R', row: 31, from: '현대제철 포항1공장', to: '황조', item: '분진', count_col: 11 },
  { side: 'R', row: 32, from: 'YK스틸', to: '스틸싸이클㈜', item: 'EAFD', count_col: 11 },
  { side: 'R', row: 33, from: 'TCC스틸', to: '성진kp', item: '폐수오니', count_col: 11 },
  { side: 'R', row: 34, from: 'TCC스틸', to: '포항그린', item: '폐수오니', count_col: 11 },
  { side: 'R', row: 35, from: '안동댐 상류하천 양안 광물찌꺼기 처리사업', to: '포항그린', item: '광재', count_col: 11 },
  { side: 'R', row: 36, from: '안동댐 상류하천 양안 광물찌꺼기 처리사업', to: '포항그린', item: '광재', count_col: 11 },
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
  emisVehicle: 14,  // 배출자 배출차량
  tranFirm: 17,     // 운반자 업체명
  tranQty: 21,      // 운반자 인수량
  tranVehicle: 23,  // 운반자 운반차량
  trtm: 25,         // 처리자(하차지)
  trtmQty: 28,      // 처리자 인수량
  writer: 41,       // 작성자명
};
const TD_MIN = 43;  // 실측 열 수. 이보다 짧은 TR은 데이터 행이 아니다.

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

// 노선사전을 미리 정규화해 둔다(ALIAS·ROUTES가 상수라 결과는 항상 동일 — 의미 변화 없음).
const NORM_ROUTES = ROUTES.map((r) => ({
  route: r, f: normName(r.from), t: normName(r.to), i: normName(r.item),
}));

// (상차지, 하차지, 품목) 부분 문자열 양방향 매칭. 인자는 {from,to,item}
// 또는 파싱된 인계서 행({emis,trtm,wasteName}) 둘 다 받는다.
function matchRoute(row) {
  const src = row || {};
  const f = normName(src.from !== undefined ? src.from : src.emis);
  const t = normName(src.to !== undefined ? src.to : src.trtm);
  const i = normName(src.item !== undefined ? src.item : src.wasteName);
  let best = null;
  for (const nr of NORM_ROUTES) {
    // 상차지·하차지가 노선의 정체다 — 둘 다 맞아야 같은 노선으로 본다.
    // (품목만 같고 상차지가 다른 건을 붙이면 엉뚱한 칸에 회수가 들어간다 — 실측 오매칭 사고)
    if (!hit(f, nr.f)) continue;
    let toOk = hit(t, nr.t);
    if (!toOk && hit(t, nr.i)) {
      // 포스코 구내운송처럼 양식은 하차지를 '구내운송'으로 적고 실제 도착처를
      // 품목 칸에 병기한다(예: 'EP 더스트 (피앤알)') — 그 경우도 하차지 일치로 본다.
      toOk = true;
    }
    if (!toOk) continue;
    const score = 10 + (hit(i, nr.i) ? 1 : 0);  // 품목 일치는 동점 시 우선순위용
    if (best === null || score > best.score) best = { score: score, route: nr.route };
  }
  return best ? best.route : null;
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
      emisVehicle: td[TD.emisVehicle],
      tranFirm: td[TD.tranFirm],
      tranQty: td[TD.tranQty],
      tranVehicle: td[TD.tranVehicle],
      trtm: td[TD.trtm],
      trtmQty: td[TD.trtmQty],
      writer: td[TD.writer],
    });
  }
  return out;
}

// ---------- 집계(allbaro_parse.py 이식, 픽스처 테스트 대상) ----------

// 파이썬 sorted(dict.items()) 재현 — 로케일 무관 코드 단위 비교(회사명은 BMP 문자뿐이라 코드포인트 순서와 동일).
function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

// rows(파싱된 인계서 행) -> 상차지·하차지·품목별 건수. day='YYYY-MM-DD'면 그 인계일자만.
function aggregate(rows, day) {
  // 형식이 틀린 기준일을 조용히 0건으로 넘기면 그날 일지가 통째로 비어 버린다 — 시끄럽게 중단한다.
  if (day != null && day !== '' && !validDay(day)) throw new Error('집계 기준일 형식 오류: ' + String(day));
  const dayKey = day ? String(day).replace(/-/g, '') : null;
  const map = new Map();
  let total = 0;
  for (const r of rows || []) {
    const from = cleanText(r.emis);
    const to = cleanText(r.trtm);
    const item = cleanText(r.wasteName);
    if (!from || !to) continue;                       // 배출자·처리자 둘 다 있어야 한 건(파이썬 동일)
    const d = String(r.date == null ? '' : r.date).slice(0, 8);
    if (dayKey && d !== dayKey) continue;
    const key = JSON.stringify([from, to, item]);   // 충돌 없는 합성 키
    let v = map.get(key);
    if (!v) { v = { from: from, to: to, item: item, n: 0, manf_nums: [] }; map.set(key, v); }
    v.n += 1;
    v.manf_nums.push(String(r.manf == null ? '' : r.manf));
    total += 1;
  }
  const counts = Array.from(map.values()).sort((a, b) => cmpStr(a.from, b.from)
    || cmpStr(a.to, b.to) || cmpStr(a.item, b.item));
  const unmatched = [];
  for (const c of counts) {
    const r = matchRoute(c);
    c.route = r ? { row: r.row, count_col: r.count_col, side: r.side } : null;
    if (!r) unmatched.push({ from: c.from, to: c.to, item: c.item, n: c.n });
  }
  return { day: day || null, total: total, counts: counts, unmatched: unmatched };
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
// 실패는 예외로 터뜨리지 않고 {ok:false, code, detail}로 돌려준다(워커가 job에 기록).
async function collectDays(creds, days) {
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
      const rows = await searchManifests(S, day, day);
      const agg = aggregate(rows, day);
      // 하루짜리 조회는 그날 행만 온다(실측) — 행은 왔는데 집계가 0이면 열이 밀린 것이다.
      // 이 빈 결과를 저장하면 그날 일지가 통째로 사라지므로 저장 전에 터뜨린다.
      if (rows.length > 0 && agg.total === 0) {
        throw new Error('집계 0건(파싱 ' + rows.length + '행) — 응답 열 구조 변경 의심');
      }
      out.push(agg);
      log.push('[' + day + '] ' + agg.total + '건 · 노선 ' + agg.counts.length + '종 · 미매칭 '
        + agg.unmatched.length + '건');
      for (const u of agg.unmatched) {
        log.push('   미매칭: ' + u.from + ' → ' + u.to + ' · ' + u.item + ' · ' + u.n + '건');
      }
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

module.exports = {
  // 상수
  ROUTES, ALIAS, BASE, ENTN, ENTN_NAME, TD,
  // 순수 함수(픽스처 테스트 대상)
  normName, matchRoute, parseSheetXml, sheetTotal, aggregate, validDay, toSlash, kstTodayISO,
  // 세션·네트워크(테스트 금지 — 리뷰로만 검증)
  createSession, searchManifests, collectDays,
};
