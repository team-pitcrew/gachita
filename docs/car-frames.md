# 차 화면 프레임 지도 (C01–C43 · C16* · C17m · D · D補 · 녹음 화면 A안)

원본 Figma `Y7zFqGUEAFDWTumG30MsOs` '민준 개선안'(페이지 `2004:57`)의 차 프레임 155개를 흐름·시연 단계·단추 행선·코드 위치로 묶은 지도입니다(T156 #471). 색·글자·모양의 기준은 [디자인](design.md) 3·4절이고, 코드에서는 `CarDesign.kt`(글자 `CarText`, 모양 `CarShape`, 장면·표지 색 `CarTints`·`CarPaper`, 공통 조각)와 `Theme.kt`(Material 역할 색, Pretendard)로 씁니다. 원본은 고쳐지는 파일이라 MCP로는 읽기만 하고, 바뀌면 이 표를 다시 뽑습니다. 프레임 그림과 프레임별 전체 글은 저장소 밖(`production/car-port-20261115/`)에 둡니다.

## 흐름 → 코드

| 흐름 | 프레임 | 차 코드(`frontend/car/app/src/main/java/io/github/teampitcrew/gachita/`) |
|---|---|---|
| F1 계정·온보딩 | C01–C08, D01–D07, D補 photo | `Onboarding.kt`(`OnboardingScreen`), `Account.kt`, `VoiceMeter.kt` |
| F2 가족·그룹·초대·좌석 | C09–C16, C16A·B·C·G·I·L, C39–C43, D08–D16*, 초대 시트·알림 | `Family.kt`(`FamilyFlow`) |
| F3 주행 좁은 창·대화 기록 | 녹음 화면 A안, C17·C17p·C17m·C21·C21p, resumed·ended, C44·D33·live/pausedTranscript | `Drive.kt`, `TranscriptScreen.kt`, `Trip.kt`, `MainActivity.kt`(`TripScreen`·`RideOverview`·`Conversations`) |
| F4 도착 전·도착 브리핑 | C19·C19p·C20, D19 수정본, finalNear·finalBrief·finalPaused | `Arrival.kt`, `TodoActions.kt`, 도착 전 카드는 `Drive.kt` `NearCard` |
| F5 여행 마무리 | C22–C32, D21–D26, D補 select* | `AfterTrip.kt`, `Scenes.kt`, `FullAudio.kt` |
| F6 콘텐츠 기록 | C33–C38, D27–D32, C補·D補 player·export, emptyContent | `Contents.kt` |
| 시연 실행 | 시연 플로우 `2045:1782` | `frontend/car/demo.py`(화면 글 확인 `--check`) |


- 읽은 때: 2026-11-15, 원본 파일을 읽기만 했습니다(`use_figma` 읽기 스크립트, `get_screenshot`). Figma에는 아무것도 쓰지 않았습니다.
- 글자는 TEXT 노드의 실제 `characters`이고 레이어 이름이 아닙니다. 버튼 이동은 프로토타입 reaction에서 읽었습니다. `→A/B`는 같은 버튼에 연결된 목적지가 여럿이라는 뜻입니다.
- 이 페이지에는 SECTION 노드가 없습니다. 모든 차량 프레임은 페이지 최상위에 있고, `2107:6979`는 섹션이 아니라 4200×100 제목 프레임입니다(아래 시안 표 참고).
- 11/14 대비: `새` = 11/14 추출본(`references/figma-final-20261114/frames.json`)에 없던 id, `글 바뀜` = 같은 id인데 보이는 글이 다름, `같음` = 글 동일. 글 비교이므로 글이 같아도 배치·색은 바뀌었을 수 있습니다. 어떤 글이 바뀌었는지는 `frames.json`의 `text_diff_vs_20261114`에 있습니다.
- 탭(함께 타는 중 / 대화 기록 / 콘텐츠 기록)은 표에서 뺐습니다. 컴포넌트 열의 `탭0/1/2`는 켜진 탭입니다. C 세트 탭은 C17(주차 중이면 C16 groups)·C44·C33으로, D 세트 탭은 D補 resumed(또는 ended)·D補 liveTranscript(또는 D33)·D補 emptyContent(또는 D27)로 갑니다.
- 버튼은 굵게 = primary, 그다음 secondary, `[레이어 이름]` = 글자 없는 아이콘 버튼, `항목:` = 누를 수 있는 카드·행, `자동 Ns` = 프레임의 시간 경과 이동입니다.

| 흐름 | 프레임 수 |
|---|---|
| F1 계정·온보딩 (C01–C08, D01–D07) | 16 |
| F2 가족·그룹·초대·좌석 (C09–C16, C16*, C39–C43, D08–D16*) | 39 |
| F3 주행·기록(좁은 창)·대화 기록 (C17, C17p, C17m, C21, C21p, C44, D17/D20 계열, resumed/ended/transcript) | 29 |
| F4 도착 브리핑 (C19, C19p, C20, D18/D19, finalNear/Brief/Paused) | 16 |
| F5 주행 후 장면 고르기·생성 (C22–C32, D21–D26, D補 select*) | 22 |
| F6 콘텐츠 기록 (C33–C38, D27–D32, C補/D補 player·export) | 33 |
| 합계 | 155 |

## F1 · 계정·온보딩 (C01–C08, D01–D07)

| 프레임 | node id | 창 | 흐름 | 시연 | 용도 | 버튼 → 이동 | 컴포넌트 | 11/14 대비 |
|---|---|---|---|---|---|---|---|---|
| [C01 / welcome / 함께 탄 순간을 오래](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2413) | `2005:2413` | 넓은 1682 | F1 | — | 시작·서비스 소개, 가입 진입 | **가치타 시작하기**→C02 | Archive / galleryCar / 1, Archive 캐릭터×2 | 글 바뀜 |
| [C02 / signup / 내 계정 만들기](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2452) | `2005:2452` | 넓은 1682 | F1 | — | 계정 만들기(이메일·비밀번호) | **가입하고 계속**→C03 | — | 글 바뀜 |
| [C03 / consent / 우리의 대화를 남기기 전에](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2492) | `2005:2492` | 넓은 1682 | F1 | — | 대화 기록·서버 전송·발화자 식별 일괄 동의 | **동의하고 계속**→C04 | — | 글 바뀜 |
| [C04 / profile / 나를 소개해 주세요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2535) | `2005:2535` | 넓은 1682 | F1 | — | 이름·캐릭터 설정 | **목소리 등록하기**→C06<br>내 사진으로 바꾸기→C05 | — | 글 바뀜 |
| [C05 / photo / 프로필 사진](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2577) | `2005:2577` | 넓은 1682 | F1 | — | 프로필 사진 선택(캐릭터로 대체 가능) | **캐릭터로 계속**→C04 | — | 글 바뀜 |
| [C06 / voice / 15초만 들려주세요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2613) | `2005:2613` | 넓은 1682 | F1 | — | 15초 목소리 등록 준비 | **녹음 시작**→C07 | — | 글 바뀜 |
| [C07 / recording / 목소리를 듣고 있어요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2716) | `2005:2716` | 넓은 1682 | F1 | — | 목소리 녹음 중 | **녹음 완료**→C08<br>다시 녹음→C06<br>자동 5s→C08 | — | 글 바뀜 |
| [C08 / voiceDone / 민준님의 목소리 등록 완료](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2820) | `2005:2820` | 넓은 1682 | F1 | — | 내 목소리 등록 완료 | **가족 그룹 만들기**→C09 | — | 글 바뀜 |
| [D01 / welcome / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1123) | `2007:1123` | 넓은 1682 | F1 | 01 | 시작·서비스 소개, 가입 진입 | **가치타 시작하기**→D02 | Archive / galleryCar / 1, Archive 캐릭터×2 | 글 바뀜 |
| [D02 / signup / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1162) | `2007:1162` | 넓은 1682 | F1 | 02 | 계정 만들기(이메일·비밀번호) | **가입하고 계속**→D03 | — | 글 바뀜 |
| [D03 / consent / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1202) | `2007:1202` | 넓은 1682 | F1 | 03 | 대화 기록·서버 전송·발화자 식별 일괄 동의 | **동의하고 계속**→D04 | — | 글 바뀜 |
| [D04 / profile / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1245) | `2007:1245` | 넓은 1682 | F1 | 04 | 이름·캐릭터 설정 | **목소리 등록하기**→D05<br>내 사진으로 바꾸기→D補 photo | — | 글 바뀜 |
| [D05 / voice / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1287) | `2007:1287` | 넓은 1682 | F1 | 05 | 15초 목소리 등록 준비 | **녹음 시작**→D06 | — | 글 바뀜 |
| [D06 / recording / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1390) | `2007:1390` | 넓은 1682 | F1 | 06 | 목소리 녹음 중 | **녹음 완료**→D07<br>다시 녹음→D05<br>자동 5s→D07 | — | 글 바뀜 |
| [D07 / voiceDone / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1494) | `2007:1494` | 넓은 1682 | F1 | 07 | 내 목소리 등록 완료 | **가족 그룹 만들기**→D08 | — | 글 바뀜 |
| [D補 / photo / 온보딩 보조 흐름](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2040) | `2026:2040` | 넓은 1682 | F1 | — | 프로필 사진 선택(캐릭터로 대체 가능) | **캐릭터로 계속**→D04 | — | 글 바뀜 |

## F2 · 가족·그룹·초대·좌석 (C09–C16, C16*, C39–C43, D08–D16*)

| 프레임 | node id | 창 | 흐름 | 시연 | 용도 | 버튼 → 이동 | 컴포넌트 | 11/14 대비 |
|---|---|---|---|---|---|---|---|---|
| [C09 / member / 우리 가족 추가](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2859) | `2005:2859` | 넓은 1682 | F2 | — | 가족 추가(엄마 초대·아이 프로필) | **엄마 계정 초대하기**→C10<br>엄마의 계정 초대하기→C10<br>아이 프로필 만들기→C11 | Group / 2x2 / one / Car | 글 바뀜 |
| [C10 / invite / 가족 초대 보내기](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2902) | `2005:2902` | 넓은 1682 | F2 | — | 가족 초대 코드·QR·링크 | **초대 링크 공유**→공유시트 FAMILY(오버레이)<br>**엄마 참여 확인**→C39<br>코드 복사→토스트 복사완료(오버레이)<br>링크 복사→토스트 복사완료(오버레이)<br>링크 열기→D補 phoneJoin(폰) | Group / 2x2 / inviting / Badge | 글 바뀜 |
| [C11 / child / 아이 프로필 만들기](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2941) | `2005:2941` | 넓은 1682 | F2 | — | 아이(서준) 프로필 만들기 | **동의하고 목소리 등록**→C12 | Group / 2x2 / two / Car | 글 바뀜 |
| [C12 / childVoice / 서준의 목소리 등록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-2982) | `2005:2982` | 넓은 1682 | F2 | — | 서준 목소리 등록 | **가족 그룹에 저장**→C40 | Group / 2x2 / three / Car | 글 바뀜 |
| [C14 / seat / 가족 좌석 바꾸기](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3138) | `2005:3138` | 넓은 1682 | F2 | — | 가족 좌석 바꾸기(구판 좌석 화면) | **이 배치로 저장**→C43<br>항목: 아빠 운전석→C16 groups; 엄마 조수석→C16 groups; 서준 뒤 오른쪽→C16 groups; 하은 뒤 왼쪽→C16 groups | 탭0 | 글 바뀜 |
| [C15 / guest / 새 동승 그룹](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3188) | `2005:3188` | 넓은 1682 | F2 | — | 새 동승 그룹 만들기 | **그룹 저장**→C16L<br>계정 초대 링크 만들기→C16 guestInvite | 탭0 | 글 바뀜 |
| [C16 / groups / 내 동승 그룹](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3085) | `2005:3085` | 넓은 1682 | F2 | — | 내 동승 그룹 목록 | **우리 가족 보기**→C16A<br>+ 새 그룹 만들기→C15<br>항목: 우리 가족 4명  |  기본 …→C16A | 탭0; Group / 2x2 profile / Car | 글 바뀜 · 이름 변경(옛 `C13 / group / 우리 가족`) |
| [C16 / guestInvite / 동승자를 초대해 주세요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3229) | `2005:3229` | 넓은 1682 | F2 | — | 동승자 초대 코드·QR·링크 | **초대 링크 공유**→공유시트 TRIP(오버레이)<br>**그룹으로 돌아가기**→C16G<br>코드 복사→토스트 복사완료(오버레이)<br>링크 복사→토스트 복사완료(오버레이)<br>링크 열기→D補 phoneGuestJoin(폰) | 탭0 | 글 바뀜 |
| [C16A / groupDetail / 우리 가족](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2094-4566) | `2094:4566` | 넓은 1682 | F2 | — | 그룹 상세(좌석 표시·좌석 배정·초대·출발) | **이 그룹과 출발**→C17<br>좌석 배정→C16B<br>구성원 초대→C16I<br>전체 그룹→C16 groups | 탭0; Group / 2x2 profile / Car | 새 |
| [C16B / seatAssignment / 좌석 배정](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2094-4626) | `2094:4626` | 넓은 1682 | F2 | — | 좌석 배정(좌석을 눌러 선택) | **이 배치로 저장**→C16A<br>그룹으로→C16A<br>항목: 운전석 아빠→C16C; 조수석 엄마→C16C; 뒤 왼쪽 서준→C16C; 뒤 오른쪽 하은→C16C | 탭0 | 새 |
| [C16C / memberPicker / 좌석 구성원 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2094-4686) | `2094:4686` | 넓은 1682 | F2 | — | 좌석에 앉을 사람 선택 | 좌석 배정으로→C16B<br>항목: 아빠→C16B; 엄마→C16B; 서준→C16B; 하은→C16B | 탭0 | 새 |
| [C16G / guestDetail / 주말 바다 친구들](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2094-4746) | `2094:4746` | 넓은 1682 | F2 | — | 새 동승 그룹 상세(초대 대기) | **동승자 초대하기**→C16 guestInvite<br>전체 그룹 보기→C16 groups | 탭0 | 새 |
| [C16I / groupInvite / 구성원 초대](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2095-4786) | `2095:4786` | 넓은 1682 | F2 | — | 그룹 구성원 초대 코드·링크 | **초대 링크 공유**→공유시트 FAMILY(오버레이)<br>**그룹으로 돌아가기**→C16A<br>코드 복사→토스트 복사완료(오버레이)<br>링크 복사→토스트 복사완료(오버레이)<br>링크 열기→D補 phoneJoin(폰) | — | 새 |
| [C16L / groupsCreated / 전체 그룹 목록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2097-4631) | `2097:4631` | 넓은 1682 | F2 | — | 전체 그룹 목록(새 그룹 포함) | **우리 가족 보기**→C16A<br>+ 새 그룹 만들기→C15<br>항목: 우리 가족 4명  |  기본 …→C16A; 주말 바다 친구들 1명  | …→C16G | 탭0; Group / 2x2 profile / Car | 새 |
| [C39 / 엄마 연결 후 / 가족 추가](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-612) | `2007:612` | 넓은 1682 | F2 | — | 엄마 연결 후 가족 추가 | **서준 프로필 만들기**→C11<br>엄마의 계정 초대하기→C10<br>아이 프로필 만들기→C11 | — | 글 바뀜 |
| [C40 / 서준 등록 후 / 하은 추가](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-657) | `2007:657` | 넓은 1682 | F2 | — | 서준 등록 후 하은 추가 | **하은 프로필 만들기**→C41<br>엄마의 계정 초대하기→C10<br>아이 프로필 만들기→C11 | — | 글 바뀜 |
| [C41 / 하은 프로필](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-700) | `2007:700` | 넓은 1682 | F2 | — | 하은 프로필 만들기 | **동의하고 목소리 등록**→C42 | — | 글 바뀜 |
| [C42 / 하은 목소리 등록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-741) | `2007:741` | 넓은 1682 | F2 | — | 하은 목소리 등록 | **가족 그룹에 저장**→C16 groups | — | 글 바뀜 |
| [C43 / 저장된 새 좌석](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-849) | `2007:849` | 넓은 1682 | F2 | — | 저장된 새 좌석 확인 후 출발 | **이 가족과 출발**→C17<br>새 동승 그룹→C15<br>항목: 아빠 운전석→C14; 엄마 조수석→C14; 서준 뒤 오른쪽→C14; 하은 뒤 왼쪽→C14 | 탭0 | 글 바뀜 |
| [D08 / member / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1533) | `2007:1533` | 넓은 1682 | F2 | 08 | 가족 추가(엄마 초대·아이 프로필) | **엄마 계정 초대하기**→D09<br>엄마의 계정 초대하기→D09<br>아이 프로필 만들기→D11 | Group / 2x2 / one / Car | 글 바뀜 |
| [D09 / invite / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1576) | `2007:1576` | 넓은 1682 | F2 | 09, QR1 | 가족 초대 코드·QR·링크 | **초대 링크 공유**→공유시트 FAMILY(오버레이)<br>**엄마 참여 확인**→D10<br>코드 복사→토스트 복사완료(오버레이)<br>링크 복사→토스트 복사완료(오버레이)<br>링크 열기→D補 phoneJoin(폰) | Group / 2x2 / inviting / Badge | 글 바뀜 |
| [D10 / memberMom / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1615) | `2007:1615` | 넓은 1682 | F2 | 10, QR4 | 엄마 연결 후 가족 추가 | **서준 프로필 만들기**→D11<br>아이 프로필 만들기→D11 | Group / 2x2 / two / Car | 글 바뀜 |
| [D11 / child / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1658) | `2007:1658` | 넓은 1682 | F2 | 11 | 아이(서준) 프로필 만들기 | **동의하고 목소리 등록**→D12 | Group / 2x2 / two / Car | 글 바뀜 |
| [D12 / childVoice / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1699) | `2007:1699` | 넓은 1682 | F2 | 12 | 서준 목소리 등록 | **가족 그룹에 저장**→D13 | Group / 2x2 / three / Car | 글 바뀜 |
| [D13 / memberSon / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1802) | `2007:1802` | 넓은 1682 | F2 | 13 | 서준 등록 후 하은 추가 | **하은 프로필 만들기**→D14 | Group / 2x2 / three / Car | 글 바뀜 |
| [D14 / childDaughter / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1845) | `2007:1845` | 넓은 1682 | F2 | 14 | 하은 프로필 만들기 | **동의하고 목소리 등록**→D15 | — | 글 바뀜 |
| [D15 / daughterVoice / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1886) | `2007:1886` | 넓은 1682 | F2 | 15 | 하은 목소리 등록·4명 완료 | **저장하고 그룹 보기**→D16 | Group / 2x2 profile / Car | 글 바뀜 |
| [D16 / groups / 내 동승 그룹](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-1989) | `2007:1989` | 넓은 1682 | F2 | 16 | 내 동승 그룹 목록 | **우리 가족 보기**→D16A<br>+ 새 그룹 만들기→D補 guest<br>항목: 우리 가족 4명  |  기본 …→D16A | 탭0; Group / 2x2 profile / Car | 글 바뀜 · 이름 변경(옛 `D16 / group / 아빠의 가족 여행`) |
| [D16A / groupDetail / 우리 가족](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2133) | `2026:2133` | 넓은 1682 | F2 | 16A, 16D | 그룹 상세(좌석 표시·좌석 배정·초대·출발) | **이 그룹과 출발**→D17<br>좌석 배정→D16B<br>구성원 초대→D16I<br>전체 그룹→D16 | 탭0; Group / 2x2 profile / Car | 글 바뀜 · 이름 변경(옛 `D補 / swapped / 온보딩 보조 흐름`) |
| [D16B / seatAssignment / 좌석 배정](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2076) | `2026:2076` | 넓은 1682 | F2 | 16B | 좌석 배정(좌석을 눌러 선택) | **이 배치로 저장**→D16A<br>그룹으로→D16A<br>항목: 운전석 아빠→D16C; 조수석 엄마→D16C; 뒤 왼쪽 서준→D16C; 뒤 오른쪽 하은→D16C | 탭0 | 글 바뀜 · 이름 변경(옛 `D補 / seat / 온보딩 보조 흐름`) |
| [D16C / memberPicker / 좌석 구성원 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2094-4307) | `2094:4307` | 넓은 1682 | F2 | 16C | 좌석에 앉을 사람 선택 | 좌석 배정으로→D16B<br>항목: 아빠→D16B; 엄마→D16B; 서준→D16B; 하은→D16B | 탭0 | 새 |
| [D16G / guestDetail / 주말 바다 친구들](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2094-4367) | `2094:4367` | 넓은 1682 | F2 | G4 | 새 동승 그룹 상세(초대 대기) | **동승자 초대하기**→D補 guestInvite<br>전체 그룹 보기→D16 | 탭0 | 새 |
| [D16I / groupInvite / 구성원 초대](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2095-4735) | `2095:4735` | 넓은 1682 | F2 | — | 그룹 구성원 초대 코드·링크 | **초대 링크 공유**→공유시트 FAMILY(오버레이)<br>**그룹으로 돌아가기**→D16A<br>코드 복사→토스트 복사완료(오버레이)<br>링크 복사→토스트 복사완료(오버레이)<br>링크 열기→D補 phoneJoin(폰) | — | 새 |
| [D16L / groupsCreated / 전체 그룹 목록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2097-4582) | `2097:4582` | 넓은 1682 | F2 | G3 | 전체 그룹 목록(새 그룹 포함) | **우리 가족 보기**→D16A<br>+ 새 그룹 만들기→D補 guest<br>항목: 우리 가족 4명  |  기본 …→D16A; 주말 바다 친구들 1명  | …→D16G | 탭0; Group / 2x2 profile / Car | 새 |
| [D補 / guest / 온보딩 보조 흐름](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2193) | `2026:2193` | 넓은 1682 | F2 | G1 | 새 동승 그룹 만들기 | **그룹 저장**→D16L<br>계정 초대 링크 만들기→D補 guestInvite | 탭0 | 글 바뀜 |
| [D補 / guestInvite / 온보딩 보조 흐름](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2241) | `2026:2241` | 넓은 1682 | F2 | G2 | 동승자 초대 코드·QR·링크 | **초대 링크 공유**→공유시트 TRIP(오버레이)<br>**그룹으로 돌아가기**→D16G<br>코드 복사→토스트 복사완료(오버레이)<br>링크 복사→토스트 복사완료(오버레이)<br>링크 열기→D補 phoneGuestJoin(폰) | 탭0 | 글 바뀜 |
| [C / 초대 링크 공유 / FAMILY-2714](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2047-2279) | `2047:2279` | 시트 800 | F2 | — | 초대 링크 공유 시트(우리 가족) | 카카오톡→닫기<br>메시지→닫기<br>링크 복사→토스트 복사완료(교체)<br>닫기→닫기 | — | 같음 |
| [C / 초대 링크 공유 / TRIP-5812](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2047-2296) | `2047:2296` | 시트 800 | F2 | — | 초대 링크 공유 시트(주말 바다 친구들) | 카카오톡→닫기<br>메시지→닫기<br>링크 복사→토스트 복사완료(교체)<br>닫기→닫기 | — | 같음 |
| [C / 초대 복사 완료](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2047-2276) | `2047:2276` | 시트 800 | F2 | — | "복사했어요" 토스트(1.5초 후 닫힘) | 자동 1.5s→닫기 | — | 같음 |

## F3 · 주행·기록(좁은 창)·대화 기록 (C17, C17p, C17m, C21, C21p, C44, D17/D20 계열, resumed/ended/transcript)

| 프레임 | node id | 창 | 흐름 | 시연 | 용도 | 버튼 → 이동 | 컴포넌트 | 11/14 대비 |
|---|---|---|---|---|---|---|---|---|
| [C17 / drive / C1n 기준 좁은 창 기록 중 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3267) | `2005:3267` | 좁은 841 | F3 | — | 주행 중 기록(좁은 창) | [프로필 메뉴 열기]→프로필메뉴(차량)(오버레이)<br>[일시정지]→C17p<br>[녹화 종료]→C22<br>[1초 타이머]→상태전환<br>자동 7s→C19 | 탭0; 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [C17 · 타이머 프로토타입](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2137-5839) | `2137:5839` | 조각 180 | F3 | — | 1초 녹화 타이머 컴포넌트 프로토(Tick A↔B) | [1초 타이머]→상태전환 | — | 새 |
| [C17m / drive / 프로필 드롭다운 열림 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2206-5852) | `2206:5852` | 좁은 841 | F3 | — | 프로필 드롭다운이 펼쳐진 주행 창(정적 시안) | [프로필 메뉴 열기]→C17p<br>[녹화 재개]→C17<br>[녹화 종료]→C22<br>[닫기]→C17p<br>항목: 동승 그룹 변경→C16 groups; 좌석 배정→C16B; 갤러리 바로가기→C33; 로그아웃→로그아웃확인(차량)(오버레이) | 탭0 | 새 |
| [C17p / drive / 기록 멈춤 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3307) | `2005:3307` | 좁은 841 | F3 | — | 주행 중 기록(좁은 창) — 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(차량)(오버레이)<br>[녹화 재개]→C17<br>[녹화 종료]→C22 | 탭0 | 글 바뀜 |
| [C21 / continue / C1n 기준 좁은 창 기록 중 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3404) | `2005:3404` | 좁은 841 | F3 | — | 경유 후 주행 계속 기록 | [프로필 메뉴 열기]→프로필메뉴(차량)(오버레이)<br>[일시정지]→C21p<br>[녹화 종료]→C22<br>[1초 타이머]→상태전환<br>자동 6s→C22 | 탭0; 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [C21p / continue / 기록 멈춤 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2014-1185) | `2014:1185` | 좁은 841 | F3 | — | 경유 후 주행 계속 기록 — 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(차량)(오버레이)<br>[녹화 재개]→C21<br>[녹화 종료]→C22 | 탭0 | 글 바뀜 |
| [C44 / transcript / 대화 기록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2019-1966) | `2019:1966` | 좁은 841 | F3 | — | 대화 기록(발화자별) | **추천 장면 고르기**→C23 | 탭1; Conversation Car×4 | 글 바뀜 |
| [D17 / drive / C1n 기준 좁은 창 기록 중 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2042) | `2007:2042` | 좁은 841 | F3 | 17 | 주행 중 기록(좁은 창) | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[일시정지]→D17p<br>[녹화 종료]→D21<br>[1초 타이머]→상태전환 | 탭0; 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [D17p / drive / 기록 멈춤 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2014-1327) | `2014:1327` | 좁은 841 | F3 | 18 | 주행 중 기록(좁은 창) — 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[녹화 재개]→D補 resumed<br>[녹화 종료]→D21 | 탭0 | 글 바뀜 |
| [D20 / continue / C1n 기준 좁은 창 기록 중 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2145) | `2007:2145` | 좁은 841 | F3 | 22 | 경유 후 주행 계속 기록 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[일시정지]→D20p<br>[녹화 종료]→D21<br>[1초 타이머]→상태전환<br>자동 6s→D補 finalNear | 탭0; 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [D20p / continue / 기록 멈춤 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2014-1609) | `2014:1609` | 좁은 841 | F3 | — | 경유 후 주행 계속 기록 — 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[녹화 재개]→D20<br>[녹화 종료]→D21 | 탭0 | 글 바뀜 |
| [D33 / transcript / 대화 기록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2019-2052) | `2019:2052` | 넓은 1682 | F3 | 26 | 대화 기록(발화자별) | **추천 장면 고르기**→D22 | 탭1; Conversation Car×4 | 글 바뀜 |
| [D補 / ended / 여행 종료](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2410) | `2026:2410` | 좁은 841 | F3 | — | 여행 기록 완료(좁은 창) | **새 여행 시작**→D16 | 탭0 | 같음 |
| [D補 / liveTranscript / 주행 중 대화 확인](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2308) | `2026:2308` | 좁은 841 | F3 | — | 주행 중 대화 기록 탭 | **함께 타는 중으로**→D補 resumed | 탭1; Conversation Car×4 | 글 바뀜 |
| [D補 / pausedTranscript / 기록 멈춤 상태의 대화](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2358) | `2026:2358` | 좁은 841 | F3 | — | 기록 멈춤 상태의 대화 기록 탭 | **함께 타는 중으로**→D17p | 탭1 | 같음 |
| [D補 / resumed / 기록 재개 후 주행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-1969) | `2026:1969` | 좁은 841 | F3 | 19 | 기록 재개 후 주행 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[일시정지]→D17p<br>[녹화 종료]→D21<br>[1초 타이머]→상태전환<br>자동 6s→D18 | 탭0; 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [프로필 / 로그아웃 확인 / 차량](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2220-5864) | `2220:5864` | 좁은 841 | F3 | — | 로그아웃 확인 오버레이(C 세트) | [바깥쪽 · 취소]→닫기<br>항목: 취소→닫기; 로그아웃→C01 | — | 새 |
| [프로필 / 로그아웃 확인 / 촬영용](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2220-5877) | `2220:5877` | 좁은 841 | F3 | — | 로그아웃 확인 오버레이(D 촬영용) | [바깥쪽 · 취소]→닫기<br>항목: 취소→닫기; 로그아웃→D01 | — | 새 |
| [프로필 메뉴 / 동승 그룹 / 차량](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2200-5852) | `2200:5852` | 좁은 841 | F3 | — | 프로필 메뉴 오버레이(C 세트용): 그룹·좌석·갤러리·로그아웃 | [메뉴 바깥쪽 · 닫기]→닫기<br>[닫기]→닫기<br>항목: 동승 그룹 변경→C16 groups; 좌석 배정→C16B; 갤러리 바로가기→C33; 로그아웃→로그아웃확인(차량)(오버레이) | — | 새 |
| [프로필 메뉴 / 동승 그룹 / 촬영용](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2200-5886) | `2200:5886` | 좁은 841 | F3 | — | 프로필 메뉴 오버레이(D 촬영용) | [메뉴 바깥쪽 · 닫기]→닫기<br>[닫기]→닫기<br>항목: 동승 그룹 변경→D16; 좌석 배정→D16B; 갤러리 바로가기→D27; 로그아웃→로그아웃확인(촬영용)(오버레이) | — | 새 |
| [A / D17 / 기록 중 **(채택 A)**](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-5597) | `2107:5597` | 좁은 841 | F3 | — | 시안 A · 기록 중 | **일시정지**→시안A-D18 | 탭0; Recording options / wave/live, Recording options / control/live | 새 |
| [A / D18 / 일시정지 **(채택 A)**](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-5715) | `2107:5715` | 좁은 841 | F3 | — | 시안 A · 일시정지 | **계속 기록**→시안A-D19 | 탭0; Recording options / wave/paused, Recording options / control/paused | 새 |
| [A / D19 / 다시 기록 **(채택 A)**](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-5834) | `2107:5834` | 좁은 841 | F3 | — | 시안 A · 다시 기록(8초 후 D20) | **일시정지**→시안A-D18<br>자동 8s→시안A-D20 | 탭0; Recording options / wave/live, Recording options / control/live | 새 |
| [B / D17 / 기록 중 (미채택 B)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6033) | `2107:6033` | 좁은 841 | F3 | — | 시안 B · 기록 중 | **일시정지**→시안B-D18 | 탭0; Recording options / wave/live/medium, Recording options / control/live | 새 |
| [B / D18 / 일시정지 (미채택 B)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6151) | `2107:6151` | 좁은 841 | F3 | — | 시안 B · 일시정지 | **계속 기록**→시안B-D19 | 탭0; Recording options / wave/paused/medium, Recording options / control/paused | 새 |
| [B / D19 / 다시 기록 (미채택 B)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6269) | `2107:6269` | 좁은 841 | F3 | — | 시안 B · 다시 기록(8초 후 D20) | **일시정지**→시안B-D18<br>자동 8s→시안B-D20 | 탭0; Recording options / wave/live/medium, Recording options / control/live | 새 |
| [C / D17 / 기록 중 (미채택 C)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6468) | `2107:6468` | 좁은 841 | F3 | — | 시안 C · 기록 중 | **일시정지**→시안C-D18 | 탭0; Recording options / wave/live/small, Recording options / control/live | 새 |
| [C / D18 / 일시정지 (미채택 C)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6591) | `2107:6591` | 좁은 841 | F3 | — | 시안 C · 일시정지 | **계속 기록**→시안C-D19 | 탭0; Recording options / wave/paused/small, Recording options / control/paused | 새 |
| [C / D19 / 다시 기록 (미채택 C)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6714) | `2107:6714` | 좁은 841 | F3 | — | 시안 C · 다시 기록(8초 후 D20) | **일시정지**→시안C-D18<br>자동 8s→시안C-D20 | 탭0; Recording options / wave/live/small, Recording options / control/live | 새 |

## F4 · 도착 브리핑 (C19, C19p, C20, D18/D19, finalNear/Brief/Paused)

| 프레임 | node id | 창 | 흐름 | 시연 | 용도 | 버튼 → 이동 | 컴포넌트 | 11/14 대비 |
|---|---|---|---|---|---|---|---|---|
| [C19 / near / C1n 기준 좁은 창 기록 중 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3341) | `2005:3341` | 좁은 841 | F4 | — | 경유지(마트) 3분 전 핵심 행동 | [프로필 메뉴 열기]→프로필메뉴(차량)(오버레이)<br>[일시정지]→C19p<br>[녹화 종료]→C22<br>[1초 타이머]→상태전환<br>자동 7s→C20 | 탭0; Briefing / action item / Car×3, Briefing emoji×3, 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [C19p / near / 기록 멈춤 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2014-1046) | `2014:1046` | 좁은 841 | F4 | — | 경유지(마트) 3분 전 핵심 행동 — 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(차량)(오버레이)<br>[녹화 재개]→C19<br>[녹화 종료]→C22 | 탭0; Briefing / action item / Car×3, Briefing emoji×3 | 글 바뀜 |
| [C20 / arrived / 하나로마트에 도착했어요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3369) | `2005:3369` | 넓은 1682 | F4 | — | 경유지 정차 후 상세 브리핑 | **계속**→C21 | 탭0; Briefing / action item / Car×6, Briefing emoji×7 | 글 바뀜 |
| [D18 / near / C1n 기준 좁은 창 기록 중 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2082) | `2007:2082` | 좁은 841 | F4 | 20 | 경유지(마트) 3분 전 핵심 행동 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[일시정지]→D18p<br>[녹화 종료]→D21<br>[1초 타이머]→상태전환 | 탭0; Briefing / action item / Car×3, Briefing emoji×3, 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [D18p / near / 기록 멈춤 / 841×1210](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2014-1470) | `2014:1470` | 좁은 841 | F4 | — | 경유지(마트) 3분 전 핵심 행동 — 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[녹화 재개]→D18<br>[녹화 종료]→D21 | 탭0; Briefing / action item / Car×3, Briefing emoji×3 | 글 바뀜 |
| [D19 / arrived / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2032-6496) | `2032:6496` | 좁은 841 | F4 | 21 | 경유지 정차 후 상세 브리핑 | **계속**→D20 | 탭0; Briefing emoji×3, Briefing / action item / Car×4 | 새 |
| [D19 / arrived / 아빠의 가족 여행_수정본](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2131-6137) | `2131:6137` | 좁은 841 | F4 | — | D19 도착 브리핑 수정본(같은 글) | **계속**→D20 | 탭0; Briefing emoji×3, Briefing / action item / Car×4 | 새 |
| [D補 / finalBrief / 좁은 화면 최종 목적지 브리핑](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2043-1890) | `2043:1890` | 좁은 841 | F4 | 24 | 숙소 정차 후 상세 브리핑 | **여행 마치고 기록 보기**→D21 | 탭0; Briefing / action item / Car×4, Briefing emoji×4 | 글 바뀜 |
| [D補 / finalNear / 좁은 화면 최종 목적지 1분 전](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2043-1835) | `2043:1835` | 좁은 841 | F4 | 23 | 숙소 1분 전 핵심 행동 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[일시정지]→D補 finalPaused<br>[녹화 종료]→D21<br>[1초 타이머]→상태전환<br>자동 8s→D補 finalBrief | 탭0; Briefing / action item / Car×3, Briefing emoji×3, 녹화 타이머 · 1초 / Tick=A | 글 바뀜 |
| [D補 / finalPaused / 숙소 도착 전 기록 멈춤](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2043-1933) | `2043:1933` | 좁은 841 | F4 | — | 숙소 도착 전 기록 멈춤 | [프로필 메뉴 열기]→프로필메뉴(촬영용)(오버레이)<br>[녹화 재개]→D補 finalNear<br>[녹화 종료]→D21 | 탭0; Briefing / action item / Car×3, Briefing emoji×3 | 글 바뀜 |
| [A / D20 / 도착 전 브리핑 **(채택 A)**](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-5952) | `2107:5952` | 좁은 841 | F4 | — | 시안 A · 도착 전 브리핑 | **일시정지**→시안A-D20p | 탭0; Recording options / control/live | 새 |
| [A / D20p / 도착 전 일시정지 **(채택 A)**](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2112-5678) | `2112:5678` | 좁은 841 | F4 | — | 시안 A · 도착 전 일시정지 | **계속 기록**→시안A-D20 | 탭0; Recording options / control/paused | 새 |
| [B / D20 / 도착 전 브리핑 (미채택 B)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6387) | `2107:6387` | 좁은 841 | F4 | — | 시안 B · 도착 전 브리핑 | **일시정지**→시안B-D20p | 탭0; Recording options / control/live | 새 |
| [B / D20p / 도착 전 일시정지 (미채택 B)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2112-5749) | `2112:5749` | 좁은 841 | F4 | — | 시안 B · 도착 전 일시정지 | **계속 기록**→시안B-D20 | 탭0; Recording options / control/paused | 새 |
| [C / D20 / 도착 전 브리핑 (미채택 C)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2107-6837) | `2107:6837` | 좁은 841 | F4 | — | 시안 C · 도착 전 브리핑 | **일시정지**→시안C-D20p | 탭0; Recording options / wave/live/small, Recording options / control/live | 새 |
| [C / D20p / 도착 전 일시정지 (미채택 C)](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2112-5820) | `2112:5820` | 좁은 841 | F4 | — | 시안 C · 도착 전 일시정지 | **계속 기록**→시안C-D20 | 탭0; Recording options / wave/paused/small, Recording options / control/paused | 새 |

## F5 · 주행 후 장면 고르기·생성 (C22–C32, D21–D26, D補 select*)

| 프레임 | node id | 창 | 흐름 | 시연 | 용도 | 버튼 → 이동 | 컴포넌트 | 11/14 대비 |
|---|---|---|---|---|---|---|---|---|
| [C22 / upload / 오늘의 주행을 기록했어요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3443) | `2005:3443` | 넓은 1682 | F5 | — | 주행 종료·전체 음성 업로드 | **추천 장면 보기**→C23<br>자동 5s→C23 | 탭2 | 글 바뀜 |
| [C23 / select0 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3546) | `2005:3546` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 0 | **장면을 선택해 주세요**→—<br>항목: 파형구간→C24; 1→C24; 파형구간→C25; 2→C25 외 5 | 탭2 | 같음 |
| [C24 / select1 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3645) | `2005:3645` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 1 | **선택한 1개 생성**→C31<br>항목: 파형구간→C23; 1→C23; 파형구간→C26; 2→C26 외 5 | 탭2 | 같음 |
| [C25 / select2 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3744) | `2005:3744` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 2 | **선택한 1개 생성**→C31<br>항목: 파형구간→C26; 1→C26; 파형구간→C23; 2→C23 외 5 | 탭2 | 같음 |
| [C26 / select3 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3843) | `2005:3843` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 3 | **선택한 2개 생성**→C31<br>항목: 파형구간→C25; 1→C25; 파형구간→C24; 2→C24 외 5 | 탭2 | 같음 |
| [C27 / select4 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-3942) | `2005:3942` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 4 | **선택한 1개 생성**→C31<br>항목: 파형구간→C28; 1→C28; 파형구간→C29; 2→C29 외 5 | 탭2 | 같음 |
| [C28 / select5 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4041) | `2005:4041` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 5 | **선택한 2개 생성**→C31<br>항목: 파형구간→C27; 1→C27; 파형구간→C30; 2→C30 외 5 | 탭2 | 같음 |
| [C29 / select6 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4140) | `2005:4140` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 6 | **선택한 2개 생성**→C31<br>항목: 파형구간→C30; 1→C30; 파형구간→C27; 2→C27 외 5 | 탭2 | 같음 |
| [C30 / select7 / 남기고 싶은 순간을 골라요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4239) | `2005:4239` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 7 | **선택한 3개 생성**→C31<br>항목: 파형구간→C29; 1→C29; 파형구간→C28; 2→C28 외 5 | 탭2 | 같음 |
| [C31 / generating / 우리 가족의 콘텐츠를 만들어요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4338) | `2005:4338` | 넓은 1682 | F5 | — | 숏폼 생성 중 | **콘텐츠 기록으로**→C32<br>자동 5s→C32 | 탭2 | 글 바뀜 |
| [C32 / complete / 우리 가족의 순간이 완성됐어요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4441) | `2005:4441` | 넓은 1682 | F5 | — | 생성 완료 결과 | **콘텐츠 기록 보기**→C33<br>항목: 11.14  강릉 가족 여행 …→C37; 11.14  강릉 가족 여행 …→C補 player3 | 탭2; Archive / galleryCar / 1, Archive 캐릭터×4, Archive / galleryCar / 3 | 글 바뀜 |
| [D21 / upload / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2184) | `2007:2184` | 넓은 1682 | F5 | 25 | 주행 종료·전체 음성 업로드 | **대화 기록 확인**→D33<br>자동 4s→D33 | 탭2 | 글 바뀜 |
| [D22 / select0 / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2287) | `2007:2287` | 넓은 1682 | F5 | 27 | 추천 장면 선택 상태 0 | **장면을 선택해 주세요**→—<br>항목: 파형구간→D23; 1→D23; 파형구간→D補 select2; 2→D補 select2 외 5 | 탭2 | 같음 |
| [D23 / select1 / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2386) | `2007:2386` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 1 | **선택한 1개 생성**→D25<br>항목: 파형구간→D22; 1→D22; 파형구간→D補 select3; 2→D補 select3 외 5 | 탭2 | 같음 |
| [D24 / select5 / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2485) | `2007:2485` | 넓은 1682 | F5 | 28 | 추천 장면 선택 상태 5 | **선택한 2개 생성**→D25<br>항목: 파형구간→D補 select4; 1→D補 select4; 파형구간→D補 select7; 2→D補 select7 외 5 | 탭2 | 같음 |
| [D25 / generating / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2584) | `2007:2584` | 넓은 1682 | F5 | 29 | 숏폼 생성 중 | **생성 결과 확인**→D26<br>자동 4s→D26 | 탭2 | 글 바뀜 |
| [D26 / complete / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2687) | `2007:2687` | 넓은 1682 | F5 | 30 | 생성 완료 결과 | **콘텐츠 기록 보기**→D27<br>항목: 11.14  강릉 가족 여행 …→D31; 11.14  강릉 가족 여행 …→D補 player3 | 탭2; Archive / galleryCar / 1, Archive 캐릭터×4, Archive / galleryCar / 3 | 글 바뀜 |
| [D補 / select2 / 추천 구간 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2522) | `2026:2522` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 2 | **선택한 1개 생성**→D25<br>항목: 파형구간→D補 select3; 1→D補 select3; 파형구간→D22; 2→D22 외 5 | 탭2 | 같음 |
| [D補 / select3 / 추천 구간 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2628) | `2026:2628` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 3 | **선택한 2개 생성**→D25<br>항목: 파형구간→D補 select2; 1→D補 select2; 파형구간→D23; 2→D23 외 5 | 탭2 | 같음 |
| [D補 / select4 / 추천 구간 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2734) | `2026:2734` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 4 | **선택한 1개 생성**→D25<br>항목: 파형구간→D24; 1→D24; 파형구간→D補 select6; 2→D補 select6 외 5 | 탭2 | 같음 |
| [D補 / select6 / 추천 구간 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2840) | `2026:2840` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 6 | **선택한 2개 생성**→D25<br>항목: 파형구간→D補 select7; 1→D補 select7; 파형구간→D補 select4; 2→D補 select4 외 5 | 탭2 | 같음 |
| [D補 / select7 / 추천 구간 선택](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2946) | `2026:2946` | 넓은 1682 | F5 | — | 추천 장면 선택 상태 7 | **선택한 3개 생성**→D25<br>항목: 파형구간→D補 select6; 1→D補 select6; 파형구간→D24; 2→D24 외 5 | 탭2 | 같음 |

## F6 · 콘텐츠 기록 (C33–C38, D27–D32, C補/D補 player·export)

| 프레임 | node id | 창 | 흐름 | 시연 | 용도 | 버튼 → 이동 | 컴포넌트 | 11/14 대비 |
|---|---|---|---|---|---|---|---|---|
| [C33 / gallery / 콘텐츠 기록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4482) | `2005:4482` | 넓은 1682 | F6 | — | 콘텐츠 기록·갤러리 보기 | 항목: 11.14  강릉 가족 여행 …→C37; 11.14  강릉 가족 여행 …→C補 player3 | 탭2; Archive / 보기 전환 / Car / 0, Archive 캐릭터×8, Archive / galleryCar / 1, Archive / galleryCar / 3 | 글 바뀜 |
| [C34 / timeline / 콘텐츠 기록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4522) | `2005:4522` | 넓은 1682 | F6 | — | 콘텐츠 기록·타임라인 보기 | 항목: 09:32 11.14  강릉 …→C37; 10:22 11.14  강릉 …→C補 player3 | 탭2; Archive / 보기 전환 / Car / 1, Archive 캐릭터×8, Archive / listCar / 1, Archive / listCar / 3 | 글 바뀜 |
| [C35 / map / 콘텐츠 기록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4562) | `2005:4562` | 넓은 1682 | F6 | — | 콘텐츠 기록·지도 보기 | 항목: 11.14  강릉 가족 여행 …→C37; 11.14  강릉 가족 여행 …→C補 player3 | 탭2; Archive / 보기 전환 / Car / 2, Archive / pin / 1, Archive 캐릭터×8, Archive / pin / 3, Archive / listPhone / 1, Archive / listPhone / 3 | 글 바뀜 |
| [C36 / detail / 이 길에서 나눈 이야기](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4601) | `2005:4601` | 넓은 1682 | F6 | — | 지도에서 고른 장면 상세 | **이 장면 보기**→C37<br>지도로 돌아가기→C35<br>항목: 11.14  강릉 가족 여행 …→C37; 11.14  강릉 가족 여행 …→C補 player3 | 탭2; Archive / pin / 1, Archive 캐릭터×8, Archive / pin / 3, Archive / listPhone / 1, Archive / listPhone / 3 | 글 바뀜 |
| [C37 / player / 아빠보다 빠른 서준의 정답](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4640) | `2005:4640` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 1) | **영상 내보내기**→C38<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C37 재생중 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 글 바뀜 |
| [C37 / player / 아빠보다 빠른 서준의 정답 / 일시정지](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2083-4309) | `2083:4309` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 1) — 일시정지 | **영상 내보내기**→C38<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C37 재생중 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 새 |
| [C37 / player / 아빠보다 빠른 서준의 정답 / 재생 중](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2081-4294) | `2081:4294` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 1) — 재생 중 | **영상 내보내기**→C38<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C37 일시정지 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 새 |
| [C38 / export / 공유할 준비가 됐어요](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2005-4668) | `2005:4668` | 넓은 1682 | F6 | — | 영상 내보내기 준비 완료(장면 1) | **콘텐츠 기록으로**→C33 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 글 바뀜 |
| [C補 / export2 / 젤리 한 봉지의 가족 협상](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2073-3728) | `2073:3728` | 넓은 1682 | F6 | — | 내보내기 준비(장면 2) | **콘텐츠 기록으로**→C33 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 새 |
| [C補 / export3 / 내일도 같이 타면 안 돼?](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2073-3774) | `2073:3774` | 넓은 1682 | F6 | — | 내보내기 준비(장면 3) | **콘텐츠 기록으로**→C33 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 새 |
| [C補 / player2 / 젤리 한 봉지의 가족 협상](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2071-3105) | `2071:3105` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 2 젤리 협상) | **영상 내보내기**→C補 export2<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C補 player2 재생중 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 새 |
| [C補 / player2 / 젤리 한 봉지의 가족 협상 / 일시정지](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2083-4358) | `2083:4358` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 2 젤리 협상) — 일시정지 | **영상 내보내기**→C補 export2<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C補 player2 재생중 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 새 |
| [C補 / player2 / 젤리 한 봉지의 가족 협상 / 재생 중](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2081-4343) | `2081:4343` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 2 젤리 협상) — 재생 중 | **영상 내보내기**→C補 export2<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C補 player2 일시정지 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 새 |
| [C補 / player3 / 내일도 같이 타면 안 돼?](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2071-3140) | `2071:3140` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 3 내일도 같이 타) | **영상 내보내기**→C補 export3<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C補 player3 재생중 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 새 |
| [C補 / player3 / 내일도 같이 타면 안 돼? / 일시정지](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2083-4407) | `2083:4407` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 3 내일도 같이 타) — 일시정지 | **영상 내보내기**→C補 export3<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C補 player3 재생중 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 새 |
| [C補 / player3 / 내일도 같이 타면 안 돼? / 재생 중](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2081-4392) | `2081:4392` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 3 내일도 같이 타) — 재생 중 | **영상 내보내기**→C補 export3<br>콘텐츠 기록→C33<br>항목: 11.14  강릉 가족 여행 …→C補 player3 일시정지 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 새 |
| [D27 / gallery / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2728) | `2007:2728` | 넓은 1682 | F6 | 31 | 콘텐츠 기록·갤러리 보기 | 항목: 11.14  강릉 가족 여행 …→D31; 11.14  강릉 가족 여행 …→D補 player3 | 탭2; Archive / 보기 전환 / Car / 0, Archive 캐릭터×8, Archive / galleryCar / 1, Archive / galleryCar / 3 | 글 바뀜 |
| [D28 / timeline / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2768) | `2007:2768` | 넓은 1682 | F6 | 32 | 콘텐츠 기록·타임라인 보기 | 항목: 09:32 11.14  강릉 …→D31; 10:22 11.14  강릉 …→D補 player3 | 탭2; Archive / 보기 전환 / Car / 1, Archive 캐릭터×8, Archive / listCar / 1, Archive / listCar / 3 | 글 바뀜 |
| [D29 / map / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2808) | `2007:2808` | 넓은 1682 | F6 | 33 | 콘텐츠 기록·지도 보기 | 항목: 11.14  강릉 가족 여행 …→D31; 11.14  강릉 가족 여행 …→D補 player3 | 탭2; Archive / 보기 전환 / Car / 2, Archive / pin / 1, Archive 캐릭터×8, Archive / pin / 3, Archive / listPhone / 1, Archive / listPhone / 3 | 글 바뀜 |
| [D30 / detail / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2847) | `2007:2847` | 넓은 1682 | F6 | — | 지도에서 고른 장면 상세 | **이 장면 보기**→D31<br>지도로 돌아가기→D29<br>항목: 11.14  강릉 가족 여행 …→D31; 11.14  강릉 가족 여행 …→D補 player3 | 탭2; Archive / pin / 1, Archive 캐릭터×8, Archive / pin / 3, Archive / listPhone / 1, Archive / listPhone / 3 | 글 바뀜 |
| [D31 / player / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2886) | `2007:2886` | 넓은 1682 | F6 | 34 | 숏폼 미리보기(장면 1) | **영상 내보내기**→D32<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D31 재생중 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 글 바뀜 |
| [D31 / player / 아빠의 가족 여행 / 일시정지](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2083-4162) | `2083:4162` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 1) — 일시정지 | **영상 내보내기**→D32<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D31 재생중 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 새 |
| [D31 / player / 아빠의 가족 여행 / 재생 중](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2081-4147) | `2081:4147` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 1) — 재생 중 | **영상 내보내기**→D32<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D31 일시정지 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 새 |
| [D32 / export / 아빠의 가족 여행](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2007-2914) | `2007:2914` | 넓은 1682 | F6 | 35 | 영상 내보내기 준비 완료(장면 1) | **콘텐츠 기록으로**→D27 | 탭2; Archive / playerCar / 1, Archive 캐릭터×2 | 글 바뀜 |
| [D補 / emptyContent / 생성 전 콘텐츠 기록](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-2473) | `2026:2473` | 넓은 1682 | F6 | — | 생성 전 빈 콘텐츠 기록 | **함께 타는 중으로**→D補 resumed | 탭2 | 같음 |
| [D補 / export2 / 젤리 협상](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-3163) | `2026:3163` | 넓은 1682 | F6 | — | 내보내기 준비(장면 2) | **콘텐츠 기록으로**→D27 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 글 바뀜 |
| [D補 / export3 / 내일도 같이 타](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-3209) | `2026:3209` | 넓은 1682 | F6 | — | 내보내기 준비(장면 3) | **콘텐츠 기록으로**→D27 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 글 바뀜 |
| [D補 / player2 / 젤리 협상](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-3093) | `2026:3093` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 2 젤리 협상) | **영상 내보내기**→D補 export2<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D補 player2 재생중 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 글 바뀜 |
| [D補 / player2 / 젤리 협상 / 일시정지](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2083-4211) | `2083:4211` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 2 젤리 협상) — 일시정지 | **영상 내보내기**→D補 export2<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D補 player2 재생중 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 새 |
| [D補 / player2 / 젤리 협상 / 재생 중](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2081-4196) | `2081:4196` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 2 젤리 협상) — 재생 중 | **영상 내보내기**→D補 export2<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D補 player2 일시정지 | 탭2; Archive / playerCar / 2, Archive 캐릭터×2 | 새 |
| [D補 / player3 / 내일도 같이 타](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2026-3128) | `2026:3128` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 3 내일도 같이 타) | **영상 내보내기**→D補 export3<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D補 player3 재생중 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 글 바뀜 |
| [D補 / player3 / 내일도 같이 타 / 일시정지](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2083-4260) | `2083:4260` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 3 내일도 같이 타) — 일시정지 | **영상 내보내기**→D補 export3<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D補 player3 재생중 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 새 |
| [D補 / player3 / 내일도 같이 타 / 재생 중](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2081-4245) | `2081:4245` | 넓은 1682 | F6 | — | 숏폼 미리보기(장면 3 내일도 같이 타) — 재생 중 | **영상 내보내기**→D補 export3<br>콘텐츠 기록→D27<br>항목: 11.14  강릉 가족 여행 …→D補 player3 일시정지 | 탭2; Archive / playerCar / 3, Archive 캐릭터×2 | 새 |

