'use strict';

// Netlify Blobs helpers (그룹웨어 백엔드). 웹사이트(jongwoon-website)의 검증된 패턴 복제:
// event.blobs에서 수동으로 env 컨텍스트 세팅, strong consistency, raw get + 수동 JSON.parse
// (없는 키는 throw 대신 null).
const { getStore, setEnvironmentContext } = require('@netlify/blobs');
// v453 키 이름 검사 — SDK가 키를 URL 경로에 날글자로 붙여 'x/../settings:autotask'가 settings:autotask로 접히던 길을 막는다(_lib/blobkey.js 머리말).
const { badBlobKey } = require('./blobkey');

// C225 판 A(층 1 — 원장 C225): 읽기 실패한 열쇠는 그 실행 안에서 쓰지·지우지 못한다.
//   blobGet이 STORAGE_READ_FAILED·STORAGE_PARSE_FAILED를 돌려준 (저장소 이름, 열쇠)를 적어 두고, blobSet·blobDelete가 그 열쇠면 쓰지 않고
//   { ok:false, code:'STORAGE_WRITE_BLOCKED' } — 부르는 쪽이 `r.ok ? r.data : {}`로 실패를 빈 문서로 뭉갠 뒤 통째로 덮어 기존 자료가 사라지던 길(전수 표 113줄)을 한 곳에서 막는다.
//   같은 열쇠를 다시 읽어 성공하면(없음 포함) 풀린다. 일부러 통째로 덮는 길(백업 복원·버전 되돌리기에서 깨진 지금 값 교체)만 opts { force:true }로 지나간다.
//   표시는 모듈 안 한 벌이고 실행(요청·크론 한 번)마다 setupBlobContext가 비운다 — 모든 함수 진입점이 실행 첫머리에 부른다(gw-cron-kick은 크론 handler에 넘기고,
//   gw-hwakwan-cron은 저장소를 쓰지 않음). 넷리파이 함수 인스턴스는 한 번에 한 실행만 돌리므로 따뜻한 인스턴스의 앞 실행 표시가 뒤 실행을 막지 않는다.
//   저장소 구별은 Store 객체의 name(실 SDK = 'site:<이름>' — store()를 몇 번 불러도 같은 이름)이고, 이름이 없는 객체(시험용)는 객체 하나를 한 저장소로 본다.
//   한계(두 번째 검토): 표시는 '읽는 이'가 아니라 '열쇠' 단위 — 한 요청에서 같은 열쇠를 두 번 읽어(또는 Promise.all로 동시에) 나중 읽기가 성공하면
//   앞 읽기 실패를 빈 문서로 뭉갠 쓰기도 지나간다. 그런 처리기는 자기 읽기 결과(r.ok)를 직접 보아야 한다(층 2).
const readFails = new Map();   // 저장소 이름 → Set(열쇠)
const anonStores = new WeakMap();
let anonSeq = 0;
function storeTag(st) {
  if (st && typeof st.name === 'string' && st.name) return 'n:' + st.name;
  if (st && (typeof st === 'object' || typeof st === 'function')) { let t = anonStores.get(st); if (!t) { t = 'a:' + (++anonSeq); anonStores.set(st, t); } return t; }
  return 's:' + String(st);
}
function markReadFail(st, key) { const t = storeTag(st); let s = readFails.get(t); if (!s) { s = new Set(); readFails.set(t, s); } s.add(key); }
function clearReadFail(st, key) { const s = readFails.get(storeTag(st)); if (s) s.delete(key); }
function readFailed(st, key) { const s = readFails.get(storeTag(st)); return !!(s && s.has(key)); }
const READ_RETRY_MS = 200;   // 읽기 한 번 다시 시도 전 쉬는 시간(예외·시간 초과·5xx만 — 깨진 JSON은 다시 읽지 않음). 함수 시간 한도 안에서 짧게

function setupBlobContext(event) {
  readFails.clear();   // C225: 실행마다 비움 — event에 blobs가 없어 아래에서 false로 돌아가는 실행도 먼저 비운다
  try {
    if (!event || !event.blobs) return false;
    const raw = Buffer.from(event.blobs, 'base64').toString('utf8');
    const data = JSON.parse(raw);
    setEnvironmentContext({
      siteID: data.siteID || (event.headers && event.headers['x-nf-site-id']),
      token: data.token,
      primaryRegion: data.primary_region,
    });
    return true;
  } catch {
    return false;
  }
}

function store(name) {
  try {
    return getStore({ name, consistency: 'strong' });
  } catch {
    return getStore(name);
  }
}

async function blobGetOnce(st, key) {
  try {
    const raw = await st.get(key);
    if (raw === null || raw === undefined) return { ok: true, data: null };
    try {
      return { ok: true, data: JSON.parse(raw) };
    } catch {
      return { ok: false, code: 'STORAGE_PARSE_FAILED' };
    }
  } catch (e) {
    return { ok: false, code: 'STORAGE_READ_FAILED', error_name: e && e.constructor && e.constructor.name };
  }
}

async function blobGet(st, key) {
  if (badBlobKey(key)) return { ok: false, code: 'STORAGE_BAD_KEY' };   // v453
  let r = await blobGetOnce(st, key);
  if (!r.ok && r.code === 'STORAGE_READ_FAILED') {   // C225: 일시 실패면 짧게 쉬고 한 번만 다시
    await new Promise(function (res) { setTimeout(res, READ_RETRY_MS); });
    r = await blobGetOnce(st, key);
  }
  if (r.ok) clearReadFail(st, key); else markReadFail(st, key);   // C225 층 1 표시(다시 읽어 성공하면 풀림)
  return r;
}

async function blobSet(st, key, val, opts) {
  if (badBlobKey(key)) return { ok: false, code: 'STORAGE_BAD_KEY' };   // v453
  if (!(opts && opts.force === true) && readFailed(st, key)) return { ok: false, code: 'STORAGE_WRITE_BLOCKED' };   // C225 층 1
  try {
    await st.set(key, JSON.stringify(val));
    if (opts && opts.force === true) clearReadFail(st, key);   // C225 두 번째 검토: force로 다시 세웠으면 표시도 지움(같은 실행의 다음 보통 쓰기가 막히지 않게)
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'STORAGE_WRITE_FAILED', error_name: e && e.constructor && e.constructor.name };
  }
}

async function blobDelete(st, key, opts) {
  if (badBlobKey(key)) return { ok: false, code: 'STORAGE_BAD_KEY' };   // v453
  if (!(opts && opts.force === true) && readFailed(st, key)) return { ok: false, code: 'STORAGE_WRITE_BLOCKED' };   // C225 층 1 · force = 깨진 계약 기록물 본문 영구 삭제(gw-data handleCdocPurge)만
  try {
    await st.delete(key);
    if (opts && opts.force === true) clearReadFail(st, key);   // C225: force로 지웠으면 표시도 지움
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'STORAGE_DELETE_FAILED', error_name: e && e.constructor && e.constructor.name };
  }
}

async function blobList(st, prefix) {
  try {
    const res = await st.list(prefix ? { prefix: String(prefix) } : undefined);   // prefix(선택) — 전체 열거 비용 회피(v310)
    return { ok: true, keys: (res && res.blobs ? res.blobs.map(function (b) { return b.key; }) : []) };
  } catch (e) {
    return { ok: false, code: 'STORAGE_LIST_FAILED', error_name: e && e.constructor && e.constructor.name };
  }
}

module.exports = { setupBlobContext, store, blobGet, blobSet, blobDelete, blobList, badBlobKey };
