'use strict';
// 29 판④ 부품 C — PDF 글자층 읽기(pdfjs-dist 레거시 Node 빌드, Mozilla, Apache-2.0).
// 순수 함수: Buffer → 쪽마다 글 조각 { x, y, w, h, str }(좌표 = 쪽 왼쪽 위 기준 pt, 회전 반영). 저장소·네트워크 없음.
// 워커 없이 돈다: Node에서 pdfjs는 '가짜 워커'(같은 스레드)를 쓰는데, 워커 모듈을 globalThis.pdfjsWorker에 미리 넣어
//   workerSrc 경로로 다시 import하지 않게 한다(Netlify 묶음 안에서 상대 경로가 깨지지 않도록).
// 글자층이 없는 그림 PDF(스캔·경영박사 메일 등)는 { ok:true, textless:true } — 부품 밖에서 AI 판독(vision)으로 넘긴다.
// 상한: 8MB · 쪽 30 · 글 조각 2만 · 20초. 넘으면 일부만 읽지 않고 실패로 돌려준다(줄이 조용히 빠지지 않게).

const LIM = { bytes: 8 * 1024 * 1024, pages: 30, items: 20000, ms: 20000, textlessChars: 4 };

let libP = null;
function loadLib() {
  if (!libP) {
    libP = (async function () {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      let base = '';
      try { base = require('path').dirname(require.resolve('pdfjs-dist/package.json')).replace(/\\/g, '/') + '/'; } catch (e) { base = ''; }
      return { pdfjs: pdfjs, base: base };
    })();
    libP.catch(function () { libP = null; });   // 실패하면 다음 호출에서 다시 시도
  }
  return libP;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise(function (_, rej) { t = setTimeout(function () { const e = new Error('timeout'); e.code = 'PDF_TIMEOUT'; rej(e); }, ms); })])
    .finally(function () { clearTimeout(t); });
}

function r2(n) { return Math.round(n * 100) / 100; }

// pdfText(buf) → { ok:true, pages:[{ w, h, items:[{x,y,w,h,str}] }] } | { ok:true, textless:true, pages:n } | { ok:false, code, why }
async function pdfText(buf, opt) {
  opt = opt || {};
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return { ok: false, code: 'BAD_INPUT', why: '파일 바이트가 아님' };
  if (buf.length > LIM.bytes) return { ok: false, code: 'TOO_BIG', why: 'PDF가 8MB를 넘음' };
  if (buf.length < 8 || Buffer.from(buf.subarray(0, 1024)).toString('latin1').indexOf('%PDF-') < 0) return { ok: false, code: 'NOT_PDF', why: 'PDF 파일이 아님' };
  let lib;
  try { lib = await loadLib(); } catch (e) { return { ok: false, code: 'PDF_LIB', why: 'PDF 읽기 모듈을 불러오지 못함' }; }
  const params = { data: new Uint8Array(buf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false };
  if (lib.base) { params.cMapUrl = lib.base + 'cmaps/'; params.cMapPacked = true; params.standardFontDataUrl = lib.base + 'standard_fonts/'; }
  const task = lib.pdfjs.getDocument(params);
  let doc = null;
  try {
    return await withTimeout((async function () {
      doc = await task.promise;
      if (doc.numPages > LIM.pages) return { ok: false, code: 'TOO_MANY_PAGES', why: '쪽이 ' + LIM.pages + '쪽을 넘음' };
      const pages = []; let n = 0, chars = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const pg = await doc.getPage(p);
        const vp = pg.getViewport({ scale: 1 });
        const tc = await pg.getTextContent();
        const items = [];
        for (let i = 0; i < tc.items.length; i++) {
          const it = tc.items[i];
          if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
          if (++n > LIM.items) return { ok: false, code: 'TOO_MANY_ITEMS', why: '글 조각이 ' + LIM.items + '개를 넘음' };
          const t = lib.pdfjs.Util.transform(vp.transform, it.transform);
          const h = Math.hypot(t[2], t[3]) || Math.abs(it.height || 0);
          // 글 기준선(y) → 글 높이 가운데로 옮겨 줄 묶기를 쉽게(같은 줄의 크기 다른 글자도 가운데는 비슷)
          items.push({ x: r2(t[4]), y: r2(t[5] - h / 2), w: r2(it.width || 0), h: r2(h), str: it.str });
          chars += it.str.replace(/\s/g, '').length;
        }
        pages.push({ w: r2(vp.width), h: r2(vp.height), items: items });
        if (pg.cleanup) pg.cleanup();
      }
      if (chars < LIM.textlessChars) return { ok: true, textless: true, pages: pages.length };
      return { ok: true, pages: pages };
    })(), opt.ms || LIM.ms);
  } catch (e) {
    const nm = e && e.name;
    if (e && e.code === 'PDF_TIMEOUT') return { ok: false, code: 'PDF_TIMEOUT', why: 'PDF 읽기가 너무 오래 걸림' };
    if (nm === 'PasswordException') return { ok: false, code: 'PDF_PASSWORD', why: '암호가 걸린 PDF' };
    return { ok: false, code: 'PDF_BAD', why: 'PDF를 열지 못함' };
  } finally {
    try { if (doc) await doc.destroy(); else await task.destroy(); } catch (e) { /* 정리 실패는 무시 */ }
  }
}

