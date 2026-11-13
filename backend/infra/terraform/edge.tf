# 가장자리: Cloudflare(프록시) → ALB → API의 NodePort(ADR-0016, ADR-0017). 영역(mangowhois.ai)의 다른 레코드는
# 가져오지도 고치지도 않는다. 인증서와 요청 수 제한은 남는 묶음(persist/)에 있다.
#
# ALB는 클러스터의 AWS Load Balancer Controller가 만든다(Terraform 상태 밖). 그래서 레코드는 컨트롤러의 클러스터 태그로
# ALB를 찾았을 때만 만든다: 첫 적용에는 레코드가 없고, ALB가 생긴 뒤 한 번 더 적용하면 생긴다(펴기 8번).
# 접힌 상태(ALB 없음)에서도 계획이 깨지지 않는다.
data "aws_lbs" "cluster" {
  tags = { "elbv2.k8s.aws/cluster" = local.cluster }
}

locals {
  alb_arn = one(data.aws_lbs.cluster.arns) # 이름이 gachita-<env>로 고정이라 하나뿐이어야 한다(둘이면 실패)
}

data "aws_lb" "cluster" {
  count = local.alb_arn == null ? 0 : 1
  arn   = local.alb_arn
}

resource "cloudflare_dns_record" "service" {
  count   = var.cloudflare_zone_id != "" && local.alb_arn != null ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.service_host
  type    = "CNAME"
  content = data.aws_lb.cluster[0].dns_name
  proxied = true
  ttl     = 1 # 프록시 레코드는 자동
  comment = "gachita: managed by terraform (backend/infra/terraform/edge.tf)"
}
