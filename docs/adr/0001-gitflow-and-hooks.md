# ADR-0001: Gitflow, 작업 번호, 훅으로 지키는 보호 규칙

* **상태:** 채택됨, 2026-11-12 (지환님 요청)
* **관련:** T1

## 배경

지환님이 SOVA 저장소(`Softbank-Hackathon-Finals/platform`)를 참고해 Gitflow와 정책, 칸반, 커밋 훅, CI를 걸어 달라고 했습니다. SOVA는 `feature/T번호-설명 → develop`, `release → main + develop`, `[T번호]` 제목, 필수 검사 통과 뒤 병합 커밋을 씁니다([SOVA ADR-0004](https://github.com/Softbank-Hackathon-Finals/platform/blob/develop/docs/adr/0004-gitflow-task-branches.md)). SOVA 저장소에는 커밋 훅이 없고 GitHub 규칙 세트로 강제합니다.

이 저장소는 무료 조직의 비공개 저장소입니다. 규칙 세트와 브랜치 보호 API가 403을 돌려줍니다("Upgrade to GitHub Pro or make this repository public", 2026-11-12 확인).

## 검토한 선택

- 저장소를 공개로 바꿔 규칙 세트를 씀: 공모전 제출 전에 코드를 공개하게 됨.
- 요금제를 올림: 비용이 생김.
- 규칙을 커밋 훅과 CI로 지킴: 강제력은 약하지만 지금 바로 쓸 수 있음.

## 결정

- SOVA의 브랜치·제목·병합 규칙을 그대로 따릅니다. 승인은 SOVA의 나중 상태처럼 필수가 아닙니다.
- 규칙은 `scripts/policy.sh` 한곳에 두고, 훅(`commit-msg`, `pre-commit`, `pre-push`)과 CI `policy`가 같이 씁니다.
- `pre-push` 훅이 `main`·`develop`으로 직접 올리는 것을 막습니다.

## 결과

훅은 `make hooks`를 한 사람에게만 걸립니다. 훅을 걸지 않은 사람이 `develop`에 직접 올리면 막을 방법이 없고, 그 커밋의 CI 결과로만 알 수 있습니다. 저장소를 공개하거나 요금제가 바뀌면 같은 조건을 규칙 세트로 옮기고 이 문서를 고칩니다.
