'use strict';
// 29 판④-4 월말명세서 AI 판독(PM 11/14 13:3x '배포 때 바로 켬' · '칸 가림 + 출력 걸러냄') — 그림·스캔·팩스 명세서 → 초안 줄(how 'vision')
// 순서: 쪽 그림(RGBA) → 계산서 쪽은 빼고(빨강·파랑 테두리 색 또는 글자층 '세금계산서'·'승인번호' — 계산서 합계는 보안 HTML·XML 길로) →
//       거래처 양식별 개인정보 칸을 흰 칸으로 가림(이름·전화·계좌·사업자번호·주소 — 차량번호 칸은 남김, 10월 표본 실측 비율 + 여유) → JPEG →
//       Claude(명세 줄만 JSON, 개인정보는 내지 말라는 지시) → 서버가 다시 걸러냄(전화·계좌·주민·사업자번호 꼴 + 회원 이름 + 다른 달 줄).
// 가림은 '알려진 스캔 양식에 대한 최선'이다 — 사진·모르는 양식은 가림 없이 가고 출력 걸러내기만 지킨다(PM 11/14 답에 적은 그대로).
const S = require('./stmt');
const { callApiStream, responseText, ApiError } = require('./claude');

const MODEL = function () { return (process.env.CLAUDE_STMT_MODEL || 'claude-opus-5-5').trim(); };
const MAX_SIDE = 1600, JPEG_Q = 80, MAX_PAGES = 24, TIMEOUT_MS = 280000;

// ---- 가림 칸(쪽 비율 [x0, y0, x1, y1]) — 10월 스캔 실측(29 자료 원본형식_20261114.md · 11/14 눈금 그림), 위치 흔들림 ±2%를 넉넉히 덮음
// all: 모든 쪽 머리·바닥 띠(인쇄 시각·내려받기 경로(PC 계정 이름)·메일 주소 URL(로그인 키 든 것 포함))
const BAND = [[0, 0, 1, 0.035], [0, 0.955, 1, 1]];
const MASKS = {
  v07: { portrait: [[0.42, 0.11, 1, 0.295], [0, 0.72, 1, 0.785]] },                               // 가온 명세표: 공급자 칸(등록번호·상호·성명·주소·전화·팩스) · 입금계좌 줄
  v06: { portrait: [[0.14, 0.08, 0.31, 0.95]], first: true },                                     // 영남 주유현황 1쪽: 이름 열(손글씨 장부 쪽은 가림 없음 — 열 자리가 일정하지 않음)
  v08: { portrait: [[0.18, 0.125, 1, 0.146], [0.62, 0.146, 1, 0.166], [0.03, 0.163, 1, 0.216]] }, // 포항모터스 거래명세서: 소유자·주소 줄 · 소유자 전화 · 공급자 칸(사업자번호·대표·주소·전화·FAX·작성자) — 차량번호 줄(10.5~12.5%)은 남김
  v09: { portrait: [[0.03, 0.235, 1, 0.318], [0.05, 0.64, 1, 0.715]] },                            // 현대상용 정비명세서: 정비사업자 칸 · 작성자·대표이사 줄 — 차량번호 줄은 남김
  v01: { landscape: [[0.04, 0.6, 0.3, 0.84]], portrait: [[0.17, 0.025, 0.385, 0.285]] },          // 스피드 잔액 확인서: 공급자 칸(사업자번호·대표·주소·담당·전화) — 10월 실물은 세로 쪽에 옆으로 누운 꼴(칸 = 가로 0.19~0.36·세로 0.04~0.26 실측) · 가로로 돌린 쪽은 그 자리를 돌린 칸
  v10: { portrait: [[0.2, 0.119, 0.8, 0.13]] },                                                    // 철탑 원장: 머리 작은 줄(사업자번호·전화·팩스·주소) — 그 아래 표 머리줄(13% 아래)은 남김(11/14 실물 확인)
  v03: { portrait: [[0.5, 0.165, 1, 0.225]] }                                                      // 신일 청구서: 대표자명·전화번호
};
function maskRects(vk, pageIdx, w, h) {
  const out = BAND.slice();
  const m = MASKS[vk];
  if (m && !(m.first && pageIdx > 0)) {
    const list = (w > h ? m.landscape : m.portrait) || [];
    list.forEach(function (r) { out.push(r); });
  }
  return out.map(function (r) { return [Math.floor(r[0] * w), Math.floor(r[1] * h), Math.ceil(r[2] * w), Math.ceil(r[3] * h)]; });
}
function paintWhite(rgba, w, h, rects) {
  rects.forEach(function (r) {
    const x0 = Math.max(0, r[0]), y0 = Math.max(0, r[1]), x1 = Math.min(w, r[2]), y1 = Math.min(h, r[3]);
    for (let y = y0; y < y1; y++) { let p = (y * w + x0) * 4; for (let x = x0; x < x1; x++, p += 4) { rgba[p] = 255; rgba[p + 1] = 255; rgba[p + 2] = 255; rgba[p + 3] = 255; } }
  });
}
// 계산서 쪽 판정 — 홈택스·보안메일 인쇄본은 빨강(공급자)·파랑(공급받는자) 테두리, 경영박사 계산서는 파랑 선이 쪽 전체 · 회색 스캔이면 글자층 낱말로
function colorStats(rgba, w, h) {
  let red = 0, blue = 0, n = 0;
  for (let p = 0; p < w * h * 4; p += 16) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2]; n++;
    if (r > 150 && g < 120 && b < 140 && r - g > 60) red++;
    else if (b > 140 && r < 110 && b - r > 60) blue++;
  }
  return { red: n ? red / n : 0, blue: n ? blue / n : 0 };
}
function isInvoicePage(stats, text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (/세금계산서/.test(t) && /(승인번호|공급받는자|작성일자)/.test(t)) return true;
  return (stats.red > 0.0015 && stats.blue > 0.0015) || stats.blue > 0.008;
}

