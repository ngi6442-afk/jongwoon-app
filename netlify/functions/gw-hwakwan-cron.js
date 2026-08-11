'use strict';

// 화관법 제품 노선 자동 제출 크론 — netlify.toml schedule = "30 22 * * 0-4"
// (UTC 22:30 = KST 익일 07:30, UTC 일~목 = KST 월~금).
// 여기서는 KST 요일 재계산·대상일 산출·백그라운드 기동만 한다(실제 제출은 15분 한도 워커가).
// 요일 규칙(PM 지시 8/11 밤 정정 — D+3): 월~목 → [D+3] / 금 → [D+3, D+4, D+5 = 월·화·수] / 토·일 → 실행 안 함.
// 스케줄이 이미 주말을 빼지만 함수 안에서 한 번 더 거른다(이중 방어 — 크론 표기 실수·수동 트리거 대비).
const { issueSession } = require('./_lib/session');

// KST 일자 문자열(YYYY-MM-DD). offsetDays만큼 이동.
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }

exports.handler = async function () {
  const kstDay = new Date(Date.now() + 9 * 3600000).getUTCDay();   // KST 요일: 0=일 … 6=토
  if (kstDay === 0 || kstDay === 6) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'weekend' }) };
  }
  const offs = (kstDay === 5) ? [3, 4, 5] : [3];   // 금요일만 주말 실행분(월·화)+수요일분까지 미리 제출
  const targetDays = offs.map(kstDate);
  const job = 'hw_cron_' + kstDate(0);   // 같은 날 재실행 시 같은 작업 키에 덮어씀(중복 blob 방지)

  // 내부 토큰(mid='__hwakwan__') — 워커는 이 토큰만 받는다. 자격증명은 워커가 환경변수에서 직접 읽는다.
  const s = issueSession({ id: '__hwakwan__', role: 'system' });
  if (!s.ok) return { statusCode: 500, body: JSON.stringify({ ok: false, code: s.code || 'SERVER_CONFIG_MISSING' }) };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'NO_SITE_URL' }) };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-hwakwan-run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ job: job, mode: 'daily', params: { targetDays: targetDays } }),
    });
    if (!resp.ok && resp.status !== 202) return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_HTTP_' + resp.status, job: job }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, job: job, targetDays: targetDays }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, code: 'KICKOFF_FAILED', job: job }) };
  }
};
