// 계약 시트·시나리오 순수 함수 실행 검사(v381~) — 브라우저 없이 백업 실데이터로 행·상세·정렬·필터·단계 목록·서류 라우팅을 실제로 돌려 본다.
// 실행: node tools/consheet_check.mjs   (백업: ../jongwoon-appdata/data/backup/gw/ 조각 + manifest.json, 없으면 옛 gw_backup.json)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < 0) throw new Error('segment ' + a); return html.slice(i, j); };
const scen = cut('// @con-scen-start', '// @con-scen-end');
const sheet = cut('// @con-sheet-start', '  function renderContracts(){');
const fnOf = (name) => { const i = html.indexOf('  function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html.length; j++) { const ch = html[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); } } throw new Error(name); };
// 10/29 appdata 백업이 조각 형식(data/backup/gw/gw_NN.json + manifest.json)으로 바뀜 — 조각의 gw_data를 합친다. 없으면 옛 한 파일.
const bkBase = [join(ROOT, '..', 'jongwoon-appdata', 'data', 'backup'), 'C:/Users/user/jongwoon/jongwoon-appdata/data/backup'].find((p) => existsSync(join(p, 'gw', 'manifest.json')) || existsSync(join(p, 'gw_backup.json')));
const loadGwData = (base) => {
  const man = join(base, 'gw', 'manifest.json');
  if (!existsSync(man)) return JSON.parse(readFileSync(join(base, 'gw_backup.json'), 'utf8')).stores.gw_data;
  const out = {};
  for (const f of JSON.parse(readFileSync(man, 'utf8')).files) Object.assign(out, (JSON.parse(readFileSync(join(base, 'gw', f.name), 'utf8')).stores || {}).gw_data || {});
  return out;
};
const bk = bkBase ? loadGwData(bkBase) : null;
const contracts = bk ? bk['col:contracts'].items.filter((c) => c && c.del !== 1) : [];
const tasks = (bk && bk['col:tasks'] && bk['col:tasks'].items) || [];
const recs = (bk && bk['col:receivables'] && bk['col:receivables'].items) || [];
const stubs = `
  var window = { addEventListener: function(){}, matchMedia: function(){ return { matches: false, addEventListener: function(){} }; }, innerWidth: 1200 };
  var docEls = {}; var document = { getElementById: function(id){ return docEls[id] || null; }, querySelectorAll: function(){ return []; } };
  var workers = [], errCalls = []; function reportErr(m, s){ errCalls.push([String(m), String(s || "")]); }   // v419 xgBuildEdits·학습 칸 주입 실제 실행용
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
  function pipeLabel(k){ return k === "waste" ? "폐기물" : (k === "chg" ? "변경계약" : "본"); }
  function conAttBoxHtml(c){ return (c.attachments && c.attachments["서류함"] && c.attachments["서류함"].length) ? '<div data-catt-drop="' + c.id + '">att</div>' : ''; }
  var gidN = 0; function genId(p){ return p + "x" + (++gidN); }   // 고유해야 한다 — 같은 id면 findTask가 엉뚱한 지시를 집는다(검토 J 검사에서 실측)
  function myName(){ return "검사"; }
  var schedN = 0; function scheduleContractSave(){ schedN++; } function saveTasksCache(){} function scheduleTasksSave(){} function renderTasks(){} function renderSummary(){} function renderContracts(){}
  var csnN = 0; function completeStageNow(){ csnN++; return "done"; }
  var alerts = []; var CONTRACT_API = "contracts.json", serverItems = null, billN = 0;
  function getToken(){ return "t"; } function ghHeaders(){ return {}; } function loadTasks(){} function loadAsb(){} function conBillToRec(){ billN++; } function canSee(){ return true; } var contractSaveTimer = null, saveNowN = 0; function doSaveContracts(){ saveNowN++; } var toasts = []; function apprToastShow(m){ toasts.push(String(m)); }
  function b64DecodeUnicode(s){ return Buffer.from(s, "base64").toString("utf8"); }
  var fetch = function(){ if (!serverItems) return Promise.resolve({ ok: false }); return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ sha: "s", content: Buffer.from(JSON.stringify({ schema: 1, items: serverItems }), "utf8").toString("base64") }); } }); };
  var confirms = []; var confirm = function(m){ confirms.push(String(m)); return true; }, alert = function(m){ alerts.push(String(m)); };
  var asb = [], asbLoaded = true, SITE_KIND = { asbestos:"석면", demolition:"철거", dredge:"준설" }, apprPendingCreates = [];
  function siteKind(r){ return (r && SITE_KIND[r.kind]) ? r.kind : "asbestos"; }
  function liveSites(){ return asb.filter(function(r){ return r && r.del !== 1; }); }
  function findAsb(id){ for (var i = 0; i < asb.length; i++) if (asb[i].id === id) return asb[i]; return null; }
  function scheduleAsbSave(){} function apprSavePending(){} function apprFlushCreates(){} function myId(){ return "m1"; } function memberName(){ return ""; } function fmtDate(d){ return d.toISOString().slice(0, 10); } 
  var gwCall = null; var Date = globalThis.Date;
  function curMember(){ return { id: "m1" }; } function apprGradeChipCss(){ return ""; } function renderDashboard(){}   // v402 로더·카드·startProcess 실제 실행용
`;
const tplLine = (html.match(/var TPL_LABELS=\{[^\r\n]*\};/) || [''])[0] + (html.match(/var TPL_EXT=\{[^\r\n]*\};/) || [''])[0] + cut('  var XG_SAFE_CO=', '  function xgToggle(){');   // v422 준설 실물 양식 함수
const opt = (n) => { try { return fnOf(n); } catch (e) { return ''; } };   // v404: 날짜 실함수(isDate·addDays·pad) — 스텁 addDays 항등 함수 제거
const api = new Function('contracts', 'tasks', 'recs', stubs + opt('isDate') + opt('addDays') + opt('pad') + opt('fmtDate') + tplLine + ' var CDOC = {}, CDOC_TTL = 60000, CDOC_KIND_LABEL = { draft:"초안", final:"최종본", received:"수령" }; ' + fnOf('cdocSan') + fnOf('cdocDocKey') + fnOf('cdocPkKey') + fnOf('cdocItems') + fnOf('cdocLive') + fnOf('cdocCurOf') + fnOf('cdocPkHit') + fnOf('cdocDay') + fnOf('cdocLoad') + fnOf('cdocRowsHtml') + fnOf('cdocTrashHtml') + fnOf('csCdocDraft') + fnOf('xgBuildEdits') + fnOf('koAmount') + fnOf('dateSerial') + fnOf('wkLabel') + fnOf('findWk') + fnOf('xgMergeLearned') + fnOf('xgApplyLearned') + fnOf('conAttList') + scen + sheet + fnOf('stageXlsxKind') + fnOf('advanceProc') + fnOf('materializeStage') + fnOf('procStageTitle') + cut('  var CON_PROC_SRC', '  // 제목 키워드로 요소 제안') + cut('  var WASTE_BACKBONE = [', '  // @con-scen-start') + fnOf('applyPublicMilestones') + fnOf('startProcess') + `
  return { xgSafetyVals, xgSafetyMissing, xgSafetyGen, XG_SAFE_FILES, csGenKeys, xgBuildEdits, xgMergeLearned, xgApplyLearned, errCalls: errCalls, CDOC, cdocTrashHtml, cdocDocKey, cdocPkKey, cdocLive, cdocCurOf, cdocPkHit, cdocRowsHtml, cdocLoad, csCdocDraft, CON_MAP, CON_BG, CON_PROC_SRC, conDueUse, conDueClear, conDueOn, conStageDue, conAnnualNext, conBaseDate, conAddBizDays, materializeStage, asb, todayStr, tasks, CON_COLS, CON_SCEN, CON_PACKETS, STAGE_DOCS, conScenStages, conModalElems, stageDocsFor, csSplitTop, csParseStageDocs, csStageDocItems, csStageDocsHtml, csDocToggle, csDocNa, csDocAdd, csDocDel, csMergeDocs, csStageFields, stageXlsxKind, csRowHtml, csDetailHtml, csStageInfo, csSortRows, csPass, csEnumValues, csEndCell, csKind, csSkipStage, csJumpStage, csUnskipStage, csPacketsHtml, csLoadTpl, csApprKind, csApprSubmit, csApprOnDecided, csApprFind, csSyncFromServer, csApprSync, csApprDropped, csAlignTasksAll, toasts: toasts, saveNow: function(){ return saveNowN; }, csLinkSite, csLinkSiteLater, csOnDone, csSiteDone, csSiteHooksRetry, csNextFeb15, advanceProc, materializeStage, asb: asb, tasks: tasks, appr: apprPendingCreates, alerts: alerts, bills: function(){ return billN; }, setServer: function(items){ serverItems = items; }, pushContract: function(c){ contracts.push(c); }, popContract: function(){ contracts.pop(); }, setAsbLoaded: function(v){ asbLoaded = v; }, setTab: function(t){ conDetTab = t; }, openStage: function(k){ csStageOpen = k; }, setTpl: function(o){ csTplKeys = o; csTplErr = 0; }, setTplErr: function(v){ csTplErr = v; }, tplState: function(){ return { keys: csTplKeys, err: csTplErr, loading: csTplLoading }; }, setGw: function(f){ gwCall = f; }, conScenKey, CON_ADDED, conAddedPrep, conAddedApply, conAddedUse, conAddedClear, conScenTag, conChgWindow, conAddedPreviewHtml, conRouteKey, stageDocsOf, csStageFieldsOf, csStageNew, csApprKindOf, csChgAmtChanged, csChgCan, csChgAdd, csChgOpenAt, csStagesHtml, csDoneStage, conProcLoad, renderConProcCard, startProcess, procSrc: function(){ return CON_PROC_SRC; }, setDocEl: function(id, el){ docEls[id] = el; }, sched: function(){ return schedN; }, csApprApply, csTaskChg, csChgBase, confirms: confirms, doneCalls: function(){ return csnN; } };
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
// v401 건별 서류 체크리스트(stage.docs[]) — 항목화 파서(괄호 보존)·골조 목록 커버리지·체크/해당없음/추가/삭제·s.docs 굳기·html 배선
{
  const P = (k) => api.csParseStageDocs(api.STAGE_DOCS[k]).map((x) => (x.t ? '[' + x.t + ']' : '') + x.n);
  T('v401 파서: 계약 8항(괄호 안 · 보존 "사용인감계(해당시 공동수급협정·수의계약확인서·안전보건확약서)") · 작업 3항(괄호 안 " — " 보존) · 견적 3항("[서류]" 괄호 안) · 수금확인 1항 태그 없음 · 완료신고 1항 · 청구 7항',
    P('계약').length === 8 && P('계약')[3] === '[작성]사용인감계(해당시 공동수급협정·수의계약확인서·안전보건확약서)' && P('계약')[4] === '[수정]설계내역서→낙찰금액 반영'
    && P('작업').length === 3 && P('작업')[2] === '[수령]농도/비산 측정결과보고서(석면 — 측정업체 발행)' && P('견적').length === 3 && P('견적')[0] === '[작성]견적서(회사별 양식 — [서류] 버튼으로 자동 생성)'
    && P('수금확인').length === 1 && P('수금확인')[0] === '입금 확인(계좌·금액 대조)' && P('완료신고').length === 1 && P('청구').length === 7 && P('청구')[4] === '[수령]국세/지방세 납세증명', JSON.stringify([P('계약'), P('작업'), P('청구')]));
  const names = [].concat(...Object.values(api.CON_SCEN)), withDocs = names.filter((n) => api.csStageDocItems({ name: n }).length > 0).length;
  T('v401 커버리지: 단계 이름 ' + names.length + '개 중 서류 목록 있는 것 ' + withDocs + '(실적보고·실적신고 2개만 없음) · 16키 전부 1항 이상 · 항목 k 고유', names.length === 81 && withDocs === 79 && Object.keys(api.STAGE_DOCS).every((k) => api.csParseStageDocs(api.STAGE_DOCS[k]).length >= 1)
    && (() => { const it = api.csStageDocItems({ name: '계약서류 작성' }); return new Set(it.map((d) => d.k)).size === it.length && it[0].k === '작성:0' && it[0].st === 'todo'; })(), '');
  const c9 = { id: 'c_v401', pipes: [{ key: 'main', cur: 0, stages: [{ name: '계약서류 작성', status: 'open', task_id: null }] }], status: 'active', scen: { type: 'asbestos' }, docType: 'public' };
  const p9 = c9.pipes[0], s9 = p9.stages[0];
  const html0 = api.csStageDocsHtml(c9, p9, 0, 'main|0', true);
  T('v401 html: 체크 8개 · 해당없음 버튼 8 · 추가 칸 1 · 골조 목록 표식 · 아직 s.docs 없음', (html0.match(/data-cs-dchk=/g) || []).length === 8 && (html0.match(/data-cs-dna=/g) || []).length === 8 && (html0.match(/data-cs-dnew=/g) || []).length === 1 && html0.indexOf('골조 목록') >= 0 && !Array.isArray(s9.docs), html0.slice(0, 200));
  api.csDocToggle(c9, p9, 0, '작성:0');
  T('v401 ☑ → s.docs 굳음(8항) · 작성:0 done · by/at', Array.isArray(s9.docs) && s9.docs.length === 8 && s9.docs[0].st === 'done' && s9.docs[0].by === 'm1' && s9.docs[0].at === '2026-10-13', JSON.stringify(s9.docs[0]));
  api.csDocToggle(c9, p9, 0, '작성:0'); api.csDocNa(c9, p9, 0, '수령:5');
  T('v401 다시 ☑ → todo · 해당없음 → na · na 항목 체크는 무시', s9.docs[0].st === 'todo' && s9.docs[5].st === 'na' && (api.csDocToggle(c9, p9, 0, '수령:5'), s9.docs[5].st === 'na'));
  api.csDocAdd(c9, p9, 0, '  현장 사진 '); api.csDocAdd(c9, p9, 0, '   ');
  T('v401 추가 → 9항(공백 이름 무시) · add:1 · k add: 접두 · 추가분 해당없음 무시', s9.docs.length === 9 && s9.docs[8].add === 1 && s9.docs[8].n === '현장 사진' && /^add:/.test(s9.docs[8].k) && (api.csDocNa(c9, p9, 0, s9.docs[8].k), s9.docs[8].st === 'todo'));
  const k9 = s9.docs[8].k; api.csDocDel(c9, p9, 0, '작성:1'); api.csDocDel(c9, p9, 0, k9);
  T('v401 삭제: 골조 항목은 안 지워짐 · 추가분만 제거 → 8항', s9.docs.length === 8 && s9.docs.some((d) => d.k === '작성:1'));
  const html1 = api.csStageDocsHtml(c9, p9, 0, 'main|0', false);
  T('v401 권한 없음 html: 버튼 0 · 체크 disabled 8 · 추가 칸 0 · 골조 표식 없음(굳은 뒤)', (html1.match(/data-cs-dna=/g) || []).length === 0 && (html1.match(/ disabled>/g) || []).length === 8 && (html1.match(/data-cs-dnew=/g) || []).length === 0 && html1.indexOf('골조 목록') < 0);
  const mA = [{ k: 'a', st: 'done', at: '2026-10-29' }, { k: 'b', st: 'todo' }], mB = [{ k: 'a', st: 'todo', at: '2026-10-28' }, { k: 'add:1', st: 'todo', add: 1, at: '2026-10-29' }];
  T('v401 검토 2 csMergeDocs: 같은 k 는 at 늦은 쪽 · 한쪽에만 있는 항목 보존 → 3항', (() => { const m = api.csMergeDocs(mA, mB); return m.length === 3 && m[0].st === 'done' && m[2].k === 'add:1'; })());
  T('v401 옛 계약(v382 이전 이름) 단계: 항목 0 · 빈 안내 · 추가 칸은 있음', api.csStageDocItems({ name: '현장 답사' }).length === 0 && api.csStageDocsHtml({ id: 'c_old', pipes: [{ key: 'main', cur: 0, stages: [{ name: '현장 답사' }] }], status: 'active' }, { key: 'main', cur: 0, stages: [{ name: '현장 답사' }] }, 0, 'main|0', true).indexOf('등록된 서류 목록이 없습니다') >= 0);
}

// ---- v402(10/30 계약 D1 4일차): 카드 9 신설 엔진(added) — 꺼짐 동일성 · 실데이터 켬 드라이런 · 사급/관급/목록 · 7번 고정 대안 · 결재 판정 · 변경계약 chg 줄 · 부록 R(생성 시점 고정·chg 병합·본 줄 잠금·서류 버튼·status·로더/startProcess 실제 실행·미리보기 격리) ----
{
  const ref = (t, p, c, ex) => { const names = api.CON_SCEN[api.conScenKey(t, p, c)] || api.CON_SCEN[t + ':pub'] || []; const o = names.map((n) => ({ name: n, opt: /^\(.+\)$/.test(n) ? 1 : 0 })); if (ex && ex.qual) o.unshift({ name: '적격심사', opt: 0 }); return o; };
  const CASES = [['asbestos', false, false], ['asbestos', true, false], ['demolition', false, false], ['demolition', true, false], ['asbestos', false, true], ['asbestos', true, true], ['demolition', false, true], ['demolition', true, true], ['waste', false, false], ['waste', true, false], ['dredge', true, false], ['dredge', false, false], ['waste', true, true], ['dredge', true, true]];
  const offOk = () => CASES.every(([t, p, c]) => [false, true].every((q) => JSON.stringify(api.conScenStages(t, p, c, { qual: q })) === JSON.stringify(ref(t, p, c, { qual: q }))));
  const st7 = api.csStageNew({ name: 'x', opt: 1 });
  T('v402 꺼짐 동일성: 14경우×적격 2 = v382 참조와 바이트 동일 · csStageNew 키 7개 · conScenTag 같은 객체·키 추가 없음 · CON_ADDED 빈 값',
    offOk() && Object.keys(st7).join(',') === 'name,due,days,status,task_id,done_at,opt' && (() => { const sc = { type: 'asbestos', pub: false, combo: false, ver: 1 }; return api.conScenTag(sc, []) === sc && Object.keys(sc).length === 4; })() && api.CON_ADDED.stages.length === 0 && api.CON_ADDED.lists.length === 0, '');
  const AP = JSON.parse(readFileSync(join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract', 'proc_added_v1.json'), 'utf8'));
  const on = JSON.parse(JSON.stringify(AP)); on.status = 'applied'; on.applied = { at: '2026-11-04', by: 'consheet', basis: 'dry-run' }; [...on.stages, ...on.lists].forEach((x) => { x.active = true; });
  const pr = api.conAddedPrep({ schema: on.schema, status: on.status, stages: on.stages, lists: on.lists });
  T('v402 실데이터 켬 드라이런(원천 proc_added_v1 스키마 ' + AP.schema + '·' + AP.status + '): conAddedPrep hard bad 0 · 단계 4 · 목록 2', AP.schema === 2 && pr.stages.length === 4 && pr.lists.length === 2 && pr.bad.filter((b) => !b.soft).length === 0, JSON.stringify(pr.bad));
  api.conAddedUse(pr, 'testsrc');
  const PRI = CASES.filter((x) => !x[1]), PUB = CASES.filter((x) => x[1]);
  T('v402 사급 5종: (착공)이 /계약/ 단계 바로 뒤 · (완료)가 /청구/ 바로 앞 · 길이 +2 · 신설 빼면 base 순서 그대로 · 둘 다 기본 꺼짐(off, R10)',
    PRI.every(([t, p, c]) => { const st = api.conScenStages(t, p, c, {}), base = ref(t, p, c, {}); const i1 = st.findIndex((s) => s.aid === 'pri_start'), i2 = st.findIndex((s) => s.aid === 'pri_complete'); return st.length === base.length + 2 && /계약/.test(st[i1 - 1].name) && /청구/.test(st[i2 + 1].name) && JSON.stringify(st.filter((s) => !s.aid).map((s) => s.name)) === JSON.stringify(base.map((s) => s.name)) && st[i1].off === 1 && st[i2].off === 1; }), '');
  T('v402 관급 5종: 생성 때 길이 그대로(변경계약 없음) · qual_manual 체크 → 맨 앞 적격심사(aid) · 자동+수동 = 1개 · 준설 관급 첫 단계 /견적/(견적 승격 유지)',
    PUB.every(([t, p, c]) => api.conScenStages(t, p, c, {}).length === ref(t, p, c, {}).length && !api.conScenStages(t, p, c, {}).some((s) => s.aid)) && api.conScenStages('asbestos', true, false, { qual_manual: 1 })[0].aid === 'qual_manual'
    && api.conScenStages('asbestos', true, false, { qual: true, qual_manual: 1 }).filter((s) => s.name === '적격심사').length === 1 && /견적/.test(api.conScenStages('dredge', true, false, {})[0].name), '');
  const dk = []; CASES.forEach(([t, p, c]) => api.conScenStages(t, p, c, {}).forEach((s, i) => { if (s.lid) dk.push(api.conScenKey(t, p, c) + '#' + (i + 1) + ' ' + s.dk[0]); }));
  const u = [...new Set(dk)], asbDone = api.conScenStages('asbestos', true, false, {}).find((s) => s.name === '완료보고 및 실적보고'), demoPub = api.conScenStages('demolition', true, false, {}).find((s) => s.name === '완료보고 및 실적보고');
  T('v402 목록: dk 8곳(석면 4·철거 4) · demolition:pub 완료보고는 dk 없음 · 석면 완료보고 2항 · (완료)는 준공 목록 · dk 없으면 stageDocsFor와 같음',
    u.filter((x) => /완료신고_석면/.test(x)).length === 4 && u.filter((x) => /완료신고_철거/.test(x)).length === 4 && !demoPub.dk && api.csParseStageDocs(api.stageDocsOf(asbDone)).length === 2
    && api.stageDocsOf(api.conScenStages('asbestos', false, false, {}).find((s) => s.aid === 'pri_complete')) === api.STAGE_DOCS['준공'] && api.stageDocsOf({ name: '착공서류' }) === api.stageDocsFor('착공서류'), u.join(' / '));
  const alt = JSON.parse(JSON.stringify(on)); alt.stages.find((s) => s.id === 'change_contract').pos = { type: 'insert', after_re: '착공|착수|계약', before_re: '준공|청구' };
  const pa7 = api.conAddedPrep({ schema: 2, status: 'applied', stages: alt.stages, lists: alt.lists }); api.conAddedUse(pa7, 'alt7');
  const pub7 = api.conScenStages('asbestos', true, false, {}), pri7 = api.conScenStages('asbestos', false, false, {}), i7 = pri7.findIndex((s) => s.aid === 'change_contract');
  const ok7 = pa7.bad.filter((b) => !b.soft).length === 0 && pub7[pub7.findIndex((s) => s.aid === 'change_contract') + 1].name === '준공서류 작성' && pri7[i7 + 1].aid === 'pri_complete' && /청구/.test(pri7[i7 + 2].name);
  api.conAddedUse(pr, 'testsrc');
  T('v402 7번 고정 대안(pos insert, 데이터만): bad 0 · 관급 준공서류 작성 바로 앞 · 사급 변경계약 → (완료) → 청구', ok7, JSON.stringify(pa7.bad));
  const cA = { id: 'c_a', contract_info: { amount: 1000 }, pipes: [], status: 'active', scen: { type: 'asbestos' } };
  const sChg = { name: '변경계약', aid: 'change_contract', ak: '계약 단계', aw: 'amt', amt0: 1000, eff0: 1000, vals: {} };
  const k0 = api.csApprKindOf(cA, sChg); sChg.vals.chg_amt = 1200; const k1 = api.csApprKindOf(cA, sChg); sChg.vals.chg_amt = 1000; const k2 = api.csApprKindOf(cA, sChg); delete sChg.vals.chg_amt;
  cA.contract_info.amount = 1500; const k3 = api.csApprKindOf(cA, sChg); cA.contract_info.amount = 1000; cA.settle_amount = 900; const k4 = api.csApprKindOf(cA, sChg); delete cA.settle_amount;
  T('v402 csApprKindOf: aid 없는 4이름 = csApprKind · 변경계약 금액 빈칸 "" · 1200 → 계약 단계 · 1000 → "" · 계약액 바뀌면 계약 단계 · 정산액만 바뀌면 ""(R15②)',
    ['계약서류 작성', '청구 및 입금확인', '(계약서·발주서)', '견적·수의계약'].every((n) => api.csApprKindOf(cA, { name: n }) === api.csApprKind(n)) && k0 === '' && k1 === '계약 단계' && k2 === '' && k3 === '계약 단계' && k4 === '', JSON.stringify([k0, k1, k2, k3, k4]));
  const mkC = (id) => { const stg = api.conScenStages('asbestos', true, false, {}); const sc = api.conScenTag({ type: 'asbestos', pub: true, combo: false, ver: 1 }, stg); return { id, type: 'asbestos', label: '석면철거', docType: 'public', client: 'x', contract_info: { amount: 1000 }, scen: sc, status: 'active', pipes: [{ key: 'main', cur: 3, stages: stg.map((s) => api.csStageNew(s)) }] }; };
  const c8 = mkC('c_v402a'); api.pushContract(c8);
  const nT8 = api.tasks.length, mainJson = JSON.stringify(c8.pipes[0]);
  api.csChgAdd(c8);
  const q8 = c8.pipes.find((p) => p.key === 'chg'), t8 = api.tasks[api.tasks.length - 1];
  const ok8a = !!q8 && q8.stages.length === 1 && q8.stages[0].round === 1 && q8.stages[0].amt0 === 1000 && q8.stages[0].eff0 === 1000 && api.tasks.length === nT8 + 1 && t8.pipe === 'chg' && t8.stage_i === 0 && /변경계약 1차/.test(t8.title) && JSON.stringify(c8.pipes[0]) === mainJson && !!c8.scen.chg && c8.scen.chg.after_re === '착공|착수|계약';
  api.csChgAdd(c8);
  const ok8b = q8.stages.length === 2 && q8.cur === 0 && api.tasks.length === nT8 + 1 && q8.stages[1].round === 2;
  const nA = api.alerts.length, cOut = mkC('c_v402b'); cOut.pipes[0].cur = 8; api.csChgAdd(cOut); const cDone = mkC('c_v402c'); cDone.status = 'done'; api.csChgAdd(cDone); const cOld = mkC('c_v402d'); delete cOld.scen.added; delete cOld.scen.chg; api.csChgAdd(cOld);
  const ok8c = ![cOut, cDone, cOld].some((x) => x.pipes.some((p) => p.key === 'chg')) && api.alerts.length === nA + 3;
  T('v402 csChgAdd: 창 안 → chg 줄 1차(round·amt0·eff0) + 지시 1(pipe chg·stage_i 0) · 본 줄 그대로 · scen.chg 원문 고정 · 1차 열린 채 2차 → 2단계·cur 0·지시 추가 없음 · 창 밖/완료/기록 없는 계약 → 변화 없음·alert', ok8a && ok8b && ok8c, JSON.stringify({ ok8a, ok8b, ok8c }));
  q8.stages[0].vals = { chg_amt: 1200 }; q8.stages[0].status = 'done'; q8.cur = 1; api.materializeStage(c8, q8, '2026-10-13');
  q8.stages[1].vals = { chg_amt: 1200 }; const kk1 = api.csApprKindOf(c8, q8.stages[1]); q8.stages[1].vals.chg_amt = 1300; const kk2 = api.csApprKindOf(c8, q8.stages[1]);
  T('v402 변경계약 2차 금액 기준 = 1차 승인 금액(현재 단계가 될 때 굳힘) — 1200→1200 결재 없음 · 1300 → 계약 단계', q8.stages[1].amt0 === 1200 && q8.stages[1].eff0 === 1000 && kk1 === '' && kk2 === '계약 단계', JSON.stringify([q8.stages[1].amt0, kk1, kk2]));
  c8.pipes[0].cur = 7; const nA3 = api.alerts.length; api.csDoneStage(c8, c8.pipes[0], 7);
  const tMain = { proc_id: c8.id, pipe: 'main', stage_i: 7, stage_name: '준공서류 작성', status: 'done' }, r3 = api.advanceProc(tMain);
  T('v402 R3: 변경계약 미완료 차수가 있으면 본 줄 준공서류 작성부터 [완료]·지시 완료 모두 막힘(지시는 완료 요청) · 그 앞 단계는 안 막힘',
    api.alerts.length === nA3 + 2 && r3 === false && tMain.status === 'review' && c8.pipes[0].cur === 7 && c8.pipes[0].stages[7].status !== 'done' && api.csChgOpenAt(c8, c8.pipes[0], 6) === 0 && api.csChgOpenAt(c8, c8.pipes[0], 7) === 1, JSON.stringify({ a: api.alerts.length - nA3, r3, st: tMain.status }));
  const base9 = () => { const c = mkC('c_v402s'); const s1 = api.csStageNew({ name: '변경계약', aid: 'change_contract', dk: ['계약'], ak: '계약 단계', aw: 'amt' }); s1.round = 1; s1.status = 'open'; s1.task_id = 'tA'; c.pipes.push({ key: 'chg', cur: 0, stages: [s1] }); return c; };
  const nx = (r) => { const s = api.csStageNew({ name: '변경계약', aid: 'change_contract', dk: ['계약'] }); s.round = r; return s; };
  const lB = base9(); lB.pipes[1].stages[0].status = 'done'; lB.pipes[1].cur = 1; const sB = JSON.parse(JSON.stringify(base9())); sB.pipes[1].stages.push(nx(2)); api.csSyncFromServer(lB, sB);
  const okB = lB.pipes[1].stages.length === 2 && lB.pipes[1].stages[0].status === 'done' && lB.pipes[1].cur === 1 && lB.pipes[1].stages[1].status === 'open' && !!lB.pipes[1].stages[1].task_id;
  const lC = base9(); lC.pipes[1].stages.push(nx(2)); const sC = JSON.parse(JSON.stringify(base9())); sC.pipes[1].stages[0].status = 'done'; sC.pipes[1].cur = 1; api.csSyncFromServer(lC, sC);
  const okC = lC.pipes[1].stages.length === 2 && lC.pipes[1].stages[0].status === 'done' && lC.pipes[1].cur === 1 && lC.pipes[1].stages[1].status === 'open' && !!lC.pipes[1].stages[1].task_id;
  const lD = mkC('c_v402s'); api.csSyncFromServer(lD, JSON.parse(JSON.stringify(base9())));
  const okD = lD.pipes.some((p) => p.key === 'chg' && p.stages.length === 1);
  T('v402 R2 csSyncFromServer chg 병합(인덱스별 합집합): (B) 로컬 1차 완료 + 서버 2차 → 2단계·cur 1·2차 지시 생성 · (C) 로컬 2차 추가 + 서버 1차 승인 → 2차 보존 · 서버에만 chg → 받음', okB && okC && okD, JSON.stringify({ okB, okC, okD }));
  const h9 = api.csStagesHtml(c8);
  const stP = api.conScenStages('asbestos', false, false, {}), cP = { id: 'c_v402p', type: 'asbestos', docType: 'private', status: 'active', scen: api.conScenTag({ type: 'asbestos', pub: false, combo: false, ver: 1 }, stP), pipes: [{ key: 'main', cur: 0, stages: stP.map((s) => api.csStageNew(s)) }] };
  const iPS = cP.pipes[0].stages.findIndex((s) => s.aid === 'pri_start'); api.openStage('main|' + iPS); const hP = api.csStagesHtml(cP); api.openStage('');
  const fakeB = { proc: { added: { schema: 2, status: 'pending', stages: JSON.parse(JSON.stringify(AP.stages)) } }, list: { added: { schema: 2, status: 'pending', lists: JSON.parse(JSON.stringify(AP.lists)) } } };
  const pvH = api.conAddedPreviewHtml(fakeB);
  T('v402 단계 탭: "변경계약 2건" 머리 · [+ 변경계약 3차](창 안) · 사급 신설 배지·기본 꺼짐 단계 [켜기] · 미리보기에 (착공)·(완료)·완료신고_석면·변경계약 별도 줄',
    /변경계약 2건/.test(h9) && /data-cs-chgadd="c_v402a">\+ 변경계약 3차/.test(h9) && /<small>신설<\/small>/.test(hP) && /data-cs-unskip="[^"]*">켜기</.test(hP) && /\(착공\)/.test(pvH) && /\(완료\)/.test(pvH) && /완료신고_석면/.test(pvH) && /별도 줄/.test(pvH), h9.slice(0, 160));
  api.openStage('chg|1'); const h13 = api.csStagesHtml(c8); api.openStage('');
  T('v402 R4: 변경계약 단계 카드에 📄 서류 버튼 없음(계약서 작성 툴이 원계약 contract_info를 덮지 않게) · 서류함 첨부 안내', !/data-cs-sdoc="c_v402a\|변경계약"/.test(h13) && /변경계약서: 서류함 첨부/.test(h13), '');
  const allC = (bk['col:contracts'].items || []), pBefore = JSON.stringify(allC.map((x) => x.pipes)); let ex11 = 0;
  for (const tab of ['ov', 'st', 'doc', 'lk']) { api.setTab(tab); allC.forEach((x) => { try { api.csDetailHtml(x); } catch (e) { ex11++; } }); }
  T('v402 옛 계약 호환(켬 상태): 백업 ' + allC.length + '건(삭제 포함) 4탭 렌더 예외 0 · 렌더 전후 pipes 같음', ex11 === 0 && JSON.stringify(allC.map((x) => x.pipes)) === pBefore, String(ex11));
  const S = (o) => Object.assign({ kind: 'stage', pos: { type: 'insert', before_re: '청구' }, docs: ['계약'], active: true }, o);
  const badD = { schema: 2, status: 'applied', stages: [S({ id: 'x1', name: 'X', scen: ['nope:pub'] }), S({ id: 'x2', name: 'Y', scen: ['asbestos:pri'], pos: { type: 'insert', after_re: '(' } }), S({ id: 'x3', name: 'Z', scen: ['asbestos:pri'] }), S({ id: 'x3', name: 'Z2', scen: ['asbestos:pri'] }), S({ id: 'x4', name: 'W', scen: ['asbestos:pri'], docs: ['없는키'] }), S({ id: 'x5', name: 'V', scen: ['asbestos:pri', 'dredge:pri'], pos: { type: 'insert', before_re: '노동부' } }), S({ id: 'x6', name: 'U', scen: ['asbestos:pri'], active: false })],
    lists: [{ id: 'l1', kind: 'list', key: 'K', replaces: '없음', match_re: 'a', value: 'v', active: true }] };
  const pb = api.conAddedPrep(badD), s1 = api.conAddedPrep({ schema: 1, status: 'applied', stages: on.stages, lists: on.lists }), sP = api.conAddedPrep({ schema: 2, status: 'pending', stages: on.stages, lists: on.lists }), sM = api.conAddedPrep({ schema: 2, status: 'mismatch', stages: on.stages, lists: on.lists }), sStr = api.conAddedPrep({ schema: 2, status: 'applied', stages: 'oops', lists: on.lists });
  T('v402 검증 실패: 시나리오 키·정규식 "("·id 중복(둘 다)·목록 대상 불량 → 그 항목만 제외+사유 · 서류 키 없음·일부 시나리오 기준 없음 → soft 적용 · 비활성 무시 · 스키마 1/pending/두 층 불일치 → 활성 전부 제외(R5) · stages 문자열 → 예외 없이 표시(R6)',
    pb.stages.map((s) => s.id).join(',') === 'x4,x5' && pb.lists.length === 0 && ['x1', 'x2', 'l1'].every((id) => pb.bad.some((b) => b.id === id && !b.soft)) && pb.bad.filter((b) => b.id === 'x3').length === 2 && pb.bad.some((b) => b.id === 'x4' && b.soft) && pb.bad.some((b) => b.id === 'x5' && b.soft)
    && [s1, sP, sM].every((x) => x.stages.length === 0 && x.lists.length === 0 && x.bad.length === 6) && sStr.lists.length === 2 && sStr.stages.length === 0 && sStr.bad.some((b) => b.id === '*'), JSON.stringify(pb.bad));
  const stA = api.conScenStages('asbestos', true, false, {}), cAsb = { id: 'c_v402r', type: 'asbestos', docType: 'public', status: 'active', contract_info: { amount: 1000 }, scen: api.conScenTag({ type: 'asbestos', pub: true, combo: false, ver: 1 }, stA), pipes: [{ key: 'main', cur: 3, stages: stA.map((s) => api.csStageNew(s)) }] };
  const cAsbR = JSON.parse(JSON.stringify(cAsb)), cR = JSON.parse(JSON.stringify(c8)), iDone = cAsbR.pipes[0].stages.findIndex((s) => s.lid === 'complete_asb');
  const wBefore = JSON.stringify(api.csChgCan(c8).w), akBefore = api.csApprKindOf(c8, q8.stages[1]);
  api.conAddedClear();
  const keyGone = !('완료신고_석면' in api.STAGE_DOCS), items0 = api.csStageDocItems(cAsbR.pipes[0].stages[iDone]), canR = api.csChgCan(cR), akR = api.csApprKindOf(cR, cR.pipes.find((p) => p.key === 'chg').stages[1]);
  api.csDocAdd(cAsbR, cAsbR.pipes[0], iDone, '추가 서류'); const fixed = cAsbR.pipes[0].stages[iDone].docs; let exR = 0; try { api.csStagesHtml(cR); api.csStagesHtml(cAsbR); } catch (e) { exR++; }
  T('v402 R1 생성 시점 고정: JSON 왕복 + conAddedClear(목록 키 삭제) 뒤에도 석면 완료보고 2항(dtx) · [+ 변경계약] 창·결재 판정 같음(scen.chg 원문 정규식 재컴파일) · [추가] 뒤 표준 2항 + 추가 1 · 렌더 예외 0',
    keyGone && items0.length === 2 && !!canR && JSON.stringify(canR.w) === wBefore && akR === akBefore && Array.isArray(fixed) && fixed.length === 3 && fixed.filter((d) => !d.add).length === 2 && exR === 0, JSON.stringify({ keyGone, n: items0.length, canR: !!canR, akR, akBefore, fixed: fixed && fixed.length }));
  const sL = { name: '(완료)', aid: 'pri_complete', dk: ['없는키_x'], status: 'open' }, cL = { id: 'c_l', status: 'active', pipes: [{ key: 'main', cur: 0, stages: [sL] }] }, nAL = api.alerts.length;
  api.csDocAdd(cL, cL.pipes[0], 0, 'x'); api.csDocToggle(cL, cL.pipes[0], 0, '기타:0');
  T('v402 R1 dk도 dtx도 안 풀리는 단계: [추가]·체크가 s.docs를 굳히지 않음(alert) · 단계 카드에 원천 못 불러옴 경고', !Array.isArray(sL.docs) && api.alerts.length >= nAL + 1 && /원천을 불러오지 못했습니다/.test(api.csStageDocsHtml(cL, cL.pipes[0], 0, 'main|0', true)), String(api.alerts.length - nAL));
  const PB = JSON.parse(readFileSync(join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract', 'blob_proc_contract_v1.json'), 'utf8')), LB = JSON.parse(readFileSync(join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract', 'blob_list_contract.json'), 'utf8'));
  const mkRes = (flagOn, mut) => { const p = JSON.parse(JSON.stringify(PB)), l = JSON.parse(JSON.stringify(LB)); if (mut) mut(p, l); return { status: 200, body: { flag: { use_blob: flagOn }, proc: p, list: l } }; };
  const activate = (p, l) => { p.added.status = 'applied'; l.added.status = 'applied'; p.added.applied = { at: '2026-11-04' }; l.added.applied = { at: '2026-11-04' }; p.added.stages.forEach((s) => { s.active = true; }); l.added.lists.forEach((x) => { x.active = true; }); };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const load = async (res) => { api.setGw(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res))); api.conProcLoad(); await tick(); await tick(); return { n: api.CON_ADDED.stages.length + api.CON_ADDED.lists.length, key: '완료신고_석면' in api.STAGE_DOCS, bad: (api.procSrc().added_bad || []).length, mode: api.procSrc().mode }; };
  const L1 = await load(mkRes(false, activate)), L2 = await load(mkRes(true, (p, l) => { activate(p, l); p.added.schema = 1; })), L3 = await load(mkRes(true, activate)), L4 = await load(new Error('net')), L5 = await load(mkRes(true, (p, l) => { activate(p, l); l.added.status = 'pending'; })), L6 = await load(mkRes(true, (p, l) => { p.added.status = 'pending'; l.added.status = 'pending'; p.added.applied = null; l.added.applied = null; p.added.stages.forEach((s) => { s.active = false; }); l.added.lists.forEach((x) => { x.active = false; }); }));   // v418: 현행 파일이 applied로 바뀌어도 '전부 비활성' 경로를 계속 시험(되돌리기 (a)의 모양)
  T('v402 R7 conProcLoad 실제 실행: 꺼짐+active → 신설 0·목록 키 없음 · 켬+스키마1 → 0·bad · 켬+정상 → 6·목록 키 있음 · 네트워크 예외 → 비워짐 · 두 층 status 불일치 → 0(R5) · 켬+전부 비활성(pending) → 0',
    L1.n === 0 && !L1.key && L2.n === 0 && L2.bad > 0 && L3.n === 6 && L3.key && L3.mode === 'blob' && L4.n === 0 && !L4.key && L5.n === 0 && L5.bad > 0 && L6.n === 0 && !L6.key, JSON.stringify([L1, L2, L3, L4, L5, L6]));
  await load(mkRes(true, activate));
  const stSP = api.conScenStages('asbestos', false, false, {}), cSP = api.startProcess('asbestos', { client: 'sp', docType: 'private', stages: stSP, scen: api.conScenTag({ type: 'asbestos', pub: false, combo: false, ver: 1 }, stSP) });
  const ps = cSP.pipes[0].stages, iS = ps.findIndex((s) => s.aid === 'pri_start'), iD = ps.findIndex((s) => s.lid === 'complete_asb');
  T('v402 R7 startProcess 실제 실행: aid·off(skipped)·dk·dtx·flds가 pipes까지 남음 · scen.added·chg 기록 · 기본 꺼짐 단계는 지시 없이 지나감',
    iS > 0 && ps[iS].status === 'skipped' && ps[iS].off === 1 && ps[iS].dk[0] === '착공' && !!ps[iS].dtx && iD > 0 && ps[iD].dk[0] === '완료신고_석면' && /석면농도측정/.test(ps[iD].dtx) && Array.isArray(ps.find((s) => s.aid === 'pri_complete').flds) && cSP.scen.added.indexOf('pri_start') >= 0 && !!cSP.scen.chg && cSP.scen.chg.before_re === '준공|청구' && !ps[iS].task_id, '');
  api.popContract(); api.popContract();
  const snapA = JSON.stringify([api.CON_ADDED.stages.map((s) => s.id), api.CON_ADDED.lists.map((l) => l.id), api.CON_ADDED.keys]), snapD = JSON.stringify(api.STAGE_DOCS);
  api.conAddedPreviewHtml(fakeB);
  T('v402 R7 미리보기는 읽기 전용(CON_ADDED·STAGE_DOCS 그대로)', JSON.stringify([api.CON_ADDED.stages.map((s) => s.id), api.CON_ADDED.lists.map((l) => l.id), api.CON_ADDED.keys]) === snapA && JSON.stringify(api.STAGE_DOCS) === snapD, '');
  const host = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  api.setDocEl('conProcCard', host); api.setGw(() => Promise.resolve(mkRes(false, (p) => { p.added.stages = [Object.defineProperty({}, 'id', { enumerable: true, get() { throw new Error('주입 예외'); } })]; })));   // 검토 6: 실제 예외 주입(문자열 stages는 예외를 안 던져 거짓 통과)
  api.renderConProcCard(); await tick(); await tick(); api.setDocEl('conProcCard', null);
  T('v402 R6·R11 관리자 카드: 미리보기가 예외를 던져도(검토 6 실제 주입) [거울 켜기](data-conproc-set)·편집 절이 남고 "미리보기 실패" 한 줄 · 카드 9 목록 읽기 전용 행 · 편집 예시가 해 없는 값', /data-conproc-set=/.test(host.innerHTML) && /카드 9 미리보기 실패/.test(host.innerHTML) && /카드 9 · (비활성|활성) · 읽기 전용/.test(host.innerHTML) && /키\(예: 실적보고_추가\)/.test(host.innerHTML) && !/노동부\|석면\)/.test(host.innerHTML), host.innerHTML.slice(0, 160));
  api.setGw(null); api.conAddedClear();
  T('v402 정리(격리): conAddedClear 뒤 STAGE_DOCS에 카드 9 키 없음 · 꺼짐 동일성 다시 성립', !('완료신고_석면' in api.STAGE_DOCS) && !('완료신고_철거' in api.STAGE_DOCS) && offOk(), '');
}

// ---- v402 적대 검토 반영(10/30): 창 닫힘·승인 분기 잠금·재개 · 금액 기준 · 7번 대안 서류 버튼 · 이 단계부터·건너뜀 가드 · 병합 순위·저장 · 정의 깨짐 기본 창 · 목록 hits 0 ----
{
  const AP2 = JSON.parse(readFileSync(join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract', 'proc_added_v1.json'), 'utf8'));
  const on2 = JSON.parse(JSON.stringify(AP2)); [...on2.stages, ...on2.lists].forEach((x) => { x.active = true; });
  api.conAddedUse(api.conAddedPrep({ schema: 2, status: 'applied', stages: on2.stages, lists: on2.lists }), 'rv');
  const stR = api.conScenStages('asbestos', false, false, {}), iBill = stR.findIndex((s) => /청구/.test(s.name));
  const mk = (id) => ({ id, type: 'asbestos', docType: 'private', status: 'active', contract_info: { amount: 1000 }, scen: api.conScenTag({ type: 'asbestos', pub: false, combo: false, ver: 1 }, stR), pipes: [{ key: 'main', cur: 0, stages: stR.map((s) => api.csStageNew(s)) }] });
  const c1 = mk('c_rv1'); c1.pipes[0].cur = iBill; api.pushContract(c1);
  const okOpen = api.csChgCan(c1).ok;
  c1.pipes[0].stages[iBill].appr = { status: '대기', at: '2026-10-30' }; const hold = api.csChgCan(c1); delete c1.pipes[0].stages[iBill].appr;
  api.csChgAdd(c1); const q1 = c1.pipes.find((p) => p.key === 'chg'), sB = c1.pipes[0].stages[iBill];
  sB.appr = { status: '승인', at: '2026-10-30' }; sB.task_id = null;
  const nT1 = api.toasts.length; api.csApprApply(c1, c1.pipes[0], iBill);
  const blocked = sB.status !== 'done' && c1.pipes[0].cur === iBill && api.toasts.length === nT1 + 1;
  q1.stages[0].status = 'done'; q1.cur = 1; api.csDoneStage(c1, c1.pipes[0], iBill);
  const resumed = sB.status === 'done' && c1.pipes[0].cur === iBill + 1;
  T('v402 검토 1·11: 본 줄 청구 상신 중이면 [+ 변경계약] 창 닫힘(hold) · 승인됐는데 지시 없는 분기(csApprApply)도 변경계약 열린 동안 진행 보류(토스트) · 변경계약 끝낸 뒤 [완료] → 승인 적용·진행', okOpen && hold.ok === false && hold.hold === true && !!q1 && blocked && resumed, JSON.stringify({ okOpen, hold: hold.ok, blocked, resumed }));
  const c2 = mk('c_rv2'); c2.contract_info = { amount: 0 }; c2.settle_amount = 900; c2.pipes[0].cur = 4; api.csChgAdd(c2); const s2 = (c2.pipes.find((p) => p.key === 'chg') || { stages: [{}] }).stages[0];
  T('v402 검토 2: 변경계약 금액 기준 = 계약서 금액(contract_info.amount)만 — 정산액·낙찰액 폴백 무시(eff0 0) · 정산액이 바뀌어도 판정 ""', s2.eff0 === 0 && (c2.settle_amount = 1200, api.csApprKindOf(c2, s2) === ''), JSON.stringify({ eff0: s2.eff0, amt0: s2.amt0 }));
  const alt = JSON.parse(JSON.stringify(on2)); alt.stages.find((s) => s.id === 'change_contract').pos = { type: 'insert', after_re: '착공|착수|계약', before_re: '준공|청구' };
  api.conAddedUse(api.conAddedPrep({ schema: 2, status: 'applied', stages: alt.stages, lists: alt.lists }), 'alt');
  const stA = api.conScenStages('asbestos', true, false, {}), iC = stA.findIndex((s) => s.aid === 'change_contract');
  const c3 = { id: 'c_rv3', type: 'asbestos', docType: 'public', status: 'active', contract_info: { amount: 1000 }, scen: { type: 'asbestos', pub: true }, pipes: [{ key: 'main', cur: iC, stages: stA.map((s) => api.csStageNew(s)) }] }; api.pushContract(c3);
  const okT3 = iC > 0 && api.csTaskChg({ proc_id: 'c_rv3', pipe: 'main', stage_i: iC }) === true && api.csTaskChg({ proc_id: 'c_rv3', pipe: 'main', stage_i: 0 }) === false;
  api.conAddedUse(api.conAddedPrep({ schema: 2, status: 'applied', stages: on2.stages, lists: on2.lists }), 'rv');
  T('v402 검토 3: 7번 고정 대안(main 줄 변경계약) 지시도 서류 버튼 숨김 판정(csTaskChg)', okT3, String(iC));
  const c9 = mk('c_rv9'); c9.pipes[0].cur = 4; api.pushContract(c9); api.csChgAdd(c9); const q9 = c9.pipes.find((p) => p.key === 'chg');
  const nA9 = api.alerts.length; api.csJumpStage(c9, c9.pipes[0], iBill + 1); const okJ = c9.pipes[0].cur === 4 && api.alerts.length === nA9 + 1;
  q9.stages[0].vals = { chg_amt: 1500 }; api.csSkipStage(c9, q9, 0); const okS = q9.stages[0].status !== 'skipped' && api.alerts.length === nA9 + 2;
  T('v402 검토 9·10: 변경계약 열린 동안 [이 단계부터]로 준공·청구 뒤로 못 건너뜀 · 금액 넣은 변경계약은 [건너뜀] 금지', okJ && okS, JSON.stringify({ okJ, okS }));
  const nx = (r, st) => { const x = api.csStageNew({ name: '변경계약', aid: 'change_contract', dk: ['계약'] }); x.round = r; x.status = st; return x; };
  const lS = mk('c_rvs'); lS.pipes.push({ key: 'chg', cur: 1, stages: [nx(1, 'done')] });
  const sS = JSON.parse(JSON.stringify(lS)); sS.pipes[1].stages[0].status = 'open'; sS.pipes[1].cur = 0; sS.pipes[1].stages.push(nx(2, 'pending'));
  const nS = api.sched(); api.csSyncFromServer(lS, sS); const okSave = api.sched() === nS + 1 && lS.pipes[1].stages.length === 2 && lS.pipes[1].stages[1].status === 'open';
  const lM = mk('c_rvm'); lM.pipes.push({ key: 'chg', cur: 1, stages: [nx(1, 'skipped')] });
  const sM = JSON.parse(JSON.stringify(lM)); sM.pipes[1].stages[0].status = 'done'; sM.pipes[1].stages[0].vals = { chg_amt: 1200 };
  const nM = api.sched(); api.csSyncFromServer(lM, sM); const okRank = lM.pipes[1].stages[0].status === 'done' && lM.pipes[1].stages[0].vals.chg_amt === 1200 && api.sched() === nM;
  T('v402 검토 5·12: chg 병합 결과가 서버본과 다르면 저장 예약(새 차수·지시 유실 방지) · 같으면 저장 안 함 · 완료가 건너뜀을 이김(다른 기기 승인 차수 금액 보존)', okSave && okRank, JSON.stringify({ okSave, okRank }));
  const c14 = mk('c_rv14'); c14.scen.chg.after_re = '('; c14.pipes.push({ key: 'chg', cur: 0, stages: [nx(1, 'open')] });
  T('v402 검토 14: scen.chg 정규식이 깨져도 본 줄은 0번부터 잠기지 않고 기본 창(첫 준공|청구)부터만 잠김', api.csChgOpenAt(c14, c14.pipes[0], 0) === 0 && api.csChgOpenAt(c14, c14.pipes[0], iBill) === 1, '');
  const pH = api.conAddedPrep({ schema: 2, status: 'applied', stages: [], lists: [{ id: 'lx', kind: 'list', key: 'K_x', replaces: '완료신고', match_re: '없는단계이름', value: 'v', active: true }] });
  T('v402 검토 4: 목록이 걸리는 단계 0이면 표시(soft — 파이썬은 빌드 오류)', pH.lists.length === 1 && pH.bad.some((b) => b.id === 'lx' && b.soft && /걸리는 단계 0/.test(b.why)), JSON.stringify(pH.bad));
  api.popContract(); api.popContract(); api.popContract(); api.conAddedClear();
}

// ---- v418(11/4 카드 9 PM 회신 "금액변동 시 + 계약기간 변동 시"): 변경계약 상신 조건 = 금액 또는 계약기간 — 세 경로 + 기준일 굳힘·2차 승계·결재 본문·건너뜀 가드·입력 칸 ----
{
  const AP3 = JSON.parse(readFileSync(join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract', 'proc_added_v1.json'), 'utf8'));
  const on3 = JSON.parse(JSON.stringify(AP3)); [...on3.stages, ...on3.lists].forEach((x) => { x.active = true; });
  const cc3 = on3.stages.find((s) => s.id === 'change_contract');
  if (!cc3.flds.some((f) => f[0] === 'chg_end')) cc3.flds.splice(2, 0, ['chg_end', '변경 후 계약기간 종료일', 'date']);   // 앱 먼저 배포 → 데이터 뒤집기 순서라 데이터 전환 전에도 같은 시험을 돈다
  api.conAddedUse(api.conAddedPrep({ schema: 2, status: 'applied', stages: on3.stages, lists: on3.lists }), 'v418');
  const stE = api.conScenStages('asbestos', true, false, {});
  let nE = 0;
  const mkE = (d3, id) => { const c = { id: id || ('c_v418' + (++nE)), type: 'asbestos', label: '석면철거', docType: 'public', client: 'x', contract_info: { amount: 1000, d3 }, scen: api.conScenTag({ type: 'asbestos', pub: true, combo: false, ver: 1 }, stE), status: 'active', pipes: [{ key: 'main', cur: 3, stages: stE.map((s) => api.csStageNew(s)) }] }; api.pushContract(c); api.csChgAdd(c); const q = c.pipes.find((p) => p.key === 'chg'); return { c, q, s: q.stages[0] }; };
  const run = (x, vals) => { x.s.vals = vals; const nC = api.confirms.length, nP = api.appr.length, nD = api.doneCalls(); api.csDoneStage(x.c, x.q, 0); const shown = api.confirms.slice(nC); return { asked: shown.some((m) => /금액·계약기간이 그대로인 변경\(물량 등\)이면 \[확인\] — 결재 없이 완료/.test(m)), submitted: api.appr.length - nP, kind: (x.s.appr || {}).kind || '', body: api.appr.length > nP ? api.appr[api.appr.length - 1].body : '', done: api.doneCalls() - nD }; };

  const a0 = mkE('2026-12-31');
  T('v418 기준일 굳힘: 변경계약이 현재 단계가 될 때 term0 = 계약 종료일(contract_info.d3) · 본 줄 단계엔 term0 없음', a0.s.term0 === '2026-12-31' && !a0.c.pipes[0].stages.some((s) => 'term0' in s), String(a0.s.term0));
  const r1 = run(a0, { chg_end: '2027-03-31' });
  const r1b = run(mkE('2026-12-31'), { chg_amt: 1000, chg_end: '2027-03-31' });
  T('v418 경로 ① 금액 그대로·기간만 변동 → 상신(금액 빈칸·같은 금액 둘 다) · 확인창 없음 · 결재 본문에 계약기간만(금액 변경 문구 없음)',
    r1.submitted === 1 && r1.kind === '계약 단계' && !r1.asked && r1.done === 0 && /계약기간 2026-12-31→2027-03-31/.test(r1.body) && !/변경 1,000→/.test(r1.body) && r1b.submitted === 1 && !r1b.asked && !/변경 1,000→/.test(r1b.body), JSON.stringify({ r1, r1b }));
  const r2 = run(mkE('2026-12-31'), {});
  const r2b = run(mkE('2026-12-31'), { chg_end: '2026-12-31' });
  const r2c = run(mkE('2026-12-31'), { chg_amt: 1000 });
  const r2d = run(mkE('2026-12-31'), { chg_amt: 1000, chg_end: '2026-12-31' });
  T('v418 경로 ② 둘 다 그대로 → 확인창 뒤 결재 없이 완료(둘 다 빈칸·같은 종료일만·같은 금액만) · 두 칸 다 같은 값으로 채우면 확인창도 없이 완료',
    [r2, r2b, r2c].every((r) => r.asked && r.submitted === 0 && r.kind === '' && r.done === 1) && !r2d.asked && r2d.submitted === 0 && r2d.done === 1, JSON.stringify({ r2, r2b, r2c, r2d }));
  const r3 = run(mkE('2026-12-31'), { chg_amt: 1200 });
  const r3b = run(mkE('2026-12-31'), { chg_amt: 1200, chg_end: '2027-03-31' });
  T('v418 경로 ③ 금액만 변동 → 상신 · 결재 본문에 금액만 / 둘 다 변동 → 상신 · 본문에 둘 다',
    r3.submitted === 1 && r3.kind === '계약 단계' && !r3.asked && /변경 1,000→1,200원/.test(r3.body) && !/계약기간 /.test(r3.body) && r3b.submitted === 1 && /변경 1,000→1,200원/.test(r3b.body) && /계약기간 2026-12-31→2027-03-31/.test(r3b.body), JSON.stringify({ r3, r3b }));
  const x2 = mkE('2026-12-31'); x2.s.vals = { chg_end: '2027-03-31' }; x2.s.status = 'done'; x2.q.cur = 1; api.csChgAdd(x2.c); const s2 = x2.q.stages[1];
  s2.vals = { chg_end: '2027-03-31' }; const k2same = api.csApprKindOf(x2.c, s2); s2.vals.chg_end = '2026-12-31'; const k2back = api.csApprKindOf(x2.c, s2);
  T('v418 2차 기준 = 직전 완료 차수의 종료일 — 1차와 같으면 결재 없음 · 원계약 종료일로 되돌리면 변동(상신)', s2.term0 === '2027-03-31' && k2same === '' && k2back === '계약 단계', JSON.stringify({ term0: s2.term0, k2same, k2back }));
  const xN = mkE(''); const rN = run(xN, { chg_end: '2027-03-31' }); const xD = mkE('2026.12.31'); xD.s.vals = { chg_end: '2026-12-31' }; const kD = api.csApprKindOf(xD.c, xD.s);
  const kOld = api.csApprKindOf(xD.c, { name: '변경계약', aid: 'change_contract', ak: '계약 단계', aw: 'amt', amt0: 1000, eff0: 1000, vals: { chg_end: '2026-12-31' } });
  T('v418 경계: 계약 종료일 미기재 + 종료일 입력 → 상신(본문 미기재→) · 표기만 다른 같은 날(2026.12.31) → 변동 아님 · 기준일 없는 옛 단계 + 종료일 입력 → 상신(안전한 쪽)', rN.submitted === 1 && /계약기간 미기재→2027-03-31/.test(rN.body) && kD === '' && kOld === '계약 단계', JSON.stringify({ rN, kD, kOld }));
  const xS = mkE('2026-12-31'); xS.s.vals = { chg_end: '2027-03-31' }; const nAS = api.alerts.length; api.csSkipStage(xS.c, xS.q, 0); const okSk = xS.s.status !== 'skipped' && api.alerts.length === nAS + 1 && /금액·계약기간을 입력했거나/.test(api.alerts[nAS]);
  xS.s.vals = {}; api.csSkipStage(xS.c, xS.q, 0); const okSk2 = xS.s.status === 'skipped';
  T('v418 건너뜀 가드: 종료일을 넣은 변경계약은 [건너뜀] 금지 · 입력을 지우면 건너뜀 가능', okSk && okSk2, JSON.stringify({ okSk, okSk2 }));
  const xH = mkE('2026-12-31'); api.setTab('st'); api.openStage('chg|0'); const hH = api.csDetailHtml(xH.c);
  const rt = JSON.parse(JSON.stringify(xH.c)); const okRt = (rt.scen.chg.flds || []).some((f) => f[0] === 'chg_end' && f[2] === 'date');
  const okData3 = AP3.status !== 'applied' || (AP3.stages.find((s) => s.id === 'change_contract').flds.some((f) => f[0] === 'chg_end' && f[2] === 'date') && AP3.stages.find((s) => s.id === 'change_contract').appr_when === 'amt');
  T('v418 입력 칸: 변경계약 카드에 날짜 칸 chg_end · 생성 때 고정한 정의(scen.chg)가 JSON 왕복에도 칸 유지 · 안내 문구 금액·계약기간 · 원천이 applied면 flds에 chg_end(appr_when amt 그대로)',
    /<input type="date" data-cs-fld="chg_end"/.test(hH) && okRt && /금액·계약기간이 바뀌면 결재\(계약 단계\)/.test(hH) && okData3, JSON.stringify({ okRt, okData3 }));
  for (let i = 0; i < nE; i++) api.popContract();
  api.conAddedClear();
}

// ---- v404(10/31 계약 D2): 기한 엔진 — 꺼짐 바이트 동일 · D-7 대장 기산 · D+30/D+0/immediate · annual(2/15·2월 말·override, B1 회귀) · 배경 품질 게이트(재확인 필요·확인 필요·81행 예외 0)
{
  const dir4 = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract');
  const MAP4 = JSON.parse(readFileSync(join(dir4, 'proc_map_v1.json'), 'utf8')), BG4 = JSON.parse(readFileSync(join(dir4, 'bg_law_v1.json'), 'utf8'));
  const flag4 = { use_blob: true, bg_ver: BG4.ver, annual_override: {} };
  const mk = (type, pub, name, extra) => Object.assign({ id: 'c4', type, scen: { type, pub, combo: false, ver: 1 }, start: '2026-11-01', contract_info: { d1: '2026-11-01', d2: '', d3: '' }, pipes: [{ key: 'main', cur: 0, stages: [{ name, due: 'manual', days: null, status: 'pending', task_id: null, done_at: null, opt: 0 }] }], site_id: '' }, extra || {});
  const stg = (c) => c.pipes[0].stages[0];
  // 1 꺼짐 바이트 동일(거울 const): 층이 다 있어도 conDueOn false, materializeStage는 status·task_id만
  api.CON_PROC_SRC.mode = 'const'; api.conDueUse({ map: MAP4, bg: BG4, flag: flag4 });
  let c1 = mk('asbestos', false, '노동부 신고 서류 작성'); api.materializeStage(c1, c1.pipes[0], c1.start);
  const off1 = !api.conDueOn() && stg(c1).status === 'open' && !!stg(c1).task_id && !('due_src' in stg(c1)) && !('due_badge' in stg(c1)) && Object.keys(stg(c1)).join(',') === 'name,due,days,status,task_id,done_at,opt';
  api.CON_PROC_SRC.mode = 'blob'; api.conDueUse({ map: MAP4, bg: BG4, flag: { use_blob: true, bg_ver: 'v0-other', annual_override: {} } });
  const off2 = !api.conDueOn();   // 판 불일치 = 꺼짐
  api.conDueUse({ map: null, bg: BG4, flag: flag4 }); const off3 = !api.conDueOn();
  T('v404 꺼짐 동일성: 거울 const·bg 판 불일치·map 없음 → 엔진 꺼짐, 단계 키 7개 그대로(새 키 0)', off1 && off2 && off3, JSON.stringify(stg(c1)));
  // 2 켬: D-7 대장 기산(노동부 신고)
  api.conDueUse({ map: MAP4, bg: BG4, flag: flag4 }); api.CON_PROC_SRC.flag = flag4;
  api.asb.length = 0; api.asb.push({ id: 'site1', kind: 'asbestos', start: '2026-11-10', del: 0 });
  let c2 = mk('asbestos', false, '노동부 신고 서류 작성', { site_id: 'site1' }); const d2 = api.conStageDue(stg(c2), c2, c2.pipes[0]);
  let c2b = mk('asbestos', false, '노동부 신고 서류 작성'); const d2b = api.conStageDue(stg(c2b), c2b, c2b.pipes[0]);
  api.materializeStage(c2, c2.pipes[0], c2.start); const t2 = api.tasks[api.tasks.length - 1];
  T('v404 D-7: 대장 start 11-10 → 11-03 · src에 181조①·D-7 · 대장 없으면 기산일 필요 · materializeStage가 지시 due·단계 due_src 기록', api.conDueOn() && d2.due === '2026-11-03' && /181조①/.test(d2.src) && /D-7/.test(d2.src) && d2b.badge === '기산일 필요' && t2.due === '2026-11-03' && stg(c2).due_src === d2.src && !('due_badge' in stg(c2)), JSON.stringify([d2, d2b, t2 && t2.due]));
  // 3 D+30 · D+0 · immediate · 영업일
  let c3 = mk('demolition', false, '해체완료신고서류 작성'); stg(c3).vals = { fin_base: '2026-12-01' }; const d3 = api.conStageDue(stg(c3), c3, c3.pipes[0]);
  let c3b = mk('asbestos', false, '배출신고 서류 작성', { contract_info: { d2: '2026-11-10', d3: '' } }); const d3b = api.conStageDue(stg(c3b), c3b, c3b.pipes[0]);
  let c3c = mk('asbestos', false, '완료보고 및 실적보고'); stg(c3c).vals = { fin_date: '2026-12-05' }; const d3c = api.conStageDue(stg(c3c), c3c, c3c.pipes[0]);
  T('v404 D+30(해체완료 12-01→12-31) · D+0(배출자 신고 = 착공일 11-10) · 지체 없이(완료보고 = 농도 결과 수령일 12-05) · 영업일 더하기(금 11-06 +5 → 11-13)', d3.due === '2026-12-31' && /D\+30/.test(d3.src) && d3b.due === '2026-11-10' && /D\+0/.test(d3b.src) && d3c.due === '2026-12-05' && /지체 없이/.test(d3c.src) && api.conAddBizDays('2026-11-06', 5) === '2026-11-13', JSON.stringify([d3, d3b, d3c]));
  // 4 annual: 2/15 · 2월 말 · override(B1 회귀)
  const td = api.todayStr(), y = Number(td.slice(0, 4)), feb15 = (td >= y + '-02-15' ? y + 1 : y) + '-02-15';
  let c4 = mk('demolition', false, '실적보고'); const d4 = api.conStageDue(stg(c4), c4, c4.pipes[0]);
  let c4b = mk('waste', false, '처리확인서 발부 및 실적보고'); const d4b = api.conStageDue(stg(c4b), c4b, c4b.pipes[0]);
  api.CON_PROC_SRC.flag = { use_blob: true, bg_ver: BG4.ver, annual_override: { 'law.cind.r.22.1': '2027-02-20' } }; const d4c = api.conStageDue(stg(c4), c4, c4.pipes[0]); api.CON_PROC_SRC.flag = flag4;
  T('v404 annual: 실적보고 → 다음 2/15(' + feb15 + ', B1 회귀) · 처리확인서·실적보고 → 다음 2월 말 · override 2027-02-20 우선', d4.due === feb15 && !d4.badge && /^\d{4}-02-2[89]$/.test(d4b.due) && d4c.due === '2027-02-20', JSON.stringify([d4, d4b, d4c]));
  // 5 배경 품질 게이트: 재확인 필요(31일) · 확인 필요(grade) · 81행 예외 0 · manual/external 외 due·badge 둘 다 빈 행 0
  const dminus = (n) => { const x = new Date(td + 'T00:00:00'); x.setDate(x.getDate() - n); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); };   // todayStr 스텁 기준 상대 날짜
  const BGx = JSON.parse(JSON.stringify(BG4)); BGx.rows.forEach((r) => { if (r.id === 'law.osh.r.181.1') r.checked = dminus(31); if (r.id === 'law.waste.r.18') r.grade = '확인 필요'; });
  api.conDueUse({ map: MAP4, bg: BGx, flag: flag4 }); const d5 = api.conStageDue(stg(c2), c2, c2.pipes[0]); const d5b = api.conStageDue(stg(c3b), c3b, c3b.pipes[0]);
  api.conDueUse({ map: MAP4, bg: BG4, flag: flag4 });
  let n5 = 0, empty5 = [], err5 = [];
  for (const key of Object.keys(MAP4.scen)) { const [type, pub] = key.split(':'); for (const row of MAP4.scen[key]) { n5++; try { const cc = mk(type, pub === 'pub', row.name); const dd = api.conStageDue(stg(cc), cc, cc.pipes[0]); if (!dd) { err5.push(key + '/' + row.name + ' 행 없음'); continue; } if (dd.due === '' && dd.badge === '' && !/^(manual|external)$/.test(row.due_rule.kind)) empty5.push(key + '/' + row.name); } catch (e) { err5.push(key + '/' + row.name + ' ' + e.message); } } }
  T('v404 배경 품질: checked 31일 경과 → 재확인 필요 · grade 확인 필요 → 확인 필요 · 81행 예외 0 · manual/external 외 due·배지 둘 다 빈 행 0', d5.badge === '재확인 필요' && d5b.badge === '확인 필요' && n5 === 81 && err5.length === 0 && empty5.length === 0, JSON.stringify({ d5, d5b, n5, err5: err5.slice(0, 3), empty5: empty5.slice(0, 5) }));
  // 6 v405 lawwatch 개정 감지: bg_recheck에 든 행은 승격본에서 빠지고 배지 '재확인 필요(개정 감지)'
  api.conDueUse({ map: MAP4, bg: BG4, flag: flag4, lawwatch: { date: '2026-11-03', bg_recheck: [{ id: 'law.osh.r.181.1', law: '산안법 시행규칙', mst: 288431 }] } });
  const d6 = api.conStageDue(stg(c2), c2, c2.pipes[0]); const d6b = api.conStageDue(stg(c3), c3, c3.pipes[0]);
  T('v405 개정 감지: 재확인 행(181조①)은 기한 보류·배지 \'재확인 필요(개정 감지)\' · 다른 행(33조)은 그대로 계산', d6.badge === '재확인 필요(개정 감지)' && d6.due === '' && d6b.due === '2026-12-31', JSON.stringify([d6, d6b]));
  api.CON_PROC_SRC.mode = 'const'; api.conDueClear(); api.asb.length = 0;
}
// ---- v407(11/1 계약 D3 2일차): 계약 서류함 — doc_key 정규화 · 기록물 메타 우선 패킷 판정 · 서류 행 버튼·기록물 줄 · 초안 훅(gwCall 없으면 무동작, 있으면 draft put 1회)
{
  const c7 = { id: 'c7', type: 'asbestos', status: 'active', scen: { type: 'asbestos', pub: true, combo: false, ver: 1 }, docType: 'public', elems: { asb: 1 }, pipes: [{ key: 'main', cur: 1, stages: [{ name: '석면 조사', status: 'done' }, { name: '노동부 신고 서류 작성', status: 'open', docs: [{ k: '수령:0', t: '수령', n: '신고증명서', st: 'todo' }, { k: 'add:x1', t: '', n: '추가 서류', st: 'todo', add: 1 }] }] }], attachments: {} };
  const p7 = c7.pipes[0];
  const k1 = api.cdocDocKey(p7, { k: '수령:0' }), k2 = api.cdocPkKey({ k: 'con' }, { k: 'contract' });
  T('v407 doc_key 정규화: 파이프.항목키(":"→"-", 길이 상한) · 패킷 pk.<패킷>.<항목> · 서버 정규식 [A-Za-z0-9가-힣_.-]{1,40} 통과', k1 === 'main.수령-0' && k2 === 'pk.con.contract' && /^[A-Za-z0-9가-힣_.-]{1,40}$/.test(k1) && /^[A-Za-z0-9가-힣_.-]{1,40}$/.test(k2) && api.cdocDocKey({ key: 'a|b/c' }, { k: 'x'.repeat(60) }).length <= 40, JSON.stringify([k1, k2]));
  api.CDOC.c7 = { items: [
    { n: 1, i: 1, dk: 'main.수령-0', kind: 'received', ver: 1, cur: 0, name: 'Cc7_S01_main.수령-0_v1_20261101_종운건설.pdf', orig: '신고증명서.pdf', ext: 'pdf', size: 10, sha: 'a', pii: 0, by: { id: 'm1', name: '검사' }, ts: 1761955200000 },
    { n: 2, i: 1, dk: 'main.수령-0', kind: 'received', ver: 2, cur: 1, name: 'Cc7_S01_main.수령-0_v2_20261101_종운건설.pdf', orig: '신고증명서(재발급).pdf', ext: 'pdf', size: 10, sha: 'b', pii: 1, by: { id: 'm1', name: '검사' }, ts: 1761955200000 },
    { n: 3, i: 1, dk: 'main.수령-0', kind: 'draft', ver: 1, cur: 1, name: 'x.json', orig: '', ext: 'json', size: 5, sha: 'c', pii: 1, by: { id: 'm1', name: '검사' }, ts: 1761955200000, gc: 1 },
    { n: 4, i: 1, dk: 'pk.con.contract', kind: 'received', ver: 1, cur: 1, name: 'Cc7_S01_pk.con.contract_v1_20261101_종운건설.pdf', orig: '계약서.pdf', ext: 'pdf', size: 10, sha: 'd', pii: 0, by: { id: 'm1', name: '검사' }, ts: 1761955200000 },
    { n: 5, i: 1, dk: 'pk.con.biz', kind: 'received', ver: 1, cur: 1, name: 'x.pdf', orig: '삭제됨.pdf', ext: 'pdf', size: 10, sha: 'e', pii: 0, by: { id: 'm1', name: '검사' }, ts: 1761955200000, del: 1 },
  ], at: Date.now(), busy: false, err: '', loaded: true };
  const live = api.cdocLive(c7, 1, 'main.수령-0'), cur = api.cdocCurOf(c7, 1, 'main.수령-0', 'received');
  T('v407 cdocLive/cur: gc·보관 항목 제외(2건) · 현재 수령본 = v2', live.length === 2 && cur && cur.n === 2, JSON.stringify([live.map((x) => x.n), cur && cur.n]));
  const hitC = api.cdocPkHit(c7, { k: 'con' }, { k: 'contract' }), hitB = api.cdocPkHit(c7, { k: 'con' }, { k: 'biz' });
  T('v407 패킷 메타 우선: contract 항목은 기록물 n=4로 판정 · 보관된 biz는 미판정(정규식 폴백)', hitC && hitC.n === 4 && hitB === null, JSON.stringify([hitC && hitC.n, hitB]));
  api.setTab('doc'); const pk7 = api.csPacketsHtml(c7);
  T('v407 패킷 HTML: 계약서 행 "올림 · 계약서.pdf v1" + [열기] · 사업자등록증 행 "첨부 필요" + [⬆ 올리기]·[📎]', pk7.indexOf('올림 · 계약서.pdf v1') > 0 && pk7.indexOf('data-cs-copen="c7|4|0"') > 0 && pk7.indexOf('data-cs-cpk="c7|con|biz"') > 0 && pk7.indexOf('data-catt-add="c7"') > 0, pk7.slice(0, 300));
  const dh = api.csStageDocsHtml(c7, p7, 1, 'main|1', true);
  T('v407 서류 행: pii 선택 · 항목마다 [최종본↑]·[수령↑](data-cs-cup …|final / |received) · 기록물 줄 2(v2 현재·개인정보 1 / v1 [현재로]) · 열기 버튼 pii 전달 · 추가 항목도 버튼', dh.indexOf('<select data-cs-pii="main|1"') > 0 && dh.indexOf('data-cs-cup="c7|main|1|수령:0|final"') > 0 && dh.indexOf('data-cs-cup="c7|main|1|수령:0|received"') > 0 && dh.indexOf('data-cs-cup="c7|main|1|add:x1|final"') > 0
    && (dh.match(/cs-cdoc-r/g) || []).length === 2 && dh.indexOf('수령 v2 <b>현재</b> <small class="pii">개인정보 1</small>') > 0 && dh.indexOf('data-cs-copen="c7|2|1"') > 0 && dh.indexOf('data-cs-ccur="c7|1"') > 0 && dh.indexOf('data-cs-ccur="c7|2"') < 0, dh.slice(0, 400));
  const dh0 = api.csStageDocsHtml(c7, p7, 1, 'main|1', false);
  T('v407 권한 없음(can=false): 올리기·pii 선택·보관 없음, [열기]는 있음', dh0.indexOf('data-cs-cup=') < 0 && dh0.indexOf('data-cs-pii') < 0 && dh0.indexOf('data-cs-cdel') < 0 && dh0.indexOf('data-cs-copen="c7|2|1"') > 0);
  const calls7 = []; api.setGw(function(fn, body){ calls7.push(body); return Promise.resolve({ status: 200, body: { item: { n: 9, i: 1, dk: body.doc_key, kind: 'draft', ver: 1, cur: 1 } } }); });
  // v419 고정값도 실제 빌더 산출로 — 평면 배열 고정값이 채움 맵 형식 불일치를 가렸다(11/4 실측)
  const xgInputs = { xgTitle: '시험 공사', xgSite: '포항시 시험동', xgClient: '시험 발주처', xgAmount: '1000000', xgD1: '2026-11-01', xgD2: '2026-11-02', xgD3: '2026-11-10', xgCo: 'con', xgOwner: '', xgAgent: '', xgAgentRrn: '', xgAgentLic: '', xgTon1: '1', xgTon2: '2', xgProc: '시험 처리장' };
  Object.keys(xgInputs).forEach((id) => api.setDocEl(id, { value: xgInputs[id] }));
  const edAsb = api.xgBuildEdits('asb_plan', { asb_survey: { rows: [] }, bldg_info: {} });
  api.csCdocDraft(c7, 'asb_plan', edAsb);
  T('v407 초안 훅: cdoc_put draft · doc_key gen.asb_plan · i = 파이프 cur(1) · pii 1 · fill {tpl, edits} · v419 edits는 실제 빌더의 시트별 객체 그대로(저장 형식 불변)', calls7.length === 1 && calls7[0].action === 'cdoc_put' && calls7[0].kind === 'draft' && calls7[0].doc_key === 'gen.asb_plan' && calls7[0].i === 1 && calls7[0].pii === 1 && calls7[0].fill.tpl === 'asb_plan' && !Array.isArray(calls7[0].fill.edits) && Array.isArray(calls7[0].fill.edits['1.공사개요']) && calls7[0].fill.edits === edAsb, JSON.stringify(calls7[0]).slice(0, 200));
  // v408 보관함(관리자 스텁 isAdmin=true): 보관 항목 1(n=5) → [복구]·[영구 삭제] · 서류 탭 상세에 포함
  const th = api.cdocTrashHtml(c7);
  T('v408 보관함: 보관 항목 n=5만(삭제됨.pdf) · 복구/영구 삭제 버튼 · 30일 미만 안내 title', th.indexOf('삭제됨.pdf') > 0 && th.indexOf('data-cs-crestore="c7|5"') > 0 && th.indexOf('data-cs-cpurge="c7|5"') > 0 && th.indexOf('보관 30일 뒤') > 0 && th.indexOf('계약서.pdf') < 0, th.slice(0, 300));
  api.setGw(null); delete api.CDOC.c7;

  // ---- v419 학습 칸 주입 — 실제 빌더 산출로 실행(시트 구조 유지·공란 칸만·실패는 원인 남기고 생성 계속) ----
  const edKinds = ['work_start', 'work_complete', 'asb_plan', 'demo_report', 'waste_report'].map((k) => api.xgBuildEdits(k, { type: 'dredge', asb_survey: { rows: [] }, bldg_info: {}, owner_info: {} }));
  T('v419 xgBuildEdits 실제 산출: 5양식 모두 시트별 객체(배열 아님) · 줄은 [셀,값,유형] · __drop_drawings__는 착공계에만', edKinds.every((e) => !Array.isArray(e) && Object.keys(e).filter((s) => s !== '__drop_drawings__').every((s) => Array.isArray(e[s]) && e[s].every((x) => Array.isArray(x) && typeof x[0] === 'string'))) && Array.isArray(edKinds[0].__drop_drawings__) && !edKinds[1].__drop_drawings__, Object.keys(edKinds[0]).join());
  const edS = edKinds[0], DS = '건설공사 직접시공계획서';
  const cellOf = (ed, s, c) => (ed[s] || []).filter((x) => x[0] === c)[0];
  const wasB = cellOf(edS, DS, 'A18')[2] === 'b' && cellOf(edS, DS, 'A17')[2] === 'b';
  const b6Before = cellOf(edS, '공문', 'B6').slice();
  const calls419 = []; api.setGw(function(fn, body){ calls419.push(body); return Promise.resolve({ status: 200, body: { defaults: { [DS + '!A18']: '학습값', '공문!B6': '덮으면 안 됨', 'A17': '시트 없는 키' } } }); });
  const al1 = await api.xgApplyLearned('work_start', edS);
  T('v419 xgApplyLearned 객체: 공란(b) 칸에만 학습값(유형 s)·계산된 칸 안 덮음·시트 없는 키 무시 · 시트 목록·__drop_drawings__ 그대로 · learned = 시트!셀 · 원본 불변 · 오류 기록 없음', wasB && calls419[0].action === 'learn_defaults_get' && calls419[0].tpl === 'work_start' && !Array.isArray(al1.edits) && Object.keys(al1.edits).join() === Object.keys(edS).join() && al1.edits.__drop_drawings__ === edS.__drop_drawings__ && JSON.stringify(cellOf(al1.edits, DS, 'A18')) === JSON.stringify(['A18', '학습값', 's']) && cellOf(al1.edits, DS, 'A17')[2] === 'b' && JSON.stringify(cellOf(al1.edits, '공문', 'B6')) === JSON.stringify(b6Before) && al1.learned.join() === DS + '!A18' && cellOf(edS, DS, 'A18')[2] === 'b' && api.errCalls.length === 0, JSON.stringify([al1.learned, api.errCalls]));
  const al2 = api.xgMergeLearned({ Sheet1: [['A1', '', 'b']] }, { 'SHEET1!A1': 'x' }), al3 = api.xgMergeLearned([['C7', '', 'b'], ['H8', 'a', 's']], { C7: 'x', H8: 'y' });
  T('v419 xgMergeLearned: 서버 대문자 키(SHEET1!A1) 일치 · 옛 평면 배열 입력은 배열로 처리(공란만)', al2.edits.Sheet1[0][1] === 'x' && Array.isArray(al3.edits) && al3.edits[0][1] === 'x' && al3.edits[1][1] === 'a' && al3.learned.join() === 'C7', JSON.stringify([al2, al3]));
  api.setGw(() => Promise.resolve({ status: 500, body: {} })); const al4 = await api.xgApplyLearned('work_start', edS);
  api.setGw(() => Promise.reject(new Error('net'))); const al5 = await api.xgApplyLearned('work_start', edS);
  api.setGw(() => Promise.resolve({ status: 200, body: { defaults: {}, on: false } })); const n419 = api.errCalls.length; const al6 = await api.xgApplyLearned('work_start', edS);
  T('v419 주입 실패: 서버 500·네트워크 오류 모두 채움 맵 그대로(생성 안 막음) + 오류 기록에 원인(HTTP_500·THREW) · 끔(defaults 빈 값)은 오류 아님', al4.edits === edS && al5.edits === edS && al4.learned.length === 0 && api.errCalls.some((e) => e[0].indexOf('HTTP_500') > 0 && e[1] === 'xgApplyLearned') && api.errCalls.some((e) => e[0].indexOf('THREW net') > 0) && api.errCalls.length === n419 && al6.learned.length === 0 && Object.keys(al6.edits).join() === Object.keys(edS).join(), JSON.stringify(api.errCalls));
  api.setGw(null);
}

{ // ---- v420 착공·준공 초안 표기(과거 실물 측정 11/4) — 실제 빌더 산출로 확인 ----
  const set420 = (o) => Object.keys(o).forEach((id) => api.setDocEl(id, { value: o[id] }));
  const base420 = { xgTitle: '시험 공사', xgSite: '포항시 시험동', xgClient: '시험 발주처', xgAmount: '1000000', xgD1: '2026-11-01', xgD2: '2026-11-02', xgD3: '2026-11-10', xgCo: 'env', xgOwner: '', xgAgent: '', xgAgentRrn: '', xgAgentLic: '' };
  const cell420 = (ed, s, c) => ((ed[s] || []).filter((x) => x[0] === c)[0] || [])[1];
  const build420 = (title) => { set420(Object.assign({}, base420, { xgTitle: title })); return { s: api.xgBuildEdits('work_start', { type: 'dredge' }), c: api.xgBuildEdits('work_complete', { type: 'dredge' }) }; };
  const P = build420('시험 공사');
  T('v420 금액 B3: "일금 X 원정(\\ N)" 착공·준공 같음 · koAmount 원문(견적·계약 화면 공용)은 그대로',
    cell420(P.s, '기본정보 입력', 'B3') === '일금 일백만 원정(\\ 1,000,000)' && cell420(P.c, '기본정보 입력', 'B3') === '일금 일백만 원정(\\ 1,000,000)' && html.indexOf('"원 정(￦ "+n.toLocaleString()') > 0, cell420(P.s, '기본정보 입력', 'B3'));
  T('v420 착공 공문: B14 따옴표 뒤 띄움·"일부로" 한 줄 · B15 양식 문장 · 짧으면 B16 안 씀',
    cell420(P.s, '공문', 'B14') === '2. 귀 청과 체결한 "시험 공사" 를 2026년 11월 02일부로' && cell420(P.s, '공문', 'B15') === '  착공하겠기에 붙임과 같이 착공계를 제출 합니다.' && cell420(P.s, '공문', 'B16') === undefined, cell420(P.s, '공문', 'B14'));
  const row420 = (ed, c) => (ed['공문'] || []).filter((x) => x[0] === c)[0] || [];
  T('v420 공문 본문 글자 크기 10pt: B14·B15는 값+크기 · B13·B18은 값 그대로(유형 f) · 머리 칸(B6·B7)은 안 건드림 · 착공·준공 같음',
    [P.s, P.c].every((ed) => row420(ed, 'B14')[3] === 10 && row420(ed, 'B15')[3] === 10 && row420(ed, 'B13')[2] === 'f' && row420(ed, 'B13')[3] === 10 && row420(ed, 'B18')[2] === 'f' && row420(ed, 'B18')[3] === 10 && row420(ed, 'B6')[3] === undefined && row420(ed, 'B7')[3] === undefined), JSON.stringify(row420(P.s, 'B13')));
  T('v420 준공 공문: B14는 날짜까지 · B15 첫머리 "부로" + 양식 문구',
    cell420(P.c, '공문', 'B14') === '2. 귀 청과 체결한 "시험 공사" 를 2026년 11월 10일' && cell420(P.c, '공문', 'B15') === '   부로 준공하였기에 붙임과 같이 준공계를 제출 합니다.', String(cell420(P.c, '공문', 'B15')));
  T('v420 날짜: 착공 공문만 일까지(글자) · 착공계·직접시공계획서·준공 공문·청구서는 일 공란 유지',
    cell420(P.s, '공문', 'B7') === '2026년 10월 13일' && cell420(P.s, '착공계', 'B16') === '2026년 10월   일' && cell420(P.s, '건설공사 직접시공계획서', 'A30') === '2026년 10월   일' && cell420(P.c, '공문', 'B7') === '2026년 10월   일' && cell420(P.c, '청구서', 'B16') === '2026년 10월   일', String(cell420(P.s, '공문', 'B7')));
  const J = (t) => /" (을|를) /.exec(cell420(build420(t).s, '공문', 'B14'))[1];
  T('v420 조사: 끝 한글 받침대로(용역=을·공사(3공구)=를·한글 없음=를)', J('시험 용역') === '을' && J('시험 공사(3공구)') === '를' && J('ABC-1') === '를', J('시험 용역'));
  const wide = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 255 ? 2 : 1; return n; };
  const longT = '경상북도 포항시 남구 일원 하수도시설물 준설공사 및 폐기물 수집운반 처리 용역 제3공구 연간 단가 계약 변경분';
  const L = build420(longT), joinL = (ed) => ['B14', 'B15', 'B16'].map((c) => cell420(ed, '공문', c) || '').join(' ').replace(/\s+/g, ' ').trim();
  const fits = (ed, w) => ['B14', 'B15', 'B16'].every((c) => wide(cell420(ed, '공문', c) || '') <= w);
  T('v420 긴 공사명: 줄마다 폭 안(착공 94·준공 88)·낱말 경계에서 나눔·이어 붙이면 문장 그대로',
    fits(L.s, 94) && fits(L.c, 88) && joinL(L.s) === '2. 귀 청과 체결한 "' + longT + '" 을 2026년 11월 02일부로 착공하겠기에 붙임과 같이 착공계를 제출 합니다.' && joinL(L.c) === '2. 귀 청과 체결한 "' + longT + '" 을 2026년 11월 10일 부로 준공하였기에 붙임과 같이 준공계를 제출 합니다.' && row420(L.s, 'B15')[3] === 10, joinL(L.s));
  const uncut = '가'.repeat(40); const U = build420(uncut);
  T('v420 띄어쓰기 없는 긴 공사명: 줄마다 폭 안 · 공사명·문장 유실 없음', fits(U.s, 94) && fits(U.c, 88) && joinL(U.s).replace(/\s/g, '').indexOf(uncut) > 0 && joinL(U.s).indexOf('착공계를 제출 합니다.') > 0, joinL(U.s));
  set420(base420);
}

{ // ---- v422 준설 실물 양식(체크 31 ✗ 4개) — 패킷 판정·값·생성 ----
  const ALL = { work_start: 1, work_complete: 1, adv_pay: 1, contract_pledge: 1, seal_reg: 1, quote_env: 1 };
  const SAFE = { safety_plan: 1, safety_risk: 1, safety_rule: 1, safety_emerg: 1, safety_ppe: 1, safety_cost: 1, labor_split: 1 };
  const NM = ['안전보건관리계획서', '안전 패킷', '산업안전보건관리비 사용내역서', '노무비 구분관리 패킷'];
  const gens = (h) => [...h.matchAll(/data-cs-gen="[^"|]*\|(\w+)"/g)].map((m) => m[1]);
  const gapN = (h) => (h.match(/양식 없음/g) || []).length;
  let c = mk(); api.setTpl(ALL); let h = api.csPacketsHtml(c);
  T('v422 준설 관급·실물 미등록: ✗ 4개 = "양식 미등록"(등록 칸 있음) · 양식 없음 0 · 생성 버튼 없음', gapN(h) === 0 && /양식 미등록\(안전보건관리계획서\)/.test(h) && /양식 미등록\(위험성평가표\(준설\)·준설 작업 안전 수칙·비상상황 대응체계·안전보호구 지급 대장\)/.test(h) && /양식 미등록\(산업안전보건관리비 사용내역서\)/.test(h) && /양식 미등록\(노무비 구분관리 서식\)/.test(h) && !/safety_|labor_split/.test(gens(h).join()), gens(h).join());
  api.setTpl(Object.assign({}, ALL, SAFE)); h = api.csPacketsHtml(c);
  T('v422 준설 관급·실물 등록: 4항목 ✓ [생성] · 양식 없음 0 · 정산합의서 ✗는 그대로', gapN(h) === 0 && ['safety_plan', 'safety_pack', 'safety_cost', 'labor_split'].every((k) => gens(h).includes(k)) && NM.every((n) => h.indexOf(n) >= 0) && /양식 미등록\(준공 정산합의서\)/.test(h), gens(h).join());
  const miss1 = Object.assign({}, ALL, SAFE); delete miss1.safety_ppe; api.setTpl(miss1); h = api.csPacketsHtml(c);
  T('v422 안전 패킷: 4개 중 하나라도 빠지면 ✗(생성 버튼 없음)', !gens(h).includes('safety_pack') && /양식 미등록\(위험성평가표/.test(h), gens(h).join());
  api.setTpl(Object.assign({}, ALL, SAFE));
  const oth = (type) => { const o = mk(); o.type = type; o.elems = {}; return api.csPacketsHtml(o); };
  T('v422 다른 종류(철거·석면·운반) 관급은 실물 등록 전까지 ✗(양식 없음) — 준설 양식이 끼어들지 않음', ['demolition', 'asbestos', 'waste'].every((t) => { const x = oth(t); return gapN(x) >= 4 && !gens(x).some((k) => /^safety_|^labor_split/.test(k)); }), '');
  const pri = mk(); pri.docType = 'private'; h = api.csPacketsHtml(pri);
  T('v422 준설 사급: 관급 전용 4항목 없음', !/안전보건관리계획서/.test(h) && !/안전 패킷/.test(h) && !/노무비 구분관리/.test(h) && !/산업안전보건관리비/.test(h), '');
  T('v422 묶음 키: csGenKeys = 안전 패킷 4 · 단일 3 · XG_SAFE_FILES와 일치', JSON.stringify(api.csGenKeys(c, 'safety_pack')) === JSON.stringify(api.XG_SAFE_FILES.safety_pack) && api.csGenKeys(c, 'safety_cost')[0] === 'safety_cost' && !api.XG_SAFE_FILES.safety_cost, '');
  const setV = (o) => Object.keys(o).forEach((id) => api.setDocEl(id, { value: o[id] }));
  const base = { xgCo: 'env', xgTitle: '하수도시설물 준설공사', xgSite: '', xgClient: '포항시 맑은물사업본부', xgAmount: '19,525,000', xgD1: '2026-05-15', xgD2: '2026-05-18', xgD3: '2026-06-15', xgSafeFee: '312254', xgSafeRecv: '', xgAgent: '', xgAgentRrn: '', xgAgentLic: '', xgOwner: '' };
  setV(base); let sv = api.xgSafetyVals(), t = sv.tokens;
  T('v422 값: 상호 주식회사 · 금액 ￦ · 작업기간·공사기간·평가년월 · 맑은물은 관리자(기업출납원) 수신 · 안전관리비 천 단위', t['업체명'] === '주식회사 종운환경' && t['금액표기'] === '일금 일천구백오십이만오천 원정(￦19,525,000)' && t['작업기간'] === '2026년 05월 18일부터 2026년 06월 15일' && t['공사기간'] === '2026.05.18~2026.06.15' && t['평가년월'] === '2026년 05월' && t['수신처'] === '포항시 맑은물사업본부 관리자(기업출납원)' && t['안전관리비'] === '312,254' && t['현장책임자'] === '나종운' && t['현장책임자연락처'] === '', JSON.stringify(t));
  setV({ xgCo: 'con', xgClient: '포항 철강산업단지 관리공단', xgAmount: '', xgD1: '', xgD2: '', xgD3: '', xgSafeFee: '' }); sv = api.xgSafetyVals(); t = sv.tokens;
  T('v422 빈 값: 건설 상호 · 수신처 = 발주자 그대로 · 금액·기간 빈 글자(토큰 잔존 없음) · 안전관리비 빈칸 공백 · 누락 안내', t['업체명'] === '주식회사 종운건설' && t['수신처'] === '포항 철강산업단지 관리공단' && t['금액표기'] === '' && t['작업기간'] === '' && t['공사기간'] === '' && /^ +$/.test(t['안전관리비']) && JSON.stringify(api.xgSafetyMissing('labor_split', sv)) === JSON.stringify(['계약금액', '계약일', '착공일', '준공예정일']) && api.xgSafetyMissing('safety_plan', sv).includes('안전보건관리비 편성금액') && !api.xgSafetyMissing('labor_split', sv).includes('안전보건관리비 편성금액'), JSON.stringify(api.xgSafetyMissing('labor_split', sv)));
  const recv = (client, typed) => { setV({ xgClient: client, xgSafeRecv: typed || '' }); return api.xgSafetyVals().tokens['수신처']; };
  T('v422 수신처: 맑은물사업소·포항시 표기는 실물 표기로 모음 · 경주는 그대로 · 창에 고친 값 우선', recv('맑은물사업소') === '포항시 맑은물사업본부 관리자(기업출납원)' && recv('경상북도 포항시 맑은물사업소') === '포항시 맑은물사업본부 관리자(기업출납원)' && recv('경상북도 경주시 맑은물사업본부') === '경상북도 경주시 맑은물사업본부' && recv('남구청 건설교통과') === '남구청 건설교통과' && recv('맑은물사업소', '직접 쓴 수신처') === '직접 쓴 수신처', recv('맑은물사업소'));
  setV(base); setV({ xgTitle: '준설·시설공사', xgD2: '' }); const svL = api.xgSafetyVals();
  T('v422 폴백 확인요망: 공사명이 종류 이름이면·계약일이 시작일 폴백이면 안내 · 계약에 값이 있으면 안내 없음 · 착공일 없으면 평가년월 빈칸', api.xgSafetyMissing('labor_split', svL, { label: '준설·시설공사', title: '' }).some((x) => x.indexOf('공사명(') === 0) && api.xgSafetyMissing('labor_split', svL, { label: '준설·시설공사', title: '' }).some((x) => x.indexOf('계약일(') === 0) && !api.xgSafetyMissing('labor_split', svL, { label: '준설·시설공사', title: '준설·시설공사', contract_info: { d1: '2026-05-15' } }).some((x) => /공사명|계약일/.test(x)) && /^ +년 +월$/.test(svL.tokens['평가년월']), JSON.stringify(api.xgSafetyMissing('labor_split', svL, { label: '준설·시설공사', title: '' })));
  setV(base); let ed = api.xgBuildEdits('safety_cost', { type: 'dredge' });
  const cell = (s, a) => ((ed[s] || []).filter((x) => x[0] === a)[0] || []);
  T('v422 사용내역서 칸: 머리 칸 채움 · 금액·안전관리비 숫자 · 환경계획 갑 공사명 · 기본정보 시트 없음', cell('안전계획 갑', 'F2')[1] === '하수도시설물 준설공사' && cell('안전계획 갑', 'C6')[1] === 19525000 && cell('안전계획 갑', 'C6')[2] === 'n' && cell('안전계획 갑', 'C8')[1] === 312254 && cell('안전계획 갑', 'D30')[1] === '상  호 : 주식회사 종운환경' && cell('안전계획 갑', 'A26')[1] === '2026년 06월   일' && cell('환경계획 갑', 'F2')[1] === '하수도시설물 준설공사' && !ed['기본정보 입력'], JSON.stringify(ed));
  setV({ xgAmount: '', xgSafeFee: '' }); ed = api.xgBuildEdits('safety_cost', { type: 'dredge' });
  { const sent = []; api.setGw((f, d) => { sent.push(d); return Promise.resolve({ status: 200, body: {} }); });
    api.csCdocDraft({ id: 'c_rrn', pipes: [{ cur: 2 }] }, 'work_start', { '현장대리인계': [['E13', '이름', 's'], ['F13', '000000-0000000', 's']], '재직증명서': [['I6', '000000-0000000', 's'], ['E5', '이름', 's']], '공문': [['F13', '그대로', 's']] }, []);
    const body = JSON.stringify(sent[0] || {});
    T('v422 착공계 초안: 주민번호 칸(현장대리인계 F13·재직증명서 I6)만 빠지고 나머지·다른 시트 F13은 남음', sent.length === 1 && body.indexOf('000000-0000000') < 0 && body.indexOf('그대로') > 0 && body.indexOf('E13') > 0, body.slice(0, 200));
    api.setGw(null); }
  T('v422 사용내역서 금액 비면 칸을 건드리지 않음(0으로 안 씀)', !cell('안전계획 갑', 'C6').length && !cell('안전계획 갑', 'C8').length, JSON.stringify(ed));
  setV(base);
  api.setGw((f, d) => Promise.resolve({ status: 404, body: {} }));
  const err = await api.xgSafetyGen('safety_pack', '시험', api.xgSafetyVals()).then(() => '', (e) => String(e));
  T('v422 생성: 미등록이면 첫 양식 이름으로 멈춤', /위험성평가표\(준설\).*양식 미등록/.test(err), err);
  api.setGw(null);
}

console.log(fails ? '\n계약 시트 실행 검사 실패 ' + fails + '건' : '\n계약 시트 실행 검사 전 항목 통과'); process.exit(fails ? 1 : 0);
