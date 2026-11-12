# ADR-0010: AWS 자격 증명은 OIDC로 받는다

* **상태:** 제안, 2026-11-13
* **관련:** T25, #31, T24(#30), T26(#32)

## 배경

인프라 자격 증명은 OIDC로 관리하기로 했다(지환, 11/12). 저장소와 서버에 오래 쓰는 AWS 열쇠(액세스 키)를 두지 않는다. AWS를 부르는 주체는 셋이다.

| 주체 | 하는 일 |
|---|---|
| GitHub Actions | PR에서 `terraform plan`, develop에서 `terraform apply`, GitHub 비밀 값을 SSM에 넣기 |
| 서버(EC2) | SSM 세션 받기, 첫 부팅 때 배포 키 읽기 |
| 파드 | 외부 비밀 값 읽기(External Secrets), Postgres 백업을 S3에 쓰기(CloudNativePG) |

## 검토한 선택

**GitHub Actions의 역할을 하나로 둘지 둘로 나눌지.**

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| 역할 하나(PR과 develop 모두) | 설정이 짧음 | PR 브랜치의 워크플로 코드가 적용 권한으로 돎. 병합 전 코드가 자원을 지우거나 비밀 값을 읽을 수 있음 |
| **둘: 계획(PR)·적용(develop)** | PR 코드는 읽기만. 적용은 병합된 코드만 | 역할과 정책이 둘 |

**파드가 AWS 권한을 받는 방법.**

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| 서버의 인스턴스 역할을 파드가 같이 씀(지금 선언, IMDS 홉 2) | 설정 없음 | 모든 파드가 같은 권한. 여행 DB가 프로필 DB 백업과 비밀 값을 읽을 수 있어 네임스페이스 격리(T26)가 IAM에서 무너짐 |
| 파드에 액세스 키 | 단순 | 오래 쓰는 열쇠. 방침과 어긋남 |
| EKS Pod Identity | AWS가 관리 | EKS 전용. 우리는 K3s |
| **서비스 계정 OIDC(IRSA 방식, 발급자를 직접 공개)** | 서비스 계정마다 역할. 열쇠 없음. CloudNativePG·External Secrets 문서가 그대로 맞음 | K3s의 서비스 계정 발급자를 공개 주소에 올리고, 토큰을 파드에 넣는 웹훅이 하나 더 필요 |

## 결정

**GitHub Actions**

- GitHub OIDC 제공자 하나와 역할 둘을 `backend/infra/terraform/account/`에 둔다. 신뢰 조건은 `aud = sts.amazonaws.com`이고 `sub`를 정확히 맞춘다(와일드카드 없음).
  - `gachita-github-plan`: `repo:team-pitcrew/gachita:pull_request`. AWS 관리 정책 `ReadOnlyAccess`에서 상태 파일 밖의 S3 객체 읽기, 사람이 넣은 비밀 값(`/gachita/*/app/*`, `/gachita/*/bootstrap/*`) 읽기, 복호화를 명시적으로 막는다. 상태는 잠그지 않고 읽기만 한다(`-lock=false`).
  - `gachita-github-apply`: `repo:team-pitcrew/gachita:ref:refs/heads/develop`. 본 설정이 만드는 서비스(EC2·VPC, S3 `gachita-*`, CloudFront, SSM `/gachita/*`, IAM `gachita-*`)만 허용하고, 사람이 넣은 비밀 값은 쓰기만 된다.
- 적용 역할이 만드는 IAM 역할에는 권한 경계 `gachita-workload-boundary`를 반드시 붙여야 한다(`iam:PermissionsBoundary` 조건). 그래서 적용 역할이 자기보다 넓은 역할을 만들어 우회할 수 없다. 적용 역할은 `gachita-github-*` 역할, 경계 정책, GitHub OIDC 제공자를 고치지 못한다. 이것들은 사람이 로컬 자격으로만 적용한다.
- 적용은 develop의 수동 실행(`workflow_dispatch`)으로만 한다. 병합으로 저절로 적용하지 않는다. 비용이 생기는 명령은 지환님이 승인한 때에만 실행한다는 방침 때문이다. 무료 조직의 비공개 저장소라 GitHub 환경의 승인자 기능을 쓸 수 없어 이렇게 막는다.
- 역할 ARN과 상태 버킷 이름은 비밀 값이 아니므로 저장소 변수(`AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN`, `TF_STATE_BUCKET`)에 둔다. 변수가 비어 있으면 워크플로는 "역할이 없어 건너뜀"으로 성공한다.

