// gw-data 액션 단위 서버 테스트(P3) — Blobs·push·audit를 인메모리 mock으로 갈아끼우고 handler를 직접 호출.
// 커버: 인증 게이트 / 프로토타입 키 우회 / 관리자 전용 / 낙관적 락 409 / leaves 비관리자 재구성 / 홍보AI 워커 제목 원형 라벨 영속(25, v320) / 관리자 등급 게이트·tier 변경(26, v321) / 문서함 휴지통(27, v321) / 기안 참조 ref 형식(28, v321) / 9/6 검증 반영 — 명시 등급 게이트·자기 변경 금지·LAST_PM 전면·스탬프 강제·부활 차단·누락 보존(29) / gw-allbaro 노선 지정 400자·운영부·노선 숨김(30, v323) / ab_hidden_export 봇 키 내보내기(31, v323 후속) / 운반일지 자동 재정렬 rematch(33, v327) /
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
// store()는 이름으로 좌표되는 객체(toString=이름) — gw-auth listMembers가 st.list({prefix})를 직접 부르므로(v321 등급 테스트) list도 흉내낸다. mem[st]는 toString으로 좌표된다
const blobsMock = {
  hooks: { beforeGet: null, beforeSet: null },   // 절 33(v327) — 느린 읽기(시간 가드)·저장 횟수 검증용 훅. 없으면 무동작
  setupBlobContext() {},
  store(n) { mem[n] = mem[n] || {}; return { name: n, toString() { return n; }, async list(o) { const pre = (o && o.prefix) || ''; return { blobs: Object.keys(mem[n] || {}).filter((k) => k.indexOf(pre) === 0).map((k) => ({ key: k })) }; } }; },
  async blobGet(st, k) { if (blobsMock.hooks.beforeGet) await blobsMock.hooks.beforeGet(k); const s = mem[st] || {}; return (k in s) ? { ok: true, data: JSON.parse(JSON.stringify(s[k])) } : { ok: false, code: 'NOT_FOUND' }; },   // 실 Blobs처럼 get마다 새 객체(JSON 파싱) — 핸들러가 저장 전 객체를 손대도 mem에 반영되지 않는다(9/6: 거부 응답 뒤 "저장 없음" 검증의 전제)
  async blobSet(st, k, v) { if (blobsMock.hooks.beforeSet) await blobsMock.hooks.beforeSet(k); mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobDelete(st, k) { if (mem[st]) delete mem[st][k]; return { ok: true }; },
  async blobList(st) { return { ok: true, keys: Object.keys(mem[st] || {}) }; },
};
const tierLib = require(join(FN, '_lib/tier.js'));   // 관리자 등급(v321) — 실 판정 모듈(의존성 없음). push mock의 isBoss·pmIds·bossIds가 실 push.js와 같은 축을 타게
const membersOf = () => Object.keys(mem.gw_users || {}).filter((k) => k.indexOf('member:') === 0).map((k) => mem.gw_users[k]);
// push mock — 등급 판정은 실 tier.ctxOf(명시 tier·부트스트랩·퇴사 제외)를 회원 블롭 스캔 위에 얹는다(실 push.tierCtx와 같은 축). adminIds도 ctx(재직 관리자만 — bot_notify sent=1은 uadmin 1명)
const pushMock = { calls: [],
  async loadMembers() { return membersOf(); },
  async tierCtx() { return tierLib.ctxOf(membersOf()); },
  async adminIds() { return (await pushMock.tierCtx()).adminIds; },
  async bossIds() { return (await pushMock.tierCtx()).bossIds; },
  async bossOrAdminIds() { const b = await pushMock.bossIds(); return b.length ? b : pushMock.adminIds(); },
  async pmIds() { return (await pushMock.tierCtx()).pmIds; },
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
const ADMIN = { id: 'uadmin', name: '관리자', admin: true, perms: {}, tier: 'pm' };   // v321: 이 계정은 절 17~25의 '비대표 관리자=PM' 전제를 등급으로 명시(파생 규칙상 이름·role 없는 관리자는 admin 등급이라 명시 필요)
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
const BOSS = { id: 'uboss', name: '나종운', admin: true, role: '대표', perms: {}, tier: 'boss' };   // 9/6 검증 S1: 게이트는 명시 tier만(uadmin이 명시 pm이라 부트스트랩이 아니다 — role·이름 파생 없음) → 대표도 명시
mem.gw_users['member:uboss'] = BOSS;
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

// 24 v318·v319 회귀(9/6 재검증): 관리자 save의 01 대분류 이월(cat·no 동시 조작 포함) / 01 문서 첨부 하드차단(등재 본인도 403 BLOCKED_01)
mem.gw_data['col:documents'] = { schema: 1, items: [
  { id: 'h1', title: '구 법인(구 cat 01·구형식 번호)', cat: '01', no: 'JW-01-002', status: '등재' },
  { id: 'h2', title: '01 직원 등재', cat: '01-03', no: 'JW-01-03-009', status: '등재', by: { id: 'udocw', name: '문서직원' } },
  { id: 'h3', title: '06 직원 등재', cat: '06-03', no: 'JW-06-03-009', status: '등재', by: { id: 'udocw', name: '문서직원' } },
], updated_at: 100 };
r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: [
  { id: 'h1', title: '구 법인(제목만 수정)', cat: '99', no: 'JW-01-002', status: '등재' },
  { id: 'h2', title: '01 직원 등재', cat: '05-01', no: 'JW-05-01-001', status: '등재', by: { id: 'udocw', name: '문서직원' } },
  { id: 'h3', title: '06 직원 등재(이동)', cat: '05-01', no: 'JW-05-01-002', status: '등재', by: { id: 'udocw', name: '문서직원' } },
] } }, tokA);
T('v318·v319: 관리자 save — 구 cat 01 문서에 cat 99 → 원본 01 유지 / 01-03 문서에 cat·no 동시 변경 → 둘 다 원본 / 비01 문서 이동은 그대로',
  r.code === 200 && docItem('h1').cat === '01' && docItem('h1').no === 'JW-01-002' && docItem('h1').title === '구 법인(제목만 수정)' && docItem('h2').cat === '01-03' && docItem('h2').no === 'JW-01-03-009' && docItem('h3').cat === '05-01' && docItem('h3').no === 'JW-05-01-002',
  JSON.stringify([r.code, docItem('h1'), docItem('h2'), docItem('h3')]).slice(0, 300));
r = await call({ action: 'doc_att_put', id: 'h2', name: '법인.pdf', data: PDF }, tokD, 'dev1');
T('v318·v319: 등재 본인(doc 수행)이 01 문서에 첨부 → 403 BLOCKED_01', r.code === 403 && r.body.error_code === 'BLOCKED_01', JSON.stringify(r.body).slice(0, 120));
r = await call({ action: 'doc_att_put', id: 'h3', name: '현장.pdf', data: PDF }, tokD, 'dev1');
T('v318·v319: 같은 사람이 06 문서에 첨부 → 200', r.code === 200 && r.body.n === 1, JSON.stringify(r.body).slice(0, 120));
r = await call({ action: 'doc_att_put', id: 'h2', name: '법인.pdf', data: PDF }, tokA);
T('v318·v319: 관리자는 01 문서 첨부 → 200', r.code === 200, JSON.stringify(r.body).slice(0, 120));


// 25 블로그 제목 원형(v320) — 워커(gw-promo-ai-run-background)를 인메모리 blob으로 돌려 라벨 영속 경로를 실측.
//    모델 호출은 없다: promoai.generateDraft만 가짜(실제 buildPrompt·pickTitleType은 그대로 돌린다). 키 값은 더미 문자열(실키 아님).
//    검증: 잡 blob title_type·title_plan / 이력 blob promoai:hist:<id> / 다음 생성의 recent_titles 라벨 출처 (a) 이력 → (b) p.ai.tt → (c) 추정 /
//          재생성 회차 own 제외 / 계약 금지 문자열과 겹치는 이력 제목 제외(LEAK_BLOCKED 유발 방지)
{
  const lib = require(join(FN, '_lib/promoai.js'));
  const worker = require(join(FN, 'gw-promo-ai-run-background.js'));
  const realGen = lib.generateDraft;
  const captured = [];
  let mockWarn = null;   // null이면 실제 draftWarnings(제목 경고 포함)를 돌린다(9/6 ②·⑥ 검증용)
  lib.generateDraft = async function (key, photos, input) {   // 워커 loadLib은 같은 exports 객체를 본다 — 네트워크 없이 계획만 돌린다
    const pr = lib.buildPrompt(Object.assign({}, input, { photoCount: photos.length }));
    const plan = pr.title_plan;
    captured.push({ input: input, plan: plan, user: pr.user });
    const code = plan.primary.code;
    const exs = plan.primary.ex.filter((e, k) => (plan.ex_skip || []).indexOf(code + k) < 0);   // 계약 금지 문자열과 겹쳐 뺀 예시는 제목으로도 안 쓴다
    const draft = { title: exs[captured.length % exs.length], body: '[사진 1 : 시험]\n본문.', tags: ['시험'], title_type: code };
    return Object.assign({ ok: true }, draft, {
      title_plan: { primary: code, backup: plan.backup && plan.backup.code, exclude: plan.exclude, lead_ok: plan.lead_ok, relaxed: plan.relaxed, labels: plan.labels },
      used_tokens: { input: 1, output: 1, total: 2 }, model: 'mock',
      warn: mockWarn ? mockWarn.slice() : lib.draftWarnings(draft, photos.length, Object.assign({}, pr.title_ctx, { plan: plan })) });
  };
  process.env.GW_ANTHROPIC_KEY = 'dummy-offline-test-key-not-real';
  const tokSys = issueSession({ id: '__promoai__', role: 'system' }).token;
  const ATT = 'att_0123456789abcdef';
  mem.gw_files = mem.gw_files || {};
  mem.gw_files[ATT] ={ kind: 'promo', type: 'image/jpeg', name: 'a.jpg', data: 'A'.repeat(200) };
  const legacy = [
    { id: 'pl1', title: '포항 제내리 오수관 역류, 막힘의 원인은 어디에 있을까요?', status: 'posted', posted_at: '2026-09-02', ts: 1788309688273, region: '포항 제내리', facility: '오수관', problem: '역류', shot_at: '2026-01-10', photos: [{ id: ATT }] },
    { id: 'pl2', title: '포항 용덕리 상가 하수구 막힘, 겨울철에 더 심해지는 이유', status: 'posted', posted_at: '2026-08-25', ts: 1787620259234, region: '포항 용덕리', facility: '상가 하수구', problem: '막힘', shot_at: '2026-01-08', photos: [{ id: ATT }] },
    { id: 'pl3', title: '포항 용흥동 우수받이 준설, 그레이팅 막힘 신호 네 가지', status: 'posted', posted_at: '2026-08-20', ts: 1786060893317, region: '포항 용흥동', facility: '우수받이', problem: '침전물', shot_at: '', photos: [{ id: ATT }] },
    { id: 'pl4', title: '포항 장량동 오수관 막힘, 준설로 뚫을 수 있을까요?', status: 'posted', posted_at: '2026-08-19', ts: 1787035355729, region: '포항 장량동', facility: '오수관', problem: '막힘', shot_at: '2025-12-30', photos: [{ id: ATT }] },
    { id: 'pl5', title: '포항 두호동 상가 하수구, 침전물과 악취는 왜 반복될까요', status: 'review', posted_at: '', ts: 1788311647545, ai: { model: 'mock', tokens: 1, ts: 1788311647545 }, region: '포항 두호동', facility: '상가 하수구', problem: '악취', shot_at: '2026-01-13', photos: [{ id: ATT }] },
  ];
  const fresh = (id, region) => ({ id: id, title: '예비 제목 ' + id, status: 'review', posted_at: '', ts: 1790000000000, region: region, facility: '우수받이', problem: '막힘', shot_at: '2026-02-03', photos: [{ id: ATT }], pre_ai: { title: '예비 제목 ' + id } });
  mem.gw_data['col:promo'] = { schema: 1, items: legacy.concat([fresh('pn1', '포항 죽도동'), fresh('pn2', '경주 황성동'), fresh('pn3', '포항 오천읍'), fresh('pn4', '포항 흥해읍')]), updated_at: 1 };
  const promo = (id) => mem.gw_data['col:promo'].items.filter((x) => x.id === id)[0];
  const runJob = async (job, promoId, contractId) => {
    await worker.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokSys }, body: JSON.stringify({ job: job, promo_id: promoId, contract_id: contractId || '', mode: 'draft', max_photos: 30 }) }, {});
    return mem.gw_data['promoai:job:' + job];
  };
  // 클라이언트 흉내(1단계 = index.html 무편집: p.ai에 tt 없음) — 결과 적용 + 게시
  const applyNoTT = (id, jb, posted) => { const p = promo(id); p.title = jb.title; p.ai = { model: 'mock', tokens: 2, ts: 1 }; if (posted) { p.status = 'posted'; p.posted_at = posted; } };

  const j1 = await runJob('pa_t1', 'pn1');
  T('v320 워커: 잡 blob에 title_type·title_plan(primary/backup/exclude/lead_ok/relaxed/labels) 기록 + done', j1 && j1.status === 'done' && /^[A-Z]$/.test(j1.title_type) && j1.title_plan && j1.title_plan.primary === j1.title_type && Array.isArray(j1.title_plan.exclude) && j1.title_plan.labels && typeof j1.title_plan.lead_ok === 'boolean', JSON.stringify(j1).slice(0, 300));
  const h1 = mem.gw_data['promoai:hist:pn1'];
  T('v320 워커: 이력 blob promoai:hist:pn1 = {items:[{title,tt,ts,job}], n:1}', h1 && Array.isArray(h1.items) && h1.items.length === 1 && h1.items[0].title === j1.title && h1.items[0].tt === j1.title_type && h1.items[0].job === 'pa_t1' && h1.n === 1, JSON.stringify(h1));
  T('v320 첫 생성: 최근 5건 = 검수 초안(ai.ts) 1 + 게시 4, 유효 시각순(두호동 초안 → 제내리 → …), 전부 라벨 없음(추정 경로 (c)), 최근 3건 추정 Q·Q·S 제외, 지역명 선두 금지', captured[0].input.recent_titles.length === 5 && captured[0].input.recent_titles[0].title === legacy[4].title && captured[0].input.recent_titles.every((x) => x.tt === '') && ['Q', 'S'].every((c) => j1.title_plan.exclude.indexOf(c) >= 0) && j1.title_plan.lead_ok === false && j1.title_plan.labels.label === 0, JSON.stringify(captured[0].input.recent_titles) + ' ' + JSON.stringify(j1.title_plan));
  T('v320 워커 로그에 [제목] 라벨 출처·회차 줄', j1.log.some((l) => /\[제목\] 최근 5건\(라벨 이력 0·기록 0·추정 5\).*회차 0/.test(l)) && j1.log.some((l) => /\[제목\] 원형 [A-Z] \(지정/.test(l)), j1.log.join(' | '));

  applyNoTT('pn1', j1, '2026-10-01');
  const j2 = await runJob('pa_t2', 'pn2');
  const rt2 = captured[1].input.recent_titles;
  T('v320 (a) 이력 blob 경로: index.html 무편집(p.ai.tt 없음)인데도 다음 생성의 recent_titles[0]에 pn1 라벨이 실리고 그 원형이 제외됨', rt2[0].title === j1.title && rt2[0].tt === j1.title_type && j2.title_plan.exclude.indexOf(j1.title_type) >= 0 && j2.title_type !== j1.title_type && j2.title_plan.labels.label === 1, JSON.stringify(rt2) + ' ' + JSON.stringify(j2.title_plan));

  // (b) p.ai.tt 경로 — 이력 blob이 사라진 상황(백업 복원 등) + 2단계 index.html이 tt를 저장한 경우
  applyNoTT('pn2', j2, '2026-10-02');
  promo('pn2').ai.tt = j2.title_type;
  delete mem.gw_data['promoai:hist:pn2'];
  const j3 = await runJob('pa_t3', 'pn3');
  const rt3 = captured[2].input.recent_titles;
  T('v320 (b) p.ai.tt 경로: 이력 blob 없어도 기록 라벨로 제외', rt3[0].title === j2.title && rt3[0].tt === j2.title_type && j3.title_plan.exclude.indexOf(j2.title_type) >= 0 && j3.title_type !== j2.title_type, JSON.stringify(rt3) + ' ' + JSON.stringify(j3.title_plan));

  // (c) 사람이 제목을 통째로 새로 쓴 기록 — 이력 불일치·p.ai.tt 없음 → 라벨 '' (추정 경로) — 생성은 정상
  applyNoTT('pn3', j3, '2026-10-03');
  promo('pn3').title = '현장 정리 가, 포항 오천읍 작업 내용';
  const j4 = await runJob('pa_t4', 'pn4');
  const rt4 = captured[3].input.recent_titles;
  T('v320 (c) 재작성 제목: 이력·기록 라벨 없음 → tt "" (추정), 생성 정상·완화 0', j4.status === 'done' && rt4[0].title === '현장 정리 가, 포항 오천읍 작업 내용' && rt4[0].tt === '' && rt4[1].tt === j2.title_type && j4.title_plan.relaxed === 0, JSON.stringify(rt4));

  // 재생성 회차 — 같은 기록 두 번째: own_titles에 이전 AI 제목(라벨)이 실리고 attempt 1, 이전 원형 제외
  const j5 = await runJob('pa_t5', 'pn1');
  const in5 = captured[4].input;
  const h5 = mem.gw_data['promoai:hist:pn1'];
  T('v320 재생성: own_titles에 이전 AI 제목+라벨, attempt 1, 이전 원형 제외·다른 원형 선택, 이력 blob 2건·n=2', in5.attempt === 1 && in5.own_titles.some((x) => x.title === j1.title && x.tt === j1.title_type) && j5.title_type !== j1.title_type && j5.title_plan.exclude.indexOf(j1.title_type) >= 0 && h5.items.length === 2 && h5.n === 2, JSON.stringify(in5.own_titles) + ' ' + j5.title_type + ' ' + JSON.stringify(h5));

  // 계약 금지 문자열과 겹치는 이력 제목 — 그 제목만 빼고 생성은 진행(LEAK_BLOCKED 아님)
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c1', title: '우수받이 준설', site: '포항 죽도동', type: '준설', label: '준설', client: '포항시청', contract_info: { amount: 20000000, client: '포항시청' } }], updated_at: 1 };
  promo('pl1').title = '포항시청 앞 오수관 역류, 막힘의 원인은 어디에 있을까요?';
  const j6 = await runJob('pa_t6', 'pn4', 'c1');
  const rt6 = captured[5] && captured[5].input.recent_titles;
  T('v320 계약 참조 시 발주처명이 든 이력 제목은 제외되고 생성 정상(LEAK_BLOCKED 아님)', j6.status === 'done' && rt6 && !rt6.some((x) => /포항시청/.test(x.title)) && j6.log.some((l) => /계약 금지 문자열과 겹쳐 제외/.test(l)), JSON.stringify([j6.status, j6.code, j6.log]).slice(0, 300));

  // ---- 9/6 2차 검증 반영(반박 검증 확정 결함) ----
  // 시각은 실제 흐름대로: 초안 도착 시 p.ai.ts(생성 시각) 저장, 게시는 그 뒤. 앞 단계 pn1~pn3 게시일 2026-10-01~03보다 뒤로 둔다.
  const applyDraft = (id, jb, aiTs) => { const p = promo(id); p.title = jb.title; p.ai = { model: 'mock', tokens: 2, ts: aiTs }; };
  const T10 = Date.parse('2026-10-10');
  // ① 일괄 초안(게시 없이 연속 생성): 2번째 초안의 recent_titles[0]이 1번째 초안 제목(이력 라벨 (a))이고 그 원형이 제외된다
  mem.gw_data['col:promo'].items.push(fresh('pb1', '포항 양덕동'), fresh('pb2', '포항 대잠동'), fresh('pb3', '경주 안강읍'));
  const jb1 = await runJob('pa_b1', 'pb1');
  const rtb1 = captured[captured.length - 1].input.recent_titles;
  T('9/6 ① 갓 등록 기록(게시·AI 초안 없음, 예비 제목 그대로 pb2·pb3)은 후보 밖 — 실제 게시·초안 5건만', jb1.status === 'done' && rtb1.length === 5 && !rtb1.some((x) => /^예비 제목/.test(x.title)), JSON.stringify(rtb1.map((x) => x.title)).slice(0, 240));
  applyDraft('pb1', jb1, T10);
  const jb2 = await runJob('pa_b2', 'pb2');
  const rtb2 = captured[captured.length - 1].input.recent_titles;
  T('9/6 ① 일괄 초안: 미게시 1번째 초안이 2번째의 recent_titles[0](이력 라벨·region 동반)으로 잡히고 그 원형이 제외됨', jb2.status === 'done' && rtb2[0].title === jb1.title && rtb2[0].tt === jb1.title_type && rtb2[0].region === '포항 양덕동' && jb2.title_plan.exclude.indexOf(jb1.title_type) >= 0 && jb2.title_type !== jb1.title_type, JSON.stringify(rtb2).slice(0, 240));
  applyDraft('pb2', jb2, T10 + 1000);
  const jb3 = await runJob('pa_b3', 'pb3');
  const rtb3 = captured[captured.length - 1].input.recent_titles;
  T('9/6 ① 일괄 초안 3번째: 최근 2건 = 앞선 미게시 초안 2건(최신순), 둘 다 제외되고 다른 원형', rtb3[0].title === jb2.title && rtb3[1].title === jb1.title && jb3.title_plan.exclude.indexOf(jb1.title_type) >= 0 && jb3.title_plan.exclude.indexOf(jb2.title_type) >= 0 && jb3.title_type !== jb1.title_type && jb3.title_type !== jb2.title_type, JSON.stringify(rtb3).slice(0, 240) + ' ' + [jb1.title_type, jb2.title_type, jb3.title_type].join(''));
  applyDraft('pb3', jb3, T10 + 2000);

  // ④ 원형 예시 문구가 계약 금지 문자열(발주처명)과 겹치는 경우: 그 예시만 빼고 생성 진행(LEAK_BLOCKED 아님)
  mem.gw_data['col:contracts'].items.push({ id: 'c2', title: '우수받이 준설', site: '포항 죽도동', type: '준설', label: '준설', client: '용흥동 산 아래', contract_info: { amount: 0, client: '용흥동 산 아래' } });
  mem.gw_data['col:promo'].items.push(fresh('pb4', '포항 상도동'));
  const jb4 = await runJob('pa_b4', 'pb4', 'c2');
  const cb4 = captured[captured.length - 1];
  T('9/6 ④ 예시 문구가 발주처명과 겹치면 그 예시(N0·S0)만 제외하고 생성 정상(LEAK_BLOCKED 아님) — 로그·input.ex_skip·user 블록에 해당 문구 없음', jb4.status === 'done' && cb4.input.ex_skip.indexOf('N0') >= 0 && cb4.input.ex_skip.indexOf('S0') >= 0 && jb4.log.some((l) => /원형 예시 \d+건이 계약 금지 문자열과 겹쳐 제외/.test(l)) && cb4.user.indexOf('용흥동 산 아래') < 0 && cb4.plan.ex_skip.indexOf('N0') >= 0, JSON.stringify([jb4.status, jb4.code, cb4.input.ex_skip, jb4.log]).slice(0, 300));

  // ④ 실패 회차 씨앗: 입력 자체가 금지 문자열과 겹쳐 LEAK_BLOCKED가 나면 이력 blob fail_n이 오르고 다음 회차 계획이 바뀐다
  mem.gw_data['col:contracts'].items.push({ id: 'c3', title: '우수받이 준설', site: '포항 죽도동', type: '준설', label: '준설', client: '우수받이', contract_info: { amount: 0, client: '우수받이' } });
  mem.gw_data['col:promo'].items.push(fresh('pb5', '포항 이동'));
  const jf1 = await runJob('pa_f1', 'pb5', 'c3');
  const hf1 = JSON.parse(JSON.stringify(mem.gw_data['promoai:hist:pb5'] || null));
  const jf2 = await runJob('pa_f2', 'pb5', 'c3');
  const hf2 = JSON.parse(JSON.stringify(mem.gw_data['promoai:hist:pb5'] || null));
  T('9/6 ④ LEAK_BLOCKED 2회: 이력 blob fail_n 1→2(items 0·n 0 유지), 2회차 로그 "회차 1(실패 1 포함)", 회차별 계획(주 원형)이 다름', jf1.status === 'fail' && jf1.code === 'LEAK_BLOCKED' && hf1 && hf1.fail_n === 1 && hf1.items.length === 0 && hf1.n === 0 && jf2.code === 'LEAK_BLOCKED' && hf2.fail_n === 2 && jf2.log.some((l) => /회차 1\(실패 1 포함\)/.test(l)) && captured[captured.length - 1].plan.primary.code !== captured[captured.length - 2].plan.primary.code, JSON.stringify([jf1.code, hf1, jf2.code, hf2, jf2.log]).slice(0, 300));
  const jf3 = await runJob('pa_f3', 'pb5');
  const hf3 = mem.gw_data['promoai:hist:pb5'];
  T('9/6 ④ 실패 뒤 성공: 이력 blob items 1·n 1·fail_n 2 유지, 로그 "회차 2(실패 2 포함)"', jf3.status === 'done' && hf3.items.length === 1 && hf3.n === 1 && hf3.fail_n === 2 && jf3.log.some((l) => /회차 2\(실패 2 포함\)/.test(l)), JSON.stringify([jf3.status, jf3.code, hf3, jf3.log]).slice(0, 300));
  applyDraft('pb5', jf3, T10 + 3000);

  // ② 검수 경고 상한 갈래별: 제목 경고가 많아도 사진·본문 경고는 잡 blob에 전부 남는다
  mockWarn = ['본문 100자 — 목표 2000자 미만(사진 1장 기준)', '마커에 빠진 사진: 2,3', '중복 사용된 사진 번호: 1', '마커 한 개에 사진 3장(4,5,6) — 한두 장씩 나눠야 합니다', '안전조치·준비 사진(7)이 본작업 사진 뒤에 있습니다 — 작업 순서 역행'].concat(Array.from({ length: 15 }, (_, k) => '제목 경고 ' + (k + 1)));
  mem.gw_data['col:promo'].items.push(fresh('pb6', '포항 송라면'));
  const jw = await runJob('pa_w1', 'pb6');
  T('9/6 ② 경고 상한 갈래별: 사진·본문 경고 5건 전부 앞에 보존 + 제목 경고는 8건까지(총 13)', jw.status === 'done' && jw.warn.length === 13 && jw.warn.slice(0, 5).join('|') === mockWarn.slice(0, 5).join('|') && jw.warn.filter((w) => /^제목/.test(w)).length === 8, JSON.stringify(jw.warn));
  mockWarn = null;

  // ⑤·⑥ 같은 기록 재생성 16회: 완화 구간에서도 직전 회차와 같은 원형이 없고, 완화 발생 회차는 잡 warn에 '제목 원형 후보가 모자라…' 경고
  mem.gw_data['col:promo'].items.push(fresh('pb7', '포항 죽도동'));
  let prevCode = '', sameN = 0, relaxN = 0, relaxWarnMiss = 0;
  const regenSeq = [];
  for (let k = 0; k < 16; k++) {
    const jr = await runJob('pa_g' + k, 'pb7');
    if (jr.status !== 'done') { relaxWarnMiss += 100; break; }
    regenSeq.push(jr.title_type);
    if (jr.title_type === prevCode) sameN++;
    if (jr.title_plan.relaxed) { relaxN++; if (!(jr.warn || []).some((w) => /^제목 원형 후보가 모자라/.test(w))) relaxWarnMiss++; }
    prevCode = jr.title_type;
    applyDraft('pb7', jr, T10 + 10000 + k);
  }
  T('9/6 ⑤·⑥ 재생성 16회(실코드 워커): 직전 회차와 같은 원형 0, 완화 회차마다 잡 warn에 완화 경고', sameN === 0 && relaxN > 0 && relaxWarnMiss === 0, regenSeq.join(' ') + ' / 동일 ' + sameN + ' / 완화 ' + relaxN + ' / 경고 누락 ' + relaxWarnMiss);

  lib.generateDraft = realGen;
  delete process.env.GW_ANTHROPIC_KEY;
}

