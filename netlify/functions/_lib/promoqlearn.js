'use strict';
// 체크 10 품질 고리 3단계(원천) — 품질 자동 학습.
//   PM 11/10 16:09 ⓓ "자동학습과 별개로 완성도 및 디테일, 그리고 글의 복잡성을 높이는 학습도 추가" · 11/13 08:03 "이 골격을 정확하게 유지한채로" · 11/13 10:52 "2. 아니 원천 3단계 ㄱ".
//
// 골격(v389 편집 간극 학습: 모델 초안 ↔ 직원 게시본 → promoai:lessons → 다음 생성)은 손대지 않는다 — 이 파일은 골격 키를 읽기만 한다.
// 하는 일: 1단계 점수(promoai:quality)에서 최근 사진AI 초안의 항목 점수를 모으고, 본보기(promoqual_ex.json — 권민지 방내리·준설 상위 5편 특징값)와 견줘
//   모자란 항목을 고른 뒤, 모델이 그 차이에서 '품질 규칙'(열 개 이내)을 스스로 써서 promoai:qlearn에 둔다(워커 gw-promo-qlearn-background, 크론 ⑥이 기동).
//   다음 생성(_lib/promoai.buildPrompt)이 직원 규칙(골격) 블록 아래에 '[완성도 목표]'로 받는다 — 부딪히면 직원 쪽.
// 원천: 생성 안(프롬프트 자료)에서 고친다. 생성 뒤에 글을 다시 쓰는 보강(설계안 F의 덧대기)은 하지 않는다.
// 사람(개발자)은 품질 규칙을 쓰지 않는다. PM 손은 끄기 스위치뿐(관리자 카드 pl_set qoff).
// 이 파일은 순수 함수 + 크론 기동 도우미(kick). 모델 호출은 워커가, 쓰기는 워커·크론·pl_set이 한다(테스트 tools/promoqlearn_check.mjs).
const PQ = require('./promoqual');

const QLEARN_KEY = 'promoai:qlearn';
const QL_VER = 'ql1-20261113';
const MAX_QRULES = 10;
const QRULE_CHARS = 120;
const RECENT_N = 8;                          // 최근 사진AI 초안 몇 편을 보나(기록마다 최신 보존 초안 1편)
const FOCUS_N = 3;                           // 부족 상위 몇 항목을 이번 목표로
const LOCK_TTL_MS = 15 * 60 * 1000;          // 워커가 죽으면 15분 뒤 다시
const RETRY_MS = 10 * 60 * 1000;             // 실패 뒤 다시 보는 간격
const CREDIT_WAIT_MS = 60 * 60 * 1000;       // 잔액 부족은 한 시간 뒤(시도 횟수를 쓰지 않음 — 2단계 E와 같은 규칙)
const MIN_GAP_MS = 20 * 60 * 60 * 1000;      // 새 초안이 와도 하루 한 번(첫 학습은 바로)
const MAX_TRIES = 3;
const HIST_MAX = 30;
const CODES = PQ.ITEMS.map(function (it) { return it[0]; });
const CODES_ALL = CODES.concat(['ALL']);
const ITEM_LABEL = {}; PQ.ITEMS.forEach(function (it) { ITEM_LABEL[it[0]] = it[2]; });

