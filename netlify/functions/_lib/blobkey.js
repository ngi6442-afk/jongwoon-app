'use strict';

// Blobs 키 이름 검사(v453 — 보안 재감사 후속 검토 high).
// @netlify/blobs 8.2.0은 키를 URL 경로에 날글자로 붙이고(`/${siteID}/${store}/${key}`) new URL로 다시 만든다 —
//   점 경로('x/../')·백슬래시·%2e%2e는 접혀 정리되고, 탭·개행은 지워지고, '?'·'#' 뒤는 경로에서 떨어지고, 끝 공백은 잘린다.
//   그래서 'x/../settings:autotask'·'../site:gw_users/member:<id>'·'\naudit:YYYY-MM'처럼 접두 검사를 비켜 가는 키가
//   실제로는 막힌 키(다른 스토어 포함)에 써지거나 읽힌다. SDK의 validateKey는 빈 키·'/' 시작·600바이트 초과만 막는다.
// 그래서 키 이름을 여기 한 곳에서 거른다 — blobs.js의 blobGet·blobSet·blobDelete가 SDK에 넘기기 전에 이것을 부르고,
//   gw-data backup_get·backup_put은 같은 검사로 400 BAD_KEY를 먼저 돌려준다. servertest mock도 같은 함수를 쓴다.
// 거르는 것: 문자열 아님·빈 키·600바이트 초과 · '/' '\' '%' '?' '#' · ASCII 제어문자(\x00-\x1f, \x7f) · 앞뒤 공백 · 키 전체가 '.' 또는 '..'.
//   (슬래시를 막으므로 점 조각은 키 전체일 때만 문제가 된다.) 실제 쓰는 키(member:·allbaro:xlsx:·docatt:·tpl:·proof: 등)에는 이 글자가 없다 —
//   v453 때 appdata 백업 스냅샷 키 1,378개(gw_data·gw_users·gw_files tpl/proof) 전수에서 0건.
function badBlobKey(key) {
  if (typeof key !== 'string' || !key) return true;
  if (Buffer.byteLength(key, 'utf8') > 600) return true;
  if (/[/\\%?#\x00-\x1f\x7f]/.test(key)) return true;
  if (key !== key.trim()) return true;
  if (key === '.' || key === '..') return true;
  return false;
}

module.exports = { badBlobKey };
