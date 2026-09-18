'use strict';
// 얼굴·머리 검출기 — v364(PM 9/16 "모자이크도 사람 얼굴 못 가리네 … 근본적으로" → 9/16 "중국계 불허"). 진화: 언어모델(Claude 비전) 좌표 → 전용 검출기.
//
// 왜: 9/16 마스크 판 실측 — Claude 비전이 낸 얼굴 상자는 자리가 틀렸다(픽셀화가 점퍼 가슴·벽돌 벽에 찍히고 얼굴은 노출). 언어모델은 픽셀 좌표를 못 짚는다.
// 무엇: **Google MoveNet MultiPose Lightning 하나만**(Apache-2.0, TF Hub google/movenet/multipose/lightning/1, tfjs 그래프 모델 9.4MB) —
//   사람의 자세를 찾고 머리 관절점(코·눈·귀)으로 '머리 상자'를 만든다. 얼굴 모델이 아니라 '사람' 모델이라 옆얼굴·숙인 머리·뒷모습·모자·안경도 가린다.
//   다중 배율 투표: 긴 변 192·256·320·384·448·512의 6배율 × 원본/좌우반전 = 12판을 돌려, 3판 이상에서 같은 자리에 머리가 잡힌 것만 채택.
//   (9/16 실측·독립 재현: 표본 13장 실제 머리 7개 전부 검출·오검출 0. 진짜 머리는 10~12표, 무늬 유령은 ≤1표라 3표 문턱은 여유가 있다.
//    타일 확대는 금지 — 고배율에서 MoveNet이 무늬에서 17관절 '사람'을 만들어낸다(점수 0.45, 진짜와 구분 불가). 768 이상도 같은 이유로 안 쓴다.)
// 왜 얼굴 모델이 아닌가: 9/16 네 갈래 실측(TinyFace 다중 입력·MediaPipe 타일·후보→자세 재검증·구글만)에서 실제 검출은 전부 MoveNet이 했고
//   얼굴 모델은 정면 1장에만 기여하며 무늬 오검출(0.90·0.96)을 냈다. face-api SSD 가중치는 원저작자가 홍콩(Hisilicon)이라 PM이 불허(9/16).
//   이 파일이 읽는 모델 파일은 movenet/ 4개뿐. face-api·MediaPipe·SSD·MTCNN·RetinaFace·YuNet·UltraFace 등 어떤 얼굴 모델도 싣지 않는다.
// 한계(실측): 몸 맥락이 없는 얼굴(포스터·창 너머·극단 근접), 25px 이하 머리(어두운 옷 작업자)는 못 잡는다. 마네킹·동상·반사상은 사람으로 잡힐 수 있다(가리기 도구엔 무해).
// 어디서: gw-promo-mask-background 워커. 번호판은 종전대로 Claude 비전(번호판 전용 공개 모델은 출처가 확인되는 것이 없다).
// 모델 파일: netlify/functions/_models/{movenet, wasm} — netlify.toml included_files로 함수에 동봉. 외부 호출 없음.
const path = require('path');
const fs = require('fs');

