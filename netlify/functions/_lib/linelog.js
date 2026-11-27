'use strict';

// 원장 C304(11/27 「원천」) 열람 기록 줄 유실 — 열람 기록 2종(gw-data appendRecLog 'reclog:YYYY-MM' 계약 서류함·개인정보 등급 서류 열람·내려받기 · appendDocLog 'doclog:YYYY-MM' 문서함 열람)이
//   그달 문서를 읽고 → 한 줄 붙이고 → 통째로 다시 써서(조건부 쓰기 없음), 두 쓰기가 0.1초 안에 겹치면 둘 다 성공으로 답하는데 한 줄이 사라졌다
//   (재현 = 09_조사_문서/열람기록줄유실_자료_20261127/repro_c304.mjs — 40줄을 0~100ms 안에 쓰면 3~4줄만 남음).
//   고친 방식 = 감사 기록 C251(_lib/audit.js — v522)과 같은 꼴: 줄마다 고유 열쇠 '<머리>:e:<쓴 시각 13자리>-<이 프로세스 순번 4자리>-<무작위 12자리>'에 새로 쓴다(값 { schema:1, items:[줄] }).
//   덮어쓸 문서가 없어 경합 자체가 없다 · 쓰기 = 저장소 왕복 1번(종전 읽기 1 + 쓰기 1).
//   · 머리 = 'doclog:YYYY-MM'·'reclog:YYYY-MM'(달 = KST — gw-data docLogKey·recLogKey 그대로). 옛 머리 문서는 옮기지 않고 그대로 읽는다 — 새 줄만 줄 열쇠.
//   · 읽는 쪽(readMonth 한 곳 — gw-data doc_log_get·rec_log_get)은 접두어 목록 1번으로 줄 열쇠·접은 문서를 얻어, 머리 줄(있던 순서 그대로) 사이에 줄 열쇠·접은 문서 줄(꼬리순 = 쓴 시각순)을
//     시각(ts)으로 끼워 넣는다 — 줄 열쇠가 없는 달은 결과가 종전과 글자째 같다. 하나라도 못 읽으면 달 전체 실패(C225 — 일부만 보여 주지 않음).
//   · 접기(foldMonth — 크론 gw-audit-fold-cron 하루 3번, 감사 접기와 같은 실행): 쓴 지 20분 넘은 줄 열쇠를 접은 문서 '<머리>:f:<묶음 마지막 꼬리>-<무작위 8자리>' 1개에 한 번 쓰고,
//     다시 읽어 쓴 그대로일 때만 그 줄 열쇠를 지운다. 접은 문서 = { schema:1, items:[줄 + k:<줄 열쇠 꼬리>], keys:[꼬리…] } — 실행마다 고유한 새 이름(겹친 두 실행이 같은 줄을 각자 접어도
//     읽는 쪽이 꼬리로 한 번만 셈 · C251 11/23 이름 고유화와 같은 원칙). 줄마다 k를 두는 까닭은 감사와 같다(재해 복원 병합 backupLogMerge가 items만 다룸).
//   감사(_lib/audit.js)를 이 모듈로 옮기지 않은 까닭: 감사 코드·열쇠 이름·동작은 바꾸지 않는다(servertest 판31·C251 결함 사본이 audit.js 글자에 기대어 있음 — 옮기면 감사 회귀 위험).
//     감사에만 있는 것(옛 조각 audit:YYYY-MM:n·서버 달)은 이 모듈에 없다. 상수·꼴은 감사와 같은 값.
//   설계·수치 = 09_조사_문서/열람기록줄유실_자료_20261127/ · 감사 설계 = 09_조사_문서/감사줄유실_자료_20261120/01_설계_전수표.md §6·§7.
const crypto = require('crypto');
const { blobGet, blobSet, blobList, blobDelete } = require('./blobs');

