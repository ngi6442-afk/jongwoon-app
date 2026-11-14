'use strict';
// P1 판22 기기·계정 자동 처리(착수설명서 판22 58행 · 업무별 설계 전산 S2·S3 857~858행 · 837행 기한 · PM 11/14 13:26 "45. 판22 ㄱ" · 원장 C142·T476).
//   ① 새 기기 승인 대기 알림 — gw-auth registerDevice가 기기 레코드를 처음 만들 때(직원 기기 = 대기) 개발자에게 푸시 1발(설계 S3 'pending 즉시 개발자 푸시 1발').
//      같은 기기로 다시 알리지 않는다: 레코드가 이미 있으면(다시 로그인·verify·해제 뒤 대기) 알리지 않음 — 레코드를 처음 만든 그 요청에서만.
//      검토 11/14 ①③: 회원당 24시간에 1발(devauto:pend:<회원> = 마지막으로 보낸 시각 — 못 읽거나 못 쓰면 보내지 않음) · 발송 시간 상한 CFG.sendCapMs(3초 — 넘으면 로그인은 그대로 진행).
//        못 보낸 기기(묶임·상한 넘음·표식 못 읽음)는 기기 레코드 pend_note(= 알림 빚, 만든 시각)로 남고 다음 날 아침 크론(runDaily)이 한 통에 "n대"로 1발(기기당 한 번 — 보내기 전에 pend_note를 지움).
//        알림 글에 기기 라벨을 싣지 않는다(사용자가 정하는 머리값) — "○○ 님 새 기기 승인 대기"까지.
//   ② 7일 체류 — 하루 1회(gw-mchk-cron 07:00 KST에 붙임, 새 크론 없음) 승인 대기가 7일 넘은 기기를 개발자에게 다시 알림.
//      기기당 대기 한 번에 한 번(대기 시작 시각 t0를 표식으로 — 매일 반복 없음, 다시 승인 → 해제로 대기가 새로 시작되면 그 대기에 한 번 더).
//      대기 시작·제외 규칙은 _lib/mchk.js 대기 기기 판정과 같다(t0 = updated 없으면 created · 퇴사·삭제·없는 회원의 대기 기기는 뺌 · 7일 '넘음' = 7×24시간 초과).
//   ③ 퇴사 다음 날 회수 — 퇴사일(leave_date, YYYY-MM-DD) 다음 날(KST)부터 그 회원의 승인 기기를 대기로 돌리고(레코드는 지우지 않음 — auto_rev 표시) 알림 구독(push:subs의 그 회원 칸)을 지운다.
//      삭제 표시 회원(del=1 — 로그인이 바로 막히는 기존 동작)도 같은 원칙으로 다음 회차에 회수. 감사 1줄씩(by '자동' · bid 'bot' · col login).
//      한 번만: 회원·퇴사일(삭제는 'del')마다 표식(devauto:state.rev[회원 id].tag). 회수 뒤 사람이 다시 승인한 기기는 다음 날 또 회수하지 않는다.
//      검토 11/14 ⑥: 기기 단위 진행 — 못 돌린 기기(left)·못 지운 구독(subs_left)만 다음 회차에 다시(다 돌린 기기는 다시 보지 않음).
//      검토 11/14 ⑦: 구독은 쓰기 직전에 다시 읽어 그 회원 칸만 지움(다시 읽기 실패 = 쓰지 않고 다음 회차).
//      퇴사일을 고치면(다른 날짜) 표식이 달라져 새 퇴사일 다음 날 한 번 더 · 퇴사일을 지우거나 미래로 바꾸면(재입사·오타) 표식을 지운다 · 형식 오류 퇴사일 = 아무것도 안 함(표식도 그대로).
//   닫힌 쪽 실패: 회원 명부·기기·구독·표식 중 하나라도 못 읽으면 아무것도 쓰지 않고 끝(다음 회차에 다시 — 크론 흔적 ok:false → appdata watch 경보).
//   받는 사람(①②) = 재직 개발자(규정 12조 — 승인·해제 = 개발자), 0명이면 관리자 전원(설계 843행 '알림 수신자 0명만 adminIds 폴백') · 우선기기 1발.
//   알림 설정(settings:notify)은 읽지도 쓰지도 않는다(관리자 병행 7일 판정 보호 — 받는 사람은 이 파일 코드 값).
//   회수를 사람이·봇 키로 부르는 길은 없다(HTTP 액션 없음 — 크론 함수 안에서만).
const { store, blobGet, blobSet, blobList } = require('./blobs');
const push = require('./push');
const tier = require('./tier');
const audit = require('./audit');

