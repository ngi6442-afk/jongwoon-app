// 봉함 상자(급여 백업 암호화 — 저장소를 모르는 순수 함수라 _lib/pay* 이름 규칙 밖에 둠) · 66 급여 백업 암호화(PM 11/24 'ㄱ' — 설계 브리핑 6절 A안) — 매일 백업(봇 키 backup_get)이 급여 문서(gw_data 'pay:*')를 가져갈 때 서버가 이 함수로 봉해서 내보내고,
//   재해 복원(backup_put)이 봉한 꼴을 받으면 같은 열쇠로 연다. 열쇠 = 넷리파이 환경 변수 PAY_BACKUP_KEY(32바이트를 base64로 · PM이 넣고 따로 보관 — 잃으면 백업에서 급여를 못 살림).
//   AES-256-GCM(무작위 iv 12바이트 · 위조 검출 tag) · kid = 열쇠 지문 앞 8자(어느 열쇠로 봉했는지만 — 열쇠는 안 실음). 순수 함수(저장소를 모름 · 열쇠는 부르는 쪽이 넘김).
'use strict';
const crypto = require('crypto');
const ENC = 'pay-aesgcm-v1';
// 환경 값 → 32바이트 열쇠(Buffer) 또는 null(없음·꼴 틀림 — 부르는 쪽이 반출을 막음)
function keyFrom(v) {
  const s = String(v || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length === 32 ? b : null;
}
function kidOf(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8); }
function seal(data, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(data), 'utf8')), c.final()]);
  return { enc: ENC, kid: kidOf(key), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function isSealed(x) { return !!x && typeof x === 'object' && !Array.isArray(x) && x.enc === ENC; }
// { ok:true, data } 또는 { ok:false, code } — KID_MISMATCH(다른 열쇠로 봉함) · BAD_SEAL(꼴 틀림·위조·깨짐)
function open(x, key) {
  if (!isSealed(x) || typeof x.iv !== 'string' || typeof x.tag !== 'string' || typeof x.ct !== 'string') return { ok: false, code: 'BAD_SEAL' };
  if (x.kid !== kidOf(key)) return { ok: false, code: 'KID_MISMATCH' };
  try {
    const iv = Buffer.from(x.iv, 'base64'), tag = Buffer.from(x.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) return { ok: false, code: 'BAD_SEAL' };
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(Buffer.from(x.ct, 'base64')), d.final()]);
    return { ok: true, data: JSON.parse(pt.toString('utf8')) };
  } catch (e) { return { ok: false, code: 'BAD_SEAL' }; }
}
module.exports = { ENC: ENC, keyFrom: keyFrom, kidOf: kidOf, seal: seal, open: open, isSealed: isSealed };
