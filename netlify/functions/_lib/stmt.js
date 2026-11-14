'use strict';
// 월말명세서(체크 29 — 권민지 월말 명세서 확인·정리) 순수 규칙. 서버 gw-stmt.js가 쓰고, 앱(29 판②)은 같은 규칙을 화면 쪽에 둔다(그때 uismoke로 대조).
// 근거: 시안 v2(09_조사_문서/29_명세표정리_자료_20261110/시안v2_20261110.md, PM 11/10 18:13 '추천대로 ㄱ') §2 입력·§3 검산·차량 대조·분류·§4 저장·§8 간극.
// 원칙
//   - 금액은 사람이 확정한다: 앱(판독)이 채운 값도 검산을 통과하기 전엔 확정(done)·전달(sent)이 안 된다(v2 §3-1 — 사유를 적고 넘기는 길 없음).
//   - 값(금액·번호)은 학습·규칙화하지 않는다. 간극은 '칸이 바뀌었는가'만 센다(§8).
//   - 사업자번호·계좌·전화·주민번호는 받지 않는다(piiScan — 걸리면 저장 거절). 대표자·기사·작업자 이름 칸은 받지 않는다(줄 칸에 이름 자리가 없음).
//   - 차량 목록(col:vehicles)은 고치지 않는다 — 줄의 veh는 그 목록 item.id를 가리키기만 한다(있는 id인지는 gw-stmt가 목록으로 확인, 옛 번호 대조는 별칭 사전).
//   - 사람이 보낸 글을 객체 열쇠로 쓰는 지도는 전부 원형 없는 객체(dict) — '__proto__'·'constructor'로 합계가 엉키지 않게(11/10 검토 high).
// 11/10 독립 검토 2관점(권한·개인정보 14건 / 검산·간극 20건) 반영판.
const crypto = require('crypto');

const RE_YM = /^(20\d{2})-(0[1-9]|1[0-2])$/;
const RE_VK = /^v\d{2,3}$/;                       // 거래처 키 — 시드 v01~v12, 새 거래처는 다음 번호(앱이 제안, 서버가 겹침 검사)
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_VEH = /^[A-Za-z0-9가-힣_-]{1,40}$/;      // 차량 목록 item.id 꼴('v' + 등록 때 번호 — 한글 포함, 11/9 스냅숏 실측) · '_common' = 공용(특정 차량 아님)
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];
const RE_RID = /^[A-Za-z][A-Za-z0-9]{0,11}$/;     // 줄 id — 앱 초안 줄과 확정 줄을 짝짓는 열쇠(간극 계산). 영문으로 시작(숫자만 이은 번호·전화 꼴 거절)
const RE_SHA = /^[0-9a-f]{16,64}$/;
const RE_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;   // 제어·방향 바꿈 문자(보이지 않는 글자) — 거절
const VEH_COMMON = '_common';
const KINDS = ['fuel', 'urea', 'tire', 'oil', 'part', 'labor', 'wash', 'cover', 'tool', 'etc'];
const KIND_LABEL = { fuel: '주유', urea: '요소수', tire: '타이어', oil: '오일', part: '부품', labor: '정비 공임', wash: '세차', cover: '덮개', tool: '작업용구', etc: '기타' };
// 작업용구 용도(v2 §3-3) — 안전보건 세부 6항목은 권민지 '안전보건예산집행표' 샘플(C053) 확인 뒤 2단계에서(지금은 한 칸)
const USES = ['posco_cip', 'posco_ep', 'dredge', 'vehicle', 'safety', 'etc'];
const USE_LABEL = { posco_cip: '포스코 CIP', posco_ep: '포스코 EP더스트', dredge: '준설', vehicle: '차량', safety: '안전보건', etc: '기타' };
const TIRE_ACTS = ['puncture', 'used', 'new', ''];   // 펑크 수리 · 중고 교체 · 신품 교체 · 모름
const TIRE_ACT_LABEL = { puncture: '펑크 수리', used: '중고 교체', new: '신품 교체', '': '' };
const HOWS = ['ocr', 'file', 'xlsx', 'hand', 'vision'];   // 줄을 채운 길 — 스캐너 OCR 글자층 · 원본 파일(htm) · 엑셀 · 사람 입력 · 비전(D1 꺼짐 — 켜기 전엔 앱이 쓰지 않음)
const SRC_KINDS = ['scan', 'htm', 'xlsx', 'hand', 'vision', 'nts', 'xml', 'xls', 'pdf'];   // 29 판④: 국세청 보안 계산서 HTML·표준 XML·옛 엑셀·글자 PDF 더함
const BASES = ['total', 'supply'];   // 줄 금액이 부가세 포함(주유소 판매내역 등)인지, 공급가(+세액 칸)인지
const STATUSES = ['doing', 'done', 'sent'];   // 작성 중 · 확정(검산 통과) · 전달함
const FINAL = { done: 1, sent: 1 };
// §8 칸 묶음 — 읽기(번호 판독 글 vraw 포함: 별칭으로 차량이 맞아도 번호 오독은 읽기 간극으로 드러나게)·차량·종류·용도 따로
const GAP_CLASSES = { read: ['date', 'vraw', 'item', 'qty', 'unit', 'amt', 'vat'], veh: ['veh'], kind: ['kind'], use: ['use'] };
const LIMIT = { rows: 400, item: 40, note: 60, vraw: 24, name: 30, hint: 20, hints: 6, vendors: 40, src: 10, srcName: 80, pages: 200, tirePos: 30, alias: 500, vsub: 200, money: 1e10, qty: 1e7 };

