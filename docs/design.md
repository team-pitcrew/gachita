# 시안과 화면 토큰

[T20](https://github.com/team-pitcrew/gachita/issues/29) · 피그마 시안이 어디까지인지, 색·글자 토큰의 기준이 어디인지, 한국형 UI 기준에 대 본 결과를 적습니다. 화면이 무엇을 하는지는 [화면 문서](../frontend/spec/README.md)가 기준입니다.

## 피그마 시안

| 파일 | 담은 것 | 기준 |
|---|---|---|
| [가치타 차량 화면](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja) | [기본 흐름](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja?node-id=2-73): 12개 앱 창 × 주행 중·정차·도착 후. [추가 상태 84개](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja?node-id=22-248): 기록 일시정지, 동의 대기, 내비 반영 대기·실패, 연결 끊김, 결과 준비 중·없음. 모두 120프레임 | 기획서 v4, T17([PR #54](https://github.com/team-pitcrew/gachita/pull/54)) |

- 밝은 화면만 있습니다. 어두운 화면과 폰 화면은 없습니다.
- 11/13 뒤에 정한 흐름(목소리 등록, 말하는 사람 강조, 말로 하는 수락, 도착 브리핑, 기록 잠시 멈춤)은 피그마에 없습니다. 이 화면들은 시안 없이 차 앱(Compose)과 웹 시연(`/demo`)에 바로 만들었고, 기준은 [차량 화면 문서](../frontend/spec/car.md)입니다. 제출(11/15)까지 피그마를 다시 그리지 않습니다(T20 범위 조정).
- 파일은 지환의 피그마 계정에 있습니다. 팀원과 심사위원이 보려면 보기 권한을 따로 줘야 합니다.

## 토큰의 기준

**기준은 웹 토큰 [`frontend/web/style.css`](../frontend/web/style.css)의 `:root`입니다.** 차 앱에는 테마 파일이 없고, 같은 색 값을 `MainActivity.kt`의 `LightColors`·`DarkColors`에 직접 적었습니다. 웹 대비는 `frontend/web/contrast.test.mjs`가 검사합니다.

| 토큰(웹) | 밝은 화면 | 어두운 화면 | 피그마 변수 | 차(Compose) |
|---|---|---|---|---|
| `--bg` | #f6f5f9 | #17161f | 같음 | `background` 같음 |
| `--surface` | #ffffff | #22202d | 같음 | `surface` 같음 |
| `--ink` / `--ink-2` | #1f1d2b / #5a5669 | #ece9f3 / #aaa5ba | 같음 | `onSurface` / `onSurfaceVariant` 같음 |
| `--line` | #e4e1eb | #383549 | 같음 | `outline` 같음 |
| `--accent` / `--accent-soft` | #5b47b0 / #efebfa | #b6a6ee / #2f2a47 | 같음 | `primary` / `primaryContainer` 같음 |
| `--on-accent` | #ffffff | #17161f | 같음(밝은 화면만) | `onPrimary` 같음 |
| `--rec` / `--ok` | #b3261e / #1b7350 | #ff9288 / #74d3a8 | 같음 | `error` / `tertiary` 같음 |
| `--r-card` / `--r-ctl` | 20 / 14 | | 같음 | 카드 20dp |

- **색은 셋이 같습니다.** 피그마 변수는 웹 토큰 이름을 그대로 씁니다(11/14 피그마 변수로 확인, 밝은 화면만).
- **차 글자 크기는 피그마와 다릅니다.** 피그마의 차 글자 단계는 20·24·28·32·36·44·56(T17/caption … display)이고, 차 앱은 18·20·24·26·30·36·40·48sp를 화면마다 직접 적었습니다. 맞추는 일은 아래 '고칠 것'에 있습니다.
- 차의 여백은 피그마의 `car-space` 12~48과 같은 범위(8~32dp)를 쓰지만 이름으로 묶지 않았습니다.

## 한국형 UI 기준에 대 본 결과

[`vmc-inner-circle/k-style-ui-ux`](https://github.com/vmc-inner-circle/k-style-ui-ux)(공개, 커밋 `68afa2e`)의 [원칙](https://github.com/vmc-inner-circle/k-style-ui-ux/blob/68afa2e/plugins/k-style-ui-ux/core/references/principles.md)과 [비평 체크리스트](https://github.com/vmc-inner-circle/k-style-ui-ux/blob/68afa2e/plugins/k-style-ui-ux/core/references/checklist.md)에 develop의 웹 화면(`frontend/web/app.js`, `style.css`)과 차 화면(`MainActivity.kt`)을 코드로 대 봤습니다(11/14). 화면을 캡처해 본 비평은 아닙니다. 이 기준은 폰 앱 초안용이라, 차 화면에서는 [Pleos 주행 안전 가이드](https://document.pleos.ai/docs/pleos-only/vehicle-app-planning-guide/driver-distraction-guideline)가 먼저입니다(하단 고정 단추 같은 폰 골격은 차에 대지 않음).

| 등급 | 어긋난 것 | 어디 | 고칠 것 | 담당 |
|---|---|---|---|---|
| P1 | 뜻이 다른 배지가 같은 색: '제안 중'과 '수락됨'이 같은 보라, '경유 반영'과 '완료'가 같은 초록 | 웹 `app.js:22-29` | 배지 표를 하나로: 보관·취소 회색, 제안 중 안내색, 수락됨·경유 반영은 '경유지로 가요' 하나로 묶어 브랜드, 완료 성공색 | web |
| P1 | 같은 빨강이 '기록 중'(정상)과 '기록 멈춤'(막힘)에 같이 쓰임 | 차 `MainActivity.kt:547`, `:551` | '기록 멈춤'은 오류 색 + 경고 아이콘, '기록 중'은 기록 표시 점만 빨강 | car-ui |
| P1 | 칩 선택에 브랜드 색 | 웹 `style.css:256-260`(자리·캐릭터 칩), `:303-306`(내 자리) | 칩 선택은 먹색 채움. 브랜드 색은 단추·체크·스위치에만 | web |
| P1 | 채운 단추에 짙은 글자(어두운 화면) | 웹 `style.css:29`, 차 `MainActivity.kt:75` | 어두운 화면의 `--accent`를 흰 글자가 4.5:1을 넘는 진한 보라로 바꾸고 `--on-accent`를 흰색으로. 대비 검사를 같이 고침 | web, car-ui |
| P1 | 허브 화면의 하단 고정 단추 | 웹 홈 `app.js:361`('새 여행 만들기'), 여행 화면 `:531`('부탁 남기기') | 하단 고정은 입력·확인 화면(참가 단계, 프로필 저장, 초대 수락)에만. 홈과 여행 화면은 해당 블록 안의 단추로 | web |
| P1 | 사람 얼굴이 이름 한 글자 | 웹 `app.js:187`(캐릭터·사진이 없을 때), 차는 얼굴 없이 이름 글자만 | 캐릭터가 없으면 기본 캐릭터 하나. 차의 말하는 사람 강조(T37)도 같은 그림 | web, car-ui |
| P2 | 캐릭터가 유니코드 이모지(기기마다 모양이 다름) | 웹 `app.js:33-38` | 같은 여섯 값(`bunny` … `penguin`)을 SVG 한 벌로(예: Fluent Emoji, MIT). 차도 같은 파일 | web, car-ui |
| P2 | 사람을 역할 이름으로 부름 | 웹 `app.js:15`('운전자가'), `:291`('대표에게'), `:484`('떠난 사람') | 아는 경우 이름으로('{이름} 님이 출발을 눌러요') | web |
| P2 | 걷어낸 기능을 가리키는 설명 | 웹 `app.js:334`('자리 설정을 한곳에서') | 좌석·공조를 걷어낼 때 같이 고침(T68·T6) | web |
| P2 | 차 글자 크기가 화면마다 직접 적힘 | 차 `MainActivity.kt`(18~48sp, 여덟 값) | 피그마 단계(20·24·28·32·36·44·56)로 `Typography` 하나에 모음. 주행 중 24sp 이상은 그대로 | car-ui |

맞는 것: 한국어 줄바꿈(`word-break: keep-all`), 웹 터치 영역 48px 이상·차 64dp 이상, 불러오는 중(웹 뼈대 화면), 빈 상태가 행동을 이끔('아직 부탁이 없어요. …'), 공유 뒤 결과 표시('초대 주소를 복사했어요'), 지우기는 확인을 거침.
