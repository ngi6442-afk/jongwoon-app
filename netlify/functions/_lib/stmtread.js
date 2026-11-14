'use strict';
// 29 판④ 월말명세서 원본 읽기 — 꼴 알아보기·나누기·마무리(거래처 대조·받는 회사·달 거르기). 부품: stmtnts·taxxml(계산서) · xlsbiff·stmtsinil(옛 엑셀) · pdftext·stmtpdfmap(글자 PDF) · stmtvision(AI 판독)
// 공통 결과 꼴 = 공유 메모 29_판4_읽기부품_규격_20261114.md
const S = require('./stmt');

// 받는 쪽(우리) 사업자번호 — 공개 번호(앱 화면·계산서에 찍힘). 국세청 보안 계산서 비밀번호 = 받는 쪽 사업자번호. env로 바꿀 수 있음(쉼표)
const CORP = [{ key: 'env', bn: '5068148535', name: '종운환경' }, { key: 'con', bn: '5068184827', name: '종운건설' }];
function corpList() {
  const e = String(process.env.STMT_CORP_BN || '').replace(/[^0-9,]/g, '');
  if (!e) return CORP;
  const l = e.split(',').filter(function (x) { return /^\d{10}$/.test(x); });
  return l.length ? l.map(function (bn, i) { return { key: i ? 'other' + i : 'env', bn: bn, name: i ? '다른 회사' : '종운환경' }; }) : CORP;
}

