# 열쇠 없이 역할로 받는다(ADR-0011). 이 설정이 만드는 역할에는 모두 권한 경계를 붙인다(account/가 만든 정책).
locals {
  boundary_arn = "arn:aws:iam::${local.account}:policy/gachita-workload-boundary"
  ssm_prefix   = "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/${var.env}"
}

# ---- 서버: SSM 세션, 배포 키 읽기, 서비스 계정 발급자의 공개 키 올리기 ----
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "k3s" {
  name                 = "gachita-${var.env}-k3s"
  assume_role_policy   = data.aws_iam_policy_document.assume_ec2.json
  permissions_boundary = local.boundary_arn
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.k3s.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "k3s" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["${local.ssm_prefix}/bootstrap/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.oidc.arn}/.well-known/openid-configuration", "${aws_s3_bucket.oidc.arn}/openid/v1/jwks"]
  }
}

resource "aws_iam_role_policy" "k3s" {
  name   = "gachita-${var.env}-k3s"
  role   = aws_iam_role.k3s.id
  policy = data.aws_iam_policy_document.k3s.json
}

resource "aws_iam_instance_profile" "k3s" {
  name = "gachita-${var.env}-k3s"
  role = aws_iam_role.k3s.name
}

# ---- 파드: 서비스 계정 OIDC. K3s 발급자의 공개 키가 S3(storage.tf)에 있다 ----
locals {
  oidc_issuer = "https://${aws_s3_bucket.oidc.bucket_regional_domain_name}"
  oidc_host   = aws_s3_bucket.oidc.bucket_regional_domain_name
  # 서비스 계정(네임스페이스/이름) → 그 계정만 받는 역할과 권한
  workloads = {
    ssm-reader = {
      sa = "external-secrets:ssm-reader"
      statements = [{
        actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        resources = ["${local.ssm_prefix}/app/*", "${local.ssm_prefix}/tf/*"]
      }]
    }
    pg-trips = {
      sa         = "gachita-trips:db"
      statements = local.backup_statements["trips"]
    }
    pg-profiles = {
      sa         = "gachita-profiles:db"
      statements = local.backup_statements["profiles"]
    }
  }
  # Postgres 백업: 자기 접두사만 읽고 쓴다. 여행 DB가 프로필 백업을 읽지 못한다
  backup_statements = { for db in ["trips", "profiles"] : db => [
    { actions = ["s3:ListBucket"], resources = [aws_s3_bucket.data.arn] },
    { actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], resources = ["${aws_s3_bucket.data.arn}/postgres/${db}/*"] },
  ] }
}

resource "aws_iam_openid_connect_provider" "cluster" {
  url            = local.oidc_issuer
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "workload_trust" {
  for_each = local.workloads
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.cluster.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["system:serviceaccount:${each.value.sa}"]
    }
  }
}

resource "aws_iam_role" "workload" {
  for_each             = local.workloads
  name                 = "gachita-${var.env}-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.workload_trust[each.key].json
  permissions_boundary = local.boundary_arn
}

data "aws_iam_policy_document" "workload" {
  for_each = local.workloads
  dynamic "statement" {
    for_each = each.value.statements
    content {
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "workload" {
  for_each = local.workloads
  name     = "gachita-${var.env}-${each.key}"
  role     = aws_iam_role.workload[each.key].id
  policy   = data.aws_iam_policy_document.workload[each.key].json
}
