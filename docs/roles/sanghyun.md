# 역할 안내: 상현님 (프론트 설계 · 백엔드 로직)

상현님과 상현님의 에이전트가 이 저장소에서 처음 읽는 글입니다. 아래 '에이전트에게 주는 글'은 통째로 붙여 넣어도 됩니다. 계획 전체는 [작업 목록](../tasks.md), 규칙 전체는 [개발 규칙](../development.md)에 있습니다.

## 맡은 것

| 파트 | 하는 일 | 경로 |
|---|---|---|
| `frontend-spec` | 피그마 전 단계. 화면이 무엇을 해야 하는지 글로 정함 | `frontend/spec/` |
| `backend-api` | 비즈니스 로직. API 서버와 명세 | `backend/api/`, `docs/api/` |

지환이 맡은 곳은 `frontend/web/`, `frontend/car/`(피그마 이후 시안과 구현), `backend/infra/`, `.github/`, `Makefile`입니다. 그쪽을 바꿔야 하면 먼저 이슈에 댓글로 범위를 맞춥니다.

Pleos 에뮬레이터에서 확인해야 하는 작업은 파트와 관계없이 지환이 맡습니다. 맡은 티켓에 그런 일이 섞여 있으면 이슈에 댓글로 넘깁니다.

## 넘기는 선

- **차량 화면의 크기와 영역.** 에뮬레이터 없이 화면 문서를 쓸 수 있게 [에뮬레이터 스펙과 화면 배치](../emulator/README.md)에 모았습니다. 앱 창은 1682 × 1210이고, 앱이 둘일 때의 반쪽 창(약 841 × 1210)도 같이 다룹니다.
- **화면 문서 → 시안·구현.** 화면 문서가 `develop`에 병합되면 지환이 그 문서로 피그마 시안과 구현을 시작합니다. 바꿀 것은 문서를 고치는 PR로 알립니다.
- **API 명세 → 앱.** `docs/api/openapi.yaml`이 앱과 서버 사이의 약속입니다. 경로나 응답을 바꾸면 명세와 서버를 같은 PR에서 고칩니다. 테스트가 둘을 대조합니다.
- **이미지.** API와 웹앱은 이미지 하나로 묶입니다. `backend/api/`를 바꾸면 CI의 `package` 검사가 이미지를 만들어 띄워 봅니다. 서버에 내보내는 일은 지환이 합니다.

## 처음 한 번

```sh
git clone https://github.com/team-pitcrew/gachita.git && cd gachita
make hooks     # 커밋 훅과 커밋 양식
make check     # 전체 검사. 로컬 Postgres 컨테이너를 띄운다
```

필요한 것: Node.js 22 이상, Docker, Python 3, `gh`, `gitleaks`.

## 티켓 하나의 순서

```sh
gh issue list -R team-pitcrew/gachita --assignee @me --state open   # 내 티켓
make ticket-start T=T17 NAME=car-spec    # develop에서 feature/T17-car-spec을 만들어 올린다
# 작업하고
make check
git commit                               # 제목은 [T17] 무엇을 하는지
make ticket-pr                           # 티켓 제목과 PR 양식으로 PR을 연다
gh pr checks --watch                     # 검사 일곱 개가 모두 통과하면 병합 커밋으로 합친다
```

티켓의 상태와 라벨은 브랜치·PR·병합에 따라 자동으로 옮겨집니다. 손으로 고치지 않습니다. 할 일 체크는 병합하고 확인한 뒤 본인이 합니다.

## 지금 맡은 티켓 (2026-11-13)

기준 문서가 참가신청서 문구정리본(11/13)으로 바뀌었습니다. 달라진 것은 [작업 목록](../tasks.md)의 머리말에 있습니다. P0은 11/15 접수(23:59 마감)에 꼭 필요한 것입니다. 위에서부터 하기를 권합니다. T38, T39, T42, T43은 11/13에 새로 생긴 티켓입니다.

