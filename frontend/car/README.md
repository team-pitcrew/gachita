# 같이타 차량 앱

Pleos Connect용 Kotlin·Compose 앱입니다(`io.github.teampitcrew.gachita`). 차량에서 가족을 골라 여행을 만들고 '기록 중' 화면과 기록 동의를 보여 줍니다(T7). 수음과 전사는 T36에서 이 위에 얹습니다.

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

## 파일

| 파일 | 하는 일 |
|---|---|
| `Car.kt` | Pleos SDK: 기어 읽기·알림, 순정 내비 경로·경유지 알림, TTS, 공조 적용·확인·복원(T8에서 부름). 차박지도 앱에서 옮김 |
| `Trip.kt` | 여행 응답 해석과 기록 동의 규칙(단위 테스트 `TripTest.kt`) |
| `Server.kt` | 같이타 API 호출(`docs/api/openapi.yaml`) |
| `MainActivity.kt` | 여행 만들기 화면과 '기록 중' 화면. 창 너비 1200dp 이상이면 두 칸 |
