'use strict';
// C185 판1(범위 밖 자동 지시 규칙 — 09_조사_문서/45_Phase1_자료_20261113/C185_자료_1119/C185_착수계획_1119.md ⓑ·「지도 표에 없던 새 자리」) 서버가 세는 규칙 5줄의 공통 틀.
//   순수 함수(저장소·명부·알림 없음): 규칙 표(읽을 입력 · 켠 시각이 필요한지 · 옛 지시 표시 종류 · 계획 함수 자리) · 새 키 꼴(한 곳 — 실행기·저장 보호가 같이 씀) ·
//   실행 run(사건 10건 막이 · 끼워 넣은 값만 명부 이름 대조 · 담당 = 배정표 가장 긴 접두어의 재직자 · 옛 지시 표시 붙이기·떼기) · 연습 요약 꼴.
//   입력은 gw-data.js evInput이 한 번 모아 넘긴다. ingest(write = 적용)와 dry_put(요약만)이 같은 계획 함수를 쓴다(판20 LD.plan·LD.drySummary와 같은 구조).
//   계획 함수(plan)는 판2~6이 채운다. plan이 없는 규칙 = '준비 중' — 서버가 live 스위치를 400 RULE_NOT_READY로 거절하고 실행기가 돌리지 않는다.
//
// 계획 함수 꼴(판2~6이 지킬 것): plan(input, ctx) → {
//   events: [{ subj, tasks: [{ key, title, detail, due, vals: [끼워 넣은 값 글자 — 날짜·차번호·대장 연번·건수], priv: 참이면 공개 범위 = 담당 }] }],   // 지금 자료로 '있어야 할' 지시 전부(이미 있는 키는 실행이 건너뜀)
//   subjects: { <주체 id>: [지금 맞는 키…] },   // 찾은 주체(직원·차)만 — 여기 없는 주체의 지시는 표시를 붙이지도 떼지도 않음
//   old: n, no_row: ['근거 행 id'…], ref: { 업무 수만 }, skip: '' }
//   input = { members, vehicles, sites, contracts, hrbg, vehbg, assign, tasks } 가운데 그 규칙 needs 칸 · ctx = { mode: 'live'|'dry', today, since, since_day, win }
//   글(title·detail)에 직원 이름·생년월일·연락처를 넣지 않는다 — 실행이 vals를 명부 이름과 대조해 하나라도 걸리면 그 규칙을 그 실행에 0건(skip 'PII').
const AR = require('./autorules');

const ID = '[^:\\s\\x00-\\x1f\\x7f]{1,80}';   // gw-data AUTOTASK_ID와 같은 꼴(콜론·공백·제어문자만 뺌)
const DATE = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';
// 새 키 꼴 — 만드는 곳은 서버 실행기 하나(앱·봇은 만들지 않음). 봇이 보내면 gw-data AUTOTASK_KEY_RE 밖이라 unknown으로 막힌다.
const KEY_RE = {
  hr: new RegExp('^hr:(' + ID + '):(join|leave):(' + DATE + '):([1-8])$'),        // 입사·퇴사 체크(인사) — 판2·3
  acct: new RegExp('^acct:(' + ID + '):(join|leave):(' + DATE + ')$'),             // 입사·퇴사 계정 — 판2·3
  ks: /^ks:(\d{4})$/,                                                              // 현장 실적 신고(연 1회) — 판5
  vehEv: new RegExp('^veh:(' + ID + '):ev:(sold|dereg):(' + DATE + '):(main|waste)$'),   // 차량 매각·말소 — 판6
};
// 저장 보호용 넓은 꼴 — 접두어가 같으면 꼴이 조금 달라도 앱 저장이 새로 달 수 없다(꼴만 살짝 바꿔 비켜 가는 길 막음)
const LIKE_RE = /^(?:hr|acct|ks):|^veh:[^:]*:ev:/;
function isEvKey(k) { const s = typeof k === 'string' ? k : ''; return KEY_RE.hr.test(s) || KEY_RE.acct.test(s) || KEY_RE.ks.test(s) || KEY_RE.vehEv.test(s); }
function isEvLike(k) { return typeof k === 'string' && LIKE_RE.test(k); }
function ruleOfKey(k) {   // 새 꼴 키 → 규칙 id(옛 지시 표시를 붙일 대상 고르기) · 아니면 ''(veh_ceq31은 기존 정기검사 키를 써서 여기 없음)
  const s = typeof k === 'string' ? k : ''; let m;
  if ((m = KEY_RE.hr.exec(s)) || (m = KEY_RE.acct.exec(s))) return m[2] === 'join' ? 'hr_join' : 'hr_leave';
  if (KEY_RE.ks.test(s)) return 'ks_report';
  if (KEY_RE.vehEv.test(s)) return 'veh_event';
  return '';
}
function subjOf(k) {   // 키 → 주체 id(직원·차·연도)
  const s = typeof k === 'string' ? k : ''; let m;
  if ((m = KEY_RE.hr.exec(s)) || (m = KEY_RE.acct.exec(s)) || (m = KEY_RE.vehEv.exec(s)) || (m = KEY_RE.ks.exec(s))) return m[1];
  return '';
}

