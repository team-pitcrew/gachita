#!/usr/bin/env bash
# 물결 E2E(T55). Docker 위 K3s 한 대에 구축 5~7단계(site.yml)와 같은 일을 하고, 뿌리 앱부터 마지막 물결까지 Argo CD가
# 올리는 것을 기록한 뒤, 쿠버네티스 DNS 이름(gachita-api.gachita.svc.cluster.local)으로 /healthz 200을 본다.
# 인프라가 바뀐 PR마다 infra-e2e 워크플로가 돌리고, 사람이 로컬에서 돌려도 같다.
#
#   backend/infra/cluster/e2e-local.sh    기록(waves.log, summary.md, local-overrides.diff)은 E2E_OUT(기본: 새 임시 폴더)
#
# 필요한 것: docker, kubectl, jq, yq(mikefarah v4), git, ansible(뿌리 앱을 구축 6단계와 같은 template 모듈로 그림), 인터넷.
# 리눅스에서는 커널 모듈 br_netfilter(sudo modprobe br_netfilter. Docker Desktop은 이미 올라와 있음).
# 끝나면 성공·실패와 관계없이 만든 컨테이너와 이미지를 지운다. AWS·Cloudflare에는 닿지 않는다.
#
# 대상은 작업 중인 커밋(HEAD)이다. 커밋하지 않은 변경은 들어가지 않는다. 실제 구축과 다른 것:
#   1~4단계(OS, K3s, Cilium, OIDC)  rancher/k3s 컨테이너 하나(판은 site.yml). CNI는 K3s 기본(flannel, kube-proxy)이고
#                                   네트워크 정책은 끈다(정책은 넣지만 막는지는 보지 않음). Cilium은 정책 CRD만 넣는다
#   5단계 저장소와 자격              GitHub 대신 로컬 git 서버: 클러스터 안 파드 하나(Argo CD 이미지의 git daemon,
#                                   git://gitserver.default.svc.cluster.local). 자격이 없어 저장소 자격은 만들지 않는다
#   6단계 뿌리 앱                    templates/root-app.yaml.j2를 그대로 그린다. 저장소·판만 로컬, db_bootstrap=initdb(recover는 스키마만)
#   7단계 확인                       물결 끝까지와 /healthz. WAL 보관(S3)은 보지 않는다. 밖(ALB·Cloudflare)은 infra.sh의 몫
#   로컬 git 서버의 덮어쓰기 한 커밋  kustomize 패치로 얹는다. 대상이 없으면 조립이 실패해 여기서 멈춘다
#     bootstrap      aws-load-balancer-controller(물결 3, AWS API로 ALB를 만듦)와 edge(물결 5, 그 컨트롤러의 CRD와 ALB)를 뺀다.
#                    둘은 스키마만 본다(ci.yml의 backend-infra, infra-e2e의 static)
#     secret-stores  SSM 대신 External Secrets의 fake 공급자. 값은 가짜 이미지 받기 토큰 하나(구글 값은 없음: 선택 값이 빈 경우)
#     db             백업 플러그인(WAL 보관), ObjectStore, ScheduledBackup을 뺀다(S3 없음)
#     api            이미지를 이 스크립트가 backend/api/Dockerfile로 만든 것으로(GHCR 받기 토큰 없이 K3s에 바로 넣음)
#   파드 신원 웹훅은 뜬다(물결 2). 역할 주석으로 AWS를 부르던 것(ALB 컨트롤러, SSM 저장소, 백업 플러그인)은 위에서 빠지거나 바뀌었다
set -euo pipefail

WAIT=${E2E_WAVE_TIMEOUT:-1200} # 뿌리 앱을 넣고 모든 앱이 Synced·Healthy가 될 때까지 기다리는 최대 초
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD)
OUT=${E2E_OUT:-$(mktemp -d)}
id=gachita-wave-e2e-$$ # 여러 세션이 같이 돌려도 겹치지 않게
image=$id-api:local
repo=$OUT/repo
infra=$repo/backend/infra
url=git://gitserver.default.svc.cluster.local/gachita.git
export KUBECONFIG=$OUT/kubeconfig

