'use strict';

// 올바로 일일운반일지 수집 백그라운드 워커 — Netlify Background Function(-background 접미사, 15분 한도).
// gw-allbaro(사용자 API)·gw-allbaro-cron(스케줄)이 내부 토큰(mid='__allbaro__')으로만 기동한다.
// 호출 즉시 202 반환, 진행·결과는 blob 'allbaro:job:<id>'에 기록 → 앱이 ab_job으로 폴링.
// 자격증명은 환경변수 GW_ALLBARO_ID / GW_ALLBARO_PW 에서만 읽고, 이 파일 밖(로그·blob·푸시)으로 절대 내보내지 않는다.
//   - 요청 본문을 통째로 찍는 코드 없음(로그인 본문에 비밀번호가 들어간다)
//   - 라이브러리가 돌려준 로그·예외 문구는 scrub()으로 자격증명 문자열을 지운 뒤에만 저장한다(마지막 방어선)
// 올바로는 조회 전용 — 여기서 등록·수정·삭제 요청을 보내지 않는다(_lib/allbaro.js도 조회만 제공).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const push = require('./_lib/push');
const { collectDays } = require('./_lib/allbaro');

const DATA = 'gw_data';
function jobKey(id) { return `allbaro:job:${id}`; }
function dayKey(day) { return `allbaro:day:${day}`; }
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_JOB = /^ab_[a-z0-9_-]{1,60}$/i;
const MAX_DAYS = 14;      // 한 실행당 최대 날짜 수(기동측과 동일)
const BACK_DAYS = 61;     // 소급 허용(기동측 60 + 하루 여유 — KST 자정 경계에서 정상 요청이 잘리지 않게)
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 500;
const MAX_VEHICLES = 500;   // 차량현황 상한(실사용 수십 대) — 이상 비대해진 문서로 워커가 붙들리지 않게
const MAX_LEARNED = 500;    // 학습 지정 상한(gw-allbaro의 저장 상한과 동일)

// 달력 왕복 검증 — 2026-02-30 같은 불가능 날짜가 blob 키로 흘러가는 것을 차단
function validDay(s) {
  const p = String(s).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2];
}
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }

// 자격증명 유출 마지막 방어선 — 저장·발송되는 모든 문자열에서 ID/PW 값을 지운다.
// 값을 비교만 하고 어디에도 쓰지 않는다. 정규식 대신 split/join(이스케이프 사고 방지).
function makeScrub() {
  const secrets = [process.env.GW_ALLBARO_ID, process.env.GW_ALLBARO_PW]
    .map(function (s) { return s == null ? '' : String(s); })
    .filter(function (s) { return s.length >= 4; });   // 너무 짧은 값은 오탐 치환만 유발
  return function scrub(v) {
    let out = (v === null || v === undefined) ? '' : String(v);
    for (const sec of secrets) { if (out.indexOf(sec) >= 0) out = out.split(sec).join('***'); }
    return out.length > MAX_LOG_CHARS ? out.slice(0, MAX_LOG_CHARS) + '…' : out;
  };
}

