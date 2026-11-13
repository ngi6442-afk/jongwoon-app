// 블로그 품질 고리 3단계(원천) 게이트 — 체크 10 · PM 11/13 10:52 "2. 아니 원천 3단계 ㄱ · 3. ㅇㅇ" · 08:03 "이 골격을 정확하게 유지한채로".
//   품질 자동 학습(_lib/promoqlearn.js · gw-promo-qlearn-background · 크론 ⑥ · buildPrompt '[완성도 목표]' · 생성 워커 주입 · 카드 품질 학습 칸·일치율 흐름).
//   골격(v389 편집 간극 학습 — promolearn·학습 워커·promoai:lessons)은 읽기만, 한 바이트도 안 바뀜 · 생성 뒤 다시 쓰기(덧대기) 없음.
// 실행: node tools/promoqlearn_check.mjs   (네트워크 없음 — 모델·기동은 가짜)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'netlify', 'functions');
process.env.GW_SESSION_SECRET = 'promoqlearn-check-secret';
const mem = {};
const blobsMock = {
  setupBlobContext() {}, store(n) { mem[n] = mem[n] || {}; return n; },
  async blobGet(st, k) { const s = mem[st] || {}; return (k in s) ? { ok: true, data: JSON.parse(JSON.stringify(s[k])) } : { ok: false, code: 'NOT_FOUND' }; },
  async blobSet(st, k, v) { mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobList(st, pre) { return { ok: true, keys: Object.keys(mem[st] || {}).filter((k) => !pre || k.indexOf(pre) === 0) }; },
};
{ const rp = require.resolve(join(FN, '_lib/blobs.js')); require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: blobsMock }; }
const QL = require(join(FN, '_lib/promoqlearn.js'));
const PQ = require(join(FN, '_lib/promoqual.js'));
const PL = require(join(FN, '_lib/promolearn.js'));
const L = require(join(FN, '_lib/promoai.js'));
const { issueSession } = require(join(FN, '_lib/session.js'));
const idx = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
let fails = 0, pass = 0;
const T = (name, ok, detail) => { if (ok) pass++; else fails++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + String(detail).slice(0, 500))); };
const H = 3600000, MIN = 60000, NOW = Date.UTC(2026, 10, 13, 3, 0, 0);
const CREDIT_MSG = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

// ---- 자료: 1단계 점수 모양(promoai:quality) — 사진AI 초안 둘 + 태그만 옛 기록(빠짐) + 초안 없는 기록(빠짐) ----
const I2 = Object.fromEntries(QL.CODES.map((c) => [c, 2]));
const its = (o) => Object.assign({}, I2, o);
const baseM = { img_burst: 1, chars_per_img: 200, md_left: 0, title_len: 30, heads: 10, company: 2, site_ratio: 0.5, equip_distinct: 12, acts_distinct: 18, place_distinct: 9, qty: 0, conn_per_sent: 1.0, long_sent_ratio: 0.15, terms_distinct: 22, core_chars: 3000, max_sim: 0.1 };
const dr = (job, ts, items, m) => ({ job, ts, pv: 'p2-20261110', score10: 5, total: 16, axis: { C: 0, D: 0, X: 0 }, items, weak: [], m: Object.assign({}, baseM, m) });
const mkQ = (extra) => ({ schema: 1, ver: PQ.QUAL_VER, ex_ver: PQ.EX.ver, hist: [], sweep: {}, updated_at: 1, recs: Object.assign({
  r1: { kind: 'ai', title: '글1', draft: dr('pa_gen_1', 1000, its({ D1: 0, X1: 1, D3: 1, D5: 0, C5: 0 }), { site_ratio: 0.15, conn_per_sent: 0.55, acts_distinct: 11, heads: 2 }) },
  r2: { kind: 'ai', title: '글2', draft: dr('pa_gen_2', 2000, its({ D1: 0, X1: 0, D3: 1, D5: 0, C5: 0 }), { site_ratio: 0.10, conn_per_sent: 0.50, acts_distinct: 10 }) },
  r3: { kind: 'tpl_tags', title: '태그만', draft: dr('pa_gen_3', 3000, its({}), {}) },
  r4: { kind: 'tpl_fail', title: '실패', draft: null },
}, extra || {}) });
const Q = mkQ();
const LES = { schema: 1, off: false, rules: [{ id: 'r_a', text: '질문형 소제목은 물음표로 끝낸다.', scope: 'style', n: 9, ts: 1 }, { id: 'r_b', text: '회사 소개 문장의 서비스 목록에는 정화조 관련 작업을 넣지 않는다.', scope: 'content', n: 8, ts: 1 }], exemplars: {}, gaps: [], stats: {} };
const lesRules = PL.normLessons(LES).rules;

