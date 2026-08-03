'use strict';
// 석면조사서 판독(Claude 비전) + §94 신고대상 판정 — gw-data(동기 폴백)와 gw-parse-background(기본 경로) 공용

// §94조 신고대상 판정 — 자재 행(위치·면적)을 법 기준에 대조(판정은 코드가 확정)
function judgeAsbestos94(rows) {
  const PLANE = ['천장', '천정', '벽', '바닥', '지붕', '슬레이트', '텍스'];
  const INSUL = ['단열', '보온', '개스킷', '패킹', '실링'];
  const SPRAY = ['분무', '내화'];
  let plane = 0, insul = 0, pipe = 0, spray = false;
  (rows || []).forEach(function (r) {
    const t = String(r.mat || '') + String(r.loc || '');
    const a = Number(r.area) || 0;
    if (SPRAY.some(function (k) { return t.indexOf(k) >= 0; })) spray = true;
    if (PLANE.some(function (k) { return t.indexOf(k) >= 0; })) plane += a;
    else if (INSUL.some(function (k) { return t.indexOf(k) >= 0; })) insul += a;
    if (/파이프|배관|보온/.test(t) && r.len) pipe += Number(r.len) || 0;
  });
  const reasons = []; let target = false;
  if (spray) { target = true; reasons.push('분무재/내화피복재 사용 → 시행령 §94조2호(면적무관)'); }
  if (plane >= 50) { target = true; reasons.push('벽체·천장·바닥·지붕재 ' + Math.round(plane * 10) / 10 + '㎡ ≥ 50㎡ → §94조1호'); }
  if (insul >= 15) { target = true; reasons.push('단열·보온재 등 ' + Math.round(insul * 10) / 10 + '㎡ ≥ 15㎡ → §94조3호'); }
  if (pipe >= 80) { target = true; reasons.push('파이프 보온재 ' + Math.round(pipe) + 'm ≥ 80m → §94조4호'); }
  return { target: target, reasons: reasons, plane: Math.round(plane * 100) / 100, insul: Math.round(insul * 100) / 100 };
}

// Claude 비전 판독 — PDF/이미지(스캔본 포함)에서 명기값만 추출. 판정은 코드(judgeAsbestos94)가.
// ANTHROPIC_API_KEY(Netlify env) 필요.
async function claudeExtractAsbestos(buf, name, type) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY(Netlify 환경변수 ANTHROPIC_API_KEY 확인)' };
  const model = (process.env.CLAUDE_PARSE_MODEL || 'claude-sonnet-5').trim();
  const ext = (name || '').toLowerCase().split('.').pop();
  const b64 = buf.toString('base64');
  let media;
  if (ext === 'pdf') media = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].indexOf(ext) >= 0) {
    const mt = ext === 'jpg' ? 'jpeg' : ext;
    media = { type: 'image', source: { type: 'base64', media_type: 'image/' + mt, data: b64 } };
  } else return null;
  const prompt = '이 문서는 석면(건축물석면) 조사결과서다. 문서에 명기된 값만 추출하라(추정·해석 금지, 없으면 빈값). '
    + '① 개요: 조사기관명(org), 건축물 소재지(site), 건축물명(bldg_name), 의뢰인/발주자 기관명(owner), 건축년도(year), 구조(struct), 용도(use), 연면적㎡(total_floor, 숫자만), 석면함유 자재면적 합계㎡(summary_area, 숫자만). '
    + '② 석면함유자재 표의 각 행: 동·층(bldg), 자재성상/종류(mat, 예: 갈매기무늬텍스·다공성텍스·분무재·보온재), 위치/부위(loc, 예: 천장·벽체·바닥·지붕·파이프), 면적㎡(area, 숫자만), 석면 종류·함유율 표기 그대로(cnt, 예: "백석면 5%"), 파이프길이m(len, 있으면). '
    + '행 제외: 합계·"계"·소계 행(중복 합산 방지), 석면 불검출(N·불검출·"-") 자재 — 검출(Y) 자재만. 같은 자재가 요약표와 상세표에 중복되면 한 번만(요약표 우선). '
    + '표를 못 찾으면 {"rows":[],"note":"이유"}. '
    + '형식: {"org":"","site":"","bldg_name":"","owner":"","year":"","struct":"","use":"","total_floor":0,"summary_area":0,"rows":[{"bldg":"","mat":"","loc":"","area":0,"cnt":"","len":0}]}';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, max_tokens: 4096,
        messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] })
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status };
    const j = await resp.json();
    const txt = ((j.content || []).find(function (b) { return b.type === 'text'; }) || {}).text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'NO_JSON' };
    const data = JSON.parse(m[0]);
    const rows = Array.isArray(data.rows) ? data.rows.map(function (r) {
      return { bldg: String(r.bldg || '').slice(0, 40), mat: String(r.mat || '').slice(0, 40), loc: String(r.loc || '').slice(0, 20), area: Number(r.area) || 0, cnt: String(r.cnt || '').slice(0, 30), len: Number(r.len) || 0 };
    }) : [];
    return { org: String(data.org || '').slice(0, 60), site: String(data.site || '').slice(0, 80),
      bldg_name: String(data.bldg_name || '').slice(0, 60), owner: String(data.owner || '').slice(0, 60),
      year: String(data.year || '').slice(0, 12), struct: String(data.struct || '').slice(0, 40), use: String(data.use || '').slice(0, 40),
      total_floor: Number(data.total_floor) || 0,
      summary_area: Number(data.summary_area) || 0, rows: rows, judge: judgeAsbestos94(rows) };
  } catch (e) { return { error: 'PARSE_FAILED' }; }
}

