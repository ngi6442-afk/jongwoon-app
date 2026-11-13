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
// v453 키 이름 검사 — 실 blobs.js와 같은 함수(_lib/blobkey.js, 의존성 없음)를 mock get·set·delete도 거친다(점 경로·제어문자 키가 mock에선 그냥 써지던 차이 메움 — 절 85 ⑨)
const { badBlobKey } = require(join(FN, '_lib/blobkey.js'));
// store()는 이름으로 좌표되는 객체(toString=이름) — gw-auth listMembers가 st.list({prefix})를 직접 부르므로(v321 등급 테스트) list도 흉내낸다. mem[st]는 toString으로 좌표된다
const blobsMock = {
  hooks: { beforeGet: null, beforeSet: null },   // 절 33(v327) — 느린 읽기(시간 가드)·저장 횟수 검증용 훅. 없으면 무동작
  setupBlobContext() {},
  store(n) { mem[n] = mem[n] || {}; return { name: n, toString() { return n; }, async list(o) { const pre = (o && o.prefix) || ''; return { blobs: Object.keys(mem[n] || {}).filter((k) => k.indexOf(pre) === 0).map((k) => ({ key: k })) }; } }; },
  async blobGet(st, k) { if (badBlobKey(k)) return { ok: false, code: 'STORAGE_BAD_KEY' }; const fg = blobsMock.hooks.failGet && blobsMock.hooks.failGet(k); if (fg) return { ok: false, code: typeof fg === 'string' ? fg : 'STORAGE_READ_FAILED' }; /* v453 검토: failGet이 글자를 돌려주면 그 코드(예: 'STORAGE_PARSE_FAILED' — 실 blobs.js의 깨진 JSON) */ if (blobsMock.hooks.beforeGet) await blobsMock.hooks.beforeGet(k); const s = mem[st] || {}; return (k in s) ? { ok: true, data: JSON.parse(JSON.stringify(s[k])) } : { ok: false, code: 'NOT_FOUND' }; },   // 실 Blobs처럼 get마다 새 객체(JSON 파싱) — 핸들러가 저장 전 객체를 손대도 mem에 반영되지 않는다(9/6: 거부 응답 뒤 "저장 없음" 검증의 전제)
  async blobSet(st, k, v) { if (badBlobKey(k)) return { ok: false, code: 'STORAGE_BAD_KEY' }; if (blobsMock.hooks.failSet && blobsMock.hooks.failSet(k)) return { ok: false, code: 'STORAGE_WRITE_FAILED' }; if (blobsMock.hooks.beforeSet) await blobsMock.hooks.beforeSet(k); mem[st] = mem[st] || {}; if (v === null) delete mem[st][k]; else mem[st][k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
  async blobDelete(st, k) { if (badBlobKey(k)) return { ok: false, code: 'STORAGE_BAD_KEY' }; if (mem[st]) delete mem[st][k]; return { ok: true }; },
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
const auditMock = { logs: [], async appendAudit(e) { auditMock.logs.push(e); }, auditKey: () => auditMock.curKey || 'audit', diffItems: () => [], short: (s) => String(s).slice(0, 20), DATA: 'gw_data',
  MAX_PER_MONTH: 8000, curKey: '' };   // v453: MAX_PER_MONTH(실 audit.js와 같은 값 — 절 85가 실 파일 값과 대조) · curKey = 이번 달 키 흉내(비면 종전 'audit')
// v364 얼굴 검출기 mock — 기본은 '못 실림'(throw) → 워커가 종전(Claude 전부)으로 내려가므로 절 41은 그대로. 절 44에서 켜서 검출기 경로·폴백을 검사한다. 실제 모델 정확도는 tools/facedet_check.mjs(실사진 게이트).
const faceMock = { fail: true, boxes: [], calls: 0, async detectFaces() { faceMock.calls++; if (faceMock.fail) throw (faceMock.fail instanceof Error ? faceMock.fail : new Error('MODELS_MISSING')); return { boxes: faceMock.boxes.map((b) => Object.assign({}, b)), w: 600, h: 400, ms: 1, diag: { passes: 12, raw: faceMock.boxes.length, clusters: faceMock.boxes.length, dropped: 0, big: 0, pose: true } }; } };
// v371 번호판 검출기 mock — 기본은 '못 실림'(MODELS_MISSING) → 워커가 종전 번호판 경로(전체 사진 1회)로 내려가므로 절 41·44는 그 기준. 절 45에서 켜서 platedet 경로·폴백·재감지를 검사한다. 실사진 정확도는 tools/platedet_check.mjs.
const plateMock = { fail: true, boxes: [], calls: 3, count: 0, async detectPlates() { plateMock.count++; if (plateMock.fail) throw (plateMock.fail instanceof Error ? plateMock.fail : new Error('MODELS_MISSING')); return { boxes: plateMock.boxes.map((b) => Object.assign({}, b)), vehicles: [{ cls: 'car', score: 0.9, x: 0.6, y: 0.6, w: 0.3, h: 0.3, votes: 4 }], calls: plateMock.calls, usage: { input: 300, output: 30 }, ms: 5, diag: { veh: 1, crops: 1, verified: plateMock.boxes.length, band: 0, fallback: 1, grown: 0, small: 0 } }; } };
for (const [p, m] of [['_lib/blobs.js', blobsMock], ['_lib/push.js', pushMock], ['_lib/audit.js', auditMock], ['_lib/facedet.js', faceMock], ['_lib/platedet.js', plateMock]]) {
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
//    v430(메뉴 56 3단계): 키가 hr → safety(권한관리 '안전' 열)로 바뀌었다. 안전 권한을 받지 않은 직원은 여전히 403(safety도 기본 숨김) — 보기/수행 짝은 절 76
r = await call({ action: 'get', collection: 'edu' }, tokW, 'dev1');
T('비관리자 edu(safety 미지정) → 403 NO_ACCESS(기본 숨김)', r.code === 403 && r.body.error_code === 'NO_ACCESS', r.code + '/' + r.body.error_code);
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
// v422 준설 실물 양식 키 — 등록·목록·받기
r = await call({ action: 'tpl_put', key: 'safety_plan', name: '안전보건관리계획서.hwpx', data: 'AAAA' }, tokA);
{
  const r1 = r, r2 = await call({ action: 'tpl_list' }, tokA), r3 = await call({ action: 'tpl_get', key: 'safety_plan' }, tokA);
  const t2 = (r2.body && r2.body.templates) || {}, ks = Object.keys(t2);
  T('v422 tpl_put 새 키 200 · tpl_list에 이름 · 21키 전부 응답(미등록 null) · 순서 = 등록표 · tpl_get 본문', r1.code === 200 && r2.code === 200 && t2.safety_plan && t2.safety_plan.name === '안전보건관리계획서.hwpx' && ks.length === 21 && t2.labor_split === null && ks[0] === 'asb_plan' && ks[ks.length - 1] === 'labor_split' && r3.code === 200 && r3.body.data === 'AAAA', JSON.stringify([r1.code, r2.code, r2.body && r2.body.error_code, r3.code, ks]));
  delete mem.gw_files['tpl:safety_plan'];
}
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
const pcBot13 = pushMock.calls.length;   // v414: 앞 절 leaves 저장이 휴가 신청 알림 1건을 남긴다 → 증분으로
r = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '테스트', body: 'b' });
T('bot_notify → sent=실발송 수', r.code === 200 && r.body.sent === 1 && pushMock.calls.length === pcBot13 + 1, JSON.stringify(r.body));

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
  const T10 = Date.now() + 60000;   // 10/11 수리: 고정 날짜('2026-10-10')는 실제 시각이 지나자 pn4(ai.ts=Date.now())보다 과거가 돼 10/10부터 2건이 깨졌다(검토 확정) — 항상 '지금보다 뒤'로
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
  audL = auditMock.logs.length;
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokW, 'dev1');
  T('ab_route_hide 부서 없는 직원 → 403 FORBIDDEN · 저장 없음 · 감사로그 노선숨김거부(v386)', r.code === 403 && r.body.code === 'FORBIDDEN' && hidden().length === 0 && auditMock.logs.slice(audL).some((l) => l.ev[0].op === '노선숨김거부'), r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokX, 'dev1');
  T('ab_route_hide 타 부서(관리부) 직원 → 403 FORBIDDEN', r.code === 403 && r.body.code === 'FORBIDDEN' && hidden().length === 0, r.code + '/' + r.body.code);
  audL = auditMock.logs.length;
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: true }, tokO, 'dev1');
  T('ab_route_hide 운영부 직원 숨김 → 200 changed · 숨긴 사람 운영부원 · 감사로그 노선숨김(v386 PM 10/14 "운영부까지 숨김·해제")', r.code === 200 && r.body.changed === true && hidden().length === 1 && hidden()[0].by === '운영부원' && auditMock.logs.slice(audL).some((l) => l.by === '운영부원' && l.ev[0].op === '노선숨김'), r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: false }, tokO, 'dev1');
  T('ab_route_hide 운영부 직원 해제 → 200 changed · 블롭 비움', r.code === 200 && r.body.changed === true && hidden().length === 0, r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 5, hide: false }, tokO, 'devX');
  T('ab_route_hide 운영부라도 미승인 기기 → 403 DEVICE_NOT_APPROVED', r.code === 403 && r.body.code === 'DEVICE_NOT_APPROVED', r.code + '/' + r.body.code);
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

// ===== 32b. v357 잠정 행에 인계일자(date) 동봉 — 앱이 경과일을 세어 '3일+ 미확정'을 드러낸다(PM 9/14 "9/11 동일→스틸 1대인데 2대"). 계수는 그대로 =====
{
  const abLib = require(join(FN, '_lib/allbaro.js'));
  const base = { emis: '동일산업(주)', trtm: '(주)스틸싸이클', wasteName: '분진(고상)', date: '20260911', state: '운반중', tranFirm: '종운환경(주)', tranVehicle: '경북80사1234' };
  const rows = [Object.assign({}, base, { manf: '2609524417', confirmedAt: '' }), Object.assign({}, base, { manf: '2609599999', confirmedAt: '20260911 16:39' })];
  const agg = abLib.aggregate(rows, '2026-09-11', {});
  const nSum = (agg.counts || []).reduce((s, c) => s + (Number(c.n) || 0), 0);
  T('aggregate: 확정 없는 행만 pending · date=인계일자 8자리 · manf 동봉 · 계수 n 합계 2(잠정 포함 규칙 불변)',
    Array.isArray(agg.pending) && agg.pending.length === 1 && agg.pending[0].date === '20260911' && agg.pending[0].manf === '2609524417' && nSum === 2, JSON.stringify(agg.pending) + ' n=' + nSum);
}

// ===== 32c. v366 재발방지 — 표기 변형(variant) 판정·집계·재판정 + 워커 잠정/변형 알림(운영부+PM, 1회) =====
{
  const abLib = require(join(FN, '_lib/allbaro.js'));
  const ITEM = '폐양극활물질(양극재 또는 전구체 제조공정에서 발생하는 것을 포함한다)(고상)';
  const prevExtra = ((mem.gw_data['allbaro:routes_extra'] || {}).items) || [];
  abLib.setExtraRoutes(prevExtra);
  const cam = abLib.matchRouteEx({ from: '에코프로비엠(CAM4)', to: '주식회사 에코프로씨엔지', item: ITEM }, {});
  const base = abLib.matchRouteEx({ from: '(주)에코프로비엠', to: '주식회사 에코프로씨엔지', item: ITEM }, {});
  T('variant: 구체 줄이 없을 때 CAM4 → L34 배정 + variant:true · 본체 이름은 variant:false · 미매칭/학습 반환에도 variant 필드', !!cam.route && cam.route.row === 34 && cam.variant === true && !!base.route && base.variant === false && abLib.matchRouteEx({ from: '없는곳', to: '없는곳', item: 'x' }, {}).variant === false, JSON.stringify([cam.variant, base.variant]));
  const rowBase = { trtm: '주식회사 에코프로씨엔지', wasteName: ITEM, date: '20260917', state: '운반중', tranFirm: '종운환경(주)', tranVehicle: '92모4921', confirmedAt: '20260917 15:00' };
  const rows = [Object.assign({}, rowBase, { emis: '(주)에코프로비엠', manf: '2609510222', tranQty: '0.41' }), Object.assign({}, rowBase, { emis: '에코프로비엠(CAM4)', manf: '2609510246', tranQty: '5.37' })];
  const agg = abLib.aggregate(rows, '2026-09-17', {});
  const cB = (agg.counts || []).find((c) => c.from === '(주)에코프로비엠'), cC = (agg.counts || []).find((c) => c.from === '에코프로비엠(CAM4)');
  T('aggregate: 두 묶음 모두 L34 · CAM4 묶음에만 variants ["에코프로비엠(CAM4)"] · 본체 묶음엔 variants 없음', cB && cC && cB.route && cB.route.row === 34 && cC.route && cC.route.row === 34 && !cB.variants && Array.isArray(cC.variants) && cC.variants[0] === '에코프로비엠(CAM4)', JSON.stringify([cB && cB.variants, cC && cC.variants]));
  abLib.setExtraRoutes(prevExtra.concat([{ side: 'L', row: 43, from: '에코프로비엠(CAM4)', to: '주식회사 에코프로씨엔지', item: '폐양극활물질', count_col: 5 }]));
  const rm = abLib.rematchDoc(agg, { learned: [] });
  const rC = (rm.doc.counts || []).find((c) => c.from === '에코프로비엠(CAM4)'), rB = (rm.doc.counts || []).find((c) => c.from === '(주)에코프로비엠');
  T('rematchDoc: CAM4 줄이 생기면 CAM4 묶음 → L43·variants 삭제(changed 1) · 본체 묶음 L34 그대로', rm.ok && rm.changed === 1 && rC && rC.route.row === 43 && !rC.variants && rB && rB.route.row === 34 && !rB.variants, JSON.stringify([rm.changed, rC && rC.route, rC && rC.variants]));
  abLib.setExtraRoutes(prevExtra);
  // 워커 알림 — 순수 함수 + 인메모리 blob/push mock
  const wk = require(join(FN, 'gw-allbaro-run-background.js'));
  T('opsPmIds: 운영부 + pm 합집합(중복 제거) · 둘 다 없으면 관리자', wk.opsPmIds({ members: [{ id: 'o1', dept: '운영부' }, { id: 'o2', dept: '관리부' }, { id: 'p1', dept: '운영부' }], pmIds: ['p1', 'p2'], adminIds: ['a1'] }).sort().join() === 'o1,p1,p2' && wk.opsPmIds({ members: [], pmIds: [], adminIds: ['a1'] }).join() === 'a1', '');
  const kst = (o) => new Date(Date.now() + 9 * 3600000 + (o || 0) * 86400000).toISOString().slice(0, 10);
  const stD = { name: 'gw_data', toString() { return 'gw_data'; } };
  delete mem.gw_data[wk.PEND_KEY]; delete mem.gw_data[wk.VAR_KEY];
  const docs = [
    { day: kst(-1), counts: [{ from: '에코프로비엠(CAM4)', to: 'x', item: 'y', route: { side: 'L', row: 34 }, variants: ['에코프로비엠(CAM4)'] }], pending: [{ manf: '2609747334', from: '동일산업(주)', to: '스틸싸이클 주식회사', item: '분진(고상)', state: '운반중', date: '20260917' }] },
    { day: kst(0), counts: [], pending: [{ manf: '999', from: '오늘', to: '오늘', item: 'z' }] },
  ];
  const tcT = { members: [{ id: 'o1', dept: '운영부' }], pmIds: ['p1'], adminIds: ['a1'] };
  const before = pushMock.calls.length;
  const n1 = await wk.notifyPendingAndVariants(stD, docs, tcT);
  const sent = pushMock.calls.slice(before);
  T('알림 1회차: 어제 잠정 1건 → 푸시 1(tag allbaro-pend-<day>, 제목에 "예약 밀림") · 오늘 날짜 잠정은 제외 · 표기 변형 1 → 푸시 1 · 표식 2개 저장', n1.pend_days === 1 && n1.pend_n === 1 && n1.var_n === 1 && sent.length === 2 && sent[0].tag === 'allbaro-pend-' + kst(-1) && /예약 밀림/.test(sent[0].title) && /2609747334/.test(sent[0].body) && /표기 변형/.test(sent[1].title) && /L34/.test(sent[1].body) && mem.gw_data[wk.PEND_KEY].keys[kst(-1) + '|2609747334'] === kst(0) && Object.keys(mem.gw_data[wk.VAR_KEY].keys).length === 1, JSON.stringify([n1, sent.map((p) => p.title)]));
  const n2 = await wk.notifyPendingAndVariants(stD, docs, tcT);
  T('알림 2회차(같은 날 재수집·08:20 백업 기동): 표식으로 중복 발송 0', n2.pend_n === 0 && n2.var_n === 0 && pushMock.calls.length === before + 2, JSON.stringify(n2));
  blobsMock.hooks.beforeGet = async (k) => { if (k === wk.PEND_KEY) throw new Error('down'); };
  let n3 = null; try { n3 = await wk.notifyPendingAndVariants(stD, [{ day: kst(-2), counts: [], pending: [{ manf: '777', from: 'a', to: 'b' }] }], tcT); } catch (e) { n3 = { threw: true }; }
  blobsMock.hooks.beforeGet = null;
  T('표식 blob 읽기 예외는 위로 던져 워커가 삼킨다(발송 없음) — 매일 다시 쏘는 쪽이 더 나쁨', n3 && n3.threw === true && pushMock.calls.length === before + 2, JSON.stringify(n3));
  delete mem.gw_data[wk.PEND_KEY]; delete mem.gw_data[wk.VAR_KEY];
}

// ===== 32d. v368 무기계약직 레이더 — contractPlan 순수 함수(기간제법 4조: 2년 시계·55세 예외·단계 멱등) =====
{
  const dc = require(join(FN, 'gw-duty-cron.js'));
  const M = [
    { id: 'c_exempt', name: '박국진', emp_type: '계약직', hire_date: '2025-09-01', birth: '1964-08-07' },     // 입사 시 61세 → 예외
    { id: 'c_due', name: '정수현', emp_type: '계약직', hire_date: '2025-12-29', birth: '1978-01-09' },        // 전환일 2027-12-29
    { id: 'c_unknown', name: '정재욱', emp_type: '계약직', hire_date: '2026-09-17' },                        // 생년월일 없음
    { id: 'c_reg', name: '정규', emp_type: '정규직', hire_date: '2020-01-01', birth: '1990-01-01' },
    { id: 'c_ret', name: '퇴사', emp_type: '계약직', hire_date: '2025-01-01', birth: '1990-01-01', leave_date: '2026-01-31' },
    { id: 'c_leap', name: '윤년', emp_type: '계약직', hire_date: '2024-02-29', birth: '1990-01-01' },         // 전환일 2026-02-28
  ];
  const sentD = { schema: 1, keys: {} };
  let it = dc.contractPlan(M, sentD, '2027-11-01');
  T('contractPlan 2027-11-01: 정수현 D-58 → d90 · 예외(61세)·정규직·퇴사자·윤년(이미 초과 → over) 처리', it.length === 2 && it[0].id === 'c_leap' && it[0].stage === 'over' && it[1].id === 'c_due' && it[1].stage === 'd90' && it[1].days === 58 && it[1].conv === '2027-12-29', JSON.stringify(it));
  it.forEach((x) => { sentD.keys[x.key] = '2027-11-01'; });
  it = dc.contractPlan(M, sentD, '2027-11-02');
  T('다음 날: d90은 회차 1회라 다시 안 뜨고 over는 매일(윤년 건만)', it.length === 1 && it[0].id === 'c_leap' && it[0].stage === 'over', JSON.stringify(it));
  it = dc.contractPlan(M, sentD, '2027-12-10');
  T('2027-12-10: 정수현 D-19 → d30(새 단계라 다시 알림)', it.some((x) => x.id === 'c_due' && x.stage === 'd30' && x.days === 19), JSON.stringify(it));
  it = dc.contractPlan(M, sentD, '2028-01-05');
  T('2028-01-05: 정수현 2년 초과 7일 → over', it.some((x) => x.id === 'c_due' && x.stage === 'over' && x.days === -7), JSON.stringify(it));
  it = dc.contractPlan(M, { keys: {} }, '2028-07-01');
  T('생년월일 없는 계약직은 90일 이내에 unknown 1회(정재욱 D-78)', it.some((x) => x.id === 'c_unknown' && x.stage === 'unknown' && x.days === 78), JSON.stringify(it));
  const cb = dc.contractBody([{ name: '정수현', conv: '2027-12-29', days: 19, stage: 'd30' }, { name: '윤년', conv: '2026-02-28', days: -600, stage: 'over' }]);
  T('contractBody: 제목 "무기계약 전환 시계 — 2명" · 본문 D-19·2년 초과 600일·노무사 확인', /2명/.test(cb.title) && /정수현 D-19\(2027-12-29\)/.test(cb.body) && /윤년 2년 초과 600일/.test(cb.body) && /노무사/.test(cb.body), cb.body);
  // 크론 통합: 인허가 0건 + 계약직 알림 1건 → PM에게 1발(tag ct-<today>) · duty:sent에 ct 키 기록
  {
    mem.gw_data['col:licenses'] = { schema: 1, duties: [], items: [] }; delete mem.gw_data['duty:sent'];
    mem.gw_users['member:c_due2'] = { id: 'c_due2', name: '정수현', role: '직원', emp_type: '계약직', hire_date: '2025-12-29', birth: '1978-01-09', perms: {} };
    const before = pushMock.calls.length;
    const realNow = Date.now; Date.now = () => new Date('2027-12-10T00:00:00Z').getTime() + 3600000;   // KST 2027-12-10 10:00
    let r0 = null; try { r0 = await dc.handler({}); } finally { Date.now = realNow; }
    const b0 = JSON.parse(r0.body); const sentAfter = pushMock.calls.slice(before);
    T('duty 크론 통합: 인허가 0·계약직 1 → ct 1·발송 1(tag ct-2027-12-10, 제목 "무기계약 전환 시계") · duty:sent에 ct: 키', b0.ct === 1 && sentAfter.length === 1 && sentAfter[0].tag === 'ct-2027-12-10' && /무기계약 전환 시계/.test(sentAfter[0].title) && Object.keys((mem.gw_data['duty:sent'] || { keys: {} }).keys).some((k) => k.indexOf('ct:c_due2:2027-12-29:d30') === 0), JSON.stringify(b0) + ' ' + JSON.stringify(sentAfter.map((p) => p.title)));
    delete mem.gw_users['member:c_due2']; delete mem.gw_data['duty:sent'];
  }
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
  const PRESET_WORKER = { tasks: 'do', veh: 'view', rec: 'view', lic: 'view', site: 'hide', check: 'do', con: 'view', cli: 'view', doc: 'view', wk: 'view', quote: 'hide', promo: 'hide', safety: 'hide', hw: 'hide', stmt: 'hide' };   // v430 safety(안전 › 교육·검진)·v431 hw(화관법)·29 판② stmt(월말명세서) 끝에 — cleanPerms 순서 = gw-auth MODULES
  let r34 = await callA34({ action: 'member_upsert', name: '새직원', role: '직원', rank: '사원', dept: '폐기물팀', pin: '1234', hire_date: '2026-09-08', emp_type: '계약직' }, tokSoo);
  const made = Object.values(mem.gw_users).find((x) => x && x.name === '새직원');
  T('관리자(비개발자)가 직원 등록 → 200 · admin false · dev 없음 · 계약직 저장', r34.code === 200 && !!made && made.admin === false && made.dev === undefined && made.role === '직원' && made.emp_type === '계약직', r34.code + '/' + r34.body.error_code);
  T('등록분 perms = 서버 프리셋(클라 값 아님)', !!made && JSON.stringify(made.perms) === JSON.stringify(PRESET_WORKER), made && JSON.stringify(made.perms));
  r34 = await callA34({ action: 'member_upsert', name: '권한도둑', role: '직원', pin: '1234', perms: { tasks: 'do', veh: 'do', rec: 'do', lic: 'do', check: 'do', con: 'do', cli: 'do', doc: 'do', wk: 'do', quote: 'do', promo: 'do', safety: 'do', hw: 'do' } }, tokSoo);   // v430 safety·v431 hw도 실어 보냄 — 서버 프리셋(숨김)으로 덮여야 한다
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

// ---- 36 주기업무 공개범위 롤백(v331, 2026-09-08 PM 실사고 재현) ----
// 실사고: 관리자가 공개범위 6건을 "전체공개"로 비운 직후, 그날 오전부터 켜둔 직원 탭이 체크박스를 하나 누른 것만으로
//         6건이 전부 부활했다(ver:checklist 17:27~17:34 실측 — 라이브가 8/11 상태로 회귀). 저장이 문서 통째 PUT이라
//         직원 payload에 그 탭의 낡은 scopes 지도가 통째로 실려 나간 것. 서버는 그것을 아무 저항 없이 받아썼다.
{
  const admScopes = { m1: ['uwork'], q1: ['uadmin'] };
  const admAsg = { m1: 'uwork' };
  // 주기업무 저장 권한(check='do')을 가진 **비관리자** — 실사고의 그 계정 형태(관리자가 아니지만 체크는 누른다)
  const WORKC = { id: 'uchk', name: '주기직원', admin: false, perms: { check: 'do' } };
  mem.gw_users['member:uchk'] = WORKC;
  const tokC = issueSession(WORKC).token;
  const seed = () => { mem.gw_data['col:checklist'] = { records: { m: { '2026-09': { m1: '2026-09-08' } } }, custom: {}, scopes: JSON.parse(JSON.stringify(admScopes)), assignee: JSON.parse(JSON.stringify(admAsg)), scope_ts: { m1: 500 }, updated_at: 7100 }; };
  seed();
  auditMock.logs.length = 0;
  // 직원(비관리자)이 체크 하나를 누르며 그 탭의 낡은 지도를 함께 올린다 — 관리자가 지운 q2를 되살리고 m1을 옛 값으로 되돌리려 한다
  r = await call({ action: 'save', collection: 'checklist', base: 7100, doc: {
    records: { m: { '2026-09': { m1: '2026-09-08', m2: '2026-09-08' } } }, custom: {},
    scopes: { m1: ['uOLD'], q1: ['uadmin'], q2: ['uOLD'] }, assignee: { m1: 'uOLD' }, scope_ts: {},
  } }, tokC, 'dev1');
  {
    const saved = mem.gw_data['col:checklist'];
    T('checklist: 비관리자 저장이 공개범위를 되돌리지 못한다 — 서버 원본 이월(지운 q2 부활 없음 · m1 옛 값 복귀 없음)',
      r.code === 200 && !saved.scopes.q2 && JSON.stringify(saved.scopes.m1) === JSON.stringify(['uwork']) && Object.keys(saved.scopes).length === 2, JSON.stringify(saved.scopes));
    T('checklist: 비관리자 저장이 담당(assignee)도 되돌리지 못한다', saved.assignee.m1 === 'uwork', JSON.stringify(saved.assignee));
    T('checklist: 편집시각 사이드카(scope_ts)도 함께 이월 — 지도만 지키면 다음 병합이 다시 어긋난다', saved.scope_ts && saved.scope_ts.m1 === 500, JSON.stringify(saved.scope_ts));
    T('checklist: 그래도 그 직원의 체크 자체는 정상 저장된다(거부가 아니라 재구성인 이유)',
      !!(saved.records && saved.records.m && saved.records.m['2026-09'] && saved.records.m['2026-09'].m2), JSON.stringify(saved.records));
    const ev = (auditMock.logs.filter((l) => l.col === 'checklist').pop() || {}).ev || [];
    T('checklist: 되돌리려던 시도가 감사로그에 남는다(공개범위 보호) — 낡은 사본을 쓰는 사람을 찾아낼 수 있게',
      ev.some((e) => e.op === '공개범위 보호'), JSON.stringify(ev));
  }
  // 관리자는 종전대로 공개범위를 바꿀 수 있고, 그 변경이 감사로그에 남는다(종전엔 한 줄도 안 남았다)
  seed();
  auditMock.logs.length = 0;
  r = await call({ action: 'save', collection: 'checklist', base: 7100, doc: {
    records: {}, custom: {}, scopes: { q1: ['uadmin'] }, assignee: {}, scope_ts: { m1: 9000 },
  } }, tokA);
  {
    const saved = mem.gw_data['col:checklist'];
    const ev = (auditMock.logs.filter((l) => l.col === 'checklist').pop() || {}).ev || [];
    T('checklist: 관리자의 공개범위 삭제는 그대로 반영된다(전체공개 전환 — 이게 9/8에 매번 되돌아가던 편집)',
      r.code === 200 && !saved.scopes.m1 && Object.keys(saved.scopes).length === 1, JSON.stringify(saved.scopes));
    T('checklist: 관리자 삭제 스탬프(툼스톤 scope_ts)가 서버에 보존돼 다른 기기로 삭제가 전파된다', saved.scope_ts && saved.scope_ts.m1 === 9000, JSON.stringify(saved.scope_ts));
    T('checklist: 공개범위·담당 변경이 감사로그에 남는다',
      ev.some((e) => e.op === '공개범위') && ev.some((e) => e.op === '담당') && !ev.some((e) => e.op === '공개범위 보호'), JSON.stringify(ev));
  }
  // 직전 문서를 못 읽으면 이월 판단 자체가 불가 → 저장 거부(fail-open이면 원 결함이 그대로 재발)
  seed();
  {
    // blobGet은 gw-data.js가 모듈 로드 시 구조분해로 묶어 두므로 mock 함수를 갈아끼워도 안 먹는다 — 이 mock이 그래서 hooks.beforeGet을 둔다
    blobsMock.hooks.beforeGet = (k) => { if (k === 'col:checklist') throw new Error('READ_FAILED'); };
    r = await call({ action: 'save', collection: 'checklist', doc: { records: {}, custom: {}, scopes: {} } }, tokC, 'dev1');
    blobsMock.hooks.beforeGet = null;
    T('checklist: 비관리자 저장 중 직전 문서 읽기 실패 → 500 PREV_READ_FAILED(이월 불가 시 fail-closed · licenses·documents와 같은 원칙)',
      r.code === 500 && r.body.error_code === 'PREV_READ_FAILED', r.code + '/' + r.body.error_code);
    T('checklist: 그 거부로 서버 문서가 손상되지 않았다(공개범위 원본 유지)',
      JSON.stringify(mem.gw_data['col:checklist'].scopes) === JSON.stringify(admScopes), JSON.stringify(mem.gw_data['col:checklist'].scopes));
  }
  // 구버전 앱(v330 이하)의 관리자 저장 — 사이드카를 아예 모른다. 그 저장이 툼스톤을 지우면 낡은 사본이 다시 키를 되살린다(= 재발).
  seed();
  r = await call({ action: 'save', collection: 'checklist', base: 7100, doc: { records: {}, custom: {}, scopes: { m1: ['uwork'], q1: ['uadmin'] }, assignee: {} } }, tokA);
  T('checklist: 사이드카를 모르는 구버전 앱의 저장도 툼스톤(scope_ts)을 지우지 못한다 — 서버가 원본을 이월',
    r.code === 200 && mem.gw_data['col:checklist'].scope_ts && mem.gw_data['col:checklist'].scope_ts.m1 === 500, JSON.stringify(mem.gw_data['col:checklist'].scope_ts));
  // 오프라인 캐시로 부팅해 빈 사이드카를 올리는 사본도 마찬가지
  r = await call({ action: 'save', collection: 'checklist', base: mem.gw_data['col:checklist'].updated_at, doc: { records: {}, custom: {}, scopes: { q1: ['uadmin'] }, assignee: {}, scope_ts: {} } }, tokA);
  T('checklist: 빈 사이드카를 올리는 사본도 툼스톤을 지우지 못한다(서버에서 줄지 않음)',
    r.code === 200 && mem.gw_data['col:checklist'].scope_ts.m1 === 500, JSON.stringify(mem.gw_data['col:checklist'].scope_ts));
  delete mem.gw_data['col:checklist'];
  delete mem.gw_users['member:uchk'];
}

// ---- 37 주기업무 완료요청 툼스톤(v332) ----
// v331은 review를 {type:{periodKey:{itemId}}} 3층이라는 이유로 평면 스탬프 병합에서 제외했다. 그 사이 프런트는 Object.assign으로
// '타입' 한 층만 얕게 합쳤고, 그래서 ①관리자가 승인·반려로 지운 요청이 낡은 탭에서 부활하고 ②남이 방금 올린 요청이 내 저장에 증발했다.
// 프런트는 3층 mergeReview로 고쳤고, 서버 몫은 하나다: review_ts(툼스톤)를 절대 줄이지 않기. 줄면 다음 병합에서 부활이 다시 시작된다.
// review 본체는 종전대로 이월하지 않는다 — 완료요청은 직원이 정상적으로 쓰는 필드다.
{
  const WORKR = { id: 'urev', name: '완료요청직원', admin: false, perms: { check: 'do' } };
  mem.gw_users['member:urev'] = WORKR;
  const tokR = issueSession(WORKR).token;
  const seedR = () => {
    mem.gw_data['col:checklist'] = {
      records: {}, custom: {}, scopes: {}, assignee: {},
      review: { monthly: { '2026-09': { m2: { by: '직원', date: '2026-09-09' } } } },
      review_ts: { monthly: { '2026-09': { m1: 500, m2: 400 } } },   // m1 = 관리자가 반려해 지운 자리(툼스톤만 남음)
      updated_at: 7200,
    };
  };

  // 낡은 탭(사이드카를 안 올림)이 지워진 m1을 되살려 저장 — 서버는 툼스톤을 지키고, 그 직원의 새 요청 m3는 정상 저장한다
  seedR();
  r = await call({ action: 'save', collection: 'checklist', base: 7200, doc: {
    records: {}, custom: {}, scopes: {}, assignee: {},
    review: { monthly: { '2026-09': { m1: { by: '낡은탭', date: '2026-09-01' }, m3: { by: '직원', date: '2026-09-09' } } } },
  } }, tokR, 'dev1');
  {
    const saved = mem.gw_data['col:checklist'];
    T('checklist: 완료요청 툼스톤(review_ts)이 사이드카를 모르는 저장에도 줄지 않는다 — 줄면 다음 병합에서 지운 요청이 다시 부활한다',
      r.code === 200 && saved.review_ts.monthly['2026-09'].m1 === 500 && saved.review_ts.monthly['2026-09'].m2 === 400,
      JSON.stringify(saved.review_ts));
    T('checklist: 그래도 직원의 완료요청 자체는 정상 저장된다(review 본체는 이월 대상이 아니다 — 직원이 쓰는 필드)',
      !!(saved.review && saved.review.monthly['2026-09'].m3), JSON.stringify(saved.review));
  }

  // 관리자가 반려(m2 삭제)하며 더 최신 스탬프를 올린다 — 서버는 최댓값만 갱신하고 옛 스탬프는 유지
  seedR();
  r = await call({ action: 'save', collection: 'checklist', base: 7200, doc: {
    records: {}, custom: {}, scopes: {}, assignee: {},
    review: { monthly: { '2026-09': {} } },
    review_ts: { monthly: { '2026-09': { m2: 9000 } } },
  } }, tokA);
  {
    const saved = mem.gw_data['col:checklist'];
    T('checklist: 관리자의 완료요청 반려·승인 스탬프는 더 최신일 때만 갱신된다(3층 재귀 최댓값)',
      r.code === 200 && saved.review_ts.monthly['2026-09'].m2 === 9000 && saved.review_ts.monthly['2026-09'].m1 === 500,
      JSON.stringify(saved.review_ts));
    T('checklist: 관리자의 반려는 그대로 반영된다(요청 삭제)',
      !saved.review.monthly['2026-09'].m2, JSON.stringify(saved.review));
  }

  // 더 옛 스탬프를 올리는 낡은 사본은 툼스톤을 뒤로 되돌리지 못한다
  seedR();
  r = await call({ action: 'save', collection: 'checklist', base: 7200, doc: {
    records: {}, custom: {}, scopes: {}, assignee: {},
    review: { monthly: { '2026-09': { m1: { by: '낡은탭', date: '2026-09-01' } } } },
    review_ts: { monthly: { '2026-09': { m1: 100 } } },
  } }, tokR, 'dev1');
  T('checklist: 더 옛 스탬프(낡은 사본)는 툼스톤을 뒤로 되돌리지 못한다',
    r.code === 200 && mem.gw_data['col:checklist'].review_ts.monthly['2026-09'].m1 === 500,
    JSON.stringify(mem.gw_data['col:checklist'].review_ts));

  // 층이 어긋난(구조 파손·조작) 사이드카는 서버 원본을 유지한다 — 툼스톤이 스칼라로 덮여 통째 증발하는 경로 차단
  seedR();
  r = await call({ action: 'save', collection: 'checklist', base: 7200, doc: {
    records: {}, custom: {}, scopes: {}, assignee: {}, review: {}, review_ts: { monthly: 1 },
  } }, tokR, 'dev1');
  T('checklist: 층이 어긋난 사이드카(monthly=스칼라)로는 툼스톤을 덮을 수 없다',
    r.code === 200 && mem.gw_data['col:checklist'].review_ts.monthly['2026-09'].m1 === 500,
    JSON.stringify(mem.gw_data['col:checklist'].review_ts));

  // 공개범위 사이드카(평면 지도)는 재귀 병합으로 바꾼 뒤에도 종전과 같이 동작해야 한다(회귀)
  seedR();
  mem.gw_data['col:checklist'].scope_ts = { m1: 500 };
  r = await call({ action: 'save', collection: 'checklist', base: 7200, doc: {
    records: {}, custom: {}, scopes: {}, assignee: {}, review: {}, scope_ts: { m1: 100, q1: 800 },
  } }, tokA);
  T('checklist: 평면 사이드카(scope_ts)의 최댓값 규칙은 재귀 병합으로 바꾼 뒤에도 그대로다(회귀)',
    r.code === 200 && mem.gw_data['col:checklist'].scope_ts.m1 === 500 && mem.gw_data['col:checklist'].scope_ts.q1 === 800,
    JSON.stringify(mem.gw_data['col:checklist'].scope_ts));

  delete mem.gw_data['col:checklist'];
  delete mem.gw_users['member:urev'];
}

// ---- 38 석면 대장 저장 왕복(v336, 2026-09-09 PM 실사고 "저장을 눌러도 창이 안 닫히고 목록에 안 뜬다" 재현·차단) ----
// 사고의 씨앗은 9/2 일괄 입력분 130건이 member_ids·worker_ids를 배열이 아니라 문자열 "[]"로 들고 있었던 것이다.
// 서버는 문서를 있는 그대로 보관하므로(정규화를 하지 않는다) 그 모양이 매 로드마다 프런트로 흘러갔고,
// renderAsb의 (r.member_ids||[]).forEach가 TypeError를 던져 목록도 안 그려지고 닫기까지 못 갔다.
// 서버 몫은 두 가지다: ① 앱이 교정해 올린 배열 모양을 변질 없이 보관할 것 ② 저장 충돌(409) 뒤 재저장이 정상 성립할 것.
// (렌더가 던지지 않는지 자체는 uismoke 37에서 실제 소스를 뽑아 실행해 검증한다.)
{
  const seedAsb = (items, at) => { mem.gw_data['col:asbestos'] = { schema: 1, items, updated_at: at }; };
  // v456(C082 ②): 현장 대장 저장은 새로 들어온 worker_ids가 명부(col:workers)에 있어야 한다 — 이 절이 쓰는 w1을 명부에 둔다(명부 없는 고아 id 거절은 절 86)
  const had38w = Object.prototype.hasOwnProperty.call(mem.gw_data, 'col:workers') ? mem.gw_data['col:workers'] : undefined;
  mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w1', name: '일용38' }], updated_at: 38 };

  // ① 사고 당시 모양 그대로 저장 → 서버는 손대지 않고 그대로 돌려준다(= 프런트가 반드시 교정해야 하는 이유)
  seedAsb([], 100);
  r = await call({ action: 'save', collection: 'asbestos', base: 100, doc: { schema: 1, items: [
    { id: 'a1', title: '일괄입력분', start: '2014-03-24', end: '2014-04-10', status: 'done', member_ids: '[]', worker_ids: '[]' },
  ] } }, tokA);
  r = await call({ action: 'get', collection: 'asbestos' }, tokA);
  T('석면: 서버는 문서를 정규화하지 않는다 — 문자열 "[]"가 그대로 되돌아온다(모양 교정은 앱 입구의 몫)',
    r.code === 200 && r.body.doc.items[0].member_ids === '[]', JSON.stringify(r.body.doc.items[0].member_ids));

  // ② 앱이 asList로 교정해 올린 배열 모양은 변질 없이 보관된다 → 다음 로드부터 지뢰가 사라진다
  const base2 = mem.gw_data['col:asbestos'].updated_at;
  r = await call({ action: 'save', collection: 'asbestos', base: base2, doc: { schema: 1, items: [
    { id: 'a1', title: '일괄입력분', start: '2014-03-24', end: '2014-04-10', status: 'done', member_ids: [], worker_ids: ['w1'] },
  ] } }, tokA);
  r = await call({ action: 'get', collection: 'asbestos' }, tokA);
  T('석면: 교정본(배열)이 저장되면 배열 그대로 보관된다 — 한 번 저장하면 그 기록은 다시 지뢰가 되지 않는다',
    r.code === 200 && Array.isArray(r.body.doc.items[0].member_ids) && Array.isArray(r.body.doc.items[0].worker_ids)
    && r.body.doc.items[0].worker_ids[0] === 'w1', JSON.stringify(r.body.doc.items[0]));

  // ③ 낡은 base로 저장하면 409 — 프런트 doSaveAsb는 이걸 받아 재조회·mergeAsb 후 다시 저장한다.
  //    사고 당시 저장은 매번 이 경로로 성공했다(그래서 서버에 17건이 쌓였다). 실패한 것은 저장이 아니라 화면이었다.
  r = await call({ action: 'save', collection: 'asbestos', base: 1, doc: { schema: 1, items: [] } }, tokA);
  T('석면: 낡은 base 저장 → 409(프런트가 재조회·병합 후 재저장하는 정상 경로)', r.code === 409, String(r.code));
  const base3 = mem.gw_data['col:asbestos'].updated_at;
  r = await call({ action: 'save', collection: 'asbestos', base: base3, doc: { schema: 1, items: [
    { id: 'a1', title: '일괄입력분', member_ids: [], worker_ids: ['w1'] },
    { id: 'a2', title: '남성초', start: '2026-09-09', status: 'plan', member_ids: ['u1'], worker_ids: [] },
  ] } }, tokA);
  T('석면: 재조회한 base로 재저장하면 200 — 새 기록이 1건만 늘어난다(중복은 화면 오해에서 생겼지 저장에서 생기지 않았다)',
    r.code === 200 && mem.gw_data['col:asbestos'].items.length === 2, String(r.code) + '/' + mem.gw_data['col:asbestos'].items.length);

  // ④ 석면 대장(현장 대장 — 석면·철거·준설, 안전 › 현장)은 현장(site) 권한으로 연다(gw-data COL asbestos:'site').
  //    2026-09-10 인허가(lic)에서 분리했다(이 절의 옛 주석·라벨은 lic 공유로 적혀 있었다 — v429에 바로잡음). 이 대장에는 근로자 인적사항(30년 보존)이 들어간다.
  //    v339(PM 2026-09-10 "인허가 석면은 운영 및 관리부만", c463117): lic 기본값을 view → hide로 뒤집었다(그때 석면 대장은 lic를 함께 썼다).
  //    v347(같은 날, df1c818): 현장(site) 키 신설 — COL asbestos lic → site, PERM_CLOSED에 site(처음부터 닫힘). v347이 이 절을 안 고쳐 v429까지 라벨이 lic로 남았다.
  //    권한을 명시로 받은 사람만 열린다. 아래 검사들이 그 사실을 고정한다(전에는 반대 사실을 고정하고 있었다). 이유 코드까지 본다 — 기기 미승인(DEVICE_NOT_APPROVED) 같은 다른 403으로 통과하지 않게(v429 검토).
  r = await call({ action: 'get', collection: 'asbestos' }, tokW, 'dev1');
  T('석면: site 미지정 직원은 차단된다(기본 숨김 — 관리부·운영부만 명시 부여)', r.code === 403 && r.body.error_code === 'NO_ACCESS', String(r.code) + '/' + r.body.error_code);
  r = await call({ action: 'get', collection: 'licenses' }, tokW, 'dev1');
  T('인허가: lic 미지정 직원도 차단된다(v339 기본 숨김 — 키는 현장 대장 site와 따로)', r.code === 403 && r.body.error_code === 'NO_ACCESS', String(r.code) + '/' + r.body.error_code);
  mem.gw_users['member:uwork'].perms.site = 'hide';
  r = await call({ action: 'get', collection: 'asbestos' }, tokW, 'dev1');
  T('석면: site=숨김으로 지정한 직원은 차단된다(대장 키는 현장 site)', r.code === 403 && r.body.error_code === 'NO_ACCESS', String(r.code) + '/' + r.body.error_code);
  delete mem.gw_users['member:uwork'].perms.site;
  // ⑤ v429(메뉴 56 2단계): 앱의 현장 대장 판정 6곳(loadAsb·캘린더 석면 일정·계약 연결 탭 4곳 — csLinkSiteLater 1·csSiteDone 1·csLinksHtml 2)을 canSee('lic') → canSee('site')로 맞춘 근거 —
  //    서버는 대장을 현장 권한 하나로 연다. 현장 보기만 있고 인허가가 숨김인 사람은 읽고, 인허가 수행만 있고 현장 권한이 없는 사람은 못 읽는다.
  //    (같은 직원의 인허가 읽기를 함께 봐서 권한 값이 실제로 먹었는지 확인 — 인허가 문서가 없으면 mock이 500을 내므로 이 절에서만 빈 문서를 둔다)
  const licSeeded = !Object.prototype.hasOwnProperty.call(mem.gw_data, 'col:licenses');
  if (licSeeded) mem.gw_data['col:licenses'] = { schema: 1, items: [], updated_at: 1 };
  mem.gw_users['member:uwork'].perms.site = 'view';
  r = await call({ action: 'get', collection: 'asbestos' }, tokW, 'dev1');
  const rLicH = await call({ action: 'get', collection: 'licenses' }, tokW, 'dev1');
  T('석면(v429): site 보기 · lic 미지정(숨김) 직원은 대장을 읽는다(200, 2건) — 인허가 권한 없이 현장 권한 하나로 열린다',
    r.code === 200 && Array.isArray(r.body.doc && r.body.doc.items) && r.body.doc.items.length === 2 && rLicH.code === 403, [r.code, r.body.doc && r.body.doc.items && r.body.doc.items.length, rLicH.code].join('/'));
  delete mem.gw_users['member:uwork'].perms.site;
  mem.gw_users['member:uwork'].perms.lic = 'do';
  r = await call({ action: 'get', collection: 'asbestos' }, tokW, 'dev1');
  const rLicD = await call({ action: 'get', collection: 'licenses' }, tokW, 'dev1');
  T('석면(v429): lic 수행만 있고 site 미지정인 직원은 차단된다(403 NO_ACCESS) — 같은 직원의 인허가 읽기는 200(권한 자체는 살아 있음)',
    r.code === 403 && r.body.error_code === 'NO_ACCESS' && rLicD.code === 200, [r.code, r.body.error_code, rLicD.code].join('/'));
  delete mem.gw_users['member:uwork'].perms.lic;
  if (licSeeded) delete mem.gw_data['col:licenses'];
  // ⑥ v430(v429 검토 반려분 이월): 현장 대장 쓰기 짝 — 쓰기는 현장 '수행'만(gw-data handleSave: permOf !== 'do' → 403 NO_WRITE). 30년 보존 대장이라 쓰기 쪽이 읽기보다 위험한데,
  //    종전 석면 저장 시험 4회는 전부 관리자 토큰이라 '보기도 저장 허용'·'인허가 키로 판정' 같은 결함이 걸리지 않았다. 이유 코드·기록 수까지 본다(⑤의 읽기 짝과 같은 직원·기기)
  const asbBefore6 = JSON.parse(JSON.stringify(mem.gw_data['col:asbestos'])), baseW6 = asbBefore6.updated_at, nW6 = asbBefore6.items.length;
  mem.gw_users['member:uwork'].perms.site = 'view';
  r = await call({ action: 'save', collection: 'asbestos', base: baseW6, doc: { schema: 1, items: [] } }, tokW, 'dev1');
  T('석면(v430 쓰기 짝 ①): site 보기 직원의 대장 저장 → 403 NO_WRITE · 기록 수 그대로(' + nW6 + '건)·updated_at 그대로',
    r.code === 403 && r.body.error_code === 'NO_WRITE' && mem.gw_data['col:asbestos'].items.length === nW6 && nW6 === 2 && mem.gw_data['col:asbestos'].updated_at === baseW6, [r.code, r.body.error_code, mem.gw_data['col:asbestos'].items.length].join('/'));
  delete mem.gw_users['member:uwork'].perms.site;
  mem.gw_users['member:uwork'].perms.lic = 'do';
  r = await call({ action: 'save', collection: 'asbestos', base: baseW6, doc: { schema: 1, items: [] } }, tokW, 'dev1');
  T('석면(v430 쓰기 짝 ②): lic 수행만·site 미지정 직원의 대장 저장 → 403 NO_WRITE(인허가 수행이 현장 대장 쓰기를 열지 않음) · 기록 그대로',
    r.code === 403 && r.body.error_code === 'NO_WRITE' && mem.gw_data['col:asbestos'].items.length === nW6 && mem.gw_data['col:asbestos'].updated_at === baseW6, [r.code, r.body.error_code].join('/'));
  delete mem.gw_users['member:uwork'].perms.lic;
  mem.gw_users['member:uwork'].perms.site = 'do';
  r = await call({ action: 'save', collection: 'asbestos', base: baseW6, doc: { schema: 1, items: asbBefore6.items.concat([{ id: 'a3', title: '쓰기 짝', status: 'plan', member_ids: [], worker_ids: [] }]) } }, tokW, 'dev1');
  T('석면(v430 쓰기 짝 ③): site 수행 직원의 대장 저장 → 200 · ' + (nW6 + 1) + '건·저장자 = 그 직원(시험 뒤 원복)',
    r.code === 200 && mem.gw_data['col:asbestos'].items.length === nW6 + 1 && mem.gw_data['col:asbestos'].updated_by === 'uwork', [r.code, r.body.error_code, mem.gw_data['col:asbestos'].items.length].join('/'));
  delete mem.gw_users['member:uwork'].perms.site;
  mem.gw_data['col:asbestos'] = asbBefore6;   // 원복(버전 링 스냅샷 ver:asbestos:*는 이 절 뒤에서 쓰지 않는다)

  delete mem.gw_data['col:asbestos'];
  if (had38w === undefined) delete mem.gw_data['col:workers']; else mem.gw_data['col:workers'] = had38w;   // v456 명부 시드 원복
}

// ===== 39. 새 노선 추가 v351(PM 9/11 "R40 추가 및 드롭다운 가장 상단에 새 노선으로 추가 버튼") — 기본표 R40 · blob allbaro:routes_extra → 예비 행 40~49 ·
//   ab_route_add(운영부·관리자, 중복이면 기존 줄, 길이 60·60·40, 예비 행 소진 409) · 추가된 줄은 ab_status routes·findRoute(ab_learn)·매칭·ab_hidden_export routes_extra에 바로 보인다.
{
  const gwab = require(join(FN, 'gw-allbaro.js'));
  const abLib = require(join(FN, '_lib/allbaro.js'));
  const OPS = { id: 'uops', name: '운영부원', admin: false, dept: '운영부', perms: {} };
  mem.gw_users['member:uops'] = OPS; mem.gw_users['member:uwork'] = WORKER;
  const tokO = issueSession(OPS).token;
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] };
  delete mem.gw_data['allbaro:routes_extra'];
  const ab = async (body, tok, dev, headers) => { const rr = await gwab.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}, headers || {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body) }; };
  const extra = () => ((mem.gw_data['allbaro:routes_extra'] || {}).items || []);
  T('기본표 R40 한라티씨→거성산업 분진(9/10 미매칭 실측) · 기본표 71줄 · 예비 행 40~49', abLib.BASE_ROUTES.length === 71 && abLib.BASE_ROUTES.some((x) => x.side === 'R' && x.row === 40 && x.from === '한라티씨' && x.to === '거성산업' && x.item === '분진') && abLib.EXTRA_ROW_MIN === 40 && abLib.EXTRA_ROW_MAX === 49, String(abLib.BASE_ROUTES.length));
  let d = abLib.matchRouteEx({ from: '한라티씨(주)', to: '거성산업(주)', item: '분진(고상)' }, {});
  T('매칭: 한라티씨→거성산업 분진 → R40', !!d.route && d.route.side === 'R' && d.route.row === 40, JSON.stringify(d).slice(0, 120));
  const verBase = abLib.routesVer();
  r = await ab({ action: 'ab_route_add', from: '새상차지', to: '새하차지', item: '새품목', side: 'L' }, tokW, 'dev1');
  T('ab_route_add 부서 없는 직원 → 403 FORBIDDEN · blob 없음', r.code === 403 && r.body.code === 'FORBIDDEN' && !mem.gw_data['allbaro:routes_extra'], r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_add', from: '', to: '새하차지', item: '', side: 'L' }, tokO, 'dev1');
  T('ab_route_add 상차지 없음 → 400 BAD_INPUT', r.code === 400 && r.body.code === 'BAD_INPUT', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_add', from: '새상차지', to: '새하차지', item: '', side: 'X' }, tokO, 'dev1');
  T('ab_route_add side X → 400 BAD_INPUT', r.code === 400 && r.body.code === 'BAD_INPUT', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_add', from: 'x'.repeat(61), to: '새하차지', item: '', side: 'L' }, tokO, 'dev1');
  T('ab_route_add 상차지 61자 → 400 STR_TOO_LONG(양식 칸 폭 60·품목 40)', r.code === 400 && r.body.code === 'STR_TOO_LONG', r.code + '/' + r.body.code);
  r = await ab({ action: 'ab_route_add', from: '새상차지', to: '새하차지', item: 'z'.repeat(41), side: 'L' }, tokO, 'dev1');
  T('ab_route_add 품목 41자 → 400 STR_TOO_LONG', r.code === 400 && r.body.code === 'STR_TOO_LONG', r.code + '/' + r.body.code);
  let audL = auditMock.logs.length;
  r = await ab({ action: 'ab_route_add', from: '새상차지', to: '새하차지', item: '새품목', side: 'L' }, tokO, 'dev1');
  T('ab_route_add 운영부 → 200 L40(예비 첫 줄) existed:false · blob routes_extra 1건{side,row,from,to,item,count_col 5,by,bid,ts} · routes_ver 바뀜 · 감사로그 노선추가 L40',
    r.code === 200 && r.body.ok === true && r.body.side === 'L' && r.body.row === 40 && r.body.existed === false && r.body.routes_ver !== verBase
    && extra().length === 1 && extra()[0].row === 40 && extra()[0].count_col === 5 && extra()[0].by === '운영부원' && extra()[0].bid === 'uops' && extra()[0].ts > 0
    && auditMock.logs.slice(audL).some((l) => l.col === 'allbaro' && l.ev && l.ev[0].op === '노선추가' && l.ev[0].id === 'L40'), JSON.stringify(r.body).slice(0, 160));
  r = await ab({ action: 'ab_route_add', from: '새상차지', to: '새하차지', item: '새품목', side: 'R' }, tokO, 'dev1');
  T('같은 상·하차지·품목 다시(열이 달라도) → 200 existed:true L40 · blob 그대로 1건', r.code === 200 && r.body.existed === true && r.body.side === 'L' && r.body.row === 40 && extra().length === 1, JSON.stringify(r.body).slice(0, 120));
  r = await ab({ action: 'ab_route_add', from: '한라티씨', to: '거성산업', item: '분진', side: 'L' }, tokO, 'dev1');
  T('기본표에 있는 조합 → 200 existed:true R40 · 새 줄 없음', r.code === 200 && r.body.existed === true && r.body.side === 'R' && r.body.row === 40 && extra().length === 1, JSON.stringify(r.body).slice(0, 120));
  r = await ab({ action: 'ab_route_add', from: '둘째상차', to: '둘째하차', item: '분진', side: 'R' }, tokA);
  T('R열 추가 → R41(R40은 기본표가 차지)', r.code === 200 && r.body.side === 'R' && r.body.row === 41 && extra().length === 2, JSON.stringify(r.body).slice(0, 120));
  r = await ab({ action: 'ab_status' }, tokA);
  { const l40 = (r.body.routes || []).find((x) => x.side === 'L' && x.row === 40), r41 = (r.body.routes || []).find((x) => x.side === 'R' && x.row === 41);
    T('ab_status routes: L40·R41 extra:true 포함(앱 드롭다운·표에 바로 보인다) · 노선 수 73', r.code === 200 && l40 && l40.extra === true && l40.from === '새상차지' && r41 && r41.extra === true && r.body.routes.length === 73, String((r.body.routes || []).length)); }
  r = await ab({ action: 'ab_learn', from: '새상차지(주)', to: '새하차지', item: '새품목', side: 'L', row: 40 }, tokO, 'dev1');
  T('추가한 줄 L40에 ab_learn 배정 → 200(findRoute가 추가 노선을 본다 — BAD_ROUTE 아님)', r.code === 200 && r.body.ok === true, r.code + '/' + r.body.code);
  d = abLib.matchRouteEx({ from: '둘째상차(주)', to: '둘째하차', item: '분진(고상)' }, {});
  T('매칭: 추가 노선 둘째상차→둘째하차 분진 → R41 · 품목 다르면 v326대로 ITEM_MISMATCH(자동 배정 없음)', !!d.route && d.route.side === 'R' && d.route.row === 41 && abLib.matchRouteEx({ from: '둘째상차', to: '둘째하차', item: '전혀다른품목' }, {}).reason === 'ITEM_MISMATCH', JSON.stringify(d).slice(0, 120));
  // v365(PM 9/18): 본체 줄 + 구체 줄이 같이 있으면 올바로 이름이 품는 가장 긴 줄 — CAM4는 CAM4 줄, 본체는 본체 줄. 차량 갈림 줄(같은 이름)은 종전 흐름.
  { const prevExtra = (mem.gw_data['allbaro:routes_extra'] || {}).items || [];
    abLib.setExtraRoutes(prevExtra.concat([{ side: 'L', row: 43, from: '에코프로비엠(CAM4)', to: '주식회사 에코프로씨엔지', item: '폐양극활물질', count_col: 5 }]));
    const cam = abLib.matchRouteEx({ from: '에코프로비엠(CAM4)', to: '주식회사 에코프로씨엔지', item: '폐양극활물질(양극재 또는 전구체 제조공정에서 발생하는 것을 포함한다)(고상)' }, {});
    const base = abLib.matchRouteEx({ from: '(주)에코프로비엠', to: '주식회사 에코프로씨엔지', item: '폐양극활물질(양극재 또는 전구체 제조공정에서 발생하는 것을 포함한다)(고상)' }, {});
    T('v365 구체 줄 우선: 에코프로비엠(CAM4) → L43(구체 줄) · (주)에코프로비엠 → L34(본체 줄) · 둘 다 AMBIGUOUS 아님', !!cam.route && cam.route.side === 'L' && cam.route.row === 43 && !!base.route && base.route.side === 'L' && base.route.row === 34, JSON.stringify([cam.route && cam.route.row, cam.reason, base.route && base.route.row, base.reason]));
    abLib.setExtraRoutes(prevExtra);
    const cam2 = abLib.matchRouteEx({ from: '에코프로비엠(CAM4)', to: '주식회사 에코프로씨엔지', item: '폐양극활물질' }, {});
    T('v365 구체 줄이 없으면 종전대로 본체 줄 L34(줄 추가 전 동작 유지)', !!cam2.route && cam2.route.row === 34, JSON.stringify(cam2.route && cam2.route.row));
    const bct = abLib.matchRouteEx({ from: '태웅제강(주)', to: '스틸싸이클 주식회사', item: 'EAFD' }, {});
    T('v365 차량 갈림 줄(태웅제강→스틸싸이클 EAFD, R6 BCT/R7 덤프 같은 이름)은 종전 흐름 유지(차량 없으면 AMBIGUOUS·needVehicle)', !bct.route && bct.reason === 'AMBIGUOUS' && bct.needVehicle === true, JSON.stringify([bct.reason, bct.needVehicle, bct.candidates]));
  }
  r = await ab({ action: 'ab_hidden_export', key: 'test-ingest-key' });
  T('ab_hidden_export routes_extra 동봉(엑셀 봇이 예비 행에 쓴다) · L40·R41 · by/bid/ts 없음', r.code === 200 && Array.isArray(r.body.routes_extra) && r.body.routes_extra.length === 2 && r.body.routes_extra[0].row === 40 && r.body.routes_extra[1].row === 41 && !/"(by|bid|ts)"/.test(JSON.stringify(r.body.routes_extra)), JSON.stringify(r.body.routes_extra).slice(0, 160));
  // 예비 행 소진 — L40~49 가득 채운 blob
  mem.gw_data['allbaro:routes_extra'] = { schema: 1, items: Array.from({ length: 10 }, (_, i) => ({ side: 'L', row: 40 + i, from: '가득' + i, to: '가득', item: '', count_col: 5 })) };
  r = await ab({ action: 'ab_route_add', from: '열한번째', to: '가득', item: '', side: 'L' }, tokA);
  T('L열 예비 행 10줄 소진 → 409 ROWS_FULL · blob 그대로 10건', r.code === 409 && r.body.code === 'ROWS_FULL' && extra().length === 10, r.code + '/' + r.body.code);
  mem.gw_data['allbaro:routes_extra'] = { schema: 1, items: [{ side: 'L', row: 5, from: '기본표좌표', to: 'x', item: '' }, { side: 'R', row: 99, from: '범위밖', to: 'x', item: '' }, { side: 'L', row: 42, from: '', to: '이름없음', item: '' }, { side: 'L', row: 43, from: '정상', to: '정상', item: '' }] };
  r = await ab({ action: 'ab_status' }, tokA);
  T('불량 추가분(기본표 좌표 L5·범위 밖 R99·이름 없음)은 버리고 정상 L43만 합친다 · 기본표 L5는 원래 이름', r.code === 200 && r.body.routes.length === 72 && r.body.routes.some((x) => x.side === 'L' && x.row === 43 && x.extra) && r.body.routes.find((x) => x.side === 'L' && x.row === 5).from !== '기본표좌표', String(r.body.routes.length));
  delete mem.gw_data['allbaro:routes_extra'];
  r = await ab({ action: 'ab_status' }, tokA);
  T('추가분 blob 없음(mock NOT_FOUND) → 기본표 71줄 그대로(빈 표로 떨어지지 않는다) · routes_ver 원복', r.code === 200 && r.body.routes.length === 71 && abLib.routesVer() === verBase, String(r.body.routes.length));
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
}

// ===== 40. 엑셀 재생성 요청 v352(PM 9/11 #33) — 숨김/노선 변경 → GitHub workflow_dispatch(가짜 fetch) · 디바운스 · 토큰 없음 · 내려받기 stale/covered
{
  const gwab = require(join(FN, 'gw-allbaro.js'));
  const ab = async (body, tok, dev) => { const rr = await gwab.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body) }; };
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] };
  delete mem.gw_data['allbaro:xlsx_regen'];
  const realFetch = global.fetch; const calls = []; let ghStatus = 204;
  global.fetch = async (url, opt) => { if (/api\.github\.com/.test(String(url))) { calls.push({ url: String(url), body: JSON.parse(opt.body), auth: opt.headers.Authorization }); return { status: ghStatus }; } return realFetch(url, opt); };
  const savedTok = process.env.GW_APPDATA_GITHUB_TOKEN; process.env.GW_APPDATA_GITHUB_TOKEN = 'test-appdata-token';
  const regen = () => mem.gw_data['allbaro:xlsx_regen'] || {};
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 6, hide: true }, tokA);
  T('숨김 → 200 · dispatch 1회(logsheet.yml, ref main, days_back 10 — v385 수집 창 9 + 자정 여유 1, Bearer 토큰) · blob xlsx_regen{requested_at,dispatched_at,dispatch_code 204,reason hide} · 응답 regen.code 204',
    r.code === 200 && r.body.changed === true && calls.length === 1 && /jongwoon-appdata\/actions\/workflows\/logsheet\.yml\/dispatches$/.test(calls[0].url) && calls[0].body.ref === 'main' && calls[0].body.inputs.days_back === '10'
    && calls[0].auth === 'Bearer test-appdata-token' && regen().dispatch_code === 204 && regen().dispatched_at > 0 && regen().reason === 'hide' && r.body.regen && r.body.regen.code === 204, JSON.stringify(r.body.regen));
  T('응답 regen에 회원 정보 없음(by 없음)', !('by' in (r.body.regen || {})), '');
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 6, hide: false }, tokA);
  T('2분 안 해제 → dispatch 안 함(디바운스) · requested_at 갱신 · skipped · 응답 regen.skipped', r.code === 200 && calls.length === 1 && regen().skipped === true && regen().reason === 'unhide' && r.body.regen.skipped === true, JSON.stringify(r.body.regen));
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 6, hide: false }, tokA);
  T('변경 없음(changed:false)이면 재생성 요청도 없음', r.code === 200 && r.body.changed === false && !r.body.regen && calls.length === 1, '');
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  r = await ab({ action: 'ab_learn', from: '재생성테스트', to: '네이처', item: '', side: 'L', row: 5 }, tokA);
  T('노선 지정 → dispatch(디바운스 지남) · reason learn · 응답 regen 동봉', r.code === 200 && calls.length === 2 && regen().reason === 'learn' && r.body.regen && r.body.regen.code === 204, JSON.stringify(r.body.regen));
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  delete mem.gw_data['allbaro:routes_extra'];
  r = await ab({ action: 'ab_route_add', from: '재생성상차', to: '재생성하차', item: '', side: 'L' }, tokA);
  T('노선 추가(새 줄) → dispatch · reason route_add', r.code === 200 && r.body.existed === false && calls.length === 3 && regen().reason === 'route_add', '');
  r = await ab({ action: 'ab_route_add', from: '재생성상차', to: '재생성하차', item: '', side: 'L' }, tokA);
  T('이미 있는 노선(existed) → 재생성 요청 없음', r.code === 200 && r.body.existed === true && calls.length === 3, '');
  // 토큰 권한 없음(403) / 토큰 없음
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  ghStatus = 403;
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 7, hide: true }, tokA);
  T('GitHub 403 → 숨김은 200 그대로 · dispatch_code 403 · dispatch_err HTTP_403 · dispatched_at 갱신 안 됨', r.code === 200 && r.body.hidden === true && regen().dispatch_code === 403 && regen().dispatch_err === 'HTTP_403' && regen().dispatched_at === 1 && r.body.regen.err === 'HTTP_403', JSON.stringify(regen()));
  ghStatus = 204;
  process.env.GW_APPDATA_GITHUB_TOKEN = ''; const g1 = process.env.GW_GALLERY_GITHUB_TOKEN, g2 = process.env.MEMBER_RELAY_GITHUB_TOKEN; process.env.GW_GALLERY_GITHUB_TOKEN = ''; process.env.MEMBER_RELAY_GITHUB_TOKEN = '';
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 7, hide: false }, tokA);
  T('토큰 없음 → 숨김 해제는 200 · dispatch 호출 없음 · dispatch_err NO_TOKEN', r.code === 200 && calls.length === 4 && regen().dispatch_err === 'NO_TOKEN' && regen().dispatch_code === 0, JSON.stringify(regen()));
  process.env.GW_APPDATA_GITHUB_TOKEN = 'test-appdata-token'; process.env.GW_GALLERY_GITHUB_TOKEN = g1 || ''; process.env.MEMBER_RELAY_GITHUB_TOKEN = g2 || '';
  // 내려받기 stale
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const old = new Date(Date.now() + 9 * 3600000 - 20 * 86400000).toISOString().slice(0, 10);
  mem.gw_data['allbaro:xlsx:' + today] = { name: 'x.xlsx', b64: 'UEs=', ts: 1000, total: 1 };
  mem.gw_data['allbaro:xlsx:' + old] = { name: 'y.xlsx', b64: 'UEs=', ts: 1000, total: 1 };
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 5000, dispatched_at: 5000, dispatch_code: 204, by: '관리자' };
  r = await ab({ action: 'ab_xlsx', day: today }, tokA);
  T('ab_xlsx: 파일 ts(1000) < 변경(5000) → stale:true · covered:true(7일 안) · regen{requested_at,dispatched_at,code} · by 없음', r.code === 200 && r.body.stale === true && r.body.covered === true && r.body.regen && r.body.regen.requested_at === 5000 && r.body.regen.code === 204 && !('by' in r.body.regen), JSON.stringify(r.body.regen));
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 5000, dispatched_at: 5000, dispatch_code: 204 };   // 오늘 날짜 재요청(디바운스) 영향 제거
  const c20 = calls.length;
  r = await ab({ action: 'ab_xlsx', day: old }, tokA);
  T('ab_xlsx: 20일 전 날짜 → stale:true·covered:true(v385 범위 59일) · 그 날짜를 덮는 접수가 없으니(cover_from 없음) 재요청 1회 days_back 22(20+1+여유1) · state requested', r.code === 200 && r.body.stale === true && r.body.covered === true && calls.length === c20 + 1 && calls[calls.length - 1].body.inputs.days_back === '22' && r.body.regen.state === 'requested', JSON.stringify([r.body.stale, r.body.covered, calls.length - c20, r.body.regen]));
  // 9/11 실측: 변경 때 dispatch 404(토큰 없음) → 토큰 넣고 배포해도 재시도가 없어 확인창이 옛 404를 계속 보여줌 → 내려받기 때 재시도
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 5000, dispatch_code: 404, dispatch_err: 'HTTP_404', reason: 'unhide' };
  const before = calls.length;
  r = await ab({ action: 'ab_xlsx', day: today }, tokA);
  T('ab_xlsx: stale + 직전 dispatch 404 → 내려받기 때 다시 보냄 · 응답 regen.code 204 · requested_at은 변경 시각(5000) 유지 · blob reason retry', r.code === 200 && calls.length === before + 1 && r.body.regen && r.body.regen.code === 204 && r.body.regen.requested_at === 5000 && regen().dispatch_code === 204 && regen().reason === 'retry' && regen().requested_at === 5000, JSON.stringify(r.body.regen));
  r = await ab({ action: 'ab_xlsx', day: today }, tokA);
  T('바로 또 내려받기 → 접수됐으므로 재시도 없음(dispatch 1회 그대로)', r.code === 200 && calls.length === before + 1 && r.body.regen.code === 204, '');
  mem.gw_data['allbaro:xlsx:' + today].ts = 9000;
  r = await ab({ action: 'ab_xlsx', day: today }, tokA);
  T('ab_xlsx: 재생성 뒤(ts 9000 > 5000) → stale:false · regen null', r.code === 200 && r.body.stale === false && r.body.regen === null, '');
  delete mem.gw_data['allbaro:xlsx_regen'];
  r = await ab({ action: 'ab_xlsx', day: today }, tokA);
  T('ab_xlsx: 재생성 blob 없음(mock NOT_FOUND) → stale:false(경고 없이 종전과 같음)', r.code === 200 && r.body.stale === false, '');
  global.fetch = realFetch; process.env.GW_APPDATA_GITHUB_TOKEN = savedTok || '';
  delete mem.gw_data['allbaro:xlsx:' + today]; delete mem.gw_data['allbaro:xlsx:' + old]; delete mem.gw_data['allbaro:routes_extra'];
  mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] }; mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
}

// ===== 41. 홍보 사진 가리기(모자이크) v353(PM 9/13 "모자이크 착수") — 권한·기동(가짜 워커 기동)·워커 인메모리 실행(가짜 비전)·상태·편집 적용·해제·소비처 mask 우선·삭제 동반
{
  const gwm = require(join(FN, 'gw-promo-mask.js'));
  const wk = require(join(FN, 'gw-promo-mask-background.js'));
  const { Jimp } = require('jimp');
  const PRO = { id: 'upromo', name: '홍보담당', admin: false, perms: { promo: 'do', contracts: 'view' } };
  const NOPRO = { id: 'unopro', name: '무권한', admin: false, perms: {} };
  mem.gw_users['member:upromo'] = PRO; mem.gw_users['member:unopro'] = NOPRO;
  const tokP = issueSession(PRO).token, tokN = issueSession(NOPRO).token;
  const call = async (body, tok, dev) => { const rr = await gwm.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body) }; };
  // 사진 2장(600×400 JPEG) — att_ 형식 id
  const mk = async () => { const img = new Jimp({ width: 600, height: 400, color: 0x2266aaff }); for (let y = 100; y < 200; y++) for (let x = 200; x < 300; x++) img.setPixelColor((((x * 5) % 256 << 24) | ((y * 7) % 256 << 16) | (50 << 8) | 255) >>> 0, x, y); return (await img.getBuffer('image/jpeg', { quality: 90 })).toString('base64'); };
  const b64 = await mk();
  const A1 = 'att_' + 'a'.repeat(16), A2 = 'att_' + 'b'.repeat(16), A3 = 'att_' + 'c'.repeat(16);
  mem.gw_files[A1] = { name: 'p1.jpg', type: 'image/jpeg', kind: 'promo', data: b64, by: '홍보담당', ts: 1 };
  mem.gw_files[A2] = { name: 'p2.jpg', type: 'image/jpeg', kind: 'promo', data: b64, by: '홍보담당', ts: 1 };
  mem.gw_files[A3] = { name: 'c.pdf', type: 'application/pdf', kind: 'contract', data: b64, by: 'x', ts: 1 };
  mem.gw_data['col:promo'] = { schema: 1, items: [{ id: 'prtest01', title: 't', body: 'b', status: 'review', photos: [{ id: A1, name: 'p1.jpg' }, { id: A2, name: 'p2.jpg' }, { id: 'docatt:1', name: 'c.pdf' }] }] };
  const savedKey = process.env.GW_ANTHROPIC_KEY, savedUrl = process.env.URL; process.env.GW_ANTHROPIC_KEY = 'test-anthropic-key-0000'; process.env.URL = 'https://x.test';
  const realFetch = global.fetch; const kicks = []; let visionBoxes = [{ kind: 'face', x: 200 / 600, y: 100 / 400, w: 100 / 600, h: 100 / 400 }]; let visionStop = 'end_turn'; let visionText = null;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (/gw-promo-mask-background/.test(u)) { kicks.push(JSON.parse(opt.body)); return { ok: true, status: 202 }; }
    if (/api\.anthropic\.com/.test(u)) { const b = JSON.parse(opt.body); T2 = b; return { status: 200, text: async () => JSON.stringify({ model: 'claude-sonnet-5', stop_reason: visionStop, usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'text', text: visionText !== null ? visionText : JSON.stringify({ boxes: visionBoxes }) }] }) }; }
    return realFetch(url, opt);
  };
  let T2 = null;
  r = await call({ action: 'mask_state', promo_id: 'prtest01' }, tokN, 'dev1');
  T('mask_state 홍보 권한 없음 → 403 NO_ACCESS', r.code === 403 && r.body.code === 'NO_ACCESS', r.code + '/' + r.body.code);
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokN, 'dev1');
  T('mask_start 홍보 권한 없음 → 403 NO_PERMISSION', r.code === 403 && r.body.code === 'NO_PERMISSION', r.code + '/' + r.body.code);
  r = await call({ action: 'mask_state', promo_id: 'prtest01' }, tokP, 'dev1');
  T('mask_state: 사진 2장(att_ 형식만 — docatt 제외) 전부 미확인(has:false) · running false', r.code === 200 && r.body.items.length === 2 && r.body.items.every((x) => x.has === false) && r.body.running === false, JSON.stringify(r.body).slice(0, 160));
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  T('mask_start 홍보 do → 202 job(pm_) · 워커 기동 1회(ids 2장·force false) · 잠금 · job queued', r.code === 202 && /^pm_/.test(r.body.job) && kicks.length === 1 && kicks[0].ids.length === 2 && kicks[0].force === false && mem.gw_data['promomask:lock:prtest01'].job === r.body.job && mem.gw_data['promomask:job:' + r.body.job].status === 'queued', JSON.stringify(r.body));
  const job1 = r.body.job;
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  T('진행 중 재기동 → 409 ALREADY_RUNNING', r.code === 409 && r.body.code === 'ALREADY_RUNNING' && r.body.job === job1, r.code + '/' + r.body.code);
  // 워커를 인메모리로 실행(내부 토큰) — 가짜 비전이 얼굴 1개를 돌려준다
  const itok = issueSession({ id: '__promomask__', role: 'system' }).token;
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: job1, promo_id: 'prtest01', ids: [A1, A2], force: false }) }, {});
  const j1 = mem.gw_data['promomask:job:' + job1];
  T('워커: done · 사진 2장 masked(상자 1) · 호출 2 · 잠금 해제 · gw_files mask:<id> 2건(원본 보존·auto:true·w/h·jpeg) + maskmeta 2건', j1.status === 'done' && j1.photos.length === 2 && j1.photos.every((p) => p.st === 'masked' && p.boxes === 1) && j1.calls === 2 && mem.gw_data['promomask:lock:prtest01'].job === '' && mem.gw_files['mask:' + A1] && mem.gw_files['mask:' + A1].auto === true && mem.gw_files['mask:' + A1].w === 600 && mem.gw_files['mask:' + A1].h === 400 && Buffer.from(mem.gw_files['mask:' + A1].data, 'base64').slice(0, 3).toString('hex') === 'ffd8ff' && mem.gw_files[A1].data === b64 && mem.gw_files['maskmeta:' + A1] && mem.gw_files['maskmeta:' + A1].n === 1 && mem.gw_files['maskmeta:' + A1].human === false, JSON.stringify(j1).slice(0, 200));
  T('비전 요청: max_tokens 4096 · effort low · json_schema boxes', T2 && T2.max_tokens === 4096 && T2.output_config && T2.output_config.effort === 'low' && T2.output_config.format && T2.output_config.format.type === 'json_schema', JSON.stringify(T2 && T2.output_config).slice(0, 120));
  // 픽셀화 실효 — 가린 판의 상자 안은 원본과 다르고, 밖은 같다(적대 검증 #26)
  { const { Jimp: J2 } = require('jimp'); const o = await J2.read(Buffer.from(b64, 'base64')); const m = await J2.read(Buffer.from(mem.gw_files['mask:' + A1].data, 'base64'));
    const dist = (a, b) => { const r = (a >>> 24) - (b >>> 24), g = ((a >>> 16) & 255) - ((b >>> 16) & 255), bb = ((a >>> 8) & 255) - ((b >>> 8) & 255); return Math.sqrt(r * r + g * g + bb * bb); };
    let inside = 0, outside = 0; for (let k = 0; k < 20; k++) { inside += dist(o.getPixelColor(205 + k * 4, 105 + k * 4), m.getPixelColor(205 + k * 4, 105 + k * 4)); outside += dist(o.getPixelColor(20 + k * 5, 20 + k * 5), m.getPixelColor(20 + k * 5, 20 + k * 5)); }
    T('픽셀화 실효: 상자 안 색차 큼 · 밖은 거의 같음', inside / 20 > 20 && outside / 20 < 12, 'in ' + (inside / 20).toFixed(1) + ' out ' + (outside / 20).toFixed(1)); }
  T('워커: 사용자 토큰으로는 안 돈다', (await (async () => { const before = JSON.stringify(mem.gw_data['promomask:job:' + job1]); await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokP }, body: JSON.stringify({ job: 'pm_x', promo_id: 'prtest01', ids: [A1] }) }, {}); return !mem.gw_data['promomask:job:pm_x'] && JSON.stringify(mem.gw_data['promomask:job:' + job1]) === before; })()), '');
  T('워커 응답·job에 API 키 없음', !JSON.stringify(j1).includes('test-anthropic-key'), '');
  r = await call({ action: 'mask_job', job: job1 }, tokP, 'dev1');
  T('mask_job → 200 done', r.code === 200 && r.body.status === 'done' && r.body.n === 2, '');
  r = await call({ action: 'mask_state', promo_id: 'prtest01' }, tokP, 'dev1');
  T('mask_state: 2장 has:true·boxes 1·auto·human false · used 2/cap 1000(maskmeta만 읽음)', r.code === 200 && r.body.items.every((x) => x.has && x.boxes === 1 && x.auto && !x.human) && r.body.running === false && r.body.used === 2 && r.body.cap === 1000, JSON.stringify(r.body).slice(0, 200));
  // 소비처: att_get 기본은 가린 판(masked:true), raw:true는 원본(홍보 do만)
  const gwd = require(join(FN, 'gw-data.js'));
  const dcall = async (body, tok, dev) => { const rr = await gwd.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body) }; };
  r = await dcall({ action: 'att_get', id: A1 }, tokP, 'dev1');
  T('att_get 기본 → 가린 판(masked:true, 원본과 다름)', r.code === 200 && r.body.masked === true && r.body.data !== b64 && r.body.data === mem.gw_files['mask:' + A1].data, r.code + '/' + JSON.stringify(r.body).slice(0, 80));
  r = await dcall({ action: 'att_get', id: A1, raw: true }, tokP, 'dev1');
  T('att_get raw:true(홍보 do·승인 기기) → 원본 · 감사로그 원본열람', r.code === 200 && !r.body.masked && r.body.data === b64 && auditMock.logs.some((l) => l.col === 'promo' && l.ev && l.ev[0].op === '원본열람'), r.code);
  r = await dcall({ action: 'att_get', id: A1, raw: true }, tokP, 'devX');
  T('att_get raw:true 미승인 기기 → 403 DEVICE_NOT_APPROVED', r.code === 403 && r.body.error_code === 'DEVICE_NOT_APPROVED', r.code + '/' + r.body.error_code);
  mem.gw_users['member:uview'] = { id: 'uview', name: '열람자', admin: false, perms: { contracts: 'view', promo: 'view' } };
  r = await dcall({ action: 'att_get', id: A1, raw: true }, issueSession(mem.gw_users['member:uview']).token, 'dev1');
  T('att_get raw:true 홍보 view → 403(원본은 편집 권한에만)', r.code === 403, r.code);
  mem.gw_users['member:uponly'] = { id: 'uponly', name: '홍보만', admin: false, perms: { contracts: 'hide', promo: 'do' } };
  r = await dcall({ action: 'att_get', id: A1 }, issueSession(mem.gw_users['member:uponly']).token, 'dev1');
  T('att_get: 계약 hide·홍보 do 회원도 홍보 사진(가린 판)을 본다', r.code === 200 && r.body.masked === true, r.code);
  r = await dcall({ action: 'att_get', id: 'att_zz' }, tokP, 'dev1');
  T('att_get: att_ 16hex 형식 아니면 400', r.code === 400, r.code);
  // 공개 서빙(gw-promo-img) — 공유 토큰 경로도 가린 판
  const gwi = require(join(FN, 'gw-promo-img.js'));
  mem.gw_data['promo:share:' + 'f'.repeat(64)] = { ids: [A1, A2], promo_id: 'prtest01', exp: Date.now() + 100000, by: 'x', ts: 1 };
  { const rr = await gwi.handler({ httpMethod: 'GET', queryStringParameters: { s: 'f'.repeat(64), i: '0' }, headers: {} });
    T('gw-promo-img 공개 서빙 → 가린 판 바이트(원본 아님)', rr.statusCode === 200 && rr.isBase64Encoded && rr.body === mem.gw_files['mask:' + A1].data && rr.body !== b64, String(rr.statusCode)); }
  // 편집 적용 — 사람이 상자 2개 지정(human) → auto가 다시 덮지 않음
  r = await call({ action: 'mask_apply', att_id: A1, boxes: [{ kind: 'plate', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, { kind: 'face', x: -0.05, y: 0.5, w: 0.2, h: 0.1 }, { x: 5, y: 5, w: 1, h: 1 }] }, tokP, 'dev1');
  T('mask_apply 상자 3개(범위 밖 1 제외, 가장자리 걸친 것은 잘라 수용) → 200 boxes 2 masked · human:true · 걸친 상자 x 0·w 0.15', r.code === 200 && r.body.boxes === 2 && r.body.masked === true && mem.gw_files['mask:' + A1].human === true && mem.gw_files['mask:' + A1].boxes.every((b) => b.by === 'human') && Math.abs(mem.gw_files['mask:' + A1].boxes[1].x) < 1e-9 && Math.abs(mem.gw_files['mask:' + A1].boxes[1].w - 0.15) < 1e-9 && mem.gw_files['maskmeta:' + A1].human === true, JSON.stringify(r.body) + JSON.stringify(mem.gw_files['mask:' + A1].boxes));
  kicks.length = 0;
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: r.body.job, promo_id: 'prtest01', ids: [A1, A2], force: false }) }, {});
  { const j2 = mem.gw_data['promomask:job:' + r.body.job];
    T('재실행(force 아님): 사람이 손본 A1은 kept:human(상자 2 유지) · 자동 A2는 kept:auto · 비전 호출 0', j2.status === 'done' && j2.photos[0].st === 'kept:human' && j2.photos[0].boxes === 2 && j2.photos[1].st === 'kept:auto' && j2.calls === 0, JSON.stringify(j2.photos)); }
  r = await call({ action: 'mask_start', promo_id: 'prtest01', force: true }, tokP, 'dev1');
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: r.body.job, promo_id: 'prtest01', ids: [A1, A2], force: true }) }, {});
  { const j3 = mem.gw_data['promomask:job:' + r.body.job];
    T('force = 자동 판만 다시: 사람이 손본 A1은 kept:human 유지 · 자동 A2만 masked · 호출 1', j3.status === 'done' && j3.photos[0].st === 'kept:human' && j3.photos[1].st === 'masked' && j3.calls === 1 && mem.gw_files['mask:' + A1].human === true, JSON.stringify(j3.photos)); }
  visionBoxes = [];
  r = await call({ action: 'mask_apply', att_id: A2, boxes: [] }, tokP, 'dev1');
  T('mask_apply 상자 0 → "가릴 것 없음"(human:true·masked false·data 빈 값) → att_get은 원본', r.code === 200 && r.body.masked === false && mem.gw_files['mask:' + A2].data === '' && mem.gw_files['mask:' + A2].human === true && (await dcall({ action: 'att_get', id: A2 }, tokP, 'dev1')).body.masked !== true, JSON.stringify(r.body));
  r = await call({ action: 'mask_start', promo_id: 'prtest01', force: true }, tokP, 'dev1');
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: r.body.job, promo_id: 'prtest01', ids: [A1, A2], force: true }) }, {});
  T('사람이 정한 "가릴 것 없음"도 force 재감지에 안 덮인다(kept:human 2장·호출 0)', mem.gw_data['promomask:job:' + r.body.job].photos.every((p) => p.st === 'kept:human') && mem.gw_data['promomask:job:' + r.body.job].calls === 0, JSON.stringify(mem.gw_data['promomask:job:' + r.body.job].photos));
  // 비전 잘림·거부·파싱 실패 → mask 안 씀(has:false 유지) — 적대 검증 #1/#10/#23
  const A4 = 'att_' + 'd'.repeat(16); mem.gw_files[A4] = { name: 'p4.jpg', type: 'image/jpeg', kind: 'promo', data: b64, by: 'x', ts: 1 };
  mem.gw_data['col:promo'].items[0].photos.push({ id: A4, name: 'p4.jpg' });
  visionStop = 'max_tokens'; visionText = '{"boxes":[{"kind":"fa';
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: r.body.job, promo_id: 'prtest01', ids: [A4], force: false }) }, {});
  T('비전 max_tokens 잘림 → fail:TRUNCATED · mask 미저장 · 상태 has:false', mem.gw_data['promomask:job:' + r.body.job].photos[0].st === 'fail:TRUNCATED' && !mem.gw_files['mask:' + A4] && (await call({ action: 'mask_state', promo_id: 'prtest01' }, tokP, 'dev1')).body.items.find((x) => x.id === A4).has === false, JSON.stringify(mem.gw_data['promomask:job:' + r.body.job].photos));
  visionStop = 'refusal'; visionText = '';
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: r.body.job, promo_id: 'prtest01', ids: [A4], force: false }) }, {});
  T('비전 refusal → fail:REFUSAL · mask 미저장', mem.gw_data['promomask:job:' + r.body.job].photos[0].st === 'fail:REFUSAL' && !mem.gw_files['mask:' + A4], '');
  visionStop = 'end_turn'; visionText = 'not json at all';
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: r.body.job, promo_id: 'prtest01', ids: [A4], force: false }) }, {});
  T('비전 응답 파싱 불가 → fail:PARSE · mask 미저장', mem.gw_data['promomask:job:' + r.body.job].photos[0].st === 'fail:PARSE' && !mem.gw_files['mask:' + A4], '');
  visionText = null;
  // 월 상한
  mem.gw_data['promomask:usage'] = { schema: 1, months: {} }; mem.gw_data['promomask:usage'].months[new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7)] = { calls: 999, input: 0, output: 0 };
  r = await call({ action: 'mask_start', promo_id: 'prtest01' }, tokP, 'dev1');
  T('월 호출 상한(999+3 > 1000) → 429 BUDGET_CAP · 워커 미기동', r.code === 429 && r.body.code === 'BUDGET_CAP', r.code + '/' + r.body.code);
  delete mem.gw_data['promomask:usage'];
  // 홈페이지 갤러리 실경로(gw-gallery-feed)도 가린 판
  const gwf = require(join(FN, 'gw-gallery-feed.js'));
  mem.gw_data['col:promo'].items[0].status = 'posted'; mem.gw_data['col:promo'].items[0].blog_url = 'https://blog.naver.com/x/1'; const savedFk = process.env.GW_GALLERY_FEED_KEY; process.env.GW_GALLERY_FEED_KEY = 'feed-test-key';
  { const rr = await gwf.handler({ httpMethod: 'GET', queryStringParameters: { img: A2, key: 'feed-test-key' }, headers: {} });
    const body2 = rr.isBase64Encoded ? rr.body : ''; const expectRaw = mem.gw_files['mask:' + A2].data === '';   // A2는 '가릴 것 없음' → 원본
    T('gw-gallery-feed img: mask 우선(가릴 것 없음이면 원본) · 캐시 5분', rr.statusCode === 200 && (expectRaw ? body2 === b64 : body2 === mem.gw_files['mask:' + A2].data) && /max-age=300/.test(rr.headers['Cache-Control']), String(rr.statusCode) + ' ' + (rr.headers || {})['Cache-Control']); }
  mem.gw_data['col:promo'].items[0].status = 'review'; process.env.GW_GALLERY_FEED_KEY = savedFk || '';
  // mask_apply 입력 검사(형식·용량)
  const A5 = 'att_' + 'e'.repeat(16); mem.gw_files[A5] = { name: 'x.webp', type: 'image/webp', kind: 'promo', data: b64, by: 'x', ts: 1 };
  r = await call({ action: 'mask_apply', att_id: A5, boxes: [] }, tokP, 'dev1');
  T('mask_apply webp(디코더 없음) → 400 UNSUPPORTED_FORMAT', r.code === 400 && r.body.code === 'UNSUPPORTED_FORMAT', r.code + '/' + r.body.code);
  r = await call({ action: 'mask_apply', att_id: A3, boxes: [] }, tokP, 'dev1');
  T('mask_apply 홍보 아닌 첨부(contract) → 403 NOT_PROMO', r.code === 403 && r.body.code === 'NOT_PROMO', r.code + '/' + r.body.code);
  delete mem.gw_files[A5]; delete mem.gw_files[A4];
  r = await call({ action: 'mask_get', att_id: A1 }, tokP, 'dev1');
  T('mask_get → has·boxes(정규화)·w/h', r.code === 200 && r.body.has === true && r.body.w === 600 && r.body.h === 400 && Array.isArray(r.body.boxes), JSON.stringify(r.body).slice(0, 120));
  r = await call({ action: 'mask_get', att_id: 'mask:' + A1 }, tokP, 'dev1');
  T('mask_get att_ 형식 아님 → 400 BAD_ID', r.code === 400 && r.body.code === 'BAD_ID', r.code);
  r = await call({ action: 'mask_clear', att_id: A1 }, tokP, 'dev1');
  T('mask_clear → 가린 판·상태 삭제(existed true) · att_get 원본', r.code === 200 && r.body.existed === true && !mem.gw_files['mask:' + A1] && !mem.gw_files['maskmeta:' + A1] && (await dcall({ action: 'att_get', id: A1 }, tokP, 'dev1')).body.data === b64, r.code);
  { const aud = auditMock.logs.length; r = await call({ action: 'mask_clear', att_id: A1 }, tokP, 'dev1');
    T('mask_clear 없는 판 → existed false · 감사로그 없음', r.code === 200 && r.body.existed === false && auditMock.logs.length === aud, ''); }
  mem.gw_users['member:uadmin'] = { id: 'uadmin', name: '관리자', admin: true, perms: {}, tier: 'pm' };
  r = await dcall({ action: 'att_del', id: A2 }, tokA);
  T('att_del → mask:<id>·maskmeta도 함께 삭제', r.code === 200 && !mem.gw_files[A2] && !mem.gw_files['mask:' + A2] && !mem.gw_files['maskmeta:' + A2], r.code);
  T('감사로그: 사진가리기·가리기수정·가리기해제·자동가리기(워커 요약)·원본열람 op 존재', ['사진가리기', '가리기수정', '가리기해제', '자동가리기', '원본열람'].every((op) => auditMock.logs.some((l) => l.col === 'promo' && l.ev && l.ev[0].op === op)), '');
  global.fetch = realFetch; process.env.GW_ANTHROPIC_KEY = savedKey || ''; process.env.URL = savedUrl || '';
  delete mem.gw_data['col:promo']; delete mem.gw_files[A1]; delete mem.gw_files[A3]; delete mem.gw_data['promo:share:' + 'f'.repeat(64)];
}

// ===== 43. v360 사진AI 자동 생성 — 서버 책임(PM 9/16 "틀어막지 말고 근본적으로"): 결과 직접 적용·상태 기록·크론 재시작·옛 작업 적용 =====
{
  const PJ = require(join(FN, '_lib/promoai_job.js'));
  const NOW = 1789520000000;
  const ph = [{ id: 'att_00000000000000aa' }, { id: 'att_00000000000000bb' }];
  // applyResult(순수)
  let doc = { schema: 1, items: [{ id: 'prm_a', status: 'review', title: '예비 제목', body: '예비 본문', photos: ph, ts: NOW - 5000 }] };
  let a = PJ.applyResult(doc, 'prm_a', { title: 'AI 제목', body: 'AI 본문', tags: ['포항', '준설', '하수구'], model: 'm', tokens: { input: 1, output: 2, total: 3 }, tt: 'q', job: 'pa_gen_x_1' }, NOW);
  const r0 = doc.items[0];
  T('applyResult: 제목·본문·태그·ai·pre_ai·updated_ts·ai_st done — 앱 paApplyToRecord와 같은 필드', a.changed && r0.title === 'AI 제목' && r0.body === 'AI 본문' && r0.tags.length === 3 && r0.ai && r0.ai.tokens === 3 && r0.ai.by === 'server' && r0.pre_ai.title === '예비 제목' && r0.updated_ts === NOW && r0.ai_st.st === 'done' && r0.ai_st.job === 'pa_gen_x_1', JSON.stringify(r0));
  T('applyResult: 이미 ai가 있으면 멱등(안 바꿈) · 빈 결과는 적용 안 함 · 없는 기록 NOT_FOUND', !PJ.applyResult(doc, 'prm_a', { title: 'x', body: 'y' }, NOW).changed && PJ.applyResult({ items: [{ id: 'z', photos: ph }] }, 'z', { title: '', body: 'y' }).why === 'EMPTY' && PJ.applyResult(doc, 'nope', {}).why === 'NOT_FOUND');
  // pickCandidates(순수) — 규칙표
  const mk = (id, extra) => Object.assign({ id: id, status: 'review', photos: ph, ts: NOW - 60000 }, extra || {});
  const items = [
    mk('c_never'),                                                         // 상태 없음 → 대상
    mk('c_ai', { ai: { ts: 1 } }),                                         // 이미 있음 → 제외
    mk('c_nophoto', { photos: [] }),                                       // 사진 없음 → 제외
    mk('c_posted', { status: 'posted', tags: ['x'] }),                     // 게시 완료(태그 있음) → 제외(v361: 태그 없으면 태그만 생성 대상)
    mk('c_running', { ai_st: { st: 'running', ts: NOW - 60000, tries: 1 } }),           // 진행 중(1분) → 제외
    mk('c_stale', { ai_st: { st: 'running', ts: NOW - 20 * 60000, tries: 1 } }),         // 20분 running → 죽은 것 → 대상
    mk('c_fail1_soon', { ai_st: { st: 'fail', ts: NOW - 60000, tries: 1 } }),            // 1회 실패 1분 전 → 10분 간격 → 제외
    mk('c_fail1_due', { ai_st: { st: 'fail', ts: NOW - 11 * 60000, tries: 1 } }),        // 1회 실패 11분 전 → 대상
    mk('c_fail2_soon', { ai_st: { st: 'fail', ts: NOW - 20 * 60000, tries: 2 } }),       // 2회 실패 20분 전 → 30분 간격 → 제외
    mk('c_fail4', { ai_st: { st: 'fail', ts: NOW - 999 * 60000, tries: 4 } }),           // 4회 → 끝 → 제외
    mk('c_locked'),                                                        // 잠금 있음 → 제외
    mk('c_done_noapply', { ai_st: { st: 'done', ts: NOW - 60000, tries: 1 } }),          // 끝났는데 ai 없음 → 대상(크론이 job에서 적용 시도)
  ];
  const got = PJ.pickCandidates(items, NOW, { c_locked: { ts: NOW - 1000, job: 'j' } }).map((c) => c.rec.id + ':' + c.why);
  T('pickCandidates 규칙: never·stale_running·retry_1(11분)·done_not_applied만 · ai/사진 없음/posted/진행 중/간격 전/4회/잠금 제외',
    got.length === 4 && got.indexOf('c_never:never') >= 0 && got.indexOf('c_stale:stale_running') >= 0 && got.indexOf('c_fail1_due:retry_1') >= 0 && got.indexOf('c_done_noapply:done_not_applied') >= 0, got.join(','));
  // v361: 게시 완료 글은 태그만
  let docP = { schema: 1, items: [{ id: 'prm_p', status: 'posted', title: '게시된 제목', body: '게시된 본문', photos: ph, tags: [] }] };
  let ap = PJ.applyResult(docP, 'prm_p', { title: 'AI 제목', body: 'AI 본문', tags: ['포항', '학교', '준설'], model: 'm', tokens: 3, job: 'j' }, NOW);
  T('v361 applyResult(posted): 제목·본문 그대로 · 태그만 채움 · ai.tags_only · ai_st done', ap.changed && ap.tags_only && docP.items[0].title === '게시된 제목' && docP.items[0].body === '게시된 본문' && docP.items[0].tags.length === 3 && docP.items[0].ai.tags_only === 1 && docP.items[0].ai_st.st === 'done' && !docP.items[0].pre_ai, JSON.stringify(docP.items[0]));
  T('v361 applyResult(posted): 태그가 없는 결과는 적용 안 함', !PJ.applyResult({ items: [{ id: 'q', status: 'posted', photos: ph }] }, 'q', { title: 'a', body: 'b', tags: [] }).changed);
  const gotP = PJ.pickCandidates([mk('p_notag', { status: 'posted', tags: [] }), mk('p_tag', { status: 'posted', tags: ['x'] }), mk('p_ai', { status: 'posted', ai: {} })], NOW, {}).map((c) => c.rec.id);
  T('v361 pickCandidates: 게시 완료는 태그 없을 때만 대상', gotP.length === 1 && gotP[0] === 'p_notag', gotP.join(','));
  T('setAiState: running마다 tries +1 · fail은 code·job 보존', (() => { const r = {}; PJ.setAiState(r, 'running', { job: 'j1' }, NOW); PJ.setAiState(r, 'fail', { code: 'NETWORK', job: 'j1' }, NOW + 1); PJ.setAiState(r, 'running', { job: 'j2' }, NOW + 2); return r.ai_st.tries === 2 && r.ai_st.st === 'running' && r.ai_st.job === 'j2'; })());
  T('C132 setAiState: 초안(ai)이 있는 기록은 fail·running으로 덮지 않음(상태 done·잡 그대로) · done은 씀 · 초안 없는 기록은 종전대로', (() => { const r = { ai: { by: 'server', pv: 'p2' }, ai_st: { st: 'done', ts: NOW, tries: 1, job: 'j1' } }; const back = PJ.setAiState(r, 'fail', { code: 'NETWORK', detail: 'fetch failed', job: 'j2' }, NOW + 1); PJ.setAiState(r, 'running', { job: 'j3' }, NOW + 2); const keep = r.ai_st.st === 'done' && r.ai_st.job === 'j1' && r.ai_st.tries === 1 && !('code' in r.ai_st) && back.st === 'done'; PJ.setAiState(r, 'done', { job: 'j4' }, NOW + 3); const d = r.ai_st.st === 'done' && r.ai_st.job === 'j4'; const n = {}; PJ.setAiState(n, 'fail', { code: 'NETWORK', job: 'j5' }, NOW); return keep && d && n.ai_st.st === 'fail' && n.ai_st.code === 'NETWORK'; })());
  // 크론 통합 — 인메모리 blob + fetch mock(워커 기동 202)
  const cron = require(join(FN, 'gw-promo-ai-cron.js'));
  const realFetch = global.fetch; const kicks = [];
  global.fetch = async (url, o) => { if (/gw-promo-ai-run-background/.test(String(url))) kicks.push(JSON.parse(o.body)); return { ok: true, status: 202 }; };   // 생성 워커 기동만 센다(체크 10 3단계 크론 ⑥의 품질 학습 워커 기동은 따로 — tools/promoqlearn_check.mjs)
  try {
    mem.gw_data['col:promo'] = { schema: 1, items: [
      mk('p_old_done', { title: '예비', body: '예비' }),                          // 옛 워커 완료작이 job blob에만 있음 → 적용
      mk('p_new', { title: '예비2', body: '예비2' }),                            // 시작 대상
      mk('p_posted', { status: 'posted', tags: ['x'] }),
    ] };
    mem.gw_data['promoai:job:pa_gen_aaa_11111111'] = { status: 'done', promo_id: 'p_old_done', title: '완료 제목', body: '완료 본문', tags: ['t1'], model: 'm', used_tokens: { total: 5 }, title_type: 'q' };
    mem.gw_data['promoai:usage'] = { schema: 1, months: {} };
    const r = await cron.handler({});
    const out = JSON.parse(r.body);
    const pd = mem.gw_data['col:promo'].items;
    const oldDone = pd.filter((x) => x.id === 'p_old_done')[0], pNew = pd.filter((x) => x.id === 'p_new')[0], pPosted = pd.filter((x) => x.id === 'p_posted')[0];
    T('크론 ①: 끝났는데 안 실린 옛 작업을 job blob에서 기록에 적용(제목·태그·ai·ai_st done)', r.statusCode === 200 && out.applied === 1 && oldDone.title === '완료 제목' && oldDone.tags[0] === 't1' && oldDone.ai && oldDone.ai_st.st === 'done', JSON.stringify(out));
    T('크론 ②: 초안 없는 기록은 서버가 시작(잠금·job queued·워커 기동 1회) · 게시 완료는 손대지 않음', out.started.length === 1 && out.started[0].id === 'p_new' && kicks.length === 1 && kicks[0].promo_id === 'p_new' && mem.gw_data['promoai:lock:p_new'].job === kicks[0].job && mem.gw_data['promoai:job:' + kicks[0].job].status === 'queued' && !pPosted.ai && !pPosted.ai_st, JSON.stringify(out));
    const r2 = await cron.handler({}); const out2 = JSON.parse(r2.body);
    T('크론 멱등: 바로 다시 돌면 잠금 때문에 시작 0·적용 0', out2.started.length === 0 && out2.applied === 0, JSON.stringify(out2));
    // 워커 실패 → ai_st fail → 간격 뒤 크론 재시작 (워커는 절 25 하네스처럼 직접 호출하지 않고 updatePromo 경로만 실측)
    await PJ.updatePromo(mem.gw_data ? { name: 'gw_data', toString() { return 'gw_data'; } } : null, 'p_new', (rec) => { PJ.setAiState(rec, 'fail', { code: 'NETWORK', job: kicks[0].job }, Date.now() - 11 * 60000); rec.ai_st.tries = 1; return {}; });
    mem.gw_data['promoai:lock:p_new'] = { ts: 0, job: '' };
    const r3 = await cron.handler({}); const out3 = JSON.parse(r3.body);
    T('크론 재시도: 실패 11분 뒤 다시 시작(why retry_1) · 기동 실패면 ai_st fail에 이유', out3.started.length === 1 && out3.started[0].why === 'retry_1' && kicks.length === 2, JSON.stringify(out3));
    global.fetch = async () => { throw new Error('down'); };
    mem.gw_data['promoai:lock:p_new'] = { ts: 0, job: '' };
    await PJ.updatePromo({ name: 'gw_data', toString() { return 'gw_data'; } }, 'p_new', (rec) => { PJ.setAiState(rec, 'fail', { code: 'NETWORK' }, Date.now() - 40 * 60000); rec.ai_st.tries = 2; return {}; });
    const r4 = await cron.handler({}); const out4 = JSON.parse(r4.body);
    const pn4 = mem.gw_data['col:promo'].items.filter((x) => x.id === 'p_new')[0];
    T('크론 기동 실패(KICKOFF_FAILED): 잠금 해제·job fail·기록 ai_st fail 코드', out4.failed.length === 1 && out4.failed[0].code === 'KICKOFF_FAILED' && pn4.ai_st.st === 'fail' && pn4.ai_st.code === 'KICKOFF_FAILED' && mem.gw_data['promoai:lock:p_new'].ts === 0, JSON.stringify(out4) + ' ' + JSON.stringify(pn4.ai_st));
  } finally { global.fetch = realFetch; }
}

// ===== 44. 사진 가리기 얼굴·머리 검출기 v364(PM 9/16 "얼굴 못 가리네 … 근본적으로" → "중국계 불허") — 순수 함수(머리 상자·후보·군집·투표) · 워커(검출기 얼굴 + Claude 번호판 / 못 실리면 종전) · 크론 옛 판 재감지 · 동봉 파일(MoveNet만)
{
  const fp = require.resolve(join(FN, '_lib/facedet.js'));
  const savedFace = require.cache[fp]; delete require.cache[fp];
  const FD = require(fp);                       // 실 모듈(순수 함수만 — 모델은 지연 적재라 안 실린다)
  require.cache[fp] = savedFace;
  const A = { x: 0.10, y: 0.10, w: 0.05, h: 0.05 };
  T('iou: 같은 상자 1 · 떨어진 상자 0 · 반 겹침 1/3', Math.abs(FD.iou(A, A) - 1) < 1e-9 && FD.iou(A, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }) === 0 && Math.abs(FD.iou(A, { x: 0.125, y: 0.10, w: 0.05, h: 0.05 }) - 1 / 3) < 1e-9, String(FD.iou(A, A)));
  T('centerIn: 중심이 안이면 참, 밖이면 거짓', FD.centerIn({ x: 0.11, y: 0.11, w: 0.02, h: 0.02 }, A) && !FD.centerIn({ x: 0.2, y: 0.2, w: 0.02, h: 0.02 }, A), '');
  const kps = [{ name: 'nose', x: 100, y: 100, score: 0.9 }, { name: 'left_eye', x: 95, y: 95, score: 0.8 }, { name: 'right_eye', x: 105, y: 95, score: 0.8 }, { name: 'left_ear', x: 90, y: 98, score: 0.3 }, { name: 'right_ear', x: 110, y: 98, score: 0.1 }, { name: 'left_shoulder', x: 70, y: 140, score: 0.7 }, { name: 'right_shoulder', x: 130, y: 140, score: 0.7 }];
  const hb = FD.headBoxFromKeypoints(kps, 600, 400);
  T('headBoxFromKeypoints(픽셀): 코·눈·귀(0.25 이상)로 머리 상자 — 코(100,100)를 품고 크기=max(외접 20·5, 어깨 60×0.55=33, 짧은 변 3%=12)=33 → w 42.9·h 49.5, 중심 (97.5,97.5: 왼귀 90~오른눈 105, 0.1짜리 오른귀 제외)', hb && Math.abs(hb.size - 33) < 1e-9 && Math.abs(hb.w - 33 * 1.3) < 1e-9 && Math.abs(hb.h - 33 * 1.5) < 1e-9 && hb.cx === 97.5 && hb.cy === 97.5 && 100 > hb.x && 100 < hb.x + hb.w && 100 > hb.y && 100 < hb.y + hb.h, JSON.stringify(hb));
  T('headBoxFromKeypoints: 머리 관절점이 전부 약하면 null · headScore = {best 최고, n 보이는 개수(0.25↑)}', FD.headBoxFromKeypoints([{ name: 'nose', x: 1, y: 1, score: 0.1 }], 600, 400) === null && FD.headScore(kps).best === 0.9 && FD.headScore(kps).n === 4 && FD.headScore([]).best === 0, JSON.stringify(FD.headScore(kps)));
  const pose = { score: 0.35, keypoints: kps };
  const c1 = FD.candidateOf(pose, 600, 400, false, 'w256'), c2 = FD.candidateOf(pose, 600, 400, true, 'f256');
  T('candidateOf: 후보 ok(자세 0.35≥0.10·머리 0.9≥0.40·머리점 4≥2) · 반전판은 x를 되돌린다(600-97.5=502.5)', c1.ok && c1.pass === 'w256' && c1.box.cx === 97.5 && c2.ok && c2.box.cx === 502.5 && c2.box.cy === 97.5, JSON.stringify([c1.box.cx, c2.box.cx]));
  T('candidateOf: 자세 0.05 → 탈락 · 머리 최고 0.3 → 탈락 · 머리점 1개 → 탈락', !FD.candidateOf({ score: 0.05, keypoints: kps }, 600, 400, false, 'w').ok && !FD.candidateOf({ score: 0.5, keypoints: kps.map((k) => Object.assign({}, k, { score: Math.min(k.score, 0.3) })) }, 600, 400, false, 'w').ok && !FD.candidateOf({ score: 0.5, keypoints: [{ name: 'nose', x: 1, y: 1, score: 0.9 }] }, 600, 400, false, 'w').ok, '');
  // 군집·투표: 같은 자리 4판(w192·w256·f256·w320) + 다른 자리 2판(w384·f384) + 같은 판 중복(w256 두 번 = 1표)
  const mk44 = (pass, cx, cy, s) => FD.candidateOf({ score: s, keypoints: kps.map((k) => Object.assign({}, k, { x: k.x + (cx - 100), y: k.y + (cy - 100) })) }, 600, 400, false, pass);
  const cands = [mk44('w192', 100, 100, 0.3), mk44('w256', 102, 99, 0.4), mk44('w256', 101, 101, 0.2), mk44('f256', 98, 102, 0.35), mk44('w320', 100, 103, 0.25), mk44('w384', 400, 300, 0.5), mk44('f384', 402, 301, 0.45), Object.assign(mk44('w448', 300, 200, 0.5), { ok: false })];
  const cls = FD.clusterCandidates(cands);
  const cl4 = cls.filter((c) => c.passes.length === 4)[0], cl2 = cls.filter((c) => c.passes.length === 2)[0];
  T('clusterCandidates: 군집 2(같은 자리 5후보=4판, 다른 자리 2판) · ok 아닌 후보 제외 · 같은 판 중복은 1표 · 점수 높은 군집이 앞', cls.length === 2 && cl4 && cl4.members.length === 5 && cl4.maxS === 0.4 && cl2 && cl2.members.length === 2 && cls[0] === cl2, JSON.stringify(cls.map((c) => [c.passes, c.members.length])));
  const fin = FD.finalsOf(cls, 600, 400);
  T('finalsOf: 3표 이상만 최종(1개) · 상자는 구성원 중앙값×1.3 비율 좌표 · src movenet-vote4 · 중심 (100,~100)이 상자 안', fin.length === 1 && fin[0].src === 'movenet-vote4' && fin[0].votes === 4 && fin[0].kind === 'face' && Math.abs(fin[0].w * 600 - 33 * 1.3 * 1.3) < 1e-6 && (100 / 600) > fin[0].x && (100 / 600) < fin[0].x + fin[0].w && (100 / 400) > fin[0].y && (100 / 400) < fin[0].y + fin[0].h, JSON.stringify(fin));
  T('finalsOf: votesMin 2로 낮추면 2개 · median 홀짝', FD.finalsOf(cls, 600, 400, { votesMin: 2 }).length === 2 && FD.median([3, 1, 2]) === 2 && FD.median([4, 1, 3, 2]) === 2.5, '');
  T('facedet 적재: WASM 백엔드 확인(실패면 WASM_BACKEND_FAILED로 던져 폴백) · 판마다 엔진 스코프', /if \(!okBackend \|\| tf\.getBackend\(\) !== 'wasm'\) throw new Error\('WASM_BACKEND_FAILED'\)/.test(require('fs').readFileSync(fp, 'utf8')) && /eng\.startScope\(\);/.test(require('fs').readFileSync(fp, 'utf8')) && /eng\.endScope\(\);/.test(require('fs').readFileSync(fp, 'utf8')), '');
  T('상수: SIZES 192~512 6단 · POSE 0.10 · HEAD 0.40 · KP 0.25 · NHEAD 2 · VOTES 3 · EXPAND 1.3 · modelRoot 첫 후보 __dirname/_models', JSON.stringify(FD.SIZES) === '[192,256,320,384,448,512]' && FD.POSE_MIN === 0.1 && FD.HEAD_MIN === 0.4 && FD.KP_MIN === 0.25 && FD.NHEAD_MIN === 2 && FD.VOTES_MIN === 3 && FD.EXPAND === 1.3 && /const cands = \[path\.join\(__dirname, '_models'\)\]/.test(require('fs').readFileSync(fp, 'utf8')), '');
  // 동봉 파일·배선
  const fs44 = require('fs');
  const MD = join(FN, '_models');
  const need = ['wasm/tfjs-backend-wasm.wasm', 'wasm/tfjs-backend-wasm-simd.wasm', 'wasm/tfjs-backend-wasm-threaded-simd.wasm', 'movenet/model.json', 'movenet/group1-shard1of3.bin', 'movenet/group1-shard2of3.bin', 'movenet/group1-shard3of3.bin'];
  const missing = need.filter((p) => { try { return fs44.statSync(join(MD, p)).size < 1000; } catch (e) { return true; } });
  T('모델 동봉 7파일(wasm 3·movenet 4) 전부 있음(1KB 이상) · face-api 폴더 없음(SSD·Tiny 가중치 불허) · modelRoot가 찾는다', missing.length === 0 && !fs44.existsSync(join(MD, 'face-api')) && !!FD.modelRoot(), missing.join(','));
  const toml = fs44.readFileSync(join(ROOT, 'netlify.toml'), 'utf8'), pkg = JSON.parse(fs44.readFileSync(join(ROOT, 'package.json'), 'utf8'));
  T('netlify.toml: gw-promo-mask-background included_files=_models/** · package.json deps tfjs·wasm·pose-detection·@mediapipe/pose, face-api 없음 · facedet.js는 얼굴 모델을 싣지 않는다', /\[functions\."gw-promo-mask-background"\]\s*\n\s*included_files = \["netlify\/functions\/_models\/\*\*"\]/.test(toml) && ['@tensorflow/tfjs', '@tensorflow/tfjs-backend-wasm', '@tensorflow-models/pose-detection', '@mediapipe/pose'].every((d) => pkg.dependencies[d]) && !pkg.dependencies['@vladmandic/face-api'] && !/face-api\/dist|ssdMobilenetv1|tinyFaceDetector|face-detection'\)/.test(require('fs').readFileSync(fp, 'utf8')), '');
  const wsrc = fs44.readFileSync(join(FN, 'gw-promo-mask-background.js'), 'utf8'), csrc = fs44.readFileSync(join(FN, 'gw-promo-ai-cron.js'), 'utf8'), msrc = fs44.readFileSync(join(FN, 'gw-promo-mask.js'), 'utf8');
  T('배선: 워커 F.detectFaces·faces===null 폴백·model facedet+ · 크론 remaskOld·startForCron(force) · mask exports.startForCron', /F\.detectFaces\(raw\)/.test(wsrc) && /faces === null \? true : b\.kind !== 'face'/.test(wsrc) && /'facedet\+' \+ det\.model/.test(wsrc) && /async function remaskOld/.test(csrc) && /startForCron\(st, \{ promoId: r\.id, ids: old, force: true/.test(csrc) && /exports\.startForCron = startForCron/.test(msrc) && /only_old: !!onlyOld/.test(msrc) && /"@mediapipe\/pose"/.test(JSON.stringify(pkg.dependencies)), '');
  // 워커 통합 — 검출기 켬: 검출기 얼굴 + Claude 번호판, Claude 얼굴은 버림
  const gwm = require(join(FN, 'gw-promo-mask.js'));
  const wk = require(join(FN, 'gw-promo-mask-background.js'));
  const cron44 = require(join(FN, 'gw-promo-ai-cron.js'));
  const { Jimp } = require('jimp');
  const img44 = new Jimp({ width: 600, height: 400, color: 0x2266aaff }); for (let y = 100; y < 200; y++) for (let x = 200; x < 300; x++) img44.setPixelColor((((x * 5) % 256 << 24) | ((y * 7) % 256 << 16) | (50 << 8) | 255) >>> 0, x, y);
  const b64 = (await img44.getBuffer('image/jpeg', { quality: 90 })).toString('base64');
  const A9 = 'att_' + 'e'.repeat(16), A10 = 'att_' + 'f'.repeat(16), A11 = 'att_' + '1'.repeat(16);
  mem.gw_files[A9] = { name: 'p9.jpg', type: 'image/jpeg', kind: 'promo', data: b64, by: 'x', ts: 1 };
  mem.gw_files[A10] = { name: 'p10.jpg', type: 'image/jpeg', kind: 'promo', data: b64, by: 'x', ts: 1 };
  mem.gw_files[A11] = { name: 'p11.jpg', type: 'image/jpeg', kind: 'promo', data: b64, by: 'x', ts: 1 };
  mem.gw_files['maskmeta:' + A10] = { schema: 1, has: true, n: 1, human: false, auto: true, w: 600, h: 400, ts: 5, model: 'facedet+platedet2+claude-sonnet-5' };   // 이미 새 판(v371 = platedet 포함)
  mem.gw_files['maskmeta:' + A11] = { schema: 1, has: true, n: 2, human: true, auto: false, w: 600, h: 400, ts: 5, model: 'human' };                    // 사람 판
  mem.gw_data['col:promo'] = { schema: 1, items: [
    { id: 'prv364', title: 't', body: 'b', status: 'review', photos: [{ id: A9, name: 'p9.jpg' }, { id: A10, name: 'p10.jpg' }, { id: A11, name: 'p11.jpg' }], ai: { ts: 1 }, tags: ['x'] },
    { id: 'prv364p', title: 't', body: 'b', status: 'posted', photos: [{ id: A9, name: 'p9.jpg' }], ai: { ts: 1 }, tags: ['x'] },
    { id: 'bad:id/x', title: 't', body: 'b', status: 'review', photos: [{ id: A9, name: 'p9.jpg' }], ai: { ts: 1 }, tags: ['x'] },
  ] };
  mem.gw_data['promomask:usage'] = { schema: 1, months: {} };
  const savedKey = process.env.GW_ANTHROPIC_KEY, savedUrl = process.env.URL; process.env.GW_ANTHROPIC_KEY = 'test-anthropic-key-0000'; process.env.URL = 'https://x.test';
  const realFetch = global.fetch; const kicks = [];
  const visionBoxes = [{ kind: 'face', x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, { kind: 'plate', x: 0.7, y: 0.7, w: 0.1, h: 0.05 }];
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (/gw-promo-mask-background/.test(u)) { kicks.push(JSON.parse(opt.body)); return { ok: true, status: 202 }; }
    if (/api\.anthropic\.com/.test(u)) return { status: 200, text: async () => JSON.stringify({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'text', text: JSON.stringify({ boxes: visionBoxes }) }] }) };
    return { ok: true, status: 202 };
  };
  try {
    const itok = issueSession({ id: '__promomask__', role: 'system' }).token;
    faceMock.fail = false; faceMock.boxes = [{ kind: 'face', x: 200 / 600, y: 100 / 400, w: 100 / 600, h: 100 / 400, score: 0.9, src: 'movenet-vote12', votes: 12 }]; faceMock.calls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364a', promo_id: 'prv364', ids: [A9], force: true }) }, {});
    const mm = mem.gw_files['maskmeta:' + A9], mk9 = mem.gw_files['mask:' + A9], j9 = mem.gw_data['promomask:job:pm_v364a'];
    T('워커(검출기 켬): 상자 2 = 검출기 얼굴(200,100) + Claude 번호판 · Claude 얼굴(0.5,0.5)은 버림 · model facedet+claude-sonnet-5(mask·maskmeta 둘 다) · maskmeta n 2 · 사진 항목 det "faces 1"',
      faceMock.calls === 1 && mk9 && mk9.boxes.length === 2 && mk9.boxes.some((b) => b.kind === 'face' && Math.abs(b.x - 200 / 600) < 1e-6) && mk9.boxes.some((b) => b.kind === 'plate') && !mk9.boxes.some((b) => b.kind === 'face' && Math.abs(b.x - 0.5) < 1e-6) && mk9.model === 'facedet+claude-sonnet-5' && mm && mm.model === 'facedet+claude-sonnet-5' && mm.n === 2 && mk9.data && j9 && j9.photos[0].st === 'masked' && /^faces 1 \(/.test(j9.photos[0].det || ''), JSON.stringify(mk9 && mk9.boxes) + ' ' + (mm && mm.model) + ' ' + JSON.stringify(j9 && j9.photos[0]));
    T('워커 결과 상자는 by:auto · 픽셀화 실효(검출기 상자 안 색차 큼)', mk9.boxes.every((b) => b.by === 'auto') && (await (async () => { const o = await Jimp.read(Buffer.from(b64, 'base64')); const m = await Jimp.read(Buffer.from(mk9.data, 'base64')); let d = 0; for (let k = 0; k < 20; k++) { const a = o.getPixelColor(205 + k * 4, 105 + k * 4), b = m.getPixelColor(205 + k * 4, 105 + k * 4); d += Math.abs((a >>> 24) - (b >>> 24)) + Math.abs(((a >>> 16) & 255) - ((b >>> 16) & 255)); } return d / 20 > 20; })()), '');
    // 검출기 못 실림 → 종전(Claude 전부)
    faceMock.fail = true; faceMock.calls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364b', promo_id: 'prv364', ids: [A9], force: true }) }, {});
    const mm2 = mem.gw_files['maskmeta:' + A9], mk9b = mem.gw_files['mask:' + A9], j9b = mem.gw_data['promomask:job:pm_v364b'];
    T('워커(검출기 못 실림): Claude 얼굴+번호판 2상자 그대로 · model claude-sonnet-5(facedet 없음) · det "facedet fail: MODELS_MISSING"',
      mk9b.boxes.length === 2 && mk9b.boxes.some((b) => b.kind === 'face' && Math.abs(b.x - 0.5) < 1e-6) && mk9b.model === 'claude-sonnet-5' && mm2.model === 'claude-sonnet-5' && /^facedet fail: MODELS_MISSING/.test(j9b.photos[0].det || ''), JSON.stringify(mk9b.boxes) + ' ' + mm2.model + ' ' + (j9b.photos[0].det || ''));
    // 재감지(only_old): 검출기 살아 있음 → 얼굴은 검출기, 번호판은 옛 판(Claude) 재사용 → Claude 호출 0
    faceMock.fail = false; faceMock.calls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364c', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
    { const mkc = mem.gw_files['mask:' + A9], jc = mem.gw_data['promomask:job:pm_v364c'];
      T('워커 재감지(only_old, 얼굴 검출기 켬·차량 검출기 못 실림): 상자 2 = 검출기 얼굴 + 번호판(종전 전체 사진 1회로 새로 감지 — v371: 옛 판 재사용 없음) · Claude 얼굴(0.5) 제거 · 호출 1 · model facedet+claude-sonnet-5 · det "platedet fail: MODELS_MISSING"',
        jc.status === 'done' && jc.calls === 1 && jc.det_fail === 0 && jc.photos[0].st === 'masked' && /platedet fail: MODELS_MISSING/.test(jc.photos[0].det || '') && mkc.boxes.length === 2 && mkc.boxes.some((b) => b.kind === 'plate' && Math.abs(b.x - 0.7) < 1e-6) && mkc.boxes.some((b) => b.kind === 'face' && Math.abs(b.x - 200 / 600) < 1e-6) && !mkc.boxes.some((b) => b.kind === 'face' && Math.abs(b.x - 0.5) < 1e-6) && mkc.model === 'facedet+claude-sonnet-5' && mkc.boxes.every((b) => b.by === 'auto'), JSON.stringify(jc.photos[0]) + ' ' + JSON.stringify(mkc.boxes));
      // 새 판이면 only_old는 건너뛴다(kept:auto) — v371: 새 판 = model에 platedet가 있는 판
      mem.gw_files['mask:' + A9].model = 'facedet+platedet2+claude-sonnet-5'; mem.gw_files['maskmeta:' + A9].model = 'facedet+platedet2+claude-sonnet-5';
      await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364d', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
      T('워커 재감지: 이미 새 판(facedet+platedet+)이면 kept:auto · 호출 0', mem.gw_data['promomask:job:pm_v364d'].photos[0].st === 'kept:auto' && mem.gw_data['promomask:job:pm_v364d'].calls === 0, JSON.stringify(mem.gw_data['promomask:job:pm_v364d'].photos[0]));
      // 검출기 못 실림 + only_old → skip:detector(Claude 호출 없음·판 그대로·det_fail 1)
      mem.gw_files['mask:' + A9].model = 'claude-sonnet-5'; mem.gw_files['maskmeta:' + A9].model = 'claude-sonnet-5';
      faceMock.fail = true; faceMock.calls = 0;
      await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364e', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
      const je = mem.gw_data['promomask:job:pm_v364e'];
      T('워커 재감지(검출기 못 실림): skip:detector · Claude 호출 0 · 판 그대로(model claude) · det_fail 1 · 감사에 "검출기 실패 1장"', je.status === 'done' && je.calls === 0 && je.det_fail === 1 && je.photos[0].st === 'skip:detector' && mem.gw_files['mask:' + A9].model === 'claude-sonnet-5' && auditMock.logs.some((l) => l.ev && l.ev[0].op === '자동가리기' && /검출기 실패 1장/.test(l.ev[0].t)), JSON.stringify(je.photos[0]));
    }
    // 검증 #8: 검출기가 한 장도 못 돈 재감지 회차는 시도로 안 센다(tries 되돌림) + det_down 표식
    mem.gw_data['promomask:remask:prv364'] = { tries: 1, ts: 1 };
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364f', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
    T('워커 재감지(검출기 못 실림): 표식 tries 1→0 · det_down 기록', mem.gw_data['promomask:remask:prv364'].tries === 0 && mem.gw_data['promomask:remask:prv364'].det_down > 0, JSON.stringify(mem.gw_data['promomask:remask:prv364']));
    delete mem.gw_data['promomask:remask:prv364'];
    // 검증 #9: 검출기 오류 문구는 코드만(경로 없음) · scrub이 경로를 지운다
    faceMock.fail = new Error("ENOENT: no such file or directory, open 'C:\\var\\task\\netlify\\functions\\_models\\movenet\\model.json'");
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364g', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
    T('검출기 오류 문구: "facedet fail: ENOENT"(경로·상세 없음)', mem.gw_data['promomask:job:pm_v364g'].photos[0].det === 'facedet fail: ENOENT', mem.gw_data['promomask:job:pm_v364g'].photos[0].det);
    delete mem.gw_data['promomask:remask:prv364'];
    faceMock.fail = true;
    // 검증 #5: 검출기 켬 + 얼굴 0 → Claude 얼굴은 버리고 번호판만 · 클램프(가장자리 음수 상자)
    faceMock.fail = false; faceMock.boxes = []; faceMock.calls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364h', promo_id: 'prv364', ids: [A9], force: true }) }, {});
    { const mh = mem.gw_files['mask:' + A9];
      T('워커(검출기 켬·얼굴 0): Claude 얼굴 버림 → 번호판 1상자만 · model facedet+ · st masked', mh.boxes.length === 1 && mh.boxes[0].kind === 'plate' && mh.model === 'facedet+claude-sonnet-5' && mem.gw_data['promomask:job:pm_v364h'].photos[0].st === 'masked', JSON.stringify(mh.boxes)); }
    faceMock.boxes = [{ kind: 'face', x: -0.02, y: 0.95, w: 0.10, h: 0.10, score: 0.5, src: 'movenet-vote3', votes: 3 }];
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364i', promo_id: 'prv364', ids: [A9], force: true }) }, {});
    { const fb = mem.gw_files['mask:' + A9].boxes.filter((b) => b.kind === 'face')[0];
      T('워커: 가장자리 상자는 클램프(x 0·y+h ≤ 1)', fb && fb.x === 0 && fb.y + fb.h <= 1 + 1e-9 && fb.w > 0, JSON.stringify(fb)); }
    // 검증 #7: 재감지에서 검출기가 머리 0인데 옛 판에 얼굴 상자가 있으면 옛 판 유지(skip:noface) · no_face 1 · 감사 문구
    mem.gw_files['mask:' + A9].model = 'claude-sonnet-5'; mem.gw_files['maskmeta:' + A9].model = 'claude-sonnet-5';
    mem.gw_files['mask:' + A9].boxes = [{ kind: 'face', x: 0.5, y: 0.5, w: 0.1, h: 0.1, by: 'auto' }, { kind: 'plate', x: 0.7, y: 0.7, w: 0.1, h: 0.05, by: 'auto' }];
    faceMock.boxes = []; faceMock.calls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364j', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
    { const jj = mem.gw_data['promomask:job:pm_v364j'];
      T('워커 재감지(머리 0·옛 판에 얼굴 있음): skip:noface · 옛 판 그대로(model claude) · no_face 1 · Claude 호출 0 · 감사 "얼굴 미검출"', jj.photos[0].st === 'skip:noface' && jj.no_face === 1 && jj.calls === 0 && mem.gw_files['mask:' + A9].model === 'claude-sonnet-5' && mem.gw_files['mask:' + A9].boxes.length === 2 && auditMock.logs.some((l) => l.ev && l.ev[0].op === '자동가리기' && /얼굴 미검출\(옛 판 유지\) 1장/.test(l.ev[0].t)), JSON.stringify(jj.photos[0])); }
    // 검증 #10: 고아 maskmeta(mask 판 없음) → skip:nomask(Claude 호출 0)
    { const savedMask = mem.gw_files['mask:' + A9]; delete mem.gw_files['mask:' + A9];
      faceMock.boxes = [{ kind: 'face', x: 0.3, y: 0.3, w: 0.1, h: 0.1, score: 0.9, src: 'movenet-vote12', votes: 12 }]; faceMock.calls = 0;
      await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v364k', promo_id: 'prv364', ids: [A9], force: true, only_old: true }) }, {});
      T('워커 재감지(고아 메타): skip:nomask · 검출기·Claude 호출 0 · 판 생성 없음', mem.gw_data['promomask:job:pm_v364k'].photos[0].st === 'skip:nomask' && faceMock.calls === 0 && mem.gw_data['promomask:job:pm_v364k'].calls === 0 && !mem.gw_files['mask:' + A9], JSON.stringify(mem.gw_data['promomask:job:pm_v364k'].photos[0]));
      mem.gw_files['mask:' + A9] = savedMask; }
    faceMock.fail = true; faceMock.boxes = [];
    // 크론 재감지: 옛 판(model에 facedet 없음)이 있는 게시 전 기록 → mask_start(force) 1건 · 게시 완료 기록은 안 봄
    kicks.length = 0;
    mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
    let rc = await cron44.handler({}); let oc = JSON.parse(rc.body);
    T('크론 ③ 재감지: 옛 판 1장(새 판 A10·사람 판 A11 제외) → prv364 mask_start(force true, ids=[A9]만) 1회 · 잠금·job queued(n 1) · 게시 완료 prv364p·형식 밖 id는 대상 아님', rc.statusCode === 200 && oc.remask && oc.remask.promo === 'prv364' && oc.remask.old === 1 && oc.remask.seen === 3 && oc.remask.ok === true && kicks.length === 1 && kicks[0].promo_id === 'prv364' && kicks[0].force === true && kicks[0].ids.length === 1 && kicks[0].ids[0] === A9 && kicks[0].only_old === true && auditMock.logs.some((l) => l.ev && l.ev[0].op === '가리기재감지') && mem.gw_data['promomask:lock:prv364'].job === kicks[0].job && mem.gw_data['promomask:job:' + kicks[0].job].status === 'queued' && mem.gw_data['promomask:job:' + kicks[0].job].n === 1 && !mem.gw_data['promomask:remask:bad:id/x'], JSON.stringify(oc.remask) + ' kicks ' + JSON.stringify(kicks));
    rc = await cron44.handler({}); oc = JSON.parse(rc.body);
    T('크론 ③ 멱등: 잠금 살아 있으면 그 기록은 읽지도 않는다(scanned 0·기동 0·시도 수 그대로 1)', oc.remask && oc.remask.scanned === 0 && !oc.remask.promo && kicks.length === 1 && mem.gw_data['promomask:remask:prv364'].tries === 1, JSON.stringify(oc.remask));
    mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
    rc = await cron44.handler({}); oc = JSON.parse(rc.body);
    T('크론 ③ 2회차: 옛 판이 그대로면 한 번 더(시도 2)', oc.remask && oc.remask.promo === 'prv364' && oc.remask.ok === true && kicks.length === 2 && mem.gw_data['promomask:remask:prv364'].tries === 2, JSON.stringify(oc.remask));
    mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
    rc = await cron44.handler({}); oc = JSON.parse(rc.body);
    T('크론 ③ 상한: 2회 뒤에도 옛 판이면 더 안 돈다(capped 1·기동 없음·done 표식) — 검출기 못 실리는 배포에서 무한 반복 방지', oc.remask && !oc.remask.promo && oc.remask.capped === 1 && kicks.length === 2 && mem.gw_data['promomask:remask:prv364'].done > 0, JSON.stringify(oc.remask));
    rc = await cron44.handler({}); oc = JSON.parse(rc.body);
    T('크론 ③ done 표식: 기록이 안 바뀌면 maskmeta를 다시 안 읽는다(scanned 0)', oc.remask && oc.remask.scanned === 0 && kicks.length === 2, JSON.stringify(oc.remask));
    mem.gw_files['maskmeta:' + A9].model = 'facedet+platedet2+claude-sonnet-5';
    mem.gw_data['col:promo'].items[0].updated_ts = Date.now() + 5;   // 기록이 바뀌면 다시 본다
    mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
    rc = await cron44.handler({}); oc = JSON.parse(rc.body);
    T('크론 ③: 기록이 바뀌어 다시 보니 새 판만 → 대상 0 · done 갱신', oc.remask && oc.remask.old === 0 && !oc.remask.promo && oc.remask.capped === 0 && oc.remask.scanned === 1 && kicks.length === 2, JSON.stringify(oc.remask));
    // 크론 예산 70%: 사용량이 상한 70%를 넘으면 BUDGET_CAP(시도 수 안 셈) — 사람 mask_start 몫 보호
    delete mem.gw_data['promomask:remask:prv364'];
    mem.gw_files['maskmeta:' + A9].model = 'claude-sonnet-5';
    mem.gw_data['col:promo'].items[0].updated_ts = Date.now() + 9;
    mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
    { const mk = require(join(FN, 'gw-promo-mask.js'));
      const d0 = new Date(Date.now() + 9 * 3600000); const mkey = d0.getUTCFullYear() + '-' + String(d0.getUTCMonth() + 1).padStart(2, '0');
      mem.gw_data['promomask:usage'] = { schema: 1, months: {} }; mem.gw_data['promomask:usage'].months[mkey] = { calls: 700, input: 0, output: 0 };
      rc = await cron44.handler({}); oc = JSON.parse(rc.body);
      T('크론 ③ 예산: 월 700(=1000×70%) 사용이면 BUDGET_CAP · 기동 0 · 시도 수 없음', oc.remask && oc.remask.promo === 'prv364' && oc.remask.ok === false && oc.remask.code === 'BUDGET_CAP' && kicks.length === 2 && !(mem.gw_data['promomask:remask:prv364'] && mem.gw_data['promomask:remask:prv364'].tries), JSON.stringify(oc.remask) + ' ' + JSON.stringify(mem.gw_data['promomask:remask:prv364']));
      mem.gw_data['promomask:usage'] = { schema: 1, months: {} };
      delete mem.gw_data['promomask:remask'];   // 예산 검사(BUDGET_CAP=전역 원인)가 남긴 전역 중단 표식 제거
      // 검증 #1: done 표식은 사진마다 판이 다 있을 때만 — 판 없는 새 기록은 표식 없이 다음 회차
      mem.gw_files['maskmeta:' + A9].model = 'facedet+platedet2+claude-sonnet-5';
      mem.gw_data['col:promo'].items.push({ id: 'prv364n', title: 't', body: 'b', status: 'review', photos: [{ id: 'att_' + '2'.repeat(16), name: 'p.jpg' }], ai: { ts: 1 }, tags: ['x'], updated_ts: Date.now() + 20 });
      mem.gw_data['col:promo'].items[0].updated_ts = Date.now() + 20;
      mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
      rc = await cron44.handler({}); oc = JSON.parse(rc.body);
      T('크론 ③ done 조건: 판이 다 있는 prv364는 done · 판 없는 prv364n은 표식 없음(scanned 2)', oc.remask && oc.remask.scanned === 2 && mem.gw_data['promomask:remask:prv364'].done > 0 && !(mem.gw_data['promomask:remask:prv364n'] && mem.gw_data['promomask:remask:prv364n'].done), JSON.stringify(oc.remask) + ' ' + JSON.stringify(mem.gw_data['promomask:remask:prv364n']));
      mem.gw_data['col:promo'].items = mem.gw_data['col:promo'].items.filter((x) => x.id !== 'prv364n');
      mem.gw_files['maskmeta:' + A9].model = 'claude-sonnet-5'; delete mem.gw_data['promomask:remask:prv364'];
      mem.gw_data['col:promo'].items[0].updated_ts = Date.now() + 30;
      // 검증 #1: 가리기 작업이 도는 중(잠금 살아 있음)이면 그 기록은 건너뛴다(scanned 0)
      mem.gw_data['promomask:lock:prv364'] = { ts: Date.now(), job: 'pm_running' };
      rc = await cron44.handler({}); oc = JSON.parse(rc.body);
      T('크론 ③ 잠금 중 기록은 읽지 않는다(scanned 0·기동 없음)', oc.remask && oc.remask.scanned === 0 && !oc.remask.promo && kicks.length === 2, JSON.stringify(oc.remask));
      mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
      // 검증 #8: det_down 표식이 6시간 안이면 건너뛴다
      mem.gw_data['promomask:remask:prv364'] = { tries: 0, det_down: Date.now() - 60000 };
      rc = await cron44.handler({}); oc = JSON.parse(rc.body);
      T('크론 ③ 검출기 장애 표식(1분 전) → 건너뜀', oc.remask && oc.remask.scanned === 0 && !oc.remask.promo, JSON.stringify(oc.remask));
      mem.gw_data['promomask:remask:prv364'] = { tries: 0, det_down: Date.now() - 7 * 3600000 };
      rc = await cron44.handler({}); oc = JSON.parse(rc.body);
      T('크론 ③ 검출기 장애 표식(7시간 전) → 다시 감지(기동 1)', oc.remask && oc.remask.promo === 'prv364' && oc.remask.ok === true && kicks.length === 3, JSON.stringify(oc.remask));
      mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' }; delete mem.gw_data['promomask:remask:prv364'];
      // 검증 #6·#12: 전역 원인(사이트 URL 없음)으로 기동 실패 → 전역 중단 표식(6시간) · 다음 회차 ③ 전체 skipped:global · 고아 job 없음
      { const savedUrl2 = process.env.URL; process.env.URL = '';
        rc = await cron44.handler({}); oc = JSON.parse(rc.body);
        const jobsBefore = Object.keys(mem.gw_data).filter((k) => k.indexOf('promomask:job:') === 0).length;   // 첫 회차(실패 job 1개 생김) 뒤 기준
        const gm = mem.gw_data['promomask:remask'];
        T('크론 ③ 전역 기동 실패(NO_SITE_URL) → promomask:remask {until +6h, code} · 기록 시도 수 없음', oc.remask && oc.remask.ok === false && oc.remask.code === 'NO_SITE_URL' && gm && gm.code === 'NO_SITE_URL' && gm.until > Date.now() + 5 * 3600000 && !(mem.gw_data['promomask:remask:prv364'] && mem.gw_data['promomask:remask:prv364'].tries), JSON.stringify(oc.remask) + ' ' + JSON.stringify(gm));
        rc = await cron44.handler({}); oc = JSON.parse(rc.body);
        T('크론 ③ 전역 중단 중: skipped global · maskmeta 안 읽음 · 새 job 없음', oc.remask && oc.remask.skipped === 'global' && Object.keys(mem.gw_data).filter((k) => k.indexOf('promomask:job:') === 0).length === jobsBefore, JSON.stringify(oc.remask));
        process.env.URL = savedUrl2; delete mem.gw_data['promomask:remask']; mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' }; }
      // startForCron 잠금 재확인: 쓰고 나서 남의 job이 보이면 ALREADY_RUNNING(기동 없음)
      const realGet = blobsMock.hooks.beforeGet; let stolen = false;
      blobsMock.hooks.beforeGet = async (k) => { if (!stolen && k === 'promomask:lock:prv364' && mem.gw_data[k] && /^pm_/.test(String(mem.gw_data[k].job || ''))) { stolen = true; mem.gw_data[k] = { ts: Date.now(), job: 'pm_human' }; } };   // 우리가 쓴 직후의 재확인 읽기에서 남이 잡은 것으로
      const kb = kicks.length;
      const s2 = await mk.startForCron({ name: 'gw_data', toString() { return 'gw_data'; } }, { promoId: 'prv364', ids: [A9], force: true, capRatio: 0.7 });
      blobsMock.hooks.beforeGet = realGet;
      T('startForCron 잠금 재확인: 쓴 직후 남(pm_human)이 잡았으면 ALREADY_RUNNING · 기동 없음', s2.ok === false && s2.code === 'ALREADY_RUNNING' && kicks.length === kb, JSON.stringify(s2));
      mem.gw_data['promomask:lock:prv364'] = { ts: 0, job: '' };
      T('mask_apply(사람 판)는 model human으로 저장돼 재감지 대상이 아니다 · netlify.toml 크론 schedule 등록', /model: 'human'/.test(msrc) && /\[functions\."gw-promo-ai-cron"\]\s*\n\s*schedule = "\*\/10 \* \* \* \*"/.test(toml), '');
    }
    // 사람이 만진 판(human)은 재감지 대상에서 제외돼야 하나? — 아니다: force는 '자동 판만 다시'라 워커가 human을 지킨다(절 41). 여기서는 model만 본다.
  } finally { global.fetch = realFetch; process.env.GW_ANTHROPIC_KEY = savedKey; process.env.URL = savedUrl; faceMock.fail = true; faceMock.boxes = []; }
}

// ===== 45. 번호판 전용 경로 v371(PM 9/23 "차번호 덜/안 가려짐" → "ㄱ") — 순수 함수 · detectPlates 흐름(주입 차량·가짜 비전) · 워커 platedet 경로/폴백/비전 오류/재감지 · 크론 옛 판 판정
{
  const pp = require.resolve(join(FN, '_lib/platedet.js'));
  const savedPlate = require.cache[pp]; delete require.cache[pp];
  const PD = require(pp);                       // 실 모듈(순수 함수·흐름 — 모델은 지연 적재라 안 실린다; detectPlates는 vehiclesOf 주입)
  require.cache[pp] = savedPlate;
  const raw45 = [
    { cls: 'car', score: 0.3, x: 0.1, y: 0.1, w: 0.2, h: 0.2, pass: 'w512' }, { cls: 'car', score: 0.35, x: 0.11, y: 0.1, w: 0.2, h: 0.2, pass: 'f512' },
    { cls: 'truck', score: 0.7, x: 0.5, y: 0.5, w: 0.3, h: 0.3, pass: 'w800' },
    { cls: 'car', score: 0.3, x: 0.8, y: 0.1, w: 0.1, h: 0.1, pass: 'w512' },
    { cls: 'person', score: 0.9, x: 0.3, y: 0.3, w: 0.1, h: 0.3, pass: 'w512' },
    { cls: 'car', score: 0.1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, pass: 'w1024' },
  ];
  const mv = PD.mergeVehicles(raw45);
  T('mergeVehicles: 같은 자리 2판(0.3·0.35)=채택(votes 2·중앙값 x 0.105) · 0.7 1판=채택 · 0.3 1판=탈락 · person 제외 · 0.1(하한 미만) 제외 · 점수순', mv.length === 2 && mv[0].cls === 'truck' && mv[0].votes === 1 && mv[1].votes === 2 && Math.abs(mv[1].x - 0.105) < 1e-9 && Math.abs(mv[1].w - 0.2) < 1e-9, JSON.stringify(mv));
  const pr45 = PD.padRect({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 1000, 1000, 0.15, 0.6), pr45b = PD.padRect({ x: 0.95, y: 0.95, w: 0.1, h: 0.1 }, 1000, 1000, 0.15);
  T('padRect: 좌우·위 15% · 아래 60%(번호판 자리) → (470,470,260,350) · 가장자리 클램프 → (935,935,65,65)', pr45.x === 470 && pr45.y === 470 && pr45.w === 260 && pr45.h === 350 && pr45b.x === 935 && pr45b.w === 65 && pr45b.h === 65, JSON.stringify([pr45, pr45b]));
  const mf = PD.mapFromCrop({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, { x: 100, y: 200, w: 400, h: 200 }, 1000, 1000), gr = PD.grow({ x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, 0.5), bd = PD.bandOf({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }), bs = PD.bandOf({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  T('mapFromCrop 조각→원본(0.3,0.3,0.04,0.02) · grow 중심 고정 50%(0.35,0.375,0.3,0.15) · bandOf 큰 차(면적 0.16>0.15) 좁은 띠(0.3,0.48,0.2,0.12) · 보통 차 띠(0.13,0.21,0.14,0.09) · verifyPad 작은 번호판(40×25px)은 최소 200px 조각이 되게 3.5 · overlaps IoU 0.47 참/떨어지면 거짓',
    Math.abs(mf.x - 0.3) < 1e-9 && Math.abs(mf.y - 0.3) < 1e-9 && Math.abs(mf.w - 0.04) < 1e-9 && Math.abs(mf.h - 0.02) < 1e-9 && Math.abs(gr.x - 0.35) < 1e-9 && Math.abs(gr.y - 0.375) < 1e-9 && Math.abs(gr.w - 0.3) < 1e-9 && Math.abs(gr.h - 0.15) < 1e-9
    && Math.abs(bd.x - 0.3) < 1e-9 && Math.abs(bd.y - 0.48) < 1e-9 && Math.abs(bd.w - 0.2) < 1e-9 && Math.abs(bd.h - 0.12) < 1e-9 && bd.fallback === true
    && Math.abs(bs.x - 0.13) < 1e-9 && Math.abs(bs.y - 0.21) < 1e-9 && Math.abs(bs.w - 0.14) < 1e-9 && Math.abs(bs.h - 0.09) < 1e-9
    && Math.abs(PD.verifyPad({ x: 0, y: 0, w: 0.04, h: 0.025 }, 1000, 1000) - 3.5) < 1e-9 && PD.verifyPad({ x: 0, y: 0, w: 0.5, h: 0.5 }, 1000, 1000) === 0.6
    && PD.overlaps({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, [{ x: 0.12, y: 0.12, w: 0.1, h: 0.1 }]) && !PD.overlaps({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }]), JSON.stringify([mf, gr, bd]));
  T('상수: SIZES 512·800·1024 · 타일 3×3(45%) · 차량 클래스 4 · 채택 0.45↑ 또는 2판 · 아래 여백 60% · 검증 여백 60% · 재시도 40% · 띠 55%~', JSON.stringify(PD.SIZES) === '[512,800,1024]' && PD.TILES === 3 && PD.TILE_FRAC === 0.45 && Object.keys(PD.VEH).length === 4 && PD.SCORE_SURE === 0.45 && PD.VOTES_MIN === 2 && PD.CROP_PAD_BOTTOM === 0.6 && PD.VERIFY_PAD === 0.6 && PD.VERIFY_MIN_PX === 200 && PD.GROW === 0.4 && PD.BAND.top === 0.55 && PD.BAND.bigTop === 0.7 && PD.BAND.bigArea === 0.15, '');
  // detectPlates 흐름 — 600×400 그림, 차량 주입 1대(0.1,0.1,0.4,0.4). 조각 = padRect(…,0.15,0.6) = (24,16,312,280). 조각 번호판 (0.5,0.8,0.2,0.1) → 원본 (0.3,0.6,0.104,0.07). 검증 partial→grow 40%→full. 폴백 상자는 none → 버림.
  const { Jimp: J45 } = require('jimp');
  const img45 = new J45({ width: 600, height: 400, color: 0x336699ff });
  const buf45 = await img45.getBuffer('image/jpeg', { quality: 90 });
  const vlog = [];
  const mkVision = (verifyStates, plateBoxes, wholeBoxes) => { let vi = 0; return {
    plates: async (b64) => { vlog.push('plates:' + (b64.length > 100)); return { boxes: plateBoxes.map((b) => Object.assign({}, b)), usage: { input: 10, output: 1 } }; },
    verify: async (b64) => { const s = verifyStates[Math.min(vi, verifyStates.length - 1)]; vi++; vlog.push('verify:' + s); return { state: s, usage: { input: 5, output: 1 } }; },
    whole: async () => { vlog.push('whole'); return { boxes: wholeBoxes.map((b) => Object.assign({}, b)), usage: { input: 20, output: 2 } }; },
  }; };
  const vehOf = async () => ({ boxes: [{ cls: 'car', score: 0.9, x: 0.1, y: 0.1, w: 0.4, h: 0.4, votes: 3 }], w: 600, h: 400, ms: 1, diag: { passes: 15, raw: 3 } });
  const r45a = await PD.detectPlates(buf45, mkVision(['partial', 'full', 'none'], [{ kind: 'plate', x: 0.5, y: 0.8, w: 0.2, h: 0.1 }], [{ kind: 'plate', x: 0.8, y: 0.8, w: 0.1, h: 0.05 }, { kind: 'face', x: 0.1, y: 0.1, w: 0.1, h: 0.1 }]), { vehiclesOf: vehOf });
  T('detectPlates 흐름: 차량 1 → 조각 번호판 1 → 검증 partial→40% 키움→full(verified) · 폴백 whole 상자는 none → 버림(얼굴은 애초 제외) · 호출 5(plates1+verify2+whole1+verify1) · 상자 (0.2792,0.586,0.1456,0.098) src vehicle-crop · diag grown 1·verified 1·fallback 1',
    r45a.boxes.length === 1 && r45a.boxes[0].src === 'vehicle-crop' && r45a.boxes[0].verified === true && Math.abs(r45a.boxes[0].x - 0.2792) < 1e-6 && Math.abs(r45a.boxes[0].y - 0.586) < 1e-6 && Math.abs(r45a.boxes[0].w - 0.1456) < 1e-6 && Math.abs(r45a.boxes[0].h - 0.098) < 1e-6
    && r45a.calls === 5 && r45a.usage.input === 10 + 5 + 5 + 20 + 5 && r45a.diag.grown === 1 && r45a.diag.verified === 1 && r45a.diag.fallback === 1 && r45a.vehicles.length === 1 && vlog.join(',') === 'plates:true,verify:partial,verify:full,whole,verify:none', JSON.stringify(r45a.boxes) + ' ' + vlog.join(','));
  vlog.length = 0;
  const r45b = await PD.detectPlates(buf45, mkVision(['none', 'none'], [{ kind: 'plate', x: 0.5, y: 0.8, w: 0.2, h: 0.1 }], []), { vehiclesOf: vehOf });
  T('detectPlates: 좌표는 나왔는데 검증 none → 차량 하단 띠(fallback true, src vehicle-band, 큰 차(0.16)라 y=0.1+0.4×0.70=0.38) · 폴백 0상자 · 호출 3', r45b.boxes.length === 1 && r45b.boxes[0].src === 'vehicle-band' && r45b.boxes[0].fallback === true && Math.abs(r45b.boxes[0].y - 0.38) < 1e-9 && r45b.diag.band === 1 && r45b.calls === 3, JSON.stringify(r45b.boxes));
  const r45c = await PD.detectPlates(buf45, mkVision(['partial', 'partial'], [{ kind: 'plate', x: 0.5, y: 0.8, w: 0.2, h: 0.1 }], []), { vehiclesOf: vehOf });
  T('detectPlates: 두 번 다 partial → 키운 상자로 가림(verified false) · 호출 4', r45c.boxes.length === 1 && r45c.boxes[0].verified === false && r45c.boxes[0].src === 'vehicle-crop' && r45c.calls === 4 && r45c.diag.grown === 2, JSON.stringify(r45c.boxes));
  const r45d = await PD.detectPlates(buf45, mkVision(['full'], [], [{ kind: 'plate', x: 0.8, y: 0.8, w: 0.1, h: 0.05 }]), { vehiclesOf: async () => ({ boxes: [], w: 600, h: 400, ms: 1, diag: { passes: 15, raw: 0 } }) });
  T('detectPlates: 차량 0 → 조각 없음 · 폴백 whole 상자 full → 채택(src whole) · 호출 2', r45d.boxes.length === 1 && r45d.boxes[0].src === 'whole' && r45d.boxes[0].verified === true && r45d.calls === 2 && r45d.diag.crops === 0, JSON.stringify(r45d.boxes));
  const r45e = await PD.detectPlates(buf45, mkVision(['full'], [{ kind: 'plate', x: 0.5, y: 0.8, w: 0.2, h: 0.1 }], []), { vehiclesOf: async () => ({ boxes: [{ cls: 'car', score: 0.9, x: 0.1, y: 0.1, w: 0.02, h: 0.02, votes: 3 }], w: 600, h: 400, ms: 1, diag: { passes: 15, raw: 1 } }) });
  T('detectPlates: 48px 미만 작은 차량은 건너뜀(small 1·호출 0, 폴백만 1)', r45e.diag.small === 1 && r45e.diag.crops === 0 && r45e.calls === 1 && r45e.boxes.length === 0, JSON.stringify(r45e.diag));
  // 워커 통합 — plateMock 켬
  const wk = require(join(FN, 'gw-promo-mask-background.js'));
  const cron45 = require(join(FN, 'gw-promo-ai-cron.js'));
  const A12 = 'att_' + '3'.repeat(16);
  mem.gw_files[A12] = { name: 'p12.jpg', type: 'image/jpeg', kind: 'promo', data: buf45.toString('base64'), by: 'x', ts: 1 };
  mem.gw_data['col:promo'] = { schema: 1, items: [{ id: 'prv371', title: 't', body: 'b', status: 'review', photos: [{ id: A12, name: 'p12.jpg' }], ai: { ts: 1 }, tags: ['x'] }] };
  mem.gw_data['promomask:usage'] = { schema: 1, months: {} };
  const savedKey = process.env.GW_ANTHROPIC_KEY, savedUrl = process.env.URL; process.env.GW_ANTHROPIC_KEY = 'test-anthropic-key-0000'; process.env.URL = 'https://x.test';
  const realFetch = global.fetch; const kicks = []; let fetchCalls = 0;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (/gw-promo-mask-background/.test(u)) { kicks.push(JSON.parse(opt.body)); return { ok: true, status: 202 }; }
    if (/api\.anthropic\.com/.test(u)) { fetchCalls++; return { status: 200, text: async () => JSON.stringify({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 5 }, content: [{ type: 'text', text: JSON.stringify({ boxes: [{ kind: 'plate', x: 0.7, y: 0.7, w: 0.1, h: 0.05 }] }) }] }) }; }
    return { ok: true, status: 202 };
  };
  try {
    const itok = issueSession({ id: '__promomask__', role: 'system' }).token;
    faceMock.fail = false; faceMock.boxes = [{ kind: 'face', x: 0.2, y: 0.2, w: 0.1, h: 0.1, score: 0.9, src: 'movenet-vote12', votes: 12 }]; faceMock.calls = 0;
    plateMock.fail = false; plateMock.boxes = [{ kind: 'plate', x: 0.6, y: 0.8, w: 0.1, h: 0.04, src: 'vehicle-crop', verified: true }]; plateMock.calls = 3; plateMock.count = 0; fetchCalls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v371a', promo_id: 'prv371', ids: [A12], force: true }) }, {});
    const ja = mem.gw_data['promomask:job:pm_v371a'], ma = mem.gw_files['mask:' + A12], mma = mem.gw_files['maskmeta:' + A12];
    T('워커(얼굴·차량 검출기 켬): 상자 2 = 검출기 얼굴 + platedet 번호판(0.6,0.8) · 전체 사진 Claude 직접 호출 0(fetch 0 — 폴백은 platedet 안에서만) · calls 3(platedet 집계) · model facedet+platedet2+claude-sonnet-5(mask·maskmeta) · det "plates 1 (veh 1, crops 1, verified 1"',
      ja && ja.status === 'done' && ja.calls === 3 && fetchCalls === 0 && plateMock.count === 1 && ma && ma.boxes.length === 2 && ma.boxes.some((b) => b.kind === 'plate' && Math.abs(b.x - 0.6) < 1e-9 && b.by === 'auto') && ma.model === 'facedet+platedet2+claude-sonnet-5' && mma.model === 'facedet+platedet2+claude-sonnet-5' && /plates 1 \(veh 1, crops 1, verified 1/.test(ja.photos[0].det || ''), JSON.stringify(ja) + ' ' + JSON.stringify(ma && ma.boxes));
    T('워커: 사용량 집계에 platedet usage 반영(input 300)', mem.gw_data['promomask:usage'].months[Object.keys(mem.gw_data['promomask:usage'].months)[0]].input === 300, JSON.stringify(mem.gw_data['promomask:usage']));
    // 차량 검출기 못 실림(MODELS_MISSING) → 종전 번호판 경로(전체 사진 1회) · model에 platedet 없음
    plateMock.fail = true; plateMock.count = 0; fetchCalls = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v371b', promo_id: 'prv371', ids: [A12], force: true }) }, {});
    const jb = mem.gw_data['promomask:job:pm_v371b'], mb = mem.gw_files['mask:' + A12];
    T('워커(차량 검출기 못 실림): 종전 번호판 경로 1회(fetch 1·calls 1) · 상자 2(얼굴 + Claude 번호판 0.7) · model facedet+claude-sonnet-5(platedet 없음 → 크론 재감지 대상) · det "platedet fail: MODELS_MISSING"',
      jb.status === 'done' && jb.calls === 1 && fetchCalls === 1 && mb.boxes.length === 2 && mb.boxes.some((b) => b.kind === 'plate' && Math.abs(b.x - 0.7) < 1e-9) && mb.model === 'facedet+claude-sonnet-5' && /platedet fail: MODELS_MISSING/.test(jb.photos[0].det || ''), JSON.stringify(jb.photos[0]));
    // 비전 오류는 platedet 안에서 나도 fail: — mask 저장 안 함(판 그대로)
    plateMock.fail = new Error('TRUNCATED'); const tsBefore = mem.gw_files['mask:' + A12].ts;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v371c', promo_id: 'prv371', ids: [A12], force: true }) }, {});
    T('워커(platedet 안 비전 잘림): fail:TRUNCATED · 판 그대로(ts 불변)', mem.gw_data['promomask:job:pm_v371c'].photos[0].st === 'fail:TRUNCATED' && mem.gw_files['mask:' + A12].ts === tsBefore, JSON.stringify(mem.gw_data['promomask:job:pm_v371c'].photos[0]));
    // 재감지(only_old): 옛 판(facedet+claude) → platedet로 새로 감지(호출 3) → 새 판 → 다시 돌리면 kept:auto
    plateMock.fail = false; plateMock.count = 0;
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v371d', promo_id: 'prv371', ids: [A12], force: true, only_old: true }) }, {});
    const jd = mem.gw_data['promomask:job:pm_v371d'];
    await wk.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + itok }, body: JSON.stringify({ job: 'pm_v371e', promo_id: 'prv371', ids: [A12], force: true, only_old: true }) }, {});
    T('워커 재감지(only_old): v364 판(facedet+claude)은 옛 판 → platedet로 새로 감지(masked·calls 3·model …platedet…) → 다음 재감지는 kept:auto(호출 0)',
      jd.photos[0].st === 'masked' && jd.calls === 3 && /platedet/.test(mem.gw_files['maskmeta:' + A12].model) && mem.gw_data['promomask:job:pm_v371e'].photos[0].st === 'kept:auto' && mem.gw_data['promomask:job:pm_v371e'].calls === 0, JSON.stringify(jd.photos[0]) + ' ' + JSON.stringify(mem.gw_data['promomask:job:pm_v371e'].photos[0]));
    // 크론 옛 판 판정: platedet 없는 자동 판만 대상
    mem.gw_files['maskmeta:' + A12].model = 'facedet+claude-sonnet-5'; mem.gw_data['col:promo'].items[0].updated_ts = Date.now() + 3; mem.gw_data['promomask:lock:prv371'] = { ts: 0, job: '' }; kicks.length = 0; delete mem.gw_data['promomask:remask:prv371']; delete mem.gw_data['promomask:remask'];
    let rc = await cron45.handler({}); let oc = JSON.parse(rc.body);
    T('크론 ③(v371): v364 판(facedet+claude)은 옛 판 → 재감지 기동 1(ids [A12])', oc.remask && oc.remask.promo === 'prv371' && kicks.length === 1 && kicks[0].ids.length === 1 && kicks[0].ids[0] === A12 && kicks[0].only_old === true, JSON.stringify(oc.remask));
    mem.gw_files['maskmeta:' + A12].model = 'facedet+platedet2+claude-sonnet-5'; mem.gw_data['col:promo'].items[0].updated_ts = Date.now() + 6; mem.gw_data['promomask:lock:prv371'] = { ts: 0, job: '' }; kicks.length = 0; delete mem.gw_data['promomask:remask:prv371'];
    rc = await cron45.handler({}); oc = JSON.parse(rc.body);
    T('크론 ③(v371): platedet 판은 새 판 → 대상 0·기동 없음', oc.remask && oc.remask.old === 0 && !oc.remask.promo && kicks.length === 0, JSON.stringify(oc.remask));
  } finally {
    global.fetch = realFetch; process.env.GW_ANTHROPIC_KEY = savedKey || ''; process.env.URL = savedUrl || '';
    faceMock.fail = true; faceMock.boxes = []; plateMock.fail = true; plateMock.boxes = [];
  }
}

// 46 v378 큰 본문 양방향 gzip(10/8 실사고: col:bids 6.69MB > 동기 함수 응답 한도 6MB → get 실패 → 입찰 탭 "수집된 공고가 없습니다")
{
  console.log('\n[46] v378 큰 본문 gzip');
  const zlib46 = require('zlib');
  const big = { schema: 1, items: [], updated_at: 1000 };
  for (let i = 0; i < 9000; i++) big.items.push({ id: 'b' + i, title: '포항시 남구 우수받이 준설 ' + i, org: '포항시청', due: '2026-10-20', status: 'new', ext: { dctx: '낙찰자 결정방법 적격심사 '.repeat(4) + i }, docs: [{ n: '공고문' + i + '.pdf', u: 'https://www.g2b.go.kr/doc/' + i }] });
  mem.gw_data['col:bids'] = big;
  const rawLen = Buffer.byteLength(JSON.stringify({ status: 'OK', collection: 'bids', doc: big, can_write: true, request_id: '0123456789abcdef' }), 'utf8');
  T('준비: 큰 문서 응답 본문 > 1MB', rawLen > 1024 * 1024, String(rawLen));
  let r46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA, 'accept-encoding': 'gzip, deflate, br' }, body: JSON.stringify({ action: 'get', collection: 'bids' }) });
  T('응답 gzip: 200 · Content-Encoding gzip · isBase64Encoded · 본문(base64)이 원문 1/4 이하', r46.statusCode === 200 && r46.headers['Content-Encoding'] === 'gzip' && r46.isBase64Encoded === true && r46.body.length < rawLen / 4, r46.statusCode + ' ' + String(r46.headers['Content-Encoding']) + ' ' + r46.body.length + '/' + rawLen);
  const dec46 = JSON.parse(zlib46.gunzipSync(Buffer.from(r46.body, 'base64')).toString('utf8'));
  T('응답 gzip: 풀면 원문 그대로(9000건) · X-GW-Raw-Bytes = 원문 바이트', dec46.status === 'OK' && dec46.doc.items.length === 9000 && Math.abs(Number(r46.headers['X-GW-Raw-Bytes']) - Buffer.byteLength(JSON.stringify(dec46), 'utf8')) <= 0, String(r46.headers['X-GW-Raw-Bytes']));
  r46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA }, body: JSON.stringify({ action: 'get', collection: 'bids' }) });
  T('응답: accept-encoding 없어도 1MB 초과면 gzip(v379 — 브라우저 요청에서 헤더가 안 보여 평문 6.78MB → 413 실사고)', r46.statusCode === 200 && r46.isBase64Encoded === true && r46.headers['Content-Encoding'] === 'gzip' && JSON.parse(zlib46.gunzipSync(Buffer.from(r46.body, 'base64')).toString('utf8')).doc.items.length === 9000, r46.statusCode + ' ' + String(r46.headers['Content-Encoding']));
  const small46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA, 'accept-encoding': 'gzip' }, body: JSON.stringify({ action: 'get', collection: 'tasks' }) });
  T('응답: 1MB 미만은 gzip 안 함', small46.statusCode === 200 && !small46.isBase64Encoded && !small46.headers['Content-Encoding'], '');
  // 요청 gzip — 앱 gwCall이 보내는 꼴(octet-stream + X-GW-Enc: gzip). Netlify는 이진 본문을 base64(isBase64Encoded)로 넘기지만 평문 binary도 받는다
  const gzGet = zlib46.gzipSync(Buffer.from(JSON.stringify({ action: 'get', collection: 'tasks' }), 'utf8'));
  r46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA, 'content-type': 'application/octet-stream', 'x-gw-enc': 'gzip' }, body: gzGet.toString('base64'), isBase64Encoded: true });
  T('요청 gzip(base64 본문): 풀어서 읽음 → get tasks 200', r46.statusCode === 200 && JSON.parse(r46.body).status === 'OK', r46.statusCode + ' ' + (r46.body || '').slice(0, 80));
  r46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA, 'content-type': 'application/octet-stream', 'x-gw-enc': 'gzip' }, body: gzGet.toString('binary'), isBase64Encoded: false });
  T('요청 gzip(binary 문자열 본문): 풀어서 읽음 → 200', r46.statusCode === 200 && JSON.parse(r46.body).status === 'OK', r46.statusCode + ' ' + (r46.body || '').slice(0, 80));
  const saveDoc46 = { schema: 1, items: big.items.map((it) => (it.id === 'b7' ? Object.assign({}, it, { status: '검토', updated: '2026-10-08' }) : it)) };
  const gzSave = zlib46.gzipSync(Buffer.from(JSON.stringify({ action: 'save', collection: 'bids', doc: saveDoc46, base: 1000 }), 'utf8'));
  T('준비: 저장 본문(평문) > 1MB · gzip은 1/4 이하', Buffer.byteLength(JSON.stringify(saveDoc46), 'utf8') > 1024 * 1024 && gzSave.length < Buffer.byteLength(JSON.stringify(saveDoc46), 'utf8') / 4, String(gzSave.length));
  r46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA, 'content-type': 'application/octet-stream', 'x-gw-enc': 'gzip' }, body: gzSave.toString('base64'), isBase64Encoded: true });
  T('요청 gzip: 일감 save 200 · 상태 변경(b7 검토) 저장됨', r46.statusCode === 200 && (mem.gw_data['col:bids'].items.find((x) => x.id === 'b7') || {}).status === '검토', r46.statusCode + ' ' + (r46.body || '').slice(0, 120));
  r46 = await gwd.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA, 'content-type': 'application/octet-stream', 'x-gw-enc': 'gzip' }, body: Buffer.from('not-gzip-at-all').toString('base64'), isBase64Encoded: true });
  T('요청: 깨진 gzip → 400 INVALID_JSON(500 아님)', r46.statusCode === 400 && JSON.parse(r46.body).error_code === 'INVALID_JSON', String(r46.statusCode));
  delete mem.gw_data['col:bids'];
}

// 47 v380 홈페이지 문의 알림(inquiry_notify) — 공유 키 검증 · PM 등급(없으면 관리자) 수신 · 본문 정제 · 키 미설정이면 닫힘
{
  process.env.INQUIRY_PUSH_KEY = 'test-inquiry-key';
  const n0 = pushMock.calls.length;
  let r47 = await call({ action: 'inquiry_notify', key: 'wrong', name: 'x' });
  T('inquiry_notify 잘못된 키 → 403 BAD_INQUIRY_KEY', r47.code === 403 && r47.body.error_code === 'BAD_INQUIRY_KEY', r47.code + '/' + r47.body.error_code);
  r47 = await call({ action: 'inquiry_notify', key: 'test-inquiry-key', id: 'inq_1', name: '홍길동', contact: '010-1234-5678', service: '석면 해체', region: '포항 남구', message: '견적\u0007 문의\n드립니다' });
  const p47 = pushMock.calls[pushMock.calls.length - 1] || {};
  T('inquiry_notify → 200 · 발송 1(PM 없으면 관리자 폴백)', r47.code === 200 && r47.body.sent === 1 && pushMock.calls.length === n0 + 1, JSON.stringify(r47.body));
  T('제목에 서비스, 본문에 이름(연락처)·지역·내용(제어문자 제거) · 태그 inquiry:id · 관리자 페이지 url', p47.title === '홈페이지 문의 접수 · 석면 해체' && p47.body.indexOf('홍길동 (010-1234-5678)') === 0 && p47.body.indexOf('\u0007') < 0 && p47.body.indexOf('견적 문의 드립니다') > 0 && p47.tag === 'inquiry:inq_1' && /member-admin/.test(p47.url), JSON.stringify(p47));
  // 속도 제한: 10분 6건 — 위 1건 포함 6건째까지 발송, 7건째는 note=rate-limited·발송 없음
  const n1 = pushMock.calls.length;
  for (let k = 0; k < 5; k++) r47 = await call({ action: 'inquiry_notify', key: 'test-inquiry-key', id: 'inq_rl' + k, name: '반복' });
  T('6건째까지 발송(창 안 상한)', r47.body.sent === 1 && pushMock.calls.length === n1 + 5, JSON.stringify(r47.body));
  r47 = await call({ action: 'inquiry_notify', key: 'test-inquiry-key', id: 'inq_rl9', name: '반복' });
  T('7건째 → 200 note=rate-limited · 발송 없음', r47.code === 200 && r47.body.note === 'rate-limited' && r47.body.sent === 0 && pushMock.calls.length === n1 + 5, JSON.stringify(r47.body));
  delete mem.gw_data['inquiry:rl'];
  delete process.env.INQUIRY_PUSH_KEY;
  r47 = await call({ action: 'inquiry_notify', key: 'test-inquiry-key', name: 'x' });
  T('INQUIRY_PUSH_KEY 미설정 → 403(열린 문 없음)', r47.code === 403);
}

// 48 v380 공고 보관 기간(PM 10/11 "마감 14일 보관") — ingest가 마감 14일 경과 new·패스를 정리하고 되살리지 않는다 · 사람이 정한 상태는 보존 · bids_purge mode:expired(dry)
{
  const day = (n) => new Date(Date.now() + 9 * 3600000 - n * 86400000).toISOString().slice(0, 10);
  mem.gw_data['col:bids'] = { schema: 1, items: [
    { id: 'e1', title: '만료 신규', due: day(20), status: 'new' },
    { id: 'e2', title: '만료 패스', due: day(15), status: '패스' },
    { id: 'e3', title: '만료 응찰', due: day(40), status: '응찰' },
    { id: 'e4', title: '만료 검토', due: day(30), status: '검토' },
    { id: 'k1', title: '유효 신규', due: day(13), status: 'new' },
    { id: 'k2', title: '마감 없음', due: '', status: 'new' },
    { id: 'k3', title: '경계(14일째)', due: day(14), status: 'new' },
  ] };
  Object.keys(mem.gw_data).forEach((k) => { if (k === 'veridx:bids' || k.indexOf('ver:bids:') === 0) delete mem.gw_data[k]; });
  let r48 = await call({ action: 'bids_purge', key: 'test-ingest-key', mode: 'expired', dry: true });
  T('bids_purge expired dry → 세기만(2건)·저장 안 함', r48.code === 200 && r48.body.dry === true && r48.body.would_remove === 2 && mem.gw_data['col:bids'].items.length === 7, JSON.stringify(r48.body));
  r48 = await call({ action: 'bids_purge', key: 'test-ingest-key', mode: 'expired', dry: 'true' });
  T("dry:'true'(문자열)도 세기만 — 실제 정리 안 돎", r48.body.dry === true && mem.gw_data['col:bids'].items.length === 7 && !mem.gw_data['veridx:bids'], JSON.stringify(r48.body));
  r48 = await call({ action: 'bids_ingest', key: 'test-ingest-key', items: [
    { id: 'e1', title: '만료 신규', due: day(20) },
    { id: 'n1', title: '새 만료', due: day(16) },
    { id: 'n2', title: '새 유효', due: day(2) },
    { id: 'e3', title: '만료 응찰', due: day(40) },
  ] });
  const ids48 = mem.gw_data['col:bids'].items.map((x) => x.id).sort().join(',');
  T('ingest: 만료 new·패스 정리 2 · 새로 들어온 만료 1 건너뜀 · 유효 추가 1', r48.code === 200 && r48.body.purged === 2 && r48.body.skipped === 1 && r48.body.added === 1, JSON.stringify(r48.body));
  T('남은 것 = 응찰·검토·유효·마감없음·경계·새 유효(상태 보존)', ids48 === 'e3,e4,k1,k2,k3,n2' && mem.gw_data['col:bids'].items.find((x) => x.id === 'e3').status === '응찰', ids48);
  const vi48 = mem.gw_data['veridx:bids'];
  T('정리가 있던 ingest는 VER_SKIP을 넘어 스냅샷 1벌(정리 전 7건)을 남긴다', vi48 && vi48.items.length === 1 && vi48.items[0].tot === 7 && vi48.items[0].by === '수집봇', JSON.stringify(vi48));
  r48 = await call({ action: 'save', collection: 'bids', doc: { schema: 1, items: [{ id: 'z1', title: '되살림 시도(만료 new)', due: day(30), status: 'new' }, { id: 'z2', title: '유효', due: day(1), status: 'new' }, { id: 'z3', title: '만료 응찰', due: day(30), status: '응찰' }] } }, tokA);
  const ids48b = (mem.gw_data['col:bids'].items || []).map((x) => x.id).sort().join(',');
  T('관리자 save(bids): 만료 new 되살림을 서버가 거른다 · 응찰은 통과', r48.code === 200 && ids48b === 'z2,z3', r48.code + ' ' + ids48b);
  r48 = await call({ action: 'bids_purge', key: 'test-ingest-key', mode: 'expired' });
  T('bids_purge expired(실행) → 더 지울 것 없음 0(앞선 save 뒤 2건 그대로)', r48.code === 200 && r48.body.removed === 0 && mem.gw_data['col:bids'].items.length === 2, JSON.stringify(r48.body));
  delete mem.gw_data['col:bids'];
}

// ===== 46. 운반일지 엑셀 놓친 변경 v385(10/14 권민지 12·13일 "엑셀 수량이 화면과 다름" — 예약 08:25가 매일 2.5~4시간 늦음) — 수집·직접 추가·노선 판정 · 재요청 · 직접 추가 저장 요청 · 워커 배선
{
  const gwab = require(join(FN, 'gw-allbaro.js'));
  const lib = require(join(FN, '_lib', 'xlsx_regen.js'));
  const ab = async (body, tok, dev) => { const rr = await gwab.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: rr.statusCode, body: JSON.parse(rr.body) }; };
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] }; mem.gw_data['allbaro:routes_hidden'] = { schema: 1, items: [] };
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (url, opt) => { if (/api\.github\.com/.test(String(url))) { calls.push({ url: String(url), body: JSON.parse(opt.body) }); return { status: 204 }; } return realFetch(url, opt); };
  const savedTok = process.env.GW_APPDATA_GITHUB_TOKEN; process.env.GW_APPDATA_GITHUB_TOKEN = 'test-appdata-token';
  const kd = (o) => new Date(Date.now() + 9 * 3600000 + (o || 0) * 86400000).toISOString().slice(0, 10);
  const d1 = kd(-1), d30 = kd(-30);
  T('lib daysAgoKst: 오늘 0 · 어제 1 · 30일 전 30 · 형식 오류 0', lib.daysAgoKst(kd(0)) === 0 && lib.daysAgoKst(d1) === 1 && lib.daysAgoKst(d30) === 30 && lib.daysAgoKst('x') === 0, '');
  T('lib routeAtOf: route_at 우선 · 없으면 노선류/이유 없음의 requested_at · collect·manual·retry는 0', lib.routeAtOf({ route_at: 7, requested_at: 9, reason: 'collect' }) === 7 && lib.routeAtOf({ requested_at: 9, reason: 'hide' }) === 9 && lib.routeAtOf({ requested_at: 9 }) === 9 && lib.routeAtOf({ requested_at: 9, reason: 'collect' }) === 0 && lib.routeAtOf({ requested_at: 9, reason: 'manual' }) === 0 && lib.routeAtOf(null) === 0, '');
  // ① 12일 재현: 파일은 전날 아침(1000), 수집본은 다음 날 아침(5000) — 노선 변경 없음
  delete mem.gw_data['allbaro:xlsx_regen'];
  mem.gw_data['allbaro:xlsx:' + d1] = { name: 'x.xlsx', b64: 'UEs=', ts: 1000, total: 5 };
  mem.gw_data['allbaro:day:' + d1] = { schema: 2, day: d1, total: 33, counts: [], ts: 5000 };
  mem.gw_data['allbaro:manual:' + d1] = { schema: 1, day: d1, items: [], ts: 500 };
  let n0 = calls.length;
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('① 12일 재현: 수집본(5000) > 파일(1000) → stale·why [collect]·changed_at 5000·src_at 1000 · 접수된 실행 없음 → 재요청 1회(days_back 10) · state requested', r.code === 200 && r.body.stale === true && JSON.stringify(r.body.why) === '["collect"]' && r.body.changed_at === 5000 && r.body.src_at === 1000 && calls.length === n0 + 1 && calls[calls.length - 1].body.inputs.days_back === '10' && r.body.regen && r.body.regen.code === 204 && r.body.regen.state === 'requested', JSON.stringify([r.body.why, r.body.changed_at, calls.length - n0]));
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('바로 또 받기 → 변경 뒤 접수된 실행이 이 날짜를 덮음(cover_from) → 재요청 없음 · state in_flight', r.body.stale === true && calls.length === n0 + 1 && r.body.regen.state === 'in_flight', JSON.stringify(r.body.regen));
  // 기한: 접수 20분 지났는데 반영본 없음 → gave_up(재요청 없음) · 70분 지나면 다시 요청
  const rg0 = mem.gw_data['allbaro:xlsx_regen']; const disp0 = rg0.dispatched_at;
  rg0.dispatched_at = Date.now() - 20 * 60000; mem.gw_data['allbaro:day:' + d1].ts = rg0.dispatched_at - 1000;
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('접수 20분 뒤에도 반영본 없음 → state gave_up · 재요청 없음(내려받기마다 dispatch 반복 방지)', r.body.stale === true && r.body.regen.state === 'gave_up' && calls.length === n0 + 1, JSON.stringify(r.body.regen));
  rg0.dispatched_at = Date.now() - 70 * 60000; mem.gw_data['allbaro:day:' + d1].ts = rg0.dispatched_at - 1000;
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('접수 70분 뒤에도 반영본 없음 → 다시 요청(1시간에 한 번) · state requested', r.body.regen.state === 'requested' && calls.length === n0 + 2, JSON.stringify(r.body.regen));
  mem.gw_data['allbaro:day:' + d1].ts = 5000; void disp0;
  mem.gw_data['allbaro:xlsx:' + d1] = { name: 'x.xlsx', b64: 'UEs=', ts: 9000, src_at: 6000, total: 33 };
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('재생성본(src_at 6000 > 5000) → stale:false · why [] · regen null', r.body.stale === false && r.body.why.length === 0 && r.body.regen === null, JSON.stringify(r.body.why));
  // ② src_at이 기준: 생성기가 읽기 시작한 뒤(6000) 저장된 직접 추가(7000)는 파일 ts(9000)보다 앞이어도 놓친 변경
  mem.gw_data['allbaro:manual:' + d1].ts = Date.now() + 5000;   // 방금 보낸 실행(①)보다 뒤의 직접 추가
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('② 직접 추가(①의 실행보다 뒤) > src_at(6000) → stale·why [manual] (파일 ts 9000과 무관하게 src_at 기준) · 놓친 변경 뒤 접수 없음 → 재요청하나 디바운스 안이라 state skipped(직전 204를 물려받아도 접수로 읽지 않음)', r.body.stale === true && JSON.stringify(r.body.why) === '["manual"]' && r.body.regen && r.body.regen.skipped === true && r.body.regen.state === 'skipped' && r.body.regen.code === 204, JSON.stringify([r.body.why, r.body.regen]));
  // ③ 노선 변경 route_at은 다른 요청(collect)이 덮어도 유지
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 8, hide: true }, tokA);
  const ra = (mem.gw_data['allbaro:xlsx_regen'] || {}).route_at;
  await lib.requestXlsxRegen({ name: 'gw_data', toString() { return 'gw_data'; } }, 'collect', '', 9);
  T('③ 숨김 → route_at 기록 · 이어서 collect 요청이 와도 route_at 그대로 · reason collect', r.code === 200 && ra > 0 && mem.gw_data['allbaro:xlsx_regen'].route_at === ra && mem.gw_data['allbaro:xlsx_regen'].reason === 'collect', JSON.stringify(mem.gw_data['allbaro:xlsx_regen']));
  mem.gw_data['allbaro:xlsx:' + d1] = { name: 'x.xlsx', b64: 'UEs=', ts: ra - 10, src_at: ra - 20, total: 33 };
  mem.gw_data['allbaro:manual:' + d1].ts = 1; mem.gw_data['allbaro:day:' + d1].ts = 1; mem.gw_data['allbaro:manual:' + d30] = { schema: 1, day: d30, items: [], ts: 0 };
  r = await ab({ action: 'ab_xlsx', day: d1 }, tokW, 'dev1');
  T('숨김 뒤 파일 → why [route]', r.body.stale === true && JSON.stringify(r.body.why) === '["route"]', JSON.stringify(r.body.why));
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 8, hide: false }, tokA);
  // ④ 직접 추가 저장 → 재생성 요청(그날까지 소급 — 30일 전이면 31)
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  n0 = calls.length;
  r = await ab({ action: 'ab_manual_put', day: d30, items: [{ from: '주식회사포스코', to: 'CIP', item: 'CIP', n: 3, qty_ton: 0 }] }, tokW, 'dev1');
  T('④ 직접 추가 저장(30일 전) → 200 · dispatch 1회 days_back 32(31+여유) · reason manual · 응답 regen state requested · cover_from = 30일 전', r.code === 200 && calls.length === n0 + 1 && calls[calls.length - 1].body.inputs.days_back === '32' && mem.gw_data['allbaro:xlsx_regen'].reason === 'manual' && mem.gw_data['allbaro:xlsx_regen'].cover_from === d30 && r.body.regen && r.body.regen.state === 'requested', JSON.stringify([r.code, r.body.code, calls.length - n0]));
  // ⑤ 30일 전 파일이 놓친 직접 추가 → 재요청도 그날까지 소급, covered true · 61일 전은 covered false
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  mem.gw_data['allbaro:xlsx:' + d30] = { name: 'z.xlsx', b64: 'UEs=', ts: 1000, total: 3 };
  n0 = calls.length;
  r = await ab({ action: 'ab_xlsx', day: d30 }, tokW, 'dev1');
  T('⑤ 30일 전 파일 + 그 뒤 직접 추가 → stale·why [manual]·covered · 재요청 days_back 32', r.body.stale === true && r.body.covered === true && calls.length === n0 + 1 && calls[calls.length - 1].body.inputs.days_back === '32', JSON.stringify([r.body.why, calls.length - n0]));
  const g99 = await lib.requestXlsxRegen({ name: 'gw_data', toString() { return 'gw_data'; } }, 'manual', '', 99); const g3 = await lib.requestXlsxRegen({ name: 'gw_data', toString() { return 'gw_data'; } }, 'manual', '', 3);
  T('lib 소급: 99 → 상한 59(+여유 1 = 생성기 상한 60) · 3 → 하한 9(수집 창) · backFor([30일 전, 어제]) 31', g99.days_back === 59 && g3.days_back === 9 && lib.backFor([d30, d1]) === 31 && lib.backFor([]) === 9, JSON.stringify([g99.days_back, g3.days_back]));
  // ⑦ 노선 변경(9일 범위) 뒤 20일 전 파일 → 그 실행은 이 날짜를 안 덮으므로 그날까지 소급해 재요청(F1·F7 — '만들고 있습니다'로 굳지 않음)
  const d20 = kd(-20);
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  mem.gw_data['allbaro:xlsx:' + d20] = { name: 'w.xlsx', b64: 'UEs=', ts: 1000, src_at: 900, total: 2 };
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 9, hide: true }, tokA);
  n0 = calls.length;
  mem.gw_data['allbaro:xlsx_regen'].dispatched_at = Date.now() - 3 * 60000;   // 디바운스 밖으로(숨김 접수는 3분 전, 9일 범위)
  mem.gw_data['allbaro:xlsx_regen'].route_at = Date.now() - 3 * 60000;
  r = await ab({ action: 'ab_xlsx', day: d20 }, tokW, 'dev1');
  T('⑦ 숨김(9일 범위 접수) 뒤 20일 전 파일 → why [route] · cover_from이 그 날짜보다 뒤 → 재요청 days_back 22 · state requested', r.body.stale === true && JSON.stringify(r.body.why) === '["route"]' && calls.length === n0 + 1 && calls[calls.length - 1].body.inputs.days_back === '22' && r.body.regen.state === 'requested', JSON.stringify([r.body.why, r.body.regen, calls.length - n0]));
  r = await ab({ action: 'ab_route_hide', side: 'L', row: 9, hide: false }, tokA);
  // ⑧ 노선 지정(15일 전 날짜를 보며) → 재정렬한 가장 오래된 날까지 소급(F2)
  const d15 = kd(-15);
  mem.gw_data['allbaro:day:' + d15] = { schema: 2, day: d15, total: 1, counts: [{ from: '소급테스트상차', to: '네이처', item: '', n: 1, route: null }], unmatched: [], ts: 1 };
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  n0 = calls.length;
  r = await ab({ action: 'ab_learn', from: '소급테스트상차', to: '네이처', item: '', side: 'L', row: 5, day: d15 }, tokA);
  T('⑧ 노선 지정(15일 전부터 재정렬) → dispatch days_back 17(15+1+여유) · 응답 regen.state requested', r.code === 200 && calls.length === n0 + 1 && calls[calls.length - 1].body.inputs.days_back === '17' && r.body.regen && r.body.regen.state === 'requested', JSON.stringify([r.code, r.body.code, r.body.rematched, calls.length - n0, calls.length > n0 ? calls[calls.length - 1].body.inputs : null]));
  delete mem.gw_data['allbaro:day:' + d15]; delete mem.gw_data['allbaro:xlsx:' + d20];
  mem.gw_data['allbaro:learned'] = { schema: 1, items: [] };
  // ⑥ 워커: regenAfterCollect를 실제로 실행(수집기 전체는 돌리지 않는다) + 호출 위치 소스 대조
  const wk = require(join(FN, 'gw-allbaro-run-background.js'));
  const stW = { name: 'gw_data', toString() { return 'gw_data'; } };
  mem.gw_data['allbaro:xlsx_regen'] = { schema: 1, requested_at: 1, dispatched_at: 1, dispatch_code: 204 };
  n0 = calls.length;
  const recA = { status: 'done' }, logA = [];
  await wk.regenAfterCollect(stW, recA, 'collect', [{ day: kd(0) }, { day: kd(-8) }], logA);
  const recB = { status: 'done' }, logB = [];
  await wk.regenAfterCollect(stW, recB, 'collect', [{ day: kd(0) }], logB);
  const recC = { status: 'fail' }, recD = { status: 'done' };
  await wk.regenAfterCollect(stW, recC, 'collect', [{ day: kd(0) }], []); await wk.regenAfterCollect(stW, recD, 'inspect', [{ day: kd(0) }], []); await wk.regenAfterCollect(stW, { status: 'done' }, 'collect', [], []);
  T('⑥ 워커 regenAfterCollect: 성공·저장 9일 → dispatch 1회 days_back 10 · rec.regen.state requested · 로그 "[엑셀] 재생성 요청 접수" / 2분 안 두 번째 → 보류(state skipped, 로그 "보류") / 실패·inspect·저장 0건 → 요청 없음',
    calls.length === n0 + 1 && calls[calls.length - 1].body.inputs.days_back === '10' && recA.regen.state === 'requested' && /\[엑셀\] 재생성 요청 접수 · 소급 9일/.test(logA.join()) && recB.regen.state === 'skipped' && /보류/.test(logB.join()) && !recC.regen && !recD.regen, JSON.stringify([calls.length - n0, recA.regen, recB.regen, logA, logB]));
  const wsrc = require('fs').readFileSync(join(FN, 'gw-allbaro-run-background.js'), 'utf8');
  T('⑥ 워커 호출 위치: rec.status 판정 직후 · 잡 블롭 저장 전 await regenAfterCollect(st, rec, mode, saved, log)', /rec\.status = \(r && r\.ok && !writeFail\) \? 'done' : 'fail';[\s\S]{0,300}await regenAfterCollect\(st, rec, mode, saved, log\);[\s\S]{0,800}await blobSet\(st, jobKey\(job\), rec\);/.test(wsrc), '');
  const asrc = require('fs').readFileSync(join(FN, 'gw-allbaro.js'), 'utf8');
  T('⑥ gw-allbaro: 재생성 함수는 lib 하나(로컬 정의 없음) · 기본 소급 9 = 수집 창 WINDOW_DAYS', !/async function requestXlsxRegen/.test(asrc) && lib.REGEN_DAYS_BACK === Number((require('fs').readFileSync(join(FN, 'gw-allbaro-cron.js'), 'utf8').match(/const WINDOW_DAYS = (\d+);/) || [])[1]), '');
  global.fetch = realFetch; process.env.GW_APPDATA_GITHUB_TOKEN = savedTok || '';
  ['allbaro:xlsx:' + d1, 'allbaro:day:' + d1, 'allbaro:manual:' + d1, 'allbaro:xlsx:' + d30, 'allbaro:manual:' + d30, 'allbaro:xlsx_regen'].forEach((k) => { delete mem.gw_data[k]; });
}

// 47 v388 문서함 직원 출력·권한(PM 10/19 "33. ㄱ지금"): 편집 원본 403 ORIG_FORBIDDEN(직원) / 열람용 PDF·이미지 200 / 관리부·양식 03·orig_dl all·관리자 허용
//    / 열람 기록 doclog(월 KST·kind view/orig/file·403은 미기록) / doc_log_get 관리자만·최신순·limit·월 / save 정규화(관리자 all만·비관리자 원본 고정·신규 제거) / doc_att_put view:1(관리자·pdf만)
{
  mem.gw_data['col:documents'] = { schema: 1, items: [
    { id: 'v1', title: '안전 매뉴얼', cat: '06-02', scope: 'all', status: '등재', files: [{ n: 1, name: '매뉴얼.docx', size: 10, mime: 'x', ts: 1, by: { id: 'uadmin' } }, { n: 2, name: '열람용_매뉴얼.pdf', size: 10, mime: 'application/pdf', ts: 2, by: { id: 'uadmin' }, view: 1 }], att_seq: 2 },
    { id: 'v2', title: '휴가 신청서', cat: '07-03', scope: 'all', status: '등재', files: [{ n: 1, name: '양식.hwp', size: 10, mime: 'x', ts: 1, by: { id: 'uadmin' } }], att_seq: 1 },
    { id: 'v3', title: '단가표', cat: '05-04', scope: 'all', status: '등재', orig_dl: 'all', files: [{ n: 1, name: '표.xlsx', size: 10, mime: 'x', ts: 1, by: { id: 'uadmin' } }], att_seq: 1 },
    { id: 'v4', title: '사진 자료', cat: '06-06', scope: 'all', status: '등재', files: [{ n: 1, name: '현장.png', size: 10, mime: 'image/png', ts: 1, by: { id: 'uadmin' } }], att_seq: 1 },
  ], updated_at: 200 };
  mem.gw_files['docatt:v1:1'] = { name: '매뉴얼.docx', type: 'x', data: ZIP }; mem.gw_files['docatt:v1:2'] = { name: '열람용_매뉴얼.pdf', type: 'application/pdf', data: PDF };
  mem.gw_files['docatt:v2:1'] = { name: '양식.hwp', type: 'x', data: HWP }; mem.gw_files['docatt:v3:1'] = { name: '표.xlsx', type: 'x', data: ZIP }; mem.gw_files['docatt:v4:1'] = { name: '현장.png', type: 'image/png', data: PNG };
  Object.keys(mem.gw_data).filter((k) => k.indexOf('doclog:') === 0).forEach((k) => { delete mem.gw_data[k]; });
  r = await call({ action: 'doc_att_get', id: 'v1', n: 1 }, tokD, 'dev1');
  T('47 직원 원본(docx) → 403 ORIG_FORBIDDEN', r.code === 403 && r.body.error_code === 'ORIG_FORBIDDEN', JSON.stringify(r.body).slice(0, 100));
  r = await call({ action: 'doc_att_get', id: 'v1', n: 2 }, tokD, 'dev1');
  T('47 직원 열람용 PDF → 200', r.code === 200 && r.body.data === PDF);
  r = await call({ action: 'doc_att_get', id: 'v4', n: 1 }, tokD, 'dev1');
  T('47 직원 이미지 첨부 → 200(원본 규칙은 편집 형식만)', r.code === 200);
  r = await call({ action: 'doc_att_get', id: 'v2', n: 1 }, tokD, 'dev1');
  T('47 양식·서식(중분류 03) hwp → 직원 200', r.code === 200 && r.body.data === HWP);
  r = await call({ action: 'doc_att_get', id: 'v3', n: 1 }, tokD, 'dev1');
  T('47 orig_dl all 문서 xlsx → 직원 200', r.code === 200);
  r = await call({ action: 'doc_att_get', id: 'v1', n: 1 }, tokM, 'dev1');
  T('47 관리부 원본 docx → 200', r.code === 200 && r.body.data === ZIP);
  r = await call({ action: 'doc_att_get', id: 'v1', n: 1 }, tokA);
  T('47 관리자 원본 → 200', r.code === 200);
  const logKeys = Object.keys(mem.gw_data).filter((k) => k.indexOf('doclog:') === 0);
  const logs = logKeys.length ? mem.gw_data[logKeys[0]].items : [];
  T('47 열람 기록: 성공 6건만 월 블롭 1개(KST YYYY-MM)·kind view/file/orig·부서·403은 미기록', logKeys.length === 1 && /^doclog:\d{4}-\d{2}$/.test(logKeys[0]) && logs.length === 6 && logs[0].kind === 'view' && logs[0].bid === 'udocw' && logs[1].kind === 'file' && logs[2].kind === 'orig' && logs[4].dept === '관리부' && logs[5].bid === 'uadmin', JSON.stringify(logs.map((x) => x.kind)));
  r = await call({ action: 'doc_log_get' }, tokD, 'dev1');
  T('47 doc_log_get 비관리자 → 403', r.code === 403);
  r = await call({ action: 'doc_log_get', limit: 3 }, tokA);
  T('47 doc_log_get 관리자: 최신순·limit·total·month', r.code === 200 && r.body.total === 6 && r.body.items.length === 3 && r.body.items[0].bid === 'uadmin' && r.body.month === logKeys[0].slice(7), JSON.stringify(r.body).slice(0, 120));
  r = await call({ action: 'doc_log_get', month: '2001-01' }, tokA);
  T('47 doc_log_get 빈 달 → 0건', r.code === 200 && r.body.total === 0 && r.body.month === '2001-01');
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: [
    { id: 'v1', title: '안전 매뉴얼', cat: '06-02', scope: 'all', status: '등재', orig_dl: 'all' },
    { id: 'v2', title: '휴가 신청서', cat: '07-03', scope: 'all', status: '등재', orig_dl: 'nope' },
    { id: 'v3', title: '단가표', cat: '05-04', scope: 'all', status: '등재' },
    { id: 'v4', title: '사진 자료', cat: '06-06', scope: 'all', status: '등재' },
  ], updated_at: 200 }, base: 200 }, tokA);
  const vd = (id) => mem.gw_data['col:documents'].items.find((x) => x && x.id === id);
  T('47 관리자 save: orig_dl all 유지·무효값 제거·비움=제거 · files 원본 이월', r.code === 200 && vd('v1').orig_dl === 'all' && vd('v2').orig_dl === undefined && vd('v3').orig_dl === undefined && vd('v1').files.length === 2, JSON.stringify(r.body).slice(0, 120));
  const at2 = mem.gw_data['col:documents'].updated_at;
  r = await call({ action: 'save', collection: 'documents', doc: { schema: 1, items: [
    { id: 'v1', title: '안전 매뉴얼(직원 편집)', cat: '06-02', scope: 'all', status: '등재' },
    { id: 'v2', title: '휴가 신청서', cat: '07-03', scope: 'all', status: '등재', orig_dl: 'all' },
    { id: 'v3', title: '단가표', cat: '05-04', scope: 'all', status: '등재' },
    { id: 'v4', title: '사진 자료', cat: '06-06', scope: 'all', status: '등재' },
    { id: 'vn', title: '직원 신규', cat: '06-06', orig_dl: 'all' },
  ], updated_at: at2 }, base: at2 }, tokD, 'dev1');
  T('47 직원 save: orig_dl은 서버 원본 고정(v1 all 유지·v2 추가 무시)·신규는 제거', r.code === 200 && vd('v1').orig_dl === 'all' && vd('v2').orig_dl === undefined && !!vd('vn') && vd('vn').orig_dl === undefined, JSON.stringify(r.body).slice(0, 120));
  r = await call({ action: 'doc_att_put', id: 'v4', name: '열람용_사진.pdf', data: PDF, view: 1, src_n: 1, src_hash: 'abcdef1234' }, tokA);
  T('47 관리자 pdf view:1 업로드 → 메타 view·src_n·src_hash', r.code === 200 && r.body.files.some((f) => f.view === 1 && f.src_n === 1 && f.src_hash === 'abcdef1234'), JSON.stringify(r.body).slice(0, 160));
  r = await call({ action: 'doc_att_put', id: 'v4', name: '첨부.docx', data: ZIP, view: 1 }, tokA);
  T('47 docx에 view:1 → 무시', r.code === 200 && !r.body.files.some((f) => f.name === '첨부.docx' && f.view === 1));
  r = await call({ action: 'doc_att_put', id: 'vn', name: '열람용.pdf', data: PDF, view: 1 }, tokD, 'dev1');
  T('47 직원(본인 문서) pdf view:1 → 무시(관리자만)', r.code === 200 && !r.body.files.some((f) => f.view === 1), JSON.stringify(r.body).slice(0, 120));
  const gsrc = require('fs').readFileSync(join(FN, 'gw-data.js'), 'utf8');
  T('47 서버 DOC_ORIG_EXT = docx·xlsx·pptx·hwp·hwpx · docOrigAllowed 4축(admin·관리부·03·orig_dl)', /const DOC_ORIG_EXT = \{ docx: 1, xlsx: 1, pptx: 1, hwp: 1, hwpx: 1 \}/.test(gsrc) && /docMinorOf\(it\) === '03'/.test(gsrc) && /it\.orig_dl === 'all'/.test(gsrc));
}
// 48 v389 블로그 자동 학습(PM 10/19 "니가 아니라 모델이 학습"): 순수 함수(간극·병합·주입·짝 선별) / 초안 보존 saveDraft / 학습 워커(가짜 모델 응답 → 규칙 창고·짝 done·rec.learn / 금지 문자열 차단 / 초안 없음)
//    / 크론 ④ 기동(전역 잠금·pending 1건·fetch 호출) / pl_get·pl_set(관리자만·끄기·규칙 삭제·짝 지정·재시도) / 생성 프롬프트 주입(buildPrompt lessons·exemplar, off면 없음)
{
  const PL = require(join(FN, '_lib/promolearn.js'));
  const PJ48 = require(join(FN, '_lib/promoai_job.js'));
  const lib48 = require(join(FN, '_lib/promoai.js'));
  const draft = '포항 장량동 상가 하수구 준설\n\n[사진 1 : 입구]\n왜 막히나요?\n상가 하수구는 기름과 음식물이 굳어 막힙니다. 저희 종운환경이 준설했습니다.\n[사진 2 : 작업]\n고압세척으로 뚫었습니다.';
  const fin = '포항 장량동 상가 하수구 준설\n\n왜 막히나요?\n상가 하수구는 기름과 음식물이 굳어서 막힙니다.\n(주)종운환경이 준설했습니다.\n고압 세척으로 뚫었습니다.\n문의는 전화로 주시면 됩니다.';
  const g = PL.gapScore(draft, fin);
  T('48 gapScore: 정규화 편집거리 0<ratio<1 · 사진 마커 제외(photos_d -2) · 같은 글은 0', g.ratio > 0.05 && g.ratio < 0.5 && g.photos_d === -2 && PL.gapScore(fin, fin).ratio === 0, JSON.stringify(g));
  const out1 = { summary: '저희→회사명', changes: [{ kind: 'style', what: '저희를 회사명으로' }], rules: [{ text: '자기 지칭은 저희가 아니라 회사명으로 쓴다', scope: 'style', n: 1, keep_id: '' }, { text: '글 끝에 문의 연락처 한 줄을 덧붙인다', scope: 'content', n: 1, keep_id: '' }, { text: '', scope: 'style', n: 1, keep_id: '' }] };
  const L1 = PL.mergeLessons(null, out1, { promo_id: 'p1', pair_id: 'pl_0123456789ab', final_title: 't1', final_body: fin, facility: '상가하수구', now: 1000, tokens: 50, gap: g, summary: out1.summary });
  const out2 = { summary: '', changes: [], rules: [{ text: '자기 지칭은 저희가 아니라 회사명으로 쓴다', scope: 'style', n: 2, keep_id: L1.rules[0].id }, { text: '사진 아래 첫 문장은 사진 묘사가 아니다', scope: 'bogus', n: 1, keep_id: 'nope' }] };
  const L2 = PL.mergeLessons(L1, out2, { promo_id: 'p2', pair_id: 'pl_0123456789ac', final_title: 't2', final_body: fin, facility: '우수받이', now: 2000, tokens: 10, gap: g, summary: '' });
  T('48 mergeLessons: 빈 규칙 제외 · keep_id로 id 유지·n 누적·first 보존 · scope 밖은 style · 예시 시설별 · gaps·stats 누적', L1.rules.length === 2 && L2.rules.length === 2 && L2.rules[0].id === L1.rules[0].id && L2.rules[0].n === 2 && L2.rules[0].first === 1000 && L2.rules[1].scope === 'style' && Object.keys(L2.exemplars).length === 2 && L2.gaps.length === 2 && L2.stats.pairs === 2 && L2.stats.tokens === 60, JSON.stringify(L2.rules));
  const ll = PL.lessonLines(L2);
  T('48 lessonLines: 근거 많은 순 · "(근거 n건)" · off면 빈 배열', ll.length === 2 && /회사명으로 쓴다 \(근거 2건\)$/.test(ll[0]) && PL.lessonLines(Object.assign({}, L2, { off: true })).length === 0, JSON.stringify(ll));
  const ex = PL.exemplarFor(L2, '상가 하수구');
  T('48 exemplarFor: 시설 키 정규화(공백 제거) 일치 → 없으면 최신 · off면 null · 마커 제거 발췌', ex && ex.facility_key === '상가하수구' && PL.exemplarFor(L2, '학교').facility_key === '우수받이' && PL.exemplarFor(Object.assign({}, L2, { off: true }), '학교') === null && ex.excerpt.indexOf('[사진') < 0, JSON.stringify(ex).slice(0, 120));
  const NOW48 = 10000000;
  const picked = PL.pickPending([{ id: 'pl_0123456789ab', promo_id: 'p1', status: 'pending', ts: 5 }, { id: 'pl_0123456789ac', promo_id: 'p1', status: 'running', ts: NOW48 - 1000 }, { id: 'pl_0123456789ad', promo_id: '', status: 'unmatched' }, { id: 'pl_0123456789ae', promo_id: 'p1', status: 'fail', tries: 1, ts: NOW48 - 20 * 60000 }, { id: 'pl_0123456789af', promo_id: 'p1', status: 'fail', tries: 3, ts: 1 }, { id: 'bad', promo_id: 'p1' }, { id: 'pl_0123456789a0', promo_id: 'p1', status: 'running', ts: NOW48 - 20 * 60000, tries: 1 }], NOW48).map((p) => p.id);
  T('48 pickPending: pending·죽은 running(15분)·fail 10분 뒤(3회 미만)만 · unmatched·진행 중·상한·id 불량 제외 · ts 오름차순', JSON.stringify(picked) === JSON.stringify(['pl_0123456789ab', 'pl_0123456789ae', 'pl_0123456789a0']), JSON.stringify(picked));
  const picked391 = PL.pickPending([{ id: 'pl_0123456789b1', promo_id: 'p1', status: 'superseded', ts: 1 }, { id: 'pl_0123456789b2', promo_id: 'p1', status: 'done', ts: 2 }, { id: 'pl_0123456789b3', promo_id: 'p1', status: 'hold', ts: 3 }, { id: 'pl_0123456789b4', promo_id: 'p1', status: 'pending', ts: 4 }], NOW48).map((p) => p.id);
  T('48(v391) pickPending 화이트리스트: superseded(게시글로 대체)·done·모르는 상태는 집지 않고 pending만', JSON.stringify(picked391) === JSON.stringify(['pl_0123456789b4']), JSON.stringify(picked391));
  // 생성 프롬프트 주입
  const pr1 = lib48.buildPrompt({ region: '포항', facility: '상가 하수구', problem: '막힘', photoCount: 3, lessons: ll, exemplar: { title: ex.title, excerpt: ex.excerpt } });
  const pr0 = lib48.buildPrompt({ region: '포항', facility: '상가 하수구', problem: '막힘', photoCount: 3 });
  T('48 buildPrompt: 규칙 블록 "[직원이 고치는 패턴 — 자동 학습 … 건]" + 참고 완성본 블록이 user에 들어가고 system은 그대로 · 자료 없으면 종전과 같음', pr1.user.indexOf('[직원이 고치는 패턴 — 자동 학습') > 0 && pr1.user.indexOf(ll[0]) > 0 && pr1.user.indexOf('[참고 완성본') > 0 && pr1.user.indexOf('옮겨 쓰지 않습니다') > 0 && pr1.system === pr0.system && pr0.user.indexOf('자동 학습') < 0 && pr1.user.indexOf('자동 학습') < pr1.user.indexOf('이번 글의 필수 조건'), pr1.user.slice(pr1.user.indexOf('[직원이'), pr1.user.indexOf('[직원이') + 80));
  // 초안 보존
  mem.gw_data['promoai:draft:pl1'] = { schema: 1, items: [{ job: 'pa_old', title: 'o', body: 'o', ts: 1 }] };
  await PJ48.saveDraft('gw_data', 'pl1', 'pa_j1', '제목1', draft, 5000);
  await PJ48.saveDraft('gw_data', 'pl1', 'pa_j1', '제목1', draft, 5001);
  await PJ48.saveDraft('gw_data', 'pl1', 'pa_j2', '제목2', draft + '2', 5002);
  await PJ48.saveDraft('gw_data', 'pl1', 'pa_j3', '제목3', draft + '3', 5003);
  {
    const dd = mem.gw_data['promoai:draft:pl1'];
    T('48 saveDraft: job 멱등 · 최근 3건만 보존 · 최신이 마지막', dd.items.length === 3 && dd.items.map((x) => x.job).join(',') === 'pa_j1,pa_j2,pa_j3' && dd.items[2].title === '제목3', JSON.stringify(dd.items.map((x) => x.job)));
  }
  // 학습 워커 — 가짜 모델 응답(global.fetch) · 내부 토큰
  const worker48 = require(join(FN, 'gw-promo-learn-background.js'));
  const savedKey48 = process.env.GW_ANTHROPIC_KEY, savedUrl48 = process.env.URL, realFetch48 = global.fetch;
  process.env.GW_ANTHROPIC_KEY = 'test-anthropic-key-0000'; process.env.URL = 'https://test.local';
  mem.gw_data['col:promo'] = { schema: 1, items: [
    { id: 'pl1', title: '포항 장량동 상가 하수구 준설', body: draft, facility: '상가 하수구', status: 'posted', ai: { ts: 1 }, photos: [{ id: 'att_0123456789abcdef' }] },
    { id: 'pl2', title: '옛 기록', body: draft, facility: '우수받이', status: 'posted', ai: { ts: 1 }, contract_id: 'c48' },
    { id: 'pl3', title: '초안 없음', body: '', facility: '학교', status: 'review' },
  ], updated_at: 1 };
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c48', title: '계약', contract_info: { amount: 77777777, client: '비밀발주처' } }], updated_at: 1 };
  delete mem.gw_data['promoai:lessons']; delete mem.gw_data['promolearn:lock']; delete mem.gw_data['promoai:draft:pl1'];   // 보존 초안 없음 → 기록 본문(record) 경로부터
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa1'] = { schema: 1, id: 'pl_aaaaaaaaaaa1', promo_id: 'pl1', status: 'running', tries: 1, ts: 1, final_title: '포항 장량동 상가 하수구 준설', final_body: '&#65279;' + fin, src_file: 'a.hwp' };
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa2'] = { schema: 1, id: 'pl_aaaaaaaaaaa2', promo_id: 'pl2', status: 'running', tries: 1, ts: 1, final_title: '옛 기록', final_body: fin + '\n금액은 77777777원이었습니다', src_file: 'b.hwp' };
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa3'] = { schema: 1, id: 'pl_aaaaaaaaaaa3', promo_id: 'pl3', status: 'running', tries: 1, ts: 1, final_title: '초안 없음', final_body: fin, src_file: 'c.hwp' };
  const apiCalls48 = [];
  global.fetch = async (url, opt) => {
    apiCalls48.push({ url: String(url), auth: String((opt && opt.headers && (opt.headers['x-api-key'] || opt.headers.Authorization)) || '') });
    const b = JSON.parse(opt.body || '{}');
    const text = JSON.stringify({ summary: '저희를 회사명으로 바꿨고 연락처를 덧붙였다', changes: [{ kind: 'style', what: '저희→회사명' }], rules: [{ text: '자기 지칭은 저희가 아니라 회사명으로 쓴다', scope: 'style', n: 1, keep_id: '' }, { text: '글 끝에 문의 안내 한 줄을 덧붙인다', scope: 'content', n: 1, keep_id: '' }] });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: b.model, stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 100 }, content: [{ type: 'text', text: text }] }) };
  };
  const tokIn = issueSession({ id: '__promoai__', role: 'system' }).token;
  const ev48 = (body, tok) => ({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
  await worker48.handler(ev48({ pair_id: 'pl_aaaaaaaaaaa1' }, tokA), {});
  T('48 학습 워커: 사용자 토큰으로는 안 돈다(짝 그대로 running)', mem.gw_data['promolearn:in:pl_aaaaaaaaaaa1'].status === 'running' && apiCalls48.length === 0);
  await worker48.handler(ev48({ pair_id: 'pl_aaaaaaaaaaa1' }, tokIn), {});
  {
    const p = mem.gw_data['promolearn:in:pl_aaaaaaaaaaa1'], L = mem.gw_data['promoai:lessons'], rec = mem.gw_data['col:promo'].items[0];
    T('48 학습 워커: 모델 1회(키는 x-api-key 헤더로만) → 짝 done(gap·draft_src record·summary·changes) · 규칙 창고 2개 · 예시(상가하수구) · rec.learn · 잠금 해제', apiCalls48.length === 1 && apiCalls48[0].auth === 'test-anthropic-key-0000' && p.status === 'done' && p.gap && p.gap.ratio > 0 && p.draft_src === 'record' && p.rules_n === 2 && /회사명/.test(p.summary) && p.changes.length === 1
      && L && L.rules.length === 2 && L.exemplars['상가하수구'] && L.exemplars['상가하수구'].promo_id === 'pl1' && L.gaps.length === 1 && L.stats.tokens === 1000 && rec.learn && rec.learn.pair === 'pl_aaaaaaaaaaa1' && rec.learn.src === 'record' && mem.gw_data['promolearn:lock'].pair === '', JSON.stringify(p).slice(0, 200));
    T('48 학습 워커: 최종본 BOM 엔티티 제거(cleanFinal) → 예시 발췌에 &#65279; 없음', L.exemplars['상가하수구'].excerpt.indexOf('65279') < 0 && L.exemplars['상가하수구'].excerpt.indexOf('왜 막히나요') >= 0);
  }
  await worker48.handler(ev48({ pair_id: 'pl_aaaaaaaaaaa2' }, tokIn), {});
  T('48 학습 워커: 계약 참조 기록 + 최종본에 계약 금액 → LEAK_BLOCKED(모델 호출 0 추가) · 규칙 창고 그대로', mem.gw_data['promolearn:in:pl_aaaaaaaaaaa2'].status === 'fail' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa2'].code === 'LEAK_BLOCKED' && apiCalls48.length === 1 && mem.gw_data['promoai:lessons'].rules.length === 2, JSON.stringify(mem.gw_data['promolearn:in:pl_aaaaaaaaaaa2']).slice(0, 160));
  await worker48.handler(ev48({ pair_id: 'pl_aaaaaaaaaaa3' }, tokIn), {});
  T('48 학습 워커: 초안도 AI 결과도 없는 기록 → NO_DRAFT', mem.gw_data['promolearn:in:pl_aaaaaaaaaaa3'].status === 'fail' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa3'].code === 'NO_DRAFT');
  // 보존 초안이 있으면 그것을 쓴다(draft_src draft)
  mem.gw_data['promoai:draft:pl1'] = { schema: 1, items: [{ job: 'pa_x', title: '초안 제목', body: draft + '\n보존본 문장', ts: 2 }] };
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa4'] = { schema: 1, id: 'pl_aaaaaaaaaaa4', promo_id: 'pl1', status: 'running', tries: 1, ts: 1, final_title: 't', final_body: fin, src_file: 'd.hwp' };
  await worker48.handler(ev48({ pair_id: 'pl_aaaaaaaaaaa4' }, tokIn), {});
  T('48 학습 워커: 보존 초안 우선(draft_src draft·draft_job) · 규칙 n 누적(같은 문장 → 2)', mem.gw_data['promolearn:in:pl_aaaaaaaaaaa4'].draft_src === 'draft' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa4'].draft_job === 'pa_x' && mem.gw_data['promoai:lessons'].rules.some((r) => r.n === 2), JSON.stringify(mem.gw_data['promoai:lessons'].rules));
  // 크론 ④ — pending 짝 1건 기동(fetch로 학습 워커 URL), 전역 잠금이면 건너뜀
  const cron48 = require(join(FN, 'gw-promo-ai-cron.js'));
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa5'] = { schema: 1, id: 'pl_aaaaaaaaaaa5', promo_id: 'pl1', status: 'pending', tries: 0, ts: 100, final_title: 't', final_body: fin };
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa6'] = { schema: 1, id: 'pl_aaaaaaaaaaa6', promo_id: 'pl1', status: 'pending', tries: 0, ts: 200, final_title: 't', final_body: fin };
  const kicks48 = [];
  global.fetch = async (url, opt) => { kicks48.push({ url: String(url), body: JSON.parse(opt.body || '{}') }); return { ok: true, status: 202 }; };
  let kl = await cron48.kickLearn('gw_data', Date.now());
  T('48 크론 ④: pending 2 중 오래된 1건만 기동 → 학습 워커 URL·pair_id · 짝 running·tries 1', kl.started === 'pl_aaaaaaaaaaa5' && kl.pending === 2 && kicks48.length === 1 && /gw-promo-learn-background$/.test(kicks48[0].url) && kicks48[0].body.pair_id === 'pl_aaaaaaaaaaa5' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa5'].status === 'running' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa5'].tries === 1, JSON.stringify(kl));
  mem.gw_data['promolearn:lock'] = { ts: Date.now(), pair: 'pl_aaaaaaaaaaa5' };
  kl = await cron48.kickLearn('gw_data', Date.now());
  T('48 크론 ④: 전역 잠금(5분) 중이면 건너뜀', kl.skipped === 'running' && kicks48.length === 1);
  delete mem.gw_data['promolearn:lock'];
  global.fetch = async () => { throw new Error('down'); };
  kl = await cron48.kickLearn('gw_data', Date.now());
  T('48 크론 ④: 기동 실패 → 짝 fail KICKOFF_FAILED(10분 뒤 재시도 대상)', kl.code === 'KICKOFF_FAILED' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa6'].status === 'fail' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa6'].code === 'KICKOFF_FAILED');
  global.fetch = realFetch48;
  // pl_get / pl_set
  const pai48 = require(join(FN, 'gw-promo-ai.js'));
  const callP = async (body, tok, dev) => { const r = await pai48.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
  let rp = await callP({ action: 'pl_get' }, tokW, 'dev1');
  T('48 pl_get 비관리자 → 403', rp.code === 403);
  rp = await callP({ action: 'pl_get' }, tokA);
  T('48 pl_get 관리자: 규칙·예시·간극 요약·짝 목록(최신순)·상태', rp.code === 200 && rp.body.ok && rp.body.lessons.rules.length === 2 && rp.body.lessons.exemplars.length >= 1 && rp.body.lessons.summary.n >= 2 && rp.body.pairs.length >= 5 && rp.body.pairs[0].ts >= rp.body.pairs[1].ts, JSON.stringify(rp.body).slice(0, 200));
  T('48(v392) pl_get: 포장 프로필 블롭 없으면 layout null', rp.body.layout === null);
  mem.gw_data['promoai:layout'] = { schema: 1, ts: 5, by: 't', profile: { n_posts: 9, ok: true, center_ratio: 1, bold_ratio: 0.19, len_med: 19, len_p90: 25, gap_default: 1, hr_per_post: 8, tags_med: 61 }, posts: Array.from({ length: 14 }, (_, i) => ({ date: '2026-10-' + (15 - i), paras: 200 + i })) };
  const rpl = await callP({ action: 'pl_get' }, tokA);
  T('48(v392) pl_get layout: profile 그대로 · posts 12편 상한 · ts', rpl.code === 200 && rpl.body.layout && rpl.body.layout.profile.len_med === 19 && rpl.body.layout.profile.center_ratio === 1 && rpl.body.layout.posts.length === 12 && rpl.body.layout.ts === 5, JSON.stringify(rpl.body.layout).slice(0, 160));
  delete mem.gw_data['promoai:layout'];
  // v394 포장 간극·pl_layout·copy_save
  const lg = PL.layoutGap([['안녕하세요.', 'c'], ['왜 막히나요?', 'c'], ['', ''], ['상가 하수구는 기름이 굳어 막힙니다.', 'c'], ['', 'i']], [['안녕하세요.', 'cb'], ['', 'h'], ['왜 막히나요?', 'cb'], ['', 'c'], ['', 'c'], ['상가 하수구는 기름이 굳어 막힙니다', 'c'], ['새로 넣은 줄', 'c'], ['', 'i'], ['', 'i']]);
  T('48(v394) layoutGap: 줄 일치(문장부호·공백 무시) 3/4 · 굵게 차 + · 구분선 +1 · 사진 +1 · 빈 줄 차 +', lg.line_match === 0.75 && lg.bold_d > 0 && lg.hr_d === 1 && lg.img_d === 1 && lg.blank_d > 0 && lg.n_final === 4, JSON.stringify(lg));
  let rl = await callP({ action: 'pl_layout' }, tokA);
  T('48(v394) pl_layout: 블롭 없으면 profile null·200', rl.code === 200 && rl.body.ok && rl.body.profile === null, JSON.stringify(rl.body).slice(0, 120));
  mem.gw_data['promoai:layout'] = { schema: 2, ts: 7, profile: { n_posts: 9, ok: true, sig_kept_ratio: 0, head_hr_ratio: 0.75 }, posts: [] };
  rl = await callP({ action: 'pl_layout' }, tokA);
  T('48(v394) pl_layout: 프로필 그대로(홍보 권한) · posts는 안 보냄', rl.code === 200 && rl.body.profile.head_hr_ratio === 0.75 && rl.body.ts === 7 && rl.body.posts === undefined, JSON.stringify(rl.body).slice(0, 160));
  delete mem.gw_data['promoai:layout'];
  let cs = await callP({ action: 'copy_save', promo_id: 'bad id', lines: [['a', 'c']] }, tokA);
  T('48(v394) copy_save: 기록 id 불량 → 400', cs.code === 400 && cs.body.code === 'BAD_PROMO_ID');
  cs = await callP({ action: 'copy_save', promo_id: 'pl1', lines: [] }, tokA);
  T('48(v394) copy_save: 줄 없음 → 400', cs.code === 400 && cs.body.code === 'NO_LINES');
  cs = await callP({ action: 'copy_save', promo_id: 'pl1', lines: [['안녕하세요.', 'c<x>b'], ['', 'h'], 'junk', ['x'.repeat(300), 'cb']] }, tokA);
  const cpb = mem.gw_data['promoai:copy:pl1'];
  T('48(v394) copy_save: 저장 · 표식은 c/b/i/h만 · 200자 절단 · 배열 아닌 줄은 빈 줄로 · by', cs.code === 200 && cs.body.n === 4 && cpb && cpb.lines[0][1] === 'cb' && cpb.lines[1][1] === 'h' && cpb.lines[2][0] === '' && cpb.lines[3][0].length === 200 && cpb.by, JSON.stringify(cpb).slice(0, 160));
  const rid48 = rp.body.lessons.rules[0].id;
  rp = await callP({ action: 'pl_set', del_rule: rid48 }, tokA);
  T('48 pl_set 규칙 삭제 → 창고 1개 · 감사로그 블로그학습', rp.code === 200 && rp.body.lessons.rules.length === 1 && !rp.body.lessons.rules.some((r) => r.id === rid48) && auditMock.logs.some((l) => l.col === 'promo' && l.ev[0].op === '블로그학습'));
  rp = await callP({ action: 'pl_set', off: true }, tokA);
  T('48 pl_set 끄기 → lessons.off true → lessonLines 빈 배열', rp.code === 200 && rp.body.lessons.off === true && PL.lessonLines(mem.gw_data['promoai:lessons']).length === 0);
  rp = await callP({ action: 'pl_set', off: false }, tokA);
  T('48 pl_set 켜기', rp.code === 200 && rp.body.lessons.off === false);
  // 체크 10 품질 고리 3단계(원천) — pl_get qlearn 칸 · pl_set qoff(품질 자동 학습 끄기·켜기 — 골격 스위치 off와 따로). 나머지는 tools/promoqlearn_check.mjs
  rp = await callP({ action: 'pl_set', qoff: true }, tokA);
  T('48(체크 10 3단계) pl_set qoff 끄기 → promoai:qlearn off · 골격 lessons.off 그대로(false) · 감사로그 "품질 학습 끔" · pl_get qlearn.off', rp.code === 200 && rp.body.qlearn && rp.body.qlearn.off === true && mem.gw_data['promoai:qlearn'].off === true && rp.body.lessons.off === false && auditMock.logs.some((l) => l.col === 'promo' && l.ev[0].op === '블로그학습' && l.ev[0].t === '품질 학습 끔'), JSON.stringify(rp.body.qlearn));
  rp = await callP({ action: 'pl_set', qoff: false }, tokW, 'dev1');
  T('48(체크 10 3단계) pl_set qoff 비관리자 → 403', rp.code === 403);
  rp = await callP({ action: 'pl_set', qoff: false }, tokA);
  T('48(체크 10 3단계) pl_set qoff 켜기 → qlearn.off false · 규칙 없음(아직 학습 전)', rp.code === 200 && rp.body.qlearn.off === false && Array.isArray(rp.body.qlearn.rules) && rp.body.qlearn.rules.length === 0);
  // 체크 10 3단계 배포 전 검토(loop F2·sec S1): 짝이 40건을 넘어도 시간순 최근 40건(키 이름순 자르기 아님) · 간극 칸은 숫자로만
  {
    const added48 = [];
    for (let i = 0; i < 41; i++) { const k = 'promolearn:in:pl_f' + String(i).padStart(11, '0'); mem.gw_data[k] = { id: k.slice(14), status: 'done', promo_id: 'x', ts: 1000 + i, gap: { ratio: 0.1 } }; added48.push(k); }
    const kNew = 'promolearn:in:pl_000000000000'; mem.gw_data[kNew] = { id: 'pl_000000000000', status: 'done', promo_id: 'x', ts: Date.now() + 60000, gap: { ratio: 0, layout: { line_match: 0.9, hr_d: '<img src=x>' } } }; added48.push(kNew);
    rp = await callP({ action: 'pl_get' }, tokA);
    T('48(체크 10 3단계 검토) pl_get 짝: 40건 넘으면 시간순 최근 40건 — 키 이름순 맨 앞인 가장 새 짝이 맨 위 · 간극 칸 저장값은 숫자 아니면 null', rp.code === 200 && rp.body.pairs.length === 40 && rp.body.pairs[0].id === 'pl_000000000000' && rp.body.pairs[0].gap.ratio === 0 && rp.body.pairs[0].gap.layout.hr_d === null && rp.body.pairs[0].gap.layout.line_match === 0.9, JSON.stringify(rp.body.pairs && rp.body.pairs[0]));
    added48.forEach((k) => { delete mem.gw_data[k]; });
  }
  mem.gw_data['promolearn:in:pl_aaaaaaaaaaa7'] = { schema: 1, id: 'pl_aaaaaaaaaaa7', promo_id: '', status: 'unmatched', tries: 0, ts: 300, final_title: '짝 없음', final_body: fin };
  rp = await callP({ action: 'pl_set', assign: { pair_id: 'pl_aaaaaaaaaaa7', promo_id: 'nope' } }, tokA);
  T('48 pl_set 짝 지정: 없는 기록 → 404', rp.code === 404 && rp.body.code === 'PROMO_NOT_FOUND');
  rp = await callP({ action: 'pl_set', assign: { pair_id: 'pl_aaaaaaaaaaa7', promo_id: 'pl1' } }, tokA);
  T('48 pl_set 짝 지정 → pending·promo_id·match 관리자 지정', rp.code === 200 && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa7'].status === 'pending' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa7'].promo_id === 'pl1' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa7'].match.title === '관리자 지정');
  rp = await callP({ action: 'pl_set', retry: 'pl_aaaaaaaaaaa6' }, tokA);
  T('48 pl_set 다시 → pending·tries 0', rp.code === 200 && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa6'].status === 'pending' && mem.gw_data['promolearn:in:pl_aaaaaaaaaaa6'].tries === 0);
  rp = await callP({ action: 'pl_set' }, tokA);
  T('48 pl_set 변경 없음 → 400', rp.code === 400 && rp.body.code === 'NO_CHANGE');
  const csrc48 = require('fs').readFileSync(join(FN, 'gw-promo-ai-cron.js'), 'utf8'), wsrc48 = require('fs').readFileSync(join(FN, 'gw-promo-ai-run-background.js'), 'utf8');
  T('48 배선: 크론 ④ kickLearn 호출 · 워커 생성 성공 뒤 saveDraft · 생성 입력에 lessons/exemplar 주입 + 차단 시 자료만 빼고 재조립 · 모자이크(③ remaskOld) 그대로', /learn = await kickLearn\(st, doc, now\)|learn = await kickLearn\(st, now\)/.test(csrc48) && /remask = await remaskOld\(st, doc, now\)/.test(csrc48) && /PJ\.saveDraft\(st, promoId, job, title, body/.test(wsrc48) && /input\.lessons = ll/.test(wsrc48) && /delete input\.exemplar; delete input\.lessons;/.test(wsrc48));
  process.env.GW_ANTHROPIC_KEY = savedKey48; process.env.URL = savedUrl48;
  if (savedKey48 === undefined) delete process.env.GW_ANTHROPIC_KEY;
}
{ // ---- 49(v395) 자동 지시 배정표 settings:assign — 기반 1 첫 시범(관리자 전용·접두어·회원 검증·낙관락·ingest/save 채움·이월·되돌리기·감사) ----
  let r49 = await call({ action: 'assign_get' }, tokW, 'dev1');
  T('49 assign_get 비관리자 → 403', r49.code === 403);
  r49 = await call({ action: 'assign_get' }, tokA);
  T('49 assign_get 관리자 → 빈 표 · 접두어 7(v417 site:·wk:) · prev null', r49.code === 200 && Object.keys(r49.body.rules).length === 0 && Object.keys(r49.body.prefixes).length === 7 && r49.body.prev === null, JSON.stringify(r49.body).slice(0, 160));
  r49 = await call({ action: 'assign_set', prefix: 'xx:', who_id: 'uwork' }, tokA);
  T('49 assign_set 모르는 접두어 → 400 BAD_PREFIX', r49.code === 400 && r49.body.error_code === 'BAD_PREFIX', r49.code + '/' + r49.body.error_code);
  r49 = await call({ action: 'assign_set', prefix: 'veh:', who_id: 'ughost' }, tokA);
  T('49 assign_set 비회원 id → 400 BAD_MEMBER', r49.code === 400 && r49.body.error_code === 'BAD_MEMBER', r49.code + '/' + r49.body.error_code);
  r49 = await call({ action: 'assign_set', prefix: 'veh:', who_id: 'uwork' }, tokW, 'dev1');
  T('49 assign_set 비관리자 → 403', r49.code === 403);
  const auditN49 = auditMock.logs.length;
  r49 = await call({ action: 'assign_set', prefix: 'veh:', who_id: 'uwork', base: 0 }, tokA);
  T('49 assign_set veh:→직원 · 감사 배정변경 1', r49.code === 200 && r49.body.rules['veh:'].who_id === 'uwork' && auditMock.logs.length === auditN49 + 1 && auditMock.logs[auditN49].ev[0].op === '배정변경', JSON.stringify(r49.body).slice(0, 160));
  const base49 = r49.body.updated_at;
  r49 = await call({ action: 'assign_set', prefix: 'lic:', who_id: 'uwork', base: 0 }, tokA);
  T('49 assign_set 낡은 base → 409 ASSIGN_STALE', r49.code === 409 && r49.body.error_code === 'ASSIGN_STALE');
  mem.gw_data['col:tasks'] = { schema: 1, items: [
    { id: 't_old49', title: '옛 인허가', auto_key: 'lic:1:exp:2026-12-01', who_id: '', who: '', status: 'open', from: '자동' },
    { id: 't_h49', title: '사람 지정', auto_key: 'veh:9:ins:2026-11-30', who_id: 'uadmin', who: '관리자', status: 'open', from: '자동' },
    { id: 't_d49', title: '끝난 것', auto_key: 'veh:8:ins:2026-10-01', who_id: '', who: '', status: 'done', from: '자동' }] };
  r49 = await call({ action: 'autotask_ingest', key: 'test-ingest-key', items: [{ auto_key: 'veh:2:insp:2026-11-20', title: '차량 정기검사', due: '2026-11-20' }] });
  const tk49 = mem.gw_data['col:tasks'].items;
  const nv49 = tk49.find((t) => t.auto_key === 'veh:2:insp:2026-11-20'), ol49 = tk49.find((t) => t.id === 't_old49'), hh49 = tk49.find((t) => t.id === 't_h49'), dd49 = tk49.find((t) => t.id === 't_d49');
  T('49 ingest: 새 veh 담당=직원(who_by assign) · 규칙 없는 lic 공란 유지 · 사람 지정 불변 · done 불변 · assigned 1 · 감사 "배정 1"',
    r49.code === 200 && r49.body.assigned === 1 && nv49 && nv49.who_id === 'uwork' && nv49.who === '직원' && nv49.who_by === 'assign' && ol49.who_id === '' && hh49.who_id === 'uadmin' && dd49.who_id === ''
    && /배정 1/.test(auditMock.logs[auditMock.logs.length - 1].ev[0].t), JSON.stringify({ r: r49.body, nv: nv49 }).slice(0, 220));
  const docS49 = JSON.parse(JSON.stringify(mem.gw_data['col:tasks']));
  docS49.items.forEach((t) => { if (t.id === nv49.id) { t.who_id = ''; t.who = ''; } });
  docS49.items.push({ id: 't_new49', title: '새 차량', auto_key: 'veh:3:insp:2026-12-05', who_id: '', who: '', status: 'open', from: '자동' });
  r49 = await call({ action: 'save', collection: 'tasks', doc: docS49 }, tokA);
  const tk49b = mem.gw_data['col:tasks'].items;
  T('49 save: 클라가 비워 보낸 서버 배정 who_id 이월 · 새 공란 veh 채움', r49.code === 200 && tk49b.find((t) => t.id === nv49.id).who_id === 'uwork' && tk49b.find((t) => t.id === 't_new49').who_id === 'uwork' && tk49b.find((t) => t.id === 't_new49').who_by === 'assign', r49.code + ' ' + JSON.stringify(tk49b.map((t) => [t.id, t.who_id])));
  r49 = await call({ action: 'assign_set', approver_id: 'uadmin', base: base49 }, tokA);
  T('49 승인권자 저장', r49.code === 200 && r49.body.approver_id === 'uadmin');
  r49 = await call({ action: 'assign_revert', base: r49.body.updated_at }, tokA);
  T('49 assign_revert → 직전 표(승인권자 빔 · veh 유지) · 감사 배정되돌림', r49.code === 200 && r49.body.approver_id === '' && r49.body.rules['veh:'].who_id === 'uwork' && auditMock.logs[auditMock.logs.length - 1].ev[0].op === '배정되돌림', JSON.stringify(r49.body).slice(0, 160));
  r49 = await call({ action: 'assign_set', base: r49.body.updated_at }, tokA);
  T('49 assign_set 변경 없음 → 400 NO_CHANGE', r49.code === 400 && r49.body.error_code === 'NO_CHANGE');
  delete mem.gw_data['settings:assign'];
}
{ // ---- 50(v396) 지시 알림 설정 settings:notify — 기반 3 첫 시범(관리자 전용·검증·낙관락·push_send 정책·save/ingest 담당자 1발·크론 요약·되돌리기·감사) ----
  mem.gw_users['member:uadm50'] = { id: 'uadm50', name: '관리자50', admin: true, perms: {}, tier: 'admin' };
  const adminsN50 = (await pushMock.adminIds()).length;   // 앞 절들이 심어둔 재직 관리자 수(고정값 아님)
  let r50 = await call({ action: 'notify_get' }, tokW, 'dev1');
  T('50 notify_get 비관리자 → 403', r50.code === 403);
  r50 = await call({ action: 'notify_get' }, tokA);
  T('50 notify_get 관리자 → 기본값 3종(현행) · meta 라벨·추천 · prev null', r50.code === 200 && r50.body.events.task_auto_create === 'admins' && r50.body.events.task_review === 'admins' && r50.body.events.due_digest === 'each' && r50.body.meta.task_auto_create.rec === 'assignee' && r50.body.prev === null, JSON.stringify(r50.body).slice(0, 200));
  r50 = await call({ action: 'notify_set', event: 'task_auto_create', value: 'nope' }, tokA);
  T('50 notify_set 모르는 값 → 400 BAD_EVENT', r50.code === 400 && r50.body.error_code === 'BAD_EVENT');
  r50 = await call({ action: 'notify_set', event: 'task_auto_create', value: 'admins' }, tokA);
  T('50 notify_set 변경 없음 → 400 NO_CHANGE', r50.code === 400 && r50.body.error_code === 'NO_CHANGE');
  // 현행 모드: 클라 관리자 전원 푸시 그대로(직원이 쏘면 관리자 2명)
  pushMock.calls.length = 0;
  r50 = await call({ action: 'push_send', to: '__admins__', title: '만기 임박 1건', body: 'x', tag: 'auto-due' }, tokW, 'dev1');
  T('50 현행(admins): auto-due 관리자 전원 푸시 그대로(sent = 관리자 수)', r50.code === 200 && r50.body.sent === adminsN50 && pushMock.calls.length === 1, JSON.stringify(r50.body) + ' admins ' + adminsN50);
  const auditN50 = auditMock.logs.length;
  r50 = await call({ action: 'notify_set', event: 'task_auto_create', value: 'assignee', base: 0 }, tokA);
  T('50 notify_set 생성→담당자 본인 · 감사 알림변경', r50.code === 200 && r50.body.events.task_auto_create === 'assignee' && auditMock.logs.length === auditN50 + 1 && auditMock.logs[auditN50].ev[0].op === '알림변경', JSON.stringify(r50.body).slice(0, 160));
  let base50 = r50.body.updated_at;
  // v437: 전환 직후(settings:notify updated_at = 방금 저장)는 병행 7일 안 — 클라 auto-due 관리자 푸시를 삼키지 않고 종전처럼 관리자 전원에게(직원이 쏘면 관리자 수만큼).
  //       7일이 지나면 종전처럼 삼킨다(sent 0 suppressed) — 저장 시각을 7일 1분 앞당겨 흉내, 끝나면 되돌림(뒤 낙관락 base50). 경우별 행렬은 81절
  pushMock.calls.length = 0;
  r50 = await call({ action: 'push_send', to: '__admins__', title: '만기 임박 1건', body: 'x', tag: 'auto-due' }, tokW, 'dev1');
  T('50 assignee 전환 직후(병행 7일 안 — v437): 클라 auto-due 관리자 푸시는 삼키지 않고 그대로(sent = 관리자 수 · suppressed 없음 · 발송 1)', r50.code === 200 && r50.body.sent === adminsN50 && !('suppressed' in r50.body) && pushMock.calls.length === 1 && pushMock.calls[0].tag === 'auto-due', JSON.stringify(r50.body) + ' admins ' + adminsN50);
  mem.gw_data['settings:notify'].updated_at = base50 - 7 * 86400000 - 60000;
  pushMock.calls.length = 0;
  r50 = await call({ action: 'push_send', to: '__admins__', title: '만기 임박 1건', body: 'x', tag: 'auto-due' }, tokW, 'dev1');
  T('50 assignee 전환 7일 1분 뒤(병행 끝): 클라 auto-due 관리자 푸시는 서버가 삼킴(sent 0 suppressed) · 다른 태그는 그대로', r50.code === 200 && r50.body.sent === 0 && r50.body.suppressed === 'task_auto_create' && pushMock.calls.length === 0, JSON.stringify(r50.body));
  r50 = await call({ action: 'push_send', to: '__admins__', title: '기타', body: 'x', tag: 'etc' }, tokW, 'dev1');
  T('50 assignee 모드: 다른 태그 __admins__는 종전대로(sent = 관리자 수)', r50.code === 200 && r50.body.sent === adminsN50, JSON.stringify(r50.body));
  mem.gw_data['settings:notify'].updated_at = base50;
  // save: 새 자동 지시 → 배정표로 담당 채움 → 담당자 본인 1발(우선기기)
  mem.gw_data['settings:assign'] = { schema: 1, rules: { 'veh:': { who_id: 'uwork' } }, approver_id: '', prev: null, updated_at: 5, updated_by: 'x' };
  mem.gw_data['col:tasks'] = { schema: 1, items: [] };
  pushMock.calls.length = 0;
  r50 = await call({ action: 'save', collection: 'tasks', doc: { schema: 1, items: [
    { id: 't_a50', title: '12가3456 정기검사 갱신', auto_key: 'veh:1:insp:2026-11-20', who_id: '', who: '', status: 'open', from: '자동', due: '2026-11-20' },
    { id: 't_b50', title: '12가3456 보험 갱신', auto_key: 'veh:1:ins:2026-11-25', who_id: '', who: '', status: 'open', from: '자동', due: '2026-11-25' },
    { id: 't_c50', title: '인허가 갱신(배정 없음)', auto_key: 'lic:1:exp:2026-12-01', who_id: '', who: '', status: 'open', from: '자동', due: '2026-12-01' }] } }, tokA);
  const pc50 = pushMock.calls.filter((p) => /^auto-new-uwork-/.test(p.tag || ''));
  T('50 save: veh 2건 담당 채움 → 담당자 1묶음 푸시("자동 지시 2건", 제목·기한) · 담당 없는 lic는 발송 없음', r50.code === 200 && pc50.length === 1 && /자동 지시 2건/.test(pc50[0].title) && /정기검사 갱신 ~2026-11-20/.test(pc50[0].body) && pushMock.calls.length === 1, JSON.stringify(pushMock.calls));
  // ingest: 새 항목 + 공란 backfill → 담당자 1발 · notified 1
  pushMock.calls.length = 0;
  r50 = await call({ action: 'autotask_ingest', key: 'test-ingest-key', items: [{ auto_key: 'veh:2:insp:2026-11-28', title: '34나5678 정기검사 갱신', due: '2026-11-28' }] });
  T('50 ingest: 새 veh 항목 → 담당 채움 + 담당자 1발 · notified 1', r50.code === 200 && r50.body.assigned === 1 && r50.body.notified === 1 && pushMock.calls.length === 1 && /자동 지시 1건/.test(pushMock.calls[0].title), JSON.stringify(r50.body) + JSON.stringify(pushMock.calls));
  // 완료 요청 → 승인권자 1인
  r50 = await call({ action: 'notify_set', event: 'task_review', value: 'issuer_approver', base: base50 }, tokA); base50 = r50.body.updated_at;
  pushMock.calls.length = 0;
  r50 = await call({ action: 'push_send', to: '__admins__', title: '승인요청: x', body: 'x', tag: 'task-rv-t1' }, tokW, 'dev1');
  T('50 issuer_approver + 승인권자 미지정 → 종전대로 관리자 전원(sent = 관리자 수)', r50.code === 200 && r50.body.sent === adminsN50, JSON.stringify(r50.body));
  mem.gw_data['settings:assign'].approver_id = 'uadmin';
  r50 = await call({ action: 'push_send', to: '__admins__', title: '승인요청: x', body: 'x', tag: 'task-rv-t1' }, tokW, 'dev1');
  T('50 issuer_approver + 승인권자 지정 → 승인권자 1인만(sent 1)', r50.code === 200 && r50.body.sent === 1, JSON.stringify(r50.body));
  r50 = await call({ action: 'push_send', to: '__admins__', title: '승인요청: x', body: 'x', tag: 'task-rv-t2' }, tokA);
  T('50 승인권자 본인이 완료 요청하면 자기 제외 → 다른 관리자(sent = 관리자 수 − 1)', r50.code === 200 && r50.body.sent === adminsN50 - 1, JSON.stringify(r50.body));
  // 크론 요약
  r50 = await call({ action: 'notify_set', event: 'due_digest', value: 'summary', base: base50 }, tokA); base50 = r50.body.updated_at;
  const cron50 = require(join(FN, 'gw-todo-cron.js'));
  const kst50 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  mem.gw_data['col:tasks'].items.push({ id: 't_d50', title: '경과', auto_key: 'cert:c9', who_id: '', who: '', status: 'open', from: '자동', due: '2026-01-01' });
  pushMock.calls.length = 0;
  const cr50 = JSON.parse((await cron50.handler({})).body);
  T('50 크론 요약: 자동 지시 열린 5·기한/경과 1·담당 없음 2 → 승인권자 1인 1발(tag task-digest-오늘)', cr50.ok && cr50.digest && cr50.digest.autos === 5 && cr50.digest.due === 1 && cr50.digest.no_who === 2 && cr50.digest.to === 1 && cr50.digest.sent === true && pushMock.calls.length === 1 && pushMock.calls[0].tag === 'task-digest-' + kst50, JSON.stringify(cr50) + JSON.stringify(pushMock.calls));
  r50 = await call({ action: 'notify_revert', base: base50 }, tokA);
  T('50 notify_revert → 직전 판(due_digest each · 나머지 유지) · 감사 알림되돌림', r50.code === 200 && r50.body.events.due_digest === 'each' && r50.body.events.task_review === 'issuer_approver' && auditMock.logs[auditMock.logs.length - 1].ev[0].op === '알림되돌림', JSON.stringify(r50.body).slice(0, 160));
  delete mem.gw_data['settings:notify']; delete mem.gw_data['settings:assign']; delete mem.gw_users['member:uadm50']; pushMock.calls.length = 0;
}
{ // ---- 51(v397) 공통 done_if 워커 — 라이브러리 순수 함수 · 크론 dry-run/적용 · clog 해시 체인 · 감사 · 승인권자 1발 · doneif_off · save 보호 · doneif_get/set ----
  const D51 = require(join(FN, '_lib/doneif.js'));
  const recs51 = { vehicles: { v1: { id: 'v1', insp_due: '2026-12-20', ins_due: '2026-11-25' } }, licenses: { l1: { id: 'l1', expiry: '2026-12-01', edu_due: '2027-01-15' } }, receivables: { r1: { id: 'r1', paid: '2026-10-20' }, r2: { id: 'r2', paid: null } } };
  const mk51 = (id, key, extra) => Object.assign({ id: id, title: id, auto_key: key, status: 'open', from: '자동', who_id: 'uwork' }, extra || {});
  T('51 signalFor: 차량 정기검사 기한 11-20 → 레코드 12-20(갱신) = 신호', D51.signalFor(mk51('a', 'veh:v1:insp:2026-11-20'), recs51).ok === true);
  T('51 signalFor: 차량 보험 기한 11-25 = 레코드 11-25(미갱신) = 신호 없음', D51.signalFor(mk51('b', 'veh:v1:ins:2026-11-25'), recs51).ok === false);
  T('51 signalFor: 인허가 보수교육 12-01 → 레코드 2027-01-15 = 신호 · 미수 입금 = 신호 · 미입금 = 없음 · 레코드 없음 = 없음',
    D51.signalFor(mk51('c', 'lic:l1:edu:2026-12-01'), recs51).ok === true && D51.signalFor(mk51('d', 'rec:r1:over45'), recs51).ok === true && D51.signalFor(mk51('e', 'rec:r2:over45'), recs51).ok === false && D51.signalFor(mk51('f', 'veh:v9:insp:2026-11-20'), recs51).why === 'no_record');
  T('51 eligible: open/hold 자동 지시만 · done·삭제·doneif_off·사람 지시 제외', D51.eligible(mk51('g', 'veh:v1:insp:2026-11-20')) && D51.eligible(mk51('h', 'veh:v1:insp:2026-11-20', { status: 'hold' })) && !D51.eligible(mk51('i', 'veh:v1:insp:2026-11-20', { status: 'done' })) && !D51.eligible(mk51('j', 'veh:v1:insp:2026-11-20', { del: 1 })) && !D51.eligible(mk51('k', 'veh:v1:insp:2026-11-20', { doneif_off: 1 })) && !D51.eligible({ id: 'l', status: 'open' }));
  const cl = D51.clogAppend(D51.clogAppend(null, { id: 'x', to: 'review' }), { id: 'y', to: 'review' });
  T('51 clogAppend: 해시 체인(2번째 p = 1번째 h, head = 마지막 h)', cl.items.length === 2 && cl.items[1].p === cl.items[0].h && cl.head === cl.items[1].h && cl.items[0].h.length === 16);
  // 크론: dry-run(기본) → 데이터 불변 · it:doneif:last 기록
  const cron51 = require(join(FN, 'gw-doneif-cron.js'));
  mem.gw_data['col:tasks'] = { schema: 1, items: [mk51('t_v', 'veh:v1:insp:2026-11-20'), mk51('t_i', 'veh:v1:ins:2026-11-25'), mk51('t_r', 'rec:r1:over45'), mk51('t_off', 'rec:r1:over45', { doneif_off: 1 }), mk51('t_h', 'veh:v1:insp:2026-11-20', { status: 'review', done_by: '직원' }), { id: 't_man', title: '사람 지시', status: 'open' }] };
  mem.gw_data['col:vehicles'] = { items: [recs51.vehicles.v1] }; mem.gw_data['col:licenses'] = { items: [recs51.licenses.l1] }; mem.gw_data['col:receivables'] = { items: [recs51.receivables.r1, recs51.receivables.r2] };
  delete mem.gw_data['settings:doneif']; delete mem.gw_data['it:doneif:last']; pushMock.calls.length = 0;
  let c51 = JSON.parse((await cron51.handler({})).body);
  T('51 크론 dry-run(설정 없음=끔): 후보 2(t_v·t_r) · 전환 0 · 데이터 불변 · it:doneif:last 기록 · 푸시 0', c51.ok && c51.on === false && c51.scanned === 3 && c51.candidates.length === 2 && c51.moved === 0 && mem.gw_data['col:tasks'].items.find((t) => t.id === 't_v').status === 'open' && mem.gw_data['it:doneif:last'].candidates.length === 2 && pushMock.calls.length === 0, JSON.stringify(c51));
  // 설정 액션
  let r51 = await call({ action: 'doneif_get' }, tokW, 'dev1'); T('51 doneif_get 비관리자 → 403', r51.code === 403);
  r51 = await call({ action: 'doneif_get' }, tokA); T('51 doneif_get 관리자 → on false · last 후보 2', r51.code === 200 && r51.body.on === false && r51.body.last && r51.body.last.candidates.length === 2, JSON.stringify(r51.body).slice(0, 160));
  r51 = await call({ action: 'doneif_set', on: 'yes' }, tokA); T('51 doneif_set 불리언 아님 → 400', r51.code === 400);
  const auditN51 = auditMock.logs.length;
  r51 = await call({ action: 'doneif_set', on: true, base: 0 }, tokA); T('51 doneif_set 켬 · 감사 앱기준설정', r51.code === 200 && r51.body.on === true && auditMock.logs[auditN51].ev[0].op === '앱기준설정');
  mem.gw_data['settings:assign'] = { schema: 1, rules: {}, approver_id: 'uadmin', prev: null, updated_at: 1, updated_by: 'x' };
  pushMock.calls.length = 0;
  mem.gw_data['ver:tasks:appbase:' + new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)] = null;   // v403: 실 Blobs의 '없는 키'(ok:true·data:null) 재현 — 모의는 없는 키를 ok:false로 주어 스냅샷 미기록 결함을 못 잡았다(10/31)
  c51 = JSON.parse((await cron51.handler({})).body);
  const tk51 = mem.gw_data['col:tasks'].items; const tv = tk51.find((t) => t.id === 't_v'), ti = tk51.find((t) => t.id === 't_i'), toff = tk51.find((t) => t.id === 't_off'), th = tk51.find((t) => t.id === 't_h');
  const clog51 = mem.gw_data['clog:appr:' + c51.today.slice(0, 7)];
  T('51 크론 켬: t_v·t_r → review·앱 기준·done_src · 미갱신 t_i open · doneif_off·사람 review 불변 · 스냅샷 키 · clog 2행 체인 · 감사 앱기준전환 · 승인권자 1발(task-appbase)',
    c51.moved === 2 && tv.status === 'review' && tv.done_by === '앱 기준' && /^doneif:veh\.insp_due/.test(tv.done_src) && ti.status === 'open' && toff.status === 'open' && th.done_by === '직원'
    && !!mem.gw_data['ver:tasks:appbase:' + c51.today] && clog51 && clog51.items.length === 2 && clog51.items[1].p === clog51.items[0].h
    && auditMock.logs[auditMock.logs.length - 1].ev[0].op === '앱기준전환' && pushMock.calls.length === 1 && pushMock.calls[0].tag === 'task-appbase-' + c51.today && c51.notified === 1, JSON.stringify(c51) + JSON.stringify(pushMock.calls));
  c51 = JSON.parse((await cron51.handler({})).body);
  T('51 크론 재실행: 이미 review인 건은 후보 아님(후보 0·전환 0·스냅샷 그대로 1개)', c51.moved === 0 && c51.candidates.length === 0);
  // save 보호: 낡은 사본이 t_v를 open으로 보내도 review 유지 · 반려(doneif_off=1)는 통과 · 승인(done)은 통과
  const docS51 = JSON.parse(JSON.stringify(mem.gw_data['col:tasks']));
  docS51.items.forEach((t) => { if (t.id === 't_v') { t.status = 'open'; t.done_at = null; t.done_by = null; } if (t.id === 't_r') { t.status = 'open'; t.done_at = null; t.done_by = null; t.doneif_off = 1; } });
  r51 = await call({ action: 'save', collection: 'tasks', doc: docS51 }, tokA);
  const tk51b = mem.gw_data['col:tasks'].items;
  T('51 save 보호: 앱 기준 review를 open으로 보낸 t_v는 review 이월 · 반려(doneif_off) t_r은 open 통과', r51.code === 200 && tk51b.find((t) => t.id === 't_v').status === 'review' && tk51b.find((t) => t.id === 't_v').done_by === '앱 기준' && tk51b.find((t) => t.id === 't_r').status === 'open' && tk51b.find((t) => t.id === 't_r').doneif_off === 1, JSON.stringify(tk51b.map((t) => [t.id, t.status])));
  const docS51b = JSON.parse(JSON.stringify(mem.gw_data['col:tasks'])); docS51b.items.forEach((t) => { if (t.id === 't_v') { t.status = 'done'; t.approved_by = '관리자'; t.approved_at = '2026-10-27'; } });
  r51 = await call({ action: 'save', collection: 'tasks', doc: docS51b }, tokA);
  T('51 save: 승인(done)은 통과', r51.code === 200 && mem.gw_data['col:tasks'].items.find((t) => t.id === 't_v').status === 'done');
  c51 = JSON.parse((await cron51.handler({})).body);
  T('51 크론: 반려로 신호 끈 t_r(입금 신호 있음)은 다시 올리지 않음', c51.candidates.length === 0 && mem.gw_data['col:tasks'].items.find((t) => t.id === 't_r').status === 'open');
  r51 = await call({ action: 'doneif_set', on: false, base: mem.gw_data['settings:doneif'].updated_at }, tokA); T('51 doneif_set 끔 · prev on true', r51.code === 200 && mem.gw_data['settings:doneif'].prev.on === true);
  ['settings:doneif', 'it:doneif:last', 'settings:assign', 'col:vehicles', 'col:licenses', 'col:receivables', 'clog:appr:' + c51.today.slice(0, 7), 'ver:tasks:appbase:' + c51.today].forEach((k) => { delete mem.gw_data[k]; }); pushMock.calls.length = 0;
}
{ // ---- 52(v398) 크론 흔적 스탬프 — todo·doneif·appr 핸들러 1회 실행 → it:cron:<fn>:last {state end, ok, runs, day} ----
  ['it:cron:gw-todo-cron:last', 'it:cron:gw-doneif-cron:last', 'it:cron:gw-appr-cron:last'].forEach((k) => { delete mem.gw_data[k]; });
  mem.gw_data['col:tasks'] = { schema: 1, items: [] };
  const todo52 = require(join(FN, 'gw-todo-cron.js')); await todo52.handler({});
  const doneif52 = require(join(FN, 'gw-doneif-cron.js')); await doneif52.handler({});
  const appr52 = require(join(FN, 'gw-appr-cron.js')); await appr52.handler({});
  const s1 = mem.gw_data['it:cron:gw-todo-cron:last'], s2 = mem.gw_data['it:cron:gw-doneif-cron:last'], s3 = mem.gw_data['it:cron:gw-appr-cron:last'];
  T('52 스탬프: todo·doneif·appr 실행 뒤 it:cron:<fn>:last state end · ok true · runs 1 · day KST', !!s1 && s1.state === 'end' && s1.ok === true && s1.runs === 1 && /^\d{4}-\d{2}-\d{2}$/.test(s1.day) && !!s2 && s2.state === 'end' && s2.ok === true && /on false/.test(s2.note) && !!s3 && s3.state === 'end' && s3.runs === 1, JSON.stringify([s1, s2, s3]).slice(0, 300));
  await todo52.handler({});
  T('52 스탬프: 재실행 runs 2 · start_ts 갱신', mem.gw_data['it:cron:gw-todo-cron:last'].runs === 2 && mem.gw_data['it:cron:gw-todo-cron:last'].start_ts >= s1.start_ts);
  ['it:cron:gw-todo-cron:last', 'it:cron:gw-doneif-cron:last', 'it:cron:gw-appr-cron:last', 'it:doneif:last'].forEach((k) => { delete mem.gw_data[k]; });
}
{ // ---- 53(v399) 감시 경보 라벨 it:alerts — 관리자 전용 · id/level 검증 · mute until 7일 · 감사 경보라벨 ----
  delete mem.gw_data['it:alerts'];
  let r53 = await call({ action: 'alerts_get' }, tokW, 'dev1'); T('53 alerts_get 비관리자 → 403', r53.code === 403);
  r53 = await call({ action: 'alerts_get' }, tokA); T('53 alerts_get 관리자 → 빈 라벨', r53.code === 200 && Object.keys(r53.body.labels).length === 0);
  r53 = await call({ action: 'alerts_set', id: 'bad id!', level: 'alert' }, tokA); T('53 alerts_set id 불량 → 400 BAD_ID', r53.code === 400 && r53.body.error_code === 'BAD_ID');
  r53 = await call({ action: 'alerts_set', id: 'gw-doneif-cron', level: 'loud' }, tokA); T('53 alerts_set level 불량 → 400 BAD_LEVEL', r53.code === 400 && r53.body.error_code === 'BAD_LEVEL');
  const auditN53 = auditMock.logs.length;
  r53 = await call({ action: 'alerts_set', id: 'gw-doneif-cron', level: 'alert' }, tokA);
  T('53 alerts_set 승격 · 감사 경보라벨 warn→alert', r53.code === 200 && r53.body.labels['gw-doneif-cron'].level === 'alert' && r53.body.labels['gw-doneif-cron'].until === '' && auditMock.logs[auditN53].ev[0].op === '경보라벨' && /warn→alert/.test(auditMock.logs[auditN53].ev[0].t), JSON.stringify(r53.body));
  r53 = await call({ action: 'alerts_set', id: 'gw-hwakwan-cron', level: 'mute' }, tokA);
  const kst53 = new Date(Date.now() + 9 * 3600000); const until53 = new Date(kst53.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  T('53 alerts_set 무음 → until = 오늘+7(KST) · 다른 라벨 보존', r53.code === 200 && r53.body.labels['gw-hwakwan-cron'].level === 'mute' && r53.body.labels['gw-hwakwan-cron'].until === until53 && r53.body.labels['gw-doneif-cron'].level === 'alert', JSON.stringify(r53.body));
  r53 = await call({ action: 'alerts_set', id: 'JW 첨부백업', level: 'alert' }, tokA);
  T('53 v427 alerts_set 로컬 예약 작업 id(한글·띄어쓰기 "JW 첨부백업") 통과', r53.code === 200 && r53.body.labels['JW 첨부백업'].level === 'alert', JSON.stringify(r53.body).slice(0, 200));
  delete mem.gw_data['it:alerts'];
}
{ // ---- 54(v400) 계약 골조·목록 거울 settings:contract / proc:contract:v1 / list:contract — 조회(로그인 전원)·스위치(관리자·값·낙관락·거울 층 검증·prev 되돌리기·감사 계약골조) ----
  delete mem.gw_data['settings:contract']; delete mem.gw_data['proc:contract:v1']; delete mem.gw_data['list:contract'];
  let r54 = await call({ action: 'con_proc_get' }, tokW, 'dev1'); T('54 con_proc_get 직원 → 200 · 기본 꺼짐 · 거울 없음', r54.code === 200 && r54.body.flag.use_blob === false && r54.body.proc === null && r54.body.list === null);
  r54 = await call({ action: 'con_proc_flag_set', use_blob: true }, tokW, 'dev1'); T('54 flag_set 비관리자 → 403', r54.code === 403);
  r54 = await call({ action: 'con_proc_flag_set', use_blob: 'yes' }, tokA); T('54 flag_set 값 불량 → 400 BAD_VALUE', r54.code === 400 && r54.body.error_code === 'BAD_VALUE');
  r54 = await call({ action: 'con_proc_flag_set', use_blob: true }, tokA); T('54 거울 없이 켜기 → 409 MIRROR_MISSING', r54.code === 409 && r54.body.error_code === 'MIRROR_MISSING');
  const mk54 = (layer, names) => ({ schema: 1, layer, proc_ver: 'v1', built_at: '2026-10-28T09:00:00+09:00', consts: Object.fromEntries(names.map((n) => [n, {}])), added: layer === 'proc' ? { stages: [] } : { lists: [] }, sha: 'abcdef0123456789' });
  mem.gw_data['proc:contract:v1'] = mk54('proc', ['CON_TYPE_ELEMS', 'CON_SCEN', 'CON_STAGE_FIELDS', 'CON_SITE_CORP']);
  mem.gw_data['list:contract'] = { ...mk54('list', ['STAGE_DOCS', 'STAGE_DOC_MAP', 'CON_PACKETS']), proc_ver: 'v2' };
  r54 = await call({ action: 'con_proc_flag_set', use_blob: true }, tokA); T('54 목록 층 proc_ver≠v1 → 409 MIRROR_MISSING(층 검증)', r54.code === 409 && r54.body.error_code === 'MIRROR_MISSING');
  mem.gw_data['list:contract'] = mk54('list', ['STAGE_DOCS', 'STAGE_DOC_MAP', 'CON_PACKETS']);
  const auditN54 = auditMock.logs.length;
  r54 = await call({ action: 'con_proc_flag_set', use_blob: true }, tokA); T('54 켜기 → 200 · 감사 계약골조', r54.code === 200 && r54.body.use_blob === true && auditMock.logs.length === auditN54 + 1 && auditMock.logs[auditN54].ev[0].op === '계약골조');
  const at54 = r54.body.updated_at;
  r54 = await call({ action: 'con_proc_get' }, tokW, 'dev1'); T('54 켠 뒤 조회(직원) → 거울 2층 sha·flag·prev', r54.code === 200 && r54.body.flag.use_blob === true && r54.body.proc.sha === 'abcdef0123456789' && r54.body.list.layer === 'list' && r54.body.flag.prev.use_blob === false);
  r54 = await call({ action: 'con_proc_flag_set', use_blob: true }, tokA); T('54 같은 값 → 400 NO_CHANGE', r54.code === 400 && r54.body.error_code === 'NO_CHANGE');
  r54 = await call({ action: 'con_proc_flag_set', use_blob: false, base: 1 }, tokA); T('54 base 불일치 → 409 CON_PROC_STALE', r54.code === 409 && r54.body.error_code === 'CON_PROC_STALE');
  r54 = await call({ action: 'con_proc_flag_set', use_blob: false, base: at54 }, tokA); T('54 끄기(되돌리기) → 200 · prev=켬', r54.code === 200 && r54.body.use_blob === false && mem.gw_data['settings:contract'].prev.use_blob === true);
  delete mem.gw_data['settings:contract']; delete mem.gw_data['proc:contract:v1']; delete mem.gw_data['list:contract'];
}

{ // ---- 55(v401) 계약 골조 편집 clog:contract — con_proc_edit(관리자·op 6종·검증·낙관락 head·WOULD_BREAK·해시 체인·재생 유효 층·감사 계약골조편집) · con_clog_add(계약 do·값 없이 종류만·월 키 체인) ----
  const fs55 = require('fs'), dir55 = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract');
  const bp55 = join(dir55, 'blob_proc_contract_v1.json'), bl55 = join(dir55, 'blob_list_contract.json');
  if (!fs55.existsSync(bp55) || !fs55.existsSync(bl55)) { console.log('  (55 생략 — appdata 거울 파일 없음)'); fail++; }
  else {
    const P55 = JSON.parse(fs55.readFileSync(bp55, 'utf8')), L55 = JSON.parse(fs55.readFileSync(bl55, 'utf8'));
    delete mem.gw_data['settings:contract']; delete mem.gw_data['proc:contract:v1']; delete mem.gw_data['list:contract']; delete mem.gw_data['clog:contract'];
    let r55 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '계약', value: 'X' }, tokW, 'dev1'); T('55 edit 비관리자 → 403', r55.code === 403);
    r55 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '계약', value: 'X' }, tokA); T('55 거울 없이 edit → 409 MIRROR_MISSING', r55.code === 409 && r55.body.error_code === 'MIRROR_MISSING');
    mem.gw_data['proc:contract:v1'] = P55; mem.gw_data['list:contract'] = L55;
    const nDocs = Object.keys(L55.consts.STAGE_DOCS).length, nMap = L55.consts.STAGE_DOC_MAP.length, nPub = P55.consts.CON_SCEN['asbestos:pub'].length;
    r55 = await call({ action: 'con_proc_edit', op: 'nope' }, tokA); T('55 op 불량 → 400 BAD_OP', r55.code === 400 && r55.body.error_code === 'BAD_OP');
    r55 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '계약', value: 'X\nY' }, tokA); T('55 docs_set 줄바꿈 값 → 400 BAD_VALUE', r55.code === 400 && r55.body.error_code === 'BAD_VALUE');
    r55 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '계약', value: '[작성] X / [수령] Y', head: '' }, tokA);
    T('55 docs_set 계약 → 200 · head 16hex · n 1', r55.code === 200 && /^[0-9a-f]{16}$/.test(r55.body.head) && r55.body.n === 1 && r55.body.edits === 1, JSON.stringify(r55.body).slice(0, 160));
    let h1 = r55.body.head;
    const auditN55 = auditMock.logs.filter((l) => l.ev[0].op === '계약골조편집').length;
    T('55 감사 계약골조편집 1건(id=h)', auditN55 === 1 && auditMock.logs.some((l) => l.ev[0].op === '계약골조편집' && l.ev[0].id === h1 && /서류 목록 계약 수정/.test(l.ev[0].t)));
    r55 = await call({ action: 'con_proc_get' }, tokW, 'dev1');
    T('55 get(직원) → 유효 층: STAGE_DOCS.계약 바뀜 · edits 1 · base_sha=파일 sha · sha 유지 · clog n/head/chain_ok', r55.code === 200 && r55.body.list.consts.STAGE_DOCS['계약'] === '[작성] X / [수령] Y' && r55.body.list.edits === 1 && r55.body.list.base_sha === L55.sha && r55.body.list.sha === L55.sha && r55.body.clog.n === 1 && r55.body.clog.head === h1 && r55.body.clog.chain_ok === true && r55.body.edit_state.docs_set['계약'] === h1, JSON.stringify(r55.body.clog).slice(0, 200));
    T('55 base 거울 블롭은 불변(편집은 clog에만)', mem.gw_data['list:contract'].consts.STAGE_DOCS['계약'] === L55.consts.STAGE_DOCS['계약'] && mem.gw_data['clog:contract'].items.length === 1);
    r55 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '계약', value: '[작성] X / [수령] Y' }, tokA); T('55 같은 값 → 400 NO_CHANGE', r55.code === 400 && r55.body.error_code === 'NO_CHANGE');
    r55 = await call({ action: 'con_proc_edit', op: 'docs_del', key: '계약', head: 'stale' }, tokA); T('55 head 불일치 → 409 CON_PROC_STALE', r55.code === 409 && r55.body.error_code === 'CON_PROC_STALE');
    r55 = await call({ action: 'con_proc_edit', op: 'docs_del', key: '없는키' }, tokA); T('55 docs_del 없는 키 → 400 BAD_VALUE', r55.code === 400 && r55.body.error_code === 'BAD_VALUE');
    r55 = await call({ action: 'con_proc_edit', op: 'docs_del', key: '계약', head: h1 }, tokA); T('55 docs_del 계약 → 200 · p=h1 체인', r55.code === 200 && r55.body.item.p === h1 && r55.body.item.op === 'docs_del');
    const hDel = r55.body.head;
    r55 = await call({ action: 'con_proc_get' }, tokA);
    T('55 get → STAGE_DOCS 계약 없음(소프트 삭제) · edit_state.docs_del.계약=h · 키 수 -1', r55.code === 200 && !('계약' in r55.body.list.consts.STAGE_DOCS) && r55.body.edit_state.docs_del['계약'] === hDel && Object.keys(r55.body.list.consts.STAGE_DOCS).length === nDocs - 1);
    r55 = await call({ action: 'con_proc_edit', op: 'scen_del', scen: 'asbestos:pub', i: 2, name: '엉뚱' }, tokA); T('55 scen_del 이름 불일치 → 400', r55.code === 400 && r55.body.error_code === 'BAD_VALUE');
    r55 = await call({ action: 'con_proc_edit', op: 'scen_del', scen: 'asbestos:pub', i: 2, name: P55.consts.CON_SCEN['asbestos:pub'][2] }, tokA); T('55 scen_del asbestos:pub #3 → 200', r55.code === 200);
    const hScen = r55.body.head;
    r55 = await call({ action: 'con_proc_get' }, tokA);
    T('55 get → asbestos:pub 단계 -1 · 이름 빠짐 · 나머지 순서 그대로 · base 불변', r55.body.proc.consts.CON_SCEN['asbestos:pub'].length === nPub - 1 && r55.body.proc.consts.CON_SCEN['asbestos:pub'].indexOf(P55.consts.CON_SCEN['asbestos:pub'][2]) < 0 && r55.body.proc.consts.CON_SCEN['asbestos:pub'][2] === P55.consts.CON_SCEN['asbestos:pub'][3] && r55.body.edit_state.scen_del['asbestos:pub|2'].h === hScen && mem.gw_data['proc:contract:v1'].consts.CON_SCEN['asbestos:pub'].length === nPub);
    r55 = await call({ action: 'con_proc_edit', op: 'scen_del', scen: 'asbestos:pub', i: 2, name: P55.consts.CON_SCEN['asbestos:pub'][2] }, tokA); T('55 같은 단계 다시 삭제 → 400 NO_CHANGE', r55.code === 400 && r55.body.error_code === 'NO_CHANGE');
    // 마지막 단계까지 지우려 하면 WOULD_BREAK
    const wp = P55.consts.CON_SCEN['waste:pri']; let okAll = true, last = null;
    for (let i = 0; i < wp.length; i++) { last = await call({ action: 'con_proc_edit', op: 'scen_del', scen: 'waste:pri', i: i, name: wp[i] }, tokA); if (i < wp.length - 1 && last.code !== 200) okAll = false; }
    T('55 waste:pri 단계 ' + (wp.length - 1) + '개 삭제 OK · 마지막 1개 → 400 WOULD_BREAK(CON_SCEN 단계 0)', okAll && last.code === 400 && last.body.error_code === 'WOULD_BREAK' && /waste:pri/.test(last.body.detail), JSON.stringify(last.body));
    r55 = await call({ action: 'con_proc_edit', op: 'map_add', re: '(', key: '청구' }, tokA); T('55 map_add 정규식 불량 → 400 BAD_RE', r55.code === 400 && r55.body.error_code === 'BAD_RE');
    r55 = await call({ action: 'con_proc_edit', op: 'map_add', re: '실적', key: '없는키' }, tokA); T('55 map_add 없는 키 → 400', r55.code === 400 && r55.body.error_code === 'BAD_VALUE');
    r55 = await call({ action: 'con_proc_edit', op: 'map_add', re: '실적', key: '청구' }, tokA); T('55 map_add /실적/→청구 → 200', r55.code === 200);
    r55 = await call({ action: 'con_proc_edit', op: 'map_add', re: '실적', key: '청구' }, tokA); T('55 같은 정규식 다시 → 400 NO_CHANGE', r55.code === 400 && r55.body.error_code === 'NO_CHANGE');
    r55 = await call({ action: 'con_proc_get' }, tokA);
    T('55 get → MAP 맨 앞 /실적/ · 길이 +1 · $re/$flags 모양', r55.body.list.consts.STAGE_DOC_MAP.length === nMap + 1 && r55.body.list.consts.STAGE_DOC_MAP[0][0].$re === '실적' && r55.body.list.consts.STAGE_DOC_MAP[0][0].$flags === '' && r55.body.list.consts.STAGE_DOC_MAP[0][1] === '청구');
    r55 = await call({ action: 'con_proc_edit', op: 'map_del', re: '실적' }, tokA); T('55 map_del /실적/ → 200', r55.code === 200);
    r55 = await call({ action: 'con_proc_edit', op: 'map_add', re: '실적', key: '청구' }, tokA); const hRe = r55.body.head;
    let g55 = await call({ action: 'con_proc_get' }, tokA); T('55 검토 1: 삭제 뒤 같은 정규식 다시 추가 → 유효 MAP 에 /실적/ 있음 · map_del 표식 사라짐', r55.code === 200 && g55.body.list.consts.STAGE_DOC_MAP[0][0].$re === '실적' && !g55.body.edit_state.map_del['실적'] && g55.body.edit_state.map_add.length === 1);
    r55 = await call({ action: 'con_proc_edit', op: 'revert', of: hRe }, tokA); g55 = await call({ action: 'con_proc_get' }, tokA); T('55 그 추가를 되돌리면 원래 map_del 이 다시 산다(MAP 원복) · reverted_of 포함', r55.code === 200 && g55.body.list.consts.STAGE_DOC_MAP.length === nMap && !!g55.body.edit_state.map_del['실적'] && g55.body.clog.reverted_of.indexOf(hRe) >= 0);
    r55 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '__proto__', value: 'x' }, tokA); T('55 검토 6: __proto__ 키 → 400', r55.code === 400);
    r55 = await call({ action: 'con_proc_get' }, tokA); T('55 get → MAP 길이 원복 · edit_state.map_del', r55.body.list.consts.STAGE_DOC_MAP.length === nMap && !!r55.body.edit_state.map_del['실적']);
    // 되돌리기
    r55 = await call({ action: 'con_proc_edit', op: 'revert', of: hDel }, tokA); T('55 revert(docs_del) → 200', r55.code === 200);
    const hRev = r55.body.head;
    r55 = await call({ action: 'con_proc_get' }, tokA); T('55 get → 계약 키 복구(앞선 docs_set 값 유지) · reverted 2(매핑 되돌림 포함)', r55.body.list.consts.STAGE_DOCS['계약'] === '[작성] X / [수령] Y' && r55.body.clog.reverted === 2 && !r55.body.edit_state.docs_del['계약']);
    r55 = await call({ action: 'con_proc_edit', op: 'revert', of: hDel }, tokA); T('55 같은 항목 다시 revert → 400 NO_CHANGE', r55.code === 400 && r55.body.error_code === 'NO_CHANGE');
    r55 = await call({ action: 'con_proc_edit', op: 'revert', of: hRev }, tokA); T('55 revert 의 revert → 400 BAD_VALUE', r55.code === 400 && r55.body.error_code === 'BAD_VALUE');
    r55 = await call({ action: 'con_proc_edit', op: 'revert', of: 'ffffffffffffffff' }, tokA); T('55 없는 h → 400', r55.code === 400);
    // 체인 검증(실 해시 재계산) · 손상 감지
    const crypto55 = require('crypto'), doc55 = mem.gw_data['clog:contract'];
    let prev55 = '', chain = true; for (const it of doc55.items) { const e = Object.assign({}, it); delete e.h; delete e.p; const h = crypto55.createHash('sha256').update(prev55 + '|' + JSON.stringify(e)).digest('hex').slice(0, 16); if (it.p !== prev55 || it.h !== h) chain = false; prev55 = it.h; }
    T('55 clog ' + doc55.items.length + '건 해시 체인 재계산 일치 · head 일치', chain && prev55 === doc55.head);
    const saved55 = doc55.items[1].value; doc55.items[1].value = 'tamper';
    r55 = await call({ action: 'con_proc_get' }, tokA); T('55 항목 변조 → get.clog.chain_ok false', r55.body.clog.chain_ok === false); doc55.items[1].value = saved55;
    // 거울 켜기는 base 층만 보므로 편집이 있어도 켜진다
    r55 = await call({ action: 'con_proc_flag_set', use_blob: true }, tokA); T('55 편집 있어도 flag_set 켜기 → 200', r55.code === 200);
    // 건별 서류 사건 clog:contract:YYYY-MM
    const mk55 = 'clog:contract:' + new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
    delete mem.gw_data[mk55];
    r55 = await call({ action: 'con_clog_add', cid: 'c1', pipe: 'main', i: 0, k: '작성:0', act: 'done' }, tokW, 'dev1'); T('55 con_clog_add 계약 권한 없음 → 403 NO_WRITE', r55.code === 403 && r55.body.error_code === 'NO_WRITE');
    r55 = await call({ action: 'con_clog_add', cid: 'c1', pipe: 'main', i: 0, k: '작성:0', act: 'zzz' }, tokA); T('55 act 불량 → 400', r55.code === 400);
    r55 = await call({ action: 'con_clog_add', cid: 'c1', pipe: 'main', i: 0, k: '작성:0', act: 'done', n: '비밀 이름' }, tokA); T('55 con_clog_add 관리자 → 200 · 월 키 · n 1', r55.code === 200 && r55.body.key === mk55 && r55.body.n === 1);
    r55 = await call({ action: 'con_clog_add', cid: 'c1', pipe: 'main', i: 0, k: 'add:x1', act: 'add' }, tokA);
    const mdoc = mem.gw_data[mk55];
    T('55 월 clog 2건 · 체인(p=앞 h) · 값 없음(종류·좌표만) · op stage_docs', mdoc.items.length === 2 && mdoc.items[1].p === mdoc.items[0].h && mdoc.head === mdoc.items[1].h && !('n' in mdoc.items[0]) && !('name' in mdoc.items[0]) && mdoc.items[0].op === 'stage_docs' && mdoc.items[0].act === 'done' && mdoc.items[1].act === 'add', JSON.stringify(mdoc.items[0]));
    delete mem.gw_data['settings:contract']; delete mem.gw_data['proc:contract:v1']; delete mem.gw_data['list:contract']; delete mem.gw_data['clog:contract']; delete mem.gw_data[mk55];
  }
}

{ // ---- 56(v402) 계약 카드 9 신설 — 서버는 고치지 않음: added를 스위치와 무관하게 그대로 내보내고(앱이 거름), 편집 재생·scen_del이 added를 건드리지 않으며, 불량 added가 거울 전체를 죽이지 않음 ----
  const fs56 = require('fs'), dir56 = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract');
  const bp56 = join(dir56, 'blob_proc_contract_v1.json'), bl56 = join(dir56, 'blob_list_contract.json');
  if (!fs56.existsSync(bp56) || !fs56.existsSync(bl56)) { console.log('  (56 생략 — appdata 거울 파일 없음)'); fail++; }
  else {
    const P56 = JSON.parse(fs56.readFileSync(bp56, 'utf8')), L56 = JSON.parse(fs56.readFileSync(bl56, 'utf8'));
    const on56 = (x, k) => { x.added.status = 'applied'; x.added.applied = { at: '2026-11-04', by: 'servertest', basis: '56' }; x.added[k].forEach((s) => { s.active = true; }); return x; };
    const p56 = on56(JSON.parse(JSON.stringify(P56)), 'stages'), l56 = on56(JSON.parse(JSON.stringify(L56)), 'lists');
    delete mem.gw_data['settings:contract']; delete mem.gw_data['clog:contract'];
    mem.gw_data['proc:contract:v1'] = p56; mem.gw_data['list:contract'] = l56;
    let r56 = await call({ action: 'con_proc_get' }, tokW, 'dev1');
    T('56 get(직원) → added 그대로(active·schema·status·applied 보존) · flag.use_blob 꺼짐(서버는 스위치 무관 내보냄, 거름은 앱)', r56.code === 200 && JSON.stringify(r56.body.proc.added) === JSON.stringify(p56.added) && JSON.stringify(r56.body.list.added) === JSON.stringify(l56.added) && !(r56.body.flag && r56.body.flag.use_blob), JSON.stringify(r56.body.flag));
    r56 = await call({ action: 'con_proc_edit', op: 'docs_set', key: '계약', value: '[작성] A / [수령] B', head: '' }, tokA);
    const okSet56 = r56.code === 200; r56 = await call({ action: 'con_proc_get' }, tokA);
    T('56 docs_set 뒤 get → added 바이트 그대로(재생이 안 건드림) · STAGE_DOCS에 카드 9 목록 키 없음(병합은 앱 몫)', okSet56 && r56.code === 200 && JSON.stringify(r56.body.list.added) === JSON.stringify(l56.added) && !('완료신고_석면' in r56.body.list.consts.STAGE_DOCS) && r56.body.list.consts.STAGE_DOCS['계약'] === '[작성] A / [수령] B', '');
    const sc56 = P56.consts.CON_SCEN['asbestos:pri'], i56 = sc56.indexOf('청구 및 입금확인');
    r56 = await call({ action: 'con_proc_edit', op: 'scen_del', scen: 'asbestos:pri', i: i56, name: sc56[i56] }, tokA);
    const okDel56 = r56.code === 200; r56 = await call({ action: 'con_proc_get' }, tokA);
    T('56 scen_del asbestos:pri 청구 → 유효 층 CON_SCEN에서 빠짐 · added 그대로((완료)는 앱이 그 시나리오에서 건너뜀 — consheet soft)', okDel56 && r56.body.proc.consts.CON_SCEN['asbestos:pri'].length === sc56.length - 1 && JSON.stringify(r56.body.proc.added) === JSON.stringify(p56.added), String(okDel56));
    delete mem.gw_data['clog:contract'];
    const p56s = JSON.parse(JSON.stringify(p56)); p56s.added.stages = 'oops'; mem.gw_data['proc:contract:v1'] = p56s;
    r56 = await call({ action: 'con_proc_get' }, tokW, 'dev1');
    T('56 proc.added.stages 문자열이어도 층 유효 → get 200(불량 added가 거울 전체를 죽이지 않음)', r56.code === 200 && !!r56.body.proc && r56.body.proc.added.stages === 'oops', String(r56.code));
    delete mem.gw_data['settings:contract']; delete mem.gw_data['proc:contract:v1']; delete mem.gw_data['list:contract']; delete mem.gw_data['clog:contract'];
    T('56 정리: 키 4개 지움', !mem.gw_data['proc:contract:v1'] && !mem.gw_data['list:contract'] && !mem.gw_data['clog:contract'] && !mem.gw_data['settings:contract']);
  }
}

{ // ---- 57(v404) 계약 D2 기한 엔진 서버 몫 — map·bg 층 동봉(없으면 null) · bg_set 권한·판 불일치·승격·해제·연 1회 override · 스위치 토글이 bg_ver 보존 ----
  const fs57 = require('fs'), dir57 = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract');
  const bp57 = join(dir57, 'blob_proc_contract_v1.json'), bl57 = join(dir57, 'blob_list_contract.json'), bm57 = join(dir57, 'proc_map_v1.json');
  if (!fs57.existsSync(bp57) || !fs57.existsSync(bl57) || !fs57.existsSync(bm57)) { console.log('  (57 생략 — appdata 거울·map 파일 없음)'); fail++; }
  else {
    delete mem.gw_data['settings:contract']; delete mem.gw_data['clog:contract']; delete mem.gw_data['map:contract:v1']; delete mem.gw_data['bg:contract:law:v1'];
    mem.gw_data['proc:contract:v1'] = JSON.parse(fs57.readFileSync(bp57, 'utf8')); mem.gw_data['list:contract'] = JSON.parse(fs57.readFileSync(bl57, 'utf8'));
    let r57 = await call({ action: 'con_proc_get' }, tokW, 'dev1');
    T('57 get: map·bg 없음 → null 동봉 · flag.bg_ver "" · annual_override {}', r57.code === 200 && r57.body.map === null && r57.body.bg === null && r57.body.flag.bg_ver === '' && JSON.stringify(r57.body.flag.annual_override) === '{}');
    mem.gw_data['map:contract:v1'] = JSON.parse(fs57.readFileSync(bm57, 'utf8'));
    mem.gw_data['bg:contract:law:v1'] = { schema: 1, ver: 'v1-test', rows: [{ id: 'law.osh.r181-1', law: '산업안전보건법 시행규칙', art: '제181조①', mst: 288431, eff: '2026-08-01', checked: '2026-10-31', grade: '실측', days: -7, base: '작업 시작일' }], sha: 'abcdef1234567890' };
    r57 = await call({ action: 'con_proc_get' }, tokW, 'dev1'); const light57 = r57.code === 200 && r57.body.map === null && r57.body.bg === null && !!r57.body.proc;   // S4: 직원+꺼짐 → 가벼운 응답
    mem.gw_data['lawwatch:last'] = { schema: 1, date: '2026-11-03', alerts: ['[계약 배경 재확인] 개정 감지 1행'], bg_recheck: [{ id: 'law.osh.r181-1', law: '산업안전보건법 시행규칙', mst: 288431 }], ts: 1 };   // v405
    r57 = await call({ action: 'con_proc_get' }, tokA);
    const lw57 = r57.code === 200 && r57.body.lawwatch && r57.body.lawwatch.date === '2026-11-03' && r57.body.lawwatch.bg_recheck.length === 1 && r57.body.lawwatch.bg_recheck[0].id === 'law.osh.r181-1';
    T('57 get: 관리자에겐 map(scen 10키·81단계·sha)·bg(ver·rows 1)·lawwatch(bg_recheck 1, v405) 동봉 · 직원+꺼짐엔 null(S4) · 두 층 불변', light57 && lw57 && r57.code === 200 && r57.body.map && Object.keys(r57.body.map.scen).length === 10 && Object.values(r57.body.map.scen).reduce((a, b) => a + b.length, 0) === 81 && typeof r57.body.map.sha === 'string' && r57.body.bg && r57.body.bg.ver === 'v1-test' && r57.body.bg.rows.length === 1 && !!r57.body.proc && !!r57.body.list);
    r57 = await call({ action: 'con_proc_bg_set', bg_ver: 'v1-test' }, tokW, 'dev1'); const f57a = r57.code === 403;
    r57 = await call({ action: 'con_proc_bg_set', bg_ver: 'v9-none' }, tokA); const f57b = r57.code === 409 && r57.body.error_code === 'BG_MISSING';
    r57 = await call({ action: 'con_proc_bg_set', bg_ver: 'bad ver!' }, tokA); const f57c = r57.code === 400;
    r57 = await call({ action: 'con_proc_bg_set' }, tokA); const f57d = r57.code === 400 && r57.body.error_code === 'NO_CHANGE';
    T('57 bg_set: 직원 403 · 4층 판 불일치 409 BG_MISSING · 판 형식 400 · 바꿀 것 없음 400', f57a && f57b && f57c && f57d);
    const an57 = auditMock.logs.length;
    r57 = await call({ action: 'con_proc_bg_set', bg_ver: 'v1-test', base: 0 }, tokA);
    T('57 bg_set 승격: 200 · settings:contract.bg_ver v1-test · use_blob 유지(false) · 감사 계약배경', r57.code === 200 && r57.body.bg_ver === 'v1-test' && mem.gw_data['settings:contract'].bg_ver === 'v1-test' && mem.gw_data['settings:contract'].use_blob === false && auditMock.logs.length === an57 + 1 && auditMock.logs[an57].ev[0].op === '계약배경');
    const at57 = mem.gw_data['settings:contract'].updated_at;
    r57 = await call({ action: 'con_proc_flag_set', use_blob: true, base: at57 }, tokA);
    const keep57 = r57.code === 200 && mem.gw_data['settings:contract'].bg_ver === 'v1-test' && mem.gw_data['settings:contract'].use_blob === true;
    r57 = await call({ action: 'con_proc_bg_set', annual_override: { 'law.cic.23-3': '2027-02-20' } }, tokA);
    const ov57 = r57.code === 200 && mem.gw_data['settings:contract'].annual_override['law.cic.23-3'] === '2027-02-20' && mem.gw_data['settings:contract'].bg_ver === 'v1-test';
    r57 = await call({ action: 'con_proc_bg_set', annual_override: { 'law.cic.23-3': '2027-2-20' } }, tokA); const bad57 = r57.code === 400;
    r57 = await call({ action: 'con_proc_bg_set', annual_override: { 'law.cic.23-3': '2027-02-20' } }, tokA); const same57 = r57.code === 400 && r57.body.error_code === 'NO_CHANGE';   // S5: 같은 값 = 변경 없음
    r57 = await call({ action: 'con_proc_bg_set', annual_override: { 'law.cic.23-3': '' }, bg_ver: '' }, tokA);
    const off57 = r57.code === 200 && mem.gw_data['settings:contract'].bg_ver === '' && !mem.gw_data['settings:contract'].annual_override['law.cic.23-3'] && mem.gw_data['settings:contract'].prev.bg_ver === 'v1-test';
    T('57 스위치 토글이 bg_ver 보존(prev에도) · override 설정(날짜 형식 검사·같은 값 NO_CHANGE)·해제 · 승격 해제 prev.bg_ver 기록', keep57 && ov57 && bad57 && same57 && off57);
    delete mem.gw_data['settings:contract']; delete mem.gw_data['proc:contract:v1']; delete mem.gw_data['list:contract']; delete mem.gw_data['map:contract:v1']; delete mem.gw_data['bg:contract:law:v1']; delete mem.gw_data['lawwatch:last'];
  }
}

{ // ---- P1 판4 계약 법령 기준표 '확인일만 바뀐 판' 자동 이월(스위치 기본 꺼짐) — 고정물 tools/bg_law_carry_fixture.json(운영 v1-20261031 · 11월 초안 v1-20261113에서 5행) ----
  const fx = JSON.parse(require('fs').readFileSync(join(ROOT, 'tools', 'bg_law_carry_fixture.json'), 'utf8'));
  const cp = (o) => JSON.parse(JSON.stringify(o));
  const chkOnly = (src, ver) => { const g = cp(src); g.ver = ver; g.sha = 'chk' + ver.replace(/[^0-9]/g, '').padEnd(13, '0'); g.built_at = '2026-12-01T09:00:00+09:00'; g.source = 'bg_law_draft.json(DRF 재확인 2026-12-01)'; g.rows.forEach((r) => { r.checked = '2026-12-01'; }); g.rows.reverse(); return g; };   // 확인일·판 메타·행 순서만 바뀐 판
  const reset = () => { delete mem.gw_data['settings:contract']; delete mem.gw_data['bg:contract:law:v1']; delete mem.gw_data['lawwatch:last']; };
  reset();
  mem.gw_data['bg:contract:law:v1'] = cp(fx.old);
  let r = await call({ action: 'con_proc_get' }, tokA);
  const def = r.code === 200 && r.body.flag.bg_auto === false && r.body.flag.bg_fp === '' && r.body.flag.bg_carry === null;
  r = await call({ action: 'con_proc_bg_set', bg_ver: 'v1-20261031' }, tokA);
  const fp0 = mem.gw_data['settings:contract'].bg_fp;
  const prom = r.code === 200 && typeof fp0 === 'string' && /^[0-9a-f]{16}$/.test(fp0) && r.body.bg_fp === fp0 && mem.gw_data['settings:contract'].bg_auto === false;
  // 스위치 꺼짐(기본): 확인일만 바뀐 판이 올라와도 이월 없음
  mem.gw_data['bg:contract:law:v1'] = chkOnly(fx.old, 'v1-20261201');
  let au = auditMock.logs.length;
  r = await call({ action: 'con_proc_get' }, tokA);
  const offNo = r.code === 200 && r.body.flag.bg_ver === 'v1-20261031' && mem.gw_data['settings:contract'].bg_ver === 'v1-20261031' && auditMock.logs.length === au;
  T('P1 판4 기본: 스위치 꺼짐·지문 없음 → 승격 때 확인일 뺀 지문 기록(16자) · 꺼짐이면 확인일만 바뀐 판도 이월 없음(bg_ver 그대로·감사 0)', def && prom && offNo);
  // 스위치 켜기(감사·prev)
  au = auditMock.logs.length;
  r = await call({ action: 'con_proc_bg_set', bg_auto: true, base: mem.gw_data['settings:contract'].updated_at }, tokA);
  const on = r.code === 200 && r.body.bg_auto === true && mem.gw_data['settings:contract'].bg_auto === true && mem.gw_data['settings:contract'].prev.bg_auto === false && mem.gw_data['settings:contract'].bg_fp === fp0 && auditMock.logs.length === au + 1 && /자동 이월 끔→켬/.test(auditMock.logs[au].ev[0].t);
  r = await call({ action: 'con_proc_bg_set', bg_auto: 'yes' }, tokA); const badT = r.code === 400;
  r = await call({ action: 'con_proc_bg_set', bg_auto: true }, tokW, 'dev1'); const staff = r.code === 403;
  r = await call({ action: 'con_proc_bg_set', bg_auto: true }, tokA); const same = r.code === 400 && r.body.error_code === 'NO_CHANGE';
  T('P1 판4 스위치: 관리자 켜기 200(감사 1줄 끔→켬 · prev.bg_auto false · 지문 유지) · 형식 400 · 직원 403 · 같은 값 NO_CHANGE', on && badT && staff && same);
  // 켜짐 + 11월 실제 판(판만 바뀜·인용 번호·새 실측) → 이월 안 됨
  mem.gw_data['bg:contract:law:v1'] = cp(fx.nov);
  au = auditMock.logs.length;
  r = await call({ action: 'con_proc_get' }, tokA);
  const novNo = r.code === 200 && r.body.flag.bg_ver === 'v1-20261031' && r.body.flag.bg_carry === null && auditMock.logs.length === au;
  // 칸 종류별: 고정물 11월 판의 바뀐 칸을 하나씩만 옛 판에 얹은 판 — 어느 하나라도 이월 안 됨
  const one = (fn) => { const g = chkOnly(fx.old, 'v1-20261202'); fn(g.rows); return g; };
  const variants = {
    mst: one((rs) => { rs.find((x) => x.id === 'law.waste.r.18').mst = 291947; }),
    eff: one((rs) => { rs.find((x) => x.id === 'law.waste.r.18').eff = '2026-11-12'; }),
    note: one((rs) => { rs.find((x) => x.id === 'law.waste.r.60.1').note += ' · 인용 번호만 바뀜'; }),
    grade: one((rs) => { rs.find((x) => x.id === 'law.ordin.pohang.d21').grade = '실측'; }),
    days: one((rs) => { rs.find((x) => x.id === 'law.waste.r.18').days = 1; }),
    rowAdd: one((rs) => { rs.push({ id: 'law.new.1', law: '새 법', art: '제1조', mst: 1, eff: '2026-12-01', checked: '2026-12-01', grade: '실측' }); }),
    rowDel: one((rs) => { rs.pop(); }),
    idRen: one((rs) => { rs[0].id = rs[0].id + 'x'; }),
  };
  const kept = [];
  for (const k of Object.keys(variants)) { mem.gw_data['bg:contract:law:v1'] = variants[k]; r = await call({ action: 'con_proc_get' }, tokA); if (!(r.code === 200 && r.body.flag.bg_ver === 'v1-20261031')) kept.push(k); }
  T('P1 판4 11월 실제 판(그대로 1·판만 바뀜 2·인용 번호 1·새 실측 1) → 이월 안 됨(bg_ver v1-20261031 그대로·감사 0) · 칸 하나만 바뀐 판 8종(mst·eff·note·grade·days·행 추가·행 삭제·id)도 전부 안 됨', novNo && kept.length === 0, '이월된 것: ' + kept.join(','));
  // 켜짐 + 확인일만 바뀐 판(판 메타·행 순서 포함) → 이월: bg_ver 새 판·bg_carry·감사 1줄 · 다시 조회해도 감사 그대로
  mem.gw_data['bg:contract:law:v1'] = chkOnly(fx.old, 'v1-20261201');
  au = auditMock.logs.length;
  r = await call({ action: 'con_proc_get' }, tokW, 'dev1');
  const st1 = mem.gw_data['settings:contract'];
  const carried = r.code === 200 && r.body.flag.bg_ver === 'v1-20261201' && st1.bg_ver === 'v1-20261201' && st1.bg_fp === fp0 && st1.bg_carry && st1.bg_carry.from === 'v1-20261031' && st1.bg_carry.to === 'v1-20261201' && st1.prev.bg_ver === 'v1-20261031' && st1.updated_by === 'auto-carry'
    && auditMock.logs.length === au + 1 && auditMock.logs[au].ev[0].op === '계약배경' && /확인일만 바뀐 판 자동 이월 v1-20261031→v1-20261201/.test(auditMock.logs[au].ev[0].t) && auditMock.logs[au].by === '자동 이월';
  r = await call({ action: 'con_proc_get' }, tokA);
  const once = r.code === 200 && r.body.flag.bg_ver === 'v1-20261201' && auditMock.logs.length === au + 1;
  // 이월 뒤 스위치 토글(거울 켜기)도 판4 칸 보존
  mem.gw_data['settings:contract'].use_blob = true;   // 거울 층 없이 토글하려고 켜진 상태에서 끄기(켜기는 MIRROR_MISSING)
  r = await call({ action: 'con_proc_flag_set', use_blob: false }, tokA);
  const keep = r.code === 200 && mem.gw_data['settings:contract'].use_blob === false && mem.gw_data['settings:contract'].bg_fp === fp0 && mem.gw_data['settings:contract'].bg_auto === true && mem.gw_data['settings:contract'].bg_carry && mem.gw_data['settings:contract'].bg_carry.to === 'v1-20261201';
  T('P1 판4 켜짐 + 확인일만 바뀐 판(판 메타·행 순서 포함) → 승격 없이 이월(직원 조회로도 · bg_ver·bg_carry·prev·감사 \'자동 이월\' 1줄) · 다시 조회 감사 그대로 · 거울 스위치 토글이 지문·스위치·이월 기록 보존', carried && once && keep);
  // 검토 P1-3: 새 판만 이월 — 기준 확인일 bg_chk(승격 때 2026-10-31 → 이월 뒤 2026-12-01) · 옛 판 다시 올림(같은 지문 · 확인일 10-31)·같은 확인일 다른 판(12-01)·한 행만 옛 확인일(11-30) = 이월 안 함(bg_ver·감사 그대로) · 모든 행 뒤(12-15) = 이월(bg_chk 12-15 · 감사 확인일 12-01→12-15)
  const chk0 = st1.bg_chk === '2026-12-01' && st1.prev.bg_chk === '2026-10-31';
  const reup = cp(fx.old); reup.ver = 'v1-20261130';
  const sameDay = chkOnly(fx.old, 'v1-20261205');
  const mixed = chkOnly(fx.old, 'v1-20261210'); mixed.rows.forEach((x) => { x.checked = '2026-12-10'; }); mixed.rows[3].checked = '2026-11-30';
  const wrongCarry = [];   // 이월되면 안 되는데 이월된 판
  au = auditMock.logs.length;
  for (const [nm, g] of [['옛 판', reup], ['같은 확인일', sameDay], ['한 행 옛 확인일', mixed]]) { mem.gw_data['bg:contract:law:v1'] = g; r = await call({ action: 'con_proc_get' }, tokA); if (!(r.code === 200 && r.body.flag.bg_ver === 'v1-20261201' && mem.gw_data['settings:contract'].bg_ver === 'v1-20261201')) wrongCarry.push(nm); }
  const noAud = auditMock.logs.length === au;
  const newer = chkOnly(fx.old, 'v1-20261215'); newer.rows.forEach((x) => { x.checked = '2026-12-15'; });
  mem.gw_data['bg:contract:law:v1'] = newer;
  r = await call({ action: 'con_proc_get' }, tokA);
  const st2 = mem.gw_data['settings:contract'];
  const fwd = r.code === 200 && r.body.flag.bg_ver === 'v1-20261215' && st2.bg_ver === 'v1-20261215' && st2.bg_chk === '2026-12-15' && st2.prev.bg_chk === '2026-12-01' && st2.bg_carry.from === 'v1-20261201'
    && auditMock.logs.length === au + 1 && /확인일 2026-12-01→2026-12-15/.test(auditMock.logs[au].ev[0].t);
  T('P1 판4 검토(P1-3) 새 판만 이월: 기준 확인일 승격 10-31 → 이월 뒤 12-01(prev 10-31) · 옛 판 다시 올림(같은 지문·확인일 10-31)·같은 확인일 다른 판·한 행만 옛 확인일 = 이월 안 함(bg_ver v1-20261201 그대로·감사 0) · 모든 행 12-15 = 이월(bg_chk 12-15·prev 12-01·감사 "확인일 2026-12-01→2026-12-15")',
    chk0 && wrongCarry.length === 0 && noAud && fwd, JSON.stringify({ chk0, wrongCarry, noAud, fwd, flag: { ver: st2.bg_ver, chk: st2.bg_chk } }));
  // 해제(bg_ver '') 상태에선 켜져 있어도 이월 없음 · 해제 = 기준 지문 비움
  r = await call({ action: 'con_proc_bg_set', bg_ver: '' }, tokA);
  const offFp = r.code === 200 && mem.gw_data['settings:contract'].bg_fp === '' && mem.gw_data['settings:contract'].bg_ver === '';
  mem.gw_data['bg:contract:law:v1'] = chkOnly(fx.old, 'v1-20261203');
  r = await call({ action: 'con_proc_get' }, tokA);
  const unNo = r.code === 200 && r.body.flag.bg_ver === '';
  // 판4 이전 승격(지문 없음) + 켜기 = 지금 올라온 판이 승격본 그대로면 그 지문을 기준으로
  mem.gw_data['settings:contract'] = { schema: 1, use_blob: true, prev: null, bg_ver: 'v1-20261031', annual_override: {}, updated_by: 'u0', updated_at: 5 };
  mem.gw_data['bg:contract:law:v1'] = cp(fx.old);
  r = await call({ action: 'con_proc_bg_set', bg_auto: true, base: 5 }, tokA);
  const legacy = r.code === 200 && mem.gw_data['settings:contract'].bg_fp === fp0 && mem.gw_data['settings:contract'].bg_auto === true;
  T('P1 판4 승격 해제 → 지문 비움·켜져 있어도 이월 없음 · 판4 이전 승격본(지문 없음)에서 켜기 → 올라온 판이 승격본이면 같은 지문 기록', offFp && unNo && legacy);
  reset();
}

{ // ---- 58(v406) 계약 서류함 cdoc(D3 1일차) — 권한·검증·표준 파일명·중복 노출·버전/현재 포인터·초안 3판·pii 열람·reclog·소프트 삭제/복구/영구 삭제 게이트·문서함 RECORD_NOT_FOR_GIT ----
  const CONW = { id: 'uconw', name: '공무직원', admin: false, perms: { con: 'do' }, dept: '운영부' };
  const CONV = { id: 'uconv', name: '열람직원', admin: false, perms: { con: 'view' }, dept: '운영부' };
  const MGT = { id: 'umgt58', name: '관리부직원', admin: false, perms: { con: 'view' }, dept: '관리부' };
  mem.gw_users['member:uconw'] = CONW; mem.gw_users['member:uconv'] = CONV; mem.gw_users['member:umgt58'] = MGT;
  const tokC = issueSession(CONW).token, tokV = issueSession(CONV).token, tokM = issueSession(MGT).token;
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c58', title: '시험 계약', scen: 'asbestos:pub', stages: [] }, { id: 'c58del', del: 1, scen: 'asbestos:pub' }], updated_at: 1 };
  mem.gw_data['map:contract:v1'] = { schema: 1, scen: { 'asbestos:pub': [{ i: 0, name: '석면 조사', co: 'con' }, { i: 3, name: '배출신고', co: 'env' }] } };
  mem.gw_files = mem.gw_files || {};
  const b58 = (x) => Buffer.from(x).toString('base64');
  const PDF58 = b58('%PDF-1.4 cdoc test'), ZIP58 = b58(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x63, 0x64, 0x6F, 0x63])), HTML58 = b58('<html>x</html>');
  const base58 = { action: 'cdoc_put', cid: 'c58', i: 0, doc_key: 'asb_survey', kind: 'received', name: '석면조사결과서.pdf', data: PDF58 };
  let r58 = await call(Object.assign({}, base58), tokV, 'dev1'); const p1 = r58.code === 403 && r58.body.error_code === 'NO_WRITE';
  r58 = await call(Object.assign({}, base58), tokW, 'dev1'); const p2 = r58.code === 403;
  r58 = await call(Object.assign({}, base58, { cid: 'c58del' }), tokC, 'dev1'); const p3 = r58.code === 404 && r58.body.error_code === 'NO_CONTRACT';
  r58 = await call(Object.assign({}, base58, { kind: 'x' }), tokC, 'dev1'); const p4 = r58.code === 400 && r58.body.error_code === 'BAD_KIND';
  r58 = await call(Object.assign({}, base58, { pii: 3 }), tokC, 'dev1'); const p5 = r58.code === 400 && r58.body.error_code === 'BAD_PII';
  r58 = await call(Object.assign({}, base58, { name: '위장.pdf', data: HTML58 }), tokC, 'dev1'); const p6 = r58.code === 400 && r58.body.error_code === 'BAD_MAGIC';
  r58 = await call(Object.assign({}, base58, { name: '악성.exe' }), tokC, 'dev1'); const p7 = r58.code === 400 && r58.body.error_code === 'BAD_EXT';
  r58 = await call(Object.assign({}, base58, { doc_key: '__proto__' }), tokC, 'dev1'); const p8 = r58.code === 400 && r58.body.error_code === 'BAD_DOC_KEY';
  r58 = await call(Object.assign({}, base58, { name: '큰.pdf', data: 'A'.repeat(6 * 1024 * 1024 + 1) }), tokC, 'dev1'); const p9 = r58.code === 413 && r58.body.error_code === 'FILE_TOO_LARGE';
  T('58 put 거부: view 403 NO_WRITE · 권한 없음 403 · 삭제 계약 404 · kind/pii/매직/확장자/doc_key 400 · 6MB 413', p1 && p2 && p3 && p4 && p5 && p6 && p7 && p8 && p9, [p1, p2, p3, p4, p5, p6, p7, p8, p9].join());
  const an58 = auditMock.logs.length;
  r58 = await call(Object.assign({}, base58), tokC, 'dev1');
  const nm = r58.body && r58.body.name;
  const ok1 = r58.code === 200 && r58.body.n === 1 && r58.body.ver === 1 && /^Cc58_S00_asb_survey_v1_\d{8}_종운건설\.pdf$/.test(nm) && r58.body.audit === true;
  const idx58 = () => mem.gw_data['recidx:c58'];
  const f1 = mem.gw_files['cdoc:c58:S00:asb_survey:1'];
  T('58 put 200: n=1 ver=1 · 표준 파일명 C<cid>_S00_<doc_key>_v1_<날짜>_종운건설.pdf(회사=거울 map co) · gw_files cdoc:c58:S00:asb_survey:1 {name 표준, orig 원래 이름, type 고정표, sha} · recidx 항목 cur=1 · 감사 기록물등록', ok1 && f1 && f1.name === nm && f1.orig === '석면조사결과서.pdf' && f1.type === 'application/pdf' && f1.sha.length === 64 && idx58().items.length === 1 && idx58().items[0].cur === 1 && idx58().items[0].pii === 0 && auditMock.logs[an58] && auditMock.logs[an58].ev[0].op === '기록물등록', JSON.stringify(r58.body).slice(0, 220));
  r58 = await call(Object.assign({}, base58), tokC, 'dev1'); const d1 = r58.code === 409 && r58.body.error_code === 'DUP_BYTES' && r58.body.dup.length === 1 && r58.body.dup[0].n === 1;
  r58 = await call(Object.assign({}, base58, { allow_dup: true }), tokC, 'dev1'); const d2 = r58.code === 200 && r58.body.n === 2 && r58.body.ver === 2 && idx58().items[0].cur === 0 && idx58().items[1].cur === 1;
  T('58 중복: 같은 바이트 → 409 DUP_BYTES(dup 목록 노출) · allow_dup → 200 n=2 ver=2, 현재 포인터 이동(1→2)', d1 && d2);
  r58 = await call({ action: 'cdoc_put', cid: 'c58', i: 3, doc_key: 'waste_report', kind: 'final', name: '배출신고서.hwpx', data: ZIP58, pii: 1 }, tokC, 'dev1');
  const e1 = r58.code === 200 && /_종운환경\.hwpx$/.test(r58.body.name) && r58.body.n === 3; const e1b = JSON.stringify(r58.body).slice(0, 160);
  r58 = await call({ action: 'cdoc_put', cid: 'c58', i: 7, doc_key: 'x', kind: 'final', name: 'a.pdf', data: b58('%PDF-1.4 stage7') }, tokC, 'dev1');
  const e2 = r58.code === 200 && !/종운/.test(r58.body.name) && /_S07_x_v1_/.test(r58.body.name); const e2b = JSON.stringify(r58.body).slice(0, 160);
  T('58 회사 접미: 단계 co env → _종운환경 · 거울에 없는 단계 → 접미 없음', e1 && e2, JSON.stringify([e1, e1b, e2, e2b]));
  // 채움 맵 초안(파일 없이) + 최근 3판 보존
  const fp = (k) => call({ action: 'cdoc_put', cid: 'c58', i: 0, doc_key: 'asb_plan', kind: 'draft', fill: { k: k, 공사명: '시험' } }, tokC, 'dev1');
  r58 = await fp(1); const g1 = r58.code === 200 && r58.body.ver === 1 && /_v1_\d{8}_종운건설\.json$/.test(r58.body.name) && mem.gw_files['cdoc:c58:S00:asb_plan:' + r58.body.n].fill.k === 1;
  const n1 = r58.body.n; await fp(2); await fp(3); r58 = await fp(4);
  const drafts = idx58().items.filter((x) => x.dk === 'asb_plan');
  const g2 = r58.code === 200 && r58.body.ver === 4 && r58.body.gc.length === 1 && r58.body.gc[0] === n1 && !mem.gw_files['cdoc:c58:S00:asb_plan:' + n1] && drafts.length === 4 && drafts[0].gc > 0 && drafts.filter((x) => !x.gc).length === 3 && drafts[3].cur === 1;
  r58 = await call({ action: 'cdoc_put', cid: 'c58', i: 0, doc_key: 'asb_plan', kind: 'draft', fill: { big: 'x'.repeat(200 * 1024) } }, tokC, 'dev1'); const g3 = r58.code === 413 && r58.body.error_code === 'FILL_TOO_LARGE';
  T('58 채움 맵 초안: 파일 없이 fill → json 표준 이름 · 4판째에 가장 오래된 바이트 gc(색인은 남음, 보존 3판) · 200KB 초과 413', g1 && g2 && g3, JSON.stringify([g1, g2, g3, r58.code]));
  // list · get · pii · reclog
  r58 = await call({ action: 'cdoc_list', cid: 'c58' }, tokV, 'dev1'); const l1 = r58.code === 200 && r58.body.items.length === 8 && r58.body.items.every((x) => x.sha && x.sha.length === 16 && !x.data);
  mem.gw_users['member:uconh'] = { id: 'uconh', name: '숨김직원', admin: false, perms: { con: 'hide' } }; const tokH = issueSession(mem.gw_users['member:uconh']).token;
  r58 = await call({ action: 'cdoc_list', cid: 'c58' }, tokH, 'dev1'); const l2 = r58.code === 403 && r58.body.error_code === 'NO_ACCESS';
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: 1 }, tokH, 'dev1'); const l3 = r58.code === 403;
  T('58 list: view 권한 → 8항목(gc 항목 포함, 바이트 없음·sha 16) · 명시 hide는 list·get 403 NO_ACCESS(기본 view 회원은 열람 가능)', l1 && l2 && l3, JSON.stringify([l1, l2, l3, r58.code]));
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: 1 }, tokV, 'dev1'); const v1 = r58.code === 200 && r58.body.data === PDF58 && r58.body.type === 'application/pdf' && r58.body.logged === true;
  const rl = Object.keys(mem.gw_data).find((k) => k.indexOf('reclog:') === 0);
  const rlDoc = rl ? mem.gw_data[rl].items.filter((x) => x.kind !== 'tpl') : [];
  const v2 = rlDoc.length === 1 && rlDoc[0].bid === 'uconv' && rlDoc[0].cid === 'c58' && rlDoc[0].n === 1;
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: 3 }, tokV, 'dev1'); const v3 = r58.code === 403 && r58.body.error_code === 'PII_FORBIDDEN';
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: 3 }, tokC, 'dev1'); const v4 = r58.code === 200 && r58.body.data === ZIP58;
  T('58 get: view → pii 0 바이트 + reclog 1건(bid·cid·n) · pii 1은 view 403 PII_FORBIDDEN, do 200', v1 && v2 && v3 && v4, JSON.stringify([v1, v2, v3, v4]));
  r58 = await call({ action: 'cdoc_put', cid: 'c58', i: 5, doc_key: 'health', kind: 'received', name: '건진.pdf', data: b58('%PDF-1.4 health'), pii: 2 }, tokC, 'dev1'); const hn = r58.body.n;
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: hn }, tokC, 'dev1'); const h1 = r58.code === 403 && r58.body.error_code === 'PII2_FORBIDDEN';
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: hn }, tokM, 'dev1'); const h2 = r58.code === 400 && r58.body.error_code === 'REASON_REQUIRED';
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: hn, reason: '노동부 제출 확인' }, tokM, 'dev1'); const h3 = r58.code === 200 && mem.gw_data[rl].items.slice(-1)[0].reason === '노동부 제출 확인' && mem.gw_data[rl].items.slice(-1)[0].pii === 2;
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: hn, reason: '점검' }, tokA); const h4 = r58.code === 200;
  T('58 pii 2: do 직원도 403 PII2_FORBIDDEN · 관리부는 사유 없으면 400 REASON_REQUIRED, 사유 있으면 200 + reclog(reason·pii 2) · 관리자 200', h1 && h2 && h3 && h4, JSON.stringify([h1, h2, h3, h4]));
  // 소프트 삭제 → 현재 포인터 이전 판 · 휴지통 목록 · 복구 · 현재 지정 · 영구 삭제 게이트
  r58 = await call({ action: 'cdoc_del', cid: 'c58', n: 2 }, tokV, 'dev1'); const s1 = r58.code === 403;
  r58 = await call({ action: 'cdoc_del', cid: 'c58', n: 2 }, tokC, 'dev1'); const s2 = r58.code === 200 && idx58().items[1].del > 0 && idx58().items[1].cur === 0 && idx58().items[0].cur === 1 && mem.gw_files['cdoc:c58:S00:asb_survey:2'];
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: 2 }, tokC, 'dev1'); const s3 = r58.code === 404;
  r58 = await call({ action: 'cdoc_list', cid: 'c58', trash: true }, tokC, 'dev1'); const s4a = r58.code === 403 && r58.body.error_code === 'ADMIN_ONLY';
  r58 = await call({ action: 'cdoc_list', cid: 'c58', trash: true }, tokA); const s4 = s4a && r58.code === 200 && r58.body.items.length === 1 && r58.body.items[0].n === 2;
  r58 = await call({ action: 'cdoc_list', cid: 'c58' }, tokC, 'dev1'); const s5 = r58.code === 200 && !r58.body.items.some((x) => x.n === 2);
  r58 = await call({ action: 'cdoc_list', cid: 'c58', all: true }, tokA); const s5a = r58.code === 200 && r58.body.items.some((x) => x.n === 2 && x.del > 0) && r58.body.items.some((x) => x.n === 1);
  r58 = await call({ action: 'cdoc_list', cid: 'c58', all: true }, tokC, 'dev1'); const s5b = r58.code === 200 && !r58.body.items.some((x) => x.n === 2);
  T('58 v408 list all:true: 관리자는 보관 항목 포함(n=2 del) · 직원은 플래그 무시', s5a && s5b);
  r58 = await call({ action: 'cdoc_purge', cid: 'c58', n: 2, confirm: true }, tokC, 'dev1'); const s6 = r58.code === 403;
  r58 = await call({ action: 'cdoc_purge', cid: 'c58', n: 2 }, tokA); const s7 = r58.code === 400 && r58.body.error_code === 'CONFIRM_REQUIRED';
  r58 = await call({ action: 'cdoc_purge', cid: 'c58', n: 2, confirm: true }, tokA); const s8 = r58.code === 409 && r58.body.error_code === 'TOO_EARLY';
  r58 = await call({ action: 'cdoc_purge', cid: 'c58', n: 1, confirm: true }, tokA); const s9 = r58.code === 409 && r58.body.error_code === 'NOT_IN_TRASH';
  T('58 보관(소프트 삭제): view 403 · do 200 → 현재 포인터 1로, 바이트 유지, get 404, 휴지통 목록 1 · 영구 삭제: 직원 403·confirm 없음 400·30일 전 409 TOO_EARLY·휴지통 아님 409', s1 && s2 && s3 && s4 && s5 && s6 && s7 && s8 && s9, [s1, s2, s3, s4, s5, s6, s7, s8, s9].join());
  r58 = await call({ action: 'cdoc_restore', cid: 'c58', n: 2 }, tokC, 'dev1'); const t1a = r58.code === 403 && r58.body.error_code === 'ADMIN_ONLY';   // v424 검토: 복구는 관리자 보관함에서만
  r58 = await call({ action: 'cdoc_restore', cid: 'c58', n: 2 }, tokA); const t1 = t1a && r58.code === 200 && !idx58().items[1].del && idx58().items[1].cur === 0 && idx58().items[0].cur === 1;
  r58 = await call({ action: 'cdoc_cur', cid: 'c58', n: 2 }, tokC, 'dev1'); const t2 = r58.code === 200 && idx58().items[1].cur === 1 && idx58().items[0].cur === 0;
  r58 = await call({ action: 'cdoc_cur', cid: 'c58', n: 2 }, tokC, 'dev1'); const t3 = r58.code === 400 && r58.body.error_code === 'NO_CHANGE';
  idx58().items[0].del = Date.now() - 31 * 86400000; idx58().items[0].cur = 0;
  r58 = await call({ action: 'cdoc_purge', cid: 'c58', n: 1, confirm: true }, tokA);
  const t4 = r58.code === 200 && !mem.gw_files['cdoc:c58:S00:asb_survey:1'] && idx58().items[0].purged > 0 && auditMock.logs.slice(-1)[0].ev[0].op === '기록물영구삭제';
  r58 = await call({ action: 'cdoc_get', cid: 'c58', n: 1, reason: 'x' }, tokA); const t5 = r58.code === 404;
  r58 = await call({ action: 'rec_log_get' }, tokC, 'dev1'); const t6 = r58.code === 403;
  r58 = await call({ action: 'rec_log_get' }, tokA); const t7 = r58.code === 200 && r58.body.total >= 3;
  T('58 복구(현재 포인터는 기존 유지) · 현재 지정(되돌리기)·같은 값 NO_CHANGE · 31일 지난 보관본 영구 삭제 200(바이트 없음·purged·감사) · 그 뒤 get 404 · rec_log_get 관리자만', t1 && t2 && t3 && t4 && t5 && t6 && t7, [t1, t2, t3, t4, t5, t6, t7].join());
  // 문서함 분기 차단
  mem.gw_data['col:documents'] = mem.gw_data['col:documents'] || { schema: 1, items: [], updated_at: 1 };
  mem.gw_data['col:documents'].items.push({ id: 'f58', title: '계약 문서', cat: '04-03', scope: 'all', status: '등재' });
  r58 = await call({ action: 'doc_att_put', id: 'f58', name: 'Cc58_S00_asb_survey_v1_20261101_종운건설.pdf', data: PDF58 }, tokA); const u1 = r58.code === 403 && r58.body.error_code === 'RECORD_NOT_FOR_GIT' && auditMock.logs.slice(-1)[0].ev[0].op === '기록물차단';
  r58 = await call({ action: 'doc_bulk_put', cid: 'bulk58', items: [{ title: 'x', cat: '04-03', files: [{ name: 'Cc58_S03_waste_report_v1_20261101_종운환경.hwpx', data: ZIP58 }] }] }, tokA); const u2 = r58.code === 403 && r58.body.error_code === 'RECORD_NOT_FOR_GIT';
  r58 = await call({ action: 'doc_att_put', id: 'f58', name: '계약서 양식.pdf', data: PDF58 }, tokA); const u3 = r58.code === 200;
  T('58 문서함 분기 차단: 기록물 표준 이름은 doc_att_put·doc_bulk_put 403 RECORD_NOT_FOR_GIT(감사 기록물차단) · 보통 이름은 그대로 200', u1 && u2 && u3, JSON.stringify([u1, u2, u3, r58.code, r58.body.error_code]));
  delete mem.gw_data['col:contracts']; delete mem.gw_data['map:contract:v1']; delete mem.gw_data['recidx:c58']; Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:') === 0).forEach((k) => delete mem.gw_files[k]); if (rl) delete mem.gw_data[rl];
}

{ // ---- 59(v410) 계약 D4 학습 코어·diff·짝 — claude.js 재수출 · learn.js 유형 공통(블로그 불변은 절 48) · docdiff(xlsx 셀·docx 문단·목록) · cdoc_put final 훅(짝·간극·값 미저장·제외·미매칭·허용 사전 게이트) · settings:learn ----
  const CL = require(join(FN, '_lib/claude.js')), PA = require(join(FN, '_lib/promoai.js')), LN = require(join(FN, '_lib/learn.js')), DD = require(join(FN, '_lib/docdiff.js'));
  T('59 claude.js 승격: promoai가 같은 함수를 재수출(callApi·scrubPayload·responseText·ApiError) · scrubPayload 평탄화 비교 그대로 · parseJsonOut 펜스 허용',
    PA.callApi === CL.callApi && PA.scrubPayload === CL.scrubPayload && PA.responseText === CL.responseText && !CL.scrubPayload('금액 200,000원', ['200000']).ok && CL.scrubPayload('abc', ['200000']).ok
    && CL.parseJsonOut('```json\n{"a":1}\n```').a === 1 && CL.parseJsonOut('x') === null && CL.responseText({ content: [{ type: 'text', text: 'a' }, { type: 'tool', text: 'b' }] }) === 'a');
  const sc = LN.normRules({ rules: [{ text: '착공일은 계약일 +7일을 기본값으로', scope: 'field_default', field: 'start_date', n: 2, keep_id: '' }, { text: 'x', scope: 'nope', n: 1, keep_id: '' }] }, [], LN.TYPES.contract.scopes);
  T('59 learn.js 계약판: scope field_default+field 키 보존 · 모르는 scope는 style · 짝 id lc_12hex · usage 월 상한 200·usageOk/usageAdd',
    sc.length === 2 && sc[0].scope === 'field_default' && sc[0].field === 'start_date' && sc[1].scope === 'style' && LN.TYPES.contract.pair_re.test(LN.newPairId('contract', 'seed'))
    && LN.TYPES.contract.monthly_cap === 200 && LN.usageOk({ calls: 199 }, 200) && !LN.usageOk({ calls: 200 }, 200) && LN.usageAdd({ ym: '2026-11', calls: 1, tokens: 5 }, '2026-11', 7).tokens === 12 && LN.usageAdd({ ym: '2026-10', calls: 9 }, '2026-11', 1).calls === 1, JSON.stringify(sc));
  const Lg = LN.pushGap(LN.pushGap(null, { pair: 'lc_a', ratio: 0.2, comparable: true }, 10), { pair: 'lc_b', ratio: null, comparable: false }, 20);
  T('59 pushGap(모델 호출 없음): gaps 2 · stats.pairs 2 · calls 0 · gapSummary는 ratio 숫자인 것만(n 1)', Lg.gaps.length === 2 && Lg.stats.pairs === 2 && Lg.stats.calls === 0 && LN.gapSummary(Lg).n === 1 && LN.gapSummary(Lg).last5_avg === 20);
  // 내장 zip 작성기(stored) — 절 59 고정값용
  const crcT = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const mkZip = (entries) => { const locals = [], cds = []; let off = 0; for (const [name, text] of entries) { const nb = Buffer.from(name), db = Buffer.from(text), crc = crc32(db); const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(db.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42); locals.push(lh, nb, db); cds.push(cd, nb); off += 30 + nb.length + db.length; } const cdb = Buffer.concat(cds), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16); return Buffer.concat([...locals, cdb, eocd]); };
  const sheet = (cells, merged) => '<?xml version="1.0"?><worksheet xmlns="x"><sheetData><row r="1">' + cells + '</row></sheetData>' + (merged ? '<mergeCells count="1"><mergeCell ref="' + merged + '"/></mergeCells>' : '') + '</worksheet>';
  const xlsx = (cells, merged, ss) => mkZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>'], ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>'], ['xl/worksheets/sheet1.xml', sheet(cells, merged)]].concat(ss ? [['xl/sharedStrings.xml', ss]] : []));
  // 최종본: C7 공유문자열 '시험 공사' · C10 inlineStr '포항 현장 ' · E34 숫자 12.5 · H10 수식 · C12 병합 비앵커(C11:D12 안) · H8 빈칸 · A34 바뀜
  const FINAL = xlsx('<c r="C7" t="s"><v>0</v></c><c r="C10" t="inlineStr"><is><t xml:space="preserve">포항 현장 </t></is></c><c r="E34"><v>12.5</v></c><c r="H10"><f>SUM(A1)</f><v>3</v></c><c r="C11" t="inlineStr"><is><t>a</t></is></c><c r="C12" t="inlineStr"><is><t>b</t></is></c><c r="A34" t="inlineStr"><is><t>다른 현장</t></is></c>', 'C11:D12', '<sst><si><t>시험 공사</t></si></sst>');
  const EDITS = [['C7', '시험 공사', 's'], ['C10', '포항 현장', 's'], ['E34', 12.5, 'n'], ['H10', '', 'b'], ['C12', '', 'b'], ['H8', '', 'b'], ['A34', '포항 현장', 's'], ['C7', '중복', 's']];
  const dx = DD.xlsxCellDiff(EDITS, FINAL);
  // v456(T427): 초안 빈칸('b')·최종본 빈칸인 H8은 분모에서 뺀다(blank_both 1) — 종전 compared 5·ratio 0.2
  T('59 docdiff xlsx 셀: 공유문자열·inlineStr·숫자·빈칸 비교(공백 정규화) · 수식·병합 비앵커=비교 불가 2 · 바뀐 셀 1(A34) · 빈칸↔빈칸 1(H8)은 분모 밖(v456 T427) · 중복 좌표 1회 · 값은 반환에 없음',
    dx.ok && dx.compared === 4 && dx.changed === 1 && dx.uncomparable === 2 && dx.blank_both === 1 && dx.refs_changed.join() === 'A34' && dx.refs_uncomparable.sort().join() === 'C12,H10' && dx.ratio === 0.25 && JSON.stringify(dx).indexOf('포항') < 0 && JSON.stringify(dx).indexOf('시험 공사') < 0, JSON.stringify(dx));
  const docx = (paras) => mkZip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document><w:body>' + paras.map((p) => '<w:p><w:r><w:t>' + p + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>']]);
  const dd = DD.docxParaDiff(docx(['제1조 목적', '제2조 기간', '제3조 금액']), docx(['제1조 목적', '제2조 공사 기간', '제3조 금액', '제4조 특약']));
  T('59 docdiff docx 문단: LCS 같은 문단 2 · 삭제 1 · 추가 2 · 본문 미반출', dd.ok && dd.same === 2 && dd.removed === 1 && dd.added === 2 && JSON.stringify(dd).indexOf('제1조') < 0, JSON.stringify(dd));
  const ld = DD.listDiff(['착공계', '예정공정표', '현장대리인계'], [{ t: '착공계' }, { t: '예정공정표', skip: true }, { t: '안전관리계획서' }]);
  const gs = DD.gapScore(dx, ld, 1), gnull = DD.gapScore({ ok: false }, null, 0);
  T('59 listDiff·gapScore(D0): 추가 1·삭제 1·건너뜀 1 → delta 3 · score = 0.25 + 0.5·min(1,3/3) + 0.5·(1/5) = 0.85(v456 T427 — 셀 비율 0.25) · 비교 불가면 score null·comparable false',
    ld.delta === 3 && ld.removed[0] === '현장대리인계' && gs.score === 0.85 && gs.comparable && gnull.score === null && !gnull.comparable, JSON.stringify([ld, gs]));
  // ---- cdoc_put final 훅 e2e ----
  const CONW9 = { id: 'uconw9', name: '공무직원9', admin: false, perms: { con: 'do' }, dept: '운영부' };
  mem.gw_users['member:uconw9'] = CONW9; const tok9 = issueSession(CONW9).token;
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c59', title: '학습 계약', scen: 'asbestos:pub', stages: [] }], updated_at: 1 };
  mem.gw_data['map:contract:v1'] = { schema: 1, scen: { 'asbestos:pub': [{ i: 0, name: '석면 조사', co: 'con' }, { i: 2, name: '노동부 신고', co: 'con' }] } };
  mem.gw_files = mem.gw_files || {};
  const b59 = (x) => Buffer.from(x).toString('base64');
  let r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'gen.asb_plan', kind: 'draft', pii: 1, fill: { tpl: 'asb_plan', at: '2026-11-01', edits: EDITS } }, tok9, 'dev1'); const d1 = r59.code === 200;
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '석면해체계획서.xlsx', data: b59(FINAL), pii: 1 }, tok9, 'dev1');
  const L9 = r59.body.learn || {};
  const pk = Object.keys(mem.gw_data).filter((k) => k.indexOf('learn:contract:in:') === 0);
  const pair = pk.length ? mem.gw_data[pk[0]] : null;
  const les = mem.gw_data['lessons:contract:asb_plan'];
  T('59 final 훅: 짝 1건(tpl asb_plan·xlsx_cell·done_nomodel — 허용 사전 전 모델 호출 없음) · 응답 learn에 changed 1/compared 4(v456 T427 빈칸↔빈칸 뺌) · 짝 블롭에 셀 값 없음 · lessons:contract:asb_plan gaps 1·calls 0',
    r59.code === 200 && L9.ok && L9.status === 'done_nomodel' && L9.tpl === 'asb_plan' && L9.kind === 'xlsx_cell' && L9.changed === 1 && L9.compared === 4 && pk.length === 1 && pair && pair.draft_n === 1 && pair.final_n === 2 && pair.gap.score === 0.25
    && JSON.stringify(pair).indexOf('포항') < 0 && JSON.stringify(pair).indexOf('시험 공사') < 0 && les && les.gaps.length === 1 && les.stats.pairs === 1 && les.stats.calls === 0, JSON.stringify([r59.code, L9, pair && pair.status]));
  // 제외 유형(명단·검진) · 초안 없는 단계 · 초안 둘 → 미매칭(후보) · pair_tpl 지정 → 매칭
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'main.수령-1', kind: 'final', name: '근로자 명단.xlsx', data: b59(FINAL), pii: 1, allow_dup: true }, tok9, 'dev1'); const ex1 = r59.code === 200 && r59.body.learn && r59.body.learn.code === 'TYPE_EXCLUDED';
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 0, doc_key: 'main.작성-0', kind: 'final', name: '조사.pdf', data: b59('%PDF-1.4 조사'), pii: 0, allow_dup: true }, tok9, 'dev1'); const ex2 = r59.code === 200 && r59.body.learn && r59.body.learn.code === 'NO_DRAFT';   // v424 비교할 수 없는 형식 + 그 단계 초안 없음(xlsx면 내용 일치율로 찾는다 — 절 73)
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'gen.work_start', kind: 'draft', pii: 1, fill: { tpl: 'work_start', at: '2026-11-01', edits: [['C7', 'x', 's']] } }, tok9, 'dev1');
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'main.작성-1', kind: 'final', name: '착공계.pdf', data: b59('%PDF-1.4 착공'), pii: 0, allow_dup: true }, tok9, 'dev1'); const um = r59.body.learn || {};   // v424 비교할 수 없는 형식이면 종전처럼 미매칭
  const ex3 = r59.code === 200 && um.status === 'unmatched' && Array.isArray(um.candidates) && um.candidates.length === 2;
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'main.작성-1', kind: 'final', name: '착공계2.xlsx', data: b59(FINAL), pii: 0, allow_dup: true, pair_tpl: 'work_start' }, tok9, 'dev1'); const pm = r59.body.learn || {};
  const ex4 = r59.code === 200 && pm.ok && pm.tpl === 'work_start' && pm.changed === 1 && pm.compared === 1;
  T('59 제외·미매칭: 명단 파일 TYPE_EXCLUDED(짝 없음) · 초안 없는 단계 NO_DRAFT · 초안 양식 둘이면 unmatched+후보 2(자동 판단 없음) · pair_tpl 지정이면 그 초안과 짝', ex1 && ex2 && ex3 && ex4, JSON.stringify([ex1, ex2, um, pm]));
  // settings:learn — 관리자만 · on/allow 검증 · 켜고 허용하면 pending
  r59 = await call({ action: 'learn_settings_set', on: true }, tok9, 'dev1'); const s1 = r59.code === 403;
  r59 = await call({ action: 'learn_settings_get' }, tokA, 'dev1'); const s2 = r59.code === 200 && r59.body.settings.contract.on === false && r59.body.cap === 200;
  r59 = await call({ action: 'learn_settings_set', allow: { 'bad key!': ['a'] } }, tokA, 'dev1'); const s3 = r59.code === 400 && r59.body.error_code === 'BAD_TPL';
  r59 = await call({ action: 'learn_settings_set', on: true, allow: { asb_plan: ['공사명', '현장', '면적'] } }, tokA, 'dev1'); const s4 = r59.code === 200 && r59.body.settings.contract.on === true;
  r59 = await call({ action: 'learn_settings_set', on: true }, tokA, 'dev1'); const s5 = r59.code === 400 && r59.body.error_code === 'NO_CHANGE';
  r59 = await call({ action: 'cdoc_put', cid: 'c59', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '석면해체계획서2.xlsx', data: b59(FINAL), pii: 1, allow_dup: true, pair_tpl: 'asb_plan' }, tok9, 'dev1'); const s6 = r59.code === 200 && r59.body.learn && r59.body.learn.status === 'pending';
  r59 = await call({ action: 'learn_pairs_get' }, tokA, 'dev1'); const s7 = r59.code === 200 && r59.body.pairs.length === 4 && r59.body.lessons.asb_plan && r59.body.lessons.asb_plan.pairs === 2 && r59.body.lessons.asb_plan.calls === 0 && r59.body.settings.contract.on === true;
  T('59 settings:learn: 직원 403 · 기본 off·cap 200 · BAD_TPL · on+allow 저장(감사 학습설정) · 같은 값 NO_CHANGE · 허용 양식의 다음 최종본은 pending(워커 몫) · learn_pairs_get 짝 4·lessons 요약', s1 && s2 && s3 && s4 && s5 && s6 && s7 && auditMock.logs.some((e) => e.ev && e.ev[0] && e.ev[0].op === '학습설정'), JSON.stringify([s1, s2, s3, s4, s5, s6, s7, r59.code]));
  delete mem.gw_data['col:contracts']; delete mem.gw_data['map:contract:v1']; delete mem.gw_data['recidx:c59']; delete mem.gw_data['settings:learn']; delete mem.gw_data['lessons:contract:asb_plan']; delete mem.gw_data['lessons:contract:work_start'];
  Object.keys(mem.gw_data).filter((k) => k.indexOf('learn:contract:in:') === 0).forEach((k) => delete mem.gw_data[k]); Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:c59') === 0).forEach((k) => delete mem.gw_files[k]);
}

{ // ---- 60(v411) 계약 D4 3일차 — 학습 워커(허용 칸만 값 노출·LEAK_BLOCKED·월 상한·규칙 병합) · 크론 ④ 교대 기동 · 생성 주입 learn_defaults_get · piiScan·cellRows·fieldDefaults ----
  const LN = require(join(FN, '_lib/learn.js')), DD = require(join(FN, '_lib/docdiff.js'));
  T('60 piiScan: 주민번호·휴대전화·계좌(마지막 5자리↑)·4묶음 차단 · 날짜 YYYY-MM-DD·금액·면적은 통과',
    !LN.piiScan('900101-1234567').ok && !LN.piiScan('010-1234-5678').ok && !LN.piiScan('123-456-789012').ok && !LN.piiScan('1002-123-45-6789').ok && LN.piiScan('계약일 2026-11-01 금액 12,500,000원 면적 45.75').ok, '');
  const fd = LN.fieldDefaults({ rules: [{ id: 'r1', text: 'A34는 현장명', scope: 'field_default', field: 'A34', value: '포항 현장', n: 2 }, { id: 'r2', text: 'C7', scope: 'field_default', field: 'C7', value: 'x', n: 1 }, { id: 'r3', text: 'H8', scope: 'field_default', field: 'H8', value: 'y', n: 3 }] }, ['A34', 'C7']);
  T('60 fieldDefaults: 허용 칸·근거 2건↑·값 있는 field_default만 → {A34} (C7은 n 1, H8은 허용 밖)', Object.keys(fd).join() === 'A34' && fd.A34 === '포항 현장', JSON.stringify(fd));
  // 고정값(절 59와 같은 zip 작성기)
  const crcT = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const mkZip = (entries) => { const locals = [], cds = []; let off = 0; for (const [name, text] of entries) { const nb = Buffer.from(name), db = Buffer.from(text), crc = crc32(db); const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(db.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42); locals.push(lh, nb, db); cds.push(cd, nb); off += 30 + nb.length + db.length; } const cdb = Buffer.concat(cds), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16); return Buffer.concat([...locals, cdb, eocd]); };
  const xlsx2 = (s1, s2) => mkZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook><sheets><sheet name="1.공사개요" sheetId="1" r:id="rId1"/><sheet name="3" sheetId="2" r:id="rId2"/></sheets></workbook>'], ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>'], ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1">' + s1 + '</row></sheetData></worksheet>'], ['xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1">' + s2 + '</row></sheetData></worksheet>']]);
  const is = (r, v) => '<c r="' + r + '" t="inlineStr"><is><t xml:space="preserve">' + v + '</t></is></c>';
  const FINAL60 = xlsx2(is('C7', '시험 공사') + is('C10', '포항 현장') + is('A34', '다른 현장') + '<c r="E34"><v>12.5</v></c>' + is('H8', '손으로 채운 값'), is('E70', '홍길동') + is('K99', '비고'));
  const EDITS60 = [['C7', '시험 공사', 's'], ['C10', '포항 현장', 's'], ['A34', '포항 현장', 's'], ['E34', 12.5, 'n'], ['H8', '', 'b'], ['3!E70', '', 'b'], ['3!K99', '', 'b'], ['__drop_drawings__', 1, 's']];
  const cr = DD.cellRows(EDITS60, FINAL60, ['C7', 'H8', '3!K99']);
  T('60 cellRows(다중 시트): 허용 칸 3만 값(visible) · 허용 밖은 바뀜 좌표만(A34·3!E70, 값 없음) · 특수 항목 무시 · 안 바뀐 수 2(C10·E34)',
    cr.ok && cr.rows.length === 3 && cr.rows.map((r) => r.ref).join() === 'C7,H8,3!K99' && cr.hidden_changed.join() === 'A34,3!E70' && cr.hidden_same_n === 2 && JSON.stringify(cr).indexOf('홍길동') < 0 && JSON.stringify(cr).indexOf('다른 현장') < 0, JSON.stringify(cr));
  const dx2 = DD.xlsxCellDiff(EDITS60, FINAL60);
  T('60 xlsxCellDiff 다중 시트: 3!E70·3!K99 비교(바뀜 2) · 시트 없는 좌표는 비교 불가', dx2.compared === 7 && dx2.changed === 4 && dx2.refs_changed.join() === 'A34,H8,3!E70,3!K99' && DD.xlsxCellDiff([['없는시트!A1', 'x', 's']], FINAL60).uncomparable === 1, JSON.stringify(dx2));
  // ---- 워커 e2e ----
  const CONW0 = { id: 'uconw0', name: '공무직원0', admin: false, perms: { con: 'do' }, dept: '운영부' }; mem.gw_users['member:uconw0'] = CONW0; const tok0 = issueSession(CONW0).token;
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c60', title: '학습 계약', scen: 'asbestos:pub', stages: [], bid_id: 'R26BK0000' }], updated_at: 1 };
  mem.gw_data['map:contract:v1'] = { schema: 1, scen: { 'asbestos:pub': [{ i: 2, name: '노동부 신고', co: 'con' }] } };
  mem.gw_files = mem.gw_files || {};
  const b60 = (x) => Buffer.from(x).toString('base64');
  let r60 = await call({ action: 'learn_settings_set', on: true, allow: { asb_plan: ['C7', 'H8', '3!K99'] } }, tokA, 'dev1'); const w0 = r60.code === 200;
  r60 = await call({ action: 'cdoc_put', cid: 'c60', i: 2, doc_key: 'gen.asb_plan', kind: 'draft', pii: 1, fill: { tpl: 'asb_plan', at: '2026-11-01', edits: EDITS60 } }, tok0, 'dev1');
  r60 = await call({ action: 'cdoc_put', cid: 'c60', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '석면해체계획서.xlsx', data: b60(FINAL60), pii: 1 }, tok0, 'dev1');
  const pid60 = r60.body.learn && r60.body.learn.id; const w1 = r60.code === 200 && r60.body.learn.status === 'pending';
  const worker60 = require(join(FN, 'gw-learn-background.js'));
  const savedKey60 = process.env.GW_ANTHROPIC_KEY, savedUrl60 = process.env.URL, realFetch60 = global.fetch;
  process.env.GW_ANTHROPIC_KEY = 'test-anthropic-key-0000'; process.env.URL = 'https://test.local';
  const api60 = [];
  global.fetch = async (url, opt) => {
    const b = JSON.parse(opt.body || '{}'); api60.push({ url: String(url), user: ((b.messages && b.messages[0] && b.messages[0].content[0].text) || ''), body: b });
    const text = JSON.stringify({ summary: 'H8은 매번 같은 값으로 채워졌다', changes: [{ kind: 'field_default', what: 'H8 기본값' }], rules: [{ text: 'H8 칸은 처음부터 "손으로 채운 값"으로 채운다', scope: 'field_default', n: 2, keep_id: '', field: 'H8', value: '손으로 채운 값' }, { text: 'E34 칸은 직원이 자주 고친다', scope: 'content', n: 1, keep_id: '', field: '', value: '' }, { text: '전화 010-1111-2222로 연락', scope: 'content', n: 1, keep_id: '', field: '', value: '' }, { text: 'A34에 값을 넣는다', scope: 'field_default', n: 2, keep_id: '', field: 'A34', value: '추측값' }] });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: b.model, stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text: text }] }) };
  };
  const tokIn60 = issueSession({ id: '__promoai__', role: 'system' }).token;
  const ev60 = (body, tok) => ({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
  await worker60.handler(ev60({ pair_id: pid60 }, tokA), {}); const w2 = mem.gw_data['learn:contract:in:' + pid60].status === 'pending' && api60.length === 0;
  await worker60.handler(ev60({ pair_id: pid60 }, tokIn60), {});
  const P60 = mem.gw_data['learn:contract:in:' + pid60], L60 = mem.gw_data['lessons:contract:asb_plan'], U60 = mem.gw_data['usage:learn:contract:' + LN.ymOf(Date.now())];
  const u = api60.length === 1 ? api60[0].user : '';
  const w3 = P60.status === 'done' && P60.rules_n === 2 && P60.visible_n === 3 && P60.hidden_changed_n === 2 && u.indexOf('손으로 채운 값') > 0 && u.indexOf('시험 공사') > 0 && u.indexOf('홍길동') < 0 && u.indexOf('다른 현장') < 0 && u.indexOf('12.5') < 0 && /바뀐 칸: A34, 3!E70/.test(u);
  const w4 = L60 && L60.rules.length === 2 && L60.rules.some((r) => r.scope === 'field_default' && r.field === 'H8' && r.value === '손으로 채운 값' && r.n === 2) && !L60.rules.some((r) => /010-1111/.test(r.text)) && !L60.rules.some((r) => r.field === 'A34') && L60.stats.calls === 1 && U60 && U60.calls === 1 && U60.tokens === 580;
  T('60 학습 워커: 사용자 토큰 거부 · 허용 칸(C7·H8·3!K99)만 값이 프롬프트에, 허용 밖은 좌표만(이름·숫자 미노출) · 결과 재검사(전화번호 규칙 버림·허용 밖 칸 field_default 버림 → 모델 규칙 4 중 2) · lessons 규칙 2·calls 1 · usage 1회 580토큰', w0 && w1 && w2 && w3 && w4, JSON.stringify([w0, w1, w2, w3, w4, P60.status, P60.code, L60 && L60.rules.map((r) => r.field || r.scope)]));
  // 생성 주입 — 허용 칸 H8 근거 2 → defaults {H8} · 스위치 끄면 {}
  r60 = await call({ action: 'learn_defaults_get', tpl: 'asb_plan' }, tok0, 'dev1'); const i1 = r60.code === 200 && r60.body.on && r60.body.defaults.H8 === '손으로 채운 값' && Object.keys(r60.body.defaults).length === 1;
  r60 = await call({ action: 'learn_settings_set', on: false }, tokA, 'dev1');
  r60 = await call({ action: 'learn_defaults_get', tpl: 'asb_plan' }, tok0, 'dev1'); const i2 = r60.code === 200 && r60.body.on === false && Object.keys(r60.body.defaults).length === 0;
  r60 = await call({ action: 'learn_settings_set', on: true }, tokA, 'dev1');
  T('60 생성 주입 learn_defaults_get: 허용 칸·근거 2건 → {H8} · 스위치 끄면 {} (앱은 공란 칸에만 넣고 fill.learned에 기록)', i1 && i2, JSON.stringify([i1, i2]));
  // LEAK_BLOCKED — 허용 칸에 전화번호 · 월 상한 hold
  const FINAL61 = xlsx2(is('C7', '시험 공사') + is('H8', '담당 010-9999-8888'), '');
  r60 = await call({ action: 'cdoc_put', cid: 'c60', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '석면해체계획서b.xlsx', data: b60(FINAL61), pii: 1, allow_dup: true }, tok0, 'dev1'); const pid61 = r60.body.learn.id;
  await worker60.handler(ev60({ pair_id: pid61 }, tokIn60), {}); const k1 = mem.gw_data['learn:contract:in:' + pid61].status === 'fail' && mem.gw_data['learn:contract:in:' + pid61].code === 'LEAK_BLOCKED' && api60.length === 1;
  mem.gw_data['usage:learn:contract:' + LN.ymOf(Date.now())] = { ym: LN.ymOf(Date.now()), calls: 200, tokens: 1 };
  r60 = await call({ action: 'cdoc_put', cid: 'c60', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '석면해체계획서c.xlsx', data: b60(FINAL60), pii: 1, allow_dup: true }, tok0, 'dev1'); const pid62 = r60.body.learn.id;
  await worker60.handler(ev60({ pair_id: pid62 }, tokIn60), {}); const k2 = mem.gw_data['learn:contract:in:' + pid62].status === 'hold' && mem.gw_data['learn:contract:in:' + pid62].code === 'USAGE_CAP' && api60.length === 1;
  delete mem.gw_data['usage:learn:contract:' + LN.ymOf(Date.now())];
  T('60 차단: 허용 칸에 전화번호 → LEAK_BLOCKED(호출 0) · 월 상한 200 도달 → hold USAGE_CAP(호출 0)', k1 && k2, JSON.stringify([k1, k2]));
  // 크론 ④ 교대 — 블로그 짝 없음 → 계약 pending 1건 기동(URL gw-learn-background)
  const cron60 = require(join(FN, 'gw-promo-ai-cron.js'));
  mem.gw_data['learn:contract:in:' + pid62].status = 'pending'; mem.gw_data['learn:contract:in:' + pid62].tries = 0; delete mem.gw_data['learn:contract:lock'];
  const kicks60 = []; global.fetch = async (url, opt) => { kicks60.push({ url: String(url), body: JSON.parse(opt.body || '{}') }); return { ok: true, status: 202 }; };
  const st60 = blobsMock.store('gw_data');
  const kc = await cron60.kickLearnContract(st60, Date.now());
  const kc2 = await cron60.kickLearnContract(st60, Date.now());   // running(15분 미만)은 다시 집지 않는다
  mem.gw_data['learn:contract:lock'] = { ts: Date.now(), pair: pid62 };   // 워커가 잠근 동안
  const kc3 = await cron60.kickLearnContract(st60, Date.now());
  T('60 크론 ④ 교대: 계약 pending 1건 → gw-learn-background 기동 · running·tries 1 · 다음 회차 pending 0 · 잠금 중이면 skipped', kc.started === pid62 && kicks60.length === 1 && /gw-learn-background$/.test(kicks60[0].url) && kicks60[0].body.pair_id === pid62 && mem.gw_data['learn:contract:in:' + pid62].status === 'running' && mem.gw_data['learn:contract:in:' + pid62].tries === 1 && kc2.pending === 0 && kc3.skipped === 'running', JSON.stringify([kc, kc2, kc3, kicks60.length]));
  global.fetch = realFetch60; process.env.GW_ANTHROPIC_KEY = savedKey60; process.env.URL = savedUrl60;
  delete mem.gw_data['col:contracts']; delete mem.gw_data['map:contract:v1']; delete mem.gw_data['recidx:c60']; delete mem.gw_data['settings:learn']; delete mem.gw_data['lessons:contract:asb_plan']; delete mem.gw_data['learn:contract:lock'];
  Object.keys(mem.gw_data).filter((k) => k.indexOf('learn:contract:in:') === 0).forEach((k) => delete mem.gw_data[k]); Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:c60') === 0).forEach((k) => delete mem.gw_files[k]);
}

{ // ---- 61(v412) 계약 D4 4일차 — 기준선 동결·일몰 판정(순수)·크론 일몰 훑기(하루 1회)·양식별 끄기/켜기 learn_tpl_set ----
  const LN = require(join(FN, '_lib/learn.js'));
  const DAY = 86400000; const now61 = Date.UTC(2026, 10, 1, 3, 0, 0);   // 2026-11-01 12:00 KST 고정(날짜 경계 무관)
  // 기준선: 10건째에 동결(첫 10건 평균), 그 뒤 간극은 기준선을 바꾸지 않는다
  let L = null; for (let i = 0; i < 12; i++) { L = LN.pushGap(L, { pair: 'p' + i, promo_id: 'c', ratio: i < 10 ? 0.5 : 0.1, score: 0.5 }, now61 - (40 - i) * DAY); LN.freezeBaseline(L, now61 - (40 - i) * DAY); }
  const L9 = (() => { let x = null; for (let i = 0; i < 9; i++) { x = LN.pushGap(x, { ratio: 0.5 }, now61); LN.freezeBaseline(x, now61); } return x; })();
  const Lb = LN.pushGap(null, { ratio: 0.5 }, now61);
  T('61 기준선 동결: 10건째 평균 50%·n 10·first_ts=1건째 · 11·12건째(10%)는 기준선 불변 · 9건은 기준선 없음 · 블로그 경로(pushGap만)엔 baseline 키 없음',
    L.baseline && L.baseline.n === 10 && Math.abs(L.baseline.avg - 0.5) < 1e-9 && L.baseline.first_ts === now61 - 40 * DAY && L.baseline.ts === now61 - 31 * DAY && L.gaps.length === 12 && !L9.baseline && !('baseline' in Lb) && !('sunset' in LN.normLessons(Lb)), JSON.stringify([L.baseline, Object.keys(Lb)]));
  // 일몰 판정(순수)
  const mk = (o) => Object.assign({ schema: 1, off: false, rules: [], exemplars: {}, gaps: [], stats: { pairs: 0, calls: 1, tokens: 0 } }, o);
  const gapsAfter = (n, ratio, from) => Array.from({ length: n }, (_, i) => ({ ratio: ratio, ts: from + i * DAY }));
  const base = { avg: 0.5, n: 10, first_ts: now61 - 40 * DAY, ts: now61 - 30 * DAY };
  const c1 = LN.sunsetCheck(mk({ stats: { calls: 0 }, baseline: base, gaps: gapsAfter(10, 0.6, now61 - 20 * DAY) }), now61);
  const c2 = LN.sunsetCheck(mk({ gaps: gapsAfter(12, 0.5, now61 - 12 * DAY) }), now61);
  const c3 = LN.sunsetCheck(mk({ baseline: Object.assign({}, base, { first_ts: now61 - 20 * DAY, ts: now61 - 10 * DAY }), gaps: gapsAfter(10, 0.6, now61 - 9 * DAY) }), now61);
  const c4 = LN.sunsetCheck(mk({ baseline: base, gaps: gapsAfter(3, 0.6, now61 - 20 * DAY) }), now61);
  const c5 = LN.sunsetCheck(mk({ baseline: base, gaps: gapsAfter(10, 0.6, now61 - 20 * DAY) }), now61);
  const c6 = LN.sunsetCheck(mk({ baseline: base, gaps: gapsAfter(10, 0.3, now61 - 20 * DAY) }), now61);
  const c7 = LN.sunsetCheck(mk({ off: true, baseline: base, gaps: gapsAfter(10, 0.6, now61 - 20 * DAY) }), now61);
  const c8 = LN.sunsetCheck(mk({ baseline: base, gaps: gapsAfter(5, 0.5, now61 - 35 * DAY).concat(gapsAfter(10, 0.5, now61 - 20 * DAY)) }), now61);   // 기준선 전 간극은 최근에 안 든다 · 같으면 due
  T('61 sunsetCheck: 호출 0=no_calls · 기준선 없음=no_baseline · 4주 전=too_early · 기준선 뒤 5건 미만=too_few · 60%≥50%=due(not_improved) · 30%<50%=improving · 이미 off=already_off · 기준선 전 간극 제외·같으면 due',
    c1.why === 'no_calls' && c2.why === 'no_baseline' && c3.why === 'too_early' && c4.why === 'too_few' && c4.n_recent === 3 && c5.due === true && c5.why === 'not_improved' && Math.abs(c5.recent_avg - 0.6) < 1e-9 && c5.n_recent === 10 && c6.due === false && c6.why === 'improving' && c7.why === 'already_off' && c8.due === true && c8.n_recent === 10 && !c1.due && !c2.due && !c3.due && !c4.due && !c7.due, JSON.stringify([c1.why, c2.why, c3.why, c4.why, c5, c6.why, c7.why, c8.why]));
  // 크론 일몰 훑기 e2e — 짝 2건(asb_plan·demo_report) + lessons(기준선 30일 전·최근 10건, calls 1) → asb_plan만 off+sunset · 같은 날 2회차 done_today · 다음 날 재훑기
  const cron61 = require(join(FN, 'gw-promo-ai-cron.js')); const st61 = blobsMock.store('gw_data');
  mem.gw_data['learn:contract:in:lc_aaaaaaaa0061'] = { id: 'lc_aaaaaaaa0061', cid: 'c61', i: 2, dk: 'main.작성-0', tpl: 'asb_plan', draft_n: 1, final_n: 1, kind: 'xlsx_cell', status: 'done_nomodel', ts: now61 - DAY, by: 'u' };
  mem.gw_data['learn:contract:in:lc_aaaaaaaa0062'] = { id: 'lc_aaaaaaaa0062', cid: 'c61', i: 3, dk: 'main.작성-1', tpl: 'demo_report', draft_n: 1, final_n: 1, kind: 'xlsx_cell', status: 'done_nomodel', ts: now61 - DAY, by: 'u' };
  mem.gw_data['lessons:contract:asb_plan'] = mk({ baseline: base, gaps: gapsAfter(10, 0.6, now61 - 20 * DAY), rules: [{ id: 'r1', text: 't', scope: 'style', n: 1 }] });
  mem.gw_data['lessons:contract:demo_report'] = mk({ baseline: base, gaps: gapsAfter(10, 0.2, now61 - 20 * DAY) });
  delete mem.gw_data['learn:contract:sunset']; delete mem.gw_data['learn:contract:lock'];
  const k1 = await cron61.kickLearnContract(st61, now61);
  const LA = mem.gw_data['lessons:contract:asb_plan'], LD = mem.gw_data['lessons:contract:demo_report'];
  const stamp1 = JSON.parse(JSON.stringify(mem.gw_data['learn:contract:sunset'] || {}));   // k3가 다음 날로 덮기 전 값
  const k2 = await cron61.kickLearnContract(st61, now61 + 3600000);
  const k3 = await cron61.kickLearnContract(st61, now61 + DAY + 3600000);
  T('61 크론 일몰 훑기: asb_plan off+sunset(auto, 기준 50%→최근 60%) · demo_report(20%)는 그대로 · 규칙 보존 · 같은 날 2회차 done_today · 다음 날 재훑기(already_off·improving) · pending 0',
    k1.pending === 0 && k1.sunset && k1.sunset.off.join() === 'asb_plan' && k1.sunset.checked.length === 2 && LA.off === true && LA.sunset && LA.sunset.by === 'auto' && Math.abs(LA.sunset.base_avg - 0.5) < 1e-9 && Math.abs(LA.sunset.recent_avg - 0.6) < 1e-9 && LA.rules.length === 1 && LD.off === false && !LD.sunset
    && stamp1.day === '2026-11-01' && stamp1.off.join() === 'asb_plan' && k2.sunset && k2.sunset.skipped === 'done_today' && k3.sunset && k3.sunset.day === '2026-11-02' && k3.sunset.off.length === 0 && k3.sunset.checked.some((c) => c.tpl === 'asb_plan' && c.why === 'already_off') && k3.sunset.checked.some((c) => c.tpl === 'demo_report' && c.why === 'improving'), JSON.stringify([k1.sunset, k2.sunset, k3.sunset]));
  // 양식별 켜기/끄기(관리자) — 켜면 sunset 기록은 남고(reset_ts) 기준선은 비워 시계 재시작 · 같은 값 NO_CHANGE · 직원 403 · 카드 조회에 sunset·baseline
  const W61 = { id: 'ucon61', name: '공무직원61', admin: false, perms: { con: 'do' }, dept: '운영부' }; mem.gw_users['member:ucon61'] = W61; const tok61 = issueSession(W61).token;
  let r61 = await call({ action: 'learn_tpl_set', tpl: 'asb_plan', off: false }, tok61, 'dev1'); const t1 = r61.code === 403;
  r61 = await call({ action: 'learn_tpl_set', tpl: 'asb_plan', off: true }, tokA, 'dev1'); const t2 = r61.code === 400 && r61.body.error_code === 'NO_CHANGE';
  r61 = await call({ action: 'learn_tpl_set', tpl: 'bad tpl!', off: false }, tokA, 'dev1'); const t3 = r61.code === 400 && r61.body.error_code === 'BAD_TPL';
  r61 = await call({ action: 'learn_tpl_set', tpl: 'asb_plan', off: 'no' }, tokA, 'dev1'); const t3b = r61.code === 400 && r61.body.error_code === 'BAD_VALUE';
  r61 = await call({ action: 'learn_tpl_set', tpl: 'asb_plan', off: false }, tokA, 'dev1'); const LA2 = mem.gw_data['lessons:contract:asb_plan'];
  const t4 = r61.code === 200 && r61.body.off === false && r61.body.baseline === null && LA2.off === false && LA2.sunset && LA2.sunset.by === 'auto' && LA2.sunset.reset_ts > 0 && LA2.sunset.reset_by === ADMIN.id && !LA2.baseline && LA2.rules.length === 1;
  r61 = await call({ action: 'learn_tpl_set', tpl: 'demo_report', off: true }, tokA, 'dev1'); const LD2 = mem.gw_data['lessons:contract:demo_report'];
  const t5 = r61.code === 200 && LD2.off === true && LD2.sunset && LD2.sunset.manual === true && LD2.sunset.by === ADMIN.id && LD2.baseline && LD2.baseline.n === 10;
  r61 = await call({ action: 'learn_pairs_get' }, tokA, 'dev1');
  const la = r61.code === 200 ? r61.body.lessons.asb_plan : null, ld = r61.code === 200 ? r61.body.lessons.demo_report : null;
  const t6 = la && la.off === false && la.sunset && la.sunset.reset_ts > 0 && la.baseline === null && ld && ld.off === true && ld.sunset.manual === true && ld.baseline && ld.baseline.n === 10;
  T('61 learn_tpl_set: 직원 403 · 같은 값 NO_CHANGE · BAD_TPL · BAD_VALUE · 켜기=off false+reset_ts+기준선 비움(규칙·sunset 보존) · 수동 끄기=sunset.manual(기준선 유지) · learn_pairs_get에 sunset·baseline · 감사 학습설정',
    t1 && t2 && t3 && t3b && t4 && t5 && t6 && auditMock.logs.some((e) => e.ev && e.ev[0] && e.ev[0].op === '학습설정' && /asb_plan 학습 켬/.test(e.ev[0].t)), JSON.stringify([t1, t2, t3, t3b, t4, t5, t6, r61.code]));
  delete mem.gw_data['lessons:contract:asb_plan']; delete mem.gw_data['lessons:contract:demo_report']; delete mem.gw_data['learn:contract:sunset']; delete mem.gw_data['learn:contract:in:lc_aaaaaaaa0061']; delete mem.gw_data['learn:contract:in:lc_aaaaaaaa0062']; delete mem.gw_users['member:ucon61'];
}

{ // ---- 62(v413) 결재 C2-1 — [내 것 아님] task_notmine · clog:appr 학습 신호 · lessons:appr 집계(모델 없음) · save 보호 ----
  const AL = require(join(FN, '_lib/apprlearn.js'));
  // 순수 집계
  const rows62 = [
    { f: 'who_id', why: 'notmine', p: 'veh:', by: 'u1' }, { f: 'who_id', why: 'notmine', p: 'veh:', by: 'u1' }, { f: 'who_id', why: 'notmine', p: 'veh:', by: 'u1' },
    { f: 'who_id', why: 'notmine', p: 'lic:', by: 'u1' }, { f: 'who_id', why: 'notmine', p: 'lic:', by: 'u2' },
    { f: 'who_id', why: 'notmine', p: 'rec:', by: 'u1' }, { f: 'who_id', why: 'edit', p: 'rec:', by: 'ua' },
    { f: 'due', why: 'edit', p: 'cert:', d: 7, by: 'ua' }, { f: 'due', why: 'edit', p: 'cert:', d: 30, by: 'ua' }, { f: 'due', why: 'edit', p: 'cert:', d: 10, by: 'ua' }, { f: 'due', why: 'edit', p: 'cert:', by: 'ua' },
    { f: 'del', why: 'edit', p: 'bid:', by: 'ua' }, { f: 'status', why: 'data:x', by: '앱 기준' }, null,
  ];
  const L62 = AL.tally(rows62, '2026-11');
  T('62 tally: veh 3건 1인=재카드 · lic 2건 2인=재카드 · rec 1건+담당 변경 1=재카드 아님 · cert 기한 변경 4(일수 3건, 중앙값 10)=리드 규칙 · bid 삭제 1 · p 없는 행 무시 · 규칙 3',
    L62.prefixes['veh:'].notmine === 3 && L62.prefixes['veh:'].notmine_who_n === 1 && L62.prefixes['veh:'].recard === true && L62.prefixes['lic:'].recard === true && L62.prefixes['lic:'].notmine_who_n === 2
    && L62.prefixes['rec:'].recard === false && L62.prefixes['rec:'].who_edit === 1 && L62.prefixes['cert:'].due_edit === 4 && L62.prefixes['cert:'].due_med === 10 && L62.prefixes['bid:'].del === 1 && !L62.prefixes[''] && L62.rules.length === 3
    && L62.rules.map((r) => r.id).join() === 'recard:lic::2026-11,recard:veh::2026-11,lead:cert::2026-11' && /R1 재카드/.test(L62.rules[0].text) && /\+10일/.test(L62.rules[2].text) && !('_who' in L62.prefixes['veh:']) && !('_days' in L62.prefixes['cert:']), JSON.stringify(L62).slice(0, 300));
  T('62 prefixOf·dayDiff', AL.prefixOf('veh:12:ins:2026-11-30') === 'veh:' && AL.prefixOf('nocolon') === '' && AL.dayDiff('2026-11-01', '2026-11-08') === 7 && AL.dayDiff('2026-11-08', '2026-11-01') === -7 && AL.dayDiff('', '2026-11-01') === null, '');
  // e2e — 직원 uwork가 담당인 자동 지시 3건 + 수동 지시 1건 + 타인 담당 1건
  const W2 = { id: 'uwork2', name: '직원2', admin: false, perms: { tasks: 'do' } }; mem.gw_users['member:uwork2'] = W2; const tokW2 = issueSession(W2).token;
  const mk62 = (id, key, who, extra) => Object.assign({ id: id, title: '지시 ' + id, auto_key: key, who_id: who, who: who ? '직원' : '', who_by: who ? 'assign' : '', status: 'open', from: '자동', due: '2026-11-30', created: '2026-11-01' }, extra || {});
  mem.gw_data['col:tasks'] = { schema: 1, items: [mk62('t62a', 'veh:1:ins:2026-11-30', 'uwork'), mk62('t62b', 'veh:2:ins:2026-11-30', 'uwork'), mk62('t62c', 'veh:3:ins:2026-11-30', 'uwork'), mk62('t62m', '', 'uwork'), mk62('t62o', 'lic:9:exp:2026-12-01', 'uwork2'), mk62('t62d', 'veh:4:ins:2026-11-30', 'uwork', { status: 'done' })], updated_at: 1000 };
  const ym62 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
  delete mem.gw_data['clog:appr:' + ym62]; delete mem.gw_data['lessons:appr'];
  mem.gw_data['settings:assign'] = { schema: 1, rules: { 'veh:': { who_id: 'uwork' } }, approver_id: '', prev: null, updated_at: 5, updated_by: 'uadmin' };   // 배정표 veh:→uwork(되채움 시험)
  let r62 = await call({ action: 'task_notmine', id: 't62m' }, tokW, 'dev1'); const n1 = r62.code === 400 && r62.body.error_code === 'NOT_AUTO';
  r62 = await call({ action: 'task_notmine', id: 't62o' }, tokW, 'dev1'); const n2 = r62.code === 403 && r62.body.error_code === 'NOT_ASSIGNEE';
  r62 = await call({ action: 'task_notmine', id: 't62a' }, tokA, 'dev1'); const n3 = r62.code === 403;   // 관리자여도 담당 본인이 아니면 안 됨(관리자는 [수정])
  r62 = await call({ action: 'task_notmine', id: 't62d' }, tokW, 'dev1'); const n4 = r62.code === 400 && r62.body.error_code === 'TASK_DONE';
  r62 = await call({ action: 'task_notmine', id: 'none' }, tokW, 'dev1'); const n5 = r62.code === 404;
  const auditN62 = auditMock.logs.length;
  r62 = await call({ action: 'task_notmine', id: 't62a' }, tokW, 'dev1');
  const ta = mem.gw_data['col:tasks'].items.find((x) => x.id === 't62a'); const cl1 = mem.gw_data['clog:appr:' + ym62];
  const n6 = r62.code === 200 && r62.body.task.who_id === '' && r62.body.task.who_by === 'notmine' && ta.who_id === '' && ta.who_by === 'notmine' && ta.notmine.prev === 'uwork' && ta.notmine.by === 'uwork' && r62.body.updated_at > 1000
    && cl1 && cl1.items.length === 1 && cl1.items[0].f === 'who_id' && cl1.items[0].why === 'notmine' && cl1.items[0].p === 'veh:' && cl1.items[0].to === '' && cl1.items[0].h && cl1.head === cl1.items[0].h && JSON.stringify(cl1).indexOf('직원') < 0
    && r62.body.signal && r62.body.signal.notmine === 1 && r62.body.signal.recard === false && auditMock.logs.length === auditN62 + 1 && auditMock.logs[auditN62].ev[0].op === '내것아님';
  r62 = await call({ action: 'task_notmine', id: 't62a' }, tokW, 'dev1'); const n7 = r62.code === 403;   // 이미 비워져 본인 아님
  T('62 task_notmine: 수동 NOT_AUTO · 타인 NOT_ASSIGNEE · 관리자도 본인 아니면 403 · 완료 TASK_DONE · 없음 404 · 성공=담당 비움+notmine{prev,by}+clog 1행(값 없음·해시)+신호 1건+감사 내것아님 · 재요청 403',
    n1 && n2 && n3 && n4 && n5 && n6 && n7, JSON.stringify([n1, n2, n3, n4, n5, n6, n7, r62.code, cl1 && cl1.items[0]]));
  // 월 3건째 → recard · lessons:appr · assign_get lessons
  await call({ action: 'task_notmine', id: 't62b' }, tokW, 'dev1');
  r62 = await call({ action: 'task_notmine', id: 't62c' }, tokW, 'dev1');
  const LA62 = mem.gw_data['lessons:appr'];
  const g62 = await call({ action: 'assign_get' }, tokA);
  T('62 월 3건째: signal.recard true · lessons:appr veh 3건 1인 recard·규칙 1(R1 재카드) · assign_get lessons 동봉',
    r62.code === 200 && r62.body.signal.recard === true && r62.body.signal.notmine === 3 && LA62 && LA62.ym === ym62 && LA62.prefixes['veh:'].notmine === 3 && LA62.prefixes['veh:'].recard === true && LA62.rules.length === 1 && /veh: 접두어 \[내 것 아님\]/.test(LA62.rules[0].text)
    && g62.code === 200 && g62.body.lessons && g62.body.lessons.prefixes['veh:'].recard === true && g62.body.lessons.rules.length === 1, JSON.stringify([r62.body.signal, LA62 && LA62.rules]));
  // save 보호: 낡은 사본이 t62a를 다시 uwork로 올림 → 비운 채 유지 · 관리자 모달 재지정(who_by edit) → 통과 + clog who_id edit 행 · 기한 변경 d · 삭제
  const cur62 = mem.gw_data['col:tasks']; const base62 = cur62.updated_at;
  const stale = JSON.parse(JSON.stringify(cur62.items)).map((t) => { if (t.id === 't62a') { t.who_id = 'uwork'; t.who = '직원'; t.who_by = 'assign'; } return t; });
  r62 = await call({ action: 'save', collection: 'tasks', base: base62, doc: { schema: 1, items: stale } }, tokA);
  const ta2 = mem.gw_data['col:tasks'].items.find((x) => x.id === 't62a'); const clN = mem.gw_data['clog:appr:' + ym62].items.length;
  const tc2 = mem.gw_data['col:tasks'].items.find((x) => x.id === 't62c');
  const s1 = r62.code === 200 && ta2.who_id === '' && ta2.who_by === 'notmine' && ta2.notmine.prev === 'uwork' && tc2.who_id === '' && clN === 3;   // 보호는 clog 행을 만들지 않고, 배정표(veh:→uwork)도 같은 사람으로 되채우지 않는다
  await call({ action: 'assign_set', prefix: 'veh:', who_id: 'uwork2' }, tokA);   // 배정표가 다른 사람으로 바뀌면 비운 지시를 채운다
  const b2 = mem.gw_data['col:tasks'].updated_at;
  const edited = JSON.parse(JSON.stringify(mem.gw_data['col:tasks'].items)).map((t) => { if (t.id === 't62a') { t.who_id = 'uwork'; t.who = '직원'; t.who_by = 'edit'; } if (t.id === 't62o') { t.due = '2026-12-08'; } if (t.id === 't62b') { t.del = 1; } return t; });
  r62 = await call({ action: 'save', collection: 'tasks', base: b2, doc: { schema: 1, items: edited } }, tokA);
  const ta3 = mem.gw_data['col:tasks'].items.find((x) => x.id === 't62a'); const tc3 = mem.gw_data['col:tasks'].items.find((x) => x.id === 't62c'); const cl3 = mem.gw_data['clog:appr:' + ym62].items.slice(3); const LA3 = mem.gw_data['lessons:appr'];
  const s2 = r62.code === 200 && ta3.who_id === 'uwork' && ta3.who_by === 'edit' && tc3.who_id === 'uwork2' && tc3.who_by === 'assign' && cl3.length === 3
    && cl3.some((r) => r.id === 't62a' && r.f === 'who_id' && r.why === 'edit' && r.from === '' && r.to === 'set' && r.p === 'veh:' && r.by === 'uadmin')
    && cl3.some((r) => r.id === 't62o' && r.f === 'due' && r.d === 8 && r.p === 'lic:') && cl3.some((r) => r.id === 't62b' && r.f === 'del' && r.to === '1')
    && LA3.prefixes['veh:'].who_edit === 1 && LA3.prefixes['veh:'].del === 1 && LA3.prefixes['lic:'].due_edit === 1 && LA3.prefixes['lic:'].due_med === 8 && JSON.stringify(mem.gw_data['clog:appr:' + ym62]).indexOf('2026-12-08') < 0;
  T('62 save 보호·신호: 낡은 사본 재배정 → 비운 채(clog 행 없음·배정표 같은 사람 되채움 없음) · 배정표가 다른 사람이면 채움 · 관리자 edit 재지정 통과+clog who_id edit · 기한 변경 d=8(날짜 값 미기록) · 삭제 del 행 · lessons 재집계', s1 && s2, JSON.stringify([s1, s2, r62.code, cl3, ta3.who_by, tc3 && tc3.who_id]));
  delete mem.gw_data['col:tasks']; delete mem.gw_data['clog:appr:' + ym62]; delete mem.gw_data['lessons:appr']; delete mem.gw_users['member:uwork2']; delete mem.gw_data['settings:assign'];
}

{ // ---- 63(v414) C3-1 — 휴가 알림 2종(settings:notify leave_request·leave_result, 기본 켬) · 무기계약직 레이더 todo-cron 이식(duty:sent 멱등) ----
  const savedSend63 = pushMock.sendTo; const sent63 = [];
  pushMock.sendTo = async (ids, p, o) => { sent63.push({ ids: ids.slice(), p: p, o: o || {} }); return { sent: ids.length, removed: 0 }; };
  delete mem.gw_data['settings:notify'];
  let r63 = await call({ action: 'notify_get' }, tokA);
  T('63 notify_get: 5종 · 휴가 2종 기본값 켬(admins·applicant, R0 규정 정합) · 끄기 선택 있음', r63.code === 200 && Object.keys(r63.body.meta).length >= 5 && r63.body.events.leave_request === 'admins' && r63.body.events.leave_result === 'applicant' && r63.body.meta.leave_request.options.off && r63.body.meta.leave_result.rec === 'applicant', JSON.stringify(r63.body.events));
  // 직원 신청 → 관리자 우선기기 1발(신청자 제외)
  const L63 = { id: 'lv63', member_id: 'uwork', member_name: '직원', type: 'annual', start: '2026-11-10', end: '2026-11-10', days: 1, reason: '개인 사정', status: 'pending', approver: '', applied: '2026-11-02', updated: '2026-11-02' };
  mem.gw_data['col:leaves'] = { schema: 1, items: [], updated_at: 1 };
  r63 = await call({ action: 'save', collection: 'leaves', base: 1, doc: { schema: 1, items: [L63] } }, tokW, 'dev1');
  const q1 = sent63.length === 1 && r63.code === 200 && sent63[0].ids.indexOf('uadmin') >= 0 && sent63[0].ids.indexOf('uwork') < 0 && /휴가 신청 1건/.test(sent63[0].p.title) && /직원/.test(sent63[0].p.body) && sent63[0].p.body.indexOf('개인 사정') < 0 && sent63[0].p.body.indexOf('2026-11-10') < 0 && sent63[0].o.primaryOnly === true && /^leave-req-/.test(sent63[0].p.tag);
  // 같은 사본 재저장(변경 없음) → 추가 발송 없음
  const b63 = mem.gw_data['col:leaves'].updated_at;
  r63 = await call({ action: 'save', collection: 'leaves', base: b63, doc: { schema: 1, items: [L63] } }, tokW, 'dev1'); const q2 = r63.code === 200 && sent63.length === 1;
  // 관리자 승인 → 신청자 1발(본문에 사유·기간 없음)
  const b63b = mem.gw_data['col:leaves'].updated_at;
  const ap = Object.assign({}, L63, { status: 'approved', approver: '관리자', approved_at: '2026-11-02' });
  r63 = await call({ action: 'save', collection: 'leaves', base: b63b, doc: { schema: 1, items: [ap] } }, tokA);
  const q3 = r63.code === 200 && sent63.length === 2 && sent63[1].ids.join() === 'uwork' && sent63[1].p.title === '휴가 승인됨' && sent63[1].p.body.indexOf('개인 사정') < 0 && sent63[1].o.primaryOnly === true && sent63[1].p.tag === 'leave-res-lv63';
  // 끄기 → 발송 없음(반려)
  await call({ action: 'notify_set', event: 'leave_result', value: 'off' }, tokA);
  mem.gw_data['col:leaves'] = { schema: 1, items: [Object.assign({}, L63, { id: 'lv63b' })], updated_at: 7 };
  r63 = await call({ action: 'save', collection: 'leaves', base: 7, doc: { schema: 1, items: [Object.assign({}, L63, { id: 'lv63b', status: 'rejected' })] } }, tokA);
  const q4 = r63.code === 200 && sent63.length === 2;
  await call({ action: 'notify_set', event: 'leave_request', value: 'off' }, tokA);
  mem.gw_data['col:leaves'] = { schema: 1, items: [], updated_at: 8 };
  r63 = await call({ action: 'save', collection: 'leaves', base: 8, doc: { schema: 1, items: [Object.assign({}, L63, { id: 'lv63c' })] } }, tokW, 'dev1');
  const q5 = r63.code === 200 && sent63.length === 2;
  T('63 휴가 알림: 신청 → 관리자 1발(신청자 제외·우선기기·이름만, 사유·기간 없음) · 변경 없는 재저장 0 · 승인 → 신청자 1발(태그 leave-res-id) · 끄면 0(결과·신청)', q1 && q2 && q3 && q4 && q5, JSON.stringify([q1, q2, q3, q4, q5, sent63.map((x) => [x.ids, x.p.title, x.p.tag])]));
  // 레이더 이식 — 계약직 회원 1명(입사 2025-01-10 → 전환 2027-01-10, 오늘 기준 D-60~70 → d90) → PM(여기선 관리자 uadmin=tier pm) 1발 + duty:sent 키 · 두 번째 실행 0발
  mem.gw_users['member:uct63'] = { id: 'uct63', name: '계약직원', admin: false, perms: {}, emp_type: '계약직', hire_date: '2025-01-10', birth: '1990-05-05' };
  Object.keys(mem.gw_data).forEach((k) => { if (/^priv:[^:]+:mytasks$/.test(k) || /^todo:sent:/.test(k)) delete mem.gw_data[k]; });
  delete mem.gw_data['duty:sent'];
  const cron63 = require(join(FN, 'gw-todo-cron.js'));
  const n0 = sent63.length;
  const o1 = JSON.parse((await cron63.handler({})).body || '{}');
  const ds = mem.gw_data['duty:sent'];
  const ctKeys = ds ? Object.keys(ds.keys).filter((k) => k.indexOf('ct:uct63:') === 0) : [];
  const rad = sent63.slice(n0).filter((x) => /^ct-/.test(x.p.tag));
  const o2 = JSON.parse((await cron63.handler({})).body || '{}');
  const rad2 = sent63.slice(n0).filter((x) => /^ct-/.test(x.p.tag));
  T('63 레이더 이식: 계약직 1명 d90 → ct- 태그 1발(PM 우선기기, 기간제법 §4① 호수 본문) · duty:sent ct:uct63:2027-01-10:d90 기록 · 같은 날 재실행 0발(멱등) · 응답 radar',
    o1.ok === true && o1.radar && o1.radar.items === 1 && o1.radar.sent === 1 && rad.length === 1 && rad[0].ids.join() === 'uadmin' && rad[0].o.primaryOnly === true && /§4①/.test(rad[0].p.body) && /계약직원 D-\d+\(2027-01-10\)/.test(rad[0].p.body)
    && ctKeys.length === 1 && ctKeys[0] === 'ct:uct63:2027-01-10:d90' && o2.radar && o2.radar.items === 0 && rad2.length === 1, JSON.stringify([o1.radar, o2.radar, ctKeys, rad.map((x) => x.p)]));
  pushMock.sendTo = savedSend63;
  delete mem.gw_users['member:uct63']; delete mem.gw_data['col:leaves']; delete mem.gw_data['settings:notify']; delete mem.gw_data['duty:sent'];
}

{ // ---- 64(v415) C3-2 입찰 알림 — bid_result each/award(낙찰 즉시 담당+PM·유찰 아침 요약) · bid_fail assignee(watch 입찰 경보에 담당 추가) ----
  const savedSend64 = pushMock.sendTo; const sent64 = [];
  pushMock.sendTo = async (ids, p, o) => { sent64.push({ ids: ids.slice(), p: p, o: o || {} }); return { sent: ids.length, removed: 0 }; };
  delete mem.gw_data['settings:notify'];
  mem.gw_data['settings:assign'] = { schema: 1, rules: { 'bid:': { who_id: 'uwork' } }, approver_id: '', prev: null, updated_at: 5, updated_by: 'uadmin' };
  const seed64 = () => { mem.gw_data['col:bids'] = { schema: 1, items: [{ id: 'b64a', title: '포항 준설 공사', status: '응찰' }, { id: 'b64b', title: '경주 철거 공사', status: '응찰' }], updated_at: 1 }; };
  seed64();
  let r64 = await call({ action: 'notify_get' }, tokA); const e0 = r64.code === 200 && Object.keys(r64.body.meta).length === 7 && r64.body.events.bid_result === 'each' && r64.body.events.bid_fail === 'admins' && r64.body.meta.bid_result.rec === 'award';
  const RES = { action: 'bids_results', key: 'test-ingest-key', results: [{ id: 'b64a', status: '낙찰', result: { state: '낙찰', winner: '종운환경', amt: 100, rate: '87.5', bidders: 3 } }, { id: 'b64b', status: '유찰', result: { state: '유찰' } }] };
  r64 = await call(RES, null); const e1 = r64.code === 200 && sent64.length === 1 && /개찰결과 2건/.test(sent64[0].p.title) && sent64[0].ids.indexOf('uadmin') >= 0 && !sent64[0].o.primaryOnly;
  await call({ action: 'notify_set', event: 'bid_result', value: 'award' }, tokA); seed64();
  r64 = await call(RES, null); const e2 = r64.code === 200 && sent64.length === 2 && sent64[1].p.title === '낙찰 1건' && /포항 준설/.test(sent64[1].p.body) && sent64[1].p.body.indexOf('경주') < 0 && sent64[1].ids.indexOf('uwork') >= 0 && sent64[1].ids.indexOf('uadmin') >= 0 && sent64[1].o.primaryOnly === true && sent64[1].p.tag === 'bids-award';
  seed64(); r64 = await call({ action: 'bids_results', key: 'test-ingest-key', results: [{ id: 'b64b', status: '유찰', result: { state: '유찰' } }] }, null); const e3 = r64.code === 200 && sent64.length === 2;
  T('64 bid_result: 기본 each=관리자 전원 2건 · award=낙찰만 담당+PM 우선기기(유찰 제외) · 유찰만이면 즉시 없음 · meta 7종', e0 && e1 && e2 && e3, JSON.stringify([e0, e1, e2, e3, sent64.map((x) => [x.ids, x.p.title])]));
  // 아침 요약 — 유찰(result.checked 오늘) 1건 → 입찰 담당 1발
  Object.keys(mem.gw_data).forEach((k) => { if (/^priv:[^:]+:mytasks$/.test(k) || /^todo:sent:/.test(k)) delete mem.gw_data[k]; }); delete mem.gw_data['duty:sent'];
  const cron64 = require(join(FN, 'gw-todo-cron.js')); const n64 = sent64.length;
  const o64 = JSON.parse((await cron64.handler({})).body || '{}');
  const dg = sent64.slice(n64).filter((x) => /^bids-lost-/.test(x.p.tag));
  T('64 아침 요약 유찰: bid_result=award → 어제·오늘 유찰 1건 → 입찰 담당 우선기기 1발 · 응답 bid_digest', o64.ok === true && o64.bid_digest && o64.bid_digest.lost === 1 && o64.bid_digest.sent === true && dg.length === 1 && dg[0].ids.join() === 'uwork' && dg[0].o.primaryOnly === true && /유찰 1건/.test(dg[0].p.title) && /경주 철거/.test(dg[0].p.body), JSON.stringify([o64.bid_digest, dg.map((x) => [x.ids, x.p.title])]));
  // bid_fail — watch 입찰 경보 태그면 담당 추가(assignee), 다른 태그는 관리자만
  const n2 = sent64.length;
  r64 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '⚠ 입찰 감시 경보', body: 'b', tag: 'watch-입찰-2026-11-02' }); const f1 = r64.code === 200 && sent64.length === n2 + 1 && sent64[n2].ids.indexOf('uwork') < 0;
  await call({ action: 'notify_set', event: 'bid_fail', value: 'assignee' }, tokA);
  r64 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '⚠ 입찰 감시 경보', body: 'b', tag: 'watch-입찰-2026-11-02' }); const f2 = r64.code === 200 && sent64.length === n2 + 2 && sent64[n2 + 1].ids.indexOf('uwork') >= 0 && sent64[n2 + 1].ids.indexOf('uadmin') >= 0;
  r64 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '⚠ 운반일지 감시 경보', body: 'b', tag: 'watch-운반일지-2026-11-02' }); const f3 = r64.code === 200 && sent64.length === n2 + 3 && sent64[n2 + 2].ids.indexOf('uwork') < 0;
  T('64 bid_fail: admins(기본)=담당 없음 · assignee=watch-입찰 태그에 담당 추가 · 다른 감시 태그는 그대로', f1 && f2 && f3, JSON.stringify([f1, f2, f3, sent64.slice(n2).map((x) => x.ids)]));
  pushMock.sendTo = savedSend64;
  delete mem.gw_data['col:bids']; delete mem.gw_data['settings:notify']; delete mem.gw_data['settings:assign'];
}

{ // ---- 65(11/2) gw-lawwatch 수신 — 키 검증·보관 lawwatch:last·관리자 푸시·bg_recheck·푸시 실패 시 200+note(502 재발 방지) ----
  const lw65 = require(join(FN, 'gw-lawwatch.js'));
  const savedKey65 = process.env.BIDS_INGEST_KEY; process.env.BIDS_INGEST_KEY = 'test-ingest-key';
  const ev65 = (body, key) => ({ httpMethod: 'POST', headers: key ? { 'x-ingest-key': key } : {}, body: JSON.stringify(body) });
  const AL = '[법령 개정 감지] 산업안전보건법: 21374 → 22122 (20261027 공포)';
  let r65 = await lw65.handler(ev65({ alerts: [AL] }, 'wrong')); const k1 = r65.statusCode === 403;
  r65 = await lw65.handler(ev65({ alerts: [] }, 'test-ingest-key')); const k2 = r65.statusCode === 400;
  const pc65 = pushMock.calls.length; delete mem.gw_data['lawwatch:last'];
  r65 = await lw65.handler(ev65({ source: 'lawwatch', date: '2026-11-02', alerts: [AL], bg_recheck: [{ id: 'b1', law: '산업안전보건법', mst: 21374 }] }, 'test-ingest-key'));
  const j65 = JSON.parse(r65.body); const L65 = mem.gw_data['lawwatch:last'];
  const k3 = r65.statusCode === 200 && j65.status === 'OK' && j65.sent >= 1 && pushMock.calls.length === pc65 + 1 && /법령 워치 — 개정 1건/.test(pushMock.calls[pc65].title) && pushMock.calls[pc65].tag === 'lawwatch'
    && L65 && L65.date === '2026-11-02' && L65.alerts.length === 1 && L65.bg_recheck.length === 1 && L65.bg_recheck[0].id === 'b1' && L65.bg_recheck[0].mst === 21374;
  // 푸시가 던져도 보관은 남고 200 + note(수집기가 '전송 실패'로 남기지 않게)
  const savedTC65 = pushMock.tierCtx; pushMock.tierCtx = async () => { throw new Error('MissingBlobsEnvironmentError'); };
  delete mem.gw_data['lawwatch:last'];
  r65 = await lw65.handler(ev65({ source: 'lawwatch', date: '2026-11-02', alerts: [AL] }, 'test-ingest-key')); const j65b = JSON.parse(r65.body);
  const k4 = r65.statusCode === 200 && j65b.sent === 0 && /PUSH_FAILED/.test(j65b.note) && mem.gw_data['lawwatch:last'] && mem.gw_data['lawwatch:last'].alerts.length === 1;
  pushMock.tierCtx = savedTC65; process.env.BIDS_INGEST_KEY = savedKey65; delete mem.gw_data['lawwatch:last'];
  T('65 gw-lawwatch: 잘못된 키 403 · 경보 0 → 400 · 경보 1 → lawwatch:last 보관+bg_recheck+관리자 푸시 1(제목 개정 1건) · 푸시 예외여도 보관 뒤 200+PUSH_FAILED(502 재발 방지)', k1 && k2 && k3 && k4, JSON.stringify([k1, k2, k3, k4, j65, j65b]));
}

{ // ---- 66(v416) 아침 음성 브리핑(체크 38 D1) — brief_get 관리자 전용·기본값 · brief_set 검증/낙관락/NO_CHANGE/감사 · revert · brief_mp3 404→200 · brief_run 403/기동 실패 500/하루 상한 429 ----
  delete mem.gw_data['settings:brief']; delete mem.gw_data['brief:log'];
  const today66 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  let r66 = await call({ action: 'brief_get' }, tokW); const g0 = r66.code === 403;
  r66 = await call({ action: 'brief_get' }, tokA);
  const g1 = r66.code === 200 && r66.body.values && r66.body.values.provider === 'azure' && r66.body.values.voice_azure === 'ko-KR-SunHiNeural' && r66.body.values.on === true && r66.body.doc === null && r66.body.usage && r66.body.usage.cap_azure === 400000 && r66.body.env && typeof r66.body.env.azure === 'boolean' && r66.body.rates.length === 3 && r66.body.today === today66 && !/AZURE_SPEECH_KEY|xi-api-key/.test(JSON.stringify(r66.body));
  r66 = await call({ action: 'brief_set', field: 'rate', value: '+50%' }, tokA); const s0 = r66.code === 400 && r66.body.error_code === 'BAD_VALUE';
  r66 = await call({ action: 'brief_set', field: 'rate', value: '+10%', base: 0 }, tokA); const s1 = r66.code === 200 && r66.body.values.rate === '+10%' && !!r66.body.prev;
  const base66 = r66.body.updated_at;
  r66 = await call({ action: 'brief_set', field: 'rate', value: '+10%', base: base66 }, tokA); const s2 = r66.code === 400 && r66.body.error_code === 'NO_CHANGE';
  r66 = await call({ action: 'brief_set', field: 'on', value: false, base: 1 }, tokA); const s3 = r66.code === 409 && r66.body.error_code === 'BRIEF_STALE';
  r66 = await call({ action: 'brief_set', field: 'on', value: false, base: base66 }, tokA); const s4 = r66.code === 200 && r66.body.values.on === false && r66.body.values.rate === '+10%';
  const aud66 = auditMock.logs.filter((e) => e.ev && e.ev[0] && e.ev[0].op === '브리핑설정').length === 2;
  r66 = await call({ action: 'brief_revert', base: r66.body.updated_at }, tokA); const v0 = r66.code === 200 && r66.body.values.on === true && r66.body.values.rate === '+10%';
  r66 = await call({ action: 'brief_mp3' }, tokA); const m0 = r66.code === 404 && r66.body.error_code === 'NO_MP3';
  mem.gw_data['brief:mp3:' + today66] = { b64: 'AAAA', bytes: 3, fmt: 'audio/mpeg' };
  r66 = await call({ action: 'brief_mp3' }, tokA); const m1 = r66.code === 200 && r66.body.b64 === 'AAAA';
  r66 = await call({ action: 'brief_run' }, tokW); const n0 = r66.code === 403;
  r66 = await call({ action: 'brief_run' }, tokA); const n1 = r66.code === 500 && /KICKOFF/.test(r66.body.error_code);   // test.local은 기동 불가 — 워커 호출 경로·실패 처리만
  mem.gw_data['brief:log'] = { schema: 1, items: [1, 2, 3, 4, 5].map((i) => ({ ts: i, date: today66, by: 'admin:uadmin', mode: 'template' })) };
  r66 = await call({ action: 'brief_run' }, tokA); const n2 = r66.code === 429 && r66.body.error_code === 'DAILY_CAP';
  T('66 브리핑: 비관리자 403 · 기본값(azure·선히·켬·상한·키 값 없음) · set 검증 400/낙관락 409/NO_CHANGE/감사 2 · revert · mp3 404→200 · run 403/기동 실패 500/하루 상한 429',
    g0 && g1 && s0 && s1 && s2 && s3 && s4 && aud66 && v0 && m0 && m1 && n0 && n1 && n2, JSON.stringify([g0, g1, s0, s1, s2, s3, s4, aud66, v0, m0, m1, n0, n1, n2]));
  Object.keys(mem.gw_data).forEach((k) => { if (/^(brief:|settings:brief)/.test(k)) delete mem.gw_data[k]; });
}

{ // ---- 67(v417) 카드 10 자동 지시 서버 규칙 3건 — autotask_facts(봇 키·id만·PII 가드) · dry_put · 스위치 get/set/revert(관리자·낙관락·감사) · 봇 푸시 ⑥(task_auto_create=assignee면 생략) · doneif site/wk 신호 ----
  const today67 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const ym67 = today67.slice(0, 7);
  const d37 = new Date(Date.now() + 37 * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
  mem.gw_data['col:asbestos'] = { schema: 1, items: [{ id: 'd1', kind: 'dredge', seq: 11, site: '', worker_ids: [], start: '2025-05-01' }, { id: 'd2', kind: 'dredge', seq: 12, site: '포항', worker_ids: ['w2'], start: '2025-06-01' }, { id: 'a1', kind: 'asbestos', seq: 13, site: '', worker_ids: [], start: '2026-01-01' }] };
  mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w2', name: '테스트', birth: '', phone: '' }] };
  mem.gw_data['col:vehicles'] = { schema: 1, items: [{ id: 'v1', no: '11가1111', state: '운행', insp_due: d37 }, { id: 'v2', no: '22나2222', state: '매각', insp_due: d37 }] };
  mem.gw_data['col:tasks'] = { schema: 1, items: [{ id: 't1', auto_key: 'wk:missing:' + ym67, status: 'open', title: 'x' }] };
  delete mem.gw_data['settings:autotask']; delete mem.gw_data['it:autotask:dry'];
  let r67 = await call({ action: 'autotask_facts', key: 'bad' }, null); const f0 = r67.code === 403;
  r67 = await call({ action: 'autotask_facts', key: 'test-ingest-key' }, null);
  const f1 = r67.code === 200 && r67.body.site.count === 1 && r67.body.site.ids[0] === 'd1' && r67.body.veh90.count === 1 && r67.body.veh90.items[0].id === 'v1' && r67.body.wk.scope === 1 && r67.body.wk.birth_blank === 1 && r67.body.keys.site === 'site:missing:' + ym67 && r67.body.exists.wk === true && r67.body.exists.site === false && r67.body.rules.site_missing === 'dry' && !/테스트|11가1111/.test(JSON.stringify(r67.body));
  r67 = await call({ action: 'autotask_dry_put', key: 'test-ingest-key', day: today67, run: 'servertest', dry: { wk_missing: { name: '김' } } }, null); const p0 = r67.code === 400 && r67.body.error_code === 'PII_FIELD';
  r67 = await call({ action: 'autotask_dry_put', key: 'test-ingest-key', day: today67, run: 'servertest', dry: { site_missing: { mode: 'dry', count: 1, ids: ['d1'], seqs: [11], by: { dredge_workers: 1, site_blank: { dredge: 1, demolition: 0 } }, would_create: true }, veh_insp90: { mode: 'dry', count: 1, items: [{ id: 'v1', due: d37, days: 37 }], overlap: 0, flags: [] }, wk_missing: { mode: 'dry', scope: 1, birth_blank: 1, phone_blank: 1, dup_pairs: 0, would_create: false, skip: '키 있음' } } }, null);
  const p1 = r67.code === 200 && mem.gw_data['it:autotask:dry'] && mem.gw_data['it:autotask:dry'].rules.site_missing.count === 1 && mem.gw_data['it:autotask:dry'].modes.veh_insp90 === 'dry';
  r67 = await call({ action: 'autotask_get' }, tokW); const g0 = r67.code === 403;
  r67 = await call({ action: 'autotask_get' }, tokA); const g1 = r67.code === 200 && r67.body.rules.site_missing === 'dry' && r67.body.rules.veh_insp90 === 'dry' && r67.body.rules.wk_missing === 'dry' && r67.body.dry && r67.body.veh_items.length === 1 && r67.body.veh_items[0].no === '11가1111' && r67.body.prev === null && Object.keys(r67.body.meta).length === 3;
  r67 = await call({ action: 'autotask_set', rule: 'veh_insp90', mode: 'maybe' }, tokA); const s0 = r67.code === 400 && r67.body.error_code === 'BAD_RULE';
  r67 = await call({ action: 'autotask_set', rule: 'veh_insp90', mode: 'live', base: 0 }, tokA); const s1 = r67.code === 200 && r67.body.rules.veh_insp90 === 'live' && !!r67.body.prev;
  const base67 = r67.body.updated_at;
  r67 = await call({ action: 'autotask_set', rule: 'veh_insp90', mode: 'live', base: base67 }, tokA); const s2 = r67.code === 400 && r67.body.error_code === 'NO_CHANGE';
  r67 = await call({ action: 'autotask_set', rule: 'site_missing', mode: 'off', base: 1 }, tokA); const s3 = r67.code === 409 && r67.body.error_code === 'AUTOTASK_STALE';
  const aud67 = auditMock.logs.filter((e) => e.ev && e.ev[0] && e.ev[0].op === '자동지시규칙').length === 1;
  r67 = await call({ action: 'autotask_revert', base: base67 }, tokA); const v0 = r67.code === 200 && r67.body.rules.veh_insp90 === 'dry';
  r67 = await call({ action: 'autotask_facts', key: 'test-ingest-key' }, null); const f2 = r67.code === 200 && r67.body.rules.veh_insp90 === 'dry';
  r67 = await call({ action: 'assign_set', prefix: 'site:', who_id: 'uwork' }, tokA); const a0 = r67.code === 200 && r67.body.rules['site:'] && r67.body.rules['site:'].who_id === 'uwork';
  // ⑥ 봇 '정기업무 n건' 푸시 — task_auto_create=assignee(설정 8일 전)면 관리자 푸시 생략, 기본(admins)이면 그대로
  const savedSend67 = pushMock.sendTo; const sent67 = [];
  pushMock.sendTo = async (ids, p, o) => { sent67.push({ ids: ids.slice(), p: p }); return { sent: ids.length, removed: 0 }; };
  delete mem.gw_data['settings:notify'];
  r67 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '정기업무 2건', body: 'x', tag: 'auto-due' }, null); const n0 = r67.code === 200 && sent67.length === 1;
  mem.gw_data['settings:notify'] = { schema: 1, events: { task_auto_create: 'assignee' }, prev: null, updated_at: Date.now() - 8 * 86400000, updated_by: 'uadmin' };
  r67 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '정기업무 2건', body: 'x', tag: 'auto-due' }, null); const n1 = r67.code === 200 && r67.body.sent === 0 && /생략/.test(r67.body.note || '') && sent67.length === 1;
  mem.gw_data['settings:notify'].updated_at = Date.now() - 86400000;   // 전환 1일 — 병행 1주 안이라 관리자 푸시 유지
  r67 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '정기업무 2건', body: 'x', tag: 'auto-due' }, null); const n2 = r67.code === 200 && sent67.length === 2;
  r67 = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '⚠ 백업', body: 'x', tag: 'backup-stale' }, null); const n3 = r67.code === 200 && sent67.length === 3;   // 다른 태그는 영향 없음
  pushMock.sendTo = savedSend67;
  // ⑤ 완료 신호 — site/wk 월 키: 미입력 0이면 신호, 아니면 아님(원본 행은 recs.__rows)
  const D67 = require(join(FN, '_lib/doneif.js'));
  const rowsOk = { __rows: { asbestos: [{ id: 'd2', kind: 'dredge', site: '포항', worker_ids: ['w2'], start: '2025-06-01' }], workers: [{ id: 'w2', birth: '810817' }] } };
  const rowsNo = { __rows: { asbestos: [{ id: 'd1', kind: 'dredge', site: '', worker_ids: [], start: '2025-05-01' }], workers: [{ id: 'w2', birth: '' }] } };
  const sig = D67.signalFor({ auto_key: 'site:missing:' + ym67 }, rowsOk).ok && !D67.signalFor({ auto_key: 'site:missing:' + ym67 }, rowsNo).ok && D67.signalFor({ auto_key: 'wk:missing:' + ym67 }, rowsOk).ok && !D67.signalFor({ auto_key: 'wk:missing:' + ym67 }, { __rows: { asbestos: rowsNo.__rows.asbestos.concat([{ id: 'd2', kind: 'dredge', site: '포항', worker_ids: ['w2'], start: '2025-06-01' }]), workers: rowsNo.__rows.workers } }).ok && D67.signalFor({ auto_key: 'site:missing:' + ym67 }, {}).why === 'no_rows';
  T('67 카드 10: facts 403/집계(site 1·veh90 1·wk 1·키·exists)·값 노출 0 · dry_put PII 거부/보관 · get 403/기본 dry·차량번호 해석 · set 검증/NO_CHANGE/409/감사 · revert · facts에 스위치 · 배정표 site: · 봇 푸시 ⑥ · 완료 신호 ⑤',
    f0 && f1 && p0 && p1 && g0 && g1 && s0 && s1 && s2 && s3 && aud67 && v0 && f2 && a0 && n0 && n1 && n2 && n3 && sig, JSON.stringify([f0, f1, p0, p1, g0, g1, s0, s1, s2, s3, aud67, v0, f2, a0, n0, n1, n2, n3, sig]));
  ['col:asbestos', 'col:workers', 'col:vehicles', 'col:tasks', 'settings:autotask', 'it:autotask:dry', 'settings:notify', 'settings:assign'].forEach((k) => { delete mem.gw_data[k]; });
}

{ // ---- 68(v419) 채움 맵 실제 형태 — xgBuildEdits 실제 산출(index.html 원문 실행)로 짝 생성 → 칸 비교 → 간극 → 워커 → 학습값 → 앱 주입 → 양식 채움까지(평면 고정값이 가린 결함 재발 방지) · 허용 칸 상한 ----
  const fs68 = require('fs');
  const LN = require(join(FN, '_lib/learn.js')), DD = require(join(FN, '_lib/docdiff.js'));
  const html68 = fs68.readFileSync(join(ROOT, 'index.html'), 'utf8');
  const fnOf68 = (name) => { const i = html68.indexOf('  function ' + name + '('); if (i < 0) throw new Error('함수 없음: ' + name); let d = 0, st = false; for (let j = i; j < html68.length; j++) { const ch = html68[j]; if (ch === '{') { d++; st = true; } else if (ch === '}') { d--; if (st && d === 0) return html68.slice(i, j + 1); } } throw new Error(name); };
  const cut68 = (a, b) => { const i = html68.indexOf(a), j = html68.indexOf(b); if (i < 0 || j < 0) throw new Error('구간 ' + a); return html68.slice(i, j); };
  // 앱 코드를 재현하지 않고 원문을 그대로 실행한다(입력 칸만 스텁)
  const app68 = new Function('gwImpl', `
    var els = {}, errs = [], workers = [];
    var document = { getElementById: function(id){ return els[id] || (els[id] = { value: "" }); }, querySelectorAll: function(){ return []; } };
    function alert(){} function todayStr(){ return "2026-11-04"; } function canDo(){ return true; } function reportErr(m){ errs.push(String(m)); }
    function gwCall(fn, body){ return gwImpl(fn, body); }
    ${fnOf68('xgBuildEdits') + fnOf68('koAmount') + fnOf68('dateSerial') + fnOf68('wkLabel') + fnOf68('findWk') + fnOf68('cdocSan') + fnOf68('xgMergeLearned') + fnOf68('xgApplyLearned')}
    ${cut68('function dataUrlToBytes', 'async function readXlsx')}
    ${cut68('var CRC_T=', 'function xmlEsc')}
    ${cut68('function xmlEsc', '// b64 양식 + 시트별 편집')}
    ${cut68('async function fillXlsxTemplate', 'function downloadBlob')}
    return { set: function(o){ Object.keys(o).forEach(function(k){ els[k] = { value: o[k] }; }); }, xgBuildEdits: xgBuildEdits, xgApplyLearned: xgApplyLearned, fillXlsxTemplate: fillXlsxTemplate, errs: errs };
  `);
  const pending68 = { impl: null };
  const A68 = app68((fn, body) => pending68.impl(fn, body));
  A68.set({ xgTitle: '시험 공사', xgSite: '포항시 시험동 1', xgClient: '시험 발주처', xgAmount: '12500000', xgD1: '2026-11-01', xgD2: '2026-11-02', xgD3: '2026-11-11', xgCo: 'con' });   // 건설 = 칸이 가장 많은 분기(허용 칸 30개 초과 시험 겸)
  const ED68 = A68.xgBuildEdits('work_start', { type: 'dredge' });
  const DS68 = '건설공사 직접시공계획서', A18 = DS68 + '!A18';
  const flat68 = DD.flattenEdits(ED68);
  T('68 실제 산출 = 시트별 객체(배열 아님) → flattenEdits: 시트!셀·__drop_drawings__ 제외 · 옛 평면 배열은 그대로 · 채움 맵 아니면 null',
    !Array.isArray(ED68) && Array.isArray(ED68.__drop_drawings__) && flat68.length > 20 && flat68.every((e) => e[0].indexOf('!') > 0 && e[0].indexOf('__drop') < 0) && flat68.some((e) => e[0] === A18 && e[2] === 'b') && DD.flattenEdits([['C7', 'x', 's']])[0][0] === 'C7' && DD.flattenEdits(null) === null && DD.flattenEdits('x') === null && DD.flattenEdits({}).length === 0, String(flat68.length));
  // 다중 시트 zip(절 59와 같은 작성기)
  const crcT = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const mkZip = (entries) => { const locals = [], cds = []; let off = 0; for (const [name, text] of entries) { const nb = Buffer.from(name), db = Buffer.from(text), crc = crc32(db); const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(db.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42); locals.push(lh, nb, db); cds.push(cd, nb); off += 30 + nb.length + db.length; } const cdb = Buffer.concat(cds), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16); return Buffer.concat([...locals, cdb, eocd]); };
  const sheets68 = Object.keys(ED68).filter((s) => s !== '__drop_drawings__');
  const cellXml = (ref, v, ty) => (ty === 'b' || v === '' ? '<c r="' + ref + '"/>' : (ty === 'n' ? '<c r="' + ref + '"><v>' + v + '</v></c>' : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</t></is></c>'));
  const wb68 = (override) => mkZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook><sheets>' + sheets68.map((s, i) => '<sheet name="' + s + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'], ['xl/_rels/workbook.xml.rels', '<Relationships>' + sheets68.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="ws" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>']].concat(sheets68.map((s, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', '<worksheet><sheetData><row r="1">' + ED68[s].map((e) => { const o = override[s + '!' + e[0]]; return o !== undefined ? cellXml(e[0], o, 's') : cellXml(e[0], e[1], e[2]); }).join('') + '</row></sheetData></worksheet>'])));
  // 최종본 = 초안 그대로 + 공문!B14 수정 + 공란이던 A18을 직원이 채움 → 바뀐 칸 정확히 2
  const FINAL68 = wb68({ '공문!B14': '직원이 고친 본문', [A18]: '직원이 채운 값' });
  const CONW68 = { id: 'uconw68', name: '공무직원68', admin: false, perms: { con: 'do' }, dept: '운영부' }; mem.gw_users['member:uconw68'] = CONW68; const tok68 = issueSession(CONW68).token;
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c68', title: '학습 계약', scen: 'dredge:pub', stages: [] }], updated_at: 1 };
  mem.gw_data['map:contract:v1'] = { schema: 1, scen: { 'dredge:pub': [{ i: 2, name: '착공', co: 'env' }] } };
  mem.gw_files = mem.gw_files || {};
  const b68 = (x) => Buffer.from(x).toString('base64');
  let r68 = await call({ action: 'cdoc_put', cid: 'c68', i: 2, doc_key: 'gen.work_start', kind: 'draft', pii: 1, fill: { tpl: 'work_start', at: '2026-11-04', edits: ED68 } }, tok68, 'dev1'); const g0 = r68.code === 200;
  const stored68 = mem.gw_files[Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:c68') === 0)[0]];
  r68 = await call({ action: 'cdoc_put', cid: 'c68', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '착공계.xlsx', data: b68(FINAL68), pii: 1 }, tok68, 'dev1');
  const L68 = r68.body.learn || {};
  const pk68 = Object.keys(mem.gw_data).filter((k) => k.indexOf('learn:contract:in:') === 0);
  const P68 = pk68.length ? mem.gw_data[pk68[0]] : null, Ls68 = mem.gw_data['lessons:contract:work_start'];
  T('68 실제 초안으로 짝: 저장 형식 시트별 객체 그대로 · kind xlsx_cell · 간극 null 아님(comparable·cell_ratio 숫자) · 바뀐 칸 2(공문!B14·직접시공 A18) · 짝 블롭에 값 없음 · lessons에 숫자 간극 1(기준선 재료)',
    g0 && !Array.isArray(stored68.fill.edits) && Array.isArray(stored68.fill.edits['공문']) && r68.code === 200 && L68.ok && L68.kind === 'xlsx_cell' && L68.status === 'done_nomodel' && L68.gap && L68.gap.comparable === true && typeof L68.gap.cell_ratio === 'number' && L68.gap.cell_ratio > 0 && L68.changed === 2 && P68 && L68.compared + P68.diff.blank_both === flat68.length && P68.diff.blank_both > 0 && L68.uncomparable === 0 && P68 && P68.diff.refs_changed.slice().sort().join() === [A18, '공문!B14'].sort().join() && JSON.stringify(P68).indexOf('직원이') < 0 && Ls68 && Ls68.gaps.length === 1 && typeof Ls68.gaps[0].ratio === 'number', JSON.stringify([L68, P68 && P68.diff]).slice(0, 400));
  // 워커 — NO_FILL로 죽지 않고 허용 칸 값이 시트!셀 좌표로 프롬프트에 → 규칙 → learn_defaults_get → 앱 주입 → 양식 채움
  const allow68 = flat68.map((e) => e[0]).filter((r) => r !== DS68 + '!D33');
  r68 = await call({ action: 'learn_settings_set', on: true, allow: { work_start: allow68 } }, tokA, 'dev1'); const w0 = r68.code === 200 && allow68.length > 30;
  r68 = await call({ action: 'cdoc_put', cid: 'c68', i: 2, doc_key: 'main.작성-0', kind: 'final', name: '착공계2.xlsx', data: b68(FINAL68), pii: 1, allow_dup: true }, tok68, 'dev1');
  const pid68 = r68.body.learn && r68.body.learn.id; const w1 = r68.code === 200 && r68.body.learn.status === 'pending' && r68.body.learn.kind === 'xlsx_cell';
  const worker68 = require(join(FN, 'gw-learn-background.js'));
  const savedKey68 = process.env.GW_ANTHROPIC_KEY, savedUrl68 = process.env.URL, realFetch68 = global.fetch;
  process.env.GW_ANTHROPIC_KEY = 'test-anthropic-key-0000'; process.env.URL = 'https://test.local';
  const api68 = [];
  global.fetch = async (url, opt) => {
    const b = JSON.parse(opt.body || '{}'); api68.push((b.messages && b.messages[0] && b.messages[0].content[0].text) || '');
    const text = JSON.stringify({ summary: 'A18을 같은 값으로 채움', changes: [{ kind: 'field_default', what: 'A18 기본값' }], rules: [{ text: '직접시공계획서 A18은 처음부터 채운다', scope: 'field_default', n: 2, keep_id: '', field: A18, value: '직원이 채운 값' }, { text: '본문 표기를 고친다', scope: 'format', n: 1, keep_id: '', field: '', value: '' }] });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: b.model, stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text: text }] }) };
  };
  const tokIn68 = issueSession({ id: '__promoai__', role: 'system' }).token;
  await worker68.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokIn68 }, body: JSON.stringify({ pair_id: pid68 }) }, {});
  global.fetch = realFetch68; process.env.GW_ANTHROPIC_KEY = savedKey68; process.env.URL = savedUrl68;
  const Pw68 = mem.gw_data['learn:contract:in:' + pid68], uw68 = api68[0] || '';
  const w2 = Pw68.status === 'done' && Pw68.code === undefined && api68.length === 1 && uw68.indexOf(A18) >= 0 && uw68.indexOf('직원이 채운 값') > 0 && uw68.indexOf(DS68 + '!D33') >= 0 === false && Pw68.visible_n === allow68.length && mem.gw_data['lessons:contract:work_start'].rules.some((r) => r.scope === 'field_default' && r.field === A18);
  T('68 워커: NO_FILL 아님(done) · 시트!셀 좌표·허용 칸 값이 프롬프트에 · 규칙 저장 · 짝 생성에 허용 칸 30개 초과 사전이 저장됨', w0 && w1 && w2, JSON.stringify([w0, w1, Pw68.status, Pw68.code, Pw68.visible_n, allow68.length]));
  // 앱 주입 — 서버 응답을 그대로 받아 공란 칸에만, 실제 fillXlsxTemplate으로 양식에 들어가는지까지
  pending68.impl = async (fn, body) => { const r = await call(body, tok68, 'dev1'); return { status: r.code, body: r.body }; };
  const al68 = await A68.xgApplyLearned('work_start', ED68);
  const rowA18 = (ed) => ed[DS68].filter((x) => x[0] === 'A18')[0];
  const TPL68 = wb68({}); const blob68 = await A68.fillXlsxTemplate(b68(TPL68), al68.edits);
  const out68 = DD.xlsxCells(Buffer.from(await blob68.arrayBuffer()));
  const i1 = !Array.isArray(al68.edits) && Object.keys(al68.edits).join() === Object.keys(ED68).join() && al68.edits.__drop_drawings__ === ED68.__drop_drawings__ && JSON.stringify(rowA18(al68.edits)) === JSON.stringify(['A18', '직원이 채운 값', 's']) && al68.learned.join() === A18 && rowA18(ED68)[2] === 'b' && A68.errs.length === 0;
  const i2 = out68.ok && out68.sheets[DS68].cells.A18.v === '직원이 채운 값' && out68.sheets['기본정보 입력'].cells.B1.v === '시험 공사';
  T('68 앱 주입: learn_defaults_get 응답 → 공란 칸 A18에 값 · 시트 구조·__drop_drawings__ 유지 · learned = 시트!셀 · 실제 fillXlsxTemplate 결과 파일에 값 들어감 · 다른 칸 유지 · 오류 기록 없음', i1 && i2, JSON.stringify([i1, i2, al68.learned, A68.errs]));
  // v420 글자 크기 줄(4번째 값) — 비교에서 f 제외, 실제 fillXlsxTemplate이 styles.xml에 덧붙이고 원본 스타일은 그대로
  const PT_STY = '<styleSheet><fonts count="2" x14ac:knownFonts="1"><font><sz val="11"/><name val="A"/></font><font><b/><sz val="12"/><name val="B"/></font></fonts><cellXfs count="2"><xf numFmtId="0" fontId="0" xfId="0"/><xf numFmtId="0" fontId="1" xfId="0" applyFont="1"><alignment horizontal="left"/></xf></cellXfs></styleSheet>';
  const ptWb = (sty) => mkZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook><sheets><sheet name="공문" sheetId="1" r:id="rId1"/></sheets></workbook>'], ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>'], ['xl/styles.xml', sty], ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="C1" s="1" t="inlineStr"><is><t>머리</t></is></c></row><row r="13"><c r="B13" s="1" t="inlineStr"><is><t>본문 그대로</t></is></c></row><row r="14"><c r="B14" s="1" t="inlineStr"><is><t>옛 값</t></is></c></row></sheetData></worksheet>']]);
  const ptEd = { '공문': [['B13', '', 'f', 10], ['B14', '새 값', 's', 10], ['C1', '머리 새 값', 's']] };
  const ptOut = async (sty) => { const buf = Buffer.from(await (await A68.fillXlsxTemplate(b68(ptWb(sty)), ptEd)).arrayBuffer()); return { z: DD.zipEntries(buf), x: DD.xlsxCells(buf) }; };
  const pt1 = await ptOut(PT_STY), pt1S = pt1.z['xl/styles.xml'].toString('utf8'), pt1X = pt1.z['xl/worksheets/sheet1.xml'].toString('utf8');
  T('68 v420 글자 크기: flattenEdits는 f 줄 제외 · 값 칸은 그대로 비교', JSON.stringify(DD.flattenEdits(ptEd)) === JSON.stringify([['공문!B14', '새 값', 's'], ['공문!C1', '머리 새 값', 's']]), JSON.stringify(DD.flattenEdits(ptEd)));
  T('68 v420 글자 크기: f 줄은 값 유지 · 두 칸이 새 스타일 하나를 공유 · 굵기·글꼴·정렬은 원본 그대로 · 지정 안 한 칸·기존 스타일은 안 바뀜 · count 갱신',
    pt1.x.sheets['공문'].cells.B13.v === '본문 그대로' && pt1.x.sheets['공문'].cells.B14.v === '새 값' && /<c r="B13" s="2"/.test(pt1X) && /<c r="B14" s="2"/.test(pt1X) && /<c r="C1" s="1"/.test(pt1X)
    && pt1S.indexOf('<fonts count="3"') >= 0 && pt1S.indexOf('<cellXfs count="3"') >= 0 && pt1S.indexOf('<font><b/><sz val="12"/><name val="B"/></font>') >= 0 && pt1S.indexOf('<font><b/><sz val="10"/><name val="B"/></font></fonts>') >= 0 && pt1S.indexOf('<xf numFmtId="0" fontId="2" xfId="0" applyFont="1"><alignment horizontal="left"/></xf></cellXfs>') >= 0, pt1S);
  const pt2 = await ptOut(PT_STY.replace('<fonts count="2"', '<fonts count="9"')), pt2S = pt2.z['xl/styles.xml'].toString('utf8');
  T('68 v420 글자 크기: styles.xml을 못 읽으면 스타일은 손대지 않고 값만 채움', pt2.x.sheets['공문'].cells.B14.v === '새 값' && pt2S.indexOf('<fonts count="9"') >= 0 && pt2S.indexOf('val="10"') < 0 && /<c r="B14" s="1"/.test(pt2.z['xl/worksheets/sheet1.xml'].toString('utf8')), pt2S.slice(0, 80));
  // 허용 칸 상한·형식
  const many = (n) => Array.from({ length: n }, (_, i) => '시트!A' + (i + 1));
  r68 = await call({ action: 'learn_settings_set', allow: { work_start: many(200) } }, tokA, 'dev1'); const c0 = r68.code === 200;
  r68 = await call({ action: 'learn_settings_set', allow: { work_start: many(201) } }, tokA, 'dev1'); const c1 = r68.code === 400 && r68.body.error_code === 'BAD_FIELDS';
  r68 = await call({ action: 'learn_settings_set', allow: { demo_report: ['건축물해체신고서1!A5~H14'] } }, tokA, 'dev1'); const c2 = r68.code === 400 && r68.body.error_code === 'BAD_FIELDS';
  r68 = await call({ action: 'learn_settings_set', allow: { work_start: ['가'.repeat(41)] } }, tokA, 'dev1'); const c3 = r68.code === 400 && r68.body.error_code === 'BAD_FIELDS';
  r68 = await call({ action: 'learn_settings_set', allow: { work_start: [' '] } }, tokA, 'dev1'); const c4 = r68.code === 400 && r68.body.error_code === 'BAD_FIELDS';
  T('68 허용 칸 상한 200: 200칸 저장 · 201칸 BAD_FIELDS · 범위 표기(~) BAD_FIELDS · 41자 BAD_FIELDS · 빈 칸 BAD_FIELDS', c0 && c1 && c2 && c3 && c4, JSON.stringify([c0, c1, c2, c3, c4]));
  ['col:contracts', 'map:contract:v1', 'recidx:c68', 'settings:learn', 'lessons:contract:work_start', 'learn:contract:lock', 'usage:learn:contract:' + LN.ymOf(Date.now())].forEach((k) => { delete mem.gw_data[k]; });
  Object.keys(mem.gw_data).filter((k) => k.indexOf('learn:contract:in:') === 0).forEach((k) => delete mem.gw_data[k]); Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:c68') === 0).forEach((k) => delete mem.gw_files[k]);
}

{ // ---- 72(v423) 넣기 박스 — box_put 조각 · cdoc_attach(작은 파일·큰 파일·중복·초안 짝) · cdoc_get 조각 · cdoc_move · box_fix · 판단 모듈·백그라운드 ----
  const fsz = require('fs');
  const BJ = require(join(FN, '_lib/boxjudge.js'));
  const BF = require(join(FN, '_lib/boxfile.js'));
  const pb = require(join(FN, 'gw-parse-background.js'));
  const U72 = { id: 'ucon72', name: '공무72', admin: false, perms: { con: 'do' }, dept: '운영부' }, U72B = { id: 'ucon72b', name: '공무72B', admin: false, perms: { con: 'do' }, dept: '운영부' };
  mem.gw_users['member:ucon72'] = U72; mem.gw_users['member:ucon72b'] = U72B;
  const tk = issueSession(U72).token, tkB = issueSession(U72B).token;
  const b = (x) => Buffer.from(x).toString('base64');
  mem.gw_files = mem.gw_files || {};
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c72', title: '박스 계약', scen: 'dredge:pub', stages: [] }], updated_at: 1 };
  const PDF = (s) => b('%PDF-1.4 ' + s);
  // box_put 입구 검사
  let r = await call({ action: 'box_put', j: 0, k: 1, name: 'a.pdf', data: PDF('x') }, tokW, 'dev1');
  const g1 = r.code === 403 && r.body.error_code === 'NO_WRITE';
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'a.pdf', data: PDF('x') }, tk);
  const g2 = r.code === 403 && r.body.error_code === 'DEVICE_NOT_APPROVED';
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'a.exe', data: PDF('x') }, tk, 'dev1');
  const g3 = r.code === 400 && r.body.error_code === 'BAD_EXT';
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'a.pdf', data: b('not pdf at all') }, tk, 'dev1');
  const g4 = r.code === 400 && r.body.error_code === 'BAD_MAGIC';
  r = await call({ action: 'box_put', j: 0, k: 9, name: 'a.pdf', data: PDF('x') }, tk, 'dev1');
  const g5 = r.code === 400 && r.body.error_code === 'BAD_PART';
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'a.pdf', data: 'A'.repeat(4400004) }, tk, 'dev1');
  const g6 = r.code === 413 && r.body.error_code === 'PART_TOO_LARGE';
  T('72 box_put 입구: 계약 권한 없음 403 · 승인 기기 없음 403 · 형식·매직 400 · 조각 수 상한 400 · 조각 크기 413', g1 && g2 && g3 && g4 && g5 && g6, JSON.stringify([g1, g2, g3, g4, g5, g6]));
  r = await call({ action: 'box_put', j: 0, k: 1, name: '옛파일.xls', data: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]).toString('base64') }, tk, 'dev1');
  T('72 box_put: xls(OLE)는 받는다(옛 📎이 받던 형식)', r.code === 200 && !!r.body.id, r.code + '/' + r.body.error_code);
  // 작은 파일 → 서류함
  r = await call({ action: 'box_put', j: 0, k: 1, name: '착공계 수령.pdf', size: 12, data: PDF('small') }, tk, 'dev1');
  const idS = r.body.id, recS = mem.gw_files[idS];
  T('72 box_put 1조각: 본 레코드에 통째로(kind box·올린 사람) · done', r.code === 200 && r.body.done === true && recS && recS.kind === 'box' && recS.bid === 'ucon72' && recS.data === PDF('small') && !recS.parts, JSON.stringify(r.body));
  mem.gw_files['parse:' + idS] = { ts: 1, result: { doc: 'box', cls: 'received' } };
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 1, doc_key: 'pk.con.contract', kind: 'draft', att: idS }, tk, 'dev1');
  const k1 = r.code === 400 && r.body.error_code === 'BAD_KIND';
  r = await call({ action: 'cdoc_attach', cid: 'cNope', i: 1, doc_key: 'pk.con.contract', kind: 'received', att: idS }, tk, 'dev1');
  const k2 = r.code === 404 && r.body.error_code === 'NO_CONTRACT' && !!mem.gw_files[idS];
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 1, doc_key: 'pk.con.contract', kind: 'received', att: idS }, tk, 'dev1');
  const itS = r.body.item || {}, fkS = 'cdoc:c72:S01:pk.con.contract:' + itS.n;
  T('72 cdoc_attach 작은 파일: 종류 검사 400 · 계약 없음 404(파일 남음, 저장 재시도 가능) · 바이트를 서류함으로 옮기고 첨부 레코드 삭제 · AI 판단 parse:<att>는 남음 · 잇는 번호 att0는 색인에만(응답·목록에 안 나감)',
    k1 && k2 && r.code === 200 && mem.gw_files[fkS] && mem.gw_files[fkS].data === PDF('small') && !mem.gw_files[idS] && !!mem.gw_files['parse:' + idS] && mem.gw_data['recidx:c72'].items.find((x) => x.n === itS.n).att0 === idS && itS.att0 === undefined && itS.orig === '착공계 수령.pdf', JSON.stringify([k1, k2, r.code, itS]));
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 1, doc_key: 'pk.con.contract', kind: 'received', att: idS }, tk, 'dev1');
  T('72 cdoc_attach 두 번: 없어진 첨부 404', r.code === 404 && r.body.error_code === 'NOT_FOUND', r.code + '/' + r.body.error_code);
  // 큰 파일 조각
  const P0 = PDF('AAAA'.repeat(40)), body = P0.slice(0, 80), body2 = P0.slice(80, 160), body3 = P0.slice(160);
  r = await call({ action: 'box_put', j: 0, k: 3, name: '스캔 계약서.pdf', size: 999, data: body }, tk, 'dev1');
  const idB = r.body.id, open0 = mem.gw_files[idB] && mem.gw_files[idB].open === 1 && r.body.done === false;
  const r2 = await call({ action: 'box_put', id: idB, j: 1, k: 3, name: '스캔 계약서.pdf', data: body2 }, tkB, 'dev1');
  const notOwner = r2.code === 409 && r2.body.error_code === 'BAD_UPLOAD';
  const r3 = await call({ action: 'cdoc_attach', cid: 'c72', i: 1, doc_key: 'pk.con.bond', kind: 'received', att: idB }, tk, 'dev1');
  const midAttach = r3.code === 409 && r3.body.error_code === 'PART_MISSING';
  await call({ action: 'box_put', id: idB, j: 1, k: 3, name: '스캔 계약서.pdf', data: body2 }, tk, 'dev1');
  r = await call({ action: 'box_put', id: idB, j: 2, k: 3, name: '스캔 계약서.pdf', data: body3 }, tk, 'dev1');
  const mB = mem.gw_files[idB];
  T('72 box_put 3조각: 첫 조각 뒤 미완 표식 · 남의 조각 409 · 미완이면 서류함에 못 넣음(409) · 마지막에 done·표식 제거·parts 3 · 조각 키 3',
    open0 && notOwner && midAttach && r.body.done === true && mB && !mB.open && mB.parts === 3 && !mB.data && mem.gw_files[BF.attPartKey(idB, 2)].data === body3, JSON.stringify([open0, notOwner, midAttach, r.body, mB]));
  T('72 boxfile: 조각을 이으면 원본 base64', (await BF.attReadB64('gw_files', idB, mB)) === P0, '');
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 1, doc_key: 'pk.con.bond', kind: 'received', att: idB }, tk, 'dev1');
  const itB = r.body.item || {}, fkB = 'cdoc:c72:S01:pk.con.bond:' + itB.n;
  T('72 cdoc_attach 큰 파일: 조각은 그대로, 서류함 레코드는 참조(att·parts, data 없음) · 첨부에 taken 표식 · 색인 parts',
    r.code === 200 && mem.gw_files[fkB].att === idB && mem.gw_files[fkB].parts === 3 && !mem.gw_files[fkB].data && mem.gw_files[idB].taken.n === itB.n && itB.parts === 3, JSON.stringify([r.code, mem.gw_files[fkB], itB]));
  const r4 = await call({ action: 'cdoc_attach', cid: 'c72', i: 2, doc_key: 'x', kind: 'received', att: idB }, tk, 'dev1');
  const r5 = await call({ action: 'att_del', id: idB }, tk, 'dev1');
  T('72 넣은 뒤 다시 넣기 409 ALREADY_TAKEN · att_del로 조각을 못 지움(409)', r4.code === 409 && r4.body.error_code === 'ALREADY_TAKEN' && r5.code === 409 && !!mem.gw_files[BF.attPartKey(idB, 0)], JSON.stringify([r4.code, r5.code]));
  const lg0 = ((mem.gw_data[Object.keys(mem.gw_data).find((x) => x.indexOf('reclog:') === 0)] || {}).items || []).length;
  r = await call({ action: 'cdoc_get', cid: 'c72', n: itB.n }, tk, 'dev1');
  const gm = r.code === 200 && r.body.parts === 3 && !r.body.data;
  let joined = '';
  for (let j = 0; j < 3; j++) { const rp = await call({ action: 'cdoc_get', cid: 'c72', n: itB.n, part: j }, tk, 'dev1'); joined += rp.body.data || ''; }
  const rx = await call({ action: 'cdoc_get', cid: 'c72', n: itB.n, part: 3 }, tk, 'dev1');
  const lg1 = ((mem.gw_data[Object.keys(mem.gw_data).find((x) => x.indexOf('reclog:') === 0)] || {}).items || []).length;
  T('72 cdoc_get 큰 파일: 첫 호출은 조각 수만 · part로 받아 이으면 원본 · 범위 밖 400 · 열람 기록 1번만', gm && joined === P0 && rx.code === 400 && lg1 === lg0 + 1, JSON.stringify([gm, joined === P0, rx.code, lg0, lg1]));
  // 중복
  r = await call({ action: 'box_put', j: 0, k: 1, name: '같은내용.pdf', data: PDF('small') }, tk, 'dev1'); const idD = r.body.id;
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 3, doc_key: 'etc.box', kind: 'received', att: idD }, tk, 'dev1');
  const dup1 = r.code === 409 && r.body.error_code === 'DUP_BYTES' && !!mem.gw_files[idD];
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 3, doc_key: 'etc.box', kind: 'received', att: idD, allow_dup: true }, tk, 'dev1');
  T('72 같은 내용: 409 DUP_BYTES(파일 남음) → allow_dup이면 넣음', dup1 && r.code === 200 && !mem.gw_files[idD], JSON.stringify([dup1, r.code]));
  // 초안 짝 — 다른 단계 초안·같은 단계 초안 둘
  const XLSX = fsz.existsSync(join(ROOT, 'tools', 'out')) ? null : null;
  const mkXlsx = () => {   // 최소 xlsx(저장식 zip)
    const crc = (bf) => { let c, t = crc._t || (crc._t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; })); c = 0xFFFFFFFF; for (const x of bf) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const files = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>착공계</t></is></c><c r="B1" t="inlineStr"><is><t>고친값</t></is></c></row></sheetData></worksheet>' };
    const ls = [], cd = []; let off = 0;
    for (const nm of Object.keys(files)) {
      const nb = Buffer.from(nm), db = Buffer.from(files[nm]), cc = crc(db);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(cc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(cc, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      ls.push(lh, nb, db); cd.push(ch, nb); off += 30 + nb.length + db.length;
    }
    const cdb = Buffer.concat(cd), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
    return Buffer.concat(ls.concat([cdb, e]));
  };
  const xb = mkXlsx(), EDITS72 = { Sheet1: [['A1', '착공계', 's'], ['B1', '초안값', 's']] };
  await call({ action: 'cdoc_put', cid: 'c72', i: 1, doc_key: 'gen.work_start', kind: 'draft', pii: 1, fill: { tpl: 'work_start', at: '2026-11-06', edits: EDITS72 } }, tk, 'dev1');
  await call({ action: 'cdoc_put', cid: 'c72', i: 2, doc_key: 'gen.safety_cost', kind: 'draft', pii: 1, fill: { tpl: 'safety_cost', at: '2026-11-06', edits: EDITS72 } }, tk, 'dev1');
  await call({ action: 'cdoc_put', cid: 'c72', i: 2, doc_key: 'gen.work_complete', kind: 'draft', pii: 1, fill: { tpl: 'work_complete', at: '2026-11-06', edits: EDITS72 } }, tk, 'dev1');
  r = await call({ action: 'box_put', j: 0, k: 1, name: '착공계_최종.xlsx', data: xb.toString('base64') }, tk, 'dev1'); const idX = r.body.id;
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 2, doc_key: 'main.작성-0', kind: 'final', att: idX, pair_tpl: 'work_start' }, tk, 'dev1');
  const Lx = r.body.learn || {}, pairX = mem.gw_data['learn:contract:in:' + Lx.id] || {}, itX = r.body.item || {};
  T('72 짝: 초안이 다른 단계(1)에 있어도 서류 이름으로 정한 양식(pair_tpl)이면 짝 · draft_i 기록 · 칸 비교 간극 50% · 색인에 짝 번호',
    r.code === 200 && Lx.ok && Lx.tpl === 'work_start' && pairX.draft_i === 1 && pairX.i === 2 && Lx.gap && Lx.gap.cell_ratio === 0.5 && itX.pair === Lx.id, JSON.stringify([r.code, Lx, pairX, itX.pair]));
  r = await call({ action: 'box_put', j: 0, k: 1, name: '착공계_또.xlsx', data: Buffer.concat([xb, Buffer.from([0])]).toString('base64') }, tk, 'dev1'); const idX2 = r.body.id;
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 2, doc_key: 'main.작성-1', kind: 'final', att: idX2 }, tk, 'dev1');
  T('72 짝: 양식을 못 정하고 같은 단계 초안이 둘이면 종전처럼 미매칭(자동 판단 없음)', r.code === 200 && r.body.learn && r.body.learn.status === 'unmatched', JSON.stringify(r.body.learn));
  // 옮기기
  const fixes0 = (mem.gw_data['box:fixes'] || { items: [] }).items.length;
  const lessonsWS = () => (mem.gw_data['lessons:contract:work_start'] || { gaps: [] }).gaps.filter((g) => g.pair === Lx.id).length;
  const lessBefore = lessonsWS();
  r = await call({ action: 'cdoc_move', cid: 'c72', n: itX.n, i: 3, doc_key: 'main.수령-0', kind: 'received', fix: { doc: '착공계', from: '착공 › 착공계', to: '준공 › 공문' } }, tk, 'dev1');
  const oldK = 'cdoc:c72:S02:main.작성-0:' + itX.n, newK = 'cdoc:c72:S03:main.수령-0:' + itX.n, idxM = mem.gw_data['recidx:c72'], itM = idxM.items.find((x) => x.n === itX.n), fx = mem.gw_data['box:fixes'].items.slice(-1)[0];
  T('72 cdoc_move: 바이트 키 이동 · 색인(단계·서류·종류·판·현재) 갱신 · 옛 짝 superseded·간극 행 제거 · 고친 내용은 box:fixes(파일 이름 없음) · 감사',
    r.code === 200 && !mem.gw_files[oldK] && !!mem.gw_files[newK] && mem.gw_files[newK].kind === 'received' && itM.i === 3 && itM.dk === 'main.수령-0' && itM.kind === 'received' && itM.cur === 1 && itM.ver === 1 && !itM.pair && pairX && mem.gw_data['learn:contract:in:' + Lx.id].status === 'superseded' && lessBefore === 1 && lessonsWS() === 0 && mem.gw_data['box:fixes'].items.length === fixes0 + 1 && fx.k === 'doc' && fx.doc === '착공계' && JSON.stringify(fx).indexOf('최종.xlsx') < 0, JSON.stringify([r.code, itM, fx, lessBefore]));
  r = await call({ action: 'cdoc_move', cid: 'c72', n: itX.n, i: 3, doc_key: 'main.수령-0', kind: 'received' }, tk, 'dev1');
  const nc1 = r.code === 400 && r.body.error_code === 'NO_CHANGE';
  const drN = mem.gw_data['recidx:c72'].items.find((x) => x.kind === 'draft').n;
  r = await call({ action: 'cdoc_move', cid: 'c72', n: drN, i: 3, doc_key: 'a', kind: 'received' }, tk, 'dev1');
  const nc2 = r.code === 400 && r.body.error_code === 'BAD_KIND';
  r = await call({ action: 'cdoc_move', cid: 'c72', n: itX.n, i: 2, doc_key: 'main.작성-0', kind: 'final', pair_tpl: 'work_start' }, tk, 'dev1');
  T('72 cdoc_move: 같은 자리 400 · 초안은 못 옮김 · 최종본 자리로 되돌리면 새 짝', nc1 && nc2 && r.code === 200 && r.body.learn && r.body.learn.ok && r.body.item.pair === r.body.learn.id, JSON.stringify([nc1, nc2, r.code, r.body.learn]));
  // 자리는 그대로, 종류만·등급만
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'K1.pdf', data: PDF('kf1') }, tk, 'dev1'); const kf1 = (await call({ action: 'cdoc_attach', cid: 'c72', i: 6, doc_key: 'etc.box', kind: 'received', att: r.body.id }, tk, 'dev1')).body.item;
  const kKey = 'cdoc:c72:S06:etc.box:' + kf1.n;
  r = await call({ action: 'cdoc_move', cid: 'c72', n: kf1.n, i: 6, doc_key: 'etc.box', kind: 'final' }, tk, 'dev1');
  const kOk = r.code === 200 && !!mem.gw_files[kKey] && mem.gw_files[kKey].kind === 'final' && mem.gw_data['recidx:c72'].items.find((x) => x.n === kf1.n).kind === 'final';
  const kGet = await call({ action: 'cdoc_get', cid: 'c72', n: kf1.n }, tk, 'dev1');
  T('72 cdoc_move 자리는 그대로·종류만: 바이트가 안 지워짐(같은 키) · 열림', kOk && kGet.code === 200 && kGet.body.data === PDF('kf1'), JSON.stringify([kOk, kGet.code, kGet.body.error_code]));
  blobsMock.hooks.failSet = (k) => k === 'recidx:c72';
  r = await call({ action: 'cdoc_move', cid: 'c72', n: kf1.n, i: 6, doc_key: 'etc.box', kind: 'received' }, tk, 'dev1');
  blobsMock.hooks.failSet = null;
  T('72 cdoc_move 색인 저장 실패: 500 · 같은 키면 원본 되돌림(파일 유지·종류 그대로)', r.code === 500 && !!mem.gw_files[kKey] && mem.gw_files[kKey].kind === 'final' && mem.gw_files[kKey].data === PDF('kf1'), JSON.stringify([r.code, mem.gw_files[kKey] && mem.gw_files[kKey].kind]));
  r = await call({ action: 'cdoc_move', cid: 'c72', n: kf1.n, i: 6, doc_key: 'etc.box', kind: 'final', pii: 1 }, tk, 'dev1');
  const pChanged = r.code === 200 && mem.gw_data['recidx:c72'].items.find((x) => x.n === kf1.n).pii === 1 && mem.gw_files[kKey].pii === 1 && !!mem.gw_files[kKey].data;
  const fixN0 = (mem.gw_data['box:fixes'] || { items: [] }).items.length;
  r = await call({ action: 'cdoc_move', cid: 'c72', n: kf1.n, i: 6, doc_key: 'etc.box', kind: 'final', pii: 1 }, tk, 'dev1');
  T('72 cdoc_move 등급만 고치기: 색인·레코드 반영 · 같은 값이면 NO_CHANGE · 자리 고침으로 안 셈', pChanged && r.code === 400 && r.body.error_code === 'NO_CHANGE' && (mem.gw_data['box:fixes'] || { items: [] }).items.length === fixN0, JSON.stringify([pChanged, r.code]));
  r = await call({ action: 'cdoc_move', cid: 'c72', n: kf1.n, i: 7, doc_key: 'etc.box', kind: 'final', fix: { doc: '010-1234-5678 명단', from: 'A', to: 'B' } }, tk, 'dev1');
  T('72 고친 판단 기록: 전화번호 꼴 문서명은 저장 안 함', r.code === 200 && mem.gw_data['box:fixes'].items.slice(-1)[0].doc === '', JSON.stringify(mem.gw_data['box:fixes'].items.slice(-1)[0]));
  // 현재본 이동: 같은 자리에 둘 → 현재본을 옮기면 앞 판이 현재
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'A1.pdf', data: PDF('a1') }, tk, 'dev1'); const a1 = (await call({ action: 'cdoc_attach', cid: 'c72', i: 4, doc_key: 'main.수령-9', kind: 'received', att: r.body.id }, tk, 'dev1')).body.item;
  r = await call({ action: 'box_put', j: 0, k: 1, name: 'A2.pdf', data: PDF('a2') }, tk, 'dev1'); const a2 = (await call({ action: 'cdoc_attach', cid: 'c72', i: 4, doc_key: 'main.수령-9', kind: 'received', att: r.body.id }, tk, 'dev1')).body.item;
  await call({ action: 'cdoc_move', cid: 'c72', n: a2.n, i: 5, doc_key: 'main.수령-8', kind: 'received' }, tk, 'dev1');
  const ia1 = mem.gw_data['recidx:c72'].items.find((x) => x.n === a1.n);
  T('72 cdoc_move: 현재본을 옮기면 옛 자리의 앞 판이 현재로', ia1.cur === 1, JSON.stringify(ia1));
  // 영구 삭제
  await call({ action: 'cdoc_del', cid: 'c72', n: itB.n }, tk, 'dev1');
  mem.gw_data['recidx:c72'].items.find((x) => x.n === itB.n).del = Date.now() - 31 * 86400000;
  mem.gw_files['parse:' + idB] = { ts: 1, bid: 'ucon72', result: { doc: 'box', cls: 'received' } };
  r = await call({ action: 'cdoc_purge', cid: 'c72', n: itB.n, confirm: true }, tokA, 'dev1');
  T('72 영구 삭제: 큰 파일은 조각·본 레코드·판독값까지', r.code === 200 && !mem.gw_files[BF.attPartKey(idB, 0)] && !mem.gw_files[idB] && !mem.gw_files[fkB] && !mem.gw_files['parse:' + idB], r.code + '/' + r.body.error_code);
  // 넣다 만 파일 — 표식·목록·재전송
  r = await call({ action: 'box_put', j: 0, k: 2, name: '멈춤.pdf', data: PDF('s0') }, tk, 'dev1'); const idO = r.body.id;
  let pd = await call({ action: 'box_pending' }, tk, 'dev1');
  const pdOpen = (pd.body.items || []).find((x) => x.id === idO);
  const pdOther = await call({ action: 'box_pending' }, tkB, 'dev1');
  await call({ action: 'box_put', id: idO, j: 1, k: 2, name: '멈춤.pdf', data: b('s1') }, tk, 'dev1');
  r = await call({ action: 'box_put', id: idO, j: 1, k: 2, name: '멈춤.pdf', data: b('s1') }, tk, 'dev1');
  const resend = r.code === 200 && r.body.done === true;
  mem.gw_files['parse:' + idO] = { ts: 1, bid: 'ucon72', result: { doc: 'box', cls: 'filled' } };
  pd = await call({ action: 'box_pending' }, tk, 'dev1');
  const pdDone = (pd.body.items || []).find((x) => x.id === idO);
  mem.gw_files['boxp:' + idO].ts = Date.now() - 2 * 86400000;
  const pdAdmin = await call({ action: 'box_pending' }, tokA, 'dev1');
  T('72 넣다 만 파일: 본인 목록(미완 표시) · 남에겐 안 보임 · 마지막 조각 재전송은 성공 · 판단 결과 함께 · 관리자는 하루 지난 남의 것도', pdOpen && pdOpen.open === 1 && !(pdOther.body.items || []).some((x) => x.id === idO) && resend && pdDone && pdDone.parsed.cls === 'filled' && (pdAdmin.body.items || []).some((x) => x.id === idO), JSON.stringify([pdOpen, resend, pdDone]));
  r = await call({ action: 'cdoc_attach', cid: 'c72', i: 7, doc_key: 'etc.box', kind: 'received', att: idO }, tk, 'dev1');
  pd = await call({ action: 'box_pending' }, tk, 'dev1');
  const noMark = !mem.gw_files['boxp:' + idO] && !(pd.body.items || []).some((x) => x.id === idO);
  r = await call({ action: 'box_put', j: 0, k: 1, name: '버릴.pdf', data: PDF('bin') }, tk, 'dev1'); const idBin = r.body.id, had = !!mem.gw_files['boxp:' + idBin];
  await call({ action: 'att_del', id: idBin }, tk, 'dev1');
  T('72 넣다 만 표식: 넣으면 지움 · 버리면 지움', noMark && had && !mem.gw_files['boxp:' + idBin], JSON.stringify([noMark, had]));
  // att_del — 넣기 전 버리기
  r = await call({ action: 'box_put', j: 0, k: 2, name: '버림.pdf', data: PDF('d0') }, tk, 'dev1'); const idZ = r.body.id;
  await call({ action: 'box_put', id: idZ, j: 1, k: 2, name: '버림.pdf', data: b('x') }, tk, 'dev1');
  r = await call({ action: 'att_del', id: idZ }, tk, 'dev1');
  T('72 넣기 전 버리기: 조각까지 지움', r.code === 200 && !mem.gw_files[idZ] && !mem.gw_files[BF.attPartKey(idZ, 0)] && !mem.gw_files[BF.attPartKey(idZ, 1)], '');
  // box_fix
  const ym = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7), ukey = 'usage:box:' + ym;
  r = await call({ action: 'box_fix', ok: true }, tk);
  const okN = mem.gw_data[ukey].ok;
  const f0 = mem.gw_data['box:fixes'].items.length;
  r = await call({ action: 'box_fix', title: '하수도 준설', from: { type: 'demolition', pub: true, x: 'y' }, to: { type: 'dredge', pub: true } }, tk);
  const fr0 = mem.gw_data['box:fixes'].items.slice(-1)[0];
  T('72 box_fix: 그대로 뒀으면 ok만 세고, 고쳤으면 box:fixes에 분류값만(다른 키 버림) · 사용량 placed·moved 계수', okN === 1 && mem.gw_data['box:fixes'].items.length === f0 + 1 && fr0.k === 'contract' && fr0.to.type === 'dredge' && fr0.from.x === undefined && mem.gw_data[ukey].fixed === 1 && mem.gw_data[ukey].placed >= 5 && mem.gw_data[ukey].moved >= 2, JSON.stringify([okN, fr0, mem.gw_data[ukey]]));
  for (let i = 0; i < 70; i++) await call({ action: 'box_fix', title: 't' + i, from: { type: 'a' }, to: { type: 'b' } }, tk);
  T('72 box_fix 상한: 60행만 남김', mem.gw_data['box:fixes'].items.length === 60, String(mem.gw_data['box:fixes'].items.length));
  // ---- 판단 모듈 ----
  const ctx = { docs: [{ id: 's|main|2|작성:0', n: '착공계', s: '착공서류 작성' }], cons: [{ id: 'c1', t: '공사', c: '공단', s: '현장' }], tpls: [{ k: 'work_start', n: '착공계' }], drafts: [{ tpl: 'work_start', n: '착공계' }] };
  const nj = BJ.normJudge({ cls: 'contract', sub: 'none', doc_name: '계약서', pii: '0', title: '공사', amount: 1000, date_contract: '2026-11-06', date_start: '2026년', date_end: '', client: '010-1234-5678', site: '포항', guarantee: 0, con_type: 'dredge', combo: false, pub: true, why_type: '준설', why_pub: '공단', our_side: '을', target: '없는id', contract_id: 'c1', tpl_key: 'nope', draft_tpl: 'work_start', why: '' }, ctx);
  T('72 판단 정리: 목록 밖 id 버림 · 날짜 형식 · 연락처 꼴 칸 비움 · 값 유지', nj.cls === 'contract' && nj.target === '' && nj.contract_id === 'c1' && nj.tpl_key === '' && nj.draft_tpl === 'work_start' && nj.con.d1 === '2026-11-06' && nj.con.d2 === '' && nj.con.client === '' && nj.con.title === '공사' && nj.con_type === 'dredge', JSON.stringify(nj));
  const nj2 = BJ.normJudge({ cls: '이상', pii: '2', con_type: 'dredge', title: '값', target: 's|main|2|작성:0' }, ctx);
  T('72 판단 정리: 모르는 종류 other · 계약서가 아니면 계약 값 없음 · 민감 등급 2', nj2.cls === 'other' && nj2.con === null && nj2.con_type === 'none' && nj2.pii === 2 && nj2.target === 's|main|2|작성:0', JSON.stringify(nj2));
  const g70 = BJ.nameGuard('2026 건강진단 결과표.pdf'), g71 = BJ.nameGuard('근로자 명단.xlsx'), g72 = BJ.nameGuard('대표 신분증.jpg'), g73 = BJ.nameGuard('착공계.xlsx');
  T('72 개인정보 파일명: 건강진단 2 · 명단 1 · 신분증 1(값 판독 없음 sub none) · 모델 안 씀(read none) · 문서 이름도 비움 · 일반 파일은 통과', g70.pii === 2 && g70.read === 'none' && g70.doc_name === '' && g71.pii === 1 && g72.sub === 'none' && g73 === null, JSON.stringify([g70, g71, g72, g73]));
  const pass72 = ['상대동 주민센터 석면철거공사 계약서.pdf', '국민건강보험공단 포항지사 석면해체공사 계약서.pdf', '건강증진센터 철거공사 계약서.hwp', '건강보험 완납증명서.pdf', '주민설명회 자료.pdf', '건강검진센터 철거공사 계약서.pdf'].filter((n) => BJ.nameGuard(n)).length;
  const h72 = ['김철수 건강 진단 결과표.pdf', '일반건강검사 결과.pdf', 'health_check_2026.pdf', '검진표.jpg'].filter((n) => (BJ.nameGuard(n) || {}).pii === 2).length;
  T('72 입구 가드: 주민센터·건강보험공단 계약서·건강보험 완납증명은 안 막음 · 건강진단 표기 변형은 등급 2 · NFD 파일명도 잡음', pass72 === 0 && h72 === 4 && !!BJ.nameGuard('근로자 명단.xlsx'.normalize('NFD')), JSON.stringify([pass72, h72]));
  T('72 본문 주민번호 꼴 가림: 하이픈·외국인등록번호·13자리', BJ.maskRrn('홍 900101-1234567 끝') === '홍 [주민번호 가림] 끝' && BJ.maskRrn('850101-5234567') === '[주민번호 가림]' && BJ.maskRrn('A1=8501011234567') === 'A1=[주민번호 가림]' && BJ.maskRrn('금액 1234567890123') === '금액 1234567890123', BJ.maskRrn('A1=8501011234567'));
  const pr = BJ.buildPrompt('a.xlsx', ctx, [{ k: 'doc', doc: '착공계', from: 'A', to: 'B' }, { k: 'contract', title: '공사', from: { type: 'demolition' }, to: { type: 'dredge' } }], '본문 900101-1234567', 'text');
  T('72 프롬프트: 서류·계약·양식·초안 목록 · 사람이 고친 판단 · 본문은 가려서', /s\|main\|2\|작성:0 = 착공서류 작성 > 착공계/.test(pr) && /c1 = 공단/.test(pr) && /work_start = 착공계/.test(pr) && /착공계 서류: A → B/.test(pr) && /type demolition→dredge/.test(pr) && pr.indexOf('900101-1234567') < 0, pr.slice(-400));
  T('72 extractText: 최소 xlsx 칸 글자', /A1=착공계/.test(BJ.extractText('xlsx', xb)) && BJ.extractText('pdf', xb) === '', BJ.extractText('xlsx', xb));
  // 모델 호출 mock — 형식·재시도·백그라운드 저장
  const realFetch = global.fetch, savedKey = process.env.GW_ANTHROPIC_KEY, reqs = []; let mode = 'ok';
  const judgeOut = { cls: 'filled', sub: 'none', doc_name: '착공계', pii: '0', title: '', amount: 0, date_contract: '', date_start: '', date_end: '', client: '', site: '', guarantee: 0, con_type: 'none', combo: false, pub: true, why_type: '', why_pub: '', our_side: '모름', target: 's|main|2|작성:0', contract_id: '', tpl_key: '', draft_tpl: 'work_start', why: '제목' };
  global.fetch = async (url, o) => { const q = JSON.parse(o.body); reqs.push(q); if (mode === 'err500') return { status: 500, text: async () => 'x' }; if (mode === 'err500once') { mode = 'ok'; return { status: 500, text: async () => 'x' }; } return { status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(judgeOut) }], usage: { input_tokens: 100, output_tokens: 20 } }) }; };
  process.env.GW_ANTHROPIC_KEY = 'test-key';
  try {
    let j1 = await BJ.judgeBox({ name: '착공계.pdf', b64: PDF('x'), ctx: ctx, fixes: [] });
    const q1 = reqs[reqs.length - 1];
    T('72 judgeBox pdf: document 블록 + 구조화 출력(스키마) · 정리된 결과 · read vision · 사용량', q1.messages[0].content[0].type === 'document' && q1.output_config.format.type === 'json_schema' && j1.doc === 'box' && j1.cls === 'filled' && j1.target === 's|main|2|작성:0' && j1.read === 'vision' && j1.usage.in === 100, JSON.stringify(j1));
    await BJ.judgeBox({ name: '착공계.xlsx', b64: xb.toString('base64'), ctx: {}, fixes: [] });
    const q2 = reqs[reqs.length - 1];
    T('72 judgeBox xlsx: 파일을 그대로 안 보내고 본문 글자만', q2.messages[0].content.length === 1 && q2.messages[0].content[0].type === 'text' && /A1=착공계/.test(q2.messages[0].content[0].text), JSON.stringify(q2.messages[0].content[0]).slice(0, 200));
    const n0 = reqs.length; const j3 = await BJ.judgeBox({ name: '건강진단.pdf', b64: PDF('x'), ctx: {}, fixes: [] });
    T('72 judgeBox 개인정보 파일명: 모델 호출 0', reqs.length === n0 && j3.read === 'none' && j3.pii === 2, '');
    mode = 'err500once'; const n1 = reqs.length; const j4 = await BJ.judgeBox({ name: '착공계.pdf', b64: PDF('x'), ctx: {}, fixes: [] });
    T('72 judgeBox 서버 오류 1회 재시도', reqs.length === n1 + 2 && j4.doc === 'box', String(reqs.length - n1));
    mode = 'err500'; const j5 = await BJ.judgeBox({ name: '착공계.pdf', b64: PDF('x'), ctx: {}, fixes: [] }); mode = 'ok';
    T('72 judgeBox 계속 실패: error만 돌려줌', j5.error === 'SERVER', JSON.stringify(j5));
    // 백그라운드
    r = await call({ action: 'box_put', j: 0, k: 2, name: '착공계_판단.pdf', data: PDF('p0') }, tk, 'dev1'); const idP = r.body.id;
    await call({ action: 'box_put', id: idP, j: 1, k: 2, name: '착공계_판단.pdf', data: b('p1') }, tk, 'dev1');
    const u0 = (mem.gw_data[ukey].calls || 0), nq = reqs.length;
    await pb.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tkB }, body: JSON.stringify({ id: idP, box: 1, ctx: ctx }) });
    const notOwn = !mem.gw_files['parse:' + idP] && reqs.length === nq;
    await pb.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tk }, body: JSON.stringify({ id: idP, box: 1, ctx: ctx }) });
    const pr1 = mem.gw_files['parse:' + idP], qp = reqs[reqs.length - 1];
    T('72 백그라운드: 남이 올린 파일은 판독 안 함 · 조각을 이어 모델에 · 사람이 고친 판단이 프롬프트에 · 결과 parse:<id> · 사용량 calls', notOwn && pr1.result.doc === 'box' && pr1.result.cls === 'filled' && qp.messages[0].content[0].source.data === PDF('p0') + b('p1') && /사람이 최근에 고친 판단/.test(qp.messages[0].content[1].text) && mem.gw_data[ukey].calls === u0 + 1, JSON.stringify([notOwn, pr1.result.doc, mem.gw_data[ukey]]));
    r = await call({ action: 'att_parse_status', id: idP }, tk, 'dev1');
    const psOwn = r.body.status === 'OK' && r.body.parsed.doc === 'box';
    r = await call({ action: 'att_parse_status', id: idP }, tkB, 'dev1');
    const psOther = r.code === 403 && r.body.error_code === 'NOT_OWNER';
    r = await call({ action: 'att_parse_status', id: idP }, tokA, 'dev1');
    const psAdmin = r.body.status === 'OK';
    const U72H = { id: 'uhide72', name: '숨김72', admin: false, perms: { con: 'hide' } }; mem.gw_users['member:uhide72'] = U72H;
    r = await call({ action: 'att_parse_status', id: idP }, issueSession(U72H).token, 'dev1');
    T('72 att_parse_status: 올린 사람·관리자만(남 403 · 계약 숨김 403)', psOwn && psOther && psAdmin && r.code === 403, JSON.stringify([psOwn, psOther, psAdmin, r.code]));
    // 남이 부른 판독은 판단 원본을 덮지 않는다 · 전용 판독은 파일명 가드를 지난다 · 버린 파일에 결과를 되살리지 않는다
    const before = JSON.stringify(mem.gw_files['parse:' + idP]);
    await pb.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tkB }, body: JSON.stringify({ id: idP, box: 1, ctx: {} }) });
    const keep1 = JSON.stringify(mem.gw_files['parse:' + idP]) === before;
    r = await call({ action: 'box_put', j: 0, k: 1, name: '대표 신분증.jpg', data: Buffer.from([0xFF, 0xD8, 0xFF, 0, 1, 2, 3, 4]).toString('base64') }, tk, 'dev1'); const idG = r.body.id, nq2 = reqs.length;
    await pb.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tk }, body: JSON.stringify({ id: idG, box: 1, kind: 'biz' }) });
    const guardKind = reqs.length === nq2 && mem.gw_files['parse:' + idG].result.error === 'PII_NAME';
    r = await call({ action: 'box_put', j: 0, k: 1, name: '착공계_버림.pdf', data: PDF('gone') }, tk, 'dev1'); const idV = r.body.id, ff = global.fetch;
    global.fetch = async (u, o) => { delete mem.gw_files[idV]; return ff(u, o); };
    await pb.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tk }, body: JSON.stringify({ id: idV, box: 1, ctx: {} }) });
    global.fetch = ff;
    T('72 백그라운드: 남이 불러도 원본 유지 · 신분증 파일명은 전용 판독도 모델 호출 0 · 판단 중 버리면 결과를 안 씀', keep1 && guardKind && !mem.gw_files['parse:' + idV], JSON.stringify([keep1, guardKind, !!mem.gw_files['parse:' + idV]]));
    // 큰 파일·잘림
    const nq3 = reqs.length;
    const jBig = await BJ.judgeBox({ name: '큰 스캔.pdf', b64: 'A'.repeat(31000004), ctx: {}, fixes: [] });
    const qBig = reqs[reqs.length - 1];
    T('72 judgeBox 요청 한도를 넘는 PDF: 파일을 안 보내고 파일명으로만 판단', reqs.length === nq3 + 1 && qBig.messages[0].content.length === 1 && qBig.messages[0].content[0].type === 'text' && jBig.read === 'name', JSON.stringify([jBig.read, qBig.messages[0].content.length]));
    const ff2 = global.fetch; global.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"cls":' }], usage: { input_tokens: 9, output_tokens: 6000 } }) });
    const jCut = await BJ.judgeBox({ name: '착공계.pdf', b64: PDF('x'), ctx: {}, fixes: [] });
    global.fetch = ff2;
    T('72 judgeBox 답이 잘리면 MAX_TOKENS 오류 + 사용량', jCut.error === 'MAX_TOKENS' && jCut.usage.out === 6000, JSON.stringify(jCut));
  } finally { global.fetch = realFetch; if (savedKey === undefined) delete process.env.GW_ANTHROPIC_KEY; else process.env.GW_ANTHROPIC_KEY = savedKey; }
  // 정리 — 뒤 절에 영향 없게
  delete mem.gw_data['recidx:c72']; delete mem.gw_data['box:fixes']; delete mem.gw_data[ukey];
  Object.keys(mem.gw_data).filter((k) => k.indexOf('learn:contract:in:') === 0 || k.indexOf('lessons:contract:') === 0).forEach((k) => delete mem.gw_data[k]);
  Object.keys(mem.gw_files).filter((k) => /^(cdoc:c72|attp:|boxp:|parse:att_)/.test(k)).forEach((k) => delete mem.gw_files[k]);
}

{ // ---- 73(v424) 체크 31 브리핑 1단계·물어보기 — 표식·hwpx 문단·내용 일치율·초안 파일째 저장·짝 정보·워커 가드·판단 표식 + 물어보기 문서 공개범위 ----
  const DD = require(join(FN, '_lib/docdiff.js')), BJ = require(join(FN, '_lib/boxjudge.js')), pb = require(join(FN, 'gw-parse-background.js')), lw = require(join(FN, 'gw-learn-background.js')), A = require(join(FN, '_lib/ask.js'));
  mem.gw_files = mem.gw_files || {};
  const U = { id: 'ucon73', name: '공무73', admin: false, perms: { con: 'do' }, dept: '운영부' };
  mem.gw_users['member:ucon73'] = U; const tk = issueSession(U).token;
  mem.gw_data['col:contracts'] = { schema: 1, items: [{ id: 'c73', title: '표식 계약', scen: 'dredge:pub', stages: [] }, { id: 'c73b', title: '다른 계약', scen: 'dredge:pub', stages: [] }], updated_at: 1 };
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bf) => { let c = 0xFFFFFFFF; for (const x of bf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const mkZip = (files) => {
    const ls = [], cd = []; let off = 0;
    for (const nm of Object.keys(files)) {
      const nb = Buffer.from(nm), db = Buffer.from(files[nm]), cc = crc(db);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(cc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(cc, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      ls.push(lh, nb, db); cd.push(ch, nb); off += 30 + nb.length + db.length;
    }
    const cdb = Buffer.concat(cd), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
    return Buffer.concat(ls.concat([cdb, e]));
  };
  const hpf = (m) => '<opf:package><opf:metadata><opf:title/><opf:meta name="keyword" content="text"' + (m ? '>' + m + '</opf:meta>' : '/>') + '</opf:metadata></opf:package>';
  const para = (t) => '<hp:p id="0"><hp:run charPrIDRef="1"><hp:t>' + t + '</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p>';
  const mkHwpx = (lines, m, cell) => mkZip({ mimetype: 'application/hwp+zip', 'Contents/content.hpf': hpf(m), 'Contents/section0.xml': '<hs:sec>' + lines.map(para).join('') + (cell ? '<hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList>' + para(cell) + '</hp:subList></hp:tc></hp:tr></hp:tbl><hp:t/></hp:run></hp:p>' : '') + '</hs:sec>' });
  const mkXl = (cells, m, sheet) => mkZip({ '[Content_Types].xml': '<Types/>', 'docProps/core.xml': '<cp:coreProperties>' + (m ? '<cp:keywords>' + m + '</cp:keywords>' : '') + '</cp:coreProperties>', 'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="' + (sheet || '착공계') + '" sheetId="1" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1">' + Object.keys(cells).map((k) => /^=/.test(cells[k]) ? '<c r="' + k + '"><f>' + cells[k].slice(1) + '</f><v>1</v></c>' : '<c r="' + k + '" t="inlineStr"><is><t>' + cells[k] + '</t></is></c>').join('') + '</row></sheetData></worksheet>' });
  const M1 = 'JWG1.c73.work_start.abc123def0', MH = 'JWG1.c73.contract_pledge.h1h2h3h4h5', MS = 'JWG1.c73.seal_reg.s1s2s3s4s5';
  // ---- docdiff ----
  const h1 = mkHwpx(['계약명 시험 공사', '금액 1,000원', '위와 같이 서약합니다'], MH, '칸 값');
  const ps = DD.hwpxParas(h1);
  T('73 hwpx 문단: 표 칸 안 문단도 한 문단 · 자기 닫는 hp:t는 건너뜀 · 빈 문단 없음', ps.length === 4 && ps.includes('칸 값') && ps[0] === '계약명 시험 공사', JSON.stringify(ps));
  const fw = mkZip({ 'Contents/section1.xml': '<s>' + para('둘째') + '</s>', 'Contents/section0.xml': '<s><hp:p><hp:run><hp:t>가<hp:fwSpace/>나<hp:tab width="1"/>다 &amp; 라</hp:t></hp:run></hp:p></s>' });
  T('73 hwpx 문단: 구역 번호 순서 · 공백 태그는 띄어쓰기 · 글자 복원', JSON.stringify(DD.hwpxParas(fw)) === JSON.stringify(['가 나 다 & 라', '둘째']), JSON.stringify(DD.hwpxParas(fw)));
  const hd = DD.hwpxParaDiff(h1, mkHwpx(['계약명 시험 공사', '금액 2,000원', '위와 같이 서약합니다'], '', '칸 값'));
  T('73 hwpx 문단 비교: 4문단 중 1 바뀜 25% · 본문 없음 · hwpx 아니면 비교 불가', hd.ok && hd.kind === 'hwpx_para' && hd.ratio === 0.25 && hd.same === 3 && JSON.stringify(hd).indexOf('시험') < 0 && DD.hwpxParaDiff(Buffer.from('xx'), h1).ok === false, JSON.stringify(hd));
  const dx0 = mkXl({ A1: '착공계', B1: '=SUM(A1)', C1: '칸', D1: '' }), dx1 = mkXl({ A1: '착공계', B1: '=SUM(A1)', C1: '고침', E1: '새 칸' });
  const fd = DD.xlsxFileDiff(dx0, dx1), fd2 = DD.xlsxFileDiff(dx0, dx1, ['착공계!C1']), fd3 = DD.xlsxFileDiff(dx0, mkXl({ A1: '착공계' }, '', '다른시트'));
  T('73 xlsx 파일 비교: 수식 빼고 칸마다(바뀜 C1·추가 E1) · 건너뛸 칸 · 시트가 없으면 비교 불가 · 값 없음', fd.ok && fd.compared === 3 && fd.changed === 2 && fd2.changed === 1 && fd2.compared === 2 && fd3.uncomparable === 2 && JSON.stringify(fd).indexOf('고침') < 0, JSON.stringify([fd, fd2, fd3]));
  T('73 표식 읽기: xlsx 키워드 · hwpx 키워드(앞에 다른 글자가 있어도, 여럿이면 끝 것) · 없으면 빈 값 · pdf 빈 값 · 잘못된 번호 해석 거부',
    DD.genMarkOf(mkXl({ A1: 'x' }, M1), 'xlsx') === M1 && DD.genMarkOf(mkHwpx(['x'], 'www.yesform.com\n JWG1.c1.a.b1b1b1 ' + MH), 'hwpx') === MH && DD.genMarkOf(mkXl({ A1: 'x' }), 'xlsx') === '' && DD.genMarkOf(Buffer.from('%PDF'), 'pdf') === '' && JSON.stringify(DD.genMarkParse(M1)) === JSON.stringify({ cid: 'c73', tpl: 'work_start', rand: 'abc123def0' }) && DD.genMarkParse('JWG1.c 1.a.b') === null && DD.genMarkParse('') === null, DD.genMarkOf(mkXl({ A1: 'x' }, M1), 'xlsx'));
  // ---- 초안 파일째 ----
  const b64 = (x) => Buffer.from(x).toString('base64');
  const FILL = { tpl: 'work_start', at: '2026-11-06', edits: { '착공계': [['A1', '착공계', 's'], ['C1', '칸', 's']] } };
  let r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'gen.work_start', kind: 'draft', pii: 1, fill: FILL, name: '착공계.xlsx', data: b64(mkXl({ A1: '착공계', C1: '칸', Z1: '양식' }, M1)), gen: M1 }, tk, 'dev1');
  const it1 = r.body.item || {}, rec1 = mem.gw_files['cdoc:c73:S01:gen.work_start:' + it1.n] || {};
  T('73 초안 파일째: 파일·채움 맵 둘 다 저장 · 색인 ext xlsx·표식 · 표준 이름 · 열면 파일', r.code === 200 && !!rec1.data && rec1.fill && rec1.gen === M1 && it1.ext === 'xlsx' && it1.gen === M1 && /gen\.work_start_v1_\d{8}\.xlsx$/.test(it1.name), JSON.stringify([r.code, it1]));
  r = await call({ action: 'cdoc_get', cid: 'c73', n: it1.n }, tk, 'dev1');
  T('73 초안 열기: 파일 바이트(채움 맵 아님) · 형식 xlsx', r.code === 200 && !!r.body.data && r.body.fill === undefined && /spreadsheet/.test(r.body.type), JSON.stringify([r.code, r.body.type]));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'gen.seal_reg', kind: 'draft', pii: 1, name: '인감계.hwpx', data: b64(mkHwpx(['사용인감계', '위 인감을 사용합니다', '주식회사 종운환경', '대표이사'], MS)), gen: 'JWG1.cOther.seal_reg.s1s2s3s4s5' }, tk, 'dev1');
  const itS = r.body.item || {};
  const badGen = r.code === 200 && !itS.gen;
  await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'gen.contract_pledge', kind: 'draft', pii: 1, name: '서약서.hwpx', data: b64(h1), gen: MH }, tk, 'dev1');
  T('73 초안 표식 검사: 다른 계약·다른 서류 번호는 안 받음(저장은 됨) · 채움 맵 없이 파일만 가능', badGen && mem.gw_data['recidx:c73'].items.find((x) => x.dk === 'gen.contract_pledge').gen === MH, JSON.stringify(itS));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'gen.bad', kind: 'draft', pii: 1, fill: FILL, name: '나쁜.exe', data: b64('x') }, tk, 'dev1');
  const badExt = r.code === 400 && r.body.error_code === 'BAD_EXT';
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'gen.only', kind: 'draft', pii: 1, fill: { tpl: 'only', at: '2026-11-06', edits: {} } }, tk, 'dev1');
  T('73 초안 입구: 파일 형식 검사는 채움 맵이 있어도 · 채움 맵만(옛 방식)도 받음', badExt && r.code === 200 && r.body.item.ext === 'json', JSON.stringify([badExt, r.code]));
  await call({ action: 'cdoc_del', cid: 'c73', n: r.body.item.n }, tk, 'dev1');
  // ---- 짝 ----
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 3, doc_key: 'main.작성-0', kind: 'final', name: '상대동 주민센터 철거공사_착공계.xlsx', data: b64(mkXl({ A1: '착공계', C1: '고친 칸', Z1: '양식', Y1: '직원이 더 씀' }, M1)) }, tk, 'dev1');
  let L = r.body.learn || {}, it = r.body.item || {}, pair = mem.gw_data['learn:contract:in:' + L.id] || {}, ix = mem.gw_data['recidx:c73'].items.find((x) => x.n === it.n);
  T('73 표식 짝: 다른 단계 초안도 표식으로 바로 · 파일명에 "주민"이 있어도 제외 안 함 · 칸 비교 50% · AI가 안 채운 칸(Y1) 따로 · 색인·응답에 양식·간극·초안 번호',
    r.code === 200 && L.ok && L.how === 'mark' && L.tpl === 'work_start' && L.kind === 'xlsx_cell' && L.gap.cell_ratio === 0.5 && pair.draft_i === 1 && pair.how === 'mark' && pair.diff.outside_changed === 1 && pair.diff.refs_outside[0] === '착공계!Y1' && ix.ptpl === 'work_start' && ix.pgap === 0.5 && ix.pkind === 'xlsx_cell' && ix.pdn === it1.n && it.ptpl === 'work_start', JSON.stringify([r.code, L, ix]));
  T('73 짝 블롭에 값 없음(좌표·횟수만)', JSON.stringify(pair).indexOf('고친 칸') < 0 && JSON.stringify(pair).indexOf('직원이 더 씀') < 0, '');
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 3, doc_key: 'main.작성-1', kind: 'final', name: '서약서 최종.hwpx', data: b64(mkHwpx(['계약명 시험 공사', '금액 2,000원', '위와 같이 서약합니다'], MH, '칸 값')) }, tk, 'dev1');
  L = r.body.learn || {};
  T('73 hwpx 표식 짝: 문단 비교 25% · 모델 대상 아님(done_nomodel)', L.ok && L.how === 'mark' && L.kind === 'hwpx_para' && L.gap.cell_ratio === 0.25 && L.status === 'done_nomodel' && L.tpl === 'contract_pledge', JSON.stringify(L));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 5, doc_key: 'main.작성-2', kind: 'final', name: '이름 다른 파일.hwpx', data: b64(mkHwpx(['사용인감계', '위 인감을 사용합니다', '주식회사 종운환경', '대표이사 나종운'])) }, tk, 'dev1');
  L = r.body.learn || {}; pair = mem.gw_data['learn:contract:in:' + L.id] || {};
  T('73 표식 없는 파일: 내용 일치율로 찾음(같은 형식 초안 중 1등, 다른 단계여도) · 일치율 기록', L.ok && L.how === 'content' && L.tpl === 'seal_reg' && L.kind === 'hwpx_para' && pair.match === 0.75, JSON.stringify([L, pair.match]));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 5, doc_key: 'main.작성-2', kind: 'final', name: '이름은 착공계.hwpx', pair_tpl: 'work_start', data: b64(mkHwpx(['사용인감계', '위 인감을 사용합니다', '주식회사 종운환경', '대표이사 나경일'])) }, tk, 'dev1');
  L = r.body.learn || {};
  T('73 이름은 xlsx 초안인데 파일은 hwpx: 형식이 달라 내용으로 다시 찾음', L.ok && L.how === 'content' && L.tpl === 'seal_reg', JSON.stringify(L));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 5, doc_key: 'main.작성-3', kind: 'final', name: '전혀 다른.hwpx', data: b64(mkHwpx(['회의록', '참석자', '안건', '결정'])) }, tk, 'dev1');
  T('73 내용이 전혀 다른 파일: 짝 없음 NO_MATCH(엉뚱한 초안과 안 묶음)', r.code === 200 && r.body.learn.code === 'NO_MATCH', JSON.stringify(r.body.learn));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'main.작성-4', kind: 'final', name: '많이 고친.xlsx', data: b64(mkXl({ A1: '착공계', C1: '전부 고침' })) }, tk, 'dev1');
  L = r.body.learn || {};
  T('73 표식 없는 xlsx: 칸 일치율로 찾음(50%는 많이 고친 수정본)', L.ok && L.tpl === 'work_start' && L.how === 'content', JSON.stringify(L));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'main.작성-5', kind: 'final', name: '스캔.pdf', data: b64('%PDF-1.4 스캔'), pair_tpl: 'work_start' }, tk, 'dev1');
  L = r.body.learn || {}; it = r.body.item || {}; ix = mem.gw_data['recidx:c73'].items.find((x) => x.n === it.n);
  T('73 날인 스캔 pdf: 서류 이름으로 짝 · 비교 불가(간극 없음 null) · 짝은 남음', L.ok && L.how === 'name' && L.kind === 'none' && L.gap.cell_ratio === null && ix.pgap === null && ix.ptpl === 'work_start', JSON.stringify([L, ix]));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'main.작성-6', kind: 'final', name: '수기.hwp', data: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 1, 2]).toString('base64') }, tk, 'dev1');
  T('73 hwp 파일 + 같은 단계 초안 여럿: 내용 비교 불가라 미매칭(자동으로 안 묶음)', r.code === 200 && r.body.learn.status === 'unmatched' && r.body.learn.candidates.length === 3, JSON.stringify(r.body.learn));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 1, doc_key: 'main.작성-7', kind: 'final', name: '건진.xlsx', pii: 2, data: b64(mkXl({ A1: '착공계', C1: '칸' }, M1)) }, tk, 'dev1');
  T('73 민감정보 등급 2: 표식이 있어도 짝을 안 만듦', r.code === 200 && r.body.learn.code === 'TYPE_EXCLUDED', JSON.stringify(r.body.learn));
  const sameB = b64(mkXl({ A1: '그대로' }, 'JWG1.c73.safety_cost.same000000'));
  await call({ action: 'cdoc_put', cid: 'c73', i: 2, doc_key: 'gen.safety_cost', kind: 'draft', pii: 1, name: '내역.xlsx', data: sameB, gen: 'JWG1.c73.safety_cost.same000000' }, tk, 'dev1');
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 2, doc_key: 'main.작성-8', kind: 'final', name: '내역 그대로.xlsx', data: sameB }, tk, 'dev1');
  L = r.body.learn || {};
  T('73 고치지 않고 그대로 넣은 파일: 중복(409) 아님 · 파일 비교 간극 0% · 채움 맵 없는 초안도 비교(xlsx_file)', r.code === 200 && L.ok && L.how === 'mark' && L.kind === 'xlsx_file' && L.gap.cell_ratio === 0, JSON.stringify([r.code, r.body.error_code, L]));
  const itSame = r.body.item;
  r = await call({ action: 'cdoc_move', cid: 'c73', n: itSame.n, i: 2, doc_key: 'main.수령-1', kind: 'received' }, tk, 'dev1');
  ix = mem.gw_data['recidx:c73'].items.find((x) => x.n === itSame.n);
  T('73 옮기기: 수령본으로 옮기면 짝 정보(양식·간극) 지움', r.code === 200 && ix.pair === undefined && ix.ptpl === undefined && ix.pgap === undefined, JSON.stringify(ix));
  // 초안 3판 유지
  const gens = []; for (let i = 0; i < 4; i++) { const g = 'JWG1.c73.adv_pay.v' + i + 'v' + i + 'v' + i + 'v'; gens.push(g); r = await call({ action: 'cdoc_put', cid: 'c73', i: 4, doc_key: 'gen.adv_pay', kind: 'draft', pii: 1, name: '선금.hwpx', data: b64(mkHwpx(['선금 신청', '판 ' + i, '같은 줄', '또 같은 줄'], g)), gen: g }, tk, 'dev1'); }
  const gcN = (r.body.gc || []).length, keys = Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:c73:S04:gen.adv_pay:') === 0).length;
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 4, doc_key: 'main.작성-9', kind: 'final', name: '선금 옛판.hwpx', data: b64(mkHwpx(['선금 신청', '판 0', '같은 줄', '또 같은 줄'], gens[0])) }, tk, 'dev1');
  L = r.body.learn || {};
  T('73 초안 3판 유지: 넷째에 첫 판 바이트 삭제 · 지워진 판의 표식은 못 찾고 내용으로 현재 판과 짝', gcN === 1 && keys === 3 && L.ok && L.how === 'content' && L.tpl === 'adv_pay', JSON.stringify([gcN, keys, L]));
  // 워커 가드
  const svT = issueSession({ id: '__promoai__', role: 'system' }).token, pid = 'lc_aaaaaaaaaaaa';
  mem.gw_data['settings:learn'] = { contract: { on: true, allow: { contract_pledge: ['A1'] } } };
  mem.gw_data['learn:contract:in:' + pid] = { id: pid, cid: 'c73', i: 3, dk: 'main.작성-1', tpl: 'contract_pledge', draft_n: 1, final_n: 1, kind: 'hwpx_para', status: 'pending' };
  await lw.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + svT }, body: JSON.stringify({ pair_id: pid }) });
  T('73 워커: 문단 비교 짝은 모델 호출 없이 간극만(done_nomodel) — 허용 양식이어도', mem.gw_data['learn:contract:in:' + pid].status === 'done_nomodel' && mem.gw_data['learn:contract:in:' + pid].code === 'NO_CELL_MAP', JSON.stringify(mem.gw_data['learn:contract:in:' + pid]));
  r = await call({ action: 'cdoc_put', cid: 'c73', i: 3, doc_key: 'main.작성-10', kind: 'final', name: '서약서 또.hwpx', data: b64(mkHwpx(['계약명 시험 공사', '금액 3,000원', '위와 같이 서약합니다'], MH, '칸 값')) }, tk, 'dev1');
  T('73 허용 사전이 있어도 hwpx 짝은 pending이 아님', r.body.learn.status === 'done_nomodel', JSON.stringify(r.body.learn));
  delete mem.gw_data['settings:learn'];
  // ---- 판단 표식 ----
  const realFetch = global.fetch, savedKey = process.env.GW_ANTHROPIC_KEY; let nReq = 0;
  global.fetch = async () => { nReq++; return { status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ cls: 'other', sub: 'none', doc_name: '', pii: '0', title: '', amount: 0, date_contract: '', date_start: '', date_end: '', client: '', site: '', guarantee: 0, con_type: 'none', combo: false, pub: true, why_type: '', why_pub: '', our_side: '모름', target: '', contract_id: '', tpl_key: '', draft_tpl: '', why: '' }) }], usage: { input_tokens: 1, output_tokens: 1 } }) }; };
  process.env.GW_ANTHROPIC_KEY = 'test-key';
  try {
    const put = async (name, buf) => (await call({ action: 'box_put', j: 0, k: 1, name: name, data: buf.toString('base64') }, tk, 'dev1')).body.id;
    const run = async (id) => { await pb.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tk }, body: JSON.stringify({ id: id, box: 1, ctx: {} }) }); return (mem.gw_files['parse:' + id] || {}).result || {}; };
    const ym = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7), ukey = 'usage:box:' + ym;
    let id = await put('고친 착공계.xlsx', mkXl({ A1: '착공계' }, M1)), j = await run(id);
    T('73 판단 표식: 모델 호출 0 · 계약·양식 바로 · 채운 서류 · read mark · 착공계는 개인정보 1 · 사용량 mark 따로(calls 안 셈)', nReq === 0 && j.read === 'mark' && j.cls === 'filled' && j.contract_id === 'c73' && j.draft_tpl === 'work_start' && j.pii === 1 && mem.gw_data[ukey].mark === 1 && !mem.gw_data[ukey].calls, JSON.stringify([nReq, j, mem.gw_data[ukey]]));
    const hDraft = ['계약명 시험 공사', '금액 1,000원', '위와 같이 서약합니다', '칸 값'];
    id = await put('고친 서약서.hwpx', mkHwpx(hDraft, MH)); j = await run(id);
    const ok2 = nReq === 0 && j.read === 'mark' && j.pii === 0 && j.draft_tpl === 'contract_pledge';
    id = await put('고친 서약서2.hwpx', mkHwpx(hDraft.concat(['대리인 900101-1234567']), MH)); j = await run(id);
    T('73 판단 표식 개인정보: 사람 칸 없는 양식 0 · 본문에 주민번호 꼴이 있으면 1', ok2 && nReq === 0 && j.pii === 1, JSON.stringify([ok2, nReq, j]));
    id = await put('없는 표식.xlsx', mkXl({ A1: '착공계' }, 'JWG1.c73.work_start.nonexist00')); j = await run(id);
    const ok3 = nReq === 1 && j.read !== 'mark';
    id = await put('근로자 명단.xlsx', mkXl({ A1: '명단' }, M1)); j = await run(id);
    T('73 판단 표식: 서류함에 없는 번호는 안 믿고 모델로 · 개인정보 파일명은 표식보다 먼저 걸러 모델도 안 부름', ok3 && nReq === 1 && j.read === 'none' && j.pii === 1, JSON.stringify([ok3, nReq, j]));
  } finally { global.fetch = realFetch; if (savedKey === undefined) delete process.env.GW_ANTHROPIC_KEY; else process.env.GW_ANTHROPIC_KEY = savedKey; }
  // ---- 물어보기 문서 공개범위 ----
  const Staff = { id: 'ustaff73', name: '직원', admin: false, perms: { doc: 'view' }, dept: '운영부' }, Mgmt = { id: 'umgmt73', name: '관리', admin: false, perms: { doc: 'view' }, dept: '관리부' }, Adm = { id: 'uadm73', name: '관리자', admin: true, perms: {} }, Hide = { id: 'uhide73', name: '숨김', admin: false, perms: { doc: 'hide' } };
  const D = (id, o) => Object.assign({ id: id, title: '문서 ' + id, cat: '02-01', no: 'JW-02-01-001' }, o);
  const savedDocs = mem.gw_data['col:documents'], savedSet = mem.gw_data['settings:documents'];
  mem.gw_data['col:documents'] = { schema: 1, items: [D('all', { scope: 'all' }), D('adm', { scope: 'admin' }), D('mg', { scope: 'mgmt' }), D('law', { cat: '01-01', no: 'JW-01-01-001', scope: 'all' }), D('pend', { status: '대기', by: { id: 'other' }, scope: 'all' }), D('mine', { status: '대기', by: { id: 'ustaff73' } }), D('named', { scope: { ids: ['ustaff73'] } }), D('deflt', {}), D('del', { scope: 'all', del: 1 })] };
  mem.gw_data['settings:documents'] = { scope_default: { '02': 'admin' } };
  const ids = async (m, q) => { const o = await A.runTool('documents', { q: q || '' }, m); return (o.rows || []).map((x) => x.제목.replace('문서 ', '')).sort().join(); };
  const st0 = await ids(Staff), mg0 = await ids(Mgmt), ad0 = await ids(Adm), hd0 = await A.runTool('documents', {}, Hide);
  T('73 물어보기 문서: 직원 = 전원 공개·지정·본인 대기만(관리자만·관리부·01 법인·남의 대기·분류 기본 비공개·삭제 안 나옴) · 관리부 = 관리부·01까지 · 관리자 전부 · 숨김 권한 거부', st0 === 'all,mine,named' && mg0 === 'all,law,mg' && ad0.split(',').length === 8 && /권한 없음/.test(hd0.error || ''), JSON.stringify([st0, mg0, ad0, hd0]));
  T('73 물어보기 문서: 검색어로 비공개 문서를 찾아도 안 나옴', (await ids(Staff, '문서 adm')) === '' && (await ids(Adm, '문서 adm')) === 'adm', '');
  mem.gw_data['col:documents'] = { schema: 1, items: Array.from({ length: 40 }, (_, i) => D('h' + i, { scope: 'admin' })).concat([D('open', { scope: 'all' })]) };
  T('73 물어보기 문서: 자르기(25행) 전에 걸러 볼 수 있는 문서가 밀려나지 않음', (await ids(Staff)) === 'open', '');
  const sget = blobsMock.blobGet; blobsMock.hooks.beforeGet = null;
  delete mem.gw_data['settings:documents'];
  mem.gw_data['col:documents'] = { schema: 1, items: [D('deflt2', {})] };
  T('73 물어보기 문서: 설정이 없으면 기본 비공개(가장 닫힌 쪽)', (await ids(Staff)) === '', '');
  if (savedDocs) mem.gw_data['col:documents'] = savedDocs; else delete mem.gw_data['col:documents'];
  if (savedSet) mem.gw_data['settings:documents'] = savedSet;
  // ---- 74 v424 독립 검토 반영 ----
  {
    const LN = require(join(FN, '_lib/learn.js')), A74 = require(join(FN, '_lib/ask.js'));
    const CID = 'c74';
    mem.gw_data['col:contracts'].items.push({ id: CID, title: '검토 계약', scen: 'dredge:pub', stages: [] });
    const ixOf = () => mem.gw_data['recidx:' + CID];
    const putDraft = (tpl, i, name, bytes, gen, extra) => call(Object.assign({ action: 'cdoc_put', cid: CID, i: i, doc_key: 'gen.' + tpl, kind: 'draft', pii: 1, name: name, data: b64(bytes), gen: gen }, extra || {}), tk, 'dev1');
    const putFinal = (i, dk, name, bytes, extra) => call(Object.assign({ action: 'cdoc_put', cid: CID, i: i, doc_key: dk, kind: 'final', name: name, data: b64(bytes), allow_dup: true }, extra || {}), tk, 'dev1');

    // 표식: 사람 칸 있는 양식은 1, 확인한 양식도 새 번호가 생기면 1, 양식 자체 회사 번호는 그대로 0
    const BJ74 = require(join(FN, '_lib/boxjudge.js'));
    const jd = (tpl, buf, db) => BJ74.markJudge('hwpx', buf, { cid: CID, tpl: tpl, draftBuf: db || null }).pii;
    const hw = (x) => mkHwpx(x, 'JWG1.c74.x.a1b2c3d4');
    const ph = '010-1234-5678', co = ['본문', '담당 ' + ph];
    T('74 표식 등급: 안전 대장·비상대응·위험성평가는 1(모르는 양식도 1) · 확인한 양식 0 · 초안에 있던 회사 번호는 0 · 새로 적은 번호는 1 · 주민번호 꼴 1(쪼개진 값·다른 하이픈 포함)',
      jd('safety_ppe', hw(['대장'])) === 1 && jd('safety_emerg', hw(['대응'])) === 1 && jd('safety_risk', hw(['평가'])) === 1 && jd('새양식', hw(['x'])) === 1 && jd('seal_reg', hw(['인감'])) === 0
      && jd('quote_env', hw(co), hw(co)) === 0 && jd('quote_env', hw(co.concat(['기사 010-9999-0000'])), hw(co)) === 1
      && jd('seal_reg', hw(['900101－1234567'])) === 1 && jd('seal_reg', mkZip({ 'Contents/section0.xml': '<s><hp:p><hp:run><hp:t>900101-12</hp:t></hp:run><hp:run><hp:t>34567</hp:t></hp:run></hp:p></s>' })) === 1,
      JSON.stringify([jd('safety_ppe', hw(['대장'])), jd('quote_env', hw(co), hw(co))]));
    T('74 파일명 가드: "공사·용역"이 들어 있어도 건강진단·신분증·명단·인적사항은 막음 · 계약서는 읽음',
      BJ74.nameGuard('구룡포 하수박스 준설공사_건강진단 결과표.pdf') && BJ74.nameGuard('철거공사 신분증 사본.jpg') && BJ74.nameGuard('철강공단 준설공사 근로자 명단.xlsx') && BJ74.nameGuard('용역 인적사항.hwpx') && !BJ74.nameGuard('건강검진센터 철거공사 계약서.pdf') && !BJ74.nameGuard('상대동 주민센터 철거공사_착공계.xlsx'), '');

    // 지난 계약 파일을 복사해 고친 파일 — 표식은 그대로, 내용은 전혀 다름
    const MX = 'JWG1.c74.work_start.aaaabbbb01', FX = { tpl: 'work_start', at: '2026-11-06', edits: { '착공계': [['A1', '가 공사', 's'], ['B1', '가 발주처', 's'], ['C1', '1000', 's'], ['D1', '2026-01-01', 's']] } };
    r = await putDraft('work_start', 1, '착공계.xlsx', mkXl({ A1: '가 공사', B1: '가 발주처', C1: '1000', D1: '2026-01-01', Z1: '양식' }, MX), MX, { fill: FX });
    const dn = r.body.item.n;
    r = await putFinal(2, 'main.a0', '다른 계약 착공계.xlsx', mkXl({ A1: '나 공사', B1: '나 발주처', C1: '2000', D1: '2027-02-02', Z1: '양식' }, MX));
    T('74 표식 + 내용 전혀 다름: 표식을 믿지 않아 짝 없음(간극 안 쌓임)', r.code === 200 && (r.body.learn || {}).ok === false && !ixOf().items.find((x) => x.n === r.body.item.n).pair, JSON.stringify(r.body.learn));
    r = await putFinal(2, 'main.a1', '착공계 고침.xlsx', mkXl({ A1: '가 공사', B1: '가 발주처', C1: '1500', D1: '2026-01-01', Z1: '양식' }, MX));
    const L74 = r.body.learn || {}, nf = r.body.item.n;
    T('74 표식 + 비슷한 내용: 표식 짝 · 색인에 찾은 경로', L74.how === 'mark' && ixOf().items.find((x) => x.n === nf).phow === 'mark' && L74.gap.cell_ratio === 0.25, JSON.stringify(L74));

    // 창고 읽기 실패 때 덮지 않음
    const lk74 = 'lessons:contract:work_start', keep = { schema: 1, off: true, rules: [{ id: 'r1', text: '규칙', scope: 'style', n: 2 }], exemplars: {}, gaps: [], stats: { pairs: 9, calls: 5, tokens: 1 }, updated_at: 1, baseline: { avg: 0.2, n: 10, ts: 1 } };
    mem.gw_data[lk74] = JSON.parse(JSON.stringify(keep));
    blobsMock.hooks.failGet = (k) => k === lk74;
    r = await putFinal(2, 'main.a2', '착공계 고침2.xlsx', mkXl({ A1: '가 공사', B1: '가 발주처', C1: '1600', D1: '2026-01-01', Z1: '양식' }, MX));
    mem.gw_users['member:uadm74'] = { id: 'uadm74', name: '관리', admin: true, perms: {} };
    const rT = await call({ action: 'learn_tpl_set', tpl: 'work_start', off: false }, issueSession({ id: 'uadm74', name: '관리', admin: true, perms: {} }).token);
    blobsMock.hooks.failGet = null;
    T('74 창고 읽기 실패: 규칙·기준선·끔 표시 그대로(최종본은 들어감) · 양식 끄기·켜기는 500', r.code === 200 && mem.gw_data[lk74].rules.length === 1 && mem.gw_data[lk74].off === true && mem.gw_data[lk74].stats.calls === 5 && rT.code === 500, JSON.stringify([r.code, mem.gw_data[lk74].stats, rT.code]));
    delete mem.gw_data[lk74];

    // 다른 서류를 단계 초안에 묶지 않음
    const CC = 'c74b'; mem.gw_data['col:contracts'].items.push({ id: CC, title: '단계 계약', scen: 'dredge:pub', stages: [] });
    const put2 = (o) => call(Object.assign({ action: 'cdoc_put', cid: CC, allow_dup: true }, o), tk, 'dev1');
    const MY = 'JWG1.c74b.work_start.ccccdddd01', FY = { tpl: 'work_start', at: 'x', edits: { '착공계': [['A1', '값', 's']] } };
    await put2({ i: 0, doc_key: 'gen.work_start', kind: 'draft', pii: 1, name: '착공계.xlsx', data: b64(mkXl({ A1: '값' }, MY)), gen: MY, fill: FY });
    let q = await put2({ i: 0, doc_key: 'main.b0', kind: 'final', name: '공사원가계산서.xlsx', data: b64(mkXl({ A1: '원가' }, '', '원가계산서')) });
    const n1 = (q.body.learn || {}).code;
    q = await put2({ i: 0, doc_key: 'main.b1', kind: 'final', name: '회의록.hwpx', data: b64(mkHwpx(['회의 내용'])) });
    const n2 = (q.body.learn || {}).code;
    q = await put2({ i: 0, doc_key: 'main.b2', kind: 'final', name: '회의록2.hwpx', data: b64(mkHwpx(['회의 내용 둘'])), pair_tpl: 'work_start' });
    const n3 = (q.body.learn || {}).code;
    const it3 = mem.gw_data['recidx:' + CC].items.find((x) => x.n === q.body.item.n);
    q = await put2({ i: 0, doc_key: 'main.b3', kind: 'final', name: '날인 스캔.pdf', data: b64('%PDF-1.4 scan') });
    T('74 무관한 파일: 시트 안 겹침·형식 다름·이름만 맞음 모두 NO_MATCH(색인에 사유) · 스캔 pdf만 단계 짝', n1 === 'NO_MATCH' && n2 === 'NO_MATCH' && n3 === 'NO_MATCH' && it3.plearn === 'NO_MATCH' && !it3.ptpl && q.body.learn.how === 'stage', JSON.stringify([n1, n2, n3, q.body.learn]));
    T('74 이번 달 짝 경로 건수가 사용량에 쌓임', (mem.gw_data['usage:box:' + LN.ymOf(Date.now())] || {}).pair_no_match >= 3 && (mem.gw_data['usage:box:' + LN.ymOf(Date.now())] || {}).pair_stage >= 1, JSON.stringify(mem.gw_data['usage:box:' + LN.ymOf(Date.now())]));

    // 보관 → 간극 지움 · 복구 → 다시 짝 · 등급 2 → 무효
    const gapsN = () => ((mem.gw_data[lk74] || {}).gaps || []).length;
    r = await putFinal(2, 'main.a3', '착공계 고침3.xlsx', mkXl({ A1: '가 공사', B1: '가 발주처', C1: '1700', D1: '2026-01-01', Z1: '양식' }, MX));
    const nd = r.body.item.n, pid = r.body.learn.id, g0 = gapsN();
    r = await call({ action: 'cdoc_del', cid: CID, n: nd }, tk, 'dev1');
    const v0 = r.code === 200 && gapsN() === g0 - 1 && mem.gw_data['learn:contract:in:' + pid].status === 'superseded' && !ixOf().items.find((x) => x.n === nd).pair;
    const tkA74 = issueSession({ id: 'uadm74', name: '관리', admin: true, perms: {} }).token; mem.gw_users['member:uadm74'] = { id: 'uadm74', name: '관리', admin: true, perms: {} };
    r = await call({ action: 'cdoc_restore', cid: CID, n: nd }, tkA74);
    const v1 = r.code === 200 && r.body.learn && r.body.learn.how === 'mark' && gapsN() === g0 && !!ixOf().items.find((x) => x.n === nd).pair;
    T('74 보관: 짝 무효·간극 지움 · 복구: 다시 짝·간극', v0 && v1, JSON.stringify([v0, v1, gapsN(), g0]));
    r = await call({ action: 'cdoc_move', cid: CID, n: nd, i: 2, doc_key: 'main.a3', kind: 'final', pii: 2 }, tk, 'dev1');
    T('74 같은 자리에서 등급만 2: 짝 무효·간극 지움', r.code === 200 && !ixOf().items.find((x) => x.n === nd).pair && gapsN() === g0 - 1, JSON.stringify([r.code, r.body.error_code, gapsN()]));

    // 워커: 지운 최종본은 모델에 안 보냄
    mem.gw_data['settings:learn'] = { contract: { on: true, allow: { work_start: ['착공계!A1'] } } };
    r = await putFinal(2, 'main.a4', '착공계 고침4.xlsx', mkXl({ A1: '가 공사 고침', B1: '가 발주처', C1: '1800', D1: '2026-01-01', Z1: '양식' }, MX));
    const pPend = r.body.learn; const nW = r.body.item.n;
    await call({ action: 'cdoc_del', cid: CID, n: nW }, tk, 'dev1');
    const pairW = mem.gw_data['learn:contract:in:' + pPend.id];
    T('74 pending 상태로 보관하면 짝이 무효로 내려간다(워커가 집지 않음)', pPend.status === 'pending' && pairW.status === 'superseded' && LN.pickPending([pairW], Date.now(), LN.TYPES.contract.pair_re, 'cid').length === 0, JSON.stringify(pairW.status));
    delete mem.gw_data['settings:learn'];

    // 사본에서 비운 칸은 비교에서 뺀다 · 색인에 AI 밖 칸 수
    const MZ = 'JWG1.c74.safety_cost.eeeeffff01', FZ = { tpl: 'safety_cost', at: 'x', edits: { '착공계': [['A1', '머리', 's']] } };
    await putDraft('safety_cost', 3, '사용내역서.xlsx', mkXl({ A1: '머리', F13: '' }, MZ), MZ, { fill: FZ, blank: ['착공계!F13', 'bad ref'] });
    const recZ = Object.keys(mem.gw_files).filter((k) => k.indexOf('cdoc:c74:S03:gen.safety_cost') === 0).map((k) => mem.gw_files[k])[0];
    r = await putFinal(3, 'main.a5', '사용내역서 고침.xlsx', mkXl({ A1: '머리', F13: '주민칸', G20: '직원이 적음', G21: '직원이 또 적음' }, MZ));
    const itZ = ixOf().items.find((x) => x.n === r.body.item.n);
    T('74 사본에서 비운 칸은 "AI가 안 채운 칸"에 안 셈 · 잘못된 좌표는 안 받음 · 간극 0%여도 색인에 AI 밖 칸 수', recZ.blank.length === 1 && r.body.learn.gap.cell_ratio === 0 && itZ.pout === 2, JSON.stringify([recZ.blank, r.body.learn.outside, itZ.pout]));

    // 같은 양식을 두 단계에서 만든 경우 — 최근 판 · 오래된 초안이 많아도 최근 초안을 찾음
    const CD = 'c74c'; mem.gw_data['col:contracts'].items.push({ id: CD, title: '대조 계약', scen: 'dredge:pub', stages: [] });
    const put3 = (o) => call(Object.assign({ action: 'cdoc_put', cid: CD, allow_dup: true }, o), tk, 'dev1');
    const lines = ['선금지급 신청서', '계약 건명 시험', '금액 일금', '위와 같이 신청합니다'];
    await put3({ i: 1, doc_key: 'gen.adv_pay', kind: 'draft', pii: 1, name: '선금.hwpx', data: b64(mkHwpx(lines)) });
    const dLate = (await put3({ i: 2, doc_key: 'gen.adv_pay', kind: 'draft', pii: 1, name: '선금.hwpx', data: b64(mkHwpx(lines)) })).body.item.n;
    q = await put3({ i: 3, doc_key: 'main.c0', kind: 'final', name: '고친 선금.hwpx', data: b64(mkHwpx(lines.concat(['추가']))) });
    T('74 같은 양식 동률: 고르게 하지 않고 최근 판과 짝', q.body.learn.ok && q.body.learn.draft_n === dLate && q.body.learn.how === 'content', JSON.stringify(q.body.learn));
    for (let n0 = 0; n0 < 14; n0++) await put3({ i: 5, doc_key: 'gen.t' + n0, kind: 'draft', pii: 1, name: 't' + n0 + '.hwpx', data: b64(mkHwpx(['문서 ' + n0 + ' 첫째', '문서 ' + n0 + ' 둘째', '문서 ' + n0 + ' 셋째'])) });
    q = await put3({ i: 6, doc_key: 'main.c1', kind: 'final', name: '고친 13.hwpx', data: b64(mkHwpx(['문서 13 첫째', '문서 13 둘째', '문서 13 셋째 고침'])) });
    T('74 초안이 많아도 최근 초안부터 대조해 찾음', q.body.learn.ok && q.body.learn.tpl === 't13', JSON.stringify(q.body.learn));

    // 색인 상한은 바이트 없는 옛 초안을 세지 않음
    const CE = 'c74d'; mem.gw_data['col:contracts'].items.push({ id: CE, title: '상한 계약', scen: 'dredge:pub', stages: [] });
    mem.gw_data['recidx:' + CE] = { schema: 1, cid: CE, seq: 400, items: Array.from({ length: 400 }, (_, n0) => ({ n: n0 + 1, i: 0, dk: 'gen.x', kind: 'draft', ver: n0 + 1, cur: 0, gc: n0 < 397 ? 1 : 0, name: 'x', sha: 's' + n0 })) };
    q = await call({ action: 'cdoc_put', cid: CE, i: 0, doc_key: 'main.d0', kind: 'final', name: '스캔.pdf', data: b64('%PDF-1.4 d') }, tk, 'dev1');
    T('74 색인 상한: 바이트가 지워진 옛 초안은 세지 않아 최종본이 막히지 않음', q.code === 200, JSON.stringify([q.code, q.body.error_code]));

    // 짝 번호·간극 줄
    const id1 = LN.newPairId('contract', 'a');
    T('74 짝 번호: 형식 유지 · 앞 8자리가 시각이라 정렬이 시간순', LN.TYPES.contract.pair_re.test(id1) && id1.slice(3, 11) === ('0000000' + Math.floor(Date.now() / 1000).toString(16)).slice(-8) && /^pl_[a-f0-9]{12}$/.test(LN.newPairId('promo', 'a')), id1);
    let Lm = LN.pushGap(null, { pair: 'lc_x', ratio: 0.5 }, 100);
    Lm = LN.mergeLessons(Lm, { rules: [] }, { rec_id: 'c', pair_id: 'lc_x', ex_key: 't', now: 200, tokens: 5, gap: { ratio: 0.5 }, summary: '요약', extra: { kind: 'xlsx_cell' } }, LN.TYPES.contract.scopes);
    T('74 모델이 처리한 짝도 간극 한 줄(기준선 표본이 절반이 되지 않음)', Lm.gaps.length === 1 && Lm.stats.pairs === 1 && Lm.stats.calls === 1 && Lm.gaps[0].summary === '요약' && Lm.gaps[0].ts === 100, JSON.stringify(Lm.gaps));

    // 얼린 기준선에 든 짝을 무효로 하면 다시 잰다
    const lkB = 'lessons:contract:qual_packet', gs = Array.from({ length: 11 }, (_, n0) => ({ pair: 'lc_b' + n0, ratio: n0 === 0 ? 1 : 0, ts: n0 + 1 }));
    const LB = { schema: 1, off: false, rules: [], exemplars: {}, gaps: gs, stats: { pairs: 11, calls: 0, tokens: 0 }, updated_at: 1 }; LN.freezeBaseline(LB, 50);
    const avg0 = LB.baseline.avg; mem.gw_data[lkB] = LB;
    const CF = 'c74e'; mem.gw_data['col:contracts'].items.push({ id: CF, title: '기준선', scen: 'dredge:pub', stages: [] });
    mem.gw_data['learn:contract:in:lc_b0'] = { id: 'lc_b0', tpl: 'qual_packet', status: 'done_nomodel', cid: CF };
    mem.gw_data['recidx:' + CF] = { schema: 1, cid: CF, seq: 1, items: [{ n: 1, i: 0, dk: 'main.e0', kind: 'final', ver: 1, cur: 1, name: 'x', pair: 'lc_b0', ptpl: 'qual_packet', ext: 'pdf', sha: 'e' }] };
    mem.gw_files['cdoc:' + CF + ':S00:main.e0:1'] = { data: b64('%PDF-1.4') };
    r = await call({ action: 'cdoc_del', cid: CF, n: 1 }, tk, 'dev1');
    T('74 무효가 된 짝이 기준선에 들어 있으면 남은 간극으로 다시 잰다', r.code === 200 && avg0 === 0.1 && mem.gw_data[lkB].baseline.avg === 0 && mem.gw_data[lkB].gaps.length === 10, JSON.stringify(mem.gw_data[lkB].baseline));

    // 권한: 양식·목록·물어보기
    const uV = { id: 'uview74', name: '보기', admin: false, perms: { con: 'view', site: 'hide', lic: 'view' }, dept: '운영부' }, uD = { id: 'udo74', name: '공무', admin: false, perms: { con: 'do' }, dept: '운영부' };
    mem.gw_users['member:uview74'] = uV; mem.gw_users['member:udo74'] = uD; mem.gw_users['device:dev74'] = { status: 'approved' };
    const tV = issueSession(uV).token, tD = issueSession(uD).token;
    mem.gw_files['tpl:work_start'] = { name: '착공계', data: 'QQ==' }; mem.gw_files['tpl:quote_env'] = { name: '견적', data: 'QQ==' };
    const a1 = await call({ action: 'tpl_get', key: 'work_start' }, tV, 'dev74'), a2 = await call({ action: 'tpl_get', key: 'quote_env' }, tV, 'dev74'), a3 = await call({ action: 'tpl_get', key: 'work_start' }, tD), a4 = await call({ action: 'tpl_get', key: 'work_start' }, tD, 'dev74');
    const rlk = Object.keys(mem.gw_data).find((k) => k.indexOf('reclog:') === 0);
    T('74 사람 정보 양식: 보기 권한 403 · 미승인 기기 403 · 처리 권한+승인 기기 200 + 열람 기록(양식 이름만) · 견적 양식은 보기 권한도 그대로',
      a1.code === 403 && a2.code === 200 && a3.code === 403 && a3.body.error_code === 'DEVICE_NOT_APPROVED' && a4.code === 200 && mem.gw_data[rlk].items.slice(-1)[0].dk === 'tpl.work_start', JSON.stringify([a1.code, a2.code, a3.code, a4.code]));
    delete mem.gw_files['tpl:work_start']; delete mem.gw_files['tpl:quote_env'];
    const CG = 'c74f'; mem.gw_data['col:contracts'].items.push({ id: CG, title: '목록', scen: 'dredge:pub', stages: [] });
    await call({ action: 'cdoc_put', cid: CG, i: 0, doc_key: 'main.f0', kind: 'received', pii: 1, name: '홍길동 재직증명.pdf', data: b64('%PDF-1.4 f') }, tk, 'dev1');
    const l1 = await call({ action: 'cdoc_list', cid: CG }, tV, 'dev74'), l2 = await call({ action: 'cdoc_list', cid: CG }, tD, 'dev74'), l3 = await call({ action: 'cdoc_list', cid: CG }, tV);
    T('74 서류 목록: 열람 권한 없는 개인정보 항목은 올린 이름 대신 표준 이름 · 처리 권한은 올린 이름 · 미승인 기기 403', l1.code === 200 && !/홍길동/.test(JSON.stringify(l1.body.items)) && /홍길동/.test(l2.body.items[0].orig) && l3.code === 403, JSON.stringify([l1.body.items[0].orig, l3.code]));
    const defs = (m) => A74.toolDefs(m).map((t) => t.name);
    const uS = { id: 'usite74', admin: false, perms: { site: 'view', lic: 'hide' }, dept: '운영부' };
    mem.gw_data['col:licenses'] = { schema: 1, items: [{ id: 'l1', name: '전체 면허', scope: [] }, { id: 'l2', name: '관리부 면허', scope: ['dept:관리부'] }, { id: 'l3', name: '본인 면허', scope: ['uview74'] }, { id: 'l4', name: '직급 면허', scope: ['rank:과장'] }] };
    const lics = async (m) => ((await A74.runTool('licenses', {}, m)).rows || []).map((x) => x.이름).join();
    const rOk = await lics(uV), rMg = await lics(Object.assign({}, uV, { id: 'x', dept: '관리부' })), rRk = await lics(Object.assign({}, uV, { id: 'y', rank: '부장' })), rAd = await lics({ id: 'adm', admin: true, perms: {} });
    delete mem.gw_data['col:licenses'];
    T('74 물어보기 석면: 현장 권한으로 판정(인허가 권한만으로 안 나옴, 현장만 있으면 나옴) · 인허가: 공개 대상 밖은 안 나옴',
      defs(uV).indexOf('asbestos') < 0 && defs(uS).indexOf('asbestos') >= 0 && defs(uS).indexOf('licenses') < 0 && rOk === '전체 면허,본인 면허' && rMg === '전체 면허,관리부 면허' && rRk === '전체 면허,직급 면허' && rAd.split(',').length === 4, JSON.stringify([defs(uV), rOk, rMg, rRk, rAd]));
    const devOk = await A74.deviceApproved({ headers: { 'x-device-id': 'dev74' } }, uV), devNo = await A74.deviceApproved({ headers: {} }, uV), devAdm = await A74.deviceApproved({ headers: {} }, { admin: true });
    T('74 물어보기 기기: 승인 기기만 · 관리자 통과', devOk && !devNo && devAdm, '');
    // v426 양식 주민번호·백업 흔적
    const rrnFake = '900101-' + '1234567';
    let q6 = await call({ action: 'tpl_put', key: 'work_start', name: '착공계.xlsx', data: b64(mkXl({ A1: '현장대리인', F13: rrnFake })) }, tkA74);
    const q6a = q6.code === 400 && q6.body.error_code === 'TPL_HAS_RRN';
    q6 = await call({ action: 'tpl_put', key: 'seal_reg', name: '인감계.hwpx', data: b64(mkHwpx(['인감', rrnFake])) }, tkA74);
    const q6b = q6.code === 400 && q6.body.error_code === 'TPL_HAS_RRN';
    q6 = await call({ action: 'tpl_put', key: 'work_start', name: '착공계.xlsx', data: b64(mkXl({ A1: '현장대리인', F13: '' })) }, tkA74);
    const q6c = q6.code === 200 && !!mem.gw_files['tpl:work_start'];
    delete mem.gw_files['tpl:work_start'];
    T('76 v426 양식 등록: 주민번호 꼴이 든 파일은 거부(xlsx·hwpx) · 값이 없으면 등록', q6a && q6b && q6c, JSON.stringify([q6a, q6b, q6c, q6.code]));
    const secOld = process.env.BIDS_INGEST_KEY; process.env.BIDS_INGEST_KEY = 'test-secret-74';
    const s1 = await call({ action: 'backup_stamp', secret: 'wrong', fn: 'files_backup', ok: true }), s2 = await call({ action: 'backup_stamp', secret: 'test-secret-74', fn: 'col:contracts', ok: true }), s3 = await call({ action: 'backup_stamp', secret: 'test-secret-74', fn: 'files_backup', ok: true, n: 12, bytes: 3456, note: '새 2' });
    const sd = mem.gw_data['it:cron:files_backup:last'] || {};
    T('76 v426 백업 흔적: 키가 틀리면 403 · 정해진 이름만 · 끝 흔적(ok·건수·용량·시각)', s1.code === 403 && s2.code === 400 && s3.code === 200 && sd.state === 'end' && sd.ok === true && sd.n === 12 && sd.bytes === 3456 && sd.ts > 0, JSON.stringify(sd));
    if (secOld === undefined) delete process.env.BIDS_INGEST_KEY; else process.env.BIDS_INGEST_KEY = secOld;
    delete mem.gw_data['it:cron:files_backup:last'];
    // v425 자동 초안 표시
    const CL5 = 'c74g'; mem.gw_data['col:contracts'].items.push({ id: CL5, title: '자동 초안', scen: 'dredge:pub', stages: [] });
    const pL5 = (o) => call(Object.assign({ action: 'cdoc_put', cid: CL5, allow_dup: true }, o), tk, 'dev1');
    const dL5 = await pL5({ i: 0, doc_key: 'gen.seal_reg', kind: 'draft', pii: 1, name: '인감계.hwpx', data: b64(mkHwpx(['사용인감계', '위 인감', '회사'])), late: true });
    const fL5 = await pL5({ i: 0, doc_key: 'fin.seal_reg', kind: 'final', name: '인감계 직원본.hwpx', data: b64(mkHwpx(['사용인감계', '위 인감 고침', '회사'])), pair_tpl: 'seal_reg', late: true });
    const lL5 = fL5.body.learn || {};
    T('75 v425 자동 초안: 색인·짝·간극 줄에 표시 · 양식별 자리(fin.) 통과 · 최종본에는 표시 안 함', dL5.body.item.late === 1 && lL5.late === true && lL5.how === 'name' && mem.gw_data['learn:contract:in:' + lL5.id].late === 1 && !fL5.body.item.late && mem.gw_data['lessons:contract:seal_reg'].gaps.slice(-1)[0].late === 1, JSON.stringify([dL5.body.item.late, lL5]));
    delete mem.gw_data['recidx:' + CL5]; delete mem.gw_data['lessons:contract:seal_reg'];
    ['recidx:' + CID, 'recidx:' + CC, 'recidx:' + CD, 'recidx:' + CE, 'recidx:' + CF, 'recidx:' + CG, lkB].forEach((k) => delete mem.gw_data[k]);
    Object.keys(mem.gw_files).filter((k) => /^cdoc:c74/.test(k)).forEach((k) => delete mem.gw_files[k]);
  }
  // 정리
  delete mem.gw_data['recidx:c73']; Object.keys(mem.gw_data).filter((k) => /^(learn:contract:in:|lessons:contract:|usage:box:)/.test(k)).forEach((k) => delete mem.gw_data[k]);
  Object.keys(mem.gw_files).filter((k) => /^(cdoc:c73|boxp:|parse:att_|att_)/.test(k)).forEach((k) => delete mem.gw_files[k]);
  delete mem.gw_data['col:contracts'];
}

{ // ---- 76(v430) 메뉴 56 3단계 — 새 권한 '안전'(safety): 교육·건강진단 기록(col:edu) 키 hr → safety · 기본 숨김 · 보기/수행 짝 · 옛 hr 키 무효 · 회원 저장 cleanPerms가 safety를 '숨김'으로 굳힘 · 일반 3직책 등록 프리셋 숨김 ----
  //   하나라도 어긋나면 직원 건강진단 날짜가 열리거나(보기 채움) 기록 담당이 못 쓴다. 응답 코드만이 아니라 이유 코드(error_code)·기록 수까지 본다.
  const gwa76 = require(join(FN, 'gw-auth.js'));
  const callA76 = async (body, tok) => { const x = await gwa76.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const savedUsers76 = JSON.parse(JSON.stringify(mem.gw_users));
  const had76 = {}; ['col:edu', 'col:asbestos'].forEach((k) => { had76[k] = Object.prototype.hasOwnProperty.call(mem.gw_data, k) ? JSON.parse(JSON.stringify(mem.gw_data[k])) : undefined; });
  const E0_76 = [{ id: 'e1', ptype: 'member', pid: 'usv76', kind: 'regular', date: '2026-06-01', next: '2026-12-01', updated: '2026-06-01' }];
  mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(E0_76)), updated_at: 760 };
  mem.gw_data['col:asbestos'] = { schema: 1, items: [{ id: 'a1', title: '현장', status: 'plan' }], updated_at: 761 };
  mem.gw_users['device:dev1'] = { status: 'approved' };
  const mk76 = (id, perms) => { mem.gw_users['member:' + id] = { id, name: id, role: '직원', admin: false, perms }; return issueSession(mem.gw_users['member:' + id]).token; };
  const tView76 = mk76('usv76', { safety: 'view' }), tDo76 = mk76('usd76', { safety: 'do' }), tHr76 = mk76('ushr76', { hr: 'do' }), tSite76 = mk76('ussite76', { site: 'do' });

  // ① 안전 보기 → 읽기 200(1건·can_write false) · 저장 403 NO_WRITE · 기록·updated_at 그대로
  const gV76 = await call({ action: 'get', collection: 'edu' }, tView76, 'dev1');
  let r76 = await call({ action: 'save', collection: 'edu', base: 760, doc: { schema: 1, items: [] } }, tView76, 'dev1');
  T('76 v430 안전 보기 → edu 읽기 200(1건·can_write false) · 저장 403 NO_WRITE(이유 코드까지) · 기록 1건·updated_at 그대로',
    gV76.code === 200 && gV76.body.doc && gV76.body.doc.items.length === 1 && gV76.body.can_write === false && r76.code === 403 && r76.body.error_code === 'NO_WRITE'
    && mem.gw_data['col:edu'].items.length === 1 && mem.gw_data['col:edu'].updated_at === 760,
    [gV76.code, gV76.body.can_write, r76.code, r76.body.error_code, mem.gw_data['col:edu'].items.length].join('/'));
  // ② 안전 수행 → 저장 200 · 다시 읽으면 2건 · can_write true · 저장자 = 그 직원 (뒤에 원복)
  r76 = await call({ action: 'save', collection: 'edu', base: 760, doc: { schema: 1, items: E0_76.concat([{ id: 'e2', ptype: 'worker', pid: 'w1', kind: 'special', date: '2026-11-09', next: '', updated: '2026-11-09' }]) } }, tDo76, 'dev1');
  const gD76 = await call({ action: 'get', collection: 'edu' }, tDo76, 'dev1');
  T('76 v430 안전 수행 → edu 저장 200 · 다시 읽으면 2건·can_write true · 저장자 = 그 직원',
    r76.code === 200 && gD76.code === 200 && gD76.body.doc.items.length === 2 && gD76.body.can_write === true && mem.gw_data['col:edu'].updated_by === 'usd76',
    [r76.code, r76.body.error_code, gD76.body.doc && gD76.body.doc.items.length, mem.gw_data['col:edu'].updated_by].join('/'));
  mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(E0_76)), updated_at: 760 };   // 원복
  // ③ 옛 키 hr 수행만(v430 전 열쇠) → 읽기 403 NO_ACCESS·저장 403 NO_WRITE / 현장 수행만 → 교육 기록 읽기 403 NO_ACCESS(같은 사람 현장 대장은 200 — 권한 값 자체는 살아 있음)
  const gH76 = await call({ action: 'get', collection: 'edu' }, tHr76, 'dev1');
  const sH76 = await call({ action: 'save', collection: 'edu', base: 760, doc: { schema: 1, items: [] } }, tHr76, 'dev1');
  const gS76 = await call({ action: 'get', collection: 'edu' }, tSite76, 'dev1');
  const gSa76 = await call({ action: 'get', collection: 'asbestos' }, tSite76, 'dev1');
  T('76 v430 옛 키 hr 수행만 → edu 읽기 403 NO_ACCESS · 저장 403 NO_WRITE(기록 그대로) · 현장 수행만 → edu 읽기 403 NO_ACCESS(같은 사람 현장 대장 읽기는 200)',
    gH76.code === 403 && gH76.body.error_code === 'NO_ACCESS' && sH76.code === 403 && sH76.body.error_code === 'NO_WRITE' && mem.gw_data['col:edu'].items.length === 1 && mem.gw_data['col:edu'].updated_at === 760
    && gS76.code === 403 && gS76.body.error_code === 'NO_ACCESS' && gSa76.code === 200,
    [gH76.code, gH76.body.error_code, sH76.code, sH76.body.error_code, gS76.code, gS76.body.error_code, gSa76.code].join('/'));

  // ④ 회원 저장 = cleanPerms — 권한관리 칸 저장(perms만 부분 전송)에 safety가 없으면 '숨김'으로 굳음 · 칸 1번(숨김→수행) 저장은 'do' · perms 없는 인사 정보 저장은 유지 · 이상한 값은 '숨김'
  mem.gw_users['member:udev76'] = { id: 'udev76', name: '개발자76', role: '개발자', admin: true, dev: true, perms: {}, tier: 'pm' };
  const tDev76 = issueSession(mem.gw_users['member:udev76']).token;
  const P0_76 = { tasks: 'hide', veh: 'do', rec: 'hide', lic: 'view', site: 'hide', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'view', quote: 'view', promo: 'do' };   // 권민지형(11/9 백업의 저장값 — safety 키 없음)
  mem.gw_users['member:upm76'] = { id: 'upm76', name: '권민지형76', role: '직원', admin: false, perms: JSON.parse(JSON.stringify(P0_76)) };
  // 감사 로그(v430 검토): 그 저장이 남긴 회원 '수정' 줄의 필드(f) — 권한은 바뀐 칸만 '키:값'(종전엔 perms JSON 통째를 80자에서 잘라 뒤쪽 safety 변경이 전후 같은 글자로 남았다)
  const aud76 = (from, id) => { const e = auditMock.logs.slice(from).filter((l) => l.col === 'member').map((l) => (l.ev || []).find((x) => x.id === id && x.op === '수정')).filter(Boolean)[0]; return e ? (e.f || {}) : null; };
  const L1_76 = auditMock.logs.length;
  const a1_76 = await callA76({ action: 'member_upsert', id: 'upm76', perms: P0_76 }, tDev76);
  const p1_76 = Object.assign({}, (mem.gw_users['member:upm76'] || {}).perms), f1_76 = aud76(L1_76, 'upm76');
  const L2_76 = auditMock.logs.length;
  const a2_76 = await callA76({ action: 'member_upsert', id: 'upm76', perms: Object.assign({}, p1_76, { safety: 'do' }) }, tDev76);
  const p2_76 = Object.assign({}, (mem.gw_users['member:upm76'] || {}).perms), f2_76 = aud76(L2_76, 'upm76');
  const L3_76 = auditMock.logs.length;
  const a3_76 = await callA76({ action: 'member_upsert', id: 'upm76', rank: '주임' }, tDev76);
  const p3_76 = Object.assign({}, (mem.gw_users['member:upm76'] || {}).perms), f3_76 = aud76(L3_76, 'upm76');
  const L4_76 = auditMock.logs.length;
  const a4_76 = await callA76({ action: 'member_upsert', id: 'upm76', perms: Object.assign({}, p3_76, { safety: 'admin' }) }, tDev76);
  const p4_76 = Object.assign({}, (mem.gw_users['member:upm76'] || {}).perms), f4_76 = aud76(L4_76, 'upm76');
  // 키 순서만 MODULES와 다른 저장값(김정아형 — site가 끝)에 인사 정보만 저장 → cleanPerms가 순서만 바꿈 → 감사에 권한 항목 없음(직급만)
  //   v431: hw(화관법)도 MODULES에 늘어 저장값에 hw가 있어야 '순서만 다른' 경우가 된다 — 앞쪽에 둔다(순서는 여전히 MODULES와 다름) · 29 판② stmt(월말명세서)도 같은 까닭으로 앞쪽에
  const PK_76 = { stmt: 'hide', safety: 'hide', hw: 'hide', tasks: 'hide', veh: 'do', rec: 'hide', lic: 'do', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'do', quote: 'hide', promo: 'hide', site: 'do' };
  mem.gw_users['member:ukja76'] = { id: 'ukja76', name: '김정아형76', role: '직원', admin: false, perms: JSON.parse(JSON.stringify(PK_76)) };
  const L5_76 = auditMock.logs.length;
  const a5_76 = await callA76({ action: 'member_upsert', id: 'ukja76', rank: '대리' }, tDev76);
  const f5_76 = aud76(L5_76, 'ukja76'), p5_76 = (mem.gw_users['member:ukja76'] || {}).perms || {};
  T('76 v430 검토 감사 로그 권한 = 바뀐 칸만: safety 없이 저장(숨김으로 굳음 — v431 hw·29 판② stmt도 같은 저장에서 함께 굳어 "safety:-,hw:-,stmt:-" → "safety:hide,hw:hide,stmt:hide") · 칸 1번 → "safety:hide" → "safety:do" · 이상한 값 → "safety:do" → "safety:hide" · 인사 정보만 저장 → 권한 항목 없음(직급만) · 키 순서만 바뀐 저장(김정아형) → 권한 항목 없음',
    !!f1_76 && JSON.stringify(f1_76.perms) === JSON.stringify(['safety:-,hw:-,stmt:-', 'safety:hide,hw:hide,stmt:hide']) && !!f2_76 && JSON.stringify(f2_76.perms) === JSON.stringify(['safety:hide', 'safety:do'])
    && !!f3_76 && !!f3_76.rank && f3_76.perms === undefined && !!f4_76 && JSON.stringify(f4_76.perms) === JSON.stringify(['safety:do', 'safety:hide'])
    && a5_76.code === 200 && !!f5_76 && !!f5_76.rank && f5_76.perms === undefined && JSON.stringify(Object.keys(p5_76)) !== JSON.stringify(Object.keys(PK_76)) && Object.keys(PK_76).every((k) => p5_76[k] === PK_76[k]),
    JSON.stringify({ f1: f1_76 && f1_76.perms, f2: f2_76 && f2_76.perms, f3: f3_76 && Object.keys(f3_76), f4: f4_76 && f4_76.perms, f5: f5_76 && Object.keys(f5_76) }));
  T('76 v430 회원 저장 cleanPerms: safety 없이 저장 → "hide"로 굳음(보기로 열리지 않음) · 칸 1번(숨김→수행) 저장 → "do" · perms 없는 인사 정보 저장 → "do" 유지 · 이상한 값 → "hide" · 다른 키는 그대로 · 키 순서 = gw-auth MODULES(끝 safety·hw·stmt — v431·29 판②)',
    a1_76.code === 200 && p1_76.safety === 'hide' && p1_76.veh === 'do' && p1_76.lic === 'view' && p1_76.site === 'hide' && p1_76.stmt === 'hide'
    && a2_76.code === 200 && p2_76.safety === 'do' && a3_76.code === 200 && p3_76.safety === 'do' && a4_76.code === 200 && p4_76.safety === 'hide' && p4_76.promo === 'do'
    && Object.keys(p2_76).slice(-3).join(',') === 'safety,hw,stmt' && Object.keys(p2_76).length === 15,
    JSON.stringify([a1_76.code, p1_76.safety, a2_76.code, p2_76.safety, a3_76.code, p3_76.safety, a4_76.code, p4_76.safety, Object.keys(p2_76).length]));
  // ⑤ 새 회원 등록의 safety — 관리자(비개발자)의 직원 등록은 서버 표(ROLE_OPEN_PERMS)로 '숨김'(클라가 safety:'do'를 실어 보내도 무시) ·
  //    개발자 등록은 앱이 보내는 직책 프리셋(index.html ROLE_PRESET을 뽑아 그대로 보냄)이 저장돼 팀장·현장직도 '숨김'(PM ② — 팀장도 숨김)
  //    (관리자(비개발자)의 팀장·현장직 신규 등록은 v430 전부터 403 DEV_ONLY — 새 회원 직책을 기본값 '직원'과 비교해 직책 변경으로 본다. 이 절 범위 밖, 보고만)
  mem.gw_users['member:usoo76'] = { id: 'usoo76', name: '경리76', role: '관리자', admin: true, perms: {}, tier: 'admin' };
  const tSoo76 = issueSession(mem.gw_users['member:usoo76']).token;
  const find76 = (nm) => Object.values(mem.gw_users).find((u) => u && u.name === nm);
  const xw76 = await callA76({ action: 'member_upsert', name: '새직원76', role: '직원', pin: '1234', perms: { safety: 'do', tasks: 'do' } }, tSoo76);
  const mw76 = find76('새직원76');
  const src76 = require('fs').readFileSync(join(ROOT, 'index.html'), 'utf8');
  const appPre76 = (rl) => { const mm = src76.match(new RegExp('"' + rl + '":\\s*\\{admin:false, perms:\\{([^}]*)\\}')); const o = {}; if (mm) [...mm[1].matchAll(/(\w+):"(\w+)"/g)].forEach((x) => { o[x[1]] = x[2]; }); return o; };
  const madeDev76 = [];
  for (const rl of ['팀장', '현장직']) {
    const pre = appPre76(rl);
    const x = await callA76({ action: 'member_upsert', name: '새' + rl + '76', role: rl, pin: '1234', admin: false, perms: pre }, tDev76);
    const m = find76('새' + rl + '76');
    madeDev76.push(x.code + ':' + (m && m.perms ? m.perms.safety : '-') + ':' + (m && m.perms && Object.keys(pre).length === 15 && Object.keys(pre).every((k) => m.perms[k] === pre[k]) ? 'same' : 'diff'));   // v431 hw·29 판② stmt로 프리셋 키 15
  }
  T('76 v430 새 회원 safety: 관리자(비개발자) 직원 등록 → 서버 프리셋 "hide"(클라가 do를 실어 보내도 무시)·admin false · 개발자가 앱 직책 프리셋으로 팀장·현장직 등록 → 프리셋 그대로 저장, safety "hide"(팀장도)',
    xw76.code === 200 && mw76 && mw76.perms.safety === 'hide' && mw76.perms.tasks === 'do' && mw76.admin === false && madeDev76.join(',') === '200:hide:same,200:hide:same',
    [xw76.code, mw76 && mw76.perms.safety].join(':') + ' / ' + madeDev76.join(','));

  mem.gw_users = savedUsers76;
  ['col:edu', 'col:asbestos'].forEach((k) => { if (had76[k] === undefined) delete mem.gw_data[k]; else mem.gw_data[k] = had76[k]; });
}

{ // ---- 77(v431) 메뉴 56 4-1 — 화관법 권한 키(hw) 등록: 회원 저장이 hw 값(수행·보기)을 지키고(cleanPerms가 버리지 않음) 값이 없으면 '숨김'으로 굳힌다 ·
  //   감사 로그에 바뀐 칸 · 새 회원 직책 프리셋 숨김 · ⑥ 제출(gw-hwakwan) — 4-1 동안은 hw를 안 봤고 v434(4-2)에서 뒤집었다: 숨김·값 없음은 조회 403 NO_ACCESS·제출 403 NO_WRITE, 보기는 제출 403 NO_WRITE(더 자세한 것은 79절).
  //   배포 뒤 PM 순서(브리핑 deploy): 권한관리 '화관법' 열 김정아 칸 1번(수행) · 권민지·정재욱 칸 각 2번(수행 → 보기). 응답 코드만이 아니라 이유 코드(error_code·code)·저장값·감사 줄까지 본다.
  const gwa77 = require(join(FN, 'gw-auth.js'));
  const callA77 = async (body, tok) => { const x = await gwa77.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const savedUsers77 = JSON.parse(JSON.stringify(mem.gw_users));
  mem.gw_users['device:dev1'] = { status: 'approved' };
  mem.gw_users['member:udev77'] = { id: 'udev77', name: '개발자77', role: '개발자', admin: true, dev: true, perms: {}, tier: 'pm' };
  mem.gw_users['member:usoo77'] = { id: 'usoo77', name: '경리77', role: '관리자', admin: true, perms: {}, tier: 'admin' };   // 관리자(비개발자) = 나수진 자리
  const tDev77 = issueSession(mem.gw_users['member:udev77']).token, tSoo77 = issueSession(mem.gw_users['member:usoo77']).token;
  // v430 배포 뒤 저장값 모양(safety는 있고 hw는 없음 — cleanPerms 13키) — 운영부 세 분 자리
  const base77 = (o) => Object.assign({ tasks: 'hide', veh: 'do', rec: 'hide', lic: 'view', site: 'hide', check: 'do', con: 'do', cli: 'hide', doc: 'view', wk: 'view', quote: 'hide', promo: 'hide', safety: 'hide' }, o || {});
  const put77 = (id, name, role, perms, dept) => { mem.gw_users['member:' + id] = { id, name, role, dept: dept || '운영부', admin: false, perms }; };
  const KJA77 = base77({ lic: 'do', site: 'do', wk: 'do' });
  put77('ukja77', '김정아형77', '팀장', JSON.parse(JSON.stringify(KJA77)));
  put77('ukmj77', '권민지형77', '직원', base77({ safety: 'do' }));
  put77('ujjw77', '정재욱형77', '직원', base77({ site: 'do', wk: 'do' }));
  const pOf77 = (id) => Object.assign({}, (mem.gw_users['member:' + id] || {}).perms);
  const aud77 = (from, id) => { const e = auditMock.logs.slice(from).filter((l) => l.col === 'member').map((l) => (l.ev || []).find((x) => x.id === id && x.op === '수정')).filter(Boolean)[0]; return e ? (e.f || {}) : null; };
  // 권한관리 칸 저장 = pmSave 모양(perms만 부분 전송 — 표에 보이는 그 사람 perms 전체 + 누른 칸) → 응답·저장값·감사 줄
  const cell77 = async (id, hw, tok) => { const L = auditMock.logs.length; const r = await callA77({ action: 'member_upsert', id, perms: Object.assign(pOf77(id), { hw }) }, tok || tDev77); return { r, p: pOf77(id), f: aud77(L, id) }; };
  const ok77 = (x) => x.r.code === 200 && x.r.body.status === 'OK' && !x.r.body.error_code && !!x.r.body.member && x.r.body.member.perms.hw === x.p.hw;

  // ① 김정아 1번(숨김 → 수행) · 권민지 2번 연달아(1초 안 — 표가 '보기' 한 번만 저장) · 정재욱 2번을 띄워서(수행 저장 뒤 보기 저장)
  const k1 = await cell77('ukja77', 'do'), m1 = await cell77('ukmj77', 'view'), j1 = await cell77('ujjw77', 'do'), j2 = await cell77('ujjw77', 'view');
  //   29 판②: 저장값(v430 모양)에 stmt도 없어 첫 저장에서 stmt가 '숨김'으로 함께 굳는다(감사 "…,stmt:-" → "…,stmt:hide") — 둘째 저장부터는 hw 칸만
  T('77 v431 권한관리 \'화관법\' 칸 저장(perms만 부분 전송 — PM 순서): 김정아형 1번 → hw "do" · 권민지형 2번 연달아 → "view" · 정재욱형 2번 띄워서 → "do" 뒤 "view" — 200 OK·이유 코드 없음·응답 회원 값 = 저장값 · 감사 로그 = 바뀐 칸만("hw:-,stmt:-" → "hw:do,stmt:hide" · "hw:-,stmt:-" → "hw:view,stmt:hide" · "hw:-,stmt:-" → "hw:do,stmt:hide" · "hw:do" → "hw:view" — 29 판② stmt는 첫 저장에서 숨김으로 굳음) · 다른 13키 값 그대로 · 키 15개·끝 safety·hw·stmt',
    [k1, m1, j1, j2].every(ok77) && k1.p.hw === 'do' && m1.p.hw === 'view' && j1.p.hw === 'do' && j2.p.hw === 'view'
    && JSON.stringify(k1.f && k1.f.perms) === '["hw:-,stmt:-","hw:do,stmt:hide"]' && JSON.stringify(m1.f && m1.f.perms) === '["hw:-,stmt:-","hw:view,stmt:hide"]'
    && JSON.stringify(j1.f && j1.f.perms) === '["hw:-,stmt:-","hw:do,stmt:hide"]' && JSON.stringify(j2.f && j2.f.perms) === '["hw:do","hw:view"]'
    && Object.keys(KJA77).every((k) => k1.p[k] === KJA77[k]) && m1.p.safety === 'do' && [k1, m1, j2].every((x) => x.p.stmt === 'hide')
    && [k1, m1, j2].every((x) => Object.keys(x.p).length === 15 && Object.keys(x.p).slice(-3).join(',') === 'safety,hw,stmt'),
    JSON.stringify({ k: [k1.r.code, k1.r.body.error_code, k1.p.hw, k1.f && k1.f.perms], m: [m1.r.code, m1.p.hw, m1.f && m1.f.perms], j: [j1.f && j1.f.perms, j2.f && j2.f.perms, j2.p.hw] }));

  // ② 그 뒤 권한과 무관한 저장(인사 카드 — perms 미전송)과 같은 사람의 다른 칸 저장에도 hw 값이 남는다
  let L77 = auditMock.logs.length;
  const k2 = await callA77({ action: 'member_upsert', id: 'ukja77', rank: '대리' }, tSoo77);   // 관리자(비개발자)의 인사 정보 저장
  const k2p = pOf77('ukja77'), k2f = aud77(L77, 'ukja77');
  L77 = auditMock.logs.length;
  const m2 = await callA77({ action: 'member_upsert', id: 'ukmj77', perms: Object.assign(pOf77('ukmj77'), { veh: 'view' }) }, tDev77);   // 차량 칸 — 표는 hw를 그대로 실어 보낸다
  const m2p = pOf77('ukmj77'), m2f = aud77(L77, 'ukmj77');
  T('77 v431 hw 값이 남음: 인사 정보만 저장(관리자, perms 미전송) → 김정아형 hw "do" 그대로·감사에 권한 항목 없음(직급만) · 같은 사람 다른 칸(차량) 저장 → 권민지형 hw "view" 그대로·감사 = "veh:do" → "veh:view"만',
    k2.code === 200 && k2.body.status === 'OK' && !k2.body.error_code && k2p.hw === 'do' && mem.gw_users['member:ukja77'].rank === '대리' && !!k2f && !!k2f.rank && k2f.perms === undefined
    && m2.code === 200 && !m2.body.error_code && m2p.hw === 'view' && m2p.veh === 'view' && JSON.stringify(m2f && m2f.perms) === '["veh:do","veh:view"]',
    JSON.stringify({ k: [k2.code, k2.body.error_code, k2p.hw, k2f && Object.keys(k2f)], m: [m2.code, m2p.hw, m2f && m2f.perms] }));

  // ③ hw 없이 저장 → '숨김'으로 굳음(보기로 열리지 않음) · 이상한 값 → '숨김'
  //    갱신 전 캐시 앱(v430)의 권한관리 표에는 '화관법' 열이 없다 — 받은 목록이 부여 전이면 hw를 빼고 보낼 수 있고, 그러면 준 값이 '숨김'으로 돌아간다(서버는 '보기'를 채우지 않는다)
  L77 = auditMock.logs.length;
  const pj3 = pOf77('ujjw77'); delete pj3.hw;
  const j3 = await callA77({ action: 'member_upsert', id: 'ujjw77', perms: pj3 }, tDev77);
  const j3p = pOf77('ujjw77'), j3f = aud77(L77, 'ujjw77');
  L77 = auditMock.logs.length;
  const m3 = await callA77({ action: 'member_upsert', id: 'ukmj77', perms: Object.assign(pOf77('ukmj77'), { hw: 'admin' }) }, tDev77);
  const m3p = pOf77('ukmj77'), m3f = aud77(L77, 'ukmj77');
  put77('uold77', '옛저장값77', '직원', { tasks: 'hide', veh: 'view' }, '폐기물팀');   // safety·hw 둘 다 없는 옛 저장값
  L77 = auditMock.logs.length;
  const o3 = await callA77({ action: 'member_upsert', id: 'uold77', rank: '사원' }, tSoo77);
  const o3p = pOf77('uold77'), o3f = aud77(L77, 'uold77');
  const o3b = (o3f && o3f.perms && o3f.perms[0] ? o3f.perms[0].split(',') : []), o3a = (o3f && o3f.perms && o3f.perms[1] ? o3f.perms[1].split(',') : []);
  T('77 v431 hw 없이 저장 → "hide"로 굳음(보기로 열리지 않음): 옛 캐시 앱처럼 hw를 빼고 보낸 칸 저장 → 정재욱형 "view" → "hide"(감사 "hw:view" → "hw:hide") · 이상한 값("admin") → "hide"(감사 "hw:view" → "hw:hide") · hw가 아예 없던 회원의 인사 정보 저장(관리자) → "hide"로 굳고 감사에 "hw:-" → "hw:hide"',
    j3.code === 200 && !j3.body.error_code && j3p.hw === 'hide' && JSON.stringify(j3f && j3f.perms) === '["hw:view","hw:hide"]'
    && m3.code === 200 && !m3.body.error_code && m3p.hw === 'hide' && JSON.stringify(m3f && m3f.perms) === '["hw:view","hw:hide"]'
    && o3.code === 200 && !o3.body.error_code && o3p.hw === 'hide' && o3b.indexOf('hw:-') >= 0 && o3a.indexOf('hw:hide') >= 0 && o3b.length === o3a.length,
    JSON.stringify({ j: [j3.code, j3p.hw, j3f && j3f.perms], m: [m3.code, m3p.hw, m3f && m3f.perms], o: [o3.code, o3p.hw, o3b.length, o3a.length] }));

  // ④ 이유 코드 — 관리자(비개발자)의 '화관법' 칸 저장은 403 DEV_ONLY(권한 편집은 개발자만 — 21-2) · 직원 토큰(본인 칸)은 403 ADMIN_ONLY · 둘 다 저장값 그대로
  const before77 = pOf77('ukja77');
  const x1 = await callA77({ action: 'member_upsert', id: 'ukja77', perms: Object.assign(pOf77('ukja77'), { hw: 'hide' }) }, tSoo77);
  const x2 = await callA77({ action: 'member_upsert', id: 'ukja77', perms: Object.assign(pOf77('ukja77'), { hw: 'view' }) }, issueSession(mem.gw_users['member:ukja77']).token);
  T('77 v431 이유 코드: 관리자(비개발자)가 \'화관법\' 칸을 바꾸면 403 DEV_ONLY · 직원 토큰(본인 칸)이면 403 ADMIN_ONLY — 둘 다 저장값 그대로(김정아형 hw "do")',
    x1.code === 403 && x1.body.error_code === 'DEV_ONLY' && x2.code === 403 && x2.body.error_code === 'ADMIN_ONLY' && before77.hw === 'do' && JSON.stringify(pOf77('ukja77')) === JSON.stringify(before77),
    [x1.code, x1.body.error_code, x2.code, x2.body.error_code, pOf77('ukja77').hw].join('/'));

  // ⑤ 새 회원 hw — 관리자(비개발자)의 직원 등록은 서버 표(ROLE_OPEN_PERMS)로 '숨김'(클라가 hw:'do'를 실어 보내도) · 개발자 등록은 앱 ROLE_PRESET(index.html에서 뽑아 그대로 보냄)
  const find77 = (nm) => Object.values(mem.gw_users).find((u) => u && u.name === nm);
  const xw77 = await callA77({ action: 'member_upsert', name: '경리등록77', role: '직원', pin: '1234', perms: { hw: 'do', safety: 'do', tasks: 'do' } }, tSoo77);
  const mw77 = find77('경리등록77');
  const src77 = require('fs').readFileSync(join(ROOT, 'index.html'), 'utf8');
  const appPre77 = (rl) => { const mm = src77.match(new RegExp('"' + rl + '":\\s*\\{admin:(?:true|false),\\s*(?:dev:true,\\s*)?perms:\\{([^}]*)\\}')); const o = {}; if (mm) [...mm[1].matchAll(/(\w+):"(\w+)"/g)].forEach((x) => { o[x[1]] = x[2]; }); return o; };
  const madeDev77 = [];
  for (const rl of ['팀장', '직원', '현장직', '관리자']) {
    const pre = appPre77(rl), adm = rl === '관리자';
    const x = await callA77({ action: 'member_upsert', name: '새' + rl + '77', role: rl, pin: adm ? 'password77' : '1234', admin: adm, perms: pre }, tDev77);
    const m = find77('새' + rl + '77');
    madeDev77.push(rl + ':' + x.code + ':' + (pre.hw || '-') + ':' + (m && m.perms ? m.perms.hw : '-'));
  }
  T('77 v431 새 회원 hw: 관리자(비개발자) 직원 등록 → 서버 프리셋 "hide"(클라가 hw:"do"를 실어 보내도 무시)·admin false · 개발자가 앱 직책 프리셋으로 등록 → 팀장·직원·현장직 "hide"(PM ③ — 부서·직책 단위로 주지 않음), 관리자 "do"(관리자는 어차피 수행 고정)',
    xw77.code === 200 && !xw77.body.error_code && !!mw77 && mw77.perms.hw === 'hide' && mw77.perms.tasks === 'do' && mw77.admin === false
    && madeDev77.join(',') === '팀장:200:hide:hide,직원:200:hide:hide,현장직:200:hide:hide,관리자:200:do:do',
    [xw77.code, xw77.body.error_code, mw77 && mw77.perms.hw].join(':') + ' / ' + madeDev77.join(','));

  // ⑥ v434(4-2)에서 뒤집음 — 화관법 API(gw-hwakwan)가 hw를 본다(브리핑 steps[3].tests): 조회(hw_status)는 숨김·값 없음(기본 숨김)이면 403 NO_ACCESS, 보기·수행은 200 ·
  //    폐기물 제출은 수행이 아니면 403 NO_WRITE(숨김·보기·값 없음 — 입력 검사보다 먼저), 수행은 검사를 지나 입력·환경 검사까지. 이 시험은 실제 제출(워커 기동)까지 가지 않게 화관법 계정 환경변수를 비운다(400 ENV_MISSING).
  const hwk77 = require(join(FN, 'gw-hwakwan.js'));
  const ICIS77 = require(join(FN, '_lib/icis.js'));
  const callH77 = async (body, tok) => { const x = await hwk77.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tok, 'x-device-id': 'dev1' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const env77 = { id: process.env.GW_ICIS_ID, pw: process.env.GW_ICIS_PW };
  delete process.env.GW_ICIS_ID; delete process.env.GW_ICIS_PW;
  put77('uhide77', '김호태형77', '직원', base77({ hw: 'hide' }), '준설팀');
  put77('unohw77', '값없음hw77', '현장직', base77(), '폐기물팀');
  mem.gw_users['member:ujjw77'].perms.hw = 'view';
  const kst77 = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
  const sub77 = { action: 'hw_waste_submit', vehicleNo: ICIS77.WASTE_VEHICLES[0], scenario: Object.keys(ICIS77.SCENARIOS)[0], date: kst77(3), time: '09:00' };
  const jobs77 = () => Object.keys(mem.gw_data).filter((k) => k.indexOf('hwakwan:job:') === 0).length;
  const jobs0_77 = jobs77(), res77 = [];
  const e77 = (r) => (r.code === 403 ? ((typeof r.body.error === 'string' && r.body.error.length > 10) ? '+글' : '-글') : '');   // v434 검토: 403 몸체에 사람 말 error(옛 앱이 괄호 안·현황 카드에 보여 줌)
  for (const id of ['uhide77', 'ujjw77', 'ukja77', 'unohw77']) {
    const tok = issueSession(mem.gw_users['member:' + id]).token;
    const s = await callH77({ action: 'hw_status' }, tok), w = await callH77(sub77, tok);
    res77.push(id + ':' + (mem.gw_users['member:' + id].perms.hw || '-') + ':' + s.code + '/' + (s.body.ok === true ? 'ok' : s.body.code) + e77(s) + ':' + w.code + '/' + w.body.code + e77(w));
  }
  const jobs1_77 = jobs77();
  if (env77.id !== undefined) process.env.GW_ICIS_ID = env77.id;
  if (env77.pw !== undefined) process.env.GW_ICIS_PW = env77.pw;
  T('77 v431→v434 4-2 — 화관법 API가 hw를 봄: hw 숨김(김호태형)·값 없음 = hw_status 403 NO_ACCESS·폐기물 제출 403 NO_WRITE · 보기(정재욱형) = hw_status 200·제출 403 NO_WRITE · 수행(김정아형) = hw_status 200·제출은 권한 검사를 지나 입력·환경 검사까지(이 시험 환경은 화관법 계정이 없어 400 ENV_MISSING) · 403 몸체마다 사람 말 error(검토 반영 — 글 전문은 79절) · 작업 기록 0',
    res77.join(',') === 'uhide77:hide:403/NO_ACCESS+글:403/NO_WRITE+글,ujjw77:view:200/ok:403/NO_WRITE+글,ukja77:do:200/ok:400/ENV_MISSING,unohw77:-:403/NO_ACCESS+글:403/NO_WRITE+글' && jobs1_77 === jobs0_77,
    res77.join(' · ') + ' / 작업 ' + jobs0_77 + '→' + jobs1_77);

  mem.gw_users = savedUsers77;
}

{ // ---- 78(v433) 메뉴 56 6단계 — 현장 대장 '특별교육 미이수'(site_edu_gap, 읽기 전용): 안전 권한 없는 현장 권한자에게 서버가 투입 인원 중 유효한 특별교육 기록이 없는 사람 이름만.
  //   응답 코드만이 아니라 이유 코드(error_code)·현장별 이름·응답 키·저장 0까지 본다. 실 Blobs는 없는 키를 ok·data null로 준다(운영 col:edu 지금 상태) — mock에서는 값 null로 심어 흉내(mock은 없는 키를 NOT_FOUND로 줌).
  const savedUsers78 = JSON.parse(JSON.stringify(mem.gw_users));
  const had78 = {}; ['col:asbestos', 'col:edu', 'col:workers'].forEach((k) => { had78[k] = Object.prototype.hasOwnProperty.call(mem.gw_data, k) ? JSON.parse(JSON.stringify(mem.gw_data[k])) : undefined; });
  mem.gw_users['device:dev1'] = { status: 'approved' };
  const mk78 = (id, extra) => { mem.gw_users['member:' + id] = Object.assign({ id, name: id, role: '직원', admin: false, perms: {} }, extra); return issueSession(mem.gw_users['member:' + id]).token; };
  mk78('p78a', { name: '갑돌78' }); mk78('p78b', { name: '을순78' }); mk78('p78del', { name: '지운회원78', del: 1 }); mk78('p78out', { name: '외부인78' });   // 투입 인원(회원) · 지운 회원 · 어느 현장에도 없는 회원
  const tKja78 = mk78('u78kja', { name: '김정아형78', perms: { site: 'do', lic: 'do', wk: 'do' } });       // 현장 수행·안전 없음
  const tView78 = mk78('u78view', { name: '현장보기78', perms: { site: 'view' } });                       // 현장 보기만
  const tMin78 = mk78('u78min', { name: '권민지형78', perms: { safety: 'do', site: 'hide', lic: 'view' } });   // 안전 수행·현장 숨김
  const tNone78 = mk78('u78none', { name: '현장없음78', perms: { veh: 'view' } });                         // site 값 없음 = 기본 숨김(gw-data PERM_CLOSED)
  mem.gw_data['col:asbestos'] = { schema: 1, items: [
    { id: 'a78run', kind: 'asbestos', status: 'run', member_ids: ['p78a', 'p78b', 'p78del'], worker_ids: ['w78a', 'w78del', 'w78b'] },
    { id: 'a78plan', kind: 'dredge', status: 'plan', member_ids: '[]', worker_ids: '["w78a"]' },   // 준설도 검사 · 문자열 칸(9/2 일괄 입력 모양)
    { id: 'a78zero', kind: 'demolition', status: 'plan', member_ids: [], worker_ids: [] },         // 투입 0명(지금 운영 진행·예정 2건 모양)
    { id: 'a78demo', kind: 'demolition', status: 'run', member_ids: ['p78a'], worker_ids: ['w78a'] },   // v454 철거 = 해체 특별교육(special_demo) — 갑돌78 미이수 · 일용갑78 이수
    { id: 'a78done', kind: 'asbestos', status: 'done', member_ids: ['p78a'], worker_ids: ['w78a'] },
    { id: 'a78gone', kind: 'asbestos', status: 'run', del: 1, member_ids: ['p78a'], worker_ids: [] },
  ], updated_at: 780 };
  mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w78a', name: '일용갑78' }, { id: 'w78b', name: '일용을78' }, { id: 'w78del', name: '지운일용78', del: 1 }], updated_at: 781 };
  const EDU78 = [
    { id: 'e78a', ptype: 'member', pid: 'p78b', kind: 'special', date: '2026-10-01', next: '', hours: 16, note: '노트78' },
    { id: 'e78b', ptype: 'worker', pid: 'w78b', kind: 'special', date: '2026-10-02', next: '' },
    { id: 'e78c', ptype: 'member', pid: 'p78a', kind: 'spec_med', date: '2026-10-03', next: '2027-10-03' },   // 건강진단만 — 갑돌 미이수
    { id: 'e78d', ptype: 'worker', pid: 'w78a', kind: 'special_demo', date: '2026-10-04', next: '' },          // v454 해체 특별교육 — 철거 현장에서만 이수(석면 현장 a78run에서는 여전히 미이수)
  ];
  mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(EDU78)), updated_at: 782 };
  const WANT78 = { a78run: ['갑돌78', '일용갑78'], a78plan: [], a78zero: [], a78demo: ['갑돌78'] };   // v454: 준설 a78plan = 판정 안 함(빈 목록) · 철거 a78demo = 해체 특별교육
  const audit0_78 = auditMock.logs.length, snap78 = JSON.stringify([mem.gw_data['col:asbestos'], mem.gw_data['col:edu'], mem.gw_data['col:workers']]);
  const gap78 = (tok, dev) => call({ action: 'site_edu_gap' }, tok, dev);

  // ① 현장 수행(김정아형)·현장 보기·관리자 → 200 · 현장별 이름 = 지운·종결 대장 빼고, 유효한 특별교육 기록이 없는 투입 인원만(건강진단만 있는 갑돌 포함 · 이수한 을순·일용을 · 지운 회원·지운 일용직 빼고)
  const rK78 = await gap78(tKja78, 'dev1'), rV78 = await gap78(tView78, 'dev1'), rA78 = await gap78(tokA);
  T('78 v433 site_edu_gap: 현장 수행(김정아형)·현장 보기·관리자 → 200 · ok·has_edu true · 현장별 이름 = 진행 a78run [갑돌78, 일용갑78](건강진단만 있는 사람은 미이수 · 이수자·지운 회원·지운 일용직 빠짐) · 준설 a78plan [](v454 — 준설은 판정 안 함) · 철거 a78demo [갑돌78](해체 특별교육 — 일용갑78은 이수 · has_demo true) · 투입 0명 a78zero [] · 종결·지운 대장 없음 · 세 사람 같은 답',
    [rK78, rV78, rA78].every((x) => x.code === 200 && x.body.ok === true && x.body.status === 'OK' && x.body.has_edu === true && x.body.has_demo === true && JSON.stringify(x.body.gaps) === JSON.stringify(WANT78)),
    [rK78, rV78, rA78].map((x) => x.code + '/' + JSON.stringify(x.body.gaps)).join(' | '));
  // ② 응답에 이름 밖 값 없음 — 키 = status·ok·has_edu·gaps·request_id · 이름은 그 현장 투입 인원 안에서만 · 교육 기록 값(이수일·종류·다음 예정·시간·메모)·투입 인원 밖 이름·지운 회원·지운 일용직 0
  const pool78 = { a78run: ['갑돌78', '을순78', '일용갑78', '일용을78'], a78plan: ['일용갑78'], a78zero: [], a78demo: ['갑돌78', '일용갑78'] };
  const rj78 = JSON.stringify(rK78.body);
  const leak78 = ['2026-10', '2027-10', 'spec_med', 'special', '노트78', '"hours"', '"next"', '"date"', '"pid"', '"ptype"', '"kind"', '외부인78', '지운회원78', '지운일용78', '을순78', '일용을78', 'a78done', 'a78gone'].filter((w) => rj78.indexOf(w) >= 0);
  T('78 v433 응답 = 이름만: 응답 키 status·ok·has_edu·has_demo·gaps·request_id(v454 — 현장별 판정 종류 kinds는 내보내지 않음) · 이름은 그 현장 투입 인원 안에서만 · 교육 기록 값(이수일·종류·다음 예정·시간·메모)·투입 인원 밖 이름(외부인)·지운 회원·지운 일용직·이수자·종결·지운 대장 0 · 같은 사람의 교육 기록 읽기(get edu)는 여전히 403 NO_ACCESS',
    Object.keys(rK78.body).sort().join(',') === 'gaps,has_demo,has_edu,ok,request_id,status' && Object.keys(rK78.body.gaps).every((id) => Array.isArray(pool78[id]) && rK78.body.gaps[id].every((n) => pool78[id].indexOf(n) >= 0)) && leak78.length === 0
    && (await call({ action: 'get', collection: 'edu' }, tKja78, 'dev1')).body.error_code === 'NO_ACCESS',
    'leak: ' + leak78.join(',') + ' / keys ' + Object.keys(rK78.body).join(','));
  // ③ 거절 — 현장 숨김(권민지형) · site 값 없음(기본 숨김) → 403 NO_ACCESS · 기기 미승인·기기 머리 없음 → 403 DEVICE_NOT_APPROVED · 비로그인 → 401 · 이유 코드까지
  const rM78 = await gap78(tMin78, 'dev1'), rN78 = await gap78(tNone78, 'dev1'), rD78 = await gap78(tKja78, 'devX'), rD2_78 = await gap78(tKja78), rU78 = await gap78(null);
  T('78 v433 거절: 현장 숨김(권민지형 — 안전 수행이어도) · site 값 없음(기본 숨김) → 403 NO_ACCESS · 미승인 기기·기기 머리 없음 → 403 DEVICE_NOT_APPROVED · 비로그인 → 401 · 거절 응답에 이름 0',
    rM78.code === 403 && rM78.body.error_code === 'NO_ACCESS' && rN78.code === 403 && rN78.body.error_code === 'NO_ACCESS'
    && rD78.code === 403 && rD78.body.error_code === 'DEVICE_NOT_APPROVED' && rD2_78.code === 403 && rD2_78.body.error_code === 'DEVICE_NOT_APPROVED' && rU78.code === 401
    && [rM78, rN78, rD78, rD2_78, rU78].every((x) => x.body.gaps === undefined && JSON.stringify(x.body).indexOf('갑돌78') < 0),
    [rM78, rN78, rD78, rD2_78, rU78].map((x) => x.code + '/' + x.body.error_code).join(' | '));
  // ④ 교육 기록 0건 → has_edu false · 이름 안 보냄(gaps {}) — 없는 키(실 Blobs ok·data null) · 빈 목록 · 지운 기록만
  mem.gw_data['col:edu'] = null; const rE0_78 = await gap78(tKja78, 'dev1');
  mem.gw_data['col:edu'] = { schema: 1, items: [], updated_at: 783 }; const rE1_78 = await gap78(tKja78, 'dev1');
  mem.gw_data['col:edu'] = { schema: 1, items: EDU78.map((e) => Object.assign({}, e, { del: 1 })), updated_at: 784 }; const rE2_78 = await gap78(tKja78, 'dev1');
  T('78 v433 교육 기록 0건 → 200 · has_edu·has_demo false · 이름 안 보냄(v454: 현장마다 빈 목록 — 앱은 "교육 기록 없음 — 이수 여부 미확인"만 그림): 없는 키(실 Blobs ok·data null — 운영 col:edu 지금) · 빈 목록 · 지운 기록만',
    [rE0_78, rE1_78, rE2_78].every((x) => x.code === 200 && x.body.ok === true && x.body.has_edu === false && x.body.has_demo === false && JSON.stringify(x.body.gaps) === '{"a78run":[],"a78plan":[],"a78zero":[],"a78demo":[]}'),
    [rE0_78, rE1_78, rE2_78].map((x) => x.code + '/' + x.body.has_edu + '/' + JSON.stringify(x.body.gaps)).join(' | '));
  mem.gw_data['col:edu'] = { schema: 1, items: EDU78.filter((e) => e.kind !== 'special'), updated_at: 786 }; const rE3_78 = await gap78(tKja78, 'dev1');
  mem.gw_data['col:edu'] = { schema: 1, items: EDU78.filter((e) => e.kind !== 'special_demo'), updated_at: 787 }; const rE4_78 = await gap78(tKja78, 'dev1');
  T('78 v454 종류별 비우기: 석면 특별교육 기록만 0건 = has_edu false·has_demo true — 석면 현장 a78run [] · 철거 현장 a78demo [갑돌78] 그대로 / 해체 특별교육 기록만 0건 = has_demo false — 철거 a78demo [] · 석면 a78run [갑돌78, 일용갑78] 그대로',
    rE3_78.code === 200 && rE3_78.body.has_edu === false && rE3_78.body.has_demo === true && JSON.stringify(rE3_78.body.gaps) === '{"a78run":[],"a78plan":[],"a78zero":[],"a78demo":["갑돌78"]}'
    && rE4_78.code === 200 && rE4_78.body.has_edu === true && rE4_78.body.has_demo === false && JSON.stringify(rE4_78.body.gaps) === '{"a78run":["갑돌78","일용갑78"],"a78plan":[],"a78zero":[],"a78demo":[]}',
    JSON.stringify([rE3_78.body, rE4_78.body]));
  mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(EDU78)), updated_at: 782 };
  // ⑤ 삭제된 일용직 제외(명부에서 지운 사람이 대장에 남아 있어도) · 일용직 이름을 되살리면 다시 나옴(같은 판정이 명부를 본다는 대조)
  mem.gw_data['col:workers'].items[2].del = 0; const rW1_78 = await gap78(tKja78, 'dev1');
  mem.gw_data['col:workers'].items[2].del = 1; const rW2_78 = await gap78(tKja78, 'dev1');
  T('78 v433 삭제된 일용직 제외: 명부에서 지운 일용직(지운일용78)은 대장 투입 인원에 남아 있어도 이름 없음 · 대조 — 지움을 풀면 [갑돌78, 일용갑78, 지운일용78]',
    rW2_78.body.gaps && rW2_78.body.gaps.a78run.join(',') === '갑돌78,일용갑78' && rW1_78.body.gaps && rW1_78.body.gaps.a78run.join(',') === '갑돌78,일용갑78,지운일용78',
    JSON.stringify([rW1_78.body.gaps, rW2_78.body.gaps]));
  // ⑥ 일용직 권한 숨김(현장 보기 + wk 숨김 — v433 검토: 그 사람은 명부 읽기가 403인데 일용직 이름을 받았다) → 일용직은 이름 대신 현장별 수만(wk_n) ·
  //    직원 이름은 그대로 · 명부 읽기(get workers)는 여전히 403 NO_ACCESS · 일용직 권한이 있는 사람(김정아형·현장 보기·관리자) 응답엔 wk_n 없음 · 교육 0건이면 gaps {}·wk_n {}
  const tWkH78 = mk78('u78wkh', { name: '일용직숨김78', perms: { site: 'view', wk: 'hide' } });
  const rH78 = await gap78(tWkH78, 'dev1'), rHw78 = await call({ action: 'get', collection: 'workers' }, tWkH78, 'dev1');
  mem.gw_data['col:edu'] = { schema: 1, items: [], updated_at: 785 }; const rH0_78 = await gap78(tWkH78, 'dev1');
  mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(EDU78)), updated_at: 782 };
  const rjH78 = JSON.stringify(rH78.body);
  T('78 v433 일용직 권한 숨김(현장 보기 + 일용직 숨김): 200 · 직원 이름만(a78run [갑돌78]·a78plan []·a78zero []) · 일용직은 현장별 수만 wk_n {a78run 1, a78plan 0(준설 — 판정 안 함), a78zero 0, a78demo 0(해체 특별교육 이수)}(지운 일용직·이수자는 세지 않음) · 응답 키 status·ok·has_edu·has_demo·gaps·wk_n·request_id · 일용직 이름 0 · 명부 읽기는 여전히 403 NO_ACCESS · 일용직 권한 있는 사람(김정아형·현장 보기·관리자) 응답엔 wk_n 없음 · 교육 0건이면 현장마다 이름 [] · 수 0',
    rH78.code === 200 && rH78.body.ok === true && rH78.body.has_edu === true
    && JSON.stringify(rH78.body.gaps) === JSON.stringify({ a78run: ['갑돌78'], a78plan: [], a78zero: [], a78demo: ['갑돌78'] }) && JSON.stringify(rH78.body.wk_n) === JSON.stringify({ a78run: 1, a78plan: 0, a78zero: 0, a78demo: 0 })
    && Object.keys(rH78.body).sort().join(',') === 'gaps,has_demo,has_edu,ok,request_id,status,wk_n' && ['일용갑78', '일용을78', '지운일용78'].every((w) => rjH78.indexOf(w) < 0)
    && rHw78.code === 403 && rHw78.body.error_code === 'NO_ACCESS'
    && [rK78, rV78, rA78].every((x) => !Object.prototype.hasOwnProperty.call(x.body, 'wk_n'))
    && rH0_78.code === 200 && rH0_78.body.has_edu === false && Object.keys(rH0_78.body.gaps).every((k) => rH0_78.body.gaps[k].length === 0) && Object.keys(rH0_78.body.wk_n).join(',') === 'a78run,a78plan,a78zero,a78demo' && Object.keys(rH0_78.body.wk_n).every((k) => rH0_78.body.wk_n[k] === 0),
    rH78.code + '/' + rjH78 + ' / get workers ' + rHw78.code + '/' + rHw78.body.error_code + ' / edu0 ' + JSON.stringify(rH0_78.body));
  // ⑦ 읽기 실패 → 500(빈 결과로 '미이수 없음'을 그리지 않게 — 앱은 '확인 못 함') · 대장·교육·명부 각각 · 회원 명부 미가용 MEMBERS_UNAVAILABLE · 저장·감사 로그 0
  const fail0_78 = blobsMock.hooks.failGet, fails78 = [];
  for (const k of ['col:asbestos', 'col:edu', 'col:workers']) { blobsMock.hooks.failGet = (key) => key === k; const x = await gap78(tKja78, 'dev1'); fails78.push(x.code + '/' + x.body.error_code + '/' + (x.body.gaps === undefined)); }
  blobsMock.hooks.failGet = fail0_78;
  const lm0_78 = pushMock.loadMembers; pushMock.loadMembers = async () => { const a = []; a.unavailable = true; return a; };
  const rMu78 = await gap78(tKja78, 'dev1'); pushMock.loadMembers = lm0_78;
  T('78 v433 읽기 실패 → 500(빈 결과를 내지 않음): 대장·교육·명부 각각 STORAGE_READ_FAILED · 회원 명부 미가용 MEMBERS_UNAVAILABLE · 실패 응답에 gaps 없음 · 이 절의 호출 전부 저장 0(대장·교육·명부 그대로)·감사 로그 0',
    fails78.join(',') === '500/STORAGE_READ_FAILED/true,500/STORAGE_READ_FAILED/true,500/STORAGE_READ_FAILED/true' && rMu78.code === 500 && rMu78.body.error_code === 'MEMBERS_UNAVAILABLE' && rMu78.body.gaps === undefined
    && JSON.stringify([mem.gw_data['col:asbestos'], mem.gw_data['col:edu'], mem.gw_data['col:workers']]) === snap78 && auditMock.logs.length === audit0_78,
    fails78.join(',') + ' / ' + rMu78.code + '/' + rMu78.body.error_code + ' / audit +' + (auditMock.logs.length - audit0_78));

  mem.gw_users = savedUsers78;
  ['col:asbestos', 'col:edu', 'col:workers'].forEach((k) => { if (had78[k] === undefined) delete mem.gw_data[k]; else mem.gw_data[k] = had78[k]; });
}

{ // ---- 79(v434) 메뉴 56 4-2 — 화관법 사람 요청 권한(hw): gw-hwakwan hwPerm(관리자 do · 회원 perms.hw · 값 없으면 hide — 기본 숨김).
  //   폐기물 제출은 수행만(숨김·보기·값 없음 403 NO_WRITE — 입력 검사·작업 기록·워커 기동·감사 로그보다 먼저) · 관리자는 기기 머리 없이도 통과 · 비관리자 기기 미승인 403 DEVICE_NOT_APPROVED ·
  //   조회(hw_status·hw_job)는 숨김이면 403 NO_ACCESS · 지금 실행(hw_run_now)은 hw를 안 봄(관리자·개발자 ADMIN_ONLY만) · 제품 자동 제출 크론·워커는 권한 검사 없음(실행 + 원문).
  //   실제 외부 제출로 나가지 않게: global.fetch 흉내(워커 기동 주소만 받아 202 — 다른 주소는 막고 기록), 화관법 계정은 가짜 값(워커는 기동 흉내라 icis 호출 0, 워커 실행 시험은 계정을 비워 ENV_MISSING) — 끝나면 되돌림.
  //   응답 코드만이 아니라 이유 코드(code)·작업 기록·기동 몸체·토큰 주인·감사 줄까지 본다.
  const savedUsers79 = JSON.parse(JSON.stringify(mem.gw_users));
  const env79 = { id: process.env.GW_ICIS_ID, pw: process.env.GW_ICIS_PW, url: process.env.URL };
  const realFetch79 = global.fetch, realNow79 = Date.now, bg079 = blobsMock.hooks.beforeGet;
  const hwKeys079 = new Set(Object.keys(mem.gw_data).filter((k) => k.indexOf('hwakwan:') === 0));   // 이 절이 만든 작업 기록만 끝에 지운다
  const kicks79 = [], stray79 = [];
  const setEnv79 = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    process.env.URL = 'https://test.local'; process.env.GW_ICIS_ID = 'test-id-79'; process.env.GW_ICIS_PW = 'test-pw-79';
    global.fetch = async (url, opt) => {
      if (String(url) === 'https://test.local/.netlify/functions/gw-hwakwan-run-background') { kicks79.push({ auth: String((opt && opt.headers && opt.headers.Authorization) || ''), body: JSON.parse((opt && opt.body) || '{}') }); return { ok: true, status: 202 }; }
      stray79.push(String(url)); throw new Error('시험 중 외부 호출 금지: ' + url);
    };
    const hwk79 = require(join(FN, 'gw-hwakwan.js')), ICIS79 = require(join(FN, '_lib/icis.js')), { verifyToken: vt79 } = require(join(FN, '_lib/session.js'));
    mem.gw_users['device:dev1'] = { status: 'approved' };
    const mk79 = (id, extra) => { mem.gw_users['member:' + id] = Object.assign({ id, name: id, role: '직원', admin: false, perms: {} }, extra); return issueSession(mem.gw_users['member:' + id]).token; };
    const tAdm79 = mk79('u79adm', { name: '관리자79', role: '관리자', admin: true });
    const tDo79 = mk79('u79do', { name: '김정아형79', role: '팀장', perms: { hw: 'do', site: 'do' } });
    const tView79 = mk79('u79view', { name: '권민지형79', perms: { hw: 'view', safety: 'do' } });
    const tHide79 = mk79('u79hide', { name: '김호태형79', perms: { hw: 'hide', veh: 'view' } });
    const tNone79 = mk79('u79none', { name: '현장형79', role: '현장직', perms: { veh: 'view', check: 'do' } });   // hw 값 없음 = 기본 숨김(배포 직후 현장 부서 모양)
    const tDev79 = mk79('u79dev', { name: '개발자형79', role: '개발자', dev: true, perms: { hw: 'hide' } });   // 관리자 아닌 개발자 + 화관법 숨김 — 지금 실행은 hw를 안 본다
    const callH79 = async (body, tok, dev) => { const x = await hwk79.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: 'Bearer ' + tok }, dev === undefined ? { 'x-device-id': 'dev1' } : (dev ? { 'x-device-id': dev } : {})), body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
    const kstOf79 = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
    const sub79 = { action: 'hw_waste_submit', vehicleNo: ICIS79.WASTE_VEHICLES[0], scenario: Object.keys(ICIS79.SCENARIOS)[0], date: kstOf79(Date.now() + 3 * 86400000), time: '09:00' };
    const jobs79 = () => Object.keys(mem.gw_data).filter((k) => k.indexOf('hwakwan:job:') === 0);
    const aud79 = (op) => auditMock.logs.filter((l) => l.col === 'hwakwan' && (l.ev || []).some((e) => e.op === op)).length;
    const jb0 = jobs79().length, au0 = aud79('폐기물제출요청');
    // ① 제출 권한
    const sH = await callH79(sub79, tHide79), sV = await callH79(sub79, tView79), sN = await callH79(sub79, tNone79);
    const kA = kicks79.length, jA = jobs79().length, auA = aud79('폐기물제출요청');
    const sDx = await callH79(sub79, tDo79, 'devX'), sDn = await callH79(sub79, tDo79, '');
    const kB = kicks79.length, jB = jobs79().length;
    const sD = await callH79(sub79, tDo79), sA = await callH79(sub79, tAdm79, '');
    const kC = kicks79.length, jC = jobs79().length, auC = aud79('폐기물제출요청');
    const tokOk79 = (k) => { const v = vt79(k.auth.replace(/^Bearer /, '')); return v.ok && v.payload.mid === '__hwakwan__'; };
    const kickOk79 = (k, job) => tokOk79(k) && k.body.job === job && k.body.mode === 'waste' && k.body.params && k.body.params.vehicleNo === sub79.vehicleNo && k.body.params.scenario === sub79.scenario && k.body.params.date === sub79.date && k.body.params.time === sub79.time;
    const jobBy79 = (id) => { const j = mem.gw_data['hwakwan:job:' + id]; return j ? j.status + '/' + j.mode + '/' + j.by : '-'; };
    //   v434 검토: 거절 몸체의 사람 말 error 전문(옛 v433 앱은 NO_WRITE·NO_ACCESS를 몰라 이 글을 제출 결과 괄호 안·현황 카드에 보여 준다 — 새 앱은 code로 판정)
    const NW79 = '화관법 수행 권한이 없어 제출하지 않았습니다 — 폐기물 운반계획서는 권한관리 화관법 열이 수행인 분만 낼 수 있습니다. 이 요청은 정부에 제출되지 않았습니다.';
    const NA79 = '화관법 권한이 없습니다(권한관리 화관법 열이 숨김) — 필요하면 관리자에게 알려 주세요.';
    const no79 = (r) => r.code === 403 && r.body.ok === false && r.body.code === 'NO_WRITE' && r.body.error === NW79 && !r.body.job;
    T('79 v434 폐기물 제출 권한(hw): 숨김(김호태형)·보기(권민지형)·값 없음(현장형) → 403 NO_WRITE·몸체 error "화관법 수행 권한이 없어 제출하지 않았습니다 … 정부에 제출되지 않았습니다."(작업 기록·워커 기동·감사 0) · 수행(김정아형) → 200 작업 번호 · 관리자(기기 머리 없이) → 200 · 수행이어도 기기 미승인(devX)·기기 머리 없음 → 403 DEVICE_NOT_APPROVED(기동 0) · 워커 기동 2번 = 내부 토큰(mid __hwakwan__ — 회원 토큰 아님)·mode waste·보낸 값 그대로·응답 작업 번호와 같음 · 작업 기록 2(queued·누른 사람 이름) · 감사 "폐기물제출요청" 2 · 외부 호출 0',
      [sH, sV, sN].every(no79) && kA === 0 && jA === jb0 && auA === au0
      && [sDx, sDn].every((r) => r.code === 403 && r.body.code === 'DEVICE_NOT_APPROVED') && kB === 0 && jB === jb0
      && sD.code === 200 && sD.body.ok === true && /^hw_waste_/.test(sD.body.job || '') && sA.code === 200 && sA.body.ok === true && /^hw_waste_/.test(sA.body.job || '') && sD.body.job !== sA.body.job
      && kC === 2 && kickOk79(kicks79[0], sD.body.job) && kickOk79(kicks79[1], sA.body.job)
      && jC === jb0 + 2 && jobBy79(sD.body.job) === 'queued/waste/김정아형79' && jobBy79(sA.body.job) === 'queued/waste/관리자79' && auC === au0 + 2 && stray79.length === 0,
      JSON.stringify({ h: [sH.code, sH.body.code], v: [sV.code, sV.body.code], n: [sN.code, sN.body.code], dx: [sDx.code, sDx.body.code], dn: [sDn.code, sDn.body.code], d: [sD.code, sD.body.job], a: [sA.code, sA.body.job], kicks: [kA, kB, kC], jobs: [jb0, jA, jB, jC], aud: [au0, auA, auC], stray: stray79 }));
    // ② 권한 검사가 입력 검사보다 먼저
    const bad79 = Object.assign({}, sub79, { vehicleNo: '없는차량79' });
    const bV = await callH79(bad79, tView79), bH = await callH79(Object.assign({}, sub79, { date: '2000-01-01' }), tHide79), bD = await callH79(bad79, tDo79);
    T('79 v434 권한 검사가 입력 검사보다 먼저: 보기 + 없는 차량 → 403 NO_WRITE(400 BAD_VEHICLE 아님) · 숨김 + 지난 날짜 → 403 NO_WRITE(400 DATE_RANGE 아님) · 수행 + 없는 차량 → 400 BAD_VEHICLE(종전 입력 검사) · 기동 그대로 2',
      no79(bV) && no79(bH) && bD.code === 400 && bD.body.code === 'BAD_VEHICLE' && kicks79.length === 2,
      [bV.code, bV.body.code, bH.code, bH.body.code, bD.code, bD.body.code, kicks79.length].join('/'));
    // ③ 조회 — 숨김만 거절(보기는 현황·작업을 본다)
    const qs79 = {};
    for (const [k, t] of [['hide', tHide79], ['none', tNone79], ['view', tView79], ['do', tDo79], ['admin', tAdm79]]) { const r = await callH79({ action: 'hw_status' }, t); qs79[k] = r.code + '/' + (r.body.ok === true ? 'ok' : r.body.code) + (r.body.scenarios ? '+노선' : '') + (r.code === 403 ? (r.body.error === NA79 ? '+글' : '-글') : ''); }
    const jH = await callH79({ action: 'hw_job', job: sD.body.job }, tHide79), jN = await callH79({ action: 'hw_job', job: sD.body.job }, tNone79);
    mem.gw_data['hwakwan:job:hw_waste_nope79'] = null;   // 실 Blobs는 없는 키를 ok·data null로 준다 — mock은 없는 키를 NOT_FOUND로 주므로 값 null로 심어 흉내(78절과 같은 방식)
    const jV = await callH79({ action: 'hw_job', job: sD.body.job }, tView79), jX = await callH79({ action: 'hw_job', job: 'hw_waste_nope79' }, tView79);
    T('79 v434 조회: hw_status 숨김·값 없음 → 403 NO_ACCESS·몸체 error "화관법 권한이 없습니다(권한관리 화관법 열이 숨김) …" · 보기·수행·관리자 → 200(노선 목록 포함) · hw_job 숨김·값 없음 → 403 NO_ACCESS(같은 error) · 보기 → 200(그 작업 queued) · 없는 작업은 보기도 404 JOB_NOT_FOUND(권한 검사를 지나 종전 처리)',
      JSON.stringify(qs79) === JSON.stringify({ hide: '403/NO_ACCESS+글', none: '403/NO_ACCESS+글', view: '200/ok+노선', do: '200/ok+노선', admin: '200/ok+노선' })
      && [jH, jN].every((r) => r.code === 403 && r.body.code === 'NO_ACCESS' && r.body.error === NA79 && r.body.status === undefined) && jV.code === 200 && jV.body.ok === true && jV.body.status === 'queued' && jX.code === 404 && jX.body.code === 'JOB_NOT_FOUND',
      JSON.stringify({ qs: qs79, jh: [jH.code, jH.body.code], jn: [jN.code, jN.body.code], jv: [jV.code, jV.body.status], jx: [jX.code, jX.body.code] }));
    // ④ 지금 실행·크론·워커에는 hw 검사 없음
    const rDev = await callH79({ action: 'hw_run_now' }, tDev79), sDev = await callH79({ action: 'hw_status' }, tDev79), rDo = await callH79({ action: 'hw_run_now' }, tDo79);
    const kRun = kicks79[kicks79.length - 1], nRun = kicks79.length;
    const cron79 = require(join(FN, 'gw-hwakwan-cron.js'));
    const shift79 = ((3 - new Date(realNow79() + 9 * 3600000).getUTCDay()) + 7) % 7, fake79 = realNow79() + shift79 * 86400000;   // 시계를 KST 수요일로(크론은 주말엔 아무것도 안 함)
    let cronR = null, cronTok = null, memReads79 = 0;
    blobsMock.hooks.beforeGet = async (k) => { if (String(k).indexOf('member:') === 0) memReads79++; if (bg079) await bg079(k); };
    Date.now = () => fake79;
    try {
      const x = await cron79.handler({});
      cronR = { code: x.statusCode, body: JSON.parse(x.body || '{}') };
      const ck = kicks79[kicks79.length - 1];
      cronTok = ck && kicks79.length === nRun + 1 ? vt79(ck.auth.replace(/^Bearer /, '')) : null;
    } finally { Date.now = realNow79; blobsMock.hooks.beforeGet = bg079; }
    const ckB = kicks79[kicks79.length - 1].body;
    const wk79 = require(join(FN, 'gw-hwakwan-run-background.js'));
    setEnv79('GW_ICIS_ID', undefined); setEnv79('GW_ICIS_PW', undefined);
    const sysTok79 = issueSession({ id: '__hwakwan__', role: 'system' }).token;
    await wk79.handler({ headers: { authorization: 'Bearer ' + tHide79 }, body: JSON.stringify({ job: 'hw_waste_t79a', mode: 'waste', params: sub79 }) });
    await wk79.handler({ headers: { authorization: 'Bearer ' + sysTok79 }, body: JSON.stringify({ job: 'hw_waste_t79b', mode: 'waste', params: sub79 }) });
    const wA = mem.gw_data['hwakwan:job:hw_waste_t79a'], wB = mem.gw_data['hwakwan:job:hw_waste_t79b'];
    const fs79 = require('fs');
    const srcC79 = fs79.readFileSync(join(FN, 'gw-hwakwan-cron.js'), 'utf8'), srcW79 = fs79.readFileSync(join(FN, 'gw-hwakwan-run-background.js'), 'utf8'), srcK79 = fs79.readFileSync(join(FN, 'gw-cron-kick.js'), 'utf8');
    const noPerm79 = [srcC79, srcW79, srcK79].every((s) => s.length > 300 && !/\bperms\b|permOf|hwPerm|canDo|NO_WRITE|NO_ACCESS|member:/.test(s));
    T('79 v434 지금 실행·크론·워커에는 hw 검사 없음: 관리자 아닌 개발자 + 화관법 숨김 → hw_run_now 200(제품 노선 기동 mode daily·내부 토큰) · 같은 사람 hw_status 403 NO_ACCESS(조회는 hw로) · 수행이어도 관리자·개발자가 아니면 hw_run_now 403 ADMIN_ONLY(종전) · 크론(시계를 KST 수요일로) 200·기동 1번(mid __hwakwan__·mode daily·D+3 하루·작업 hw_cron_<오늘>)·회원 읽기 0 · 워커 = 회원 토큰이면 기록 0, 내부 토큰이면 권한을 안 보고 진행(화관법 계정 없음 → ENV_MISSING, 외부 제출 0) · 크론·워커·크론 킥 원문에 권한 판정 0 · 외부 호출 0',
      rDev.code === 200 && rDev.body.ok === true && /^hw_run_/.test(rDev.body.job || '') && !!kRun && kRun.body.mode === 'daily' && kRun.body.job === rDev.body.job && tokOk79(kRun)
      && sDev.code === 403 && sDev.body.code === 'NO_ACCESS' && rDo.code === 403 && rDo.body.code === 'ADMIN_ONLY'
      && !!cronR && cronR.code === 200 && cronR.body.ok === true && cronR.body.job === 'hw_cron_' + kstOf79(fake79) && kicks79.length === nRun + 1 && !!cronTok && cronTok.ok && cronTok.payload.mid === '__hwakwan__'
      && ckB.mode === 'daily' && JSON.stringify(ckB.params && ckB.params.targetDays) === JSON.stringify([kstOf79(fake79 + 3 * 86400000)]) && memReads79 === 0
      && wA === undefined && !!wB && wB.status === 'fail' && wB.code === 'ENV_MISSING' && noPerm79 && stray79.length === 0,
      JSON.stringify({ dev: [rDev.code, rDev.body.code || rDev.body.job], devS: [sDev.code, sDev.body.code], doRun: [rDo.code, rDo.body.code], cron: cronR, cronMid: cronTok && cronTok.payload && cronTok.payload.mid, ck: ckB, memReads: memReads79, wA: !!wA, wB: wB && [wB.status, wB.code], noPerm: noPerm79, stray: stray79 }));
  } finally {
    global.fetch = realFetch79; Date.now = realNow79; blobsMock.hooks.beforeGet = bg079;
    setEnv79('GW_ICIS_ID', env79.id); setEnv79('GW_ICIS_PW', env79.pw); setEnv79('URL', env79.url);
    mem.gw_users = savedUsers79;
    Object.keys(mem.gw_data).filter((k) => k.indexOf('hwakwan:') === 0 && !hwKeys079.has(k)).forEach((k) => { delete mem.gw_data[k]; });
  }
}

{ // ---- 80(v436) 메뉴 56 7단계 — 안전 설정 settings:safety(현황 ⑤ 인정·평가·회사 구분 — PM 11/10 ⓐ '안전 설정 따로', 인허가 행 kosha_cert 안 씀).
  //   읽기 safety_settings_get = 로그인·기기 승인 뒤 관리자 또는 안전 권한(숨김 아님) · 쓰기 safety_settings_set = 관리자만 · 값 검사 400 · 낙관락 409 · prev 1판 · 감사 1줄.
  //   응답 코드만이 아니라 이유 코드(error_code)·저장값·prev·감사 줄(f 바뀐 칸)·저장 0까지 본다. 실 Blobs는 없는 키를 ok·data null로 준다(운영 지금 — settings:safety 없음) — mock에서는 값 null로 심어 흉내(78절과 같은 방식).
  const savedUsers80 = JSON.parse(JSON.stringify(mem.gw_users));
  const KEY80 = 'settings:safety', had80 = Object.prototype.hasOwnProperty.call(mem.gw_data, KEY80) ? JSON.parse(JSON.stringify(mem.gw_data[KEY80])) : undefined;
  mem.gw_users['device:dev1'] = { status: 'approved' };
  const mk80 = (id, extra) => { mem.gw_users['member:' + id] = Object.assign({ id, name: id, role: '직원', admin: false, perms: {} }, extra); return issueSession(mem.gw_users['member:' + id]).token; };
  const tMin80 = mk80('u80min', { name: '권민지형80', perms: { safety: 'do', lic: 'view' } });                 // 안전 수행
  const tKja80 = mk80('u80kja', { name: '김정아형80', perms: { safety: 'view', site: 'do', lic: 'do' } });     // 안전 보기
  const tJw80 = mk80('u80jw', { name: '정재욱형80', perms: { site: 'do', lic: 'view' } });                     // safety 값 없음 = 기본 숨김(gw-data PERM_CLOSED)
  const tHide80 = mk80('u80hide', { name: '안전숨김80', perms: { safety: 'hide', site: 'do' } });              // 명시 숨김
  const tAdm80 = mk80('u80adm', { name: '관리자80', role: '관리자', admin: true });
  const get80 = (tok, dev) => call({ action: 'safety_settings_get' }, tok, dev);
  const set80 = (body, tok, dev) => call(Object.assign({ action: 'safety_settings_set' }, body), tok, dev);
  const aud80 = () => auditMock.logs.filter((l) => l.col === 'safety');
  const K80 = (o) => Object.assign({ stage: 'none', apply_no: '', applied_on: '', review_on: '', decided_on: '', expires_on: '', rate_year: '', checks: [] }, o || {});
  const V80 = (k, h) => ({ kosha: K80(k), headcount: Object.assign({ env: '', con: '' }, h || {}) });
  mem.gw_data[KEY80] = null;   // 운영 지금 상태(키 없음)
  const audit0_80 = aud80().length;

  // ① 읽기 권한 — 안전 수행·보기·관리자 200(저장값 없음 = settings null) · 안전 값 없음(기본 숨김)·명시 숨김 403 NO_ACCESS · 기기 미승인 403 · 비로그인 401
  const gMin80 = await get80(tMin80, 'dev1'), gKja80 = await get80(tKja80, 'dev1'), gAdm80 = await get80(tokA), gAdm2_80 = await get80(tAdm80);
  const gJw80 = await get80(tJw80, 'dev1'), gHide80 = await get80(tHide80, 'dev1'), gDevX80 = await get80(tKja80, 'devX'), gNoDev80 = await get80(tKja80), gNo80 = await get80(null);
  T('80 v436 읽기 권한(safety_settings_get): 안전 수행(권민지형)·안전 보기(김정아형)·관리자(기기 머리 없이도) → 200 · 저장값 없음(운영 지금) = settings null·updated_at 0·updated_by ""·prev null · 응답 키 status·settings·updated_at·updated_by·prev·request_id / 안전 값 없음(정재욱형 — 기본 숨김)·명시 숨김 → 403 NO_ACCESS · 기기 미승인·기기 머리 없음 → 403 DEVICE_NOT_APPROVED · 비로그인 → 401 · 거절 몸체에 settings 없음',
    [gMin80, gKja80, gAdm80, gAdm2_80].every((x) => x.code === 200 && x.body.status === 'OK' && x.body.settings === null && x.body.updated_at === 0 && x.body.updated_by === '' && x.body.prev === null && Object.keys(x.body).sort().join(',') === 'prev,request_id,settings,status,updated_at,updated_by')
    && [gJw80, gHide80].every((x) => x.code === 403 && x.body.error_code === 'NO_ACCESS') && [gDevX80, gNoDev80].every((x) => x.code === 403 && x.body.error_code === 'DEVICE_NOT_APPROVED') && gNo80.code === 401
    && [gJw80, gHide80, gDevX80, gNoDev80, gNo80].every((x) => x.body.settings === undefined),
    [gMin80, gKja80, gAdm80, gAdm2_80, gJw80, gHide80, gDevX80, gNoDev80, gNo80].map((x) => x.code + '/' + (x.body.error_code || '') + '/' + JSON.stringify(x.body.settings)).join(' | '));

  // ② 쓰기 거절 — 관리자가 아니면 안전 수행이어도 403 ADMIN_ONLY(저장 0·감사 0)
  const good80 = V80({ stage: 'applied', apply_no: 'K-2026-0001', applied_on: '2026-11-12' }, { env: 18, con: 4 });
  const wMin80 = await set80(Object.assign({ base: 0 }, good80), tMin80, 'dev1'), wKja80 = await set80(Object.assign({ base: 0 }, good80), tKja80, 'dev1'), wJw80 = await set80(Object.assign({ base: 0 }, good80), tJw80, 'dev1'), wNo80 = await set80(Object.assign({ base: 0 }, good80), null);
  T('80 v436 쓰기 거절(safety_settings_set): 안전 수행(권민지형)·안전 보기(김정아형)·안전 없음(정재욱형) → 403 ADMIN_ONLY(현황은 읽기 전용 — 고치기는 관리자) · 비로그인 401 · 저장 0(키 그대로 null)·감사 0',
    [wMin80, wKja80, wJw80].every((x) => x.code === 403 && x.body.error_code === 'ADMIN_ONLY' && x.body.settings === undefined) && wNo80.code === 401 && mem.gw_data[KEY80] === null && aud80().length === audit0_80,
    [wMin80, wKja80, wJw80, wNo80].map((x) => x.code + '/' + x.body.error_code).join(' | '));

  // ③ 관리자 저장 1(저장값 없음 → base 0) — 알려진 칸만 · prev null · 감사 1줄(바뀐 칸 f) · 권민지형 읽기 = 같은 값
  const w1_80 = await set80(Object.assign({ base: 0, extra: 'x' }, good80, { kosha: Object.assign({ junk: 1 }, good80.kosha, { apply_no: '  K-2026-0001  ' }) }), tokA);
  const st1_80 = JSON.parse(JSON.stringify(mem.gw_data[KEY80] || null)), au1_80 = aud80().slice(audit0_80);
  const g1_80 = await get80(tMin80, 'dev1');
  T('80 v436 관리자 저장 1(저장값 없음 → base 0): 200 · 응답 = 읽기와 같은 꼴(settings·updated_at·updated_by uadmin·prev null) · 저장값 = 알려진 칸만(모르는 칸 junk·extra 버림 · 접수번호 앞뒤 공백 정리 · 인원 숫자) · schema 1 · prev null(처음) · 감사 1줄(col safety · op 안전설정 · id settings:safety · 바뀐 칸 f: KOSHA 단계 (입력 전)→접수 · 접수번호 · 접수일 · 상시근로자 두 칸 · 글 t) · 권민지형 읽기 = 같은 값·같은 updated_at',
    w1_80.code === 200 && w1_80.body.status === 'OK' && JSON.stringify(w1_80.body.settings) === JSON.stringify(good80) && w1_80.body.updated_by === 'uadmin' && w1_80.body.updated_at > 0 && w1_80.body.prev === null
    && !!st1_80 && st1_80.schema === 1 && st1_80.prev === null && st1_80.updated_by === 'uadmin' && st1_80.updated_at === w1_80.body.updated_at && JSON.stringify(st1_80.kosha) === JSON.stringify(good80.kosha) && JSON.stringify(st1_80.headcount) === '{"env":18,"con":4}' && st1_80.extra === undefined && st1_80.kosha.junk === undefined
    && au1_80.length === 1 && au1_80[0].by === '관리자' && au1_80[0].bid === 'uadmin' && au1_80[0].ev.length === 1 && au1_80[0].ev[0].op === '안전설정' && au1_80[0].ev[0].id === KEY80
    && JSON.stringify(au1_80[0].ev[0].f) === JSON.stringify({ 'kosha.stage': ['(입력 전)', '접수'], 'kosha.apply_no': ['', 'K-2026-0001'], 'kosha.applied_on': ['', '2026-11-12'], 'headcount.env': ['', '18'], 'headcount.con': ['', '4'] })
    && au1_80[0].ev[0].t === 'KOSHA 단계 (입력 전)→접수 · 접수번호 —→K-2026-0001 · 접수일 —→2026-11-12 · 상시근로자 종운환경 —→18 · 상시근로자 종운건설 —→4'
    && g1_80.code === 200 && JSON.stringify(g1_80.body.settings) === JSON.stringify(w1_80.body.settings) && g1_80.body.updated_at === w1_80.body.updated_at && g1_80.body.updated_by === 'uadmin',
    JSON.stringify({ w1: [w1_80.code, w1_80.body.error_code, w1_80.body.settings], st1: st1_80, au: au1_80.map((a) => a.ev) }));

  // ④ 관리자 저장 2(다른 관리자 · base = 저장 1의 updated_at) — prev = 저장 1 한 판 · 감사 +1(바뀐 칸만)
  const good2_80 = V80({ stage: 'certified', apply_no: 'K-2026-0001', applied_on: '2026-11-12', review_on: '2026-12-01', decided_on: '2027-01-05', expires_on: '2030-01-04', rate_year: '2028', checks: [{ date: '2027-06-01', note: '공단 사후점검 적합' }] }, { env: '20', con: 0 });
  const w2_80 = await set80(Object.assign({ base: w1_80.body.updated_at }, good2_80), tAdm80);
  const st2_80 = JSON.parse(JSON.stringify(mem.gw_data[KEY80] || null)), au2_80 = aud80().slice(audit0_80);
  T('80 v436 관리자 저장 2(다른 관리자 · base = 저장 1의 updated_at): 200 · 인원 숫자 글 "20" → 20 · 0명 그대로 · prev = 저장 1 한 판(kosha·headcount·updated_at·updated_by — prev 안의 prev 없음, 응답 prev = 날·사람만) · updated_at이 커짐 · 감사 +1줄(바뀐 칸만 — 접수번호·접수일은 같아 빠짐)',
    w2_80.code === 200 && w2_80.body.updated_by === 'u80adm' && w2_80.body.updated_at > w1_80.body.updated_at && !!st2_80 && JSON.stringify(st2_80.headcount) === '{"env":20,"con":0}' && st2_80.kosha.stage === 'certified' && st2_80.kosha.checks.length === 1 && st2_80.kosha.checks[0].note === '공단 사후점검 적합'
    && JSON.stringify(st2_80.prev) === JSON.stringify({ kosha: st1_80.kosha, headcount: st1_80.headcount, updated_at: st1_80.updated_at, updated_by: 'uadmin' }) && JSON.stringify(w2_80.body.prev) === JSON.stringify({ updated_at: st1_80.updated_at, updated_by: 'uadmin' })
    && au2_80.length === 2 && Object.keys(au2_80[1].ev[0].f).join(',') === 'kosha.stage,kosha.review_on,kosha.decided_on,kosha.expires_on,kosha.rate_year,kosha.checks,headcount.env,headcount.con' && au2_80[1].by === '관리자80',
    JSON.stringify({ w2: [w2_80.code, w2_80.body.error_code], prev: st2_80 && st2_80.prev, f: au2_80[1] && au2_80[1].ev[0].f }));

  // ⑤ 값 검사 → 400(이유 코드) · 저장 0·감사 0 · 틀린 값 + 낡은 base = 400(값 검사가 먼저)
  const base2_80 = st2_80 ? st2_80.updated_at : -1, snap2_80 = JSON.stringify(mem.gw_data[KEY80]), aud2n80 = aud80().length;
  const BAD80 = [
    ['BAD_STAGE', { kosha: K80({ stage: 'approved' }) }], ['BAD_STAGE', { kosha: K80({ stage: '' }) }],
    ['BAD_DATE', { kosha: K80({ applied_on: '2026-13-01' }) }], ['BAD_DATE', { kosha: K80({ expires_on: '2026-02-30' }) }], ['BAD_DATE', { kosha: K80({ review_on: '20261110' }) }], ['BAD_DATE', { kosha: K80({ decided_on: 20261110 }) }],
    ['BAD_HEADCOUNT', { headcount: { env: -1, con: 4 } }], ['BAD_HEADCOUNT', { headcount: { env: 1000, con: 4 } }], ['BAD_HEADCOUNT', { headcount: { env: 3.5, con: 4 } }], ['BAD_HEADCOUNT', { headcount: { env: 'abc', con: 4 } }], ['BAD_HEADCOUNT', { headcount: { env: 18, con: '1000' } }], ['BAD_HEADCOUNT', { headcount: { env: true, con: 4 } }],
    ['BAD_TEXT', { kosha: K80({ apply_no: 'x'.repeat(41) }) }], ['BAD_TEXT', { kosha: K80({ apply_no: 12 }) }],
    ['BAD_YEAR', { kosha: K80({ rate_year: '27' }) }], ['BAD_YEAR', { kosha: K80({ rate_year: '1999' }) }],
    ['BAD_CHECKS', { kosha: K80({ checks: Array.from({ length: 11 }, (_, i) => ({ date: '2027-03-' + (10 + i), note: '' })) }) }], ['BAD_CHECKS', { kosha: K80({ checks: [{ note: '날짜 없음' }] }) }], ['BAD_CHECKS', { kosha: K80({ checks: [{ date: '2027-02-30', note: '' }] }) }],
    ['BAD_CHECKS', { kosha: K80({ checks: [{ date: '2027-03-01', note: 'x'.repeat(101) }] }) }], ['BAD_CHECKS', { kosha: K80({ checks: 'x' }) }],
    ['BAD_VALUE', { kosha: null }], ['BAD_VALUE', { headcount: [18, 4] }], ['BAD_VALUE', { kosha: 'none' }],
  ];
  const badR80 = [];
  for (const [want, over] of BAD80) { const r = await set80(Object.assign({ base: base2_80 }, V80({}, { env: 18, con: 4 }), over), tokA); badR80.push(r.code === 400 && r.body.error_code === want ? '' : want + '≠' + r.code + '/' + r.body.error_code); }
  const badStale80 = await set80(Object.assign({ base: 1 }, V80({ stage: 'nope' })), tokA);
  T('80 v436 값 검사 → 400 이유 코드: 단계(approved·빈칸) BAD_STAGE · 날짜(13월·2월 30일·20261110·숫자) BAD_DATE · 인원(-1·1000·3.5·abc·"1000"·true) BAD_HEADCOUNT · 접수번호(41자·숫자) BAD_TEXT · 요율 연도(27·1999) BAD_YEAR · 사후점검(11건·날짜 없음·없는 날짜·메모 101자·배열 아님) BAD_CHECKS · kosha·headcount 모양(null·배열·글) BAD_VALUE · 틀린 값 + 낡은 base = 400(값 검사가 먼저) · 전부 저장 0·감사 0',
    badR80.length === BAD80.length && badR80.every((s) => s === '') && badStale80.code === 400 && badStale80.body.error_code === 'BAD_STAGE' && JSON.stringify(mem.gw_data[KEY80]) === snap2_80 && aud80().length === aud2n80,
    badR80.filter(Boolean).join(' | ') + ' / 틀린 값+낡은 base ' + badStale80.code + '/' + badStale80.body.error_code);

  // ⑥ 낙관락 → 409 SAFETY_STALE(낡은 base · base 없음 · 다른 값) · 저장 0·감사 0 / ⑦ 같은 값 → 400 NO_CHANGE(인원 글 "20"·"0"이어도 같은 값)
  const sOld80 = await set80(Object.assign({ base: w1_80.body.updated_at }, V80({ stage: 'review' })), tokA), sNone80 = await set80(V80({ stage: 'review' }), tokA), sOther80 = await set80(Object.assign({ base: base2_80 + 1 }, V80({ stage: 'review' })), tokA);
  const sSame80 = await set80(Object.assign({ base: base2_80 }, { kosha: st2_80 ? st2_80.kosha : null, headcount: { env: '20', con: '0' } }), tokA);
  T('80 v436 낙관락·같은 값: 낡은 base(저장 1의 updated_at — 저장 2 뒤)·base 없음(새 액션 — base를 안 보내는 옛 앱 없음)·다른 값 → 409 SAFETY_STALE · 저장값 그대로 같은 값(인원 "20"·"0" 글) → 400 NO_CHANGE · 전부 저장 0·감사 0',
    [sOld80, sNone80, sOther80].every((x) => x.code === 409 && x.body.error_code === 'SAFETY_STALE') && sSame80.code === 400 && sSame80.body.error_code === 'NO_CHANGE'
    && JSON.stringify(mem.gw_data[KEY80]) === snap2_80 && aud80().length === aud2n80,
    [sOld80, sNone80, sOther80, sSame80].map((x) => x.code + '/' + x.body.error_code).join(' | '));

  // ⑧ 읽기 실패·깨진 저장값 → 500(빈 값으로 '입력 전'을 그리거나 그 위에 쓰지 않음) · 다른 길(get collection)로는 못 읽음
  const fg080 = blobsMock.hooks.failGet; blobsMock.hooks.failGet = (k) => k === KEY80;
  const fG80 = await get80(tMin80, 'dev1'), fS80 = await set80(Object.assign({ base: base2_80 }, V80({ stage: 'review' })), tokA);
  blobsMock.hooks.failGet = fg080;
  const fSnap80 = JSON.stringify(mem.gw_data[KEY80]);
  mem.gw_data[KEY80] = { schema: 1, kosha: { stage: 'weird' }, headcount: {}, updated_at: 5 };   // 모양이 깨진 저장값(손으로 고친 블롭 등)
  const iG80 = await get80(tMin80, 'dev1'), iS80 = await set80(Object.assign({ base: 5 }, V80({ stage: 'review' })), tokA), iSnap80 = JSON.stringify(mem.gw_data[KEY80]);
  const oc1_80 = await call({ action: 'get', collection: 'settings:safety' }, tokA), oc2_80 = await call({ action: 'get', collection: 'safety' }, tokA);
  T('80 v436 읽기 실패·깨진 저장값 → 500: 읽기 실패 = 읽기 STORAGE_READ_FAILED(settings 없음)·쓰기 SETTINGS_READ_FAILED(저장 0) · 깨진 저장값 = 읽기 SETTINGS_INVALID·쓰기 SETTINGS_READ_FAILED(그대로) · 다른 길 get collection(settings:safety·safety) → 400 UNKNOWN_COLLECTION · 감사 0',
    fG80.code === 500 && fG80.body.error_code === 'STORAGE_READ_FAILED' && fG80.body.settings === undefined && fS80.code === 500 && fS80.body.error_code === 'SETTINGS_READ_FAILED' && fSnap80 === snap2_80
    && iG80.code === 500 && iG80.body.error_code === 'SETTINGS_INVALID' && iS80.code === 500 && iS80.body.error_code === 'SETTINGS_READ_FAILED' && iSnap80 === JSON.stringify({ schema: 1, kosha: { stage: 'weird' }, headcount: {}, updated_at: 5 })
    && [oc1_80, oc2_80].every((x) => x.code === 400 && x.body.error_code === 'UNKNOWN_COLLECTION') && aud80().length === aud2n80,
    [fG80, fS80, iG80, iS80, oc1_80, oc2_80].map((x) => x.code + '/' + x.body.error_code).join(' | '));

  // ⑨ (v436 검토 반영) 상한 딱 그 값은 통과 · 빈칸 ↔ 0명은 다른 값 — 새로 시작(키 없음 = base 0). 41자·101자·11건·1000 거절은 ⑤, 여기는 그 바로 아래가 통과하는지(비교를 >=로 바꾸면 앱이 보내는 값을 서버가 거절)
  mem.gw_data[KEY80] = null;
  const aud9n80 = aud80().length;
  const edge80 = V80({ stage: 'certified', apply_no: 'A'.repeat(40), checks: Array.from({ length: 10 }, (_, i) => ({ date: '2027-03-' + (10 + i), note: i === 0 ? 'n'.repeat(100) : '' })) }, { env: 999, con: '' });
  const e1_80 = await set80(Object.assign({ base: 0 }, edge80), tokA), eSt1_80 = JSON.parse(JSON.stringify(mem.gw_data[KEY80] || null));
  const e2_80 = await set80(Object.assign({ base: e1_80.body.updated_at }, edge80, { headcount: { env: 999, con: 0 } }), tokA), eAu2_80 = aud80().slice(-1)[0], eCon2_80 = mem.gw_data[KEY80] && mem.gw_data[KEY80].headcount.con;
  const e3_80 = await set80(Object.assign({ base: e2_80.body.updated_at }, edge80), tokA), eAu3_80 = aud80().slice(-1)[0], eCon3_80 = mem.gw_data[KEY80] && mem.gw_data[KEY80].headcount.con;
  T('80 v436 상한 경계·빈칸↔0(검토 반영): 접수번호 40자·메모 100자·사후점검 10건·인원 999 → 200(그대로 저장) · 빈칸 → 0명 = 200(같은 값 아님 — 저장 0)·감사 f {"headcount.con": ["", "0"]}·글 "상시근로자 종운건설 —→0" · 0명 → 빈칸 = 200·감사 f {"headcount.con": ["0", ""]} · 감사 +3줄',
    e1_80.code === 200 && !!eSt1_80 && eSt1_80.kosha.apply_no === 'A'.repeat(40) && eSt1_80.kosha.checks.length === 10 && eSt1_80.kosha.checks[0].note === 'n'.repeat(100) && eSt1_80.headcount.env === 999 && eSt1_80.headcount.con === ''
    && e2_80.code === 200 && eCon2_80 === 0 && !!eAu2_80 && JSON.stringify(eAu2_80.ev[0].f) === JSON.stringify({ 'headcount.con': ['', '0'] }) && eAu2_80.ev[0].t === '상시근로자 종운건설 —→0'
    && e3_80.code === 200 && eCon3_80 === '' && !!eAu3_80 && JSON.stringify(eAu3_80.ev[0].f) === JSON.stringify({ 'headcount.con': ['0', ''] }) && aud80().length === aud9n80 + 3,
    JSON.stringify({ e: [e1_80.code + '/' + (e1_80.body.error_code || ''), e2_80.code + '/' + (e2_80.body.error_code || ''), e3_80.code + '/' + (e3_80.body.error_code || '')], f2: eAu2_80 && eAu2_80.ev[0].f, f3: eAu3_80 && eAu3_80.ev[0].f }));

  // ⑩ (v436 검토 반영) 사후점검 — 같은 값 판정은 정규화한 값째: 한 줄에 둘을 적은 1건('적합 / 2028-06-01 적합') → 2건으로 나눔 = 감사용 납작한 글은 같아도 200(NO_CHANGE 아님)
  //   감사 글은 건수 + 뺀 줄·더한 줄(이어 붙여 80자에서 자르던 때는 긴 이력의 뒤쪽 줄을 고치면 이전·새 값이 같게 찍혔다) · 순서만 바꿈 = '순서만 바뀜' · 정말 같은 값은 NO_CHANGE 그대로
  const one80 = V80({ stage: 'certified', checks: [{ date: '2027-06-01', note: '적합 / 2028-06-01 적합' }] }, { env: 18, con: 4 });
  const two80 = V80({ stage: 'certified', checks: [{ date: '2027-06-01', note: '적합' }, { date: '2028-06-01', note: '적합' }] }, { env: 18, con: 4 });
  const c1_80 = await set80(Object.assign({ base: e3_80.body.updated_at }, one80), tokA);
  const c2_80 = await set80(Object.assign({ base: c1_80.body.updated_at }, two80), tokA), cSt2_80 = JSON.parse(JSON.stringify(mem.gw_data[KEY80] || null)), cAu2_80 = aud80().slice(-1)[0];
  const long80 = V80({ stage: 'certified', checks: [{ date: '2027-06-01', note: '가'.repeat(90) }, { date: '2028-06-01', note: '적합' }, { date: '2029-06-01', note: '적합' }] }, { env: 18, con: 4 });
  const c3_80 = await set80(Object.assign({ base: c2_80.body.updated_at }, long80), tokA);
  const long2_80 = JSON.parse(JSON.stringify(long80)); long2_80.kosha.checks[2].note = '부적합 — 시정 요구';
  const c4_80 = await set80(Object.assign({ base: c3_80.body.updated_at }, long2_80), tokA), cAu4_80 = aud80().slice(-1)[0];
  const swap80 = JSON.parse(JSON.stringify(long2_80)); swap80.kosha.checks = [swap80.kosha.checks[1], swap80.kosha.checks[0], swap80.kosha.checks[2]];
  const c5_80 = await set80(Object.assign({ base: c4_80.body.updated_at }, swap80), tokA), cAu5_80 = aud80().slice(-1)[0], audC5n80 = aud80().length, snapC5_80 = JSON.stringify(mem.gw_data[KEY80]);
  const c6_80 = await set80(Object.assign({ base: c5_80.body.updated_at }, swap80), tokA);
  T('80 v436 사후점검 같은 값 판정·감사 글(검토 반영): 1건("적합 / 2028-06-01 적합") → 같은 글 2건 = 200·2건 저장·감사 f "1건 · 뺌 …" → "2건 · 더함 …" · 긴 이력(첫 메모 90자) 3번째 줄만 고침 = 감사 f "3건 · 뺌 2029-06-01 적합" → "3건 · 더함 2029-06-01 부적합 — 시정 요구"(이전 ≠ 새)·글 t 같은 뜻 · 순서만 바꿈 = 200·"3건" → "3건 · 순서만 바뀜" · 정말 같은 값 = 400 NO_CHANGE(저장 0·감사 0)',
    c1_80.code === 200 && c2_80.code === 200 && !!cSt2_80 && JSON.stringify(cSt2_80.kosha.checks) === JSON.stringify(two80.kosha.checks)
    && !!cAu2_80 && JSON.stringify(cAu2_80.ev[0].f) === JSON.stringify({ 'kosha.checks': ['1건 · 뺌 2027-06-01 적합 / 2028-06-01 적합', '2건 · 더함 2027-06-01 적합 / 2028-06-01 적합'] })
    && c3_80.code === 200 && c4_80.code === 200 && !!cAu4_80 && JSON.stringify(cAu4_80.ev[0].f) === JSON.stringify({ 'kosha.checks': ['3건 · 뺌 2029-06-01 적합', '3건 · 더함 2029-06-01 부적합 — 시정 요구'] })
    && cAu4_80.ev[0].t === '사후점검 3건 · 뺌 2029-06-01 적합→3건 · 더함 2029-06-01 부적합 — 시정 요구'
    && c5_80.code === 200 && !!cAu5_80 && JSON.stringify(cAu5_80.ev[0].f) === JSON.stringify({ 'kosha.checks': ['3건', '3건 · 순서만 바뀜'] })
    && c6_80.code === 400 && c6_80.body.error_code === 'NO_CHANGE' && aud80().length === audC5n80 && JSON.stringify(mem.gw_data[KEY80]) === snapC5_80,
    JSON.stringify({ c: [c1_80, c2_80, c3_80, c4_80, c5_80, c6_80].map((x) => x.code + '/' + (x.body.error_code || '')), f2: cAu2_80 && cAu2_80.ev[0].f, f4: cAu4_80 && cAu4_80.ev[0].f, f5: cAu5_80 && cAu5_80.ev[0].f }));

  mem.gw_users = savedUsers80;
  if (had80 === undefined) delete mem.gw_data[KEY80]; else mem.gw_data[KEY80] = had80;
}

{ // ---- 81(v437) 45 C026 — 자동 지시 생성 알림 '담당자 본인' 전환 뒤 첫 7일 관리자 병행을 앱 경로에도(게이트 보고 5-2 1-a · 게이트 ③ '1주 병행' 맞춤, 서버만).
  //   판정 한 곳 notifyParallelOn(settings:notify updated_at 기준 7일 — 없거나 0이면 병행 끝)을 봇 경로(bot_notify 태그 auto-due)와 앱 경로(push_send __admins__ 태그 auto-due·rec-over·bid-qual)가 같이 쓴다.
  //   병행 중 = 앱 경로는 삼키지 않고 종전처럼 관리자 전원(보낸 사람 제외) · 봇 경로도 관리자 전원 / 병행 끝 = 앱 경로 sent 0·suppressed 'task_auto_create' · 봇 경로 sent 0·'관리자 푸시 생략' 안내.
  //   담당자 1발(save → notifyAutoCreated)은 병행과 상관없이 나간다 · admins 모드·설정 없음은 지금처럼 나감 · 다른 태그·__admins__ 아닌 대상은 영향 없음.
  //   응답 코드만이 아니라 받는 사람 id·이유 코드(suppressed)·응답 키 목록·안내 글(note)까지 본다. 경계 = 7일 ± 1분 + 시계를 멈춘 정확한 7일(≤)·1ms 뒤.
  //   검토 반영(11/10): ⑧ 옛 블롭에서 실제 notify_set으로 전환 = 병행 시작(저장 시각·다른 칸·prev·감사) · ⑨ 알려진 한계(다른 칸·되돌리기 = 병행 7일 다시) 동작 고정.
  const savedUsers81 = JSON.parse(JSON.stringify(mem.gw_users)), savedSend81 = pushMock.sendTo, realNow81 = Date.now;
  const keep81 = {}; ['settings:notify', 'settings:assign', 'col:tasks'].forEach((k) => { keep81[k] = Object.prototype.hasOwnProperty.call(mem.gw_data, k) ? JSON.parse(JSON.stringify(mem.gw_data[k])) : undefined; });
  const sent81 = [];
  try {
    mem.gw_users['device:dev1'] = { status: 'approved' };
    const mk81 = (id, extra) => { mem.gw_users['member:' + id] = Object.assign({ id, name: id, role: '직원', admin: false, perms: {} }, extra); return issueSession(mem.gw_users['member:' + id]).token; };
    mk81('u81adm', { name: '관리자81', role: '관리자', admin: true, tier: 'admin' });   // 관리자가 둘 이상이어야 '보낸 사람 제외'가 보인다
    const tWk81 = mk81('u81wk', { name: '정재욱형81', perms: { tasks: 'do', veh: 'do' } });
    pushMock.sendTo = async (ids, p) => { sent81.push({ ids: ids.slice().sort(), tag: p.tag }); return { sent: ids.length, removed: 0 }; };
    const adm81 = (await pushMock.adminIds()).slice().sort(), admNoA81 = adm81.filter((id) => id !== 'uadmin');
    const D81 = 86400000, TAGS81 = ['auto-due', 'rec-over', 'bid-qual'];
    const nf81 = (ev, at) => { const d = { schema: 1, events: { task_auto_create: ev }, prev: null, updated_by: 'uadmin' }; if (at !== undefined) d.updated_at = at; mem.gw_data['settings:notify'] = d; };
    const app81 = async (tag, tok, dev, to) => { sent81.length = 0; const x = await call({ action: 'push_send', to: to || '__admins__', title: '자동 지시', body: 'x', tag: tag }, tok, dev); return { code: x.code, body: x.body, s: sent81.slice() }; };
    const bot81 = async (tag) => { sent81.length = 0; const x = await call({ action: 'bot_notify', key: 'test-ingest-key', title: '정기업무 1건', body: 'x', tag: tag }, null); return { code: x.code, body: x.body, s: sent81.slice() }; };
    const ks81 = (b) => Object.keys(b).sort().join(',');
    const went81 = (x, want, tag) => x.code === 200 && x.body.status === 'OK' && ks81(x.body) === 'request_id,sent,skipped,status' && x.body.sent === want.length && x.body.skipped === 0 && x.s.length === 1 && x.s[0].ids.join(',') === want.join(',') && x.s[0].tag === tag;
    const ate81 = (x) => x.code === 200 && x.body.status === 'OK' && ks81(x.body) === 'request_id,sent,status,suppressed' && x.body.sent === 0 && x.body.suppressed === 'task_auto_create' && x.s.length === 0;
    const botWent81 = (x, tag) => x.code === 200 && x.body.status === 'OK' && ks81(x.body) === 'admins,devices,removed,request_id,sent,status' && x.body.sent === adm81.length && x.body.admins === adm81.length && x.s.length === 1 && x.s[0].ids.join(',') === adm81.join(',') && x.s[0].tag === (tag || 'auto-due');
    const botAte81 = (x) => x.code === 200 && x.body.status === 'OK' && ks81(x.body) === 'admins,devices,note,request_id,sent,status' && x.body.sent === 0 && x.body.devices === 0 && x.body.admins === adm81.length && x.body.note === 'task_auto_create=assignee — 관리자 푸시 생략(담당자 본인 1발은 ingest가 보냄)' && x.s.length === 0;
    //   한 상태에서 앱 경로(직원이 쏨 · 관리자가 쏨 × 태그 셋)와 봇 경로(auto-due)를 함께 돌려 둘이 같은 판정인지 본다
    const run81 = async () => { const w = [], a = []; for (const tg of TAGS81) { w.push(await app81(tg, tWk81, 'dev1')); a.push(await app81(tg, tokA)); } return { w, a, b: await bot81('auto-due') }; };
    const on81 = (r) => r.w.every((x, i) => went81(x, adm81, TAGS81[i])) && r.a.every((x, i) => went81(x, admNoA81, TAGS81[i])) && botWent81(r.b);
    const off81 = (r) => r.w.every(ate81) && r.a.every(ate81) && botAte81(r.b);
    const sh81 = (r) => JSON.stringify({ w: r.w.map((x) => [x.body.sent, x.body.suppressed || '', x.s.length]), a: r.a.map((x) => [x.body.sent, x.body.suppressed || '', x.s.length]), b: [r.b.body.sent, r.b.body.note || '', r.b.s.length] });

    // ① 병행 중 — 전환 직후(updated_at = 지금) · 7일 1분 전: 앱 경로 세 태그 모두 관리자 전원(직원이 쏘면 관리자 전원, 관리자가 쏘면 본인 빼고 — 종전 규칙) · 봇 경로도 관리자 전원
    nf81('assignee', Date.now()); const rNow81 = await run81();
    nf81('assignee', Date.now() - 7 * D81 + 60000); const rIn81 = await run81();
    T('81 v437 병행 중(전환 직후 · 7일 1분 전): 앱 경로 auto-due·rec-over·bid-qual 관리자 푸시를 삼키지 않음 — 직원이 쏘면 관리자 전원 · 관리자가 쏘면 본인 빼고(종전 규칙) · 응답 키 status·sent·skipped·request_id(suppressed 없음) · 봇 경로 auto-due도 관리자 전원(응답 키 admins·devices·removed)',
      adm81.length >= 2 && admNoA81.length === adm81.length - 1 && on81(rNow81) && on81(rIn81), sh81(rNow81) + ' / ' + sh81(rIn81) + ' adm ' + adm81.join(','));

    // ② 병행 끝 — 7일 1분 뒤 · updated_at 없음 · 0: 앱 경로 세 태그 모두 삼킴(sent 0 · suppressed 'task_auto_create' · 발송 0) · 봇 경로 생략(sent 0 · devices 0 · 안내 글)
    nf81('assignee', Date.now() - 7 * D81 - 60000); const rOut81 = await run81();
    nf81('assignee'); const rNone81 = await run81();
    nf81('assignee', 0); const rZero81 = await run81();
    T('81 v437 병행 끝(7일 1분 뒤 · updated_at 없음 · 0): 앱 경로 세 태그 모두 서버가 삼킴(응답 키 status·sent·suppressed·request_id = sent 0 · suppressed task_auto_create · 발송 0 — 직원·관리자 같음) · 봇 경로 auto-due도 생략(sent 0 · devices 0 · 안내 글 그대로 · 발송 0)',
      off81(rOut81) && off81(rNone81) && off81(rZero81), sh81(rOut81) + ' / ' + sh81(rNone81) + ' / ' + sh81(rZero81));

    // ③ 경계(시계를 멈춤): 저장 뒤 정확히 7일 = 병행 중(≤) · 7일 1ms 뒤 = 끝 · 저장 시각이 1분 미래(서버 사이 시계 차) = 병행 중 · 숫자 아닌 깨진 값 = 끝(없음과 같음)
    const T0_81 = realNow81(); Date.now = () => T0_81;
    nf81('assignee', T0_81 - 7 * D81); const rEq81 = await run81();
    nf81('assignee', T0_81 - 7 * D81 - 1); const rEq1_81 = await run81();
    nf81('assignee', T0_81 + 60000); const rFut81 = await run81();
    nf81('assignee', 'abc'); const rBad81 = await run81();
    Date.now = realNow81;
    T('81 v437 경계(시계 멈춤): 저장 뒤 정확히 7일 = 병행 중(≤ — 앱 세 태그·봇 모두 관리자 전원) · 7일 1ms 뒤 = 병행 끝(앱 삼킴·봇 생략) · 저장 시각이 1분 미래(서버 사이 시계 차) = 병행 중 · 숫자 아닌 깨진 값 = 병행 끝(없음과 같음)',
      on81(rEq81) && off81(rEq1_81) && on81(rFut81) && off81(rBad81), [rEq81, rEq1_81, rFut81, rBad81].map(sh81).join(' / '));

    // ④ admins 모드(30일 전 저장 · 방금 저장)·설정 없음(기본 admins) → 지금처럼 나감 — 병행 판정을 타지 않음
    nf81('admins', Date.now() - 30 * D81); const rA1_81 = await run81();
    nf81('admins', Date.now()); const rA2_81 = await run81();
    delete mem.gw_data['settings:notify']; const rA3_81 = await run81();
    T('81 v437 task_auto_create = admins(30일 전 저장 · 방금 저장)·설정 없음(기본 admins): 앱 경로 세 태그·봇 경로 모두 지금처럼 관리자 전원(직원이 쏘면 전원 · 관리자가 쏘면 본인 빼고)',
      on81(rA1_81) && on81(rA2_81) && on81(rA3_81), [rA1_81, rA2_81, rA3_81].map(sh81).join(' / '));

    // ⑤ 다른 태그·다른 대상은 영향 없음 — 병행 끝(assignee, 8일 전)에도: task-rv-(완료 요청 — task_review 기본 admins라 관리자 전원)·auto-new-(서버 담당자 1발 태그)·비슷한 이름·그 밖 · __admins__ 아닌 대상(회원 id) · 봇 경로 다른 태그(backup-stale·rec-over)
    nf81('assignee', Date.now() - 8 * D81);
    const o81 = [];
    for (const tg of ['task-rv-t81', 'auto-new-u81wk-2026-11-13', 'auto-due-x', 'x-auto-due', 'etc']) o81.push({ tg, x: await app81(tg, tWk81, 'dev1') });
    const toOne81 = await app81('auto-due', tokA, undefined, 'u81wk');
    const bOther81 = [await bot81('backup-stale'), await bot81('rec-over')];
    T('81 v437 다른 태그·대상은 영향 없음(병행 끝 assignee에서도): 앱 경로 task-rv-·auto-new-·auto-due-x·x-auto-due·etc = 관리자 전원(suppressed 없음) · 대상이 회원 id(__admins__ 아님)면 auto-due도 그 사람에게 · 봇 경로 backup-stale·rec-over = 관리자 전원(봇은 auto-due만 판정)',
      o81.every((o) => went81(o.x, adm81, o.tg)) && went81(toOne81, ['u81wk'], 'auto-due') && botWent81(bOther81[0], 'backup-stale') && botWent81(bOther81[1], 'rec-over'),
      JSON.stringify(o81.map((o) => [o.tg, o.x.body.sent, o.x.body.suppressed || ''])) + ' one ' + JSON.stringify(toOne81.body) + ' bot ' + JSON.stringify(bOther81.map((x) => x.body)));

    // ⑥ 담당자 1발(save → notifyAutoCreated)은 병행과 상관없이 나간다: 병행 중 = 담당자 1발 + 앱 관리자 푸시 둘 다 · 병행 끝 = 담당자 1발 그대로 + 앱 관리자 푸시는 삼킴
    mem.gw_data['settings:assign'] = { schema: 1, rules: { 'veh:': { who_id: 'u81wk' } }, approver_id: '', prev: null, updated_at: 5, updated_by: 'x' };
    mem.gw_data['col:tasks'] = { schema: 1, items: [] };
    const today81 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const save81 = async (id, key) => { sent81.length = 0; const items = JSON.parse(JSON.stringify(mem.gw_data['col:tasks'].items)); items.push({ id, title: '81가' + id + ' 정기검사 갱신', auto_key: key, who_id: '', who: '', status: 'open', from: '자동', due: '2026-11-20' }); const x = await call({ action: 'save', collection: 'tasks', doc: { schema: 1, items } }, tokA); return { code: x.code, s: sent81.slice() }; };
    const one81 = (x) => x.code === 200 && x.s.length === 1 && x.s[0].ids.join(',') === 'u81wk' && x.s[0].tag === 'auto-new-u81wk-' + today81;
    nf81('assignee', Date.now());
    const sv1_81 = await save81('t81a', 'veh:81a:insp:2026-11-20'), ap1_81 = await app81('auto-due', tokA);
    nf81('assignee', Date.now() - 7 * D81 - 60000);
    const sv2_81 = await save81('t81b', 'veh:81b:insp:2026-11-20'), ap2_81 = await app81('auto-due', tokA);
    T('81 v437 담당자 1발(save → notifyAutoCreated)은 병행과 상관없이: 병행 중 = 담당자 1발(auto-new-담당-오늘 · 받는 사람 담당 1명) + 앱 auto-due 관리자 푸시(본인 빼고) 둘 다 · 병행 끝 = 담당자 1발 그대로(앞서 알린 지시는 다시 안 보냄) + 앱 관리자 푸시는 삼킴',
      one81(sv1_81) && went81(ap1_81, admNoA81, 'auto-due') && one81(sv2_81) && ate81(ap2_81), JSON.stringify([sv1_81, ap1_81.body, sv2_81, ap2_81.body]));

    // ⑦ 판정 한 곳(원문, 주석 뺌): notifyParallelOn 정의 1 · 상수 NOTIFY_PARALLEL_MS = 7일 한 줄 · 봇·앱 두 핸들러가 1번씩 부름(그 밖 호출 0) · 두 핸들러 안에 updated_at·86400000 식 0(7일 식을 다시 풀어 쓰지 않음) · 담당자 1발은 병행 판정을 안 봄
    const src81 = require('fs').readFileSync(join(FN, 'gw-data.js'), 'utf8');
    const nc81 = (s) => s.split('\n').map((ln) => ln.replace(/(^|[^:"'])\/\/.*$/, '$1')).join('\n');
    const fnb81 = (name) => { const i = src81.indexOf('function ' + name + '('); if (i < 0) return ''; let dd = 0, st = false; for (let j = i; j < src81.length; j++) { const ch = src81[j]; if (ch === '{') { dd++; st = true; } else if (ch === '}') { dd--; if (st && dd === 0) return nc81(src81.slice(i, j + 1)); } } return ''; };
    const srcNC81 = nc81(src81), bB81 = fnb81('handleBotNotify'), bA81 = fnb81('handlePushSend'), bN81 = fnb81('notifyAutoCreated'), bP81 = fnb81('notifyParallelOn');
    T('81 v437 판정 한 곳(원문 — 주석 뺌): notifyParallelOn 정의 1(지금 − updated_at ≤ NOTIFY_PARALLEL_MS, 없음·0 → 0) · 상수 NOTIFY_PARALLEL_MS = 7 * 86400000 한 줄 · 봇(handleBotNotify)·앱(handlePushSend) 핸들러가 1번씩 부름 · 그 밖 호출 0 · 두 핸들러 안에 updated_at·86400000 0 · notifyAutoCreated는 병행 판정을 안 봄',
      (srcNC81.match(/\bfunction notifyParallelOn\(/g) || []).length === 1 && bP81 === 'function notifyParallelOn(nf) { return (Date.now() - Number((nf && nf.updated_at) || 0)) <= NOTIFY_PARALLEL_MS; }'
      && (srcNC81.match(/\bconst NOTIFY_PARALLEL_MS = 7 \* 86400000;/g) || []).length === 1 && (srcNC81.match(/\bNOTIFY_PARALLEL_MS\b/g) || []).length === 2
      && (srcNC81.match(/\bnotifyParallelOn\(/g) || []).length === 3 && (bB81.match(/\bnotifyParallelOn\(/g) || []).length === 1 && (bA81.match(/\bnotifyParallelOn\(/g) || []).length === 1
      && /if \(nfA\.events\.task_auto_create === 'assignee' && !notifyParallelOn\(nfA\)\)/.test(bB81) && bA81.indexOf("if (nfP && nfP.events.task_auto_create === 'assignee' && /^(auto-due|rec-over|bid-qual)$/.test(tagP) && !notifyParallelOn(nfP)) return jr(200, { status: 'OK', sent: 0, suppressed: 'task_auto_create', request_id: R });") > 0
      && !/updated_at|86400000/.test(bB81) && !/updated_at|86400000/.test(bA81) && bN81.length > 100 && !/notifyParallelOn|NOTIFY_PARALLEL_MS/.test(bN81),
      JSON.stringify({ def: bP81, calls: (srcNC81.match(/\bnotifyParallelOn\(/g) || []).length, bot: (bB81.match(/\bnotifyParallelOn\(/g) || []).length, app: (bA81.match(/\bnotifyParallelOn\(/g) || []).length, inline: [/updated_at|86400000/.test(bB81), /updated_at|86400000/.test(bA81)] }));

    // ⑧ 실제 저장 경로(검토 반영 — 50절은 블롭 없는 첫 저장, ①~⑥은 updated_at을 직접 심어 저장 핸들러를 안 탄다): 운영 11/13 모양 그대로 옛 블롭(5칸 · 30일 전 저장)이 있는 상태에서
    //    notify_set(task_auto_create → assignee, base = 옛 저장 시각) → 응답·블롭 updated_at = 전환 시각(호출 구간 안 — 병행 시작) · 다른 칸 그대로(휴가 2종은 블롭에 없어 기본값) · prev = 옛 판 · 감사 '알림변경' 1줄
    //    · 곧바로 앱 세 태그·봇 관리자 전원 / 저장 시각을 8일 전으로 옮기면 병행 끝 — 전환 때 옛 updated_at을 그대로 두면(병행 0일) 여기서 터진다
    const OLD81 = { task_auto_create: 'admins', task_review: 'issuer_approver', due_digest: 'summary', bid_result: 'award', bid_fail: 'assignee' };
    const WANT81 = Object.assign({}, OLD81, { task_auto_create: 'assignee', leave_request: 'admins', leave_result: 'applicant' });
    const evSame81 = (ev, want) => !!ev && Object.keys(want).every((k) => ev[k] === want[k]);
    const oldAt81 = Date.now() - 30 * D81;
    mem.gw_data['settings:notify'] = { schema: 1, events: Object.assign({}, OLD81), prev: null, updated_by: 'r1-20261104', updated_at: oldAt81 };
    const aud81 = auditMock.logs.length, tSet81 = Date.now();
    const set81 = await call({ action: 'notify_set', event: 'task_auto_create', value: 'assignee', base: oldAt81 }, tokA);
    const tSetEnd81 = Date.now(), blob81 = JSON.parse(JSON.stringify(mem.gw_data['settings:notify'] || {}));
    const rSet81 = await run81();
    mem.gw_data['settings:notify'].updated_at = Date.now() - 8 * D81; const rSetOut81 = await run81();
    T('81 v437 실제 저장 경로(검토 반영 — 운영처럼 옛 블롭 5칸·30일 전 저장에서 notify_set으로 assignee 전환): 응답·블롭 updated_at = 전환 시각(호출 구간 안 — 병행 시작) · 다른 칸 그대로(완료 요청·만기 임박·개찰·수집 실패, 휴가 2종 기본값) · prev = 옛 판(30일 전·admins) · 감사 알림변경 1줄 · 곧바로 앱 세 태그·봇 관리자 전원 · 저장 시각을 8일 전으로 옮기면 병행 끝(앱 삼킴·봇 생략)',
      set81.code === 200 && set81.body.updated_at >= tSet81 && set81.body.updated_at <= tSetEnd81 && blob81.updated_at === set81.body.updated_at
      && evSame81(set81.body.events, WANT81) && evSame81(blob81.events, WANT81) && !!blob81.prev && blob81.prev.updated_at === oldAt81 && evSame81(blob81.prev.events, OLD81)
      && auditMock.logs.length === aud81 + 1 && auditMock.logs[aud81].ev[0].op === '알림변경' && auditMock.logs[aud81].ev[0].id === 'task_auto_create'
      && on81(rSet81) && off81(rSetOut81),
      JSON.stringify({ code: set81.code, at: [set81.body.updated_at - tSet81, blob81.updated_at === set81.body.updated_at], ev: set81.body.events, prev: blob81.prev ? [blob81.prev.updated_at === oldAt81, blob81.prev.events] : null, aud: auditMock.logs.length - aud81 }) + ' ' + sh81(rSet81) + ' / ' + sh81(rSetOut81));

    // ⑨ 알려진 한계 고정(검토 반영 — FEATURES v437·MANUAL 21-12·gw-data 주석에 적은 동작): assignee인 채 병행이 끝난 뒤(8일 전 저장) 다른 칸을 바꾸거나(notify_set 만기 임박)
    //    [되돌리기](notify_revert)를 하면 저장 시각이 새로 찍혀 병행 7일이 다시 시작된다 — 칸별 시각을 들이면 이 항목과 그 문서들을 함께 고친다(문서만 조용히 틀어지지 않게)
    mem.gw_data['settings:notify'].updated_at = Date.now() - 8 * D81;
    const rLimOff81 = await run81();
    const bDg81 = mem.gw_data['settings:notify'].updated_at, tDg81 = Date.now();
    const dg81 = await call({ action: 'notify_set', event: 'due_digest', value: 'each', base: bDg81 }, tokA);
    const rDg81 = await run81();
    mem.gw_data['settings:notify'].updated_at = Date.now() - 8 * D81;
    const bRv81 = mem.gw_data['settings:notify'].updated_at, tRv81 = Date.now();
    const rv81 = await call({ action: 'notify_revert', base: bRv81 }, tokA);
    const nfRv81 = JSON.parse(JSON.stringify(mem.gw_data['settings:notify'] || {}));
    const rRv81 = await run81();
    T('81 v437 알려진 한계 고정(검토 반영): assignee인 채 병행이 끝난 뒤(8일 전 저장 — 앱 삼킴·봇 생략) 다른 칸 notify_set(만기 임박 → each)·[되돌리기] notify_revert(→ summary)를 하면 저장 시각이 새로 찍혀 병행 7일이 다시 시작(앱 세 태그·봇 관리자 전원) · task_auto_create는 assignee 그대로 · 칸별 시각을 들이면 이 항목·FEATURES v437·MANUAL 21-12·gw-data 주석을 함께 고친다',
      off81(rLimOff81) && dg81.code === 200 && dg81.body.updated_at >= tDg81 && dg81.body.events.task_auto_create === 'assignee' && dg81.body.events.due_digest === 'each' && on81(rDg81)
      && rv81.code === 200 && rv81.body.updated_at >= tRv81 && rv81.body.events.task_auto_create === 'assignee' && rv81.body.events.due_digest === 'summary' && nfRv81.updated_at === rv81.body.updated_at && on81(rRv81),
      JSON.stringify({ dg: [dg81.code, dg81.body.updated_at - tDg81, dg81.body.events && dg81.body.events.due_digest], rv: [rv81.code, rv81.body.updated_at - tRv81, rv81.body.events && rv81.body.events.due_digest] }) + ' ' + [rLimOff81, rDg81, rRv81].map(sh81).join(' / '));
  } finally {
    Date.now = realNow81; pushMock.sendTo = savedSend81; mem.gw_users = savedUsers81;
    Object.keys(keep81).forEach((k) => { if (keep81[k] === undefined) delete mem.gw_data[k]; else mem.gw_data[k] = keep81[k]; });
  }
}

// 82 v444 부동산(온비드 col:onbid) 마감 14일 정리 — PM 11/10 15:56 결정 ⑥ '마감 지난 부동산 물건도 공고와 같은 규칙'(48 v380 공고 정리와 같은 판정 bidPurgeable·bidsCutDate) · ★기본 꺼짐(settings:onbid purge):
//    ① 꺼져 있으면 아무것도 안 지움(수집·저장) ② 세기 onbid_purge dry = 건수만·쓰기 0(관리자 — 비관리자 403·비로그인 401·dry 아니면 400 DRY_ONLY) ③ 켜기 onbid_purge_set(관리자·값 검사·낙관락·같은 값·prev·감사)
//    ④ 켜면 수집이 마감 + 14일 지난 신규·패스(상태 없음 = 신규)만 지우고 검토·참여·사람이 바꾼 상태·마감 없음·마감 꼴 아님·14일째는 보존 + 되살림 방지 + 정리 전 스냅샷 1벌 ⑤ 저장이 되살린 만료 줄을 거름(되살림만이면 스냅샷·감사 없음, 서버 줄을 지우면 스냅샷·감사 '정리')
//    ⑥ 공고 정리와 같은 날짜 경계(같은 표본 — bids_purge dry와 같은 수 · 공고 수집과 같은 남은 줄) ⑦ 저장 충돌(409) 중 정리가 끼어들어도 사람이 바꾼 상태는 남음 ⑧ 다시 끄면 정리 안 함
{
  const day = (n) => new Date(Date.now() + 9 * 3600000 - n * 86400000).toISOString().slice(0, 10);
  const keep82 = {}; ['col:onbid', 'col:bids', 'settings:onbid', 'veridx:onbid', 'veridx:bids'].forEach((k) => { keep82[k] = mem.gw_data[k]; });
  const clrVer82 = () => Object.keys(mem.gw_data).forEach((k) => { if (k === 'veridx:onbid' || k.indexOf('ver:onbid:') === 0 || k === 'veridx:bids' || k.indexOf('ver:bids:') === 0) delete mem.gw_data[k]; });
  const SEED82 = () => [
    { id: 'p1', title: '만료 신규', due: day(20), status: 'new' },
    { id: 'p2', title: '만료 패스', due: day(15), status: '패스' },
    { id: 'p3', title: '경계+1 신규(15일)', due: day(15), status: 'new' },
    { id: 'p4', title: '만료 신규 url 없음', due: day(30), status: 'new', url: '' },
    { id: 'p5', title: '상태 없음 만료', due: day(20) },
    { id: 'h1', title: '만료 검토', due: day(40), status: '검토' },
    { id: 'h2', title: '만료 참여', due: day(30), status: '참여' },
    { id: 'h3', title: '만료 사람 상태', due: day(30), status: '보류' },
    { id: 'k1', title: '유효 신규(13일)', due: day(13), status: 'new' },
    { id: 'k2', title: '경계(14일째)', due: day(14), status: 'new' },
    { id: 'k3', title: '마감 없음', due: '', status: 'new' },
    { id: 'k4', title: '마감 꼴 아님', due: '2026/01/01', status: 'new' },
    { id: 'k5', title: '패스(14일째)', due: day(14), status: '패스' }].map((x) => Object.assign({ url: 'https://onbid.example/' + x.id }, x));
  const ids82 = (k) => ((mem.gw_data[k] && mem.gw_data[k].items) || []).map((x) => x.id).sort().join(',');
  const SURV82 = 'h1,h2,h3,k1,k2,k3,k4,k5';
  try {
    delete mem.gw_data['settings:onbid']; clrVer82();
    mem.gw_data['col:onbid'] = { schema: 1, items: SEED82(), updated_at: 5000 };
    // ② 세기(꺼진 채) — 쓰기 0
    const snap82 = JSON.stringify(mem.gw_data), aud82 = auditMock.logs.length;
    const dry82 = await call({ action: 'onbid_purge', dry: true }, tokA);
    const b82 = dry82.body || {};
    T('82 v444 부동산 정리 세기(꺼진 채): 관리자 dry = 200·on false·지울 5(신규 4·패스 1 — 마감 15일↑ 신규·패스·상태 없음)·남는 마감 지난 사람 상태 3(검토·참여·보류)·마감 없음/꼴 아님 2·지울 것 중 url 없음 1·총 13·기준일 = 오늘 − 14일(KST)·보관 14일 · 쓰기 0(저장소 글자째 그대로·감사 0·스냅샷 0)',
      dry82.code === 200 && b82.dry === true && b82.on === false && b82.would_remove === 5 && b82.by_status && b82.by_status['new'] === 4 && b82.by_status['패스'] === 1 && b82.kept_expired === 3 && b82.no_due === 2 && b82.no_url === 1 && b82.total === 13
      && b82.cut === day(14) && b82.keep_days === 14 && JSON.stringify(mem.gw_data) === snap82 && auditMock.logs.length === aud82 && !mem.gw_data['veridx:onbid'], JSON.stringify(b82));
    const dryS82 = await call({ action: 'onbid_purge', dry: 'true' }, tokA), dryN82 = await call({ action: 'onbid_purge', dry: 1 }, tokA), noDry82 = await call({ action: 'onbid_purge' }, tokA), falseDry82 = await call({ action: 'onbid_purge', dry: false }, tokA);
    const wDry82 = await call({ action: 'onbid_purge', dry: true }, tokW, 'dev1'), anonDry82 = await call({ action: 'onbid_purge', dry: true }, null), botDry82 = await call({ action: 'onbid_purge', dry: true, key: 'test-ingest-key' }, null);
    T('82 v444 세기 관용·막음: dry "true"·1도 세기만(5) · dry 없음·false = 400 DRY_ONLY(지우지 않음) · 비관리자(기기 승인) 403 ADMIN_ONLY · 비로그인 401 · 봇 키만으로는 401(관리자 세션만) · 그사이 저장소 글자째 그대로·감사 0',
      dryS82.code === 200 && dryS82.body.would_remove === 5 && dryN82.code === 200 && dryN82.body.would_remove === 5 && noDry82.code === 400 && noDry82.body.error_code === 'DRY_ONLY' && falseDry82.code === 400 && falseDry82.body.error_code === 'DRY_ONLY'
      && wDry82.code === 403 && wDry82.body.error_code === 'ADMIN_ONLY' && anonDry82.code === 401 && botDry82.code === 401 && JSON.stringify(mem.gw_data) === snap82 && auditMock.logs.length === aud82,
      [dryS82.code, dryN82.code, noDry82.code + '/' + noDry82.body.error_code, falseDry82.code, wDry82.code + '/' + wDry82.body.error_code, anonDry82.code, botDry82.code].join(' '));
    // ① 꺼진 채 수집·저장 = 아무것도 안 지움(되살림 방지도 꺼짐)
    let r82 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'p1', title: '만료 신규', due: day(20) }, { id: 'n1', title: '새 만료', due: day(16) }, { id: 'n2', title: '새 유효', due: day(2) }] });
    T('82 v444 꺼진 채 수집(ingest col onbid): 정리 0·건너뜀 0·새 2(만료 n1도 받음)·15건 그대로(만료 신규·패스 보존)·스냅샷 0(VER_SKIP)',
      r82.code === 200 && r82.body.purged === 0 && r82.body.skipped === 0 && r82.body.added === 2 && r82.body.total === 15 && ids82('col:onbid') === 'h1,h2,h3,k1,k2,k3,k4,k5,n1,n2,p1,p2,p3,p4,p5' && !mem.gw_data['veridx:onbid'], JSON.stringify(r82.body));
    const ua82 = mem.gw_data['col:onbid'].updated_at;
    r82 = await call({ action: 'save', collection: 'onbid', base: ua82, doc: { schema: 1, items: mem.gw_data['col:onbid'].items.concat([{ id: 'z1', title: '되살림 시도(만료 신규)', due: day(30), status: 'new' }]) } }, tokA);
    T('82 v444 꺼진 채 저장(save col onbid): 만료 신규 z1까지 그대로 16건(거르지 않음)·스냅샷 0·감사에 정리 줄 0',
      r82.code === 200 && mem.gw_data['col:onbid'].items.length === 16 && ids82('col:onbid').indexOf('z1') >= 0 && !mem.gw_data['veridx:onbid'] && !auditMock.logs.slice(aud82).some((l) => (l.ev || []).some((e) => e.op === '정리')), r82.code + ' ' + ids82('col:onbid'));
    // ③ 켜기 — 관리자만·값 검사·낙관락·같은 값
    const w82 = await call({ action: 'onbid_purge_set', on: true }, tokW, 'dev1'), an82 = await call({ action: 'onbid_purge_set', on: true }, null), bad82 = await call({ action: 'onbid_purge_set', on: 'yes' }, tokA);
    const same82 = await call({ action: 'onbid_purge_set', on: false }, tokA), stale82 = await call({ action: 'onbid_purge_set', on: true, base: 123 }, tokA);
    T('82 v444 켜기 막음: 비관리자 403 ADMIN_ONLY · 비로그인 401 · 값 "yes" 400 BAD_VALUE · 꺼진 채 끄기 400 NO_CHANGE · 낡은 base 409 ONBID_STALE · 설정 키 생기지 않음',
      w82.code === 403 && w82.body.error_code === 'ADMIN_ONLY' && an82.code === 401 && bad82.code === 400 && bad82.body.error_code === 'BAD_VALUE' && same82.code === 400 && same82.body.error_code === 'NO_CHANGE' && stale82.code === 409 && stale82.body.error_code === 'ONBID_STALE' && !mem.gw_data['settings:onbid'],
      [w82.code, an82.code, bad82.code, same82.code + '/' + same82.body.error_code, stale82.code].join(' '));
    const aud82b = auditMock.logs.length;
    const on82 = await call({ action: 'onbid_purge_set', on: true, base: 0 }, tokA), set82 = mem.gw_data['settings:onbid'] || {};
    const again82 = await call({ action: 'onbid_purge_set', on: true }, tokA), dryOn82 = await call({ action: 'onbid_purge', dry: true }, tokA);
    T('82 v444 켜기(관리자, base 0 = 설정 없음): 200·on true·설정 purge true·keep_days 14·prev {purge false, updated_at 0}·updated_by 관리자 · 감사 1줄(col onbid 정리설정 "끔→켬") · 다시 켜기 400 NO_CHANGE · 세기 on true',
      on82.code === 200 && on82.body.on === true && set82.purge === true && set82.keep_days === 14 && set82.prev && set82.prev.purge === false && set82.prev.updated_at === 0 && set82.updated_by === 'uadmin' && on82.body.updated_at === set82.updated_at
      && auditMock.logs.length === aud82b + 1 && auditMock.logs[aud82b].col === 'onbid' && auditMock.logs[aud82b].ev[0].op === '정리설정' && /끔→켬/.test(auditMock.logs[aud82b].ev[0].t)
      && again82.code === 400 && again82.body.error_code === 'NO_CHANGE' && dryOn82.body.on === true, JSON.stringify({ on82: on82.body, set82, again: again82.code }));
    // ④ 켜진 채 수집: 마감 + 14일 지난 신규·패스만 정리·사람 상태·14일째·마감 없음·꼴 아님 보존·되살림 방지·정리 전 스냅샷 1벌
    clrVer82(); mem.gw_data['col:onbid'] = { schema: 1, items: SEED82(), updated_at: 6000 };
    r82 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'p1', title: '만료 신규', due: day(20) }, { id: 'n1', title: '새 만료', due: day(16) }, { id: 'n2', title: '새 유효', due: day(2) }, { id: 'h1', title: '만료 검토', due: day(40) }] });
    const vi82 = mem.gw_data['veridx:onbid'], h1b82 = (mem.gw_data['col:onbid'].items || []).find((x) => x.id === 'h1') || {};
    T('82 v444 켜진 채 수집: 정리 5(p1~p5 — 신규·패스·상태 없음·url 없음 포함)·건너뜀 1(원장에 없는 만료 n1)·새 1(n2) · 남은 줄 = 검토·참여·보류·13일·14일째(신규·패스)·마감 없음·꼴 아님 + n2 · 검토 상태 그대로 · VER_SKIP을 넘어 정리 전 스냅샷 1벌(13건·수집봇) · 감사 "정리 5건(마감 14일 경과)"',
      r82.code === 200 && r82.body.purged === 5 && r82.body.skipped === 1 && r82.body.added === 1 && ids82('col:onbid') === SURV82 + ',n2' && h1b82.status === '검토'
      && vi82 && vi82.items.length === 1 && vi82.items[0].tot === 13 && vi82.items[0].by === '수집봇' && auditMock.logs.some((l) => l.col === 'onbid' && (l.ev || []).some((e) => /정리 5건\(마감 14일 경과\)/.test(e.t || ''))), JSON.stringify(r82.body) + ' ' + ids82('col:onbid'));
    // ⑤ 켜진 채 저장: 되살린 만료 신규 z1은 거름·만료 검토 z2·유효 z3 통과 — 되살림만이면 스냅샷·감사 정리 줄 없음 / 서버 줄(p1)을 지우게 되면 스냅샷 1벌 + 감사 '정리 1건'
    const ub82 = mem.gw_data['col:onbid'].updated_at, aud82c = auditMock.logs.length;
    r82 = await call({ action: 'save', collection: 'onbid', base: ub82, doc: { schema: 1, items: mem.gw_data['col:onbid'].items.concat([{ id: 'z1', title: '되살림(만료 신규)', due: day(30), status: 'new' }, { id: 'z2', title: '만료 검토', due: day(30), status: '검토' }, { id: 'z3', title: '유효', due: day(1), status: 'new' }]) } }, tokA);
    T('82 v444 켜진 채 저장 — 되살림 방지: 만료 신규 z1 거름·만료 검토 z2·유효 z3 통과 · 서버에 없던 줄만 걸렀으니 스냅샷 그대로 1벌·감사 정리 줄 0',
      r82.code === 200 && ids82('col:onbid') === SURV82 + ',n2,z2,z3' && (mem.gw_data['veridx:onbid'] || { items: [] }).items.length === 1 && !auditMock.logs.slice(aud82c).some((l) => (l.ev || []).some((e) => e.op === '정리')), r82.code + ' ' + ids82('col:onbid'));
    mem.gw_data['col:onbid'] = { schema: 1, items: SEED82(), updated_at: 7000 };   // 켠 날 수집보다 저장이 먼저 온 경우(서버 원장에 만료 줄이 아직 있음)
    const aud82d = auditMock.logs.length;
    r82 = await call({ action: 'save', collection: 'onbid', base: 7000, doc: { schema: 1, items: SEED82().map((x) => (x.id === 'k1' ? Object.assign({}, x, { status: '검토' }) : x)) } }, tokA);
    const ev82 = auditMock.logs.slice(aud82d).reduce((a, l) => a.concat(l.ev || []), []), vi82b = mem.gw_data['veridx:onbid'] || { items: [] };
    T('82 v444 켜진 채 저장 — 서버 줄을 지우는 저장: p1~p5 정리·사람이 바꾼 k1 검토 남음 · VER_SKIP을 넘어 저장 전 스냅샷(13건 — 2벌째) · 감사 "부동산 정리 5건(마감 14일 경과 신규·패스 — 저장 때)"',
      r82.code === 200 && ids82('col:onbid') === SURV82 && ((mem.gw_data['col:onbid'].items || []).find((x) => x.id === 'k1') || {}).status === '검토' && vi82b.items.length === 2 && (vi82b.items[0] || {}).tot === 13
      && ev82.some((e) => e.op === '정리' && e.t === '부동산 정리 5건(마감 14일 경과 신규·패스 — 저장 때)'), JSON.stringify({ code: r82.code, ids: ids82('col:onbid'), ver: vi82b.items.length, ev: ev82.map((e) => e.op) }));
    // ⑥ 공고 정리와 같은 날짜 경계 — 같은 표본을 공고 원장에도 두고 세기·수집을 비교
    clrVer82(); mem.gw_data['col:bids'] = { schema: 1, items: SEED82() }; mem.gw_data['col:onbid'] = { schema: 1, items: SEED82() };
    const bd82 = await call({ action: 'bids_purge', mode: 'expired', dry: true }, tokA), od82 = await call({ action: 'onbid_purge', dry: true }, tokA);
    const bi82 = await call({ action: 'bids_ingest', key: 'test-ingest-key', items: [] }), oi82 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [] });
    T('82 v444 공고 정리와 같은 날짜 경계: 같은 표본에서 bids_purge dry 5 = onbid_purge dry 5·기준일 같음 · 빈 수집 뒤 남은 줄 공고 = 부동산(검토·참여·보류·13일·14일째·마감 없음·꼴 아님)',
      bd82.body.would_remove === 5 && od82.body.would_remove === 5 && bd82.body.cut === od82.body.cut && bi82.body.purged === 5 && oi82.body.purged === 5 && ids82('col:bids') === SURV82 && ids82('col:onbid') === SURV82,
      JSON.stringify({ bd: bd82.body.would_remove, od: od82.body.would_remove, cut: [bd82.body.cut, od82.body.cut], b: ids82('col:bids'), o: ids82('col:onbid') }));
    // ⑦ 저장 충돌(409) 중 정리가 끼어들어도 사람이 바꾼 상태는 남음: 관리자 화면이 p1을 검토로 바꾸는 사이 수집이 p1(신규)을 정리 → 낡은 base 저장 409 → 다시 읽어 합친 원장(로컬 우선 — p1 검토)으로 저장 = p1 검토로 남음
    mem.gw_data['col:onbid'] = { schema: 1, items: SEED82(), updated_at: 8000 };
    await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [] });
    const uc82 = mem.gw_data['col:onbid'].updated_at;
    const st82 = await call({ action: 'save', collection: 'onbid', base: 8000, doc: { schema: 1, items: SEED82().map((x) => (x.id === 'p1' ? Object.assign({}, x, { status: '검토' }) : x)) } }, tokA);
    const merged82 = mem.gw_data['col:onbid'].items.concat([Object.assign({}, SEED82()[0], { status: '검토' })]);
    const re82 = await call({ action: 'save', collection: 'onbid', base: uc82, doc: { schema: 1, items: merged82 } }, tokA), p1b82 = (mem.gw_data['col:onbid'].items || []).find((x) => x.id === 'p1') || {};
    T('82 v444 409 중 정리: 수집이 p1(신규)을 정리한 뒤 낡은 base 저장 = 409 STALE_BASE(원장 그대로 8줄) → 합친 원장으로 다시 저장 = p1 검토로 남음(사람이 바꾼 상태는 정리 대상 아님)',
      st82.code === 409 && st82.body.error_code === 'STALE_BASE' && re82.code === 200 && p1b82.status === '검토' && ids82('col:onbid') === 'h1,h2,h3,k1,k2,k3,k4,k5,p1', st82.code + ' ' + re82.code + ' ' + ids82('col:onbid'));
    // ⑧ 다시 끄면(관리자·base) 수집이 정리 안 함
    const off82 = await call({ action: 'onbid_purge_set', on: false, base: (mem.gw_data['settings:onbid'] || {}).updated_at }, tokA), set82b = mem.gw_data['settings:onbid'] || {};
    mem.gw_data['col:onbid'] = { schema: 1, items: SEED82() };
    const oi82b = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n1', title: '새 만료', due: day(16) }] });
    T('82 v444 다시 끄기: 200·설정 purge false·prev purge true · 그 뒤 수집 정리 0·만료 n1도 받음(14건)',
      off82.code === 200 && set82b.purge === false && (set82b.prev || {}).purge === true && oi82b.body.purged === 0 && oi82b.body.skipped === 0 && mem.gw_data['col:onbid'].items.length === 14,
      JSON.stringify({ off: off82.code, ing: oi82b.body }));
  } finally {
    clrVer82();
    Object.keys(keep82).forEach((k) => { if (keep82[k] === undefined) delete mem.gw_data[k]; else mem.gw_data[k] = keep82[k]; });
  }
}

// 83 v444 검토 반영(데이터 삭제 안전 — 서버, 공고·부동산 공통): ① 수집이 원장을 못 읽으면(읽기 실패 — 처음 읽기·쓰기 직전 다시 읽기) 500·쓰기 0(빈 원장에 받은 줄만 다시 쓰지 않음 · 키 없음은 빈 원장으로 시작 그대로)
//    ② 수집이 읽은 뒤 쓰기 전에 관리자 저장이 끼면(정리 전 스냅샷을 쓰는 사이) 쓰기 직전 다시 읽어 새 원장으로 처음부터 — 그사이 신규 → 검토로 바꾼 만료 줄이 지워지지 않음 · 계속 바뀌어도 셋째 번은 씀(끝없이 돌지 않음)
//    ③ 시점 복구(ver_restore)의 복구 전 자동보존이 스냅샷 제외(VER_SKIP) 부동산·공고에도 남음(종전엔 말없이 건너뜀) ④ 새로 받은 줄 created = KST 날짜(UTC 전날 22시대 수집 = KST 다음 날) · updated는 종전 UTC 날짜
{
  const day = (n) => new Date(Date.now() + 9 * 3600000 - n * 86400000).toISOString().slice(0, 10);
  const keep83 = {}; ['col:onbid', 'col:bids', 'settings:onbid', 'veridx:onbid', 'veridx:bids'].forEach((k) => { keep83[k] = mem.gw_data[k]; });
  const clrVer83 = () => Object.keys(mem.gw_data).forEach((k) => { if (k === 'veridx:onbid' || k.indexOf('ver:onbid:') === 0 || k === 'veridx:bids' || k.indexOf('ver:bids:') === 0) delete mem.gw_data[k]; });
  const fg83 = blobsMock.hooks.failGet, bs83 = blobsMock.hooks.beforeSet, bg83 = blobsMock.hooks.beforeGet, realNow83 = Date.now;
  const SEED83 = () => [
    { id: 'p1', title: '만료 신규', due: day(20), status: 'new' },
    { id: 'p2', title: '만료 패스', due: day(16), status: '패스' },
    { id: 'h1', title: '만료 검토', due: day(30), status: '검토' },
    { id: 'k1', title: '유효 신규', due: day(3), status: 'new' }].map((x) => Object.assign({ url: 'https://onbid.example/' + x.id }, x));
  const ids83 = (k) => ((mem.gw_data[k] && mem.gw_data[k].items) || []).map((x) => x.id + ':' + (x.status || '')).sort().join(',');
  try {
    // ① 읽기 실패 — 처음 읽기(부동산·공고) · 쓰기 직전 다시 읽기 · 키 없음
    clrVer83(); delete mem.gw_data['settings:onbid'];
    mem.gw_data['col:onbid'] = { schema: 1, items: SEED83(), updated_at: 9000 }; mem.gw_data['col:bids'] = { schema: 1, items: SEED83(), updated_at: 9100 };
    const snap83 = JSON.stringify(mem.gw_data), aud83 = auditMock.logs.length;
    blobsMock.hooks.failGet = (k) => k === 'col:onbid' || k === 'col:bids';
    const fo83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n1', title: '새 물건', due: day(-5) }] });
    const fb83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', items: [{ id: 'n1', title: '새 공고', due: day(-5) }] });
    let nr83 = 0; blobsMock.hooks.failGet = (k) => k === 'col:onbid' && ++nr83 === 2;   // 처음 읽기는 되고 쓰기 직전 다시 읽기만 실패
    const fr83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n1', title: '새 물건', due: day(-5) }] });
    blobsMock.hooks.failGet = fg83;
    const same83 = JSON.stringify(mem.gw_data) === snap83 && auditMock.logs.length === aud83;
    // 셋째 회차(다시 읽지 않고 쓰는 회차)의 처음 읽기가 실패해도 500 — 앞 두 회차는 원장이 바뀌어(updated_at) 다시 했고, 셋째 처음 읽기에서 실패 = 빈 원장에 받은 줄만 쓰지 않음
    mem.gw_data['col:onbid'] = { schema: 1, items: SEED83(), updated_at: 9050 };
    let nz83 = 0;
    blobsMock.hooks.beforeGet = async (k) => { if (k === 'col:onbid') { nz83++; mem.gw_data['col:onbid'].updated_at = 9050 + nz83; } if (bg83) await bg83(k); };
    blobsMock.hooks.failGet = (k) => k === 'col:onbid' && nz83 >= 4;   // 읽기 5번째(셋째 회차 처음)부터 실패(실패 판정이 beforeGet보다 먼저 — 넷째까지는 읽힘)
    const fz83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n1', title: '새 물건', due: day(-5) }] });
    blobsMock.hooks.failGet = fg83; blobsMock.hooks.beforeGet = bg83;
    const z83 = fz83.code === 500 && fz83.body.error_code === 'STORAGE_READ_FAILED' && nz83 === 4 && ids83('col:onbid') === 'h1:검토,k1:new,p1:new,p2:패스' && mem.gw_data['col:onbid'].updated_by !== '수집봇' && auditMock.logs.length === aud83;
    delete mem.gw_data['col:onbid'];
    const fn83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n1', title: '새 물건', due: day(-5) }] });
    T('83 v444 검토 ① 수집이 원장을 못 읽으면 500·쓰기 0: 부동산·공고 처음 읽기 실패 = 500 STORAGE_READ_FAILED · 쓰기 직전 다시 읽기 실패 = 500(두 번 읽음) · 그사이 원장·스냅샷·감사 글자째 그대로(받은 줄만으로 덮지 않음) · 셋째 회차(다시 읽지 않고 쓰는 회차) 처음 읽기 실패 = 500·원장 줄·상태 그대로(넷째 읽기까지 되고 다섯째에서 실패) · 키 없음 = 빈 원장으로 시작(200·새 1)',
      fo83.code === 500 && fo83.body.error_code === 'STORAGE_READ_FAILED' && fb83.code === 500 && fb83.body.error_code === 'STORAGE_READ_FAILED' && fr83.code === 500 && nr83 === 2 && same83 && z83
      && fn83.code === 200 && fn83.body.added === 1 && ids83('col:onbid') === 'n1:new', JSON.stringify({ fo: fo83.code + '/' + fo83.body.error_code, fb: fb83.code, fr: fr83.code + '/' + nr83, same83, z: [fz83.code, nz83, z83], fn: fn83.body }));
    // ② 수집 도중 관리자 저장(정리 켜짐) — 정리 전 스냅샷을 쓰는 사이 p1 신규 → 검토(updated_at 바뀜)
    mem.gw_data['settings:onbid'] = { schema: 1, purge: true, keep_days: 14, updated_at: 1 };
    clrVer83(); mem.gw_data['col:onbid'] = { schema: 1, items: SEED83(), updated_at: 9200 };
    let fired83 = 0;
    blobsMock.hooks.beforeSet = (k) => { if (!fired83 && String(k).indexOf('ver:onbid:') === 0) { fired83++; const c = mem.gw_data['col:onbid']; c.items = c.items.map((x) => (x.id === 'p1' ? Object.assign({}, x, { status: '검토' }) : x)); c.updated_at = 9300; } };
    const aud83b = auditMock.logs.length;
    const rc83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n2', title: '새 유효', due: day(-3) }] });
    blobsMock.hooks.beforeSet = bs83;
    const vi83 = (mem.gw_data['veridx:onbid'] || { items: [] }).items, ev83 = auditMock.logs.slice(aud83b).reduce((a, l) => a.concat(l.ev || []), []);
    T('83 v444 검토 ② 수집 도중 관리자 저장(정리 켜짐): 정리 전 스냅샷을 쓰는 사이 p1 신규 → 검토 → 쓰기 직전 다시 읽어 새 원장으로 다시 = p1 검토로 남음(종전엔 낡은 원장으로 정리해 p1이 줄째 지워짐) · 정리 1(만료 패스 p2)·새 1 · 감사 "정리 1건" 한 줄 · 정리 전 스냅샷 1벌(처음 읽은 원장 4건 — 다시 할 때는 같은 날이라 건너뜀)',
      rc83.code === 200 && fired83 === 1 && ids83('col:onbid') === 'h1:검토,k1:new,n2:new,p1:검토' && rc83.body.purged === 1 && rc83.body.added === 1 && mem.gw_data['col:onbid'].updated_by === '수집봇'
      && vi83.length === 1 && vi83[0].tot === 4 && ev83.filter((e) => e.op === '수집').length === 1 && ev83.some((e) => /정리 1건\(마감 14일 경과\)/.test(e.t || '')), JSON.stringify({ code: rc83.code, body: rc83.body, ids: ids83('col:onbid'), ver: vi83.length, ev: ev83.map((e) => e.t) }));
    // ② 계속 바뀌면(읽을 때마다 updated_at이 다름) 셋째 번은 다시 읽지 않고 씀 — 원장 읽기 5번(처음·다시 × 2 + 셋째 처음)
    delete mem.gw_data['settings:onbid']; clrVer83(); mem.gw_data['col:onbid'] = { schema: 1, items: SEED83(), updated_at: 9400 };
    let reads83 = 0; blobsMock.hooks.beforeGet = async (k) => { if (k === 'col:onbid') { reads83++; mem.gw_data['col:onbid'].updated_at = 10000 + reads83; } if (bg83) await bg83(k); };
    const rl83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'n3', title: '새 유효', due: day(-3) }] });
    blobsMock.hooks.beforeGet = bg83;
    T('83 v444 검토 ② 계속 바뀌는 원장: 셋째 번은 다시 읽지 않고 씀(끝없이 돌지 않음) — 200·새 1·원장 읽기 5번·쓴 사람 수집봇',
      rl83.code === 200 && rl83.body.added === 1 && reads83 === 5 && mem.gw_data['col:onbid'].updated_by === '수집봇' && ids83('col:onbid').indexOf('n3:new') >= 0, JSON.stringify({ code: rl83.code, reads83, body: rl83.body }));
    // ③ 시점 복구 — 복구 전 자동보존(VER_SKIP 부동산·공고)
    const TS83 = 1700000000000, vr83 = {};
    for (const col of ['onbid', 'bids']) {
      clrVer83(); mem.gw_data['col:' + col] = { schema: 1, items: SEED83(), updated_at: 9600 };
      mem.gw_data['ver:' + col + ':' + TS83] = { ts: TS83, by: '수집봇', doc: { schema: 1, items: SEED83().slice(0, 2) } };
      mem.gw_data['veridx:' + col] = { items: [{ ts: TS83, by: '수집봇', day: '2023-11-15', tot: 2, live: 2 }] };
      const rr = await call({ action: 'ver_restore', collection: col, ts: TS83 }, tokA);
      const vx = (mem.gw_data['veridx:' + col] || { items: [] }).items, pre = vx.find((e) => e.by === '관리자(복구 전 자동보존)') || null;
      vr83[col] = { code: rr.code, n: mem.gw_data['col:' + col].items.length, idx: vx.length, pre: pre ? pre.tot : null, blob: pre ? ((mem.gw_data['ver:' + col + ':' + pre.ts] || {}).doc || { items: [] }).items.length : null };
    }
    T('83 v444 검토 ③ 시점 복구(스냅샷 제외 VER_SKIP 부동산·공고): 복구 = 200·원장 2건(스냅샷 그대로) · 복구 직전 원장(4건)이 버전 링에 "관리자(복구 전 자동보존)"로 남음(복구를 되돌릴 수 있음 — 종전엔 말없이 건너뜀)',
      ['onbid', 'bids'].every((c) => vr83[c].code === 200 && vr83[c].n === 2 && vr83[c].idx === 2 && vr83[c].pre === 4 && vr83[c].blob === 4), JSON.stringify(vr83));
    // ④ 새 줄 수집일 created = KST 날짜 — UTC 2027-03-01 22:30(KST 03-02 07:30) 수집(Date.now만 흉내 — updated의 new Date()는 실제 시계)
    clrVer83(); mem.gw_data['col:onbid'] = { schema: 1, items: [], updated_at: 9700 };
    Date.now = () => Date.parse('2027-03-01T22:30:00Z');
    let rk83;
    try { rk83 = await call({ action: 'bids_ingest', key: 'test-ingest-key', col: 'onbid', items: [{ id: 'c1', title: '새 물건', due: '2027-04-01' }] }); } finally { Date.now = realNow83; }
    const c83 = (mem.gw_data['col:onbid'].items || []).find((x) => x.id === 'c1') || {};
    T('83 v444 검토 ④ 새 줄 수집일(created) = KST 날짜: UTC 03-01 22:30(KST 03-02 07:30) 수집 = created 2027-03-02 · updated는 종전 UTC 날짜 그대로(앱 mergeBidsLocal 날짜 단위 병합 축 — new Date())',
      rk83.code === 200 && c83.created === '2027-03-02' && c83.updated === new Date().toISOString().slice(0, 10), JSON.stringify(c83));
  } finally {
    blobsMock.hooks.failGet = fg83; blobsMock.hooks.beforeSet = bs83; blobsMock.hooks.beforeGet = bg83; Date.now = realNow83;
    clrVer83();
    Object.keys(keep83).forEach((k) => { if (keep83[k] === undefined) delete mem.gw_data[k]; else mem.gw_data[k] = keep83[k]; });
  }
}

// 84 v447(56 판 1차 — 안전 › 체크 칸 사람별 표): ① gw-auth 회원 칸 4개(사무직 office·관리감독자 지정 supervisor·소속 회사 corp·시험 계정 test_acct) — 필드별 복사(보내지 않은 칸 그대로)·켜짐만 저장(꺼짐은 칸째 지움)·
//   감사 기록(AUD_FIELDS)·소속 회사 값 검사(400 BAD_CORP — 어떤 칸도 바꾸기 전: 이름 색인·다른 칸 그대로)·시험 계정 표식은 관리자만(비관리자 회원 저장은 종전대로 403 ADMIN_ONLY)·비관리자 회원 목록에 네 칸(날짜·인사정보는 여전히 없음)
//   ② col:edu 새 종류 7개·위험성평가 회차 표식(ra{on,type,unit})·숫자 시간 — 행 모양 그대로 저장·낡은 base 409·base 맞으면 200(덮어쓰기 없이 그대로)
//   ③ site_edu_gap이 새 종류 기록에 흔들리지 않음 — 특별교육 판정은 special 종류만: 새 종류만 있으면 has_edu false·이름 0(종전엔 아무 기록 1건이면 전원 미이수 이름) · special + 새 종류 = special만 있을 때와 같은 답 · special_demo는 특별교육 이수 아님
{
  const gwa84 = require(join(FN, 'gw-auth.js'));
  const callA84 = async (body, tok) => { const x = await gwa84.handler({ httpMethod: 'POST', headers: { authorization: tok ? 'Bearer ' + tok : '' }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
  const savedUsers84 = JSON.parse(JSON.stringify(mem.gw_users));
  const had84 = {}; ['col:edu', 'col:asbestos', 'col:workers'].forEach((k) => { had84[k] = Object.prototype.hasOwnProperty.call(mem.gw_data, k) ? JSON.parse(JSON.stringify(mem.gw_data[k])) : undefined; });
  const aud84 = auditMock.logs.length;
  try {
    mem.gw_users = {
      'member:udev84': { id: 'udev84', name: '개발자84', role: '개발자', admin: true, dev: true, perms: {}, tier: 'pm' },
      'member:uadm84': { id: 'uadm84', name: '관리자84', role: '관리자', admin: true, perms: {}, tier: 'admin' },
      'member:uw84': { id: 'uw84', name: '직원84', role: '직원', admin: false, perms: { tasks: 'do', safety: 'do' }, rank: '사원', dept: '운영부', hire_date: '2024-02-01', birth: '1990-01-01' },
      'member:uo84': { id: 'uo84', name: '사무84', role: '직원', admin: false, perms: { tasks: 'do' }, office: true, corp: 'env' },
      'name:직원84': 'uw84', 'name:사무84': 'uo84',
      'device:dev1': { status: 'approved' },
    };
    const tokAdm84 = issueSession(mem.gw_users['member:uadm84']).token, tokW84 = issueSession(mem.gw_users['member:uw84']).token;
    const u84 = () => mem.gw_users['member:uw84'];
    // ① 관리자 저장 — 네 칸 켬(다른 칸은 보내지 않음) → 켜짐 저장·다른 칸(권한·직급·부서·입사일·생년) 그대로·감사 1줄에 네 칸
    let r84 = await callA84({ action: 'member_upsert', id: 'uw84', office: true, supervisor: true, corp: 'con', test_acct: true }, tokAdm84);
    const ev84 = auditMock.logs.slice(aud84).reduce((a, l) => a.concat(l.ev || []), []).filter((e) => e.id === 'uw84');
    const f84 = (ev84[0] && ev84[0].f) || {};
    T('84 v447 ① 회원 칸 4개 저장(관리자): 200 · office·supervisor·test_acct true·corp con · 보내지 않은 칸(perms·rank·dept·hire_date·birth) 그대로 · 감사 1줄 f에 네 칸(없음 → 값)',
      r84.code === 200 && u84().office === true && u84().supervisor === true && u84().corp === 'con' && u84().test_acct === true
      && JSON.stringify(u84().perms) === JSON.stringify({ tasks: 'do', veh: 'view', rec: 'view', lic: 'hide', site: 'hide', check: 'view', con: 'view', cli: 'view', doc: 'view', wk: 'view', quote: 'hide', promo: 'hide', safety: 'do', hw: 'hide', stmt: 'hide' })
      && u84().rank === '사원' && u84().dept === '운영부' && u84().hire_date === '2024-02-01' && u84().birth === '1990-01-01'
      && ev84.length === 1 && ['office', 'supervisor', 'corp', 'test_acct'].every((k) => Array.isArray(f84[k])) && f84.corp[1] === 'con',
      JSON.stringify({ code: r84.code, m: u84(), f: f84 }));
    // ①-2 필드별 복사 — 다른 칸만 보낸 저장(인사 정보)은 네 칸 그대로 · 꺼짐(false·빈 값)은 칸째 지움(false로 남기지 않음 — 감사 소음 0)
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', rank: '주임' }, tokAdm84);
    const keep84 = r84.code === 200 && u84().rank === '주임' && u84().office === true && u84().supervisor === true && u84().corp === 'con' && u84().test_acct === true;
    const aud84b = auditMock.logs.length;
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', office: false, supervisor: false, corp: '', test_acct: false }, tokAdm84);
    const off84 = r84.code === 200 && !('office' in u84()) && !('supervisor' in u84()) && !('corp' in u84()) && !('test_acct' in u84());
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', office: false, supervisor: false, corp: '', test_acct: false }, tokAdm84);   // 같은 꺼짐을 다시 — 감사 줄 0(없음 → 없음)
    const quiet84 = r84.code === 200 && auditMock.logs.slice(aud84b).reduce((a, l) => a.concat(l.ev || []), []).filter((e) => e.id === 'uw84').length === 1;
    T('84 v447 ①-2 필드별 복사·꺼짐: 다른 칸만 보낸 저장 = 네 칸 그대로 · false·빈 값 = 칸째 지움(false·"" 남지 않음) · 같은 꺼짐 다시 저장 = 감사 줄 0',
      keep84 && off84 && quiet84, JSON.stringify({ keep84, off84, quiet84, m: u84() }));
    // ①-2b (v460 — 원장 C085) 자격·담당 교육 대상 표시 quals — 허용 키만 정해진 순서로 · 배열 아님·허용 키 0개 = 칸째 지움 · 보내지 않으면 그대로 · 감사 줄에 quals
    const audQ84 = auditMock.logs.length;
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', quals: ['elec', 'drv', 'hack', 'drv', '__proto__'] }, tokAdm84);
    const q1_84 = r84.code === 200 && JSON.stringify(u84().quals) === '["drv","elec"]';
    const evQ84 = auditMock.logs.slice(audQ84).reduce((a, l) => a.concat(l.ev || []), []).filter((e) => e.id === 'uw84');
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', rank: '주임' }, tokAdm84);
    const q2_84 = r84.code === 200 && JSON.stringify(u84().quals) === '["drv","elec"]';
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', quals: 'drv' }, tokAdm84);
    const q3_84 = r84.code === 200 && !('quals' in u84());
    r84 = await callA84({ action: 'member_upsert', id: 'uw84', quals: ['cm'] }, tokAdm84); r84 = await callA84({ action: 'member_upsert', id: 'uw84', quals: ['nope'] }, tokAdm84);
    const q4_84 = r84.code === 200 && !('quals' in u84());
    T('84 v460 quals(자격·담당 교육 대상 표시): 허용 키만 정해진 순서로 저장(["elec","drv","hack","drv","__proto__"] → ["drv","elec"]) · 감사 1줄 f에 quals · 다른 칸만 보낸 저장 = 그대로 · 배열 아님·허용 키 0개 = 칸째 지움',
      q1_84 && q2_84 && q3_84 && q4_84 && evQ84.length === 1 && Array.isArray((evQ84[0].f || {}).quals), JSON.stringify({ q1_84, q2_84, q3_84, q4_84, ev: evQ84.length, m: u84() }));
    // ①-3 소속 회사 값 검사 — 표 밖 값·객체 = 400 BAD_CORP · 같은 요청의 다른 칸(이름 바꾸기 아님 — 직급·사무직)도 안 바뀜 · 이름 색인 그대로
    const before84 = JSON.stringify(u84());
    const bc1 = await callA84({ action: 'member_upsert', id: 'uw84', corp: 'abc', office: true, rank: '대리' }, tokAdm84);
    const bc2 = await callA84({ action: 'member_upsert', id: 'uw84', corp: { env: 1 }, office: true }, tokAdm84);
    const bc3 = await callA84({ action: 'member_upsert', id: 'uw84', corp: 'toString' }, tokAdm84);
    T('84 v447 ①-3 소속 회사 값 검사: "abc"·객체·상속 키 "toString" = 400 BAD_CORP · 회원 레코드 글자째 그대로(직급·사무직 안 바뀜) · 이름 색인 그대로 · env·con만 받음',
      [bc1, bc2, bc3].every((x) => x.code === 400 && x.body.error_code === 'BAD_CORP') && JSON.stringify(u84()) === before84 && mem.gw_users['name:직원84'] === 'uw84',
      [bc1, bc2, bc3].map((x) => x.code + '/' + x.body.error_code).join(' | '));
    // ①-4 시험 계정 표식은 관리자만 — 비관리자(안전 수행이어도)의 회원 저장은 종전대로 403 ADMIN_ONLY·표식 그대로 · 서버 코드는 칸 앞(이름 색인 지우기보다 먼저)에서 관리자 검사
    const t84 = await callA84({ action: 'member_upsert', id: 'uw84', test_acct: true }, tokW84);
    const src84 = require('fs').readFileSync(join(FN, 'gw-auth.js'), 'utf8');
    const iChk84 = src84.indexOf("if (d.test_acct !== undefined && !c.member.admin) return jr(403, { status: 'FORBIDDEN', error_code: 'ADMIN_ONLY', request_id: R });"), iCorp84 = src84.indexOf("error_code: 'BAD_CORP'"), iName84 = src84.indexOf('if (nameChange) { await blobSet(st, nameKey(m.name), null); m.name = name; }');
    T('84 v447 ①-4 시험 계정 표식은 관리자만: 비관리자(안전 수행) 저장 = 403 ADMIN_ONLY·표식 없음 그대로 · 서버 검사(관리자·BAD_CORP)는 이름 색인 지우기보다 앞 · AUD_FIELDS에 네 칸',
      t84.code === 403 && t84.body.error_code === 'ADMIN_ONLY' && !('test_acct' in u84()) && iChk84 > 0 && iCorp84 > 0 && iName84 > 0 && iChk84 < iName84 && iCorp84 < iName84
      && /const AUD_FIELDS = \[[^\]]*'office','supervisor','corp','test_acct','quals'\]/.test(src84), JSON.stringify({ code: t84.code, ec: t84.body.error_code, iChk84, iCorp84, iName84 }));
    // ①-5 회원 목록 — 비관리자 투영에 네 칸은 요청자의 안전 권한이 숨김이 아닐 때만(안전 담당이 표를 그림 — v447 검토: 직무 구분도 최소 범위로), 날짜·인사정보(hire_date·birth·leave_date)는 여전히 없음
    //   안전 보기(ukv84) = 다른 회원 네 칸 · 안전 숨김(uo84 — 값 없음 = 기본 숨김)·안전 'hide' 명시(ukh84) = 다른 회원 네 칸 없음 · 본인은 종전대로 전체(uo84 office·corp)
    await callA84({ action: 'member_upsert', id: 'uw84', supervisor: true, test_acct: true }, tokAdm84);
    mem.gw_users['member:ukv84'] = { id: 'ukv84', name: '안전보기84', role: '직원', admin: false, perms: { safety: 'view' } };
    mem.gw_users['member:ukh84'] = { id: 'ukh84', name: '안전숨김84', role: '직원', admin: false, perms: { safety: 'hide', site: 'do' } };
    const ml84 = await callA84({ action: 'member_list' }, issueSession(mem.gw_users['member:ukv84']).token);
    const mlo84 = await callA84({ action: 'member_list' }, issueSession(mem.gw_users['member:uo84']).token);
    const mlh84 = await callA84({ action: 'member_list' }, issueSession(mem.gw_users['member:ukh84']).token);
    const w84 = (ml84.body.members || []).find((m) => m.id === 'uw84') || {}, wo84 = (mlo84.body.members || []).find((m) => m.id === 'uw84') || {}, wh84 = (mlh84.body.members || []).find((m) => m.id === 'uw84') || {};
    const o84 = (mlo84.body.members || []).find((m) => m.id === 'uo84') || {}, ov84 = (ml84.body.members || []).find((m) => m.id === 'uo84') || {};
    const four84 = (x) => ['office', 'supervisor', 'corp', 'test_acct'].filter((k) => k in x);
    T('84 v447 ①-5 회원 목록(비관리자): 안전 보기 = 다른 회원 office·supervisor·corp·test_acct 네 칸(값 그대로·없으면 없음) · 안전 숨김(값 없음·hide 명시) = 다른 회원 네 칸 키째 없음 · hire_date·birth·leave_date 없음 · 본인은 종전대로 전체',
      ml84.code === 200 && mlo84.code === 200 && mlh84.code === 200 && w84.supervisor === true && w84.test_acct === true && w84.office === undefined && w84.corp === undefined && ov84.office === true && ov84.corp === 'env'
      && !('hire_date' in w84) && !('birth' in w84) && !('leave_date' in w84) && four84(wo84).length === 0 && four84(wh84).length === 0 && wo84.name === '직원84' && wh84.retired === false
      && o84.office === true && o84.corp === 'env', JSON.stringify({ w84, wo84, wh84, o84 }));

    // ② col:edu 새 종류·회차 표식·숫자 시간 — 저장 그대로 · 409 · 병합은 앱 몫(서버는 base 낙관락)
    mem.gw_users['member:uw84'].perms = { safety: 'do' };
    const tokS84 = issueSession(mem.gw_users['member:uw84']).token;
    const NEW84 = ['hire', 'change', 'basic_con', 'gen_med', 'ra_join', 'ra_share', 'special_demo'].map((k, i) => ({ id: 'n84' + i, ptype: i % 2 ? 'worker' : 'member', pid: i % 2 ? 'w84a' : 'uw84', kind: k, date: '2026-11-0' + (i + 1), hours: i + 0.5, next: k === 'gen_med' ? '2027-11-03' : '', note: '메모' + i, created: '2026-11-12', updated: '2026-11-12' }));
    NEW84[4].ra = { on: '2026-10-30', type: 'regular', unit: '운영부' }; NEW84[5].ra = { on: '2026-10-31', type: 'adhoc', unit: '석면 #131' };
    mem.gw_data['col:edu'] = { schema: 1, items: [{ id: 'old84', ptype: 'member', pid: 'uw84', kind: 'regular', date: '2026-07-01', hours: '4시간', next: '', updated: '2026-07-01' }], updated_at: 8400 };
    const s84a = await call({ action: 'save', collection: 'edu', base: 8400, doc: { schema: 1, items: [mem.gw_data['col:edu'].items[0]].concat(NEW84) } }, tokS84, 'dev1');
    const got84 = (mem.gw_data['col:edu'].items || []);
    const ok84 = s84a.code === 200 && got84.length === 8 && NEW84.every((n) => { const g = got84.find((x) => x.id === n.id); return g && g.kind === n.kind && g.hours === n.hours && typeof g.hours === 'number' && JSON.stringify(g.ra || null) === JSON.stringify(n.ra || null); }) && got84[0].hours === '4시간';
    const s84b = await call({ action: 'save', collection: 'edu', base: 8400, doc: { schema: 1, items: [] } }, tokS84, 'dev1');
    T('84 v447 ② col:edu 새 종류 7개(hire·change·basic_con·gen_med·ra_join·ra_share·special_demo)·회차 표식 ra{on,type,unit}·숫자 시간 = 행 모양 그대로 200 저장(옛 줄 "4시간" 그대로) · 낡은 base로 빈 목록 저장 = 409 STALE_BASE·8줄 그대로',
      ok84 && s84b.code === 409 && s84b.body.error_code === 'STALE_BASE' && (mem.gw_data['col:edu'].items || []).length === 8, JSON.stringify({ a: s84a.code, b: s84b.code + '/' + s84b.body.error_code, n: got84.length }));

    // ③ site_edu_gap — 새 종류만 있는 기록·special + 새 종류·special_demo
    mem.gw_users['member:ukja84'] = { id: 'ukja84', name: '현장84', role: '직원', admin: false, perms: { site: 'do', wk: 'do' } };
    const tokK84 = issueSession(mem.gw_users['member:ukja84']).token;
    mem.gw_data['col:asbestos'] = { schema: 1, items: [{ id: 'a84', kind: 'asbestos', status: 'run', member_ids: ['uw84', 'uo84'], worker_ids: ['w84a', 'w84b'] }], updated_at: 8401 };
    mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w84a', name: '일용갑84' }, { id: 'w84b', name: '일용을84' }], updated_at: 8402 };
    const gap84 = async () => call({ action: 'site_edu_gap' }, tokK84, 'dev1');
    mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(NEW84)), updated_at: 8403 };
    const g0 = await gap84();
    const SP84 = [{ id: 'sp84', ptype: 'worker', pid: 'w84b', kind: 'special', date: '2026-10-01' }];
    mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(SP84)), updated_at: 8404 };
    const g1 = await gap84();
    mem.gw_data['col:edu'] = { schema: 1, items: JSON.parse(JSON.stringify(SP84.concat(NEW84))), updated_at: 8405 };
    const g2 = await gap84();
    mem.gw_data['col:edu'] = { schema: 1, items: [{ id: 'sd84', ptype: 'member', pid: 'uw84', kind: 'special_demo', date: '2026-10-02' }].concat(JSON.parse(JSON.stringify(SP84))), updated_at: 8406 };
    const g3 = await gap84();
    T('84 v447 ③ site_edu_gap이 새 종류 기록에 흔들리지 않음: 새 종류 7개만 = 200·has_edu false·이름 0(종전 has_edu는 종류 무관이라 투입 4명 전원 미이수) · special 1건 = 미이수 [직원84, 사무84, 일용갑84] · special + 새 종류 = 같은 이름(has_demo만 true — v454) · 석면 현장에서 special_demo는 이수 아님(직원84 그대로 미이수)',
      g0.code === 200 && g0.body.has_edu === false && g0.body.has_demo === true && JSON.stringify(g0.body.gaps) === '{"a84":[]}'
      && g1.code === 200 && g1.body.has_edu === true && JSON.stringify(g1.body.gaps) === JSON.stringify({ a84: ['직원84', '사무84', '일용갑84'] })
      && g2.code === 200 && g2.body.has_edu === true && JSON.stringify(g2.body.gaps) === JSON.stringify(g1.body.gaps) && g1.body.has_demo === false && g2.body.has_demo === true
      && g3.code === 200 && JSON.stringify(g3.body.gaps) === JSON.stringify({ a84: ['직원84', '사무84', '일용갑84'] }),
      JSON.stringify({ g0: g0.body, g1: g1.body.gaps, g2: g2.body.gaps, g3: g3.body.gaps }));
  } finally {
    mem.gw_users = savedUsers84;
    Object.keys(had84).forEach((k) => { if (had84[k] === undefined) delete mem.gw_data[k]; else mem.gw_data[k] = had84[k]; });
  }
}

{ // ---- 85(v453) 보안(보안 재감사 11/13 ②③⑧ · 원장 C093·C094) — backup_put 재해 복원 모드(관리자 세션·봇 키만으로는 gw_users·audit:*·settings:* 못 씀 · 회원 권한·신원 칸 지킴 ·
  //   감사 로그는 붙이기만) · 재해 복원 길은 열려 있음 · autotask_ingest 서버 스위치 판정 · 봇 키 상수시간 비교 · settings_apply(봇 키 설정 적용 — 허용 목록·값 검사·prev·감사 '설정적용').
  //   검사마다 결함을 심은 gw-data 사본(소스 한 곳을 바꿔 같은 mock으로 메모리에서 컴파일 — 파일은 쓰지 않음)에서는 실패해야 한다.
  const fs85 = require('fs'), Mod85 = require('module');
  const FILE85 = join(FN, 'gw-data.js'), SRC85 = fs85.readFileSync(FILE85, 'utf8');
  const load85 = (src) => { const m = new Mod85(FILE85); m.filename = FILE85; m.paths = Mod85._nodeModulePaths(FN); m._compile(src, FILE85); return m.exports; };
  const mutSrc85 = (from, to) => { if (SRC85.split(from).length !== 2) throw new Error('결함 자리가 한 곳이 아님: ' + from.slice(0, 60)); return SRC85.replace(from, () => to); };   // 같은 글이 다른 핸들러에도 있으면 엉뚱한 곳을 바꾸므로 한 곳만
  const mut85 = (from, to) => load85(mutSrc85(from, to));
  const caller85 = (mod) => async (body, tok, dev) => { const r = await mod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
  const c85 = caller85(gwd);
  const snap85 = JSON.stringify({ u: mem.gw_users, d: mem.gw_data });
  const reset85 = () => { const s = JSON.parse(snap85); mem.gw_users = s.u; mem.gw_data = s.d; };
  const M85 = { id: 'u85', name: '관리85', role: '관리자', rank: '대리', dept: '관리부', admin: true, tier: 'admin', perms: { tasks: 'do' }, uid: 'adm85', pin_salt: 's85', pin_hash: 'h85' };
  const tok85 = issueSession(M85).token;
  const KST85 = (n) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
  const LIVE85 = { schema: 1, rules: { site_missing: 'live', veh_insp90: 'live', wk_missing: 'live' }, updated_at: 5, updated_by: 'x' };
  const BK = 'test-ingest-key';
  try {
    // ① 관리자(비개발자) 자기 승격 — 관리자 세션으로 자기 회원 레코드에 dev·tier boss / 봇 키만(restore 표식 없음)으로 dev → 둘 다 403 RESTORE_MODE_ONLY · 레코드 그대로
    const chkA = async (c) => { reset85(); mem.gw_users['member:u85'] = JSON.parse(JSON.stringify(M85));
      const r1 = await c({ action: 'backup_put', store: 'gw_users', key: 'member:u85', data: Object.assign({}, M85, { dev: true, tier: 'boss' }), confirm: true }, tok85);
      const r2 = await c({ action: 'backup_put', secret: BK, store: 'gw_users', key: 'member:u85', data: Object.assign({}, M85, { dev: true }), confirm: true });
      const m = mem.gw_users['member:u85'];
      return { ok: r1.code === 403 && r1.body.error_code === 'RESTORE_MODE_ONLY' && r2.code === 403 && r2.body.error_code === 'RESTORE_MODE_ONLY' && !m.dev && m.tier === 'admin', info: [r1.code, r1.body.error_code, r2.code, r2.body.error_code, m.dev, m.tier] };
    };
    // ② 재해 복원 모드(봇 키 + restore + confirm)도 지금 회원 레코드의 권한·신원·접근 칸은 지금 값 — 나머지(직급·연번)만 백업본 · 감사 '재해복원'(바뀐 칸·지킨 칸 이름만, 값 없음)
    const chkB = async (c) => { reset85(); mem.gw_users['member:u85'] = JSON.parse(JSON.stringify(Object.assign({}, M85, { leave_date: '2026-10-31' })));
      const bk = { id: 'u85', name: '바뀐이름', role: '대표', rank: '과장', dept: '운영부', admin: true, dev: true, tier: 'boss', perms: { tasks: 'do', quote: 'do' }, uid: 'evil85', seq: 3 };
      const n0 = auditMock.logs.length;
      const r = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u85', data: bk, confirm: true });
      const m = mem.gw_users['member:u85'], a = auditMock.logs[n0], t = a ? a.ev[0].t : '';
      return { ok: r.code === 200 && r.body.restore === true && m.rank === '과장' && m.seq === 3 && !('dev' in m) && m.tier === 'admin' && m.name === '관리85' && m.role === '관리자' && m.dept === '관리부' && m.uid === 'adm85'
        && JSON.stringify(m.perms) === JSON.stringify({ tasks: 'do' }) && m.leave_date === '2026-10-31' && m.pin_hash === 'h85' && m.admin === true
        && !!a && a.ev[0].op === '재해복원' && /바뀐 칸 \[rank,seq\]/.test(t) && /지킨 칸 \[[^\]]*\bdev\b[^\]]*\]/.test(t) && /\btier\b/.test(t) && !/과장|evil85|boss|운영부/.test(t), info: { code: r.code, m, t } };
    };
    // ②-3(v453 검토) 지운 회원(del 1)·부분 레코드(이름·역할·부서 칸 빠짐) — 재해 복원으로 del 해제·빠진 신원 칸만 백업 값 · 권한 칸(admin·dev·tier·perms·PIN)·있는 신원 칸(uid)은 지금 값 · 감사 'del 해제'(값 없음)
    const chkB3 = async (c) => { reset85();
      mem.gw_users['member:u87'] = { id: 'u87', del: 1, uid: 'w87', pin_salt: 's87', pin_hash: 'h87', admin: false, perms: { tasks: 'view' } };
      const bk = { id: 'u87', name: '복원87', role: '직원', dept: '운영부', uid: 'other87', admin: true, dev: true, tier: 'boss', perms: { tasks: 'do' }, rank: '주임' };
      const n0 = auditMock.logs.length;
      const r = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u87', data: bk, confirm: true });
      const m = mem.gw_users['member:u87'] || {}, t = auditMock.logs[n0] ? auditMock.logs[n0].ev[0].t : '';
      return { ok: r.code === 200 && !('del' in m) && m.name === '복원87' && m.role === '직원' && m.dept === '운영부' && m.uid === 'w87' && m.admin === false && !('dev' in m) && !('tier' in m)
        && JSON.stringify(m.perms) === JSON.stringify({ tasks: 'view' }) && m.pin_hash === 'h87' && m.rank === '주임' && m.id === 'u87' && /del 해제/.test(t) && !/복원87|운영부|other87|boss/.test(t), info: { code: r.code, m, t } };
    };
    // ②-2 지금 레코드가 없는 회원 — PIN 없음·admin·dev false·id는 키 · v453 검토: tier도 걷음(admin을 뒤에 켤 때 아무도 지정 안 한 boss가 살아나지 않게) · perms는 백업 값(재해 복구) — 감사 note에 칸·값
    const chkB2 = async (c) => { reset85(); delete mem.gw_users['member:u86'];
      const n0 = auditMock.logs.length;
      const r = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u86', data: { id: 'zz', name: '복원86', admin: true, dev: true, tier: 'boss', perms: { quote: 'do', hr: 'view' }, pin_hash: 'x', pin_salt: 'y' }, confirm: true });
      const m = mem.gw_users['member:u86'], t = auditMock.logs[n0] ? auditMock.logs[n0].ev[0].t : '';
      return { ok: r.code === 200 && !!m && m.admin === false && m.dev === false && !m.pin_hash && !m.pin_salt && m.id === 'u86' && m.name === '복원86' && !('tier' in m)
        && JSON.stringify(m.perms) === JSON.stringify({ quote: 'do', hr: 'view' }) && /perms \[quote:do,hr:view\]/.test(t) && /tier 없음/.test(t) && !/복원86/.test(t), info: { code: r.code, m, t } };
    };
    // ⑬(v453 검토 medium) 재직 회원을 재해 복원으로 끄는 길 — 백업 del:1·지난 leave_date = 지금 값 그대로(del 없음·퇴사일 없음 · 감사 지킨 칸 del·leave_date) · 오늘 이후 퇴사일은 받음 ·
    //    결과 명부 유효 pm 0명이면 409 LAST_PM(부트스트랩 파생 pm만 있을 때 명시 tier 관리자를 되살리면 파생이 끝나 pm이 사라지는 경우 — gw-auth 회원 삭제·저장과 같은 판정)
    const chkB4 = async (c) => { reset85();
      mem.gw_users['member:u88'] = { id: 'u88', name: '재직88', admin: true, dev: true, tier: 'pm', perms: {}, pin_salt: 's88', pin_hash: 'h88' };
      const n0 = auditMock.logs.length;
      const r1 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u88', data: { id: 'u88', name: '재직88', del: 1, leave_date: KST85(-3), rank: '과장' }, confirm: true });
      const m1 = JSON.parse(JSON.stringify(mem.gw_users['member:u88'] || {})), t1 = auditMock.logs[n0] ? auditMock.logs[n0].ev[0].t : '';
      const r2 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u88', data: { id: 'u88', name: '재직88', leave_date: KST85(20) }, confirm: true });
      const m2 = mem.gw_users['member:u88'] || {};
      // 부트스트랩 사업장: 재직 관리자 p1(개발자·명시 tier 없음 = 파생 pm)뿐 · 지운 관리자 d1(명시 tier admin)을 백업(del 없음)으로 되살리면 파생이 끝나 pm 0 → 409
      mem.gw_users = { 'member:p1': { id: 'p1', name: '파생', admin: true, dev: true, perms: {} }, 'member:d1': { id: 'd1', name: '지운', admin: true, tier: 'admin', del: 1, perms: {} } };
      const before3 = JSON.stringify(mem.gw_users);
      const r3d = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:d1', data: { id: 'd1', name: '지운', admin: true, tier: 'admin', perms: {} }, dry: true });
      const r3 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:d1', data: { id: 'd1', name: '지운', admin: true, tier: 'admin', perms: {} }, confirm: true });
      const same3 = JSON.stringify(mem.gw_users) === before3;
      return { ok: r1.code === 200 && !('del' in m1) && !('leave_date' in m1) && m1.rank === '과장' && m1.dev === true && m1.tier === 'pm' && /지킨 칸 \[[^\]]*\bleave_date\b[^\]]*\]/.test(t1) && /지킨 칸 \[[^\]]*\bdel\b[^\]]*\]/.test(t1)
        && r2.code === 200 && m2.leave_date === KST85(20) && r3.code === 409 && r3.body.error_code === 'LAST_PM' && same3 && r3d.code === 200 && r3d.body.would_error === 'LAST_PM',
        info: { r1: r1.code, m1, t1, r2: r2.code, ld2: m2.leave_date, r3: [r3.code, r3.body.error_code], same3, r3d: r3d.body.would_error } };
    };
    // ③ 감사 로그(audit:YYYY-MM) — 관리자 세션·봇 키만으로 비우기 403(그대로) · 재해 복원 모드는 붙이기만(바꿔치기 줄은 새 줄로 더해지고 원래 줄 그대로 · 비운 백업으로도 안 줄어듦) · 미래 시각 400 · 월 상한 넘으면 400
    const AUD85 = { schema: 1, items: [{ ts: 1000, by: '갑', bid: 'u1', col: 'tasks', ev: [{ op: '수정', id: 't1', t: '원본' }] }, { ts: 2000, by: '을', bid: 'u2', col: 'tasks', ev: [{ op: '추가', id: 't2', t: 'x' }] }] };
    const chkC = async (c) => { reset85(); mem.gw_data['audit:2026-11'] = JSON.parse(JSON.stringify(AUD85));
      const r1 = await c({ action: 'backup_put', store: 'gw_data', key: 'audit:2026-11', data: { schema: 1, items: [] }, confirm: true }, tokA);
      const r2 = await c({ action: 'backup_put', secret: BK, store: 'gw_data', key: 'audit:2026-11', data: { schema: 1, items: [] }, confirm: true });
      const same12 = JSON.stringify(mem.gw_data['audit:2026-11']) === JSON.stringify(AUD85);
      const forged = { schema: 1, items: [{ ts: 1000, by: '갑', bid: 'u1', col: 'tasks', ev: [{ op: '수정', id: 't1', t: '바꿔치기' }] }, { ts: 500, by: '병', bid: 'u3', col: 'tasks', ev: [{ op: '추가', id: 't0', t: '옛 줄' }] }] };
      const r3 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-11', data: forged, confirm: true });
      const it = ((mem.gw_data['audit:2026-11'] || {}).items) || [];
      const r4 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-11', data: { schema: 1, items: [] }, confirm: true });
      const n4 = (((mem.gw_data['audit:2026-11'] || {}).items) || []).length;
      // v453 검토: 되살린 줄마다 서버가 restored 표식(지금 줄엔 없음) · 같은 백업을 다시 넣어도(지금 줄엔 restored가 붙어 있어도) 더 붙지 않음
      const rs = it.slice(0, 2).every((e) => Number.isFinite(e.restored) && e.restored > 0) && it.slice(2).every((e) => !('restored' in e));
      const r4b = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-11', data: forged, confirm: true });
      const n4b = (((mem.gw_data['audit:2026-11'] || {}).items) || []).length;
      const r5 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-11', data: { schema: 1, items: [{ ts: Date.now() + 86400000, by: 'x', ev: [] }] }, confirm: true });
      mem.gw_data['audit:2026-10'] = { schema: 1, items: Array.from({ length: 7999 }, (_, i) => ({ ts: 3000 + i, by: 'a', ev: [] })) };
      const r6 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-10', data: { schema: 1, items: [{ ts: 1, by: 'b', ev: [] }, { ts: 2, by: 'c', ev: [] }] }, confirm: true });
      const n6 = mem.gw_data['audit:2026-10'].items.length;
      return { ok: r1.code === 403 && r1.body.error_code === 'RESTORE_MODE_ONLY' && r2.code === 403 && r2.body.error_code === 'RESTORE_MODE_ONLY' && same12
        && r3.code === 200 && it.length === 4 && JSON.stringify(it.slice(2)) === JSON.stringify(AUD85.items) && it[0].ts === 500 && r3.body.preview.merge.added === 2
        && r4.code === 200 && n4 === 4 && r5.code === 400 && r5.body.error_code === 'AUDIT_FUTURE_TS' && r6.code === 400 && r6.body.error_code === 'AUDIT_FULL' && n6 === 7999
        && rs && r4b.code === 200 && r4b.body.preview.merge.added === 0 && n4b === 4,
        info: { r1: r1.code, r2: r2.code, same12, r3: r3.code, n3: it.length, n4, r5: r5.body.error_code, r6: r6.body.error_code, rs, r4b: [r4b.code, (r4b.body.preview || {}).merge], n4b } };
    };
    // ④ 민감 설정 키(settings:*) — 관리자 세션·봇 키만·관리자 세션 + restore 표식 = 403(그대로) · 미리보기(dry)는 건수만 되고 restore_only 표시
    const chkD = async (c) => { reset85(); delete mem.gw_data['settings:autotask']; const nf0 = JSON.stringify(mem.gw_data['settings:notify']);
      const r1 = await c({ action: 'backup_put', store: 'gw_data', key: 'settings:autotask', data: LIVE85, confirm: true }, tokA);
      const r2 = await c({ action: 'backup_put', secret: BK, store: 'gw_data', key: 'settings:autotask', data: LIVE85, confirm: true });
      const r3 = await c({ action: 'backup_put', store: 'gw_data', key: 'settings:notify', data: { schema: 1, events: { task_auto_create: 'assignee' } }, confirm: true, restore: true }, tokA);
      const r4 = await c({ action: 'backup_put', store: 'gw_data', key: 'settings:autotask', data: LIVE85, dry: true }, tokA);
      return { ok: [r1, r2, r3].every((x) => x.code === 403 && x.body.error_code === 'RESTORE_MODE_ONLY') && !mem.gw_data['settings:autotask'] && JSON.stringify(mem.gw_data['settings:notify']) === nf0
        && r4.code === 200 && r4.body.dry === true && r4.body.restore_only === true && r4.body.would_error === 'RESTORE_MODE_ONLY', info: [r1.code, r2.code, r3.code, r4.code, r4.body.restore_only, r4.body.would_error] };
    };
    // ⑤ 재해 복원 길은 통과 — 봇 키 + restore + confirm으로 settings:autotask·gw_users device 복원 200(감사 '재해복원') · restore 표식이 있어도 confirm 없으면 NEED_CONFIRM ·
    //    logsheet_daily(allbaro:xlsx — 봇 키 + confirm)·restore.py --selftest(restore:selftest) 길은 종전 그대로 200(감사 '백업복원')
    const chkE = async (c) => { reset85(); delete mem.gw_data['settings:autotask'];
      const n0 = auditMock.logs.length;
      const r0 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'settings:autotask', data: LIVE85 });
      const r1 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'settings:autotask', data: LIVE85, confirm: true });
      // v453 검토: 재해 복원은 스위치를 live로 올리지 않는다 — 지금(없음 = 기본 dry)보다 높은 백업 live는 dry로 써짐(나머지 칸 그대로) · 감사 '스위치 live 복원 안 함' · 지금 live인 규칙은 백업 live 그대로
      const st1 = JSON.stringify(mem.gw_data['settings:autotask'] || null) === JSON.stringify(Object.assign({}, LIVE85, { rules: { site_missing: 'dry', veh_insp90: 'dry', wk_missing: 'dry' } }));
      const t1 = (auditMock.logs.slice(n0).find((e) => e.ev[0].op === '재해복원' && e.ev[0].id === 'settings:autotask') || { ev: [{ t: '' }] }).ev[0].t;
      mem.gw_data['settings:autotask'] = { schema: 1, rules: { site_missing: 'live', veh_insp90: 'off', wk_missing: 'dry' }, updated_at: 7, updated_by: 'uadmin' };
      const r1b = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'settings:autotask', data: LIVE85, confirm: true });
      const st1b = JSON.stringify((mem.gw_data['settings:autotask'] || {}).rules) === JSON.stringify({ site_missing: 'live', veh_insp90: 'dry', wk_missing: 'dry' });
      const n0b = auditMock.logs.length;
      delete mem.gw_data['settings:autotask'];
      const r2 = await c({ action: 'backup_put', secret: BK, store: 'gw_data', key: 'allbaro:xlsx:2026-11-12', data: { b64: 'AAAA' }, confirm: true });
      const r3 = await c({ action: 'backup_put', secret: BK, store: 'gw_data', key: 'restore:selftest', data: { schema: 1, items: [{ id: 't1' }] }, confirm: true });
      const r4 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'device:d85', data: { status: 'approved' }, confirm: true });
      const ops = auditMock.logs.slice(n0b).map((e) => e.ev[0].op + ':' + e.ev[0].id);
      return { ok: r0.code === 400 && r0.body.error_code === 'NEED_CONFIRM' && r1.code === 200 && r1.body.restore === true && st1 && /스위치 live 복원 안 함 \[site_missing,veh_insp90,wk_missing\]/.test(t1)
        && r1b.code === 200 && st1b && r2.code === 200 && r3.code === 200 && r4.code === 200 && !!mem.gw_users['device:d85']
        && JSON.stringify(ops) === JSON.stringify(['백업복원:allbaro:xlsx:2026-11-12', '백업복원:restore:selftest', '재해복원:device:d85']), info: { r: [r0.code, r1.code, r1b.code, r2.code, r3.code, r4.code], st1, t1, st1b, ops } };
    };
    // ⑥ autotask_ingest 서버 스위치 — 스위치 없음(기본 dry) = 새 규칙 3건 키(site·wk·veh 만료 31일 이상) 막음·기존 4규칙(D-30 veh 30일·증명서)만 생성 · 감사 '스위치 막음' ·
    //    site live·veh off·wk dry = site만 · 전부 live = 나머지 생성
    const chkF = async (c) => { reset85(); delete mem.gw_data['settings:autotask']; mem.gw_data['col:tasks'] = { schema: 1, items: [] };
      const ym = KST85(0).slice(0, 7);
      const items = [{ auto_key: 'site:missing:' + ym, title: '현장' }, { auto_key: 'wk:missing:' + ym, title: '일용직' }, { auto_key: 'veh:v85:insp:' + KST85(60), title: 'D-90' },
        { auto_key: 'veh:v87:insp:' + KST85(31), title: 'D-90 경계' }, { auto_key: 'veh:v88:insp:' + KST85(30), title: 'D-30 경계' }, { auto_key: 'veh:v86:insp:' + KST85(10), title: 'D-30' }, { auto_key: 'cert:c85', title: '증명서' }];
      const keys = () => mem.gw_data['col:tasks'].items.map((t) => t.auto_key.split(':').slice(0, 2).join(':')).sort().join(',');
      const n0 = auditMock.logs.length;
      const r1 = await c({ action: 'autotask_ingest', key: BK, items }); const k1 = keys();
      const a1 = auditMock.logs.slice(n0).filter((e) => e.col === 'tasks' && e.ev[0].op === '정기업무').map((e) => e.ev[0].t).join(' | ');
      mem.gw_data['settings:autotask'] = { schema: 1, rules: { site_missing: 'live', veh_insp90: 'off', wk_missing: 'dry' }, updated_at: 9, updated_by: 'uadmin' };
      const r2 = await c({ action: 'autotask_ingest', key: BK, items }); const k2 = keys();
      mem.gw_data['settings:autotask'] = JSON.parse(JSON.stringify(LIVE85));
      const r3 = await c({ action: 'autotask_ingest', key: BK, items }); const k3 = keys();
      return { ok: r1.code === 200 && r1.body.made === 3 && r1.body.blocked === 4 && k1 === 'cert:c85,veh:v86,veh:v88' && JSON.stringify(r1.body.blocked_rules) === JSON.stringify({ site_missing: 1, wk_missing: 1, veh_insp90: 2 })
        && /스위치 막음 4/.test(a1) && !/v85|v87|missing:/.test(a1)
        && r2.body.made === 1 && r2.body.blocked === 3 && /site:missing/.test(k2) && !/wk:missing/.test(k2)
        && r3.body.made === 3 && r3.body.blocked === 0 && k3 === 'cert:c85,site:missing,veh:v85,veh:v86,veh:v87,veh:v88,wk:missing', info: { r1: r1.body, k1, a1, r2: [r2.body.made, r2.body.blocked], k3 } };
    };
    // ⑦ 봇 키 비교 — 길이 다른 키·같은 길이 다른 키·빈 키 = 403(ingest·backup_put·settings_apply) · 소스: process.env.BIDS_INGEST_KEY는 botKeyOk 한 곳 · '=== secret'/'!== secret' 0 · ingest가 botKeyOk
    const chkG = async (c) => {
      const rs = [await c({ action: 'autotask_ingest', key: BK + 'x', items: [] }), await c({ action: 'autotask_ingest', key: 'test-ingest-kez', items: [] }), await c({ action: 'autotask_ingest', key: '', items: [] }),
        await c({ action: 'backup_put', secret: BK + 'x', store: 'gw_data', key: 'rt', data: { a: 1 }, confirm: true }), await c({ action: 'settings_apply', key: 'x', target: 'doneif', mark: 'r1-x85', changes: { on: true } })];
      return { ok: rs.every((x) => x.code === 403), info: rs.map((x) => x.code) };
    };
    const stat85 = (src) => { const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      const ing = (code.match(/async function handleAutotaskIngest\(event, d, R\) \{[\s\S]*?\n\}\n/) || [''])[0];
      return (code.match(/process\.env\.BIDS_INGEST_KEY/g) || []).length === 1 && /function botKeyOk\(given\) \{ return keyMatch\(given, /.test(code) && !/[!=]== secret\b/.test(code) && /^\s*if \(!botKeyOk\(d\.key\)\) return jr\(403/m.test(ing); };
    // ⑧ settings_apply — 키 403 · 허용 목록 밖(autotask) 400 BAD_TARGET · 표식·값·같은 값·낡은 base · dry는 쓰지 않음 · notify 두 칸 적용(나머지 칸 그대로 · prev = 직전 판 · updated_by bot:표식 · 감사 '설정적용' 1줄) ·
    //    앱 카드 [되돌리기](notify_revert)로 그대로 돌아감 · assign(접두어·승인권자·명부 밖 400·모르는 접두어 400) · doneif(on boolean)
    const chkH = async (c) => { reset85();
      mem.gw_data['settings:notify'] = { schema: 1, events: { task_auto_create: 'assignee', task_review: 'admins', due_digest: 'each', bid_result: 'award' }, prev: null, updated_at: 1000, updated_by: 'pm-r1-20261104' };
      delete mem.gw_data['settings:doneif']; delete mem.gw_data['settings:assign']; delete mem.gw_data['settings:autotask'];
      const ap = (o) => c(Object.assign({ action: 'settings_apply', key: BK, target: 'notify', mark: 'r1-test85' }, o));
      const r0 = await ap({ key: 'wrong', changes: { task_review: 'issuer_approver' } });
      const r1 = await ap({ target: 'autotask', changes: { veh_insp90: 'live' } });
      const r1b = await ap({ target: 'settings:notify', changes: { task_review: 'issuer_approver' } });
      const r2 = await ap({ mark: 'R1 테스트', changes: { task_review: 'issuer_approver' } });
      const r3 = await ap({ changes: { task_review: 'nope' } });
      const r4 = await ap({ changes: { task_auto_create: 'assignee' } });
      const r5 = await ap({ base: 999, changes: { task_review: 'issuer_approver' } });
      const r6 = await ap({ dry: true, changes: { task_review: 'issuer_approver' } });
      // v453 검토: dry는 true·false·없음만(1·'true' = 400 BAD_DRY) · 쓰기는 confirm:true 따로(없으면 400 NEED_CONFIRM) — 셋 다 쓰지 않음
      const r14 = await ap({ dry: 1, changes: { task_review: 'issuer_approver' } });
      const r15 = await ap({ dry: 'true', changes: { task_review: 'issuer_approver' } });
      const r16 = await ap({ changes: { task_review: 'issuer_approver' } });
      const dryKept = mem.gw_data['settings:notify'].updated_at === 1000 && mem.gw_data['settings:notify'].events.task_review === 'admins';
      const nA = auditMock.logs.length;
      const r7 = await ap({ base: 1000, ref: 'C025', confirm: true, changes: { task_review: 'issuer_approver', due_digest: 'summary' } });
      const nf = JSON.parse(JSON.stringify(mem.gw_data['settings:notify'])), a7 = auditMock.logs.slice(nA);
      const r8 = await c({ action: 'notify_revert', base: nf.updated_at }, tokA);
      const nf8 = mem.gw_data['settings:notify'];
      const r9 = await ap({ target: 'assign', confirm: true, base: 0, changes: { 'veh:': 'uwork', approver_id: 'uadmin' } });
      const as9 = mem.gw_data['settings:assign'] || {};
      const r10 = await ap({ target: 'assign', changes: { 'veh:': 'ughost' } });
      const r11 = await ap({ target: 'assign', changes: { 'xx:': 'uwork' } });
      const r12 = await ap({ target: 'doneif', confirm: true, base: 0, changes: { on: true } });
      const dn = mem.gw_data['settings:doneif'] || {};
      const r13 = await ap({ target: 'doneif', changes: { on: 'yes' } });
      // v453 검토: 쓰기에 base 없음 = 400 NEED_BASE(안 씀) · 대상 키 읽기 실패·깨진 값 = 503 SETTINGS_READ_FAILED(기본값 위에 얹어 쓰지 않음 — 다른 칸·prev 그대로)
      const nfH = JSON.stringify(mem.gw_data['settings:notify']);
      const r17 = await ap({ confirm: true, changes: { bid_fail: 'assignee' } });
      let r18, r19, r20;
      try {
        blobsMock.hooks.failGet = (k) => k === 'settings:notify';
        r18 = await ap({ confirm: true, base: 0, changes: { bid_fail: 'assignee' } });
        blobsMock.hooks.failGet = (k) => (k === 'settings:notify' ? 'STORAGE_PARSE_FAILED' : false);
        r19 = await ap({ dry: true, changes: { bid_fail: 'assignee' } });
        blobsMock.hooks.failGet = (k) => k === 'settings:doneif';
        r20 = await ap({ target: 'doneif', confirm: true, base: dn.updated_at, changes: { on: false } });
      } finally { delete blobsMock.hooks.failGet; }
      const keptH = JSON.stringify(mem.gw_data['settings:notify']) === nfH && (mem.gw_data['settings:doneif'] || {}).on === true;
      const errs = [r0, r1, r1b, r2, r3, r4, r5, r10, r11, r13, r14, r15, r16, r17, r18, r19, r20].map((x) => x.code + ':' + x.body.error_code).join(',');
      return { ok: errs === '403:BAD_INGEST_KEY,400:BAD_TARGET,400:BAD_TARGET,400:BAD_MARK,400:BAD_EVENT,400:NO_CHANGE,409:SETTINGS_STALE,400:BAD_MEMBER,400:BAD_PREFIX,400:BAD_VALUE,400:BAD_DRY,400:BAD_DRY,400:NEED_CONFIRM,400:NEED_BASE,503:SETTINGS_READ_FAILED,503:SETTINGS_READ_FAILED,503:SETTINGS_READ_FAILED' && keptH
        && r6.code === 200 && r6.body.dry === true && r6.body.changes.length === 1 && dryKept
        && r7.code === 200 && r7.body.audit === true && nf.events.task_review === 'issuer_approver' && nf.events.due_digest === 'summary' && nf.events.task_auto_create === 'assignee' && nf.events.bid_result === 'award'
        && nf.prev.updated_by === 'pm-r1-20261104' && nf.prev.updated_at === 1000 && nf.prev.events.task_review === 'admins' && nf.updated_by === 'bot:r1-test85' && nf.applied_via === 'settings_apply' && nf.updated_at > 1000
        && a7.length === 1 && a7[0].by === '설정봇(r1-test85)' && a7[0].bid === 'bot' && a7[0].ev.length === 2 && a7[0].ev.every((e) => e.op === '설정적용' && /^notify:/.test(e.id) && /r1-test85 · C025$/.test(e.t))
        && r8.code === 200 && nf8.events.task_review === 'admins' && nf8.events.due_digest === 'each' && nf8.events.task_auto_create === 'assignee'
        && r9.code === 200 && as9.rules && as9.rules['veh:'] && as9.rules['veh:'].who_id === 'uwork' && as9.approver_id === 'uadmin' && as9.updated_by === 'bot:r1-test85' && as9.prev && as9.prev.updated_at === 0
        && r12.code === 200 && dn.on === true && dn.prev && dn.prev.on === false && dn.updated_by === 'bot:r1-test85' && !mem.gw_data['settings:autotask'],
        info: { errs, r6: r6.body, r7: r7.body.error_code, nf, a7: a7.map((e) => [e.by, e.ev.length]), r8: r8.code, r9: r9.code, r12: r12.code } };
    };

    // ⑨(v453 검토 high) 키 이름 — @netlify/blobs 8.2.0은 키를 URL 경로에 날글자로 붙여 new URL이 접는다(아래 fold로 확인). 관리자 세션 backup_put·봇 backup_get에 접히는 키 = 400 BAD_KEY · 운영 값 그대로 ·
    //    민감값(push:keys 개인키·PIN 해시)이 응답에 없음 · 바른 키 backup_get은 그대로 200
    const BADK = ['x/../settings:autotask', '../site:gw_users/member:u85', '\naudit:2026-11', 'x/../push:keys', 'x\\..\\settings:notify', 'settings:autotask ', '%2e%2e/settings:autotask',
      'x%2F..%2Fsettings:autotask', 'set\ttings:autotask', '..'];
    const chkK = async (c) => { reset85(); mem.gw_users['member:u85'] = JSON.parse(JSON.stringify(M85)); delete mem.gw_data['settings:autotask'];
      mem.gw_data['push:keys'] = { publicKey: 'PUB85', privateKey: 'PRIV85SECRET' }; mem.gw_data['audit:2026-11'] = JSON.parse(JSON.stringify(AUD85));
      const before = JSON.stringify({ u: mem.gw_users, d: mem.gw_data });
      const puts = [];
      for (const k of BADK) puts.push(await c({ action: 'backup_put', store: 'gw_data', key: k, data: /member/.test(k) ? Object.assign({}, M85, { dev: true, tier: 'boss' }) : (/audit/.test(k) ? { schema: 1, items: [] } : LIVE85), confirm: true }, tok85));
      const gets = [];
      for (const k of ['x/../push:keys', '../site:gw_users/member:u85', '\npush:keys', 'push:keys ']) gets.push(await c({ action: 'backup_get', secret: BK, store: 'gw_data', key: k }));
      const good = await c({ action: 'backup_get', secret: BK, store: 'gw_data', key: 'audit:2026-11' });
      const leak = JSON.stringify(gets.concat(puts).map((x) => x.body)).match(/PRIV85SECRET|h85/g);
      return { ok: puts.every((x) => x.code === 400 && x.body.error_code === 'BAD_KEY') && gets.every((x) => x.code === 400 && x.body.error_code === 'BAD_KEY') && !leak
        && JSON.stringify({ u: mem.gw_users, d: mem.gw_data }) === before && good.code === 200 && good.body.data.items.length === 2,
        info: { puts: puts.map((x) => x.code + ':' + x.body.error_code), gets: gets.map((x) => x.code + ':' + x.body.error_code), leak, good: good.code } };
    };
    // ⑨-2 저장소 층 — 실 _lib/blobs.js(실 @netlify/blobs 모듈, 가짜 store 객체)가 접히는 키를 SDK(store.get·set·delete)에 넘기지 않음(STORAGE_BAD_KEY) · 바른 키는 넘김 ·
    //      _lib/blobkey.js가 BADK 전부 거부·실제 쓰는 키 꼴(한글 이름·번호판 id·cdoc·allbaro:xlsx) 통과 · servertest mock도 같은 함수로 거부(mem에 안 써짐) · new URL이 정말 접는지(위협 확인)
    const fs85b = require('fs');
    const loadAt85 = (file, src) => { const m = new Mod85(file); m.filename = file; m.paths = Mod85._nodeModulePaths(dirname(file)); m._compile(src, file); return m.exports; };
    const BLF = join(FN, '_lib', 'blobs.js'), BLSRC = fs85b.readFileSync(BLF, 'utf8'), BKF = join(FN, '_lib', 'blobkey.js'), BKSRC = fs85b.readFileSync(BKF, 'utf8');
    const GOODK = ['settings:autotask', 'member:u85', 'name:홍길동', 'veh:v경북12가3456:insp:2026-12-01', 'cdoc:c1:S01:gen.x:1', 'allbaro:xlsx:2026-11-12', 'audit:2026-11', 'x..y'];
    const chkL = async (lib, keyFn) => { const calls = [];
      const st = { async get(k) { calls.push('g:' + k); return null; }, async set(k) { calls.push('s:' + k); }, async delete(k) { calls.push('d:' + k); } };
      const res = [];
      for (const k of BADK) res.push(await lib.blobGet(st, k), await lib.blobSet(st, k, { a: 1 }), await lib.blobDelete(st, k));
      const g1 = await lib.blobSet(st, 'settings:autotask', { a: 1 }), g2 = await lib.blobGet(st, 'member:u85'), g3 = await lib.blobDelete(st, 'tmp:85');
      const kf = BADK.every((k) => keyFn(k) === true) && GOODK.every((k) => keyFn(k) === false);
      const mk0 = Object.keys(mem.gw_data).length, mw = await blobsMock.blobSet('gw_data', 'x/../settings:autotask', LIVE85), mg = await blobsMock.blobGet('gw_data', '\naudit:2026-11');
      const mockOk = mw.ok === false && mw.code === 'STORAGE_BAD_KEY' && mg.ok === false && Object.keys(mem.gw_data).length === mk0;
      const fold = (k) => new URL('/region:us/SITE/site:gw_data/' + k, 'https://edge.test').pathname;
      const folds = fold('x/../settings:autotask') === '/region:us/SITE/site:gw_data/settings:autotask' && fold('../site:gw_users/member:u85') === '/region:us/SITE/site:gw_users/member:u85'
        && fold('\naudit:2026-11') === '/region:us/SITE/site:gw_data/audit:2026-11' && fold('x\\..\\settings:notify') === '/region:us/SITE/site:gw_data/settings:notify';
      return { ok: res.every((r) => r.ok === false && r.code === 'STORAGE_BAD_KEY') && JSON.stringify(calls) === JSON.stringify(['s:settings:autotask', 'g:member:u85', 'd:tmp:85']) && g1.ok && g2.ok && g3.ok && kf && mockOk && folds,
        info: { calls: calls.length, kf, mockOk, folds } };
    };
    const realBlobs85 = loadAt85(BLF, BLSRC), realKey85 = loadAt85(BKF, BKSRC).badBlobKey;
    // ⑩(v453 검토 medium) 열람 기록 doclog:*·reclog:*(감사로그와 같은 방식)·계약 편집 기록 clog:contract·clog:contract:YYYY-MM(해시 체인)도 재해 복원 모드로만 — 관리자 세션·봇 키만 = 403(그대로) ·
    //    doclog 재해 복원 = 붙이기만(restored 표식) · clog = 지금 체인 뒤를 잇는 백업은 그 뒤 줄만(짧음·같음 CLOG_NOT_AHEAD · 백업 체인 깨짐 CLOG_CHAIN_BAD · 없음이면 받음) ·
    //    2차 검토: 갈라짐·손실 뒤 새 체인·깨진 지금 체인 = 다시 잇기(지금 줄 버림 0 · rechained · restored 범위) · clog:appr:*도 이 갈래(잘린 체인 시작 p 허용)
    const crypto85 = require('crypto');
    const chain85 = (es) => { let head = ''; const items = es.map((e) => { const h = crypto85.createHash('sha256').update(head + '|' + JSON.stringify(e)).digest('hex').slice(0, 16); const it = Object.assign({ h: h, p: head }, e); head = h; return it; }); return { schema: 1, items: items, head: head }; };
    const chainOk85 = (doc) => { let prev = ''; for (const it of ((doc && doc.items) || [])) { const e = Object.assign({}, it); delete e.h; delete e.p; if (it.p !== prev || crypto85.createHash('sha256').update(prev + '|' + JSON.stringify(e)).digest('hex').slice(0, 16) !== it.h) return false; prev = it.h; } return prev === ((doc && doc.head) || ''); };   // 첫 줄 p '' 엄격(conClogChainOk와 같은 식 — 독립 구현)
    const E85 = [1, 2, 3, 4].map((i) => ({ ts: 1000 + i, by: 'u' + i, op: 'stage_docs', cid: 'c1', pipe: 'p', i: i, k: 'k' + i, act: 'done' }));
    const chkJ = async (c) => { reset85();
      const DL = { schema: 1, items: [{ ts: 10, bid: 'u1', by: '갑', id: 'd1' }] }, RL = { schema: 1, items: [{ ts: 11, bid: 'u2', cid: 'c1' }] };
      mem.gw_data['doclog:2026-11'] = JSON.parse(JSON.stringify(DL)); mem.gw_data['reclog:2026-11'] = JSON.parse(JSON.stringify(RL));
      const C2 = chain85(E85.slice(0, 2)); mem.gw_data['clog:contract:2026-11'] = JSON.parse(JSON.stringify(C2)); mem.gw_data['clog:contract'] = JSON.parse(JSON.stringify(C2));
      const before = JSON.stringify(mem.gw_data);
      const deny = [];
      for (const k of ['doclog:2026-11', 'reclog:2026-11', 'clog:contract', 'clog:contract:2026-11']) {
        deny.push(await c({ action: 'backup_put', store: 'gw_data', key: k, data: { schema: 1, items: [] }, confirm: true }, tokA));
        deny.push(await c({ action: 'backup_put', secret: BK, store: 'gw_data', key: k, data: { schema: 1, items: [] }, confirm: true }));
      }
      const same = JSON.stringify(mem.gw_data) === before;
      const rd = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'doclog:2026-11', data: { schema: 1, items: [{ ts: 10, bid: 'u1', by: '갑', id: 'd1' }, { ts: 12, bid: 'u3', by: '병', id: 'd2' }] }, confirm: true });
      const dl = mem.gw_data['doclog:2026-11'].items;
      const ok3 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-11', data: chain85(E85.slice(0, 3)), confirm: true });
      const c3 = JSON.stringify(mem.gw_data['clog:contract:2026-11'].items) === JSON.stringify(chain85(E85.slice(0, 3)).items) && mem.gw_data['clog:contract:2026-11'].head === chain85(E85.slice(0, 3)).head;
      const after3 = JSON.stringify(mem.gw_data['clog:contract:2026-11']);
      const short = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-11', data: chain85(E85.slice(0, 2)), confirm: true });
      const same3b = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-11', data: chain85(E85.slice(0, 3)), confirm: true });
      const tam = chain85(E85); tam.items[1].k = 'tampered';
      const bad = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-11', data: tam, confirm: true });
      const kept3 = JSON.stringify(mem.gw_data['clog:contract:2026-11']) === after3;
      delete mem.gw_data['clog:contract:2026-10'];
      const fresh = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-10', data: chain85(E85.slice(0, 1)), confirm: true });
      // v453 검토 medium: 갈라진 백업 — 거절(종전 CLOG_DIVERGED)이 아니라 다시 잇기: 백업 4줄 뒤에 백업에 없는 지금 줄(E1)만 rechained 표식으로 · 체인 온전 · 지금 줄 버림 0 · dry 미리보기도 같은 판정(쓰지 않음)
      const divBk = chain85([E85[0], Object.assign({}, E85[1], { k: 'zz' }), E85[2], E85[3]]);
      const divDry = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-11', data: divBk, dry: true });
      const dryKept = JSON.stringify(mem.gw_data['clog:contract:2026-11']) === after3;
      const nA = auditMock.logs.length;
      const div = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-11', data: divBk, confirm: true });
      const dv = mem.gw_data['clog:contract:2026-11'] || {}, dvi = dv.items || [];
      const strip = (e) => { const o = Object.assign({}, e); delete o.h; delete o.p; delete o.rechained; return JSON.stringify(o); };
      const tDiv = (auditMock.logs.slice(nA).find((e) => e.ev[0].op === '재해복원') || { ev: [{ t: '' }] }).ev[0].t;
      const divOk = div.code === 200 && dvi.length === 5 && JSON.stringify(dvi.slice(0, 4)) === JSON.stringify(divBk.items) && strip(dvi[4]) === strip(E85[1]) && Number.isFinite(dvi[4].rechained)
        && dvi.slice(0, 4).every((e) => !('rechained' in e)) && chainOk85(dv) && Array.isArray(dv.restored) && dv.restored[dv.restored.length - 1].from === chain85(E85.slice(0, 3)).head && dv.restored[dv.restored.length - 1].to === dv.head
        && dv.restored[dv.restored.length - 1].rechained === 1 && tDiv.indexOf(chain85(E85.slice(0, 3)).head) >= 0 && tDiv.indexOf(dv.head) >= 0 && /다시 이음 1줄/.test(tDiv)
        && divDry.code === 200 && divDry.body.would_error === '' && divDry.body.preview.merge.rechained === 1 && divDry.body.preview.merge.mode === 'diverged' && dryKept;
      // 손실 뒤: 키를 잃은 뒤 앱이 ''부터 새 줄 2(그중 하나는 앞 줄을 되돌리는 revert — of = 앞 줄 h)를 쌓음 + 백업 27줄 → 29줄·체인 OK · 새 줄 2는 rechained · revert의 of는 새 h로 고쳐짐 ·
      //   restored 범위는 다음 앱 기록 쓰기(con_clog_add)에도 남음 · 깨진 지금 체인(줄 하나 변조)도 읽히는 줄은 다시 이음
      const ym = KST85(0).slice(0, 7), LK = 'clog:contract:' + ym;
      const B27 = chain85(Array.from({ length: 27 }, (_, i) => ({ ts: 2000 + i, by: 'u1', op: 'stage_docs', cid: 'c9', pipe: 'p', i: i % 90, k: 'b' + i, act: 'done' })));
      const N1 = { ts: 9001, by: 'u2', op: 'docs_set', key: 'x', value: 'v' }, N0 = chain85([N1]), N2 = { ts: 9002, by: 'u2', op: 'revert', of: N0.items[0].h };
      mem.gw_data[LK] = chain85([N1, N2]);
      const loss = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: LK, data: B27, confirm: true });
      const lv = mem.gw_data[LK] || {}, lvi = lv.items || [];
      const lossOk = loss.code === 200 && lvi.length === 29 && chainOk85(lv) && JSON.stringify(lvi.slice(0, 27)) === JSON.stringify(B27.items) && Number.isFinite(lvi[27].rechained) && Number.isFinite(lvi[28].rechained)
        && lvi[27].op === 'docs_set' && lvi[28].op === 'revert' && lvi[28].of === lvi[27].h && lvi[27].h !== N0.items[0].h;
      const add = await c({ action: 'con_clog_add', cid: 'c9', pipe: 'p', i: 1, k: 'kk', act: 'done' }, tokA);
      const la = mem.gw_data[LK] || {};
      const keepR = add.code === 200 && (la.items || []).length === 30 && Array.isArray(la.restored) && la.restored.length === 1 && la.restored[0].rechained === 2 && chainOk85(la);
      const bro = chain85([N1, Object.assign({}, N2, { of: 'zz' })]); bro.items[0].value = 'tampered';   // 줄 0 변조 = 지금 체인 깨짐
      mem.gw_data['clog:contract:2026-05'] = bro;
      const brk = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-05', data: chain85(E85.slice(0, 2)), confirm: true });
      const bv = (mem.gw_data['clog:contract:2026-05'] || {}).items || [];
      const brkOk = brk.code === 200 && bv.length === 4 && chainOk85(mem.gw_data['clog:contract:2026-05']) && bv[2].value === 'tampered' && Number.isFinite(bv[3].rechained) && brk.body.preview.merge.mode === 'broken';
      // clog:appr:YYYY-MM(결재 학습 신호 — DONEIF.clogAppend, 상한에서 앞이 잘려 첫 줄 p가 ''가 아님)도 기록 키 — 관리자 세션 = 403 · 재해 복원 = 잘린 백업 체인 받음 · 뒤를 잇는 백업은 그 줄만
      const A6 = chain85(Array.from({ length: 6 }, (_, i) => ({ ts: 3000 + i, id: 't' + i, f: 'status', from: 'open', to: 'review', why: 'data:x', by: '앱 기준' })));
      const cut = (n0, n1) => ({ schema: 1, items: A6.items.slice(n0, n1), head: A6.items[n1 - 1].h });
      mem.gw_data['clog:appr:2026-11'] = cut(2, 4);
      const ap0 = JSON.stringify(mem.gw_data['clog:appr:2026-11']);
      const apDeny = await c({ action: 'backup_put', store: 'gw_data', key: 'clog:appr:2026-11', data: { schema: 1, items: [] }, confirm: true }, tokA);
      const apSame = JSON.stringify(mem.gw_data['clog:appr:2026-11']) === ap0;
      const apExt = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:appr:2026-11', data: cut(1, 6), confirm: true });
      const apv = mem.gw_data['clog:appr:2026-11'] || {};
      const apOk = apDeny.code === 403 && apDeny.body.error_code === 'RESTORE_MODE_ONLY' && apSame && apExt.code === 200 && (apv.items || []).length === 4 && apv.head === A6.head && apExt.body.preview.merge.mode === 'extend';
      return { ok: deny.every((x) => x.code === 403 && x.body.error_code === 'RESTORE_MODE_ONLY') && same
        && rd.code === 200 && dl.length === 2 && !('restored' in dl[0]) && dl[1].id === 'd2' && Number.isFinite(dl[1].restored)
        && ok3.code === 200 && c3 && short.code === 400 && short.body.error_code === 'CLOG_NOT_AHEAD' && same3b.code === 400 && same3b.body.error_code === 'CLOG_NOT_AHEAD'
        && bad.code === 400 && bad.body.error_code === 'CLOG_CHAIN_BAD' && kept3 && fresh.code === 200 && (mem.gw_data['clog:contract:2026-10'] || {}).items.length === 1
        && divOk && lossOk && keepR && brkOk && apOk,
        info: { deny: deny.map((x) => x.code), same, rd: rd.code, dl: dl.length, ok3: [ok3.code, ok3.body.error_code], c3, short: short.body.error_code, same3b: same3b.body.error_code, bad: bad.body.error_code, kept3, fresh: [fresh.code, fresh.body.error_code],
          divOk, div: [div.code, div.body.error_code, dvi.length], divDry: divDry.body.would_error, lossOk, loss: [loss.code, loss.body.error_code, lvi.length], keepR, add: add.code, brkOk, brk: [brk.code, brk.body.error_code, bv.length], apOk, ap: [apDeny.code, apExt.code, apExt.body.error_code, (apv.items || []).length] } };
    };
    // ⑪(v453 검토 low) 감사 로그 병합 마무리 — 되살린 줄과 지금 줄을 ts로 안정 정렬 · 이번 달 키(auditKey())는 뒤이을 '재해복원' 1줄 자리를 남김(7999 + 1 = 400 · 지난달 키 7999 + 1 = 8000 받음) ·
    //    월 상한은 _lib/audit.js MAX_PER_MONTH(실 파일 값 8000 · gw-data에 8000 글자 0) · 지금 감사 키 읽기 실패면 500·그대로(빈 것으로 보고 백업만 쓰지 않음)
    const chkC2 = async (c) => { reset85();
      mem.gw_data['audit:2026-07'] = { schema: 1, items: [{ ts: 1000, by: 'a', ev: [] }, { ts: 3000, by: 'c', ev: [] }] };
      const r1 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-07', data: { schema: 1, items: [{ ts: 2000, by: 'b', ev: [] }] }, confirm: true });
      const order = mem.gw_data['audit:2026-07'].items.map((e) => e.by).join('');
      auditMock.curKey = 'audit:2026-12';
      mem.gw_data['audit:2026-12'] = { schema: 1, items: Array.from({ length: 7999 }, (_, i) => ({ ts: 5000 + i, by: 'a', ev: [] })) };
      mem.gw_data['audit:2026-09'] = { schema: 1, items: Array.from({ length: 7999 }, (_, i) => ({ ts: 5000 + i, by: 'a', ev: [] })) };
      const r2 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-12', data: { schema: 1, items: [{ ts: 1, by: 'z', ev: [] }] }, confirm: true });
      const r3 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-09', data: { schema: 1, items: [{ ts: 1, by: 'z', ev: [] }] }, confirm: true });
      const n2 = mem.gw_data['audit:2026-12'].items.length, n3 = mem.gw_data['audit:2026-09'].items.length;
      auditMock.curKey = '';
      mem.gw_data['audit:2026-08'] = JSON.parse(JSON.stringify(AUD85));
      blobsMock.hooks.failGet = (k) => k === 'audit:2026-08';
      let r4;
      try { r4 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-08', data: { schema: 1, items: [{ ts: 1, by: 'z', ev: [] }] }, confirm: true }); } finally { delete blobsMock.hooks.failGet; }
      const kept4 = JSON.stringify(mem.gw_data['audit:2026-08']) === JSON.stringify(AUD85);
      const auSrc = fs85b.readFileSync(join(FN, '_lib', 'audit.js'), 'utf8');
      const bkCode = (SRC85.match(/\nfunction backupLogMax[\s\S]*?\nasync function handleBackupPut[\s\S]*?\n\}\n/) || [''])[0];
      const st = /const MAX_PER_MONTH = 8000;/.test(auSrc) && /module\.exports = \{[^}]*\bMAX_PER_MONTH\b[^}]*\}/.test(auSrc) && bkCode.length > 0 && !/8000/.test(bkCode) && /AUDIT_MAX_PER_MONTH/.test(bkCode);
      return { ok: r1.code === 200 && order === 'abc' && r2.code === 400 && r2.body.error_code === 'AUDIT_FULL' && n2 === 7999 && r3.code === 200 && n3 === 8000 && r4.code === 500 && kept4 && st,
        info: { r1: r1.code, order, r2: [r2.code, r2.body.error_code], n2, r3: r3.code, n3, r4: r4.code, kept4, st } };
    };
    // ⑫(v453 검토 low) autotask_ingest 키 꼴 허용 목록 — 스위치 전부 live에서도 7꼴(veh insp·ins·lic exp·edu·rec over45·cert·site·wk missing — 한글 번호판 id 포함) 밖은 만들지 않고 blocked_rules.unknown ·
    //    꼴만 살짝 바꾼 키(site:missing-·wk:Missing·끝 공백·13월·공백 든 id·cert:c·bid:·월 뒤 일·날짜 붙임) 10건 막힘 · 감사 '허용 꼴 밖'(키 없음)
    const chkF2 = async (c) => { reset85(); mem.gw_data['settings:autotask'] = JSON.parse(JSON.stringify(LIVE85)); mem.gw_data['col:tasks'] = { schema: 1, items: [] };
      const ym = KST85(0).slice(0, 7);
      const good = ['veh:v경북12가3456:insp:' + KST85(10), 'veh:v91:ins:' + KST85(5), 'lic:L91:exp:' + KST85(20), 'lic:L92:edu:' + KST85(25), 'rec:r91:over45', 'cert:c91', 'site:missing:' + ym, 'wk:missing:' + ym, 'veh:v92:insp:' + KST85(60)];
      const bad = ['site:missing-' + ym, 'wk:Missing:' + ym, 'veh:v93:insp:' + KST85(10) + ' ', 'veh:v94:insp:2026-13-01', 'lic:L 93:exp:' + KST85(10), 'rec:r92:over45 ', 'cert:c', 'bid:b1:x', 'site:missing:' + ym + '-01', 'veh:v95:insp:' + KST85(60).replace(/-/g, '')];
      const n0 = auditMock.logs.length;
      const r = await c({ action: 'autotask_ingest', key: BK, items: good.concat(bad).map((k) => ({ auto_key: k, title: 't' })) });
      const made = mem.gw_data['col:tasks'].items.map((t) => t.auto_key);
      const a = auditMock.logs.slice(n0).filter((e) => e.col === 'tasks' && e.ev[0].op === '정기업무').map((e) => e.ev[0].t).join(' | ');
      return { ok: r.code === 200 && r.body.made === 9 && r.body.blocked === 10 && JSON.stringify(r.body.blocked_rules) === JSON.stringify({ unknown: 10 }) && good.every((k) => made.indexOf(k) >= 0) && bad.every((k) => made.indexOf(k) < 0)
        && /스위치 막음 10/.test(a) && /허용 꼴 밖/.test(a) && !/missing|v93|L 93|bid:/.test(a), info: { code: r.code, made: r.body.made, blocked: r.body.blocked, br: r.body.blocked_rules, a } };
    };
    // ⑭(v453 검토 medium) 깨진 지금 값(실 blobs.js STORAGE_PARSE_FAILED)은 재해 복원으로 교체 — 회원 = 지금 레코드 없음 규칙(PIN 없음·admin·dev false·tier 없음) · 감사 = 백업 줄만(restored) · clog = 백업 체인 ·
    //    감사 note '깨진 지금 값 교체' · 지금 값을 쓰지 않는 키(settings:notify·gw_users device:)는 일시 읽기 실패여도 복원 · 회원 일시 읽기 실패는 500·그대로(⑪ 감사 키와 같음)
    const chkP = async (c) => { reset85();
      mem.gw_users['member:u89'] = { id: 'u89', name: '깨짐', admin: true, dev: true, tier: 'boss', pin_hash: 'h89', pin_salt: 's89' };   // mock 값은 있어도 읽기는 깨진 JSON으로 흉내
      mem.gw_users['member:u90'] = JSON.parse(JSON.stringify(M85)); const u90 = JSON.stringify(mem.gw_users['member:u90']);
      mem.gw_data['audit:2026-06'] = JSON.parse(JSON.stringify(AUD85)); mem.gw_data['clog:contract:2026-06'] = chain85(E85.slice(0, 1));
      const n0 = auditMock.logs.length, res = {};
      const PARSE = ['member:u89', 'audit:2026-06', 'clog:contract:2026-06'], FAIL = ['settings:notify', 'device:d89', 'member:u90'];
      try {
        blobsMock.hooks.failGet = (k) => (PARSE.indexOf(k) >= 0 ? 'STORAGE_PARSE_FAILED' : FAIL.indexOf(k) >= 0);
        res.m = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u89', data: { id: 'u89', name: '깨짐', admin: true, dev: true, tier: 'boss', pin_hash: 'x', perms: { tasks: 'do' } }, confirm: true });
        res.a = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-06', data: { schema: 1, items: [{ ts: 1500, by: '정', ev: [] }] }, confirm: true });
        res.cl = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-06', data: chain85(E85.slice(0, 2)), confirm: true });
        res.s = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'settings:notify', data: { schema: 1, events: { task_review: 'issuer_approver' } }, confirm: true });
        res.dv = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'device:d89', data: { status: 'approved' }, confirm: true });
        res.f = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u90', data: Object.assign({}, M85, { dev: true }), confirm: true });
      } finally { delete blobsMock.hooks.failGet; }
      const m = mem.gw_users['member:u89'] || {}, au = (mem.gw_data['audit:2026-06'] || {}).items || [], cl = mem.gw_data['clog:contract:2026-06'] || {};
      const ts = auditMock.logs.slice(n0).filter((e) => e.ev[0].op === '재해복원').map((e) => e.ev[0].t);
      return { ok: res.m.code === 200 && m.admin === false && m.dev === false && !('tier' in m) && !m.pin_hash && !m.pin_salt
        && res.a.code === 200 && au.length === 1 && au[0].by === '정' && Number.isFinite(au[0].restored)
        && res.cl.code === 200 && (cl.items || []).length === 2 && chainOk85(cl)
        && res.s.code === 200 && (mem.gw_data['settings:notify'] || {}).events.task_review === 'issuer_approver' && res.dv.code === 200 && !!mem.gw_users['device:d89']
        && res.f.code === 500 && JSON.stringify(mem.gw_users['member:u90']) === u90 && ts.filter((t) => /깨진 지금 값 교체/.test(t)).length === 3,
        info: { codes: Object.keys(res).map((k) => k + ':' + res[k].code + ':' + (res[k].body.error_code || '')), m, au: au.length, cl: (cl.items || []).length, ts } };
    };
    // ⑮(v453 검토 low) dry도 재해 복원 갈래 판정을 돈다 — 쓰기에서 날 거절을 would_error로(미래 시각 AUDIT_FUTURE_TS · 백업 체인 깨짐 CLOG_CHAIN_BAD) · 통과면 '' + preview.merge·preview.member(바뀐 칸·지킨 칸 이름) · 저장 0
    const chkQ = async (c) => { reset85(); mem.gw_data['audit:2026-04'] = JSON.parse(JSON.stringify(AUD85)); mem.gw_users['member:u85'] = JSON.parse(JSON.stringify(M85));
      mem.gw_data['clog:contract:2026-04'] = chain85(E85.slice(0, 1));
      const before = JSON.stringify({ u: mem.gw_users, d: mem.gw_data }), n0 = auditMock.logs.length;
      const q1 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-04', data: { schema: 1, items: [{ ts: Date.now() + 86400000, by: 'x', ev: [] }] }, dry: true });
      const q2 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'audit:2026-04', data: { schema: 1, items: [{ ts: 1500, by: '정', ev: [] }] }, dry: true });
      const q3 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_users', key: 'member:u85', data: Object.assign({}, M85, { dev: true, rank: '부장' }), dry: true });
      const tam = chain85(E85.slice(0, 3)); tam.items[2].k = 'x';
      const q4 = await c({ action: 'backup_put', secret: BK, restore: true, store: 'gw_data', key: 'clog:contract:2026-04', data: tam, dry: true });
      const same = JSON.stringify({ u: mem.gw_users, d: mem.gw_data }) === before && auditMock.logs.length === n0;
      const mb = (q3.body.preview || {}).member || {};
      return { ok: q1.code === 200 && q1.body.would_error === 'AUDIT_FUTURE_TS' && q2.code === 200 && q2.body.would_error === '' && q2.body.preview.merge.added === 1 && q2.body.preview.merge.kept === 2
        && q3.code === 200 && q3.body.would_error === '' && JSON.stringify(mb.changed) === JSON.stringify(['rank']) && mb.kept.indexOf('dev') >= 0 && q4.code === 200 && q4.body.would_error === 'CLOG_CHAIN_BAD' && same,
        info: { q1: q1.body.would_error, q2: [q2.body.would_error, (q2.body.preview || {}).merge], q3: [q3.body.would_error, mb], q4: q4.body.would_error, same } };
    };
    // ⑯(v453 검토 low) 로그인 입력에 '/'·'%'·'#'·제어문자 = 401 INVALID_CREDENTIALS(종전 500 STORAGE_BAD_KEY) · 잠금 키 안 써짐 — gw-auth(CRLF 파일)
    const GAF85 = join(FN, 'gw-auth.js'), GASRC85 = fs85b.readFileSync(GAF85, 'utf8');
    const authCaller85 = (mod) => async (body) => { const x = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
    const chkN = async (ca) => { reset85(); const rs = [];
      for (const nm of ['a/b', 'x%y', 'a#b?', '관리\u0001자', 'a\\b']) rs.push(await ca({ action: 'login', name: nm, pin: '1234' }));
      const lk = Object.keys(mem.gw_users).filter((k) => k.indexOf('lock:') === 0 && badBlobKey(k));
      return { ok: rs.every((x) => x.code === 401 && x.body.error_code === 'INVALID_CREDENTIALS') && lk.length === 0, info: rs.map((x) => x.code + ':' + x.body.error_code) };
    };

    const R85 = {};
    for (const [n, f] of [['A', chkA], ['B', chkB], ['B2', chkB2], ['B3', chkB3], ['B4', chkB4], ['C', chkC], ['C2', chkC2], ['D', chkD], ['E', chkE], ['F', chkF], ['F2', chkF2], ['G', chkG], ['H', chkH], ['J', chkJ], ['K', chkK], ['P', chkP], ['Q', chkQ]]) R85[n] = await f(c85);
    R85.N = await chkN(authCaller85(loadAt85(GAF85, GASRC85)));
    R85.L = await chkL(realBlobs85, realKey85);
    // 결함 사본 — 고친 자리를 하나씩 되돌린 gw-data(같은 mock). 각 검사가 ✗여야 한다
    const MUT85 = {
      A: [["  if (cls && !restore) plan = { status: 403, body: { status: 'FORBIDDEN', error_code: 'RESTORE_MODE_ONLY'", "  if (false) plan = { status: 403, body: { status: 'FORBIDDEN', error_code: 'RESTORE_MODE_ONLY'"]],
      B: [["const BACKUP_MEMBER_AUTH = ['pin_salt', 'pin_hash', 'admin', 'dev', 'tier', 'perms'];", "const BACKUP_MEMBER_AUTH = ['pin_salt', 'pin_hash', 'admin'];"],
        ["const BACKUP_MEMBER_IDENT = ['name', 'uid', 'role', 'dept'];", 'const BACKUP_MEMBER_IDENT = [];']],
      B2: [['payload.admin = false; payload.dev = false; payload.id', 'payload.admin = false; payload.id'], ['delete payload.tier; payload.admin = false;', 'payload.admin = false;'],
        ["(pk ? ' · perms [' + pk.slice(0, 120) + ']' : '')", "''"]],
      B4: [["      else { if (own(payload, 'del') && JSON.stringify(payload.del) !== JSON.stringify(prev.del)) kept.push('del'); if (own(prev, 'del')) payload.del = prev.del; else delete payload.del; }", '      else {}'],
        ["      else if (has(payload, 'leave_date') && tier.retired({ leave_date: payload.leave_date })) {", '      else if (false) {'],
        ['if (tier.ctxOf(all).pmIds.length > 0 && tier.ctxOf(after).pmIds.length === 0) return', 'if (false) return']],
      P: [["const corrupt = !cur.ok && cur.code === 'STORAGE_PARSE_FAILED';", 'const corrupt = false;'], ['const needCur = isMember || ', 'const needCur = true || ']],
      Q: [['  else if (cls) plan = await backupRestorePlan(', '  else if (cls && !d.dry) plan = await backupRestorePlan(']],
      B3: [["        if (!has(prev, f)) return;   // 지금 값이 없을 때만 백업 값", "        if (!has(prev, f)) { delete payload[f]; return; }"],
        ["const BACKUP_MEMBER_AUTH = ['pin_salt', 'pin_hash', 'admin', 'dev', 'tier', 'perms'];", "const BACKUP_MEMBER_AUTH = ['pin_salt', 'pin_hash', 'admin', 'dev', 'tier', 'perms', 'del'];"]],
      C: [["} else if (cls === 'audit' || cls === 'doclog' || cls === 'reclog') {", '} else if (false) {'],
        ['add.push(Object.assign({}, e, { restored: now }));', 'add.push(e);'],
        ["function backupLogLine(e) { if (!Object.prototype.hasOwnProperty.call(e, 'restored')) return JSON.stringify(e);", "function backupLogLine(e) { return JSON.stringify(e); if (!Object.prototype.hasOwnProperty.call(e, 'restored')) return JSON.stringify(e);"],
        ['? AUDIT_MAX_PER_MONTH :', '? 8001 :']],
      C2: [['const items = add.concat(cur).sort(function (a, b) { return tsOf(a) - tsOf(b); });', 'const items = add.concat(cur);'],
        ["(cls === 'audit' && key === auditKey()) ? 1 : 0", '0'],
        ["  if (needCur && !cur.ok && !corrupt && cur.code !== 'NOT_FOUND') return { status: 500,", '  if (false) return { status: 500,']],
      D: [["  if (key.indexOf('settings:') === 0) return 'settings';\n", '']],
      F2: [["  return 'unknown';\n}\nasync function handleAutotaskIngest", "  return '';\n}\nasync function handleAutotaskIngest"],
        ["  site: new RegExp('^site:missing:' + AUTOTASK_MONTH + '$'),", "  site: new RegExp('^site:missing:' + AUTOTASK_MONTH),"],
        ["  veh: new RegExp('^veh:' + AUTOTASK_ID + ':(insp|ins):(' + AUTOTASK_DATE + ')$'),", "  veh: new RegExp('^veh:' + AUTOTASK_ID + ':(insp|ins):(' + AUTOTASK_DATE + ')'),"]],
      J: [["  if (key.indexOf('doclog:') === 0) return 'doclog';\n", ''], ["  if (key.indexOf('reclog:') === 0) return 'reclog';\n", ''],
        ["  if (key.indexOf('clog:') === 0) return 'clog';", "  if (key === CON_CLOG_KEY || key.indexOf(CON_CLOG_KEY + ':') === 0) return 'clog';"],   // v453 검토: clog:appr:* 빠지던 앞 회차
        ["  if (key.indexOf('clog:') === 0) return 'clog';", "  if (false) return 'clog';"],
        ["      if (!add.length) return { err: 'CLOG_NOT_AHEAD' };", '      if (false) return { err: \'CLOG_NOT_AHEAD\' };'],
        ["    if (!bk.items.length || cur.items.some(function (e) { return e.h === bk.head; })) return { err: 'CLOG_NOT_AHEAD' };", ''],
        ["  if (!bk.items.every(isObj) || !backupClogChainOk(bk, strict)) return { err: 'CLOG_CHAIN_BAD' };", ''],
        ['    o.rechained = now;\n', ''],
        ['    if (typeof o.of === \'string\' && own(remap, o.of)) o.of = remap[o.of];\n', ''],
        ['function backupClogStrict(key) { return key === CON_CLOG_KEY', 'function backupClogStrict(key) { return true || key === CON_CLOG_KEY'],
        ['Array.isArray(doc.restored) ? { restored: doc.restored } : {}', '{}'],
        ["  if (!cur.items.length) return done(bk.items, bk.head, bk.items.length, 0, 0,", "  if (!curChain) return done(bk.items, bk.head, bk.items.length, 0, 0,"],   // 앞 회차: 깨진 지금 체인 = 백업으로 통째(지금 줄 버림)
        ["  const curOk = isObj(curDoc) && Array.isArray(curDoc.items);\n  const curItems", "  const curOk = isObj(curDoc) && Array.isArray(curDoc.items) && !curDoc.items.length;\n  const curItems"]],   // 갈라짐 = 거절 대신 덮기
      K: [["  if (badBlobKey(key)) return jr(400, { status: 'REJECTED', error_code: 'BAD_KEY', request_id: R });\n  // 민감키", '  // 민감키'],
        ["  if (badBlobKey(key)) return jr(400, { status: 'REJECTED', error_code: 'BAD_KEY', request_id: R });   // v453 접두", '  // v453 접두']],
      E: [['restore = bot && d.restore === true;', 'restore = false;'], ["  } else if (cls === 'settings' && key === AUTOTASK_KEY) {", '  } else if (false) {'],
        ["if (rules[k] === 'live' && now[k] !== 'live')", "if (rules[k] === 'live' && false)"]],
      F: [["if (rule && (rule === 'unknown' || sw.rules[rule] !== 'live'))", "if (rule && (rule === 'unknown'))"], ["return dd >= AR.VEH90_MIN ? 'veh_insp90' : '';", "return dd > AR.VEH90_MIN ? 'veh_insp90' : '';"]],
      G: [['b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)', 'b.length > 0 && crypto.timingSafeEqual(a, b)']],
      H: [['const SETTINGS_APPLY_TARGETS = { notify: 1, assign: 1, doneif: 1 };', 'const SETTINGS_APPLY_TARGETS = { notify: 1, assign: 1, doneif: 1, autotask: 1 };'],
        ['try { au = await appendAudit({ ts: now,', 'try { au = true; if (0) await appendAudit({ ts: now,'],
        ["prev: { events: nf.events, updated_at: nf.updated_at || 0, updated_by: nf.updated_by || '' }, updated_by: by,", "prev: { events: next, updated_at: nf.updated_at || 0, updated_by: nf.updated_by || '' }, updated_by: by,"],
        ["  if (d.dry !== undefined && d.dry !== true && d.dry !== false) return jr(400, { status: 'REJECTED', error_code: 'BAD_DRY', request_id: R });\n", ''],
        ["  if (d.confirm !== true) return jr(400, { status: 'REJECTED', error_code: 'NEED_CONFIRM', changes: ev, updated_at: curAt || 0, request_id: R });\n", ''],
        ["  if (d.base === undefined) return jr(400, { status: 'REJECTED', error_code: 'NEED_BASE',", "  if (false) return jr(400, { status: 'REJECTED', error_code: 'NEED_BASE',"],
        ["  if (!pre.ok && pre.code !== 'NOT_FOUND') return jr(503, { status: 'ERROR', error_code: 'SETTINGS_READ_FAILED', request_id: R });\n", '']],
    };
    const M85R = {};
    for (const n of Object.keys(MUT85)) {
      M85R[n] = [];
      for (const [from, to] of MUT85[n]) { const f = { A: chkA, B: chkB, B2: chkB2, B3: chkB3, B4: chkB4, C: chkC, C2: chkC2, D: chkD, E: chkE, F: chkF, F2: chkF2, G: chkG, H: chkH, J: chkJ, K: chkK, P: chkP, Q: chkQ }[n]; M85R[n].push((await f(caller85(mut85(from, to)))).ok); }
    }
    auditMock.curKey = '';
    // 저장소 층 결함 사본 — 실 blobs.js에서 get·set·delete 하나씩 키 검사를 걷은 것 · 실 blobkey.js에서 규칙 하나씩 걷은 것(각각 chkL ✗여야)
    const blMut85 = (fn) => { const re = new RegExp('(async function ' + fn + '\\([^)]*\\) \\{\\r?\\n)\\s*if \\(badBlobKey\\(key\\)\\)[^\\n]*\\n'); if (!re.test(BLSRC)) throw new Error('blobs.js 결함 자리 없음: ' + fn); return loadAt85(BLF, BLSRC.replace(re, '$1')); };
    const bkMut85 = (from, to) => { if (BKSRC.split(from).length !== 2) throw new Error('blobkey.js 결함 자리가 한 곳이 아님: ' + from); return loadAt85(BKF, BKSRC.replace(from, () => to)).badBlobKey; };
    M85R.L = [];
    for (const fn of ['blobGet', 'blobSet', 'blobDelete']) M85R.L.push((await chkL(blMut85(fn), realKey85)).ok);
    for (const [from, to] of [['[/\\\\%?#\\x00-\\x1f\\x7f]', '[\\\\%?#\\x00-\\x1f\\x7f]'], ['[/\\\\%?#\\x00-\\x1f\\x7f]', '[/%?#\\x00-\\x1f\\x7f]'], ['[/\\\\%?#\\x00-\\x1f\\x7f]', '[/\\\\?#\\x00-\\x1f\\x7f]'],
      ['[/\\\\%?#\\x00-\\x1f\\x7f]', '[/\\\\%?#]'], ["  if (key !== key.trim()) return true;\n", ''], ["  if (key === '.' || key === '..') return true;\n", '']]) M85R.L.push((await chkL(realBlobs85, bkMut85(from, to))).ok);
    // gw-auth(CRLF) 결함 사본 — 로그인 키 이름 검사 줄을 걷으면 500으로 돌아가야(chkN ✗)
    const gaFrom85 = "  if (badBlobKey(lockKey(ident)) || badBlobKey(nameKey(ident)) || badBlobKey(nameKeyRaw(ident))) return GEN();";
    if (GASRC85.split(gaFrom85).length !== 2) throw new Error('gw-auth 결함 자리가 한 곳이 아님');
    M85R.N = [(await chkN(authCaller85(loadAt85(GAF85, GASRC85.replace(gaFrom85, () => '  // (결함 사본)'))))).ok];
    const killed85 = (n) => M85R[n].length > 0 && M85R[n].every((x) => x === false);
    const statOld85 = stat85(mutSrc85("  if (!botKeyOk(d.key)) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });   // v453 상수시간\n  const items",
      "  const secret = (process.env.BIDS_INGEST_KEY || '').trim();\n  if (!secret || String(d.key || '').trim() !== secret) return jr(403, { status: 'FORBIDDEN', error_code: 'BAD_INGEST_KEY', request_id: R });\n  const items"));
    T('85 v453 ① backup_put 자기 승격 막음: 관리자(비개발자) 세션으로 자기 회원 레코드에 dev·tier boss = 403 RESTORE_MODE_ONLY · 봇 키만(restore 표식 없음)으로 dev = 403 · 레코드 dev 없음·tier admin 그대로 · 결함 사본(관문 걷음) ✗',
      R85.A.ok && killed85('A'), JSON.stringify({ A: R85.A.info, mut: M85R.A }));
    T('85 v453 ② 재해 복원 모드 회원: 권한 칸(dev·tier·perms·admin·PIN)·있는 신원 칸(uid·name·role·dept·leave_date) 지금 값 · 직급·연번만 백업본 · 감사 재해복원 "바뀐 칸 [rank,seq]"·지킨 칸 이름(값 없음) · 없는 회원 = PIN 없음·admin·dev false·tier 없음·id는 키·perms 백업 값(감사 note perms [칸:값]) · 검토: 지운 회원(del 1)·부분 레코드 = del 해제·빠진 이름·역할·부서만 백업 값·권한 칸 지금 값·감사 "del 해제" · 결함 사본(옛 PIN·admin만 · 신원 칸 안 지킴 · 새 회원 dev 그대로 · 새 회원 tier 그대로 · perms note 없음 · 빠진 신원 칸 지움 · del 지킴) ✗',
      R85.B.ok && R85.B2.ok && R85.B3.ok && killed85('B') && killed85('B2') && killed85('B3'), JSON.stringify({ B: R85.B.info, B2: R85.B2.info, B3: R85.B3.info, mut: [M85R.B, M85R.B2, M85R.B3] }));
    T('85 v453 ③ 감사 로그 붙이기만: 관리자 세션·봇 키만 비우기 403(그대로) · 재해 복원 = 바꿔치기 줄은 새 줄로 앞에·원래 2줄 그대로 뒤(4줄 · 붙임 2) · 빈 백업으로도 안 줄어듦 · 미래 시각 400 AUDIT_FUTURE_TS · 7999 + 2 = 400 AUDIT_FULL(그대로) · 검토: 되살린 줄만 restored 표식 · 같은 백업 다시 = 붙임 0 · 결함 사본(통째 덮기 · 표식 없음 · 표식 때문에 겹쳐 붙음 · 상한 8001) ✗',
      R85.C.ok && killed85('C'), JSON.stringify({ C: R85.C.info, mut: M85R.C }));
    T('85 v453 ④ 민감 설정 키 settings:*: 관리자 세션·봇 키만·관리자 세션 + restore 표식 = 403 RESTORE_MODE_ONLY(settings:autotask 없음 그대로·settings:notify 그대로) · 미리보기 dry 200 restore_only·would_error RESTORE_MODE_ONLY · 결함 사본(settings 갈래 뺌) ✗',
      R85.D.ok && killed85('D'), JSON.stringify({ D: R85.D.info, mut: M85R.D }));
    T('85 v453 ⑤ 재해 복원 길 통과: 봇 키 + restore + confirm = settings:autotask·gw_users device 200(감사 재해복원) · confirm 없으면 NEED_CONFIRM · logsheet allbaro:xlsx·restore.py selftest 길 = 종전 200(감사 백업복원) · 2차 검토: settings:autotask 백업 live는 지금이 live가 아니면 dry로(감사 "스위치 live 복원 안 함 [3규칙]")·지금 live인 규칙은 그대로 · 결함 사본(복원 모드 못 켬 · live 낮추기 걷음 2곳) ✗',
      R85.E.ok && killed85('E'), JSON.stringify({ E: R85.E.info, mut: M85R.E }));
    T('85 v453 ⑥ autotask_ingest 서버 스위치: 스위치 없음(dry) = site·wk·veh 만료 31·60일 막음(blocked 4 · 규칙별 수) · 기존 D-30 veh 10·30일·증명서 생성 · 감사 "스위치 막음 4"(키 없음) · site live/veh off/wk dry = site만 · 전부 live = 나머지 · 결함 사본(스위치 판정 걷음 · 경계 31 → 32) ✗',
      R85.F.ok && killed85('F'), JSON.stringify({ F: R85.F.info, mut: M85R.F }));
    T('85 v453 ⑦ 봇 키 상수시간 비교: 길이 다른 키·같은 길이 다른 키·빈 키 = 403(autotask_ingest·backup_put·settings_apply) · 소스 process.env.BIDS_INGEST_KEY는 botKeyOk 한 곳·"=== secret"/"!== secret" 0·ingest 첫 줄 botKeyOk · 결함 사본(길이 검사 걷음 = 500 · ingest 옛 비교) ✗',
      R85.G.ok && killed85('G') && stat85(SRC85) && !statOld85, JSON.stringify({ G: R85.G.info, mut: M85R.G, stat: stat85(SRC85), statOld85 }));
    T('85 v453 ⑧ settings_apply: 키 403 · autotask·settings:notify 이름 = 400 BAD_TARGET · 표식·값·같은 값·낡은 base 거부 · dry 안 씀 · notify 두 칸 적용(나머지 칸 그대로·prev 직전 판·bot:표식·applied_via·감사 설정적용 1줄 ev 2·ref) · 앱 카드 notify_revert로 그대로 · assign 접두어·승인권자(명부 밖·모르는 접두어 400) · doneif on · 검토: dry 1·"true" = 400 BAD_DRY · confirm 없음 = 400 NEED_CONFIRM(안 씀) · 2차 검토: 쓰기에 base 없음 = 400 NEED_BASE · 대상 키 읽기 실패·깨진 값(notify·doneif, dry 포함) = 503 SETTINGS_READ_FAILED·그대로 · 결함 사본(autotask 허용 · 감사 없음 · prev 새 값 · BAD_DRY 걷음 · confirm 걷음 · base 필수 걷음 · 직접 읽기 걷음) ✗',
      R85.H.ok && killed85('H'), JSON.stringify({ H: R85.H.info, mut: M85R.H }));
    T('85 v453 ⑨ 키 이름(검토 high — SDK가 키를 URL 경로에 붙여 new URL이 접음): 관리자 세션 backup_put "x/../settings:autotask"·"../site:gw_users/member:<id>"·"\\naudit:YYYY-MM"·"x/../push:keys"·백슬래시·끝 공백·%2e%2e·%2F·탭·".." = 400 BAD_KEY · 봇 backup_get 같은 꼴 = 400 · 운영 값·회원 dev 그대로 · 개인키·PIN 해시 응답 0 · 바른 키 200 · 실 blobs.js가 SDK에 안 넘김(STORAGE_BAD_KEY)·바른 키는 넘김 · blobkey 실제 키 꼴 통과 · mock도 거부 · 결함 사본(핸들러 검사 2곳 · blobs get/set/delete 3곳 · blobkey 규칙 6개 걷음) ✗',
      R85.K.ok && R85.L.ok && killed85('K') && killed85('L'), JSON.stringify({ K: R85.K.info, L: R85.L.info, mut: [M85R.K, M85R.L] }));
    T('85 v453 ⑩ 기록 키(검토 medium): doclog·reclog·clog:contract·clog:contract:YYYY-MM = 관리자 세션·봇 키만 403(그대로) · doclog 재해 복원 = 붙이기만(되살린 줄 restored) · clog = 지금 체인을 잇는 백업은 그 뒤 줄만(짧음·같음 CLOG_NOT_AHEAD·체인 깨짐 CLOG_CHAIN_BAD·그대로 · 없던 키는 받음) · 2차 검토: 갈라짐 = 다시 이음(백업 4 + 지금에만 있는 1 rechained·체인 OK·restored 범위 from/to·감사 from/to 해시·dry 같은 판정) · 손실 뒤 새 줄 2(revert 포함) + 백업 27 = 29줄·revert of 새 h · restored가 다음 con_clog_add에도 남음 · 깨진 지금 체인도 읽히는 줄 다시 이음 · clog:appr:* = 관리자 403·잘린 체인(시작 p 있음) 잇기 · 결함 사본(appr 빠진 갈래 · clog 갈래 · NOT_AHEAD 2곳 · 체인 검사 · rechained 표식 · of 고침 · appr 엄격 시작 · restored 안 남김 · 깨지면 통째 · 갈라지면 덮기) ✗',
      R85.J.ok && killed85('J'), JSON.stringify({ J: R85.J.info, mut: M85R.J }));
    T('85 v453 ⑪ 감사 로그 병합 마무리(검토 low): 되살린 줄·지금 줄 ts 안정 정렬(a·b·c) · 이번 달 키 7999 + 1 = 400 AUDIT_FULL("재해복원" 1줄 자리) · 지난달 키 7999 + 1 = 200·8000 · 지금 키 읽기 실패 = 500·그대로 · 상한은 audit.js MAX_PER_MONTH(8000 글자 gw-data 0) · 결함 사본(정렬 · 자리 남김 · 읽기 실패 관문 걷음) ✗',
      R85.C2.ok && killed85('C2'), JSON.stringify({ C2: R85.C2.info, mut: M85R.C2 }));
    T('85 v453 ⑫ autotask_ingest 키 꼴 허용 목록(검토 low): 스위치 전부 live에서도 7꼴(한글 번호판 id 포함) 9건만 생성 · 꼴만 바꾼 10건(site:missing-·wk:Missing·끝 공백·13월·공백 id·cert:c·bid:·월 뒤 일·날짜 붙임) = blocked_rules {unknown 10} · 감사 "허용 꼴 밖"(키 없음) · 결함 사본(목록 밖 통과 · site·veh 끝 $ 걷음) ✗',
      R85.F2.ok && killed85('F2'), JSON.stringify({ F2: R85.F2.info, mut: M85R.F2 }));
    T('85 v453 ⑬ 재직 회원 끄기 막음(2차 검토 medium): 재해 복원 백업 del:1·지난 leave_date = del 없음·퇴사일 없음 그대로(감사 지킨 칸 del·leave_date) · 오늘 이후 퇴사일은 받음 · 부트스트랩 파생 pm만 있을 때 명시 tier 관리자 되살림 = 409 LAST_PM·그대로(dry would_error LAST_PM) · 결함 사본(del 백업 따름 · 지난 퇴사일 받음 · LAST_PM 걷음) ✗',
      R85.B4.ok && killed85('B4'), JSON.stringify({ B4: R85.B4.info, mut: M85R.B4 }));
    T('85 v453 ⑭ 깨진 지금 값 교체(2차 검토 medium): 실 blobs.js STORAGE_PARSE_FAILED = 회원 새 레코드 규칙(PIN·admin·dev·tier 없음)·감사 백업 줄만(restored)·clog 백업 체인 200 · 감사 "깨진 지금 값 교체" 3줄 · settings:notify·device: 일시 읽기 실패여도 200 · 회원 일시 읽기 실패 500·그대로 · 결함 사본(깨진 값도 500 · 모든 갈래 읽기 검사) ✗',
      R85.P.ok && killed85('P'), JSON.stringify({ P: R85.P.info, mut: M85R.P }));
    T('85 v453 ⑮ dry 미리보기가 쓰기와 같은 판정(2차 검토 low): 미래 시각 감사 = would_error AUDIT_FUTURE_TS · 깨진 백업 체인 = CLOG_CHAIN_BAD · 통과 = "" + merge {added 1·kept 2} · 회원 = member {changed [rank]·kept dev} · 저장·감사 0 · 결함 사본(dry는 판정 건너뜀) ✗',
      R85.Q.ok && killed85('Q'), JSON.stringify({ Q: R85.Q.info, mut: M85R.Q }));
    T('85 v453 ⑯ 로그인 키 이름(2차 검토 low): gw-auth login 이름 칸 "a/b"·"x%y"·"a#b?"·제어문자·백슬래시 = 401 INVALID_CREDENTIALS(종전 500 STORAGE_BAD_KEY) · 금지 글자 잠금 키 0 · 결함 사본(검사 줄 걷음) ✗',
      R85.N.ok && killed85('N'), JSON.stringify({ N: R85.N.info, mut: M85R.N }));
  } finally { reset85(); auditMock.curKey = ''; delete blobsMock.hooks.failGet; }
}

{ // ---- 86(v456) 서버·저장 안전 수리 묶음 — C066(요청 gzip·zip 항목 풀기 상한 · PII_RE 보강) · C079(숫자 아닌 updated_at) · C080(거래처 13자리 · 물어보기) ·
  //   C082(명부 옛 건강진단 exam · 현장 대장 고아 일용직 id) · C107(backup_put 쓰기는 봇 키만) · C108(gw-cron-kick·gw-lawwatch 상수시간 비교) · T427(간극 분모 빈칸↔빈칸 · cellRows 병합 비앵커).
  //   검사마다 고친 자리를 되돌린 사본(gw-data·docdiff·learn·ask — 소스 한 곳을 바꿔 같은 mock으로 메모리에서 컴파일, 파일은 쓰지 않음)에서는 실패해야 한다. 실패 글에 번호 값은 싣지 않는다(참·거짓·코드만).
  const fs86 = require('fs'), Mod86 = require('module'), zlib86 = require('zlib');
  const load86 = (file, src) => { const m = new Mod86(file); m.filename = file; m.paths = Mod86._nodeModulePaths(dirname(file)); m._compile(src, file); return m.exports; };
  const F86 = { gwd: join(FN, 'gw-data.js'), dd: join(FN, '_lib/docdiff.js'), ln: join(FN, '_lib/learn.js'), ask: join(FN, '_lib/ask.js') };
  const S86 = {}; Object.keys(F86).forEach((k) => { S86[k] = fs86.readFileSync(F86[k], 'utf8'); });
  const mutSrc86 = (k, from, to) => { if (S86[k].split(from).length !== 2) throw new Error('결함 자리가 한 곳이 아님: ' + from.slice(0, 60)); return S86[k].replace(from, () => to); };
  const mut86 = (k, from, to) => load86(F86[k], mutSrc86(k, from, to));
  const caller86 = (mod) => async (body, tok, dev) => { const r = await mod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
  const raw86 = async (mod, event) => { const r = await mod.handler(Object.assign({ httpMethod: 'POST' }, event)); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
  const c86 = caller86(gwd);
  const snap86 = JSON.stringify({ u: mem.gw_users, d: mem.gw_data });
  const reset86 = () => { const s = JSON.parse(snap86); mem.gw_users = s.u; mem.gw_data = s.d; };
  const SAFE86 = { id: 'us86', name: '안전86', admin: false, perms: { wk: 'do', safety: 'view' } }, WK86 = { id: 'uw86', name: '명부86', admin: false, perms: { wk: 'do' } };
  const ADM86 = { id: 'ua86', name: '관리86', admin: true, perms: {}, tier: 'pm' };
  const tS86 = issueSession(SAFE86).token, tW86 = issueSession(WK86).token, tA86 = issueSession(ADM86).token;
  const seedU86 = () => { mem.gw_users['member:uadmin'] = JSON.parse(JSON.stringify(ADMIN)); mem.gw_users['member:us86'] = JSON.parse(JSON.stringify(SAFE86)); mem.gw_users['member:uw86'] = JSON.parse(JSON.stringify(WK86)); mem.gw_users['member:ua86'] = JSON.parse(JSON.stringify(ADM86)); mem.gw_users['device:dev1'] = { status: 'approved' }; };
  // 작은 zip 작성기(저장 0·deflate 8 둘 다 — 항목: [이름, 원본 Buffer, deflate 여부])
  const crcT86 = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
  const crc86 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcT86[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const zip86 = (entries) => { const locals = [], cds = []; let off = 0; for (const [name, raw, defl] of entries) { const nb = Buffer.from(name), db = defl ? zlib86.deflateRawSync(raw) : raw, crc = defl ? 0 : crc86(raw), mth = defl ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(mth, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(mth, 10); cd.writeUInt32LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42);
    locals.push(lh, nb, db); cds.push(cd, nb); off += 30 + nb.length + db.length; }
    const cdb = Buffer.concat(cds), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16); return Buffer.concat([...locals, cdb, eocd]); };
  const xlsx86 = (cells, merged) => zip86([['[Content_Types].xml', Buffer.from('<Types/>')], ['xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>')], ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1">' + cells + '</row></sheetData>' + (merged ? '<mergeCells count="1"><mergeCell ref="' + merged + '"/></mergeCells>' : '') + '</worksheet>'), true]]);
  const R86 = {}, MUT86 = {};
  const chk86 = {
    // ① C066 요청 gzip 상한: 풀면 40MB(공백) = 413 BODY_TOO_LARGE · 작은 gzip = 200 · 깨진 JSON = 400 INVALID_JSON
    A: async (mod) => { reset86(); seedU86(); mem.gw_data['col:tasks'] = { schema: 1, items: [], updated_at: 1 };
      const ev = (b) => ({ headers: { authorization: 'Bearer ' + tokA, 'x-gw-enc': 'gzip' }, body: b, isBase64Encoded: true });
      const a1 = await raw86(mod, ev(zlib86.gzipSync(Buffer.alloc(40 * 1024 * 1024, 32)).toString('base64')));
      const a2 = await raw86(mod, ev(zlib86.gzipSync(Buffer.from(JSON.stringify({ action: 'get', collection: 'tasks' }))).toString('base64')));
      const a3 = await raw86(mod, { headers: {}, body: '{nope' });
      return { ok: a1.code === 413 && a1.body.error_code === 'BODY_TOO_LARGE' && a2.code === 200 && a3.code === 400 && a3.body.error_code === 'INVALID_JSON', info: [a1.code, a1.body.error_code, a2.code, a3.code] };
    },
    // ③ C079 숫자 아닌 updated_at: 글자 시각 문서에 아무 base로 저장 = 200·updated_at 숫자로 · 그 뒤 낡은 base = 409(낙관락 다시 걸림) · 숫자 글자('1000')는 종전처럼 비교(999 = 409)
    C: async (mod) => { reset86(); seedU86(); const c = caller86(mod);
      mem.gw_data['col:vehicles'] = { schema: 1, items: [{ id: 'v86', no: '86가' }], updated_at: '2026-11-11T00:00:00Z' };
      const r1 = await c({ action: 'save', collection: 'vehicles', base: 12345, doc: { schema: 1, items: [{ id: 'v86', no: '86나' }] } }, tokA);
      const at = mem.gw_data['col:vehicles'].updated_at;
      const r2 = await c({ action: 'save', collection: 'vehicles', base: 1, doc: { schema: 1, items: [] } }, tokA);
      const r3 = await c({ action: 'save', collection: 'vehicles', base: at, doc: { schema: 1, items: [{ id: 'v86', no: '86다' }] } }, tokA);
      mem.gw_data['col:vehicles'] = { schema: 1, items: [], updated_at: '1000' };
      const r4 = await c({ action: 'save', collection: 'vehicles', base: 999, doc: { schema: 1, items: [] } }, tokA);
      const r5 = await c({ action: 'save', collection: 'vehicles', base: 1000, doc: { schema: 1, items: [] } }, tokA);
      return { ok: r1.code === 200 && typeof at === 'number' && Number.isFinite(at) && r2.code === 409 && r2.body.error_code === 'STALE_BASE' && r3.code === 200 && r4.code === 409 && r5.code === 200, info: [r1.code, typeof at, r2.code, r3.code, r4.code, r5.code] };
    },
    // ④ C080 거래처 13자리: 새 거래처(전각·줄표 섞임) = 400 CLI_BIZ13·저장 안 됨 · 서버에 있던 13자리 그대로 + 다른 줄 고침 = 200 · 있던 줄을 13자리로 바꿈 = 400 · 가린 번호·10자리·쉼표로 나눈 둘 = 200
    D: async (mod) => { reset86(); seedU86(); const c = caller86(mod);
      const OLD = '1111111111111', base0 = { schema: 1, items: [{ id: 'c1', name: '갑', biz_no: '1234567890' }, { id: 'c2', name: '을', biz_no: OLD }], updated_at: 860 };
      mem.gw_data['col:clients'] = JSON.parse(JSON.stringify(base0)); const s0 = JSON.stringify(mem.gw_data['col:clients']);
      const d1 = await c({ action: 'save', collection: 'clients', base: 860, doc: { schema: 1, items: base0.items.concat([{ id: 'c3', name: '병', biz_no: '９００１０１－１２３４５６７' }]) } }, tokA);
      const same1 = JSON.stringify(mem.gw_data['col:clients']) === s0;
      const d2 = await c({ action: 'save', collection: 'clients', base: 860, doc: { schema: 1, items: [{ id: 'c1', name: '갑2', biz_no: '1234567890' }, { id: 'c2', name: '을', biz_no: OLD }] } }, tokA);
      const at2 = mem.gw_data['col:clients'].updated_at;
      const d3 = await c({ action: 'save', collection: 'clients', base: at2, doc: { schema: 1, items: [{ id: 'c1', name: '갑2', biz_no: '900101 1234567' }, { id: 'c2', name: '을', biz_no: OLD }] } }, tokA);
      const d4 = await c({ action: 'save', collection: 'clients', base: at2, doc: { schema: 1, items: [{ id: 'c1', name: '갑2', biz_no: '1234567890' }, { id: 'c2', name: '을', biz_no: OLD }, { id: 'c4', name: '정', biz_no: '900101-1******' }, { id: 'c5', name: '무', biz_no: '123-45-67890, 234-56-78901' }] } }, tokA);
      return { ok: d1.code === 400 && d1.body.error_code === 'CLI_BIZ13' && d1.body.n === 1 && same1 && JSON.stringify(d1.body).indexOf('９') < 0 && d2.code === 200 && d3.code === 400 && d3.body.error_code === 'CLI_BIZ13' && d4.code === 200 && mem.gw_data['col:clients'].items.length === 4,
        info: [d1.code, d1.body.error_code, same1, d2.code, d3.code, d4.code] };
    },
    // ⑤-1 C082 ① 명부 exam: 안전 권한 없는 일용직 수행자 읽기 = exam 칸 없음 · 안전 보기·관리자 = 있음 · 그 사람 저장 = exam 서버 값 이월(보낸 값 버림·새 줄 exam 없음) · 안전 권한자 저장 = 반영 · 직전 명부 못 읽으면 500 PREV_READ_FAILED
    E: async (mod) => { reset86(); seedU86(); const c = caller86(mod);
      mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w86a', name: '가', exam: '2026-01-02' }, { id: 'w86b', name: '나' }], updated_at: 861 };
      const g1 = await c({ action: 'get', collection: 'workers' }, tW86, 'dev1'), g2 = await c({ action: 'get', collection: 'workers' }, tS86, 'dev1'), g3 = await c({ action: 'get', collection: 'workers' }, tA86, 'dev1');
      const noEx = g1.code === 200 && g1.body.doc.items.every((w) => !('exam' in w)) && g1.body.doc.items.length === 2;
      const hasEx = g2.code === 200 && g2.body.doc.items[0].exam === '2026-01-02' && g3.code === 200 && g3.body.doc.items[0].exam === '2026-01-02';
      const s1 = await c({ action: 'save', collection: 'workers', base: 861, doc: { schema: 1, items: [{ id: 'w86a', name: '가2' }, { id: 'w86b', name: '나', exam: '2020-01-01' }, { id: 'w86c', name: '다', exam: '' }] } }, tW86, 'dev1');
      const it1 = mem.gw_data['col:workers'].items, at1 = mem.gw_data['col:workers'].updated_at;
      const keep = s1.code === 200 && it1[0].name === '가2' && it1[0].exam === '2026-01-02' && !('exam' in it1[1]) && !('exam' in it1[2]);
      const s2 = await c({ action: 'save', collection: 'workers', base: at1, doc: { schema: 1, items: [{ id: 'w86a', name: '가2', exam: '2026-03-03' }, { id: 'w86b', name: '나' }] } }, tS86, 'dev1');
      const safeW = s2.code === 200 && mem.gw_data['col:workers'].items[0].exam === '2026-03-03';
      blobsMock.hooks.failGet = (k) => k === 'col:workers';
      const s3 = await c({ action: 'save', collection: 'workers', doc: { schema: 1, items: [] } }, tW86, 'dev1');
      delete blobsMock.hooks.failGet;
      return { ok: noEx && hasEx && keep && safeW && s3.code === 500 && s3.body.error_code === 'PREV_READ_FAILED' && mem.gw_data['col:workers'].items.length === 2, info: [noEx, hasEx, s1.code, keep, s2.code, safeW, s3.code, s3.body.error_code] };
    },
    // ⑤-2 C082 ② 현장 대장 고아 id: 그 줄에 이미 있던 명부 밖 id(wGone) + 새 명부 id = 200 · 새 명부 밖 id = 400 ORPHAN_WORKER(n 1·저장 안 됨) · 새 줄의 글자 "[...]" 모양도 같음 · 지운 일용직(del 1)은 명부에 있음 = 200 · 새 id가 있을 때 명부 못 읽음 = 500
    F: async (mod) => { reset86(); seedU86(); const c = caller86(mod);
      mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w86a', name: '가' }, { id: 'w86d', name: '지운', del: 1 }], updated_at: 862 };
      mem.gw_data['col:asbestos'] = { schema: 1, items: [{ id: 'a86', title: '옛 현장', worker_ids: ['wGone'] }], updated_at: 863 };
      const f1 = await c({ action: 'save', collection: 'asbestos', base: 863, doc: { schema: 1, items: [{ id: 'a86', title: '옛 현장', worker_ids: ['wGone', 'w86a'] }] } }, tokA);
      const at1 = mem.gw_data['col:asbestos'].updated_at, s1 = JSON.stringify(mem.gw_data['col:asbestos']);
      const f2 = await c({ action: 'save', collection: 'asbestos', base: at1, doc: { schema: 1, items: [{ id: 'a86', title: '옛 현장', worker_ids: ['wGone', 'w86a', 'wNew'] }] } }, tokA);
      const same2 = JSON.stringify(mem.gw_data['col:asbestos']) === s1;
      const f3 = await c({ action: 'save', collection: 'asbestos', base: at1, doc: { schema: 1, items: [{ id: 'a86', title: '옛 현장', worker_ids: ['wGone', 'w86a'] }, { id: 'a87', title: '새 현장', worker_ids: '["wX"]' }] } }, tokA);
      const f4 = await c({ action: 'save', collection: 'asbestos', base: at1, doc: { schema: 1, items: [{ id: 'a86', title: '옛 현장', worker_ids: ['wGone', 'w86a', 'w86d'] }] } }, tokA);
      const at4 = mem.gw_data['col:asbestos'].updated_at;
      blobsMock.hooks.failGet = (k) => k === 'col:workers';
      const f5 = await c({ action: 'save', collection: 'asbestos', base: at4, doc: { schema: 1, items: [{ id: 'a86', title: '옛 현장', worker_ids: ['wGone', 'w86a', 'w86d', 'w86a2'] }] } }, tokA);
      delete blobsMock.hooks.failGet;
      return { ok: f1.code === 200 && f2.code === 400 && f2.body.error_code === 'ORPHAN_WORKER' && f2.body.n === 1 && same2 && f3.code === 400 && f3.body.error_code === 'ORPHAN_WORKER' && f4.code === 200 && f5.code === 500 && f5.body.error_code === 'WORKERS_READ_FAILED',
        info: [f1.code, f2.code, f2.body.error_code, same2, f3.code, f4.code, f5.code, f5.body.error_code] };
    },
    // ⑥ C107 backup_put: 관리자 세션 col:tasks 쓰기 = 403 BOT_KEY_ONLY(그대로) · 관리자 dry = 200·would_error BOT_KEY_ONLY · 관리자 audit 키 = 종전 RESTORE_MODE_ONLY(먼저) · 봇 키 + confirm = 200
    G: async (mod) => { reset86(); seedU86(); const c = caller86(mod);
      mem.gw_data['col:tasks'] = { schema: 1, items: [{ id: 't86' }], updated_at: 864 }; const s0 = JSON.stringify(mem.gw_data['col:tasks']);
      const b1 = await c({ action: 'backup_put', store: 'gw_data', key: 'col:tasks', data: { schema: 1, items: [] }, confirm: true }, tokA);
      const same1 = JSON.stringify(mem.gw_data['col:tasks']) === s0;
      const b2 = await c({ action: 'backup_put', store: 'gw_data', key: 'col:tasks', data: { schema: 1, items: [] }, dry: true }, tokA);
      const b3 = await c({ action: 'backup_put', store: 'gw_data', key: 'audit:2026-11', data: { schema: 1, items: [] }, confirm: true }, tokA);
      const b4 = await c({ action: 'backup_put', secret: 'test-ingest-key', store: 'gw_data', key: 'col:tasks', data: { schema: 1, items: [{ id: 't86b' }] }, confirm: true });
      return { ok: b1.code === 403 && b1.body.error_code === 'BOT_KEY_ONLY' && same1 && b2.code === 200 && b2.body.dry === true && b2.body.would_error === 'BOT_KEY_ONLY' && b2.body.restore_only === false
        && b3.code === 403 && b3.body.error_code === 'RESTORE_MODE_ONLY' && b4.code === 200 && mem.gw_data['col:tasks'].items[0].id === 't86b', info: [b1.code, b1.body.error_code, same1, b2.code, b2.body.would_error, b3.body.error_code, b4.code] };
    },
  };
  const KILL86 = {
    A: [['gwd', ', { maxOutputLength: BODY_GZ_MAX })', ')']],
    C: [['gwd', "prevDoc.updated_at && Number.isFinite(Number(prevDoc.updated_at)) && Number(d.base)", "prevDoc.updated_at && Number(d.base)"]],
    D: [['gwd', '    if (biz13N) return jr(400', '    if (false) return jr(400']],
    E: [['gwd', "  if (col === 'workers' && !wkExamSee(c.member) && Array.isArray(doc.items)) {\n    doc = ", "  if (false) {\n    doc = "], ['gwd', "  if (col === 'workers' && !wkExamSee(c.member)) {", '  if (false) {']],
    F: [['gwd', '      if (orphans.length) return jr(400', '      if (false) return jr(400']],   // v456 2차 검토: orphanN → orphans(고아 id 목록도 돌려줌 — 88 ③) · 같은 거절 줄 걷음
    G: [['gwd', "  if (!bot) return jr(403, { status: 'FORBIDDEN', error_code: 'BOT_KEY_ONLY'", "  if (false) return jr(403, { status: 'FORBIDDEN', error_code: 'BOT_KEY_ONLY'"]],
  };
  try {
    for (const k of Object.keys(chk86)) {
      R86[k] = await chk86[k](gwd);
      MUT86[k] = [];
      for (const [f, a, b] of KILL86[k]) { const x = await chk86[k](mut86(f, a, b)); MUT86[k].push(x.ok); }
    }
    const killed86 = (k) => MUT86[k].length > 0 && MUT86[k].every((v) => v === false);
    T('86 v456 ① C066 요청 gzip 풀기 상한: 풀면 40MB = 413 BODY_TOO_LARGE(종전 400 INVALID_JSON으로 뭉뚱그림) · 작은 gzip = 200 · 깨진 JSON = 400 INVALID_JSON · 결함 사본(maxOutputLength 걷음) ✗',
      R86.A.ok && killed86('A'), JSON.stringify({ A: R86.A.info, mut: MUT86.A }));
    // zip 항목 상한(docdiff zipEntries — 중앙 디렉터리 길): 풀면 70MB 항목 = null(비교 불가) · 작은 항목 = 그대로 · ZIP_ENTRY_MAX 64MB · 결함 사본(첫 inflate 상한 걷음) = 70MB 버퍼
    const DD86 = require(F86.dd);
    const bigZip = zip86([['big.xml', Buffer.alloc(70 * 1024 * 1024, 65), true], ['ok.xml', Buffer.from('<a>1</a>'), true]]);
    // v456 검토: 풀기는 zipBudget.inflate 한 줄로 모임(항목 상한 = min(ZIP_ENTRY_MAX, 남은 총량 예산)) — 결함 사본은 그 줄의 상한을 걷는다(같은 강도)
    const z1 = DD86.zipEntries(bigZip), zMut = mut86('dd', 'zlib.inflateRawSync(data, { maxOutputLength: cap })', 'zlib.inflateRawSync(data)').zipEntries(bigZip);
    // 정적: netlify/functions 아래 동기 압축 풀기 호출은 전부 maxOutputLength를 함께(같은 줄) · gw-data hwpxExtractText는 DD.ZIP_ENTRY_MAX
    const decomp86 = [];
    const walk86 = (d) => fs86.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk86(p); } else if (/\.js$/.test(e.name)) { fs86.readFileSync(p, 'utf8').split('\n').forEach((l) => { if (/\b(?:inflateRawSync|gunzipSync|inflateSync|unzipSync|brotliDecompressSync)\(/.test(l)) decomp86.push([e.name, /maxOutputLength/.test(l)]); }); } });
    walk86(FN);
    T('86 v456 ① C066 zip 항목 상한: 풀면 70MB 항목 = null · 작은 항목 그대로 · ZIP_ENTRY_MAX = 64MB · 정적: 함수 폴더 동기 압축 풀기 ' + decomp86.length + '곳 전부 maxOutputLength · hwpxExtractText = DD.zipBudget(항목 64MB·총량 예산 — 87) · 결함 사본(상한 걷음) = 70MB 버퍼 ✗',
      // v456 검토: 동기 풀기 자리는 4곳 → 2곳(docdiff zipBudget 한 곳 + 요청 gzip)으로 모임 — 전부 maxOutputLength는 그대로 · hwpxExtractText는 DD.zipBudget()(같은 예산)으로 풂(직접 inflate 0)
      z1['big.xml'] === null && z1['ok.xml'] && z1['ok.xml'].toString() === '<a>1</a>' && DD86.ZIP_ENTRY_MAX === 64 * 1024 * 1024 && decomp86.length >= 2 && decomp86.every((x) => x[1])
      && /const bud = DD\.zipBudget\(\);/.test(S86.gwd) && /method === 8 \? bud\.inflate\(data\) : bud\.take\(data\)/.test(S86.gwd) && !!zMut['big.xml'] && zMut['big.xml'].length === 70 * 1024 * 1024,
      JSON.stringify({ big: z1['big.xml'] === null, decomp86, mut: !!zMut['big.xml'] }));
    // ② C066 PII_RE 보강: 잡힘·안 잡힘 양쪽 고정(번호는 모두 시험용 꾸밈 값) · 회사 대표 전화·팩스(공개 번호)는 지역번호 꼴에서 뺌 · index.html 회사 tel·fax 상수 전부 PII_OWN_TEL에
    const LN86 = require(F86.ln);
    const HIT86 = ['9001011234567', '주민 9001015234567 끝', '900101-1234567', '900101 – 5234567', '900101－1234567', '010.1234.5678', '010—1234—5678', '010 1234 5678', '01012345678',
      '02-123-4567', '054-123-4567', '(054) 123-4567', '070-1234-5678', '031.123.4567', '02 1234 5678', '110 123 456789', '1002 123 456789', '12345678901', '110123456789', '12345678901234', '054-291-1203'];
    const PASS86 = ['계약일 2026-11-01 금액 12,500,000원 면적 45.75', '1234567890', '2026.11.13', '2026. 11. 13.', '0.14999994000000001', '1,234,567,890원', '2026-11-13 10:45', 'A1 B12 C123', '45 75 123', '20261113',
      '공사기간 2026-11-01 ~ 2026-12-31', '포항시 남구 1234-5', '시트!A34', '45.123456789012', '2026 11 13 10', '단가 12 500', '☎ (054)291-1202', '054-291-1204', '054)291-1214', '경상북도 포항시 남구 정몽주로 823-10(청림동)   ☎ (054)291-1202'];
    const pii86 = (L) => ({ miss: HIT86.filter((s) => L.piiScan(s).ok).length, fp: PASS86.filter((s) => !L.piiScan(s).ok).length });
    const p86 = pii86(LN86);
    const telC86 = [...readFileSyncFS86(join(ROOT, 'index.html')).matchAll(/(?:\btel|\bfax|"전화"|"팩스")\s*:\s*"([^"]+)"/g)].map((m) => m[1].replace(/\D/g, ''));
    const telOk86 = telC86.length >= 5 && telC86.every((d) => LN86.PII_OWN_TEL[d] === 1);
    // v456 검토: 11~14자리 꼴은 영문자·₩ 뒤·'원' 앞을 뺀 꼴(87절) — 결함 사본 첫째는 그 줄을 통째로 걷음(종전과 같은 강도)
    //   v456 2차 검토: PII_9 줄이 \d{11,}·확장자 예외·i 표시로 바뀜(88절) — 결함 사본은 그 줄을 통째로 걷음(같은 강도)
    const pMut86 = [pii86(mut86('ln', '  /(?<![\\dA-Za-z.₩])\\d{11,}(?!\\d|\\s*원|\\.(?:jpe?g|png|gif|heic|pdf|xlsx?|hwpx?|docx?|zip)\\b)/i];', '  ];')), pii86(mut86('ln', "PII_OWN_TEL[m.replace(/\\D/g, '')] ? ' ' : m", 'm')), pii86(mut86('ln', 'for (let i = 0; i < PII_RE.length; i++)', 'for (let i = 0; i < 4; i++)'))];   // 셋째 = 옛 꼴 넷만 보는 사본(종전 동작)
    const sites86 = [(fs86.readFileSync(join(FN, 'gw-learn-background.js'), 'utf8').match(/LN\.piiScan\(/g) || []).length, (S86.gwd.match(/LN\.piiScan\(/g) || []).length, (fs86.readFileSync(join(FN, '_lib/boxjudge.js'), 'utf8').match(/LN\.piiScan\(/g) || []).length];
    T('86 v456 ② C066 PII_RE: 붙여 쓴 주민·외국인번호·줄표 변형·점/긴 줄표/공백 휴대전화·지역번호 전화(구분자)·공백 계좌·구분자 없는 11~14자리 ' + HIT86.length + '꼴 잡힘 · 날짜·금액·10자리 맨숫자·소수·면적·셀 좌표·회사 대표 전화·팩스 ' + PASS86.length + '꼴 통과 · 옛 꼴 PII_0~3 그대로 · 앱 회사 tel·fax 상수 ' + telC86.length + '개 전부 예외 목록 · 쓰는 곳(학습 워커 3·gw-data 3·boxjudge 1) 그대로 · 결함 사본(11~14자리 걷음·회사 번호 예외 걷음·붙여 쓴 주민번호 걷음) ✗',
      p86.miss === 0 && p86.fp === 0 && LN86.PII_RE.length === 10 && String(LN86.PII_RE[0]) === String(/\d{6}\s*-\s*[1-4]\d{6}/) && telOk86 && sites86[0] === 3 && sites86[1] >= 3 && sites86[2] >= 1
      && pMut86[0].miss > 0 && pMut86[1].fp > 0 && pMut86[2].miss > 0, JSON.stringify({ p86, telOk86, tels: telC86.length, sites86, pMut86 }));
    T('86 v456 ③ C079 숫자 아닌 updated_at: 글자 시각 문서에 아무 base로 저장 = 200·updated_at 숫자로 고쳐 씀 · 그 뒤 낡은 base = 409 STALE_BASE(낙관락 다시 걸림)·맞는 base = 200 · 숫자 글자 "1000"은 종전처럼 비교(999 = 409·1000 = 200) · 결함 사본(유한 숫자 검사 걷음 = 매번 409) ✗',
      R86.C.ok && killed86('C'), JSON.stringify({ C: R86.C.info, mut: MUT86.C }));
    // ④ 물어보기 clients 도구: 13자리는 사업자번호 '13자리(숨김)'·원문 0 · 그 번호로 물으면 0행 · 10자리 번호로는 찾힘 · 결함 사본(가림 걷음) ✗
    const ASK86 = require(F86.ask);
    mem.gw_data['col:clients'] = { schema: 1, items: [{ id: 'c1', name: '갑', biz_no: '1234567890' }, { id: 'c2', name: '을', biz_no: '1111111111111' }], updated_at: 1 };
    const askChk86 = async (A) => { const q1 = await A.runTool('clients', {}, ADM86), q2 = await A.runTool('clients', { q: '1111111111111' }, ADM86), q3 = await A.runTool('clients', { q: '1234567890' }, ADM86);
      const r2 = (q1.rows || []).find((x) => x.상호 === '을') || {};
      return q1.count === 2 && r2.사업자번호 === '13자리(숨김)' && JSON.stringify(q1).indexOf('1111111111111') < 0 && q2.count === 0 && q3.count === 1; };
    const ask86 = await askChk86(ASK86), askMut86 = await askChk86(mut86('ask', ".map((c) => (c && CLIBIZ.biz13(c.biz_no)) ? Object.assign({}, c, { biz_no: '', _b13: true }) : c)", ''));
    const CB86 = require(join(FN, '_lib/clibiz.js'));
    T('86 v456 ④ C080 거래처 13자리: 새 거래처(전각·전각 줄표) = 400 CLI_BIZ13(n 1·저장 안 됨·응답에 번호 없음) · 서버에 있던 13자리 그대로 + 다른 줄 고침 = 200(옛 값이 저장을 막지 않음) · 있던 줄을 13자리로 바꿈 = 400 · 가린 번호·10자리·쉼표로 나눈 둘 = 200 · 물어보기 clients = "13자리(숨김)"·그 번호로 물으면 0행 · 결함 사본(서버 거절 걷음·물어보기 가림 걷음) ✗',
      R86.D.ok && killed86('D') && ask86 && !askMut86 && CB86.biz13('900101-1234567') && !CB86.biz13('900101-1******') && !CB86.biz13('123-45-67890'), JSON.stringify({ D: R86.D.info, mut: MUT86.D, ask86, askMut86 }));
    T('86 v456 ⑤ C082 ① 명부 옛 건강진단 exam: 안전 권한 없는 일용직 수행자 읽기 = exam 칸 없음 · 안전 보기·관리자 = 있음 · 그 사람 저장 = exam 서버 값 이월(보낸 값 버림·새 줄 exam 없음) · 안전 권한자 저장 = 반영 · 직전 명부 못 읽음 = 500 PREV_READ_FAILED(쓰지 않음) · 결함 사본(읽기 빼기 걷음·저장 이월 걷음) ✗',
      R86.E.ok && killed86('E'), JSON.stringify({ E: R86.E.info, mut: MUT86.E }));
    T('86 v456 ⑤ C082 ② 현장 대장 고아 일용직 id: 그 줄에 있던 명부 밖 id + 새 명부 id = 200 · 새 명부 밖 id = 400 ORPHAN_WORKER(n 1·저장 안 됨) · 새 줄 글자 "[...]" 모양도 400 · 지운 일용직(명부에 있음) = 200 · 새 id 있는데 명부 못 읽음 = 500 WORKERS_READ_FAILED · 결함 사본(거절 걷음) ✗',
      R86.F.ok && killed86('F'), JSON.stringify({ F: R86.F.info, mut: MUT86.F }));
    T('86 v456 ⑥ C107 backup_put 쓰기는 봇 키만: 관리자 세션 col:tasks confirm = 403 BOT_KEY_ONLY(그대로) · 관리자 dry = 200·would_error BOT_KEY_ONLY · 관리자 audit 키 = 종전 RESTORE_MODE_ONLY 먼저 · 봇 키 + confirm = 200 · 결함 사본(관문 걷음) ✗',
      R86.G.ok && killed86('G'), JSON.stringify({ G: R86.G.info, mut: MUT86.G }));
    // 호출처 전수(정적): 앱 index.html에 backup_put 0 · appdata restore.py·logsheet_daily.py의 backup_put 본문은 전부 secret(봇 키)
    const ixBp86 = (readFileSyncFS86(join(ROOT, 'index.html')).match(/backup_put/g) || []).length;
    const ad86 = join(ROOT, '..', 'jongwoon-appdata', 'collectors');
    // v456 검토: appdata 폴더가 없으면 통과로 세지 않고 '생략'으로 알림(종전엔 없어도 통과) · tools/*.mjs 쪽은 87
    const adHas86 = fs86.existsSync(ad86);
    const adOk86 = adHas86 && ['restore.py', 'logsheet_daily.py'].every((f) => { const t = fs86.readFileSync(join(ad86, f), 'utf8'); const bodies = t.split('\n').filter((l) => /"action": "backup_put"/.test(l)); return bodies.length >= 1 && bodies.every((l) => /"secret"/.test(l)); });
    if (!adHas86) console.log('  (86 ⑥ appdata 호출처 정적 검사 생략 — ' + ad86 + ' 없음 · 앱 index.html backup_put ' + ixBp86 + ')');
    else T('86 v456 ⑥ C107 호출처 전수(정적): 앱 index.html backup_put 0 · appdata restore.py·logsheet_daily.py backup_put 요청 줄 전부 봇 키(secret)', ixBp86 === 0 && adOk86, JSON.stringify({ ixBp86, adOk86 }));
    // ⑦ C108 gw-cron-kick·gw-lawwatch 상수시간 비교 — 같은 길이 다른 키·다른 길이·env 비움 = 403 · 맞는 키 = 다음 검사로(cron-kick BAD_TARGET 400 · lawwatch NO_ALERTS 400) · 소스 '!==/=== secret' 0·_lib/keymatch botKeyOk · 공용 keyMatch = gw-data keyMatch 같은 결과
    const kick86 = require(join(FN, 'gw-cron-kick.js')), lw86 = require(join(FN, 'gw-lawwatch.js')), KM86 = require(join(FN, '_lib/keymatch.js'));
    const kc = async (key) => { const r = await kick86.handler({ body: JSON.stringify({ key: key, target: 'nope' }) }, {}); return r.statusCode; };
    const lc = async (key, hdr) => { const r = await lw86.handler({ httpMethod: 'POST', headers: hdr ? { 'x-ingest-key': key } : {}, body: JSON.stringify(hdr ? {} : { key: key }) }); return r.statusCode; };
    const savedK86 = process.env.BIDS_INGEST_KEY;
    const kr = [await kc('test-ingest-kez'), await kc('short'), await kc(''), await kc(' test-ingest-key '), await lc('test-ingest-kez'), await lc('short', true), await lc('test-ingest-key', true), await lc('test-ingest-key')];
    process.env.BIDS_INGEST_KEY = ''; const kr0 = [await kc(''), await lc('', true)]; process.env.BIDS_INGEST_KEY = savedK86;
    const srcK86 = fs86.readFileSync(join(FN, 'gw-cron-kick.js'), 'utf8'), srcL86 = fs86.readFileSync(join(FN, 'gw-lawwatch.js'), 'utf8');
    const stat86 = (s) => !/[!=]==\s*secret\b/.test(s) && /require\('\.\/_lib\/keymatch'\)/.test(s) && /botKeyOk\(/.test(s) && !/process\.env\.BIDS_INGEST_KEY/.test(s);
    const gwKm86 = load86(F86.gwd, S86.gwd + '\nexports.__km86 = keyMatch;').__km86;
    const KS86 = [['k', 'k'], [' k ', 'k'], ['k', ''], ['', ''], ['kk', 'k'], ['k', 'kk'], [null, 'k'], ['abc', 'abd']];
    const same86 = KS86.every(([g, s]) => KM86.keyMatch(g, s) === gwKm86(g, s));
    const oldK86 = srcK86.replace('  if (!botKeyOk(d.key))', "  const secret = (process.env.BIDS_INGEST_KEY || '').trim();\n  if (!secret || String(d.key || '').trim() !== secret)");
    T('86 v456 ⑦ C108 gw-cron-kick·gw-lawwatch 상수시간 비교: 같은 길이 다른 키·다른 길이·빈 키 = 403 · 앞뒤 공백 키 = 통과(다음 검사 400) · 헤더 키 맞음 = 400 NO_ALERTS · env 비움 = 403 · 소스 "!==/=== secret" 0·_lib/keymatch botKeyOk·env 직접 읽기 0 · 공용 keyMatch = gw-data keyMatch(표본 8 같은 결과) · 결함 사본(옛 비교) = 정적 ✗',
      JSON.stringify(kr) === JSON.stringify([403, 403, 403, 400, 403, 403, 400, 400]) && JSON.stringify(kr0) === '[403,403]' && stat86(srcK86) && stat86(srcL86) && same86 && !stat86(oldK86),
      JSON.stringify({ kr, kr0, sK: stat86(srcK86), sL: stat86(srcL86), same86, old: stat86(oldK86) }));
    // ⑧ T427 간극 분모·cellRows 병합 비앵커 · 짝 찾기 점수는 종전 식 그대로
    const FIN86 = xlsx86('<c r="A1" t="inlineStr"><is><t>가</t></is></c><c r="A4" t="inlineStr"><is><t>고침</t></is></c><c r="C1" t="inlineStr"><is><t>앵커</t></is></c><c r="D1" t="inlineStr"><is><t>비앵커</t></is></c>', 'C1:D2');
    const ED86 = [['A1', '가', 's'], ['A2', '', 'b'], ['A3', '', 's'], ['A4', '', 'b'], ['D1', 'x', 's'], ['C1', '앵커', 's']];
    const t427 = (D) => { const x = D.xlsxCellDiff(ED86, FIN86), cr = D.cellRows(ED86, FIN86, ['A1', 'D1', 'C1']), ms = D.matchScore({ fill: { edits: ED86 } }, 'xlsx', 'xlsx', FIN86);
      return { x: [x.compared, x.changed, x.blank_both, x.uncomparable, x.ratio], rows: cr.rows.map((r) => r.ref).join(), ms }; };
    const tq = t427(DD86);
    const tqM = [t427(mut86('dd', "    if ((ty === 'b' || normS(want) === '') && normS(f.v) === '') { blankBoth++; return; }\n", '')), t427(mut86('dd', " || inMergedNonAnchor(sr.ref, sh.merged)) return;   // v456(T427)", ') return;   // v456(T427)'))];
    T('86 v456 ⑧ T427 간극: 초안 빈칸·최종본 빈칸 2칸(A2 b·A3 빈 값)은 분모 밖(blank_both 2) → 비교 3·바뀜 1(A4)·비교 불가 1(병합 비앵커 D1)·비율 0.333 · cellRows는 병합 비앵커 D1 뺌(A1·C1만) · 짝 찾기 점수 = 종전 식(빈칸↔빈칸 = 같은 칸) 1 − 1/5 = 0.8 · 결함 사본(빈칸 빼기 걷음 = 비율 0.2·cellRows 비앵커 걷음 = D1 들어감) ✗',
      JSON.stringify(tq.x) === '[3,1,2,1,0.333]' && tq.rows === 'A1,C1' && tq.ms === 0.8 && JSON.stringify(tqM[0].x) !== JSON.stringify(tq.x) && tqM[1].rows !== 'A1,C1', JSON.stringify({ tq, tqM }));
  } finally { reset86(); delete blobsMock.hooks.failGet; }
  function readFileSyncFS86(p) { return fs86.readFileSync(p, 'utf8'); }
}

{ // ---- 87(v456 검토 반영 11/13) — ① zip 총량 예산·겹친 항목·항목 수(docdiff zipBudget·zipEntries · gw-data hwpxExtractText) ② PII 정규화(전각·폭 없는 문자)·주민번호 구분자·11~14자리 오탐(영문자·₩ 뒤·'원' 앞)
  //   ③ 숫자 아닌 updated_at 앞 base 0 = 409(handleSave·휴지통) · 휴지통 글자 시각 = 비교 건너뜀 ④ 간극 식 판 gv(기준선·일몰은 같은 판 칸 비교 간극만) ⑤ 호출처·lawwatch 옛 비교 정적.
  //   검사마다 고친 자리를 되돌린 사본(메모리 컴파일 — 파일은 쓰지 않음)에서는 실패해야 한다. 실패 글에 번호 값은 싣지 않는다.
  const fs87 = require('fs'), Mod87 = require('module'), zlib87 = require('zlib');
  const load87 = (file, src) => { const m = new Mod87(file); m.filename = file; m.paths = Mod87._nodeModulePaths(dirname(file)); m._compile(src, file); return m.exports; };
  const F87 = { gwd: join(FN, 'gw-data.js'), dd: join(FN, '_lib/docdiff.js'), ln: join(FN, '_lib/learn.js') };
  const S87 = {}; Object.keys(F87).forEach((k) => { S87[k] = fs87.readFileSync(F87[k], 'utf8'); });
  const mut87 = (k, from, to, extra) => { if (S87[k].split(from).length !== 2) throw new Error('결함 자리가 한 곳이 아님: ' + from.slice(0, 60)); return load87(F87[k], S87[k].replace(from, () => to) + (extra || '')); };
  const snap87 = JSON.stringify({ u: mem.gw_users, d: mem.gw_data });
  const reset87 = () => { const s = JSON.parse(snap87); mem.gw_users = s.u; mem.gw_data = s.d; };
  // zip 작성기 — 항목 [이름, 원본 Buffer|null, deflate, 로컬 헤더 재사용 번호(겹친 항목)]
  const zip87 = (entries) => { const locals = [], cds = [], offs = []; let off = 0;
    for (const [name, raw, defl, reuse] of entries) { const nb = Buffer.from(name); let lo, csz, usz, mth;
      if (reuse !== undefined) { lo = offs[reuse][0]; csz = offs[reuse][1]; usz = offs[reuse][2]; mth = offs[reuse][3]; }
      else { const db = defl ? zlib87.deflateRawSync(raw, { level: 9 }) : raw; mth = defl ? 8 : 0; csz = db.length; usz = raw.length; lo = off;
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(mth, 8); lh.writeUInt32LE(csz, 18); lh.writeUInt32LE(usz, 22); lh.writeUInt16LE(nb.length, 26);
        locals.push(lh, nb, db); off += 30 + nb.length + db.length; }
      offs.push([lo, csz, usz, mth]);
      const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(mth, 10); cd.writeUInt32LE(csz, 20); cd.writeUInt32LE(usz, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(lo, 42);
      cds.push(cd, nb); }
    const cdb = Buffer.concat(cds), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Math.min(entries.length, 65535), 8); eocd.writeUInt16LE(Math.min(entries.length, 65535), 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cdb, eocd]); };
  const MB87 = 1024 * 1024;
  try {
    // ① zip — (가) 겹친 항목: 60MB 로컬 1개를 중앙 디렉터리 20줄이 가리킴 = 푼 것 1개 (나) 서로 다른 16MB 항목 10개(풀면 160MB) = 총량 128MB 안에서 8개·나머지 null
    //   (다) 저장 항목 2100개 = 2000개까지 (라) hwpxExtractText 16MB 섹션 10개 = 글 길이 ≤ 128MB · 결함 사본(겹침 막기 걷음·총량 걷음·항목 수 걷음·hwpx 직접 풀기) ✗
    const DD87 = require(F87.dd);
    const zA = zip87([['x0.xml', Buffer.alloc(60 * MB87, 65), true]].concat(Array.from({ length: 19 }, (_, i) => ['x' + (i + 1) + '.xml', null, true, 0])));
    const zB = zip87(Array.from({ length: 10 }, (_, i) => ['b' + i + '.xml', Buffer.alloc(16 * MB87, 66 + i), true]));
    const zC = zip87(Array.from({ length: 2100 }, (_, i) => ['c' + i + '.txt', Buffer.from('c'), false]));
    const zH = zip87(Array.from({ length: 10 }, (_, i) => ['Contents/section' + i + '.xml', Buffer.alloc(16 * MB87, 72), true]));
    const sumOf = (o) => Object.keys(o).reduce((s, k) => s + (o[k] ? o[k].length : 0), 0), liveOf = (o) => Object.keys(o).filter((k) => o[k]).length;
    const zipChk = (D) => { const a = D.zipEntries(zA); const ra = [liveOf(a), sumOf(a)]; const b = D.zipEntries(zB); const rb = [liveOf(b), sumOf(b), Object.keys(b).length]; const c = D.zipEntries(zC); return { a: ra, b: rb, c: Object.keys(c).length }; };
    const zr = zipChk(DD87);
    const zOk = zr.a[0] === 1 && zr.a[1] === 60 * MB87 && zr.b[0] === 8 && zr.b[1] <= DD87.ZIP_TOTAL_MAX && zr.b[2] === 10 && zr.c === DD87.ZIP_ENTRIES_MAX && DD87.ZIP_TOTAL_MAX === 128 * MB87 && DD87.ZIP_ENTRIES_MAX === 2000;
    const zM = [zipChk(mut87('dd', '!skip(name) && !seenLho[lho] && ', '!skip(name) && ')), zipChk(mut87('dd', 'const cap = Math.min(ZIP_ENTRY_MAX, ZIP_TOTAL_MAX - used);', 'const cap = ZIP_ENTRY_MAX;')),
      zipChk(mut87('dd', 'const n = Math.min(buf.readUInt16LE(eocd + 10), ZIP_ENTRIES_MAX)', 'const n = buf.readUInt16LE(eocd + 10)'))];
    const zKill = zM[0].a[0] > 1 && zM[1].b[0] === 10 && zM[2].c === 2100;
    const hx = load87(F87.gwd, S87.gwd + '\nexports.__hx87 = hwpxExtractText;').__hx87(zH).length;
    const hxM = mut87('gwd', 'method === 8 ? bud.inflate(data) : bud.take(data)', "method === 8 ? require('zlib').inflateRawSync(data, { maxOutputLength: DD.ZIP_ENTRY_MAX }) : data", '\nexports.__hx87 = hwpxExtractText;').__hx87(zH).length;
    T('87 v456 검토 ① zip 총량 예산: 겹친 항목(60MB 로컬 1개 ← 중앙 디렉터리 20줄) = 1개만 풂 · 서로 다른 16MB 항목 10개 = 8개(128MB 안)·나머지 null · 저장 항목 2100개 = 2000개까지 · hwpxExtractText 16MB 섹션 10개 = 글 ≤ 128MB · 결함 사본(겹침 막기·총량·항목 수·hwpx 직접 풀기) ✗',
      zOk && zKill && hx > 0 && hx <= 128 * MB87 + 64 && hxM > 128 * MB87, JSON.stringify({ zr, zM: zM.map((m) => [m.a[0], m.b[0], m.c]), hxMB: Math.round(hx / MB87), hxMMB: Math.round(hxM / MB87) }));
    // ② PII — 새로 잡는 꼴(검토 6꼴 + ₩ 없는 계좌 등)·새로 통과하는 꼴(쉼표 없는 금액·영문자 뒤 아이디·파일 이름 시각·₩ 금액) · 결함 사본(정규화 걷음·주민번호 구분자 걷음·11~14자리 옛 꼴) ✗
    const LN87 = require(F87.ln);
    const HIT87 = ['900101 1234567', '900101.1234567', '900101/1234567', '900101_1234567', '900101​1234567', '９００１０１－１２３４５６７', '０１０－１２３４－５６７８', '010​1234​5678', '９００１０１１２３４５６７', '계좌 110123456789 입금'];
    const PASS87 = ['계약금액 15000000000원', '계약금액 15000000000 원', '{"id":"d1731456789012"}', 'F202611131530.xlsx', '₩15000000000', '2026.11.13 10:45', '면적 1,234.5㎡ · ① 항목', '시트!A34 45.123456789012'];
    const pii87 = (L) => ({ miss: HIT87.filter((s) => L.piiScan(s).ok).length, fp: PASS87.filter((s) => !L.piiScan(s).ok).length });
    const p87 = pii87(LN87);
    const pM87 = [pii87(mut87('ln', '  s = piiNorm(s).replace(PII_OWN_RE,', '  s = String(s).replace(PII_OWN_RE,')), pii87(mut87('ln', '(?:0[1-9]|[12]\\d|3[01])[\\s./_]*[1-8]\\d{6}(?!\\d)/,', '(?:0[1-9]|[12]\\d|3[01])[1-8]\\d{6}(?!\\d)/,')),
      pii87(mut87('ln', '  /(?<![\\dA-Za-z.₩])\\d{11,}(?!\\d|\\s*원|\\.(?:jpe?g|png|gif|heic|pdf|xlsx?|hwpx?|docx?|zip)\\b)/i];', '  /(?<![\\d.])\\d{11,14}(?!\\d)/];'))];   // v456 2차 검토: 지금 줄(88절) → 옛 꼴
    T('87 v456 검토 ② PII: 공백·점·빗금·밑줄·폭 없는 문자로 나눈 주민번호·전각 주민번호·전각 휴대전화·폭 없는 문자 휴대전화·계좌 ' + HIT87.length + '꼴 잡힘 · 쉼표 없는 금액(원·₩)·영문자 뒤 아이디·파일 이름 시각·①·㎡ ' + PASS87.length + '꼴 통과 · 결함 사본(정규화 걷음 = 전각 샘·주민번호 구분자 걷음 = 샘·11~14자리 옛 꼴 = 오탐) ✗',
      p87.miss === 0 && p87.fp === 0 && pM87[0].miss > 0 && pM87[1].miss > 0 && pM87[2].fp > 0, JSON.stringify({ p87, pM87 }));
    // ③ 숫자 아닌 updated_at — handleSave: base 0 = 409 · 글자 base = 200(숫자로 고침) · 휴지통(doc_restore): 글자 시각 + 글자 base = 200·숫자로 고침 · base 0 = 409 · 결함 사본(두 base 0 줄 걷음·휴지통 유한 검사 걷음) ✗
    const chkC87 = async (mod) => { reset87(); const c = async (body) => { const r = await mod.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA }, body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
      const TS = '2026-11-11T00:00:00Z';
      mem.gw_data['col:vehicles'] = { schema: 1, items: [{ id: 'v87', no: '87가' }], updated_at: TS };
      const s0 = await c({ action: 'save', collection: 'vehicles', base: 0, doc: { schema: 1, items: [] } }), kept = mem.gw_data['col:vehicles'].items.length === 1;
      const s1 = await c({ action: 'save', collection: 'vehicles', base: TS, doc: { schema: 1, items: [{ id: 'v87', no: '87나' }] } }), num1 = typeof mem.gw_data['col:vehicles'].updated_at === 'number';
      mem.gw_data['col:documents'] = { schema: 1, items: [{ id: 'd87', title: '휴지통 87', cat: '02-01', del: 1, deleted_at: new Date().toISOString(), deleted_by: { id: 'uadmin', name: '관리자' } }], updated_at: TS };
      const t0 = await c({ action: 'doc_restore', id: 'd87', base: 0 }), still = mem.gw_data['col:documents'].items[0].del === 1;
      const t1 = await c({ action: 'doc_restore', id: 'd87', base: TS }), num2 = typeof mem.gw_data['col:documents'].updated_at === 'number' && mem.gw_data['col:documents'].items[0].del === undefined;
      return { ok: s0.code === 409 && s0.body.error_code === 'STALE_BASE' && kept && s1.code === 200 && num1 && t0.code === 409 && still && t1.code === 200 && num2, info: [s0.code, kept, s1.code, num1, t0.code, still, t1.code, num2] };
    };
    const rC87 = await chkC87(gwd);
    const mC87 = [await chkC87(mut87('gwd', "  if (d.base !== undefined && prevDoc && prevDoc.updated_at && !Number.isFinite(Number(prevDoc.updated_at)) && Number(d.base) === 0)\n", '  if (false)\n')),
      await chkC87(mut87('gwd', "  if (d.base !== undefined && doc.updated_at && !Number.isFinite(Number(doc.updated_at)) && Number(d.base) === 0) return", '  if (false) return')),
      await chkC87(mut87('gwd', "  if (d.base !== undefined && doc.updated_at && Number.isFinite(Number(doc.updated_at)) && Number(d.base) !== Number(doc.updated_at)) return", '  if (d.base !== undefined && doc.updated_at && Number(d.base) !== Number(doc.updated_at)) return'))];
    T('87 v456 검토 ③ 숫자 아닌 updated_at: 저장 base 0(GET 못 받은 기기) = 409 STALE_BASE·서버 문서 그대로 · 그 글자 base = 200·숫자로 고침 · 휴지통 복구 base 0 = 409·글자 base = 200·숫자로 고침 · 결함 사본(저장 base 0 줄 걷음·휴지통 base 0 줄 걷음·휴지통 유한 검사 걷음) ✗',
      rC87.ok && mC87.every((m) => !m.ok), JSON.stringify({ C: rC87.info, mut: mC87.map((m) => m.info) }));
    // ④ 간극 식 판 — 옛 칸 비교 간극(gv 없음) 10 + 새 9 = 기준선 없음 · 새 1 더 = 기준선(새 10건 평균) · 문단 비교 간극은 판 없이도 셈 · 정적: gw-data 짝 간극 gv·워커 gv · 결함 사본(판 거르기 걷음) ✗
    const gapL87 = (L) => { const old = Array.from({ length: 10 }, (_, i) => ({ pair: 'o' + i, kind: 'xlsx_cell', ratio: 0.9, ts: 100 + i })); const nw = Array.from({ length: 9 }, (_, i) => ({ pair: 'n' + i, kind: 'xlsx_cell', ratio: 0.2, gv: L.GAP_VER, ts: 200 + i }));
      const A = { gaps: old.concat(nw) }; L.freezeBaseline(A, 1000); const B = { gaps: old.concat(nw, [{ pair: 'n9', kind: 'xlsx_cell', ratio: 0.2, gv: L.GAP_VER, ts: 300 }]) }; L.freezeBaseline(B, 1000);
      const H = { gaps: Array.from({ length: 10 }, (_, i) => ({ pair: 'h' + i, kind: 'hwpx_para', ratio: 0.5, ts: 100 + i })) }; L.freezeBaseline(H, 1000);
      return [!A.baseline, B.baseline ? Math.round(B.baseline.avg * 1000) / 1000 : null, B.baseline ? B.baseline.pairs.indexOf('o0') : null, H.baseline ? H.baseline.n : 0]; };
    const g87 = gapL87(LN87), gM87 = gapL87(mut87('ln', " && !(x.kind === 'xlsx_cell' && Number(x.gv) !== GAP_VER)", ''));
    const wk87 = fs87.readFileSync(join(FN, 'gw-learn-background.js'), 'utf8');
    const gStat87 = /comparable: gap\.comparable, late: pick\.late \? 1 : 0, gv: LN\.GAP_VER \}, now\);/.test(S87.gwd) && /gv: \(pair\.diff && typeof pair\.diff\.blank_both === 'number'\) \? LN\.GAP_VER : 1,/.test(wk87) && LN87.GAP_VER === 2;
    T('87 v456 검토 ④ 간극 식 판(T427): 옛 칸 비교 간극 10 + 새 9 = 기준선 없음 · 새 10 = 기준선 0.2(옛 간극 빠짐) · 문단 비교 간극 10 = 판 없이 기준선 · gw-data 짝 간극 gv·워커 gv(diff에 blank_both면 2) · 결함 사본(판 거르기 걷음 = 옛 간극으로 기준선) ✗',
      JSON.stringify(g87) === '[true,0.2,-1,10]' && gStat87 && JSON.stringify(gM87) !== JSON.stringify(g87), JSON.stringify({ g87, gM87, gStat87 }));
    // ⑤ 호출처·옛 비교 정적: 앱 index.html backup_put 0 · tools/*.mjs 중 servertest·uismoke 밖 backup_put 0 · gw-lawwatch 옛 비교 사본은 정적 검사에서 ✗(86 ⑦은 cron-kick만 심었음)
    const ixBp87 = (fs87.readFileSync(join(ROOT, 'index.html'), 'utf8').match(/backup_put/g) || []).length;
    const toolBp87 = fs87.readdirSync(join(ROOT, 'tools')).filter((f) => /\.(mjs|js|py|ps1)$/.test(f) && f !== 'servertest.mjs' && f !== 'uismoke.mjs').filter((f) => /backup_put/.test(fs87.readFileSync(join(ROOT, 'tools', f), 'utf8')));
    const stat87 = (s) => !/[!=]==\s*secret\b/.test(s) && /require\('\.\/_lib\/keymatch'\)/.test(s) && /botKeyOk\(/.test(s) && !/process\.env\.BIDS_INGEST_KEY/.test(s);
    const srcL87 = fs87.readFileSync(join(FN, 'gw-lawwatch.js'), 'utf8');
    if (srcL87.split('  if (!botKeyOk(got))').length !== 2) throw new Error('lawwatch 결함 자리 없음');
    const oldL87 = srcL87.replace('  if (!botKeyOk(got))', "  const secret = (process.env.BIDS_INGEST_KEY || '').trim();\n  if (!secret || String(got).trim() !== secret)");
    T('87 v456 검토 ⑤ 호출처·옛 비교 정적: 앱 index.html backup_put 0 · tools 폴더(servertest·uismoke 밖) backup_put 0 · gw-lawwatch 지금 = 상수시간 · lawwatch 옛 비교 사본 = 정적 ✗',
      ixBp87 === 0 && toolBp87.length === 0 && stat87(srcL87) && !stat87(oldL87), JSON.stringify({ ixBp87, toolBp87, now: stat87(srcL87), old: stat87(oldL87) }));
  } catch (e) { T('87 v456 검토 반영 묶음 실행', false, String(e && e.message)); } finally { reset87(); }
}

{ // ---- 88(v456 2차 검토 11/13) — ① docdiff: 같은 Buffer는 한 번만 풂(WeakMap)·통합 문서 칸 상한 XLSX_CELLS_MAX ② PII: 가운뎃점·15자리 이상·파일 이름 확장자 ③ 400 ORPHAN_WORKER 고아 id 목록
  //   ④ 동기 압축 풀기 자리 고정(정적 — docdiff zipBudget 1곳·gw-data parseBody gunzip 1곳) ⑤ appdata autotask --selftest(폴더·python 있을 때).
  //   검사마다 고친 자리를 되돌린 사본(메모리 컴파일 — 파일은 쓰지 않음)에서는 실패해야 한다. 실패 글에 번호 값은 싣지 않는다.
  const fs88 = require('fs'), Mod88 = require('module'), zlib88 = require('zlib'), cp88 = require('child_process');
  const load88 = (file, src) => { const m = new Mod88(file); m.filename = file; m.paths = Mod88._nodeModulePaths(dirname(file)); m._compile(src, file); return m.exports; };
  const F88 = { gwd: join(FN, 'gw-data.js'), dd: join(FN, '_lib/docdiff.js'), ln: join(FN, '_lib/learn.js') };
  const S88 = {}; Object.keys(F88).forEach((k) => { S88[k] = fs88.readFileSync(F88[k], 'utf8'); });
  const mut88 = (k, from, to) => { if (S88[k].split(from).length !== 2) throw new Error('결함 자리가 한 곳이 아님: ' + from.slice(0, 60)); return load88(F88[k], S88[k].replace(from, () => to)); };
  const snap88 = JSON.stringify({ u: mem.gw_users, d: mem.gw_data });
  const reset88 = () => { const s = JSON.parse(snap88); mem.gw_users = s.u; mem.gw_data = s.d; };
  const zip88 = (entries) => { const locals = [], cds = []; let off = 0;
    for (const [name, raw] of entries) { const nb = Buffer.from(name), db = zlib88.deflateRawSync(raw, { level: 9 });
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
      const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(off, 42);
      locals.push(lh, nb, db); cds.push(cd, nb); off += 30 + nb.length + db.length; }
    const cdb = Buffer.concat(cds), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cdb, eocd]); };
  const xlsx88 = (sheet, shared) => zip88([['xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')], ['xl/worksheets/sheet1.xml', Buffer.from(sheet)]].concat(shared ? [['xl/sharedStrings.xml', Buffer.from(shared)]] : []));
  try {
    // ① (가) 같은 폭탄 최종본(같은 칸 20MB)으로 matchScore 12번 + xlsxCellDiff 1번 = 큰 풀기 1번(종전 13번) · hwpxParas 같은 Buffer 두 번 = 같은 결과 객체
    //   (나) 서로 다른 칸 XLSX_CELLS_MAX개 = ok · 1개 더 = ok:false TOO_MANY_CELLS · 공유 문자열이 상한을 넘어도 TOO_MANY_CELLS · 결함 사본(메모 걷음 = 13번 · hwpx 메모 걷음 · 칸 세기 걷음 = ok) ✗
    const cellA = '<c r="A1" t="inlineStr"><is><t>x</t></is></c>';
    const bomb = xlsx88('<worksheet><sheetData><row r="1">' + cellA.repeat(Math.floor(20 * 1024 * 1024 / cellA.length)) + '</row></sheetData></worksheet>');
    const recF = { fill: { edits: { S: [['A1', 'x', 's']] } } };
    const bigCount = (D) => { const orig = zlib88.inflateRawSync; let n = 0; zlib88.inflateRawSync = function () { const r = orig.apply(this, arguments); if (r.length > 1024 * 1024) n++; return r; };
      try { const fb = Buffer.from(bomb); for (let i = 0; i < 12; i++) D.matchScore(recF, 'xlsx', 'xlsx', fb); D.xlsxCellDiff([['S!A1', 'x', 's']], fb); } finally { zlib88.inflateRawSync = orig; } return n; };
    const DD88 = require(F88.dd);
    const n1 = bigCount(DD88), nM = bigCount(mut88('dd', 'function xlsxCells(buf) { return memoBuf(MEMO_XLSX, buf, xlsxCellsRaw); }', 'function xlsxCells(buf) { return xlsxCellsRaw(buf); }'));
    const hz = zip88([['Contents/section0.xml', Buffer.from('<hp:p><hp:t>가</hp:t></hp:p>')]]);
    const hSame = DD88.hwpxParas(hz) === DD88.hwpxParas(hz), hM = mut88('dd', 'function hwpxParas(buf) { return memoBuf(MEMO_HWPX, buf, hwpxParasRaw); }', 'function hwpxParas(buf) { return hwpxParasRaw(buf); }');
    const hSameM = hM.hwpxParas(hz) === hM.hwpxParas(hz);
    const cells = (n) => { const p = []; for (let i = 1; i <= n; i++) p.push('<c r="A' + i + '"><v>1</v></c>'); return '<worksheet><sheetData><row r="1">' + p.join('') + '</row></sheetData></worksheet>'; };
    const MAXC = DD88.XLSX_CELLS_MAX, xOk = xlsx88(cells(MAXC)), xOver = xlsx88(cells(MAXC + 1));
    const xSS = xlsx88(cells(1), '<sst>' + '<si><t>s</t></si>'.repeat(MAXC + 1) + '</sst>');
    const capChk = (D) => { const a = D.xlsxCells(Buffer.from(xOk)), b = D.xlsxCells(Buffer.from(xOver)), c = D.xlsxCells(Buffer.from(xSS)); return [a.ok, b.ok ? 'ok' : b.code, c.ok ? 'ok' : c.code]; };
    const cap = capChk(DD88), capM = capChk(mut88('dd', '    if (cnt && ++cnt.n > XLSX_CELLS_MAX) break;\n', ''));
    T('88 v456 2차 검토 ① docdiff: 같은 폭탄 최종본으로 matchScore 12번 + xlsxCellDiff = 큰 풀기 1번(WeakMap) · hwpxParas 같은 Buffer = 같은 결과 · 통합 문서 칸 ' + MAXC + '개 = ok · 1개 더·공유 문자열 상한 넘음 = TOO_MANY_CELLS · 결함 사본(메모 걷음 = 13번 · hwpx 메모 걷음 · 칸 세기 걷음 = ok) ✗',
      n1 === 1 && nM === 13 && hSame && !hSameM && MAXC === 200000 && JSON.stringify(cap) === '[true,"TOO_MANY_CELLS","TOO_MANY_CELLS"]' && capM[1] === 'ok', JSON.stringify({ n1, nM, hSame, hSameM, cap, capM }));
    // ② PII(번호는 모두 시험용 꾸밈 값): 가운뎃점(· ・ ∙ •, 앞뒤 띄어쓰기 포함)으로 나눈 주민번호·휴대전화·지역번호 · 16자리·20자리 이어진 숫자 · 가운뎃점 뒤 계좌 = 잡힘
    //   파일 이름 시각(밑줄·띄어쓰기·대문자 확장자 뒤) · 가운뎃점 날짜·소수 = 통과 · 결함 사본(가운뎃점 정규화 걷음·위 상한 {11,14}로 되돌림·확장자 예외 걷음) ✗
    const MD88 = String.fromCharCode(0xB7, 0x30FB, 0x2219, 0x2022), dot = String.fromCharCode(0xB7), kdot = String.fromCharCode(0x30FB), bdot = String.fromCharCode(0x2219), blt = String.fromCharCode(0x2022);
    const HIT88 = ['900101' + dot + '1234567', '900101 ' + kdot + ' 1234567', '010' + dot + '1234' + dot + '5678', '010 ' + bdot + ' 1234 ' + bdot + ' 5678', '054' + blt + '123' + blt + '4567', '카드 1234567812345678', '12345678901234567890', '계좌' + dot + '12345678901234'];
    const PASS88 = ['사진_20261113153012.jpg', 'scan_202611131530.pdf', '현장 202611131530.JPG', '보고서_202611131530.hwpx', '안전 ' + dot + ' 품질 ' + dot + ' 2026' + dot + '11' + dot + '13', '45' + dot + '123456789012', '계약금액 1500000000000000원'];
    const pii88 = (L) => ({ miss: HIT88.filter((s) => L.piiScan(s).ok).length, fp: PASS88.filter((s) => !L.piiScan(s).ok).length });
    const p88 = pii88(require(F88.ln));
    const pM88 = [pii88(mut88('ln', "\n    .replace(/(\\d)\\s*[" + MD88 + "]\\s*(?=\\d)/g, '$1.').replace(/[" + MD88 + "]/g, ' ');", ';')), pii88(mut88('ln', '\\d{11,}(?!\\d|', '\\d{11,14}(?!\\d|')),
      pii88(mut88('ln', '|\\.(?:jpe?g|png|gif|heic|pdf|xlsx?|hwpx?|docx?|zip)\\b)/i];', ')/i];'))];
    T('88 v456 2차 검토 ② PII: 가운뎃점(앞뒤 띄어쓰기 포함) 주민번호·휴대전화·지역번호 · 16·20자리 · 가운뎃점 뒤 계좌 ' + HIT88.length + '꼴 잡힘 · 밑줄·띄어쓰기·대문자 확장자 파일 이름 시각·가운뎃점 날짜·소수·원 금액 ' + PASS88.length + '꼴 통과 · 결함 사본(가운뎃점 정규화 걷음·위 상한 {11,14}·확장자 예외 걷음) ✗',
      p88.miss === 0 && p88.fp === 0 && pM88[0].miss > 0 && pM88[1].miss > 0 && pM88[2].fp > 0, JSON.stringify({ p88, pM88 }));
    // ③ 400 ORPHAN_WORKER = 새로 들어온 명부 밖 id 목록(ids)도 돌려줌(그 줄에 있던 명부 밖 id는 넣지 않음 · 저장 안 됨) · 결함 사본(목록 걷음) ✗
    const chkO88 = async (mod) => { reset88(); const c = async (body) => { const r = await mod.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tokA }, body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
      mem.gw_data['col:workers'] = { schema: 1, items: [{ id: 'w88' }], updated_at: 1 };
      mem.gw_data['col:asbestos'] = { schema: 1, items: [{ id: 'a88', worker_ids: ['wOld88'] }], updated_at: 5 };
      const r = await c({ action: 'save', collection: 'asbestos', base: 5, doc: { schema: 1, items: [{ id: 'a88', worker_ids: ['wOld88', 'w88', 'wX88', 'wY88'] }] } });
      const kept = JSON.stringify(mem.gw_data['col:asbestos'].items[0].worker_ids) === '["wOld88"]';
      return { ok: r.code === 400 && r.body.error_code === 'ORPHAN_WORKER' && r.body.n === 2 && JSON.stringify((r.body.ids || []).slice().sort()) === '["wX88","wY88"]' && kept, info: [r.code, r.body.error_code, r.body.n, r.body.ids, kept] }; };
    const o88 = await chkO88(gwd), oM88 = await chkO88(mut88('gwd', ", ids: orphans.slice(0, 50).map(function (i) { return String(i).slice(0, 40); })", ''));
    T('88 v456 2차 검토 ③ 400 ORPHAN_WORKER = 새로 들어온 명부 밖 id 목록(ids — 그 줄에 있던 명부 밖 id는 뺌)·n 2·저장 안 됨(앱이 두 번째 400에서 이 id만 대장에서 빼고 다시 저장 — uismoke v456 ⑧) · 결함 사본(목록 걷음) ✗',
      o88.ok && !oM88.ok, JSON.stringify({ o88: o88.info, oM88: oM88.info }));
    // ④ 정적: netlify/functions 아래 동기 압축 풀기 호출 = _lib/docdiff.js inflateRawSync 1곳(zipBudget.inflate) + gw-data.js gunzipSync 1곳(parseBody) 뿐 —
    //   새 풀기는 DD.zipEntries·DD.zipBudget()으로만(항목당 상한만 건 직접 호출은 총량 예산을 비켜 감 — 87 ①의 hwpx 결함 꼴) · 결함 사본(gw-data에 항목당 상한 직접 풀기 1줄 더함) ✗
    const sites88 = (extra) => { const out = [];
      const walk = (d) => fs88.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.js$/.test(e.name)) {
        const rel = p.slice(FN.length + 1).replace(/\\/g, '/'); const src = fs88.readFileSync(p, 'utf8') + (extra && extra[rel] ? extra[rel] : '');
        src.split('\n').forEach((l) => { const m = /\b(inflateRawSync|gunzipSync|inflateSync|unzipSync|brotliDecompressSync|inflateRaw|gunzip|unzip)\(/.exec(l); if (m) out.push(rel + ':' + m[1]); }); } });
      walk(FN); return out.sort(); };
    const st88 = sites88(), stM88 = sites88({ 'gw-data.js': '\n    const raw2 = zlib.inflateRawSync(data, { maxOutputLength: DD.ZIP_ENTRY_MAX });' });
    const pb88 = (() => { const i = S88.gwd.indexOf('function parseBody('), j = S88.gwd.indexOf('\n}', i); return i >= 0 ? S88.gwd.slice(i, j) : ''; })();
    const fix88 = (L) => JSON.stringify(L) === JSON.stringify(['_lib/docdiff.js:inflateRawSync', 'gw-data.js:gunzipSync', 'gw-stmt.js:gunzipSync']);   // v461(29): gw-stmt parseBody도 요청 gzip 1곳(GZ_MAX_OUT 6MB 상한 — 아래 pbS88)
    const gws88 = fs88.readFileSync(join(FN, 'gw-stmt.js'), 'utf8'), pbS88 = (() => { const i = gws88.indexOf('function parseBody('), j = gws88.indexOf('\n}', i); return i >= 0 ? gws88.slice(i, j) : ''; })();
    const capS88 = /gunzipSync\(.*, \{ maxOutputLength: GZ_MAX_OUT \}\)/.test(pbS88) && /\nconst GZ_MAX_OUT = 6 \* 1024 \* 1024;/.test(gws88);
    T('88 v456 2차 검토 ④ 정적: 함수 폴더 동기·비동기 압축 풀기 호출 = _lib/docdiff.js inflateRawSync 1곳 + gw-data.js gunzipSync 1곳(parseBody 안) + gw-stmt.js gunzipSync 1곳(parseBody 안·maxOutputLength GZ_MAX_OUT 6MB — v461)뿐 · 결함 사본(gw-data에 항목당 상한만 건 inflateRawSync 1줄) ✗',
      fix88(st88) && /gunzipSync\(/.test(pb88) && capS88 && !fix88(stM88), JSON.stringify({ st88, stM88, capS88 }));
    // ⑤ appdata autotask --selftest(원장 C106 — 워크플로는 --dry-run·실행만 돌림): 형제 폴더 jongwoon-appdata·python이 있을 때만 rc 0·"selftest 통과"·결함 사본 줄 ✓ — 없으면 생략을 알림
    const ad88 = join(ROOT, '..', 'jongwoon-appdata', 'collectors', 'autotask.py');
    if (!fs88.existsSync(ad88)) console.log('  (88 ⑤ 생략 — jongwoon-appdata 폴더 없음)');
    else {
      const r = cp88.spawnSync('python', ['-I', '-X', 'utf8', ad88, '--selftest'], { encoding: 'utf8', timeout: 120000 });
      if (r.error && r.error.code === 'ENOENT') console.log('  (88 ⑤ 생략 — python 없음)');
      else T('88 v456 2차 검토 ⑤ appdata autotask.py --selftest(python -I -X utf8): rc 0 · "selftest 통과 (n/n)" · 결함 사본 줄 ✓ 포함',
        r.status === 0 && /selftest 통과 \((\d+)\/\1\)/.test(r.stdout || '') && /✓ 결함 사본/.test(r.stdout || ''), JSON.stringify({ rc: r.status, tail: String(r.stdout || '').trim().split('\n').slice(-1)[0], err: String(r.stderr || '').slice(0, 200) }));
    }
  } catch (e) { T('88 v456 2차 검토 묶음 실행', false, String(e && e.message)); } finally { reset88(); }
}

{ // ---- 86(P1 판1) 법인 등기 날짜 settings:corp_reg + 입찰 투찰(응찰) 잠금(기본 꺼짐) — 원장 T462·T461·T388 · 업무별 설계 C6.
  //   corp_reg_get·corp_reg_set = 관리자만 · 값 검사(BAD_DATE·BAD_FUTURE·BAD_VALUE) · 낙관락 409 CORP_REG_STALE · NO_CHANGE · prev 1판 · 감사 1줄(col corp_reg).
  //   공고 저장(save bids): 꺼짐·키 없음 = 종전 그대로(회귀) · 켜짐 + 잠김 = 응찰로 바꾼 줄 400 GATE_CORP_REG(blocked·why·저장 0·감사 투찰잠금) · 되돌리기·이미 응찰은 통과 · 설정 못 읽음 = 응찰 전환만 503.
  //   날짜는 고정: 지난 날 2026-09-29·2026-10-07(오늘보다 앞) · 미래 2099-12-31(오늘보다 뒤) — 오늘 날짜 값에 기대지 않음.
  const savedUsers86 = JSON.parse(JSON.stringify(mem.gw_users));
  const KEY86 = 'settings:corp_reg', BK86 = 'col:bids';
  const had86 = { s: mem.gw_data[KEY86], b: mem.gw_data[BK86] };
  delete mem.gw_data[KEY86]; delete mem.gw_data[BK86];
  mem.gw_users['device:dev1'] = { status: 'approved' };
  mem.gw_users['member:u86n'] = { id: 'u86n', name: '나수진형86', role: '관리자', admin: true, perms: {} };
  const tN86 = issueSession(mem.gw_users['member:u86n']).token;
  const get86 = (tok, dev) => call({ action: 'corp_reg_get' }, tok, dev);
  const set86 = (body, tok, dev) => call(Object.assign({ action: 'corp_reg_set' }, body), tok, dev);
  const aud86 = (col) => auditMock.logs.filter((l) => l.col === col);
  const V86 = (o) => Object.assign({ reg_on: '', biz_fix_on: '', g2b_on: '', gate: false }, o || {});
  const B86 = (id, status, extra) => Object.assign({ id, title: '공고 ' + id, org: '시험시', due: '', status, updated: '2026-11-13' }, extra || {});
  const seedBids86 = (items) => { mem.gw_data[BK86] = { schema: 1, items: JSON.parse(JSON.stringify(items)), updated_at: 5000 }; };
  const saveBids86 = (items) => call({ action: 'save', collection: 'bids', doc: { schema: 1, items }, base: 5000 }, tokA);
  const stOf86 = (id) => { const x = ((mem.gw_data[BK86] || {}).items || []).find((t) => t.id === id); return x ? x.status : '(없음)'; };
  try {
    // ① 권한 — 관리자 아님 403 ADMIN_ONLY(읽기·쓰기) · 비로그인 401 · 관리자 읽기(키 없음) = settings null·lock ''
    const g0 = await get86(tokA), gW = await get86(tokW, 'dev1'), sW = await set86(Object.assign({ base: 0 }, V86({ reg_on: '2026-09-29' })), tokW, 'dev1'), gNo = await get86(null);
    T('86 P1 판1 ① 권한: 관리자 읽기(키 없음) = 200 settings null·updated_at 0·lock ""·prev null · 직원 읽기·쓰기 = 403 ADMIN_ONLY · 비로그인 401 · 저장 0',
      g0.code === 200 && g0.body.settings === null && g0.body.updated_at === 0 && g0.body.lock === '' && g0.body.prev === null
      && gW.code === 403 && gW.body.error_code === 'ADMIN_ONLY' && sW.code === 403 && sW.body.error_code === 'ADMIN_ONLY' && gNo.code === 401 && !(KEY86 in mem.gw_data),
      JSON.stringify([g0, gW.code, sW.code, gNo.code]));

    // ② 값 검사 → 400 이유 코드 · 저장 0·감사 0
    const a0 = aud86('corp_reg').length;
    const BAD86 = [['BAD_DATE', { reg_on: '2026-02-30' }], ['BAD_DATE', { g2b_on: '20261007' }], ['BAD_DATE', { biz_fix_on: 20261001 }], ['BAD_FUTURE', { g2b_on: '2099-12-31' }], ['BAD_VALUE', { gate: 'true' }], ['BAD_VALUE', { gate: 1 }]];
    const bad86 = [];
    for (const [code, o] of BAD86) { const r = await set86(Object.assign({ base: 0 }, V86(o)), tokA); if (!(r.code === 400 && r.body.error_code === code)) bad86.push(code + '→' + r.code + '/' + r.body.error_code); }
    const noGate = await set86({ base: 0, reg_on: '2026-09-29', biz_fix_on: '', g2b_on: '' }, tokA);
    T('86 P1 판1 ② 값 검사: 없는 날(2/30)·꼴 틀림(8자리·숫자) = 400 BAD_DATE · 미래 2099-12-31 = 400 BAD_FUTURE · gate "true"·1·빠짐 = 400 BAD_VALUE · 저장 0·감사 0',
      bad86.length === 0 && noGate.code === 400 && noGate.body.error_code === 'BAD_VALUE' && !(KEY86 in mem.gw_data) && aud86('corp_reg').length === a0, JSON.stringify({ bad86, noGate: noGate.body.error_code }));

    // ③ 저장 1(base 0) — 알려진 칸만 · prev null · 감사 1줄 · base 없음·낡은 base 409 · 같은 값 NO_CHANGE
    const w1 = await set86(Object.assign({ base: 0, junk: 'x' }, V86({ reg_on: '2026-09-29' })), tN86);
    const s1 = JSON.parse(JSON.stringify(mem.gw_data[KEY86] || null)), au1 = aud86('corp_reg').slice(a0);
    const noBase = await set86(V86({ reg_on: '2026-09-29', biz_fix_on: '2026-10-01' }), tokA), stale = await set86(Object.assign({ base: 1 }, V86({ reg_on: '2026-09-29', biz_fix_on: '2026-10-01' })), tokA);
    const same = await set86(Object.assign({ base: w1.body.updated_at }, V86({ reg_on: '2026-09-29' })), tokA);
    T('86 P1 판1 ③ 저장 1(나수진형 관리자 · base 0): 200 · 저장값 = 세 날짜·gate 꺼짐만(모르는 칸 junk 버림) · schema 1 · prev null · updated_by u86n · 감사 1줄(col corp_reg · op 법인등기 · f 조직변경 등기 접수일 ""→2026-09-29) · base 없음·낡은 base = 409 CORP_REG_STALE · 같은 값 = 400 NO_CHANGE · 감사 그대로 1줄',
      w1.code === 200 && JSON.stringify(w1.body.settings) === JSON.stringify(V86({ reg_on: '2026-09-29' })) && w1.body.lock === '' && !!s1 && s1.schema === 1 && s1.prev === null && s1.updated_by === 'u86n' && s1.junk === undefined && s1.gate === false
      && au1.length === 1 && au1[0].ev[0].op === '법인등기' && au1[0].ev[0].id === KEY86 && JSON.stringify(au1[0].ev[0].f) === JSON.stringify({ reg_on: ['', '2026-09-29'] })
      && noBase.code === 409 && noBase.body.error_code === 'CORP_REG_STALE' && stale.code === 409 && stale.body.error_code === 'CORP_REG_STALE' && same.code === 400 && same.body.error_code === 'NO_CHANGE' && aud86('corp_reg').length === a0 + 1,
      JSON.stringify({ w1: w1.body, s1, au: au1.map((x) => x.ev), noBase: noBase.code, stale: stale.code, same: same.body.error_code }));

    // ④ 저장 2 — 잠금 켬(완료일 빔) · prev = 저장 1 · lock G2B_EMPTY · 감사 f = 바뀐 칸만
    const w2 = await set86(Object.assign({ base: w1.body.updated_at }, V86({ reg_on: '2026-09-29', biz_fix_on: '2026-10-01', gate: true })), tokA);
    const s2 = JSON.parse(JSON.stringify(mem.gw_data[KEY86] || null)), au2 = aud86('corp_reg').slice(a0);
    T('86 P1 판1 ④ 저장 2(잠금 켬 · 완료일 빔): 200 · lock G2B_EMPTY · prev = 저장 1 한 판(세 날짜·gate·updated_at·updated_by) · 응답 prev = 날·사람만 · 감사 +1(f 사업자등록 정정일·투찰 잠금 끔→켬)',
      w2.code === 200 && w2.body.lock === 'G2B_EMPTY' && w2.body.updated_at > w1.body.updated_at && !!s2 && s2.gate === true
      && JSON.stringify(s2.prev) === JSON.stringify(Object.assign(V86({ reg_on: '2026-09-29' }), { updated_at: s1.updated_at, updated_by: 'u86n' })) && JSON.stringify(w2.body.prev) === JSON.stringify({ updated_at: s1.updated_at, updated_by: 'u86n' })
      && au2.length === 2 && JSON.stringify(au2[1].ev[0].f) === JSON.stringify({ biz_fix_on: ['', '2026-10-01'], gate: ['끔', '켬'] }),
      JSON.stringify({ w2: w2.body, prev: s2 && s2.prev, f: au2[1] && au2[1].ev[0].f }));

    // ⑤ 잠김(완료일 빔) — 검토→응찰·새 줄 응찰 = 400 GATE_CORP_REG(blocked·why) · 저장 0 · 감사 투찰잠금 1줄 / 이미 응찰·낙찰→응찰 되돌리기·참여 그대로·다른 고침 = 200
    seedBids86([B86('k1', '검토'), B86('k2', '응찰'), B86('k3', '낙찰'), B86('k4', '참여'), B86('k5', 'new')]);
    const snap5 = JSON.stringify(mem.gw_data[BK86]), ab0 = aud86('bids').length;
    const r5a = await saveBids86([B86('k1', '응찰'), B86('k2', '응찰'), B86('k3', '낙찰'), B86('k4', '참여'), B86('k5', 'new'), B86('k6', '응찰')]);
    const kept5 = JSON.stringify(mem.gw_data[BK86]) === snap5, ab5 = aud86('bids').slice(ab0);
    const r5b = await saveBids86([B86('k1', '검토', { title: '고친 제목' }), B86('k2', '응찰'), B86('k3', '응찰'), B86('k4', '참여'), B86('k5', '패스')]);
    T('86 P1 판1 ⑤ 잠김(켬 · 완료일 빔): 검토→응찰(k1)·새 줄 응찰(k6) = 400 GATE_CORP_REG · why G2B_EMPTY · blocked [{k1, from 검토}, {k6, from ""}](이미 응찰 k2·참여 k4는 안 듦) · 공고 문서 그대로 · 감사 1줄(col bids · op 투찰잠금 · id k1,k6) / 다음 저장(응찰 전환 없음 · 낙찰→응찰 되돌리기 k3 · 제목 고침 · 패스) = 200 · k3 응찰·k1 검토',
      r5a.code === 400 && r5a.body.error_code === 'GATE_CORP_REG' && r5a.body.why === 'G2B_EMPTY' && JSON.stringify(r5a.body.blocked) === JSON.stringify([{ id: 'k1', from: '검토' }, { id: 'k6', from: '' }])
      && kept5 && ab5.length === 1 && ab5[0].ev[0].op === '투찰잠금' && ab5[0].ev[0].id === 'k1,k6'
      && r5b.code === 200 && stOf86('k3') === '응찰' && stOf86('k1') === '검토' && stOf86('k5') === '패스',
      JSON.stringify({ r5a: [r5a.code, r5a.body], kept5, ab5: ab5.map((x) => x.ev), r5b: r5b.code, k3: stOf86('k3') }));

    // ⑥ 완료일이 등기 접수일보다 이름 = 잠김 G2B_BEFORE_REG · 완료일 ≥ 접수일 = 열림(200·응찰 저장)
    const w6 = await set86(Object.assign({ base: mem.gw_data[KEY86].updated_at }, V86({ reg_on: '2026-09-29', biz_fix_on: '2026-10-01', g2b_on: '2026-09-01', gate: true })), tokA);
    seedBids86([B86('k1', '검토')]);
    const r6a = await saveBids86([B86('k1', '응찰')]);
    const w6b = await set86(Object.assign({ base: mem.gw_data[KEY86].updated_at }, V86({ reg_on: '2026-09-29', biz_fix_on: '2026-10-01', g2b_on: '2026-10-07', gate: true })), tokA);
    const r6b = await saveBids86([B86('k1', '응찰')]);
    T('86 P1 판1 ⑥ 완료일 2026-09-01 < 접수일 2026-09-29(다음 변경) = lock G2B_BEFORE_REG · 응찰 전환 400 GATE_CORP_REG(why G2B_BEFORE_REG) / 완료일 2026-10-07 = lock "" · 같은 전환 200(k1 응찰)',
      w6.code === 200 && w6.body.lock === 'G2B_BEFORE_REG' && r6a.code === 400 && r6a.body.why === 'G2B_BEFORE_REG' && w6b.code === 200 && w6b.body.lock === '' && r6b.code === 200 && stOf86('k1') === '응찰',
      JSON.stringify([w6.body.lock, r6a.code, r6a.body.why, w6b.body.lock, r6b.code]));

    // ⑦ 회귀 — 꺼짐(완료일 빔이어도)·키 없음 = 종전과 같음(200 · 응찰 저장) · 빈칸 저장으로 날짜 지우기
    const w7 = await set86(Object.assign({ base: mem.gw_data[KEY86].updated_at }, V86({ reg_on: '2026-09-29', gate: false })), tokA);
    seedBids86([B86('k1', '검토')]);
    const r7a = await saveBids86([B86('k1', '응찰')]);
    delete mem.gw_data[KEY86];
    seedBids86([B86('k1', '검토')]);
    const r7b = await saveBids86([B86('k1', '응찰')]);
    T('86 P1 판1 ⑦ 회귀(꺼짐 = 지금 동작): 빈칸 저장으로 정정일·완료일 지움(200 · 저장값 빈칸 · lock "") · 꺼짐 + 완료일 빔 = 검토→응찰 200(응찰 저장) · 키 없음 = 200(응찰 저장)',
      w7.code === 200 && w7.body.settings.biz_fix_on === '' && w7.body.settings.g2b_on === '' && w7.body.lock === '' && r7a.code === 200 && r7b.code === 200 && stOf86('k1') === '응찰',
      JSON.stringify([w7.code, w7.body.settings, r7a.code, r7b.code]));

    // ⑧ 설정을 못 읽으면 — 응찰 전환이 있는 저장만 503 CORP_REG_READ_FAILED(공고 그대로) · 전환 없는 저장은 설정을 읽지 않고 200 · 쓰기 읽기 실패 = 500 SETTINGS_READ_FAILED
    seedBids86([B86('k1', '검토'), B86('k2', '응찰')]);
    blobsMock.hooks.failGet = (k) => k === KEY86;
    const r8a = await saveBids86([B86('k1', '응찰'), B86('k2', '응찰')]);
    const st8a = stOf86('k1');
    const r8b = await saveBids86([B86('k1', '검토', { title: '고침' }), B86('k2', '응찰')]);
    const r8c = await set86(Object.assign({ base: 0 }, V86({ reg_on: '2026-09-29' })), tokA), r8d = await get86(tokA);
    delete blobsMock.hooks.failGet;
    T('86 P1 판1 ⑧ 설정 읽기 실패: 응찰 전환 저장 = 503 CORP_REG_READ_FAILED(k1 검토 그대로) · 전환 없는 저장 = 200(설정 안 읽음 — 종전과 같음) · corp_reg_set = 500 SETTINGS_READ_FAILED · corp_reg_get = 500',
      r8a.code === 503 && r8a.body.error_code === 'CORP_REG_READ_FAILED' && st8a === '검토' && r8b.code === 200 && r8c.code === 500 && r8c.body.error_code === 'SETTINGS_READ_FAILED' && r8d.code === 500,
      JSON.stringify([r8a.code, r8a.body.error_code, st8a, r8b.code, r8c.code, r8d.code]));
  } finally {
    delete blobsMock.hooks.failGet;
    mem.gw_users = savedUsers86;
    if (had86.s === undefined) delete mem.gw_data[KEY86]; else mem.gw_data[KEY86] = had86.s;
    if (had86.b === undefined) delete mem.gw_data[BK86]; else mem.gw_data[BK86] = had86.b;
  }
}

{ // ---- 87(P1 판2) 차량 지시 완료 창의 새 만기일(veh_due_set) + 차량 만기 '다시 지시'(autorules vehRedo · autotask_ingest 갈래) — 원장 T693·T364.
  //   veh_due_set 권한 = 차량 수행(관리자 포함) · 또는 (그 지시 담당 + 배정표 차량 담당 + 차량의 그 칸 = 지시 만료일) — 나머지 403 NO_WRITE(why) · 값 검사 · 낙관(base_due) · 그 줄 그 칸만 · 버전 링 · 감사.
  //   날짜는 고정(만료 2026-10-31·2026-12-20·2020-01-31 · 다시 지시 규칙 표본의 오늘 = 2026-11-13). ingest는 서버 오늘(KST)을 쓰므로 만료일을 2020년으로 둬 늘 '지남'.
  //   검사마다 결함을 심은 gw-data·autorules 사본(소스 한 곳을 바꿔 메모리에서 컴파일 — 파일은 쓰지 않음)에서는 실패해야 한다.
  const fs87 = require('fs'), Mod87 = require('module');
  const FILE87 = join(FN, 'gw-data.js'), SRC87 = fs87.readFileSync(FILE87, 'utf8');
  const ARF87 = join(FN, '_lib', 'autorules.js'), ARSRC87 = fs87.readFileSync(ARF87, 'utf8');
  const load87 = (file, src) => { const m = new Mod87(file); m.filename = file; m.paths = Mod87._nodeModulePaths(dirname(file)); m._compile(src, file); return m.exports; };
  const mutOf87 = (src, from, to) => { if (src.split(from).length !== 2) throw new Error('결함 자리가 한 곳이 아님: ' + from.slice(0, 60)); return src.replace(from, () => to); };
  const caller87 = (mod) => async (body, tok, dev) => { const r = await mod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) }); return { code: r.statusCode, body: JSON.parse(r.body || '{}') }; };
  const snap87 = JSON.stringify({ u: mem.gw_users, d: mem.gw_data });
  const reset87 = () => { const s = JSON.parse(snap87); mem.gw_users = s.u; mem.gw_data = s.d; };
  const MA87 = { id: 'u87a', name: '차량담당87', admin: false, perms: { tasks: 'do', veh: 'view' } };   // 배정표 차량 담당(차량 보기)
  const MB87 = { id: 'u87b', name: '다른담당87', admin: false, perms: { tasks: 'do', veh: 'view' } };   // 지시 담당이지만 배정표 밖
  const MC87 = { id: 'u87c', name: '남87', admin: false, perms: { tasks: 'view', veh: 'hide' } };
  const tA87 = issueSession(MA87).token, tB87 = issueSession(MB87).token, tC87 = issueSession(MC87).token;
  const VID2 = 'v경북12가3456';   // 차량 id = 'v' + 번호판(한글 포함)
  const V87 = () => [{ id: 'v1', no: '11가1111', type: '덤프', own: '지입', state: '운행', insp_due: '2026-10-31', ins_due: '2026-12-20', insurer: '시험보험', note: '', updated: '2026-10-01' },
    { id: VID2, no: '경북12가3456', state: '운행', insp_due: '2026-09-30', ins_due: '2027-01-05', updated: '2026-10-01' }];
  const TK87 = (id, key, who, status, extra) => Object.assign({ id, title: '지시 ' + id, auto_key: key, who_id: who || '', who: '', status: status || 'open', from: '자동', due: '' }, extra || {});
  const T87 = () => [TK87('t1', 'veh:v1:insp:2026-10-31', 'u87a'), TK87('t2', 'veh:v1:ins:2026-12-20', 'u87a'), TK87('t3', undefined, 'u87a', 'open', { from: '관리자' }),
    TK87('t4', 'veh:v1:insp:2026-10-31', 'u87a', 'done'), TK87('t5', 'veh:' + VID2 + ':insp:2026-09-30', 'u87b'), TK87('t6', 'veh:v1:insp:2026-09-01', 'u87a'),
    TK87('t7', 'veh:v1:insp:2026-10-31:re:2026-11', 'u87a'), TK87('t8', 'veh:vNone:insp:2026-10-31', 'u87a'), TK87('t9', 'veh:v1:insp:2026-10-31', 'u87a', 'open', { del: 1 }), TK87('t10', 'veh:v1:ins:2026-12-20', 'u87b')];
  const seed87 = (opt) => { reset87();
    Object.assign(mem.gw_users, { 'member:u87a': MA87, 'member:u87b': MB87, 'member:u87c': MC87, 'device:dev1': { status: 'approved' } });
    mem.gw_data['col:vehicles'] = { schema: 1, items: V87(), updated_at: 7000, updated_by: 'x' };
    mem.gw_data['col:tasks'] = { schema: 1, items: T87(), updated_at: 7100, updated_by: 'x' };
    delete mem.gw_data['settings:autotask'];
    if (!opt || !opt.noAssign) mem.gw_data['settings:assign'] = { schema: 1, rules: { 'veh:': { who_id: 'u87a' } }, approver_id: '', prev: null, updated_at: 5, updated_by: 'x' }; else delete mem.gw_data['settings:assign'];
    Object.keys(mem.gw_data).filter((k) => k.indexOf('ver:vehicles:') === 0 || k === 'veridx:vehicles').forEach((k) => { delete mem.gw_data[k]; });
  };
  const vehOf87 = (id) => (mem.gw_data['col:vehicles'].items || []).find((v) => v.id === id);
  const set87 = (c, tok, task, date, base, dev) => c(Object.assign({ action: 'veh_due_set', task_id: task, date: date }, base === undefined ? {} : { base_due: base }), tok, dev === undefined ? 'dev1' : dev);
  const KST87 = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  // ① 거절 — 권한·지시 꼴·값·낙관·같은 값: 차량 문서·버전 링·감사 그대로
  const chk87A = async (c) => { seed87(); const v0 = JSON.stringify(mem.gw_data['col:vehicles']), a0 = auditMock.logs.length, got = [];
    const exp = [[await set87(c, null, 't1', '2027-10-31'), 401, ''], [await set87(c, tA87, 't1', '2027-10-31', undefined, ''), 403, 'DEVICE_NOT_APPROVED'],
      [await set87(c, tA87, 't9', '2027-10-31'), 404, 'NO_TASK'], [await set87(c, tA87, 'tZZ', '2027-10-31'), 404, 'NO_TASK'], [await set87(c, tokA, 't3', '2027-10-31'), 400, 'NOT_VEH_TASK'],
      [await set87(c, tokA, 't4', '2027-10-31'), 400, 'TASK_DONE'], [await set87(c, tC87, 't1', '2027-10-31'), 403, 'NO_WRITE:NOT_ASSIGNEE'], [await set87(c, tB87, 't1', '2027-10-31'), 403, 'NO_WRITE:NOT_ASSIGNEE'],
      [await set87(c, tB87, 't5', '2026-12-31'), 403, 'NO_WRITE:NOT_ASSIGN_TABLE'], [await set87(c, tB87, 't10', '2027-12-20'), 403, 'NO_WRITE:NOT_ASSIGN_TABLE'], [await set87(c, tA87, 't6', '2027-09-01'), 403, 'NO_WRITE:DATE_MOVED'],
      [await set87(c, tA87, 't1', '2026-02-30'), 400, 'BAD_DATE'], [await set87(c, tA87, 't1', '20271031'), 400, 'BAD_DATE'], [await set87(c, tA87, 't1', '1999-12-31'), 400, 'BAD_DATE'], [await set87(c, tA87, 't1', 20271031), 400, 'BAD_DATE'], [await set87(c, tA87, 't1', ''), 400, 'BAD_DATE'],
      [await set87(c, tokA, 't8', '2027-10-31'), 404, 'NO_VEHICLE'], [await set87(c, tokA, 't1', '2027-10-31', '2026-01-01'), 409, 'VEH_DUE_STALE'], [await set87(c, tA87, 't1', '2026-10-31', '2026-10-31'), 400, 'NO_CHANGE']];
    exp.forEach(([r, code, ec], i) => { const e = r.body.error_code ? r.body.error_code + (r.body.why ? ':' + r.body.why : '') : ''; if (r.code !== code || (ec && e !== ec)) got.push(i + ' ' + r.code + '/' + e); });
    seed87({ noAssign: true }); const rNo = await set87(c, tA87, 't1', '2027-10-31');
    if (!(rNo.code === 403 && rNo.body.why === 'NOT_ASSIGN_TABLE')) got.push('배정표 없음 ' + rNo.code + '/' + rNo.body.why);
    const same = JSON.stringify(mem.gw_data['col:vehicles']) === v0 && !Object.keys(mem.gw_data).some((k) => k.indexOf('ver:vehicles:') === 0) && auditMock.logs.length === a0;
    return { ok: got.length === 0 && same, info: { got, same } };
  };
  // ② 담당 갈래 저장 — 그 줄 그 칸만 · 다른 칸·다른 줄·다른 값 그대로 · updated 오늘(KST) · updated_by · 버전 링 1 · 감사 1줄(col vehicles · op 수정 · f 그 칸 [이전, 새]) · 보험 지시는 ins_due만
  const chk87B = async (c) => { seed87(); const a0 = auditMock.logs.length;
    const r1 = await set87(c, tA87, 't1', '2027-10-31', '2026-10-31'); const v1 = JSON.parse(JSON.stringify(vehOf87('v1'))), au = auditMock.logs.slice(a0), vers = Object.keys(mem.gw_data).filter((k) => k.indexOf('ver:vehicles:') === 0);
    const ua1 = mem.gw_data['col:vehicles'].updated_at, ub1 = mem.gw_data['col:vehicles'].updated_by;   // 검토 반영: r2가 같은 ms에 끝나야만 맞던 대조(시각 의존) — r1 바로 뒤 값으로
    const verDoc = vers.length ? mem.gw_data[vers[0]].doc : null;
    const r2 = await set87(c, tA87, 't2', '2027-12-20', '2026-12-20'); const v1b = vehOf87('v1');
    const r3 = await set87(c, tA87, 't7', '2027-11-30', '2027-10-31');   // 다시 지시 키(:re:) — 차량 칸이 이미 2027-10-31로 바뀜 = 담당 갈래 거절
    const ok = r1.code === 200 && JSON.stringify(r1.body.vehicle) === JSON.stringify({ id: 'v1', field: 'insp_due', value: '2027-10-31', prev: '2026-10-31', updated: KST87 })
      && v1.insp_due === '2027-10-31' && v1.ins_due === '2026-12-20' && v1.no === '11가1111' && v1.own === '지입' && v1.insurer === '시험보험' && v1.updated === KST87
      && JSON.stringify(vehOf87(VID2)) === JSON.stringify(V87()[1]) && ub1 === 'u87a' && ua1 === r1.body.updated_at
      && vers.length >= 1 && verDoc && verDoc.items[0].insp_due === '2026-10-31'
      && au.length === 1 && au[0].col === 'vehicles' && au[0].bid === 'u87a' && au[0].ev[0].op === '수정' && au[0].ev[0].id === 'v1' && JSON.stringify(au[0].ev[0].f) === JSON.stringify({ insp_due: ['2026-10-31', '2027-10-31'] }) && /배정 담당/.test(au[0].ev[0].t)
      && r2.code === 200 && r2.body.vehicle.field === 'ins_due' && v1b.ins_due === '2027-12-20' && v1b.insp_due === '2027-10-31'
      && r3.code === 403 && r3.body.why === 'DATE_MOVED';
    return { ok, info: { r1: r1.body, v1, au: au.map((x) => x.ev), vers: vers.length, r2: r2.code, r3: [r3.code, r3.body.why] } };
  };
  // ③ 차량 수행 갈래 — 담당 아니어도(직원 veh do · 관리자) 그 지시의 그 칸 · 칸이 이미 바뀐 지시(:re: 키)도 · 지금보다 이른 날도 서버는 받음(앱이 확인 문구)
  const chk87C = async (c) => { seed87();
    const r1 = await set87(c, tokW, 't5', '2027-09-30', '2026-09-30', 'dev1'), r2 = await set87(c, tokA, 't6', '2026-08-01', '2026-10-31');
    const ok = r1.code === 200 && vehOf87(VID2).insp_due === '2027-09-30' && r2.code === 200 && vehOf87('v1').insp_due === '2026-08-01' && vehOf87('v1').ins_due === '2026-12-20';
    return { ok, info: [r1.code, r1.body.error_code, r2.code, r2.body.error_code] };
  };
  // ④ 규칙 vehRedo(오늘 2026-11-13 고정) — 지남 + 그 만료일 지시 완료 + 진행 0 + 이번 달 다시 키 없음 → ':re:2026-11'(제목·기한) · 회색·지난 지시 없음·안 지남·진행 중 다시 지시·승인 대기·이번 달 키 있음(지운 것도)·지운 차·지운 지시만 = 없음
  const VR87 = [{ id: 'A', no: '11가1111', state: '운행', insp_due: '2026-10-31', ins_due: '2027-03-01' }, { id: 'B', no: '22나2222', state: '운행', insp_due: '2027-01-01', ins_due: '2026-11-01' },
    { id: 'C', no: '33다3333', state: '매각', insp_due: '2026-10-01' }, { id: 'D', no: '44라4444', state: '운행', insp_due: '2026-10-02' }, { id: 'E', no: '55마5555', state: '운행', insp_due: '2026-11-20' },
    { id: 'F', no: '66바6666', state: '운행', insp_due: '2026-10-03' }, { id: 'G', no: '', state: '정비', insp_due: '2026-09-04' }, { id: 'H', no: '88아8888', state: '운행', insp_due: '2026-10-05' },
    { id: 'I', no: '99자9999', state: '운행', insp_due: '2026-10-06', del: 1 }, { id: 'J', no: '10차1010', state: '운행', ins_due: '2026-10-07' }, { id: 'K', no: '12카1212', state: '운행', insp_due: '2026-11-12' },
    { id: 'L', no: '13타1313', state: '운행', insp_due: '2026-11-13' }];
  const VT87 = [{ auto_key: 'veh:A:insp:2026-10-31', status: 'done' }, { auto_key: 'veh:B:ins:2026-11-01', status: 'done' }, { auto_key: 'veh:B:ins:2026-11-01:re:2026-10', status: 'open' },
    { auto_key: 'veh:C:insp:2026-10-01', status: 'done' }, { auto_key: 'veh:E:insp:2026-11-20', status: 'done' }, { auto_key: 'veh:F:insp:2026-10-03', status: 'done' }, { auto_key: 'veh:F:insp:2026-10-03:re:2026-11', status: 'open', del: 1 },
    { auto_key: 'veh:G:insp:2026-09-04', status: 'done' }, { auto_key: 'veh:G:insp:2026-09-04:re:2026-10', status: 'done' }, { auto_key: 'veh:H:insp:2026-10-05', status: 'review' },
    { auto_key: 'veh:I:insp:2026-10-06', status: 'done' }, { auto_key: 'veh:J:ins:2026-10-07', status: 'done', del: 1 }, { auto_key: 'veh:K:insp:2026-11-12', status: 'done' }, { auto_key: 'veh:L:insp:2026-11-13', status: 'done' }];
  const chk87D = (ar) => { const out = ar.vehRedo(JSON.parse(JSON.stringify(VR87)), JSON.parse(JSON.stringify(VT87)), '2026-11-13');
    const keys = out.map((n) => n.auto_key);
    const a = out.find((n) => n.id === 'A') || {}, g = out.find((n) => n.id === 'G') || {};
    const ok = JSON.stringify(keys) === JSON.stringify(['veh:A:insp:2026-10-31:re:2026-11', 'veh:G:insp:2026-09-04:re:2026-11', 'veh:K:insp:2026-11-12:re:2026-11'])
      && a.title === '11가1111 정기검사 갱신 — 다시(완료 뒤 만기일 그대로)' && a.due === '2026-10-31' && a.kind === 'insp' && a.days === -13 && /2026-10-31 그대로/.test(a.detail) && g.title === '차량 정기검사 갱신 — 다시(완료 뒤 만기일 그대로)'
      && ar.vehRedo([], VT87, '2026-11-13').length === 0 && ar.vehRedo(VR87, null, '2026-11-13').length === 0;
    return { ok, info: keys };
  };
  // ⑤ autotask_ingest 갈래 — 봇 항목 없이도 서버가 차량·지시로 세어 다시 지시 1건(담당 = 배정표 · who_by assign · 기한 = 만료일) · 스위치 없음(dry)이어도 만듦(D-30 차량 규칙과 같이 스위치 무관) · 다시 부르면 0 · 감사 '차량 다시 지시 1'
  const chk87E = async (c) => { seed87();
    mem.gw_data['col:vehicles'].items.push({ id: 'r1', no: '77사7777', state: '운행', insp_due: '2020-01-31', ins_due: '2099-01-01', updated: '2026-10-01' }, { id: 'r2', no: '78사7878', state: '검사보류', insp_due: '2020-02-29', updated: '2026-10-01' });
    mem.gw_data['col:tasks'].items.push(TK87('tr1', 'veh:r1:insp:2020-01-31', 'u87a', 'done'), TK87('tr2', 'veh:r2:insp:2020-02-29', 'u87a', 'done'));
    const a0 = auditMock.logs.length;
    const r1 = await c({ action: 'autotask_ingest', key: 'test-ingest-key', items: [] });
    const nw = mem.gw_data['col:tasks'].items.filter((t) => /:re:/.test(t.auto_key || '') && t.id !== 't7');
    const r2 = await c({ action: 'autotask_ingest', key: 'test-ingest-key', items: [] });
    const nw2 = mem.gw_data['col:tasks'].items.filter((t) => /:re:/.test(t.auto_key || '') && t.id !== 't7');
    const x = nw[0] || {}, ym = KST87.slice(0, 7), lastT = (auditMock.logs.slice(a0)[0] || { ev: [{}] }).ev[0].t || '';
    const ok = r1.code === 200 && r1.body.redo === 1 && r1.body.made === 1 && nw.length === 1 && x.auto_key === 'veh:r1:insp:2020-01-31:re:' + ym && x.who_id === 'u87a' && x.who_by === 'assign' && x.status === 'open' && x.due === '2020-01-31'
      && x.from === '자동' && /77사7777 정기검사 갱신 — 다시/.test(x.title) && /차량 다시 지시 1/.test(lastT) && r2.code === 200 && r2.body.redo === 0 && nw2.length === 1;
    return { ok, info: { r1: r1.body, nw: nw.map((t) => [t.auto_key, t.who_id, t.who_by, t.due]), r2: r2.body, lastT } };
  };
  // ⑦ 검토 S1 — 만기일 보호(save vehicles vehDueGuard): veh_due_set 뒤 그 표식을 모르는 낡은 사본(v1 insp_due 2026-10-31·표식 없음 + 다른 차 메모 고침 — 같은 날 로컬 우선 병합·옛 캐시 앱이 올리는 꼴)을
  //   관리자가 저장 = v1 insp_due 2027-10-31 그대로·표식 이어 감·다른 차 고침 들어감·감사 '만기일 보호' · 표식을 아는 사본(같은 at)이 바꾸기 전 날짜로 되돌림 = 받음 ·
  //   표식 모르는 사본이 다른 날짜(2026-12-31)로 고침 = 받음(사람 편집) · 표식 = {prev 2026-10-31, at 응답 updated_at}
  const save87 = (c, items) => c({ action: 'save', collection: 'vehicles', doc: { schema: 1, items: items }, base: mem.gw_data['col:vehicles'].updated_at }, tokA, 'dev1');
  const chk87F = async (c) => { seed87();
    const r1 = await set87(c, tA87, 't1', '2027-10-31', '2026-10-31');
    const mk = ((vehOf87('v1') || {}).due_set || {}).insp_due || null;
    const stale = V87(); stale[1].note = '새 메모';
    const a0 = auditMock.logs.length;
    const s1 = await save87(c, stale);
    const v1a = JSON.parse(JSON.stringify(vehOf87('v1'))), n2 = (vehOf87(VID2) || {}).note, ops = auditMock.logs.slice(a0).map((x) => x.ev.map((e) => e.op).join('+')).join('|');
    const known = JSON.parse(JSON.stringify(mem.gw_data['col:vehicles'].items)); known[0].insp_due = '2026-10-31';
    const s2 = await save87(c, known); const back = vehOf87('v1').insp_due;
    seed87(); await set87(c, tA87, 't1', '2027-10-31', '2026-10-31');
    const edit = V87(); edit[0].insp_due = '2026-12-31';
    const s3 = await save87(c, edit); const ed = vehOf87('v1').insp_due;
    const ok = r1.code === 200 && !!mk && mk.prev === '2026-10-31' && mk.at === r1.body.updated_at
      && s1.code === 200 && v1a.insp_due === '2027-10-31' && v1a.due_set && v1a.due_set.insp_due && v1a.due_set.insp_due.at === mk.at && n2 === '새 메모' && /만기일 보호/.test(ops)
      && s2.code === 200 && back === '2026-10-31' && s3.code === 200 && ed === '2026-12-31';
    return { ok, info: { r1: r1.code, mk, s1: s1.code, v1: [v1a.insp_due, v1a.due_set], n2, ops, s2: s2.code, back, s3: s3.code, ed } };
  };
  // ⑧ 검토 S2 — 쓰기 직전 다시 읽기: 버전 링 스냅샷 중(veridx 쓰기 직전)에 다른 일반 저장이 끝남(다른 차 메모 · updated_at 바뀜) → 그 고침 그대로 + 새 만기일 ·
  //   그 사이 같은 칸이 바뀜 → 409 VEH_DUE_STALE·그 값 그대로
  const race87 = async (c, fn) => { let fired = 0; blobsMock.hooks.beforeSet = async (k) => { if (k === 'veridx:vehicles' && !fired) { fired = 1; fn(mem.gw_data['col:vehicles']); } };
    try { return Object.assign(await set87(c, tA87, 't1', '2027-10-31', '2026-10-31'), { fired }); } finally { blobsMock.hooks.beforeSet = null; } };
  const chk87G = async (c) => {
    seed87(); const r1 = await race87(c, (d) => { d.items[1].note = '동시 저장'; d.updated_at = 7777; d.updated_by = 'uadmin'; });
    const g1 = [vehOf87('v1').insp_due, vehOf87(VID2).note];
    seed87(); const r2 = await race87(c, (d) => { d.items[0].insp_due = '2027-01-01'; d.updated_at = 7778; });
    const g2 = vehOf87('v1').insp_due;
    const ok = r1.fired === 1 && r1.code === 200 && g1[0] === '2027-10-31' && g1[1] === '동시 저장' && r2.fired === 1 && r2.code === 409 && r2.body.error_code === 'VEH_DUE_STALE' && g2 === '2027-01-01';
    return { ok, info: { r1: [r1.code, r1.fired], g1, r2: [r2.code, r2.body.error_code], g2 } };
  };
  try {
    const gw87 = caller87(gwd), R87 = {};
    for (const [n, f] of [['A', chk87A], ['B', chk87B], ['C', chk87C], ['E', chk87E], ['F', chk87F], ['G', chk87G]]) R87[n] = await f(gw87);
    R87.D = chk87D(require(ARF87));
    const MUT87 = {
      A: [["    if (!(t.who_id && t.who_id === c.member.id)) return jr(403, { status: 'FORBIDDEN', error_code: 'NO_WRITE', why: 'NOT_ASSIGNEE', request_id: R });\n", ''],
        ["    if (!(ar && ar.who_id === c.member.id)) return jr(403,", '    if (false) return jr(403,'],
        ["  if (!vehDo && cur !== m[3]) return jr(403,", '  if (false) return jr(403,'],
        ["error_code: 'NOT_VEH_TASK', request_id: R });\n  if (t.status === 'done') return jr(400, { status: 'REJECTED', error_code: 'TASK_DONE', request_id: R });\n", "error_code: 'NOT_VEH_TASK', request_id: R });\n"],
        ["  if (typeof v !== 'string' || !/^20\\d{2}-\\d{2}-\\d{2}$/.test(v)) return null;", "  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(v))) return null;"]],
      B: [['const vid = m[1], field = AR.VEH_DUE_KIND[m[2]].f;', "const vid = m[1], field = 'insp_due';"], ['  wv[field] = date; wv.updated = today;', '  wv[field] = date;'],
        ['const f = {}; f[field] = [cur, date];', 'const f = {}; f[field] = [date, date];'], ["  await verSnapshot('vehicles', rv.data, c.member.name, false);\n", '']],
      C: [["  const vehDo = permOf(c.member, 'vehicles') === 'do';", "  const vehDo = !!c.member.admin;"]],
      E: [['      AR.vehRedo(rvh.data.items, doc.items, today).forEach(function (n) {', '      [].forEach(function (n) {'], ["by: '자동', due: n.due, status: 'open'", "by: '자동', due: today, status: 'open'"]],
      F: [["  if (col === 'vehicles' && Array.isArray(doc.items)) vehDueKept = vehDueGuard(oldItems, doc.items);\n", ''],   // 검토 S1 — 고치기 전 코드(보호 없음)
        ["      if (!mk || typeof mk !== 'object' || (tm && tm.at === mk.at)) return;", "      if (!mk || typeof mk !== 'object') return;"],   // 표식을 아는 사본의 되돌림까지 막음
        ["      if (nz(t[f]) === nz(mk.prev) && nz(o[f]) !== nz(t[f])) { t[f] = o[f]; n++; }", "      if (nz(o[f]) !== nz(t[f])) { t[f] = o[f]; n++; }"],   // 사람 편집(다른 날짜)까지 막음
        ["wv.due_set[field] = { prev: cur, at: now };", ''],   // 표식 안 남김
        ["    if (vehDueKept) ev.push({ op: '만기일 보호'", "    if (false) ev.push({ op: '만기일 보호'"]],
      G: [["  if (Number((rv2.data && rv2.data.updated_at) || 0) !== Number(doc.updated_at || 0)) {", '  if (false) {'],   // 검토 S2 — 고치기 전 코드(다시 읽은 문서를 안 씀)
        ["    if (cur2 !== cur) return jr(409, { status: 'CONFLICT', error_code: 'VEH_DUE_STALE', cur: cur2, request_id: R });\n", '']],
    };
    const AMUT87 = [['    if (GREY.indexOf(String(v.state || \'\')) >= 0) return;\n    [\'insp\'', "    ['insp'"], ["      if (dd === null || dd >= 0) return;   // 지난 것만", '      if (dd === null || dd > 0) return;'],
      ["      if (same.some(function (t) { return t.status !== 'done'; })) return;\n", ''], ['      if (anyKey[key]) return;\n', ''], ["  const vt = live(taskRows).filter(", "  const vt = asList(taskRows).filter("],
      ["      if (!same.some(function (t) { return t.status === 'done'; })) return;\n", '']];
    const kill87 = [];
    for (const n of Object.keys(MUT87)) for (const [from, to] of MUT87[n]) {
      let k; try { const mod = load87(FILE87, mutOf87(SRC87, from, to)); k = !(await ({ A: chk87A, B: chk87B, C: chk87C, E: chk87E, F: chk87F, G: chk87G })[n](caller87(mod))).ok; } catch (e) { k = 'err ' + e.message; }
      if (k !== true) kill87.push(n + ':' + from.slice(0, 50) + (k === false ? ' 안 깨짐' : ' ' + k));
    }
    for (const [from, to] of AMUT87) { let k; try { k = !chk87D(load87(ARF87, mutOf87(ARSRC87, from, to))).ok; } catch (e) { k = 'err ' + e.message; } if (k !== true) kill87.push('D:' + from.slice(0, 50) + (k === false ? ' 안 깨짐' : ' ' + k)); }
    T('87 P1 판2 ① veh_due_set 거절: 비로그인 401 · 기기 미승인 403 · 지운·없는 지시 404 NO_TASK · 사람이 만든 지시 400 NOT_VEH_TASK · 완료 400 TASK_DONE · 차량 숨김·보기 비담당 403 NO_WRITE(NOT_ASSIGNEE) · 지시 담당이지만 배정표 밖(검사·보험) 403(NOT_ASSIGN_TABLE) · 배정표 없음 403(NOT_ASSIGN_TABLE) · 차량 칸이 지시 만료일과 다름 403(DATE_MOVED) · 2/30·8자리·1999·숫자·빈칸 400 BAD_DATE · 차량 없음 404 · 낡은 base_due 409 VEH_DUE_STALE · 같은 날 400 NO_CHANGE · 차량 문서·버전 링·감사 그대로',
      R87.A.ok, JSON.stringify(R87.A.info));
    T('87 P1 판2 ② 배정표 차량 담당(차량 보기) 저장: 검사 지시 = insp_due만 2026-10-31→2027-10-31(보험·차번호·소유·보험사·다른 차 그대로 · updated 오늘 KST · updated_by u87a · 응답 vehicle{id,field,value,prev,updated}) · 버전 링 = 바꾸기 전 문서 · 감사 1줄(col vehicles · op 수정 · f insp_due [이전, 새] · 배정 담당) · 보험 지시 = ins_due만 · 칸이 이미 바뀐 다시 지시(:re:) = 403 DATE_MOVED',
      R87.B.ok, JSON.stringify(R87.B.info));
    T('87 P1 판2 ③ 차량 수행 갈래: 직원(veh do · 담당 아님) = 그 지시 칸 200 · 관리자 = 칸이 이미 바뀐 지시도·지금보다 이른 날(2026-08-01)도 200(확인 문구는 앱) · 그 칸만',
      R87.C.ok, JSON.stringify(R87.C.info));
    T('87 P1 판2 ④ 다시 지시 규칙 vehRedo(오늘 2026-11-13 고정): 지남 + 그 만료일 지시 완료 + 진행 0 + 이번 달 키 없음 = A·G(지난달 다시 지시도 완료)·K(어제 만료) → ":re:2026-11"(제목 "<차번호> 정기검사 갱신 — 다시(완료 뒤 만기일 그대로)"·차번호 없음 "차량" · 기한 = 만료일 · days −13) / 진행 중 다시 지시(B)·회색(C)·지시 없음(D)·안 지남(E)·이번 달 키 있음(지운 것 F)·승인 대기(H)·지운 차(I)·지운 지시만(J)·오늘 만료(L — 아직 안 지남) = 없음 · 빈 차량·지시 없음 = 0건',
      R87.D.ok, JSON.stringify(R87.D.info));
    T('87 P1 판2 ⑤ autotask_ingest 갈래: 봇 항목 0이어도 서버가 센 다시 지시 1건(veh:r1:insp:2020-01-31:re:<이번 달 KST> · 담당 = 배정표 u87a · who_by assign · 열림 · 기한 2020-01-31 · from 자동) · 검사보류(회색) 차 제외 · 스위치 없음(dry)이어도 만듦(D-30 차량 규칙과 같이 스위치 무관) · 응답 redo 1·made 1 · 감사 "차량 다시 지시 1" · 다시 부르면 redo 0·겹침 없음',
      R87.E.ok, JSON.stringify(R87.E.info));
    T('87 P1 판2 ⑦ 검토 S1 만기일 보호(save vehicles): veh_due_set 표식 {prev 2026-10-31, at = 응답 updated_at} · 표식 모르는 낡은 사본(insp_due 바꾸기 전 날짜 + 다른 차 메모) 저장 = 새 만기일 2027-10-31 그대로·표식 이어 감·다른 차 고침 들어감·감사 "만기일 보호" · 표식 아는 사본의 되돌림 = 받음 · 표식 모르는 사본의 다른 날짜(2026-12-31) = 받음',
      R87.F.ok, JSON.stringify(R87.F.info));
    T('87 P1 판2 ⑧ 검토 S2 쓰기 직전 다시 읽기: 버전 링 스냅샷 중 끝난 다른 차 저장(메모 · updated_at 바뀜) = 그 고침 그대로 + 새 만기일 · 그 사이 같은 칸이 바뀜 = 409 VEH_DUE_STALE·그 값 그대로',
      R87.G.ok, JSON.stringify(R87.G.info));
    T('87 P1 판2 ⑥ 결함 사본 ' + (Object.keys(MUT87).reduce((s, k) => s + MUT87[k].length, 0) + AMUT87.length) + '개(담당 검사·배정표 검사·날짜 칸 검사·완료 거절·날짜 꼴 느슨 · 칸 고정 insp·updated 안 씀·감사 이전 값·버전 링 걷음 · 차량 수행을 관리자만 · ingest 갈래 걷음·겹침 검사 걷음 · 규칙: 회색·지남 경계·진행 중·이번 달 키·지운 지시·완료 조건 · 검토 S1: 보호 걷음·표식 무시·사람 편집도 막음·표식 안 남김·감사 걷음 · S2: 다시 읽기 걷음·409 걷음) = 모두 ✗',
      kill87.length === 0, kill87.join(' | '));
  } finally { reset87(); }
}

// 89 체크 29 월말명세서 1단계 판①(gw-stmt.js·_lib/stmt.js — 시안 v2, PM 11/10 18:13 '추천대로 ㄱ' · 11/10 독립 검토 2관점 34건 반영): 권한(관리자 수행 · perms.stmt do/view · 값 없으면 숨김 · 기기 승인 먼저 · 퇴사) /
//    ⑯ 29 판⑤ — 전달함 표시 stmt_sent(묶음↔길·확정만·낡은 판 409·전부 아니면 안 씀·전달 기록·되돌리기) + 결재 kind '월말명세서'(③·정정 흡수·수행 권한·ref 꼴)
//    거래처 목록(시드 12곳·낙관락·지우기·묶음 바꾸기 금지·NO_CHANGE) / 저장 정리(월 밖 날짜·개인정보 꼴·없는 거래처·없는 차량·낡은 base) · 서버 검산 · 확정·전달 막기(NOT_BALANCED) ·
//    초안 짝(DRAFT_EXISTS·DRAFT_ON_FINAL)·확정 때·확정 뒤 고칠 때 간극 1줄·확정 풀 때 reopen(값 없음·해시 체인·깨진 기록은 안 덮음) · 월 색인(부가세 포함 한 기준)·다시 만들기(접두어) ·
//    되돌리기(한 판·초안까지) · 차량 별칭(정규화·끝 4자리 감사) · 차량별 이력(확정분만) · 차량 대조(veh 권한) · 잔액형 4칸 · 읽기 실패면 덮지 않음 · 순수 규칙 경계(허용 오차·세 기준·소수 자릿수·객체 오염)
{
  const gws89 = require(join(FN, 'gw-stmt.js'));
  const S89 = require(join(FN, '_lib/stmt.js'));
  const zlib89 = require('zlib');
  async function cs89(body, tok, dev, raw) {
    const r = await gws89.handler(raw || { httpMethod: 'POST', headers: Object.assign({ authorization: tok ? 'Bearer ' + tok : '' }, dev ? { 'x-device-id': dev } : {}), body: JSON.stringify(body) });
    return { code: r.statusCode, body: JSON.parse(r.body || '{}') };
  }
  const keep89 = {}; Object.keys(mem.gw_data).forEach((k) => { if (/^(stmt:|stmtidx:|clog:stmt:)/.test(k)) keep89[k] = mem.gw_data[k]; });
  const vehKeep89 = mem.gw_data['col:vehicles'];
  const savedUsers89 = Object.assign({}, mem.gw_users);
  const audit89 = auditMock.logs.length;
  try {
    // 차량 목록 표본(저장·별칭은 목록에 있는 id만 받음) — veh_a·veh_b(시험 줄) + 대조 표본 7대(⑫)
    mem.gw_data['col:vehicles'] = { schema: 1, items: [
      { id: 'veh_a', no: '11가0001', own: '자차', state: '운행', type: '덤프', note: '' },
      { id: 'veh_b', no: '22나0002', own: '지입', state: '운행', type: '트랙터', note: '' },
      { id: 'v12가1111', no: '12가1111', own: '자차', state: '운행', type: '덤프', driver: '기사갑', insurer: '보험사', note: '' },
      { id: 'v34나2222', no: '56다3333(구2222)', own: '자차', state: '운행', type: '덤프', driver: '기사을', insurer: '', note: '' },
      { id: 'v78라7900', no: '91마4444', own: '자차', state: '운행', type: '카고트럭', driver: '', insurer: '', note: '번호 바뀜' },
      { id: 'v55바5555', no: '55바5555', own: '지입', state: '운행', type: '트랙터', driver: '차주병', insurer: '', note: '구 8419' },
      { id: 'v66사6666', no: '66사6666', own: '자차', state: '운행', type: '덤프', note: '' },
      { id: 'v77아6666', no: '77아6666', own: '자차', state: '매각', type: '덤프', note: '' },
      { id: 'v88자8888', no: '88자8888', own: '자차', state: '운행', type: '덤프', note: '', del: 1 }
    ] };
    const V89 = { id: 'uview89', name: '보기89', admin: false, perms: { stmt: 'view' } };
    const D89 = { id: 'udo89', name: '수행89', admin: false, perms: { stmt: 'do' } };
    const NV89 = { id: 'unoveh89', name: '차량숨김89', admin: false, perms: { stmt: 'view', veh: 'hide' } };
    const RT89 = { id: 'uret89', name: '퇴사89', admin: false, perms: { stmt: 'do' }, leave_date: '2020-01-01' };
    mem.gw_users['member:uview89'] = V89; mem.gw_users['member:udo89'] = D89; mem.gw_users['member:unoveh89'] = NV89; mem.gw_users['member:uret89'] = RT89;
    const tV89 = issueSession(V89).token, tD89 = issueSession(D89).token, tNV89 = issueSession(NV89).token, tRT89 = issueSession(RT89).token;
    // ① 권한 — 모르는 동작 400(로그인 전) · 비로그인 401 · 퇴사 401 · 기기 미승인 403(권한보다 먼저 — 숨김 회원도) · stmt 값 없음 = 숨김 · 보기 = 읽기만(쓰기 5종 전부 NO_WRITE) · 수행 200
    const p89 = [await cs89({ action: 'nope' }, tokA), await cs89({ action: 'stmt_cfg_get' }, null), await cs89({ action: 'stmt_cfg_get' }, tRT89, 'dev1'),
      await cs89({ action: 'stmt_cfg_get' }, tD89), await cs89({ action: 'stmt_cfg_get' }, tokW), await cs89({ action: 'stmt_cfg_get' }, tokW, 'dev1'),
      await cs89({ action: 'stmt_cfg_get' }, tV89, 'dev1'), await cs89({ action: 'stmt_cfg_get' }, tD89, 'dev1')];
    const vw89 = [];
    for (const a of ['stmt_cfg_set', 'stmt_save', 'stmt_revert', 'stmt_reindex', 'stmt_alias_set']) vw89.push((await cs89({ action: a, ym: '2026-10', vk: 'v05', base: 0 }, tV89, 'dev1')).body.error_code);
    T('89 ① 월말명세서 권한: 모르는 동작 400 · 비로그인 401 · 퇴사 401 · 기기 미승인 403 DEVICE_NOT_APPROVED(수행·숨김 회원 모두 — 권한보다 먼저) · stmt 값 없는 직원 403 NO_ACCESS(PERM_CLOSED에 기대지 않음) · 보기 = 읽기 200·쓰기 5종 NO_WRITE · 수행 200',
      p89[0].code === 400 && p89[0].body.error_code === 'UNKNOWN_ACTION' && p89[1].code === 401 && p89[2].code === 401 && p89[3].code === 403 && p89[3].body.error_code === 'DEVICE_NOT_APPROVED'
      && p89[4].code === 403 && p89[4].body.error_code === 'DEVICE_NOT_APPROVED' && p89[5].code === 403 && p89[5].body.error_code === 'NO_ACCESS' && p89[6].code === 200 && p89[7].code === 200
      && vw89.every((x) => x === 'NO_WRITE'),
      p89.map((x) => x.code + '/' + (x.body.error_code || '')).join(' ') + ' · ' + vw89.join(','));
    // ② 거래처 목록 — 시드 12곳 · 낡은 base 409 · 더하기 200 · 지우기 VENDOR_REMOVED · 묶음 바꾸기 GROUP_LOCKED · 같은 값 NO_CHANGE · 이름 바꾸면 감사 'a→b' · 설정 읽기 실패 = 500(시드로 그리지 않음)
    const c89 = await cs89({ action: 'stmt_cfg_get' }, tokA);
    const seed89 = c89.body.vendors || [];
    const add89 = seed89.concat([{ vk: 'v13', name: '새주유소', group: 'veh', kind: 'fuel', basis: 'total', hint: ['새주유'] }]);
    const stale89 = await cs89({ action: 'stmt_cfg_set', vendors: add89, base: 5 }, tokA);
    const set89 = await cs89({ action: 'stmt_cfg_set', vendors: add89, base: 0 }, tokA);
    const rm89 = await cs89({ action: 'stmt_cfg_set', vendors: seed89, base: set89.body.updated_at }, tokA);
    const grp89 = await cs89({ action: 'stmt_cfg_set', vendors: set89.body.vendors.map((v) => v.vk === 'v05' ? Object.assign({}, v, { group: 'tool' }) : v), base: set89.body.updated_at }, tokA);
    const nc89 = await cs89({ action: 'stmt_cfg_set', vendors: set89.body.vendors, base: set89.body.updated_at }, tokA);
    const ren89 = await cs89({ action: 'stmt_cfg_set', vendors: set89.body.vendors.map((v) => v.vk === 'v13' ? Object.assign({}, v, { name: '새주유소2' }) : v), base: set89.body.updated_at }, tokA);
    const renAud89 = auditMock.logs.slice(audit89).filter((x) => x.col === 'stmt' && x.ev[0].op === '명세서거래처').map((x) => x.ev[0].t);
    blobsMock.hooks.failGet = (k) => k === 'stmt:cfg';
    const cf89 = await cs89({ action: 'stmt_cfg_get' }, tokA);
    blobsMock.hooks.failGet = null;
    T('89 ② 거래처 목록: 시드 12곳(veh 9·tool 3 · v05 basis total · v01·v10·v11 잔액형) · 낡은 base 409 · v13 더함 200(prev 없음) · 지우기 VENDOR_REMOVED · 묶음 바꾸기 GROUP_LOCKED · 같은 값 NO_CHANGE · 이름 바꾸기 200·감사 "v13 새주유소→새주유소2" · 읽기 실패 500',
      c89.code === 200 && c89.body.seeded === true && c89.body.updated_at === 0 && seed89.length === 12 && seed89.filter((v) => v.group === 'veh').length === 9 && seed89.filter((v) => v.group === 'tool').length === 3
      && seed89[4].vk === 'v05' && seed89[4].basis === 'total' && ['v01', 'v10', 'v11'].every((vk) => seed89.find((v) => v.vk === vk).carry === true)
      && stale89.code === 409 && set89.code === 200 && set89.body.vendors.length === 13 && rm89.body.error_code === 'VENDOR_REMOVED' && grp89.body.error_code === 'GROUP_LOCKED'
      && nc89.body.error_code === 'NO_CHANGE' && ren89.code === 200 && renAud89.some((t) => t.indexOf('v13 새주유소→새주유소2') >= 0) && cf89.code === 500,
      JSON.stringify([c89.code, seed89.length, stale89.code, set89.code, rm89.body.error_code, grp89.body.error_code, nc89.body.error_code, ren89.code, cf89.code]));
    // ③ 저장 정리 — 월 밖 날짜(at) · 비고 휴대폰 PII · 없는 거래처 · 키 꼴 · 월 꼴 · 낡은 base · 목록에 없는 차량 UNKNOWN_VEH · '__proto__' 차량 BAD_VEH · 숫자만 줄 id BAD_RID · 천 단위 아닌 쉼표 BAD_MONEY — 아무것도 안 씀
    const row89 = (o) => Object.assign({ date: '2026-10-01', veh: 'veh_a', vraw: '5288', item: '초저유황경유', kind: 'fuel', qty: '100', unit: '1650', amt: 165000, how: 'ocr' }, o);
    const e89 = [await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [row89({}), row89({ date: '2026-09-30' })] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [row89({ note: '기사 010-1234-5678' })] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v99', base: 0, rows: [] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: '대송', base: 0, rows: [] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-13', vk: 'v05', base: 0, rows: [] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 7, rows: [] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [row89({ veh: 'veh_zz' })] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [row89({ veh: '__proto__' })] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [row89({ r: '01012345678' })] }, tokA),
      await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [row89({ amt: '1,2,3,4' })] }, tokA)];
    T('89 ③ 저장 정리: ROW_MONTH(at 1) · PII_1 · UNKNOWN_VENDOR · BAD_VK · BAD_YM · 409 · 목록에 없는 차량 UNKNOWN_VEH · __proto__ BAD_VEH · 숫자 줄 id BAD_RID · "1,2,3,4" BAD_MONEY — 저장 0',
      e89[0].body.error_code === 'ROW_MONTH' && e89[0].body.at === 1 && e89[1].body.error_code === 'PII_1' && e89[2].body.error_code === 'UNKNOWN_VENDOR' && e89[3].body.error_code === 'BAD_VK'
      && e89[4].body.error_code === 'BAD_YM' && e89[5].code === 409 && e89[6].body.error_code === 'UNKNOWN_VEH' && e89[7].body.error_code === 'BAD_VEH' && e89[8].body.error_code === 'BAD_RID'
      && e89[9].body.error_code === 'BAD_MONEY' && !mem.gw_data['stmt:2026-10:v05'] && ({}).fuel === undefined,
      e89.map((x) => x.code + '/' + x.body.error_code).join(' '));
    // ④ 초안 짝 + 작성 중 저장 → 서버 검산(셋째 줄 차량 없음) · 색인 한 줄 · 확정·전달 막기 NOT_BALANCED(검산 결과 같이) · 초안 다시 = DRAFT_EXISTS · 확정 요청에 초안 = DRAFT_ON_FINAL
    const draft89 = [row89({ r: 'd1' }), row89({ r: 'd2', date: '2026-10-02', veh: 'veh_b', vraw: '7900', qty: '50.5', amt: 83325 }), row89({ r: 'd3', date: '2026-10-03', veh: '', vraw: '1234', item: '요소수', kind: 'urea', qty: '2', unit: '10000', amt: 20000 })];
    const inv89 = { date: '2026-10-31', supply: 243932, vat: 24393, total: 268325 };
    const s1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: draft89, draft_rows: draft89, inv: inv89, stated: '268,325', src: [{ kind: 'scan', name: 'C:\\x\\대송ic주유소-26.10.pdf', pages: 3 }, { kind: 'scan', name: '20261102094123.pdf', pages: 1 }] }, tD89, 'dev1');
    const at1 = s1.body.doc && s1.body.doc.updated_at;
    const ix1 = mem.gw_data['stmtidx:2026-10'];
    const dn1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at1, rows: draft89, inv: inv89, stated: 268325, status: 'done' }, tD89, 'dev1');
    const sn1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at1, rows: draft89, inv: inv89, stated: 268325, status: 'sent' }, tD89, 'dev1');
    const dx1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at1, rows: draft89, draft_rows: draft89 }, tD89, 'dev1');
    const df1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at1, rows: draft89, draft_rows: draft89, redraft: true, status: 'done' }, tD89, 'dev1');
    T('89 ④ 작성 중 저장 200(초안 3줄·how ocr 3 · 파일 이름 경로 뺌·긴 숫자 … · 명세 합계 "268,325" 받음 · 검산: 셋째 줄 veh 붉음, 합계 = 계산서 = 명세 합계) · 색인 v05 줄 3·붉음 1 · 확정·전달 400 NOT_BALANCED + checks · DRAFT_EXISTS · 확정 요청 초안 DRAFT_ON_FINAL',
      s1.code === 200 && s1.body.doc.draft.rows.length === 3 && s1.body.doc.draft.how.ocr === 3 && s1.body.doc.src[0].name === '대송ic주유소-26.10.pdf' && s1.body.doc.src[1].name === '….pdf'
      && s1.body.doc.stated === 268325 && s1.body.doc.status === 'doing' && s1.body.checks.ok === false && s1.body.checks.bad.length === 1 && s1.body.checks.bad[0].r === 'd3' && s1.body.checks.bad[0].why[0] === 'veh'
      && s1.body.checks.inv_diff === 0 && s1.body.checks.stated_diff === 0 && s1.body.doc.rows[1].qd === 1 && s1.body.idx === true && ix1 && ix1.vendors.v05.rows === 3 && ix1.vendors.v05.bad === 1
      && dn1.code === 400 && dn1.body.error_code === 'NOT_BALANCED' && dn1.body.checks.bad.length === 1 && sn1.body.error_code === 'NOT_BALANCED'
      && dx1.body.error_code === 'DRAFT_EXISTS' && df1.body.error_code === 'DRAFT_ON_FINAL' && mem.gw_data['stmt:2026-10:v05'].updated_at === at1,
      JSON.stringify({ s1: [s1.code, s1.body.error_code, s1.body.checks && s1.body.checks.bad], dn1: dn1.body.error_code, sn1: sn1.body.error_code, dx1: dx1.body.error_code, df1: df1.body.error_code }));
    // ⑤ 사람이 고침(셋째 줄 차량 고름·둘째 줄 품목 글) → 확정 200 → 간극(문서에서 셈): 읽기 18 중 1(번호 글 vraw 포함) · 차량 2 중 0(초안 빈 칸은 분모 밖) · 종류 3 중 0 · clog 1줄 final(값 없음)
    const fin89 = draft89.map((x) => Object.assign({}, x)); fin89[2].veh = 'veh_a'; fin89[1].item = '경유';
    const s2 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at1, rows: fin89, inv: inv89, stated: 268325, status: 'done' }, tD89, 'dev1');
    const cl89 = mem.gw_data['clog:stmt:2026-10'];
    const g89 = await cs89({ action: 'stmt_gap', ym: '2026-10' }, tV89, 'dev1');
    const gv = g89.body.vendors && g89.body.vendors.v05;
    const clogTxt = JSON.stringify(cl89 || {});
    T('89 ⑤ 확정 200(checks ok · draft 보존) → clog 1줄 op final(값 없음) · 간극 요약(보기 권한, 문서에서 셈): 읽기 18 중 1 · 차량 2 중 0 · 종류 3 중 0 · 줄 3/3 · chain_ok',
      s2.code === 200 && s2.body.checks.ok === true && s2.body.doc.status === 'done' && s2.body.doc.draft.rows[2].veh === '' && s2.body.gap === true
      && cl89 && cl89.items.length === 1 && cl89.items[0].op === 'final' && clogTxt.indexOf('165000') < 0 && clogTxt.indexOf('경유') < 0 && cl89.items[0].changed.read === 1
      && g89.code === 200 && gv && gv.filled.read === 18 && gv.changed.read === 1 && gv.filled.veh === 2 && gv.changed.veh === 0 && gv.filled.kind === 3 && gv.changed.kind === 0
      && gv.rows.draft === 3 && gv.rows.final === 3 && gv.rows.deleted === 0 && gv.rows.added === 0 && g89.body.chain_ok === true && g89.body.n === 1,
      JSON.stringify({ s2: [s2.code, s2.body.error_code, s2.body.gap], gv: gv, chain: g89.body.chain_ok }));
    cl89.items[0].changed.read = 9;
    const g89b = await cs89({ action: 'stmt_gap', ym: '2026-10' }, tokA);
    cl89.items[0].changed.read = 1;
    T('89 ⑤-2 간극 기록을 손으로 고치면 chain_ok false(해시 체인) · 요약 값은 문서에서 세어 그대로(읽기 1)', g89b.code === 200 && g89b.body.chain_ok === false && g89b.body.vendors.v05.changed.read === 1, String(g89b.body.chain_ok));
    // ⑥ 월 보드·차량별 이력(확정분만 — 작성 중은 pending)·색인 다시 만들기(다른 달 문서는 접두어로 거름)
    const m89 = await cs89({ action: 'stmt_month', ym: '2026-10' }, tV89, 'dev1');
    const o06 = await cs89({ action: 'stmt_save', ym: '2026-11', vk: 'v06', base: 0, rows: [row89({ date: '2026-11-02', amt: 165000 })], stated: 165000 }, tokA);
    const p06 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v06', base: 0, rows: [row89({ date: '2026-10-05', amt: 165000 })], stated: 1 }, tokA);
    const vh89 = await cs89({ action: 'stmt_veh', veh: 'veh_a', to: '2026-11', n: 3 }, tV89, 'dev1');
    delete mem.gw_data['stmtidx:2026-10'];
    const ri89 = await cs89({ action: 'stmt_reindex', ym: '2026-10' }, tD89, 'dev1');
    const mo89 = vh89.body.months || [];
    const oct89 = mo89.find((m) => m.ym === '2026-10'), nov89 = mo89.find((m) => m.ym === '2026-11');
    T('89 ⑥ 월 보드(v05 ok·done·거래처 13곳) · 차량별 이력 veh_a: 10월 = 대송 확정분만(주유 1건 165,000 + 요소수 1건 20,000 = 185,000) · 영남 10월 붉은 작성 중 = pending · 11월 = 영남 작성 중만 pending · 색인 지운 뒤 reindex = 10월 v05·v06만(11월 v06 안 섞임)',
      m89.code === 200 && m89.body.vendors.v05.ok === true && m89.body.vendors.v05.status === 'done' && m89.body.cfg.length === 13 && o06.code === 200 && p06.code === 200
      && vh89.code === 200 && oct89 && oct89.kinds.fuel[0] === 1 && oct89.kinds.fuel[1] === 165000 && oct89.kinds.urea[1] === 20000 && oct89.total === 185000 && oct89.vendors.join() === 'v05' && oct89.pending.join() === 'v06'
      && nov89 && nov89.total === 0 && nov89.pending.join() === 'v06' && ri89.code === 200 && Object.keys(ri89.body.vendors).sort().join() === 'v05,v06' && ri89.body.vendors.v05.rows === 3
      && mem.gw_data['stmtidx:2026-10'].vendors.v05.veh.veh_a.fuel[1] === 165000,
      JSON.stringify({ m: m89.code, mo: mo89, ri: ri89.body.vendors && Object.keys(ri89.body.vendors) }));
    // ⑦ 확정 뒤 고침(done → done, 줄 바뀜) = 간극 1줄 더 · status 빼고 검산 실패 판 = NOT_BALANCED(확정 그대로) · status:'doing' 명시 = 확정 풀기 + reopen 1줄
    const at5 = mem.gw_data['stmt:2026-10:v05'].updated_at;
    const fin89b = fin89.map((x) => Object.assign({}, x)); fin89b[0].vraw = '5268';
    const s3 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at5, rows: fin89b, inv: inv89, stated: 268325 }, tD89, 'dev1');
    const fin89c = fin89b.map((x) => Object.assign({}, x)); fin89c[0].amt = 165001;
    const s4 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: s3.body.doc && s3.body.doc.updated_at, rows: fin89c, inv: inv89, stated: 268325 }, tD89, 'dev1');
    const s5 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: s3.body.doc && s3.body.doc.updated_at, rows: fin89c, inv: inv89, stated: 268325, status: 'doing' }, tD89, 'dev1');
    const ops89 = (mem.gw_data['clog:stmt:2026-10'].items || []).map((x) => x.op + (x.op === 'final' ? ':' + x.changed.read : '')).join(',');
    T('89 ⑦ 확정 뒤 줄 고침(status 빼면 done 유지) = 간극 1줄 더(읽기 2 — 번호 글 포함) · 검산 실패 판을 status 없이 = 400 NOT_BALANCED · status doing 명시 = 200 + reopen · 기록 = final:1,final:2,reopen',
      s3.code === 200 && s3.body.doc.status === 'done' && s3.body.gap === true && s4.code === 400 && s4.body.error_code === 'NOT_BALANCED' && s5.code === 200 && s5.body.doc.status === 'doing' && s5.body.gap === true
      && ops89 === 'final:1,final:2,reopen',
      JSON.stringify({ s3: [s3.code, s3.body.error_code], s4: s4.body.error_code, s5: [s5.code, s5.body.error_code], ops: ops89 }));
    // ⑧ 되돌리기 — 낡은 base 409 · 직전 판(확정 판)으로: 검산 통과면 done 그대로 · 두 번째 NO_PREV · 재판독(redraft) 뒤 되돌리면 초안도 옛 판으로
    const at6 = mem.gw_data['stmt:2026-10:v05'].updated_at;
    const rvS = await cs89({ action: 'stmt_revert', ym: '2026-10', vk: 'v05', base: at6 - 1 }, tD89, 'dev1');
    const rv1 = await cs89({ action: 'stmt_revert', ym: '2026-10', vk: 'v05', base: at6 }, tD89, 'dev1');
    const rv2 = await cs89({ action: 'stmt_revert', ym: '2026-10', vk: 'v05', base: rv1.body.doc && rv1.body.doc.updated_at }, tD89, 'dev1');
    const d07a = [row89({ r: 'a1', date: '2026-10-07' })], d07b = [row89({ r: 'b1', date: '2026-10-07', vraw: '9999' })];
    const q1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v07', base: 0, rows: d07a, draft_rows: d07a, stated: 165000 }, tokA);
    const q2 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v07', base: q1.body.doc.updated_at, rows: d07b, draft_rows: d07b, redraft: true, stated: 165000 }, tokA);
    const q3 = await cs89({ action: 'stmt_revert', ym: '2026-10', vk: 'v07', base: q2.body.doc.updated_at }, tokA);
    T('89 ⑧ 되돌리기: 낡은 base 409 · 직전 판(확정·검산 통과) = done · prev 비움 · 두 번째 NO_PREV · 재판독 뒤 되돌리면 초안도 a1 판(간극 짝 유지)',
      rvS.code === 409 && rv1.code === 200 && rv1.body.doc.status === 'done' && rv1.body.checks.ok === true && rv1.body.doc.prev === null && rv2.body.error_code === 'NO_PREV'
      && q2.code === 200 && q2.body.doc.draft.rows[0].r === 'b1' && q3.code === 200 && q3.body.doc.draft.rows[0].r === 'a1' && q3.body.doc.rows[0].r === 'a1',
      JSON.stringify([rvS.code, rv1.code, rv1.body.doc && rv1.body.doc.status, rv2.body.error_code, q3.code, q3.body.doc && q3.body.doc.draft && q3.body.doc.draft.rows[0].r]));
    // ⑨ 차량 별칭 — 정규화 열쇠 · 목록에 없는 차량 UNKNOWN_VEH · 같은 값 NO_CHANGE · 지우기 · 이상한 raw 400 · 감사는 번호·차량 모두 끝 4자리만
    const a0 = await cs89({ action: 'stmt_alias_set', raw: '경북 12가-7900', veh: 'veh_zz', base: 0 }, tD89, 'dev1');
    const a1 = await cs89({ action: 'stmt_alias_set', raw: '경북 12가-7900', veh: 'v78라7900', base: 0 }, tD89, 'dev1');
    const a2 = await cs89({ action: 'stmt_alias_set', raw: '경북12가7900', veh: 'v78라7900', base: a1.body.updated_at }, tD89, 'dev1');
    const a3 = await cs89({ action: 'stmt_alias_set', raw: '경북12가 7900', veh: '', base: a1.body.updated_at }, tD89, 'dev1');
    const a4 = await cs89({ action: 'stmt_alias_set', raw: { toString: 1 }, veh: '', base: 0 }, tD89, 'dev1');
    const ag = await cs89({ action: 'stmt_alias_get' }, tV89, 'dev1');
    T('89 ⑨ 차량 별칭: 목록에 없는 차량 UNKNOWN_VEH · 열쇠 = 경북12가7900 · 같은 값 NO_CHANGE · 빈 veh = 지움 · raw가 객체 = 400 BAD_RAW(500 아님) · 보기 권한 읽기',
      a0.body.error_code === 'UNKNOWN_VEH' && a1.code === 200 && a1.body.map['경북12가7900'] === 'v78라7900' && a2.body.error_code === 'NO_CHANGE' && a3.code === 200 && !('경북12가7900' in a3.body.map)
      && a4.code === 400 && a4.body.error_code === 'BAD_RAW' && ag.code === 200 && Object.keys(ag.body.map).length === 0,
      JSON.stringify({ a0: a0.body.error_code, a1: a1.code, a2: a2.body.error_code, a3: a3.code, a4: [a4.code, a4.body.error_code] }));
    // ⑩ 잔액형(스피드 v01 — 공급가+세액) · 원장 4칸(전기이월 + 당월 − 입금 = 잔액, 당월 = 줄 합 부가세 포함) · 4칸 없이 확정 = no_carry · 잔액 틀림 = carry · 당월 틀림 = carry_month
    const tr89 = { r: 't1', date: '2026-10-05', veh: 'veh_a', vraw: '0001', item: '타이어 펑크수리', kind: 'tire', qty: '1', unit: '20000', amt: 20000, vat: 2000, how: 'hand', tire: { pos: '운전석 3축 안쪽', act: 'puncture' } };
    const inv01 = { date: '2026-10-31', supply: 20000, vat: 2000, total: 22000 };
    const sp0 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v01', base: 0, rows: [tr89], inv: inv01, status: 'done' }, tokA);
    const sp1 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v01', base: 0, rows: [tr89], inv: inv01, carry: { prev: 50000, month: 22000, paid: 50000, bal: 22000 }, status: 'done' }, tokA);
    const b1 = sp1.body.doc && sp1.body.doc.updated_at;
    const sp2 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v01', base: b1, rows: [tr89], inv: inv01, carry: { prev: 50000, month: 22000, paid: 50000, bal: 21000 }, status: 'doing' }, tokA);
    const sp3 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v01', base: sp2.body.doc && sp2.body.doc.updated_at, rows: [tr89], inv: inv01, carry: { prev: 50000, month: 22002, paid: 50000, bal: 22002 } }, tokA);
    T('89 ⑩ 잔액형 v01: 원장 4칸 없이 확정 400 NOT_BALANCED(no_carry) · 50,000 + 22,000 − 50,000 = 22,000 → 확정 200(타이어 위치·조치) · 잔액 21,000 = carry · 당월 22,002 = carry_month(공급가+세액 명세는 0원)',
      sp0.code === 400 && sp0.body.checks.issues.indexOf('no_carry') >= 0 && sp1.code === 200 && sp1.body.checks.ok === true && sp1.body.checks.carry_ok === true && sp1.body.doc.rows[0].tire.act === 'puncture'
      && sp2.code === 200 && sp2.body.checks.issues.indexOf('carry') >= 0 && sp3.code === 200 && sp3.body.checks.issues.indexOf('carry_month') >= 0 && sp3.body.checks.carry_ok === true,
      JSON.stringify([sp0.code, sp0.body.checks && sp0.body.checks.issues, sp1.code, sp2.body.checks && sp2.body.checks.issues, sp3.body.checks && sp3.body.checks.issues]));
    // ⑪ 읽기 실패·깨진 값 — 문서 읽기 실패면 쓰지 않음 · 깨진 색인 = 500 IDX_INVALID(빈 달로 안 그림)·reindex로 복구 · 깨진 간극 기록은 안 덮음(gap false·chain_ok false) · gzip 압축 폭탄 = 400(로그인 전, 6MB 상한)
    const before89 = JSON.stringify(mem.gw_data['stmt:2026-10:v05']);
    blobsMock.hooks.failGet = (k) => k === 'stmt:2026-10:v05';
    const rf89 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: 0, rows: [] }, tokA);
    blobsMock.hooks.failGet = null;
    const rfSame89 = JSON.stringify(mem.gw_data['stmt:2026-10:v05']) === before89;
    mem.gw_data['stmtidx:2026-10'] = { vendors: 'broken' };
    const bi89 = await cs89({ action: 'stmt_month', ym: '2026-10' }, tokA);
    const bi89b = await cs89({ action: 'stmt_reindex', ym: '2026-10' }, tokA);
    const clKeep = mem.gw_data['clog:stmt:2026-10'];
    mem.gw_data['clog:stmt:2026-10'] = { items: { x: 1 }, head: 'deadbeef' };
    const at7 = mem.gw_data['stmt:2026-10:v05'].updated_at;
    const bc89 = await cs89({ action: 'stmt_save', ym: '2026-10', vk: 'v05', base: at7, rows: fin89, inv: inv89, stated: 268325, status: 'done' }, tokA);
    const bcg = await cs89({ action: 'stmt_gap', ym: '2026-10' }, tokA);
    const bcKept = JSON.stringify(mem.gw_data['clog:stmt:2026-10']) === JSON.stringify({ items: { x: 1 }, head: 'deadbeef' });
    mem.gw_data['clog:stmt:2026-10'] = clKeep;
    const bomb = zlib89.gzipSync(Buffer.alloc(7 * 1024 * 1024, 32)).toString('base64');
    const gz89 = await cs89(null, null, null, { httpMethod: 'POST', headers: { 'x-gw-enc': 'gzip' }, isBase64Encoded: true, body: bomb });
    T('89 ⑪ 문서 읽기 실패 500 DOC_READ_FAILED·저장값 그대로 · 깨진 색인 500 IDX_INVALID → reindex 200 · 깨진 간극 기록 = 확정 200·gap false·기록 그대로·chain_ok false · 7MB로 풀리는 gzip = 400 INVALID_JSON',
      rf89.code === 500 && rf89.body.error_code === 'DOC_READ_FAILED' && rfSame89
      && bi89.code === 500 && bi89.body.error_code === 'IDX_INVALID' && bi89b.code === 200 && bc89.code === 200 && bc89.body.gap === false && bcKept && bcg.body.chain_ok === false
      && gz89.code === 400 && gz89.body.error_code === 'INVALID_JSON',
      JSON.stringify({ rf: [rf89.code, rf89.body.error_code, rfSame89], bi: [bi89.code, bi89.body.error_code, bi89b.code], bc: [bc89.code, bc89.body.gap, bcKept, bcg.body.chain_ok], gz: [gz89.code, gz89.body.error_code] }));
    // ⑫ 차량 대조 stmt_match — 별칭 → 현재 번호 → 옛 번호('(구…)'·id·비고) → 끝 4자리 · 겹치면 multi · 지운 차 빠짐 · 고르기 목록에 기사·보험·비고·번호 칸 없음(id = 'v'+전체 번호라 veh 권한 필요) · veh 숨김 = 403
    const al89 = await cs89({ action: 'stmt_alias_set', raw: '9999', veh: 'v12가1111', base: mem.gw_data['stmt:alias:veh'] ? mem.gw_data['stmt:alias:veh'].updated_at : 0 }, tD89, 'dev1');
    const mt89 = await cs89({ action: 'stmt_match', raws: ['1111호', '12가 1111', '3333', '2222호', '7900', '78라7900', '8419', '6666', '8888', '9999', '12', ''] }, tV89, 'dev1');
    const nv89 = await cs89({ action: 'stmt_match', raws: [] }, tNV89, 'dev1');
    const nv89b = [await cs89({ action: 'stmt_month', ym: '2026-10' }, tNV89, 'dev1'), await cs89({ action: 'stmt_get', ym: '2026-10', vk: 'v05' }, tNV89, 'dev1'), await cs89({ action: 'stmt_alias_get' }, tNV89, 'dev1'), await cs89({ action: 'stmt_veh', veh: 'veh_a' }, tNV89, 'dev1')];   // 29 판② 검토: 차량 숨김이면 명세서 읽기 전부 403(응답에 전체 번호 id가 실림)
    const mh = (mt89.body.matches || []).map((m) => m.how + ':' + (m.veh || m.cand.join('|')));
    const vl89 = JSON.stringify(mt89.body.vehicles || []);
    T('89 ⑫ 차량 대조: last4 · plate · 괄호 밖 현재 번호 last4 · (구2222) old4 · id 옛 번호 old4·old · 비고 "구 8419" old4 · 끝4 두 대 multi · 지운 차 none · 별칭 alias · 짧은 글·빈칸 none · 목록 8대(지운 차 빠짐)에 기사·보험·비고·번호 칸 없음 · veh 숨김 403 NO_VEH_ACCESS(29 판② — stmt_month·stmt_get·stmt_alias_get·stmt_veh 읽기도)',
      al89.code === 200 && mt89.code === 200 && mh.join(',') === ['last4:v12가1111', 'plate:v12가1111', 'last4:v34나2222', 'old4:v34나2222', 'old4:v78라7900', 'old:v78라7900', 'old4:v55바5555', 'multi:v66사6666|v77아6666', 'none:', 'alias:v12가1111', 'none:', 'none:'].join(',')
      && mt89.body.vehicles.length === 8 && !/기사|보험|차주|번호 바뀜|91마4444/.test(vl89) && mt89.body.vehicles.every((v) => !('no' in v) && !('driver' in v) && !('note' in v) && !('insurer' in v))
      && mt89.body.vehicles.find((v) => v.id === 'v78라7900').old4[0] === '7900' && mt89.body.vehicles.find((v) => v.id === 'v55바5555').own === '지입' && nv89.code === 403 && nv89.body.error_code === 'NO_VEH_ACCESS'
      && nv89b.every((x) => x.code === 403 && x.body.error_code === 'NO_VEH_ACCESS'),   // 29 판②: stmt_month·stmt_get·stmt_alias_get·stmt_veh도
      JSON.stringify({ al: al89.code, mt: mt89.code, mh: mh, nv: nv89.body.error_code }));
    // ⑬ 감사 — col stmt · 글에 금액 숫자 없음(쉼표 꼴 포함) · 별칭 감사의 번호·차량 id 끝 4자리만(전체 번호 없음)
    const aud89 = auditMock.logs.slice(audit89).filter((x) => x.col === 'stmt');
    const aliasAud = aud89.filter((x) => x.ev[0].op === '명세서차량별칭').map((x) => x.ev[0].t);
    T('89 ⑬ 감사: col stmt 줄 · 금액 글 없음(165000·165,000·268325·20000·83325) · 별칭 감사 3줄 모두 "…끝4 → 차량 …끝4"/(지움) 꼴(12가1111·78라7900·경북 없음)',
      aud89.length >= 15 && aud89.every((x) => !/165,?000|268,?325|20,?000|83,?325/.test(x.ev[0].t)) && aliasAud.length === 3
      && aliasAud.every((t) => /^…\d{4} → (차량 …\d{4}|\(지움\))$/.test(t)) && !aliasAud.some((t) => /12가1111|78라7900|경북/.test(t)),
      JSON.stringify({ n: aud89.length, alias: aliasAud }));
    // ⑭ 순수 규칙 경계(변이 잡기) — 줄 허용 오차(소수 자릿수)·할인 줄 · 세 기준(total·supvat·suponly)의 계산서·명세 합계·세액 허용 · 차량 소계 · 잔액형 · 종류·용도 · 달 이동 · 간극 빠진/더한 줄 · 객체 오염 · 숫자·글 정리 · 개인정보 꼴
    const R0 = (o) => Object.assign({ r: '', date: '', veh: 'veh_a', vraw: '', item: 'x', kind: 'fuel', use: '', qty: null, qd: 0, unit: null, ud: 0, amt: 0, vat: null, tire: null, how: 'hand', note: '' }, o);
    const CK = (rows, o, ven) => S89.checkDoc(Object.assign({ basis: 'total', group: 'veh', rows: rows, inv: null, stated: null, carry: null, vsub: null }, o || {}), ven || { group: 'veh' });
    const q30 = S89.decimal('30.30', 1e7);
    const t1 = [S89.rowIssues(R0({ qty: 30.3, qd: 2, unit: 1650, amt: 50000 }), 'veh').join(), S89.rowIssues(R0({ qty: 30.3, qd: 2, unit: 1650, amt: 50005 }), 'veh').join(),
      S89.rowIssues(R0({ qty: 30.3, qd: 2, unit: 1650, amt: 50010 }), 'veh').join(), S89.rowIssues(R0({ qty: 100, unit: 1650, amt: 165001 }), 'veh').join(), S89.rowIssues(R0({ qty: 1, unit: 5000, amt: -5000 }), 'veh').join()];
    T('89 ⑭-1 줄 검산: "30.30" = 30.3·소수 2자리 · 30.30×1,650: 50,000(차 5) 통과·50,005(차 10) 붉음(허용 9) · 50,010 붉음 · 정수×정수 1원 차 붉음(허용 0) · 할인 줄 −5,000 통과',
      q30 && q30.n === 30.3 && q30.d === 2 && t1[0] === '' && t1[1] === 'calc' && t1[2] === 'calc' && t1[3] === 'calc' && t1[4] === '', JSON.stringify(t1));
    const r12 = Array.from({ length: 12 }, () => R0({ kind: 'labor', amt: 20000, vat: 2000 }));
    const r12bad = r12.map((x, i) => i === 0 ? Object.assign({}, x, { amt: 20009 }) : x);
    const inv12 = { supply: 240000, vat: 24000, total: 264000 };
    const c14 = [CK([R0({ amt: 1000 })], { inv: { supply: 909, vat: 91, total: 1000 } }), CK([R0({ amt: 1001 })], { inv: { supply: 909, vat: 91, total: 1000 } }), CK([R0({ amt: 1000 })], { stated: 999 }),
      CK([R0({ amt: 1000 })], { inv: { supply: 909, vat: 90, total: 1000 } }), CK(r12, { basis: 'supply', inv: inv12, stated: 264000 }), CK(r12bad, { basis: 'supply', inv: inv12 }),
      CK(r12bad, { basis: 'supply', stated: 264000 }), CK(r12.map((x, i) => i < 12 ? Object.assign({}, x, { vat: 2001 }) : x), { basis: 'supply', inv: inv12 }),
      CK(r12.map((x) => Object.assign({}, x, { vat: 2001 })).map((x, i) => i === 0 ? Object.assign({}, x, { vat: 2002 }) : x), { basis: 'supply', inv: inv12 }),
      CK([R0({ kind: 'part', amt: 100000 })], { basis: 'supply', inv: { supply: 100000, vat: 10000, total: 110000 } }), CK([R0({ amt: 1000 })], {}), CK([], { stated: 0 })];
    T('89 ⑭-2 묶음 검산: total 계산서 0원(1원 차 inv) · 명세 합계 0원(stated) · 계산서 공급가+세액≠합계(inv_sum) · supvat 12줄 통과 · 공급가 9원 오독 = inv(세액 허용으로 덮지 않음)·명세 합계도 stated · 세액 합 +12(줄 수) 통과·+13 inv · suponly 계산서 공급가 대조·부가세 포함 110,000(추정 1줄) · 기준 없음 no_ref · 줄 0개 no_rows',
      c14[0].ok && c14[1].issues.join() === 'inv' && c14[2].issues.join() === 'stated' && c14[3].issues.indexOf('inv_sum') >= 0 && c14[4].ok && c14[4].mode === 'supvat'
      && c14[5].issues.join() === 'inv' && c14[5].sup_diff === 9 && c14[6].issues.join() === 'stated' && c14[7].ok && c14[7].vat_diff === 12 && c14[8].issues.join() === 'inv' && c14[8].vat_diff === 13
      && c14[9].ok && c14[9].mode === 'suponly' && c14[9].sum_gross === 110000 && c14[9].est === 1 && c14[10].issues.join() === 'no_ref' && c14[11].issues.join() === 'no_rows',
      JSON.stringify(c14.map((c) => [c.ok, c.issues.join('|'), c.mode])));
    const c15 = [CK([R0({ veh: 'veh_a', amt: 100 }), R0({ veh: 'veh_b', amt: 50 })], { stated: 150, vsub: { veh_a: 100, veh_b: 50 } }), CK([R0({ veh: 'veh_a', amt: 100 }), R0({ veh: 'veh_a', amt: 50 })], { stated: 150, vsub: { veh_a: 100, veh_b: 50 } }),
      CK([R0({ kind: 'part', amt: 30000 })], { basis: 'supply', stated: 30000, carry: { prev: 0, month: 33000, paid: 0, bal: 33000 } }, { group: 'veh', carry: true }),
      CK([R0({ kind: 'part', amt: 30000 })], { basis: 'supply', stated: 30000 }, { group: 'veh', carry: true }), CK([R0({ kind: '', amt: 1 })], { stated: 1 }),
      CK([R0({ veh: '', use: 'vehicle', kind: 'tool', amt: 1 })], { stated: 1, group: 'tool' }), CK([R0({ veh: '', use: 'safety', kind: 'tool', amt: 1 })], { stated: 1, group: 'tool' })];
    T('89 ⑭-3 차량 소계 맞음·다른 차에 붙은 줄 = vsub · suponly 잔액형 당월 33,000 = 줄 합 30,000의 부가세 포함 추정(±추정 줄 수) 통과 · 잔액형인데 4칸 없음 no_carry · 종류 빈칸 kind · 용구 "차량" 용도 차량 없음 veh · 용구 안전보건 차량 없어도 통과',
      c15[0].ok && c15[1].issues.join() === 'vsub' && c15[1].vsub_bad.length === 2 && c15[2].ok && c15[2].month_diff === 0 && c15[3].issues.join() === 'no_carry'
      && c15[4].bad[0].why.join() === 'kind' && c15[5].bad[0].why.join() === 'veh' && c15[6].ok,
      JSON.stringify(c15.map((c) => [c.ok, c.issues.join('|'), c.bad.map((b) => b.why.join('+')).join()])));
    const pol = S89.checkDoc({ basis: 'total', group: 'veh', rows: [R0({ veh: '__proto__', amt: 1 }), R0({ veh: 'constructor', amt: 2 }), R0({ veh: 'toString', amt: 3 })], stated: 6 }, { group: 'veh' });
    const gap14 = S89.gapCount([R0({ r: 'a', amt: 1, item: 'x' }), R0({ r: 'b', amt: 2, item: 'y' })], [R0({ r: 'a', amt: 1, item: 'x' }), R0({ r: 'c', amt: 3 }), R0({ r: 'constructor', amt: 4 })]);
    const ms = S89.vehMonths([{ ym: '2026-10', doc: { vendors: { v01: { ok: true, status: 'done', veh: { veh_a: { fuel: [1, 10] } } }, v02: { ok: false, status: 'doing', veh: { veh_a: { fuel: [1, 99] } } }, v03: { ok: true, status: 'doing', veh: { veh_a: { fuel: [1, 7] } } } } } }], 'veh_a');
    T('89 ⑭-4 객체 오염 없음(__proto__·constructor·toString 차량 줄도 각자 합·Object.prototype 그대로) · 간극 빠진 줄 1·더한 줄 2(constructor 줄 id 포함) · 차량 이력 = 확정·통과(v01)만, 작성 중·붉음은 pending · 달 이동 2026-01−1 = 2025-12·−13 = 2024-12 · kstYm 10/31 14:59Z = 10월·15:00Z = 11월',
      ({}).fuel === undefined && pol.veh_kinds['__proto__'].fuel[1] === 1 && pol.veh_kinds['constructor'].fuel[1] === 2 && pol.veh_kinds['toString'].fuel[1] === 3 && pol.ok
      && gap14.rows.deleted === 1 && gap14.rows.added === 2 && gap14.filled.read === 4 && gap14.changed.read === 2
      && ms.length === 1 && ms[0].total === 10 && ms[0].vendors.join() === 'v01' && ms[0].pending.join() === 'v02,v03'
      && S89.ymShift('2026-01', -1) === '2025-12' && S89.ymShift('2026-01', -13) === '2024-12' && S89.kstYm(Date.UTC(2026, 9, 31, 14, 59, 59)) === '2026-10' && S89.kstYm(Date.UTC(2026, 9, 31, 15, 0, 0)) === '2026-11',
      JSON.stringify({ gap: gap14, ms: ms }));
    T('89 ⑭-5 숫자·글 정리: "1,234" = 1234 · "1,2,3,4"·"12,34" 거절 · 공백만 = 빈칸(null) · -0 → 0 · 1e21·"100.12345"·100.12345 거절 · 보이지 않는 글자(U+202E) 거절 · 개인정보 꼴: 붙인 주민번호·점 전화·공백 계좌·10자리 숫자 걸림 · 날짜 "2026.10.31"·"2026-10-31" 안 걸림 · 파일 이름 객체 = BAD_SRC',
      S89.money('1,234', false) === 1234 && S89.money('1,2,3,4', false) === undefined && S89.money('12,34', false) === undefined && S89.money(' ', true) === null && Object.is(S89.money(-0, false), 0)
      && S89.decimal(1e21, 1e30) === undefined && S89.decimal('100.12345', 1e7) === undefined && S89.decimal(100.12345, 1e7) === undefined && S89.text('a\u202Eb', 10) === null
      && S89.piiScan('8505152345678') !== '' && S89.piiScan('010.1234.5678') !== '' && S89.piiScan('1002 123 456789') !== '' && S89.piiScan('번호 1234567890') !== ''
      && S89.piiScan('2026.10.31') === '' && S89.piiScan('2026-10-31') === '' && S89.cleanSrc([{ kind: 'scan', name: { toString: 1 } }]).code === 'BAD_SRC', '');

    // ⑮ 29 판② — 금액 빈칸 줄(종이를 보며 넣다 멈춘 줄): 작성 중 저장은 받고 검산 'amt'로 붉음(합에는 0) · 확정은 NOT_BALANCED ·
    //    권한관리 레지스트리 등록 뒤 gw-auth cleanPerms가 stmt 값을 지킴(수행 → gw-stmt 200) · 값 없는 직원 저장 → '숨김'으로 굳음(→ 403 NO_ACCESS) · 보기 → 쓰기 403 NO_WRITE
    const R15 = (o) => Object.assign({ r: 'h1', date: '2026-11-03', veh: 'veh_a', vraw: '0001', item: '요소수', kind: 'urea', qty: '10', unit: '1000', amt: 10000, how: 'hand' }, o);
    const rows15 = [R15({}), R15({ r: 'h2', qty: '5', unit: null, amt: null })];
    const a15 = await cs89({ action: 'stmt_save', ym: '2026-11', vk: 'v07', base: 0, rows: rows15, stated: 10000 }, tokA);
    const a15d = await cs89({ action: 'stmt_save', ym: '2026-11', vk: 'v07', base: a15.body.doc ? a15.body.doc.updated_at : 0, status: 'done', rows: rows15, stated: 10000 }, tokA);
    const a15e = await cs89({ action: 'stmt_save', ym: '2026-11', vk: 'v07', base: a15.body.doc ? a15.body.doc.updated_at : 0, rows: [R15({ amt: '' })], stated: 10000 }, tokA);
    const a15c = S89.checkDoc({ basis: 'supply', group: 'veh', rows: [S89.cleanRow(R15({}), '2026-11').row, S89.cleanRow(R15({ r: 'h2', amt: '  ' }), '2026-11').row], stated: 10000 }, { group: 'veh' });
    const gwa15 = require(join(FN, 'gw-auth.js'));
    const callA15 = async (body, tok) => { const x = await gwa15.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }); return { code: x.statusCode, body: JSON.parse(x.body || '{}') }; };
    mem.gw_users['member:udev15'] = { id: 'udev15', name: '개발자15', role: '개발자', admin: true, dev: true, perms: {}, tier: 'pm' };
    mem.gw_users['member:ukmj15'] = { id: 'ukmj15', name: '권민지형15', role: '직원', admin: false, perms: { tasks: 'do', veh: 'view' } };
    mem.gw_users['member:unop15'] = { id: 'unop15', name: '무권한15', role: '직원', admin: false, perms: { tasks: 'do', veh: 'view' } };
    const tDev15 = issueSession(mem.gw_users['member:udev15']).token;
    const g15a = await callA15({ action: 'member_upsert', id: 'ukmj15', perms: Object.assign({}, mem.gw_users['member:ukmj15'].perms, { stmt: 'do' }) }, tDev15);
    const pg15a = Object.assign({}, (mem.gw_users['member:ukmj15'] || {}).perms);
    const s15a = await cs89({ action: 'stmt_cfg_get' }, issueSession(mem.gw_users['member:ukmj15']).token, 'dev1');
    const g15b = await callA15({ action: 'member_upsert', id: 'unop15', rank: '사원' }, tDev15);
    const pg15b = Object.assign({}, (mem.gw_users['member:unop15'] || {}).perms);
    const s15b = await cs89({ action: 'stmt_cfg_get' }, issueSession(mem.gw_users['member:unop15']).token, 'dev1');
    const g15c = await callA15({ action: 'member_upsert', id: 'unop15', perms: Object.assign({}, pg15b, { stmt: 'view' }) }, tDev15);
    const tN15 = issueSession(mem.gw_users['member:unop15']).token;
    const s15r = await cs89({ action: 'stmt_month', ym: '2026-11' }, tN15, 'dev1'), s15w = await cs89({ action: 'stmt_save', ym: '2026-11', vk: 'v07', base: 0, rows: [] }, tN15, 'dev1');
    T('89 ⑮ 29 판② 금액 빈칸 줄: 작성 중 저장 200(빈칸 = null 저장·검산 붉음 2번 줄 "amt"·합에는 0 — 명세 합계 10,000 맞음) · 확정 400 NOT_BALANCED · 금액 "" 줄도 작성 중 200 · 순수 규칙: 빈칸 금액 = amt(calc 아님) · 권한관리 등록 뒤 회원 저장: stmt "do" 지킴 → gw-stmt 200 · stmt 없는 직원 인사 저장 → "hide"로 굳음 → 403 NO_ACCESS · "view" 저장 → 읽기 200·쓰기 403 NO_WRITE',
      a15.code === 200 && a15.body.doc.rows[1].amt === null && a15.body.checks.ok === false && a15.body.checks.bad.length === 1 && a15.body.checks.bad[0].i === 1 && a15.body.checks.bad[0].why.join() === 'amt'
      && a15.body.checks.sum_amt === 10000 && a15.body.checks.issues.length === 0
      && a15d.code === 400 && a15d.body.error_code === 'NOT_BALANCED' && a15e.code === 200 && a15e.body.doc.rows[0].amt === null
      && a15c.bad.length === 1 && a15c.bad[0].why.join() === 'amt' && a15c.sum_amt === 10000 && a15c.sum_gross === 11000 && a15c.est === 2
      && g15a.code === 200 && pg15a.stmt === 'do' && s15a.code === 200 && g15b.code === 200 && pg15b.stmt === 'hide' && s15b.code === 403 && s15b.body.error_code === 'NO_ACCESS'
      && g15c.code === 200 && s15r.code === 200 && s15w.code === 403 && s15w.body.error_code === 'NO_WRITE',
      JSON.stringify({ a15: [a15.code, a15.body.checks && a15.body.checks.bad, a15.body.checks && a15.body.checks.issues], a15d: [a15d.code, a15d.body.error_code], a15e: a15e.code, a15c: [a15c.bad, a15c.sum_gross, a15c.est], g: [g15a.code, pg15a.stmt, s15a.code, g15b.code, pg15b.stmt, s15b.code, g15c.code, s15r.code, s15w.code] }));

    // ⑯ 29 판⑤(PM 11/12 23:41 '운반일지 보고, 결재 탭' · 11/13 '결재 없이') — 전달함 표시 stmt_sent + 결재 kind '월말명세서'(③ 대표 전결)
    //    stmt_sent: 보기 403 NO_WRITE · 묶음↔길 짝(veh = 결재 상신 · tool = 결제 지시) · 작성 중 섞임 NOT_DONE · 낡은 base 409 · 다른 묶음 GROUP_MISMATCH · 문서 없음 NO_DOC · 같은 곳 두 번 BAD_ITEMS · ref 꼴 BAD_REF —
    //      실패면 아무것도 안 씀 · 성공 = 전부 sent·전달 기록(via·ref·by)·prev = 확정 판·줄 그대로 · 색인 요약 sent{at,via} · 감사 '명세서전달' 1줄 · 다시 보내면 NOT_DONE ·
    //      [되돌리기] = 확정으로(전달 기록 지움) · 상세 [전달함](stmt_save sent) = via manual · 확정 풀기(doing) = 전달 기록 지움
    //    결재 '월말명세서': grade 3·to boss · 열린 카드 있으면 정정 흡수(같은 id·카드 1장) · 월말명세서 수행 아닌 직원 403 NO_WRITE · ref 꼴(달·tool) 400 BAD_REF · 다른 종류의 stmt: ref 400 · 전결 400 · 승인 뒤 다시 = 새 카드
    const R16 = (o) => Object.assign({ r: 'p1', date: '2026-09-03', veh: 'veh_a', vraw: '0001', item: '요소수', kind: 'urea', qty: '10', unit: '1000', amt: 10000, how: 'hand' }, o);
    const T16 = (o) => Object.assign({ r: 't1', date: '2026-09-05', veh: '', vraw: '', item: '장갑', kind: 'tool', use: 'posco_cip', qty: '10', unit: '1000', amt: 10000, how: 'hand' }, o);
    async function mk16(vk, rows, status) {
      const a = await cs89({ action: 'stmt_save', ym: '2026-09', vk: vk, base: 0, rows: rows, stated: 10000 }, tokA);
      if (!status || a.code !== 200) return a;
      return cs89({ action: 'stmt_save', ym: '2026-09', vk: vk, base: a.body.doc.updated_at, status: status, rows: rows, stated: 10000 }, tokA);
    }
    const d16 = [await mk16('v07', [R16({})], 'done'), await mk16('v03', [R16({ kind: 'part', item: '필터' })], 'done'), await mk16('v06', [R16({ kind: 'fuel', item: '경유' })]), await mk16('v12', [T16({})], 'done')];
    const at16 = (vk) => (mem.gw_data['stmt:2026-09:' + vk] || {}).updated_at;
    const it16 = (vks) => vks.map((vk) => ({ vk: vk, base: at16(vk) }));
    const VR16 = 'stmt:2026-09:veh';
    const many16 = []; for (let i = 0; i < 41; i++) many16.push({ vk: 'v' + (100 + i), base: 0 });
    const e16 = [
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: it16(['v07']) }, tV89, 'dev1'),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'task', ref: VR16, items: it16(['v07']) }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: it16(['v07', 'v06']) }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: [{ vk: 'v07', base: at16('v07') - 1 }] }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: it16(['v07', 'v12']) }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: it16(['v07']).concat([{ vk: 'v08', base: 0 }]) }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: it16(['v07', 'v07']) }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: 'a b', items: it16(['v07']) }, tokA),
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: 'stmt:2026-10:veh', items: it16(['v07']) }, tokA),   // 다른 달 ref
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', items: it16(['v07']) }, tokA),   // ref 없음
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'tool', via: 'task', ref: 'x', items: it16(['v12']) }, tokA),   // 지시 id 꼴 아님
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: many16 }, tokA),   // 41곳 > 상한 40
      await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: [{ vk: 'v07', base: String(at16('v07')) }] }, tokA)   // base 글자
    ];
    const want16 = ['403/NO_WRITE', '400/BAD_VIA', '400/NOT_DONE', '409/STMT_STALE', '400/GROUP_MISMATCH', '400/NO_DOC', '400/BAD_ITEMS', '400/BAD_REF', '400/BAD_REF', '400/BAD_REF', '400/BAD_REF', '400/BAD_ITEMS', '400/BAD_ITEMS'];
    const ixBefore16 = JSON.stringify(mem.gw_data['stmtidx:2026-09'] || null), audBefore16 = auditMock.logs.filter((x) => x.col === 'stmt' && x.ev[0].op === '명세서전달').length;
    const still16 = ['v07', 'v03', 'v12'].every((vk) => mem.gw_data['stmt:2026-09:' + vk].status === 'done' && !mem.gw_data['stmt:2026-09:' + vk].sent)
      && JSON.stringify(mem.gw_data['stmtidx:2026-09'] || null) === ixBefore16 && auditMock.logs.filter((x) => x.col === 'stmt' && x.ev[0].op === '명세서전달').length === audBefore16;   // 색인·감사도 그대로
    const aud16 = auditMock.logs.length, rows16 = JSON.stringify(mem.gw_data['stmt:2026-09:v07'].rows);
    const s16 = await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: 'stmt:2026-09:veh', items: it16(['v07', 'v03']) }, tD89, 'dev1');
    const doc16 = mem.gw_data['stmt:2026-09:v07'], ix16 = JSON.parse(JSON.stringify(mem.gw_data['stmtidx:2026-09'].vendors));
    const aud16l = auditMock.logs.slice(aud16).filter((x) => x.col === 'stmt');
    const again16 = await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'veh', via: 'appr', ref: VR16, items: it16(['v07']) }, tokA);
    // 전달함 문서는 확정 풀기 없이 못 고침(SENT_LOCKED) · 같은 판 다시 저장은 받고 전달 기록 그대로
    const lk16 = await cs89({ action: 'stmt_save', ym: '2026-09', vk: 'v07', base: at16('v07'), rows: [R16({ amt: 20000, qty: '10', unit: '2000' })], stated: 20000 }, tokA);
    const lk16s = await cs89({ action: 'stmt_save', ym: '2026-09', vk: 'v07', base: at16('v07'), status: 'sent', rows: [R16({ amt: 20000, qty: '10', unit: '2000' })], stated: 20000 }, tokA);
    const sameSent16 = JSON.stringify(mem.gw_data['stmt:2026-09:v07'].sent);
    const lk16ok = await cs89({ action: 'stmt_save', ym: '2026-09', vk: 'v07', base: at16('v07'), rows: [R16({})], stated: 10000 }, tokA);
    const tool16 = await cs89({ action: 'stmt_sent', ym: '2026-09', group: 'tool', via: 'task', ref: 'tabc12345', items: it16(['v12']) }, tokA);
    const tdoc16 = mem.gw_data['stmt:2026-09:v12'];
    const rv16 = await cs89({ action: 'stmt_revert', ym: '2026-09', vk: 'v03', base: at16('v03') }, tokA);
    const man16 = await cs89({ action: 'stmt_save', ym: '2026-09', vk: 'v03', base: at16('v03'), status: 'sent', rows: [R16({ kind: 'part', item: '필터' })], stated: 10000 }, tokA);
    const op16 = await cs89({ action: 'stmt_save', ym: '2026-09', vk: 'v03', base: at16('v03'), status: 'doing', rows: [R16({ kind: 'part', item: '필터' })], stated: 10000 }, tokA);
    const ix16b = mem.gw_data['stmtidx:2026-09'].vendors;
    T('89 ⑯ 29 판⑤ stmt_sent: 보기 403 NO_WRITE · 차량은 결재 상신만(BAD_VIA) · 작성 중 섞임 NOT_DONE · 낡은 base 409 · 다른 묶음 GROUP_MISMATCH · 문서 없음 NO_DOC · 같은 곳 두 번 BAD_ITEMS · ref 꼴 BAD_REF — 실패 때 아무것도 안 씀 · 성공 = 두 곳 sent·전달 기록(appr·ref·수행 회원)·prev 확정 판·줄 그대로·색인 sent{at,via}·감사 1줄 · 다시 = NOT_DONE · 작업용구 = via task · 되돌리기 = 확정(기록 지움) · 상세 [전달함] = manual · 확정 풀기 = 기록 지움',
      d16.every((x) => x.code === 200) && d16[0].body.doc.status === 'done' && d16[2].body.doc.status === 'doing' && d16[3].body.doc.status === 'done'
      && JSON.stringify(e16.map((x) => x.code + '/' + x.body.error_code)) === JSON.stringify(want16) && e16[3].body.vk === 'v07' && still16
      && s16.code === 200 && s16.body.items.length === 2 && s16.body.items.every((x) => x.ok)
      && doc16.status === 'sent' && doc16.sent.via === 'appr' && doc16.sent.ref === 'stmt:2026-09:veh' && doc16.sent.by === 'udo89' && doc16.prev.status === 'done' && JSON.stringify(doc16.rows) === rows16
      && ix16.v07.status === 'sent' && ix16.v07.sent && ix16.v07.sent.via === 'appr' && ix16.v07.sent.at === doc16.sent.at && ix16.v03.status === 'sent' && ix16.v06.sent === null
      && aud16l.length === 1 && aud16l[0].ev[0].op === '명세서전달' && /전달함 2\/2곳 · 결재 상신/.test(aud16l[0].ev[0].t)
      && again16.code === 400 && again16.body.error_code === 'NOT_DONE'
      && lk16.code === 400 && lk16.body.error_code === 'SENT_LOCKED' && lk16s.code === 400 && lk16s.body.error_code === 'SENT_LOCKED'
      && lk16ok.code === 200 && lk16ok.body.doc.status === 'sent' && JSON.stringify(lk16ok.body.doc.sent) === sameSent16 && s16.body.idx === true && ix16.v07.sent.by === 'udo89'
      && tool16.code === 200 && tdoc16.status === 'sent' && tdoc16.sent.via === 'task' && tdoc16.sent.ref === 'tabc12345'
      && rv16.code === 200 && rv16.body.doc.status === 'done' && rv16.body.doc.sent === null
      && man16.code === 200 && man16.body.doc.status === 'sent' && man16.body.doc.sent.via === 'manual'
      && op16.code === 200 && op16.body.doc.status === 'doing' && op16.body.doc.sent === null && ix16b.v03.sent === null,
      JSON.stringify({ d: d16.map((x) => x.code + '/' + ((x.body.doc || {}).status || x.body.error_code)), e: e16.map((x) => x.code + '/' + x.body.error_code), s: [s16.code, s16.body.error_code, s16.body.items], ix: ix16.v07, aud: aud16l.map((x) => x.ev[0]), again: again16.body.error_code, tool: [tool16.code, tdoc16.sent], rv: [rv16.code, rv16.body.doc && rv16.body.doc.status], man: [man16.code, man16.body.doc && man16.body.doc.sent], op: [op16.code, op16.body.doc && op16.body.doc.sent] }).slice(0, 1500));
    // 쓰기 도중 실패(PARTIAL_WRITE): ① 두 번째 곳 쓰기 실패 → 첫 곳만 전달함·색인 그 곳만·감사 '1/2곳' ② 검사 뒤 쓰기 직전에 두 번째 곳이 다른 저장으로 바뀜 → 409 PARTIAL_WRITE(cause STMT_STALE)·그 곳은 안 덮음
    const mk16b = async (ym, vk, rows) => { const a = await cs89({ action: 'stmt_save', ym: ym, vk: vk, base: 0, rows: rows, stated: 10000 }, tokA); return cs89({ action: 'stmt_save', ym: ym, vk: vk, base: a.body.doc.updated_at, status: 'done', rows: rows, stated: 10000 }, tokA); };
    const R16b = (ym) => R16({ date: ym + '-04', kind: 'part', item: '필터' });
    await mk16b('2026-08', 'v02', [R16b('2026-08')]); await mk16b('2026-08', 'v03', [R16b('2026-08')]); await mk16b('2026-07', 'v02', [R16b('2026-07')]); await mk16b('2026-07', 'v03', [R16b('2026-07')]);
    const at16b = (ym, vk) => mem.gw_data['stmt:' + ym + ':' + vk].updated_at;
    const audP16 = auditMock.logs.length;
    blobsMock.hooks.failSet = (k) => k === 'stmt:2026-08:v03';
    const pw16 = await cs89({ action: 'stmt_sent', ym: '2026-08', group: 'veh', via: 'appr', ref: 'stmt:2026-08:veh', items: [{ vk: 'v02', base: at16b('2026-08', 'v02') }, { vk: 'v03', base: at16b('2026-08', 'v03') }] }, tokA);
    blobsMock.hooks.failSet = null;
    const pwAud16 = auditMock.logs.slice(audP16).filter((x) => x.col === 'stmt' && x.ev[0].op === '명세서전달');
    let rd16 = 0; const bump16 = at16b('2026-07', 'v03');
    blobsMock.hooks.beforeGet = (k) => { if (k === 'stmt:2026-07:v03' && ++rd16 === 2) mem.gw_data[k] = Object.assign({}, mem.gw_data[k], { updated_at: bump16 + 7, stated: 10000 }); };
    const cc16 = await cs89({ action: 'stmt_sent', ym: '2026-07', group: 'veh', via: 'appr', ref: 'stmt:2026-07:veh', items: [{ vk: 'v02', base: at16b('2026-07', 'v02') }, { vk: 'v03', base: bump16 }] }, tokA);
    blobsMock.hooks.beforeGet = null;
    const ri16 = await cs89({ action: 'stmt_reindex', ym: '2026-09' }, tokA);
    T('89 ⑯-3 29 판⑤ stmt_sent 쓰기 도중: ① 두 번째 곳 쓰기 실패 = 500 PARTIAL_WRITE(cause STORAGE_WRITE_FAILED·vk)·첫 곳만 전달함(색인도 그 곳만 sent·idx true)·감사 "1/2곳"(쓴 곳 이름만) ② 쓰기 직전 다시 읽기에서 그 곳이 바뀌었으면 = 409 PARTIAL_WRITE(cause STMT_STALE)·바뀐 곳은 안 덮음(확정·바뀐 판 그대로) ③ 색인 다시 만들기 = 전달 기록 요약(by 포함) 그대로',
      pw16.code === 500 && pw16.body.error_code === 'PARTIAL_WRITE' && pw16.body.cause === 'STORAGE_WRITE_FAILED' && pw16.body.vk === 'v03' && pw16.body.items.length === 1 && pw16.body.idx === true
      && mem.gw_data['stmt:2026-08:v02'].status === 'sent' && mem.gw_data['stmt:2026-08:v03'].status === 'done' && mem.gw_data['stmtidx:2026-08'].vendors.v02.status === 'sent' && mem.gw_data['stmtidx:2026-08'].vendors.v03.status === 'done'
      && pwAud16.length === 1 && /전달함 1\/2곳/.test(pwAud16[0].ev[0].t) && pwAud16[0].ev[0].t.indexOf('신일상사') < 0
      && cc16.code === 409 && cc16.body.error_code === 'PARTIAL_WRITE' && cc16.body.cause === 'STMT_STALE' && cc16.body.vk === 'v03' && rd16 === 2
      && mem.gw_data['stmt:2026-07:v02'].status === 'sent' && mem.gw_data['stmt:2026-07:v03'].status === 'done' && mem.gw_data['stmt:2026-07:v03'].updated_at === bump16 + 7
      && ri16.code === 200 && ri16.body.vendors.v07.sent && ri16.body.vendors.v07.sent.via === 'appr' && ri16.body.vendors.v07.sent.by === 'udo89',
      JSON.stringify({ pw: [pw16.code, pw16.body.error_code, pw16.body.cause, pw16.body.vk, pw16.body.items, pw16.body.idx], pwAud: pwAud16.map((x) => x.ev[0].t), cc: [cc16.code, cc16.body.error_code, cc16.body.cause, cc16.body.vk, rd16], ri: ri16.body.vendors && ri16.body.vendors.v07 && ri16.body.vendors.v07.sent }));
    const ap16 = mem.gw_data['col:approvals'] || (mem.gw_data['col:approvals'] = { schema: 1, items: [], updated_at: 0 });
    const a16 = await call({ action: 'approval_create', kind: '월말명세서', title: '월말명세서 2026-09 차량 거래처', body: '본문1', ref: 'stmt:2026-09:veh', cid: 'c16a' }, tD89, 'dev1');
    const it16a = mem.gw_data['col:approvals'].items.find((x) => x.id === a16.body.id);
    const a16b = await call({ action: 'approval_create', kind: '월말명세서', title: '월말명세서 2026-09 차량 거래처(고침)', body: '본문2', ref: 'stmt:2026-09:veh', cid: 'c16b' }, tD89, 'dev1');
    const n16 = mem.gw_data['col:approvals'].items.filter((x) => x.ref === 'stmt:2026-09:veh').length;
    const it16b = mem.gw_data['col:approvals'].items.find((x) => x.id === a16.body.id);
    const DNV89 = { id: 'udonv89', name: '수행차량숨김89', admin: false, perms: { stmt: 'do', veh: 'hide' } }; mem.gw_users['member:udonv89'] = DNV89;
    const a16y = [
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-09:veh' }, tV89, 'dev1'),   // 보기 = NO_WRITE
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-09:veh' }, issueSession(DNV89).token, 'dev1'),   // 수행 + 차량 숨김 = NO_VEH_ACCESS
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-09:veh' }, tRT89, 'dev1'),   // 퇴사 = 401
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:1999-09:veh' }, tD89, 'dev1')   // 달 꼴(20xx) = BAD_REF
    ];
    if (it16b) it16b.status = '보류';
    const a16h = await call({ action: 'approval_create', kind: '월말명세서', title: '월말명세서 2026-09 차량 거래처(보류 뒤)', body: '본문h', ref: 'stmt:2026-09:veh', cid: 'c16h' }, tokA);   // 보류 카드도 흡수(관리자가 고침 → by 바뀜)
    const hld16 = JSON.parse(JSON.stringify(mem.gw_data['col:approvals'].items.find((x) => x.id === a16.body.id) || null));   // 그 시점 사본(뒤에서 같은 카드를 '승인'으로 바꿈)
    const a16x = [
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-09:veh' }, tokW, 'dev1'),
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-9:veh' }, tD89, 'dev1'),
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-09:tool' }, tD89, 'dev1'),
      await call({ action: 'approval_create', kind: '지입료', title: 'x', ref: 'stmt:2026-09:veh' }, tokA),
      await call({ action: 'approval_create', kind: '월말명세서', title: 'x', ref: 'stmt:2026-09:veh', self_decide: 1 }, tokA)
    ];
    { const live16 = mem.gw_data['col:approvals'].items.find((x) => x.id === a16.body.id); if (live16) live16.status = '승인'; }   // 결재(decide) 길은 절 17~25가 본다 — 여기선 '승인 뒤 다시 올림'만(정정이 문서를 새로 써서 쥐고 있던 객체는 떨어짐 — 저장소 것을 다시 찾음)
    const a16n = await call({ action: 'approval_create', kind: '월말명세서', title: '월말명세서 2026-09 추가', body: '본문3', ref: 'stmt:2026-09:veh', cid: 'c16n' }, tD89, 'dev1');
    const it16n = mem.gw_data['col:approvals'].items.find((x) => x.id === a16n.body.id);
    const gr16 = await call({ action: 'appr_grades_get' }, tokA);
    T('89 ⑯-2 29 판⑤ 결재 월말명세서: 등급표 기본 ③ · 수행 직원 상신 = grade 3·to boss(대표 큐) · 열린 카드에 다시 올리면 정정 흡수(같은 id·updated·제목·본문 바뀜·카드 1장) · stmt 권한 없는 직원 403 NO_WRITE · ref 달 꼴·tool 400 BAD_REF · 다른 종류의 stmt: ref 400 BAD_REF · 전결 400 SELF_DECIDE_KIND · 승인 뒤 다시 = 새 카드',
      gr16.code === 200 && gr16.body.grades['월말명세서'] === 3 && gr16.body.defaults['월말명세서'] === 3
      && a16.code === 200 && it16a && it16a.kind === '월말명세서' && it16a.grade === 3 && it16a.to === 'boss' && it16a.by.id === 'udo89'
      && a16b.code === 200 && a16b.body.id === a16.body.id && a16b.body.updated === true && n16 === 1 && it16b.title === '월말명세서 2026-09 차량 거래처(고침)' && it16b.body === '본문2'
      && JSON.stringify(a16x.map((x) => x.code + '/' + x.body.error_code)) === JSON.stringify(['403/NO_WRITE', '400/BAD_REF', '400/BAD_REF', '400/BAD_REF', '400/SELF_DECIDE_KIND'])
      && a16n.code === 200 && a16n.body.id !== a16.body.id && !a16n.body.updated && it16n && it16n.grade === 3 && it16n.status === '대기'
      && JSON.stringify(a16y.map((x) => x.code + '/' + (x.body.error_code || ''))) === JSON.stringify(['403/NO_WRITE', '403/NO_VEH_ACCESS', '401/' + (a16y[2].body.error_code || ''), '400/BAD_REF']) && a16y[2].code === 401
      && a16h.code === 200 && a16h.body.id === a16.body.id && a16h.body.updated === true && hld16.status === '보류' && hld16.body === '본문h' && hld16.by.id === 'uadmin',
      JSON.stringify({ g: gr16.body.grades && gr16.body.grades['월말명세서'], a: [a16.code, it16a && [it16a.grade, it16a.to]], b: [a16b.code, a16b.body.updated, n16], x: a16x.map((x) => x.code + '/' + x.body.error_code), y: a16y.map((x) => x.code + '/' + x.body.error_code), h: [a16h.code, a16h.body.updated, hld16 && hld16.status, hld16 && hld16.by], n: [a16n.code, a16n.body.updated] }));
    ap16.items = ap16.items.filter((x) => String(x.ref || '').indexOf('stmt:') !== 0);
  } finally {
    blobsMock.hooks.failGet = null;
    mem.gw_users = savedUsers89;
    if (vehKeep89 === undefined) delete mem.gw_data['col:vehicles']; else mem.gw_data['col:vehicles'] = vehKeep89;
    Object.keys(mem.gw_data).forEach((k) => { if (/^(stmt:|stmtidx:|clog:stmt:)/.test(k) && !(k in keep89)) delete mem.gw_data[k]; });
    Object.keys(keep89).forEach((k) => { mem.gw_data[k] = keep89[k]; });
  }
}

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n서버 테스트 전 항목 통과 (' + pass + ')');process.exit(fail ? 1 : 0);
