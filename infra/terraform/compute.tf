# K3s 서버 한 대. 관리형 쿠버네티스를 쓰지 않고 직접 운영한다.
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_eip" "k3s" {
  domain = "vpc"
  tags   = { Name = "gachita-${var.env}-k3s" }
}

locals {
  # 도메인 없이 인증서를 받으려고 sslip.io 이름을 쓴다. 1.2.3.4 → api.1-2-3-4.sslip.io
  api_host = "api.${replace(aws_eip.k3s.public_ip, ".", "-")}.sslip.io"
}

resource "aws_instance" "k3s" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.k3s.id]
  iam_instance_profile   = aws_iam_instance_profile.k3s.name

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    env             = var.env
    region          = var.region
    public_ip       = aws_eip.k3s.public_ip
    k3s_version     = var.k3s_version
    argocd_version  = var.argocd_version
    gitops_repo     = var.gitops_repo
    gitops_revision = var.gitops_revision
  })
  user_data_replace_on_change = true

  metadata_options {
    http_tokens                 = "required" # IMDSv2만
    http_put_response_hop_limit = 2          # 파드가 인스턴스 역할을 쓸 수 있게(Postgres 백업)
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

resource "aws_eip_association" "k3s" {
  instance_id   = aws_instance.k3s.id
  allocation_id = aws_eip.k3s.id
}
