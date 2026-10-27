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
  var gidN = 0; function genId(p){ return p + "x" + (++gidN); }   // 고유해야 한다 — 같은 id면 findTask가 엉뚱한 지시를 집는다(검토 J 검사에서 실측)
  function myName(){ return "검사"; }
  function scheduleContractSave(){} function saveTasksCache(){} function scheduleTasksSave(){} function renderTasks(){} function renderSummary(){} function renderContracts(){}
  function completeStageNow(){ return "done"; }
  var alerts = []; var CONTRACT_API = "contracts.json", serverItems = null, billN = 0;
  function getToken(){ return "t"; } function ghHeaders(){ return {}; } function addDays(d){ return d; } function loadTasks(){} function loadAsb(){} function conBillToRec(){ billN++; } function canSee(){ return true; } var contractSaveTimer = null, saveNowN = 0; function doSaveContracts(){ saveNowN++; } var toasts = []; function apprToastShow(m){ toasts.push(String(m)); }
  function b64DecodeUnicode(s){ return Buffer.from(s, "base64").toString("utf8"); }
  var fetch = function(){ if (!serverItems) return Promise.resolve({ ok: false }); return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ sha: "s", content: Buffer.from(JSON.stringify({ schema: 1, items: serverItems }), "utf8").toString("base64") }); } }); };
  var confirm = function(){ return true; }, alert = function(m){ alerts.push(String(m)); };
  var asb = [], asbLoaded = true, SITE_KIND = { asbestos:"석면", demolition:"철거", dredge:"준설" }, apprPendingCreates = [];
  function siteKind(r){ return (r && SITE_KIND[r.kind]) ? r.kind : "asbestos"; }
  function liveSites(){ return asb.filter(function(r){ return r && r.del !== 1; }); }
  function findAsb(id){ for (var i = 0; i < asb.length; i++) if (asb[i].id === id) return asb[i]; return null; }
  function scheduleAsbSave(){} function apprSavePending(){} function apprFlushCreates(){} function myId(){ return "m1"; } function memberName(){ return ""; } function fmtDate(d){ return d.toISOString().slice(0, 10); } 
  var gwCall = null; var Date = globalThis.Date;
