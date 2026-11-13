# 가치타

**가족이 차 안에서 나눈 대화를 차가 받아 적어, 아이의 부탁은 내비 경유지로, 장소별 할 일은 도착했을 때 알려 주는 Pleos 차량 앱입니다.** PITCREW 팀의 현대자동차그룹 차량용 앱 개발 공모전 출품작입니다.

- 차량 앱(`frontend/car`)이 기록 동의를 받은 뒤 차량 마이크로 수음해 Pleos STT(ON_DEVICE)로 받아 적습니다.
- "화장실 가고 싶어"를 알아채 휴게소를 화면과 말로 제안하고, "응, 다음 휴게소 가자"로 순정 내비에 경유지를 넣습니다. 휴게소는 시연 경로(판교 → 강릉, 영동고속도로 강릉방향)의 고정 목록에서 아직 지나치지 않은 곳을 고릅니다.
- "마트에서 우유랑 간식 사자"를 모아 두었다가 마트에 주차하면 할 일을 알립니다. 같은 기능을 Gleo 함수로 선언해 두었습니다(Pleos 승인 전, 음성 호출은 확인하지 않음).
- 주행 중에는 Pleos 주행 제한 값에 맞춰 설정 화면과 목록을 가립니다.
- 위 동작은 Pleos Connect Emulator 2.1.0에서 확인했습니다(Gleo 음성 호출은 빼고). 실차에서는 확인하지 않았습니다.
- 서버와 폰 웹앱은 **https://gachita.mangowhois.ai**에서 돕니다(11/13부터, AWS). 폰은 수음하지 않고 프로필·초대·참가·기록 동의·부탁을 맡습니다.

## 지금 들어 있는 것

| 폴더 | 내용 | 상태 |
|---|---|---|
| `frontend/web/` | 폰 웹앱. 프로필(이름·캐릭터·사진), 그룹 초대 수락(`/j/<초대>`), 한 화면에 한 가지씩 묻는 여행 참가와 기록 동의, 부탁 남기기와 상태 보기. 웹 시연(`/demo`) | 동작. 서버가 같이 내보냅니다. 참가 단계의 온도·시트는 걷어내는 중(T68·T6) |
| `frontend/car/` | Pleos 차량 앱(Android · Kotlin · Compose). 여행과 기록 동의, 수음과 받아쓰기, 주행 중 화면, 부탁을 경유지로, 도착 브리핑([차량 앱 README](frontend/car/README.md)) | 동작(에뮬레이터). 받아 적은 말은 아직 서버로 보내지 않고 차 안에 쌓음 |
| `backend/api/` | API 서버. 기기 프로필과 구글 계정 연결(OAuth), 그룹과 QR 초대, 여행 코드, 참가자와 자리, 기록 동의, 부탁의 상태, 장면, 발화·기록본·피드, 목소리 등록과 대조 | 동작. Postgres에 저장. 좌석·공조 선호는 11/13 계획에서 빼는 중(T68) |
| `backend/infra/` | AWS 자원([Terraform](backend/infra/terraform/README.md))과 클러스터 선언([Argo CD](backend/infra/gitops/README.md)) | 실서비스 동작(11/13부터). Cloudflare → ALB → K3s 한 노드(t4g.large) → API, CloudNativePG Postgres 하나에 `trips`·`profiles` 두 DB. 실제 주소 E2E 통과, Route 53이 밖에서 30초마다 점검 |
| `docs/` | [개발 규칙](docs/development.md), [구조와 스택](docs/architecture.md), [작업 목록](docs/tasks.md), [프로젝트 보드](docs/project-board.md), [결정 기록](docs/adr), [실측 보고](docs/research) | |
| `apk/` | 제출용 차량 앱 APK(`PITCREW_가치타_release.apk`) | 있음 |

## 실행 방법

### 차량 앱(Pleos 에뮬레이터)