// 계약서 판독 — 공사명·금액·계약/착공/준공일·발주자·현장주소(명기값만)
async function claudeExtractContract(buf, name) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY(Netlify 환경변수 ANTHROPIC_API_KEY 확인)' };
  const model = (process.env.CLAUDE_PARSE_MODEL || 'claude-sonnet-5').trim();
  const ext = (name || '').toLowerCase().split('.').pop();
  const b64 = buf.toString('base64');
  let media;
  if (ext === 'pdf') media = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].indexOf(ext) >= 0) {
    const mt = ext === 'jpg' ? 'jpeg' : ext;
    media = { type: 'image', source: { type: 'base64', media_type: 'image/' + mt, data: b64 } };
  } else return null;
  const prompt = '이 문서는 공사·용역 계약서(또는 계약 관련 서류 묶음)다. 문서에 명기된 값만 추출하라(추정 금지, 없으면 빈값). '
    + 'title 공사명/계약명, amount 계약금액(숫자만, 원 단위·부가세 포함액 우선), date_contract 계약(체결)일 YYYY-MM-DD, date_start 착공일 YYYY-MM-DD, date_end 준공(예정)일 YYYY-MM-DD, '
    + 'client 발주자/도급인 기관·업체명, site 현장(공사) 주소, guarantee 계약보증금액(숫자만, 있으면). '
    + '형식: {"title":"","amount":0,"date_contract":"","date_start":"","date_end":"","client":"","site":"","guarantee":0} JSON만 출력.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, max_tokens: 1024,
        messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] })
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status };
    const j = await resp.json();
    const txt = ((j.content || []).find(function (b) { return b.type === 'text'; }) || {}).text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'NO_JSON' };
    const data = JSON.parse(m[0]);
    const dt = function (s) { s = String(s || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
    return { doc: 'contract', title: String(data.title || '').slice(0, 100), amount: Number(data.amount) || 0,
      date_contract: dt(data.date_contract), date_start: dt(data.date_start), date_end: dt(data.date_end),
      client: String(data.client || '').slice(0, 60), site: String(data.site || '').slice(0, 100), guarantee: Number(data.guarantee) || 0 };
  } catch (e) { return { error: 'PARSE_FAILED' }; }
}