| 순서 | 티켓 | 파트 | 우선순위 | 끝난 것으로 보는 기준 |
|---|---|---|---|---|
| 1 | [T42 화면 문서: 문구정리본에 맞춰 고치기](https://github.com/team-pitcrew/gachita/issues/60) | frontend-spec | P0 | 동의, 말하는 사람 강조, 말로 하는 수락, 도착 브리핑, 기록 잠시 멈춤, 프로필 피드가 화면 문서에 들어감 |
| 2 | [T12 음성 처리 흐름 설계](https://github.com/team-pitcrew/gachita/issues/13) | backend-api | P1 | 결정 기록 한 건과 API 명세 초안. 전제는 차량 직접 수음과 [ADR-0008](../adr/0008-in-car-capture-and-sdk-stt.md) |
| 3 | [T39 기록본 저장과 프로필 피드 API](https://github.com/team-pitcrew/gachita/issues/62) | backend-api | P1 | 두 프로필의 발화를 저장한 뒤 각 피드에 자기 발화만 나옴 |
| 4 | [T38 화자 대조: 모델 고르기와 API](https://github.com/team-pitcrew/gachita/issues/61) | backend-api | P1 | 결정 기록과 명세. 등록한 두 목소리가 맞는 프로필로 돌아옴 |
| 5 | [T43 장면 추천과 숏폼 생성](https://github.com/team-pitcrew/gachita/issues/63) | backend-api | P2 | 결정 기록과 시험 영상 한 편 |

끝낸 것: T17, T18, T19, T21, T22, T23.

할 일의 원문은 각 이슈에 있습니다. 순서나 범위가 맞지 않으면 이슈에 댓글을 남기거나 [작업 목록](../tasks.md)을 고치는 PR을 올립니다.

## 에이전트에게 주는 글

```text
너는 같이타 저장소(team-pitcrew/gachita)에서 상현님의 일을 돕는다.

맡은 파트는 둘이다.
- frontend-spec: frontend/spec/ 아래 화면 문서. 피그마로 그리기 전에 화면이 무엇을 해야 하는지 글로 정한다.
- backend-api: backend/api/ (Node 22 표준 http + pg, Postgres 17)와 docs/api/openapi.yaml.

먼저 읽는다: AGENTS.md, docs/development.md, docs/roles/sanghyun.md, 그리고 맡은 티켓의 이슈 본문.
화면 문서를 쓸 때는 frontend/spec/README.md와 _template.md를 따른다. 다섯 제목(목적, 흐름, 화면 요소, 상태, 문구)을 모두 채운다. 색과 크기는 적지 않는다.
API를 바꿀 때는 docs/api/openapi.yaml을 먼저 고치고 서버와 테스트를 맞춘다. OAuth 프로필(T21)과 현대 계정 연동(T22)은 서로 다른 모듈로 둔다. 기기 프로필에는 OAuth를 걸지 않는다.

일하는 순서: make ticket-start T=T번호 NAME=설명 → 작업 → make check → 커밋([T번호] 제목) → make ticket-pr → 검사 통과 확인.
한 PR은 한 파트, 한 가지 일만 바꾼다. PR 양식의 다섯 칸을 채우고, 확인한 것에는 돌린 명령과 결과를 적는다.

하지 않는다.
- main, develop에 직접 커밋하거나 올리지 않는다. --no-verify를 쓰지 않는다.
- frontend/web, frontend/car, backend/infra, .github, Makefile은 지환의 파트다. 바꿔야 하면 멈추고 이슈에 댓글로 묻는다.
- 비밀 값, 팀원 연락처, 단톡방 원문, 기획서 PDF를 저장소에 넣지 않는다.
- terraform apply처럼 비용이 생기는 명령을 실행하지 않는다.
- 에뮬레이터에서 확인해야 하는 일은 지환이 맡는다. 그런 일이 나오면 멈추고 이슈에 댓글로 넘긴다.
- 티켓의 라벨과 상태를 손으로 고치지 않는다. 실패한 검사를 약하게 고쳐 통과시키지 않는다.
- 문서에 가능하다고 적힌 것, 에뮬레이터에서 본 것, 실차에서 본 것을 섞어 적지 않는다. 확인하지 않은 것을 확인했다고 적지 않는다.

병합은 상현님이 정한다. PR을 열고 검사 결과를 알린 뒤 멈춘다.
```