const USERS = 'gw_users', DATA = 'gw_data';
const STATE_KEY = 'devauto:state';
const PEND_PREFIX = 'devauto:pend:';   // 회원별 새 기기 알림 24시간 묶음 표식 {last}
const PENDING_DAYS = 7;
const DAY_MS = 86400000;
const BY = '자동';
// 시간 상한(검토 11/14 ①②) — 발송 1회 3초 · 크론의 기기 처리 전체 15초(넘으면 월 점검은 그대로 돈다). servertest가 줄여 쓴다
const CFG = { sendCapMs: 3000, runCapMs: 15000 };

function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function kstDay(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}
// 약속에 시간 상한 — {done:true, v} 또는 {done:false}(상한 넘음 — 원래 약속은 버려 둠) · 예외는 그대로 던짐
function withCap(p, ms) {
  let t;
  const cap = new Promise(function (r) { t = setTimeout(function () { r({ done: false }); }, ms); });
  return Promise.race([Promise.resolve(p).then(function (v) { return { done: true, v: v }; }), cap]).then(function (x) { clearTimeout(t); return x; }, function (e) { clearTimeout(t); throw e; });
}
// 회원 상태 → 회수 표식. 'del' = 삭제 표시 · 'leave:YYYY-MM-DD' = 퇴사일 다음 날부터(tier.retired와 같은 비교 — 당일까지는 재직) · null = 회수 대상 아님
//   형식 오류 퇴사일은 'bad'(회수 안 함·표식도 안 건드림) — 검토 11/14 ⑨부터 회원 저장이 형식 오류를 400으로 막는다(옛 값·복원 값만 남을 수 있음)
function goneTag(m, today) {
  if (!isObj(m)) return null;
  if (m.del === 1) return 'del';
  const ld = m.leave_date;
  if (ld == null || ld === '') return null;
  if (!validDate(ld)) return 'bad';
  return ld < today ? 'leave:' + ld : null;
}
// 받는 사람 — 재직 개발자, 없으면 관리자 전원(ctx = tier.ctxOf — 재직만)
function recipients(ctx) {
  const devs = ((ctx && ctx.members) || []).filter(function (m) { return m && m.dev; }).map(function (m) { return m.id; });
  return devs.length ? devs : (((ctx && ctx.adminIds) || []).slice());
}
// 읽기 — 실 Blobs는 없는 키 = ok·null, servertest 가짜 저장소는 NOT_FOUND
async function readOr(st, key, dflt) {
  const r = await blobGet(st, key);
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, data: dflt } : { ok: false };
  return { ok: true, data: r.data == null ? dflt : r.data };
}
function subsShapeOk(doc) { return isObj(doc) && (doc.members == null || isObj(doc.members)); }

// ① 새 기기 대기 알림 — gw-auth registerDevice가 레코드를 처음 만들고 저장에 성공한 뒤 부른다. 실패는 삼킨다(로그인·기기 판정 무변).
//   반환 sent:true = 이번에 알림을 마침(받는 사람 0명 포함 — 레코드 pend_note를 지움) · false = 못 보냄(pend_note 그대로 → 다음 날 아침 1발)
async function notifyNewPending(member, nowMs) {
  const now = nowMs || Date.now();
  try {
    const mid = String((member && member.id) || '');
    if (!mid) return { sent: false, why: 'no_member' };
    const su = store(USERS), key = PEND_PREFIX + mid;
    const r = await readOr(su, key, null);
    if (!r.ok) return { sent: false, why: 'read' };
    if (isObj(r.data) && num(r.data.last) > 0 && now - num(r.data.last) < DAY_MS) return { sent: false, why: 'bundled' };
    const w = await blobSet(su, key, { last: now });
    if (!w || !w.ok) return { sent: false, why: 'write' };
    const nm = String((member && member.name) || '').slice(0, 20);
    const job = (async function () {
      const ctx = await push.tierCtx();
      const to = recipients(ctx);
      if (!to.length) return 0;
      await push.sendTo(to, { title: '새 기기 승인 대기', body: nm + ' 님 새 기기 승인 대기', url: './', tag: 'dev-pend-' + mid }, { ctx: ctx, primaryOnly: true, by: BY, timeoutMs: CFG.sendCapMs });
      return to.length;
    })();
    const c = await withCap(job, CFG.sendCapMs);
    if (!c.done) return { sent: false, why: 'timeout' };
    return { sent: true, to: c.v };
  } catch (e) { return { sent: false, why: 'error' }; }
}

