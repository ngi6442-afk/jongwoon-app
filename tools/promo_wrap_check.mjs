// 블로그 복사 HTML 줄나눔 회귀 게이트(v363) — index.html의 줄나눔 함수(// @promo-wrap-start ~ // @promo-wrap-end)를 그대로 떼어 실행해
//   직원이 실제로 끊은 줄(tools/promo_wrap_fixture.json, 9/11 수정본 2편)과 줄 단위로 대조한다. 일치율이 픽스처 min_match 아래면 실패.
//   실행: node tools/promo_wrap_check.mjs   (배포 전 필수 — 규칙을 손대면 여기 숫자가 먼저 움직여야 한다)
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const idx = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
const fx = JSON.parse(fs.readFileSync(join(ROOT, 'tools', 'promo_wrap_fixture.json'), 'utf8'));
const m = idx.match(/\/\/ @promo-wrap-start([\s\S]*?)\/\/ @promo-wrap-end/);
if (!m) { console.log('promo_wrap_check: index.html에 // @promo-wrap-start ~ end 구간이 없다'); process.exit(1); }
const W = new Function(m[1] + '\nreturn { promoWrapSense: promoWrapSense, promoSplitSentences: promoSplitSentences, promoLinesOf: promoLinesOf, PROMO_WRAP_LO: PROMO_WRAP_LO, PROMO_WRAP_HI: PROMO_WRAP_HI };')();

// 픽스처 본문(마커 포함) → 직원 줄과 비교할 우리 줄. 마커 줄은 캡션만, 고정문은 뺀다(픽스처와 같은 규칙).
function oursOf(sample) {
  const FIXED = sample.fixed_excluded || [];
  const out = [];
  String(sample.body).split('\n').forEach((ln) => {
    ln = ln.trim(); if (!ln) return;
    const mm = ln.match(/^\[?사진\s*[\d,\s~\-·]+\]?\s*[:：]?\s*(.*)$/);
    if (mm && (ln.charAt(0) === '[' || ln.indexOf('사진') === 0)) { const cap = mm[1].trim().replace(/\]$/, '').trim(); if (cap) out.push(cap); return; }
    ln = ln.replace(/\[사진[^\]]*\]/g, '').trim();
    if (!ln || FIXED.some((x) => ln.indexOf(x) >= 0)) return;
    W.promoLinesOf(ln).forEach((l) => out.push(l));
  });
  return out;
}
function lcs(a, b) {
  const n = a.length, mm = b.length; const dp = []; for (let i = 0; i <= n; i++) dp.push(new Array(mm + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= mm; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[n][mm];
}
let ok = true;
console.log('줄나눔 창 ' + W.PROMO_WRAP_LO + '~' + W.PROMO_WRAP_HI + '자');
for (const s of fx.samples) {
  const ours = oursOf(s);
  const same = lcs(s.staff_lines, ours);
  const rate = same / s.staff_lines.length;
  const min = (fx.min_match || {})[s.id] || 0;
  const pass = rate >= min;
  ok = ok && pass;
  const lens = ours.map((l) => l.length).sort((a, b) => a - b);
  console.log((pass ? '  ✓ ' : '  ✗ ') + s.id + ' ' + s.note + ' — 직원 ' + s.staff_lines.length + '줄 / 우리 ' + ours.length + '줄 · 일치 ' + same + ' (' + Math.round(rate * 100) + '%, 기준 ' + Math.round(min * 100) + '%) · 우리 줄 길이 중앙값 ' + (lens[lens.length >> 1] || 0) + ' 최대 ' + (lens[lens.length - 1] || 0));
  // 낱말 보존: 우리 줄을 합친 낱말 집합이 본문 낱말을 전부 품는다(줄나눔이 글자를 먹지 않는다)
  const bodyWords = new Set(String(s.body).replace(/\[사진[^\]]*\]|사진\s*\d+\s*[:：]/g, ' ').split(/\s+/).filter((w) => w && !s.fixed_excluded.some((x) => w.indexOf(x) >= 0)));
  const ourWords = new Set(ours.join(' ').split(/\s+/).filter(Boolean));
  const lost = [...bodyWords].filter((w) => !ourWords.has(w) && !/^\[|사진/.test(w));
  const lostReal = lost.filter((w) => !s.fixed_excluded.some((x) => String(s.body).split('\n').some((ln) => ln.indexOf(x) >= 0 && ln.indexOf(w) >= 0)));
  if (lostReal.length) { ok = false; console.log('    ✗ 사라진 낱말 ' + lostReal.length + ': ' + lostReal.slice(0, 8).join(' ')); }
}
console.log(ok ? '\n줄나눔 게이트 통과' : '\n줄나눔 게이트 실패');
process.exit(ok ? 0 : 1);
