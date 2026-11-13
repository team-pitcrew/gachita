# P02/P03 준비. 기본값에서는 자원을 추가하지 않으며 기존 aws_instance.k3s는 그대로 둡니다.
variable "enable_private_agents" {
  description = "P01 동결·토큰 준비·plan 검토 뒤 별도로 적용할 때만 true. NAT 2대와 agent 3대의 비용이 발생합니다"
  type        = bool
  default     = false
}

locals {
  agent_azs = var.enable_private_agents ? { for i, az in local.azs : az => i } : {}
  agents = var.enable_private_agents ? {
    app-a  = { pool = "app", az = local.azs[0], instance_type = "t4g.small" }
    app-b  = { pool = "app", az = local.azs[1], instance_type = "t4g.small" }
    data-a = { pool = "data", az = local.azs[0], instance_type = "t4g.medium" }
  } : {}
  agent_token_parameter = "/gachita/${var.env}/bootstrap/k3s-agent-token"
}

resource "aws_subnet" "private" {
  for_each                = local.agent_azs
  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = "10.10.${10 + each.value}.0/24"
  map_public_ip_on_launch = false
  tags = {
    Name                                     = "${local.cluster}-private-${each.value}"
    "kubernetes.io/role/internal-elb"        = "1"
    "kubernetes.io/cluster/${local.cluster}" = "owned"
  }
}

resource "aws_eip" "nat" {
  for_each = local.agent_azs
  domain   = "vpc"
  tags     = { Name = "${local.cluster}-nat-${each.value}" }
}

resource "aws_nat_gateway" "agents" {
  for_each      = local.agent_azs
  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  tags          = { Name = "${local.cluster}-nat-${each.value}" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  for_each = local.agent_azs
  vpc_id   = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.agents[each.key].id
  }
  tags = { Name = "${local.cluster}-private-${each.value}" }
}

resource "aws_route_table_association" "private" {
  for_each       = local.agent_azs
  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

# 기존 endpoint의 소유 경로를 바꾸지 않도록 사설 route table 전용으로 추가합니다.
resource "aws_vpc_endpoint" "agents_s3" {
  count             = var.enable_private_agents ? 1 : 0
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for rt in aws_route_table.private : rt.id]
  tags              = { Name = "${local.cluster}-agents-s3" }
}

# ALB controller가 관리하는 NodePort 규칙과 충돌하지 않게 인라인 ingress는 쓰지 않습니다.
resource "aws_security_group" "agent" {
  for_each    = var.enable_private_agents ? toset(["app", "data"]) : toset([])
  name        = "${local.cluster}-${each.key}"
  description = "Private K3s ${each.key} agents"
  vpc_id      = aws_vpc.main.id
  tags = {
    Name                                     = "${local.cluster}-${each.key}"
    "kubernetes.io/cluster/${local.cluster}" = "owned"
  }
}

locals {
  node_sgs = var.enable_private_agents ? merge({ platform = aws_security_group.k3s.id }, { for k, sg in aws_security_group.agent : k => sg.id }) : {}
  # Cilium VXLAN, health TCP/ICMP, kubelet(메트릭·로그). 모두 노드 SG 사이에서만 허용합니다.
  node_links = { for link in setproduct(keys(local.node_sgs), keys(local.node_sgs), ["vxlan", "health", "icmp", "kubelet"]) :
    join("-", link) => { from = link[0], to = link[1], kind = link[2] }
    if link[2] != "kubelet" || link[0] == "platform"
  }
  node_protocols = {
    vxlan   = { protocol = "udp", port = 8472 }
    health  = { protocol = "tcp", port = 4240 }
    icmp    = { protocol = "icmp", port = -1 }
    kubelet = { protocol = "tcp", port = 10250 }
  }
}

resource "aws_vpc_security_group_ingress_rule" "node_mesh" {
  for_each                     = local.node_links
  security_group_id            = local.node_sgs[each.value.to]
  referenced_security_group_id = local.node_sgs[each.value.from]
  ip_protocol                  = local.node_protocols[each.value.kind].protocol
  from_port                    = local.node_protocols[each.value.kind].port
  to_port                      = local.node_protocols[each.value.kind].port
  description                  = "${each.value.kind}: ${each.value.from} to ${each.value.to}"
}

resource "aws_vpc_security_group_ingress_rule" "agent_api" {
  for_each                     = aws_security_group.agent
  security_group_id            = aws_security_group.k3s.id
  referenced_security_group_id = each.value.id
  ip_protocol                  = "tcp"
  from_port                    = 6443
  to_port                      = 6443
  description                  = "private ${each.key} agents to K3s server"
}

resource "aws_vpc_security_group_egress_rule" "agent" {
  for_each          = aws_security_group.agent
  security_group_id = each.value.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_iam_role" "agent" {
  count                = var.enable_private_agents ? 1 : 0
  name                 = "${local.cluster}-agent"
  assume_role_policy   = data.aws_iam_policy_document.assume_ec2.json
  permissions_boundary = local.boundary_arn
}

resource "aws_iam_role_policy_attachment" "agent_ssm" {
  count      = var.enable_private_agents ? 1 : 0
  role       = aws_iam_role.agent[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "agent" {
  statement {
    actions = ["ssm:GetParameter"]
    resources = [
      "${local.ssm_prefix}/bootstrap/argocd-repo-token",
      "${local.ssm_prefix}/bootstrap/k3s-agent-token",
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "agent" {
  count  = var.enable_private_agents ? 1 : 0
  name   = "${local.cluster}-agent-bootstrap"
  role   = aws_iam_role.agent[0].id
  policy = data.aws_iam_policy_document.agent.json
}

resource "aws_iam_instance_profile" "agent" {
  count = var.enable_private_agents ? 1 : 0
  name  = "${local.cluster}-agent"
  role  = aws_iam_role.agent[0].name
}

resource "aws_instance" "agent" {
  for_each                    = local.agents
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = each.value.instance_type
  subnet_id                   = aws_subnet.private[each.value.az].id
  vpc_security_group_ids      = [aws_security_group.agent[each.value.pool].id]
  iam_instance_profile        = aws_iam_instance_profile.agent[0].name
  associate_public_ip_address = false
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/agent_user_data.sh.tftpl", {
    vars = jsonencode({
      env                   = var.env
      region                = var.region
      gitops_repo           = var.gitops_repo
      gitops_revision       = var.gitops_revision
      node_name             = "${local.cluster}-${each.key}"
      node_pool             = each.value.pool
      server_url            = "https://${aws_instance.k3s.private_ip}:6443"
      agent_token_parameter = local.agent_token_parameter
    })
  })
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = 40
    encrypted   = true
  }
  lifecycle {
    ignore_changes = [ami]
  }
  tags = { Name = "${local.cluster}-${each.key}", NodePool = each.value.pool }
  # 첫 apt/SSM 호출 전에 NAT 경로와 IAM 정책을 준비합니다.
  depends_on = [aws_route_table_association.private, aws_iam_role_policy.agent, aws_iam_role_policy_attachment.agent_ssm]
}

output "private_agents" {
  description = "기본값은 빈 map. 새 agent만 포함하며 기존 instance_id 출력은 유지합니다"
  value       = { for name, node in aws_instance.agent : name => { id = node.id, private_ip = node.private_ip, pool = local.agents[name].pool, az = local.agents[name].az } }
}
