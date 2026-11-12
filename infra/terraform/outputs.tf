output "public_ip" {
  description = "서버의 고정 IP"
  value       = aws_eip.k3s.public_ip
}

output "api_host" {
  description = "API의 주소 이름. infra/gitops의 인그레스에 이 값을 적는다"
  value       = local.api_host
}

output "data_bucket" {
  description = "백업과 클립 버킷"
  value       = aws_s3_bucket.data.bucket
}

output "ssm_session" {
  description = "서버에 들어가는 명령"
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.k3s.id}"
}
