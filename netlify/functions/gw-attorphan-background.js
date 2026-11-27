'use strict';
// C289(11/27) 오래 참조 없는 첨부 정리 — 연습 방식 워커(Netlify Background Function, 15분 한도). 지우지 않고 보고 문서(attorphan:report)만 쓴다.
// 예약 크론 gw-attorphan-cron(주 1회)이 내부 토큰(mid='__attorphan__')으로 기동한다. 판정 규칙은 _lib/attorphan.js.
const { setupBlobContext, store, blobGet, blobSet, blobList } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const AO = require('./_lib/attorphan');
const { stamp } = require('./_lib/cronstamp');

exports.handler = async function (event, context) {
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__attorphan__') return;
    const r = await AO.run({ store: store, blobGet: blobGet, blobSet: blobSet, blobList: blobList }, Date.now());
    console.log('[첨부 정리 연습] 첨부 ' + r.att + ' · 지울 후보 ' + r.n_candidates + ' · 새 고아 ' + r.n_fresh + (r.partial ? ' · 읽기 실패 ' + r.read_fail + '(이번 회차는 판정 그대로)' : ''));
    await stamp('gw-attorphan-cron', { state: 'end', ok: !!r.ok && !r.partial, note: (r.partial ? 'partial ' : '') + 'cand ' + r.n_candidates });
  } catch (e) {
    try { await stamp('gw-attorphan-cron', { state: 'end', ok: false, note: 'WORKER_THREW ' + String((e && e.message) || '').slice(0, 60) }); } catch (e2) {}
  }
};
