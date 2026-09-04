// gw-data 액션 단위 서버 테스트(P3) — Blobs·push·audit를 인메모리 mock으로 갈아끼우고 handler를 직접 호출.
// 커버: 인증 게이트 / 프로토타입 키 우회 / 관리자 전용 / 낙관적 락 409 / leaves 비관리자 재구성 /
//       차량 관리자 필드 복원 / tpl·proof 입력 검증 / backup_put confirm 게이트 / bot_notify 키 검증
// 실행: node tools/servertest.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(ROOT, 'netlify', 'functions');

process.env.GW_SESSION_SECRET = 'servertest-secret';
process.env.BIDS_INGEST_KEY = 'test-ingest-key';
process.env.URL = 'https://test.local';

// ---- in-memory Blobs mock ----
const mem = {};   // mem[store][key] = data
const blobsMock = {
  setupBlobContext() {},
  store(n) { mem[n] = mem[n] || {}; return n; },
  async blobGet(st, k) { const s = mem[st] || {}; return (k in s) ? { ok: true, data: s[k] } : { ok: false, code: 'NOT_FOUND' }; },
  async blobSet(st, k, v) { mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobDelete(st, k) { if (mem[st]) delete mem[st][k]; return { ok: true }; },
  async blobList(st) { return { ok: true, keys: Object.keys(mem[st] || {}) }; },
};
const pushMock = { calls: [], bossList: [],   // bossList는 결재 등급 테스트(17)에서 채운다 — 그 전 테스트(bot_notify sent=1)는 uadmin 1명 유지
  async adminIds() { return ['uadmin'].concat(pushMock.bossList); },
  isBoss(m) { return !!(m && m.admin && m.del !== 1 && (String(m.role || '') === '대표' || String(m.name || '') === '나종운')); },
  async bossIds() { return pushMock.bossList.slice(); },
  async bossOrAdminIds() { return pushMock.bossList.length ? pushMock.bossList.slice() : pushMock.adminIds(); },
  async pmIds() { return (await pushMock.adminIds()).filter((id) => pushMock.bossList.indexOf(id) < 0); },
  async pmOrAdminIds() { const p = await pushMock.pmIds(); return p.length ? p : pushMock.adminIds(); },
  async getSubs() { return { members: { uadmin: [{ sub: {} }] } }; }, async saveSubs() {}, async sendTo(ids, p) { pushMock.calls.push(p); return { sent: ids.length, removed: 0 }; } };
const auditMock = { logs: [], async appendAudit(e) { auditMock.logs.push(e); }, auditKey: () => 'audit', diffItems: () => [], short: (s) => String(s).slice(0, 20), DATA: 'gw_data' };
for (const [p, m] of [['_lib/blobs.js', blobsMock], ['_lib/push.js', pushMock], ['_lib/audit.js', auditMock]]) {
  const rp = require.resolve(join(FN, p));
  require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: m };
}
const { issueSession } = require(join(FN, '_lib/session.js'));
const gwd = require(join(FN, 'gw-data.js'));

// ---- seed ----
const ADMIN = { id: 'uadmin', name: '관리자', admin: true, perms: {} };
const WORKER = { id: 'uwork', name: '직원', admin: false, perms: { tasks: 'do', veh: 'do', leaves: 'do', rec: 'do' } };
mem.gw_users = { 'member:uadmin': ADMIN, 'member:uwork': WORKER, 'device:dev1': { status: 'approved' } };
mem.gw_data = {};
const tokA = issueSession(ADMIN).token, tokW = issueSession(WORKER).token;
async function call(body, tok, dev) {
  const r = await gwd.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) });
  return { code: r.statusCode, body: JSON.parse(r.body || '{}') };
}

let pass = 0, fail = 0;
const T = (name, cond, note) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (note ? ' — ' + note : '')); } };

// 1 인증 게이트
let r = await call({ action: 'get', collection: 'tasks' }, null);
T('비로그인 get → 401', r.code === 401);
// 2 프로토타입 키 우회 차단
r = await call({ action: 'get', collection: 'constructor' }, tokA);
T('collection=constructor → 400 UNKNOWN_COLLECTION', r.code === 400 && r.body.error_code === 'UNKNOWN_COLLECTION', r.code + '/' + r.body.error_code);
// 3 미지 컬렉션
r = await call({ action: 'get', collection: 'nope' }, tokA);
T('미지 컬렉션 → 400', r.code === 400);
// 4 bids 비관리자 차단(기기 승인돼도)
r = await call({ action: 'get', collection: 'bids' }, tokW, 'dev1');
T('비관리자 bids → 403 ADMIN_ONLY', r.code === 403 && r.body.error_code === 'ADMIN_ONLY');
// 4b edu(교육·건강진단 대장)는 인사 탭이 관리자 전용인데 서버 permOf 기본 view라 비관리자가 API로 전 직원 검진 기록을 읽을 수 있던 구멍(9/4) — 닫고 시작
r = await call({ action: 'get', collection: 'edu' }, tokW, 'dev1');
T('비관리자 edu(hr) → 403 NO_ACCESS(기본 숨김)', r.code === 403 && r.body.error_code === 'NO_ACCESS', r.code + '/' + r.body.error_code);
// 5 기기 미승인 차단
r = await call({ action: 'get', collection: 'tasks' }, tokW, 'devX');
T('미승인 기기 → 403 DEVICE_NOT_APPROVED', r.code === 403 && r.body.error_code === 'DEVICE_NOT_APPROVED');
// 6 낙관적 락: 서버 문서 updated_at=1000, base=500 → 409
mem.gw_data['col:tasks'] = { schema: 1, items: [{ id: 't1', title: '기존' }], updated_at: 1000 };
r = await call({ action: 'save', collection: 'tasks', base: 500, doc: { schema: 1, items: [] } }, tokA);
T('낡은 base 저장 → 409 STALE_BASE', r.code === 409 && r.body.error_code === 'STALE_BASE');
// 7 base 일치 → 저장 OK + updated_at 반환
r = await call({ action: 'save', collection: 'tasks', base: 1000, doc: { schema: 1, items: [{ id: 't1', title: '수정' }] } }, tokA);
T('base 일치 저장 → 200 + updated_at', r.code === 200 && r.body.updated_at > 0);
// 8 leaves 비관리자 재구성: 타인 항목 보존 + 본인 승인 격상 차단
mem.gw_data['col:leaves'] = { schema: 1, items: [ { id: 'L1', member_id: 'uadmin', status: 'pending' }, { id: 'L2', member_id: 'uwork', status: 'pending' } ], updated_at: 2000 };
r = await call({ action: 'save', collection: 'leaves', base: 2000, doc: { schema: 1, items: [ { id: 'L2', member_id: 'uwork', status: 'approved' }, { id: 'L3', member_id: 'uwork', status: 'pending' } ] } }, tokW, 'dev1');
{
  const saved = mem.gw_data['col:leaves'].items;
  const hasOther = saved.some((x) => x.id === 'L1');
  const l2 = saved.find((x) => x.id === 'L2');
  const l3 = saved.find((x) => x.id === 'L3');
  T('leaves: 타인 신청(L1) 보존', r.code === 200 && hasOther, JSON.stringify(saved).slice(0, 120));
  T('leaves: 본인 승인 자가격상 차단(L2 pending 유지)', l2 && l2.status === 'pending', l2 && l2.status);
  T('leaves: 본인 신규 신청(L3) 반영', !!l3);
}
// 9 차량 관리자 전용 필드 복원
mem.gw_data['col:vehicles'] = { schema: 1, items: [{ id: 'v1', no: '82수', acq_price: 50000000, nodoc_amt: 3000000 }], updated_at: 3000 };
r = await call({ action: 'save', collection: 'vehicles', base: 3000, doc: { schema: 1, items: [{ id: 'v1', no: '82수-수정' }] } }, tokW, 'dev1');
{
  const v1 = (mem.gw_data['col:vehicles'].items || []).find((x) => x.id === 'v1');
  T('차량: 비관리자 저장에도 취득가액 복원', r.code === 200 && v1 && v1.acq_price === 50000000, JSON.stringify(v1));
}
// 10 tpl 잘못된 키
r = await call({ action: 'tpl_put', key: 'evil', data: 'AAAA' }, tokA);
T('tpl_put 미등록 키 → 400 BAD_TPL_KEY', r.code === 400 && r.body.error_code === 'BAD_TPL_KEY');
// 11 proof __index__ 자기파괴 방지
r = await call({ action: 'proof_put', name: '__index__', data: 'AAAA' }, tokA);
T('proof_put __index__ → 400', r.code === 400);
// 12 backup_put confirm 게이트
r = await call({ action: 'backup_put', secret: 'test-ingest-key', store: 'gw_data', key: 'rt', data: { a: 1 } });
T('backup_put confirm 없음 → NEED_CONFIRM', r.body.error_code === 'NEED_CONFIRM');
r = await call({ action: 'backup_put', secret: 'test-ingest-key', store: 'gw_data', key: 'rt', data: { a: 1 }, confirm: true });
T('backup_put confirm → 200 + 저장', r.code === 200 && mem.gw_data.rt && mem.gw_data.rt.a === 1);
// 13 bot_notify 키 검증 + 발송 결과
r = await call({ action: 'bot_notify', key: 'wrong', title: 'x' });
T('bot_notify 잘못된 키 → 403', r.code === 403);
r = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '테스트', body: 'b' });
T('bot_notify → sent=실발송 수', r.code === 200 && r.body.sent === 1 && pushMock.calls.length === 1, JSON.stringify(r.body));

