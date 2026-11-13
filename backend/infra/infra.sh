#!/usr/bin/env bash
# 펴기와 접기(ADR-0017, T53). infra 워크플로와 사람이 같은 순서로 돌린다. 다시 돌려도 결과가 같게 짰다.
#
#   backend/infra/infra.sh up     남는 묶음 → 접는 묶음 → 구축 단계(서버 안) → ALB → 레코드 → 확인
#   backend/infra/infra.sh down   edge 앱 지우기(길을 닫음, 컨트롤러가 ALB를 지움) → 마지막 백업 → 접는 묶음 destroy → 남은 것 확인
#
# 운영(T57, ops 워크플로). 떠 있는 서버에 SSM으로 명령을 보낸다. 서버가 없으면 실패한다.
#   backend/infra/infra.sh status              노드, 구축 단계, 앱 물결, Postgres와 백업, ALB 대상, 소진 속도 알림, 실제 주소(SERVICE_URL)
#   backend/infra/infra.sh converge [단계,...]  구축 단계 다시 돌리기(비우면 전부. os,k3s,cilium,oidc,argocd,root,verify)
#   backend/infra/infra.sh backup              손 전체 백업
#   backend/infra/infra.sh restore [시각] [apply]  지정 시점 복구. 옆에 db-pitr을 세워 재고 비교한다(연습).
#                                              apply면 먼저 db를 백업하고 db-pitr의 데이터를 db에 덮어쓴다
#   backend/infra/infra.sh clean-e2e           실제 주소 E2E와 부하 시험이 남긴 여행(제목이 'E2E '로 시작)을 지운다(T54, T62)
#
# 필요한 것: AWS 자격(워크플로는 OIDC 적용 역할), jq. up·down은 상태 버킷 TF_STATE_BUCKET도.
# 고를 것: CLOUDFLARE_API_TOKEN과 TF_VAR_cloudflare_zone_id(없으면 인증서·레코드 없이 ALB까지만),
#          TF_VAR_gitops_revision(병합 전 브랜치를 실제 계정에 펼 때).
set -euo pipefail

REGION=${AWS_REGION:-ap-northeast-2}
ENV_NAME=${TF_VAR_env:-dev}
CLUSTER=gachita-$ENV_NAME # Terraform local.cluster, 컨트롤러의 clusterName, ALB 이름
TF=$(cd "$(dirname "$0")/terraform" && pwd)
export AWS_REGION=$REGION AWS_PAGER=""

log() { echo "[$(date +%H:%M:%S) $1] $2"; }
fail() { # 표준 오류로: $(…) 안에서 불려도 메시지가 보인다
  echo "::error::$1" >&2
  exit 1
}

tf() { # tf <묶음 폴더> <명령...>. 묶음마다 상태 키가 다르다(main은 dev/, persist는 persist/)
  local dir=$1 key
  shift
  : "${TF_STATE_BUCKET:?상태 버킷 이름(TF_STATE_BUCKET)이 필요합니다}"
  key=$([ "$dir" = "$TF" ] && echo "$ENV_NAME" || basename "$dir")/terraform.tfstate
  terraform -chdir="$dir" init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" \
    -backend-config="key=$key" -backend-config="region=$REGION" -backend-config=use_lockfile=true \
    -backend-config=encrypt=true >/dev/null
  if [ "$dir" = "$TF" ] && [ "${1:-}" = apply ]; then
    # 환경 변수뿐 아니라 .tfvars로 켠 agent도 자동 up 경로에 들어오지 못하게 실제 계획을 검사합니다.
    local plan_dir
    plan_dir=$(mktemp -d)
    if ! terraform -chdir="$dir" plan -input=false -out="$plan_dir/plan" >&2 ||
      ! terraform -chdir="$dir" show -json "$plan_dir/plan" | python3 "$TF/../migration/check_plan.py" legacy; then
      rm -rf "$plan_dir"
      fail "단일 노드 up 계획을 중단했습니다. migration/README.md의 별도 절차를 따르십시오"
    fi
    terraform -chdir="$dir" apply -input=false "$plan_dir/plan" || { rm -rf "$plan_dir"; return 1; }
    rm -rf "$plan_dir"
    return 0
  fi
  terraform -chdir="$dir" "$@"
}

