'use strict';
// C289(11/27) 「덧대기」 오래 참조 없는 첨부 정리 — 연습 방식(지울 후보만 보여 줌 · 지우는 길 없음).
// 「원천」은 v516(C257): 저장 안 하고 버린 홍보 사진은 그 자리에서 지운다. 이 모듈은 탭 닫기·끊김·새로고침처럼 원천이 못 막는 고아를 찾아 보고만 한다.
// 기준(11/20·11/26 고아 63건 대조와 같음): 감사(audit:*)를 뺀 모든 저장 값(gw_data·gw_users·gw_files의 값)에서 att_<16hex>가 한 번이라도 나오면 '쓰는 중'.
//   첨부 자신의 키(att_·mask:·maskmeta:·parse:·boxp:·조각처럼 그 id를 키에 품은 것)는 참조로 치지 않는다.
// 읽기 실패가 하나라도 있으면 그 회차는 후보를 바꾸지 않는다(실패를 '없음'으로 보지 않음 — C225).
// 후보 = 참조 없음이 처음 보인 뒤 STALE_DAYS(7일) 넘게 계속 참조 없는 첨부(주 1회 크론이 몇 초 일찍 돌아도 한 주 밀리지 않게 12시간 여유 — 검토 11/27).
//   종류(인허가 수령본·넣다 만 서류함 파일 boxp: 표식 등)는 키로 모르므로 가리지 않고 딸린 키 수(related)로만 보인다 — 지우기는 사람이 목록을 보고 승인 뒤.
const REPORT_KEY = 'attorphan:report';
const STALE_DAYS = 7;
const DAY_MS = 86400000;
const SLACK_MS = 12 * 3600000;
const ATT_RE = /att_[0-9a-f]{16}/g;
const ATT_KEY_RE = /^att_[0-9a-f]{16}$/;
const SKIP_DATA_PREFIX = ['audit:'];
const MAX_LIST = 500;   // 보고에 싣는 후보·새 고아 줄 상한(문서 크기 보호) — 수는 따로 셈

function idsIn(text) { return String(text || '').match(ATT_RE) || []; }
function skipDataKey(k) { return SKIP_DATA_PREFIX.some(function (p) { return String(k).indexOf(p) === 0; }); }

// 한 회차 판정(순수). prev = 직전 보고의 unref {id: 처음 참조 없음 본 ms}, attKeys = 첨부 키 목록, refs = Set(참조된 id), fileKeys = gw_files 전체 키
function step(prev, attKeys, refs, fileKeys, now, readFail) {
  const prevUnref = (prev && prev.unref && typeof prev.unref === 'object') ? prev.unref : {};
  if (readFail) {
    // 실패 회차: 직전 상태를 그대로 둔다(새로 넣지도 빼지도 않음)
    return { unref: Object.assign({}, prevUnref), candidates: [], fresh: [], partial: true };
  }
  const unref = {};
  (attKeys || []).forEach(function (a) { if (!refs.has(a)) unref[a] = Number(prevUnref[a]) > 0 ? Number(prevUnref[a]) : now; });
  const related = {};
  (fileKeys || []).forEach(function (k) {
    if (ATT_KEY_RE.test(k)) return;
    idsIn(k).forEach(function (a) { if (unref[a]) (related[a] = related[a] || []).push(k); });
  });
  const candidates = [], fresh = [];
  Object.keys(unref).sort().forEach(function (a) {
    const since = unref[a], days = Math.floor((now - since) / DAY_MS);
    const row = { id: a, since: since, days: days, related: (related[a] || []).length };
    if (now - since >= STALE_DAYS * DAY_MS - SLACK_MS) candidates.push(row); else fresh.push(row);
  });
  return { unref: unref, candidates: candidates, fresh: fresh, partial: false };
}

// 한 회차 실행 — B = { blobGet, blobList, blobSet, store }. 지우지 않는다.
async function run(B, now) {
  now = now || Date.now();
  const stD = B.store('gw_data'), stU = B.store('gw_users'), stF = B.store('gw_files');
  const refs = new Set(); let readFail = 0, scanned = 0;
  const lf = await B.blobList(stF), ld = await B.blobList(stD), lu = await B.blobList(stU);
  if (!lf.ok || !ld.ok || !lu.ok) readFail++;
  const fileKeys = lf.ok ? lf.keys : [];
  const attKeys = fileKeys.filter(function (k) { return ATT_KEY_RE.test(k); });
  const scan = async function (st, keys, skip) {
    for (const k of keys) {
      if (skip(k)) continue;
      const r = await B.blobGet(st, k);
      if (!r.ok) { readFail++; continue; }
      scanned++;
      if (r.data === null || r.data === undefined) continue;
      idsIn(typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).forEach(function (a) { refs.add(a); });
    }
  };
  if (ld.ok) await scan(stD, ld.keys, function (k) { return skipDataKey(k) || k === REPORT_KEY; });
  if (lu.ok) await scan(stU, lu.keys, function () { return false; });
  // gw_files: 첨부 자신(키에 id를 품은 것)은 빼고 나머지 값(서류함 색인·문서 첨부 메타 등)만
  if (lf.ok) await scan(stF, fileKeys, function (k) { return idsIn(k).length > 0; });
  const pr = await B.blobGet(stD, REPORT_KEY);
  if (!pr.ok) readFail++;
  const prev = pr.ok ? pr.data : null;
  const s = step(prev, attKeys, refs, fileKeys, now, readFail > 0);
  const doc = {
    schema: 1, ts: now, dry_run: true, stale_days: STALE_DAYS, partial: s.partial, read_fail: readFail, scanned: scanned,
    att: attKeys.length, refs: refs.size, unref: s.unref,
    n_candidates: s.candidates.length, n_fresh: s.fresh.length,
    candidates: s.candidates.slice(0, MAX_LIST), fresh: s.fresh.slice(0, MAX_LIST),
    last_ok: s.partial ? (prev && prev.last_ok) || 0 : now,
  };
  if (s.partial && prev && typeof prev === 'object') {
    // 실패 회차는 직전 판정을 보존하고 실패 표시만 더한다
    Object.assign(doc, { n_candidates: prev.n_candidates || 0, n_fresh: prev.n_fresh || 0, candidates: prev.candidates || [], fresh: prev.fresh || [], att: prev.att || attKeys.length, refs: prev.refs || refs.size });
  }
  const w = await B.blobSet(stD, REPORT_KEY, doc);
  return { ok: !!(w && w.ok), partial: s.partial, read_fail: readFail, n_candidates: doc.n_candidates, n_fresh: doc.n_fresh, att: doc.att };
}

// 관리자 조회용 요약(지우는 길 없음 — 실제 삭제는 운영책임자 승인 뒤 따로)
function summary(doc) {
  const d = (doc && typeof doc === 'object') ? doc : null;
  if (!d) return { has: false };
  return { has: true, ts: Number(d.ts) || 0, partial: !!d.partial, read_fail: Number(d.read_fail) || 0, last_ok: Number(d.last_ok) || 0, stale_days: Number(d.stale_days) || STALE_DAYS,
    att: Number(d.att) || 0, n_candidates: Number(d.n_candidates) || 0, n_fresh: Number(d.n_fresh) || 0,
    candidates: (Array.isArray(d.candidates) ? d.candidates : []).map(function (r) { return { id: String(r.id || ''), days: Number(r.days) || 0, related: Number(r.related) || 0 }; }).filter(function (r) { return ATT_KEY_RE.test(r.id); }) };
}

module.exports = { REPORT_KEY, STALE_DAYS, step, run, summary, idsIn };