// ---- 하루 1회 처리 ----
// 판정(순수 — servertest가 재료를 넣어 돌린다). members = 회원 원본 전부(삭제 포함) · devices = 기기 값 배열 · subs = push:subs.members · state = devauto:state
function plan(nowMs, members, devices, subs, state) {
  const today = kstDay(nowMs);
  const byId = {}; members.forEach(function (m) { if (isObj(m) && m.id) byId[m.id] = m; });
  const revPrev = isObj(state.rev) ? state.rev : {}, stalePrev = isObj(state.stale) ? state.stale : {};
  const rev = [], clear = [];
  Object.keys(byId).forEach(function (id) {
    const m = byId[id], tag = goneTag(m, today);
    if (tag === 'bad') return;   // 형식 오류 = 아무것도 안 함
    if (!tag) { if (revPrev[id]) clear.push(id); return; }   // 재직(퇴사일 없음·당일·미래) — 지난 표식만 지움
    const prev = isObj(revPrev[id]) && revPrev[id].tag === tag ? revPrev[id] : null;
    let devs, hasSubs;
    if (prev) {   // 이 퇴사일은 이미 회수함(한 번만) — 못 돌린 기기·못 지운 구독만 다시
      const left = Array.isArray(prev.left) ? prev.left : [];
      if (!left.length && !prev.subs_left) return;
      devs = devices.filter(function (d) { return left.indexOf(d.id) >= 0 && d.member_id === id && d.status === 'approved'; });
      hasSubs = !!prev.subs_left && hasOwn(subs, id);
    } else {
      devs = devices.filter(function (d) { return d.member_id === id && d.status === 'approved'; });
      hasSubs = hasOwn(subs, id);
    }
    rev.push({ id: id, name: String(m.name || ''), tag: tag, why: tag === 'del' ? 'deleted' : 'retired', ld: tag === 'del' ? '' : tag.slice(6), devices: devs.map(function (d) { return d.id; }), hasSubs: hasSubs, prev: prev });
  });
  // 회원 레코드가 없어진 표식은 정리(명부를 다 읽었을 때만 여기 온다)
  Object.keys(revPrev).forEach(function (id) { if (!byId[id]) clear.push(id); });
  const gone = function (id) { const x = byId[id]; return !x || x.del === 1 || (!!x.leave_date && String(x.leave_date) < today); };   // tier.retired와 같은 식을 기준 시각(nowMs)의 KST 날짜로
  // 못 보낸 새 기기 알림(pend_note) — 아직 대기·재직 회원 기기만
  const owed = [];
  devices.forEach(function (d) {
    if (d.status === 'approved' || !d.id || !d.pend_note) return;
    if (d.member_id && gone(d.member_id)) return;
    owed.push({ id: d.id, name: String(d.member_name || '') });
  });
  const owedIds = owed.map(function (x) { return x.id; });
  // 7일 체류 — mchk.js 대기 기기 판정과 같은 규칙
  const stale = {}, fresh = [];
  devices.forEach(function (d) {
    if (d.status === 'approved' || !d.id) return;
    if (d.member_id && gone(d.member_id)) return;
    const t0 = num(d.updated) || num(d.created);
    if (!(t0 > 0 && nowMs - t0 > PENDING_DAYS * DAY_MS)) return;
    stale[d.id] = t0;
    if (stalePrev[d.id] !== t0 && owedIds.indexOf(d.id) < 0) fresh.push({ id: d.id, name: String(d.member_name || ''), t0: t0 });
  });
  return { today: today, rev: rev, clear: clear, stale: stale, fresh: fresh, owed: owed };
}

