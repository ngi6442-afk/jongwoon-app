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
  { id: 'd1', title: '취업규칙', cat: '02-01' },   // v317 2층 cat 'AA-BB' — 공개범위 설정 키는 대분류 AA
  { id: 'd2', title: '안전보건 수칙', cat: '03-01', scope: 'all' },
  { id: 'd3', title: '규정 지정공개', cat: '05-01', scope: { ids: ['udocw'] } },
  { id: 'd4', title: '양식 관리부', cat: '06-03', scope: 'mgmt' },
  { id: 'd5', title: '법인 등기', cat: '01-03' },
  { id: 'd6', title: '임시 숨김', cat: '06-03', del: 1, hidden_tmp: 1 },
  { id: 'd7', title: '타인 대기', cat: '06-03', status: '대기', by: { id: 'udocw2', name: '직원2' }, scope: 'all' },
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
  { id: 'd1', title: '취업규칙', cat: '02-01', scope: 'admin' },
  { id: 'd2', title: '안전보건 수칙', cat: '03-01', scope: 'all' },
  { id: 'd3', title: '규정 지정공개', cat: '05-01', scope: { ids: ['udocw', 'udocw', 7] } },
  { id: 'd4', title: '양식 관리부', cat: '06-03', scope: 'all' },
  { id: 'd5', title: '법인 등기 위장', cat: '06-03' },
  { id: 'd7', title: '타인 대기', cat: '06-03', status: '등재', by: { id: 'udocw', name: '문서직원' }, scope: 'all' },
  { id: 'dn1', title: '신규 직원문서', cat: '06-03', status: '등재', by: { id: 'uadmin', name: '관리자' }, registered_by: { id: 'uadmin' }, scope: 'nope' },
] } }, tokD, 'dev1');
{
  const d4 = docItem('d4'), d5 = docItem('d5'), d6 = docItem('d6'), d7 = docItem('d7'), dn1 = docItem('dn1'), d1 = docItem('d1'), d3 = docItem('d3');
  T('재구성: 못 보는 문서 scope 확장 시도(d4 mgmt→all) 원본 유지', r.code === 200 && d4 && d4.scope === 'mgmt', JSON.stringify(d4));
  T('재구성: 01 법인(d5) cat 위장 → 원본 유지', d5 && d5.cat === '01-03' && d5.title === '법인 등기');
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
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1'].indexOf(x.id) >= 0).concat([{ id: 'dn2', title: '반려될 문서', cat: '05-01' }]) } }, tokD, 'dev1');
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
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1', 'dn2'].indexOf(x.id) >= 0).concat([{ id: 'dn3', title: '폴 재시도 문서', cat: '06-03' }]) } }, tokD, 'dev1');
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
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.filter((x) => ['d1', 'd2', 'd3', 'dn1', 'dn2', 'dn3'].indexOf(x.id) >= 0).concat([{ id: 'dn4', title: '즉시 등재 문서', cat: '06-03' }]) } }, tokD, 'dev1');
{
  const dn4 = docItem('dn4');
  T('gate none: 직원 등재 → 즉시 등재(registered_by=본인)·카드 없음', r.code === 200 && dn4.status === '등재' && dn4.registered_by.id === 'udocw' && docAppr('dn4').length === 0, JSON.stringify(dn4));
}
r = await call({ action: 'doc_settings_get' }, tokA);
r = await call({ action: 'doc_settings_set', register_gate: 'staff', base: r.body.updated_at }, tokA);
// 관리자: 신규는 status 없어도 즉시 등재(PM 전결), scope 정규화, 기존 문서 상태는 클라 값 그대로(무제한)
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.concat([{ id: 'dn5', title: '관리자 문서', cat: '02-01', scope: { ids: [1, 'udocw2', 'udocw2'] } }]) } }, tokA);
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
mem.gw_data['col:documents'].items.push({ id: 'd8', title: 'JW-06-03-001 양식(cat 없음)', no: 'JW-06-03-001', scope: 'all' });
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokM2)).map((x) => {
  if (x.id === 'd4') return Object.assign({}, x, { scope: 'all', cat: '02-01', no: 'JW-02-01-999', title: '양식 관리부(내용 수정)' });
  if (x.id === 'd2') return Object.assign({}, x, { scope: { ids: ['udocw2', 'umgmt2'] } });
  return x;
}) } }, tokM2, 'dev1');
{
  const d4 = docItem('d4'), d2 = docItem('d2');
  T('med1: 관리부원 scope mgmt→all·cat 06-03→02-01·no 변경 전송 → 서버 원본 유지(scope mgmt·cat 06-03·no 없음), 제목 수정만 반영', r.code === 200 && d4 && d4.scope === 'mgmt' && d4.cat === '06-03' && d4.no === undefined && d4.title === '양식 관리부(내용 수정)', JSON.stringify(d4));
  T('med1: 보이는 문서 scope all→ids 변경 전송 → 원본(all) 유지', d2 && d2.scope === 'all', JSON.stringify(d2 && d2.scope));
}
r = await docVisibleTo(tokW);
T('med1: 무결재 노출 없음 — 일반 직원에게 d4 여전히 비노출', r.every((x) => x.id !== 'd4'), r.map((x) => x.id).join(','));
// med3: 보이는 문서를 cat '01-03'로 보내거나(기존) 신규를 01로 올리면 → 기존은 원본 유지(소실 0), 신규는 폐기+감사로그 '제거'. cat 없는 구건 d8은 no를 JW-01-03으로 바꿔도 06-03 명시 고정
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => {
  if (x.id === 'd2') return Object.assign({}, x, { cat: '01-03' });
  if (x.id === 'd8') return Object.assign({}, x, { no: 'JW-01-03-001', title: 'JW-01-03-001 법인으로 위장' });
  return x;
}).concat([{ id: 'dz01', title: '신규 01 위장', cat: '01-03' }, { id: 'dz02', title: '신규 01 위장(번호 파생)', no: 'JW-01-01-002' }, { id: 'dz03', title: '신규 구 cat 01 위장', cat: '01', no: 'JW-01-002' }]) } }, tokD, 'dev1');
{
  const d2 = docItem('d2'), d8 = docItem('d8');
  T('med3: 기존 문서 cat 01-03 전송 → 원본(03-01) 유지·소실 0', r.code === 200 && d2 && d2.cat === '03-01' && d2.title === '안전보건 수칙', JSON.stringify(d2));
  T('med3: cat 없는 구건 no를 JW-01-03으로 바꿔도 분류 06-03 명시 고정·no 원본', d8 && d8.cat === '06-03' && d8.no === 'JW-06-03-001', JSON.stringify(d8));
  T('med3: 신규 01 위장(cat 01-03 / no JW-01-01-002 파생 / 구 cat 01+구형식 번호) 3건 전부 폐기 + 감사로그 제거', !docItem('dz01') && !docItem('dz02') && !docItem('dz03') && ['dz01', 'dz02', 'dz03'].every((id) => auditMock.logs.some((l) => l.col === 'documents' && l.ev.some((e) => e.op === '제거' && e.id === id))));
  T('med3: 전체 건수 보존(d1~d8·dn1~dn5 = 13건)', mem.gw_data['col:documents'].items.length === 13, String(mem.gw_data['col:documents'].items.length));
}
// low4: 반려 건을 '대기' 사본(reg_n 없음)으로 편집 전송 → 반려·사유 유지·카드 없음 / reg_n+1 전송 → 재상신
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).concat([{ id: 'dn6', title: '반려 후 편집 문서', cat: '05-01' }]) } }, tokD, 'dev1');
T('결재 카드(문서함 등재) 본문: 2층 분류 라벨 "분류 05-01 차량·장비 · 규정·기준"(v317)', docAppr('dn6').length === 1 && String(docAppr('dn6')[0].body || '').indexOf('분류 05-01 차량·장비 · 규정·기준') >= 0, String(docAppr('dn6')[0] && docAppr('dn6')[0].body));
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
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).concat([{ id: 'dn7', title: '상신 실패 문서', cat: '06-03' }]) } }, tokD, 'dev1');
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
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.map((x) => x.id === 'dn1' ? Object.assign({}, x, { cat: '01-03' }) : x) } }, tokA);
r = await docVisibleTo(tokD);
T('low6: 01-03으로 옮긴 본인 문서 → 등재자에게도 비노출(01 하드차단이 본인 예외보다 앞)', r.every((x) => x.id !== 'dn1') && docItem('dn1').cat === '01-03', r.map((x) => x.id).join(','));
// low7: 대기 아닌 문서(dn3 등재)에 현재 cid와 같은 뒤늦은 반려 카드 → 폴에서 무시(등재 유지)
mem.gw_data['col:approvals'].items.push({ id: 'aplate', kind: '문서함 등재', ref: 'doc:dn3', cid: 'docreg-dn3', status: '반려', reason: '늦은 반려', decided_by: { id: 'uadmin', name: '관리자' }, decided_at: new Date().toISOString(), by: { id: 'udocw', name: '문서직원' } });
r = await call({ action: 'approvals_list' }, tokA);
T('low7: 이미 등재된 문서에 같은 cid의 뒤늦은 반려 → 무시(등재 유지·사유 없음)', r.code === 200 && docItem('dn3').status === '등재' && docItem('dn3').reject_reason === undefined, JSON.stringify(docItem('dn3')));

