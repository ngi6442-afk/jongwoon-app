'use strict';
// 블로그 자동 학습(v389, PM 2026-10-19 "니가 아니라 모델이 학습하도록 — 모델 초안과 직원 수정 게시글의 차이를 학습해 간극을 줄여라").
//
// 구조(설계 브리핑 09_조사_문서/블로그_학습루프_재설계_브리핑_20261019.md):
//   초안 보존 promoai:draft:<기록id>  ←  워커가 생성 성공 때 저장(회차별, 최근 3건)
//   짝 블롭   promolearn:in:<pl_id>   ←  로컬 수집기(PM PC 폴더)·관리자 카드가 올린 {promo_id, final_title, final_body, status}
//   학습 워커 gw-promo-learn-background ← 크론(10분) ④가 pending 짝을 1건씩 기동 → 모델이 초안↔최종본 차이를 읽어
//   규칙 창고 promoai:lessons {rules[≤25], exemplars{시설키: 완성본 발췌}, gaps[간극 이력], stats, off}
//   → 다음 생성(buildPrompt)이 규칙·예시를 데이터로 받는다. 사람(개발자)은 규칙을 쓰지 않는다.
//
// 이 파일은 순수 함수 + 작은 I/O 도우미. 모델 호출·블롭 쓰기는 워커·크론·API가 한다(테스트는 여기 함수들을 직접 검증).
const { issueSession } = require('./session');

