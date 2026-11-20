'use strict';
// P1 판21 KOITA 연구노트 월 자동 초안(착수설명서 판21 · 원장 T759·C099) — 받기·읽기·확정은 이 파일 한 곳, gw-data는 관문·디스패치 연결만.
//   만드는 쪽 = appdata collectors/rnote.py(GitHub Actions cron-backup.yml 'rnote' 작업 — 매일 08:20 KST 기동, 만들기는 KST 1~3일, 그 밖의 날은 흔적만).
//   달마다 문서 1개 'rnote:YYYY-MM'(gw_data — 야간 백업 대상):
//     { schema, period, status 'draft'|'confirmed', text(지금 글 — 확정 뒤엔 확정본), bot_text(봇 원본 — 바뀌지 않음, 판33 학습 짝 재료), bot_at, meta, created_at, updated_at, confirmed:{ts,by,name,edited} }
//   받기 rnote_put = 봇 키(gw-data botKeyOk) — 순서(검토 11/15 ①): 달 꼴 → probe(있는지 묻기만) → 문서가 있으면 '이미 있음'(force 아닐 때 — 재검사·명부 읽기 전에) →
//     규칙 판(RULES_VER — 수집기와 같은지) → 크기 → 명부(회원 0명·못 읽음 = 503) → 서버 재검사(이름·거래처 느슨한 꼴·금액·번호·메일·키) → 저장.
//     ping = 흔적만(만들지 않는 날 — 지난달 문서 없음·확정 안 된 채 오래된 초안이면 ok false) · fail = 봇이 멈춘 사유 코드만(글 없음).
//   읽기 rnote_get = 판29 pmconGate 읽기(관리자) — 최근 12달 목록·가장 오래된 확정 전 초안·가장 최근 확정본 · 확정 rnote_save = pmconGate 쓰기(연구전담요원 = PM만, 검토 11/15 ④) · 감사 1줄(col rnote).
//   새 푸시 없음(PM 콘솔 카드만).
const { store, blobGet, blobSet, blobList } = require('./blobs');
const AUDIT = require('./audit');
const LN = require('./learn');
const cronstamp = require('./cronstamp');

