# AWS·Cloudflare 자원 (Terraform)

묶음이 셋입니다. 펴고 접는 순서와 확인은 [`../infra.sh`](../infra.sh)(`infra` 워크플로)가 맡습니다. 결정은 [ADR-0012](../../../docs/adr/0012-cluster-build-and-node-size.md)(구축·노드), [ADR-0016](../../../docs/adr/0016-slo-capacity-single-postgres.md)(기본 배치), [ADR-0017](../../../docs/adr/0017-alb-by-controller-and-fold-order.md)(ALB 컨트롤러·펴기 순서), [ADR-0018](../../../docs/adr/0018-postgres-storage-on-root-disk.md)(Postgres 저장 장치). 클러스터를 세우는 단계는 [`backend/infra/cluster`](../cluster/README.md), 그 위에 올리는 것은 [`backend/infra/gitops`](../gitops/README.md)에 있습니다.

| 묶음 | 폴더(상태 키) | 만드는 것 | 접을 때 |
|---|---|---|---|
| 계정 | `account/`(`account/`) | GitHub OIDC 역할 셋(계획·적용·웹 화면 파일 올리기), 권한 경계 `gachita-workload-boundary` | 남김. 사람이 로컬 자격으로 한 번 |
| 남는 묶음 | `persist/`(`persist/`) | 데이터 버킷(백업, 공개 차단·버전·암호화), 클립 버킷(공개 차단·버전 없음·암호화·2일 만료, T64), 발급자 버킷과 발급자 문서, 서비스 주소의 ACM 인증서와 검증 레코드, Cloudflare 요청 수 제한, 미디어 CDN(`media.tf`: CloudFront 배포·us-east-1 인증서·서명 공개 키·클립 버킷 정책·`media.gachita` 레코드. 저장소 변수 `MEDIA_PUBLIC_KEY`가 있을 때만, ADR-0026) | 남김. 다시 펼 때 다시 만들지 않음 |
| 접는 묶음 | 이 폴더(`dev/`) | VPC `10.10.0.0/16`, 공개 서브넷 둘(ALB용 태그), 인터넷 게이트웨이, S3 엔드포인트, 노드 보안 그룹, EC2 `t4g.large` 한 대, 서버 역할, 서비스 계정 OIDC 제공자와 파드 역할 다섯(`ssm-reader`, `pg`, `pg-restore`, `alb-controller`, `api`), ALB가 있을 때만 Cloudflare `gachita` 레코드 | 지움 |

- **ALB는 Terraform이 만들지 않습니다.** 클러스터의 AWS Load Balancer Controller가 Gateway를 보고 만들고 지웁니다(이름 `gachita-dev`, 태그 `Project=gachita`, `elbv2.k8s.aws/cluster=gachita-dev`). 그래서 접을 때는 Terraform보다 먼저 클러스터에서 Gateway를 지웁니다(`infra.sh down`). 레코드는 이 태그로 ALB를 찾았을 때만 생기므로 펴기는 이 폴더를 두 번 적용합니다(두 번째에 레코드).
- 노드 보안 그룹의 들어오는 규칙은 Terraform이 묶어 들지 않습니다. 컨트롤러가 더하는 'ALB → NodePort' 규칙을 다음 적용이 지우지 않게 하려는 것입니다. SSH·웹 포트는 열지 않고 관리는 SSM입니다.
- 관리형 쿠버네티스, 관리형 DB, NAT, 사설 서브넷은 쓰지 않습니다(ADR-0016의 기본 배치).

## 비용 어림

서울 리전, 한 달 내내 켜 둘 때(AWS 가격표 API, 2026-11-13): t4g.large $60.7 + gp3 40 GB $3.6 + 서버 공인 IPv4 $3.6 + ALB $16.4(시간당 $0.0225) + ALB 공인 IPv4 둘 $7.3 + LCU 몇 달러 + S3·전송 $1 안팎 ≈ **월 $95, 하루 $3.1.** Cloudflare 무료 요금제 안에서 씁니다. 쓰지 않을 때는 `infra.sh down`으로 접으면 남는 묶음(버킷, 인증서)만 남아 월 $1 안팎입니다.

