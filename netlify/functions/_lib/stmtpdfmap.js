'use strict';
// 29 판④ 부품 C — 글자 PDF 명세서 틀(수양개발 거래명세서 · 오천공구 거래처 원장 전표별 · 상품상세).
// 입력 = pdftext.pdfText의 쪽들(또는 PDF Buffer) → 공통 출력 꼴(29_판4_읽기부품_규격 '출력 꼴'). 순수 함수, 저장소·네트워크 없음.
// 어떤 틀인지는 제목 낱말과 머리 칸 이름으로 고른다. 머리 칸이 다 없으면 다른 업체 글자 PDF로 보고 UNKNOWN_LAYOUT(엉뚱한 칸 매김 금지).
// 사업자번호·이름·전화·계좌는 줄 글(item·note·vraw)에 넣지 않는다 — 꼴이 섞이면 그 글을 비운다(서버 piiScan 거절 예방).
// 출력의 check는 부품 확인용(줄 수·합계 일치) — 서버로 보내는 draft_rows에는 쓰지 않는다.

const PT = require('./pdftext');
const S = require('./stmt');

const RE_VRAW = /^[가-힣A-Za-z0-9 ()-]+$/;
const RE_BN = /(\d{3})-(\d{2})-(\d{5})/;
const LIM = S.LIMIT || { item: 40, note: 60, vraw: 24, rows: 400 };

function compact(s) { return String(s || '').replace(/\s+/g, ''); }
function clip(s, n) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).trim() : t; }
function safeText(s, n) { const t = clip(s, n); return t && S.piiScan(t) ? '' : t; }
function safeVraw(s) { const t = clip(s, LIM.vraw); return t && RE_VRAW.test(t) && !S.piiScan(t) ? t : ''; }
function money(s, warn, what) {
  const n = PT.num(s);
  if (n === null) return null;
  if (!Number.isInteger(n)) { warn.push(what + ' 금액에 소수가 있어 반올림함'); return Math.round(n); }
  return n;
}
function dec(s) { const n = PT.num(s); return n === null ? null : Math.round(n * 10000) / 10000; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function validDay(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
function ymMode(rows) {
  const c = {}; let best = '', bn = 0;
  rows.forEach(function (r) { if (r.date) { const k = r.date.slice(0, 7); c[k] = (c[k] || 0) + 1; if (c[k] > bn) { bn = c[k]; best = k; } } });
  return best;
}
// 머리 칸 찾기 — 머리 줄(must 낱말이 모두 있는 줄) 둘레(위 4pt ~ 아래 below pt)의 조각 중 이름이 맞는 것. → { heads, y } | null
function findHeads(lines, names, must, below) {
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], set = ln.items.map(function (it) { return compact(it.str); });
    if (!must.every(function (m) { return set.indexOf(m) >= 0; })) continue;
    const heads = [], seen = {}; let yMax = ln.y;
    for (let j = Math.max(0, i - 2); j < lines.length && lines[j].y <= ln.y + below; j++) {
      if (lines[j].y < ln.y - 4) continue;
      lines[j].items.forEach(function (it) {
        const k = names[compact(it.str)];
        if (k && !seen[k]) { seen[k] = 1; heads.push({ key: k, x: it.x, w: it.w }); if (lines[j].y > yMax) yMax = lines[j].y; }
      });
    }
    return { heads: heads, y: yMax };
  }
  return null;
}
function hasAll(heads, keys) { return keys.every(function (k) { return heads.some(function (h) { return h.key === k; }); }); }
function sumOf(rows, k) { return rows.reduce(function (a, r) { return a + (typeof r[k] === 'number' ? r[k] : 0); }, 0); }
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function out(vendor, rows, extra) {
  return Object.assign({ ok: true, src: 'pdf', vendor: vendor, buyer_bn: '', ym_hint: '', rows: rows, inv: null, carry: null, warn: [] }, extra);
}