const DATA = 'gw_data', USERS = 'gw_users';
const PREFIX = 'rnote:';             // 'rnote:YYYY-MM'
const FIRST = '2026-11';             // 첫 자동 달(12/1이 11월분을 만듦) — 그 앞 달은 흔적 판정에서 '빠짐'으로 치지 않는다
const STAMP_FN = 'rnote';            // it:cron:rnote:last
const RULES_VER = '2026-11-16.1';    // 거르기 규칙 판 — appdata rnote.py RULES_VER와 같아야 받음(한쪽만 고치고 잊는 일 막기 — 덧대기)
const TEXT_MAX = 200000;             // 글 상한(UTF-8 바이트)
const META_MAX = 4000;               // meta JSON 상한(바이트)
const LIST_MONTHS = 12;              // 화면 목록 = 최근 12달
const NAME_MIN = 2;                  // 공백 뺀 이름이 이보다 짧으면 검사하지 않는다(한 글자 오탐)
const CORE_MIN = 3;                  // 거래처 법인 표기를 뗀 핵심 이름은 3자 이상만(짧은 낱말을 다 가려 글이 못 읽히지 않게)
// appdata rnote.py NAME_SKIP과 같음 — 보통 낱말·시험 입력·가림 표시 글자·직함(뒤에 숫자가 붙은 꼴 '테스트2'도 같은 낱말로 봄)
const NAME_SKIP = { '개인': 1, '기타': 1, '미정': 1, '없음': 1, '본사': 1, '현장': 1, '테스트': 1, '시험': 1, test: 1, '직원': 1, '거래처': 1, '금액': 1, '번호': 1, '관리자': 1, '대표': 1, '운영부': 1, '관리부': 1, '샘플': 1, '예시': 1 };
const CORP_RE = /\(주\)|\(유\)|\(사\)|\(재\)|㈜|주식회사|유한회사|합자회사|사단법인|재단법인/g;
const ZW_RE = /[​-‍⁠﻿]/g;
const H = 3600000;
// 금액 꼴 — appdata rnote.py AMOUNT_RES와 같은 꼴·같은 플래그(수집기는 전부 re.I — 원장 C177 ⓐ로 여기도 전부 i, 영문 글자가 없는 꼴은 뜻이 같음)
//   (원 뒤 원장·원본·원문·원칙·원인·원천 같은 낱말은 금액 아님)
const AMOUNT_RES = [
  /\d[\d,]*(?:\.\d+)?\s*(?:억|천만|백만|만|천)?\s*원(?![장본문칙인천점래격자형리단])/i,
  /\d[\d,]*(?:\.\d+)?\s*억/i,
  /\d[\d,]*\s*만\s*원/i,
  /\d[\d,]*(?:\.\d+)?\s*[천백십]\s*만/i,
  /₩\s*\d/i,
  /\d[\d,]*\s*KRW/i,
  /KRW\s*\d/i,
  /[일이삼사오육칠팔구십백천]+\s*(?:억|만)\s*원/i,
];
// 키·토큰 꼴 — appdata rnote.py KEY_RES와 같은 꼴(값이 아니라 꼴만 본다)
const KEY_RES = [
  /sk-[A-Za-z0-9_-]{16,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/,
  /(?<![\w/+-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![\w-])/,
  /\b(?:api[_-]?key|key|token|secret|password|passwd|pwd|oc)\s*[=:]\s*[^\s,;]{6,}/i,
];
const MAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;   // appdata rnote.py MAIL_RE와 같음(검토 11/15 ⑦)
const NAME_JOIN = '[\\s,·・∙•]*';   // 이름 글자 사이에 허용하는 것(공백·쉼표·가운뎃점) — appdata rnote.py NAME_JOIN과 같음
// 사람 이름 = 회원 + 아래 칸(일용직·차량 운전자) · 거래처 이름 = 아래 칸 — appdata rnote.py NAME_COLS·CLIENT_COLS와 같은 표
const NAME_COLS = [['col:workers', 'name'], ['col:vehicles', 'driver']];
const CLIENT_COLS = [['col:clients', 'name'], ['col:contracts', 'client'], ['col:asbestos', 'client'], ['col:quotes', 'recv']];
// 거르기 표 내용 지문(원장 C174 ⑤ — 판 번호만 맞추면 한쪽 표만 고친 것을 못 잡음): 두 저장소가 같은 차례로 표 내용을 JSON 배열로 늘어놓고 sha256 앞 16자.
//   수집기 rnote.py rules_fp()와 같은 배열이어야 한다 — 받기 때 수집기 지문과 다르면 400 RNOTE_RULES_FP(원천: 표 내용 자체를 견줌). 번호 꼴(PII)은 앱 learn.js piiScan과 수집기 PII_RES가 일부러 다른 구현이라 뺀다.
//   원장 C177 ⓐ: 꼴마다 [글, 대소문자 무시 'i' 또는 ''] — 꼴 글은 같아도 한쪽만 i면 영문 꼴이 한쪽에서만 걸린다.
//   'g'는 파이썬에 없는 개념이라 지문 밖 — 대신 플래그 규칙을 servertest가 따로 지킨다: 지우기(.replace)에 쓰는 CORP_RE·ZW_RE = g 필수(없으면 첫 글자만 지움),
//   검사(.test)에 쓰는 AMOUNT_RES·KEY_RES·MAIL_RE = g·y 금지(lastIndex가 남아 다음 요청에서 놓침), 모든 꼴 m·s·u 금지(수집기와 뜻이 갈림).
//   (파이썬 re.A·JS의 \d·\s 차이는 지문 밖 — 수집기 \d는 유니코드 숫자까지 넓어 더 가리는 쪽이고, \s는 KEY_RES 끝 꼴에서 수집기가 좁아 서버가 더 거절하는 쪽이라 새지 않음)
function rxFp(r) { return [r.source, r.flags.indexOf('i') >= 0 ? 'i' : '']; }
function rulesFp() {
  const arr = [['v', 2], ['name_min', NAME_MIN], ['core_min', CORE_MIN], ['name_skip', Object.keys(NAME_SKIP).sort()], ['corp', rxFp(CORP_RE)], ['zw', rxFp(ZW_RE)], ['join', NAME_JOIN],
    ['name_cols', NAME_COLS], ['client_cols', CLIENT_COLS], ['amount', AMOUNT_RES.map(rxFp)], ['key', KEY_RES.map(rxFp)], ['mail', rxFp(MAIL_RE)]];
  return require('crypto').createHash('sha256').update(JSON.stringify(arr), 'utf8').digest('hex').slice(0, 16);
}
const RULES_FP = rulesFp();

function kstYm(ms) { return new Date(ms + 9 * H).toISOString().slice(0, 7); }
function kstDay(ms) { return new Date(ms + 9 * H).toISOString().slice(0, 10); }
function prevYm(ym) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }
function addYm(ym, n) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); }
function ymOk(ym) { return typeof ym === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(ym); }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function bytes(s) { return Buffer.byteLength(String(s), 'utf8'); }
function normText(s) { return String(s == null ? '' : s).normalize('NFC').replace(ZW_RE, ''); }   // NFC + 폭 없는 문자 지움(검토 11/15 ⑥)

