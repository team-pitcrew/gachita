# 클러스터 선언 (GitOps)

Argo CD가 이 폴더를 읽어 클러스터를 맞춥니다. 사람이 `kubectl apply`로 직접 고치지 않고, 이 폴더를 고쳐 PR로 올립니다. 설계는 [ADR-0013](../../../docs/adr/0013-network-edge-and-isolation.md), 클러스터를 세우는 단계는 [`backend/infra/cluster`](../cluster/README.md)(T24 앞부분 PR). **2026-11-13 기준으로 실제 클러스터(AWS)에 올려 본 적이 없습니다.** 로컬 E2E 결과는 아래 '확인한 것'.

```
backend/infra/gitops/
├── bootstrap/          뿌리 앱(root)이 읽는 곳. 물결(sync-wave) 순서의 Application 13개
├── platform/           플랫폼 설정: cluster-base(포트 규칙), pod-identity-webhook, secret-stores(SSM)
├── components/
│   └── data-plane/     데이터 경로 네임스페이스의 기본 차단과 DNS 허용
└── apps/
    ├── db/             Postgres(base) → trips/(gachita-trips), profiles/(gachita-profiles)
    ├── api/            API(base) → overlays/dev(gachita, 이미지 태그)
    └── edge/           Gateway, HTTPRoute, 요청 수 제한, cloudflared(edge)
```

## 올라오는 순서

구축 6단계가 뿌리 앱 하나를 넣으면, 뿌리 앱이 `bootstrap/`의 앱을 물결 순서로 만듭니다. 앞 물결의 앱이 모두 Healthy가 된 뒤에 다음 물결로 갑니다.

| 물결 | 앱 | 무엇 |
|---|---|---|
| 0 | `cluster-base`, `gateway-api` | 포트 규칙, Gateway API CRD v1.6.3 |
| 1 | `cert-manager`, `cnpg`, `external-secrets`, `traefik` | CRD와 운영자 |
| 2 | `barman-cloud`, `pod-identity-webhook`, `secret-stores` | 운영자에 기대는 플랫폼 설정 |
| 3 | `db-trips`, `db-profiles` | 네임스페이스, Postgres, 백업, 네트워크 정책 |
| 4 | `api` | 비밀 값(DB 주소·이미지 받기·구글), 배포, 네트워크 정책 |
| 5 | `edge` | Gateway, HTTPRoute, cloudflared. API가 건강해진 뒤에 밖으로 연다 |

## 자원을 만들기 전에 채울 곳

계정 번호 자리 표시 `000000000000`이 역할 ARN(서비스 계정 주석)과 버킷 이름에 있습니다. 서버가 뜨자마자 이 폴더를 올리므로 **만들기 전에** 채워 develop에 병합합니다. 채우지 않으면 SSM 저장소가 `InvalidProviderConfig`로 물결 2에서 멈춥니다(독립 검증에서 확인). Terraform도 자리 표시가 남아 있으면 서버를 만들지 않습니다. 주소(`gachita.mangowhois.ai`)는 정해져 있어 바꿀 것이 없습니다.

```sh
backend/infra/gitops/fill-account.sh          # 지금 aws 자격의 계정 번호로. 다시 돌려도 같은 결과
```

API 이미지 태그(`apps/api/overlays/dev`)도 GHCR에 올라간 태그여야 합니다. 지금 값은 `c71304da7098`(11/13 develop)입니다.

## 새 판 내보내기

1. 로컬에서 `make push`로 이미지를 올립니다. 올리기 전에 이미지를 띄워 `/healthz`와 웹앱을 봅니다. 태그는 커밋 SHA 앞 12자입니다.
2. `make deploy-tag TAG=<올린 태그>`로 `apps/api/overlays/dev/kustomization.yaml`의 `newTag`를 바꾸고 PR로 올립니다.
3. 병합되면 Argo CD가 하나씩 바꿉니다(새 파드가 두 DB에 닿아 준비된 뒤 옛 파드를 내림). 되돌릴 때는 이전 태그로 같은 일을 합니다.

## 격리를 확인하는 명령(실제 클러스터에서, T26)

```sh
# API가 아닌 파드에서 DB로: 막혀야 한다
kubectl -n edge run probe --rm -it --image=postgres:17 --restart=Never -- pg_isready -h db-rw.gachita-trips -p 5432 -t 3
# 실제로 막힌 흐름 보기(Cilium Hubble, 에이전트 안의 명령)
kubectl -n kube-system exec ds/cilium -c cilium-agent -- hubble observe --namespace gachita-trips --verdict DROPPED --last 20
# 포트 규칙: 거절되어야 한다
kubectl -n gachita create service nodeport probe --tcp=80:80
```

## 확인한 것