// 차량 목록 시드 거래처(v2 §1 — 권민지 브리핑 원문 P03·P13 그대로, R1 기본값: 권민지가 화면에서 고침).
// kind = 그 거래처 줄의 기본 품목 종류('' = 줄마다), basis = 줄 금액 기준(판독요약 2-2 서식 실측, 모르면 supply — 틀리면 붉은 칸으로 드러나고 화면에서 바꿈),
// carry = 잔액형(전기이월·잔액 칸이 있는 명세 — 판독요약 2-2: 스피드·철탑·오천, 확정하려면 잔액 4칸 필수), hint = 파일 이름·글자층에서 거래처를 알아보는 낱말(29 판④ 판별용).
const SEED_VENDORS = [
  { vk: 'v01', name: '스피드타이어', group: 'veh', kind: 'tire', basis: 'supply', carry: true, hint: ['스피드타이어', '스피드'] },
  { vk: 'v02', name: '수양개발', group: 'veh', kind: 'cover', basis: 'supply', carry: false, hint: ['수양개발', '수양'] },
  { vk: 'v03', name: '신일상사', group: 'veh', kind: 'part', basis: 'supply', carry: false, hint: ['신일상사', '신일'] },
  { vk: 'v04', name: '덕천세차장', group: 'veh', kind: '', basis: 'supply', carry: false, hint: ['덕천세차장', '덕천'] },
  { vk: 'v05', name: '대송IC주유소(지에스칼텍스)', group: 'veh', kind: 'fuel', basis: 'total', carry: false, hint: ['대송', '칼텍스'] },
  { vk: 'v06', name: '영남주유소', group: 'veh', kind: 'fuel', basis: 'total', carry: false, hint: ['영남주유소', '영남'] },
  { vk: 'v07', name: '가온상사(요소수)', group: 'veh', kind: 'urea', basis: 'supply', carry: false, hint: ['가온상사', '가온'] },
  { vk: 'v08', name: '포항모터스', group: 'veh', kind: '', basis: 'supply', carry: false, hint: ['포항모터스'] },
  { vk: 'v09', name: '현대상용서비스센터', group: 'veh', kind: '', basis: 'supply', carry: false, hint: ['현대상용'] },
  { vk: 'v10', name: '철탑종합공구상사', group: 'tool', kind: 'tool', basis: 'supply', carry: true, hint: ['철탑'] },
  { vk: 'v11', name: '오천공구', group: 'tool', kind: 'tool', basis: 'supply', carry: true, hint: ['오천공구', '오천'] },
  { vk: 'v12', name: '드림오피스', group: 'tool', kind: 'tool', basis: 'supply', carry: false, hint: ['드림오피스'] }
];

function dict() { return Object.create(null); }
function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function okVeh(s) { return typeof s === 'string' && RE_VEH.test(s) && BAD_KEYS.indexOf(s) < 0; }

// 개인정보 꼴 — 0~3 = learn.js PII_RE와 같은 4개, 4~7 = 이 기능에서 더 넓힘(11/10 검토: 붙여 쓴 주민번호·점/긴 줄표 전화·10자리 이상 숫자·공백 구분 계좌).
// learn.js 쪽 같은 확대는 그 기능 판에서(공용 규칙이라 여기서 바꾸지 않음). 걸리면 저장 거절 — 값은 로그에 안 남김.
const PII_RE = [/\d{6}\s*-\s*[1-4]\d{6}/, /01\d[\s-]?\d{3,4}[\s-]?\d{4}/, /\b\d{2,6}-\d{2,6}-\d{5,8}\b/, /\b\d{2,6}-\d{2,6}-\d{2,6}-\d{1,8}\b/,
  /\d{6}[\s.·–—]?[1-4]\d{6}/, /01\d[\s.·–—]\d{3,4}[\s.·–—]\d{4}/, /\d{10,}/, /\b\d{3,6}[\s.·–—]\d{2,6}[\s.·–—]\d{4,8}\b/];
