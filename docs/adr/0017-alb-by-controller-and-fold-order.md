# ADR-0017: ALB는 AWS Load Balancer Controller가 만들고, 펴기·접기는 그 의존성 순서로 한다

* **상태:** 제안, 2026-11-13 (ADR-0016 채택에 맞춤, 실제 계정에서 펴고 접어 확인)
  * 채택(지환, 11/13): 들어오는 길은 ALB, ALB는 AWS Load Balancer Controller가 만들고 그 컨트롤러는 Argo CD로 관리한다. Traefik은 쓰지 않는다. 기획안과 요구사항을 넘는 구성은 하지 않는다.
  * 제안(이 문서): 자원마다 누가 만드는지의 경계, 펴기·접기의 순서와 그 순서를 지키는 검사.
* **관련:** T53(#90, 펴기·접기 워크플로), T51(#88), T52(#89), T54(#91), T24, T27, ADR-0016(채택, PR #103: 기본 배치·Postgres 하나·ALB 선택), ADR-0011(OIDC), ADR-0012(구축 단계), ADR-0013(물결)

## 배경

- 지환님 목표(11/13): 코드만으로 환경 전체를 펴고 접고, 여러 번 되풀이해도 남는 것이나 충돌이 없어야 한다.
- ALB는 Terraform, Ansible, 스크립트로도 만들 수 있다. 지환님은 컨트롤러로 정했다. 컨트롤러가 만들면 ALB가 **Terraform 상태 밖**에 생긴다. 그래서 '무엇이 무엇보다 먼저 있어야 하는지'를 정하지 않으면, 펼 때는 경로가 열리지 않고 접을 때는 ALB가 남아 VPC 삭제를 막는다.
- 이 문서는 ADR-0016(채택)이 정한 기본 배치(한 대, Postgres 하나, Cloudflare → ALB → API의 NodePort)를 전제로 한다.

## 검토한 선택: ALB를 무엇이 만드나

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| Terraform이 ALB·리스너·대상 그룹을 만듦 | 상태 안이라 접을 때 같이 지워짐 | 대상(노드의 NodePort 번호)을 Terraform과 클러스터가 같이 알아야 함. 노드·서비스가 바뀌면 Terraform을 다시 적용. 경로가 Git의 두 곳(Terraform, 클러스터)에 나뉨 |
| Ansible·스크립트가 AWS CLI로 만듦 | 단계에 넣기 쉬움 | 다시 돌려도 같은 결과가 되게 짜기가 어렵고(있으면 고치고 없으면 만들기), 상태가 어디에도 없음 |
| **AWS Load Balancer Controller(공식, Argo CD로)** | 경로(Gateway·HTTPRoute)가 앱 선언 옆에 있고, 노드·서비스가 바뀌면 대상을 저절로 맞춤. 인증서를 호스트 이름으로 찾아 Git에 계정 값이 없음 | ALB가 Terraform 상태 밖. 접을 때 클러스터가 살아 있는 동안 먼저 지워야 함. 컨트롤러가 AWS 권한(역할)을 가짐 |

## 결정

### 1. 누가 무엇을 만드나

| 묶음 | 만드는 것 | 누가 | 접을 때 |
|---|---|---|---|
| 계정(처음 한 번) | 상태 버킷, GitHub OIDC 역할 둘, 권한 경계 | 사람, 로컬 자격 | 남김 |
| 남는 묶음(T51) | 데이터 버킷(백업), 발급자 버킷, ACM 인증서와 Cloudflare의 검증 레코드(DNS만), Cloudflare 요청 수 제한 규칙 | Terraform | 남김. 다시 펼 때 다시 만들지 않음(인증서를 다시 받지 않음) |
| 접는 묶음 | VPC, 공개 서브넷 둘(ALB용 태그 `kubernetes.io/role/elb=1`), 인터넷 게이트웨이, 경로, S3 엔드포인트, 노드 보안 그룹, EC2 한 대, 노드 역할, 서비스 계정 OIDC 제공자, 파드 역할(External Secrets, Postgres 백업, **ALB 컨트롤러**) | Terraform | 지움 |
| 클러스터 바닥 | K3s, Cilium, 발급자 공개 키, Argo CD, 뿌리 앱 | 첫 부팅 + Ansible 7단계 | 서버와 함께 사라짐 |
| 클러스터 위 | 컨트롤러들(ALB 컨트롤러 포함), DB, API, Gateway·HTTPRoute | Argo CD 물결 | 서버와 함께 사라짐 |
| **ALB 쪽** | ALB(이름 고정 `gachita-dev`), 리스너, 대상 그룹, ALB 보안 그룹 둘(앞단·뒷단), 노드 보안 그룹에 더한 규칙 | **ALB 컨트롤러** | Gateway를 지우면 컨트롤러가 지움 — **Terraform이 지우기 전에** |
| 접는 묶음의 레코드 | Cloudflare `gachita` 레코드(프록시) → ALB 주소 | Terraform(같은 묶음. 컨트롤러의 클러스터 태그로 ALB를 찾았을 때만 만듦) | 접는 묶음과 같이 |

- 컨트롤러가 만드는 AWS 자원에는 `Project=gachita`가 붙는다(차트 값 `defaultTags`). 같이 쓰는 계정에서 우리 것을 태그로 가린다(ADR-0011).
- Git에는 펼 때마다 바뀌는 값을 적지 않는다. 인증서는 리스너의 호스트 이름(`gachita.mangowhois.ai`)으로 컨트롤러가 찾고(컨트롤러 문서 'Certificate Discovery'), 서브넷은 태그로, VPC는 이름 태그로 찾는다(차트 값 `vpcTags`, 컨트롤러 인자 `--aws-vpc-tags`). 역할 ARN은 이름이 고정이라 계정 번호만 있으면 된다. 계정 번호는 계정마다 한 번 채운다(`fill-account.sh`). 그래서 T50(값을 Git 밖에서 넘기기)은 접었다 펴기에 필요하지 않다.
- 인스턴스 대상은 노드의 `spec.providerID`(`aws:///<영역>/<인스턴스 ID>`)에서 인스턴스를 찾는다. K3s는 기본으로 `k3s://<이름>`을 적으므로 구축 2단계가 kubelet 인자 `provider-id`로 AWS 형식을 준다. 노드 보안 그룹에는 컨트롤러가 고를 수 있게 `kubernetes.io/cluster/gachita-dev` 태그를 단다. 그 보안 그룹의 규칙은 Terraform이 묶음(inline)으로 들지 않으므로 컨트롤러가 더한 규칙을 Terraform이 지우지 않는다.
- 원본 보호는 `LoadBalancerConfiguration`의 `sourceRanges`에 Cloudflare 대역을 적어 컨트롤러가 앞단 보안 그룹을 만들게 한다. 대역은 자주 바뀌지 않아 Git에 둔다.

### 2. 펴기 순서와 각 단계가 끝났는지 보는 것

| 순서 | 하는 일 | 앞에 있어야 하는 것 | 끝났는지 |
|---|---|---|---|
| 1 | 남는 묶음 적용(보통 바뀔 것 없음) | 계정 묶음 | ACM 인증서 `ISSUED` |
| 2 | 접는 묶음 적용(레코드는 아직 없음) | 1 | EC2 실행 중 |
| 3 | 첫 부팅과 구축 1~6단계(K3s → Cilium → 발급자 공개 키 → Argo CD → 뿌리 앱) | 2(서버, 배포 키, 발급자 버킷) | 단계 기록 파일 `6-root.done`(SSM으로 읽음) |
| 4 | 물결 0~2: 규칙과 CRD → 운영자(cert-manager, CloudNativePG, External Secrets) → 파드 신원 웹훅, 백업 플러그인, 비밀 값 저장소 | 3 | 앱 Healthy |
| 5 | 물결 3: **ALB 컨트롤러**와 Postgres(백업이 있으면 복구, T52) | 4의 **파드 신원 웹훅**(컨트롤러의 AWS 자격이 웹훅이 넣는 토큰에서 옴 — 웹훅보다 먼저 뜨면 자격 없이 뜸), cert-manager(웹훅 인증서), 2의 컨트롤러 역할·서브넷 태그, 3의 발급자 공개 키 | 앱 Healthy |
| 6 | 물결 4: API(서비스는 NodePort) | 5의 Postgres | 앱 Healthy |
| 7 | 물결 5: Gateway·HTTPRoute → 컨트롤러가 ALB를 만들고 노드를 대상에 넣음 | 5의 컨트롤러, 6의 API, 1의 인증서 | Gateway `Programmed`, 대상 건강 |
| 8 | 접는 묶음을 한 번 더 적용: Cloudflare 레코드 → ALB | 7의 ALB | 레코드가 ALB 주소를 가리킴 |
| 9 | 확인: 구축 7단계(물결·WAL 보관) + 실제 주소 E2E(T54) | 8 | `https://gachita.mangowhois.ai/healthz` 200, E2E 통과 |

- 지금 물결(ADR-0013)에서 바뀌는 것은 하나다: 컨트롤러는 파드 신원 웹훅이 건강해진 **뒤** 물결(3)에 둔다. 같은 물결에 두면 웹훅이 준비되기 전에 컨트롤러 파드가 떠 AWS 자격 없이 돌 수 있다(웹훅은 실패해도 파드를 막지 않음: `failurePolicy: Ignore`). 자격 환경 변수는 파드를 만들 때만 들어가므로 저절로 고쳐지지 않는다. **ADR-0016의 결과 절은 '웹훅 인증서를 cert-manager로 받으므로 물결 2'라고 적었는데, 이 문서가 물결 3으로 바로잡는다.** cert-manager(물결 1)도 물결 3이면 이미 있다.
- 8번의 레코드는 같은 Terraform 묶음을 한 번 더 적용해 만든다. 레코드는 컨트롤러의 클러스터 태그로 찾은 ALB가 있을 때만 생긴다(`data "aws_lbs"`는 없으면 빈 목록). 그래서 묶음을 따로 나누지 않고, 첫 적용에는 레코드가 없고 ALB가 생긴 뒤의 적용에서 생긴다. 접힌 상태의 PR 계획도 깨지지 않는다.

### 3. 접기 순서

| 순서 | 하는 일 | 왜 이 순서 | 끝났는지 |
|---|---|---|---|
| 1 | 마지막 전체 백업(T52) | 클러스터가 살아 있을 때만 됨. WAL 보관 주기(5분) 사이의 마지막 변경까지 S3에 남김 | `Backup` 완료 |
| 2 | `edge` 앱(Gateway)을 지움 → 컨트롤러가 ALB·대상 그룹·보안 그룹·노드 보안 그룹 규칙을 지움 | 컨트롤러가 살아 있어야 지움. ALB가 남으면 비용이 나고 그 네트워크 카드가 서브넷·VPC 삭제를 막음 | 태그 `Project=gachita`로 찾은 ALB·대상 그룹 0개, ALB의 네트워크 카드 0개 |
| 3 | 접는 묶음 destroy(레코드 포함) | 2. 레코드가 잠깐 없는 ALB를 가리키지만 그때는 이미 서비스가 내려가는 중 | Terraform 끝 |
| 4 | 남은 것 확인 | | 태그로 찾은 것이 남는 묶음과 상태 버킷뿐 |

- **2가 실패할 때(클러스터가 이미 망가짐):** 같은 태그(`Project=gachita`와 컨트롤러의 클러스터 태그)로 ALB·대상 그룹·보안 그룹을 찾아 지우는 정리 단계를 둔다. 적용 역할에 그 태그 조건으로 ELB 삭제 권한이 필요하다.
- 되풀이해도 같은 결과: ALB 이름은 고정이고 DNS 주소만 바뀐다(펴기 8번이 매번 고침). 인증서·버킷은 남는 묶음이라 다시 만들지 않는다. 발급자 공개 키는 서버마다 새로 올린다(구축 4단계).
- 다시 펼 때 Postgres(T52): 구축 단계가 데이터 버킷에 전체 백업이 있는지 보고, 있으면 뿌리 앱이 DB 앱을 복구 선언(`apps/db/recover`)으로 바꿔 올린다. 복구한 클러스터는 같은 경로(`postgres/db`)에 새 타임라인으로 이어 쓴다. 그래서 운영자의 '빈 보관소' 검사를 복구 선언에서만 끈다(`cnpg.io/skipEmptyWalArchiveCheck`, CloudNativePG 1.30이 이 주석을 보고 플러그인에 검사 여부를 넘김). 같은 경로를 두 클러스터가 같이 쓰는 일은 없다(접힌 뒤에만 편다). 결정은 서버마다 한 번 하고 기록 파일에 남겨, 같은 서버에서 구축 단계를 다시 돌려도 바뀌지 않는다.

### 4. 하지 않는 것(기획안·요구사항 밖)

external-dns(Cloudflare 토큰을 클러스터에 넣게 됨), ALB의 WAF·접근 기록·Authenticated Origin Pulls, 사설 서브넷과 NAT, 노드 여럿, CloudWatch SLO 대시보드, T50(값을 Git 밖에서 넘기기), DB 세대별 경로는 지금 하지 않는다. 필요해지면 그때 따로 정한다.

요청 수 제한은 ADR-0016대로 Cloudflare 엣지로 옮긴다(무료 요금제 규칙 하나, 주소마다 10초에 200). 남는 묶음에 둔다. Cloudflare에서 ALB(443만 엶)로 가려면 영역의 SSL/TLS 모드가 Full(strict)이어야 한다. 영역 전체 설정이라 Terraform이 바꾸지 않고 사람이 확인한다.

## 계획(PR 순서)

| 순서 | 티켓 | 내용 |
|---|---|---|
| 1 | ADR-0016 병합 | 채택됨(PR #103). 컨트롤러 물결은 이 문서대로 3 |
| 2 | T25(#74) 보강 | 권한 경계에 ALB 컨트롤러가 쓰는 ELB·EC2 보안 그룹·ACM 읽기(태그 조건), 적용 역할에 ACM, 3절의 태그 조건 ELB 삭제, 레코드용 ELB 읽기, 우리 서버로 좁힌 SSM 명령 보내기 |
| 3 | T24(#77) 다시 | Terraform: 공개 서브넷 둘과 태그, 터널 제거, 컨트롤러 역할, ALB가 있을 때만 생기는 레코드, Postgres 역할 하나(ADR-0016), `worker_count` 변수. 구축 단계: providerID, 확인 단계에서 바깥 주소 확인을 워크플로로 |
| 4 | T51(#88) | 남는 묶음 분리(버킷 둘, ACM과 검증 레코드, 요청 수 제한 규칙). #77에 같이 넣음 |
| 5 | GitOps(T27) | ALB 컨트롤러 앱(물결 3), Traefik·cloudflared 제거, GatewayClass `gateway.k8s.aws/alb`, `LoadBalancerConfiguration`(이름 고정, internet-facing, `sourceRanges`), API 서비스 NodePort와 포트 규칙 예외 하나, Postgres 하나(ADR-0016) |
| 6 | T52(#89) | 백업이 있으면 복구로 펴기, 접기 전 마지막 백업. 로컬에서 S3 호환 저장소로 확인 |
| 7 | T53(#90) | `backend/infra/infra.sh up|down`과 `infra` 워크플로가 2·3절의 순서와 검사를 그대로 |
| 8 | 처음 접었다 펴기 | 11/13에 함(아래 '실제 계정에서 펴고 접은 것'). 실제 GitHub·Cloudflare 경로는 아래 사람 몫이 끝난 뒤 |

**실제 GitHub·Cloudflare 경로로 펴기 전에 사람이 할 것:** 저장소 읽기 자격(배포 키가 조직 설정으로 막혀 있어 허용하거나 다른 자격을 정함), Cloudflare API 토큰(mangowhois.ai DNS 편집과 영역 WAF 편집)과 영역 번호, 이미지 받기 토큰(`read:packages`)을 `gh secret set`/`gh variable set`으로 넣기, 저장소 변수 셋(역할 ARN 둘, 상태 버킷). `account/`와 상태 버킷은 11/13에 만들었다.

## 결과

- ALB가 Terraform 밖에 생기는 대신 펴기·접기에 순서가 생기고, 그 순서는 워크플로(T53)가 지킨다.
- 컨트롤러 물결이 하나 뒤로 간다(웹훅 뒤). Postgres와 같은 물결이라 전체 시간은 거의 같다.
- 레코드 단계를 묶음으로 나누지 않고 같은 묶음을 두 번 적용한다(ALB를 태그로 찾았을 때만 레코드). Postgres는 다시 펼 때 백업에서 복구한다(T52).

### 실제 계정에서 펴고 접은 것(2026-11-13, 계정 721622471953, `backend/infra/infra.sh`)

펴기 → 접기 → 다시 펴기(복구) → 접기를 돌렸다. Cloudflare 토큰과 GHCR 토큰이 없어(사람 몫) 레코드와 Cloudflare 경유 확인은 하지 않았다. 대신 ALB에 직접 대고 확인했다.

| 무엇 | 결과 |
|---|---|
| 컨트롤러(v3.6.2)의 Gateway API가 K3s·인스턴스 대상·Cilium kube-proxy 대체에서 | 돈다. 파드 신원 웹훅이 넣은 자격으로 VPC를 이름 태그로 찾고, ALB `gachita-dev`(internet-facing, 영역 둘), HTTPS 443(인증서는 호스트 이름으로 찾음), 대상 그룹(노드 NodePort, `/healthz`)을 만들고 노드를 넣음. 대상 healthy |
| 물결 3 배치 | 컨트롤러 파드에 `AWS_ROLE_ARN`·`AWS_WEB_IDENTITY_TOKEN_FILE`이 들어감 |
| ALB를 거친 E2E | 12단계 통과(경로 탈출 요청 하나는 API의 404 대신 ALB가 400으로 먼저 막음). 다른 호스트 404 |
| 격리 | 포트 규칙이 `gachita`의 다른 NodePort를 거절. `pg_hba`가 `profiles`→`trips`, `trips`→`profiles`를 거절. DB 주소는 `db-rw.gachita-db.svc.cluster.local` |
| 접기 | 마지막 전체 백업 21초 → edge 앱 지우기부터 ALB가 사라지기까지 약 35초 → 접는 묶음 22개 destroy 약 40초. 컨트롤러가 ALB·대상 그룹·보안 그룹을 모두 지워 VPC 삭제가 막히지 않음 |
| 다시 펴기(복구) | 사람 손 없이 17분 44초(구축 1~6단계 약 6분, 물결과 확인 약 11분). 6단계가 백업을 보고 `recover`를 고름. 접기 전 데이터(`trips` 2건, `profiles` 1건)가 그대로이고 새 타임라인(2)으로 WAL 보관이 이어짐 |

실제로 돌려서 찾아 고친 것: IAM이 OIDC 제공자를 만들 때 발급자 문서를 읽음(남는 묶음이 올리게 함), Ansible이 공개 키 JSON을 파이썬 표기로 올림, zsh 수식자로 깨진 역할 ARN, SSM 명령이 sh라 pipefail 실패, 백업 사이드카 128Mi에서 OOMKilled(256Mi/512Mi로), 태그 검색 API가 지운 자원을 몇 분 넘게 보여 줌(서비스마다 직접 물음).

**사람이 정할 것:** 이 저장소는 조직 설정으로 배포 키가 막혀 있다(`Deploy keys are disabled for this repository`). 그래서 이번 확인은 노드 안의 git 서버(`git://gitserver.argocd.svc.cluster.local/gachita.git`, 쿠버네티스 DNS)로 했다. 실제 GitHub 경로로 펴려면 배포 키 허용이나 다른 읽기 자격(GitHub App, 저장소 하나만 읽는 토큰)을 정해야 한다.

- 확인하지 못한 것: Cloudflare → ALB(레코드, Full(strict), 요청 수 제한 규칙), ACM 발급(이번엔 자체 서명 인증서를 잠시 넣음), GHCR에서 이미지 받기(같은 커밋을 빌드해 노드에 넣음), `infra` 워크플로를 GitHub에서 돌리기(develop에 병합되어야 함).
