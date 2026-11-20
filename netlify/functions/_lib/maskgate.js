'use strict';
// C259 공개 사진 판정 — 홍보 사진이 앱 밖(공유 주소·홈페이지 갤러리 피드·갤러리 릴레이)으로 나갈 때 세 길이 같이 쓰는 함수 하나.
//
// 규칙(원본은 '가린 판이 확인된 경우'에만 나간다 — 임의로 완화하지 말 것):
//   · mask:<id>에 data가 있음                       → 가린 판을 낸다
//   · mask:<id>의 data가 빈 값 + maskmeta:<id>가 '상자 0개로 끝남'(has:true·n 0)을 말함 → 감지기·사람이 '가릴 것 없음'으로 확인한 것 → 원본을 낸다
//   · 그 밖(mask 없음 = 작업 기록 없음·실패·시간 초과 / maskmeta 없음 / 둘이 어긋남) → 거절
//   · 읽기 실패는 '없음'으로 보지 않는다 — 원본으로 넘어가지 않고 거절(일시 오류 코드)
//   · 낼 레코드는 kind 'promo'만(다른 종류 첨부는 이 통로로 나가지 않는다)
// 반환: { ok:true, rec, masked } 또는 { ok:false, status, code }
//   status: 503 읽기 실패(다시 시도하면 될 수 있음) · 409 가린 판 없음(공개 불가 상태) · 403 홍보 사진 아님 · 404 원본 없음
const { store, blobGet } = require('./blobs');

const FILES = 'gw_files';

function deny(status, code) { return { ok: false, status: status, code: code }; }
// 키 없음 — 실 blobs.js는 {ok:true, data:null}, 일부 경로·시험 mock은 {ok:false, code:'NOT_FOUND'}(gw-auth·gw-data와 같은 처리). 그 밖의 !ok는 읽기 실패다.
function absent(r) { return (r.ok && !r.data) || (!r.ok && r.code === 'NOT_FOUND'); }

async function pickPublic(attId, fst) {
  const id = String(attId || '');
  const st = fst || store(FILES);
  const m = await blobGet(st, 'mask:' + id);
  if (absent(m)) return deny(409, 'NOT_MASKED');
  if (!m.ok) return deny(503, 'MASK_READ_FAILED');
  if (String(m.data.kind || '') !== 'promo') return deny(403, 'NOT_PROMO');
  if (String(m.data.data || '')) return { ok: true, rec: m.data, masked: true };
  // 빈 판 — 상태 문서가 '상자 0개로 끝남'이라고 말할 때만 원본
  const mm = await blobGet(st, 'maskmeta:' + id);
  if (absent(mm)) return deny(409, 'NOT_MASKED');
  if (!mm.ok) return deny(503, 'META_READ_FAILED');
  const meta = mm.data;
  if (meta.has !== true) return deny(409, 'NOT_MASKED');
  if (Number(meta.n) !== 0) return deny(409, 'MASK_META_MISMATCH');
  if (Array.isArray(m.data.boxes) && m.data.boxes.length) return deny(409, 'MASK_META_MISMATCH');
  const o = await blobGet(st, id);
  if (absent(o)) return deny(404, 'NO_FILE');
  if (!o.ok) return deny(503, 'FILE_READ_FAILED');
  if (!String(o.data.data || '')) return deny(404, 'NO_FILE');
  if (String(o.data.kind || '') !== 'promo') return deny(403, 'NOT_PROMO');
  return { ok: true, rec: o.data, masked: false };
}

module.exports = { pickPublic, absent };
