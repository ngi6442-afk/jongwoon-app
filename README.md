# 종운 그룹웨어 (jongwoon-app)

종운환경·종운건설의 업무 앱입니다. 단일 `index.html` 설치형 PWA와 Netlify Functions 서버로 이루어져 있습니다.
처음 시작은 JW-02-04-001 주기별 업무체크리스트(구 JW-05-011)였고, 지금은 지시·결재·차량·기성·인허가·계약·운반일지·화관법·안전·급여 등 그룹웨어 전체를 담습니다.

> 작업 규칙과 현재 상태는 이 문서가 아니라 `HANDOFF.md`(운영 헌장) → `CLAUDE.md`(작업 규칙) → `FEATURES.md`(판별 기록) 순서로 봅니다.

## 접속과 설치

1. 주소: `https://jongwoon-app.netlify.app/`
2. 로그인: 개인 아이디와 비밀번호(관리자가 발급, 직원이 [내 아이디 설정]으로 변경). 이름 로그인은 2026-09-11 종료.
3. 처음 쓰는 기기는 **기기 승인**을 받아야 합니다(관리자가 승인). 승인 전에는 자료를 읽거나 쓸 수 없습니다.
4. 브라우저 메뉴의 "홈 화면에 추가"로 아이콘을 만들면 앱처럼 쓸 수 있습니다.

## 구조

| 층 | 내용 |
|---|---|
| 화면 | `index.html` 한 파일(외부 CDN·프레임워크·빌드 없음), `sw.js` 서비스워커, `manifest.webmanifest` |
| 서버 | `netlify/functions/` — 로그인·권한(`gw-auth`), 자료 읽기·저장(`gw-data`), 업무별 함수(`gw-hwakwan`·`gw-allbaro`·`gw-pay`·`gw-stmt` 등), 공용 모듈 `_lib/` |
| 자료 | **Netlify Blobs**(회원 `gw_users`, 업무 자료 `gw_data` 등)가 유일한 원천. 저장할 때마다 버전 링이 남아 시점 복구가 됩니다 |
| 예약 실행 | `netlify.toml`의 스케줄 함수(화관법 자동 제출·올바로 수집·할 일 알림 등). 앱 밖 감시·백업은 `jongwoon-appdata`의 GitHub Actions |
| 백업 | `jongwoon-appdata`의 `data/backup/`(매일 Blobs 스냅샷). 그 저장소의 다른 `data/*.json`은 옛 미러라 원천이 아닙니다 |

- 권한은 서버가 강제합니다(회원별 do/view/hide). 브라우저에는 GitHub 토큰이 없습니다(2026-08 단일 원천 전환 때 제거).
- 개인정보는 최소로 둡니다(연락처·주민번호·계좌는 앱 자료에 넣지 않음).

## 배포

- Netlify가 **`claude/gw-backend` 브랜치**를 배포합니다. `main`은 참고용이고 배포되지 않습니다.
- 판 번호는 `sw.js`의 `SHELL_CACHE` 값(예: `jw-shell-v541`)과 `FEATURES.md` 기록을 함께 올립니다.
- 배포 전 검사: `tools/`의 화면 검사(uismoke)와 서버 검사(servertest), `node --check netlify/functions/*.js`. 절차는 `CLAUDE.md`·`RUNBOOK.md`.

## 문서

| 파일 | 내용 |
|---|---|
| `HANDOFF.md` | 운영 헌장 — 금지·해제 대장, 의도된 설계, 검증 의무 |
| `CLAUDE.md` | 작업 규칙과 기능별 경계 |
| `FEATURES.md` | 판(버전)별 변경 기록 |
| `RUNBOOK.md` | 장애·경보 대응 절차 |
| `TESTLIST.md` | 사람이 확인할 시험 목록 |
| `MANUAL.html` | 직원용 사용 설명서 |
| `BACKEND.md` | 서버 도입(1단계) 당시 설계 기록 |
| `ROADMAP.md` | 남은 계획 |