async function gather() {
  const su = store(USERS), sd = store(DATA);
  const ms = await push.loadMembers();
  if (!Array.isArray(ms) || ms.unavailable) return { ok: false, code: 'MEMBERS_UNAVAILABLE' };
  const l = await blobList(su, 'device:');
  if (!l || !l.ok) return { ok: false, code: 'DEVICES_UNAVAILABLE' };
  const devices = [];
  for (const k of l.keys) {
    if (String(k).indexOf('device:') !== 0) continue;
    const r = await readOr(su, k, null);
    if (!r.ok) return { ok: false, code: 'DEVICES_UNAVAILABLE' };
    if (isObj(r.data)) devices.push(Object.assign({}, r.data, { id: r.data.id || String(k).slice(7), __key: k }));
  }
  const sr = await readOr(sd, 'push:subs', { schema: 1, members: {} });
  if (!sr.ok || !subsShapeOk(sr.data)) return { ok: false, code: 'SUBS_UNAVAILABLE' };
  const subs = sr.data.members || {};
  const stR = await readOr(su, STATE_KEY, { schema: 1, rev: {}, stale: {} });
  if (!stR.ok || !isObj(stR.data)) return { ok: false, code: 'STATE_UNAVAILABLE' };
  return { ok: true, members: ms.filter(isObj), devices: devices, subs: subs, state: stR.data };
}
function nameList(xs) {
  const nm = xs.map(function (x) { return x.name.slice(0, 10); }).filter(Boolean);
  return (nm.slice(0, 3).join(' · ') || '기기') + (nm.length > 3 ? ' 외 ' + (nm.length - 3) + '명' : '');
}
async function capSend(out, to, payload, ctx) {
  try {
    const c = await withCap(push.sendTo(to, payload, { ctx: ctx, primaryOnly: true, by: BY, timeoutMs: CFG.sendCapMs }), CFG.sendCapMs);
    if (!c.done) { out.failed++; out.timeouts++; return false; }
    out.notified += to.length; return true;
  } catch (e) { out.failed++; return false; }
}