function piiScan(obj, skipLongDigits) {
  let s; try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (e) { return 'SERIALIZE'; }
  for (let i = 0; i < PII_RE.length; i++) { if (skipLongDigits && i === 6) continue; if (PII_RE[i].test(s)) return 'PII_' + i; }
  return '';
}
function validDay(s) {   // 달력 왕복 — 2026-02-30 같은 날짜 거절
  if (typeof s !== 'string' || !RE_DATE.test(s)) return false;
  const p = s.split('-').map(Number), t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
}
function kstYm(ts) { return new Date((ts || Date.now()) + 9 * 3600000).toISOString().slice(0, 7); }
function ymShift(ym, n) {   // 'YYYY-MM' ± n달
  const p = ym.split('-').map(Number), t = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
  return t.toISOString().slice(0, 7);
}
// 글 칸 — 줄바꿈·탭은 한 칸, 앞뒤 공백 정리. 글이 아니거나 너무 길거나 보이지 않는 제어 글자가 있으면 null
function text(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || RE_CTRL.test(v)) return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? null : s;
}
// 돈 — 원 단위 정수(음수 허용: 반품·할인 줄). 숫자 글은 천 단위 쉼표 꼴만('1,234' ○ · '12,34' ×). 빈칸(공백만 포함)이면 null(allowNull일 때), 잘못이면 undefined
function money(v, allowNull) {
  if (v === undefined || v === null) return allowNull ? null : undefined;
  if (typeof v === 'string') {
    const s = v.replace(/\s|원/g, '');
    if (s === '') return allowNull ? null : undefined;
    if (!/^-?(\d{1,3}(,\d{3})+|\d+)$/.test(s)) return undefined;
    v = Number(s.replace(/,/g, ''));
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > LIMIT.money) return undefined;
  return v === 0 ? 0 : v;   // -0 → 0
}
// 수량·단가 — 소수 4자리까지. 받은 글의 소수 자릿수(d)를 같이 돌려준다(줄 검산 허용 오차 — '30.30'은 2자리). 빈칸이면 null, 잘못이면 undefined
function decimal(v, max) {
  if (v === undefined || v === null) return null;
  let s;
  if (typeof v === 'string') {
    s = v.replace(/\s/g, '');
    if (s === '') return null;
    if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,4})?$/.test(s)) return undefined;
    s = s.replace(/,/g, '');
  } else if (typeof v === 'number' && isFinite(v)) {
    s = String(v);
    if (!/^-?\d+(\.\d{1,4})?$/.test(s)) return undefined;   // 지수 꼴·소수 5자리 이상은 숫자로 와도 거절(글과 같은 규칙)
  } else return undefined;
  const n = Number(s);
  if (!isFinite(n) || Math.abs(n) > max) return undefined;
  return { n: n === 0 ? 0 : n, d: (s.split('.')[1] || '').length };
}
// 차량번호 글 → 비교용(공백·하이픈·기호 뺌). 별칭 사전 열쇠
function normPlate(s) { return typeof s === 'string' ? s.replace(/[^가-힣A-Za-z0-9]/g, '').slice(0, LIMIT.vraw) : ''; }
function plateLast4(s) { const d = typeof s === 'string' ? s.replace(/\D/g, '') : ''; return d.length >= 4 ? d.slice(-4) : ''; }

// 거래처 한 곳 정리(설정 저장·시드 공용) → { v } | { code }
function cleanVendor(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { code: 'BAD_VENDOR' };
  if (typeof x.vk !== 'string' || !RE_VK.test(x.vk)) return { code: 'BAD_VK' };
  const name = text(x.name, LIMIT.name);
  if (!name) return { code: 'BAD_NAME' };
  if (x.group !== 'veh' && x.group !== 'tool') return { code: 'BAD_GROUP' };
  const kind = (x.kind === undefined || x.kind === null) ? '' : x.kind;
  if (kind !== '' && KINDS.indexOf(kind) < 0) return { code: 'BAD_KIND' };
  const basis = (x.basis === undefined || x.basis === null) ? 'supply' : x.basis;
  if (BASES.indexOf(basis) < 0) return { code: 'BAD_BASIS' };
  const hs = (x.hint === undefined || x.hint === null) ? [] : x.hint;
  if (!Array.isArray(hs) || hs.length > LIMIT.hints) return { code: 'BAD_HINT' };
  const hint = [];
  for (const h of hs) { const t = text(h, LIMIT.hint); if (!t) return { code: 'BAD_HINT' }; hint.push(t); }
  return { v: { vk: x.vk, name: name, group: x.group, kind: kind, basis: basis, carry: x.carry === true, active: x.active !== false, hint: hint } };
}
// 거래처 목록(설정 몸체) → { v:[...] } | { code } — 겹치는 vk 거절
function cleanVendors(list) {
  if (!Array.isArray(list) || !list.length || list.length > LIMIT.vendors) return { code: 'BAD_VENDORS' };
  const out = [], seen = dict();
  for (const x of list) {
    const c = cleanVendor(x);
    if (!c.v) return c;
    if (seen[c.v.vk]) return { code: 'DUP_VK' };
    seen[c.v.vk] = 1; out.push(c.v);
  }
  const p = piiScan(out.map(function (v) { return [v.name, v.hint]; }));
  if (p) return { code: p };
  return { v: out };
}
function seedVendors() { return cleanVendors(SEED_VENDORS).v; }

