// 얼굴·머리 검출기 게이트(v364, MoveNet 다중 배율 투표) — 표본 13장 실사진에 _lib/facedet.js를 돌려 픽스처(tools/facedet_fixture.json)와 대조.
//   통과: 픽스처의 얼굴·머리 중심이 전부 검출 상자 안 + 사진 전체 오검출(중심을 하나도 안 품는 상자) ≤ max_extra.
//   사진은 얼굴이 있어 git에 넣지 않는다 — 폴더를 FACEDET_PHOTOS 환경변수(또는 인자)로. 없으면 종료 코드 2(건너뜀 — 게이트는 로컬에서만 성립).
//   실행: FACEDET_PHOTOS=<폴더> node tools/facedet_check.mjs   (배포 전 필수 — 넘지 못하면 배포 불가, 브리핑 §2)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = require(join(ROOT, 'netlify', 'functions', '_lib', 'facedet.js'));
const fx = JSON.parse(fs.readFileSync(join(ROOT, 'tools', 'facedet_fixture.json'), 'utf8'));
const dir = process.argv[2] || process.env.FACEDET_PHOTOS || '';
if (!dir || !fs.existsSync(dir)) { console.log('facedet_check: 사진 폴더 없음(FACEDET_PHOTOS) — 건너뜀'); process.exit(2); }
if (!F.modelRoot()) { console.log('facedet_check: 모델 폴더 없음(netlify/functions/_models)'); process.exit(1); }

const R = (v) => Math.round(v);
let miss = 0, extra = 0, need = 0, tms = 0, n = 0;
for (const p of fx.photos) {
  const file = join(dir, p.id + '.jpg');
  if (!fs.existsSync(file)) { console.log('  ? ' + p.id + ' 사진 없음 — 건너뜀'); continue; }
  const r = await F.detectFaces(fs.readFileSync(file));
  n++; tms += r.ms;
  const px = r.boxes.map((b) => ({ x: b.x * r.w, y: b.y * r.h, w: b.w * r.w, h: b.h * r.h, src: b.src, why: b.why, score: b.score }));
  const hit = px.map(() => 0);
  const missed = [], hardHit = [];
  for (const c of p.faces) {
    need++;
    let ok = false;
    px.forEach((b, i) => { if (c[0] >= b.x && c[0] <= b.x + b.w && c[1] >= b.y && c[1] <= b.y + b.h) { hit[i] = 1; ok = true; } });
    if (!ok) { miss++; missed.push(c.join(',')); }
  }
  for (const c of (p.faces_hard || [])) {   // 어려운 얼굴: 잡히면 오검출 아님(보고만), 못 잡아도 실패 아님
    px.forEach((b, i) => { if (c[0] >= b.x && c[0] <= b.x + b.w && c[1] >= b.y && c[1] <= b.y + b.h) { hit[i] = 1; hardHit.push(c.join(',')); } });
  }
  const ex = px.filter((b, i) => !hit[i]);
  extra += ex.length;
  const tag = (missed.length || ex.length) ? '  ✗ ' : '  ✓ ';
  console.log(tag + p.id.slice(0, 14) + ' ' + String(r.ms).padStart(5) + 'ms 얼굴 ' + p.faces.length + '/검출 ' + px.length + (missed.length ? ' 놓침 [' + missed.join(' ') + ']' : '') + (hardHit.length ? ' 어려운 얼굴도 검출 [' + hardHit.join(' ') + ']' : '') + (ex.length ? ' 오검출 ' + ex.map((b) => b.src + '@' + R(b.x) + ',' + R(b.y) + ' ' + R(b.w) + 'x' + R(b.h)).join(' ') : '') + '  · ' + JSON.stringify(r.diag));
}
const ok = miss === 0 && extra <= (fx.max_extra || 0) && n > 0;
console.log((ok ? '\n얼굴 검출 게이트 통과' : '\n얼굴 검출 게이트 실패') + ' — 얼굴 ' + (need - miss) + '/' + need + ' 검출, 오검출 ' + extra + '(허용 ' + fx.max_extra + '), ' + n + '장 평균 ' + (n ? R(tms / n) : 0) + 'ms');
process.exit(ok ? 0 : 1);