// 26 관리자 등급(v321, PM 9/6 ㄱ · 9/6 검증 S1 반영): _lib/tier.js 명시 우선·부트스트랩 파생·ctxOf / 실 push.js tierCtx·bossIds·pmIds tier 기준 / 서버 게이트(① 전결·PM 큐=pm만 → 관리자 등급 admin 403 PM_ONLY, ③·총정리=boss만)
//    / 관리자 등급의 ② 기안은 자동통과 없음 / pm 0명 폴백 / gw-auth member_upsert tier(변경 권한 boss·pm, 관리자만, BAD_TIER, LAST_PM 강등·삭제, 감사로그 등급변경, 관리자 해제 시 제거, member_list 동봉)
{
  T('tier(명시 우선·strict 기본, 9/6 S1): 명시 boss·pm·admin 그대로 / 명시 없음 → admin(role 대표·이름 나종운·dev·나경일도 파생 없음) / 비관리자·삭제·퇴사 → \'\' / 무효 tier(constructor)는 admin',
    tierLib.tierOf({ admin: true, name: '나종운', tier: 'admin' }) === 'admin' && tierLib.tierOf({ admin: true, name: '나수진', tier: 'pm' }) === 'pm' && tierLib.tierOf({ admin: true, tier: 'boss', name: 'x' }, false) === 'boss'
    && tierLib.tierOf({ admin: true, role: '대표', name: 'x' }) === 'admin' && tierLib.tierOf({ admin: true, name: '나종운' }, false) === 'admin' && tierLib.tierOf({ admin: true, dev: true, name: 'y' }) === 'admin' && tierLib.tierOf({ admin: true, name: '나경일' }, false) === 'admin'
    && tierLib.tierOf({ admin: false, role: '대표', name: '나종운' }, true) === '' && tierLib.tierOf({ admin: true, name: '나종운', del: 1 }, true) === '' && tierLib.tierOf({ admin: true, tier: 'pm', leave_date: '2020-01-01' }) === '' && tierLib.tierOf(null) === ''
    && tierLib.tierOf({ admin: true, name: '나수진', tier: 'constructor' }, true) === 'admin' && tierLib.validTier('boss') && !tierLib.validTier('constructor') && !tierLib.validTier(''));
  T('tier(부트스트랩 — 재직 관리자 전원 미지정일 때만): role 대표→boss / 이름 나종운→boss(dev여도) / dev→pm / 이름 나경일→pm / 그 외 관리자→admin · isBootstrap은 명시 tier 하나에 종료(퇴사·삭제·비관리자의 명시 tier는 무시) · retired KST',
    tierLib.tierOf({ admin: true, role: '대표', name: 'x' }, true) === 'boss' && tierLib.tierOf({ admin: true, name: '나종운', dev: true }, true) === 'boss' && tierLib.tierOf({ admin: true, dev: true, name: 'y' }, true) === 'pm' && tierLib.tierOf({ admin: true, name: '나경일' }, true) === 'pm' && tierLib.tierOf({ admin: true, role: '관리자', name: '나수진' }, true) === 'admin'
    && tierLib.isBootstrap([{ admin: true, name: '나종운' }, { admin: false, tier: 'pm' }]) === true && tierLib.isBootstrap([{ admin: true, name: '나종운' }, { admin: true, tier: 'pm', name: 'x' }]) === false
    && tierLib.isBootstrap([{ admin: true, tier: 'pm', leave_date: '2020-01-01' }, { admin: true, tier: 'boss', del: 1 }, { admin: true, name: '나경일' }]) === true && tierLib.isBootstrap([]) === true && tierLib.retired({ leave_date: '2020-01-01' }) && !tierLib.retired({ leave_date: '2999-12-31' }) && !tierLib.retired({}));
  {
    const cx = tierLib.ctxOf([{ id: 'a', admin: true, role: '대표' }, { id: 'b', admin: true, name: '나경일' }, { id: 'c', admin: true, name: '나수진' }, { id: 'd', admin: false }, { id: 'e', admin: true, tier: 'pm', leave_date: '2020-01-01' }]);
    const cy = tierLib.ctxOf([{ id: 'a', admin: true, role: '대표' }, { id: 'b', admin: true, name: '나경일' }, { id: 'c', admin: true, name: '나수진', tier: 'admin' }]);
    T('ctxOf: 부트스트랩(전원 미지정·퇴사자 명시 무시) → boss a·pm b·admin 3(퇴사 e 제외) / 명시 하나 생기면 파생 중단 → boss 0·pm 0·admin 3 · isBoss/isPm/tierOf 노출',
      cx.bootstrap === true && cx.bossIds.join() === 'a' && cx.pmIds.join() === 'b' && cx.adminIds.join() === 'a,b,c' && cx.isBoss(cx.members[0]) && cx.isPm(cx.members[1]) && cy.bootstrap === false && cy.bossIds.length === 0 && cy.pmIds.length === 0 && cy.adminIds.join() === 'a,b,c' && cy.tierOf(cy.members[0]) === 'admin', JSON.stringify([cx.bossIds, cx.pmIds, cx.adminIds, cy.bossIds, cy.pmIds]));
  }  const TADM = { id: 'utadm', name: '나수진', admin: true, role: '관리자', dept: '관리부', perms: {} };   // 관리자 등급 admin(파생) — 예: 관리부
  mem.gw_users['member:utadm'] = TADM;
  const tokT = issueSession(TADM).token;
  mem.gw_data['col:approvals'] = { schema: 1, items: [], updated_at: 0 };
  mem.gw_data['col:documents'] = { schema: 1, items: [{ id: 'd1', title: '취업규칙', cat: '02-01', status: '등재' }], updated_at: 100 };
  {   // 실 push.js를 한 번 로드(mock 대신) — tierCtx·bossIds·pmIds·adminIds가 tier.ctxOf(명시 tier·퇴사 제외) 기준인지. 로드 후 캐시는 mock으로 원복
    const pp = require.resolve(join(FN, '_lib/push.js'));
    const saved = require.cache[pp]; delete require.cache[pp];
    const realPush = require(pp);
    require.cache[pp] = saved;
    const tc = await realPush.tierCtx(), b = await realPush.bossIds(), p = await realPush.pmIds(), a = await realPush.adminIds();
    T('push.js(실물): tierCtx bootstrap false(명시 tier 존재) · bossIds=uboss(명시) · pmIds=uadmin(명시 pm만 — 미지정 utadm은 admin) · adminIds=재직 관리자 3 · loadMembers 노출 · 동기 isBoss/isPm/tierOf 제거', tc.bootstrap === false && b.join() === 'uboss' && p.join() === 'uadmin' && a.slice().sort().join() === 'uadmin,uboss,utadm' && tc.tierOf(TADM) === 'admin' && tc.isPm(ADMIN) && tc.isBoss(BOSS) && typeof realPush.loadMembers === 'function' && realPush.isBoss === undefined && realPush.tierOf === undefined, JSON.stringify([tc.bootstrap, b, p, a]));
  }  const n0 = mem.gw_data['col:approvals'].items.length;
  r = await call({ action: 'approval_create', kind: '사규', title: '관리자 등급 전결 시도', ref: 'doc:d1', self_decide: true }, tokT);
  T('등급: 관리자 등급(admin) 전결 종결 → 403 PM_ONLY · 카드 미생성', r.code === 403 && r.body.error_code === 'PM_ONLY' && r.body.status === 'FORBIDDEN' && mem.gw_data['col:approvals'].items.length === n0, r.code + '/' + r.body.error_code);
  r = await call({ action: 'approval_create', kind: '사규', title: 'PM 전결', ref: 'doc:d1', self_decide: true }, tokA);
  T('등급: pm 전결 종결 → 200 승인', r.code === 200 && r.body.decided === '승인');
  r = await call({ action: 'approval_create', kind: '사규', title: '대표 전결 시도', self_decide: true }, tokB, 'dev1');
  T('등급: 대표 전결 시도 → 400 SELF_DECIDE_PM_ONLY(종전 유지)', r.code === 400 && r.body.error_code === 'SELF_DECIDE_PM_ONLY');
  r = await call({ action: 'approval_create', kind: '사규', title: '직원 전결 시도', self_decide: true }, tokW, 'dev1');
  T('등급: 직원 전결 시도 → 400 SELF_DECIDE_PM_ONLY(종전 유지)', r.code === 400 && r.body.error_code === 'SELF_DECIDE_PM_ONLY');
  r = await call({ action: 'approval_create', kind: '가족친화', title: '① 큐 건' }, tokW, 'dev1');
  const q1 = r.body.id;
  r = await call({ action: 'approvals_list' }, tokT);
  T('approvals_list(관리자 등급): pm_present true(uadmin) · boss_present true · 전체 목록', r.code === 200 && r.body.pm_present === true && r.body.boss_present === true && r.body.items.some((x) => x.id === q1));
  r = await call({ action: 'approval_decide', id: q1, decision: '승인' }, tokT);
  T('등급: ① PM 큐를 관리자 등급이 승인 → 403 PM_ONLY', r.code === 403 && r.body.error_code === 'PM_ONLY', r.code + '/' + r.body.error_code);
  r = await call({ action: 'approval_decide', id: q1, decision: '보류' }, tokT);
  T('등급: ① PM 큐를 관리자 등급이 보류 → 403 PM_ONLY(PM 큐 전부)', r.code === 403 && r.body.error_code === 'PM_ONLY');
  r = await call({ action: 'approval_decide', id: q1, decision: '승인' }, tokB, 'dev1');
  T('등급: ① PM 큐를 대표가 승인 → 403 PM_ONLY(종전 유지)', r.code === 403 && r.body.error_code === 'PM_ONLY');
  r = await call({ action: 'approval_decide', id: q1, decision: '승인' }, tokA);
  T('등급: ① PM 큐를 pm이 승인 → 200 종결', r.code === 200 && r.body.decided === '승인');
  r = await call({ action: 'approval_create', kind: '사직·휴직', title: '② 직원 기안' }, tokW, 'dev1');
  const q2 = r.body.id;
  r = await call({ action: 'approval_decide', id: q2, decision: '승인' }, tokT);
  T('등급: ② 1단계(PM 큐)를 관리자 등급이 승인 → 403 PM_ONLY', r.code === 403 && r.body.error_code === 'PM_ONLY');
  r = await call({ action: 'approval_decide', id: q2, decision: '승인' }, tokA);
  T('등급: ② 1단계를 pm이 승인 → 대표 큐로 전환', r.code === 200 && r.body.to === 'boss');
  r = await call({ action: 'approval_decide', id: q2, decision: '승인' }, tokT);
  T('등급: ② 2단계(대표 큐)를 관리자 등급이 승인 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_create', kind: '지입료', title: '③ 건' }, tokW, 'dev1');
  const q3 = r.body.id;
  r = await call({ action: 'approval_decide', id: q3, decision: '승인' }, tokT);
  T('등급: ③을 관리자 등급이 승인 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_decide', id: q3, decision: '승인' }, tokA);
  T('등급: ③을 pm이 승인 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_decide', id: q3, decision: '보류' }, tokT);
  T('등급: ③ 보류는 관리자 누구나(대표 부재 대기 통로 유지 — 관리자 등급 포함)', r.code === 200 && r.body.decided === '보류');
  r = await call({ action: 'approval_decide', id: q3, decision: '승인' }, tokB, 'dev1');
  T('등급: ③을 대표가 승인 → 200', r.code === 200 && r.body.decided === '승인');
  mem.gw_data['col:approvals'].items.push({ id: 'summary-2026-07', kind: '전결총정리', grade: 3, to: 'boss', status: '대기', title: '7월 전결 총정리 — 0건', by: { id: '__system__', name: '시스템' }, created: '2026-08-01T00:00:00.000Z', summary: { ids: [], counts: {} } });
  r = await call({ action: 'approval_decide', id: 'summary-2026-07', decision: '확인' }, tokT);
  T('등급: 총정리 [확인]을 관리자 등급이 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_decide', id: 'summary-2026-07', decision: '확인' }, tokA);
  T('등급: 총정리 [확인]을 pm이 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_decide', id: 'summary-2026-07', decision: '확인' }, tokB, 'dev1');
  T('등급: 총정리 [확인] 대표 → 200', r.code === 200 && r.body.decided === '승인');
  let pushN = pushMock.calls.length;
  r = await call({ action: 'approval_create', kind: '사직·휴직', title: '관리자 등급 ② 기안' }, tokT);
  {
    const it = mem.gw_data['col:approvals'].items.find((x) => x.id === r.body.id);
    T('등급: 관리자 등급의 ② 기안 → to pm(자동통과 없음·chain 0) · 결재 요청 푸시 1(PM 큐)', r.code === 200 && it && it.to === 'pm' && it.chain.length === 0 && pushMock.calls.length === pushN + 1, JSON.stringify(it).slice(0, 160));
  }
  r = await call({ action: 'approval_create', kind: '사직·휴직', title: 'pm ② 기안' }, tokA);
  T('등급: pm의 ② 기안 → 자동통과·to boss(종전 유지)', r.code === 200 && mem.gw_data['col:approvals'].items.find((x) => x.id === r.body.id).to === 'boss');
  // pm 0명 폴백: uadmin을 admin 등급으로 내리면(블롭 직접) PM 큐가 관리자 전원에게 열린다
  mem.gw_users['member:uadmin'] = Object.assign({}, ADMIN, { tier: 'admin' });
  r = await call({ action: 'approvals_list' }, tokT);
  T('등급: tier pm 0명 → pm_present false', r.code === 200 && r.body.pm_present === false);
  r = await call({ action: 'approval_create', kind: '가족친화', title: '① 폴백 건' }, tokW, 'dev1');
  r = await call({ action: 'approval_decide', id: r.body.id, decision: '승인' }, tokT);
  T('등급: pm 0명이면 관리자 등급도 PM 큐 결재 가능(교착 방지 폴백)', r.code === 200 && r.body.decided === '승인', r.code + '/' + r.body.error_code);
  mem.gw_users['member:uadmin'] = ADMIN;
  // gw-auth member_upsert tier
  const gwa = require(join(FN, 'gw-auth.js'));
  const callA = async (body, tok) => { const x = await gwa.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'pm' }, tokT);
  T('등급 변경: 자기 등급 → 403 SELF_CHANGE_FORBIDDEN(9/6 S1 — 자기 변경 금지가 등급 권한보다 앞)', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'uboss', tier: 'pm' }, tokT);
  T('등급 변경: 관리자 등급(admin) 요청자가 남의 등급 → 403 TIER_PM_OR_BOSS_ONLY', r.code === 403 && r.body.error_code === 'TIER_PM_OR_BOSS_ONLY' && mem.gw_users['member:uboss'].tier === 'boss', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'uwork', tier: 'pm' }, tokA);
  T('등급 변경: 비관리자 대상 → 400 TIER_NOT_ADMIN', r.code === 400 && r.body.error_code === 'TIER_NOT_ADMIN', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'super' }, tokA);
  T('등급 변경: 무효 등급 → 400 BAD_TIER', r.code === 400 && r.body.error_code === 'BAD_TIER');
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'constructor' }, tokA);
  T('등급 변경: 프로토타입 키 등급 → 400 BAD_TIER', r.code === 400 && r.body.error_code === 'BAD_TIER');
  r = await callA({ action: 'member_upsert', id: 'uadmin', tier: 'admin' }, tokA);
  T('등급 변경: 자기 등급 변경 → 403 SELF_CHANGE_FORBIDDEN(9/6 S1)', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'uadmin', tier: 'admin' }, tokB);
  T('등급 변경: 마지막 pm(uadmin) 강등(대표 요청) → 409 LAST_PM', r.code === 409 && r.body.error_code === 'LAST_PM', r.code + '/' + r.body.error_code);
  const audN = auditMock.logs.length;
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'pm' }, tokA);
  T('등급 변경: pm이 관리자 등급을 pm으로 → 200 · tier 저장 · 응답 member.tier · 감사로그 등급변경(admin→pm)', r.code === 200 && r.body.member.tier === 'pm' && mem.gw_users['member:utadm'].tier === 'pm' && auditMock.logs.slice(audN).some((l) => l.col === 'member' && l.ev.some((e) => e.op === '등급변경' && e.id === 'utadm' && /admin→pm/.test(e.t))), JSON.stringify(auditMock.logs.slice(audN)).slice(0, 240));
  r = await callA({ action: 'member_upsert', id: 'uadmin', tier: 'admin' }, tokB);
  T('등급 변경: 대표가 uadmin을 admin으로(다른 pm 있음) → 200', r.code === 200 && mem.gw_users['member:uadmin'].tier === 'admin', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'uadmin', tier: 'pm' }, issueSession(mem.gw_users['member:utadm']).token);
  T('등급 변경: 새 pm(utadm)이 uadmin을 pm으로 복귀 → 200', r.code === 200 && mem.gw_users['member:uadmin'].tier === 'pm');
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'pm' }, tokA);
  T('등급 변경: 같은 등급 재지정 → 200(감사로그 등급변경 추가 없음)', r.code === 200 && auditMock.logs.filter((l) => l.col === 'member' && l.ev.some((e) => e.op === '등급변경' && e.id === 'utadm')).length === 1);
  r = await callA({ action: 'member_list' }, tokW);
  T('member_list(비관리자): tier 동봉', r.code === 200 && r.body.members.some((m) => m.id === 'utadm' && m.tier === 'pm'));
  r = await callA({ action: 'member_upsert', id: 'utadm', admin: false }, tokA);
  T('관리자 해제 → tier 제거(관리자 아닌 회원은 등급 없음)', r.code === 200 && mem.gw_users['member:utadm'].tier === undefined && mem.gw_users['member:utadm'].admin === false, JSON.stringify(mem.gw_users['member:utadm']).slice(0, 160));
  r = await callA({ action: 'member_delete', id: 'uadmin' }, tokB);
  T('마지막 pm(uadmin) 삭제 → 409 LAST_PM', r.code === 409 && r.body.error_code === 'LAST_PM' && mem.gw_users['member:uadmin'].del !== 1, r.code + '/' + r.body.error_code);
  // 원복 — 절 26의 upsert가 바꾼 등급·관리자 여부를 되돌린다(관리자 등급 admin / pm). 절 29가 이 상태(개발자 0명·uadmin 명시 pm·uboss 명시 boss·utadm 미지정)를 전제한다
  mem.gw_users['member:utadm'] = { id: 'utadm', name: '나수진', admin: true, role: '관리자', dept: '관리부', perms: {} };
  mem.gw_users['member:uadmin'] = { id: 'uadmin', name: '관리자', admin: true, perms: {}, tier: 'pm' };
}

