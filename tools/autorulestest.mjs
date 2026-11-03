// 자동 지시 서버 규칙 3건 순수 함수 검증(카드 10, v417) — 실호출 없음. 실행: node tools/autorulestest.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = require(join(ROOT, 'netlify/functions/_lib/autorules.js'));

let pass = 0, fail = 0;
const T = (name, cond, note) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (note ? ' — ' + note : '')); } };

// site
const asb = [
  { id: 'a1', kind: 'asbestos', seq: 1, site: '포항시 남구', worker_ids: [], start: '2026-03-01' },           // 석면 근로자 없음 → 제외
  { id: 'd1', kind: 'dredge', seq: 2, site: '', worker_ids: [], start: '2025-05-01' },                         // 준설: 근로자 0 + 소재지 공란 → 1행
  { id: 'd2', kind: 'dredge', seq: 3, site: '포항', worker_ids: ['w1', 'w2'], start: '2025-06-01' },           // 정상
  { id: 'd3', kind: 'dredge', seq: 4, site: '', worker_ids: ['w3'], start: '2024-06-01' },                     // 소재지 공란(2024)
  { id: 'm1', kind: 'demolition', seq: 5, site: '', worker_ids: [], start: '2025-07-01' },                     // 철거 소재지 공란(근로자 비움은 셈 안 함)
  { id: 'm2', kind: 'demolition', seq: 6, site: '경주', worker_ids: ['w4'], start: '2025-08-01' },
  { id: 'x1', kind: 'dredge', seq: 7, site: '', worker_ids: [], del: 1 },                                      // 삭제 제외
];
const s = A.siteMissing(asb);
T('site: 준설 근로자 0명 1(d1)·소재지 공란 준설 2(d1·d3)·철거 1(m1) → 행 3(중복 없음)·석면·삭제 제외', s.count === 3 && s.by.dredge_workers === 1 && s.by.site_blank.dredge === 2 && s.by.site_blank.demolition === 1 && s.ids.indexOf('a1') < 0 && s.ids.indexOf('x1') < 0 && s.seqs.length === 3, JSON.stringify(s));
T('site: 빈 대장 → 0', A.siteMissing([]).count === 0 && A.siteMissing(null).count === 0);

// veh
const TODAY = '2026-11-03';
const veh = [
  { id: 'v1', no: '1', state: '운행', insp_due: '2026-12-10', kind: '덤프' },        // 37일 → 후보 + 건설기계 flag
  { id: 'v2', no: '2', state: '운행', insp_due: '2027-01-31' },                       // 89일 → 후보
  { id: 'v3', no: '3', state: '운행', insp_due: '2027-02-02' },                       // 91일 → 제외
  { id: 'v4', no: '4', state: '운행', insp_due: '2026-11-20' },                       // 17일 → D-30 영역이라 제외
  { id: 'v5', no: '5', state: '매각', insp_due: '2026-12-01' },                       // 회색 제외
  { id: 'v6', no: '6', state: '운행', insp_due: '2026-12-20' },                       // 47일 → 기존 키 있음 → overlap
  { id: 'v7', no: '7', state: '운행', insp_due: '' },                                 // 날짜 없음
  { id: 'v8', no: '8', state: '운행', insp_due: '2026-12-25', del: 1 },               // 삭제
];
const v = A.veh90(veh, TODAY, ['veh:v6:insp:2026-12-20']);
T('veh D-90: 31~90일 후보 2(v1 37일·v2 89일, 가까운 순)·17일은 D-30 몫·91일 제외·회색·삭제 제외·기존 키 겹침 1·건설기계 flag v1', v.count === 2 && v.items[0].id === 'v1' && v.items[1].id === 'v2' && v.overlap === 1 && v.flags.length === 1 && v.flags[0] === 'v1' && v.items[0].key === 'veh:v1:insp:2026-12-10', JSON.stringify(v));

// worker
T('birth6: 81.08.17·810817·1981-08-17 → 810817 · 잘못된 월/일·5자리·빈칸 → ""', A.birth6('81.08.17') === '810817' && A.birth6('810817') === '810817' && A.birth6('1981-08-17') === '810817' && A.birth6('811317') === '' && A.birth6('81081') === '' && A.birth6('') === '' && A.birth6('810832') === '');
const workers = [
  { id: 'w1', name: '김철수', birth: '810817', phone: '' },
  { id: 'w2', name: '이영희', birth: '', phone: '' },           // 범위 안(d2 2025) 생년월일 공란
  { id: 'w3', name: '박민수', birth: '', phone: '' },           // d3는 2024 → 범위 밖
  { id: 'w4', name: '김철수', birth: '90.01.01', phone: '010-1234-5678' },   // 동명이인(김철수 2명) → 1쌍
  { id: 'w5', name: '최지우', birth: '', phone: '', del: 1 },   // 삭제
];
const w = A.wkMissing(workers, asb, 2025);
T('wk: 2025~ 참여자 범위 3(w1·w2·w4), 생년월일 공란 1(w2)·연락처 공란 2·동명이인 1쌍·전체 참고(생년월일 공란 2/4)', w.scope === 3 && w.birth_blank === 1 && w.ids_birth_blank[0] === 'w2' && w.phone_blank === 2 && w.dup_pairs === 1 && w.total_live === 4 && w.ref.birth_blank_all === 2, JSON.stringify(w));
T('wk 산출물에 이름·생년월일·연락처 값 없음(piiScan 통과)', A.piiScan(w) === '' && A.piiScan(s) === '' && A.piiScan(v) === '');
T('piiScan: 전화번호 꼴·이름 필드가 들어가면 거부', A.piiScan({ x: '010-1234-5678' }) === 'PHONE' && A.piiScan({ name: '김' }) === 'FIELD');
T('월 키(KST 날짜 기준)', A.siteKey('2026-11-03') === 'site:missing:2026-11' && A.wkKey('2026-12-01') === 'wk:missing:2026-12');

console.log(fail ? '\n실패 ' + fail + ' / 통과 ' + pass : '\n자동 지시 규칙 순수 함수 전 항목 통과 (' + pass + ')');
process.exit(fail ? 1 : 0);