# 서버에서 명령 하나를 돌리고(SSM Run Command) 출력을 보인다. 실패하면 실패한다.
on_server() { # on_server <인스턴스> <최대 초> <명령>
  local id=$1 max=$2 cmd=$3 cid status i
  # SSM은 명령을 sh(dash)로 돌린다. bash로, 따옴표가 깨지지 않게 base64로 감싸 보낸다
  cmd="echo $(printf '%s' "$cmd" | base64 | tr -d '\n') | base64 -d | bash"
  cid=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --parameters "$(jq -n --arg c "$cmd" --arg t "$max" '{commands: [$c], executionTimeout: [$t]}')" \
    --query Command.CommandId --output text)
  for ((i = 0; i < max / 5 + 12; i++)); do
    sleep 5
    status=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)
    case $status in Pending | InProgress | Delayed) continue ;; esac
    aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" \
      --query '[StandardOutputContent, StandardErrorContent]' --output text
    [ "$status" = Success ]
    return
  done
  return 1
}

ssm_online() { # 서버의 SSM 에이전트가 붙었는지
  [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$1" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ]
}

alb_arn() {
  aws elbv2 describe-load-balancers --names "$CLUSTER" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true
}

# 컨트롤러가 만든 것(클러스터 태그). 접기에서 컨트롤러가 못 지웠을 때만 쓴다(ADR-0017 3절).
lbc_resources() { # lbc_resources <종류 필터: elasticloadbalancing:loadbalancer 등>
  aws resourcegroupstaggingapi get-resources --resource-type-filters "$1" \
    --tag-filters "Key=elbv2.k8s.aws/cluster,Values=$CLUSTER" --query 'ResourceTagMappingList[].ResourceARN' --output text
}

target_health() { # ALB 대상의 상태별 개수(예: "1 healthy"). ALB가 없으면 빈 줄
  local a t
  a=$(alb_arn)
  [ -n "$a" ] && [ "$a" != None ] || return 0
  for t in $(aws elbv2 describe-target-groups --load-balancer-arn "$a" --query 'TargetGroups[].TargetGroupArn' --output text); do
    aws elbv2 describe-target-health --target-group-arn "$t" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text
  done | tr '\t' '\n' | sort | uniq -c | xargs
}
healthy() { [[ $1 =~ healthy && ! $1 =~ (unhealthy|initial|draining|unused) ]]; }

# 서버에서 도는 전체 백업(최대 약 18분). 이름 앞머리(fold, manual, before-restore)로 누가 떴는지 남긴다.
# Postgres가 없는 것(CRD나 클러스터가 없음)과 클러스터에 묻지 못하는 것(API 오류)을 가른다. 없을 때 접기는 건너뛰고 나머지는 실패한다
backup_script() { # backup_script <앞머리>
  echo "prefix=$1"
  cat <<'EOF'
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
crd=$(kubectl get crd clusters.postgresql.cnpg.io --ignore-not-found -o name)
db=$([ -z "$crd" ] || kubectl -n gachita-db get clusters.postgresql.cnpg.io db --ignore-not-found -o name)
if [ -z "$db" ]; then echo "Postgres(gachita-db/db)가 없습니다"; [ "$prefix" = fold ]; exit; fi
n=$prefix-$(date +%Y%m%d%H%M%S)
printf "apiVersion: postgresql.cnpg.io/v1\nkind: Backup\nmetadata: {name: %s, namespace: gachita-db}\nspec:\n  cluster: {name: db}\n  method: plugin\n  pluginConfiguration: {name: barman-cloud.cloudnative-pg.io}\n" "$n" | kubectl apply -f -
for i in $(seq 1 220); do
  p=$(kubectl -n gachita-db get backup/$n -o jsonpath="{.status.phase}")
  case $p in completed) echo "백업 $n 완료"; exit 0 ;; failed) kubectl -n gachita-db get backup/$n -o jsonpath="{.status.error}"; exit 1 ;; esac
  sleep 5
done
echo "백업 $n 이 끝나지 않았습니다(마지막 상태: $p)"
exit 1
EOF
}

migration_on_server() {
  local id=$1 action=$2
  on_server "$id" 180 "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; python3 - '$action' <<'MIGRATION_PY'
$(cat "$TF/../migration/control.py")
MIGRATION_PY"
}

