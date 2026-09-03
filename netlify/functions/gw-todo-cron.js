'use strict';
// 내 할 일(mytasks) 기한 알림 크론 — netlify.toml schedule = "0 23 * * *" (UTC 23:00 = KST 08:00 매일).
// PM 요구(2026-09-03): "내 업무 탭 내가 할 일에 만료일 설정 + 알림". 회원별 비공개 문서 priv:<mid>:mytasks를
// 읽어 오늘(KST) 기한이고 미완료·미삭제인 항목이 있으면 그 회원에게만 웹푸시 1발(전 기기 — 개인 알림이라 우선기기 규칙 무관).
// 멱등: todo:sent:<mid>.ids[항목id]=발송일 — 같은 항목이 같은 날 두 번 가지 않고, 기한을 미루면 새 기한일에 다시 간다. 사용자 문서(priv:*)는 절대 되쓰지 않는다(클라 저장과 경합 0).
// 완료·삭제된 항목은 대상에서 빠지므로 '완료 시 미발송'이 자연히 성립한다. 경과(D+n) 재알림은 없음(화면 빨강 배지로만).
const { setupBlobContext, store, blobGet, blobSet, blobList } = require('./_lib/blobs');
const push = require('./_lib/push');

const DATA = 'gw_data';
function kstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

exports.handler = async function (event) {
  const today = kstToday();
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  const l = await blobList(st, 'priv:');
  if (!l.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: l.code || 'LIST_FAILED' }) };
  let members = 0, items = 0, fails = 0;
  for (const k of (l.keys || [])) {
    const m = /^priv:([^:]+):mytasks$/.exec(String(k));
    if (!m) continue;
    const mid = m[1];
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
      await push.sendTo([mid], { title: '오늘 기한 할 일 ' + dueNow.length + '건', body: body, url: './', tag: 'todo-due-' + today });
      dueNow.forEach(function (t) { sentDoc.ids[t.id] = today; });
      // 링 정리 — 오래된 발송 기록은 90일 지나면 버린다(문서가 무한히 자라지 않게)
      const cutoff = new Date(Date.now() + 9 * 3600000 - 90 * 86400000).toISOString().slice(0, 10);
      Object.keys(sentDoc.ids).forEach(function (id) { if (String(sentDoc.ids[id]) < cutoff) delete sentDoc.ids[id]; });
      await blobSet(st, 'todo:sent:' + mid, sentDoc);
      members++; items += dueNow.length;
    } catch (e) { fails++; }
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, today: today, members: members, items: items, fails: fails }) };
};
