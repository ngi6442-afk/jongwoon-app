'use strict';

// 혁신⑦ 포항 시공 지도 — 게시 완료(posted)된 홍보 기록의 GPS 자동 축적분을
// 홈페이지 시공 지도 데이터(data/map.json)로 내보낸다.
//
// promo 실측(2026-08-24 라이브 col:promo): gps는 사진 EXIF에서만 생기는 {lat,lon} 숫자 객체
// (클라이언트 promoJpegGps → promoUpload.gps, 수동 입력 경로 없음), region은 promo_geo(Nominatim)
// 자동 기입 문자열("포항 용흥동" 꼴, regionSrc:"gps"). 따라서 "GPS 자동 축적분" = gps 필드가 있는 기록.
//
// 확정사양 ⑦: 주소 노출은 동·읍 단위까지만 — 좌표(lat/lon)·번지·건물명·발주처는 이 파일 밖으로
// 절대 내보내지 않는다. 내보내는 값은 region에서 뽑은 동·읍 토큰 하나 + 공종 + 연월 + 시설 요약 +
// (있으면) 블로그 글 주소뿐이다. 지도 위 좌표 배치는 홈페이지 쪽 동·읍 중심점 표(js/map.js)가 맡는다.
//
// 내보내기 방식은 ⑥(gw-gallery-relay)과 같은 패턴: 전량 재빌드한 data/map.json 한 파일을
// Git Trees 원자 커밋 → gw-map/ 브랜치 → base staging PR(자동 머지 없음, 머지는 PM).
// 홈페이지 main은 절대 건드리지 않는다.
//
// 중복 방지: 재빌드 결과가 staging의 현재 map.json과 같으면 PR을 만들지 않는다.
// (전량 재빌드라 몇 번을 불러도 결과가 수렴한다 — 이전 지도 PR이 열려 있는 채로 새 PR이 생기면
//  새 PR이 최신 전체본이므로 PM은 최신 것만 머지하면 된다. PR 본문에 명시.)
const crypto = require('crypto');
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const { appendAudit } = require('./_lib/audit');

const DATA = 'gw_data';
const USERS = 'gw_users';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-device-label', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function rid() { return crypto.randomBytes(8).toString('hex'); }
function jr(statusCode, body) { return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) }; }

const RE_BLOG_URL = /^https?:\/\/[^\s"'<>]+$/;
const MAP_JSON_PATH = 'data/map.json';                  // website 레포 경로(⑥ data/gallery.json과 같은 정적 JSON 패턴)
const BRANCH_PREFIX = 'gw-map/';
const EVIDENCE_MARKER = '<!-- gw-map-evidence -->';
const BASE_BRANCH = 'staging';                          // 홈페이지 변경은 staging→PR→PM 머지만(main 금지)
const MAX_ITEMS = 500;                                  // 방어적 상한
const PR_KEY = 'map:pr:last';                           // 마지막 지도 PR 기록(내용 해시로 중복 PR 방지)

// 공종 분류 — 시공지도 시안의 4종(준설/폐기물/철거/석면). ⑥ siteTag와 같은 방식으로
// 기록의 시설·문제·제목 텍스트에서 판정하되, 지도 범례에 맞춰 4종으로 접는다. 순서 중요(석면·철거 먼저).
const CAT_RULES = [
  ['석면', /석면|슬레이트/],
  ['철거', /철거|해체/],
  ['폐기물', /폐기물|재활용|수집운반|수집·운반/],
];
function mapCat(rec) {
  const txt = String((rec && rec.facility) || '') + ' ' + String((rec && rec.problem) || '') + ' ' + String((rec && rec.title) || '');
  for (const r of CAT_RULES) { if (r[1].test(txt)) return r[0]; }
  return '준설';
}

// region 문자열에서 동·읍·면 토큰 하나만 추출(뒤에서부터). 매칭된 토큰만 내보내므로
// 수동 입력에 번지·건물명이 섞여 있어도 지도 데이터로는 새어 나가지 않는다.
// "동빈1가" 같은 숫자+가 법정동도 받는다. 못 찾으면 null(그 기록은 지도에서 제외).
function dongOf(region) {
  const toks = String(region || '').trim().split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (/^[가-힣]{1,11}[동읍면]$/.test(t) || /^[가-힣]{1,9}[0-9]{1,2}가$/.test(t)) return t;
  }
  return null;
}