// 2점 기준 — 1단계 채점기(promoqual ITEMS)와 같은 문턱. say = 생성 목표 줄에 쓰는 이름, scale = 보여 줄 눈금(비율 ×100), num = 한글 수사 종류(sino 삼십오 / native 서른다섯)
//   skip = 목표로 삼지 않는 항목(까닭), nodisp = 숫자 없이 이름만
//   bound = 판독표만큼(배포 전 검토 loop F5 — 11/13): 현장·장비·동작·지형은 사진이 보여 주는 만큼만 있다. 개수·비율 목표를 생성에 주면 판독표에 없는 것을 지어내게 밀므로,
//     생성 목표 줄에는 숫자 대신 '판독표를 빠짐없이 살려 쓰기'로만 넣는다(카드에는 숫자 그대로 보임).
const GOAL = {
  C1: { m: 'img_burst', cmp: 'le', t: 2, unit: '장', say: '글 없이 이어진 사진', num: 'native' },
  C2: { m: 'chars_per_img', cmp: 'ge', t: 150, unit: '자', say: '사진 한 장당 글', num: 'sino' },
  C3: { m: 'md_left', cmp: 'le', t: 0, unit: '', say: '마크다운 기호·계절 어긋남 같은 결함 없애기', num: 'native', nodisp: true },
  C4: { m: 'title_len', cmp: 'range', t: 20, t2: 50, unit: '자', say: '제목 길이(고정 키워드 나열 아님)', num: 'sino' },
  C5: { m: 'heads', cmp: 'ge', t: 3, unit: '개', say: '소제목·목록·구분선·굵게(시각 리듬)', num: 'native', skip: '굵게·구분선 같은 포장은 기존 포장 학습(골격) 몫' },
  C6: { m: 'company', cmp: 'ge', t: 2, unit: '', say: '마무리(회사 신뢰 블록·문의 안내)', num: 'native', nodisp: true },
  D1: { m: 'site_ratio', cmp: 'ge', t: 35, scale: 100, unit: '퍼센트', say: '현장 문장 비율', num: 'sino', bound: '판독표 장면마다 이 현장에서 한 일을 한 문장 이상 — 판독표·입력에 없는 장면은 쓰지 않음' },
  D2: { m: 'equip_distinct', cmp: 'ge', t: 10, unit: '개', say: '장비·도구 이름', num: 'native', bound: '판독표 장비 칸의 장비·도구를 빠짐없이 정확한 이름으로 — 판독표에 없는 장비는 쓰지 않음' },
  D3: { m: 'acts_distinct', cmp: 'ge', t: 15, unit: '개', say: '공정 동사', num: 'native', bound: '판독표 행위 칸의 동작을 빠짐없이 살려 쓰기 — 판독표에 없는 동작은 쓰지 않음' },
  D4: { m: 'place_distinct', cmp: 'ge', t: 8, unit: '개', say: '지형·시설 부위 일반 낱말(지명 아님)', num: 'native', bound: '판독표 장면에 보이는 지형·시설 부위를 일반 낱말로 — 지명·현장 이름은 쓰지 않음' },
  D5: { m: 'qty', cmp: 'ge', t: 3, unit: '개', say: '현장 수량(작업량·장비 대수·인원·시간)', num: 'native', skip: '현장 수량은 입력·판독표에 있을 때만 — 지어내지 않게 목표로 삼지 않음' },
  X1: { m: 'conn_per_sent', cmp: 'range', t: 90, t2: 120, scale: 100, unit: '개(문장 백 개당)', say: '연결어미', num: 'sino' },
  X2: { m: 'long_sent_ratio', cmp: 'range', t: 12, t2: 20, scale: 100, unit: '퍼센트', say: '예순 자 넘는 긴 문장 비율', num: 'sino' },
  X3: { m: 'terms_distinct', cmp: 'ge', t: 20, unit: '개', say: '전문 용어', num: 'native' },
  X4: { m: 'core_chars', cmp: 'ge', t: 2500, unit: '자', say: '본문 분량', num: 'sino' },
  X5: { m: 'max_sim', cmp: 'le', t: 35, scale: 100, unit: '퍼센트', say: '최근 같은 회사 글과 본문 겹침', num: 'sino' },
};
if (CODES.some(function (c) { return !GOAL[c]; }) || Object.keys(GOAL).length !== CODES.length) throw new Error('promoqlearn GOAL과 promoqual ITEMS 불일치');

