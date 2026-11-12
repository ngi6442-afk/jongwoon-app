// 블로그 품질 고리 1단계(측정만) 게이트 — 체크 10 '블로그 완성도' · PM 11/10 17:40 '10. ㄱ'(원장 C058). 근거 work/09_조사_문서/10_블로그완성도_자료_20261110/03_학습설계안 §4·§7.
//   ① 채점기 = 10번 자료 파이썬 판(analyze.py·trial_score.py)과 같은 값 — 표본 6편(fixture)의 16항목·10점·지표 27종(102편 전수 대조는 11/10 로컬 1회, 불일치 0)
//   ② 앱 복사 포장 재현: _lib/promoqual.js planFromBody = index.html @promo-post 구간(promoBuildPostHtml → 줄 계획)과 글자·표식째 같음(두 벌 — 한쪽만 고치면 여기서 터진다)
//   ③ 결함 잡기(마크다운 ** · 게시월과 다른 계절 · 사진 묶음 · 고정 키워드 제목)
//   ④ 크론 ⑤ sweep: 저장(앱 출력·초안·이력) · 같은 상태 재실행은 쓰기 0 · 바뀐 기록만 · 다음 날 전부 · 판 바뀜 전부 · 지운 기록 정리 · 읽기 실패면 쓰지 않음
//   ⑤ pl_get quality(관리자만 — 비관리자 403 그대로) · 블롭 없으면 rows 0 · summary 최근 게시 평균·본보기 값
//   ⑥ 출력 무변: 생성 라이브러리·생성 워커·학습 워커·복사 출력 구간은 promoqual을 부르지 않는다 · 크론·pl_get은 try 안에서 늦게 부른다 · 카드 표시 배선
// 실행: node tools/promoqual_check.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'netlify', 'functions');
process.env.GW_SESSION_SECRET = 'promoqual-check-secret';

// ---- 인메모리 Blobs·감사 mock(servertest와 같은 꼴) ----
const mem = {};
const hooks = { failGet: null, sets: 0 };
const blobsMock = {
  setupBlobContext() {},
  store(n) { mem[n] = mem[n] || {}; return n; },
  async blobGet(st, k) { if (hooks.failGet && hooks.failGet(k)) return { ok: false, code: 'STORAGE_READ_FAILED' }; const s = mem[st] || {}; return (k in s) ? { ok: true, data: JSON.parse(JSON.stringify(s[k])) } : { ok: false, code: 'NOT_FOUND' }; },
  async blobSet(st, k, v) { hooks.sets++; mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobDelete(st, k) { if (mem[st]) delete mem[st][k]; return { ok: true }; },
  async blobList(st, pre) { return { ok: true, keys: Object.keys(mem[st] || {}).filter((k) => !pre || k.indexOf(pre) === 0) }; },
};
const auditMock = { logs: [], async appendAudit(e) { auditMock.logs.push(e); }, auditKey: () => 'audit', diffItems: () => [], short: (s) => String(s).slice(0, 20), DATA: 'gw_data' };
for (const [p, m] of [['_lib/blobs.js', blobsMock], ['_lib/audit.js', auditMock]]) {
  const rp = require.resolve(join(FN, p));
  require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: m };
}
const PQ = require(join(FN, '_lib/promoqual.js'));
const PL = require(join(FN, '_lib/promolearn.js'));
const fx = JSON.parse(fs.readFileSync(join(ROOT, 'tools', 'promoqual_fixture.json'), 'utf8'));
const idx = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
let fails = 0, pass = 0;
const T = (name, ok, detail) => { if (ok) pass++; else fails++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + String(detail).slice(0, 400))); };

