# CLAUDE.md — jongwoon-app 작업 규칙

이 레포는 종운환경·종운건설의 업무 앱(설치형 PWA)이다. 상세 설계는 **jongwoon-docs/05_규정/JW-05-017_ERP설계구축가이드.md**를 먼저 정독할 것(구 JW-05-014, 문서번호 충돌로 017 재배정). 문서 체계 일반 규칙은 jongwoon-docs/05_규정/JW-05-013의 0장.

## 불변 원칙
- 단일 `index.html` PWA. 외부 CDN·프레임워크·빌드체인·node_modules 금지.
- 데이터는 jongwoon-appdata의 `data/*.json` (git이 DB). GitHub Contents API + 앱 토큰으로 읽고 쓴다.
- 배포는 main push → GitHub Pages 자동. 로컬 테스트: `python3 -m http.server 8000`.
- appdata 스키마 변경 시: 실물 JSON을 먼저 읽고, 이관은 dry-run 출력으로 검증 후 실행. 레코드는 삭제 대신 상태 변경(이력 보존).
- 개인정보 최소화: 이름까지만. 연락처·주민번호·계좌 금지. appdata·assets 비공개 유지.
- 기존 도구(은행 사이트·세무사·카톡·현장 종이 점검표) 대체 금지. 앱은 "했는지"의 기록 층.
- 커밋은 의미 단위, 한국어 메시지, push 후 원격 반영 확인.

## 모듈 현황
- M0 주기 업무 체크(checklist.json): 운영 중, 함부로 손대지 않는다.
- M1 업무 전달(tasks.json): **구현 완료(P1, 2026-07-07 / 개인 인박스 2026-07-08)**. `지시` 탭=관리자 공간(등록·담당지정·완료·보류·삭제, 지시자=로그인 이름 자동, 기한순·경과 빨강·완료 이력). `업무` 탭 상단 **"내게 온 지시"**=개인 인박스: 담당=로그인 회원명인 미완료 지시를 기한순 표시, 행 탭으로 완료(완료자=로그인 이름 기록). 권한: 완료/보류는 `canActTask`(관리자 `canDo("tasks")` 또는 본인 담당)로 완화 — 직원이 지시는 못 내려도 자기 업무는 완료 가능. 등록·삭제는 관리자 전용 유지. 기존 checklist.json의 deadlines를 tasks.json으로 이관(유실 0, id 보존), checklist에서 deadlines 키 제거. 이관 스크립트: `~/jongwoon/migrate_deadlines_to_tasks.py`(dry-run 기본, `--apply`로 적용).
- M2 차량·자산 만기(vehicles.json): **구현 완료(P2, 2026-07-07 / 갱신기능 2026-07-08)**. `차량` 탭 + 통합 `대시보드`(첫 화면). 검사/보험 D-day 색상(경과 빨강·30일 주황·90일 노랑·**말소예정·매각·검사보류 회색**), 만기 임박순 정렬. **차량은 편집형(RW)**: 각 행 `수정` → 검사/보험 만기·상태·보험사·메모 편집, `검사/보험 갱신(+1년)` 버튼으로 다음 만기 세팅. `~/jongwoon/extract_vehicles.py`는 이제 **최초 시드/신규차량 확인용**(연락처 제외·차주명까지만); **재추출 시 앱 편집분을 덮어쓰므로 주의**(현황표는 백업 성격). state `검사보류`는 검사 의도적 스킵(회색·대시보드 제외).
- M3 수금·기성(receivables.json): **구현 완료(P3, 2026-07-07 / 업무연동·공개범위 2026-07-08)**. `기성` 탭(구 수금). 청구 등록·계산서 발행·입금완료·미수전환·삭제. 미수 오래된 순·합계, 대시보드 통합. 은행 연동 없음.
  - **건별 공개범위**: 기성 수정 모달(거래처·내역·금액·청구일·**담당(assignee)**·**공개대상 scope**). `recVisible`=관리자·담당·scope 포함·전체공개. 비회원은 안 보임.
  - **업무 연동**: 계산서 발행 → "입금확인: {거래처}…" 지시 자동 생성(who=담당, rec_id 링크, scope 동기화). 입금완료 → 연동 지시 자동 완료. 미수전환 → 재개. 계산서 취소 → 미완료 연동 지시 제거. **금액 불일치** 토글 → `mismatch` 플래그·불일치 칩·연동 지시에 "금액 불일치" 메모. 헬퍼: `createRecTask/completeRecTask/reopenRecTask/removeRecTask/findRecTask`.
