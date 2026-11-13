#!/usr/bin/env bash
# 펴기와 접기(ADR-0017, T53). infra 워크플로와 사람이 같은 순서로 돌린다. 다시 돌려도 결과가 같게 짰다.
#
#   backend/infra/infra.sh up     남는 묶음 → 접는 묶음 → 구축 단계(서버 안) → ALB → 레코드 → 확인
#   backend/infra/infra.sh down   마지막 백업 → edge 앱 지우기(컨트롤러가 ALB를 지움) → 접는 묶음 destroy → 남은 것 확인
#
# 필요한 것: AWS 자격(워크플로는 OIDC 적용 역할), 상태 버킷 TF_STATE_BUCKET, jq.
# 고를 것: CLOUDFLARE_API_TOKEN과 TF_VAR_cloudflare_zone_id(없으면 인증서·레코드 없이 ALB까지만),
#          TF_VAR_gitops_revision(병합 전 브랜치를 실제 계정에 펼 때).
set -euo pipefail

REGION=${AWS_REGION:-ap-northeast-2}
ENV_NAME=${TF_VAR_env:-dev}
CLUSTER=gachita-$ENV_NAME # Terraform local.cluster, 컨트롤러의 clusterName, ALB 이름
TF=$(cd "$(dirname "$0")/terraform" && pwd)
: "${TF_STATE_BUCKET:?상태 버킷 이름(TF_STATE_BUCKET)이 필요합니다}"
export AWS_REGION=$REGION AWS_PAGER=""

log() { echo "[$(date +%H:%M:%S) $1] $2"; }
fail() {
  echo "::error::$1"
  exit 1
}

tf() { # tf <묶음 폴더> <명령...>. 묶음마다 상태 키가 다르다(main은 dev/, persist는 persist/)
  local dir=$1 key
  shift
  key=$([ "$dir" = "$TF" ] && echo "$ENV_NAME" || basename "$dir")/terraform.tfstate
  terraform -chdir="$dir" init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" \
    -backend-config="key=$key" -backend-config="region=$REGION" -backend-config=use_lockfile=true \
    -backend-config=encrypt=true >/dev/null
  terraform -chdir="$dir" "$@"
}

# 서버에서 명령 하나를 돌리고(SSM Run Command) 출력을 보인다. 실패하면 실패한다.
on_server() { # on_server <인스턴스> <최대 초> <명령>
  local id=$1 max=$2 cmd=$3 cid status i
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

up() {
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
      out=$(on_server "$id" 60 'ls /var/lib/gachita/bootstrap 2>/dev/null | tr "\n" " "; cloud-init status 2>/dev/null | tail -1' || true)
      echo "  $out"
      case $out in *7-verify.done*) break ;; *"status: error"*) break ;; esac
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
  local tg health=""
  tg=$(aws elbv2 describe-target-groups --load-balancer-arn "$(alb_arn)" --query 'TargetGroups[].TargetGroupArn' --output text)
  for ((i = 0; i < 30; i++)); do
    health=$(for t in $tg; do aws elbv2 describe-target-health --target-group-arn "$t" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text; done | tr '\t' '\n' | sort | uniq -c | tr '\n' ' ')
    [[ -n $tg && $health =~ healthy && ! $health =~ (unhealthy|initial|draining|unused) ]] && break
    sleep 10
  done
  echo "  대상 상태: $health"
  [[ $health =~ healthy && ! $health =~ (unhealthy|initial|draining|unused) ]] || fail "ALB의 대상이 건강하지 않습니다"
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
  local id=""
  id=$(tf "$TF" output -raw instance_id 2>/dev/null || true)
  if [[ $id == i-* ]] && ssm_online "$id"; then
    log 1/4 "마지막 전체 백업(T52). WAL 보관 주기 사이의 마지막 변경까지 S3에 남긴다(최대 20분)"
    on_server "$id" 1200 '
      set -euo pipefail
      export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
      if kubectl -n gachita-db get cluster db >/dev/null 2>&1; then
        n=fold-$(date +%Y%m%d%H%M%S)
        printf "apiVersion: postgresql.cnpg.io/v1\nkind: Backup\nmetadata: {name: %s, namespace: gachita-db}\nspec:\n  cluster: {name: db}\n  method: plugin\n  pluginConfiguration: {name: barman-cloud.cloudnative-pg.io}\n" "$n" | kubectl apply -f -
        kubectl -n gachita-db wait backup/$n --for=jsonpath="{.status.phase}"=completed --timeout=1100s
      else
        echo "Postgres가 없어 백업을 건너뜀"
      fi' || fail "마지막 백업이 끝나지 않았습니다. 데이터를 지키려면 접지 않습니다(고친 뒤 다시)"

    log 2/4 "edge 앱을 지운다: Gateway가 지워지며 컨트롤러가 ALB·대상 그룹·보안 그룹을 지운다(최대 10분)"
    on_server "$id" 700 '
      set -euo pipefail
      export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
      # 뿌리 앱이 edge 앱을 다시 만들지 않게 자동 동기화를 끈다. 다른 앱(컨트롤러 포함)은 그대로 둔다
      kubectl -n argocd patch application root --type merge -p "{\"spec\":{\"syncPolicy\":{\"automated\":null}}}"
      kubectl -n argocd delete application edge --ignore-not-found --wait=true --timeout=600s' ||
      echo "  edge 앱을 지우지 못했습니다. 태그로 정리합니다"
  else
    log 1/4 "서버가 없거나 SSM에 붙지 않아 백업과 edge 앱 지우기를 건너뜀(이미 접혔거나 클러스터가 망가짐)"
  fi

  log 2/4 "컨트롤러가 만든 ALB가 사라졌는지(최대 5분). 남았으면 태그로 지운다"
  local i
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

  log 3/4 "접는 묶음 destroy(레코드 포함). 남는 묶음은 건드리지 않는다"
  if ! tf "$TF" destroy -input=false -auto-approve; then
    # 컨트롤러의 보안 그룹이 남아 VPC를 못 지운 때: 노드 보안 그룹(그것을 가리키던 규칙)은 이미 지워졌으니 지울 수 있다
    for sg in $(lbc_resources ec2:security-group); do
      echo "  컨트롤러의 보안 그룹을 직접 지움: ${sg##*/}"
      aws ec2 delete-security-group --group-id "${sg##*/}" || true
    done
    tf "$TF" destroy -input=false -auto-approve
  fi

  log 4/4 "남은 것: Project=gachita 태그가 붙은 EC2·ELB가 없어야 한다(태그 목록은 몇 분 늦게 맞춰질 수 있음)"
  local left=""
  for ((i = 0; i < 18; i++)); do
    # 지운 서버는 한동안 terminated로 보이므로 서버는 상태로 따로 본다
    left="$(aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=gachita \
      --resource-type-filters ec2 elasticloadbalancing --query 'ResourceTagMappingList[].ResourceARN' --output text |
      tr '\t' '\n' | grep -v ':instance/' || true) $(aws ec2 describe-instances --filters Name=tag:Project,Values=gachita \
      Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)"
    left=$(echo "$left" | xargs)
    [ -z "$left" ] && break
    sleep 10
  done
  [ -z "$left" ] || fail "접은 뒤에도 남은 것: $left"
  echo "  남는 묶음(접지 않음):"
  aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=gachita \
    --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | sed 's/^/    /'
  log 끝 "접었습니다"
}

case ${1:-} in
up) up ;;
down) down ;;
*)
  echo "쓰는 법: $0 up|down" >&2
  exit 2
  ;;
esac
