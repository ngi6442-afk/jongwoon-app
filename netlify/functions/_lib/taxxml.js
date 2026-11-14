'use strict';
// 체크 29 판④ 부품 A — 표준 전자세금계산서 XML → 원본 읽기 공통 꼴(규격 …/29_판4_읽기부품_규격_20261114.md).
// 순수 함수. XML 파서는 직접(외부 라이브러리 없음): 요소·속성·글·CDATA·주석·처리 지시·DOCTYPE 건너뜀,
//   엔티티 &amp; &lt; &gt; &quot; &apos; &#N; &#xH;만 풀고(사용자 정의 엔티티는 풀지 않음 — 폭탄 막기), 네임스페이스 접두어는 버린다.
// 읽는 칸(국세청 표준 v3 꼴, 실물 3개 구조 대조 11/14):
//   TaxInvoiceDocument/IssueDateTime(작성일 YYYYMMDD) · TaxInvoiceTradeSettlement/InvoicerParty/{ID, NameText}(공급자)
//   · InvoiceeParty/ID(받는 쪽) · SpecifiedMonetarySummation/{ChargeTotalAmount, TaxTotalAmount, GrandTotalAmount}
//   · TaxInvoiceTradeLineItem마다 PurchaseExpiryDateTime·NameText·InformationText(규격)·ChargeableUnitQuantity
//     ·UnitPrice/UnitAmount·InvoiceAmount·TotalTax/CalculatedAmount·DescriptionText(비고)
// 대표자·담당자·주소·이메일(SpecifiedPerson·DefinedContact·SpecifiedAddress)은 읽지 않는다.
const S = require('./stmt');
const N = require('./stmtnts');

const LIMIT = { XML: 4 * 1024 * 1024, NODES: 20000, DEPTH: 64, ROWS: 500 };

// ── XML 파서 ───────────────────────────────────────────────────────────
function unEnt(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, function (m, e) {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}
function local(name) { const i = name.indexOf(':'); return i >= 0 ? name.slice(i + 1) : name; }
function node(name) { return { name: name, attrs: Object.create(null), kids: [], text: '' }; }

// 글 → { ok, root } | { ok:false, code }
function parseXml(src) {
  const s = String(src);
  if (s.length > LIMIT.XML) return { ok: false, code: 'TOO_BIG' };
  const top = node('#doc');
  const stack = [top];
  let i = 0, count = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    const cur = stack[stack.length - 1];
    if (lt < 0) { cur.text += unEnt(s.slice(i)); break; }
    if (lt > i) cur.text += unEnt(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) return { ok: false, code: 'BAD_XML' }; i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); if (e < 0) return { ok: false, code: 'BAD_XML' }; cur.text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt + 2); if (e < 0) return { ok: false, code: 'BAD_XML' }; i = e + 2; continue; }
    if (s.startsWith('<!', lt)) {   // DOCTYPE — 안쪽 [ … ] 까지 건너뜀, 엔티티 정의는 쓰지 않는다
      let j = lt + 2, depth = 0;
      for (; j < n; j++) { const c = s[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      if (j >= n) return { ok: false, code: 'BAD_XML' };
      i = j + 1; continue;
    }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt + 2); if (e < 0) return { ok: false, code: 'BAD_XML' };
      const nm = local(s.slice(lt + 2, e).trim());
      if (stack.length < 2 || stack[stack.length - 1].name !== nm) return { ok: false, code: 'BAD_XML' };
      stack.pop(); i = e + 1; continue;
    }
    // 여는 태그 — 따옴표 안의 '>'를 건너뛰며 끝 찾기
    let j = lt + 1, q = '';
    for (; j < n; j++) { const c = s[j]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    if (j >= n) return { ok: false, code: 'BAD_XML' };
    let inner = s.slice(lt + 1, j);
    const self = inner.endsWith('/');
    if (self) inner = inner.slice(0, -1);
    const m = inner.match(/^([A-Za-z_][\w:.-]*)/);
    if (!m) return { ok: false, code: 'BAD_XML' };
    const el = node(local(m[1]));
    const are = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a; const rest = inner.slice(m[1].length);
    while ((a = are.exec(rest))) { const k = local(a[1]); if (k !== '__proto__') el.attrs[k] = unEnt(a[3] != null ? a[3] : a[4]); }
    if (++count > LIMIT.NODES) return { ok: false, code: 'TOO_BIG' };
    cur.kids.push(el);
    if (!self) { stack.push(el); if (stack.length > LIMIT.DEPTH) return { ok: false, code: 'TOO_DEEP' }; }
    i = j + 1;
  }
  if (stack.length !== 1) return { ok: false, code: 'BAD_XML' };
  const root = top.kids[0];
  if (!root) return { ok: false, code: 'BAD_XML' };
  return { ok: true, root: root };
}
function kid(nd, name) { if (!nd) return null; for (let i = 0; i < nd.kids.length; i++) if (nd.kids[i].name === name) return nd.kids[i]; return null; }
function kids(nd, name) { return nd ? nd.kids.filter(function (k) { return k.name === name; }) : []; }
function at(nd, path) { let c = nd; const p = path.split('/'); for (let i = 0; i < p.length && c; i++) c = kid(c, p[i]); return c; }
function txt(nd, path) { const c = path ? at(nd, path) : nd; return c ? c.text.replace(/\s+/g, ' ').trim() : ''; }