- M4 인허가·보수교육(licenses.json): **구현 완료(P4, 2026-07-08)**. `인허가` 탭(편집형). JW-04-001 인허가 13건을 시드로 넣되, **원천에 만료일이 비어 있어** 만료일·보수교육 예정일은 앱에서 직접 입력·수정(수정 모달). 만료일은 날짜/`해당없음`/미정(null) 지원. 날짜 입력 시 M2와 동일한 D-day 색상·대시보드·캘린더 알람 작동. 법정 만기일은 지어내지 않음(PM 입력).
- 단계 완료 시 이 파일과 가이드를 실태에 맞게 갱신한다.

## 신규 탭/모듈 추가 규칙 (필수)
- **탭을 새로 만들면 반드시 모듈 레지스트리에 등록**해 권한관리·게이팅에 자동 반영한다. 등록 위치 5곳: `MODULES` 배열 + `MODULE_TAB`(탭버튼 id) + `MODULE_VIEW`(뷰 id) + `MOD_LABEL`(한글명) + `ROLE_PRESET`(대표/관리자=do, 직원=기본값). 권한관리 UI(`#mePerms`)는 `MODULES.map(MOD_LABEL[mod])`로 자동 생성되므로 등록만 하면 셀렉트가 자동 추가된다.
- **모듈 id = 백엔드 `gw-data.js`의 `COL` 권한키와 반드시 일치**시킨다(예: 계약 con, 거래처 cli, 문서함 doc). 데이터 컬렉션이 있으면 `COL`에 `컬렉션명:'모듈id'` 추가 + 프런트 `_urlCollection`에 매핑.
- **탭 내 mutating 동작은 `canDo("모듈id")` 가드**, 뷰는 `MODULE_VIEW` readonly로 자동 게이팅.
- ⚠️ **개인 인박스("내게 온 지시")·"내가 할 일"은 권한과 무관하게 항상 노출**: 업무(check) 탭은 `applyPerms`에서 절대 숨기지 않으며(특례), 그 안의 주기 체크리스트만 `.check-only`로 check 권한 게이팅. 지시(tasks) 권한이 hide여도 담당/지시자에게 배정된 미완료 지시는 반드시 보여야 한다.

## 회원·권한 (P5, 2026-07-08)
- `data/users.json`: 회원 {id,name,pin,role,admin,perms:{tasks/veh/rec/lic/check: do|view|hide}}. 시드 관리자 나종운(PIN 0000, 반드시 변경).
- 로그인: ⚙ → 이름 선택 + PIN. `jw_app_member`(localStorage)에 현재 회원. 관리자만 ⚙에서 `회원 관리`(추가/수정/삭제, 역할 프리셋 대표/관리자/직원).
- 게이팅: `hide`=탭 자체 안 보임, `view`=탭은 보이되 `.readonly` 클래스로 추가·수정·완료·삭제 버튼 숨김 + 모든 mutating 함수 시작에 `canDo(mod)` 가드. 대시보드 공유 행(taskRowHtml/recRowHtml)도 canDo로 버튼 제거.
- ⚠️ **UI 권한(실수 방지·역할 구분)이지 하드 보안이 아니다** — 공용 토큰이 브라우저에 있어 기술자는 우회 가능. 하드 보안은 JW-05-017 §7의 1단계(백엔드)에서. 권한 모델은 그때 서버측 강제로 승격.
- **로그인 유지 방식(2026-07-08 개정)**: 기본은 **세션 저장**(sessionStorage) — 앱을 닫으면 로그아웃, 다시 열면 로그인. 폰·공용 기기 대비 자동로그인 기본 OFF. 로그인 모달의 `이 기기에서 로그인 유지` 체크 시에만 localStorage 영구 저장(개인 PC용). `getMemberId`는 session→local 순 조회, `setMemberId(id, persist)`가 분기.
- **현재 사용자 표시**: 좌상단 헤더 우측에 `curUserBtn`(현재 회원명, 없으면 "로그인"). 탭하면 로그인/전환 모달. `updateUserChip()`가 `applyPerms`에서 갱신.
- **PIN 관리**(2026-07-08): 로그인 모달 `내 PIN 변경`으로 각자 본인 PIN 변경. 기본 PIN 0000으로 로그인하면 변경 모달을 자동으로 띄워 유도(`openChangePin(true)`).
- 앱 내 `도움말`(로그인 모달 → 도움말).
- **건별 공개범위(2026-07-08)**: 지시·인허가 각 건에 `scope`(회원 id 배열). 비면 전체 공개, 지정 시 그 직원(+관리자, 지시는 담당 본인)만 목록에서 봄. 관리자는 전부 보고 `공개 …` 칩으로 대상 표시. 인허가 수정 모달 + **지시 수정 모달 신설**(제목·담당·기한·상세·공개대상, 관리자 전용)에서 설정. 헬퍼 `taskVisible`/`licVisible`/`renderMemberChecks`/`getCheckedMembers`. renderTasks·renderLicenses·대시보드에서 필터. (UI 구분이지 하드보안 아님)