// ---- ① 기준 = 1단계 채점기 문턱과 같음(경계값으로 확인) ----
{
  const at = (code, mk, v) => PQ.scoreOf(Object.assign({}, baseM, { [QL.GOAL[code].m]: v, _title: '제목입니다만 스무 자를 넘기려고 길게 씀' })).items[code];
  const g = QL.GOAL;
  const ok = [
    at('D1', 0, 0.35) === 2 && at('D1', 0, 0.34) < 2 && g.D1.t === 35 && g.D1.scale === 100,
    at('D2', 0, 10) === 2 && at('D2', 0, 9) < 2, at('D3', 0, 15) === 2 && at('D3', 0, 14) < 2, at('D4', 0, 8) === 2 && at('D4', 0, 7) < 2,
    at('X1', 0, 0.9) === 2 && at('X1', 0, 0.89) < 2 && g.X1.t === 90, at('X2', 0, 0.12) === 2 && at('X2', 0, 0.11) < 2 && g.X2.t === 12,
    at('X3', 0, 20) === 2 && at('X3', 0, 19) < 2, at('X4', 0, 2500) === 2 && at('X4', 0, 2499) < 2, at('X5', 0, 0.35) === 2 && at('X5', 0, 0.36) < 2 && g.X5.cmp === 'le',
    at('C1', 0, 2) === 2 && at('C1', 0, 3) < 2, at('C2', 0, 150) === 2 && at('C2', 0, 149) < 2,
  ];
  T('① 2점 기준(GOAL) = 1단계 채점기 문턱(D1·D2·D3·D4·X1·X2·X3·X4·X5·C1·C2 경계값) · 항목 16개 · 현장 수량 D5·포장 C5는 목표 아님', ok.every(Boolean) && QL.CODES.length === 16 && !!g.D5.skip && !!g.C5.skip, JSON.stringify(ok));
}

// ---- ② 자료 모으기·이번 목표·자료 지문 ----
{
  const ds = QL.recentDrafts(Q);
  T('② 최근 초안: 사진AI 초안만 최신순(태그만 옛 기록·초안 없는 기록 뺌) · 상한 여덟 편', ds.map((d) => d.id).join() === 'r2,r1' && QL.recentDrafts(mkQ(Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['x' + i, { kind: 'ai', draft: dr('j' + i, 5000 + i, its({}), {}) }])))).length === QL.RECENT_N, ds.map((d) => d.id).join());
  const st = QL.itemStats(ds), fo = QL.focusOf(st);
  T('② 이번 목표 = 평균 2 미만 낮은 순 세 항목 D1(0)·X1(0.5)·D3(1) — D5·C5(0점이어도 목표 아님) 뺌 · 지금 값 중앙(눈금 ×100)·본보기 값(방내리)',
    fo.map((f) => f.code).join() === 'D1,X1,D3' && fo[0].now === 13 && fo[0].target === 35 && fo[0].ex === 45 && fo[1].now === 53 && fo[1].cmp === 'range' && fo[1].target2 === 120 && fo[2].now === 11 && fo[2].ex === 20 && st.D5.avg === 0 && st.C5.avg === 0, JSON.stringify(fo));
  const s0 = QL.basisSig(Q, lesRules);
  const s1 = QL.basisSig(mkQ({ r5: { kind: 'ai', title: '새 글', draft: dr('pa_gen_5', 9000, its({}), {}) } }), lesRules);
  const s2 = QL.basisSig(Q, lesRules.concat([{ id: 'r_c', n: 1 }]));
  T('② 자료 지문: 새 초안·직원 규칙(골격)이 바뀌면 달라지고 같은 자료면 같음', s0 === QL.basisSig(mkQ(), PL.normLessons(LES).rules) && s0 !== s1 && s0 !== s2);
}

// ---- ③ 학습 프롬프트(모델이 규칙을 쓴다 — 개발자는 안 씀) ----
{
  const ds = QL.recentDrafts(Q), st = QL.itemStats(ds), fo = QL.focusOf(st);
  const pp = QL.buildQLearnPrompt({ stats: st, focus: fo, lessons: lesRules, rules: [{ id: 'qabc', item: 'D1', n: 2, text: '사진마다 한 문장 이상 현장에서 한 일을 쓴다.' }], n: ds.length });
  const sys = pp.system, u = pp.user;
  T('③ 학습 입력: 본보기 · 16항목 줄(평균·지금·본보기·기준) · 이번 목표 D1·X1·D3 · 직원 규칙 두 줄(부딪히면 안 됨) · 기존 품질 규칙(id·항목·n)',
    /\[본보기\]/.test(u) && QL.CODES.every((c) => u.indexOf('- ' + c + ' ') >= 0) && /\[이번 목표 — 부족 상위 3항목\] D1 현장 문장\(평균 0\), X1 연결어미\(평균 0\.5\), D3 공정 동사\(평균 1\)/.test(u)
    && u.indexOf('[직원 규칙 2개 — 골격') > 0 && u.indexOf('- 질문형 소제목은 물음표로 끝낸다.') > 0 && u.indexOf('- qabc · D1 · 2 · 사진마다') > 0 && /목표 아님 — 현장 수량은/.test(u), u.slice(0, 600));
  T('③ 학습 지시: 지어내기 금지(판독표·입력에 있는 것만) · 직원 규칙과 부딪히지 않음 · 포장 규칙 안 만듦 · 본보기 문장 옮기기 금지 · 아라비아 숫자 금지 · 열 개 이내 · 스키마 item 열거(16 + ALL)·추가 칸 금지',
    ['사실을 지어내게 하는 규칙은 쓰지 않습니다', '이것과 부딪히는 규칙은 쓰지 않고', '포장은 앱이 복사할 때 따로 배워 붙이므로', '본보기 글의 문장·지역·현장 이름을 옮기라는 규칙은 쓰지 않습니다', '규칙에는 아라비아 숫자를 쓰지 않습니다', '전체 열 개 이내'].every((s) => sys.indexOf(s) >= 0)
    && pp.schema.properties.rules.items.properties.item.enum.length === 17 && pp.schema.properties.rules.items.additionalProperties === false && pp.schema.additionalProperties === false && pp.schema.required.join() === 'summary,rules');
}