// ── 값 다듬기 ─────────────────────────────────────────────────────────
function num(s) {
  const t = String(s || '').replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
function won(s) { const v = num(s); return v == null ? null : Math.round(v); }
function dec4(s) { const v = num(s); return v == null ? null : Math.round(v * 10000) / 10000; }
function ymd(s) {   // YYYYMMDD(뒤에 시각이 붙어도 앞 8자리) → YYYY-MM-DD, 달력에 없는 날은 ''
  const m = String(s || '').replace(/\D/g, '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return '';
  const d = m[1] + '-' + m[2] + '-' + m[3];
  return S.validDay(d) ? d : '';
}
function bn10(s) { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? d : ''; }
function clean(s, max) {   // 줄 글 — 제어 글자 빼고 자르고, 전화·계좌·주민번호 꼴이면 비운다
  const t = String(s || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 120);
  return t && S.piiScan(t) ? null : t;   // null = 개인정보 꼴이라 비움
}
const RE_PLATE = /(?:\d{2,3}\s?[가-힣]\s?\d{4})/;

// 루트(TaxInvoice) → 공통 꼴. src 'xml'
function fromTree(root, src) {
  const warn = [];
  if (root.name !== 'TaxInvoice') return { ok: false, code: 'NOT_TAXINVOICE', why: '전자세금계산서 XML이 아닙니다' };
  const doc = kid(root, 'TaxInvoiceDocument');
  const st = kid(root, 'TaxInvoiceTradeSettlement');
  if (!doc || !st) return { ok: false, code: 'NOT_TAXINVOICE', why: '전자세금계산서 칸이 빠졌습니다' };
  const date = ymd(txt(doc, 'IssueDateTime'));
  const ivr = kid(st, 'InvoicerParty'), ive = kid(st, 'InvoiceeParty');
  let vname = clean(txt(ivr, 'NameText'), 60);
  if (vname === null) { vname = ''; warn.push('공급자 상호에 연락처 꼴 글이 있어 비웠습니다'); }
  const sum = kid(st, 'SpecifiedMonetarySummation');
  const inv = { date: date, supply: won(txt(sum, 'ChargeTotalAmount')), vat: won(txt(sum, 'TaxTotalAmount')), total: won(txt(sum, 'GrandTotalAmount')) };
  const items = kids(root, 'TaxInvoiceTradeLineItem');
  if (items.length > LIMIT.ROWS) return { ok: false, code: 'TOO_MANY_ROWS', why: '품목 줄이 ' + LIMIT.ROWS + '줄을 넘습니다' };
  let blanked = 0;
  const rows = items.map(function (it) {
    let item = clean(txt(it, 'NameText'), 80);
    const spec = clean(txt(it, 'InformationText'), 60), memo = clean(txt(it, 'DescriptionText'), 80);
    if (item === null) { item = ''; blanked++; }
    const notes = [];
    if (spec === null || memo === null) blanked++;
    if (spec) notes.push(spec);
    if (memo) notes.push(memo);
    const pm = (item + ' ' + notes.join(' ')).match(RE_PLATE);
    const vraw = pm && /^[가-힣A-Za-z0-9 ()-]+$/.test(pm[0]) ? pm[0].replace(/\s+/g, '') : '';
    return {
      date: ymd(txt(it, 'PurchaseExpiryDateTime')), vraw: vraw, item: item, kind: '',
      qty: dec4(txt(it, 'ChargeableUnitQuantity')), unit: dec4(txt(it, 'UnitPrice/UnitAmount')),
      amt: won(txt(it, 'InvoiceAmount')), vat: won(txt(it, 'TotalTax/CalculatedAmount')),
      note: notes.join(' · ').slice(0, 120), how: 'file'
    };
  });
  if (blanked) warn.push('줄 글 ' + blanked + '곳에 전화·계좌 꼴이 있어 비웠습니다');
  if (!rows.length) warn.push('품목 줄이 없습니다');
  // 검산 — 공급+세액=합계, 줄 합 = 머리 합
  if (inv.supply != null && inv.vat != null && inv.total != null && inv.supply + inv.vat !== inv.total) warn.push('계산서 공급가액+세액이 합계와 다릅니다');
  const sa = rows.reduce(function (a, r) { return a + (r.amt || 0); }, 0), sv = rows.reduce(function (a, r) { return a + (r.vat || 0); }, 0);
  if (rows.length && inv.supply != null && sa !== inv.supply) warn.push('품목 공급가액 합이 계산서 공급가액과 다릅니다');
  if (rows.length && inv.vat != null && rows.every(function (r) { return r.vat != null; }) && sv !== inv.vat) warn.push('품목 세액 합이 계산서 세액과 다릅니다');
  if (!date) warn.push('작성일을 읽지 못했습니다');
  const tc = txt(doc, 'TypeCode');
  if (/^0[24]\d\d$/.test(tc)) warn.push('수정 (세금)계산서입니다 — 원 계산서와 같이 보세요');   // 종류 코드 앞 2자리 01 세금계산서·02 수정·03 계산서·04 수정 계산서
  return {
    ok: true, src: src || 'xml',
    vendor: { name: vname, bn: bn10(txt(ivr, 'ID')) },
    buyer_bn: bn10(txt(ive, 'ID')),
    ym_hint: date ? date.slice(0, 7) : '',
    rows: rows,
    inv: (inv.supply == null && inv.total == null) ? null : inv,
    carry: null,
    warn: warn
  };
}

// Buffer|글(전자세금계산서 XML) → 공통 꼴(src 'xml')
function readTaxXml(input) {
  let s;
  if (Buffer.isBuffer(input)) {
    if (input.length > LIMIT.XML) return { ok: false, code: 'TOO_BIG', why: 'XML이 4MB를 넘습니다' };
    const head = input.subarray(0, 200).toString('latin1');
    const enc = (head.match(/encoding\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (/euc-?kr|ks_c_5601|cp949/i.test(enc)) { try { s = new TextDecoder('euc-kr').decode(input); } catch (e) { s = N.decodeText(input); } }
    else s = N.decodeText(input);
  } else s = String(input || '');
  const p = parseXml(s);
  if (!p.ok) return { ok: false, code: p.code, why: 'XML을 읽지 못했습니다' };
  return fromTree(p.root, 'xml');
}

function looksXml(f) {
  if (/\.xml$/i.test(f.name || '')) return true;
  const h = f.buf.subarray(0, 400).toString('latin1');
  return /^\s*(﻿|\xef\xbb\xbf)?<\?xml/.test(h) || h.indexOf('<TaxInvoice') >= 0;
}
// 국세청 보안메일 HTML → 풀기 → 첨부 XML → 공통 꼴(src 'nts'). bnList = 받는 쪽 사업자번호 후보(종운환경·종운건설)
function readNts(htmlBuf, bnList) {
  const d = N.decryptNts(htmlBuf, bnList);
  if (!d.ok) return d;
  const xs = d.files.filter(looksXml);
  if (!xs.length) return { ok: false, code: 'NO_XML', why: '보안메일에 계산서 XML 첨부가 없습니다' };
  const r = readTaxXml(xs[0].buf);
  if (!r.ok) return r;
  r.src = 'nts';
  r.bnIdx = d.bnIdx;   // 맞은 후보 순번(번호 값은 buyer_bn에만)
  if (xs.length > 1) r.warn.push('XML 첨부가 ' + xs.length + '개 — 첫 번째만 읽었습니다');
  return r;
}

module.exports = { LIMIT, parseXml, readTaxXml, readNts, fromTree };