// ① 파이썬 판과 같은 값(표본 6편)
{
  const KEYS = Object.keys(fx.posts[0].expect.m).filter((k) => k !== 'max_sim_same_group');
  for (const p of fx.posts) {
    const r = PQ.scoreSeq(p.title, p.seq, p.date, p.expect.m.max_sim_same_group);
    const dItems = Object.keys(p.expect.items).filter((k) => p.expect.items[k] !== r.items[k]);
    const dM = KEYS.filter((k) => JSON.stringify(p.expect.m[k]) !== JSON.stringify(r.m[k]));
    T('① ' + p.date + ' ' + p.group + ' — 16항목·10점(' + p.expect.score10 + ')·축·지표 ' + KEYS.length + '종 파이썬 값과 같음',
      !dItems.length && r.score10 === p.expect.score10 && JSON.stringify(r.axis) === JSON.stringify(p.expect.axis) && !dM.length,
      JSON.stringify({ items: dItems.map((k) => k + ' py' + p.expect.items[k] + ' js' + r.items[k]), score: [p.expect.score10, r.score10], m: dM.map((k) => k + ' py' + JSON.stringify(p.expect.m[k]) + ' js' + JSON.stringify(r.m[k])) }));
  }
  // 겹침(X5)은 102편 묶음이 있어야 같은 값 — 표본끼리는 정의만 본다: 같은 글 1, 남남 0, 공백 무시 8글자 조각
  const a = PQ.shingles('가나다라마바사아자차'), b = PQ.shingles('가나다라 마바사아 자차'), c = PQ.shingles('카타파하카타파하카타');
  T('① 겹침 정의: 공백 뺀 8글자 조각 자카드(같은 글 1 · 공백만 달라도 1 · 남남 0)', PQ.jaccard(a, a) === 1 && PQ.jaccard(a, b) === 1 && PQ.jaccard(a, c) === 0 && a.size === 3);
  T('① 파이썬 반올림(딱 반이면 짝수 쪽 · 정확한 10진값 기준)', PQ.pyRound(0.125, 2) === 0.12 && PQ.pyRound(0.375, 2) === 0.38 && PQ.pyRound(0.345, 2) === 0.34 && PQ.pyRound(2.5, 0) === 2 && PQ.pyRound(3.5, 0) === 4 && PQ.pyRound(149.5, 0) === 150 && PQ.pyRound(0.30000000000000004, 1) === 0.3,
    JSON.stringify([PQ.pyRound(0.125, 2), PQ.pyRound(0.375, 2), PQ.pyRound(0.345, 2), PQ.pyRound(2.5, 0), PQ.pyRound(3.5, 0)]));
}

