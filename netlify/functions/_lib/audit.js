'use strict';

// 감사 로그(audit trail) — 서버측에서만 기록(클라이언트 직접 쓰기 불가 → 위변조 방지).
// 월별 블롭 audit:YYYY-MM (gw_data 스토어). 항목: {ts,by,bid,col,ev:[{op,id,t,f?}]}
// ev.f = {필드: [이전값, 새값]} (값은 문자열화·80자 절단, PIN 등 비밀값은 기록 안 함)
const crypto = require('crypto');
const { store, blobGet, blobSet, blobList } = require('./blobs');

const DATA = 'gw_data';
// 원장 C251(11/20 「원천」) 감사 줄 유실(동시 저장) — 종전 appendAudit는 그달 조각 문서를 읽고 → 한 줄 붙이고 → 통째로 다시 썼다(조건부 쓰기 없음).
//   두 저장이 0.1초쯤 안에 겹치면 둘 다 true를 돌려주는데 한 줄이 사라졌다(운영 11/19 4번 실측 — 지시 완료 승인·결재·기성 줄의 감사).
//   지금: 줄마다 고유 열쇠 'audit:YYYY-MM:e:<쓴 시각 13자리>-<이 프로세스 순번 4자리>-<무작위 12자리>'에 새로 쓴다(값 = { schema: 1, items: [줄] } — 다른 audit:* 문서와 같은 꼴이라
//   백업 내보내기·재해 복원 병합(gw-data backupLogMerge)이 그대로 다룬다). 덮어쓸 문서가 없어 경합 자체가 없다 — 쓰기는 저장소 왕복 1번(종전 읽기 1~2 + 목록 1 + 쓰기 1).
//   · 옛 조각 문서(머리 audit:YYYY-MM · 조각 audit:YYYY-MM:n)는 옮기지 않고 그대로 읽는다 — 새 줄만 줄 열쇠. appendAudit는 조각 문서를 더는 쓰지 않는다
//     (아래 조각 상한 PART_MAX_BYTES·PART_MAX_ITEMS·PART_MAX는 옛 조각 읽기와 재해 복원 병합, 뒤에 넣을 '접기'가 쓰는 값으로 남는다 — 줄 열쇠에는 달 상한이 없다).
//   · 읽는 쪽(readMonth 한 곳 — 감사 화면·월 점검)은 접두어 목록 1번으로 조각 번호와 줄 열쇠를 함께 얻어, 조각 줄(있던 순서 그대로) 뒤에 줄 열쇠 줄(열쇠 이름순 = 쓴 시각순)을
//     시각(ts)으로 끼워 넣는다 — 줄 열쇠가 없는 달은 결과가 종전과 글자째 같다. 줄 열쇠는 LINE_READ_POOL개씩 나란히 읽는다(하나라도 못 읽으면 달 전체 실패 — 일부만 보이지 않음).
//   · 운영 판으로 되돌려도 옛 코드는 깨지지 않는다: 옛 조각 목록 정규식은 숫자 조각(':<1~3자리>')만 집어 줄 열쇠를 지나친다 — 다만 옛 코드는 줄 열쇠의 줄을 보지 못한다(되돌린 동안 새 줄은 다시 조각에 쌓임).
//   · 줄 열쇠 수 = 줄 수(운영 11월 하루 평균 122줄·최대 390줄). 지난 줄 열쇠를 접는 정리는 이 판에 없다 — 읽는 비용이 열쇠 수에 비례하고(아래 LINE_READ_POOL 실측),
//     줄 열쇠 하나 읽기마다 저장소 API 요청 1번(서명 주소 — SDK가 이 요청은 재시도하지 않음)이라 API 분당 한도에 걸리면 달 읽기가 실패한다(한도 값 운영 미확인).
//     접기 설계·수치·'넣지 않으면 언제까지 안전한가' = 09_조사_문서/감사줄유실_자료_20261120/01_설계_전수표.md §6·§7.
const MAX_PER_MONTH = 8000;   // 한 키(조각) 줄 상한 — 백업 복원 병합(gw-data backupLogMerge)이 이 값을 넘기면 400 AUDIT_FULL. P1 판31부터 appendAudit는 잘라 내지 않고 아래 조각 상한에서 새 조각으로 넘긴다 · C251부터 appendAudit는 조각을 쓰지 않는다(줄 열쇠)
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
// C251 줄 열쇠 — 'audit:YYYY-MM:e:<쓴 시각 ms 13자리>-<이 프로세스 순번 4자리>-<무작위 12자리(hex)>'. 이름순 = 쓴 시각순(같은 ms·같은 프로세스는 순번순).
//   blobkey.js가 거르는 글자('/' '\' '%' '?' '#'·제어문자) 없음 · 옛 조각 정규식(':<숫자 1~3자리>'로 끝남)에 걸리지 않음.
const LINE_TAG = ':e:';
const LINE_READ_POOL = 32;   // 줄 열쇠를 나란히 읽는 수 — 실측(실 SDK 8.2.0 + 가짜 API 서버 · HTTP 요청 1번 30ms 지연 = 열쇠 하나 읽기 72ms): 122열쇠 0.5초 · 400열쇠 1.3초 · 1,000열쇠 2.7초 · 2,500열쇠 6.2초 · 3,700열쇠 9.3초(열쇠 수에 비례 — 근거 = 조사 폴더 measure_30.txt · 운영 지연은 재지 못함)
let lineSeq = 0;
function auditLineKey(head, nowMs) {
  lineSeq = (lineSeq + 1) % 10000;
  return head + LINE_TAG + String(Math.floor(Number(nowMs) || 0)).padStart(13, '0') + '-' + String(lineSeq).padStart(4, '0') + '-' + crypto.randomBytes(6).toString('hex');
}

