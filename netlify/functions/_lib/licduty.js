'use strict';
// P1 판20(원장 T179·C117 · 착수설명서 판20 · 업무별 설계 3-8 A3) 인허가 의무 기한 → 담당 자동 지시. 순수 함수(저장·알림 없음) — servertest P1 판20 대상.
// 판정 한 곳: rowState = 인허가 '이번 달' 탭(index.html @lic-month 구간 lmGroups·lmNext)과 같은 계산 — 같은 _lib/duty.js dutyCur(앱 DUTY_SHARED와 글자째 같은 본문)·dutyStage,
//   같은 입력(서버 lic_month_get이 내리는 licBgOut 칸을 sched로 · 의무 대장 행 · 허가증)으로 묶음(지남·7일 안·30일 안·기준일 없음·그 뒤·해당 없음)과 기한을 낸다.
//   uismoke P1 판20이 같은 표본·여러 날짜에서 탭 묶음·기한과 이 결과를 대조한다(한 번이라도 다르면 실패).
// 지시: 행·회차마다 키 하나 'lic:<허가증 id 또는 ->:duty:<번호>:<계산 기한(orig)>' — 기한 정정은 그 회차의 날짜만 바꾸므로 키는 그대로(같은 지시의 기한만 따라감).
//   같은 회차가 30일 안 → 7일 안 → 지남으로 오르면 새 지시를 만들지 않고 그 지시의 단계(lic_stage)·제목만 올리고, 오를 때마다 담당에게 알림 1발(내려갔다 다시 오르면 그때 1발 — 지남이 매일 반복되지 않음).
//   담당 = 배정표에서 그 행 키(lic:<허가증>:duty:<번호>)의 가장 긴 접두어 담당(이번 달 탭 단추 권한 licDutyGate와 같은 줄). 없거나 재직자가 아니면 만들지 않고 no_who로 센다(관리자 폴백 없음).
//   열린 지시는 배정표 담당이 바뀌면 다음 실행에서 새 담당으로 옮긴다(판20 검토 B2 — 사람이 바꾼 담당은 그대로). 허가증 id의 ':'·빈칸은 키 안에서 %XX(keyId).
//   기한 계산(_lib/duty.js)은 판20 검토 A부터 기록 없는 회차를 DUTY_FROM 뒤로는 해가 바뀌어도 지우지 않는다 — 지난 회차가 닫힐 때까지 같은 지시가 남는다.
// 첫 회차 묶음(C117): 인허가 기한 지시가 하나도 없는 상태(지운 것 포함 — 켠 뒤 첫 실행)에서 이미 '지남'인 행들은 담당별로 '지난 기한 n건 정리' 지시 1건(lic_rows = 묶은 행·회차)으로 묶는다.
//   묶음이 열려 있는(완료·삭제 아님) 동안 그 행·회차는 행별 지시를 만들지 않는다. 그 뒤 새로 기한이 오는 행부터 행별 지시.
// 완료: _lib/doneif.js가 이 키를 읽어 그 회차 완료 기록(runs[].due = orig)·해당 없음이면 승인 대기(앱 기준)로 올린다(묶음은 묶은 행이 모두 그럴 때).
const DUTY = require('./duty');

const STAGE_TXT = { d30: '30일 안', d7: '7일 안', over: '지남', later: '30일 밖' };   // later = 기한 정정으로 30일 밖이 된 열린 지시의 제목
const STAGE_RANK = { later: 0, d30: 1, d7: 2, over: 3 };
const BUNDLE_MID = ':duty:over:';
const KEY_RE = /^lic:([^:\s\x00-\x1f\x7f]{1,160}):duty:(\d{1,4}):(\d{4}-\d{2}-\d{2})$/;
const BUNDLE_RE = /^lic:-:duty:over:(\d{4}-\d{2}-\d{2}):(\d{1,3})$/;
function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