// ---- 걸러낼 이름 — 회원(재직·퇴사 모두)·일용직·운전자 · 거래처. 못 읽으면 null(검사 없이 받지 않음) ----
async function memberNames() {
  const l = await blobList(store(USERS), 'member:');
  if (!l || !l.ok || !Array.isArray(l.keys)) return null;
  const out = [];
  for (const k of l.keys) {
    if (String(k).indexOf('member:') !== 0) continue;
    const r = await blobGet(store(USERS), k);
    if (!r.ok) { if (r.code === 'NOT_FOUND') continue; return null; }
    if (isObj(r.data) && r.data.name) out.push(String(r.data.name).trim());
  }
  return out.length ? out : null;   // 검토 11/15 ⑧: 회원 이름 0명 = 명부를 못 읽은 것으로 본다(검사 없이 받지 않음)
}
async function colNames(cols) {   // 못 읽은 컬렉션이 하나라도 있으면 null · 없는 컬렉션 = 빈 목록
  const out = [];
  for (const [key, field] of cols) {
    const r = await blobGet(store(DATA), key);
    if (!r.ok) { if (r.code === 'NOT_FOUND') continue; return null; }
    const items = isObj(r.data) && Array.isArray(r.data.items) ? r.data.items : [];
    items.forEach(function (x) { if (isObj(x) && x[field]) out.push(String(x[field]).trim()); });
  }
  return out;
}
async function clientNames() { return colNames(CLIENT_COLS); }
async function peopleNames() { const m = await memberNames(); const o = m === null ? null : await colNames(NAME_COLS); return m === null || o === null ? null : m.concat(o); }
// 이름 정리(appdata rnote.py clean_names와 같은 규칙) — 공백 뺀 길이 2 미만·보통 낱말(뒤 숫자 뗀 꼴 포함)·글자 없는 숫자 꼴은 뺌 · client면 법인 표기·공백을 뗀 핵심 이름(3자 이상)도 더함
function skipName(t) {
  const c = t.replace(/\s+/g, '');
  if (c.length < NAME_MIN) return true;
  if (!/[A-Za-z가-힣]/.test(c)) return true;                       // 숫자·기호뿐
  return !!NAME_SKIP[c] || !!NAME_SKIP[c.replace(/[\d._-]+$/, '')] || !!NAME_SKIP[c.toLowerCase()];
}
function cleanNames(list, client) {
  const seen = {}, out = [];
  const add = function (t) { if (!skipName(t) && !seen[t]) { seen[t] = 1; out.push(t); } };
  (list || []).forEach(function (n) {
    const t = normText(n).trim(); if (!t) return;
    add(t);
    if (client) { const core = t.replace(CORP_RE, '').replace(/\s+/g, ''); if (core.length >= CORE_MIN && core !== t) add(core); }
  });
  return out.sort(function (a, b) { return b.length - a.length; });
}
// 이름 하나의 느슨한 꼴 — 글자 사이 공백·쉼표·가운뎃점 허용(appdata rnote.py name_re와 같음) · 공백 뺀 2자 이름은 붙여 쓴 꼴만('이 도구' 같은 보통 글이 두 글자 이름으로 가려지지 않게)
function nameRe(n) {
  const cs = Array.from(n.replace(/\s+/g, '')).map(function (ch) { return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  return new RegExp(cs.join(cs.length >= 3 ? NAME_JOIN : ''), 'i');
}
// 재검사(순수) — 걸린 종류 목록(값 없음). names/clients = cleanNames 결과
function leakKinds(text, names, clients) {
  const s = normText(text), kinds = [];
  const hit = function (list) { return (list || []).some(function (n) { return nameRe(n).test(s); }); };
  if (hit(names)) kinds.push('name');
  if (hit(clients)) kinds.push('client');
  if (AMOUNT_RES.some(function (re) { return re.test(s); })) kinds.push('amount');
  if (!LN.piiScan(s).ok || MAIL_RE.test(s)) kinds.push('pii');
  if (KEY_RES.some(function (re) { return re.test(s); })) kinds.push('key');
  return kinds;
}
async function readDoc(st, period) {   // { ok, doc } — 없음 = doc null · 읽기 실패 = ok false
  const r = await blobGet(st, PREFIX + period);
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, doc: null } : { ok: false };
  return { ok: true, doc: isObj(r.data) ? r.data : null };
}
// 최근 n달 가운데 문서가 있는 달 — { docs: [{ period, status, doc }] 오래된 순, unread: [못 읽은 달] } · 목록 자체를 못 읽으면 null
//   원장 C174 ③: 한 달 문서만 못 읽어도 카드 전체가 실패하던 것 → 그 달만 unread로 빼고 나머지는 보인다(흔적 판정은 unread가 있으면 ok false)
async function recentDocs(nowMs, n) {
  const st = store(DATA), cur = kstYm(nowMs), lo = addYm(cur, -(n || LIST_MONTHS));
  const l = await blobList(st, PREFIX);
  if (!l || !l.ok || !Array.isArray(l.keys)) return null;
  const ps = l.keys.filter(function (k) { return String(k).indexOf(PREFIX) === 0; }).map(function (k) { return String(k).slice(PREFIX.length); }).filter(function (p) { return String(p) && ymOk(p) && p >= lo && p < cur; }).sort();
  const out = [], unread = [];
  for (const p of ps) {
    const r = await readDoc(st, p);
    if (!r.ok) { unread.push(p); continue; }
    if (r.doc) out.push({ period: p, status: r.doc.status === 'confirmed' ? 'confirmed' : 'draft', doc: r.doc });
  }
  return { docs: out, unread: unread };
}
function view(doc) {   // 화면에 내리는 칸 — 봇 원본(bot_text)은 내리지 않는다(학습 재료로 저장만)
  if (!doc) return null;
  return { period: doc.period, status: doc.status, text: String(doc.text || ''), meta: isObj(doc.meta) ? doc.meta : {}, created_at: num(doc.created_at), updated_at: num(doc.updated_at),
    confirmed: isObj(doc.confirmed) ? doc.confirmed : null };
}

// ---- 받기(봇 키는 gw-data가 먼저 본다) ----
async function stampOk(ok, note) { await cronstamp.stamp(STAMP_FN, { state: 'end', ok: ok, note: String(note || '').slice(0, 120) }); }
// 확정 안 된 채 오래된 초안 — 그 달 다음다음 달 4일(KST)부터(만든 달 + 1달 + 3일 창 넘김)
function staleDraft(p, nowMs) { const lim = addYm(p, 2) + '-04'; return kstDay(nowMs) >= lim; }
// 확정 안 된 채 오래된 초안·못 읽은 달 — 흔적 경고 꼬리(rs = recentDocs 결과) · { bad, note }
function warnOf(rs, nowMs) {
  const old = rs.docs.filter(function (x) { return x.status === 'draft' && x.period >= FIRST && staleDraft(x.period, nowMs); }).map(function (x) { return x.period; });
  const note = (old.length ? ' · 확정 안 된 초안 ' + old.join('·') : '') + (rs.unread.length ? ' · 읽지 못한 달 ' + rs.unread.join('·') : '');
  return { bad: !!(old.length || rs.unread.length), note: note };
}
async function dueState(nowMs) {   // 흔적용 — 지난달 문서가 있어야 하는 날인가 + 확정 안 된 채 오래된 초안(검토 11/15 ③)
  const due = prevYm(kstYm(nowMs)), dd = Number(kstDay(nowMs).slice(8, 10));
  const rs = await recentDocs(nowMs, LIST_MONTHS);
  if (rs === null) return { due: due, ok: false, note: '연구노트 문서를 읽지 못함' };
  const w = warnOf(rs, nowMs);
  if (due < FIRST || dd <= 3) return { due: due, ok: !w.bad, note: (due < FIRST ? '첫 회 전(' + FIRST + '분이 첫 회)' : due + '분 만드는 날') + w.note };
  const has = rs.docs.find(function (x) { return x.period === due; });
  return { due: due, ok: !!has && !w.bad, note: (has ? due + '분 있음(' + has.status + ')' : due + '분 초안 없음 — 매월 1~3일 만들기 실패') + w.note };
}
// 원장 C174 ②: 1~3일에는 봇이 ping 대신 묻기·저장을 해 흔적이 늘 ok로 덮였다(오래 미확정 초안 경고가 그 사흘 가려짐) → 잘 된 흔적에도 같은 경고 꼬리를 붙인다
async function stampWarn(note, nowMs) {
  const rs = await recentDocs(nowMs, LIST_MONTHS);
  if (rs === null) { await stampOk(false, note + ' · 연구노트 문서를 읽지 못함'); return; }
  const w = warnOf(rs, nowMs);
  await stampOk(!w.bad, note + w.note);
}
async function put(d, nowMs) {
  const now = nowMs || Date.now();
  // 원장 C177 ⓖ: 판정 글(note — 값·이름 없음)도 돌려준다 — 봇 로그가 due_ok만 보고 '있음'이라 적어 '첫 회 전'을 '문서 있음'으로 읽히게 했다
  if (d.ping === true) { const s = await dueState(now); await stampOk(s.ok, s.note); return { code: 200, body: { status: 'OK', ping: true, due: s.due, due_ok: s.ok, note: String(s.note || '').slice(0, 120) } }; }
  const period = String(d.period || '');
  if (!ymOk(period) || period >= kstYm(now)) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };   // 지난달까지만
  if (d.fail !== undefined) {   // 봇이 거르기·재료에서 멈춤 — 사유 코드만(글은 받지 않음)
    const code = String(d.fail || '');
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code) || d.text !== undefined) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_FAIL' } };
    await stampOk(false, period + '분 만들기 멈춤 ' + code);
    return { code: 200, body: { status: 'OK', recorded: true } };
  }
  const st = store(DATA), key = PREFIX + period;
  // 검토 11/15 ①: 있는지 먼저 — 1일에 저장한 달을 2·3일에 다시 보낼 때 재검사·명부 읽기 실패로 흔적·작업이 잘못 실패하지 않게
  const r = await readDoc(st, period);
  if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_READ_FAILED' } };
  if (d.probe === true) {   // 묻기만(글 없음) — 수집기가 1~3일에 만들기 전에
    if (d.text !== undefined) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PROBE' } };
    if (r.doc) await stampWarn(period + '분 이미 있음(' + r.doc.status + ')', now);
    return { code: 200, body: { status: 'OK', probe: true, exists: !!r.doc, doc_status: r.doc ? r.doc.status : '' } };
  }
  if (r.doc) {
    if (r.doc.status === 'confirmed') {
      if (d.force === true) return { code: 409, body: { status: 'CONFLICT', error_code: 'RNOTE_CONFIRMED' } };   // 요원이 확정한 달은 봇이 못 덮음
      await stampWarn(period + '분 이미 있음(확정)', now);
      return { code: 200, body: { status: 'OK', exists: true, doc_status: 'confirmed' } };
    }
    if (d.force !== true) { await stampWarn(period + '분 이미 있음(초안)', now); return { code: 200, body: { status: 'OK', exists: true, doc_status: 'draft' } }; }
  }
  if (String(d.rules_ver || '') !== RULES_VER) { await stampOk(false, period + '분 받기 거절 — 규칙 판 다름(수집기 ' + String(d.rules_ver || '없음').slice(0, 20) + ' · 앱 ' + RULES_VER + ')'); return { code: 400, body: { status: 'REJECTED', error_code: 'RNOTE_RULES_VER', want: RULES_VER } }; }
  if (String(d.rules_fp || '') !== RULES_FP) { await stampOk(false, period + '분 받기 거절 — 거르기 표 내용 다름(수집기 ' + String(d.rules_fp || '없음').slice(0, 16) + ' · 앱 ' + RULES_FP + ')'); return { code: 400, body: { status: 'REJECTED', error_code: 'RNOTE_RULES_FP', want: RULES_FP } }; }
  if (typeof d.text !== 'string' || !d.text.trim()) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_TEXT' } };
  if (bytes(d.text) > TEXT_MAX) return { code: 413, body: { status: 'REJECTED', error_code: 'TOO_LARGE', max: TEXT_MAX } };
  const meta = d.meta === undefined ? {} : d.meta;
  if (!isObj(meta) || bytes(JSON.stringify(meta)) > META_MAX) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_META' } };
  const nm = await peopleNames(), cn = await clientNames();
  if (nm === null || cn === null) { await stampOk(false, period + '분 받기 보류 — 명부·거래처를 못 읽음'); return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_NAMES_UNAVAILABLE' } }; }
  const kinds = leakKinds(d.text + '\n' + JSON.stringify(meta), cleanNames(nm, false), cleanNames(cn, true));
  if (kinds.length) { await stampOk(false, period + '분 받기 거절 — 서버 재검사 ' + kinds.join('·')); return { code: 400, body: { status: 'REJECTED', error_code: 'RNOTE_LEAK', kinds: kinds } }; }
  const doc = { schema: 1, period: period, status: 'draft', text: d.text, bot_text: d.text, bot_at: now, meta: meta, rules_ver: RULES_VER,
    created_at: r.doc ? num(r.doc.created_at) || now : now, updated_at: Math.max(now, r.doc ? num(r.doc.updated_at) + 1 : 0), confirmed: null, by: 'bot' };
  const w = await blobSet(st, key, doc);
  if (!w || !w.ok) { await stampOk(false, period + '분 저장 실패'); return { code: 500, body: { status: 'ERROR', error_code: 'RNOTE_WRITE_FAILED' } }; }
  await stampWarn(period + '분 초안 저장' + (r.doc ? '(다시 만듦)' : ''), now);
  return { code: 200, body: { status: 'OK', saved: true, period: period, replaced: !!r.doc } };
}

