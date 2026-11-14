'use strict';
// 체크 29 판④ 부품 A — 국세청 보안메일(전자세금계산서 HTML) 풀기 + KISA SEED-128 직접 구현.
// 규격: side-session-notes …/29_판4_읽기부품_규격_20261114.md '부품 A'. 순수 함수(Buffer → 객체), 저장소·네트워크 없음.
// 보안 HTML 꼴(실물 구조만 확인, 값은 보지 않음):
//   hidden input idCriHeader = base64 → 바이트마다 XOR 0x6b → 줄마다 '키:값'
//     ContentEncryptionAlgorithm(1 AES-128-CBC · 2 SEED-128-CBC · 3 ARIA — 3은 ALG_UNSUPPORTED) · HintKey(쓰지 않음) · HashKey
//     AttachFileCount · AttachFileName · AttachFileTagID · AttachFileSize
//   idCriPcContents = 본문(암호 base64) · idCriAttachContents<i> = 첨부(복호 결과가 다시 base64 글 → 파일 바이트)
//   키 = MD5(사업자번호 숫자 10자리 글) 16바이트, iv = 0 16바이트, PKCS7.
//   맞는 번호 판정 = HashKey 복호 결과 글 == 키의 hex(대소문자 무시).
// 사업자번호 값은 돌려주지 않는다(맞은 후보의 순번 bnIdx만) — 로그에도 찍지 않는다.
const crypto = require('crypto');

// ── SEED-128 (RFC 4269 / KISA) ─────────────────────────────────────────
// S-박스 S1·S2 = RFC 4269 표(대수 정의 S1(x)=A1·x^247⊕169, S2(x)=A2·x^251⊕56, GF(2^8) 다항식 0x163에서 다시 세어 맞춘 값).
const S1 = Buffer.from(
  'a985d6d3541dac255d43181e51fcca632844209de0e2c817a58f037bbb13d2ee708c3fa832ddf674ec950b575c5bbd01241c739810ccf2d92ce772839bd186c9' +
  '6050a3eb0db69e4fb75ac678a612afd561c3b441527d8d081f9900190453f7e1fd762f27b08b0eaba26e934d697c090abfeff3c58714fe64de2e4b1a06216b66' +
  '02f5928a0cb37ed07a4796e52680addfa13037ae36152238f4a7454c81e9849735cbce3c7111c78975fbdaf8945982c4ff493967c0cfd7b80f8e4223916cdba4' +
  '34f148c26f3d2d40be3ebcc1aaba4e553bdc687f9cd84a5677a0ed46b52b65fae3b9b19f5ef9e6b231ea6d5fe4f0cd88163a58d462290733e81b0579906a2a9a', 'hex');
const S2 = Buffer.from(
  '38e82da6cfdeb3b8af6055c7446f6b5bc36233b529a0e2a7d39111061cbc364bef886ca817c416f4c245e1d63f3d8e98284ef63ea5f90ddfd82b667a272ff1' +
  '7242d441c07367ac8bf7ad801fca2caa34d20beee95d9418f857ae08c513cd86b9ff7dc131f58a6ab1d120d7022204687107db9d9961bee659dd5190dc9aa3ab' +
  'd0810f471ae3ec8dbf967b5ca2a163234dc89e9c3a0c2eba6e9f5af292f34978cc15fb70757f351003646dc674d5b4ea097619fe4012e0bd05fa01f02a5ea956' +
  '438514899bb0e5487997fc1e82218c1b5f7754b21d254f0046ed5852eb7edac9fd3095653cb6e4bb7c0e5039263284699337e724a4cb530a87d94c838fce3b4ab7', 'hex');
