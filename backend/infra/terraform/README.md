# AWS·Cloudflare 자원 (Terraform)

K3s 서버 한 대와 그 주변 자원, 그리고 가장자리(Cloudflare Tunnel과 `gachita.mangowhois.ai` 레코드)를 만듭니다. **2026-11-13 기준으로 아무것도 만들지 않았습니다.** `terraform apply`는 비용이 생기므로 지환님이 승인한 때에만 실행합니다. 클러스터를 세우는 단계는 [`backend/infra/cluster`](../cluster/README.md), 그 위에 올리는 것은 [`backend/infra/gitops`](../gitops/README.md)에 있습니다. 결정은 [ADR-0012](../../../docs/adr/0012-cluster-build-and-node-size.md).

## 만드는 것 (AWS 28개 + Cloudflare 3개와 SSM 값 1개)

| 자원 | 내용 |
|---|---|
| 네트워크 | VPC `10.10.0.0/16`(K3s 파드 `10.42.0.0/16`·서비스 `10.43.0.0/16`과 겹치지 않게), 공개 서브넷 하나, 인터넷 게이트웨이, S3 게이트웨이 엔드포인트(비용 없음) |
| 보안 그룹 | **들어오는 규칙 없음.** 웹은 Cloudflare Tunnel(서버가 밖으로 연결), 관리는 SSM 세션과 포트 포워딩. `admin_cidrs`를 채우면 6443만 그 주소에 열림 |
| 서버 | EC2 `t4g.large`(ARM, 8 GiB), 우분투 24.04, 암호화한 gp3 40 GB, IMDSv2만·홉 1(파드는 서버 역할에 못 닿음), 자동 복구, 공인 IPv4(나가는 길만. 고정 IP 없음) |
| 서버 역할 | SSM 세션, 배포 키 읽기(`/gachita/dev/bootstrap/*`), 발급자 공개 키 올리기 |
| 파드 역할 | 서비스 계정 OIDC 제공자 + `ssm-reader`(External Secrets), `pg-trips`, `pg-profiles`(자기 백업 접두사만). 모두 권한 경계 `gachita-workload-boundary`(ADR-0011) |
| 버킷 | 데이터(백업·클립, 공개 차단, 버전 관리, 암호화, 지난 버전 30일 뒤 삭제), 발급자(공개 키 두 파일만 공개) |
| Cloudflare | 원격 관리 터널 `gachita-dev`, 터널 경로(`gachita.mangowhois.ai` → `traefik.edge`), `gachita` CNAME(프록시). 영역의 다른 레코드는 가져오지 않음. 터널 토큰은 SSM `/gachita/dev/tf/cloudflare-tunnel-token` |
| 첫 부팅 | 구축 도구만 깔고 `ansible-pull`로 [`backend/infra/cluster/site.yml`](../cluster/site.yml)의 7단계를 돌림 |

- 관리형 쿠버네티스, 관리형 DB, CloudFront, ALB, NAT는 쓰지 않습니다. LB를 두지 않는 이유는 [ADR-0013](../../../docs/adr/0013-network-edge-and-isolation.md).
- Cloudflare 계정·영역 번호(저장소 변수 `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`)가 비어 있으면 Cloudflare 쪽은 만들지 않습니다.
- 한 대뿐이라 서버가 죽으면 서비스가 멈춥니다. 하드웨어 장애는 EC2 자동 복구가 같은 서버로 되살리고, 서버를 새로 만들면 클러스터는 Git에서, 데이터는 S3 백업에서 되살립니다.

## 비용 어림

서울 리전, 한 달 내내 켜 둘 때(AWS 가격표 API로 2026-11-13 확인): t4g.large $60.7(시간당 $0.0832) + gp3 40 GB $3.6 + 공인 IPv4 $3.6 + S3·전송 $1 안팎 ≈ **월 $69, 하루 $2.3.** Cloudflare 무료 요금제 안에서 씁니다. t4g는 버스트형이라 CPU를 기준(0.6 vCPU)보다 오래 쓰면 vCPU·시간당 $0.04가 더 붙습니다. 쓰지 않을 때는 아래 '내리기'로 지웁니다.

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

# 2. GitHub OIDC 역할(account/). 자원 6개, 모두 IAM이라 비용 없음. GitHub OIDC 제공자는 이 계정에 이미 있어(다른 프로젝트 관리) 읽기만 한다
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
| `gachita-github-plan` | 이 저장소의 PR(`repo:team-pitcrew@351326633/gachita@1455271774:pull_request`, GitHub 불변 sub) | 계정 읽기. 상태 파일 밖의 S3 객체, 사람이 넣은 비밀 값(`/gachita/*/app/*`·`bootstrap/*`)은 읽기·복호화 못 함 |
| `gachita-github-apply` | develop(`repo:team-pitcrew@351326633/gachita@1455271774:ref:refs/heads/develop`) | 본 설정이 만드는 서비스만. **같이 쓰는 계정이라 EC2는 `Project=gachita` 태그가 붙은 자원만** 만들고 고침. 만드는 IAM 역할에는 권한 경계 `gachita-workload-boundary`가 붙어야 함. `account/`가 만든 것과 GitHub OIDC 제공자는 못 고침. 사람이 넣은 비밀 값은 직접 읽지 못하지만 경계 안의 역할을 만들 수 있어, 신뢰 범위는 develop 병합 권한과 같음 |

## 처음 한 번 (비밀 값)