**파드**

- K3s API 서버의 서비스 계정 발급자(`service-account-issuer`)를 CloudFront 주소(`https://<배포>.cloudfront.net/k8s`)로 바꾸고, 발견 문서와 공개 키(JWKS)를 S3에 올린다. 버킷은 공개하지 않고 CloudFront 원본 접근 제어(OAC)로만 읽힌다. 이 경로는 캐시하지 않는다(서버를 새로 만들면 키가 바뀜).
- IAM에 이 발급자를 OIDC 제공자로 등록하고, 서비스 계정마다 역할을 둔다. 신뢰 조건은 `sub = system:serviceaccount:<네임스페이스>:<이름>`.

  | 서비스 계정 | 역할 | 권한 |
  |---|---|---|
  | `external-secrets/ssm-reader` | `gachita-dev-ssm-reader` | `/gachita/dev/app/*`, `/gachita/dev/tf/*` 읽기 |
  | `gachita-trips/trips` | `gachita-dev-pg-trips` | 데이터 버킷의 `postgres/trips/` 읽기·쓰기 |
  | `gachita-profiles/profiles` | `gachita-dev-pg-profiles` | 데이터 버킷의 `postgres/profiles/` 읽기·쓰기 |

- 토큰은 AWS의 공개 웹훅([amazon-eks-pod-identity-webhook](https://github.com/aws/amazon-eks-pod-identity-webhook))이 서비스 계정 주석(`eks.amazonaws.com/role-arn`)을 보고 파드에 넣는다. EKS가 아니어도 쓰도록 만든 것이고, cert-manager가 웹훅 인증서를 만든다. External Secrets는 웹훅 없이 같은 주석을 읽어 스스로 토큰을 받는다.
- 서버의 IMDS 홉 제한을 1로 내린다. 파드는 인스턴스 역할에 닿지 못한다. 인스턴스 역할은 SSM 세션, 배포 키 읽기, 발급자 공개 키 올리기만 한다.
- 구현은 클러스터 쪽 자원과 함께 T24에서 한다(발급자 주소가 CloudFront를 만든 뒤에 정해짐).

**남는 고정 비밀 값(예외)**

AWS 열쇠는 없다. 아래는 AWS가 아닌 곳의 자격이라 OIDC로 바꿀 수 없어 예외로 둔다. 모두 `gh secret set`으로 저장소 비밀 값에 넣고, 워크플로가 적용 역할로 SSM에 옮긴다(T24).

| 값 | 왜 남나 |
|---|---|
| 이미지 받기 토큰(`read:packages`) | GHCR 비공개 패키지는 개인 접근 토큰으로만 받는다 |
| Argo CD 배포 키(읽기 전용 SSH) | 비공개 저장소를 읽는 자격. Argo CD가 올라오기 전에 필요 |
| 구글 OAuth 클라이언트 비밀 값 | 구글이 발급하는 값 |
| Cloudflare API 토큰 | Terraform이 터널과 DNS를 만들 때 |

## 결과

- 적용 순서가 생긴다: 상태 버킷(CLI) → `account/`(로컬 자격) → 저장소 변수 → 이후 계획·적용은 GitHub Actions. 순서는 `backend/infra/terraform/README.md`의 '처음 한 번'.
- 로컬 IAM 사용자(`mango_sesacthon`)의 열쇠는 처음 한 번과 `account/` 변경에만 쓴다. 이 열쇠는 저장소와 서버에 두지 않는다.
- 계획 역할은 상태 파일을 읽는다. 상태에는 Terraform이 만든 값(Cloudflare 터널 토큰)이 들어 있으므로, PR을 열 수 있는 사람은 그 값을 볼 수 있다. 팀 4명이 저장소 쓰기 권한을 가진 지금은 같은 신뢰 범위로 본다. 외부 기여자를 받게 되면 계획을 PR 라벨로 승인한 뒤에만 돌린다.
- 확인한 것: `terraform validate`(account). 실제 계정에 만들지 않았고, 역할을 받아 계획을 돌린 적도 없다.