// ---- 쪽 그림 준비: pages = [{ w, h, data(RGBA Uint8Array|Buffer), text }] → { images:[{buf, w, h, i}], skipped:[{i, why}] }
async function prepareImages(vk, pages) {
  const { Jimp } = require('jimp');
  const images = [], skipped = [];
  for (let i = 0; i < pages.length && images.length < MAX_PAGES; i++) {
    const p = pages[i];
    if (!p || !p.w || !p.h || !p.data) { skipped.push({ i: i, why: 'empty' }); continue; }
    const rgba = Buffer.from(p.data.buffer ? Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength) : p.data);   // 사본에 칠함
    if (isInvoicePage(colorStats(rgba, p.w, p.h), p.text)) { skipped.push({ i: i, why: 'invoice' }); continue; }
    paintWhite(rgba, p.w, p.h, maskRects(vk, i, p.w, p.h));
    const img = new Jimp({ width: p.w, height: p.h, data: rgba });
    const sc = Math.min(1, MAX_SIDE / Math.max(p.w, p.h));
    if (sc < 1) img.resize({ w: Math.round(p.w * sc), h: Math.round(p.h * sc) });
    images.push({ buf: await img.getBuffer('image/jpeg', { quality: JPEG_Q }), w: img.bitmap.width, h: img.bitmap.height, i: i });
  }
  if (pages.length > MAX_PAGES) skipped.push({ i: MAX_PAGES, why: 'too_many' });
  return { images: images, skipped: skipped };
}
// 사진(jpg·png) 한 장 → pages 꼴
async function pagesFromImage(buf) {
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  return [{ w: img.bitmap.width, h: img.bitmap.height, data: Buffer.from(img.bitmap.data), text: '' }];
}

// ---- 지시문
const KIND_HINT = { fuel: '주유(리터·단가·금액)', urea: '요소수', tire: '타이어', part: '부품', cover: '차량 덮개', tool: '작업용구', oil: '오일', wash: '세차', labor: '정비 공임' };
function buildPrompt(vendor, ym) {
  const kind = vendor && vendor.kind ? (KIND_HINT[vendor.kind] || vendor.kind) : '줄마다 다름';
  const tool = vendor && vendor.group === 'tool';
  return [
    '이 그림들은 거래처 "' + String(vendor && vendor.name || '') + '"가 우리 회사에 보낸 ' + ym + ' 거래명세서(또는 주유현황·원장·정비명세서)의 쪽들이다. 흰 칸은 가린 자리다.',
    '명세의 거래 줄만 JSON으로 옮겨라. 문서에 적힌 값만 — 추정·계산으로 채우지 말고, 안 보이거나 애매하면 null로 두고 note에 "확인 필요".',
    '절대 내지 말 것: 사람 이름, 전화·팩스 번호, 계좌번호, 사업자등록번호, 주민번호, 주소, 이메일. 이런 글이 품목·비고 칸에 섞여 있으면 그 부분은 빼고 적어라.',
    '빼야 할 줄: 소계·합계·월계·총계·전기이월·이월·입금·결제 줄(이것들은 sum·carry에만), 빈 줄, 계산서.',
    '칸: date = YYYY-MM-DD(' + ym + ' 안 — 월/일만 있으면 ' + ym.slice(0, 4) + '년), vraw = 그 줄의 차량 번호 글(예 "5288", "80버5474", "6441호" → "6441"; 없으면 ""), item = 품목·작업 내용(40자 안), ' +
      'qty = 수량(리터는 소수 그대로), unit = 단가, amt = 줄 금액(문서의 금액 칸 그대로 — 공급가액 칸이 따로 있으면 공급가액), vat = 줄 세액 칸이 있으면 그 값 아니면 null, note = 규격·비고(개인정보 빼고, 60자 안).',
    tool ? '작업용구 거래처다 — 차량 칸이 없으면 vraw "".' : '이 거래처 줄의 종류는 보통 ' + kind + '이다.',
    '정비명세서처럼 한 장에 차량 하나와 부품·작업 여러 줄이 있으면, 줄마다 같은 vraw·date(정비 완료일)를 붙이고 부품 줄과 작업(기술료·공임) 줄을 모두 적어라.',
    '손글씨 장부는 읽히는 줄만, 숫자가 애매하면 그 칸을 null로.',
    'sum = 문서에 적힌 합계(공급가 supply·세액 vat·합계 total — 없으면 null), carry = 잔액형이면 {prev 전기이월, month 당월, paid 입금, bal 잔액} 아니면 null.',
    '출력은 JSON 하나만: {"rows":[{"date":"","vraw":"","item":"","qty":null,"unit":null,"amt":null,"vat":null,"note":""}],"sum":{"supply":null,"vat":null,"total":null},"carry":null,"unread_pages":0}'
  ].join('\n');
}

