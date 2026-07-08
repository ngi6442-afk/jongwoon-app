# 그룹웨어 백엔드 (Netlify Functions) — §7 1단계

정적 PWA를 **백엔드 있는 앱**으로 올린다. 목적: (1) 앱 토큰을 브라우저에서 제거 = 하드 보안, (2) 서버측 권한 강제, (3) WEHAGO·오픈뱅킹 연동 발판.

참고: 웹사이트(jongwoon-website)가 같은 스택(Netlify Functions + @netlify/blobs + HMAC 세션)을 이미 프로덕션에서 쓰고 있고, 그 패턴을 복제했다.

## 구성
- `netlify/functions/_lib/blobs.js` — Netlify Blobs 헬퍼(웹사이트 복제)
- `netlify/functions/_lib/password.js` — scrypt PIN 해시(평문 저장 안 함)
- `netlify/functions/_lib/session.js` — HMAC 무상태 세션 토큰(env `GW_SESSION_SECRET`)
- `netlify/functions/gw-auth.js` — 인증/회원관리 (Blobs `gw_users`)
  - action: `bootstrap`(최초 관리자, 회원 0명일 때만) / `login`(name+pin) / `verify` / `member_list` / `member_upsert`(관리자) / `member_delete`(관리자) / `set_pin`(본인·관리자)
- `netlify/functions/gw-data.js` — 데이터 CRUD + 서버측 권한 (Blobs `gw_data`)
  - action: `get {collection}` / `save {collection, doc}`; 컬렉션 tasks·vehicles·receivables·licenses·checklist
  - 권한: 회원 perms(do/view/hide)로 읽기(hide=403)·쓰기(do 아니면 403) 강제. 관리자 전부 허용.
- `package.json`, `netlify.toml`

## 배포 (사람이 1회)
1. **Netlify에서 New site → jongwoon-app 레포 연결**(빌드 명령 없음, publish `.`). Functions는 자동 인식.
2. **환경변수 설정**(Site settings → Environment variables):
   - `GW_SESSION_SECRET` = 임의의 긴 랜덤 문자열(세션 서명키). 예: `openssl rand -hex 32`.
   - (선택) `GW_SESSION_TTL` = 세션 유효초(기본 43200 = 12h).
3. 배포되면 함수 엔드포인트: `https://<사이트>.netlify.app/.netlify/functions/gw-auth`, `.../gw-data`.
4. **최초 관리자 생성**: gw-auth에 `{action:"bootstrap", name:"나종운", pin:"1234"}` POST 1회(회원 0명일 때만 통함). 이후 관리자로 로그인해 직원 추가.
5. **기존 데이터 이관**: 현재 appdata의 tasks/vehicles/receivables/licenses.json을 gw-data `save`로 한 번씩 올림(관리자 세션 토큰 필요). 회원(users.json)은 gw-auth `member_upsert`로.

## 남은 작업(다음 단계)
- 앱(index.html) 데이터층을 GitHub Contents API → `gw-auth`/`gw-data` 호출로 전환. 앱 토큰 입력 제거, 로그인=서버 세션.
- **2단계 WEHAGO**: 계산서 발행 데이터 수신 함수 → 자동 미수. (WEHAGO API 권한 필요)
- **3단계 오픈뱅킹**: 입금내역 조회 함수 → 자동 완료/불일치. (오픈뱅킹 이용기관 등록 필요)

## 주의
- `GW_SESSION_SECRET`은 절대 코드/커밋에 넣지 않는다(env only). 없으면 로그인 fail-closed.
- 이 PC엔 Node가 없어 로컬 함수 테스트 불가 → Netlify 배포로 검증.
- 읽기 시 건별 scope 필터는 아직 클라이언트 담당(1.5단계에서 서버로 이관 예정). 쓰기 권한·모듈 hide는 서버 강제됨.