// 본보기 라벨·제목에 든 실명·지명(promoqual_ex.json e1 — 배포 전 검토 sec S3·loop F3): 학습 입력에 싣지 않고(원천), 이 낱말이 든 규칙은 버린다.
//   C059 '공사명·장소 일반명 공개'는 PM 결정 전이라 기본값 불허. 게이트가 본보기 라벨·제목의 실명·지명이 여기 다 있는지 본다.
const DENY = ['권민지', '방내리'];
// 사람·직책·연락처·지시 무시 꼴(모델이 지시를 어긴 경우의 마지막 거름) — 품질 규칙은 글 쓰는 법만 말하므로 이런 낱말이 들 까닭이 없다
const DENY_RE = /[가-힣]{2,4}\s?(대리|주임|과장|차장|부장|팀장|실장|소장|이사|대표)(님|에게|께|이|가|은|는|의|\s|$)|공일공|지시[를을]?\s?무시|규칙[을를]?\s?무시/;
function h32(s) { let h = 2166136261; s = String(s || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function median(a) { const s = a.slice().sort(function (x, y) { return x - y; }); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
function num(v) { return (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v); }
function scaled(c, v) { const g = GOAL[c]; const x = num(v); return x === null ? null : Math.round(x * (g.scale || 1)); }
function exValue(c) {
  const m = (PQ.EX && PQ.EX.top && PQ.EX.top.m) || {};
  const k = GOAL[c].m === 'max_sim' ? 'max_sim_same_group' : GOAL[c].m;
  return scaled(c, m[k]);
}
function critText(c) {
  const g = GOAL[c], u = g.unit === '퍼센트' ? '%' : (g.unit === '개(문장 백 개당)' ? '개/문장 백 개' : g.unit);
  if (c === 'C3') return '결함 0(마크다운 기호·제목/본문 계절 어긋남 없음)';
  if (c === 'C5') return '소제목 ≥ max(3, 사진 수/3) + 목록·구분선 5 이상·굵게 15% 이상';
  if (c === 'C6') return '회사 신뢰 블록 + 문의·지도';
  if (g.cmp === 'range') return g.t + '~' + g.t2 + u;
  return g.t + u + (g.cmp === 'le' ? ' 이하' : ' 이상');
}

// ---- 자료 모으기(순수) ----
// 최근 사진AI 초안 — 1단계 점수 기록(recs[id].draft = 기록마다 최신 보존 초안의 항목 점수·지표). 태그만 만든 옛 기록(tpl_tags)은 뺀다.
function recentDrafts(Q0) {
  const Q = PQ.normQ(Q0);
  const out = [];
  Object.keys(Q.recs).forEach(function (id) {
    const r = Q.recs[id];
    if (!r || r.kind === 'tpl_tags' || !r.draft || !r.draft.items || typeof r.draft.items !== 'object') return;
    out.push({ id: id, job: String(r.draft.job || ''), ts: Number(r.draft.ts) || 0, pv: String(r.draft.pv || ''), items: r.draft.items, m: r.draft.m || {}, score10: r.draft.score10, title: String(r.title || '') });
  });
  out.sort(function (a, b) { return (b.ts - a.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  return out.slice(0, RECENT_N);
}
function itemStats(drafts) {
  const st = {};
  CODES.forEach(function (c) {
    const sc = drafts.map(function (d) { return num(d.items[c]); }).filter(function (v) { return v !== null; });
    const mv = drafts.map(function (d) { return num(d.m ? d.m[GOAL[c].m] : null); }).filter(function (v) { return v !== null; });
    st[c] = { avg: sc.length ? Math.round(100 * sc.reduce(function (a, b) { return a + b; }, 0) / sc.length) / 100 : null, low: sc.filter(function (v) { return v < 2; }).length, n: sc.length, now: mv.length ? median(mv) : null };
  });
  return st;
}
// 이번 목표 — 평균 점수 2 미만인 항목 중 낮은 순(같으면 채점표 순서) 상위 FOCUS_N, 목표로 삼지 않는 항목(skip)은 뺀다.
function focusOf(stats) {
  return CODES.filter(function (c) { const s = stats[c]; return s && s.avg !== null && s.avg < 2 && !GOAL[c].skip; })
    .sort(function (a, b) { return (stats[a].avg - stats[b].avg) || (CODES.indexOf(a) - CODES.indexOf(b)); })
    .slice(0, FOCUS_N)
    .map(function (c) {
      const g = GOAL[c], s = stats[c];
      return { code: c, avg: s.avg, now: g.nodisp ? null : scaled(c, s.now), target: g.t, target2: g.t2 || null, cmp: g.cmp, unit: g.unit, num: g.num, ex: g.nodisp ? null : exValue(c), nodisp: !!g.nodisp };
    });
}
// 학습 자료가 바뀌었는지 — 최근 초안(작업 번호)·채점 판·본보기 판·직원 규칙(골격 — 바뀌면 부딪히지 않게 다시 맞춘다)
function basisSig(Q0, lessonsRules) {
  const ds = recentDrafts(Q0).map(function (d) { return d.job || (d.id + '@' + d.ts); }).join(',');
  const lr = (Array.isArray(lessonsRules) ? lessonsRules : []).map(function (r) { return String((r && r.id) || '') + ':' + String((r && r.n) || ''); }).join(',');
  return [QL_VER, PQ.QUAL_VER, String((PQ.EX && PQ.EX.ver) || ''), h32(ds), h32(lr)].join('|');
}

// ---- 학습 프롬프트(모델이 품질 규칙을 쓴다 — 개발자는 쓰지 않는다) ----
const QLEARN_SYSTEM = [
  '당신은 준설·폐기물·석면·철거 회사 블로그 글쓰기 모델의 품질 코치입니다.',
  '회사의 글쓰기 모델이 최근에 쓴 초안들을, 직원이 직접 써서 점수가 높았던 본보기 글과 항목별로 잰 값으로 받습니다.',
  '목표: 다음 초안이 처음부터 본보기 수준의 완성도·디테일·복잡성에 가깝게 나오도록, 글쓰기 모델이 지킬 품질 규칙을 뽑아 기존 품질 규칙과 합쳐 돌려줍니다.',
  '',
  '규칙을 쓰는 법',
  '- 재현 가능한 지시문으로 씁니다("…마다 …를 쓴다", "…는 …로 이어 쓴다"). 감상·칭찬·추측은 쓰지 않습니다. 한 규칙은 백이십 자 이내, 한 가지만 말합니다.',
  '- [이번 목표] 항목을 먼저 다룹니다. 이미 기준을 넘는 항목은 규칙으로 만들지 않습니다.',
  '- 사실을 지어내게 하는 규칙은 쓰지 않습니다. 장비·인원·대수·수량·작업 순서 같은 현장 사실은 사진 판독표·입력·자동 현장 사실에 있는 것만 쓰라고 씁니다. 판독표에 없는 것을 채우라고 하지 않습니다.',
  '- [직원 규칙]은 직원이 실제로 고쳐 게시한 차이에서 배운 것입니다. 이것과 부딪히는 규칙은 쓰지 않고, 직원 규칙을 고치거나 되풀이하지 않습니다.',
  '- 줄 나누기·정렬·굵게·구분선 같은 포장은 앱이 복사할 때 따로 배워 붙이므로 규칙으로 만들지 않습니다.',
  '- 본보기 글의 문장·지역·현장 이름을 옮기라는 규칙은 쓰지 않습니다. 특징(서술 흐름·문장 구조·낱말 종류)만 씁니다.',
  '- 사람 이름·직책, 현장·건물·마을·공사 이름을 쓰라는 규칙이나 그런 이름이 든 규칙은 쓰지 않습니다(공사명·장소 공개는 정해지지 않아 쓰지 않음).',
  '- D1~D4(현장 문장·장비·공정 동사·지형 낱말) 규칙은 판독표의 장면·장비·행위 칸을 빠짐없이 살려 쓰라는 꼴로만 씁니다. 개수나 비율을 채우라고 하지 않습니다(사진에 없는 것을 지어내게 됨).',
  '- [이번 목표] 항목이라도 직원 규칙과 부딪히면 그 항목 규칙은 쓰지 않고 넘어갑니다. 규칙을 쓴 항목만 다음 생성의 목표 줄에 들어갑니다.',
  '- 규칙에는 아라비아 숫자를 쓰지 않습니다. 정도는 말로 씁니다(예: "사진마다 한 문장 이상", "세 문장에 한 번꼴로").',
  '- item에는 그 규칙이 겨냥하는 항목 코드(C1~X5 중 하나, 여러 항목이면 ALL)를 넣습니다.',
  '- 기존 품질 규칙과 합칩니다: 같은 뜻이면 하나로 합치고 n(근거가 된 초안 수)을 더합니다. 이번 자료와 모순되면 이번 쪽으로 고칩니다. 겨냥한 항목이 이제 기준을 넘었으면 그 규칙은 빼도 됩니다.',
  '- 전체 열 개 이내.',
  '',
  '출력은 JSON 하나: summary(이번 판단 요약 이백 자 이내) · rules(합쳐진 전체 품질 규칙 목록 — text, item, n(정수), keep_id(기존 규칙을 이어받았으면 그 id, 새 규칙이면 빈 문자열)).',
].join('\n');
const QLEARN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '이번 판단 요약(이백 자 이내)' },
    rules: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, item: { type: 'string', enum: CODES_ALL }, n: { type: 'integer' }, keep_id: { type: 'string' } }, required: ['text', 'item', 'n', 'keep_id'], additionalProperties: false } },
  },
  required: ['summary', 'rules'],
  additionalProperties: false,
};
// o = { stats, focus, lessons(직원 규칙 [{text}]), rules(기존 품질 규칙), n(초안 수) }
function buildQLearnPrompt(o) {
  const st = o.stats || {}, focus = Array.isArray(o.focus) ? o.focus : [], lessons = Array.isArray(o.lessons) ? o.lessons : [], rules = Array.isArray(o.rules) ? o.rules : [];
  const ex = PQ.EX || {}, dr = Array.isArray(ex.dredge) ? ex.dredge : [];
  const drMed = median(dr.map(function (e) { return num(e.score10); }).filter(function (v) { return v !== null; }));
  const L = [];
  // 본보기 줄은 이름 없는 표기만(실명·지명은 학습 입력에 싣지 않는다 — DENY, C059 불허 기본값)
  L.push('[본보기] (문장은 주지 않고 잰 값만 줍니다)');
  if (ex.top) L.push('- 석면 현장서술형 본보기 한 편 — 시범 ' + ex.top.score10 + '점(본보기 값은 이 글)');
  if (dr.length) L.push('- 준설 상위 ' + dr.length + '편 — 중앙 ' + (drMed === null ? '—' : Math.round(drMed * 10) / 10) + '점');
  L.push('');
  L.push('[항목별 — 최근 사진AI 초안 ' + (Number(o.n) || 0) + '편] (항목 · 평균 점수 0~2 · 초안 지금 값(중앙) · 본보기 값 · 2점 기준)');
  CODES.forEach(function (c) {
    const s = st[c] || {}, g = GOAL[c];
    const nowV = g.nodisp ? '—' : (s.now === null || s.now === undefined ? '—' : String(scaled(c, s.now)));
    const exV = g.nodisp ? '—' : (exValue(c) === null ? '—' : String(exValue(c)));
    L.push('- ' + c + ' ' + g.say + ': 평균 ' + (s.avg === null || s.avg === undefined ? '—' : s.avg) + ' · 지금 ' + nowV + ' · 본보기 ' + exV + ' · 기준 ' + critText(c) + (g.skip ? ' (목표 아님 — ' + g.skip + ')' : '') + (g.bound ? ' (판독표만큼 — ' + g.bound + ')' : ''));
  });
  L.push('');
  L.push('[이번 목표 — 부족 상위 ' + focus.length + '항목] ' + (focus.length ? focus.map(function (f) { return f.code + ' ' + GOAL[f.code].say + '(평균 ' + f.avg + ')'; }).join(', ') : '없음 — 모든 항목이 기준을 넘었습니다. 기존 규칙만 정리합니다.'));
  L.push('');
  L.push('[직원 규칙 ' + lessons.length + '개 — 골격: 직원이 고쳐 게시한 차이에서 배운 규칙. 부딪히는 품질 규칙은 쓰지 않습니다]');
  if (!lessons.length) L.push('(없음)');
  lessons.forEach(function (r) { L.push('- ' + String((r && r.text) || r || '').slice(0, 160)); });
  L.push('');
  L.push('[기존 품질 규칙 ' + rules.length + '개] (id · 항목 · n · 규칙)');
  if (!rules.length) L.push('(없음 — 첫 학습)');
  rules.forEach(function (r) { L.push('- ' + r.id + ' · ' + r.item + ' · ' + r.n + ' · ' + r.text); });
  L.push('');
  L.push('위 자료로 품질 규칙을 뽑고 기존 품질 규칙과 합쳐 JSON으로만 답하십시오.');
  return { system: QLEARN_SYSTEM, user: L.join('\n'), schema: QLEARN_SCHEMA };
}