// 14 quotes 서버 편입(견적 탭 GitHub 직행→저장 유실 실사고의 회귀 방지)
r = await call({ action: 'save', collection: 'quotes', doc: { schema: 1, items: [{ id: 'q1', no: '202608-01' }] } }, tokA);
T('quotes 저장 → 200', r.code === 200, r.code + '/' + r.body.error_code);
r = await call({ action: 'get', collection: 'quotes' }, tokA);
T('quotes 조회 왕복(no 보존)', r.code === 200 && r.body.doc && (r.body.doc.items || []).length === 1 && r.body.doc.items[0].no === '202608-01');
r = await call({ action: 'save', collection: 'quotes', doc: { schema: 1, items: [] } }, tokW, 'dev1');
T('quotes: 권한 미부여 직원 쓰기 → 403 NO_WRITE', r.code === 403 && r.body.error_code === 'NO_WRITE');
// 견적서 독립 권한(영업 직렬 전용): 기본값 숨김 — 명시 부여 없으면 읽기도 차단
r = await call({ action: 'get', collection: 'quotes' }, tokW, 'dev1');
T('quotes: 기본 숨김 → 읽기도 403 NO_ACCESS', r.code === 403 && r.body.error_code === 'NO_ACCESS', r.code + '/' + r.body.error_code);
const SALES = { id: 'usales', name: '영업', admin: false, perms: { quote: 'do' } };
mem.gw_users['member:usales'] = SALES;
r = await call({ action: 'save', collection: 'quotes', doc: { schema: 1, items: [{ id: 'q9', no: '202608-09' }] } }, issueSession(SALES).token, 'dev1');
T('quotes: 견적서 수행(영업) 부여 시 쓰기 가능', r.code === 200);

// 15 버전 링 + 시점 복구(구 git 이력 복구가 Blobs 전환으로 무효가 된 자리 — S1-B)
mem.gw_data['col:clients'] = { schema: 1, items: [{ id: 'c1', name: '원본' }, { id: 'c2', del: 1 }], updated_at: 5000 };
r = await call({ action: 'save', collection: 'clients', base: 5000, doc: { schema: 1, items: [{ id: 'c1', name: '수정' }] } }, tokA);
T('저장 시 직전 문서 스냅샷 생성', r.code === 200 && Object.keys(mem.gw_data).some((k) => k.indexOf('ver:clients:') === 0));
r = await call({ action: 'ver_list', collection: 'clients' }, tokA);
T('ver_list → 1건 + 카운트(전체2·사용1)', r.code === 200 && r.body.items.length === 1 && r.body.items[0].tot === 2 && r.body.items[0].live === 1, JSON.stringify(r.body.items));
const vts = r.body.items[0].ts;
r = await call({ action: 'ver_list', collection: 'clients' }, tokW, 'dev1');
T('ver_list 비관리자 → 403', r.code === 403);
r = await call({ action: 'ver_get', collection: 'clients', ts: vts }, tokA);
T('ver_get → 복구본/현재 카운트', r.code === 200 && r.body.ver.tot === 2 && r.body.cur.tot === 1, JSON.stringify(r.body));
r = await call({ action: 'ver_restore', collection: 'clients', ts: vts }, tokA);
T('ver_restore → 문서 되돌림(c1=원본)', r.code === 200 && mem.gw_data['col:clients'].items.length === 2 && mem.gw_data['col:clients'].items[0].name === '원본');
r = await call({ action: 'ver_list', collection: 'clients' }, tokA);
T('복구 전 상태 자동보존(이력 2건)', r.code === 200 && r.body.items.length === 2);
r = await call({ action: 'ver_restore', collection: 'clients', ts: 12345 }, tokA);
T('ver_restore 없는 버전 → 404', r.code === 404);
// 15b 퇴사자 차단(S2-A): 퇴사일 지난 회원은 유효 세션이 있어도 데이터 접근 불가
const RETIRED = { id: 'uret', name: '퇴사자', admin: false, perms: { tasks: 'do' }, leave_date: '2020-01-01' };
mem.gw_users['member:uret'] = RETIRED;
r = await call({ action: 'get', collection: 'tasks' }, issueSession(RETIRED).token, 'dev1');
T('퇴사일 지난 회원 → 401 NO_MEMBER', r.code === 401 && r.body.error_code === 'NO_MEMBER', r.code + '/' + r.body.error_code);
mem.gw_users['member:uret'].leave_date = '2999-12-31';
r = await call({ action: 'get', collection: 'tasks' }, issueSession(RETIRED).token, 'dev1');
T('퇴사일 미도래 회원 → 접근 가능', r.code === 200);

