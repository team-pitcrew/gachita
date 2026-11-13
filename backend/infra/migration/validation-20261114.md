# T84 준비 변경의 검증 기록

2026-11-14 KST에 `feature/T84-cluster-foundation`에서 확인했습니다. 이 기록은 코드와 계획의 검증이며 실제 4노드 구축 인수가 아닙니다.

| 확인 대상 | 결과 | 범위와 한계 |
|---|---|---|
| P01 제어·계획 보호 | Python 21 tests 통과. 기존 명령 6개 × 실패 조건 4개의 하위 사례 포함 | 동결 중 실패·재시도·원래 정책 복원·앱 재생성·조회 실패·삭제/교체 계획을 검사합니다. 운영 동결은 실행하지 않았습니다 |
| Terraform | fmt/validate, mock plan 2개 통과 | AWS 접속 없이 기본 비활성화와 3 agent·2 AZ·private IP·IMDSv2·암호화·SG 경계를 검사합니다 |
| Ansible | server/agent syntax-check, app/data 설정 렌더링 통과 | 실제 EC2 가입·재부팅 검증은 후속 적용 단계입니다 |
| 셸 | infra.sh 및 실제 계획에서 렌더링한 agent user-data 3개 bash 구문 통과 | 첫 부팅의 AWS·저장소 접근은 아직 실행하지 않았습니다 |
| 저장소 검사 | `make check`: 웹 26개·API 43개 통과 | API 테스트는 별도 일회용 PostgreSQL 컨테이너와 DB 주소를 사용했습니다 |
| 기본 계획 | 기존 관리 자원 30개 모두 `no-op`; 출력 `private_agents = {}`만 추가 | S3의 state 사본(serial 39), `-refresh=false`, 동일한 영역 변수. AWS data source는 읽고 Cloudflare 관리 자원은 refresh하지 않았습니다 |
| agent 활성화 계획 | **54개 추가, 변경 0, 삭제 0**. 기존 관리 자원 30개 모두 `no-op` | 위와 같은 state 사본. `check_plan.py agents` 통과. 실제 적용 직전 fresh plan이 필요합니다 |

계획 파일과 전체 state에는 운영 정보가 있어 커밋하지 않았습니다. 사본의 backend만 로컬 경로로 바꾸었고 운영 S3 state에는 쓰지 않았습니다. Cloudflare token은 로컬에 없어 `-refresh=false` 계획의 provider 초기화에 접근 권한이 없는 임시 문자열을 사용했습니다. 이 결과는 Cloudflare의 최신 상태 조회를 증명하지 않습니다.

추가로 [GitHub Terraform 실행](https://github.com/team-pitcrew/gachita/actions/runs/43527170436)에서 기본 설정을 실제 운영 상태로 refresh하여 확인했습니다. main은 기존 자원 변경 없이 `private_agents = {}` 출력만 추가했고, persist는 `No changes`, account는 예상한 NAT/EIP 권한을 위한 `aws_iam_role_policy.apply` 1개 in-place update였습니다. 세 계획 모두 성공했으며 apply는 실행하지 않았습니다. agent 활성화 계획은 여전히 위 state 사본 기준입니다.

08:23 KST 운영 조회에서는 기존 EC2의 유형·사설 주소와 노드 이름이 유지되었고, K3s `v1.36.6+k3s1` 노드 1대가 Ready였습니다. Argo CD 13개가 Healthy·Synced, API는 2/2 Ready, CNPG는 1/1 Ready, `db-1` local-path PVC는 기존 볼륨에 Bound, 공개 `/healthz`는 200이었습니다. 전환 ConfigMap은 없었습니다. SQLite `state.db` 파일이 존재하며 agent-token은 기존 server-token을 가리키는 심볼릭 링크 상태였습니다. 전용 가입 자격 준비와 제어 노드의 백업 방식 확인을 후속 실행 조건으로 유지합니다.

AWS 자원 생성·교체·삭제, GitOps 동결, DB 쓰기·복구, 토큰 발급·전달은 실행하지 않았습니다. EBS CSI, Cilium cross-node 통신, 새 노드의 Ready·메모리 여유, 앱 트래픽·DB 전환은 미검증입니다.
