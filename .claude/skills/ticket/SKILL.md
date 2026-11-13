---
name: ticket
description: 가치타 저장소에서 티켓(GitHub 이슈) 하나를 규칙대로 진행합니다. 브랜치 만들기, 커밋, PR 열기까지의 순서와 명령을 담았습니다. "T7 시작해", "이 작업 PR 올려", "티켓 만들어"에 씁니다.
---

# 티켓 하나를 끝까지

이 저장소는 GitHub 이슈를 티켓으로 씁니다. 상태(Backlog → In progress → In review → Done), 파트 라벨, 담당, 프로젝트 보드는 `.github/workflows/tickets.yml`이 자동으로 옮깁니다. **손으로 라벨이나 보드를 고치지 않습니다.** 규칙의 원문은 `docs/development.md`입니다.

## 순서

플랜과 스펙 → 구현 → 로컬 E2E → CI → 병합 → 이미지 등록 → 배포.

1. **티켓 고르기.** `gh issue list -R team-pitcrew/gachita --assignee @me --label status:backlog`. 선행 작업이 끝났는지 본문에서 확인합니다.
2. **플랜과 스펙.** 코드를 고치기 전에 무엇을 어떻게 할지(입력과 출력, 조건, 실패했을 때의 동작)를 짧게 정해 티켓에 댓글로 남깁니다. `gh issue comment <번호> -R team-pitcrew/gachita --body-file plan.md`. 구현하면서 달라지면 PR의 '무엇을, 왜'에 적습니다.
3. **시작.** `make ticket-start T=T7 NAME=car-shell`. `develop`에서 `feature/T7-car-shell`을 만들어 올립니다. 브랜치가 올라가면 티켓이 In progress가 됩니다.
4. **구현.** 한 PR은 한 파트만 바꿉니다. 파트와 경로는 `.github/parts.json`에 있습니다.
5. **검사와 로컬 E2E.** `make check`. 이미지에 들어가는 것(`backend/api`, `frontend/web`)을 바꿨으면 `make e2e`로 이미지를 띄워 여행 하나의 흐름을 확인하고, 결과를 PR의 '확인한 것'에 붙입니다.
6. **커밋.** 제목은 `[T7] 무엇을 하는지`. `git commit`만 치면 양식(`.gitmessage`)이 뜹니다. 훅이 제목과 비밀 값을 봅니다.
7. **PR과 CI.** `make ticket-pr`. 제목은 티켓 제목으로, 본문은 양식으로 채워지고 `Closes #번호`가 들어갑니다. 양식의 다섯 칸을 채웁니다. PR이 열리면 티켓이 In review가 됩니다. `gh pr checks --watch`로 필수 검사 일곱 개를 봅니다.
8. **병합.** 일곱 개가 모두 통과한 것을 본 뒤 병합 커밋으로 합칩니다. 병합되면 티켓이 닫히고 Done이 됩니다.
9. **이미지 등록.** 이미지에 들어가는 파일이 바뀌었으면 `develop`의 CI 실행에서 `publish` 잡이 ARM64 이미지를 GHCR에 올립니다(자동). 실행 요약에 태그가 적힙니다.
10. **배포.** 아래 '백엔드를 내보낼 때'. 클러스터가 선 뒤에 합니다(T24).
11. **할 일 체크.** 병합과 확인 뒤에 이슈의 체크 상자를 체크합니다. 다른 사람의 체크는 대신 하지 않습니다.

## 새 티켓 만들기

- 계획에 넣을 작업: `docs/tasks.md`에 `### T번호 제목 (P1) · 파트` 형식으로 추가해 PR로 올리고, 병합 뒤 `python3 .github/scripts/tasks.py --apply`.
- 바로 필요한 작업이나 결함: GitHub의 이슈 양식(작업, 결함, 사후 검토)으로 만듭니다. 번호와 라벨, 담당은 자동으로 붙습니다.

## 백엔드를 내보낼 때

1. `develop` 병합 뒤 CI의 `publish` 잡이 올린 태그(커밋 SHA 앞 12자)를 실행 요약에서 확인합니다. CI를 거치지 않고 올려야 하면 `make push`(E2E를 통과한 뒤 올림).
2. `make deploy-tag TAG=<올린 태그>`로 dev 환경의 태그를 바꾸고, 그 변경을 PR로 올립니다(파트는 backend-infra). 병합되면 Argo CD가 내보냅니다.

## 하지 않는 것

- `main`·`develop`에 직접 커밋하거나 올리지 않습니다. `--no-verify`를 쓰지 않습니다.
- 다른 파트의 코드를 바꿀 때는 그 파트 담당과 먼저 범위를 맞춥니다.
- `terraform apply`처럼 비용이 생기는 명령은 승인 없이 실행하지 않습니다.
- 확인하지 않은 것을 확인했다고 적지 않습니다. 문서·에뮬레이터·실차를 구분합니다.
