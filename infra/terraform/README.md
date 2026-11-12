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
| 첫 부팅 | K3s `v1.37.2+k3s1` → Argo CD `v3.6.1` → 뿌리 앱(`infra/gitops/bootstrap`) |

- 관리형 쿠버네티스와 관리형 DB를 쓰지 않습니다. Postgres는 클러스터 안에서 CloudNativePG로 돌립니다(`infra/gitops`).
- 도메인이 없어 주소 이름은 `api.<고정 IP>.sslip.io`를 씁니다.
- 한 대뿐이라 서버가 죽으면 서비스가 멈춥니다. 데이터는 S3 백업에서 되살립니다.

## 비용 어림

서울 리전에서 한 달 내내 켜 두면 서버, 디스크, 고정 IP를 합쳐 대략 **월 35~40달러**로 봅니다. 2026-11-12에 가격표를 다시 확인하지는 않았습니다. 만들기 전에 AWS 요금 계산기로 확인합니다. 쓰지 않을 때는 `terraform destroy`로 지웁니다.

## 처음 한 번 (사람이 직접)

```sh
# 1. 상태 버킷 만들기(이름은 계정마다 달라야 함)
aws s3api create-bucket --bucket gachita-tfstate-<계정 ID> --region ap-northeast-2 \
  --create-bucket-configuration LocationConstraint=ap-northeast-2
aws s3api put-bucket-versioning --bucket gachita-tfstate-<계정 ID> --versioning-configuration Status=Enabled

# 2. Argo CD가 비공개 저장소를 읽을 토큰(GitHub 세분화 토큰, 이 저장소의 Contents 읽기만)을 SSM에 넣기
aws ssm put-parameter --region ap-northeast-2 --name /gachita/dev/argocd-repo-token --type SecureString --value '<토큰>'

# 3. 계획 보기
cd infra/terraform
cp backend.hcl.example backend.hcl   # 버킷 이름 채우기
terraform init -backend-config=backend.hcl
terraform plan
```

## 만들기와 그 뒤

```sh
terraform apply                      # 승인 뒤에만
terraform output api_host            # 이 값을 infra/gitops/apps/api/overlays/dev 의 인그레스에 적어 PR로 올린다
$(terraform output -raw ssm_session) # 서버에 들어가기
sudo tail -f /var/log/gachita-bootstrap.log
```

## 확인한 것

- `terraform validate` 통과, `terraform plan`이 21개 생성 계획을 오류 없이 보여 줌(2026-11-12, 로컬 상태로 계획만).
- 실제로 만들어 보지 않았습니다. 첫 부팅 스크립트(`user_data.sh.tftpl`)는 실행해 본 적이 없습니다.
