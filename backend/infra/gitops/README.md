# 클러스터 선언 (GitOps)

Argo CD가 이 폴더를 읽어 클러스터를 맞춥니다. 사람이 `kubectl apply`로 직접 고치지 않고, 이 폴더를 고쳐 PR로 올립니다. 설계는 [ADR-0013](../../../docs/adr/0013-network-edge-and-isolation.md)(격리·포트), [ADR-0016](../../../docs/adr/0016-slo-capacity-single-postgres.md)(Postgres 하나·ALB), [ADR-0017](../../../docs/adr/0017-alb-by-controller-and-fold-order.md)(ALB 컨트롤러·펴기 순서). 클러스터를 세우는 단계는 [`backend/infra/cluster`](../cluster/README.md).

```
backend/infra/gitops/
├── bootstrap/          뿌리 앱(root)이 읽는 곳. 물결(sync-wave) 순서의 Application 12개
├── platform/           플랫폼 설정: cluster-base(포트 규칙), pod-identity-webhook, secret-stores(SSM)
├── components/
│   └── data-plane/     데이터 경로 네임스페이스의 기본 차단과 DNS 허용
└── apps/
    ├── db/             Postgres 하나(gachita-db): base/, 처음 펼 때 이 폴더(initdb), 복구로 펼 때 recover/
    ├── api/            API(base) → overlays/dev(gachita, 이미지 태그)
    └── edge/           GatewayClass(ALB), Gateway와 ALB 설정, HTTPRoute와 대상 그룹 설정
```

## 올라오는 순서

구축 6단계가 뿌리 앱 하나를 넣으면, 뿌리 앱이 `bootstrap/`의 앱을 물결 순서로 만듭니다. 앞 물결의 앱이 모두 Synced·Healthy가 된 뒤에 다음 물결로 갑니다(첫 동기화 전 잠깐의 OutOfSync/Healthy는 세지 않음, `cluster/argocd/argocd-cm.yaml`).

| 물결 | 앱 | 무엇 |
|---|---|---|
| 0 | `cluster-base`, `gateway-api` | 포트 규칙, Gateway API CRD v1.6.3 |
| 1 | `cert-manager`, `cnpg`, `external-secrets` | CRD와 운영자 |
| 2 | `barman-cloud`, `pod-identity-webhook`, `secret-stores` | 운영자에 기대는 플랫폼 설정 |
| 3 | `db`, `aws-load-balancer-controller` | Postgres 하나와 백업. ALB 컨트롤러(파드 신원 웹훅 뒤라야 AWS 자격을 받음) |
| 4 | `api` | 비밀 값(DB 주소·이미지 받기·구글), 배포(서비스는 NodePort), 네트워크 정책 |
| 5 | `edge` | Gateway → 컨트롤러가 ALB를 만들고 노드를 대상에 넣음. API가 건강해진 뒤에 밖으로 연다 |

뿌리 앱은 이 저장소를 읽는 자식 앱 여섯(`cluster-base`, `secret-stores`, `pod-identity-webhook`, `db`, `api`, `edge`)에 자기와 같은 저장소 주소와 판을 넘깁니다(`backend/infra/cluster/templates/root-app.yaml.j2`). 그래서 병합 전 브랜치도 실제 계정에 펴 볼 수 있습니다. 데이터 버킷에 Postgres 전체 백업이 있으면 `db` 앱의 경로를 `apps/db/recover`로 바꿔 복구로 폅니다(T52).

## 이름과 주소

