'use strict';
// 넣기 박스 큰 파일 조각(v423, 체크 31 — PM 11/5 "서류 등록 채널 하나"). 저장소는 그대로 gw_files.
// 넷리파이 동기 함수 본문 한도(약 6MB) 때문에 큰 파일은 조각으로 받는다.
// 본 레코드 att_<id> {name,type,kind:'box',parts:k,by,bid,ts,size} + 조각 attp:<id>:<j> {bid,data}. 작은 파일(k=1)은 종전 첨부와 같이 본 레코드 data에 통째로.
// 조각은 base64 문자열을 4의 배수 길이로 자른 것이라 그대로 이어 붙이면 원본 base64가 된다.
const { blobGet, blobDelete } = require('./blobs');

function attPartKey(id, j) { return 'attp:' + id + ':' + j; }

// 본 레코드 → 전체 base64. 조각이 하나라도 없으면 던진다(호출부가 PART_MISSING 처리).
async function attReadB64(st, id, rec) {
  if (!rec) throw new Error('NO_RECORD');
  if (rec.open) throw new Error('PART_MISSING');
  const k = Number(rec.parts) || 0;
  if (!k) return String(rec.data || '');
  const parts = await Promise.all(Array.from({ length: k }, function (_, j) {
    return blobGet(st, attPartKey(id, j)).then(function (r) {
      if (!r.ok || !r.data || typeof r.data.data !== 'string') throw new Error('PART_MISSING');
      return r.data.data;
    });
  }));
  return parts.join('');
}

async function attDeleteParts(st, id, rec) {
  const k = Number(rec && rec.parts) || 0;
  for (let j = 0; j < k; j++) { try { await blobDelete(st, attPartKey(id, j)); } catch (e) {} }
}

module.exports = { attPartKey, attReadB64, attDeleteParts };