const SIZES = [192, 256, 320, 384, 448, 512];   // 긴 변 픽셀(32의 배수). pose-detection은 이미지를 이 긴 변으로 줄여 넣는다 — 확대는 무의미, 배율 다양성이 핵심
const POSE_MIN = 0.10;      // 자세(인스턴스) 점수 하한 — 후보
const HEAD_MIN = 0.40;      // 머리 관절점(코·눈·귀) 최고 점수 하한 — 후보
const KP_MIN = 0.25;        // 관절점이 '보인다'로 치는 점수 — 머리 상자 구성·머리점 개수
const NHEAD_MIN = 2;        // 보이는 머리 관절점 최소 개수
const VOTES_MIN = 3;        // 같은 자리에 잡힌 판(12판 중) 최소 수 — 채택
const BOX_W = 1.3, BOX_H = 1.5;   // 머리 상자 = 크기 × (1.3, 1.5), 중심에서 위 55%
const MIN_FRAC = 0.03;      // 머리 크기 하한 = 짧은 변의 3%
const JOIN_DIST = 0.8;      // 군집 합류: 중심 거리 ≤ 0.8 × 큰 쪽 크기(또는 중심이 상대 상자 안)
const EXPAND = 1.3;         // 최종 상자 = 군집 중앙값 상자 × 1.3(귀·눈 관절점은 머리 윤곽보다 안쪽 — 가리기용 여유; applyBoxes가 20% 더 준다)
const MAX_POSES = 6;        // MoveNet MultiPose 상한(판당)
const MAX_AREA = 0.20;      // 화면 대비 넓이 — 넘으면 diag.big으로 표시만(근접 얼굴은 정당)
const MODEL_DIRS = ['netlify/functions/_models', '_models'];