function head(buf, n) { return buf.slice(0, n).toString('latin1'); }
// 꼴: nts(국세청 보안 계산서 HTML) · xml(표준 전자세금계산서) · xls(OLE) · xlsx(zip — 지금 틀 없음) · pdf · image · html(그 밖 HTML — 포항모터스 정비 .htm 등) · ''
function sniff(buf, name) {
  if (!buf || buf.length < 8) return '';
  const h8 = buf.slice(0, 8).toString('hex');
  if (h8 === 'd0cf11e0a1b11ae1') return 'xls';
  if (head(buf, 5) === '%PDF-') return 'pdf';
  if (h8.indexOf('ffd8ff') === 0 || h8 === '89504e470d0a1a0a') return 'image';
  if (h8.indexOf('504b0304') === 0) return 'xlsx';
  const t = buf.slice(0, Math.min(buf.length, 400000)).toString('utf8');
  if (/id=["']idCriHeader["']/.test(t)) return 'nts';
  if (/^\s*(﻿)?<\?xml/.test(t) && /TaxInvoice/.test(t)) return 'xml';
  if (/<html|<table|<body/i.test(t)) return 'html';
  return '';
}

// 결과 마무리 — 거래처 이름 대조(공급자 상호에 거래처 낱말이 있는지) · 받는 회사(종운건설이면 경고) · 그 달 밖 줄 빼기 · 상한
function finish(res, ctx) {
  const out = Object.assign({ warn: [] }, res);
  out.warn = Array.isArray(res.warn) ? res.warn.slice(0, 20) : [];
  ctx = ctx || {};
  const vn = String(res.vendor && res.vendor.name || '').replace(/\s+/g, '');
  const hints = (ctx.vendor && Array.isArray(ctx.vendor.hint) ? ctx.vendor.hint : []).concat(ctx.vendor && ctx.vendor.name ? [String(ctx.vendor.name).replace(/\(.*\)/, '')] : []);
  if (vn && hints.length && !hints.some(function (h) { const k = String(h || '').replace(/\s+/g, ''); return k && (vn.indexOf(k) >= 0 || k.indexOf(vn) >= 0); })) {
    out.warn.unshift('다른 거래처 서류로 보입니다(서류의 공급자: ' + String(res.vendor.name).slice(0, 30) + ') — 맞는 거래처 상세에 넣었는지 확인하세요');
    out.vendor_mismatch = true;
  }
  if (res.buyer_bn) {
    const c = corpList().filter(function (x) { return x.bn === res.buyer_bn; })[0];
    if (!c) { out.warn.unshift('받는 회사가 우리 회사가 아닌 서류입니다'); out.buyer_other = true; }
    else if (c.key !== 'env') { out.warn.unshift('받는 회사가 ' + c.name + '인 서류입니다 — 종운환경 명세서에 넣지 마세요'); out.buyer_other = true; }
  }
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const keep = [], other = [];
  rows.forEach(function (r) { if (r && r.date && r.date.slice(0, 7) !== ctx.ym) other.push(r); else keep.push(r); });
  if (other.length) out.warn.push('그 달(' + ctx.ym + ') 밖 줄 ' + other.length + '개는 뺐습니다' + (res.ym_hint && res.ym_hint !== ctx.ym ? ' — 서류 기간 ' + res.ym_hint : ''));
  if (keep.length > S.LIMIT.rows) { out.warn.push('줄이 많아 ' + S.LIMIT.rows + '줄까지만'); keep.length = S.LIMIT.rows; }
  out.rows = keep.map(function (r) { return Object.assign({}, r, { kind: r.kind || (ctx.vendor && ctx.vendor.kind) || '' }); });
  if (res.vendor) out.vendor = { name: String(res.vendor.name || '').slice(0, 40) };   // 공급자 번호는 화면에 안 냄
  delete out.buyer_bn;
  return out;
}

// 글자로 읽히는 것은 바로 — { ok, result } | { ok, ai:'pdf'|'image'|'html' } | { ok:false, code, why }
async function readFile(buf, name, ctx) {
  const kind = sniff(buf, name);
  if (kind === 'nts') {
    const T = require('./taxxml');
    const r = await T.readNts(buf, corpList().map(function (x) { return x.bn; }));
    if (!r.ok) return { ok: false, code: r.code || 'NTS_FAILED', why: r.code === 'NO_KEY' ?'우리 회사 사업자번호로 열리지 않는 계산서입니다' : '' };
    return { ok: true, result: finish(r, ctx) };
  }
  if (kind === 'xml') {
    const T = require('./taxxml');
    const r = T.readTaxXml(buf);
    if (!r.ok) return { ok: false, code: r.code || 'XML_FAILED' };
    return { ok: true, result: finish(r, ctx) };
  }
  if (kind === 'xls') {
    const X = require('./stmtsinil');
    const r = X.readSinilXls(buf);
    if (!r.ok) return { ok: false, code: r.code || 'XLS_FAILED', why: r.code === 'UNKNOWN_LAYOUT' ? '아직 모르는 엑셀 양식입니다' : '' };
    // 신일 청구서는 머리 총금액 = 줄 합 = 계산서 합계(10월 실측) → 줄 금액이 부가세 포함 — 화면이 줄 금액 기준을 '부가세 포함'으로 바꾸게
    if (r.meta && r.meta.total_basis === 'same') r.basis = 'total';
    else if (r.meta && r.meta.total_basis === 'x1.1') r.basis = 'supply';
    return { ok: true, result: finish(r, ctx) };
  }
  if (kind === 'pdf') {
    const P = require('./stmtpdfmap');
    const r = await P.readPdf(buf);
    if (r.ok && !r.textless) return { ok: true, result: finish(r, ctx) };
    if (r.ok && r.textless) return { ok: true, ai: 'pdf' };
    if (r.code === 'UNKNOWN_LAYOUT') return { ok: true, ai: 'pdf' };   // 글자는 있지만 모르는 양식(스캔 OCR 글자층 포함) → 그림으로 판독
    return { ok: false, code: r.code || 'PDF_FAILED' };
  }
  if (kind === 'image') return { ok: true, ai: 'image' };
  if (kind === 'html') return { ok: true, ai: 'html' };
  if (kind === 'xlsx') return { ok: false, code: 'UNKNOWN_LAYOUT', why: '아직 모르는 엑셀(xlsx) 양식입니다 — 거래처 원본을 PM께 보내 주시면 틀을 더합니다' };
  return { ok: false, code: 'UNSUPPORTED_TYPE', why: 'PDF·그림(JPG·PNG)·엑셀·계산서 HTML·XML만 읽습니다' };
}

// HTML(모르는 양식) → 글(표는 칸을 ' | '로) — AI에 글로 보냄(그림 아님)
function htmlText(buf) {
  let s = buf.toString('utf8');
  const m = /charset=["']?(euc-kr|ks_c_5601-1987|cp949)/i.exec(s.slice(0, 3000));
  if (m) { try { s = new TextDecoder('euc-kr').decode(buf); } catch (e) {} }
  s = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' | ').replace(/<\/(tr|p|div|li|h\d)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, function (a, n) { return String.fromCharCode(Number(n)); });
  return s.split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).filter(Boolean).join('\n').slice(0, 60000);
}

// AI 판독(배경 함수) — mode pdf|image|html → { ok, result, skipped, usage } | { ok:false, code }
async function readByAi(buf, mode, ctx) {
  const V = require('./stmtvision');
  const textRead = async function (txt) {   // 글로 판독 — 줄바꿈 살린 채 개인정보 꼴·회원 이름을 먼저 지움(11/14 검토 med)
    const r = await V.readText(V.scrubText(txt, ctx.names || [], 60000, true), ctx.vendor || {}, ctx.ym, ctx.names || []);
    if (!r.ok) return r;
    return { ok: true, result: finish(r.result, ctx), usage: r.usage, skipped: [] };
  };
  if (mode === 'html') return await textRead(htmlText(buf));
  let pages, more = 0;
  if (mode === 'image') {
    try { pages = await V.pagesFromImage(buf); } catch (e) { return { ok: false, code: (e && e.code) || 'IMAGE_FAILED' }; }
  } else if (mode === 'pdf') {
    const P = require('./pdftext');
    const pi = await P.pdfPageImages(buf, V.MAX_PAGES, { truncate: true });
    if (!pi.ok) return { ok: false, code: pi.code || 'PDF_IMAGES_FAILED' };
    pages = pi.pages;
    more = Number(pi.more) || 0;   // 상한 뒤 못 읽은 쪽 수(경고로)
    // 그림이 없는 글자 PDF(모르는 양식) = 그림 대신 글로 판독(종전엔 빈 쪽으로 NO_PAGES — 11/14 검토 med)
    const txt = pages.map(function (p) { return p ? String(p.text || '') : ''; }).join('\n');
    if (!pages.some(function (p) { return p && p.w && p.data; }) && txt.replace(/\s+/g, '').length > 20) return await textRead(txt);
  } else return { ok: false, code: 'BAD_MODE' };
  const prep = await V.prepareImages(ctx.vk, pages, { photo: mode === 'image' });
  if (!prep.images.length) return { ok: false, code: prep.skipped.some(function (x) { return x.why === 'invoice'; }) ? 'ONLY_INVOICE' : 'NO_PAGES' };
  const r = await V.readVision(prep.images, ctx.vendor || {}, ctx.ym, ctx.names || []);
  if (!r.ok) return r;
  const res = finish(r.result, ctx);
  const cnt = function (w) { return prep.skipped.filter(function (x) { return x.why === w; }).length; };
  if (cnt('invoice')) res.warn.push('계산서 쪽 ' + cnt('invoice') + '장은 AI에 보내지 않았습니다(계산서 합계는 보안 계산서 HTML을 넣거나 손으로)');
  if (cnt('too_many') + more) res.warn.push('쪽이 많아 ' + V.MAX_PAGES + '쪽까지만 읽었습니다 — 나머지 ' + (cnt('too_many') + more) + '쪽은 따로 넣어 주세요');
  if (cnt('empty')) res.warn.push('그림이 없는 쪽 ' + cnt('empty') + '장은 읽지 않았습니다');
  return { ok: true, result: res, usage: r.usage, skipped: prep.skipped };
}

// ---- 29 판⑥ 거래처 찾기(PM 11/14 '목록에서 한꺼번에') — 파일 이름 → 글자로 읽히는 내용(공급자 상호) → PDF 글 전체 순. 한 곳만 걸릴 때만 정한다(둘 이상·없음 = null → 사람이 고름)
//   그림·스캔은 내용을 보지 않는다(AI에 보내려면 거래처별 가림 칸이 먼저 정해져야 함 — 가림 없이 보내지 않게)
function normKey(s) { return String(s == null ? '' : s).replace(/\(.*?\)/g, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[\s_\-.,()[\]]/g, '').toLowerCase(); }
function vendorKeys(v, min) { return [v.name].concat(Array.isArray(v.hint) ? v.hint : []).map(normKey).filter(function (k) { return k.length >= min; }); }
function matchVendor(t, vendors, min) {
  const n = normKey(t);
  if (!n) return null;
  const hit = vendors.filter(function (v) { return vendorKeys(v, min).some(function (k) { return n.indexOf(k) >= 0; }); });
  return hit.length === 1 ? hit[0] : null;
}
async function guessVendor(buf, name, vendors, ym) {
  const act = (vendors || []).filter(function (v) { return v && v.active !== false; });
  const byName = matchVendor(name, act, 2);
  if (byName) return { vk: byName.vk, how: 'name' };
  const kind = sniff(buf, name);
  try {
    if (kind === 'nts' || kind === 'xml' || kind === 'xls' || kind === 'pdf') {
      const r = await readFile(buf, name, { ym: ym, vk: '', vendor: null });
      const vn = r.ok && r.result && r.result.vendor && r.result.vendor.name;
      const v = vn ? matchVendor(vn, act, 2) : null;
      if (v) return { vk: v.vk, how: 'content' };
      if (kind === 'pdf') {
        const P = require('./pdftext');
        const t = await P.pdfText(buf);
        if (t.ok && !t.textless && Array.isArray(t.pages)) {
          const txt = t.pages.map(function (p) { return (p.items || []).map(function (i) { return i.str; }).join(' '); }).join(' ');
          const w = matchVendor(txt, act, 3);   // 글 전체는 주소·품목에 짧은 낱말(오천·영남)이 섞임 — 3자 이상 낱말만
          if (w) return { vk: w.vk, how: 'content' };
        }
      }
    }
  } catch (e) { /* 못 찾으면 사람이 고름 */ }
  return null;
}

module.exports = { CORP, corpList, sniff, finish, readFile, readByAi, htmlText, guessVendor, matchVendor, normKey };
