# 화면 명세와 디자인 인수인계

화면의 동작과 문구, 연결된 피그마 자료를 정리하는 곳입니다. 이 파트의 산출물은 화면 명세와 피그마 디자인 인수인계까지이며, 웹앱·차량 앱 구현은 이 자료를 기준으로 이어갑니다.

## 쓰는 법

1. `_template.md`를 복사해 화면 묶음 하나에 파일 하나를 만듭니다. 이름은 영문 소문자와 하이픈으로 씁니다. 예: `car-driving.md`.
2. 다섯 제목(목적, 흐름, 화면 요소, 상태, 문구)을 모두 채웁니다. CI의 `frontend-spec` 검사가 제목이 빠졌는지와 링크가 깨졌는지 봅니다.
3. 그림이 필요하면 손그림 사진이나 간단한 상자 그림을 `frontend/spec/img/`에 두고 링크합니다.
4. 피그마 링크에는 실제로 확인한 화면 범위를 적습니다. 기존 차량 화면을 상세 화면의 근거로 연결할 때는 진입 화면과 상세 흐름을 구분합니다.

## 무엇을 적나

| 제목 | 적는 것 |
|---|---|
| 목적 | 이 화면에서 사용자가 끝내려는 일 한 가지. 기획서의 몇 쪽에 해당하는지 |
| 흐름 | 어디서 들어와 무엇을 누르고 어디로 가는지. 번호 목록으로 |
| 화면 요소 | 화면에 있어야 하는 것과 중요한 순서. 색과 크기는 적지 않음 |
| 상태 | 비어 있을 때, 불러오는 중, 실패했을 때, 통신이 끊겼을 때, 주행 중일 때 |
| 문구 | 제목, 단추, 알림에 들어갈 글자 그대로. 해요체 |

## 넘기는 기준

문서와 연결된 피그마 자료를 검토한 뒤 `frontend/web/`·`frontend/car/` 구현 담당에게 넘깁니다. 명세·시안 작성 완료, PR 병합, 앱 구현, 에뮬레이터·실차 확인은 각각 구분해 적습니다. 백엔드 산출물도 병합된 API와 검토 중인 설계·구현 PR을 구분하고, 바뀐 점은 문서를 고치는 PR로 알립니다.

## 지금 있는 화면

폰 웹앱의 참가 4단계와 여행 화면은 문서 없이 먼저 만들었습니다([기록](https://github.com/team-pitcrew/gachita/pull/21)). 이후 화면의 자료는 아래 티켓으로 관리합니다.

- [차량 화면](car.md): T17, T42. 출발 전(동승자 QR 읽기), 말하는 사람 강조, 말로 하는 수락, 도착 브리핑, 기록 잠시 멈춤. 피그마 120개 프레임은 v4 시안
- [도착 후 화면](after-trip.md): T18, T42. 장면 고르기, 주행 기억 지도, 공유, 피드와 숏폼 재생
- [프로필과 동승 연결](profile.md): T19, T42. 프로필과 캐릭터, 동승 연결 QR(차가 읽음)과 기록 동의. 그룹과 초대 코드는 두지 않음(11/14)

### 화면 지도

| 시안 | 기기 | 들어오는 길 | 화면 문서 |
|---|---|---|---|
| [C6 여행 만들기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-1116) | 차, 주차 | 여행이 없을 때 첫 화면 | [차량 화면](car.md) 흐름 1의 1 |
| [C5 출발 전](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-647) | 차, 주차 | 여행을 만든 뒤 | 흐름 1의 2~4(동승자 연결, 기록 동의, 목소리 등록) |
| [C7 QR 읽은 뒤 자리 고르기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=12-531) | 차, 주차 | C5의 '동승자 연결' | 흐름 1의 2 |
| [C1](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=2-2)·[C1n](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=4-254) 기록 중과 말하는 사람 강조 | 차, 주행 | 기어 D | 흐름 2 |
| [C2](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=2-121)·[C2n](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=4-357) 휴게소 제안과 말로 수락 | 차, 주행 | 쉬어 가자는 말 | 흐름 3 |
| [C4 기록 잠시 멈춤](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-537) | 차, 주행 | 호출어나 'Gleo 쓰기' | 흐름 5 |
| [C3 도착 브리핑](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=3-93) | 차, 주차 | 할 일 장소에서 기어 P | 흐름 4 |
| [P1 홈·내 기록본](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=5-345) | 폰 | 주소를 열면 | [프로필 화면](profile.md) 1절, [도착 후 화면](after-trip.md) 4절 |
| [P2 프로필 만들기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=5-431) | 폰 | P1의 '프로필 만들기', 동승 연결 전 | 프로필 1절 |
| [P3 동승 연결 QR](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=5-509) | 폰 | P1의 '동승 연결' | 프로필 4절 |
| [P4 탔어요·기록 동의](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=5-571) | 폰 | 차가 QR을 읽은 뒤 | 프로필 4절 |
| [P5 여행 중](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=6-464) | 폰 | P4 뒤 | 프로필 4절의 4 |
| [P6 부탁 남기기](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=6-546) | 폰 | P5의 '부탁 남기기' | 문서 없음(처음 웹앱 때 만든 화면) |
| [P7 기록본](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=6-581) | 폰 | 여행 뒤, P1의 내 기록본 | 도착 후 1~2절, 4절 피드 |
| [P8 9:16 숏폼](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=6-651) | 폰, 주차 중 차 | P7의 '숏폼 보기' | 도착 후 4절 |

11/13 뒤 화면의 시안은 [개편 파일(11/14)](https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n?node-id=0-1)에 있고, 시안과 화면 문서가 다르면 화면 문서를 따릅니다. 만든 것과 만드는 중인 것은 각 문서의 흐름 끝에 '목표 동작 + 구현 상태'로 적습니다.