// 21 직접 기안·전결 종결(v315): 비대표 관리자 ① self_decide = 생성+승인 한 쓰기(승인·decided_by 본인·chain 전결·감사로그 전결·푸시 0·큐 미노출)
//    / 직원·대표·②·③·격상·미정·제외 종류 → 400(카드 미생성) / cid 멱등 / approvals_list grades 동봉 / 상신만은 기존 라우팅 / 총정리 집계 포함
mem.gw_data['col:approvals'] = { schema: 1, items: [], updated_at: 0 };
mem.gw_data['col:documents'] = { schema: 1, items: [{ id: 'd1', title: '취업규칙', cat: '02-01', status: '등재' }], updated_at: 100 };   // 대기 문서 0 — 관리자 폴의 등재상신복구(med2)가 이 절의 카드 수를 흔들지 않게
const apprN = () => mem.gw_data['col:approvals'].items.length;
let pushN0 = pushMock.calls.length;
r = await call({ action: 'approval_create', kind: '사규', title: '취업규칙 개정 결재', body: '본문', ref: 'doc:d1', cid: 'sd-1', self_decide: true }, tokA);
const sdId = r.body.id;
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === sdId);
  T('전결 종결: PM ① → 200 decided 승인 · status 승인·decided_by 본인·decided_at=created·self_decided·grade1·chain 전결', r.code === 200 && r.body.decided === '승인' && it && it.status === '승인' && it.decided_by.id === 'uadmin' && it.decided_at === it.created && it.self_decided === true && it.grade === 1 && it.to === 'pm' && it.ref === 'doc:d1' && it.chain.length === 1 && it.chain[0].decision === '전결', JSON.stringify(it).slice(0, 240));
  T('전결 종결: 감사로그 전결 1건(상신 없음) · 푸시 0(본인 결재)', auditMock.logs.some((l) => l.col === 'approvals' && l.ev[0].op === '전결' && l.ev[0].id === sdId) && !auditMock.logs.some((l) => l.col === 'approvals' && l.ev[0].op === '상신' && l.ev[0].id === sdId) && pushMock.calls.length === pushN0, '푸시 +' + (pushMock.calls.length - pushN0));
}
r = await call({ action: 'approval_create', kind: '사규', title: '재시도(응답 유실)', cid: 'sd-1', self_decide: true }, tokA);
T('전결 종결: cid 멱등 재시도 → 같은 id·dedup·decided 승인·카드 1건', r.code === 200 && r.body.id === sdId && r.body.dedup === true && r.body.decided === '승인' && apprN() === 1, JSON.stringify(r.body));
r = await call({ action: 'approvals_list' }, tokA);
T('approvals_list(관리자): grades 동봉 + 전결 건은 승인 상태(대기 큐 아님)', r.code === 200 && r.body.grades && r.body.grades['사규'] === 1 && r.body.items.some((x) => x.id === sdId && x.status === '승인') && !r.body.items.some((x) => x.status === '대기'), JSON.stringify(r.body.grades).slice(0, 80));
r = await call({ action: 'approvals_list' }, tokW, 'dev1');
T('approvals_list(직원): grades 동봉(표시용)', r.code === 200 && r.body.grades && r.body.grades['지시'] === 1 && r.body.grades['운반일지'] === 3);
r = await call({ action: 'approval_create', kind: '사규', title: '직원 전결 시도', self_decide: true }, tokW, 'dev1');
T('전결 종결: 직원 → 400 SELF_DECIDE_PM_ONLY', r.code === 400 && r.body.error_code === 'SELF_DECIDE_PM_ONLY', r.code + '/' + r.body.error_code);
r = await call({ action: 'approval_create', kind: '사규', title: '대표 전결 시도', self_decide: true }, tokB, 'dev1');
T('전결 종결: 대표 → 400 SELF_DECIDE_PM_ONLY(대표는 기안 대상 아님)', r.code === 400 && r.body.error_code === 'SELF_DECIDE_PM_ONLY');
r = await call({ action: 'approval_create', kind: '사직·휴직', title: '② 전결 시도', self_decide: true }, tokA);
T('전결 종결: ② → 400 SELF_DECIDE_GRADE1_ONLY', r.code === 400 && r.body.error_code === 'SELF_DECIDE_GRADE1_ONLY');
r = await call({ action: 'approval_create', kind: '지입료', title: '③ 전결 시도', self_decide: true }, tokA);
T('전결 종결: ③ → 400 SELF_DECIDE_GRADE1_ONLY', r.code === 400 && r.body.error_code === 'SELF_DECIDE_GRADE1_ONLY');
r = await call({ action: 'approval_create', kind: '사규', title: '격상 + 전결', boss_up: 1, self_decide: true }, tokA);
T('전결 종결: ① 격상(대표 상신 토글) → 400 GRADE1_ONLY', r.code === 400 && r.body.error_code === 'SELF_DECIDE_GRADE1_ONLY');
r = await call({ action: 'approval_create', kind: '일반', title: '등급 미정 전결', self_decide: true }, tokA);
T('전결 종결: 등급 미정 kind → 400 GRADE1_ONLY', r.code === 400 && r.body.error_code === 'SELF_DECIDE_GRADE1_ONLY');
r = await call({ action: 'approval_create', kind: '문서함 등재', title: '제외 종류', self_decide: true }, tokA);
T('전결 종결: 문서함 등재(전용 경로) → 400 SELF_DECIDE_KIND', r.code === 400 && r.body.error_code === 'SELF_DECIDE_KIND');
r = await call({ action: 'approval_create', kind: '지시', title: '지시 전결 시도', self_decide: true }, tokA);
T('전결 종결: 지시(지시 탭 전용) → 400 SELF_DECIDE_KIND(low8)', r.code === 400 && r.body.error_code === 'SELF_DECIDE_KIND');
r = await call({ action: 'approval_create', kind: '휴가', title: '제외 종류', self_decide: true }, tokA);
T('전결 종결: 휴가(모듈 승인) → 400 SELF_DECIDE_KIND', r.code === 400 && r.body.error_code === 'SELF_DECIDE_KIND');
r = await call({ action: 'approval_create', kind: '운반일지', title: '제외 종류', ref: 'ab:2026-09-01', self_decide: true }, tokA);
T('전결 종결: 운반일지 → 400 SELF_DECIDE_KIND', r.code === 400 && r.body.error_code === 'SELF_DECIDE_KIND');
T('전결 종결 거부 9건 모두 카드 미생성(1건 유지)', apprN() === 1, String(apprN()));
pushN0 = pushMock.calls.length;
r = await call({ action: 'approval_create', kind: '사규', title: '상신만', ref: 'doc:d1' }, tokA);
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === r.body.id);
  T('[상신만](self_decide 없음): 기존 라우팅 — 대기·to pm·self_decided 없음·결재 요청 푸시 1', r.code === 200 && !r.body.decided && it && it.status === '대기' && it.to === 'pm' && !it.self_decided && pushMock.calls.length === pushN0 + 1, JSON.stringify(it).slice(0, 160));
}
r = await call({ action: 'approval_create', kind: '가족친화', title: '직원 ① 상신', self_decide: false }, tokW, 'dev1');
T('직원 기안 ①: PM 큐 대기(전결 아님)', r.code === 200 && mem.gw_data['col:approvals'].items.find((x) => x.id === r.body.id).status === '대기');
// 총정리 집계: 전결 건의 decided_at을 전월(8월 KST)로 옮기고 크론 실행 → ids에 포함(grade1+승인+decided_at 기준이라 별도 로직 없이 잡혀야 한다)
{
  const it = mem.gw_data['col:approvals'].items.find((x) => x.id === sdId);
  it.created = '2026-08-20T05:00:00.000Z'; it.decided_at = '2026-08-20T05:00:00.000Z';
  cr = await apprCron.runSummary('gw_data', KST_SEP1);
  const sum = mem.gw_data['col:approvals'].items.find((x) => x.id === 'summary-2026-08');
  T('총정리 크론: 전결 종결 건 집계 포함(ids·counts 사규 1)', cr.ok && sum && sum.summary.ids.indexOf(sdId) >= 0 && sum.summary.counts['사규'] === 1, JSON.stringify(cr) + ' / ' + (sum && JSON.stringify(sum.summary).slice(0, 160)));
}