// 줄 하나 정리 → { row } | { code } — ym 밖 날짜 거절(월 귀속 = 줄 날짜, v2 §2), 모르는 칸은 버림.
// 종류(kind) 빈칸은 받는다(초안·작성 중 — 기본 종류가 없는 거래처 v04·v08·v09) — 확정 때 검산이 'kind'로 막는다(11/10 검토 L4)
function cleanRow(x, ym) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { code: 'BAD_ROW' };
  const r = (x.r === undefined || x.r === null || x.r === '') ? '' : x.r;
  if (r !== '' && (typeof r !== 'string' || !RE_RID.test(r))) return { code: 'BAD_RID' };
  const date = (x.date === undefined || x.date === null) ? '' : x.date;
  if (date !== '' && !validDay(date)) return { code: 'BAD_DATE' };
  if (date !== '' && date.slice(0, 7) !== ym) return { code: 'ROW_MONTH' };
  const veh = (x.veh === undefined || x.veh === null) ? '' : x.veh;
  if (veh !== '' && !okVeh(veh)) return { code: 'BAD_VEH' };
  const vraw = text(x.vraw, LIMIT.vraw);
  if (vraw === null || (vraw && !/^[가-힣A-Za-z0-9 ()-]+$/.test(vraw))) return { code: 'BAD_VRAW' };
  const item = text(x.item, LIMIT.item), note = text(x.note, LIMIT.note);
  if (item === null || note === null) return { code: 'BAD_TEXT' };
  const kind = (x.kind === undefined || x.kind === null) ? '' : x.kind;
  if (kind !== '' && KINDS.indexOf(kind) < 0) return { code: 'BAD_KIND' };
  const use = (x.use === undefined || x.use === null) ? '' : x.use;
  if (use !== '' && USES.indexOf(use) < 0) return { code: 'BAD_USE' };
  const qty = decimal(x.qty, LIMIT.qty), unit = decimal(x.unit, LIMIT.money);
  if (qty === undefined || unit === undefined) return { code: 'BAD_NUMBER' };
  // 금액 빈칸(null)은 받는다(29 판② — 작성 중 저장은 언제든: 종이를 보며 넣다 멈춘 줄) — 검산이 'amt'로 붉게 해 확정(done·sent)을 막는다
  const amt = money(x.amt, true), vat = money(x.vat, true);
  if (amt === undefined || vat === undefined) return { code: 'BAD_MONEY' };
  const how = (x.how === undefined || x.how === null) ? 'hand' : x.how;
  if (HOWS.indexOf(how) < 0) return { code: 'BAD_HOW' };
  let tire = null;
  if (kind === 'tire' && x.tire !== undefined && x.tire !== null) {
    if (typeof x.tire !== 'object' || Array.isArray(x.tire)) return { code: 'BAD_TIRE' };
    const pos = text(x.tire.pos, LIMIT.tirePos), act = (x.tire.act === undefined || x.tire.act === null) ? '' : x.tire.act;
    if (pos === null || TIRE_ACTS.indexOf(act) < 0) return { code: 'BAD_TIRE' };
    tire = { pos: pos, act: act };
  }
  return { row: { r: r, date: date, veh: veh, vraw: vraw, item: item, kind: kind, use: use,
    qty: qty ? qty.n : null, qd: qty ? qty.d : 0, unit: unit ? unit.n : null, ud: unit ? unit.d : 0, amt: amt, vat: vat, tire: tire, how: how, note: note } };
}
// 줄 목록 → { rows } | { code, at } — 줄 id 겹침 거절, 줄 글에 개인정보 꼴이 있으면 거절
function cleanRows(list, ym, needRid) {
  if (!Array.isArray(list) || list.length > LIMIT.rows) return { code: 'BAD_ROWS' };
  const rows = [], seen = dict();
  for (let i = 0; i < list.length; i++) {
    const c = cleanRow(list[i], ym);
    if (!c.row) return { code: c.code, at: i };
    if (needRid && !c.row.r) return { code: 'NO_RID', at: i };
    if (c.row.r) { if (seen[c.row.r]) return { code: 'DUP_RID', at: i }; seen[c.row.r] = 1; }
    rows.push(c.row);
  }
  const p = piiScan(rows.map(function (x) { return [x.item, x.note, x.vraw, x.tire ? x.tire.pos : '']; }));
  if (p) return { code: p };
  return { rows: rows };
}
function cleanInv(x) {   // 전자세금계산서 합계 { date, supply, vat, total } | null
  if (x === undefined || x === null) return { v: null };
  if (typeof x !== 'object' || Array.isArray(x)) return { code: 'BAD_INV' };
  const date = (x.date === undefined || x.date === null) ? '' : x.date;
  if (date !== '' && !validDay(date)) return { code: 'BAD_INV' };
  const s = money(x.supply, false), v = money(x.vat, false), t = money(x.total, false);
  if (s === undefined || v === undefined || t === undefined) return { code: 'BAD_INV' };
  return { v: { date: date, supply: s, vat: v, total: t } };
}
// 잔액형 원장 4칸 { prev 전기이월, month 당월(부가세 포함 — 원장에 적힌 값), paid 당월 입금, bal 잔액 } | null
// 당월을 계산서 합계로 갈음하지 않는다 — 원장은 거래마다 세액을 반올림해 계산서(합산 세액)와 몇 원 다를 수 있다(11/10 검토 M2)
function cleanCarry(x) {
  if (x === undefined || x === null) return { v: null };
  if (typeof x !== 'object' || Array.isArray(x)) return { code: 'BAD_CARRY' };
  const p = money(x.prev, false), m = money(x.month, false), d = money(x.paid, false), b = money(x.bal, false);
  if (p === undefined || m === undefined || d === undefined || b === undefined) return { code: 'BAD_CARRY' };
  return { v: { prev: p, month: m, paid: d, bal: b } };
}
// 명세서의 차량 소계 { 차량 id: 금액 } | null — 줄을 다른 차에 붙인 판독 오류를 잡는다(v2 §3-1 '줄 합 = 차량 소계', 11/10 검토 M4)
function cleanVsub(x) {
  if (x === undefined || x === null) return { v: null };
  if (typeof x !== 'object' || Array.isArray(x)) return { code: 'BAD_VSUB' };
  const ks = Object.keys(x);
  if (ks.length > LIMIT.vsub) return { code: 'BAD_VSUB' };
  if (!ks.length) return { v: null };
  const out = dict();
  for (const k of ks) {
    if (!okVeh(k)) return { code: 'BAD_VSUB' };
    const m = money(x[k], false);
    if (m === undefined) return { code: 'BAD_VSUB' };
    out[k] = m;
  }
  return { v: out };
}
// 넣은 파일 표시 — 이름(경로 뺀 파일 이름)·쪽 수·sha. 파일 자체는 저장하지 않는다(v2 §4 — 원본은 권민지 PC·종이).
// 스캐너 기본 이름의 긴 숫자(날짜시각)는 '…'로 줄여 저장(10자리 이상 숫자 꼴 거절에 걸리지 않게), 그 밖 개인정보 꼴은 거절
function cleanSrc(list) {
  if (list === undefined || list === null) return { v: [] };
  if (!Array.isArray(list) || list.length > LIMIT.src) return { code: 'BAD_SRC' };
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object' || Array.isArray(x) || SRC_KINDS.indexOf(x.kind) < 0) return { code: 'BAD_SRC' };
    if (x.name !== undefined && x.name !== null && typeof x.name !== 'string') return { code: 'BAD_SRC' };
    const name = text(String(x.name || '').split(/[\\/]/).pop().replace(/\d{10,}/g, '…'), LIMIT.srcName);
    const pages = (x.pages === undefined || x.pages === null) ? 0 : x.pages;
    const sha = (x.sha === undefined || x.sha === null) ? '' : x.sha;
    if (name === null || !Number.isInteger(pages) || pages < 0 || pages > LIMIT.pages || (sha !== '' && (typeof sha !== 'string' || !RE_SHA.test(sha)))) return { code: 'BAD_SRC' };
    out.push({ kind: x.kind, name: name, pages: pages, sha: sha });
  }
  const p = piiScan(out.map(function (x) { return x.name; }), true);
  if (p) return { code: p };
  return { v: out };
}

