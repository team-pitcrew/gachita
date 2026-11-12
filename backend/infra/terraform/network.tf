# 한 대짜리 구성이라 공개 서브넷 하나만 둔다. 서버로 들어오는 포트는 없다(Cloudflare Tunnel은 서버가 밖으로 연결).
# 대역: VPC 10.10.0.0/16. K3s의 파드(10.42.0.0/16)·서비스(10.43.0.0/16) 대역과 겹치면 노드 경로가 깨진다.
# ponytail: NAT와 사설 서브넷이 없다. 노드를 늘리거나 서버를 밖에서 아예 못 보게 하려면 사설 서브넷과 NAT를 더한다.
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.10.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "gachita-${var.env}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "gachita-${var.env}" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.10.0.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false # 서버에서 직접 켠다(compute.tf)
  tags                    = { Name = "gachita-${var.env}-public" }
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
  subnet_id      = aws_subnet.public.id
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
  description = "K3s server: nothing in, everything out (Cloudflare Tunnel dials out)"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "gachita-${var.env}-k3s" }
}

# 들어오는 규칙은 기본으로 없다. SSH(22)·웹(80·443)을 열지 않는다. 관리 접속은 SSM 세션과 포트 포워딩.
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
