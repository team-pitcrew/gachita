# 개발 규칙

SOVA 저장소(`Softbank-Hackathon-Finals/platform`)의 Gitflow와 작업 추적을 옮기고, 변경을 설명하고 내보내는 방식은 Google의 공개 기준을 따랐습니다. 결정 이유는 [ADR-0001](adr/0001-gitflow-and-hooks.md)과 [ADR-0003](adr/0003-collaboration.md)에 있습니다.

## 처음 한 번

```sh
git clone https://github.com/team-pitcrew/gachita.git && cd gachita
make hooks        # 커밋 훅과 커밋 양식을 건다
make check        # 테스트(로컬 Postgres 컨테이너를 띄운다)
```

## 파트와 담당

작업과 리뷰, CI는 네 파트로 나눕니다. 원본은 [`.github/parts.json`](../.github/parts.json)이고 CODEOWNERS, 이슈 양식, CI 범위, 티켓 담당이 모두 이 파일을 따릅니다.

| 파트 | 다루는 것 | 경로 | 담당 |
|---|---|---|---|
| `frontend-spec` | 프론트 · 피그마 전 단계 | `frontend/spec/` | 상현 |
| `frontend-app` | 프론트 · 피그마 이후 단계 | `frontend/web/`, `frontend/car/` | 지환 |
| `backend-api` | 백엔드 · 비즈니스 로직 | `backend/api/`, `docs/api/` | 상현 |
| `backend-infra` | 백엔드 · 인프라 | `backend/infra/` | 지환 |

- 한 PR은 한 파트만 바꾸는 것을 기본으로 합니다.
- 다른 파트의 코드를 바꿀 때는 먼저 그 파트 담당과 범위를 맞춥니다.
- `.github/`, `.githooks/`, `Makefile`처럼 모두가 쓰는 파일은 지환이 맡습니다.

## 티켓

GitHub 이슈가 티켓입니다. 제목은 `[T번호] 제목`이고, 라벨 셋(`part:*`, `P0`~`P2`, `status:*`)이 붙습니다. Pleos 에뮬레이터에서 확인해야 하는 티켓에는 `env:emulator`가 더 붙습니다.

| 일어난 일 | 자동으로 되는 것 |
|---|---|
| 이슈 양식으로 티켓을 만듦 | 번호(`[T숫자]`), 파트·우선순위 라벨, `status:backlog`, 파트 담당 지정. 에뮬레이터가 필요하면 파트와 관계없이 지환 |
| `feature/T번호-설명` 브랜치를 올림 | 티켓이 `status:in-progress` |
| PR을 엶 | 티켓이 `status:in-review`, PR에 바뀐 파트의 `part:*` 라벨 |
| PR이 병합됨 | 본문에 `Closes #번호`로 이은 티켓은 닫히고 `status:done`. `Refs #번호`로만 이은 티켓은 `status:in-progress`로 남음 |
| PR이 병합 없이 닫힘 | 티켓이 `status:in-progress` |

- 자동화는 [`tickets.yml`](../.github/workflows/tickets.yml)과 [`tickets.py`](../.github/scripts/tickets.py)가 합니다. 라벨과 상태를 손으로 고치지 않습니다.
- 프로젝트 보드도 같은 워크플로가 맞춥니다. 저장소에 비밀 값 `PROJECT_TOKEN`과 변수 `PROJECT_NUMBER`가 있어야 하고, 없으면 라벨까지만 합니다([프로젝트 보드](project-board.md)).
- 계획에 있는 작업은 [`docs/tasks.md`](tasks.md)에 적고 `python3 .github/scripts/tasks.py --apply`로 티켓을 만듭니다.
- 끝낸 할 일의 체크는 병합과 확인 뒤에 사람이 합니다. 체크는 자동으로 하지 않습니다.

이슈 양식은 셋입니다. 칸은 Google SRE가 변경과 장애를 적는 방식에서 가져왔습니다.

