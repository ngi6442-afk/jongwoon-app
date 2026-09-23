'use strict';
// 홍보 사진 가리기 워커 — Netlify Background Function(15분 한도). v353(PM 2026-09-13 "모자이크 착수") · 적대 검증 반영(9/13 밤).
// gw-promo-mask(사용자 API)가 내부 토큰(mid='__promomask__')으로만 기동한다. 호출 즉시 202, 진행·결과는 blob 'promomask:job:<id>' → 앱이 mask_job으로 폴링.
// 사진마다: 원본(att_<id>, gw_files) 읽기 → Claude 비전 좌표 → jimp 픽셀화 → gw_files 'mask:<att_id>'(이미지) + 'maskmeta:<att_id>'(상태) 저장(원본 보존).
// 규칙(적대 검증 반영):
//   · 사람이 손본 판(human 상자가 있거나 human:true — '가릴 것 없음'도 포함)은 force여도 덮지 않는다. force는 '자동 판만 다시'다.
//   · 비전 거부·잘림·파싱 실패는 mask를 쓰지 않고 'fail:'로 남긴다(배지 '미확인' 유지 → 게시 전 경고).
//   · 저장 직전에 mask를 다시 읽어, 감지 중 사람이 먼저 적용했으면(human 또는 더 새 ts) 덮지 않는다.
//   · 12분 예산 — 넘으면 남은 사진은 skip:time, status 'partial'. 사진마다 잠금 ts를 갱신한다.
// API 키는 GW_ANTHROPIC_KEY 를 여기서만 읽어 detectBoxes 인자로만 흘린다 — 로그·blob·응답에 남기지 않는다(scrub 마지막 방어선).
const { setupBlobContext, store, blobGet, blobSet } = require('./_lib/blobs');
const { verifyToken, bearer } = require('./_lib/session');
const F = require('./_lib/facedet');   // v364: 얼굴 전용 검출기(공개 모델, 외부 호출 없음)
const P = require('./_lib/platedet');  // v371: 번호판 — 차량 검출기(Google COCO-SSD) → 조각 확대 → Claude 좌표 → 자기검증
const { appendAudit } = require('./_lib/audit');
const M = require('./_lib/promomask');

const DATA = 'gw_data';
const FILES = 'gw_files';
function jobKey(id) { return `promomask:job:${id}`; }
function lockKey(promoId) { return `promomask:lock:${promoId}`; }
const USAGE_KEY = 'promomask:usage';
const RE_JOB = /^pm_[a-z0-9_-]{1,60}$/i;
const RE_REC_ID = /^[A-Za-z0-9_-]{2,48}$/;
const RE_ATT = /^att_[a-f0-9]{16}$/i;
const MAX_PHOTOS = 40;
const BUDGET_MS = 12 * 60 * 1000;      // 15분 한도 안에서 마감(비전 최대 40초 × 사진 수가 넘칠 수 있다)
const MAX_LOG_CHARS = 300;

function makeScrub() {
  const secrets = [process.env.GW_ANTHROPIC_KEY].map(function (s) { return s == null ? '' : String(s); }).filter(function (s) { return s.length >= 8; });
  return function scrub(v) {
    let out = (v === null || v === undefined) ? '' : String(v);
    for (const sec of secrets) { if (out.indexOf(sec) >= 0) out = out.split(sec).join('***'); }
    out = out.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'"\\/]+[\\/])+[^\s'"\\/]*/g, '<path>');   // 서버 파일 경로 제거(검증 #9 — 검출기·fs 오류 문구가 job에 실린다)
    return out.length > MAX_LOG_CHARS ? out.slice(0, MAX_LOG_CHARS) + '…' : out;
  };
}
function kstMonth() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7); }
async function bumpUsage(st, calls, usage) {
  try {
    const r = await blobGet(st, USAGE_KEY);
    const doc = (r.ok && r.data && r.data.months) ? r.data : { schema: 1, months: {} };
    const m = kstMonth();
    const cur = doc.months[m] || { calls: 0, input: 0, output: 0 };
    cur.calls += calls; cur.input += (usage && usage.input) || 0; cur.output += (usage && usage.output) || 0;
    doc.months[m] = cur;
    await blobSet(st, USAGE_KEY, doc);
  } catch (e) { /* 사용량 집계 실패는 본 작업을 바꾸지 않는다 */ }
}
function isHuman(rec) {
  if (!rec) return false;
  if (rec.human === true) return true;
  return Array.isArray(rec.boxes) && rec.boxes.some(function (b) { return b && b.by === 'human'; });
}
async function saveMask(fst, id, rec) {
  const w = await blobSet(fst, M.maskKey(id), rec);
  if (!w.ok) throw new Error('WRITE_' + (w.code || 'FAILED'));
  await blobSet(fst, M.metaKey(id), M.metaOf(rec));
}

