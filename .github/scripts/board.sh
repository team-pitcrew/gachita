#!/bin/sh
# 비상용. 평소에는 tickets.yml이 상태를 옮긴다(docs/project-board.md).
#   .github/scripts/board.sh status T2 in-progress     # backlog | ready | in-progress | in-review | done
#   .github/scripts/board.sh sync                      # 모든 티켓을 보드에 올리고 Status를 라벨에 맞춘다(토큰에 project 권한 필요)
#   .github/scripts/board.sh setup                     # 프로젝트 보드를 만들고 T번호 이슈를 올린다(한 번만. 2026-11-13에 실행함)
set -eu
REPO=team-pitcrew/gachita
STATES="backlog ready in-progress in-review done"

case "${1:-}" in
  status)
    task=${2:?T번호}
    state=${3:?상태}
    echo " $STATES " | grep -q " $state " || { echo "상태는 다음 중 하나: $STATES" >&2; exit 1; }
    # 검색(--search)은 방금 만든 이슈를 늦게 보여 준다. 목록을 받아 제목으로 고른다.
    number=$(gh issue list -R "$REPO" --state all --limit 200 --json number,title \
      --jq "map(select(.title | startswith(\"[$task] \"))) | .[0].number // empty")
    [ -n "$number" ] || { echo "[$task] 로 시작하는 이슈가 없습니다" >&2; exit 1; }
    for s in $STATES; do
      [ "$s" = "$state" ] || gh issue edit "$number" -R "$REPO" --remove-label "status:$s" >/dev/null 2>&1 || true
    done
    gh issue edit "$number" -R "$REPO" --add-label "status:$state" >/dev/null
    echo "#$number [$task] → $state"
    ;;
  setup)
    gh project list --owner team-pitcrew >/dev/null || { echo "먼저: gh auth refresh -s project,read:project" >&2; exit 1; }
    url=$(gh project create --owner team-pitcrew --title "같이타" --format json --jq .url)
    num=${url##*/}
    gh project link "$num" --owner team-pitcrew --repo "$REPO"
    gh issue list -R "$REPO" --state all --limit 200 --json url,title --jq '.[] | select(.title | test("^\\[T[0-9]+\\] ")) | .url' |
      while IFS= read -r issue; do gh project item-add "$num" --owner team-pitcrew --url "$issue" >/dev/null; done
    gh variable set PROJECT_NUMBER -R "$REPO" --body "$num"
    echo "보드: $url"
    echo "상태 열(Backlog · Ready · In progress · In review · Done)은 보드 설정의 Status 필드에서 맞춥니다."
    ;;
  sync)
    # 워크플로에 PROJECT_TOKEN이 없거나 보드가 라벨과 어긋났을 때 쓴다. 여러 번 돌려도 결과가 같다.
    PROJECT_TOKEN=$(gh auth token) PROJECT_NUMBER=$(gh variable get PROJECT_NUMBER -R "$REPO") \
      python3 - "$(dirname "$0")" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import tickets

cards = [i for i in tickets.list_issues() if tickets.t_number(i["title"])]
for i in cards:
    tickets.sync_project(i["id"], "done" if i["state"] != "OPEN" else tickets.status_of(i["labels"]) or "backlog")
print(f"보드에 맞춘 티켓: {len(cards)}개")
PY
    ;;
  *)
    sed -n '2,5p' "$0" >&2
    exit 2
    ;;
esac