// ---- 결과 정리·병합(순수) ----
function cleanRule(t) {
  const s = String(t === null || t === undefined ? '' : t).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/[0-9]{3,}/.test(s)) return '';                 // 금액·번호 꼴은 버린다(생성 프롬프트의 금액 차단 검사와 겹치지 않게 — 숫자는 말로 쓰라고 지시)
  if (/https?:|www\.|@/i.test(s)) return '';
  if (DENY.some(function (w) { return s.indexOf(w) >= 0; }) || DENY_RE.test(s)) return '';   // 실명·지명·직책·연락처·지시 무시 꼴(배포 전 검토 sec S3)
  return s.slice(0, QRULE_CHARS);
}
function normQRules(out, oldRules, now) {
  const old = Object.create(null); (Array.isArray(oldRules) ? oldRules : []).forEach(function (r) { if (r && r.id) old[String(r.id)] = r; });
  const res = [], seen = Object.create(null), ids = Object.create(null);
  (out && Array.isArray(out.rules) ? out.rules : []).forEach(function (r) {
    if (!r || typeof r !== 'object' || res.length >= MAX_QRULES) return;
    const text = cleanRule(r.text);
    if (!text) return;
    const k = text.replace(/\s+/g, '');
    if (seen[k]) return;
    seen[k] = 1;
    const prev = old[String(r.keep_id || '')] || null;
    let id = prev ? String(prev.id) : ('q' + h32(text).slice(0, 7));
    while (ids[id]) id = id + 'x';
    ids[id] = 1;
    const item = CODES_ALL.indexOf(String(r.item || '')) >= 0 ? String(r.item) : 'ALL';
    const n = Math.max(1, Math.min(999, parseInt(r.n, 10) || (prev ? (Number(prev.n) || 1) : 1)));
    res.push({ id: id, text: text, item: item, n: n, ts: prev ? (Number(prev.ts) || now) : now });
  });
  return res;
}
function normQL(x) {
  const q = (x && typeof x === 'object') ? x : {};
  const rules = (Array.isArray(q.rules) ? q.rules : []).filter(function (r) { return r && typeof r === 'object' && r.id && r.text; }).slice(0, MAX_QRULES).map(function (r) {
    return { id: String(r.id).slice(0, 24), text: String(r.text).slice(0, QRULE_CHARS), item: CODES_ALL.indexOf(String(r.item)) >= 0 ? String(r.item) : 'ALL', n: Math.max(1, parseInt(r.n, 10) || 1), ts: Number(r.ts) || 0 };
  });
  const st = (q.stats && typeof q.stats === 'object') ? q.stats : {};
  return {
    schema: 1, ver: String(q.ver || ''), off: q.off === true, rules: rules,
    focus: (Array.isArray(q.focus) ? q.focus : []).map(normFocus).filter(Boolean).slice(0, FOCUS_N),
    summary: String(q.summary || '').slice(0, 300),
    learned_at: Number(q.learned_at) || 0, basis_sig: String(q.basis_sig || ''), try_sig: String(q.try_sig || ''),
    tries: Math.max(0, Number(q.tries) || 0), lock_ts: Number(q.lock_ts) || 0,
    code: String(q.code || ''), detail: String(q.detail || '').slice(0, 160), fail_ts: Number(q.fail_ts) || 0,
    n_drafts: Number(q.n_drafts) || 0,
    stats: { calls: Number(st.calls) || 0, tokens: Number(st.tokens) || 0, fail_calls: Number(st.fail_calls) || 0, fail_tokens: Number(st.fail_tokens) || 0 },
    hist: (Array.isArray(q.hist) ? q.hist : []).slice(-HIST_MAX),
    updated_at: Number(q.updated_at) || 0,
  };
}
// 저장된 목표 항목을 칸마다 다시 만든다(배포 전 검토 sec S1) — 기준·단위·수사 종류는 GOAL에서, 숫자 칸은 숫자 또는 null만. 화면·생성 둘 다 저장값을 믿지 않는다.
function normFocus(f) {
  const g = (f && typeof f === 'object') ? GOAL[f.code] : null;
  if (!g) return null;
  const r2 = function (v) { const x = num(v); return x === null ? null : Math.round(x * 100) / 100; };
  return { code: String(f.code), avg: r2(f.avg), now: g.nodisp ? null : r2(f.now), target: g.t, target2: g.t2 || null, cmp: g.cmp, unit: g.unit, num: g.num, ex: g.nodisp ? null : r2(f.ex), nodisp: !!g.nodisp, bound: !!g.bound };
}
// 학습 결과 병합 — base는 쓰기 직전에 다시 읽은 값(끄기 스위치를 그대로 지킨다). ctx = { now, tokens, sig, focus, n }
function mergeQL(base0, out, ctx) {
  const base = normQL(base0), now = Number(ctx.now) || Date.now(), tokens = Number(ctx.tokens) || 0;
  const rules = normQRules(out, base.rules, now);
  const r = Object.assign({}, base, {
    ver: QL_VER, rules: rules, focus: (Array.isArray(ctx.focus) ? ctx.focus : []).map(normFocus).filter(Boolean).slice(0, FOCUS_N), summary: String((out && out.summary) || '').slice(0, 300),
    learned_at: now, basis_sig: String(ctx.sig || ''), try_sig: String(ctx.sig || ''), tries: 0, lock_ts: 0, code: '', detail: '', fail_ts: 0,
    n_drafts: Number(ctx.n) || 0, updated_at: now,
    stats: Object.assign({}, base.stats, { calls: base.stats.calls + 1, tokens: base.stats.tokens + tokens }),
  });
  r.hist = base.hist.concat([{ at: now, n: Number(ctx.n) || 0, focus: r.focus.map(function (f) { return f.code; }), rules: rules.length, tokens: tokens }]).slice(-HIST_MAX);
  return r;
}