// 27 문서함 휴지통(v321): 삭제 스탬프(deleted_at·deleted_by — 관리자 값 신뢰·비관리자 서버 스탬프·낡은 사본 이월) / 비관리자 저장 복구 불가 / doc_restore(관리자·낙관락·cid 멱등·already·감사로그 복구)
//    / doc_purge(confirm 필수·삭제 아님 거부·30일 미경과 거부 days_left·구건 updated_ts·updated 간주·삭제일 미상 fail-closed·첨부 블롭 1..att_seq 제거·감사로그 영구삭제·스냅샷·cid 멱등)
{
  const verDayOf = (ts) => new Date(ts + 9 * 3600000).toISOString().slice(0, 10);
  const OLD = Date.now() - 40 * 86400000, NEW3 = Date.now() - 3 * 86400000;
  mem.gw_data['col:documents'] = { schema: 1, items: [
    { id: 't1', title: '40일 전 삭제(스탬프)', cat: '02-01', del: 1, deleted_at: new Date(OLD).toISOString(), deleted_by: { id: 'uadmin', name: '관리자' }, files: [{ n: 1, name: 'a.pdf', size: 1, mime: 'application/pdf', ts: 1, by: { id: 'uadmin', name: '관리자' } }, { n: 2, name: 'b.pdf', size: 1, mime: 'application/pdf', ts: 1, by: { id: 'uadmin', name: '관리자' } }], att_seq: 3 },
    { id: 't2', title: '구건 삭제(updated_ts만·3일)', cat: '02-01', del: 1, updated_ts: NEW3, updated: verDayOf(NEW3) },
    { id: 't3', title: '살아있는 문서', cat: '06-03', scope: 'all', status: '등재', files: [{ n: 1, name: 'c.pdf', size: 1, mime: 'application/pdf', ts: 1, by: { id: 'uadmin', name: '관리자' } }], att_seq: 1 },
    { id: 't4', title: '직원 문서', cat: '06-03', scope: 'all', status: '등재', by: { id: 'udocw', name: '문서직원' } },
    { id: 't5', title: '구건 삭제(updated 일자만·45일)', cat: '02-01', del: 1, updated: verDayOf(Date.now() - 45 * 86400000) },
  ], updated_at: 500 };
  mem.gw_files['docatt:t1:1'] = { name: 'a.pdf', data: PDF }; mem.gw_files['docatt:t1:2'] = { name: 'b.pdf', data: PDF }; mem.gw_files['docatt:t1:3'] = { name: 'orphan.pdf', data: PDF };
  mem.gw_files['docatt:t3:1'] = { name: 'c.pdf', data: PDF };
  const tdoc = (id) => mem.gw_data['col:documents'].items.find((x) => x && x.id === id);
  r = await call({ action: 'save', collection: 'documents', base: 500, doc: { schema: 1, items: mem.gw_data['col:documents'].items.map((x) => x.id === 't3' ? Object.assign({}, x, { del: 1 }) : x) } }, tokA);
  T('휴지통: 관리자 삭제 저장(스탬프 없이) → 서버가 deleted_at·deleted_by(uadmin) 스탬프', r.code === 200 && tdoc('t3').del === 1 && !!tdoc('t3').deleted_at && tdoc('t3').deleted_by.id === 'uadmin', JSON.stringify(tdoc('t3')).slice(0, 200));
  const t3At = tdoc('t3').deleted_at;
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.map((x) => { const s = Object.assign({}, x); if (x.id === 't3') { delete s.deleted_at; delete s.deleted_by; } return s; }) } }, tokA);
  T('휴지통: 낡은 사본(스탬프 없음) 재저장 → 삭제 스탬프 이월', r.code === 200 && tdoc('t3').deleted_at === t3At && tdoc('t3').deleted_by.id === 'uadmin');
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: mem.gw_data['col:documents'].items.map((x) => { const s = Object.assign({}, x); if (x.id === 't2') delete s.del; return s; }) } }, tokA);
  T('휴지통: 관리자 저장으로 del 해제(병합 복구 경로) → deleted_* 제거', r.code === 200 && tdoc('t2').del === undefined && tdoc('t2').deleted_at === undefined);
  tdoc('t2').del = 1;   // 다시 휴지통으로(아래 복구 테스트용) — 구건 흉내(스탬프 없음)
  mem.gw_data['col:documents'].items.push({ id: 't6', title: '직원이 지울 문서', cat: '06-03', scope: 'all', status: '등재', by: { id: 'udocw', name: '문서직원' } });
  // 비관리자 저장은 "보이는 문서 전부"를 보내는 클라 규약(안 보낸 보이는 문서는 삭제로 해석) — 실제 앱처럼 get 결과를 편집해 보낸다
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => x.id === 't6' ? Object.assign({}, x, { del: 1, deleted_at: '2020-01-01T00:00:00.000Z', deleted_by: { id: 'uadmin', name: '관리자' } }) : x) } }, tokD, 'dev1');
  T('휴지통: 비관리자 삭제 → deleted_by는 서버가 본인(udocw)·deleted_at 서버 시각(위조값 폐기 — 30일 시계 조작 차단)', r.code === 200 && tdoc('t6').del === 1 && tdoc('t6').deleted_by.id === 'udocw' && tdoc('t6').deleted_at !== '2020-01-01T00:00:00.000Z' && (Date.now() - Date.parse(tdoc('t6').deleted_at)) < 60000, JSON.stringify(tdoc('t6')).slice(0, 200));
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => { const s = Object.assign({}, x); if (x.id === 't6') { delete s.del; delete s.deleted_at; delete s.deleted_by; } return s; }) } }, tokD, 'dev1');
  T('휴지통: 비관리자의 저장 복구 시도(del 제거) → 서버가 삭제 유지·스탬프 유지(복구는 관리자 doc_restore만)', r.code === 200 && tdoc('t6').del === 1 && tdoc('t6').deleted_by.id === 'udocw' && !!tdoc('t6').deleted_at, JSON.stringify(tdoc('t6')).slice(0, 200));
  r = await call({ action: 'doc_restore', id: 't2' }, tokD, 'dev1');
  T('복구: 비관리자 → 403 ADMIN_ONLY', r.code === 403 && r.body.error_code === 'ADMIN_ONLY');
  r = await call({ action: 'doc_restore', id: 'nope' }, tokA);
  T('복구: 없는 문서 → 404 NO_DOC', r.code === 404 && r.body.error_code === 'NO_DOC');
  r = await call({ action: 'doc_restore', id: 't2', cid: 'bad cid!' }, tokA);
  T('복구: cid 형식 위반 → 400 BAD_CID', r.code === 400 && r.body.error_code === 'BAD_CID');
  r = await call({ action: 'doc_restore', id: 't2', base: 1 }, tokA);
  T('복구: 낡은 base → 409 STALE_BASE', r.code === 409 && r.body.error_code === 'STALE_BASE');
  // 스냅샷 확인은 링 상한(VER_RECENT 20)에 걸리지 않게 "최신 ver 키가 앞으로 갔는지"로 본다
  const verMax = () => Object.keys(mem.gw_data).filter((k) => k.indexOf('ver:documents:') === 0).reduce((m, k) => Math.max(m, Number(k.slice(14)) || 0), 0);
  const verN0 = verMax();
  r = await call({ action: 'doc_restore', id: 't2', base: mem.gw_data['col:documents'].updated_at, cid: 'rs-1' }, tokA);
  const rsAt = r.body.updated_at;
  T('복구: 관리자 → 200 · del 제거 · restored_by·restored_at · deleted_* 없음 · updated_ts 갱신 · 감사로그 복구 · 스냅샷 생성 · updated_at 응답', r.code === 200 && tdoc('t2').del === undefined && tdoc('t2').restored_by.id === 'uadmin' && !!tdoc('t2').restored_at && tdoc('t2').deleted_at === undefined && tdoc('t2').updated_ts > NEW3 && rsAt > 0 && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '복구' && l.ev[0].id === 't2') && verMax() > verN0, JSON.stringify(tdoc('t2')).slice(0, 200));
  r = await call({ action: 'doc_restore', id: 't2', cid: 'rs-1' }, tokA);
  T('복구: cid 멱등 재요청 → 200 dedup·같은 updated_at', r.code === 200 && r.body.dedup === true && r.body.updated_at === rsAt);
  r = await call({ action: 'doc_restore', id: 't2', cid: 'rs-2' }, tokA);
  T('복구: 이미 살아 있는 문서 → 200 already(무변경)', r.code === 200 && r.body.already === true);
  r = await call({ action: 'get', collection: 'documents' }, tokA);
  T('복구 후 get(관리자): t2 del 없음 · 삭제 건(t1·t3·t5·t6)은 del:1 그대로 내려감(휴지통 서랍 재료)', r.code === 200 && r.body.doc.items.some((x) => x.id === 't2' && x.del !== 1) && ['t1', 't3', 't5', 't6'].every((id) => r.body.doc.items.some((x) => x.id === id && x.del === 1)));
  r = await call({ action: 'doc_purge', id: 't1', confirm: true }, tokD, 'dev1');
  T('영구 삭제: 비관리자 → 403 ADMIN_ONLY', r.code === 403 && r.body.error_code === 'ADMIN_ONLY');
  r = await call({ action: 'doc_purge', id: 't1' }, tokA);
  T('영구 삭제: confirm 없음 → 400 NEED_CONFIRM(항목 유지)', r.code === 400 && r.body.error_code === 'NEED_CONFIRM' && !!tdoc('t1'));
  r = await call({ action: 'doc_purge', id: 't2', confirm: true }, tokA);
  T('영구 삭제: 삭제 아닌 문서 → 400 NOT_DELETED', r.code === 400 && r.body.error_code === 'NOT_DELETED');
  r = await call({ action: 'doc_purge', id: 't3', confirm: true }, tokA);
  T('영구 삭제: 30일 미경과(오늘 삭제) → 400 PURGE_TOO_EARLY · days_left 30 · 항목·첨부 유지', r.code === 400 && r.body.error_code === 'PURGE_TOO_EARLY' && r.body.days_left === 30 && !!tdoc('t3') && !!mem.gw_files['docatt:t3:1'], JSON.stringify(r.body));
  r = await call({ action: 'doc_purge', id: 't6', confirm: true }, tokA);
  T('영구 삭제: 직원이 오늘 지운 문서(t6)도 거부', r.code === 400 && r.body.error_code === 'PURGE_TOO_EARLY');
  r = await call({ action: 'doc_purge', id: 't1', confirm: true, base: 1 }, tokA);
  T('영구 삭제: 낡은 base → 409 STALE_BASE', r.code === 409 && r.body.error_code === 'STALE_BASE');
  const nDocs = mem.gw_data['col:documents'].items.length;
  const verN1 = verMax();
  r = await call({ action: 'doc_purge', id: 't1', confirm: true, base: mem.gw_data['col:documents'].updated_at, cid: 'pg-1' }, tokA);
  T('영구 삭제: 40일 경과 t1 → 200 · 항목 제거 · 첨부 블롭 docatt:t1:1·2·3(고아 포함) 제거 · purged_files 3 · 남의 첨부(t3) 무변경 · 감사로그 영구삭제 · 스냅샷 생성', r.code === 200 && r.body.purged_files === 3 && r.body.failed_files === 0 && !tdoc('t1') && mem.gw_data['col:documents'].items.length === nDocs - 1 && !mem.gw_files['docatt:t1:1'] && !mem.gw_files['docatt:t1:2'] && !mem.gw_files['docatt:t1:3'] && !!mem.gw_files['docatt:t3:1'] && auditMock.logs.some((l) => l.col === 'documents' && l.ev[0].op === '영구삭제' && l.ev[0].id === 't1' && /첨부 블롭 3/.test(l.ev[0].t)) && verMax() > verN1, JSON.stringify(r.body));
  r = await call({ action: 'doc_purge', id: 't1', confirm: true, cid: 'pg-1' }, tokA);
  T('영구 삭제: cid 멱등 재요청 → 200 dedup(404 아님)', r.code === 200 && r.body.dedup === true && r.body.purged_files === 3);
  r = await call({ action: 'doc_purge', id: 't1', confirm: true, cid: 'pg-2' }, tokA);
  T('영구 삭제: 이미 지운 문서 재요청(새 cid) → 404 NO_DOC', r.code === 404 && r.body.error_code === 'NO_DOC');
  r = await call({ action: 'doc_purge', id: 't5', confirm: true, cid: 'pg-3' }, tokA);
  T('영구 삭제: 구건(updated 일자만·45일) → updated를 삭제일로 간주해 200', r.code === 200 && !tdoc('t5'), r.code + '/' + r.body.error_code);
  mem.gw_data['col:documents'].items.push({ id: 't7', title: '삭제일 미상', cat: '02-01', del: 1 });
  r = await call({ action: 'doc_purge', id: 't7', confirm: true }, tokA);
  T('영구 삭제: 삭제일을 알 수 없는 구건 → 400 PURGE_DATE_UNKNOWN(fail-closed)', r.code === 400 && r.body.error_code === 'PURGE_DATE_UNKNOWN' && !!tdoc('t7'));
  r = await call({ action: 'doc_att_get', id: 't3', n: 1 }, tokA);
  T('휴지통 문서의 첨부 열기 → 404 NO_DOC(삭제 중엔 비노출, 복구 후 열림)', r.code === 404 && r.body.error_code === 'NO_DOC');
  r = await call({ action: 'get', collection: 'documents' }, tokD, 'dev1');
  T('휴지통 문서(t6 scope all·del)는 비관리자 get에 규칙대로 내려가되 클라가 숨긴다(서버 필터 변경 없음)', r.code === 200 && r.body.doc.items.some((x) => x.id === 't6' && x.del === 1));
}