guard_legacy() {
  local agents ids
  agents=$(aws ec2 describe-instances --filters "Name=tag:Project,Values=gachita" "Name=tag:Env,Values=$ENV_NAME" \
    Name=tag:NodePool,Values=app,data Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text) || fail "agent 조회 실패: 기존 운영 명령을 실행하지 않습니다"
  [ -z "$agents" ] || fail "사설 agent가 있습니다. 단일 노드 운영 명령을 사용할 수 없습니다"
  ids=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$CLUSTER-k3s" \
    Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text) || fail "서버 조회 실패"
  [ -n "$ids" ] || return 0
  [[ $ids =~ ^i-[0-9a-f]+$ ]] || fail "서버가 한 대가 아니어서 전환 상태를 판정할 수 없습니다"
  ssm_online "$ids" || fail "서버의 전환 상태를 읽을 수 없습니다. 기존 운영 명령을 실행하지 않습니다"
  migration_on_server "$ids" guard || fail "전환 상태 보호 장치가 기존 운영 명령을 차단했습니다"
}

server() { # 떠 있는 서버(Name 태그)의 인스턴스 번호. 없거나 SSM에 붙지 않으면 실패한다
  local id
  id=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$CLUSTER-k3s" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  [[ $id =~ ^i-[0-9a-f]+$ ]] || fail "떠 있는 서버($CLUSTER-k3s)가 없습니다(${id:-없음}). 접힌 상태면 먼저 펴기(infra 워크플로 up)"
  ssm_online "$id" || fail "서버 $id 의 SSM 에이전트가 붙지 않았습니다"
  echo "$id"
}

up() {
  : "${TF_STATE_BUCKET:?상태 버킷 이름(TF_STATE_BUCKET)이 필요합니다}"
  log 1/6 "남는 묶음(버킷, 인증서): 보통 바뀔 것이 없다"
  tf "$TF/persist" apply -input=false -auto-approve

  log 2/6 "접는 묶음(네트워크, 서버, 역할). 서버의 첫 부팅이 구축 단계를 시작한다"
  tf "$TF" apply -input=false -auto-approve
  local id
  id=$(terraform -chdir="$TF" output -raw instance_id)

  log 3/6 "구축 7단계가 끝날 때까지(서버 $id, 최대 40분). 단계마다 기록 파일을 본다"
  local i out=""
  for ((i = 0; i < 80; i++)); do
    if ssm_online "$id"; then
      # 첫 부팅이 실패했어도 구축을 다시 돌리는 중(gachita-converge)이면 기다린다
      out=$(on_server "$id" 60 'ls /var/lib/gachita/bootstrap 2>/dev/null | tr "\n" " "; cloud-init status 2>/dev/null | tail -1; pgrep -fc "ansible-pull|ansible-playbook" || true' || true)
      echo "  $(echo "$out" | tr '\n' ' ')"
      case $out in *7-verify.done*) break ;; *"status: error"*$'\n'0*) break ;; esac
    else
      echo "  서버의 SSM 에이전트를 기다림"
    fi
    sleep 30
  done
  if [[ $out != *7-verify.done* ]]; then
    ssm_online "$id" && on_server "$id" 60 'tail -40 /var/log/gachita/bootstrap.log' || true
    fail "구축 단계가 끝나지 않았습니다. 위 로그의 마지막 '[n/7 이름]'이 멈춘 단계입니다"
  fi

  log 4/6 "컨트롤러가 만든 ALB($CLUSTER)가 active가 될 때까지(최대 10분)"
  local state=""
  for ((i = 0; i < 60; i++)); do
    state=$(aws elbv2 describe-load-balancers --names "$CLUSTER" --query 'LoadBalancers[0].State.Code' --output text 2>/dev/null || true)
    [ "$state" = active ] && break
    sleep 10
  done
  [ "$state" = active ] || fail "ALB가 active가 아닙니다($state). kubectl -n edge describe gateway public 과 컨트롤러 로그를 봅니다"

  log 5/6 "접는 묶음을 한 번 더: ALB가 생겼으니 Cloudflare 레코드가 그것을 가리킨다"
  tf "$TF" apply -input=false -auto-approve

  log 6/6 "확인: ALB의 대상(노드의 NodePort)이 건강한지(최대 5분)"
  local health=""
  for ((i = 0; i < 30; i++)); do
    health=$(target_health)
    healthy "$health" && break
    sleep 10
  done
  echo "  대상 상태: $health"
  healthy "$health" || fail "ALB의 대상이 건강하지 않습니다"
  if [ -n "${TF_VAR_cloudflare_zone_id:-}" ]; then
    local host
    host=$(terraform -chdir="$TF" output -raw service_url)
    for ((i = 0; i < 30; i++)); do curl -sf --max-time 10 "$host/healthz" && break || sleep 10; done
    curl -sf --max-time 10 "$host/healthz" >/dev/null || fail "$host/healthz 가 200이 아닙니다(Cloudflare → ALB)"
    echo
    log 끝 "$host 이 열렸습니다. 다음은 실제 주소 E2E(live-e2e 워크플로)"
  else
    log 끝 "Cloudflare 영역이 없어 레코드 없이 ALB까지 폈습니다: $(terraform -chdir="$TF" output -raw alb_dns)"
  fi
}

