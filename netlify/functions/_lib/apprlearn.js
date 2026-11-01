'use strict';
// 결재(appr) 학습 신호 집계(v413, 착수 브리핑 C2-1) — 모델 호출 없음·토큰 0(설계 §3-14 appr 단계 메모: "AI 산출은 카드 기본값 3필드뿐이라 clog:appr 집계→배정표·리드 delta 카드로 충분").
// 입력 = clog:appr:<YYYY-MM> 행 {ts, id, f(who_id|due|del|status), from/to('set'·'' 표식, 값 없음), why(notmine|edit|data:…), p(접두어), d(기한 변경 일수), by}
// 출력 = lessons:appr {schema, ym, prefixes{접두어: 집계}, rules[≤25], updated_at}. 규칙 = 사람이 읽는 delta 문구(배정표 R1 재카드·리드 개정 제안) — 사람이 규칙을 쓰지 않는다.
const MAX_RULES = 25;
const RECARD_N = 3;      // 접두어별 [내 것 아님] 월 3건 → R1 재카드(브리핑 §6)
const RECARD_WHO = 2;    // 또는 2인 이상
const LEAD_MIN = 3;      // 기한 변경 3건부터 중앙값 제안(bg:appr:rule R2)

function prefixOf(autoKey) { const k = String(autoKey || ''); const i = k.indexOf(':'); return i > 0 ? k.slice(0, i + 1) : ''; }
function dayDiff(a, b) {
  const re = /^\d{4}-\d{2}-\d{2}$/; if (!re.test(String(a || '')) || !re.test(String(b || ''))) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function tally(rows, ym) {
  const P = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (!r || !r.p) return;
    const x = P[r.p] = P[r.p] || { notmine: 0, _who: {}, who_edit: 0, due_edit: 0, _days: [], del: 0, reject: 0 };
    if (r.f === 'who_id' && r.why === 'notmine') { x.notmine++; if (r.by) x._who[String(r.by)] = 1; }
    else if (r.f === 'who_id') x.who_edit++;
    else if (r.f === 'due') { x.due_edit++; if (typeof r.d === 'number') x._days.push(r.d); }
    else if (r.f === 'del') x.del++;
    else if (r.f === 'status' && r.why === 'reject') x.reject++;
  });
  const recard = [], lead = [];   // 재카드(배정) 규칙을 앞에, 리드 제안은 뒤에
  Object.keys(P).sort().forEach(function (p) {
    const x = P[p];
    x.notmine_who_n = Object.keys(x._who).length; delete x._who;
    x.recard = x.notmine >= RECARD_N || x.notmine_who_n >= RECARD_WHO;
    const s = x._days.slice().sort(function (a, b) { return a - b; }); delete x._days;
    x.due_med = s.length ? s[Math.floor(s.length / 2)] : null;
    if (x.recard) recard.push({ id: 'recard:' + p + ':' + ym, text: p + ' 접두어 [내 것 아님] ' + ym + ' ' + x.notmine + '건(' + x.notmine_who_n + '인) → 배정표 R1 재카드', scope: 'assign', n: x.notmine, p: p });
    if (s.length >= LEAD_MIN) lead.push({ id: 'lead:' + p + ':' + ym, text: p + ' 기한 변경 ' + x.due_edit + '건 · 중앙값 ' + (x.due_med > 0 ? '+' : '') + x.due_med + '일 → 리드 개정 제안(bg:appr:rule R2)', scope: 'lead', n: x.due_edit, p: p, d: x.due_med });
  });
  return { schema: 1, ym: String(ym || ''), prefixes: P, rules: recard.concat(lead).slice(0, MAX_RULES), updated_at: 0 };
}
module.exports = { prefixOf, dayDiff, tally, MAX_RULES, RECARD_N, RECARD_WHO, LEAD_MIN };
