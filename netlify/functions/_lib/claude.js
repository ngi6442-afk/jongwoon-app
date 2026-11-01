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
    throw new ApiError(aborted ? 'TIMEOUT' : 'NETWORK', String((e && e.message) || e), !aborted);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new ApiError('AUTH', 'API 키가 거부되었습니다(' + res.status + ')', false);
  if (res.status === 429) throw new ApiError('RATE_LIMIT', '요청이 몰렸습니다(429)', true);
  if (res.status >= 500) throw new ApiError('SERVER', 'API 서버 오류(' + res.status + ')', true);
  if (res.status >= 400) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { /* 원문 사용 */ }
    throw new ApiError('BAD_REQUEST', msg, false);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError('PARSE', '응답 JSON 파싱 실패: ' + text.slice(0, 120), true);
  }
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

module.exports = { API_URL, API_VERSION, ApiError, callApi, responseText, scrubPayload, parseJsonOut, usageTokens };
