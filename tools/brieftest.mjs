// 아침 음성 브리핑 순수 함수 검증(v416, 체크 38 D1) — 실호출 없음(Claude·Azure·ElevenLabs 금지, 키 없이 돈다).
// 커버: 날짜 보조 / 집계(결재 PM·대표 큐, 금액, 지시, 입찰 창, 차량 30일·경과·매각 제외, 인허가, 운반일지 그저께) / 템플릿 길이·숫자 /
//       모델 요청 본문에 금액·제목 0(scrubPayload) / 자기검증 6종(DIGIT·KO_NUM·UNKNOWN·REPEAT·STOP·LENGTH) / 채우기 / SSML 엔티티 / 설정 검증 / 상한.
// 실행: node tools/brieftest.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B = require(join(ROOT, 'netlify/functions/_lib/brief.js'));
const { scrubPayload } = require(join(ROOT, 'netlify/functions/_lib/claude.js'));

let pass = 0, fail = 0;
const T = (name, cond, note) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (note ? ' — ' + note : '')); } };

// 1) 날짜·금액 보조
T('dayDiff 오늘 0·내일 1·어제 -1·형식 불량 null', B.dayDiff('2026-11-03', '2026-11-03') === 0 && B.dayDiff('2026-11-04', '2026-11-03') === 1 && B.dayDiff('2026-11-02', '2026-11-03') === -1 && B.dayDiff('해당없음', '2026-11-03') === null && B.dayDiff('', '2026-11-03') === null);
T('prevWeekday 월→금 · 화→월 · 일→금', B.prevWeekday('2026-11-02') === '2026-10-30' && B.prevWeekday('2026-11-03') === '2026-11-02' && B.prevWeekday('2026-11-01') === '2026-10-30');
T('shiftDay 월초 경계', B.shiftDay('2026-11-01', -2) === '2026-10-30' && B.shiftDay('2026-12-31', 1) === '2027-01-01');
T('koDate·fmtWon', B.koDate('2026-11-03') === '11월 3일' && B.fmtWon(12000000) === '1,200만 원' && B.fmtWon(123456789) === '1억 2,346만 원' && B.fmtWon(5000) === '5,000 원' && B.fmtWon(0) === '0 원');

