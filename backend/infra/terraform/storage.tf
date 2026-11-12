data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
}

# ---- 데이터 버킷: Postgres 백업(postgres/trips/, postgres/profiles/)과 나중의 클립·사진. 공개하지 않는다 ----
# 개인 데이터는 CDN에 올리지 않는다. 내려받을 때는 API가 짧게 서명한 주소를 준다.
resource "aws_s3_bucket" "data" {
  bucket = "gachita-${var.env}-${local.account}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---- 발급자 버킷: K3s 서비스 계정 발급자의 공개 키 두 파일만 둔다(ADR-0011) ----
# 두 파일은 공개 키라 공개해도 된다. 이름이 계정 번호로 정해져 서버를 만들기 전에 발급자 주소를 안다.
# 파일은 서버가 첫 부팅 때 올린다(키가 서버마다 새로 생김). Terraform은 버킷과 읽기 정책만 만든다.
resource "aws_s3_bucket" "oidc" {
  bucket        = "gachita-${var.env}-oidc-${local.account}"
  force_destroy = true # 공개 키뿐이라 지울 때 비워도 된다. 데이터 버킷은 백업 보호를 위해 이렇게 두지 않는다
}

resource "aws_s3_bucket_public_access_block" "oidc" {
  bucket                  = aws_s3_bucket.oidc.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false # 아래 정책 하나(두 파일 읽기)만 공개
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "oidc_public" {
  statement {
    sid       = "PublicIssuerDocuments"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.oidc.arn}/.well-known/openid-configuration", "${aws_s3_bucket.oidc.arn}/openid/v1/jwks"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "oidc" {
  bucket     = aws_s3_bucket.oidc.id
  policy     = data.aws_iam_policy_document.oidc_public.json
  depends_on = [aws_s3_bucket_public_access_block.oidc]
}