1. **서버:** 저장소 루트에서 `make run`. `http://localhost:8787`에 API와 웹앱이 뜨고 로컬 Postgres 컨테이너를 같이 띄웁니다(Docker 필요).
2. **에뮬레이터:** Pleos Connect Emulator 2.1.0(AVD `Pleos_Connect_v2_0` 기기 정의)을 **Cold boot**로 켭니다. Quick boot에서는 기어 같은 차량 값을 읽지 못합니다. 기어와 속도는 Virtual Console(`adb forward tcp:8088 tcp:8088` 뒤 `http://127.0.0.1:8088/`)에서 바꿉니다.
   - 차량 마이크에 말하려면 에뮬레이터의 Extended controls > Microphone에서 PC 마이크를 가상 마이크로 쓰게 켭니다(Pleos 문서). 우리 Mac에는 마이크가 없어 PC 마이크로는 해 보지 않았고, 음성 파일을 gRPC로 넣었습니다(`-grpc 8556 -grpc-use-token -audio none`으로 켜고 [차량 앱 README](frontend/car/README.md)의 스크립트).
3. **설치와 실행:** 앱은 사용자 10에서 돕니다. 같은 패키지의 디버그 빌드를 깔았던 에뮬레이터라면 서명이 달라 먼저 지웁니다(`adb uninstall io.github.teampitcrew.gachita`).

```bash
adb install --user 10 -r -g apk/PITCREW_가치타_release.apk
```

```bash
adb shell am start --user 10 -n io.github.teampitcrew.gachita/.MainActivity
```

4. **기록 시작:** 첫 화면에서 가족을 고르고 '여행 만들기'(서버 주소 기본값 `http://10.0.2.2:8787`은 에뮬레이터에서 본 PC의 `make run`) → 기어 P에서 '대화 기록 동의'를 켬('● 기록 중'). 마이크·알림 권한은 처음 기록할 때 묻습니다(`-g`로 설치하면 미리 허용).
5. **부탁이 경유지로:** 순정 내비에서 목적지를 정하고(예: 강릉역) 우리 앱을 다시 앞으로, 기어 D → 차량 마이크에 "화장실 가고 싶어" → 제안 카드와 "용인휴게소에 들를까요?" → "응, 다음 휴게소 가자"(또는 '경유지로 추가') → 내비가 앞으로 나와 경유지가 들어가고, 앱으로 돌아오면 '경유지를 추가했어요'.
6. **도착 브리핑:** 내비 목적지를 이름에 '마트'가 든 곳(예: 이마트 강릉점)으로 정하고 경유지는 두지 않음 → 기어 D에서 "마트에서 우유랑 간식 사자" → 속도를 5 km/h 이하로 두고 기어 P → '마트에서 할 일' 카드와 TTS. 앱은 주차한 순간 내비가 향하는 다음 곳(첫 경유지, 없으면 목적지)이 할 일의 장소일 때 알리므로, 5에서 넣은 휴게소가 남아 있으면 알리지 않습니다.
   - 자동으로 같은 흐름을 도는 스크립트(`frontend/car/demo.py`, `waypoint_e2e.py`, `arrival_e2e.py`)는 디버그 빌드용입니다(서버·목적지를 실행 인자로 받음). 시연 영상도 디버그 빌드와 `demo.py`로 찍었습니다. release APK로는 4까지 에뮬레이터에서 확인했습니다.

### 서버와 웹앱

```bash
make hooks     # 복제한 뒤 한 번: 커밋 훅과 커밋 양식 걸기
make run       # http://localhost:8787 (로컬 Postgres 컨테이너를 같이 띄움)
make check     # CI와 같은 검사
```

브라우저에서 `http://localhost:8787`을 열고 '새 여행 만들기'를 누릅니다. 다른 기기는 같은 주소 끝에 `#코드`를 붙여 참가합니다. 운전석으로 참가한 사람에게만 출발·주차와 부탁 제안·수락 단추가 보입니다.

## 테스트 환경 및 필요한 설정

