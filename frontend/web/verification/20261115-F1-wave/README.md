# 목소리 등록 파형을 실제 소리로(T142·T133) 확인 — 11/15

Claude 데스크톱 앱의 내장 브라우저(Chromium, 390×844, 밝은 화면)에서 로컬 API(자기 Postgres)에 붙여 봤습니다.

- **소리 넣기:** 데스크톱에는 마이크가 없어, 확인할 때만 페이지의 `getUserMedia`를 macOS `say -v Yuna` 한국어 합성 음성 WAV(48 kHz, 13.7초)를 재생하는 `MediaStream`으로 바꿨습니다(앱 코드에는 시험 훅 없음, Chromium `--use-fake-device-for-media-stream`과 같은 효과). 그 스트림이 앱의 `MediaStreamAudioSourceNode → AnalyserNode` 경로로 들어갑니다.
- **P07-live-9s.jpg:** 녹음 9초. 지난 칸 높이가 말소리 크기대로 21~33px로 서로 다르고(1·3·4·6초에 읽은 값이 그대로 남음 — 지난 칸은 멈춤), 앞으로 칸은 시안처럼 옅은 막대.
- **P07-end-15s.jpg:** 15초에 저절로 멈춤. 음성이 13.7초에 끝나 마지막 세 칸(13.5~15초)이 최저 6px로 내려감 — 막대가 실제 들어온 소리를 따른다는 확인.
- 이어서 '녹음 완료' → `POST /api/profiles/me/voice`(값만) → `hasVoice: true`.
- **아이 목소리(P12·P42, `groups.js`, 같은 `voice-meter.js`):**
  - P12-child-live-6s.jpg: 녹음 6초, 지난 칸 30~46px(말소리대로), 앞으로 칸은 시안처럼 낮은 10px 점.
  - P12-child-saved.jpg: 15초에 멈추고 값만 `POST /api/groups/{id}/members/{profileId}/voice` → '프로필 준비 완료', `GET /api/groups`에서 아이 `hasVoice: true`. 음성이 끝난 마지막 칸이 16→10px로 내려감.
  - P12-child-silence-400.jpg: 디지털 무음 스트림으로 녹음 → 막대 모두 10px, 서버 400 → '말소리가 없어 등록할 수 없음'과 '다시 녹음'(이 한 장은 내장 브라우저가 390 폭 흉내를 풀어 800×600으로 찍힘).
  - 아이 화면은 #413 병합 직전 머리(88fffc2, 같은 groups.js 목소리 부분)에서 찍었습니다.
- 실제 폰 마이크·사람 목소리·iOS Safari는 확인하지 않았습니다.
