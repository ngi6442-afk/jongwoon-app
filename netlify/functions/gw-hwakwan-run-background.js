'use strict';

// 화관법 제출 백그라운드 워커 — Netlify Background Function(-background 접미사, 15분 한도).
// gw-hwakwan(사용자 API)·gw-hwakwan-cron(스케줄)이 내부 토큰(mid='__hwakwan__')으로만 기동한다.
// 호출 즉시 202 반환, 진행·결과는 blob 'hwakwan:job:<id>'에 기록 → 앱이 hw_job으로 폴링.
// 제출은 정부 규제 민원이라 되돌릴 수 없다 — 실패 의심 시 중단이 원칙(icis.js가 준수, 여기선 기록만 정확히).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const push = require('./_lib/push');
const { SCENARIOS, WASTE_VEHICLES, runDaily, submitWaste } = require('./_lib/icis');

const DATA = 'gw_data';
function jobKey(id) { return `hwakwan:job:${id}`; }
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_JOB = /^hw_[a-z0-9_-]{1,60}$/i;
// 달력 왕복 검증(V2 검토 2026-08-11) — 2026-02-30 같은 불가능 날짜 차단
function validDay(s) {
  const p = String(s).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
}

// 실패 요약 — 푸시 본문용. 로그 끝부분(원인 근처)을 우선한다. 자격증명 값은 icis.js가 로그에 안 남긴다.
function failSummary(log) {
  const lines = (Array.isArray(log) ? log : []).map(String).filter(Boolean);
  return (lines.slice(-3).join(' / ') || '원인 미상 — 작업 로그 확인').slice(0, 280);
}

exports.handler = async function (event, context) {
  let st = null, job = '', rec = null;
  try {
    setupBlobContext(event, context);
    // 내부 토큰만 허용 — 사용자 토큰(mid=회원id)으로는 워커를 못 돌린다(검증 우회 제출 차단).
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__hwakwan__') return;
    let d = {};
    try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    job = String(d.job || '').trim();
    const mode = String(d.mode || '').trim();
    const params = (d.params && typeof d.params === 'object') ? d.params : {};
    if (!RE_JOB.test(job)) return;
    if (mode !== 'daily' && mode !== 'waste') return;
    st = store(DATA);
    rec = { ts: Date.now(), status: 'running', mode: mode, log: [], results: null };
    await blobSet(st, jobKey(job), rec);

    // 자격증명은 환경변수에서만. 없으면 실패 기록 후 조용히 종료(값은 어디에도 안 남긴다).
    if (!process.env.GW_ICIS_ID || !process.env.GW_ICIS_PW) {
      rec.status = 'fail'; rec.code = 'ENV_MISSING'; rec.ts = Date.now();
      await blobSet(st, jobKey(job), rec);
      return;
    }
    const creds = { id: process.env.GW_ICIS_ID, pw: process.env.GW_ICIS_PW };

    if (mode === 'daily') {
      // 제품 노선 자동 제출 — targetDays는 기동측(크론·hw_run_now)에서 계산돼 온다.
      const targetDays = (Array.isArray(params.targetDays) ? params.targetDays : []).map(function (s) { return String(s || '').trim(); }).filter(function (s) { return RE_DATE.test(s) && validDay(s); });
      if (!targetDays.length) {
        rec.status = 'fail'; rec.code = 'NO_TARGET_DAYS'; rec.ts = Date.now();
        await blobSet(st, jobKey(job), rec);
        return;
      }
      let r;
      try { r = await runDaily(creds, targetDays, {}); }
      catch (e) { r = { ok: false, days: [], log: ['RUN_THREW: ' + String((e && e.message) || e).slice(0, 200)] }; }
      rec.results = Array.isArray(r.days) ? r.days : [];
      rec.log = Array.isArray(r.log) ? r.log : [];
      rec.status = r.ok ? 'done' : 'fail';
      rec.ts = Date.now();
      await blobSet(st, jobKey(job), rec);
      // 마지막 자동 실행 기록(hw_status 상태 카드용) — 성공·실패 모두 갱신
      const nSub = rec.results.reduce(function (a, dd) { return a + ((dd && Array.isArray(dd.submitted)) ? dd.submitted.length : 0); }, 0);
      const nSkip = rec.results.reduce(function (a, dd) { return a + ((dd && Array.isArray(dd.skipped)) ? dd.skipped.length : 0); }, 0);
      await blobSet(st, 'hwakwan:lastrun', {
        ts: Date.now(), job: job, ok: !!r.ok, submitted: nSub, skipped: nSkip,
        days: rec.results.map(function (dd) {
          return { day: dd && dd.day, base: dd && dd.base,
            submitted: ((dd && dd.submitted) || []).map(function (s) { return { sn: s && s.sn, label: s && s.label }; }),
            skipped: (dd && dd.skipped) || [] };
        }),
      });
      // 관리자 웹푸시 — 실패는 반드시, 성공도 접수 건수 통지(발송 실패가 작업 결과를 바꾸면 안 됨)
      try {
        const ids = await push.adminIds();
        if (ids.length) {
          if (r.ok) await push.sendTo(ids, { title: '화관법 자동 접수', body: nSub + '건 접수' + (nSkip ? ' · ' + nSkip + '건 건너뜀' : ''), url: './', tag: 'hwakwan' });
          else await push.sendTo(ids, { title: '화관법 자동제출 실패', body: failSummary(rec.log), url: './', tag: 'hwakwan' });
        }
      } catch (e) {}
      return;
    }

    // mode === 'waste' — 폐기물 노선 1건 제출. gw-hwakwan이 이미 검증했지만 워커도 화이트리스트 재검증(심층 방어).
    const vehicleNo = String(params.vehicleNo || '').trim();
    const scenario = String(params.scenario || '').trim();
    const date = String(params.date || '').trim();
    const time = String(params.time || '').trim();
    if (WASTE_VEHICLES.indexOf(vehicleNo) < 0 || !Object.prototype.hasOwnProperty.call(SCENARIOS, scenario) || !RE_DATE.test(date) || !validDay(date) || !RE_TIME.test(time)) {
      rec.status = 'fail'; rec.code = 'BAD_PARAMS'; rec.ts = Date.now();
      await blobSet(st, jobKey(job), rec);
      return;
    }
    let r;
    try { r = await submitWaste(creds, { vehicleNo: vehicleNo, scenario: scenario, date: date, time: time }); }
    catch (e) { r = { ok: false, code: 'SUBMIT_THREW', detail: String((e && e.message) || e).slice(0, 300) }; }
    rec.results = r || null;
    rec.status = (r && r.ok) ? 'done' : 'fail';
    if (r && !r.ok) { rec.code = r.code || 'SUBMIT_FAILED'; if (r.detail) rec.detail = String(r.detail).slice(0, 300); }
    rec.ts = Date.now();
    await blobSet(st, jobKey(job), rec);   // 푸시 없음 — UI가 hw_job 폴링으로 결과 표시
  } catch (e) {
    // 백그라운드 — 응답 무의미. 마지막 안전망: 작업이 '영원히 running'으로 남지 않게 실패 기록 시도.
    try {
      if (st && job) {
        const fail = rec || { ts: Date.now(), mode: '', log: [], results: null };
        fail.status = 'fail'; fail.code = fail.code || 'WORKER_THREW';
        fail.detail = String((e && e.message) || e).slice(0, 300); fail.ts = Date.now();
        await blobSet(st, jobKey(job), fail);
      }
    } catch (e2) {}
  }
};
