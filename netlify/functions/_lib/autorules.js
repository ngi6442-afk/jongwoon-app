'use strict';
// 자동 지시 서버 규칙 3건(카드 10, v417 — 09_조사_문서/착수브리핑_카드10_자동지시_20261102.md §3, PM 11/3 13:15 "착수").
// site G2-a 현장 대장 미입력 월 1회 · veh G1 차량 정기검사 D-90 · worker P0 일용직 인적사항 월 1회.
// 결정적 집계(모델 호출 없음). 산출물은 id·수만 — 이름·생년월일·연락처 값은 어디에도 싣지 않는다(브리핑 §8).
// 같은 함수를 ① 서버 autotask_facts(appdata autotask.py가 호출 — 생성 여부는 규칙 스위치 settings:autotask) ② 완료 신호(_lib/doneif.js: 다음 회차 미입력 0 → 승인 대기)가 쓴다.
const GREY = ['말소예정', '매각', '검사보류'];   // 앱 isGreyState·autotask.py GREY와 동일
const VEH90_MIN = 31, VEH90_MAX = 90;           // D-90 구간: 기존 D-30(≤30)이 이미 잡는 날은 뺀다(같은 auto_key라 live면 서버가 먼저 만들 뿐)
const WK_SINCE_YEAR = 2025;                      // 일용직 셈 범위 = 2025년 이후 참여자(PM 10/1 '우선')

