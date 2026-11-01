'use strict';
// 학습 루프 공통 코어(v410, 계약 D4 1일차 — 설계 §5 "promolearn.js의 pickPending·normRules·mergeLessons·gapSummary·잠금을 _lib/learn.js로 승격").
//
// 골격(블로그 v389~v394 그대로): 초안 보존 → 짝 → 워커 1건 → 모델이 차이를 규칙(≤25)·예시·간극으로 병합 → 다음 생성 주입 → 끄기 스위치만.
// 유형 등록표 TYPES로 블로그(promo)·계약 서류(contract)를 같은 함수가 다룬다. 블로그 키·동작은 promolearn.js가 이 코어를 같은 인자로 부르므로 불변(servertest 절 48).
// 사람(PM·직원·개발자)은 규칙을 쓰지 않는다(PM 10/19·10/20·11/1). 셀 값·개인정보는 어떤 블롭에도 넣지 않는다(좌표·변경 여부·횟수만).

const MAX_RULES = 25;
const RULE_CHARS = 120;
const EXEMPLAR_CHARS = 1500;
const MAX_GAPS = 60;
const MAX_TRIES = 3;
const LOCK_TTL_MS = 5 * 60 * 1000;
const RUNNING_STALE_MS = 15 * 60 * 1000;
const RETRY_WAIT_MS = 10 * 60 * 1000;
const SCOPES4 = { style: 1, format: 1, structure: 1, content: 1 };

// 유형 등록표 — 새 유형 = 여기 1행(설계 §5 '유형 등록표 1장'). 키 접두어·짝 id 형식·scope·금지 유형·월 상한.
const TYPES = {
  promo: {
    pair_prefix: 'promolearn:in:', pair_re: /^pl_[a-f0-9]{12}$/, lock_key: 'promolearn:lock',
    lessons_key: function () { return 'promoai:lessons'; },
    scopes: SCOPES4, monthly_cap: 0,                      // 0 = 상한 없음(블로그는 기존 그대로)
  },
  contract: {
    pair_prefix: 'learn:contract:in:', pair_re: /^lc_[a-f0-9]{12}$/, lock_key: 'learn:contract:lock',
    lessons_key: function (tpl) { return 'lessons:contract:' + String(tpl || 'default').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40); },
    scopes: Object.assign({ field_default: 1 }, SCOPES4),   // 계약판: '필드 기본값' 규칙(대상 필드 키 포함)
    monthly_cap: 200,                                       // usage:learn:contract:<YYYY-MM> 월 상한(설계 추정값)
    // 유형 자체 제외(설계 §5 차단 경계): 건강진단 결과표·근로자 명단·신분증 — 마스킹에 기대지 않고 짝을 만들지 않는다
    forbid_re: /검진|건강|명단|명부|신분증|주민|health|roster/i,
    settings_key: 'settings:learn',
  },
};
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;