// 22 문서함 파일 첨부(v315): 올리기 권한(관리자·등재 본인·doc 수행) / 확장자·매직바이트·크기 한도 / mime 고정표(high1) / 열기=docVisible(공개범위·타인 대기 404)
//    / save 재구성 files 원본 고정(위조·삭제 무시)·관리자 직전 읽기 실패 500(med2) / 삭제 관리자 전용(메타·바이트 제거)·att_seq 단조 증가(low4·low7) / att_parse 프리픽스(low6)
//    / 일괄 등재(관리자·cid 멱등·항목당 1~3·합계 5.5MB·확장자·매직·제목·항목 상한·2층 분류 cat 73키)
mem.gw_data['col:documents'] = { schema: 1, items: [
  { id: 'f1', title: '관리자 문서', cat: '02-01', scope: 'all', status: '등재' },
  { id: 'f2', title: '직원 대기 문서', cat: '06-03', status: '대기', by: { id: 'udocw', name: '문서직원' } },
  { id: 'f3', title: '비공개 문서', cat: '05-01', status: '등재' },
  { id: 'f4', title: '삭제 문서', cat: '06-03', del: 1 },
  { id: 'f5', title: '구건(카운터 없음·n 2 잔존)', cat: '06-03', scope: 'all', status: '등재', files: [{ n: 2, name: '구.pdf', size: 1, mime: 'application/pdf', ts: 1, by: { id: 'uadmin', name: '관리자' } }] },
  { id: 'f6', title: '카운터만 남은 문서', cat: '06-03', scope: 'all', status: '등재', att_seq: 5 },
], updated_at: 100 };
mem.gw_files = { 'docatt:f5:2': { name: '구.pdf', type: 'application/pdf', data: 'JVBERi0=' } };
// 매직바이트가 맞는 최소 페이로드 — 서버가 확장자와 내용을 대조한다(high1)
const b64of = (x) => Buffer.from(x).toString('base64');
const PDF = b64of('%PDF-1.4 hello!!');                                                   // 16바이트
const PNG = b64of(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]));
const JPG = b64of(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]));
const ZIP = b64of('PK office-ooxml-or-hwpx');
const HWP = b64of(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]));
const HTML = b64of('<html><script>alert(1)</script>');
const fdoc = (id) => mem.gw_data['col:documents'].items.find((x) => x && x.id === id);
r = await call({ action: 'doc_att_put', id: 'f1', name: '취업규칙.pdf', mime: 'text/html', data: PDF }, tokA);
T('첨부: 관리자 → 200 n=1 · files 메타(name·size·by) · gw_files docatt:f1:1 · 감사로그 첨부', r.code === 200 && r.body.n === 1 && r.body.files.length === 1 && fdoc('f1').files.length === 1 && fdoc('f1').files[0].name === '취업규칙.pdf' && fdoc('f1').files[0].size === 16 && fdoc('f1').files[0].by.id === 'uadmin' && mem.gw_files['docatt:f1:1'] && mem.gw_files['docatt:f1:1'].data === PDF && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '첨부' && l.ev[0].id === 'f1'), JSON.stringify(r.body).slice(0, 200));
T('high1: 클라 mime(text/html) 폐기 — 저장 type·메타 mime 모두 확장자 고정표(application/pdf) · att_seq 1', mem.gw_files['docatt:f1:1'].type === 'application/pdf' && fdoc('f1').files[0].mime === 'application/pdf' && fdoc('f1').att_seq === 1, JSON.stringify([mem.gw_files['docatt:f1:1'].type, fdoc('f1').files[0].mime, fdoc('f1').att_seq]));
r = await call({ action: 'doc_att_put', id: 'f1', name: '두번째.hwpx', data: ZIP }, tokA);
T('첨부: 같은 문서 두 번째 → n=2 · att_seq 2 · hwpx=zip 매직 통과', r.code === 200 && r.body.n === 2 && fdoc('f1').files.length === 2 && fdoc('f1').att_seq === 2 && mem.gw_files['docatt:f1:2'] && mem.gw_files['docatt:f1:2'].type === 'application/hwp+zip');
r = await call({ action: 'doc_att_put', id: 'f1', name: '위장.pdf', data: HTML }, tokA);
T('high1: pdf 확장자 + HTML 내용 → 400 BAD_MAGIC(위장 파일 저장 거부)', r.code === 400 && r.body.error_code === 'BAD_MAGIC', r.code + '/' + r.body.error_code);
r = await call({ action: 'doc_att_put', id: 'f1', name: '위장.png', data: JPG }, tokA);
T('high1: png 확장자 + jpg 바이트 → 400 BAD_MAGIC', r.code === 400 && r.body.error_code === 'BAD_MAGIC');
r = await call({ action: 'doc_att_put', id: 'f1', name: '위장.docx', data: PDF }, tokA);
T('high1: docx 확장자 + pdf 바이트 → 400 BAD_MAGIC', r.code === 400 && r.body.error_code === 'BAD_MAGIC');
r = await call({ action: 'doc_att_put', id: 'f1', name: '한글.hwp', data: HWP }, tokA);
T('첨부: hwp OLE 매직 통과 → type application/x-hwp · n=3', r.code === 200 && r.body.n === 3 && mem.gw_files['docatt:f1:3'].type === 'application/x-hwp');
r = await call({ action: 'doc_att_put', id: 'f1', name: '악성.exe', data: PDF }, tokA);
T('첨부: 확장자 화이트리스트 밖 → 400 BAD_EXT', r.code === 400 && r.body.error_code === 'BAD_EXT');
r = await call({ action: 'doc_att_put', id: 'f1', name: 'x.constructor', data: PDF }, tokA);
T('low5: 확장자 프로토타입 키(constructor) → 400 BAD_EXT', r.code === 400 && r.body.error_code === 'BAD_EXT');
r = await call({ action: 'doc_att_put', id: 'f1', name: '큰파일.pdf', data: 'A'.repeat(6 * 1024 * 1024 + 1) }, tokA);
T('med3: 문서 첨부 6MB(base64) 초과 → 413 FILE_TOO_LARGE(계약 첨부 8MB와 별개)', r.code === 413 && r.body.error_code === 'FILE_TOO_LARGE');
r = await call({ action: 'doc_att_put', id: 'nope', name: 'x.pdf', data: PDF }, tokA);
T('첨부: 없는 문서 → 404 NO_DOC', r.code === 404 && r.body.error_code === 'NO_DOC');
r = await call({ action: 'doc_att_put', id: 'f4', name: 'x.pdf', data: PDF }, tokA);
T('첨부: 삭제(del:1) 문서 → 404 NO_DOC', r.code === 404 && r.body.error_code === 'NO_DOC');
r = await call({ action: 'doc_att_put', id: 'f1', name: 'x.pdf', data: PDF }, tokW, 'dev1');
T('첨부: doc 수행 권한 없는 직원 → 403 NO_WRITE', r.code === 403 && r.body.error_code === 'NO_WRITE');
r = await call({ action: 'doc_att_put', id: 'f1', name: 'x.pdf', data: PDF }, tokD, 'dev1');
T('첨부: doc 수행 직원이 남의 문서(f1) → 403 NOT_OWNER', r.code === 403 && r.body.error_code === 'NOT_OWNER');
r = await call({ action: 'doc_att_put', id: 'f2', name: '증빙.jpg', mime: 'image/jpeg', data: JPG }, tokD, 'dev1');
T('첨부: 등재 본인의 대기 문서(f2) → 200(본인은 대기 중에도 첨부)', r.code === 200 && fdoc('f2').files.length === 1 && fdoc('f2').files[0].by.id === 'udocw', r.code + '/' + r.body.error_code);
r = await call({ action: 'doc_att_put', id: 'f2', name: 'x.pdf', data: PDF }, tokD2, 'dev1');
T('첨부: 타인(직원2)이 남의 대기 문서 → 403 NOT_OWNER', r.code === 403 && r.body.error_code === 'NOT_OWNER');
// att_seq(low4·low7): 카운터 없는 구건은 files 최대 n에서 이어가고, files가 비어도 카운터가 남아 있으면 번호를 재사용하지 않는다
r = await call({ action: 'doc_att_put', id: 'f5', name: '신규.pdf', data: PDF }, tokA);
T('att_seq: 카운터 없는 구건(files n 2) → n=3 · att_seq 3', r.code === 200 && r.body.n === 3 && fdoc('f5').att_seq === 3);
r = await call({ action: 'doc_att_put', id: 'f6', name: '신규.pdf', data: PDF }, tokA);
T('att_seq: files 0·att_seq 5 → n=6(삭제된 번호 재사용 없음)', r.code === 200 && r.body.n === 6 && fdoc('f6').att_seq === 6);
// 열기(doc_att_get) = docVisible 축: f1(02 scope all) 직원 열람 / f3(05 분류 기본 관리자만) 직원 404 / f2 타인 대기 404·본인 200 / 없는 n 404 / type은 고정표
r = await call({ action: 'doc_att_put', id: 'f3', name: '비공개.pdf', data: PDF }, tokA);
r = await call({ action: 'doc_att_get', id: 'f1', n: 1 }, tokD, 'dev1');
T('열기: 공개(scope all) 문서 → 직원 200 · name·type(고정표)·data', r.code === 200 && r.body.data === PDF && r.body.name === '취업규칙.pdf' && r.body.type === 'application/pdf');
mem.gw_files['docatt:f1:1'].type = 'text/html';   // 저장값이 오염됐다고 가정(구 데이터·직접 조작) — 응답은 고정표만
r = await call({ action: 'doc_att_get', id: 'f1', n: 1 }, tokA);
T('high1: 저장 type이 text/html이어도 응답 type은 확장자 고정표(application/pdf)', r.code === 200 && r.body.type === 'application/pdf', r.body.type);
r = await call({ action: 'doc_att_get', id: 'f3', n: 1 }, tokD, 'dev1');
T('열기: 열람 범위 밖(05 분류 기본 관리자만) → 404 NO_DOC(존재 비노출)', r.code === 404 && r.body.error_code === 'NO_DOC', r.code + '/' + r.body.error_code);
r = await call({ action: 'doc_att_get', id: 'f3', n: 1 }, tokA);
T('열기: 관리자는 무제한', r.code === 200 && r.body.data === PDF);
r = await call({ action: 'doc_att_get', id: 'f2', n: 1 }, tokD2, 'dev1');
T('열기: 타인의 대기 문서 → 404', r.code === 404);
r = await call({ action: 'doc_att_get', id: 'f2', n: 1 }, tokD, 'dev1');
T('열기: 본인의 대기 문서 → 200 · type image/jpeg', r.code === 200 && r.body.data === JPG && r.body.type === 'image/jpeg');
r = await call({ action: 'doc_att_get', id: 'f1', n: 9 }, tokA);
T('열기: 없는 번호 → 404 NO_FILE', r.code === 404 && r.body.error_code === 'NO_FILE');
r = await call({ action: 'doc_att_get', id: 'f1', n: 1 }, tokW, 'dev1');
T('열기: doc 보기 권한(기본 view) 직원도 공개 문서는 열람', r.code === 200);
r = await call({ action: 'att_parse', id: 'docatt:f1:1' }, tokA);
T('low6: att_parse에 docatt: 키 → 400 BAD_ID(계약 권한으로 문서함 첨부 판독 차단)', r.code === 400 && r.body.error_code === 'BAD_ID', r.code + '/' + r.body.error_code);
// save 재구성: 비관리자가 files 위조(f1)·삭제(f2 files 제거) 전송 → 서버 원본 고정. 관리자 낡은 사본(files 없음) 저장에도 이월
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: [
  { id: 'f1', title: '관리자 문서', cat: '02-01', scope: 'all', status: '등재', files: [{ n: 9, name: '위조.pdf', size: 1 }] },
  { id: 'f2', title: '직원 대기 문서(편집)', cat: '06-03', status: '대기', by: { id: 'udocw', name: '문서직원' } },
  { id: 'fn1', title: '신규 with files', cat: '06-03', files: [{ n: 1, name: '위조.pdf' }] },
] } }, tokD, 'dev1');
T('save 재구성(직원): 첨부 메타 위조(f1)·삭제(f2) 무시 — 서버 원본 고정(att_seq 포함), 신규 문서 files·att_seq 제거, 제목 편집만 반영', r.code === 200 && fdoc('f1').files.length === 3 && fdoc('f1').files[0].name === '취업규칙.pdf' && fdoc('f2').files.length === 1 && fdoc('f2').title === '직원 대기 문서(편집)' && fdoc('fn1') && fdoc('fn1').files === undefined && fdoc('f1').att_seq === 3 && fdoc('fn1').att_seq === undefined, JSON.stringify([fdoc('f1').files, fdoc('f1').att_seq, fdoc('f2').files, fdoc('fn1')]).slice(0, 200));
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.map((x) => { const s = Object.assign({}, x); delete s.files; return s; }) } }, tokA);
T('save 재구성(관리자 낡은 사본 — files 없음): 첨부 메타 이월', r.code === 200 && fdoc('f1').files.length === 3 && fdoc('f2').files.length === 1 && fdoc('f3').files.length === 1);
{
  // med2: 관리자 저장인데 직전 문서 읽기 실패 → 500(fail-closed) — 종전엔 files 전량 삭제·스냅샷 없이 덮었다
  const savedDocs = mem.gw_data['col:documents'];
  delete mem.gw_data['col:documents'];
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: savedDocs.items.map((x) => { const s = Object.assign({}, x); delete s.files; return s; }) } }, tokA);
  const wrote = !!mem.gw_data['col:documents'];
  mem.gw_data['col:documents'] = savedDocs;
  T('med2: 관리자 저장 + 직전 읽기 실패 → 500 PREV_READ_FAILED · 미저장', r.code === 500 && r.body.error_code === 'PREV_READ_FAILED' && !wrote, r.code + '/' + r.body.error_code);
}
// 삭제: 관리자만 — 메타·바이트 제거, 감사로그 첨부삭제, 이후 열기 404, att_seq 유지
r = await call({ action: 'doc_att_del', id: 'f1', n: 1 }, tokD, 'dev1');
T('첨부 삭제: 비관리자 → 403 ADMIN_ONLY', r.code === 403 && r.body.error_code === 'ADMIN_ONLY');
r = await call({ action: 'doc_att_del', id: 'f1', n: 1 }, tokA);
T('첨부 삭제: 관리자 → 200 · 메타 2건 남음 · 바이트 삭제 · att_seq 3 유지 · 감사로그 첨부삭제', r.code === 200 && r.body.files.length === 2 && fdoc('f1').files.length === 2 && fdoc('f1').files[0].n === 2 && fdoc('f1').att_seq === 3 && !mem.gw_files['docatt:f1:1'] && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '첨부삭제' && l.ev[0].id === 'f1'), JSON.stringify([fdoc('f1').files, fdoc('f1').att_seq]));
r = await call({ action: 'doc_att_get', id: 'f1', n: 1 }, tokA);
T('첨부 삭제 후 열기 → 404 NO_FILE', r.code === 404 && r.body.error_code === 'NO_FILE');
r = await call({ action: 'doc_att_del', id: 'f1', n: 9 }, tokA);
T('첨부 삭제: 없는 번호 → 404', r.code === 404);
r = await call({ action: 'doc_att_put', id: 'f1', name: '네번째.png', data: PNG }, tokA);
T('삭제 후 재첨부 번호는 단조 증가(n=4 — 번호 재사용 없음)', r.code === 200 && r.body.n === 4 && fdoc('f1').att_seq === 4);
// 일괄 등재(doc_bulk_put)
const bulkItems = [
  { title: '정본 A 규정', cat: '02-01', no: 'JW-02-01-001', version: 'v1', revised: '2026-09-01', note: '정본', files: [{ name: 'a.hwpx', mime: 'text/html', data: ZIP }] },
  { title: '증빙 B(구 2자리 cat → 99)', cat: '02', scope: 'mgmt', files: [{ name: 'b.pdf', data: PDF }, { name: 'b2.png', data: PNG }] },
  { title: '분류 없음 → 미분류', files: [{ name: 'c.xlsx', data: ZIP }] },
  { title: '빈 대분류 10 재무·세무', cat: '10-01', files: [{ name: 'd.pdf', data: PDF }] },
  { title: '표 밖 분류 13-01 → 99', cat: '13-01', files: [{ name: 'e.pdf', data: PDF }] },
  { title: '프로토타입 키 → 99', cat: 'constructor', files: [{ name: 'f.pdf', data: PDF }] },
];
const docN0 = mem.gw_data['col:documents'].items.length;
r = await call({ action: 'doc_bulk_put', cid: 'bulk-1', items: bulkItems }, tokD, 'dev1');
T('bulk: 비관리자 → 403 ADMIN_ONLY', r.code === 403 && r.body.error_code === 'ADMIN_ONLY');
r = await call({ action: 'doc_bulk_put', items: bulkItems }, tokA);
T('bulk: cid 없음 → 400 NO_CID', r.code === 400 && r.body.error_code === 'NO_CID');
r = await call({ action: 'doc_bulk_put', cid: 'bulk-1', items: bulkItems }, tokA);
const bulkIds = (r.body.items || []).map((x) => x.id);
{
  const a = fdoc(bulkIds[0]), b = fdoc(bulkIds[1]), c = fdoc(bulkIds[2]), d10 = fdoc(bulkIds[3]), d13 = fdoc(bulkIds[4]), dpk = fdoc(bulkIds[5]);
  T('bulk: 관리자 6건 → 200 count 6 · 전부 즉시 등재(registered_by 관리자·by 관리자) · 메타 이월(no·version·revised·note) · att_seq=첨부 수', r.code === 200 && r.body.count === 6 && bulkIds.length === 6 && a && a.status === '등재' && a.registered_by.id === 'uadmin' && a.by.id === 'uadmin' && a.no === 'JW-02-01-001' && a.version === 'v1' && a.revised === '2026-09-01' && a.note === '정본' && a.cat === '02-01' && a.att_seq === 1 && b.att_seq === 2, JSON.stringify(a).slice(0, 240));
  T('bulk: 첨부 메타 n 1..k + gw_files 바이트 + mime 고정표(클라 text/html 폐기) + scope 정규화(mgmt) + 구 2자리 cat 02 → 99 강등 + 미지정 분류=99·scope 없음(비공개)', b && b.cat === '99' && b.files.length === 2 && b.files[1].n === 2 && b.files[1].mime === 'image/png' && a.files[0].mime === 'application/hwp+zip' && mem.gw_files['docatt:' + a.id + ':1'].type === 'application/hwp+zip' && mem.gw_files['docatt:' + b.id + ':2'] && mem.gw_files['docatt:' + b.id + ':2'].data === PNG && b.scope === 'mgmt' && c && c.cat === '99' && c.scope === undefined && c.files.length === 1, JSON.stringify([a && a.files, b && b.files, c && c.cat, c && c.scope]).slice(0, 240));
  T('2층 분류: bulk cat 10-01 → 그대로 / 13-01(표 밖) → 99 강등 / constructor → 99', d10 && d10.cat === '10-01' && d13 && d13.cat === '99' && dpk && dpk.cat === '99', JSON.stringify([d10 && d10.cat, d13 && d13.cat, dpk && dpk.cat]));
  T('bulk: 감사로그 일괄등재 6건 · 문서 수 +6 · bulk_cid 스탬프', auditMock.logs.some((l) => l.col === 'documents' && l.ev.length === 6 && l.ev.every((e) => e.op === '일괄등재')) && mem.gw_data['col:documents'].items.length === docN0 + 6 && a.bulk_cid === 'bulk-1');
}
r = await call({ action: 'doc_bulk_put', cid: 'bulk-1', items: bulkItems }, tokA);
T('bulk: 같은 cid 재요청 → dedup·같은 id·문서 수 불변', r.code === 200 && r.body.dedup === true && r.body.items.map((x) => x.id).join() === bulkIds.join() && mem.gw_data['col:documents'].items.length === docN0 + 6, JSON.stringify(r.body).slice(0, 160));
r = await call({ action: 'doc_bulk_put', cid: 'bulk-2', items: [{ title: '첨부 없음', files: [] }] }, tokA);
T('bulk: 항목 첨부 0 → 400 BAD_FILE_COUNT(index 0)', r.code === 400 && r.body.error_code === 'BAD_FILE_COUNT' && r.body.index === 0);
r = await call({ action: 'doc_bulk_put', cid: 'bulk-3', items: [{ title: '첨부 4', files: [1, 2, 3, 4].map((i) => ({ name: 'f' + i + '.pdf', data: PDF })) }] }, tokA);
T('bulk: 항목 첨부 4 → 400 BAD_FILE_COUNT', r.code === 400 && r.body.error_code === 'BAD_FILE_COUNT');
r = await call({ action: 'doc_bulk_put', cid: 'bulk-4', items: [{ title: '정상', files: [{ name: 'ok.pdf', data: PDF }] }, { title: '확장자', files: [{ name: 'bad.exe', data: PDF }] }] }, tokA);
T('bulk: 2번째 항목 확장자 위반 → 400 BAD_EXT(index 1) · 전체 거부(1번째도 미등재)', r.code === 400 && r.body.error_code === 'BAD_EXT' && r.body.index === 1 && mem.gw_data['col:documents'].items.length === docN0 + 6);
r = await call({ action: 'doc_bulk_put', cid: 'bulk-4m', items: [{ title: '정상', files: [{ name: 'ok.pdf', data: PDF }] }, { title: '위장', files: [{ name: 'ok.pdf', data: PDF }, { name: 'bad.pdf', data: HTML }] }] }, tokA);
T('high1: bulk 2번째 항목 2번째 파일 매직 불일치 → 400 BAD_MAGIC(index 1·file 1) · 전체 거부', r.code === 400 && r.body.error_code === 'BAD_MAGIC' && r.body.index === 1 && r.body.file === 1 && mem.gw_data['col:documents'].items.length === docN0 + 6, JSON.stringify(r.body));
r = await call({ action: 'doc_bulk_put', cid: 'bulk-5', items: [{ title: '', files: [{ name: 'ok.pdf', data: PDF }] }] }, tokA);
T('bulk: 제목 없음 → 400 NO_TITLE', r.code === 400 && r.body.error_code === 'NO_TITLE');
{
  const big = b64of('%PDF-1.4 ' + 'A'.repeat(Math.floor(2.2 * 1024 * 1024)));   // ≈2.93MB base64 — 둘이면 5.5MB 초과
  r = await call({ action: 'doc_bulk_put', cid: 'bulk-6', items: [{ title: '큰 1', files: [{ name: 'x1.pdf', data: big }] }, { title: '큰 2', files: [{ name: 'x2.pdf', data: big }] }] }, tokA);
  T('med3: bulk 첨부 합계 5.5MB 초과 → 413 BULK_TOO_LARGE(index 1) · 미등재', r.code === 413 && r.body.error_code === 'BULK_TOO_LARGE' && r.body.index === 1 && mem.gw_data['col:documents'].items.length === docN0 + 6 && !Object.keys(mem.gw_files).some((k) => k.indexOf('docatt:') === 0 && mem.gw_files[k].name === 'x1.pdf'), r.code + '/' + r.body.error_code);
}
r = await call({ action: 'doc_bulk_put', cid: 'bulk-7', items: Array.from({ length: 101 }, (_, i) => ({ title: 't' + i, files: [{ name: 'a.pdf', data: PDF }] })) }, tokA);
T('bulk: 항목 101 → 400 TOO_MANY_ITEMS', r.code === 400 && r.body.error_code === 'TOO_MANY_ITEMS');
r = await call({ action: 'doc_bulk_put', cid: 'bad cid!', items: bulkItems }, tokA);
T('bulk: cid 형식 위반 → 400 NO_CID', r.code === 400 && r.body.error_code === 'NO_CID');
r = await call({ action: 'get', collection: 'documents' }, tokM, 'dev1');
T('bulk 등재 문서 열람: scope mgmt 건은 관리부원에게 보이고 미분류(분류 기본 관리자만)는 비노출', r.code === 200 && (r.body.doc.items || []).some((x) => x.id === bulkIds[1]) && !(r.body.doc.items || []).some((x) => x.id === bulkIds[2]));

