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

[같이타 보드](https://github.com/orgs/team-pitcrew/projects/1)는 조직의 비공개 프로젝트이고 이 저장소에 이어져 있습니다. 번호는 저장소 변수 `PROJECT_NUMBER`(1)에 있습니다. Status 열은 Backlog, Ready, In progress, In review, Done입니다.

보드에 쓰려면 프로젝트 권한이 있는 토큰이 필요합니다. Actions의 기본 토큰으로는 조직 프로젝트에 쓸 수 없습니다.

| 누가 쓰나 | 토큰 | 상태 |
|---|---|---|
| 워크플로(`tickets.yml`) | 저장소 비밀 값 `PROJECT_TOKEN` | **아직 없음.** 넣기 전에는 워크플로가 라벨까지만 맞춤 |
| 사람과 에이전트(`board.sh sync`) | 자기 `gh` 토큰. `gh auth refresh -s project,read:project`로 권한을 더함 | 지환의 토큰에 있음 |

`PROJECT_TOKEN`은 지환이 GitHub 설정에서 직접 만듭니다. 세분화 토큰(fine-grained)으로, 소유자는 `team-pitcrew`, 저장소는 `gachita`만, 권한은 저장소의 Issues·Pull requests 읽기와 조직의 Projects 읽기·쓰기만 줍니다.

```sh
gh secret set PROJECT_TOKEN -R team-pitcrew/gachita    # 토큰을 붙여 넣는다
.github/scripts/board.sh sync                           # 그 전까지, 또는 보드가 라벨과 어긋났을 때
```

## 지금 상태 (2026-11-13)

- 보드를 만들고 티켓 31개를 올렸습니다. Status는 `status:*` 라벨과 같게 맞췄습니다.
- 보드에 쓰는 코드(`tickets.py`의 `sync_project`)는 로컬 토큰으로 실제 보드에 돌려 확인했습니다. **워크플로 안에서 도는 것은 `PROJECT_TOKEN`이 없어 아직 보지 못했습니다.**
- 그동안 새 티켓이나 상태 변화는 `board.sh sync`를 돌려야 보드에 나타납니다. 라벨은 워크플로가 그대로 맞춥니다.
- 보드의 기본 화면은 표입니다. 칸반으로 보려면 보드에서 화면의 Layout을 Board로 바꿉니다(API로는 바꿀 수 없음).
- 프로젝트에 딸린 기본 자동화(Item closed, Pull request merged 등)는 꺼져 있습니다. 상태는 우리 워크플로만 옮깁니다.

## 살펴보는 명령

```sh
gh issue list -R team-pitcrew/gachita --label status:in-progress     # 지금 하고 있는 것
gh issue list -R team-pitcrew/gachita --label part:backend-api       # 파트별
gh issue list -R team-pitcrew/gachita --assignee @me --label P0      # 내 급한 것
.github/scripts/board.sh status T7 ready                              # 비상용: 상태 라벨을 손으로 옮김
.github/scripts/board.sh sync                                         # 보드를 라벨에 다시 맞춤
```