log() { echo "[$(date -u +%T) +${SECONDS}s $1] $2"; }
fail() {
  echo "::error::$1"
  printf '### 물결 E2E 실패 (%s)\n\n%s\n' "$SHA" "$1" > "$OUT/summary.md"
  exit 1
}
retry() { # retry <횟수> <명령...>: 5초 간격
  local n=$1 i
  shift
  for ((i = 1; i <= n; i++)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 5
  done
  "$@" # 마지막 한 번은 출력을 보인다
}

diagnose() {
  echo "--- 끝나지 않은 앱"
  kubectl -n argocd get applications -o json | jq -r '.items[]
    | select(.status.sync.status != "Synced" or .status.health.status != "Healthy")
    | "\(.metadata.name): \(.status.sync.status)/\(.status.health.status) \([.status.conditions[]?.message] | join("; "))",
      (.status.resources[]? | select(.health.status? and .health.status != "Healthy")
       | "  \(.kind)/\(.namespace)/\(.name): \(.health.status) \(.health.message // "")")' || true
  echo "--- 돌지 않는 파드"
  kubectl get pods -A --no-headers | awk '$4 != "Running" && $4 != "Completed"' || true
  echo "--- API 로그"
  kubectl -n gachita logs deploy/gachita-api --tail=30 2>/dev/null || true
}

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -s "$KUBECONFIG" ]; then diagnose; fi
  docker rm -f -v "$id-k3s" >/dev/null 2>&1 || true
  docker rmi "$image" >/dev/null 2>&1 || true
  echo "기록: $OUT"
  exit "$rc"
}
mkdir -p "$OUT"
[ -z "$(ls -A "$OUT")" ] || { echo "::error::기록 폴더가 비어 있지 않습니다: $OUT"; exit 1; }
trap cleanup EXIT
trap 'exit 130' INT TERM

for c in docker kubectl jq yq git ansible; do command -v "$c" >/dev/null || fail "$c 명령이 필요합니다"; done
yq --version | grep -q mikefarah || fail "yq는 mikefarah/yq v4가 필요합니다"

# ---------------------------------------------------------------- 1 저장소
log 1/7 "저장소: HEAD($SHA)의 backend/infra에 덮어쓰기 한 커밋을 얹은 브랜치 e2e"
mkdir -p "$repo"
git -C "$ROOT" archive HEAD backend/infra/cluster backend/infra/gitops | tar -x -C "$repo"
git -C "$repo" init -q -b e2e
git -C "$repo" add -A
git -C "$repo" -c user.name=e2e -c user.email=e2e@localhost commit -qm "HEAD $SHA"

patch_in() { # patch_in <gitops 아래 kustomization 폴더> <전략적 병합 패치>
  P="$2" yq -i '.patches += [{"patch": strenv(P)}]' "$infra/gitops/$1/kustomization.yaml"
}
for app in aws-load-balancer-controller edge; do
  patch_in bootstrap "apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: $app, namespace: argocd}
\$patch: delete"
done
patch_in platform/secret-stores 'apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata: {name: ssm}
spec:
  provider:
    aws: null
    fake:
      data:
        - {key: /gachita/dev/app/ghcr-pull-token, value: local-not-a-token}'
patch_in apps/db/base 'apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: {name: db}
spec: {plugins: null}'
patch_in apps/db/base 'apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata: {name: backup}
$patch: delete'
patch_in apps/db/base 'apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata: {name: daily}
$patch: delete'
patch_in apps/api/overlays/dev "apiVersion: apps/v1
kind: Deployment
metadata: {name: gachita-api}
spec:
  template:
    spec:
      containers:
        - {name: api, image: $image}"
for dir in bootstrap platform/secret-stores apps/db apps/api/overlays/dev; do
  kubectl kustomize "$infra/gitops/$dir" >/dev/null || fail "덮어쓰기가 맞지 않습니다: $dir"
done
git -C "$repo" -c user.name=e2e -c user.email=e2e@localhost commit -qam "로컬 덮어쓰기(e2e-local.sh)"
git -C "$repo" diff HEAD~1 > "$OUT/local-overrides.diff"
git -C "$repo" diff --stat HEAD~1
git clone -q --bare "$repo" "$OUT/gachita.git"
want=$(($(kubectl kustomize "$infra/gitops/bootstrap" | grep -c '^kind: Application$') + 1)) # 자식 앱과 뿌리 앱

# ---------------------------------------------------------------- 2 이미지
log 2/7 "API 이미지(HEAD의 backend/api/Dockerfile): $image"
git -C "$ROOT" archive HEAD .dockerignore backend/api frontend/web | docker build -q -f backend/api/Dockerfile -t "$image" - >/dev/null

# ---------------------------------------------------------------- 3 K3s
k3s=$(sed -n 's/^ *k3s_version: *//p' "$infra/cluster/site.yml")
cilium=$(sed -n 's/^ *cilium_version: *//p' "$infra/cluster/site.yml")
log 3/7 "K3s $k3s 한 대(Docker). traefik·servicelb 끔(실제와 같음), 네트워크 정책 끔, CNI는 flannel"
docker run -d --name "$id-k3s" --hostname "$id-k3s" --privileged -p 127.0.0.1::6443 \
  "rancher/k3s:${k3s/+/-}" server --disable=traefik --disable=servicelb --disable-network-policy >/dev/null