// 28 기안 참조 문서 ref 형식(v321 검색 선택 — 저장 형식 종전 동일): 'doc:<id>' 그대로 · 미선택·생략 '' · 60자 절단 · 전결 종결에도 보존 · 직원 목록 응답에 ref 노출
{
  const findAp = (id) => mem.gw_data['col:approvals'].items.find((x) => x.id === id);
  r = await call({ action: 'approval_create', kind: '매뉴얼', title: '참조 있음', ref: 'doc:d1', cid: 'rf-1' }, tokW, 'dev1');
  const a1 = findAp(r.body.id);
  r = await call({ action: 'approval_create', kind: '매뉴얼', title: '참조 없음', ref: '', cid: 'rf-2' }, tokW, 'dev1');
  const a2 = findAp(r.body.id);
  r = await call({ action: 'approval_create', kind: '매뉴얼', title: '참조 생략', cid: 'rf-3' }, tokW, 'dev1');
  const a3 = findAp(r.body.id);
  r = await call({ action: 'approval_create', kind: '매뉴얼', title: '긴 참조', ref: 'doc:' + 'x'.repeat(100), cid: 'rf-4' }, tokW, 'dev1');
  const a4 = findAp(r.body.id);
  T('ref: doc:<id> 그대로 / 빈 문자열·생략 → \'\' / 60자 절단(doc: 접두 유지)', a1 && a1.ref === 'doc:d1' && a2 && a2.ref === '' && a3 && a3.ref === '' && a4 && a4.ref.length === 60 && a4.ref.indexOf('doc:') === 0, JSON.stringify([a1 && a1.ref, a2 && a2.ref, a3 && a3.ref, a4 && a4.ref.length]));
  r = await call({ action: 'approval_create', kind: '매뉴얼', title: 'PM 전결+참조', ref: 'doc:d1', cid: 'rf-5', self_decide: true }, tokA);
  const a5 = findAp(r.body.id);
  r = await call({ action: 'approvals_list' }, tokW, 'dev1');
  T('ref: 전결 종결 건에도 ref 보존 · 직원 approvals_list 본인 건에 ref 노출', a5 && a5.ref === 'doc:d1' && a5.status === '승인' && a5.self_decided === true && r.code === 200 && (r.body.items || []).some((x) => x.id === a1.id && x.ref === 'doc:d1'), JSON.stringify(a5).slice(0, 160));
}