// ② 앱 복사 포장 재현 = index.html promoBuildPostHtml → 줄 계획
{
  const m = idx.match(/\/\/ @promo-post-start([\s\S]*?)\/\/ @promo-post-end/);
  T('② index.html @promo-post 구간 있음', !!m);
  const W = m ? new Function('document', m[1] + '\nreturn { promoBuildPostHtml: promoBuildPostHtml };')({ getElementById() { return null; } }) : null;
  // promoPlanOfHtml(DOMParser)와 같은 규칙 — 이 출력이 쓰는 꼴(h2·p·hr)만: h2 건너뜀 · hr → ['','h'] · jw-nocopy 건너뜀 · img → ['','i'] · 글은 태그 벗기고 공백 하나로 · c 가운데 · b 굵게
  const planOfHtml = (html) => {
    const plan = []; const re = /<h2\b[^>]*>[\s\S]*?<\/h2>|<hr>|<p\b([^>]*)>([\s\S]*?)<\/p>/g; let x;
    while ((x = re.exec(html)) && plan.length < 600) {
      if (x[0].indexOf('<h2') === 0) continue;
      if (x[0] === '<hr>') { plan.push(['', 'h']); continue; }
      const attrs = x[1] || '', inner = x[2] || '';
      if (/class="[^"]*jw-nocopy/.test(attrs)) continue;
      if (/<img\b/.test(inner)) { plan.push(['', 'i']); continue; }
      const st = (attrs.match(/style="([^"]*)"/) || ['', ''])[1];
      const t = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      const f = (/text-align:\s*center/.test(st) ? 'c' : '') + ((/<(b|strong)\b/.test(inner) || /font-weight:\s*(700|bold)/.test(st)) ? 'b' : '');
      plan.push([t.slice(0, 200), t ? f : '']);
    }
    return plan;
  };
  const syn = [
    { id: 'syn-env', title: '합성 — 마커 꼴 전부', n_img: 6, tags: ['포항', '#준설', '상가 하수구'], body: ['첫 문단입니다. 두 번째 문장은 쉼표가 있고, 조금 더 길게 이어서 써 보는 문장입니다 그리고 더 길게 이어집니다.', '', '[사진 1 : 입구] 사진 뒤에 바로 이어진 문장입니다.', '사진 2,3 : 캡션입니다. 캡션 뒤에 붙은 본문 문장입니다.', '왜 이렇게 될까요?', '[사진 3·4 : 중복] [사진 9 : 범위 밖]', '- **굵게** 목록 한 줄', '', '', '마지막 문단입니다. 여기는 & 기호와 <꺾쇠>도 있습니다.'].join('\n') },
    { id: 'syn-con', title: '합성 — 석면 글(건설 머리·꼬리)', n_img: 3, tags: [], body: '석면 슬레이트 해체 현장입니다.\n[사진 1~2 : 습윤]\n작업 전 출입을 막았습니까?\n비산을 막으려고 습윤제를 뿌렸습니다.\n사진 3 : 포장' },
  ];
  const cases = fx.pack.cases.concat(syn);
  for (const c of cases) {
    for (const [lbl, prof] of [['프로필', fx.pack.prof], ['프로필 없음', null]]) {
      const imgs = Array.from({ length: c.n_img }, (_, i) => ({ url: 'https://x/' + i + '.jpg', name: 'p' + i }));
      const want = W ? planOfHtml(W.promoBuildPostHtml(c.title, c.body, imgs, c.tags, prof)) : [];
      const got = PQ.planFromBody(c.body, c.n_img, prof, c.tags).map((e) => [e[0], e[1]]);
      let at = -1; for (let i = 0; i < Math.max(want.length, got.length); i++) { if (JSON.stringify(want[i]) !== JSON.stringify(got[i])) { at = i; break; } }
      T('② 포장 재현 ' + c.id + ' · ' + lbl + ' — 줄 ' + want.length + '개 글자·표식째 같음', want.length > 5 && at < 0, at < 0 ? '' : '첫 차이 ' + at + ': 앱 ' + JSON.stringify(want[at]) + ' / 재현 ' + JSON.stringify(got[at]));
    }
  }
  const pf = PQ.planFromBody(syn[0].body, 6, fx.pack.prof, []);
  // 마커 1 · 2,3 · 3·4(3은 앱처럼 한 번 더) · 9(사진 6장이라 없음) → 5장 + 안 쓰인 5·6이 마지막 사진 묶음 바로 뒤 = 사진 7칸, 소제목 1
  const kinds = pf.filter((e) => e[2] === 's' || e[1] === 'i').map((e) => (e[2] === 's' ? 'S' : 'i')).join('');
  T('② 소제목은 종류 s(채점에서 소제목) · 같은 번호 두 번이면 두 번(앱과 같음) · 안 쓰인 사진 5·6은 마지막 사진 묶음 뒤에 이어 붙음', kinds === 'iiiSiiii', kinds);
}