`;
const tplLine = (html.match(/var TPL_LABELS=\{[^\r\n]*\};/) || [''])[0];
const api = new Function('contracts', 'tasks', 'recs', stubs + tplLine + fnOf('conAttList') + scen + sheet + fnOf('stageXlsxKind') + fnOf('advanceProc') + fnOf('materializeStage') + fnOf('procStageTitle') + `
  return { CON_COLS, CON_SCEN, CON_PACKETS, conScenStages, conModalElems, stageDocsFor, csStageFields, stageXlsxKind, csRowHtml, csDetailHtml, csStageInfo, csSortRows, csPass, csEnumValues, csEndCell, csKind, csSkipStage, csJumpStage, csUnskipStage, csPacketsHtml, csLoadTpl, csApprKind, csApprSubmit, csApprOnDecided, csApprFind, csSyncFromServer, csApprSync, csApprDropped, csAlignTasksAll, toasts: toasts, saveNow: function(){ return saveNowN; }, csLinkSite, csLinkSiteLater, csOnDone, csSiteDone, csSiteHooksRetry, csNextFeb15, advanceProc, materializeStage, asb: asb, tasks: tasks, appr: apprPendingCreates, alerts: alerts, bills: function(){ return billN; }, setServer: function(items){ serverItems = items; }, pushContract: function(c){ contracts.push(c); }, popContract: function(){ contracts.pop(); }, setAsbLoaded: function(v){ asbLoaded = v; }, setTab: function(t){ conDetTab = t; }, openStage: function(k){ csStageOpen = k; }, setTpl: function(o){ csTplKeys = o; csTplErr = 0; }, setTplErr: function(v){ csTplErr = v; }, tplState: function(){ return { keys: csTplKeys, err: csTplErr, loading: csTplLoading }; }, setGw: function(f){ gwCall = f; } };
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
// v384 결재·대장 (10/13 적대 검토 반영판 — advanceProc·materializeStage는 실함수, 서버 계약본은 fetch 스텁)
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));
T('v384 csApprKind: 계약서류 작성→계약 단계 · 청구 및 입금확인→청구 검수 · (계약서·발주서)→계약 단계 · 견적·수의계약→없음(견적) · 작업 수행→없음', api.csApprKind('계약서류 작성') === '계약 단계' && api.csApprKind('청구 및 입금확인') === '청구 검수' && api.csApprKind('(계약서·발주서)') === '계약 단계' && api.csApprKind('견적·수의계약') === '' && api.csApprKind('작업 수행') === '', '');
let c5 = mk(); c5.client = '포항철강산업단지관리공단'; c5.title = '하수도시설물 준설공사(3공구)'; c5.who = '운영부';
T('v384 csApprSubmit: 큐에 1건(kind 청구 검수, ref con:id|main|6, 제목 [계약] 발주처 · 단계) · stage.appr 대기(cid·at·by_id)', api.csApprSubmit(c5, c5.pipes[0], 6) === true && api.appr.length === 1 && api.appr[0].kind === '청구 검수' && api.appr[0].ref === 'con:c_t|main|6' && /^\[계약\] 포항철강산업단지관리공단 · 청구 및 입금확인$/.test(api.appr[0].title) && c5.pipes[0].stages[6].appr.status === '대기' && c5.pipes[0].stages[6].appr.by_id === 'm1' && /^\d{4}-/.test(c5.pipes[0].stages[6].appr.at), JSON.stringify(api.appr[0]));
const s6 = c5.pipes[0].stages[6], itemsMix = [{ id: 'ap1', ref: 'con:c_t|main|6', cid: 'old', status: '반려', reason: '금액 확인', created: '2026-10-13T00:00:00.000Z' }, { id: 'ap2', ref: 'con:c_t|main|6', cid: s6.appr.cid, status: '대기', created: '2026-10-13T00:10:00.000Z' }];
T('v384 검토 A csApprFind: cid가 있으면 cid 카드만(옛 반려 ap1 무시 → ap2) · cid 없으면 상신 시각 이후 가장 최근 ref 카드', api.csApprFind(itemsMix, c5, c5.pipes[0], 6, s6).id === 'ap2' && (() => { const sv = { appr: { at: '2026-10-13T00:05:00.000Z' } }; const f = api.csApprFind(itemsMix, c5, c5.pipes[0], 6, sv); return f && f.id === 'ap2'; })() && api.csApprFind([itemsMix[0]], c5, c5.pipes[0], 6, { appr: { at: '2026-10-13T00:05:00.000Z' } }) === null, '');
api.pushContract(c5); api.setServer(null);
api.csApprOnDecided({ id: 'ap1', ref: 'con:c_t|main|6', status: '반려', reason: '금액 확인', decided_by: { name: '대표' }, decided_at: '2026-10-13T01:00:00Z' }); await tick();
T('v384 csApprOnDecided 반려(서버본 없음): stage.appr 반려·사유·결정자 · 단계는 그대로(cur 0)', s6.appr.status === '반려' && s6.appr.reason === '금액 확인' && s6.appr.decided_by === '대표' && c5.pipes[0].cur === 0, JSON.stringify(s6.appr));
c5.pipes[0].cur = 6; s6.status = 'open'; const nT0 = api.tasks.length, b0 = api.bills();
api.csApprSubmit(c5, c5.pipes[0], 6); api.csApprOnDecided({ id: 'ap2', ref: 'con:c_t|main|6', status: '승인', decided_by: { name: '대표' }, decided_at: '2026-10-13T01:00:00Z' }); await tick(200);
T('v384 csApprOnDecided 승인(현재 단계, 지시 없음): 단계 done · cur 7 · 다음 단계 open + 지시 1건(실 materializeStage) · 청구라 기성 연동 1회', s6.status === 'done' && c5.pipes[0].cur === 7 && c5.pipes[0].stages[7].status === 'open' && api.tasks.length === nT0 + 1 && !!c5.pipes[0].stages[7].task_id && api.bills() === b0 + 1, JSON.stringify(c5.pipes[0].stages.map((x) => x.status)) + ' bills ' + (api.bills() - b0));
api.popContract();
// 검토 B — 두 기기: 서버본(다른 기기가 이미 승인·진행)이 앞서 있으면 채택만 하고 다시 진행하지 않는다
let cA = mk(); cA.id = 'c_dbl'; cA.pipes[0].cur = 6; cA.pipes[0].stages[6].status = 'open'; api.csApprSubmit(cA, cA.pipes[0], 6);
const srv = JSON.parse(JSON.stringify(cA)); srv.pipes[0].stages[6].status = 'done'; srv.pipes[0].stages[6].appr.status = '승인'; srv.pipes[0].cur = 7; srv.pipes[0].stages[7].status = 'open'; srv.pipes[0].stages[7].task_id = 't_srv';
api.pushContract(cA); api.setServer([srv]); const nT1 = api.tasks.length, b1 = api.bills();
api.csApprOnDecided({ id: 'ap9', ref: 'con:c_dbl|main|6', status: '승인', decided_by: { name: '대표' }, decided_at: '2026-10-13T01:00:00Z' }); await tick(200);
T('v384 검토 B 중복 적용 방지: 서버본 채택(cur 7·stage7 task_id t_srv 그대로) · 새 지시 0 · 기성 연동 0', cA.pipes[0].cur === 7 && cA.pipes[0].stages[7].task_id === 't_srv' && cA.pipes[0].stages[6].appr.status === '승인' && api.tasks.length === nT1 && api.bills() === b1, JSON.stringify({ cur: cA.pipes[0].cur, t7: cA.pipes[0].stages[7].task_id, nT: api.tasks.length - nT1, bills: api.bills() - b1 }));
api.popContract(); api.setServer(null);
T('v384 2차 F1 csSyncFromServer: 서버본에 없는 로컬 키(site_id)는 남는다 · 진행은 앞선 쪽(서버 cur 1)', (() => { const l = mk(); l.site_id = 'keep'; const sv = JSON.parse(JSON.stringify(l)); delete sv.site_id; sv.pipes[0].cur = 1; return api.csSyncFromServer(l, sv) === true && l.site_id === 'keep' && l.pipes[0].cur === 1; })(), '');
T('v384 2차 F1 csSyncFromServer 같은 날 동률: 서버의 공사명·단계 입력값(vals)·상신(appr)이 로컬에 들어오고, 로컬에만 있는 vals는 남는다', (() => { const l = mk(); l.pipes[0].stages[2].vals = { only_local: 1 }; const sv = JSON.parse(JSON.stringify(l)); sv.title = 'T2'; sv.pipes[0].stages[6].vals = { tax_no: 'x' }; sv.pipes[0].stages[6].appr = { cid: 'k', kind: '청구 검수', at: '2026-10-13T00:00:00.000Z', status: '대기' }; delete sv.pipes[0].stages[2].vals; const ch = api.csSyncFromServer(l, sv); return ch === true && l.title === 'T2' && l.pipes[0].stages[6].vals.tax_no === 'x' && l.pipes[0].stages[6].appr.status === '대기' && l.pipes[0].stages[2].vals.only_local === 1; })(), '');
T('v384 2차 F1 csSyncFromServer: 같은 상신이면 결정이 난 쪽(승인)이 이긴다 · 더 최근 상신(at 뒤)이 이긴다', (() => { const l = mk(); l.pipes[0].stages[6].appr = { cid: 'k', at: '2026-10-13T00:00:00.000Z', status: '대기' }; const sv = JSON.parse(JSON.stringify(l)); sv.pipes[0].stages[6].appr.status = '승인'; api.csSyncFromServer(l, sv); const a = l.pipes[0].stages[6].appr.status === '승인'; const l2 = mk(); l2.pipes[0].stages[6].appr = { cid: 'new', at: '2026-10-13T01:00:00.000Z', status: '대기' }; const sv2 = JSON.parse(JSON.stringify(l2)); sv2.pipes[0].stages[6].appr = { cid: 'old', at: '2026-10-13T00:00:00.000Z', status: '반려' }; api.csSyncFromServer(l2, sv2); return a && l2.pipes[0].stages[6].appr.cid === 'new'; })(), '');
T('v384 2차 csSyncFromServer: 서버가 뒤(cur 작음)면 로컬 진행 유지 · 서버 파이프가 전부 끝났으면 status done', (() => { const l = mk(); l.pipes[0].cur = 3; const sv = JSON.parse(JSON.stringify(l)); sv.pipes[0].cur = 2; api.csSyncFromServer(l, sv); return l.pipes[0].cur === 3; })() && (() => { const l = mk(); const sv = JSON.parse(JSON.stringify(l)); sv.pipes[0].cur = sv.pipes[0].stages.length; sv.pipes[0].stages.forEach((s) => { s.status = 'done'; }); return api.csSyncFromServer(l, sv) === true && l.status === 'done'; })(), '');
// 2차 F1 끝에서 끝: 결정 기기(PM)의 사본에는 상신 기록이 없고 서버에는 상신+입력값이 있다 → 접목 뒤 승인 적용, 입력값·공사명 보존, 즉시 저장
let cF = mk(); cF.id = 'c_f1'; cF.pipes[0].cur = 6; cF.pipes[0].stages[6].status = 'open';
const srvF = JSON.parse(JSON.stringify(cF)); srvF.title = 'T-서버'; srvF.pipes[0].stages[6].vals = { tax_no: 'TX1' }; srvF.pipes[0].stages[6].appr = { cid: 'kf', kind: '청구 검수', at: '2026-10-13T00:00:00.000Z', by_id: 'm9', status: '대기' };
api.pushContract(cF); api.setServer([srvF]); const nTF = api.tasks.length, bF = api.bills(), svN = api.saveNow();
api.csApprOnDecided({ id: 'apf', ref: 'con:c_f1|main|6', status: '승인', decided_by: { name: '대표' }, decided_at: '2026-10-13T00:30:00Z' }); await tick(200);
T('v384 2차 F1·F3·F18 결정 기기: 서버 상신 기록 접목 → 승인 적용(cur 7·지시 1) · 서버 입력값·공사명 보존 · 즉시 저장 1회 · 토스트 없음', cF.pipes[0].cur === 7 && cF.pipes[0].stages[6].status === 'done' && cF.pipes[0].stages[6].vals.tax_no === 'TX1' && cF.title === 'T-서버' && api.tasks.length === nTF + 1 && api.bills() === bF + 1 && api.saveNow() === svN + 1 && api.toasts.length === 0, JSON.stringify({ cur: cF.pipes[0].cur, vals: cF.pipes[0].stages[6].vals, title: cF.title, saves: api.saveNow() - svN, toasts: api.toasts }));
api.popContract(); api.setServer(null);
api.csApprOnDecided({ id: 'apx', ref: 'con:nope|main|6', status: '승인' }); await tick();
T('v384 2차 F3: 계약을 못 찾으면 토스트', api.toasts.length === 1 && /찾지 못했습니다/.test(api.toasts[0]), JSON.stringify(api.toasts));
// 2차 F4·F18 폴: 카드 없음 + 큐 없음 + 2분 경과 → 미전송 · 결정 20초 안이면 적용 보류 · 20초 지나면 적용
let cP = mk(); cP.id = 'c_poll'; cP.pipes[0].cur = 6; cP.pipes[0].stages[6].status = 'open'; api.csApprSubmit(cP, cP.pipes[0], 6); api.appr.length = 0; cP.pipes[0].stages[6].appr.at = new Date(Date.now() - 180000).toISOString();
api.pushContract(cP); api.setGw(() => Promise.resolve({ status: 200, body: { items: [] } })); api.csApprSync(cP, true); await tick(20);
T('v384 2차 F4: 카드도 큐도 없고 2분 지남 → stage.appr 미전송(카드에 [상신] 다시)', cP.pipes[0].stages[6].appr.status === '미전송', cP.pipes[0].stages[6].appr.status);
cP.pipes[0].stages[6].appr.status = '대기'; const cidP = cP.pipes[0].stages[6].appr.cid;
api.setGw(() => Promise.resolve({ status: 200, body: { items: [{ id: 'app', cid: cidP, ref: 'con:c_poll|main|6', status: '승인', decided_at: new Date().toISOString(), decided_by: { name: 'PM' } }] } })); api.csApprSync(cP, true); await tick(20);
const held = cP.pipes[0].stages[6].status === 'open' && cP.pipes[0].stages[6].appr.status === '대기';
api.setGw(() => Promise.resolve({ status: 200, body: { items: [{ id: 'app', cid: cidP, ref: 'con:c_poll|main|6', status: '승인', decided_at: new Date(Date.now() - 60000).toISOString(), decided_by: { name: 'PM' } }] } })); api.csApprSync(cP, true); await tick(200);
T('v384 2차 F18 폴: 결정 20초 안이면 보류(대기 유지) · 60초 지난 승인은 적용(done·cur 7)', held && cP.pipes[0].stages[6].status === 'done' && cP.pipes[0].cur === 7, JSON.stringify({ held, st: cP.pipes[0].stages[6].status, cur: cP.pipes[0].cur }));
api.popContract(); api.setGw(null);
// 2차 F4 csApprDropped · F7/F11 csAlignTasksAll
let cD = mk(); cD.id = 'c_drop'; cD.pipes[0].cur = 6; cD.pipes[0].stages[6].status = 'open'; api.csApprSubmit(cD, cD.pipes[0], 6); api.pushContract(cD); api.csApprDropped('con:c_drop|main|6', cD.pipes[0].stages[6].appr.cid);
T('v384 2차 F4 csApprDropped: 4xx 폐기 → 미전송', cD.pipes[0].stages[6].appr.status === '미전송', '');
api.popContract();
let cG = mk(); cG.id = 'c_align'; cG.pipes[0].cur = 2; api.pushContract(cG); api.materializeStage(cG, cG.pipes[0], '2026-10-13'); const tG = api.tasks[api.tasks.length - 1]; cG.pipes[0].stages[2].status = 'done'; cG.pipes[0].stages[2].done_at = '2026-10-13'; cG.pipes[0].cur = 3; tG.status = 'review';
const nAl = api.csAlignTasksAll();
T('v384 2차 F7·F11 csAlignTasksAll: 단계 done인데 지시 review → done 1건(approved_by 결재함)', nAl === 1 && tG.status === 'done' && tG.approved_by === '결재함', JSON.stringify({ nAl, st: tG.status }));
api.popContract();
// 검토 J — 상신한 단계의 지시는 완료 요청으로 잠기고, 승인/완료로 advanceProc를 불러도 넘어가지 않는다
let cL = mk(); cL.id = 'c_lock'; cL.client = '잠금'; const li = cL.pipes[0].stages.findIndex((s) => /계약서/.test(s.name)); cL.pipes[0].cur = li; api.pushContract(cL); api.materializeStage(cL, cL.pipes[0], '2026-10-13');
const tL = api.tasks[api.tasks.length - 1]; api.csApprSubmit(cL, cL.pipes[0], li); const na0 = api.alerts.length; tL.status = 'done'; api.advanceProc(tL);
T('v384 검토 J 잠금: 상신 → 지시 review("결재함 상신") · [완료]→advanceProc는 되돌림(review 유지·cur 그대로·안내 1회)', li >= 0 && tL.status === 'review' && /결재함 상신/.test(tL.done_by || '') && cL.pipes[0].cur === li && cL.pipes[0].stages[li].status === 'open' && api.alerts.length === na0 + 1 && /상신돼 있습니다/.test(api.alerts[api.alerts.length - 1]), JSON.stringify({ li, st: tL.status, by: tL.done_by, sst: cL.pipes[0].stages[li].status, cur: cL.pipes[0].cur, alerts: api.alerts.length - na0, last: api.alerts[api.alerts.length - 1] }));
const nUn0 = api.alerts.length, tUn = (() => { const x = mk(); x.id = 'c_unsub'; x.pipes[0].cur = li; api.pushContract(x); api.materializeStage(x, x.pipes[0], '2026-10-13'); const t = api.tasks[api.tasks.length - 1]; t.status = 'done'; const r = api.advanceProc(t); api.popContract(); return { r, st: t.status, cur: x.pipes[0].cur }; })();
T('v384 2차 F2 잠금 확대: 미상신 결재 단계도 advanceProc false·지시 review·cur 그대로·"상신이 필요" 안내', tUn.r === false && tUn.st === 'review' && tUn.cur === li && api.alerts.length === nUn0 + 1 && /상신이 필요합니다/.test(api.alerts[api.alerts.length - 1]), JSON.stringify(tUn));
api.popContract();
// 대장 연결
api.asb.push({ id: 'a1', kind: 'dredge', title: '하수도시설물 준설공사(3공구)', client: '포항철강산업단지관리공단', start: '2026-10-01', status: 'run' });
let c6 = mk(); c6.id = 'c_6'; c6.client = '포항철강산업단지관리공단'; c6.title = '하수도시설물 준설공사(3공구)';
const linked = api.csLinkSite(c6, true);
T('v384 csLinkSite: 같은 종류·공사명 대장에 연결(새로 만들지 않음) · con_id/site_id 양방향', linked && linked.id === 'a1' && linked.con_id === 'c_6' && c6.site_id === 'a1' && api.asb.length === 1, JSON.stringify(linked));
let c7 = mk(); c7.id = 'c_7'; c7.client = '동국제강(주) 포항공장'; c7.title = '세륜기 준설'; const made = api.csLinkSite(c7, true);
T('v384 csLinkSite: 맞는 대장이 없으면 새 대장(kind dredge·status plan·note 자동 생성)', made && made.id !== 'a1' && made.kind === 'dredge' && made.status === 'plan' && /자동 생성/.test(made.note) && api.asb.length === 2, '');
let c8 = mk(); c8.id = 'c_8'; c8.type = 'waste'; T('v384 csLinkSite: 운반은 대장 없음(null)', api.csLinkSite(c8, true) === null, '');
let c8b = mk(); c8b.id = 'c_8b'; api.setAsbLoaded(false); T('v384 csLinkSite: 대장 로드 전엔 보류(null·새 대장 없음)', api.csLinkSite(c8b, false) === null && api.asb.length === 2, ''); api.setAsbLoaded(true);
api.asb.push({ id: 'a10', kind: 'dredge', title: '세륜기 준설 반복', client: '반복발주처', start: '2025-10-01', status: 'done' });
let c13 = mk(); c13.id = 'c_13'; c13.client = '반복발주처'; c13.title = '세륜기 준설 반복'; c13.start = '2026-10-01'; const m13 = api.csLinkSite(c13, true);
T('v384 검토 D: 종결된 작년 대장(같은 공사명)에는 붙이지 않고 새 대장 · 발주처만 같고 현장·시작일 다르면 연결 안 함', m13 && m13.id !== 'a10' && api.asb.length === 4 && (() => { const x = mk(); x.id = 'c_14'; x.client = '포항철강산업단지관리공단'; x.title = '다른 공사'; x.site = '다른 현장'; x.start = '2026-12-01'; api.asb.push({ id: 'a11', kind: 'dredge', title: '또 다른 공사', client: '포항철강산업단지관리공단', site: '엉뚱 현장', start: '2026-01-01', status: 'run' }); const r = api.csLinkSite(x, 'find'); return r === null; })(), JSON.stringify(m13));
let c15 = mk(); c15.id = 'c_15'; c15.site_id = 'a_gone'; api.asb.push({ id: 'a_gone', kind: 'dredge', title: 'x', del: 1 }); c15.title = '삭제후 재연결'; const m15 = api.csLinkSite(c15, true);
T('v384 검토 K: 삭제된 대장을 가리키는 계약은 다시 연결(새 대장)', m15 && m15.id !== 'a_gone' && c15.site_id === m15.id, '');
T('v384 2차 F10: 이미 이 계약을 가리키는 대장(con_id)이 있으면 그 행에 재연결(새 대장 없음)', (() => { api.asb.push({ id: 'a_own', kind: 'dredge', title: 'own', con_id: 'c_own', status: 'run' }); const x = mk(); x.id = 'c_own'; x.title = '다른 이름'; const n = api.asb.length; const r = api.csLinkSite(x, true); return r && r.id === 'a_own' && x.site_id === 'a_own' && api.asb.length === n; })(), '');
T('v384 2차 F16: 발주처 같고 시작일만 같으면(현장 다름) 연결 안 함', (() => { api.asb.push({ id: 'a_sd', kind: 'dredge', title: '다른 공사 A', client: '같은발주처', site: '현장A', start: '2026-10-13', status: 'run' }); const x = mk(); x.id = 'c_sd'; x.client = '같은발주처'; x.title = '다른 공사 B'; x.site = '현장B'; x.start = '2026-10-13'; return api.csLinkSite(x, 'find') === null; })(), '');
T('v384 2차 F12: 옛 계약(scen 없음)은 연결만 — 종결 계약이어도 대장을 done으로 바꾸지 않는다', (() => { api.asb.push({ id: 'a_old', kind: 'dredge', title: '옛 계약 공사', status: 'run' }); const x = mk(); x.id = 'c_old'; delete x.scen; x.title = '옛 계약 공사'; x.status = 'done'; const r = api.csLinkSite(x, true); const row = api.asb.find((q) => q.id === 'a_old'); return r && r.id === 'a_old' && row.status === 'run' && !x.site_hook; })(), '');
T('v384 2차 F8: 가리키는 대장이 로컬에 없으면 csSiteDone은 표식 없이 보류(false) · csLinkSiteLater는 다시 받기(wait)', (() => { const x = mk(); x.id = 'c_miss'; x.site_id = 'a_not_here'; x.status = 'done'; const r = api.csSiteDone(x); const w = api.csLinkSiteLater(x); return r === false && !x.site_hook && w === 'wait'; })(), '');
T('v384 2차 F9: "none" 표식 계약을 새 대장에 재연결하면 표식 해제 + 대장 done·ks 초안', (() => { const x = mk(); x.id = 'c_none'; x.title = '없음 재연결'; x.status = 'done'; x.site_hook = 'none'; x.site_id = 'a_gone'; const r = api.csLinkSite(x, true); return r && r.status === 'done' && r.ks && r.ks.draft === 1 && x.site_hook === '2026-10-13'; })(), '');
// 검토 G — 못 받은 기기: 큐에 넣고 받은 뒤 연결
let c16 = mk(); c16.id = 'c_16'; c16.title = '큐 연결'; api.pushContract(c16); api.setAsbLoaded(false); const w16 = api.csLinkSiteLater(c16); api.setAsbLoaded(true); api.csSiteHooksRetry();
T('v384 검토 G csLinkSiteLater: 미로드 → "wait" · loadAsb 뒤 csSiteHooksRetry가 연결', w16 === 'wait' && !!c16.site_id && api.asb.some((r) => r.id === c16.site_id && r.con_id === 'c_16'), JSON.stringify({ w16, sid: c16.site_id }));
api.popContract();
// 종결 훅
c6.contract_info = { amount: 19525000, d1: '2026-05-08' }; c6.settle_amount = 19450000; c6.status = 'done'; const nT = api.tasks.length; api.csOnDone(c6);
const t15 = api.tasks[api.tasks.length - 1];
T('v384 csOnDone: 대장 done·end 채움·ks 초안(상ㆍ하수도설비공사업·정산액 19,450,000·계약일·corp 환경·draft) · 2/15 할 일 1건(다음 2월 15일) · 두 번 불러도 1회 · site_hook/task_hook', linked.status === 'done' && !!linked.end && linked.ks && linked.ks.biz === '상ㆍ하수도설비공사업' && linked.ks.amount === 19450000 && linked.ks.contract_date === '2026-05-08' && linked.ks.corp === '주식회사 종운환경' && linked.ks.draft === 1
  && api.tasks.length === nT + 1 && t15.title === '실적신고(2/15) — 하수도시설물 준설공사(3공구)' && t15.due === '2027-02-15' && (api.csOnDone(c6), api.tasks.length === nT + 1) && c6.site_hook === '2026-10-13' && c6.task_hook === '2026-10-13', JSON.stringify(linked.ks) + ' ' + (t15 && t15.due));
