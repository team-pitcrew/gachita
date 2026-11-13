# ADR-0013: 한 대짜리 클러스터의 길·격리·포트·가용성

* **상태:** 제안, 2026-11-13 (1절·3절과 10절의 한 대 전제는 [ADR-0015](0015-split-nodes-private-subnets-alb.md)가 대신함)
* **관련:** T24(#30), T26(#32), T27, T28, ADR-0010(주소·Cloudflare), ADR-0011(OIDC), ADR-0012(구축·노드 사양)

## 배경

지환님이 11/13에 정한 것: 지금은 노드 하나로 하되 격리는 네임스페이스와 네트워크로 한다. API를 어떻게 열지, 리버스 프록시, CNI와 네트워크 정책, 포트 관리(동적이되 관리되는 방향), S3와 CDN, Cloudflare 가장자리, 공식 오픈소스 컨트롤러를 컨트롤 플레인에 두고 관리, 가용성 제어, 필요하면 LB, 차량 앱(Pleos)의 클라우드 연결 안정성을 한 설계로 묶는다. 주소는 `gachita.mangowhois.ai` 하나, 가장자리는 Cloudflare(ADR-0010).

## 결정

### 1. 요청이 가는 길

```
폰·차량 ─HTTPS(HTTP/3)─▶ Cloudflare 엣지(서울): TLS, WAF·DDoS, 정적 파일 캐시
   ─Tunnel(서버가 밖으로 연 연결)─▶ cloudflared ×2        [edge]
   ─▶ Traefik ×2 (Gateway "public", 리스너 web:8000)       [edge]
   ─HTTPRoute gachita(요청 수 제한)─▶ API ×2 (http)        [gachita]
   ─▶ Postgres db (postgresql)                             [gachita-trips] / [gachita-profiles]
백업: 각 Postgres의 서비스 계정 역할 ─▶ S3 데이터 버킷 postgres/trips/, postgres/profiles/
```

| 층 | 무엇 | 왜 |
|---|---|---|
| 가장자리 | Cloudflare(무료 요금제) | 차량과 폰에 가까운 서울 엣지에서 TLS를 끝내고, 공격 차단과 캐시를 맡김. 서버 IP를 숨김 |
| 서버로 가는 길 | **Cloudflare Tunnel** | 서버에 들어오는 포트가 0개. 원본 인증서와 Cloudflare IP 대역 관리가 없음 |
| 리버스 프록시 | **Traefik v3.7(Gateway API)** | 경로를 쿠버네티스 표준(Gateway API v1.6.3)으로 적음. 프록시를 바꿔도 경로 선언은 그대로(GatewayClass만 바꿈) |
| 로드 밸런서 | **두지 않음** | 아래 3 |

- 공개 인증서는 Cloudflare가 끝내므로 Let's Encrypt와 `sslip.io`는 만들지 않는다(처음부터 터널). 클러스터가 아직 없어 옮길 비용이 없고, 서버를 새로 만들 때마다 인증서를 다시 받는 일(발급 한도)도 없다.
- 터널의 경로 규칙은 Cloudflare 쪽(Terraform `edge.tf`)에 두고 클러스터의 cloudflared는 토큰만 가진다. 경로는 `gachita.mangowhois.ai` → `traefik.edge:80` 하나다. 나머지는 404.

### 2. API를 여는 방법

- 밖에 여는 것은 Gateway `edge/public` 하나다. 경로(HTTPRoute)를 붙일 수 있는 네임스페이스는 `gachita.io/expose: "true"` 라벨이 있는 곳뿐(지금 `gachita` 하나).
- 웹앱과 API는 같은 이름에서 나간다(ADR-0010). 경로 `/` 전체를 API 서비스로 보내고, API가 `/api/`와 정적 파일을 나눈다.
- 요청 수 제한은 Traefik 미들웨어로 사용자 주소당 초당 20회(순간 40). 클러스터 안에서는 출발지가 cloudflared로 보이므로 Cloudflare가 넣는 `CF-Connecting-IP`로 센다. Traefik에는 cloudflared만 닿게 막았으므로(5) 이 머리글은 믿을 수 있다.

### 3. 로드 밸런서를 두지 않는 이유

노드가 하나라 AWS LB(ALB·NLB)는 가용성을 더하지 못하고 비용만 는다. 균형은 이미 두 곳에서 된다.

- Cloudflare: cloudflared 하나가 Cloudflare 두 지역에 연결을 4개 연다. 커넥터 2개면 8개이고, Cloudflare가 살아 있는 연결로 나눈다.
- 클러스터 안: Traefik 2개와 API 2개를 쿠버네티스 Service(Cilium eBPF)가 나눈다.

노드를 늘리면 cloudflared와 Traefik을 노드마다 퍼뜨리면 된다(이미 topologySpread가 걸려 있음). 터널을 버리고 AWS 안에서 받아야 할 때 NLB를 둔다.

### 4. CNI와 네트워크 정책: Cilium

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| K3s 기본(flannel + kube-router) | 따로 깔 것 없음 | 표준 NetworkPolicy만. 밖으로 나가는 길을 이름으로 막지 못함(IP 대역만). 막혔는지 볼 도구가 없음 |
| Calico | 성숙, 표준·확장 정책 | FQDN 정책은 유료판. 흐름 보기 약함 |
| **Cilium 1.20.4** | eBPF, kube-proxy 대체. 이름(FQDN)으로 나가는 길을 막음. Hubble로 흐름을 봄. CNCF 졸업 프로젝트 | 메모리 약 0.4 GiB(ADR-0012 표). 쿠버네티스 지원 범위(1.33~1.36)에 K3s 판을 맞춰야 함 |

- CNI는 클러스터가 없는 지금 정하는 것이 가장 싸다(바꾸려면 클러스터를 다시 만들어야 함). T28의 CNI 부분을 여기서 정한다. 저장 장치(EBS CSI)는 T28에 남긴다.
- **규칙: 클러스터 안 파드끼리는 표준 NetworkPolicy, 클러스터 밖(API 서버·S3·STS·구글·Cloudflare)은 CiliumNetworkPolicy.** 표준 정책은 CNI를 바꿔도 그대로 읽힌다. 이름으로 막기와 API 서버(`kube-apiserver` 개체)는 Cilium만 할 수 있다.
- 데이터 경로 네임스페이스 넷은 **기본 전부 차단**(`components/data-plane`)하고 아래 표만 연다. 컨트롤러 네임스페이스(argocd, cert-manager, cnpg-system, external-secrets, pod-identity)는 1단계에서 막지 않고, 실제 클러스터에서 Hubble로 흐름을 본 뒤 조인다.
- 서버의 IMDS 홉 1: 파드는 서버의 IAM 역할에 닿지 못한다. AWS 권한은 서비스 계정 역할로만(ADR-0011).

### 5. 네임스페이스로 나눈 격리

| 네임스페이스 | 무엇 | 들어오는 길 | 나가는 길 |
|---|---|---|---|
| `edge` | cloudflared, Traefik | Traefik ← cloudflared(web)만 | cloudflared → Cloudflare(7844 TCP·UDP), Traefik, Traefik → API(http), API 서버 |
| `gachita` | API | ← Traefik(http)만 | 두 DB(postgresql), 구글 OAuth(443) |
| `gachita-trips` | 여행 Postgres | ← API(postgresql), ← CNPG 운영자(status) | API 서버, STS, S3(443) |
| `gachita-profiles` | 프로필 Postgres | 위와 같음 | 위와 같음 |

- 여행 DB와 프로필 DB는 서로 닿지 않고, edge에서도 닿지 않는다(T26).
- IAM도 나뉜다: 여행 DB의 역할은 `postgres/trips/`만, 프로필 DB의 역할은 `postgres/profiles/`만 읽고 쓴다(ADR-0011).
- DB 접속 정보는 각 DB 네임스페이스의 Secret `db-app`에 있다. `gachita`의 서비스 계정 `db-reader`는 그 Secret 하나만 `get`할 수 있고(`resourceNames`), External Secrets가 그 권한으로 `gachita`에 `db-urls`를 만든다.
- 앱 비밀 값을 읽는 저장소(ClusterSecretStore `ssm`)는 `gachita`와 `edge`만 쓸 수 있다.
- 네임스페이스마다 Pod Security `baseline`을 강제하고 `restricted`는 경고로 둔다.

### 6. 포트 관리(동적이되 한곳에서)

숫자는 컨테이너 정의 한 곳에만 둔다. 나머지는 이름으로 가리켜, 포트가 바뀌어도 고칠 곳이 하나다.

| 층 | 규칙 | 지키는 방법 |
|---|---|---|
| 밖 | 443(Cloudflare 엣지)만 | 보안 그룹 들어오는 규칙 0개(Terraform) |
| 노드 | 데이터 경로 네임스페이스에서 NodePort·LoadBalancer·hostPort·hostNetwork 금지 | ValidatingAdmissionPolicy `gachita-port-rules`(쿠버네티스 내장, 컨트롤러 없음). API 서버가 거절 |
| 파드 | 컨테이너 포트에는 이름 필수. Service `targetPort`, NetworkPolicy `port`는 이름 | 같은 정책이 이름 없는 포트를 거절 |
| 서비스 | HTTP 서비스는 80 `http`, Postgres는 5432 `postgresql`(CloudNativePG 고정) | 선언 |

| 이름 | 숫자 | 어디에 |
|---|---|---|
| `http` | 8787 | API 컨테이너(`apps/api/base/deployment.yaml`). 서비스 80 |
| `web` | 8000 | Traefik 진입점(차트 값). 서비스 80, Gateway 리스너 |
| `metrics` | 2000 | cloudflared(`/ready`) |
| `postgresql`·`status` | 5432·8000 | CloudNativePG 인스턴스 |
| - | 6443 | 쿠버네티스 API. 밖에 열지 않고 SSM 포트 포워딩으로 |
| - | 7844 | cloudflared → Cloudflare(나가는 길) |

대역: VPC `10.10.0.0/16`, 파드 `10.42.0.0/16`, 서비스 `10.43.0.0/16`(클러스터 DNS `10.43.0.10`). 지금까지의 VPC `10.42.0.0/16`은 K3s 파드 대역과 겹쳐 바꿨다(ADR-0012).

### 7. S3와 CDN

| 무엇 | 어디 | 공개 |
|---|---|---|
| 웹앱의 정적 파일 | API가 내보내고 **Cloudflare가 엣지에 캐시**(CDN) | 공개 |
| API 응답 | 캐시하지 않음(API가 `cache-control: no-store`) | - |
| Postgres 백업(WAL 포함) | S3 데이터 버킷 `postgres/<db>/` | 비공개, 버전 관리, 30일 뒤 지난 버전 삭제 |
| 클립·사진(나중) | S3 데이터 버킷. API가 짧게 서명한 주소로 내려줌 | 비공개. **개인 데이터는 CDN에 올리지 않는다** |
| 서비스 계정 발급자의 공개 키 | S3 발급자 버킷(두 파일) | 공개(공개 키) |

CloudFront는 만들지 않는다(ADR-0010). Cloudflare가 CDN을 겸한다. 정적 파일을 서버에서 떼어 S3에서 바로 내보내야 하면(서버가 멈춰도 웹앱이 떠야 할 때) 그때 Cloudflare → S3 경로를 따로 정한다.

### 8. 컨트롤러: 공식 배포를 1급으로, 컨트롤 플레인에

| 컨트롤러 | 판 | 배포원 | 누가 올리나 |
|---|---|---|---|
| K3s(CoreDNS, local-path, metrics-server 포함) | v1.36.6+k3s1 | k3s-io 공식 설치 스크립트(같은 태그) | 구축 2단계 |
| Cilium | 1.20.4 | helm.cilium.io 공식 차트 | 구축 3단계(K3s HelmChart) |
| Argo CD | v3.6.1 | argoproj 공식 매니페스트 | 구축 5단계 |
| Gateway API CRD | v1.6.3 | kubernetes-sigs 공식 | 물결 0 |
| cert-manager | v1.21.3 | charts.jetstack.io 공식 차트 | 물결 1 |
| CloudNativePG | 1.30.1(차트 0.29.1) | cloudnative-pg 공식 차트 | 물결 1 |
| External Secrets | v2.14.0 | charts.external-secrets.io 공식 차트 | 물결 1 |
| Traefik | v3.7.17(차트 42.3.2) | traefik.github.io 공식 차트 | 물결 1 |
| Barman Cloud 플러그인 | v0.16.0(차트 0.9.0) | cloudnative-pg 공식 차트 | 물결 2 |
| 파드 신원 웹훅 | v0.6.19 | aws/amazon-eks-pod-identity-webhook의 `deploy/` | 물결 2 |
| cloudflared | 2026.10.7 | cloudflare/cloudflared 공식 이미지 | 물결 5 |

- K3s가 같이 싣는 Traefik과 서비스 LB(klipper)는 끈다. 판을 우리가 고정하고 Argo CD로 관리하기 위해서다.
- 컨트롤러는 모두 `nodeSelector: node-role.kubernetes.io/control-plane: "true"`와 컨트롤 플레인·`CriticalAddonsOnly` 테인트를 견디는 설정을 갖는다. 지금은 노드가 하나라 차이가 없지만, 일꾼 노드를 더하고 서버에 `CriticalAddonsOnly=true:NoExecute`(K3s 문서의 전용 서버 방법)를 걸면 컨트롤러는 서버에, 앱은 일꾼에 저절로 나뉜다. cloudflared와 API는 일꾼으로 퍼지도록 묶지 않는다.
- 판은 `bootstrap/`의 Application과 `backend/infra/cluster`에만 있다.

### 9. Argo CD 물결

| 물결 | 앱 | 다음 물결로 가는 조건 |
|---|---|---|
| 0 | `cluster-base`(포트 규칙), `gateway-api`(CRD) | 적용됨 |
| 1 | `cert-manager`, `cnpg`, `external-secrets`, `traefik` | 각 운영자 Deployment Available |
| 2 | `barman-cloud`, `pod-identity-webhook`, `secret-stores` | 플러그인·웹훅 준비, ClusterSecretStore Ready(실제 클러스터에서는 SSM에 닿아야 함) |
| 3 | `db-trips`, `db-profiles` | CNPG Cluster `Cluster in healthy state` |
| 4 | `api` | ExternalSecret 셋 Ready, Deployment Available(두 DB에 닿아야 준비) |
| 5 | `edge` | Gateway Programmed, HTTPRoute Accepted, cloudflared 준비 |

알려진 함정과 처리(근거는 Argo CD v3.6.1 문서·소스):

- **자식 앱의 건강을 기다리기**: Application의 건강 판정은 Argo CD 1.8에서 빠졌다. `argocd-cm`에 `resource.customizations.health.argoproj.io_Application`을 넣어야 뿌리 앱이 앞 물결의 건강을 기다린다(`backend/infra/cluster/argocd/argocd-cm.yaml`, 문서 `operator-manual/health.md`).
- **CRD가 아직 없을 때**: 물결로 CRD를 먼저 올리지만, 사용자 정의 자원을 담은 앱에는 `SkipDryRunOnMissingResource=true`를 둔다. 큰 CRD를 싣는 차트(Gateway API, cert-manager, CNPG, External Secrets, Traefik)는 `ServerSideApply=true`(클라이언트 적용의 주석 크기 한도를 피함).
- **건강 판정이 있는지**: v3.6.1에 `postgresql.cnpg.io/Cluster`, `external-secrets.io/ExternalSecret`·`ClusterSecretStore`, `gateway.networking.k8s.io/Gateway`·`HTTPRoute`, `cert-manager.io/Certificate`가 들어 있음을 확인했다. `CiliumNetworkPolicy`와 플러그인의 `ObjectStore`는 없다(만들어지면 건강).
- **HTTPRoute를 둘 곳**: API 앱(물결 4)에 두면 Gateway(물결 5)가 없어 HTTPRoute가 건강해지지 않고 물결 4가 끝나지 않는다. 그래서 HTTPRoute는 `edge` 앱이 `gachita` 네임스페이스에 만든다. 밖으로 여는 일은 API가 건강해진 뒤에 일어난다.
- **재시도·자동 복구·가지치기**: 모든 자식 앱이 자동 동기화, 가지치기, 자동 복구, 재시도 5회(10초부터 두 배, 최대 3분).
- **데이터 보호**: DB 앱에는 연쇄 삭제 finalizer를 두지 않고, CNPG `Cluster`에 `Prune=false,Delete=false`. Git에서 실수로 지워도 DB는 남는다.
- **선택 비밀 값**: 구글 값이 SSM에 없으면 ExternalSecret이 Secret을 만들지 않고 Ready가 된다(`deletionPolicy: Delete`, External Secrets 소스에서 확인). 그래서 물결 4가 구글 값 때문에 멈추지 않는다.

### 10. 가용성

| 장치 | 하는 일 |
|---|---|
| 우선순위 클래스 | `gachita-platform`(컨트롤러) > `gachita-data`(Postgres) > `gachita-app`(API). 메모리가 모자라면 API부터 밀려난다 |
| kubelet 예약 | OS 512 MiB, K3s 768 MiB, 축출 기준 256 MiB. 파드가 노드 전체를 멈추지 못한다 |
| Postgres | 메모리 요청=한도. 쓰는 양이 요청을 넘지 않아 축출 순서에서 뒤로 간다 |
| 두 개씩 | API·Traefik·cloudflared 2개, 순차 교체(`maxUnavailable: 0`), 중단 예산(`minAvailable: 1`) |
| 프로브 | API 준비 = 두 DB에 닿음(`/healthz`), 살아 있음 = 프로세스만(TCP). DB가 잠깐 멈췄다고 API를 다시 띄우지 않는다 |
| EC2 자동 복구 | 하드웨어 장애 때 같은 서버(디스크·설정 그대로) |
| 다시 세우기 | 클러스터는 Git에서(Terraform → 구축 7단계 → 물결), 데이터는 S3 백업(WAL로 시점 복구) |

무엇이 죽으면 어떻게 되나:

| 죽은 것 | 영향 | 되살아나는 길 |
|---|---|---|
| API 파드 하나 | 없음(다른 하나가 받음) | Deployment가 새로 띄움 |
| cloudflared 하나 | 없음(다른 커넥터의 연결로) | 같음 |
| Postgres 하나(trips) | 여행 쓰기·읽기 실패, 프로필은 됨. API는 준비가 빠져 요청을 덜 받음 | CNPG가 다시 띄움. 디스크가 상하면 S3에서 복구 |
| Argo CD | 지금 돌아가는 것은 영향 없음. 새 변경이 안 들어감 | `gachita-converge --tags argocd` |
| 서버 | 전체 중단. Cloudflare가 530을 돌려줌 | EC2 자동 복구, 안 되면 서버 교체 후 구축 단계와 백업 복구 |
| Cloudflare | 밖에서 닿지 않음 | 기다림. 급하면 터널을 끄고 프록시 레코드로(ADR-0010의 다른 선택) |

### 11. 차량 앱(Pleos)의 클라우드 연결 안정성

차는 터널·지하 주차장·기지국 전환으로 통신이 자주 끊긴다. 서버 쪽에서 할 수 있는 것과 앱이 해야 할 것을 나눈다.

**서버·가장자리(이 설계에 들어 있음)**
- 서울 엣지에서 TLS를 끝내 왕복이 짧다. HTTP/3(QUIC)은 망이 바뀌어도 연결을 이어 가는 기능(연결 이주)이 있다.
- 서버를 갈아도 이름과 엣지 IP가 그대로다(Cloudflare 애니캐스트, 터널 ID 고정). 차량의 DNS 캐시나 고정 주소가 낡지 않는다.
- 배포 중에도 끊기지 않는다(두 개씩, 순차 교체, 준비 프로브).
- 요청 수 제한은 사용자 주소 기준이고 넉넉하다. 통신사 NAT 뒤의 여러 대가 같은 주소를 쓰기 때문이다.
- 서버가 멈추면 Cloudflare가 530(터널 없음)이나 502를 돌려준다. 앱은 이것을 '다시 시도할 수 있는 실패'로 다룬다.

**앱(T7 차량 앱, T39 발화 올리기에 넘김. 서버 API 변경이 필요한 것은 backend-api 담당과 맞춤)**
- 쓰기 요청에 멱등 키(`Idempotency-Key`). 같은 요청을 다시 보내도 한 번만 반영된다. 서버 쪽 구현이 필요하다.
- 끊긴 동안의 쓰기는 기기에 보관했다가 연결이 돌아오면 순서대로 보낸다(T39의 '모아 두었다 보냄'). 화면은 `frontend/spec/car.md`의 '통신 끊김 / 다시 연결' 상태를 따른다.
- 다시 시도: 지수 백오프와 지터(1·2·4·8초, 최대 30초). 다시 시도할 것: 연결 실패, 시간 초과, 408·429·502·503·504·520~530. 다시 시도하지 않을 것: 그 밖의 4xx.
- 시간 제한: 연결 5초, 응답 10초. 짧은 요청을 여러 번이 긴 요청 하나보다 낫다.
- 상태 읽기는 `ETag`·`If-None-Match`로 바뀐 것만 받는다(304). 서버 쪽 구현이 필요하다.
- 망 상태는 Android `ConnectivityManager`의 콜백으로 보고, 끊겼을 때는 요청을 쌓기만 한다.
- Pleos가 앱의 백그라운드 통신이나 망 사용을 어떻게 제한하는지는 확인하지 않았다(에뮬레이터·실차에서 T7).

## 결과

- 지금 선언의 Traefik 인그레스·Let's Encrypt·`sslip.io`·단일 Postgres가 Gateway API·Cloudflare Tunnel·DB 둘로 바뀐다. T27의 '가장자리를 Cloudflare로'와 T26의 'DB를 파드로 나누고 격리'의 선언 부분이 이 구조에 들어온다. T26의 확인(실제로 막히는지, 질의 시간 제한)은 클러스터가 선 뒤에 한다.
- 데이터가 들기 전에 DB를 둘로 나누므로, T26이 걱정한 '이미 든 데이터를 옮기는 절차'가 필요 없다.
- 노드 메모리를 더 쓴다(Cilium, External Secrets, 파드 신원 웹훅, cloudflared). 노드를 t4g.large로 올리는 이유다(ADR-0012).
- 확인한 것과 못 한 것은 PR과 `backend/infra/gitops/README.md`의 '확인한 것'에 적는다.
