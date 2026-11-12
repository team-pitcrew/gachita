#!/bin/sh
# 작업 상태를 적는다. 보드가 생기기 전에는 이슈 라벨 status:* 로 적는다(docs/project-board.md).
#   scripts/board.sh status T2 in-progress     # backlog | ready | in-progress | in-review | done
#   scripts/board.sh setup                     # 프로젝트 보드를 만들고 T번호 이슈를 올린다(토큰에 project 권한 필요)
set -eu
REPO=team-pitcrew/gachita
STATES="backlog ready in-progress in-review done"

case "${1:-}" in
  status)
    task=${2:?T번호}
    state=${3:?상태}
    echo " $STATES " | grep -q " $state " || { echo "상태는 다음 중 하나: $STATES" >&2; exit 1; }
    number=$(gh issue list -R "$REPO" --state all --search "in:title \"[$task]\"" --json number,title \
      --jq "map(select(.title | startswith(\"[$task] \"))) | .[0].number // empty")
    [ -n "$number" ] || { echo "[$task] 로 시작하는 이슈가 없습니다" >&2; exit 1; }
    for s in $STATES; do
      [ "$s" = "$state" ] || gh issue edit "$number" -R "$REPO" --remove-label "status:$s" >/dev/null 2>&1 || true
    done
    gh issue edit "$number" -R "$REPO" --add-label "status:$state" >/dev/null
    echo "#$number [$task] → $state"
    ;;
  setup)
    # ponytail: 토큰 권한이 없어 2026-11-12에는 실행해 보지 못했다. 권한을 받은 뒤 처음 돌릴 때 결과를 확인한다.
    gh project list --owner team-pitcrew >/dev/null || { echo "먼저: gh auth refresh -s project,read:project" >&2; exit 1; }
    url=$(gh project create --owner team-pitcrew --title "같이타" --format json --jq .url)
    num=${url##*/}
    gh project link "$num" --owner team-pitcrew --repo "$REPO"
    gh issue list -R "$REPO" --state all --limit 100 --json url,title --jq '.[] | select(.title | test("^\\[T[0-9]+\\] ")) | .url' |
      while IFS= read -r issue; do gh project item-add "$num" --owner team-pitcrew --url "$issue" >/dev/null; done
    echo "보드: $url"
    echo "상태 열(Backlog · Ready · In progress · In review · Done)은 보드 설정의 Status 필드에서 맞춥니다."
    ;;
  *)
    sed -n '2,4p' "$0" >&2
    exit 2
    ;;
esac
