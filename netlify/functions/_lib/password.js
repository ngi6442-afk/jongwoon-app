'use strict';

// PIN/비밀번호 해시 (그룹웨어). 웹사이트와 동일한 scrypt(keylen 64, per-user salt hex).
// Node 내장 crypto만 사용 — 추가 의존성 없음.
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

function verifySecret(secret, salt, expectedHash) {
  try {
    if (typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
    const derived = crypto.scryptSync(String(secret), salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(expectedHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

module.exports = { hashSecret, verifySecret, SCRYPT_KEYLEN };
