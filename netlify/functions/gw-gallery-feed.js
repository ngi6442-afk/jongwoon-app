'use strict';

// 갤러리 빌드 피드 — 홈페이지 빌드가 "현재 게시된 현장 글 목록"을 통째로 받아 가는 읽기 전용 통로.
//
// 왜 만들었나(2026-08-25 PM 결정 '근본안-나'): 종전 gw-gallery-relay는 게시할 때마다 website 레포에
// 브랜치를 만들고 PR을 냈다. 그 PR은 staging행이라 main까지 올리려면 PM 머지가 두 번 필요했다.
// 게시 한 번에 사람 손이 두 번 붙는 구조여서, 게시 → 홈페이지 재빌드 → 반영으로 바꾼다.
// 이 함수는 그 재빌드가 데이터를 길어가는 수도꼭지다. 쓰기는 전혀 하지 않는다(순수 GET).
//
// 왜 이미지를 따로 받게 했나: 카드가 쌓일수록 사진을 한 응답에 담으면 함수 응답 상한(6MB)에 걸린다.
// 그래서 index는 목록(사진은 파일명 + 첨부 id만), img는 한 장씩 바이트를 준다. 빌드가 N+1번 호출한다.
//
// 노출 범위(임의로 넓히지 말 것): ① 빌드 키(GW_GALLERY_FEED_KEY)를 아는 쪽만, ② status='posted' +
// blog_url 있는 기록만(=이미 공개 블로그에 실린 글), ③ 사진은 그 기록의 kind='promo' 첨부 앞 3장만.
// 첨부 id를 직접 받지 않고 index가 내준 목록 안에 있을 때만 내준다(다른 첨부 열람 통로가 되지 않게).
const crypto = require('crypto');
const { setupBlobContext, store, blobGet } = require('./_lib/blobs');

const DATA = 'gw_data';
const FILES = 'gw_files';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body, extra) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extra || {}), body: JSON.stringify(body) };
}

const RE_ATT = /^att_[a-f0-9]{16}$/i;
const RE_BLOG_URL = /^https?:\/\/[^\s"'<>]+$/;
const MAX_PHOTOS = 3;                                   // 확정사양 ⑥: 대표 3장

// 홈페이지 갤러리 tag 화이트리스트 6개 — gw-gallery-relay와 같은 규칙(바뀌면 양쪽을 같이 고칠 것).
// 검사 순서 중요: 석면·철거·CCTV·재활용을 폐기물·준설보다 먼저.
const TAG_RULES = [
  ['석면', /석면|슬레이트/],
  ['건설', /철거|해체/],
  ['CCTV', /CCTV|cctv/],
  ['재활용', /재활용/],
  ['수집·운반', /폐기물|수집운반|수집·운반/],
];
function siteTag(rec) {
  const txt = String((rec && rec.facility) || '') + ' ' + String((rec && rec.problem) || '') + ' ' + String((rec && rec.title) || '');
  for (const r of TAG_RULES) { if (r[1].test(txt)) return r[0]; }
  return '준설';
}

function kstDate(o) { return new Date(Date.now() + 9 * 3600000 + (o || 0) * 86400000).toISOString().slice(0, 10); }
function clamp(v, n) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) : s; }

// 카드 날짜 = 게시일(PM 결정 2026-08-25). 사진 EXIF 촬영일(shot_at)을 쓰면 겨울 사진으로 쓴 글이
// 1월 날짜를 달고 목록 맨 아래로 내려간다 — 첫 자동 카드에서 실제로 발생했다. gw-gallery-relay와 동일 규칙.
function itemDate(rec) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(rec.posted_at || ''))) return String(rec.posted_at);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(rec.updated || ''))) return String(rec.updated);
  return kstDate(0);
}

// 파일명은 기록 id + 순번으로 결정론적으로 만든다. 빌드가 매번 같은 이름을 받아야
// 재빌드마다 사진이 새 파일로 쌓이지 않는다(relay는 난수를 붙였지만 여기서는 안 된다).
function imgName(pid, idx, ext) { return 'gw-' + pid + '-' + idx + '.' + ext; }

function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

