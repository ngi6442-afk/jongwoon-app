'use strict';

// C225 판 A 두 번째 검토(원장 C225): 발송·중복 방지 표식 — 표식 읽기가 실패한 회차에 알림을 보낸 뒤 표식을 쓰는 길.
//   _lib/blobs.js 층 1이 못 읽은 열쇠의 쓰기를 막으므로, 그대로 쓰면 표식이 남지 않아 다음 회차에 같은 알림이 또 나가고
//   깨진 표식(JSON 파싱 실패)은 영영 고쳐지지 않는다(운영 판은 첫 회차가 덮어 스스로 고쳐졌다).
//   그래서 처음 읽기가 실패한 회차만 이것으로 쓴다: 다시 읽어 성공(없음 포함)하면 그 값에 이번 표식을 합쳐 쓰고(다시 읽기가 층 1 표시를 푼다) ·
//   깨진 표식이면 지킬 자료가 아니므로 이번 표식만으로 force로 다시 세움 · 그래도 못 읽으면 쓰지 않고 { ok:false }(부르는 쪽이 회차 실패로).
//   build(cur) = 저장할 문서(cur = 다시 읽은 값, 없거나 깨졌으면 null). 처음 읽기가 성공한 회차는 종전대로 부르는 쪽이 바로 쓴다(정상 길 무변).
const { blobGet, blobSet } = require('./blobs');

async function markAfterSend(st, key, build) {
  const r = await blobGet(st, key);
  if (r.ok || r.code === 'NOT_FOUND') return blobSet(st, key, build(r.ok ? r.data : null));
  if (r.code === 'STORAGE_PARSE_FAILED') return blobSet(st, key, build(null), { force: true });
  return { ok: false, code: r.code || 'STORAGE_READ_FAILED' };
}

module.exports = { markAfterSend };