// ---- 검산(v2 §3-1 — 「덧대기」: 종이·손글씨 명세가 남는 한 판독 오류를 뒤에서 잡는다) ----
// 줄: 수량×단가 = 금액 — 허용 오차는 받은 글의 소수 자릿수만큼(수량 '30.30' × 단가 1,650 → ±9원, 정수×정수 → 0원). 금액이 음수면(할인·반품) 절댓값끼리.
//     종류 빈칸 · 차량 거래처 줄 차량 없음 · 용구 거래처 줄 용도 없음 · 용구 '차량' 용도인데 차량 없음 = 붉음
// 묶음(명세 기준 mode): total = 줄 금액이 부가세 포함 / supvat = 공급가 + 세액 칸 / suponly = 공급가만(세액 칸 없음)
//   계산서: total → 줄 합 = 합계(0원) · supvat → 공급가 합 = 공급가(0원)·세액 합 = 세액(세액 칸 있는 줄 수 원까지 — 줄마다 반올림) · suponly → 공급가 합 = 공급가(0원) · 계산서 자체 공급가+세액=합계
//   명세 합계(stated): 같은 줄에서 나온 값이라 0원(명세 기준 합 — total 줄 합 · supvat 공급가+세액 · suponly 공급가)
//   차량 소계(vsub): 차량별 명세 기준 합 = 소계(0원)
//   잔액형: 원장 4칸 자체 식(전기이월 + 당월 − 입금 = 잔액, 0원) + 원장 당월 = 줄 합(부가세 포함 — 추정 줄 수 원까지). 거래처가 잔액형인데 4칸이 없으면 붉음
// 부가세 포함 금액(gross — 월 보드·차량 이력을 한 기준으로 더하는 값): total = 금액 · supvat = 금액+세액 · suponly = 금액 × 계산서 합계/공급가(없으면 ×1.1 — '추정' 줄로 셈)
function calcTol(x) {
  let t = 0;
  if (x.qd) t += Math.ceil(Math.abs(x.unit) * 0.5 * Math.pow(10, -x.qd));
  if (x.ud) t += Math.ceil(Math.abs(x.qty) * 0.5 * Math.pow(10, -x.ud));
  return t;
}
function amtOf(x) { return typeof x.amt === 'number' ? x.amt : 0; }   // 금액 빈칸 = 0으로 더함(그 줄은 'amt'로 붉음 — 확정 불가)
function rowIssues(x, group) {
  const out = [];
  if (typeof x.amt !== 'number') out.push('amt');
  else if (typeof x.qty === 'number' && typeof x.unit === 'number') {
    // 29 판④(11/14 실물): 단가가 부가세 포함인 명세(가온 요소수 단가 1,500 → 공급가 17,727 + 세액 1,773 · 오천 상품상세)는 수량×단가 = 공급가 + 세액 — 세액 칸이 있으면 그것도 통과
    const q = Math.round(Math.abs(x.qty * x.unit)), t = calcTol(x);
    const okAmt = Math.abs(q - Math.abs(x.amt)) <= t, okGross = typeof x.vat === 'number' && Math.abs(q - Math.abs(x.amt + x.vat)) <= t;
    if (!okAmt && !okGross) out.push('calc');
  }
  if (!x.kind) out.push('kind');
  if (group === 'veh' && !x.veh) out.push('veh');
  if (group === 'tool' && !x.use) out.push('use');
  if (group === 'tool' && x.use === 'vehicle' && !x.veh) out.push('veh');
  return out;
}
function docMode(doc) {
  if (doc.basis === 'total') return 'total';
  return (doc.rows || []).some(function (x) { return x.vat !== null && x.vat !== undefined; }) ? 'supvat' : 'suponly';
}
function rowOwn(x, mode) { return mode === 'supvat' ? amtOf(x) + (x.vat || 0) : amtOf(x); }
function rowGross(x, doc, mode) {
  if (mode === 'total') return { v: amtOf(x), est: false };
  if (mode === 'supvat') return { v: amtOf(x) + (x.vat || 0), est: false };
  if (doc.inv && doc.inv.supply) return { v: Math.round(amtOf(x) * doc.inv.total / doc.inv.supply), est: true };
  return { v: Math.round(amtOf(x) * 1.1), est: true };
}
// vendor = 거래처 설정(잔액형 여부·묶음) — 묶음은 저장된 문서 값(doc.group)이 먼저(설정을 나중에 바꿔도 지난 문서 판정이 안 바뀌게)
function checkDoc(doc, vendor) {
  const group = doc.group || (vendor && vendor.group) || 'veh';
  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  const mode = docMode(doc);
  const bad = [], ownByVeh = dict(), vehKinds = dict();
  let sumAmt = 0, sumVat = 0, nVat = 0, sumOwn = 0, sumGross = 0, est = 0;
  rows.forEach(function (x, i) {
    const is = rowIssues(x, group);
    if (is.length) bad.push({ i: i, r: x.r || '', why: is });
    sumAmt += amtOf(x);
    if (x.vat !== null && x.vat !== undefined) { sumVat += x.vat; nVat++; }
    const o = rowOwn(x, mode), g = rowGross(x, doc, mode);
    sumOwn += o; sumGross += g.v; if (g.est) est++;
    if (x.veh) {
      ownByVeh[x.veh] = (ownByVeh[x.veh] || 0) + o;
      const vk = vehKinds[x.veh] = vehKinds[x.veh] || dict();
      const kd = x.kind || 'etc', a = vk[kd] = vk[kd] || [0, 0];
      a[0] += 1; a[1] += g.v;
    }
  });
  const issues = [];
  let invDiff = null, supDiff = null, vatDiff = null, statedDiff = null, carryOk = null, monthDiff = null;
  const vsubBad = [];
  if (doc.inv) {
    if (doc.inv.supply + doc.inv.vat !== doc.inv.total) issues.push('inv_sum');
    if (mode === 'total') { invDiff = sumAmt - doc.inv.total; if (invDiff !== 0) issues.push('inv'); }
    else if (mode === 'supvat') { supDiff = sumAmt - doc.inv.supply; vatDiff = sumVat - doc.inv.vat; invDiff = sumAmt + sumVat - doc.inv.total; if (supDiff !== 0 || Math.abs(vatDiff) > nVat) issues.push('inv'); }
    else { supDiff = sumAmt - doc.inv.supply; invDiff = supDiff; if (supDiff !== 0) issues.push('inv'); }
  }
  if (doc.stated !== null && doc.stated !== undefined) { statedDiff = sumOwn - doc.stated; if (statedDiff !== 0) issues.push('stated'); }
  if (!doc.inv && (doc.stated === null || doc.stated === undefined)) issues.push('no_ref');
  if (doc.vsub) {
    Object.keys(doc.vsub).forEach(function (v) { const s = ownByVeh[v] || 0; if (s !== doc.vsub[v]) vsubBad.push({ veh: v, diff: s - doc.vsub[v] }); });
    if (vsubBad.length) issues.push('vsub');
  }
  if (vendor && vendor.carry && !doc.carry) issues.push('no_carry');
  if (doc.carry) {
    carryOk = doc.carry.prev + doc.carry.month - doc.carry.paid === doc.carry.bal;
    if (!carryOk) issues.push('carry');
    monthDiff = doc.carry.month - sumGross;
    if (Math.abs(monthDiff) > est) issues.push('carry_month');
  }
  if (!rows.length) issues.push('no_rows');
  return { ok: !bad.length && !issues.length, mode: mode, bad: bad, issues: issues, sum_amt: sumAmt, sum_vat: sumVat, sum_own: sumOwn, sum_gross: sumGross, est: est,
    inv_diff: invDiff, sup_diff: supDiff, vat_diff: vatDiff, stated_diff: statedDiff, vsub_bad: vsubBad, carry_ok: carryOk, month_diff: monthDiff, veh_kinds: vehKinds };
}

