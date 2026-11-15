'use strict';
// P1 판20(원장 T179·C117 · 착수설명서 판20 · 업무별 설계 3-8 A3) 인허가 의무 기한 → 담당 자동 지시. 순수 함수(저장·알림 없음) — servertest P1 판20 대상.
// 판정 한 곳: rowState = 인허가 '이번 달' 탭(index.html @lic-month 구간 lmGroups·lmNext)과 같은 계산 — 같은 _lib/duty.js dutyCur(앱 DUTY_SHARED와 글자째 같은 본문)·dutyStage,
//   같은 입력(서버 lic_month_get이 내리는 licBgOut 칸을 sched로 · 의무 대장 행 · 허가증)으로 묶음(지남·7일 안·30일 안·기준일 없음·그 뒤·해당 없음)과 기한을 낸다.
//   uismoke P1 판20이 같은 표본·여러 날짜에서 탭 묶음·기한과 이 결과를 대조한다(한 번이라도 다르면 실패).
// 지시: 행·회차마다 키 하나 'lic:<허가증 id 또는 ->:duty:<번호>:<계산 기한(orig)>' — 기한 정정은 그 회차의 날짜만 바꾸므로 키는 그대로(같은 지시의 기한만 따라감).
//   같은 회차가 30일 안 → 7일 안 → 지남으로 오르면 새 지시를 만들지 않고 그 지시의 단계(lic_stage)·제목만 올리고, 오를 때마다 담당에게 알림 1발(내려갔다 다시 오르면 그때 1발 — 지남이 매일 반복되지 않음).
//   담당 = 배정표에서 그 행 키(lic:<허가증>:duty:<번호>)의 가장 긴 접두어 담당(이번 달 탭 단추 권한 licDutyGate와 같은 줄). 없으면 만들지 않고 no_who로 센다(관리자 폴백 없음).
// 첫 회차 묶음(C117): 인허가 기한 지시가 하나도 없는 상태(지운 것 포함 — 켠 뒤 첫 실행)에서 이미 '지남'인 행들은 담당별로 '지난 기한 n건 정리' 지시 1건(lic_rows = 묶은 행·회차)으로 묶는다.
//   묶음이 열려 있는(완료·삭제 아님) 동안 그 행·회차는 행별 지시를 만들지 않는다. 그 뒤 새로 기한이 오는 행부터 행별 지시.
// 완료: _lib/doneif.js가 이 키를 읽어 그 회차 완료 기록(runs[].due = orig)·해당 없음이면 승인 대기(앱 기준)로 올린다(묶음은 묶은 행이 모두 그럴 때).
const DUTY = require('./duty');

const STAGE_TXT = { d30: '30일 안', d7: '7일 안', over: '기한 지남' };
const STAGE_RANK = { later: 0, d30: 1, d7: 2, over: 3 };
const BUNDLE_MID = ':duty:over:';
const KEY_RE = /^lic:([^:\s\x00-\x1f\x7f]{1,80}):duty:(\d{1,4}):(\d{4}-\d{2}-\d{2})$/;
const BUNDLE_RE = /^lic:-:duty:over:(\d{4}-\d{2}-\d{2}):(\d{1,3})$/;

function dutyKey(no, licId) { return 'lic:' + (licId || '-') + ':duty:' + no; }   // 배정표 줄 찾기(gw-data licDutyKey가 이 함수를 쓴다)
function taskKey(no, licId, orig) { return dutyKey(no, licId) + ':' + orig; }
function bundleKey(today, i) { return 'lic:-' + BUNDLE_MID + today + ':' + i; }
function isDutyKey(k) { const s = String(k || ''); return KEY_RE.test(s) || BUNDLE_RE.test(s); }
function parse(k) {   // → {bundle:false, lic, no, due} | {bundle:true, day, i} | null
  const s = String(k || ''); let m = BUNDLE_RE.exec(s);
  if (m) return { bundle: true, day: m[1], i: Number(m[2]) };
  m = KEY_RE.exec(s);
  return m ? { bundle: false, lic: m[1], no: Number(m[2]), due: m[3] } : null;
}
function assignFor(key, rules) {   // gw-data assignFor와 같은 규칙(가장 긴 접두어)
  const k = String(key || ''); let best = null;
  Object.keys(rules || {}).forEach(function (p) { if (k.indexOf(p) === 0 && (!best || p.length > best.length)) best = p; });
  return best ? rules[best] : null;
}
function findDuty(duties, no) { const a = Array.isArray(duties) ? duties : []; for (let i = 0; i < a.length; i++) { if (a[i] && a[i].no === no) return a[i]; } return null; }   // 앱 findDuty와 같은 비교(===)
function licOf(lics, id) { if (!id) return null; const a = Array.isArray(lics) ? lics : []; for (let i = 0; i < a.length; i++) { const l = a[i]; if (l && l.id === id && l.del !== 1) return l; } return null; }   // 앱 lmLicOf

