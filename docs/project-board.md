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

## 보드가 켜지려면 (한 번, 사람이 직접)

보드에 쓰려면 프로젝트 권한이 있는 토큰이 필요합니다. Actions의 기본 토큰으로는 조직 프로젝트에 쓸 수 없습니다.

```sh
# 1. 내 gh 토큰에 프로젝트 권한 추가(브라우저 인증)
gh auth refresh -s project,read:project

# 2. 보드를 만들고 저장소에 잇고 번호를 저장소 변수에 넣는다
.github/scripts/board.sh setup

# 3. 조직 프로젝트 읽기·쓰기만 되는 세분화 토큰을 만들어 비밀 값으로 넣는다
gh secret set PROJECT_TOKEN -R team-pitcrew/gachita
```

보드의 Status 열 이름은 Backlog, Ready, In progress, In review, Done이어야 합니다. 2번이 끝나면 보드 설정에서 한 번 맞춥니다.

## 지금 상태 (2026-11-12)

- 라벨로 도는 자동화는 들어 있습니다. `develop`에 병합된 뒤부터 돕니다.
- **보드는 아직 없습니다.** 위 1~3이 되지 않았습니다. 그동안은 `status:*` 라벨이 같은 다섯 상태를 가리킵니다.
- 보드에 쓰는 부분(`tickets.py`의 `sync_project`)은 권한이 없어 한 번도 실행해 보지 못했습니다. 보드를 켠 뒤 처음 도는 것을 확인해야 합니다.

## 살펴보는 명령

```sh
gh issue list -R team-pitcrew/gachita --label status:in-progress     # 지금 하고 있는 것
gh issue list -R team-pitcrew/gachita --label part:backend-api       # 파트별
gh issue list -R team-pitcrew/gachita --assignee @me --label P0      # 내 급한 것
.github/scripts/board.sh status T7 ready                              # 비상용: 상태 라벨을 손으로 옮김
```