// ---- ④ 결과 정리·병합 ----
{
  const old = [{ id: 'qold1', text: '옛 규칙', item: 'D1', n: 3, ts: 111 }];
  const out = { summary: '요약', rules: [
    { text: '사진마다 판독표에 있는 장비와 행위를 이어 한 문장으로 쓴다.', item: 'D1', n: 5, keep_id: 'qold1' },
    { text: '본문은 2500자 이상으로 쓴다.', item: 'X4', n: 1, keep_id: '' },
    { text: '자세한 것은 www.example.com 참고', item: 'ALL', n: 1, keep_id: '' },
    { text: '원인과 조치를 한 문장 안에서 이어 쓴다.', item: 'Z9', n: 0, keep_id: '' },
    { text: '원인과  조치를 한 문장 안에서 이어 쓴다.', item: 'X1', n: 2, keep_id: '' },
  ].concat(Array.from({ length: 12 }, (_, i) => ({ text: '규칙 ' + '가나다라마바사아자차카타'[i] + ' 하나', item: 'X3', n: 1, keep_id: '' }))) };
  const rs = QL.normQRules(out, old, 999);
  T('④ 규칙 정리: keep_id면 옛 id·옛 시각 · 세 자리 넘는 숫자·주소 규칙 버림 · 항목 코드 밖이면 ALL · n 최소 1 · 같은 뜻(공백만 다름) 하나 · 열 개 상한',
    rs[0].id === 'qold1' && rs[0].ts === 111 && rs[0].n === 5 && !rs.some((r) => /2500|www/.test(r.text)) && rs[1].item === 'ALL' && rs[1].n === 1 && rs.filter((r) => /원인과/.test(r.text)).length === 1 && rs.length === QL.MAX_QRULES && rs.every((r) => /^q/.test(r.id)), JSON.stringify(rs.slice(0, 3)));
  const base = Object.assign(QL.normQL(null), { off: true, stats: { calls: 2, tokens: 100 }, hist: Array.from({ length: 30 }, (_, i) => ({ at: i })), lock_ts: 5, tries: 2, code: 'NETWORK', try_sig: 'x' });
  const m = QL.mergeQL(base, out, { now: 7000, tokens: 50, sig: 'SIG', focus: [{ code: 'D1' }], n: 2 });
  T('④ 병합: 끄기 스위치는 쓰기 직전 읽은 값 그대로 · 잠금·실패·시도 지움 · 자료 지문·학습 시각 · 누적 호출·토큰 · 이력 서른 상한',
    m.off === true && m.lock_ts === 0 && m.code === '' && m.tries === 0 && m.basis_sig === 'SIG' && m.try_sig === 'SIG' && m.learned_at === 7000 && m.stats.calls === 3 && m.stats.tokens === 150 && m.hist.length === QL.HIST_MAX && m.hist[m.hist.length - 1].at === 7000 && m.ver === QL.QL_VER, JSON.stringify({ off: m.off, st: m.stats, h: m.hist.length }));
}

// ---- ⑤ 크론 ⑥ 판정(하루 한 번·첫 학습 바로·실패 재시도·잔액 부족) ----
{
  const sig = QL.basisSig(Q, lesRules);
  const D = (ql, now, q, lr) => QL.decide(ql, q || Q, lr || lesRules, now);
  const learned = { learned_at: NOW - 2 * H, basis_sig: sig, try_sig: sig };
  const Qn = mkQ({ r5: { kind: 'ai', title: '새 글', draft: dr('pa_gen_5', 9000, its({ D1: 0 }), {}) } });
  const r = [
    D({ off: true }, NOW).why === 'off',
    D({ lock_ts: NOW - 5 * MIN }, NOW).why === 'running',
    QL.decide({}, { recs: {} }, lesRules, NOW).why === 'no_drafts',
    D({}, NOW).why === 'first' && D({}, NOW).kick === true,
    D(learned, NOW).why === 'same',
    D(learned, NOW, Qn).why === 'daily_cap',
    D(Object.assign({}, learned, { learned_at: NOW - 21 * H }), NOW, Qn).why === 'new_data',
    D(Object.assign({}, learned, { learned_at: NOW - 21 * H }), NOW, Q, lesRules.concat([{ id: 'r_new', n: 1 }])).why === 'new_data',
    D({ try_sig: sig, tries: 1, code: 'NETWORK', fail_ts: NOW - 5 * MIN }, NOW).why === 'retry_wait',
    D({ try_sig: sig, tries: 1, code: 'NETWORK', fail_ts: NOW - 11 * MIN }, NOW).why === 'retry',
    D({ try_sig: sig, tries: 3, code: 'NETWORK', fail_ts: NOW - 60 * MIN }, NOW).why === 'gave_up',
    D({ try_sig: sig, tries: 0, code: 'CREDIT_LOW', fail_ts: NOW - 30 * MIN }, NOW).why === 'credit_wait',
    D({ try_sig: sig, tries: 3, code: 'CREDIT_LOW', fail_ts: NOW - 61 * MIN }, NOW).why === 'credit_retry',
    D({ try_sig: sig, tries: 1, lock_ts: NOW - 20 * MIN }, NOW).why === 'retry',
  ];
  T('⑤ 판정: 끔·도는 중·초안 없음·첫 학습(바로)·같은 자료·하루 한 번(새 초안 2시간 뒤 대기 → 21시간 뒤 기동)·직원 규칙 바뀜·실패 10분 대기→재시도·세 번 실패 멈춤·잔액 부족 한 시간(횟수 무관)·죽은 워커 15분 뒤', r.every(Boolean), JSON.stringify(r));
  const k1 = QL.markKick({}, sig, NOW), k2 = QL.markKick(k1, sig, NOW + 1), k3 = QL.markKick(Object.assign({}, k2, { code: 'NETWORK' }), 'OTHER', NOW + 2);
  T('⑤ 기동 표시: 잠금·시도 +1(같은 자료) · 자료가 바뀌면 시도 1부터 · 이전 실패 사유 지움', k1.tries === 1 && k1.lock_ts === NOW && k2.tries === 2 && k3.tries === 1 && k3.try_sig === 'OTHER' && k3.code === '');
}