// 행 하나의 이번 회차 — 앱 lmGroups와 같은 갈래: 의무 행 없음 = null(탭도 안 그림) · 해당 없음 = 'na' · 기한 없음(기준일·허가일·계산 못 함) = 'base' · 그 밖 = dutyStage(없으면 'later')
function rowState(r, d, lic, today) {
  if (!r || !d) return null;
  const no = r.no;
  if (d.na && d.na.on) return { no: no, stage: 'na', due: '', orig: '', days: null, fixed: false, missing: null };
  const nx = DUTY.dutyCur(Object.assign({}, d, { sched: r }), lic, today);
  if (!nx || !nx.due) return { no: no, stage: 'base', due: '', orig: '', days: null, fixed: false, missing: nx ? nx.missing : 'sched' };
  return { no: no, stage: DUTY.dutyStage(nx) || 'later', due: nx.due, orig: nx.orig, days: nx.days, fixed: !!nx.fixed, missing: null };
}
function states(rows, duties, lics, today) {
  return (Array.isArray(rows) ? rows : []).map(function (r) { return rowState(r, findDuty(duties, r.no), licOf(lics, r.lic_id), today); }).filter(Boolean);
}

function shortDuty(r) { return String((r && r.duty) || '').split('(')[0].trim().slice(0, 40) || ('의무 ' + (r && r.no)); }
function rowTitle(r, stage) { return '인허가 기한 ' + STAGE_TXT[stage] + ' — ' + r.no + '. ' + shortDuty(r); }
function rowDetail(r, s) {
  return ('기한 ' + s.due + (s.fixed ? '(정정됨 · 계산 기한 ' + s.orig + ')' : '') + (r.lic ? ' · ' + String(r.lic).slice(0, 60) : '') +
    " · 인허가 탭 '이번 달'에서 [완료+수령 올리기]로 접수번호나 수령본을 올리면 이 지시는 승인 대기로 넘어갑니다. 기한이 다르면 [기한 정정], 이 회사에 해당하지 않으면 [해당 없음].").slice(0, 500);
}
function bundleDetail(list) {
  const nos = list.map(function (x) { return x.no; }), oldest = list.reduce(function (a, x) { return !a || x.due < a ? x.due : a; }, '');
  return ('이 기능을 켠 뒤 첫 실행에서 이미 기한이 지난 ' + list.length + '건을 지시 하나로 묶었습니다(행 ' + nos.join('·') + ' — 가장 오래된 기한 ' + oldest + '). ' +
    "인허가 탭 '이번 달'의 '지남' 묶음에서 행마다 [완료+수령 올리기]·[기한 정정]·[해당 없음]으로 정리하면, 모두 정리됐을 때 이 지시가 승인 대기로 넘어갑니다. 이 지시가 열려 있는 동안 이 건들은 따로 지시가 오지 않습니다.").slice(0, 500);
}
function openish(t) { return !!(t && t.del !== 1 && (t.status === 'open' || t.status === 'hold')); }