function kstNow() { return new Date(Date.now() + 9 * 3600000); }
function ymOf(rec) {
  const shot = String((rec && rec.shot_at) || '');
  if (/^\d{4}-\d{2}/.test(shot)) return shot.slice(0, 7);
  const upd = String((rec && rec.updated) || '');
  if (/^\d{4}-\d{2}/.test(upd)) return upd.slice(0, 7);
  return kstNow().toISOString().slice(0, 7);
}
function clamp(v, n) { const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }

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
function canPromo(m) {
  if (!m) return false;
  if (m.admin) return true;
  return ((m.perms || {}).promo) === 'do';
}

// ── GitHub API(website 레포 대상) — gw-gallery-relay와 동일 골격·동일 토큰 ──
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
    'User-Agent': 'gw-map-relay',
    'Content-Type': 'application/json',
  };
}
async function ghFetch(method, path, cfg, body) {
  return fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method, headers: ghHeaders(cfg.token), body: body ? JSON.stringify(body) : undefined,
  });
}

// 게시 완료 + GPS 자동 축적 기록 → 지도 항목 목록(전량 재빌드).
// 항목: { dong, cat, ym, what, url? } — 좌표·번지·발주처·기록 id는 싣지 않는다.
function buildItems(items) {
  const out = [];
  for (const it of items) {
    if (!it || it.del === 1) continue;
    if (String(it.status || '') !== 'posted') continue;                      // 검수·게시 완료를 거친 기록만 공개
    const g = it.gps;
    if (!g || !isFinite(Number(g.lat)) || !isFinite(Number(g.lon))) continue; // GPS 자동 축적분만(확정사양 ⑦)
    const dong = dongOf(it.region);
    if (!dong) continue;                                                     // 동·읍 단위로 못 접는 기록은 내보내지 않는다
    const item = { dong: dong, cat: mapCat(it), ym: ymOf(it), what: clamp(it.facility || it.problem, 60) };
    const u = String(it.blog_url || '');
    if (RE_BLOG_URL.test(u)) item.url = u;                                   // 블로그 글 연결(있을 때만)
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  out.sort(function (a, b) { return a.ym < b.ym ? 1 : (a.ym > b.ym ? -1 : 0); });
  return out;
}

function docHash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// data/map.json 한 파일을 Trees 원자 커밋 → gw-map/ 브랜치 → base staging PR
async function buildPr(cfg, ctx) {
  const { mapJson, items, by, R } = ctx;

  const refRes = await ghFetch('GET', `/git/ref/heads/${BASE_BRANCH}`, cfg);
  if (!refRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'get_ref', request_id: R });
  let baseCommitSha;
  try { baseCommitSha = (await refRes.json()).object.sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_ref', request_id: R }); }
  const baseCommitRes = await ghFetch('GET', `/git/commits/${baseCommitSha}`, cfg);
  if (!baseCommitRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'get_commit', request_id: R });
  let baseTreeSha;
  try { baseTreeSha = (await baseCommitRes.json()).tree.sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_commit', request_id: R }); }

  const blobRes = await ghFetch('POST', `/git/blobs`, cfg, { content: Buffer.from(mapJson, 'utf8').toString('base64'), encoding: 'base64' });
  if (!blobRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_json_blob', request_id: R });
  let jsonSha; try { jsonSha = (await blobRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_json_blob', request_id: R }); }

  const treeRes = await ghFetch('POST', `/git/trees`, cfg, { base_tree: baseTreeSha, tree: [{ path: MAP_JSON_PATH, mode: '100644', type: 'blob', sha: jsonSha }] });
  if (!treeRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_tree', request_id: R });
  let newTreeSha; try { newTreeSha = (await treeRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_tree', request_id: R }); }

  // 동별 요약(PR 본문·커밋 메시지용) — 여기서도 동·읍 단위 집계만 쓴다
  const byDong = {};
  for (const it of items) { byDong[it.dong] = (byDong[it.dong] || 0) + 1; }
  const dongs = Object.keys(byDong);
  const summary = dongs.map(function (d) { return `${d} ${byDong[d]}건`; }).join(' · ');

  const commitRes = await ghFetch('POST', `/git/commits`, cfg, {
    message: `gw-map: 시공 지도 데이터 갱신 (기록 ${items.length}건, 동·읍 ${dongs.length}곳)`,
    tree: newTreeSha, parents: [baseCommitSha],
  });
  if (!commitRes.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_commit', request_id: R });
  let newCommitSha; try { newCommitSha = (await commitRes.json()).sha; } catch { return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'parse_commit2', request_id: R }); }

  const branch = `${BRANCH_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const mkRef = await ghFetch('POST', `/git/refs`, cfg, { ref: `refs/heads/${branch}`, sha: newCommitSha });
  if (!mkRef.ok) return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'create_branch', request_id: R });

  const body = [
    EVIDENCE_MARKER,
    '## 앱 → 홈페이지 시공 지도 데이터 자동 갱신 (혁신⑦)',
    '',
    '게시 완료된 홍보 기록의 GPS 자동 축적분을 동·읍 단위로 접어 data/map.json을 전량 재빌드했습니다.',
    '',
    `- 기록 ${items.length}건 · 동·읍 ${dongs.length}곳: ${summary}`,
    '- 노출 범위: 동·읍 이름 + 공종 + 연월 + 시설 요약 + 블로그 링크(있는 것만). 좌표·번지·발주처 없음.',
    `- 표시 처리: ${by}`,
    `- submitted_at: ${new Date().toISOString()}`,
    '',
    '전량 재빌드라 이 PR이 항상 최신 전체본입니다. 이전 gw-map PR이 열려 있으면 이것만 머지하고 이전 것은 닫으면 됩니다.',
    'PM 검토·머지 필요. 자동 머지 없음.',
  ].join('\n');
  const prRes = await ghFetch('POST', `/pulls`, cfg, {
    title: `시공 지도 갱신: 기록 ${items.length}건 · 동·읍 ${dongs.length}곳`, head: branch, base: BASE_BRANCH, body,
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

  const st = store(DATA);
  const pr = await blobGet(st, 'col:promo');
  if (!pr.ok) return jr(500, { ok: false, code: pr.code, request_id: R });
  const items = buildItems((pr.data && pr.data.items) || []);
  if (!items.length) return jr(200, { ok: true, empty: true, request_id: R });         // 내보낼 기록 없음 — PR 없이 종료

  const mapJson = JSON.stringify({ items: items }, null, 2) + '\n';
  const hash = docHash(mapJson);

  // 같은 내용으로 이미 PR을 만들었으면 다시 만들지 않는다
  const prev = await blobGet(st, PR_KEY);
  if (prev.ok && prev.data && prev.data.hash === hash && prev.data.pr_number) {
    return jr(200, { ok: true, already: true, pr_number: prev.data.pr_number, pr_url: prev.data.pr_url || '', request_id: R });
  }

  // staging의 현재 map.json과 같으면 갱신할 것이 없다(파일이 아직 없으면 새로 만든다)
  const curRes = await ghFetch('GET', `/contents/${MAP_JSON_PATH}?ref=${BASE_BRANCH}`, cfg);
  if (curRes.ok) {
    try {
      const j = await curRes.json();
      const cur = JSON.parse(Buffer.from(String(j.content || ''), 'base64').toString('utf8'));
      if (JSON.stringify(cur) === JSON.stringify({ items: items })) {
        return jr(200, { ok: true, already: true, unchanged: true, request_id: R });
      }
    } catch (e) { /* 현재 파일이 깨져 있으면 재빌드본으로 교체 PR */ }
  } else if (curRes.status !== 404) {
    return jr(502, { ok: false, code: 'UPSTREAM_FAILED', stage: 'get_map_json', request_id: R });
  }

  const res = await buildPr(cfg, { mapJson, items, by: c.member.name, R });
  if (!res.pr) return res;

  await blobSet(st, PR_KEY, { pr_number: res.pr.number, pr_url: res.pr.html_url, branch: res.pr.head && res.pr.head.ref, hash: hash, ts: Date.now(), by: c.member.name });
  try {
    await appendAudit({ ts: Date.now(), by: c.member.name, bid: c.member.id, col: 'promo',
      ev: [{ op: '지도PR', id: 'map', t: '기록 ' + items.length + '건 · PR #' + res.pr.number }] });
  } catch (e) {}
  return jr(201, { ok: true, pr_number: res.pr.number, pr_url: res.pr.html_url, count: items.length, request_id: R });
}

exports.handler = async function (event) {
  const R = rid();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return jr(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: R });
  try {
    setupBlobContext(event);
    let d;
    try { d = JSON.parse(event.body || '{}'); } catch { return jr(400, { ok: false, code: 'INVALID_JSON', request_id: R }); }
    if (d && d.action === 'map_publish') return await handlePublish(event, d, R);
    return jr(400, { ok: false, code: 'UNKNOWN_ACTION', request_id: R });
  } catch (e) {
    return jr(500, { ok: false, code: 'HANDLER_FAILED', request_id: R });
  }
};
