variable "region" {
  description = "AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "env" {
  description = "환경 이름. 자원 이름과 태그에 붙는다"
  type        = string
  default     = "dev"
}

variable "instance_type" {
  description = "K3s 서버 한 대의 크기. ARM(Graviton)이어야 한다. 근거는 ADR-0012의 노드 사양 표(4 GiB로는 요청 합계가 넘침)"
  type        = string
  default     = "t4g.large"
}

variable "root_volume_gb" {
  description = "루트 디스크 크기(GB). 이미지, K3s, Postgres 볼륨(local-path)이 여기에 든다"
  type        = number
  default     = 40
}

variable "admin_cidrs" {
  description = "쿠버네티스 API(6443)에 직접 닿을 주소 범위. 비워 두고 SSM 포트 포워딩(output ssm_kube_api)으로 들어가는 것이 기본"
  type        = list(string)
  default     = []
}

variable "gitops_repo" {
  description = "Argo CD와 구축 스크립트(ansible-pull)가 읽을 저장소(배포 키로 읽으므로 SSH 주소)"
  type        = string
  default     = "git@github.com:team-pitcrew/gachita.git"
}

variable "gitops_revision" {
  description = "Argo CD와 구축 스크립트가 따라갈 브랜치"
  type        = string
  default     = "develop"
}

# ---- Cloudflare(가장자리, ADR-0010). 계정 번호와 영역 번호는 비밀 값이 아니다 ----
variable "cloudflare_account_id" {
  description = "Cloudflare 계정 번호. 비우면 Cloudflare 자원을 만들지 않는다(AWS만 계획할 때)"
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "mangowhois.ai 영역 번호. 이 영역에서 service_name 레코드 하나만 다룬다"
  type        = string
  default     = ""
}

variable "service_host" {
  description = "서비스 주소. 웹앱과 API가 같은 이름에서 나간다(API는 /api/)"
  type        = string
  default     = "gachita.mangowhois.ai"
}
