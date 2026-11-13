// 사진AI 생성 스트리밍 게이트 — 체크 10 · 11/13 v455 배포 뒤 확인에서 찾은 운영 문제:
//   응답 전체를 기다리던 생성 호출(callApi)이 Node fetch(undici)의 '응답 머리 300초' 제한에 끊겨 5분 넘는 생성이 'fetch failed'(NETWORK)로 실패,
//   재시도 1회까지 600초(장량동 기록 5회 연속 — 시작→실패 605초 = 300초 × 2). 수리 = _lib/claude.js callApiStream(SSE) + generateDraft가 사용.
// 실행: node tools/promostream_check.mjs   (네트워크 없음 — fetch 흉내: Response + ReadableStream)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'netlify', 'functions');
const CL = require(join(FN, '_lib/claude.js'));
const PA = require(join(FN, '_lib/promoai.js'));
const PJ = require(join(FN, '_lib/promoai_job.js'));
let fails = 0, pass = 0;
const T = (name, ok, detail) => { if (ok) pass++; else fails++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + String(detail).slice(0, 500))); };
const enc = new TextEncoder();
const sse = (events, nl) => events.map(([ev, d]) => ('event: ' + ev + '\ndata: ' + JSON.stringify(d) + '\n\n').replace(/\n/g, nl || '\n')).join('');
const chunks = (bytes, n) => { const out = []; for (let i = 0; i < bytes.length; i += n) out.push(bytes.slice(i, i + n)); return out; };
const sseResponse = (text, n) => new Response(new ReadableStream({ start(c) { chunks(enc.encode(text), n || 7).forEach((b) => c.enqueue(b)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const realFetch = global.fetch;
let calls = [];
const useFetch = (fn) => { calls = []; global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return fn(url, opts, calls.length); }; };
const CREDIT_MSG = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const KEY = 'dummy-offline-key';
const FULL = '{"scenes":[],"title":"포항 장량동 우수받이 — 가나다 확인","body":"본문 한글 ⓐ 줄입니다."}';
const okEvents = (text) => [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', model: 'claude-sonnet-5', usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '생각 중' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['ping', { type: 'ping' }],
].concat(text.match(/[\s\S]{1,9}/g).map((t) => ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } }])).concat([
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 500 } }],
  ['message_stop', { type: 'message_stop' }],
]);

