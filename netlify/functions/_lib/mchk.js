'use strict';
// P1 판31 월 점검 자동 대조(착수설명서 판31 76행·위험 8 '알림이 PM에게 몰림' 206행 · 시안 판3 ③ PM 콘솔 806~819줄 · 원장 T476 · PM 11/14 11:27 "45. 판 30,31ㄱ").
// 매월 1일(KST) 전달(前月) 기준 9항목을 대조해 달마다 문서 1개 'mchk:YYYY-MM'(gw_data — 야간 백업 대상)를 남긴다. 계산은 이 파일 한 곳 — gw-data는 관문·디스패치 연결만, gw-mchk-cron은 기동만.
// 항목 상태 4가지: ok 맞음 · bad 어긋남 · unknown 확인 못 함(서버가 재료를 못 읽거나 재료가 앱 저장소 밖) · none 기준 없음(숫자만 기록 — 근거 규칙을 찾지 못한 항목).
//   콘솔 카드(index.html PMCON_CHECKS 'mchk')는 어긋남·확인 못 함만 줄로 보이고, 둘 다 0이거나 PM이 [확인]한 달이면 뜨지 않는다. 새 푸시 알림은 없다(카드만 — 위험 8).
// 기준값은 이미 있는 규칙에서만 가져왔다(아래 항목마다 basis) — 근거가 없으면 'none', 지어내지 않는다.
const { store, blobGet, blobSet, blobList } = require('./blobs');
const PUSH = require('./push');
const AUDIT = require('./audit');
const tier = require('./tier');

const DATA = 'gw_data', USERS = 'gw_users';
const DOC_PREFIX = 'mchk:';          // 'mchk:YYYY-MM' = 그달 점검 문서
const ALERT_PREFIX = 'mchk:alerts:'; // 'mchk:alerts:YYYY-MM' = 그달 봇 경보 수(gw-data bot_notify가 ⚠ 제목마다 1 — noteAlert)
const ALERT_SINCE = 'mchk:alerts:since';   // 경보를 세기 시작한 시각(처음 한 번) — 경보가 없던 달(문서 없음)을 '0건'으로 읽는 근거
const BACKUP_PREFIX = 'mchk:backup:';      // 'mchk:backup:YYYY-MM' = 그달 매일 백업이 끝난 날(KST) { days: { 'DD': 'full'|'partial' } } — gw-data backup_stamp(fn 'backup')가 noteBackup으로 더함
const BACKUP_SINCE = 'mchk:backup:since';  // 백업 흔적을 받기 시작한 시각(처음 한 번) — 그 앞 날은 빠진 날로 치지 않는다
const H = 3600000, D = 24 * H;
const DEVICE_PENDING_DAYS = 7;      // 판22 '대기 7일'(착수설명서 58행 — 새 기기 승인 대기 7일 넘으면 다시 알림)
const SUBS_PER_MEMBER = 5;          // 그룹웨어 운영권한관리규정(JW-11-01-003) 제14조① '회원당 5대 이내' · gw-data handlePushSub slice(-5)
const FILES_BACKUP_H = 96;          // appdata data/cron_map.json 'JW 첨부백업' alert_after_h 96(주말·연휴 넘겨 PC가 꺼진 경우까지 잡는 선)
// 월 사용 상한 — 코드에 적힌 값 그대로(한쪽만 고치지 말 것 — servertest 'P1 판31'이 원본 상수와 대조)
const USAGE_CAPS = [
  { id: 'ask', label: '물어보기', unit: '토큰', cap: Number(process.env.GW_ASK_MONTH_TOKENS || 12000000), src: 'gw-ask.js MONTH_TOKENS' },
  { id: 'promoai', label: '블로그 AI', unit: '회', cap: 500, src: '_lib/promoai_job.js MONTH_CALL_CAP' },
  { id: 'promomask', label: '사진 가리기', unit: '회', cap: 1000, src: 'gw-promo-mask.js MONTH_CALL_CAP' },
  { id: 'brief_azure', label: '아침 브리핑 음성', unit: '자', cap: 400000, src: '_lib/brief.js CAP_AZURE_CHARS' },
  { id: 'brief_claude', label: '아침 브리핑 글', unit: '토큰', cap: 1000000, src: '_lib/brief.js CAP_CLAUDE_TOKENS' },
  { id: 'learn', label: '계약 학습', unit: '회', cap: 200, src: '_lib/learn.js TYPES.contract.monthly_cap' },
];
const ITEMS = [   // 순서 = 착수설명서 판31 줄(로그인·잠금·퇴사자 접속·권한 변경·대기 기기·구독·사용량·백업 연속일·경보 수)
  { id: 'login', label: '로그인', rule: '이름으로 로그인 0건(아이디로만)', basis: '그룹웨어 운영권한관리규정(JW-11-01-003) 제6조①·⑤ · 이름 로그인 9/11 종료(착수설명서 106행) · gw-auth ALLOW_NAME_LOGIN' },
  { id: 'lock', label: '잠금', rule: '기준 없음 — 숫자만 기록', basis: '제6조④(반복 실패 잠금)는 건수 기준을 두지 않음 · gw-auth LOCK_THRESHOLD 5회·15분' },
  { id: 'retired', label: '퇴사자 접속', rule: '퇴사일 다음 날 뒤 로그인 0건', basis: '그룹웨어 운영권한관리규정 제8조(퇴사일 다음 날부터 로그인 차단) · _lib/tier.js retired' },
  { id: 'perm', label: '권한 변경', rule: '모듈 권한·관리자·개발자 표시 변경은 개발자만 · 등급 변경은 대표·PM만', basis: '그룹웨어 운영권한관리규정 제9조③·제10조① · gw-auth DEV_ONLY·TIER_PM_OR_BOSS_ONLY' },
  { id: 'device', label: '대기 기기', rule: '승인 대기 ' + DEVICE_PENDING_DAYS + '일 넘은 기기 0 · 퇴사·삭제 회원의 승인된 기기 0', basis: '착수설명서 판22(대기 7일·퇴사 다음 날 대기로) · 그룹웨어 운영권한관리규정 제12조③' },
  { id: 'subs', label: '구독', rule: '회원당 알림 기기 ' + SUBS_PER_MEMBER + '대 이내 · 퇴사·삭제 회원 구독 0', basis: '그룹웨어 운영권한관리규정 제14조① · 착수설명서 판22(퇴사 다음 날 구독 회수) · gw-data push_sub' },
  { id: 'usage', label: '사용량', rule: '월 사용 상한에 닿은 기능 0', basis: '코드의 월 상한(물어보기·블로그 AI·사진 가리기·아침 브리핑·계약 학습)' },
  { id: 'backup', label: '백업 연속일', rule: '매일 백업이 빠진 날 0 · 부분 백업(실패 키 있음) 0 · 첨부 백업 마지막 흔적 ' + FILES_BACKUP_H + '시간 안', basis: '그룹웨어 운영권한관리규정 제17조①(매일 05시 30분 전체 백업) · appdata .github/workflows/backup.yml cron "30 20 * * *"(KST 05:30 매일)·cron_map backup.yml · 첨부 = cron_map JW 첨부백업 96시간' },
  { id: 'alerts', label: '경보 수', rule: '기준 없음 — 숫자만 기록', basis: '자동화운영규정(JW-11-01-004) 제14조②(이상일 때만 알림)는 허용 건수를 두지 않음' },
];
const ITEM_BY = {}; ITEMS.forEach(function (x) { ITEM_BY[x.id] = x; });