down() {
  : "${TF_STATE_BUCKET:?상태 버킷 이름(TF_STATE_BUCKET)이 필요합니다}"
  local id up="" i
  # 서버가 있으면(멈춘 것도) 마지막 백업을 확인해야 접는다. destroy는 루트 디스크(DB와 아직 보관 못 한 WAL)를 같이 지운다.
  # 서버는 상태 파일(terraform output)이 아니라 이름 태그로 찾는다: output이 실패하거나 낡아도 놓치지 않게. 묻지 못하면 여기서 멈춘다(set -e)
  id=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$CLUSTER-k3s" \
    Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
  [[ -z $id || $id =~ ^i-[0-9a-f]+$ ]] || fail "서버($CLUSTER-k3s)가 하나가 아닙니다: $id"
  if [ -n "$id" ]; then
    for ((i = 0; i < 30; i++)); do ssm_online "$id" && up=1 && break || sleep 10; done
    [ -n "$up" ] || fail "서버 $id 가 있는데 5분 동안 SSM에 닿지 않아 마지막 백업을 확인할 수 없습니다. 데이터를 지키려고 접지 않습니다.
  서버를 되살려 SSM이 붙은 뒤 다시 접습니다. S3의 마지막 WAL까지만 남겨도 된다고 정했으면 사람이 서버를 지운 뒤(aws ec2 terminate-instances) 다시 접습니다"
  fi
  # 길을 먼저 닫고 백업한다. 백업 뒤에 길을 닫으면 그사이 들어온 쓰기는 다음 WAL 조각에만 있어(보관 주기 5분)
  # destroy가 서버를 끝낼 때 사라진다
  if [ -n "$up" ]; then
    log 1/5 "들어오는 길을 닫는다: edge 앱을 지우면 Gateway가 지워지며 컨트롤러가 ALB·대상 그룹·보안 그룹을 지운다(최대 10분)"
    on_server "$id" 700 '
      set -euo pipefail
      export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
      # 뿌리 앱이 edge 앱을 다시 만들지 않게 자동 동기화를 끈다. 다른 앱(컨트롤러 포함)은 그대로 둔다
      kubectl -n argocd patch application root --type merge -p "{\"spec\":{\"syncPolicy\":{\"automated\":null}}}"
      kubectl -n argocd delete application edge --ignore-not-found --wait=true --timeout=600s' ||
      echo "  edge 앱을 지우지 못했습니다. 태그로 정리합니다"
  else
    log 1/5 "서버가 없어 edge 앱 지우기와 백업을 건너뜀(이미 접힘)"
  fi

  log 2/5 "컨트롤러가 만든 ALB가 사라졌는지(최대 5분). 남았으면 태그로 지운다"
  for ((i = 0; i < 30; i++)); do [ -z "$(alb_arn)" ] || [ "$(alb_arn)" = None ] && break || sleep 10; done
  for a in $(lbc_resources elasticloadbalancing:loadbalancer); do
    echo "  ALB를 직접 지움: $a"
    aws elbv2 delete-load-balancer --load-balancer-arn "$a"
  done
  aws elbv2 wait load-balancers-deleted --names "$CLUSTER" 2>/dev/null || true
  for t in $(lbc_resources elasticloadbalancing:targetgroup); do
    echo "  대상 그룹을 직접 지움: $t"
    aws elbv2 delete-target-group --target-group-arn "$t"
  done

  if [ -n "$up" ]; then
    log 3/5 "마지막 전체 백업(T52). 길이 닫힌 뒤라 마지막 쓰기까지 들어간다(최대 20분). Postgres가 없으면 건너뛰고, 묻지 못하면 접지 않는다"
    on_server "$id" 1200 "$(backup_script fold)" || fail "마지막 백업이 끝나지 않았습니다. 데이터를 지키려면 접지 않습니다(고친 뒤 다시). 들어오는 길은 닫혀 있습니다. 다시 열려면 서버에서 kubectl -n argocd patch application root --type merge -p '{\"spec\":{\"syncPolicy\":{\"automated\":{\"prune\":true,\"selfHeal\":true}}}}' 뒤 infra.sh up(ALB가 새 주소로 생기므로 5/6이 레코드를 고침)"
  fi

  log 4/5 "접는 묶음 destroy(레코드 포함). 남는 묶음은 건드리지 않는다"
  if ! tf "$TF" destroy -input=false -auto-approve; then
    # 컨트롤러의 보안 그룹이 남아 VPC를 못 지운 때: 노드 보안 그룹(그것을 가리키던 규칙)은 이미 지워졌으니 지울 수 있다
    for sg in $(lbc_resources ec2:security-group); do
      echo "  컨트롤러의 보안 그룹을 직접 지움: ${sg##*/}"
      aws ec2 delete-security-group --group-id "${sg##*/}" || true
    done
    tf "$TF" destroy -input=false -auto-approve
  fi

  log 5/5 "남은 것: Project=gachita 태그가 붙은 네트워크·서버·디스크와 컨트롤러가 만든 ALB·대상 그룹이 없어야 한다"
  # 태그 검색 API(resourcegroupstaggingapi)는 지운 것을 몇 분 넘게 보여 주므로(11/13 실제로 3분 넘게) 서비스마다 직접 묻는다
  local left="" tag=Name=tag:Project,Values=gachita
  for ((i = 0; i < 12; i++)); do
    left=$({
      aws ec2 describe-vpcs --filters $tag --query 'Vpcs[].VpcId' --output text
      aws ec2 describe-instances --filters $tag Name=instance-state-name,Values=pending,running,stopping,stopped \
        --query 'Reservations[].Instances[].InstanceId' --output text
      aws ec2 describe-security-groups --filters $tag --query 'SecurityGroups[].GroupId' --output text
      aws ec2 describe-volumes --filters $tag --query 'Volumes[].VolumeId' --output text
      aws ec2 describe-vpc-endpoints --filters $tag --query 'VpcEndpoints[?State!=`deleted`].VpcEndpointId' --output text
      alb_arn
      for t in $(lbc_resources elasticloadbalancing:targetgroup); do
        aws elbv2 describe-target-groups --target-group-arns "$t" --query 'TargetGroups[].TargetGroupArn' --output text 2>/dev/null || true
      done
    } | { grep -v '^None$' || true; } | xargs)
    [ -z "$left" ] && break
    sleep 10
  done
  [ -z "$left" ] || fail "접은 뒤에도 남은 것: $left"
  local acct b kept=""
  acct=$(aws sts get-caller-identity --query Account --output text)
  # 적용 역할에는 버킷 목록(ListAllMyBuckets)이 없어 이름으로 하나씩 묻는다
  for b in "gachita-$ENV_NAME-$acct" "gachita-$ENV_NAME-oidc-$acct" "$TF_STATE_BUCKET"; do
    aws s3api head-bucket --bucket "$b" 2>/dev/null && kept="$kept $b"
  done
  echo "  남는 것(접지 않음): 버킷$kept"
  log 끝 "접었습니다"
}

