# 역할의 권한. 이름 규칙(gachita-*)으로 범위를 좁힌다.
#   상태 버킷 gachita-tfstate-<계정>, 데이터 버킷 gachita-<env>-<계정>, 발급자 버킷 gachita-<env>-oidc-<계정>
#   SSM 값 /gachita/<env>/tf/*(Terraform이 씀), /gachita/<env>/app/*·bootstrap/*(사람이 넣은 비밀 값, 워크플로가 씀)
locals {
  cloudwatch_ours = [ # 소진 속도 알림과 SLO 대시보드(T62)
    "arn:aws:cloudwatch:${var.region}:${local.account}:alarm:gachita-*",
    "arn:aws:cloudwatch::${local.account}:dashboard/gachita-*",
  ]
  boundary_arn = "arn:aws:iam::${local.account}:policy/gachita-workload-boundary"
  # 사람이 넣은 비밀 값. 계획·적용 역할 모두 직접 읽지 못한다(적용 역할은 쓰기만).
  # 다만 적용 역할은 경계 안의 역할(서버·파드)을 만들 수 있고 그 역할은 읽을 수 있으므로, 이 값들의 신뢰 범위는
  # 'develop에 병합할 수 있는 사람'과 같다(ADR-0011).
  human_secrets = [
    "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*/app/*",
    "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*/bootstrap/*",
  ]
  # 이 계정은 다른 프로젝트(railshot 등)와 같이 쓴다. EC2는 우리 태그(Project=gachita, provider의 default_tags)가
  # 붙은 자원만 고친다. 다른 프로젝트 자원에는 Project 태그가 없는 것도 많아 '남의 태그면 거부'로는 막을 수 없다.
  ec2_arn  = "arn:aws:ec2:${var.region}:${local.account}"
  project  = "gachita" # provider default_tags의 Project 값
  ec2_made = ["vpc", "subnet", "internet-gateway", "route-table", "security-group", "security-group-rule", "vpc-endpoint", "instance"]
  ec2_create = ["CreateVpc", "CreateSubnet", "CreateInternetGateway", "CreateRouteTable", "CreateSecurityGroup",
  "CreateVpcEndpoint", "RunInstances", "AuthorizeSecurityGroupEgress", "AuthorizeSecurityGroupIngress"]
  # 우리 발급자 하나(본 설정의 storage.tf: gachita-<env>-oidc-<계정> 버킷 주소)
  cluster_oidc_arn = "arn:aws:iam::${local.account}:oidc-provider/gachita-*-oidc-${local.account}.s3.${var.region}.amazonaws.com"
  # ALB는 클러스터의 AWS Load Balancer Controller가 만든다(ADR-0017). 이름은 gachita-<env>로 고정
  elb_arn = "arn:aws:elasticloadbalancing:${var.region}:${local.account}"
  alb_named = ["${local.elb_arn}:loadbalancer/app/gachita-*/*", "${local.elb_arn}:listener/app/gachita-*/*",
  "${local.elb_arn}:listener-rule/app/gachita-*/*"]
}