## 계약·프로세스 파이프라인 엔진 (M6, 2026-07-10~ 구축 중)
- **목적**: 인허가 변경·단발계약(석면철거·건축물철거·폐기물)을 **단계 파이프라인**으로 관리 → 각 단계가 처리기한과 함께 `지시`에 순차 생성. 미래 **계약서 PDF 파싱→서류 자동생성** 확장 대비 구조화 레코드 유지.
- **저장**: `data/contracts.json`(신설 컬렉션). 백엔드 `gw-data.js` COL에 `contracts` 추가함. 계약 레코드 = `{id,type,label,client,site,start,lic_id,info{},review{missing,suspect,ok},docs[],pipes[{key,cur,stages[{name,due,days,status,task_id,done_at}]}],status,who}`. `info`·`docs`는 서류생성용 **빈 슬롯**(지금 미사용).
- **템플릿**(`PROC_TEMPLATES`): lic_change(변경지시→접수→완료), waste, asbestos(석면철거: main + 백본 지정5일), demolition(건축물철거: main + 백본 건설3일). 공용 `WASTE_BACKBONE`(신고접수→필증인수(auto)→올바로등록→배차→처리→확인서인수), 행정처리기한 지정/석면 5일·건설 3일 자동.
- **엔진**: `startProcess(type,{client,site,start,who,lic_id})`→계약레코드+각 pipe 첫 단계 지시 생성. 단계 done(**승인 시점** `approveTask`에서 `advanceProc`)→다음 단계 자동 open, auto 기한은 완료일+N일. manual 기한 미입력이면 지시에 `기한 입력` 칩. 진행 `proc-chip`(라벨 i/total·단계명).
- **조건부 단계**(석면 없음 등)는 담당자가 그냥 완료로 스킵(조건 로직 없음).
- **UI 현황**: 인허가 행 `변경` 버튼(→lic_change) + **`계약` 탭 신설**(`계약 시작` 모달: 유형 석면철거/건축물철거/폐기물 + 거래처·현장·시작일·담당 → startProcess). 계약 목록에 파이프별 현재 단계·기한(지시 due 조회)·삭제. 석면/철거는 본+폐기물 2파이프 동시 생성 검증 완료(headless). **TODO(백엔드 단계)**: PDF 파싱(AI)·오기입 확인·서류 생성 → `info/docs` 슬롯 사용.

## 알람: 캘린더(.ics) 연동
- 요구된 "iOS·안드로이드 자동 알람"은 **기기 기본 캘린더 연동**으로 구현(가이드 §5 "푸시 알림 인프라" 금지 준수, 서버 0).
- 만기·지시 행의 `캘린더` 버튼 → `data:text/calendar` .ics 다운로드(VEVENT + VALARM -P7D·-P1D). 폰 기본 캘린더가 네이티브 알람을 울린다.
- 앱 자체는 푸시/백그라운드 알림을 하지 않는다(정적 PWA 한계·가이드 준수). 자동 갱신 구독(webcal) 원하면 추후 GitHub Actions로 .ics 피드 생성.

