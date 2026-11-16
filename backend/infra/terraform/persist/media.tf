# 미디어 CDN(T179, ADR-0026): 쇼츠·표지·프로필 사진을 CloudFront가 클립 버킷에서 읽어 서울 거점으로 내보낸다.
#   주소 media.gachita.mangowhois.ai(Cloudflare는 DNS만) → CloudFront → OAC(sigv4) → 클립 버킷(계속 비공개)
# 접어도 남는다: 켜 둔 시간으로 돈이 나가지 않고(쓴 만큼), 만들고 지우는 데 10분쯤 걸리며, 주소와 서명 키가 그대로여야 한다.
# 공개 키(media_public_key)와 영역 번호가 모두 있을 때만 만든다. 개인키는 Terraform과 상태에 없다(GitHub 비밀 값 → SSM, infra-secrets).

# CloudFront에 붙이는 인증서는 us-east-1에 있어야 한다. 적용 역할의 인증서 권한은 우리 태그를 요구하므로 태그를 같이 준다.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "gachita"
      ManagedBy = "terraform"
      Env       = var.env
      Stack     = "persist"
    }
  }
}

variable "media_host" {
  description = "미디어 주소. 서비스 주소의 하위 이름이어야 폰 웹에서 같은 사이트로 본다"
  type        = string
  default     = "media.gachita.mangowhois.ai"
}

variable "media_public_key" {
  description = "서명 확인용 RSA 2048 공개 키(PEM, 저장소 변수 MEDIA_PUBLIC_KEY). 비우면 미디어 CDN을 만들지 않는다"
  type        = string
  default     = ""
}

locals {
  media = local.edge && var.media_public_key != ""
  # CDN이 읽는 접두사. 버킷의 나머지(여행 코드 아래의 원음 클립, short-assets/)는 서명이 있어도 CDN으로 나가지 않는다
  media_prefixes = ["shorts", "profiles", "public"]
  # AWS 관리 캐시 정책 CachingOptimized(기본 24시간, 압축). 계정마다 같은 번호
  caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
}

