'use strict';
// 서류 차이 재기(v410, 계약 D4 1일차 — 설계 §5 diff 단위 "xlsx=채움 셀(zip/xml 직접 파싱) · docx=문단 · 서류 목록=추가/삭제/건너뜀 집합").
// 내장 모듈만(zlib) — 외부 npm 없음(중국계 금지 규칙·저자 확인 부담 회피). 수식·병합셀(비앵커)·글상자는 '비교 불가'로 센다(0% 오판 금지, D0 §1).
// 반환 값에는 셀 값·문단 본문을 넣지 않는다(좌표·횟수·비율만) — 짝 블롭에 개인정보가 실리지 않게 하는 구조적 장치.
const zlib = require('zlib');

// ---- zip(중앙 디렉터리 기준, 로컬 헤더 폴백) ----
// v456(원장 C066): 항목당 풀기 상한 64MB — 상한 없이 풀면 작은 압축 항목 하나가 수백 MB로 풀려 그 호출이 메모리 초과로 죽었다(서류 처리·학습 짝 — 로그인 뒤 경로).
//   넘는 항목은 null(아래 catch — 깨진 항목과 같은 '비교 불가'). gw-data hwpxExtractText도 이 값을 쓴다. 실제 양식 xml은 수 MB 안.
const ZIP_ENTRY_MAX = 64 * 1024 * 1024;
// v456 검토(C066 — 항목당 상한만으로는 못 막음): 파일 하나에서 푸는 총량 128MB·항목 수 2000까지 · 중앙 디렉터리 여러 줄이 같은 로컬 헤더를 가리키면(겹친 zip 폭탄 —
//   작은 파일 하나가 이름만 다른 64MB 버퍼 수십 개로 풀렸다) 처음 한 줄만 푼다. 예산을 다 쓰면 남은 항목은 null(비교 불가) — 실제 양식은 수 MB·항목 수십 개.
//   gw-data hwpxExtractText도 같은 예산(zipBudget)을 쓴다.
const ZIP_TOTAL_MAX = 128 * 1024 * 1024, ZIP_ENTRIES_MAX = 2000;
function zipBudget() {
  let used = 0;
  return {
    left: function () { return ZIP_TOTAL_MAX - used; },
    // 압축 항목 하나 풀기 — 남은 예산과 항목 상한 중 작은 값까지. 넘거나 깨졌으면 null(예산을 다 썼으면 풀지 않음)
    inflate: function (data) {
      const cap = Math.min(ZIP_ENTRY_MAX, ZIP_TOTAL_MAX - used);
      if (cap <= 0) return null;
      try { const b = zlib.inflateRawSync(data, { maxOutputLength: cap }); used += b.length; return b; } catch (e) { used += cap; return null; }   // 넘친 항목은 상한만큼 쓴 것으로 센다(되풀이로 예산을 비켜 가지 않게)
    },
    take: function (b) { if (!b) return null; if (b.length > ZIP_TOTAL_MAX - used) return null; used += b.length; return b; },   // 저장(0) 항목도 예산에 센다
  };
}
// want(이름 또는 정규식)를 주면 그 항목만 푼다 — 표식 읽기처럼 한 항목만 필요할 때
function zipEntries(buf, want) {
  const out = {};
  const skip = function (name) { return !!want && !(typeof want === 'string' ? name === want : want.test(name)); };
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;
  const bud = zipBudget();
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p--) { if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; } }
  if (eocd >= 0) {
    const n = Math.min(buf.readUInt16LE(eocd + 10), ZIP_ENTRIES_MAX), cdOff = buf.readUInt32LE(eocd + 16);
    const seenLho = {};
    let p = cdOff;
    for (let i = 0; i < n && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
      const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
      const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
      if (!skip(name) && !seenLho[lho] && lho + 30 <= buf.length && buf.readUInt32LE(lho) === 0x04034b50) {
        seenLho[lho] = 1;   // v456 검토: 같은 로컬 헤더를 다시 가리키는 줄은 건너뜀(겹친 항목)
        const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
        const ds = lho + 30 + lnl + lel, data = buf.slice(ds, ds + csize);
        out[name] = method === 8 ? bud.inflate(data) : (method === 0 ? bud.take(data) : null);
        if (out[name] && usize && out[name].length !== usize) out[name] = null;
      }
      p += 46 + nl + el + cl;
    }
    if (want || Object.keys(out).length) return out;
  }
  // 폴백: 로컬 헤더 순회(크기가 헤더에 있는 파일만)
  let p = 0, cnt = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50 && cnt++ < ZIP_ENTRIES_MAX) {
    const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26), el = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nl).toString('utf8'), ds = p + 30 + nl + el;
    if (!csize) break;
    if (skip(name)) { p = ds + csize; continue; }
    out[name] = method === 8 ? bud.inflate(buf.slice(ds, ds + csize)) : bud.take(buf.slice(ds, ds + csize));
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
// v456 검토(C066): 통합 문서 하나에서 읽는 칸·공유 문자열 수 상한 — 압축 폭탄은 128MB 예산 안에서도 서로 다른 칸 230만 개를 만들어 칸 표 하나로 1GB를 넘겼다(함수 메모리 초과).
//   넘으면 그 파일은 ok:false TOO_MANY_CELLS(비교 불가 — 짝 찾기 null·박스 판독 글 없음). 실제 양식은 900~2,200칸(레포 시험 산출·차량 현황표 실측).
const XLSX_CELLS_MAX = 200000;
function parseSheetXml(xml, shared, cnt) {
  const cells = {};
  const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
  while ((m = cre.exec(xml))) {
    if (cnt && ++cnt.n > XLSX_CELLS_MAX) break;
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
// v456 검토(C066 — 예산이 호출마다 새로 잡힘): 같은 Buffer 객체는 한 번만 풀고 읽는다(WeakMap — 그 Buffer가 살아 있는 동안만, 요청이 끝나면 함께 풀림).
//   cdocLearnPair·gw-parse-background는 같은 최종본 Buffer로 matchScore를 후보마다(최대 12+1번) 부르고 그 뒤 xlsxCellDiff를 또 부른다 —
//   종전엔 부를 때마다 압축 폭탄을 128MB까지 다시 풀고 수백만 칸을 다시 읽어 동기 시간 제한에 걸렸다. 돌려준 값은 읽기만 한다(호출부가 고치지 않음).
const MEMO_XLSX = new WeakMap(), MEMO_DOCX = new WeakMap(), MEMO_HWPX = new WeakMap();
function memoBuf(map, buf, fn) {
  if (!Buffer.isBuffer(buf)) return fn(buf);
  if (map.has(buf)) return map.get(buf);
  const r = fn(buf); map.set(buf, r); return r;
}
// 전 시트 — 비교에 쓰는 셀 좌표는 '시트명!A1'(시트 없는 'A1'은 첫 시트 — 옛 평면 배열 호환)이라 시트 이름으로 찾는다. 반환 {ok, sheets:{이름:{cells, merged}}, first, names, cells, merged(첫 시트 — 종전 호환)}
function xlsxCells(buf) { return memoBuf(MEMO_XLSX, buf, xlsxCellsRaw); }
function xlsxCellsRaw(buf) {
  const z = zipEntries(buf);
  const wb = z['xl/workbook.xml'] ? z['xl/workbook.xml'].toString('utf8') : '';
  const rels = z['xl/_rels/workbook.xml.rels'] ? z['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
  const shared = [], cnt = { n: 0 };   // v456 검토: 칸 + 공유 문자열 수(XLSX_CELLS_MAX)
  const tooMany = { ok: false, code: 'TOO_MANY_CELLS', sheets: {}, names: [], first: '', cells: {}, merged: [] };
  if (z['xl/sharedStrings.xml']) { const ss = z['xl/sharedStrings.xml'].toString('utf8'); const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(ss))) { if (++cnt.n > XLSX_CELLS_MAX) return tooMany; shared.push(textOf(m[1])); } }
  const sheets = {}, names = [];
  const sre = /<sheet\b([^>]*)\/?>/g; let m;
  while ((m = sre.exec(wb))) {
    if (cnt.n > XLSX_CELLS_MAX) return tooMany;
    const a = m[1]; const nm = /\bname="([^"]*)"/.exec(a), rid = /\br:id="([^"]+)"/.exec(a) || /\bid="([^"]+)"/.exec(a);
    if (!nm || !rid) continue;
    const rr = new RegExp('<Relationship\\b[^>]*\\bId="' + rid[1] + '"[^>]*\\bTarget="([^"]+)"').exec(rels) || new RegExp('<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="' + rid[1] + '"').exec(rels);
    const path = rr ? rr[1].replace(/^\/?(xl\/)?/, 'xl/') : '';
    if (!path || !z[path]) continue;
    const name = xmlUnesc(nm[1]); names.push(name); sheets[name] = parseSheetXml(z[path].toString('utf8'), shared, cnt);
  }
  if (!names.length && z['xl/worksheets/sheet1.xml']) { names.push('Sheet1'); sheets.Sheet1 = parseSheetXml(z['xl/worksheets/sheet1.xml'].toString('utf8'), shared, cnt); }
  if (cnt.n > XLSX_CELLS_MAX) return tooMany;
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
  let compared = 0, changed = 0, unc = 0, blankBoth = 0; const rc = [], ru = [];
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
    // v456(원장 T427 — 11/4 측정보고 §3): 초안도 빈칸(비우는 칸 'b' 또는 빈 값)·최종본도 빈칸인 칸은 분모에서 뺀다 — 종전엔 '안 바뀐 칸'으로 세어
    //   빈칸이 많은 양식(해체신고 9.1% ↔ 실효 96.2%)의 간극이 낮게 나왔다. 뺀 수는 blank_both로만(좌표 없음)
    if ((ty === 'b' || normS(want) === '') && normS(f.v) === '') { blankBoth++; return; }
    compared++;
    let same;
    if (ty === 'b') same = normS(f.v) === '';
    else if (ty === 'n') same = f.t === 'blank' ? normS(want) === '' : sameNum(f.v, want);
    else same = normS(f.v) === normS(want);
    if (!same) { changed++; rc.push(ref); }
  });
  return { ok: true, kind: 'xlsx_cell', compared: compared, changed: changed, uncomparable: unc, blank_both: blankBoth, ratio: compared ? Math.round(1000 * changed / compared) / 1000 : null, refs_changed: rc.slice(0, 200), refs_uncomparable: ru.slice(0, 100) };
}

