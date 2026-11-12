# 클러스터 선언 (GitOps)

Argo CD가 이 폴더를 읽어 클러스터를 맞춥니다. 사람이 `kubectl apply`로 직접 고치지 않고, 이 폴더를 고쳐 PR로 올립니다. **2026-11-12 기준으로 실제 클러스터에 올려 본 적이 없습니다.**

```
backend/infra/gitops/
├── bootstrap/        뿌리 앱이 읽는 곳. 아래 넷을 올린다
│   ├── cert-manager  인증서 발급기 v1.21.3
│   ├── cnpg          CloudNativePG 운영자 1.30.1(차트 0.29.1)
│   ├── platform      인증서 발급 규칙(Let's Encrypt)
│   └── api           같이타 API와 Postgres
├── platform/
└── apps/api/
    ├── base/         Postgres 한 대, API 배포, 서비스, 인그레스와 요청 수 제한
    └── overlays/dev/ 이미지 태그, 주소 이름, 백업 버킷
```

## 올라오는 순서

1. 서버의 첫 부팅 스크립트가 Argo CD와 뿌리 앱 `root`를 넣습니다(`backend/infra/terraform/user_data.sh.tftpl`).
2. `root`가 `bootstrap/`을 읽어 앱 넷을 만듭니다. cert-manager와 CloudNativePG가 먼저, 그다음 발급 규칙, 마지막에 API입니다.
3. CloudNativePG가 Postgres를 띄우고 접속 주소를 비밀 값 `gachita-pg-app`에 넣습니다. API는 그 값을 `DATABASE_URL`로 받습니다.
4. API가 시작하면서 표를 맞춥니다(`backend/api/schema.sql`).

## 자원을 만든 뒤 바꿀 곳

`overlays/dev/kustomization.yaml`에 자리 표시 값이 두 개 있습니다.

| 자리 표시 | 넣을 값 |
|---|---|
| `api.0-0-0-0.sslip.io` (두 곳) | `terraform output api_host` |
| `gachita-dev-000000000000` | `terraform output data_bucket` |

## 새 판 내보내기

1. 로컬에서 `make push`로 이미지를 올립니다. 올리기 전에 이미지를 띄워 `/healthz`와 웹앱을 봅니다. 태그는 커밋 SHA 앞 12자입니다.
2. `make deploy-tag TAG=<올린 태그>`로 `overlays/dev/kustomization.yaml`의 `newTag`를 바꾸고 PR로 올립니다.
3. 병합되면 Argo CD가 새 이미지로 바꿉니다. 되돌릴 때는 이전 태그로 같은 일을 합니다.

## 확인한 것

- `kustomize build`로 조립해 `kubeconform -strict`로 스키마를 봤습니다(10개 모두 통과). Argo CD·cert-manager·CloudNativePG·Traefik의 스키마는 공개 CRD 모음에서 가져왔습니다.
- API 이미지를 빌드해 읽기 전용 파일 시스템, 일반 사용자로 띄워 로컬 Postgres에 붙는 것을 확인했습니다(`/healthz` 200).
- 실제 클러스터에서의 동작(인증서 발급, 백업, 올라오는 순서)은 확인하지 않았습니다.

## 알고 쓰는 한계

- Postgres와 API가 한 대씩입니다. 서버가 죽으면 멈춥니다.
- 백업은 CloudNativePG의 내장 방식(`barmanObjectStore`)입니다. 1.30.1에는 있지만 폐기 예정이라 운영자를 올릴 때 Barman Cloud 플러그인으로 옮겨야 합니다.
- 이미지를 사람이 로컬에서 올리고 태그도 사람이 PR로 올립니다. 잦아지면 자동으로 PR을 여는 봇을 둡니다.
