'use strict';

// 감사 로그(audit trail) — 서버측에서만 기록(클라이언트 직접 쓰기 불가 → 위변조 방지).
// 월별 블롭 audit:YYYY-MM (gw_data 스토어). 항목: {ts,by,bid,col,ev:[{op,id,t,f?}]}
// ev.f = {필드: [이전값, 새값]} (값은 문자열화·80자 절단, PIN 등 비밀값은 기록 안 함)
const { store, blobGet, blobSet } = require('./blobs');

const DATA = 'gw_data';
const MAX_PER_MONTH = 8000;   // 월 상한(초과 시 오래된 것부터 잘림) — 16인 규모에서 도달할 일 없음

function auditKey(month) {
  if (month && /^\d{4}-\d{2}$/.test(month)) return 'audit:' + month;
  const d = new Date();
  return 'audit:' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

async function appendAudit(entry) {
  // 저장 실패가 본 작업을 막으면 안 됨 — 전부 삼킴
  try {
    const st = store(DATA);
    const key = auditKey();
    const r = await blobGet(st, key);
    const doc = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data : { schema: 1, items: [] };
    doc.items.push(entry);
    if (doc.items.length > MAX_PER_MONTH) doc.items = doc.items.slice(-MAX_PER_MONTH);
    await blobSet(st, key, doc);
  } catch (e) { /* no-op */ }
}

function short(v) {
  if (v === undefined) return '';
  if (v === null) return '';
  let s;
  if (typeof v === 'object') { try { s = JSON.stringify(v); } catch { s = String(v); } }
  else s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

// items 배열 diff(id 기준). 추가/제거/필드변경 이벤트 생성. updated류 제외.
const SKIP_FIELDS = { updated: 1, updated_at: 1, created: 1 };
function itemTitle(it) {
  return short(it.title || it.name || it.client || it.no || it.member_name || it.label || it.id || '');
}
function diffItems(oldItems, newItems, maxEv) {
  maxEv = maxEv || 30;
  const ev = [];
  const oldBy = {};
  (oldItems || []).forEach(function (it) { if (it && it.id) oldBy[it.id] = it; });
  const seen = {};
  for (const it of (newItems || [])) {
    if (!it || !it.id) continue;
    seen[it.id] = 1;
    const old = oldBy[it.id];
    if (!old) { ev.push({ op: '추가', id: it.id, t: itemTitle(it) }); }
    else {
      const f = {};
      const keys = new Set(Object.keys(old).concat(Object.keys(it)));
      for (const k of keys) {
        if (SKIP_FIELDS[k]) continue;
        const a = old[k], b = it[k];
        const sa = (typeof a === 'object') ? JSON.stringify(a) : a;
        const sb = (typeof b === 'object') ? JSON.stringify(b) : b;
        if (sa !== sb && !(a == null && b == null)) f[k] = [short(a), short(b)];
      }
      if (Object.keys(f).length) ev.push({ op: '수정', id: it.id, t: itemTitle(it), f: f });
    }
    if (ev.length >= maxEv) { ev.push({ op: '생략', id: '', t: '이후 변경 생략(상한)' }); return ev; }
  }
  for (const id in oldBy) {
    if (!seen[id]) { ev.push({ op: '제거', id: id, t: itemTitle(oldBy[id]) }); if (ev.length >= maxEv) break; }
  }
  return ev;
}

module.exports = { appendAudit, auditKey, diffItems, short, DATA };
