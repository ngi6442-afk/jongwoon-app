'use strict';
// 전결 총정리 크론(결재 3차, 명세 20260903 §5) — netlify.toml schedule = "0 23 * * *" (UTC 23:00 = KST 익일 08:00 매일 기동,
// 함수 내부에서 KST 1일에만 실제 실행 — cron 표현식으론 "매월 1일 KST 08:00"을 한 줄로 못 쓴다).
// 하는 일: 전월 ①PM 전결 승인 건 + 휴가 모듈 승인 건(읽기 합산 — 이중 결재 없음)을 카드 1장(kind '전결총정리',
// grade 3, to:'boss')으로 대표에게 상신. 대표 버튼은 [확인] 하나(= decide '확인' → status '승인', "열람 확인" 성격).
// 안전장치는 운반일지 자동 기안(gw-allbaro-run-background autoDraftApproval)과 동일 패턴:
//   멱등(id 'summary-YYYY-MM' + cid 'auto-sum-YYYY-MM') · approvals 읽기 실패 시 스킵(fail-closed) ·
//   쓰기 직전 신선본 재검사 · 본선 쓰기 후 1회 자가복구 · 감사로그 · 0건이면 미생성 · 미확인 재푸시 없음(§12-7).
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { appendAudit } = require('./_lib/audit');
const push = require('./_lib/push');

const DATA = 'gw_data';
const APPR_KEY = 'col:approvals';

function kstIso(ms) { return new Date(ms + 9 * 3600000).toISOString(); }           // KST 벽시계의 ISO 표현(UTC 표기 재사용)
function kstMonthOf(iso) {                                                          // ISO(UTC) → KST 기준 YYYY-MM. 경계(§10-6): 8/31 23:50 KST 승인 → 8월
  const t = Date.parse(String(iso || ''));
  if (isNaN(t)) return '';
  return kstIso(t).slice(0, 7);
}
function prevMonth(ym) {                                                            // 'YYYY-MM' 한 달 전
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}
function itemGrade(x) { return (x.grade === 1 || x.grade === 2 || x.grade === 3) ? x.grade : 0; }

