'use strict';

// P1 판30(원장 T422·T476 · 착수설명서 판30 · 시안 판3 ③ '계약 서류 목록 — 분기 점검' 카드 · PM 11/14 "45. 판 30,31ㄱ"):
//   PM 콘솔 점검 카드 하나 — 이번 분기(KST 달력 분기) 계약 서류 목록이 실제로 어떻게 쓰였는지 숫자로 보이고, 같은 서류를 2건·2명 이상 더했으면
//   '목록에 넣자는 제안'을 **표시만** 한다(기본 서류 목록을 바꾸는 길은 없다 — 고치는 곳은 권한관리 '계약 골조·목록 편집' 그대로).
//   [확인]은 분기 1회 — 판29 누른 기록(status:decide)에 한 줄(row 'conchk:<YYYY>-Q<n>', kind 'conchk')만 더한다(pmcon_decide·기록 꼴은 그대로).
//
// 계산(summarize)은 순수 함수 — 저장소를 읽는 일은 handlers()가 gw-data에서 받은 부품으로 한다.
// 집계 규칙은 appdata collectors/contract_gap.py list_delta_of와 같은 축:
//   - 재료 = 월 기록 clog:contract:YYYY-MM의 op 'stage_docs'(act done·undo·na·add·del)만. 해시 h가 같은 줄만 중복으로 빼고 같은 초 기록은 모두 센다.
//   - 건수는 사건 수 그대로: 완료 = done · 되돌림 = undo(건너뜀 취소 포함) · 건너뜀 = na · 더함 = add · 뺌 = del.
//   - 표본 = 목록을 바꾼 사건 = 더함 + 뺌 + 건너뜀(정의서 ② delta). 표본이 SMALL_N(10 — learn.js SUNSET_BASE_N·contract_gap BASE_N과 같은 값) 미만이면 비율을 내지 않는다.
//   - 서류 이름·단계 이름은 기록에 없어(종류·좌표만) 지금 계약(col:contracts — 지운 계약 포함)의 stage.docs[]에서 (계약·파이프·단계·키)로 찾는다.
//   - 제안 = 이번 분기 '더함' 중 뒤에 '뺌'이 없고 지금 계약에 남아 있는 서류를, 이름(공백 무시)으로 묶어 계약 SUGGEST_MIN_C건 이상 **그리고** 더한 사람 SUGGEST_MIN_P명 이상.
// 사람 이름·서류 내용 값은 내보내지 않는다(사람은 수만, 서류는 목록 이름만).
const SMALL_N = 10;
const SUGGEST_MIN_C = 2, SUGGEST_MIN_P = 2;
const STAGE_ACTS = { done: 1, undo: 1, na: 1, add: 1, del: 1 };
const TYPE_TXT = { dredge: '준설', asbestos: '석면', demolition: '철거', waste: '폐기물', lic_change: '인허가 변경' };
const MONTH_RE = /^clog:contract:(\d{4}-\d{2})$/;