- **차량 앱:** Pleos Connect Emulator 2.1.0(Android 14, API 34, arm64), Mac mini M5 Pro, 2026-11-13. 실차에서는 확인하지 않았습니다. 화면 크기와 확인 범위는 [에뮬레이터 스펙](docs/emulator/README.md)에 있습니다.
- 차량 앱이 서버에 닿는 주소는 첫 화면의 '서버 주소'입니다. 평문 http는 `10.0.2.2`·`localhost`·`127.0.0.1`에만 열려 있고 그 밖은 https만 씁니다. 실제 서버 주소는 `https://gachita.mangowhois.ai`입니다.
- 차량 앱을 빌드하려면 JDK 21과 Android SDK 34가 필요합니다(`cd frontend/car && ./gradlew assembleRelease`). 릴리스 서명 키는 저장소에 없고, `~/.gachita/keystore.properties`가 있을 때만 서명합니다.
- Node.js 22 이상, Docker(로컬 Postgres 17 컨테이너용). API 서버의 의존성은 `pg` 하나입니다.
- 웹앱을 확인한 환경: macOS, Node 22.22.3, 데스크톱 Chromium 계열 브라우저. 웹앱은 실제 휴대폰에서 아직 열어 보지 않았습니다.
- 화면 글꼴 Pretendard는 CDN에서 받습니다. 받지 못하면 기기의 한글 글꼴로 보입니다.
- 포트는 환경 변수 `PORT`로 바꿉니다.
- 저장은 Postgres에 합니다. 여행 저장소와 프로필 저장소의 접속 주소는 환경 변수 `TRIPS_DATABASE_URL`과 `PROFILES_DATABASE_URL`로 각각 줍니다. 없으면 `DATABASE_URL` 하나를 같이 씁니다. 48시간이 지난 여행은 읽을 수 없고 다음 여행을 만들 때 지워집니다.
- 로그인 없이 쓰는 기기 프로필이 기본입니다. 서버가 발급한 토큰을 기기에 두고, 서버에는 해시만 남깁니다. 프로필 없이도 여행 코드를 아는 사람은 그 여행을 읽고 고칩니다.
- 기기 프로필에 구글 계정을 연결하면 기기를 바꿔도 프로필을 이어 받습니다(ADR-0006). 구글 클라이언트 값은 환경 변수 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`로 줍니다. 현대 계정 연동은 아직 없습니다(ADR-0004).

## API

정식 명세는 [docs/api/openapi.yaml](docs/api/openapi.yaml)입니다(0.6.0, 경로 27개). API 테스트가 명세와 서버의 경로가 같은지 봅니다. 발화·기록본·목소리처럼 음성에 닿는 경로의 인증과 보관 규칙은 [음성 처리 명세](docs/api/voice.md)에 있습니다.

- JSON을 주고받습니다. 오류는 `{ "error": "사람이 읽는 이유", "type": "invalid" }`처럼 오고, 클라이언트는 `type`으로 가릅니다.
- **자리:** `ROW_1_LEFT`(운전석), `ROW_1_RIGHT`, `ROW_2_LEFT`, `ROW_2_CENTER`, `ROW_2_RIGHT`. Pleos Vehicle SDK의 `SeatArea` 이름과 같습니다.
- **부탁의 상태:** `held`(보관) → `proposed`(제안) → `accepted`(수락) → `reflected`(내비 반영 확인) → `done`(완료). 끝나기 전에는 언제든 `cancelled`로 갈 수 있습니다. 내비 요청이 실패하면 `held`로 되돌려 부탁을 남깁니다.
- **장면:** 위치(`lat`·`lng`)는 둘 다 있거나 둘 다 없습니다. 위치 없는 장면은 목록에만 있고 지도에는 나오지 않습니다.

## APK 파일 위치

[`apk/PITCREW_가치타_release.apk`](apk/PITCREW_가치타_release.apk) — 차량 앱 release 빌드(패키지 `io.github.teampitcrew.gachita`, 버전 0.1.0, minSdk 29, targetSdk 34). 같은 커밋의 `frontend/car`에서 `./gradlew assembleRelease`로 만들었습니다.