// ---- ⑥ 생성 주입(한글 수사·숫자 없음) · buildPrompt 블록 자리 ----
const qdoc = Object.assign(QL.normQL(null), { rules: [{ id: 'q1', text: '사진마다 판독표에 있는 장비와 행위를 이어 한 문장으로 쓴다.', item: 'D1', n: 2, ts: 1 }, { id: 'q2', text: '원인과 조치를 한 문장 안에서 이어 쓴다.', item: 'X1', n: 2, ts: 1 }], focus: QL.focusOf(QL.itemStats(QL.recentDrafts(Q))) });
{
  const inj = QL.injectOf(qdoc, L);
  T('⑥ 주입 값: 규칙 문장 둘 · 목표 줄 한글 수사(숫자 0) — D1 십삼→삼십오 퍼센트 이상 · X1 오십삼→구십~백이십(범위) · D3 열한→열다섯 개 이상 · 꺼짐/규칙 없음 = null · 수사 함수 없으면 목표 줄 빈 배열',
    inj && inj.rules.length === 2 && inj.focus.length === 3 && inj.focus[0] === '현장 문장 비율(최근 초안 십삼 퍼센트 → 목표 삼십오 퍼센트 이상)' && inj.focus[1] === '연결어미(최근 초안 오십삼 개(문장 백 개당) → 목표 구십~백이십 개(문장 백 개당))' && inj.focus[2] === '공정 동사(최근 초안 열한 개 → 목표 열다섯 개 이상)'
    && !inj.focus.some((s) => /[0-9]/.test(s)) && QL.injectOf(Object.assign({}, qdoc, { off: true }), L) === null && QL.injectOf(QL.normQL(null), L) === null && QL.injectOf(qdoc, null).focus.length === 0, JSON.stringify(inj));
  const base = { region: '포항 두호동', facility: '상가 하수구', problem: '역류', photoCount: 4, shot_at: '2026-10-20 10:00', post_date: '2026-11-13', seed: 'qlearn', lessons: ['질문형 소제목은 물음표로 끝낸다.'], exemplar: { title: '예시 제목', excerpt: '예시 본문 앞부분입니다.' }, recent_heads: ['왜 막혔을까요?'] };
  const p = L.buildPrompt(Object.assign({}, base, { qrules: inj.rules, qfocus: inj.focus }));
  const p0 = L.buildPrompt(base);
  const u = p.user, H1 = '[완성도 목표 — 품질 자동 학습 두 건]';
  const a = u.split('\n'), i = a.findIndex((l) => l.indexOf(H1) === 0);
  const removed = i > 0 ? a.slice(0, i - 1).concat(a.slice(i + 4)).join('\n') : '';
  const forb = L.contractForbidden({ contract_info: { amount: 20000000, guarantee: 2600000 }, client: '포항시 맑은물사업소', bid_id: 'R26BK01752009', id: 'cmabcdef' });
  T('⑥ 생성 프롬프트: [직원이 고치는 패턴] → [참고 완성본] → [완성도 목표 — 품질 자동 학습 두 건] → [최근 글 소제목] → 필수 조건 순 · 직원 쪽 우선·지어내기 금지 문구 · 목표 줄 · 블록에 숫자 0 · 금지 문자열 검사 통과',
    u.indexOf('[직원이 고치는 패턴') < u.indexOf('[참고 완성본') && u.indexOf('[참고 완성본') < u.indexOf(H1) && u.indexOf(H1) < u.indexOf('[최근 글 소제목]') && u.indexOf('[최근 글 소제목]') < u.indexOf('이번 글의 필수 조건')
    && a[i].indexOf('위 [직원이 고치는 패턴]과 부딪히면 직원 쪽을 따릅니다') > 0 && a[i].indexOf('현장 사실은 사진 판독표·입력·자동 현장 사실에 있는 것만 씁니다') > 0 && a[i + 3] === '이번에 특히 채울 항목: ' + inj.focus.join(' · ')
    && !/[0-9]/.test(a.slice(i, i + 4).join('\n')) && L.scrubPayload({ user: u }, forb).ok, a.slice(i - 1, i + 5).join(' | '));
  T('⑥ 품질 규칙이 없으면 프롬프트는 블록 다섯 줄만 빠진 것과 글자까지 같음(나머지 — 골격 블록 포함 — 그대로) · 블록 없음', i > 0 && removed === p0.user && p0.user.indexOf('[완성도 목표') < 0 && p.system === p0.system);
}

