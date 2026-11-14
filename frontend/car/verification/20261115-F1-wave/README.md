# 차 목소리 등록 막대를 실제 소리로(T142 C06·C07, T133 아이 C12·C42) 확인 — 11/15

왼쪽은 피그마 실제 화면 PNG(`references/figma-final-20261114/png`), 오른쪽은 이 브랜치의 디버그 APK를 내가 띄운 읽기 전용 에뮬레이터(Pleos_Connect_2_1, emulator-5588, `-audio none -grpc`)에 깔아 로컬 API(자기 Postgres)에 붙여 찍은 앱 창입니다. 확인 뒤 에뮬레이터를 닫았습니다.

- **소리:** 우리 녹음이 열린 것(`dumpsys audio`의 `silenced:false`)을 본 뒤에만 gRPC `injectAudio`로 macOS `say -v Yuna` 한국어 합성 음성(16 kHz 2채널, 13.7초)을 가상 마이크에 넣었습니다.
- **C07-live-10s.png:** 넣기 전 1초쯤은 낮은 점, 그 뒤 칸은 조각마다 잰 실제 크기, 앞으로 칸은 시안처럼 옅은 막대.
- **C07-end-15s.png:** 15초에 저절로 멈춤. '녹음 완료' → `POST /api/profiles/me/voice` 200.
- **C08-to-family.png:** C08 '가족 그룹 만들기' → 가족 흐름(C09)이 차 로그인 토큰으로 열려 서버의 이름 '민준'을 보임.
- **C12-child-15s.png:** 아이 목소리. 화면에 들어서자 녹음이 시작돼 앞 10초는 무음(낮은 12dp), 소리를 넣은 뒤 칸만 높이가 달라짐 — 막대가 실제 들어온 소리를 따름. 15초 뒤 값만 `POST /api/groups/{id}/members/{profileId}/voice` 200 → '프로필 준비 완료'.
- `cmd uimode night yes`를 줬지만 이 AVD의 사용자 10 앱은 밝은 테마로 그려졌습니다. 차를 늘 어둡게 두는 #428 뒤에는 어두운 토큰으로 그려집니다(이 PR은 `MaterialTheme.colorScheme` 색만 씀).
- 합성 음성은 두 채널이 같아 좌+우 모노가 커져 높이가 위쪽에 몰립니다. 실제 차 마이크·사람 목소리·실차는 확인하지 않았습니다.