function kstYm(ms) { return new Date(ms + 9 * H).toISOString().slice(0, 7); }
function kstDay(ms) { return new Date(ms + 9 * H).toISOString().slice(0, 10); }
function prevYm(ym) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }
function ymOk(ym) { return typeof ym === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(ym); }
function bounds(ym) { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return { s: Date.UTC(y, m - 1, 1) - 9 * H, e: Date.UTC(y, m, 1) - 9 * H }; }   // KST 그달 [s, e)
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function item(id, st, lines, n) { const b = ITEM_BY[id]; return { id: id, label: b.label, st: st, rule: b.rule, basis: b.basis, lines: lines, n: n || {} }; }

// ---- 재료 읽기 — 못 읽은 것과 없는 것을 가른다(못 읽음 = null → 그 항목 '확인 못 함') ----
async function getOr(st, key, dflt) {   // { ok, data } — 없음 = dflt · 읽기 실패 = ok false
  const r = await blobGet(st, key);
  if (!r.ok) return r.code === 'NOT_FOUND' ? { ok: true, data: dflt } : { ok: false };
  return { ok: true, data: r.data == null ? dflt : r.data };
}
async function listVals(st, prefix) {   // 접두어 키 전부의 값(지워진 키 = null 건너뜀) · 하나라도 못 읽으면 null
  const l = await blobList(st, prefix);
  if (!l || !l.ok) return null;
  const out = [];
  for (const k of l.keys) {
    if (k.indexOf(prefix) !== 0) continue;
    const r = await getOr(st, k, null);
    if (!r.ok) return null;
    if (isObj(r.data)) out.push({ key: k, v: r.data });
  }
  return out;
}
async function gather(period) {
  const sd = store(DATA), su = store(USERS);
  const m = {};
  m.audit = await AUDIT.readMonth(period);
  const ms = await PUSH.loadMembers();
  m.members = (ms && !ms.unavailable) ? ms.filter(isObj) : null;
  m.devices = await listVals(su, 'device:');
  m.locks = await listVals(su, 'lock:');
  const subs = await getOr(sd, 'push:subs', { members: {} });
  m.subs = subs.ok && isObj(subs.data) && isObj(subs.data.members || {}) ? (subs.data.members || {}) : null;
  m.usage = {};
  for (const k of ['ask:usage', 'promoai:usage', 'promomask:usage', 'brief:usage:' + period, 'usage:learn:contract:' + period, 'usage:box:' + period]) { const r = await getOr(sd, k, {}); m.usage[k] = r.ok && isObj(r.data) ? r.data : null; }
  const fs = await getOr(sd, 'it:cron:files_backup:last', null);
  m.filesStamp = fs.ok ? (isObj(fs.data) ? fs.data : 'none') : null;
  const al = await getOr(sd, ALERT_PREFIX + period, null);
  m.alertDoc = al.ok ? (isObj(al.data) ? al.data : 'none') : null;
  const as = await getOr(sd, ALERT_SINCE, null);
  m.alertSince = as.ok ? (isObj(as.data) ? as.data : 'none') : null;
  const bk = await getOr(sd, BACKUP_PREFIX + period, null);
  m.backupDoc = bk.ok ? (isObj(bk.data) ? bk.data : 'none') : null;
  const bs = await getOr(sd, BACKUP_SINCE, null);
  m.backupSince = bs.ok ? (isObj(bs.data) ? bs.data : 'none') : null;
  const pl = await getOr(sd, 'push:log', { items: [] });
  m.pushLog = pl.ok && isObj(pl.data) && Array.isArray(pl.data.items) ? pl.data.items : null;
  return m;
}

