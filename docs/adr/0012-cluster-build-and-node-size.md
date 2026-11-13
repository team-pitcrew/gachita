# ADR-0012: 클러스터는 Terraform → 얇은 첫 부팅 → Ansible 단계로 세우고, 노드는 t4g.large

* **상태:** 일부 채택, 2026-11-13
  * 채택(지환, 11/12~13): 클러스터 구축은 Terraform 필수에 단계가 분명한 구축 스크립트(Ansible 가능), 노드 사양은 구성 요소별 요청·한도의 합으로 숫자로 정함, 다른 프로젝트와 같이 쓰는 지금 계정.
  * 제안(승인 전): t4g.large와 그 비용(월 약 $69), 실제 자원을 만드는 것, 배포 키.
  * 대신함(11/13): 노드 위 구성(Traefik·cloudflared·터널 토큰 없음, Postgres 하나, ALB 컨트롤러)과 요청 합계는 [ADR-0016](0016-slo-capacity-single-postgres.md) 3절, 들어오는 길과 펴기·접기 순서는 ADR-0017. 아래 표는 그에 맞춰 고쳤다.
* **관련:** T24, #30, T25(ADR-0011), T26, T27(ADR-0010), T28, ADR-0013

## 배경

- 클러스터 구축은 Terraform이 필수이고, 클러스터를 세우는 스크립트는 Ansible을 써도 된다. 단계가 분명해야 한다(지환, 11/12).
- 지금은 첫 부팅 스크립트(`user_data.sh.tftpl`) 한 덩어리가 K3s → Argo CD → 뿌리 앱을 올린다. 어디서 멈췄는지 알기 어렵고, 다시 돌리면 같은 결과가 된다는 보장이 없고, 고치려면 서버를 새로 만들어야 한다.
- 한 대에 K3s, Argo CD, cert-manager, CloudNativePG, Postgres 하나(ADR-0016), API, Cilium(ADR-0013), External Secrets, AWS Load Balancer Controller(ADR-0017)가 올라간다. 동기화 중에 메모리가 모자라 파드가 죽거나 Argo CD가 흔들리면 안 된다.
- 서버에 SSH를 열지 않는다. 들어갈 때는 SSM 세션을 쓴다.

## 검토한 선택

**클러스터를 세우는 방식**

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| 첫 부팅 스크립트 한 덩어리(지금) | 파일 하나 | 단계·검사가 없음. 다시 돌리기 어려움. 바꾸면 서버 교체 |
| Ansible을 밖에서 SSH로 | 흔한 방식 | 22를 열어야 함. 설계와 어긋남 |
| Ansible을 밖에서 SSM 연결 플러그인으로 | 포트를 열지 않음 | 파일 전송용 S3 버킷, 실행하는 쪽에 세션 플러그인·컬렉션 필요. 느리고 실패 지점이 많음 |
| **서버 안에서 `ansible-pull`(로컬 연결)** | 포트를 열지 않음. 저장소의 플레이북을 그대로 받아 돎. 다시 돌릴 때는 SSM Run Command로 같은 명령 | 서버에 ansible-core를 깐다. 저장소를 읽을 자격(11/14부터 읽기 전용 토큰)이 서버에 있어야 함(Argo CD도 어차피 필요) |

**Argo CD보다 먼저 있어야 하는 것(CNI, Argo CD 자신)을 누가 관리하나**

- Cilium은 파드 네트워크라 Argo CD 파드보다 먼저 있어야 한다. K3s의 helm-controller가 `HelmChart`(`bootstrap: true`, 호스트 네트워크로 설치)로 올린다. Argo CD가 맡으면 Argo CD가 멈췄을 때 CNI를 고칠 길이 없다.
- Argo CD도 Ansible이 올린다. Argo CD가 자기 자신을 관리하면 잘못된 선언 하나로 Argo CD가 멈추고 되살릴 주체가 없다.

**비공개 이미지를 받는 자격**

