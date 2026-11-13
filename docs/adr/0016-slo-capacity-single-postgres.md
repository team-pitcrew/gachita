# ADR-0016: 동시 접속 100에서 SLO를 지키는 한 대를 기본으로, Postgres는 하나로, 그 이상은 워커를 붙여 늘린다

* **상태:** 일부 채택, 일부 제안, 2026-11-13
  * **채택(지환, 11/13):** Postgres는 하나로 잡는다. 기준선은 동시 접속 100에서 SLO를 지키는 크기다. 그 이상은 수평 확장으로 받고 여유분을 둔다. 들어오는 길은 ALB와 AWS Load Balancer Controller로 두고 Argo CD로 관리한다(Traefik은 뺀다).
  * **제안(이 PR의 병합으로 정함):** SLO의 값, 기본 배치, 여유분의 크기, 늘리는 단계. ADR-0015(PR #81)의 노드 수·Postgres 복제·NAT와 'Traefik NodePort + Terraform 대상 그룹'을 대신하고 나머지는 그대로 쓴다.
* **관련:** T60(#102), T24(#30), T26(#32), T27(#33), T28(#34), T39(PR #85), [ADR-0013](0013-network-edge-and-isolation.md), ADR-0012(PR #77), ADR-0014(PR #82), ADR-0015(PR #81)

## 배경

- ADR-0015의 구성은 월 약 $208입니다. 지금 쓰임에 비해 크다는 지적이 있었습니다(지환, 11/13).
- 지환님이 정한 것: "Postgres는 하나로 잡아." "100은 동시접속자 수야. SLO/SLI를 아마존 표준으로 지키는 선을 얘기하는 거야. 분산 노드로 부하를 줄일 수 있다면 하고 그 이상은 수평 확장할 수 있도록 유연성을 갖추면서 비즈니스 여유분을 만들어."
- 들어오는 길도 같은 날 정해졌습니다(지환): "ALB + Controller 조합으로 가. 공식 컨트롤러가 있을 테니 ArgoCD랑 엮고." 앞서 "Traefik을 굳이 써야 해?"라는 물음이 있었고, Traefik을 빼는 쪽으로 정리됐습니다.
- 한 대 + 터널(ADR-0012·0013)과 노드 셋 + ALB(ADR-0015) 가운데 무엇을 기본으로 둘지가 정해지지 않아 구현 PR(#74, #77, #83)이 멈춰 있습니다.
- 서버에서 확인한 것(`backend/api`): 프로세스 안에 남는 상태는 DB 연결 풀뿐이라 API는 여러 개를 나란히 띄울 수 있습니다. 여행과 프로필의 DB 주소를 따로 받습니다(`TRIPS_DATABASE_URL`, `PROFILES_DATABASE_URL`). 웹앱은 2초마다 여행 상태를 묻고, 바뀐 것이 없으면 서버가 304로 답합니다.
- AWS와 Cloudflare에는 아직 아무것도 만들지 않았습니다.

## '아마존 표준'으로 삼은 자료

AWS 자료는 재는 방법과 계산법을 정해 주고, 목표 숫자는 업무에 맞춰 고르라고 합니다. 그래서 방법은 아래 문서를 따르고, 숫자는 선택지를 보이고 하나를 권합니다.

| 무엇 | 문서 | 여기서 쓴 것 |
|---|---|---|
| 가용성의 정의와 계산 | [Well-Architected 신뢰성 기둥: Availability](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/availability.html) | 요청으로 재는 가용성(성공한 응답 ÷ 유효한 요청, 1분이나 5분 단위). 강한 의존성은 가용성을 곱하고, 독립된 중복은 100% − (실패율의 곱). 등급 표(99% ~ 99.999%)와 '가용성을 올리면 비용이 늘므로 필요한 만큼만' |
| SLI·SLO·오류 예산·소진 속도 | [CloudWatch: Service level objectives](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-ServiceLevelObjectives.html) | SLI는 지표와 임계값, SLO는 기간과 달성 목표. 요청 기준과 기간 기준. 오류 예산. 소진 속도 = 살펴보는 창의 오류율 ÷ (100% − 목표) |
| 구성 요소가 약속하는 가용성 | [EC2 SLA](https://aws.amazon.com/compute/sla/), [ELB SLA](https://aws.amazon.com/elasticloadbalancing/sla/) | EC2 인스턴스 하나는 99.5%, 가용 영역 둘 이상에 나눠 두면 99.99%. ALB는 가용 영역 둘 이상에서 99.99% |
| 여유분을 두는 방식 | [Builders' Library: Static stability using Availability Zones](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/) | 장애 때 새로 만들지 않고 버티도록 미리 용량을 둔다(가용 영역 셋이면 50% 더) |
| 다시 보내기 | [Builders' Library: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) | 차량 앱의 다시 보내기 규칙(ADR-0013의 11절이 이미 따름) |

소진 속도 알림의 창과 배수는 AWS 문서에 정해진 값이 없어 [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)의 값을 빌렸습니다.

## 부하: 동시 접속 100이 서버에 주는 것

가정입니다. 실제 쓰임을 보고 고칩니다.

| 항목 | 가정 | 초당 |
|---|---|---|
| 구성 | 차량 앱 30 + 폰 웹앱 70(차 한 대에 폰 2.3대) | - |
| 조회 | 100개가 모두 2초마다 여행 상태를 물음. 대부분 304 | 50 요청 |
| 발화 올리기 | 차 한 대가 분당 13.6문장(11/13 에뮬레이터 실측 11분 150문장, 합성 음성). 5초마다 묶어 올림 | 6 요청, 6.8줄 |
| 여행 문서 쓰기 | 차마다 분당 한 번(부탁, 상태 바꾸기) | 0.5 요청 |
| **합계** | 읽기 88% · 쓰기 12% | **약 57 요청** |

- 저장: 발화 한 줄이 색인을 합쳐 약 270바이트였습니다(로컬 측정). 6.8줄/초가 하루 내내 이어지면 하루 약 160 MB, 48시간 보관이면 약 320 MB입니다.
- DB 연결: API 하나가 풀 둘에 10개씩 20개를 씁니다. API 둘이면 40개이고 Postgres의 기본 한도는 100개입니다.

## 로컬에서 잰 것(11/13)

| 동시 접속 | 초당 요청 | 조회 p95 / p99 | 발화 올리기 p95 / p99 | 쓰기 p95 / p99 | 오류 | 평균 사용 코어 | 메모리 최고: API 하나 / Postgres |
|---|---|---|---|---|---|---|---|
| 100 | 56.5 | 5.0 / 6.0 ms | 8.2 / 8.8 ms | 6.7 / 7.4 ms | 0 | 0.14 | 27 / 114 MiB |
| 300 | 169.5 | 3.9 / 4.7 ms | 6.2 / 7.1 ms | 6.0 / 6.8 ms | 0 | 0.27 | 30 / 114 MiB |
| 1,000 | 565 | 2.2 / 3.1 ms | 5.5 / 118 ms | 4.6 / 17.4 ms | 0 | 0.33 | 30 / 137 MiB |

- **조건.** Apple M5 Pro(18코어)의 Docker Desktop(18 CPU, 7.6 GiB). 잰 시각(10:30~10:33)에 같은 기기에서 다른 세션의 Pleos 에뮬레이터 E2E가 돌고 있었고, 1분 부하 평균이 9~11이었습니다. API 2개(메모리 한도 256 MiB), Postgres 17 하나(한도 512 MiB, 데이터베이스 둘·역할 둘). 이미지는 PR #85(T39) 브랜치로 만들었습니다(발화 올리기가 들어 있음, 병합 전). 부하는 같은 기기의 Node 스크립트가 위 가정대로 걸었고 단계마다 45~60초입니다.
- **읽는 법.** 지연은 서버와 DB만의 값입니다. 네트워크, TLS, Cloudflare, ALB, 같은 노드의 다른 파드가 없습니다. 실제 EC2가 아닙니다. CPU 시간은 준비 단계가 섞여 낮은 단계에서 더 크게 잡혔습니다.
- **t4g로 옮긴 어림.** t4g의 코어가 이 기기 코어의 1/3 속도라고 가정하면(재지 않은 가정), 동시 접속 100의 데이터 경로는 약 0.4 vCPU, 300은 약 0.8 vCPU입니다. t4g.large가 크레딧 없이 계속 쓸 수 있는 양은 0.6 vCPU(vCPU 둘 × 30%)이고, 넘는 만큼은 vCPU·시간당 $0.04입니다(0.5 vCPU를 한 달 내내 넘겨도 약 $15).

## 검토한 선택

**가용성 목표와 그 목표가 요구하는 구성**

| 목표(30일) | 허용되는 중단 | AWS의 숫자로 뒷받침되는 구성 | 월 비용 |
|---|---|---|---|
| **99.5%** | 3시간 36분 | 인스턴스 하나(EC2 인스턴스 단위 약속 99.5%) | $99 |
| 99.9% | 43분 | 강한 의존성을 모두 가용 영역 둘에: 워커 둘 + ALB + **Postgres 대기 복제본** | $172 |
| 99.95% | 21분 | 위에 더해 컨트롤 플레인 셋, 가용 영역마다 NAT | $300 이상(어림) |

Postgres가 하나면 그 노드가 강한 의존성입니다. 요청은 거의 모두 DB를 거치므로(준비 프로브도 두 DB를 봄), 워커를 둘로 늘려도 요청 경로의 가용성은 Postgres가 있는 노드의 가용성을 넘지 못합니다(곱의 법칙). 99.9%를 약속하려면 Postgres에 다른 가용 영역의 대기 복제본이 있어야 합니다.

**기본 배치**

| 선택 | 켜 둔 시간당 | 월 | 접어 둔 동안 | 설계 가용성 | 걸리는 점 |
|---|---|---|---|---|---|
| (가) 한 대 + 터널(ADR-0012·0013) | $0.095 | $69 | $1 안팎 | 99.5% | 들어오는 쪽에 SLI를 잴 지점이 없어 지표 수집을 노드에 올려야 함. 워커를 붙일 때 ALB로 바꾸면 길이 바뀜 |
| **(나) 한 대 + ALB** | $0.135 | $99 | $1 안팎 | 99.5% | 한 대에서는 ALB가 가용성을 더하지 않음. 월 $30 |
| (다) 서버 + 워커 둘 + ALB + Postgres 대기 복제본 | $0.236 | $172 | $1 안팎 | 99.9% | 동시 접속 100의 부하에는 필요 없는 용량. Postgres 인스턴스가 둘 |
| (라) ADR-0015 그대로(사설 서브넷과 NAT 포함) | $0.285 | $208 | $1 안팎 | 99.9% | (다)에 NAT $47이 더해짐 |

서울 리전 가격표 API(11/13). t4g.large $0.0832, t4g.medium $0.0416, ALB $0.0225와 LCU $0.008, 공인 IPv4 $0.005(모두 시간당), gp3 $0.0912(GB·월).

**ALB를 누가 만들고, 그 뒤에 무엇을 두나**

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| Terraform이 ALB와 대상 그룹을 만들고 Traefik NodePort로(ADR-0015) | ALB가 Terraform 상태 안에 있어 접을 때 같이 지워짐 | 프록시가 둘(ALB와 Traefik). NodePort 번호를 Terraform과 GitOps가 같이 알아야 함 |
| **AWS Load Balancer Controller가 Gateway·HTTPRoute를 보고 ALB를 만듦(채택)** | 프록시가 ALB 하나. 경로 선언(HTTPRoute)은 그대로 쓰고 GatewayClass만 바꿈. NodePort를 컨트롤러가 대상 그룹에 등록 | ALB가 Terraform 상태 밖이라 접는 순서를 지켜야 함. 컨트롤러와 IAM 역할이 하나 늘어남 |
| 같은 컨트롤러에 Ingress로 | 가장 오래 쓰인 길 | 경로 선언을 Ingress로 다시 써야 함. Gateway API로 안 될 때의 차선 |

## 결정

**기본 배치는 (나)입니다: t4g.large 한 대에 전부 올리고, Postgres는 하나, 들어오는 길은 Cloudflare → ALB(AWS Load Balancer Controller) → API. 가용성 SLO는 99.5%로 잡습니다.** 동시 접속 300까지는 그대로, 그 위는 값과 워커 수만 바꿔 받습니다.

### 1. SLI와 SLO

기간은 30일 이동 창, 계산은 요청 기준입니다.

| SLI | 좋은 사건 ÷ 전체 | 재는 곳 | SLO |
|---|---|---|---|
| 가용성 | 5xx가 아니고 시간 안에 끝난 요청 ÷ 유효한 요청(4xx 제외) | ALB의 요청 지표(1분 단위). 사용자 쪽에서 보는 값은 밖에서 1분마다 도는 점검(`/healthz`, T54의 E2E) | **99.5%** |
| 조회 지연 | 200 ms 안에 끝난 `GET /api/trips/:code` ÷ 전체 | ALB의 대상 응답 시간 | 99% |
| 쓰기 지연 | 1초 안에 저장되고 확인된 쓰기와 발화 올리기 ÷ 전체 | 같음 | 99% |
| 발화 신선도 | 말한 뒤 60초 안에 저장된 발화 ÷ 전체 발화 | `utterances`의 `created_at`과 `at`의 차이 | 95%(통신이 끊긴 구간 포함) |

- **오류 예산.** 가용성 99.5%면 30일에 216분, 요청으로는 200건 가운데 1건입니다.
- **소진 속도 알림.** 빠른 소진: 1시간 창의 소진 속도가 14.4 이상(한 시간에 한 달 예산의 2%). 느린 소진: 6시간 창이 6 이상(6시간에 5%). 둘 다 울리면 배포를 멈추고 원인을 봅니다.
- **지연 임계값의 근거.** 로컬에서 잰 p99(조회 6 ms, 발화 올리기 9 ms)의 20배 넘게 잡았습니다. 네트워크와 느린 코어, 이웃 파드의 몫입니다. EC2에서 잰 뒤 조입니다.
- **복구 목표(SLO와 별개, 장애 한 번에 대한 것).** RPO 5분(WAL 보관 주기), RTO 30분(백업에서 다시 세움).
- 99.5%로 잡은 이유: Postgres가 하나이고 노드가 하나라 AWS가 약속하는 값이 99.5%입니다. 한 대에서는 노드 재부팅과 K3s 판 올리기도 모두 중단 시간입니다. 장애가 없는 달에는 99.9%가 나오겠지만 약속할 근거가 없습니다.

### 2. Postgres 하나

- CloudNativePG 클러스터 하나(`db`), 인스턴스 하나, 네임스페이스 하나(`gachita-db`). 그 안에 데이터베이스 둘(`trips`, `profiles`)과 소유 역할 둘(`trips`, `profiles`)을 둡니다.
- **서버 코드는 바꾸지 않습니다.** 두 주소가 같은 Postgres의 서로 다른 데이터베이스와 역할을 가리키면 됩니다. 로컬에서 이렇게 띄워 `/healthz` 200과 E2E 12단계 통과를 확인했고, 표는 각자의 데이터베이스에 생겼습니다.
- 역할이 남의 데이터베이스에 들어가지 못하게 `pg_hba`에 거절 두 줄을 둡니다. 로컬 Postgres 17에서 양쪽 모두 `pg_hba.conf rejects connection`으로 거절되는 것을 확인했습니다.

| | 그대로 남는 것 | 잃는 것 |
|---|---|---|
| 접근 | 데이터베이스와 역할이 따로. 서로의 데이터베이스에 접속 불가. 네임스페이스 기본 차단으로 DB에는 API와 운영자만 닿음 | 파드와 네임스페이스 단위의 분리. Postgres 자체가 뚫리거나 관리자 권한이 새면 둘 다 보임 |
| 자원 | - | 한쪽의 무거운 질의가 다른 쪽을 느리게 함. 메모리와 연결 한도를 같이 씀 |
| 장애 | - | 하나가 멈추면 여행과 프로필이 같이 멈춤(전에는 한쪽만) |
| 백업 | S3에 WAL과 전체 백업 | 따로 되돌리기. 복구하면 둘이 같은 시점으로 같이 돌아감. IAM 역할과 백업 경로도 하나 |

- 아끼는 것: 메모리 요청 512 MiB(Postgres 둘과 사이드카 둘 1,152 → 하나씩 640).
- **SLO에 주는 영향.** Postgres가 강한 의존성 하나가 됩니다.

| 장애 | 되살아나는 길 | 걸리는 시간(어림, 재지 않음) | 데이터 |
|---|---|---|---|
| Postgres 프로세스나 파드 | CloudNativePG가 다시 띄움 | 1분 안팎 | 그대로 |
| 노드 하드웨어 | EC2 자동 복구(같은 디스크) 뒤 K3s와 파드가 다시 뜸 | 5~15분 | 그대로 |
| 디스크 손상, 노드 교체 | S3의 백업과 WAL로 다시 세움 | 30분(RTO) | 최대 5분치를 잃음(RPO). 차량 앱이 보관한 발화는 다시 올라옴(ADR-0014) |
| 가용 영역 | 다른 영역에 다시 펴고 복구 | 30분 이상 | 같음 |

  99.5%의 예산 216분이면 백업 복구를 여러 번 감당합니다. 99.9%(43분)였다면 한 번으로 예산이 끝납니다. 이것이 Postgres 하나를 99.5%와 묶은 이유입니다. 보완은 5분 주기 WAL 보관, 매일 전체 백업, 펴기 절차에 넣는 복구 연습입니다.

### 3. 기본 배치: 한 대

| 구성 요소 | 메모리 요청(MiB) | ADR-0012(PR #77)와 달라진 것 |
|---|---|---|
| Cilium, CoreDNS·metrics-server | 524 | - |
| Argo CD | 752 | - |
| cert-manager, CloudNativePG와 백업 플러그인, External Secrets, 파드 신원 웹훅 | 408 | - |
| Traefik | 0 | 둘(128) → 없음(ALB가 프록시를 맡음) |
| AWS Load Balancer Controller | 64 | 새로 하나. 차트에 기본값이 없어 요청값은 어림 |
| cloudflared | 0 | 둘(96) → 없음(ALB) |
| Postgres + 백업 사이드카 | 640 | 둘(1,152) → 하나 |
| API 2개 | 192 | - |
| **파드 합계** | **2,580** | 3,252에서 672 줄어듦 |

| 인스턴스 | 파드에 쓸 수 있는 메모리 | 요청 대비 |
|---|---|---|
| t4g.medium(4 GiB) | 1,792 MiB | 144%. 올라가지 않음 |
| **t4g.large(8 GiB)** | 5,888 MiB | 44% |

- **t4g.medium으로는 내려가지 못합니다.** 막는 것은 사용자 부하가 아니라 고정 몫입니다. 노드 예약 2,304 MiB(OS 512, K3s 서버 1,536, 축출 기준 256)와 컨트롤러·CNI 1,748 MiB가 사용자와 무관하게 필요해 합이 4,052 MiB입니다. 데이터 경로(API 둘, Postgres)의 요청은 832 MiB뿐이고 로컬에서 실제로 쓴 것은 200 MiB 안팎이었습니다. 4 GiB로 가려면 Argo CD(752)나 Cilium(384)을 빼거나 컨트롤 플레인을 밖으로 내보내야 하는데, 정해 둔 방침(GitOps, 이름으로 막는 정책, 직접 운영)과 어긋납니다.
- **분산 노드는 기본에 넣지 않습니다.** 부하로 보면 동시 접속 100의 데이터 경로가 이 기기의 0.14코어, t4g 어림 0.4 vCPU라 나눌 것이 없습니다. 가용성으로 보면 Postgres가 하나라 워커를 늘려도 요청 경로의 가용성이 오르지 않습니다. 워커는 2단계에서 변수로 붙입니다.
- **들어오는 길은 Cloudflare → ALB → API입니다.** ALB는 클러스터의 AWS Load Balancer Controller가 Gateway와 HTTPRoute를 보고 만들고, 컨트롤러는 Argo CD가 올립니다(채택). Traefik은 두지 않습니다. 클러스터 안에 L7 프록시가 없어지므로 호스트와 경로는 ALB의 규칙이, 본문 크기 제한은 API가(이미 있음), 요청 수 제한은 Cloudflare 엣지가 맡습니다. 파드 IP가 VPC에서 보이지 않아(Cilium 오버레이) ALB의 대상은 인스턴스의 NodePort이고, 건강 확인은 준비 프로브와 같은 `/healthz`입니다.
- 한 대에서는 ALB가 가용성을 더하지 않습니다(ADR-0013의 3절). 그래도 기본에 두는 이유는 셋입니다. 지환님이 정한 길이고, SLI를 잴 지점이 됩니다(요청 수, 5xx, 응답 시간의 백분위가 1분 단위로 CloudWatch에 남아 노드에 지표 수집기를 올리지 않아도 됨). 그리고 워커를 붙일 때 들어오는 길이 바뀌지 않습니다(컨트롤러가 새 노드를 대상에 넣음).
- **노드는 공개 서브넷에 둡니다.** 공인 IP는 나가는 길에만 쓰고, 들어오는 것은 ALB 보안 그룹에서 오는 NodePort뿐입니다. 사설 서브넷과 NAT(월 $47)는 3단계로 미룹니다. ADR-0015의 대역 계획은 그대로 두고 공개 서브넷 둘은 처음부터 만듭니다(ALB가 가용 영역 둘을 요구함).

### 4. 여유분과 늘리는 단계

**여유분은 3배입니다. 기본 배치가 동시 접속 300까지 SLO를 지키게 둡니다.** 로컬에서는 1,000까지 오류 없이 한 자릿수 ms였고 메모리는 늘지 않았습니다. 다만 실제 EC2에서 잰 것이 아니라 10배 가운데 3배만 믿습니다. 300에서 t4g 어림 CPU는 0.8 vCPU로 vCPU 둘 안이고, DB 연결은 40/100입니다.

| 단계 | 동시 접속 | 바꾸는 것 | 방식 |
|---|---|---|---|
| 0 기본 | ~300 | - | t4g.large 한 대 |
| 1 | ~1,000 | API 2 → 4, Postgres 메모리 512 → 1,024 MiB, 볼륨 8 → 20 Gi | GitOps 값만(PR 하나). 한 대 그대로(요청 약 3,300 / 5,888 MiB) |
| 2 | ~3,000 | 워커 2대(t4g.medium, 가용 영역 둘), API 6~8개를 워커로 | Terraform 변수 `worker_count`와 GitOps 값. 컨트롤러가 워커를 ALB 대상에 넣음. 구조는 그대로 |
| 3 | 그 이상, 또는 SLO를 99.9%로 | Postgres 대기 복제본, 연결 풀러, 조회를 서버가 밀어 주는 방식으로, 컨트롤 플레인 셋, 사설 서브넷과 NAT | 구조가 바뀜. 따로 결정 기록 |

- **Postgres 하나가 버티는 곳까지.** 연결 100개(API 4개면 80개). 저장은 동시 접속 1,000이 종일 이어지면 하루 약 1.6 GB, 48시간이면 3.2 GB입니다. CPU와 메모리는 노드 사양을 올려 받습니다(수직). 그다음이 3단계의 풀러와 복제본입니다.
- **늘리는 신호.** 소진 속도 알림. 조회 p99가 임계값의 절반(100 ms)을 5분 넘김. 노드 CPU의 5분 평균이 60%를 넘거나 CPU 크레딧 잔고가 줄어듦. Postgres 연결이 70개를 넘음. 파드 메모리가 한도의 80%. 디스크 70%.

### 5. ADR-0015에서 그대로 쓰는 것과 바뀌는 것

| ADR-0015의 항목 | 이 결정에서 |
|---|---|
| Cloudflare → ALB, TLS 두 구간, 원본 보호(Cloudflare 대역만) | 그대로 |
| ALB 뒤의 Traefik NodePort, Terraform이 만드는 ALB와 대상 그룹 | Traefik을 빼고 ALB가 API의 NodePort로 바로 감. ALB는 AWS Load Balancer Controller가 만듦 |
| 리버스 프록시의 층 | Cloudflare(TLS, 캐시, 요청 수 제한)와 ALB(경로, 건강 확인) 두 층. 요청 수 제한을 엣지로 옮기는 것은 그대로 |
| 서브넷 대역 계획 | 그대로. 공개 둘은 처음부터, 사설과 NAT는 3단계 |
| 서버 1 + 워커 2 | 기본은 한 대. 워커는 `worker_count`(기본 0) |
| Postgres를 DB마다 인스턴스 둘 | 클러스터 하나에 인스턴스 하나. 대기 복제본은 3단계 |
| 월 약 $208 | 월 약 $99 |

## 결과

**바뀌는 파일과 값(구현은 이 PR에서 하지 않습니다)**

- GitOps `backend/infra/gitops`
  - `apps/db/trips`, `apps/db/profiles`를 없애고 `apps/db` 하나(네임스페이스 `gachita-db`).
  - `Cluster db`: `bootstrap.initdb`의 `database: trips`·`owner: trips`, `managed.roles`에 `profiles`(`passwordSecret: db-profiles`), `postgresql.pg_hba`에 `host trips profiles all reject`와 `host profiles trips all reject`, `storage.size: 8Gi`, 메모리 512Mi, 서비스 계정의 역할 `gachita-dev-pg`.
  - 새 선언: `Database profiles`(소유 `profiles`), External Secrets의 `Password` 생성기와 `ExternalSecret db-profiles`(basic-auth, 사용자 `profiles`).
  - 백업 경로 `s3://gachita-dev-<계정>/postgres/db`. `reader.yaml`의 `resourceNames`는 `db-app`, `db-profiles`.
  - `bootstrap/30-db-trips.yaml`과 `30-db-profiles.yaml`을 `30-db.yaml` 하나로.
  - `apps/api/base/secrets.yaml`: 저장소를 `gachita-db` 하나로. `TRIPS_DATABASE_URL`은 `db-app`의 `uri`, `PROFILES_DATABASE_URL`은 `db-profiles`의 비밀번호로 조립(`db-rw.gachita-db:5432/profiles`). `network.yaml`의 `api-to-dbs`는 네임스페이스 하나로.
  - `bootstrap/10-traefik.yaml`을 빼고 AWS Load Balancer Controller의 Application을 넣음. 공식 차트 `eks/aws-load-balancer-controller` 3.6.2(`https://aws.github.io/eks-charts`). 값: `clusterName: gachita-dev`, `region: ap-northeast-2`, `vpcId`(IMDS 홉 1이라 둘 다 꼭 줌), `replicaCount: 1`, `enableCertManager: true`, `enableServiceMutatorWebhook: false`, `defaultTags.Project: gachita`, 서비스 계정의 역할 `gachita-dev-alb-controller`, 컨트롤 플레인 노드 선택자와 테인트 허용, 메모리 요청 64Mi·한도 256Mi(어림). 웹훅 인증서를 cert-manager로 받으므로 물결 2.
  - `apps/edge`: cloudflared, Traefik용 GatewayClass와 Middleware, HTTPRoute의 `ExtensionRef`를 뺌. GatewayClass를 컨트롤러 것으로, Gateway 리스너는 HTTPS 443(ACM 인증서), 대상은 인스턴스·건강 확인 `/healthz`. HTTPRoute의 호스트와 경로는 그대로.
  - `apps/api/base/service.yaml`을 `NodePort`로. 포트 규칙(`platform/cluster-base/port-rules.yaml`)에 `gachita`의 `gachita-api` 서비스 하나만 예외. `network.yaml`의 들어오는 쪽을 Traefik 파드에서 공개 서브넷 대역(ALB)으로.
- Terraform `backend/infra/terraform`
  - 변수 `worker_count`(기본 0), `worker_instance_type`(기본 `t4g.medium`), `private_nodes`(기본 `false`).
  - `network.tf`: 공개 서브넷 둘(`10.10.0.0/24`, `10.10.1.0/24`)과 컨트롤러가 찾는 태그(`kubernetes.io/role/elb=1`, `kubernetes.io/cluster/gachita-dev=owned`). 사설 서브넷과 NAT는 `private_nodes`일 때만. ALB 앞단 보안 그룹(Cloudflare 대역의 443만)과, 노드 보안 그룹에 그 보안 그룹에서 오는 NodePort 범위.
  - `compute.tf`: 서버 하나(`t4g.large`)와 `worker_count`만큼의 워커(가용 영역을 번갈아).
  - `iam.tf`: 파드 역할 `pg-trips`, `pg-profiles`를 `pg` 하나로(서비스 계정 `gachita-db:db`, 접두사 `postgres/db/`). 컨트롤러용 역할 `alb-controller`를 더함. 권한 경계(#74)에 ELB, EC2 보안 그룹, ACM 읽기가 들어가야 함.
  - `edge.tf`: 터널을 빼고 ACM 인증서와 검증 레코드. **ALB와 대상 그룹은 Terraform이 만들지 않음.** `gachita` 레코드는 ALB가 생긴 뒤 태그로 찾아 가리킴(펴기의 둘째 단계).
- 접는 순서: ALB가 Terraform 상태 밖이므로 `destroy` 전에 `edge` 앱(Gateway)을 지우고, ALB가 사라진 것을 태그로 확인합니다. 그러지 않으면 ALB가 남아 비용이 나고 서브넷과 VPC 삭제를 막습니다.
- 구축 단계 `backend/infra/cluster`: 워커가 붙는 단계는 `worker_count`가 1 이상일 때만. **서버 노드의 테인트도 워커가 있을 때만 겁니다.** 워커 없이 걸면 API와 Postgres가 갈 곳이 없습니다.
- 문서: ADR-0013의 5절(DB 네임스페이스 둘)과 10절의 표, T26(#32)의 '서로 다른 파드로', ADR-0012의 노드 사양 표(요청 3,252 → 2,580), ADR-0015의 상태 줄. ADR-0014의 '여행 DB'와 '프로필 DB'는 데이터베이스 단위로 읽으면 그대로입니다.

**확인한 것(11/13, 로컬)**

- Postgres 17 하나에 데이터베이스 둘·역할 둘로 API 둘을 띄워 `/healthz` 200, E2E 12단계 통과. 교차 접속은 `pg_hba`에서 거절.
- 위 표의 부하 측정(동시 접속 100, 300, 1,000).
- Postgres 하나 선언의 초안(`Cluster`의 `managed.roles`와 `pg_hba`, `Database`, `Password` 생성기, `ExternalSecret`)이 `kubeconform -strict`를 통과.
- 가격은 AWS 가격표 API(서울).

**확인하지 못한 것**

- 실제 EC2에서의 지연, CPU, 메모리 전부. t4g 코어가 1/3 속도라는 가정. 플랫폼(K3s, Argo CD, Cilium)의 유휴 CPU.
- CloudNativePG에서 `managed.roles`, `Database`, `pg_hba`와 `Password` 생성기가 실제로 맞물려 도는지(스키마만 봄).
- AWS Load Balancer Controller v3.6의 Gateway API가 EKS가 아닌 K3s, 인스턴스 대상, Cilium의 kube-proxy 대체에서 도는지. 안 되면 같은 컨트롤러에 Ingress로 갑니다. 컨트롤러가 쓰는 메모리와 NodePort에서 출발지(ALB 주소)가 보존되는지도 재지 않았습니다.
- ALB 지표로 SLI를 계산하고 CloudWatch의 SLO 기능에 얹는 방법과 비용.
- 장애별 복구 시간. 표의 값은 어림이고, 펴기와 복구를 실제로 해 보며 잽니다.
- Cloudflare 무료 요금제의 가용성 약속. Cloudflare는 어느 구성에서나 강한 의존성입니다.
- 발화 신선도 SLI에서 차량 시계와 서버 시계의 차이.
- 동시 접속 가정(차 30 · 폰 70, 2초 주기, 5초 묶음)이 실제 쓰임과 맞는지.