// ---- 크론 ⑥ 판정(순수) ----
function decide(ql0, Q0, lessonsRules, now) {
  const ql = normQL(ql0);
  if (ql.off) return { kick: false, why: 'off' };
  if (ql.lock_ts && now - ql.lock_ts < LOCK_TTL_MS) return { kick: false, why: 'running' };
  if (!recentDrafts(Q0).length) return { kick: false, why: 'no_drafts' };
  const sig = basisSig(Q0, lessonsRules);
  const sameTry = ql.try_sig === sig;
  if (sameTry && ql.code === 'CREDIT_LOW') return (now - ql.fail_ts >= CREDIT_WAIT_MS) ? { kick: true, why: 'credit_retry', sig: sig } : { kick: false, why: 'credit_wait' };
  if (sameTry && ql.tries >= MAX_TRIES && sig !== ql.basis_sig) return { kick: false, why: 'gave_up' };
  if (sameTry && ql.code) return (now - ql.fail_ts < RETRY_MS) ? { kick: false, why: 'retry_wait' } : { kick: true, why: 'retry', sig: sig };
  if (sig === ql.basis_sig) return { kick: false, why: 'same' };
  if (!sameTry && ql.learned_at && now - ql.learned_at < MIN_GAP_MS) return { kick: false, why: 'daily_cap' };
  return { kick: true, why: sameTry ? 'retry' : (ql.learned_at ? 'new_data' : 'first'), sig: sig };
}
function markKick(ql0, sig, now) {
  const ql = normQL(ql0);
  if (ql.try_sig !== sig) { ql.try_sig = sig; ql.tries = 0; }
  ql.tries += 1; ql.lock_ts = now; ql.code = ''; ql.detail = ''; ql.updated_at = now;
  return ql;
}
// 크론 ⑥ — 판정이 '기동'이면 잠금·시도를 적고 워커를 부른다. 반환은 로그용 요약. 골격 키는 읽기만.
async function kick(st, now) {
  const B = require('./blobs');
  const qr = await B.blobGet(st, QLEARN_KEY);
  if (!qr.ok && qr.code !== 'NOT_FOUND') return { error: qr.code || 'QL_READ_FAILED' };
  const ql = normQL(qr.ok ? qr.data : null);
  if (ql.off) return { skipped: 'off' };
  if (ql.lock_ts && now - ql.lock_ts < LOCK_TTL_MS) return { skipped: 'running' };
  const q = await B.blobGet(st, PQ.QUAL_KEY);
  if (!q.ok) return { skipped: q.code === 'NOT_FOUND' ? 'no_quality' : 'quality_' + (q.code || 'READ_FAILED') };
  const PL = require('./promolearn');
  const lr = await B.blobGet(st, PL.LESSONS_KEY);
  if (!lr.ok && lr.code !== 'NOT_FOUND') return { skipped: 'lessons_' + (lr.code || 'READ_FAILED') };
  const lessons = PL.normLessons(lr.ok ? lr.data : null);
  const d = decide(ql, q.data, lessons.rules, now);
  if (!d.kick) return { skipped: d.why };
  // 쓰기 직전 다시 읽기(배포 전 검토 ops F3·loop F8) — 점수·직원 규칙을 읽는 사이 PM이 끈 것·다른 기동·끝난 학습을 덮지 않는다
  const re = await B.blobGet(st, QLEARN_KEY);
  if (!re.ok) return { error: re.code || 'QL_READ_FAILED' };
  const cur = normQL(re.data);
  if (cur.off) return { skipped: 'off' };
  if (cur.lock_ts && now - cur.lock_ts < LOCK_TTL_MS) return { skipped: 'running' };
  if (cur.basis_sig === d.sig && !cur.code) return { skipped: 'same' };
  const nq = markKick(cur, d.sig, now);
  const w = await B.blobSet(st, QLEARN_KEY, nq);
  if (!w.ok) return { error: w.code || 'QL_WRITE_FAILED' };
  const LN = require('./learn');
  const k = await LN.kickWorker('gw-promo-qlearn-background', { sig: d.sig });
  if (!k.ok) { nq.lock_ts = 0; nq.code = String(k.code || 'KICKOFF_FAILED'); nq.fail_ts = now; await B.blobSet(st, QLEARN_KEY, nq); return { started: false, why: d.why, code: nq.code }; }
  return { started: true, why: d.why, tries: nq.tries };
}

