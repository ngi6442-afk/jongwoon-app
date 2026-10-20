// 블로그 복사 출력 회귀 게이트(v394) — index.html의 // @promo-post-start ~ // @promo-post-end 구간(마커 파서·고정 머리/꼬리·줄나눔·promoBuildPostHtml)을 그대로 떼어 node에서 돌린다.
//   검사: ① 프로필 없음 = 예전 출력(서명 3줄·구분선 0·굵게 0) ② 프로필 ok = 직원이 손으로 하던 포장 5가지 자동 적용(서명 삭제·인사말 줄별 굵게·소제목 굵게·소제목 앞 구분선·문단 경계 빈 줄)
//   ③ 비율이 문턱 아래면 적용 안 함 ④ 어느 경우에도 문장 낱말은 하나도 안 사라진다(마커 제외). 실행: node tools/promo_post_check.mjs
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const idx = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
const m = idx.match(/\/\/ @promo-post-start([\s\S]*?)\/\/ @promo-post-end/);
if (!m) { console.log('promo_post_check: index.html에 // @promo-post-start ~ end 구간이 없다'); process.exit(1); }
const W = new Function('document', m[1] + '\nreturn { promoBuildPostHtml: promoBuildPostHtml, PROMO_HEAD_SIG: PROMO_HEAD_SIG, PROMO_GREET: PROMO_GREET, PROMO_BLANK: PROMO_BLANK, PROMO_HR: PROMO_HR };')({ getElementById: function () { return null; } });

const body = ['포항 장량동 상가에서 배수구 냄새가 심해졌다는 연락을 받았습니다. 뚜껑만 열어 냄새를 빼면 되지 않느냐고 물으십니다.', '',
  '왜 막히나요?', '', '상가 하수구는 기름과 음식물이 굳어서 막힙니다. 배관 안쪽에 층이 쌓이면 물길이 좁아집니다.', '', '[사진 1 : 작업 전 입구]', '',
  '어떻게 뚫나요?', '', '고압 세척으로 굳은 층을 벗겨 내고 흡입차로 걷어 냅니다. 작업 뒤에는 물을 흘려 확인합니다.', '[사진 2 : 작업 후]'].join('\n');
const imgs = [{ url: 'https://x/1.jpg', name: 'a' }, { url: 'https://x/2.jpg', name: 'b' }];
const tags = ['포항하수구준설', '상가하수구'];
const PROF = { ok: true, n_posts: 9, sig_kept_ratio: 0, greet_bold: { '(주)종운환경 입니다.': 1, '포항 및 대구·경북 지역에서': 0.8, '하수관로 준설, 맨홀 준설, 집수정 준설,': 0.17 }, head_bold_ratio: 0.98, head_hr_ratio: 0.75, head_blank_ratio: 0.11, blank_per_para: 0.26 };
const WEAK = { ok: true, n_posts: 9, sig_kept_ratio: 1, greet_bold: {}, head_bold_ratio: 0.2, head_hr_ratio: 0.2, head_blank_ratio: 0.1, blank_per_para: 0.05 };
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/&amp;/g, '&').replace(/\s+/g, '');
const count = (h, s) => h.split(s).length - 1;
let fails = 0;
const T = (name, ok, detail) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + String(detail).slice(0, 220))); if (!ok) fails++; };

const A = W.promoBuildPostHtml('제목', body, imgs, tags, null);
const B = W.promoBuildPostHtml('제목', body, imgs, tags, PROF);
const C = W.promoBuildPostHtml('제목', body, imgs, tags, WEAK);
const words = body.replace(/\[사진[^\]]*\]/g, '').split(/\s+/).filter(Boolean);
const lost = (h) => words.filter((w) => text(h).indexOf(w.replace(/\s+/g, '')) < 0);

T('① 프로필 없음 = 예전 출력: 서명 3줄 있음 · 구분선 0 · <b> 0 · 소제목 앞 빈 줄', A.indexOf(W.PROMO_HEAD_SIG[0]) > 0 && count(A, W.PROMO_HR) === 0 && count(A, '<b>') === 0 && A.indexOf(W.PROMO_BLANK + '<p style="margin:0;line-height:1.8;text-align:center;">왜 막히나요?') > 0, A.slice(0, 300));
T('② 프로필 ok: 서명 3줄 삭제 · 인사말 "(주)종운환경 입니다."·"포항 및 대구·경북 지역에서" 굵게, "안녕하세요."·"하수관로 준설…"은 안 굵게',
  B.indexOf(W.PROMO_HEAD_SIG[0]) < 0 && B.indexOf('<b>(주)종운환경 입니다.</b>') > 0 && B.indexOf('<b>포항 및 대구·경북 지역에서</b>') > 0 && B.indexOf('<b>안녕하세요.</b>') < 0 && B.indexOf('<b>하수관로 준설, 맨홀 준설, 집수정 준설,</b>') < 0, B.slice(0, 600));
T('② 소제목 2개: 앞에 빈 줄+구분선, 굵게', count(B, W.PROMO_HR) === 2 && B.indexOf(W.PROMO_BLANK + W.PROMO_HR + '<p style="margin:0;line-height:1.8;text-align:center;"><b>왜 막히나요?</b></p>') > 0 && B.indexOf(W.PROMO_HR + '<p style="margin:0;line-height:1.8;text-align:center;"><b>어떻게 뚫나요?</b></p>') > 0, B);
T('② 문단 경계 빈 줄: 프로필 적용본의 빈 줄이 예전보다 많다(문단 사이 빈 줄 복원) · 연달아 두 개 없음', count(B, W.PROMO_BLANK) > count(A, W.PROMO_BLANK) && B.indexOf(W.PROMO_BLANK + W.PROMO_BLANK) < 0, 'A ' + count(A, W.PROMO_BLANK) + ' B ' + count(B, W.PROMO_BLANK));
T('② 사진 2장·태그·꼬리는 그대로', count(B, '<img ') === 2 && B.indexOf('#포항하수구준설 #상가하수구') > 0 && B.indexOf('(주)종운환경</p>') > 0, '');
T('③ 비율이 문턱 아래(WEAK): 서명 유지 · 구분선 0 · 소제목 굵게 없음 · 빈 줄 수 = 예전', C.indexOf(W.PROMO_HEAD_SIG[0]) > 0 && count(C, W.PROMO_HR) === 0 && count(C, '<b>') === 0 && count(C, W.PROMO_BLANK) === count(A, W.PROMO_BLANK), 'C ' + count(C, W.PROMO_BLANK) + ' A ' + count(A, W.PROMO_BLANK));
T('④ 낱말 보존: 세 출력 모두 본문 낱말 손실 0', lost(A).length === 0 && lost(B).length === 0 && lost(C).length === 0, JSON.stringify([lost(A), lost(B), lost(C)]).slice(0, 200));
console.log(fails ? '복사 출력 게이트 실패 ' + fails + '건' : '복사 출력 게이트 통과');
process.exit(fails ? 1 : 0);