// 15c 기성 돈 상태 서버 강제(간이 검수 게이트): rec 수행 직원도 paid·reviewed·invoice는 못 바꿈
mem.gw_data['col:receivables'] = { schema: 1, items: [{ id: 'r1', client: '갑', amount: 100, paid: null, invoice: false }], updated_at: 7000 };
r = await call({ action: 'save', collection: 'receivables', base: 7000, doc: { schema: 1, items: [
  { id: 'r1', client: '갑', amount: 100, paid: '2026-08-04', invoice: true, reviewed: { by: '직원', date: '2026-08-04' } },
  { id: 'r2', client: '을', amount: 200, paid: '2026-08-04', invoice: true, reviewed: { by: '직원', date: '2026-08-04' } }
] } }, tokW, 'dev1');
{
  const its = mem.gw_data['col:receivables'].items;
  const r1 = its.find((x) => x.id === 'r1'), r2 = its.find((x) => x.id === 'r2');
  T('기성: 직원이 기존 건 입금·발행·검수 조작 → 서버가 복원', r.code === 200 && r1 && r1.paid === null && r1.invoice === false && !r1.reviewed, JSON.stringify(r1));
  T('기성: 직원 신규 청구는 미입금·미발행·미검수로 강제', r2 && r2.paid === null && r2.invoice === false && !r2.reviewed && r2.amount === 200, JSON.stringify(r2));
}
r = await call({ action: 'save', collection: 'receivables', doc: { schema: 1, items: [{ id: 'r1', client: '갑', amount: 100, paid: '2026-08-04', invoice: false }, { id: 'r2', client: '을', amount: 200, paid: null, invoice: false }] } }, tokA);
T('기성: 관리자는 입금 처리 가능', r.code === 200 && mem.gw_data['col:receivables'].items.find((x) => x.id === 'r1').paid === '2026-08-04');

// 15d 정기업무 봇 ingest(autotask — S1 이후 리포 tasks.json 스테일 사고의 수리 경로)
mem.gw_data['col:tasks'] = { schema: 1, items: [
  { id: 'ta', title: '기존 자동지시', auto_key: 'veh:v9:insp:2026-09-01', status: 'open' },
  { id: 'tb', title: '회색차 잘못 생성', auto_key: 'veh:vGrey:ins:2026-09-01', status: 'open' }
], updated_at: 8000 };
r = await call({ action: 'autotask_ingest', key: 'wrong', items: [] });
T('autotask_ingest 잘못된 키 → 403', r.code === 403);
r = await call({ action: 'autotask_ingest', key: 'test-ingest-key',
  items: [ { auto_key: 'veh:v9:insp:2026-09-01', title: '중복이라 무시' }, { auto_key: 'cert:c11', title: '증명서 갱신 발급', due: '2026-08-14' } ],
  hide_keys: ['veh:vGrey:ins:2026-09-01'] });
{
  const its = mem.gw_data['col:tasks'].items;
  T('autotask: auto_key 중복 무시 + 신규 1건 생성', r.code === 200 && r.body.made === 1 && its.some((t) => t.auto_key === 'cert:c11' && t.status === 'open'), JSON.stringify(r.body));
  T('autotask: hide_keys 자기정정(회색차 지시 숨김)', r.body.fixed === 1 && its.find((t) => t.id === 'tb').del === 1);
}

// 16 봇 스냅샷: bids는 VER_SKIP(매 수집마다 전체 문서 복제가 대표 체감 속도를 깎아 제외) — 봇 ingest는 스냅샷을 남기지 않는다(비우기 force만 보존). 옛 기대 '일 1개'는 설계 변경 전 잔재였음(9/4 정정)
mem.gw_data['col:bids'] = { schema: 1, items: [{ id: 'b1', status: 'new' }], updated_at: 1 };
r = await call({ action: 'bids_ingest', key: 'test-ingest-key', items: [{ id: 'b2', title: 't' }] });
r = await call({ action: 'bids_ingest', key: 'test-ingest-key', items: [{ id: 'b3', title: 't' }] });
{
  const vers = Object.keys(mem.gw_data).filter((k) => k.indexOf('ver:bids:') === 0);
  T('봇 ingest 스냅샷 없음(bids=VER_SKIP)', r.code === 200 && vers.length === 0, vers.length + '개');
}

