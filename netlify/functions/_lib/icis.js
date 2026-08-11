'use strict';

// 화관법민원24(icis.mcee.go.kr) 유해화학물질 운반계획서 자동 제출 코어.
// 파이썬 원본(화관법_자동화/bot/bulk_submit.py + route_rpt.py)의 충실 이식 — 원본이 유일한 의미론 기준.
// (2026-08-11 실제 정부 접수 14건으로 검증된 코드의 이식본. 의미 변경 금지.)
//
// 구성:
//   * 순수 함수(파싱·폼 조립) — port_test/test_icis.js 픽스처로 검증.
//   * 세션·네트워크(Session/runDaily/submitWaste) — 실서버 검증은 사람 감독 하에만. 테스트 금지.
// 자격증명은 인자 creds={id,pw}로만 받는다(호출부가 GW_ICIS_ID/GW_ICIS_PW에서 읽어 전달).
// 제출은 정부 규제 민원이라 되돌릴 수 없다 — 실패 의심 시 중단이 원칙(계속 진행 금지).

const BASE = 'https://icis.mcee.go.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const PARENT = BASE + '/cdms/cvpl/createWriting.do';
const VIEW = BASE + '/cdms/cvpl/cnvync/viewCnvyncTemporary.do';

// 폐기물 노선 시나리오(UI 3단계 입력용)
const SCENARIOS = {
  tk_still:  { label: '특강 → 스틸싸이클', from: '특강',   to: '스틸싸이클' },
  tk_vefesa: { label: '특강 → 베페사',     from: '특강',   to: '베페사' },
  yk:        { label: 'YK스틸 → 스틸싸이클', from: 'YK스틸', to: '스틸싸이클' },
  taewoong:  { label: '태웅 → 스틸싸이클',   from: '태웅',   to: '스틸싸이클' },
};
const WASTE_VEHICLES = ['경북98사5749', '경북98사1743'];

// 자동 등록 대상 노선(출발지 키워드). 여기 없는 노선은 건너뛴다.
// YK스틸->스틸싸이클 은 평일 비정기라 기본 제외.
const AUTO_ROUTES = ['베페사징크코리아', '스틸싸이클'];
const SKIP_ROUTES = ['YK스틸'];

// 불러오기 복제는 서버가 배차일시를 현재시각으로 리셋하고 경로를 비운다(실측 8/8).
// 따라서 시각·경로 계열은 "원본 제출본의 view"에서 읽어 덮어쓴다. (HAR post_142/143 키 실측)
const TIME_KEYS = ['carerBeginDt', 'carerEndDt', 'carerEndDtTmpr', 'startDt', 'arriveDt'];
const ROUTE_KEYS = ['beginLc', 'endLc', 'carerDstnc', 'carerTime', 'breakTime', 'totTime',
  'carerHour', 'diffTime', 'flowP', 'startNm', 'startAddr', 'startX',
  'startY', 'finishNm', 'finishAddr', 'finishX', 'finishY', 'choiceCls',
  'distance', 'durationTm', 'highDistance', 'normalDistance', 'passNm',
  'passAddr', 'passX', 'passY', 'passCd', 'newRoadYn', 'newRoadRsn',
  'routeGuideRpt', 'midCount', 'midList', 'routeCount', 'routeList',
  'routeOption', 'routeGuide', 'routeImagePath', 'educateNo'];
const TIME_KEY_SET = new Set(TIME_KEYS);
const ROUTE_KEY_SET = new Set(ROUTE_KEYS);

// ---------- 공용 유틸 ----------

// (name,value) 쌍 목록 -> 사전. 파이썬 dict(list)와 동일하게 중복 키는 마지막 값이 이긴다.
function toDict(pairs) {
  const d = Object.create(null);
  for (const [k, v] of pairs) d[k] = v;
  return d;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// HTML 엔티티 해제 — 파이썬 html.unescape 대응(픽스처·실서버에 나오는 범위 + 표준 최소셋).
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  middot: '\u00b7', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', ndash: '\u2013', mdash: '\u2014',
  // \ud654\ud559\ubb3c\uc9c8\uba85\u00b7\ub2e8\uc704 \ubcf4\uac15(V1 \uac80\ud1a0 2026-08-11): \uadf8\ub9ac\uc2a4 \ubb38\uc790\u00b7\uae30\ud638
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  micro: '\u00b5', sup2: '\u00b2', sup3: '\u00b3', frac12: '\u00bd',
  frac14: '\u00bc', sect: '\u00a7', para: '\u00b6', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', permil: '\u2030', bull: '\u2022',
  prime: '\u2032', Prime: '\u2033', minus: '\u2212',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4',
  epsilon: '\u03b5', lambda: '\u03bb', mu: '\u03bc', pi: '\u03c0',
  sigma: '\u03c3', omega: '\u03c9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394',
  Omega: '\u03a9',
};
// HTML5 \uaddc\uaca9: \uc218\uce58 \ucc38\uc870 0x80~0x9F\ub294 windows-1252\ub85c \uc7ac\ud574\uc11d(\ud30c\uc774\uc36c html.unescape \ub3d9\uc77c)
const WIN1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};
function unescapeHtml(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isNaN(code)) return m;
      if (code >= 0x80 && code <= 0x9f && WIN1252[code]) return String.fromCodePoint(WIN1252[code]);
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    const low = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, low)) return NAMED_ENTITIES[low];
    return m;
  });
}