function keyOk(qs) {
  const want = String(process.env.GW_GALLERY_FEED_KEY || '');
  if (!want) return false;                              // 키 미설정이면 아예 닫는다(기본 개방 금지)
  const got = String((qs && qs.key) || '');
  const a = Buffer.from(got); const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// 게시 완료 + 블로그 주소가 있는 기록만. 삭제분(del=1)은 제외.
async function postedRecords() {
  const cr = await blobGet(store(DATA), 'col:promo');
  if (!cr.ok || !cr.data) return null;
  return (cr.data.items || []).filter(function (x) {
    return x && x.del !== 1 && String(x.status || '') === 'posted' && RE_BLOG_URL.test(String(x.blog_url || ''));
  });
}

// 목록 — 사진은 바이트 대신 (파일명, 첨부 id) 쌍으로만 준다.
async function handleIndex(R) {
  const recs = await postedRecords();
  if (recs === null) return jr(502, { ok: false, code: 'NO_COLLECTION', request_id: R });

  const items = [];
  for (const rec of recs) {
    const pid = String(rec.id || '');
    if (!pid) continue;
    const photos = Array.isArray(rec.photos) ? rec.photos : [];
    const imgs = [];
    for (const ph of photos) {
      if (imgs.length >= MAX_PHOTOS) break;
      const id = String((ph && ph.id) || '');
      if (!RE_ATT.test(id)) continue;
      const fr = await blobGet(store(FILES), id);
      if (!fr.ok || !fr.data || String(fr.data.kind || '') !== 'promo') continue;
      let buf; try { buf = Buffer.from(String(fr.data.data || ''), 'base64'); } catch { continue; }
      const ext = detectImageExt(buf);
      if (!ext) continue;
      imgs.push({ file: imgName(pid, imgs.length + 1, ext), att: id, bytes: buf.length });
    }
    if (!imgs.length) continue;                         // 사진 없는 글은 카드로 내보내지 않는다

    const descParts = [clamp(rec.region, 60), clamp(rec.facility, 80), clamp(rec.problem, 80)].filter(Boolean);
    items.push({
      promo_id: pid,
      title: clamp(rec.title, 200) || (descParts.join(' ') || '현장 기록'),
      date: itemDate(rec),
      tag: siteTag(rec),
      url: String(rec.blog_url),
      description: descParts.length ? (descParts.join(' · ') + ' 현장 기록입니다.') : '',
      images: imgs,
    });
  }
  // 홈페이지 렌더러가 date 내림차순으로 정렬하므로 여기서도 같은 순서로 내보낸다.
  items.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return jr(200, { ok: true, generated: kstDate(0), count: items.length, items: items, request_id: R });
}

// 사진 한 장 — index가 내준 목록에 있는 첨부만. 첨부 id를 그대로 믿지 않는다.
async function handleImg(qs, R) {
  const att = String((qs && qs.img) || '');
  if (!RE_ATT.test(att)) return jr(400, { ok: false, code: 'BAD_ATT', request_id: R });

  const recs = await postedRecords();
  if (recs === null) return jr(502, { ok: false, code: 'NO_COLLECTION', request_id: R });
  const allowed = recs.some(function (rec) {
    const photos = Array.isArray(rec.photos) ? rec.photos : [];
    return photos.slice(0, MAX_PHOTOS).some(function (ph) { return String((ph && ph.id) || '') === att; });
  });
  if (!allowed) return jr(404, { ok: false, code: 'NOT_IN_FEED', request_id: R });

  const fr = await blobGet(store(FILES), att);
  if (!fr.ok || !fr.data) return jr(404, { ok: false, code: 'NO_FILE', request_id: R });
  if (String(fr.data.kind || '') !== 'promo') return jr(403, { ok: false, code: 'NOT_PROMO', request_id: R });

  return {
    statusCode: 200,
    headers: Object.assign({
      'Content-Type': String(fr.data.type || 'image/jpeg'),
      'Cache-Control': 'public, max-age=86400',
    }, CORS),
    body: String(fr.data.data || ''),
    isBase64Encoded: true,
  };
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return jr(405, { ok: false, code: 'METHOD', request_id: R });
  const qs = event.queryStringParameters || {};
  if (!keyOk(qs)) return jr(403, { ok: false, code: 'BAD_KEY', request_id: R });
  try {
    setupBlobContext(event);
    if (qs.img) return await handleImg(qs, R);
    return await handleIndex(R);
  } catch (e) {
    return jr(500, { ok: false, code: 'SERVER', request_id: R });
  }
};