// 17 결재 3차 — 업무별 등급: 게이트 매트릭스(명세 §4.1) + 생성 스탬프 + ② 단계 전환
const BOSS = { id: 'uboss', name: '나종운', admin: true, role: '대표', perms: {} };
mem.gw_users['member:uboss'] = BOSS;
pushMock.bossList = ['uboss'];
const tokB = issueSession(BOSS).token;
mem.gw_data['col:approvals'] = { schema: 1, items: [], updated_at: 0 };
// 등급표 조회·변경 게이트
r = await call({ action: 'appr_grades_get' }, tokW, 'dev1');
T('등급표 조회 비관리자 → 403', r.code === 403);
r = await call({ action: 'appr_grades_get' }, tokA);
T('등급표 기본값(§2 확정표): 지시=① 운반일지=③ 사직·휴직=②', r.code === 200 && r.body.grades['지시'] === 1 && r.body.grades['운반일지'] === 3 && r.body.grades['사직·휴직'] === 2, JSON.stringify(r.body.grades).slice(0, 120));
r = await call({ action: 'appr_grades_set', kind: '지시', grade: 3 }, tokW, 'dev1');
T('등급 변경 비관리자 → 403', r.code === 403);
r = await call({ action: 'appr_grades_set', kind: '없는종류', grade: 1 }, tokA);
T('등급표 밖 kind → 400 UNKNOWN_KIND', r.code === 400 && r.body.error_code === 'UNKNOWN_KIND');
r = await call({ action: 'appr_grades_set', kind: '지시', grade: 3 }, tokA);
T('등급 변경 관리자 → 200 + 병합 반영', r.code === 200 && r.body.grades['지시'] === 3);
r = await call({ action: 'appr_grades_set', kind: '지시', grade: 1 }, tokA);
T('등급 원복(지시=①)', r.code === 200 && r.body.grades['지시'] === 1);
// ① 생성·게이트: 담당 기안 → grade1·to pm, 대표는 결재 불가(PM_ONLY), 비대표 관리자 승인=종결
r = await call({ action: 'approval_create', kind: '지시', title: '① 등급 건' }, tokW, 'dev1');
const g1id = r.body.id;
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g1id);
  T('① 생성: grade1 · to pm 스탬프', r.code === 200 && it && it.grade === 1 && it.to === 'pm', JSON.stringify(it).slice(0, 120));
}
r = await call({ action: 'approval_decide', id: g1id, decision: '승인' }, tokB, 'dev1');
T('① PM 큐를 대표가 결재 → 403 PM_ONLY', r.code === 403 && r.body.error_code === 'PM_ONLY', r.code + '/' + r.body.error_code);
r = await call({ action: 'approval_decide', id: g1id, decision: '확인' }, tokA);
T('전결총정리 아닌 건에 확인 → 400', r.code === 400 && r.body.error_code === 'CONFIRM_ONLY_SUMMARY');
r = await call({ action: 'approval_decide', id: g1id, decision: '승인' }, tokA);
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g1id);
  T('① 비대표 관리자 승인=종결 + chain 기록', r.code === 200 && it.status === '승인' && Array.isArray(it.chain) && it.chain.length === 1, JSON.stringify(it.chain));
}
// ③ 생성·게이트: 지입료=③ → to boss, 비대표는 승인 불가·보류만, 대표 승인=종결
r = await call({ action: 'approval_create', kind: '지입료', title: '③ 등급 건' }, tokW, 'dev1');
const g3id = r.body.id;
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g3id);
  T('③ 생성: grade3 · to boss(운반일지 하드코딩의 일반화)', r.code === 200 && it && it.grade === 3 && it.to === 'boss');
}
r = await call({ action: 'approval_decide', id: g3id, decision: '승인' }, tokA);
T('③을 비대표 관리자가 승인 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
r = await call({ action: 'approval_decide', id: g3id, decision: '보류' }, tokA);
T('③ 보류는 관리자 누구나(대표 부재 대기 통로 유지)', r.code === 200 && r.body.decided === '보류');
r = await call({ action: 'approval_decide', id: g3id, decision: '승인' }, tokB, 'dev1');
T('③ 대표 승인=종결', r.code === 200 && r.body.decided === '승인');
// ② 생성·단계 전환: 사직·휴직=② → to pm → PM 보류 불가 → PM 승인 시 to boss·status 대기 → 대표만 → 반려는 기안자 회귀(종결)
r = await call({ action: 'approval_create', kind: '사직·휴직', title: '② 등급 건' }, tokW, 'dev1');
const g2id = r.body.id;
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g2id);
  T('② 생성: grade2 · to pm(1/2단계)', r.code === 200 && it && it.grade === 2 && it.to === 'pm');
}
r = await call({ action: 'approval_decide', id: g2id, decision: '보류' }, tokA);
T('② PM 단계 보류 → 400 HOLD_NOT_ALLOWED(§12-6)', r.code === 400 && r.body.error_code === 'HOLD_NOT_ALLOWED');
r = await call({ action: 'approval_decide', id: g2id, decision: '승인' }, tokA);
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g2id);
  T('② PM 승인=단계 전환(to boss·status 대기·최종 결과 미기록)', r.code === 200 && r.body.to === 'boss' && it.to === 'boss' && it.status === '대기' && !it.decided_by, JSON.stringify(it).slice(0, 160));
}
r = await call({ action: 'approval_decide', id: g2id, decision: '승인' }, tokA);
T('② 2단계를 비대표가 승인 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
r = await call({ action: 'approval_decide', id: g2id, decision: '반려' }, tokB, 'dev1');
T('② 대표 반려 사유 없음 → 400', r.code === 400 && r.body.error_code === 'REASON_REQUIRED');
r = await call({ action: 'approval_decide', id: g2id, decision: '반려', reason: '재검토' }, tokB, 'dev1');
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g2id);
  T('② 대표 반려=종결(기안자 회귀 — PM 큐로 안 돌아감)', r.code === 200 && it.status === '반려' && it.to === 'boss' && it.chain.length === 2);
}
// PM(비대표 관리자) 자기 기안 ② = 자동통과 → 즉시 대표 큐
r = await call({ action: 'approval_create', kind: '사직·휴직', title: 'PM 기안 ②' }, tokA);
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === r.body.id);
  T('② PM 기안 자동통과(chain 기록·to boss)', r.code === 200 && it.to === 'boss' && it.chain.length === 1 && it.chain[0].decision === '자동통과');
}
// "대표 상신" 토글 = ① 건별 ② 격상
r = await call({ action: 'approval_create', kind: '지시', title: '격상 건', boss_up: 1 }, tokW, 'dev1');
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === r.body.id);
  T('토글 격상: grade2 · escalated · to pm', r.code === 200 && it.grade === 2 && it.escalated === true && it.to === 'pm');
}
// 시스템 전용 kind·구건 하위호환
r = await call({ action: 'approval_create', kind: '전결총정리', title: '위조 총정리' }, tokA);
T('전결총정리 사용자 기안 → 400 SYSTEM_KIND', r.code === 400 && r.body.error_code === 'SYSTEM_KIND');
r = await call({ action: 'approval_create', kind: '일반', title: '등급표 밖 구건' }, tokW, 'dev1');
const g0id = r.body.id;
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === g0id);
  T('등급표 밖 kind: grade 미부여(구건=현행)', r.code === 200 && it && it.grade === undefined && it.to === undefined);
}
r = await call({ action: 'approval_decide', id: g0id, decision: '승인' }, tokB, 'dev1');
T('구건은 현행 게이트(관리자 전원 — 대표 포함)', r.code === 200 && r.body.decided === '승인');

// 18 전결 총정리 크론(gw-appr-cron): 전월 ① 승인 집계 + 휴가 읽기 합산 + 멱등 + KST 경계(§10-6)
const apprCron = require(join(FN, 'gw-appr-cron.js'));
mem.gw_data['col:approvals'] = { schema: 1, items: [
  { id: 'p1', kind: '지시', title: '8월 전결 건', grade: 1, to: 'pm', status: '승인', by: { id: 'uwork', name: '직원' },
    created: '2026-08-19T01:00:00.000Z', decided_at: '2026-08-20T05:00:00.000Z', chain: [] },
  { id: 'p2', kind: '지시', title: '8월 반려 건', grade: 1, to: 'pm', status: '반려', by: { id: 'uwork', name: '직원' },
    created: '2026-08-21T01:00:00.000Z', decided_at: '2026-08-21T02:00:00.000Z', reason: 'x', chain: [] },
  { id: 'p3', kind: '지시', title: '9월 귀속 건(8/31 23시 UTC=KST 9/1)', grade: 1, to: 'pm', status: '승인', by: { id: 'uwork', name: '직원' },
    created: '2026-08-31T10:00:00.000Z', decided_at: '2026-08-31T15:10:00.000Z', chain: [] },
  { id: 'p4', kind: '사직·휴직', title: '②는 총정리 제외', grade: 2, to: 'boss', status: '승인', by: { id: 'uwork', name: '직원' },
    created: '2026-08-10T01:00:00.000Z', decided_at: '2026-08-11T01:00:00.000Z', chain: [] },
], updated_at: 100 };
mem.gw_data['col:leaves'] = { schema: 1, items: [
  { id: 'L8', member_id: 'uwork', type: 'annual', days: 1, start: '2026-08-14', status: 'approved' },
  { id: 'L9', member_id: 'uwork', type: 'resign', days: 0, start: '2026-08-20', status: 'approved' },
  { id: 'L10', member_id: 'uwork', type: 'annual', days: 1, start: '2026-07-02', status: 'approved' },
], updated_at: 100 };
const KST_SEP1 = Date.UTC(2026, 7, 31, 23, 0);   // UTC 8/31 23:00 = KST 9/1 08:00
let cr = await apprCron.runSummary('gw_data', KST_SEP1 + 86400000 * 5);   // KST 9/6 — 복구 창(1~5일) 밖
T('크론: KST 1~5일 밖이면 스킵', cr.ok && cr.skipped === 'not-first-days', JSON.stringify(cr));
cr = await apprCron.runSummary('gw_data', KST_SEP1);
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === 'summary-2026-08');
  T('크론: 총정리 카드 생성(①승인 1 + 휴가 1 = 2건, ③·to boss)', cr.ok && cr.id === 'summary-2026-08' && it && it.kind === '전결총정리' && it.grade === 3 && it.to === 'boss' && it.title.indexOf('2건') >= 0, JSON.stringify(cr) + ' / ' + (it && it.title));
  T('크론: KST 경계 — 8/31 23시 UTC 승인 건은 9월 귀속(제외), ②도 제외', it && it.summary.ids.length === 1 && it.summary.ids[0] === 'p1' && it.summary.rejected === 1, it && JSON.stringify(it.summary));
  T('크론: 휴가 읽기 합산(사직·전월 밖 제외)', it && it.summary.leave.n === 1 && it.summary.leave.days === 1, it && JSON.stringify(it.summary.leave));
}
cr = await apprCron.runSummary('gw_data', KST_SEP1);
T('크론: 재실행 멱등(같은 id 스킵)', cr.ok && cr.skipped === 'exists' && mem.gw_data['col:approvals'].items.filter((x) => x.id === 'summary-2026-08').length === 1);
// 총정리 카드 게이트: [확인]만, 대표만
r = await call({ action: 'approval_decide', id: 'summary-2026-08', decision: '반려', reason: 'x' }, tokB, 'dev1');
T('총정리에 반려 → 400 SUMMARY_CONFIRM_ONLY', r.code === 400 && r.body.error_code === 'SUMMARY_CONFIRM_ONLY');
r = await call({ action: 'approval_decide', id: 'summary-2026-08', decision: '확인' }, tokA);
T('총정리 확인을 비대표가 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
r = await call({ action: 'approval_decide', id: 'summary-2026-08', decision: '확인' }, tokB, 'dev1');
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === 'summary-2026-08');
  T('총정리 대표 [확인] → status 승인 · chain decision 확인', r.code === 200 && it.status === '승인' && it.chain.length === 1 && it.chain[0].decision === '확인');
}