const M0 = 0xfc, M1 = 0xf3, M2 = 0xcf, M3 = 0x3f;
// G 함수를 바이트 자리마다 미리 센 표(SS0~SS3). Z0..Z3 = Y의 마스크 XOR(RFC 4269 §2.2.1).
const SS = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
(function () {
  for (let x = 0; x < 256; x++) {
    const y0 = S1[x], y1 = S2[x];
    // 자리 0(S1): Z0=y&m0 Z1=y&m1 Z2=y&m2 Z3=y&m3 · 자리 1(S2): Z0=y&m1 Z1=y&m2 Z2=y&m3 Z3=y&m0
    // 자리 2(S1): Z0=y&m2 Z1=y&m3 Z2=y&m0 Z3=y&m1 · 자리 3(S2): Z0=y&m3 Z1=y&m0 Z2=y&m1 Z3=y&m2
    SS[0][x] = (((y0 & M3) << 24) | ((y0 & M2) << 16) | ((y0 & M1) << 8) | (y0 & M0)) >>> 0;
    SS[1][x] = (((y1 & M0) << 24) | ((y1 & M3) << 16) | ((y1 & M2) << 8) | (y1 & M1)) >>> 0;
    SS[2][x] = (((y0 & M1) << 24) | ((y0 & M0) << 16) | ((y0 & M3) << 8) | (y0 & M2)) >>> 0;
    SS[3][x] = (((y1 & M2) << 24) | ((y1 & M1) << 16) | ((y1 & M0) << 8) | (y1 & M3)) >>> 0;
  }
})();
function G(x) {
  return (SS[0][x & 0xff] ^ SS[1][(x >>> 8) & 0xff] ^ SS[2][(x >>> 16) & 0xff] ^ SS[3][(x >>> 24) & 0xff]) >>> 0;
}
// 키 상수 KC0 = 황금비 0x9e3779b9, KCi = KC(i-1) <<< 1
const KC = (function () {
  const a = new Uint32Array(16); let k = 0x9e3779b9;
  for (let i = 0; i < 16; i++) { a[i] = k; k = ((k << 1) | (k >>> 31)) >>> 0; }
  return a;
})();

// 라운드 키 32개(16라운드 × 2)
function seedKeySchedule(key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error('SEED_KEY_LEN');
  let A = key.readUInt32BE(0), B = key.readUInt32BE(4), C = key.readUInt32BE(8), D = key.readUInt32BE(12);
  const rk = new Uint32Array(32);
  for (let i = 0; i < 16; i++) {
    rk[2 * i] = G((A + C - KC[i]) >>> 0);
    rk[2 * i + 1] = G((B - D + KC[i]) >>> 0);
    let t;
    if ((i & 1) === 0) { t = A; A = ((A >>> 8) | (B << 24)) >>> 0; B = ((B >>> 8) | (t << 24)) >>> 0; }   // (A||B) >>> 8
    else { t = C; C = ((C << 8) | (D >>> 24)) >>> 0; D = ((D << 8) | (t >>> 24)) >>> 0; }                 // (C||D) <<< 8
  }
  return rk;
}

// 블록 하나(16바이트). dec=true면 라운드 키를 거꾸로.
function seedBlock(rk, src, so, dst, doff, dec) {
  let L0 = src.readUInt32BE(so), L1 = src.readUInt32BE(so + 4), R0 = src.readUInt32BE(so + 8), R1 = src.readUInt32BE(so + 12);
  for (let r = 0; r < 16; r++) {
    const ri = dec ? 15 - r : r;
    let T0 = (R0 ^ rk[2 * ri]) >>> 0, T1 = (R1 ^ rk[2 * ri + 1]) >>> 0;
    T1 = G((T1 ^ T0) >>> 0);
    T0 = G((T0 + T1) >>> 0);
    T1 = G((T1 + T0) >>> 0);
    T0 = (T0 + T1) >>> 0;
    const nR0 = (L0 ^ T0) >>> 0, nR1 = (L1 ^ T1) >>> 0;
    L0 = R0; L1 = R1; R0 = nR0; R1 = nR1;
  }
  // 마지막 라운드 뒤 좌우를 되바꿈(출력 = R16 || L16)
  dst.writeUInt32BE(R0, doff); dst.writeUInt32BE(R1, doff + 4); dst.writeUInt32BE(L0, doff + 8); dst.writeUInt32BE(L1, doff + 12);
}
function seedEncryptBlock(key, block) { const o = Buffer.alloc(16); seedBlock(seedKeySchedule(key), block, 0, o, 0, false); return o; }
function seedDecryptBlock(key, block) { const o = Buffer.alloc(16); seedBlock(seedKeySchedule(key), block, 0, o, 0, true); return o; }

