'use strict';
// 블로그 자동 학습 워커(v389) — Netlify Background Function. 크론(gw-promo-ai-cron ④)이 내부 토큰(mid='__promoai__')으로 짝 1건씩 기동한다.
// 하는 일: 짝 블롭(promolearn:in:<id>)의 직원 최종본 ↔ 보존된 모델 초안(promoai:draft:<기록id>, 없으면 기록 본문)을 모델에 보여
//   규칙을 뽑아 규칙 창고(promoai:lessons)와 합치고, 간극 점수를 남긴다. 사람(개발자)은 규칙을 쓰지 않는다.
// 자격증명·계약 차단은 사진AI 워커와 같은 규칙: 키는 GW_ANTHROPIC_KEY 인자 하나로만 흐르고, 계약 금지 문자열이 프롬프트·결과에 있으면 중단(LEAK_BLOCKED/RESULT_BLOCKED).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const PJ = require('./_lib/promoai_job');
const PL = require('./_lib/promolearn');

const DATA = 'gw_data';
const TIMEOUT_MS = 240000;
const MAX_TOKENS = 6000;
const EFFORT = 'medium';
const MAX_TEXT = 12000;

function loadLib() { try { return require('./_lib/promoai'); } catch (e) { return null; } }
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
  let st = null, pair = null, pairId = '';
  const scrub = makeScrub();
  const finish = async function (status, code, detail, extra) {
    if (!st || !pair) return;
    pair.status = status; pair.ts = Date.now();
    if (code) pair.code = cut(code, 40); else delete pair.code;
    if (detail) pair.detail = cut(scrub(detail), 160); else delete pair.detail;
    if (extra) Object.keys(extra).forEach(function (k) { pair[k] = extra[k]; });
    try { await blobSet(st, PL.pairKey(pairId), pair); } catch (e) {}
  };
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__promoai__') return;
    let d = {}; try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    pairId = String(d.pair_id || '').trim();
    if (!PL.RE_PAIR_ID.test(pairId)) return;
    st = store(DATA);
    const pr = await blobGet(st, PL.pairKey(pairId));
    if (!pr.ok || !pr.data) return;
    pair = pr.data;
    if (pair.status === 'done') return;
    if (!PL.RE_REC_ID.test(String(pair.promo_id || ''))) { await finish('unmatched', 'NO_PROMO_ID', '짝 맞춘 기록이 없습니다'); return; }
    await blobSet(st, PL.LOCK_KEY, { ts: Date.now(), pair: pairId });
    if (!process.env.GW_ANTHROPIC_KEY) { await finish('fail', 'ENV_MISSING'); return; }
    const lib = loadLib();
    if (!lib) { await finish('fail', 'LIB_MISSING'); return; }

    const pm = await blobGet(st, 'col:promo');
    if (!pm.ok) { await finish('fail', 'PROMO_READ_FAILED', pm.code); return; }
    const items = (pm.data && Array.isArray(pm.data.items)) ? pm.data.items : [];
    const rec = items.filter(function (it) { return it && it.id === pair.promo_id && it.del !== 1; })[0] || null;
    if (!rec) { await finish('fail', 'PROMO_NOT_FOUND'); return; }

    // 초안 — 보존본(생성 때 저장) 최신 1건. 없으면 기록 본문(AI 결과가 그대로 남아 있는 옛 기록 — src 'record'로 표시, 앱에서 손본 글이면 간극이 작게 나올 수 있다)
    let draft = null;
    const dr = await blobGet(st, PL.draftKey(rec.id));
    if (dr.ok && dr.data && Array.isArray(dr.data.items) && dr.data.items.length) {
      const it = dr.data.items[dr.data.items.length - 1];
      if (it && it.body) draft = { title: cut(it.title, 200), body: cut(it.body, MAX_TEXT), src: 'draft', job: String(it.job || '') };
    }
    if (!draft && rec.ai && rec.body) draft = { title: cut(rec.title, 200), body: cut(rec.body, MAX_TEXT), src: 'record', job: '' };
    if (!draft) { await finish('fail', 'NO_DRAFT', '모델 초안이 없는 기록입니다(사진AI 생성 전)'); return; }

    const finalTitle = cut(PL.cleanFinal(pair.final_title), 200), finalBody = cut(PL.cleanFinal(pair.final_body), MAX_TEXT);
    if (!finalBody) { await finish('fail', 'EMPTY_FINAL', '최종본 본문이 비었습니다'); return; }

    const lr = await blobGet(st, PL.LESSONS_KEY);
    const lessons = PL.normLessons(lr.ok ? lr.data : null);
    const facility = PL.facilityKey(rec);
    const pp = PL.buildLearnPrompt({ draft_title: draft.title, draft_body: draft.body, final_title: finalTitle, final_body: finalBody, rules: lessons.rules, facility: facility });

    // 계약 금지 문자열 — 기록이 계약을 참조하면 그 계약의 금액·발주처 등이 프롬프트에 있으면 중단(사진AI 워커와 같은 벽)
    let forbidden = [];
    if (rec.contract_id) {
      const cr = await blobGet(st, 'col:contracts');
      const cRec = (cr.ok && cr.data && Array.isArray(cr.data.items)) ? (cr.data.items.filter(function (it) { return it && it.id === rec.contract_id && it.del !== 1; })[0] || null) : null;
      if (cRec) { try { forbidden = lib.contractForbidden(cRec) || []; } catch (e) { forbidden = []; } }
    }
    const g1 = lib.scrubPayload({ system: pp.system, user: pp.user }, forbidden);
    if (!g1.ok) { await finish('fail', 'LEAK_BLOCKED', '계약 금지 문자열이 학습 입력에 있어 중단'); return; }

    const body = {
      model: lib.MODEL, max_tokens: MAX_TOKENS, system: pp.system,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: pp.schema } },
      messages: [{ role: 'user', content: [{ type: 'text', text: pp.user }] }],
    };
    let json = null;
    try { json = await lib.callApi(process.env.GW_ANTHROPIC_KEY, body, TIMEOUT_MS); }
    catch (e) { await finish('fail', (e && e.code) || 'API_FAILED', (e && (e.detail || e.message)) || ''); return; }
    if (json && json.stop_reason === 'refusal') { await finish('fail', 'REFUSAL'); return; }
    const usage = (json && json.usage) || {};
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const out = parseOut(lib.responseText(json));
    if (!out || !Array.isArray(out.rules)) { await finish('fail', 'PARSE_FAILED', '규칙 JSON을 읽지 못했습니다', { tokens: tokens }); return; }
    // 결과 재검사 — 규칙·요약에 계약 문자열이 섞이면 그 항목을 버린다(전체 중단 대신 항목 단위)
    if (forbidden.length) {
      out.rules = out.rules.filter(function (r) { return r && lib.scrubPayload(String(r.text || ''), forbidden).ok; });
      if (!lib.scrubPayload(String(out.summary || ''), forbidden).ok) out.summary = '';
    }
    const gap = PL.gapScore(draft.body, finalBody);
    // v394 포장 간극 — 복사 때 앱이 저장한 줄 계획(promoai:copy:<기록>) ↔ 게시글 줄 배치(final_layout). 둘 중 하나가 없으면 재지 않는다.
    try {
      if (Array.isArray(pair.final_layout) && pair.final_layout.length) {
        const cp = await blobGet(st, PL.copyKey(rec.id));
        if (cp.ok && cp.data && Array.isArray(cp.data.lines) && cp.data.lines.length) gap.layout = PL.layoutGap(cp.data.lines, pair.final_layout);
      }
    } catch (e) {}
    const merged = PL.mergeLessons(lessons, out, { promo_id: rec.id, pair_id: pairId, final_title: finalTitle, final_body: finalBody, facility: facility, now: Date.now(), tokens: tokens, gap: gap, summary: out.summary });
    const w = await blobSet(st, PL.LESSONS_KEY, merged);
    if (!w.ok) { await finish('fail', w.code || 'LESSONS_WRITE_FAILED'); return; }
    await finish('done', '', '', { gap: gap, rules_n: merged.rules.length, draft_src: draft.src, draft_job: draft.job, tokens: tokens, summary: cut(out.summary, 200), changes: (Array.isArray(out.changes) ? out.changes : []).slice(0, 12).map(function (c) { return { kind: String((c && c.kind) || ''), what: cut(c && c.what, 100) }; }) });
    try { await PJ.updatePromo(st, rec.id, function (r) { r.learn = { ts: Date.now(), gap: gap.ratio, pair: pairId, src: draft.src }; return {}; }); } catch (e) {}
  } catch (e) {
    try { await finish('fail', 'WORKER_THREW', (e && e.message) || String(e)); } catch (e2) {}
  } finally {
    try { if (st) { const cur = await blobGet(st, PL.LOCK_KEY); if (cur.ok && cur.data && cur.data.pair === pairId) await blobSet(st, PL.LOCK_KEY, { ts: 0, pair: '' }); } } catch (e3) {}
  }
};