// ── 그림 PDF → 쪽마다 가장 큰 그림(RGBA) — AI 판독(stmtvision)으로 넘길 쪽 그림 ──
// canvas 없이: getOperatorList가 그림 칠하기 명령을 모으는 동안 pdfjs 워커(같은 스레드)가 DCT(JPEG)·Flate(예측자 포함)·회색·RGB·CMYK를
// 풀어 page.objs에 { width, height, kind, data }로 넣는다(Node에선 OffscreenCanvas가 없어 ImageBitmap이 아니라 바이트로 온다).
// kind 1 = 1비트 회색(줄마다 바이트 맞춤, 1 = 흰색) · 2 = RGB 24비트 · 3 = RGBA 32비트 → RGBA Buffer(w*h*4)로 바꾼다.
// 그림이 없는 쪽(글자 PDF)은 { w:0, h:0, data:null, text }. 상한: 쪽 maxPages(기본 28) · 그림 한 장 4000만 화소 · 입력 8MB.
const IMG = { maxPages: 28, maxPixels: 40000000, ms: 60000 };
function objGet(objs, id) {
  return new Promise(function (res) {
    try {
      if (objs.has && objs.has(id)) { res(objs.get(id)); return; }
      objs.get(id, function (v) { res(v); });
    } catch (e) { res(null); }
  });
}
function toRGBA(img) {
  const w = img.width, h = img.height, src = img.data, out = Buffer.alloc(w * h * 4);
  if (img.kind === 3) { if (src.length < w * h * 4) return null; out.set(src.subarray(0, w * h * 4)); return out; }
  if (img.kind === 2) {
    if (src.length < w * h * 3) return null;
    for (let i = 0, j = 0, n = w * h; i < n; i++, j += 3) { const o = i * 4; out[o] = src[j]; out[o + 1] = src[j + 1]; out[o + 2] = src[j + 2]; out[o + 3] = 255; }
    return out;
  }
  if (img.kind === 1) {
    const rb = (w + 7) >> 3;
    if (src.length < rb * h) return null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (src[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0, o = (y * w + x) * 4;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
    return out;
  }
  return null;
}
async function pdfPageImages(buf, maxPages, opt) {
  opt = opt || {};
  maxPages = maxPages > 0 ? Math.floor(maxPages) : IMG.maxPages;
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return { ok: false, code: 'BAD_INPUT' };
  if (buf.length > LIM.bytes) return { ok: false, code: 'TOO_BIG' };
  if (buf.length < 8 || Buffer.from(buf.subarray(0, 1024)).toString('latin1').indexOf('%PDF-') < 0) return { ok: false, code: 'NOT_PDF' };
  let lib;
  try { lib = await loadLib(); } catch (e) { return { ok: false, code: 'PDF_LIB' }; }
  const params = { data: new Uint8Array(buf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, isOffscreenCanvasSupported: false };
  if (lib.base) { params.cMapUrl = lib.base + 'cmaps/'; params.cMapPacked = true; params.standardFontDataUrl = lib.base + 'standard_fonts/'; }
  const OPS = lib.pdfjs.OPS, PAINT = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat];
  const task = lib.pdfjs.getDocument(params);
  let doc = null;
  try {
    return await withTimeout((async function () {
      doc = await task.promise;
      if (doc.numPages > maxPages && !opt.truncate) return { ok: false, code: 'TOO_MANY_PAGES' };
      const last = Math.min(doc.numPages, maxPages), more = doc.numPages - last;   // opt.truncate = 앞 maxPages쪽만 읽고 남은 쪽 수를 알림(29 판④ 검토 — AI 판독은 통째로 실패하지 않게)
      const pages = [];
      for (let p = 1; p <= last; p++) {
        const pg = await doc.getPage(p);
        const tc = await pg.getTextContent();
        const text = tc.items.map(function (it) { return it.str || ''; }).join(' ').replace(/\s+/g, ' ').trim();
        const ol = await pg.getOperatorList();
        let best = null;
        for (let i = 0; i < ol.fnArray.length; i++) {
          if (PAINT.indexOf(ol.fnArray[i]) < 0) continue;
          const a = ol.argsArray[i] || [];
          let img = null;
          if (ol.fnArray[i] === OPS.paintInlineImageXObject) img = a[0];
          else if (typeof a[0] === 'string') img = await objGet(a[0].indexOf('g_') === 0 ? pg.commonObjs : pg.objs, a[0]);
          if (!img || !img.width || !img.height || !img.data) continue;
          if (img.width * img.height > IMG.maxPixels) return { ok: false, code: 'IMAGE_TOO_LARGE' };
          if (!best || img.width * img.height > best.width * best.height) best = img;
        }
        let data = null;
        if (best) { data = toRGBA(best); if (!data) return { ok: false, code: 'IMAGE_KIND' }; }
        pages.push(data ? { w: best.width, h: best.height, data: data, text: text } : { w: 0, h: 0, data: null, text: text });
        if (pg.cleanup) pg.cleanup();
      }
      return { ok: true, pages: pages, more: more };
    })(), opt.ms || IMG.ms);
  } catch (e) {
    if (e && e.code === 'PDF_TIMEOUT') return { ok: false, code: 'PDF_TIMEOUT' };
    if (e && e.name === 'PasswordException') return { ok: false, code: 'PDF_PASSWORD' };
    return { ok: false, code: 'PDF_BAD' };
  } finally {
    try { if (doc) await doc.destroy(); else await task.destroy(); } catch (e) { /* 정리 실패는 무시 */ }
  }
}

// 줄 묶기 — y(글 가운데)가 tol 안이면 한 줄. 줄 안은 x 순. → [{ y, items, text }]
function groupLines(items, tol) {
  tol = tol == null ? 3 : tol;
  const s = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
  const lines = [];
  for (let i = 0; i < s.length; i++) {
    const it = s[i], last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= tol) { last.items.push(it); last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length; }
    else lines.push({ y: it.y, items: [it] });
  }
  lines.forEach(function (ln) {
    ln.items.sort(function (a, b) { return a.x - b.x; });
    ln.text = ln.items.map(function (x) { return x.str; }).join(' ').replace(/\s+/g, ' ').trim();
    ln.y = r2(ln.y);
  });
  return lines;
}

const RE_NUM = /^\(?-?\\?[\d,]+(\.\d+)?\)?$/;
function isNum(s) { return RE_NUM.test(String(s).replace(/\s/g, '')); }
// 숫자 글 → 수(쉼표·원 기호 빼고, 괄호 = 음수). 숫자 꼴이 아니면 null
function num(s) {
  let t = String(s == null ? '' : s).replace(/[\s₩\\원]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return isFinite(n) ? (neg ? -n : n) : null;
}

// 칸 나누기 — heads = [{ key, x, w }](머리 글 위치). 숫자 조각은 오른쪽 끝을 머리 오른쪽 끝에, 글 조각은 가운데를 머리 가운데에 가장 가깝게.
// 한 칸에 여러 조각이 오면 x 순으로 띄어 붙인다. maxDist를 넘게 먼 조각은 버린다. → { key: '글' }
function splitCols(lineItems, heads, maxDist) {
  maxDist = maxDist == null ? 80 : maxDist;
  const out = {}, bucket = {};
  lineItems.forEach(function (it) {
    const n = isNum(it.str);
    let best = null, bd = Infinity;
    heads.forEach(function (h) {
      const d = n ? Math.abs((it.x + it.w) - (h.x + h.w)) : Math.abs((it.x + it.w / 2) - (h.x + h.w / 2));
      if (d < bd) { bd = d; best = h; }
    });
    if (!best || bd > maxDist) return;
    (bucket[best.key] = bucket[best.key] || []).push(it);
  });
  Object.keys(bucket).forEach(function (k) {
    out[k] = bucket[k].sort(function (a, b) { return a.x - b.x; }).map(function (x) { return x.str.trim(); }).join(' ').replace(/\s+/g, ' ').trim();
  });
  return out;
}

module.exports = { LIM, IMG, pdfText, pdfPageImages, toRGBA, groupLines, splitCols, isNum, num };