const LESSONS_KEY = 'promoai:lessons';
const PAIR_PREFIX = 'promolearn:in:';
const LOCK_KEY = 'promolearn:lock';
const LAYOUT_KEY = 'promoai:layout';     // v392 포장 측정 프로필(수집기가 실제 게시글을 재서 올림 — 줄 길이·정렬·간격·구분선·굵게·회사 소개)
const COPY_PREFIX = 'promoai:copy:';     // v394 복사 때 앱이 내보낸 줄 계획([텍스트, 표식]) — 게시글 final_layout과 비교해 포장 간극을 잰다
function copyKey(id) { return COPY_PREFIX + String(id || ''); }
function normLine(t) { return String(t || '').replace(/\s+/g, '').replace(/[.,!?？！·…\-–—"'“”‘’()\[\]]/g, ''); }
// 포장 간극 — 앱 복사본 줄 계획 ↔ 게시글 줄 배치. line_match = 게시글 글 줄 중 복사본에 같은 줄이 있는 비율(정규화), 나머지는 차이(게시글 − 복사본).
function layoutGap(copyLines, finalLines) {
  const C = Array.isArray(copyLines) ? copyLines : [], F = Array.isArray(finalLines) ? finalLines : [];
  const txt = function (L) { return L.filter(function (x) { return x && x[0] && x[1] !== 'i' && x[1] !== 'h'; }); };
  const cnt = function (L, f) { return L.filter(function (x) { return x && x[1] === f && !x[0]; }).length; };
  const blanks = function (L) { return L.filter(function (x) { return x && !x[0] && x[1] !== 'i' && x[1] !== 'h'; }).length; };
  const ct = txt(C), ft = txt(F);
  const set = Object.create(null); ct.forEach(function (x) { set[normLine(x[0])] = 1; });
  let hit = 0; ft.forEach(function (x) { if (set[normLine(x[0])]) hit++; });
  const ratio = function (L, ch) { return L.length ? L.filter(function (x) { return String(x[1] || '').indexOf(ch) >= 0; }).length / L.length : 0; };
  return {
    line_match: ft.length ? Math.round(1000 * hit / ft.length) / 1000 : null,
    bold_d: Math.round(100 * (ratio(ft, 'b') - ratio(ct, 'b'))) / 100,
    center_d: Math.round(100 * (ratio(ft, 'c') - ratio(ct, 'c'))) / 100,
    hr_d: cnt(F, 'h') - cnt(C, 'h'), img_d: cnt(F, 'i') - cnt(C, 'i'),
    blank_d: Math.round(100 * ((ft.length ? blanks(F) / ft.length : 0) - (ct.length ? blanks(C) / ct.length : 0))) / 100,
    n_copy: ct.length, n_final: ft.length,
  };
}
const MAX_RULES = 25;
const RULE_CHARS = 120;
const EXEMPLAR_CHARS = 1500;
const MAX_GAPS = 60;
const MAX_TRIES = 3;
const LOCK_TTL_MS = 5 * 60 * 1000;
const RUNNING_STALE_MS = 15 * 60 * 1000;
const RETRY_WAIT_MS = 10 * 60 * 1000;
const GAP_CHARS = 7000;                  // 편집거리 계산 상한(7,000×7,000 ≈ 0.3초)
const SCOPES = { style: 1, format: 1, structure: 1, content: 1 };
const RE_PAIR_ID = /^pl_[a-f0-9]{12}$/;
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;

function pairKey(id) { return PAIR_PREFIX + id; }
function draftKey(promoId) { return 'promoai:draft:' + promoId; }

// ---- 텍스트 정리 ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function cleanFinal(text) {
  let s = String(text === null || text === undefined ? '' : text);
  s = s.replace(/\r\n?/g, '\n').replace(/﻿/g, '').replace(/&#65279;/g, '');
  s = s.replace(/&#(\d+);/g, function (m, n) { const c = parseInt(n, 10); return (c > 31 && c !== 65279) ? String.fromCharCode(c) : ''; });
  s = s.replace(/&([a-z]+);/g, function (m, k) { return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m; });
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  s = s.split('\n').map(function (l) { return l.replace(/[ \t]+$/g, ''); }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
// 사진 마커([사진 3 : …]·"사진 3 : …" 줄)를 빼고 본문만 — 비교·예시용(앱 파서와 같은 두 형태만 다룬다)
function stripMarkers(text) {
  return String(text || '').split('\n').map(function (ln) {
    const t = ln.trim();
    if (/^[-*•]?\s*사진\s*[0-9][0-9,\s~\-–·과번]*\s*[:：]/.test(t)) return '';
    return ln.replace(/\[\s*사진\s*[0-9][^\]]*\]/g, '').replace(/[ \t]{2,}/g, ' ');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function normForGap(text) {
  return stripMarkers(text).toLowerCase().replace(/[\s ]+/g, '').replace(/[.,!?;:'"“”‘’()\[\]【】\-–—·…~]/g, '').slice(0, GAP_CHARS);
}
function levenshtein(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (prev[j - 1] + cost < v) v = prev[j - 1] + cost;
      cur[j] = v;
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}
function countLines(t) { return String(t || '').split('\n').filter(function (l) { return l.trim(); }).length; }
function countHeads(t) { return String(t || '').split('\n').filter(function (l) { const s = l.trim(); return s.length > 0 && s.length <= 45 && /[?？]$/.test(s); }).length; }
function countPhotos(t) { const s = String(t || ''); return (s.match(/\[\s*사진\s*[0-9]/g) || []).length + (s.split('\n').filter(function (l) { return /^\s*[-*•]?\s*사진\s*[0-9][0-9,\s~\-–·과번]*\s*[:：]/.test(l); }).length); }
// 간극 점수 — 초안과 최종본이 얼마나 다른지. ratio 0 = 같음, 1 = 전부 다름(정규화 편집거리). 구조 차이는 줄·소제목·사진 수 차.
function gapScore(draft, finalText) {
  const a = normForGap(draft), b = normForGap(finalText);
  const d = levenshtein(a, b);
  const base = Math.max(a.length, b.length, 1);
  return {
    ratio: Math.round((d / base) * 1000) / 1000,
    len_draft: a.length, len_final: b.length,
    lines_d: countLines(stripMarkers(finalText)) - countLines(stripMarkers(draft)),
    heads_d: countHeads(finalText) - countHeads(draft),
    photos_d: countPhotos(finalText) - countPhotos(draft),
  };
}
function facilityKey(rec) {
  const f = String((rec && rec.facility) || '').replace(/\s+/g, '').slice(0, 20);
  return f || 'default';
}
function hash32(s) { let h = 2166136261; const t = String(s || ''); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

// ---- 학습 프롬프트(모델이 규칙을 쓴다 — 개발자는 쓰지 않는다) ----
const LEARN_SYSTEM = [
  '당신은 준설·폐기물·석면·철거 회사의 블로그 편집 코치입니다.',
  '회사의 글쓰기 모델이 만든 초안과, 직원이 네이버에 올리기 전에 그 초안을 고친 최종본을 비교합니다.',
  '목표: 다음 초안이 처음부터 최종본에 가깝게 나오도록, 글쓰기 모델이 지킬 규칙을 뽑아 기존 규칙과 합쳐 돌려줍니다.',
  '',
  '규칙을 쓰는 법',
  '- 재현 가능한 지시문으로 씁니다("…로 끝낸다", "…는 쓰지 않는다", "사진 설명은 …"). 감상·칭찬·추측은 쓰지 않습니다.',
  '- 한 규칙은 백이십 자 이내, 한 가지만 말합니다.',
  '- 이 글에만 해당하는 사실(지역 이름·날짜·수치·고객·현장 상황)은 규칙이 아닙니다. 넣지 않습니다.',
  '- scope는 넷 중 하나: style(문체·어미·호칭·표현), format(포장 — 줄 길이·줄나눔·정렬·굵기·구분선·기호), structure(구성·순서·소제목·사진 배치·분량), content(내용 추가·삭제·금지어·회사명·연락처 배치).',
  '- 기존 규칙과 합칩니다: 같은 뜻이면 하나로 합치고 근거 수(n)를 더합니다. 이번 비교와 모순되면 이번 쪽으로 고칩니다. 이번 비교에서 확인되지 않은 기존 규칙도 지우지 않고 유지합니다(n 그대로).',
  '- 전체 25개 이내. 넘치면 근거 수가 적고 영향이 작은 것부터 뺍니다.',
  '- 직원이 지운 내용은 "쓰지 않는다"로 씁니다. 다만 금액·조문 번호 같은 숫자는 규칙에 넣지 않습니다.',
  '- 앱이 게시용으로 복사할 때 자동으로 붙이는 것 — 글 머리 고정 인사말("안녕하세요 … 종운환경입니다"), 회사 소개 카드, 글 끝 회사명·업무·주소·전화 카드, 해시태그 줄 — 은 글쓰기 모델의 몫이 아닙니다. 그것을 "덧붙인다"는 규칙으로 만들지 않습니다.',
  '- 줄 나누기·정렬·굵게·구분선 같은 포장도 앱이 복사할 때 자동으로 합니다. "짧은 줄로 나눈다", "가운데 정렬한다" 같은 줄 배치 규칙은 만들지 않습니다. 문장 자체를 짧게 쓰는 것(한 문장에 한 가지)은 style 규칙으로 쓸 수 있습니다.',
  '- 최종본에는 사진이 실제 이미지로 들어가 있어 초안의 사진 마커([사진 n : 설명])가 보이지 않고, 편집기 흔적("사진 삭제" 같은 줄)이 남아 있을 수 있습니다. 마커 형식을 바꾸라거나 "사진 삭제" 줄을 쓰라는 규칙은 만들지 않습니다. 사진 설명 문장(캡션)의 말투·길이만 규칙이 될 수 있습니다.',
  '',
  '출력은 JSON 하나: summary(이번 비교 요약 이백 자 이내) · changes(바뀐 점 목록, 각 kind=style|format|structure|content, what 백 자 이내, 최대 열둘) · rules(합쳐진 전체 규칙 목록 — text, scope, n(근거 건수, 정수), keep_id(기존 규칙을 이어받았으면 그 id, 새 규칙이면 빈 문자열)).',
].join('\n');
const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '이번 비교 요약(이백 자 이내)' },
    changes: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['style', 'format', 'structure', 'content'] }, what: { type: 'string' } }, required: ['kind', 'what'], additionalProperties: false } },
    rules: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, scope: { type: 'string', enum: ['style', 'format', 'structure', 'content'] }, n: { type: 'integer' }, keep_id: { type: 'string' } }, required: ['text', 'scope', 'n', 'keep_id'], additionalProperties: false } },
  },
  required: ['summary', 'changes', 'rules'],
  additionalProperties: false,
};
function buildLearnPrompt(o) {
  const rules = Array.isArray(o.rules) ? o.rules : [];
  const lines = [];
  lines.push('[기존 규칙 ' + rules.length + '개]  (id · scope · n · 규칙)');
  if (!rules.length) lines.push('(없음 — 첫 학습)');
  rules.forEach(function (r) { lines.push('- ' + r.id + ' · ' + r.scope + ' · ' + r.n + ' · ' + r.text); });
  lines.push('');
  lines.push('[시설] ' + String(o.facility || '(미상)'));
  lines.push('');
  lines.push('[모델 초안]');
  lines.push('제목: ' + String(o.draft_title || ''));
  lines.push(String(o.draft_body || ''));
  lines.push('');
  lines.push('[직원 최종본 — 실제 게시한 글]');
  lines.push('제목: ' + String(o.final_title || ''));
  lines.push(String(o.final_body || ''));
  lines.push('');
  lines.push('위 두 글의 차이에서 규칙을 뽑고 기존 규칙과 합쳐 JSON으로만 답하십시오.');
  return { system: LEARN_SYSTEM, user: lines.join('\n'), schema: LEARN_SCHEMA };
}
// 모델 출력 → 규칙 목록 정리(화이트리스트·길이·개수). 금지 문자열 검사는 워커가 한다.
function normRules(out, oldRules) {
  const old = {}; (oldRules || []).forEach(function (r) { if (r && r.id) old[r.id] = r; });
  const seen = {}; const res = [];
  (Array.isArray(out && out.rules) ? out.rules : []).forEach(function (r) {
    if (!r) return;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, RULE_CHARS);
    const scope = SCOPES[r.scope] ? r.scope : 'style';
    if (!text || seen[text]) return;
    seen[text] = 1;
    let id = (typeof r.keep_id === 'string' && old[r.keep_id]) ? r.keep_id : '';
    if (!id) { for (const k in old) { if (old[k].text === text) { id = k; break; } } }
    if (!id) id = 'r' + hash32(text);
    // 근거 수 — 모델이 센 값과 "기존 규칙이면 +1"(모델이 안 세어도 누적되게) 중 큰 쪽
    const modelN = Math.floor(Number(r.n) || 0);
    const n = old[id] ? Math.max(modelN, (Number(old[id].n) || 1) + 1) : Math.max(1, modelN);
    res.push({ id: id, text: text, scope: scope, n: n, first: old[id] ? old[id].first : 0, last: 0 });
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
// 학습 결과 병합(순수) — ctx {promo_id, pair_id, final_title, final_body, facility, now, tokens, gap, summary}
function mergeLessons(oldL, out, ctx) {
  const L = normLessons(oldL);
  const now = Number(ctx.now) || Date.now();
  const rules = normRules(out, L.rules);
  rules.forEach(function (r) { if (!r.first) r.first = now; r.last = now; });
  L.rules = rules;
  const fk = String(ctx.facility || 'default');
  L.exemplars[fk] = { promo_id: String(ctx.promo_id || ''), title: String(ctx.final_title || '').slice(0, 80), excerpt: stripMarkers(ctx.final_body).slice(0, EXEMPLAR_CHARS), ts: now, gap: ctx.gap ? ctx.gap.ratio : null };
  L.gaps.push({ promo_id: String(ctx.promo_id || ''), pair: String(ctx.pair_id || ''), ts: now, ratio: ctx.gap ? ctx.gap.ratio : null, lines_d: ctx.gap ? ctx.gap.lines_d : 0, heads_d: ctx.gap ? ctx.gap.heads_d : 0, photos_d: ctx.gap ? ctx.gap.photos_d : 0, summary: String(ctx.summary || '').slice(0, 200),
    layout: (ctx.gap && ctx.gap.layout) ? { line_match: ctx.gap.layout.line_match, hr_d: ctx.gap.layout.hr_d, bold_d: ctx.gap.layout.bold_d, blank_d: ctx.gap.layout.blank_d } : null });   // v394 포장 간극(복사본 줄 계획이 있을 때만)
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
// 같은 시설 완성본 예시 → 없으면 가장 최근 것. off면 null.
function exemplarFor(L0, facility) {
  const L = normLessons(L0);
  if (L.off) return null;
  const fk = String(facility || '').replace(/\s+/g, '').slice(0, 20) || 'default';
  let ex = L.exemplars[fk] || null, key = fk;
  if (!ex) { for (const k in L.exemplars) { const e = L.exemplars[k]; if (e && e.excerpt && (!ex || (Number(e.ts) || 0) > (Number(ex.ts) || 0))) { ex = e; key = k; } } }
  if (!ex || !ex.excerpt) return null;
  return { title: String(ex.title || ''), excerpt: String(ex.excerpt || '').slice(0, EXEMPLAR_CHARS), facility_key: key, promo_id: String(ex.promo_id || '') };
}
function gapSummary(L0) {
  const L = normLessons(L0);
  const g = L.gaps.filter(function (x) { return x && typeof x.ratio === 'number'; });
  const avg = function (arr) { return arr.length ? Math.round(arr.reduce(function (s, x) { return s + x.ratio; }, 0) / arr.length * 1000) / 10 : null; };
  const last5 = g.slice(-5), prev5 = g.slice(-10, -5);
  const a = avg(last5), b = avg(prev5);
  return { n: g.length, last5_avg: a, prev5_avg: b, trend: (a === null || b === null) ? '' : (a < b ? 'down' : (a > b ? 'up' : 'flat')) };
}
// 크론이 기동할 짝 고르기 — pending 우선, running은 15분 넘게 그대로면 죽은 것, fail은 10분 뒤 재시도(3회까지). promo_id 없는(미매칭) 짝은 제외.
function pickPending(pairs, now) {
  now = now || Date.now();
  const out = [];
  (Array.isArray(pairs) ? pairs : []).forEach(function (p) {
    if (!p || !RE_PAIR_ID.test(String(p.id || '')) || !RE_REC_ID.test(String(p.promo_id || ''))) return;
    const st = String(p.status || 'pending'), ts = Number(p.ts) || 0, tries = Number(p.tries) || 0;
    // v391 화이트리스트 — 집는 상태는 pending · 죽은 running · 재시도 fail 셋만. done·unmatched·superseded(게시글로 대체)·모르는 상태는 손대지 않는다
    // (10/20 실사고: 블랙리스트라 수집기가 'superseded'로 바꾼 폴더 짝 7건을 크론이 그대로 집어 학습 → 규칙 창고 오염 2차).
    if (st === 'pending') { out.push(p); return; }
    if (st === 'running') { if (now - ts >= RUNNING_STALE_MS && tries < MAX_TRIES) out.push(p); return; }
    if (st === 'fail') { if (tries < MAX_TRIES && now - ts >= RETRY_WAIT_MS) out.push(p); return; }
  });
  out.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
  return out;
}
async function kickLearnWorker(pairId) {
  const s = issueSession({ id: '__promoai__', role: 'system' });
  if (!s.ok) return { ok: false, code: s.code || 'SERVER_CONFIG_MISSING' };
  const base = String(process.env.URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, code: 'NO_SITE_URL' };
  try {
    const resp = await fetch(base + '/.netlify/functions/gw-promo-learn-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token },
      body: JSON.stringify({ pair_id: pairId }),
    });
    if (!resp.ok && resp.status !== 202) return { ok: false, code: 'KICKOFF_HTTP_' + resp.status };
    return { ok: true };
  } catch (e) { return { ok: false, code: 'KICKOFF_FAILED' }; }
}

module.exports = {
  LESSONS_KEY, PAIR_PREFIX, LOCK_KEY, LAYOUT_KEY, COPY_PREFIX, copyKey, layoutGap, MAX_RULES, RULE_CHARS, EXEMPLAR_CHARS, MAX_GAPS, MAX_TRIES, LOCK_TTL_MS, RE_PAIR_ID, RE_REC_ID,
  pairKey, draftKey, cleanFinal, stripMarkers, normForGap, levenshtein, gapScore, facilityKey, hash32,
  LEARN_SYSTEM, LEARN_SCHEMA, buildLearnPrompt, normRules, emptyLessons, normLessons, mergeLessons, lessonLines, exemplarFor, gapSummary, pickPending,
  kickLearnWorker,
};