// ---- 항목 판정(순수 — servertest가 재료를 직접 넣어 돌린다) ----
function judge(period, nowMs, m) {
  const b = bounds(period), out = [];
  const logs = m.audit && m.audit.ok ? m.audit.items.filter(isObj) : null;
  const byId = {}; (m.members || []).forEach(function (x) { if (x.id) byId[x.id] = x; });
  const gone = function (id) { const x = byId[id]; return !x || x.del === 1 || tier.retired(x); };
  const logins = logs ? logs.filter(function (x) { return x.col === 'login' && (x.ev || []).some(function (e) { return e && e.op === '로그인'; }) && num(x.ts) >= b.s && num(x.ts) < b.e; }) : null;
  // 1 로그인 — 이름 경로 0건
  if (!logins) out.push(item('login', 'unknown', ['감사 기록을 읽지 못했습니다']));
  else {
    const byName = logins.filter(function (x) { return (x.ev || []).some(function (e) { return e && e.op === '로그인' && /\(이름\)$/.test(String(e.t || '')); }); });
    const ppl = {}; logins.forEach(function (x) { ppl[x.bid || x.by] = 1; });
    out.push(item('login', byName.length ? 'bad' : 'ok', byName.length ? ['이름으로 로그인 ' + byName.length + '건 — 아이디로만 들어오게 되어 있습니다'] : ['로그인 ' + logins.length + '건 · ' + Object.keys(ppl).length + '명 · 모두 아이디'], { logins: logins.length, people: Object.keys(ppl).length, by_name: byName.length }));
  }
  // 2 잠금 — 기준 없음(숫자만). 잠금 기록은 성공 로그인 때 지워지므로 '남아 있는 기록' 기준
  if (!m.locks) out.push(item('lock', 'unknown', ['잠금 기록을 읽지 못했습니다']));
  else {
    const inM = m.locks.filter(function (x) { return num(x.v.until) >= b.s && num(x.v.until) < b.e + 15 * 60000; }).length;
    const failing = m.locks.filter(function (x) { return num(x.v.fails) > 0; }).length;
    out.push(item('lock', 'none', ['그달 잠금 ' + inM + '건(남은 기록 기준) · 실패가 쌓인 아이디 ' + failing + '개'], { locked: inM, failing: failing, keys: m.locks.length }));
  }
  // 3 퇴사자 접속 — 로그인한 날(KST)이 퇴사일보다 뒤
  if (!logins || !m.members) out.push(item('retired', 'unknown', [!logins ? '감사 기록을 읽지 못했습니다' : '회원 명부를 읽지 못했습니다']));
  else {
    const late = logins.filter(function (x) { const mb = byId[x.bid]; return mb && mb.leave_date && kstDay(num(x.ts)) > String(mb.leave_date); });
    const names = {}; late.forEach(function (x) { names[String(x.by || '')] = 1; });
    out.push(item('retired', late.length ? 'bad' : 'ok', late.length ? ['퇴사일 뒤 로그인 ' + late.length + '건 — ' + Object.keys(names).slice(0, 3).join(', ')] : ['퇴사일 뒤 로그인 0건'], { late: late.length }));
  }
  // 4 권한 변경 — 회원 '수정' 줄의 perms·admin·dev(개발자만) · tier(대표·PM만). 변경자 판정은 점검 시각의 명부(지금 개발자·등급)
  if (!logs || !m.members) out.push(item('perm', 'unknown', [!logs ? '감사 기록을 읽지 못했습니다' : '회원 명부를 읽지 못했습니다']));
  else {
    const ctx = tier.ctxOf(m.members);
    let n = 0; const bad = [];
    logs.forEach(function (x) {
      if (x.col !== 'member' || num(x.ts) < b.s || num(x.ts) >= b.e) return;
      (x.ev || []).forEach(function (e) {
        if (!e || e.op !== '수정' || !isObj(e.f)) return;
        const sys = ['perms', 'admin', 'dev'].filter(function (k) { return Object.prototype.hasOwnProperty.call(e.f, k); });
        const tr = Object.prototype.hasOwnProperty.call(e.f, 'tier');
        if (!sys.length && !tr) return;
        n++;
        const actor = byId[x.bid];
        const okSys = !sys.length || !!(actor && actor.dev);
        const okTier = !tr || !!(actor && (ctx.tierOf(actor) === 'boss' || ctx.tierOf(actor) === 'pm'));
        if (!okSys || !okTier) bad.push(String(x.by || '?') + ' → ' + String(e.t || '') + ' [' + sys.concat(tr ? ['tier'] : []).join(',') + ']');
      });
    });
    out.push(item('perm', bad.length ? 'bad' : 'ok', bad.length ? ['개발자·대표·PM이 아닌 사람의 권한 변경 ' + bad.length + '건 — ' + bad.slice(0, 2).join(' · ')] : ['권한 변경 ' + n + '건 — 모두 정해진 사람'], { changes: n, bad: bad.length }));
  }
  // 5 대기 기기 — 점검 시각 기준(지금 상태)
  if (!m.devices) out.push(item('device', 'unknown', ['기기 목록을 읽지 못했습니다']));
  else {
    const ds = m.devices.map(function (x) { return x.v; });
    const pend = ds.filter(function (v) { return v.status !== 'approved'; });
    const old = pend.filter(function (v) { return num(v.created) > 0 && nowMs - num(v.created) > DEVICE_PENDING_DAYS * D; });
    const goneApproved = m.members ? ds.filter(function (v) { return v.status === 'approved' && v.member_id && gone(v.member_id); }) : null;
    const lines = [];
    if (old.length) lines.push('승인 대기 ' + DEVICE_PENDING_DAYS + '일 넘은 기기 ' + old.length + '대');
    if (goneApproved && goneApproved.length) lines.push('퇴사·삭제 회원의 승인된 기기 ' + goneApproved.length + '대');
    const st = (old.length || (goneApproved && goneApproved.length)) ? 'bad' : (goneApproved ? 'ok' : 'unknown');
    if (st === 'unknown') lines.push('회원 명부를 읽지 못해 퇴사자 기기를 대조하지 못했습니다');
    if (st === 'ok') lines.push('기기 ' + ds.length + '대 · 승인 ' + (ds.length - pend.length) + ' · 대기 ' + pend.length + '(7일 안)');
    out.push(item('device', st, lines, { devices: ds.length, pending: pend.length, pending_old: old.length, gone_approved: goneApproved ? goneApproved.length : null }));
  }
  // 6 구독 — 점검 시각 기준
  if (!m.subs) out.push(item('subs', 'unknown', ['알림 구독 목록을 읽지 못했습니다']));
  else {
    const ids = Object.keys(m.subs);
    const cnt = function (id) { return Array.isArray(m.subs[id]) ? m.subs[id].length : 0; };
    const over = ids.filter(function (id) { return cnt(id) > SUBS_PER_MEMBER; });
    const goneS = m.members ? ids.filter(function (id) { return cnt(id) > 0 && gone(id); }) : null;
    const lines = [];
    if (over.length) lines.push('알림 기기 ' + SUBS_PER_MEMBER + '대 넘은 회원 ' + over.length + '명');
    if (goneS && goneS.length) lines.push('퇴사·삭제 회원 구독 ' + goneS.length + '명');
    const st = (over.length || (goneS && goneS.length)) ? 'bad' : (goneS ? 'ok' : 'unknown');
    if (st === 'unknown') lines.push('회원 명부를 읽지 못해 퇴사자 구독을 대조하지 못했습니다');
    if (st === 'ok') lines.push('알림 받는 회원 ' + ids.length + '명 · 기기 ' + ids.reduce(function (s, id) { return s + cnt(id); }, 0) + '대');
    out.push(item('subs', st, lines, { members: ids.length, over: over.length, gone: goneS ? goneS.length : null }));
  }
  // 7 사용량 — 그달 사용이 월 상한에 닿았는가
  {
    const u = m.usage || {}, rows = [], miss = [];
    const pick = function (k, f) { if (!u[k]) { miss.push(k); return null; } try { return num(f(u[k])); } catch (e) { return 0; } };
    const cap = {}; USAGE_CAPS.forEach(function (c) { cap[c.id] = c; });
    const add = function (id, used) { if (used === null) return; rows.push({ id: id, label: cap[id].label, used: used, cap: cap[id].cap, unit: cap[id].unit }); };
    add('ask', pick('ask:usage', function (d) { return (d.month || {})[period]; }));
    add('promoai', pick('promoai:usage', function (d) { return ((d.months || {})[period] || {}).calls; }));
    add('promomask', pick('promomask:usage', function (d) { return ((d.months || {})[period] || {}).calls; }));
    const bu = pick('brief:usage:' + period, function (d) { return d.azure_chars; }); add('brief_azure', bu);
    add('brief_claude', bu === null ? null : num((u['brief:usage:' + period] || {}).claude_tokens));
    add('learn', pick('usage:learn:contract:' + period, function (d) { return d.calls; }));
    const box = u['usage:box:' + period] ? num(u['usage:box:' + period].calls) : null;
    const hit = rows.filter(function (r) { return r.cap > 0 && r.used >= r.cap; });
    const lines = hit.map(function (r) { return r.label + ' ' + fmt(r.used) + '/' + fmt(r.cap) + r.unit + ' — 월 상한에 닿아 그달 그 기능이 멈췄습니다'; });
    const st = hit.length ? 'bad' : (miss.length ? 'unknown' : 'ok');
    if (st === 'unknown') lines.push('사용량 기록 ' + miss.length + '개를 읽지 못했습니다');
    if (st === 'ok') lines.push('상한 닿은 것 없음 — ' + rows.map(function (r) { return r.label + ' ' + Math.round(100 * r.used / r.cap) + '%'; }).join(' · ') + (box !== null ? ' · 넣기 박스 ' + box + '회(상한 없음)' : ''));
    const nn = {}; rows.forEach(function (r) { nn[r.id] = r.used; }); if (box !== null) nn.box = box;
    out.push(item('usage', st, lines, nn));
  }
  // 8 백업 연속일 — 매일 백업(appdata backup.py, KST 05:30)이 끝날 때마다 backup_stamp(fn 'backup')로 남긴 그달 날짜 목록(mchk:backup:YYYY-MM)을 본다.
  //   기록 시작(mchk:backup:since — 없으면 그달 문서의 since)보다 앞 날은 빠진 날로 치지 않는다(첫 달은 'n일부터 기록') · 그달 전체가 시작 전이면 판정하지 않음(기준 없음 — 숫자 없음).
  //   부분 백업(실패 키 있음 — 판5) 날은 어긋남. 확인 못 함은 흔적 문서를 못 읽었을 때만.
  //   첨부 백업(PC)은 흔적 스탬프(마지막 1개)로 점검 시각 기준 96시간·실패만 본다 — 걸리면 어긋남.
  {
    const lines = [], nn = { missing: null, partial: null, from: null, files_age_h: null };
    let st, filesBad = false, filesUnk = false;
    const bd = m.backupDoc, bsn = m.backupSince;
    const startTs = isObj(bsn) && num(bsn.ts) ? num(bsn.ts) : (isObj(bd) && num(bd.since) ? num(bd.since) : null);
    if (bd === null || bsn === null) { st = 'unknown'; lines.push('매일 백업 흔적 기록을 읽지 못했습니다'); }
    else if (startTs === null || startTs >= b.e) { st = 'none'; lines.push('매일 백업 흔적 기록 전 — 이 달은 판정하지 않음'); }
    else {
      const last = Number(new Date(b.e - 1 + 9 * H).toISOString().slice(8, 10));
      const from = startTs <= b.s ? 1 : Number(kstDay(startTs).slice(8, 10));
      const days = isObj(bd) && isObj(bd.days) ? bd.days : {};
      const miss = [], part = [];
      for (let dd = from; dd <= last; dd++) { const k = String(dd).padStart(2, '0'); if (days[k] === 'full') continue; if (days[k] === 'partial') part.push(dd); else miss.push(dd); }
      const mo = Number(period.slice(5, 7)), dl = function (a) { return a.slice(0, 5).map(function (x) { return mo + '/' + x; }).join(', ') + (a.length > 5 ? ' 외 ' + (a.length - 5) + '일' : ''); };
      if (miss.length) lines.push('매일 백업 빠진 날 ' + miss.length + '일(' + dl(miss) + ')');
      if (part.length) lines.push('부분 백업(실패 키 있음) ' + part.length + '일(' + dl(part) + ')');
      if (!miss.length && !part.length) lines.push('매일 백업 ' + (last - from + 1) + '/' + (last - from + 1) + '일');
      if (from > 1) lines.push(from + '일부터 기록');
      nn.missing = miss.length; nn.partial = part.length; nn.from = from;
      st = (miss.length || part.length) ? 'bad' : 'ok';
    }
    const fs = m.filesStamp;
    if (fs === null) { filesUnk = true; lines.push('첨부 백업 흔적을 읽지 못했습니다'); }
    else if (fs === 'none') lines.push('첨부 백업 흔적 없음');
    else {
      nn.files_age_h = Math.floor((nowMs - num(fs.ts)) / H);
      if (fs.ok === false) { filesBad = true; lines.unshift('첨부 백업 마지막 실행 실패(' + kstDay(num(fs.ts)) + ')'); }
      else if (nn.files_age_h > FILES_BACKUP_H) { filesBad = true; lines.unshift('첨부 백업 마지막 흔적 ' + nn.files_age_h + '시간 전 — ' + FILES_BACKUP_H + '시간 넘음'); }
      else lines.push('첨부 백업 마지막 흔적 ' + nn.files_age_h + '시간 전(' + FILES_BACKUP_H + '시간 안)');
    }
    if (filesBad) st = 'bad';
    else if (filesUnk && st !== 'bad') st = 'unknown';
    out.push(item('backup', st, lines, nn));
  }
  // 9 경보 수 — 기준 없음(숫자만 — 카드에 줄로 안 나옴). 재료: 그달 봇 경보 수(noteAlert) · 세기 시작(mchk:alerts:since) 뒤 문서 없는 달 = 0건 ·
  //   첫 달은 'n일부터 셈' · 세기 전 달은 알림함(최근 100건 고리)이 그달을 덮으면 ⚠ 제목 수, 아니면 센 만큼만 '세기 전'으로 적는다. 확인 못 함은 기록을 못 읽었을 때만.
  {
    const ad = m.alertDoc, asn = m.alertSince;
    const pl = m.pushLog;
    const plCount = pl ? pl.filter(function (x) { return isObj(x) && num(x.ts) >= b.s && num(x.ts) < b.e && String(x.title || '').charAt(0) === '⚠'; }).length : null;
    const plCovers = !!(pl && pl.length && num(pl[0].ts) <= b.s);
    const start = isObj(asn) && num(asn.ts) ? num(asn.ts) : (isObj(ad) && num(ad.since) ? num(ad.since) : null);
    if (ad === null || asn === null) out.push(item('alerts', 'unknown', ['경보 기록을 읽지 못했습니다'], { alerts: null }));
    else if (start !== null && start < b.e) {
      const n = isObj(ad) ? num(ad.n) : 0, from = start <= b.s + H ? 1 : Number(kstDay(start).slice(8, 10));
      out.push(item('alerts', 'none', ['경보 ' + n + '건' + (from > 1 ? '(' + from + '일부터 셈)' : '')], { alerts: n, src: 'count', from: from }));
    }
    else if (plCovers) out.push(item('alerts', 'none', ['경보 ' + plCount + '건(알림함 기준)'], { alerts: plCount, src: 'push_log' }));
    else out.push(item('alerts', 'none', ['경보 세기 전 — 알림함 최근 100건 중 ' + (plCount === null ? '?' : plCount) + '건'], { alerts: null, src: 'partial', partial: plCount }));
  }
  return out;
}
function counts(items) { const c = { ok: 0, bad: 0, unknown: 0, none: 0 }; items.forEach(function (x) { c[x.st] = (c[x.st] || 0) + 1; }); return c; }
async function compute(period, nowMs, by) {
  const m = await gather(period);
  const items = judge(period, nowMs, m);
  return { schema: 1, period: period, at: nowMs, by: by || 'cron', items: items, counts: counts(items), ack: null, updated_at: nowMs };
}

