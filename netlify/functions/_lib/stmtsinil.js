'use strict';
// 신일 '자동차 부품납품 및 대금청구서'(.xls, BIFF8) → 월말명세서 공통 출력 꼴(29 판④ 부품 B).
// 규격: side-session-notes 29_판4_읽기부품_규격_20261114.md '출력 꼴'·'부품 B'.
// 실물 배치(11/14 확인 — 값은 보지 않고 꼴만): 쪽마다 머리(제목 · 구분/업체/기간/청구일 · 상호/대표자명/전화번호 · 총금액/현금/카드/외상)
//   → 칸 이름 줄 2개(SEQ·증표번호·항목·관련번호·차량번호·현금·카드·외상·총합계·판매일자·특이사항 / 세부명세·L·부품번호·부품명·수량·단가·금액)
//   → 건 줄(SEQ 숫자) 아래 부품 줄들 → 쪽 꼬리(출력자·PAGE·출력일시). 건의 부품 줄이 다음 쪽으로 넘어가기도 한다(쪽 머리 뒤에 이어짐).
// 원칙
//   - 칸은 이름 글로 찾는다(열 번호 고정 안 함 — 쪽마다 칸 이름 줄을 다시 읽음). 실물은 L 칸에 'L값 부품번호'가 한 글로 들어 있어 L~부품명 앞 칸을 이어 읽는다.
//   - 대표자명·전화번호 칸은 읽지 않는다. 업체(청구처) 칸도 버린다 — vendor.name = '상호' 칸만.
//   - 줄 하나 = 부품 하나. 머리 '총금액'은 inv가 아님 → meta.total·meta.total_basis + 검산 warn.
//     규격은 '총금액 = 부가세 포함(부품 합×1.1)'이었으나 11/14 실물은 총금액 = 부품 합(×1.1 아님) → 두 꼴 모두 통과, 둘 다 아니면 warn.
//   - 줄 글이 서버 piiScan(stmt.js)에 걸리면 걸린 조각을 빼고, 그래도 걸리면 그 글을 비운다(warn에 건수).
const { readXls } = require('./xlsbiff');
const { piiScan } = require('./stmt');

const LIM_ITEM = 40, LIM_NOTE = 60, LIM_VRAW = 24;
const RE_VRAW_OK = /^[가-힣A-Za-z0-9 ()-]+$/;
const RE_FULL_PLATE = /[가-힣]{2}\s?\d{2}\s?[가-힣]\s?\d{4}|\d{2,3}\s?[가-힣]\s?\d{4}/;
const RE_HO = /(\d{4})\s?호/;
const RE_LAST4 = /(?:^|[^0-9A-Za-z])(\d{4})(?![0-9])/;
const RE_LONG_DIGITS = /\d{10,}/g;
const SLASH_KEEP = '\u0001';   // '1축/2번' 같은 타이어 자리 글은 '/'로 가르지 않게 잠시 바꿔 둠