| 선택 | 걸리는 점 |
|---|---|
| 노드의 `registries.yaml`(지금) | 노드의 모든 파드가 그 자격으로 비공개 이미지를 받음. 토큰을 바꾸면 K3s를 다시 시작해야 함 |
| **`gachita` 네임스페이스의 imagePullSecret(External Secrets가 SSM에서 만듦)** | 그 네임스페이스만 받음. 토큰을 바꾸면 한 시간 안에 저절로 반영 |

**비밀 값을 클러스터까지**

| 선택 | 걸리는 점 |
|---|---|
| 사람이 `kubectl create secret` | 기록이 없고 서버를 새로 만들 때마다 다시 넣어야 함 |
| Sealed Secrets·SOPS(암호문을 저장소에) | 비밀 값을 저장소에 넣지 않는다는 방침과 어긋남(암호문이라도). 키 관리가 또 생김 |
| **GitHub 비밀 값 → 워크플로(OIDC) → SSM → External Secrets** | SSM과 External Secrets가 하나씩 늘어남. 대신 비밀 값은 `gh secret set` 한곳에서 바꾸고, 서버를 새로 만들어도 저절로 들어감 |

## 결정

**층을 셋으로 나눈다.**

| 층 | 맡는 것 | 바꾸는 법 |
|---|---|---|
| Terraform(`backend/infra/terraform`) | AWS(네트워크, 서버, IAM, S3, SSM, ACM)와 Cloudflare(`gachita` 레코드, 요청 수 제한). ALB는 만들지 않음(컨트롤러) | PR 계획 → develop 수동 적용(ADR-0011) |
| 구축 단계(`backend/infra/cluster`, Ansible) | 서버 OS, K3s, Cilium, 서비스 계정 발급자, Argo CD, 뿌리 앱 | `gachita-converge`(SSM Run Command) |
| Argo CD(`backend/infra/gitops`) | 나머지 전부를 물결 순서로(ADR-0013) | PR 병합 |

**첫 부팅 스크립트는 얇게**: 패키지(ansible-core, git, AWS CLI) → SSM에서 저장소 읽기 토큰(git 자격 도우미) → `/usr/local/sbin/gachita-converge`(= `ansible-pull … site.yml`) 실행. 환경마다 다른 값(계정, 발급자 주소, 브랜치, 서비스 주소)만 Terraform이 `/etc/gachita/vars.yml`로 넘기고, 판은 저장소 한곳(`site.yml`, `argocd/kustomization.yaml`)에 고정한다.

**단계 일곱 개.** 각 단계는 먼저 이미 됐는지 보고, 끝나면 `/var/lib/gachita/bootstrap/<번호>-<이름>.done`에 시각을 남긴다. 로그(`/var/log/gachita/bootstrap.log`)의 작업 이름에 `[3/7 cilium]`처럼 단계가 붙어 멈춘 곳이 보인다. `--tags <이름>`으로 한 단계만 다시 돌린다.

| 단계 | 하는 일 | 끝났는지 보는 검사 |
|---|---|---|
| 1 os | 패키지, 파일 감시 한도 | apt·sysctl 결과 |
| 2 k3s | K3s v1.36.6+k3s1(같은 태그의 설치 스크립트, 바이너리 해시 확인). flannel·kube-proxy·네트워크 정책·traefik·servicelb 끔, Secret 암호화, kubelet 예약 | `k3s --version` 판, `/readyz` = ok, 발급자 = S3 주소 |
| 3 cilium | Cilium 1.20.4(K3s `HelmChart`, `bootstrap: true`), kube-proxy 대체 | DaemonSet 준비, 노드 Ready, `cilium-dbg status` |
| 4 oidc | 발급자 문서와 공개 키를 S3에 올림(서버를 새로 만들면 키가 바뀜) | 공개 주소의 키 = 클러스터의 키 |
| 5 argocd | 우선순위 클래스, Argo CD v3.6.1(+Application 건강 판정, 요청·한도, dex·알림 끔), 저장소 자격 | 구성 요소 다섯이 준비됨 |
| 6 root | 뿌리 앱(`backend/infra/gitops/bootstrap`) | 앱이 있음 |
| 7 verify | 물결이 끝까지 올라오길 기다림(최대 30분), 두 Postgres의 WAL 보관 | 모든 앱 Synced·Healthy(남은 앱 이름이 멈춘 물결), `ContinuousArchiving=True`(보관이 실패해도 DB는 Healthy라 물결로는 안 보임), 밖에서 `https://gachita.mangowhois.ai/healthz` 200 |

