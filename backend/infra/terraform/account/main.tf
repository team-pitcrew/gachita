# 계정에 한 번 만드는 것: GitHub Actions가 열쇠 없이 받는 역할 둘과, 역할이 만드는 역할의 상한(권한 경계).
# 사람이 로컬 자격으로 적용한다(README의 '처음 한 번'). CI의 적용 역할은 이 폴더를 고치지 못한다.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # 상태는 본 설정과 같은 버킷의 account/terraform.tfstate 에 둔다(backend.hcl의 key만 다름).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "gachita"
      ManagedBy = "terraform"
      Stack     = "account"
    }
  }
}

variable "region" {
  description = "AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "github_sub_prefix" {
  description = <<-EOT
    역할을 받을 수 있는 저장소의 OIDC sub 접두사. 이 저장소는 GitHub의 불변 sub 형식(이름@ID)을 쓴다.
    확인: gh api repos/team-pitcrew/gachita/actions/oidc/customization/sub 의 sub_claim_prefix (2026-11-13)
    이름만 쓰는 옛 형식(repo:team-pitcrew/gachita)으로는 역할을 받지 못한다.
  EOT
  type        = string
  default     = "repo:team-pitcrew@351326633/gachita@1455271774"
  validation {
    condition     = can(regex("^repo:[^/@]+@[0-9]+/[^/@]+@[0-9]+$", var.github_sub_prefix))
    error_message = "불변 형식 repo:OWNER@OWNER-ID/REPO@REPO-ID 이어야 한다(와일드카드 없음)."
  }
}

variable "apply_branch" {
  description = "적용 역할을 받을 수 있는 브랜치. 병합된 코드만 적용한다"
  type        = string
  default     = "develop"
}

data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  oidc    = "token.actions.githubusercontent.com"
}

# GitHub Actions의 OIDC 제공자. 이 계정에는 다른 프로젝트(railshot)의 Terraform이 이미 만들어 두었고 그 역할들이 믿는다.
# 그래서 만들지 않고 읽기만 한다. 우리가 destroy해도 남의 제공자를 지우지 않는다.
# ponytail: 제공자가 없는 새 계정에서는 이 data를 resource "aws_iam_openid_connect_provider"(url, client_id_list = ["sts.amazonaws.com"])로 바꾼다.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://${local.oidc}"
}

data "aws_iam_policy_document" "trust" {
  for_each = {
    # PR에서 도는 계획. 포크에서 온 PR은 OIDC 토큰을 받지 못한다(GitHub 기본값).
    plan = "${var.github_sub_prefix}:pull_request"
    # develop에 병합된 코드를 수동 실행(workflow_dispatch)으로 적용한다. 형식은 GitHub 문서의 불변 sub 예
    # repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH 그대로.
    apply = "${var.github_sub_prefix}:ref:refs/heads/${var.apply_branch}"
  }
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc}:sub"
      values   = [each.value]
    }
  }
}

resource "aws_iam_role" "github" {
  for_each             = data.aws_iam_policy_document.trust
  name                 = "gachita-github-${each.key}"
  assume_role_policy   = each.value.json
  max_session_duration = 3600
}

# ---- 밖에서 도는 점검(ADR-0016 1절의 '사용자 쪽에서 보는 가용성', T62) ----
# Route 53이 30초마다 세 지역에서 실제 주소의 /healthz(Cloudflare → ALB → API → Postgres 둘)를 부른다. 지표(HealthCheckStatus)는 us-east-1.
# Route 53 상태 확인은 IAM에서 이름·태그로 좁힐 수 없어(같이 쓰는 계정의 남의 것까지 고칠 수 있음) 적용 역할에 주지 않고,
# 사람이 로컬 자격으로 적용하는 이 폴더에 둔다. 접어도 남아 접힌 동안은 실패로 센다(그동안 서비스가 없으므로 맞는 값).
# 주소가 Cloudflare에서 열린 뒤 채워 적용한다. 비용: 다른 곳 주소 $0.75 + HTTPS $2.00 = 월 $2.75(AWS 가격표, 11/13)
variable "health_check_host" {
  description = "밖에서 점검할 서비스 주소(예: gachita.mangowhois.ai). 비우면 만들지 않는다"
  type        = string
  default     = ""
}

resource "aws_route53_health_check" "service" {
  count             = var.health_check_host == "" ? 0 : 1
  fqdn              = var.health_check_host
  type              = "HTTPS"
  port              = 443
  resource_path     = "/healthz"
  request_interval  = 30
  failure_threshold = 3
  regions           = ["ap-northeast-1", "ap-southeast-1", "us-west-2"] # 가장 적은 셋
  tags              = { Name = "gachita-healthz" }
}
