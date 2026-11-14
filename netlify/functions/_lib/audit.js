'use strict';

// 감사 로그(audit trail) — 서버측에서만 기록(클라이언트 직접 쓰기 불가 → 위변조 방지).
// 월별 블롭 audit:YYYY-MM (gw_data 스토어). 항목: {ts,by,bid,col,ev:[{op,id,t,f?}]}
// ev.f = {필드: [이전값, 새값]} (값은 문자열화·80자 절단, PIN 등 비밀값은 기록 안 함)
const { store, blobGet, blobSet, blobList } = require('./blobs');

const DATA = 'gw_data';
const MAX_PER_MONTH = 8000;   // 한 키(조각) 줄 상한 — 백업 복원 병합(gw-data backupLogMerge)이 이 값을 넘기면 400 AUDIT_FULL. P1 판31부터 appendAudit는 잘라 내지 않고 아래 조각 상한에서 새 조각으로 넘긴다
// P1 판31 감사 기록 월 상한 분할(원장 T476) — 한 달 문서가 상한에 닿으면 같은 달 안에서 다음 조각으로 나눠 담는다(종전: 8000줄을 넘으면 오래된 줄부터 잘림 = 기록이 빠짐).
//   조각 1 = 'audit:YYYY-MM'(종전 키 그대로 — 머리) · 조각 n(≥2) = 'audit:YYYY-MM:n'. 조각은 쓰는 쪽·읽는 쪽 모두 키 목록(접두어 'audit:YYYY-MM:')으로 찾는다
//   (검토 11/14 — 머리 parts는 옛 문서·복원 병합 호환으로만 읽고 새로 쓰지 않음: 머리를 다시 쓰면 그사이 머리에 붙은 줄을 지울 수 있어서).
//   상한 근거(운영 백업 11/13 20:15 실측): 10월 1,696줄·382,546바이트(줄당 225) · 11월 1~13일 1,284줄·295,798바이트(줄당 230 — 한 달 약 70만 바이트 예상) · 가장 긴 줄 5,847바이트.
//   넷리파이 함수 요청·응답 6MB(6,291,456) — 백업 내보내기(backup_get)는 키 하나씩, 감사 화면(audit)은 그달 조각을 합쳐 1MB 넘으면 gzip(gw-data gzipOut)으로 낸다.
//   한 조각 = 1,000,000바이트·4,000줄 — 응답 한도의 1/6이라 압축 없이도 backup_get이 넉넉하고, 4,000줄은 MAX_PER_MONTH(복원 병합 상한 8000)의 절반이라 복원 줄을 더해도 거절되지 않는다.
//   조각 수 상한 PART_MAX(60 = 60MB/월 — 지금 속도의 80배 넘음)에 닿으면 쓰지 않고 false(잘라 내지 않음 — 기록물 액션은 audit:false로 드러남).
const PART_MAX_BYTES = 1000000;
const PART_MAX_ITEMS = 4000;
const PART_MAX = 60;