// ---- 크론·봇 키 다시 돌리기 ----
// opts: { period?, force?, by } — period 없음 = 크론(KST 1~3일만 · 전달) · 있으면 그 달(봇 키 수동). 같은 달 문서가 있으면 건너뜀(force만 다시 — 그때 [확인]은 풀리고 prev_ack에 남음)
async function run(nowMs, opts) {
  opts = opts || {};
  let period = opts.period;
  if (period === undefined || period === null || period === '') {
    const day = Number(kstDay(nowMs).slice(8, 10));
    if (day < 1 || day > 3) return { ok: true, skipped: 'not-first-days' };   // 1일 기동이 빠져도(스케줄 미발화·일시 오류) 3일까지 잡는다 — 문서가 있으면 건너뛰므로 두 번 돌아도 1개
    period = prevYm(kstYm(nowMs));
  }
  if (!ymOk(period) || period >= kstYm(nowMs)) return { ok: false, code: 'BAD_PERIOD' };   // 끝난 달만
  const st = store(DATA), key = DOC_PREFIX + period;
  const cur = await getOr(st, key, null);
  if (!cur.ok) return { ok: false, code: 'MCHK_READ_FAILED' };
  if (isObj(cur.data) && opts.force !== true) return { ok: true, skipped: 'exists', period: period };
  const doc = await compute(period, nowMs, opts.by);
  // 쓰기 직전 다시 읽기 — 그사이 다른 기동이 썼으면 건너뜀(한 달 문서 1개)
  const again = await getOr(st, key, null);
  if (!again.ok) return { ok: false, code: 'MCHK_READ_FAILED' };
  if (isObj(again.data) && opts.force !== true) return { ok: true, skipped: 'exists', period: period };
  if (isObj(again.data)) { doc.rerun = num(again.data.rerun) + 1; doc.prev_ack = again.data.ack || null; doc.updated_at = Math.max(nowMs, num(again.data.updated_at) + 1); }
  const w = await blobSet(st, key, doc);
  if (!w || !w.ok) return { ok: false, code: 'MCHK_WRITE_FAILED' };
  const c = doc.counts;
  try { await AUDIT.appendAudit({ ts: nowMs, by: opts.by === 'bot' ? '월점검봇' : '자동', bid: '__system__', col: 'mchk', ev: [{ op: doc.rerun ? '월점검다시' : '월점검', id: key, t: period + ' 어긋남 ' + c.bad + ' · 확인 못 함 ' + c.unknown + ' · 맞음 ' + c.ok + ' · 기준 없음 ' + c.none }] }); } catch (e) {}
  return { ok: true, period: period, counts: c, rerun: doc.rerun || 0 };
}
const runMonthly = function (nowMs) { return run(nowMs, { by: 'cron' }); };

