'use strict';
// 계약 서류 학습 워커(v411, 계약 D4 3일차) — Netlify Background Function. 크론 ④(gw-promo-ai-cron, 블로그 짝이 없을 때 교대)가 내부 토큰(mid='__promoai__')으로 짝 1건씩 기동한다.
// 하는 일: 짝(learn:contract:in:<id>)의 초안 채움 맵 ↔ 최종본 xlsx를 셀 단위로 읽어 **허용 사전(settings:learn.contract.allow[양식])에 든 셀만 값을** 모델에 보여주고,
//   나머지 셀은 바뀜/안 바뀜만 보여 규칙(field_default·format·structure·content·style)을 뽑아 규칙 창고(lessons:contract:<양식>)와 합친다. 사람은 규칙을 쓰지 않는다(PM 10/19·11/1).
// 차단: 허용 사전 없음=모델 호출 없음(done_nomodel) · 주민번호·연락처·계좌 패턴이 전송 본문에 있으면 LEAK_BLOCKED(마스킹 안 함, 중단) · 계약 id·입찰번호 scrub · 월 상한 usage:learn:contract:<YYYY-MM>(200)
//   · 결과 규칙에 금지 패턴이 섞이면 그 항목만 버림 · 키는 GW_ANTHROPIC_KEY 인자 하나.
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const LN = require('./_lib/learn');
const DD = require('./_lib/docdiff');
const CL = require('./_lib/claude');
const BF = require('./_lib/boxfile');

const DATA = 'gw_data', FILES = 'gw_files';
const TIMEOUT_MS = 180000;
const MAX_TOKENS = 4000;
const EFFORT = 'medium';
const T = LN.TYPES.contract;

function cut(s, n) { return String(s === null || s === undefined ? '' : s).slice(0, n); }
function cdocKey(cid, i, dk, n) { return 'cdoc:' + cid + ':S' + String(i).padStart(2, '0') + ':' + dk + ':' + n; }
function makeScrub() {
  const key = String(process.env.GW_ANTHROPIC_KEY || '');
  return function (s) { s = String(s || ''); if (key && key.length >= 8) { while (s.indexOf(key) >= 0) s = s.replace(key, '[REDACTED]'); } return s; };
}
function modelName() { try { return require('./_lib/promoai').MODEL; } catch (e) { return 'claude-sonnet-5'; } }

