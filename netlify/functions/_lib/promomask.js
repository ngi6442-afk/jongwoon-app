'use strict';
// 홍보 사진 가리기(모자이크) — v353(PM 2026-09-13 "모자이크 착수", 9/11 브리핑 (a)+(c) 승인) · 적대 검증 반영(9/13 밤, 29건).
//   ① Claude 비전에 얼굴·자동차 번호판의 위치를 물어 정규화 좌표(0~1)로 받는다(자동 후보).
//   ② jimp(순수 JS)로 그 자리를 픽셀화해 새 JPEG를 만든다. 원본 첨부(att_<id>)는 손대지 않고 가린 판을 mask:<att_id>에 따로 둔다.
//   ③ 사람이 앱 사진 격자에서 상자를 더하거나 지우면(mask_apply) 원본에서 다시 픽셀화한다 — 좌표는 원본 크기 기준 정규화값이라 크기와 무관.
// 비전 좌표는 근사값이다(작은 얼굴·헬멧·측면·역광 누락 가능) — 그래서 여백(비례 20% + 절대 최소)을 두고, 반드시 사람 확인 화면을 거친다.
// 적대 검증 반영: 비전 응답의 거부·잘림·파싱 실패는 '가릴 것 없음'이 아니라 **실패**다(stop_reason 검사·parseBoxes null) — 실패는 mask를 쓰지 않아
//   배지가 '미확인'으로 남고 게시 전 경고가 뜬다. 가장자리 밖으로 걸친 상자는 버리지 않고 잘라 넣는다(cleanBoxes 클램프).
// API 키는 호출자가 인자로만 넘긴다(여기서 env를 읽지 않는다). 로그·반환값에 키를 싣지 않는다.
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';        // 초안 생성(promoai.js)과 같은 모델
const MAX_TOKENS = 4096;                 // 상자 40개 × ~35토큰 + 여유(1024는 단체 사진에서 잘렸다 — 적대 검증)
const TIMEOUT_MS = 40000;
const PAD = 0.20;                        // 상자 여백 비례(가로·세로 각 20%)
const PAD_MIN = 0.01;                    // 절대 최소 여백(이미지 변 대비 1%) — 작은 얼굴도 오차를 흡수
const MIN_BLOCK = 12;                    // 픽셀화 최소 블록(px)
const MAX_BOXES = 40;
const MAX_PHOTO_B64 = 1600000;           // 워커·apply 공통 상한(앱 업로더는 1600px·JPEG 0.82)
const RE_B64 = /^[A-Za-z0-9+/=\r\n]+$/;
const IMG_MIME = { 'image/jpeg': 1, 'image/png': 1 };   // jimp 1.6.1은 WebP 디코더가 없다(적대 검증) — jpeg·png만

function maskKey(attId) { return 'mask:' + attId; }
function metaKey(attId) { return 'maskmeta:' + attId; }   // 이미지 없이 상태만(mask_state·mask_get이 읽는다 — 큰 blob 40장 읽기 방지)

function mimeOf(rec) {
  const t = String((rec && rec.type) || '').trim().toLowerCase();
  if (IMG_MIME[t]) return t;
  const n = String((rec && rec.name) || '').toLowerCase();
  if (/\.jpe?g$/.test(n)) return 'image/jpeg';
  if (/\.png$/.test(n)) return 'image/png';
  return '';
}
// 첨부 레코드가 가리기 대상 이미지인지 — 워커·mask_apply 공통. 통과하면 {mt, data} 아니면 {err}
function checkImageRec(rec) {
  if (!rec || rec.kind !== 'promo') return { err: 'not_promo' };
  const mt = mimeOf(rec), data = String(rec.data || '');
  if (!mt) return { err: 'unsupported_format' };
  if (!data || !RE_B64.test(data)) return { err: 'bad_image' };
  if (data.length > MAX_PHOTO_B64) return { err: 'too_large' };
  return { mt: mt, data: data };
}

// 상자 정규화 — {kind, x,y,w,h ∈ [0,1]}. 가장자리 밖으로 걸친 상자는 잘라서 넣는다(버리지 않는다). 남는 크기가 0이면 버린다.
function cleanBoxes(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (b) {
    if (!b || typeof b !== 'object' || out.length >= MAX_BOXES) return;
    const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
    if (![x, y, w, h].every(function (v) { return Number.isFinite(v); })) return;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(1, x + w), y1 = Math.min(1, y + h);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
    const kind = (b.kind === 'face' || b.kind === 'plate') ? b.kind : 'other';
    out.push({ kind: kind, x: x0, y: y0, w: x1 - x0, h: y1 - y0, by: (b.by === 'human') ? 'human' : 'auto' });
  });
  return out;
}

