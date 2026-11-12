# 역할의 권한. 이름 규칙(gachita-*)으로 범위를 좁힌다.
#   상태 버킷 gachita-tfstate-<계정>, 데이터 버킷 gachita-<env>-<계정>, 발급자 버킷 gachita-<env>-oidc-<계정>
#   SSM 값 /gachita/<env>/tf/*(Terraform이 씀), /gachita/<env>/app/*·bootstrap/*(사람이 넣은 비밀 값, 워크플로가 씀)
locals {
  boundary_arn = "arn:aws:iam::${local.account}:policy/gachita-workload-boundary"
  # 사람이 넣은 비밀 값. 계획 역할과 적용 역할 모두 읽지 못한다(적용 역할은 쓰기만).
  human_secrets = [
    "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*/app/*",
    "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*/bootstrap/*",
  ]
}

# ---- 계획(PR): 읽기만. 계정 전체 읽기에서 데이터와 비밀 값 읽기를 뺀다 ----
resource "aws_iam_role_policy_attachment" "plan_read" {
  role       = aws_iam_role.github["plan"].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan_deny" {
  # 상태 파일 말고는 버킷 안의 내용(백업, 클립)을 읽지 않는다
  statement {
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = ["arn:aws:s3:::gachita-tfstate-${local.account}/*"]
  }
  statement {
    effect    = "Deny"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
    resources = local.human_secrets
  }
  statement {
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue", "kms:Decrypt"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "plan_deny" {
  name   = "deny-data-and-secrets"
  role   = aws_iam_role.github["plan"].id
  policy = data.aws_iam_policy_document.plan_deny.json
}

# ---- 적용(develop, 수동 실행): 본 설정이 만드는 자원의 서비스만 ----
data "aws_iam_policy_document" "apply" {
  # 네트워크, 서버, 보안 그룹, VPC 엔드포인트. 이 리전에서만
  statement {
    actions   = ["ec2:*"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }
  # 상태, 데이터, 발급자 버킷
  statement {
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::gachita-*", "arn:aws:s3:::gachita-*/*"]
  }
  # SSM 값: Terraform이 쓰는 값, 비밀 값 넣기(쓰기만), 공개 AMI 번호 읽기
  statement {
    actions = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:GetParameters",
    "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*",
      "arn:aws:ssm:${var.region}::parameter/aws/service/*",
    ]
  }
  statement {
    actions   = ["ssm:DescribeParameters", "sts:GetCallerIdentity", "iam:ListOpenIDConnectProviders", "iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = ["*"]
  }
  # 역할 만들기는 권한 경계를 붙일 때만 된다. 경계보다 넓은 역할을 만들 수 없다
  statement {
    actions   = ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }
  statement {
    actions = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
    "iam:TagRole", "iam:UntagRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
  statement {
    actions = ["iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
      "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile",
    "iam:UntagInstanceProfile"]
    resources = ["arn:aws:iam::${local.account}:instance-profile/gachita-*"]
  }
  # 클러스터의 서비스 계정 OIDC 발급자(파드가 받는 역할, ADR-0011)
  statement {
    actions = ["iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider", "iam:GetOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider", "iam:UntagOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint",
    "iam:AddClientIDToOpenIDConnectProvider", "iam:RemoveClientIDFromOpenIDConnectProvider"]
    resources = ["arn:aws:iam::${local.account}:oidc-provider/*"]
  }
  # 자기 자신과 이 폴더가 만든 것은 고치지 못한다. 고치려면 사람이 로컬 자격으로 이 폴더를 적용한다
  statement {
    effect  = "Deny"
    actions = ["iam:*"]
    resources = [
      "arn:aws:iam::${local.account}:role/gachita-github-*",
      local.boundary_arn,
      aws_iam_openid_connect_provider.github.arn,
    ]
  }
  statement {
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary", "iam:CreateUser", "iam:CreateAccessKey"]
    resources = ["*"]
  }
  statement {
    effect    = "Deny"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
    resources = local.human_secrets
  }
}

resource "aws_iam_role_policy" "apply" {
  name   = "apply-gachita-stack"
  role   = aws_iam_role.github["apply"].id
  policy = data.aws_iam_policy_document.apply.json
}

# ---- 권한 경계: 적용 역할이 만드는 역할(서버, 파드)이 넘을 수 없는 상한 ----
data "aws_iam_policy_document" "boundary" {
  # 서버가 SSM 세션을 받는 데 필요한 것(AmazonSSMManagedInstanceCore와 같은 범위)
  statement {
    actions = ["ssm:UpdateInstanceInformation", "ssm:ListInstanceAssociations", "ssm:DescribeAssociation",
      "ssm:GetDocument", "ssm:DescribeDocument", "ssm:GetManifest", "ssm:ListAssociations", "ssm:PutInventory",
      "ssm:PutComplianceItems", "ssm:PutConfigurePackageResult", "ssm:UpdateAssociationStatus",
      "ssm:UpdateInstanceAssociationStatus", "ssm:GetDeployablePatchSnapshotForInstance",
    "ssmmessages:*", "ec2messages:*"]
    resources = ["*"]
  }
  statement {
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*",
      "arn:aws:ssm:${var.region}::parameter/aws/*",
    ]
  }
  statement {
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::gachita-*", "arn:aws:s3:::gachita-*/*"]
  }
  statement {
    actions   = ["s3:GetEncryptionConfiguration"]
    resources = ["*"]
  }
  # 상태 버킷은 어떤 서버·파드도 닿지 않는다
  statement {
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::gachita-tfstate-*", "arn:aws:s3:::gachita-tfstate-*/*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = "gachita-workload-boundary"
  description = "Upper bound for roles created by the CI apply role (server and pods)"
  policy      = data.aws_iam_policy_document.boundary.json
}

output "plan_role_arn" {
  description = "gh variable set AWS_PLAN_ROLE_ARN 에 넣는 값"
  value       = aws_iam_role.github["plan"].arn
}

output "apply_role_arn" {
  description = "gh variable set AWS_APPLY_ROLE_ARN 에 넣는 값"
  value       = aws_iam_role.github["apply"].arn
}

output "workload_boundary_arn" {
  description = "본 설정의 역할에 붙이는 권한 경계"
  value       = aws_iam_policy.boundary.arn
}