// ---- 간극(v2 §8 — 사람 승인 단계 없음, 값 없이 칸 변경 여부만) ----
// 앱 초안 줄(draft — 판독·자동 대조가 채운 판)과 확정 줄을 줄 id(r)로 짝지어, 초안에서 값이 있던 칸 중 바뀐 칸을 묶음별로 센다.
// 초안 줄이 확정에서 빠졌으면 그 줄의 채운 칸 전부 '바뀜', 확정에만 있는 줄(사람이 더함)은 rows.added로만 센다(분모에 안 들어감).
function same(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
}
function filled(v) { return !(v === '' || v === null || v === undefined); }
function gapCount(draftRows, rows) {
  const fin = dict(), filledN = {}, changedN = {}, draftIds = dict();
  Object.keys(GAP_CLASSES).forEach(function (k) { filledN[k] = 0; changedN[k] = 0; });
  (rows || []).forEach(function (x) { if (x && x.r) fin[x.r] = x; });
  let deleted = 0, added = 0;
  (draftRows || []).forEach(function (d) {
    if (!d || !d.r) return;
    draftIds[d.r] = 1;
    const f = fin[d.r];
    if (!f) deleted++;
    Object.keys(GAP_CLASSES).forEach(function (k) {
      GAP_CLASSES[k].forEach(function (fld) {
        if (!filled(d[fld])) return;
        filledN[k]++;
        if (!f || !same(d[fld], f[fld])) changedN[k]++;
      });
    });
  });
  (rows || []).forEach(function (x) { if (!x || !x.r || !draftIds[x.r]) added++; });
  return { filled: filledN, changed: changedN, rows: { draft: (draftRows || []).length, final: (rows || []).length, deleted: deleted, added: added } };
}

