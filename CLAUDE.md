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
- M1 업무 전달(tasks.json) → M2 차량 만기(vehicles.json) → M3 수금(receivables.json) → M4 인허가(licenses.json): JW-05-014의 3~4장 스키마·완료 기준을 따른다.
- 단계 완료 시 이 파일과 가이드를 실태에 맞게 갱신한다.