# ---- 운영(T57) ----

status() {
  local id bad="" health code url=${SERVICE_URL:-https://gachita.mangowhois.ai}
  id=$(server)
  log 1/4 "클러스터(서버 $id): 노드, 구축 단계, 앱 물결, Postgres와 백업"
  on_server "$id" 120 "$(status_script)" || bad=" 클러스터"
  log 2/4 "ALB 대상"
  health=$(target_health)
  echo "  ${health:-ALB 없음}"
  healthy "$health" || bad="$bad ALB대상"
  log 3/4 "가용성 소진 속도 알림(ADR-0016, Terraform slo.tf)"
  alarms=$(aws cloudwatch describe-alarms --alarm-name-prefix "$CLUSTER-availability-burn-" \
    --query 'MetricAlarms[].[AlarmName, StateValue]' --output text) || alarms="(알림을 묻지 못함) ALARM"
  echo "${alarms:-알림 없음}" | sed 's/^/  /'
  ! awk '$2 == "ALARM"' <<<"$alarms" | grep -q . || bad="$bad 소진속도"
  log 4/4 "실제 주소 ${url%/}/healthz"
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "${url%/}/healthz" || true)
  echo "  $code"
  [ "$code" = 200 ] || bad="$bad 실제주소"
  [ -z "$bad" ] || fail "정상이 아닌 것:$bad"
  log 끝 "모두 정상"
}

