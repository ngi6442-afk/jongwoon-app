'use strict';
// 서류 차이 재기(v410, 계약 D4 1일차 — 설계 §5 diff 단위 "xlsx=채움 셀(zip/xml 직접 파싱) · docx=문단 · 서류 목록=추가/삭제/건너뜀 집합").
// 내장 모듈만(zlib) — 외부 npm 없음(중국계 금지 규칙·저자 확인 부담 회피). 수식·병합셀(비앵커)·글상자는 '비교 불가'로 센다(0% 오판 금지, D0 §1).
// 반환 값에는 셀 값·문단 본문을 넣지 않는다(좌표·횟수·비율만) — 짝 블롭에 개인정보가 실리지 않게 하는 구조적 장치.
const zlib = require('zlib');

// ---- zip(중앙 디렉터리 기준, 로컬 헤더 폴백) ----
function zipEntries(buf) {
  const out = {};
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p--) { if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; } }
  if (eocd >= 0) {
    const n = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
    let p = cdOff;
    for (let i = 0; i < n && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
      const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
      const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
      if (lho + 30 <= buf.length && buf.readUInt32LE(lho) === 0x04034b50) {
        const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
        const ds = lho + 30 + lnl + lel, data = buf.slice(ds, ds + csize);
        try { out[name] = method === 8 ? zlib.inflateRawSync(data) : (method === 0 ? data : null); } catch (e) { out[name] = null; }
        if (out[name] && usize && out[name].length !== usize) out[name] = null;
      }
      p += 46 + nl + el + cl;
    }
    if (Object.keys(out).length) return out;
  }
  // 폴백: 로컬 헤더 순회(크기가 헤더에 있는 파일만)
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26), el = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nl).toString('utf8'), ds = p + 30 + nl + el;
    if (!csize) break;
    try { out[name] = method === 8 ? zlib.inflateRawSync(buf.slice(ds, ds + csize)) : buf.slice(ds, ds + csize); } catch (e) { out[name] = null; }
    p = ds + csize;
  }
  return out;
}
function xmlUnesc(s) {
  return String(s || '').replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function textOf(xml) { let s = ''; const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) s += m[1]; return xmlUnesc(s); }