판 고르기: Cilium 1.20의 쿠버네티스 지원은 1.33~1.36이고(Cilium 문서 `compatibility`), Argo CD 3.6은 1.34~1.37이다. 그래서 K3s는 stable 채널의 1.37이 아니라 1.36의 최신(v1.36.6+k3s1, 11/3)으로 고정한다.

**노드 사양.** 공식 문서의 숫자는 K3s 서버 최소 2코어·2 GB(docs.k3s.io)뿐이다. Argo CD 매니페스트와 Cilium·Traefik·External Secrets·CloudNativePG·cert-manager·백업 플러그인 차트는 자원 기본값이 비어 있다(`resources: {}`, 11/13 확인). 그래서 아래 요청값은 이 구성의 어림이고, 각 선언에 넣었다. 메모리 단위 MiB.

| 구성 요소 | 개수 | 요청 | 한도 |
|---|---|---|---|
| OS·SSM 에이전트(`system-reserved`) | - | 512 | - |
| K3s 서버 프로세스(`kube-reserved`). 로컬 검증에서 RSS 1.6 GiB | - | 1,536 | - |
| 축출 여유(`eviction-hard`) | - | 256 | - |
| Cilium agent·operator·envoy | 3 | 384 | 1,536 |
| CoreDNS·metrics-server(K3s 기본값) | 2 | 140 | 170 |
| Argo CD(controller 384, repo-server 192, server 96, redis 32, appset 48) | 5 | 752 | 2,560 |
| cert-manager | 3 | 120 | 480 |
| CloudNativePG 운영자 + 백업 플러그인 | 2 | 144 | 576 |
| External Secrets | 3 | 120 | 480 |
| 파드 신원 웹훅 | 1 | 24 | 64 |
| AWS Load Balancer Controller(요청은 어림) | 1 | 64 | 256 |
| Postgres 하나 512 + 백업 사이드카 256(한도 512. 11/13 실제 계정에서 128은 접기 전 전체 백업 중 OOMKilled) | 2 | 768 | 1,024 |
| API | 2 | 192 | 512 |
| **파드 합계** | | **2,708** | **7,658** |

| 인스턴스 | 메모리 | 파드에 쓸 수 있는 것 | 요청 대비 | 서울 시간당(가격표 API, 11/13) | 한 달 |
|---|---|---|---|---|---|
| t4g.medium | 4 GiB | 1,792(계산값) | 151% — 파드가 다 올라가지 못함 | $0.0416 | $30.4 |
| **t4g.large** | 8 GiB | 5,498(11/13 실측, OS가 보는 메모리 7,802 MiB. 계산값 5,888) | 49% | $0.0832 | $60.7 |
| m7g.large | 8 GiB | 5,888(계산값) | 46% | $0.1003 | $73.2 |
| t4g.xlarge | 16 GiB | 14,080(계산값) | 19% | $0.1664 | $121.5 |

