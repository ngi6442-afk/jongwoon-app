'use strict';
// 넣기 박스 판단(v423, 체크 31 — PM 11/5 "계약서를 넣으면 에이전트가 유형을 판단" · "서류 등록 채널 하나").
// 파일 하나를 보고 종류(계약서·채운 서류·받은 서류·빈 양식·회사 증빙)를 가리고, 계약서면 값과 계약 유형을, 서류면 들어갈 자리를 고른다.
// 출력은 parse:<att id>에 남고(AI 판단 원본), 사람이 고친 것은 box:fixes에 쌓여 다음 판단의 프롬프트에 들어간다(출력↔입력 간극 학습).
// 개인정보 파일명(건강진단·명단·신분증 등)은 모델에 보내지 않는다. 본문 텍스트의 주민등록번호 꼴은 전송 전에 가린다. 요청 한도를 넘는 큰 파일은 파일명으로만 판단한다.
const CL = require('./claude');
const DD = require('./docdiff');
const LN = require('./learn');

const TIMEOUT_MS = 240000;
const MAX_TOKENS = 6000;   // 답과 사고를 함께 제한한다 — 실측 출력 최대 1,117이나 서류·계약 목록이 긴 경우 여유
const EFFORT = 'medium';
const TEXT_MAX = 8000;
const PDF_B64_MAX = 31000000;     // API 요청 한도 32MB 안쪽(프롬프트 몫 남김) — 넘으면 파일명으로만 판단
const IMG_B64_MAX = 6900000;      // 그림 5MB
const FIX_MAX = 12;
const CLS = ['contract', 'filled', 'received', 'blank', 'proof', 'other'];
const SUB = ['asbestos_survey', 'bldg', 'biz', 'none'];
const CON_TYPE = ['asbestos', 'demolition', 'waste', 'dredge', 'none'];
const SIDE = ['을', '갑', '모름'];

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    cls: { type: 'string', enum: CLS }, sub: { type: 'string', enum: SUB }, doc_name: { type: 'string' }, pii: { type: 'string', enum: ['0', '1', '2'] },
    title: { type: 'string' }, amount: { type: 'number' }, date_contract: { type: 'string' }, date_start: { type: 'string' }, date_end: { type: 'string' },
    client: { type: 'string' }, site: { type: 'string' }, guarantee: { type: 'number' },
    con_type: { type: 'string', enum: CON_TYPE }, combo: { type: 'boolean' }, pub: { type: 'boolean' }, why_type: { type: 'string' }, why_pub: { type: 'string' }, our_side: { type: 'string', enum: SIDE },
    target: { type: 'string' }, contract_id: { type: 'string' }, tpl_key: { type: 'string' }, draft_tpl: { type: 'string' }, why: { type: 'string' },
  },
  required: ['cls', 'sub', 'doc_name', 'pii', 'title', 'amount', 'date_contract', 'date_start', 'date_end', 'client', 'site', 'guarantee', 'con_type', 'combo', 'pub', 'why_type', 'why_pub', 'our_side', 'target', 'contract_id', 'tpl_key', 'draft_tpl', 'why'],
};