// 'YYYY-MM-DD HH:MM[:SS]' 파싱 -> {ms(UTC 기준 epoch), hasSec}. 실패 시 null.
// 시간대 개입을 없애려 UTC로만 계산한다(입출력 문자열이 같은 좌표계라 결과 동일).
function parseDt(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  const hh = +m[4]; const mi = +m[5]; const ss = m[6] === undefined ? 0 : +m[6];
  const ms = Date.UTC(y, mo - 1, d, hh, mi, ss);
  // 범위 검증(왕복 확인) — 파이썬 strptime은 2-30·24:00 따위를 거부한다.
  // Date.UTC의 조용한 이월(2026-02-30→03-02)을 그대로 두면 잘못된 날짜로 정부 접수가 나간다.
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d
      || t.getUTCHours() !== hh || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== ss) {
    return null;
  }
  return { ms, hasSec: m[6] !== undefined };
}

// '2026-08-07 09:08:53' -> ms 만큼 이동. 형식(초 유무 포함) 유지. 파싱 불가면 원문 그대로.
function shiftDt(dtStr, ms) {
  const s = String(dtStr == null ? '' : dtStr).trim();
  if (!s) return s;
  const p = parseDt(s);
  if (!p) return s;
  const d = new Date(p.ms + ms);
  const pad = (n) => String(n).padStart(2, '0');
  let out = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
    + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  if (p.hasSec) out += ':' + pad(d.getUTCSeconds());
  return out;
}

// 폼 값 리스트에서 key를 value로 교체(없으면 추가). 파이썬 set_field와 동일 — 같은 키가
// 여러 번 나오면 전부 교체된다(제출 폼에서 교체 대상 키는 중복이 없어 실질 동일).
function setField(vals, key, value) {
  const out = [];
  let done = false;
  for (const [k, v] of vals) {
    if (k === key) { out.push([k, value]); done = true; }
    else out.push([k, v]);
  }
  if (!done) out.push([key, value]);
  return out;
}

// ---------- 파싱(픽스처 테스트 대상) ----------

// 불러오기 목록 HTML -> 행 배열. 파이썬 parse_rows 이식.
function parseRows(html) {
  const rows = [];
  for (const m of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    if (!tr.includes('fn_cnvyncChoice')) continue;
    const tr2 = tr.replace(/<!--[\s\S]*?-->/g, '');
    const cells = [];
    for (const c of tr2.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) {
      cells.push(unescapeHtml(c[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    }
    const mc = /fn_cnvyncChoice\(\s*'?([^')\s]+)'?\s*\)/.exec(tr);
    if (!mc || cells.length < 7) continue;
    rows.push({
      pre: unescapeHtml(mc[1]), seq: cells[0], date: cells[1],
      from: cells[3], to: cells[4], chem: cells[5], vhcle: cells[6],
    });
  }
  return rows;
}

// 목록 페이지네이션의 최대 페이지 수.
function totalPages(html) {
  const ps = [];
  for (const m of String(html).matchAll(/fn_link_page\((\d+)\)/g)) ps.push(parseInt(m[1], 10));
  return ps.length ? Math.max(...ps) : 1;
}

// 속성값 추출 — 큰따옴표·작은따옴표 모두. (화학물질 행 input이 작은따옴표라
// 큰따옴표만 읽던 파이썬 구버전은 행 전체를 놓쳤다 — 8/13 제출 실패의 원인. 실측 2026-08-11)
function attrVal(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(attrs);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3];
}

