'use strict';
// P1 판24-③ (원장 C095 · 옛 T424 · 보안 재감사 ⑥ — 재현됨): 계약 단계 결재를 서버도 강제한다.
//   종전엔 계약 단계(pipes) 결재가 화면(advanceProc·csDoneStage·csApprApply)에서만 막혀, 옛 화면·콘솔 저장이 '결재가 끝나지 않은 단계를 끝남으로'·
//   '결재함에 없는 승인을 단계에 적어 변경계약 금액·종료일을 반영'할 수 있었다. 서버는 단계 결재 결과를 직접 찍지 않으므로(결재는 col:approvals, 단계 반영은 앱이 함)
//   믿을 값은 결재함 항목뿐이다 — 결재함 항목은 approval_decide(관리자·등급 게이트)로만 '승인'이 된다(PM 전결 ①은 생성 때 승인 — 같은 권한).
// 규칙(바뀐 것만 본다 — 지금 서버 문서에 이미 있는 어긋남은 그대로 통과):
//   ① 단계가 이번 저장에서 새로 '끝남(done)'이 됐고 그 단계가 결재 대상이면(앱 csApprKindOf와 같은 판정 · 시나리오 계약만) → 그 단계 ref의 결재함 항목이 '승인'이어야 한다
//   ② 단계의 상신 기록(appr)이 이번 저장에서 새로 '승인'이 됐으면(직전 서버 값이 같은 상신 번호로 승인이 아님) → 같은 결재함 항목이 '승인'이어야 한다
//   ③ 같은 상신 번호(appr.cid)인데 상신 때 사본(appr.snap — 변경 금액·종료일)이 바뀌었으면 거절(승인 뒤·대기 중에 금액을 바꿔치기 하는 길 — 재상신은 새 번호)
//   ④ (재검토 11/15 — 원천) 변경계약 단계(aw 'amt')의 승인 사본은 결재함 항목에 서버가 상신 때 받아 둔 사본(approval_create snap — 승인 뒤 못 바꿈)과 같아야 한다 — ③은 보조
//   결재함 항목 대조 = ref 'con:<계약 id>|<줄 key>|<단계 번호>' · 상신 번호(cid) 같음(번호 없는 승인은 대조 불가 — 앱은 v384부터 늘 붙임) · 단계 고유 종류와 항목 종류 같음 · 상태 '승인'
//   검토(11/15) 반영: 직전에 번호가 있던 상신의 번호를 비우거나 빼면 바뀐 것으로 봄 · 사본 비교는 번호를 비운 것도 같은 상신으로 · 승인 표시 종류 = 단계 고유 종류(앱이 보낸 appr.kind 아님) ·
//   그 자리 단계의 정체(이름·aid·ak·aw)가 직전과 다르면 직전 단계 없음으로 대조
// 결재 대상 판정은 앱(index.html csApprKind·csApprKindOf·csChgAmtChanged)과 같은 식이다 — uismoke 'P1 판24-③'이 같은 표본으로 두 벌을 대조한다. 바꾸면 두 곳 동시에.
const CON_APPR_KINDS = [[/청구|입금/, '청구 검수'], [/계약서/, '계약 단계']];   // 앱 CON_APPR_KINDS와 같은 표
function apprKind(name) { for (let i = 0; i < CON_APPR_KINDS.length; i++) { if (CON_APPR_KINDS[i][0].test(name || '')) return CON_APPR_KINDS[i][1]; } return ''; }
function csNum(x) { return Number(String(x == null ? '' : x).replace(/[^0-9]/g, '')) || 0; }
function chgBase(c) { return Number(((c && c.contract_info) || {}).amount) || 0; }
function chgAmtMoved(c, s) { const v = csNum((s.vals || {}).chg_amt); return (v > 0 && v !== csNum(s.amt0)) || (s.eff0 != null && csNum(chgBase(c)) !== csNum(s.eff0)); }
function chgTermMoved(s) { const e = (s.vals || {}).chg_end; return !!e && csNum(e) !== csNum(s.term0); }
// 앱 csApprKindOf — 신설 단계(aid)는 명시값(ak)만, 변경계약(aw 'amt')은 금액·기간이 바뀐 때만
function apprKindOf(c, s) {
  if (!s || typeof s !== 'object') return '';
  if (!s.aid) return apprKind(s.name);
  if (!s.ak) return '';
  return (s.aw === 'amt' && !(chgAmtMoved(c, s) || chgTermMoved(s))) ? '' : String(s.ak);
}
function snapKey(a) { const v = a && a.snap; if (!v || typeof v !== 'object') return ''; return JSON.stringify([String(v.chg_amt == null ? '' : v.chg_amt), String(v.chg_end == null ? '' : v.chg_end)]); }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
// 단계가 가진 결재 종류(입력 칸 값과 무관 — 그 단계의 정체) — 신설 단계는 ak, 그 밖은 이름 판정. 승인 표시 대조는 앱이 appr에 적어 보낸 종류가 아니라 이것으로(검토 11/15 B2)
function ownKind(s) { if (!isObj(s)) return ''; return s.aid ? String(s.ak || '') : apprKind(s.name); }
// 그 자리 단계의 정체 — 이름·신설 id·종류·변경계약 표식이 직전과 다르면 다른 단계로 본다(검토 B3: 끝난 단계 이름을 '계약서…'로 바꿔 결재 없이 끝난 것처럼 보이던 길)
function stageId(s) { return JSON.stringify([String(s.name == null ? '' : s.name), String(s.aid || ''), String(s.ak || ''), String(s.aw || '')]); }
// 결재함에서 이 단계의 '승인' 항목 찾기 — 상신 번호(cid)가 없으면 대조 불가(검토 A1: 빈 번호가 같은 ref의 아무 승인이나 받던 길) · 종류가 정해진 단계는 항목 종류 같음
function approvedItem(apItems, ref, appr, kind) {
  const cid = appr && appr.cid ? String(appr.cid) : '';
  if (!cid) return null;
  return (apItems || []).find(function (it) {
    return it && it.ref === ref && it.status === '승인' && it.cid === cid && (!kind || it.kind === kind);
  }) || null;
}
// 이번 저장이 결재함 대조를 해야 하는가(결재함을 읽을지) — check()와 같은 조건의 '후보'만 센다(결재함 읽기를 아끼려고)
function scan(oldItems, newItems) {
  const oldBy = {};
  (Array.isArray(oldItems) ? oldItems : []).forEach(function (o) { if (o && o.id != null) oldBy[String(o.id)] = o; });
  const rows = [];
  (Array.isArray(newItems) ? newItems : []).forEach(function (c) {
    if (!isObj(c) || c.id == null) return;
    const o = oldBy[String(c.id)] || null, scen = !!(c.scen || (o && o.scen));
    (Array.isArray(c.pipes) ? c.pipes : []).forEach(function (p) {
      if (!isObj(p) || !Array.isArray(p.stages)) return;
      const op = (o && Array.isArray(o.pipes)) ? o.pipes.find(function (q) { return isObj(q) && q.key === p.key; }) : null;
      p.stages.forEach(function (s, i) {
        if (!isObj(s)) return;
        const os0 = (op && Array.isArray(op.stages) && isObj(op.stages[i])) ? op.stages[i] : null;
        const os = (os0 && stageId(os0) === stageId(s)) ? os0 : null;   // 정체가 바뀐 자리 = 직전 단계 없음으로(새로 끝남·새 승인으로 대조)
        const ref = 'con:' + c.id + '|' + p.key + '|' + i, a = isObj(s.appr) ? s.appr : null, oa = (os && isObj(os.appr)) ? os.appr : null;
        const kind = scen ? apprKindOf(c, s) : '', own = ownKind(s), at = { cid: String(c.id), pipe: String(p.key || ''), i: i };
        const aCid = a ? String(a.cid || '') : '', oCid = oa ? String(oa.cid || '') : '';
        if (s.status === 'done' && !(os && os.status === 'done') && kind) rows.push(Object.assign({ why: 'STAGE_DONE', ref: ref, appr: a, kind: kind }, at));
        // 승인 표시: 직전과 같은 상신 번호로 이미 승인이었으면 그대로 · 직전에 번호가 있었는데 비우거나 뺐으면 바뀜(검토 A1) · 단계 고유 종류가 없으면 승인될 수 없는 단계(늘 거절)
        if (a && a.status === '승인' && !(oa && oa.status === '승인' && aCid === oCid)) rows.push(Object.assign({ why: 'APPR_CLAIM', ref: ref, appr: a, kind: own, hard: !own }, at));
        // 사본: 같은 상신(번호 같음 — 새 번호가 비었으면 직전 상신과 같은 것으로 봄)인데 금액·종료일 사본이 다르면 거절(재상신은 새 번호)
        if (a && oa && (aCid === oCid || !aCid) && snapKey(oa) !== snapKey(a)) rows.push(Object.assign({ why: 'SNAP_CHANGED', ref: ref, appr: a, kind: '', hard: true }, at));
        // 재검토(11/15 A — 원천): 유효 금액·종료일을 내는 변경계약 단계(aw 'amt' · 승인 표시 · 사본 있음 — 앱 conChgEff가 읽는 꼴)는 사본이 **결재함 항목의 사본**과 같아야 한다.
        //   같은 자리의 직전 서버 값(정체·번호와 무관한 날 자리)과 승인·번호·사본이 모두 같으면 이미 대조된 상태라 건너뜀(결재함 읽기 아낌) — 그 밖은 다 대조(이름 바꿈·지웠다 다시 넣기·번호 돌리기 등 몇 번에 나눠도)
        //   사본이 없는 옛 결재 항목은 대조할 사본이 없으므로 '직전 서버 값과 같을 때'(= 위 건너뜀)만 통과
        if (s.aw === 'amt' && a && a.status === '승인' && isObj(a.snap)) {
          const pa = (os0 && isObj(os0.appr)) ? os0.appr : null;
          const prevSame = !!(pa && pa.status === '승인' && String(pa.cid || '') === aCid && snapKey(pa) === snapKey(a));
          if (!prevSame) rows.push(Object.assign({ why: 'SNAP_UNBOUND', ref: ref, appr: a, kind: own, bind: true, hard: !own }, at));
        }
      });
    });
  });
  // 3차 재검토 B1: 유효 금액·종료일을 내던 승인된 변경계약 차수(직전 서버 값)를 지우거나 '건너뜀'으로 바꾸거나 그 자리를 다른 단계로 바꾸면 결재 없이 원계약 값으로 돌아간다 — 거절(관리자도).
  //   되돌리려면 새 변경계약을 상신. 계약 자체를 지운 것(del 1·목록에서 빠짐)은 대상 아님
  const newBy = {};
  (Array.isArray(newItems) ? newItems : []).forEach(function (c) { if (isObj(c) && c.id != null) newBy[String(c.id)] = c; });
  Object.keys(oldBy).forEach(function (id) {
    const o = oldBy[id], c = newBy[id];
    if (!isObj(o) || !c || c.del === 1) return;
    (Array.isArray(o.pipes) ? o.pipes : []).forEach(function (op) {
      if (!isObj(op) || !Array.isArray(op.stages)) return;
      const p = Array.isArray(c.pipes) ? c.pipes.find(function (q) { return isObj(q) && q.key === op.key; }) : null;
      op.stages.forEach(function (os, i) {
        if (!(isObj(os) && os.aw === 'amt' && os.status === 'done' && isObj(os.appr) && os.appr.status === '승인' && isObj(os.appr.snap))) return;
        const s = (p && Array.isArray(p.stages)) ? p.stages[i] : null;
        if (!isObj(s) || s.status === 'skipped' || stageId(s) !== stageId(os)) rows.push({ why: 'APPR_REVOKED', ref: 'con:' + id + '|' + op.key + '|' + i, appr: null, kind: '', hard: true, cid: id, pipe: String(op.key || ''), i: i });
      });
    });
  });
  return rows;
}
// 3차 재검토 B1(덧대기 — 막지 않음): 승인된 변경계약 차수가 있는 계약에서 원계약 금액·준공일 칸(contract_info.amount·d3)이 바뀐 계약 — 감사 줄용(값 없음). 반환 [{cid, f:['amount'|'d3']}]
function origChanged(oldItems, newItems) {
  const oldBy = {}, out = [];
  (Array.isArray(oldItems) ? oldItems : []).forEach(function (o) { if (o && o.id != null) oldBy[String(o.id)] = o; });
  (Array.isArray(newItems) ? newItems : []).forEach(function (c) {
    if (!isObj(c) || c.id == null) return;
    const o = oldBy[String(c.id)]; if (!isObj(o)) return;
    const hasAppr = (Array.isArray(o.pipes) ? o.pipes : []).some(function (p) { return isObj(p) && Array.isArray(p.stages) && p.stages.some(function (s) { return isObj(s) && s.aw === 'amt' && s.status === 'done' && isObj(s.appr) && s.appr.status === '승인'; }); });
    if (!hasAppr) return;
    const a = isObj(o.contract_info) ? o.contract_info : {}, b = isObj(c.contract_info) ? c.contract_info : {}, f = [];
    if (String(a.amount == null ? '' : a.amount) !== String(b.amount == null ? '' : b.amount)) f.push('amount');
    if (String(a.d3 == null ? '' : a.d3) !== String(b.d3 == null ? '' : b.d3)) f.push('d3');
    if (f.length) out.push({ cid: String(c.id), f: f });
  });
  return out;
}
// 거절할 줄 — rows(scan 결과) 중 결재함에 '승인' 항목이 없는 것 + 사본 바뀜(늘 거절). 반환 [{cid, pipe, i, why}] (이름·금액 없음)
function judge(rows, apItems) {
  const out = [];
  rows.forEach(function (r) {
    const it = r.hard ? null : approvedItem(apItems, r.ref, r.appr, r.kind);
    const ok = !!it && (!r.bind || (isObj(it.snap) && snapKey(it) === snapKey(r.appr)));   // 재검토 A: 사본 묶음 — 결재함 항목 사본(서버가 상신 때 받은 값)과 같아야
    if (!ok) out.push({ cid: r.cid, pipe: r.pipe, i: r.i, why: r.why });
  });
  return out;
}
module.exports = { CON_APPR_KINDS, apprKind, apprKindOf, ownKind, chgAmtMoved, chgTermMoved, scan, judge, approvedItem, origChanged };