// ---- 관리자 열람 · PM [확인] ----
function periodOf(d, nowMs) {
  if (d && d.period !== undefined && d.period !== null && d.period !== '') return ymOk(String(d.period)) ? String(d.period) : null;
  return prevYm(kstYm(nowMs));
}
async function get(d, canAck, nowMs) {
  const period = periodOf(d, nowMs || Date.now());
  if (!period) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };
  const r = await getOr(store(DATA), DOC_PREFIX + period, null);
  if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'MCHK_READ_FAILED' } };
  return { code: 200, body: { status: 'OK', period: period, doc: isObj(r.data) ? r.data : null, can_ack: !!canAck } };
}
// [확인] — PM 관문은 gw-data(판29 pmconGate 쓰기 = 명시 tier pm · 명부 못 읽으면 503)가 먼저 본다. log = { key, read, fold } = 판29 누른 기록(status:decide) 꼴 그대로.
//   순서: 점검 문서 읽기(없음 404·낡은 base 409·이미 확인 400) → 누른 기록 읽기(실패 503 — 아무것도 안 씀) → 점검 문서에 ack → 누른 기록 1줄(실패면 ack 되돌리고 500) → 감사 1줄
async function ack(d, member, log, nowMs) {
  const now = nowMs || Date.now();
  const period = d && ymOk(String(d.period || '')) ? String(d.period) : null;
  if (!period) return { code: 400, body: { status: 'REJECTED', error_code: 'BAD_PERIOD' } };
  const st = store(DATA), key = DOC_PREFIX + period;
  const r = await getOr(st, key, null);
  if (!r.ok) return { code: 503, body: { status: 'ERROR', error_code: 'MCHK_READ_FAILED' } };
  if (!isObj(r.data) || !Array.isArray(r.data.items)) return { code: 404, body: { status: 'REJECTED', error_code: 'MCHK_NONE' } };
  const doc = r.data;
  if (d.base === undefined || num(d.base) !== num(doc.updated_at)) return { code: 409, body: { status: 'CONFLICT', error_code: 'MCHK_STALE' } };
  if (isObj(doc.ack)) return { code: 400, body: { status: 'REJECTED', error_code: 'MCHK_ACKED' } };
  const lr = await log.read(st);
  if (!lr.ok) return { code: 503, body: { status: 'ERROR', error_code: 'PMCON_READ_FAILED' } };
  const c = counts(doc.items);
  const name = String(member.name || '').slice(0, 20);
  const before = JSON.parse(JSON.stringify(doc));
  doc.ack = { ts: now, by: member.id, name: name };
  doc.updated_at = Math.max(now, num(doc.updated_at) + 1);
  const w1 = await blobSet(st, key, doc);
  if (!w1 || !w1.ok) return { code: 500, body: { status: 'ERROR', error_code: 'MCHK_WRITE_FAILED' } };
  const ldoc = lr.doc;
  ldoc.log.push({ ts: now, by: member.id, name: name, row: 'mchk:' + period, kind: 'mchk', choice: 'ack', grade: '', due: '',
    q: Number(period.slice(5, 7)) + '월 월 점검 확인 — 어긋남 ' + c.bad + ' · 확인 못 함 ' + c.unknown, rec: '', val: '', match: null, why: '', applied: false, via: 'mchk' });
  log.fold(ldoc);
  ldoc.schema = 1; ldoc.updated_by = member.id; ldoc.updated_at = Math.max(now, num(ldoc.updated_at) + 1);
  const w2 = await blobSet(st, log.key, ldoc);
  if (!w2 || !w2.ok) { try { await blobSet(st, key, before); } catch (e) {} return { code: 500, body: { status: 'ERROR', error_code: 'PMCON_WRITE_FAILED' } }; }
  let au = false;
  try { au = (await AUDIT.appendAudit({ ts: now, by: member.name, bid: member.id, col: 'mchk', ev: [{ op: '월점검확인', id: key, t: period + ' 어긋남 ' + c.bad + ' · 확인 못 함 ' + c.unknown }] })) !== false; } catch (e) { au = false; }
  return { code: 200, body: { status: 'OK', period: period, ack: doc.ack, updated_at: doc.updated_at, log_updated_at: ldoc.updated_at, audit: au } };
}