// 검토 11/14 ③: 아주 큰·깨진 시각(1e20·NaN)은 Date가 'Invalid time value'로 터진다 — '' (분기 밖)로 돌려 그 줄만 빠지게
function kstYm(ts) { const t = Number(ts); if (!isFinite(t) || Math.abs(t) > 8.64e15 - 9 * 3600000) return ''; return new Date(t + 9 * 3600000).toISOString().slice(0, 7); }
// KST 달력 분기 — key '2026-Q4' · 그 분기 달 셋 · 지금 달
function quarterOf(ts) {
  const ym = kstYm(ts), y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)), q = Math.floor((m - 1) / 3) + 1;
  const months = [0, 1, 2].map(function (k) { return y + '-' + String(q * 3 - 2 + k).padStart(2, '0'); });
  return { key: y + '-Q' + q, y: y, q: q, months: months, cur: ym };
}
// 회차 = 첫 서류 기록 달의 분기부터 센 순서(1부터). 기록이 없으면 1
function roundOf(firstYm, qt) {
  if (!/^\d{4}-\d{2}$/.test(String(firstYm || ''))) return 1;
  const fy = Number(firstYm.slice(0, 4)), fq = Math.floor((Number(firstYm.slice(5, 7)) - 1) / 3) + 1;
  return Math.max(1, (qt.y - fy) * 4 + (qt.q - fq) + 1);
}
function normName(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
function txt(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function docAt(byId, cid, pipe, i, k) {   // (계약·파이프·단계·키) → { stage, name } | null
  const c = byId[cid]; if (!c || !Array.isArray(c.pipes)) return null;
  const p = c.pipes.find(function (x) { return x && String(x.key || '') === pipe; }); if (!p || !Array.isArray(p.stages)) return null;
  const s = p.stages[i]; if (!s || typeof s !== 'object') return null;
  const d = (Array.isArray(s.docs) ? s.docs : []).find(function (x) { return x && typeof x === 'object' && String(x.k || '') === k; });
  return { stage: txt(s.name, 40), name: d ? txt(d.n, 80) : '' };
}

// o = { contracts: col:contracts items[], months: [{ items, head }](이번 분기 달 기록 — 달 순서 무관), first_ym: 'YYYY-MM' | '', now: ms,
//       learn: { pairs: n|null, allow: { 양식: [칸…] } | null, sunset_off: n|null } | null }
function summarize(o) {
  const now = Number(o && o.now) || Date.now(), qt = quarterOf(now);
  const all = (o && Array.isArray(o.contracts) ? o.contracts : []).filter(function (c) { return c && typeof c === 'object' && c.id; });
  const byId = {}; all.forEach(function (c) { if (!byId[c.id]) byId[c.id] = c; });
  // ① 진행 계약(지우지 않음·종결 아님) · 단계 서류 상태
  const live = all.filter(function (c) { return c.del !== 1 && c.status !== 'done'; });
  const types = {}, docs = { total: 0, done: 0, todo: 0, na: 0 };
  live.forEach(function (c) {
    const t = String(c.type || ''); types[t] = (types[t] || 0) + 1;
    (Array.isArray(c.pipes) ? c.pipes : []).forEach(function (p) {
      (p && Array.isArray(p.stages) ? p.stages : []).forEach(function (s) {
        (s && Array.isArray(s.docs) ? s.docs : []).forEach(function (d) {
          if (!d || typeof d !== 'object') return;
          docs.total++;
          if (d.st === 'done') docs.done++; else if (d.st === 'na') docs.na++; else docs.todo++;
        });
      });
    });
  });
  const typeTxt = Object.keys(types).sort(function (a, b) { return types[b] - types[a] || (a < b ? -1 : 1); }).map(function (t) { return { t: TYPE_TXT[t] || '기타', n: types[t] }; });
  // ② 이번 분기 서류 기록(stage_docs) — 해시 h 같은 줄만 중복
  const rows = [], seen = {};
  let seq = 0;
  (o && Array.isArray(o.months) ? o.months : []).forEach(function (doc) {
    (doc && Array.isArray(doc.items) ? doc.items : []).forEach(function (e) {
      seq++;
      if (!e || typeof e !== 'object' || e.op !== 'stage_docs' || !e.cid || !STAGE_ACTS[e.act]) return;
      if (kstYm(Number(e.ts) || 0) < qt.months[0] || kstYm(Number(e.ts) || 0) > qt.months[2]) return;   // 달 키와 시각이 어긋난 줄은 분기 밖이면 뺌
      if (e.h) { if (seen[e.h]) return; seen[e.h] = 1; }
      rows.push({ ts: Number(e.ts) || 0, n: seq, e: e });
    });
  });
  rows.sort(function (a, b) { return a.ts - b.ts || a.n - b.n; });
  const log = { n: rows.length, contracts: 0, people: 0, done: 0, undo: 0, skip: 0, add: 0, del: 0, delta: 0 };
  const cids = {}, bys = {}, adds = {}, skipBy = {};
  rows.forEach(function (r) {
    const e = r.e, cid = String(e.cid), pipe = String(e.pipe || ''), i = Number(e.i), k = String(e.k || ''), tup = cid + '|' + pipe + '|' + i + '|' + k;
    cids[cid] = 1; if (e.by) bys[String(e.by)] = 1;
    if (e.act === 'na') {
      log.skip++;
      const at = docAt(byId, cid, pipe, i, k) || { stage: '', name: '' };
      const sk = at.stage || '(단계 모름)';
      const g = skipBy[sk] || (skipBy[sk] = { stage: sk, n: 0, c: {}, docs: [] });
      g.n++; g.c[cid] = 1;
      const nm = at.name || '(이름 모름)'; if (g.docs.indexOf(nm) < 0) g.docs.push(nm);
    } else if (e.act === 'add') { log.add++; adds[tup] = { cid: cid, by: String(e.by || ''), pipe: pipe, i: i, k: k }; }
    else if (e.act === 'del') { log.del++; delete adds[tup]; }
    else log[e.act]++;
  });
  log.contracts = Object.keys(cids).length; log.people = Object.keys(bys).length; log.delta = log.add + log.del + log.skip;
  const skips = Object.keys(skipBy).map(function (s) { const g = skipBy[s]; return { stage: g.stage, n: g.n, contracts: Object.keys(g.c).length, docs: g.docs.slice(0, 12) }; })
    .sort(function (a, b) { return b.n - a.n || (a.stage < b.stage ? -1 : 1); });
  // ③ 제안 — 남아 있는 '더함'을 이름으로 묶어 계약 2건 이상 그리고 사람 2명 이상
  const grp = {};
  Object.keys(adds).forEach(function (t) {
    const a = adds[t], at = docAt(byId, a.cid, a.pipe, a.i, a.k);
    if (!byId[a.cid] || byId[a.cid].del === 1) return;   // 검토 11/14 ①: 지운 계약은 제안 재료가 아님(종결 계약은 셈 — 그 분기에 실제로 더한 것)
    if (!at || !at.name) return;   // 지금 계약에 없는 서류(뒤에 지움·계약 사라짐)는 제안 재료가 아님
    const key = normName(at.name); if (!key) return;
    const g = grp[key] || (grp[key] = { name: at.name, c: {}, p: {}, stages: {} });
    g.c[a.cid] = 1; if (a.by) g.p[a.by] = 1; if (at.stage) g.stages[at.stage] = 1;
  });
  const suggest = Object.keys(grp).map(function (k) { const g = grp[k]; return { name: g.name, contracts: Object.keys(g.c).length, people: Object.keys(g.p).length, stages: Object.keys(g.stages).slice(0, 4) }; })
    .filter(function (g) { return g.contracts >= SUGGEST_MIN_C && g.people >= SUGGEST_MIN_P; })
    .sort(function (a, b) { return b.contracts - a.contracts || b.people - a.people || (a.name < b.name ? -1 : 1); }).slice(0, 20);
  const sample = log.delta, small = sample < SMALL_N;
  const firstMonth = qt.months.find(function (m) { return m <= qt.cur && (o.month_keys || []).indexOf(m) >= 0; }) || qt.cur;
  // ④ 학습 한 줄
  let learn = null;
  if (o && o.learn) {
    const al = o.learn.allow && typeof o.learn.allow === 'object' && !Array.isArray(o.learn.allow) ? o.learn.allow : null;
    learn = { pairs: typeof o.learn.pairs === 'number' ? o.learn.pairs : null,
      tpls: al ? Object.keys(al).length : null,
      cells: al ? Object.keys(al).reduce(function (s, t) { const v = al[t]; return s + (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0)); }, 0) : null,
      sunset_off: typeof o.learn.sunset_off === 'number' ? o.learn.sunset_off : null };
  }
  return {
    quarter: qt.key, round: roundOf(o && o.first_ym, qt), months: [firstMonth, qt.cur],
    live: { n: live.length, types: typeTxt, docs: docs },
    log: log, skips: skips, suggest: suggest,
    sample: sample, small: small, ratio: (small || !log.n) ? null : Math.round(sample / log.n * 100),
    learn: learn,
    rule: { small_n: SMALL_N, min_contracts: SUGGEST_MIN_C, min_people: SUGGEST_MIN_P },
  };
}

// 저장소 읽기 → summarize. D = gw-data가 넘긴 부품. { ok, sum } | { ok:false, code }
async function loadSummary(D, st, now) {
  const qt = quarterOf(now);
  const cr = await D.blobGet(st, D.colKey('contracts'));
  if (!cr.ok && cr.code !== 'NOT_FOUND') return { ok: false, code: 'CONCHK_READ_FAILED' };
  const contracts = (cr.ok && cr.data && Array.isArray(cr.data.items)) ? cr.data.items : [];
  const l = await D.blobList(st, 'clog:contract:');
  if (!l.ok) return { ok: false, code: 'CONCHK_READ_FAILED' };
  const mkeys = (l.keys || []).map(function (k) { const m = MONTH_RE.exec(String(k)); return m ? m[1] : ''; }).filter(Boolean).sort();
  const months = [];
  for (const m of qt.months) {
    if (m > qt.cur || mkeys.indexOf(m) < 0) continue;
    const r = await D.blobGet(st, 'clog:contract:' + m);
    if (!r.ok) return { ok: false, code: 'CONCHK_READ_FAILED' };
    if (r.data && !Array.isArray(r.data.items)) return { ok: false, code: 'CONCHK_READ_FAILED' };   // 깨진 달 기록 — 0건으로 보이지 않게
    if (r.data) months.push(r.data);
  }
  // 학습 — 못 읽으면 그 칸만 null('불러오지 못함'), 카드 전체를 막지 않음
  let learn = { pairs: null, allow: null, sunset_off: null };
  try { const lp = await D.blobList(st, D.LN.TYPES.contract.pair_prefix); if (lp.ok) learn.pairs = (lp.keys || []).filter(function (k) { return String(k).indexOf(D.LN.TYPES.contract.pair_prefix) === 0; }).length; } catch (e) {}
  // 검토 11/14 ②: 설정은 키를 직접 읽는다(gw-data learnSettings는 읽기 실패를 삼켜 빈 허용 = '0양식 0칸'으로 보였음) — 실패·깨짐 = null('?') · 없음 = 빈 허용
  try {
    const sr = await D.blobGet(st, D.LN.TYPES.contract.settings_key);
    if (sr.ok || sr.code === 'NOT_FOUND') {
      const sd = sr.ok && sr.data ? sr.data : {};
      const al = sd && typeof sd === 'object' && sd.contract && typeof sd.contract === 'object' ? sd.contract.allow : undefined;
      if (al === undefined || al === null) learn.allow = {};
      else if (typeof al === 'object' && !Array.isArray(al)) learn.allow = al;
    }
  } catch (e) {}
  try {
    const ll = await D.blobList(st, 'lessons:contract:');
    if (ll.ok) {
      let off = 0, bad = false;
      for (const k of (ll.keys || [])) {
        if (String(k).indexOf('lessons:contract:') !== 0) continue;
        const r = await D.blobGet(st, k);
        if (!r.ok && r.code !== 'NOT_FOUND') { bad = true; break; }   // 하나라도 못 읽으면 수를 모름('?') — 0으로 보이지 않게
        const L = D.LN.normLessons(r.ok ? r.data : null);
        if (L && L.off && L.sunset) off++;
      }
      if (!bad) learn.sunset_off = off;
    }
  } catch (e) {}
  return { ok: true, sum: summarize({ contracts: contracts, months: months, month_keys: mkeys, first_ym: mkeys[0] || '', now: now, learn: learn }) };
}

// gw-data 연결: D = { gate(pmconGate), read(pmconRead), fold(pmconFold), key(PMCON_KEY), store(), blobGet, blobSet, blobList, appendAudit, LN, colKey, jr }
function handlers(D) {
  const rowOf = function (q) { return 'conchk:' + q; };
  const checkedOf = function (doc, q) {
    const hit = (doc && Array.isArray(doc.log) ? doc.log : []).filter(function (x) { return x && x.row === rowOf(q); });
    const x = hit[hit.length - 1];
    return x ? { ts: Number(x.ts) || 0, name: txt(x.name, 20), n: hit.length } : null;
  };
  async function get(event, d, R) {
    const g = await D.gate(event, R, false); if (g.res) return g.res;
    const st = D.store(), now = Date.now();
    const s = await loadSummary(D, st, now);
    if (!s.ok) return D.jr(503, { status: 'ERROR', error_code: s.code, request_id: R });
    const pr = await D.read(st);
    if (!pr.ok) return D.jr(503, { status: 'ERROR', error_code: 'PMCON_READ_FAILED', request_id: R });
    return D.jr(200, Object.assign({ status: 'OK' }, s.sum, { checked: checkedOf(pr.doc, s.sum.quarter), can_write: g.isPm, pm_known: g.known, request_id: R }));
  }
  async function confirm(event, d, R) {
    const g = await D.gate(event, R, true); if (g.res) return g.res; const c = g.c;
    const now = Date.now(), qt = quarterOf(now);
    if (String((d && d.quarter) || '') !== qt.key) return D.jr(400, { status: 'REJECTED', error_code: 'BAD_QUARTER', quarter: qt.key, request_id: R });   // 화면이 본 분기와 지금 분기가 다름(분기 경계에 열어 둔 화면)
    const st = D.store();
    const s = await loadSummary(D, st, now);
    if (!s.ok) return D.jr(503, { status: 'ERROR', error_code: s.code, request_id: R });
    const s1 = await D.read(st);
    if (!s1.ok) return D.jr(503, { status: 'ERROR', error_code: 'PMCON_READ_FAILED', request_id: R });
    const done = checkedOf(s1.doc, qt.key);
    if (done) return D.jr(409, { status: 'CONFLICT', error_code: 'CONCHK_DONE', checked: done, request_id: R });   // 분기 1회 — 다시 누름은 막음
    const sum = s.sum, doc = s1.doc;
    const val = '표본 ' + sum.sample + '건 · 기록 ' + sum.log.n + '건 · 제안 ' + sum.suggest.length;
    const rec = { ts: now, by: c.member.id, name: txt(c.member.name, 20), row: rowOf(qt.key), kind: 'conchk', choice: 'ok', grade: '', due: '',
      q: '계약 서류 목록 분기 점검 ' + qt.y + '년 ' + qt.q + '분기(' + sum.round + '회차) 확인', rec: '', val: val, match: null, why: '', applied: false, via: 'conchk' };
    doc.log.push(rec);
    D.fold(doc);
    doc.schema = 1; doc.updated_by = c.member.id; doc.updated_at = Math.max(now, (Number(doc.updated_at) || 0) + 1);
    const w = await D.blobSet(st, D.key, doc);
    if (!w.ok) return D.jr(500, { status: 'ERROR', error_code: 'CONCHK_WRITE_FAILED', request_id: R });
    let au = false;
    try { au = await D.appendAudit({ ts: now, by: c.member.name, bid: c.member.id, col: 'pmcon', ev: [{ op: 'PM콘솔', id: rec.row, t: '계약 서류 분기 점검 · 확인 · ' + qt.key + ' · ' + val }] }) !== false; } catch (e) { au = false; }
    return D.jr(200, { status: 'OK', record: rec, checked: { ts: now, name: rec.name, n: 1 }, updated_at: doc.updated_at, audit: au, request_id: R });
  }
  return { get: get, confirm: confirm };
}

module.exports = { summarize, quarterOf, roundOf, loadSummary, handlers, SMALL_N, SUGGEST_MIN_C, SUGGEST_MIN_P };
