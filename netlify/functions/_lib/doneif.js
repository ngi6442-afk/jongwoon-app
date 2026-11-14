'use strict';
// 공통 done_if 워커 라이브러리(공통 기반 2, v397 — 업무별 최적화 설계 3-14 appr A3ⓑ·A4 · 착수 브리핑 A5). 순수 함수 — servertest 절 51 대상.
// 데이터 사건(신호) → 열린 자동 지시를 '승인 대기(review)·done_by 앱 기준'으로만 올린다(done 자동 종결 아님 — 카드 1-5 추천안, 규정 §6② 개정 불요).
// 신호 3종(v397): 차량 정기검사·보험 만기가 카드 기한보다 뒤로 갱신 / 인허가 만료·보수교육 기한이 뒤로 갱신 / 미수 청구가 입금(paid).
// 증명서(cert:) 3종 올림 신호(P1 판19 · 원장 T359 — A5 2일차): 아래 '증명서 3종' 절. 적격(bid:)은 입찰 도메인 P2.
// 손대지 않는 것: 사람이 완료 체크한 review(done_by 실명) · done · 삭제 · 승인권자가 반려해 신호를 끈 항목(doneif_off=1) · 자동 지시 아닌 것.
const crypto = require('crypto');
const AR = require('./autorules');   // v417 카드 10 ⑤ 완료 신호 2종(site·wk 월 키 — 다음 회차 미입력 0) — 집계 함수를 서버 autotask_facts와 공유

const DONEIF_KEY = 'settings:doneif';   // {schema:1, on:false, prev:{on}, updated_at, updated_by} — 기본 꺼짐 = dry-run(계획만 기록)
const DONEIF_LAST = 'it:doneif:last';    // 마지막 점검 {ts, today, on, scanned, candidates[≤50], moved, notified}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function parseKey(k) {   // 'veh:<id>:insp:<due>' · 'veh:<id>:ins:<due>' · 'lic:<id>:exp:<due>' · 'lic:<id>:edu:<due>' · 'rec:<id>:over45'
  const p = String(k || '').split(':');
  if (p[0] === 'veh' && p.length >= 4) return { dom: 'veh', col: 'vehicles', id: p[1], kind: p[2], due: p[3] };
  if (p[0] === 'lic' && p.length >= 4) return { dom: 'lic', col: 'licenses', id: p[1], kind: p[2], due: p[3] };
  if (p[0] === 'rec' && p.length >= 3) return { dom: 'rec', col: 'receivables', id: p[1], kind: p[2] };
  if (p[0] === 'site' && p[1] === 'missing' && p.length >= 3) return { dom: 'site', col: 'asbestos', id: '', kind: 'missing', ym: p[2] };   // v417 카드 10
  if (p[0] === 'wk' && p[1] === 'missing' && p.length >= 3) return { dom: 'wk', col: 'workers', id: '', kind: 'missing', ym: p[2] };
  if (p[0] === 'cert' && p.length === 2 && /^c\d{1,6}$/.test(p[1])) return { dom: 'cert', col: 'proof', id: '', kind: 'cycle', cyc: Number(p[1].slice(1)) };   // P1 판19 — 키 꼴은 gw-data AUTOTASK_KEY_RE.cert와 같다
  return null;
}