// ③ 결함 잡기
{
  const prof = fx.pack.prof;
  const base = ['상가 앞 맨홀을 열어 퇴적물을 확인했습니다. 고압세척으로 관 벽을 씻어 냈습니다.', '', '왜 막혔을까요?', '', '기름이 굳어 관이 좁아졌기 때문입니다.'].join('\n');
  const q1 = PQ.finish(PQ.measureText('포항 상가 하수구 준설 현장에서 확인한 막힘 원인', base, 0, [], prof, '2026-11-02'), '포항 상가 하수구 준설 현장에서 확인한 막힘 원인', 0);
  const q2 = PQ.finish(PQ.measureText('봄비 시작 전에 점검해야 할 하수관로 — 포항 현장 기록', base + '\n- **영업 중단** 문장', 0, [], prof, '2026-11-02'), '봄비 시작 전에 점검해야 할 하수관로 — 포항 현장 기록', 0);
  T('③ C3 결함: 마크다운 ** 노출 + 11월 글 제목 봄비 → 0점(깨끗한 글은 2점)', q1.items.C3 === 2 && q2.items.C3 === 0 && q2.m.md_left > 0 && q2.m.title_season_off.join() === '봄', JSON.stringify([q1.items.C3, q2.items.C3, q2.m.md_left, q2.m.title_season_off]));
  const burst = PQ.finish(PQ.measureText('사진 묶음 시험 글 제목입니다 스무 자 넘게', '첫 문장입니다.\n[사진 1~12 : 작업 전후]\n끝 문장입니다.', 12, [], prof, '2026-11-02'), 't', 0);
  T('③ C1 사진 묶음: 글 없이 이어진 12장 → 0점 · 사진 수 12', burst.items.C1 === 0 && burst.m.img_burst === 12 && burst.m.n_img === 12, JSON.stringify(burst.m));
  const fixedT = PQ.scoreOf(Object.assign({}, q1.m, { _title: '포항시 준설 포항시 하수구 준설 전문업체' }));
  T('③ C4 제목: 고정 키워드 나열("포항시 준설 포항시 …") → 0점', fixedT.items.C4 === 0 && q1.items.C4 === 2);
  T('③ 지도 가정: 앱 출력은 has_map 1(게시 때 붙음 — 앱 글 13/13편)', q1.m.has_map === 1);
}

