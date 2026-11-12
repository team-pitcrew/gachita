#!/bin/sh
# 저장소 규칙을 한곳에서 검사한다. 커밋 훅과 CI가 같은 스크립트를 쓴다.
#   .github/scripts/policy.sh title  "<커밋 또는 PR 제목>"
#   .github/scripts/policy.sh branch "<브랜치 이름>"
#   .github/scripts/policy.sh target "<브랜치 이름>" "<PR 대상 브랜치>"
# 규칙은 docs/development.md에 있다.
set -eu

kind=${1:?title 또는 branch}
value=${2:?검사할 값}

case "$kind" in
  title)
    # 병합·되돌리기·fixup 커밋은 git이 만든 제목을 그대로 둔다
    if printf '%s' "$value" | grep -Eq '^(Merge |Revert |fixup! |squash! )'; then exit 0; fi
    if printf '%s' "$value" | grep -Eq '^\[(T[0-9]+|setup|sync)\] .+'; then exit 0; fi
    echo "제목은 [T번호], [setup], [sync] 중 하나로 시작합니다. 예: [T3] 프로필 발급 API 추가" >&2
    echo "받은 제목: $value" >&2
    exit 1
    ;;
  branch)
    if printf '%s' "$value" | grep -Eq '^(main|develop|bot/sync-tasks)$'; then exit 0; fi
    if printf '%s' "$value" | grep -Eq '^(feature|hotfix)/T[0-9]+-[a-z0-9][a-z0-9-]*$'; then exit 0; fi
    if printf '%s' "$value" | grep -Eq '^release/v[0-9]+\.[0-9]+\.[0-9]+$'; then exit 0; fi
    echo "브랜치 이름은 feature/T번호-설명, hotfix/T번호-설명, release/vX.Y.Z 중 하나입니다. 예: feature/T3-device-profile" >&2
    echo "받은 이름: $value" >&2
    exit 1
    ;;
  target)
    # gitflow: 어느 브랜치가 어디로 들어갈 수 있는가
    base=${3:?PR 대상 브랜치}
    case "$value" in
      feature/* | bot/sync-tasks) ok=develop ;;
      release/* | hotfix/*) ok="main develop" ;;
      *) ok="" ;;
    esac
    for b in $ok; do [ "$b" = "$base" ] && exit 0; done
    echo "$value 는 $base 로 PR을 열 수 없습니다. feature는 develop으로, release와 hotfix는 main과 develop으로 엽니다." >&2
    exit 1
    ;;
  *)
    echo "알 수 없는 검사: $kind" >&2
    exit 2
    ;;
esac