// ---- 증명서 3종 올림 신호(P1 판19 · T359) ----
// 지시: cert:c<n> = 20일 주기 '증명서 갱신 발급 — 납세·지방세·4대보험 완납증명'(index.html runAutoTaskGen — 기준일 2026-01-01, n = 지난 일수/20, 기한 = 다음 회차 첫날).
// 3종 = 국세 납세증명(홈택스) · 지방세 납세증명(위택스) · 4대(사회)보험 완납증명(정부24) — 같은 지시 detail · FEATURES.md '증명서 갱신 루틴' · 업무별 설계 3-14 appr A3ⓑ.
// 원천: 지시 본문이 올리라는 '적격심사 증빙 보관함'(gw_files proof:<이름> + 색인 proof:__index__) — 문서함은 기한 있는 실물 증빙을 받지 않는다(9/4 규칙, 오케스트레이터 11/14 결정).
//   크론은 색인 한 개만 읽는다(파일 본문 안 읽음): {names:[이름], meta:{이름:{ts 서버 올린 시각, file 원래 이름, by_id}}} — meta는 판19부터 proof_put이 남긴다(시각 없는 옛 항목은 안 셈, 이행 없음).
//   보관함엔 종류별 자리·발급일·만료일 칸이 없어 종류는 원래 이름(file)으로만 가르고, 회차 판정은 올린 시각으로 한다.
// 넘기지 않는 쪽으로 닫는 경우(사람이 [완료]): 색인 읽기 실패·없음·깨진 꼴 · 3종 중 하나라도 없음 · 회차 시작(기준일 + n×20일)·지시 만든 날(created) 이전에 올린 항목 ·
//   지운 항목(names에서 빠짐 — meta만 남아도 안 셈) · 시각 메타 없는 옛 항목 · pdf 아닌 항목(사진·스캔 그림) · 한 이름이 두 종류 이상에 걸림 ·
//   한 항목이 열린 증명서 지시 둘 이상에 걸림(회차 겹침) · 깨진 메타(ts·file·by_id) · 미래 시각(서버 +10분 초과) · 지시 만든 날 칸이 날짜가 아님.
const CERT_EPOCH_MS = Date.parse('2026-01-01T00:00:00+09:00');   // 앱 생성기 기준일(KST 자정 — 앱은 기기 현지 시각, 운영 기기 = KST)
const CERT_CYCLE_MS = 20 * 86400000;
const CERT_KINDS = [   // 이름 판정 — 한 파일이 정확히 한 종류에만 맞아야 센다(라벨은 why·화면 후보 요약에 나감 — 파일 이름은 내보내지 않는다)
  { k: 'nat', label: '국세', ok: function (s) { return /(납세|국세\s*완납)\s*증명/.test(s) && !/지방세/.test(s) && !/보험/.test(s); } },
  { k: 'loc', label: '지방세', ok: function (s) { return /지방세/.test(s) && /(납세|완납)/.test(s) && /증명/.test(s); } },
  { k: 'soc', label: '4대보험', ok: function (s) { return /(4대|사회)\s*(사회\s*)?보험/.test(s) && /완납/.test(s) && /증명/.test(s); } },
];
function kstDayStartMs(day) { return isDate(day) ? Date.parse(day + 'T00:00:00+09:00') : NaN; }
function certKindOf(name) {
  const s = String(name || '');
  if (!/\.pdf$/i.test(s)) return '';
  const hit = CERT_KINDS.filter(function (c) { return c.ok(s); });
  return hit.length === 1 ? hit[0].k : '';
}
// 열린(자격 있는) 증명서 지시 → [{id, start}] — start = max(회차 시작, 만든 날 KST 자정). 만든 날이 날짜가 아니면 목록에서 빠지고 신호도 없다
function certOpenList(tasks) {
  const out = [];
  (tasks || []).forEach(function (t) {
    if (!eligible(t)) return;
    const k = parseKey(t.auto_key);
    if (!k || k.dom !== 'cert') return;
    const c0 = kstDayStartMs(t.created);
    if (!isFinite(c0)) return;
    out.push({ id: t.id, start: Math.max(CERT_EPOCH_MS + k.cyc * CERT_CYCLE_MS, c0) });
  });
  return out;
}
function certSignal(task, k, recs) {
  const idx = recs && recs.__rows ? recs.__rows.proof : null;
  if (!idx || typeof idx !== 'object' || !Array.isArray(idx.names)) return { ok: false, why: 'no_proof' };   // 읽기 실패·없음·깨진 꼴 = 신호 없음
  const meta = (idx.meta && typeof idx.meta === 'object' && !Array.isArray(idx.meta)) ? idx.meta : {};
  const open = recs.__certOpen;
  if (!Array.isArray(open)) return { ok: false, why: 'cert.no_ctx' };
  const me = open.find(function (o) { return o && o.id === task.id; });
  if (!me) return { ok: false, why: 'cert.no_created' };
  const now = Number(recs.__now) || 0;
  const have = {}, seen = {};
  idx.names.forEach(function (n) {
    if (typeof n !== 'string' || !n || seen[n] || !Object.prototype.hasOwnProperty.call(meta, n)) return;   // 지운 항목은 names에 없어 여기 안 옴 · 시각 메타 없는 옛 항목 = 안 셈
    seen[n] = 1;
    const m = meta[n];
    if (!m || typeof m !== 'object') return;
    const ts = m.ts;
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0 || typeof m.file !== 'string' || typeof m.by_id !== 'string' || !m.by_id) return;
    if (now && ts > now + 600000) return;   // 서버 시각보다 10분 넘게 앞선 항목 = 깨진 값
    const kind = certKindOf(m.file);
    if (!kind) return;
    const hits = open.filter(function (o) { return ts >= o.start; });
    if (hits.length !== 1 || hits[0].id !== task.id) return;   // 지시 전 올림(0건)·회차 겹침(2건 이상)·다른 지시 몫
    have[kind] = 1;
  });
  const miss = CERT_KINDS.filter(function (c) { return !have[c.k]; });
  if (miss.length) return { ok: false, why: 'cert.missing ' + miss.map(function (c) { return c.label; }).join('·') };
  return { ok: true, why: 'cert.c' + k.cyc + ' ' + CERT_KINDS.map(function (c) { return c.label; }).join('·') };
}

function eligible(t) {
  return !!(t && t.auto_key && t.del !== 1 && (t.status === 'open' || t.status === 'hold') && !t.doneif_off);
}

