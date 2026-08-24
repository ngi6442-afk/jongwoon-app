'use strict';

// 혁신⑥ 갤러리 동시 게시 — 게시 완료(posted)된 홍보 기록을 홈페이지 갤러리 카드로 보낸다.
//
// member-relay 실측(2026-08-24): 홈페이지 갤러리는 정적 파일 data/gallery.json을 js/gallery.js가
// 렌더하고, "CMS"의 실체는 website 레포의 Netlify 함수(member-gallery-relay.js)가 GitHub Git Trees로
// (이미지 + gallery.json)을 원자적 커밋해 staging 대상 PR을 만드는 구조다(자동 머지 없음, 머지는 PM).
// 그 relay는 홈페이지 회원 세션 전용이라 앱 서버가 호출할 수 없으므로, 이 함수가 같은 패턴
// (Trees 원자 커밋 → gw-gallery/ 브랜치 → base staging PR)을 앱 서버에서 직접 수행한다.
// 홈페이지 main은 절대 건드리지 않는다 — 이 함수의 쓰기는 새 브랜치 + PR 생성까지다.
//
// 발행 시점(확정사양 ⑥): 블로그 발행 확인 후 — 서버에 저장된 기록이 status='posted'이고
// blog_url이 있어야만 보낸다(클라이언트가 보낸 값은 promo_id 하나뿐, 나머지는 서버 기록으로 검증).
// 사진: 대표 3장(기록의 앞 3장). 업로드 시점에 이미 웹용으로 리사이즈돼 있다(1600px·jpeg q0.82).
// 중복 방지: gallery:pr:<promo_id> blob + gallery.json 내 같은 블로그 주소 존재 검사(재클릭은 기존 PR 안내).
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');

const DATA = 'gw_data';
const USERS = 'gw_users';
const FILES = 'gw_files';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }

const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const RE_ATT = /^att_[a-f0-9]{16}$/i;
const RE_BLOG_URL = /^https?:\/\/[^\s"'<>]+$/;
const MAX_PHOTOS = 3;                                   // 확정사양 ⑥: 대표 3장
const GALLERY_JSON_PATH = 'data/gallery.json';          // website 레포 경로(member-gallery-relay와 동일)
const GALLERY_IMG_DIR = 'img/gallery/';
const GALLERY_IMG_PUBLIC = '/img/gallery/';
const BRANCH_PREFIX = 'gw-gallery/';
const EVIDENCE_MARKER = '<!-- gw-gallery-evidence -->';
const BASE_BRANCH = 'staging';                          // 홈페이지 변경은 staging→PR→PM 머지만(main 금지)
function prKey(pid) { return `gallery:pr:${pid}`; }

// 홈페이지 갤러리 tag 화이트리스트(website member-gallery-relay ALLOWED_TAGS와 동일 6개).
// 기록의 시설·문제 텍스트에서 판정 — 앱 promoFacilType 키워드를 site tag로 접는다.
// 검사 순서 중요: 석면·철거·CCTV·재활용을 폐기물·준설 키워드보다 먼저(예: "하수관로 CCTV 조사"는 CCTV).
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
  return '준설';   // gutter/pipe/septic/tank/dredge 계열 기본값(promoFacilType 기본값과 동일 방향)
}

function kstDate(o) { return new Date(Date.now() + 9 * 3600000 + (o || 0) * 86400000).toISOString().slice(0, 10); }
function retired(m) { const ld = m && m.leave_date; return ld ? String(ld) < kstDate(0) : false; }
async function currentMember(event) {
  const v = verifyToken(bearer(event));
  if (!v.ok) return { ok: false, reason: v.reason };
  const r = await blobGet(store(USERS), `member:${v.payload.mid}`);
  if (!r.ok || !r.data || r.data.del === 1 || retired(r.data)) return { ok: false, reason: 'NO_MEMBER' };
  return { ok: true, member: r.data };
}
async function deviceApproved(event, member) {
  if (member.admin) return true;
  const h = (event && event.headers) || {};
  const id = String(h['x-device-id'] || '').trim();
  if (!id) return false;
  const r = await blobGet(store(USERS), `device:${id}`);
  return !!(r.ok && r.data && r.data.status === 'approved');
}
// 홍보 수행 권한(gw-promo-img canPromo와 동일 규칙)
function canPromo(m) {
  if (!m) return false;
  if (m.admin) return true;
  return ((m.perms || {}).promo) === 'do';
}

