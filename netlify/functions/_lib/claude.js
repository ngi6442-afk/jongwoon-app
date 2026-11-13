'use strict';
// Anthropic Messages API 호출 공통(v410, 계약 D4 1일차 — 설계 §5 "callApi·scrubPayload를 _lib/claude.js로 승격").
// promoai.js(블로그)가 갖고 있던 callApi·ApiError·responseText·scrubPayload를 그대로 옮기고, promoai.js는 여기서 받아 같은 이름으로 재수출한다(블로그 동작 불변).
// 규칙: 키는 호출부가 인자로 넘긴다(GW_ANTHROPIC_KEY 하나, 폴백 없음) · 금지 문자열은 전송 직전 scrubPayload로 재검사하고 걸리면 조용히 지우지 않고 오류로 드러낸다 ·
//       TIMEOUT은 재시도하지 않는다(끊어도 서버 생성은 계속돼 요금만 두 배) · 개발 중 실호출 금지(테스트는 dry 경로·순수 함수만).

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

class ApiError extends Error {
  constructor(code, detail, retryable) {
    super(code + ': ' + detail);
    this.code = code;
    this.detail = detail;
    this.retryable = !!retryable;
  }
}

// 'fetch failed' 같은 묶음 오류에 실제 원인 코드(undici cause — UND_ERR_HEADERS_TIMEOUT·ECONNRESET 등)를 붙인다(진단용 — 키 값은 들어가지 않는다)
function errDetail(e) {
  const m = String((e && e.message) || e);
  const c = (e && e.cause) ? String(e.cause.code || e.cause.name || '') : '';
  return (c && m.indexOf(c) < 0) ? m + ' (' + c + ')' : m;
}
// 상태 코드 규칙(callApi·callApiStream 공통) — 2xx면 null
function statusError(status, text) {
  if (status === 401 || status === 403) return new ApiError('AUTH', 'API 키가 거부되었습니다(' + status + ')', false);
  if (status === 429) return new ApiError('RATE_LIMIT', '요청이 몰렸습니다(429)', true);
  if (status >= 500) return new ApiError('SERVER', 'API 서버 오류(' + status + ')', true);
  if (status >= 400) {
    let msg = String(text || '').slice(0, 200);
    try { const j = JSON.parse(text); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { /* 원문 사용 */ }
    return new ApiError('BAD_REQUEST', msg, false);
  }
  return null;
}

async function callApi(apiKey, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    // TIMEOUT은 재시도하지 않는다 — 10분짜리를 한 번 더 돌리면 백그라운드 15분 상한을 뚫고,
    // 끊긴 요청도 서버 생성은 계속돼 요금이 두 배로 나간다. NETWORK(즉시 실패)만 재시도.
    throw new ApiError(aborted ? 'TIMEOUT' : 'NETWORK', errDetail(e), !aborted);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const se = statusError(res.status, text);
  if (se) throw se;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError('PARSE', '응답 JSON 파싱 실패: ' + text.slice(0, 120), true);
  }
}

