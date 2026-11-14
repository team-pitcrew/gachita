# T142 폰 계정·온보딩(P01–P08) 확인 — 11/15

왼쪽은 피그마 v2(`GISs0yf3c1KCjXwuFmF4ij`, 페이지 `2004:57`) 프레임, 오른쪽은 이 브랜치의 웹앱을 로컬 API(자기 Postgres 컨테이너, `PORT=8842`)에 붙여 데스크톱 Chromium(ego lite)에서 390×844·밝은 화면으로 연 것입니다.

| 파일 | 프레임 | 확인한 동작 |
|---|---|---|
| P01.png | 2005:4799 welcome | 프로필 토큰 없는 첫 화면이 P01 |
| P02.png | 2005:4827 signup | `POST /api/accounts`로 새 계정(201). '이미 계정이 있나요?' → 같은 칸으로 `POST /api/sessions` 로그인(새 기기 토큰) 뒤 처음 화면 |
| P03.png | 2005:4856 consent | `PATCH /api/profiles/me {consent:true}` → `consent:true, consentVersion:"2026-11-14"` |
| P04.png | 2005:4888 profile | 이름 '민준'·안경 캐릭터 저장(`PATCH /api/profiles/me`) |
| P05.png | 2005:4919 photo | 사진을 골라 `PUT /api/profiles/me/photo`(`hasPhoto:true`) |
| P06.png | 2005:4944 voice | 읽을 문장 '안녕, 나는 민준이야.' |
| P07.png | 2005:5008 recording | 녹음 중 10 / 15초, 15초에 저절로 멈춤 |
| P08.png | 2005:5073 voiceDone | `POST /api/profiles/me/voice`(JSON 값 112차원) → `hasVoice:true` |

- **마이크:** 이 데스크톱 브라우저에는 마이크가 없어, 확인할 때만 페이지의 `navigator.mediaDevices.getUserMedia`를 macOS `say -v Yuna`로 만든 48 kHz 한국어 합성 음성 WAV(13.7초)를 재생하는 스트림으로 바꿨습니다(앱 코드에 시험용 훅은 없음). 그 뒤는 앱 그대로: 기기 표본율 → 16 kHz → `voice-embed.js` `embed()` → 값만 올림. 서버가 값의 모양(세 묶음 정규화, 말소리 있음)을 받아들였습니다. 실제 폰 마이크와 사람 목소리로는 확인하지 않았습니다.
- 임베더 이식은 `voice-embed.test.mjs`가 `backend/api/voice-vectors.json` 여섯 입력과 성분마다 1e-6 안인지 봅니다.
- 시안과 다른 곳: 머리 줄의 '9:41'(기기 상태 표시줄 그림)은 넣지 않고 기존 앱 머리(가치타 · 연결됨)를 씀. P02 아래 '이메일 없이 프로필 만들기 · 구글로 계속'(기존 기기 프로필·구글 연결로 가는 길), P03 아래 '동의 문구 전체 보기'(여행 기록 동의와 같은 문장, ADR-0023 8절 전환기 문장을 빼지 않음), P06 안내에 '소리는 이 폰에서 값으로 바뀌고, 값만 서버에 저장돼요.'를 더함. P06 시간 표시는 시안의 '01:08:24' 대신 '00:15'. P08 카드는 '민준 / 아빠' 대신 이름만(가족 안 역할은 F2 그룹에 있음). P08 '가족 그룹 만들기'는 F2(T133) 병합 전이라 처음 화면으로 감(`// mock:`).
- 에뮬레이터·실차와 무관한 웹 확인입니다.
