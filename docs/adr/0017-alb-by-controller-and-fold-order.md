# ADR-0017: ALB는 AWS Load Balancer Controller가 만들고, 펴기·접기는 그 의존성 순서로 한다

* **상태:** 제안, 2026-11-13
  * 채택(지환, 11/13): 들어오는 길은 ALB, ALB는 AWS Load Balancer Controller가 만들고 그 컨트롤러는 Argo CD로 관리한다. Traefik은 쓰지 않는다. 기획안과 요구사항을 넘는 구성은 하지 않는다.
  * 제안(이 문서): 자원마다 누가 만드는지의 경계, 펴기·접기의 순서와 그 순서를 지키는 검사.
* **관련:** T53(#90, 펴기·접기 워크플로), T51(#88), T52(#89), T54(#91), T24, T27, ADR-0016(초안: 기본 배치·Postgres 하나·ALB 선택), ADR-0011(OIDC), ADR-0012(구축 단계), ADR-0013(물결)

## 배경

- 지환님 목표(11/13): 코드만으로 환경 전체를 펴고 접고, 여러 번 되풀이해도 남는 것이나 충돌이 없어야 한다.
- ALB는 Terraform, Ansible, 스크립트로도 만들 수 있다. 지환님은 컨트롤러로 정했다. 컨트롤러가 만들면 ALB가 **Terraform 상태 밖**에 생긴다. 그래서 '무엇이 무엇보다 먼저 있어야 하는지'를 정하지 않으면, 펼 때는 경로가 열리지 않고 접을 때는 ALB가 남아 VPC 삭제를 막는다.
- 이 문서는 ADR-0016(초안)이 정한 기본 배치(한 대, Postgres 하나, Cloudflare → ALB → API의 NodePort)를 전제로 한다.

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
| 남는 묶음(T51) | 데이터 버킷(백업), 발급자 버킷, ACM 인증서와 Cloudflare의 검증 레코드(DNS만) | Terraform | 남김. 다시 펼 때 다시 만들지 않음(인증서를 다시 받지 않음) |
| 접는 묶음 1단계 | VPC, 공개 서브넷 둘(ALB용 태그 `kubernetes.io/role/elb=1`), 인터넷 게이트웨이, 경로, S3 엔드포인트, 노드 보안 그룹, EC2 한 대, 노드 역할, 서비스 계정 OIDC 제공자, 파드 역할(External Secrets, Postgres 백업, **ALB 컨트롤러**) | Terraform | 지움 |
| 클러스터 바닥 | K3s, Cilium, 발급자 공개 키, Argo CD, 뿌리 앱 | 첫 부팅 + Ansible 7단계 | 서버와 함께 사라짐 |
| 클러스터 위 | 컨트롤러들(ALB 컨트롤러 포함), DB, API, Gateway·HTTPRoute | Argo CD 물결 | 서버와 함께 사라짐 |
| **ALB 쪽** | ALB(이름 고정 `gachita-dev`), 리스너, 대상 그룹, ALB 보안 그룹 둘(앞단·뒷단), 노드 보안 그룹에 더한 규칙 | **ALB 컨트롤러** | Gateway를 지우면 컨트롤러가 지움 — **Terraform이 지우기 전에** |
| 접는 묶음 2단계 | Cloudflare `gachita` 레코드(프록시) → ALB 주소 | Terraform(ALB를 이름으로 읽음) | 1단계보다 먼저 지움 |

- 컨트롤러가 만드는 AWS 자원에는 `Project=gachita`가 붙는다(차트 값 `defaultTags`). 같이 쓰는 계정에서 우리 것을 태그로 가린다(ADR-0011).
- Git에는 계정마다 다른 값을 적지 않는다. 인증서는 리스너의 호스트 이름(`gachita.mangowhois.ai`)으로 컨트롤러가 찾고(컨트롤러 문서 'Certificate Discovery'), 서브넷은 태그로 찾는다. 컨트롤러에 넘길 VPC ID와 역할 ARN은 구축 단계가 Terraform 값을 받아 넘긴다(T50).
- 원본 보호는 `LoadBalancerConfiguration`의 `sourceRanges`에 Cloudflare 대역을 적어 컨트롤러가 앞단 보안 그룹을 만들게 한다. 대역은 자주 바뀌지 않아 Git에 둔다.

### 2. 펴기 순서와 각 단계가 끝났는지 보는 것

| 순서 | 하는 일 | 앞에 있어야 하는 것 | 끝났는지 |
|---|---|---|---|
| 1 | 남는 묶음 적용(보통 바뀔 것 없음) | 계정 묶음 | ACM 인증서 `ISSUED` |
| 2 | 접는 묶음 1단계 적용 | 1 | EC2 실행 중 |
| 3 | 첫 부팅과 구축 1~6단계(K3s → Cilium → 발급자 공개 키 → Argo CD → 뿌리 앱) | 2(서버, 배포 키, 발급자 버킷) | 단계 기록 파일 `6-root.done`(SSM으로 읽음) |
| 4 | 물결 0~2: 규칙과 CRD → 운영자(cert-manager, CloudNativePG, External Secrets) → 파드 신원 웹훅, 백업 플러그인, 비밀 값 저장소 | 3 | 앱 Healthy |
| 5 | 물결 3: **ALB 컨트롤러**와 Postgres | 4의 **파드 신원 웹훅**(컨트롤러의 AWS 자격이 웹훅이 넣는 토큰에서 옴 — 웹훅보다 먼저 뜨면 자격 없이 뜸), cert-manager(웹훅 인증서), 2의 컨트롤러 역할·서브넷 태그, 3의 발급자 공개 키 | 앱 Healthy |
| 6 | 물결 4: API(서비스는 NodePort) | 5의 Postgres | 앱 Healthy |
| 7 | 물결 5: Gateway·HTTPRoute → 컨트롤러가 ALB를 만들고 노드를 대상에 넣음 | 5의 컨트롤러, 6의 API, 1의 인증서 | Gateway `Programmed`, 대상 건강 |
| 8 | 접는 묶음 2단계: Cloudflare 레코드 → ALB | 7의 ALB | 레코드가 ALB 주소를 가리킴 |
| 9 | 확인: 구축 7단계(물결·WAL 보관) + 실제 주소 E2E(T54) | 8 | `https://gachita.mangowhois.ai/healthz` 200, E2E 통과 |

- 지금 물결(ADR-0013)에서 바뀌는 것은 하나다: 컨트롤러는 파드 신원 웹훅이 건강해진 **뒤** 물결(3)에 둔다. 같은 물결에 두면 웹훅이 준비되기 전에 컨트롤러 파드가 떠 AWS 자격 없이 돌 수 있다(웹훅은 실패해도 파드를 막지 않음: `failurePolicy: Ignore`).

### 3. 접기 순서

| 순서 | 하는 일 | 왜 이 순서 | 끝났는지 |
|---|---|---|---|
| 1 | 마지막 전체 백업(T52) | 클러스터가 살아 있을 때만 됨 | 백업 완료 |
| 2 | 접는 묶음 2단계 지움(Cloudflare 레코드) | 사라질 ALB를 사용자가 보지 않게 | 레코드 없음 |
| 3 | `edge` 앱(Gateway)을 지움 → 컨트롤러가 ALB·대상 그룹·보안 그룹·노드 보안 그룹 규칙을 지움 | 컨트롤러가 살아 있어야 지움. ALB가 남으면 비용이 나고 그 네트워크 카드가 서브넷·VPC 삭제를 막음 | 태그 `Project=gachita`로 찾은 ALB·대상 그룹 0개, ALB의 네트워크 카드 0개 |
| 4 | 접는 묶음 1단계 destroy | 3 | Terraform 끝 |
| 5 | 남은 것 확인 | | 태그로 찾은 것이 남는 묶음과 상태 버킷뿐 |

- **3이 실패할 때(클러스터가 이미 망가짐):** 같은 태그(`Project=gachita`와 컨트롤러의 클러스터 태그)로 ALB·대상 그룹·보안 그룹을 찾아 지우는 정리 단계를 둔다. 적용 역할에 그 태그 조건으로 ELB 삭제 권한이 필요하다.
- 되풀이해도 같은 결과: ALB 이름은 고정이고 DNS 주소만 바뀐다(2단계가 매번 고침). 인증서·버킷은 남는 묶음이라 다시 만들지 않는다. 발급자 공개 키는 서버마다 새로 올린다(구축 4단계).

### 4. 하지 않는 것(기획안·요구사항 밖)

external-dns(Cloudflare 토큰을 클러스터에 넣게 됨), ALB의 WAF·접근 기록·Authenticated Origin Pulls, 사설 서브넷과 NAT, 노드 여럿, CloudWatch SLO 대시보드는 지금 하지 않는다. 필요해지면 그때 따로 정한다.

## 계획(PR 순서)

| 순서 | 티켓 | 내용 |
|---|---|---|
| 1 | ADR-0016 병합 | 기본 배치·Postgres 하나·ALB 선택(다른 세션 초안) |
| 2 | T25(#74) 보강 | 권한 경계에 ALB 컨트롤러가 쓰는 ELB·EC2 보안 그룹·ACM 읽기(태그 조건), 적용 역할에 3절의 태그 조건 ELB 삭제와 Cloudflare 레코드용 ELB 읽기 |
| 3 | T24(#77) 다시 | Terraform: 공개 서브넷 둘과 태그, 터널 제거, 컨트롤러 역할, 접는 묶음 2단계(레코드). Postgres 하나(ADR-0016) |
| 4 | T51(#88) | 남는 묶음 분리(버킷 둘, ACM과 검증 레코드) |
| 5 | GitOps(새 티켓 또는 T24) | ALB 컨트롤러 앱(물결 3), Traefik·cloudflared 제거, GatewayClass `gateway.k8s.aws/alb`, `LoadBalancerConfiguration`(이름 고정, internet-facing, `sourceRanges`), API 서비스 NodePort와 포트 규칙 예외 하나 |
| 6 | T50(#87) | VPC ID·역할 ARN·버킷을 Git 밖에서(구축 단계가 넘김) |
| 7 | T53(#90) | `infra-up`·`infra-down` 워크플로가 2·3절의 순서와 검사를 그대로 |
| 8 | 처음 접었다 펴기 | 실제 계정에서 펴기 → 확인 → 접기 → 남은 것 확인 → 다시 펴기. 비용·시간을 PR에 |

**처음 접었다 펴기 전에 사람이 할 것:** Cloudflare API 토큰(터널이 빠져 DNS 편집만)과 계정·영역 번호, 이미지 받기 토큰(`read:packages`)을 `gh secret set`/`gh variable set`으로 넣기, 배포 키 승인, `account/`와 상태 버킷 처음 한 번.

## 결과

- ALB가 Terraform 밖에 생기는 대신 펴기·접기에 순서가 생기고, 그 순서는 워크플로(T53)가 지킨다.
- 컨트롤러 물결이 하나 뒤로 간다(웹훅 뒤). Postgres와 같은 물결이라 전체 시간은 거의 같다.
- 확인하지 못한 것: v3.6 컨트롤러의 Gateway API가 EKS가 아닌 K3s, 인스턴스 대상, Cilium의 kube-proxy 대체에서 도는지(안 되면 같은 컨트롤러에 Ingress), 컨트롤러가 Gateway를 지울 때 걸리는 시간, ALB의 네트워크 카드가 풀리는 시간. 모두 처음 접었다 펴기에서 잰다.
