#!/bin/bash
# 이 Mac에 자체 러너 VM을 만든다(T65). VM 하나에 러너 하나라 잡끼리 Docker 이름·포트가 겹치지 않는다.
#   .github/runner/up.sh 1 2 3      gachita-runner-1..3 VM과 러너 gachita-mac-1..3
#
# VM: Ubuntu 24.04 + Docker(Lima docker-rootful), 4 CPU · 8 GiB · 60 GiB. Mac 폴더를 붙이지 않고(--mount-none) 포트를 Mac으로
# 내보내지 않는다. Rosetta: Android SDK의 리눅스 도구(aapt2 등)가 x86_64라서.
# 필요한 것: limactl, gh(이 저장소 관리자), 이 Mac의 Android SDK 라이선스(~/Library/Android/sdk/licenses, 이미 동의한 것을 옮김).
# 지우기: limactl delete -f gachita-runner-N, 그리고 저장소 Settings → Actions → Runners에서 gachita-mac-N 제거
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
license=${ANDROID_LICENSE:-$HOME/Library/Android/sdk/licenses/android-sdk-license}
[ -f "$license" ] || { echo "Android SDK 라이선스 파일이 없습니다: $license" >&2; exit 1; }
for n in "$@"; do
  vm=gachita-runner-$n
  limactl list -q | grep -qx "$vm" || limactl create --tty=false --name="$vm" --cpus=4 --memory=8 --disk=60 --mount-none \
    --set '.vmType="vz" | .rosetta.enabled=true | .rosetta.binfmt=true | .portForwards=[{"guestPortRange":[1,65535],"guestIP":"0.0.0.0","ignore":true}]' \
    template://docker-rootful
  limactl start --tty=false "$vm"
  limactl copy "$license" "$vm:/tmp/android-sdk-license"
  # 등록 토큰은 1시간짜리라 VM마다 새로 받는다
  token=$(gh api -X POST repos/team-pitcrew/gachita/actions/runners/registration-token -q .token)
  limactl shell "$vm" env RUNNER_NAME="gachita-mac-$n" RUNNER_TOKEN="$token" bash -s < "$here/provision.sh"
done
gh api repos/team-pitcrew/gachita/actions/runners -q '.runners[] | "\(.name) \(.status)"'
