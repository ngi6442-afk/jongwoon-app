// 계약 시트·시나리오 순수 함수 실행 검사(v381~) — 브라우저 없이 백업 실데이터로 행·상세·정렬·필터·단계 목록·서류 라우팅을 실제로 돌려 본다.
// 실행: node tools/consheet_check.mjs   (백업: ../jongwoon-appdata/data/backup/gw_backup.json)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < 0) throw new Error('segment ' + a); return html.slice(i, j); };
const scen = cut('// @con-scen-start', '// @con-scen-end');
const sheet = cut('// @con-sheet-start', '  function renderContracts(){');
const fnOf = (name) => { const i = html.indexOf('  function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
const bkPath = [join(ROOT, '..', 'jongwoon-appdata', 'data', 'backup', 'gw_backup.json'), 'C:/Users/user/jongwoon/jongwoon-appdata/data/backup/gw_backup.json'].find((p) => existsSync(p));
const bk = bkPath ? JSON.parse(readFileSync(bkPath, 'utf8')).stores.gw_data : null;
const contracts = bk ? bk['col:contracts'].items.filter((c) => c && c.del !== 1) : [];
const tasks = (bk && bk['col:tasks'] && bk['col:tasks'].items) || [];
const recs = (bk && bk['col:receivables'] && bk['col:receivables'].items) || [];
const stubs = `
  var window = { addEventListener: function(){}, matchMedia: function(){ return { matches: false, addEventListener: function(){} }; }, innerWidth: 1200 };
  var document = { getElementById: function(){ return null; } };
  var localStorage = { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){} };
  var lastBidForCon = null;
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(ch){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]; }); }
  function findTask(id){ for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i]; return null; }
  function findRec(id){ for (var i = 0; i < recs.length; i++) if (recs[i].id === id) return recs[i]; return null; }
  function findProc(id){ for (var i = 0; i < contracts.length; i++) if (contracts[i].id === id) return contracts[i]; return null; }
  function conBidAmt(){ return 0; }
  function conAmt(c){ return ((c && c.contract_info && c.contract_info.amount) || 0) || conBidAmt(c); }
  function conAmtEff(c){ return (c && Number(c.settle_amount)) || conAmt(c); }
  function fmtAmount(n){ return Number(n).toLocaleString(); }
  function dispName(n){ return n; }
  function todayStr(){ return "2026-10-13"; }
  function vehDday(d){ var t = new Date(d + "T00:00:00"), now = new Date("2026-10-13T00:00:00"); var diff = Math.round((t - now) / 86400000); return { diff: diff, text: diff < 0 ? ("D+" + (-diff)) : ("D-" + diff) }; }
  function canDo(){ return true; }
  function isAdmin(){ return true; }
  function canApproveTask(){ return true; }
  function conHasBldg(c){ return !!(c && (c.type === "asbestos" || c.type === "demolition" || c.bldg_info)); }
  function conNeedsBldg(c){ return !!(c && !c.bldg_info && (c.type === "asbestos" || c.type === "demolition")); }
  function pipeLabel(k){ return k === "waste" ? "폐기물" : "본"; }
  function conAttBoxHtml(c){ return (c.attachments && c.attachments["서류함"] && c.attachments["서류함"].length) ? '<div data-catt-drop="' + c.id + '">att</div>' : ''; }
  function genId(p){ return p + "x"; }
  function myName(){ return "검사"; }
  function scheduleContractSave(){} function saveTasksCache(){} function scheduleTasksSave(){} function renderTasks(){} function renderSummary(){} function renderContracts(){}
  function completeStageNow(){ return "done"; }
  function materializeStage(c, pipe){ while (pipe.cur < pipe.stages.length && pipe.stages[pipe.cur].status === "skipped") pipe.cur++; if (pipe.cur < pipe.stages.length) pipe.stages[pipe.cur].status = "open"; }
  var confirm = function(){ return true; }, alert = function(){};
  var gwCall = null; var Date = globalThis.Date;
`;
const tplLine = (html.match(/var TPL_LABELS=\{[^\r\n]*\};/) || [''])[0];
const api = new Function('contracts', 'tasks', 'recs', stubs + tplLine + fnOf('conAttList') + scen + sheet + fnOf('stageXlsxKind') + `
  return { CON_COLS, CON_SCEN, CON_PACKETS, conScenStages, conModalElems, stageDocsFor, csStageFields, stageXlsxKind, csRowHtml, csDetailHtml, csStageInfo, csSortRows, csPass, csEnumValues, csEndCell, csKind, csSkipStage, csJumpStage, csUnskipStage, csPacketsHtml, csLoadTpl, setTab: function(t){ conDetTab = t; }, openStage: function(k){ csStageOpen = k; }, setTpl: function(o){ csTplKeys = o; csTplErr = 0; }, setTplErr: function(v){ csTplErr = v; }, tplState: function(){ return { keys: csTplKeys, err: csTplErr, loading: csTplLoading }; }, setGw: function(f){ gwCall = f; } };
`)(contracts, tasks, recs);
let fails = 0; const T = (n, ok, note) => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : ' — ' + note)); if (!ok) fails++; };
// 시나리오 목록
const want = { 'asbestos:pri': 8, 'asbestos:pub': 10, 'demolition:pri': 8, 'demolition:pub': 10, 'combo:pri': 9, 'combo:pub': 11, 'waste:pri': 6, 'waste:pub': 6, 'dredge:pub': 8, 'dredge:pri': 5 };
T('v382 단계 목록 10개 길이(PM 원문)', Object.keys(want).every((k) => api.CON_SCEN[k].length === want[k]), JSON.stringify(Object.fromEntries(Object.keys(want).map((k) => [k, api.CON_SCEN[k].length]))));
T('v382 conScenStages: 철거 관급 선택 단계 3(전체 괄호 — "(필증수령) 공사수행"은 필수) · 석면 사급 0 · 혼합 관급 11 · 적격 낙찰 → 맨 앞 적격심사 · 운반 종류는 혼합 무시',
  api.conScenStages('demolition', true, false, {}).filter((s) => s.opt).length === 3 && api.conScenStages('asbestos', false, false, {}).filter((s) => s.opt).length === 0
  && api.conScenStages('demolition', true, true, {}).length === 11 && api.conScenStages('dredge', true, false, { qual: true })[0].name === '적격심사' && api.conScenStages('waste', true, true, {}).length === 6, '');