// 허가증 id를 키 한 칸으로 — ':'·'%'·빈칸·제어문자는 %XX로(키 꼴이 깨지지 않게 · 판20 검토 B5). 보통 id(영문·숫자·한글)는 그대로라 지금 배정표 줄('lic:' 접두어)과 같다. 없으면 '-'.
function keyId(id) {
  const s = String(id == null ? '' : id);
  return s ? s.replace(/[%:\s\x00-\x1f\x7f]/g, function (c) { const h = c.charCodeAt(0).toString(16).toUpperCase(); return '%' + (h.length < 2 ? '0' + h : h); }) : '-';
}
function dutyKey(no, licId) { return 'lic:' + keyId(licId) + ':duty:' + no; }   // 배정표 줄 찾기(gw-data licDutyKey가 이 함수를 쓴다)
function taskKey(no, licId, orig) { return dutyKey(no, licId) + ':' + orig; }
function bundleKey(today, i) { return 'lic:-' + BUNDLE_MID + today + ':' + i; }
function isDutyKey(k) { const s = typeof k === 'string' ? k : ''; return KEY_RE.test(s) || BUNDLE_RE.test(s); }
function parse(k) {   // → {bundle:false, lic, no, due} | {bundle:true, day, i} | null
  const s = typeof k === 'string' ? k : ''; let m = BUNDLE_RE.exec(s);
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
  if (d.na && d.na.on) return { no: no, stage: 'na', due: '', orig: '', days: null, fixed: false, missing: null, ahead: [] };
  const nx = DUTY.dutyCur(Object.assign({}, d, { sched: r }), lic, today);
  if (!nx || !nx.due) return { no: no, stage: 'base', due: '', orig: '', days: null, fixed: false, missing: nx ? nx.missing : 'sched', ahead: [] };
  // 판20 재검토 1: ahead = 지금 회차가 지났을 때 그 뒤로 30일 안에 들어왔거나 지난 회차(dutyCur — 탭 '다음 회차' 작은 글과 같은 값)
  const ahead = (nx.ahead || []).map(function (a) { return { due: a.due, days: a.days, stage: DUTY.dutyStage(a) }; });
  return { no: no, stage: DUTY.dutyStage(nx) || 'later', due: nx.due, orig: nx.orig, days: nx.days, fixed: !!nx.fixed, missing: null, ahead: ahead };
}
// '다음 회차' 한 줄 — 지시 글 끝(NEXT_SEP 뒤)에 붙임. 날마다 바뀌지 않게 날짜 + 단계 말만(일수 안 씀)
const NEXT_SEP = '\n※ ';
function aheadLine(items) {
  return items.map(function (x) { const p = DUTY.dutyParse(x.due); return x.no + '행 다음 회차 기한 ' + (p ? p.m + '월 ' + p.d + '일' : x.due) + (x.stage === 'over' ? '도 지났습니다' : '도 다가옵니다(' + STAGE_TXT[x.stage] + ')'); }).join(' · ');
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
// 판20b(원장 C187 ②) 다시 엶: 이번 달 탭에 그 회차 완료·해당 없음 기록이 없는데 지시만 닫히거나(완료 승인) 지워졌으면 다음 실행에서 그 지시를 다시 연다.
//   지금 회차 지시가 닫힌 채면 그 행은 단계 오름·다음 회차 알림이 붙을 곳이 없어 조용해진다(탭은 계속 '지남') — 지시를 지우는 것 자체는 막지 않는다.
//   안 여는 때: 승인 대기(담당이 손으로 [완료] → 승인권자 대기) · 30일 밖 · 같은 날 이미 엶 · 한 번 연 뒤 다시 닫혔는데 단계(지금 회차·다음 회차)가 오르지 않음.
function reopenNeed(t, s, aheadItems, today) {
  if (t.del !== 1 && t.status === 'review') return false;
  if (s.stage === 'later') return false;
  const ro = (t.lic_reopen && typeof t.lic_reopen === 'object') ? t.lic_reopen : null;
  if (ro && ro.day === today) return false;
  if (!ro) return true;
  if (STAGE_RANK[s.stage] > (STAGE_RANK[t.lic_stage] || 0)) return true;
  const nx = (t.lic_next && typeof t.lic_next === 'object') ? t.lic_next : {};
  return aheadItems.some(function (x) { return STAGE_RANK[x.stage] > (STAGE_RANK[nx[x.no + ':' + x.due]] || 0); });
}
function reopenTxt(day) { const p = DUTY.dutyParse(day); return '(' + (p ? p.m + '/' + p.d : day) + ' 다시 열림 — 이번 달 탭에 이 회차 완료 기록이 없어 지시만 닫을 수 없습니다. 탭에서 [완료+수령 올리기]나 [해당 없음]으로 닫아야 끝납니다.)'; }
const REOPEN_RE = / ?\(\d{1,2}\/\d{1,2} 다시 열림 — [^)]*\)/g;
// 판20b: 지시의 다음 회차 기록(lic_next '행:기한')이 닫힌 회차인지 — 그 행이 해당 없음 · 그 회차 완료 기록 있음 · 그 행 지금 회차보다 이른 회차(cur = plan이 낸 행별 지금 회차·완료 회차)
function nextClosed(cur, k) {
  const m = /^(\d{1,4}):(\d{4}-\d{2}-\d{2})$/.exec(String(k)); if (!m || !cur) return false;
  const c = cur[m[1]]; if (!c) return false;
  return !!(c.na || c.runs[m[2]] || (c.orig && m[2] < c.orig));
}

