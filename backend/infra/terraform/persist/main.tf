# 접어도 남는 묶음(T51, ADR-0017). 백업이 든 데이터 버킷, 서비스 계정 발급자 버킷, 서비스 주소의 인증서와 검증 레코드,
# Cloudflare 요청 수 제한. 접는 묶음(../)은 이 묶음을 이름으로 읽기만 한다. 펴기는 이 묶음을 먼저 적용하고, 접기는 건드리지 않는다.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29"
    }
  }

  # 상태는 접는 묶음과 같은 버킷의 persist/terraform.tfstate(backend.hcl의 key만 다름)
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "gachita"
      ManagedBy = "terraform"
      Env       = var.env
      Stack     = "persist"
    }
  }
}

# 토큰은 환경 변수 CLOUDFLARE_API_TOKEN(GitHub 비밀 값). 영역 번호가 비면 Cloudflare 쪽은 만들지 않는다.
provider "cloudflare" {}

variable "region" {
  description = "AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "env" {
  description = "환경 이름. 버킷 이름에 붙는다(접는 묶음과 같아야 함)"
  type        = string
  default     = "dev"
}

variable "service_host" {
  description = "서비스 주소. 인증서와 요청 수 제한이 이 이름에 걸린다"
  type        = string
  default     = "gachita.mangowhois.ai"
}

variable "cloudflare_zone_id" {
  description = "mangowhois.ai 영역 번호. 비우면 인증서·검증 레코드·요청 수 제한을 만들지 않는다(AWS만 계획할 때)"
  type        = string
  default     = ""
}

data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  edge    = var.cloudflare_zone_id != ""
}

# ---- 데이터 버킷: Postgres 백업(postgres/db/)과 나중의 클립·사진. 공개하지 않는다 ----
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
# 파일은 서버가 구축 4단계에서 올린다(키가 서버마다 새로 생김). 남는 묶음이라 발급자 주소가 접었다 펴도 같다.
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

# 발급자 문서는 내용이 버킷 이름만으로 정해진다(K3s API 서버가 내놓는 것과 같은 다섯 값). IAM은 OIDC 제공자를 만들 때
# 이 문서를 읽으므로 서버보다 먼저 있어야 한다(접는 묶음의 aws_iam_openid_connect_provider). 그래서 여기서 올린다.
locals {
  issuer = "https://${aws_s3_bucket.oidc.bucket_regional_domain_name}"
}

resource "aws_s3_object" "oidc_discovery" {
  bucket        = aws_s3_bucket.oidc.id
  key           = ".well-known/openid-configuration"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    issuer                                = local.issuer
    jwks_uri                              = "${local.issuer}/openid/v1/jwks"
    response_types_supported              = ["id_token"]
    subject_types_supported               = ["public"]
    id_token_signing_alg_values_supported = ["RS256"]
  })
}

# 공개 키는 서버마다 새로 생겨 서버가 구축 4단계에서 덮어쓴다. 여기서는 처음 한 번 빈 자리만 만들고 그 뒤로는 손대지 않는다.
resource "aws_s3_object" "oidc_jwks" {
  bucket        = aws_s3_bucket.oidc.id
  key           = "openid/v1/jwks"
  content_type  = "application/json"
  cache_control = "no-cache"
  content       = jsonencode({ keys = [] })
  lifecycle {
    ignore_changes = [content, etag, metadata, tags_all, version_id]
  }
}

# ---- 인증서: ALB 컨트롤러가 Gateway 리스너의 호스트 이름으로 찾는다(Git에 ARN이 없음) ----
# 남는 묶음이라 다시 펼 때 새로 받지 않는다. 검증 레코드는 DNS만(프록시 안 함).
resource "aws_acm_certificate" "service" {
  count             = local.edge ? 1 : 0
  domain_name       = var.service_host
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "acm" {
  for_each = { for o in flatten(aws_acm_certificate.service[*].domain_validation_options) : o.domain_name => o }
  zone_id  = var.cloudflare_zone_id
  name     = trimsuffix(each.value.resource_record_name, ".")
  type     = each.value.resource_record_type
  content  = trimsuffix(each.value.resource_record_value, ".")
  proxied  = false
  ttl      = 300
  comment  = "gachita: ACM validation (backend/infra/terraform/persist)"
}

resource "aws_acm_certificate_validation" "service" {
  count                   = local.edge ? 1 : 0
  certificate_arn         = aws_acm_certificate.service[0].arn
  validation_record_fqdns = [for r in cloudflare_dns_record.acm : r.name]
}

# ---- 요청 수 제한: 클러스터 안에 프록시가 없어 Cloudflare 엣지에서 센다(ADR-0016) ----
# 무료 요금제의 규칙 하나. 통신사 NAT 뒤의 차와 폰이 같은 주소를 쓸 수 있어 넉넉히(주소마다 10초에 200).
# ponytail: 영역의 요청 수 제한 묶음(http_ratelimit)을 통째로 맡는다. 영역에 이미 규칙이 있으면 만들기가 실패하니
#           그때는 그 묶음을 가져와(import) 규칙을 합친다.
resource "cloudflare_ruleset" "ratelimit" {
  count   = local.edge ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "zone rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"
  rules = [{
    ref         = "gachita_per_ip"
    description = "gachita: 200 requests per 10s per IP (ADR-0016)"
    expression  = "(http.host eq \"${var.service_host}\")"
    action      = "block"
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 10
      requests_per_period = 200
      mitigation_timeout  = 10
    }
  }]
}

output "data_bucket" {
  description = "백업과 클립 버킷(접는 묶음이 이름으로 읽음)"
  value       = aws_s3_bucket.data.bucket
}

output "oidc_bucket" {
  description = "서비스 계정 발급자 버킷"
  value       = aws_s3_bucket.oidc.bucket
}

output "certificate_arn" {
  description = "서비스 주소의 인증서(컨트롤러가 호스트 이름으로 찾으므로 어디에도 적지 않는다)"
  value       = try(aws_acm_certificate_validation.service[0].certificate_arn, "")
}
