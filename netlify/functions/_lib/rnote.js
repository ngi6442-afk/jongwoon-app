'use strict';
// P1 판21 KOITA 연구노트 월 자동 초안(착수설명서 판21 · 원장 T759·C099) — 받기·읽기·확정은 이 파일 한 곳, gw-data는 관문·디스패치 연결만.
//   만드는 쪽 = appdata collectors/rnote.py(GitHub Actions cron-backup.yml 'rnote' 작업 — 매일 08:20 KST 기동, 만들기는 KST 1~3일, 그 밖의 날은 흔적만).
//   달마다 문서 1개 'rnote:YYYY-MM'(gw_data — 야간 백업 대상):
//     { schema, period, status 'draft'|'confirmed', text(지금 글 — 확정 뒤엔 확정본), bot_text(봇 원본 — 바뀌지 않음, 판33 학습 짝 재료), bot_at, meta, created_at, updated_at, confirmed:{ts,by,name,edited} }
//   받기 rnote_put = 봇 키(gw-data botKeyOk — 다른 봇 받기와 같은 상수시간 비교) — 크기 상한 · 달 꼴(지난달까지만) · 서버 재검사(회원 실명·거래처 이름·금액·주민/전화/계좌 꼴·키 꼴)에
//     하나라도 걸리면 400 RNOTE_LEAK(값은 응답·로그에 없음 — 종류만) · 명부·거래처를 못 읽으면 503(검사 없이 받지 않음) · 같은 달이 있으면 덮지 않고 exists(force는 초안일 때만 · 확정된 달은 409)
//     ping = 흔적만(만들지 않는 날) · fail = 봇이 거르기에서 멈춘 사유 코드만(글 없음) — 둘 다 흔적 it:cron:rnote:last를 남겨 appdata watch.py(cron_map 'rnote' stamp)가 본다.
//   읽기 rnote_get · 확정 rnote_save = gw-data 판29 pmconGate 읽기(로그인 → 기기 승인 → 관리자 — 요원 = PM은 관리자) · 확정은 [확인](글 그대로) 또는 [고침](고친 글) — 감사 1줄(col rnote).
//   새 푸시 없음(PM 콘솔 카드만).
const { store, blobGet, blobSet, blobList } = require('./blobs');
const AUDIT = require('./audit');
const LN = require('./learn');
const CL = require('./claude');
const cronstamp = require('./cronstamp');

