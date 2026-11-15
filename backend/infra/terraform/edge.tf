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
  # DNS만(T174, 11/15). 프록시를 켜면 한국 요청이 Cloudflare LAX 엣지를 돌아 서울 원본으로 온다(TLS 0.5~1초, 3.5 MB 내려받기 43~130초).
  # 끄면 ALB가 직접 받는다: 엣지의 요청 수 제한(persist/의 ruleset)과 원본 가리기가 이 호스트에는 걸리지 않는다. 되돌리려면 true·ttl 1.
  proxied = false
  ttl     = 60
  comment = "gachita: managed by terraform (backend/infra/terraform/edge.tf)"
}
