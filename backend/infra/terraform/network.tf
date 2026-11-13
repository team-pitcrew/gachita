# 공개 서브넷 둘(ALB는 가용 영역 둘이 필요). 서버는 첫째에 있다. 들어오는 길은 Cloudflare → ALB → 서버의 NodePort뿐이고,
# 그 규칙은 ALB 컨트롤러가 노드 보안 그룹에 더한다(ADR-0016, ADR-0017).
# 대역: VPC 10.10.0.0/16. K3s의 파드(10.42.0.0/16)·서비스(10.43.0.0/16) 대역과 겹치면 노드 경로가 깨진다.
# 공개 서브넷 대역(10.10.0.0/23)은 API의 네트워크 정책이 ALB를 알아보는 데도 쓴다(backend/infra/gitops/apps/api).
# ponytail: NAT와 사설 서브넷이 없다. 서버를 밖에서 아예 못 보게 하려면 사설 서브넷과 NAT를 더한다(ADR-0016의 기본 배치 밖).
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = "10.10.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.cluster } # ALB 컨트롤러가 이 이름 태그로 VPC를 찾는다(차트 값 vpcTags)
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "gachita-${var.env}" }
}

resource "aws_subnet" "public" {
  for_each                = { for i, az in local.azs : az => i }
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.10.${each.value}.0/24"
  availability_zone       = each.key
  map_public_ip_on_launch = false # 서버에서 직접 켠다(compute.tf)
  tags = {
    Name                                     = "gachita-${var.env}-public-${each.value}"
    "kubernetes.io/role/elb"                 = "1" # 컨트롤러가 인터넷 쪽 ALB를 둘 서브넷을 이 태그로 찾는다
    "kubernetes.io/cluster/${local.cluster}" = "owned"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "gachita-${var.env}-public" }
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# S3로 가는 길을 AWS 안으로(백업). 게이트웨이 엔드포인트는 비용이 없다.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "gachita-${var.env}-s3" }
}

resource "aws_security_group" "k3s" {
  name        = "gachita-${var.env}-k3s"
  description = "K3s node: only the ALB reaches the NodePort (rule added by the ALB controller)"
  vpc_id      = aws_vpc.main.id
  tags = {
    Name                                     = "gachita-${var.env}-k3s"
    "kubernetes.io/cluster/${local.cluster}" = "owned" # 컨트롤러가 대상 노드의 보안 그룹을 이 태그로 고른다
  }
}

# Terraform은 들어오는 규칙을 아래 것만 따로 든다(보안 그룹에 묶어 들지 않음). 그래서 ALB 컨트롤러가 더한
# 'ALB 뒷단 보안 그룹 → NodePort' 규칙을 다음 적용이 지우지 않는다. SSH(22)·웹(80·443)은 열지 않는다.
# 관리 접속은 SSM 세션과 포트 포워딩.
resource "aws_vpc_security_group_ingress_rule" "kube_api" {
  for_each          = toset(var.admin_cidrs)
  security_group_id = aws_security_group.k3s.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 6443
  to_port           = 6443
  description       = "kubernetes api for admins"
}

# 나가는 길은 열어 둔다. 파드가 어디로 나갈지는 Cilium 정책이 이름(FQDN)으로 막는다(ADR-0013).
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.k3s.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "all out"
}