// ④ 크론 ⑤ sweep
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 10, 9, 0, 0);   // 2026-11-10 18:00 KST
const recA = { id: 'qa1', title: '맨홀 뚜껑 둘레로 하얗게 굳은 침전물, 포항 두호동 상가하수구에서 본 것', body: fx.pack.cases[1].body, status: 'posted', posted_at: '2026-10-23', photos: Array.from({ length: 6 }, (_, i) => ({ id: 'att_' + String(i).padStart(16, '0') })), tags: ['포항', '두호동'], ai: { ts: 5, model: 'm' }, ai_st: { st: 'done' }, ts: 100, updated_ts: 100 };
const recB = { id: 'qb2', title: fx.pack.cases[0].title, body: fx.pack.cases[0].body, status: 'posted', posted_at: '2026-11-02', photos: Array.from({ length: 9 }, (_, i) => ({ id: 'att_1' + String(i).padStart(15, '0') })), tags: [], ai_st: { st: 'fail', code: 'BAD_REQUEST', tries: 4 }, ts: 200, updated_ts: 200 };
const recC = { id: 'qc3', title: '우수받이에서 냄새가 나는 이유, 포항 제내리 현장', body: fx.pack.cases[2].body, status: 'review', photos: Array.from({ length: 20 }, (_, i) => ({ id: 'att_2' + String(i).padStart(15, '0') })), tags: [], ai: { ts: 7 }, ai_st: { st: 'done' }, ts: 300, updated_ts: 300 };
const recD = { id: 'qd4', title: '지운 기록', body: '지운 글입니다.', status: 'review', del: 1, photos: [], ts: 50 };
const doc0 = () => ({ schema: 1, items: JSON.parse(JSON.stringify([recA, recB, recC, recD])) });
{
  mem.gw_data = {};
  mem.gw_data['promoai:layout'] = { schema: 2, ts: 9, profile: fx.pack.prof };
  mem.gw_data['promoai:draft:qc3'] = { schema: 1, items: [{ job: 'pa_gen_q1', title: recC.title, body: fx.pack.cases[2].body.slice(0, 1500), ts: NOW - 2 * DAY }, { job: 'pa_gen_q2', title: recC.title, body: fx.pack.cases[2].body, ts: NOW - DAY }] };
  const r1 = await PQ.sweep('gw_data', doc0(), NOW);
  const Q1 = mem.gw_data[PQ.QUAL_KEY];
  T('④ 첫 회차: 살아 있는 기록 3건 채점(지운 기록 제외) · 초안 2건 이력 · 전부(full) · 판·본보기 판 기록', r1.scored === 3 && r1.drafts === 2 && r1.full === true && Q1 && Object.keys(Q1.recs).sort().join() === 'qa1,qb2,qc3' && Q1.hist.length === 2 && Q1.ver === PQ.QUAL_VER && Q1.ex_ver === PQ.EX.ver && Q1.sweep.day === '2026-11-10', JSON.stringify(r1));
  const a = Q1.recs.qa1, b = Q1.recs.qb2, c = Q1.recs.qc3;
  T('④ 본문 출처: 사진AI · 템플릿(사진AI 실패) · 게시일 = posted_at, 게시 전 = 잰 날', a.kind === 'ai' && b.kind === 'tpl_fail' && c.kind === 'ai' && a.date === '2026-10-23' && b.date === '2026-11-02' && c.date === '2026-11-10', JSON.stringify([a.kind, b.kind, c.kind, a.date, b.date, c.date]));
  {
    const dd = { schema: 1, items: [{ id: 'qe5', title: '옛 게시 기록 — 게시일 칸 없음', body: '본문입니다.', status: 'posted', updated: '2026-08-25', photos: [], ts: 1 }, { id: 'qf6', title: '날짜 칸 전부 없음', body: '본문입니다.', status: 'posted', photos: [], ts: Date.UTC(2026, 7, 19, 3) }] };
    const keep = mem.gw_data[PQ.QUAL_KEY]; delete mem.gw_data[PQ.QUAL_KEY];
    await PQ.sweep('gw_data', dd, NOW);
    const qq = mem.gw_data[PQ.QUAL_KEY].recs;
    T('④ 옛 게시 기록 날짜: posted_at 없으면 updated → 기록 생성일(KST) — 오늘로 잡지 않음(계절 판정·최근 순)', qq.qe5.date === '2026-08-25' && qq.qf6.date === '2026-08-19', JSON.stringify([qq.qe5.date, qq.qf6.date]));
    mem.gw_data[PQ.QUAL_KEY] = keep;
  }
  // 저장값 = 같은 재료를 직접 잰 값(앱 출력 — X5는 같은 회사 다른 기록과 겹침)
  const prof = fx.pack.prof;
  const mA = PQ.measureText(recA.title, recA.body, 6, recA.tags, prof, '2026-10-23'), mB = PQ.measureText(recB.title, recB.body, 9, recB.tags, prof, '2026-11-02'), mC = PQ.measureText(recC.title, recC.body, 20, recC.tags, prof, '2026-11-10');
  const sA = PQ.shingles(mA.text), sB = PQ.shingles(mB.text), sC = PQ.shingles(mC.text);
  const dA = PQ.finish(mA, recA.title, Math.max(PQ.jaccard(sA, sB), PQ.jaccard(sA, sC)));
  T('④ 저장 점수 = 직접 잰 값(16항목·10점·약한 항목·지표)', a.out.score10 === dA.score10 && JSON.stringify(a.out.items) === JSON.stringify(dA.items) && JSON.stringify(a.out.weak) === JSON.stringify(dA.weak) && a.out.m.site_ratio === dA.m.site_ratio && a.out.m.max_sim === dA.m.max_sim, JSON.stringify([a.out.score10, dA.score10]));
  T('④ 템플릿 글(마크다운 **) → C3 감점이 저장됨 · 초안 최신(pa_gen_q2)이 기록 초안 칸', b.out.items.C3 < 2 && b.out.m.md_left > 0 && c.draft && c.draft.job === 'pa_gen_q2' && typeof c.draft.score10 === 'number', JSON.stringify([b.out.items.C3, b.out.m.md_left, c.draft && c.draft.job]));
  const sets0 = hooks.sets, upd0 = mem.gw_data[PQ.QUAL_KEY].updated_at;
  const r2 = await PQ.sweep('gw_data', doc0(), NOW + 60000);
  T('④ 같은 상태로 다시 → 쓰기 0(skipped same)', r2.skipped === 'same' && hooks.sets === sets0 && mem.gw_data[PQ.QUAL_KEY].updated_at === upd0, JSON.stringify(r2));
  const d3 = doc0(); d3.items[1].body = d3.items[1].body.replace(/\*\*/g, ''); d3.items[1].updated_ts = 999;
  const r3 = await PQ.sweep('gw_data', d3, NOW + 120000);
  const b3 = mem.gw_data[PQ.QUAL_KEY].recs.qb2;
  T('④ 기록 하나 바뀜 → 그 기록만 다시(full 아님) · 마크다운 지운 뒤 md_left 0', r3.scored === 1 && r3.full === false && b3.out.m.md_left === 0 && mem.gw_data[PQ.QUAL_KEY].recs.qa1.ts === NOW, JSON.stringify(r3));
  const r4 = await PQ.sweep('gw_data', d3, NOW + DAY);
  T('④ 다음 날 → 전부 다시(full) · 이력은 작업 단위라 늘지 않음(2)', r4.scored === 3 && r4.full === true && mem.gw_data[PQ.QUAL_KEY].hist.length === 2 && mem.gw_data[PQ.QUAL_KEY].sweep.day === '2026-11-11', JSON.stringify(r4));
  mem.gw_data[PQ.QUAL_KEY].ver = 'q0-old';
  const r5 = await PQ.sweep('gw_data', d3, NOW + DAY + 60000);
  T('④ 채점 판이 바뀌면 → 전부 다시', r5.scored === 3 && r5.full === true && mem.gw_data[PQ.QUAL_KEY].ver === PQ.QUAL_VER, JSON.stringify(r5));
  // 재생성(작업 번호 바뀜 — 본문은 그대로) → 지문이 잡아 초안을 다시 읽고 새 작업만 이력에
  const d8 = JSON.parse(JSON.stringify(d3)); d8.items[2].ai_st = { st: 'done', job: 'pa_gen_q3' };
  mem.gw_data['promoai:draft:qc3'].items.push({ job: 'pa_gen_q3', title: recC.title, body: fx.pack.cases[2].body.slice(0, 2000), ts: NOW + DAY });
  const r8 = await PQ.sweep('gw_data', d8, NOW + DAY + 90000);
  T('④ 재생성(작업 번호 바뀜, 본문 그대로) → 그 기록만 다시 · 초안 칸 = 새 작업 · 이력 +1(3)', r8.scored === 1 && r8.drafts === 1 && mem.gw_data[PQ.QUAL_KEY].recs.qc3.draft.job === 'pa_gen_q3' && mem.gw_data[PQ.QUAL_KEY].hist.length === 3, JSON.stringify(r8));
  // 초안 블롭 읽기 실패 → 앞 초안 값 유지 · 포장 프로필 읽기 실패 → 쓰지 않음
  const d9 = JSON.parse(JSON.stringify(d8)); d9.items[2].ai_st = { st: 'done', job: 'pa_gen_q4' };
  hooks.failGet = (k) => k === 'promoai:draft:qc3';
  await PQ.sweep('gw_data', d9, NOW + DAY + 100000);
  hooks.failGet = null;
  T('④ 초안 블롭 읽기 실패 → 기록 초안 칸은 앞 값 유지(빈 값으로 덮지 않음)', mem.gw_data[PQ.QUAL_KEY].recs.qc3.draft && mem.gw_data[PQ.QUAL_KEY].recs.qc3.draft.job === 'pa_gen_q3', JSON.stringify(mem.gw_data[PQ.QUAL_KEY].recs.qc3.draft && mem.gw_data[PQ.QUAL_KEY].recs.qc3.draft.job));
  const d10 = JSON.parse(JSON.stringify(d9)); d10.items[0].updated_ts = 4242;
  hooks.failGet = (k) => k === PQ.LAYOUT_KEY; const sets10 = hooks.sets;
  const r10 = await PQ.sweep('gw_data', d10, NOW + DAY + 110000);
  hooks.failGet = null;
  T('④ 포장 프로필 읽기 실패 → 재지 않고 쓰기 0(다음 회차에 다시)', /^LAYOUT_/.test(String(r10.error || '')) && hooks.sets === sets10, JSON.stringify(r10));
  await PQ.sweep('gw_data', d9, NOW + DAY + 115000);
  const d6 = JSON.parse(JSON.stringify(d9)); d6.items[2].del = 1;
  const r6 = await PQ.sweep('gw_data', d6, NOW + DAY + 120000);
  T('④ 지운 기록 → 점수 칸 정리(gone 1)', r6.gone === 1 && !mem.gw_data[PQ.QUAL_KEY].recs.qc3 && Object.keys(mem.gw_data[PQ.QUAL_KEY].recs).length === 2, JSON.stringify(r6));
  hooks.failGet = (k) => k === PQ.QUAL_KEY; const sets7 = hooks.sets;
  const r7 = await PQ.sweep('gw_data', doc0(), NOW + 3 * DAY);
  hooks.failGet = null;
  T('④ 점수 블롭 읽기 실패 → 쓰지 않고 error(빈 값으로 덮지 않음)', r7.error === 'STORAGE_READ_FAILED' && hooks.sets === sets7, JSON.stringify(r7));
  const S = PQ.summary(mem.gw_data[PQ.QUAL_KEY]);
  T('④ summary: 행 날짜 내림차순 · 최근 게시 평균(항목 합에서) · 사진AI 중앙 · 본보기 방내리 8.4·준설 상위 5편 중앙 6.6 · 약한 항목 칩에 본보기 값', S.rows.length === 2 && S.rows[0].date >= S.rows[1].date && S.recent4.n === 2 && S.recent4.avg === PQ.pyRound((S.rows[0].total + S.rows[1].total) / 2 * 10 / 32, 1) && S.top.score10 === 8.4
    && PQ.summary({ recs: { a: { date: '2026-11-02', status: 'posted', out: { score10: 3.4, total: 11 } }, b: { date: '2026-10-30', status: 'posted', out: { score10: 3.1, total: 10 } }, c: { date: '2026-10-26', status: 'posted', out: { score10: 5.9, total: 19 } }, d: { date: '2026-10-23', status: 'posted', out: { score10: 5, total: 16 } } } }).recent4.avg === 4.4 && S.dredge.score10 === 6.6 && S.rows.every((r) => r.weak.every((w) => w.ex !== undefined)) && S.items.length === 16, JSON.stringify({ r4: S.recent4, top: S.top, dr: S.dredge, w: S.rows[0].weak }));
  T('④ summary: 블롭 없으면 rows 0(카드는 "아직 잰 글이 없습니다")', PQ.summary(null).rows.length === 0 && PQ.summary(null).top.score10 === 8.4);
}

