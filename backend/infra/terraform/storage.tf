data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  cluster = "gachita-${var.env}" # ALB 컨트롤러의 clusterName(backend/infra/gitops의 차트 값과 같아야 함)
  # 클립 버킷(남는 묶음, T64)은 역할 권한에 ARN만 쓰므로 이름으로 적는다. data로 읽으면 남는 묶음을 적용하기 전의 계획이 실패한다
  clips_arn = "arn:aws:s3:::gachita-${var.env}-clips-${local.account}"
}

# 버킷 둘은 남는 묶음(persist/)에 있다. 접는 묶음은 이름으로 읽기만 하므로 접어도 백업과 발급자 주소가 남는다(T51).
data "aws_s3_bucket" "data" {
  bucket = "gachita-${var.env}-${local.account}"
}

data "aws_s3_bucket" "oidc" {
  bucket = "gachita-${var.env}-oidc-${local.account}"
}