// ---- xlsx 셀 ----
// 첫 시트(workbook.xml → rels → 대상, 없으면 sheet1.xml). 반환 {ok, cells:{A1:{t:'s'|'n'|'b'|'f'|'e', v}}, merged:[[r1,c1,r2,c2]], sheet, code}
// 값(v)은 비교에만 쓰고 호출부가 밖으로 내보내지 않는다.
function colNum(col) { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n; }
function refRC(ref) { const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(String(ref || '').toUpperCase()); return m ? [Number(m[2]), colNum(m[1])] : null; }
function parseSheetXml(xml, shared) {
  const cells = {};
  const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
  while ((m = cre.exec(xml))) {
    const attrs = m[1] || '', body = m[2] || '';
    const r = /\br="([A-Z]{1,3}\d{1,7})"/.exec(attrs); if (!r) continue;
    const t = (/\bt="([^"]+)"/.exec(attrs) || [0, 'n'])[1];
    if (/<f\b/.test(body)) { cells[r[1]] = { t: 'f', v: '' }; continue; }
    const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body); let v = vm ? xmlUnesc(vm[1]) : '';
    if (t === 's') { cells[r[1]] = { t: 's', v: shared[Number(v)] !== undefined ? shared[Number(v)] : '' }; }
    else if (t === 'inlineStr') cells[r[1]] = { t: 's', v: textOf(body) };
    else if (t === 'str') cells[r[1]] = { t: 's', v: v };
    else if (t === 'b') cells[r[1]] = { t: 'b', v: v === '1' ? 'TRUE' : 'FALSE' };
    else if (t === 'e') cells[r[1]] = { t: 'e', v: v };
    else cells[r[1]] = v === '' ? { t: 'blank', v: '' } : { t: 'n', v: Number(v) };
  }
  const merged = []; const mre = /<mergeCell\b[^>]*\bref="([A-Z]{1,3}\d{1,7}):([A-Z]{1,3}\d{1,7})"/g;
  while ((m = mre.exec(xml))) { const a = refRC(m[1]), b = refRC(m[2]); if (a && b) merged.push([a[0], a[1], b[0], b[1]]); }
  return { cells: cells, merged: merged };
}
// 전 시트 — 비교에 쓰는 셀 좌표는 '시트명!A1'(시트 없는 'A1'은 첫 시트 — 옛 평면 배열 호환)이라 시트 이름으로 찾는다. 반환 {ok, sheets:{이름:{cells, merged}}, first, names, cells, merged(첫 시트 — 종전 호환)}
function xlsxCells(buf) {
  const z = zipEntries(buf);
  const wb = z['xl/workbook.xml'] ? z['xl/workbook.xml'].toString('utf8') : '';
  const rels = z['xl/_rels/workbook.xml.rels'] ? z['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
  const shared = [];
  if (z['xl/sharedStrings.xml']) { const ss = z['xl/sharedStrings.xml'].toString('utf8'); const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(ss))) shared.push(textOf(m[1])); }
  const sheets = {}, names = [];
  const sre = /<sheet\b([^>]*)\/?>/g; let m;
  while ((m = sre.exec(wb))) {
    const a = m[1]; const nm = /\bname="([^"]*)"/.exec(a), rid = /\br:id="([^"]+)"/.exec(a) || /\bid="([^"]+)"/.exec(a);
    if (!nm || !rid) continue;
    const rr = new RegExp('<Relationship\\b[^>]*\\bId="' + rid[1] + '"[^>]*\\bTarget="([^"]+)"').exec(rels) || new RegExp('<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="' + rid[1] + '"').exec(rels);
    const path = rr ? rr[1].replace(/^\/?(xl\/)?/, 'xl/') : '';
    if (!path || !z[path]) continue;
    const name = xmlUnesc(nm[1]); names.push(name); sheets[name] = parseSheetXml(z[path].toString('utf8'), shared);
  }
  if (!names.length && z['xl/worksheets/sheet1.xml']) { names.push('Sheet1'); sheets.Sheet1 = parseSheetXml(z['xl/worksheets/sheet1.xml'].toString('utf8'), shared); }
  if (!names.length) return { ok: false, code: 'NO_SHEET', sheets: {}, names: [], first: '', cells: {}, merged: [] };
  return { ok: true, sheets: sheets, names: names, first: names[0], cells: sheets[names[0]].cells, merged: sheets[names[0]].merged };
}
// '시트명!A1' → {sheet, ref}. 시트 없으면 첫 시트. 좌표가 아니면 null(__drop_drawings__ 같은 특수 항목).
function splitRef(full) {
  const s = String(full || '').trim(); const i = s.lastIndexOf('!');
  const sheet = i >= 0 ? s.slice(0, i).replace(/^'|'$/g, '') : '', ref = (i >= 0 ? s.slice(i + 1) : s).toUpperCase();
  return refRC(ref) ? { sheet: sheet, ref: ref } : null;
}
function inMergedNonAnchor(ref, merged) {
  const rc = refRC(ref); if (!rc) return false;
  for (let i = 0; i < merged.length; i++) { const g = merged[i]; if (rc[0] >= g[0] && rc[0] <= g[2] && rc[1] >= g[1] && rc[1] <= g[3] && !(rc[0] === g[0] && rc[1] === g[1])) return true; }
  return false;
}
function normS(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }
// v419 채움 맵 정규화(한 곳) — 앱 xgBuildEdits·초안 fill.edits의 실제 형태는 {시트:[[셀,값,유형]], __drop_drawings__:[시트]} 객체. 비교는 평면 [['시트!셀',값,유형]]을 쓴다.
// 옛 평면 배열은 그대로 돌려준다. 채움 맵이 아니면 null(호출부가 NO_FILL·kind none 처리). 저장 형식은 바꾸지 않는다(읽을 때만 편다).
function flattenEdits(edits) {
  if (Array.isArray(edits)) return edits;
  if (!edits || typeof edits !== 'object') return null;
  const out = [];
  Object.keys(edits).forEach(function (sheet) {
    if (sheet === '__drop_drawings__' || !Array.isArray(edits[sheet])) return;
    edits[sheet].forEach(function (e) { if (Array.isArray(e) && e[0] && e[2] !== 'f') out.push([sheet + '!' + e[0], e[1], e[2]]); });   // v420 유형 f = 글자 크기만 바꾸는 줄(값을 안 쓰므로 비교 대상 아님)
  });
  return out;
}
function sameNum(a, b) { const x = Number(a), y = Number(b); if (!isFinite(x) || !isFinite(y)) return normS(a) === normS(b); return Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-9); }
// 채움 맵 edits [[셀, 값, 's'|'n'|'b']] ↔ 최종본 xlsx. 반환은 좌표·횟수만.
function xlsxCellDiff(edits, finalBuf) {
  const E = Array.isArray(edits) ? edits : [];
  const fx = xlsxCells(finalBuf);
  if (!fx.ok) return { ok: false, code: fx.code, kind: 'xlsx_cell', compared: 0, changed: 0, uncomparable: E.length, refs_changed: [], refs_uncomparable: [] };
  let compared = 0, changed = 0, unc = 0; const rc = [], ru = [];
  const seen = {};
  E.forEach(function (e) {
    if (!Array.isArray(e) || !e[0]) return;
    const sr = splitRef(e[0]); if (!sr) return;
    const ref = (sr.sheet ? sr.sheet + '!' : '') + sr.ref; if (seen[ref]) return; seen[ref] = 1;
    const ty = String(e[2] || 's'), want = e[1];
    const sh = sr.sheet ? fx.sheets[sr.sheet] : fx.sheets[fx.first];
    if (!sh) { unc++; ru.push(ref); return; }   // 최종본에 그 시트가 없음(이름 바뀜·삭제) = 비교 불가
    const f = sh.cells[sr.ref] || { t: 'blank', v: '' };
    if (f.t === 'f' || f.t === 'e' || inMergedNonAnchor(sr.ref, sh.merged)) { unc++; ru.push(ref); return; }
    compared++;
    let same;
    if (ty === 'b') same = normS(f.v) === '';
    else if (ty === 'n') same = f.t === 'blank' ? normS(want) === '' : sameNum(f.v, want);
    else same = normS(f.v) === normS(want);
    if (!same) { changed++; rc.push(ref); }
  });
  return { ok: true, kind: 'xlsx_cell', compared: compared, changed: changed, uncomparable: unc, ratio: compared ? Math.round(1000 * changed / compared) / 1000 : null, refs_changed: rc.slice(0, 200), refs_uncomparable: ru.slice(0, 100) };
}