// ⑤ pl_get quality — 관리자만(비관리자 403 그대로)
{
  const { issueSession } = require(join(FN, '_lib/session.js'));
  mem.gw_users = { 'member:uadmin': { id: 'uadmin', name: '관리자', admin: true, perms: {} }, 'member:uwork': { id: 'uwork', name: '직원', admin: false, perms: { promo: 'do' } }, 'device:dev1': { status: 'approved' } };
  const tokA = issueSession(mem.gw_users['member:uadmin']).token, tokW = issueSession(mem.gw_users['member:uwork']).token;
  const pai = require(join(FN, 'gw-promo-ai.js'));
  const callP = async (body, tok, dev) => { const r = await pai.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: 'Bearer ' + tok }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
  let r = await callP({ action: 'pl_get' }, tokW, 'dev1');
  T('⑤ pl_get 비관리자 → 403(그대로)', r.code === 403);
  r = await callP({ action: 'pl_get' }, tokA);
  T('⑤ pl_get 관리자 → quality(rows·본보기·최근 평균) + 기존 lessons·layout 그대로', r.code === 200 && r.body.quality && r.body.quality.rows.length === 2 && r.body.quality.top.score10 === 8.4 && r.body.lessons && 'layout' in r.body, JSON.stringify(r.body).slice(0, 300));
  hooks.failGet = (k) => k === PQ.QUAL_KEY;
  r = await callP({ action: 'pl_get' }, tokA);
  hooks.failGet = null;
  T('⑤ 점수 블롭 읽기 실패해도 pl_get 200 · quality는 빈 요약(rows 0)', r.code === 200 && r.body.quality && r.body.quality.rows.length === 0 && r.body.lessons, JSON.stringify(r.body).slice(0, 200));
}

