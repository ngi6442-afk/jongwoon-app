'use strict';

// v433(메뉴 56 6단계, PM 11/9 "56. ㄱ" — 확인 항목 기본안 '이름으로'): 현장 대장 '특별교육 미이수' 판정 — 순수 함수(저장소·네트워크 없음).
// gw-data site_edu_gap이 쓴다. 안전 권한(교육·검진 기록 읽기)이 없는 현장 권한자(김정아·정재욱)는 교육 기록을 못 읽어 앱이 판정할 수 없으므로
// 서버가 현장(대장 id)마다 '투입 인원 중 유효한 특별교육 기록이 없는 사람 이름'만 골라 준다 — 교육 기록 자체(종류·이수일·다음 예정·건강진단)는 내보내지 않는다.
//
// 앱 index.html의 asbNoSpecial · eduHasValidSpecial(eduLatest) · asList · memberName(findMember) · dispName(isBossMember)과 **같은 규칙** — 바꾸면 동시에.
//   uismoke v433 ①이 index.html에서 그 함수들을 뽑아 같은 표본(종결·삭제 대장 · 삭제 일용직 · special 아닌 기록 · 지운 기록 · 기록 여러 건 · 이름 같은 사람 ·
//   대표 · 퇴사자 · 삭제 회원 · 토큰 · 문자열 칸)에서 이 함수와 같은 사람·같은 순서를 내는지 대조한다.
//   - 대장: 지운 줄(del 1)·종결(status done) 빼고(앱 renderSites가 그리는 줄 + 종결이면 건너뜀) — 준설·철거 현장까지 검사(앱 지금 범위 그대로, 종류를 좁히면 화면이 바뀐다)
//   - 유효한 특별교육 기록 = 지우지 않은 교육 기록 중 같은 대상(ptype member|worker)·같은 사람(pid)·종류 special이 1건이라도 있음
//     (앱 eduHasValidSpecial = eduLatest(…, "special")가 null이 아님 — 이수일·다음 예정일은 보지 않는다)
//   - 직원 이름 = 회원 명부(지운 회원 제외·퇴사자는 남김 — 앱이 받는 member_list와 같은 범위·순서)에서 id로 찾은 이름. 대표는 '대표님'(앱 dispName — 등급 판정은 tier.js),
//     '__all__'은 '전사'(앱 memberName), dept:·rank: 같은 토큰·없는 id·이름 없는 회원은 뺀다
//   - 일용직 이름 = 명부(col:workers)에서 지우지 않은 같은 id의 첫 줄 이름(지운 일용직·없는 id·빈 이름은 뺀다)
//   - 순서 = 그 현장의 member_ids 순(직원) 다음 worker_ids 순(일용직) — 앱과 같음
//   - 같은 대장 id가 두 줄이면 앞 줄(지운·종결 줄을 뺀 뒤 첫 줄)만 — 앱 siteGapSigs(서명)도 같은 줄을 고른다
// has_edu = 지우지 않은 교육 기록이 1건이라도 있나(종류 무관). 앱은 0건이면 '교육 기록 없음 — 이수 여부 미확인'을 그리고 이름을 쓰지 않는다.
// opts.workerNames === false(v433 검토 — 일용직 권한 wk가 숨김인 사람): 일용직은 이름 대신 현장별 수만 wk_n에 — 그 사람은 일용직 명부(col:workers)를 못 읽고
//   v433 전 화면에도 일용직 이름이 없었다(앱은 명부를 일용직 권한일 때만 읽음). 수는 이름을 냈을 사람 수와 같다(지운 일용직·없는 id·빈 이름은 세지 않음).
const tier = require('./tier');

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// 앱 asList와 같은 식 — 배열 자리에 문자열 "[]"·JSON 문자열·쉼표 문자열·그 밖의 값이 와도 배열로(v336 사고 입구 교정)
function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '[]') return [];
    if (s.charAt(0) === '[') { try { const p = JSON.parse(s); if (Array.isArray(p)) return p; } catch (e) { /* 깨진 JSON은 쉼표 문자열로 */ } }
    return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }
  return [];
}

// 앱이 받는 회원 목록과 같은 범위·순서 — gw-auth listMembers(지운 회원 제외, 연번 seq 오름차순 → 없는 것은 뒤로, 같으면 이름순)
function memberList(members) {
  const out = (Array.isArray(members) ? members : []).filter(function (m) { return m && typeof m === 'object' && m.del !== 1; });
  out.sort(function (a, b) {
    const sa = (typeof a.seq === 'number') ? a.seq : 1e9;
    const sb = (typeof b.seq === 'number') ? b.seq : 1e9;
    if (sa !== sb) return sa - sb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return out;
}

// sites = col:asbestos items · eduItems = col:edu items · workers = col:workers items · members = 회원 레코드 전부(지운 회원 포함 — 여기서 거른다)
// → { has_edu, gaps: { 대장id: [이름…] } } (opts.workerNames false면 + wk_n: { 대장id: 일용직 수 }) — 이름·수 말고 다른 값은 담지 않는다
function siteEduGaps(sites, eduItems, workers, members, opts) {
  const wkNames = !(opts && opts.workerNames === false);
  const ms = memberList(members);
  const boot = tier.isBootstrap(ms);
  const edu = (Array.isArray(eduItems) ? eduItems : []).filter(function (r) { return r && r.del !== 1; });
  const wk = Array.isArray(workers) ? workers : [];
  function findMember(id) { for (let i = 0; i < ms.length; i++) { if (ms[i].id === id) return ms[i]; } return null; }
  function memberName(id) { if (!id) return ''; if (id === '__all__') return '전사'; const m = findMember(id); return m ? m.name : ''; }
  function dispName(name) {
    if (!name) return '';
    if (name === '전사') return name;
    for (let i = 0; i < ms.length; i++) { if (ms[i].name === name) return tier.tierOf(ms[i], boot) === 'boss' ? '대표님' : name; }
    if (name === '나종운') return '대표님';
    return name;
  }
  function hasSpecial(ptype, pid) {
    for (let i = 0; i < edu.length; i++) { const r = edu[i]; if (r.ptype === ptype && r.pid === pid && r.kind === 'special') return true; }
    return false;
  }
  function workerName(id) {
    for (let i = 0; i < wk.length; i++) { const w = wk[i]; if (w && w.id === id && w.del !== 1) return w.name || ''; }
    return '';
  }
  const gaps = {}, wkN = {};
  (Array.isArray(sites) ? sites : []).forEach(function (r) {
    if (!r || typeof r !== 'object' || r.del === 1 || r.status === 'done' || r.id == null) return;
    const key = String(r.id);
    if (key === '__proto__' || hasOwn(gaps, key)) return;   // 같은 id 두 줄은 앞 줄만(대장 id는 하나씩 — 객체 원형 키는 받지 않는다)
    const out = [];
    let k = 0;
    asList(r.member_ids).forEach(function (id) { if (!hasSpecial('member', id)) { const n = dispName(memberName(id)); if (n) out.push(n); } });
    asList(r.worker_ids).forEach(function (id) { if (hasSpecial('worker', id)) return; const n = workerName(id); if (!n) return; if (wkNames) out.push(n); else k++; });
    gaps[key] = out;
    if (!wkNames) wkN[key] = k;
  });
  const has = edu.some(function (r) { return typeof r === 'object'; });
  return wkNames ? { has_edu: has, gaps: gaps } : { has_edu: has, gaps: gaps, wk_n: wkN };
}

module.exports = { asList, memberList, siteEduGaps };