// 긴 생성(사진AI 초안)용 스트리밍 호출 — 11/13 운영 실측: 응답 전체를 기다리는 callApi는 Node fetch(undici)의 '응답 머리 300초' 제한에 걸려
//   5분 넘는 생성이 'fetch failed'(NETWORK)로 끊기고, 재시도 1회까지 600초를 날렸다(사진 20장 + 2단계 판독표 출력 — 성공은 5분 안, 실패는 시작→실패 605초 = 300초 × 2).
//   stream:true면 머리가 곧바로 오고 토큰·ping이 이어져 그 제한에 안 걸린다. 전체 상한은 timeoutMs(호출부 10분) — 본문을 다 받을 때까지 타이머를 유지한다.
//   돌려주는 모양은 callApi(비스트리밍 JSON)와 같다: { id, type, model, content:[{type:'text', text}], stop_reason, stop_sequence, usage } — 생각 블록은 버린다.
//   응답이 이벤트 스트림이 아니면(시험 흉내·프록시) 본문 JSON을 그대로 읽는다. 상태 코드 규칙은 callApi와 같다(statusError).
//   머리를 받은 뒤 끊기면 재시도하지 않는다(retryable false — 몇 분짜리를 한 번 더 돌리면 백그라운드 15분 상한을 뚫는다, 서버 재시도 규칙이 나중에 다시 한다).
async function callApiStream(apiKey, body, timeoutMs) {
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(function () { fired = true; ctl.abort(); }, timeoutMs);
  const isAbort = function (e) { return fired || !!(e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))); };
  try {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
        body: JSON.stringify(Object.assign({}, body, { stream: true })),
        signal: ctl.signal,
      });
    } catch (e) {
      const ab = isAbort(e);
      throw new ApiError(ab ? 'TIMEOUT' : 'NETWORK', errDetail(e), !ab);
    }
    const ct = (res && res.headers && typeof res.headers.get === 'function') ? String(res.headers.get('content-type') || '') : '';
    if (res.status < 200 || res.status >= 300 || !/text\/event-stream/i.test(ct) || !res.body) {
      let text = '';
      try { text = await res.text(); } catch (e) { const ab = isAbort(e); throw new ApiError(ab ? 'TIMEOUT' : 'NETWORK', errDetail(e), false); }
      const se = statusError(res.status, text);
      if (se) throw se;
      try { return JSON.parse(text); } catch (e) { throw new ApiError('PARSE', '응답 JSON 파싱 실패: ' + text.slice(0, 120), true); }
    }
    return await readSse(res.body, isAbort);
  } finally {
    clearTimeout(timer);
  }
}
// SSE 본문을 비스트리밍 응답 모양으로 모은다(이벤트 message_start·content_block_start·content_block_delta(text_delta)·message_delta·message_stop·ping·error).
async function readSse(stream, isAbort) {
  const dec = new TextDecoder('utf-8');
  const msg = { id: '', type: 'message', model: '', content: [], stop_reason: null, stop_sequence: null, usage: {} };
  const blocks = [];
  let buf = '', done = false, gotText = false;
  const handle = function (data) {
    let d; try { d = JSON.parse(data); } catch (e) { return; }
    if (!d || typeof d !== 'object') return;
    if (d.type === 'message_start' && d.message) { msg.id = String(d.message.id || ''); msg.model = String(d.message.model || ''); Object.assign(msg.usage, d.message.usage || {}); }
    else if (d.type === 'content_block_start' && d.content_block) blocks[d.index] = { type: String(d.content_block.type || ''), text: String(d.content_block.text || '') };
    else if (d.type === 'content_block_delta' && d.delta) {
      if (d.delta.type !== 'text_delta') return;   // 생각·서명 조각은 버린다
      const b = blocks[d.index] || (blocks[d.index] = { type: 'text', text: '' });
      b.text += String(d.delta.text || ''); gotText = true;
    }
    else if (d.type === 'message_delta') {
      if (d.delta && d.delta.stop_reason !== undefined) msg.stop_reason = d.delta.stop_reason;
      if (d.delta && d.delta.stop_sequence !== undefined) msg.stop_sequence = d.delta.stop_sequence;
      if (d.usage) Object.assign(msg.usage, d.usage);
    }
    else if (d.type === 'message_stop') done = true;
    else if (d.type === 'error') { const er = d.error || {}; throw new ApiError('SERVER', ('스트림 오류 ' + String(er.type || '') + ' ' + String(er.message || '')).trim().slice(0, 200), !gotText); }
  };
  const flush = function (raw) {
    const data = raw.split(/\r\n|\r|\n/).filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).replace(/^ /, ''); }).join('\n');
    if (data) handle(data);
  };
  try {
    for await (const chunk of stream) {
      buf += (typeof chunk === 'string') ? chunk : dec.decode(chunk, { stream: true });
      let m;
      while ((m = /\r\n\r\n|\n\n|\r\r/.exec(buf))) { flush(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
    }
    buf += dec.decode();
    if (buf.trim()) flush(buf);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const ab = isAbort(e);
    throw new ApiError(ab ? 'TIMEOUT' : 'NETWORK', errDetail(e), false);
  }
  if (!done) throw new ApiError('NETWORK', '스트림이 끝 표시 없이 끊김', false);
  msg.content = blocks.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return { type: 'text', text: b.text }; });
  return msg;
}

function responseText(json) {
  const blocks = (json && json.content) || [];
  let s = '';
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] && blocks[i].type === 'text' && blocks[i].text) s += blocks[i].text;
  }
  return s;
}

// obj(또는 문자열)를 직렬화해 forbidden 목록이 들어 있는지 본다.
// 공백·쉼표를 지운 평탄화 비교를 함께 해서 '200,000' / '경상북도 포항시 맑은물사업소'의 표기 변형도 잡는다.
// 반환 {ok:boolean, hit:string} — hit은 걸린 금지 문자열(비밀이므로 호출부가 마스킹해 로그에 남길 것).
function scrubPayload(obj, forbidden) {
  let s;
  try {
    s = (typeof obj === 'string') ? obj : JSON.stringify(obj);
  } catch (e) {
    return { ok: false, hit: '__SERIALIZE_FAILED__' };
  }
  if (s == null) s = '';
  const flat = s.replace(/[\s,]/g, '');
  const list = forbidden || [];
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i] == null ? '' : list[i]).trim();
    if (!t) continue;
    if (s.indexOf(t) >= 0) return { ok: false, hit: t };
    const ft = t.replace(/[\s,]/g, '');
    // 짧은 토큰의 평탄화 비교는 오탐이 나므로 4자 이상만
    if (ft.length >= 4 && flat.indexOf(ft) >= 0) return { ok: false, hit: t };
  }
  return { ok: true, hit: '' };
}

// 응답 본문에서 JSON 하나 꺼내기(```json 펜스 허용). 실패 null.
function parseJsonOut(text) {
  let t = String(text || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) t = m[1].trim();
  try { return JSON.parse(t); } catch (e) { return null; }
}
function usageTokens(json) {
  const u = (json && json.usage) || {};
  return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

module.exports = { API_URL, API_VERSION, ApiError, callApi, callApiStream, readSse, errDetail, statusError, responseText, scrubPayload, parseJsonOut, usageTokens };