## 처음 한 번 (사람이 로컬 자격으로)

AWS 열쇠는 저장소와 서버에 두지 않습니다. GitHub Actions는 OIDC로 역할을 받습니다([ADR-0011](../../../docs/adr/0011-aws-credentials-via-oidc.md)). 그 역할을 만드는 일만은 사람이 로컬 자격으로 한 번 합니다. **순서대로** 합니다.

| 순서 | 무엇 | 누가 | 상태 |
|---|---|---|---|
| 1 | 상태 버킷 `gachita-tfstate-<계정>` | 사람, AWS CLI | 2026-11-13 만듦(721622471953) |
| 2 | `account/`: 계획 역할(PR), 적용 역할(develop), 권한 경계. GitHub OIDC 제공자는 이 계정에 이미 있어 읽기만 | 사람, 로컬 Terraform | 2026-11-13 적용(자원 6개). CI 역할은 이 폴더를 고치지 못함 |
| 3 | 저장소 변수 셋 | 사람, `gh variable set` | 아직. 넣으면 PR에서 계획이 돎 |
| 4 | 남는 묶음과 접는 묶음 | `infra` 워크플로(develop) 또는 로컬 `infra.sh` | 펴기·접기 |

```sh
# 1. 상태 버킷(이름은 계정마다 달라야 함). 버전 관리를 켜 두면 상태를 잘못 써도 되돌릴 수 있다
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket --bucket gachita-tfstate-$ACCOUNT --region ap-northeast-2 \
  --create-bucket-configuration LocationConstraint=ap-northeast-2
aws s3api put-bucket-versioning --bucket gachita-tfstate-$ACCOUNT --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket gachita-tfstate-$ACCOUNT --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-tagging --bucket gachita-tfstate-$ACCOUNT --tagging 'TagSet=[{Key=Project,Value=gachita},{Key=ManagedBy,Value=cli}]'   # 같이 쓰는 계정이라 우리 것임을 태그로
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
gh secret set ARGOCD_REPO_TOKEN    -R team-pitcrew/gachita    # fine-grained 토큰, 이 저장소 하나의 Contents·Metadata 읽기만(아래)
gh secret set GOOGLE_CLIENT_ID     -R team-pitcrew/gachita    # 없어도 서버는 뜸
gh secret set GOOGLE_CLIENT_SECRET -R team-pitcrew/gachita
gh secret set ASR_TOKEN            -R team-pitcrew/gachita    # 재전사(T75) 상현님 Nemotron ASR 토큰. 없으면 보내지 않음
gh secret set CLOUDFLARE_API_TOKEN -R team-pitcrew/gachita    # mangowhois.ai: DNS 편집, 영역 WAF(요청 수 제한 규칙) 편집
gh secret set CLOUDFLARE_API_TOKEN_READ -R team-pitcrew/gachita   # PR 계획용: mangowhois.ai Zone·DNS·Zone WAF 읽기만(쓰기 토큰은 PR에 주지 않음)
gh variable set CLOUDFLARE_ZONE_ID -R team-pitcrew/gachita --body <mangowhois.ai 영역 번호>
gh workflow run infra-secrets -R team-pitcrew/gachita --ref develop   # GitHub 비밀 값 → SSM
```