# ---- 계획(PR): 읽기만. 계정 전체 읽기(ReadOnlyAccess)는 같이 쓰는 계정의 다른 프로젝트 SSM 값·로그·DB 내용까지
# 읽을 수 있어 쓰지 않는다. Terraform이 우리 자원을 다시 읽는(refresh) 데 필요한 것만 준다 ----
data "aws_iam_policy_document" "plan_read" {
  # 네트워크·서버 설정 읽기(자원 단위로 좁힐 수 없다). 이 리전만
  statement {
    actions   = ["ec2:Describe*", "ec2:Get*"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }
  # IAM 설정 읽기(역할·정책·제공자의 설정. 비밀 값이 아니다)
  statement {
    actions   = ["iam:Get*", "iam:List*", "sts:GetCallerIdentity"]
    resources = ["*"]
  }
  # 인증서(남는 묶음)와 컨트롤러가 만든 ALB(레코드가 가리킬 곳) 읽기
  statement {
    actions   = ["acm:DescribeCertificate", "acm:ListCertificates", "acm:ListTagsForCertificate", "elasticloadbalancing:Describe*"]
    resources = ["*"]
  }
  # 우리 버킷의 설정 읽기(버킷 ARN만. 객체는 아래 상태 파일만)
  statement {
    actions   = ["s3:Get*", "s3:List*"]
    resources = ["arn:aws:s3:::gachita-*"]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::gachita-tfstate-${local.account}/*"]
  }
  # 소진 속도 알림과 SLO 대시보드(본 설정 slo.tf). DescribeAlarms를 이름 접두사로 물을 때 자원 단위로 좁혀도 되는지 확인하지 못해 *로 둔다(설정만 보이고 값은 아님)
  statement {
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
  statement {
    actions   = ["cloudwatch:ListTagsForResource", "cloudwatch:GetDashboard"]
    resources = local.cloudwatch_ours
  }
  # Terraform이 쓴 값과 공개 AMI 번호만
  statement {
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account}:parameter/gachita/*/tf/*",
      "arn:aws:ssm:${var.region}::parameter/aws/service/*",
    ]
  }
  statement {
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "plan_read" {
  name   = "read-gachita-stack"
  role   = aws_iam_role.github["plan"].id
  policy = data.aws_iam_policy_document.plan_read.json
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
  # 복호화는 사람이 넣은 값의 경로만 막는다. Terraform이 쓴 SecureString(/tf/)은 계획의 refresh가 읽어야 한다
  # (같은 값이 상태 파일에도 있어 막아도 지키는 것이 없다).
  statement {
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = local.human_secrets
    }
  }
  statement {
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]
  }
  # ec2:Get*·Describe* 가운데 설정이 아니라 값(남의 서버 user data, 콘솔 출력·화면, 시작 템플릿의 user data)을 주는 것
  statement {
    effect    = "Deny"
    actions   = ["ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot", "ec2:GetLaunchTemplateData", "ec2:GetPasswordData"]
    resources = ["*"]
  }
  statement { # 우리 서버의 속성은 refresh가 읽는다(user data 포함)
    effect    = "Deny"
    actions   = ["ec2:DescribeInstanceAttribute"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
}

resource "aws_iam_role_policy" "plan_deny" {
  name   = "deny-data-and-secrets"
  role   = aws_iam_role.github["plan"].id
  policy = data.aws_iam_policy_document.plan_deny.json
}

# ---- 적용(develop, 수동 실행): 본 설정이 만드는 자원의 서비스만 ----
data "aws_iam_policy_document" "apply" {
  # ---- EC2(네트워크, 서버, 보안 그룹, VPC 엔드포인트) ----
  # 읽기: 자원 단위로 좁힐 수 없다. 이 리전만
  statement {
    actions   = ["ec2:Describe*", "ec2:Get*"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }
  # 만들기: 새 자원에 우리 태그가 있어야 한다
  statement {
    actions   = [for a in local.ec2_create : "ec2:${a}"]
    resources = [for t in local.ec2_made : "${local.ec2_arn}:${t}/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
  }
  # 만드는 순간에 태그 달기(TagSpecifications)
  statement {
    actions   = ["ec2:CreateTags"]
    resources = ["${local.ec2_arn}:*/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = local.ec2_create
    }
  }
  # 고치기·지우기·붙이기: 우리 태그가 있는 자원만(새 서브넷의 VPC처럼 만들 때 가리키는 부모도 여기서 허용)
  statement {
    actions = concat([for a in local.ec2_create : "ec2:${a}"], ["ec2:Delete*", "ec2:Modify*", "ec2:Associate*",
      "ec2:Disassociate*", "ec2:Attach*", "ec2:Detach*", "ec2:Replace*", "ec2:Revoke*", "ec2:CreateRoute",
      "ec2:CreateTags", "ec2:DeleteTags", "ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances",
    "ec2:TerminateInstances"])
    resources = ["${local.ec2_arn}:*/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  # 서버와 함께 생기는 디스크·네트워크 카드와 공개 AMI. 서버(instance)는 위의 태그 조건을 통과해야 한다.
  # ponytail: 네트워크 카드는 태그 조건이 없어, 다른 프로젝트의 기존 카드를 지정해 우리 서버를 띄우는 것은 막지 못한다
  #           (그 카드를 고치거나 지우지는 못함). 막으려면 aws_network_interface를 따로 만들어 태그를 단다.
  statement {
    actions   = ["ec2:RunInstances"]
    resources = ["${local.ec2_arn}:volume/*", "${local.ec2_arn}:network-interface/*", "arn:aws:ec2:${var.region}::image/*"]
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
  # ---- 인증서(남는 묶음): 우리 태그를 달아 만들고, 우리 태그가 있는 것만 고치고 지운다 ----
  statement {
    # AddTagsToCertificate는 넣지 않는다: 요청 태그만 보면 남의(태그 없는) 인증서에 우리 태그를 달고 지울 수 있다.
    # 태그를 단 요청에 그 권한이 따로 필요하면 첫 적용이 AccessDenied로 멈춘다. 그때 인증서는 사람이 로컬 자격으로 만든다
    actions   = ["acm:RequestCertificate"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
  }
  statement {
    actions   = ["acm:DeleteCertificate", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  # ALB 읽기(레코드), 남은 것 확인(태그로 찾기)
  statement {
    actions   = ["acm:DescribeCertificate", "acm:ListCertificates", "acm:ListTagsForCertificate", "elasticloadbalancing:Describe*", "tag:GetResources"]
    resources = ["*"]
  }
  # 접기에서 클러스터가 이미 망가져 컨트롤러가 ALB를 못 지울 때의 정리(ADR-0017 3절). 우리 태그가 있는 것만
  statement {
    actions   = ["elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:DeleteTargetGroup"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  # 펴기·접기 워크플로가 서버에 명령을 보낸다(구축 단계 확인, 마지막 백업, edge 앱 지우기). 우리 서버에만
  statement {
    actions   = ["ssm:SendCommand"]
    resources = ["${local.ec2_arn}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  statement {
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
  }
  statement {
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:DescribeInstanceInformation"]
    resources = ["*"]
  }
  # ---- CloudWatch: 소진 속도 알림과 SLO 대시보드(본 설정 slo.tf, T62). 이름(gachita-*)으로 ----
  statement {
    actions = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource",
    "cloudwatch:ListTagsForResource", "cloudwatch:PutDashboard", "cloudwatch:GetDashboard", "cloudwatch:DeleteDashboards"]
    resources = local.cloudwatch_ours
  }
  statement { # 적용의 refresh와 ops 워크플로의 status(알림 상태)
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
  # ---- IAM: 이름(gachita-*)과 태그(Project=gachita)가 둘 다 맞는 것만 ----
  # 역할 만들기는 권한 경계와 우리 태그를 붙일 때만 된다. 경계보다 넓은 역할을 만들 수 없다
  statement {
    actions   = ["iam:CreateRole"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
  }
  statement {
    actions   = ["iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  statement {
    actions = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
    "iam:ListInstanceProfilesForRole", "iam:ListRoleTags"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
  }
  statement {
    actions = ["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:UpdateRole",
    "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole"]
    resources = ["arn:aws:iam::${local.account}:role/gachita-*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  # 태그를 달며 만들 때(CreateRole 등에 태그가 들어 있으면 Tag* 권한도 따로 판정된다)
  statement {
    actions = ["iam:TagRole", "iam:TagInstanceProfile", "iam:TagOpenIDConnectProvider"]
    resources = [
      "arn:aws:iam::${local.account}:role/gachita-*",
      "arn:aws:iam::${local.account}:instance-profile/gachita-*",
      local.cluster_oidc_arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
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
  # 인스턴스 프로필과 클러스터의 서비스 계정 OIDC 발급자(파드가 받는 역할, ADR-0011): 만들 때 태그, 그 뒤 태그
  statement {
    actions   = ["iam:CreateInstanceProfile", "iam:CreateOpenIDConnectProvider"]
    resources = ["arn:aws:iam::${local.account}:instance-profile/gachita-*", local.cluster_oidc_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
  }
  statement {
    actions   = ["iam:GetInstanceProfile", "iam:ListInstanceProfileTags", "iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviderTags"]
    resources = ["arn:aws:iam::${local.account}:instance-profile/gachita-*", local.cluster_oidc_arn]
  }
  statement {
    actions = ["iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile",
      "iam:UntagInstanceProfile", "iam:TagInstanceProfile", "iam:DeleteOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider", "iam:TagOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint",
    "iam:AddClientIDToOpenIDConnectProvider", "iam:RemoveClientIDFromOpenIDConnectProvider"]
    resources = ["arn:aws:iam::${local.account}:instance-profile/gachita-*", local.cluster_oidc_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  # 자기 자신과 이 폴더가 만든 것은 고치지 못한다. 고치려면 사람이 로컬 자격으로 이 폴더를 적용한다
  statement {
    effect  = "Deny"
    actions = ["iam:*"]
    resources = [
      "arn:aws:iam::${local.account}:role/gachita-github-*",
      local.boundary_arn,
      data.aws_iam_openid_connect_provider.github.arn, # 다른 프로젝트와 같이 쓰는 GitHub 제공자
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
  statement {
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = local.human_secrets
    }
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
  # SecureString 복호화(AWS 관리 키 aws/ssm). SSM을 거친 요청만
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
  statement {
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::gachita-*", "arn:aws:s3:::gachita-*/*"]
  }
  statement {
    actions   = ["s3:GetEncryptionConfiguration"]
    resources = ["*"]
  }
  # ALB 컨트롤러(ADR-0017). 역할 자체의 권한은 공식 정책(본 설정 iam.tf). 공식 정책은 보안 그룹 규칙과 리스너를
  # 자원 조건 없이 고칠 수 있어, 같이 쓰는 계정에서는 여기서 우리 것으로 좁힌다.
  statement {
    actions = ["elasticloadbalancing:Describe*", "ec2:Describe*", "ec2:GetSecurityGroupsForVpc", "acm:ListCertificates",
    "acm:DescribeCertificate", "iam:ListServerCertificates", "iam:GetServerCertificate"]
    resources = ["*"]
  }
  statement { # 만들 때 우리 태그를 단다(차트 값 defaultTags)
    actions   = ["elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:CreateTargetGroup", "ec2:CreateSecurityGroup"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
  }
  # 태그 달기는 만드는 호출 안에서만. 요청 태그만 보면 남의 자원에 우리 태그를 달아 위의 '우리 태그' 권한을 얻는다
  statement {
    actions   = ["elasticloadbalancing:AddTags"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
    condition {
      test     = "StringEquals"
      variable = "elasticloadbalancing:CreateAction"
      values   = ["CreateLoadBalancer", "CreateTargetGroup"]
    }
  }
  statement {
    actions   = ["ec2:CreateTags"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.project]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateSecurityGroup"]
    }
  }
  statement { # 우리 태그가 있는 것만 고치고 지운다(ALB·대상 그룹·보안 그룹, 노드 보안 그룹, 보안 그룹을 만들 VPC)
    actions = ["elasticloadbalancing:*", "ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
    "ec2:RevokeSecurityGroupIngress", "ec2:DeleteSecurityGroup", "ec2:CreateTags", "ec2:DeleteTags"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.project]
    }
  }
  statement { # 리스너와 규칙은 태그가 늦게 붙을 수 있어 ALB 이름으로
    actions   = ["elasticloadbalancing:*"]
    resources = local.alb_named
  }
  statement { # 계정에 ELB 서비스 연결 역할이 아직 없을 때 한 번
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["elasticloadbalancing.amazonaws.com"]
    }
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
