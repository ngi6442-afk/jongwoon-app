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
// v412 일몰(설계 §5): 기준선 = 유형(양식)별 첫 10건 간극 평균(동결) · 기준선 뒤 4주 · 기준선 뒤 최근 10건(5건 이상)이 줄지 않으면 off
const SUNSET_DAYS = 28, SUNSET_BASE_N = 10, SUNSET_RECENT_N = 10, SUNSET_MIN_AFTER = 5;
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
    if (scope === 'field_default' && typeof r.value === 'string' && r.value.trim()) row.value = r.value.replace(/\s+/g, ' ').trim().slice(0, 120);   // 계약판: 기본값(허용 사전 안의 칸만 값이 보이므로 여기까지 온 값은 허용된 것)
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
  if (x.baseline && typeof x.baseline === 'object') e.baseline = x.baseline;   // v412 계약판만 쓴다(블로그 lessons엔 키가 생기지 않는다)
  if (x.sunset && typeof x.sunset === 'object') e.sunset = x.sunset;
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

// ---- 계약 서류판 프롬프트(v411, D4 3일차) — 모델이 규칙을 쓴다. 허용 사전(R2)에 든 셀만 값이 보이고, 나머지 셀은 '바뀜/안 바뀜'만 보인다. ----
const CONTRACT_SYSTEM = [
  '당신은 준설·폐기물·석면·철거 회사의 계약 서류 채움 코치입니다.',
  '회사 앱이 양식(xlsx)의 칸을 자동으로 채운 초안과, 담당 직원이 그 초안을 고쳐 제출한 최종본을 칸(셀) 단위로 비교합니다.',
  '목표: 다음 초안이 처음부터 최종본에 가깝게 나오도록, 앱이 지킬 규칙을 뽑아 기존 규칙과 합쳐 돌려줍니다.',
  '',
  '규칙을 쓰는 법',
  '- scope는 다섯 중 하나: field_default(어떤 칸을 처음부터 어떤 값·형식으로 채운다 — field에 셀 좌표, value에 그 값), format(날짜·단위·표기 형식), structure(행 순서·줄 수), content(넣는다/넣지 않는다), style(표현).',
  '- 값이 보이는 칸에서 직원이 매번 같은 값으로 고친 칸만 field_default로 씁니다. 이 건에만 해당하는 값(공사명·금액·날짜)은 규칙이 아닙니다.',
  '- 값이 안 보이는 칸(바뀜/안 바뀜만 있는 칸)은 "자주 바뀌는 칸"이라는 사실만 content 규칙으로 쓸 수 있고, 값을 추측해 쓰지 않습니다.',
  '- 한 규칙은 백이십 자 이내, 한 가지만. 감상·추측은 쓰지 않습니다. 사람 이름·주민번호·연락처·계좌는 어떤 규칙에도 넣지 않습니다.',
  '- 기존 규칙과 합칩니다: 같은 뜻이면 하나로 합치고 근거 수(n)를 더합니다. 모순되면 이번 쪽으로 고칩니다. 확인되지 않은 기존 규칙도 지우지 않고 유지합니다.',
  '- 전체 25개 이내.',
  '',
  '출력은 JSON 하나: summary(이번 비교 요약 이백 자 이내) · changes(바뀐 점 목록, 각 kind=field_default|format|structure|content|style, what 백 자 이내, 최대 열둘) · rules(합쳐진 전체 규칙 목록 — text, scope, n(정수), keep_id(기존 규칙 id 또는 빈 문자열), field(field_default면 셀 좌표, 아니면 빈 문자열), value(field_default면 기본값, 아니면 빈 문자열)).',
].join('\n');
const CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changes: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['field_default', 'format', 'structure', 'content', 'style'] }, what: { type: 'string' } }, required: ['kind', 'what'], additionalProperties: false } },
    rules: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, scope: { type: 'string', enum: ['field_default', 'format', 'structure', 'content', 'style'] }, n: { type: 'integer' }, keep_id: { type: 'string' }, field: { type: 'string' }, value: { type: 'string' } }, required: ['text', 'scope', 'n', 'keep_id', 'field', 'value'], additionalProperties: false } },
  },
  required: ['summary', 'changes', 'rules'],
  additionalProperties: false,
};
// o: {tpl, rules, rows:[{ref, draft, final, visible}], hidden_changed:[ref], hidden_same_n}
function buildContractPrompt(o) {
  const rules = Array.isArray(o.rules) ? o.rules : [];
  const L = [];
  L.push('[기존 규칙 ' + rules.length + '개]  (id · scope · n · field · 규칙)');
  if (!rules.length) L.push('(없음 — 첫 학습)');
  rules.forEach(function (r) { L.push('- ' + r.id + ' · ' + r.scope + ' · ' + r.n + ' · ' + (r.field || '-') + ' · ' + r.text + (r.value ? ' (값: ' + r.value + ')' : '')); });
  L.push('');
  L.push('[양식] ' + String(o.tpl || ''));
  L.push('');
  L.push('[값이 보이는 칸 — 허용 사전 안] (셀 · 앱 초안 값 · 직원 최종본 값)');
  const vis = (Array.isArray(o.rows) ? o.rows : []).filter(function (r) { return r && r.visible; });
  if (!vis.length) L.push('(없음)');
  vis.forEach(function (r) { L.push('- ' + r.ref + ' · ' + JSON.stringify(String(r.draft === undefined || r.draft === null ? '' : r.draft)) + ' · ' + JSON.stringify(String(r.final === undefined || r.final === null ? '' : r.final))); });
  L.push('');
  L.push('[값이 안 보이는 칸] 바뀐 칸: ' + ((o.hidden_changed || []).join(', ') || '(없음)') + ' · 안 바뀐 칸 수: ' + (Number(o.hidden_same_n) || 0));
  L.push('');
  L.push('위 차이에서 규칙을 뽑고 기존 규칙과 합쳐 JSON으로만 답하십시오.');
  return { system: CONTRACT_SYSTEM, user: L.join('\n'), schema: CONTRACT_SCHEMA };
}
// 절대 금지 패턴(설계 §5 2층: 주민번호·연락처·계좌) — 마스킹하지 않고 걸리면 전송 중단(fail-closed). 호출부가 사유 코드만 남긴다(값 로그 금지).
// 계좌 패턴은 마지막 묶음 5자리 이상(또는 4묶음) — 'YYYY-MM-DD' 날짜(4-2-2)는 잡지 않는다. 사업자번호(3-2-5)는 잡힌다(보수적 — 허용 사전에서 빼면 된다).
const PII_RE = [/\d{6}\s*-\s*[1-4]\d{6}/, /01\d[\s-]?\d{3,4}[\s-]?\d{4}/, /\b\d{2,6}-\d{2,6}-\d{5,8}\b/, /\b\d{2,6}-\d{2,6}-\d{2,6}-\d{1,8}\b/];
function piiScan(obj) {
  let s; try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (e) { return { ok: false, code: 'SERIALIZE' }; }
  for (let i = 0; i < PII_RE.length; i++) { if (PII_RE[i].test(s)) return { ok: false, code: 'PII_' + i }; }
  return { ok: true, code: '' };
}
// 내부 토큰으로 배경 워커 기동(블로그 kickLearnWorker와 같은 축)
async function kickWorker(fnName, body) {
  const { issueSession } = require('./session');
  const s = issueSession({ id: '__promoai__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/' + fnName, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token }, body: JSON.stringify(body || {}) });
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) { return { ok: false, code: 'KICKOFF_FAILED' }; }
}
// 생성에 넣을 칸 기본값 — field_default 규칙 중 허용 사전에 든 셀·근거 2건 이상·값 있음. 반환 {ref: value}
function fieldDefaults(L0, allowRefs) {
  const L = normLessons(L0); const out = {};
  if (L.off) return out;
  const A = {}; (Array.isArray(allowRefs) ? allowRefs : []).forEach(function (r) { A[String(r).toUpperCase()] = 1; });
  L.rules.forEach(function (r) {
    if (!r || r.scope !== 'field_default' || !r.field || !r.value) return;
    const ref = String(r.field).toUpperCase();
    if (!A[ref] || (Number(r.n) || 0) < 2) return;
    if (!out[ref] || (Number(r.n) || 0) > (out[ref].n || 0)) out[ref] = { v: String(r.value).slice(0, 120), n: Number(r.n) || 0, id: r.id };
  });
  const flat = {}; Object.keys(out).forEach(function (k) { flat[k] = out[k].v; });
  return flat;
}

