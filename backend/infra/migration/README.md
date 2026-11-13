# 4노드 전환의 제어와 agent 구축 준비

**T84는 기존 서버와 데이터를 유지하면서 전환 제어(P01)와 사설 agent 선언(P02·P03의 준비 범위)을 추가합니다.** 현재 서버를 플랫폼 역할로 남기고 앱 2대·데이터 1대를 추가하는 방향입니다. 이 PR을 병합해도 `enable_private_agents = false`이므로 새 AWS 자원이나 노드를 생성하지 않습니다. 기존 GitOps 배치, 서버 user-data, `site.yml`, DB PVC는 바꾸지 않습니다.

이슈는 [T84 · #241](https://github.com/team-pitcrew/gachita/issues/241), 보드는 [가치타 프로젝트](https://github.com/orgs/team-pitcrew/projects/1), 작업 목록은 [docs/tasks.md](../../../docs/tasks.md), 결과는 [검증 기록](validation-20261114.md)입니다. 사용자에게 제시한 2026-11-14 전환 계획의 첫 구현입니다. P03의 **실제 4노드 Ready 인수는 후속 적용 작업**에 남습니다.

## 시스템: 기존 자원 옆에 추가하는 범위

| 대상 | 이번 선언 | 실제 적용 전 조건 |
|---|---|---|
| 기존 `aws_instance.k3s` | 주소·사양·공개 서브넷·user-data·디스크 그대로 | plan에서 `no-op` 확인 |
| app-a / app-b | t4g.small, 서로 다른 AZ, private subnet | Cilium·예약량·DaemonSet 메모리 검증 |
| data-a | t4g.medium, app-a와 같은 AZ, private subnet | EBS CSI·StorageClass·DB 리허설은 P04·P06 |
| 네트워크 | 10.10.10.0/24·10.10.11.0/24, AZ별 NAT 2대 | 비용·쿼터·라우팅 확인 |
| S3 | 사설 route table 전용 Gateway endpoint | 기존 endpoint는 변경하지 않습니다 |
| SG | 노드 SG 사이 8472/UDP, 4240/TCP, ICMP, 10250/TCP; agent→server 6443/TCP | cross-node DNS·통신·로그·metrics와 비허용 경로 확인 |
| IAM | SSM 관리 + 저장소 토큰·전용 agent 토큰 2개 경로 읽기 | 계정 역할의 NAT/EIP 권한은 별도 account plan/apply 검토 |

처음 계획의 기존 S3 endpoint 확장 대신 새 private route table 전용 endpoint를 선언했습니다. 기존 endpoint 업데이트까지 배제하므로 agent plan을 **허용 목록에 있는 자원 생성만**으로 검사할 수 있습니다. Gateway endpoint 자체에는 시간 요금이 없지만 NAT·EIP·EC2·EBS·전송 비용은 별도입니다. [AWS Gateway endpoint 문서](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html) EBS CSI 및 복구 역할의 확대는 이번 PR에 포함하지 않습니다. 10250/TCP의 출발지는 기존 platform SG로 한정하며 metrics-server도 P04에서 platform 배치를 유지해야 합니다.

## 애플리케이션: 동결과 재개의 순서

`infra.sh migration freeze`는 Argo CD의 13개 앱에 진행 중인 sync가 없는지 확인합니다. 원래 `automated` 정책, 앱 UID, 활성 DB, 목표 노드 역할을 `kube-system/gachita-cluster-migration` ConfigMap에 먼저 저장한 뒤 **root → 자식 앱** 순서로 자동 동기화를 끕니다. 앱 수정은 resourceVersion 검사를 사용합니다. 중간 실패 시 상태와 원래 정책이 남으므로 같은 명령을 재시도하거나 `resume`으로 되돌릴 수 있습니다.

`resume`은 **자식 앱 → root** 순서로 원래 정책을 복원합니다. 원래 자동 동기화가 꺼져 있던 앱이나 `automated` 키가 없던 앱도 그대로 복원합니다. 앱이 재생성되었거나 sync가 진행 중이면 중단합니다. 재개 뒤에도 전환 기록은 남습니다. 전환을 시작한 환경에서 예전 단일 노드 삭제 명령을 다시 사용할 수 있게 자동 해제하지 않습니다.

```bash
# 조회는 현재 운영 상태를 바꾸지 않습니다.
backend/infra/infra.sh migration status

# 아래 두 명령은 운영 변경입니다. 별도 작업창에서 실행합니다.
backend/infra/infra.sh migration freeze
backend/infra/infra.sh migration resume
```

동결은 API 요청·백그라운드 sweep·DB 쓰기를 멈추지 않습니다. P07에서 모든 writer를 중지하는 절차가 따로 필요합니다. 이 도구의 `resume`은 활성 DB가 여전히 `gachita-db/db`인 준비 단계에만 사용합니다. DB 주소나 GitOps 복구 경로가 바뀐 뒤의 재개 절차는 P07에서 새 선언에 맞춰 구현해야 합니다.

전환 기록이 있거나 app/data EC2가 있으면 `up`, `down`, `converge`, `backup`, `restore`, `clean-e2e`를 거절합니다. AWS·SSM·Kubernetes 상태 조회가 실패해도 허용하지 않습니다. `up`은 `.tfvars`로 agent를 켠 경우도 실제 plan에서 차단합니다. `status` 조회는 유지합니다. 전환 상태를 모르는 기존 `pg_restore --clean` 경로를 새 DB에 사용하지 않습니다.

이 보호 장치는 `infra.sh` 진입점의 검사입니다. 직접 실행하는 `terraform apply`, `kubectl`, 서버의 기존 `gachita-converge`, 이미 실행 중인 작업을 강제로 통제하지 않습니다. 전환 작업창에는 기존 infra/ops 워크플로와 수동 sync를 함께 직렬화해야 합니다. 도구는 동시 sync를 발견하면 중단하며, 서버의 파일 잠금은 전환 도구끼리의 동시 실행을 차단합니다. 기존 서버가 있으나 SSM/API가 응답하지 않는 경우도 기존 `up/down`은 중단하므로 먼저 조회 경로를 복구해야 합니다.

## 데이터와 가입 자격의 보존

기존 CNPG Cluster `db`, local-path PVC, 백업 prefix, OIDC 발급자는 이번 변경에서 건드리지 않습니다. 새 agent에는 암호화한 gp3 루트 디스크만 선언하며 DB 데이터 볼륨은 아직 만들지 않습니다. 스토리지·백업·복구 전환은 별도 PR로 수행합니다.

가입 자격의 값은 Terraform에 전달하지 않습니다. agent가 자신의 IAM 역할로 `/gachita/dev/bootstrap/k3s-agent-token` SecureString을 읽고 `0600` 파일에 저장합니다. Ansible의 해당 작업은 `no_log`로 실행합니다. `K10<CA hash>::node:<credential>` 형식만 받으며 server 토큰이나 짧은 토큰으로 대체하지 않습니다. **현재 서버의 기본 agent-token이 server-token을 가리키는 상태라면 먼저 별도의 agent 토큰을 설정하고 서버 재시작 영향을 검토해야 합니다.** 이 PR은 토큰 생성·전달·서버 재시작을 실행하지 않습니다. [K3s token 문서](https://docs.k3s.io/cli/token)

새 agent의 `gachita-agent-converge`는 `agent.yml`만 실행합니다. 기존 server 디렉터리나 서비스가 발견되면 설치 전에 중단합니다. server와 동일한 K3s 버전, AWS providerID, zone/region·instance-type·pool 라벨을 설정합니다. 모든 새 노드에는 `gachita.io/bootstrap=pending:NoSchedule`, data에는 추가로 `gachita.io/pool=data:NoSchedule` taint를 둡니다. P04가 Cilium·스토리지·배치 검증을 마친 뒤 bootstrap taint를 명시적으로 제거해야 합니다. taint는 처음 등록할 때 적용되므로 이미 등록된 Node의 taint 제거는 kubectl로 수행합니다. 설정에 남은 라벨은 agent 재시작 때 다시 반영됩니다. [K3s agent 문서](https://docs.k3s.io/cli/agent)

새 노드에는 `node.kubernetes.io/exclude-from-external-load-balancers=true`도 설정합니다. 현재 ALB가 instance 대상을 사용하므로 NoSchedule taint만으로는 자동 대상 등록을 막을 수 없습니다. P05에서 준비된 앱 노드만 설정 파일과 Node 객체 양쪽에서 이 라벨을 제거하고 ALB health를 확인합니다. data 노드는 계속 제외합니다. [AWS Load Balancer Controller의 기본 NodeSelector](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/targetgroupbinding/targetgroupbinding/)

## 검증 명령과 적용 전 통과 조건

```bash
python3 -m unittest discover -s backend/infra/migration -v
terraform -chdir=backend/infra/terraform fmt -check -recursive
terraform -chdir=backend/infra/terraform init -backend=false
terraform -chdir=backend/infra/terraform validate
terraform -chdir=backend/infra/terraform test
ansible-playbook -i localhost, --syntax-check backend/infra/cluster/site.yml
ansible-playbook -i localhost, --syntax-check backend/infra/cluster/agent.yml
make check
```

실제 계정의 plan은 기존 S3 backend와 현재 Cloudflare 영역 변수를 그대로 사용합니다. 읽기 전용 Cloudflare 토큰이 필요하며, 토큰 없이 영역 변수를 비우면 기존 DNS 삭제 계획이 나오므로 그렇게 대체하지 않습니다. 저장 계획 파일에는 민감한 값이 포함될 수 있어 비공개 임시 디렉터리에서만 취급합니다.

```bash
# 기존 환경과 같은 변수·backend를 초기화한 뒤 수행합니다. apply는 하지 않습니다.
terraform -chdir=backend/infra/terraform plan -lock=false -out=/private/path/default.tfplan
terraform -chdir=backend/infra/terraform show -json /private/path/default.tfplan \
  | python3 backend/infra/migration/check_plan.py default

terraform -chdir=backend/infra/terraform plan -lock=false -var=enable_private_agents=true -out=/private/path/agents.tfplan
terraform -chdir=backend/infra/terraform show -json /private/path/agents.tfplan \
  | python3 backend/infra/migration/check_plan.py agents
```

기본 plan은 모든 기존 관리 자원의 `no-op`, 활성화 plan은 알려진 새 자원 생성만 허용합니다. 교체·삭제·기존 자원 업데이트가 있으면 게이트가 실패합니다. account 권한 계획은 별도로 검토합니다. 테스트와 CI의 모의 plan은 실제 계정의 계획, Cilium cross-node 통신, agent 가입, 재부팅, DB 복구 인수를 대신하지 않습니다.

| 단계 | 후속 실행에서 남은 일 |
|---|---|
| P00 | 실행 직전 서버·DB·백업·ALB 상태와 비용 기준 재확인 |
| P01 | 작업창에서 freeze/resume 리허설, 기존 운영 작업의 직렬화 |
| P02 | account 권한 변경과 추가 자원 plan 검토, `enable_private_agents=true`를 운영 변수와 Terraform 워크플로에 지속 반영, 승인된 계획 적용 |
| P03 | agent 전용 토큰 준비, 3노드 생성·SSM·Ready·재부팅·예약량·네트워크 검증 |
| P04 이후 | EBS CSI·배치·앱 대상·DB·제어 노드 이전을 단계별로 구현 |

Argo CD 자동 동기화의 의미는 [공식 문서](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)를, 노드 간 포트는 [Cilium 요구 사항](https://docs.cilium.io/en/stable/operations/system_requirements/)을 기준으로 확인했습니다.