// ── 수양개발 '거래명세서'(Excel 글자 PDF) ──
const SY_HEADS = { '일자': 'date', '품목': 'item', '차량번호': 'veh', '수량': 'qty', '단가': 'unit', '공급가액': 'amt', '세액': 'vat', '비고': 'note', '규격': 'spec' };
const SY_MUST = ['date', 'item', 'veh', 'qty', 'unit', 'amt', 'vat'];
function mapSuyang(pages) {
  const warn = [], rows = [];
  let docY = 0, docM = 0, vendor = { name: '', bn: '' }, buyerBn = '', totLine = null, grand = null, heads = null, unknownLay = false;
  pages.forEach(function (pg) {
    const lines = PT.groupLines(pg.items, 3);
    const hf = findHeads(lines, SY_HEADS, ['일자', '품목'], 16);
    if (hf) { if (!hasAll(hf.heads, SY_MUST)) { unknownLay = true; return; } heads = hf.heads; }
    if (!heads) { unknownLay = true; return; }
    const headY = hf ? hf.y : -1;
    let done = false;
    lines.forEach(function (ln) {
      const ct = compact(ln.text);
      if (ln.y <= headY) {   // 머리 위 — 문서 날짜·공급자 상호·번호·합계금액
        const md = ct.match(/(\d{4})년(\d{1,2})월(\d{1,2})일/);
        if (md && !docY) { docY = +md[1]; docM = +md[2]; }
        ln.items.forEach(function (it) {
          const b = it.str.match(RE_BN);
          if (b) { if (it.x > pg.w * 0.45) { if (!vendor.bn) vendor.bn = b[1] + b[2] + b[3]; } else if (!buyerBn) buyerBn = b[1] + b[2] + b[3]; }
        });
        const lab = ln.items.filter(function (it) { return it.x > pg.w * 0.45 && (compact(it.str) === '상호' || compact(it.str) === '상'); })[0];
        if (lab && !vendor.name) {
          const lab2 = ln.items.filter(function (it) { return it.x > lab.x && it.x < lab.x + 30 && compact(it.str) === '호'; })[0] || lab;
          const stop = ln.items.filter(function (it) { return it.x > lab2.x && /^(성|성명|대표|대표자)$/.test(compact(it.str)); })[0];
          const nm = ln.items.filter(function (it) { return it.x > lab2.x + lab2.w && (!stop || it.x < stop.x); }).map(function (it) { return it.str; }).join(' ');
          vendor.name = safeText(nm, LIM.name || 30);
        }
        // 합계금액 줄 — 원 기호(\ ₩ ￦)가 앞에 붙은 금액(Excel 표는 '합계금액'·'(공급가액+세액)' 글이 금액과 다른 줄에 놓인다)
        if (/공급가액\+세액|합계금액/.test(ct) || ln.items.some(function (it) { return /^[\\₩￦]/.test(compact(it.str)); })) {
          const nums = ln.items.map(function (it) { return PT.num(it.str); }).filter(function (n) { return n !== null; });
          if (nums.length) grand = nums[nums.length - 1];
        }
        return;
      }
      if (done) return;
      const c = PT.splitCols(ln.items, heads);
      if (/^합계/.test(compact(c.item || '')) || /^합계/.test(compact(c.date || '')) || /^합계/.test(ct)) {
        totLine = { qty: dec(c.qty), amt: money(c.amt, warn, '합계 줄'), vat: money(c.vat, warn, '합계 줄') };
        done = true; return;
      }
      const amt = money(c.amt, warn, '줄'), dm = compact(c.date || '').match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
      if (amt === null && !dm) {   // 숫자 없는 줄 — 바로 위 줄 품목이 두 줄로 접힌 것이면 이어 붙임
        const prev = rows[rows.length - 1];
        if (prev && c.item && Object.keys(c).length === 1 && ln.y - prev._y < 14) prev.item = safeText(prev.item + ' ' + c.item, LIM.item);
        return;
      }
      let date = '';
      if (dm) {
        const m = +dm[1], d = +dm[2];
        if (docY) { const y = m > docM ? docY - 1 : docY; if (validDay(y, m, d)) date = y + '-' + pad2(m) + '-' + pad2(d); }
        if (!date) warn.push('일자를 날짜로 못 바꾼 줄이 있음');
      }
      const r = { date: date, vraw: safeVraw(c.veh), item: safeText(c.item, LIM.item), kind: 'cover', qty: dec(c.qty), unit: dec(c.unit), amt: amt, vat: money(c.vat, warn, '줄'),
        note: safeText([c.spec, c.note].filter(Boolean).join(' '), LIM.note), how: 'file', _y: ln.y };
      if (r.qty !== null && r.unit !== null && r.amt !== null && Math.abs(r.qty * r.unit - r.amt) > 1) warn.push('수량×단가와 공급가액이 다른 줄이 있음');
      rows.push(r);
    });
  });
  if (unknownLay && !rows.length) return { ok: false, code: 'UNKNOWN_LAYOUT', why: '거래명세서 머리 칸이 수양개발 틀과 다름' };
  if (!docY) warn.push('문서 날짜(년 월 일)를 못 찾아 일자를 비움');
  rows.forEach(function (r) { delete r._y; });
  const sAmt = sumOf(rows, 'amt'), sVat = sumOf(rows, 'vat'), sQty = Math.round(sumOf(rows, 'qty') * 10000) / 10000;
  let sumOk = true;
  if (!totLine) { warn.push('합계 줄을 못 찾음'); sumOk = false; }
  else {
    if (totLine.amt !== null && totLine.amt !== sAmt) { warn.push('공급가액 줄 합(' + fmt(sAmt) + ')과 합계 줄(' + fmt(totLine.amt) + ')이 다름'); sumOk = false; }
    if (totLine.vat !== null && totLine.vat !== sVat) { warn.push('세액 줄 합(' + fmt(sVat) + ')과 합계 줄(' + fmt(totLine.vat) + ')이 다름'); sumOk = false; }
    if (totLine.qty !== null && totLine.qty !== sQty) { warn.push('수량 줄 합과 합계 줄이 다름'); sumOk = false; }
  }
  if (grand !== null && grand !== sAmt + sVat) { warn.push('합계금액(공급가액+세액)이 줄 합과 다름'); sumOk = false; }
  if (!rows.length) warn.push('명세 줄이 없음');
  return out(vendor, rows, { buyer_bn: buyerBn, ym_hint: ymMode(rows) || (docY ? docY + '-' + pad2(docM) : ''), warn: dedup(warn),
    check: { layout: 'suyang', lines: rows.length, sum_ok: sumOk && !!rows.length } });
}