// 규칙 표 — 순서 = 화면 순서. needs = 그 규칙이 읽는 입력(실행에 늘 필요한 배정표·명부는 needsOf가 더함) · since = 켠 시각 뒤의 사건만 세는 규칙(없으면 NO_SINCE) · mark = 옛 지시 표시 종류
const RULES = {
  hr_join: { needs: ['members', 'hrbg'], since: true, mark: 'date', plan: null },
  hr_leave: { needs: ['members', 'hrbg'], since: true, mark: 'date', plan: null },
  veh_ceq31: { needs: ['vehicles', 'vehbg'], since: false, mark: '', plan: null },
  ks_report: { needs: ['sites', 'contracts'], since: false, mark: '', plan: null },
  veh_event: { needs: ['vehicles', 'vehbg'], since: true, mark: 'state', plan: null },
};
const RULE_IDS = Object.keys(RULES);
const BASE_NEEDS = ['assign', 'members'];
const CAP = 10;        // 한 규칙이 한 실행에 새로 만들 사건(사람·차·묶음) 상한 — 넘으면 그 실행 0건 + skip TOO_MANY(켠 시각이 잘못됐을 때의 안전판)
const DRY_WIN = 30;    // 연습 요약 = 최근 30일에 생긴 사건을 켰다면(보여 주기용)
const DAY = 86400000;
function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function ready(id) { return hasOwn(RULES, id) && typeof RULES[id].plan === 'function'; }
function needsOf(id) { const o = {}; BASE_NEEDS.concat(hasOwn(RULES, id) ? RULES[id].needs : []).forEach(function (n) { o[n] = 1; }); return Object.keys(o); }
function kstDay(ms) { return new Date(Number(ms) + 9 * 3600000).toISOString().slice(0, 10); }
function isDate(s) { return typeof s === 'string' && new RegExp('^' + DATE + '$').test(s); }
// 실행 맥락 — live: 켠 시각 since(ms) · 켠 날 since_day(KST) / dry: 지금 − 30일을 켠 시각으로 본다. since가 필요한 규칙인데 없으면 skip NO_SINCE
function ctxFor(id, mode, sinceMs, nowMs, today) {
  if (mode === 'live') {
    const s = Number(sinceMs);
    if (RULES[id] && RULES[id].since && !(isFinite(s) && s > 0)) return { skip: 'NO_SINCE' };
    return { ctx: { mode: 'live', today: today, since: s > 0 ? s : 0, since_day: s > 0 ? kstDay(s) : '', win: 0 } };
  }
  const s0 = Number(nowMs) - DRY_WIN * DAY;
  return { ctx: { mode: 'dry', today: today, since: s0, since_day: kstDay(s0), win: DRY_WIN } };
}
// 연습 요약 꼴(it:autotask:dry.rules.<규칙>) — 사람 이름·회원 id 없음(담당 id만 — 화면이 이름으로 바꿈) · ms 시각 같은 긴 숫자 없음(AR.piiScan 전화 꼴에 우연히 걸리지 않게)
function emptySum(mode) { return { mode: mode, ready: true, win: mode === 'dry' ? DRY_WIN : 0, events: 0, tasks: 0, who: [], no_who: 0, no_due: 0, marked: 0, unmarked: 0, gone: 0, old: 0, no_row: [], skip: '', ref: {} }; }
function skipSum(mode, why) { const s = emptySum(mode); s.skip = String(why || 'ERROR').slice(0, 40); return s; }
function notReadySum(mode) { return { mode: mode, ready: false }; }
function cnt(v) { const n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }
function refOf(r) { const o = {}; if (r && typeof r === 'object') Object.keys(r).slice(0, 20).forEach(function (k) { if (/^[a-z][a-z0-9_]{0,30}$/.test(k)) o[k] = cnt(r[k]); }); return o; }