// 계획 — input {rows(licBgOut 꼴), duties, lics, tasks, rules(배정표), names(id→이름), today}. 저장·알림 없음.
// 반환 {today, first, states, create[{key,no,stage,who_id,title,detail,due,orig}], bump[{id,no,from,to,rise,due,title}], bundles[{key,who_id,title,detail,rows[{no,due}]}], no_who[no], base[no], na[no], later[no]}
function plan(input) {
  const today = input.today, rules = input.rules || {}, rows = Array.isArray(input.rows) ? input.rows : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const byKey = {}, covered = {};
  let first = true;
  tasks.forEach(function (t) {
    if (!t || typeof t.auto_key !== 'string') return;
    const p = parse(t.auto_key); if (!p) return;
    first = false;   // 지운 것·완료 포함 — 한 번이라도 인허가 기한 지시가 있었으면 첫 실행 아님
    if (!p.bundle) { if (!byKey[t.auto_key]) byKey[t.auto_key] = t; return; }
    if (t.del === 1 || t.status === 'done') return;   // 묶음이 닫혔으면(사람이 완료·삭제) 남은 행은 행별 지시로
    (Array.isArray(t.lic_rows) ? t.lic_rows : []).forEach(function (x) { if (x && x.no != null && x.due) covered[x.no + ':' + x.due] = 1; });
  });
  const out = { today: today, first: first, states: [], create: [], bump: [], bundles: [], no_who: [], base: [], na: [], later: [] };
  const overBy = {}, whoOrder = [];
  rows.forEach(function (r) {
    const s = rowState(r, findDuty(input.duties, r.no), licOf(input.lics, r.lic_id), today);
    if (!s) return;
    out.states.push(s);
    if (s.stage === 'na') { out.na.push(s.no); return; }
    if (s.stage === 'base') { out.base.push(s.no); return; }
    const key = taskKey(s.no, r.lic_id, s.orig), have = byKey[key];
    if (have) {
      if (!openish(have)) return;   // 승인 대기·완료·삭제 = 손대지 않음
      const from = have.lic_stage && STAGE_RANK[have.lic_stage] ? have.lic_stage : 'd30';
      const to = s.stage === 'later' ? from : s.stage;   // 기한 정정으로 30일 밖이 되면 단계는 그대로 두고 기한만 따라감
      if (from !== to || have.due !== s.due) out.bump.push({ id: have.id, no: s.no, from: from, to: to, rise: STAGE_RANK[to] > STAGE_RANK[from], due: s.due, title: rowTitle(r, to) });
      return;
    }
    if (s.stage === 'later') { out.later.push(s.no); return; }
    if (covered[s.no + ':' + s.orig]) return;   // 열린 묶음 지시에 든 회차
    const a = assignFor(dutyKey(s.no, r.lic_id), rules);
    if (!a || !a.who_id) { out.no_who.push(s.no); return; }
    if (first && s.stage === 'over') {
      if (!overBy[a.who_id]) { overBy[a.who_id] = []; whoOrder.push(a.who_id); }
      overBy[a.who_id].push({ no: s.no, due: s.orig, shown: s.due });
      return;
    }
    out.create.push({ key: key, no: s.no, stage: s.stage, who_id: a.who_id, title: rowTitle(r, s.stage), detail: rowDetail(r, s), due: s.due, orig: s.orig });
  });
  whoOrder.forEach(function (w, i) {
    const list = overBy[w];
    out.bundles.push({ key: bundleKey(today, i + 1), who_id: w, title: '인허가 지난 기한 ' + list.length + '건 정리', detail: bundleDetail(list.map(function (x) { return { no: x.no, due: x.shown }; })),
      rows: list.map(function (x) { return { no: x.no, due: x.due }; }) });
  });
  return out;
}

// 적용 — tasks 배열에 넣고 고친다. mkId() = 새 지시 id. 반환 {made, bundled, bumped, redated, ids(새로 만든 id), notify{who_id:[제목]}}
function apply(p, tasks, today, names, mkId) {
  const res = { made: 0, bundled: 0, bumped: 0, redated: 0, ids: [], notify: {} };
  const nm = names || {};
  const note = function (who, line) { (res.notify[who] = res.notify[who] || []).push(line); };
  const base = function (key, who, title, detail, due) {
    return { id: mkId(), title: String(title).slice(0, 120), detail: String(detail).slice(0, 500), who_id: who, who: nm[who] || '', who_by: 'assign', scope: [],
      from: '자동', from_id: '', by: '자동', due: due || '', status: 'open', done_at: null, done_by: null, auto_key: key, created: today, updated: today };
  };
  p.bundles.forEach(function (b) {
    const t = base(b.key, b.who_id, b.title, b.detail, '');
    t.lic_rows = b.rows.map(function (x) { return { no: x.no, due: x.due }; });
    tasks.push(t); res.ids.push(t.id); res.bundled++; note(b.who_id, b.title);
  });
  p.create.forEach(function (c) {
    const t = base(c.key, c.who_id, c.title, c.detail, c.due);
    t.lic_stage = c.stage;
    tasks.push(t); res.ids.push(t.id); res.made++; note(c.who_id, c.title + ' ~' + c.due);
  });
  const byId = {}; tasks.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
  p.bump.forEach(function (b) {
    const t = byId[b.id]; if (!openish(t)) return;
    if (t.due !== b.due) { t.due = b.due; res.redated++; }
    if ((t.lic_stage || 'd30') !== b.to) { t.lic_stage = b.to; t.title = String(b.title).slice(0, 120); }
    t.updated = today;
    if (b.rise) { res.bumped++; if (t.who_id && t.who_id !== '__all__') note(t.who_id, t.title + ' ~' + t.due); }
  });
  return res;
}