// ── 오천공구 공통: 머리 위 '매장 : 상호' · '전표일자 : A ~ B' ──
function ochunMeta(pages) {
  const m = { name: '', ym: '' };
  pages.forEach(function (pg) {
    PT.groupLines(pg.items, 3).forEach(function (ln) {
      ln.items.forEach(function (it) {
        const a = it.str.match(/^\s*매장\s*:\s*(.+)$/);
        if (a && !m.name) m.name = safeText(a[1], LIM.name || 30);
        const b = it.str.match(/전표일자\s*:\s*\d{4}-\d{2}-\d{2}\s*~\s*(\d{4}-\d{2})-\d{2}/);
        if (b && !m.ym) m.ym = b[1];
      });
    });
  });
  return m;
}
function sumAfter(s) { const t = String(s || '').replace(/^\s*합계\s*:?\s*/, ''); return PT.num(t); }

// ── 오천 '거래처 원장 - 전표별' → carry ──
const LG_HEADS = { '전표일자': 'date', '전표타입': 'type', '내용': 'desc', '매입금액': 'buy', '지불금액': 'pay', '매출금액': 'sale', '수금금액': 'paid', '잔액': 'bal', '메모': 'memo' };
function mapOchunLedger(pages) {
  const warn = [], meta = ochunMeta(pages);
  let heads = null, prev = null, month = 0, paid = 0, bal = null, lastSum = null, nSale = 0, nPaid = 0, odd = {};
  pages.forEach(function (pg) {
    const lines = PT.groupLines(pg.items, 3);
    const hf = findHeads(lines, LG_HEADS, ['전표일자', '전표타입'], 4);
    if (hf) heads = hf.heads;
    if (!heads || !hasAll(heads, ['type', 'sale', 'paid', 'bal'])) return;
    const headY = hf ? hf.y : -1;
    lines.forEach(function (ln) {
      if (ln.y <= headY) return;
      const c = PT.splitCols(ln.items, heads);
      if (ln.items.some(function (it) { return /^\s*합계\s*:/.test(it.str); })) {
        lastSum = { sale: sumAfter(c.sale), paid: sumAfter(c.paid) }; return;
      }
      // 전표타입은 머리 바로 아래 조각만(옆 '내용' 칸 첫 낱말 '이월'·'이체'와 섞이지 않게, '월: [n]' 묶음 머리는 건너뜀)
      const th = heads.filter(function (h) { return h.key === 'type'; })[0];
      const tIt = ln.items.filter(function (it) { return Math.abs((it.x + it.w / 2) - (th.x + th.w / 2)) <= 12 && /^[가-힣]+$/.test(compact(it.str)); })[0];
      const t = tIt ? compact(tIt.str) : '';
      if (!t) return;
      const b = PT.num(c.bal);
      if (t === '이월') { if (prev === null && b !== null) prev = b; }
      else if (t === '매출' || t === '반품') { const v = PT.num(c.sale); if (v !== null) { month += v; nSale++; } }
      else if (t === '수금') { const v = PT.num(c.paid); if (v !== null) { paid += v; nPaid++; } }
      else odd[t] = 1;
      if (b !== null) bal = b;
    });
  });
  if (!heads) return { ok: false, code: 'UNKNOWN_LAYOUT', why: '거래처 원장 머리 칸을 못 찾음' };
  Object.keys(odd).forEach(function (t) { warn.push('원장에 셈하지 않은 전표 종류가 있음(' + safeText(t, 10) + ')'); });
  if (prev === null) { warn.push('이월 잔액을 못 찾아 0으로 봄'); prev = 0; }
  if (bal === null) warn.push('마지막 잔액을 못 찾음');
  let sumOk = bal !== null;
  if (lastSum) {
    if (lastSum.sale !== null && lastSum.sale !== month) { warn.push('매출 줄 합(' + fmt(month) + ')과 원장 합계(' + fmt(lastSum.sale) + ')가 다름'); sumOk = false; }
    if (lastSum.paid !== null && lastSum.paid !== paid) { warn.push('수금 줄 합(' + fmt(paid) + ')과 원장 합계(' + fmt(lastSum.paid) + ')가 다름'); sumOk = false; }
  } else warn.push('원장 합계 줄을 못 찾음');
  if (bal !== null && prev + month - paid !== bal) { warn.push('이월+매출−수금이 마지막 잔액과 다름'); sumOk = false; }
  return out({ name: meta.name, bn: '' }, [], { ym_hint: meta.ym, carry: { prev: prev, month: month, paid: paid, bal: bal }, warn: dedup(warn),
    check: { layout: 'ochun_ledger', sales: nSale, paids: nPaid, sum_ok: sumOk } });
}