// 19 문서함 공개범위·등재 결재(v314): 설정 게이트·기본값(전부 비공개) / get 필터(scope·mgmt·01·타인 대기) / save 재구성(탈취 차단·상태 원복·hidden_tmp 보존)
//    / 직원 등재→대기+카드 자동 상신(멱등 cid) / 승인→등재·반려→반려 / 재상신 cid / 폴 재시도·구 카드 무시 / gate none / 관리자 즉시 등재 / 설정 낙관락
const DOCW = { id: 'udocw', name: '문서직원', admin: false, perms: { doc: 'do' } };
const DOCW2 = { id: 'udocw2', name: '직원2', admin: false, perms: { doc: 'do' } };
const MGMT = { id: 'umgmt', name: '관리부원', admin: false, dept: '관리부', perms: { doc: 'view' } };
mem.gw_users['member:udocw'] = DOCW; mem.gw_users['member:udocw2'] = DOCW2; mem.gw_users['member:umgmt'] = MGMT;
const tokD = issueSession(DOCW).token, tokD2 = issueSession(DOCW2).token, tokM = issueSession(MGMT).token;
mem.gw_data['col:approvals'] = { schema: 1, items: [], updated_at: 0 };
delete mem.gw_data['settings:documents'];
mem.gw_data['col:documents'] = { schema: 1, items: [
  { id: 'd1', title: '취업규칙', cat: '02' },
  { id: 'd2', title: '안전보건 수칙', cat: '03', scope: 'all' },
  { id: 'd3', title: '규정 지정공개', cat: '05', scope: { ids: ['udocw'] } },
  { id: 'd4', title: '양식 관리부', cat: '06', scope: 'mgmt' },
  { id: 'd5', title: '법인 등기', cat: '01' },
  { id: 'd6', title: '임시 숨김', cat: '06', del: 1, hidden_tmp: 1 },
  { id: 'd7', title: '타인 대기', cat: '06', status: '대기', by: { id: 'udocw2', name: '직원2' }, scope: 'all' },
], updated_at: 9000 };
const docIds = (res) => ((res.body.doc && res.body.doc.items) || []).map((x) => x.id).sort().join(',');
const docItem = (id) => (mem.gw_data['col:documents'].items || []).find((x) => x && x.id === id);
const docAppr = (id) => mem.gw_data['col:approvals'].items.filter((x) => x && x.kind === '문서함 등재' && x.ref === 'doc:' + id);
r = await call({ action: 'doc_settings_get' }, tokD, 'dev1');
T('문서함 설정 조회 비관리자 → 403', r.code === 403);
r = await call({ action: 'doc_settings_get' }, tokA);
T('문서함 설정 기본값: 전 분류 관리자만(전부 비공개) · 등재 결재 staff', r.code === 200 && ['02', '03', '05', '06', '99'].every((c) => r.body.settings.scope_default[c] === 'admin') && r.body.settings.register_gate === 'staff', JSON.stringify(r.body.settings));
r = await call({ action: 'get', collection: 'documents' }, tokD, 'dev1');
T('get 필터(직원): 전원 공개·본인 지정만 — 분류 기본(관리자만)·mgmt·01·타인 대기·숨김 구건 제거', r.code === 200 && docIds(r) === 'd2,d3', docIds(r));
r = await call({ action: 'get', collection: 'documents' }, tokM, 'dev1');
T('get 필터(관리부): 전원·mgmt·01 — 지정(타인)·분류 기본은 제외', r.code === 200 && docIds(r) === 'd2,d4,d5', docIds(r));
r = await call({ action: 'get', collection: 'documents' }, tokA);
T('get(관리자): 무제한 7건', r.code === 200 && docIds(r) === 'd1,d2,d3,d4,d5,d6,d7', docIds(r));
r = await call({ action: 'doc_settings_set', cat: '01', scope: 'all' }, tokA);
T('설정: 01 법인 → 400 BAD_CAT(하드차단 유지)', r.code === 400 && r.body.error_code === 'BAD_CAT');
r = await call({ action: 'doc_settings_set', cat: '02', scope: 'everyone' }, tokA);
T('설정: 무효 scope → 400 BAD_SCOPE', r.code === 400 && r.body.error_code === 'BAD_SCOPE');
r = await call({ action: 'doc_settings_set', register_gate: 'boss' }, tokA);
T('설정: 무효 gate → 400 BAD_GATE', r.code === 400 && r.body.error_code === 'BAD_GATE');
r = await call({ action: 'doc_settings_set', cat: '02', scope: 'all' }, tokD, 'dev1');
T('설정 변경 비관리자 → 403', r.code === 403);
r = await call({ action: 'doc_settings_set', cat: '02', scope: 'all', base: 0 }, tokA);
const dsAt = r.body.updated_at;
T('설정: 02 → 전원 (base 0) → 200 + 감사로그 문서함설정', r.code === 200 && r.body.settings.scope_default['02'] === 'all' && dsAt > 0 && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '문서함설정'), r.code + '/' + r.body.error_code);
r = await call({ action: 'doc_settings_set', cat: '03', scope: 'mgmt', base: 1 }, tokA);
T('설정 낙관락: 낡은 base → 409 DOC_SETTINGS_STALE', r.code === 409 && r.body.error_code === 'DOC_SETTINGS_STALE');
r = await call({ action: 'doc_settings_set', cat: '03', scope: 'mgmt', base: dsAt }, tokA);
T('설정 낙관락: 최신 base → 200', r.code === 200 && r.body.settings.scope_default['03'] === 'mgmt' && r.body.settings.scope_default['02'] === 'all');
r = await call({ action: 'get', collection: 'documents' }, tokD, 'dev1');
T('분류 기본값 변경 즉시 반영: 02 전원 → 직원이 d1 열람', r.code === 200 && docIds(r) === 'd1,d2,d3', docIds(r));
r = await call({ action: 'get', collection: 'documents' }, tokM, 'dev1');
T('03 관리부+관리자 → 관리부원 d2 유지(문서 scope all 우선) + d1', r.code === 200 && docIds(r) === 'd1,d2,d4,d5', docIds(r));
// save 재구성(탈취 차단): 못 보는 문서(d4 scope 확장·d5 01 위장·d6 삭제·d7 타인 대기 격상) 전부 서버 원본 유지, 신규는 등재자 스탬프+'대기'(status '등재' 위조 원복)
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: [
  { id: 'd1', title: '취업규칙', cat: '02', scope: 'admin' },
  { id: 'd2', title: '안전보건 수칙', cat: '03', scope: 'all' },
  { id: 'd3', title: '규정 지정공개', cat: '05', scope: { ids: ['udocw', 'udocw', 7] } },
  { id: 'd4', title: '양식 관리부', cat: '06', scope: 'all' },
  { id: 'd5', title: '법인 등기 위장', cat: '06' },
  { id: 'd7', title: '타인 대기', cat: '06', status: '등재', by: { id: 'udocw', name: '문서직원' }, scope: 'all' },
  { id: 'dn1', title: '신규 직원문서', cat: '06', status: '등재', by: { id: 'uadmin', name: '관리자' }, registered_by: { id: 'uadmin' }, scope: 'nope' },
] } }, tokD, 'dev1');
{
  const d4 = docItem('d4'), d5 = docItem('d5'), d6 = docItem('d6'), d7 = docItem('d7'), dn1 = docItem('dn1'), d1 = docItem('d1'), d3 = docItem('d3');
  T('재구성: 못 보는 문서 scope 확장 시도(d4 mgmt→all) 원본 유지', r.code === 200 && d4 && d4.scope === 'mgmt', JSON.stringify(d4));
  T('재구성: 01 법인(d5) cat 위장 → 원본 유지', d5 && d5.cat === '01' && d5.title === '법인 등기');
  T('재구성: 숨김 구건(d6 del:1 hidden_tmp:1) 소프트 삭제 그대로 보존(영구 삭제 아님)', d6 && d6.del === 1 && d6.hidden_tmp === 1, JSON.stringify(d6));
  T('재구성: 타인 대기 문서(d7) 등재 격상·등재자 바꿔치기 원복', d7 && d7.status === '대기' && d7.by.id === 'udocw2', JSON.stringify(d7));
  T('재구성: 신규 문서 status 등재 위조 → 대기 + 등재자=저장자 스탬프 + 무효 scope 제거', dn1 && dn1.status === '대기' && dn1.by.id === 'udocw' && !dn1.registered_by && dn1.scope === undefined, JSON.stringify(dn1));
  T('재구성: 보이는 기존 문서의 scope 변경(d1 admin·d3 ids 확장)도 원본 고정(med1 — 내용 편집만)', d1 && d1.scope === undefined && d3 && d3.scope.ids.length === 1 && d3.scope.ids[0] === 'udocw', JSON.stringify([d1 && d1.scope, d3 && d3.scope]));
  const ap = docAppr('dn1');
  T('직원 등재 → 결재함 문서함 등재 카드 자동 상신(by=직원·cid docreg-dn1·① to pm·본문 공개범위)', ap.length === 1 && ap[0].by.id === 'udocw' && ap[0].cid === 'docreg-dn1' && ap[0].grade === 1 && ap[0].to === 'pm' && ap[0].status === '대기' && ap[0].body.indexOf('공개범위') >= 0, JSON.stringify(ap).slice(0, 200));
  T('상신 푸시: 결재 요청(PM 큐)', pushMock.calls.length && pushMock.calls[pushMock.calls.length - 1].title.indexOf('결재 요청: 신규 직원문서') === 0, JSON.stringify(pushMock.calls[pushMock.calls.length - 1]));
}
// 멱등: 같은 사본 재저장(응답 유실 재시도 흉내 + status 위조) → 카드 1건 유지·상태 대기 유지
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1'].indexOf(x.id) >= 0).map((x) => Object.assign({}, x, { status: '등재' })) } }, tokD, 'dev1');
T('멱등: 재저장에도 카드 1건·본인 대기 문서 등재 위조 원복', r.code === 200 && docAppr('dn1').length === 1 && docItem('dn1').status === '대기', docAppr('dn1').length + '/' + docItem('dn1').status);
r = await call({ action: 'get', collection: 'documents' }, tokD2, 'dev1');
T('대기 문서는 타인에게 비노출(직원2 → dn1 없음, 본인 d7만)', r.code === 200 && docIds(r) === 'd1,d2,d7', docIds(r));
r = await call({ action: 'get', collection: 'documents' }, tokD, 'dev1');
T('대기 문서는 등재 본인에게 노출(문서직원 → dn1)', r.code === 200 && docIds(r) === 'd1,d2,d3,dn1', docIds(r));
// 승인 → 등재(등재자 기록·감사로그), 반려 → 반려(사유)
let dnAp = docAppr('dn1')[0];
r = await call({ action: 'approval_decide', id: dnAp.id, decision: '승인' }, tokA);
{
  const dn1 = docItem('dn1');
  T('승인 → 문서 등재(registered_by=결재자·감사로그 등재)', r.code === 200 && dn1.status === '등재' && dn1.registered_by.id === 'uadmin' && !!dn1.registered_at && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '등재' && l.ev[0].id === 'dn1'), JSON.stringify(dn1));
}
r = await call({ action: 'get', collection: 'documents' }, tokD2, 'dev1');
T('등재 후에도 분류 기본(06 관리자만) → 직원2 비노출', r.code === 200 && docIds(r).indexOf('dn1') < 0, docIds(r));
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1'].indexOf(x.id) >= 0).concat([{ id: 'dn2', title: '반려될 문서', cat: '05' }]) } }, tokD, 'dev1');
dnAp = docAppr('dn2')[0];
T('두 번째 등재 → 카드 상신', r.code === 200 && dnAp && dnAp.cid === 'docreg-dn2' && docItem('dn2').status === '대기');
r = await call({ action: 'approval_decide', id: dnAp.id, decision: '반려', reason: '보완 필요' }, tokA);
{
  const dn2 = docItem('dn2');
  T('반려 → 문서 반려 + 사유 + 감사로그 등재반려', r.code === 200 && dn2.status === '반려' && dn2.reject_reason === '보완 필요' && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '등재반려'), JSON.stringify(dn2));
}
// 재상신: 본인 반려 건 반려→대기·reg_n 2 → 새 cid 카드. 타인(직원2)은 못 보는 문서라 손댈 수 없음
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd7'].indexOf(x.id) >= 0).concat([Object.assign({}, docItem('dn2'), { status: '대기', reg_n: 2 })]) } }, tokD2, 'dev1');
T('타인의 반려 문서 재상신 시도 → 서버 원본 유지(반려)', r.code === 200 && docItem('dn2').status === '반려' && docAppr('dn2').length === 1);
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1'].indexOf(x.id) >= 0).concat([Object.assign({}, docItem('dn2'), { status: '대기', reg_n: 2, title: '보완한 문서' })]) } }, tokD, 'dev1');
{
  const dn2 = docItem('dn2'), aps = docAppr('dn2');
  T('본인 재상신 → 대기·reg_n 2·사유 제거 + 새 cid(docreg-dn2-2) 카드', r.code === 200 && dn2.status === '대기' && dn2.reg_n === 2 && !dn2.reject_reason && aps.length === 2 && aps.some((a) => a.cid === 'docreg-dn2-2' && a.status === '대기'), JSON.stringify(aps.map((a) => a.cid + ':' + a.status)));
}
r = await call({ action: 'approval_decide', id: docAppr('dn2').find((a) => a.cid === 'docreg-dn2-2').id, decision: '승인' }, tokA);
T('재상신 카드 승인 → 등재', r.code === 200 && docItem('dn2').status === '등재');
// 폴 재시도: decide 시점 문서 반영 실패를 흉내(카드만 승인 상태) → 관리자 approvals_list가 멱등 반영. 구 카드(cid 불일치)는 무시
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1', 'dn2'].indexOf(x.id) >= 0).concat([{ id: 'dn3', title: '폴 재시도 문서', cat: '06' }]) } }, tokD, 'dev1');
{
  const ap3 = docAppr('dn3')[0];
  ap3.status = '승인'; ap3.decided_by = { id: 'uadmin', name: '관리자' }; ap3.decided_at = new Date().toISOString();   // 결재는 확정됐는데 문서 반영이 빠진 상태
  mem.gw_data['col:approvals'].items.push({ id: 'apstale', kind: '문서함 등재', ref: 'doc:dn3', cid: 'docreg-dn3-9', status: '반려', reason: '구 카드', decided_by: { id: 'uadmin', name: '관리자' }, decided_at: new Date().toISOString(), by: { id: 'udocw', name: '문서직원' } });
  r = await call({ action: 'approvals_list' }, tokD, 'dev1');
  T('비관리자 폴은 문서 반영 안 함(dn3 대기 유지)', r.code === 200 && docItem('dn3').status === '대기');
  r = await call({ action: 'approvals_list' }, tokA);
  T('관리자 폴 → 미반영 승인 건 재시도 반영(dn3 등재), cid 불일치 구 카드(반려)는 무시', r.code === 200 && docItem('dn3').status === '등재', JSON.stringify(docItem('dn3')));
}
// gate none: 직원 등재 즉시 등재·카드 없음
r = await call({ action: 'doc_settings_get' }, tokA);
r = await call({ action: 'doc_settings_set', register_gate: 'none', base: r.body.updated_at }, tokA);
T('설정: 등재 결재 none', r.code === 200 && r.body.settings.register_gate === 'none');
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1', 'dn2', 'dn3'].indexOf(x.id) >= 0).concat([{ id: 'dn4', title: '즉시 등재 문서', cat: '06' }]) } }, tokD, 'dev1');
{
  const dn4 = docItem('dn4');
  T('gate none: 직원 등재 → 즉시 등재(registered_by=본인)·카드 없음', r.code === 200 && dn4.status === '등재' && dn4.registered_by.id === 'udocw' && docAppr('dn4').length === 0, JSON.stringify(dn4));
}
r = await call({ action: 'doc_settings_get' }, tokA);
r = await call({ action: 'doc_settings_set', register_gate: 'staff', base: r.body.updated_at }, tokA);
// 관리자: 신규는 status 없어도 즉시 등재(PM 전결), scope 정규화, 기존 문서 상태는 클라 값 그대로(무제한)
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.concat([{ id: 'dn5', title: '관리자 문서', cat: '02', scope: { ids: [1, 'udocw2', 'udocw2'] } }]) } }, tokA);
{
  const dn5 = docItem('dn5');
  T('관리자 신규 → 즉시 등재(registered_by 관리자)·scope ids 정규화·카드 없음', r.code === 200 && dn5.status === '등재' && dn5.registered_by.id === 'uadmin' && dn5.scope.ids.length === 1 && dn5.scope.ids[0] === 'udocw2' && docAppr('dn5').length === 0, JSON.stringify(dn5));
}
r = await call({ action: 'get', collection: 'documents' }, tokD2, 'dev1');
T('지정 직원 공개(dn5 ids udocw2) → 직원2 열람, 문서직원은 제외', r.code === 200 && docIds(r).indexOf('dn5') >= 0 && ((await call({ action: 'get', collection: 'documents' }, tokD, 'dev1')).body.doc.items || []).every((x) => x.id !== 'dn5'), docIds(r));