function pkcs7Pad(buf) { const n = 16 - (buf.length % 16); return Buffer.concat([buf, Buffer.alloc(n, n)]); }
function pkcs7Unpad(buf) {
  if (!buf.length || buf.length % 16) throw new Error('PAD');
  const n = buf[buf.length - 1];
  if (n < 1 || n > 16) throw new Error('PAD');
  for (let i = buf.length - n; i < buf.length; i++) if (buf[i] !== n) throw new Error('PAD');
  return buf.subarray(0, buf.length - n);
}
const IV0 = Buffer.alloc(16);
function seedCbcEncrypt(key, data, iv) {
  const rk = seedKeySchedule(key), p = pkcs7Pad(Buffer.from(data)), out = Buffer.alloc(p.length);
  let prev = Buffer.from(iv || IV0);
  const x = Buffer.alloc(16);
  for (let o = 0; o < p.length; o += 16) {
    for (let j = 0; j < 16; j++) x[j] = p[o + j] ^ prev[j];
    seedBlock(rk, x, 0, out, o, false);
    prev = out.subarray(o, o + 16);
  }
  return out;
}
function seedCbcDecrypt(key, data, iv) {
  if (!data.length || data.length % 16) throw new Error('LEN');
  const rk = seedKeySchedule(key), out = Buffer.alloc(data.length);
  let prev = iv || IV0;
  for (let o = 0; o < data.length; o += 16) {
    seedBlock(rk, data, o, out, o, true);
    for (let j = 0; j < 16; j++) out[o + j] ^= prev[j];
    prev = data.subarray(o, o + 16);
  }
  return pkcs7Unpad(out);
}
function aesCbcDecrypt(key, data, iv) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv || IV0);
  return Buffer.concat([d.update(data), d.final()]);
}
function aesCbcEncrypt(key, data, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv || IV0);
  return Buffer.concat([c.update(data), c.final()]);
}

// ── 보안메일 HTML ──────────────────────────────────────────────────────
const LIMIT = { HTML: 8 * 1024 * 1024, FILES: 5, BN: 10 };
const XOR = 0x6b;
const ALG = { 1: 'AES', 2: 'SEED', 3: 'ARIA' };

function fail(code, why) { return { ok: false, code: code, why: why }; }
function decodeText(buf) {   // UTF-8이 깨지면 EUC-KR(국세청 옛 메일)
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { /* 아래 */ }
  try { return new TextDecoder('euc-kr').decode(b); } catch (e) { return b.toString('latin1'); }
}
function unEnt(s) {   // 속성 값 안의 흔한 엔티티만(base64·파일 이름)
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, e) {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
    const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}