- 클러스터 안에서는 쿠버네티스 DNS 이름으로 찾습니다: API는 `gachita-api.gachita.svc.cluster.local`, Postgres는 `db-rw.gachita-db.svc.cluster.local:5432`(데이터베이스 `trips`, `profiles`). API의 DB 주소는 External Secrets가 두 역할의 비밀 번호로 이 이름을 넣어 만듭니다.
- 펼 때마다 바뀌는 값은 Git에 두지 않습니다: ALB 컨트롤러는 VPC를 이름 태그(`Name=gachita-dev`)로, 인증서를 리스너의 호스트 이름으로, 서브넷을 태그로 찾습니다. 계정 번호(역할 ARN, 버킷 이름)는 계정마다 한 번 채운 값입니다.
- 밖에서 들어오는 길은 Cloudflare DNS(프록시 없음, T174) → ALB(`gachita-dev`, 모든 주소의 443, ACM 인증서) → 노드의 NodePort → API 하나입니다. 프록시를 끄면서 엣지의 요청 수 제한과 원본 가리기는 이 호스트에 걸리지 않습니다. NodePort는 포트 규칙이 `gachita/gachita-api`에만 허용합니다.

## 새 판 내보내기

1. 로컬에서 `make push`로 이미지를 올립니다. 올리기 전에 이미지를 띄워 `/healthz`와 웹앱을 봅니다. 태그는 커밋 SHA 앞 12자입니다.
2. `make deploy-tag TAG=<올린 태그>`로 `apps/api/overlays/dev/kustomization.yaml`의 `newTag`를 바꾸고 PR로 올립니다.
3. 병합되면 Argo CD가 `RollingUpdate`(`maxUnavailable: 0`, `maxSurge: 1`)로 교체합니다. 새 파드가 두 데이터베이스에 닿아 `/healthz` 준비 검사를 통과한 뒤에 옛 파드를 하나씩 내립니다. 옛 파드는 종료 신호 전에 10초 기다려(`preStop`) 서비스 대상에서 먼저 빠집니다.

T93은 48시간 자동 삭제를 가진 구버전과 새 정책이 함께 돌지 않도록 한때 `Recreate`를 썼습니다. 그 방식은 배포마다 API 파드 둘을 모두 내려, 11/14 저녁 여섯 번의 배포 시각마다 ALB가 502를 냈습니다(5분 합계 2~57건, 같은 구간 ELB 503과 대상 5XX는 0건). 정책 전환이 끝나 T121에서 되돌렸습니다. 교체 중에는 새 판과 옛 판이 잠깐 함께 돕니다. 종료 전 대기보다 오래 걸리는 요청(큰 원음 업로드)은 여전히 끊길 수 있습니다. 배포 뒤 새 파드 2개 Ready, `/healthz` 200, Argo CD의 Synced·Healthy를 확인합니다.

롤백은 **T90의 무기한 보관 정책과 명시적 삭제 처리를 포함한 이미지**의 태그로만 합니다. 48시간 자동 삭제가 남은 이전 이미지로 되돌리면 보존할 자료가 다시 삭제될 수 있습니다.

## 격리를 확인하는 명령(실제 클러스터에서)

```sh
# API가 아닌 파드에서 DB로: 막혀야 한다
kubectl -n default run probe --rm -it --image=postgres:17 --restart=Never -- pg_isready -h db-rw.gachita-db.svc.cluster.local -p 5432 -t 3
# 실제로 막힌 흐름 보기(Cilium Hubble, 에이전트 안의 명령)
kubectl -n kube-system exec ds/cilium -c cilium-agent -- hubble observe --namespace gachita-db --verdict DROPPED --last 20
# 포트 규칙: 거절되어야 한다
kubectl -n gachita create service nodeport probe --tcp=80:80
```

## 확인한 것