// 신호 판정. recs = {vehicles:{id:레코드}, licenses:{...}, receivables:{...}}. 반환 {ok, why}
function signalFor(task, recs) {
  const k = parseKey(task && task.auto_key);
  if (!k) return { ok: false, why: 'unknown_key' };
  if (k.dom === 'site' || k.dom === 'wk') {   // v417 카드 10 ⑤: 월 지시는 레코드 1건이 아니라 집계 — 다음 회차 미입력 0이면 신호(recs.__rows = 원본 행 배열, 크론이 싣는다)
    const rows = (recs && recs.__rows) || {};
    if (!Array.isArray(rows.asbestos)) return { ok: false, why: 'no_rows' };
    if (k.dom === 'site') { const n = AR.siteMissing(rows.asbestos).count; return n === 0 ? { ok: true, why: 'site.missing 0' } : { ok: false, why: 'site.missing ' + n }; }
    if (!Array.isArray(rows.workers)) return { ok: false, why: 'no_rows' };
    const n2 = AR.wkMissing(rows.workers, rows.asbestos).birth_blank;
    return n2 === 0 ? { ok: true, why: 'wk.birth_blank 0' } : { ok: false, why: 'wk.birth_blank ' + n2 };
  }
  if (k.dom === 'cert') return certSignal(task, k, recs);   // P1 판19 — recs.__rows.proof(증빙 보관함 색인, 읽기 실패 = null) · recs.__certOpen(plan이 싣는다)
  const rec = ((recs || {})[k.col] || {})[k.id];
  if (!rec) return { ok: false, why: 'no_record' };
  if (k.dom === 'veh' || k.dom === 'lic') {
    const f = k.dom === 'veh' ? (k.kind === 'insp' ? 'insp_due' : (k.kind === 'ins' ? 'ins_due' : null))
                              : (k.kind === 'exp' ? 'expiry' : (k.kind === 'edu' ? 'edu_due' : null));
    if (!f) return { ok: false, why: 'unknown_kind' };
    const cur = rec[f];
    if (isDate(cur) && isDate(k.due) && cur > k.due) return { ok: true, why: k.dom + '.' + f + ' ' + k.due + '→' + cur };
    return { ok: false, why: 'not_renewed' };
  }
  if (k.dom === 'rec') {
    if (rec.paid) return { ok: true, why: 'rec.paid ' + String(rec.paid).slice(0, 10) };
    return { ok: false, why: 'unpaid' };
  }
  return { ok: false, why: 'unknown_dom' };
}

// 전환 계획: 자격 있는 자동 지시 중 신호가 켜진 것
function plan(tasks, recs) {
  const candidates = []; let scanned = 0;
  const ctx = Object.assign({}, recs || {});
  ctx.__certOpen = certOpenList(tasks);   // P1 판19: 증명서 첨부 한 건이 어느 회차 몫인지(겹치면 아무 지시에도 안 셈)는 열린 증명서 지시 전체를 봐야 안다
  (tasks || []).forEach(function (t) {
    if (!eligible(t)) return;
    scanned++;
    const s = signalFor(t, ctx);
    if (s.ok) candidates.push({ id: t.id, title: String(t.title || '').slice(0, 60), who_id: t.who_id || '', from_id: t.from_id || '', why: s.why });
  });
  return { candidates: candidates, scanned: scanned };
}

// 적용: review · done_at · done_by '앱 기준' · done_src. 바뀐 수 반환. 다시 자격 검사(계획 뒤 바뀐 항목 보호)
function apply(tasks, candidates, today) {
  const by = {}; (candidates || []).forEach(function (c) { by[c.id] = c; });
  let n = 0;
  (tasks || []).forEach(function (t) {
    const c = t && by[t.id];
    if (!c || !eligible(t)) return;
    t.status = 'review'; t.done_at = today; t.done_by = '앱 기준'; t.done_src = 'doneif:' + String(c.why).slice(0, 60); t.updated = today;
    n++;
  });
  return n;
}

// 변경 기록 clog:appr:<YYYY-MM> — append-only·해시 체인(규약 clog:<domain>:<YYYY-MM>). 값은 필드·사유만(PII 없음)
// 상한 CLOG_MAX줄 — 넘으면 앞을 잘라 첫 줄 p가 ''가 아닐 수 있다(gw-data backup_put 재해 복원 병합이 같은 상한·느슨한 시작 검사를 쓴다 — v453 검토)
const CLOG_MAX = 5000;
function clogAppend(doc, entry) {
  const d = (doc && Array.isArray(doc.items)) ? doc : { schema: 1, items: [], head: '' };
  const prev = d.head || '';
  const h = crypto.createHash('sha256').update(prev + '|' + JSON.stringify(entry)).digest('hex').slice(0, 16);
  d.items.push(Object.assign({ h: h, p: prev }, entry));
  d.head = h;
  if (d.items.length > CLOG_MAX) d.items = d.items.slice(-CLOG_MAX);
  return d;
}

function byId(items) { const o = {}; (items || []).forEach(function (x) { if (x && x.id && x.del !== 1) o[x.id] = x; }); return o; }

module.exports = { DONEIF_KEY, DONEIF_LAST, isDate, parseKey, eligible, signalFor, plan, apply, clogAppend, CLOG_MAX, byId, CERT_EPOCH_MS, CERT_CYCLE_MS, CERT_KINDS, certKindOf, certOpenList };
