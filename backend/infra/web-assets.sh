#!/usr/bin/env bash
# 웹 화면 파일(frontend/web)을 미디어 CDN의 공개 접두사에 올린다(T179, ADR-0026 6절). deploy-tag 워크플로가 태그 변경 PR을 열기 전에 부른다.
#
#   backend/infra/web-assets.sh <태그>   태그 = 커밋 SHA 앞 12자. 그 커밋의 frontend/web을 s3://<클립 버킷>/public/web/<태그>/ 에 올린다
#
# 판마다 새 접두사라 덮어쓰지 않는다. 그래서 1년 캐시(immutable)를 주고, 되돌릴 때 옛 접두사가 그대로 살아 있다.
# 다시 돌려도 같다(sync는 이미 있는 파일을 건너뛴다). 필요한 것: AWS 자격(올리기 역할, account/), git, aws.
set -euo pipefail

tag=${1:?태그(커밋 SHA 앞 12자)가 필요합니다}
printf '%s' "$tag" | grep -Eq '^[0-9a-f]{12}$' || {
  echo "::error::태그는 커밋 SHA 앞 12자입니다: $tag" >&2
  exit 1
}
export AWS_PAGER=""
env_name=${TF_VAR_env:-dev}
bucket="gachita-$env_name-clips-$(aws sts get-caller-identity --query Account --output text)"
dest="s3://$bucket/public/web/$tag"
cache="public, max-age=31536000, immutable"

# 일하는 폴더가 아니라 그 커밋의 파일을 꺼낸다(이미지에 든 것과 같다). 임시 폴더는 러너가 치운다(RUNNER_TEMP)
tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/web-assets.XXXXXX")
git archive "$tag" frontend/web | tar -x -C "$tmp"
src="$tmp/frontend/web"

# aws가 확장자로 추측하지 못하거나 러너마다 달라지는 것은 Content-Type을 적어 올린다.
# 모듈 스크립트는 Content-Type이 자바스크립트가 아니면 브라우저가 실행하지 않는다.
while read -r ext type; do
  aws s3 cp "$src" "$dest" --recursive --exclude '*' --include "*.$ext" \
    --content-type "$type" --cache-control "$cache" --only-show-errors
done <<'TYPES'
js text/javascript
mjs text/javascript
css text/css
svg image/svg+xml
json application/json
webmanifest application/manifest+json
wasm application/wasm
webp image/webp
TYPES
# 나머지(png·jpg 등)는 추측대로. 위에서 올린 파일은 크기가 같아 건너뛴다
aws s3 sync "$src" "$dest" --size-only --cache-control "$cache" --only-show-errors

echo "올림: $dest ($(find "$src" -type f | wc -l | tr -d ' ')개)"