T('v384 검토 I: 옛 계약(scen 없음)은 종결 훅 없음(2/15 지시 안 만듦)', (() => { const o = mk(); delete o.scen; o.status = 'done'; const n = api.tasks.length; api.csOnDone(o); return api.tasks.length === n && !o.task_hook; })(), '');
// 검토 C — 대장을 못 받은 기기에서 종결: site_hook 안 찍고 보류 → 받은 뒤 재시도로 처리
api.asb.push({ id: 'a9', kind: 'dredge', title: '미로드 종결', client: 'z', status: 'run' });
let c12 = mk(); c12.id = 'c_12'; c12.title = '미로드 종결'; c12.site_id = 'a9'; c12.status = 'done'; api.pushContract(c12); api.setAsbLoaded(false); api.csOnDone(c12);
const a9 = api.asb.find((r) => r.id === 'a9'); const midState = { run: a9.status === 'run', site_hook: c12.site_hook, task_hook: c12.task_hook };
api.setAsbLoaded(true); api.csSiteHooksRetry();
T('v384 검토 C: 미로드 종결 → task_hook만 · site_hook 없음 · 대장 run 그대로 → 로드 뒤 재시도로 대장 done·ks 초안·site_hook', midState.run && !midState.site_hook && !!midState.task_hook && a9.status === 'done' && a9.ks && a9.ks.draft === 1 && c12.site_hook === '2026-10-13', JSON.stringify({ midState, after: a9.status, hook: c12.site_hook }));
api.popContract();
T('v384 ks 초안은 빈 칸만: 사람이 넣은 ks.amount·no는 유지, no가 있으면 draft 없음', (() => { api.asb.push({ id: 'a_ks', kind: 'dredge', title: 'ks', status: 'run', ks: { no: '2026-001', amount: 123 } }); const x = mk(); x.id = 'c_ks'; x.site_id = 'a_ks'; x.status = 'done'; api.csSiteDone(x); const r = api.asb.find((q) => q.id === 'a_ks'); return r.status === 'done' && r.ks.no === '2026-001' && r.ks.amount === 123 && r.ks.biz === '상ㆍ하수도설비공사업' && !r.ks.draft; })(), '');
T('v384 csNextFeb15: 2026-10-13 기준 → 2027-02-15', api.csNextFeb15() === '2027-02-15', api.csNextFeb15());
T('준공·만기 칸: d3 없음 → "-" · 지난 날짜 → vs-dan · 완료 건 → 회색 완료', api.csEndCell({ status: 'active' }).html.indexOf('-') >= 0 && api.csEndCell({ status: 'active', contract_info: { d3: '2026-01-01' } }).cls === 'vs-dan' && /완료/.test(api.csEndCell({ status: 'done' }).html), '');
console.log(fails ? '\n계약 시트 실행 검사 실패 ' + fails + '건' : '\n계약 시트 실행 검사 전 항목 통과'); process.exit(fails ? 1 : 0);
