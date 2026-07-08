'use strict';

// Netlify Blobs helpers (그룹웨어 백엔드). 웹사이트(jongwoon-website)의 검증된 패턴 복제:
// event.blobs에서 수동으로 env 컨텍스트 세팅, strong consistency, raw get + 수동 JSON.parse
// (없는 키는 throw 대신 null).
const { getStore, setEnvironmentContext } = require('@netlify/blobs');

function setupBlobContext(event) {
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

async function blobGet(st, key) {
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

async function blobSet(st, key, val) {
  try {
    await st.set(key, JSON.stringify(val));
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'STORAGE_WRITE_FAILED', error_name: e && e.constructor && e.constructor.name };
  }
}

async function blobDelete(st, key) {
  try {
    await st.delete(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'STORAGE_DELETE_FAILED', error_name: e && e.constructor && e.constructor.name };
  }
}

module.exports = { setupBlobContext, store, blobGet, blobSet, blobDelete };
