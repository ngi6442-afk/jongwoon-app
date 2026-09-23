'use strict';
// 번호판 가리기 — 차량 전용 검출기 + 조각 확대(v371, PM 9/23 "차번호 덜/안 가려짐" → "ㄱ"). 진화: 사진 전체를 Claude 비전에 묻던 것 → 차량을 먼저 찾고 그 조각만 묻는다.
//
// 왜: 9/23 실측(두 게시글 26장) — Claude 비전이 사진 전체를 보고 부른 번호판 좌표 7개가 전부 엉뚱한 자리(도로·인도·아스팔트, 세로로 밀림)였고 배경 차량 6대는 빠졌다.
//   얼굴은 v364에서 전용 검출기(MoveNet)로 풀었고, 번호판만 언어모델 좌표에 남아 있었다.
// 무엇: ① **Google COCO-SSD(SSDLite MobileNetV2, tfjs 그래프 모델 18MB, Apache-2.0, tensorflow/tfjs-models)** 로 자동차·트럭·버스·오토바이 상자를 찾는다 —
//   긴 변 512·800·1024 × 원본/좌우반전 = 6판 투표(같은 자리 2판 이상 또는 점수 0.6 이상만 채택). 9/23 실측: WASM 백엔드에서 판당 약 0.1초, 3장 26대 차량 중 번호판 있는 차 전부 검출.
//   ② 차량 상자를 넓혀 잘라낸 조각을 Claude 비전에 보내 번호판 좌표를 받는다(조각 안에서 번호판은 크게 보여 좌표가 정확해진다). 좌표는 조각 → 원본으로 환산.
//   ③ 자기검증: 받은 번호판 상자를 여백을 두고 잘라 "번호판이 온전히 들어 있나"를 다시 묻는다. 아니면 상자를 키워 1회 재시도, 그래도 아니면 차량 하단 띠를 통째로 가린다(놓치는 것보다 넓게).
//   ④ 차량이 안 잡힌 번호판(가장자리에 걸친 트럭 등)을 위해 종전 전체 사진 1회(detectBoxes)는 폴백으로 남기되 그 상자도 ③으로 검증한다.
// 중국계 없음: 모델·가중치 = Google TensorFlow(storage.googleapis.com/tfjs-models). 이 파일이 읽는 모델은 cocossd/ 6개 파일뿐. 번호판 글자 읽기 모델은 싣지 않는다 — 번호 문자열은 저장·로그하지 않는다.
// 모델 파일: netlify/functions/_models/cocossd — netlify.toml included_files로 동봉. facedet의 WASM 백엔드·디스크 로더를 같이 쓴다(적재 때만 지연 require — 순수 함수는 facedet 없이 돈다).
const path = require('path');
const fs = require('fs');

const SIZES = [512, 800, 1024];            // 긴 변 픽셀 — COCO-SSD 입력은 300×300로 내부 축소되므로 배율 다양성은 작은 차량(배경)용
const VEH = { car: 1, truck: 1, bus: 1, motorcycle: 1 };
const SCORE_MIN = 0.22;                    // 후보 하한(작은 배경 차량 0.2대 실측)
const SCORE_SURE = 0.45;                   // 이 점수 이상이면 1판만 잡혀도 채택(9/23 A8 가장자리 차: 타일 1판 0.48뿐 — 오검출은 조각 1회 비용일 뿐이라 낮게)
const VOTES_MIN = 2;                       // 그 밖은 같은 자리(IoU≥0.45)에 2판 이상
const JOIN_IOU = 0.45;
const MAX_VEH = 8;                         // 사진당 차량 상한(비용 상한: 차량당 Claude 2~3회)
const CROP_PAD = 0.15;                     // 조각 여백(차량 상자 대비, 좌우·위)
const CROP_PAD_BOTTOM = 0.60;              // 아래 여백(차량 상자 세로 대비) — 검출기 상자가 차체 위쪽만 잡는 일이 있어(9/23 B18 K7: 번호판이 상자 밑 0.05) 번호판 자리인 아래를 넉넉히
const TILES = 3;                           // 3×3 겹침 타일(각 45%, 긴 변 800) 판 추가 — 가장자리에 걸친 작은 차(9/23 A8 오른쪽 끝 흰 차)는 전체 판·절반 판에서 놓치고 35~45% 조각에서만 0.76으로 잡혔다
const TILE_FRAC = 0.45;
const CROP_MIN_PX = 48;                    // 이보다 작은 차량은 번호판이 읽힐 크기가 아니다 — 하단 띠 폴백 없이 건너뜀(오검출 방지)
const CROP_MAX_SIDE = 1200;                // 조각 긴 변 상한(비전 입력)
const VERIFY_PAD = 0.60;                   // 검증 조각 여백(번호판 상자 대비)
const GROW = 0.40;                         // 재시도 때 상자 키우는 비율
const BAND = { top: 0.55, left: 0.08, right: 0.92 };   // 폴백: 차량 하단 띠(상자 세로 55%부터 끝까지, 좌우 8% 안쪽)