// ---- 읽기 · 확정(관문은 gw-data pmconGate — 읽기 관리자 · 확정 PM) ----
// period 없음 = 최근 12달 목록 + 가장 오래된 확정 전 초안(doc) + 가장 최근 확정본(latest) · period 있음 = 그 달 문서(doc)
async function get(d, canWrite, nowMs) {
  const now = nowMs || Date.now();
  const hasP = d && d.period !== undefined && d.period !== null && d.period !== '';
  if (hasP && !ymOk(String(d.period))) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };
  const rs = await recentDocs(now, LIST_MONTHS);
  if (rs === null) return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_READ_FAILED' } };
  const months = rs.docs.map(function (x) { return { period: x.period, status: x.status }; });
  let doc = null, period = '';
  if (hasP) {
    period = String(d.period);
    const r = await readDoc(store(DATA), period);
    if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_READ_FAILED' } };
    doc = r.doc;
  } else {
    const p = rs.docs.find(function (x) { return x.status === 'draft'; });   // 오래된 순 첫 초안
    if (p) { doc = p.doc; period = p.period; }
  }
  const lc = rs.docs.filter(function (x) { return x.status === 'confirmed'; }).pop() || null;
  return { code: 200, body: { status: 'OK', period: period, doc: view(doc), latest: lc ? view(lc.doc) : null, months: months, unread: rs.unread, can_write: !!canWrite } };
}
// [확인] = 글 없이(지금 글 그대로 확정) · [고침] = text(고친 글로 확정). 봇 원본 bot_text는 그대로 남아 판33 학습 짝(원본 ↔ 확정본)이 된다.
async function save(d, member, nowMs) {
  const now = nowMs || Date.now();
  const period = ymOk(String((d && d.period) || '')) ? String(d.period) : null;
  if (!period) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };
  const hasText = d.text !== undefined && d.text !== null;
  if (hasText && (typeof d.text !== 'string' || !d.text.trim())) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_TEXT' } };
  if (hasText && bytes(d.text) > TEXT_MAX) return { code: 413, body: { status: 'REJECTED', error_code: 'TOO_LARGE', max: TEXT_MAX } };
  const st = store(DATA), key = PREFIX + period;
  const r = await readDoc(st, period);
  if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_READ_FAILED' } };
  if (!r.doc) return { code: 404, body: { status: 'REJECTED', error_code: 'RNOTE_NONE' } };
  const doc = r.doc;
  if (d.base === undefined || num(d.base) !== num(doc.updated_at)) return { code: 409, body: { status: 'CONFLICT', error_code: 'RNOTE_STALE' } };
  if (doc.status === 'confirmed') return { code: 400, body: { status: 'REJECTED', error_code: 'RNOTE_CONFIRMED' } };
  const before = String(doc.text || '');
  const text = hasText ? d.text : before;
  const edited = text !== before;
  const name = String(member.name || '').slice(0, 20);
  if (typeof doc.bot_text !== 'string') doc.bot_text = before;   // 옛 문서 보호 — 원본 칸이 없으면 지금 글을 원본으로
  doc.text = text; doc.status = 'confirmed';
  doc.confirmed = { ts: now, by: member.id, name: name, edited: edited };
  doc.updated_at = Math.max(now, num(doc.updated_at) + 1);
  const w = await blobSet(st, key, doc);
  if (!w || !w.ok) return { code: 500, body: { status: 'ERROR', error_code: 'RNOTE_WRITE_FAILED' } };
  let au = false;
  try { au = (await AUDIT.appendAudit({ ts: now, by: member.name, bid: member.id, col: 'rnote', ev: [{ op: edited ? '연구노트고침' : '연구노트확정', id: key, t: period + (edited ? ' 고친 글로 확정' : ' 초안 그대로 확정') + ' · ' + text.length + '자' }] })) !== false; } catch (e) { au = false; }
  return { code: 200, body: { status: 'OK', period: period, doc: view(doc), audit: au } };
}

module.exports = { PREFIX, FIRST, STAMP_FN, RULES_VER, RULES_FP, rulesFp, TEXT_MAX, META_MAX, LIST_MONTHS, AMOUNT_RES, KEY_RES, MAIL_RE, CORP_RE, ZW_RE, NAME_COLS, CLIENT_COLS, kstYm, prevYm, addYm, ymOk, normText, skipName, cleanNames, nameRe, leakKinds, memberNames, peopleNames, clientNames, recentDocs, staleDraft, dueState, put, get, save, view };