const LINE_TAG = ':e:';
const FOLD_TAG = ':f:';
const READ_POOL = 32;              // 줄 열쇠·접은 문서를 나란히 읽는 수(감사 LINE_READ_POOL과 같은 값)
const FOLD_AGE_MS = 20 * 60000;    // 쓴 지 20분 넘은 줄 열쇠만 접음
const FOLD_MAX_ITEMS = 2000;       // 한 묶음 줄 상한(열람 기록 월 상한 5,000·재해 복원 병합 상한 안)
const FOLD_MAX_BYTES = 900000;
const FOLD_RUN_CAP_MS = 20000;     // 한 실행 시간 상한(이 시각이 지나면 새 묶음을 시작하지 않음)
const TAIL_RE = /^\d{13}-\d{4}-[0-9a-f]{12}$/;
let lineSeq = 0;

function lineKey(head, nowMs) {
  lineSeq = (lineSeq + 1) % 10000;
  return head + LINE_TAG + String(Math.floor(Number(nowMs) || 0)).padStart(13, '0') + '-' + String(lineSeq).padStart(4, '0') + '-' + crypto.randomBytes(6).toString('hex');
}
// 달 = KST(gw-data docLogKey·recLogKey와 같은 식 — UTC 시각 + 9시간의 UTC 연·월)
function kstMonth(nowMs) {
  const d = new Date((Number(nowMs) || Date.now()) + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
function prevMonth(mon) {
  const y = Number(mon.slice(0, 4)), m = Number(mon.slice(5, 7));
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}
function docOk(x) { return !!x && typeof x === 'object' && Array.isArray(x.items); }

// 한 줄 남기기 — 새 열쇠 1개에 쓴다. 남겼으면 true · 못 남김(쓰기 실패·예외) false(삼킴 — 부르는 쪽이 반환값으로 막을지 정함)
async function append(st, head, entry) {
  try {
    const w = await blobSet(st, lineKey(head, Date.now()), { schema: 1, items: [entry] });
    return !!(w && w.ok);
  } catch (e) { return false; }
}

// 이 달 머리 뒤 열쇠(접두어 목록 1번) — lines = 줄 열쇠 · folds = 접은 문서(둘 다 이름순, 겹친 이름은 한 번) · 목록 못 읽음 = null
async function listMonth(st, head) {
  const l = await blobList(st, head + ':');
  if (!l || !l.ok) return null;
  const esc = head.replace(/[-:]/g, '\\$&');
  const reL = new RegExp('^' + esc + LINE_TAG + '\\d{13}-\\d{4}-[0-9a-f]{12}$'), reF = new RegExp('^' + esc + FOLD_TAG + '\\d{13}-\\d{4}-[0-9a-f]{12}-[0-9a-f]{8}$');
  const seen = {}, lines = [], folds = [];
  (l.keys || []).forEach(function (k) {
    if (seen[k]) return;
    if (reL.test(k)) { seen[k] = 1; lines.push(k); } else if (reF.test(k)) { seen[k] = 1; folds.push(k); }
  });
  return { lines: lines.sort(), folds: folds.sort() };
}
// 접은 문서 꼴 — { items:[줄마다 k = 줄 열쇠 꼬리] } (keys는 있으면 꼬리 목록 — 재해 복원으로 빠질 수 있어 읽는 쪽은 줄의 k를 본다)
function foldOk(x) {
  return docOk(x) && x.items.every(function (e) { return !!e && typeof e === 'object' && typeof e.k === 'string' && TAIL_RE.test(e.k); })
    && (x.keys === undefined || (Array.isArray(x.keys) && x.keys.every(function (t) { return typeof t === 'string' && TAIL_RE.test(t); })));
}
function foldTails(doc) {
  const s = new Set();
  doc.items.forEach(function (e) { s.add(e.k); });
  if (Array.isArray(doc.keys)) doc.keys.forEach(function (t) { s.add(t); });
  return s;
}
function stripK(e) { const o = {}; Object.keys(e).forEach(function (n) { if (n !== 'k') o[n] = e[n]; }); return o; }
// 열쇠 값 전부(이름순 그대로) — READ_POOL개씩 나란히. { ok:true, docs:[문서 또는 null(없음)] } · 하나라도 읽기 실패·깨짐 = { ok:false, code }
async function readDocs(st, keys, okFn) {
  const docs = new Array(keys.length), good = okFn || docOk;
  let next = 0, bad = '';
  const work = async function () {
    while (!bad && next < keys.length) {
      const i = next++;
      const r = await blobGet(st, keys[i]);
      if (!r.ok && r.code !== 'NOT_FOUND') { bad = bad || r.code || 'STORAGE_READ_FAILED'; return; }
      if (!r.ok || r.data == null) { docs[i] = null; continue; }
      if (!good(r.data)) { bad = bad || 'LOG_BAD_DOC'; return; }
      docs[i] = r.data;
    }
  };
  const pool = [];
  for (let p = 0; p < Math.min(READ_POOL, keys.length); p++) pool.push(work());
  await Promise.all(pool);
  return bad ? { ok: false, code: bad } : { ok: true, docs: docs };
}
// 머리 줄(a — 있던 순서 그대로) 사이에 줄 열쇠 줄(b — 꼬리순)을 시각(ts)으로 끼워 넣는다(같은 시각이면 머리 줄이 앞 — 감사 auditMerge와 같음)
function merge(a, b) {
  if (!b.length) return a;
  const tsOf = function (e, dflt) { const t = e && typeof e === 'object' ? Number(e.ts) : NaN; return Number.isFinite(t) ? t : dflt; };
  const out = [];
  let i = 0;
  for (const x of b) {
    const tb = tsOf(x.e, x.t);
    while (i < a.length && tsOf(a[i], -Infinity) <= tb) out.push(a[i++]);
    out.push(x.e);
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}

// 한 달 기록 전부 — { ok:true, items, lines(줄 열쇠 수), folds(접은 문서 수), missing(목록에는 있는데 값이 없고 접은 문서에도 없는 줄 열쇠·접은 문서 수) } ·
//   머리·줄 열쇠·접은 문서 하나라도 읽기 실패·깨짐·목록 실패 = { ok:false, code } · 달 전체 없음 = 빈 목록. 월 상한(DOCLOG_MAX·RECLOG_MAX)은 부르는 쪽이 이 합친 결과로 판정한다.
async function readMonth(st, head) {
  const r = await blobGet(st, head);
  if (!r.ok && r.code !== 'NOT_FOUND') return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  const hasHead = r.ok && r.data != null;
  if (hasHead && !docOk(r.data)) return { ok: false, code: 'LOG_BAD_DOC' };
  const ls = await listMonth(st, head);
  if (!ls) return { ok: false, code: 'STORAGE_LIST_FAILED' };
  let items = hasHead ? r.data.items.slice() : [], missing = 0, folds = ls.folds;
  if (ls.lines.length || folds.length) {
    let fd = await readDocs(st, folds, foldOk);
    if (!fd.ok) return { ok: false, code: fd.code };
    const ld = await readDocs(st, ls.lines);
    if (!ld.ok) return { ok: false, code: ld.code };
    const cut = head.length + LINE_TAG.length;
    // 목록과 읽기 사이에 지워진 줄 열쇠(접기가 그사이 접고 지움)가 있으면 접은 문서를 한 번 다시 목록해 새로 생긴 것을 읽는다(감사 설계 §7-3)
    if (ld.docs.some(function (d) { return !d; })) {
      const l2 = await listMonth(st, head);
      if (!l2) return { ok: false, code: 'STORAGE_LIST_FAILED' };
      const had = new Set(folds), extra = l2.folds.filter(function (k) { return !had.has(k); });
      if (extra.length) {
        const fd2 = await readDocs(st, extra, foldOk);
        if (!fd2.ok) return { ok: false, code: fd2.code };
        const pairs = folds.map(function (k, i) { return [k, fd.docs[i]]; }).concat(extra.map(function (k, i) { return [k, fd2.docs[i]]; }))
          .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
        folds = pairs.map(function (p) { return p[0]; }); fd = { ok: true, docs: pairs.map(function (p) { return p[1]; }) };
      }
    }
    // 같은 꼬리(줄 열쇠 하나)는 한 번만: 접은 문서(이름순) → 아직 안 접힌 줄 열쇠. 모은 줄은 꼬리순(= 쓴 시각순)
    const add = [], taken = new Set();
    fd.docs.forEach(function (doc) {
      if (!doc) { missing++; return; }
      const here = foldTails(doc);
      doc.items.forEach(function (e) { if (!taken.has(e.k)) add.push({ e: stripK(e), t: Number(e.k.slice(0, 13)), k: e.k }); });
      here.forEach(function (t) { taken.add(t); });
    });
    ld.docs.forEach(function (doc, i) {
      const tail = ls.lines[i].slice(cut);
      if (taken.has(tail)) return;   // 이미 접은 문서에 든 줄(지우다 멈춘 찌꺼기·접는 중)
      if (!doc) { missing++; return; }
      taken.add(tail);
      const t = Number(tail.slice(0, 13));
      doc.items.forEach(function (e) { add.push({ e: e, t: t, k: tail }); });
    });
    add.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });   // 안정 정렬 — 한 꼬리 안의 줄 차례는 그대로
    items = merge(items, add);
  }
  return { ok: true, items: items, lines: ls.lines.length, folds: folds.length, missing: missing };
}

// ---- 접기 — 읽고-고쳐-쓰는 문서가 없다: 접은 문서는 새 이름에 한 번 쓰고, 줄 열쇠는 접은 문서에 든 것이 확인된 것만 지운다(감사 foldMonth와 같은 순서·같은 판정).
async function deleteKeys(st, keys) {
  let next = 0, ok = 0, fail = 0;
  const work = async function () {
    while (next < keys.length) {
      const k = keys[next++];
      let r; try { r = await blobDelete(st, k); } catch (e) { r = null; }
      if (r && r.ok) ok++; else fail++;
    }
  };
  const pool = [];
  for (let p = 0; p < Math.min(READ_POOL, keys.length); p++) pool.push(work());
  await Promise.all(pool);
  return { ok: ok, fail: fail };
}
// 줄 열쇠 읽기(접기용 — 하나 실패해도 나머지는 계속) — 읽기 실패·없음·깨짐은 빼고 셈(그 줄은 이번에 접지 않고 남김)
async function foldReadLines(st, head, keys, out) {
  const res = new Array(keys.length), cut = head.length + LINE_TAG.length;
  let next = 0;
  const work = async function () {
    while (next < keys.length) {
      const i = next++;
      const r = await blobGet(st, keys[i]);
      if (!r.ok && r.code !== 'NOT_FOUND') { out.read_fail++; continue; }
      if (!r.ok || r.data == null) { out.gone++; continue; }
      if (!docOk(r.data)) { out.bad++; continue; }
      res[i] = { key: keys[i], tail: keys[i].slice(cut), doc: r.data };
    }
  };
  const pool = [];
  for (let p = 0; p < Math.min(READ_POOL, keys.length); p++) pool.push(work());
  await Promise.all(pool);
  return res.filter(Boolean);
}
// 한 묶음 쓰기 → 다시 읽어 쓴 그대로인지 확인 → 그때만 그 줄 열쇠를 지움. 이름 = 묶음 마지막 꼬리 + '-' + 무작위 8자리(실행마다 고유)
async function foldWrite(st, head, batch, out) {
  const items = [], keys = [];
  batch.forEach(function (b) { b.doc.items.forEach(function (e) { items.push(Object.assign({}, e, { k: b.tail })); }); keys.push(b.tail); });
  const name = head + FOLD_TAG + keys[keys.length - 1] + '-' + crypto.randomBytes(4).toString('hex'), doc = { schema: 1, items: items, keys: keys };
  const w = await blobSet(st, name, doc);
  if (!w || !w.ok) { out.write_fail++; return false; }
  const r = await blobGet(st, name);
  if (!r.ok || JSON.stringify(r.data) !== JSON.stringify(doc)) { out.verify_fail++; return false; }   // 못 읽음·쓴 것과 다름 — 지우지 않음(다음 실행이 찌꺼기로 정리)
  out.docs++; out.folded += batch.length;
  const dr = await deleteKeys(st, batch.map(function (b) { return b.key; }));
  out.deleted += dr.ok; out.del_fail += dr.fail;
  return true;
}
// 한 달 접기 — head = 'doclog:YYYY-MM' 같은 머리 · nowMs = 지금(20분 판정) · deadline = 이 시각이 지나면 새 묶음을 시작하지 않음
async function foldMonth(st, head, nowMs, deadline) {
  const out = { head: head, ok: true, code: '', docs: 0, folded: 0, deleted: 0, residue: 0, del_fail: 0, read_fail: 0, gone: 0, bad: 0, write_fail: 0, verify_fail: 0, young: 0, left: 0 };
  const ls = await listMonth(st, head);
  if (!ls) return Object.assign(out, { ok: false, code: 'STORAGE_LIST_FAILED' });
  const fd = await readDocs(st, ls.folds, foldOk);
  if (!fd.ok) return Object.assign(out, { ok: false, code: fd.code });   // 이미 접은 꼬리를 모르면 이 달은 이번에 건너뜀(찌꺼기를 지우지도, 새로 접지도 않음)
  const folded = new Set();
  fd.docs.forEach(function (d) { if (d) foldTails(d).forEach(function (t) { folded.add(t); }); });
  const cut = head.length + LINE_TAG.length, tailOf = function (k) { return k.slice(cut); };
  const residue = ls.lines.filter(function (k) { return folded.has(tailOf(k)); });
  const dr = await deleteKeys(st, residue);
  out.residue = dr.ok; out.del_fail += dr.fail;
  const cutoff = nowMs - FOLD_AGE_MS;
  const cand = ls.lines.filter(function (k) { return !folded.has(tailOf(k)) && Number(tailOf(k).slice(0, 13)) <= cutoff; });
  out.young = ls.lines.length - residue.length - cand.length;
  let i = 0;
  while (i < cand.length) {
    if (Date.now() > deadline) { out.code = 'TIME_CAP'; break; }
    const chunk = cand.slice(i, i + FOLD_MAX_ITEMS);
    i += chunk.length;
    const got = await foldReadLines(st, head, chunk, out);
    let batch = [], nItems = 0, nBytes = 0;
    for (const g of got) {
      const b = Buffer.byteLength(JSON.stringify(g.doc.items), 'utf8') + 60 * g.doc.items.length, n = g.doc.items.length;
      if (batch.length && (nItems + n > FOLD_MAX_ITEMS || nBytes + b > FOLD_MAX_BYTES)) {
        if (Date.now() > deadline) { out.code = 'TIME_CAP'; batch = []; break; }
        if (!(await foldWrite(st, head, batch, out))) { batch = []; break; }
        batch = []; nItems = 0; nBytes = 0;
      }
      batch.push(g); nItems += n; nBytes += b;
    }
    if (batch.length && !(await foldWrite(st, head, batch, out))) break;
    if (out.write_fail || out.verify_fail || out.code === 'TIME_CAP') break;
  }
  const after = await listMonth(st, head);
  out.left = after ? after.lines.length : -1;
  return out;
}
// 한 번 실행 — 접두어마다(예: ['doclog','reclog']) 그달 + 전달(KST — nowMs 기준). { ok, logs:[foldMonth 결과…], ms } · ok = 모두 목록·접은 문서 읽기 성공(시간 상한으로 끊긴 것은 실패 아님)
async function foldRun(st, prefixes, nowMs, deadline) {
  const start = Date.now(), cap = Number.isFinite(deadline) ? deadline : start + FOLD_RUN_CAP_MS;
  const cur = kstMonth(nowMs), prev = prevMonth(cur), logs = [];
  for (const p of prefixes) for (const mon of [prev, cur]) logs.push(await foldMonth(st, p + ':' + mon, nowMs, cap));
  return { ok: logs.every(function (x) { return x.ok; }), logs: logs, ms: Date.now() - start };
}

module.exports = { append, readMonth, listMonth, foldMonth, foldRun, lineKey, kstMonth, prevMonth, LINE_TAG, FOLD_TAG, READ_POOL, FOLD_AGE_MS, FOLD_MAX_ITEMS, FOLD_MAX_BYTES, FOLD_RUN_CAP_MS };
