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

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n서버 테스트 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