// 평일(월~금) — 정기업무 봇(appdata autotask.yml '10 23 * * 0-4' UTC = KST 월~금 08:10)이 도는 날. 공휴일은 모른다(봇도 돈다).
function isRunDay(day) { const p = DUTY.dutyParse(day); if (!p) return false; const w = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); return w >= 1 && w <= 5; }
// 미리 세기 — 오늘부터 days일 동안 봇이 도는 날마다 plan·apply를 되풀이(아무도 완료·정정하지 않는다고 봄). 반환 [{day, bundles[{n, nos}], create[{no, stage, due}], rise[{no, to}]}](생긴 날만)
function forecast(input, days) {
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map(function (t) { return JSON.parse(JSON.stringify(t)); });
  const out = []; let n = 0;
  for (let k = 0; k < days; k++) {
    const day = DUTY.dutyAddDays(input.today, k);
    if (!isRunDay(day)) continue;
    const p = plan(Object.assign({}, input, { today: day, tasks: tasks }));
    const ev = { day: day, bundles: p.bundles.map(function (b) { return { n: b.rows.length, nos: b.rows.map(function (x) { return x.no; }) }; }),
      create: p.create.map(function (c) { return { no: c.no, stage: c.stage, due: c.due }; }), rise: p.bump.filter(function (b) { return b.rise; }).map(function (b) { return { no: b.no, to: b.to }; }) };
    apply(p, tasks, day, {}, function () { n++; return 'sim' + n; });
    if (ev.bundles.length || ev.create.length || ev.rise.length) out.push(ev);
  }
  return out;
}
// 연습 모드 요약(it:autotask:dry rules.lic_duty — 관리자 화면·PM 콘솔이 읽음). 사람 이름 없음(담당은 id만 · 화면이 이름으로 바꿈). 의무 이름은 짧게.
function drySummary(input, days) {
  const p = plan(input), f = forecast(input, days || 60);
  const whoN = {}; p.bundles.forEach(function (b) { whoN[b.who_id] = (whoN[b.who_id] || 0) + 1; }); p.create.forEach(function (c) { whoN[c.who_id] = (whoN[c.who_id] || 0) + 1; });
  let ahead = 0, rises = 0; f.forEach(function (e) { if (e.day !== input.today) { ahead += e.create.length; rises += e.rise.length; } });
  return { today: input.today, first: p.first, rows: p.states.length,
    now: { bundles: p.bundles.map(function (b) { return { who_id: b.who_id, n: b.rows.length, nos: b.rows.map(function (x) { return x.no; }) }; }), create: p.create.map(function (c) { return { no: c.no, stage: c.stage, due: c.due, who_id: c.who_id }; }), bump: p.bump.length },
    who: Object.keys(whoN).map(function (k) { return { id: k, n: whoN[k] }; }),
    no_who: p.no_who, base: p.base, na: p.na,
    ahead: { days: days || 60, create: ahead, rise: rises, list: f.filter(function (e) { return e.day !== input.today; }).slice(0, 20).map(function (e) { return { day: e.day, nos: e.create.map(function (c) { return c.no; }), stage: e.create.map(function (c) { return c.stage; }), rise: e.rise.map(function (x) { return x.no; }) }; }) } };
}

module.exports = { STAGE_TXT, STAGE_RANK, KEY_RE, BUNDLE_RE, dutyKey, taskKey, bundleKey, isDutyKey, parse, assignFor, findDuty, licOf, rowState, states, rowTitle, plan, apply, isRunDay, forecast, drySummary };
