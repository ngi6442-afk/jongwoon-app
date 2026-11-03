'use strict';
// 아침 음성 브리핑(체크 38 D1, v416 — 25_사용자인식AI/D1_착수브리핑_20261102.md §3 D1, PM 11/3 "ㄱ").
// 흐름: 집계(숫자는 코드가) → 문장(Claude 자리표시 글 또는 템플릿) → 숫자 자기검증 → SSML → Azure mp3 → 보관(brief:day·brief:mp3) → 사용량·로그.
// 규칙: ① 금액·업체명·제목은 Anthropic에 가지 않는다(자리표시 — 모델은 {{이름}}만 쓰고 코드가 채움, 전송 직전 scrubPayload) ② 숫자는 전부 facts에서만
//       ③ 키(GW_ANTHROPIC_KEY·AZURE_SPEECH_KEY·ELEVENLABS_API_KEY)는 호출 헤더로만 — 응답·로그·블롭에 값 0 ④ 월 상한 가드(고정값: Azure 40만 자·Claude 100만 토큰)를
//       넘으면 글 카드·템플릿 ⑤ 같은 날 생성본이 있으면 예약은 다시 만들지 않는다(force는 관리자 카드만) ⑥ 실호출 없는 순수 함수는 tools/brieftest.mjs가 검증.
const { blobGet, blobSet } = require('./blobs');
const { callApi, responseText, scrubPayload, usageTokens } = require('./claude');

const SETTINGS_KEY = 'settings:brief';
const PROVIDERS = ['azure', 'elevenlabs'];
const RATES = ['-10%', '0%', '+10%'];
const DEFAULTS = { on: true, provider: 'azure', voice_azure: 'ko-KR-SunHiNeural', voice_elevenlabs: '', rate: '0%' };
const CAP_AZURE_CHARS = 400000;     // F0 월 50만 자의 80% — 보낸 SSML 전체 글자 수(공백·태그 포함)로 센다
const CAP_CLAUDE_TOKENS = 1000000;  // 입력+출력+캐시 합(usageTokens)
const ADMIN_RUNS_PER_DAY = 5;       // [지금 1회 생성] 하루 상한 — 유료 호출 반복 방지
const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 4000;            // 생각 몫까지 — 모자라면 글 없이 max_tokens로 끝나 템플릿으로 넘어간다
const TIMEOUT_MS = 60000;
const LEN_MIN = 150, LEN_MAX = 300; // 채운 뒤 본문 길이(자)
const LOG_KEEP = 60;
const MP3_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';   // 48kbps — 60초 약 0.36MB, base64 약 0.48MB(함수 6MB 한도 아래)

function kstNow() { return new Date(Date.now() + 9 * 3600000); }
function kstToday() { return kstNow().toISOString().slice(0, 10); }
function kstDate(offsetDays) { return new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }
function monthOf(day) { return String(day || kstToday()).slice(0, 7); }
function hhmm(ts) { const d = new Date(Number(ts) + 9 * 3600000); return d.toISOString().slice(11, 16); }

// ---------- 설정(settings:brief) — 알림 설정 카드와 같은 결(기본값·prev 1판·되돌리기) ----------
function settingsDefaults() { return Object.assign({}, DEFAULTS); }
function settingsValid(field, value) {
  if (field === 'on') return value === true || value === false;
  if (field === 'provider') return PROVIDERS.indexOf(String(value)) >= 0;
  if (field === 'rate') return RATES.indexOf(String(value)) >= 0;
  if (field === 'voice_azure') return typeof value === 'string' && /^[A-Za-z]{2}-[A-Za-z]{2}-[A-Za-z0-9]{2,40}$/.test(value);   // 예 ko-KR-SunHiNeural
  if (field === 'voice_elevenlabs') return typeof value === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(value);                 // 목소리 id(빈칸 허용)
  return false;
}
function settingsNormalize(raw) {
  const s = settingsDefaults();
  if (raw && typeof raw === 'object') Object.keys(s).forEach(function (k) { if (raw[k] !== undefined && settingsValid(k, raw[k])) s[k] = raw[k]; });
  return s;
}
async function settingsRead(st) {
  try {
    const r = await blobGet(st, SETTINGS_KEY);
    if (r.ok && r.data && typeof r.data === 'object') {
      return { values: settingsNormalize(r.data.values), prev: r.data.prev || null, updated_at: r.data.updated_at || 0, updated_by: r.data.updated_by || '' };
    }
  } catch (e) { /* 기본값 */ }
  return { values: settingsDefaults(), prev: null, updated_at: 0, updated_by: '' };
}
function settingsPublic(s) {
  return { values: s.values, defaults: settingsDefaults(), providers: PROVIDERS, rates: RATES,
    prev: s.prev ? { updated_at: s.prev.updated_at || 0, updated_by: s.prev.updated_by || '' } : null, updated_at: s.updated_at || 0, updated_by: s.updated_by || '' };
}

