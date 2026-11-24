'use strict';
// C265 그림 형식 확인 — 홍보 사진 올리기(gw-data att_put kind promo)와 공개 주소(gw-promo-img·gw-gallery-feed img)가 같이 쓴다.
//   보낸 type·저장된 type을 믿지 않는다: base64 내용의 머리 바이트로 JPEG·PNG·WebP만 그림으로 본다.
//   공개 응답의 Content-Type은 이 허용 목록 안에서만 나간다(그 밖은 거절) — 앱 주소에서 문서·스크립트 형식으로 열리는 길을 막는다.
const ALLOWED = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };

// 버퍼 머리 → 'image/jpeg' | 'image/png' | 'image/webp' | ''
function sniffBuf(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return '';
}
// base64 글자열 머리만 풀어 본다(전체를 풀지 않음) — 앞 공백·줄바꿈은 걷는다
function sniffB64(b64) {
  const s = String(b64 || '').replace(/^[\s]+/, '').slice(0, 64).replace(/[\r\n\s]/g, '');
  if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) return '';
  try { return sniffBuf(Buffer.from(s, 'base64')); } catch (e) { return ''; }
}
// 공개 응답용 — 저장된 type이 허용 목록 안이고 머리 바이트도 그림일 때만 그 머리 바이트 형식을 돌려준다. 아니면 ''(거절)
function publicImageType(rec) {
  const t = String((rec && rec.type) || '').trim().toLowerCase();
  if (!ALLOWED[t]) return '';
  return sniffB64(rec && rec.data);
}

module.exports = { ALLOWED, sniffBuf, sniffB64, publicImageType };