// ---- ⑦ 품질 학습 워커(가짜 모델) — 쓰는 키는 promoai:qlearn 하나, 골격 키는 그대로 ----
{
  const worker = require(join(FN, 'gw-promo-qlearn-background.js'));
  const tokSys = issueSession({ id: '__promoai__', role: 'system' }).token, tokBad = issueSession({ id: 'u1', role: 'member' }).token;
  const realCall = L.callApi;
  let captured = null, calls = 0, mode = 'ok';
  const OUT = { summary: '현장 문장과 연결어미가 모자람', rules: [{ text: '사진마다 판독표에 있는 장비와 행위를 이어 한 문장으로 쓴다.', item: 'D1', n: 2, keep_id: '' }, { text: '본문은 2500자 이상으로 쓴다.', item: 'X4', n: 1, keep_id: '' }, { text: '원인과 조치를 한 문장 안에서 이어 쓴다.', item: 'X1', n: 2, keep_id: '' }] };
  L.callApi = async function (key, body) {
    calls++; captured = body;
    if (mode === 'credit') { const e = new Error('bad'); e.code = 'BAD_REQUEST'; e.detail = CREDIT_MSG; throw e; }
    if (mode === 'net') { const e = new Error('down'); e.code = 'NETWORK'; e.detail = 'fetch failed ' + key; throw e; }
    return { content: [{ type: 'text', text: JSON.stringify(OUT) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } };
  };
  try {
    process.env.GW_ANTHROPIC_KEY = 'dummy-offline-test-key-not-real';
    mem.gw_data = { 'promoai:quality': Q, 'promoai:lessons': LES };
    const sig = QL.basisSig(Q, lesRules);
    mem.gw_data['promoai:qlearn'] = QL.markKick({}, sig, Date.now());
    const lesBefore = JSON.stringify(mem.gw_data['promoai:lessons']);
    const run = (tok) => worker.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify({ sig: sig }) }, {});
    await run(tokBad);
    T('⑦ 내부 토큰이 아니면 아무것도 안 함(호출 0·잠금 그대로)', calls === 0 && mem.gw_data['promoai:qlearn'].lock_ts > 0);
    await run(tokSys);
    const q = mem.gw_data['promoai:qlearn'];
    T('⑦ 학습 성공: 규칙 둘(숫자 규칙 버림)·이번 목표 D1·X1·D3·잠금 풀림·시도 0·자료 지문·누적 호출 1·토큰 1,200 · 골격 promoai:lessons 글자까지 그대로',
      q.rules.length === 2 && q.rules.map((r) => r.item).join() === 'D1,X1' && q.focus.map((f) => f.code).join() === 'D1,X1,D3' && q.lock_ts === 0 && q.tries === 0 && q.basis_sig === sig && q.stats.calls === 1 && q.stats.tokens === 1200 && q.code === '' && JSON.stringify(mem.gw_data['promoai:lessons']) === lesBefore, JSON.stringify(q).slice(0, 400));
    T('⑦ 요청: 같은 모델·텍스트 한 덩어리(사진 없음)·json_schema·시스템 = 품질 코치 지시 · 직원 규칙이 입력에 실림', captured && captured.model === L.MODEL && captured.messages.length === 1 && captured.messages[0].content.length === 1 && captured.messages[0].content[0].type === 'text' && captured.output_config.format.type === 'json_schema' && captured.system === QL.QLEARN_SYSTEM && captured.messages[0].content[0].text.indexOf('질문형 소제목은 물음표로 끝낸다.') > 0);
    // 실패 — 잔액 부족(횟수 안 씀)·네트워크(횟수 그대로)
    mem.gw_data['promoai:qlearn'] = QL.markKick(mem.gw_data['promoai:qlearn'], 'SIG2', Date.now()); mode = 'credit'; await run(tokSys);
    const qc = mem.gw_data['promoai:qlearn'];
    mem.gw_data['promoai:qlearn'] = QL.markKick(qc, 'SIG2', Date.now()); mode = 'net'; await run(tokSys);
    const qn = mem.gw_data['promoai:qlearn'];
    T('⑦ 실패: 잔액 부족 → CREDIT_LOW·시도 횟수 되돌림(0)·잠금 풀림 · 네트워크 → NETWORK·시도 1 · 사유에 키 값 없음([REDACTED]) · 규칙은 그대로',
      qc.code === 'CREDIT_LOW' && qc.tries === 0 && qc.lock_ts === 0 && qc.fail_ts > 0 && qn.code === 'NETWORK' && qn.tries === 1 && qn.detail.indexOf('dummy-offline') < 0 && /\[REDACTED\]/.test(qn.detail) && qn.rules.length === 2, JSON.stringify({ c: [qc.code, qc.tries], n: [qn.code, qn.tries, qn.detail] }));
    const n0 = calls;
    mem.gw_data['promoai:qlearn'] = Object.assign(QL.markKick(qn, 'SIG3', Date.now()), { off: true }); mode = 'ok'; await run(tokSys);
    T('⑦ 기동 뒤 꺼졌으면 잠금만 풀고 호출 0(규칙·끔 그대로)', calls === n0 && mem.gw_data['promoai:qlearn'].off === true && mem.gw_data['promoai:qlearn'].lock_ts === 0 && mem.gw_data['promoai:qlearn'].rules.length === 2);
  } finally { L.callApi = realCall; delete process.env.GW_ANTHROPIC_KEY; }
}