- `kubectl kustomize` + `kubeconform -strict`(쿠버네티스 기본 + 공개 CRD 모음): `bootstrap` 12, `platform` 14, `apps/api/overlays/dev` 15(여기까지 `ci.yml`), `apps/db` 14, `apps/db/recover` 14, `apps/edge` 6, `cluster/argocd` 58(여기까지 `infra-e2e`. Argo CD 원본의 CRD 3개는 스키마 모음에 CRD 스키마가 없어 건너뜀)개 모두 통과(11/13).
- 차트 다섯(cert-manager, cnpg, external-secrets, traefik, barman-cloud)을 이 값으로 `helm template --kube-version 1.36.6`해 그려짐을 확인. 컨트롤러마다 우선순위, 컨트롤 플레인 노드 선택자, 요청값이 들어감.
- **로컬 물결 E2E(11/13, [`backend/infra/cluster/e2e-local.sh`](../cluster/e2e-local.sh). 인프라가 바뀐 PR마다 `infra-e2e` 워크플로가 같은 스크립트를 돎)**: Docker 위 K3s `rancher/k3s:v1.36.6-k3s1` 한 노드에 구축 5~7단계와 같은 일(우선순위 클래스, `backend/infra/cluster/argocd`로 Argo CD v3.6.1, `templates/root-app.yaml.j2`로 그린 뿌리 앱)을 하고, 이 폴더를 클러스터 안 git 서버에서 읽게 해 뿌리 앱부터 끝까지 돌렸습니다. 표는 `infra-e2e` 워크플로의 GitHub 실행기 기록(11/13 run 43385923741, 이 PR 머리 `1285626`)입니다. 11개 앱 모두 Synced·Healthy, 뿌리 앱을 넣고 575초(스크립트 전체 671초). 이 맥의 Docker Desktop에서는 같은 일이 2분 24초였습니다(이미지 캐시가 있던 상태).

  | 물결 | 앱 | 처음 보임(UTC) | 그 물결의 마지막 앱이 Synced·Healthy |
  |---|---|---|---|
  | 0 | `cluster-base`, `gateway-api` | 07:31:27 | 07:35:08(gateway-api, CRD 건강 반영이 늦음) |
  | 1 | `cert-manager`, `cnpg`, `external-secrets` | 07:35:08 | 07:39:25(cert-manager) |
  | 2 | `barman-cloud`, `pod-identity-webhook`, `secret-stores` | 07:39:27 | 07:39:46(barman-cloud) |
  | 3 | `db` | 07:39:46 | 07:40:35 |
  | 4 | `api` | 07:40:35 | 07:40:57 |

  - 다음 물결은 앞 물결의 마지막 앱이 Synced·Healthy로 기록된 뒤에 처음 보임(스크립트가 기록 순서로 확인하고, 어긋나면 실패).
  - 쿠버네티스 DNS 이름으로 `http://gachita-api.gachita.svc.cluster.local/healthz` 200 `{"ok":true}`(일회용 파드에서). `/healthz`는 Postgres 하나의 두 데이터베이스(trips, profiles)에 모두 닿아야 200.
  - **로컬에서 대신하거나 뺀 것**(전체는 스크립트 머리): `aws-load-balancer-controller`(물결 3)와 `edge`(물결 5) 앱은 빼고 스키마만 봄, SSM 대신 External Secrets의 가짜 공급자, Postgres 백업 플러그인·ObjectStore·정기 백업 뺌, API 이미지는 HEAD에서 로컬로 만들어 K3s에 넣음, Cilium 대신 K3s 기본 flannel에 네트워크 정책을 끄고 Cilium 정책 CRD만 넣음.
  - **로컬에서 확인하지 못한 것**: 네트워크 정책이 실제로 막는지(Cilium이 있어야 함), SSM·STS·S3에 닿는지, WAL 보관과 백업·복구(`recover/`는 스키마만), ALB와 Cloudflare, 노드 예약값. 모두 실제 계정에서 봅니다(T24·T26·T53).

## 알고 쓰는 한계

- Postgres와 노드가 한 대씩입니다. 서버가 죽으면 멈춥니다(ADR-0013의 '무엇이 죽으면').
- 컨트롤러 네임스페이스에는 아직 네트워크 정책이 없습니다. 실제 클러스터에서 Hubble로 흐름을 본 뒤 조입니다.
- `apps/edge/baseline.yaml`은 `components/data-plane`과 같은 내용입니다. edge 앱이 `gachita` 네임스페이스에도 선언(HTTPRoute, 요청 수 제한)을 만들어 kustomize의 네임스페이스 바꾸기를 쓸 수 없어서입니다.