- '파드에 쓸 수 있는 것' = 메모리 − 예약 2,304(OS 512 + K3s 1,536 + 축출 기준 256). 계산값은 이름표의 메모리(8 GiB)로 셈했고, 실제로는 OS가 보는 메모리(t4g.large 7,802 MiB)에서 뺀다. K3s 예약은 처음에 768로 잡았으나, 독립 검증의 로컬 K3s에서 서버 프로세스가 RSS 1.6 GiB를 써서 1,536으로 올렸다.
- **t4g.large**로 정한다. 파드 요청 2,708을 넣고도 2,790 MiB가 남아(실측 할당 가능 5,498 기준), 동기화 때 repo-server와 controller가 차트를 그리며 1 GiB 안팎 더 써도 견딘다. 로컬 E2E의 실제 유휴 사용량(파드 1,121 MiB)은 요청보다 훨씬 작다. 한도 합계(7,658)는 넘지만 모든 구성 요소가 동시에 한도까지 쓰는 일은 없고, 넘치면 우선순위가 낮은 API부터 밀려난다(ADR-0013의 가용성).
- CPU 요청 합계 1,040m / 쓸 수 있는 1,700m(Traefik·cloudflared·Postgres 둘 시절 값. ADR-0016 구성으로 다시 세지 않음. 11/13 실제 계정 유휴 사용은 202m). CPU 한도는 두지 않는다(스로틀링으로 프로브가 실패하는 것을 막음). t4g는 버스트형이라 기준(30%/vCPU, 둘이면 0.6 vCPU)을 오래 넘기면 vCPU·시간당 $0.04가 더 붙는다. 평소에는 기준 안으로 본다. 늘 넘기면 m7g.large(고정 성능)로 바꾼다.
- 디스크는 gp3 40 GB: 이미지 약 5 GB, OS 3 GB, Postgres 볼륨 5+2 GiB, WAL·로그 여유. 이미지 정리가 시작되는 85% 전에 60% 안쪽으로 둔다. 30 GB보다 월 $0.9 더 든다.

**비밀 값이 가는 길**

```
사람: gh secret set → GitHub 비밀 값
  → infra-secrets 워크플로(develop 수동, 적용 역할. 쓰기만) → SSM SecureString /gachita/dev/app/*, bootstrap/*
  → External Secrets(서비스 계정 역할 ssm-reader, 읽기만) → 네임스페이스의 Secret
Terraform이 만든 값(`/tf/`) → SSM /gachita/dev/tf/* → 같은 길
```

| GitHub 비밀 값 | SSM | 권한·내용 | 만드는 사람 | 쓰는 곳 |
|---|---|---|---|---|
| `GHCR_PULL_TOKEN` | `app/ghcr-pull-token` | 클래식 토큰, `read:packages` 하나 | 사람 | `gachita`의 imagePullSecret |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `app/google/*` | 구글 OAuth 웹 클라이언트, 리다이렉트 `https://gachita.mangowhois.ai/…` | 사람 | API 환경 변수. 없어도 서버는 뜬다 |
| `ARGOCD_REPO_TOKEN` | `bootstrap/argocd-repo-token` | 저장소 읽기 토큰(이 저장소 하나, HTTPS. 배포 키가 조직 설정으로 막혀 11/14에 바꿈) | 승인 뒤 | 첫 부팅(ansible-pull), Argo CD 저장소 자격 |
| `CLOUDFLARE_API_TOKEN` | (SSM에 두지 않음) | `mangowhois.ai` DNS 편집 + 영역 WAF 편집 | 사람 | `terraform`·`infra` 워크플로의 develop 실행에서만(PR 계획에는 주지 않음) |
| `CLOUDFLARE_API_TOKEN_READ` | (SSM에 두지 않음) | 같은 영역 DNS·Zone·Zone WAF 읽기만 | 사람 | PR의 `terraform` 계획 |
| `PROJECT_TOKEN` | (SSM에 두지 않음) | 조직 Projects 읽기·쓰기, 이 저장소 이슈·PR 읽기 | 사람 | `tickets` 워크플로(클러스터와 무관) |
| - | - | DB 주소(사용자·비밀번호 포함) | CloudNativePG가 DB 네임스페이스에 생성 | 그 Secret 하나만 읽는 역할로 `gachita`에 복사(ADR-0013) |