비밀 값은 사람이 만들어 저장소 비밀 값에 넣고, 워크플로가 SSM으로 옮깁니다. 저장소와 서버에 그대로 두지 않습니다. 표와 이유는 [ADR-0012](../../../docs/adr/0012-cluster-build-and-node-size.md#결정).

```sh
gh secret set GHCR_PULL_TOKEN      -R team-pitcrew/gachita    # 클래식 토큰, 권한 read:packages 하나
gh secret set ARGOCD_DEPLOY_KEY    -R team-pitcrew/gachita < gachita-deploy   # 승인 뒤: ssh-keygen -t ed25519 -f gachita-deploy -N '' , 공개 키는 Deploy keys에 읽기 전용
gh secret set GOOGLE_CLIENT_ID     -R team-pitcrew/gachita    # 없어도 서버는 뜸
gh secret set GOOGLE_CLIENT_SECRET -R team-pitcrew/gachita
gh secret set CLOUDFLARE_API_TOKEN -R team-pitcrew/gachita    # 계정 Cloudflare Tunnel 편집 + mangowhois.ai DNS 편집
gh variable set CLOUDFLARE_ACCOUNT_ID -R team-pitcrew/gachita --body <계정 번호>
gh variable set CLOUDFLARE_ZONE_ID    -R team-pitcrew/gachita --body <mangowhois.ai 영역 번호>
gh workflow run infra-secrets -R team-pitcrew/gachita --ref develop   # GitHub 비밀 값 → SSM
```

## 만들기 전에 (develop에 병합해 둘 것)

서버는 뜨자마자 develop의 `backend/infra/gitops`를 그대로 올립니다. 아래 둘이 맞지 않으면 물결 2(SSM 저장소)나 물결 4(이미지)에서 멈추므로, Terraform이 서버를 만들기 전에 확인하고 맞지 않으면 계획에서 멈춥니다(`compute.tf`의 precondition).

```sh
# 1. 계정 번호 자리 표시(000000000000)를 이 계정 번호로. 역할 ARN과 버킷 이름에 쓰인다
backend/infra/gitops/fill-account.sh                 # 지금 aws 자격의 계정. 번호를 직접 줄 수도 있음
# 2. 클러스터가 받을 API 이미지 태그(GHCR에 올라가 있어야 함)
make push && make deploy-tag TAG=<올린 태그>          # 지금 값은 c71304da7098(11/13 develop)
# 3. 이 변경을 PR로 develop에 병합
```

## 만들기와 그 뒤

```sh
gh workflow run terraform -R team-pitcrew/gachita --ref develop -f apply=true   # 승인 뒤에만. 계획을 본 다음 적용
# 서버가 뜨면 첫 부팅 스크립트가 7단계를 돈다(30분 안팎). 진행은:
aws ssm start-session --region ap-northeast-2 --target <instance-id>          # terraform output ssm_session
sudo tail -f /var/log/gachita/bootstrap.log; ls /var/lib/gachita/bootstrap      # 끝난 단계
curl -fsS https://gachita.mangowhois.ai/healthz                                 # 밖에서 확인
```

올린 뒤 확인할 순서와 명령은 [`backend/infra/cluster/README.md`](../cluster/README.md#올린-뒤-확인).

## 내리기

```sh
# 1. 백업을 남길지 정한다. 데이터 버킷은 비어 있지 않으면 terraform destroy가 지우지 못한다(일부러: 백업 보호)
#    남김: 버킷만 Terraform 관리에서 뺀다
terraform state list | grep 'aws_s3_bucket.*\.data' | xargs -n1 terraform state rm
#    지움: AWS 콘솔 → S3 → gachita-dev-<계정> → '비우기'(지난 버전까지 지움) 뒤 다음 단계
# 2. 나머지를 지운다(발급자 버킷은 공개 키뿐이라 비우고 지우게 해 둠).
#    워크플로가 아니라 로컬에서 지울 때는 Cloudflare 값이 환경에 있어야 한다(없으면 터널·레코드를 읽지 못해 멈춤)
export CLOUDFLARE_API_TOKEN=<토큰> TF_VAR_cloudflare_account_id=<계정 번호> TF_VAR_cloudflare_zone_id=<영역 번호>
terraform init -backend-config=backend.hcl && terraform destroy
# 3. 터널 경로 설정은 'Terraform이 지우지 못한다'고 경고하지만 터널을 지우면 함께 사라진다. Cloudflare 대시보드에서 터널과 gachita 레코드가 없는지, 메일 레코드가 그대로인지 본다
# 4. account/(OIDC 역할)는 남겨도 비용이 없다. 지우려면 terraform -chdir=account destroy, 상태 버킷은 마지막에
```

## 확인한 것

- 2026-11-13: `terraform validate` 통과. 로컬 자격으로 상태 없이 **계획만**: AWS 28개 생성, Cloudflare 계정·영역 번호를 넣으면 32개(터널, 터널 설정, CNAME, SSM 값). 만들지는 않았습니다.
- `account/`: `terraform validate` 통과, 상태 없이 계획만 6개, 정책 문서를 IAM 정책 시뮬레이터로 35가지 호출에 돌려 기대와 맞음(2026-11-13, ADR-0011). 계정에 만들지 않았고, 역할을 받아 계획을 돌린 적이 없습니다. 워크플로는 지금 저장소 변수가 없어 "역할이 없어 건너뜀"으로 끝납니다.
- 실제로 만들어 보지 않았습니다. 첫 부팅 스크립트와 구축 단계는 실제 서버에서 돈 적이 없습니다.