// ---- docx 문단 ----
function docxParas(buf) {
  const z = zipEntries(buf); const d = z['word/document.xml']; if (!d) return null;
  const xml = d.toString('utf8'); const out = []; const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g; let m;
  while ((m = re.exec(xml))) { let s = ''; const tr = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g; let t; while ((t = tr.exec(m[1]))) s += t[1]; s = normS(xmlUnesc(s)); if (s) out.push(s); }
  return out;
}
function lcsLen(a, b) {
  const n = a.length, m = b.length; if (!n || !m) return 0;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) { for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); const t = prev; prev = cur; cur = t; }
  return prev[m];
}
// 초안 docx ↔ 최종 docx 문단 집합. 같은 문단 수 L(LCS) 기준 removed=초안−L, added=최종−L. 본문은 내보내지 않는다.
function docxParaDiff(draftBuf, finalBuf) {
  const A = docxParas(draftBuf), B = docxParas(finalBuf);
  if (!A || !B) return { ok: false, code: 'NO_DOCUMENT_XML', kind: 'docx_para', compared: 0, changed: 0, uncomparable: 0 };
  const cap = 3000; const a = A.slice(0, cap), b = B.slice(0, cap);
  const L = lcsLen(a, b);
  const removed = a.length - L, added = b.length - L;
  return { ok: true, kind: 'docx_para', n_draft: a.length, n_final: b.length, same: L, removed: removed, added: added, compared: a.length, changed: removed, uncomparable: 0, ratio: a.length ? Math.round(1000 * Math.max(removed, added) / Math.max(a.length, b.length, 1)) / 1000 : null };
}

