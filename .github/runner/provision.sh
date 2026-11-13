#!/bin/bash
# 자체 러너 VM 하나를 준비한다(T65). up.sh가 Lima VM 안에서 VM 사용자로 부른다. VM 하나에 러너 하나: 잡끼리 Docker 이름·포트가 겹치지 않게.
# 입력(환경 변수): RUNNER_NAME, RUNNER_TOKEN(1시간짜리 등록 토큰). Android 라이선스 파일은 호스트에서 /tmp/android-sdk-license로 넣어 둔다.
set -euxo pipefail
RUNNER_VERSION=2.338.2
RUNNER_SHA=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945
KUBECTL_VERSION=v1.37.2
YQ_VERSION=v4.54.3
export DEBIAN_FRONTEND=noninteractive

# ubuntu-latest에 미리 있던 도구 가운데 워크플로가 쓰는 것
sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq make python3 unzip zip ca-certificates
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
  sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
sudo apt-get update -qq && sudo apt-get install -y -qq gh
curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/arm64/kubectl"
echo "$(curl -fsSL "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/arm64/kubectl.sha256")  /tmp/kubectl" | sha256sum -c
sudo install -m 755 /tmp/kubectl /usr/local/bin/kubectl
curl -fsSLo /tmp/yq "https://github.com/mikefarah/yq/releases/download/$YQ_VERSION/yq_linux_arm64"
sudo install -m 755 /tmp/yq /usr/local/bin/yq

# Android SDK: 빈 SDK에 호스트에서 이미 동의한 라이선스만 둔다. 빌드할 때 AGP가 필요한 판을 받는다.
# aapt2 등 SDK의 리눅스 도구는 x86_64라 VM의 Rosetta(binfmt)로 돈다
sudo mkdir -p /opt/android-sdk/licenses
sudo install -m 644 /tmp/android-sdk-license /opt/android-sdk/licenses/android-sdk-license
sudo chown -R "$USER" /opt/android-sdk

# 잡을 시작할 때마다: 앞 잡이 남긴 컨테이너·네트워크·볼륨과 레지스트리 로그인을 지운다. 이미지는 캐시로 남기되 디스크가 80%를 넘으면 지운다
sudo mkdir -p /opt/runner-hooks
sudo tee /opt/runner-hooks/job-started.sh >/dev/null <<'HOOK'
#!/bin/bash
docker ps -aq | xargs -r docker rm -f >/dev/null
docker network prune -f >/dev/null
docker volume prune -af >/dev/null
rm -f "$HOME/.docker/config.json"
[ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt 80 ] || docker system prune -af >/dev/null
true
HOOK
sudo chmod 755 /opt/runner-hooks/job-started.sh

# 러너(공식 릴리스, 체크섬 확인)
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSLo runner.tar.gz "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz"
echo "$RUNNER_SHA  runner.tar.gz" | sha256sum -c
tar xzf runner.tar.gz && rm runner.tar.gz
sudo ./bin/installdependencies.sh >/dev/null
cat > .env <<ENV
LANG=C.UTF-8
ANDROID_HOME=/opt/android-sdk
ANDROID_SDK_ROOT=/opt/android-sdk
ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/runner-hooks/job-started.sh
ENV
./config.sh --unattended --url https://github.com/team-pitcrew/gachita --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" --labels gachita --work _work --replace
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
rm -f /tmp/android-sdk-license
echo "runner-ready $RUNNER_NAME"
