# AWS 자원 (Terraform)

K3s 서버 한 대와 그 주변 자원을 만듭니다. **2026-11-12 기준으로 아무것도 만들지 않았습니다.** `terraform apply`는 비용이 생기므로 지환님이 승인한 때에만 실행합니다.

## 만드는 것 (21개)

| 자원 | 내용 |
|---|---|
| 네트워크 | VPC `10.42.0.0/16`, 공개 서브넷 하나, 인터넷 게이트웨이 |
| 보안 그룹 | 80·443만 밖에서 열림. SSH(22)는 열지 않고 SSM 세션으로 들어감. 쿠버네티스 API(6443)는 `admin_cidrs`에 적은 주소만 |
| 서버 | EC2 `t4g.medium`(ARM), 우분투 24.04, 암호화한 gp3 30 GB, IMDSv2만, 고정 IP |
| 역할 | SSM 세션, 데이터 버킷 읽기·쓰기, `/gachita/dev/*` SSM 값 읽기 |
| 버킷 | Postgres 백업과 클립용. 공개 차단, 버전 관리, 암호화, 지난 버전 30일 뒤 삭제 |
| 첫 부팅 | 비공개 이미지 받기 설정 → K3s `v1.37.2+k3s1` → Argo CD `v3.6.1` → 뿌리 앱(`backend/infra/gitops/bootstrap`) |

- 관리형 쿠버네티스와 관리형 DB를 쓰지 않습니다. Postgres는 클러스터 안에서 CloudNativePG로 돌립니다(`backend/infra/gitops`).
- 도메인이 없어 주소 이름은 `api.<고정 IP>.sslip.io`를 씁니다.
- 한 대뿐이라 서버가 죽으면 서비스가 멈춥니다. 데이터는 S3 백업에서 되살립니다.

## 비용 어림

서울 리전에서 한 달 내내 켜 두면 서버, 디스크, 고정 IP를 합쳐 대략 **월 35~40달러**로 봅니다. 2026-11-12에 가격표를 다시 확인하지는 않았습니다. 만들기 전에 AWS 요금 계산기로 확인합니다. 쓰지 않을 때는 `terraform destroy`로 지웁니다.

## 처음 한 번 (사람이 로컬 자격으로)

AWS 열쇠는 저장소와 서버에 두지 않습니다. GitHub Actions는 OIDC로 역할을 받습니다([ADR-0011](../../../docs/adr/0011-aws-credentials-via-oidc.md)). 그 역할을 만드는 일만은 사람이 로컬 자격으로 한 번 합니다. **순서대로** 합니다.

| 순서 | 무엇 | 누가 | 상태 |
|---|---|---|---|
| 1 | 상태 버킷 `gachita-tfstate-<계정>` | 사람, AWS CLI | 상태를 둘 곳이 있어야 Terraform을 시작할 수 있음 |
| 2 | `account/`: GitHub OIDC 제공자, 계획 역할(PR), 적용 역할(develop), 권한 경계 | 사람, 로컬 Terraform | CI 역할은 이 폴더를 고치지 못함 |
| 3 | 저장소 변수 셋 | 사람, `gh variable set` | 이때부터 PR에서 계획이 돎 |
| 4 | 본 설정(이 폴더) | GitHub Actions, 수동 실행 | 승인 뒤에만 |