try {
  // ① 이벤트 스트림을 비스트리밍 응답 모양으로(한글이 7바이트 조각 경계에 걸려도 그대로) · 생각 블록 버림 · 사용량 합침 · 요청에 stream:true
  {
    useFetch(() => sseResponse(sse(okEvents(FULL)), 7));
    const r = await CL.callApiStream(KEY, { model: 'm', max_tokens: 10 }, 5000);
    const sent = JSON.parse(calls[0].opts.body);
    T('① SSE 모으기: 글 = 조각 합(한글·ⓐ가 바이트 조각 경계에 걸려도 그대로) · 생각 블록 버림 · stop_reason end_turn · 사용량 입력 1000·캐시 200·출력 500 · id·model · 요청 stream:true·signal·키 머리',
      CL.responseText(r) === FULL && r.content.length === 1 && r.content[0].type === 'text' && r.stop_reason === 'end_turn' && r.usage.input_tokens === 1000 && r.usage.cache_read_input_tokens === 200 && r.usage.output_tokens === 500 && r.id === 'msg_1' && r.model === 'claude-sonnet-5'
      && sent.stream === true && sent.max_tokens === 10 && !!calls[0].opts.signal && calls[0].opts.headers['x-api-key'] === KEY && calls[0].url === CL.API_URL, JSON.stringify(r).slice(0, 300));
    useFetch(() => sseResponse(sse(okEvents(FULL), '\r\n'), 5));
    const r2 = await CL.callApiStream(KEY, {}, 5000);
    T('① 줄 끝이 CRLF여도 같음', CL.responseText(r2) === FULL && r2.stop_reason === 'end_turn', CL.responseText(r2));
  }
  // ② 이벤트 스트림이 아니면 JSON 그대로(시험 흉내·프록시) · 상태 코드 규칙은 callApi와 같음
  {
    useFetch(() => new Response(JSON.stringify({ id: 'x', content: [{ type: 'text', text: 'abc' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await CL.callApiStream(KEY, {}, 5000);
    const code = async (status, body) => { useFetch(() => new Response(body || '{}', { status, headers: { 'content-type': 'application/json' } })); try { await CL.callApiStream(KEY, {}, 5000); return 'OK'; } catch (e) { return e.code + ':' + e.retryable + ':' + e.detail; } };
    const c400 = await code(400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: CREDIT_MSG } }));
    const c401 = await code(401), c429 = await code(429), c529 = await code(529), c500 = await code(500);
    T('② JSON 응답은 그대로 읽음 · 400 = BAD_REQUEST(잔액 문구 → 작업 층 CREDIT_LOW 그대로) · 401 AUTH · 429 RATE_LIMIT(재시도) · 5xx SERVER(재시도)',
      CL.responseText(r) === 'abc' && /^BAD_REQUEST:false:Your credit balance/.test(c400) && PJ.failCode('BAD_REQUEST', c400.split(':').slice(2).join(':')) === 'CREDIT_LOW' && /^AUTH:false/.test(c401) && /^RATE_LIMIT:true/.test(c429) && /^SERVER:true/.test(c529) && /^SERVER:true/.test(c500), [c400, c401, c429, c529, c500].join(' | '));
  }
  // ③ 'fetch failed'는 원인 코드를 붙여 NETWORK(머리 받기 전 — 재시도) · 비스트리밍 callApi도 같은 사유 표기
  {
    const tfail = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_HEADERS_TIMEOUT', name: 'HeadersTimeoutError' }; throw e; };
    useFetch(tfail);
    let e1 = null; try { await CL.callApiStream(KEY, {}, 5000); } catch (e) { e1 = e; }
    let e2 = null; try { await CL.callApi(KEY, {}, 5000); } catch (e) { e2 = e; }
    T('③ fetch failed → NETWORK·재시도 가능·사유 "fetch failed (UND_ERR_HEADERS_TIMEOUT)" — callApi·callApiStream 둘 다', e1 && e1.code === 'NETWORK' && e1.retryable === true && e1.detail === 'fetch failed (UND_ERR_HEADERS_TIMEOUT)' && e2 && e2.code === 'NETWORK' && e2.detail === 'fetch failed (UND_ERR_HEADERS_TIMEOUT)', JSON.stringify([e1 && e1.detail, e2 && e2.detail]));
  }
  // ④ 전체 상한(시간 제한) — 머리는 왔는데 본문이 안 끝나면 상한에서 끊고 TIMEOUT(재시도 안 함) · 끝 표시 없이 닫히면 NETWORK(재시도 안 함 — 서버 재시도 규칙이 나중에)
  {
    useFetch((url, opts) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(sse(okEvents(FULL).slice(0, 6)))); opts.signal.addEventListener('abort', () => c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const t0 = Date.now(); let e1 = null; try { await CL.callApiStream(KEY, {}, 60); } catch (e) { e1 = e; }
    useFetch(() => sseResponse(sse(okEvents(FULL).slice(0, 9)), 11));
    let e2 = null; try { await CL.callApiStream(KEY, {}, 5000); } catch (e) { e2 = e; }
    T('④ 상한(60ms 흉내)에서 본문 읽기를 끊음 → TIMEOUT·재시도 안 함 · 끝 표시(message_stop) 없이 닫힘 → NETWORK·재시도 안 함("스트림이 끝 표시 없이 끊김")',
      e1 && e1.code === 'TIMEOUT' && e1.retryable === false && Date.now() - t0 < 3000 && e2 && e2.code === 'NETWORK' && e2.retryable === false && /끝 표시 없이/.test(e2.detail), JSON.stringify([e1 && [e1.code, e1.retryable], e2 && [e2.code, e2.retryable, e2.detail]]));
  }
  // ⑤ 스트림 중 오류 이벤트(과부하 등) — 글이 오기 전이면 SERVER 재시도 가능, 글이 온 뒤면 재시도 안 함 · 최대 길이 잘림은 stop_reason 그대로
  {
    const errEv = ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
    useFetch(() => sseResponse(sse(okEvents(FULL).slice(0, 5).concat([errEv])), 13));
    let e1 = null; try { await CL.callApiStream(KEY, {}, 5000); } catch (e) { e1 = e; }
    useFetch(() => sseResponse(sse(okEvents(FULL).slice(0, 8).concat([errEv])), 13));
    let e2 = null; try { await CL.callApiStream(KEY, {}, 5000); } catch (e) { e2 = e; }
    const mt = okEvents(FULL).map((x) => (x[0] === 'message_delta' ? ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 32000 } }] : x));
    useFetch(() => sseResponse(sse(mt), 64));
    const r3 = await CL.callApiStream(KEY, {}, 5000);
    T('⑤ 오류 이벤트: 글 전 = SERVER·재시도 가능 · 글 뒤 = SERVER·재시도 안 함 · 사유에 overloaded_error · max_tokens는 stop_reason으로 그대로(생성 함수가 TRUNCATED로)', e1 && e1.code === 'SERVER' && e1.retryable === true && /overloaded_error/.test(e1.detail) && e2 && e2.code === 'SERVER' && e2.retryable === false && r3.stop_reason === 'max_tokens' && r3.usage.output_tokens === 32000, JSON.stringify([e1 && [e1.code, e1.retryable], e2 && [e2.code, e2.retryable], r3.stop_reason]));
  }
  // ⑥ 실제 생성 함수(generateDraft)가 스트리밍을 씀 — 판독표·본문이 SSE로 와도 초안이 그대로 · 머리 전 NETWORK는 한 번 재시도 · 잘림은 TRUNCATED
  {
    const draft = { scenes: [{ n: 1, scene: '우수받이 입구', equip: '준설차 흡입호스', act: '호스 투입', state: '침전물', count: '', conf: '높음' }, { n: 2, scene: '작업 후', equip: '', act: '', state: '비워짐', count: '', conf: '보통' }], title: '포항 장량동 우수받이 침전물, 흡입호스로 비운 기록입니다', body: '[사진 1 : 입구]\n입구를 열자 침전물이 쌓여 있었습니다.\n[사진 2 : 작업 후]\n비워진 모습입니다.', tags: ['포항', '우수받이'], title_type: 'O' };
    const photos = [{ media_type: 'image/jpeg', data: 'A'.repeat(200) }, { media_type: 'image/jpeg', data: 'B'.repeat(200) }];
    const input = { region: '포항 장량동', facility: '우수받이', problem: '침전물', photoCount: 2, shot_at: '2026-10-20 10:00', post_date: '2026-11-13' };
    useFetch(() => sseResponse(sse(okEvents(JSON.stringify(draft))), 23));
    const g = await PA.generateDraft(KEY, photos, input);
    const sent = JSON.parse(calls[0].opts.body);
    T('⑥ generateDraft: 요청 stream:true(구조화 출력·사진 블록 그대로) · 초안 제목·본문·판독표 2·프롬프트 판 · 사용 토큰 1,700', g.ok === true && g.title === draft.title && g.body === draft.body && g.scenes.length === 2 && g.prompt_ver === PA.PROMPT_VER && g.used_tokens === 1700 && sent.stream === true && sent.output_config && sent.output_config.format && sent.output_config.format.type === 'json_schema' && sent.messages[0].content.filter((b) => b.type === 'image').length === 2 && calls.length === 1, JSON.stringify({ ok: g.ok, code: g.code, detail: g.detail, used: g.used_tokens }));
    useFetch((url, opts, n) => { if (n === 1) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; } return sseResponse(sse(okEvents(JSON.stringify(draft))), 31); });
    const g2 = await PA.generateDraft(KEY, photos, input);
    const mt = okEvents(JSON.stringify(draft)).map((x) => (x[0] === 'message_delta' ? ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 32000 } }] : x));
    useFetch(() => sseResponse(sse(mt), 64));
    const g3 = await PA.generateDraft(KEY, photos, input);
    useFetch(() => sseResponse(sse(okEvents(JSON.stringify(draft)).slice(0, 10)), 17));
    const g4 = await PA.generateDraft(KEY, photos, input);
    T('⑥ 머리 전 NETWORK(ECONNRESET)는 한 번 재시도해 성공(호출 2) · 잘림 = TRUNCATED(재시도 안 함 — 호출 1) · 본문 중간 끊김 = NETWORK 재시도 안 함(호출 1 — 15분 상한 보호)',
      g2.ok === true && g3.ok === false && g3.code === 'TRUNCATED' && g4.ok === false && g4.code === 'NETWORK' && calls.length === 1, JSON.stringify([g2.ok, g3.code, g4.code, g4.detail]));
  }
  // ⑧ 빈 본문(종운환경3 11/13 질문) — 머리만 오고 0바이트로 닫힘 = NETWORK·재시도 안 함(생성 함수 호출 1) · 끝까지 왔는데 글이 비었음 = 응답 그대로 돌려주고
  //   생성 함수가 PARSE_FAILED(종전 규칙대로 한 번 더 — 호출 2, 비스트리밍 때와 같음) · 이벤트 스트림이 아닌 200 빈 본문 = PARSE·재시도 가능(callApi와 같음)
  {
    const photos = [{ media_type: 'image/jpeg', data: 'A'.repeat(200) }, { media_type: 'image/jpeg', data: 'B'.repeat(200) }];
    const input = { region: '포항 장량동', facility: '우수받이', problem: '침전물', photoCount: 2, shot_at: '2026-10-20 10:00', post_date: '2026-11-13' };
    useFetch(() => sseResponse('', 7));
    let e1 = null; try { await CL.callApiStream(KEY, {}, 5000); } catch (e) { e1 = e; }
    useFetch(() => sseResponse('', 7));
    const g1 = await PA.generateDraft(KEY, photos, input); const n1 = calls.length;
    const emptyText = [
      ['message_start', { type: 'message_start', message: { id: 'msg_2', type: 'message', model: 'claude-sonnet-5', usage: { input_tokens: 900, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    useFetch(() => sseResponse(sse(emptyText), 9));
    const r2 = await CL.callApiStream(KEY, {}, 5000);
    useFetch(() => sseResponse(sse(emptyText), 9));
    const g2 = await PA.generateDraft(KEY, photos, input); const n2 = calls.length;
    const blank = () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
    useFetch(blank); let e3 = null; try { await CL.callApiStream(KEY, {}, 5000); } catch (e) { e3 = e; }
    useFetch(blank); let e4 = null; try { await CL.callApi(KEY, {}, 5000); } catch (e) { e4 = e; }
    T('⑧ 빈 본문: 머리만 오고 0바이트 = NETWORK·재시도 안 함(생성 함수 호출 1) · 끝까지 왔는데 글 없음 = 응답 그대로(글 "") → 생성 함수 PARSE_FAILED(종전 규칙 한 번 더 — 호출 2) · 이벤트 스트림 아닌 200 빈 본문 = PARSE·재시도 가능(callApi와 같음)',
      e1 && e1.code === 'NETWORK' && e1.retryable === false && /끝 표시 없이/.test(e1.detail) && g1.ok === false && g1.code === 'NETWORK' && n1 === 1
      && CL.responseText(r2) === '' && r2.stop_reason === 'end_turn' && g2.ok === false && g2.code === 'PARSE_FAILED' && n2 === 2
      && e3 && e3.code === 'PARSE' && e3.retryable === true && e4 && e4.code === 'PARSE' && e4.retryable === true,
      JSON.stringify([e1 && [e1.code, e1.retryable], g1.code, n1, g2.code, n2, e3 && [e3.code, e3.retryable], e4 && [e4.code, e4.retryable]]));
  }
  // ⑦ 배선(정적) — 생성만 스트리밍, 학습 워커들은 짧아 종전 callApi · promoai 재수출
  {
    const pai = fs.readFileSync(join(FN, '_lib/promoai.js'), 'utf8');
    T('⑦ generateDraft는 callApiStream · promoai가 callApiStream·callApi 둘 다 claude.js 것을 재수출 · callApi(비스트리밍)는 학습 워커용으로 그대로',
      /json = await callApiStream\(apiKey, body, timeoutMs\);/.test(pai) && !/json = await callApi\(apiKey, body, timeoutMs\);/.test(pai) && PA.callApiStream === CL.callApiStream && PA.callApi === CL.callApi && typeof CL.callApi === 'function');
  }
} finally { global.fetch = realFetch; }

console.log(fails ? '\n생성 스트리밍 게이트 실패 ' + fails + ' / 통과 ' + pass : '\n생성 스트리밍 게이트 전 항목 통과 (' + pass + ')');
process.exit(fails ? 1 : 0);