status_script() { # 서버에서: 보이고, 앱·DB·WAL 보관 가운데 하나라도 아니면 실패
  cat <<'EOF'
set -uo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
bad=""
echo "== 노드"; kubectl get nodes -o wide --no-headers
echo "== 구축 단계"; ls /var/lib/gachita/bootstrap | xargs
echo "== 앱(물결 이름 동기화 건강)"
apps=$(kubectl -n argocd get applications -o json | jq -r '.items[] | [(.metadata.annotations["argocd.argoproj.io/sync-wave"] // "0"), .metadata.name, .status.sync.status, .status.health.status] | @tsv' | sort -n)
echo "$apps"
if [ -z "$apps" ] || echo "$apps" | awk -F'\t' '$3 != "Synced" || $4 != "Healthy"' | grep -q .; then bad="$bad 앱"; fi
echo "== Postgres(gachita-db/db)"
kubectl -n gachita-db get cluster db -o json | jq -r '"\(.status.phase), 주 인스턴스 \(.status.currentPrimary)", ([.status.conditions[] | "\(.type)=\(.status)"] | join(" "))' || bad="$bad db"
for c in Ready ContinuousArchiving; do
  [ "$(kubectl -n gachita-db get cluster db -o jsonpath="{.status.conditions[?(@.type==\"$c\")].status}" 2>/dev/null)" = True ] || bad="$bad db:$c"
done
echo "== WAL 보관(보관 대기 조각 수, 마지막이 실패인지, 마지막 보관 뒤 초)"
# 데이터와 WAL이 루트 디스크의 같은 PV에 있다(ADR-0018). 보관이 밀리면 WAL이 루트를 채운다. 조각 16 MB, 8개면 128 MB·약 40분 밀림
p=$(kubectl -n gachita-db get cluster db -o jsonpath='{.status.currentPrimary}' 2>/dev/null)
wal=$([ -z "$p" ] || kubectl -n gachita-db exec "$p" -c postgres -- psql -tA -F' ' -c "SELECT (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'), coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false), coalesce(extract(epoch FROM now() - last_archived_time)::int, -1) FROM pg_stat_archiver" 2>/dev/null)
echo "  ${wal:-묻지 못함}"
read -r ready failing _ <<<"$wal"
[[ ${ready:-x} =~ ^[0-9]+$ && $ready -le 8 && $failing == f ]] || bad="$bad WAL보관"
echo "== 디스크(루트, 70% 이상이면 실패. kubelet 이미지 정리 85%·축출 90%보다 앞섬)"
df -h / | tail -1; df -i / | tail -1
use=$(df --output=pcent / | tail -1 | tr -dc 0-9); iuse=$(df --output=ipcent / | tail -1 | tr -dc 0-9)
[ "${use:-100}" -lt 70 ] && [ "${iuse:-100}" -lt 70 ] || bad="$bad 디스크(${use}%,inode${iuse}%)"
du -sh /var/lib/rancher/k3s/storage/* 2>/dev/null | sed 's/^/  /'
echo "== 최근 백업"
kubectl -n gachita-db get backups -o json | jq -r '.items | sort_by(.metadata.creationTimestamp) | .[-3:][] | "\(.metadata.name) \(.status.phase) \(.status.stoppedAt // "-")"'
echo "== 되감을 수 있는 구간(ObjectStore backup의 서버 db). 없거나 마지막 전체 백업이 26시간(매일 + 2시간)보다 오래면 실패"
win=$(kubectl -n gachita-db get objectstore backup -o json 2>/dev/null | jq -c '.status.serverRecoveryWindow.db // empty')
echo "  ${win:-없음}"
first=$(jq -r '.firstRecoverabilityPoint // empty' <<<"$win"); last=$(jq -r '.lastSuccessfulBackupTime // empty' <<<"$win")
[ -n "$first" ] || bad="$bad 복구구간"
age=$([ -z "$last" ] || echo $(($(date +%s) - $(date -d "$last" +%s))))
[[ -n $age && $age -le $((26 * 3600)) ]] || bad="$bad 전체백업(${last:-없음})"
[ -z "$bad" ] || { echo "정상이 아닌 것:$bad"; exit 1; }
EOF
}

converge() { # converge [단계,...]
  local stages=${1:-} id
  [[ -z $stages || ,$stages, =~ ^(,(os|k3s|cilium|oidc|argocd|root|verify))+,$ ]] ||
    fail "단계는 os,k3s,cilium,oidc,argocd,root,verify 가운데서 쉼표로 잇습니다: $stages"
  id=$(server)
  log 1/1 "구축 단계 다시 돌리기(${stages:-전부}, 서버 $id, 최대 40분). 단계마다 이미 됐는지 먼저 본다"
  # 출력이 길어(SSM은 앞 24,000자만 돌려줌) 기록 파일의 끝을 보인다. 마지막 '[n/7 이름]'이 멈춘 단계다
  on_server "$id" 2400 "/usr/local/sbin/gachita-converge${stages:+ --tags $stages} >/dev/null 2>&1; rc=\$?
    tail -n 60 /var/log/gachita/bootstrap.log; exit \$rc" || fail "구축 단계가 실패했습니다(위 기록의 끝)"
  log 끝 "구축 단계를 다시 맞췄습니다"
}

backup() {
  local id
  id=$(server)
  log 1/1 "손 전체 백업(서버 $id, 최대 20분)"
  on_server "$id" 1200 "$(backup_script manual)" || fail "백업이 끝나지 않았습니다"
}

restore() { # restore [시각] [apply]
  local target=${1:-} mode=${2:-} id
  local re='^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
  [[ -z $target || $target =~ $re ]] || fail "시각은 RFC 3339로(예: 2026-11-13T15:00:00+09:00). 비우면 마지막 WAL까지: $target"
  [[ -z $mode || $mode == apply ]] || fail "둘째 인자는 apply만 됩니다: $mode"
  id=$(server)
  log 1/1 "지정 시점 복구(${target:-마지막 WAL까지}, ${mode:-연습: db는 그대로}, 서버 $id, 최대 45분)"
  on_server "$id" 2700 "$(restore_script "$target" "$mode")" || fail "복구가 실패했습니다(위 출력)"
}

# 서버에서: 같은 백업 경로(postgres/db)에서 옆 클러스터 db-pitr을 세우고(쓰기·WAL 보관 없음), 걸린 시간과 표마다 행 수를 db와 비교한다.
# apply면 db를 먼저 백업하고 데이터베이스마다 pg_dump | pg_restore --clean(한 트랜잭션)으로 덮어쓴다. 끝나면 db-pitr을 지운다.
# db-pitr의 자격은 읽기만 하는 역할 gachita-<env>-pg-restore(Terraform iam.tf), 길은 apps/db/base/network.yaml
restore_script() { # restore_script <시각> <apply|"">
  echo "target='$1' mode='$2'"
  cat <<'EOF'
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
k() { kubectl -n gachita-db "$@"; }
k delete cluster db-pitr --ignore-not-found --wait=true # 지난번에 남은 것. 그 공간까지 세지 않게 먼저 지운다
for i in $(seq 60); do ls -d /var/lib/rancher/k3s/storage/*_gachita-db_db-pitr-* >/dev/null 2>&1 || break; sleep 2; done # PVC→PV→디렉터리 정리
# db-pitr도 같은 루트 디스크(local-path)에 선다. 복구본, WAL 재생·임시 파일, apply의 덮어쓰기 WAL을 생각해
# db 실제 크기(PV 디렉터리, PVC 요청 8Gi가 아님)의 3배와 2 GiB가 남아 있어야 시작한다
# du는 재는 도중 사라진 파일(WAL 재활용)에도 0이 아닌 값으로 끝나므로 결과만 쓴다
db_bytes=$({ du -sb /var/lib/rancher/k3s/storage/*_gachita-db_db-[0-9]* 2>/dev/null || true; } | awk '{s += $1} END {print s + 0}')
avail=$(df -B1 --output=avail / | tail -1 | tr -dc 0-9)
need=$((db_bytes * 3 + 2 * 1024 ** 3))
echo "루트 남은 공간 $(numfmt --to=iec "$avail"), db 실제 크기 $(numfmt --to=iec "$db_bytes"), 필요 $(numfmt --to=iec "$need")"
[ "$db_bytes" -gt 0 ] || { echo "db의 PV를 찾지 못해 크기를 재지 못했습니다(/var/lib/rancher/k3s/storage)"; exit 1; }
[ "$avail" -ge "$need" ] || { echo "공간이 모자라 복구를 시작하지 않습니다(운영 db와 같은 디스크)"; exit 1; }
acct=$(sed -n 's/^account_id: "*\([0-9]*\)"*$/\1/p' /etc/gachita/vars.yml)
env=$(sed -n 's/^env: //p' /etc/gachita/vars.yml)
image=$(k get cluster db -o jsonpath='{.spec.imageName}')
trap 'k delete cluster db-pitr --ignore-not-found --wait=false >/dev/null' EXIT
start=$(date +%s)
k apply -f - <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: {name: db-pitr}
spec:
  instances: 1
  imageName: $image
  bootstrap:
    recovery:
      source: origin
      database: trips
      owner: trips
      $([ -z "$target" ] || echo "recoveryTarget: {targetTime: \"$target\"}")
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters: {barmanObjectName: backup, serverName: db}
  storage: {size: 8Gi}
  resources: {requests: {cpu: 100m, memory: 512Mi}, limits: {memory: 512Mi}}
  serviceAccountTemplate:
    metadata:
      annotations: {eks.amazonaws.com/role-arn: "arn:aws:iam::$acct:role/gachita-$env-pg-restore"}
YAML
if ! k wait cluster/db-pitr --for=condition=Ready --timeout=1200s; then
  k get cluster db-pitr; k get pods -l cnpg.io/cluster=db-pitr
  k logs -l cnpg.io/cluster=db-pitr --all-containers --tail=30 || true
  exit 1
fi
echo "db-pitr 준비까지 $(($(date +%s) - start))초(복구 시간)"
old=$(k get cluster db -o jsonpath='{.status.currentPrimary}')
new=$(k get cluster db-pitr -o jsonpath='{.status.currentPrimary}')
# 표마다 정확한 행 수(복구 직후에는 통계가 비어 있어 count(*)로)
counts() { k exec "$1" -c postgres -- psql -d "$2" -tAc "SELECT coalesce(string_agg(format('%s=%s', table_name,
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]), ' ' ORDER BY table_name), '(표 없음)')
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"; }
for d in trips profiles; do echo "$d: db [$(counts "$old" $d)] / db-pitr [$(counts "$new" $d)]"; done
echo "db-pitr의 마지막 여행 시각: $(k exec "$new" -c postgres -- psql -d trips -tAc 'SELECT max(created_at) FROM trips')"
EOF
  [ "$2" = apply ] || return 0
  echo "bash <<'BACKUP'"
  backup_script before-restore
  echo BACKUP
  cat <<'EOF'
for d in trips profiles; do
  k exec "$new" -c postgres -- pg_dump -Fc -d $d | k exec -i "$old" -c postgres -- pg_restore --clean --if-exists --single-transaction -d $d
  echo "$d: db에 덮어씀 → [$(counts "$old" $d)]"
done
EOF
}

clean_e2e() {
  local id
  id=$(server)
  log 1/1 "실제 주소 E2E와 부하 시험이 남긴 여행(제목이 'E2E '로 시작)을 지운다(서버 $id)"
  on_server "$id" 120 "$(
    cat <<'EOF'
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
p=$(kubectl -n gachita-db get cluster db -o jsonpath='{.status.currentPrimary}')
n=$(kubectl -n gachita-db exec "$p" -c postgres -- psql -d trips -tAc "WITH d AS (DELETE FROM trips WHERE doc->>'title' LIKE 'E2E %' RETURNING 1) SELECT count(*) FROM d")
echo "지운 여행: $n"
EOF
  )" || fail "지우지 못했습니다"
}

case ${1:-} in
up | down | converge | backup | restore | clean-e2e) guard_legacy ;;
esac

case ${1:-} in
up) up ;;
down) down ;;
status) status ;;
converge) converge "${2:-}" ;;
backup) backup ;;
restore) restore "${2:-}" "${3:-}" ;;
clean-e2e) clean_e2e ;;
migration)
  case ${2:-} in status | freeze | resume) migration_on_server "$(server)" "$2" ;;
    *) fail "쓰는 법: $0 migration status|freeze|resume" ;;
  esac
  ;;
*)
  echo "쓰는 법: $0 up|down|status|converge [단계,...]|backup|restore [시각] [apply]|clean-e2e|migration status|freeze|resume" >&2
  exit 2
  ;;
esac