// 29 9/6 검증 반영(보안·권한 / 회귀·정확성): S1 명시 등급 게이트(부트스트랩 예외)·자기 name/role/admin/dev/tier 변경 금지·예약 이름·NAME_TAKEN·이름/직책 변경 DEV_ONLY / S2 BOSS_ONLY 폴백 제거·총정리 크론 스킵+감시 /
//    S3 LAST_PM 전면(admin:false·leave_date)·퇴사 pm 제외 / S4 삭제 스탬프 서버 강제(관리자 위조 무시) / S5 직원 누락 저장 원본 유지·타인 문서 del 무시 / R1 부활 차단(관리자·직원) / R3 hidden_tmp purge / R6 docop 정리 / R7 role 코어션 / member_list 민감 필드 부재
{
  const gwa = require(join(FN, 'gw-auth.js'));
  const callA = async (body, tok) => { const x = await gwa.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const U = (id) => mem.gw_users['member:' + id];
  const tokT = issueSession(U('utadm')).token;
  // ---- S1(b)(c) 회원 저장 게이트 ----
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나수진', role: '대표' }, tokT);
  T('S1: 관리자가 자기 role을 대표로 위조 → 403 SELF_CHANGE_FORBIDDEN · 저장 없음', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN' && U('utadm').role === '관리자', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나경일' }, tokT);
  T('S1: 자기 이름을 나경일로 위조 → 403 SELF_CHANGE_FORBIDDEN', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN' && U('utadm').name === '나수진');
  r = await callA({ action: 'member_upsert', id: 'uadmin', tier: 'boss' }, tokA);
  T('S1: pm이 자기 tier를 boss로 → 403 SELF_CHANGE_FORBIDDEN(개발자 예외 없음 — 개발자 부트스트랩 통과 상태)', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN' && U('uadmin').tier === 'pm');
  r = await callA({ action: 'member_upsert', id: 'uadmin', dev: true }, tokA);
  T('S1: 자기 dev 지정 → 403 SELF_CHANGE_FORBIDDEN', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN' && !U('uadmin').dev);
  r = await callA({ action: 'member_upsert', id: 'uadmin', name: '관리자', role: '', annual_days: 15 }, tokA);
  T('S1: 자기 인사 정보(연차)만 수정 — 같은 name·빈 role 동봉 → 200(변경 아님)', r.code === 200 && U('uadmin').annual_days === 15 && U('uadmin').tier === 'pm', r.code + '/' + r.body.error_code);
  // 예약 이름·role 대표: 개발자가 없어 개발자 게이트는 통과하는 상태에서 pm(비대표)이 시도
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나경일' }, tokA);
  T('S1: pm이 남의 이름을 나경일(예약)로 → 403 NAME_RESERVED', r.code === 403 && r.body.error_code === 'NAME_RESERVED' && U('utadm').name === '나수진', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'utadm', role: '대표' }, tokA);
  T('S1: pm이 남의 role을 대표로 → 403 ROLE_BOSS_ONLY', r.code === 403 && r.body.error_code === 'ROLE_BOSS_ONLY' && U('utadm').role === '관리자');
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나종운' }, tokB);
  T('S1: 대표가 남의 이름을 나종운(기존 회원과 동일)으로 → 409 NAME_TAKEN(이름 색인 탈취 차단 — 목록 비교, 색인 없어도)', r.code === 409 && r.body.error_code === 'NAME_TAKEN' && U('utadm').name === '나수진' && U('uboss').name === '나종운' && !mem.gw_users['name:나종운'], r.code + '/' + r.body.error_code);
  mem.gw_users['name:직원2x'] = 'udocw2';   // 색인만 있고 목록엔 다른 이름인 경우(구 색인 잔재) — 색인 쪽으로도 잡히는지
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '직원2x' }, tokB);
  T('S1: 이름 색인(name:<lower>)이 남을 가리키면 → 409 NAME_TAKEN(색인 비교)', r.code === 409 && r.body.error_code === 'NAME_TAKEN' && U('utadm').name === '나수진');
  delete mem.gw_users['name:직원2x'];
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '직원' }, tokB);
  T('S1: 기존 회원(uwork)과 같은 이름 → 409 NAME_TAKEN', r.code === 409 && r.body.error_code === 'NAME_TAKEN');
  r = await callA({ action: 'member_upsert', name: '직원', role: '직원', pin: '1234' }, tokB);
  T('S1: 신규 회원을 기존 이름으로 → 409 NAME_TAKEN', r.code === 409 && r.body.error_code === 'NAME_TAKEN');
  r = await callA({ action: 'member_upsert', id: 'utadm', role: '대표' }, tokB);
  T('S1: 대표가 남의 role을 대표로 → 200 — 그러나 명시 tier 없으면 게이트는 admin(파생 없음)', r.code === 200 && U('utadm').role === '대표' && (await pushMock.tierCtx()).tierOf(U('utadm')) === 'admin', r.code + '/' + r.body.error_code);
  r = await call({ action: 'approval_create', kind: '지입료', title: '③ 위조 대표 검사' }, tokW, 'dev1');
  const q3f = r.body.id;
  r = await call({ action: 'approval_decide', id: q3f, decision: '승인' }, tokT);
  T('S1: role 대표(명시 tier 없음)로 ③ 승인 시도 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY', r.code + '/' + r.body.error_code);
  r = await call({ action: 'approval_create', kind: '사규', title: 'role 대표 전결 시도', self_decide: true }, tokT);
  T('S1: role 대표(명시 없음)의 전결 시도 → 403 PM_ONLY(등급 admin)', r.code === 403 && r.body.error_code === 'PM_ONLY');
  r = await callA({ action: 'member_upsert', id: 'utadm', role: '관리자' }, tokB);
  T('S1: role 원복(대표→관리자, 대표 요청) → 200 · 감사로그 등급변경 없음(유효 등급 admin 그대로)', r.code === 200 && U('utadm').role === '관리자' && !auditMock.logs.some((l) => l.col === 'member' && l.ev.some((e) => e.op === '등급변경' && e.id === 'utadm' && /admin→admin/.test(e.t))));
  r = await callA({ action: 'member_upsert', id: 'utadm', role: { a: 1 } }, tokB);
  T('R7: role에 객체 전송 → 문자열 코어션(빈 값=변경 없음) 200 · role 유지', r.code === 200 && U('utadm').role === '관리자', JSON.stringify(U('utadm').role));
  // ---- S3 LAST_PM 전면 ----
  r = await callA({ action: 'member_upsert', id: 'uadmin', admin: false }, tokB);
  T('S3: admin:false로 마지막 pm 해제 → 409 LAST_PM · 저장 없음', r.code === 409 && r.body.error_code === 'LAST_PM' && U('uadmin').admin === true && U('uadmin').tier === 'pm', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'uadmin', leave_date: '2020-01-01' }, tokB);
  T('S3: 마지막 pm에 지난 퇴사일 → 409 LAST_PM(퇴사=유효 pm 아님)', r.code === 409 && r.body.error_code === 'LAST_PM' && !U('uadmin').leave_date, r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'uadmin', leave_date: '2999-12-31' }, tokB);
  T('S3: 미래 퇴사일은 통과(아직 재직) → 200', r.code === 200 && U('uadmin').leave_date === '2999-12-31');
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'pm' }, tokA);
  T('S3 준비: utadm을 pm으로(다른 pm 생김) → 200', r.code === 200 && U('utadm').tier === 'pm');
  const audL = auditMock.logs.length;
  r = await callA({ action: 'member_upsert', id: 'uadmin', leave_date: '2020-01-01' }, tokB);
  T('S3: 다른 pm이 있으면 퇴사일 저장 200 · 감사로그 등급변경 pm→없음(퇴사)', r.code === 200 && U('uadmin').leave_date === '2020-01-01' && auditMock.logs.slice(audL).some((l) => l.col === 'member' && l.ev.some((e) => e.op === '등급변경' && e.id === 'uadmin' && /pm→없음/.test(e.t))), JSON.stringify(auditMock.logs.slice(audL)).slice(0, 200));
  {
    const tc = await pushMock.tierCtx();
    T('S3: 퇴사한 pm은 pmIds·adminIds에서 제외(utadm만 pm) · tierOf \'\'', tc.pmIds.join() === 'utadm' && tc.adminIds.indexOf('uadmin') < 0 && tc.tierOf(U('uadmin')) === '', JSON.stringify([tc.pmIds, tc.adminIds]));
  }
  r = await call({ action: 'approvals_list' }, tokT);
  T('S3: 퇴사 pm 제외 후에도 pm_present true(utadm)', r.code === 200 && r.body.pm_present === true);
  r = await call({ action: 'get', collection: 'tasks' }, tokA);
  T('S3: 퇴사한 pm의 세션 → 401 NO_MEMBER', r.code === 401 && r.body.error_code === 'NO_MEMBER');
  mem.gw_users['member:uadmin'] = { id: 'uadmin', name: '관리자', admin: true, perms: {}, tier: 'pm' };   // 원복(블롭 직접 — 퇴사 세션으로는 못 되돌린다)
  r = await callA({ action: 'member_upsert', id: 'utadm', tier: 'admin' }, tokA);
  T('S3 정리: utadm을 admin으로(uadmin pm 복귀) → 200', r.code === 200 && U('utadm').tier === 'admin');
  r = await callA({ action: 'member_delete', id: 'uadmin' }, tokB);
  T('S3: 마지막 pm 삭제 → 409 LAST_PM(삭제도 같은 판정)', r.code === 409 && r.body.error_code === 'LAST_PM' && U('uadmin').del !== 1);
  // ---- 이름·직책 변경은 개발자만(S1(c)) — 개발자 생성 후 비개발자 pm 시도 ----
  mem.gw_users['member:udev'] = { id: 'udev', name: '개발자', admin: true, dev: true, perms: {} };
  const tokDev = issueSession(U('udev')).token;
  r = await callA({ action: 'member_upsert', id: 'utadm', role: '직원' }, tokA);
  T('S1(c): 개발자가 있으면 pm의 남의 role 변경 → 403 DEV_ONLY', r.code === 403 && r.body.error_code === 'DEV_ONLY' && U('utadm').role === '관리자', r.code + '/' + r.body.error_code);
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나수진2' }, tokA);
  T('S1(c): pm의 남의 name 변경 → 403 DEV_ONLY', r.code === 403 && r.body.error_code === 'DEV_ONLY');
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나수진', role: '관리자', annual_days: 12 }, tokA);
  T('S1(c): 같은 name·role 동봉한 인사 수정은 200(변경 아님)', r.code === 200 && U('utadm').annual_days === 12);
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나수진2' }, tokDev);
  T('S1(c): 개발자의 name 변경 → 200 · 이름 색인 이동', r.code === 200 && U('utadm').name === '나수진2' && mem.gw_users['name:나수진2'] === 'utadm' && !mem.gw_users['name:나수진']);
  r = await callA({ action: 'member_upsert', id: 'utadm', name: '나수진' }, tokDev);
  r = await callA({ action: 'member_upsert', id: 'udev', tier: 'boss' }, tokDev);
  T('S1: 개발자(명시 tier 없음=admin)의 자기 tier 변경 → 403 SELF_CHANGE_FORBIDDEN', r.code === 403 && r.body.error_code === 'SELF_CHANGE_FORBIDDEN' && !U('udev').tier && U('utadm').name === '나수진');
  {
    const tc = await pushMock.tierCtx();
    T('S1: dev 플래그도 명시 tier 없으면 admin(부트스트랩 아님) — pmIds에 udev 없음', tc.tierOf(U('udev')) === 'admin' && tc.pmIds.indexOf('udev') < 0 && tc.bootstrap === false);
  }
  delete mem.gw_users['member:udev'];
  // ---- S2 BOSS_ONLY 폴백 제거 · 총정리 크론 스킵 ----
  r = await callA({ action: 'member_upsert', id: 'uboss', tier: 'admin' }, tokA);
  T('S2 준비: pm이 대표를 admin 등급으로(대표 0명) → 200 · 감사로그 등급변경 boss→admin', r.code === 200 && U('uboss').tier === 'admin' && auditMock.logs.some((l) => l.col === 'member' && l.ev.some((e) => e.op === '등급변경' && e.id === 'uboss' && /boss→admin/.test(e.t))), r.code + '/' + r.body.error_code);
  r = await call({ action: 'approvals_list' }, tokA);
  T('S2: boss_present false', r.code === 200 && r.body.boss_present === false);
  r = await call({ action: 'approval_decide', id: q3f, decision: '승인' }, tokT);
  T('S2: 대표 0명 — 관리자 등급의 ③ 승인 → 403 BOSS_ONLY(폴백 없음)', r.code === 403 && r.body.error_code === 'BOSS_ONLY', r.code + '/' + r.body.error_code);
  r = await call({ action: 'approval_decide', id: q3f, decision: '승인' }, tokA);
  T('S2: 대표 0명 — pm의 ③ 승인 → 403 BOSS_ONLY', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_decide', id: q3f, decision: '승인' }, tokB, 'dev1');
  T('S2: 강등된 대표(role 대표·이름 나종운·tier admin)의 ③ 승인 → 403 BOSS_ONLY(파생 없음)', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  r = await call({ action: 'approval_decide', id: q3f, decision: '보류' }, tokT);
  T('S2: 대표 0명이어도 보류는 가능(대기 유지 통로)', r.code === 200 && r.body.decided === '보류');
  mem.gw_data['col:approvals'].items.push({ id: 'summary-2026-06', kind: '전결총정리', grade: 3, to: 'boss', status: '대기', title: '6월 전결 총정리 — 1건', by: { id: '__system__', name: '자동' }, created: '2026-07-01T00:00:00.000Z', summary: { ids: [], counts: {} } });
  r = await call({ action: 'approval_decide', id: 'summary-2026-06', decision: '확인' }, tokA);
  T('S2: 대표 0명 — 총정리 [확인]을 pm이 → 403 BOSS_ONLY(폴백 없음)', r.code === 403 && r.body.error_code === 'BOSS_ONLY');
  {
    const apprCron2 = require(join(FN, 'gw-appr-cron.js'));
    const saved = mem.gw_data['col:approvals'];
    mem.gw_data['col:approvals'] = { schema: 1, items: [{ id: 'p9', kind: '지시', title: '8월 전결 건', grade: 1, to: 'pm', status: '승인', by: { id: 'uwork', name: '직원' }, created: '2026-08-19T01:00:00.000Z', decided_at: '2026-08-20T05:00:00.000Z', chain: [] }], updated_at: 100 };
    mem.gw_data['col:leaves'] = { schema: 1, items: [], updated_at: 100 };
    const audC = auditMock.logs.length, pushC = pushMock.calls.length;
    const cr2 = await apprCron2.runSummary('gw_data', Date.UTC(2026, 7, 31, 23, 0));
    T('S2: 총정리 크론 — 대표 0명이면 스킵(no-boss) · 카드 미생성 · 감사로그 감시 · 푸시 0', cr2.ok && cr2.skipped === 'no-boss' && !mem.gw_data['col:approvals'].items.some((x) => x.id === 'summary-2026-08') && auditMock.logs.slice(audC).some((l) => l.col === 'approvals' && l.ev.some((e) => e.op === '감시' && e.id === 'summary-2026-08')) && pushMock.calls.length === pushC, JSON.stringify(cr2));
    mem.gw_users['member:uboss'].tier = 'boss';
    const cr3 = await apprCron2.runSummary('gw_data', Date.UTC(2026, 7, 31, 23, 0));
    T('S2: 등급 지정 후 재기동 → 카드 생성 · 대표에게만 푸시', cr3.ok && cr3.id === 'summary-2026-08' && pushMock.calls.length === pushC + 1, JSON.stringify(cr3));
    mem.gw_data['col:approvals'] = saved;
  }
  r = await call({ action: 'approval_decide', id: q3f, decision: '승인' }, tokB, 'dev1');
  T('S2: 대표 등급 복귀(tier boss) → ③ 승인 200', r.code === 200 && r.body.decided === '승인', r.code + '/' + r.body.error_code);
  // ---- member_list 비관리자 민감 필드 ----
  r = await callA({ action: 'member_list' }, tokW);
  {
    const bad = ['pin_hash', 'pin_salt', 'uid', 'perms', 'hire_date', 'annual_days', 'birth', 'leave_date', 'annual_base', 'loa_days', 'emp_type'];
    const leak = r.body.members.filter((m) => m.id !== 'uwork').flatMap((m) => bad.filter((k) => k in m));
    T('S7: member_list(비관리자) — 타인 레코드에 민감 필드(pin·uid·perms·인사정보) 없음 · tier·dev·admin은 동봉', r.code === 200 && leak.length === 0 && r.body.members.some((m) => m.id === 'uboss' && m.tier === 'boss' && m.admin === true), leak.join(','));
  }
  // ---- 문서함: S4 스탬프 강제 / S5 누락 보존·타인 del 무시 / R1 부활 차단 / R3 hidden_tmp / R6 docop 정리 ----
  const OLD40 = new Date(Date.now() - 40 * 86400000).toISOString();
  mem.gw_data['col:documents'] = { schema: 1, items: [
    { id: 'w1', title: '관리자가 지울 문서', cat: '02-01', status: '등재' },
    { id: 'w2', title: '전원 공개(타인 등재)', cat: '02-01', scope: 'all', status: '등재', by: { id: 'udocw2', name: '직원2' } },
    { id: 'w3', title: '문서직원 본인 문서', cat: '02-01', scope: 'all', status: '등재', by: { id: 'udocw', name: '문서직원' } },
    { id: 'w4', title: '40일 전 삭제(영구 삭제 대상)', cat: '02-01', del: 1, deleted_at: OLD40, deleted_by: { id: 'uadmin', name: '관리자' } },
    { id: 'w5', title: 'v314 임시 숨김', cat: '02-01', del: 1, hidden_tmp: 1, deleted_at: OLD40 },
    { id: 'w6', title: '관리자만(직원 비가시)', cat: '06-03', status: '등재' },
  ], updated_at: 700 };
  const wdoc = (id) => mem.gw_data['col:documents'].items.find((x) => x && x.id === id);
  const wAll = () => mem.gw_data['col:documents'].items;
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: wAll().map((x) => x.id === 'w1' ? Object.assign({}, x, { del: 1, deleted_at: '2020-01-01T00:00:00.000Z', deleted_by: { id: 'uwork', name: '직원' } }) : x) } }, tokA);
  T('S4: 관리자가 deleted_at(2020)·deleted_by(직원) 위조해 삭제 → 서버 시각·서버 by(uadmin) 강제', r.code === 200 && wdoc('w1').del === 1 && wdoc('w1').deleted_by.id === 'uadmin' && (Date.now() - Date.parse(wdoc('w1').deleted_at)) < 60000, JSON.stringify(wdoc('w1')).slice(0, 200));
  r = await call({ action: 'doc_purge', id: 'w1', confirm: true }, tokA);
  T('S4: 위조 삭제일이 폐기됐으므로 즉시 영구 삭제 불가 → 400 PURGE_TOO_EARLY', r.code === 400 && r.body.error_code === 'PURGE_TOO_EARLY');
  const w1At = wdoc('w1').deleted_at;
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: wAll().map((x) => x.id === 'w1' ? Object.assign({}, x, { deleted_at: '2020-01-01T00:00:00.000Z' }) : x) } }, tokA);
  T('S4: 이미 삭제된 문서의 deleted_at 위조 재저장 → 서버 원본 이월', r.code === 200 && wdoc('w1').deleted_at === w1At);
  // S5 직원 누락 저장: 보이는 문서 중 w3만 보냄 → 나머지 유지
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: [Object.assign({}, wdoc('w3'), { title: '본인 문서(수정)' })] } }, tokD, 'dev1');
  T('S5: 직원이 보이는 문서(w2 등)를 페이로드에서 빼고 저장 → 원본 유지 · w3 편집 반영 · 전체 건수 6 유지', r.code === 200 && wdoc('w2') && wdoc('w2').title === '전원 공개(타인 등재)' && wdoc('w3').title === '본인 문서(수정)' && wAll().length === 6, wAll().map((x) => x.id).join(','));
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => x.id === 'w2' ? Object.assign({}, x, { del: 1, title: '타인 문서 제목 편집' }) : x) } }, tokD, 'dev1');
  T('S5: 타인 등재 문서(w2)에 del:1 전송 → del 무시(원본 유지) · 제목 편집만 반영', r.code === 200 && wdoc('w2').del === undefined && !wdoc('w2').deleted_at && wdoc('w2').title === '타인 문서 제목 편집', JSON.stringify(wdoc('w2')).slice(0, 200));
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).map((x) => x.id === 'w3' ? Object.assign({}, x, { del: 1 }) : x) } }, tokD, 'dev1');
  T('S5: 본인 등재 문서(w3) del:1 → 삭제 + 서버 스탬프(udocw)', r.code === 200 && wdoc('w3').del === 1 && wdoc('w3').deleted_by.id === 'udocw');
  // R3 hidden_tmp
  r = await call({ action: 'doc_purge', id: 'w5', confirm: true }, tokA);
  T('R3: hidden_tmp(v314 임시 숨김) 영구 삭제 → 400 HIDDEN_TMP · 항목 유지', r.code === 400 && r.body.error_code === 'HIDDEN_TMP' && !!wdoc('w5'), r.code + '/' + r.body.error_code);
  // R6 docop 정리
  mem.gw_data['docop:old-1'] = { ts: Date.now() - 8 * 86400000, body: { status: 'OK' } };
  mem.gw_data['docop:new-1'] = { ts: Date.now() - 86400000, body: { status: 'OK' } };
  r = await call({ action: 'doc_restore', id: 'w5', cid: 'rs-w5' }, tokA);
  T('R3: hidden_tmp는 복구 가능 → 200 · hidden_tmp 제거', r.code === 200 && wdoc('w5').del === undefined && wdoc('w5').hidden_tmp === undefined);
  T('R6: 휴지통 작업 시 7일 지난 docop 블롭 정리(old 삭제·new 유지·방금 것 유지)', !mem.gw_data['docop:old-1'] && !!mem.gw_data['docop:new-1'] && !!mem.gw_data['docop:rs-w5'], Object.keys(mem.gw_data).filter((k) => k.indexOf('docop:') === 0).join(','));
  // R1 부활 차단: w4 영구 삭제 → 낡은 사본(관리자·직원) 저장 → 부활 0
  const staleW4 = JSON.parse(JSON.stringify(wdoc('w4')));
  r = await call({ action: 'doc_purge', id: 'w4', confirm: true, cid: 'pg-w4' }, tokA);
  T('R1 준비: w4 영구 삭제 → 200', r.code === 200 && !wdoc('w4'));
  const nAppr = mem.gw_data['col:approvals'].items.length;
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: wAll().concat([staleW4]) } }, tokA);
  T('R1: 관리자의 낡은 사본(del:1 w4) 저장 → 부활 0 · 감사로그 제거(부활 차단)', r.code === 200 && !wdoc('w4') && auditMock.logs.some((l) => l.col === 'documents' && l.ev.some((e) => e.op === '제거' && e.id === 'w4' && /부활/.test(e.t))), wAll().map((x) => x.id).join(','));
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: (await docVisibleTo(tokD)).concat([Object.assign({}, staleW4, { by: { id: 'udocw', name: '문서직원' } })]) } }, tokD, 'dev1');
  T('R1: 직원의 낡은 사본(del:1 w4) 저장 → 부활 0 · \'대기\' 없음 · 등재 카드 없음', r.code === 200 && !wdoc('w4') && mem.gw_data['col:approvals'].items.length === nAppr && !mem.gw_data['col:approvals'].items.some((a) => a.ref === 'doc:w4'), wAll().map((x) => x.id).join(','));
  r = await call({ action: 'get', collection: 'documents' }, tokD, 'dev1');
  T('R1·S5 후 직원 get: w2(전원) 보이고 w6(관리자만)·w4(영구 삭제) 없음', r.code === 200 && docIds(r).indexOf('w2') >= 0 && docIds(r).indexOf('w6') < 0 && docIds(r).indexOf('w4') < 0, docIds(r));
}