## 녹음 화면 시안 `2107:6979` — 채택안 A (F3·F4의 주행 창 디자인)

`2107:6979` "D17–20 녹음 화면 / 3가지 개선 시안"은 제목 프레임이고, 그 아래 시안 A(`2107:5593` 파형 중심), B(`2107:6029` 가족 중심), C(`2107:6464` 대화 중심) 줄이 있습니다. 오너는 **A**를 골랐습니다. 시안의 D 번호는 본편과 뜻이 다릅니다: 시안 D18 = 일시정지, D19 = 다시 기록, D20 = 도착 전 브리핑. 본편의 D18 = near, D19 = arrived, D20 = continue입니다.

| 시안 A 프레임 | node id | 흐름 | 화면 글(요약) | 버튼 → 이동 | 장면 설명(캡션) |
|---|---|---|---|---|---|
| A / D17 / 기록 중 | `2107:5597` | F3 | 00:12:48 · 아빠, 바다는 왜 짜? · 일시정지 | **일시정지**→시안A-D18 | D17  기록 중 / 하단 버튼으로 일시정지 |
| A / D18 / 일시정지 | `2107:5715` | F3 | 00:12:48 · 마지막 대화 · 아빠, 바다는 왜 짜? · 계속 기록 | **계속 기록**→시안A-D19 | D18  일시정지 / 하단 버튼으로 재개 |
| A / D19 / 다시 기록 | `2107:5834` | F3 | 00:12:49 · 그럼 바다도 국이야? · 일시정지 | **일시정지**→시안A-D18<br>자동 8s→시안A-D20 | D19  다시 기록 / 다음 장면 → |
| A / D20 / 도착 전 브리핑 | `2107:5952` | F4 | 녹음 · 00:38:14 · 하나로마트 · 약 3분 후 도착 · 🚻 · 화장실 가기 · 🛒 · 장보기 · 🗑 · 쓰레기 정리하기 · 일시정지 | **일시정지**→시안A-D20p | D20  도착 전 브리핑 / 정차 후 상세 브리핑 → |
| A / D20p / 도착 전 일시정지 | `2112:5678` | F4 | 마이크 꺼짐 · 00:38:14 · 하나로마트 · 약 3분 후 도착 · 🚻 · 화장실 가기 · 🛒 · 장보기 · 🗑 · 쓰레기 정리하기 · 계속 기록 | **계속 기록**→시안A-D20 | — |

