# ADR-0011: AWS 자격 증명은 OIDC로 받는다

* **상태:** 일부 채택, 2026-11-13
  * 채택(지환, 11/12~13): 인프라 자격 증명은 OIDC로, 오래 쓰는 AWS 열쇠를 저장소와 서버에 두지 않음, 다른 프로젝트와 같이 쓰는 지금 계정에 만듦.
  * 제안(승인 전): 역할 구조(계획·적용, 권한 경계, 태그·이름으로 좁히기)와 서비스 계정 OIDC의 세부, `account/`를 실제로 적용하는 것, Cloudflare 토큰의 범위.
* **관련:** T25, #31, T24(#30), T26(#32), T27, ADR-0010

## 배경

인프라 자격 증명은 OIDC로 관리하기로 했다(지환, 11/12). 저장소와 서버에 오래 쓰는 AWS 열쇠(액세스 키)를 두지 않는다. AWS를 부르는 주체는 셋이다.

| 주체 | 하는 일 |
|---|---|
| GitHub Actions | PR에서 `terraform plan`, develop에서 `terraform apply`, GitHub 비밀 값을 SSM에 넣기 |
| 서버(EC2) | SSM 세션 받기, 첫 부팅 때 배포 키 읽기, 서비스 계정 발급자의 공개 키 올리기 |
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

- 역할 둘을 `backend/infra/terraform/account/`에 둔다. 신뢰 조건은 `aud = sts.amazonaws.com`이고 `sub`를 정확히 맞춘다(와일드카드 없음).
- `sub`는 GitHub의 **불변 형식**(`repo:OWNER@OWNER-ID/REPO@REPO-ID:…`)이다. 이 저장소는 그 형식이 기본으로 켜져 있다(`gh api repos/team-pitcrew/gachita/actions/oidc/customization/sub` → `use_immutable_subject: true`, 접두사 `repo:team-pitcrew@351326633/gachita@1455271774`, 11/13 확인). 이름만 쓰는 옛 형식으로는 역할을 받지 못한다.
- GitHub OIDC 제공자(`token.actions.githubusercontent.com`)는 이 계정에 **이미 있다**. 다른 프로젝트(railshot)의 Terraform이 관리하고 그 역할들이 믿는다. 그래서 만들지 않고 `data`로 읽기만 하며, 우리 쪽 destroy가 그것을 지우지 않는다. 적용 역할은 그 제공자를 고치지 못한다.
  - `gachita-github-plan`: `repo:team-pitcrew@351326633/gachita@1455271774:pull_request`. 계정 전체 읽기(AWS 관리 정책 `ReadOnlyAccess`)는 같이 쓰는 계정의 다른 프로젝트 SSM 값·로그·DB 내용까지 읽을 수 있어 쓰지 않는다. Terraform이 우리 자원을 다시 읽는 데 필요한 것만 준다: EC2 설정 읽기(리전), IAM 설정 읽기, `gachita-*` 버킷의 설정과 상태 파일, SSM은 `/gachita/*/tf/*`와 공개 AMI 번호. 그 위에 상태 밖 S3 객체, 사람이 넣은 비밀 값(`/gachita/*/app/*`, `/gachita/*/bootstrap/*`)의 읽기와 복호화를 명시적으로 막는다. 복호화 거부는 그 경로(KMS 암호화 문맥 `PARAMETER_ARN`)로만 건다. Terraform이 쓴 SecureString(`/tf/`)은 계획의 refresh가 읽어야 하고, 같은 값이 상태 파일에도 있어 막아도 지키는 것이 없다. 상태는 잠그지 않고 읽기만 한다(`-lock=false`).
  - `gachita-github-apply`: `repo:team-pitcrew@351326633/gachita@1455271774:ref:refs/heads/develop`. 본 설정이 만드는 서비스(EC2·VPC, S3 `gachita-*`, SSM `/gachita/*`, IAM `gachita-*`, 우리 서비스 계정 발급자 하나)만 허용한다. CloudFront와 ALB는 만들지 않으므로(ADR-0010) 권한도 주지 않는다.
  - **이 계정은 다른 프로젝트(railshot, bravo 등)와 같이 쓴다.** 그쪽 EC2·VPC·EKS와 EKS의 OIDC 제공자가 있다. 그래서 EC2는 **우리 태그(`Project=gachita`, provider의 `default_tags`)가 붙은 자원만** 만들고 고치고 지운다: 만들 때는 `aws:RequestTag/Project`, 그 뒤에는 `aws:ResourceTag/Project`가 `gachita`여야 한다. IAM 역할·인스턴스 프로필·서비스 계정 발급자도 이름(`gachita-*`)과 태그가 둘 다 맞아야 고치고 지울 수 있다. 읽기(`Describe*`)만 자원 단위로 좁힐 수 없어 리전으로 좁힌다. 다른 프로젝트 자원에는 `Project` 태그가 없는 것도 많아(11/13 확인: VPC 5, 인스턴스 9, 보안 그룹 18) '남의 태그면 거부'로는 막을 수 없어 허용 쪽을 좁혔다. OIDC 제공자 권한도 우리 발급자 주소 하나(`gachita-*-oidc-<계정>.s3.<리전>.amazonaws.com`)로 좁혔다. 계정을 따로 쓸지는 지환님께 묻는 중이다.
  - 사람이 넣은 비밀 값은 적용 역할이 **직접** 읽지 못한다(읽기·복호화 명시적 거부, 쓰기만 됨). 다만 적용 역할은 경계 안의 역할(서버·파드)을 만들 수 있고 그 역할은 비밀 값을 읽을 수 있다. 그래서 비밀 값의 신뢰 범위는 '적용 역할을 받는 코드', 곧 develop에 병합할 수 있는 사람과 같다.
