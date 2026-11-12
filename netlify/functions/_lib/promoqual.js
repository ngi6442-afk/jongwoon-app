'use strict';
// 블로그 품질 고리 1단계 — 측정만(체크 10 '블로그 완성도', PM 11/10 17:40 '10. ㄱ' = 원장 C058 '품질 학습 착수 — 추천대로 출력이 안 바뀌는 1단계 측정만부터').
//   근거: work/09_조사_문서/10_블로그완성도_자료_20261110/ — 03_학습설계안 §4(채점 3축 19항목 중 코드로 재는 16항목)·§7(1단계: promoqual.js · 본보기 특징값 · 앱 글·새 초안 점수 저장 · 관리자 카드 표시).
//   지표·채점은 그 폴더 _도구/analyze.py·trial_score.py의 JS 판이다 — 같은 게시글 구성요소를 넣으면 같은 항목 점수가 나온다(tools/promoqual_check.mjs가 표본 6편을 파이썬 값과 대조).
//
// 무엇을 재나 — '앱 출력': 기록 본문을 지금 복사 창이 만드는 모양 그대로 펼쳐 잰다. planFromBody는 index.html @promo-post 구간
//   (promoBuildPostHtml → promoPlanOfHtml)의 줄 만들기를 옮긴 것이다 — 두 벌이므로 게이트가 같은 본문에서 글자·표식째 대조한다(한쪽만 고치면 터진다).
//   게시 때 직원이 붙이는 지도는 붙는 것으로 본다(앱 글 13/13편 실측 — assume_map). 인사말·고정 문구는 분석 규칙대로 지표에서 빠진다(x).
// 하지 않는 것(1단계): 생성 프롬프트·생성 워커·복사 출력·게시는 이 파일을 부르지 않는다(출력 무변 — uismoke가 지킴). 모델 판정 3항목(C7·D6·X6)·보강 재작성·주간 품질 규칙·게시본 채점은 3단계.
// 저장: promoai:quality(아래 sweep) — 크론(gw-promo-ai-cron ⑤)이 기록이 바뀌었을 때·하루 1번 전부 다시 잰다. 관리자 카드는 pl_get의 quality(summary)로 읽기만 한다.
const { blobGet, blobSet } = require('./blobs');
const EX = require('./promoqual_ex.json');

const QUAL_KEY = 'promoai:quality';
const QUAL_VER = 'q1-20261110';          // 채점 규칙 판 — 바뀌면 크론이 다음 회차에 전부 다시 잰다
const LAYOUT_KEY = 'promoai:layout';     // 포장 프로필(promolearn.LAYOUT_KEY와 같은 키 — 복사 창이 쓰는 그 값으로 포장을 재현)
const HIST_MAX = 120;                    // 초안 점수 이력(생성 작업 단위)
const SIM_MAX = 60;                      // X5 겹침 비교 대상 상한(같은 회사 글 최근 순)
const PLAN_MAX = 600;                    // promoPlanOfHtml 상한과 같다
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;

