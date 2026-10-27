'use strict';
// 공통 done_if 워커 라이브러리(공통 기반 2, v397 — 업무별 최적화 설계 3-14 appr A3ⓑ·A4 · 착수 브리핑 A5). 순수 함수 — servertest 절 51 대상.
// 데이터 사건(신호) → 열린 자동 지시를 '승인 대기(review)·done_by 앱 기준'으로만 올린다(done 자동 종결 아님 — 카드 1-5 추천안, 규정 §6② 개정 불요).
// 신호 3종(v397): 차량 정기검사·보험 만기가 카드 기한보다 뒤로 갱신 / 인허가 만료·보수교육 기한이 뒤로 갱신 / 미수 청구가 입금(paid).
// 증명서(cert:) 3종 업로드 신호는 문서함 첨부 분류 메타 실측 뒤(A5 2일차). 적격(bid:)은 입찰 도메인 P2.
// 손대지 않는 것: 사람이 완료 체크한 review(done_by 실명) · done · 삭제 · 승인권자가 반려해 신호를 끈 항목(doneif_off=1) · 자동 지시 아닌 것.
const crypto = require('crypto');

const DONEIF_KEY = 'settings:doneif';   // {schema:1, on:false, prev:{on}, updated_at, updated_by} — 기본 꺼짐 = dry-run(계획만 기록)
const DONEIF_LAST = 'it:doneif:last';    // 마지막 점검 {ts, today, on, scanned, candidates[≤50], moved, notified}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function parseKey(k) {   // 'veh:<id>:insp:<due>' · 'veh:<id>:ins:<due>' · 'lic:<id>:exp:<due>' · 'lic:<id>:edu:<due>' · 'rec:<id>:over45'
  const p = String(k || '').split(':');
  if (p[0] === 'veh' && p.length >= 4) return { dom: 'veh', col: 'vehicles', id: p[1], kind: p[2], due: p[3] };
  if (p[0] === 'lic' && p.length >= 4) return { dom: 'lic', col: 'licenses', id: p[1], kind: p[2], due: p[3] };
  if (p[0] === 'rec' && p.length >= 3) return { dom: 'rec', col: 'receivables', id: p[1], kind: p[2] };
  return null;
}

function eligible(t) {
  return !!(t && t.auto_key && t.del !== 1 && (t.status === 'open' || t.status === 'hold') && !t.doneif_off);
}

// 신호 판정. recs = {vehicles:{id:레코드}, licenses:{...}, receivables:{...}}. 반환 {ok, why}
function signalFor(task, recs) {
  const k = parseKey(task && task.auto_key);
  if (!k) return { ok: false, why: 'unknown_key' };
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
  (tasks || []).forEach(function (t) {
    if (!eligible(t)) return;
    scanned++;
    const s = signalFor(t, recs);
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
function clogAppend(doc, entry) {
  const d = (doc && Array.isArray(doc.items)) ? doc : { schema: 1, items: [], head: '' };
  const prev = d.head || '';
  const h = crypto.createHash('sha256').update(prev + '|' + JSON.stringify(entry)).digest('hex').slice(0, 16);
  d.items.push(Object.assign({ h: h, p: prev }, entry));
  d.head = h;
  if (d.items.length > 5000) d.items = d.items.slice(-5000);
  return d;
}

function byId(items) { const o = {}; (items || []).forEach(function (x) { if (x && x.id && x.del !== 1) o[x.id] = x; }); return o; }

module.exports = { DONEIF_KEY, DONEIF_LAST, isDate, parseKey, eligible, signalFor, plan, apply, clogAppend, byId };
