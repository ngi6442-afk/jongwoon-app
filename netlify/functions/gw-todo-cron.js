'use strict';
// 내 할 일(mytasks) 기한 알림 크론 — netlify.toml schedule = "0 23 * * *" (UTC 23:00 = KST 08:00 매일).
// PM 요구(2026-09-03): "내 업무 탭 내가 할 일에 만료일 설정 + 알림". 회원별 비공개 문서 priv:<mid>:mytasks를
// 읽어 오늘(KST) 기한이고 미완료·미삭제인 항목이 있으면 그 회원에게만 웹푸시 1발(전 기기 — 개인 알림이라 우선기기 규칙 무관).
// 멱등: todo:sent:<mid>.ids[항목id]=발송일 — 같은 항목이 같은 날 두 번 가지 않고, 기한을 미루면 새 기한일에 다시 간다. 사용자 문서(priv:*)는 절대 되쓰지 않는다(클라 저장과 경합 0).
// 완료·삭제된 항목은 대상에서 빠지므로 '완료 시 미발송'이 자연히 성립한다. 경과(D+n) 재알림은 없음(화면 빨강 배지로만).
const { setupBlobContext, store, blobGet, blobSet, blobList } = require('./_lib/blobs');
const push = require('./_lib/push');
const { stamp } = require('./_lib/cronstamp');   // v398 실행 흔적 it:cron:<fn>:last

const DATA = 'gw_data';
function kstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