// 작성 화면 HTML에서 지정 폼(기본 frm)의 현재 값 전부를 [name, value] 목록으로.
// 페이지에는 popForm·printForm 등 폼이 8개라, 전체를 긁으면 검색폼 쓰레기가 섞인다 —
// 반드시 본 폼 범위로 한정한다(실측 2026-08-11).
function formValues(html, formName) {
  formName = formName || 'frm';
  const fm = new RegExp('<form[^>]*\\bname=["\']' + escRe(formName) + '["\'][^>]*>([\\s\\S]*?)<\\/form>')
    .exec(String(html));
  const frm = fm ? fm[1] : String(html);
  const out = [];
  for (const m2 of frm.matchAll(/<(input|textarea)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m2[1];
    const attrs = m2[2];
    const name = attrVal(attrs, 'name');
    if (!name) continue;
    const typ = attrVal(attrs, 'type') || 'text';
    if (typ === 'button' || typ === 'submit' || typ === 'image' || typ === 'file') continue;
    if ((typ === 'checkbox' || typ === 'radio') && !/\bchecked\b/.test(attrs)) continue;
    if (tag === 'textarea') {
      const tm = new RegExp(
        '<textarea\\b(?:[^>"\']|"[^"]*"|\'[^\']*\')*name=["\']' + escRe(name) + '["\']'
        + '(?:[^>"\']|"[^"]*"|\'[^\']*\')*>([\\s\\S]*?)<\\/textarea>').exec(frm);
      out.push([name, tm ? unescapeHtml(tm[1]) : '']);
      continue;
    }
    const val = attrVal(attrs, 'value');
    out.push([name, val !== null ? unescapeHtml(val) : '']);
  }
  return out;
}

// ---------- 폼 조립(픽스처 테스트 대상) ----------

// 복제본 폼(base) 위에 원본 제출본(orig)의 시각·경로 필드를 덮어쓴다.
// 시각(TIME_KEYS)은 shiftMs 만큼 이동, 경로(ROUTE_KEYS)는 orig 값 복사. base에 없는 키는 뒤에 추가.
function overlayForm(baseVals, origVals, shiftMs) {
  const orig = toDict(origVals); // 덮어쓸 키들은 반복 없음 — dict 안전(파이썬 동일)
  const out = [];
  const have = new Set();
  for (const [k, v] of baseVals) {
    have.add(k);
    if (TIME_KEY_SET.has(k)) out.push([k, shiftDt(k in orig ? orig[k] : v, shiftMs)]);
    else if (ROUTE_KEY_SET.has(k)) out.push([k, k in orig ? orig[k] : v]);
    else out.push([k, v]);
  }
  for (const k of TIME_KEYS.concat(ROUTE_KEYS)) {
    if (!have.has(k) && (k in orig)) {
      out.push([k, TIME_KEY_SET.has(k) ? shiftDt(orig[k], shiftMs) : orig[k]]);
    }
  }
  return out;
}

// 브라우저 JS가 제출 직전 채우는 값들을 보충 — 성공 HAR(entry 143) 실측 대조.
// * view_mode_fileUploader/fileUploader_count: plupload가 동적 생성(HTML에 없음)
// * flowP=2: 경로 로드 완료 표시 / newRoadYn=N: 미반영도로 없음 / carerHour=0
// * diffTime은 브라우저가 빈값으로 보냄 / mxldg는 '21300.00'이 아니라 '21300' (잔여 오차 2건 정합)
function normalizeForm(form) {
  let fd = toDict(form);
  if (!('view_mode_fileUploader' in fd)) {
    const out = [];
    for (const [k, v] of form) {
      out.push([k, v]);
      if (k === 'diffTime') { // 성공 HAR의 위치(diffTime 직후) 그대로
        out.push(['view_mode_fileUploader', 'on']);
        out.push(['fileUploader_count', '0']);
      }
    }
    form = out;
    fd = toDict(form);
  }
  if (!fd.flowP && fd.routeList) form = setField(form, 'flowP', '2');
  if (!fd.newRoadYn) form = setField(form, 'newRoadYn', 'N');
  if (!fd.carerHour) form = setField(form, 'carerHour', '0');
  form = setField(form, 'diffTime', '');
  if (/^\d+\.0+$/.test(fd.mxldg || '')) form = setField(form, 'mxldg', fd.mxldg.split('.')[0]);
  return form;
}

// ---------- routeGuideRpt 재구성(route_rpt.py 이식, 픽스처 테스트 대상) ----------
// 제출본 view에는 routeGuide는 남지만 routeGuideRpt는 빈값 — routeGuide에서 되만든다.
// 규칙은 실제 제출 HAR(베페 노선)을 바이트 단위로 역산해 확정(2026-08-08).

// 파이썬 round(반올림 시 .5는 짝수로) 재현 — HAR 역산 규칙이 파이썬 round 기준.
function pyRound(x) {
  const fl = Math.floor(x);
  const diff = x - fl;
  if (diff > 0.5) return fl + 1;
  if (diff < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

// 거리 = dist<1000 ? '{dist}m' : '{round(dist/100)/10}km' ('%g' — 정수면 소수점 없이)
function distText(d) {
  const f = parseFloat(d);
  if (Number.isNaN(f)) return String(d);
  const n = Math.trunc(f);
  if (n < 1000) return n + 'm';
  return String(pyRound(n / 100.0) / 10.0) + 'km';
}

// routeGuide 항목 'lng,lat,0,dist,turn,img,road,land,exit' -> 필요한 6필드
function stepFields(step) {
  const p = step.split(',').map((x) => x.trim());
  while (p.length < 9) p.push('');
  return [p[3], p[4], p[5], p[6], p[7], p[8]]; // dist, turn, img, road, land, exit
}

// routeGuide 문자열 -> routeGuideRpt 문자열. routeGuide가 비면 '' 반환.
function buildRouteRpt(routeGuide, startNm, startAddr, finishNm, finishAddr) {
  if (!routeGuide) return '';
  const steps = String(routeGuide).split('$$').filter((s) => s.trim());
  const out = ['bul_start.png;' + startNm + ';' + startAddr];
  for (const s of steps) {
    const [dist, turn, img, road, land, exit_] = stepFields(s);
    // 시작 공백/끝 공백 형태 보존: road 없으면 ' land', land 없으면 'road '
    const roadField = (road || land) ? road + ' ' + land : '';
    let direction;
    if (exit_) direction = ((land || road) + ' ' + exit_).trim();
    else if (land) direction = (road + ' ' + land).trim();
    else direction = road;
    const instr = distText(dist) + ' 이동 후 ' + direction + '방향 ' + turn;
    out.push(img + ';' + roadField + ';' + instr);
  }
  out.push('bul_end.png;' + finishNm + ';' + finishAddr);
  return out.join(':');
}

// 제출 폼 전체 조립 파이프라인(bulk_submit.py main의 폼 구간과 동일 순서):
// overlay(시각 이동·경로 복사) -> tmprAt='n' -> routeGuideRpt 재구성 -> normalize
function composeForm(baseVals, origVals, shiftMs) {
  let form = overlayForm(baseVals, origVals, shiftMs);
  form = setField(form, 'tmprAt', 'n');
  const fd = toDict(form);
  // 안내문(routeGuideRpt)은 view에 안 남으므로 routeGuide에서 재구성(HAR 대조로 규칙 검증됨)
  if (!fd.routeGuideRpt && fd.routeGuide) {
    form = setField(form, 'routeGuideRpt', buildRouteRpt(
      fd.routeGuide, fd.startNm || '', fd.startAddr || '', fd.finishNm || '', fd.finishAddr || ''));
  }
  return normalizeForm(form);
}

// ---------- 날짜 유틸(KST) ----------

function kstTodayISO() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseDateMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function isoShiftDays(iso, days) {
  const ms = parseDateMs(iso);
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

// '(짧은이름)주소' -> 짧은이름. 없으면 앞 14자.
function shortLoc(loc) {
  const m = /^\(([^)]+)\)/.exec(loc || '');
  return m ? m[1] : String(loc || '').slice(0, 14);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const RESULT_OK_RE = /"?result"?\s*:\s*"?(1|ok)"?/;

// ---------- 세션·네트워크 (테스트 금지 — 리뷰로만 검증. 실서버 호출은 사람 감독 하에만) ----------

// fetch는 쿠키를 저장하지 않으므로 수동 관리한다(파이썬 cookiejar 대응).
// UA·Referer·Origin·X-Requested-With 는 파이썬과 동일하게 보낸다.
class Session {
  constructor(creds) {
    this.creds = creds || {};
    this.cookies = new Map();
    this.cvplSn = ''; // newDraft()로 발급된 현재 작성 맥락
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

  // 수동 리다이렉트(쿠키 수집을 위해) — urllib처럼 301/302/303은 GET으로 재요청.
  async _request(method, path, body, headers, timeoutMs) {
    let target = /^https?:/.test(path) ? path : BASE + path;
    let m = method;
    let b = body;
    let h = Object.assign({}, headers);
    for (let hop = 0; hop < 5; hop++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        const hh = Object.assign({ 'User-Agent': UA }, h);
        if (this.cookies.size) {
          hh.Cookie = Array.from(this.cookies, ([k, v]) => k + '=' + v).join('; ');
        }
        res = await fetch(target, { method: m, body: b, headers: hh, redirect: 'manual', signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
      this._storeCookies(res);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
          // 파이썬 urllib 동작 재현: POST의 307/308은 자동 재전송 없이 에러(시끄러운 중단).
          // 301/302/303은 GET으로 변환해 추적.
          if (m === 'POST' && (res.status === 307 || res.status === 308)) {
            if (res.body) { try { res.body.cancel(); } catch (e) { /* 무시 */ } }
            throw new Error('POST ' + res.status + ' 리다이렉트 — 중단: ' + target);
          }
          if (res.body) { try { res.body.cancel(); } catch (e) { /* 무시 */ } }
          target = new URL(loc, target).toString();
          m = 'GET'; b = null; delete h['Content-Type'];
          continue;
        }
      }
      // 파이썬 urllib은 4xx/5xx에서 HTTPError를 raise한다 — 같은 동작이어야
      // 에러 페이지가 parseRows에 들어가 "0행"으로 오인되는 일(중복방지 무력화)이 없다.
      if (res.status >= 400) {
        if (res.body) { try { res.body.cancel(); } catch (e) { /* 무시 */ } }
        throw new Error('HTTP ' + res.status + ': ' + target);
      }
      return res.text();
    }
    throw new Error('리다이렉트 한도 초과: ' + target);
  }

  get(path) {
    return this._request('GET', path, null, {}, 40000);
  }

  // opts: {xhr=true, referer=null, timeoutMs=180000}
  // 정상 요청이면 제출도 0.5초에 응답한다(성공 HAR entry 143 실측 475ms).
  // 8/13 실패의 원인은 서버가 느려서가 아니라 폼 결손(화학물질 행 누락)으로
  // 서버가 매달린 것. 타임아웃은 여유있게 180초 유지하되, 걸리면 폼을 의심할 것.
  post(path, data, opts) {
    const o = opts || {};
    const xhr = o.xhr === undefined ? true : !!o.xhr;
    const sp = new URLSearchParams();
    const pairs = Array.isArray(data) ? data : Object.entries(data || {});
    for (const [k, v] of pairs) {
      if (Array.isArray(v)) for (const vv of v) sp.append(k, String(vv)); // 파이썬 doseq 대응
      else sp.append(k, String(v == null ? '' : v));
    }
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: o.referer || (BASE + '/cdms/'),
      Origin: BASE,
    };
    if (xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    return this._request('POST', path, sp.toString(), headers, o.timeoutMs || 180000);
  }

  async login() {
    const id = this.creds.id;
    const pw = this.creds.pw;
    if (!id || !pw) throw new Error('자격증명 없음(GW_ICIS_ID/GW_ICIS_PW 확인)');
    await this.get('/cdms/');
    const res = await this.post('/cdms/confirm/checkLogin.do', {
      mberId: id, mberPassword: pw, id_chk: 'n',
      signData: 'Login', sign: 'Login', signedData: '', vidType: 'client',
    });
    let j;
    try { j = JSON.parse(res); } catch (e) { throw new Error('로그인 응답 파싱 실패: ' + res.slice(0, 120)); }
    if (j.result !== 'ok') throw new Error('로그인 실패: result=' + j.result);
    // 부모 페이지 경유(세션 맥락) — 이거 없이는 listCnvync가 0건/500 (실측)
    await this.get('/cdms/cvpl/createWriting.do');
  }

  // 신규 운반계획서 작성 -> cvplSn 발급. 응답은 JSON {result, cvplSn}.
  async newDraft() {
    const res = await this.post('/cdms/cvpl/cnvync/createCnvyncWriting.do', {
      cvplSn: '', ty: 'new', formatTy: 'g701', formatStleTy: 'g801',
      formatId: 'g909', bsnTy: '', prhibtPrmisnTy: '', chmclsTy: '',
      prmcdReqstTy: '', bsnSttusTy: '', mngrSttemntTy: '', pki: 'n',
      insttId: 'a209', nameTy: '', tyGbn: '',
    }, { xhr: true, referer: PARENT });
    let j;
    try {
      j = JSON.parse(res);
    } catch (e) {
      const m = /(W\d{4}-\d+)/.exec(res);
      if (m) { if (!this.cvplSn) this.cvplSn = m[1]; return m[1]; }
      throw new Error('cvplSn 발급 응답 파싱 실패: ' + res.slice(0, 120));
    }
    if (j.result !== 'ok' || !j.cvplSn) throw new Error('cvplSn 발급 실패: ' + res.slice(0, 120));
    // 작성맥락(this.cvplSn)은 최초 발급 sn으로 고정 — 파이썬은 sn0을 filed_keys/list_plans에
    // 끝까지 명시 전달했다. 건별 draft sn으로 덮어쓰면 다일 실행(금요일 3일치)에서
    // 2·3일차 listCnvync가 소비된 sn을 맥락으로 보내 목록이 비거나 오류가 난다(V1 검토).
    if (!this.cvplSn) this.cvplSn = j.cvplSn;
    return j.cvplSn;
  }

  // 불러오기 목록 — 브라우저 팝업 복제(실측 2026-08-08):
  // 1페이지 = popForm 5필드 + 날짜는 쿼리스트링, 2페이지~ = 팝업 내 frm 전체.
  listPlans(sDate, eDate, page) {
    const p = page || 1;
    const qs = '/cdms/cvpl/cnvync/listCnvync.do?sDate=' + sDate + '&eDate=' + eDate;
    if (p === 1) {
      return this.post(qs, {
        cvplSn: this.cvplSn, drv: '', curTon: '',
        srchSeCd: 'CITUS', selectSrchSeCd: 'CITUS',
      }, { xhr: false, referer: VIEW });
    }
    return this.post('/cdms/cvpl/cnvync/listCnvync.do', {
      searchSort: '', sDate: sDate, eDate: eDate, beginLc: '',
      endLc: '', searchCmpnm: '', searchChmclsNm: '',
      searchDrverNm: '', searchVhcleNo: '', cvplSn: this.cvplSn,
      preCvplSn: '', pageNo: String(p),
    }, { xhr: false, referer: BASE + qs });
  }

  async copyFrom(sn, pre) {
    const res = await this.post('/cdms/cvpl/cnvync/updateCnvyncPre.do',
      { cvplSn: sn, preCvplSn: pre },
      { referer: BASE + '/cdms/cvpl/cnvync/listCnvync.do' });
    let j;
    try { j = JSON.parse(res); } catch (e) { throw new Error('불러오기 응답 파싱 실패 preCvplSn=' + pre); }
    if (String(j.result) === '0') throw new Error('불러오기 실패 preCvplSn=' + pre);
  }

  view(sn) {
    return this.post('/cdms/cvpl/cnvync/viewCnvyncTemporary.do', {
      cvplSn: sn, ty: 'new', formatTy: 'g701', formatStleTy: 'g801',
      formatId: 'g909', pki: 'n', insttId: 'a209',
    }, { xhr: false, referer: PARENT });
  }

  // 제출 전 교육이수 확인 — 브라우저 흐름(HAR entry 117) 복제.
  educateCheck(sn, drverNm, educateNo) {
    return this.post('/cdms/cvpl/cnvync/educateNoCheck.do', {
      drverNm: drverNm, educateNo: educateNo, cvplSn: sn,
      checkPathGubun: 'S', diviceGubun: 'P',
    }, { referer: VIEW });
  }

  // 경로 저장 — 제출과 같은 폼, tmprAt·totTime·carerHour만 빈값(HAR entry 142).
  updateRoute(form) {
    let f = setField(form, 'tmprAt', '');
    f = setField(f, 'totTime', '');
    f = setField(f, 'carerHour', '');
    return this.post('/cdms/cvpl/cnvync/updateRoute.do', f, { referer: VIEW });
  }

  submit(form) {
    return this.post('/cdms/cvpl/cnvync/updateCnvyncWriting.do', form, { referer: VIEW });
  }
}

function createSession(creds) { return new Session(creds); }

// 민원처리 진행상황(listProgress) 공용 폼
function progressForm(over) {
  return Object.assign({
    searchSort: '', sDate: '', eDate: '', searchFormatId: '',
    searchProcsTy: '', searchSplemntTy: '', searchCvplSn: '',
    ty: 'view', formatId: '', cvplSn: '', pageNo: '1',
    pageTy: '', splemntNo: '',
  }, over || {});
}

// 해당 날짜 배차로 이미 존재하는 '차량|YYYY-MM-DD HH:MM' 집합. 중복 제출 방지용 —
// 정부 시스템이라 같은 배차를 두 번 넣으면 안 된다. 두 원천의 합집합(실측 2026-08-11):
//   1) 불러오기 목록(listCnvync): 사업장 공유(타 계정 제출분 포함). 단 새 접수는
//      반나절가량 늦게 뜨고, 미제출 유령 레코드도 섞일 수 있다.
//   2) 이 계정의 접수 목록(listProgress): 즉시 반영. 제목이
//      '…(차량[,차량]) (출발일시 ~ 도착일시)' 꼴이라 view 없이 파싱 가능.
// 초 단위는 건마다 달라(21:00:36 vs 21:00:14) 분까지만 비교한다.
async function filedKeys(S, day) {
  const keys = new Set();
  const html = await S.listPlans(day, day, 1);
  let rows = parseRows(html);
  const np = totalPages(html);
  for (let p = 2; p <= np; p++) rows = rows.concat(parseRows(await S.listPlans(day, day, p)));
  for (const r of rows) {
    const v = toDict(formValues(await S.view(r.pre)));
    const beg = String(v.carerBeginDt || '').trim().slice(0, 16);
    for (const vh of r.vhcle.replace(/ /g, '').split(',')) keys.add(vh + '|' + beg);
  }
  const frm = progressForm({ sDate: isoShiftDays(day, -7), eDate: kstTodayISO() });
  const ref = BASE + '/cdms/cvpl/listProgress.do';
  const first = await S.post('/cdms/cvpl/listProgress.do', frm, { xhr: false, referer: ref });
  const pages = [first];
  const np2 = totalPages(first);
  for (let p = 2; p <= np2; p++) {
    pages.push(await S.post('/cdms/cvpl/listProgress.do',
      progressForm({ sDate: frm.sDate, eDate: frm.eDate, pageNo: String(p) }),
      { xhr: false, referer: ref }));
  }
  for (const html2 of pages) {
    // 제목 셀에 태그·개행이 섞이므로 행 단위로 태그를 벗긴 평문에서 파싱한다
    for (const trm of html2.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const tr = trm[1];
      if (!tr.includes('W6009') || tr.includes('searchCvplSn')) continue;
      const flat = tr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      for (const m of flat.matchAll(/\(([^()]+)\)\s*\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}\s*~/g)) {
        const vhs = m[1];
        const beg = m[2];
        if (beg.slice(0, 10) !== day) continue;
        for (const vh of vhs.replace(/ /g, '').split(',')) keys.add(vh + '|' + beg);
      }
    }
  }
  return keys;
}

// 접수번호로 이 계정의 민원처리 진행상황을 검색해 실제 접수 행을 돌려준다(없으면 '').
// PM이 녹화해준 확인 루트(listProgress) — 제출 성공의 유일한 판정 기준.
async function verifyFiled(S, sn) {
  const resp = await S.post('/cdms/cvpl/listProgress.do',
    progressForm({ searchCvplSn: sn }),
    { xhr: false, referer: BASE + '/cdms/cvpl/listProgress.do' });
  for (const trm of resp.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = trm[1];
    if (!row.includes(sn) || row.includes('searchCvplSn')) continue;
    const cells = [];
    for (const c of row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) {
      cells.push(c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length) return cells.join(' | ');
  }
  return '';
}

// 특정 날짜의 목록(전 페이지)을 파싱해 온다.
async function listAllRows(S, sDate, eDate) {
  const html = await S.listPlans(sDate, eDate, 1);
  let rows = parseRows(html);
  const np = totalPages(html);
  for (let p = 2; p <= np; p++) rows = rows.concat(parseRows(await S.listPlans(sDate, eDate, p)));
  return rows;
}

// 원본 제출본 view -> [orig 폼, 사전]. 출발시각/경로가 없으면 null(판독 실패 — 중단 사유).
async function readOrig(S, pre) {
  const orig = formValues(await S.view(pre));
  const od = toDict(orig);
  if (!od.carerBeginDt || !od.routeList) return null;
  return { orig, od };
}

// 한 건 제출(교육확인 -> 경로저장 -> 등록 -> 접수 재확인). 브라우저 순서 복제.
// 성공 시 {row}, 실패 시 예외 대신 {code, detail} 반환 — 호출부가 즉시 중단한다.
async function submitOne(S, sn, form) {
  const fd = toDict(form);
  let nChem = 0;
  for (const [k] of form) if (k === 'chmclsNm') nChem++;
  if (!nChem) return { code: 'NO_CHEM', detail: '화학물질 행 0개 — 폼 판독 실패. 제출 중단.' };
  const e = await S.educateCheck(fd.cvplSn || sn, fd.drverNm || '', fd.educateNo || '');
  if (e.includes('"result"') && e.toLowerCase().includes('fail')) {
    return { code: 'EDUCATE_FAIL', detail: '교육이수 확인 실패: ' + e.slice(0, 120) };
  }
  const rr = await S.updateRoute(form);
  if (!RESULT_OK_RE.test(rr)) {
    return { code: 'ROUTE_SAVE_FAIL', detail: '경로저장 응답 이상(' + rr.length + '바이트): ' + rr.slice(0, 200) };
  }
  const res = await S.submit(form);
  // 정상 응답은 12바이트 {"result":1}, 0.5초. 느리면 폼 결손 의심.
  const ok = RESULT_OK_RE.test(res) || res.includes('성공');
  if (!ok) {
    return { code: 'SUBMIT_FAIL', detail: '등록 응답이 예상과 다릅니다(' + res.length + '바이트): ' + res.slice(0, 200) };
  }
  // 자가 검증 — 응답 OK를 믿지 않고 접수 목록에서 접수번호로 재확인한다.
  // (8/13 1차 실패 때 응답만 보고 성공을 오판한 재발 방지)
  const row = await verifyFiled(S, sn);
  if (!row) {
    return { code: 'VERIFY_FAIL', detail: '응답은 OK였지만 접수 목록에 ' + sn + ' 가 없습니다 — 중단. 사이트에서 직접 확인 필요.' };
  }
  return { row: row };
}

// 제품 노선 일괄 등록(크론용). targetDays = ['YYYY-MM-DD', ...].
// 기준일: 오늘(KST)부터 최대 7일 소급해 listPlans >= 5건인 날.
// 실패하면 그 건에서 멈춘다(다음 건으로 넘어가지 않음) — {ok:false, code, detail}.
async function runDaily(creds, targetDays, opts) {
  const o = opts || {};
  const dry = !!o.dry;
  const log = [];
  const days = [];
  const fail = (code, detail) => {
    log.push('[실패] ' + code + ': ' + detail);
    return { ok: false, code: code, detail: detail, days: days, log: log };
  };
  try {
    const S = createSession(creds);
    await S.login();
    log.push('[로그인] OK');
    const ctxSn = await S.newDraft();
    log.push('[작성맥락] cvplSn=' + ctxSn);

    // 기준일 탐색
    let base = null;
    let baseRows = null;
    const today = kstTodayISO();
    for (let i = 0; i <= 7; i++) {
      const d = isoShiftDays(today, -i);
      const rows = await listAllRows(S, d, d);
      if (rows.length >= 5) { base = d; baseRows = rows; break; }
    }
    if (!base) return fail('NO_BASE', '최근 7일 내 계획서 5건 이상인 기준일이 없습니다.');
    log.push('[기준일] ' + base + ' — ' + baseRows.length + '건');

    // 자동 대상 필터
    const targets = [];
    for (const r of baseRows) {
      if (SKIP_ROUTES.some((k) => r.from.includes(k))) {
        log.push('   건너뜀(비정기): ' + shortLoc(r.from) + '→' + shortLoc(r.to) + ' ' + r.vhcle);
        continue;
      }
      if (!AUTO_ROUTES.some((k) => r.from.includes(k))) {
        log.push('   건너뜀(대상외): ' + shortLoc(r.from) + '→' + shortLoc(r.to) + ' ' + r.vhcle);
        continue;
      }
      targets.push(r);
    }
    log.push('[자동대상] ' + targets.length + '건');

    const baseMs = parseDateMs(base);
    for (const day of targetDays || []) {
      const dayMs = parseDateMs(day);
      if (dayMs === null) return fail('BAD_DAY', '날짜 형식 오류: ' + day);
      const shiftMs = dayMs - baseMs;
      const rec = { day: day, base: base, submitted: [], skipped: [] };
      days.push(rec);
      // 제출 모드에서만 그날 기제출 건을 미리 읽어 중복을 건너뛴다(조회 비용 아끼려 dry엔 생략).
      const already = dry ? new Set() : await filedKeys(S, day);
      if (already.size) log.push('[중복확인] ' + day + ' 기제출 ' + already.size + '건 — 겹치는 배차는 건너뜁니다');

      for (const r of targets) {
        const label = day + ' ' + shortLoc(r.from) + '→' + shortLoc(r.to) + ' [' + r.vhcle + ']';
        // 원본 제출본의 실제 값(시각·경로) 확보
        const ro = await readOrig(S, r.pre);
        if (!ro) return fail('BAD_ORIG', '원본 판독 실패(' + r.pre + '): 출발시각/경로 없음 — 중단');
        // 같은 (차량, 출발 분)이 이미 그날 존재하면 건너뛴다 — 중복 제출 방지
        const key = r.vhcle.replace(/ /g, '') + '|'
          + shiftDt(String(ro.od.carerBeginDt).trim(), shiftMs).slice(0, 16);
        if (already.has(key)) {
          rec.skipped.push(label);
          log.push('   건너뜀(기제출): ' + label);
          continue;
        }
        if (dry) {
          rec.submitted.push({ sn: null, label: label, row: null });
          log.push('[dry] ' + label);
          continue;
        }
        // 매 건마다 새 계획서 맥락 + 불러오기(첨부·행 sn 등 서버 상태는 복제본 것 유지)
        const sn = await S.newDraft();
        await S.copyFrom(sn, r.pre);
        const baseVals = formValues(await S.view(sn));
        const form = composeForm(baseVals, ro.orig, shiftMs);
        const done = await submitOne(S, sn, form);
        if (done.code) return fail(done.code, label + ' — ' + done.detail);
        rec.submitted.push({ sn: sn, label: label, row: done.row });
        log.push('[제출] ' + label + ' (접수번호 ' + sn + ')');
        log.push('      [접수확인] ' + done.row.slice(0, 110));
        await sleep(1000); // 제출 1건마다 1초 대기
      }
    }
    return { ok: true, days: days, log: log };
  } catch (e) {
    return fail('ERROR', String((e && e.message) || e));
  }
}

// 폐기물 노선 1건 제출(UI 3단계 입력). date='YYYY-MM-DD', time='HH:MM'.
// 템플릿: listPlans(오늘-120일~오늘)에서 from/to/차량이 맞는 가장 최근 행.
async function submitWaste(creds, params) {
  const p = params || {};
  const log = [];
  const fail = (code, detail) => ({ ok: false, code: code, detail: detail, log: log });
  try {
    const sc = SCENARIOS[p.scenario];
    if (!sc) return fail('BAD_SCENARIO', '알 수 없는 시나리오: ' + p.scenario);
    if (!WASTE_VEHICLES.includes(p.vehicleNo)) return fail('BAD_VEHICLE', '허용되지 않은 차량: ' + p.vehicleNo);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return fail('BAD_DATE', '날짜 형식 오류: ' + p.date);
    if (!/^\d{2}:\d{2}$/.test(p.time || '')) return fail('BAD_TIME', '시간 형식 오류: ' + p.time);
    const label = p.date + ' ' + p.time + ' ' + sc.label + ' [' + p.vehicleNo + ']';

    const S = createSession(creds);
    await S.login();
    log.push('[로그인] OK');
    const ctxSn = await S.newDraft();
    log.push('[작성맥락] cvplSn=' + ctxSn);

    // 템플릿 탐색 — 가장 최근(시작일 최대) 행
    const today = kstTodayISO();
    const rows = await listAllRows(S, isoShiftDays(today, -120), today);
    let tpl = null;
    let tplDate = '';
    for (const r of rows) {
      if (!r.from.includes(sc.from) || !r.to.includes(sc.to) || !r.vhcle.includes(p.vehicleNo)) continue;
      const d = (r.date || '').slice(0, 10);
      if (d > tplDate) { tpl = r; tplDate = d; }
    }
    if (!tpl) return fail('NO_TEMPLATE', '과거 제출본 없음: ' + sc.label + ' [' + p.vehicleNo + ']');
    log.push('[템플릿] ' + tpl.pre + ' (' + tpl.date + ')');

    // 원본 판독 + 시각 이동량 계산
    const ro = await readOrig(S, tpl.pre);
    if (!ro) return fail('BAD_ORIG', '원본 판독 실패(' + tpl.pre + '): 출발시각/경로 없음 — 중단');
    const origBegin = parseDt(String(ro.od.carerBeginDt).trim());
    const newBegin = parseDt(p.date + ' ' + p.time + ':00');
    if (!origBegin || !newBegin) return fail('BAD_ORIG', '출발시각 파싱 실패: ' + ro.od.carerBeginDt);
    const shiftMs = newBegin.ms - origBegin.ms; // 소요시간·도착시각·startDt/arriveDt 상대 간격 자동 유지

    // 중복 제출 방지 — 같은 (차량, 출발 분)이 이미 그날 존재하면 중단
    const already = await filedKeys(S, p.date);
    if (already.has(p.vehicleNo.replace(/ /g, '') + '|' + p.date + ' ' + p.time)) {
      return fail('DUPLICATE', '같은 차량·출발시각 배차가 이미 접수돼 있습니다: ' + label);
    }

    const sn = await S.newDraft();
    await S.copyFrom(sn, tpl.pre);
    const baseVals = formValues(await S.view(sn));
    const form = composeForm(baseVals, ro.orig, shiftMs);
    const done = await submitOne(S, sn, form);
    if (done.code) return fail(done.code, label + ' — ' + done.detail);
    log.push('[제출] ' + label + ' (접수번호 ' + sn + ')');
    log.push('      [접수확인] ' + done.row.slice(0, 110));
    return { ok: true, sn: sn, row: done.row, label: label, log: log };
  } catch (e) {
    return fail('ERROR', String((e && e.message) || e));
  }
}

module.exports = {
  // 상수
  SCENARIOS, WASTE_VEHICLES, AUTO_ROUTES, SKIP_ROUTES, TIME_KEYS, ROUTE_KEYS,
  // 순수 함수(픽스처 테스트 대상)
  formValues, parseRows, totalPages, overlayForm, normalizeForm, buildRouteRpt, shiftDt,
  setField, composeForm,
  // 세션·네트워크(테스트 금지 — 리뷰로만 검증)
  createSession, filedKeys, verifyFiled, runDaily, submitWaste,
};