- 적용 역할이 만드는 IAM 역할에는 권한 경계 `gachita-workload-boundary`를 반드시 붙여야 한다(`iam:PermissionsBoundary` 조건). 그래서 적용 역할이 자기보다 넓은 역할을 만들어 우회할 수 없다. 적용 역할은 `gachita-github-*` 역할, 경계 정책, GitHub OIDC 제공자를 고치지 못한다. 경계에는 SSM을 거친 복호화(`kms:Decrypt`, `kms:ViaService = ssm.<리전>.amazonaws.com`)를 넣어, 서버의 배포 키 읽기와 External Secrets가 경계에 막히지 않게 한다. 이것들은 사람이 로컬 자격으로만 적용한다.
- 적용은 develop의 수동 실행(`workflow_dispatch`)으로만 한다. 병합으로 저절로 적용하지 않는다. 비용이 생기는 명령은 지환님이 승인한 때에만 실행한다는 방침 때문이다. 무료 조직의 비공개 저장소라 GitHub 환경의 승인자 기능을 쓸 수 없어 이렇게 막는다.
- 역할 ARN과 상태 버킷 이름은 비밀 값이 아니므로 저장소 변수(`AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN`, `TF_STATE_BUCKET`)에 둔다. 변수가 비어 있으면 워크플로는 "역할이 없어 건너뜀"으로 성공한다.

**파드**

- K3s API 서버의 서비스 계정 발급자(`service-account-issuer`)를 발급자 전용 S3 버킷 주소(`https://gachita-dev-oidc-<계정>.s3.ap-northeast-2.amazonaws.com`)로 바꾸고, 발견 문서(`/.well-known/openid-configuration`)와 공개 키(`/openid/v1/jwks`) 두 파일만 그 버킷에 올린다. 두 파일은 공개 키라 공개해도 되는 값이고, 버킷에는 이 둘 말고 아무것도 두지 않는다. 이름이 계정 번호로 정해지므로 서버를 만들기 전에 주소를 알 수 있다. 서버를 새로 만들면 키가 바뀌므로 첫 부팅 때마다 다시 올린다(캐시 없음).
- IAM에 이 발급자를 OIDC 제공자로 등록하고, 서비스 계정마다 역할을 둔다. 신뢰 조건은 `sub = system:serviceaccount:<네임스페이스>:<이름>`.

  | 서비스 계정 | 역할 | 권한 |
  |---|---|---|
  | `external-secrets/ssm-reader` | `gachita-dev-ssm-reader` | `/gachita/dev/app/*`, `/gachita/dev/tf/*` 읽기 |
  | `gachita-trips/trips` | `gachita-dev-pg-trips` | 데이터 버킷의 `postgres/trips/` 읽기·쓰기 |
  | `gachita-profiles/profiles` | `gachita-dev-pg-profiles` | 데이터 버킷의 `postgres/profiles/` 읽기·쓰기 |

