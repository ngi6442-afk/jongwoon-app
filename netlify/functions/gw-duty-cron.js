'use strict';
// 인허가 의무 대장 기한 알림 크론(v354, 인허가 2차 — PM 2026-09-11 ㄱ "담당자는 관리자로 동결, 나머지는 추천대로").
//   netlify.toml schedule = "5 23 * * *" (UTC 23:05 = KST 08:05 매일). col:licenses의 duties(98행)에서 자동 회차(sched.auto)인 행의 다음 기한을
//   앱과 같은 본문(_lib/duty.js dutyNext)으로 계산해 단계별 알림을 관리자 전원에게 1발 묶어 보낸다.
//   단계: d30(30일 이내 1회) · d7(7일 이내 1회) · over(지남 — 완료 처리될 때까지 매일 1회). 멱등: duty:sent {'<no>:<due>:<단계>': 날짜}.
//   회원 문서(priv:*)는 쓰지 않는다 — 내 할 일 등재 대신 관리자 푸시 + 앱 [인허가 > 이번 달] 탭이 같은 계산으로 목록을 보여준다(gw-todo-cron과 같은 원칙).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const push = require('./_lib/push');
const D = require('./_lib/duty');

const DATA = 'gw_data';
const SENT_KEY = 'duty:sent';
const KEEP_DAYS = 400;   // 발송 기록 보관(연 1회 회차의 다음 알림까지 기억)
function kstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

// 알림 대상 계산 — 순수 함수(servertest가 직접 부른다). duties·licenses·sentDoc·today → { items:[{no,duty,due,days,stage,key}], stale:[keys] }
function plan(duties, licenses, sentDoc, today) {
  const licBy = Object.create(null);
  (licenses || []).forEach(function (l) { if (l && l.id && l.del !== 1) licBy[l.id] = l; });
  const sent = (sentDoc && sentDoc.keys && typeof sentDoc.keys === 'object') ? sentDoc.keys : {};
  const items = [];
  (duties || []).forEach(function (d) {
    if (!d || d.no == null || !d.sched || !d.sched.auto) return;
    const lic = d.sched.lic_id ? (licBy[d.sched.lic_id] || null) : null;
    const nx = D.dutyNext(d, lic, today);
    if (!nx || !nx.due) return;
    const stage = D.dutyStage(nx);
    if (!stage) return;
    const key = d.no + ':' + nx.due + ':' + stage;
    // d30·d7은 회차당 1회, over는 하루 1회
    if (stage === 'over' ? sent[key] === today : !!sent[key]) return;
    items.push({ no: d.no, duty: String(d.duty || ''), due: nx.due, days: nx.days, stage: stage, key: key });
  });
  items.sort(function (a, b) { return a.days - b.days; });
  return items;
}

function bodyOf(items) {
  const over = items.filter(function (x) { return x.stage === 'over'; });
  const d7 = items.filter(function (x) { return x.stage === 'd7'; });
  const d30 = items.filter(function (x) { return x.stage === 'd30'; });
  const line = function (x) { return (x.stage === 'over' ? ('지남 ' + (-x.days) + '일') : ('D-' + x.days)) + ' ' + x.no + '. ' + x.duty.slice(0, 28); };
  const parts = [];
  if (over.length) parts.push('지남 ' + over.length + '건');
  if (d7.length) parts.push('7일 내 ' + d7.length + '건');
  if (d30.length) parts.push('30일 내 ' + d30.length + '건');
  const head = parts.join(' · ');
  const top = items.slice(0, 3).map(line).join(' / ');
  return { title: '인허가 기한 — ' + head, body: (top + (items.length > 3 ? ' 외 ' + (items.length - 3) + '건' : '') + ' · 인허가 > 이번 달').slice(0, 200) };
}

