'use strict';

// 비관리자에게 숨는 지시 판정 한 곳(C248 검토 — gw-data.js에서 글자째 옮김).
//   부르는 곳: gw-data.js 지시 읽기 거름·저장 이월(handleGet·handleSave) · _lib/ask.js 물어보기 my_tasks(서버가 화면에 안 내려 주는 지시는 물어보기에서도 빠지게).
//   기성 권한은 부르는 쪽 permOf(member, 'receivables')로 판정한다 — gw-data의 permOf(COL receivables → 'rec')를 그대로 넘긴다.
//   ask.js는 COL에 receivables 키가 없으면 늘 '보기'가 되므로 ask.js COL에도 receivables: 'rec'를 둔다(servertest C248 검토가 두 permOf의 기성 판정을 대조).
function make(permOf) {
// v464(C078 ① PM 11/13 '추천대로'): 기성 연동 지시(입금확인 rec_id · 미수 45일 자동 auto_key 'rec:<기성 id>:…' — 제목에 거래처·금액)는 기성 숨김 직원에게 서버가 내려 주지 않는다.
//   담당(본인·전사 __all__)·공개범위에 이름·지시자(from_id·from)인 사람은 그대로(앱 taskVisible·taskForMe와 같은 줄 — 넓히지 않고 좁히기만).
//   그 직원이 지시를 저장하면 빠진 지시는 서버 원본 이월(지워지지 않게), 낡은 사본에 남은 같은 id도 서버 원본으로.
function taskRecHiddenFor(member, t) {
  if (!member || member.admin || !t) return false;
  const rid = t.rec_id || ((/^rec:([^:]+):/.exec(String(t.auto_key || '')) || [])[1]) || '';
  if (!rid || permOf(member, 'receivables') !== 'hide') return false;
  if (t.who_id === '__all__' || (member.id && t.who_id === member.id)) return false;
  if (Array.isArray(t.scope) && member.id && t.scope.indexOf(member.id) >= 0) return false;
  if ((t.from_id && t.from_id === member.id) || (t.from && t.from === member.name)) return false;
  return true;
}
// C185 판2: 입·퇴사 지시(키 hr:·acct:)는 담당·관리자만 — 담당(who_id)·공개 범위(scope)·지시자가 아니면 비관리자에게 숨김(미래 퇴사일·입사 사실이 다른 직원에게 드러나지 않게).
//   키 꼴은 넓게(hr:·acct:로 시작하면 — 서버 실행기만 만드는 꼴, 앱 저장은 이 꼴을 못 단다)
function taskHrHiddenFor(member, t) {
  if (!member || member.admin || !t) return false;
  if (!/^(?:hr|acct):/.test(String(t.auto_key || ''))) return false;
  if (member.id && t.who_id === member.id) return false;
  if (Array.isArray(t.scope) && member.id && t.scope.indexOf(member.id) >= 0) return false;
  if (t.from_id && t.from_id === member.id) return false;
  return true;
}
// 비관리자에게 숨는 지시 = 기성 연동 지시(v464 — 기성 숨김 직원) ∨ 입·퇴사 지시(C185 판2). 읽기 거름·저장 이월·물어보기 my_tasks가 이 한 함수를 부른다
function taskHiddenFor(member, t) { return taskRecHiddenFor(member, t) || taskHrHiddenFor(member, t); }
return { taskRecHiddenFor, taskHrHiddenFor, taskHiddenFor };
}

module.exports = { make };