- SSM에는 이 표의 값만 있고, 모두 `infra-secrets`(적용 역할)가 쓴다. 손으로 넣은 값이나 손으로 만든 클러스터 Secret은 두지 않는다(11/14 점검: 옛 `bootstrap/argocd-deploy-key`와 손으로 만든 Argo CD 자격을 지움. 클러스터의 Secret은 External Secrets·CloudNativePG·구축 단계만 만듦).
- **바꿀 때:** `gh secret set` → `infra-secrets`. `app/*`는 External Secrets가 1시간 안에 따라온다(환경 변수로 읽는 구글 값은 그 뒤 API 파드를 다시 띄움). `bootstrap/argocd-repo-token`은 첫 부팅과 구축 단계만 읽으므로 `ops` 워크플로의 `converge`(단계 `argocd`)를 돌린다. 이미지 받기 토큰은 노드가 아니라 네임스페이스에서 쓴다.

## 결과

- 서버를 갈아도 Terraform → 첫 부팅 → 7단계로 같은 클러스터가 다시 선다. 데이터는 S3 백업에서 되살린다.
- 구축 단계를 고치면 서버를 새로 만들지 않고 `gachita-converge`로 맞춘다. 단, 첫 부팅 스크립트(`user_data`)를 고치면 Terraform이 서버를 바꾼다(`user_data_replace_on_change`).
- 노드를 t4g.large로 올려 비용이 월 $30.4에서 $60.7로 는다. 지금 선언(t4g.medium)으로는 요청 합계가 넘쳐 애초에 올라오지 않는다.
- 확인한 것(11/13): `terraform validate`, 로컬 자격으로 상태 없이 계획만(AWS 28개, Cloudflare 번호를 넣으면 32개), `ansible-playbook --syntax-check`, 템플릿 세 개를 표본 값으로 그려 YAML 확인, Argo CD 설치 묶음 `kubeconform`(61개, 스키마 없는 3개 건너뜀). 로컬 E2E(Docker 위 K3s v1.36.6 한 노드)에서 구축 5·6단계와 같은 일을 했다: 우선순위 클래스, 이 PR의 `argocd/` kustomization으로 Argo CD v3.6.1(다섯 구성 요소 1분 안에 준비, 우선순위·요청값 들어감), 뿌리 앱. `argocd-cm`의 Application 건강 판정 덕에 다음 물결이 앞 물결의 마지막 앱이 Healthy가 된 그 초에 만들어졌고, 뿌리 앱부터 API `/healthz`까지 2분 38초(T24 GitOps PR). 유휴 메모리는 파드 합계 1,121 MiB(Argo CD 552), 요청 합계 2,516 MiB(Cilium·cloudflared·백업 사이드카 없이)였다. 여기에 Cilium(요청 384)과 나머지를 더하면 위 표의 요청 3,252 MiB가 되고, OS·K3s 몫을 빼면 t4g.medium에는 들어가지 않는다는 판단이 그대로다.
- 독립 검증 뒤(11/13 08:40~): 자리 표시가 남으면 Terraform 사전 조건이 계획에서 멈추고 `fill-account.sh`로 채우면 28개 계획이 나옴을 임시 사본에서 확인. 고친 선언으로 로컬 E2E를 다시 돌림(K3s에 이 표의 kubelet 예약을 그대로 줌): 노드 할당 가능 = 용량 − 2,304 MiB, 14개 앱이 물결 순서대로 Healthy(7분 12초), Postgres `17.11-minimal-trixie`와 저장소의 API 태그로 뜸, 유휴 파드 사용량 1,033 MiB. 물결 0의 Gateway API CRD 건강은 Argo CD가 상태만 바뀐 갱신을 무시하는 최적화(`ignoreResourceUpdates.all: /status`, 기본값) 때문에 다음 주기 갱신까지 약 3분 반 늦게 반영됐다. 물결을 막지는 않고 7단계의 30분 제한 안이라 그대로 둔다.
- 확인하지 못한 것: 실제 서버에서 7단계가 끝까지 도는지, Cilium이 K3s 1.36에서 bootstrap으로 뜨는지, 발급자 공개 키로 STS가 역할을 내주는지. 모두 승인 뒤 T24에서 본다.
