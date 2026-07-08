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
- M1 업무 전달(tasks.json): **구현 완료(P1, 2026-07-07)**. 앱 상단 `지시` 탭. 등록(내용·담당·기한, 지시자=로그인 이름 자동)·완료(완료자 기록)·보류·삭제(soft del=1). 기한순 정렬, 경과 빨강, 완료 이력. 기존 checklist.json의 deadlines를 tasks.json으로 이관하고(유실 0, id 보존) checklist에서 deadlines 키 제거. 이관 스크립트: `~/jongwoon/migrate_deadlines_to_tasks.py`(dry-run 기본, `--apply`로 적용).
- M2 차량·자산 만기(vehicles.json): **구현 완료(P2, 2026-07-07)**. `차량` 탭 + 통합 `대시보드`(첫 화면). vehicles.json은 assets 현황표에서 파생(읽기 전용, 연락처 제외·차주명까지만). 검사/보험 D-day 색상(경과 빨강·30일 주황·90일 노랑·**말소예정·매각·검사보류 회색**), 만기 임박순 정렬. 추출 스크립트: `~/jongwoon/extract_vehicles.py`(dry-run 기본). 갱신은 분기 1회 세션에서 현황표 대조. state 중 `검사보류`는 "검사 의도적 스킵" 차량(회색·대시보드 제외), 추출 시 노트 키워드로 자동 분류.
- M3 수금·기성(receivables.json): **구현 완료(P3, 2026-07-07)**. `수금` 탭. 청구 등록(거래처·내역·금액선택·청구일)·계산서 발행 토글·입금완료(paid=날짜)·미수전환·삭제(soft del). 미수 목록은 청구일 오래된 순, 미수 합계 표시. 대시보드에 미수 건수·목록 통합. 은행 연동 없음(수기 체크 층).
- M4 인허가·보수교육(licenses.json): **구현 완료(P4, 2026-07-08)**. `인허가` 탭(편집형). JW-04-001 인허가 13건을 시드로 넣되, **원천에 만료일이 비어 있어** 만료일·보수교육 예정일은 앱에서 직접 입력·수정(수정 모달). 만료일은 날짜/`해당없음`/미정(null) 지원. 날짜 입력 시 M2와 동일한 D-day 색상·대시보드·캘린더 알람 작동. 법정 만기일은 지어내지 않음(PM 입력).
- 단계 완료 시 이 파일과 가이드를 실태에 맞게 갱신한다.

## 알람: 캘린더(.ics) 연동
- 요구된 "iOS·안드로이드 자동 알람"은 **기기 기본 캘린더 연동**으로 구현(가이드 §5 "푸시 알림 인프라" 금지 준수, 서버 0).
- 만기·지시 행의 `캘린더` 버튼 → `data:text/calendar` .ics 다운로드(VEVENT + VALARM -P7D·-P1D). 폰 기본 캘린더가 네이티브 알람을 울린다.
- 앱 자체는 푸시/백그라운드 알림을 하지 않는다(정적 PWA 한계·가이드 준수). 자동 갱신 구독(webcal) 원하면 추후 GitHub Actions로 .ics 피드 생성.

## 앱 구조 메모
- 탭: `홈`(대시보드·기본) / `지시`(tasks) / `차량`(vehicles) / `수금`(receivables) / `인허가`(licenses) / `체크`(checklist).
- 데이터 파일별로 독립 로드·저장·충돌병합(sha 기반 PUT, 409/422 시 재조회 후 id 병합). tasks·receivables·licenses 병합 키는 item.id, del=1 우선. vehicles만 읽기 전용(저장 없음).
- 대시보드 만기(경과·임박)는 차량 + 인허가를 합산. 만기·지시 행의 `캘린더` 버튼은 .ics 알람 연동.
- SW 셸 캐시는 cache-first이므로 index.html 변경 시 sw.js의 `SHELL_CACHE` 버전을 반드시 올린다(현재 jw-shell-v6).
