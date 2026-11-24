'use strict';
// C240 판 A-1 — 요청 본문의 '가르는 칸'은 글자만(원천: 들머리에서 꼴 검사).
//   까닭: 표 열쇠 검사(hasOwnProperty.call(COL, x) · 표[x] · `키:${x}`)는 배열 ["leaves"]·숫자를 글자로 바꿔 통과시키고,
//   그 뒤 갈래·권한 비교(x === 'bids' 등)는 엄격 비교라 모두 거짓 — 관리자 전용 읽기·칸 빼기·이월 가드를 통째로 건너뛰었다(11/20 검토 ㉠, 운영에서 재현).
//   그래서 함수마다 '글자로 믿고 가르는 칸'(전수 표 — 09_조사_문서/서버권한_자료_20261120/막는판A1_문서초안_1120.md)을 들머리에서 본다:
//   칸이 있는데(undefined·null이 아닌데) 글자가 아니면 그 칸 이름을 돌려준다 → 부르는 쪽이 400(저장소를 읽기 전 — 아무것도 안 바뀜).
//   본문 자체가 객체가 아니면(배열·글자·null) 건드리지 않는다(종전 갈래가 그대로 400·무시).
function badField(d, fields) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  for (let i = 0; i < fields.length; i++) {
    const v = d[fields[i]];
    if (v !== undefined && v !== null && typeof v !== 'string') return fields[i];
  }
  return null;
}
module.exports = { badField };
