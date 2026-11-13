'use strict';
// 체크 10 품질 고리 3단계(원천) — 품질 자동 학습 워커(Netlify Background Function). PM 11/13 10:52 "2. 아니 원천 3단계 ㄱ".
// 크론(gw-promo-ai-cron ⑥)이 내부 토큰(mid='__promoai__')으로 기동한다. 새 초안 점수가 생기면 하루 한 번(첫 학습은 바로).
// 하는 일: 1단계 점수(promoai:quality)의 최근 사진AI 초안 항목 점수 ↔ 본보기 값(promoqual_ex.json — 권민지 방내리·준설 상위 5편)
//   + 직원 규칙(골격 promoai:lessons — 읽기만) + 기존 품질 규칙 → 모델 1회(텍스트만, json_schema) → 품질 규칙(열 개 이내)을 promoai:qlearn에 둔다.
//   다음 생성(buildPrompt)은 직원 규칙 블록 아래에 '[완성도 목표]'로 받는다(부딪히면 직원 쪽). 생성 뒤에 글을 다시 쓰지 않는다(원천).
// 골격 키(promoai:lessons·promolearn:*·promoai:draft:*)는 쓰지 않는다. 사람(개발자)은 품질 규칙을 쓰지 않는다.
// 자격증명: 키는 GW_ANTHROPIC_KEY 인자 하나로만 흐르고, 실패 사유에 섞이면 [REDACTED]로 바꾼다.
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const QL = require('./_lib/promoqlearn');
const PQ = require('./_lib/promoqual');
const PL = require('./_lib/promolearn');

const DATA = 'gw_data';
const TIMEOUT_MS = 180000;
const MAX_TOKENS = 4000;
const EFFORT = 'medium';

function loadLib() { try { return require('./_lib/promoai'); } catch (e) { return null; } }
function loadJob() { try { return require('./_lib/promoai_job'); } catch (e) { return null; } }
function cut(s, n) { return String(s === null || s === undefined ? '' : s).slice(0, n); }
function makeScrub() {
  const key = String(process.env.GW_ANTHROPIC_KEY || '');
  return function (s) { s = String(s || ''); if (key && key.length >= 8) { while (s.indexOf(key) >= 0) s = s.replace(key, '[REDACTED]'); } return s; };
}
function parseOut(text) {
  let t = String(text || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) t = m[1].trim();
  try { return JSON.parse(t); } catch (e) { return null; }
}

exports.handler = async function (event, context) {
  let st = null;
  const scrub = makeScrub();
  // 실패·종료 — 다시 읽고 잠금만 풀거나 사유를 적는다(끄기 스위치·규칙은 그대로). 잔액 부족은 시도 횟수를 쓰지 않는다(2단계 E와 같은 규칙).
  const release = async function (code, detail) {
    if (!st) return;
    try {
      const cur = await blobGet(st, QL.QLEARN_KEY);
      const q = QL.normQL(cur.ok ? cur.data : null);
      q.lock_ts = 0; q.updated_at = Date.now();
      if (code) {
        const PJ = loadJob();
        const c = (PJ && typeof PJ.failCode === 'function') ? PJ.failCode(code, detail) : String(code);
        q.code = cut(c, 40); q.detail = cut(scrub(detail || ''), 160); q.fail_ts = Date.now();
        if (c === 'CREDIT_LOW') q.tries = Math.max(0, q.tries - 1);
      }
      await blobSet(st, QL.QLEARN_KEY, q);
    } catch (e) {}
  };
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__promoai__') return;
    st = store(DATA);
    const qr = await blobGet(st, QL.QLEARN_KEY);
    const q0 = QL.normQL(qr.ok ? qr.data : null);
    if (q0.off) { await release('', ''); return; }   // 기동 뒤 꺼졌으면 잠금만 푼다
    if (!process.env.GW_ANTHROPIC_KEY) { await release('ENV_MISSING'); return; }
    const lib = loadLib();
    if (!lib) { await release('LIB_MISSING'); return; }

    const pq = await blobGet(st, PQ.QUAL_KEY);
    if (!pq.ok) { await release('QUALITY_READ_FAILED', pq.code); return; }
    const lr = await blobGet(st, PL.LESSONS_KEY);
    if (!lr.ok && lr.code !== 'NOT_FOUND') { await release('LESSONS_READ_FAILED', lr.code); return; }
    const lessons = PL.normLessons(lr.ok ? lr.data : null);   // 골격 — 읽기만(부딪히지 않게 학습 입력에 넘긴다)
    const drafts = QL.recentDrafts(pq.data);
    if (!drafts.length) { await release('NO_DRAFTS', '점수가 매겨진 사진AI 초안이 없습니다'); return; }
    const stats = QL.itemStats(drafts), focus = QL.focusOf(stats);
    const pp = QL.buildQLearnPrompt({ stats: stats, focus: focus, lessons: lessons.rules, rules: q0.rules, n: drafts.length });

    // 전송 직전 검사 — 학습 입력에는 계약 자료가 없지만(점수·본보기 값·규칙 문장뿐) 사진AI 워커와 같은 벽을 한 번 지난다
    let g = null; try { g = lib.scrubPayload({ system: pp.system, user: pp.user }, []); } catch (e) { g = null; }
    if (!g || !g.ok) { await release('LEAK_BLOCKED', '학습 입력 검사에 걸려 중단'); return; }

    const body = {
      model: lib.MODEL, max_tokens: MAX_TOKENS, system: pp.system,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: pp.schema } },
      messages: [{ role: 'user', content: [{ type: 'text', text: pp.user }] }],
    };
    let json = null;
    try { json = await lib.callApi(process.env.GW_ANTHROPIC_KEY, body, TIMEOUT_MS); }
    catch (e) { await release((e && e.code) || 'API_FAILED', (e && (e.detail || e.message)) || ''); return; }
    if (json && json.stop_reason === 'refusal') { await release('REFUSAL'); return; }
    const usage = (json && json.usage) || {};
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const out = parseOut(lib.responseText(json));
    if (!out || !Array.isArray(out.rules)) { await release('PARSE_FAILED', '품질 규칙 JSON을 읽지 못했습니다'); return; }

    // 쓰기 직전 다시 읽고 합친다 — 그새 바뀐 끄기 스위치를 덮지 않는다
    const cur = await blobGet(st, QL.QLEARN_KEY);
    const base = QL.normQL(cur.ok ? cur.data : null);
    const merged = QL.mergeQL(base, out, { now: Date.now(), tokens: tokens, sig: QL.basisSig(pq.data, lessons.rules), focus: focus, n: drafts.length });
    const w = await blobSet(st, QL.QLEARN_KEY, merged);
    if (!w.ok) { await release(w.code || 'QL_WRITE_FAILED'); return; }
  } catch (e) {
    try { await release('WORKER_THREW', (e && e.message) || String(e)); } catch (e2) {}
  }
};