// ---- 월 색인 한 줄(월 보드·차량별 이력) — 거래처·월 문서에서 금액 요약만. total·차량 합 = 부가세 포함 한 기준(gross), est = 비율로 추정한 줄 수 ----
function vendorSummary(doc, chk) {
  return { group: doc.group, status: doc.status, rows: (doc.rows || []).length, bad: chk.bad.length, issues: chk.issues.slice(0, 8), ok: chk.ok,
    total: chk.sum_gross, est: chk.est, inv: doc.inv ? doc.inv.total : null, stated: (doc.stated === null || doc.stated === undefined) ? null : doc.stated,
    bal: doc.carry ? doc.carry.bal : null, draft: !!doc.draft, at: doc.updated_at, by: doc.updated_by, veh: chk.veh_kinds,
    sent: (doc.status === 'sent' && doc.sent && typeof doc.sent === 'object') ? { at: Number(doc.sent.at) || 0, via: String(doc.sent.via || ''), by: String(doc.sent.by || '') } : null };   // 29 판⑤ 전달 기록(월 보드 상태 글 · 누가 전달 — 비관리자는 결재 목록에 자기 상신만 보여 '보고 없음' 판정을 자기가 전달한 곳으로 한정)
}
// 차량 하나의 달별 종류 합(색인 여러 달) → [{ ym, kinds:{kind:[n, gross]}, total, vendors:[vk], pending:[vk] }]
// 합에는 확정(done·sent)이고 검산 통과인 거래처만 넣는다 — 작성 중·붉은 문서는 pending으로 이름만(11/10 검토 M5)
function vehMonths(idxDocs, vehId) {
  return idxDocs.map(function (ix) {
    const kinds = dict(), vendors = [], pending = [];
    let total = 0;
    const vs = (ix.doc && ix.doc.vendors) || {};
    Object.keys(vs).sort().forEach(function (vk) {
      const s = vs[vk], v = (s && hasOwn(s.veh, vehId)) ? s.veh[vehId] : null;
      if (!v || typeof v !== 'object') return;
      if (!(s.ok === true && FINAL[s.status])) { pending.push(vk); return; }
      vendors.push(vk);
      Object.keys(v).forEach(function (kd) {
        const p = v[kd];
        if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') return;
        const a = kinds[kd] = kinds[kd] || [0, 0]; a[0] += p[0]; a[1] += p[1]; total += p[1];
      });
    });
    return { ym: ix.ym, kinds: kinds, total: total, vendors: vendors, pending: pending };
  }).filter(function (m) { return m.vendors.length || m.pending.length; });
}
function sha16(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

// ---- 차량 대조(v2 §3-2 「덧대기」 — 거래처가 옛 번호를 계속 쓰는 것은 우리가 못 고친다. 원천(차량 목록 옛 번호 표기 통일)은 차량 담당 몫) ----
// 차량 목록(col:vehicles) 한 대 → 현재 번호 + 옛 번호: 번호 칸 괄호 '(구…)' · id(= 'v' + 등록 때 번호 — 번호가 바뀌어도 id는 그대로) · 비고의 번호 꼴('12가3456', '구 3456')
// 11/9 스냅숏 실측(판독요약 3-2): 번호 바뀐 차 4대 = '(구…)' 2대 + id·비고에만 2대 — 끝 4자리 단순 대조로는 4대 모두 안 잡힘
const RE_PLATE = /\d{2,3}\s?[가-힣]\s?\d{4}/g;
function vehKeys(v) {
  const no = typeof (v && v.no) === 'string' ? v.no : '';
  const outside = no.replace(/\([^)]*\)/g, ' ');
  const curM = outside.match(RE_PLATE);
  const cur = normPlate(curM ? curM[0] : outside), cur4 = plateLast4(curM ? curM[0] : outside);
  const oldFull = dict(), old4 = dict();
  function addOld(s) { const n = normPlate(s); if (n && n !== cur) { oldFull[n] = 1; const d = plateLast4(n); if (d && d !== cur4) old4[d] = 1; } }
  (no.match(/\([^)]*\)/g) || []).forEach(function (p) {
    if (!/구/.test(p)) return;
    const m = p.match(RE_PLATE);
    if (m) m.forEach(addOld); else { const d = (p.match(/구\s*(\d{4})/) || [])[1]; if (d && d !== cur4) old4[d] = 1; }
  });
  const idPlate = ((typeof (v && v.id) === 'string' ? v.id : '').replace(/^v/, '').match(RE_PLATE) || [])[0];
  if (idPlate) addOld(idPlate);
  const note = typeof (v && v.note) === 'string' ? v.note : '';
  (note.match(RE_PLATE) || []).forEach(addOld);
  (note.match(/구\s*(?:번호)?\s*(\d{4})(?!\d)/g) || []).forEach(function (s) { const d = s.replace(/\D/g, '').slice(-4); if (d && d !== cur4) old4[d] = 1; });
  return { cur: cur, cur4: cur4, old: Object.keys(oldFull), old4: Object.keys(old4) };
}
// 차량 목록 → 찾기 표 + 고르기 목록(id·끝 4자리·차종·자차/지입·상태 — 기사·보험·비고·번호 칸은 내보내지 않는다. id는 'v'+등록 때 번호라 전체 번호가 든다 → 차량 보기 권한자에게만, gw-stmt)
// ids = 지운 차까지 모든 id(지난달 줄이 가리키는 차가 나중에 지워져도 그 달 문서를 다시 저장할 수 있게)
function vehIndex(items) {
  const full = dict(), l4 = dict(), list = [], ids = dict();
  function put(o, k, id, old) { if (!k) return; const a = o[k] = o[k] || []; if (!a.some(function (x) { return x.id === id; })) a.push({ id: id, old: old }); }
  (items || []).forEach(function (v) {
    if (!v || typeof v !== 'object' || !okVeh(v.id)) return;
    ids[v.id] = 1;
    if (v.del === 1) return;
    const k = vehKeys(v);
    put(full, k.cur, v.id, false); put(l4, k.cur4, v.id, false);
    k.old.forEach(function (o) { put(full, o, v.id, true); });
    k.old4.forEach(function (o) { put(l4, o, v.id, true); });
    list.push({ id: v.id, l4: k.cur4, old4: k.old4, type: String(v.type || '').slice(0, 20), own: v.own === '지입' ? '지입' : (v.own === '자차' ? '자차' : ''), state: String(v.state || '').slice(0, 10) });
  });
  return { full: full, l4: l4, list: list, ids: ids };
}
// 명세서에 찍힌 번호 글 하나 → { how, veh, cand } — how: alias(사람이 고른 것) · plate(현재 번호 전체) · old(옛 번호 전체) · last4(끝 4자리, 현재 번호 한 대) · old4(끝 4자리, 옛 번호 한 대) · multi(여러 대 — 사람이 고름) · none(처음 보는 번호)
function matchPlate(raw, ix, alias) {
  const key = normPlate(raw);
  if (!key) return { how: 'none', veh: '', cand: [] };
  if (alias && hasOwn(alias, key) && okVeh(alias[key])) return { how: 'alias', veh: alias[key], cand: [] };
  const f = hasOwn(ix.full, key) ? ix.full[key] : [];
  const fc = f.filter(function (x) { return !x.old; }), fo = f.filter(function (x) { return x.old; });
  if (fc.length === 1) return { how: 'plate', veh: fc[0].id, cand: [] };
  if (!fc.length && fo.length === 1) return { how: 'old', veh: fo[0].id, cand: [] };
  if (f.length > 1) return { how: 'multi', veh: '', cand: f.map(function (x) { return x.id; }) };
  const digits = key.replace(/\D/g, '');
  if (digits.length < 4) return { how: 'none', veh: '', cand: [] };
  const h = hasOwn(ix.l4, digits.slice(-4)) ? ix.l4[digits.slice(-4)] : [];
  if (h.length === 1) return { how: h[0].old ? 'old4' : 'last4', veh: h[0].id, cand: [] };
  if (h.length > 1) return { how: 'multi', veh: '', cand: h.map(function (x) { return x.id; }) };
  return { how: 'none', veh: '', cand: [] };
}

module.exports = {
  RE_YM, RE_VK, RE_VEH, VEH_COMMON, KINDS, KIND_LABEL, USES, USE_LABEL, TIRE_ACTS, TIRE_ACT_LABEL, HOWS, BASES, STATUSES, FINAL, GAP_CLASSES, LIMIT, SEED_VENDORS,
  dict, okVeh, piiScan, validDay, kstYm, ymShift, text, money, decimal, normPlate, plateLast4, cleanVendor, cleanVendors, seedVendors, cleanRow, cleanRows, cleanInv, cleanCarry, cleanVsub, cleanSrc,
  calcTol, rowIssues, docMode, checkDoc, gapCount, vendorSummary, vehMonths, sha16, vehKeys, vehIndex, matchPlate
};
