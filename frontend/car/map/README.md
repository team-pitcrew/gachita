# 가치타 지도

이 APK는 공개 도로 지도와 Pleos가 제공하는 차량 위치를 표시합니다. 내비의 빈 지도에 대한 별도 표시 경로입니다. 순정 내비의 인증 오류를 고치거나 경로 안내를 제공하지 않습니다. 화면에도 `경로 안내 미연결`을 표시합니다.

## 설치와 분할 화면

Java 21과 Android SDK 34가 필요합니다. `frontend/car`에서 실행합니다.

```sh
./gradlew :map:assembleDebug
adb -s emulator-5558 install -r map/build/outputs/apk/debug/map-debug.apk
adb -s emulator-5558 shell am start --user 10 -n io.github.teampitcrew.gachitamap/.MapActivity
```

위 명령의 기기와 사용자 번호는 실제 대상에 맞춰 확인합니다. Pleos의 분할 화면으로 지도를 왼쪽, 가치타를 오른쪽에 둡니다. Gleo가 앱을 호출하면 Pleos 런처가 창을 왼쪽으로 옮길 수 있습니다. 이 경우 분할선의 교환 버튼으로 다시 배치합니다.

## 데이터와 실패 상태

- MapLibre Native 13.7.1과 OpenFreeMap `liberty` 스타일을 사용합니다. 인터넷 연결이 필요합니다. 지도 저작자 표시는 MapLibre 기본 컨트롤로 제공합니다.
- NaviHelper 3.0.5의 `getCurrentLocationInfo` 응답을 사용합니다. 위치를 받기 전에는 한국 전체를 표시합니다. 임의의 현재 위치나 경로선을 만들지 않습니다.
- 위치 응답이 10초 동안 없으면 현재 위치 마커를 지웁니다. 지도 이동 중에는 추적을 멈추고 `현재 위치` 버튼으로 다시 켭니다.
- 위치와 지도 타일은 별도 연결입니다. 타일 서버 장애가 발생하면 차량 위치 수신만으로 지도 표시 성공을 보장하지 않습니다.
- 목적지 검색, 경로 계산, TBT, 재탐색은 구현하지 않았습니다. `APP_MAPS` 분류는 분할 화면용 지도 앱 등록에 사용합니다. 활성 경로를 등록하거나 순정 내비 경로를 덮어쓰지 않습니다.

## 2026-11-14 검증 범위

Pleos emulator 2.1.0 / Android 14 / Android Emulator 37.2.13에서 실제 도로·건물·지명과 차량 위치 마커를 확인했습니다. 실차는 검증하지 않았습니다. 순정 Navi42 3.3.2-rc5-hotfix.3에서는 같은 날 `connect_empty` 스타일과 엔진 HTTP 401이 남았습니다. 이 APK 설치를 순정 인증 복구로 보고하지 않습니다.

공식 자료: [지도 앱 개발](https://document.pleos.ai/docs/pleos-only/vehicle-app-developer-guide/navigation-app-development-guide), [OpenFreeMap](https://openfreemap.org/quick_start/), [MapLibre Android](https://maplibre.org/maplibre-native/android/api/).
