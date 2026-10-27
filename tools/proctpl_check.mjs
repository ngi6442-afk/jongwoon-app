// 계약 골조 템플릿 검사(계약 D1 1일차, 10/27) — index.html `@con-scen` 블록의 상수 7종(CON_TYPE_ELEMS·CON_SCEN·STAGE_DOC_MAP·CON_STAGE_FIELDS·STAGE_DOCS·CON_PACKETS·CON_SITE_CORP)을
// 평가해 appdata data/contract/proc_v1.json과 대조한다(변환 diff 0). `--export`는 JSON을 다시 쓴다(상수가 바뀌면 먼저 export → 커밋). 정규식은 {$re, $flags}로 직렬화.
// 실행: node tools/proctpl_check.mjs [--export] [--print]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const OUT = join(ROOT, '..', 'jongwoon-appdata', 'data', 'contract', 'proc_v1.json');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < 0) throw new Error('segment ' + a); return html.slice(i, j); };
const seg = cut('// @con-scen-start', '// @con-scen-end');
const NAMES = ['CON_TYPE_ELEMS', 'CON_SCEN', 'STAGE_DOC_MAP', 'CON_STAGE_FIELDS', 'STAGE_DOCS', 'CON_PACKETS', 'CON_SITE_CORP'];

// 선언문 오른쪽(리터럴)을 잘라 평가 — 'var NAME = ' 뒤부터 다음 최상위 선언('\n  var '·'\n  function ') 전까지, 마지막 ';'까지
function rhsOf(name) {
  const key = '  var ' + name + ' = ';
  const i = seg.indexOf(key); if (i < 0) throw new Error('상수 없음: ' + name);
  const start = i + key.length;
  let end = seg.length;
  for (const b of ['\n  var ', '\n  function ', '\n  // @']) { const j = seg.indexOf(b, start); if (j >= 0 && j < end) end = j; }
  let body = seg.slice(start, end);
  const semi = body.lastIndexOf(';');
  if (semi >= 0) body = body.slice(0, semi);
  return body.trim();
}
const consts = {};
for (const n of NAMES) consts[n] = new Function('return (' + rhsOf(n) + ');')();
const ser = (v) => JSON.stringify(v, (k, val) => (val instanceof RegExp) ? { $re: val.source, $flags: val.flags } : val, 1);
const doc = { schema: 1, proc_ver: 'v1', source: 'jongwoon-app index.html @con-scen (v382~)', note: '계약 D1 1일차 — 상수 7종을 데이터로. 단계 이름은 PM 원문 불변. 신설 단계(변경계약 끼움·완료신고 2종·적격심사 수동·사급 선택)는 added 절에 비활성으로 둔다(카드 9 뒤).', consts: JSON.parse(ser(consts)), added: { stages: [], note: '카드 9 골조 확인 R2 뒤 채움 — 그 전엔 비어 있음' } };
const want = JSON.stringify(doc, null, 1);
let fails = 0;
const T = (name, ok, note) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : ' — ' + note)); if (!ok) fails++; };
if (process.argv.includes('--print')) console.log(want);
if (process.argv.includes('--export')) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, want + '\n');
  console.log('export →', OUT, want.length, '자');
}
T('상수 7종 평가(CON_SCEN 시나리오 ' + Object.keys(consts.CON_SCEN).length + '개 · 단계 입력 ' + consts.CON_STAGE_FIELDS.length + ' · 서류 ' + Object.keys(consts.STAGE_DOCS).length + ' · 패킷 ' + consts.CON_PACKETS.length + ')',
  Object.keys(consts.CON_SCEN).length === 10 && consts.CON_STAGE_FIELDS.length >= 15 && Object.keys(consts.STAGE_DOCS).length >= 16 && consts.CON_PACKETS.length === 4, JSON.stringify(Object.keys(consts.CON_SCEN)));
T('단계 이름 원문 보존: CON_SCEN 10목록 전부 문자열·공백 아님 · 선택 단계는 괄호', Object.values(consts.CON_SCEN).every((l) => Array.isArray(l) && l.length > 0 && l.every((s) => typeof s === 'string' && s.trim())), '');
if (existsSync(OUT)) {
  const have = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n').trim();
  const diff0 = have === want.trim();
  if (!diff0) {
    const a = have.split('\n'), b = want.split('\n'); let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    T('변환 diff 0: index.html 상수 = appdata proc_v1.json', false, '첫 차이 줄 ' + (k + 1) + ': 파일「' + (a[k] || '').trim().slice(0, 80) + '」 vs 코드「' + (b[k] || '').trim().slice(0, 80) + '」 — 상수를 바꿨으면 node tools/proctpl_check.mjs --export 뒤 appdata 커밋');
  } else T('변환 diff 0: index.html 상수 = appdata proc_v1.json', true);
  // 되돌림 검사: JSON → 정규식 복원 → 같은 단계 이름에 같은 서류 키 매핑
  const back = JSON.parse(have, (k, v) => (v && typeof v === 'object' && '$re' in v) ? new RegExp(v.$re, v.$flags) : v);
  const mapA = consts.STAGE_DOC_MAP, mapB = back.consts.STAGE_DOC_MAP;
  const names = [].concat(...Object.values(consts.CON_SCEN));
  const docKey = (map, n) => { for (const [re, key] of map) if (re.test(n)) return key; return ''; };
  T('정규식 복원: 단계 이름 ' + names.length + '개의 서류 키 매핑이 코드와 JSON에서 동일', names.every((n) => docKey(mapA, n) === docKey(mapB, n)), '');
} else console.log('  (proc_v1.json 없음 — --export로 생성)');
console.log(fails ? '\nproctpl 검사 실패 ' + fails + '건' : '\nproctpl 검사 통과');
process.exit(fails ? 1 : 0);