```sh
# 1. 상태 버킷(이름은 계정마다 달라야 함). 버전 관리를 켜 두면 상태를 잘못 써도 되돌릴 수 있다
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket --bucket gachita-tfstate-$ACCOUNT --region ap-northeast-2 \
  --create-bucket-configuration LocationConstraint=ap-northeast-2
aws s3api put-bucket-versioning --bucket gachita-tfstate-$ACCOUNT --versioning-configuration Status=Enabled
sed "s/<계정 ID>/$ACCOUNT/" backend.hcl.example > backend.hcl     # 커밋하지 않는다(.gitignore)

# 2. GitHub OIDC 역할(account/). 자원 7개, 모두 IAM이라 비용 없음
(cd account && terraform init -backend-config=../backend.hcl -backend-config=key=account/terraform.tfstate \
  && terraform plan && terraform apply)                          # 승인 뒤에만

# 3. 역할과 버킷 이름을 저장소 변수로(비밀 값이 아님)
gh variable set AWS_PLAN_ROLE_ARN  -R team-pitcrew/gachita --body "$(terraform -chdir=account output -raw plan_role_arn)"
gh variable set AWS_APPLY_ROLE_ARN -R team-pitcrew/gachita --body "$(terraform -chdir=account output -raw apply_role_arn)"
gh variable set TF_STATE_BUCKET    -R team-pitcrew/gachita --body "gachita-tfstate-$ACCOUNT"

# 4. 이제 이 폴더가 바뀐 PR마다 계획이 PR 댓글로 달린다(.github/workflows/terraform.yml).
#    적용: Actions → terraform → Run workflow(develop) → apply 체크. 승인 뒤에만
```

GitHub Actions의 역할 둘:

| 역할 | 받을 수 있는 곳 | 할 수 있는 것 |
|---|---|---|
| `gachita-github-plan` | 이 저장소의 PR(`repo:team-pitcrew/gachita:pull_request`) | 계정 읽기. 상태 파일 밖의 S3 객체, 사람이 넣은 비밀 값(`/gachita/*/app/*`·`bootstrap/*`)은 못 읽음 |
| `gachita-github-apply` | develop(`repo:team-pitcrew/gachita:ref:refs/heads/develop`) | 본 설정이 만드는 서비스만. 만드는 IAM 역할에는 권한 경계 `gachita-workload-boundary`가 붙어야 함. `account/`가 만든 것은 못 고침 |

## 처음 한 번 (비밀 값)

서버가 첫 부팅 때 읽을 값 두 개를 SSM에 넣습니다. 사람이 만든 값이라 OIDC로 바꿀 수 없는 예외입니다(ADR-0011). 이 경로는 T24에서 `gh secret set` → 워크플로 → SSM으로 바꿉니다.

```sh
#    - 배포 키: ssh-keygen -t ed25519 -f gachita-deploy -N '' 로 만들고, 공개 키를 저장소 Settings → Deploy keys에 읽기 전용으로 등록
#    - 이미지 받기 토큰: GitHub 클래식 토큰, 권한은 read:packages 하나
aws ssm put-parameter --region ap-northeast-2 --name /gachita/dev/argocd-deploy-key --type SecureString --value "$(cat gachita-deploy)"
aws ssm put-parameter --region ap-northeast-2 --name /gachita/dev/ghcr-token --type SecureString --value '<토큰>'

# 로컬에서 계획을 볼 때(보통은 PR 댓글로 본다)
terraform init -backend-config=backend.hcl && terraform plan
```

## 만들기와 그 뒤

```sh
terraform apply                      # 승인 뒤에만
terraform output api_host            # 이 값과 data_bucket을 backend/infra/gitops/apps/api/overlays/dev 에 적어 PR로 올린다
$(terraform output -raw ssm_session) # 서버에 들어가기
sudo tail -f /var/log/gachita-bootstrap.log
```

## 확인한 것

- `account/`: `terraform validate` 통과(2026-11-13). 계정에 만들지 않았고, 역할을 받아 계획을 돌린 적이 없습니다. 워크플로는 지금 저장소 변수가 없어 "역할이 없어 건너뜀"으로 끝납니다.
- `terraform validate` 통과, `terraform plan`이 21개 생성 계획을 오류 없이 보여 줌(2026-11-12, 로컬 상태로 계획만).
- 실제로 만들어 보지 않았습니다. 첫 부팅 스크립트(`user_data.sh.tftpl`)는 실행해 본 적이 없습니다.