T('v382 conModalElems: 석면 {asb,labor,wst} · 철거+혼합 {demo,wst,asb,labor} · 준설 {dredge}', JSON.stringify(api.conModalElems('asbestos', false)) === '{"asb":1,"labor":1,"wst":1}' && (() => { const e = api.conModalElems('demolition', true); return e.demo === 1 && e.asb === 1 && e.labor === 1 && e.wst === 1; })() && JSON.stringify(api.conModalElems('dredge', true)) === '{"dredge":1}', '');
// 서류 라우팅·지시 상세 — 10목록 전체 이름에 대해 예외 없이, 핵심 이름은 기대 종류
const allNames = [...new Set(Object.values(api.CON_SCEN).flat())];
const route = Object.fromEntries(allNames.map((n) => [n, api.stageXlsxKind(n)]));
T('v382 stageXlsxKind — PM 원문 ' + allNames.length + '개 전부 예외 없음 · 노동부 신고 서류 작성→asb_plan · 해체완료신고서류 작성→demo_report · (해체신고)→demo_report · 착공서류→work_start · 준공서류 작성(처리확인서 포함)→work_complete · (배출신고)→waste_report · 견적·수의계약→quote_docs · 청구 및 입금확인→null',
  route['노동부 신고 서류 작성'] === 'asb_plan' && route['해체완료신고서류 작성'] === 'demo_report' && route['(해체신고)'] === 'demo_report' && route['착공서류'] === 'work_start' && route['준공서류 작성(처리확인서 포함)'] === 'work_complete' && route['(배출신고)'] === 'waste_report' && route['견적·수의계약'] === 'quote_docs' && route['청구 및 입금확인'] === null && route['완료보고 및 실적보고'] === null, JSON.stringify(route));