function cut(s, n) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
function maskRrn(s) { return String(s || '').replace(/\b\d{6}\s*-\s*[1-8]\d{6}\b/g, '[주민번호 가림]').replace(/\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[1-8]\d{6}\b/g, '[주민번호 가림]'); }   // 외국인등록번호·하이픈 없는 13자리 포함
function xmlText(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'g'); let m, out = [];
  while ((m = re.exec(xml)) && out.length < 4000) { const t = m[1].replace(/<[^>]+>/g, '').trim(); if (t) out.push(t); }
  return out.join(' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// 구형 hwp(OLE) 미리보기 글 PrvText(UTF-16) — 외부 라이브러리 없이 복합 문서 구조만 따라간다. 못 읽으면 ''.
function hwpPrvText(buf) {
  try {
    if (buf.length < 512 || buf.readUInt32LE(0) !== 0xE011CFD0) return '';
    const secSize = 1 << buf.readUInt16LE(30), miniSize = 1 << buf.readUInt16LE(32), END = 0xFFFFFFFA;
    const nFat = buf.readUInt32LE(44), dirStart = buf.readUInt32LE(48), miniCut = buf.readUInt32LE(56), miniFatStart = buf.readUInt32LE(60), difStart = buf.readUInt32LE(68);
    const off = function (s) { return (s + 1) * secSize; };
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = buf.readUInt32LE(76 + i * 4); if (s < END) fatSecs.push(s); }
    let dif = difStart, g0 = 0;
    while (dif < END && g0++ < 4096 && fatSecs.length < nFat) { const o = off(dif); for (let i = 0; i < secSize / 4 - 1 && fatSecs.length < nFat; i++) { const s = buf.readUInt32LE(o + i * 4); if (s < END) fatSecs.push(s); } dif = buf.readUInt32LE(o + secSize - 4); }
    const per = secSize / 4;
    const next = function (s) { return buf.readUInt32LE(off(fatSecs[Math.floor(s / per)]) + (s % per) * 4); };
    const read = function (start) { const out = []; let s = start, g = 0; while (s < END && g++ < 200000) { out.push(buf.slice(off(s), off(s) + secSize)); s = next(s); } return Buffer.concat(out); };
    const dir = read(dirStart);
    let root = null, prv = null;
    for (let p = 0; p + 128 <= dir.length; p += 128) {
      const nl = dir.readUInt16LE(p + 64); if (nl < 2) continue;
      const name = dir.slice(p, p + nl - 2).toString('utf16le'), type = dir[p + 66], start = dir.readUInt32LE(p + 116), size = dir.readUInt32LE(p + 120);
      if (type === 5) root = { start: start, size: size };
      if (name === 'PrvText') prv = { start: start, size: size };
    }
    if (!prv || !prv.size) return '';
    let data;
    if (prv.size >= miniCut || !root) data = read(prv.start).slice(0, prv.size);
    else {
      const ms = read(root.start), mf = read(miniFatStart), out = [];
      let s = prv.start, g = 0;
      while (s < END && g++ < 100000) { out.push(ms.slice(s * miniSize, (s + 1) * miniSize)); s = mf.readUInt32LE(s * 4); }
      data = Buffer.concat(out).slice(0, prv.size);
    }
    return data.toString('utf16le').replace(/\s+/g, ' ').trim();
  } catch (e) { return ''; }
}

// 파일 → 모델에 보낼 내용. pdf·그림은 그대로, 나머지는 앞부분 글자만.
function extractText(ext, buf) {
  try {
    if (ext === 'xlsx') {
      const x = DD.xlsxCells(buf); if (!x.ok) return '';
      const out = [];
      x.names.slice(0, 6).forEach(function (nm) {
        out.push('[시트 ' + nm + ']');
        const cells = x.sheets[nm].cells;
        Object.keys(cells).slice(0, 400).forEach(function (ref) { const c = cells[ref]; if (c && c.t !== 'blank' && c.t !== 'f' && String(c.v) !== '') out.push(ref + '=' + cut(c.v, 60)); });
      });
      return out.join(' ');
    }
    if (ext === 'docx') { const p = DD.docxParas(buf); return p ? p.join(' ') : ''; }
    const z = DD.zipEntries(buf);
    if (ext === 'hwpx') return Object.keys(z).filter(function (n) { return /Contents\/section\d+\.xml$/i.test(n); }).sort().map(function (n) { return z[n] ? xmlText(z[n].toString('utf8'), 'hp:t') : ''; }).join(' ');
    if (ext === 'pptx') return Object.keys(z).filter(function (n) { return /ppt\/slides\/slide\d+\.xml$/i.test(n); }).sort().slice(0, 20).map(function (n) { return z[n] ? xmlText(z[n].toString('utf8'), 'a:t') : ''; }).join(' ');
    return '';
  } catch (e) { return ''; }
}