// ---- 출력 걸러내기(서버 몫 — 지시를 어겨도 저장 전에 빠짐)
const SCRUB_RE = [/\d{6}\s*[-.·–—]?\s*[1-4]\d{6}/g, /0\d{1,2}[\s).·–—-]{0,2}\d{3,4}[\s.·–—-]\d{4}/g, /\b\d{3}-\d{2}-\d{5}\b/g, /\b\d{2,6}[-\s]\d{2,6}[-\s]\d{2,8}(?:[-\s]\d{1,8})?\b/g, /\d{10,}/g, /[\w.+-]+@[\w-]+\.[\w.-]+/g];
const INVIS_RE = new RegExp('[\u200b-\u200f\u2028\u2029\ufeff]', 'g');
function scrubText(s, names, max) {
  let t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(INVIS_RE, ' ');
  SCRUB_RE.forEach(function (re) { t = t.replace(re, ' '); });
  (names || []).forEach(function (n) { if (n && n.length >= 2) t = t.split(n).join(' '); });
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}
function num(v, frac) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s원₩]/g, ''));
  if (!isFinite(n)) return null;
  if (!frac) return Math.round(n);
  return Math.round(n * 10000) / 10000;
}
function normDate(s, ym) {
  const t = String(s || '').trim();
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(t);
  let y, mo, d;
  if (m) { y = m[1]; mo = m[2]; d = m[3]; }
  else if ((m = /^(\d{1,2})[-./](\d{1,2})$/.exec(t))) { y = ym.slice(0, 4); mo = m[1]; d = m[2]; }
  else if ((m = /^(\d{2})[-./](\d{1,2})[-./](\d{1,2})$/.exec(t))) { y = '20' + m[1]; mo = m[2]; d = m[3]; }
  else return '';
  const out = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  return S.validDay(out) ? out : '';
}
function vrawOf(s) {
  const t = String(s || '').replace(/호$/, '').replace(/[^가-힣A-Za-z0-9 ()-]/g, '').trim();
  return t.slice(0, S.LIMIT.vraw);
}
// 모델 JSON → 공통 꼴(규격 29_판4_읽기부품_규격_20261114.md)
function toResult(json, opts) {
  const ym = opts.ym, names = opts.names || [], vendor = opts.vendor || {};
  const warn = [];
  const list = (json && Array.isArray(json.rows)) ? json.rows : [];
  const rows = []; let other = 0, dropped = 0;
  list.slice(0, S.LIMIT.rows).forEach(function (x) {
    if (!x || typeof x !== 'object') { dropped++; return; }
    const date = normDate(x.date, ym);
    if (date && date.slice(0, 7) !== ym) { other++; return; }
    const item = scrubText(x.item, names, S.LIMIT.item);
    let note = scrubText(x.note, names, S.LIMIT.note);
    if (!item && String(x.item == null ? '' : x.item).trim()) note = ('확인 필요(품목 글 지움) ' + note).trim().slice(0, S.LIMIT.note);   // 걸러내기가 품목을 통째로 지웠으면 사람이 보게
    const row = { date: date, vraw: vrawOf(x.vraw), item: item, kind: vendor.kind || '', qty: num(x.qty, true), unit: num(x.unit, true), amt: num(x.amt, false), vat: num(x.vat, false), note: note, how: 'vision' };
    if (!row.item && row.amt === null && row.qty === null) { dropped++; return; }
    if (S.piiScan([row.item, row.note, row.vraw])) { row.item = ''; row.note = '확인 필요(개인정보 꼴 지움)'; }
    rows.push(row);
  });
  if (other) warn.push('다른 달 줄 ' + other + '개는 뺐습니다');
  if (dropped) warn.push('읽지 못한 줄 ' + dropped + '개');
  const sum = json && json.sum && typeof json.sum === 'object' ? { supply: num(json.sum.supply), vat: num(json.sum.vat), total: num(json.sum.total) } : null;
  const c = json && json.carry && typeof json.carry === 'object' ? json.carry : null;
  const carry = c && [c.prev, c.month, c.paid, c.bal].some(function (v) { return v !== null && v !== undefined && v !== ''; })
    ? { prev: num(c.prev) || 0, month: num(c.month) || 0, paid: num(c.paid) || 0, bal: num(c.bal) || 0 } : null;
  if (sum && sum.total !== null) {
    const amtSum = rows.reduce(function (s, r) { return s + (r.amt || 0) + (r.vat || 0); }, 0);
    const supSum = rows.reduce(function (s, r) { return s + (r.amt || 0); }, 0);
    if (amtSum !== sum.total && supSum !== sum.total && Math.round(supSum * 1.1) !== sum.total) warn.push('줄 합이 문서 합계와 다릅니다 — 붉은 칸을 확인하세요');
  }
  if (json && Number(json.unread_pages) > 0) warn.push('읽지 못한 쪽 ' + Number(json.unread_pages) + '장');
  return { ok: true, src: 'vision', vendor: { name: String(vendor.name || ''), bn: '' }, buyer_bn: '', ym_hint: ym, rows: rows, inv: null, carry: carry, sum: sum, warn: warn };
}
function parseJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}
// 판독 한 번: { ok, result, usage } | { ok:false, code }
async function readVision(images, vendor, ym, names) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, code: 'NO_API_KEY' };
  if (!images.length) return { ok: false, code: 'NO_PAGES' };
  const content = images.map(function (im) { return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.buf.toString('base64') } }; });
  content.push({ type: 'text', text: buildPrompt(vendor, ym) });
  let res;
  try { res = await callApiStream(key, { model: MODEL(), max_tokens: 16000, messages: [{ role: 'user', content: content }] }, TIMEOUT_MS); }
  catch (e) { return { ok: false, code: (e instanceof ApiError) ? ('CLAUDE_' + e.code) : 'CLAUDE_FAILED', retry: !!(e && e.retryable) }; }
  const json = parseJson(responseText(res));
  if (!json) return { ok: false, code: 'NO_JSON' };
  const u = res.usage || {};
  return { ok: true, result: toResult(json, { ym: ym, vendor: vendor, names: names }), usage: { in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0 }, model: MODEL() };
}