// ---- 생성 주입(순수) — 워커가 promoai 한글 수사 함수(koNum·koCount)를 넘긴다. 입력에 아라비아 숫자를 싣지 않는다(금지 문자열 검사와 겹치지 않게) ----
function focusText(f, fmt) {
  const g = GOAL[f.code]; if (!g || g.skip) return '';
  if (g.bound) return g.say + '(' + g.bound + ')';   // 판독표만큼 — 숫자 목표 없이(지어내기 방지)
  const k = function (v) { const n = Math.max(0, Math.round(Number(v) || 0)); return g.num === 'sino' ? fmt.koNum(n) : fmt.koCount(n); };
  const u = g.unit ? ' ' + g.unit : '';
  if (f.nodisp || g.nodisp) return g.say;
  const tgt = f.cmp === 'range' ? k(f.target) + '~' + k(f.target2) + u : k(f.target) + u + (f.cmp === 'le' ? ' 이하' : ' 이상');
  const nowTxt = (f.now === null || f.now === undefined || isNaN(Number(f.now))) ? '' : '최근 초안 ' + k(f.now) + u + ' → ';
  return g.say + '(' + nowTxt + '목표 ' + tgt + ')';
}
function injectOf(raw, fmt) {
  const ql = normQL(raw);
  if (ql.off || !ql.rules.length) return null;
  const F = (fmt && typeof fmt.koNum === 'function' && typeof fmt.koCount === 'function') ? fmt : null;
  // 목표 줄은 모델이 규칙을 쓴 항목만(배포 전 검토 loop F1) — 코치가 직원 규칙과 부딪혀 규칙을 안 쓴 항목은 목표 줄에서도 빠진다
  const ruled = Object.create(null); ql.rules.forEach(function (r) { ruled[r.item] = 1; });
  return {
    rules: ql.rules.map(function (r) { return r.text; }),
    focus: F ? ql.focus.filter(function (f) { return ruled[f.code]; }).map(function (f) { return focusText(f, F); }).filter(function (s) { return s && !/[0-9]/.test(s); }) : [],
  };
}

