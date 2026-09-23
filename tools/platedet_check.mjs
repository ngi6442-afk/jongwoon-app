// 번호판 검출 게이트(v371, 차량 검출기 + 조각 확대 + 자기검증) — 표본 26장 실사진에 _lib/platedet.js를 돌려 픽스처(tools/platedet_fixture.json)와 대조.
//   사진은 번호판·얼굴이 있어 git에 넣지 않는다 — 폴더를 PLATEDET_PHOTOS 환경변수(또는 인자)로. 없으면 종료 코드 2(건너뜀 — 게이트는 로컬에서만 성립).
//   두 모드:
//     · 기본(오프라인, 외부 호출 없음): 단계 ①만 — 픽스처의 번호판 중심이 검출 차량 상자(여백 CROP_PAD 포함) 안에 있는지 → 놓침 0이 통과.
//     · GW_ANTHROPIC_KEY 가 있으면 전체(②③ 포함, 실제 Claude 호출·비용 발생): 픽스처 번호판 중심이 최종 상자 안에 있는지 → 놓침 0이 통과, 오검출은 보고.
//   실행: PLATEDET_PHOTOS=<폴더> node tools/platedet_check.mjs [--full]
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = require(join(ROOT, 'netlify', 'functions', '_lib', 'platedet.js'));
const M = require(join(ROOT, 'netlify', 'functions', '_lib', 'promomask.js'));
const fx = JSON.parse(fs.readFileSync(join(ROOT, 'tools', 'platedet_fixture.json'), 'utf8'));
const dir = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : (process.env.PLATEDET_PHOTOS || '');
const full = process.argv.includes('--full') && !!process.env.GW_ANTHROPIC_KEY;
if (!dir || !fs.existsSync(dir)) { console.log('platedet_check: 사진 폴더 없음(PLATEDET_PHOTOS) — 건너뜀'); process.exit(2); }

const inside = (c, b) => c[0] >= b.x && c[0] <= b.x + b.w && c[1] >= b.y && c[1] <= b.y + b.h;
const center = (g) => [g[0] + g[2] / 2, g[1] + g[3] / 2];
let miss = 0, need = 0, extra = 0, hardHit = 0, hardN = 0, n = 0, tms = 0, calls = 0, vehMiss = 0;
const { Jimp } = require('jimp');
for (const p of fx.photos) {
  const file = join(dir, p.id + '.jpg');
  if (!fs.existsSync(file)) { console.log('  ? ' + p.id + ' 사진 없음 — 건너뜀'); continue; }
  const buf = fs.readFileSync(file);
  let boxes, vehicles, ms, c = 0, diag = '';
  if (full) {
    const key = process.env.GW_ANTHROPIC_KEY;
    const vision = {
      plates: (b64) => M.detectPlatesInCrop(key, 'image/jpeg', b64),
      verify: (b64) => M.verifyPlate(key, 'image/jpeg', b64),
      whole: async () => M.detectBoxes(key, 'image/jpeg', buf.toString('base64')),
    };
    const r = await P.detectPlates(buf, vision);
    boxes = r.boxes; vehicles = r.vehicles; ms = r.ms; c = r.calls; calls += c; diag = JSON.stringify(r.diag);
  } else {
    const img = await Jimp.read(buf);
    const r = await P.detectVehicles(img);
    vehicles = r.boxes; ms = r.ms;
    boxes = vehicles.map((v) => { const W = img.bitmap.width, H = img.bitmap.height; const rc = P.padRect(v, W, H, P.CROP_PAD, P.CROP_PAD_BOTTOM); return { x: rc.x / W, y: rc.y / H, w: rc.w / W, h: rc.h / H, cls: v.cls, score: v.score, votes: v.votes }; });
    diag = 'veh ' + vehicles.length;
  }
  n++; tms += ms;
  const hit = boxes.map(() => 0); const missed = [];
  for (const g of (p.plates || [])) { need++; const cc = center(g); let ok = false; boxes.forEach((b, i) => { if (inside(cc, b)) { hit[i] = 1; ok = true; } }); if (!ok) { miss++; missed.push(cc.map((v) => v.toFixed(2)).join(',')); } }
  for (const g of (p.plates_hard || [])) { hardN++; const cc = center(g); boxes.forEach((b, i) => { if (inside(cc, b)) { hit[i] = 1; hardHit++; } }); }
  const ex = full ? boxes.filter((b, i) => !hit[i]).length : 0; extra += ex;
  if (!full && (p.vehicles || 0) > 0 && vehicles.length === 0) vehMiss++;
  const tag = (missed.length) ? '  ✗ ' : '  ✓ ';
  console.log(tag + p.id.slice(0, 14) + ' ' + String(ms).padStart(5) + 'ms 번호판 ' + (p.plates || []).length + (p.plates_hard ? '+' + p.plates_hard.length : '') + ' / ' + (full ? '상자 ' + boxes.length + ' 호출 ' + c : '차량 ' + vehicles.length) + (missed.length ? ' 놓침 [' + missed.join(' ') + ']' : '') + (ex ? ' 여분 ' + ex : '') + ' · ' + diag);
}
console.log((full ? '[전체]' : '[차량 단계만]') + ' 사진 ' + n + ' · 번호판 ' + need + ' 중 놓침 ' + miss + ' · 어려운 것 ' + hardHit + '/' + hardN + (full ? ' · 여분 ' + extra + ' · 호출 ' + calls : ' · 차량 있는데 0대 ' + vehMiss) + ' · 평균 ' + (n ? Math.round(tms / n) : 0) + 'ms');
process.exit(miss === 0 ? 0 : 1);