// ── GitHub API(website 레포 대상) — member-gallery-relay의 검증된 골격 복제 ──
function ghConfig() {
  const token = process.env.GW_GALLERY_GITHUB_TOKEN || process.env.MEMBER_RELAY_GITHUB_TOKEN;
  const owner = process.env.GW_GALLERY_GITHUB_OWNER || 'ngi6442-afk';
  const repo = process.env.GW_GALLERY_GITHUB_REPO || 'jongwoon-website';
  return { token, owner, repo };
}
function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gw-gallery-relay',
    'Content-Type': 'application/json',
  };
}
async function ghFetch(method, path, cfg, body) {
  return fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method, headers: ghHeaders(cfg.token), body: body ? JSON.stringify(body) : undefined,
  });
}

// 이미지 형식은 매직바이트로만 판정(member-gallery-relay detectImageExt와 동일)
function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// 대표 사진 취득 — 기록 앞 3장, gw_files에서 kind='promo'만(다른 종류 첨부는 이 통로로 나가지 않는다).
async function pickImages(rec, pid) {
  const out = [];
  const photos = Array.isArray(rec.photos) ? rec.photos : [];
  for (const ph of photos) {
    if (out.length >= MAX_PHOTOS) break;
    const id = String((ph && ph.id) || '');
    if (!RE_ATT.test(id)) continue;
    const fr = await blobGet(store(FILES), id);
    if (!fr.ok || !fr.data || String(fr.data.kind || '') !== 'promo') continue;
    const b64 = String(fr.data.data || '');
    if (!b64) continue;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
    const ext = detectImageExt(buf);
    if (!ext) continue;
    const name = `gw-${pid}-${out.length + 1}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    out.push({ repoPath: GALLERY_IMG_DIR + name, publicPath: GALLERY_IMG_PUBLIC + name, bytesB64: buf.toString('base64') });
  }
  return out;
}

function clamp(v, n) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) : s; }

// 갤러리 카드 항목 — website 데이터 모델(batch4-b1) 그대로: title/date/tag/description/images(경로 문자열 배열)/url
function buildItem(rec, imagePaths) {
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(rec.shot_at || '')) ? String(rec.shot_at).slice(0, 10)
    : (/^\d{4}-\d{2}-\d{2}$/.test(String(rec.updated || '')) ? String(rec.updated) : kstDate(0));
  const descParts = [clamp(rec.region, 60), clamp(rec.facility, 80), clamp(rec.problem, 80)].filter(Boolean);
  return {
    title: clamp(rec.title, 200) || (descParts.join(' ') || '현장 기록'),
    date: date,
    tag: siteTag(rec),
    url: String(rec.blog_url),
    description: descParts.length ? (descParts.join(' · ') + ' 현장 기록입니다.') : '',
    images: imagePaths,
  };
}

// Trees 원자 커밋(이미지들 + data/gallery.json) → gw-gallery/ 브랜치 → base staging PR
async function buildPr(cfg, ctx) {
  const { item, images, pid, by, R } = ctx;

  const refRes = await ghFetch('GET', `/git/ref/heads/${BASE_BRANCH}`, cfg);
  if (!refRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'get_ref', request_id: R });
  let baseCommitSha;
  try { baseCommitSha = (await refRes.json()).object.sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_ref', request_id: R }); }
  const baseCommitRes = await ghFetch('GET', `/git/commits/${baseCommitSha}`, cfg);
  if (!baseCommitRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'get_commit', request_id: R });
  let baseTreeSha;
  try { baseTreeSha = (await baseCommitRes.json()).tree.sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_commit', request_id: R }); }

  // 현재 staging의 gallery.json을 읽어 맨 앞에 항목 추가(전량 재작성 아님 — 기존 항목 보존)
  const curRes = await ghFetch('GET', `/contents/${GALLERY_JSON_PATH}?ref=${BASE_BRANCH}`, cfg);
  if (!curRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'get_gallery_json', request_id: R });
  let doc;
  try {
    const j = await curRes.json();
    doc = JSON.parse(Buffer.from(String(j.content || ''), 'base64').toString('utf8'));
  } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_gallery_json', request_id: R }); }
  const items = (doc && Array.isArray(doc.items)) ? doc.items : [];
  // 같은 블로그 주소가 이미 있으면 중복 게시하지 않는다(잠금 blob 유실 대비 이중 방어)
  if (items.some(function (it) { return it && it.url === item.url; })) {
    return jr(200, { ok: true, already: true, reason: 'URL_EXISTS', request_id: R });
  }
  const galleryJson = JSON.stringify({ items: [item].concat(items) }, null, 2) + '\n';

  const tree = [];
  for (const img of images) {
    const blobRes = await ghFetch('POST', `/git/blobs`, cfg, { content: img.bytesB64, encoding: 'base64' });
    if (!blobRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_blob', request_id: R });
    let sha; try { sha = (await blobRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_blob', request_id: R }); }
    tree.push({ path: img.repoPath, mode: '100644', type: 'blob', sha });
  }
  {
    const blobRes = await ghFetch('POST', `/git/blobs`, cfg, { content: Buffer.from(galleryJson, 'utf8').toString('base64'), encoding: 'base64' });
    if (!blobRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_json_blob', request_id: R });
    let sha; try { sha = (await blobRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_json_blob', request_id: R }); }
    tree.push({ path: GALLERY_JSON_PATH, mode: '100644', type: 'blob', sha });
  }

  const treeRes = await ghFetch('POST', `/git/trees`, cfg, { base_tree: baseTreeSha, tree });
  if (!treeRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_tree', request_id: R });
  let newTreeSha; try { newTreeSha = (await treeRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_tree', request_id: R }); }

  const commitRes = await ghFetch('POST', `/git/commits`, cfg, {
    message: `gw-gallery: ${item.title} (${item.tag}, 사진 ${images.length}장)`,
    tree: newTreeSha, parents: [baseCommitSha],
  });
  if (!commitRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_commit', request_id: R });
  let newCommitSha; try { newCommitSha = (await commitRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_commit2', request_id: R }); }

  const branch = `${BRANCH_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const mkRef = await ghFetch('POST', `/git/refs`, cfg, { ref: `refs/heads/${branch}`, sha: newCommitSha });
  if (!mkRef.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_branch', request_id: R });

  const body = [
    EVIDENCE_MARKER,
    '## 앱 → 홈페이지 갤러리 자동 게시 (혁신⑥)',
    '',
    '블로그 게시 완료로 확인된 홍보 기록 1건을 시공 갤러리 카드로 추가합니다.',
    '',
    '### 보이는 변화 (gallery.html 시공 갤러리)',
    `- 새 카드 1장: **${item.title}**`,
    `- 분류 태그: ${item.tag} · 날짜: ${item.date}`,
    `- 대표 사진 ${images.length}장 (첫 장이 썸네일, 나머지는 카드 하단 미니 스트립)`,
    images.length ? images.map(function (i) { return `  - \`${i.publicPath}\``; }).join('\n') : '',
    `- 카드에서 블로그 글로 연결: ${item.url}`,
    '',
    `- promo_id: \`${pid}\` · 표시 처리: ${by}`,
    `- submitted_at: ${new Date().toISOString()}`,
    '',
    'PM 검토·머지 필요. 자동 머지 없음.',
  ].filter(Boolean).join('\n');
  const prRes = await ghFetch('POST', `/pulls`, cfg, {
    title: `갤러리 동시 게시: ${item.title}`, head: branch, base: BASE_BRANCH, body,
  });
  if (!prRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_pr', request_id: R });
  let pr; try { pr = await prRes.json(); } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_pr', request_id: R }); }
  return { pr };
}

async function handlePublish(event, d, R) {
  const c = await currentMember(event);
  if (!c.ok) return jr(401, { ok: false, code: c.reason || 'NO_SESSION', request_id: R });
  if (!(await deviceApproved(event, c.member))) return jr(403, { ok: false, code: 'DEVICE_NOT_APPROVED', request_id: R });
  if (!canPromo(c.member)) return jr(403, { ok: false, code: 'NO_PERMISSION', request_id: R });

  const cfg = ghConfig();
  if (!cfg.token) return jr(500, { ok: false, code: 'ENV_MISSING', request_id: R });   // GW_GALLERY_GITHUB_TOKEN 미설정

  const pid = String(d.promo_id || '').trim();
  if (!RE_REC_ID.test(pid)) return jr(400, { ok: false, code: 'BAD_PROMO_ID', request_id: R });

  const st = store(DATA);

  // 이미 보낸 건 — 기존 PR 안내(중복 카드·중복 PR 방지)
  const prev = await blobGet(st, prKey(pid));
  if (prev.ok && prev.data && prev.data.pr_number) {
    return jr(200, { ok: true, already: true, pr_number: prev.data.pr_number, pr_url: prev.data.pr_url || '', request_id: R });
  }

  // 서버 기록으로 검증 — 클라이언트 주장이 아니라 저장된 상태가 근거다
  const pr = await blobGet(st, 'col:promo');
  if (!pr.ok) return jr(500, { ok: false, code: pr.code, request_id: R });
  const rec = ((pr.data && pr.data.items) || []).filter(function (it) { return it && it.id === pid && it.del !== 1; })[0] || null;
  if (!rec) return jr(404, { ok: false, code: 'PROMO_NOT_FOUND', request_id: R });
  if (String(rec.status || '') !== 'posted') return jr(400, { ok: false, code: 'NOT_POSTED', request_id: R });   // 발행 시점: 블로그 발행 확인 후
  if (!RE_BLOG_URL.test(String(rec.blog_url || ''))) return jr(400, { ok: false, code: 'NO_BLOG_URL', request_id: R });

  const images = await pickImages(rec, pid);
  if (!images.length) return jr(400, { ok: false, code: 'NO_PHOTOS', request_id: R });

  const item = buildItem(rec, images.map(function (i) { return i.publicPath; }));
  const res = await buildPr(cfg, { item, images, pid, by: c.member.name, R });
  if (!res.pr) return res;   // 오류 응답 그대로(중복 URL의 already 포함)

  await blobSet(st, prKey(pid), { pr_number: res.pr.number, pr_url: res.pr.html_url, branch: res.pr.head && res.pr.head.ref, ts: Date.now(), by: c.member.name });
  try {
    await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo',
      ev: [{ op: '갤러리PR', id: pid, t: item.title + ' · ' + item.tag + ' · 사진 ' + images.length + '장 · PR #' + res.pr.number }] });
  } catch (e) {}
  return jr(201, { ok: true, pr_number: res.pr.number, pr_url: res.pr.html_url, images: images.length, tag: item.tag, request_id: R });
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: R });
  try {
    setupBlobContext(event);
    let d;
    try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { ok: false, code: 'INVALID_JSON', request_id: R }); }
    if (d && d.action === 'gallery_publish') return await handlePublish(event, d, R);
    return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
};