function live(items) { return (Array.isArray(items) ? items : []).filter(function (x) { return x && typeof x === 'object' && x.del !== 1; }); }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function dayDiff(dateStr, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const t = String(today).split('-');
  const a = Date.UTC(+m[1], +m[2] - 1, +m[3]), b = Date.UTC(+t[0], +t[1] - 1, +t[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}
function asList(v) { return Array.isArray(v) ? v : []; }
function blank(s) { return !String(s == null ? '' : s).trim(); }

// ---- 3-1 site G2-a: 현장 대장 미입력 ----
// 준설(dredge) 행의 투입 근로자 0명 + 철거·준설 행의 소재지(site) 공란. 석면(asbestos) 행의 근로자 없음은 확인목록 판단 대기와 겹쳐 제외(브리핑 3-1 [추정]).
// 반환 {count(행 수, 중복 없음), ids, seqs, by:{dredge_workers, site_blank:{dredge, demolition}}}
function siteMissing(asbRows) {
  const rows = live(asbRows);
  const hit = {}; const by = { dredge_workers: 0, site_blank: { dredge: 0, demolition: 0 } };
  rows.forEach(function (r) {
    const kind = String(r.kind || 'asbestos');
    let miss = false;
    if (kind === 'dredge' && !asList(r.worker_ids).length) { by.dredge_workers++; miss = true; }
    if ((kind === 'dredge' || kind === 'demolition') && blank(r.site)) { by.site_blank[kind]++; miss = true; }
    if (miss) hit[r.id] = r;
  });
  const ids = Object.keys(hit);
  return { count: ids.length, ids: ids, seqs: ids.map(function (id) { return hit[id].seq; }).filter(function (x) { return x != null; }), by: by, total: rows.length };
}

// ---- 3-2 veh G1: 정기검사 D-90 ----
// 회색 3종 제외 · insp_due가 오늘부터 31~90일 · 같은 auto_key(veh:<id>:insp:<만료일>)가 col:tasks에 이미 있으면 겹침(overlap)으로 세고 후보에서 뺀다.
// 종류(kind) 칸에 건설기계류 글(굴삭기·지게차·크레인·덤프·로더·건설기계)이 있는 행은 flag(건설기계 D-31은 G2 뒤 — 브리핑 3-2 ⓑ).
const RE_CONSTR = /굴삭기|굴착기|지게차|크레인|로더|불도저|건설기계|덤프/;
function veh90(vehRows, today, existingKeys) {
  const have = {}; asList(existingKeys).forEach(function (k) { have[String(k)] = 1; });
  const items = []; let overlap = 0; const flags = [];
  live(vehRows).forEach(function (v) {
    if (GREY.indexOf(String(v.state || '')) >= 0) return;
    if (!isDate(v.insp_due)) return;
    const d = dayDiff(v.insp_due, today);
    if (d === null || d < VEH90_MIN || d > VEH90_MAX) return;
    const key = 'veh:' + v.id + ':insp:' + v.insp_due;
    if (have[key]) { overlap++; return; }
    items.push({ id: v.id, due: v.insp_due, days: d, key: key });
    if (RE_CONSTR.test(String(v.kind || '') + ' ' + String(v.type || ''))) flags.push(v.id);
  });
  items.sort(function (a, b) { return a.days - b.days; });
  return { count: items.length, items: items, overlap: overlap, flags: flags, window: [VEH90_MIN, VEH90_MAX] };
}

// ---- 3-3 worker P0: 일용직 인적사항 ----
// 생년월일 6자리 정규화: '81.08.17'·'810817'·'1981-08-17' → '810817'. 월 01~12·일 01~31이 아니면 빈칸(=미입력).
function birth6(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  const six = d.length === 8 ? d.slice(2) : (d.length === 6 ? d : '');
  if (!six) return '';
  const mo = Number(six.slice(2, 4)), da = Number(six.slice(4, 6));
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  return six;
}
// 범위 = 시작일이 sinceYear년 이후인 대장 행의 worker_ids(중복 제거). 반환 {scope, birth_blank, phone_blank, dup_pairs, ids_birth_blank, total_live, ref:{birth_blank_all, phone_blank_all}}
function wkMissing(workerRows, asbRows, sinceYear) {
  const since = String(sinceYear || WK_SINCE_YEAR) + '-01-01';
  const ws = live(workerRows);
  const byId = {}; ws.forEach(function (w) { byId[w.id] = w; });
  const scope = {};
  live(asbRows).forEach(function (r) { if (String(r.start || '') >= since) asList(r.worker_ids).forEach(function (id) { if (byId[id]) scope[id] = 1; }); });
  const ids = Object.keys(scope);
  const blankB = ids.filter(function (id) { return !birth6(byId[id].birth); });
  const blankP = ids.filter(function (id) { return blank(byId[id].phone); });
  // 동명이인 의심(이름만 같음) — 수만 센다(이름 값은 내보내지 않음)
  const names = {}; ws.forEach(function (w) { const n = String(w.name || '').replace(/\s+/g, '').trim(); if (n) names[n] = (names[n] || 0) + 1; });
  let dup = 0; Object.keys(names).forEach(function (n) { if (names[n] > 1) dup += names[n] * (names[n] - 1) / 2; });
  return { scope: ids.length, birth_blank: blankB.length, phone_blank: blankP.length, dup_pairs: dup, ids_birth_blank: blankB, total_live: ws.length,
    ref: { birth_blank_all: ws.filter(function (w) { return !birth6(w.birth); }).length, phone_blank_all: ws.filter(function (w) { return blank(w.phone); }).length } };
}

// 월 키 — KST 날짜 기준(브리핑 3-1: 러너 UTC 날짜로 세면 08:10 정시 기동 때 전날·월초엔 전월)
function monthKeyOf(today) { return String(today).slice(0, 7); }

// ---- P1 판2(원장 T693·T364): 차량 만기 '다시 지시' — 기존 D-30 차량 규칙(veh:<id>:<insp|ins>:<만료일>, 스위치 무관)에 더한 갈래 ----
// 만료일이 오늘보다 앞(지남)인데 그 만료일 키의 지시가 이미 완료(done)되어 같은 키로는 다시 생기지 않는 차 → 키 끝에 ':re:<YYYY-MM>'(달마다 한 번) 붙여 새 지시.
// 조건: 회색 3종 제외 · 같은 만료일 키(원 키 + ':re:' 키들, 지운 것 제외) 중 완료가 1건 이상 · 진행·보류·승인 대기 0건 · 이번 달 다시 키가 없음(지운 것 포함 — 지웠으면 다음 달).
// 앱 index.html vehRedoItems와 같은 규칙(uismoke P1 판2가 같은 표본에서 대조). 반환 [{auto_key, id, kind, due, days, title, detail}] — 이름·연락처 없음(차번호는 기존 D-30 제목과 같음).
const VEH_DUE_KIND = { insp: { f: 'insp_due', label: '정기검사' }, ins: { f: 'ins_due', label: '보험' } };
function vehRedo(vehRows, taskRows, today) {
  const vt = live(taskRows).filter(function (t) { return typeof t.auto_key === 'string' && t.auto_key.indexOf('veh:') === 0; });
  const anyKey = {}; asList(taskRows).forEach(function (t) { if (t && typeof t.auto_key === 'string') anyKey[t.auto_key] = 1; });
  const out = [];
  live(vehRows).forEach(function (v) {
    if (GREY.indexOf(String(v.state || '')) >= 0) return;
    ['insp', 'ins'].forEach(function (kind) {
      const cur = v[VEH_DUE_KIND[kind].f];
      if (!isDate(cur)) return;
      const dd = dayDiff(cur, today);
      if (dd === null || dd >= 0) return;   // 지난 것만
      const base = 'veh:' + v.id + ':' + kind + ':' + cur;
      const same = vt.filter(function (t) { return t.auto_key === base || t.auto_key.indexOf(base + ':re:') === 0; });
      if (!same.some(function (t) { return t.status === 'done'; })) return;
      if (same.some(function (t) { return t.status !== 'done'; })) return;
      const key = base + ':re:' + monthKeyOf(today);
      if (anyKey[key]) return;
      const lb = VEH_DUE_KIND[kind].label;
      out.push({ auto_key: key, id: v.id, kind: kind, due: cur, days: dd,
        title: (String(v.no || '') || '차량') + ' ' + lb + ' 갱신 — 다시(완료 뒤 만기일 그대로)',
        detail: '지난 지시는 완료됐지만 차량 ' + lb + ' 만기일이 ' + cur + ' 그대로입니다. 갱신했으면 완료할 때 새 만기일을 넣어 주세요.' });
    });
  });
  return out;
}
function siteKey(today) { return 'site:missing:' + monthKeyOf(today); }
function wkKey(today) { return 'wk:missing:' + monthKeyOf(today); }

// 산출물 PII 가드 — 값 문자열에 한글 이름 꼴·전화번호·생년월일(6자리 숫자)이 들어가면 거부(브리핑 §7 1회차 중단 조건). id·수·날짜·키만 통과.
function piiScan(obj) {
  const s = JSON.stringify(obj || {});
  if (/01[016789]-?\d{3,4}-?\d{4}/.test(s)) return 'PHONE';
  if (/"(?:name|이름|birth|생년월일|phone|연락처)":/.test(s)) return 'FIELD';
  return '';
}

module.exports = { GREY, VEH90_MIN, VEH90_MAX, WK_SINCE_YEAR, live, isDate, dayDiff, siteMissing, veh90, birth6, wkMissing, monthKeyOf, siteKey, wkKey, piiScan, VEH_DUE_KIND, vehRedo };