exports.handler = async function (event) {
  const today = kstToday();
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  await stamp('gw-todo-cron', { state: 'start' });
  const l = await blobList(st, 'priv:');
  if (!l.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: l.code || 'LIST_FAILED' }) };
  // 퇴사·삭제 회원은 건너뛴다(v329) — priv 블롭 키만 훑던 종전엔 회원 레코드를 한 번도 읽지 않아,
  // 퇴사자가 남겨둔 미래 기한 할 일이 있으면 접근이 막힌 그 사람 폰이 매일 08시에 울렸다(구독은 회수되지 않는다).
  // 최종 관문은 push.sendTo의 활성 필터지만, 여기서 먼저 끊어 todo:sent 쓰기와 루프를 아낀다. 명부를 못 읽으면 걸러내지 않고 진행한다(sendTo도 같은 규칙).
  let ctx = null;
  try { ctx = await push.tierCtx(); } catch (e) { ctx = null; }
  // 게이트는 명부를 **실제로 읽었을 때만** 건다 — ctx.unavailable(스토어 list/get 실패)이나 0명이면 거르지 않는다.
  // 종전 주석("ctx를 못 만들면 sendTo가 막는다")은 tierCtx가 throw하지 않는 이 실패 모드에서 성립하지 않았다(빈 명부 = 전원 스킵).
  const gateOn = !!(ctx && !ctx.unavailable && (ctx.members || []).length);
  const activeSet = Object.create(null);
  if (ctx) (ctx.members || []).forEach(function (m) { if (m && m.id) activeSet[m.id] = 1; });
  let members = 0, items = 0, fails = 0, skipped = 0;
  for (const k of (l.keys || [])) {
    const m = /^priv:([^:]+):mytasks$/.exec(String(k));
    if (!m) continue;
    const mid = m[1];
    if (gateOn && !activeSet[mid]) { skipped++; continue; }   // 퇴사·삭제 회원
    const r = await blobGet(st, k);
    const list = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    if (!list.length) continue;
    const sr = await blobGet(st, 'todo:sent:' + mid);
    const sentDoc = (sr.ok && sr.data && sr.data.ids && typeof sr.data.ids === 'object') ? sr.data : { schema: 1, ids: {} };
    const dueNow = list.filter(function (t) { return t && t.del !== 1 && !t.done && String(t.due || '') === today && sentDoc.ids[t.id] !== today; });   // 항목+날짜당 1회 — 기한을 미루면 새 기한일에 다시(v310)
    if (!dueNow.length) continue;
    try {
      // 본문에 제목을 싣지 않는다 — sendTo가 알림함(push:log)에 남기고 그 이력은 관리자 전원이 보므로 '나만 보기' 할 일이 새어 나간다(v310)
      const body = '내 업무 탭 > 내가 할 일에서 확인하세요.';
      await push.sendTo([mid], { title: '오늘 기한 할 일 ' + dueNow.length + '건', body: body, url: './', tag: 'todo-due-' + today }, ctx ? { ctx: ctx } : null);
      dueNow.forEach(function (t) { sentDoc.ids[t.id] = today; });
      // 링 정리 — 오래된 발송 기록은 90일 지나면 버린다(문서가 무한히 자라지 않게)
      const cutoff = new Date(Date.now() + 9 * 3600000 - 90 * 86400000).toISOString().slice(0, 10);
      Object.keys(sentDoc.ids).forEach(function (id) { if (String(sentDoc.ids[id]) < cutoff) delete sentDoc.ids[id]; });
      await blobSet(st, 'todo:sent:' + mid, sentDoc);
      members++; items += dueNow.length;
    } catch (e) { fails++; }
  }
  // v396 알림 설정 due_digest=summary: 만기 임박 개별 푸시 대신 아침 요약 1줄 — 자동 지시 열린 n·오늘 기한/경과 m·담당 없음 k → 배정표 승인권자 1인(없으면 관리자 전원)
  let digest = null;
  try {
    const nfr = await blobGet(st, 'settings:notify');
    if (nfr.ok && nfr.data && nfr.data.events && nfr.data.events.due_digest === 'summary') {
      const tr = await blobGet(st, 'col:tasks');
      const tasks = (tr.ok && tr.data && Array.isArray(tr.data.items)) ? tr.data.items : [];
      const autos = tasks.filter(function (x) { return x && x.auto_key && x.del !== 1 && x.status !== 'done'; });
      const due = autos.filter(function (x) { return x.due && String(x.due) <= today; }).length;
      const noWho = autos.filter(function (x) { return !x.who_id; }).length;
      const ar = await blobGet(st, 'settings:assign');
      const apv = (ar.ok && ar.data && ar.data.approver_id) ? String(ar.data.approver_id) : '';
      let to = apv ? [apv] : ((ctx && ctx.adminIds) || []);
      if (gateOn) to = to.filter(function (id) { return !!activeSet[id]; });
      digest = { autos: autos.length, due: due, no_who: noWho, to: to.length };
      if (autos.length && to.length) {
        await push.sendTo(to, { title: '자동 지시 요약 ' + autos.length + '건', body: '오늘 기한·경과 ' + due + '건 · 담당 없음 ' + noWho + '건 — 지시함 자동 만기 구역에서 확인', url: './', tag: 'task-digest-' + today }, ctx ? { ctx: ctx, primaryOnly: true } : { primaryOnly: true });
        digest.sent = true;
      }
    }
  } catch (e) { digest = { error: String(e && e.message || e).slice(0, 80) }; }
  // v415 C3-2 bid_result=award일 때 유찰은 아침 요약 1줄(어제·오늘 개찰 유찰 n, result.checked는 UTC 날짜라 둘 다 본다) → 입찰 담당(배정표 bid:), 없으면 관리자. 우선기기.
  let bidDigest = null;
  try {
    const nfr2 = await blobGet(st, 'settings:notify');
    if (nfr2.ok && nfr2.data && nfr2.data.events && nfr2.data.events.bid_result === 'award') {
      const br = await blobGet(st, 'col:bids'); const bids = (br.ok && br.data && Array.isArray(br.data.items)) ? br.data.items : [];
      const yday = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
      const lost = bids.filter(function (b) { return b && b.del !== 1 && b.status === '유찰' && b.result && (String(b.result.checked) === today || String(b.result.checked) === yday); });
      bidDigest = { lost: lost.length, sent: false };
      if (lost.length) {
        const ar2 = await blobGet(st, 'settings:assign'); const w = (ar2.ok && ar2.data && ar2.data.rules && ar2.data.rules['bid:'] && ar2.data.rules['bid:'].who_id) ? String(ar2.data.rules['bid:'].who_id) : '';
        let to = w ? [w] : ((ctx && ctx.adminIds) || []); if (gateOn) to = to.filter(function (id) { return !!activeSet[id]; });
        if (to.length) { await push.sendTo(to, { title: '개찰 유찰 ' + lost.length + '건(어제·오늘)', body: lost.slice(0, 3).map(function (b) { return String(b.title || '').slice(0, 28); }).join(' · ') + (lost.length > 3 ? ' 외 ' + (lost.length - 3) + '건' : '') + ' — 입찰 탭', url: './', tag: 'bids-lost-' + today }, { ctx: ctx, primaryOnly: true }); bidDigest.sent = true; }
      }
    }
  } catch (e) { bidDigest = { error: String(e && e.message || e).slice(0, 80) }; }
  // v414 C3-1 무기계약직 레이더 이식 — gw-duty-cron(netlify.toml 미등록이라 안 돌던 크론)의 contractPlan을 08:00 여기서 돌린다. 멱등 키는 duty:sent 공유(toml 불변·duty 함수는 그대로).
  //   수신 = PM(tier pm, 없으면 관리자) 우선기기 1발. 단계 d90·d30 각 1회, over 매일 1회, unknown(생년월일 없음) 1회. 근거 기간제법 §4①(2년 초과 → 무기계약 간주)·§4①5호(55세 이상 체결 예외) — 판정은 노무사.
  let radar = null;
  try {
    const DC = require('./gw-duty-cron');
    const sr2 = await blobGet(st, 'duty:sent'); const sentDoc2 = (sr2.ok && sr2.data && sr2.data.keys && typeof sr2.data.keys === 'object') ? sr2.data : { schema: 1, keys: {} };
    const ct = DC.contractPlan(ctx ? ctx.members : [], sentDoc2, today);
    radar = { items: ct.length, sent: 0 };
    if (ct.length) {
      let pmIds = (ctx && Array.isArray(ctx.pmIds) && ctx.pmIds.length) ? ctx.pmIds : ((ctx && ctx.adminIds) || []);
      if (gateOn) pmIds = pmIds.filter(function (id) { return !!activeSet[id]; });
      if (pmIds.length) { const cm = DC.contractBody(ct); await push.sendTo(pmIds, { title: cm.title, body: cm.body, url: './', tag: 'ct-' + today }, { ctx: ctx, primaryOnly: true }); radar.sent = pmIds.length; }
      ct.forEach(function (x) { sentDoc2.keys[x.key] = today; });
      await blobSet(st, 'duty:sent', sentDoc2);
    }
  } catch (e) { radar = { error: String(e && e.message || e).slice(0, 80) }; fails++; }
  await stamp('gw-todo-cron', { state: 'end', ok: fails === 0, note: 'members ' + members + ' · items ' + items + ' · fails ' + fails + (digest && digest.sent ? ' · digest' : '') + (radar && radar.sent ? ' · radar ' + radar.items : '') });
  return { statusCode: 200, body: JSON.stringify({ ok: true, today: today, members: members, items: items, fails: fails, skipped: skipped, digest: digest, radar: radar, bid_digest: bidDigest }) };
};
