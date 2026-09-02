// 인허가 주기의무 등재표(md) → data/duties_seed.json 생성기 — 3층 구조 1차(의무층 시드)
// 왜 스크립트인가: 등재표는 계속 증보되는 문서라 손 변환은 행 누락·오타가 곧 주기 오적용이 된다.
// 등재표가 바뀌면 반드시 이 파서로 재생성한다(손 편집 금지).
// 실행: node tools/duties_seed.mjs [등재표.md 경로]
// 기본 원천: Desktop\work\09_조사_문서\인허가_주기의무_등재표_20260825.md (3차 교차감사 반영본 + 증보 1)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ||
  'C:\\Users\\user\\Desktop\\work\\09_조사_문서\\인허가_주기의무_등재표_20260825.md';
const OUT = join(ROOT, 'data', 'duties_seed.json');

const md = readFileSync(SRC, 'utf8');
const lines = md.split(/\r?\n/);

// 셀 정리 — 마크다운 굵게(**)는 앱 화면에 그대로 노출되므로 여기서 벗긴다(내용은 원문 유지)
const clean = (s) => String(s || '').replace(/\*\*/g, '').trim();

// 헤더행·구분선(---)을 뺀 표의 데이터 행들을 [셀배열]로
function tableRowsAfter(headerText) {
  const start = lines.findIndex((l) => l.trim().startsWith(headerText));
  if (start < 0) throw new Error('섹션 없음: ' + headerText);
  const rows = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('|')) {
      inTable = true;
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
      if (cells.every((c) => /^:?-+:?$/.test(c) || c === '')) continue; // 구분선·전체 공백행
      rows.push(cells);
    } else if (inTable) break; // 표가 끝나면 종료(섹션 내 표 1개 전제)
  }
  return rows;
}

const items = [];
const errors = [];

// ---- ① 본표 73행: | 번호 | 인허가(회사) | 의무 항목 | 주기 | 기산점·마감 | 근거 조문 | 확정도 | 선행 확인 |
const main = tableRowsAfter('## 주기 의무 등재표');
for (const c of main) {
  if (c.length < 8) { if (c[0] !== '번호') errors.push('본표 셀 부족: ' + c.join('|').slice(0, 40)); continue; }
  if (c[0] === '번호') continue; // 헤더
  const no = parseInt(c[0], 10);
  if (!no) { errors.push('본표 번호 파싱 실패: ' + c[0]); continue; }
  let duty = c[2];
  let unit = '사업장';
  if (duty.startsWith('[차량단위]')) { unit = '차량'; duty = duty.slice('[차량단위]'.length).trim(); }
  else if (duty.startsWith('[개인단위]')) { unit = '개인'; duty = duty.slice('[개인단위]'.length).trim(); }
  const confirm = c[6].startsWith('확정') ? '확정' : (c[6].indexOf('조건부') >= 0 ? '조건부' : null);
  if (!confirm) { errors.push('본표 ' + no + '번 확정도 해석 불가: ' + c[6]); continue; }
  items.push({
    no, lic: c[1], duty, cycle: c[3], basis: c[4], law: c[5],
    confirm, precheck: c[7] === '-' ? '' : c[7], unit
  });
}
const mainCount = items.length;