| 양식 | 칸 | 근거 |
|---|---|---|
| 작업 | 파트, 우선순위, 필요한 환경, 왜 하는가, 할 일, 하지 않는 것, 설계, 검토한 대안, 서비스 수준, 용량과 비용, 의존성과 장애 동작, 관측, 보안과 개인정보, 완료 기준, 위험과 되돌리기, 선행 작업. 설계부터 보안과 개인정보까지는 선택 | 범위를 미리 긋고(하지 않는 것) 되돌릴 길을 정해 둔 변경이 안전합니다([Launch Checklist](https://sre.google/sre-book/launch-checklist/)). 칸 순서는 구글 설계 문서(배경, 목표와 비목표, 설계, 대안, 교차 관심사: [Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/))를 따르고, 서비스 수준은 [SLO 문서](https://sre.google/workbook/slo-document/)를 줄인 것입니다 |
| 결함 | 파트, 심각도, 확인한 환경, 기대한 동작, 실제 동작, 재현 순서, 영향 범위, 처음 본 때와 알아챈 경로, 증거, 임시 조치, 짐작하는 원인 | 기대·실제·재현을 적고 본 것과 짐작을 나눕니다([Effective Troubleshooting](https://sre.google/sre-book/effective-troubleshooting/)). 원인보다 피해를 멈추는 것이 먼저입니다([Managing Incidents](https://sre.google/sre-book/managing-incidents/)) |
| 사후 검토 | 요약, 영향, 근본 원인, 계기, 감지, 해결, 시간순 기록, 잘된 것, 잘못된 것, 운이 좋았던 것, 후속 조치 | [Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)와 [예시](https://sre.google/sre-book/example-postmortem/) |

결함의 심각도는 우선순위 라벨로 옮겨집니다(S0·S1 → P0, S2 → P1, S3 → P2).

작업 양식의 선택 칸은 서버, 데이터, 모델, 외부 서비스에 닿는 일에 채웁니다. 문서 고치기 같은 작은 일은 비워 둡니다. 출시 점검표의 질문을 우리 크기에 맞춰 줄였습니다.

| 칸 | 묻는 것 | 점검표 항목 |
|---|---|---|
| 설계 | 입력과 출력, 어디서 도는지, API와 저장하는 데이터의 모양, 핵심 판단 규칙 | Architecture |
| 검토한 대안 | 다른 방법과 고르지 않은 이유 | (설계 문서) |
| 서비스 수준 | 무엇을 재고 목표가 얼마인지, 어디서 어떻게 재는지, 지금 값과 근거 | Volume estimates, capacity, and performance |
| 용량과 비용 | 요청 수, 데이터 크기, CPU·메모리·저장소, 한 달 비용, 열 배로 늘면 막히는 곳 | Machines, Growth issues |
| 의존성과 장애 동작 | 기대는 것과, 그것이 느리거나 죽었을 때의 동작 | System reliability and failover, External dependencies |
| 관측 | 로그·지표·알림, 볼 화면이나 명령 | Monitoring and server management |
| 보안과 개인정보 | 다루는 데이터, 동의, 보관과 삭제, 밖으로 나가는 것, 권한 | Security |
| 위험과 되돌리기 | 내보내는 순서와 되돌리는 방법 | Automation and manual tasks, Schedule and rollout planning |

작업 목록(`docs/tasks.md`)에서는 같은 칸을 한 줄로 적습니다: `설계:`, `대안:`, `서비스 수준:`, `용량:`, `의존성:`, `관측:`, `보안:`. 이미 있는 티켓의 본문에 새 칸을 넣으려면 `python3 .github/scripts/tasks.py --apply --refresh`를 돌립니다(체크한 항목이 없는 열린 티켓의 본문을 작업 목록대로 다시 씁니다).

## 한 작업의 순서

**플랜과 스펙 → 구현 → 로컬 E2E → CI → 병합 → 이미지 등록 → 배포**

```sh
gh issue comment <번호> -R team-pitcrew/gachita --body-file plan.md   # 플랜과 스펙: 구현 전에 티켓에 댓글로
make ticket-start T=T7 NAME=car-shell     # develop에서 feature/T7-car-shell을 만들어 올린다
# 구현하고
make check
make e2e                                  # 로컬 E2E: 이미지를 띄워 여행 하나의 흐름을 HTTP로 확인한다
git commit                                # 양식이 뜬다. 제목은 [T7] 무엇을 하는지
make ticket-pr                            # 티켓 제목과 PR 양식으로 PR을 연다
gh pr checks --watch                      # CI: 검사 일곱 개
gh pr merge --merge --match-head-commit <확인한 HEAD>
# 이미지 등록은 develop에 병합되면 CI가 한다. 배포는 아래 '백엔드를 내보내는 법'
```

- **플랜과 스펙**은 코드를 고치기 전에 티켓에 댓글로 남깁니다. 무엇을 어떻게 할지(입력과 출력, 조건, 실패했을 때의 동작)를 짧게 적습니다. 구현하면서 달라지면 PR의 '무엇을, 왜'에 달라진 점을 적습니다.
- **로컬 E2E**는 이미지에 들어가는 것(`backend/api/`, `frontend/web/`)을 바꿨을 때 돌리고, 결과를 PR의 '확인한 것'에 붙입니다. 차량 앱은 에뮬레이터에서 확인합니다(CI에서는 에뮬레이터를 돌리지 못함).
- **배포**는 클러스터가 선 뒤에 합니다(T24).

에이전트는 `.claude/skills/ticket`의 순서를 따릅니다.

## 브랜치

| 브랜치 | 시작점 | PR 대상 | 뜻 |
|---|---|---|---|
| `feature/T번호-설명` | `develop` | `develop` | 작업 하나 |
| `bot/deploy-tag` | `develop`(워크플로가 다시 만듦) | `develop` | dev 이미지 태그 바꾸기(`deploy-tag`, T56). 제목은 `[sync]` |
| `release/vX.Y.Z` | `develop` | `main`, 그다음 `develop` | 확인한 범위를 내보낼 준비 |
| `hotfix/T번호-설명` | `main` | `main`, 그다음 `develop` | 내보낸 판의 급한 수정 |

- `develop`이 기본 브랜치이고 통합 기준입니다. `main`은 내보낸 판입니다. 공모전에 내는 APK와 영상은 `main`의 태그에서 만듭니다.
- 작업은 병합 커밋으로 합쳐 묶음을 남깁니다(스쿼시하지 않음).

## 커밋과 PR 쓰는 법

Google의 [변경 설명 쓰는 법](https://google.github.io/eng-practices/review/developer/cl-descriptions.html)과 [작은 변경](https://google.github.io/eng-practices/review/developer/small-cls.html)을 따릅니다.

- **제목 한 줄:** `[T번호] 무엇을 하는지`. 명령하듯 쓰고, 그 줄만 읽어도 무엇이 바뀌는지 알 수 있어야 합니다. 번호 없는 저장소 설정은 `[setup]`, 자동 동기화는 `[sync]`.
- **본문:** 무엇을 왜 바꿨는지. 코드를 다시 설명하지 않고 내린 판단과 배경을 적습니다.
- **작게:** 한 PR은 한 가지 일만 합니다. 100줄 안팎이 읽기 좋고 1000줄이면 대개 너무 큽니다.
- `git commit`을 치면 [커밋 양식](../.gitmessage)이, PR을 열면 [PR 양식](../.github/pull_request_template.md)이 뜹니다.

PR 양식의 다섯 칸은 Google SRE의 변경 관리에서 가져왔습니다([Release Engineering](https://sre.google/sre-book/release-engineering/), [Launch Checklist](https://sre.google/sre-book/launch-checklist/)).

| 칸 | 묻는 것 |
|---|---|
| 무엇을, 왜 | 바꾼 것과 이유 |
| 확인한 것 | 돌린 명령과 결과. 문서·에뮬레이터·실차를 구분. 확인하지 않은 것 |
| 위험과 영향 범위 | 잘못되면 무엇이 깨지고 누가 영향을 받나 |
| 내보내기와 되돌리기 | 병합 뒤 할 일과, 문제가 생겼을 때 되돌리는 방법 |
| 남은 범위 | 하지 않은 것과 다음 티켓 |

장애나 큰 실수는 이슈 양식 '사후 검토'로 남깁니다. [비난하지 않는 사후 검토](https://sre.google/sre-book/postmortem-culture/) 형식입니다.

## CI 게이트

워크플로는 [`ci.yml`](../.github/workflows/ci.yml) 하나이고 검사는 일곱 개입니다. **일곱 개 모두 항상 결과를 냅니다.** PR과 `develop` 병합에서는 바뀐 파트의 검사만 실제로 돌고, 나머지는 "검사할 것이 없습니다"로 통과합니다. `main`에 올라온 뒤와 수동 실행은 전부 돕니다.

| 검사 | 언제 실제로 도나 | 하는 일 |
|---|---|---|
| `scope` | 항상 | 스크립트 테스트, 바뀐 파트 계산 |
| `policy` | 항상 | PR 제목·브랜치 이름·대상 브랜치·커밋 제목, 비밀 값 검사(gitleaks) |
| `frontend-spec` | `frontend/spec/`이 바뀜 | 화면 문서에 다섯 제목이 있는지, 링크가 깨졌는지 |
| `frontend-app` | `frontend/web/`·`frontend/car/`가 바뀜. 스텝은 바뀐 쪽만 | 웹앱 검사(`frontend/web/`이 바뀜), 차량 앱 빌드와 단위 테스트(`frontend/car/`이 바뀜. 폴더가 생긴 뒤, Gradle 캐시) |
| `backend-api` | `backend/api/`·`docs/api/`가 바뀜 | Postgres에 붙인 API 테스트(명세 대조 포함) |
| `backend-infra` | `backend/infra/`가 바뀜 | Terraform 형식·정합성, 클러스터 선언 스키마 |
| `package` | `backend/api/`·`frontend/web/`·`.dockerignore`가 바뀜 | 이미지를 만들어 띄우고 그 이미지에 대고 E2E([`e2e.mjs`](../.github/scripts/e2e.mjs). 로컬 `make e2e`와 같은 스크립트) |

- `backend/infra/`가 바뀐 PR에서는 [`infra-e2e`](../.github/workflows/infra-e2e.yml)가 따로 돕니다. 필수 검사가 아니고, `backend-infra`가 보지 않는 폴더의 조립·스키마, Terraform `account/`·`persist/` 정합성, Ansible 구문과 로컬 K3s의 물결 E2E([`e2e-local.sh`](../backend/infra/cluster/e2e-local.sh))를 봅니다(T55).
- **모든 잡은 자체 러너에서 돕니다(T65, 11/13부터).** GitHub 호스트 러너가 결제 문제로 잡을 시작하지 않아, 지환님의 Mac에 Lima Linux VM 다섯(`gachita-runner-1..5`)을 두고 VM마다 러너 하나(라벨 `gachita`)를 붙였습니다. VM은 Mac 폴더를 보지 않고 포트를 내보내지 않으며, Mac(`host.lima.internal`)으로는 DNS 말고 새 연결을 열지 못합니다(adb·개발 서버에 닿지 않게). 잡을 시작할 때마다 앞 잡이 남긴 컨테이너와 레지스트리 로그인을 지웁니다. 다시 만들기와 지우기는 [`.github/runner/up.sh`](../.github/runner/up.sh)입니다.
  - **신뢰 범위.** 러너는 상주하고, 잡은 러너와 같은 사용자(비밀번호 없는 sudo)로 돕니다. PR의 코드가 VM에 무언가를 남기면, 뒤에 같은 VM에서 도는 develop 잡(펴기·운영·terraform 적용이 받는 OIDC 역할)과 러너 자격(`~/actions-runner/.credentials`)에 닿을 수 있습니다. 호스트 러너에는 없던 길이고, 처음에는 비공개 저장소의 공동 작업자만 PR을 올린다는 전제로 도입했습니다. 11/14 공개 전환 뒤에는 외부 기여자의 포크 PR 실행에 매번 승인이 필요하도록 `all_external_contributors`를 설정했습니다. 외부 PR의 코드와 워크플로를 검토하기 전에는 실행을 승인하지 않습니다. 결제가 풀리면 호스트 러너로 돌아가거나 러너를 잡 하나마다 새로 등록(`--ephemeral`)하는 쪽으로 바꿉니다.
  - **Mac을 다시 켜면** VM이 저절로 켜지지 않습니다. `limactl start gachita-runner-1` … `-5`(러너는 VM 안의 서비스라 같이 뜹니다). Mac이 잠들면 잡이 대기합니다(최대 24시간).
  - 호스트 러너로 돌아가려면 `runs-on`을 `ubuntu-latest`로 바꿉니다.
- 일곱 개 뒤에 `publish` 잡이 있습니다. 필수 검사가 아니고 PR에서는 건너뜀으로 보입니다. `develop`에 병합된 뒤, 이미지에 들어가는 파일이 바뀌었고 같은 실행의 일곱 개가 모두 통과했으면 ARM64 이미지를 GHCR에 올립니다(아래 '백엔드를 내보내는 법').
- 문서(`.md`)와 협업 설정(양식, 티켓 자동화, 훅)만 바뀌면 `scope`와 `policy`만 실제로 돕니다. 화면 문서(`frontend/spec/`)는 `frontend-spec`이 봅니다.
- 검사 자체를 정하는 파일(`ci.yml`, `scope.py`, `spec_check.py`, `parts.json`, `Makefile`)이 바뀌면 전부 돕니다.
- 11/14 공개 전환 시점에는 브랜치 보호와 ruleset이 설정되어 있지 않습니다. PR 화면에서 일곱 개가 모두 초록색인 것을 보고 병합합니다.
- 실패한 검사를 약하게 고쳐 통과시키지 않습니다.

## 병합 조건

| 대상 | PR | 필수 검사 | 승인 |
|---|---|---|---|
| `develop` | 필요 | 위의 일곱 개 | 필수 아님 |
| `main` | 필요 | 위의 일곱 개 | 필수 아님 |

승인은 필수가 아니지만, 리뷰에서 확인된 결함과 변경 요청은 해결한 뒤 병합합니다. CODEOWNERS에 따라 파트 담당에게 리뷰 알림이 갑니다.

## 백엔드를 내보내는 법

API와 웹앱은 이미지 하나(`ghcr.io/team-pitcrew/gachita-api`)로 묶습니다. 로컬 E2E로 확인하고, `develop`에 병합되면 CI가 이미지를 올리고, 태그를 바꾸는 PR로 내보냅니다.

```sh
make e2e                          # 이미지를 만들어 일회용 Postgres와 띄우고 여행 하나의 흐름을 확인한다
# PR을 병합하면 ci.yml의 publish 잡이 ARM64 이미지를 올린다. 태그는 커밋 SHA 앞 12자이고 실행 요약에 적힌다
make deploy-tag TAG=<올린 태그>   # dev 환경의 태그를 바꾼다
# 이 변경을 backend-infra 티켓의 PR로 올린다. 병합되면 Argo CD가 내보낸다
```

- 올라간 태그 보기: `gh api /orgs/team-pitcrew/packages/container/gachita-api/versions --jq '.[:5][] | {tags: .metadata.container.tags, created_at}'`
- `make push`는 CI를 거치지 않고 로컬에서 올릴 때 씁니다. `make e2e`를 통과해야 올립니다.
- 되돌릴 때는 `make deploy-tag`로 이전 태그를 다시 적어 PR로 올립니다.
- 자동으로: develop에 병합돼 이미지가 올라가면 `deploy-tag` 워크플로가 그 태그로 바꾸는 PR(`bot/deploy-tag`, 제목 `[sync]`)을 엽니다. 되돌릴 때는 Actions → `deploy-tag` → Run workflow에 이전 태그를 넣습니다. 병합은 사람이 하고, 병합 뒤 실제 주소 E2E(`live-e2e`)가 돕니다(T56).
- 클러스터가 선 뒤에는 실제 주소에 대고 같은 E2E를 돕니다: Actions → `live-e2e` → Run workflow(기본 주소 `https://gachita.mangowhois.ai`). 닿지 않으면 첫 단계에서 실패합니다(T54).
- 이미지 저장소는 GHCR입니다. `gachita-api`는 조직의 비공개 패키지이고 이 저장소에 이어져 있습니다. 2026-11-13에 로컬에서 `make push`로 ARM64 이미지를 올려 확인했습니다.

토큰과 권한은 이렇게 씁니다. 따로 만든 토큰은 `gh secret set`으로 저장소 비밀 값에 둡니다.

| 어디서 | 무엇이 필요한가 | 상태 |
|---|---|---|
| 로컬 `make push` | 자기 `gh` 토큰의 `write:packages` | 지환의 토큰에 있음 |
| `publish-api-image` 워크플로(병합 때 `ci.yml`의 `publish` 잡이 부름. 손으로도 돌림) | Actions 기본 토큰(`packages: write`, 그 잡에만). 비밀 값 없음 | 이 워크플로로 올린 기록 있음(11/12, 그때는 push로 돎). 병합 때 올리기는 T47 병합 뒤 확인 |
| 클러스터가 이미지를 받을 때 | `read:packages`만 있는 클래식 토큰을 비밀 값 `GHCR_PULL_TOKEN`으로. `infra-secrets` 워크플로가 SSM으로 옮기고 External Secrets가 `gachita` 네임스페이스의 imagePullSecret으로 만듦([ADR-0012](adr/0012-cluster-build-and-node-size.md)) | 클러스터를 만들 때 필요(T24). 아직 없음 |
| 워크플로가 프로젝트 보드에 쓸 때 | 비밀 값 `PROJECT_TOKEN`([프로젝트 보드](project-board.md)) | 아직 없음 |
| `terraform` 워크플로(PR 계획, develop 수동 적용) | AWS 열쇠 없음. OIDC로 역할을 받음. 저장소 변수 `AWS_PLAN_ROLE_ARN`·`AWS_APPLY_ROLE_ARN`·`TF_STATE_BUCKET`([ADR-0011](adr/0011-aws-credentials-via-oidc.md)) | 역할을 아직 만들지 않음. 그동안은 "역할이 없어 건너뜀" |
- 깨끗한 환경에서 다시 만들어야 할 때만 `publish-api-image` 워크플로를 손으로 돌립니다.
- 클러스터가 아직 없어 '병합되면 내보낸다'는 실제로 본 적이 없습니다(T24).

## 커밋 훅

| 훅 | 하는 일 |
|---|---|
| `commit-msg` | 제목이 `[T번호]`, `[setup]`, `[sync]`로 시작하는지 |
| `pre-commit` | 브랜치 이름, `main`·`develop` 직접 커밋 금지, 올리려는 변경의 비밀 값 검사 |
| `pre-push` | `main`·`develop`으로 직접 올리기 금지, 빠른 검사(`make check-fast`) |

규칙 문장은 `.github/scripts/policy.sh` 한곳에 있고 훅과 CI가 같이 씁니다. `--no-verify`로 훅을 건너뛰지 않습니다.

## 확인 수준을 구분해 적기

문서에 가능하다고 적힌 것, 에뮬레이터에서 본 것, 실차에서 본 것을 섞어 쓰지 않습니다.

## 넣지 않는 것

비밀 값, 팀원 연락처, 단톡방 원문, 민준님 기획서 PDF는 이 저장소에 넣지 않습니다. 클라우드 자원을 만드는 명령(`terraform apply`)은 비용이 생기므로 지환님이 승인한 때에만 실행합니다.
