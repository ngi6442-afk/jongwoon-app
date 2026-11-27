'use strict';
// 의무 대장 회차 계산(v353, 인허가 2차 — PM 2026-09-11 ㄱ "담당자는 관리자로 동결, 나머지는 추천대로").
// 앱(index.html의 DUTY_SHARED 구간)과 서버 크론(gw-duty-cron)이 **같은 본문**을 쓴다 — uismoke가 두 본문을 글자 단위로 대조한다.
// 그래서 ES5(var·function)만 쓰고 Node 전용 API를 쓰지 않는다. 날짜는 전부 'YYYY-MM-DD' 문자열, 시간대 무관(달력 산술만).
//
// 행 d 의 일정 d.sched = { type: fixed|interval|event|always|na, every_n, every_unit(month|year), fixed_month, fixed_day(0=말일), fixed2_month, fixed2_day(둘째 고정일, 선택),
//   base: issued|last_done|manual|none, lic_id, grace_days, auto, needs_manual_date, note, confidence }  — data/duties_sched.json(정규화 표)
// 완료 기록 d.runs = [{ due, done_at, memo, by, ts }]  ·  기준일 d.base_date(직전 이행일 또는 기산일 — 사람이 넣는다)
// 다음 기한 규칙:
//   fixed    : 매년 M/D(1~2개). 기준(직전 이행일=runs 최신 done_at 또는 base_date)에 가장 가까운 회차가 채워진 것 → 그다음 회차. 기준이 없으면 DUTY_FROM 해분부터(지났으면 지남 — 닫힐 때까지 남음, 판20 검토 A).
//   interval issued    : 허가일 + k×주기 (+유예). 기준일(직전 이행일)에 가장 가까운 회차가 채워진 것. 기준이 없으면 DUTY_FROM에 이미 한 주기 넘게 지난 회차는 안 보인다.
//   interval last_done/manual : 기준일(runs 최신 done_at 또는 base_date) + 주기 (+유예). 기준일이 없으면 계산 불가(missing:'base').
//   완료 처리된 회차(runs[].due)는 건너뛴다. 결과 { due, days(음수=지남), overdue, kind, anchor, missing }.
// ==== DUTY_SHARED_BEGIN ====
function dutyPad2(n){ return (n < 10 ? "0" : "") + n; }
function dutyParse(iso){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}
function dutyLastDay(y, m){ return new Date(y, m, 0).getDate(); }   // m = 1~12
function dutyMake(y, m, d){
  while (m > 12){ m -= 12; y += 1; }
  while (m < 1){ m += 12; y -= 1; }
  var last = dutyLastDay(y, m);
  if (d < 1 || d > last) d = last;   // 0 = 말일, 31일이 없는 달은 말일로
  return y + "-" + dutyPad2(m) + "-" + dutyPad2(d);
}
function dutyAddMonths(iso, n){
  var p = dutyParse(iso); if (!p) return "";
  return dutyMake(p.y, p.m + n, p.d);
}
function dutyAddDays(iso, n){
  var p = dutyParse(iso); if (!p) return "";
  var t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86400000);
  return t.getUTCFullYear() + "-" + dutyPad2(t.getUTCMonth() + 1) + "-" + dutyPad2(t.getUTCDate());
}
function dutyDiffDays(a, b){   // a - b (일)
  var pa = dutyParse(a), pb = dutyParse(b); if (!pa || !pb) return 0;
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
}
function dutyPeriodMonths(s){
  var n = Number(s && s.every_n) || 0;
  if (n <= 0) return 0;
  return (s.every_unit === "year") ? n * 12 : n;
}
// 직전 이행 기준 — runs 중 가장 늦은 done_at, 없으면 base_date
function dutyAnchor(d){
  var best = "";
  var runs = (d && d.runs && d.runs.length) ? d.runs : [];
  for (var i = 0; i < runs.length; i++){ var r = runs[i]; if (r && dutyParse(r.done_at) && r.done_at > best) best = r.done_at; }
  if (best) return best;
  return (d && dutyParse(d.base_date)) ? d.base_date : "";
}
function dutyDoneSet(d){
  var set = {}, runs = (d && d.runs && d.runs.length) ? d.runs : [];
  for (var i = 0; i < runs.length; i++){ if (runs[i] && runs[i].due) set[runs[i].due] = true; }
  return set;
}
// 후보 기한 목록에서 기준일(직전 이행일)이 채운 회차 = 기준일에 가장 가까운 후보(마감 전 이행·마감 뒤 늦은 이행 모두 그 회차로 본다).
//   예: 매년 3/31 — 2026-03-20 이행 → 2026-03-31 회차 완료 → 다음 2027-03-31 / 2026-04-05(늦은 이행)도 2026 회차.
function dutyFilledIdx(cands, anchor){
  var best = -1, bestGap = 1e9;
  for (var i = 0; i < cands.length; i++){
    var gap = Math.abs(dutyDiffDays(cands[i], anchor));
    if (gap < bestGap){ bestGap = gap; best = i; }
  }
  return best;
}
// 다음 회차를 찾기 시작할 후보 자리(고정일·허가일 주기) — 완료 기록(runs[].due)이 후보에 있으면 가장 늦은 완료 회차 다음(P1 판28: 기한을 한참 넘겨 낸 회차가
//   제출일에 더 가까운 다음 회차까지 채운 것으로 보이지 않게 — 예: 2026-02-28 회차를 2026-11-13에 냄 → 다음 2027-02-28), 없으면 기준일에 가장 가까운 후보 다음, 둘 다 없으면 -1
function dutyStartIdx(cands, done, anchor){
  var k, last = -1;
  for (k = 0; k < cands.length; k++){ if (done[cands[k]]) last = k; }
  if (last >= 0) return last + 1;
  if (anchor) return dutyFilledIdx(cands, anchor) + 1;
  return -1;
}
// P1 판20 검토 A: 기록이 없는 회차를 세기 시작한 날(판28 '이번 달' 탭이 운영에 들어온 날) — 기준(완료 기록·기준일)이 없는 행은 '오늘'이 아니라 이 날까지만 지난 회차를 걸러 낸다.
//   그 뒤에 기한이 온 회차는 [완료+수령 올리기]·[해당 없음]으로 닫힐 때까지 해가 바뀌어도 '지남'으로 남는다(가장 오래된 것부터 — 종전엔 1월 1일·한 주기 뒤에 기록 없이 사라짐).
//   이 날 이후 아무 날의 결과는 종전 규칙을 이 날에 멈춘 것과 같고, 이 날 이전 날짜(시험)는 종전 그대로(오늘).
var DUTY_FROM = "2026-11-13";
// 판20 재검토 2: 그 행의 세기 시작일 — 근거 표 행(sched.count_from)·의무 대장 행(count_from)·허가증 등록일(created — 앱 허가증 등록 두 길이 늘 적음) 가운데 가장 늦은 날,
//   DUTY_FROM보다 이르거나 없으면 DUTY_FROM. 나중에 근거 표에 오르는 행·새로 등록하는 허가증이 DUTY_FROM 해 회차부터 '지남'으로 보이지 않게(지금 98행·허가증 13개 = 칸 없음·등록 2026-07-08 → 결과 같음).
// 판20b: today를 주면 그날보다 늦은(미래) 값은 무시한다 — 미래 세기 시작일이 그날까지 '오늘' 기준(해 넘김 전 규칙)으로 돌아가지 않게. 그날이 오면 그 값부터 셈.
function dutyFrom(d, lic, today){
  var f = DUTY_FROM, c = [d && d.sched && d.sched.count_from, d && d.count_from, lic && lic.created], i, x;
  for (i = 0; i < c.length; i++){ x = String(c[i] || "").slice(0, 10); if (today && x > today) x = ""; if (dutyParse(x) && x > f) f = x; }
  return f;
}
// d = 의무 행, lic = 붙는 허가증({issued}) 또는 null, today = 'YYYY-MM-DD'
function dutyNext(d, lic, today){
  var s = d && d.sched;
  if (!s || !s.auto) return null;
  var done = dutyDoneSet(d), anchor = dutyAnchor(d), grace = Number(s.grace_days) || 0, k, j, due, cands = [], start = 0;
  var from = dutyFrom(d, lic), lim = today < from ? today : from;   // 기준 없는 행의 '지난 회차 걸러 내기' 기준 날
  // 판20b: 세기 시작일이 오늘보다 늦으면(미래) 그 값은 무시하고 고정 날짜로(DUTY_FROM 전 날짜는 종전 그대로 오늘)
  if (dutyFrom(d, lic) > today){ lim = dutyFrom(d, lic, today); if (today < lim) lim = today; }
  var out = { due: "", days: 0, overdue: false, kind: s.type, anchor: anchor, missing: null };
  if (s.type === "fixed"){
    // 매년 1~2개 고정일(fixed_month/day, 선택 fixed2_month/day — 예: 반기 보고 7/31·익년 1/31). 말일 = day 0.
    var dates = [], mo = Number(s.fixed_month) || 0, dy = Number(s.fixed_day), mo2 = Number(s.fixed2_month) || 0, dy2 = Number(s.fixed2_day);
    if (mo < 1 || mo > 12){ out.missing = "sched"; return out; }
    dates.push([mo, isNaN(dy) ? 0 : dy]);
    if (mo2 >= 1 && mo2 <= 12) dates.push([mo2, isNaN(dy2) ? 0 : dy2]);
    var y0 = dutyParse(anchor) ? dutyParse(anchor).y : dutyParse(lim).y;   // 판20 검토 A: 기준 없음 = DUTY_FROM 해부터(종전 오늘 해)
    var lastDue = ""; for (k in done){ if (done.hasOwnProperty(k) && dutyParse(k) && k > lastDue) lastDue = k; }
    if (lastDue && dutyParse(lastDue).y < y0) y0 = dutyParse(lastDue).y;   // P1 판28 검토 4: 후보 시작 연도 = 가장 늦은 완료 회차 연도와 제출일 연도 중 이른 쪽 — 몇 해 늦게 낸 회차도 후보 안에 들어 그다음 회차부터(여러 회차를 건너뛰지 않게)
    var yN = Math.max(y0 + 5, dutyParse(today).y + 1);   // 판20 검토 A: 오늘 다음 해까지는 늘 후보(시작 해가 오래돼도 '범위 밖'이 되지 않게)
    for (k = y0 - 1; k <= yN; k++){ for (j = 0; j < dates.length; j++) cands.push(dutyMake(k, dates[j][0], dates[j][1])); }
    cands.sort();
    start = dutyStartIdx(cands, done, anchor);
    if (start < 0){   // 기준 없음: DUTY_FROM 해분부터 — 그 전 해 회차·DUTY_FROM에 이미 한 주기(12/날짜 수 개월) 넘게 지난 회차는 안 보인다(그 뒤 회차는 닫힐 때까지 남음)
      start = 0;
      var ly = dutyParse(lim).y, gapM = Math.round(12 / dates.length);
      while (start < cands.length && (dutyParse(cands[start]).y < ly || dutyAddMonths(cands[start], gapM) <= lim)) start++;
    }
  } else if (s.type === "interval"){
    var per = dutyPeriodMonths(s);
    if (!per){ out.missing = "sched"; return out; }
    if (s.base === "issued"){
      var issued = (lic && dutyParse(lic.issued)) ? lic.issued : "";
      if (!issued){ out.missing = "lic"; return out; }
      for (k = 1; k <= 120; k++){
        due = dutyAddMonths(issued, per * k);
        cands.push(grace ? dutyAddDays(due, grace) : due);
      }
      start = dutyStartIdx(cands, done, anchor);
      if (start < 0){ start = 0; while (start < cands.length && dutyAddMonths(cands[start], per) <= lim) start++; }   // 기준 없음: DUTY_FROM에 이미 한 주기 넘게 지난 회차는 안 보인다(그 뒤 회차는 닫힐 때까지 남음 — 판20 검토 A)
    } else {   // last_done · manual — 직전 이행일(runs) 또는 사람이 넣은 기준일부터 한 주기
      if (!anchor){ out.missing = "base"; return out; }
      // C244(계산 검산 11/20): 유예는 회차마다 그 회차 기준일에 한 번만 붙인다 — 유예를 더한 앞 회차에 다시 주기를 더하면 유예가 쌓였다(71행 6개월·유예 30: 2027-07-29 → 2027-07-30)
      due = anchor;
      for (k = 0; k < 6; k++){ due = dutyAddMonths(due, per); cands.push(grace ? dutyAddDays(due, grace) : due); }
    }
  } else {
    return null;   // event·always·na — 자동 회차 없음
  }
  for (k = start; k < cands.length; k++){ if (!done[cands[k]]){ out.due = cands[k]; break; } }   // 완료 처리된 회차는 건너뛴다
  if (!out.due){ out.missing = "range"; return out; }
  out.days = dutyDiffDays(out.due, today);
  out.overdue = out.days < 0;
  // 판20 재검토 1: 이 회차 뒤로 이미 30일 안에 들어왔거나 지난 회차들(완료 안 된 것) — 지난 회차가 열려 있는 동안 진짜 다음 기한이 조용히 지나가지 않게. 쓰는 쪽은 dutyCur(지금 회차가 지났을 때만)
  out.ahead = [];
  for (j = k + 1; j < cands.length; j++){ if (done[cands[j]]) continue; due = dutyDiffDays(cands[j], today); if (due > 30) break; out.ahead.push({ due: cands[j], days: due }); }
  return out;
}
// 이번 회차(P1 판28) — dutyNext에 그 행의 [해당 없음]·[기한 정정]을 얹는다. 해당 없음(d.na.on) = null(자동 회차 끔 — 행·근거·완료 기록은 그대로).
//   기한 정정은 그 회차만(d.due_fix[계산 기한] = { to, … } — 주기 값은 안 바꿈). 결과 = dutyNext 결과 + orig(계산 기한 — 완료 기록 runs[].due에 넣는 값) · fixed(정정됨).
function dutyCur(d, lic, today){
  if (d && d.na && d.na.on) return null;
  var nx = dutyNext(d, lic, today);
  if (!nx || !nx.due) return nx;
  nx.orig = nx.due; nx.fixed = false;
  var fm = (d && d.due_fix && typeof d.due_fix === "object") ? d.due_fix : null;
  var fx = (fm && Object.prototype.hasOwnProperty.call(fm, nx.due)) ? fm[nx.due] : null;
  if (fx && dutyParse(fx.to)){ nx.due = fx.to; nx.fixed = true; nx.days = dutyDiffDays(nx.due, today); nx.overdue = nx.days < 0; }
  if (!nx.overdue) nx.ahead = [];   // 판20 재검토 1: '다음 회차'는 지금 회차가 지났을 때만(월 1회 행이 매달 겹쳐 보이지 않게 — 지금 회차가 안 지났으면 그 지시가 먼저)
  return nx;
}
// 알림 단계 — 'over'(지남, 매일) · 'd7'(7일 이내 1회) · 'd30'(30일 이내 1회) · ''
function dutyStage(nx){
  if (!nx || !nx.due) return "";
  if (nx.days < 0) return "over";
  if (nx.days <= 7) return "d7";
  if (nx.days <= 30) return "d30";
  return "";
}
// ==== DUTY_SHARED_END ====

module.exports = { DUTY_FROM, dutyFrom, dutyParse, dutyLastDay, dutyMake, dutyAddMonths, dutyAddDays, dutyDiffDays, dutyPeriodMonths, dutyAnchor, dutyDoneSet, dutyFilledIdx, dutyStartIdx, dutyNext, dutyCur, dutyStage };