// ---- 카드(pl_get) ----
function cardOf(raw, now) {
  const ql = normQL(raw);
  now = now || Date.now();
  return {
    ver: ql.ver, off: ql.off, rules: ql.rules,
    focus: ql.focus.map(function (f) { const g = GOAL[f.code] || {}; return { code: f.code, label: ITEM_LABEL[f.code] || '', say: g.say || '', avg: f.avg, now: f.now, target: f.target, target2: f.target2, cmp: f.cmp, unit: f.unit, ex: f.ex, nodisp: !!f.nodisp, bound: !!f.bound, ruled: ql.rules.some(function (r) { return r.item === f.code; }) }; }),
    summary: ql.summary, learned_at: ql.learned_at, n_drafts: ql.n_drafts,
    code: ql.code, detail: ql.detail, tries: ql.tries, running: !!(ql.lock_ts && now - ql.lock_ts < LOCK_TTL_MS),
    stats: ql.stats, hist: ql.hist.slice(-8),
  };
}

module.exports = {
  QLEARN_KEY, QL_VER, MAX_QRULES, QRULE_CHARS, RECENT_N, FOCUS_N, LOCK_TTL_MS, RETRY_MS, CREDIT_WAIT_MS, MIN_GAP_MS, MAX_TRIES, HIST_MAX, CODES, GOAL, DENY, DENY_RE,
  recentDrafts, itemStats, focusOf, basisSig, exValue, critText,
  QLEARN_SYSTEM, QLEARN_SCHEMA, buildQLearnPrompt,
  cleanRule, normQRules, normQL, normFocus, mergeQL,
  decide, markKick, kick,
  focusText, injectOf, cardOf,
};