function modelRoot() {
  const cands = [path.join(__dirname, '_models')];   // 번들 배치(/var/task/netlify/functions/_lib → ../_models) 첫 후보
  for (const d of MODEL_DIRS) { cands.push(path.resolve(process.cwd(), d)); cands.push(path.resolve(__dirname, '..', d.replace(/^netlify\/functions\//, ''))); }
  cands.push(path.resolve(__dirname, '..', '_models'));
  for (const c of cands) { try { if (fs.existsSync(path.join(c, 'movenet', 'model.json'))) return c; } catch (e) { /* 다음 */ } }
  return null;
}

// ── 순수 함수(검사 대상) ──
function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}
function centerIn(a, b) {   // a의 중심이 b 안에
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}
function ptIn(px, py, b) { return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; }
const HEAD_NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];
function byName(kps) { const by = {}; (kps || []).forEach(function (k) { if (k && k.name) by[k.name] = k; }); return by; }
// 관절점(픽셀, {name,x,y,score}) → 머리 상자(픽셀) 또는 null. 코·눈·귀 중 보이는 점의 외접 사각형 중심, 크기 = max(외접 폭·높이, 어깨 폭×0.55, 짧은 변 3%)
function headBoxFromKeypoints(kps, W, H, opts) {
  const o = Object.assign({ kpMin: KP_MIN, boxW: BOX_W, boxH: BOX_H, minFrac: MIN_FRAC }, opts || {});
  const by = byName(kps);
  const pts = HEAD_NAMES.map(function (n) { return by[n]; }).filter(function (k) { return k && k.score >= o.kpMin; });
  if (!pts.length) return null;
  const xs = pts.map(function (k) { return k.x; }), ys = pts.map(function (k) { return k.y; });
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sh = ['left_shoulder', 'right_shoulder'].map(function (n) { return by[n]; }).filter(function (k) { return k && k.score >= o.kpMin; });
  const shw = sh.length === 2 ? Math.abs(sh[0].x - sh[1].x) : 0;
  const size = Math.max(x1 - x0, y1 - y0, shw * 0.55, Math.min(W, H) * o.minFrac);
  const w = size * o.boxW, h = size * o.boxH;
  return { x: cx - w / 2, y: cy - h * 0.55, w: w, h: h, cx: cx, cy: cy, size: size };
}
// 머리 관절점 최고 점수·보이는 개수
function headScore(kps, kpMin) {
  const by = byName(kps); let best = 0, n = 0;
  HEAD_NAMES.forEach(function (nm) { const k = by[nm]; if (!k) return; if (k.score > best) best = k.score; if (k.score >= (kpMin == null ? KP_MIN : kpMin)) n++; });
  return { best: best, n: n };
}
// 한 판의 자세 하나 → 후보 {pass, s, best, nh, box, ok}. flipped면 x를 되돌린다(x' = W - x).
function candidateOf(pose, W, H, flipped, pass, opts) {
  const o = Object.assign({ poseMin: POSE_MIN, headMin: HEAD_MIN, kpMin: KP_MIN, nheadMin: NHEAD_MIN }, opts || {});
  const kps = ((pose && pose.keypoints) || []).map(function (k) { return { name: k.name, x: flipped ? (W - k.x) : k.x, y: k.y, score: k.score }; });
  const hs = headScore(kps, o.kpMin);
  const box = headBoxFromKeypoints(kps, W, H, o);
  const s = Number(pose && pose.score) || 0;
  return { pass: pass, s: s, best: hs.best, nh: hs.n, box: box, ok: !!box && s >= o.poseMin && hs.best >= o.headMin && hs.n >= o.nheadMin };
}
// 후보(모든 판) → 군집(점수순 탐욕 합류). 각 군집: passes(서로 다른 판), members, rep(대표 상자), maxS, maxH
function clusterCandidates(cands, opts) {
  const o = Object.assign({ joinDist: JOIN_DIST }, opts || {});
  const ok = (cands || []).filter(function (c) { return c && c.ok && c.box; }).sort(function (a, b) { return b.s - a.s; });
  const clusters = [];
  for (const c of ok) {
    let hit = null;
    for (const cl of clusters) {
      const d = Math.hypot(c.box.cx - cl.rep.cx, c.box.cy - cl.rep.cy);
      if (d <= o.joinDist * Math.max(cl.rep.size, c.box.size) || ptIn(c.box.cx, c.box.cy, cl.rep) || ptIn(cl.rep.cx, cl.rep.cy, c.box)) { hit = cl; break; }
    }
    if (hit) { hit.members.push(c); if (hit.passes.indexOf(c.pass) < 0) hit.passes.push(c.pass); hit.maxS = Math.max(hit.maxS, c.s); hit.maxH = Math.max(hit.maxH, c.best); }
    else clusters.push({ rep: c.box, members: [c], passes: [c.pass], maxS: c.s, maxH: c.best });
  }
  return clusters;
}
function median(a) { const s = a.slice().sort(function (x, y) { return x - y; }); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
// 군집 → 최종 상자(비율 0~1). votesMin 이상인 군집만. 상자 = 구성원 중심·크기의 중앙값 × expand(한 판의 엇나간 귀 관절점이 상자를 부풀리지 않게)
function finalsOf(clusters, W, H, opts) {
  const o = Object.assign({ votesMin: VOTES_MIN, expand: EXPAND }, opts || {});
  const out = [];
  for (const cl of clusters || []) {
    if (!cl.passes || cl.passes.length < o.votesMin) continue;
    const cx = median(cl.members.map(function (m) { return m.box.cx; })), cy = median(cl.members.map(function (m) { return m.box.cy; }));
    const w = median(cl.members.map(function (m) { return m.box.w; })) * o.expand, h = median(cl.members.map(function (m) { return m.box.h; })) * o.expand;
    out.push({ kind: 'face', x: (cx - w / 2) / W, y: (cy - h * 0.55) / H, w: w / W, h: h / H, score: Math.round(cl.maxS * 1000) / 1000, src: 'movenet-vote' + cl.passes.length, votes: cl.passes.length });
  }
  out.sort(function (a, b) { return b.votes - a.votes || b.score - a.score; });
  return out;
}

// ── 모델 적재(지연·1회) ──
let _env = null;
async function loadEnv() {
  if (_env) return _env;
  const root = modelRoot();
  if (!root) throw new Error('MODELS_MISSING');
  const tf = require('@tensorflow/tfjs');
  const wasm = require('@tensorflow/tfjs-backend-wasm');
  wasm.setWasmPaths(path.join(root, 'wasm') + path.sep);
  const okBackend = await tf.setBackend('wasm'); await tf.ready();
  if (!okBackend || tf.getBackend() !== 'wasm') throw new Error('WASM_BACKEND_FAILED');   // 검증 #13: 실패를 삼키면 순수 JS 백엔드로 20배 느리게 돌며 det_fail 0으로 보인다
  const pd = require('@tensorflow-models/pose-detection');
  const pose = await pd.createDetector(pd.SupportedModels.MoveNet, { modelType: pd.movenet.modelType.MULTIPOSE_LIGHTNING, enableTracking: false, enableSmoothing: false, minPoseScore: 0.01, modelUrl: diskIOHandler(tf, path.join(root, 'movenet')) });
  _env = { tf: tf, pose: pose, root: root };
  return _env;
}
// tfjs 그래프 모델을 디스크에서 읽는 IOHandler(tfjs-node 없이) — model.json + 가중치 조각을 한 버퍼로
function diskIOHandler(tf, dir) {
  return {
    load: async function () {
      const mj = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
      const manifest = mj.weightsManifest || [];
      const specs = []; const bufs = [];
      for (const g of manifest) { for (const s of (g.weights || [])) specs.push(s); for (const p of (g.paths || [])) bufs.push(fs.readFileSync(path.join(dir, p))); }
      const total = bufs.reduce(function (n, b) { return n + b.length; }, 0);
      const all = new Uint8Array(total); let off = 0;
      for (const b of bufs) { all.set(new Uint8Array(b.buffer, b.byteOffset, b.length), off); off += b.length; }
      return { modelTopology: mj.modelTopology, format: mj.format, generatedBy: mj.generatedBy, convertedBy: mj.convertedBy, weightSpecs: specs, weightData: all.buffer, signature: mj.signature, userDefinedMetadata: mj.userDefinedMetadata };
    },
  };
}
function toTensor(tf, img) {
  const W = img.bitmap.width, H = img.bitmap.height, d = img.bitmap.data;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return tf.tensor3d(rgb, [H, W, 3], 'int32');
}

// 본체: JPEG/PNG buf → {boxes:[{kind:'face',x,y,w,h,score,src,votes}], w, h, ms, diag}
async function detectFaces(buf) {
  const t0 = Date.now();
  const env = await loadEnv();
  const { tf, pose } = env;
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  const W = img.bitmap.width, H = img.bitmap.height;
  const flip = img.clone().flip({ horizontal: true, vertical: false });
  const cands = [];
  let passes = 0;
  for (const size of SIZES) {
    for (const run of [['w' + size, img, false], ['f' + size, flip, true]]) {
      pose.multiPoseMaxDimension = size; pose.minPoseScore = 0.01;   // 다 받고 규칙이 거른다
      const eng = tf.engine(); eng.startScope();   // 검증 #2: estimatePoses 안에서 던지면 입력(23MB)·패딩 텐서가 새므로 판마다 스코프
      const t = toTensor(tf, run[1]);
      try {
        const poses = await pose.estimatePoses(t, { maxPoses: MAX_POSES, flipHorizontal: false });
        passes++;
        poses.forEach(function (p) { cands.push(candidateOf(p, W, H, run[2], run[0])); });
      } finally { try { t.dispose(); } catch (e) { /* 스코프가 정리 */ } eng.endScope(); }
    }
  }
  const clusters = clusterCandidates(cands);
  const boxes = finalsOf(clusters, W, H);
  const big = boxes.filter(function (b) { return b.w * b.h > MAX_AREA; }).length;
  const okN = cands.filter(function (c) { return c.ok; }).length;
  return { boxes: boxes, w: W, h: H, ms: Date.now() - t0, diag: { passes: passes, raw: okN, clusters: clusters.length, dropped: clusters.length - boxes.length, big: big, pose: true } };
}

module.exports = { detectFaces, headBoxFromKeypoints, headScore, candidateOf, clusterCandidates, finalsOf, median, iou, centerIn, diskIOHandler, modelRoot, SIZES, POSE_MIN, HEAD_MIN, KP_MIN, NHEAD_MIN, VOTES_MIN, EXPAND, BOX_W, BOX_H, MIN_FRAC, JOIN_DIST, MAX_AREA };
