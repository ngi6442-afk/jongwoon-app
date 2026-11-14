'use strict';

// P1 판7(원장 C102) 법령 개정 감지 목록 — gw-lawwatch(쌓기)·gw-data lic_recheck_get(읽기) 공용.
//   저장 = 별도 키 CHANGED_KEY('lawwatch:changed' {schema, items:[{name, date, mst, prev_mst}], ts}) — lawwatch:last(경보 전문·bg_recheck)와 나눔.
//     gw-lawwatch는 이 키 읽기에 성공했을 때만(없음 = 빈 목록) 합쳐 씀 · 못 읽으면 안 씀(누적을 덮지 않음) · 바뀐 것이 없으면 안 씀(adwatch 등 감지 없는 회차).
//   원천 = 수집기 POST law_changed + 경보 글 '[법령 개정 감지] 이름: …'(날짜 = 그 회차 date — 11/9 감지분·이 키 쓰기를 못 한 회차가 lawwatch:last에 남은 꼴).
//     gw-lawwatch는 덮기 전 앞 판 lawwatch:last의 경보 글 감지분도 주워 담고, lic_recheck_get은 이 키 + 지금 lawwatch:last 경보 글을 합쳐 내린다.
//   같은 법령은 가장 늦은 감지 날짜 하나만 · 2년(KEEP_DAYS) 넘은 감지는 뺌 · 최대 MAX건.
//   맞춤(의무 대장 행 law 칸)·풀림(행 확인 날짜 > 감지 날짜)은 앱 licRkMarks — 이 목록은 표시 재료일 뿐 기한 계산 입력이 아니다.
const ALERT_RE = /^\[법령 개정 감지\] (.+?): /;
const CHANGED_KEY = 'lawwatch:changed';
const KEEP_DAYS = 730;
const MAX = 300;

function isDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
function kstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
function nameKey(s) { return String(s || '').replace(/[\s·ㆍ・‧∙]/g, ''); }
function clean(x, dflt) {   // 한 줄 꼴 맞춤 — 이름 없음·날짜 못 정함 = null
  if (!x || typeof x !== 'object') return null;
  const name = String(x.name == null ? '' : x.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  const date = isDay(x.date) ? x.date : (isDay(dflt) ? dflt : '');
  if (!name || !date) return null;
  const o = { name: name, date: date };
  if (Number(x.mst) > 0) o.mst = Number(x.mst);
  if (Number(x.prev_mst) > 0) o.prev_mst = Number(x.prev_mst);
  return o;
}
// 한 문서(lawwatch:last 꼴 또는 수집기 POST 본문)에서 감지 목록 — law_changed + 경보 글
function fromDoc(doc) {
  if (!doc || typeof doc !== 'object') return [];
  const dflt = isDay(doc.date) ? doc.date : '';
  const out = [];
  (Array.isArray(doc.law_changed) ? doc.law_changed.slice(0, 200) : []).forEach(function (x) { const c = clean(x, dflt); if (c) out.push(c); });
  (Array.isArray(doc.alerts) ? doc.alerts.slice(0, 200) : []).forEach(function (a) { const m = String(a || '').match(ALERT_RE); if (m) { const c = clean({ name: m[1] }, dflt); if (c) out.push(c); } });
  return out;
}
// 여러 목록 합침 — 같은 이름(빈칸·가운뎃점 무시)은 가장 늦은 날짜 줄 · 오늘 뒤 날짜는 오늘로 · 2년 넘은 감지 뺌 · 늦은 날짜 순 MAX건
function merge(lists, today) {
  const td = isDay(today) ? today : kstToday();
  const cut = new Date(Date.parse(td + 'T00:00:00Z') - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const by = {};
  (lists || []).forEach(function (l) {
    (Array.isArray(l) ? l : []).forEach(function (x) {
      const c = clean(x, ''); if (!c) return;
      if (c.date > td) c.date = td;
      if (c.date < cut) return;
      const k = nameKey(c.name), o = by[k];
      if (!o || c.date > o.date || (c.date === o.date && !o.mst && c.mst)) by[k] = c;
    });
  });
  return Object.keys(by).map(function (k) { return by[k]; })
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0))); })
    .slice(0, MAX);
}

// 별도 키 문서 → 목록(꼴 틀림 = 빈 목록)
function itemsOf(doc) { return (doc && typeof doc === 'object' && Array.isArray(doc.items)) ? doc.items : []; }
// 두 목록이 같은 내용인지(합친 결과가 저장본과 같으면 쓰지 않음)
function sameList(a, b) { return JSON.stringify(a || []) === JSON.stringify(b || []); }

module.exports = { fromDoc, merge, itemsOf, sameList, isDay, kstToday, nameKey, ALERT_RE, CHANGED_KEY, KEEP_DAYS, MAX };