// ---- 서류 목록 집합 ----
// base = 골조 목록 이름 배열 · cur = 건별 항목 [{t|name, skip|skipped}] → 추가·삭제·건너뜀(이름은 양식명이라 개인정보 아님)
function listDiff(base, cur) {
  const B = (Array.isArray(base) ? base : []).map(function (x) { return normS(typeof x === 'string' ? x : (x && (x.t || x.name))); }).filter(Boolean);
  const C = (Array.isArray(cur) ? cur : []).map(function (x) { return { t: normS(typeof x === 'string' ? x : (x && (x.t || x.name))), skip: !!(x && (x.skip || x.skipped || x.na)) }; }).filter(function (x) { return x.t; });
  const bs = {}; B.forEach(function (t) { bs[t] = 1; }); const cs = {}; C.forEach(function (x) { cs[x.t] = 1; });
  const added = C.filter(function (x) { return !bs[x.t]; }).map(function (x) { return x.t; });
  const removed = B.filter(function (t) { return !cs[t]; });
  const skipped = C.filter(function (x) { return x.skip; }).map(function (x) { return x.t; });
  return { added: added.slice(0, 50), removed: removed.slice(0, 50), skipped: skipped.slice(0, 50), delta: added.length + removed.length + skipped.length, base_n: B.length };
}

// ---- 간극(D0 §1): ①셀 비율(가중 1) + ②목록 delta(0.5, 기준 목록 수로 정규화) + ③첨부 누락(0.5, 5건 상한) ----
function gapScore(cell, list, missing) {
  const r = (cell && cell.ok && typeof cell.ratio === 'number') ? cell.ratio : null;
  const ld = list ? Math.min(1, (Number(list.delta) || 0) / Math.max(Number(list.base_n) || 1, 1)) : 0;
  const ms = Math.min(1, (Number(missing) || 0) / 5);
  return { cell_ratio: r, list_delta: list ? (Number(list.delta) || 0) : null, missing: Number(missing) || 0, score: r === null ? null : Math.round(1000 * (r + 0.5 * ld + 0.5 * ms)) / 1000, comparable: r !== null };
}

// 허용 사전에 든 셀의 (초안 값, 최종 값) 짝 — 워커가 모델에 보낼 행. 허용 밖 셀은 바뀜 여부만(값 없음).
function cellRows(edits, finalBuf, allowRefs) {
  const A = {}; (Array.isArray(allowRefs) ? allowRefs : []).forEach(function (r) { const s = splitRef(r); if (s) A[(s.sheet ? s.sheet + '!' : '') + s.ref] = 1; });
  const fx = xlsxCells(finalBuf); const rows = [], hidden_changed = []; let hidden_same = 0; const seen = {};
  if (!fx.ok) return { ok: false, code: fx.code, rows: [], hidden_changed: [], hidden_same_n: 0 };
  (Array.isArray(edits) ? edits : []).forEach(function (e) {
    if (!Array.isArray(e) || !e[0]) return;
    const sr = splitRef(e[0]); if (!sr) return;
    const ref = (sr.sheet ? sr.sheet + '!' : '') + sr.ref; if (seen[ref]) return; seen[ref] = 1;
    const sh = sr.sheet ? fx.sheets[sr.sheet] : fx.sheets[fx.first]; if (!sh) return;
    const f = sh.cells[sr.ref] || { t: 'blank', v: '' }; if (f.t === 'f' || f.t === 'e') return;
    const ty = String(e[2] || 's'), want = ty === 'b' ? '' : e[1];
    const same = ty === 'n' ? (f.t === 'blank' ? normS(want) === '' : sameNum(f.v, want)) : normS(f.v) === normS(want);
    if (A[ref]) rows.push({ ref: ref, draft: normS(want).slice(0, 120), final: normS(f.v).slice(0, 120), visible: true, same: same });
    else if (!same) hidden_changed.push(ref); else hidden_same++;
  });
  return { ok: true, rows: rows, hidden_changed: hidden_changed.slice(0, 100), hidden_same_n: hidden_same };
}
module.exports = { zipEntries, xlsxCells, xlsxCellDiff, docxParas, docxParaDiff, listDiff, gapScore, refRC, inMergedNonAnchor, splitRef, cellRows, flattenEdits };