// 응답 본문에서 상자 배열을 꺼낸다 — 읽을 수 없으면 null('없음'과 구분: 적대 검증 #1).
function parseBoxes(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { const j = JSON.parse(s); if (Array.isArray(j)) return cleanBoxes(j); if (j && Array.isArray(j.boxes)) return cleanBoxes(j.boxes); } catch (e) { /* 아래 */ }
  const m = /\[[\s\S]*\]/.exec(s);
  if (m) { try { const j2 = JSON.parse(m[0]); if (Array.isArray(j2)) return cleanBoxes(j2); } catch (e) { /* 실패 */ } }
  return null;
}

// ① 비전 — 얼굴·번호판 좌표. 실패는 예외로 던진다(호출자가 사진 단위로 잡아 '감지 실패'로 기록 — mask 저장 안 함).
//   거부(stop_reason refusal)·잘림(max_tokens)·파싱 불가는 전부 예외다. 상자 0개는 end_turn + 빈 배열일 때만.
async function detectBoxes(apiKey, mediaType, b64) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: '당신은 사진 속 개인정보를 찾는 검출기입니다. 사람 얼굴(정면·측면·마스크·헬멧 착용 포함, 아주 작은 얼굴도)과 자동차 번호판(앞·뒤, 기울어진 것 포함)의 위치를 모두 찾습니다. ' +
      '좌표는 이미지 왼쪽 위를 (0,0), 오른쪽 아래를 (1,1)로 하는 비율값입니다. x,y는 상자 왼쪽 위, w,h는 너비·높이. 놓치는 것보다 조금 넓게 잡는 쪽이 낫습니다. 없으면 빈 배열.',
    output_config: {
      effort: 'low',    // 좌표 나열은 긴 사고가 필요 없다 — 사고 토큰이 max_tokens를 먹어 잘리던 것 방지(적대 검증)
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            boxes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['face', 'plate'] },
                  x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                },
                required: ['kind', 'x', 'y', 'w', 'h'],
                additionalProperties: false,
              },
            },
          },
          required: ['boxes'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: '이 사진에서 사람 얼굴과 자동차 번호판의 위치를 전부 찾아 boxes로 주세요.' },
    ] }],
  };
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION }, body: JSON.stringify(body), signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    throw new Error((e && e.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK');
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw new Error('AUTH');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (res.status >= 400) throw new Error('HTTP_' + res.status);
  let j = null;
  try { j = JSON.parse(text); } catch (e) { throw new Error('BAD_JSON'); }
  const stop = String((j && j.stop_reason) || '');
  if (stop === 'refusal') throw new Error('REFUSAL');
  if (stop === 'max_tokens') throw new Error('TRUNCATED');
  const parts = (j && Array.isArray(j.content)) ? j.content : [];
  const out = parts.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
  const boxes = parseBoxes(out);
  if (boxes === null) throw new Error('PARSE');
  const usage = (j && j.usage) ? { input: Number(j.usage.input_tokens) || 0, output: Number(j.usage.output_tokens) || 0 } : null;
  return { boxes: boxes, usage: usage, model: (j && j.model) || MODEL };
}

// ①-b 비전 공용 호출(v371) — detectBoxes와 같은 오류 규약(TIMEOUT/NETWORK/AUTH/RATE_LIMIT/HTTP_/BAD_JSON/REFUSAL/TRUNCATED). 본문 text와 usage를 돌려준다.
async function askVision(apiKey, mediaType, b64, system, question, schema, maxTokens) {
  const body = {
    model: MODEL, max_tokens: maxTokens || 1024, system: system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schema } },
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } }, { type: 'text', text: question }] }],
  };
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION }, body: JSON.stringify(body), signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    throw new Error((e && e.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK');
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw new Error('AUTH');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (res.status >= 400) throw new Error('HTTP_' + res.status);
  let j = null;
  try { j = JSON.parse(text); } catch (e) { throw new Error('BAD_JSON'); }
  const stop = String((j && j.stop_reason) || '');
  if (stop === 'refusal') throw new Error('REFUSAL');
  if (stop === 'max_tokens') throw new Error('TRUNCATED');
  const parts = (j && Array.isArray(j.content)) ? j.content : [];
  const out = parts.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
  const usage = (j && j.usage) ? { input: Number(j.usage.input_tokens) || 0, output: Number(j.usage.output_tokens) || 0 } : null;
  return { text: out, usage: usage, model: (j && j.model) || MODEL };
}
const BOX_SCHEMA = { type: 'object', properties: { boxes: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['plate'] }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['kind', 'x', 'y', 'w', 'h'], additionalProperties: false } } }, required: ['boxes'], additionalProperties: false };
const VERIFY_SCHEMA = { type: 'object', properties: { state: { type: 'string', enum: ['full', 'partial', 'none'] } }, required: ['state'], additionalProperties: false };
// ①-c 차량 조각 안의 번호판 좌표(v371, platedet ②) — 좌표는 조각 기준 비율. 상자 0개 = 이 차량에 보이는 번호판 없음. 번호 문자열은 받지도 저장하지도 않는다.
async function detectPlatesInCrop(apiKey, mediaType, b64) {
  const r = await askVision(apiKey, mediaType, b64,
    '당신은 자동차 사진에서 번호판 위치를 찾는 검출기입니다. 이 이미지는 차량 한 대 주변을 잘라낸 조각입니다. 앞·뒤 번호판(기울어진 것, 일부 가려진 것 포함)의 위치를 전부 찾으세요. 좌표는 이 조각의 왼쪽 위 (0,0)·오른쪽 아래 (1,1) 비율값이고 x,y는 상자 왼쪽 위, w,h는 너비·높이입니다. 번호판 테두리를 정확히 감싸되 놓치는 것보다 조금 넓게 잡으세요. 번호판이 없으면 빈 배열. 번호 문자열은 적지 마세요.',
    '이 차량 조각에서 번호판 위치를 boxes로 주세요.', BOX_SCHEMA, 1024);
  const boxes = parseBoxes(r.text);
  if (boxes === null) throw new Error('PARSE');
  return { boxes: boxes.map(function (b) { return { kind: 'plate', x: b.x, y: b.y, w: b.w, h: b.h }; }), usage: r.usage, model: r.model };
}
// ①-d 자기검증(v371, platedet ③) — 번호판 상자를 여백 두고 잘라낸 조각: 'full'(번호판 네 변이 조각 안에·글자가 보임) / 'partial'(잘려 일부만) / 'none'(번호판 아님)
async function verifyPlate(apiKey, mediaType, b64) {
  const r = await askVision(apiKey, mediaType, b64,
    '당신은 사진 조각을 검사합니다. 이 조각은 자동차 번호판이 있다고 추정한 자리를 여백을 두고 잘라낸 것입니다. 판정: 번호판 전체(네 변)가 조각 안에 들어 있고 글자가 보이면 full, 번호판이 잘려 일부만 보이면 partial, 번호판이 아예 없으면 none. 번호 문자열은 적지 마세요.',
    '이 조각의 상태를 state로 주세요.', VERIFY_SCHEMA, 256);
  let state = '';
  try { const j = JSON.parse(String(r.text || '').trim()); state = String((j && j.state) || ''); } catch (e) { const m = /"state"\s*:\s*"(full|partial|none)"/.exec(String(r.text || '')); state = m ? m[1] : ''; }
  if (state !== 'full' && state !== 'partial' && state !== 'none') throw new Error('PARSE');
  return { state: state, usage: r.usage, model: r.model };
}