// nowMs 주입 = 테스트 가능(servertest) + KST 재계산 일원화. 반환: {ok, skipped?, id?, n?}
async function runSummary(st, nowMs) {
  const nowK = kstIso(nowMs);                              // 예: '2026-09-01T08:00:00.000Z' = KST 9/1 08:00
  // 1~5일 복구 창 — 1일 단 1회 기동이 실패하면(블롭 일시 오류·스케줄 미발화, 재시도 없음) 그 달 카드가
  // 영영 안 생기는 구멍(리뷰 med, 9/3 방지 원칙). 멱등(sumId·cid) 덕에 창을 넓혀도 중복 생성은 없다
  const dayN = Number(nowK.slice(8, 10));
  if (dayN < 1 || dayN > 5) return { ok: true, skipped: 'not-first-days' };
  const period = prevMonth(nowK.slice(0, 7));              // 전월(KST)
  const sumId = 'summary-' + period;
  const cid = 'auto-sum-' + period;

  const ar = await blobGet(st, APPR_KEY);
  if (!ar.ok) return { ok: false, code: 'APPR_READ_FAILED' };                       // fail-closed
  const doc = (ar.data && Array.isArray(ar.data.items)) ? ar.data : { schema: 1, items: [] };
  if (doc.items.some(function (x) { return x && (x.id === sumId || x.cid === cid); })) return { ok: true, skipped: 'exists' };

  // 대상: ① 등급 + 전월(KST) 승인 종결 건. ①의 반려·보류는 목록에 안 넣고 숫자로만(§5)
  const apr = [], counts = {};
  let rejected = 0, sumDays = 0, held = 0;
  doc.items.forEach(function (x) {
    if (!x || itemGrade(x) !== 1) return;
    if (x.status === '승인' && kstMonthOf(x.decided_at) === period) {
      apr.push(x);
      counts[x.kind || '일반'] = (counts[x.kind || '일반'] || 0) + 1;
      const c0 = Date.parse(String(x.created || '')), c1 = Date.parse(String(x.decided_at || ''));
      if (!isNaN(c0) && !isNaN(c1) && c1 >= c0) sumDays += (c1 - c0) / 86400000;
      if (Array.isArray(x.chain) && x.chain.some(function (e) { return e && e.decision === '보류'; })) held++;
    } else if (x.status === '반려' && kstMonthOf(x.decided_at) === period) rejected++;
  });

  // 휴가는 모듈 승인 유지(approvals 미생성) — 승인 로그를 읽기만 해서 건수·일수 합산(§5, 이중 결재 없음).
  // 사직·휴직은 ② 결재라인 영역이라 제외. 읽기 실패는 휴가 0으로 진행(총정리 본체를 막지 않는다).
  let lvN = 0, lvDays = 0;
  try {
    const lr = await blobGet(st, 'col:leaves');
    const lvs = (lr.ok && lr.data && Array.isArray(lr.data.items)) ? lr.data.items : [];
    lvs.forEach(function (l) {
      if (!l || l.del === 1 || l.status !== 'approved' || l.type === 'resign' || l.type === 'loa') return;
      if (String(l.start || '').slice(0, 7) !== period) return;
      lvN++; lvDays += Number(l.days) || 0;
    });
  } catch (e) {}

  const total = apr.length + lvN;
  if (!total) return { ok: true, skipped: 'empty' };                                // 0건이면 카드 안 만듦(§5)

  const mLabel = Number(period.slice(5, 7)) + '월';
  const parts = Object.keys(counts).map(function (k) { return k + ' ' + counts[k]; });
  if (lvN) parts.push('휴가 ' + lvN + '건 ' + (Math.round(lvDays * 100) / 100) + '일');
  const lines = [parts.join(' · ')];
  lines.push('반려 ' + rejected + ' · 보류 경유 ' + held + ' · 평균 처리 ' + (apr.length ? (Math.round((sumDays / apr.length) * 10) / 10) : 0) + '일');
  // 전월 총정리 미확인 링크 1줄(§12-7 — 재푸시는 없음, 다음 달 카드 상단에서만 알린다)
  const prevSum = doc.items.find(function (x) { return x && x.id === 'summary-' + prevMonth(period); });
  if (prevSum && (prevSum.status === '대기' || prevSum.status === '보류')) lines.push('⚠ 전월(' + prevMonth(period) + ') 총정리 미확인 — 결재함에 남아 있습니다');
  apr.slice(0, 20).forEach(function (x) {
    lines.push('· [' + (x.kind || '일반') + '] ' + String(x.title || '').slice(0, 40)
      + ' — 기안 ' + ((x.by && x.by.name) || '?') + ' · 승인 ' + kstIso(Date.parse(x.decided_at)).slice(5, 10).replace('-', '/'));
  });
  if (apr.length > 20) lines.push('… 외 ' + (apr.length - 20) + '건');

  const item = { id: sumId, cid: cid, kind: '전결총정리', grade: 3, to: 'boss',
    title: mLabel + ' 전결 총정리 — ' + total + '건',
    body: lines.join('\n').slice(0, 1500), ref: 'sum:' + period,
    by: { id: '__system__', name: '자동' }, created: new Date(nowMs).toISOString(), status: '대기', chain: [],
    summary: { period: period, ids: apr.map(function (x) { return x.id; }).slice(0, 100), counts: counts,
      rejected: rejected, held: held, avg_days: apr.length ? Math.round((sumDays / apr.length) * 10) / 10 : 0,
      leave: { n: lvN, days: Math.round(lvDays * 100) / 100 } } };

  // 쓰기 직전 신선본 재읽기 + 멱등 재검사(레이스 창 축소 — approval_create·운반일지 자동 기안과 동일)
  const ar2 = await blobGet(st, APPR_KEY);
  if (!ar2.ok) return { ok: false, code: 'APPR_READ_FAILED' };
  const fresh = (ar2.data && Array.isArray(ar2.data.items)) ? ar2.data : { schema: 1, items: [] };
  if (fresh.items.some(function (x) { return x && (x.id === sumId || x.cid === cid); })) return { ok: true, skipped: 'exists' };
  fresh.items.push(item);
  fresh.updated_by = '__system__'; fresh.updated_at = Date.now();
  const w = await blobSet(st, APPR_KEY, fresh);
  if (!w.ok) return { ok: false, code: w.code };
  // 무조건 덮어쓰기 저장소 — 동시 쓰기에 밀렸으면 1회 자가복구
  try {
    const chk = await blobGet(st, APPR_KEY);
    if (chk.ok && chk.data && Array.isArray(chk.data.items) && !chk.data.items.some(function (x) { return x && x.id === item.id; })) {
      chk.data.items.push(item);
      chk.data.updated_by = '__system__'; chk.data.updated_at = Date.now();
      await blobSet(st, APPR_KEY, chk.data);
    }
  } catch (e) {}
  try { await appendAudit({ ts: Date.now(), by: '자동', bid: '__system__', col: 'approvals', ev: [{ op: '상신', id: item.id, t: ('전결총정리 · ' + item.title).slice(0, 80) }] }); } catch (e) {}
  // 대표 우선기기 1발(§5 — 오피스PC 팝업 병행 없음: 운반일지 예외가 아니다). 대표 부재 시 관리자 폴백.
  try {
    const ids = await push.bossOrAdminIds();
    await push.sendTo(ids, { title: '결재 요청: ' + item.title, body: parts.join(' · ').slice(0, 200), url: './', tag: 'appr-' + item.id }, { primaryOnly: true });
  } catch (e) {}
  return { ok: true, id: item.id, n: total };
}

exports.runSummary = runSummary;   // servertest에서 nowMs 주입 호출용

exports.handler = async function (event) {
  let st;
  try { setupBlobContext(event); st = store(DATA); } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_BLOB_CONTEXT' }) }; }
  const r = await runSummary(st, Date.now());
  return { statusCode: r.ok ? 200 : 500, body: JSON.stringify(r) };
};
