# 구조와 기술 스택

2026-11-14 기준입니다. 참가신청서 문구정리본(11/13)과 11/14 계획 결정을 따릅니다. 달라진 것은 [작업 목록](tasks.md)의 머리말에 있습니다. 표의 '상태'는 이 저장소에 실제로 있는 것만 '있음'으로 적었습니다.

## 폴더

루트에 보이는 폴더는 `docs`, `frontend`, `backend`와 공모전 규정대로 둔 `apk/`입니다.

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
├── apk/                제출용 차량 앱 APK
├── .github/            CI, PR·이슈 양식, 규칙 검사와 보드 스크립트(scripts/)
├── .githooks/          커밋 훅
└── Makefile · README.md · AGENTS.md
```

## 한눈에

```mermaid
flowchart LR
  subgraph 차 안
    Car["차량 앱 (frontend/car)\nAndroid · Compose · Pleos SDK"]
    Phone["웹앱 (frontend/web)\n폰 브라우저"]
  end
  CF["Cloudflare 엣지\ngachita.mangowhois.ai · TLS · 캐시 · 요청 수 제한"]
  subgraph AWS["AWS · EC2 한 대 · K3s"]
    ALB["ALB gachita-dev\n(AWS Load Balancer Controller가 Gateway로 만듦)"]
    API["gachita: API 서버 (backend/api)\nNode 22 · NodePort"]
    PG[("gachita-db: Postgres 하나\ntrips · profiles")]
    S3[("S3\n백업 · 클립")]
  end
  Car -->|HTTPS| CF
  Phone -->|HTTPS| CF
  CF -->|HTTPS 443| ALB --> API
  API --> PG
  PG -.->|백업| S3
  Car -->|같은 기기 안| Pleos["순정 내비 · 기어 · STT · TTS · Gleo"]
```

## 스택

| 묶음 | 스택 | 고른 이유 | 상태 |
|---|---|---|---|
| 웹앱 `frontend/web` | HTML · CSS · ES 모듈, 빌드 없음. 글꼴 Pretendard. 홈 화면 설치(매니페스트와 서비스 워커) | 화면 수가 적고, 폰 브라우저가 파일을 그대로 읽음. 의존성이 없어 CI가 1초 안에 끝남. 화면이 열 개를 넘거나 상태가 얽히면 Vite + React로 옮김([ADR-0002](adr/0002-stack-split.md)) | 있음. 프로필, 동승 연결 QR, 기록 동의, 여행 화면의 여행·대화·쇼츠 탭(대화방, 세로 쇼츠, #239), 여행 뒤 기록본·자막 고치기·공유, 홈 화면 설치, 웹 시연(`/demo`). 데스크톱·헤드리스 브라우저에서 확인 |
| 차량 앱 `frontend/car` | Kotlin 2.0 · Jetpack Compose · AGP 8.6 · minSdk 29 · targetSdk 34. Pleos Vehicle 2.3.2, NaviHelper 3.0.5, TextToSpeech 3.3.1, SpeechToText 3.3.1 | 내비·기어·TTS·STT는 Pleos SDK로만 부를 수 있음. 에뮬레이터에서 웹뷰 방식은 메모리 약 253 MB, 네이티브는 약 96 MB였음(Pleos 기준 400 MB) | 있음. 여행과 기록 동의, 수음과 받아쓰기, 주행 중 화면, 부탁을 경유지로, 도착 브리핑, 동승자 연결 QR 읽기, 목소리 등록과 말한 사람 강조, 기본 내비 옆 반쪽 창의 탭 셋(함께 타는 중·대화 기록·쇼츠, #239)(에뮬레이터에서 확인. #239 뒤 다시 돈 E2E는 쇼츠뿐, [차량 앱 README](../frontend/car/README.md)). 실차에서는 확인하지 않음 |
| API 서버 `backend/api` | Node 22 표준 `http`. Postgres 드라이버 `pg` 하나 | 경로가 서른 개 안팎이어도 프레임워크 없이 읽힘. 타입이 필요해지면 TypeScript로 옮김 | 있음. 프로필과 구글 연결, 동승 연결, 여행, 발화·기록본·피드, 목소리 등록과 대조, 장면 후보·숏폼 구성, 클립과 다시 받아 적기, 자막 고치기, 공유([API 명세](api/openapi.yaml)). 그룹과 초대 코드 경로는 닫음(11/14) |
| 데이터 | Postgres 17, CloudNativePG로 클러스터 안에서 운영 | 관리형 DB 없이 직접 운영하는 조건. 백업과 복구를 선언으로 다룸 | 실서비스: CloudNativePG 클러스터 하나에 `trips`·`profiles` 두 DB([ADR-0016](adr/0016-slo-capacity-single-postgres.md)). 로컬과 CI는 Postgres 17 컨테이너 |
| 클라우드 | AWS. EC2 한 대에 K3s 직접 설치. Terraform으로 자원을 만들고 Argo CD가 `backend/infra/gitops`를 읽어 맞춤 | 한 대로 시작해 비용을 낮추고, 클러스터 상태를 저장소에서 읽을 수 있게 함 | 11/13부터 실서비스(`https://gachita.mangowhois.ai`). EC2 t4g.large 한 대에 K3s, Cloudflare → ALB → API. 실제 주소 E2E 통과, Route 53이 밖에서 30초마다 점검. 선언은 [backend/infra/terraform](../backend/infra/terraform/README.md), [backend/infra/gitops](../backend/infra/gitops/README.md) |
| CI | GitHub Actions. 네 파트 중 바뀐 것만 검사: `scope`, `policy`, `frontend-spec`, `frontend-app`, `backend-api`, `backend-infra`, `package` | SOVA처럼 필수 검사가 항상 결과를 내고 범위는 그 안에서 고름 | 있음. 11/13부터 자체 러너(Lima VM 다섯, T65)에서 돎 |