// ② 픽셀화 — 원본 buf(JPEG/PNG)를 한 번만 디코드해 {buf(JPEG q82 또는 null), w, h}를 돌려준다. 상자가 없으면 buf null(가릴 것 없음).
async function applyBoxes(buf, boxes) {
  const list = cleanBoxes(boxes);
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  const W = img.width, H = img.height;
  if (!list.length) return { buf: null, w: W, h: H };
  list.forEach(function (b) {
    const px = Math.max(b.w * W * PAD, W * PAD_MIN), py = Math.max(b.h * H * PAD, H * PAD_MIN);
    let x = Math.floor(b.x * W - px), y = Math.floor(b.y * H - py);
    let w = Math.ceil(b.w * W + px * 2), h = Math.ceil(b.h * H + py * 2);
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > W) w = W - x;
    if (y + h > H) h = H - y;
    if (w < 2 || h < 2) return;
    const size = Math.max(MIN_BLOCK, Math.round(Math.min(w, h) / 6));
    img.pixelate({ size: size, x: x, y: y, w: w, h: h });
  });
  return { buf: await img.getBuffer('image/jpeg', { quality: 82 }), w: W, h: H };
}

// 상태 문서(maskmeta:<id>) — 이미지 없이 {has, n, human, auto, w, h, ts}. mask 저장·삭제와 항상 짝으로 쓴다.
function metaOf(rec) {
  const boxes = (rec && Array.isArray(rec.boxes)) ? rec.boxes : [];
  return { schema: 1, has: true, n: boxes.length, human: !!(rec && (rec.human === true || boxes.some(function (b) { return b && b.by === 'human'; }))),
    auto: !!(rec && rec.auto === true), w: Number(rec && rec.w) || 0, h: Number(rec && rec.h) || 0, ts: Number(rec && rec.ts) || 0,
    model: String((rec && rec.model) || '') };   // v364: 어느 검출기 판인지(facedet+… / claude-…) — 크론 재감지 판정용
}

module.exports = { maskKey, metaKey, mimeOf, checkImageRec, cleanBoxes, parseBoxes, detectBoxes, askVision, detectPlatesInCrop, verifyPlate, applyBoxes, metaOf, MODEL, PAD, PAD_MIN, MAX_BOXES, MAX_PHOTO_B64, IMG_MIME };
