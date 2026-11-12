#!/bin/sh
# 티켓 하나의 시작과 PR을 규칙대로 만든다. 상태·라벨·보드는 GitHub 워크플로(tickets.yml)가 옮긴다.
#   .github/scripts/ticket.sh start T7 car-shell   # develop에서 feature/T7-car-shell을 만들어 올린다 → 작업 중
#   .github/scripts/ticket.sh pr                   # 지금 브랜치의 티켓으로 PR을 연다 → 리뷰 중
set -eu
REPO=team-pitcrew/gachita
root=$(git rev-parse --show-toplevel)
tab=$(printf '\t')

issue_of() { # T번호 → "이슈번호<TAB>제목"
  gh issue list -R "$REPO" --state all --limit 300 --json number,title \
    --jq "map(select(.title | startswith(\"[$1] \"))) | .[0] | select(.) | \"\(.number)\t\(.title)\""
}

case "${1:-}" in
  start)
    task=${2:?T번호. 예: T7}
    name=${3:?짧은 영문 설명. 예: car-shell}
    branch="feature/$task-$name"
    "$root/.github/scripts/policy.sh" branch "$branch"
    [ -n "$(issue_of "$task")" ] || { echo "[$task] 티켓이 없습니다. 이슈를 먼저 만듭니다." >&2; exit 1; }
    git fetch -q origin
    git switch -c "$branch" origin/develop
    git push -q -u origin "$branch"
    echo "시작: $branch"
    ;;
  pr)
    branch=$(git symbolic-ref --short HEAD)
    task=$(printf '%s' "$branch" | sed -n 's#^[a-z]*/\(T[0-9][0-9]*\)-.*#\1#p')
    [ -n "$task" ] || { echo "브랜치 이름에서 T번호를 찾지 못했습니다: $branch" >&2; exit 1; }
    found=$(issue_of "$task")
    [ -n "$found" ] || { echo "[$task] 티켓이 없습니다" >&2; exit 1; }
    number=${found%%"$tab"*}
    title=${found#*"$tab"}
    case "$branch" in feature/*) base=develop ;; *) base=main ;; esac
    # 양식 맨 아래의 'Closes #'에 티켓 번호를 채운다. 마지막 PR이 아니면 Refs로 고친다.
    body=$(sed "s/^Closes #\$/Closes #$number/" "$root/.github/pull_request_template.md")
    git push -q -u origin "$branch"
    gh pr create -R "$REPO" --base "$base" --head "$branch" --title "$title" --body "$body"
    ;;
  *)
    sed -n '2,4p' "$0" >&2
    exit 2
    ;;
esac