const DATA = 'gw_data', USERS = 'gw_users';
const PREFIX = 'rnote:';             // 'rnote:YYYY-MM'
const FIRST = '2026-11';             // 첫 자동 달(12/1이 11월분을 만듦) — 그 앞 달은 흔적 판정에서 '빠짐'으로 치지 않는다
const STAMP_FN = 'rnote';            // it:cron:rnote:last
const TEXT_MAX = 200000;             // 글 상한(UTF-8 바이트) — 한 달 커밋 수백 줄 기준 넉넉히, Netlify 본문 6MB 한도 아래
const META_MAX = 4000;               // meta JSON 상한(바이트)
const NAME_MIN = 2;                  // 이보다 짧은 이름은 검사하지 않는다(한 글자 오탐)
// appdata rnote.py NAME_SKIP과 같음 — 이름 칸에 든 낱말(시험 입력 '테스트'가 커밋 제목 '회귀 테스트'를 거절시키지 않게) · 가림 표시 글자((직원)·(거래처)·(금액)·(번호))와 직함(가린 글이 늘 걸리지 않게)
const NAME_SKIP = { '개인': 1, '기타': 1, '미정': 1, '없음': 1, '본사': 1, '현장': 1, '테스트': 1, '시험': 1, test: 1, '직원': 1, '거래처': 1, '금액': 1, '번호': 1, '관리자': 1, '대표': 1, '운영부': 1, '관리부': 1 };
const H = 3600000;
// 금액 꼴 — 숫자 + 원·만원·억(원) · ₩숫자 · KRW (원 뒤 원장·원본·원문·원칙·원인·원천 같은 낱말은 금액 아님) — appdata rnote.py AMOUNT_RES와 같은 꼴
const AMOUNT_RES = [
  /\d[\d,]*(?:\.\d+)?\s*(?:억|천만|백만|만|천)?\s*원(?![장본문칙인천점래격자형리단])/,
  /\d[\d,]*(?:\.\d+)?\s*억/,
  /\d[\d,]*\s*만\s*원/,
  /₩\s*\d/,
  /\d[\d,]*\s*KRW/i,
  /[일이삼사오육칠팔구십백천]+\s*(?:억|만)\s*원/,
];
// 키·토큰 꼴 — appdata rnote.py KEY_RES와 같은 꼴(값이 아니라 꼴만 본다)
const KEY_RES = [
  /sk-[A-Za-z0-9_-]{16,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/,
  /(?<![\w/+-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![\w-])/,
  /\b(?:api[_-]?key|key|token|secret|password|passwd|pwd|oc)\s*[=:]\s*[^\s,;]{6,}/i,
];

function kstYm(ms) { return new Date(ms + 9 * H).toISOString().slice(0, 7); }
function kstDay(ms) { return new Date(ms + 9 * H).toISOString().slice(0, 10); }
function prevYm(ym) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }
function ymOk(ym) { return typeof ym === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(ym); }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function bytes(s) { return Buffer.byteLength(String(s), 'utf8'); }

// ---- 걸러낼 이름 — 회원(재직·퇴사 모두)·거래처. 못 읽으면 null(검사 없이 받지 않음) ----
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
  return out;
}
// 사람 이름 = 회원 + 아래 칸(일용직·차량 운전자) · 거래처 이름 = 아래 칸 — appdata rnote.py NAME_COLS·CLIENT_COLS와 같은 표(봇이 가린 곳을 서버가 다시 본다)
const NAME_COLS = [['col:workers', 'name'], ['col:vehicles', 'driver']];
const CLIENT_COLS = [['col:clients', 'name'], ['col:contracts', 'client'], ['col:asbestos', 'client'], ['col:quotes', 'recv']];
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
function cleanNames(list) {
  const seen = {}, out = [];
  (list || []).forEach(function (n) { const t = String(n || '').trim(); if (t.length >= NAME_MIN && !NAME_SKIP[t] && !seen[t]) { seen[t] = 1; out.push(t); } });
  return out.sort(function (a, b) { return b.length - a.length; });
}
// 재검사(순수) — 걸린 종류 목록(값 없음). names/clients = 정리된 이름 목록
function leakKinds(text, names, clients) {
  const s = String(text || ''), flat = s.replace(/\s+/g, ''), kinds = [];
  const hitName = function (list) { return (list || []).some(function (n) { return s.indexOf(n) >= 0 || flat.indexOf(n.replace(/\s+/g, '')) >= 0 || !CL.scrubPayload(s, [n]).ok; }); };
  if (hitName(names)) kinds.push('name');
  if (hitName(clients)) kinds.push('client');
  if (AMOUNT_RES.some(function (re) { return re.test(s); })) kinds.push('amount');
  if (!LN.piiScan(s).ok) kinds.push('pii');
  if (KEY_RES.some(function (re) { return re.test(s); })) kinds.push('key');
  return kinds;
}
async function readDoc(st, period) {   // { ok, doc } — 없음 = doc null · 읽기 실패 = ok false
  const r = await blobGet(st, PREFIX + period);
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, doc: null } : { ok: false };
  return { ok: true, doc: isObj(r.data) ? r.data : null };
}
function view(doc) {   // 화면에 내리는 칸 — 봇 원본(bot_text)은 내리지 않는다(학습 재료로 저장만)
  if (!doc) return null;
  return { period: doc.period, status: doc.status, text: String(doc.text || ''), meta: isObj(doc.meta) ? doc.meta : {}, created_at: num(doc.created_at), updated_at: num(doc.updated_at),
    confirmed: isObj(doc.confirmed) ? doc.confirmed : null };
}

