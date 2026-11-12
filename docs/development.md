# 개발 규칙: Gitflow와 작업 번호

SOVA 저장소(`Softbank-Hackathon-Finals/platform`)의 규칙을 이 저장소 크기에 맞게 옮겼습니다. 결정 이유는 [ADR-0001](adr/0001-gitflow-and-hooks.md)에 있습니다.

## 처음 한 번

```sh
git clone https://github.com/team-pitcrew/gachita.git && cd gachita
make hooks        # 커밋 훅을 건다
make check        # CI와 같은 검사
```

`make hooks`를 하지 않으면 아래 규칙이 내 컴퓨터에서 검사되지 않습니다. CI는 같은 규칙을 다시 검사합니다.

## 브랜치

| 브랜치 | 시작점 | PR 대상 | 뜻 |
|---|---|---|---|
| `feature/T번호-설명` | `develop` | `develop` | 작업 하나 |
| `release/vX.Y.Z` | `develop` | `main`, 그다음 `develop` | 확인한 범위를 내보낼 준비 |
| `hotfix/T번호-설명` | `main` | `main`, 그다음 `develop` | 내보낸 판의 급한 수정 |
| `bot/sync-tasks` | `develop` | `develop` | 작업 목록 동기화(아직 쓰지 않음) |

- `develop`이 기본 브랜치이고 통합 기준입니다. `main`은 내보낸 판입니다. 공모전에 내는 APK와 영상은 `main`의 태그에서 만듭니다.
- 설명은 영문 소문자와 숫자, 하이픈으로 씁니다. 예: `feature/T2-device-profile`.
- 작업은 병합 커밋으로 합쳐 묶음을 남깁니다(스쿼시하지 않음).

## 커밋과 PR 제목

제목은 `[T번호] 설명`으로 시작합니다. 작업 번호가 없는 저장소 설정은 `[setup]`, 자동 동기화는 `[sync]`를 씁니다.

```
[T2] 프로필 발급 API 추가
[setup] CI에 차량 앱 빌드 추가
```

PR 본문에는 `Refs #이슈번호`를, 그 작업의 마지막 PR이면 `Closes #이슈번호`를 적습니다. 본문은 문제, 바뀐 동작, 확인한 것, 남은 범위 순서로 씁니다.

## 병합 조건

| 대상 | PR | 필수 검사 | 승인 |
|---|---|---|---|
| `develop` | 필요 | `policy`, `web`, `api`. `backend/infra/`가 바뀌면 `infra`도(차량 앱이 생기면 `car` 추가) | 필수 아님 |
| `main` | 필요 | 위와 같음 | 필수 아님 |

- 검사가 모두 통과한 뒤 병합합니다. 실패한 검사를 약하게 고쳐 통과시키지 않습니다.
- 승인은 필수가 아니지만, 리뷰에서 확인된 결함과 변경 요청은 해결한 뒤 병합합니다.
- 다른 사람이 맡은 작업의 코드를 바꿀 때는 먼저 그 사람과 범위를 맞춥니다.

**이 조건은 GitHub가 강제하지 않습니다.** 무료 조직의 비공개 저장소에는 브랜치 보호와 규칙 세트를 걸 수 없습니다(2026-11-12 API로 확인, 403). 그래서 커밋 훅과 CI로 지킵니다. 저장소를 공개로 바꾸거나 요금제를 올리면 같은 조건을 규칙 세트로 옮깁니다.

## 커밋 훅

| 훅 | 하는 일 |
|---|---|
| `commit-msg` | 제목이 `[T번호]`, `[setup]`, `[sync]`로 시작하는지 |
| `pre-commit` | 브랜치 이름, `main`·`develop` 직접 커밋 금지, 올리려는 변경의 비밀 값 검사(gitleaks) |
| `pre-push` | `main`·`develop`으로 직접 올리기 금지, 빠른 검사(`make check-fast`) |

규칙 문장은 `.github/scripts/policy.sh` 한곳에 있고 훅과 CI가 같이 씁니다. `--no-verify`로 훅을 건너뛰지 않습니다.

## 한 작업의 순서

```sh
git fetch origin
git switch -c feature/T2-device-profile origin/develop
# 구현하고 make check
git push -u origin feature/T2-device-profile
gh pr create --base develop --title '[T2] 프로필 발급 API 추가' --body-file pr.md
gh pr checks --watch
gh pr merge --merge --match-head-commit <확인한 HEAD>
```

끝낸 할 일은 PR이 병합되고 확인한 뒤 이슈에서 체크합니다. 칸반 쓰는 법은 [프로젝트 보드](project-board.md)에 있습니다.

## 확인 수준을 구분해 적기

문서에 가능하다고 적힌 것, 에뮬레이터에서 본 것, 실차에서 본 것을 섞어 쓰지 않습니다. PR의 '확인한 것'과 문서에 어느 수준인지 적습니다.

## 넣지 않는 것

비밀 값, 팀원 연락처, 단톡방 원문, 민준님 기획서 PDF는 이 저장소에 넣지 않습니다. 클라우드 자원을 만드는 명령(`terraform apply`)은 비용이 생기므로 지환님이 승인한 때에만 실행합니다.
