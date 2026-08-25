'use strict';

// 홈페이지 재빌드 트리거 — 현장 글을 게시하면 홈페이지가 스스로 다시 빌드되게 한다.
//
// 배경(2026-08-25 PM 결정 '근본안-나'): 종전에는 게시할 때마다 website 레포에 PR이 생기고
// PM이 두 번(staging 머지 → main 머지) 눌러야 홈페이지에 올라갔다. 이제는 이 함수가 Netlify
// 빌드 훅을 한 번 때리고, 홈페이지 빌드가 gw-gallery-feed에서 카드·사진을 받아 구워 배포한다.
// 커밋도 PR도 생기지 않는다.
//
// 전환 방식(플래그 데이 없음): 빌드 훅 주소(GW_SITE_BUILD_HOOK)가 설정돼 있으면 configured:true를
// 돌려주고, 앱 화면은 그때부터 PR 릴레이를 부르지 않는다. 설정 전에는 configured:false여서
// 기존 PR 경로가 그대로 살아 있다. 즉 PM이 Netlify에 훅을 만들어 환경변수에 넣는 순간 자동으로 바뀐다.
//
// 훅 주소는 그 자체가 자격증명이다(아는 사람은 누구나 빌드를 돌릴 수 있다). 응답·로그·감사기록
// 어디에도 값을 남기지 않는다 — 설정 여부만 부울로 노출한다.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');

const USERS = 'gw_users';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }

function kstDate(o) { return new Date(Date.now() + 9 * 3600000 + (o || 0) * 86400000).toISOString().slice(0, 10); }
function retired(m) { const ld = m && m.leave_date; return ld ? String(ld) < kstDate(0) : false; }
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
// 홍보 수행 권한(gw-promo-img·gw-gallery-relay와 동일 규칙)
function canPromo(m) {
  if (!m) return false;
  if (m.admin) return true;
  return ((m.perms || {}).promo) === 'do';
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD', request_id: R });

  try {
    setupBlobContext(event);
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
    const c = await currentMember(event);
    if (!c.ok) return jr(401, { ok: false, code: c.reason, request_id: R });
    if (!canPromo(c.member)) return jr(403, { ok: false, code: 'NO_PROMO', request_id: R });

    const hook = String(process.env.GW_SITE_BUILD_HOOK || '').trim();
    if (!hook) {
      // 아직 훅이 없다 — 호출한 화면이 기존 PR 경로로 되돌아가도록 알린다(오류가 아니다).
      return jr(200, { ok: true, configured: false, request_id: R });
    }
    if (!/^https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9]+$/.test(hook)) {
      // 형식이 다르면 때리지 않는다. 잘못된 주소로 요청을 흘리지 않기 위한 방어.
      return jr(500, { ok: false, configured: true, code: 'BAD_HOOK_FORMAT', request_id: R });
    }

    let res;
    try {
      res = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger_title: '현장 글 게시 — 갤러리 재빌드' }),
      });
    } catch (e) {
      return jr(502, { ok: false, configured: true, code: 'HOOK_UNREACHABLE', request_id: R });
    }
    if (!res.ok) return jr(502, { ok: false, configured: true, code: 'HOOK_FAILED', status: res.status, request_id: R });

    try {
      await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo',
        ev: [{ op: '홈페이지재빌드', id: String((body && body.promo_id) || ''), t: '갤러리 게시로 사이트 재빌드 요청' }] });
    } catch (e) { /* 감사 실패가 빌드 요청을 되돌리지는 않는다 */ }

    return jr(200, { ok: true, configured: true, request_id: R });
  } catch (e) {
    return jr(500, { ok: false, code: 'SERVER', request_id: R });
  }
};