function auditKey(month) {
  if (month && /^\d{4}-\d{2}$/.test(month)) return 'audit:' + month;
  const d = new Date();
  return 'audit:' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// 조각 키 — n 1 = 머리(종전 키) · n ≥ 2 = 'audit:YYYY-MM:n'
function auditPartKey(head, n) { return n <= 1 ? head : head + ':' + n; }
function auditParts(doc) { const n = Math.floor(Number(doc && doc.parts)); return (n >= 2 && n <= PART_MAX) ? n : 1; }
function auditDocOk(x) { return !!x && typeof x === 'object' && Array.isArray(x.items); }
function auditBytes(x) { try { return Buffer.byteLength(JSON.stringify(x), 'utf8'); } catch (e) { return Infinity; } }
// 이 줄을 더하면 조각 상한을 넘는가 — 비어 있는 조각은 늘 받는다(아주 긴 한 줄도 조각 하나에 들어감)
function auditFull(doc, entry) { return doc.items.length > 0 && (doc.items.length >= PART_MAX_ITEMS || auditBytes(doc) + auditBytes(entry) + 1 > PART_MAX_BYTES); }

async function appendAudit(entry) {
  // 저장 실패가 본 작업을 막으면 안 됨 — 전부 삼킴
  try {
    const st = store(DATA);
    const key = auditKey();
    const r = await blobGet(st, key);
    // 읽기 실패·깨진 값이면 쓰지 않는다(fail-closed) — 종전에는 이번 달 기록을 못 읽으면 빈 문서로 시작해 그 달 감사 기록 전체를 한 줄로 덮어썼다(P1 판29 검토 11/13 참고 줄).
    //   이 한 줄은 못 남기고 false(기록물 액션은 audit:false로 드러남) · '없음'(실 blobs = ok·data null / 시험 = NOT_FOUND)만 새 문서로 시작.
    if (!r.ok && r.code !== 'NOT_FOUND') return false;
    if (r.ok && r.data != null && !(typeof r.data === 'object' && Array.isArray(r.data.items))) return false;
    const doc = (r.ok && r.data) ? r.data : { schema: 1, items: [] };
    // P1 판31(검토 11/14 막음 1): 마지막 조각 = 머리 parts와 '실제 있는 조각 키'(접두어 목록) 중 큰 번호 — 동시 요청이 머리를 다시 써 parts가 지워졌거나
    //   머리를 잃은 뒤에도 남아 있는 조각을 놓치지 않는다(목록 읽기 실패 = 쓰지 않음). 조각은 읽어서 '없음'일 때만 새로 만들고(읽기 실패·깨짐 = 쓰지 않음),
    //   줄이 있으면 그 조각에 이어 쓴다 — 성공으로 답한 줄이 든 조각을 빈 조각으로 덮는 길 0.
    const ls = await auditListParts(st, key);
    if (!ls) return false;
    let n = Math.max(auditParts(doc), ls.length ? ls[ls.length - 1] : 1), cur = doc;
    if (n > 1) { cur = await auditPartRead(st, key, n); if (!cur) return false; }
    while (auditFull(cur, entry)) {
      if (n >= PART_MAX) return false;   // 조각 수 상한 — 잘라 내지 않고 이 줄 false
      n += 1;
      cur = await auditPartRead(st, key, n);   // 다음 조각도 읽어서 — 다른 요청이 먼저 만들었으면 거기에 이어 씀
      if (!cur) return false;
    }
    cur.items.push(entry);
    // 조각을 넘길 때 머리는 다시 쓰지 않는다(검토 11/14) — 머리를 다시 쓰면 그사이 다른 요청이 머리에 붙인 줄을 지울 수 있다. 조각은 쓰는 쪽·읽는 쪽 모두 키 목록으로 찾는다
    //   (머리 parts는 옛 문서·재해 복원 병합과의 호환으로만 읽음). 남는 경합: 같은 조각에 두 요청이 동시에 쓰면 한 줄이 빠질 수 있음(조건부 쓰기 부품 없음 — 종전과 같음)
    const w = await blobSet(st, auditPartKey(key, n), cur);
    if (w && w.ok) return true;   // v406
    return false;   // v406: 기록물 액션이 감사 실패를 응답에 가시화(audit:false) — 삼키는 것은 그대로
  } catch (e) { return false; }
}
// 이 달 머리 뒤 조각 번호(실제 있는 키 — 오름차순) · 목록 읽기 실패 = null
async function auditListParts(st, head) {
  const l = await blobList(st, head + ':');
  if (!l || !l.ok) return null;
  const re = new RegExp('^' + head.replace(/[-:]/g, '\\$&') + ':(\\d{1,3})$'), out = [];
  (l.keys || []).forEach(function (k) { const m = re.exec(k); if (m) { const v = Number(m[1]); if (v >= 2 && v <= PART_MAX) out.push(v); } });
  return out.sort(function (a, b) { return a - b; });
}
// 조각 n 읽기 — 있으면 그 문서 · '없음'이면 새 빈 조각 · 읽기 실패·깨짐 = null(쓰지 않음)
async function auditPartRead(st, head, n) {
  const pr = await blobGet(st, auditPartKey(head, n));
  if (!pr.ok && pr.code !== 'NOT_FOUND') return null;
  if (pr.ok && pr.data != null) return auditDocOk(pr.data) ? pr.data : null;
  return { schema: 1, part: n, items: [] };
}

// P1 판31: 한 달 감사 기록 전부(조각을 차례로 이어 붙임) — 감사 화면(gw-data audit)·월 점검(_lib/mchk.js)이 읽는 한 곳.
//   month = 'YYYY-MM'(꼴이 아니면 auditKey처럼 이번 달) · { ok:true, month, items, parts, missing(머리는 있다는데 없는 조각 수) } · 머리·조각 하나라도 읽기 실패·깨짐 = { ok:false, code } (일부만 보여 주지 않음) · 달 전체 없음 = 빈 목록
async function readMonth(month) {
  const head = auditKey(month), mon = head.slice(6);
  const st = store(DATA);
  const r = await blobGet(st, head);
  if (!r.ok && r.code !== 'NOT_FOUND') return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  const hasHead = r.ok && r.data != null;
  if (hasHead && !auditDocOk(r.data)) return { ok: false, code: 'AUDIT_BAD_DOC' };
  // 검토 11/14: 머리 parts만 믿지 않고 실제 있는 조각 키(접두어 목록)까지 — 목록 못 읽음 = 실패 · 머리가 없어도 남은 조각은 읽음
  const ls = await auditListParts(st, head);
  if (!ls) return { ok: false, code: 'STORAGE_LIST_FAILED' };
  const n = Math.max(hasHead ? auditParts(r.data) : 1, ls.length ? ls[ls.length - 1] : 1);
  if (!hasHead && n === 1) return { ok: true, month: mon, items: [], parts: 0, missing: 0 };
  let items = hasHead ? r.data.items.slice() : [], missing = hasHead ? 0 : 1;   // 머리가 없는데 조각이 있으면 머리 1개 빠짐
  for (let i = 2; i <= n; i++) {
    const pr = await blobGet(st, auditPartKey(head, i));
    if (!pr.ok && pr.code !== 'NOT_FOUND') return { ok: false, code: pr.code || 'STORAGE_READ_FAILED' };
    if (!pr.ok || pr.data == null) { missing++; continue; }
    if (!auditDocOk(pr.data)) return { ok: false, code: 'AUDIT_BAD_DOC' };
    items = items.concat(pr.data.items);
  }
  return { ok: true, month: mon, items: items, parts: n, missing: missing };
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

module.exports = { appendAudit, auditKey, diffItems, short, DATA, MAX_PER_MONTH, readMonth, auditPartKey, PART_MAX_BYTES, PART_MAX_ITEMS, PART_MAX };   // v453 MAX_PER_MONTH — gw-data backup_put 감사 로그 붙이기 상한이 같은 값을 쓴다 · P1 판31 readMonth(조각 합쳐 읽기)·조각 상한
