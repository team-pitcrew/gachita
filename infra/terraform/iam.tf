# 서버가 쓰는 역할. 열쇠를 서버에 두지 않고 인스턴스 역할로 받는다.
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "k3s" {
  name               = "gachita-${var.env}-k3s"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

# SSM 세션으로 들어가기
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.k3s.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "k3s" {
  # Postgres 백업을 버킷에 쓰고 읽는다
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.data.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.data.arn}/*"]
  }
  # 첫 부팅 때 Argo CD가 저장소를 읽을 토큰을 가져온다(README의 '처음 한 번'에서 사람이 넣는다)
  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/gachita/${var.env}/*"]
  }
}

resource "aws_iam_role_policy" "k3s" {
  name   = "gachita-${var.env}-k3s"
  role   = aws_iam_role.k3s.id
  policy = data.aws_iam_policy_document.k3s.json
}

resource "aws_iam_instance_profile" "k3s" {
  name = "gachita-${var.env}-k3s"
  role = aws_iam_role.k3s.name
}