// 미매칭 '건수' 합. unmatched=[{from,to,item,n}] — n이 비면 1건으로 센다(과소집계 방지).
function unmatchedCount(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce(function (a, u) {
    const v = Number(u && u.n);
    return a + (Number.isFinite(v) && v > 0 ? v : 1);
  }, 0);
}
// counts에서 총 건수 되계산(라이브러리 total이 없거나 이상할 때의 보정)
function countsTotal(counts) {
  if (!Array.isArray(counts)) return 0;
  return counts.reduce(function (a, c) {
    const v = Number(c && c.n);
    return a + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
}
// counts에서 톤 합계 되계산(라이브러리 total_qty_ton이 없거나 이상할 때의 보정)
function countsQty(counts) {
  if (!Array.isArray(counts)) return 0;
  const s = counts.reduce(function (a, c) {
    const v = Number(c && c.qty_ton);
    return a + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
  return Math.round(s * 1000) / 1000;
}
// counts에서 '단위 미상' 건수 되계산 — 0으로 뭉개지 말고 그대로 드러낸다(계약 A-4).
function countsQtyUnknown(counts) {
  if (!Array.isArray(counts)) return 0;
  return counts.reduce(function (a, c) {
    const v = Number(c && c.qty_unknown);
    return a + (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  }, 0);
}

// 차량현황(앱 blob col:vehicles) → [{no, type}]. 삭제(del=1)·차량번호 없는 항목 제외.
// 차량번호에 섞인 괄호 주석·공백 정규화는 _lib/allbaro.js가 한다 — 여기서는 원본을 그대로 넘긴다.
// 조회 실패는 빈 배열(수집은 계속). 차량을 모르면 차량으로 갈리는 줄은 라이브러리가 미매칭으로 드러낸다.
async function readVehicles(st, log) {
  try {
    const r = await blobGet(st, 'col:vehicles');
    if (!r.ok) { log.push('[차량] 조회 실패 ' + (r.code || '') + ' — 차량 판정 없이 진행'); return []; }
    const items = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    const out = [];
    let capped = false;
    for (const v of items) {
      if (!v || v.del === 1) continue;
      const no = String(v.no == null ? '' : v.no).trim();
      if (!no) continue;
      if (out.length >= MAX_VEHICLES) { capped = true; break; }
      out.push({ no: no, type: String(v.type == null ? '' : v.type).trim() });
    }
    log.push('[차량] ' + out.length + '대' + (capped ? ' (상한 ' + MAX_VEHICLES + '대까지만)' : ''));
    return out;
  } catch (e) {
    log.push('[차량] 조회 예외 — 차량 판정 없이 진행');
    return [];
  }
}

// 학습 사전(allbaro:learned) → [{from,to,item,side,row}]. 사람이 [노선 지정]으로 넣은 대응.
// 형태가 깨진 항목은 넘기지 않는다(라이브러리에서 조용히 오배정될 여지를 만들지 않는다).
async function readLearned(st, log) {
  try {
    const r = await blobGet(st, 'allbaro:learned');
    if (!r.ok) { log.push('[학습] 조회 실패 ' + (r.code || '') + ' — 학습 지정 없이 진행'); return []; }
    const items = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    const out = [];
    let bad = 0;
    for (const it of items) {
      const side = String((it && it.side) || '').trim().toUpperCase();
      const row = Number(it && it.row);
      const from = String((it && it.from) || '').trim();
      const to = String((it && it.to) || '').trim();
      if ((side !== 'L' && side !== 'R') || !Number.isInteger(row) || row <= 0 || !from || !to) { bad++; continue; }
      if (out.length >= MAX_LEARNED) break;
      out.push({ from: from, to: to, item: String((it && it.item) || '').trim(), side: side, row: row });
    }
    if (out.length || bad) log.push('[학습] ' + out.length + '건 적용' + (bad ? ' · 형식 오류 ' + bad + '건 제외' : ''));
    return out;
  } catch (e) {
    log.push('[학습] 조회 예외 — 학습 지정 없이 진행');
    return [];
  }
}

// 실패 요약 — 푸시 본문용. 로그 끝부분(원인 근처)을 우선. 이미 scrub된 로그만 넘길 것.
function failSummary(log) {
  const lines = (Array.isArray(log) ? log : []).map(String).filter(Boolean);
  return (lines.slice(-3).join(' / ') || '원인 미상 — 작업 로그 확인').slice(0, 280);
}

exports.handler = async function (event, context) {
  let st = null, job = '', rec = null;
  const scrub = makeScrub();
  try {
    setupBlobContext(event, context);
    // 내부 토큰만 허용 — 사용자 토큰(mid=회원id)으로는 워커를 못 돌린다(검증·권한 우회 차단).
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__allbaro__') return;
    let d = {};
    try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    job = String(d.job || '').trim();
    const mode = String(d.mode || '').trim();
    if (!RE_JOB.test(job)) return;
    if (mode !== 'collect' && mode !== 'inspect') return;

    // ---- inspect: 하루치 원시 행(시각 포함)을 그대로 반환 — EP더스트 조업일 규칙 실측용.
    // 조회 전용·내부 토큰 전용. 집계·저장(allbaro:day)은 건드리지 않는다.
    if (mode === 'inspect') {
      st = store(DATA);
      rec = { ts: Date.now(), status: 'running', mode: 'inspect', log: [], results: null };
      await blobSet(st, jobKey(job), rec);
      try {
        const day = String((d.params && d.params.day) || '').trim();
        if (!RE_DATE.test(day) || !validDay(day)) { rec.status = 'fail'; rec.code = 'BAD_DAY'; }
        else if (!process.env.GW_ALLBARO_ID || !process.env.GW_ALLBARO_PW) { rec.status = 'fail'; rec.code = 'ENV_MISSING'; }
        else {
          const A = require('./_lib/allbaro');
          const S = A.createSession({ id: process.env.GW_ALLBARO_ID, pw: process.env.GW_ALLBARO_PW });
          await S.login();
          const rows = await A.searchManifests(S, day, day);
          const emisLike = String((d.params && d.params.emisLike) || '');
          const wasteLike = String((d.params && d.params.wasteLike) || '');
          const hit = rows.filter(function (r) {
            return (!emisLike || String(r.emis).indexOf(emisLike) >= 0)
              && (!wasteLike || String(r.wasteName).indexOf(wasteLike) >= 0);
          }).map(function (r) {
            return { manf: r.manf, emis: r.emis, trtm: r.trtm, wasteName: r.wasteName,
              date: r.date, reservedAt: r.reservedAt, confirmedAt: r.confirmedAt,
              tranWorkAt: r.tranWorkAt, trtmWorkAt: r.trtmWorkAt,
              tranVehicle: r.tranVehicle, qty: r.tranQty };
          });
          rec.status = 'done'; rec.results = { day: day, total: rows.length, hit: hit.slice(0, 120) };
        }
      } catch (e) {
        rec.status = 'fail'; rec.code = rec.code || 'INSPECT_FAILED';
        rec.detail = scrub(String((e && e.message) || e));
      }
      rec.ts = Date.now();
      await blobSet(st, jobKey(job), rec);
      return;
    }

    // 날짜 재검증(심층 방어) — 형식·달력·범위를 모두 통과한 값만 blob 키가 된다.
    const lo = kstDate(-BACK_DAYS), hi = kstDate(1);   // 상한도 하루 여유(KST 자정 경계)
    const seen = Object.create(null);
    const days = [];
    for (const raw of (Array.isArray(d.days) ? d.days : [])) {
      const s = String(raw || '').trim();
      if (!RE_DATE.test(s) || !validDay(s)) continue;
      if (s < lo || s > hi) continue;
      if (seen[s]) continue;
      seen[s] = 1;
      days.push(s);
      if (days.length >= MAX_DAYS) break;
    }
    days.sort();

    st = store(DATA);
    rec = { ts: Date.now(), status: 'running', mode: 'collect', days_req: days, log: [], results: null };
    await blobSet(st, jobKey(job), rec);

    if (!days.length) {
      rec.status = 'fail'; rec.code = 'NO_TARGET_DAYS'; rec.ts = Date.now();
      await blobSet(st, jobKey(job), rec);
      return;
    }

    // 자격증명은 환경변수에서만. 없으면 실패 기록 후 조용히 종료(값은 어디에도 안 남긴다).
    if (!process.env.GW_ALLBARO_ID || !process.env.GW_ALLBARO_PW) {
      rec.status = 'fail'; rec.code = 'ENV_MISSING'; rec.ts = Date.now();
      await blobSet(st, jobKey(job), rec);
      return;
    }
    const creds = { id: process.env.GW_ALLBARO_ID, pw: process.env.GW_ALLBARO_PW };

    // 매칭 정밀화 입력(계약 B-1) — 차량현황·학습사전을 앱 blob에서 읽어 aggregate까지 그대로 넘긴다.
    // 둘 다 실패해도 수집은 계속한다(빈 배열). 값이 비면 판정이 헐거워질 뿐, 조용한 오배정은
    // 라이브러리 규칙(후보 여럿 → 미매칭)이 막는다.
    const preLog = [];
    const vehicles = await readVehicles(st, preLog);
    const learned = await readLearned(st, preLog);

    let r;
    try { r = await collectDays(creds, days, { vehicles: vehicles, learned: learned }); }
    catch (e) { r = { ok: false, code: 'COLLECT_THREW', days: [], log: ['COLLECT_THREW: ' + String((e && e.message) || e)] }; }

    const log = preLog.map(scrub)
      .concat((Array.isArray(r && r.log) ? r.log : []).map(scrub))
      .slice(-MAX_LOG_LINES);

    // 날짜별 저장 — 덮어쓰기(늦게 올라온 인계서가 반영되도록).
    // 요청한 날짜 집합에 있는 값만 키로 쓴다(라이브러리가 이상한 day를 돌려줘도 키 오염 없음).
    const saved = [];
    let unmatchedTotal = 0;
    let writeFail = 0;   // blob 쓰기 실패가 수집 성공에 묻히면 그날 집계가 조용히 빈다 — 따로 센다
    const unmatchedDays = [];
    for (const dd of (Array.isArray(r && r.days) ? r.days : [])) {
      const day = String((dd && dd.day) || '').trim();
      if (!RE_DATE.test(day) || !validDay(day) || !seen[day]) { log.push('[건너뜀] 알 수 없는 날짜 응답'); continue; }
      const counts = Array.isArray(dd.counts) ? dd.counts : [];
      const unmatched = Array.isArray(dd.unmatched) ? dd.unmatched : [];
      const tRaw = Number(dd.total);
      const total = (Number.isFinite(tRaw) && tRaw >= 0) ? tRaw : countsTotal(counts);
      // 실패한 실행이 과거의 정상 집계를 0건으로 덮어쓰지 않게 — 빈 결과 + 전체 실패면 보존
      if (!(r && r.ok) && total === 0) { log.push('[보존] ' + day + ' 빈 결과 — 기존 집계 유지'); continue; }
      const un = unmatchedCount(unmatched);
      // 수량(계약 A-4) — 라이브러리 값이 없거나 이상하면 counts에서 되계산한다.
      const qRaw = Number(dd.total_qty_ton);
      const qty = (Number.isFinite(qRaw) && qRaw >= 0) ? Math.round(qRaw * 1000) / 1000 : countsQty(counts);
      const quRaw = Number(dd.qty_unknown);
      const qtyUnknown = (Number.isFinite(quRaw) && quRaw >= 0) ? Math.floor(quRaw) : countsQtyUnknown(counts);
      // 계수 제외(타사 운반·미실행 예약건, 2026-08-19 신설) — 기록에 싣고 로그로도 드러낸다.
      const excluded = Array.isArray(dd.excluded) ? dd.excluded : [];
      if (excluded.length) {
        log.push('[' + day + '] 계수 제외 ' + excluded.length + '건 — ' +
          excluded.map(function (e) { return (e.manf || '?') + '(' + (e.why || '') + ')'; }).join(', ').slice(0, 200));
      }
      // 잠정(배출자 확정 전, 2026-08-24 신설) — 계수에는 포함돼 있고, 예약이 밀린 유령일 수
      // 있어 인계번호를 blob·로그에 남긴다(다음 수집이 자동 정리하지만 사람이 그날 바로 본다).
      const pendingRows = Array.isArray(dd.pending) ? dd.pending : [];
      if (pendingRows.length) {
        log.push('[' + day + '] 잠정(확정 전) ' + pendingRows.length + '건 — ' +
          pendingRows.map(function (p) { return p.manf || '?'; }).join(', ').slice(0, 200));
      }
      // 차량번호별 합계(2026-08-24) — 주는돈(지입차 지급) 마감 정산 참고. 일지에는 안 싣는다.
      const vehTotals = Array.isArray(dd.veh_totals) ? dd.veh_totals : [];
      // schema 2 = 수량 필드 추가(1단계 문서와 구분). 소비자는 필드별로 방어적으로 읽는다.
      const w = await blobSet(st, dayKey(day), { schema: 2, day: day, total: total, total_qty_ton: qty, qty_unknown: qtyUnknown, counts: counts, unmatched: unmatched, excluded: excluded, pending: pendingRows, veh_totals: vehTotals, ts: Date.now(), job: job });
      if (!w.ok) { writeFail++; log.push('[저장실패] ' + day + ' ' + (w.code || '')); continue; }
      saved.push({ day: day, total: total, qty_ton: qty, unmatched_n: un });
      unmatchedTotal += un;
      if (un > 0) unmatchedDays.push(day + ' ' + un + '건');
    }
    saved.sort(function (a, b) { return a.day < b.day ? 1 : (a.day > b.day ? -1 : 0); });   // 최신 날짜부터

    rec.log = log.slice(-MAX_LOG_LINES);
    rec.results = saved;
    rec.unmatched_total = unmatchedTotal;
    rec.status = (r && r.ok && !writeFail) ? 'done' : 'fail';
    if (!(r && r.ok)) { rec.code = (r && r.code) ? scrub(String(r.code)).slice(0, 60) : 'COLLECT_FAILED'; if (r && r.detail) rec.detail = scrub(r.detail); }
    else if (writeFail) { rec.code = 'DAY_WRITE_FAILED'; rec.detail = writeFail + '개 날짜 저장 실패'; }
    rec.ts = Date.now();
    await blobSet(st, jobKey(job), rec);

    // 마지막 수집 기록(ab_status 상태 카드용) — 성공·실패 모두 갱신
    const lastrun = { ts: Date.now(), job: job, ok: rec.status === 'done', days: saved, unmatched_total: unmatchedTotal };
    if (rec.code) lastrun.code = rec.code;
    await blobSet(st, 'allbaro:lastrun', lastrun);

    // 관리자 웹푸시 — 실패는 반드시, 미매칭이 있으면 알림(노선표 손질이 필요하다는 신호).
    // 성공 + 미매칭 0이면 푸시하지 않는다(매일 오는 알림은 소음이다).
    // 발송 실패가 작업 결과를 바꾸면 안 되므로 전부 삼킨다.
    try {
      const needFail = rec.status === 'fail';
      // 미매칭은 7일 창을 매일 다시 훑으므로, 노선표를 고칠 때까지 같은 알림이 매일 온다.
      // 내용이 직전과 같으면 보내지 않는다 — 매일 오는 알림은 무시하게 되고, 그러면 새 미매칭도 놓친다.
      const sig = unmatchedDays.slice().sort().join('|');
      let needUnmatched = unmatchedTotal > 0;
      if (needUnmatched) {
        const prev = await blobGet(st, 'allbaro:lastnotify');
        if (prev.ok && prev.data && prev.data.sig === sig) needUnmatched = false;
      }
      if (needFail || needUnmatched) {
        const ids = await push.adminIds();
        if (ids.length) {
          if (needFail) await push.sendTo(ids, { title: '올바로 수집 실패', body: failSummary(rec.log), url: './', tag: 'allbaro' });
          if (needUnmatched) await push.sendTo(ids, { title: '운반일지 미매칭', body: (unmatchedDays.join(' · ') + ' — 노선표 확인 필요').slice(0, 280), url: './', tag: 'allbaro-unmatched' });
        }
      }
      if (unmatchedTotal > 0) { if (needUnmatched) await blobSet(st, 'allbaro:lastnotify', { sig: sig, ts: Date.now() }); }
      else await blobSet(st, 'allbaro:lastnotify', { sig: '', ts: Date.now() });   // 해소되면 서명 비움(다음 발생 시 다시 알림)
    } catch (e) {}
  } catch (e) {
    // 백그라운드 — 응답 무의미. 마지막 안전망: 작업이 '영원히 running'으로 남지 않게 실패 기록 시도.
    try {
      if (st && job) {
        const fail = rec || { ts: Date.now(), mode: 'collect', log: [], results: null };
        fail.status = 'fail'; fail.code = fail.code || 'WORKER_THREW';
        fail.detail = scrub((e && e.message) || e); fail.ts = Date.now();
        await blobSet(st, jobKey(job), fail);
      }
    } catch (e2) {}
  } finally {
    // 동시 실행 잠금 해제 — 성공·실패·예외 어느 경로로 끝나도 시도한다.
    // 단, '자기 job의 잠금'일 때만 푼다(계약 B-minor). 다른 job(뒤이어 붙은 다른 워커·수동수집)이
    // 이미 잠금을 가져갔다면 남의 잠금을 풀지 않는다. 해제 못 해도 10분 뒤 만료되므로 영구 잠금은 없다.
    try {
      if (st && job) {
        const cur = await blobGet(st, 'allbaro:lock');
        if (cur.ok && cur.data && cur.data.job === job) await blobSet(st, 'allbaro:lock', { ts: 0, job: '' });
      }
    } catch (e3) {}
  }
};
