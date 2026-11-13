# 프로젝트 보드(칸반)

티켓(T번호 이슈)이 카드입니다. 카드를 손으로 옮기지 않습니다. 브랜치와 PR이 생기고 병합되는 대로 [`tickets.yml`](../.github/workflows/tickets.yml)이 라벨과 보드를 같이 옮깁니다.

## 상태

| 상태 | 언제 | 무엇이 옮기나 |
|---|---|---|
| Backlog | 티켓을 만든 직후. 선행이 안 끝난 것 포함 | 이슈가 생길 때 |
| Ready | 선행이 끝나 시작할 수 있음 | 담당자가 고를 때만(자동 아님) |
| In progress | 브랜치를 올림. 또는 PR이 병합 없이 닫힘 | 브랜치와 PR 이벤트 |
| In review | PR을 엶 | PR 이벤트 |
| Done | PR 본문의 `Closes #번호`로 이은 PR이 병합됨 | PR 이벤트 |

- 보드의 상태는 완료의 증거가 아닙니다. 증거는 PR의 '확인한 것'입니다.
- `Refs #번호`로만 이은 PR은 병합돼도 티켓을 끝내지 않습니다. 그 티켓의 마지막 PR에만 `Closes`를 씁니다.
- 이미 닫힌 티켓은 뒤로 돌리지 않습니다.
- 할 일의 체크는 사람이 합니다. 다른 사람의 체크를 대신 하지 않습니다.

## 보드

[가치타 보드](https://github.com/orgs/team-pitcrew/projects/1)는 조직의 비공개 프로젝트이고 이 저장소에 이어져 있습니다. 기본 화면은 Status별 칸반('칸반')이고 열은 Backlog, Ready, In progress, In review, Done입니다. 번호는 저장소 변수 `PROJECT_NUMBER`(1)에 있습니다.

## 카드가 저절로 옮겨지는 길

두 가지가 같이 돕니다.

**1. 프로젝트에 딸린 자동화(토큰 없이 돎).** 보드의 Workflows에서 켜 두었습니다.

| 자동화 | 하는 일 |
|---|---|
| Auto-add to project | 이 저장소에 열린 이슈가 생기면 보드에 올림(필터 `is:issue is:open`) |
| Item added to project | 올라온 카드를 Backlog로 |
| Pull request linked to issue | PR 본문의 `Closes #번호`로 이슈에 이어지면 In review로 |
| Item closed | 이슈가 닫히면 Done으로 |
| Pull request merged | 보드에 올라온 PR이 병합되면 Done으로 |

**2. 우리 워크플로(`tickets.yml`).** 라벨을 옮기고, 비밀 값 `PROJECT_TOKEN`이 있으면 보드도 같이 옮깁니다. 위의 자동화가 못 하는 것이 여기에 있습니다.

| 일어난 일 | 프로젝트 자동화 | 우리 워크플로 |
|---|---|---|
| 브랜치를 올림 → In progress | 못 함 | 라벨은 됨. 보드는 `PROJECT_TOKEN`이 있어야 함 |
| `Refs #번호`로만 이은 PR → In review | 못 함 | 위와 같음 |
| PR이 병합 없이 닫힘 → In progress | 못 함 | 위와 같음 |

보드에 쓰려면 프로젝트 권한이 있는 토큰이 필요합니다. Actions의 기본 토큰으로는 조직 프로젝트에 쓸 수 없습니다. `PROJECT_TOKEN`에는 조직의 Projects 읽기·쓰기와 이 저장소의 Issues·Pull requests 읽기 권한이 있어야 합니다.

```sh
gh secret set PROJECT_TOKEN -R team-pitcrew/gachita    # 토큰을 붙여 넣는다
.github/scripts/board.sh sync                           # 보드를 라벨에 다시 맞춘다(자기 gh 토큰에 project 권한 필요)
```

## 지금 상태 (2026-11-14)

- 보드를 만들고 티켓을 모두 올렸습니다. 화면을 칸반으로 바꾸고 프로젝트 자동화 다섯 개를 켰습니다.
- 프로젝트 자동화가 도는 것을 봤습니다: PR #45를 열자 T32 카드가 In review로 옮겨졌습니다.
- `PROJECT_TOKEN`은 2026-11-13 16:39(UTC)에 저장소 비밀 값으로 넣었습니다. 토큰이 있으면 워크플로가 라벨과 함께 보드도 옮깁니다(`tickets.py`). 보드와 라벨이 어긋나 보이면 `board.sh sync`를 돌립니다.
- 보드에 쓰는 코드(`tickets.py`의 `sync_project`)는 로컬 토큰으로 실제 보드에 돌려 확인했습니다. 토큰을 넣은 뒤 워크플로 안에서 보드가 옮겨지는 것은 이 문서를 쓰며 따로 확인하지 않았습니다.
- 상태의 기준은 `status:*` 라벨입니다. 보드와 라벨이 다르면 `board.sh sync`가 라벨 쪽으로 맞춥니다.

## 살펴보는 명령

```sh
gh issue list -R team-pitcrew/gachita --label status:in-progress     # 지금 하고 있는 것
gh issue list -R team-pitcrew/gachita --label part:backend-api       # 파트별
gh issue list -R team-pitcrew/gachita --assignee @me --label P0      # 내 급한 것
.github/scripts/board.sh status T7 ready                              # 비상용: 상태 라벨을 손으로 옮김
.github/scripts/board.sh sync                                         # 보드를 라벨에 다시 맞춤
```
