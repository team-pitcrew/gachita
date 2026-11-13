#!/bin/sh
# 계정 번호 자리 표시(000000000000)를 실제 계정 번호로 바꾼다. 역할 ARN(서비스 계정 주석)과 버킷 이름에 쓰인다.
# 자원을 만들기 **전에** 돌려 develop에 병합한다. 그러지 않으면 Terraform이 서버를 만들지 않는다(compute.tf의 precondition).
#   backend/infra/gitops/fill-account.sh                 # 지금 aws 자격의 계정 번호
#   backend/infra/gitops/fill-account.sh 123456789012
set -eu
account=${1:-$(aws sts get-caller-identity --query Account --output text)}
case $account in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "계정 번호는 숫자 12자리입니다: $account" >&2; exit 1 ;;
esac
dir=$(dirname "$0")
files=$(grep -rl --include='*.yaml' 000000000000 "$dir" || true)
if [ -z "$files" ]; then echo "자리 표시가 없습니다(이미 채움)"; exit 0; fi
for f in $files; do
  sed -i.bak "s/000000000000/$account/g" "$f" && rm -f "$f.bak"
  echo "채움: $f"
done
