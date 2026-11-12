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

variable "github_repo" {
  description = "역할을 받을 수 있는 저장소(owner/name). 다른 저장소의 워크플로는 받지 못한다"
  type        = string
  default     = "team-pitcrew/gachita"
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

# GitHub Actions의 OIDC 토큰을 믿는다. AWS가 GitHub의 인증서를 직접 확인하므로 지문은 두지 않는다.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.oidc}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust" {
  for_each = {
    # PR에서 도는 계획. 포크에서 온 PR은 OIDC 토큰을 받지 못한다(GitHub 기본값).
    plan = "repo:${var.github_repo}:pull_request"
    # develop에 병합된 코드를 수동 실행(workflow_dispatch)으로 적용한다.
    apply = "repo:${var.github_repo}:ref:refs/heads/${var.apply_branch}"
  }
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
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
