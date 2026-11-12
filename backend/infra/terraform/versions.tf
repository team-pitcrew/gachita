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

  # 상태는 S3에 둔다. 버킷 이름은 backend.hcl로 준다(README의 '처음 한 번').
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "gachita"
      ManagedBy = "terraform"
      Env       = var.env
    }
  }
}

# 토큰은 환경 변수 CLOUDFLARE_API_TOKEN으로 받는다(GitHub 비밀 값. 저장소에 넣지 않음).
provider "cloudflare" {}
