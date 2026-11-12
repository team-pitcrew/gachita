# K3s 서버 한 대. 관리형 쿠버네티스를 쓰지 않고 직접 운영한다.
# 첫 부팅 스크립트는 구축 도구만 깔고 저장소의 Ansible(backend/infra/cluster)을 부른다. 단계는 거기에 있다.
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
  }

  tags = { Name = "gachita-${var.env}-k3s" }
}