// <input …> 태그들에서 id → value
function hiddenValues(html) {
  const out = Object.create(null);
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    const id = (t.match(/\bid\s*=\s*"([^"]*)"/i) || t.match(/\bid\s*=\s*'([^']*)'/i) || t.match(/\bid\s*=\s*([^\s"'>]+)/i) || [])[1];
    if (!id || !/^idCri[A-Za-z0-9]{1,40}$/.test(id)) continue;
    const v = (t.match(/\bvalue\s*=\s*"([^"]*)"/i) || t.match(/\bvalue\s*=\s*'([^']*)'/i) || t.match(/\bvalue\s*=\s*([^\s"'>]+)/i) || [])[1];
    if (v != null && !(id in out)) out[id] = unEnt(v);
  }
  return out;
}
function b64(s) { return Buffer.from(String(s || '').replace(/\s+/g, ''), 'base64'); }
function parseHeader(v) {
  const raw = b64(v);
  if (!raw.length) return null;
  const x = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) x[i] = raw[i] ^ XOR;
  const h = Object.create(null);
  const lines = decodeText(x).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], k = L.indexOf(':');
    if (k <= 0) continue;
    const key = L.slice(0, k).trim();
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
    h[key] = L.slice(k + 1).trim();
  }
  return h;
}
function dec(alg, key, data) { return alg === 'SEED' ? seedCbcDecrypt(key, data, IV0) : aesCbcDecrypt(key, data, IV0); }
// 여러 첨부일 때 머리 값이 'a|b' 꼴인지 모름(실물 3개는 모두 1개) — 개수와 맞게 갈리면 쓰고, 아니면 번호 붙은 키(AttachFileName0…)를 찾는다.
function attachList(h, n, key) {
  const v = h[key];
  if (n <= 1) return [v != null ? v : h[key + '0']];
  const out = [];
  for (let i = 0; i < n; i++) out.push(h[key + i]);
  if (out.every(function (x) { return x != null; })) return out;
  if (v != null) {
    const seps = ['|', ';', '/', ','];
    for (let s = 0; s < seps.length; s++) { const p = v.split(seps[s]); if (p.length === n) return p.map(function (x) { return x.trim(); }); }
  }
  return new Array(n).fill(undefined);
}

// htmlBuf: Buffer(보안메일 HTML) · bnList: 사업자번호 후보 글 배열(하이픈 있어도 됨 — 숫자만 씀)
// → { ok:true, alg:'SEED'|'AES', bnIdx, body:'본문 글', files:[{name, buf}] } | { ok:false, code, why }
function decryptNts(htmlBuf, bnList) {
  if (!Buffer.isBuffer(htmlBuf)) return fail('BAD_INPUT', '파일이 아닙니다');
  if (htmlBuf.length > LIMIT.HTML) return fail('TOO_BIG', '보안메일 HTML이 8MB를 넘습니다');
  const html = htmlBuf.toString('latin1');   // 필요한 값은 모두 ASCII(base64) — 글자 깨짐 무관
  const hv = hiddenValues(html);
  if (!hv.idCriHeader) return fail('NO_HEADER', '국세청 보안메일 꼴이 아닙니다(머리 칸 없음)');
  const h = parseHeader(hv.idCriHeader);
  if (!h || !h.ContentEncryptionAlgorithm) return fail('BAD_HEADER', '보안메일 머리를 읽지 못했습니다');
  const alg = ALG[h.ContentEncryptionAlgorithm];
  if (alg !== 'AES' && alg !== 'SEED') return fail('ALG_UNSUPPORTED', '지원하지 않는 암호 방식입니다(' + String(h.ContentEncryptionAlgorithm).slice(0, 4) + ')');
  if (!h.HashKey) return fail('BAD_HEADER', '보안메일 머리에 확인 값이 없습니다');
  const hk = b64(h.HashKey);
  if (!hk.length || hk.length % 16) return fail('BAD_HEADER', '보안메일 확인 값 꼴이 다릅니다');
  const list = Array.isArray(bnList) ? bnList.slice(0, LIMIT.BN) : [];
  let key = null, bnIdx = -1;
  for (let i = 0; i < list.length && !key; i++) {
    const d = String(list[i] == null ? '' : list[i]).replace(/\D/g, '');
    if (d.length !== 10) continue;
    const k = crypto.createHash('md5').update(d, 'utf8').digest();
    try {
      const got = dec(alg, k, hk).toString('latin1').trim();
      if (got.toLowerCase() === k.toString('hex')) { key = k; bnIdx = i; }
    } catch (e) { /* 패딩 틀림 = 다른 번호 */ }
  }
  if (!key) return fail('NO_KEY', '받는 쪽 사업자번호가 맞지 않습니다');
  const nAtt = /^\d{1,3}$/.test(h.AttachFileCount || '') ? Number(h.AttachFileCount) : 0;
  if (nAtt > LIMIT.FILES) return fail('TOO_MANY_FILES', '첨부가 ' + LIMIT.FILES + '개를 넘습니다');
  let body = '';
  try { body = hv.idCriPcContents ? decodeText(dec(alg, key, b64(hv.idCriPcContents))) : ''; }
  catch (e) { return fail('BAD_BODY', '본문을 풀지 못했습니다'); }
  const names = attachList(h, nAtt, 'AttachFileName'), tags = attachList(h, nAtt, 'AttachFileTagID');
  const files = [];
  for (let i = 0; i < nAtt; i++) {
    const tag = tags[i] && /^idCri[A-Za-z0-9]{1,40}$/.test(tags[i]) && hv[tags[i]] != null ? tags[i] : 'idCriAttachContents' + i;
    const v = hv[tag];
    if (v == null) return fail('NO_ATTACH', '첨부 ' + (i + 1) + '번 칸이 없습니다');
    let buf;
    try { buf = b64(dec(alg, key, b64(v)).toString('latin1')); }
    catch (e) { return fail('BAD_ATTACH', '첨부 ' + (i + 1) + '번을 풀지 못했습니다'); }
    const nm = String(names[i] || ('첨부' + (i + 1))).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
    files.push({ name: nm, buf: buf });
  }
  return { ok: true, alg: alg, bnIdx: bnIdx, body: body, files: files };
}