## 사용자 프로필

- **기기 프로필:** 처음 열면 서버가 프로필 ID와 긴 무작위 토큰을 발급하고, 기기에 저장합니다. 이후 요청은 이 토큰으로 본인임을 보입니다. 서버에는 토큰의 해시만 둡니다.
- **담는 것:** 이름 또는 별명, 캐릭터나 사진, 기록 동의의 기본값. 좌석·공조 선호는 11/13 계획에서 뺐습니다. 서버와 웹에서 걷어냈습니다(T68, T6). 11/14 결정으로 가족은 따로 묶지 않고 같은 차에 탄 기록으로만 잇고, 동승자는 폰의 동승 연결 QR을 차가 읽어 넣기로 했습니다. [ADR-0009](adr/0009-family-group-and-qr-invite.md)의 그룹과 QR 초대(`/j/`)는 닫았습니다(T46, #198). 사람별 기록은 발화 표와 피드에 쌓입니다(T39, [ADR-0014](adr/0014-transcript-storage.md)).
- **여러 기기:** 기기마다 토큰을 따로 둡니다(`POST /api/profiles/me/tokens`). 다른 기기의 토큰은 그대로입니다.
- **따로 둘 것:** OAuth 로그인으로 만드는 프로필과 현대차 개인 프로필 연동은 기기 프로필과도, 서로와도 다른 기능으로 둡니다. 구글 계정 연결은 서버에 있습니다(T21, [ADR-0006](adr/0006-oauth-provider-google.md)). 한 프로필에 구글 계정 하나이고, 다른 기기에서 계정으로 들어오면 그 기기의 토큰을 새로 줍니다. 웹앱에는 아직 구글 단추가 없습니다. 현대 계정 연동은 조건만 조사했습니다(T22, [ADR-0004](adr/0004-hyundai-profile-link.md)).
- **격리:** 실서비스는 Postgres 클러스터 하나에 프로필(`profiles`)과 여행(`trips`)을 다른 DB로 두고, DB마다 접속 계정을 나눕니다([ADR-0016](adr/0016-slo-capacity-single-postgres.md)). 네트워크는 기본 차단이고 API 파드만 DB에 닿습니다([ADR-0013](adr/0013-network-edge-and-isolation.md)). 처음 선언한 '네임스페이스마다 Postgres 하나'는 ADR-0016으로 바꿨습니다.

## 연산을 두는 곳

Pleos는 주행 중 내비가 아닌 앱의 CPU를 5% 미만, RAM을 400 MB 이하로 두라고 적었습니다. 그래서 차량 앱은 화면과 Pleos SDK 호출, 주행 상태 판단을 맡고, 화자 대조와 장면 고르기 같은 무거운 연산은 서버에 둡니다. 받아쓰기는 Pleos STT(ON_DEVICE)에 맡깁니다([ADR-0008](adr/0008-in-car-capture-and-sdk-stt.md), 차 앱에 있음, T36). 에뮬레이터에서 1시간(내비 앞, 기어 D, 10분에 50문장) 잰 값은 우리 앱이 기기 전체 CPU의 평균 1.41%(최대 4.05%), 메모리(PSS) 평균 74 MB였고, Pleos STT 엔진은 평균 4.9%(최대 12.3%), 296 MB였습니다(T63 #222). 실차는 재지 않았습니다. 통신이 끊겨도 이미 받은 부탁의 표시와 차량 제어는 차 안에서 돕니다.

## 음성 처리 흐름

말이 차 안에서 글이 됩니다. 서버에 남는 원음은 사람이 고른 장면의 클립뿐이고, 목소리 등록과 말한 사람 맞추기에 쓰는 소리는 잠깐 서버로 보냈다가 원본을 저장하지 않고 버립니다([ADR-0019](adr/0019-speaker-matching.md), [음성 처리 명세](api/voice.md)의 동의 문구). 단계마다 고른 방법과 뺀 대안은 결정 기록에 있고, 받아 적은 글의 품질을 높이는 데이터(출처, 모으기, 다듬기, 넣는 자리)는 [전사록 데이터](transcript-data.md)에 있습니다.

| # | 단계 | 어디서 | 왜 이 방법인가 | 상태 |
|---|---|---|---|---|
| 1 | 수음 | 차. `AudioRecord` 16 kHz 2채널. 모두 동의하고 기록 중일 때만 | 기준 문서가 차량 직접 수음을 기본으로 둠. 폰 수음은 두지 않음([ADR-0008](adr/0008-in-car-capture-and-sdk-stt.md)) | 있음(에뮬레이터) |
| 2 | 받아쓰기 | 차. Pleos STT(ON_DEVICE)에 `sendAudio()` | 말이 끝나고 0.6초 안팎에 글이 나와 부탁 제안에 맞음. 클라우드 받아쓰기는 원음 전체가 차 밖으로 나가 뺌([ADR-0007](adr/0007-voice-processing-flow.md)) | 있음(에뮬레이터) |
| 3 | 좌석 구역 | 차. 두 채널의 소리 크기로 앞줄·뒷줄 | Pleos SDK에 화자·좌석 API가 없음. 네 자리 구분은 확인하지 못함([E2E 실측](emulator/e2e-flow.md)) | 있음(에뮬레이터, T37 #225: 합성 음성 12문장 12/12, 실차 마이크 배치는 확인 전) |
| 4 | 발화 올리기 | 차 → API `POST /api/trips/{code}/utterances`. 순번과 확인 순번으로 끊겨도 다시 보냄 | 동의 세대가 바뀌면 옛 발화는 내용 없이 순번만([ADR-0014](adr/0014-transcript-storage.md), [음성 처리 명세](api/voice.md)) | 있음(에뮬레이터, #172: 52문장 52/52) |
| 5 | 말한 사람 맞추기 | 차 → API. 등록 음성(1~20초)과 발화 음성(0.5~10초)을 보내 구역 안 후보의 등록 목소리와 대조, 기준을 넘으면 그 프로필, 아니면 '모름'. 소리는 대조용 값만 남기고 원본은 바로 버림 | 클라우드 화자 API는 원음이 제3자에게 가서 뺌. 지금은 의존성 없는 참조 임베더, 학습된 모델은 정확도 표 뒤([ADR-0019](adr/0019-speaker-matching.md)) | 서버 있음(손님 단위 등록 #176, 사람이 고친 화자 #204). 차의 등록 화면과 대조 호출·고치기도 있음(에뮬레이터, T37 #225: 맞힘 6·틀림 1·모름 5, 실차는 확인 전) |
| 6 | 부탁·할 일 알아채기 | 차. 낱말 규칙 | 말이 끝난 직후 반응해야 해 차 안의 규칙으로 둠. LLM 판정은 뒤로 미룸(`Asks.kt`, `Todos.kt`) | 있음(에뮬레이터) |
| 7 | 장면 후보 | API. 규칙 | LLM 계약 전이라 규칙으로 고름(11/14) | 서버 있음(#181, 합성 대화 시험) |
| 8 | 사람이 고른 장면의 클립 | 차가 고른 구간만 올림. 그때까지 차 안에 암호화해 둠(기간 제한 없음, T90 — 원음 지우기·동의 철회 때 지움) | 원음 전체는 차 밖으로 보내지 않음([ADR-0007](adr/0007-voice-processing-flow.md)). 클립은 기존 API 주소에서 참가자 토큰을 확인하고 내줌([ADR-0021](adr/0021-shortform-as-composition-data.md), ADR-0020의 `media` 하위 도메인은 두지 않음) | 서버와 클립 버킷 있음(#163·#167), 차에서 고른 구간 잘라 올리기 있음(에뮬레이터, 가짜 S3, #222). 실제 버킷으로는 확인 전 |
| 9 | 고른 클립 다시 받아 적기 | API → 재전사 서버. 고른 클립만, 서버에 설정이 있을 때만 | Pleos 초안이 짧은 물음에서 틀린 것을 자막에서 고침. 동의 화면에 밝힘 | 서버 있음(#183, 실패하면 원문 자막. 서버에 설정이 있을 때만, 길은 #191) |
| 10 | 숏폼 | 폰 9:16 재생 페이지, 주차 중 차 | 클립·자막·말한 사람을 이어 틈([ADR-0021](adr/0021-shortform-as-composition-data.md)). 영상 파일은 기기에서 만들고, 서버의 힉스필드 생성은 꺼서 배포([ADR-0022](adr/0022-shortform-video-on-device-and-server-generation-off.md)) | 폰 있음(#185, 브라우저). 차는 주차 중 재생 있음(에뮬레이터, #233). #239부터 폰·차 모두 전신 캐릭터와 자막을 그리는 세로 쇼츠 화면. 영상 만들기: 웹은 MP4 또는 WebM 내려받기·공유, 차는 MP4를 갤러리에 저장(#239·#244·#245, 코드와 단위 시험). 서버 생성(T85·T86)은 `SHORTS_ENABLED=false`라 503이고 부르는 화면이 없음 |

## 외부 API

경로와 형식은 [API 명세](api/openapi.yaml)에, 외부 API의 자세한 상태는 [외부 API](api/external.md)에 있습니다.

| 무엇 | 어디서 부르나 | 쓰는 곳 | 상태 |
|---|---|---|---|
| Pleos NaviHelper | 차량 앱 | 경유지 반영, 현재 위치, 장소까지 거리·시간 | 에뮬레이터에서 확인(11/12). 조회와 거리 묻기는 화면 전환 없음 |
| Pleos Vehicle SDK | 차량 앱 | 기어 | 에뮬레이터에서 확인(Cold boot에서만 읽힘). 좌석·공조 적용은 11/13 계획에서 뺌 |
| Pleos TextToSpeech | 차량 앱 | 제안과 알림을 말로 | 에뮬레이터에서 확인 |
| 길찾기(카카오모빌리티 또는 네이버 클라우드 Directions) | API 서버 | 들르면 늘어나는 시간 계산 | 정하지 않음. `requestTrip`은 장소 한 곳까지만 답해 우회 시간을 주지 못함 |
| 휴게소 위치(한국도로공사 공공데이터) | API 서버 | 경로 위 휴게소 추천(`POST /api/rest-stops`) | 있음(T97). 202곳(좌표가 틀린 1곳 뺌)을 저장소에 넣어 두고 서버 안에서 계산. 바깥 호출·키 없음. 경로 좌표가 없어 직선으로 어림 |
| 지도 표시(카카오 또는 네이버 지도 SDK) | 웹앱, 차량 앱 | 주행 기억 지도 | 정하지 않음 |
| Pleos SpeechToText | 차량 앱 | 대화 받아쓰기(앱이 받은 원음을 `sendAudio()`로 넣음) | 에뮬레이터에서 확인(11/13, [E2E 실측](emulator/e2e-flow.md)). 차 앱에 있음(T36) |
| 화자 대조 | API 서버 | 같은 좌석 구역 안의 사람 구분 | 서버 안의 참조 임베더로 만듦([ADR-0019](adr/0019-speaker-matching.md)). 학습된 모델은 정확도 표 뒤(T38). 말소리는 대조에만 쓰고 버림 |
| LLM(Claude API) | API 서버 | 장면 고르기 | 쓰지 않음. 장면 후보는 규칙으로 고름(T43, #181) |
| 재전사(Nemotron ASR, 외부 서버) | API 서버 | 고른 장면 클립의 자막 다시 받아 적기 | 있음(T75, #183). 서버에 `ASR_URL`·토큰이 있을 때만, 실패하면 원문 자막. 나가는 길은 #191 |
| 힉스필드(Seedance 2.5) | API 서버 | 쇼츠의 두 캐릭터 반응 장면 생성 | 배포했으나 꺼짐(T85·T86, `SHORTS_ENABLED=false`). 부르는 화면 없음. 보내는 것과 남은 위험은 [ADR-0022](adr/0022-shortform-video-on-device-and-server-generation-off.md) |
| Cloudflare | 가장자리 | 주소 `gachita.mangowhois.ai`, 서버로 가는 길, 요청 수 제한 | 동작(11/13부터, [ADR-0010](adr/0010-domain-and-cloudflare-edge.md)). 길·격리·포트는 [ADR-0013](adr/0013-network-edge-and-isolation.md)과 그 1·3절을 대신한 [ADR-0015](adr/0015-split-nodes-private-subnets-alb.md). 클립과 서버가 만든 영상(꺼 둠)은 같은 주소의 API가 내줌([ADR-0021](adr/0021-shortform-as-composition-data.md), [ADR-0022](adr/0022-shortform-video-on-device-and-server-generation-off.md)) |

## 아직 없는 것

실차와 실제 휴대폰에서의 확인, 실제 클립 버킷으로 끝까지 이어 보기, 폰의 주행 기억 지도와 차의 도착 후 요약. 순서는 [작업 목록](tasks.md)에 있습니다.