exports.handler = async function (event, context) {
  let st = null, fst = null, job = '', promoId = '', rec = null;
  const scrub = makeScrub();
  const finish = async function (status, code, detail) {
    if (!st || !job || !rec) return;
    rec.status = status;
    if (code) rec.code = code;
    if (detail) rec.detail = scrub(detail);
    rec.ts = Date.now();
    try { await blobSet(st, jobKey(job), rec); } catch (e) {}
  };
  try {
    setupBlobContext(event, context);
    const v = verifyToken(bearer(event));
    if (!v.ok || v.payload.mid !== '__promomask__') return;
    let d = {};
    try { d = JSON.parse(event.body || '{}'); } catch (e) { return; }
    job = String(d.job || '').trim();
    promoId = String(d.promo_id || '').trim();
    const force = d.force === true;
    const onlyOld = d.only_old === true;   // v364 크론 재감지: 옛 판만(새 판 건너뜀·검출기 없으면 Claude 호출 없이 skip·번호판은 옛 판 재사용)
    if (!RE_JOB.test(job) || !RE_REC_ID.test(promoId)) return;
    const ids = (Array.isArray(d.ids) ? d.ids : []).map(function (x) { return String(x || '').trim(); }).filter(function (x) { return RE_ATT.test(x); }).slice(0, MAX_PHOTOS);

    st = store(DATA); fst = store(FILES);
    const started = Date.now();
    rec = { ts: started, status: 'running', promo_id: promoId, n: ids.length, done: 0, photos: [] };
    await blobSet(st, jobKey(job), rec);
    if (!process.env.GW_ANTHROPIC_KEY) { await finish('fail', 'ENV_MISSING'); return; }
    const apiKey = process.env.GW_ANTHROPIC_KEY;   // detectBoxes 인자로만 흐른다
    if (!ids.length) { await finish('done', 'NO_PHOTOS'); return; }

    let calls = 0, timedOut = false, detFail = 0, noFace = 0; const usage = { input: 0, output: 0 };
    for (const id of ids) {
      const item = { id: id, boxes: 0, st: '' };
      if (Date.now() - started > BUDGET_MS) { item.st = 'skip:time'; timedOut = true; rec.photos.push(item); continue; }
      try {
        const r = await blobGet(fst, id);
        const chk = M.checkImageRec(r.ok ? r.data : null);
        if (chk.err) { item.st = 'skip:' + chk.err; rec.photos.push(item); continue; }
        const mr = await blobGet(fst, M.maskKey(id));
        const prev = (mr.ok && mr.data) ? mr.data : null;
        // 사람이 손본 판은 force여도 덮지 않는다('가릴 것 없음'으로 확인한 것도 사람 판단이다)
        if (prev && isHuman(prev)) { item.st = 'kept:human'; item.boxes = (prev.boxes || []).length; rec.photos.push(item); continue; }
        if (prev && !force && prev.auto === true) { item.st = 'kept:auto'; item.boxes = (prev.boxes || []).length; rec.photos.push(item); continue; }
        if (prev && onlyOld && /platedet/.test(String(prev.model || ''))) { item.st = 'kept:auto'; item.boxes = (prev.boxes || []).length; rec.photos.push(item); continue; }   // 이미 새 판(v371: 번호판 전용 경로까지 거친 판)
        if (onlyOld && !prev) { item.st = 'skip:nomask'; rec.photos.push(item); continue; }   // 검증 #10: maskmeta만 남은 고아(사람이 지운 판) — 재감지가 다시 가리지 않는다
        // v364(PM 9/16 "얼굴 못 가리네 … 근본적으로"): 얼굴·머리는 전용 검출기(_lib/facedet — Google MoveNet 다중 배율 투표, 얼굴 모델 없음·중국계 없음), 번호판만 Claude 비전.
        //   9/16 실측: Claude 비전 얼굴 상자는 자리가 틀려(픽셀화가 가슴·벽에 찍힘) 얼굴 상자로는 쓰지 않는다. 검출기가 못 실리면 종전(Claude 전부)으로 내려간다.
        const raw = Buffer.from(chk.data, 'base64');
        let faces = null, fdiag = '';
        try { const fr = await F.detectFaces(raw); faces = fr.boxes.map(function (b) { return { kind: 'face', x: b.x, y: b.y, w: b.w, h: b.h }; }); fdiag = 'faces ' + faces.length + ' (' + fr.ms + 'ms, raw ' + fr.diag.raw + ', pose ' + (fr.diag.pose ? 'on' : 'off') + ')'; }
        catch (e) { faces = null; fdiag = 'facedet fail: ' + ((e && (e.code || String(e.message || 'ERR').split(/[:'\\/]/)[0])) || 'ERR'); }   // 코드만(경로·상세 제외, 검증 #9)
        if (faces === null) detFail++;
        if (faces === null && onlyOld) { item.st = 'skip:detector'; item.det = scrub(fdiag); rec.photos.push(item); continue; }   // 검출기 없이 재감지하면 옛 판을 같은 판으로 덮을 뿐 — Claude 호출 안 함
        // 검증 #7: 재감지에서 검출기가 머리를 하나도 못 찾았는데 옛 판에 얼굴 상자가 있으면 옛 판을 지우지 않는다(사람 확인 없이 가림을 줄이지 않는다) — 카드에 "얼굴 미검출"로 보인다
        if (onlyOld && faces && !faces.length && prev && (prev.boxes || []).some(function (b) { return b && b.kind === 'face'; })) { item.st = 'skip:noface'; item.boxes = (prev.boxes || []).length; item.det = scrub(fdiag); noFace++; rec.photos.push(item); continue; }
        // v371(PM 9/23 "차번호 덜/안 가려짐" → "ㄱ"): 번호판도 전용 경로 — 차량 검출기(_lib/platedet, Google COCO-SSD 6판 투표) → 차량 조각 확대 → Claude 좌표 → 자기검증(full/partial/none) →
        //   실패면 차량 하단 띠. 전체 사진 1회(종전 detectBoxes)는 폴백(whole)으로만 쓰고 그 상자도 검증한다. 9/23 실측: 종전 방식은 번호판 상자 7개 전부 엉뚱한 자리(세로로 밀림).
        //   재감지(only_old)도 번호판을 새로 감지한다(옛 판 재사용 없음 — 그 판이 틀린 것이 재감지 이유). 차량 검출기가 못 실리면(MODELS_MISSING·WASM) 종전(전체 사진 1회)으로 내려가고 model에 platedet가 안 붙어 크론이 다시 잡는다.
        let det, pdiag = '';
        if (faces === null) {
          det = await M.detectBoxes(apiKey, chk.mt, chk.data);   // 얼굴 검출기 못 실림 → 종전(Claude 전부)
          calls += 1; if (det.usage) { usage.input += det.usage.input; usage.output += det.usage.output; }
        } else {
          try {
            const pr = await P.detectPlates(raw, {
              plates: function (b64) { return M.detectPlatesInCrop(apiKey, 'image/jpeg', b64); },
              verify: function (b64) { return M.verifyPlate(apiKey, 'image/jpeg', b64); },
              whole: function () { return M.detectBoxes(apiKey, chk.mt, chk.data); },
            });
            calls += pr.calls; usage.input += (pr.usage && pr.usage.input) || 0; usage.output += (pr.usage && pr.usage.output) || 0;
            det = { boxes: pr.boxes.map(function (b) { return { kind: 'plate', x: b.x, y: b.y, w: b.w, h: b.h }; }), model: 'platedet+' + M.MODEL, usage: null };
            pdiag = ' · plates ' + det.boxes.length + ' (veh ' + pr.diag.veh + ', crops ' + pr.diag.crops + ', verified ' + pr.diag.verified + ', band ' + pr.diag.band + ', ' + pr.ms + 'ms, calls ' + pr.calls + ')';
          } catch (e) {
            const code = (e && (e.code || String(e.message || 'ERR').split(/[:'\\/]/)[0])) || 'ERR';
            if (code !== 'MODELS_MISSING' && code !== 'WASM_BACKEND_FAILED') throw e;   // 비전 오류(REFUSAL·TRUNCATED·PARSE·AUTH·TIMEOUT…)는 종전처럼 fail:로 — mask 저장 안 함
            det = await M.detectBoxes(apiKey, chk.mt, chk.data);   // 차량 검출기 못 실림 → 종전 번호판 경로(platedet 표식 없음 → 크론이 다시 잡는다)
            calls += 1; if (det.usage) { usage.input += det.usage.input; usage.output += det.usage.output; }
            det = { boxes: det.boxes, model: det.model, usage: null };
            pdiag = ' · platedet fail: ' + code;
          }
        }
        const claude = det.boxes.filter(function (b) { return faces === null ? true : b.kind !== 'face'; });   // 검출기가 살아 있으면 Claude는 번호판만
        const boxes = M.cleanBoxes((faces || []).concat(claude)).map(function (b) { b.by = 'auto'; return b; });   // 클램프(머리 상자는 가장자리에서 음수가 될 수 있다)
        item.boxes = boxes.length; item.det = scrub(fdiag + pdiag);   // 검출기 오류 문구에 서버 경로가 실릴 수 있어 스크럽(길이 상한 포함)
        const out = await M.applyBoxes(raw, boxes);
        // 저장 직전 재확인 — 감지하는 사이 사람이 먼저 적용했으면 그쪽이 이긴다(적대 검증 #17)
        const again = await blobGet(fst, M.maskKey(id));
        const cur = (again.ok && again.data) ? again.data : null;
        if (cur && (isHuman(cur) || (Number(cur.ts) || 0) > started)) { item.st = 'kept:human'; item.boxes = (cur.boxes || []).length; rec.photos.push(item); continue; }
        await saveMask(fst, id, { schema: 1, src: id, name: r.data.name, type: 'image/jpeg', kind: 'promo', auto: true, human: false, boxes: boxes,
          w: out.w, h: out.h, data: out.buf ? out.buf.toString('base64') : '', model: (faces === null ? det.model : 'facedet+' + det.model), by: '__promomask__', ts: Date.now() });
        item.st = boxes.length ? 'masked' : 'clear';
      } catch (e) {
        item.st = 'fail:' + scrub((e && e.message) || 'ERR');
      }
      rec.photos.push(item);
      rec.done = rec.photos.length;
      try { await blobSet(st, jobKey(job), rec); } catch (e2) {}
      try { await blobSet(st, lockKey(promoId), { ts: Date.now(), job: job }); } catch (e3) {}   // 잠금 ts 갱신(긴 작업이 TTL을 넘지 않게)
    }
    // 검증 #8: 재감지(only_old)에서 검출기가 한 장도 못 돌았으면 이 회차는 시도로 안 센다(표식 tries 되돌림) + det_down 표식(크론이 6시간 쉼) — 장애가 걷히면 다시 감지된다
    if (onlyOld && detFail > 0 && !rec.photos.some(function (p) { return p.st === 'masked' || p.st === 'clear'; })) {
      try {
        const rk = 'promomask:remask:' + promoId; const cur = await blobGet(st, rk);
        const td = (cur.ok && cur.data && typeof cur.data === 'object') ? cur.data : {};
        await blobSet(st, rk, Object.assign({}, td, { tries: Math.max(0, (Number(td.tries) || 0) - 1), det_down: Date.now(), job: job }));
      } catch (e) {}
    }
    await bumpUsage(st, calls, usage);
    rec.calls = calls; rec.det_fail = detFail; rec.no_face = noFace;   // 검출기 실패 장수(0이 정상 — 모델 누락·번들 경로 문제를 크게 보이게) · 얼굴 미검출(옛 판 유지) 장수
    const masked = rec.photos.filter(function (p) { return p.st === 'masked'; }).length, failed = rec.photos.filter(function (p) { return /^fail:/.test(p.st); }).length;
    try { await appendAudit({ ts: Date.now(), by: '__promomask__', bid: '__promomask__', col: 'promo', ev: [{ op: '자동가리기', id: job, t: promoId + ' · 가림 ' + masked + '장 / 실패 ' + failed + '장 / 호출 ' + calls + (detFail ? ' / 검출기 실패 ' + detFail + '장' : '') + (noFace ? ' / 얼굴 미검출(옛 판 유지) ' + noFace + '장' : '') + (timedOut ? ' · 시간 초과' : '') }] }); } catch (e) {}
    await finish(timedOut ? 'partial' : 'done', timedOut ? 'TIME_BUDGET' : '');
  } catch (e) {
    await finish('fail', 'WORKER_THREW', (e && e.message) || '');
  } finally {
    // 자기 job의 잠금만 해제
    try {
      if (st && promoId) {
        const lk = await blobGet(st, lockKey(promoId));
        if (lk.ok && lk.data && lk.data.job === job) await blobSet(st, lockKey(promoId), { ts: 0, job: '' });
      }
    } catch (e) {}
  }
};