// 계획 — input {rows(licBgOut 꼴), duties, lics, tasks, rules(배정표), names(id→이름), active(재직 id 표 — 있으면 그 밖 담당 = 담당 없음), today}. 저장·알림 없음.
// 반환 {today, first, states, create[{key,no,stage,who_id,title,detail,due,orig}], bump[{id,no,from,to,rise,due,title}], move[{id,no,from,to}], bundles[{key,who_id,title,detail,rows[{no,due}]}], no_who[no], base[no], na[no], later[no]}
function plan(input) {
  const today = input.today, rules = input.rules || {}, rows = Array.isArray(input.rows) ? input.rows : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [], act = input.active && typeof input.active === 'object' ? input.active : null;
  const okWho = function (id) { return !!id && id !== '__all__' && (!act || hasOwn(act, id)); };
  const target = function (no, licId) { const a = assignFor(dutyKey(no, licId), rules); return a && okWho(a.who_id) ? a.who_id : ''; };   // 배정표 그 행 담당(재직자만)
  const byKey = {}, covered = {}, openBundles = [], seenNext = {};
  let first = true;
  tasks.forEach(function (t) {
    if (!t || typeof t.auto_key !== 'string') return;
    const p = parse(t.auto_key); if (!p) return;
    first = false;   // 지운 것·완료 포함 — 한 번이라도 인허가 기한 지시가 있었으면 첫 실행 아님
    // 판20b: 어느 지시(닫힌 것·지운 것 포함)든 '다음 회차' 줄로 이미 알린 단계 — 그 회차가 지금 회차가 되어 행별 지시가 생길 때 같은 단계 알림을 또 보내지 않게
    if (t.lic_next && typeof t.lic_next === 'object') Object.keys(t.lic_next).forEach(function (k) { const v = t.lic_next[k]; if (hasOwn(STAGE_RANK, v) && STAGE_RANK[v] > (STAGE_RANK[seenNext[k]] || 0)) seenNext[k] = v; });
    if (!p.bundle) { if (!byKey[t.auto_key]) byKey[t.auto_key] = t; return; }
    if (t.del === 1 || t.status === 'done') return;   // 묶음이 닫혔으면(사람이 완료·삭제) 남은 행은 행별 지시로
    if (openish(t)) openBundles.push(t);
    (Array.isArray(t.lic_rows) ? t.lic_rows : []).forEach(function (x) { if (x && x.no != null && x.due) covered[x.no + ':' + x.due] = t; });
  });
  const out = { today: today, first: first, states: [], create: [], bump: [], move: [], bundles: [], ahead: [], no_who: [], base: [], na: [], later: [], reopen: [], cur: {}, seen: seenNext };
  const aheadOf = function (s) { return s.stage === 'over' ? s.ahead.map(function (a) { return { no: s.no, due: a.due, stage: a.stage }; }) : []; };
  // 열린 지시의 담당 따라가기(판20 검토 B2): 배정표 담당이 바뀌면 새 담당으로 · 담당이 재직자가 아니고 배정표에도 재직 담당이 없으면 비움('담당 없음').
  //   사람이 지시 창에서 바꾼 담당(who_by 'edit')·[내 것 아님]으로 빠진 같은 사람에게는 되돌리지 않는다(종전 배정 채움과 같은 원칙).
  const follow = function (t, tw, no) {
    if (t.who_by === 'edit') return;
    if (tw) { if (t.who_id !== tw && !(t.who_by === 'notmine' && t.notmine && t.notmine.prev === tw)) out.move.push({ id: t.id, no: no, from: t.who_id || '', to: tw }); return; }
    if (t.who_id && act && !hasOwn(act, t.who_id)) out.move.push({ id: t.id, no: no, from: t.who_id, to: '' });
  };
  const rowByNo = {}; rows.forEach(function (r) { if (r && r.no != null) rowByNo[r.no] = r; });
  openBundles.forEach(function (t) {
    const x0 = (Array.isArray(t.lic_rows) ? t.lic_rows : [])[0], r0 = x0 ? rowByNo[x0.no] : null;
    if (!r0) return;
    const tw = target(r0.no, r0.lic_id);
    if (!tw) out.no_who.push(r0.no);
    follow(t, tw, r0.no);
  });
  const overBy = {}, whoOrder = [];
  rows.forEach(function (r) {
    const s = rowState(r, findDuty(input.duties, r.no), licOf(input.lics, r.lic_id), today);
    if (!s) return;
    out.states.push(s);
    // 판20b: 행별 지금 회차·완료 회차 — apply가 지시의 다음 회차 기록(lic_next)에서 닫힌 회차를 걷을 때 씀
    out.cur[s.no] = { na: s.stage === 'na', orig: s.orig, runs: DUTY.dutyDoneSet(findDuty(input.duties, r.no)) };
    if (s.stage === 'na') { out.na.push(s.no); return; }
    if (s.stage === 'base') { out.base.push(s.no); return; }
    const key = taskKey(s.no, r.lic_id, s.orig), have = byKey[key];
    if (have) {
      if (!openish(have)) {
        // 판20b: 탭 기록 없이 닫히거나 지워진 지금 회차 지시 = 다시 엶(reopenNeed) · 그 밖(승인 대기 등)은 손대지 않음
        if (!reopenNeed(have, s, aheadOf(s), today)) return;
        if (!target(s.no, r.lic_id)) { out.no_who.push(s.no); return; }
        out.reopen.push({ id: have.id, no: s.no, stage: s.stage });
      }
      const from = have.lic_stage && STAGE_RANK[have.lic_stage] ? have.lic_stage : 'd30';
      const to = s.stage === 'later' ? from : s.stage;   // 기한 정정으로 30일 밖이 되면 단계는 그대로(다시 오를 때 알림 1)·제목은 '30일 밖'·기한은 따라감
      const ti = rowTitle(r, s.stage === 'later' ? 'later' : to);
      if (from !== to || have.due !== s.due || have.title !== ti) out.bump.push({ id: have.id, no: s.no, from: from, to: to, rise: STAGE_RANK[to] > STAGE_RANK[from], due: s.due, title: ti });
      const tw = target(s.no, r.lic_id);
      if (!tw) out.no_who.push(s.no);
      follow(have, tw, s.no);
      out.ahead.push({ id: have.id, items: aheadOf(s) });   // 판20 재검토 1: 그 행 열린 지시에 '다음 회차' 줄(없으면 빈 목록 = 줄 지움)
      return;
    }
    if (s.stage === 'later') { out.later.push(s.no); return; }
    const cb = covered[s.no + ':' + s.orig];
    if (cb) { if (openish(cb)) out.ahead.push({ id: cb.id, items: aheadOf(s) }); return; }   // 열린 묶음 지시에 든 회차 — '다음 회차' 줄은 그 묶음에
    const tw = target(s.no, r.lic_id);
    if (!tw) { out.no_who.push(s.no); return; }   // 배정표에 없거나 재직자가 아님 — 만들지 않음(관리자 폴백 없음)
    if (first && s.stage === 'over') {
      if (!overBy[tw]) { overBy[tw] = []; whoOrder.push(tw); }
      overBy[tw].push({ no: s.no, due: s.orig, shown: s.due, ahead: aheadOf(s) });
      return;
    }
    out.create.push({ key: key, no: s.no, stage: s.stage, who_id: tw, title: rowTitle(r, s.stage), detail: rowDetail(r, s), due: s.due, orig: s.orig, ahead: aheadOf(s) });
    // 판20b: 이 회차가 '다음 회차' 줄로 이미 같은 단계(이상) 알림을 받았으면 지시는 만들되 알림은 다시 안 보냄(단계 기록 이어받음)
    const seen = seenNext[s.no + ':' + s.orig];
    if (seen && STAGE_RANK[seen] >= STAGE_RANK[s.stage]) out.create[out.create.length - 1].quiet = true;
  });
  whoOrder.forEach(function (w, i) {
    const list = overBy[w];
    out.bundles.push({ key: bundleKey(today, i + 1), who_id: w, title: '인허가 지난 기한 ' + list.length + '건 정리', detail: bundleDetail(list.map(function (x) { return { no: x.no, due: x.shown }; })),
      rows: list.map(function (x) { return { no: x.no, due: x.due }; }), ahead: list.reduce(function (a, x) { return a.concat(x.ahead); }, []) });
  });
  out.no_who = out.no_who.filter(function (v, i, a) { return a.indexOf(v) === i; });
  return out;
}

