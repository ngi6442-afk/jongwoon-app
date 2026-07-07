# CLAUDE.md — jongwoon-app 작업 규칙

이 레포는 종운환경·종운건설의 업무 앱(설치형 PWA)이다. 상세 설계는 **jongwoon-docs/05_규정/JW-05-014_ERP설계구축가이드.md**를 먼저 정독할 것. 문서 체계 일반 규칙은 jongwoon-docs/05_규정/JW-05-013의 0장.

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
- M2 차량 만기(vehicles.json) → M3 수금(receivables.json) → M4 인허가(licenses.json): JW-05-014의 3~4장 스키마·완료 기준을 따른다.
- 단계 완료 시 이 파일과 가이드를 실태에 맞게 갱신한다.

## 앱 구조 메모 (M1 반영)
- 탭: `지시`(tasks.json) / `주기 체크`(checklist.json). 기본 탭은 `지시`.
- 데이터 파일별로 독립 로드·저장·충돌병합(sha 기반 PUT, 409/422 시 재조회 후 id 병합). tasks 병합 키는 item.id, del=1 우선.
- SW 셸 캐시는 cache-first이므로 index.html 변경 시 sw.js의 `SHELL_CACHE` 버전을 반드시 올린다(현재 jw-shell-v3).
