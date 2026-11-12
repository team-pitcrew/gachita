# 구조와 기술 스택

2026-11-13 기준입니다. 참가신청서 문구정리본(11/13)을 따릅니다. 달라진 것은 [작업 목록](tasks.md)의 머리말에 있습니다. 표의 '상태'는 이 저장소에 실제로 있는 것만 '있음'으로 적었습니다.

## 폴더

루트에 보이는 폴더는 `docs`, `frontend`, `backend` 셋입니다. 공모전에 낼 APK가 생기면 규정대로 루트에 `apk/`가 하나 더 생깁니다.

```
gachita/
├── docs/               규칙, 구조, API 명세, 결정 기록, 작업 목록
├── frontend/
│   ├── web/            웹앱. 폰에서 쓰는 화면
│   └── car/            차량 앱. Pleos 에뮬레이터와 실차에서 도는 Android 앱
├── backend/
│   ├── api/            API 서버
│   └── infra/
│       ├── terraform/  AWS 자원
│       └── gitops/     클러스터에 올릴 것의 선언. Argo CD가 읽는다
├── .github/            CI, PR·이슈 양식, 규칙 검사와 보드 스크립트(scripts/)
├── .githooks/          커밋 훅
└── Makefile · README.md · AGENTS.md
```

## 한눈에

```mermaid
flowchart LR
  subgraph 차 안
    Car["차량 앱 (frontend/car)\nAndroid · Compose · Pleos SDK"]
    Phone["웹앱 (frontend/web)\n폰 브라우저 · 홈 화면 설치"]
  end
  subgraph AWS
    Edge["Traefik 인그레스 · Let's Encrypt"]
    API["API 서버 (backend/api)\nNode 22"]
    PG[("Postgres\nCloudNativePG")]
    S3[("S3\n백업 · 클립")]
  end
  Car -->|HTTPS| Edge
  Phone -->|HTTPS| Edge
  Edge --> API --> PG
  PG -.->|백업| S3
  Car -->|같은 기기 안| Pleos["순정 내비 · 공조 · 좌석 · TTS"]
```

## 스택

| 묶음 | 스택 | 고른 이유 | 상태 |
|---|---|---|---|
| 웹앱 `frontend/web` | HTML · CSS · ES 모듈, 빌드 없음. 설치형 웹앱(PWA: 매니페스트와 서비스 워커). 글꼴 Pretendard | 화면 수가 적고, 차량 웹뷰와 폰 브라우저가 같은 파일을 그대로 읽음. 의존성이 없어 CI가 1초 안에 끝남. 화면이 열 개를 넘거나 상태가 얽히면 Vite + React로 옮김([ADR-0002](adr/0002-stack-split.md)) | 참가 4단계와 여행 화면 있음. 설치와 프로필 화면은 T6 |
| 차량 앱 `frontend/car` | Kotlin 2.0 · Jetpack Compose · AGP 8.6 · minSdk 28. Pleos Vehicle 2.3.2, NaviHelper 3.0.5, TextToSpeech 3.3.1, SpeechToText 3.3.1 | 내비·공조·좌석·TTS·STT는 Pleos SDK로만 부를 수 있음. 에뮬레이터에서 웹뷰 방식은 메모리 약 253 MB, 네이티브는 약 96 MB였음(Pleos 기준 400 MB) | 없음. T7에서 차박지도 앱의 연동 코드를 옮김 |
| API 서버 `backend/api` | Node 22 표준 `http`. Postgres 드라이버 `pg` 하나 | 경로가 열 개 안팎이라 프레임워크 없이 읽힘. 타입이 필요해지면 TypeScript로 옮김 | 있음. Postgres 저장과 기기 프로필 포함 |
| 데이터 | Postgres 17, CloudNativePG로 클러스터 안에서 운영 | 관리형 DB 없이 직접 운영하는 조건. 백업과 복구를 선언으로 다룸 | 선언 있음. 로컬과 CI는 Postgres 17 컨테이너 |
| 클라우드 | AWS. EC2 한 대에 K3s 직접 설치. Terraform으로 자원을 만들고 Argo CD가 `backend/infra/gitops`를 읽어 맞춤 | 한 대로 시작해 비용을 낮추고, 클러스터 상태를 저장소에서 읽을 수 있게 함 | Terraform과 클러스터 선언 있음([backend/infra/terraform](../backend/infra/terraform/README.md), [backend/infra/gitops](../backend/infra/gitops/README.md)). **아직 아무 자원도 만들지 않음** |
| CI | GitHub Actions. 네 파트 중 바뀐 것만 검사: `scope`, `policy`, `frontend-spec`, `frontend-app`, `backend-api`, `backend-infra`, `package` | SOVA처럼 필수 검사가 항상 결과를 내고 범위는 그 안에서 고름 | 있음 |

