# K3s 서버 한 대. 관리형 쿠버네티스를 쓰지 않고 직접 운영한다.
# 첫 부팅 스크립트는 구축 도구만 깔고 저장소의 Ansible(backend/infra/cluster)을 부른다. 단계는 거기에 있다.
locals {
  gitops              = "${path.module}/../gitops"
  gitops_placeholders = [for f in fileset(local.gitops, "**/*.yaml") : f if strcontains(file("${local.gitops}/${f}"), "000000000000")]
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "k3s" {
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.k3s.id]
  iam_instance_profile        = aws_iam_instance_profile.k3s.name
  associate_public_ip_address = true # 나가는 길에만 쓴다. 들어오는 길은 Cloudflare Tunnel이라 고정 IP가 필요 없다

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    env             = var.env
    region          = var.region
    account_id      = local.account
    gitops_repo     = var.gitops_repo
    gitops_revision = var.gitops_revision
    service_host    = var.service_host
    oidc_bucket     = aws_s3_bucket.oidc.bucket
    oidc_issuer     = local.oidc_issuer
  })
  user_data_replace_on_change = true

  metadata_options {
    http_tokens                 = "required" # IMDSv2만
    http_put_response_hop_limit = 1          # 파드는 서버의 역할에 닿지 못한다. 파드는 서비스 계정 역할을 쓴다(ADR-0011)
  }

  maintenance_options {
    auto_recovery = "default" # 하드웨어 장애 때 같은 서버(디스크·주소 그대로)로 되살린다
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  lifecycle {
    ignore_changes = [ami] # 새 이미지가 나왔다고 서버를 갈아 치우지 않는다

    # 서버가 뜨면 첫 부팅이 develop의 backend/infra/gitops를 그대로 올린다. 아래가 맞지 않으면 물결 2·4에서 멈추므로
    # 서버를 만들기 전에 막는다(README '만들기 전에').
    precondition {
      condition     = length(local.gitops_placeholders) == 0 && strcontains(file("${local.gitops}/platform/secret-stores/ssm.yaml"), local.account)
      error_message = "backend/infra/gitops의 계정 번호가 이 계정과 다르거나 자리 표시(000000000000)가 남았다: ${join(", ", local.gitops_placeholders)}. backend/infra/gitops/fill-account.sh 로 채워 develop에 병합한 뒤 만든다."
    }
    precondition {
      condition     = !strcontains(file("${local.gitops}/apps/api/overlays/dev/kustomization.yaml"), "newTag: unreleased")
      error_message = "API 이미지 태그가 unreleased다. make push 뒤 make deploy-tag TAG=<올린 태그> 를 develop에 병합한 뒤 만든다."
    }
  }

  tags = { Name = "gachita-${var.env}-k3s" }
}