## 앱 구조 메모
- 앱 명칭: **종운 그룹웨어**(manifest/title). 좌상단 헤더는 `종운환경 · 종운건설`.
- 탭: `홈`(대시보드·기본) / `지시`(tasks·관리자 등록/관리) / `차량`(vehicles) / `기성`(receivables·구 수금) / `인허가`(licenses) / `업무`(구 주기업무: 상단 "내게 온 지시" 개인 인박스 + 주기 체크리스트, 내부 id는 `check` 유지).
- **반응형**: 모바일=상단 가로 탭(세그먼트), PC(≥860px)=좌측 세로 사이드바 + 우측 콘텐츠. `.layout`(flex)/`.tabbar`/`.views` 구조, 미디어쿼리로 전환.
- 데이터 파일별로 독립 로드·저장·충돌병합(sha 기반 PUT, 409/422 시 재조회 후 id 병합). tasks·receivables·licenses·vehicles 모두 병합 키 item.id, del=1 우선. (vehicles도 이제 편집 저장)
- 대시보드 만기(경과·임박)는 차량 + 인허가를 합산. 만기·지시 행의 `캘린더` 버튼은 .ics 알람 연동.
- SW 셸 캐시는 cache-first이므로 index.html 변경 시 sw.js의 `SHELL_CACHE` 버전을 반드시 올린다(현재 jw-shell-v15).
- 지시 등록 `담당` 입력칸은 회원명 datalist(`#memberNames`, `populateMemberNames()`) 자동완성 — 오타로 "내게 온 지시" 매칭이 깨지지 않게. 자유 입력도 유지.
- **선택 복구(2026-07-10)**: 지시·차량·기성 각 탭에 `삭제된 N 보기` 토글 → soft-delete(del=1) 항목을 개별 `복구` 버튼으로 되돌림. 공통 헬퍼 `renderDeletedList({items,can,toggleId,listId,show,noun,labelFn,onRestore})` + `restoreOneTask/Veh/Rec`. 각 render 함수 말미에서 호출. 옛 지시 "전체 복구"(restoreDeletedTasks)와 미연결 restoreDeletedVehicles 제거. 토글은 `canDo(mod)`일 때만 노출.
- **선택 삭제/복구 통일 + 선택 모드(2026-07-10)**: 지시·차량·기성 3모듈 공통으로 **개별 ×삭제·개별 복구 제거 → 체크박스 다중선택**. **선택 모드 토글**(`selMode[mod]`): 평소엔 체크박스 없이 행 탭=완료(지시)/하이라이트(기성), 목록 상단 `☑ 선택` 버튼 누르면 체크박스 노출 + 행 탭=선택으로 전환(완료·하이라이트와 겹침/오작동 방지). 셀바 `#{mod}SelBar`(주의: 지시는 mod="tasks"라 요소 id `tasksSelBar`), 선택 모드 시 전체선택 + `선택 삭제(N)`. 삭제된 목록: 체크박스 + 전체선택 + `선택 복구(N)` + **`영구삭제(N)`**(hardDelete: 배열에서 실제 제거, soft 아님·복구 불가·강한 확인). 공통: `selSets/delSelSets/selMode`, `renderSelBar`, `toggleSelId`, `bulkDelete/bulkRestore/hardDelete`, `selBoxHtml/bindSelBoxes`, `renderDeletedList(mod,toggleId,listId,show,noun,labelFn)`. 행 렌더러는 `sel=canDo&&selMode[mod]` 인자로 체크박스 분기(대시보드 공유 호출은 sel 없음). 선택 상태는 임시(새로고침 해제). ⚠️ 영구삭제는 저장 병합이 overwrite면 확정, 충돌 병합 시 재등장 가능(gw-backend blobs는 overwrite).
- **UI 일관성 개편(2026-07-10)**: 지시·차량·기성 목록 통일 — ① 선택 모드 폐기, **체크박스 상시 표시**(각 행 좌측 `.sel-box` 단일 네모). ② 셀바 맨 왼쪽 **글자 없는 전체선택 체크박스**(행 체크박스와 동일 `.sel-box`, 좌측 열 정렬) + 상시 표시 좌측정렬 기능버튼(선택 삭제/복구/영구삭제, 미선택 시 `disabled`). ③ **지시 동그란 완료박스·행 탭 완료 제거 → `완료` 버튼**(초록 `appr-btn`, `data-task-done`→toggleTaskDone, 권한 `canActTask`)로 실수 완료 방지 + 단일 체크박스 통일. ④ **캘린더 버튼 전부 제거**(.ics/downloadICS/bindCalHandlers 코드는 유지, 나중 재추가). ⑤ **차량 카드 가로 컴팩트**: `.veh-line`에 번호·검사/보험 D-day(`.veh-due` inline)·이력/수정(`.veh-acts` 우측) 한 줄, 셀 높이 축소. ⑥ 공통: 칸 여백 축소(`.item` 9px14px), 제목 글자 위계 강화(제목 크게·메타 작게). sw v53.
- **기성 UX(2026-07-10)**: ① 미수 행 본문 탭 → **하이라이트 토글**(`r.hl`, 저장·동기화, `.rec-hl`). ② **불일치(`mismatch`)는 미수 맨 아래** 정렬. ③ **정렬 드롭다운**(`recSort`: 청구일 오래된/최신·금액 큰순·거래처명) — 셀바에 위치. 정렬 우선순위: 중복 의심 최상단(0) < 일반(1) < 불일치(2), 그 안에서 `recSortCmp`.
- **차량 보험사 일괄 대조(2026-07-10)**: 차량 탭 하단 `보험사 일괄 대조(xlsx)` — 차량보유 현황표(자차 시트) 업로드 → 차량번호(공백 무시 정규화) 매칭 → 보험사 **채움/정정** 미리보기 후 적용(저장은 기존 경로=백엔드/Blobs). 회사명만 반영(전화 제거: `\n`·`(` 앞까지). 기성 홈택스 임포트의 순수 JS xlsx 파서(`xlsxRows/xlsxSheet/xlsxZip`, DecompressionStream) 재사용. 헬퍼 `vehInsurerMap/Plan/Apply`, `handleVehInsFile`, `showVehInsPreview`, `confirmVehInsImport`. 지입 시트엔 보험사 컬럼 없음(대상=자차).