// ---- v368 무기계약직 레이더(PM 9/21) — 계약직 2년 시계(기간제법 4조). 앱 ctRadar와 같은 규칙. 단계: d90(1회)·d30(1회)·over(매일 1회)·unknown(생년월일 없음, 90일 이내 1회).
//   55세 이상(계약 체결 시)은 제4조①5호 예외라 알리지 않는다. 수신자 = PM(tier pm), 없으면 관리자. 멱등 키 'ct:<id>:<전환일>:<단계>'는 duty:sent에 같이 둔다.
function ctAddYears(d, y) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); if (!m) return ''; const yy = Number(m[1]) + y; let dd = m[3]; if (m[2] === '02' && dd === '29') { const leap = (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0; if (!leap) dd = '28'; } return yy + '-' + m[2] + '-' + dd; }
function ctAgeAt(birth, at) { const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birth || '')), a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(at || '')); if (!b || !a) return null; let age = Number(a[1]) - Number(b[1]); if (Number(a[2]) < Number(b[2]) || (Number(a[2]) === Number(b[2]) && Number(a[3]) < Number(b[3]))) age--; return age; }
function ctDays(from, to) { const f = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)), t = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)); return Math.round((t - f) / 86400000); }
function contractPlan(members, sentDoc, today) {
  const sent = (sentDoc && sentDoc.keys && typeof sentDoc.keys === 'object') ? sentDoc.keys : {};
  const items = [];
  (members || []).forEach(function (m) {
    if (!m || m.emp_type !== '계약직' || m.del === 1) return;
    if (m.leave_date && String(m.leave_date) < today) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.hire_date || ''))) return;
    const conv = ctAddYears(m.hire_date, 2), days = ctDays(today, conv), age = ctAgeAt(m.birth, m.hire_date);
    if (age !== null && age >= 55) return;   // 예외
    let stage = null;
    if (age === null) { if (days <= 90) stage = 'unknown'; }
    else if (days < 0) stage = 'over';
    else if (days <= 30) stage = 'd30';
    else if (days <= 90) stage = 'd90';
    if (!stage) return;
    const key = 'ct:' + m.id + ':' + conv + ':' + stage;
    if (stage === 'over' ? sent[key] === today : !!sent[key]) return;
    items.push({ id: m.id, name: String(m.name || ''), conv: conv, days: days, stage: stage, key: key });
  });
  items.sort(function (a, b) { return a.days - b.days; });
  return items;
}
function contractBody(items) {
  const line = function (x) { return x.stage === 'over' ? (x.name + ' 2년 초과 ' + (-x.days) + '일(' + x.conv + ')') : x.stage === 'unknown' ? (x.name + ' 생년월일 없음 — 판정 불가') : (x.name + ' D-' + x.days + '(' + x.conv + ')'); };
  return { title: '무기계약 전환 시계 — ' + items.length + '명', body: (items.slice(0, 3).map(line).join(' / ') + (items.length > 3 ? ' 외 ' + (items.length - 3) + '명' : '') + ' · 인사·직원 탭 칩 · 기간제법 4조 — 노무사 확인').slice(0, 200) };
}

exports.handler = async function (event) {
  const today = kstToday();
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  const lr = await blobGet(st, 'col:licenses');
  if (!lr.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: lr.code || 'READ_FAILED' }) };
  const duties = (lr.data && Array.isArray(lr.data.duties)) ? lr.data.duties : [];
  const licenses = (lr.data && Array.isArray(lr.data.items)) ? lr.data.items : [];
  const sr = await blobGet(st, SENT_KEY);
  const sentDoc = (sr.ok && sr.data && sr.data.keys && typeof sr.data.keys === 'object') ? sr.data : { schema: 1, keys: {} };
  const items = plan(duties, licenses, sentDoc, today);
  let ctx = null;
  try { ctx = await push.tierCtx(); } catch (e) { ctx = null; }
  const ctItems = contractPlan(ctx ? ctx.members : [], sentDoc, today);   // v368
  if (!items.length && !ctItems.length) return { statusCode: 200, body: JSON.stringify({ ok: true, today: today, items: 0, ct: 0 }) };
  const ids = (ctx && Array.isArray(ctx.adminIds)) ? ctx.adminIds : [];
  let sent = 0, fails = 0;
  if (items.length && ids.length) {
    try {
      const msg = bodyOf(items);
      await push.sendTo(ids, { title: msg.title, body: msg.body, url: './', tag: 'duty-' + today }, ctx ? { ctx: ctx } : null);
      sent = ids.length;
    } catch (e) { fails++; }
  }
  // v368 무기계약직 레이더 — PM(없으면 관리자)에게 1발
  let ctSent = 0;
  if (ctItems.length) {
    const pmIds = (ctx && Array.isArray(ctx.pmIds) && ctx.pmIds.length) ? ctx.pmIds : ids;
    if (pmIds.length) {
      try { const cm = contractBody(ctItems); await push.sendTo(pmIds, { title: cm.title, body: cm.body, url: './', tag: 'ct-' + today }, ctx ? { ctx: ctx } : null); ctSent = pmIds.length; } catch (e) { fails++; }
    }
  }
  // 발송 기록(관리자가 없어도 기록은 남긴다 — 다음 날 중복 판정용) + 오래된 키 정리
  items.forEach(function (x) { sentDoc.keys[x.key] = today; });
  ctItems.forEach(function (x) { sentDoc.keys[x.key] = today; });
  const cutoff = new Date(Date.now() + 9 * 3600000 - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  Object.keys(sentDoc.keys).forEach(function (k) { if (String(sentDoc.keys[k]) < cutoff) delete sentDoc.keys[k]; });
  await blobSet(st, SENT_KEY, sentDoc);
  return { statusCode: 200, body: JSON.stringify({ ok: true, today: today, items: items.length, admins: ids.length, sent: sent, ct: ctItems.length, ct_sent: ctSent, fails: fails }) };
};
exports.plan = plan;
exports.bodyOf = bodyOf;
exports.contractPlan = contractPlan;   // v368
exports.contractBody = contractBody;
