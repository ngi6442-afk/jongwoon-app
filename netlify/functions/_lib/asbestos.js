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

module.exports = { judgeAsbestos94, claudeExtractAsbestos };
