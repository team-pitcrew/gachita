# T112 내비 옆 반쪽 창 확인

2026년 11월 14일 Pleos AVD `Pleos_Completion_1114`를 `-read-only`로 띄운 `emulator-5566`(2560 × 1440, 밀도 160)에서 확인했습니다. 다른 세션의 에뮬레이터와 공용 데이터는 쓰지 않았고, 여행 화면은 이 확인용 로컬 API·DB에 만들었습니다. 실차는 시험하지 않았습니다. 창 경계는 `adb shell dumpsys activity activities`의 작업 `mBounds`입니다.

| 화면 | 상태 | 창 경계 |
|---|---|---|
| [01](01-os-default-wide.png) | 내비가 앞에 있을 때 가치타를 연 기본 상태. 내비가 가려짐 | 가치타 `[853,90]–[2535,1300]` |
| [02](02-wide-dialog.png) | 넓은 창에서 '반쪽 창'을 누름 | 같음 |
| [03](03-navi-left-gachita-right.png) | 창 바로 나눔(오른쪽 끝 ⋮를 왼쪽으로 끌기 → 가운데 ⋮ 누르기) | 내비 `[853,90]–[1694,1300]`, 가치타 `[1718,90]–[2559,1300]` |
| [04](04-half-dialog.png) | 반쪽 창에서 '전체화면'을 누름. 이 캡처 뒤 안내에 '가치타가 왼쪽이면 먼저 가운데 ⋮를 누르기'를 더했고 다시 찍지 않음 | 같음 |
| [05](05-trip-half-navi-left.png) | 함께 타는 중, 반쪽 창(머리 줄에 '전체화면') | 같음 |
| [06](06-trip-os-widened.png) | 가운데 ⋮를 왼쪽 끝까지 끌어 넓힘(머리 줄에 '반쪽 창') | 가치타 `[853,90]–[2535,1300]` |
| [07](07-tried-portrait-letterbox.png) | 시도: 매니페스트 `screenOrientation="portrait"`. 넓은 영역 가운데 레터박스, 내비는 가려진 채 | 작업 `[853..1694]`로 보고되지만 화면은 가운데 |
| [08](08-tried-landscape-letterbox.png) | 시도: 1:1에서 `setRequestedOrientation(LANDSCAPE)`. 반쪽 창 안 레터박스. 이 시도 앞에 가치타를 다시 열어 왼쪽으로 옮겨 갔음 | 가치타 `[853,90]–[1694,1300]` |

`ActivityOptions.setLaunchBounds`와 `FLAG_ACTIVITY_LAUNCH_ADJACENT`도 시도했으나 창 경계가 바뀌지 않아 캡처하지 않았습니다. 07·08은 시험용 빌드이고 이 PR에 들어가지 않습니다.

- `assembleDebug testDebugUnitTest`: 121개 통과. `make check`: 웹 검사와 API 79개 통과.
- 디버그 APK SHA-256: `2b72cef34c4b6830601d7ef00c3ceb34571ab2e580ecb51c8876b39a36086f85`.
- 보지 못한 것: 주행 중(기어 D) 단추가 사라지는지, 실제 지도 타일(이 AVD의 내비는 검색 상자만 보임), 실차.