// gw-data bot_notify가 부른다 — ⚠로 시작하는 봇 경보만 그달 수 1 더함(제목별 수 30종까지). 실패는 삼킨다(경보 발송을 막지 않음)
async function noteAlert(title, nowMs) {
  try {
    const t = String(title || '');
    if (t.charAt(0) !== '⚠') return false;
    const now = nowMs || Date.now(), st = store(DATA), key = ALERT_PREFIX + kstYm(now);
    const r = await getOr(st, key, null);
    if (!r.ok) return false;
    const doc = isObj(r.data) ? r.data : { schema: 1, n: 0, since: now, by: {} };
    if (!isObj(doc.by)) doc.by = {};
    doc.n = num(doc.n) + 1;
    const k = t.slice(0, 40);
    if (Object.prototype.hasOwnProperty.call(doc.by, k) || Object.keys(doc.by).length < 30) doc.by[k] = num(doc.by[k]) + 1;
    doc.updated_at = now;
    const w = await blobSet(st, key, doc);
    if (!isObj(r.data)) await sinceMark(st, ALERT_SINCE, now);   // 그달 첫 경보 = 세기 시작 표시가 없으면 남김(경보 없는 달을 0건으로 읽는 근거)
    return !!(w && w.ok);
  } catch (e) { return false; }
}
// 처음 한 번만 — 있거나 못 읽으면 건드리지 않음
async function sinceMark(st, key, now) {
  try { const s = await getOr(st, key, null); if (s.ok && !isObj(s.data)) await blobSet(st, key, { schema: 1, ts: now }); } catch (e) {}
}
// gw-data backup_stamp(fn 'backup' — appdata backup.py가 매일 백업을 저장한 뒤 봇 키로)가 부른다 — 그날(KST)을 그달 목록에 더함.
//   ok + 부분 아님 = 'full' · partial = 'partial'(실패 키 있음) · 그 밖(ok false)은 더하지 않음(빠진 날) · 같은 날 'full'이 한 번이라도 있으면 'full'. 실패는 삼킨다(흔적이 백업을 막지 않음)
async function noteBackup(ok, partial, nowMs) {
  try {
    if (!ok && !partial) return false;
    const now = nowMs || Date.now(), st = store(DATA), key = BACKUP_PREFIX + kstYm(now), dd = kstDay(now).slice(8, 10);
    const r = await getOr(st, key, null);
    if (!r.ok) return false;
    const doc = isObj(r.data) ? r.data : { schema: 1, since: now, days: {} };
    if (!isObj(doc.days)) doc.days = {};
    doc.days[dd] = (doc.days[dd] === 'full' || (ok && !partial)) ? 'full' : 'partial';
    doc.runs = num(doc.runs) + 1; doc.updated_at = now;
    const w = await blobSet(st, key, doc);
    if (!isObj(r.data)) await sinceMark(st, BACKUP_SINCE, now);
    return !!(w && w.ok);
  } catch (e) { return false; }
}

module.exports = { ITEMS, USAGE_CAPS, DEVICE_PENDING_DAYS, SUBS_PER_MEMBER, FILES_BACKUP_H, DOC_PREFIX, ALERT_PREFIX, ALERT_SINCE, BACKUP_PREFIX, BACKUP_SINCE, kstYm, prevYm, bounds, gather, judge, counts, compute, run, runMonthly, get, ack, noteAlert, noteBackup };