T('v382 stageDocsFor — 전 이름 중 상세 비는 것은 실적·반입 계열뿐', allNames.filter((n) => !api.stageDocsFor(n)).every((n) => /실적신고|실적보고$/.test(n) || n === '실적보고'), JSON.stringify(allNames.filter((n) => !api.stageDocsFor(n))));
T('v382 csStageFields — 준공서류 작성에 정산액 · 노동부에 필증 번호 · 작업 수행(준설)은 필증/공사수행 묶음 아님(빈 칸 허용)', api.csStageFields('준공서류 작성').some((f) => f[0] === 'settle_amount') && api.csStageFields('노동부 신고 서류 작성').some((f) => f[0] === 'mol_no') && Array.isArray(api.csStageFields('작업 수행')), '');
// 가짜 계약으로 단계 탭 HTML + 건너뜀/이 단계부터
const mk = () => ({ id: 'c_t', type: 'dredge', label: '준설·시설공사', docType: 'public', client: '테스트', site: 'x', start: '2026-10-01', status: 'active', scen: { type: 'dredge', pub: true, combo: false, ver: 1 }, pipes: [{ key: 'main', cur: 0, stages: api.conScenStages('dredge', true, false, {}).map((s) => ({ name: s.name, due: 'manual', days: null, status: 'pending', task_id: null, done_at: null, opt: s.opt })) }] });
let c = mk(); c.pipes[0].stages[0].status = 'open';
api.setTab('st'); api.openStage('main|3');
const h = api.csDetailHtml(c);
T('v382 단계 탭 HTML: 8카드 · 열린 카드 1(작업 수행)에 작업현황 표 + 버튼 · 현재 단계(1)는 cur', (h.match(/class="cs-stg/g) || []).length === 8 && /cs-stg open/.test(h) && /작업현황 0일/.test(h) && /data-cs-wladd=/.test(h) && /cs-stg cur/.test(h), '');
c = mk(); c.pipes[0].stages[0].status = 'open'; api.csJumpStage(c, c.pipes[0], 3);
T('v382 이 단계부터(3): 앞 3단계 skipped · cur=3 · 그 단계 open', c.pipes[0].stages.slice(0, 3).every((s) => s.status === 'skipped') && c.pipes[0].cur === 3 && c.pipes[0].stages[3].status === 'open', JSON.stringify(c.pipes[0].stages.map((s) => s.status)));
c = mk(); c.type = 'demolition'; c.pipes[0].stages = api.conScenStages('demolition', true, false, {}).map((s) => ({ name: s.name, status: 'pending', opt: s.opt, task_id: null })); c.pipes[0].cur = 0; c.pipes[0].stages[0].status = 'open';
api.csSkipStage(c, c.pipes[0], 3); api.csSkipStage(c, c.pipes[0], 4);
T('v382 선택 단계 건너뜀(대기 중): 상태 skipped, cur 그대로 · 선택 복구로 pending', c.pipes[0].stages[3].status === 'skipped' && c.pipes[0].stages[4].status === 'skipped' && c.pipes[0].cur === 0 && (api.csUnskipStage(c, c.pipes[0], 4), c.pipes[0].stages[4].status === 'pending'), '');
// 백업 실데이터(있으면)
if (contracts.length) {
  T('백업 계약 ' + contracts.length + '건 전부 행 HTML 생성 · 셀 8개', contracts.every((x) => (api.csRowHtml(x, false).match(/<td/g) || []).length === 8), '');
  for (const tab of ['ov', 'st', 'doc', 'lk']) { api.setTab(tab); T('백업 계약 상세 탭 ' + tab + ' 예외 0', contracts.every((x) => api.csDetailHtml(x).length > 100), ''); }
  api.setTab('st'); T('옛 계약(scen 없음)은 단계 탭에 안내 한 줄', contracts.filter((x) => !x.scen).every((x) => /v382 이전 단계 목록/.test(api.csDetailHtml(x))), '');
  T('칩 필터 active+done = 전체 · 발주처 "맑은물" 부분 일치', contracts.filter((x) => api.csPass(x, {}, 'active')).length + contracts.filter((x) => api.csPass(x, {}, 'done')).length === contracts.length && contracts.filter((x) => api.csPass(x, { client: '맑은물' }, '')).every((x) => /맑은물/.test(x.client)), '');
} else console.log('  (백업 파일 없음 — 실데이터 검사 생략)');
// v383 패킷
api.setTpl(null);
let c3 = mk(); let ph = api.csPacketsHtml(c3);
T('v383 패킷(준설 관급, 양식 목록 전): 패킷 4 · gen 항목은 "양식 확인 중" · 첨부 필요 항목에 📎(data-catt-add)', (ph.match(/class="cs-pk"/g) || []).length === 4 && /양식 확인 중/.test(ph) && /data-catt-add=/.test(ph), '');
api.setTpl({ work_start: 1, work_complete: 1, settle_doc: 1, contract_pledge: 1, seal_reg: 1, quote_env: 1 });
c3.attachments = { '서류함': [{ name: '철강공단 계약서류준비.pdf' }, { name: '계량증명서_구룡포.pdf' }, { name: '통장사본.jpg' }] };
ph = api.csPacketsHtml(c3);
T('v383 패킷(양식 6종 등록·첨부 3): 생성 ✓에 [생성](data-cs-gen) · 계약서·계량증명서·통장 첨부됨 · adv_pay는 미등록 ✗ · 사급 전용 항목(계약서 툴·약식 계약서) 없음',
  (ph.match(/data-cs-gen=/g) || []).length >= 4 && /첨부됨 · 철강공단 계약서류준비\.pdf/.test(ph) && /첨부됨 · 계량증명서_구룡포\.pdf/.test(ph) && /첨부됨 · 통장사본\.jpg/.test(ph) && /양식 미등록\(선금지급신청 세트\)/.test(ph) && !/계약서\(작성 툴\)/.test(ph) && !/준설 약식 계약서/.test(ph), '');
let c4 = mk(); c4.docType = 'private'; c4.pipes[0].stages = api.conScenStages('dredge', false, false, {}).map((s) => ({ name: s.name, status: 'pending', opt: s.opt, task_id: null }));
ph = api.csPacketsHtml(c4);
T('v383 패킷(준설 사급): 착공·준공 패킷 없음(2) · 계약서 툴·견적서·약식 계약서 항목 · 청구 패킷은 통장·세금계산서만', (ph.match(/class="cs-pk"/g) || []).length === 2 && /계약서\(작성 툴\)/.test(ph) && /준설 약식 계약서/.test(ph) && !/납세증명/.test(ph) && /세금계산서/.test(ph), '');
// v383 검토 반영 — 첨부 오탐·캐시 실패 분리
let c9 = mk(); api.setTpl({});
c9.attachments = { '서류함': [{ name: '사업자등록증.pdf' }, { name: '계약보증보험증권.pdf' }, { name: '국세완납증명서.pdf' }, { name: '원가계산서.xlsx' }, { name: '안전보호구 사진대지.pdf' }, { name: '하자보수보증증권.pdf' }] };
ph = api.csPacketsHtml(c9);
const itemOf = (name) => { const m = ph.match(new RegExp('<span class="nm">' + name.replace(/[()]/g, '\\$&') + '<div class="sub">([^<]*)<')); return m ? m[1] : null; };
T('v383 검토 ③ 첨부 역단언: 사업자등록증→사업자 ◻만(등록증은 첨부 필요) · 계약보증보험증권→보증만(4대보험 아님) · 국세완납→납세만 · 원가계산서→세금계산서 아님 · 보호구 사진대지→사진대지 아님 · 하자보수보증→보증 아님',
  /^첨부됨 · 사업자등록증\.pdf$/.test(itemOf('사업자등록증')) && itemOf('건설업·폐기물 등록증') === '첨부 필요' && /^첨부됨 · 계약보증보험증권\.pdf$/.test(itemOf('계약보증증권')) && itemOf('4대보험 완납증명') === '첨부 필요'
  && /^첨부됨 · 국세완납증명서\.pdf$/.test(itemOf('국세·지방세 납세증명')) && itemOf('세금계산서') === '첨부 필요' && itemOf('사진대지') === '첨부 필요' && itemOf('계약서(발주처 서식·날인본)') === '첨부 필요',
  JSON.stringify({ biz: itemOf('사업자등록증'), reg: itemOf('건설업·폐기물 등록증'), bond: itemOf('계약보증증권'), ins: itemOf('4대보험 완납증명'), tax: itemOf('국세·지방세 납세증명'), inv: itemOf('세금계산서'), photos: itemOf('사진대지'), contract: itemOf('계약서(발주처 서식·날인본)') }));
c9.attachments = { '서류함': [{ name: '건설업등록증.pdf' }, { name: '폐기물수집운반업허가증.pdf' }, { name: '준공사진대지.pdf' }, { name: '하도급계약서_날인.pdf' }] }; ph = api.csPacketsHtml(c9);
T('v383 검토 ③ 정방향: 건설업등록증·운반업허가증→등록증 ◻(외 1) · 준공사진대지→사진대지 ◻ · 하도급계약서→계약서 ◻', /^첨부됨 · 건설업등록증\.pdf 외 1$/.test(itemOf('건설업·폐기물 등록증')) && /^첨부됨 · 준공사진대지\.pdf$/.test(itemOf('사진대지')) && /^첨부됨 · 하도급계약서_날인\.pdf$/.test(itemOf('계약서(발주처 서식·날인본)')), itemOf('건설업·폐기물 등록증') + ' / ' + itemOf('사진대지'));
api.setTpl(null); api.setTplErr(Date.now()); ph = api.csPacketsHtml(c9);
T('v383 검토 ① 실패 상태: 캐시 null + 실패 시각 → "양식 목록 확인 실패"(미등록 아님) · ✗ 미등록 문구 없음', /양식 목록 확인 실패/.test(ph) && !/양식 미등록/.test(ph), '');
api.setTpl(null); api.setGw(() => Promise.resolve({ status: 500, body: {} })); api.csLoadTpl(); await new Promise((r) => setTimeout(r, 0));
let ts = api.tplState();
T('v383 검토 ① csLoadTpl 비200: 캐시는 null 그대로(미등록 {} 아님) · 실패 시각 기록 · 30초 안 재호출은 요청 안 함', ts.keys === null && ts.err > 0 && !ts.loading && (api.setGw(() => { throw new Error('호출됨'); }), api.csLoadTpl(), true), JSON.stringify(ts));
api.setGw(() => Promise.reject(new Error('net'))); api.setTplErr(0); api.csLoadTpl(); await new Promise((r) => setTimeout(r, 0)); ts = api.tplState();
T('v383 검토 ① csLoadTpl 네트워크 실패: 캐시 null · 실패 시각', ts.keys === null && ts.err > 0, JSON.stringify(ts));
api.setGw(() => Promise.resolve({ status: 200, body: { templates: { work_start: { name: 'a.xlsx' }, adv_pay: null } } })); api.setTplErr(0); api.csLoadTpl(); await new Promise((r) => setTimeout(r, 0)); ts = api.tplState();
T('v383 검토 ① csLoadTpl 200: 등록된 키만 1 · 실패 시각 0', ts.keys && ts.keys.work_start === 1 && !ts.keys.adv_pay && ts.err === 0, JSON.stringify(ts));
api.setGw(null);
T('준공·만기 칸: d3 없음 → "-" · 지난 날짜 → vs-dan · 완료 건 → 회색 완료', api.csEndCell({ status: 'active' }).html.indexOf('-') >= 0 && api.csEndCell({ status: 'active', contract_info: { d3: '2026-01-01' } }).cls === 'vs-dan' && /완료/.test(api.csEndCell({ status: 'done' }).html), '');
console.log(fails ? '\n계약 시트 실행 검사 실패 ' + fails + '건' : '\n계약 시트 실행 검사 전 항목 통과'); process.exit(fails ? 1 : 0);