function hash32(s) { let h = 2166136261; const t = String(s || ''); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
function pairKey(type, id) { return TYPES[type].pair_prefix + id; }
function newPairId(type, seed) { return (type === 'promo' ? 'pl_' : 'lc_') + (hash32(String(seed) + ':' + Date.now()) + hash32(String(seed) + ':' + Math.random())).slice(0, 12); }
function usageKey(type, ym) { return 'usage:learn:' + type + ':' + ym; }
function ymOf(now) { return new Date((now || Date.now()) + 9 * 3600000).toISOString().slice(0, 7); }

// ---- 규칙 창고(유형 공통) ----
// 모델 출력 → 규칙 목록 정리(화이트리스트·길이·개수). 금지 문자열 검사는 워커가 한다. scope는 유형 등록표의 집합만.
function normRules(out, oldRules, scopes) {
  const S = scopes || SCOPES4;
  const old = {}; (oldRules || []).forEach(function (r) { if (r && r.id) old[r.id] = r; });
  const seen = {}; const res = [];
  (Array.isArray(out && out.rules) ? out.rules : []).forEach(function (r) {
    if (!r) return;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, RULE_CHARS);
    const scope = S[r.scope] ? r.scope : 'style';
    if (!text || seen[text]) return;
    seen[text] = 1;
    let id = (typeof r.keep_id === 'string' && old[r.keep_id]) ? r.keep_id : '';
    if (!id) { for (const k in old) { if (old[k].text === text) { id = k; break; } } }
    if (!id) id = 'r' + hash32(text);
    // 근거 수 — 모델이 센 값과 "기존 규칙이면 +1"(모델이 안 세어도 누적되게) 중 큰 쪽
    const modelN = Math.floor(Number(r.n) || 0);
    const n = old[id] ? Math.max(modelN, (Number(old[id].n) || 1) + 1) : Math.max(1, modelN);
    const row = { id: id, text: text, scope: scope, n: n, first: old[id] ? old[id].first : 0, last: 0 };
    if (scope === 'field_default' && typeof r.field === 'string' && r.field.trim()) row.field = r.field.trim().slice(0, 40);   // 계약판: 대상 필드 키
    res.push(row);
  });
  return res.slice(0, MAX_RULES);
}
function emptyLessons() { return { schema: 1, off: false, rules: [], exemplars: {}, gaps: [], stats: { pairs: 0, calls: 0, tokens: 0 }, updated_at: 0 }; }
function normLessons(x) {
  const e = emptyLessons();
  if (!x || typeof x !== 'object') return e;
  e.off = x.off === true;
  e.rules = Array.isArray(x.rules) ? x.rules.filter(function (r) { return r && r.id && r.text; }).slice(0, MAX_RULES) : [];
  e.exemplars = (x.exemplars && typeof x.exemplars === 'object') ? x.exemplars : {};
  e.gaps = Array.isArray(x.gaps) ? x.gaps.slice(-MAX_GAPS) : [];
  e.stats = Object.assign({ pairs: 0, calls: 0, tokens: 0 }, (x.stats && typeof x.stats === 'object') ? x.stats : {});
  e.updated_at = Number(x.updated_at) || 0;
  return e;
}
// 간극 1건만 쌓기(모델 호출 없음 — 계약판 허용 사전 전, 또는 블로그 외 유형의 측정만). entry는 호출부가 좌표·횟수만 담아 넘긴다.
function pushGap(oldL, entry, now) {
  const L = normLessons(oldL);
  const e = Object.assign({}, entry || {}); e.ts = Number(now) || Date.now();
  L.gaps.push(e);
  if (L.gaps.length > MAX_GAPS) L.gaps = L.gaps.slice(-MAX_GAPS);
  L.stats.pairs = (Number(L.stats.pairs) || 0) + 1;
  L.updated_at = e.ts;
  return L;
}
// 학습 결과 병합(순수) — ctx {rec_id, pair_id, ex_key(예시 분기키), ex_title, ex_excerpt(호출부가 이미 정리한 발췌), now, tokens, gap, summary, extra(간극 추가 필드)}
function mergeLessons(oldL, out, ctx, scopes) {
  const L = normLessons(oldL);
  const now = Number(ctx.now) || Date.now();
  const rules = normRules(out, L.rules, scopes);
  rules.forEach(function (r) { if (!r.first) r.first = now; r.last = now; });
  L.rules = rules;
  const fk = String(ctx.ex_key || 'default');
  L.exemplars[fk] = { promo_id: String(ctx.rec_id || ''), title: String(ctx.ex_title || '').slice(0, 80), excerpt: String(ctx.ex_excerpt || '').slice(0, EXEMPLAR_CHARS), ts: now, gap: ctx.gap ? ctx.gap.ratio : null };
  const g = { promo_id: String(ctx.rec_id || ''), pair: String(ctx.pair_id || ''), ts: now, ratio: ctx.gap ? ctx.gap.ratio : null };
  Object.keys(ctx.extra || {}).forEach(function (k) { g[k] = ctx.extra[k]; });
  g.summary = String(ctx.summary || '').slice(0, 200);
  if (ctx.layout !== undefined) g.layout = ctx.layout;
  L.gaps.push(g);
  if (L.gaps.length > MAX_GAPS) L.gaps = L.gaps.slice(-MAX_GAPS);
  L.stats.pairs = (Number(L.stats.pairs) || 0) + 1;
  L.stats.calls = (Number(L.stats.calls) || 0) + 1;
  L.stats.tokens = (Number(L.stats.tokens) || 0) + (Number(ctx.tokens) || 0);
  L.updated_at = now;
  return L;
}
// 생성 프롬프트에 넣을 규칙 줄(근거 많은 순). off면 빈 배열.
function lessonLines(L0) {
  const L = normLessons(L0);
  if (L.off || !L.rules.length) return [];
  return L.rules.slice().sort(function (a, b) { return (Number(b.n) || 0) - (Number(a.n) || 0); }).slice(0, MAX_RULES)
    .map(function (r) { return String(r.text).slice(0, RULE_CHARS) + ((Number(r.n) || 1) > 1 ? ' (근거 ' + r.n + '건)' : ''); });
}
// 분기키 예시 → 없으면 가장 최근 것. off면 null. keyNorm은 유형별 키 정규화(블로그=시설명 공백 제거 20자).
function exemplarFor(L0, key, keyNorm) {
  const L = normLessons(L0);
  if (L.off) return null;
  const fk = (typeof keyNorm === 'function' ? keyNorm(key) : String(key || '')) || 'default';
  let ex = L.exemplars[fk] || null, k2 = fk;
  if (!ex) { for (const k in L.exemplars) { const e = L.exemplars[k]; if (e && e.excerpt && (!ex || (Number(e.ts) || 0) > (Number(ex.ts) || 0))) { ex = e; k2 = k; } } }
  if (!ex || !ex.excerpt) return null;
  return { title: String(ex.title || ''), excerpt: String(ex.excerpt || '').slice(0, EXEMPLAR_CHARS), facility_key: k2, promo_id: String(ex.promo_id || '') };
}
function gapSummary(L0) {
  const L = normLessons(L0);
  const g = L.gaps.filter(function (x) { return x && typeof x.ratio === 'number'; });
  const avg = function (arr) { return arr.length ? Math.round(arr.reduce(function (s, x) { return s + x.ratio; }, 0) / arr.length * 1000) / 10 : null; };
  const last5 = g.slice(-5), prev5 = g.slice(-10, -5);
  const a = avg(last5), b = avg(prev5);
  return { n: g.length, last5_avg: a, prev5_avg: b, trend: (a === null || b === null) ? '' : (a < b ? 'down' : (a > b ? 'up' : 'flat')) };
}
// 크론이 기동할 짝 고르기 — pending 우선, running은 15분 넘게 그대로면 죽은 것, fail은 10분 뒤 재시도(3회까지). rec_id 없는(미매칭) 짝은 제외.
// 화이트리스트: 집는 상태는 pending · 죽은 running · 재시도 fail 셋만(10/20 실사고 — superseded 짝 오학습).
function pickPending(pairs, now, pairRe, recField) {
  now = now || Date.now();
  const RE = pairRe || TYPES.promo.pair_re, F = recField || 'promo_id';
  const out = [];
  (Array.isArray(pairs) ? pairs : []).forEach(function (p) {
    if (!p || !RE.test(String(p.id || '')) || !RE_REC_ID.test(String(p[F] || ''))) return;
    const st = String(p.status || 'pending'), ts = Number(p.ts) || 0, tries = Number(p.tries) || 0;
    if (st === 'pending') { out.push(p); return; }
    if (st === 'running') { if (now - ts >= RUNNING_STALE_MS && tries < MAX_TRIES) out.push(p); return; }
    if (st === 'fail') { if (tries < MAX_TRIES && now - ts >= RETRY_WAIT_MS) out.push(p); return; }
  });
  out.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
  return out;
}
// 월 상한 — usage 블롭 {ym, calls, tokens}. cap 0 = 상한 없음.
function usageOk(usage, cap) { return !cap || (Number((usage || {}).calls) || 0) < cap; }
function usageAdd(usage, ym, tokens) { const u = (usage && usage.ym === ym) ? usage : { ym: ym, calls: 0, tokens: 0 }; u.calls = (Number(u.calls) || 0) + 1; u.tokens = (Number(u.tokens) || 0) + (Number(tokens) || 0); u.ts = Date.now(); return u; }

module.exports = {
  TYPES, MAX_RULES, RULE_CHARS, EXEMPLAR_CHARS, MAX_GAPS, MAX_TRIES, LOCK_TTL_MS, RUNNING_STALE_MS, RETRY_WAIT_MS, SCOPES4, RE_REC_ID,
  hash32, pairKey, newPairId, usageKey, ymOf,
  normRules, emptyLessons, normLessons, pushGap, mergeLessons, lessonLines, exemplarFor, gapSummary, pickPending, usageOk, usageAdd,
};