// 30 gw-allbaro(v323, PM 9/7) — 노선 지정 품목 400자·상차지/하차지 120자(#10) · 노선 지정 운영부 허용(#13) · 노선 숨김 ab_route_hide(#9)
//    같은 mock(blobs·audit) 위에서 gw-allbaro handler를 직접 호출. mock blobGet은 없는 키를 NOT_FOUND(ok:false)로 주므로(실 Blobs는 ok:true·data:null) 학습·숨김 blob을 빈 문서로 선시드.
{
  const gwab = require(join(FN, 'gw-allbaro.js'));
  const OPS = { id: 'uops', name: '운영부원', admin: false, dept: '운영부', perms: {} };
  const OTHER = { id: 'uoth', name: '타부서원', admin: false, dept: '관리부', perms: {} };
  mem.gw_users['member:uops'] = OPS; mem.gw_users['member:uoth'] = OTHER;
  mem.gw_users['member:uadmin'] = { id: 'uadmin', name: '관리자', admin: true, perms: {}, tier: 'pm' };
  mem.gw_users['member:uwork'] = WORKER;
  const tokO = issueSession(OPS).token, tokX = issueSession(OTHER).token;
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] };
  const ab = async (body, tok, dev) => { const rr = await gwab.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body || '{}') }; };
  const learned = () => mem.gw_data['allbaro:learned'].items;
  const hidden = () => mem.gw_data['allbaro:routes_hidden'].items;
  const LONG_ITEM = ('그 밖의 폐광물유[아스팔트유·그리스(grease)·방청유 및 ' + '기타폐광물유'.repeat(60)).slice(0, 200);
  // #10 길이 상한
  r = await ab({ action: 'ab_learn', from: '에코프로 씨엔지', to: '네이처(경주)', item: LONG_ITEM, side: 'L', row: 35 }, tokA);
  T('ab_learn 품목 200자(관리자) → 200 · 저장 원문 그대로(200자) · route L35', LONG_ITEM.length === 200 && r.code === 200 && r.body.ok === true && r.body.route.side === 'L' && r.body.route.row === 35 && learned().length === 1 && learned()[0].item === LONG_ITEM && learned()[0].item.length === 200, r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_learn', from: '에코프로 씨엔지', to: '네이처(경주)', item: LONG_ITEM + ' ', side: 'L', row: 35 }, tokA);
  T('같은 조합(공백 차이) 재지정 → 200 · 덮어씀(learned 1건 유지 — learnKey는 normItem 정규화)', r.code === 200 && learned().length === 1, r.code + '/' + learned().length);
  r = await ab({ action: 'ab_learn', from: 'A', to: 'B', item: 'x'.repeat(401), side: 'L', row: 35 }, tokA);
  T('ab_learn 품목 401자 → 400 STR_TOO_LONG', r.code === 400 && r.body.code === 'STR_TOO_LONG', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_learn', from: 'x'.repeat(121), to: 'B', item: '', side: 'L', row: 35 }, tokA);
  T('ab_learn 상차지 121자 → 400 STR_TOO_LONG', r.code === 400 && r.body.code === 'STR_TOO_LONG', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_learn', from: 'x'.repeat(120), to: 'y'.repeat(120), item: 'z'.repeat(400), side: 'R', row: 8 }, tokA);
  T('ab_learn 상·하차지 120자·품목 400자(상한 그대로) → 200', r.code === 200 && learned().length === 2, r.code + '/' + r.body.code);
  // #13 운영부 허용
  let audL = auditMock.logs.length;
  r = await ab({ action: 'ab_learn', from: '운영부테스트', to: '네이처', item: '폐합성수지', side: 'L', row: 5 }, tokO, 'dev1');
  T('ab_learn 운영부 직원 → 200 · 감사로그 노선지정 by 운영부원', r.code === 200 && learned().some((x) => x.from === '운영부테스트' && x.by === '운영부원') && auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.by === '운영부원' && l.ev[0].op === '노선지정'), r.code + '/' + r.body.code);
  audL = auditMock.logs.length;
  r = await ab({ action: 'ab_learn', from: '타부서테스트', to: '네이처', item: '폐합성수지', side: 'L', row: 5 }, tokX, 'dev1');
  T('ab_learn 타 부서(관리부) 직원 → 403 FORBIDDEN · 저장 없음 · 감사로그 노선지정거부 by 타부서원', r.code === 403 && r.body.code === 'FORBIDDEN' && !learned().some((x) => x.from === '타부서테스트') && auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.by === '타부서원' && l.ev[0].op === '노선지정거부' && /관리부/.test(l.ev[0].t)), r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_learn', from: '무부서테스트', to: '네이처', item: '', side: 'L', row: 5 }, tokW, 'dev1');
  T('ab_learn 부서 없는 직원 → 403 FORBIDDEN', r.code === 403 && r.body.code === 'FORBIDDEN', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_learn', from: '미승인기기', to: '네이처', item: '', side: 'L', row: 5 }, tokO, 'devX');
  T('ab_learn 운영부라도 미승인 기기 → 403 DEVICE_NOT_APPROVED', r.code === 403 && r.body.code === 'DEVICE_NOT_APPROVED', r.code + '/' + r.body.code);
  // #9 노선 숨김
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokW, 'dev1');
  T('ab_route_hide 직원 → 403 ADMIN_ONLY', r.code === 403 && r.body.code === 'ADMIN_ONLY', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokO, 'dev1');
  T('ab_route_hide 운영부 직원도 403 ADMIN_ONLY(숨김은 관리자 전용)', r.code === 403 && r.body.code === 'ADMIN_ONLY' && hidden().length === 0, r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 999, hide: true }, tokA);
  T('ab_route_hide 없는 줄(L999) → 400 BAD_ROUTE', r.code === 400 && r.body.code === 'BAD_ROUTE', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'X', row: 5, hide: true }, tokA);
  T('ab_route_hide 잘못된 side → 400 BAD_ROUTE', r.code === 400 && r.body.code === 'BAD_ROUTE', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: 'yes' }, tokA);
  T('ab_route_hide hide가 불리언 아님 → 400 BAD_INPUT', r.code === 400 && r.body.code === 'BAD_INPUT', r.code + '/' + r.body.code);
  audL = auditMock.logs.length;
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokA);
  T('ab_route_hide 관리자 hide → 200 changed · 블롭 routes_hidden items [{side,row,by,ts}] · 감사로그 노선숨김 L5', r.code === 200 && r.body.hidden === true && r.body.changed === true && r.body.hidden_n === 1 && hidden().length === 1 && hidden()[0].side === 'L' && hidden()[0].row === 5 && hidden()[0].by === '관리자' && hidden()[0].ts > 0 && mem.gw_data['allbaro:routes_hidden'].schema === 1 && auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.by === '관리자' && l.ev[0].op === '노선숨김' && l.ev[0].id === 'L5'), JSON.stringify(r.body).slice(0, 160));
  audL = auditMock.logs.length;
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokA);
  T('같은 줄 다시 hide → 200 changed:false · 중복 없음 · 감사로그 추가 없음', r.code === 200 && r.body.changed === false && hidden().length === 1 && auditMock.logs.length === audL, JSON.stringify(r.body).slice(0, 120));
  r = await ab({ action: 'ab_status' }, tokA);
  { const rt = (r.body.routes || []).find((x) => x.side === 'L' && x.row === 5);
    T('ab_status routes: L5 hidden:true·hidden_by 관리자 · 다른 줄 hidden 없음 · hidden_error false · 노선 수 그대로', r.code === 200 && rt && rt.hidden === true && rt.hidden_by === '관리자' && rt.hidden_ts > 0 && r.body.routes.filter((x) => x.hidden).length === 1 && r.body.hidden_error === false && r.body.routes.length === require(join(FN, '_lib/allbaro.js')).ROUTES.length, JSON.stringify(rt)); }
  r = await ab({ action: 'ab_learn', from: '숨긴줄배정', to: '네이처', item: '폐합성수지', side: 'L', row: 5 }, tokA);
  T('숨긴 줄에도 노선 지정 가능(배정은 소프트 숨김과 무관) → 200', r.code === 200 && learned().some((x) => x.from === '숨긴줄배정' && x.row === 5), r.code + '/' + r.body.code);
  audL = auditMock.logs.length;
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: false }, tokA);
  T('unhide → 200 changed · 블롭 비움 · 감사로그 노선숨김해제', r.code === 200 && r.body.hidden === false && r.body.changed === true && hidden().length === 0 && auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.ev[0].op === '노선숨김해제' && l.ev[0].id === 'L5'), JSON.stringify(r.body).slice(0, 120));
  r = await ab({ action: 'ab_status' }, tokA);
  T('unhide 후 ab_status routes에 hidden 없음', r.code === 200 && !(r.body.routes || []).some((x) => x.hidden), '');
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: false }, tokA);
  T('이미 안 숨긴 줄 unhide → 200 changed:false', r.code === 200 && r.body.changed === false, JSON.stringify(r.body).slice(0, 120));
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [{ side: 'L', row: 5, by: '관리자', ts: 1 }, { side: 'R', row: 999, by: '옛줄', ts: 1 }] };
  r = await ab({ action: 'ab_status' }, tokA);
  T('ab_status: 노선표에 없는 숨김 잔재(R999)는 무시 · L5만 hidden', r.code === 200 && r.body.routes.filter((x) => x.hidden).length === 1 && r.body.routes.find((x) => x.hidden).row === 5, '');
  delete mem.gw_data['allbaro:routes_hidden'];
  r = await ab({ action: 'ab_status' }, tokA);
  T('ab_status: 숨김 blob 읽기 실패(mock NOT_FOUND) → 200 유지 · hidden 없음 · hidden_error true(없음과 구분)', r.code === 200 && !(r.body.routes || []).some((x) => x.hidden) && r.body.hidden_error === true, JSON.stringify(r.body).slice(0, 120));
}