// ── 오천 '거래처 원장 - 상품상세'(상세별 내역서) → 줄(kind 'tool') ──
const DT_HEADS = { '상품': 'item', '바코드': 'code', '재고단위': 'uom', '상품수량': 'qty', '상품단가': 'unit', '공급가액': 'amt', '부가세액': 'vat', '합계금액': 'tot' };
function mapOchunDetail(pages) {
  const warn = [], meta = ochunMeta(pages), rows = [];
  let heads = null, cur = '', lastSum = null, sale = null, sales = [];
  pages.forEach(function (pg) {
    const lines = PT.groupLines(pg.items, 3);
    const hf = findHeads(lines, DT_HEADS, ['상품', '공급가액'], 4);
    if (hf) heads = hf.heads;
    if (!heads || !hasAll(heads, ['item', 'qty', 'unit', 'amt', 'vat'])) return;
    const headY = hf ? hf.y : -1;
    lines.forEach(function (ln) {
      if (ln.y <= headY) return;
      const md = ln.text.match(/매출일자\s*:\s*(\d{4})-(\d{2})-(\d{2})/);
      if (md) {
        cur = validDay(+md[1], +md[2], +md[3]) ? md[1] + '-' + md[2] + '-' + md[3] : '';
        if (!cur) warn.push('매출일자를 날짜로 못 바꾼 건이 있음');
        const g = function (lab) { const it = ln.items.filter(function (x) { return compact(x.str).indexOf(lab + ':') === 0; })[0]; return it ? PT.num(compact(it.str).slice(lab.length + 1)) : null; };
        sale = { amt: g('공급가액'), vat: g('부가세액'), n: 0, sa: 0, sv: 0 }; sales.push(sale);
        return;
      }
      const c = PT.splitCols(ln.items, heads);
      if (ln.items.some(function (it) { return /^\s*합계\s*:/.test(it.str); })) { lastSum = { amt: sumAfter(c.amt), vat: sumAfter(c.vat), tot: sumAfter(c.tot) }; return; }
      const amt = money(c.amt, warn, '줄');
      if (amt === null || !c.item) return;
      const r = { date: cur, vraw: '', item: safeText(c.item, LIM.item), kind: 'tool', qty: dec(c.qty), unit: dec(c.unit), amt: amt, vat: money(c.vat, warn, '줄'), note: '', how: 'file' };
      const tot = PT.num(c.tot);
      if (tot !== null && r.vat !== null && amt + r.vat !== tot) warn.push('공급가액+부가세가 합계금액과 다른 줄이 있음');
      // 상품단가는 부가세 포함 값일 때가 있다 — 수량×단가가 공급가액이나 공급가액+부가세 어느 쪽과도 안 맞을 때만 경고
      if (r.qty !== null && r.unit !== null && Math.abs(r.qty * r.unit - amt) > 1 && Math.abs(r.qty * r.unit - amt - (r.vat || 0)) > 1) warn.push('수량×단가와 공급가액이 다른 줄이 있음');
      if (!cur) warn.push('매출일자 머리 없이 나온 줄이 있음');
      if (sale) { sale.n++; sale.sa += amt; sale.sv += r.vat || 0; }
      rows.push(r);
    });
  });
  if (!heads) return { ok: false, code: 'UNKNOWN_LAYOUT', why: '상품상세 머리 칸을 못 찾음' };
  let sumOk = rows.length > 0;
  sales.forEach(function (s) { if ((s.amt !== null && s.amt !== s.sa) || (s.vat !== null && s.vat !== s.sv)) { warn.push('매출 건 머리 금액과 그 건 줄 합이 다름'); sumOk = false; } });
  const sA = sumOf(rows, 'amt'), sV = sumOf(rows, 'vat');
  if (lastSum) {
    if (lastSum.amt !== null && lastSum.amt !== sA) { warn.push('공급가액 줄 합(' + fmt(sA) + ')과 합계(' + fmt(lastSum.amt) + ')가 다름'); sumOk = false; }
    if (lastSum.vat !== null && lastSum.vat !== sV) { warn.push('부가세 줄 합(' + fmt(sV) + ')과 합계(' + fmt(lastSum.vat) + ')가 다름'); sumOk = false; }
    if (lastSum.tot !== null && lastSum.tot !== sA + sV) { warn.push('공급가액+부가세 줄 합과 합계금액이 다름'); sumOk = false; }
  } else { warn.push('상품상세 합계 줄을 못 찾음'); sumOk = false; }
  if (!rows.length) warn.push('명세 줄이 없음');
  return out({ name: meta.name, bn: '' }, rows, { ym_hint: meta.ym || ymMode(rows), warn: dedup(warn),
    check: { layout: 'ochun_detail', lines: rows.length, sum_ok: sumOk } });
}

