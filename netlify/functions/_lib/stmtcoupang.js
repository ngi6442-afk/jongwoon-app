'use strict';
// 29 판⑨ 쿠팡 주문 메일 본문 읽기(PM 11/20 '쿠팡까지 같이') — 첨부가 없는 '[쿠팡] …님 주문하신 내역을 확인해주세요' 메일의 HTML 본문.
// 표 '구매 상세내역 | 쿠팡가 | 수량 | 구매금액 | 판매자'의 줄 = 명세 줄(줄 금액 = 부가세 포함 → basis total) · '결제 정보'의 배송비·할인은 줄로 · 총 결제금액과 맞춰 봄.
// 받는 사람·연락처·주소·결제 계좌 칸은 읽지 않고, 남기는 원본(stmtfile)도 주문 표·결제 금액만 잘라 낸 HTML(orderHtml)로 둔다.
const S = require('./stmt');

const SUBJ = /주문하신\s*내역/;
const DOM = /(^|\.)coupang\.com$/i;
function isOrderMail(dom, subject) { return DOM.test(String(dom || '')) && SUBJ.test(String(subject || '')); }

function decode(s) {
  return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (a, n) { return String.fromCharCode(Number(n)); }).replace(/&#x([0-9a-f]+);/gi, function (a, n) { return String.fromCharCode(parseInt(n, 16)); });
}
// 표 줄 → [[칸 글, …], …] (안쪽 표는 바깥 줄과 따로 — 가장 안쪽 tr만)
function cellRows(html) {
  const out = [];
  const re = /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cells = [];
    const cre = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = cre.exec(m[1]))) cells.push(decode(c[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (cells.length) out.push(cells);
  }
  return out;
}
function won(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const m = /^(-|−)?([\d,]+)원$/.exec(t);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(n) ? (m[1] ? -n : n) : null;
}
function isCoupangOrder(buf) {
  const t = buf.slice(0, Math.min(buf.length, 200000)).toString('utf8');
  return /구매\s*상세내역/.test(t) && /쿠팡가/.test(t) && /coupang/i.test(t);
}
// 주문 표·결제 금액 부분만 — 남기는 원본(받는 사람·연락처·주소·계좌 없이)
function orderHtml(buf, at) {
  const s = buf.toString('utf8');
  const a = s.search(/<table\b[^>]*>(?:(?!<table\b)[\s\S])*?구매\s*상세내역/);
  const r = cellRows(a >= 0 ? s.slice(a) : s);
  const keep = [];
  let inItems = false, inPay = false;
  for (const cells of r) {
    const j = cells.join(' ');
    if (/구매\s*상세내역/.test(j) && /쿠팡가/.test(j)) { inItems = true; keep.push(cells); continue; }
    if (/받으시는|연락처|주소/.test(j)) break;
    if (inItems && cells.length >= 4) { keep.push(cells); continue; }
    if (/상품\s*가격|배송비|할인|쿠폰|캐시|적립|총\s*결제금액/.test(j) && cells.length === 2) { inPay = true; keep.push(cells); continue; }
    if (inPay && cells.length === 2 && won(cells[1]) != null) keep.push([/무통장|카드|계좌|페이|은행/.test(cells[0]) ? '결제' : cells[0], cells[1]]);
  }
  const esc = function (x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const day = at ? new Date(Number(at) + 9 * 3600000).toISOString().slice(0, 10) : '';
  return Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="jw-src" content="coupang-order"><title>쿠팡 주문 ' + day + '</title></head><body><p>쿠팡 주문 메일 ' + day + ' — 주문 표·결제 금액만 남김(받는 사람·연락처·주소·결제 계좌는 뺌)</p><table border="1">'
    + keep.map(function (c) { return '<tr>' + c.map(function (x) { return '<td>' + esc(x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></body></html>', 'utf8');
}
// 읽기 — { ok, src:'coupang', vendor, rows, basis:'total', inv:null, carry:null, warn } | { ok:false, code }
// day = 주문일(메일 받은 날, 'YYYY-MM-DD') — 본문에 주문일 칸이 없어 메일 날짜로(남긴 원본 제목에도 같은 날)
function readOrder(buf, day) {
  const s = buf.toString('utf8');
  if (!/구매\s*상세내역/.test(s)) return { ok: false, code: 'NOT_COUPANG_ORDER' };
  const title = /<title>쿠팡 주문 (\d{4}-\d{2}-\d{2})<\/title>/.exec(s);
  const date = (title && title[1]) || (S.validDay(day) ? day : '');
  const r = cellRows(s);
  const rows = [], warn = [];
  let inItems = false, total = null, goods = null, ship = 0;
  for (const cells of r) {
    const j = cells.join(' ');
    if (/구매\s*상세내역/.test(j) && /쿠팡가/.test(j)) { inItems = true; continue; }
    if (inItems && cells.length >= 4 && won(cells[1]) != null && won(cells[3]) != null) {
      const unit = won(cells[1]), qty = Number(String(cells[2]).replace(/[^\d.]/g, '')), amt = won(cells[3]);
      let item = String(cells[0]).slice(0, S.LIMIT.item);
      if (S.piiScan(item, true)) { item = ''; warn.push('품목 이름에 연락처 꼴 글이 있어 비웠습니다'); }
      const seller = String(cells[4] || '').replace(/[^가-힣A-Za-z0-9 ()㈜.&-]/g, '').slice(0, 30);
      rows.push({ date: date, vraw: '', item: item, kind: '', qty: Number.isFinite(qty) && qty > 0 ? qty : null, unit: unit, amt: amt, vat: null, note: seller ? '판매자 ' + seller : '', how: 'file' });
      continue;
    }
    if (cells.length === 2) {
      const v = won(cells[1]);
      if (v == null) continue;
      inItems = false;
      if (/상품\s*가격/.test(cells[0])) goods = v;
      else if (/배송비/.test(cells[0])) ship = v;
      else if (/총\s*결제금액/.test(cells[0])) total = v;
      else if (/할인|쿠폰/.test(cells[0]) && v !== 0) rows.push({ date: date, vraw: '', item: String(cells[0]).replace(/\s+/g, ' ').slice(0, S.LIMIT.item), kind: '', qty: 1, unit: -Math.abs(v), amt: -Math.abs(v), vat: null, note: '', how: 'file' });
    }
  }
  if (!rows.length) return { ok: false, code: 'NO_ROWS', why: '주문 표에서 줄을 찾지 못했습니다' };
  if (ship > 0) rows.push({ date: date, vraw: '', item: '배송비', kind: '', qty: 1, unit: ship, amt: ship, vat: null, note: '', how: 'file' });
  const sum = rows.reduce(function (a, x) { return a + (x.amt || 0); }, 0);
  const gs = rows.filter(function (x) { return x.amt > 0 && x.item !== '배송비'; }).reduce(function (a, x) { return a + x.amt; }, 0);
  if (goods != null && gs !== goods) warn.push('품목 금액 합(' + gs + ')이 상품 가격(' + goods + ')과 다릅니다');
  if (total != null && sum !== total) warn.push('줄 합(' + sum + ')이 총 결제금액(' + total + ')과 다릅니다 — 쿠팡캐시·적립금 등으로 낸 몫이 있으면 그 차이입니다');
  if (!date) warn.push('주문일을 알 수 없습니다');
  return { ok: true, src: 'coupang', vendor: { name: '쿠팡' }, ym_hint: date ? date.slice(0, 7) : '', rows: rows, basis: 'total', inv: null, carry: null, sum: total != null ? { total: total } : null, warn: warn };
}

module.exports = { isOrderMail, isCoupangOrder, orderHtml, readOrder, cellRows };
