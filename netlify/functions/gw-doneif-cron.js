'use strict';
// 공통 done_if 워커(공통 기반 2, v397) — netlify.toml schedule "*/10 * * * *". 도메인별 10분 크론 신설 금지(이 함수 하나가 공용).
// settings:doneif.on=false(기본) → 계획만 it:doneif:last에 기록(dry-run, 데이터 불변). on=true → review 전환 + 전환 전 일일 스냅샷 1회 +
// clog:appr 해시 체인 + 감사 '앱기준전환' + 승인권자 1발(배정표 approver_id, 없으면 관리자 전원). 되돌리기 = 지시 카드 [완료요청 취소]/[반려](반려는 신호 끔).
const { setupBlobContext, store, blobGet, blobSet, blobList } = require('./_lib/blobs');
const push = require('./_lib/push');
const audit = require('./_lib/audit');
const D = require('./_lib/doneif');
const { stamp } = require('./_lib/cronstamp');   // v398 실행 흔적 it:cron:<fn>:last

const DATA = 'gw_data';
const USERS = 'gw_users';   // C185 판2 입사 계정 신호(device:* — 읽기만)
const FILES = 'gw_files';   // P1 판19 증빙 보관함 색인(proof:__index__) — 읽기만
function kstToday(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }

async function run(st, nowMs) {
  const today = kstToday(nowMs);
  const sr = await blobGet(st, D.DONEIF_KEY);
  const on = !!(sr.ok && sr.data && sr.data.on === true);
  const tr = await blobGet(st, 'col:tasks');
  const tdoc = (tr.ok && tr.data && Array.isArray(tr.data.items)) ? tr.data : null;
  if (!tdoc) return { ok: false, code: 'NO_TASKS' };
  // 필요한 레코드 컬렉션만 읽는다(자격 있는 자동 지시의 접두어 기준)
  const need = {};
  tdoc.items.forEach(function (t) { if (!D.eligible(t)) return; const k = D.parseKey(t.auto_key); if (k) need[k.col] = true; });
  const recs = { __rows: {}, __now: nowMs };
  if (need.workers) need.asbestos = true;   // v417 카드 10: wk 월 지시 신호는 명부+대장(참여 범위) 둘 다 본다
  for (const col of Object.keys(need)) {
    if (col === '__none') continue;   // C185 판2 입·퇴사 체크 항목(hr:) — 사람 [완료]만, 읽을 것 없음
    if (col === 'devices') {   // C185 판2 입사 계정(acct:) 신호 — gw_users device:* 를 하나씩 읽어야 해서 열린 계정 지시가 있을 때 매 시 첫 회차(분 0~9)에만 · 못 읽음·그 밖 회차 = null(신호 없음)
      let devs = null;
      if (new Date(nowMs).getUTCMinutes() < 10) {
        try {
          const us = store(USERS), l = await blobList(us, 'device:');
          if (l && l.ok) { devs = []; for (const k of l.keys) { if (String(k).indexOf('device:') !== 0) continue; const r = await blobGet(us, k); if (!r.ok) { devs = null; break; } if (r.data && typeof r.data === 'object') devs.push({ member_id: r.data.member_id, status: r.data.status }); } }   // 판2 검토 1: 못 읽음만 신호 끔 · 지운 기기(ok·null)·객체 아닌 값은 건너뜀
        } catch (e) { devs = null; }
      }
      recs.__rows.devices = devs;
      // C185 판3 계정 회수 신호: 열린 퇴사 계정 지시(acct:<회원>:leave:<퇴사일>)가 있으면 자동 회수 기록(gw_users devauto:state) 하나를 읽음 — 매 회차(한 번 읽기) · 못 읽음·깨진 꼴 = null(신호 없음)
      if (tdoc.items.some(function (t) { if (!D.eligible(t)) return false; const pk = D.parseKey(t.auto_key); return !!pk && pk.dom === 'acct' && pk.kind === 'leave'; })) {
        let ds = null;
        try { const r = await blobGet(store(USERS), 'devauto:state'); ds = (r && r.ok && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data : null; } catch (e) { ds = null; }
        recs.__rows.devstate = ds;
      }
      continue;
    }
    if (col === 'proof') {   // P1 판19 증명서 신호: 열린 증명서 지시가 있을 때만 증빙 보관함 색인 하나를 읽는다(파일 본문 안 읽음). 읽기 실패·없음·깨진 꼴 = null(신호 없음)
      let pr = null;
      try { pr = await blobGet(store(FILES), 'proof:__index__'); } catch (e) { pr = null; }
      recs.__rows.proof = (pr && pr.ok && pr.data && Array.isArray(pr.data.names)) ? pr.data : null;
      continue;
    }
    const r = await blobGet(st, 'col:' + col);
    const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    if (col === 'asbestos' || col === 'workers') recs.__rows[col] = items;   // v417: 집계형 신호(site·wk)는 원본 배열
    else recs[col] = D.byId(items);
    if (col === 'licenses') recs.__rows.lic_duties = (r.ok && r.data && Array.isArray(r.data.duties)) ? r.data.duties : null;   // P1 판20 인허가 기한 지시 신호(의무 대장 행 — 못 읽음 = null = 신호 없음)
  }
  const p = D.plan(tdoc.items, recs);
  const last = { ts: nowMs, today: today, on: on, scanned: p.scanned, candidates: p.candidates.slice(0, 50), moved: 0, notified: 0 };
  let clogFail = '';   // C225 판 A
  if (on && p.candidates.length) {
    try {   // 전환 전 문서 일일 스냅샷 1회(ver 링과 별도 키, 되돌리기 재료)
      const sk = 'ver:tasks:appbase:' + today;
      const ex = await blobGet(st, sk);
      if (!(ex.ok && ex.data)) await blobSet(st, sk, { ts: nowMs, by: '앱 기준', doc: tdoc });   // v403: 실 Blobs는 없는 키를 ok:true·data:null로 준다(ok만 보면 '있음'으로 오판 → 10/31 첫 전환 때 스냅샷 미기록)
    } catch (e) {}
    last.moved = D.apply(tdoc.items, p.candidates, today);
    tdoc.updated_by = '앱 기준'; tdoc.updated_at = nowMs;
    const w = await blobSet(st, 'col:tasks', tdoc);
    if (!w.ok) return { ok: false, code: w.code || 'SAVE_FAILED' };
    try {
      const ck = 'clog:appr:' + today.slice(0, 7);
      const cr = await blobGet(st, ck);
      // C225 판 A: 그달 변경 기록을 못 읽으면 새 체인으로 덮지 않고 이 회차를 실패로 돌려준다(크론 스탬프 ok:false · 지시 전환·알림은 그대로)
      if (!cr.ok && cr.code !== 'NOT_FOUND') clogFail = cr.code || 'STORAGE_READ_FAILED';
      else {
        let cd = (cr.ok && cr.data) ? cr.data : null;
        p.candidates.forEach(function (c) { cd = D.clogAppend(cd, { ts: nowMs, id: c.id, f: 'status', from: 'open', to: 'review', why: 'data:' + c.why, by: '앱 기준' }); });
        await blobSet(st, ck, cd);
      }
    } catch (e) {}
    try { await audit.appendAudit({ ts: nowMs, by: '앱 기준', bid: 'bot', col: 'tasks', ev: [{ op: '앱기준전환', id: '', t: '승인 대기 ' + last.moved + '건' }] }); } catch (e) {}
    try {   // 승인권자 1발 — 자동 지시의 승인 축은 배정표 approver_id(없으면 관리자 전원), 우선기기
      const ar = await blobGet(st, 'settings:assign');
      const apv = (ar.ok && ar.data && ar.data.approver_id) ? String(ar.data.approver_id) : '';
      const tc = await push.tierCtx();
      const to = apv ? [apv] : ((tc && tc.adminIds) || []);
      // C185 판2 검토 9: 승인권자가 관리자가 아니면 입·퇴사 지시(hr:·acct: — 담당·관리자만 보는 지시)는 그 사람 알림에서 뺌(입사 날짜가 든 제목이 지시를 볼 수 없는 사람에게 가지 않게)
      const hrId = {}; tdoc.items.forEach(function (t) { if (t && /^(?:hr|acct):/.test(String(t.auto_key || ''))) hrId[t.id] = 1; });
      // C185 판3: 명부를 못 읽은 회차(tierCtx unavailable)는 명부 일부로 '관리자 아님'이라 보지 않고 승인권자 회원 레코드로 판정(못 읽음 = 아님 → 입·퇴사는 관리자 쪽)
      let apvAdm = !!apv && (((tc && tc.adminIds) || []).indexOf(apv) >= 0);
      if (apv && tc && tc.unavailable) { try { const mr = await blobGet(store(USERS), 'member:' + apv); apvAdm = !!(mr.ok && mr.data && mr.data.admin === true && mr.data.del !== 1 && !(mr.data.leave_date && String(mr.data.leave_date) < today)); } catch (e) { apvAdm = false; } }
      const cands = (apv && !apvAdm) ? p.candidates.filter(function (x) { return !hrId[x.id]; }) : p.candidates;
      if (to.length && cands.length) {
        const body = cands.slice(0, 3).map(function (c) { return c.title.slice(0, 28); }).join(' · ') + (cands.length > 3 ? ' 외 ' + (cands.length - 3) + '건' : '') + ' — 지시함 [오늘 승인 일괄]';
        await push.sendTo(to, { title: '승인 대기 ' + (cands === p.candidates ? last.moved : cands.length) + '건(앱 기준)', body: body.slice(0, 200), url: './', tag: 'task-appbase-' + today }, { ctx: tc, primaryOnly: true, by: '앱 기준' });
        last.notified = to.length;
      }
      // C185 판2 재확인 2: 승인권자 알림에서 뺀 입·퇴사 후보는 관리자 전원에게 따로 1발(후보가 전부 입·퇴사여도 승인 대기 알림이 누군가에게 감)
      const hrC = cands === p.candidates ? [] : p.candidates.filter(function (x) { return hrId[x.id]; });
      const adm = (tc && tc.adminIds) || [];
      if (hrC.length && adm.length) {
        const bodyH = hrC.slice(0, 3).map(function (c) { return c.title.slice(0, 28); }).join(' · ') + (hrC.length > 3 ? ' 외 ' + (hrC.length - 3) + '건' : '') + ' — 지시함 [오늘 승인 일괄]';
        await push.sendTo(adm, { title: '승인 대기 ' + hrC.length + '건(앱 기준 · 입·퇴사)', body: bodyH.slice(0, 200), url: './', tag: 'task-appbase-hr-' + today }, { ctx: tc, primaryOnly: true, by: '앱 기준' });
        last.notified += adm.length;
      }
      if (hrC.length && !adm.length) last.notify_fail = 'MEMBERS_UNAVAILABLE';   // C185 판3: 관리자에게 보낼 입·퇴사 승인 대기가 있는데 받을 관리자 0명 = 조용히 0발 대신 기록(it:doneif:last)
    } catch (e) {}
  }
  try { await blobSet(st, D.DONEIF_LAST, last); } catch (e) {}
  if (clogFail) return Object.assign({ ok: false, code: 'CLOG_' + clogFail }, last);   // C225 판 A: 변경 기록 한 줄을 못 남긴 회차 = 실패(지금까지는 조용히 지나감)
  return Object.assign({ ok: true }, last);
}

exports.run = run;
exports.handler = async function (event) {
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  await stamp('gw-doneif-cron', { state: 'start' });
  const r = await run(st, Date.now());
  await stamp('gw-doneif-cron', { state: 'end', ok: !!r.ok, note: 'on ' + !!r.on + ' · scanned ' + (r.scanned || 0) + ' · cand ' + ((r.candidates || []).length) + ' · moved ' + (r.moved || 0) + (r.code ? ' · ' + String(r.code).slice(0, 40) : '') });   // C225 두 번째 검토: 실패 회차는 원인 코드를 흔적 끝에
  return { statusCode: r.ok ? 200 : 500, body: JSON.stringify(r) };
};
