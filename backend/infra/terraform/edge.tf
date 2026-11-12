# 가장자리: Cloudflare Tunnel과 gachita 레코드 하나(ADR-0010, ADR-0013).
# 영역(mangowhois.ai)의 다른 레코드(메일 전달 등)는 가져오지도 고치지도 않는다.
# 계정·영역 번호가 비어 있으면 아무것도 만들지 않는다(AWS만 계획할 때).
locals {
  edge = var.cloudflare_account_id != "" && var.cloudflare_zone_id != ""
}

# 원격 관리 터널: 경로 규칙은 Cloudflare 쪽에 두고, 클러스터의 cloudflared는 토큰만 가진다.
resource "cloudflare_zero_trust_tunnel_cloudflared" "k3s" {
  count      = local.edge ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "gachita-${var.env}"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "k3s" {
  count      = local.edge ? 1 : 0
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.k3s[0].id
  config = {
    ingress = [
      {
        # 클러스터 안의 Traefik(edge 네임스페이스). 경로는 Gateway API의 HTTPRoute가 나눈다.
        hostname = var.service_host
        service  = "http://traefik.edge.svc.cluster.local:80"
        origin_request = {
          connect_timeout    = 10
          keep_alive_timeout = 90
        }
      },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_dns_record" "service" {
  count   = local.edge ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.service_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.k3s[0].id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 프록시 레코드는 자동
  comment = "gachita: managed by terraform (backend/infra/terraform/edge.tf)"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "k3s" {
  count      = local.edge ? 1 : 0
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.k3s[0].id
}

# 클러스터의 cloudflared가 External Secrets로 읽는다(/tf/ 아래는 Terraform이 쓰는 값).
resource "aws_ssm_parameter" "tunnel_token" {
  count = local.edge ? 1 : 0
  name  = "/gachita/${var.env}/tf/cloudflare-tunnel-token"
  type  = "SecureString"
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.k3s[0].token
}