// 적용 — tasks 배열에 넣고 고친다. mkId() = 새 지시 id. 반환 {made, bundled, bumped, redated, moved, changed, ids(새로 만든 id), notify{who_id:[제목]}}
//   알림 줄 = 새 지시(묶음·행별) · 새 담당으로 옮긴 지시 · 단계가 오른 지시(옮긴 뒤의 담당에게) — 같은 지시는 한 줄.
//   판20b: nowMs(선택) = 다시 연 지시의 updated_ts(앱 병합이 직원의 지운 사본보다 이 열림을 늦은 것으로 보게) · 다시 연 지시 = res.reopened·알림 줄 '다시 엶 n행 — …'
function apply(p, tasks, today, names, mkId, nowMs) {
  const res = { made: 0, bundled: 0, bumped: 0, redated: 0, moved: 0, changed: 0, next_rise: 0, next: [], ids: [], notify: {}, reopened: 0 };
  const nm = names || {}, noted = {};
  const note = function (who, id, line) { if (!who || who === '__all__' || noted[id]) return; noted[id] = 1; (res.notify[who] = res.notify[who] || []).push(line); };
  // 판20 재검토 1: 지시의 '다음 회차' 칸(lic_next {'행:기한': 단계} — 서버만 씀)·글 끝 한 줄을 맞추고, 단계가 오른 것이 있으면 true(같은 단계로 다시 안 보냄 — 기록은 지우지 않음)
  const setNext = function (t, items) {
    const nx = Object.assign({}, (t.lic_next && typeof t.lic_next === 'object') ? t.lic_next : {});
    // 판20b: 닫힌 회차(완료 기록·해당 없음·그 행 지금 회차보다 이른 회차)의 기록은 걷음 — 칸이 끝없이 쌓이지 않게
    Object.keys(nx).forEach(function (k) { if (nextClosed(p.cur, k)) delete nx[k]; });
    let rise = false;
    items.forEach(function (x) { const k = x.no + ':' + x.due, prev = nx[k]; if (prev !== x.stage) { if (STAGE_RANK[x.stage] > (STAGE_RANK[prev] || 0)) { rise = true; res.next.push({ no: x.no, due: x.due, stage: x.stage }); } nx[k] = x.stage; } });
    const base = String(t.detail || '').split(NEXT_SEP)[0], line = aheadLine(items), det = (line ? base + NEXT_SEP + line : base).slice(0, 900);
    let ch = false;
    if (Object.keys(nx).length && JSON.stringify(nx) !== JSON.stringify(t.lic_next || {})) { t.lic_next = nx; ch = true; }
    if (!Object.keys(nx).length && t.lic_next !== undefined) { delete t.lic_next; ch = true; }
    if (det !== t.detail) { t.detail = det; ch = true; }
    return { rise: rise, ch: ch, line: line };
  };
  const base = function (key, who, title, detail, due) {
    return { id: mkId(), title: String(title).slice(0, 120), detail: String(detail).slice(0, 500), who_id: who, who: nm[who] || '', who_by: 'assign', scope: [],
      from: '자동', from_id: '', by: '자동', due: due || '', status: 'open', done_at: null, done_by: null, auto_key: key, created: today, updated: today };
  };
  const byId = {}; tasks.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
  // 판20b: 다시 엶 — 옮김·단계 오름·다음 회차보다 먼저(그 셋이 열린 지시로 보게). 알림 줄은 옮긴 뒤의 담당에게(아래)
  const reo = {};
  (p.reopen || []).forEach(function (o) {
    const t = byId[o.id]; if (!t || openish(t)) return;
    t.status = 'open'; if (t.del === 1) t.del = 0;
    t.done_at = null; t.done_by = null; t.approved_by = null; t.approved_at = null; delete t.done_src;
    const ro = (t.lic_reopen && typeof t.lic_reopen === 'object') ? t.lic_reopen : {};
    t.lic_reopen = { day: today, n: (Number(ro.n) || 0) + 1 };
    const parts = String(t.detail || '').split(NEXT_SEP), b0 = parts[0].replace(REOPEN_RE, '');
    parts[0] = b0 + ' ' + reopenTxt(today);
    t.detail = parts.join(NEXT_SEP).slice(0, 900);
    t.updated = today; if (typeof nowMs === 'number') t.updated_ts = nowMs;
    reo[t.id] = o.no; res.reopened++; res.changed++;
  });
  p.move.forEach(function (m) {
    const t = byId[m.id]; if (!openish(t)) return;
    t.who_id = m.to; t.who = m.to ? (nm[m.to] || '') : ''; if (m.to) t.who_by = 'assign';
    t.updated = today; res.moved++; res.changed++;
    if (!hasOwn(reo, t.id)) note(m.to, t.id, t.title + (t.due ? ' ~' + t.due : ''));
  });
  Object.keys(reo).forEach(function (id) { const t = byId[id]; note(t.who_id, id, '다시 엶 ' + reo[id] + '행 — 탭에서 [완료+수령 올리기]로 닫아야 끝납니다'); });
  p.bump.forEach(function (b) {
    const t = byId[b.id]; if (!openish(t)) return;
    if (t.due !== b.due) { t.due = b.due; res.redated++; }
    t.lic_stage = b.to;
    t.title = String(b.title).slice(0, 120);
    t.updated = today; res.changed++;
    if (b.rise) { res.bumped++; note(t.who_id, t.id, t.title + ' ~' + t.due); }
  });
  // 열린 지시의 '다음 회차' — 같은 지시(묶음에 여러 행)는 한 번에 모아 한 줄·알림 한 줄
  const byTask = {}, order = [];
  (p.ahead || []).forEach(function (a) { if (!byTask[a.id]) { byTask[a.id] = []; order.push(a.id); } Array.prototype.push.apply(byTask[a.id], a.items); });
  order.forEach(function (id) {
    const t = byId[id]; if (!openish(t)) return;
    const r = setNext(t, byTask[id]);
    if (r.ch) { t.updated = today; res.changed++; }
    if (r.rise) { res.next_rise++; note(t.who_id, t.id, t.title + ' · ' + r.line); }
  });
  p.bundles.forEach(function (b) {
    const t = base(b.key, b.who_id, b.title, b.detail, '');
    t.lic_rows = b.rows.map(function (x) { return { no: x.no, due: x.due }; });
    if ((b.ahead || []).length) setNext(t, b.ahead);   // 처음부터 다음 회차가 걸려 있으면 그 줄을 달고(알림은 새 지시 1발에 함께)
    tasks.push(t); res.ids.push(t.id); res.bundled++; res.changed++; note(b.who_id, t.id, b.title);
  });
  p.create.forEach(function (c) {
    const t = base(c.key, c.who_id, c.title, c.detail, c.due);
    t.lic_stage = c.stage;
    if ((c.ahead || []).length) setNext(t, c.ahead);
    tasks.push(t); res.ids.push(t.id); res.made++; res.changed++;
    // 판20b: 이어받은 지시(quiet)는 다음 회차 줄에 아직 안 알린 단계가 있을 때만 알림
    const seen = p.seen || {}, loud = !c.quiet || (c.ahead || []).some(function (x) { return STAGE_RANK[x.stage] > (STAGE_RANK[seen[x.no + ':' + x.due]] || 0); });
    if (loud) note(c.who_id, t.id, c.title + ' ~' + c.due);
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
    const ar = apply(p, tasks, day, {}, function () { n++; return 'sim' + n; });
    ev.next = ar.next;   // 판20 재검토 1: 열린 지시에 걸린 다음 회차의 단계 오름(그날 알림에 들어감)
    ev.sent = Object.keys(ar.notify).length;   // 그날 담당 알림 발 수(사람별 1발)
    if (ev.bundles.length || ev.create.length || ev.rise.length || ev.next.length) out.push(ev);
  }
  return out;
}
// 연습 모드 요약(it:autotask:dry rules.lic_duty — 관리자 화면·PM 콘솔이 읽음). 사람 이름 없음(담당은 id만 · 화면이 이름으로 바꿈). 의무 이름은 짧게.
function drySummary(input, days) {
  const p = plan(input), f = forecast(input, days || 60);
  const whoN = {}; p.bundles.forEach(function (b) { whoN[b.who_id] = (whoN[b.who_id] || 0) + 1; }); p.create.forEach(function (c) { whoN[c.who_id] = (whoN[c.who_id] || 0) + 1; });
  let ahead = 0, rises = 0; f.forEach(function (e) { if (e.day !== input.today) { ahead += e.create.length; rises += e.rise.length + e.next.length; } });
  return { today: input.today, first: p.first, rows: p.states.length,
    now: { bundles: p.bundles.map(function (b) { return { who_id: b.who_id, n: b.rows.length, nos: b.rows.map(function (x) { return x.no; }) }; }), create: p.create.map(function (c) { return { no: c.no, stage: c.stage, due: c.due, who_id: c.who_id }; }), bump: p.bump.length },
    who: Object.keys(whoN).map(function (k) { return { id: k, n: whoN[k] }; }),
    no_who: p.no_who, base: p.base, na: p.na,
    ahead: { days: days || 60, create: ahead, rise: rises, list: f.filter(function (e) { return e.day !== input.today; }).slice(0, 20).map(function (e) { return { day: e.day, nos: e.create.map(function (c) { return c.no; }), stage: e.create.map(function (c) { return c.stage; }), rise: e.rise.map(function (x) { return x.no; }).concat(e.next.map(function (x) { return x.no; })) }; }) } };
}

module.exports = { STAGE_TXT, STAGE_RANK, KEY_RE, BUNDLE_RE, keyId, dutyKey, taskKey, bundleKey, isDutyKey, parse, assignFor, findDuty, licOf, rowState, states, rowTitle, plan, apply, isRunDay, forecast, drySummary };