# ---- 인증서(us-east-1)와 검증 레코드. 서비스 인증서와 같은 방식 ----
resource "aws_acm_certificate" "media" {
  count             = local.media ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.media_host
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "media_acm" {
  for_each = { for o in flatten(aws_acm_certificate.media[*].domain_validation_options) : o.domain_name => o }
  zone_id  = var.cloudflare_zone_id
  name     = trimsuffix(each.value.resource_record_name, ".")
  type     = each.value.resource_record_type
  content  = trimsuffix(each.value.resource_record_value, ".")
  proxied  = false
  ttl      = 300
  comment  = "gachita: ACM validation for media CDN (backend/infra/terraform/persist)"
}

resource "aws_acm_certificate_validation" "media" {
  count                   = local.media ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.media[0].arn
  validation_record_fqdns = [for r in cloudflare_dns_record.media_acm : r.name]
}

# ---- 서명 키: 공개 키만 CloudFront에 올린다. API가 개인키로 서명한 주소·쿠키만 통과한다 ----
# 키를 바꿀 때는 새 공개 키를 키 묶음에 더해 둘 다 받게 한 뒤 옛 것을 뺀다(이 자원의 키를 바로 바꾸면 그 순간 서명이 모두 깨진다).
resource "aws_cloudfront_public_key" "media" {
  count   = local.media ? 1 : 0
  name    = "gachita-${var.env}-media"
  comment = "gachita media signing key"
  # CloudFront는 키를 줄바꿈으로 끝나게 돌려주고, 저장소 변수는 워크플로에서 끝 줄바꿈 없이 온다. 맞추지 않으면 계획마다
  # 키를 갈아 끼우려 한다(키 번호가 바뀌어 서명이 모두 깨짐). 11/16 계획에서 발견해 적용 전에 멈췄다
  encoded_key = "${trimspace(var.media_public_key)}\n"
}

resource "aws_cloudfront_key_group" "media" {
  count = local.media ? 1 : 0
  name  = "gachita-${var.env}-media"
  items = [aws_cloudfront_public_key.media[0].id]
}

resource "aws_cloudfront_origin_access_control" "media" {
  count                             = local.media ? 1 : 0
  name                              = "gachita-${var.env}-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---- 캐시와 응답 머리말 ----
# 비공개 객체는 가장자리에 길어야 10분 둔다. 동의 철회·삭제로 S3에서 지운 것이 그 안에 CDN에서도 사라진다
# (무효화 API를 부르지 않는다, ADR-0026). 서명 값(Expires·Signature·Key-Pair-Id)은 CloudFront가 캐시 키에서 뺀다.
resource "aws_cloudfront_cache_policy" "media_private" {
  count       = local.media ? 1 : 0
  name        = "gachita-${var.env}-media-private"
  comment     = "signed media: 10 minutes at the edge"
  min_ttl     = 0
  default_ttl = 600
  max_ttl     = 600
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# 웹앱이 fetch와 canvas로 읽으므로 CORS 머리말을 가장자리에서 붙인다(허용 출처는 서비스 주소 하나, 자격 증명 없음).
# GET·HEAD만 받는다: 서명 주소로 하는 단순 GET은 사전 요청(OPTIONS)이 없다. 머리말을 더 붙여 사전 요청이 생기면 그때 OPTIONS를 연다.
resource "aws_cloudfront_response_headers_policy" "media" {
  count = local.media ? 1 : 0
  name  = "gachita-${var.env}-media"
  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec       = 600
    origin_override                  = true
    access_control_allow_headers {
      items = ["Range"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }
    access_control_allow_origins {
      items = ["https://${var.service_host}"]
    }
    access_control_expose_headers {
      items = ["Accept-Ranges", "Content-Length", "Content-Range", "ETag"]
    }
  }
}

# 서명한 미디어에는 브라우저 캐시 시간을 가장자리에서 붙인다(T179). 버킷의 객체에 Cache-Control이 없어 그대로 두면 브라우저가
# 어림(Last-Modified의 10%)으로 캐시한다. API는 서명의 만료를 5분 구간으로 올려 같은 구간에서 같은 주소를 주므로
# (ADR-0027) 그 주소로 다시 볼 때 내려받지 않는다. 10분은 서명에 남은 시간(10~15분)과 가장자리 캐시(10분)를 넘지 않는 값이다.
# private: 중간 프록시가 남의 미디어를 캐시하지 않는다. 객체에 Cache-Control이 따로 있으면 그것을 따른다(override = false).
resource "aws_cloudfront_response_headers_policy" "media_private" {
  count = local.media ? 1 : 0
  name  = "gachita-${var.env}-media-private"
  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec       = 600
    origin_override                  = true
    access_control_allow_headers {
      items = ["Range"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }
    access_control_allow_origins {
      items = ["https://${var.service_host}"]
    }
    access_control_expose_headers {
      items = ["Accept-Ranges", "Content-Length", "Content-Range", "ETag"]
    }
  }
  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "private, max-age=600"
      override = false
    }
  }
}

# ---- 배포 ----
resource "aws_cloudfront_distribution" "media" {
  count           = local.media ? 1 : 0
  enabled         = true
  is_ipv6_enabled = true
  comment         = "gachita ${var.env} media"
  aliases         = [var.media_host]
  price_class     = "PriceClass_200" # 서울 거점이 드는 가장 낮은 등급(100은 북미·유럽만)
  http_version    = "http2and3"

  origin {
    origin_id                = "clips"
    domain_name              = aws_s3_bucket.clips.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media[0].id
  }

  # 기본: 서명 필수. 서명이 없거나 만료되면 CloudFront가 403으로 끝낸다(원본까지 가지 않음)
  default_cache_behavior {
    target_origin_id           = "clips"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.media_private[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media_private[0].id
    trusted_key_groups         = [aws_cloudfront_key_group.media[0].id]
    compress                   = false # mp4·png·jpg는 이미 압축돼 있다
  }

  # 공개 정적 그림(캐릭터 등): 서명 없이, 길게 캐시
  ordered_cache_behavior {
    path_pattern               = "/public/*"
    target_origin_id           = "clips"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media[0].id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.media[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ---- 버킷 정책: 이 배포만, 세 접두사만 읽는다. 공개 차단은 그대로(서비스 주체에 배포 ARN 조건이라 공개 정책이 아니다) ----
# 목록 권한(ListBucket)은 주지 않는다. 그래서 없는 키는 404가 아니라 403으로 답한다.
data "aws_iam_policy_document" "clips_cdn" {
  count = local.media ? 1 : 0
  statement {
    sid       = "MediaCdnRead"
    actions   = ["s3:GetObject"]
    resources = [for p in local.media_prefixes : "${aws_s3_bucket.clips.arn}/${p}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "clips" {
  count  = local.media ? 1 : 0
  bucket = aws_s3_bucket.clips.id
  policy = data.aws_iam_policy_document.clips_cdn[0].json
}

# ---- 레코드: DNS만(프록시 안 함). Cloudflare를 지나지 않아 영상·큰 파일 약관과 무관하다(ADR-0020의 판단) ----
resource "cloudflare_dns_record" "media" {
  count   = local.media ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.media_host
  type    = "CNAME"
  content = aws_cloudfront_distribution.media[0].domain_name
  proxied = false
  ttl     = 300
  comment = "gachita: media CDN, DNS only (backend/infra/terraform/persist/media.tf)"
}

# ---- API가 읽는 값 둘(비밀이 아니다). External Secrets가 개인키(app/media/MEDIA_PRIVATE_KEY)와 함께 Secret 하나로 묶는다 ----
resource "aws_ssm_parameter" "media" {
  for_each = local.media ? {
    MEDIA_CDN_BASE    = "https://${var.media_host}"
    MEDIA_KEY_PAIR_ID = aws_cloudfront_public_key.media[0].id
  } : {}
  name  = "/gachita/${var.env}/tf/media/${each.key}"
  type  = "String"
  value = each.value
}

output "media_distribution_id" {
  description = "미디어 배포 번호(확인·무효화에 씀). 없으면 빈 값"
  value       = try(aws_cloudfront_distribution.media[0].id, "")
}

output "media_key_pair_id" {
  description = "서명에 넣는 Key-Pair-Id(API 환경 변수 MEDIA_KEY_PAIR_ID). 없으면 빈 값"
  value       = try(aws_cloudfront_public_key.media[0].id, "")
}