function key(s) { return typeof s === 'string' ? s.replace(/[\s:：]/g, '') : ''; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function toNum(v) {
  if (isNum(v)) return v;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[,\s원]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}
function round4(n) { return Math.round(n * 10000) / 10000; }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function toDate(v) {   // 'YYYY-MM-DD' 글 또는 엑셀 일련번호 → 'YYYY-MM-DD' | ''
  if (isNum(v) && v > 20000 && v < 80000) {
    const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return y + '-' + pad(mo) + '-' + pad(d);
}
function clean(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); }

// 같은 줄에서 이름 칸 오른쪽 첫 값
function rightOf(row, ci) {
  for (let c = ci + 1; c < row.length; c++) if (row[c] !== '' && row[c] != null) return row[c];
  return '';
}

// 특이사항 → { vraw, rest[] } — 차량 번호(전체 번호판 > 'NNNN호' > 홀로 선 숫자 4자리) 하나를 뽑고 나머지 글은 조각으로
function splitNote(raw) {
  let s = clean(raw);
  let vraw = '';
  let m = s.match(RE_FULL_PLATE);
  if (m) vraw = m[0].replace(/\s/g, '');
  else if ((m = s.match(RE_HO))) vraw = m[1];
  else if ((m = s.match(RE_LAST4))) { vraw = m[1]; m = { 0: m[1], index: m.index + m[0].length - 4 }; }
  if (m) {
    let end = m.index + m[0].length;
    if (s.charAt(end) === '호') end++;
    s = s.slice(0, m.index) + ' ' + s.slice(end);
  }
  const rest = [];
  s = s.replace(/(\d+\s?축)\s*\/\s*(\d+\s?번)/g, '$1' + SLASH_KEEP + '$2');
  s.split('/').forEach(function (seg) {
    let t = clean(seg.split(SLASH_KEEP).join('/'));
    if (/차\s*번호\s*변경/.test(t)) {
      const nums = t.match(/\d{2,3}[가-힣]\d{4}|\d{4}/g) || [];
      t = '차번호 변경' + (nums.length ? ' ' + nums.join(' ') : '');
    } else {
      t = t.replace(/^로(?=\s|$)/, '').replace(/포항\s+모터스/g, '포항모터스');
    }
    t = clean(t).replace(/^[.=,·~\-\s]+|[.=,·~\-\s]+$/g, '');
    if (t) rest.push(t);
  });
  return { vraw: vraw, rest: rest };
}

// 칸 이름 줄 찾기 — 이름(공백·쌍점 뺀 글) → 열
function headerMap(row, names) {
  const map = Object.create(null);
  row.forEach(function (v, ci) { const k = key(v); if (k && names.indexOf(k) >= 0 && map[k] == null) map[k] = ci; });
  return map;
}
const CASE_NAMES = ['SEQ', '증표번호', '항목', '관련번호', '차량번호', '현금', '카드', '외상', '총합계', '판매일자', '특이사항'];
const PART_NAMES = ['세부명세', 'L', '부품번호', '부품명', '수량', '단가', '금액'];

function isSinil(sheets) {
  return !!(sheets && sheets.some(function (sh) {
    return sh.cells.slice(0, 30).some(function (row) { return row.some(function (v) { const k = key(v); return k.indexOf('부품납품') >= 0 && k.indexOf('대금청구서') >= 0; }); });
  }));
}

// readXls 결과 시트들 → 공통 꼴
function sinilFromSheets(sheets) {
  if (!isSinil(sheets)) return { ok: false, code: 'UNKNOWN_LAYOUT', why: '신일 부품납품 대금청구서 틀이 아님' };
  const warn = [];
  const rows = [];
  const cases = [];
  let vendorName = '', period = null, totals = [], cm = null, pm = null, cur = null;
  let piiCut = 0, piiBlank = 0, pnDrop = 0, cut = 0, orphan = 0;

  function safe(text) {   // piiScan 걸리면 10자리 넘는 숫자 줄(실물: 부품명 안 참조 부품번호)만 빼고 다시, 그래도 걸리면 ''
    if (!text || !piiScan(text)) return text;
    const t = clean(text.replace(RE_LONG_DIGITS, ' ').replace(/[=:]\s*\)/g, ')').replace(/\(\s*\)/g, ''));
    if (t && !piiScan(t)) { piiCut++; return t; }
    piiBlank++; return '';
  }

  for (const sh of sheets) {
    const cells = sh.cells;
    for (let ri = 0; ri < cells.length; ri++) {
      const row = cells[ri] || [];
      if (!row.length) continue;
      const k0 = row.map(key);
      // 머리 이름:값 칸
      for (let ci = 0; ci < row.length; ci++) {
        const k = k0[ci];
        if (k === '상호' && !vendorName) vendorName = clean(rightOf(row, ci));
        else if (k === '기간' && !period) {
          const a = toDate(rightOf(row, ci));
          let b = '';
          for (let c = ci + 1; c < row.length; c++) { const d = toDate(row[c]); if (d && (a !== d || c > ci + 1)) b = d; }
          if (a) period = { from: a, to: b || a };
        } else if (k === '총금액') {
          const t = toNum(rightOf(row, ci));
          if (t != null) totals.push(Math.round(t));
        }
      }
      // 칸 이름 줄
      if (k0.indexOf('SEQ') >= 0 && k0.indexOf('판매일자') >= 0) { cm = headerMap(row, CASE_NAMES); continue; }
      if (k0.indexOf('세부명세') >= 0 && k0.indexOf('부품명') >= 0) { pm = headerMap(row, PART_NAMES); continue; }
      if (!cm || !pm) continue;
      const seq = row[cm.SEQ];
      if (isNum(seq) && Number.isInteger(seq)) {             // 건 줄
        const tot = toNum(row[cm['총합계']]);
        const cr = toNum(row[cm['외상']]);
        const parts = splitNote(row[cm['특이사항']]);
        let vraw = parts.vraw;
        if (vraw && (!RE_VRAW_OK.test(vraw) || vraw.length > LIM_VRAW || piiScan(vraw))) vraw = '';
        cur = { seq: seq, date: toDate(row[cm['판매일자']]), amt: tot != null ? tot : cr, cash: toNum(row[cm['현금']]) || 0, card: toNum(row[cm['카드']]) || 0, credit: cr,
          lines: isNum(row[cm['항목']]) ? row[cm['항목']] : null, vraw: vraw, rest: parts.rest, sum: 0, n: 0 };
        cases.push(cur);
        continue;
      }
      // 부품 줄: SEQ 칸 비고 · 부품명 글 · 금액 숫자
      const name = clean(row[pm['부품명']]);
      const amt = toNum(row[pm['금액']]);
      if (!name || amt == null || clean(row[cm.SEQ]) !== '') continue;   // 실물 빈 칸은 ' '(공백 글)로 들어 있음
      const fromC = pm.L != null ? pm.L : pm['부품번호'];
      const toC = pm['부품명'];
      const pnParts = [];
      for (let c = fromC; c != null && c < toC; c++) if (row[c] !== '' && row[c] != null) pnParts.push(clean(row[c]));
      let pn = pnParts.join(' ');
      const tok = pn.split(' ');
      if (tok.length >= 2 && tok[0].length <= 2) pn = tok.slice(1).join(' ');   // 앞 L값(1~2글자) 떼기
      const qty = toNum(row[pm['수량']]), unit = toNum(row[pm['단가']]);
      if (!cur) orphan++;
      let item = name;
      if (item.length > LIM_ITEM) { item = item.slice(0, LIM_ITEM); cut++; }
      item = safe(item);
      // 부품번호에 10자리 넘는 숫자 줄이 있으면 서버 piiScan(/\d{10,}/)이 줄 전체를 거절 → note에서 부품번호만 뺀다(건수 warn)
      if (pn && piiScan(pn)) { pn = ''; pnDrop++; }
      let note = [pn].concat(cur ? cur.rest : []).filter(Boolean).join(' · ');
      note = safe(note);
      if (note.length > LIM_NOTE) { note = note.slice(0, LIM_NOTE); cut++; }
      const a = Math.round(amt);
      rows.push({ date: cur ? cur.date : '', vraw: cur ? cur.vraw : '', item: item, kind: 'part', qty: qty == null ? null : round4(qty), unit: unit == null ? null : round4(unit),
        amt: a, vat: null, note: note, how: 'xlsx' });
      if (cur) { cur.sum += a; cur.n++; }
    }
  }

  if (!cm || !pm) return { ok: false, code: 'NO_HEADER', why: '칸 이름 줄(SEQ·세부명세)을 못 찾음' };
  if (!rows.length) return { ok: false, code: 'NO_ROWS', why: '부품 줄이 없음' };

  // 검산
  const supply = rows.reduce(function (s, r) { return s + r.amt; }, 0);
  const total = totals.length ? totals[0] : null;
  if (totals.some(function (t) { return t !== total; })) warn.push('쪽마다 총금액이 다름');
  // 총금액 기준: 부품 합×1.1(반올림)이면 'x1.1'(줄 = 공급가) · 부품 합과 같으면 'same'(11/14 실물이 이 꼴 — 줄 금액이 부가세 포함인지는 계산서와 대조해야 앎)
  const withVat = Math.round(supply * 11 / 10);
  let totalBasis = null;
  if (total == null) warn.push('머리 총금액을 못 찾음');
  else if (withVat === total) totalBasis = 'x1.1';
  else if (supply === total) totalBasis = 'same';
  else warn.push('총금액이 부품 합(' + supply + ')과도 부품 합×1.1(' + withVat + ')과도 다름: 총금액 ' + total + '원');
  const badCase = cases.filter(function (c) { return c.amt == null || c.amt !== c.sum; });
  if (badCase.length) warn.push('건 금액 ≠ 그 건 부품 합: ' + badCase.length + '건(SEQ ' + badCase.slice(0, 5).map(function (c) { return c.seq; }).join(',') + (badCase.length > 5 ? '…' : '') + ')');
  const badPay = cases.filter(function (c) { return c.amt != null && c.credit != null && c.cash + c.card + c.credit !== c.amt; });
  if (badPay.length) warn.push('현금+카드+외상 ≠ 총합계: ' + badPay.length + '건');
  const badLines = cases.filter(function (c) { return c.lines != null && c.lines !== c.n; });
  if (badLines.length) warn.push('항목 수 ≠ 부품 줄 수: ' + badLines.length + '건');
  const noParts = cases.filter(function (c) { return c.n === 0; });
  if (noParts.length) warn.push('부품 줄 없는 건: ' + noParts.length + '건');
  if (orphan) warn.push('건 줄 앞에 나온 부품 줄: ' + orphan + '줄(날짜·차량 없음)');
  const seqs = cases.map(function (c) { return c.seq; });
  if (new Set(seqs).size !== seqs.length) warn.push('SEQ 겹침');
  const noVeh = cases.filter(function (c) { return !c.vraw; }).length;
  if (noVeh) warn.push('차량 번호 못 찾은 건: ' + noVeh + '건');
  const noDate = cases.filter(function (c) { return !c.date; }).length;
  if (noDate) warn.push('판매일자 없는 건: ' + noDate + '건');
  let ym = period ? period.from.slice(0, 7) : '';
  if (period && period.to.slice(0, 7) !== ym) warn.push('기간이 두 달에 걸침');
  if (!ym) {
    const cnt = Object.create(null);
    rows.forEach(function (r) { if (r.date) cnt[r.date.slice(0, 7)] = (cnt[r.date.slice(0, 7)] || 0) + 1; });
    ym = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0] || '';
    warn.push('머리 기간을 못 찾음');
  }
  const outside = rows.filter(function (r) { return r.date && r.date.slice(0, 7) !== ym; }).length;
  if (outside) warn.push('기간 밖 날짜 줄: ' + outside + '줄');
  if (pnDrop) warn.push('부품번호가 긴 숫자라 메모에서 뺌: ' + pnDrop + '줄');
  if (piiCut) warn.push('개인정보 꼴 숫자를 줄 글에서 뺌: ' + piiCut + '칸');
  if (piiBlank) warn.push('개인정보 꼴이 섞여 줄 글을 비움: ' + piiBlank + '칸');
  if (cut) warn.push('긴 글 자름: ' + cut + '칸');

  let vname = vendorName.slice(0, 30);
  if (vname && piiScan(vname)) vname = '';
  return { ok: true, src: 'xls', vendor: { name: vname, bn: '' }, buyer_bn: '', ym_hint: ym, rows: rows, inv: null, carry: null,
    meta: { total: total, sum: supply, total_basis: totalBasis, cases: cases.length, pages: totals.length }, warn: warn };
}

// parseSinil(buf) → 공통 꼴 | { ok:false, code, why }
function parseSinil(buf) {
  const x = readXls(buf);
  if (!x.ok) return x;
  return sinilFromSheets(x.sheets);
}

// readSinilXls = parseSinil(나누기 stmtread.js가 부르는 이름). 틀이 아니면 code UNKNOWN_LAYOUT(stmtread가 '아직 모르는 엑셀 양식'으로 안내).
module.exports = { parseSinil: parseSinil, readSinilXls: parseSinil, sinilFromSheets: sinilFromSheets, isSinil: isSinil, splitNote: splitNote };