// ---- ⑧ 크론 ⑥ 기동(가짜 fetch) ----
{
  const realFetch = global.fetch; const kicks = []; let down = false;
  global.fetch = async (url, o) => { if (down) throw new Error('down'); kicks.push({ url: String(url), auth: o.headers.Authorization, body: JSON.parse(o.body) }); return { ok: true, status: 202 }; };
  const savedUrl = process.env.URL; process.env.URL = 'https://jw.test';
  try {
    mem.gw_data = { 'promoai:quality': Q, 'promoai:lessons': LES };
    let r = await QL.kick('gw_data', NOW);
    const q1 = mem.gw_data['promoai:qlearn'];
    T('⑧ 첫 학습: 바로 기동 · 주소 gw-promo-qlearn-background · 내부 토큰 · 잠금·시도 1', r.started === true && r.why === 'first' && kicks.length === 1 && /\/\.netlify\/functions\/gw-promo-qlearn-background$/.test(kicks[0].url) && /^Bearer /.test(kicks[0].auth) && q1.lock_ts === NOW && q1.tries === 1, JSON.stringify(r));
    r = await QL.kick('gw_data', NOW + MIN);
    T('⑧ 도는 중이면 건너뜀(running)', r.skipped === 'running' && kicks.length === 1);
    mem.gw_data['promoai:qlearn'] = QL.mergeQL(q1, { summary: '', rules: [{ text: '규칙', item: 'D1', n: 1, keep_id: '' }] }, { now: NOW + 2 * MIN, sig: QL.basisSig(Q, lesRules), focus: [], n: 2 });
    r = await QL.kick('gw_data', NOW + 20 * MIN);
    T('⑧ 같은 자료면 건너뜀(same)', r.skipped === 'same' && kicks.length === 1);
    mem.gw_data['promoai:quality'] = mkQ({ r5: { kind: 'ai', title: '새 글', draft: dr('pa_gen_5', 9000, its({ D1: 0 }), {}) } });
    r = await QL.kick('gw_data', NOW + 3 * H);
    const r2 = await QL.kick('gw_data', NOW + 22 * H);
    T('⑧ 새 초안: 하루 한 번(세 시간 뒤 daily_cap → 스물두 시간 뒤 new_data 기동)', r.skipped === 'daily_cap' && r2.started === true && r2.why === 'new_data' && kicks.length === 2, JSON.stringify([r, r2]));
    mem.gw_data['promoai:qlearn'].lock_ts = 0; mem.gw_data['promoai:quality'] = mkQ({ r6: { kind: 'ai', title: '또 새 글', draft: dr('pa_gen_6', 9500, its({}), {}) } });
    mem.gw_data['promoai:qlearn'].learned_at = NOW; down = true;
    r = await QL.kick('gw_data', NOW + 50 * H);
    const qd = mem.gw_data['promoai:qlearn'];
    T('⑧ 기동 실패 → 잠금 풀고 KICKOFF_FAILED(10분 뒤 재시도 대상)', r.started === false && r.code === 'KICKOFF_FAILED' && qd.lock_ts === 0 && qd.code === 'KICKOFF_FAILED' && QL.decide(qd, mem.gw_data['promoai:quality'], lesRules, NOW + 50 * H + 5 * MIN).why === 'retry_wait', JSON.stringify(r));
    mem.gw_data['promoai:qlearn'].off = true;
    T('⑧ 꺼짐이면 건너뜀(off) · 점수 블롭 없으면 no_quality', (await QL.kick('gw_data', NOW + 60 * H)).skipped === 'off' && (delete mem.gw_data['promoai:qlearn'], delete mem.gw_data['promoai:quality'], (await QL.kick('gw_data', NOW + 61 * H)).skipped === 'no_quality'));
  } finally { global.fetch = realFetch; process.env.URL = savedUrl || ''; down = false; }
}

