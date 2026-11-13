# 시안과 화면 토큰

[T20](https://github.com/team-pitcrew/gachita/issues/29) · 피그마 시안이 어디까지인지, 색·글자 토큰의 기준이 어디인지, 한국형 UI 기준에 대 본 결과를 적습니다. 화면이 무엇을 하는지는 [화면 문서](../frontend/spec/README.md)가 기준입니다.

## 피그마 시안

| 파일 | 담은 것 | 기준 |
|---|---|---|
| [가치타 차량 화면](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja) | [기본 흐름](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja?node-id=2-73): 12개 앱 창 × 주행 중·정차·도착 후. [추가 상태 84개](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja?node-id=22-248): 기록 일시정지(운전자가 누름), 동의 대기, 내비 반영 대기·실패, 연결 끊김, 결과 준비 중·없음. 모두 120프레임 | 기획서 v4, T17([PR #54](https://github.com/team-pitcrew/gachita/pull/54)) |
| [개편 · 차와 폰](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=0-1) | 차 8장: [C1 주행 중 기록과 말하는 사람 강조](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=2-2), [C2 휴게소 제안과 말로 수락](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=2-121), [C3 도착 브리핑](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-93), [C4 Gleo 쓰는 동안 기록 잠시 멈춤](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-537), [C5 출발 전](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-647), [C6 여행 만들기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-1116)(1682 × 1210), [C1n](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=4-254)·[C2n](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=4-357)(841 × 1210). 폰 8장(390 × 844): P1 홈과 내 기록본 ~ [P8 9:16 숏폼](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=6-651). [근거 보드](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=8-512)(k-style-ui-ux, Android for Cars 등), [토큰 보드](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=8-598)(밝은·어두운) | 11/13 문구정리본, T20 개편(11/14, 지환 Pro 팀) |

- v4 파일은 밝은 화면의 차 화면만 있습니다.
- 11/13 뒤 흐름은 개편 파일에 있습니다. 말로 하는 수락과 도착 브리핑은 그보다 먼저 차 앱(Compose)에 만들어 에뮬레이터에서 확인했고, 목소리 등록·말하는 사람 강조·기록 잠시 멈춤은 구현 중입니다(T37, T41). 개편 시안을 따른 구현은 웹 [#175](https://github.com/team-pitcrew/gachita/pull/175)(열림)와 뒤이을 차 PR입니다.
- **화면 문서가 시안보다 앞섭니다.** C5의 '참가 QR', P2 '그룹 초대', P3 '자리 고르기'는 11/14 결정(폰의 동승 연결 QR을 차가 읽음, 그룹 없음, 자리는 차에서 고름) 전에 그렸습니다. 이 셋은 [차량 화면](../frontend/spec/car.md) 흐름 1과 [프로필 화면](../frontend/spec/profile.md)을 따릅니다.
- 두 파일 모두 지환의 피그마 계정(개편 파일은 Pro 팀)에 있고, 팀원과 심사위원에게 보기 권한을 아직 주지 않았습니다.

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

- 피그마 값은 11/14에 피그마 MCP로 [기본 흐름](https://www.figma.com/design/Qc58INq2ECd1ODzzmM7Nja?node-id=2-73) 노드(`2:73`)의 변수를 읽어 확인했습니다. 피그마 변수는 웹 토큰 이름을 그대로 씁니다.
- **색은 셋이 같습니다**(v4 피그마는 밝은 화면만).
- **개편 파일의 토큰 보드는 새 값입니다.** 밝은 화면에서 `--bg` #f2f1f6, `--ink` #1d1a28, `--ink-2` #514c66, `--line` #e7e5ed, `--accent-soft` #edebf6, `--ok` #177a41로 바뀌고 `--surface-2`, `--warn`(주의), 틴트 다섯이 더해집니다. `--accent` #5b47b0과 `--rec`는 그대로입니다(11/14 피그마 MCP로 [토큰 보드](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=8-598)의 변수를 읽음). 웹은 #175가 옮기는 중이고, 병합되면 위 표의 값도 바뀝니다. 차는 그 뒤 같은 값으로 맞춥니다.
- **차 글자 크기는 피그마와 다릅니다.** 같은 노드의 글자 변수(`T17/caption` … `T17/display`)는 20·24·28·32·36·44·56이고, 차 앱은 18·20·24·26·30·36·40·48sp를 화면마다 직접 적었습니다. 단추와 입력란의 크기만 `CarType`(`MainActivity.kt:79`)에 있습니다.
- 차의 여백(8~32dp)은 피그마 변수 `car-space`(12~48)와 다른 단계이고 이름으로 묶지 않았습니다.

## 한국형 UI 기준에 대 본 결과

[`vmc-inner-circle/k-style-ui-ux`](https://github.com/vmc-inner-circle/k-style-ui-ux)(공개, 커밋 `68afa2e`)의 [원칙](https://github.com/vmc-inner-circle/k-style-ui-ux/blob/68afa2e/plugins/k-style-ui-ux/core/references/principles.md)과 [비평 체크리스트](https://github.com/vmc-inner-circle/k-style-ui-ux/blob/68afa2e/plugins/k-style-ui-ux/core/references/checklist.md)에 develop의 웹 화면(`frontend/web/app.js`, `style.css`)과 차 화면(`MainActivity.kt`)을 코드로 대 봤습니다(11/14). 화면을 캡처해 본 비평은 아닙니다. 이 기준은 폰 앱 초안용이라, 차 화면에서는 [Pleos 주행 안전 가이드](https://document.pleos.ai/docs/pleos-only/vehicle-app-planning-guide/driver-distraction-guideline)가 먼저입니다(하단 고정 단추 같은 폰 골격은 차에 대지 않음).

| 등급 | 어긋난 것 | 어디 | 고칠 것 | 담당 |
|---|---|---|---|---|
| P0 | 걷어낼 좌석·공조를 가리키는 설명. 걷어내고 이 글만 남으면 없는 기능을 가리킴 | 웹 `app.js:334`('자리 설정을 한곳에서') | 좌석·공조를 걷어내는 같은 PR에서 고침(T68 서버, T6 웹) | web |
| P1 | 뜻이 다른 배지가 같은 색: '제안 중'과 '수락됨'이 같은 보라, '경유 반영'과 '완료'가 같은 초록. 같은 상태를 웹과 시연이 다르게 부름('경유 반영' / '경유지 반영') | 웹 `app.js:22-29`, `demo/demo.js:15` | 배지 표를 하나로: 보관 회색, 제안 중 안내색, 수락됨 브랜드, 경유 반영 성공색, 완료·취소는 닫힌 행이라 회색. `accepted`와 `reflected`는 계약(`openapi.yaml`, [차량 화면](../frontend/spec/car.md) 흐름 3)대로 구분하고, 같은 상태의 이름만 웹과 시연에서 맞춤. 안내색 토큰(`--info`)은 지금 없어 웹과 차에 새로 둠 | web |
| P1 | 같은 빨강이 '기록 중'(정상)과 '기록 멈춤'(막힘)에 같이 쓰임 | 차 `MainActivity.kt:547`, `:551` | '기록 멈춤'은 오류 색 + 경고 아이콘, '기록 중'은 기록 표시 점만 빨강 | car-ui |
| P1 | 칩 선택에 브랜드 색 | 웹 `style.css:256-260`(캐릭터 칩 등), `:303-306`(내 자리) | 칩 선택은 먹색 채움. 같은 `.chip` 모양을 쓰는 체크(기록 동의 기본값, `app.js:232`)는 브랜드 색 그대로 | web |
| P1 | 채운 단추에 짙은 글자(어두운 화면) | 웹 `style.css:29`, 차 `MainActivity.kt:75` | 채움용 토큰(`--accent-fill`)을 따로 둠. 어두운 화면에서 흰 글자가 4.5:1을 넘는 진한 보라로 하고, 글자용 `--accent`(#b6a6ee)는 그대로. 한 토큰으로는 둘 다 맞출 수 없음. 차는 `Button`의 채움 색을 같은 값으로, 대비 검사에 한 줄 더함 | web, car-ui |
| P1 | 허브 화면의 하단 고정 단추 | 웹 홈 `app.js:361`('새 여행 만들기'), 여행 화면 `:531`('부탁 남기기') | 하단 고정은 입력·확인 화면(프로필 저장, 기록 동의 묻기)에만. 홈과 여행 화면은 해당 블록 안의 단추로. 그러면 조작법 설명 '부탁은 아래 단추로 언제든 남길 수 있어요'(`app.js:16`)도 함께 지움 | web |
| P1 | 사람을 역할 이름으로 부름 | 웹 `app.js:15`('운전자가'), `:484`('떠난 사람') | 아는 경우 이름으로('{이름} 님이 출발을 눌러요') | web |
| P1 | 캐릭터도 사진도 없는 사람의 얼굴이 이름 한 글자 | 웹 `app.js:187` | 사람마다 다른 기본 캐릭터(여섯 가운데 하나)를 줌. 차의 말하는 사람 강조(T37)도 같은 그림. 얼굴을 동물 캐릭터로 두는 것은 기준 문서의 결정이라 k-style의 '사람 아바타' 규칙과 다르게 감 | web, car-ui |
| P2 | 캐릭터가 유니코드 이모지(기기마다 모양이 다름) | 웹 `app.js:33-40` | 같은 여섯 값(`bunny` … `penguin`)을 SVG 한 벌로(예: Fluent Emoji, MIT). 차도 같은 파일 | web, car-ui |
| P2 | 차 글자 크기가 화면마다 직접 적힘 | 차 `MainActivity.kt`(18~48sp, 여덟 값) | 있는 `CarType`(`:79`)을 피그마 단계(20·24·28·32·36·44·56)로 넓혀 모음. 주행 중 24sp 이상은 그대로 | car-ui |

여행 초대 공유(`/#코드`)와 그룹 초대 수락 화면은 11/14 결정으로 없어지므로 대지 않았습니다. 새로 생기는 동승 연결 QR(폰이 띄우고 주차 중 차가 읽음) 화면도 같은 기준으로 봅니다. 특히 '한 번뿐인 행동의 눌린 뒤 모습'(차가 읽은 뒤 폰의 '{자리}에 탔어요')이 있어야 합니다.

맞는 것: 한국어 줄바꿈(`word-break: keep-all`), 터치 영역(웹 48px 이상, 차 단추 64dp 이상·기록 동의 스위치 48dp), 불러오는 중(웹 뼈대 화면), 빈 상태가 행동을 이끔('아직 부탁이 없어요. …'), 지우기는 확인을 거침.
