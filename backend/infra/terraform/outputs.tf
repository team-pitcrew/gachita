output "service_url" {
  description = "밖에서 닿는 주소(Cloudflare). 확인: curl <이 값>/healthz"
  value       = "https://${var.service_host}"
}

output "account_id" {
  description = "backend/infra/gitops의 자리 표시 000000000000을 이 값으로 바꾼다(역할 ARN, 버킷 이름)"
  value       = local.account
}

output "data_bucket" {
  description = "백업과 클립 버킷"
  value       = aws_s3_bucket.data.bucket
}

output "oidc_issuer" {
  description = "K3s 서비스 계정 발급자(파드가 받는 AWS 역할의 신뢰 대상)"
  value       = local.oidc_issuer
}

output "workload_roles" {
  description = "서비스 계정에 붙이는 역할(eks.amazonaws.com/role-arn 주석)"
  value       = { for k, r in aws_iam_role.workload : k => r.arn }
}

output "ssm_session" {
  description = "서버에 들어가는 명령"
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.k3s.id}"
}

output "ssm_kube_api" {
  description = "쿠버네티스 API를 내 컴퓨터의 6443으로(kubeconfig의 server는 https://127.0.0.1:6443)"
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.k3s.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=6443,localPortNumber=6443"
}

output "converge" {
  description = "구축 단계를 다시 돌리는 명령(같은 결과가 되게 짜여 있다)"
  value       = "aws ssm send-command --region ${var.region} --instance-ids ${aws_instance.k3s.id} --document-name AWS-RunShellScript --parameters commands=/usr/local/sbin/gachita-converge"
}
