'use strict';
// v456(원장 C108 — 보안 재감사 v453 남은 걱정): 공유 비밀키 상수시간 비교 공용 — gw-cron-kick·gw-lawwatch가 쓴다(종전 '!==' 비교).
//   규칙은 gw-data keyMatch·botKeyOk와 같다(받은 값은 앞뒤 공백을 떼고 · 길이가 다르면 바로 거부 · 같으면 crypto.timingSafeEqual · 비밀키가 비면 늘 거부 — 기본 개방 금지).
//   gw-data는 자기 keyMatch·botKeyOk를 그대로 둔다(servertest 85 ⑦이 그 파일 안 한 곳을 지킴) — 두 벌 같은 규칙은 servertest 86이 같은 표본으로 대조한다.
const crypto = require('crypto');

function keyMatch(given, secret) {
  const a = Buffer.from(String(given == null ? '' : given).trim(), 'utf8'), b = Buffer.from(String(secret || ''), 'utf8');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
// 수집봇 공유 시크릿(BIDS_INGEST_KEY) — env는 부를 때마다 읽는다(시험이 env를 바꿔 돌림)
function botKeyOk(given) { return keyMatch(given, (process.env.BIDS_INGEST_KEY || '').trim()); }

module.exports = { keyMatch, botKeyOk };