// 31 ab_hidden_export(v323 후속, PM 9/7 ㄱ 숨김→엑셀 동기화) — appdata logsheet 봇이 세션 없이 BIDS_INGEST_KEY로 숨긴 좌표만 읽는다.
//    키 일치 200(body.key·헤더 x-ingest-key) / 불일치·누락 401 / 세션 있어도 키 없으면 401 / env 키 비면 닫힘 / 응답에 by·bid·ts 없음 / 잔재 무시 / 블롭 읽기 실패 500.
{
  const gwab = require(join(FN, 'gw-allbaro.js'));
  const ab = async (body, headers) => { const rr = await gwab.handler({ httpMethod: 'POST', headers: Object.assign({}, headers || {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body || '{}') }; };
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, updated_at: 1757200000000, items: [{ side: 'R', row: 6, by: '관리자', bid: 'uadmin', ts: 2 }, { side: 'L', row: 5, by: '관리자', bid: 'uadmin', ts: 1 }, { side: 'R', row: 999, by: '옛줄', ts: 1 }] };
  r = await ab({ action: 'ab_hidden_export', key: 'test-ingest-key' });
  T('ab_hidden_export body.key 일치·세션 없음 → 200 · items 좌표만(L5·R6 정렬) · 잔재 R999 제외 · updated_at', r.code === 200 && r.body.ok === true && r.body.n === 2 && JSON.stringify(r.body.items) === JSON.stringify([{ side: 'L', row: 5 }, { side: 'R', row: 6 }]) && r.body.updated_at === 1757200000000, JSON.stringify(r.body).slice(0, 200));
  T('응답에 회원 정보 없음(by·bid·ts 키·이름·id 없음)', r.code === 200 && !/"(by|bid|ts)"/.test(JSON.stringify(r.body)) && !/관리자|uadmin|옛줄/.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 200));
  r = await ab({ action: 'ab_hidden_export' }, { 'x-ingest-key': 'test-ingest-key' });
  T('헤더 x-ingest-key 일치 → 200', r.code === 200 && r.body.n === 2, r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_hidden_export', key: 'wrong-key' });
  T('키 불일치 → 401 BAD_INGEST_KEY · items 없음', r.code === 401 && r.body.code === 'BAD_INGEST_KEY' && !('items' in r.body), r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_hidden_export', key: 'test-ingest-ke' });
  T('길이 다른 키(접두 일치) → 401', r.code === 401 && r.body.code === 'BAD_INGEST_KEY', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_hidden_export' });
  T('키 누락·세션 없음 → 401 BAD_INGEST_KEY(NO_SESSION 아님 — 세션 게이트 앞에서 갈라짐)', r.code === 401 && r.body.code === 'BAD_INGEST_KEY', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_hidden_export' }, { authorization: 'Bearer ' + tokA, 'x-device-id': 'dev1' });
  T('관리자 세션·승인 기기만 있고 키 없음 → 401(세션은 대체 인증 아님)', r.code === 401 && r.body.code === 'BAD_INGEST_KEY', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_status', key: 'test-ingest-key' });
  T('다른 액션(ab_status)은 키로 못 연다 → 401(세션 게이트 그대로)', r.code === 401 && r.body.code !== 'BAD_INGEST_KEY', r.code + '/' + r.body.code);
  { const saved = process.env.BIDS_INGEST_KEY; process.env.BIDS_INGEST_KEY = '';
    r = await ab({ action: 'ab_hidden_export', key: '' });
    T('env BIDS_INGEST_KEY 비어 있으면 빈 키도 401(기본 개방 금지)', r.code === 401 && r.body.code === 'BAD_INGEST_KEY', r.code + '/' + r.body.code);
    process.env.BIDS_INGEST_KEY = saved; }
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] };
  r = await ab({ action: 'ab_hidden_export', key: 'test-ingest-key' });
  T('숨긴 줄 없음 → 200 items [] · updated_at null', r.code === 200 && r.body.n === 0 && Array.isArray(r.body.items) && r.body.items.length === 0 && r.body.updated_at === null, JSON.stringify(r.body).slice(0, 120));
  delete mem.gw_data['allbaro:routes_hidden'];
  r = await ab({ action: 'ab_hidden_export', key: 'test-ingest-key' });
  T('숨김 blob 읽기 실패(mock NOT_FOUND) → 500(봇은 전체 양식으로 폴백 — 빈 목록으로 오해 금지)', r.code === 500 && r.body.ok === false && !('items' in r.body), r.code + '/' + r.body.code);
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] };
}


// ===== 32. 노선 매칭 규칙 v326(PM 9/8) — 품목 불일치는 후보 1개여도 미매칭(ITEM_MISMATCH), R39 폐석회 줄 =====
{
  const abLib = require(join(FN, '_lib/allbaro.js'));
  const mx = (row) => abLib.matchRouteEx(row, {});
  let d = mx({ from: '(주)포스코퓨처엠', to: '대화산업(주)', item: '폐석회(고상)' });
  T('포스코퓨처엠→대화산업 폐석회 → R39(새 줄) 배정 · weak false', !!d.route && d.route.side === 'R' && d.route.row === 39 && d.weak === false && d.reason === null, JSON.stringify(d.route) + '/' + d.reason);
  d = mx({ from: '(주)포스코퓨처엠', to: '대화산업(주)', item: '분진(고상)' });
  T('같은 상·하차지 분진 → R14 그대로', !!d.route && d.route.row === 14 && d.reason === null, JSON.stringify(d.route));
  d = mx({ from: '(주)티씨씨스틸', to: '(주)성진케이피인터내셔널(종합재활용업)', item: '폐석회(고상)' });
  T('후보 1개(R36 폐수오니)인데 품목 다름 → 배정 없음 · ITEM_MISMATCH · 후보 동봉', d.route === null && d.reason === 'ITEM_MISMATCH' && d.weak === false && Array.isArray(d.candidates) && d.candidates.length === 1 && d.candidates[0].row === 36, JSON.stringify(d));
  d = mx({ from: '(주)티씨씨스틸', to: '(주)성진케이피인터내셔널(종합재활용업)', item: '폐수처리오니(고상)' });
  T('후보 1개 품목 일치 → R36 배정', !!d.route && d.route.row === 36 && d.reason === null && d.weak === false, JSON.stringify(d.route));
  d = mx({ from: '주식회사포스코', to: '(주)피엔알', item: '전혀 다른 품목명' });
  T('구내운송(품목칸=도착처, viaItem) 줄은 품목이 달라도 종전대로 배정 · weak false', !!d.route && d.route.side === 'R' && d.route.row === 9 && d.weak === false, JSON.stringify(d));
  d = mx({ from: '없는배출자', to: '없는처리자', item: '분진' });
  T('상·하차지 없음 → NO_ROUTE 그대로', d.route === null && d.reason === 'NO_ROUTE', d.reason);
  const rs = abLib.ROUTES || [];
  const keys = rs.map((r) => r.side + r.row);
  T('ROUTES: R39 존재 · (side,row) 중복 없음 · R39 count_col 11', keys.includes('R39') && new Set(keys).size === keys.length && rs.find((r) => r.side === 'R' && r.row === 39).count_col === 11, keys.length + '/' + new Set(keys).size);
  const src = require('fs').readFileSync(join(ROOT, 'index.html'), 'utf8');
  T('앱 AB_ROUTES에 R39 폐석회 · 사유 문구 ITEM_MISMATCH 있음', /\{s:"R",r:39,f:"\(주\)포스코퓨처엠",t:"대화산업",i:"폐석회"\}/.test(src) && /ITEM_MISMATCH:\s*"품목이 다름/.test(src));
}

// ===== 33. 운반일지 자동 재정렬 v327(PM 9/8 "학습시키거나 노선표가 바뀌면 사람이 수동 수집을 안 눌러도 기록이 스스로 재정렬") =====
//    (a) 옛 규칙 day 블롭 → ab_day가 그 자리에서 재정렬(R14 분진→R39·routes_ver·n/qty/total 불변·감사) (b) ab_learn(day) → 그날 묶음이 학습 줄로·rematched.changed≥1
//    (c) 학습 없는 다른 묶음 불변 (d) 차량 분리 묶음(vehicle_type)은 같은 줄·차량 미상은 종전 줄 유지 없이 미매칭 (e) 숨긴 노선·직접 추가 블롭 무변경
//    (f) 시간 가드(느린 blobGet) left 반환 (g) routes_ver 같으면 저장 0 · 학습 못 읽으면 stale·저장 0 · ab_status 7일 상한·stale_days · BAD_DAY · 순수 함수
{
  const gwab = require(join(FN, 'gw-allbaro.js'));
  const abLib = require(join(FN, '_lib/allbaro.js'));
  const ab = async (body, tok, dev) => { const rr = await gwab.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body || '{}') }; };
  const VER = abLib.ROUTES_VER;
  const kst = (n) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
  const D = kst(-1);   // 어제(학습 대상 날짜)
  const dk = (day) => 'allbaro:day:' + day;
  const expectVer = require('crypto').createHash('sha1').update(abLib.ROUTES.map((r) => [r.side, r.row, r.from, r.to, r.item].join('\u0001')).join('\n'), 'utf8').digest('hex').slice(0, 12);
  T('ROUTES_VER = side/row/from/to/item 이어붙인 sha1 앞 12자(노선표 바뀌면 값이 바뀐다)', typeof VER === 'string' && /^[0-9a-f]{12}$/.test(VER) && VER === expectVer, VER + '/' + expectVer);
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [{ side: 'L', row: 5, by: '관리자', bid: 'uadmin', ts: 1 }] };
  mem.gw_data['allbaro:manual:' + D] = { schema: 1, day: D, items: [{ route_id: '', from: '수동상차', to: '수동하차', item: '', n: 1, qty_ton: 0, memo: '' }], by: '관리자', bid: 'uadmin', ts: 5 };
  const hiddenBefore = JSON.stringify(mem.gw_data['allbaro:routes_hidden']), manualBefore = JSON.stringify(mem.gw_data['allbaro:manual:' + D]);
  const B = (from, to, item, n, qty, route, extra) => Object.assign({ from: from, to: to, item: item, n: n, manf_nums: Array.from({ length: n }, (_, i) => 'M' + i), qty_ton: qty, qty_unknown: 0, qty_src: 'tran', n_pending: 0, route: route, weak: false }, extra || {});
  const TCC = ['(주)티씨씨스틸', '(주)성진케이피인터내셔널(종합재활용업)', '폐석회(고상)'];
  const oldDoc = (day) => ({ schema: 2, day: day || D, total: 7, total_qty_ton: 61.5, qty_unknown: 0,
    counts: [
      B('(주)포스코퓨처엠', '대화산업(주)', '폐석회(고상)', 2, 20.5, { side: 'R', row: 14, count_col: 11, item: '분진' }, { weak: true }),   // v325 이전 규칙 — 후보 1개라 분진 줄에 배정+weak(9/7 실사고)
      B('(주)포스코퓨처엠', '대화산업(주)', '분진(고상)', 1, 10, { side: 'R', row: 14, count_col: 11, item: '분진' }),
      B(TCC[0], TCC[1], TCC[2], 1, 5, null, { reason: 'ITEM_MISMATCH', candidates: [{ side: 'R', row: 36, item: '폐수오니' }] }),
      B('(주)태웅제강', '(주)스틸싸이클', '분진(고상)', 2, 16, { side: 'R', row: 7, count_col: 11, item: 'EAFD(덤프)' }, { vehicle_type: '덤프' }),
      B('(주)태웅제강', '(주)스틸싸이클', '분진(고상)', 1, 10, { side: 'R', row: 6, count_col: 11, item: 'EAFD (BCT차량)' }, { vehicle_type: '트랙터' }),
    ],
    unmatched: [{ from: TCC[0], to: TCC[1], item: TCC[2], n: 1, reason: 'ITEM_MISMATCH', candidates: [{ side: 'R', row: 36, item: '폐수오니' }] }],
    excluded: [{ manf: 'X1', from: 'a', to: 'b', item: 'c', why: '타사 운반(x)', state: '운반중' }],
    pending: [{ manf: 'P1', from: 'a', to: 'b', item: 'c', state: '운반중' }],
    veh_totals: [{ no: '82수1234', n: 7, ton: 61.5, ton_unknown: 0 }], ts: 1, job: 'ab_run_old' });
  const curDoc = (day) => ({ schema: 2, day: day, total: 0, total_qty_ton: 0, qty_unknown: 0, counts: [], unmatched: [], excluded: [], pending: [], veh_totals: [], routes_ver: VER, ts: 1, job: 'ab_run_cur' });
  const find = (doc, from, item, vt) => (doc.counts || []).find((c) => c.from === from && c.item === item && (vt === undefined || c.vehicle_type === vt));
  const keep = (doc) => JSON.stringify([doc.total, doc.total_qty_ton, doc.qty_unknown, doc.excluded, doc.pending, doc.veh_totals, (doc.counts || []).map((c) => JSON.stringify([c.from, c.to, c.item, c.n, c.qty_ton, c.qty_unknown, c.qty_src, c.n_pending, c.manf_nums, c.vehicle_type || null])).sort()]);
  const keepBefore = keep(oldDoc());
  let sets = 0;
  blobsMock.hooks.beforeSet = (k) => { if (String(k).indexOf('allbaro:day:') === 0) sets++; };
  // (a) 옛 규칙 블롭(routes_ver 없음) → ab_day가 그 자리에서 재정렬
  mem.gw_data[dk(D)] = oldDoc();
  mem.gw_data[dk(kst(0))] = curDoc(kst(0));   // 오늘은 이미 현재 노선표로 집계된 빈 문서(mock은 없는 키를 NOT_FOUND로 주므로 심어 둔다)
  let audL = auditMock.logs.length; sets = 0;
  r = await ab({ action: 'ab_day', day: D }, tokA);
  { const b = r.body, lime = find(b, '(주)포스코퓨처엠', '폐석회(고상)'), dust = find(b, '(주)포스코퓨처엠', '분진(고상)'), tcc = find(b, TCC[0], TCC[2]);
    T('(a) ab_day: 옛 규칙(R14 분진·weak) 폐석회 묶음 → R39 폐석회 · weak false · reason/candidates 없음', r.code === 200 && lime && lime.route && lime.route.side === 'R' && lime.route.row === 39 && lime.route.count_col === 11 && lime.route.item === '폐석회' && lime.weak === false && !('reason' in lime) && !('candidates' in lime), JSON.stringify(lime));
    T('(a) 응답·블롭 routes_ver=ROUTES_VER · rematched_at>0 · rematched.changed 1 · 저장 1회', b.routes_ver === VER && b.rematched_at > 0 && b.rematched && b.rematched.changed === 1 && mem.gw_data[dk(D)].routes_ver === VER && mem.gw_data[dk(D)].rematched_at > 0 && sets === 1, JSON.stringify([b.routes_ver, b.rematched, sets]));
    T('(a) n·qty·qty_src·n_pending·manf_nums·total·excluded·pending·veh_totals 불변(응답·블롭)', keep(b) === keepBefore && keep(mem.gw_data[dk(D)]) === keepBefore, '');
    T('(a) 분진 묶음 R14 그대로 · 티씨씨 폐석회는 여전히 미매칭 ITEM_MISMATCH(후보 R36) · unmatched 1건 재생성', dust && dust.route && dust.route.row === 14 && dust.weak === false && tcc && tcc.route === null && tcc.reason === 'ITEM_MISMATCH' && b.unmatched.length === 1 && b.unmatched[0].from === TCC[0] && b.unmatched[0].n === 1 && b.unmatched[0].candidates[0].row === 36, JSON.stringify(b.unmatched));
    T('(a) 감사로그 "재정렬 ' + D + ' 변경 1건 (사유: 노선표)" by 관리자', auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.by === '관리자' && l.ev.some((e) => e.op === '재정렬' && e.id === D && e.t === '재정렬 ' + D + ' 변경 1건 (사유: 노선표)')), JSON.stringify(auditMock.logs.slice(audL).map((l) => l.ev))); }
  // (b) ab_learn(day 지정) → 같은 요청 안에서 그날부터 오늘까지 재정렬
  audL = auditMock.logs.length; sets = 0;
  r = await ab({ action: 'ab_learn', from: TCC[0], to: TCC[1], item: TCC[2], side: 'R', row: 36, day: D }, tokA);
  { const saved = mem.gw_data[dk(D)], tcc = find(saved, TCC[0], TCC[2]);
    T('(b) ab_learn day=' + D + ' → 200 · rematched {days:[D,오늘], changed 1, left []} · 학습 1건', r.code === 200 && r.body.rematched && JSON.stringify(r.body.rematched.days) === JSON.stringify([D, kst(0)]) && r.body.rematched.changed === 1 && Array.isArray(r.body.rematched.left) && r.body.rematched.left.length === 0 && !('failed' in r.body.rematched) && mem.gw_data['allbaro:learned'].items.length === 1, JSON.stringify(r.body.rematched));
    T('(b) 그날 티씨씨 묶음 route R36 · learned true · reason 없음 · unmatched [] · 저장 1회(오늘 문서는 변경 0·routes_ver 같음 → 저장 없음)', tcc && tcc.route && tcc.route.row === 36 && tcc.learned === true && !('reason' in tcc) && saved.unmatched.length === 0 && sets === 1, JSON.stringify(tcc) + '/' + sets);
    T('(b) 감사로그 재정렬 (사유: 학습)', auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.by === '관리자' && l.ev.some((e) => e.op === '재정렬' && e.id === D && e.t === '재정렬 ' + D + ' 변경 1건 (사유: 학습)')), '');
    // (c) 학습과 무관한 묶음 불변
    const lime2 = find(saved, '(주)포스코퓨처엠', '폐석회(고상)'), dust2 = find(saved, '(주)포스코퓨처엠', '분진(고상)');
    T('(c) 학습과 무관한 묶음(폐석회 R39·분진 R14) 불변 · 회수·수량·합계 불변', lime2.route.row === 39 && !lime2.learned && dust2.route.row === 14 && !dust2.learned && keep(saved) === keepBefore, '');
    // (d) 차량 분리 묶음
    T('(d) 차량 분리 묶음(vehicle_type 덤프→R7 · 트랙터→R6) 재정렬 2회 뒤에도 같은 줄', find(saved, '(주)태웅제강', '분진(고상)', '덤프').route.row === 7 && find(saved, '(주)태웅제강', '분진(고상)', '트랙터').route.row === 6, ''); }
  // (d) 차량 종류 미상 서브묶음(vehicle_type 없음)이 옛 저장에서 R7에 붙어 있어도 종전 줄을 붙들지 않는다 + 순수 함수(입력 불변)
  { const input = { counts: [B('(주)태웅제강', '(주)스틸싸이클', '분진(고상)', 1, 8, { side: 'R', row: 7, count_col: 11, item: 'EAFD(덤프)' })], total: 1 };
    const snap = JSON.stringify(input);
    const res = abLib.rematchDoc(input, { learned: [] });
    T('(d) 차량 미상 묶음 → 미매칭 AMBIGUOUS(종전 R7 유지 안 함) · changed 1 · unmatched 1 · 입력 문서 불변(순수 함수) · counts 없는 문서는 ok:false', res.ok && res.changed === 1 && res.doc.counts[0].route === null && res.doc.counts[0].reason === 'AMBIGUOUS' && res.doc.unmatched.length === 1 && res.doc.routes_ver === VER && JSON.stringify(input) === snap && abLib.rematchDoc({ total: 1 }, {}).ok === false, JSON.stringify(res.doc.counts[0])); }
  // (e) 숨긴 노선·직접 추가 블롭 무변경
  T('(e) 숨긴 노선·직접 추가 블롭 무변경(재정렬 2회 뒤) · 학습 블롭은 handleLearn 기존 로직 그대로 1건', JSON.stringify(mem.gw_data['allbaro:routes_hidden']) === hiddenBefore && JSON.stringify(mem.gw_data['allbaro:manual:' + D]) === manualBefore && mem.gw_data['allbaro:learned'].items[0].row === 36, '');
  // (g) routes_ver 같으면 저장 0
  sets = 0;
  r = await ab({ action: 'ab_day', day: D }, tokA);
  T('(g) routes_ver 같은 문서 ab_day → 저장 0 · rematched/stale 없음 · R36 유지', r.code === 200 && sets === 0 && !('rematched' in r.body) && !('stale' in r.body) && find(r.body, TCC[0], TCC[2]).route.row === 36, sets + '/' + JSON.stringify(r.body.rematched));
  r = await ab({ action: 'ab_status' }, tokA);
  T('(g) ab_status(전부 최신) → 저장 0 · stale_days [] · rematched 없음 · days에 D 미배정 0', r.code === 200 && sets === 0 && Array.isArray(r.body.stale_days) && r.body.stale_days.length === 0 && !('rematched' in r.body) && r.body.days.find((x) => x.day === D).unmatched_n === 0, JSON.stringify(r.body.stale_days));
  // 학습 사전을 못 읽으면 재정렬하지 않는다(stale:true·저장 0) — 학습 배정이 풀린 문서 저장 금지
  { const stale = oldDoc(); stale.routes_ver = 'old000000000'; mem.gw_data[dk(D)] = stale; delete mem.gw_data['allbaro:learned']; sets = 0;
    r = await ab({ action: 'ab_day', day: D }, tokA);
    T('학습 블롭 읽기 실패 + stale 문서 → 재정렬 안 함 · stale:true · 저장 0 · 옛 배정 그대로 응답(routes_ver old)', r.code === 200 && r.body.stale === true && !('rematched' in r.body) && sets === 0 && r.body.routes_ver === 'old000000000' && find(r.body, '(주)포스코퓨처엠', '폐석회(고상)').route.row === 14, JSON.stringify([r.body.stale, sets, r.body.routes_ver]));
    r = await ab({ action: 'ab_status' }, tokA);
    T('학습 블롭 읽기 실패 + ab_status → 재정렬 안 함 · stale_days [D] · 저장 0 · days D 미배정 1(옛 값)', r.code === 200 && sets === 0 && JSON.stringify(r.body.stale_days) === JSON.stringify([D]) && !('rematched' in r.body) && r.body.days.find((x) => x.day === D).unmatched_n === 1, JSON.stringify(r.body.stale_days));
    mem.gw_data['allbaro:learned'] = { schema: 1, items: [{ from: TCC[0], to: TCC[1], item: TCC[2], side: 'R', row: 36, by: '관리자', ts: 1 }] };
    r = await ab({ action: 'ab_status' }, tokA);
    T('학습 복구 후 ab_status → stale 1일 재정렬(저장 1·changed 2: 폐석회 R39+티씨씨 R36) · rematched.days [D] · days D 미배정 0(재정렬된 값으로 응답) · stale_days []', r.code === 200 && sets === 1 && r.body.rematched && JSON.stringify(r.body.rematched.days) === JSON.stringify([D]) && r.body.rematched.changed === 2 && r.body.days.find((x) => x.day === D).unmatched_n === 0 && r.body.stale_days.length === 0 && mem.gw_data[dk(D)].routes_ver === VER, JSON.stringify(r.body.rematched) + '/' + sets); }
  // ab_status 상한 7일·stale_days: 오늘~-8 아홉 날을 옛 버전으로 심는다
  { const nine = []; for (let i = 0; i <= 8; i++) nine.push(kst(-i));
    nine.forEach((day) => { const x = oldDoc(day); x.routes_ver = 'old000000000'; mem.gw_data[dk(day)] = x; });
    sets = 0;
    r = await ab({ action: 'ab_status' }, tokA);
    const rm = r.body.rematched || {};
    T('ab_status: stale 9일 → 최신순 7일만 재정렬(저장 7) · stale_days [-7,-8] · 재정렬된 7일은 미배정 0 · 나머지 2일은 옛 값(미배정 1·routes_ver old)', r.code === 200 && sets === 7 && rm.days && rm.days.length === 7 && rm.days[0] === kst(0) && rm.days[6] === kst(-6) && rm.changed === 14 && JSON.stringify(r.body.stale_days) === JSON.stringify([kst(-7), kst(-8)]) && r.body.days.find((x) => x.day === kst(-6)).unmatched_n === 0 && r.body.days.find((x) => x.day === kst(-7)).unmatched_n === 1 && mem.gw_data[dk(kst(-7))].routes_ver === 'old000000000', JSON.stringify([sets, rm.days, rm.changed, r.body.stale_days]));
    sets = 0;
    r = await ab({ action: 'ab_day', day: kst(-8) }, tokA);
    T('ab_day(-8): stale 단일 날짜는 항상 처리 → 저장 1 · routes_ver 갱신 · rematched.changed 2', r.code === 200 && sets === 1 && r.body.routes_ver === VER && r.body.rematched && r.body.rematched.changed === 2 && mem.gw_data[dk(kst(-8))].routes_ver === VER, JSON.stringify([sets, r.body.rematched]));
    sets = 0;
    r = await ab({ action: 'ab_status' }, tokA);
    T('ab_status 재호출: 남은 stale 1일(-7)만 재정렬(저장 1) · stale_days []', r.code === 200 && sets === 1 && JSON.stringify(r.body.rematched.days) === JSON.stringify([kst(-7)]) && JSON.stringify(r.body.stale_days) === '[]', JSON.stringify([sets, r.body.stale_days])); }
  // (f) 시간 가드 — 느린 blobGet(60ms)·예산 200ms로 20일 요청 → 처리한 날짜 + left = 20, left는 요청 순서의 꼬리
  { const twenty = []; for (let i = 19; i >= 0; i--) twenty.push(kst(-i));
    twenty.forEach((day) => { if (!mem.gw_data[dk(day)]) { const x = oldDoc(day); x.routes_ver = 'old000000000'; mem.gw_data[dk(day)] = x; } });
    blobsMock.hooks.beforeGet = (k) => (String(k).indexOf('allbaro:day:') === 0 ? new Promise((res) => setTimeout(res, 60)) : null);
    const t0 = Date.now();
    const rd = await gwab.rematchDays(blobsMock.store('gw_data'), twenty, mem.gw_data['allbaro:learned'].items, { budgetMs: 200, why: '학습', by: '관리자', bid: 'uadmin' });
    const took = Date.now() - t0;
    blobsMock.hooks.beforeGet = null;
    T('(f) 시간 가드: 20일·예산 200ms·읽기 60ms → left ' + rd.left.length + '일 반환 · 처리 ' + rd.days.length + '+left=20 · left는 요청 순서의 꼬리 · failed 0 · ' + took + 'ms', rd.left.length > 0 && rd.days.length > 0 && rd.days.length + rd.left.length === 20 && JSON.stringify(rd.left) === JSON.stringify(twenty.slice(20 - rd.left.length)) && rd.failed.length === 0 && took < 1500, JSON.stringify([rd.days.length, rd.left.length, took]));
    // 같은 20일을 정상 속도로 ab_learn(day=-19) → 창(-19…오늘) 전부 처리(left [])
    sets = 0;
    r = await ab({ action: 'ab_learn', from: TCC[0], to: TCC[1], item: TCC[2], side: 'R', row: 36, day: kst(-19) }, tokA);
    T('(f) ab_learn day=-19 → 20일 창(-19…오늘, 오름차순) 전부 처리 · left [] · 남은 stale 전부 저장(routes_ver 갱신)', r.code === 200 && JSON.stringify(r.body.rematched.days) === JSON.stringify(twenty) && r.body.rematched.left.length === 0 && twenty.every((day) => mem.gw_data[dk(day)].routes_ver === VER), JSON.stringify(r.body.rematched).slice(0, 200)); }
  // day 없음 → 최근 7일 창(오름차순) / day 형식 오류 → 400 BAD_DAY(학습 저장 전 거부)
  r = await ab({ action: 'ab_learn', from: '(주)포스코퓨처엠', to: '대화산업(주)', item: '폐석회(고상)', side: 'R', row: 39, day: '' }, tokA);
  T('ab_learn day 없음 → 최근 7일 창(-6…오늘) · left []', r.code === 200 && r.body.rematched.days.length === 7 && r.body.rematched.days[0] === kst(-6) && r.body.rematched.days[6] === kst(0) && r.body.rematched.left.length === 0, JSON.stringify(r.body.rematched));
  r = await ab({ action: 'ab_learn', from: 'A', to: 'B', item: '', side: 'L', row: 5, day: '2026-13-01' }, tokA);
  T('ab_learn day 형식 오류 → 400 BAD_DAY · 학습 저장 없음(2건 유지)', r.code === 400 && r.body.code === 'BAD_DAY' && mem.gw_data['allbaro:learned'].items.length === 2, r.code + '/' + r.body.code);
  blobsMock.hooks.beforeSet = null;
}