- `kubectl kustomize` + `kubeconform -strict`(쿠버네티스 기본 + 공개 CRD 모음, CI와 같은 명령): `bootstrap` 13, `platform` 14, `apps/api/overlays/dev` 16, `apps/db/trips`·`profiles` 각 11, `apps/edge` 14개 모두 통과(11/13).
- 차트 다섯(cert-manager, cnpg, external-secrets, traefik, barman-cloud)을 이 값으로 `helm template --kube-version 1.36.6`해 그려짐을 확인. 컨트롤러마다 우선순위, 컨트롤 플레인 노드 선택자, 요청값이 들어감.
- **로컬 E2E(11/13, Docker 위 K3s `rancher/k3s:v1.36.6-k3s1` 한 노드)**: 구축 5·6단계와 같은 일(우선순위 클래스, `backend/infra/cluster/argocd`로 Argo CD v3.6.1, 뿌리 앱)을 하고 이 폴더를 로컬 git 서버에서 읽게 해 뿌리 앱부터 끝까지 돌렸습니다. 14개 앱 모두 Synced·Healthy, 뿌리 앱을 넣고 2분 38초.

  | 물결 | 앱이 만들어진 시각(UTC) | 그 물결의 마지막 앱이 Healthy |
  |---|---|---|
  | 0 | 22:33:41 | 22:33:55(gateway-api) |
  | 1 | 22:33:55 | 22:34:44(external-secrets) |
  | 2 | 22:34:44 | 22:35:04(barman-cloud) |
  | 3 | 22:35:04 | 22:35:53(db-trips, db-profiles) |
  | 4 | 22:35:53 | 22:35:55(api: 두 파드가 두 DB에 닿아 준비) |
  | 5 | 22:35:55 | 22:35:56(edge) |

  - 다음 물결은 앞 물결의 마지막 앱이 Healthy가 된 그 초에 만들어짐(Application 건강 판정이 동작).
  - Traefik을 거쳐 `Host: gachita.mangowhois.ai`로 `/healthz` 200 `{"ok":true}`, `/` 200(웹앱), 다른 호스트 404.
  - 같은 `CF-Connecting-IP`로 60번 빠르게 보내면 200 54번, 429 6번(요청 수 제한).
  - `gachita`에서 NodePort 서비스와 이름 없는 포트의 파드는 포트 규칙이 거절, `default`에서는 허용(라벨 붙은 네임스페이스만).
  - DB 주소는 `db-reader`가 `db-app` 하나만 읽는 권한으로 복사됨(`db-rw.gachita-trips`, `db-rw.gachita-profiles`). 구글 값이 없으면 `google-oauth`가 Secret 없이 Ready, API는 구글 변수 없이 뜸.
  - Postgres 파드에 우선순위 `gachita-data`, 요청=한도 512 MiB, 포트 이름 셋. 파드 신원 웹훅이 서비스 계정 주석을 보고 `AWS_ROLE_ARN`·`AWS_WEB_IDENTITY_TOKEN_FILE`을 넣음.
  - 유휴 메모리(Cilium·cloudflared·백업 사이드카 없이): 파드 합계 1,121 MiB(Argo CD 552), 요청 합계 2,516 MiB.
  - **로컬에서만 바꾼 것(12곳)**: 저장소 주소(로컬 git 서버)와 브랜치, SSM 대신 External Secrets의 가짜 공급자, Postgres 백업 플러그인과 정기 백업 뺌(S3 없음), cloudflared 배포 뺌(터널 없음), 이미지 태그(develop의 `c71304da7098`). K3s는 Cilium 없이 기본 flannel에 네트워크 정책을 끄고 돌렸습니다(Cilium 정책 CRD만 넣음).
  - **로컬에서 확인하지 못한 것**: 네트워크 정책이 실제로 막는지(Cilium이 있어야 함), SSM·STS·S3에 닿는지, 백업, Cloudflare Tunnel, 노드 예약값. 모두 실제 클러스터에서 봅니다(T24·T26).

## 알고 쓰는 한계

- 물결 0의 Gateway API CRD가 Established가 돼도 Argo CD가 다음 주기 갱신(약 2~3분)까지 Progressing으로 볼 수 있습니다. Argo CD 3.x 기본값이 상태만 바뀐 갱신을 무시하기 때문입니다(`resource.customizations.ignoreResourceUpdates.all: /status`). 로컬 E2E 두 번째에서 3분 반 늦었고, 물결은 그 뒤 순서대로 이어졌습니다.

- Postgres와 노드가 한 대씩입니다. 서버가 죽으면 멈춥니다(ADR-0013의 '무엇이 죽으면').
- 컨트롤러 네임스페이스에는 아직 네트워크 정책이 없습니다. 실제 클러스터에서 Hubble로 흐름을 본 뒤 조입니다.
- `apps/edge/baseline.yaml`은 `components/data-plane`과 같은 내용입니다. edge 앱이 `gachita` 네임스페이스에도 선언(HTTPRoute, 요청 수 제한)을 만들어 kustomize의 네임스페이스 바꾸기를 쓸 수 없어서입니다.