// 옛 지시 표시 — 실행 때마다 다시 판정(검토 3): 주체의 지금 날짜·상태와 맞지 않는 열린 지시 = 제목 앞 머리 글자 + 본문 끝 까닭 한 줄 · 다시 맞으면 서버가 붙인 그대로일 때만 뗌
const MARK = { date: '[날짜 바뀜 — 확인 뒤 지우기] ', state: '[상태 바뀜 — 확인 뒤 지우기] ' };
const MARK_WHY = { date: '※ 날짜가 바뀌어 지금 기록과 맞지 않는 지시입니다 — 맞는 지시가 따로 있는지 확인한 뒤 이 지시를 지워 주세요.',
  state: '※ 상태가 바뀌어 지금 기록과 맞지 않는 지시입니다 — 확인한 뒤 이 지시를 지워 주세요.' };
function markedKind(t) { const ti = String((t && t.title) || ''); return ti.indexOf(MARK.date) === 0 ? 'date' : (ti.indexOf(MARK.state) === 0 ? 'state' : ''); }
function markTask(t, kind, today) {
  t.title = MARK[kind] + String(t.title || '');
  const d = String(t.detail || '');
  if (d.indexOf(MARK_WHY[kind]) < 0) t.detail = (d ? d + '\n' : '') + MARK_WHY[kind];
  t.updated = today;
}
function unmarkTask(t, kind, today) {
  t.title = String(t.title || '').slice(MARK[kind].length);
  const d = String(t.detail || ''), w = MARK_WHY[kind];
  let i = d.lastIndexOf('\n' + w);
  if (i >= 0) t.detail = d.slice(0, i) + d.slice(i + 1 + w.length);
  else if ((i = d.indexOf(w)) >= 0) t.detail = d.slice(0, i) + d.slice(i + w.length);
  t.updated = today;
}
function assignFor(k, rules) {   // gw-data assignFor와 같은 판정(가장 긴 접두어)
  let best = null;
  Object.keys(rules || {}).forEach(function (p) { if (k.indexOf(p) === 0 && (!best || p.length > best.length)) best = p; });
  return best ? rules[best] : null;
}

