'use strict';

// 홍보 사진 임시 공개 배포 — "완성본 한 장"을 네이버 글쓰기에 붙여넣을 때 쓴다.
//
// 왜 필요한가: 에디터들은 보안상 base64 내장 이미지(data: URI)를 붙여넣기에서 버리는 일이 잦다.
// 사진이 **진짜 http 주소**로 있으면 붙여넣는 쪽이 그 주소를 받아 자기 서버로 가져간다.
// 그래서 승인 전 사람이 누른 그 순간에만, 그 기록의 사진에 한해, 짧게 공개 주소를 연다.
//
// 노출 범위를 좁히는 장치(설계 의도 — 임의로 완화하지 말 것):
//   ① 발급은 로그인+홍보 수행 권한자만(share_make). ② 대상은 그 기록의 사진(kind:'promo')뿐.
//   ③ 토큰은 32바이트 난수(추측 불가), ④ 24시간 뒤 자동 만료, ⑤ 인덱스로만 접근(첨부 id 비노출).
// 애초에 공개 블로그에 실릴 사진이라 성격상 공개 대상이지만, 그래도 기간·범위를 묶어 둔다.
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');

const DATA = 'gw_data';
const USERS = 'gw_users';
const FILES = 'gw_files';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }

const RE_ATT = /^att_[a-f0-9]{16}$/i;
const RE_SHARE = /^[a-f0-9]{64}$/;
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const SHARE_TTL_MS = 24 * 3600 * 1000;
const MAX_IMGS = 40;                         // 한 기록의 사진 상한(현행 업로드 상한 20장의 두 배 여유)
function shareKey(s) { return `promo:share:${s}`; }

function kstDate(o) { return new Date(Date.now() + 9 * 3600000 + (o || 0) * 86400000).toISOString().slice(0, 10); }
function retired(m) { const ld = m && m.leave_date; return ld ? String(ld) < kstDate(0) : false; }
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
// 홍보 수행 권한(gw-data permOf와 동일 규칙 — 관리자는 통과)
function canPromo(m) {
  if (!m) return false;
  if (m.admin) return true;
  const p = m.perms || {};
  return p.promo === 'do';
}

// 발급: 그 기록의 사진 id 목록을 스냅샷으로 굳혀 둔다(나중에 기록이 바뀌어도 링크가 다른 사진을 가리키지 않게).
async function handleShareMake(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { status: 'UNAUTHORIZED', error_code: c.reason, request_id: R });
  if (!canPromo(c.member)) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_PROMO', request_id: R });
  const pid = String(d.promo_id || '');
  if (!RE_REC_ID.test(pid)) return jr(400, { status: 'REJECTED', error_code: 'BAD_ID', request_id: R });

  const cr = await blobGet(store(DATA), 'col:promo');
  if (!cr.ok || !cr.data) return jr(404, { status: 'REJECTED', error_code: 'NO_COLLECTION', request_id: R });
  const items = (cr.data.items || []).filter(function (x) { return x && x.id === pid && x.del !== 1; });
  if (!items.length) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });

  const ids = (items[0].photos || []).map(function (ph) { return String((ph && ph.id) || ''); })
    .filter(function (id) { return RE_ATT.test(id); }).slice(0, MAX_IMGS);
  if (!ids.length) return jr(400, { status: 'REJECTED', error_code: 'NO_PHOTOS', request_id: R });

  const s = crypto.randomBytes(32).toString('hex');
  const w = await blobSet(store(DATA), shareKey(s), { ids: ids, promo_id: pid, exp: Date.now() + SHARE_TTL_MS, by: c.member.name, ts: Date.now() });
  if (!w.ok) return jr(500, { status: 'ERROR', error_code: w.code || 'STORAGE_WRITE_FAILED', request_id: R });
  return jr(200, { status: 'OK', share: s, n: ids.length, expires_in_h: 24, request_id: R });
}

// 공개 조회: 토큰+인덱스로만. 첨부 id를 받지 않는다(다른 첨부 열람 통로가 되지 않게).
async function handleImg(qs, R) {
  const s = String((qs && qs.s) || '');
  if (!RE_SHARE.test(s)) return jr(400, { status: 'REJECTED', error_code: 'BAD_SHARE', request_id: R });
  const r = await blobGet(store(DATA), shareKey(s));
  if (!r.ok || !r.data) return jr(404, { status: 'REJECTED', error_code: 'NOT_FOUND', request_id: R });
  if (!r.data.exp || Date.now() > r.data.exp) return jr(410, { status: 'REJECTED', error_code: 'EXPIRED', request_id: R });

  const i = parseInt(String((qs && qs.i) || ''), 10);
  const ids = r.data.ids || [];
  if (!(i >= 0 && i < ids.length)) return jr(404, { status: 'REJECTED', error_code: 'BAD_INDEX', request_id: R });

  const fr = await blobGet(store(FILES), ids[i]);
  if (!fr.ok || !fr.data) return jr(404, { status: 'REJECTED', error_code: 'NO_FILE', request_id: R });
  // 홍보 사진만 — 다른 종류 첨부(계약·석면 등)는 이 통로로 절대 나가지 않는다
  if (String(fr.data.kind || '') !== 'promo') return jr(403, { status: 'FORBIDDEN', error_code: 'NOT_PROMO', request_id: R });

  return {
    statusCode: 200,
    headers: Object.assign({
      'Content-Type': String(fr.data.type || 'image/jpeg'),
      'Cache-Control': 'public, max-age=86400',
      'X-Robots-Tag': 'noindex'
    }, CORS),
    body: String(fr.data.data || ''),
    isBase64Encoded: true
  };
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    setupBlobContext(event);
    if (event.httpMethod === 'GET') return await handleImg(event.queryStringParameters || {}, R);
    if (event.httpMethod === 'POST') {
      let d = {}; try { d = JSON.parse(event.body || '{}'); } catch (e) { return jr(400, { status: 'REJECTED', error_code: 'BAD_JSON', request_id: R }); }
      if (d.action === 'share_make') return await handleShareMake(event, d, R);
      return jr(400, { status: 'REJECTED', error_code: 'UNKNOWN_ACTION', request_id: R });
    }
    return jr(405, { status: 'REJECTED', error_code: 'METHOD', request_id: R });
  } catch (e) {
    return jr(500, { status: 'ERROR', error_code: 'SERVER', request_id: R });
  }
};
