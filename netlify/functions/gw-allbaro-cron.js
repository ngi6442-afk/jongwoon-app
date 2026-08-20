'use strict';

// 올바로 일일운반일지 자동 수집 크론 — netlify.toml schedule = "0 23 * * *"
// (UTC 23:00 = KST 익일 08:00, 매일. 주말도 돈다 — 주말 인계서도 뒤늦게 올라온다).
// 여기서는 KST 기준 대상일 산출·백그라운드 기동만 한다(실제 수집은 15분 한도 워커가).
// 수집 창 = 오늘(KST) 포함 최근 7일. 올바로는 처리자 인수 등록이 며칠 늦게 올라와
// 과거 날짜 집계가 뒤늦게 바뀐다 → 창을 두고 매일 덮어쓴다.
// 자격증명은 이 파일에서 읽지 않는다 — 워커가 환경변수(GW_ALLBARO_ID/PW)에서 직접 읽는다.
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { issueSession } = require('./_lib/session');

const DATA = 'gw_data';
const WINDOW_DAYS = 9;  // 8/20 조업일 규칙 개정의 경계(8/13 이전) 복구 겸 여유 — 안정되면 7로 복귀 가능
const LOCK_KEY = 'allbaro:lock';        // 동시 실행 잠금(gw-allbaro.handleRunNow·워커와 공용 키·형식)
const LOCK_TTL_MS = 10 * 60 * 1000;     // 10분 뒤 자동 만료(워커가 죽어도 영구 잠금 없음) — handleRunNow와 동일
function jobKey(id) { return `allbaro:job:${id}`; }

// KST 일자 문자열(YYYY-MM-DD). offsetDays만큼 이동.
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }

exports.handler = async function (event, context) {
  const days = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push(kstDate(-i));   // 오래된 날짜부터, 마지막이 오늘(KST)
  const job = 'ab_cron_' + kstDate(0);   // 같은 날 재실행 시 같은 작업 키에 덮어씀(중복 blob 방지)

  // 내부 토큰(mid='__allbaro__') — 워커는 이 토큰만 받는다.
  const s = issueSession({ id: '__allbaro__', role: 'system' });
  if (!s.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: s.code || 'SERVER_CONFIG_MISSING' }) };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_SITE_URL' }) };

  // 동시 실행 잠금(계약 B-minor) — 수동수집([지금 수집]) 또는 앞선 크론이 아직 돌고 있으면,
  // 같은 올바로 계정에 워커 둘이 붙어 뒤 세션이 앞 세션을 무효화한다(허위 '실패' + 불필요한 외부 부하).
  // 잠겨 있으면 그날은 건너뛰고 이유를 남긴다. 취득에 성공하면 잠금은 워커가 자기 job일 때만 해제한다.
  // blob 컨텍스트를 못 잡으면(스케줄 실행 환경 차이) 잠금 없이라도 수집은 진행한다 — 수집 자체를 거르지 않는다.
  let st = null, lockHeld = false;
  try {
    setupBlobContext(event);
    st = store(DATA);
    const lk = await blobGet(st, LOCK_KEY);
    if (lk.ok && lk.data && lk.data.ts && (Date.now() - lk.data.ts) < LOCK_TTL_MS) {
      const lockJob = String(lk.data.job || '');
      // 건너뛴 이유를 job 레코드로 남긴다(ab_status/ab_job에서 확인 가능).
      try { await blobSet(st, jobKey(job), { ts: Date.now(), status: 'skipped', mode: 'collect', by: 'cron', code: 'ALREADY_RUNNING', lock_job: lockJob, days_req: days }); } catch (e) {}
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'already_running', job: job, lock_job: lockJob }) };
    }
    const w = await blobSet(st, LOCK_KEY, { ts: Date.now(), job: job });
    if (w.ok) lockHeld = true;
  } catch (e) {
    st = null; lockHeld = false;   // 잠금 확인/설정 불가 — 수집은 그대로 진행(잠금 없이)
  }

  try {
    const resp = await fetch(base + '/.netlify/functions/gw-allbaro-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: 'collect', days: days }),
    });
    if (!resp.ok && resp.status !== 202) {
      // 기동 실패 — 우리가 방금 잡은 잠금을 즉시 해제(워커가 안 뜨면 아무도 안 푼다).
      if (st && lockHeld) { try { await blobSet(st, LOCK_KEY, { ts: 0, job: '' }); } catch (e) {} }
      return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_HTTP_' + resp.status, job: job }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, job: job, days: days }) };
  } catch (e) {
    if (st && lockHeld) { try { await blobSet(st, LOCK_KEY, { ts: 0, job: '' }); } catch (e2) {} }
    return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_FAILED', job: job }) };
  }
};