// ── 순수 함수(검사 대상) ──
function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}
function centerIn(a, b) { const cx = a.x + a.w / 2, cy = a.y + a.h / 2; return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h; }
function median(a) { const s = a.slice().sort(function (x, y) { return x - y; }); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
// 여러 판의 원시 검출 [{cls, score, x,y,w,h(비율), pass}] → 투표 병합 [{cls, score, x,y,w,h, votes}]
function mergeVehicles(raw, opts) {
  const o = Object.assign({ scoreMin: SCORE_MIN, scoreSure: SCORE_SURE, votesMin: VOTES_MIN, joinIou: JOIN_IOU, maxVeh: MAX_VEH }, opts || {});
  const cands = (raw || []).filter(function (r) { return r && VEH[r.cls] && Number(r.score) >= o.scoreMin && r.w > 0 && r.h > 0; }).sort(function (a, b) { return b.score - a.score; });
  const groups = [];
  for (const c of cands) {
    let hit = null;
    for (const g of groups) { if (iou(c, g.rep) >= o.joinIou) { hit = g; break; } }
    if (hit) { hit.members.push(c); if (hit.passes.indexOf(c.pass) < 0) hit.passes.push(c.pass); if (c.score > hit.score) { hit.score = c.score; } }
    else groups.push({ rep: c, members: [c], passes: [c.pass], score: c.score, cls: c.cls });
  }
  const out = [];
  for (const g of groups) {
    if (!(g.score >= o.scoreSure || g.passes.length >= o.votesMin)) continue;
    const x = median(g.members.map(function (m) { return m.x; })), y = median(g.members.map(function (m) { return m.y; }));
    const x1 = median(g.members.map(function (m) { return m.x + m.w; })), y1 = median(g.members.map(function (m) { return m.y + m.h; }));
    out.push({ cls: g.cls, score: Math.round(g.score * 1000) / 1000, x: x, y: y, w: x1 - x, h: y1 - y, votes: g.passes.length });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, o.maxVeh);
}
// 상자(비율) → 여백을 준 픽셀 사각형(이미지 안으로 클램프). {x, y, w, h}(픽셀 정수). padBottom(선택)은 아래쪽만 따로(차량 조각용)
function padRect(b, W, H, pad, padBottom) {
  const px = b.w * W * pad, py = b.h * H * pad, pb = b.h * H * (padBottom == null ? pad : padBottom);
  let x0 = Math.floor(b.x * W - px), y0 = Math.floor(b.y * H - py), x1 = Math.ceil((b.x + b.w) * W + px), y1 = Math.ceil((b.y + b.h) * H + pb);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
// 조각 안 비율 상자 → 원본 비율 상자
function mapFromCrop(b, rect, W, H) {
  return { kind: 'plate', x: (rect.x + b.x * rect.w) / W, y: (rect.y + b.y * rect.h) / H, w: (b.w * rect.w) / W, h: (b.h * rect.h) / H };
}
// 상자를 비율 g만큼 키운다(중심 고정, 0~1 클램프는 cleanBoxes가)
function grow(b, g) { return { kind: b.kind || 'plate', x: b.x - b.w * g / 2, y: b.y - b.h * g / 2, w: b.w * (1 + g), h: b.h * (1 + g) }; }
// 폴백: 차량 하단 띠
function bandOf(v) { return { kind: 'plate', x: v.x + v.w * BAND.left, y: v.y + v.h * BAND.top, w: v.w * (BAND.right - BAND.left), h: v.h * (1 - BAND.top), fallback: true }; }
// 이미 있는 상자와 겹치는가(IoU 또는 중심 포함)
function overlaps(b, list, thr) {
  return (list || []).some(function (o) { return iou(b, o) >= (thr == null ? 0.3 : thr) || centerIn(b, o) || centerIn(o, b); });
}

// ── 모델 적재(지연·1회) — facedet의 WASM 백엔드·디스크 로더 재사용 ──
let _model = null;
async function loadModel() {
  if (_model) return _model;
  const F = require('./facedet');   // 지연 require — 검사에서 facedet이 mock이어도 순수 함수는 영향 없다
  const root = F.modelRoot();
  if (!root || !fs.existsSync(path.join(root, 'cocossd', 'model.json'))) throw new Error('MODELS_MISSING');
  const tf = require('@tensorflow/tfjs');
  if (tf.getBackend() !== 'wasm') {
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    wasm.setWasmPaths(path.join(root, 'wasm') + path.sep);
    const okBackend = await tf.setBackend('wasm'); await tf.ready();
    if (!okBackend || tf.getBackend() !== 'wasm') throw new Error('WASM_BACKEND_FAILED');
  }
  const coco = require('@tensorflow-models/coco-ssd');
  const model = await coco.load({ base: 'lite_mobilenet_v2', modelUrl: F.diskIOHandler(tf, path.join(root, 'cocossd')) });
  _model = { tf: tf, model: model };
  return _model;
}
function toTensor(tf, img) {
  const W = img.bitmap.width, H = img.bitmap.height, d = img.bitmap.data;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return tf.tensor3d(rgb, [H, W, 3], 'int32');
}
// jimp 이미지 → 차량 상자(비율) — 6판 투표
async function detectVehicles(img) {
  const t0 = Date.now();
  const { tf, model } = await loadModel();
  const W = img.bitmap.width, H = img.bitmap.height;
  const flip = img.clone().flip({ horizontal: true, vertical: false });
  const raw = []; let passes = 0;
  // 판 목록: 배율 3 × 원본/반전(6판) + 3×3 겹침 타일(9판, 긴 변 800). 타일 판의 좌표는 원본 비율로 되돌린다(ox·oy·sx·sy = 조각의 원본 내 위치·크기 비율)
  const runs = [];
  for (const size of SIZES) { runs.push({ pass: 'w' + size, src: img, flipped: false, size: size, ox: 0, sx: 1 }); runs.push({ pass: 'f' + size, src: flip, flipped: true, size: size, ox: 0, sx: 1 }); }
  if (TILES > 1 && W >= 400 && H >= 400) {
    const tw = Math.ceil(W * TILE_FRAC), th = Math.ceil(H * TILE_FRAC), step = (1 - TILE_FRAC) / (TILES - 1);
    for (let i = 0; i < TILES; i++) {
      for (let j = 0; j < TILES; j++) {
        const x0 = Math.min(W - tw, Math.floor(W * step * i)), y0 = Math.min(H - th, Math.floor(H * step * j));
        runs.push({ pass: 't' + i + j, src: img.clone().crop({ x: x0, y: y0, w: tw, h: th }), flipped: false, size: 800, ox: x0 / W, sx: tw / W, oy: y0 / H, sy: th / H });
      }
    }
  }
  for (const run of runs) {
    const src = run.src, sc = Math.min(1, run.size / Math.max(src.bitmap.width, src.bitmap.height));
    const im = sc < 1 ? src.clone().scaleToFit({ w: run.size, h: run.size }) : src;
    const w = im.bitmap.width, h = im.bitmap.height;
    const eng = tf.engine(); eng.startScope();
    const t = toTensor(tf, im);
    try {
      const preds = await model.detect(t, 20, SCORE_MIN);
      passes++;
      preds.forEach(function (p) {
        if (!VEH[p.class]) return;
        const bx = p.bbox[0] / w, by = p.bbox[1] / h, bw = p.bbox[2] / w, bh = p.bbox[3] / h;
        const x = run.flipped ? (1 - bx - bw) : bx, sy = (run.sy == null ? 1 : run.sy), oy = run.oy || 0;
        raw.push({ cls: p.class, score: p.score, x: run.ox + x * run.sx, y: oy + by * sy, w: bw * run.sx, h: bh * sy, pass: run.pass });
      });
    } finally { try { t.dispose(); } catch (e) { /* 스코프가 정리 */ } eng.endScope(); }
  }
  const boxes = mergeVehicles(raw);
  return { boxes: boxes, w: W, h: H, ms: Date.now() - t0, diag: { passes: passes, raw: raw.length } };
}
// 조각 JPEG(base64) — rect(픽셀) 잘라 긴 변 CROP_MAX_SIDE 이내로
async function cropB64(img, rect) {
  const c = img.clone().crop({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  const longSide = Math.max(c.bitmap.width, c.bitmap.height);
  if (longSide > CROP_MAX_SIDE) c.scaleToFit({ w: CROP_MAX_SIDE, h: CROP_MAX_SIDE });
  const buf = await c.getBuffer('image/jpeg', { quality: 85 });
  return buf.toString('base64');
}

// 본체: 원본 buf + 비전 함수 2개(promomask.detectPlatesInCrop·verifyPlate — apiKey는 호출자가 묶어서 넘긴다) + 폴백 전체 감지 함수
//   → {boxes:[{kind:'plate', x,y,w,h, src, verified}], vehicles, calls, usage, ms, diag}
async function detectPlates(buf, vision, opts) {
  const t0 = Date.now();
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  const W = img.bitmap.width, H = img.bitmap.height;
  const vr = (opts && typeof opts.vehiclesOf === 'function') ? await opts.vehiclesOf(img) : await detectVehicles(img);   // 검사에서 차량 검출을 주입(모델 없이 흐름만)
  const out = []; let calls = 0; const usage = { input: 0, output: 0 }; const diag = { veh: vr.boxes.length, vehMs: vr.ms, crops: 0, verified: 0, grown: 0, band: 0, fallback: 0, small: 0 };
  const acc = function (r) { calls++; if (r && r.usage) { usage.input += r.usage.input || 0; usage.output += r.usage.output || 0; } };
  // ③ 검증 — 상자를 여백 두고 잘라 "온전히 들어 있나". 실패면 키워 1회 재시도. 반환 {box, verified} 또는 null(번호판 아님)
  const verify = async function (b) {
    let cur = b;
    for (let i = 0; i < 2; i++) {
      const rect = padRect(cur, W, H, VERIFY_PAD);
      if (rect.w < 8 || rect.h < 8) return null;
      const r = await vision.verify(await cropB64(img, rect)); acc(r);
      if (r.state === 'full') { diag.verified++; return { box: cur, verified: true }; }
      if (r.state === 'none') return null;
      cur = grow(cur, GROW); diag.grown++;   // 'partial' → 키워 재시도
    }
    return { box: cur, verified: false };   // 두 번 다 부분 — 키운 상자로 가린다(놓치는 것보다 넓게)
  };
  for (const v of vr.boxes) {
    const rect = padRect(v, W, H, CROP_PAD, CROP_PAD_BOTTOM);
    if (rect.w < CROP_MIN_PX || rect.h < CROP_MIN_PX) { diag.small++; continue; }
    diag.crops++;
    const r = await vision.plates(await cropB64(img, rect)); acc(r);
    const found = (r.boxes || []).map(function (b) { return mapFromCrop(b, rect, W, H); });
    let kept = 0;
    for (const b of found) {
      if (overlaps(b, out)) continue;
      const vres = await verify(b);
      if (!vres) continue;
      out.push(Object.assign({}, vres.box, { kind: 'plate', src: 'vehicle-crop', verified: vres.verified })); kept++;
    }
    if (!kept && found.length) { const band = bandOf(v); if (!overlaps(band, out)) { out.push(Object.assign(band, { src: 'vehicle-band' })); diag.band++; } }   // 좌표는 나왔는데 검증에서 전부 '번호판 아님' → 차량 하단 띠
  }
  // ④ 폴백 — 전체 사진 1회(차량이 안 잡힌 번호판): 나온 상자를 같은 검증에 태운다
  if (vision.whole) {
    const r = await vision.whole(); acc(r); diag.fallback++;
    for (const b0 of (r.boxes || []).filter(function (b) { return b && b.kind === 'plate'; })) {
      const b = { kind: 'plate', x: b0.x, y: b0.y, w: b0.w, h: b0.h };
      if (overlaps(b, out)) continue;
      const vres = await verify(b);
      if (vres) out.push(Object.assign({}, vres.box, { kind: 'plate', src: 'whole', verified: vres.verified }));
    }
  }
  return { boxes: out, vehicles: vr.boxes, calls: calls, usage: usage, ms: Date.now() - t0, diag: diag };
}

module.exports = { detectPlates, detectVehicles, mergeVehicles, padRect, mapFromCrop, grow, bandOf, overlaps, loadModel, SIZES, SCORE_MIN, SCORE_SURE, VOTES_MIN, JOIN_IOU, MAX_VEH, CROP_PAD, CROP_PAD_BOTTOM, TILES, TILE_FRAC, CROP_MIN_PX, VERIFY_PAD, GROW, BAND, VEH };