## 사용자 프로필

- **기기 프로필:** 처음 열면 서버가 프로필 ID와 긴 무작위 토큰을 발급하고, 기기에 저장합니다. 이후 요청은 이 토큰으로 본인임을 보입니다. 서버에는 토큰의 해시만 둡니다.
- **담는 것:** 이름, 자리별 선호(운전석·조수석·뒷자리의 온도·열선·통풍), 기록 동의의 기본값. 자리별 선호는 기획서 v4의 기능이고 지금 기준 문서에는 없습니다(T8). 가족을 한 묶음으로 두는 구조와 사람별 기록본(T39)은 아직 없습니다.
- **다른 기기로 옮기기:** 한 번만 쓰는 6자 코드로 옮깁니다(T6 이후).
- **따로 둘 것:** OAuth 로그인으로 만드는 프로필(T21)과 현대차 개인 프로필 연동(T22)은 기기 프로필과도, 서로와도 다른 기능으로 둡니다. 아직 없습니다.
- **격리:** 프로필과 여행 데이터를 서로 다른 Postgres 파드에 두고 네트워크로 막을 계획입니다(T23, T26). 지금은 한 DB에 표만 다릅니다.

## 연산을 두는 곳

Pleos는 주행 중 내비가 아닌 앱의 CPU를 5% 미만, RAM을 400 MB 이하로 두라고 적었습니다. 그래서 차량 앱은 화면과 Pleos SDK 호출, 주행 상태 판단을 맡고, 화자 대조와 장면 고르기 같은 무거운 연산은 서버에 둡니다. 받아쓰기는 Pleos STT(ON_DEVICE)에 맡기는 것을 제안했습니다([ADR-0008](adr/0008-in-car-capture-and-sdk-stt.md)). 수음 자체는 한 코어의 1% 안팎이었고, STT가 도는 동안의 자원은 아직 재지 않았습니다(T36). 통신이 끊겨도 이미 받은 부탁의 표시와 차량 제어는 차 안에서 돕니다.

## 외부 API

경로와 형식은 [API 명세](api/openapi.yaml)에, 외부 API의 자세한 상태는 [외부 API](api/external.md)에 있습니다.

| 무엇 | 어디서 부르나 | 쓰는 곳 | 상태 |
|---|---|---|---|
| Pleos NaviHelper | 차량 앱 | 경유지 반영, 현재 위치, 장소까지 거리·시간 | 에뮬레이터에서 확인(11/12). 조회와 거리 묻기는 화면 전환 없음 |
| Pleos Vehicle SDK | 차량 앱 | 기어, 좌석별 온도·열선·통풍 | 에뮬레이터에서 일부 확인(11/1, 11/10) |
| Pleos TextToSpeech | 차량 앱 | 제안과 알림을 말로 | 에뮬레이터에서 확인 |
| 길찾기(카카오모빌리티 또는 네이버 클라우드 Directions) | API 서버 | 들르면 늘어나는 시간 계산 | 정하지 않음. `requestTrip`은 장소 한 곳까지만 답해 우회 시간을 주지 못함 |
| 지도 표시(카카오 또는 네이버 지도 SDK) | 웹앱, 차량 앱 | 주행 기억 지도 | 정하지 않음 |
| Pleos SpeechToText | 차량 앱 | 대화 받아쓰기(앱이 받은 원음을 `sendAudio()`로 넣음) | 에뮬레이터에서 확인(11/13, [E2E 실측](emulator/e2e-flow.md)). ADR-0008 제안 |
| 화자 대조 | API 서버 | 같은 좌석 구역 안의 사람 구분 | 정하지 않음(T38). 원음을 어디까지 보낼지는 T12 |
| LLM(Claude API) | API 서버 | 장면 고르기 | 정하지 않음 |
| Let's Encrypt | 클러스터 | 인증서 | 선언 있음. 발급은 미확인 |

## 아직 없는 것

차량 앱, 웹앱의 프로필 화면, 클라우드 자원, 음성과 클립 처리. 순서는 [작업 목록](tasks.md)에 있습니다.
