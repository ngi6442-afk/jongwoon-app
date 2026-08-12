'use strict';

// 올바로 일일운반일지 자동 수집 크론 — netlify.toml schedule = "0 23 * * *"
// (UTC 23:00 = KST 익일 08:00, 매일. 주말도 돈다 — 주말 인계서도 뒤늦게 올라온다).
// 여기서는 KST 기준 대상일 산출·백그라운드 기동만 한다(실제 수집은 15분 한도 워커가).
// 수집 창 = 오늘(KST) 포함 최근 7일. 올바로는 처리자 인수 등록이 며칠 늦게 올라와
// 과거 날짜 집계가 뒤늦게 바뀐다 → 창을 두고 매일 덮어쓴다.
// 자격증명은 이 파일에서 읽지 않는다 — 워커가 환경변수(GW_ALLBARO_ID/PW)에서 직접 읽는다.
const { issueSession } = require('./_lib/session');

const WINDOW_DAYS = 7;

// KST 일자 문자열(YYYY-MM-DD). offsetDays만큼 이동.
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }

exports.handler = async function () {
  const days = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push(kstDate(-i));   // 오래된 날짜부터, 마지막이 오늘(KST)
  const job = 'ab_cron_' + kstDate(0);   // 같은 날 재실행 시 같은 작업 키에 덮어씀(중복 blob 방지)

  // 내부 토큰(mid='__allbaro__') — 워커는 이 토큰만 받는다.
  const s = issueSession({ id: '__allbaro__', role: 'system' });
  if (!s.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: s.code || 'SERVER_CONFIG_MISSING' }) };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_SITE_URL' }) };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-allbaro-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: 'collect', days: days }),
    });
    if (!resp.ok && resp.status !== 202) return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_HTTP_' + resp.status, job: job }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, job: job, days: days }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_FAILED', job: job }) };
  }
};