// 2) 집계
const TODAY = '2026-11-03';
const cols = {
  approvals: { items: [
    { id: 'a1', status: '대기', to: 'pm', title: '포항 준설 계약 상신', body: '금액 12,000,000원 · 기타', created: '2026-11-01T01:00:00Z' },
    { id: 'a2', status: '대기', to: 'pm', title: '경주 철거 계약', body: '금액 3,000,000원', created: '2026-10-20T01:00:00Z' },
    { id: 'a3', status: '대기', to: 'boss', title: '운반일지 2026-10-31', body: '' },
    { id: 'a4', status: '승인', to: 'pm', title: '끝난 건', body: '금액 99,000,000원' },
    { id: 'a5', status: '대기', to: 'pm', title: '삭제된 건', body: '금액 88,000,000원', del: 1 },
  ] },
  tasks: { items: [{ status: 'open', due: '2026-11-03' }, { status: 'open', due: '2026-10-01' }, { status: 'open', due: '2026-11-09' }, { status: 'open', due: '' }, { status: 'review' }, { status: 'done' }, { status: 'open', due: '2026-11-03', del: 1 }] },
  bids: { items: [{ status: 'new', due: '2026-11-05', created: '2026-11-03' }, { status: '검토', due: '2026-11-06', created: '2026-10-01' }, { status: 'new', due: '2026-11-07', created: '2026-11-02' }, { status: 'new', due: '2026-11-20', created: '2026-10-30' }, { status: '패스', due: '2026-11-04', created: '2026-11-03' }, { status: 'new', due: '', created: '2026-11-02' }] },
  vehicles: { items: [{ state: '운행', insp_due: '2026-11-20', ins_due: '2027-01-01' }, { state: '운행', insp_due: '2026-10-01', ins_due: '2026-11-10' }, { state: '매각', insp_due: '2026-11-05' }, { state: '말소예정', ins_due: '2026-11-05' }, { state: '정비', insp_due: '2026-12-03' }, { state: '운행', insp_due: '2026-12-04' }] },
  licenses: { items: [{ expiry: '2026-11-10' }, { expiry: '해당없음', edu_due: '2027-01-01' }, { expiry: '해당없음', edu_due: '2026-11-30' }, { expiry: '2026-10-01' }] },
};
const abJob = { status: 'done', ts: 1793574071313, log: ['[차량] 52대', '[2026-10-31] 21건 · 486.2톤 · 노선 9종 · 미매칭 0건 · 위탁량 대체 21건 · 잠정(확정 전) 3건', '[2026-11-01] 5건 · 110.03톤 · 노선 2종 · 미매칭 0건 · 위탁량 대체 5건 · 잠정(확정 전) 3건', '[2026-11-02] 6건 · 84.88톤 · 노선 6종'] };
const f = B.computeFacts(cols, abJob, TODAY);
T('집계 결재: PM 큐 2(승인·삭제 제외)·대표 1·최대 금액 1,200만·제목', f.appr_pm === 2 && f.appr_boss === 1 && f.appr_amt === 12000000 && f.appr_title === '포항 준설 계약 상신', JSON.stringify([f.appr_pm, f.appr_boss, f.appr_amt, f.appr_title]));
T('집계 금지 문자열에 대기 결재 제목 전부(끝난 건·삭제 건 제외)', f.forbidden.length === 3 && f.forbidden.indexOf('운반일지 2026-10-31') >= 0 && f.forbidden.indexOf('끝난 건') < 0, JSON.stringify(f.forbidden));
T('집계 지시: 열림 4(삭제 제외)·오늘 기한·경과 2·승인 대기 1', f.task_open === 4 && f.task_due === 2 && f.task_review === 1, JSON.stringify([f.task_open, f.task_due, f.task_review]));
T('집계 입찰: 사흘 안 마감 2(new·검토, 패스 제외, 11/7은 4일 뒤)·직전 평일(11/2) 뒤 신규 3', f.bid_soon === 2 && f.bid_new === 3, JSON.stringify([f.bid_soon, f.bid_new]));
T('집계 차량: 30일 안 3(매각·말소 제외, 보험 11/10·정비 12/3 포함, 한 대는 검사 경과+보험 임박 둘 다)·경과 1 · 12/4는 31일이라 제외', f.veh_30 === 3 && f.veh_over === 1, JSON.stringify([f.veh_30, f.veh_over]));
T('집계 인허가: 30일 안 2(해당없음 건너뜀·edu_due 포함·지난 것 제외)', f.lic_30 === 2, String(f.lic_30));
T('집계 운반일지: 그저께(11/1) 5건·110.03톤·잠정 3·수집 시각', f.ab && f.ab.day === '2026-11-01' && f.ab.cnt === 5 && f.ab.ton === 110.03 && f.ab.prov === 3 && f.ab.src_ts === 1793574071313, JSON.stringify(f.ab));
const f0 = B.computeFacts({}, null, TODAY);
T('집계 빈 컬렉션·잡 없음 → 전부 0·ab null', f0.appr_pm === 0 && f0.task_open === 0 && f0.bid_new === 0 && f0.veh_30 === 0 && f0.lic_30 === 0 && f0.ab === null && f0.forbidden.length === 0);

// 3) 템플릿
const tpl = B.templateText(f);
const vt = B.verifyFilled(tpl, f);
T('템플릿: 150~300자·숫자 전부 facts·자리표시 0', vt.ok && tpl.length >= B.LEN_MIN && tpl.length <= B.LEN_MAX && /1,200만 원/.test(tpl) && /11월 1일 기준 5건 110톤, 잠정 3건/.test(tpl), vt.code + ' ' + tpl.length);
const tpl0 = B.templateText(f0);
T('템플릿(전부 0): 길이 안·운반일지 없음 문장', B.verifyFilled(tpl0, f0).ok && /수집 기록이 없어/.test(tpl0), B.verifyFilled(tpl0, f0).code + ' ' + tpl0.length);

// 4) 모델 요청 본문 — 금액·제목·숫자 0(자리표시만), scrubPayload 통과
const body = B.claudeBody(f);
const bs = JSON.stringify(body);
T('요청 본문: 모델 haiku-5-5·effort low·자리표시 16종·있음/없음', body.model === 'claude-haiku-5-5' && body.output_config.effort === 'low' && (bs.match(/\{\{\w+\}\}/g) || []).length >= 16 && /있음/.test(bs));
T('요청 본문: 결재 제목·금액 숫자 0 · scrubPayload 통과', scrubPayload(body, f.forbidden.concat(['12,000,000', '12000000'])).ok && bs.indexOf('포항') < 0 && !/\d{3,}/.test(body.messages[0].content), bs.slice(0, 200));