function fixLine(f) {
  if (!f || typeof f !== 'object') return '';
  if (f.k === 'doc') return (f.doc ? cut(f.doc, 40) + ' 서류: ' : '') + cut(f.from, 60) + ' → ' + cut(f.to, 60);
  const from = f.from || {}, to = f.to || {}, ch = [];
  Object.keys(to).forEach(function (k) { if (String(from[k]) !== String(to[k])) ch.push(k + ' ' + cut(from[k], 24) + '→' + cut(to[k], 24)); });
  return ch.length ? (f.title ? '"' + cut(f.title, 40) + '" ' : '') + ch.join(', ') : '';
}

function buildPrompt(name, ctx, fixes, text, mode) {
  const c = ctx || {}, L = [];
  L.push('파일명: ' + cut(name, 120));
  L.push('직원이 앱의 서류 넣기 박스에 넣은 파일 하나를 보고 아래 값을 채워라. 문서에 적힌 값만 쓴다. 추정 금지, 없으면 빈 문자열이나 0. 주민등록번호·연락처·계좌번호는 어떤 칸에도 쓰지 않는다.');
  L.push('');
  L.push('cls(파일 종류): contract = 공사·용역·위수탁 계약서(날인본·사본·계약 서류 묶음 포함, 변경계약서 포함) / filled = 우리 회사가 작성해 내는 서류에 값을 채운 것(착공계·준공계·서약서·계획서·신고서·공문·견적서·사진대지 등) / received = 외부에서 받은 서류(필증·보험증권·보증서·증명서·세금계산서·발주처 공문·측정 결과 등) / blank = 값을 채우기 전의 빈 양식 / proof = 특정 계약과 상관없는 우리 회사 증빙(우리 회사 사업자등록증·건설업·폐기물 등록증·면허·신용평가·안전성평가 등) / other = 위 어디에도 못 넣음.');
  L.push('sub: asbestos_survey = 석면조사 결과서, bldg = 건축물대장, biz = 거래 상대의 사업자등록증·신분증, 아니면 none. 이때 cls는 received.');
  L.push('doc_name: 문서 제목 원문(40자 안). why: 그렇게 본 근거 한 줄.');
  L.push('pii: 1 = 근로자 명단·위임장·신분증 사본·재직증명서처럼 개인을 식별하는 정보가 있음, 2 = 건강진단 결과, 0 = 없음.');
  L.push('');
  L.push('cls가 contract일 때만 채운다(아니면 비움): title 공사명·계약명, amount 계약금액(숫자, 원 단위, 부가세 포함액 우선), date_contract 계약일 YYYY-MM-DD, date_start 착공일 YYYY-MM-DD, date_end 준공(예정)일 YYYY-MM-DD, client 발주자·도급인 이름, site 현장(공사) 주소, guarantee 계약보증금(숫자).');
  L.push('con_type(계약 유형): asbestos = 석면 해체·제거 / demolition = 건축물 철거·해체(석면 없음) / waste = 폐기물 수집·운반·처리 위수탁 / dredge = 준설·하수도·관로·배수시설 유지보수 등 시설공사 / none = 판단 불가. combo = 석면과 건축물 철거가 한 계약이면 true. pub = 발주자가 국가·지자체·공공기관·공기업·교육청·군부대면 true. why_type·why_pub = 근거 한 줄. our_side = 우리 회사(종운환경·종운건설)가 수급인이면 을, 도급인이면 갑, 모르면 모름.');
  if (Array.isArray(c.docs) && c.docs.length) {
    L.push(''); L.push('이 계약의 서류 목록(target에 가장 맞는 id를 쓴다, 맞는 것이 없으면 빈 문자열):');
    c.docs.slice(0, 150).forEach(function (d) { L.push(cut(d.id, 80) + ' = ' + cut(d.s, 40) + ' > ' + cut(d.n, 60)); });
  }
  if (Array.isArray(c.drafts) && c.drafts.length) {
    L.push(''); L.push('앱이 만들었거나 만들 수 있는 서류(cls가 filled이고 이 서류로 보이면 draft_tpl에 tpl을 쓴다, 아니면 빈 문자열):');
    c.drafts.slice(0, 40).forEach(function (d) { L.push(cut(d.tpl, 40) + ' = ' + cut(d.n, 60)); });
  }
  if (Array.isArray(c.cons) && c.cons.length) {
    L.push(''); L.push('진행 중인 계약(문서의 공사명·발주처·현장이 분명히 일치할 때만 contract_id에 id를 쓴다, 아니면 빈 문자열):');
    c.cons.slice(0, 60).forEach(function (d) { L.push(cut(d.id, 40) + ' = ' + cut(d.c, 40) + ' / ' + cut(d.t, 60) + ' / ' + cut(d.s, 40)); });
  }
  if (Array.isArray(c.tpls) && c.tpls.length) {
    L.push(''); L.push('양식 목록(cls가 blank이면 tpl_key에 가장 맞는 키를 쓴다, 없으면 빈 문자열):');
    c.tpls.slice(0, 40).forEach(function (d) { L.push(cut(d.k, 40) + ' = ' + cut(d.n, 60)); });
  }
  const fl = (Array.isArray(fixes) ? fixes : []).slice(-FIX_MAX).map(fixLine).filter(Boolean);
  if (fl.length) { L.push(''); L.push('사람이 최근에 고친 판단(같은 실수를 반복하지 말 것):'); fl.forEach(function (x) { L.push('- ' + x); }); }
  if (mode === 'text') { L.push(''); L.push('파일 본문 앞부분:'); L.push(maskRrn(text).slice(0, TEXT_MAX)); }
  if (mode === 'name') { L.push(''); L.push('본문을 읽지 못했다. 파일명과 위 목록만으로 판단하고, 값은 비워라.'); }
  return L.join('\n');
}