// ---- v412 기준선·일몰(계약판 호출부만 부른다 — 블로그 lessons 불변) ----
function numericGaps(L) { return (L.gaps || []).filter(function (x) { return x && typeof x.ratio === 'number'; }).slice().sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); }); }
function avgRatio(arr) { return arr.length ? arr.reduce(function (s2, x) { return s2 + x.ratio; }, 0) / arr.length : null; }
// 기준선 동결(제자리 수정): 숫자 간극이 10건에 닿는 순간 첫 10건 평균을 L.baseline에 적는다. 이미 있으면 그대로(간극이 60건 넘어 잘려도 기준선은 남는다).
function freezeBaseline(L, now) {
  if (!L || typeof L !== 'object' || (L.baseline && typeof L.baseline === 'object')) return L;
  const g = numericGaps(L);
  if (g.length < SUNSET_BASE_N) return L;
  const b = g.slice(0, SUNSET_BASE_N);
  L.baseline = { avg: avgRatio(b), n: b.length, first_ts: Number(b[0].ts) || 0, ts: Number(now) || Date.now() };
  return L;
}
// 일몰 판정(순수) — {due, why, base_avg, recent_avg, n_base, n_recent}. why: already_off·no_calls(모델이 배운 적 없음)·no_baseline·too_early·too_few·not_improved(due)·improving
function sunsetCheck(L0, now) {
  const L = normLessons(L0); now = Number(now) || Date.now();
  const out = { due: false, why: '', base_avg: null, recent_avg: null, n_base: 0, n_recent: 0 };
  if (L.off) { out.why = 'already_off'; return out; }
  if (!((Number(L.stats.calls) || 0) >= 1)) { out.why = 'no_calls'; return out; }
  const b = L.baseline; if (!b || typeof b.avg !== 'number') { out.why = 'no_baseline'; return out; }
  out.base_avg = b.avg; out.n_base = Number(b.n) || 0;
  if (now - (Number(b.ts) || 0) < SUNSET_DAYS * 86400000) { out.why = 'too_early'; return out; }
  const after = numericGaps(L).filter(function (x) { return (Number(x.ts) || 0) > (Number(b.ts) || 0); }).slice(-SUNSET_RECENT_N);
  out.n_recent = after.length;
  if (after.length < SUNSET_MIN_AFTER) { out.why = 'too_few'; return out; }
  out.recent_avg = avgRatio(after);
  out.due = out.recent_avg >= out.base_avg; out.why = out.due ? 'not_improved' : 'improving';
  return out;
}

module.exports = {
  freezeBaseline, sunsetCheck, SUNSET_DAYS, SUNSET_BASE_N, SUNSET_RECENT_N, SUNSET_MIN_AFTER,
  CONTRACT_SYSTEM, CONTRACT_SCHEMA, buildContractPrompt, PII_RE, piiScan, kickWorker, fieldDefaults,
  TYPES, MAX_RULES, RULE_CHARS, EXEMPLAR_CHARS, MAX_GAPS, MAX_TRIES, LOCK_TTL_MS, RUNNING_STALE_MS, RETRY_WAIT_MS, SCOPES4, RE_REC_ID,
  hash32, pairKey, newPairId, usageKey, ymOf,
  normRules, emptyLessons, normLessons, pushGap, mergeLessons, lessonLines, exemplarFor, gapSummary, pickPending, usageOk, usageAdd,
};