// 모르는 HTML(포항모터스 정비 .htm 등) — 글로 판독(그림 아님). 글은 부르는 쪽이 scrubText로 먼저 걸렀다
async function readText(txt, vendor, ym, names) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, code: 'NO_API_KEY' };
  if (!String(txt || '').trim()) return { ok: false, code: 'NO_TEXT' };
  const prompt = buildPrompt(vendor, ym).replace('이 그림들은', '아래 글은').replace(' 흰 칸은 가린 자리다.', ' 표 칸은 " | "로 나눴다.');
  let res;
  try { res = await callApiStream(key, { model: MODEL(), max_tokens: 16000, messages: [{ role: 'user', content: [{ type: 'text', text: prompt + '\n\n---\n' + txt }] }] }, TIMEOUT_MS); }
  catch (e) { return { ok: false, code: (e instanceof ApiError) ? ('CLAUDE_' + e.code) : 'CLAUDE_FAILED', retry: !!(e && e.retryable) }; }
  const json = parseJson(responseText(res));
  if (!json) return { ok: false, code: 'NO_JSON' };
  const u = res.usage || {};
  const out = toResult(json, { ym: ym, vendor: vendor, names: names });
  out.src = 'vision';
  return { ok: true, result: out, usage: { in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0 }, model: MODEL() };
}

module.exports = { readText, MASKS, BAND, maskRects, paintWhite, colorStats, isInvoicePage, prepareImages, pagesFromImage, buildPrompt, scrubText, normDate, vrawOf, toResult, parseJson, readVision, MAX_PAGES };