async function runDaily(nowMs) {
  const g = await gather();
  if (!g.ok) return { ok: false, code: g.code, wrote: 0 };
  const p = plan(nowMs, g.members, g.devices, g.subs, g.state);
  const su = store(USERS), sd = store(DATA);
  const out = { ok: true, today: p.today, revoked_devices: 0, revoked_subs: 0, members: 0, cleared: p.clear.length, stale: Object.keys(p.stale).length, stale_new: p.fresh.length, owed: 0, notified: 0, failed: 0, timeouts: 0 };
  const devById = {}; g.devices.forEach(function (d) { devById[d.id] = d; });
  const lines = [];
  // 기기 → 대기(레코드 그대로 · auto_rev 표시) — 기기 단위로 성공·실패를 남김
  for (const r of p.rev) {
    r.okIds = []; r.leftIds = [];
    for (const id of r.devices) {
      const d = devById[id]; const key = d.__key;
      const rec = Object.assign({}, d); delete rec.__key;
      rec.status = 'pending'; rec.updated = nowMs; rec.auto_rev = { at: nowMs, why: r.why, ld: r.ld };
      const w = await blobSet(su, key, rec);
      if (!w || !w.ok) { r.leftIds.push(id); out.failed++; continue; }
      r.okIds.push(id); out.revoked_devices++;
      lines.push({ op: '기기승인취소', id: String(id).slice(0, 20), t: (r.why === 'deleted' ? '삭제 회수(자동) — ' : '퇴사 회수(자동) — ') + r.name.slice(0, 20) });
    }
  }
  // 구독 — 쓰기 직전에 다시 읽어 그 회원 칸만 지움(다른 회원 칸·다른 최상위 칸 그대로) · 다시 읽기·쓰기 실패 = subs_left
  const subTargets = p.rev.filter(function (r) { return r.hasSubs; });
  let subsOk = true;
  if (subTargets.length) {
    const fr = await readOr(sd, 'push:subs', { schema: 1, members: {} });
    if (!fr.ok || !subsShapeOk(fr.data)) { subsOk = false; out.failed++; }
    else {
      const doc = fr.data; if (!doc.members) doc.members = {};
      const hit = subTargets.filter(function (r) { return hasOwn(doc.members, r.id); });
      hit.forEach(function (r) { r.subsN = Array.isArray(doc.members[r.id]) ? doc.members[r.id].length : 1; delete doc.members[r.id]; });
      if (hit.length) {
        const w = await blobSet(sd, 'push:subs', doc);
        subsOk = !!(w && w.ok);
        if (!subsOk) out.failed++;
      }
      if (subsOk) hit.forEach(function (r) { out.revoked_subs += r.subsN; lines.push({ op: '구독회수', id: r.id, t: r.name.slice(0, 20) + ' 알림 구독 ' + r.subsN + '대(' + (r.why === 'deleted' ? '삭제' : '퇴사') + ' 회수 · 자동)' }); });
    }
  }
  // 감사 1줄씩(쓴 것만)
  for (const ev of lines) { try { await audit.appendAudit({ ts: nowMs, by: BY, bid: 'bot', col: 'login', ev: [ev] }); } catch (e) {} }
  // 표식 — 회원마다 진행(left = 못 돌린 기기 · subs_left = 못 지운 구독) · 재직으로 돌아온 회원 표식 지움 · 7일 표식 = 지금 7일 넘은 대기 기기만
  const revPrev = isObj(g.state.rev) ? g.state.rev : {};
  const nextRev = {}; Object.keys(revPrev).forEach(function (id) { if (p.clear.indexOf(id) < 0) nextRev[id] = revPrev[id]; });
  p.rev.forEach(function (r) {
    const pv = r.prev || {};
    const mk = { tag: r.tag, at: r.prev ? num(pv.at) || nowMs : nowMs, devices: num(pv.devices) + r.okIds.length, subs: num(pv.subs) + (r.hasSubs && subsOk ? (r.subsN || 0) : 0) };
    if (r.leftIds.length) mk.left = r.leftIds;
    if (r.hasSubs && !subsOk) mk.subs_left = true;
    nextRev[r.id] = mk;
    if (!mk.left && !mk.subs_left) out.members++;
  });
  const next = { schema: 1, rev: nextRev, stale: p.stale, updated: nowMs };
  const same = JSON.stringify({ r: revPrev, s: isObj(g.state.stale) ? g.state.stale : {} }) === JSON.stringify({ r: nextRev, s: p.stale });
  let stateOk = true;
  if (!same) { const w = await blobSet(su, STATE_KEY, next); stateOk = !!(w && w.ok); if (!stateOk) out.failed++; }
  const ctx = tier.ctxOf(g.members);
  const to = recipients(ctx);
  // 못 보낸 새 기기 알림 — 보내기 전에 기기마다 pend_note를 지움(기기당 한 번 · 못 지운 기기는 이번에 빼고 다음 회차) → 한 통에 n대
  if (p.owed.length) {
    const sentable = [];
    for (const o of p.owed) {
      const d = devById[o.id]; const rec = Object.assign({}, d); delete rec.__key; delete rec.pend_note;
      const w = await blobSet(su, d.__key, rec);
      if (w && w.ok) sentable.push(o); else out.failed++;
    }
    out.owed = sentable.length;
    if (sentable.length && to.length) await capSend(out, to, { title: '새 기기 승인 대기 ' + sentable.length + '대', body: nameList(sentable) + ' — 인사·직원 탭 직원 카드 › 등록 기기에서 승인', url: './', tag: 'dev-pend-day-' + p.today }, ctx);
  }
  // 7일 넘은 대기 — 표식을 남긴 뒤에만 1발(표식을 못 쓰면 보내지 않음 — 매일 반복 방지)
  if (p.fresh.length && stateOk && to.length) {
    await capSend(out, to, { title: '승인 대기 ' + PENDING_DAYS + '일 넘은 기기 ' + p.fresh.length + '대', body: nameList(p.fresh) + ' — 인사·직원 탭 직원 카드 › 등록 기기에서 승인·삭제', url: './', tag: 'dev-stale-' + p.today }, ctx);
  }
  if (out.failed) out.ok = false;
  return out;
}

module.exports = { STATE_KEY, PEND_PREFIX, PENDING_DAYS, CFG, goneTag, validDate, withCap, recipients, plan, notifyNewPending, runDaily };
