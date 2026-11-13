'use strict';
// 의무 대장 회차 계산(v353, 인허가 2차 — PM 2026-09-11 ㄱ "담당자는 관리자로 동결, 나머지는 추천대로").
// 앱(index.html의 DUTY_SHARED 구간)과 서버 크론(gw-duty-cron)이 **같은 본문**을 쓴다 — uismoke가 두 본문을 글자 단위로 대조한다.
// 그래서 ES5(var·function)만 쓰고 Node 전용 API를 쓰지 않는다. 날짜는 전부 'YYYY-MM-DD' 문자열, 시간대 무관(달력 산술만).
//
// 행 d 의 일정 d.sched = { type: fixed|interval|event|always|na, every_n, every_unit(month|year), fixed_month, fixed_day(0=말일), fixed2_month, fixed2_day(둘째 고정일, 선택),
//   base: issued|last_done|manual|none, lic_id, grace_days, auto, needs_manual_date, note, confidence }  — data/duties_sched.json(정규화 표)
// 완료 기록 d.runs = [{ due, done_at, memo, by, ts }]  ·  기준일 d.base_date(직전 이행일 또는 기산일 — 사람이 넣는다)
// 다음 기한 규칙:
//   fixed    : 매년 M/D(1~2개). 기준(직전 이행일=runs 최신 done_at 또는 base_date)에 가장 가까운 회차가 채워진 것 → 그다음 회차. 기준이 없으면 올해분부터(지났으면 지남).
//   interval issued    : 허가일 + k×주기 (+유예). 기준일(직전 이행일)에 가장 가까운 회차가 채워진 것. 기준이 없으면 한 주기 넘게 지난 회차는 안 보인다.
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
// d = 의무 행, lic = 붙는 허가증({issued}) 또는 null, today = 'YYYY-MM-DD'
function dutyNext(d, lic, today){
  var s = d && d.sched;
  if (!s || !s.auto) return null;
  var done = dutyDoneSet(d), anchor = dutyAnchor(d), grace = Number(s.grace_days) || 0, k, j, due, cands = [], start = 0;
  var out = { due: "", days: 0, overdue: false, kind: s.type, anchor: anchor, missing: null };
  if (s.type === "fixed"){
    // 매년 1~2개 고정일(fixed_month/day, 선택 fixed2_month/day — 예: 반기 보고 7/31·익년 1/31). 말일 = day 0.
    var dates = [], mo = Number(s.fixed_month) || 0, dy = Number(s.fixed_day), mo2 = Number(s.fixed2_month) || 0, dy2 = Number(s.fixed2_day);
    if (mo < 1 || mo > 12){ out.missing = "sched"; return out; }
    dates.push([mo, isNaN(dy) ? 0 : dy]);
    if (mo2 >= 1 && mo2 <= 12) dates.push([mo2, isNaN(dy2) ? 0 : dy2]);
    var y0 = dutyParse(anchor) ? dutyParse(anchor).y : dutyParse(today).y;
    for (k = -1; k < 6; k++){ for (j = 0; j < dates.length; j++) cands.push(dutyMake(y0 + k, dates[j][0], dates[j][1])); }
    cands.sort();
    start = dutyStartIdx(cands, done, anchor);
    if (start < 0){   // 기준 없음: 올해분부터 — 지난해 회차·한 주기(12/날짜 수 개월) 넘게 지난 회차는 안 보인다
      start = 0;
      var ty = dutyParse(today).y, gapM = Math.round(12 / dates.length);
      while (start < cands.length && (dutyParse(cands[start]).y < ty || dutyAddMonths(cands[start], gapM) <= today)) start++;
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
      if (start < 0){ start = 0; while (start < cands.length && dutyAddMonths(cands[start], per) <= today) start++; }   // 기준 없음: 한 주기 넘게 지난 회차는 안 보인다
    } else {   // last_done · manual — 직전 이행일(runs) 또는 사람이 넣은 기준일부터 한 주기
      if (!anchor){ out.missing = "base"; return out; }
      due = dutyAddMonths(anchor, per);
      if (grace) due = dutyAddDays(due, grace);
      for (k = 0; k < 6; k++){ cands.push(due); due = dutyAddMonths(due, per); }
    }
  } else {
    return null;   // event·always·na — 자동 회차 없음
  }
  for (k = start; k < cands.length; k++){ if (!done[cands[k]]){ out.due = cands[k]; break; } }   // 완료 처리된 회차는 건너뛴다
  if (!out.due){ out.missing = "range"; return out; }
  out.days = dutyDiffDays(out.due, today);
  out.overdue = out.days < 0;
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

module.exports = { dutyParse, dutyLastDay, dutyMake, dutyAddMonths, dutyAddDays, dutyDiffDays, dutyPeriodMonths, dutyAnchor, dutyDoneSet, dutyFilledIdx, dutyStartIdx, dutyNext, dutyCur, dutyStage };
