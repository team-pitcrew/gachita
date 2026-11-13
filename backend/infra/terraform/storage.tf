data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  cluster = "gachita-${var.env}" # ALB 컨트롤러의 clusterName(backend/infra/gitops의 차트 값과 같아야 함)
}

# 버킷 둘은 남는 묶음(persist/)에 있다. 접는 묶음은 이름으로 읽기만 하므로 접어도 백업과 발급자 주소가 남는다(T51).
data "aws_s3_bucket" "data" {
  bucket = "gachita-${var.env}-${local.account}"
}

data "aws_s3_bucket" "oidc" {
  bucket = "gachita-${var.env}-oidc-${local.account}"
}