function normJudge(o, ctx) {
  const c = ctx || {}, x = o && typeof o === 'object' ? o : {};
  const isDate = function (s) { s = String(s || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
  const has = function (list, key, v) { v = String(v || ''); return (Array.isArray(list) && list.some(function (d) { return d && String(d[key]) === v; })) ? v : ''; };
  const clean = function (s, n) { const t = cut(s, n); return (t && !LN.piiScan(t).ok) ? '' : t; };
  const cls = CLS.indexOf(x.cls) >= 0 ? x.cls : 'other', isCon = cls === 'contract';
  const piiN = Number(x.pii);
  return {
    doc: 'box', cls: cls, sub: SUB.indexOf(x.sub) >= 0 ? x.sub : 'none', doc_name: clean(x.doc_name, 60), pii: (piiN === 1 || piiN === 2) ? piiN : 0, why: clean(x.why, 120),
    con: isCon ? { title: clean(x.title, 100), amount: Number(x.amount) > 0 ? Math.round(Number(x.amount)) : 0, d1: isDate(x.date_contract), d2: isDate(x.date_start), d3: isDate(x.date_end), client: clean(x.client, 60), site: clean(x.site, 100), guarantee: Number(x.guarantee) > 0 ? Math.round(Number(x.guarantee)) : 0 } : null,
    con_type: (isCon && CON_TYPE.indexOf(x.con_type) >= 0) ? x.con_type : 'none', combo: isCon && x.combo === true, pub: isCon ? x.pub !== false : true, why_type: isCon ? clean(x.why_type, 80) : '', why_pub: isCon ? clean(x.why_pub, 80) : '', our_side: SIDE.indexOf(x.our_side) >= 0 ? x.our_side : '모름',
    target: has(c.docs, 'id', x.target), contract_id: has(c.cons, 'id', x.contract_id), tpl_key: has(c.tpls, 'k', x.tpl_key), draft_tpl: has(c.drafts, 'tpl', x.draft_tpl),
  };
}

// 개인정보 파일명 — 모델 호출 없이 판단. 학습 제외 정규식(forbid_re)은 '주민'·'건강'만으로 걸려 주민센터 계약서·건강보험 완납증명까지 막으므로 입구는 서류 이름 단위로 따로 둔다
const GUARD_RE = /건강\s*(?:진단|검진|검사)|검진|건진|명단|명부|인적\s*사항|신분증|주민\s*등록|health|roster/i;
const GUARD_HEALTH_RE = /건강\s*(?:진단|검진|검사)|검진|건진|health/i;
const GUARD_EXCEPT_RE = /계약서/;   // '건강검진센터 철거공사 계약서' 같은 계약 문서는 내용을 읽는다. '…공사_건강진단 결과표'는 막는다(v424 검토)
function nameGuard(name) {
  const n = String(name || '').normalize('NFC');
  if (!GUARD_RE.test(n) || GUARD_EXCEPT_RE.test(n)) return null;
  // doc_name은 비운다 — 파일명에 사람 이름이 섞이므로 고친 판단 기록·화면 문구로 번지지 않게
  return { doc: 'box', cls: 'received', sub: 'none', doc_name: '', pii: GUARD_HEALTH_RE.test(n) ? 2 : 1, why: '파일명이 개인정보 서류여서 내용을 읽지 않았습니다', con: null, con_type: 'none', combo: false, pub: true, why_type: '', why_pub: '', our_side: '모름', target: '', contract_id: '', tpl_key: '', draft_tpl: '', read: 'none' };
}

// v424 표식 — 앱이 만든 서류를 고친 파일. 어느 계약·양식인지 이미 알므로 모델을 부르지 않는다(비용 0·전송 0, 직원이 고를 것도 없음).
// 개인정보 등급: 사람 칸이 없다고 확인한 양식만 0에서 시작하고(운영 양식 18종 실측 11/6), 나머지는 1. 0 후보도 파일 전체를 훑어 주민번호 꼴이나 AI 초안에 없던 휴대폰·계좌 꼴이 있으면 1.
const MARK_PII0 = { contract_pledge: 1, seal_reg: 1, bond_waiver: 1, labor_exempt: 1, quote_env: 1, quote_con: 1, settle_doc: 1, safety_cost: 1, safety_rule: 1, bid_rate: 1, qual_packet: 1, adv_pay: 1, work_complete: 1 };
const SCAN_RRN = [/\d{6}\s*[-\u2010-\u2015\uFF0D]\s*[1-8]\d{6}/, /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[1-8]\d{6}(?!\d)/];
const SCAN_NUM_G = [/(?<!\d)01[016789][\s-]?\d{3,4}[\s-]?\d{4}(?!\d)/g, /(?<![\d-])\d{2,6}-\d{2,6}-\d{5,8}(?![\d-])/g];
const SCAN_BIZ = /^\d{3}-\d{2}-\d{5}$/;   // 사업자등록번호 꼴은 계좌가 아니다
const SCAN_PART = /\.(?:xml|hpf|txt)$/i, SCAN_JOIN = /(?:sharedStrings|comments|section\d+|masterpage\d*|header\d*|footer\d*)\.xml$/i;
function scanParts(buf) {
  const out = [], z = DD.zipEntries(buf);
  Object.keys(z).forEach(function (n) {
    if (!SCAN_PART.test(n) || !z[n]) return;
    const x = z[n].toString('utf8'), sp = x.replace(/<[^>]+>/g, ' ');
    out.push(sp);
    if (SCAN_JOIN.test(n)) out.push(x.replace(/<[^>]+>/g, ''));   // 글자 조각으로 쪼개진 값
    const m12 = /\.xml$/i.test(n) ? x.match(/<v>\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[3-8]\d{6}<\/v>/) : null;   // 숫자 칸에서 앞 0이 빠진 2000년대생
    if (m12) out.push('000000-1000000');
  });
  return out;
}
function numsOf(texts) { const seen = {}; texts.forEach(function (t) { SCAN_NUM_G.forEach(function (re) { (t.match(re) || []).forEach(function (v) { if (!SCAN_BIZ.test(v)) seen[v.replace(/[\s-]/g, '')] = 1; }); }); }); return seen; }
// 사람 정보 꼴이 있는가 — draftBuf가 있으면 초안에 이미 있던 회사 번호는 뺀다. 못 읽으면 닫힌 쪽
function markScan(buf, draftBuf) {
  try {
    const tx = scanParts(buf);
    if (tx.some(function (t) { return SCAN_RRN.some(function (re) { return re.test(t); }); })) return true;
    const now = numsOf(tx), base = draftBuf ? numsOf(scanParts(draftBuf)) : {};
    return Object.keys(now).some(function (k) { return !base[k]; });
  } catch (e) { return true; }
}
function markJudge(ext, buf, m) {
  let pii = Object.prototype.hasOwnProperty.call(MARK_PII0, m.tpl) ? 0 : 1;
  if (!pii && markScan(buf, m.draftBuf || null)) pii = 1;
  return { doc: 'box', cls: 'filled', sub: 'none', doc_name: '', pii: pii, why: '앱이 만든 서류의 표식으로 찾았습니다', con: null, con_type: 'none', combo: false, pub: true, why_type: '', why_pub: '', our_side: '모름', target: '', contract_id: m.cid, tpl_key: '', draft_tpl: m.tpl, read: 'mark' };
}

async function judgeBox(a) {
  const name = String(a.name || ''), ctx = a.ctx || {}, b64 = String(a.b64 || '');
  const guard = nameGuard(name); if (guard) return guard;
  const key = String(process.env.GW_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY' };
  const ext = String((name.match(/\.([a-z0-9]+)$/i) || [0, ''])[1]).toLowerCase();
  const content = [];
  let mode = 'name', text = '';
  if (ext === 'pdf') { if (b64.length <= PDF_B64_MAX) { content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }); mode = 'vision'; } }
  else if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') { if (b64.length <= IMG_B64_MAX) { content.push({ type: 'image', source: { type: 'base64', media_type: ext === 'png' ? 'image/png' : 'image/jpeg', data: b64 } }); mode = 'vision'; } }
  else {
    const buf = Buffer.from(b64, 'base64');
    text = ext === 'hwp' ? hwpPrvText(buf) : extractText(ext, buf);
    if (text) mode = 'text';
  }
  content.push({ type: 'text', text: buildPrompt(name, ctx, a.fixes, text, mode) });
  const body = { model: String(process.env.CLAUDE_PARSE_MODEL || 'claude-sonnet-5').trim(), max_tokens: MAX_TOKENS, output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } }, messages: [{ role: 'user', content: content }] };
  let json;
  try { json = await CL.callApi(key, body, TIMEOUT_MS); }
  catch (e) {
    if (e && e.retryable) { await new Promise(function (r) { setTimeout(r, 3000); }); try { json = await CL.callApi(key, body, TIMEOUT_MS); } catch (e2) { return { error: String((e2 && e2.code) || 'CLAUDE_FAILED') }; } }
    else return { error: String((e && e.code) || 'CLAUDE_FAILED') };
  }
  const u = (json && json.usage) || {}, usage = { in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0 };
  if (json && json.stop_reason === 'max_tokens') return { error: 'MAX_TOKENS', usage: usage };
  if (json && json.stop_reason === 'refusal') return { error: 'REFUSAL', usage: usage };
  const out = CL.parseJsonOut(CL.responseText(json));
  if (!out) return { error: 'NO_JSON', usage: usage };
  const res = normJudge(out, ctx);
  res.read = mode;
  res.usage = usage;
  return res;
}

module.exports = { judgeBox, normJudge, nameGuard, markJudge, markScan, buildPrompt, hwpPrvText, extractText, maskRrn, SCHEMA };
