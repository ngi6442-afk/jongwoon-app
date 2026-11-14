'use strict';
// 29 판④-4 월말명세서 AI 판독 — Netlify Background Function(-background, 15분). 앱이 stmt_read로 원본을 맡기고(gw_files stmtsrc:<id>) {id}로 부른다.
// 결과는 gw_files stmtread:<id>({ ts, bid, ym, vk, ok, result|code })에 쓰고 맡긴 표(stmtsrc:<id>)는 곧바로 지운다.
// 29 판⑥(PM 11/14 '첨부'): 첨부 원본(stmt_drop)이면 맡긴 표는 원본 대신 첨부 키(file: stmtfile:<id>)만 들고 — 원본은 남는다 — 끝나면 목록 한 줄(gw_data stmtdrop:<ym>:<id>)을 read·fail로 고친다.
// 권한은 gw-stmt와 같은 규칙(월말명세서 수행 · 차량 숨김 아님 · 기기 승인) + 맡긴 사람만(판독 요금).
const { setupBlobContext, store, blobGet, blobSet, blobDelete, blobList } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');
const tier = require('./_lib/tier');
const RD = require('./_lib/stmtread');
const SV = require('./_lib/stmtvision');

const FILES = 'gw_files', DATA = 'gw_data', USERS = 'gw_users';
const RE_ID = /^[a-f0-9]{24}$/;

function stmtDo(m) { return !!m && (m.admin || (m.perms && m.perms.stmt === 'do')); }
function vehHidden(m) { return !m.admin && !!(m.perms && m.perms.veh === 'hide'); }
async function deviceOk(event, m) {
  if (m.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), 'device:' + id);
  return !!(r.ok && r.data && r.data.status === 'approved');
}
async function memberNames() {   // 출력 걸러내기용 회원 이름(재직·퇴사 모두 — 장부에 남은 이름도 빼게)
  try {
    const l = await blobList(store(USERS), 'member:');
    const keys = (l.ok && Array.isArray(l.keys)) ? l.keys.slice(0, 200) : [];
    const out = [];
    for (const k of keys) { const r = await blobGet(store(USERS), k); if (r.ok && r.data && r.data.name) out.push(String(r.data.name).trim()); }
    return out.filter(function (n) { return n.length >= 2; });
  } catch (e) { return []; }
}
async function usage(ym, res) {
  try {
    const key = 'usage:stmt:' + ym, r = await blobGet(store(DATA), key);
    const u = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
    u.calls = (Number(u.calls) || 0) + 1;
    u.in = (Number(u.in) || 0) + (Number(res && res.usage && res.usage.in) || 0);
    u.out = (Number(u.out) || 0) + (Number(res && res.usage && res.usage.out) || 0);
    if (!res || !res.ok) u.err = (Number(u.err) || 0) + 1;
    await blobSet(store(DATA), key, u);
  } catch (e) { /* 사용량 기록 실패가 판독을 막지 않는다 */ }
}

exports.handler = async function (event, context) {
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok) return;
    const mr = await blobGet(store(USERS), 'member:' + v.payload.mid);
    const m = mr.ok ? mr.data : null;
    if (!m || m.del === 1 || tier.retired(m) || !stmtDo(m) || vehHidden(m)) return;
    if (!(await deviceOk(event, m))) return;
    let d = {};
    try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    const id = String(d.id || '');
    if (!RE_ID.test(id)) return;
    const src = await blobGet(store(FILES), 'stmtsrc:' + id);
    if (!src.ok || !src.data) return;
    if (src.data.bid !== m.id && !m.admin) return;   // 맡긴 사람(또는 관리자)만
    const rec = { ts: Date.now(), bid: src.data.bid, ym: src.data.ym, vk: src.data.vk };
    let out;
    try {
      // 29 판⑥ 첨부 원본 판독 — 맡긴 표(stmtsrc)는 원본 대신 첨부 키(stmtfile:<id>)만 듦(원본은 지우지 않음)
      let b64 = String(src.data.data || '');
      if (!b64 && /^stmtfile:[a-f0-9]{24}$/.test(String(src.data.file || ''))) { const f = await blobGet(store(FILES), src.data.file); b64 = (f.ok && f.data && f.data.data) ? String(f.data.data) : ''; }
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw Object.assign(new Error('no file'), { code: 'NO_FILE' });
      const vendor = src.data.vendor || {};
      const names = await memberNames();
      out = await RD.readByAi(buf, src.data.mode, { ym: src.data.ym, vk: src.data.vk, vendor: vendor, names: names });
    } catch (e) { out = { ok: false, code: (e && e.code === 'NO_FILE') ? 'NO_FILE' : 'READ_FAILED' }; }
    await blobSet(store(FILES), 'stmtread:' + id, Object.assign(rec, out.ok ? { ok: true, result: out.result, skipped: out.skipped || [] } : { ok: false, code: out.code || 'READ_FAILED' }));
    const drop = src.data.drop;   // 29 판⑥ 목록 한 줄(gw_data stmtdrop:<ym>:<id>)을 read·fail로 — 그 사이 거래처를 바꿔 다시 맡겼으면(job 다름) 건드리지 않음
    if (drop && /^\d{4}-\d{2}$/.test(String(drop.ym)) && RE_ID.test(String(drop.id))) {
      try {
        const k = 'stmtdrop:' + drop.ym + ':' + drop.id, g = await blobGet(store(DATA), k);
        if (g.ok && g.data && g.data.job === id) {
          const e = g.data;
          e.job = '';
          if (out.ok) { e.state = 'read'; e.result = out.result; e.n = out.result.rows.length; e.src = 'vision'; e.warn = (out.result.warn || []).length; e.code = ''; }
          else { e.state = 'fail'; e.code = out.code || 'READ_FAILED'; e.result = null; e.n = 0; }
          await blobSet(store(DATA), k, e);
        }
      } catch (e) { /* 목록 표시 실패 — 결과는 stmtread에 있음 */ }
    }
    await blobDelete(store(FILES), 'stmtsrc:' + id);
    await usage(src.data.ym, out);
    try {
      const n = out.ok && out.result ? out.result.rows.length : 0;
      await appendAudit({ ts: Date.now(), by: m.name, bid: m.id, col: 'stmt', ev: [{ op: '명세서판독', id: src.data.ym + ':' + src.data.vk, t: out.ok ? ('AI 판독 ' + n + '줄') : ('AI 판독 실패 ' + String(out.code || '')) }] });
    } catch (e) {}
  } catch (e) {
    try { console.log('[gw-stmt-read-background] ' + String((e && e.message) || e).slice(0, 200)); } catch (e2) {}
  }
};
