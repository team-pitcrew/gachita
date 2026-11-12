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
  description = "K3s 서버 한 대의 크기. ARM(Graviton)이어야 한다"
  type        = string
  default     = "t4g.medium"
}

variable "root_volume_gb" {
  description = "루트 디스크 크기(GB). Postgres 데이터도 여기에 둔다"
  type        = number
  default     = 30
}

variable "admin_cidrs" {
  description = "쿠버네티스 API(6443)에 닿을 수 있는 주소 범위. 비우면 밖에서 못 닿고 SSM으로만 들어간다"
  type        = list(string)
  default     = []
}

variable "k3s_version" {
  description = "설치할 K3s 판. 2026-11-12의 stable 채널 값"
  type        = string
  default     = "v1.37.2+k3s1"
}

variable "argocd_version" {
  description = "설치할 Argo CD 판"
  type        = string
  default     = "v3.6.1"
}

variable "gitops_repo" {
  description = "Argo CD가 읽을 저장소(배포 키로 읽으므로 SSH 주소)"
  type        = string
  default     = "git@github.com:team-pitcrew/gachita.git"
}

variable "gitops_revision" {
  description = "Argo CD가 따라갈 브랜치"
  type        = string
  default     = "develop"
}