// ---- 사전·규칙(analyze.py와 같은 값·같은 순서) ----
const FIXED_HAS = ['전문으로 수행하고 있는', '전문적으로 진행하고 있는', 'www.jongwoon', '대표전화', '상 담 문 의', '상담 문의', '우수받이·맨홀·관로·집수정 준설, 폐기물 수집운반', '[전화삭제]', '진행하고 있는'];
const CONN = ['고 ', '며 ', '면서 ', '지만 ', '는데 ', '은데 ', '므로 ', '어서 ', '아서 ', '여서 ', '해서 ', '때문에 ', '도록 ', '위해 ', '위해서 ', '려면 ', '거나 ', '으며 ', '하여 ', '되어 ', '이며 ', '니까 ', '으면 ', '다면 ', '라도 ', '수록 '];
const EQUIP = ['준설차', '흡입차', '진공흡입', '진공 흡입', '흡입 장비', '흡입장비', '흡입 호스', '흡입호스', '호스', '고압세척차', '고압 세척', '고압세척', '고압 노즐', '노즐', '살수', '수중펌프', '펌프', '집게차', '크레인', '굴삭기', '포크레인', '덤프', '탱크', 'CCTV', '카메라', '송풍기', '가스측정기', '측정기', '라바콘', '안내판', '신호수', '화살표', '경광등', '안전펜스', '사다리', '삽', '막대', '갈퀴', '장화', '안전모', '보호장갑', '장갑', '마대', '톤백', '음압기', '집진기', '헤파', 'HEPA', '비닐', '보양재', '테이프', '습윤제', '분무', '안전대', '안전망', '안전난간', '발판', '비계', '고소작업차', '스카이', '방진복', '보호복', '방진마스크', '호흡보호구', '호흡용 보호구', '보안경', '안전화', '위생설비', '위생시설', '탈의실', '샤워', '포장재', '경고판', '표지', '지게차', '차량'];
const TERMS = ['우수받이', '빗물받이', '맨홀', '집수정', '하수관로', '관로', '우수관', '오수관', '합류식', '분류식', '측구', '배수로', '그레이팅', '퇴적물', '침전물', '토사', '슬러지', '오니', '스컴', '기름때', '유지', '유속', '역류', '통수', '배수불량', '배수 불량', '준설', '흡입', '고압세척', '연결관', '본관', '이음부', '관경', '침전', '부유물', '악취', '황화수소', '유해가스', '산소결핍', '밀폐공간', '지정폐기물', '수집운반', '폐기물관리법', '하수도법', '석면', '비산', '고형화', '습윤', '습식', '밀폐', '음압', '보양', '석면조사', '작업계획', '해체', '감리', '농도', '슬레이트', '텍스', '천장재', '보온재', '석면폐증', '중피종', '폐암', '잠복기', '산업안전보건법', '발암물질', '함유', '분진', '집진', '추락', '고소작업', '배관', '세륜', '펌프장', '오수', '우수', '하수', '저류', '침수', '배수'];
const PLACE = ['도로변', '도로', '차로', '차선', '보도', '골목', '상가', '건물', '주방', '학교', '교사동', '공장', '창고', '지붕', '천장', '펌프장', '주유소', '아파트', '빌라', '공공시설', '연구시설', '주차장', '가로수', '경사', '하류', '상류', '본관', '연결관', '부지', '마당', '화단', '교차로', '인도', '하천', '저류지', '배수펌프', '세륜장', '정문', '후문', '외벽', '내벽', '바닥', '벽면', '창문', '출입문'];
const ACTS = ['설치', '투입', '배치', '흡입', '세척', '제거', '해체', '포장', '운반', '반출', '점검', '확인', '보양', '습윤', '분사', '밀폐', '측정', '통제', '이동', '정리', '마무리', '준비', '연결', '굴착', '절단', '파쇄', '적재', '하역', '살수', '교체', '촬영', '조사', '청소', '소독', '탈수', '건조', '계량', '보관', '인계'];
const SEASON = { '봄': ['봄', '봄비', '벚꽃', '꽃잎', '해빙'], '여름': ['여름', '장마', '폭염', '무더위'], '가을': ['가을', '단풍'], '겨울': ['겨울', '한파', '결빙', '영하', '동파', '눈 오기'] };
function seasonOf(month) { return ({ 3: '봄', 4: '봄', 5: '봄', 6: '여름', 7: '여름', 8: '여름', 9: '가을', 10: '가을', 11: '가을' })[month] || '겨울'; }
// 파이썬 \d = 유니코드 숫자 → \p{Nd}(u 플래그). 나머지는 글자째 같다.
const QTY_RE = /\p{Nd}+(?:[.,]\p{Nd}+)?\s*(?:m|㎜|mm|cm|km|㎡|m2|㎥|톤|kg|L|ℓ|개소|대|명|시간|분|구간|층|%|미터|평|마대|포대)(?![가-힣A-Za-z])|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무)\s?(?:대|명|개소|시간|톤|미터|마대|포대|차례 운반)(?![가-힣])/gu;
const PAST_RE = /(었|았|였|했|됐|웠|졌|렸|겼|왔|냈|췄|웠|봤|섰)(습니다|고|으며|는데|지만)/u;
const SITE_RE = /이번 현장|이 현장|현장에서|현장은|첫 지점|이 지점|다음 지점|모습입니다|과정입니다|장면입니다|단계입니다|작업입니다|확인했|진행했|진행하였|설치했|투입|배치했|제거했|제거하였|정리했|마무리했/u;
const GREET_END = /입니다\.?$/u;
// 파이썬 re.fullmatch(r'(#\S+\s*)+', t)와 같은 판정을 되돌림 없이: 공백으로 나눈 낱말이 전부 '#'로 시작하고 두 글자 이상
function isTagLine(t) {
  if (!t || /^\s/u.test(t) || t.charAt(0) !== '#') return false;
  return t.split(/\s+/u).filter(Boolean).every(function (w) { return w.charAt(0) === '#' && cpLen(w) >= 2; });
}
const LIST_RE = /^(✔️?|✅|❌|●|★|•|-\s|\p{Nd}+[.)]\s*|[①-⑳])/u;
const CIRCLED = /^[①-⑳]/u;
const MD_RE = /\*\*|^- \*\*|#{2,}\s/gmu;
const SENT_SPLIT = /(?<=[.?!])\s+|(?<=니다)\s+(?=[가-힣A-Za-z"“(])|(?<=니까)\s+/u;

function uniq(a) { return a.filter(function (w, i) { return a.indexOf(w) === i; }); }   // 파이썬 dict 키처럼 같은 낱말은 한 번
const EQUIP_U = uniq(EQUIP), TERMS_U = uniq(TERMS), PLACE_U = uniq(PLACE), ACTS_U = uniq(ACTS);

// 글자 수 = 코드 포인트(파이썬 len과 같게 — 이모지 등)
function cpLen(s) { let n = 0; for (const ch of String(s)) { void ch; n++; } return n; }
function nch(s) { return cpLen(String(s).replace(/\s/gu, '')); }
// 파이썬 str.count — 겹치지 않게 왼쪽부터
function countOf(s, w) { if (!w) return 0; let n = 0, i = 0; for (;;) { i = s.indexOf(w, i); if (i < 0) return n; n++; i += w.length; } }
// 파이썬 round(x, nd) — 실수의 정확한 10진값 기준, 딱 반이면 짝수 쪽
function pyRound(x, nd) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  nd = nd || 0;
  const neg = x < 0, s = Math.abs(x).toFixed(100), dot = s.indexOf('.');
  const ip = s.slice(0, dot), fp = s.slice(dot + 1);
  const keep = fp.slice(0, nd), rest = fp.slice(nd);
  let up;
  if (rest.charAt(0) > '5') up = true;
  else if (rest.charAt(0) < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else { const last = nd > 0 ? keep.charAt(nd - 1) : ip.charAt(ip.length - 1); up = (Number(last) % 2) === 1; }
  let n = BigInt(ip + keep); if (up) n += 1n;
  let str = n.toString();
  if (nd > 0) { str = str.padStart(nd + 1, '0'); str = str.slice(0, str.length - nd) + '.' + str.slice(str.length - nd); }
  const v = Number(str);
  return neg && v !== 0 ? -v : v;
}
function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

// ---- 줄 분류(analyze.py lines_of의 글 줄 규칙) — 줄 = {t, f, n, b}: f '' 본문·'h' 소제목·'l' 목록·'x' 인사·고정 문구·'t' 태그·'img'(n장)·'hr'·'blank' ----
function addText(out, S, raw, o) {
  const t = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!t) { out.push({ t: '', f: 'blank', n: 0, b: '' }); return; }
  S.nline += 1;
  if (isTagLine(t)) { out.push({ t: t, f: 't', n: 0, b: '' }); return; }
  if (!S.greetDone && S.nline <= 3 && t.indexOf('안녕하세요') === 0) S.greet = true;
  if (S.greet) {
    out.push({ t: t, f: 'x', n: 0, b: '' });
    if (GREET_END.test(t) || S.nline > 9) { S.greet = false; S.greetDone = true; }
    return;
  }
  const len = cpLen(t);
  if (len < 60 && FIXED_HAS.some(function (h) { return t.indexOf(h) >= 0; })) { out.push({ t: t, f: 'x', n: 0, b: '' }); return; }
  if (LIST_RE.test(t) && len <= 45 && !CIRCLED.test(t)) { out.push({ t: t, f: 'l', n: 0, b: '' }); return; }
  const isHead = o.block === 'quote' || o.block === 'section' || o.sub === true || ((Number(o.fs) || 0) >= 19 && len <= 50) || (!!o.b && len <= 34 && /\?$/.test(t)) || CIRCLED.test(t);
  out.push({ t: t, f: isHead ? 'h' : '', n: Number(o.fs) || 0, b: o.b ? 'b' : '' });
}
// 네이버 게시글 구성요소(수집기 seq — title·oglink·지도 등은 건너뜀)
function linesFromSeq(seq) {
  const out = [], S = { greet: false, greetDone: false, nline: 0 };
  (Array.isArray(seq) ? seq : []).forEach(function (c) {
    const k = c && c.k;
    if (k === 'img') { out.push({ t: '', f: 'img', n: Object.prototype.hasOwnProperty.call(c, 'n') ? (Number(c.n) || 0) : 1, b: '' }); return; }
    if (k === 'hr') { out.push({ t: '', f: 'hr', n: 0, b: '' }); return; }
    if (k !== 'text' && k !== 'quote' && k !== 'section' && k !== 'table') return;
    (Array.isArray(c.p) ? c.p : []).forEach(function (x) { addText(out, S, x && x.t, { fs: x && x.fs, b: !!(x && x.b), block: k }); });
  });
  return out;
}
function seqHasMap(seq) { return (Array.isArray(seq) ? seq : []).some(function (c) { return c && (c.k === 'placesMap' || c.k === 'map'); }); }
// 줄 계획 [텍스트, 표식(c 가운데·b 굵게·i 사진·h 구분선), 종류] — 복사 계획(promoai:copy)·게시글 줄 배치(final_layout)·planFromBody 공통. 종류 's' = 앱 소제목(질문형 한 줄)
function linesFromPlan(plan) {
  const out = [], S = { greet: false, greetDone: false, nline: 0 };
  (Array.isArray(plan) ? plan : []).forEach(function (e) {
    if (!Array.isArray(e)) return;
    const t = String(e[0] || ''), f = String(e[1] || ''), kind = String(e[2] || '');
    if (f.indexOf('i') >= 0) { out.push({ t: '', f: 'img', n: 1, b: '' }); return; }
    if (f.indexOf('h') >= 0 && !t.trim()) { out.push({ t: '', f: 'hr', n: 0, b: '' }); return; }
    addText(out, S, t, { fs: 0, b: f.indexOf('b') >= 0, block: 'text', sub: kind === 's' });
  });
  return out;
}

// ---- 지표(analyze.py와 같은 정의·같은 반올림) ----
function measure(L, title, dateStr, hasMap) {
  const paras = []; let cur = [];
  L.forEach(function (x) { if (x.f === '' && x.t) cur.push(x.t); else if (cur.length) { paras.push(cur.join(' ')); cur = []; } });
  if (cur.length) paras.push(cur.join(' '));
  const sents = [];
  paras.forEach(function (p) { p.split(SENT_SPLIT).forEach(function (s0) { const s = String(s0 || '').trim(); if (nch(s) >= 4) sents.push(s); }); });
  const isTxt = function (x) { return x.f === '' || x.f === 'h' || x.f === 'l'; };
  const textLines = L.filter(isTxt);
  const all = textLines.map(function (x) { return x.t; }).join(' ');
  const core = nch(all);
  let nImg = 0, run = 0, maxrun = 0;
  L.forEach(function (x) { if (x.f === 'img') { nImg += x.n; run += x.n; if (run > maxrun) maxrun = run; } else if (isTxt(x) && x.t) run = 0; });
  const slen = sents.length ? sents.map(nch) : [0];
  const conn = sents.length ? sents.map(function (s) { return CONN.reduce(function (a, c) { return a + countOf(s, c); }, 0); }) : [0];
  const past = sents.filter(function (s) { return PAST_RE.test(s); }).length;
  const site = sents.filter(function (s) { return PAST_RE.test(s) || SITE_RE.test(s); }).length;
  const has = function (w) { return all.indexOf(w) >= 0; };
  const heads = L.filter(function (x) { return x.f === 'h'; });
  const txtN = textLines.filter(function (x) { return !!x.t; }).length;
  const boldN = textLines.filter(function (x) { return x.b === 'b' && x.t; }).length;
  const month = /^\d{4}-\d{2}/.test(String(dateStr || '')) ? Number(String(dateStr).slice(5, 7)) : 0;
  const seasPost = month ? seasonOf(month) : '';
  const ttl = String(title || '');
  const tSeason = Object.keys(SEASON).filter(function (s) { return SEASON[s].some(function (w) { return ttl.indexOf(w) >= 0; }); });
  let bodyOff = 0;
  Object.keys(SEASON).forEach(function (s) { if (s !== seasPost) SEASON[s].forEach(function (w) { bodyOff += countOf(all, w); }); });
  const mdText = L.filter(function (x) { return !!x.t; }).map(function (x) { return x.t; }).join(' ');
  return {
    m: {
      core_chars: core, n_img: nImg, chars_per_img: nImg ? pyRound(core / nImg, 0) : null, img_burst: maxrun,
      heads: heads.length, q_heads: heads.filter(function (x) { return /\?$/.test(x.t.replace(/\s+$/, '')); }).length,
      lists: L.filter(function (x) { return x.f === 'l'; }).length, hr: L.filter(function (x) { return x.f === 'hr'; }).length,
      bold_ratio: txtN ? pyRound(boldN / txtN, 2) : 0,
      n_sent: sents.length, sent_len_mean: pyRound(mean(slen), 1), long_sent_ratio: pyRound(slen.filter(function (x) { return x >= 60; }).length / slen.length, 2),
      conn_per_sent: pyRound(mean(conn), 2),
      past_ratio: sents.length ? pyRound(past / sents.length, 2) : 0, site_ratio: sents.length ? pyRound(site / sents.length, 2) : 0,
      acts_distinct: ACTS_U.filter(has).length, place_distinct: PLACE_U.filter(has).length,
      equip_distinct: EQUIP_U.filter(has).length, terms_distinct: TERMS_U.filter(has).length,
      qty: (all.match(QTY_RE) || []).length,
      company: (all.match(/종운환경|종운건설/gu) || []).length, cta: (all.match(/문의|상담|연락/gu) || []).length,
      md_left: (mdText.match(MD_RE) || []).length,
      title_len: cpLen(ttl), title_season_off: tSeason.filter(function (s) { return s !== seasPost; }), body_season_off: bodyOff,
      has_map: hasMap ? 1 : 0,
    },
    text: all,
  };
}

// ---- 채점(trial_score.py — 16항목 × 0~2점 → 10점 환산, 기준값은 시안) ----
function tri(v, hi, mid, rev) {
  if (v === null || v === undefined) return 0;
  if (rev) return v <= hi ? 2 : (v <= mid ? 1 : 0);
  return v >= hi ? 2 : (v >= mid ? 1 : 0);
}
const ITEMS = [
  ['C1', 'C', '사진 사이 글', function (m) { return tri(m.img_burst, 2, 4, true); }],
  ['C2', 'C', '사진당 글', function (m) { return tri(m.chars_per_img, 150, 80); }],
  ['C3', 'C', '결함', function (m) { return Math.max(0, 2 - (m.md_left ? 1 : 0) - ((m.title_season_off || []).length ? 1 : 0) - (m.body_season_off >= 2 ? 1 : 0)); }],
  ['C4', 'C', '제목', function (m) { return m._fixed_title ? 0 : ((m.title_len >= 20 && m.title_len <= 50) ? 2 : 1); }],
  ['C5', 'C', '시각 리듬', function (m) { return (m.heads >= Math.max(3, m.n_img / 3) ? 1 : 0) + ((m.lists + m.hr) >= 5 && m.bold_ratio >= 0.15 ? 1 : 0); }],
  ['C6', 'C', '마무리', function (m) { return (m.company >= 2 ? 1 : 0) + ((m.cta >= 1 || m.has_map) ? 1 : 0); }],
  ['D1', 'D', '현장 문장', function (m) { return tri(m.site_ratio, 0.35, 0.20); }],
  ['D2', 'D', '장비·도구', function (m) { return tri(m.equip_distinct, 10, 6); }],
  ['D3', 'D', '공정 동사', function (m) { return tri(m.acts_distinct, 15, 10); }],
  ['D4', 'D', '장소·지형', function (m) { return tri(m.place_distinct, 8, 5); }],
  ['D5', 'D', '현장 수량', function (m) { return tri(m.qty, 3, 1); }],
  ['X1', 'X', '연결어미', function (m) { return tri(m.conn_per_sent, 0.9, 0.6); }],
  ['X2', 'X', '긴 문장', function (m) { return tri(m.long_sent_ratio, 0.12, 0.07); }],
  ['X3', 'X', '전문 용어', function (m) { return tri(m.terms_distinct, 20, 15); }],
  ['X4', 'X', '분량', function (m) { return tri(m.core_chars, 2500, 1500); }],
  ['X5', 'X', '겹침', function (m) { return tri(m.max_sim, 0.35, 0.6, true); }],
];
// 항목이 보는 지표(카드 '부족 항목' 칩에 본보기 값과 나란히)
const ITEM_METRIC = { C1: 'img_burst', C2: 'chars_per_img', C3: 'md_left', C4: 'title_len', C5: 'heads', C6: 'company', D1: 'site_ratio', D2: 'equip_distinct', D3: 'acts_distinct', D4: 'place_distinct', D5: 'qty', X1: 'conn_per_sent', X2: 'long_sent_ratio', X3: 'terms_distinct', X4: 'core_chars', X5: 'max_sim' };
function scoreOf(m) {
  const mm = Object.assign({}, m, { _fixed_title: String(m._title || '').replace(/ /g, '').indexOf('포항시준설포항시') === 0 });
  const items = {}, axis = { C: 0, D: 0, X: 0 };
  let tot = 0;
  ITEMS.forEach(function (it) { const v = it[3](mm); items[it[0]] = v; axis[it[1]] += v; tot += v; });
  const weak = ITEMS.filter(function (it) { return items[it[0]] < 2; }).map(function (it) { return it[0]; })
    .sort(function (a, b) { return (items[a] - items[b]) || (codeIdx(a) - codeIdx(b)); });
  return { items: items, axis: axis, total: tot, score10: pyRound(tot * 10 / (2 * ITEMS.length), 1), weak: weak };
}
function codeIdx(c) { for (let i = 0; i < ITEMS.length; i++) if (ITEMS[i][0] === c) return i; return 99; }

// ---- 겹침(X5): 공백 뺀 8글자 조각 자카드 ----
function shingles(text) {
  const a = Array.from(String(text || '').replace(/\s/gu, ''));
  const s = new Set();
  for (let i = 0; i + 8 <= a.length; i++) s.add(a.slice(i, i + 8).join(''));
  return s;
}
function jaccard(A, B) {
  if (!A || !B || !A.size || !B.size) return 0;
  let inter = 0; const small = A.size <= B.size ? A : B, big = small === A ? B : A;
  small.forEach(function (x) { if (big.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

// ---- 게시글 구성요소 하나 채점(표본 대조·3단계 게시본 채점용) ----
function scoreSeq(title, seq, dateStr, maxSim) {
  const r = measure(linesFromSeq(seq), title, dateStr, seqHasMap(seq));
  r.m.max_sim = (maxSim === undefined || maxSim === null) ? 0 : maxSim;
  r.m._title = String(title || '');
  const s = scoreOf(r.m);
  delete r.m._title;
  return Object.assign({ m: r.m, text: r.text }, s);
}

// ---- 앱 복사 포장 재현(index.html @promo-post 구간 — promoBuildPostHtml + promoPlanOfHtml의 줄 만들기. 두 벌: 게이트가 대조) ----
const PROMO_HEAD_SIG = ['종운환경·종운건설 | 포항 준설·폐기물·철거·석면', '포항·경북 하수관로 준설·CCTV 관로조사, 폐기물 수집운반, 철거·석면해체 전문. 공공기관 실적 다수. 대표전화 054-291-1202.', 'www.jongwoon.co.kr'];
const PROMO_GREET = {
  env: ['안녕하세요.', '포항 및 대구·경북 지역에서', '하수관로 준설, 맨홀 준설, 집수정 준설,', '하수관로 조사 및 고압세척을', '전문으로 수행하고 있는', '(주)종운환경 입니다.'],
  con: ['안녕하세요.', '포항 및 대구·경북 지역에서', '건축물 철거, 석면 해체·제거를', '전문으로 수행하고 있는', '(주)종운건설 입니다.'],
};
const PROMO_ORG = {
  env: { name: '(주)종운환경', addr: '경북 포항시 남구 서원재로 1', biz: '우수받이·맨홀·관로·집수정 준설, 폐기물 수집운반' },
  con: { name: '(주)종운건설', addr: '경북 포항시 남구 정몽주로 823-10', biz: '석면 해체·제거, 건축물 철거' },
};
const PROMO_TEL = '';
const PROMO_SITE = 'jongwoon.co.kr';
const PROMO_MARK_RE = /\[\s*사진\s*([0-9][0-9,\s~\-–·과번]*?)\s*(?:[:：]([^\]]*))?\]/g;
const PROMO_MARK_NB_RE = /^\s*[-*•]?\s*사진\s*([0-9][0-9,\s~\-–·과번]*?)\s*[:：](.*)$/;
const PROMO_WRAP_LO = 12, PROMO_WRAP_HI = 26;
const PROMO_CUT_RE = /(는|은|이|가|을|를|에|에서|로|으로|도|까지|부터|와|과|의|면|지만|는데|고|며|서|아서|어서|해서|해|어|아|자|니|처럼|보다|만|께|한테|뿐|이라|라서|라면|다면|든지|거나|던)$/;
function promoOrgOf(body) { return /석면|철거|해체/.test(String(body || '')) ? 'con' : 'env'; }
function promoMarkNums(spec) {
  const norm = String(spec || '').replace(/[·과]/g, ',').replace(/번/g, '').replace(/\s*([~\-–])\s*/g, '$1');
  const out = [], parts = norm.split(/[,\s]+/);
  for (let i = 0; i < parts.length; i++) {
    const q = parts[i];
    if (!q) continue;
    const m = q.match(/^(\d+)[~\-–](\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (b < a) { const t = a; a = b; b = t; }
      if (b - a > 200) continue;
      for (let n = a; n <= b; n++) out.push(n);
      continue;
    }
    if (/^\d+$/.test(q)) out.push(parseInt(q, 10));
  }
  return out;
}
function promoIsCut(w) { return PROMO_CUT_RE.test(w) || /,$/.test(w); }
function promoSplitSentences(t) {
  const out = []; let cur = ''; const str = String(t || '').trim();
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i); cur += ch;
    if ((ch === '.' || ch === '?' || ch === '!' || ch === '？' || ch === '！') && i + 1 < str.length && /\s/.test(str.charAt(i + 1))) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function promoWrapSense(t, lo, hi, commaFirst) {
  const words = String(t || '').split(' ').filter(function (w) { return !!w; });
  const out = []; let cur = [], lastCut = -1;
  const joined = function (a) { return a.join(' '); };
  const recalc = function () { lastCut = -1; for (let i = 0; i < cur.length; i++) { if (promoIsCut(cur[i]) && joined(cur.slice(0, i + 1)).length >= lo) lastCut = i; } };
  const flush = function (upto) { out.push(joined(cur.slice(0, upto + 1))); cur = cur.slice(upto + 1); recalc(); };
  for (let k = 0; k < words.length; k++) {
    const w = words[k]; cur.push(w);
    const L = joined(cur).length, i = cur.length - 1;
    const cut = promoIsCut(w) && L >= lo;
    if (cut && commaFirst && /,$/.test(w)) { flush(i); continue; }
    if (cut) lastCut = i;
    if (L > hi) {
      if (lastCut >= 0 && lastCut < i) {
        flush(lastCut);
        if (cur.length && promoIsCut(cur[cur.length - 1]) && joined(cur).length >= lo) lastCut = cur.length - 1;
      } else flush(i > 0 ? i - 1 : i);
    } else if (cut && L >= (lo + hi) / 2) { flush(i); }
  }
  if (cur.length) out.push(joined(cur));
  return out;
}
function promoLinesOf(t) {
  let out = [];
  promoSplitSentences(t).forEach(function (u) { out = out.concat(promoWrapSense(u, PROMO_WRAP_LO, PROMO_WRAP_HI, true)); });
  return out;
}
// 본문 → 복사 창 줄 계획 [텍스트, 표식, 종류]. nImg = 기록 사진 수(마커 번호가 가리키는 사진, 안 쓰인 사진은 앱처럼 마지막 사진 묶음 뒤에 이어 붙는다)
function planFromBody(body, nImg, prof, tags) {
  const P = prof, useP = !!(P && P.ok);
  const out = [];
  const lines = String(body || '').split(/\r?\n/), org = promoOrgOf(body);
  const N = Math.max(0, Math.floor(Number(nImg) || 0));
  const used = {}; let imgCount = 0, orphanAt = -1;
  const lastKind = function () { return out.length ? out[out.length - 1][2] : ''; };
  const norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200); };
  const pushLine = function (l, bold, kind) { const t = norm(l); out.push([t, t ? ('c' + (bold ? 'b' : '')) : '', kind || 'line']); };
  const pushBlank = function () { if (out.length && lastKind() !== 'blank') out.push(['', '', 'blank']); };
  const pushHr = function () { if (out.length && lastKind() !== 'hr') out.push(['', 'h', 'hr']); };
  const isSubhead = function (t) { return t.length <= 45 && /[?？]$/.test(t) && t.indexOf('. ') < 0; };
  const pushText = function (t0) {
    const t = String(t0 || '').trim(); if (!t) return;
    if (isSubhead(t)) {
      pushBlank();
      if (useP && (P.head_hr_ratio || 0) >= 0.5) pushHr();
      pushLine(t, useP && (P.head_bold_ratio || 0) >= 0.5, 's');
      return;
    }
    promoLinesOf(t).forEach(function (l) { pushLine(l, false); });
  };
  const pushNums = function (nums) {
    const seen = {}; let k = 0;
    for (let j = 0; j < nums.length; j++) {
      const n = nums[j];
      if (seen[n]) continue;
      seen[n] = 1;
      const i = n - 1;
      if (i >= 0 && i < N) { used[i] = 1; k++; imgCount++; }
    }
    if (k) { pushBlank(); for (let j = 0; j < k; j++) out.push(['', 'i', 'img']); pushBlank(); }
  };
  const handleLine = function (ln) {
    const re = new RegExp(PROMO_MARK_RE.source, 'g');
    let m, idx = 0, any = false;
    while ((m = re.exec(ln))) {
      any = true;
      pushText(ln.slice(idx, m.index));
      pushNums(promoMarkNums(m[1]));
      idx = m.index + m[0].length;
    }
    if (any) { pushText(ln.slice(idx)); return; }
    const nb = ln.match(PROMO_MARK_NB_RE);
    if (nb) {
      const tail = String(nb[2] || ''), dot = tail.indexOf('.');
      pushNums(promoMarkNums(nb[1]));
      if (dot >= 0 && dot < tail.length - 1) pushText(tail.slice(dot + 1));
      return;
    }
    pushText(ln);
  };
  const headLines = (useP && (P.sig_kept_ratio || 0) < 0.3) ? PROMO_GREET[org] : PROMO_HEAD_SIG.concat(PROMO_GREET[org]);
  const gbold = (useP && P.greet_bold && typeof P.greet_bold === 'object') ? P.greet_bold : {};
  headLines.forEach(function (l) { pushLine(l, (gbold[l] || 0) >= 0.5); }); pushBlank();
  lines.forEach(function (ln) {
    if (!String(ln).trim()) { if (useP && (P.blank_per_para || 0) >= 0.15) pushBlank(); return; }
    const before = imgCount;
    handleLine(ln);
    if (imgCount > before) orphanAt = out.length;
  });
  const rest = [];
  for (let i = 0; i < N; i++) if (!used[i]) rest.push(['', 'i', 'img']);
  if (rest.length) { if (orphanAt >= 0) Array.prototype.splice.apply(out, [orphanAt, 0].concat(rest)); else rest.forEach(function (e) { out.push(e); }); }
  const o = PROMO_ORG[org];
  out.push([o.name, 'cb', 'tail']); out.push([o.biz, 'c', 'tail']); out.push([o.addr, 'c', 'tail']);
  if (PROMO_TEL) out.push(['문의 ' + PROMO_TEL, 'c', 'tail']);
  out.push([PROMO_SITE, 'c', 'tail']);
  const tg = (Array.isArray(tags) ? tags : []).map(function (x) { return String(x || '').replace(/^#+/, '').replace(/\s+/g, ''); }).filter(Boolean);
  if (tg.length) { out.push(['', '', 'blank']); for (let i = 0; i < tg.length; i += 5) out.push([tg.slice(i, i + 5).map(function (x) { return '#' + x; }).join(' '), 'c', 'tags']); }
  return out.slice(0, PLAN_MAX);
}

// ---- 기록(앱 출력) 채점 — others = 같은 회사 다른 글의 겹침 조각(X5) ----
function measureText(title, body, nImg, tags, prof, dateStr) {
  const plan = planFromBody(body, nImg, prof, tags);
  const r = measure(linesFromPlan(plan), title, dateStr, true);   // assume_map — 지도는 게시 때 직원이 붙인다(앱 글 13/13편)
  return { m: r.m, text: r.text, plan_n: plan.length };
}
function finish(meas, title, maxSim) {
  const m = Object.assign({}, meas.m, { max_sim: pyRound(maxSim || 0, 3), _title: String(title || '') });
  const s = scoreOf(m);
  delete m._title;
  return Object.assign({ m: m }, s);
}
// 저장용 압축(카드·이력에 필요한 것만)
const KEEP_M = ['core_chars', 'n_img', 'chars_per_img', 'img_burst', 'heads', 'q_heads', 'lists', 'hr', 'bold_ratio', 'n_sent', 'sent_len_mean', 'long_sent_ratio', 'conn_per_sent', 'site_ratio', 'equip_distinct', 'acts_distinct', 'place_distinct', 'qty', 'terms_distinct', 'company', 'cta', 'md_left', 'title_len', 'title_season_off', 'body_season_off', 'max_sim'];
function pack(sc) {
  const m = {}; KEEP_M.forEach(function (k) { if (sc.m[k] !== undefined) m[k] = sc.m[k]; });
  return { score10: sc.score10, total: sc.total, axis: sc.axis, items: sc.items, weak: sc.weak, m: m };
}

// ---- 저장(promoai:quality) ----
function kstDay(ts) { return new Date((ts || Date.now()) + 9 * 3600000).toISOString().slice(0, 10); }
function normQ(x) {
  const q = (x && typeof x === 'object') ? x : {};
  return {
    schema: 1, ver: String(q.ver || ''), ex_ver: String(q.ex_ver || ''),
    recs: (q.recs && typeof q.recs === 'object') ? q.recs : {},
    hist: Array.isArray(q.hist) ? q.hist : [],
    sweep: (q.sweep && typeof q.sweep === 'object') ? q.sweep : {},
    updated_at: Number(q.updated_at) || 0,
  };
}
function kindOf(r) {
  const ai = r && r.ai;
  if (ai && ai.tags_only) return 'tpl_tags';
  if (ai) return 'ai';
  if (r && r.ai_st && r.ai_st.st === 'fail') return 'tpl_fail';
  return 'tpl';
}
// 기록 지문 — 바뀌면 다시 잰다(본문·제목·사진 수·태그·상태·게시일·AI 적용 시각·수정 시각·생성 작업 번호와 상태 — 기록에 적용 안 된 재생성 초안도 잡히게)
function fpOf(r) {
  const s = (r.ai_st && typeof r.ai_st === 'object') ? r.ai_st : {};
  return [Number(r.updated_ts) || 0, Number(r.ts) || 0, (r.ai && Number(r.ai.ts)) || 0, String(r.body || '').length, hashStr(String(r.body || '')), String(r.title || ''), (Array.isArray(r.photos) ? r.photos.length : 0), (Array.isArray(r.tags) ? r.tags.length : 0), String(r.status || ''), String(r.posted_at || ''), String(s.job || ''), String(s.st || '')].join('|');
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
// 계절 판정·정렬 날짜 — 게시된 글 = 게시일(posted_at, 옛 기록은 칸이 없어 updated → 기록 생성일), 게시 전 = 잰 날(오늘 게시한다면)
function dateOf(r, day) {
  if (String(r.status || '') !== 'posted') return day;
  const d = [r.posted_at, r.updated].map(function (x) { return String(x || ''); }).filter(function (x) { return /^\d{4}-\d{2}-\d{2}/.test(x); })[0];
  return d ? d.slice(0, 10) : (Number(r.ts) > 0 ? kstDay(Number(r.ts)) : day);
}
// 크론 ⑤ — 기록이 바뀌었거나 날이 바뀌었거나 채점 판이 바뀌면 잰다. 반환은 로그용 요약. doc = 크론이 이미 읽은 col:promo.
async function sweep(st, doc, now) {
  const t0 = Date.now();
  now = now || Date.now();
  const day = kstDay(now);
  const items = (doc && Array.isArray(doc.items) ? doc.items : []).filter(function (r) { const id = String((r && r.id) || ''); return r && r.del !== 1 && RE_REC_ID.test(id) && !/^(__proto__|constructor|prototype)$/.test(id); });   // 점수 칸 키가 되므로 프로토타입 이름은 거른다
  const qr = await blobGet(st, QUAL_KEY);
  if (!qr.ok && qr.code !== 'NOT_FOUND') return { error: qr.code || 'QUAL_READ_FAILED' };
  const Q = normQ(qr.ok ? qr.data : null);
  const verSame = Q.ver === QUAL_VER && Q.ex_ver === EX.ver;
  const full = !verSame || Q.sweep.day !== day;
  const live = Object.create(null); items.forEach(function (r) { live[r.id] = r; });
  const todo = items.filter(function (r) { return full || !Q.recs[r.id] || Q.recs[r.id].fp !== fpOf(r); });
  const gone = Object.keys(Q.recs).filter(function (id) { return !live[id]; });
  if (!todo.length && !gone.length) return { skipped: 'same', n: items.length };
  const lay = await blobGet(st, LAYOUT_KEY);
  // 포장 프로필을 못 읽으면(없음이 아니라 읽기 실패) 재지 않는다 — 프로필 없이 펼치면 서명·굵게가 달라져 점수가 흔들린다. 다음 회차에 다시
  if (!lay.ok && lay.code !== 'NOT_FOUND') return { error: 'LAYOUT_' + (lay.code || 'READ_FAILED') };
  const prof = (lay.ok && lay.data && lay.data.profile && typeof lay.data.profile === 'object') ? lay.data.profile : null;
  // 모든 기록의 앱 출력 지표·겹침 조각(X5 비교 상대) — 같은 회사 글 최근 순 SIM_MAX편
  const meas = Object.create(null), sh = Object.create(null), orgOfRec = Object.create(null);
  const byDate = items.slice().sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
  byDate.forEach(function (r) {
    const d = dateOf(r, day);
    meas[r.id] = measureText(String(r.title || ''), String(r.body || ''), Array.isArray(r.photos) ? r.photos.length : 0, r.tags, prof, d);
    sh[r.id] = shingles(meas[r.id].text);
    orgOfRec[r.id] = promoOrgOf(r.body);
  });
  const simAgainst = function (id, set, org) {
    let best = 0, n = 0;
    for (const r of byDate) {
      if (r.id === id || orgOfRec[r.id] !== org) continue;
      if (++n > SIM_MAX) break;
      const v = jaccard(set, sh[r.id]); if (v > best) best = v;
    }
    return best;
  };
  const histSeen = Object.create(null); Q.hist.forEach(function (h) { if (h && h.job) histSeen[h.job] = 1; });
  let scored = 0, drafts = 0;
  for (const r of todo) {
    const d = dateOf(r, day), org = orgOfRec[r.id], fp = fpOf(r), prev = Q.recs[r.id] || null;
    const out = finish(meas[r.id], r.title, simAgainst(r.id, sh[r.id], org));
    const rec = { fp: fp, ts: now, title: String(r.title || '').slice(0, 120), date: d, status: String(r.status || ''), kind: kindOf(r), org: org,
      n_img: Array.isArray(r.photos) ? r.photos.length : 0, out: pack(out), draft: null };
    // 모델 초안(보존본, 최근 3건) — 최신은 카드에, 각 작업은 이력에 한 번씩.
    //   기록·채점 판이 그대로인데 날만 바뀌어 전부 다시 재는 회차는 초안 블롭을 다시 읽지 않는다(기록이 늘어도 크론 시간을 지킴 — 새 생성은 지문의 작업 번호가 잡는다)
    if (prev && verSame && prev.fp === fp) rec.draft = prev.draft || null;
    else if (r.ai || r.ai_st) {
      const dr = await blobGet(st, 'promoai:draft:' + r.id);
      if (!dr.ok && dr.code !== 'NOT_FOUND') rec.draft = prev ? (prev.draft || null) : null;   // 읽기 실패 — 앞 값 유지(빈 값으로 덮지 않음)
      const dl = (dr.ok && dr.data && Array.isArray(dr.data.items)) ? dr.data.items.filter(function (x) { return x && x.body; }) : [];
      dl.forEach(function (x, i) {
        const dd = kstDay(Number(x.ts) || now);
        const mt = measureText(String(x.title || ''), String(x.body || ''), rec.n_img, r.tags, prof, dd);
        const sc = finish(mt, x.title, simAgainst(r.id, shingles(mt.text), org));
        const pv = String(x.pv || '').slice(0, 20);   // 프롬프트 판(체크 10 2단계 p2부터 초안에 남음 — 없으면 그 전 판)
        if (i === dl.length - 1) rec.draft = Object.assign({ job: String(x.job || ''), ts: Number(x.ts) || 0, pv: pv }, pack(sc));
        if (x.job && !histSeen[x.job]) { histSeen[x.job] = 1; Q.hist.push({ job: String(x.job), id: r.id, ts: Number(x.ts) || 0, pv: pv, score10: sc.score10, axis: sc.axis, weak: sc.weak.slice(0, 5) }); drafts++; }
      });
    }
    Q.recs[r.id] = rec; scored++;
  }
  gone.forEach(function (id) { delete Q.recs[id]; });
  Q.hist.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
  if (Q.hist.length > HIST_MAX) Q.hist = Q.hist.slice(Q.hist.length - HIST_MAX);
  Q.ver = QUAL_VER; Q.ex_ver = EX.ver;
  Q.sweep = { day: full ? day : (Q.sweep.day || day), ts: now, n: items.length, scored: scored, drafts: drafts, full: !!full, prof_ts: (lay.ok && lay.data) ? (Number(lay.data.ts) || 0) : 0, ms: Date.now() - t0 };
  Q.updated_at = now;
  const w = await blobSet(st, QUAL_KEY, Q);
  if (!w.ok) return { error: w.code || 'QUAL_WRITE_FAILED', scored: scored };
  return { n: items.length, scored: scored, drafts: drafts, gone: gone.length, full: !!full, ms: Q.sweep.ms };
}

// ---- 카드용 요약(pl_get) — 저장값만 읽는다 ----
function med(a) { const s = a.slice().sort(function (x, y) { return x - y; }); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : pyRound((s[h - 1] + s[h]) / 2, 2); }
function exCompact(e) { return { key: e.key, label: e.label, date: e.date, score10: e.score10, axis: e.axis }; }
function summary(raw) {
  const Q = normQ(raw);
  const top = EX.top, dr = EX.dredge || [];
  const exM = top.m || {};
  const rows = Object.keys(Q.recs).map(function (id) {
    const r = Q.recs[id] || {}, o = r.out || {};
    const weak = (Array.isArray(o.weak) ? o.weak : []).slice(0, 4).map(function (c) {
      const k = ITEM_METRIC[c];
      return { code: c, v: (o.m && o.m[k] !== undefined) ? o.m[k] : null, ex: exM[k] !== undefined ? exM[k] : (k === 'max_sim' ? exM.max_sim_same_group : null), s: (o.items || {})[c] };
    });
    return { id: id, date: r.date || '', title: r.title || '', status: r.status || '', kind: r.kind || '', n_img: r.n_img || 0, score10: o.score10, total: o.total, axis: o.axis || null, weak: weak,
      draft10: (r.draft && r.draft.score10 !== undefined) ? r.draft.score10 : null, draft_ts: r.draft ? (r.draft.ts || 0) : 0, draft_pv: r.draft ? String(r.draft.pv || '') : '' };
  }).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || (b.draft_ts - a.draft_ts); });
  const posted = rows.filter(function (r) { return r.status === 'posted' && typeof r.score10 === 'number'; });
  const r4 = posted.slice(0, 4);
  const ai = rows.filter(function (r) { return r.kind === 'ai' && typeof r.score10 === 'number'; }).map(function (r) { return r.score10; });
  return {
    ver: Q.ver, ex_ver: Q.ex_ver, sweep: Q.sweep, updated_at: Q.updated_at,
    top: exCompact(top), dredge: { label: '권민지 준설 상위 ' + dr.length + '편', score10: med(dr.map(function (e) { return e.score10; })), dates: dr.map(function (e) { return e.date; }) },
    basis: EX.basis,
    // 평균은 항목 점수 합(정수)에서 낸다 — 반올림한 10점 값끼리 평균하면 4.35 → 4.3처럼 한 번 더 깎인다(정확값 4.375 → 4.4)
    recent4: { n: r4.length, avg: r4.length ? pyRound(r4.reduce(function (a, r) { return a + (typeof r.total === 'number' ? r.total * 10 / (2 * ITEMS.length) : r.score10); }, 0) / r4.length, 1) : null, list: r4.map(function (r) { return { date: r.date, score10: r.score10 }; }) },
    ai: { n: ai.length, med: med(ai) },
    items: ITEMS.map(function (it) { return { code: it[0], axis: it[1], label: it[2] }; }),
    rows: rows.slice(0, 40),
    hist: Q.hist.slice(-20).map(function (h) { return { id: h.id, ts: h.ts, pv: String(h.pv || ''), score10: h.score10, axis: h.axis }; }),
  };
}

module.exports = {
  QUAL_KEY, QUAL_VER, LAYOUT_KEY, HIST_MAX, ITEMS, ITEM_METRIC, EX,
  pyRound, cpLen, nch, countOf, linesFromSeq, linesFromPlan, measure, scoreOf, scoreSeq, shingles, jaccard,
  promoOrgOf, promoMarkNums, promoLinesOf, planFromBody, measureText, finish, pack, kindOf, fpOf, kstDay, normQ, sweep, summary,
};