retry 60 docker exec "$id-k3s" test -s /etc/rancher/k3s/k3s.yaml
# 같은 노드에서 파드 → 서비스 → 파드의 응답이 iptables를 거쳐야 한다. 없으면 클러스터 DNS부터 닿지 않는다
docker exec "$id-k3s" test -e /proc/sys/net/bridge/bridge-nf-call-iptables ||
  fail "커널 모듈 br_netfilter가 없습니다(리눅스: sudo modprobe br_netfilter)"
port=$(docker port "$id-k3s" 6443/tcp | head -1)
docker exec "$id-k3s" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://127.0.0.1:${port##*:}#" > "$KUBECONFIG"
retry 60 kubectl wait --for=condition=Ready node --all --timeout=5s
retry 60 kubectl -n kube-system rollout status deploy/coredns --timeout=5s
docker save "$image" | docker exec -i "$id-k3s" ctr -n k8s.io images import - >/dev/null
docker cp -q "$OUT/gachita.git" "$id-k3s:/var/lib/rancher/gachita.git"

# ---------------------------------------------------------------- 4 구축 5단계
log 4/7 "구축 5단계: 우선순위 클래스, Cilium 정책 CRD($cilium), Argo CD(cluster/argocd)"
kubectl apply --server-side -f "$infra/cluster/base/priorityclasses.yaml" >/dev/null
kubectl apply --server-side \
  -f "https://raw.githubusercontent.com/cilium/cilium/v$cilium/pkg/k8s/apis/cilium.io/client/crds/v2/ciliumnetworkpolicies.yaml" >/dev/null
kubectl apply --server-side --force-conflicts -k "$infra/cluster/argocd" >/dev/null
for r in statefulset/argocd-application-controller deploy/argocd-repo-server deploy/argocd-server deploy/argocd-redis \
  deploy/argocd-applicationset-controller; do
  kubectl -n argocd rollout status "$r" --timeout=300s >/dev/null
done

# 로컬 git 서버. 노드에 복사한 저장소를 Argo CD 이미지(이미 노드에 있음)의 git daemon으로 읽기 전용으로 낸다
argocd_image=$(kubectl -n argocd get deploy argocd-repo-server -o jsonpath='{.spec.template.spec.containers[0].image}')
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: {name: gitserver, namespace: default, labels: {app: gitserver}}
spec:
  containers:
    - name: git
      image: $argocd_image
      # 복사한 저장소는 root 소유라 파드 사용자(argocd)에게 safe.directory를 연다
      command: [git, -c, "safe.directory=*", daemon, --base-path=/srv, --export-all, --reuseaddr, /srv]
      ports: [{name: git, containerPort: 9418}]
      volumeMounts: [{name: repo, mountPath: /srv/gachita.git, readOnly: true}]
  volumes: [{name: repo, hostPath: {path: /var/lib/rancher/gachita.git, type: Directory}}]
---
apiVersion: v1
kind: Service
metadata: {name: gitserver, namespace: default}
spec:
  selector: {app: gitserver}
  ports: [{name: git, port: 9418, targetPort: git}]
YAML
kubectl wait --for=condition=Ready pod/gitserver --timeout=120s >/dev/null
retry 12 kubectl -n argocd exec deploy/argocd-repo-server -c argocd-repo-server -- git ls-remote "$url" e2e
log 4/7 "로컬 git 서버: $url (브랜치 e2e)"

# ---------------------------------------------------------------- 5 구축 6단계
log 5/7 "구축 6단계: 뿌리 앱(templates/root-app.yaml.j2, db_bootstrap=initdb)"
ansible localhost -i localhost, -c local -e ansible_python_interpreter=auto_silent -m ansible.builtin.template \
  -a "src=$infra/cluster/templates/root-app.yaml.j2 dest=$OUT/root-app.yaml" \
  -e "$(jq -nc --arg r "$url" '{gitops_repo: $r, gitops_revision: "e2e", db_bootstrap: "initdb"}')" >/dev/null
kubectl apply -f "$OUT/root-app.yaml" >/dev/null
root_at=$SECONDS