exports.handler = async function (event, context) {
  let st = null, pair = null, pairId = '';
  const scrub = makeScrub();
  const finish = async function (status, code, detail, extra) {
    if (!st || !pair) return;
    pair.status = status; pair.ts = Date.now();
    if (code) pair.code = cut(code, 40); else delete pair.code;
    if (detail) pair.detail = cut(scrub(detail), 160); else delete pair.detail;
    if (extra) Object.keys(extra).forEach(function (k) { pair[k] = extra[k]; });
    try { await blobSet(st, LN.pairKey('contract', pairId), pair); } catch (e) {}
  };
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__promoai__') return;
    let d = {}; try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    pairId = String(d.pair_id || '').trim();
    if (!T.pair_re.test(pairId)) return;
    st = store(DATA);
    const pr = await blobGet(st, LN.pairKey('contract', pairId));
    if (!pr.ok || !pr.data) return;
    pair = pr.data;
    if (pair.status === 'done' || pair.status === 'done_nomodel') return;
    if (!pair.tpl || !(pair.draft_n >= 1) || !(pair.final_n >= 1)) { await finish('unmatched', 'NO_DRAFT_PAIR', '초안 짝이 없습니다'); return; }
    await blobSet(st, T.lock_key, { ts: Date.now(), pair: pairId });

    // 허용 사전 — 없으면 모델 호출 없이 끝(간극은 cdoc_put 때 이미 쟀다)
    let s = {}; try { const r = await blobGet(st, T.settings_key); s = (r.ok && r.data && r.data.contract) ? r.data.contract : {}; } catch (e) {}
    const allow = (s.allow && Array.isArray(s.allow[pair.tpl])) ? s.allow[pair.tpl] : [];
    if (s.on !== true || !allow.length) { await finish('done_nomodel', 'NOT_ALLOWED', '허용 사전 없음 — 모델 호출 없이 간극만'); return; }
    if (!process.env.GW_ANTHROPIC_KEY) { await finish('fail', 'ENV_MISSING'); return; }
    // 월 상한
    const ym = LN.ymOf(Date.now()); const ur = await blobGet(st, LN.usageKey('contract', ym)); const usage = (ur.ok && ur.data) ? ur.data : null;
    if (!LN.usageOk(usage && usage.ym === ym ? usage : null, T.monthly_cap)) { await finish('hold', 'USAGE_CAP', '월 상한 ' + T.monthly_cap + '회 — 다음 달'); return; }

    // 재료: 초안 채움 맵(fill.edits) · 최종본 xlsx 바이트
    const dr = await blobGet(store(FILES), cdocKey(pair.cid, Number.isInteger(pair.draft_i) ? pair.draft_i : pair.i, 'gen.' + pair.tpl, pair.draft_n));   // v423 넣기 박스: 초안과 최종본이 다른 단계일 수 있다(draft_i)
    const fillFlat = (dr.ok && dr.data && dr.data.fill) ? DD.flattenEdits(dr.data.fill.edits) : null;   // v419 실제 초안은 시트별 객체 — 옛 평면 배열도 받는다
    if (!fillFlat) { await finish('fail', 'NO_FILL', '초안 채움 맵이 없습니다'); return; }
    const fr = await blobGet(store(FILES), cdocKey(pair.cid, pair.i, pair.dk, pair.final_n));
    let finalB64 = (fr.ok && fr.data && fr.data.data) ? String(fr.data.data) : '';
    if (!finalB64 && fr.ok && fr.data && fr.data.att) { try { const ar = await blobGet(store(FILES), fr.data.att); finalB64 = await BF.attReadB64(store(FILES), fr.data.att, ar.data); } catch (e) { finalB64 = ''; } }   // v423 큰 파일은 조각
    if (!finalB64) { await finish('fail', 'NO_FINAL', '최종본 바이트가 없습니다'); return; }
    const rows = DD.cellRows(fillFlat, Buffer.from(finalB64, 'base64'), allow);
    if (!rows.ok) { await finish('fail', rows.code || 'DIFF_FAILED'); return; }
    if (!rows.rows.length && !rows.hidden_changed.length) { await finish('done', 'NO_CHANGE', '바뀐 칸 없음 — 모델 호출 생략', { rules_n: null }); return; }

    const lk = T.lessons_key(pair.tpl); const lr = await blobGet(st, lk); const lessons = LN.normLessons(lr.ok ? lr.data : null);
    if (lessons.off) { await finish('done_nomodel', 'LESSONS_OFF', '이 양식 학습 끔'); return; }
    const pp = LN.buildContractPrompt({ tpl: pair.tpl, rules: lessons.rules, rows: rows.rows, hidden_changed: rows.hidden_changed, hidden_same_n: rows.hidden_same_n });
    // 2층 차단: 절대 금지 패턴(주민번호·연락처·계좌) → 중단 · 계약 식별자 scrub
    const pi = LN.piiScan(pp.user);
    if (!pi.ok) { await finish('fail', 'LEAK_BLOCKED', '금지 패턴(' + pi.code + ')이 전송 본문에 있어 중단 — 허용 사전 재검토'); return; }
    let forbidden = [];
    try { const cr = await blobGet(st, 'col:contracts'); const c = (cr.ok && cr.data && Array.isArray(cr.data.items)) ? cr.data.items.filter(function (x) { return x && x.id === pair.cid; })[0] : null; if (c) forbidden = [c.id, c.bid_id, c.lic_id].filter(function (x) { return x && String(x).length >= 4; }).map(String); } catch (e) {}
    const g1 = CL.scrubPayload({ system: pp.system, user: pp.user }, forbidden);
    if (!g1.ok) { await finish('fail', 'LEAK_BLOCKED', '계약 식별자가 학습 입력에 있어 중단'); return; }

    const body = { model: modelName(), max_tokens: MAX_TOKENS, system: pp.system, output_config: { effort: EFFORT, format: { type: 'json_schema', schema: pp.schema } }, messages: [{ role: 'user', content: [{ type: 'text', text: pp.user }] }] };
    let json = null;
    try { json = await CL.callApi(process.env.GW_ANTHROPIC_KEY, body, TIMEOUT_MS); }
    catch (e) { await finish('fail', (e && e.code) || 'API_FAILED', (e && (e.detail || e.message)) || ''); return; }
    if (json && json.stop_reason === 'refusal') { await finish('fail', 'REFUSAL'); return; }
    const tokens = CL.usageTokens(json);
    try { await blobSet(st, LN.usageKey('contract', ym), LN.usageAdd(usage, ym, tokens)); } catch (e) {}
    const out = CL.parseJsonOut(CL.responseText(json));
    if (!out || !Array.isArray(out.rules)) { await finish('fail', 'PARSE_FAILED', '규칙 JSON을 읽지 못했습니다', { tokens: tokens }); return; }
    // 결과 재검사 — 규칙·값·요약에 금지 패턴·계약 식별자가 섞이면 그 항목만 버린다
    out.rules = out.rules.filter(function (r) { const s2 = String((r && r.text) || '') + ' ' + String((r && r.value) || ''); return LN.piiScan(s2).ok && CL.scrubPayload(s2, forbidden).ok && (!r.field || allow.map(function (a) { return String(a).toUpperCase(); }).indexOf(String(r.field).toUpperCase()) >= 0 || r.scope !== 'field_default'); });
    if (!LN.piiScan(String(out.summary || '')).ok) out.summary = '';
    const gap = pair.gap || {};
    const merged = LN.mergeLessons(lessons, out, { rec_id: pair.cid, pair_id: pairId, ex_key: pair.tpl, ex_title: '', ex_excerpt: '', now: Date.now(), tokens: tokens, gap: { ratio: typeof gap.cell_ratio === 'number' ? gap.cell_ratio : null }, summary: out.summary, extra: { score: gap.score === undefined ? null : gap.score, kind: pair.kind || '', changed: rows.hidden_changed.length + rows.rows.filter(function (r) { return !r.same; }).length } }, T.scopes);
    LN.freezeBaseline(merged, Date.now());   // v412
    const w = await blobSet(st, lk, merged);
    if (!w.ok) { await finish('fail', w.code || 'LESSONS_WRITE_FAILED'); return; }
    await finish('done', '', '', { rules_n: merged.rules.length, tokens: tokens, summary: cut(out.summary, 200), changes: (Array.isArray(out.changes) ? out.changes : []).slice(0, 12).map(function (c) { return { kind: String((c && c.kind) || ''), what: cut(c && c.what, 100) }; }), visible_n: rows.rows.length, hidden_changed_n: rows.hidden_changed.length });
  } catch (e) {
    try { await finish('fail', 'WORKER_THREW', (e && e.message) || String(e)); } catch (e2) {}
  } finally {
    try { if (st) { const cur = await blobGet(st, T.lock_key); if (cur.ok && cur.data && cur.data.pair === pairId) await blobSet(st, T.lock_key, { ts: 0, pair: '' }); } } catch (e3) {}
  }
};