// ---- ② 증보 1 (2026-09-01): | 의무 | 주기·기한 | 근거 조문 | 구분 | — 번호는 74부터 이어 붙인다
// '근거 조문' 열은 2026-09-02 정정으로 신설 — 헤더행에서 열 위치를 읽어 구판(3열 표)도 그대로 읽힌다.
// ★미확인/★제외/의무 '없음' 확인행도 등재한다(본표 33번 '비적용 확인' 행과 같은 성격 —
// 오적용을 막는 기록이므로 자동 판단으로 버리지 않는다. 정리는 PM 검토 몫).
const SUPPS = [
  { head: '### 건폐법 수집·운반업 고유 세트', lic: '건설폐기물 수집·운반업 — 건폐법 세트(종운환경)' },
  { head: '### 비산먼지 발생사업 신고', lic: '비산먼지 발생사업 신고(현장별·확인요)' },
  { head: '### 특정공사 사전신고', lic: '특정공사 사전신고(현장별·확인요)' },
];
let nextNo = Math.max(...items.map((d) => d.no)) + 1;
const suppCounts = {};
for (const s of SUPPS) {
  const rows = tableRowsAfter(s.head);
  let cnt = 0;
  let col = { cycle: 1, law: -1, gubun: 2 }; // 구판(근거 조문 열 없는 3열 표) 기본값
  for (const c of rows) {
    if (c[0] === '의무') { // 헤더행 — 열 이름으로 위치 확정('근거 조문' 열 신설 대응)
      const li = c.indexOf('근거 조문'), gi = c.indexOf('구분');
      col = { cycle: 1, law: li, gubun: gi >= 0 ? gi : (li >= 0 ? 3 : 2) };
      continue;
    }
    if (!c[0]) continue; // 빈 행
    const duty = c[0], cycle = c[col.cycle] || '—', gubun = c[col.gubun] || '';
    const law = col.law >= 0 ? (c[col.law] || '') : '';
    const mi = duty.startsWith('★미확인'); // 조례 미확인 = 사람이 채워야 알림 확정 → 조건부
    const confirm = (mi || gubun.indexOf('조건부') >= 0) ? '조건부' : '확정';
    if (col.law >= 0 && !law) errors.push('증보 근거 조문 공란: ' + duty.slice(0, 30)); // 전 행 채움 원칙(원기록 미기재는 그 취지를 셀에 명기)
    items.push({
      no: nextNo++, lic: s.lic, duty, cycle,
      basis: gubun || (duty.startsWith('★제외') ? '적용 제외' : (mi ? '선행 확인 필요' : '')),
      law, confirm,
      precheck: mi ? duty.replace(/^★미확인:?\s*/, '') : '',
      unit: '사업장'
    });
    cnt++;
  }
  suppCounts[s.head.replace('### ', '')] = cnt;
}

// ---- 검증: no 유일 + 필수필드 + 열거값
const seen = new Set();
for (const d of items) {
  if (seen.has(d.no)) errors.push('번호 중복: ' + d.no);
  seen.add(d.no);
  for (const k of ['lic', 'duty', 'cycle']) if (!d[k]) errors.push(d.no + '번 필수필드 공백: ' + k);
  if (d.confirm !== '확정' && d.confirm !== '조건부') errors.push(d.no + '번 확정도 이상: ' + d.confirm);
  if (['사업장', '차량', '개인'].indexOf(d.unit) < 0) errors.push(d.no + '번 unit 이상: ' + d.unit);
  if (d.confirm === '조건부' && !d.precheck) console.log('  (참고) ' + d.no + '번 조건부인데 선행확인 공란: ' + d.duty.slice(0, 30));
}
if (errors.length) { console.error('검증 실패 ' + errors.length + '건:\n' + errors.join('\n')); process.exit(1); }

const today = new Date();
const pad = (n) => (n < 10 ? '0' : '') + n;
const out = {
  schema: 1,
  source: basename(SRC),
  generated: today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()),
  count: items.length,
  items
};
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');

const n = (f) => items.filter(f).length;
console.log('duties_seed.json 생성 완료 → ' + OUT);
console.log('  본표: ' + mainCount + '행 / 증보: ' + JSON.stringify(suppCounts) + ' / 총 ' + items.length + '행');
console.log('  확정 ' + n((d) => d.confirm === '확정') + ' · 조건부 ' + n((d) => d.confirm === '조건부'));
console.log('  근거 조문(law) 공란 ' + n((d) => !d.law) + '행 · 원기록 미기재 표기 ' + n((d) => d.law.indexOf('미기재') >= 0) + '행');
console.log('  단위: 사업장 ' + n((d) => d.unit === '사업장') + ' · 차량 ' + n((d) => d.unit === '차량') + ' · 개인 ' + n((d) => d.unit === '개인'));
