# 디자인 시스템과 시안

[T20](https://github.com/team-pitcrew/gachita/issues/29) · 화면이 **어떻게 보이는지**의 기준입니다. 화면이 **무엇을 하는지**는 [화면 문서](../frontend/spec/README.md)가 기준이고, 둘이 다르면 동작은 화면 문서를 따릅니다.

이 문서의 원칙·캐릭터·색은 11/14 03시 지환님이 정한 '디자인 1급 문서'(저장소 밖 작업 공간, 시안·웹·차가 따르는 기준)를 저장소에 옮긴 것입니다. 원본 캐릭터 시트는 저장소에 넣지 않고 앱이 쓰는 캐릭터별 그림만 넣습니다.

**11/15부터 화면 기준은 [민준 개선안](design-screens.md)입니다.** 색·모서리·글자 단계는 그 시안의 Figma 변수 모음 '가치타 2 / 토큰'(밝은·어두운 두 모드)과 글자 스타일(`Car/…`·`Phone/…`)을 따르고, 아래 3·4절이 그 값과 코드 이름을 한 표로 잇습니다. 값은 11/15 02:55 KST 복제본에서 읽었고, 04시 무렵부터는 Figma MCP가 원본을 바로 읽습니다(읽기만).

## 1. 원칙

- **가족의 대화를 기억하고, 도착할 때 필요한 일을 꺼내 줍니다**(시안 '00 읽어보기'). 주행 중에는 기록 상태와 짧은 브리핑만, 가입·편집·콘텐츠 재생은 주차 중에만. 기록 일시정지는 언제든 한 번에.
- **차는 어둡게, 폰은 밝게.** 시안의 차 화면 146장은 어두운 모드, 폰 화면 58장은 밝은 모드입니다. 차 앱은 늘 어두운 화면이고(#428) 폰은 밝은 화면이 기본입니다(기기가 어두운 모드면 같은 토큰의 어두운 값).
- **먹선과 파스텔.** 테두리 없는 카드 위에 먹색(어두운 화면에서는 미색) 글자, 강조는 연한 바탕(`-soft`). 캐릭터가 선 그림이라 카드에는 선을 두르지 않습니다.
- **한 화면에 한 가지 일.** 주 단추만 상징색, 칩 선택은 먹색, 숫자·진행은 먹색. 이모지와 이름 글자 얼굴은 쓰지 않습니다. 시안의 'Briefing / emoji'(Twemoji) 조각도 쓰지 않습니다(11/15 오너: 도착 브리핑은 이모지 없는 판) ([한국형 UI 기준](https://github.com/vmc-inner-circle/k-style-ui-ux/blob/68afa2e/plugins/k-style-ui-ux/core/references/principles.md)).
- **차 주행 화면은 Pleos 가이드가 먼저.** 글자 24sp 이상(결정할 글자는 32sp), 움직이거나 깜박이는 표시 없음, 말하는 사람은 그 자리 캐릭터에 링 하나([Pleos 주행 안전 가이드](https://document.pleos.ai/docs/pleos-only/vehicle-app-planning-guide/driver-distraction-guideline)). 폰의 골격(하단 고정 단추 등)은 차에 대지 않습니다.
- **말투는 해요체.** 문구는 화면 문서의 '문구' 표 그대로 씁니다.

## 2. 캐릭터: 원본 '말랑' 10종

사람의 얼굴(프로필, 피드), 차의 말하는 사람 강조, 숏폼의 말한 사람 표시에 같은 그림을 씁니다. 유형마다 원본 시트의 큰 캐릭터와 작은 캐릭터가 하나씩 있어, 웹과 차 모두 **10유형 × 큰·작은 = 20장**의 투명 전신 PNG를 씁니다(T83 #239, [`frontend/web/chars/README.md`](../frontend/web/chars/README.md)). 작은 캐릭터의 값은 `{값}-small`입니다(예: `cap-small`). 시트에서 이웃 캐릭터에 겹쳐 가려진 외곽과 팔은 11/14 지환님 요청으로 이미지 편집으로 복원했습니다. 그래서 원본과 같은 픽셀을 잘라 낸 것은 아니고, 선·표정·소품·색은 원본을 따릅니다. 아래 '카드 바탕'은 원본 시트의 카드 색이고, 앱의 그림은 바탕이 투명합니다.

| 값(API `character`, 작은 캐릭터는 `-small`) | 이름 | 소품 | 카드 바탕 |
|---|---|---|---|
| `basic` | 기본 | 손 흔들기 | 라벤더 |
| `cap` | 캡모자 | 뒤로 쓴 캡 | 꿀 |
| `glasses` | 안경 | 동그란 안경, 책 | 장미 |
| `travel` | 여행 | 버킷햇, 배낭 | 민트 |
| `game` | 게임 | 헤드폰, 게임패드 | 하늘 |
| `sport` | 운동 | 머리띠, 땀방울 | 민트 |
| `pet` | 반려동물 | 고양이 | 하늘 |
| `camping` | 캠핑 | 버킷햇, 랜턴 | 꿀 |
| `office` | 직장인 | 넥타이, 노트북 | 라벤더 |
| `healing` | 힐링 | 수면 모자 | 장미 |

- **얼굴:** 사진, 없으면 캐릭터, 없으면 `basic`. 사진만 원으로 자르고, 캐릭터는 전신을 틀 안에 맞춰(contain) 보입니다. 얼굴만 자르거나 이웃 캐릭터를 함께 보이지 않습니다.
- **옛 값:** `bunny` 등 동물 여섯과 모르는 값은 `basic` 그림으로 보입니다. 서버는 20자 문자열만 받아 바꿀 것이 없습니다.
- **차의 손님:** 캐릭터 값이 없습니다. 좌석 지도는 자리 순서로 `basic`·`cap`·`glasses`·`travel`·`game`을 쓰고, 쇼츠는 웹과 같은 자리 기본값(앞줄 `basic`·`cap`, 뒷줄 `glasses-small`·`travel-small`·`basic-small`)을 씁니다. 폰에서 고른 값이 있으면 그 값(#245). 쇼츠에서 말한 사람을 모르면 이름을 짓지 않습니다. 웹은 '말한 사람 미확인', 차는 좌석 구역이 있으면 자리 이름, 없으면 '화자 미확인'이고, 그림은 기본 캐릭터입니다(#247).
- **앱 마스코트**는 차 모양으로, 사람 캐릭터와 실루엣을 나눕니다(사람과 앱이 섞여 보이지 않게).

## 3. 색

**상징색은 민트**입니다(밝은 #60C090, 어두운 #6FD3A6). 원본 시트의 '여행' 색이고, 차에서 초록은 '정상·듣는 중'으로 읽혀 기록 중 빨강과 확실히 갈립니다. 바이올렛 #5b47b0은 쓰지 않습니다. 바탕·글자는 따뜻한 미색·먹색입니다([k-style-ui-ux](https://github.com/vmc-inner-circle/k-style-ui-ux) `derive.py --brand "#60C090" --tone warm`에서 시작해 시안이 그대로 씀).

이름은 시안의 Figma 변수(`color/…`) 기준입니다. 웹은 `frontend/web/style.css`의 CSS 변수, 차는 `Theme.kt`의 Material 역할입니다. **웹의 `--accent`는 시안의 `accent-text`(글자 색)이고, 시안의 `accent`(바탕 색)는 웹에서 `--accent-fill`입니다** — 이름이 엇갈리니 옮길 때 이 표를 봅니다.

| 시안 변수 | 밝은(폰) | 어두운(차) | 웹 | 차 | 쓰는 곳 |
|---|---|---|---|---|---|
| `bg` | #F6F4F1 | #12110F | `--bg` | `background` | 화면 바탕 |
| `surface` | #FFFFFF | #1C1A17 | `--surface` | `surface` | 카드 |
| `surface-2` | #F1EEE9 | #26231F | `--surface-2` | `surfaceVariant` | 묶음, 좌석 지도, 탭 바탕 |
| `ink` | #28221B | #F4F1EC | `--ink` | `onSurface` | 글자, 그림의 선 |
| `ink-2` | #5A5044 | #B5ADA2 | `--ink-2` | `onSurfaceVariant` | 보조 글 |
| `line` | #EDEAE6 | #34302A | `--line` | `outlineVariant` | 구분선 |
| `accent` | #60C090 | #6FD3A6 | `--accent-fill` | `primary` | 주 단추·고른 것의 바탕 |
| `on-accent` | #28221B | #12110F | `--on-accent` | `onPrimary` | 민트 바탕 위 글자(먹색) |
| `accent-text` | #2B7A53 | #7FDDB2 | `--accent` | `onPrimaryContainer` | 민트 글자·링·테두리 |
| `accent-soft` | #E4F4EC | #1C3A2D | `--accent-soft` | `primaryContainer` | 고른 것·제안·'연결됨' 바탕 |
| `rec` | #B3261E | #FF8A80 | `--rec` | `error` | 기록 중 표시와 타이머에만 |
| `rec-soft` | #FCE8E6 | #3A1F1E | (없음) | `errorContainer` | 기록 중 상태 바탕 |
| `ok` | #2B7A53 | #7FDDB2 | `--ok` | `tertiary` | 완료·반영 |
| `ok-soft` | #E4F4EC | #1C3A2D | (없음) | `tertiaryContainer` | 완료 바탕 |
| `warn` | #8C6400 | #F5C766 | `--warn` | `secondary` | 기다림, 기록 일시정지 |
| `warn-soft` | #FBF1DC | #3A2F17 | (없음) | `secondaryContainer` | 일시정지·도착 전 바탕 |
| `tint-1`~`5` | #ECEAFB #FCF0D9 #FBE7EE #E4F4EC #E5F0FB | #2A2840 #3A3020 #3A2530 #1E3A2E #1F2F40 | (없음) | (없음) | 사람마다 다른 장면 카드 바탕(시안에만, 코드는 아직 안 씀) |

- **주 단추는 민트 바탕에 먹색 글자입니다.** 민트 바탕은 흰 글자와 대비가 2.2:1이라 글자를 먹색(`on-accent`)으로 둡니다. 민트를 글자·링·테두리에 쓸 때는 `accent-text`입니다(시안 변수 설명 그대로). 글자 대비는 모두 4.5:1 이상이고 웹은 `contrast.test.mjs`가 검사합니다.
- **차는 늘 어두운 값입니다**(#428). 낮·밤으로 단추 색을 바꾸던 규칙(#217)은 없앴습니다.
- **빨강은 기록 중에만.** 기록 타이머(시안 C17 '19:11')와 기록 상태 점이 `rec`입니다. 막힘·실패는 빨강 글자에 경고 아이콘을 더해 색만으로 전하지 않습니다.
- **노랑은 멈춤과 기다림.** 기록 일시정지·도착 전 안내 바탕은 `warn-soft`, 글자는 `warn`입니다.

## 4. 글자와 모양

글꼴은 폰·차 모두 **Pretendard**입니다(시안 글자 스타일 전부). 차는 앱에 글꼴 파일을 담습니다 — Pleos 시스템의 'pretendard' 이름은 다른 글꼴(AstaSans)로 이어지므로 시스템 이름으로 부르지 않습니다(차 글꼴 PR 진행 중). 폰은 `"Pretendard Variable", Pretendard`를 먼저 부르고 없으면 기기 한글 글꼴입니다.

| 시안 스타일 | 크기/줄 높이 | 굵기 | 쓰는 곳 |
|---|---|---|---|
| `Car/Status 56` | 56/64 | Bold, 자간 -2 | 기록 타이머, 큰 상태 |
| `Car/Title 40` | 40/50 | Bold, 자간 -2 | 화면 제목 |
| `Car/Headline 32` | 32/42 | Bold, 자간 -1 | 카드 제목, 결정할 글자 |
| `Car/Body 28` | 28/40 | Medium | 본문, 대화 |
| `Car/Label 24` | 24/32 | Medium | 단추·탭·보조 글(차의 가장 작은 글자) |
| `Phone/Display 28` | 28/38 | Bold, 자간 -2 | 큰 제목 |
| `Phone/Title 22` | 22/30 | Bold, 자간 -1 | 화면 제목 |
| `Phone/Headline 19` | 19/28 | Bold, 자간 -1 | 카드 제목 |
| `Phone/Body 17` | 17/26 | Regular | 본문 |
| `Phone/Label 15` | 15/22 | Medium | 단추·탭 |
| `Phone/Caption 13` | 13/18 | Regular | 시각·보조 글 |

| | 폰(웹) | 차(Compose) |
|---|---|---|
| 모서리 | 카드 24(`radius/phone-card`, `--r-phone-card`), 단추·입력·칩 16(`radius/phone-ctl`), 배지·상태는 알약 | 카드 32(`radius/car-card`), 단추 24(`radius/car-ctl`) |
| 누르는 곳 | 48px 이상 | 단추 64dp 이상, 스위치 48dp |

- 차의 글자는 24 아래로 내리지 않습니다(주행 중 24sp 이상). 지금 코드의 20sp 글자(동의 화면의 긴 안내 등)는 시안 단계에 없으니 24로 올리거나 주차 중 화면에만 둡니다.
- 웹의 옛 반경(`--r-card` 14, `--r-ctl` 10)은 새 시안으로 바꾼 화면부터 `--r-phone-card`·`--r-phone-ctl`로 옮깁니다.
- 한국어는 낱말 중간에서 줄을 바꾸지 않습니다(`word-break: keep-all`). 숫자·단계는 원본 시트의 번호처럼 동그란 배지로 씁니다.

## 5. 공통 구성 요소

화면마다 새로 그리지 않고 아래 조각을 씁니다. 값은 원본 시안(폰 P 프레임, 차 C17·C17m·로그아웃 확인 `2220:5864`)에서 읽었고, 색은 3절 토큰 이름, 글자는 4절 스타일 이름입니다. 폰은 밝은 값, 차는 어두운 값입니다. 프레임별로 어디에 쓰였는지는 [화면 기준](design-screens.md)에 있습니다(폰 6절).

| 조각 | 폰(390) | 차(1682·841) | 색 |
|---|---|---|---|
| 머리 줄 | 350×32. 마스코트 24 + '가치타' 19 Bold. 오른쪽에 연결 상태(점 6 + `Phone/Caption 13`)와 **내 얼굴 단추 32**(누름 44) | 777×64. 마스코트 48 + '가치타' 32 Bold. 오른쪽 **내 얼굴 단추 64**(사진 54) | 글자 `ink`, 연결 점 `ok`·끊김 `rec` |
| 상위 탭 | 350×48, 모서리 14, 칸 셋 | 777×76, 모서리 20, 칸 모서리 16 | 바탕 `surface-2`, 고른 칸 `accent-soft` + `ink`, 나머지 `ink-2` |
| 카드 | 모서리 24(`radius/phone-card`), 안쪽 16–18 | 모서리 32(`radius/car-card`), 안쪽 24–46 | `surface` |
| 강조 카드 | 모서리 20, 안쪽 16 | 모서리 18–28 | `accent-soft`(요약·고른 것), `ok-soft`(현재 동승 그룹), `warn-soft`(일시정지·도착 전) |
| 목록 행 단추 | 높이 52, 모서리 16, 글 17 Bold + 오른쪽 '›' | 높이 66, 모서리 16, 글 25 Bold + '›' | `surface-2` + `ink` |
| 주 단추 | 높이 52, 모서리 16(`radius/phone-ctl`), 글 17 Bold | 높이 68–96, 모서리 24(`radius/car-ctl`), 글 24–30 Bold | `accent` 바탕 + `on-accent` 글자 |
| 보조 단추 | 같은 크기 | 같은 크기 | `surface-2` + `ink` |
| 위험 단추(로그아웃·지우기) | 같은 크기, 앞에 아이콘 | 높이 60, 아이콘 26 | `rec-soft` 바탕 + `rec` 글자 |
| 얼굴 | 원. 사진은 채워 자르고, 캐릭터는 전신을 틀 안에 맞춤. 32·40·48·72 | 48·54·80 | 틀 바탕 `surface-2` |
| 그룹 얼굴 2×2 | 72(부품 `Group / 2x2 / … / Phone`) | 144(`… / Car`) | 칸 사이 4 |
| 드롭다운 | 오른쪽 위 얼굴 단추 아래로 열림, 폭 = 화면 − 32, 모서리 24, 안쪽 16, 칸 사이 12 | 480 폭, 모서리 26, 안쪽 26 | `surface`, 테두리 #7A9C87 2(시안 값, 변수 아님), 그림자, 바깥 #000 56% |
| 확인 대화상자 | 가운데, 폭 = 화면 − 48, 제목 `Phone/Title 22` + 설명 `Phone/Body 17` `ink-2` + 단추 둘(취소·위험) | 480×232, 제목 30 Bold, 설명 21 | 드롭다운과 같음, 바깥 #000 62%. 바깥을 누르면 취소 |
| 상태 알약 | 높이 28, 점 + `Phone/Label 15` | 높이 48, 점 + `Car/Label 24` | 연결됨 `ok`, 기록 중 `rec`, 일시정지 `warn`(각 `-soft` 바탕) |
| 좌석 지도 | 차 몸 모서리 28, 자리 얼굴 48 | 차 몸 `surface-2` 모서리 40, 자리 얼굴 80 | 말하는 사람 링 `accent-text`, 빈자리 점선 `ink-2` |
| 알림('복사했어요' 등) | 아래 가운데, 모서리 16 | 위 가운데 | `accent-soft` + `ink` |

- **내 얼굴 단추와 드롭다운(11/15).** 모든 머리 줄 오른쪽 끝에 내 얼굴 단추를 둡니다. 누르면 드롭다운: 얼굴·이름과 닫기 → 현재 동승 그룹(그룹 얼굴 2×2, 이름, 인원) → 목록 행(내 프로필·동승 그룹 변경·좌석 배정·갤러리 바로가기) → 로그아웃(위험). 차는 주행 중에 '그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.'를 보이고 그 둘을 막습니다. 로그아웃은 확인 대화상자('로그아웃할까요? / 로그아웃하면 시작 화면으로 돌아가요.')를 거칩니다.
- 화면에 직접 색 값·글자 크기를 적지 않습니다. 새 값이 필요하면 시안 변수에 먼저 있는지 보고, 없으면 이 표에 더한 뒤 씁니다.

## 6. 구현 상태(11/14 develop `ca3d56a`)

| 무엇 | 웹 | 차 |
|---|---|---|
| 민트 토큰 | 있음([#175](https://github.com/team-pitcrew/gachita/pull/175): `style.css`) | 있음([#217](https://github.com/team-pitcrew/gachita/pull/217): `Theme.kt`) |
| 캐릭터 | 20장 전신 PNG([#239](https://github.com/team-pitcrew/gachita/pull/239): `chars/*.png`, 고르기 20가지 '{이름} · 큰/작은'). 옛 `chars/*.svg` 파일은 남아 있으나 쓰지 않음 | 20장 전신 PNG(#239: `res/drawable-nodpi/char_*.png`). 좌석 지도는 자리 순서 기본 다섯, 쇼츠는 고른 캐릭터(#245)·미확인도 전신(#247) |
| 화면 구성 | P1~P8 있음: 동승 연결 QR #205, 기록본과 장면 고르기 #200, 자막 고치기 #202·#209, 공유와 회수 #201·#206. #239부터 여행 화면 탭(여행·대화·쇼츠), 대화 목록 → 대화방, 위아래로 넘기는 세로 쇼츠(재생·이전·다음·음소거, 전신 캐릭터와 자막). 데스크톱·헤드리스 브라우저와 ego lite에서 확인, 실제 휴대폰은 아직 | #239: 기본 내비 옆 반쪽 창, 고정 칸(머리 줄·탭·본문·동의), 머리 줄 알약('주차 중'·'주행 중'·'연결 대기'), 탭 셋, 초점 칸 하나, 여행 관리, 대화방, 전신 캐릭터 쇼츠, Vehicle SDK 좌석 영역으로 그리는 좌석 지도, 'Gleo 쓰기' 단추 없음. 말로 수락·도착 브리핑·기록 잠시 멈춤·목소리 등록·말한 사람 강조·동승자 연결은 그대로 있음(에뮬레이터. E2E는 쇼츠의 `short_e2e.py`(#242) 말고는 #239 전 화면에서 돌림) |

#239의 차 화면은 Codex가 Pleos AVD에서 찍은 캡처(저장소 밖, 반쪽 창, 주차 중·주행 중)로 확인했고 실차는 아닙니다. 배치는 [차량 화면](../frontend/spec/car.md)의 화면 요소 표를 따릅니다. 쇼츠의 영상 만들기·저장·공유(#239·#244·#245)는 [ADR-0022](adr/0022-shortform-video-on-device-and-server-generation-off.md)를 따릅니다.

## 7. 피그마 시안

| 파일 | 담은 것 | 기준 |
|---|---|---|
| [민준 개선안](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2004-57) | 차 전체(1682 × 1210)·좁은 창(841 × 1210)·폰(390 × 844) 화면과 시연판(D01–D33), [시연 플로우 35단계](https://www.figma.com/design/Y7zFqGUEAFDWTumG30MsOs?node-id=2045-1782). 어두운 화면 | **지금 기준**(11/15 오너 결정). 프레임 → 흐름·코드 대응과 남은 것은 [화면 기준](design-screens.md) |
| [개편 · 차와 폰](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=0-1) | 차 9장: [C1 주행 중 기록과 말하는 사람 강조](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=2-2), [C2 휴게소 제안과 말로 수락](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=2-121), [C3 도착 브리핑](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-93), [C4 Gleo 쓰는 동안 기록 잠시 멈춤](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-537), [C5 출발 전](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-647), [C6 여행 만들기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-1116), [C7 QR 읽은 뒤 자리 고르기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=12-531)(1682 × 1210), [C1n](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=4-254)·[C2n](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=4-357)(841 × 1210). 폰 8장(390 × 844). [근거 보드](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=8-512), [토큰 보드](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=8-598) | 이전 기준(11/13 문구정리본, 11/14 디자인 1급) |
| [가치타 차량 화면](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja) | 12개 앱 창 × 주행 중·정차·도착 후와 추가 상태, 120프레임(밝은 화면만) | 기획서 v4, T17([PR #54](https://github.com/team-pitcrew/gachita/pull/54)). 바이올렛 시절의 기록 |

- 개편 파일은 11/14 결정(폰의 동승 연결 QR을 차가 읽음, 그룹 없음, 자리는 차에서 고름)에 맞춰 같은 날 C5·C7과 폰 P1~P5를 고쳤습니다.
- 이전 두 파일은 지환의 피그마 계정(개편 파일은 Pro 팀)에 있고, 팀원과 심사위원에게 보기 권한을 아직 주지 않았습니다. 민준 개선안은 민준님 파일이고, Figma MCP로 읽는 작업본은 지환의 복제본(노드 id 같음)입니다.

## 8. 한국형 UI 기준에 대 본 결과

[`vmc-inner-circle/k-style-ui-ux`](https://github.com/vmc-inner-circle/k-style-ui-ux)(커밋 `68afa2e`)의 원칙과 [비평 체크리스트](https://github.com/vmc-inner-circle/k-style-ui-ux/blob/68afa2e/plugins/k-style-ui-ux/core/references/checklist.md)에 develop(`67cef42`)의 웹·차 화면을 코드로 대 봤습니다(11/14, 화면 캡처 비평은 아님). 줄 번호는 그 커밋 기준입니다.

| 등급 | 어긋난 것 | 어디 | 처리 |
|---|---|---|---|
| P0 | 걷어낼 좌석·공조를 가리키는 홈 설명 | 웹 `app.js:334` | 고침(T6 #174) |
| P1 | 뜻이 다른 배지가 같은 색('제안 중'·'수락됨', '경유 반영'·'완료'), 같은 상태를 웹과 시연이 다르게 부름 | 웹 `app.js:22-29`, `demo/demo.js:15` | 남음. 이름은 웹과 시연이 한 표(`shared.js`, #159)를 써 '경유지 반영'으로 맞음. 색은 아직 '제안 중'·'수락됨'이 같고 '경유지 반영'·'완료'가 같음(웹 다음 PR). `accepted`·`reflected`는 계약대로 구분 |
| P1 | '기록 중'과 '기록 멈춤'이 같은 빨강 | 차 `MainActivity.kt:547`, `:551` | 일부 고침([#217](https://github.com/team-pitcrew/gachita/pull/217)): 머리 바탕은 기록 중 빨강, 멈춤·기다림 노랑으로 갈림. 막혔을 때 '기록 멈춤' 글자는 아직 빨강이고 경고 아이콘이 없음 |
| P1 | 칩 선택에 상징색 | 웹 `style.css:256-260`, `:303-306` | 고침(#175, 칩 선택은 먹색) |
| P1 | 어두운 화면의 주 단추에 짙은 글자 | 웹 `style.css:29`, 차 `MainActivity.kt:75` | 고침(#175). 민트로 바꾸며 의도된 예외(3절: 밝은 상징색 위 먹색 글자). 차는 #217에서 낮에 짙은 민트 위 흰 글자 |
| P1 | 허브 화면의 하단 고정 단추 | 웹 `app.js:361`, `:531` | 홈은 고침(#205가 '새 여행 만들기'를 걷음). 여행 화면의 '부탁 남기기'는 남음 |
| P1 | 사람을 역할 이름으로 부름 | 웹 `app.js:15`, `:484` | 남음('운전자가', '떠난 사람') |
| P1 | 사진·캐릭터 없는 사람의 얼굴이 이름 한 글자 | 웹 `app.js:187` | 고침(#175, 기본 캐릭터) |
| P2 | 캐릭터가 유니코드 이모지 | 웹 `app.js:33-40` | 고침(#175, 원본 조각 10종) |
| P2 | 차 글자 크기가 화면마다 직접 적힘 | 차 `MainActivity.kt` | 고침(#217, `Theme.kt`의 글자 단계) |

여행 초대 공유와 그룹 초대 수락 화면은 11/14 결정으로 없어지므로 대지 않았습니다. 새 동승 연결 화면(P3·P4, C7)도 같은 기준으로 봅니다. 특히 한 번뿐인 행동의 눌린 뒤 모습(폰의 '{자리}에 탔어요')이 있어야 합니다.

맞는 것: 한국어 줄바꿈, 터치 영역, 불러오는 중(웹 뼈대 화면), 빈 상태가 행동을 이끔, 지우기는 확인을 거침.