// ===== 34. 직원 등록 권한 v328(PM 9/8 "대표/관리자/개발자 제외한 다른 직책은 관리자도 등록") =====
{
  const gwa34 = require(join(FN, 'gw-auth.js'));
  const callA34 = async (body, tok) => { const x = await gwa34.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const savedUsers = JSON.parse(JSON.stringify(mem.gw_users));
  // 개발자가 있는 상태여야 canDev 부트스트랩(개발자 0명이면 아무 관리자나 개발자 취급)이 꺼진다
  mem.gw_users = {
    'member:udev': { id: 'udev', name: '개발자', role: '개발자', admin: true, dev: true, perms: {}, tier: 'pm' },
    'member:usoo': { id: 'usoo', name: '경리', role: '관리자', admin: true, perms: {}, tier: 'admin' },
    'member:uw1': { id: 'uw1', name: '직원1', role: '직원', admin: false, perms: { tasks: 'do' } },
    'member:ua2': { id: 'ua2', name: '관리자2', role: '관리자', admin: true, perms: {}, tier: 'admin' },
    'device:dev1': { status: 'approved' },
  };
  const tokSoo = issueSession(mem.gw_users['member:usoo']).token;   // 관리자(비개발자) = 나수진 자리
  const tokDev = issueSession(mem.gw_users['member:udev']).token;
  const PRESET_WORKER = { tasks: 'do', veh: 'view', rec: 'view', lic: 'view', check: 'do', con: 'view', cli: 'view', doc: 'view', wk: 'view', quote: 'hide', promo: 'hide' };
  let r34 = await callA34({ action: 'member_upsert', name: '새직원', role: '직원', rank: '사원', dept: '폐기물팀', pin: '1234', hire_date: '2026-09-08', emp_type: '계약직' }, tokSoo);
  const made = Object.values(mem.gw_users).find((x) => x && x.name === '새직원');
  T('관리자(비개발자)가 직원 등록 → 200 · admin false · dev 없음 · 계약직 저장', r34.code === 200 && !!made && made.admin === false && made.dev === undefined && made.role === '직원' && made.emp_type === '계약직', r34.code + '/' + r34.body.error_code);
  T('등록분 perms = 서버 프리셋(클라 값 아님)', !!made && JSON.stringify(made.perms) === JSON.stringify(PRESET_WORKER), made && JSON.stringify(made.perms));
  r34 = await callA34({ action: 'member_upsert', name: '권한도둑', role: '직원', pin: '1234', perms: { tasks: 'do', veh: 'do', rec: 'do', lic: 'do', check: 'do', con: 'do', cli: 'do', doc: 'do', wk: 'do', quote: 'do', promo: 'do' } }, tokSoo);
  const thief = Object.values(mem.gw_users).find((x) => x && x.name === '권한도둑');
  T('관리자가 perms를 직접 실어 보내도(구버전 앱) → 200이되 서버 프리셋으로 덮어씀(권한 도배 차단)', r34.code === 200 && !!thief && JSON.stringify(thief.perms) === JSON.stringify(PRESET_WORKER), r34.code + '/' + (thief && JSON.stringify(thief.perms)));
  r34 = await callA34({ action: 'member_upsert', id: 'uw1', perms: { tasks: 'do', veh: 'do', rec: 'do', lic: 'do', check: 'do', con: 'do', cli: 'do', doc: 'do', wk: 'do', quote: 'do', promo: 'do' } }, tokSoo);
  T('관리자가 기존 회원 perms 편집 → 403 DEV_ONLY(권한관리는 개발자만)', r34.code === 403 && r34.body.error_code === 'DEV_ONLY', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '새관리자', role: '관리자', pin: 'password12' }, tokSoo);
  T('관리자가 관리자 직책 등록 → 403 DEV_ONLY', r34.code === 403 && r34.body.error_code === 'DEV_ONLY', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '새대표', role: '대표', pin: 'password12' }, tokSoo);
  T('관리자가 대표 직책 등록 → 403', r34.code === 403, r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '몰래관리자', role: '직원', pin: '1234', admin: true }, tokSoo);
  T('관리자가 admin:true로 등록 → 403 DEV_ONLY', r34.code === 403 && r34.body.error_code === 'DEV_ONLY', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '몰래개발자', role: '직원', pin: '1234', dev: true }, tokSoo);
  T('관리자가 dev:true로 등록 → 403', r34.code === 403 && r34.body.error_code === 'DEV_ONLY', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '아이디직원', role: '직원', pin: '1234', uid: 'newbie1' }, tokSoo);
  T('관리자가 아이디까지 발급하려 하면 → 403(아이디는 개발자만)', r34.code === 403 && r34.body.error_code === 'DEV_ONLY', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '나종운', role: '직원', pin: '1234' }, tokSoo);
  T('관리자가 예약 이름(나종운)으로 등록 → 403 NAME_RESERVED', r34.code === 403 && r34.body.error_code === 'NAME_RESERVED', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '직원1', role: '직원', pin: '1234' }, tokSoo);
  T('관리자가 기존과 같은 이름으로 등록 → 409 NAME_TAKEN', r34.code === 409 && r34.body.error_code === 'NAME_TAKEN', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', id: 'uw1', role: '팀장' }, tokSoo);
  T('관리자가 직원→팀장 직책 변경 → 200 · perms 보존(권한관리에서만 편집)', r34.code === 200 && mem.gw_users['member:uw1'].role === '팀장' && mem.gw_users['member:uw1'].admin === false, r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', id: 'uw1', role: '관리자' }, tokSoo);
  T('관리자가 직원→관리자 직책 변경 → 403 DEV_ONLY', r34.code === 403 && r34.body.error_code === 'DEV_ONLY' && mem.gw_users['member:uw1'].role === '팀장', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', id: 'ua2', role: '직원' }, tokSoo);
  T('관리자가 다른 관리자의 직책을 일반 직책으로 내리기 → 403(대상이 관리자면 개발자만)', r34.code === 403 && r34.body.error_code === 'DEV_ONLY' && mem.gw_users['member:ua2'].role === '관리자', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', id: 'uw1', name: '직원1개명' }, tokSoo);
  T('관리자가 기존 회원 이름 변경 → 403(종전대로 개발자만)', r34.code === 403 && r34.body.error_code === 'DEV_ONLY', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', id: 'uw1', rank: '주임', annual_days: 15, emp_type: '계약직' }, tokSoo);
  T('관리자의 인사 정보 수정(직급·연차·고용형태)은 종전대로 200', r34.code === 200 && mem.gw_users['member:uw1'].rank === '주임' && mem.gw_users['member:uw1'].emp_type === '계약직', r34.code + '/' + r34.body.error_code);
  r34 = await callA34({ action: 'member_upsert', name: '개발자등록분', role: '관리자', pin: 'password12', admin: true }, tokDev);
  T('개발자는 종전대로 관리자 등록 가능 → 200', r34.code === 200, r34.code + '/' + r34.body.error_code);
  const src34 = require('fs').readFileSync(join(ROOT, 'index.html'), 'utf8');
  const mPre = src34.match(/"직원":\s*\{admin:false, perms:\{([^}]*)\}/);
  const appPerm = mPre ? mPre[1].replace(/\s|"/g, '') : '';
  const srvPerm = Object.keys(PRESET_WORKER).map((k) => k + ':' + PRESET_WORKER[k]).join(',');
  T('앱 ROLE_PRESET(직원) = 서버 ROLE_OPEN_PERMS(직원) — 두 표가 어긋나면 등록분 권한이 화면과 달라진다', appPerm === srvPerm, appPerm + ' vs ' + srvPerm);
  mem.gw_users = savedUsers;
}


// ===== 35. 퇴사직원 분류 v329(PM 9/8) — member_list 퇴사 파생 불리언 / push.sendTo 수신자 활성 필터 / gw-todo-cron 퇴사자 스킵 =====
{
  const gwa35 = require(join(FN, 'gw-auth.js'));
  const callA35 = async (body, tok) => { const x = await gwa35.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const kst35 = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
  const savedUsers35 = JSON.parse(JSON.stringify(mem.gw_users));
  const savedLog35 = mem.gw_data['push:log'], savedSubs35 = mem.gw_data['push:subs'];
  mem.gw_users = {
    'member:uliv': { id: 'uliv', name: '재직', role: '직원', admin: false, perms: {}, hire_date: '2024-01-01', seq: 1 },
    'member:uret': { id: 'uret', name: '퇴사자', role: '직원', admin: false, perms: {}, leave_date: kst35(-1), seq: 2 },   // 어제 퇴사 = 퇴사
    'member:usoon': { id: 'usoon', name: '퇴사예정', role: '직원', admin: false, perms: {}, leave_date: kst35(1), seq: 3 },   // 내일 퇴사 = 아직 재직
    'member:udel35': { id: 'udel35', name: '삭제회원', role: '직원', admin: false, perms: {}, del: 1, seq: 4 },
    'member:uadm35': { id: 'uadm35', name: '관리자35', role: '관리자', admin: true, perms: {}, tier: 'pm', seq: 5 },
    'device:dev1': { status: 'approved' },
  };
  const tokLiv = issueSession(mem.gw_users['member:uliv']).token;
  const tokAdm35 = issueSession(mem.gw_users['member:uadm35']).token;
  const tokRet = issueSession(mem.gw_users['member:uret']).token;
  // ---- member_list: 퇴사자는 계속 내려주되(인사 화면이 그린다) 비관리자에겐 날짜 대신 파생 불리언만 ----
  let r35 = await callA35({ action: 'member_list' }, tokLiv);
  const byId35 = {}; (r35.body.members || []).forEach((m) => { byId35[m.id] = m; });
  T('member_list(비관리자): 퇴사자 포함(목록에서 빼지 않는다) · retired 파생 true · leave_date는 여전히 없음(S7 개인정보 차단 유지)',
    r35.code === 200 && !!byId35.uret && byId35.uret.retired === true && !('leave_date' in byId35.uret) && !('hire_date' in byId35.uret), JSON.stringify(byId35.uret));
  T('member_list(비관리자): 퇴사예정(미래 leave_date)은 retired false — 아직 재직이므로 담당 배정·공개범위에서 걸러지지 않는다', !!byId35.usoon && byId35.usoon.retired === false && !('leave_date' in byId35.usoon), JSON.stringify(byId35.usoon));
  T('member_list: 삭제(del=1) 회원은 종전대로 목록에 없음 · 관리자·본인 레코드는 종전대로 safeMember 전체(leave_date 포함)', !byId35.udel35 && byId35.uliv && byId35.uliv.hire_date === '2024-01-01',
    JSON.stringify(Object.keys(byId35)));
  r35 = await callA35({ action: 'member_list' }, tokAdm35);
  {
    const a35 = (r35.body.members || []).find((m) => m.id === 'uret');
    T('member_list(관리자): 퇴사자 leave_date 종전대로 내려감(인사 탭이 퇴사일·정산을 그린다)', r35.code === 200 && !!a35 && a35.leave_date === kst35(-1), JSON.stringify(a35));
  }
  T('퇴사자 세션은 종전대로 차단(S2-A 무손상) — member_list도 401', (await callA35({ action: 'member_list' }, tokRet)).code === 401, '');
  // ---- 실 push.js sendTo: 수신자 활성 필터(퇴사·삭제·미존재) ----
  {
    const pp = require.resolve(join(FN, '_lib/push.js'));
    const savedPush35 = require.cache[pp]; delete require.cache[pp];
    const realPush35 = require(pp);
    require.cache[pp] = savedPush35;   // 이후 절은 다시 mock
    delete mem.gw_data['push:log'];
    const res35 = await realPush35.sendTo(['uliv', 'uret', 'udel35', 'unknown35', 'usoon'], { title: 't', body: 'b', url: './', tag: 'g' });
    const log35 = (mem.gw_data['push:log'] && mem.gw_data['push:log'].items) || [];
    const last35 = log35[log35.length - 1] || {};
    T('push.sendTo: 퇴사·삭제·미존재 수신자는 발송에서도 알림함(push:log) to에서도 제외 · 재직·퇴사예정은 유지 · skipped 3',
      res35.skipped === 3 && (last35.to || []).join() === 'uliv,usoon' && last35.skipped === 3, JSON.stringify([res35, last35.to, last35.skipped]));
    const res35b = await realPush35.sendTo(['uret'], { title: 'x', body: '', url: './', tag: 'g' }, { logOnly: true });
    const log35b = mem.gw_data['push:log'].items;
    T('push.sendTo(logOnly): 퇴사자만 지정 → 이력 to 빈 목록 · skipped 1 · 발송 0(알림함만 남기는 결재 통지 경로도 같은 필터)',
      res35b.sent === 0 && res35b.skipped === 1 && (log35b[log35b.length - 1].to || []).length === 0 && log35b[log35b.length - 1].skipped === 1, JSON.stringify(res35b));
    const ctx35 = await realPush35.tierCtx();
    const res35c = await realPush35.sendTo(['uret', 'uliv'], { title: 'y', body: '', url: './', tag: 'g' }, { ctx: ctx35 });
    T('push.sendTo(opts.ctx): 호출자가 만든 tierCtx를 재사용해도 같은 필터 결과(회원 재스캔 없음) · skipped 1', res35c.skipped === 1 && (mem.gw_data['push:log'].items.slice(-1)[0].to || []).join() === 'uliv', JSON.stringify(res35c));
    const res35d = await realPush35.sendTo([], { title: 'z', body: '', url: './', tag: 'g' });
    T('push.sendTo([]): 자동상신처럼 대상이 없어도 알림함 이력은 종전대로 남는다(skipped 0)', res35d.skipped === 0 && mem.gw_data['push:log'].items.slice(-1)[0].title === 'z' && mem.gw_data['push:log'].items.slice(-1)[0].skipped === undefined, JSON.stringify(res35d));
    T('activeIdSet: 재직·퇴사예정만 활성 — 퇴사·삭제 제외', (await realPush35.activeIdSet()).uliv === 1 && (await realPush35.activeIdSet()).usoon === 1 && (await realPush35.activeIdSet()).uret === undefined && (await realPush35.activeIdSet()).udel35 === undefined, '');
    // ---- v330: 명부 미가용(gw_users list 실패)은 "전원 퇴사"가 아니다 — 필터를 건너뛴다(fail-open) ----
    // 종전(v329)엔 blobList 한 번이 튀면 members:[] → activeIdSet 빈 집합 → 수신자 전원 탈락 → 결재·운반일지·화관법·개찰·할 일 알림이
    // 그 시간대에 통째로 무음 차단(200 OK / sent:0)됐다. push.js가 blobs를 로드시 구조분해하므로 실패 주입 뒤 모듈을 다시 읽는다.
    {
      const savedList35 = blobsMock.blobList;
      blobsMock.blobList = async (st) => (String(st) === 'gw_users' ? { ok: false, code: 'LIST_FAILED' } : savedList35(st));
      delete require.cache[pp];
      const pushFail35 = require(pp);
      require.cache[pp] = savedPush35;
      T('activeIdSet: 회원 명부를 못 읽으면 null(판정 불가) — 빈 집합과 구분된다', (await pushFail35.activeIdSet()) === null, '');
      delete mem.gw_data['push:log'];
      const res35f = await pushFail35.sendTo(['uliv', 'uret'], { title: 'fo', body: '', url: './', tag: 'g' });
      const last35f = (mem.gw_data['push:log'].items || []).slice(-1)[0] || {};
      T('push.sendTo(명부 미가용): 수신자를 거르지 않고 보낸다(skipped 0 · to 원본 유지) · push:log에 filter_unavailable로 가시화 — 퇴사자 1건이 새는 것보다 회사 전체가 무음이 되는 쪽이 나쁘다',
        res35f.skipped === 0 && (last35f.to || []).join() === 'uliv,uret' && last35f.filter_unavailable === true && last35f.skipped === undefined, JSON.stringify([res35f, last35f.to, last35f.filter_unavailable]));
      const res35g = await pushFail35.sendTo(['uliv'], { title: 'by', body: '', url: './', tag: 'g' }, { by: 'uadm35' });
      T('push.sendTo(opts.by): 발신자 id가 알림함 이력에 남는다(push_send는 임의 제목·본문을 실을 수 있다 — 최소한 누가 쐈는지)',
        res35g.sent === 0 && mem.gw_data['push:log'].items.slice(-1)[0].by === 'uadm35', JSON.stringify(mem.gw_data['push:log'].items.slice(-1)[0]));
      blobsMock.blobList = savedList35;
    }
  }
  // ---- gw-todo-cron: 회원 레코드를 안 읽던 무인 크론에 활성 게이트 ----
  {
    Object.keys(mem.gw_data).forEach((k) => { if (/^priv:[^:]+:mytasks$/.test(k) || /^todo:sent:/.test(k)) delete mem.gw_data[k]; });
    const today35 = kst35(0);
    mem.gw_data['priv:uliv:mytasks'] = { schema: 1, items: [{ id: 'a1', due: today35, text: '재직자 할 일' }] };
    mem.gw_data['priv:uret:mytasks'] = { schema: 1, items: [{ id: 'b1', due: today35, text: '퇴사자가 남긴 할 일' }] };
    mem.gw_data['priv:usoon:mytasks'] = { schema: 1, items: [{ id: 'c1', due: today35, text: '퇴사예정 할 일' }] };
    const cron35 = require(join(FN, 'gw-todo-cron.js'));
    const pc35 = pushMock.calls.length;
    const out35 = JSON.parse((await cron35.handler({})).body || '{}');
    T('gw-todo-cron: 퇴사자는 루프에서 건너뛴다(skipped 1) — 종전엔 priv 블롭 키만 훑어 접근이 막힌 퇴사자 폰이 매일 08시에 울렸다',
      out35.ok === true && out35.skipped === 1 && out35.members === 2 && pushMock.calls.length === pc35 + 2, JSON.stringify(out35));
    T('gw-todo-cron: 퇴사자에겐 todo:sent 기록조차 남기지 않는다(쓰기 절약) · 재직·퇴사예정은 종전대로 발송·기록',
      !mem.gw_data['todo:sent:uret'] && !!mem.gw_data['todo:sent:uliv'] && !!mem.gw_data['todo:sent:usoon'], JSON.stringify(Object.keys(mem.gw_data).filter((k) => k.indexOf('todo:sent:') === 0)));
    {   // v330: 명부 미가용(ctx.unavailable)이면 게이트를 걸지 않는다 — 종전 주석("ctx를 못 만들면 진행")은 tierCtx가 throw하지 않는 이 경로에서 죽은 코드였다
      Object.keys(mem.gw_data).forEach((k) => { if (/^todo:sent:/.test(k)) delete mem.gw_data[k]; });
      const savedTC35 = pushMock.tierCtx;
      pushMock.tierCtx = async () => { const c = tierLib.ctxOf(membersOf()); c.unavailable = true; return c; };
      const pc35b = pushMock.calls.length;
      const out35b = JSON.parse((await cron35.handler({})).body || '{}');
      pushMock.tierCtx = savedTC35;
      T('gw-todo-cron(명부 미가용): 아무도 건너뛰지 않는다(skipped 0 · members 3) — 회원 스토어가 한 번 튀었다고 전원이 스킵되면 그날 아침 알림이 통째로 사라진다',
        out35b.ok === true && out35b.skipped === 0 && out35b.members === 3 && pushMock.calls.length === pc35b + 3, JSON.stringify(out35b));
    }
    Object.keys(mem.gw_data).forEach((k) => { if (/^priv:[^:]+:mytasks$/.test(k) || /^todo:sent:/.test(k)) delete mem.gw_data[k]; });
  }
  mem.gw_users = savedUsers35;
  if (savedLog35 === undefined) delete mem.gw_data['push:log']; else mem.gw_data['push:log'] = savedLog35;
  if (savedSubs35 === undefined) delete mem.gw_data['push:subs']; else mem.gw_data['push:subs'] = savedSubs35;
}

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n서버 테스트 전 항목 통과 (' + pass + ')');process.exit(fail ? 1 : 0);