# ---------------------------------------------------------------- 6 구축 7단계: 물결
# 2초마다 앱 목록을 보고, (동기화, 건강)이 바뀐 앱마다 한 줄을 남긴다: 시각 물결 앱 동기화 건강
log 6/7 "물결이 끝까지(앱 $want개, 최대 ${WAIT}초)"
prev="" last=""
while :; do
  snap=$(kubectl -n argocd get applications -o json 2>/dev/null) || snap='{"items": []}'
  cur=$(jq -r '.items[] | [(.metadata.annotations["argocd.argoproj.io/sync-wave"] // "root"), .metadata.name,
    (.status.sync.status // "-"), (.status.health.status // "-")] | @tsv' <<<"$snap" | sort -n)
  grep -vxF -f <(printf '%s\n' "$prev") <<<"$cur" | awk -v t="$(date -u +%T)" '{print t "\t" $0}' >> "$OUT/waves.log" || true
  prev=$cur
  pending=$(jq -r --argjson want "$want" '
    [.items[] | select(.status.sync.status != "Synced" or .status.health.status != "Healthy")
     | "\(.metadata.annotations["argocd.argoproj.io/sync-wave"] // "-"):\(.metadata.name):\(.status.sync.status // "?")/\(.status.health.status // "?")"]
    + (if (.items | length) < $want then ["앱 \(.items | length)/\($want)개"] else [] end) | join(" ")' <<<"$snap")
  [ -n "$pending" ] || break
  if [ "$pending" != "$last" ]; then
    log 6/7 "남은 것: $pending"
    last=$pending
  fi
  [ $((SECONDS - root_at)) -lt "$WAIT" ] || fail "물결이 ${WAIT}초 안에 끝나지 않았습니다. 남은 것: $pending"
  sleep 2
done
waves=$((SECONDS - root_at))
log 6/7 "모든 앱 Synced·Healthy: 뿌리 앱을 넣고 ${waves}초"

# 순서: 물결 n의 앱이 처음 보이기 전에 그보다 앞 물결의 앱이 모두 Healthy로 보였어야 한다(waves.log의 줄 순서로 본다)
table=$(awk -F'\t' '
  $2 == "root" { next }
  !($3 in wave) { wave[$3] = $2; seen[$3] = $1; if (!($2 in first)) first[$2] = NR }
  $5 == "Healthy" && !($3 in hrow) { hrow[$3] = NR; htime[$3] = $1 }
  END {
    for (a in wave) {
      for (w in first) if (w + 0 > wave[a] + 0 && !((a in hrow) && hrow[a] < first[w])) {
        print "물결 " w "이 " a "(물결 " wave[a] ")가 Healthy가 되기 전에 시작했습니다" > "/dev/stderr"; bad = 1
      }
      printf "| %s | %s | %s | %s |\n", wave[a], a, seen[a], ((a in htime) ? htime[a] : "-")
    }
    exit bad
  }' "$OUT/waves.log" | sort -t'|' -k2,2n -k4,4) || fail "물결 순서가 어긋났습니다(waves.log)"

# ---------------------------------------------------------------- 7 /healthz
log 7/7 "쿠버네티스 DNS 이름으로 /healthz(default 네임스페이스의 일회용 파드에서)"
kubectl run healthz --image="$image" --restart=Never --command -- node -e '
fetch("http://gachita-api.gachita.svc.cluster.local/healthz").then(
  async (r) => { console.log(r.status, await r.text()); process.exit(r.status === 200 ? 0 : 1); },
  (e) => { console.log(String(e)); process.exit(1); })' >/dev/null
for _ in $(seq 60); do
  phase=$(kubectl get pod healthz -o jsonpath='{.status.phase}')
  case $phase in Succeeded | Failed) break ;; esac
  sleep 2
done
healthz=$(kubectl logs healthz 2>&1 || true)
[ "$phase" = Succeeded ] || fail "/healthz가 200이 아닙니다($phase): $healthz"
log 7/7 "/healthz: $healthz"

{
  printf '### 물결 E2E 통과 (%s)\n\n' "$SHA"
  printf '| 물결 | 앱 | 처음 보임(UTC) | Healthy(UTC) |\n|---|---|---|---|\n%s\n\n' "$table"
  printf -- '- 뿌리 앱을 넣고 모든 앱(%s개) Synced·Healthy까지 %d분 %d초. 스크립트 전체 %d분 %d초\n' \
    "$want" $((waves / 60)) $((waves % 60)) $((SECONDS / 60)) $((SECONDS % 60))
  printf -- '- `http://gachita-api.gachita.svc.cluster.local/healthz`: %s\n' "$healthz"
  printf -- '- 로컬에서 대신하거나 뺀 것은 `backend/infra/cluster/e2e-local.sh` 머리에 있다(덮어쓰기는 local-overrides.diff)\n'
} > "$OUT/summary.md"
cat "$OUT/summary.md"