async function appendAudit(entry) {
  // 저장 실패가 본 작업을 막으면 안 됨 — 전부 삼킴
  try {
    // C251: 줄마다 새 열쇠에 쓴다 — 읽고 붙이고 통째로 쓰는 문서가 없어 동시 저장이 서로를 덮지 못한다(달 = auditKey() 그대로 — 서버 달).
    //   그달 머리·조각을 읽지 않으므로 머리가 깨졌거나 못 읽히는 때에도 이 줄은 남는다(종전: 못 읽으면 쓰지 않고 false). 읽는 쪽(readMonth)은 종전처럼 하나라도 못 읽으면 실패.
    const w = await blobSet(store(DATA), auditLineKey(auditKey(), Date.now()), { schema: 1, items: [entry] });
    if (w && w.ok) return true;   // v406
    return false;   // v406: 기록물 액션이 감사 실패를 응답에 가시화(audit:false) — 삼키는 것은 그대로
  } catch (e) { return false; }
}
// 이 달 머리 뒤 열쇠(접두어 목록 1번) — parts = 조각 번호(실제 있는 키 — 오름차순) · lines = 줄 열쇠(이름순, 겹친 이름은 한 번) · 목록 읽기 실패 = null
async function auditListMonth(st, head) {
  const l = await blobList(st, head + ':');
  if (!l || !l.ok) return null;
  const esc = head.replace(/[-:]/g, '\\$&');
  const reP = new RegExp('^' + esc + ':(\\d{1,3})$'), reL = new RegExp('^' + esc + LINE_TAG + '\\d{13}-\\d{4}-[0-9a-f]{12}$');
  const parts = [], seen = {}, lines = [];
  (l.keys || []).forEach(function (k) {
    const m = reP.exec(k);
    if (m) { const v = Number(m[1]); if (v >= 2 && v <= PART_MAX) parts.push(v); return; }
    if (reL.test(k) && !seen[k]) { seen[k] = 1; lines.push(k); }
  });
  return { parts: parts.sort(function (a, b) { return a - b; }), lines: lines.sort() };
}
// 줄 열쇠 값 전부(이름순 그대로) — LINE_READ_POOL개씩 나란히. { ok:true, docs:[문서 또는 null(없음)] } · 하나라도 읽기 실패·깨짐 = { ok:false, code }
async function auditLineDocs(st, keys) {
  const docs = new Array(keys.length);
  let next = 0, bad = '';
  const work = async function () {
    while (!bad && next < keys.length) {
      const i = next++;
      const r = await blobGet(st, keys[i]);
      if (!r.ok && r.code !== 'NOT_FOUND') { bad = bad || r.code || 'STORAGE_READ_FAILED'; return; }
      if (!r.ok || r.data == null) { docs[i] = null; continue; }
      if (!auditDocOk(r.data)) { bad = bad || 'AUDIT_BAD_DOC'; return; }
      docs[i] = r.data;
    }
  };
  const pool = [];
  for (let p = 0; p < Math.min(LINE_READ_POOL, keys.length); p++) pool.push(work());
  await Promise.all(pool);
  return bad ? { ok: false, code: bad } : { ok: true, docs: docs };
}
// 조각 줄(a — 있던 순서 그대로) 사이에 줄 열쇠 줄(b — 열쇠 이름순)을 시각(ts)으로 끼워 넣는다. 두 줄기 안의 순서는 바꾸지 않는다(같은 시각이면 조각 줄이 앞).
//   배포 뒤에는 조각이 더 늘지 않으므로 보통은 '조각 줄 전부 → 줄 열쇠 줄'이다. 섞이는 때 = 운영 판으로 되돌린 동안 조각에 쌓인 줄 · 재해 복원으로 조각에 되살린 줄.
function auditMerge(a, b) {
  if (!b.length) return a;
  const tsOf = function (e, dflt) { const t = e && typeof e === 'object' ? Number(e.ts) : NaN; return Number.isFinite(t) ? t : dflt; };
  const out = [];
  let i = 0;
  for (const x of b) {
    const tb = tsOf(x.e, x.t);
    while (i < a.length && tsOf(a[i], -Infinity) <= tb) out.push(a[i++]);
    out.push(x.e);
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}

// P1 판31: 한 달 감사 기록 전부(조각을 차례로 이어 붙임) — 감사 화면(gw-data audit)·월 점검(_lib/mchk.js)이 읽는 한 곳.
//   month = 'YYYY-MM'(꼴이 아니면 auditKey처럼 이번 달) · { ok:true, month, items, parts, missing(머리는 있다는데 없는 조각 수 + 목록에는 있는데 값이 없는 줄 열쇠 수), lines(줄 열쇠 수) } ·
//   머리·조각·줄 열쇠 하나라도 읽기 실패·깨짐 = { ok:false, code } (일부만 보여 주지 않음) · 달 전체 없음 = 빈 목록
//   C251: 조각 줄(종전 그대로) + 줄 열쇠 줄 — 줄 열쇠가 없는 달은 items·parts·missing이 종전과 같다.
async function readMonth(month) {
  const head = auditKey(month), mon = head.slice(6);
  const st = store(DATA);
  const r = await blobGet(st, head);
  if (!r.ok && r.code !== 'NOT_FOUND') return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
  const hasHead = r.ok && r.data != null;
  if (hasHead && !auditDocOk(r.data)) return { ok: false, code: 'AUDIT_BAD_DOC' };
  // 검토 11/14: 머리 parts만 믿지 않고 실제 있는 조각 키(접두어 목록)까지 — 목록 못 읽음 = 실패 · 머리가 없어도 남은 조각은 읽음
  const ls = await auditListMonth(st, head);
  if (!ls) return { ok: false, code: 'STORAGE_LIST_FAILED' };
  const n = Math.max(hasHead ? auditParts(r.data) : 1, ls.parts.length ? ls.parts[ls.parts.length - 1] : 1);
  if (!hasHead && n === 1 && !ls.lines.length) return { ok: true, month: mon, items: [], parts: 0, missing: 0, lines: 0 };
  const chunks = hasHead || n > 1;   // 조각 문서가 있는 달인가(줄 열쇠만 있는 달 = 머리가 없어도 빠진 것이 아님)
  let items = hasHead ? r.data.items.slice() : [], missing = (chunks && !hasHead) ? 1 : 0;   // 머리가 없는데 조각이 있으면 머리 1개 빠짐
  for (let i = 2; i <= n; i++) {
    const pr = await blobGet(st, auditPartKey(head, i));
    if (!pr.ok && pr.code !== 'NOT_FOUND') return { ok: false, code: pr.code || 'STORAGE_READ_FAILED' };
    if (!pr.ok || pr.data == null) { missing++; continue; }
    if (!auditDocOk(pr.data)) return { ok: false, code: 'AUDIT_BAD_DOC' };
    items = items.concat(pr.data.items);
  }
  if (ls.lines.length) {
    const ld = await auditLineDocs(st, ls.lines);
    if (!ld.ok) return { ok: false, code: ld.code };
    const add = [], cut = head.length + LINE_TAG.length;
    ld.docs.forEach(function (doc, i) {
      if (!doc) { missing++; return; }   // 목록에는 있는데 값이 없음 — 빠진 것으로 센다(월 점검 '확인 못 함' · 감사 화면 안내)
      const t = Number(ls.lines[i].slice(cut, cut + 13));
      doc.items.forEach(function (e) { add.push({ e: e, t: t }); });
    });
    items = auditMerge(items, add);
  }
  return { ok: true, month: mon, items: items, parts: chunks ? n : 0, missing: missing, lines: ls.lines.length };
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

module.exports = { appendAudit, auditKey, diffItems, short, DATA, MAX_PER_MONTH, readMonth, auditPartKey, PART_MAX_BYTES, PART_MAX_ITEMS, PART_MAX, auditLineKey, LINE_READ_POOL };   // v453 MAX_PER_MONTH — gw-data backup_put 감사 로그 붙이기 상한이 같은 값을 쓴다 · P1 판31 readMonth(조각 합쳐 읽기)·조각 상한 · C251 줄 열쇠