// 20 문서함 적대 검증 7건 재현(9/4): med1 비관리자 기존 문서 scope·cat 고정 / med2 상신 실패 고착 → 관리자 폴 반대 방향 복구 / med3 01 위장 소실 방지
//    / low4 재상신은 reg_n+1 명시 신호만 / low6 01 이동 문서 본인 비노출 / low7 대기 아닌 문서에 뒤늦은 반려 무시·승인 시 반려 잔존 정리
const MGMT2 = { id: 'umgmt2', name: '관리부수행', admin: false, dept: '관리부', perms: { doc: 'do' } };
mem.gw_users['member:umgmt2'] = MGMT2;
const tokM2 = issueSession(MGMT2).token;
const docVisibleTo = async (tok) => ((await call({ action: 'get', collection: 'documents' }, tok, 'dev1')).body.doc.items || []);
// med1: 관리부원(doc 수행)이 보이는 문서 d4(mgmt)를 all로, cat 06→02, no 변경, d2 scope를 ids로 축소·확장 시도 → 전부 원본 유지, 내용(title)만 반영
mem.gw_data['col:documents'].items.push({ id: 'd8', title: 'JW-06-001 양식(cat 없음)', no: 'JW-06-001', scope: 'all' });
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokM2)).map((x) => {
  if (x.id === 'd4') return Object.assign({}, x, { scope: 'all', cat: '02', no: 'JW-02-999', title: '양식 관리부(내용 수정)' });
  if (x.id === 'd2') return Object.assign({}, x, { scope: { ids: ['udocw2', 'umgmt2'] } });
  return x;
}) } }, tokM2, 'dev1');
{
  const d4 = docItem('d4'), d2 = docItem('d2');
  T('med1: 관리부원 scope mgmt→all·cat 06→02·no 변경 전송 → 서버 원본 유지(scope mgmt·cat 06·no 없음), 제목 수정만 반영', r.code === 200 && d4 && d4.scope === 'mgmt' && d4.cat === '06' && d4.no === undefined && d4.title === '양식 관리부(내용 수정)', JSON.stringify(d4));
  T('med1: 보이는 문서 scope all→ids 변경 전송 → 원본(all) 유지', d2 && d2.scope === 'all', JSON.stringify(d2 && d2.scope));
}
r = await docVisibleTo(tokW);
T('med1: 무결재 노출 없음 — 일반 직원에게 d4 여전히 비노출', r.every((x) => x.id !== 'd4'), r.map((x) => x.id).join(','));
// med3: 보이는 문서를 cat '01'로 보내거나(기존) 신규를 01로 올리면 → 기존은 원본 유지(소실 0), 신규는 폐기+감사로그 '제거'. cat 없는 구건 d8은 no를 JW-01로 바꿔도 06 명시 고정
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => {
  if (x.id === 'd2') return Object.assign({}, x, { cat: '01' });
  if (x.id === 'd8') return Object.assign({}, x, { no: 'JW-01-001', title: 'JW-01-001 법인으로 위장' });
  return x;
}).concat([{ id: 'dz01', title: '신규 01 위장', cat: '01' }]) } }, tokD, 'dev1');
{
  const d2 = docItem('d2'), d8 = docItem('d8');
  T('med3: 기존 문서 cat 01 전송 → 원본(03) 유지·소실 0', r.code === 200 && d2 && d2.cat === '03' && d2.title === '안전보건 수칙', JSON.stringify(d2));
  T('med3: cat 없는 구건 no를 JW-01로 바꿔도 분류 06 명시 고정·no 원본', d8 && d8.cat === '06' && d8.no === 'JW-06-001', JSON.stringify(d8));
  T('med3: 신규 01 위장 → 폐기 + 감사로그 제거', !docItem('dz01') && auditMock.logs.some((l) => l.col === 'documents' && l.ev.some((e) => e.op === '제거' && e.id === 'dz01')));
  T('med3: 전체 건수 보존(d1~d8·dn1~dn5 = 13건)', mem.gw_data['col:documents'].items.length === 13, String(mem.gw_data['col:documents'].items.length));
}
// low4: 반려 건을 '대기' 사본(reg_n 없음)으로 편집 전송 → 반려·사유 유지·카드 없음 / reg_n+1 전송 → 재상신
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).concat([{ id: 'dn6', title: '반려 후 편집 문서', cat: '05' }]) } }, tokD, 'dev1');
r = await call({ action: 'approval_decide', id: docAppr('dn6')[0].id, decision: '반려', reason: '표지 누락' }, tokA);
T('low4 준비: dn6 반려', r.code === 200 && docItem('dn6').status === '반려');
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => x.id === 'dn6' ? Object.assign({}, x, { status: '대기', title: '반려 전 사본으로 편집' }) : x) } }, tokD, 'dev1');
{
  const dn6 = docItem('dn6');
  T('low4: 낡은 대기 사본 편집 전송(reg_n 없음) → 반려·사유 유지·카드 추가 없음, 제목 편집만 반영', r.code === 200 && dn6.status === '반려' && dn6.reject_reason === '표지 누락' && docAppr('dn6').length === 1 && dn6.title === '반려 전 사본으로 편집', JSON.stringify(dn6));
}
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => x.id === 'dn6' ? Object.assign({}, x, { status: '대기', reg_n: 5 }) : x) } }, tokD, 'dev1');
T('low4: reg_n을 +1이 아닌 값(5)으로 전송 → 재상신 아님(반려 유지)', r.code === 200 && docItem('dn6').status === '반려' && docAppr('dn6').length === 1);
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => x.id === 'dn6' ? Object.assign({}, x, { status: '대기', reg_n: 2 }) : x) } }, tokD, 'dev1');
T('low4: reg_n 정확히 +1 전송 → 재상신(대기·reg_n 2·새 카드)', r.code === 200 && docItem('dn6').status === '대기' && docItem('dn6').reg_n === 2 && docAppr('dn6').some((a) => a.cid === 'docreg-dn6-2'));
r = await call({ action: 'approval_decide', id: docAppr('dn6').find((a) => a.cid === 'docreg-dn6-2').id, decision: '승인' }, tokA);
{
  const dn6 = docItem('dn6');
  T('low7(정리): 재상신 승인 → 등재 + reject_reason·rejected_at 잔존 없음', r.code === 200 && dn6.status === '등재' && dn6.reject_reason === undefined && dn6.rejected_at === undefined, JSON.stringify(dn6));
}
// med2: 상신 실패 고착(approvals 블롭 읽기 실패 흉내) → 문서 대기·카드 0·register_warn → 관리자 approvals_list가 반대 방향 복구(카드 1·기안자=직원)
{
  const savedAppr = mem.gw_data['col:approvals'];
  delete mem.gw_data['col:approvals'];
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).concat([{ id: 'dn7', title: '상신 실패 문서', cat: '06' }]) } }, tokD, 'dev1');
  mem.gw_data['col:approvals'] = savedAppr;
  T('med2: 상신 실패 → 저장은 성공(대기)·register_warn 1·카드 0·감사로그 등재상신실패', r.code === 200 && r.body.register_warn === 1 && docItem('dn7').status === '대기' && docAppr('dn7').length === 0 && auditMock.logs.some((l) => l.ev.some((e) => e.op === '등재상신실패' && e.id === 'dn7')), JSON.stringify(r.body));
  r = await call({ action: 'approvals_list' }, tokD2, 'dev1');
  T('med2: 비관리자 폴은 복구 안 함(카드 0 유지)', r.code === 200 && docAppr('dn7').length === 0);
  r = await call({ action: 'approvals_list' }, tokA);
  const ap7 = docAppr('dn7');
  T('med2: 관리자 폴 → 카드 생성(cid docreg-dn7·기안자=등재 직원·① PM 큐) + 응답에 즉시 포함 + 감사로그 등재상신복구', r.code === 200 && ap7.length === 1 && ap7[0].cid === 'docreg-dn7' && ap7[0].by.id === 'udocw' && ap7[0].to === 'pm' && r.body.items.some((x) => x.id === ap7[0].id) && auditMock.logs.some((l) => l.ev.some((e) => e.op === '등재상신복구' && e.id === 'dn7')), JSON.stringify(ap7).slice(0, 200));
  r = await call({ action: 'approvals_list' }, tokA);
  T('med2: 재폴 멱등(카드 1건 유지)', r.code === 200 && docAppr('dn7').length === 1);
}
// low6: 관리자가 직원 문서(dn1 by udocw, 등재)를 01로 옮김 → 그 직원 get에서 미노출
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.map((x) => x.id === 'dn1' ? Object.assign({}, x, { cat: '01' }) : x) } }, tokA);
r = await docVisibleTo(tokD);
T('low6: 01로 옮긴 본인 문서 → 등재자에게도 비노출(01 하드차단이 본인 예외보다 앞)', r.every((x) => x.id !== 'dn1') && docItem('dn1').cat === '01', r.map((x) => x.id).join(','));
// low7: 대기 아닌 문서(dn3 등재)에 현재 cid와 같은 뒤늦은 반려 카드 → 폴에서 무시(등재 유지)
mem.gw_data['col:approvals'].items.push({ id: 'aplate', kind: '문서함 등재', ref: 'doc:dn3', cid: 'docreg-dn3', status: '반려', reason: '늦은 반려', decided_by: { id: 'uadmin', name: '관리자' }, decided_at: new Date().toISOString(), by: { id: 'udocw', name: '문서직원' } });
r = await call({ action: 'approvals_list' }, tokA);
T('low7: 이미 등재된 문서에 같은 cid의 뒤늦은 반려 → 무시(등재 유지·사유 없음)', r.code === 200 && docItem('dn3').status === '등재' && docItem('dn3').reject_reason === undefined, JSON.stringify(docItem('dn3')));

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n서버 테스트 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