// ---------- 집계(순수 — tools/brieftest.mjs 검증) ----------
function dayDiff(dateStr, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const t = String(today).split('-');
  const a = Date.UTC(+m[1], +m[2] - 1, +m[3]), b = Date.UTC(+t[0], +t[1] - 1, +t[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}
function shiftDay(day, n) {
  const t = String(day).split('-');
  return new Date(Date.UTC(+t[0], +t[1] - 1, +t[2]) + (n || 0) * 86400000).toISOString().slice(0, 10);
}
function prevWeekday(today) {
  const t = String(today).split('-');
  let d = new Date(Date.UTC(+t[0], +t[1] - 1, +t[2]));
  do { d = new Date(d.getTime() - 86400000); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
function koDate(day) { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(day || '')); return m ? (Number(m[1]) + '월 ' + Number(m[2]) + '일') : String(day || ''); }
function fmtWon(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 100000000) { const eok = Math.floor(n / 100000000), man = Math.round((n % 100000000) / 10000); return eok + '억' + (man ? ' ' + man.toLocaleString('en-US') + '만' : '') + ' 원'; }
  if (n >= 10000) return Math.round(n / 10000).toLocaleString('en-US') + '만 원';
  return n.toLocaleString('en-US') + ' 원';
}
function liveItems(doc) { const its = (doc && Array.isArray(doc.items)) ? doc.items : (Array.isArray(doc) ? doc : []); return its.filter(function (x) { return x && typeof x === 'object' && x.del !== 1; }); }
function amountOf(a) { const m = /금액\s*([\d,]+)\s*원/.exec(String((a && a.body) || '')); return m ? Number(m[1].replace(/,/g, '')) : 0; }

// cols = {approvals, tasks, bids, vehicles, licenses}(각 col 문서 또는 items 배열), abJob = 어제 올바로 잡(allbaro:job:ab_cron_<어제>, null 가능)
function computeFacts(cols, abJob, today) {
  const f = { date: today, appr_pm: 0, appr_boss: 0, appr_amt: 0, appr_title: '', task_open: 0, task_due: 0, task_review: 0, bid_soon: 0, bid_new: 0,
    veh_30: 0, veh_over: 0, lic_30: 0, ab: null, forbidden: [] };
  const ap = liveItems(cols.approvals).filter(function (a) { return a.status === '대기'; });
  const pm = ap.filter(function (a) { return a.to === 'pm'; });
  f.appr_pm = pm.length; f.appr_boss = ap.filter(function (a) { return a.to === 'boss'; }).length;
  let pick = null, best = 0;
  pm.forEach(function (a) { const n = amountOf(a); if (n > best) { best = n; pick = a; } });
  if (!pick && pm.length) pick = pm.slice().sort(function (a, b) { return String(a.created || '').localeCompare(String(b.created || '')); })[0];
  if (pick) { f.appr_amt = best; f.appr_title = String(pick.title || '').replace(/\s+/g, ' ').trim().slice(0, 40); }
  ap.forEach(function (a) { const t = String(a.title || '').trim(); if (t.length >= 4) f.forbidden.push(t); });
  liveItems(cols.tasks).forEach(function (t) {
    if (t.status === 'open') { f.task_open++; const d = dayDiff(t.due, today); if (d !== null && d <= 0) f.task_due++; }
    else if (t.status === 'review') f.task_review++;
  });
  const pw = prevWeekday(today);
  // 입찰: 레이더가 전국 공고를 다 모으므로(new 2,400건·matched는 전건 키워드라 걸러지지 않음 — 11/3 첫 생성 '사흘 안 마감 615건') 마감 임박은 사람이 '검토'로 표시한 건만, 신규는 유입량으로.
  liveItems(cols.bids).forEach(function (b) {
    if (b.status === '검토') { const d = dayDiff(b.due, today); if (d !== null && d >= 0 && d <= 3) f.bid_soon++; }
    if (b.status === 'new' && String(b.created || '').slice(0, 10) >= pw) f.bid_new++;
  });
  liveItems(cols.vehicles).forEach(function (v) {
    if (v.state === '매각' || v.state === '말소예정') return;
    let soon = false, over = false;
    [v.insp_due, v.ins_due].forEach(function (x) { const d = dayDiff(x, today); if (d === null) return; if (d < 0) over = true; else if (d <= 30) soon = true; });
    if (soon) f.veh_30++; if (over) f.veh_over++;
  });
  liveItems(cols.licenses).forEach(function (l) {
    const hit = [l.expiry, l.edu_due].some(function (x) { const d = dayDiff(x, today); return d !== null && d >= 0 && d <= 30; });
    if (hit) f.lic_30++;
  });
  // 운반일지 — 자동 수집이 매일 08:00 한 번이라 아침 생성 때는 '어제 08:00 수집' 기준 → 그저께분을 말하고 기준 시각을 함께 말한다(브리핑 §3 D1).
  if (abJob && abJob.status === 'done' && Array.isArray(abJob.log)) {
    const day2 = shiftDay(today, -2);
    const re = /^\[(\d{4}-\d{2}-\d{2})\]\s*(\d+)건 · ([\d.]+)톤/;
    let line = null;
    abJob.log.forEach(function (l) { const m = re.exec(String(l)); if (m && m[1] === day2 && !line) line = { day: m[1], cnt: Number(m[2]), ton: Number(m[3]), raw: String(l) }; });
    if (line) {
      const pm2 = /잠정\(확정 전\)\s*(\d+)건/.exec(line.raw);
      f.ab = { day: line.day, cnt: line.cnt, ton: line.ton, prov: pm2 ? Number(pm2[1]) : 0, src_ts: Number(abJob.ts) || 0 };
    }
  }
  return f;
}

// 자리표시 → 채울 값(문자열). 단위가 들어가는 값(금액·톤·날짜)은 여기서 단위까지 붙인다.
function fillsOf(f) {
  const o = { date: koDate(f.date), appr_pm: String(f.appr_pm), appr_boss: String(f.appr_boss), appr_amt: f.appr_amt ? fmtWon(f.appr_amt) : '', appr_title: f.appr_title || '',
    task_open: String(f.task_open), task_due: String(f.task_due), task_review: String(f.task_review), bid_soon: String(f.bid_soon), bid_new: String(f.bid_new),
    veh_30: String(f.veh_30), veh_over: String(f.veh_over), lic_30: String(f.lic_30),
    ab_day: f.ab ? koDate(f.ab.day) : '', ab_cnt: f.ab ? String(f.ab.cnt) : '', ab_ton: f.ab ? (Math.round(f.ab.ton * 10) / 10).toLocaleString('en-US') + '톤' : '', ab_prov: f.ab ? String(f.ab.prov) : '' };
  return o;
}
function hasFlag(f, k) {
  if (k === 'appr_amt') return f.appr_amt > 0;
  if (k === 'appr_title') return !!f.appr_title;
  if (k === 'date') return true;
  if (/^ab_/.test(k)) return !!f.ab;
  return Number(f[k]) > 0;
}

// 템플릿 글(폴백·기준선) — 숫자는 전부 facts. 150~300자.
function templateText(f) {
  const v = fillsOf(f);
  let s = '좋은 아침입니다. ' + v.date + ' 브리핑입니다. ';
  s += '결재는 내 차례 ' + v.appr_pm + '건, 대표님 차례 ' + v.appr_boss + '건이 기다립니다. ';
  if (f.appr_amt > 0) s += (v.appr_title ? '가장 큰 건은 ' + v.appr_title + ', ' + v.appr_amt + '입니다. ' : '가장 큰 금액은 ' + v.appr_amt + '입니다. ');
  s += '지시는 열린 것 ' + v.task_open + '건 중 오늘 기한이거나 지난 것이 ' + v.task_due + '건, 승인 대기가 ' + v.task_review + '건입니다. ';
  s += '입찰은 검토 표시 중 사흘 안 마감 ' + v.bid_soon + '건, 새로 들어온 공고 ' + v.bid_new + '건입니다. ';
  s += '차량 검사·보험 만기 30일 안 ' + v.veh_30 + '대, 지난 것 ' + v.veh_over + '대, 인허가 만기 30일 안 ' + v.lic_30 + '건입니다. ';
  if (f.ab) s += '운반일지는 ' + v.ab_day + ' 기준 ' + v.ab_cnt + '건 ' + v.ab_ton + ', 잠정 ' + v.ab_prov + '건입니다. ';
  else s += '운반일지는 어제 수집 기록이 없어 오늘은 빠집니다. ';
  s += '이상입니다.';
  return s.trim();
}

// 모델에 보내는 요청(자리표시만 — 숫자·금액·제목 0). 반환 body(callApi용).
const SYSTEM = '너는 회사 그룹웨어의 아침 음성 브리핑 작가다. 입력은 항목 목록이고 항목마다 자리표시({{이름}})와 있음/없음 표시가 있다.\n'
  + '규칙: ① 숫자·금액·업체명·제목을 절대 쓰지 말고 반드시 자리표시 {{이름}}을 그대로 쓴다(값은 프로그램이 채운다). ② "한 건·세 곳·네 대" 같은 한글 수사도 쓰지 않는다. '
  + '③ 건수 자리표시 뒤에는 단위(건·대)를 붙이고, {{date}}·{{appr_amt}}·{{ab_ton}}·{{ab_day}}·{{appr_title}}에는 단위를 붙이지 않는다(들어 있음). 기간은 "한 달 안"처럼 숫자 없이 쓴다. ④ "없음" 항목은 짧게 없다고 하거나 생략한다. '
  + '⑤ 자리표시는 주어진 것만, 각각 최대 1회. ⑥ 존댓말, 소리 내어 읽기 좋은 짧은 문장, 공백 포함 150~250자. ⑦ "좋은 아침입니다"로 시작하고 "이상입니다"로 끝낸다. ⑧ "그만"이라는 말은 쓰지 않는다. ⑨ 출력은 본문만.';
function claudeBody(f) {
  const Y = function (k) { return hasFlag(f, k) ? '있음' : '없음'; };
  const lines = [
    '오늘 날짜 {{date}}.',
    '- 결재 내 차례 건수 {{appr_pm}} — ' + Y('appr_pm') + ' / 대표님 결재 대기 건수 {{appr_boss}} — ' + Y('appr_boss'),
    '- 내 차례 중 가장 큰 금액 {{appr_amt}} — ' + Y('appr_amt') + ' / 그 건의 제목 {{appr_title}} — ' + Y('appr_title'),
    '- 열린 지시 {{task_open}} — ' + Y('task_open') + ' / 오늘 기한이거나 지난 지시 {{task_due}} — ' + Y('task_due') + ' / 승인 대기 {{task_review}} — ' + Y('task_review'),
    '- 입찰 검토 표시 중 사흘 안 마감 {{bid_soon}} — ' + Y('bid_soon') + ' / 직전 평일 뒤 새로 들어온 공고 {{bid_new}} — ' + Y('bid_new'),
    '- 차량 검사·보험 만기가 한 달 안인 차량 {{veh_30}} — ' + Y('veh_30') + ' / 기한 지난 차량 {{veh_over}} — ' + Y('veh_over'),
    '- 인허가 만기가 한 달 안인 건 {{lic_30}} — ' + Y('lic_30'),
    '- 운반일지 {{ab_day}} 기준 운반 {{ab_cnt}}건·{{ab_ton}}·잠정 {{ab_prov}} — ' + Y('ab_cnt') + '(없음이면 "운반일지 수집 기록이 없다"고 한 문장)',
  ];
  return { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, output_config: { effort: 'low' }, messages: [{ role: 'user', content: lines.join('\n') }] };
}

// 숫자 자기검증 — 채우기 전(모델 글)과 채운 뒤. 반환 {ok, code, text}.
const RE_KO_NUM = /(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰)\s?(건|곳|대|명|개|번|종|회|톤|일)/;
const ALLOWED_LITERALS = ['30'];   // 템플릿의 "30일 안" — facts 밖에서 허용하는 유일한 숫자
function verifyModelText(text, f) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, code: 'EMPTY' };
  const bare = t.replace(/\{\{\w+\}\}/g, '');   // 자리표시 이름(veh_30 등)의 숫자는 제외하고 본다
  if (/\d/.test(bare)) return { ok: false, code: 'DIGIT' };
  if (RE_KO_NUM.test(bare)) return { ok: false, code: 'KO_NUM' };
  if (/그만/.test(t)) return { ok: false, code: 'STOP_WORD' };
  const fills = fillsOf(f);
  const seen = {};
  const re = /\{\{(\w+)\}\}/g; let m;
  while ((m = re.exec(t))) {
    if (!Object.prototype.hasOwnProperty.call(fills, m[1])) return { ok: false, code: 'UNKNOWN_PLACEHOLDER' };
    seen[m[1]] = (seen[m[1]] || 0) + 1;
    if (seen[m[1]] > 2) return { ok: false, code: 'PLACEHOLDER_REPEAT' };
  }
  return { ok: true, code: '' };
}
function fillText(text, f) {
  const fills = fillsOf(f);
  return String(text || '').replace(/\{\{(\w+)\}\}/g, function (_, k) { return Object.prototype.hasOwnProperty.call(fills, k) ? fills[k] : ''; }).replace(/[ \t]+/g, ' ').trim();
}
function verifyFilled(text, f) {
  const t = String(text || '');
  if (/\{\{/.test(t)) return { ok: false, code: 'PLACEHOLDER_LEFT' };
  const fl = fillsOf(f);
  const allowed = Object.keys(fl).map(function (k) { return fl[k]; }).concat(ALLOWED_LITERALS).join(' | ');
  const groups = t.match(/\d[\d,.]*/g) || [];
  for (let i = 0; i < groups.length; i++) { if (allowed.indexOf(groups[i]) < 0) return { ok: false, code: 'NUMBER_NOT_IN_FACTS' }; }
  if (t.length < LEN_MIN || t.length > LEN_MAX) return { ok: false, code: 'LENGTH' };
  if (/그만/.test(t)) return { ok: false, code: 'STOP_WORD' };
  return { ok: true, code: '' };
}

// ---------- 음성 ----------
function xmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function ssmlOf(text, voice, rate) {
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="' + xmlEsc(voice) + '"><prosody rate="' + xmlEsc(rate || '0%') + '">' + xmlEsc(text) + '</prosody></voice></speak>';
}
function azureEnv() {
  const key = String(process.env.AZURE_SPEECH_KEY || '').trim(), region = String(process.env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
  return { key: key, region: /^[a-z0-9]{3,30}$/.test(region) ? region : '', ok: !!key && /^[a-z0-9]{3,30}$/.test(region) };
}
async function fetchTimeout(url, opts, ms) {
  const ctl = new AbortController(); const timer = setTimeout(function () { ctl.abort(); }, ms || 30000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); } finally { clearTimeout(timer); }
}
async function azureTts(ssml) {
  const env = azureEnv(); if (!env.ok) throw new Error('AZURE_ENV_MISSING');
  const res = await fetchTimeout('https://' + env.region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': env.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': MP3_FORMAT, 'User-Agent': 'jongwoon-gw-brief' }, body: ssml }, 45000);
  if (!res.ok) throw new Error('AZURE_HTTP_' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('AZURE_EMPTY');
  return buf;
}
async function azureVoices() {
  const env = azureEnv(); if (!env.ok) return { ok: false, code: 'AZURE_ENV_MISSING' };
  const res = await fetchTimeout('https://' + env.region + '.tts.speech.microsoft.com/cognitiveservices/voices/list', { method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': env.key, 'User-Agent': 'jongwoon-gw-brief' } }, 30000);
  if (!res.ok) return { ok: false, code: 'AZURE_HTTP_' + res.status };
  let arr = []; try { arr = await res.json(); } catch (e) { return { ok: false, code: 'AZURE_PARSE' }; }
  const ko = (Array.isArray(arr) ? arr : []).filter(function (v) { return v && /^ko-KR/i.test(String(v.Locale || '')); }).map(function (v) { return String(v.ShortName || ''); });
  return { ok: true, ts: Date.now(), region: env.region, total: Array.isArray(arr) ? arr.length : 0, ko: ko, sunhi: ko.indexOf('ko-KR-SunHiNeural') >= 0 };
}
// ElevenLabs — 호출 경로만(10/21 'ELEVENLABS_API_KEY만 넣으면 전환'). 키가 없으면 호출하지 않는다(브리핑 §8).
async function elevenTts(text, voiceId) {
  const key = String(process.env.ELEVENLABS_API_KEY || '').trim(); if (!key) throw new Error('ELEVENLABS_NO_KEY');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(voiceId || ''))) throw new Error('ELEVENLABS_NO_VOICE');
  const res = await fetchTimeout('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?output_format=mp3_44100_64', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, body: JSON.stringify({ text: String(text), model_id: 'eleven_multilingual_v2' }) }, 45000);
  if (!res.ok) throw new Error('ELEVENLABS_HTTP_' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('ELEVENLABS_EMPTY');
  return buf;
}

// ---------- 사용량·로그 ----------
function usageKey(day) { return 'brief:usage:' + monthOf(day); }
async function usageRead(st, day) {
  try { const r = await blobGet(st, usageKey(day)); if (r.ok && r.data) return { azure_chars: Number(r.data.azure_chars) || 0, claude_tokens: Number(r.data.claude_tokens) || 0, runs: Number(r.data.runs) || 0 }; } catch (e) {}
  return { azure_chars: 0, claude_tokens: 0, runs: 0 };
}
async function usageAdd(st, day, add) {
  const u = await usageRead(st, day);
  u.azure_chars += Number(add.azure_chars) || 0; u.claude_tokens += Number(add.claude_tokens) || 0; u.runs += Number(add.runs) || 0;
  u.month = monthOf(day); u.ts = Date.now(); u.cap_azure = CAP_AZURE_CHARS; u.cap_claude = CAP_CLAUDE_TOKENS;
  try { await blobSet(st, usageKey(day), u); } catch (e) {}
  return u;
}
function capState(u) {
  return { azure_over: (u.azure_chars || 0) >= CAP_AZURE_CHARS, claude_over: (u.claude_tokens || 0) >= CAP_CLAUDE_TOKENS, azure_pct: Math.round(100 * (u.azure_chars || 0) / CAP_AZURE_CHARS), claude_pct: Math.round(100 * (u.claude_tokens || 0) / CAP_CLAUDE_TOKENS) };
}
async function logAppend(st, entry) {
  let doc = { schema: 1, items: [] };
  try { const r = await blobGet(st, 'brief:log'); if (r.ok && r.data && Array.isArray(r.data.items)) doc = r.data; } catch (e) {}
  doc.items.push(entry); if (doc.items.length > LOG_KEEP) doc.items = doc.items.slice(-LOG_KEEP);
  doc.ts = Date.now();
  try { await blobSet(st, 'brief:log', doc); } catch (e) {}
}
async function logRead(st, n) {
  try { const r = await blobGet(st, 'brief:log'); if (r.ok && r.data && Array.isArray(r.data.items)) return r.data.items.slice(-(n || 7)).reverse(); } catch (e) {}
  return [];
}

// ---------- 생성(오케스트레이션) ----------
async function readCols(st) {
  const out = {};
  for (const name of ['approvals', 'tasks', 'bids', 'vehicles', 'licenses']) {
    try { const r = await blobGet(st, 'col:' + name); out[name] = (r.ok && r.data) ? r.data : null; } catch (e) { out[name] = null; }
  }
  return out;
}
async function readAbJob(st, today) {
  for (const off of [-1, -2]) {
    const key = 'allbaro:job:ab_cron_' + kstDate(off);
    try { const r = await blobGet(st, key); if (r.ok && r.data && r.data.status === 'done') return r.data; } catch (e) {}
  }
  return null;
}

async function sentence(st, f, today, log) {
  const apiKey = String(process.env.GW_ANTHROPIC_KEY || '').trim();
  const usage = await usageRead(st, today);
  if (!apiKey) return { mode: 'template', reason: 'NO_CLAUDE_KEY', text: templateText(f), tokens: 0 };
  if (capState(usage).claude_over) return { mode: 'template', reason: 'CLAUDE_CAP', text: templateText(f), tokens: 0 };
  const body = claudeBody(f);
  const forb = f.forbidden.concat(f.appr_amt ? [String(f.appr_amt)] : []);
  const sc = scrubPayload(body, forb);
  if (!sc.ok) { log.push('[문장] scrub 걸림 → 템플릿'); return { mode: 'template', reason: 'SCRUB_HIT', text: templateText(f), tokens: 0 }; }
  let json;
  try { json = await callApi(apiKey, body, TIMEOUT_MS); }
  catch (e) {
    // detail은 API 오류 문구(키 값 없음 — claude.js가 상태·메시지만 담는다). 400은 요청 형태 문제라 문구가 있어야 고친다.
    log.push('[문장] Claude 실패 ' + String((e && e.code) || e).slice(0, 40) + (e && e.detail ? ' — ' + String(e.detail).slice(0, 160) : '') + ' → 템플릿');
    return { mode: 'template', reason: 'CLAUDE_' + String((e && e.code) || 'FAIL').slice(0, 20), text: templateText(f), tokens: 0 };
  }
  const tokens = usageTokens(json);
  if (json.stop_reason !== 'end_turn') { log.push('[문장] stop_reason ' + json.stop_reason + ' → 템플릿'); return { mode: 'template', reason: 'STOP_' + String(json.stop_reason || '').slice(0, 20), text: templateText(f), tokens: tokens }; }
  const raw = responseText(json);
  const v1 = verifyModelText(raw, f);
  if (!v1.ok) { log.push('[문장] 자기검증(채우기 전) ' + v1.code + ' → 템플릿'); return { mode: 'template', reason: 'VERIFY_' + v1.code, text: templateText(f), tokens: tokens }; }
  const filled = fillText(raw, f);
  const v2 = verifyFilled(filled, f);
  if (!v2.ok) { log.push('[문장] 자기검증(채운 뒤) ' + v2.code + ' → 템플릿'); return { mode: 'template', reason: 'VERIFY_' + v2.code, text: templateText(f), tokens: tokens }; }
  return { mode: 'claude', reason: '', text: filled, tokens: tokens };
}

// 목소리 목록 확인(brief:voices) — 없거나 30일 넘었으면 voices/list 1회(무료 GET). 브리핑 §3 D1 끝 조건 "voices/list에 선히 있음 — 없으면 중단·보고".
async function ensureVoices(st, log) {
  let cur = null;
  try { const r = await blobGet(st, 'brief:voices'); if (r.ok && r.data) cur = r.data; } catch (e) {}
  if (cur && cur.ts && (Date.now() - Number(cur.ts)) < 30 * 86400000) return cur;
  let v;
  try { v = await azureVoices(); } catch (e) { v = { ok: false, code: String((e && e.message) || e).slice(0, 40) }; }
  if (!v.ok) { log.push('[음성] voices/list 실패 ' + (v.code || '')); return cur; }
  const doc = { schema: 1, ts: Date.now(), region: v.region, total: v.total, ko: (v.ko || []).slice(0, 40), ko_count: (v.ko || []).length, sunhi: v.sunhi };
  try { await blobSet(st, 'brief:voices', doc); } catch (e) {}
  return doc;
}

async function voiceOf(st, s, text, today, log) {
  const out = { ok: false, reason: '', bytes: 0, chars: 0, provider: s.values.provider, voice: '' };
  if (!s.values.on) { out.reason = 'OFF'; return out; }
  const usage = await usageRead(st, today);
  if (s.values.provider === 'elevenlabs') {
    out.voice = s.values.voice_elevenlabs;
    if (!String(process.env.ELEVENLABS_API_KEY || '').trim()) { out.reason = 'ELEVENLABS_NO_KEY'; return out; }
    try { const buf = await elevenTts(text, s.values.voice_elevenlabs); out.ok = true; out.bytes = buf.length; out.chars = String(text).length; out.b64 = buf.toString('base64'); }
    catch (e) { out.reason = String((e && e.message) || e).slice(0, 40); log.push('[음성] ' + out.reason); }
    return out;
  }
  out.voice = s.values.voice_azure;
  const env = azureEnv(); if (!env.ok) { out.reason = 'AZURE_ENV_MISSING'; return out; }
  const vo = await ensureVoices(st, log);
  if (vo && Array.isArray(vo.ko) && vo.ko.length && vo.ko.indexOf(s.values.voice_azure) < 0) { out.reason = 'VOICE_MISSING'; log.push('[음성] ' + s.values.voice_azure + ' 이 voices/list에 없음 — 중단'); return out; }
  const ssml = ssmlOf(text, s.values.voice_azure, s.values.rate);
  if ((usage.azure_chars || 0) + ssml.length > CAP_AZURE_CHARS) { out.reason = 'AZURE_CAP'; log.push('[음성] 월 상한 → 글 카드'); return out; }
  try { const buf = await azureTts(ssml); out.ok = true; out.bytes = buf.length; out.chars = ssml.length; out.b64 = buf.toString('base64'); }
  catch (e) { out.reason = String((e && e.message) || e).slice(0, 40); log.push('[음성] ' + out.reason); }
  return out;
}

// opts: {force, by}. 반환 {ok, skipped?, doc}. 같은 날 생성본이 있으면 force가 아닌 한 다시 만들지 않는다(유료 호출 2회 방지).
async function generate(st, opts) {
  const o = opts || {}; const today = kstToday(); const t0 = Date.now(); const log = [];
  const dayKey = 'brief:day:' + today;
  if (!o.force) {
    try { const r = await blobGet(st, dayKey); if (r.ok && r.data && r.data.text) return { ok: true, skipped: 'exists', doc: r.data }; } catch (e) {}
  }
  const s = await settingsRead(st);
  const cols = await readCols(st);
  const abJob = await readAbJob(st, today);
  const f = computeFacts(cols, abJob, today);
  const missing = Object.keys(cols).filter(function (k) { return !cols[k]; });
  if (missing.length) log.push('[집계] 못 읽은 컬렉션 ' + missing.join(','));
  const sen = await sentence(st, f, today, log);
  const vo = await voiceOf(st, s, sen.text, today, log);
  const facts = { appr_pm: f.appr_pm, appr_boss: f.appr_boss, appr_amt: f.appr_amt, task_open: f.task_open, task_due: f.task_due, task_review: f.task_review, bid_soon: f.bid_soon, bid_new: f.bid_new,
    veh_30: f.veh_30, veh_over: f.veh_over, lic_30: f.lic_30, ab: f.ab ? { day: f.ab.day, cnt: f.ab.cnt, ton: f.ab.ton, prov: f.ab.prov, src_ts: f.ab.src_ts } : null };
  const doc = { schema: 1, date: today, ts: Date.now(), by: String(o.by || 'cron'), mode: sen.mode, reason: sen.reason, text: sen.text, len: sen.text.length, facts: facts, cols_missing: missing,
    provider: vo.provider, voice: vo.voice, rate: s.values.rate, mp3: { ok: vo.ok, bytes: vo.bytes, chars: vo.chars, reason: vo.reason }, claude: { model: MODEL, tokens: sen.tokens }, ms: Date.now() - t0, log: log.slice(0, 20) };
  const w = await blobSet(st, dayKey, doc);
  if (!w.ok) return { ok: false, code: w.code, doc: doc };
  if (vo.ok && vo.b64) { await blobSet(st, 'brief:mp3:' + today, { schema: 1, date: today, ts: doc.ts, fmt: 'audio/mpeg', bytes: vo.bytes, b64: vo.b64 }); }
  await usageAdd(st, today, { azure_chars: vo.ok ? vo.chars : 0, claude_tokens: sen.tokens, runs: 1 });
  await logAppend(st, { ts: doc.ts, date: today, by: doc.by, mode: sen.mode, reason: sen.reason, len: doc.len, tokens: sen.tokens, chars: vo.ok ? vo.chars : 0, mp3: vo.ok, mp3_reason: vo.reason, ms: doc.ms });
  return { ok: true, doc: doc };
}

module.exports = { SETTINGS_KEY, PROVIDERS, RATES, CAP_AZURE_CHARS, CAP_CLAUDE_TOKENS, ADMIN_RUNS_PER_DAY, MODEL, LEN_MIN, LEN_MAX,
  kstToday, kstDate, hhmm, dayDiff, shiftDay, prevWeekday, koDate, fmtWon, computeFacts, fillsOf, templateText, claudeBody, verifyModelText, fillText, verifyFilled, xmlEsc, ssmlOf,
  settingsDefaults, settingsValid, settingsNormalize, settingsRead, settingsPublic, azureEnv, azureVoices, azureTts, elevenTts, ensureVoices,
  usageRead, usageAdd, capState, logAppend, logRead, generate };