// ---- ⑨ 생성 워커 통합(가짜 모델): 품질 규칙·목표 줄이 입력에 실리고, 끄면 안 실림 ----
{
  const worker = require(join(FN, 'gw-promo-ai-run-background.js'));
  const realGen = L.generateDraft;
  let captured = null;
  L.generateDraft = async function (key, photos, input) {
    captured = input;
    return { ok: true, title: '맨홀 둘레로 번진 흰 퇴적물, 포항 두호동 상가 하수구 확인', body: '[사진 1 : 입구]\n본문입니다.', tags: ['포항'], title_type: 'O', scenes: [{ n: 1, scene: '입구', equip: '', act: '', state: '', count: '', conf: '높음' }], prompt_ver: L.PROMPT_VER, used_tokens: { input: 1, output: 1, total: 2 }, model: 'mock', warn: [] };
  };
  try {
    process.env.GW_ANTHROPIC_KEY = 'dummy-offline-test-key-not-real';
    const tokSys = issueSession({ id: '__promoai__', role: 'system' }).token;
    const A1 = 'att_00000000000000b1';
    mem.gw_files = { [A1]: { kind: 'promo', type: 'image/jpeg', name: '1.jpg', data: 'A'.repeat(200) } };
    const rec = (id) => ({ id, title: '예비 제목', body: '예비 본문', status: 'review', ts: Date.now(), region: '포항 두호동', facility: '상가하수구', problem: '역류', shot_at: '2026-10-20 10:00', photos: [{ id: A1, name: '1.jpg', shot: '2026-10-20 10:00' }] });
    mem.gw_data = { 'col:promo': { schema: 1, updated_at: 1, items: [rec('wq1'), rec('wq2')] }, 'promoai:qlearn': qdoc, 'promoai:lessons': LES };
    await worker.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokSys }, body: JSON.stringify({ job: 'pa_gen_q1', promo_id: 'wq1', contract_id: '', mode: 'draft', max_photos: 30 }) }, {});
    const job1 = mem.gw_data['promoai:job:pa_gen_q1'];
    T('⑨ 생성 워커: 입력 qrules = 품질 규칙 문장 둘 · qfocus = 한글 수사 목표 줄 셋(숫자 0) · 직원 규칙(lessons)도 그대로 실림 · 로그 "[품질 학습] 규칙 2건 · 목표 3항목" · 잡 done',
      captured && JSON.stringify(captured.qrules) === JSON.stringify(qdoc.rules.map((r) => r.text)) && captured.qfocus && captured.qfocus.length === 3 && !captured.qfocus.some((s) => /[0-9]/.test(s)) && Array.isArray(captured.lessons) && captured.lessons.length === 2
      && job1 && job1.status === 'done' && job1.log.some((l) => /\[품질 학습\] 규칙 2건 · 목표 3항목/.test(l)), JSON.stringify({ q: captured && captured.qrules, f: captured && captured.qfocus, st: job1 && job1.status, code: job1 && job1.code }));
    mem.gw_data['promoai:qlearn'] = Object.assign({}, qdoc, { off: true }); captured = null;
    await worker.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokSys }, body: JSON.stringify({ job: 'pa_gen_q2', promo_id: 'wq2', contract_id: '', mode: 'draft', max_photos: 30 }) }, {});
    const job2 = mem.gw_data['promoai:job:pa_gen_q2'];
    T('⑨ 품질 학습을 끄면 입력에 qrules·qfocus 없음 · 로그 줄 없음 · 직원 규칙은 그대로 · 잡 done', captured && captured.qrules === undefined && captured.qfocus === undefined && Array.isArray(captured.lessons) && job2 && job2.status === 'done' && !job2.log.some((l) => /품질 학습/.test(l)), JSON.stringify({ st: job2 && job2.status }));
  } finally { L.generateDraft = realGen; delete process.env.GW_ANTHROPIC_KEY; }
}

