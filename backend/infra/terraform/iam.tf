# 열쇠 없이 역할로 받는다(ADR-0011). 이 설정이 만드는 역할에는 모두 권한 경계를 붙인다(account/가 만든 정책).
locals {
  boundary_arn = "arn:aws:iam::${local.account}:policy/gachita-workload-boundary"
  ssm_prefix   = "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/${var.env}"
}

# ---- 서버: SSM 세션, 저장소 읽기 토큰 읽기, 서비스 계정 발급자의 공개 키 올리기, 백업이 있는지 보기 ----
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
  statement { # SecureString 복호화(aws/ssm 키). SSM을 거친 요청만
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${data.aws_s3_bucket.oidc.arn}/openid/v1/jwks"] # 발급자 문서는 남는 묶음이 올림
  }
  # 구축 6단계가 Postgres 전체 백업이 있는지 보고 복구로 펼지 정한다(T52). 목록만, 내용은 못 읽는다
  statement {
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.data.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["postgres/db/base/*"]
    }
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
  oidc_issuer = "https://${data.aws_s3_bucket.oidc.bucket_regional_domain_name}"
  oidc_host   = data.aws_s3_bucket.oidc.bucket_regional_domain_name
  # 서비스 계정(네임스페이스/이름) → 그 계정만 받는 역할과 권한
  workloads = {
    ssm-reader = {
      sa = "external-secrets:ssm-reader"
      statements = [{
        actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        resources = ["${local.ssm_prefix}/app/*", "${local.ssm_prefix}/tf/*"]
        }, {
        actions   = ["kms:Decrypt"]
        resources = ["*"]
        via_ssm   = true # SecureString 복호화는 SSM을 거친 요청만
      }]
    }
    # Postgres 하나(ADR-0016): 백업 접두사 postgres/db/ 만 읽고 쓴다
    pg = {
      sa = "gachita-db:db"
      statements = [
        { actions = ["s3:ListBucket"], resources = [data.aws_s3_bucket.data.arn] },
        { actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], resources = ["${data.aws_s3_bucket.data.arn}/postgres/db/*"] },
      ]
    }
    # 지정 시점 복구(T57, infra.sh restore)가 옆에 세우는 db-pitr: 같은 접두사를 읽기만 한다(쓰기·WAL 보관 없음)
    pg-restore = {
      sa = "gachita-db:db-pitr"
      statements = [
        { actions = ["s3:ListBucket"], resources = [data.aws_s3_bucket.data.arn] },
        { actions = ["s3:GetObject"], resources = ["${data.aws_s3_bucket.data.arn}/postgres/db/*"] },
      ]
    }
    # ALB 컨트롤러(ADR-0017): 공식 정책(v3.6.2 docs/install/iam_policy.json)의 동작에서 WAF·Shield·Cognito를 뺀 것.
    # ponytail: 자원 범위는 여기서 다시 적지 않고 권한 경계(account/의 gachita-workload-boundary)가 우리 태그와
    #           ALB 이름(gachita-*)으로 좁힌다. 이 역할의 실제 권한은 둘의 교집합이다.
    alb-controller = {
      sa = "kube-system:aws-load-balancer-controller"
      statements = [{
        actions = ["iam:CreateServiceLinkedRole", "ec2:Describe*", "ec2:GetSecurityGroupsForVpc", "ec2:CreateSecurityGroup",
          "ec2:CreateTags", "ec2:DeleteTags", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress",
          "ec2:DeleteSecurityGroup", "elasticloadbalancing:*", "acm:ListCertificates", "acm:DescribeCertificate",
        "iam:ListServerCertificates", "iam:GetServerCertificate"]
        resources = ["*"]
      }]
    }
  }
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
      dynamic "condition" {
        for_each = lookup(statement.value, "via_ssm", false) ? [1] : []
        content {
          test     = "StringEquals"
          variable = "kms:ViaService"
          values   = ["ssm.${var.region}.amazonaws.com"]
        }
      }
    }
  }
}

resource "aws_iam_role_policy" "workload" {
  for_each = local.workloads
  name     = "gachita-${var.env}-${each.key}"
  role     = aws_iam_role.workload[each.key].id
  policy   = data.aws_iam_policy_document.workload[each.key].json
}