- 토큰은 AWS의 공개 웹훅([amazon-eks-pod-identity-webhook](https://github.com/aws/amazon-eks-pod-identity-webhook))이 서비스 계정 주석(`eks.amazonaws.com/role-arn`)을 보고 파드에 넣는다. EKS가 아니어도 쓰도록 만든 것이고, cert-manager가 웹훅 인증서를 만든다. External Secrets는 웹훅 없이 같은 주석을 읽어 스스로 토큰을 받는다.
- 서버의 IMDS 홉 제한을 1로 내린다. 파드는 인스턴스 역할에 닿지 못한다. 인스턴스 역할은 SSM 세션, 배포 키 읽기, 발급자 공개 키 올리기만 한다.
- 구현은 클러스터 쪽 자원과 함께 T24에서 한다.
- 발급자를 Cloudflare 이름(`gachita.mangowhois.ai`) 아래에 두는 길도 봤다. 그러면 IAM 인증이 터널과 서비스 주소에 묶여, 터널이 끊기면 백업까지 멈춘다. S3 버킷은 AWS 안에서 끝나 그 고리가 없다.

**남는 고정 비밀 값(예외)**

AWS 열쇠는 없다. 아래는 AWS가 아닌 곳의 자격이라 OIDC로 바꿀 수 없어 예외로 둔다. 모두 `gh secret set`으로 저장소 비밀 값에 넣고, 워크플로가 적용 역할로 SSM에 옮긴다(T24).

| 값 | 왜 남나 |
|---|---|
| 이미지 받기 토큰(`read:packages`) | GHCR 비공개 패키지는 개인 접근 토큰으로만 받는다 |
| Argo CD 배포 키(읽기 전용 SSH) | 비공개 저장소를 읽는 자격. Argo CD가 올라오기 전에 필요 |
| 구글 OAuth 클라이언트 비밀 값 | 구글이 발급하는 값 |
| Cloudflare API 토큰 | Terraform이 터널과 `gachita` 레코드를 만들 때(ADR-0010). 권한은 계정의 Cloudflare Tunnel 편집과 `mangowhois.ai` 영역의 DNS 편집. Cloudflare 토큰은 레코드 하나로 좁힐 수 없어 영역의 다른 레코드(메일 전달)도 고칠 수 있다. 그래서 Terraform은 `gachita` 레코드 하나만 선언하고 다른 레코드를 가져오지 않는다 |
| Cloudflare 터널 토큰 | cloudflared가 터널에 붙는 값. Terraform이 만들어 SSM `/gachita/dev/tf/`에 둔다 |

**같이 쓰는 계정에서 남는 길(11/13 점검)**

지환님이 지금 계정(다른 프로젝트와 같이 씀)에 만들기로 정했다. 우리 자원은 태그 가능한 것 모두 `Project=gachita`를 단다(provider `default_tags`, 상태 버킷은 CLI로). 그래도 다른 프로젝트 자원에 닿을 수 있는 길:

| 길 | 닿는 것 | 왜 남나 / 막는 것 |
|---|---|---|
| 사람의 로컬 자격(`mango_sesacthon`) | 계정 전체 | 상태 버킷과 `account/`를 처음 만드는 데 필요. Terraform은 상태에 든 것만 고치고 지우며, `account/`는 GitHub 제공자를 `data`로만 읽어 destroy가 지우지 않는다. 손 명령을 잘못 치는 것은 막지 못한다 |
| 적용 역할의 `ec2:RunInstances`의 네트워크 카드·디스크 | 다른 프로젝트의 **기존 네트워크 카드를 지정해** 우리 서버를 띄우기 | 서버와 함께 생기는 카드·디스크는 만들 때 태그를 달 수 없어 조건 없이 허용. 그 카드를 고치거나 지우지는 못한다 |
| 적용 역할의 S3·SSM | 이름이 `gachita-*`인 버킷, `/gachita/*` 값 | 태그가 아니라 이름으로 좁힘. 지금 다른 프로젝트에 그 이름은 없다(11/13 확인) |
| 읽기(`ec2:Describe*`, `iam:Get*`·`List*`) | 다른 프로젝트의 EC2·IAM **설정** | 자원 단위로 좁힐 수 없다. 값(SSM, S3 객체, 로그, DB)은 읽지 못한다 |
| 같이 쓰는 GitHub OIDC 제공자 | 우리 역할이 그것을 믿음 | 우리는 고치지 못한다(명시적 거부). 다른 프로젝트가 지우면 우리 워크플로가 역할을 받지 못한다(되만들면 ARN이 같아 다시 됨) |

정책 문서 셋은 IAM 정책 시뮬레이터로 56가지 호출에 돌려 기대와 맞음을 봤다(정책 논리만. EC2 API가 실제로 함께 판정하는 자원은 첫 적용에서 확인).

## 결과

- 적용 순서가 생긴다: 상태 버킷(CLI) → `account/`(로컬 자격) → 저장소 변수 → 이후 계획·적용은 GitHub Actions. 순서는 `backend/infra/terraform/README.md`의 '처음 한 번'.
- 로컬 IAM 사용자(`mango_sesacthon`)의 열쇠는 처음 한 번과 `account/` 변경에만 쓴다. 이 열쇠는 저장소와 서버에 두지 않는다.
- 계획 역할은 상태 파일을 읽는다. 상태에는 Terraform이 만든 값(Cloudflare 터널 토큰)이 들어 있으므로, PR을 열 수 있는 사람은 그 값을 볼 수 있다. 팀 4명이 저장소 쓰기 권한을 가진 지금은 같은 신뢰 범위로 본다. 외부 기여자를 받게 되면 계획을 PR 라벨로 승인한 뒤에만 돌린다.
- 확인한 것(11/13): `terraform validate`(account), 로컬 자격으로 상태 없이 계획만(6개: 역할 둘, 정책 셋, 관리 정책 붙이기 하나. 제공자는 읽기만). 계획에서 나온 정책 문서 셋을 IAM 정책 시뮬레이터(`simulate-custom-policy`, 읽기 전용)로 35가지 호출에 돌려 기대와 맞음: 우리 태그 자원의 만들기·지우기 허용, 남의·태그 없는 인스턴스와 VPC, EKS·GitHub 제공자, 다른 버킷은 거부, 경계 없는 역할 만들기 거부, 사람이 넣은 비밀 값 직접 읽기·복호화 거부, `/tf/` 복호화는 계획 역할이 막지 않음, 경계는 SSM을 거친 복호화만 허용. 시뮬레이터는 정책 논리만 본다. 실제 계정에 만들지 않았고, 역할을 받아 계획을 돌린 적도 없다(EC2 API가 실제로 어떤 자원을 함께 판정하는지는 첫 적용에서 확인).
