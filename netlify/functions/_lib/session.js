'use strict';

// 무상태 HMAC 세션 토큰 (그룹웨어). 웹사이트 member-auth 패턴 재사용.
// 서명키 GW_SESSION_SECRET는 env에만 존재, 절대 로그/반환 안 함. 토큰 payload엔 비밀 없음.
const crypto = require('crypto');

const DEFAULT_TTL = 43200; // 12h
const TTL_MIN = 300;
const TTL_MAX = 604800;    // 7d

function nowSec() { return Math.floor(Date.now() / 1000); }
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function sessionSecret() { return process.env.GW_SESSION_SECRET || null; }
function ttlSeconds() {
  const raw = parseInt(process.env.GW_SESSION_TTL || '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_TTL;
  return Math.max(TTL_MIN, Math.min(TTL_MAX, raw));
}
function signPayload(payloadB64, secret) {
  return b64urlEncode(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

// member: { id, role, admin }. payload에 비밀번호/해시 없음.
function issueSession(member, secret) {
  const sec = secret || sessionSecret();
  if (!sec) return { ok: false, code: 'SERVER_CONFIG_MISSING' };
  const iat = nowSec();
  const exp = iat + ttlSeconds();
  const payload = { mid: member.id, role: member.role || 'member', admin: !!member.admin, jti: crypto.randomBytes(12).toString('hex'), iat, exp };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const token = `${payloadB64}.${signPayload(payloadB64, sec)}`;
  return { ok: true, token, expires_at: exp };
}

function verifyToken(token, secret) {
  const sec = secret || sessionSecret();
  if (!sec) return { ok: false, reason: 'SERVER_CONFIG_MISSING' };
  if (typeof token !== 'string' || token.indexOf('.') < 0) return { ok: false, reason: 'INVALID_FORMAT' };
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return { ok: false, reason: 'INVALID_FORMAT' };
  const expected = signPayload(payloadB64, sec);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); } catch { return { ok: false, reason: 'INVALID_FORMAT' }; }
  if (!payload || !payload.mid || !payload.exp) return { ok: false, reason: 'INVALID_FORMAT' };
  if (nowSec() >= payload.exp) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, payload };
}

// Authorization: Bearer xxx 헤더에서 토큰 추출
function bearer(event) {
  const h = event && event.headers && (event.headers.authorization || event.headers.Authorization);
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

module.exports = { issueSession, verifyToken, bearer, sessionSecret, ttlSeconds };