// ---- 받기(봇 키는 gw-data가 먼저 본다) ----
async function stampOk(ok, note) { await cronstamp.stamp(STAMP_FN, { state: 'end', ok: ok, note: String(note || '').slice(0, 120) }); }
async function dueState(nowMs) {   // 흔적용 — 지난달 문서가 있어야 하는 날인가(첫 자동 달 앞·1~3일 창 안은 기다림)
  const due = prevYm(kstYm(nowMs)), dd = Number(kstDay(nowMs).slice(8, 10));
  if (due < FIRST || dd <= 3) return { due: due, ok: true, note: due < FIRST ? '첫 회 전(' + FIRST + '분이 첫 회)' : due + '분 만드는 날' };
  const r = await readDoc(store(DATA), due);
  if (!r.ok) return { due: due, ok: false, note: due + '분 문서를 읽지 못함' };
  return { due: due, ok: !!r.doc, note: r.doc ? due + '분 있음(' + r.doc.status + ')' : due + '분 초안 없음 — 매월 1~3일 만들기 실패' };
}
async function put(d, nowMs) {
  const now = nowMs || Date.now();
  if (d.ping === true) { const s = await dueState(now); await stampOk(s.ok, s.note); return { code: 200, body: { status: 'OK', ping: true, due: s.due, due_ok: s.ok } }; }
  const period = String(d.period || '');
  if (!ymOk(period) || period >= kstYm(now)) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };   // 지난달까지만(이번 달·앞날은 아직 덜 찬 달)
  if (d.fail !== undefined) {   // 봇이 거르기·재료에서 멈춤 — 사유 코드만(글은 받지 않음)
    const code = String(d.fail || '');
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code) || d.text !== undefined) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_FAIL' } };
    await stampOk(false, period + '분 만들기 멈춤 ' + code);
    return { code: 200, body: { status: 'OK', recorded: true } };
  }
  if (typeof d.text !== 'string' || !d.text.trim()) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_TEXT' } };
  if (bytes(d.text) > TEXT_MAX) return { code: 413, body: { status: 'REJECTED', error_code: 'TOO_LARGE', max: TEXT_MAX } };
  const meta = d.meta === undefined ? {} : d.meta;
  if (!isObj(meta) || bytes(JSON.stringify(meta)) > META_MAX) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_META' } };
  const nm = await peopleNames(), cn = await clientNames();
  if (nm === null || cn === null) { await stampOk(false, period + '분 받기 보류 — 명부·거래처를 못 읽음'); return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_NAMES_UNAVAILABLE' } }; }
  const kinds = leakKinds(d.text + '\n' + JSON.stringify(meta), cleanNames(nm), cleanNames(cn));
  if (kinds.length) { await stampOk(false, period + '분 받기 거절 — 서버 재검사 ' + kinds.join('·')); return { code: 400, body: { status: 'REJECTED', error_code: 'RNOTE_LEAK', kinds: kinds } }; }
  const st = store(DATA), key = PREFIX + period;
  const r = await readDoc(st, period);
  if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_READ_FAILED' } };
  if (r.doc) {
    if (r.doc.status === 'confirmed') {
      if (d.force === true) return { code: 409, body: { status: 'CONFLICT', error_code: 'RNOTE_CONFIRMED' } };   // 요원이 확정한 달은 봇이 못 덮음
      await stampOk(true, period + '분 이미 있음(확정)');
      return { code: 200, body: { status: 'OK', exists: true, doc_status: 'confirmed' } };
    }
    if (d.force !== true) { await stampOk(true, period + '분 이미 있음(초안)'); return { code: 200, body: { status: 'OK', exists: true, doc_status: 'draft' } }; }
  }
  const doc = { schema: 1, period: period, status: 'draft', text: d.text, bot_text: d.text, bot_at: now, meta: meta,
    created_at: r.doc ? num(r.doc.created_at) || now : now, updated_at: Math.max(now, r.doc ? num(r.doc.updated_at) + 1 : 0), confirmed: null, by: 'bot' };
  const w = await blobSet(st, key, doc);
  if (!w || !w.ok) { await stampOk(false, period + '분 저장 실패'); return { code: 500, body: { status: 'ERROR', error_code: 'RNOTE_WRITE_FAILED' } }; }
  await stampOk(true, period + '분 초안 저장' + (r.doc ? '(다시 만듦)' : ''));
  return { code: 200, body: { status: 'OK', saved: true, period: period, replaced: !!r.doc } };
}

// ---- 읽기 · 확정(관문은 gw-data pmconGate 읽기 — 관리자) ----
function periodOf(d, nowMs) {
  if (d && d.period !== undefined && d.period !== null && d.period !== '') return ymOk(String(d.period)) ? String(d.period) : null;
  return prevYm(kstYm(nowMs));
}
async function get(d, nowMs) {
  const period = periodOf(d, nowMs || Date.now());
  if (!period) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };
  const r = await readDoc(store(DATA), period);
  if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'RNOTE_READ_FAILED' } };
  return { code: 200, body: { status: 'OK', period: period, doc: view(r.doc), can_write: true } };
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

module.exports = { PREFIX, FIRST, STAMP_FN, TEXT_MAX, META_MAX, AMOUNT_RES, KEY_RES, NAME_COLS, CLIENT_COLS, kstYm, prevYm, ymOk, cleanNames, leakKinds, memberNames, peopleNames, clientNames, dueState, put, get, save, view };