// ⑥ 출력 무변·배선(정적)
{
  const rd = (p) => fs.readFileSync(join(FN, p), 'utf8');
  const cron = rd('gw-promo-ai-cron.js'), api = rd('gw-promo-ai.js'), pai = rd('_lib/promoai.js'), wk = rd('gw-promo-ai-run-background.js'), lw = rd('gw-promo-learn-background.js'), job = rd('_lib/promoai_job.js'), pqs = rd('_lib/promoqual.js');
  const post = (idx.match(/\/\/ @promo-post-start([\s\S]*?)\/\/ @promo-post-end/) || ['', ''])[1];
  T('⑥ 출력 무변: 생성 라이브러리·생성 워커·학습 워커·작업 층·복사 출력 구간에 promoqual·quality 0', !/promoqual/.test(pai + wk + lw + job) && !/promoqual|promoQual|quality/.test(post));
  T('⑥ 크론 ⑤: try 안에서 늦게 부름(모듈 실패가 ①~④를 못 깨게) · 결과 로그 quality · 모듈 맨 위 require 없음', /try \{ quality = await require\('\.\/_lib\/promoqual'\)\.sweep\(st, doc, now\); \} catch \(e\) \{ quality = \{ error: /.test(cron) && /learn: learn, quality: quality \}/.test(cron) && !/^const .*require\('\.\/_lib\/promoqual'\)/m.test(cron));
  T('⑥ pl_get: try 안 require · 실패면 null · 응답 quality 칸(layout: layout, request_id: R 순서 그대로)', /try \{ const PQ = require\('\.\/_lib\/promoqual'\); const qr = await blobGet\(st, PQ\.QUAL_KEY\); quality = PQ\.summary\(qr\.ok \? qr\.data : null\); \} catch \(e\) \{ quality = null; \}/.test(api) && /quality: quality, layout: layout, request_id: R/.test(api));
  T('⑥ 카드: promoQualHtml(표시만 — 버튼·저장 호출 0) · promoLearnDraw가 부름 · 항목 이름 16개', /function promoQualHtml\(q\)\{/.test(idx) && /h \+= promoQualHtml\(res\.body\.quality\);/.test(idx) && (() => { const s = (idx.match(/function promoQualHtml\(q\)\{([\s\S]*?)\n  \}\n  function renderPromoLearn/) || ['', ''])[1]; return s.length > 200 && !/gwCall|<button|data-pl-/.test(s); })() && Object.keys(new Function((idx.match(/(var PQ_ITEM_TXT = \{[^}]+\};)/) || ['', 'var PQ_ITEM_TXT={};'])[1] + ' return PQ_ITEM_TXT;')()).join() === PQ.ITEMS.map((i) => i[0]).join());
  T('⑥ 키·상수: promoai:quality · 포장 프로필 키 = promolearn LAYOUT_KEY · 본보기 판 e1(방내리·준설 5편)', PQ.QUAL_KEY === 'promoai:quality' && PQ.LAYOUT_KEY === PL.LAYOUT_KEY && /^e1-/.test(PQ.EX.ver) && PQ.EX.top.logNo === '224389621750' && PQ.EX.dredge.length === 5 && /require\('\.\/promoqual_ex\.json'\)/.test(pqs));
}

console.log(fails ? '\n품질 고리 게이트 실패 ' + fails + ' / 통과 ' + pass : '\n품질 고리 게이트 전 항목 통과 (' + pass + ')');
process.exit(fails ? 1 : 0);