- A의 탭 이동은 기존 D 세트로 갑니다(함께 타는 중→D補 resumed, 대화 기록→D補 liveTranscript, 콘텐츠 기록→D補 emptyContent). A 프레임은 아직 시연 플로우 `2045:1782`에 연결되어 있지 않습니다. 시연 17–22단계는 여전히 옛 좁은 창(D17, D17p, D補 resumed, D18, D19, D20)을 가리킵니다.
- 작업 지침 `BRIEF.md`의 소유표는 A안 5개를 모두 F3 담당으로 둡니다. 이 지도는 화면 성격에 따라 A-D20·A-D20p를 F4 표에 적었습니다(id는 같음).
- A의 컴포넌트: `Recording options / wave/live`·`wave/paused`(720×140 파형), `Recording options / control/live`·`control/paused`(777×128 하단 버튼). B는 `wave/*/medium`, C는 `wave/*/small`을 씁니다.

## 시연 플로우 `2045:1782` 단계 → 프레임

| 단계 | 이름 | 창 | 보여 주는 프레임 |
|---|---|---|---|
| 01 | 01 시작 | 차량 전체 화면 | `2007:1123` D01 |
| 02 | 02 계정 만들기 | 차량 전체 화면 | `2007:1162` D02 |
| 03 | 03 기록 동의 | 차량 전체 화면 | `2007:1202` D03 |
| 04 | 04 내 프로필 | 차량 전체 화면 | `2007:1245` D04 |
| 05 | 05 목소리 등록 | 차량 전체 화면 | `2007:1287` D05 |
| 06 | 06 15초 녹음 | 차량 전체 화면 | `2007:1390` D06 |
| 07 | 07 등록 완료 | 차량 전체 화면 | `2007:1494` D07 |
| 08 | 08 가족 추가 | 차량 전체 화면 | `2007:1533` D08 |
| 09 | 09 코드와 링크 초대 | 차량 전체 화면 | `2007:1576` D09 |
| 10 | 10 엄마 참여 확인 | 차량 전체 화면 | `2007:1615` D10 |
| 11 | 11 서준 프로필 | 차량 전체 화면 | `2007:1658` D11 |
| 12 | 12 서준 목소리 | 차량 전체 화면 | `2007:1699` D12 |
| 13 | 13 다음 구성원 | 차량 전체 화면 | `2007:1802` D13 |
| 14 | 14 하은 프로필 | 차량 전체 화면 | `2007:1845` D14 |
| 15 | 15 하은 목소리 | 차량 전체 화면 | `2007:1886` D15 |
| 16 | 16 전체 그룹 목록 | 차량 전체 화면 | `2007:1989` D16 |
| 16A | 16A 우리 가족 | 차량 전체 화면 | `2026:2133` D16A |
| 16B | 16B 좌석 선택 | 차량 전체 화면 | `2026:2076` D16B |
| 16C | 16C 앉을 사람 선택 | 차량 전체 화면 | `2094:4307` D16C |
| 16D | 16D 저장 후 출발 | 차량 전체 화면 | `2026:2133` D16A |
| G1 | G1 새 그룹 만들기 | 차량 전체 화면 | `2026:2193` D補 guest |
| G2 | G2 QR와 링크 초대 | 차량 전체 화면 | `2026:2241` D補 guestInvite |
| G3 | G3 전체 그룹 목록 | 차량 전체 화면 | `2097:4582` D16L |
| G4 | G4 새 그룹 확인 | 차량 전체 화면 | `2094:4367` D16G |
| QR1 | 차량 / 코드·QR·링크 | 차량 전체 화면 | `2007:1576` D09 |
| QR2 | 폰 / 동의와 참여 | 휴대폰 | `2043:1711` D補 phoneJoin(폰) |
| QR3 | 폰 / 참여 완료 | 휴대폰 | `2043:1743` D補 phoneJoined(폰) |
| QR4 | 차량 / 엄마 연결 | 차량 전체 화면 | `2007:1615` D10 |
| 17 | 17 주행 / 기록 중 | 좁은 창 / 내비 옆 | `2007:2042` D17 |
| 18 | 18 기록 중지 | 좁은 창 / 내비 옆 | `2014:1327` D17p |
| 19 | 19 기록 재개 | 좁은 창 / 내비 옆 | `2026:1969` D補 resumed |
| 20 | 20 도착 전 핵심 행동 | 좁은 창 / 내비 옆 | `2007:2082` D18 |
| 21 | 21 정차 후 상세 브리핑 | 좁은 창 / 내비 옆 | `2032:6496` D19 |
| 22 | 22 여행 계속 | 좁은 창 / 내비 옆 | `2007:2145` D20 |
| 23 | 23 숙소 도착 전 핵심 | 좁은 창 / 내비 옆 | `2043:1835` D補 finalNear |
| 24 | 24 숙소 정차 후 상세 | 좁은 창 / 내비 옆 | `2043:1890` D補 finalBrief |
| 25 | 25 음성 업로드 | 차량 전체 화면 | `2007:2184` D21 |
| 26 | 26 대화 기록 확인 | 차량 전체 화면 | `2019:2052` D33 |
| 27 | 27 추천 구간 확인 | 차량 전체 화면 | `2007:2287` D22 |
| 28 | 28 파형에서 장면 선택 | 차량 전체 화면 | `2007:2485` D24 |
| 29 | 29 숏폼 생성 | 차량 전체 화면 | `2007:2584` D25 |
| 30 | 30 생성 결과 | 차량 전체 화면 | `2007:2687` D26 |
| 31 | 31 갤러리 | 차량 전체 화면 | `2007:2728` D27 |
| 32 | 32 타임라인 | 차량 전체 화면 | `2007:2768` D28 |
| 33 | 33 지도 | 차량 전체 화면 | `2007:2808` D29 |
| 34 | 34 숏폼 보기 | 차량 전체 화면 | `2007:2886` D31 |
| 35 | 35 영상 내보내기 | 차량 전체 화면 | `2007:2914` D32 |

- 번호 단계 01–35, 좌석 16A–16D, 새 동승 그룹 G1–G4, QR 곁가지 4칸입니다. 11/14 판(35단계 + QR 4칸) 뒤에 16A–16D·G1–G4 줄이 새로 생겼습니다. 21단계 칸에는 제목 링크가 없어 미리보기 이름으로 맞췄습니다(D19 arrived → `2032:6496`).

## 11/14에 있었으나 지금 없는 차량 프레임

- `2007:2110` D19 / arrived / 아빠의 가족 여행 → 지금의 D19는 `2032:6496`(그리고 `_수정본` `2131:6137`)

## PNG를 못 받은 프레임 (0)

없음. 155개 모두 `png/`에 있습니다.