// 실행 — 한 규칙. write = 참이면 tasks(지시 배열)에 새 지시를 넣고 표시를 붙이고 뗀다 · 거짓이면 수만(연습 요약 · live 규칙의 미리 보기)
//   opt = { rules: 배정표(엄격 읽기), active: { 재직 회원 id: 이름 }, names: [명부 이름 전부 — 퇴사 포함], mkId: fn }
//   반환 { sum, made: [새 지시], changed: 바뀐 지시 수, txt: 감사 한 줄 조각(수만) }
function run(id, input, ctx, tasks, opt, write) {
  const R = RULES[id], sum = emptySum(ctx.mode), out = { sum: sum, made: [], changed: 0, txt: '' };
  tasks = Array.isArray(tasks) ? tasks : [];
  opt = opt || {};
  if (!R || typeof R.plan !== 'function') { out.sum = notReadySum(ctx.mode); return out; }
  let p;
  try { p = R.plan(input || {}, ctx) || {}; } catch (e) { sum.skip = 'ERROR'; out.txt = id + ' 건너뜀(ERROR)'; return out; }
  sum.old = cnt(p.old);
  sum.no_row = (Array.isArray(p.no_row) ? p.no_row : []).map(function (x) { return String(x).slice(0, 40); }).slice(0, 20);
  sum.ref = refOf(p.ref);
  if (p.skip) { sum.skip = String(p.skip).slice(0, 40); out.txt = id + ' 건너뜀(' + sum.skip + ')'; return out; }
  const have = {};
  tasks.forEach(function (t) { if (t && t.auto_key) (have[t.auto_key] || (have[t.auto_key] = [])).push(t); });
  const alive = function (k) { return (have[k] || []).some(function (t) { return t.del !== 1; }); };
  const active = opt.active || {}, plans = [];
  (Array.isArray(p.events) ? p.events : []).forEach(function (ev) {
    const mk = [], seen = {};
    ((ev && Array.isArray(ev.tasks)) ? ev.tasks : []).forEach(function (x) {
      const k = String((x && x.key) || '');
      if (!k || seen[k]) return; seen[k] = 1;
      if (have[k]) { if (!alive(k)) sum.gone++; return; }   // 지운 지시의 키도 '있음' — 서버가 되살리지 않고 수만(gone)
      const r = assignFor(k, opt.rules), who = r && r.who_id ? String(r.who_id) : '';
      if (!who || !hasOwn(active, who)) { sum.no_who++; return; }   // 담당 없음·재직자 아님 = 만들지 않음(관리자 폴백 없음)
      mk.push({ x: x, k: k, who: who });
    });
    if (mk.length) plans.push(mk);
  });
  sum.events = plans.length;
  if (plans.length > CAP) { sum.skip = 'TOO_MANY'; out.txt = id + ' 멈춤(사건 ' + plans.length + ' > ' + CAP + ')'; return out; }
  // 글 검사 — 끼워 넣은 값(vals)만 명부 이름(2자 이상)과 대조(고정 문구는 대조하지 않음 — 우연히 겹치면 매일 막히므로 · 검토 15) + 제목·본문 전화 꼴
  const names = (Array.isArray(opt.names) ? opt.names : []).map(function (s) { return typeof s === 'string' ? s.trim() : ''; }).filter(function (s) { return s.length >= 2; });
  const bad = plans.some(function (mk) {
    return mk.some(function (e) {
      const vals = Array.isArray(e.x.vals) ? e.x.vals : [];
      if (vals.some(function (v) { const s = String(v == null ? '' : v); return names.some(function (nm) { return s.indexOf(nm) >= 0; }); })) return true;
      return !!AR.piiScan({ t: String(e.x.title || ''), d: String(e.x.detail || '') });
    });
  });
  if (bad) { sum.skip = 'PII'; out.txt = id + ' 멈춤(글 검사)'; return out; }
  const by = {};
  plans.forEach(function (mk) {
    mk.forEach(function (e) {
      const due = isDate(e.x.due) ? e.x.due : '';
      sum.tasks++; by[e.who] = (by[e.who] || 0) + 1; if (!due) sum.no_due++;
      if (!write) return;
      const t = { id: typeof opt.mkId === 'function' ? opt.mkId() : 't' + Date.now().toString(16), title: String(e.x.title || '').slice(0, 120), detail: String(e.x.detail || '').slice(0, 500),
        who_id: e.who, who: String(active[e.who] || ''), who_by: 'assign', scope: e.x.priv ? [e.who] : [], from: '자동', from_id: '', by: '자동', due: due, status: 'open',
        done_at: null, done_by: null, auto_key: e.k, created: ctx.today, updated: ctx.today };
      tasks.push(t); out.made.push(t); have[e.k] = [t];
    });
  });
  sum.who = Object.keys(by).sort().map(function (w) { return { id: w, n: by[w] }; });
  let changed = out.made.length;
  if (R.mark && p.subjects && typeof p.subjects === 'object') {
    tasks.forEach(function (t) {
      if (!t || t.del === 1 || t.status === 'done' || ruleOfKey(t.auto_key) !== id) return;
      const s = subjOf(t.auto_key);
      if (!hasOwn(p.subjects, s)) return;   // 주체를 못 찾음(영구삭제 등) = 붙이지도 떼지도 않음
      const ok = (Array.isArray(p.subjects[s]) ? p.subjects[s] : []).indexOf(t.auto_key) >= 0, mk = markedKind(t);
      if (!ok) { sum.marked++; if (!mk && write) { markTask(t, R.mark, ctx.today); changed++; } }
      else if (mk) { sum.unmarked++; if (write) { unmarkTask(t, mk, ctx.today); changed++; } }
    });
  }
  out.changed = write ? changed : 0;
  if (sum.tasks || sum.unmarked || (write && changed)) out.txt = id + ' 새 ' + sum.tasks + (sum.marked ? ' · 표시 ' + sum.marked : '') + (sum.unmarked ? ' · 표시 뗌 ' + sum.unmarked : '') + (sum.no_who ? ' · 담당 없음 ' + sum.no_who : '');
  else if (sum.no_who) out.txt = id + ' 담당 없음 ' + sum.no_who;
  return out;
}

module.exports = { KEY_RE, isEvKey, isEvLike, ruleOfKey, subjOf, RULES, RULE_IDS, BASE_NEEDS, CAP, DRY_WIN, ready, needsOf, kstDay, ctxFor, emptySum, skipSum, notReadySum, MARK, MARK_WHY, markedKind, markTask, unmarkTask, run };