// 건축물대장 판독 — 대지위치·용도·구조·연면적·층수·사용승인일(명기값만). 철거·해체 서류의 기준자료
async function claudeExtractBldg(buf, name) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY(Netlify 환경변수 ANTHROPIC_API_KEY 확인)' };
  const model = (process.env.CLAUDE_PARSE_MODEL || 'claude-sonnet-5').trim();
  const ext = (name || '').toLowerCase().split('.').pop();
  const b64 = buf.toString('base64');
  let media;
  if (ext === 'pdf') media = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].indexOf(ext) >= 0) {
    const mt = ext === 'jpg' ? 'jpeg' : ext;
    media = { type: 'image', source: { type: 'base64', media_type: 'image/' + mt, data: b64 } };
  } else return null;
  const prompt = '이 문서는 건축물대장(일반/총괄표제부 등)이다. 명기된 값만 추출하라(추정 금지, 없으면 빈값). '
    + 'site 대지위치(도로명 우선), bldg_name 건물명, use 주용도, struct 주구조, total_floor 연면적㎡(숫자만), '
    + 'floors 층수(예: "지상3/지하1"), approved 사용승인일 YYYY-MM-DD(연도만 있으면 YYYY), area_bldg 건축면적㎡(숫자만), owner 소유자명(최근). '
    + '동이 여럿이면 표제부 기준 대표값. 형식: {"site":"","bldg_name":"","use":"","struct":"","total_floor":0,"floors":"","approved":"","area_bldg":0,"owner":""} JSON만.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, max_tokens: 1024,
        messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] })
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status };
    const j = await resp.json();
    const txt = ((j.content || []).find(function (b) { return b.type === 'text'; }) || {}).text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'NO_JSON' };
    const data = JSON.parse(m[0]);
    return { doc: 'bldg', site: String(data.site || '').slice(0, 100), bldg_name: String(data.bldg_name || '').slice(0, 60),
      use: String(data.use || '').slice(0, 40), struct: String(data.struct || '').slice(0, 40),
      total_floor: Number(data.total_floor) || 0, floors: String(data.floors || '').slice(0, 20),
      approved: String(data.approved || '').slice(0, 12), area_bldg: Number(data.area_bldg) || 0,
      owner: String(data.owner || '').slice(0, 60) };
  } catch (e) { return { error: 'PARSE_FAILED' }; }
}

// 사업자등록증·신분증 판독 — 발주처(갑) 정보 자동 입력용. 주민등록번호는 추출하지 않음(생년월일만)
async function claudeExtractBiz(buf, name) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY(Netlify 환경변수 ANTHROPIC_API_KEY 확인)' };
  const model = (process.env.CLAUDE_PARSE_MODEL || 'claude-sonnet-5').trim();
  const ext = (name || '').toLowerCase().split('.').pop();
  const b64 = buf.toString('base64');
  let media;
  if (ext === 'pdf') media = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].indexOf(ext) >= 0) {
    const mt = ext === 'jpg' ? 'jpeg' : ext;
    media = { type: 'image', source: { type: 'base64', media_type: 'image/' + mt, data: b64 } };
  } else return null;
  const prompt = '이 문서는 사업자등록증 또는 신분증(주민등록증·운전면허증)이다. 명기된 값만 추출하라(추정 금지, 없으면 빈값). '
    + 'doc_kind("사업자등록증"|"신분증"), name(상호 또는 성명), ceo(대표자 — 사업자등록증만), '
    + 'biz_no(사업자등록번호 — 사업자등록증만), birth(생년월일 YYYY-MM-DD — 신분증만. 주민등록번호 뒷자리는 절대 출력 금지), '
    + 'addr(사업장 소재지 또는 주소). '
    + '형식: {"doc_kind":"","name":"","ceo":"","biz_no":"","birth":"","addr":""} JSON만 출력.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, max_tokens: 512,
        messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] })
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status };
    const j = await resp.json();
    const txt = ((j.content || []).find(function (b) { return b.type === 'text'; }) || {}).text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'NO_JSON' };
    const data = JSON.parse(m[0]);
    return { doc: 'biz', doc_kind: String(data.doc_kind || '').slice(0, 12), name: String(data.name || '').slice(0, 60),
      ceo: String(data.ceo || '').slice(0, 30), biz_no: String(data.biz_no || '').slice(0, 20),
      birth: String(data.birth || '').slice(0, 12), addr: String(data.addr || '').slice(0, 100) };
  } catch (e) { return { error: 'PARSE_FAILED' }; }
}