function dedup(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }).slice(0, 20); }

// 틀 고르기 — 쪽 글 전체(공백 뺀)의 제목 낱말로
function pickLayout(pages) {
  const all = compact(pages.map(function (p) { return p.items.map(function (i) { return i.str; }).join(''); }).join(''));
  if (all.indexOf('거래처원장') >= 0 && all.indexOf('전표별') >= 0) return 'ochun_ledger';
  if (all.indexOf('거래처원장') >= 0 && (all.indexOf('상품상세') >= 0 || all.indexOf('상세별') >= 0)) return 'ochun_detail';
  if (all.indexOf('거래명세서') >= 0) return 'suyang';
  return '';
}

// mapPages(pages) — pdfText의 pages → 공통 꼴(동기, 시험·재사용용)
function mapPages(pages) {
  if (!Array.isArray(pages) || !pages.length) return { ok: false, code: 'NO_PAGES', why: '쪽이 없음' };
  const lay = pickLayout(pages);
  if (lay === 'ochun_ledger') return mapOchunLedger(pages);
  if (lay === 'ochun_detail') return mapOchunDetail(pages);
  if (lay === 'suyang') return mapSuyang(pages);
  return { ok: false, code: 'UNKNOWN_LAYOUT', why: '아는 명세서 틀이 아님' };
}

// readStmtPdf(buf) — PDF Buffer → 공통 꼴 | { ok:true, textless:true, src:'pdf', pages } (그림 PDF — AI 판독으로) | { ok:false, code, why }
async function readStmtPdf(buf) {
  const pt = await PT.pdfText(buf);
  if (!pt.ok) return pt;
  if (pt.textless) return { ok: true, textless: true, src: 'pdf', pages: pt.pages };
  try { return mapPages(pt.pages); } catch (e) { return { ok: false, code: 'MAP_FAIL', why: '명세서 틀 읽기 중 오류' }; }
}

module.exports = { readStmtPdf, readPdf: readStmtPdf, mapPages, pickLayout, mapSuyang, mapOchunLedger, mapOchunDetail };