// 5) 자기검증·채우기
const good = '좋은 아침입니다. {{date}} 브리핑입니다. 결재는 내 차례 {{appr_pm}}건, 대표님 차례 {{appr_boss}}건입니다. 가장 큰 건은 {{appr_title}}, {{appr_amt}}입니다. 지시는 열린 것 {{task_open}}건, 오늘 기한이거나 지난 것 {{task_due}}건, 승인 대기 {{task_review}}건입니다. 입찰은 사흘 안 마감 {{bid_soon}}건, 새 공고 {{bid_new}}건입니다. 차량 만기 한 달 안 {{veh_30}}대, 지난 것 {{veh_over}}대, 인허가 {{lic_30}}건입니다. 운반일지는 {{ab_day}} 기준 {{ab_cnt}}건 {{ab_ton}}, 잠정 {{ab_prov}}건입니다. 이상입니다.';
const filled = B.fillText(good, f);
T('자기검증: 정상 글 통과 → 채움 → 숫자 전부 facts·길이 안', B.verifyModelText(good, f).ok && B.verifyFilled(filled, f).ok && /내 차례 2건/.test(filled) && /1,200만 원/.test(filled) && /11월 1일 기준 5건 110톤/.test(filled), B.verifyFilled(filled, f).code + ' ' + filled.length);
T('자기검증: 숫자 → DIGIT', B.verifyModelText('결재 3건입니다 ' + good, f).code === 'DIGIT');
T('자기검증: 한글 수사 → KO_NUM', B.verifyModelText(good.replace('{{appr_pm}}건', '세 건'), f).code === 'KO_NUM');
T('자기검증: 모르는 자리표시 → UNKNOWN_PLACEHOLDER', B.verifyModelText(good + ' {{nope}}', f).code === 'UNKNOWN_PLACEHOLDER');
T('자기검증: 같은 자리표시 3회 → PLACEHOLDER_REPEAT', B.verifyModelText(good + ' {{appr_pm}} {{appr_pm}}', f).code === 'PLACEHOLDER_REPEAT');
T('자기검증: "그만" → STOP_WORD', B.verifyModelText(good.replace('이상입니다.', '브리핑 그만.'), f).code === 'STOP_WORD');
T('자기검증(채운 뒤): 짧은 글 → LENGTH · facts 밖 숫자 → NUMBER_NOT_IN_FACTS · "30일 안"은 허용', B.verifyFilled('좋은 아침입니다. 이상입니다.', f).code === 'LENGTH' && B.verifyFilled(filled.replace('2건', '7건'), f).code === 'NUMBER_NOT_IN_FACTS' && B.verifyFilled(filled.replace('한 달 안', '30일 안'), f).ok);
T('채우기: 값 없는 자리표시는 빈칸(ab 없음)', B.fillText('운반 {{ab_cnt}}건', f0) === '운반 건');

// 6) SSML·설정·상한
const ss = B.ssmlOf('[R&D 협력] <a> "x" \'y\'', 'ko-KR-SunHiNeural', '+10%');
T('SSML: 엔티티 5종 치환·voice·prosody', /&amp;/.test(ss) && /&lt;a&gt;/.test(ss) && /&quot;x&quot;/.test(ss) && /&apos;y&apos;/.test(ss) && /name="ko-KR-SunHiNeural"/.test(ss) && /rate="\+10%"/.test(ss) && ss.indexOf('<a>') < 0);
T('설정 검증: provider·rate·voice 형식·on', B.settingsValid('provider', 'azure') && !B.settingsValid('provider', 'fish') && B.settingsValid('rate', '-10%') && !B.settingsValid('rate', '5%') && B.settingsValid('voice_azure', 'ko-KR-InJoonNeural') && !B.settingsValid('voice_azure', 'bad voice') && B.settingsValid('voice_elevenlabs', '') && B.settingsValid('on', false) && !B.settingsValid('on', 'yes'));
const nz = B.settingsNormalize({ provider: 'fish', rate: '+10%', on: 'x', voice_azure: 'ko-KR-SunHiNeural' });
T('설정 정규화: 불량 값은 기본값·정상 값 유지', nz.provider === 'azure' && nz.rate === '+10%' && nz.on === true && nz.voice_elevenlabs === '');
const cs = B.capState({ azure_chars: 400000, claude_tokens: 500000 });
T('월 상한: Azure 40만 자 도달 over · Claude 50% · 비율', cs.azure_over === true && cs.claude_over === false && cs.azure_pct === 100 && cs.claude_pct === 50);
T('azureEnv: 키·지역 없으면 ok false(값 노출 없음)', (() => { const k = process.env.AZURE_SPEECH_KEY, r = process.env.AZURE_SPEECH_REGION; delete process.env.AZURE_SPEECH_KEY; delete process.env.AZURE_SPEECH_REGION; const e = B.azureEnv(); if (k) process.env.AZURE_SPEECH_KEY = k; if (r) process.env.AZURE_SPEECH_REGION = r; return e.ok === false && !('key' in e && e.key); })());

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n브리핑 순수 함수 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