// 등급확인서(신용평가·안전성평가) — 적격심사 등급·유효기간을 인허가 탭에 자동 반영하기 위한 판독(P5c)
async function claudeExtractGrade(buf, name) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { error: 'NO_API_KEY(Netlify 환경변수 ANTHROPIC_API_KEY 확인)' };
  const model = (process.env.CLAUDE_PARSE_MODEL || 'claude-sonnet-5').trim();
  const ext = (name || '').toLowerCase().split('.').pop();
  const b64 = buf.toString('base64');
  let media;
  if (ext === 'pdf') media = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].indexOf(ext) >= 0) {
    const mt = ext === 'jpg' ? 'jpeg' : ext;
    media = { type: 'image', source: { type: 'base64', media_type: 'image/' + mt, data: b64 } };
  } else return null;
  const prompt = '이 문서는 신용평가등급확인서(NICE 등) 또는 산업안전보건공단 안전성평가 결과 통보서다. '
    + '명기된 값만 추출하라(추정 금지, 없으면 빈값). '
    + 'doc_kind("신용평가확인서"|"안전성평가"), company(업체명 그대로), '
    + 'grade(등급 표기 그대로 — 예: B°, BB°, D. 기호° 포함해 원문 그대로), '
    + 'valid_from(유효기간 시작 YYYY-MM-DD), valid_until(유효기간 종료 YYYY-MM-DD), issued(평가일 또는 발급일 YYYY-MM-DD). '
    + '형식: {"doc_kind":"","company":"","grade":"","valid_from":"","valid_until":"","issued":""} JSON만 출력.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, max_tokens: 512,
        messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] })
    });
    if (!resp.ok) return { error: 'CLAUDE_' + resp.status };
    const j = await resp.json();
    const txt = ((j.content || []).find(function (b) { return b.type === 'text'; }) || {}).text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'NO_JSON' };
    const data = JSON.parse(m[0]);
    return { doc: 'grade', doc_kind: String(data.doc_kind || '').slice(0, 12), company: String(data.company || '').slice(0, 40),
      grade: String(data.grade || '').slice(0, 10), valid_from: String(data.valid_from || '').slice(0, 10),
      valid_until: String(data.valid_until || '').slice(0, 10), issued: String(data.issued || '').slice(0, 10) };
  } catch (e) { return { error: 'PARSE_FAILED' }; }
}

// 첨부 레코드 → 문서종류별 판독 라우팅 (kind 우선, 없으면 파일명)
async function parseAttachment(rec) {
  const name = rec.name || '';
  let kind = rec.kind || '';
  if (!kind) kind = /등록증|신분증|면허증/.test(name) ? 'biz'
    : (/대장/.test(name) ? 'bldg' : (/계약/.test(name) ? 'contract' : 'asbestos'));
  const buf = Buffer.from(rec.data, 'base64');
  if (kind === 'biz') return await claudeExtractBiz(buf, name);
  if (kind === 'bldg') return await claudeExtractBldg(buf, name);
  if (kind === 'contract') return await claudeExtractContract(buf, name);
  return await claudeExtractAsbestos(buf, name, rec.type);
}

module.exports = { judgeAsbestos94, claudeExtractAsbestos, claudeExtractContract, claudeExtractBldg, claudeExtractBiz, claudeExtractGrade, parseAttachment };
