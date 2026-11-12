# 같이타

차 안에서 웃었던 대화를 짧은 콘텐츠로 남기고, 동승자의 부탁과 자리 설정을 함께 챙기는 차량 서비스입니다. PITCREW 팀의 현대자동차그룹 차량용 앱 개발 공모전 출품작입니다.

## 지금 들어 있는 것

| 폴더 | 내용 | 상태 |
|---|---|---|
| `apps/web/` | 웹앱. 한 화면에 한 가지씩 네 단계로 참가하고(이름, 자리, 온도·시트, 기록 동의), 부탁을 남기고 상태를 봅니다 | 동작. 서버가 같이 내보냅니다 |
| `apps/car/` | Pleos 차량 앱(Android · Kotlin · Compose) | 아직 없음(T7) |
| `services/api/` | API 서버. 여행 코드, 참가자와 자리, 좌석·공조 선호, 기록 동의, 부탁의 상태, 장면의 시각과 위치 | 동작. 메모리 저장(Postgres는 T2) |
| `infra/` | AWS 자원(Terraform)과 클러스터 선언(Argo CD) | 아직 없음(T4, T5) |
| `docs/` | [개발 규칙](docs/development.md), [구조와 스택](docs/architecture.md), [작업 목록](docs/tasks.md), [프로젝트 보드](docs/project-board.md), [결정 기록](docs/adr) | |
| `apk/` | 제출용 APK(`팀명_앱이름_release.apk`) | 아직 없음(T13) |

## 실행 방법

```bash
make hooks     # 복제한 뒤 한 번: 커밋 훅 걸기
make run       # http://localhost:8787
make check     # CI와 같은 검사
```

브라우저에서 `http://localhost:8787`을 열고 '새 여행 만들기'를 누릅니다. 다른 기기는 같은 주소 끝에 `#코드`를 붙여 참가합니다. 운전석으로 참가한 사람에게만 출발·주차와 부탁 제안·수락 단추가 보입니다.

## 테스트 환경 및 필요한 설정

- Node.js 22 이상. 설치할 패키지는 없습니다.
- 확인한 환경: macOS, Node 22.22.3, 데스크톱 Chromium 계열 브라우저. 실제 휴대폰과 Pleos 에뮬레이터에서는 아직 열어 보지 않았습니다.
- 화면 글꼴 Pretendard는 CDN에서 받습니다. 받지 못하면 기기의 한글 글꼴로 보입니다.
- 포트는 환경 변수 `PORT`로 바꿉니다.
- 저장은 메모리에만 합니다. 서버를 다시 켜면 여행이 사라지고, 48시간이 지난 여행은 읽을 수 없습니다.
- 로그인이 없습니다. 여행 코드를 아는 사람이 그 여행을 읽고 고칩니다. 외부에 올릴 때는 이 점을 알고 올립니다.

## API

모든 경로는 `/api/trips` 아래에 있고 JSON을 주고받습니다. 오류는 `{ "error": "이유" }`로 옵니다.

| 요청 | 본문 | 하는 일 |
|---|---|---|
| `POST /api/trips` | `{ title? }` | 여행을 만들고 6자 코드를 돌려줍니다 |
| `GET /api/trips/:code?v=버전` | | 여행 전체 상태. 버전이 같으면 304 |
| `PATCH /api/trips/:code` | `{ status?, recording? }` | 상태는 `boarding`, `driving`, `parked`, `ended` |
| `POST /api/trips/:code/participants` | `{ name, seat, consent, prefs? }` | 참가. 한 자리에는 한 사람 |
| `PATCH /api/trips/:code/participants/:id` | `{ seat?, prefs?, consent? }` | 자리 이동, 선호와 동의 변경 |
| `POST /api/trips/:code/requests` | `{ by, text, when? }` | 부탁 남기기 |
| `PATCH /api/trips/:code/requests/:id` | `{ status }` | 부탁 상태 바꾸기 |
| `POST /api/trips/:code/moments` | `{ lat, lng, label?, at? }` | 장면의 시각과 위치 남기기 |

- **자리:** `ROW_1_LEFT`(운전석), `ROW_1_RIGHT`, `ROW_2_LEFT`, `ROW_2_CENTER`, `ROW_2_RIGHT`. Pleos Vehicle SDK의 `SeatArea` 이름과 같습니다.
- **선호:** `prefs`는 `{ tempC: 16~30, heat: 0~3, vent: 0~3 }`입니다. 차량 앱이 그 차의 지원 범위에 맞춰 적용합니다.
- **기록:** 주행(`driving`)을 시작할 때 참가자 모두가 동의했으면 기록을 켭니다. 한 명이라도 동의를 끄면 멈추고, 주차·종료에서 마감합니다.
- **부탁의 상태:** `held`(보관) → `proposed`(제안) → `accepted`(수락) → `reflected`(내비 반영 확인) → `done`(완료). 끝나기 전에는 언제든 `cancelled`로 갈 수 있습니다. 내비 요청이 실패하면 `accepted`에서 `held`로 되돌려 부탁을 남깁니다.

## APK 파일 위치

아직 없습니다. 차량 앱을 만들면 `apk/` 폴더에 올리고 이 절을 고칩니다.