// ---- docx 문단 ----
function docxParas(buf) { return memoBuf(MEMO_DOCX, buf, docxParasRaw); }
function docxParasRaw(buf) {
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
// 초안 ↔ 최종 문단 집합. 같은 문단 수 L(LCS) 기준 removed=초안−L, added=최종−L. 본문은 내보내지 않는다.
const PARA_CAP = 3000;
function paraDiff(A, B, kind) {
  const a = A.slice(0, PARA_CAP), b = B.slice(0, PARA_CAP);
  const L = lcsLen(a, b);
  const removed = a.length - L, added = b.length - L;
  return { ok: true, kind: kind, n_draft: a.length, n_final: b.length, same: L, removed: removed, added: added, compared: a.length, changed: removed, uncomparable: 0, ratio: a.length ? Math.round(1000 * Math.max(removed, added) / Math.max(a.length, b.length, 1)) / 1000 : null };
}
function docxParaDiff(draftBuf, finalBuf) {
  const A = docxParas(draftBuf), B = docxParas(finalBuf);
  if (!A || !B) return { ok: false, code: 'NO_DOCUMENT_XML', kind: 'docx_para', compared: 0, changed: 0, uncomparable: 0 };
  return paraDiff(A, B, 'docx_para');
}
// ---- hwpx 문단(v424, 브리핑 1단계) ---- Contents/section*.xml의 hp:p마다 hp:t 글자. 표 칸 안 문단도 각각 한 문단(문단 안에 문단이 있어 스택으로 읽는다). 한글에서 다시 저장해 런이 쪼개져도 글자는 같다.
function hwpxParas(buf) { return memoBuf(MEMO_HWPX, buf, hwpxParasRaw); }
function hwpxParasRaw(buf) {
  const z = zipEntries(buf, /^Contents\/section\d+\.xml$/i);
  const num = function (n) { return Number((/section(\d+)\.xml$/i.exec(n) || [0, 0])[1]); };
  const names = Object.keys(z).sort(function (a, b) { return num(a) - num(b); });
  if (!names.length) return null;
  const out = [];
  names.forEach(function (n) {
    if (!z[n]) return;
    const xml = z[n].toString('utf8'), stack = [];
    const re = /<hp:p\b[^>]*?(\/?)>|<\/hp:p>|<hp:t\b[^>]*\/>|<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/g; let m;
    while ((m = re.exec(xml))) {
      const tok = m[0];
      if (tok.charAt(1) === '/') { if (stack.length) { const s = normS(xmlUnesc(stack.pop())); if (s) out.push(s); } }
      else if (tok.indexOf('<hp:p') === 0) { if (m[1] !== '/') stack.push(''); }
      else if (m[2] !== undefined && stack.length) stack[stack.length - 1] += m[2].replace(/<hp:(?:tab|fwSpace|nbSpace|lineBreak)\b[^>]*\/?>/g, ' ').replace(/<[^>]+>/g, '');
    }
  });
  return out;
}
function hwpxParaDiff(draftBuf, finalBuf) {
  const A = hwpxParas(draftBuf), B = hwpxParas(finalBuf);
  if (!A || !B) return { ok: false, code: 'NO_SECTION', kind: 'hwpx_para', compared: 0, changed: 0, uncomparable: 0 };
  return paraDiff(A, B, 'hwpx_para');
}
// ---- hwpx 칸(토큰) 비교(P1 판16 · 원장 T396 — 계약 학습 2차) ----
// 앱은 hwpx 양식 글자 안의 {{칸 이름}}을 값으로 바꿔 초안을 만든다(index.html fillHwpxTemplate — 칸이 든 문단만 고치고 문단 수는 그대로).
// 서버에 남은 빈 양식(tpl:<양식>) · 초안 · 최종본 세 파일의 문단을 읽어
//   ① 양식 문단 ↔ 초안 문단(같은 차례)으로 초안의 칸 값을 되읽고 — 문단 수가 다르거나 칸 없는 문단이 1할 넘게 다르면 양식이 초안 때와 다름(TPL_CHANGED, 칸 비교 전체 불가)
//   ② 초안 ↔ 최종본 문단을 LCS로 맞춘다(빈 글 문단·칸만 있는 문단은 기준점에서 뺌) — 그대로 남은 문단의 칸은 '안 바뀜'. 맞지 않은 틀 칸 문단은 앞뒤로 맞은 문단 사이 구간에서 찾는다:
//      그 틀로 읽히는 최종 문단이 최종본 전체(LCS로 맞은 문단 빼고)에서 하나뿐이고 그것이 구간 안일 때만 그 문단 · 틀이 짧으면 같은 차례 짝도 그 문단이어야(판16 3차).
//      한 칸의 틀로 다른 칸의 양식·초안 문단이 읽히면(같은 틀·앞뒤가 겹치는 틀 — 수량/수량합계·원/만원) 두 칸 다 비교 불가.
// 비교 불가(칸 단위): 틀 글자 없이 칸만 있는 문단(표 칸 — 셀 주소로 짝지을 때까지 읽지 않음) · 같은 틀 글자가 양식에 둘 이상 · 글상자 안 칸 · 두 칸이 글자 없이 붙음 ·
//   틀을 못 찾음(문단을 고쳐 씀·지움·표 구조 변경) · 칸 사이 글자가 값 안에도 있음 · 같은 칸이 문단마다 다른 값. 원칙: 틀리게 세느니 비교 불가(판16 2차 검토 — 씨앗 고정 퍼징 servertest P1 판16 ①-3).
// 띄어쓰기만 다른 것은 같은 값으로 본다(normS와 같은 뜻). 반환에는 칸 이름·횟수만(값 없음) — 값은 hwpxTokRows(허용 칸만)가 워커에만 준다.
// 외부 npm 없음(내장 zlib만 — 이 파일 머리말). 문단 수 상한 TOK_PARA_CAP(LCS 표 Uint16 — 1500×1500 = 4.5MB).
const TOK_PARA_CAP = 1500, TOK_PARA_LEN = 2000, TOK_PER_PARA = 12;
const TOK_RE = /\{\{([^{}]{1,40})\}\}/g;
const MEMO_HWPXI = new WeakMap();
// 문단마다 {s: 글자(normS), box: 글상자 안인가} — 빈 문단도 넣는다(빈 칸 값만 든 문단이 빠지면 양식과 차례가 어긋난다). hwpxParas와 같은 읽기 + 글상자(hp:drawText) 표시.
function hwpxParaItems(buf) { return memoBuf(MEMO_HWPXI, buf, hwpxParaItemsRaw); }
function hwpxParaItemsRaw(buf) {
  const z = zipEntries(buf, /^Contents\/section\d+\.xml$/i);
  const num = function (n) { return Number((/section(\d+)\.xml$/i.exec(n) || [0, 0])[1]); };
  const names = Object.keys(z).sort(function (a, b) { return num(a) - num(b); });
  if (!names.length) return null;
  const out = [], OVER = { over: true };   // 판16 검토 ②: 문단(·열린 문단)을 담을 때마다 상한을 본다 — 빈 문단 수백만 개 압축 파일이 배열로 수백 MB가 되기 전에 TOO_MANY_PARAS
  for (const n of names) {
    if (!z[n]) return null;   // 풀지 못한 구역이 있으면 차례를 믿을 수 없다
    const xml = z[n].toString('utf8'), stack = []; let box = 0;
    const re = /<hp:p\b[^>]*?(\/?)>|<\/hp:p>|<hp:drawText\b[^>]*?(\/?)>|<\/hp:drawText>|<hp:t\b[^>]*\/>|<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/g; let m;
    while ((m = re.exec(xml))) {
      const tok = m[0];
      if (tok === '</hp:p>') { if (stack.length) { const x = stack.pop(); out.push({ s: normS(xmlUnesc(x.t)), box: x.box }); } }
      else if (tok === '</hp:drawText>') { if (box > 0) box--; }
      else if (tok.indexOf('<hp:drawText') === 0) { if (m[2] !== '/') box++; }
      else if (tok.indexOf('<hp:p') === 0) { if (m[1] !== '/') stack.push({ t: '', box: box > 0 }); else out.push({ s: '', box: box > 0 }); }
      else if (m[3] !== undefined && stack.length) { const x = stack[stack.length - 1]; x.t += m[3].replace(/<hp:(?:tab|fwSpace|nbSpace|lineBreak)\b[^>]*\/?>/g, ' ').replace(/<[^>]+>/g, ''); if (x.t.length > TOK_PARA_LEN * 8) return OVER; }
      if (out.length + stack.length > TOK_PARA_CAP) return OVER;
    }
  }
  return out;
}
function stripWs(s) { return String(s || '').replace(/\s+/g, ''); }
// 양식 문단 글자 → {lits:[칸 앞·사이·뒤 글자], toks:[칸 이름]} (칸 없으면 null)
function tokSplit(s) {
  const lits = [], toks = []; let last = 0, m; TOK_RE.lastIndex = 0;
  while ((m = TOK_RE.exec(s))) { lits.push(s.slice(last, m.index)); toks.push(m[1].trim()); last = m.index + m[0].length; }
  if (!toks.length) return null;
  lits.push(s.slice(last));
  return { lits: lits, toks: toks };
}
// 틀 글자로 문단에서 칸 값 읽기(앞에서부터 가장 짧게 — 정규식 되짚기 없음). 맞지 않으면 null. 값은 원문 띄어쓰기를 살려 앞뒤만 다듬는다.
function tokRead(sp, text) {
  const o = String(text || ''), pos = []; let st = '';
  for (let i = 0; i < o.length; i++) { if (!/\s/.test(o[i])) { st += o[i]; pos.push(i); } }
  const L = sp.lits.map(stripWs), k = L.length - 1;
  if (st.indexOf(L[0]) !== 0) return null;
  // 판16 검토 ③: 칸 사이 글자가 문단 글에 양식보다 많이 나오면(값 안에 같은 글자 — '갑 및 을') 어디서 끊을지 모른다 = 못 읽음
  const cnt = function (h, s) { let c = 0, q = h.indexOf(s); while (q >= 0) { c++; q = h.indexOf(s, q + s.length); } return c; };
  const tplLit = L.join('\u0001');
  for (let j = 1; j < k; j++) { if (L[j] && cnt(st, L[j]) > cnt(tplLit, L[j])) return null; }
  let p = L[0].length; const vals = [];
  for (let j = 1; j <= k; j++) {
    let q;
    if (j === k) { if (st.length - L[k].length < p || st.slice(st.length - L[k].length) !== L[k]) return null; q = st.length - L[k].length; }
    else { if (!L[j]) return null; q = st.indexOf(L[j], p); if (q < 0) return null; }
    vals.push(q > p ? o.slice(pos[p], pos[q - 1] + 1).trim() : '');
    p = q + L[j].length;
  }
  return vals;
}
// LCS 짝(차례 유지) — a·b는 띄어쓰기 지운 글자 배열. 반환 ma[i] = 맞은 b 차례(없으면 -1)
function lcsPairs(a, b) {
  const n = a.length, m = b.length, W = m + 1, t = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * W + j] = a[i] === b[j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1]);
  const ma = new Array(n).fill(-1); let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { ma[i] = j; i++; j++; } else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) i++; else j++; }
  return ma;
}
// 핵심 — 칸마다 {name, st: same|changed|unc|blank, d(초안 값), f(최종 값)}. 값은 호출부가 밖으로 내보내지 않는다.
function hwpxTokCore(tplBuf, draftBuf, finalBuf) {
  const T = hwpxParaItems(tplBuf), D = hwpxParaItems(draftBuf), F = hwpxParaItems(finalBuf);
  if (!T || !D || !F) return { ok: false, code: 'NO_SECTION' };
  if (T.over || D.over || F.over || T.length > TOK_PARA_CAP || D.length > TOK_PARA_CAP || F.length > TOK_PARA_CAP) return { ok: false, code: 'TOO_MANY_PARAS' };
  const sp = T.map(function (x) { return x.s.length <= TOK_PARA_LEN ? tokSplit(x.s) : null; });
  if (!sp.some(Boolean)) return { ok: false, code: 'NO_TOKENS' };
  if (T.length !== D.length) return { ok: false, code: 'TPL_CHANGED' };
  // ① 양식이 초안 때와 같은가 — 칸 없는 문단 9할 이상 같음 · 칸 문단 절반 이상 틀이 맞음
  let plain = 0, plainSame = 0, tokP = 0, tokOk = 0; const dv = new Array(T.length).fill(null);
  for (let i = 0; i < T.length; i++) {
    if (!sp[i]) { plain++; if (stripWs(T[i].s) === stripWs(D[i].s)) plainSame++; continue; }
    tokP++; dv[i] = tokRead(sp[i], D[i].s); if (dv[i]) tokOk++;
  }
  if ((plain && plainSame / plain < 0.9) || tokOk * 2 < tokP) return { ok: false, code: 'TPL_CHANGED' };
  // ② 초안 ↔ 최종본 맞추기
  // 판16 검토 ①: 틀 글자 없이 칸만 있는 문단(표 칸 '{{품명}}')은 LCS 짝에서 뺀다 — 빈 값이면 다른 빈 문단과, 값이 같으면 다른 칸과 짝이 되어 값이 엉뚱한 칸에 붙거나 사라졌다. 구간 짝으로만 읽는다.
  // 판16 2차 검토(11/15): 칸만 있는 문단은 값을 아예 읽지 않는다(아래 bare → 비교 불가 — 표 칸은 셀 주소로 짝지을 때까지). 빈 글 문단도 LCS 기준점에서 뺀다
  //   (빈 문단끼리 짝이 되면 옆 칸의 최종 문단을 기준점이 가져가 직원이 넣은 문단이 칸에 붙었다). 같은 틀 글자가 양식에 둘 이상인 칸 문단도 비교 불가(서로 값이 바뀌어 읽힘).
  const bare = sp.map(function (x) { return !!x && !stripWs(x.lits.join('')); });
  // 판16 3차 검토 ①(양식 단계): 한 칸의 틀로 다른 칸 문단(양식 글 또는 초안 글)이 읽히면 두 칸 다 비교 불가 —
  //   같은 틀('수량: {{a}}'/'수량: {{b}}')·앞부분이 겹치는 틀('수량 {{가}}'/'수량합계 {{나}}')·뒷부분이 겹치는 틀('{{가}} 원'/'{{나}} 만원')을 함께 거른다.
  const tokIdx = []; for (let i = 0; i < sp.length; i++) if (sp[i] && !bare[i]) tokIdx.push(i);
  if (tokIdx.length > 400) return { ok: false, code: 'TOO_MANY_TOKENS' };
  const conf = new Array(T.length).fill(false);
  tokIdx.forEach(function (i) { tokIdx.forEach(function (j) { if (i !== j && (tokRead(sp[i], T[j].s) || tokRead(sp[i], D[j].s))) { conf[i] = true; conf[j] = true; } }); });
  const a = D.map(function (x, i) { const s = stripWs(x.s); return (bare[i] || !s) ? '\u0000d' + i : s; }), b = F.map(function (x, j) { const s = stripWs(x.s); return s ? s : '\u0000f' + j; });
  const ma = lcsPairs(a, b), lcsF = {}, usedF = {};   // lcsF = LCS로 맞은 최종 문단 · usedF = 이 돌기에서 칸 문단으로 집은 최종 문단
  for (let i = 0; i < ma.length; i++) if (ma[i] >= 0) lcsF[ma[i]] = 1;
  const occ = {};   // 칸 이름 → [{st, d, f}]
  const put = function (nm, st, d, f) { (occ[nm] = occ[nm] || []).push({ st: st, d: d, f: f }); };
  for (let i = 0; i < T.length; i++) {
    const s0 = sp[i]; if (!s0) continue;
    const unc = function () { s0.toks.forEach(function (nm, k) { put(nm, 'unc', dv[i] ? dv[i][k] : '', ''); }); };
    const adj = s0.lits.slice(1, -1).some(function (l) { return !stripWs(l); });   // 칸 둘이 글자 없이 붙음
    if (T[i].box || D[i].box || !dv[i] || adj || s0.toks.length > TOK_PER_PARA) { unc(); continue; }
    if (bare[i] || conf[i]) { unc(); continue; }   // 2차 검토 ①: 틀 없는 칸 문단 = 읽지 않음 · 3차 ①: 틀이 다른 칸 문단을 읽음(같은·겹치는 틀) = 어느 칸인지 가를 수 없음
    let fv = null;   // 같은 칸이 여러 번 나오면 초안 값이 모두 같아야 한다(아래 모음에서 검사)
    if (ma[i] >= 0) { if (F[ma[i]].box) { unc(); continue; } fv = dv[i].slice(); }
    else {
      let lo = -1, hi = F.length, ilo = -1, ihi = T.length;
      for (let x = i - 1; x >= 0; x--) if (ma[x] >= 0) { lo = ma[x]; ilo = x; break; }
      for (let x = i + 1; x < ma.length; x++) if (ma[x] >= 0) { hi = ma[x]; ihi = x; break; }
      const candF = [], gapD = [];
      for (let y = lo + 1; y < hi; y++) if (!lcsF[y]) candF.push(y);
      for (let x = ilo + 1; x < ihi; x++) if (ma[x] < 0) gapD.push(x);
      let pick = -1;
      // 같은 차례 짝 = 구간의 안 맞은 초안 문단이 **전부 칸 문단이고** 수가 양쪽 같을 때만(판16 검토 ① — 칸 없는 문단이 섞이면 지우고 더한 문단과 칸을 가를 수 없다). 틀리게 세느니 비교 불가.
      //   2차 검토: 틀 글자가 2자 이상이면(양식 안에 같은 틀이 없음은 위에서 확인) 구간에서 그 틀로 읽히는 문단을 먼저 찾는다 — 차례가 바뀐 틀 칸도 제 값. 틀이 짧으면 같은 차례 짝(틀 읽기로 확인)
      //   3차 검토 ②(구간 단계): 그 틀로 읽히는 최종 문단이 구간 안에 정확히 하나일 때만 인정(둘 이상 = 직원이 같은 틀 줄을 더 넣음 등 — 비교 불가). 짧은 틀의 같은 차례 짝도 같은 조건
      //   3차 확인: 셈은 구간만이 아니라 최종본 전체(LCS로 맞은 문단 빼고)에서 — 차례가 기준점 너머로 바뀐 원래 문단 + 구간에 넣은 같은 틀 새 줄을 가른다. 하나뿐인 그 문단이 구간 안에 있어야 인정
      const readersAll = []; for (let y = 0; y < F.length; y++) { if (!lcsF[y] && tokRead(s0, F[y].s)) readersAll.push(y); }
      const readers = readersAll.filter(function (y) { return y > lo && y < hi; });
      if (readersAll.length !== 1 || readers.length !== 1) { unc(); continue; }
      if (stripWs(s0.lits.join('')).length >= 2) pick = readers[0];
      else if (candF.length === gapD.length && gapD.every(function (x) { return !!sp[x]; }) && candF[gapD.indexOf(i)] === readers[0]) pick = readers[0];
      if (pick === undefined || pick < 0 || usedF[pick] || F[pick].box) { unc(); continue; }
      fv = tokRead(s0, F[pick].s);
      if (!fv) { unc(); continue; }   // 2차 검토 ③: 같은 차례로 짝지은 최종 문단도 그 틀대로 읽혀야 인정(틀 글자가 안 맞으면 비교 불가)
      usedF[pick] = 1;
    }
    s0.toks.forEach(function (nm, k) {
      const d = dv[i][k], f = fv[k];
      put(nm, stripWs(d) === stripWs(f) ? (stripWs(d) === '' ? 'blank' : 'same') : 'changed', d, f);
    });
  }
  const toks = Object.keys(occ).map(function (nm) {
    const L = occ[nm], ds = {}; L.forEach(function (o) { if (o.st !== 'unc') ds[stripWs(o.d)] = 1; });
    if (Object.keys(ds).length > 1) return { name: nm, st: 'unc', d: '', f: '' };   // 같은 칸이 문단마다 다른 값 = 되읽기를 믿을 수 없다
    const ch = L.filter(function (o) { return o.st === 'changed'; })[0];
    if (ch) return { name: nm, st: 'changed', d: ch.d, f: ch.f };
    const sm = L.filter(function (o) { return o.st === 'same'; })[0];
    if (sm) return { name: nm, st: 'same', d: sm.d, f: sm.f };
    const bl = L.filter(function (o) { return o.st === 'blank'; })[0];
    if (bl) return { name: nm, st: 'blank', d: '', f: '' };
    return { name: nm, st: 'unc', d: L[0].d, f: '' };
  });
  return { ok: true, toks: toks };
}
// 판16 검토 ④: 빈 양식 지문 — 한글 양식 초안을 남길 때 그때 양식(tpl:<양식>의 data)의 지문을 초안 메타(tpl_sha)에 적고, 짝 지을 때 지금 양식 지문과 다르면 TPL_CHANGED
//   (양식을 다시 올려 칸 이름이 바뀌면 옛 값이 새 이름으로 읽혔다). 지문이 없는 옛 초안은 종전처럼 문단 수·같음 비율로 판정. 내장 crypto.
function tplFinger(b64) { return require('crypto').createHash('sha256').update(String(b64 || ''), 'utf8').digest('hex').slice(0, 16); }
function hwpxTokDiff(tplBuf, draftBuf, finalBuf) {
  let c; try { c = hwpxTokCore(tplBuf, draftBuf, finalBuf); } catch (e) { c = { ok: false, code: 'TOK_THREW' }; }
  if (!c.ok) return { ok: false, code: c.code, kind: 'hwpx_tok', compared: 0, changed: 0, uncomparable: 0, refs_changed: [], refs_uncomparable: [] };
  let compared = 0, changed = 0, unc = 0, blank = 0; const rc = [], ru = [];
  c.toks.forEach(function (t) {
    if (t.st === 'unc') { unc++; ru.push(t.name); return; }
    if (t.st === 'blank') { blank++; return; }
    compared++; if (t.st === 'changed') { changed++; rc.push(t.name); }
  });
  if (!compared && !blank) return { ok: false, code: 'NO_TOKEN_MATCH', kind: 'hwpx_tok', compared: 0, changed: 0, uncomparable: unc, refs_changed: [], refs_uncomparable: ru.slice(0, 100) };
  return { ok: true, kind: 'hwpx_tok', compared: compared, changed: changed, uncomparable: unc, blank_both: blank, ratio: compared ? Math.round(1000 * changed / compared) / 1000 : null, refs_changed: rc.slice(0, 200), refs_uncomparable: ru.slice(0, 100) };
}
// 허용 칸의 (초안 값, 최종 값) 짝 — cellRows와 같은 꼴(워커가 모델에 보낼 행). 허용 밖 칸은 바뀜 여부만(값 없음). 비교 불가 칸은 빠진다.
function hwpxTokRows(tplBuf, draftBuf, finalBuf, allowToks) {
  const A = {}; (Array.isArray(allowToks) ? allowToks : []).forEach(function (r) { A[String(r).trim()] = 1; });
  let c; try { c = hwpxTokCore(tplBuf, draftBuf, finalBuf); } catch (e) { c = { ok: false, code: 'TOK_THREW' }; }
  if (!c.ok) return { ok: false, code: c.code, rows: [], hidden_changed: [], hidden_same_n: 0 };
  const rows = [], hidden_changed = []; let hidden_same = 0;
  c.toks.forEach(function (t) {
    if (t.st === 'unc') return;
    const same = t.st !== 'changed';
    if (A[t.name]) rows.push({ ref: t.name, draft: normS(t.d).slice(0, 120), final: normS(t.f).slice(0, 120), visible: true, same: same });
    else if (!same) hidden_changed.push(t.name); else hidden_same++;
  });
  return { ok: true, rows: rows, hidden_changed: hidden_changed.slice(0, 100), hidden_same_n: hidden_same };
}
// ---- xlsx 파일 대 파일(v424) ---- 채움 맵이 없는 초안(안전 패킷·낙찰률 내역서)과, AI가 안 채운 칸을 직원이 얼마나 고쳤는지. 수식 칸은 계산값이 따라 바뀌므로 비교하지 않는다. 좌표·횟수만 돌려준다.
function xlsxFileDiff(draftBuf, finalBuf, skipRefs) {
  const dx = xlsxCells(draftBuf), fx = xlsxCells(finalBuf);
  if (!dx.ok || !fx.ok) return { ok: false, code: dx.ok ? fx.code : dx.code, kind: 'xlsx_file', compared: 0, changed: 0, uncomparable: 0, refs_changed: [], refs_uncomparable: [] };
  const skip = {}; (Array.isArray(skipRefs) ? skipRefs : []).forEach(function (r) { const s = splitRef(r); if (s) skip[(s.sheet || dx.first) + '!' + s.ref] = 1; });
  let compared = 0, changed = 0, unc = 0; const rc = [], ru = [];
  dx.names.forEach(function (nm) {
    const ds = dx.sheets[nm], fs = fx.sheets[nm], refs = {};
    Object.keys(ds.cells).forEach(function (k) { refs[k] = 1; });
    if (fs) Object.keys(fs.cells).forEach(function (k) { refs[k] = 1; });
    Object.keys(refs).forEach(function (ref) {
      const key = nm + '!' + ref; if (skip[key]) return;
      const a = ds.cells[ref] || { t: 'blank', v: '' };
      if (!fs) { if (a.t !== 'f' && normS(a.v) !== '') { unc++; ru.push(key); } return; }   // 최종본에 그 시트가 없음
      const b = fs.cells[ref] || { t: 'blank', v: '' };
      if (a.t === 'f' || b.t === 'f' || a.t === 'e' || b.t === 'e' || inMergedNonAnchor(ref, fs.merged)) return;
      const av = normS(a.v), bv = normS(b.v);
      if (av === '' && bv === '') return;
      compared++;
      const same = (a.t === 'n' && b.t === 'n') ? sameNum(a.v, b.v) : av === bv;
      if (!same) { changed++; rc.push(key); }
    });
  });
  return { ok: true, kind: 'xlsx_file', compared: compared, changed: changed, uncomparable: unc, ratio: compared ? Math.round(1000 * changed / compared) / 1000 : null, refs_changed: rc.slice(0, 200), refs_uncomparable: ru.slice(0, 100) };
}
// 내용 일치율 0~1 — 표식이 사라진 파일이 어느 초안의 수정본인지 찾는다. 0 = 다른 서류(형식이 다르거나 시트가 안 겹침). null = 비교할 수 없는 형식(hwp·스캔 pdf·초안에 재료 없음).
const MATCH_FAM = { xlsx: 1, hwpx: 1, docx: 1 };
function matchScore(rec, draftExt, finalExt, finalBuf) {
  if (!rec || !finalBuf) return null;
  const db = rec.data ? Buffer.from(String(rec.data), 'base64') : null;
  if (finalExt === 'xlsx') {
    const fill = rec.fill ? flattenEdits(rec.fill.edits) : null;
    if (fill && fill.length) {
      const d = xlsxCellDiff(fill, finalBuf); if (!d.ok) return null;
      // v456(T427): 간극 분모에서 뺀 빈칸↔빈칸(blank_both)은 '어느 초안의 수정본인가' 판정에서는 종전대로 '같은 칸'으로 센다 —
      //   짝 찾기(PAIR_MATCH_MIN·PAIR_STAGE_MIN 문턱)가 바뀌지 않게(빈칸이 많은 초안의 수정본이 NO_MATCH로 떨어지던 것을 막음). 종전 식과 같은 값.
      const same = d.compared + (d.blank_both || 0);
      const tot = same + d.uncomparable; if (!tot) return null;
      if (same / tot < 0.5) return 0;   // 채운 시트 대부분이 없다 = 다른 서류
      if (!same) return null;
      return 1 - Math.round(1000 * d.changed / same) / 1000;
    }
    if (db && draftExt === 'xlsx') { const d = xlsxFileDiff(db, finalBuf); if (!d.ok) return null; if (d.ratio === null) return d.uncomparable > 0 ? 0 : null; return 1 - d.ratio; }
    return MATCH_FAM[draftExt] ? 0 : null;
  }
  if (!MATCH_FAM[finalExt]) return null;
  if (draftExt !== finalExt) return (MATCH_FAM[draftExt] || draftExt === 'json') ? 0 : null;   // hwpx 파일 ↔ xlsx 초안
  if (!db) return null;
  const f = finalExt === 'hwpx' ? hwpxParas : docxParas;
  const A = f(db), B = f(finalBuf);
  if (!A || !B || !A.length || !B.length) return null;
  const a = A.slice(0, PARA_CAP), b = B.slice(0, PARA_CAP);
  return lcsLen(a, b) / Math.max(a.length, b.length);
}
// ---- 표식(v424) ---- 앱이 만든 파일의 문서 정보 키워드 칸(xlsx docProps/core.xml cp:keywords · hwpx Contents/content.hpf keyword)에 든 번호. 형식 JWG1.<계약>.<양식>.<난수>. 파일을 다시 저장해도 문서 정보는 남는 것이 보통이나, 사라지면 내용 일치율로 찾는다.
const GEN_SRC = 'JWG1\\.[A-Za-z0-9_-]{1,40}\\.[a-z0-9_]{1,30}\\.[a-z0-9]{6,16}';
const GEN_ALL = new RegExp(GEN_SRC, 'g'), GEN_ONE = new RegExp('^' + GEN_SRC + '$');
function genMarkOf(buf, ext) {
  const nm = ext === 'xlsx' ? 'docProps/core.xml' : (ext === 'hwpx' ? 'Contents/content.hpf' : '');
  if (!nm || !Buffer.isBuffer(buf)) return '';
  try { const b = zipEntries(buf, nm)[nm]; if (!b) return ''; const m = b.toString('utf8').match(GEN_ALL); return m ? m[m.length - 1] : ''; } catch (e) { return ''; }
}
function genMarkParse(mark) { const s = String(mark || ''); if (!GEN_ONE.test(s)) return null; const p = s.split('.'); return { cid: p[1], tpl: p[2], rand: p[3] }; }

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
    const f = sh.cells[sr.ref] || { t: 'blank', v: '' }; if (f.t === 'f' || f.t === 'e' || inMergedNonAnchor(sr.ref, sh.merged)) return;   // v456(T427): 병합 칸의 앵커 아닌 칸은 xlsxCellDiff처럼 뺀다(모델에 빈 값이 가던 것)
    const ty = String(e[2] || 's'), want = ty === 'b' ? '' : e[1];
    const same = ty === 'n' ? (f.t === 'blank' ? normS(want) === '' : sameNum(f.v, want)) : normS(f.v) === normS(want);
    if (A[ref]) rows.push({ ref: ref, draft: normS(want).slice(0, 120), final: normS(f.v).slice(0, 120), visible: true, same: same });
    else if (!same) hidden_changed.push(ref); else hidden_same++;
  });
  return { ok: true, rows: rows, hidden_changed: hidden_changed.slice(0, 100), hidden_same_n: hidden_same };
}
module.exports = { ZIP_ENTRY_MAX, ZIP_TOTAL_MAX, ZIP_ENTRIES_MAX, XLSX_CELLS_MAX, zipBudget, zipEntries, xlsxCells, xlsxCellDiff, xlsxFileDiff, docxParas, docxParaDiff, hwpxParas, hwpxParaDiff, hwpxParaItems, hwpxTokDiff, hwpxTokRows, tplFinger, TOK_PARA_CAP, matchScore, genMarkOf, genMarkParse, listDiff, gapScore, refRC, inMergedNonAnchor, splitRef, cellRows, flattenEdits };
