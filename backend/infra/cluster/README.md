# 클러스터 구축 단계 (Ansible)

서버 안에서 클러스터를 세우는 일곱 단계입니다. Terraform이 만든 서버의 첫 부팅 스크립트가 `ansible-pull`로 이 폴더의 [`site.yml`](site.yml)을 받아 돌립니다. 서버에 SSH를 열지 않으므로 Ansible은 서버 안에서 로컬로 돕니다. 결정과 노드 사양은 [ADR-0012](../../../docs/adr/0012-cluster-build-and-node-size.md). **2026-11-13 기준으로 실제 서버에서 돈 적이 없습니다.**

```
Terraform(AWS·Cloudflare) → 첫 부팅(user_data: 도구, 배포 키, ansible-pull) → 아래 7단계 → Argo CD가 물결 순서로(backend/infra/gitops)
```

| 단계 | 태그 | 하는 일 | 끝났는지 보는 검사 |
|---|---|---|---|
| 1 | `os` | 패키지, 파일 감시 한도 | apt·sysctl |
| 2 | `k3s` | K3s v1.36.6+k3s1. flannel·kube-proxy·네트워크 정책·traefik·servicelb 끔, Secret 암호화, kubelet 예약, 서비스 계정 발급자 = S3 | 판, `/readyz`, 발급자 주소 |
| 3 | `cilium` | Cilium 1.20.4(K3s `HelmChart`, `bootstrap: true`), kube-proxy 대체 | DaemonSet, 노드 Ready, `cilium-dbg status` |
| 4 | `oidc` | 발급자 문서와 공개 키를 S3에 | 공개 주소의 키 = 클러스터의 키 |
| 5 | `argocd` | 우선순위 클래스, Argo CD v3.6.1([`argocd/`](argocd/kustomization.yaml)), 저장소 자격 | 구성 요소 다섯 준비 |
| 6 | `root` | 뿌리 앱(`backend/infra/gitops/bootstrap`) | 앱 있음 |
| 7 | `verify` | 물결이 끝까지(최대 30분), 밖에서 `/healthz` | 모든 앱 Synced·Healthy, 200 |

- 판은 `site.yml`의 `vars`와 `argocd/kustomization.yaml`의 주소 두 곳에만 있습니다.
- 단계가 끝나면 `/var/lib/gachita/bootstrap/<번호>-<이름>.done`에 시각이 남습니다. 실패하면 로그의 마지막 `[n/7 이름]`이 멈춘 단계입니다.
- 서버마다 다른 값(계정, 발급자 주소, 브랜치, 서비스 주소)은 Terraform이 `/etc/gachita/vars.yml`에 넣습니다.

## 다시 돌리기

같은 결과가 되도록 짜여 있습니다. 단계마다 먼저 이미 됐는지 봅니다.

```sh
# 내 컴퓨터에서(SSM Run Command). 명령은 terraform output converge
aws ssm send-command --region ap-northeast-2 --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/sbin/gachita-converge"]'
# 서버 안에서(SSM 세션)
sudo gachita-converge                  # 전부
sudo gachita-converge --tags argocd    # 한 단계만(os, k3s, cilium, oidc, argocd, root, verify)
ls /var/lib/gachita/bootstrap; sudo tail -n 50 /var/log/gachita/bootstrap.log
```

판을 올릴 때는 `site.yml`이나 `argocd/kustomization.yaml`을 고쳐 PR로 병합한 뒤 그 단계만 다시 돌립니다. 첫 부팅 스크립트(`user_data`)를 고치면 Terraform이 서버를 새로 만듭니다.

## 올린 뒤 확인

승인을 받고 `terraform apply`를 한 뒤 이 순서로 봅니다. T24의 완료 기준입니다.

```sh
# 0. 쿠버네티스 API를 내 컴퓨터로(다른 창에 띄워 둠). kubeconfig는 서버의 /etc/rancher/k3s/k3s.yaml, server를 https://127.0.0.1:6443 으로
aws ssm start-session --region ap-northeast-2 --target <id> --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=6443,localPortNumber=6443

# 1. 첫 부팅: 일곱 단계가 다 끝났나
aws ssm start-session --target <id>;  ls /var/lib/gachita/bootstrap   # 1-os.done … 7-verify.done

# 2. 물결별 동기화: 물결 번호 순으로 Synced·Healthy가 됐나, 각 앱이 언제 끝났나
kubectl -n argocd get applications -o json | jq -r '.items[] | [(.metadata.annotations["argocd.argoproj.io/sync-wave"]), .metadata.name, .status.sync.status, .status.health.status, .status.operationState.finishedAt] | @tsv' | sort -n

# 3. 밖에서
curl -fsS https://gachita.mangowhois.ai/healthz          # {"ok":true}, 폰의 이동통신망에서도

# 4. Postgres 백업: 처음 전체 백업이 끝났고 WAL이 S3에 쌓이나
kubectl -n gachita-trips get backups,scheduledbackups
kubectl -n gachita-trips get cluster db -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")]}'
aws s3 ls s3://gachita-dev-<계정>/postgres/trips/ --recursive | tail     # profiles도 같은 방법

# 5. 새 이미지 내보내기: 태그 변경 PR이 병합되면 바뀌나
make push && make deploy-tag TAG=<올린 태그>      # 이 변경을 PR로. 병합 뒤
kubectl -n gachita get deploy gachita-api -o jsonpath='{.spec.template.spec.containers[0].image}'
```

## 고장 났을 때

| 증상 | 볼 곳 |
|---|---|
| 2단계에서 발급자 검사 실패 | `/etc/rancher/k3s/config.yaml`의 `service-account-issuer-=`. K3s가 기본값을 앞에 두면 STS가 역할을 내주지 않음 |
| 3단계에서 노드가 Ready가 안 됨 | `kubectl -n kube-system get helmchart,job,pod`. Cilium 설치 작업(`helm-install-cilium`) 로그 |
| 4단계 실패 | 계정의 S3 공개 차단(계정 단위 Block Public Access)이 켜져 있으면 발급자 버킷 정책이 거절됨 |
| 7단계에서 오래 멈춤 | 로그에 남은 `물결:앱:동기화/건강`. `kubectl -n argocd get app <이름> -o yaml`의 `status.conditions` |