// 시험·fixture용 — 같은 꼴의 보안 HTML 만들기(가짜 값만 넣을 것). files: [{name, buf}]
function encryptNtsForTest(opt) {
  const algNo = opt.algNo || (opt.alg === 'AES' ? 1 : 2);   // algNo는 머리 값만 바꿔 보는 시험용(3 = ARIA 거절 확인)
  const key = crypto.createHash('md5').update(String(opt.bn).replace(/\D/g, ''), 'utf8').digest();
  const enc = algNo === 1 ? function (d) { return aesCbcEncrypt(key, d, IV0); } : function (d) { return seedCbcEncrypt(key, d, IV0); };
  const files = opt.files || [];
  const head = [
    'ContentEncryptionAlgorithm:' + algNo,
    'HintKey:' + (opt.hint || '받는 분 사업자등록번호 10자리'),
    'HashKey:' + enc(Buffer.from(key.toString('hex'), 'latin1')).toString('base64'),
    'AttachFileCount:' + files.length,
    'AttachFileName:' + files.map(function (f) { return f.name; }).join('|'),
    'AttachFileTagID:' + files.map(function (f, i) { return 'idCriAttachContents' + i; }).join('|'),
    'AttachFileSize:' + files.map(function (f) { return f.buf.length; }).join('|'),
    '', ''
  ].join('\r\n');
  const hb = Buffer.from(head, 'utf8');
  for (let i = 0; i < hb.length; i++) hb[i] ^= XOR;
  const bodyEnc = enc(Buffer.from(opt.body || '<html><body>가짜 본문</body></html>', 'utf8')).toString('base64');
  const inputs = [
    '<input type="hidden" id="idCriHeader" value="' + hb.toString('base64') + '">',
    '<input type="hidden" id="idCriPcContents" value="' + bodyEnc + '">',
    '<input type="hidden" id="idCriMobileContents" value="' + bodyEnc + '">'
  ];
  files.forEach(function (f, i) {
    inputs.push('<input type="hidden" id="idCriAttachContents' + i + '" value="' + enc(Buffer.from(f.buf.toString('base64'), 'latin1')).toString('base64') + '">');
  });
  return Buffer.from('﻿<!DOCTYPE html>\r\n<html lang="ko"><head><meta charset="utf-8"><title>전자세금계산서(시험용 가짜)</title></head><body>\r\n' +
    inputs.join('\r\n') +
    '\r\n<div id="CriBtnPosition"></div><input type="password" id="idPcPwd" name="idPcPwd"><input type="password" id="idMobilePwd" name="idMobilePwd">\r\n</body></html>\r\n', 'utf8');
}

module.exports = {
  LIMIT, seedKeySchedule, seedEncryptBlock, seedDecryptBlock, seedCbcEncrypt, seedCbcDecrypt, aesCbcEncrypt, aesCbcDecrypt,
  parseHeader, hiddenValues, decodeText, decryptNts, encryptNtsForTest
};