// ---- ⑩ 골격 불변·배선(정적) ----
{
  const rd = (p, enc) => fs.readFileSync(join(FN, p), enc || 'utf8');
  const pl = rd('_lib/promolearn.js'), lw = rd('gw-promo-learn-background.js'), cron = rd('gw-promo-ai-cron.js'), papi = rd('gw-promo-ai.js'), pai = rd('_lib/promoai.js'), wk = rd('gw-promo-ai-run-background.js', 'latin1'), qw = rd('gw-promo-qlearn-background.js');
  T('⑩ 골격 파일(promolearn.js·학습 워커)은 품질 학습을 모름 · 품질 학습 워커는 골격 키에 안 씀 · 생성 모듈은 학습 모듈을 부르지 않음(자료로만 받음)',
    !/qlearn|promoqlearn/.test(pl) && !/qlearn|promoqlearn/.test(lw) && !/blobSet\([^)]*LESSONS/.test(qw) && !/blobSet\([^)]*(draftKey|pairKey|PAIR_PREFIX)/.test(qw) && !/promoqlearn/.test(pai));
  T('⑩ 크론 ⑥: try 안에서 늦게 부름 · 결과 로그 out.qlearn(①~⑤ 칸 줄은 그대로) · 모듈 맨 위 require 없음',
    /try \{ qlearn = await require\('\.\/_lib\/promoqlearn'\)\.kick\(st, now\); \} catch \(e\) \{ qlearn = \{ error: /.test(cron) && /out\.qlearn = qlearn;/.test(cron) && /learn: learn, quality: quality \}/.test(cron) && !/^const .*require\('\.\/_lib\/promoqlearn'\)/m.test(cron));
  T('⑩ pl_get qlearn 칸(try·실패면 null — quality·layout 순서 그대로) · pl_set qoff(관리자·감사 "품질 학습 끔/켬" — 골격 off와 따로) · 생성 워커 주입·재조립 때 같이 뺌',
    /try \{ const QL = require\('\.\/_lib\/promoqlearn'\); const qq = await blobGet\(st, QL\.QLEARN_KEY\); qlearn = QL\.cardOf\(/.test(papi) && /qlearn: qlearn, quality: quality, layout: layout, request_id: R/.test(papi) && /\} else if \(typeof d\.qoff === 'boolean'\) \{/.test(papi) && /ev = '품질 학습 ' \+ \(d\.qoff \? '끔' : '켬'\);/.test(papi)
    && /QL\.injectOf\(qr\.ok \? qr\.data : null, lib\)/.test(wk) && /input\.qrules \|\| input\.qfocus \|\|/.test(wk) && /delete input\.qrules; delete input\.qfocus;/.test(wk));
}

// ---- ⑪ 카드: 일치율 흐름(PM 'ㅇㅇ')·품질 학습 칸(실행) ----
{
  const grab = (re) => (idx.match(re) || [''])[0];
  // esc는 앱의 여러 줄 함수라 떼어 오지 않고 같은 뜻의 시험용을 둔다(HTML 특수문자 바꾸기)
  const src = grab(/function plFmtTs\(ts\)\{[^\n]*\n/) + grab(/var PQ_ITEM_TXT = \{[^\n]*\n/) + grab(/  var PL_MON = [\s\S]*?\n  function promoQLearnHtml\(q\)\{[\s\S]*?\n  \}\n/);
  const escSrc = 'function esc(s){ return String(s===null||s===undefined?"":s).replace(/[&<>"]/g,function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c]; }); }\n';
  const recs = { pa: { id: 'pa', posted_at: '2026-10-12' }, pb: { id: 'pb', posted_at: '2026-11-11' } };
  let F = null, err = '';
  try { F = new Function('promoFind', escSrc + src + '\nreturn { s: promoMatchSeries, h: promoMatchHtml, q: promoQLearnHtml, t: pqTarget };')((id) => recs[id] || null); } catch (e) { err = e.message; }
  const pairs = [
    { status: 'done', promo_id: 'pb', gap: { ratio: 0 }, src_file: 'blog:224472642734 Wed, 11 Nov 2026', final_title: '제내리', draft_src: 'draft' },
    { status: 'done', promo_id: 'zz', gap: { ratio: 0.098 }, src_file: 'blog:224383320322 Wed, 19 Aug 2026', final_title: '장량동', draft_src: 'record' },
    { status: 'fail', promo_id: 'x', gap: null, src_file: 'blog:1 Fri, 23 Oct 2026' },
    { status: 'done', promo_id: 'pa', gap: { ratio: 0.004 }, src_file: 'blog:2 Mon, 12 Oct 2026', final_title: '장량동2', draft_src: 'record' },
  ];
  const s = F && F.s(pairs);
  T('⑪ 일치율 흐름: 학습 끝난 짝만 게시일 순(기록 게시일 → 글 날짜 순으로 찾음) · 일치율 = 1 − 간극(0.098 → 90.2%) · 끝에서 100%(99.5 이상) 연속 2',
    !!F && s.list.map((x) => x.date + ':' + x.match).join() === '2026-08-19:90.2,2026-10-12:99.6,2026-11-11:100' && s.streak === 2, err || JSON.stringify(s));
  const h2 = F && F.h(pairs), h1 = F && F.h(pairs.slice(1, 2));
  T('⑪ 일치율 줄: "본문 일치율 흐름 … 08/19 90.2% → 10/12 99.6% → 11/11 100%" · 100% 두 편 연속이면 "직원 수정 없음 2편 연속" 경고 · 한 편이면 경고 없음 · 짝 없으면 빈 줄',
    !!F && /본문 일치율 흐름/.test(h2) && /08\/19 <b>90\.2%<\/b><\/span> → .*10\/12 <b>99\.6%<\/b>.* → .*11\/11 <b>100%<\/b>/.test(h2) && /직원 수정 없음 2편 연속\(일치율 100%\)/.test(h2) && !/직원 수정 없음/.test(h1) && F.h([]) === '', (h2 || '').slice(0, 300));
  const card = F && F.q({ off: false, rules: [{ id: 'q1', item: 'D1', n: 2, text: '사진마다 판독표 장비를 쓴다.' }, { id: 'q2', item: 'ALL', n: 1, text: '전체 규칙' }], focus: [{ code: 'D1', say: '현장 문장 비율', avg: 0, now: 13, target: 35, cmp: 'ge', unit: '퍼센트', ex: 45 }, { code: 'X1', say: '연결어미', avg: 0.5, now: 53, target: 90, target2: 120, cmp: 'range', unit: '개(문장 백 개당)', ex: 104 }, { code: 'C3', say: '결함 없애기', nodisp: true, avg: 1 }], summary: '요약', learned_at: NOW, n_drafts: 2, code: '', tries: 0, running: false, stats: { calls: 1, tokens: 1200 } });
  const cardOff = F && F.q({ off: true, rules: [], focus: [], stats: {} });
  T('⑪ 품질 학습 칸: 켜짐 — 끄기 버튼(data-pq-off="1")·꺼짐 — 켜기(="0") · 목표 칩 "13% → 35% 이상"·"53 → 90~120(문장 백 개당)"·결함은 숫자 없이 · 규칙(항목 칩·전체) · 읽기 실패 문구 · 저장 호출은 카드 바깥(send)만',
    !!F && /data-pq-off="1"[^>]*>켜짐 — 끄기/.test(card) && /data-pq-off="0"[^>]*>꺼짐 — 켜기/.test(cardOff) && /D1 현장 문장 비율 13% → 35% 이상/.test(card) && /X1 연결어미 53 → 90~120\(문장 백 개당\)/.test(card) && />C3 결함 없애기</.test(card)
    && /D1 현장 문장<\/span><span style="flex:1;">사진마다 판독표 장비를 쓴다\./.test(card) && />전체<\/span>/.test(card) && /읽지 못했습니다/.test(F.q(null)) && !/gwCall/.test(src)
    && /send\(\{ qoff: b\.getAttribute\("data-pq-off"\) === "1" \}\)/.test(idx) && /h \+= promoMatchHtml\(pairs\);/.test(idx) && /h \+= promoQLearnHtml\(res\.body\.qlearn\);/.test(idx), (card || '').slice(0, 400));
}

console.log(fails ? '\n품질 학습 게이트 실패 ' + fails + ' / 통과 ' + pass : '\n품질 학습 게이트 전 항목 통과 (' + pass + ')');
process.exit(fails ? 1 : 0);