- **저장소 읽기 자격:** 조직 설정으로 배포 키가 막혀 있어(2026-11-13, `Deploy keys are disabled for this repository`) 이 저장소 하나만 읽는 fine-grained 토큰을 HTTPS로 씁니다(T24, 11/14). 첫 부팅이 SSM에서 받아 파일(600)에 두고, git은 자격 도우미로, Argo CD는 저장소 자격(`argocd/gachita-repo`)으로 읽습니다. 토큰은 만료(지금 것은 2026-12-14)가 있어 바꿀 때는 같은 이름으로 다시 넣고 `infra-secrets`를 돌린 뒤 `ops` 워크플로의 `converge`(단계 `argocd`)를 돌립니다. 모든 비밀 값의 길과 바꾸는 법은 [ADR-0012](../../../docs/adr/0012-cluster-build-and-node-size.md#결정)의 표 한 곳에 둡니다.
- Cloudflare 영역의 SSL/TLS 모드는 Full(strict)이어야 합니다. ALB는 443만 엽니다(영역 전체 설정이라 Terraform이 바꾸지 않음).

## 만들기 전에 (develop에 병합해 둘 것)

서버는 뜨자마자 develop의 `backend/infra/gitops`를 그대로 올립니다. 계정 번호(역할 ARN, 버킷 이름)는 계정마다 한 번 채워 둡니다(T27에서 채움). API 이미지 태그가 `unreleased`면 Terraform이 서버를 만들기 전에 멈춥니다(`compute.tf`의 precondition).

## 펴기와 접기

```sh
gh workflow run infra -R team-pitcrew/gachita --ref develop -f action=up     # 펴기. 실행하는 것이 비용 승인
gh workflow run infra -R team-pitcrew/gachita --ref develop -f action=down   # 접기
# 로컬에서(같은 스크립트): 상태 버킷과 AWS 자격, 고를 것은 Cloudflare 토큰·영역 번호, 병합 전 브랜치
TF_STATE_BUCKET=gachita-tfstate-<계정> backend/infra/infra.sh up
```

| 펴기(`up`) | 접기(`down`) |
|---|---|
| 1 남는 묶음 적용(보통 바뀔 것 없음) | 1 마지막 전체 백업(`Backup` 완료까지) |
| 2 접는 묶음 적용 → 서버 첫 부팅이 구축 7단계 | 2 뿌리 앱 자동 동기화를 끄고 `edge` 앱 지움 → 컨트롤러가 ALB·대상 그룹·보안 그룹을 지움 |
| 3 SSM으로 단계 기록 파일 `7-verify.done`을 기다림 | 3 ALB가 사라졌는지(남으면 클러스터 태그로 지움) |
| 4 ALB `gachita-dev`가 active | 4 접는 묶음 destroy(레코드 포함). 컨트롤러의 보안 그룹이 VPC를 막으면 지우고 다시 |
| 5 접는 묶음 한 번 더 → 레코드 | 5 `Project=gachita` EC2·ELB가 남지 않았는지 |
| 6 ALB 대상 건강, `https://gachita.mangowhois.ai/healthz` | |

다시 펼 때 데이터 버킷에 Postgres 전체 백업이 있으면 구축 6단계가 복구로 폅니다(T52). 적용 역할도 `Project=gachita` 태그와 `gachita-*` 이름이 맞는 자원만 고치고 지울 수 있습니다(ADR-0011).

## 확인한 것

- 2026-11-13: `terraform validate` 통과. 로컬 자격으로 상태 없이 **계획만**: AWS 28개 생성, Cloudflare 계정·영역 번호를 넣으면 32개(터널, 터널 설정, CNAME, SSM 값). 만들지는 않았습니다.
- `account/`: `terraform validate` 통과, 상태 없이 계획만 6개, 정책 문서를 IAM 정책 시뮬레이터로 35가지 호출에 돌려 기대와 맞음(2026-11-13, ADR-0011). 11/13에 계정에 만들었고(로컬 자격), GitHub에서 역할을 받아 계획을 돌린 적은 아직 없습니다. 워크플로는 지금 저장소 변수가 없어 "역할이 없어 건너뜀"으로 끝납니다.
- 실제로 만들어 보지 않았습니다. 첫 부팅 스크립트와 구축 단계는 실제 서버에서 돈 적이 없습니다.
