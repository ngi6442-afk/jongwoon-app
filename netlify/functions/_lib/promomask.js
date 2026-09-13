'use strict';
// 홍보 사진 가리기(모자이크) — v354(PM 2026-09-13 "모자이크 착수", 9/11 브리핑 (a)+(c) 승인).
//   ① Claude 비전에 얼굴·자동차 번호판의 위치를 물어 정규화 좌표(0~1)로 받는다(자동 후보).
//   ② jimp(순수 JS)로 그 자리를 픽셀화해 새 JPEG를 만든다. 원본 첨부(att_<id>)는 손대지 않고 가린 판을 mask:<att_id>에 따로 둔다.
//   ③ 사람이 앱 사진 격자에서 상자를 더하거나 지우면(mask_apply) 원본에서 다시 픽셀화한다 — 좌표는 원본 크기 기준 정규화값이라 크기와 무관.
// 비전 좌표는 근사값이다(작은 얼굴·헬멧·측면·역광 누락 가능) — 그래서 20% 여백을 두고, 반드시 사람 확인 화면을 거친다(메모 '중복·삭제는 사람 확인').
// API 키는 호출자가 인자로만 넘긴다(여기서 env를 읽지 않는다). 로그·반환값에 키를 싣지 않는다.
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';        // 초안 생성(promoai.js)과 같은 모델 — 장당 약 10원(9/11 실측 추정)
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 40000;
const PAD = 0.20;                        // 상자 여백(가로·세로 각 20%) — 비전 좌표 오차 흡수
const MIN_BLOCK = 12;                    // 픽셀화 최소 블록(px)
const MAX_BOXES = 40;

function maskKey(attId) { return 'mask:' + attId; }

// 상자 정규화 — {kind:'face'|'plate'|'other', x,y,w,h ∈ [0,1]} 만 통과. 크기 0·범위 밖·NaN은 버린다.
function cleanBoxes(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (b) {
    if (!b || typeof b !== 'object' || out.length >= MAX_BOXES) return;
    const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
    if (![x, y, w, h].every(function (v) { return Number.isFinite(v); })) return;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x >= 1 || y >= 1) return;
    const kind = (b.kind === 'face' || b.kind === 'plate') ? b.kind : 'other';
    out.push({ kind: kind, x: Math.max(0, x), y: Math.max(0, y), w: Math.min(1 - x, w), h: Math.min(1 - y, h), by: (b.by === 'human') ? 'human' : 'auto' });
  });
  return out;
}

// 응답 본문에서 JSON 배열을 꺼낸다 — json_schema 출력이면 그대로, 아니면 첫 [ … ] 블록.
function parseBoxes(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  try { const j = JSON.parse(s); if (Array.isArray(j)) return cleanBoxes(j); if (j && Array.isArray(j.boxes)) return cleanBoxes(j.boxes); } catch (e) { /* 아래 */ }
  const m = /\[[\s\S]*\]/.exec(s);
  if (m) { try { return cleanBoxes(JSON.parse(m[0])); } catch (e) { /* 실패 */ } }
  return [];
}

// ① 비전 — 얼굴·번호판 좌표. 실패는 예외로 던진다(호출자가 사진 단위로 잡아 '감지 실패'로 기록).
async function detectBoxes(apiKey, mediaType, b64) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: '당신은 사진 속 개인정보를 찾는 검출기입니다. 사람 얼굴(정면·측면·마스크·헬멧 착용 포함, 아주 작은 얼굴도)과 자동차 번호판(앞·뒤, 기울어진 것 포함)의 위치를 모두 찾습니다. ' +
      '좌표는 이미지 왼쪽 위를 (0,0), 오른쪽 아래를 (1,1)로 하는 비율값입니다. x,y는 상자 왼쪽 위, w,h는 너비·높이. 놓치는 것보다 조금 넓게 잡는 쪽이 낫습니다. 없으면 빈 배열.',
    output_config: {
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
  const parts = (j && Array.isArray(j.content)) ? j.content : [];
  const out = parts.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
  const usage = (j && j.usage) ? { input: Number(j.usage.input_tokens) || 0, output: Number(j.usage.output_tokens) || 0 } : null;
  return { boxes: parseBoxes(out), usage: usage, model: (j && j.model) || MODEL };
}

// ② 픽셀화 — 원본 buf(JPEG/PNG/WebP)에 상자들을 적용해 JPEG(q82) 버퍼를 돌려준다. 상자가 없으면 null(가릴 것 없음).
async function applyBoxes(buf, boxes) {
  const list = cleanBoxes(boxes);
  if (!list.length) return null;
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  const W = img.width, H = img.height;
  list.forEach(function (b) {
    const px = b.w * W * PAD, py = b.h * H * PAD;
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
  return await img.getBuffer('image/jpeg', { quality: 82 });
}

// 이미지 크기만(앱 편집 화면이 비율을 맞추는 데 쓴다)
async function imageSize(buf) {
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  return { w: img.width, h: img.height };
}

module.exports = { maskKey, cleanBoxes, parseBoxes, detectBoxes, applyBoxes, imageSize, MODEL, PAD, MAX_BOXES };
