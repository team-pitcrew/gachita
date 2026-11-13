# 같이타 차량 앱

Pleos Connect용 Kotlin·Compose 앱입니다(`io.github.teampitcrew.gachita`). 차량에서 가족을 골라 여행을 만들고 '기록 중' 화면과 기록 동의를 보여 줍니다(T7). 기록 중이면 차량 마이크로 수음해 Pleos STT(ON_DEVICE)로 받아 적고, 발화를 순번과 함께 앱 안 보관함에 쌓습니다(T36). 주행 중에도 앞에 남는 화면이고, 주행 제한 중에는 설정과 진단을 가립니다(T11).

## 빌드와 실행

JDK 21과 Android SDK 34가 필요합니다. `local.properties`(sdk.dir)와 서명 키는 저장소에 넣지 않습니다.

```sh
cd frontend/car
./gradlew assembleDebug testDebugUnitTest
adb install --user 10 -r -g app/build/outputs/apk/debug/app-debug.apk
adb shell am start --user 10 -n io.github.teampitcrew.gachita/.MainActivity --es server http://10.0.2.2:8787
```

- 서버는 저장소 루트에서 `make run`(http://localhost:8787). 에뮬레이터에서 Mac은 `10.0.2.2`입니다.
- 서버 주소는 첫 화면의 '서버 주소'나 `--es server <주소>`로 바꾸고, 앱이 기억합니다.
- 기어 값은 Cold boot한 에뮬레이터에서만 읽힙니다(`docs/emulator/README.md`).
- 마이크 권한(`RECORD_AUDIO`)과 알림 권한(`POST_NOTIFICATIONS`, 화면 뒤에서 '기록 멈춤'을 알림으로 보임)은 처음 기록할 때 함께 묻습니다. `-g`로 설치하면 미리 허용됩니다.

## 주행 중 화면(T11)

- **선언:** `MainActivity`에 `distractionOptimized`. 선언하지 않으면 기어 D에서 Pleos 차단 화면이 앱을 덮습니다.
- **판단:** 기어나 속도로 직접 정하지 않고 플랫폼의 주행 제한 값(AAOS `CarUxRestrictionsManager`, `isRequiresDistractionOptimization`)을 따릅니다(Pleos 주행 규제 개발 가이드). 값을 받기 전이거나 받지 못하면 제한된 화면입니다. 에뮬레이터에서 기어 D는 제한 80(설정 64 + 동영상 16), P는 0이었습니다.
- **주행 중 보이는 것:** 기록 상태, 받아 적은 말 두 줄, 일행, 보관한 부탁 수, 기록 동의 스위치(끄기는 한 번 누름. 켜기는 지금처럼 기어 P에서만), 연결 상태. 글자는 24sp 이상입니다.
- **주행 중 가리는 것:** 여행 만들기(가족 고르기와 서버 주소 입력: 설정·키보드), 새 여행 만들기, 설명과 진단 줄(20sp). 영상·긴 기록·시트 설정은 아직 앱에 없습니다. 생기면 같은 값으로 가립니다.
- 에뮬레이터에서 제한이 걸리지 않거나 차단 화면이 뜨지 않았다고 심사 기준을 통과한다는 뜻은 아닙니다.

## 수음과 받아쓰기(T36)

- **언제:** 기록 상태가 '기록 중'(모두 동의, 주차 중 시작)이고 우리 화면이 앞일 때 마이크 포그라운드 서비스(`CaptureService`)를 시작합니다. 화면 뒤에서는 서비스를 시작할 수 없어(T10) 앱을 열 때 시작합니다. 동의가 빠지면 그 자리에서 `AudioRecord`를 멈추고 마이크를 놓습니다. 수음 중에는 화면이 뒤에 있어도 10초마다 서버의 동의를 확인합니다.
- **어떻게:** `AudioRecord`(MIC, 16 kHz 2채널)를 0.1초씩 읽어 좌+우 모노로 `SpeechToText.sendAudio()`에 넣습니다. STT가 마이크를 여는 `request()`는 쓰지 않습니다. 원음은 저장하지 않습니다.
- **발화:** 첫 중간 결과 − 1초에서 최종 결과까지를 한 건으로 묶어 `files/utterances-<여행 코드>.jsonl`에 순번(여행·기기마다 1부터)과 함께 한 줄씩 씁니다. 필드는 순번, 여행, 시작·끝 시각, 글자, 원음 구간(수음 시작부터의 ms), 기어, 좌석 구역(자리만, T37). 화면에는 방금 받아 적은 말 두 줄만 보입니다(자동 스크롤 없음).
- **막힘:** `isClientSilenced`, 값이 모두 0인 조각 1초, `read()`가 2초 넘게 돌아오지 않음 중 하나면 '기록 멈춤'.
- **서버:** 발화를 받는 API(T39)가 아직 없어 보내지 않고 쌓기만 합니다(`Uplink` 자리에 `KEEP`). 모양은 ADR-0014 초안을 따릅니다: `POST /api/trips/{code}/utterances {device_id, items}` → `{acked_seq}`, 받은 순번 뒤의 것만 100건씩 다시 보냄.

## 로컬 E2E

차량 앱에서 여행을 만들어 서버에 생기는 것까지 한 번에 확인합니다. 에뮬레이터를 다른 사람이 쓰는 중이면 먼저 물어봅니다.

1. 저장소 루트에서 `make run`(서버와 Postgres).
2. Pleos 에뮬레이터를 Cold boot하고 `adb forward tcp:8088 tcp:8088`(Virtual Console로 기어를 바꿈).
3. `frontend/car`에서 `./gradlew assembleDebug`.
4. `python3 frontend/car/e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더>`

수음과 받아쓰기는 `python3 frontend/car/capture_e2e.py <APK> <저장소 밖 폴더> [분]`입니다. 에뮬레이터를 `-grpc 8556 -grpc-use-token -audio none`으로 켜 두면 macOS 합성 음성으로 만든 가족 대화를 gRPC `injectAudio`로 가상 마이크에 넣고(호스트 마이크는 쓰지 않음), 내비를 앞에 둔 기어 D에서 보관함에 쌓인 발화를 넣은 문장과 맞춰 봅니다. 30초마다 CPU·메모리를 재고, 내비가 앞일 때 시스템 마이크 차단(`cmd sensor_privacy`) → '기록 멈춤', 동의 끄기 → 마이크 놓음, 앱 다시 켜기 → 순번 이어짐까지 확인합니다. 공용 DB를 다른 시험이 비울 수 있으면 따로 띄운 서버를 `GACHITA_PORT`로 줍니다. 넣은 문장과 받아 적은 문장은 `transcript.tsv`에 나란히 남습니다.

`e2e.py`의 스크립트는 설치 → 기어 D에서 여행 만들기가 가려지고 앞 화면이 우리 앱(차단 화면 아님) → 여행 만들기(가족 4명) → 기어 D에서 동의 켜기(안 켜짐) → 기어 P에서 켜기(기록 중) → 기어 D에서 유지 → 끄기(바로 멈춤) → 반쪽 폭(841) 순서로 화면을 캡처하고, 단계마다 서버의 여행(`GET /api/trips/{코드}`)을 함께 적어 `results.json`에 판정을 남깁니다. 실패가 있으면 종료 코드 1입니다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `Car.kt` | Pleos SDK: 기어 읽기·알림, 순정 내비 경로·경유지 알림, TTS, 공조 적용·확인·복원(T8에서 부름). 차박지도 앱에서 옮김. AAOS 주행 제한 값(T11) |
| `Trip.kt` | 여행 응답 해석과 기록 동의 규칙(단위 테스트 `TripTest.kt`) |
| `Server.kt` | 같이타 API 호출(`docs/api/openapi.yaml`) |
| `Capture.kt` | 수음에서 화면·SDK와 무관한 것: 모노 합치기, 발화 묶기, 막힘 판정, 보관함과 보내는 쪽 이음매(단위 테스트 `CaptureTest.kt`) |
| `CaptureService.kt` | 마이크 포그라운드 서비스: `AudioRecord` → Pleos STT `sendAudio()` → 보관함. 화면이 읽는 수음 상태(`Live`) |
| `MainActivity.kt` | 여행 만들기 화면과 '기록 중' 화면. 기록 상태에 맞춰 수음을 켜고 끔. 창 너비 1200dp 이상이면 두 칸. `--ei widthDp 841`이면 그 폭으로 그림(에뮬레이터는 창을 나누지 않음) |
| `e2e.py` | 위의 로컬 E2E(여행과 기록 동의) |
| `capture_e2e.py` | 수음과 받아쓰기 E2E(T36). `e2e.py`의 도구를 같이 씀 |