// 23 문서함 2층 분류(문서체계 설계안 v2 2026-09-04 §6 #26, v317): 설정 기본값(대분류 12키 전부 admin=비공개) / BAD_CAT 경계(표 밖 13·중분류 키 06-01) / docCatOf 4층 번호 파생 → get 필터
//    구형식 JW-05-001·구 텍스트 category·구 2자리 cat → 99(폴백 삭제) / cat 위조 'constructor' → no 파생 / 구 cat '01'+구형식 번호 → 대분류 01 하드차단 유지(docMajorOf)
r = await call({ action: 'doc_settings_get' }, tokA);
{
  const sd = r.body.settings.scope_default, keys = Object.keys(sd).sort();
  T('2층: 설정 기본값 키 = 대분류 02~12·99(12개) · 미저장 대분류 전부 관리자만 · 기존 저장값(02 all·03 mgmt) 유지', r.code === 200 && keys.join() === ['02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '99'].join() && ['04', '05', '06', '08', '09', '10', '11', '12', '99'].every((c) => sd[c] === 'admin') && sd['02'] === 'all' && sd['03'] === 'mgmt', JSON.stringify(sd));
}
r = await call({ action: 'doc_settings_set', cat: '13', scope: 'all' }, tokA);
T('2층: 표 밖 대분류(13) 설정 → 400 BAD_CAT', r.code === 400 && r.body.error_code === 'BAD_CAT');
r = await call({ action: 'doc_settings_set', cat: '06-01', scope: 'all' }, tokA);
T('2층: 중분류 키(06-01) 설정 → 400 BAD_CAT(공개범위 기본값은 대분류 단위)', r.code === 400 && r.body.error_code === 'BAD_CAT');
r = await call({ action: 'doc_settings_set', cat: '07', scope: 'constructor' }, tokA);
T('low5: scope 프로토타입 키(constructor) → 400 BAD_SCOPE', r.code === 400 && r.body.error_code === 'BAD_SCOPE');
r = await call({ action: 'doc_settings_get' }, tokA);
r = await call({ action: 'doc_settings_set', cat: '07', scope: 'all', base: r.body.updated_at }, tokA);
T('2층: 07 인사·노무 → 전원 설정 200', r.code === 200 && r.body.settings.scope_default['07'] === 'all' && r.body.settings.scope_default['11'] === 'admin');
r = await call({ action: 'doc_settings_get' }, tokA);
r = await call({ action: 'doc_settings_set', cat: '06', scope: 'mgmt', base: r.body.updated_at }, tokA);
T('2층: 06 안전보건 → 관리부+관리자 설정 200', r.code === 200 && r.body.settings.scope_default['06'] === 'mgmt' && r.body.settings.scope_default['07'] === 'all');
mem.gw_data['col:documents'].items.push(
  { id: 'g1', title: '취업규칙', no: 'JW-07-01-001', status: '등재' },                                   // 07-01 → 대분류 07 전원 → 직원 열람
  { id: 'g2', title: '연도판', no: 'JW-07-05-001-2026', status: '등재' },                                // 4층 연도판도 앞 두 마디 → 07-05 → 열람
  { id: 'g3', title: '별지', no: 'JW-06-01-004-01', status: '등재' },                                    // 06-01 → 06 mgmt → 관리부만
  { id: 'g4', title: 'JW-11-002 구형식 번호(제목)', status: '등재' },                                   // 구형식 → 99 → 비노출
  { id: 'g5', title: '인허가 관리표', category: '인허가', status: '등재' },                              // 구 텍스트 폴백 삭제 → 99 → 비노출
  { id: 'g6', title: '구형식 번호+scope all', no: 'JW-05-001', scope: 'all', status: '등재' },          // 99여도 문서 scope all은 열람
  { id: 'g7', title: 'cat 위조', cat: 'constructor', no: 'JW-12-01-001', status: '등재' },               // no 파생 12-01 → 12 admin → 비노출
  { id: 'g8', title: '구 2자리 cat', cat: '07', no: 'JW-05-001', status: '등재' },                      // 구 cat '07'은 키 아님 → 99 → 07 전원이어도 비노출
  { id: 'g9', title: '구 cat 01+구형식', cat: '01', no: 'JW-01-002', scope: 'all', status: '등재' },    // 번호 파생 실패해도 대분류 01 → 하드차단(scope all 무시) → 직원 비노출·관리부 열람
  { id: 'g10', title: 'JW-2026 사업계획', status: '등재' },                                             // 99
  { id: 'g11', title: '표 밖 중분류', no: 'JW-06-07-001', scope: 'all', status: '등재' },               // 06-07은 키 아님 → 99, scope all → 열람
);
r = await call({ action: 'get', collection: 'documents' }, tokD, 'dev1');
{
  const ids = (r.body.doc.items || []).map((x) => x.id);
  T('2층 파생(직원): g1 07-01·g2 연도판 07-05 열람 / g6·g11 99+scope all 열람 / g3 06-01(mgmt)·g4 구형식·g5 구 텍스트·g7 cat 위조→12·g8 구 2자리 cat·g9 구 cat 01·g10 비노출',
    r.code === 200 && ['g1', 'g2', 'g6', 'g11'].every((id) => ids.indexOf(id) >= 0) && ['g3', 'g4', 'g5', 'g7', 'g8', 'g9', 'g10'].every((id) => ids.indexOf(id) < 0), ids.join(','));
}
r = await call({ action: 'get', collection: 'documents' }, tokM, 'dev1');
{
  const ids = (r.body.doc.items || []).map((x) => x.id);
  T('2층 파생(관리부): 별지 JW-06-01-004-01 → 06 mgmt 열람 + 구 cat 01(g9) 하드차단 축(관리부+관리자) 열람 / g7(12 admin) 비노출', r.code === 200 && ids.indexOf('g3') >= 0 && ids.indexOf('g9') >= 0 && ids.indexOf('g7') < 0, ids.join(','));
}

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n서버 테스트 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
