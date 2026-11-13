#!/bin/bash
# 자체 러너 VM 하나를 준비한다(T65). up.sh가 Lima VM 안에서 VM 사용자로 부른다. VM 하나에 러너 하나: 잡끼리 Docker 이름·포트가 겹치지 않게.
# 입력(환경 변수): RUNNER_NAME, RUNNER_TOKEN(1시간짜리 등록 토큰). Android 라이선스 파일은 호스트에서 /tmp/android-sdk-license로 넣어 둔다.
set -euxo pipefail
RUNNER_VERSION=2.338.2
RUNNER_SHA=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945
KUBECTL_VERSION=v1.37.2
YQ_VERSION=v4.54.3
YQ_SHA=89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67 # 릴리스의 checksums(SHA-256)와 같음
AWSCLI_VERSION=2.31.26
AWSCLI_SHA=6fffa5d77635a4695a864a5efda0f61f47a530ceb2aea66ea35a38f3ece95cae # AWS는 PGP 서명만 내어, 11/13 받은 파일의 값으로 고정
export DEBIAN_FRONTEND=noninteractive

# 잡 도중에 apt 잠금이 걸리거나 docker가 올라가지 않게 자동 업그레이드를 끈다(판은 이 스크립트로 올림)
sudo systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true

# ubuntu-latest에 미리 있던 도구 가운데 워크플로가 쓰는 것. ansible-core는 infra-e2e가 apt로 받지만 미리 둔다
sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq make python3 unzip zip ca-certificates nodejs ruby ansible-core
# nodejs: setup-terraform의 래퍼, ruby: backend/api 테스트가 OpenAPI(YAML)를 읽음. 둘 다 ubuntu-latest에 미리 있던 것
# x86_64 C 라이브러리: Rosetta로 도는 Android SDK 도구(aapt2)가 쓴다. amd64 꾸러미는 ports가 아니라 archive에 있다
if ! dpkg --print-foreign-architectures | grep -qx amd64; then
  sudo sed -i '/^URIs: http:\/\/ports.ubuntu.com/a Architectures: arm64' /etc/apt/sources.list.d/ubuntu.sources
  printf 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates noble-security\nComponents: main universe\nArchitectures: amd64\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' |
    sudo tee /etc/apt/sources.list.d/amd64.sources >/dev/null
  sudo dpkg --add-architecture amd64
  sudo apt-get update -qq
fi
sudo apt-get install -y -qq libc6:amd64 libstdc++6:amd64 zlib1g:amd64
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
  sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
sudo apt-get update -qq && sudo apt-get install -y -qq gh
curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/arm64/kubectl"
echo "$(curl -fsSL "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/arm64/kubectl.sha256")  /tmp/kubectl" | sha256sum -c
sudo install -m 755 /tmp/kubectl /usr/local/bin/kubectl
curl -fsSLo /tmp/yq "https://github.com/mikefarah/yq/releases/download/$YQ_VERSION/yq_linux_arm64"
echo "$YQ_SHA  /tmp/yq" | sha256sum -c
sudo install -m 755 /tmp/yq /usr/local/bin/yq
# AWS CLI: infra·ops·infra-secrets 워크플로(infra.sh)가 쓴다
curl -fsSLo /tmp/awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-$AWSCLI_VERSION.zip"
echo "$AWSCLI_SHA  /tmp/awscli.zip" | sha256sum -c
rm -rf /tmp/aws && unzip -q /tmp/awscli.zip -d /tmp && sudo /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscli.zip

# Mac(host.lima.internal = 192.168.5.2)으로 새 연결을 막는다. 잡과 그 의존성이 Mac의 localhost 서비스(adb, 개발 서버)에
# 닿지 않게. DNS(53)는 그 주소로 가야 해서 열고, 들어온 SSH(limactl shell)의 응답은 막지 않는다(NEW만). 재부팅해도 다시 건다
sudo tee /etc/systemd/system/block-mac-host.service >/dev/null <<'UNIT'
[Unit]
Description=Block new connections from this runner VM to the Mac (host.lima.internal), except DNS
After=docker.service
Wants=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/block-mac-host
[Install]
WantedBy=multi-user.target
UNIT
sudo tee /usr/local/sbin/block-mac-host >/dev/null <<'RULES'
#!/bin/sh
# 체인마다 맨 앞에: DNS 허용, 그다음 Mac으로 가는 새 연결 거절(DOCKER-USER 끝의 RETURN보다 앞). 이미 있으면 다시 넣지 않는다
mac=192.168.5.2
front() { chain=$1; shift; iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" 1 "$@"; }
for chain in OUTPUT DOCKER-USER; do
  iptables -L "$chain" >/dev/null 2>&1 || continue
  front "$chain" -d "$mac" -m conntrack --ctstate NEW -j REJECT
  front "$chain" -d "$mac" -p tcp --dport 53 -j ACCEPT
  front "$chain" -d "$mac" -p udp --dport 53 -j ACCEPT
done
RULES
sudo chmod 755 /usr/local/sbin/block-mac-host
sudo systemctl daemon-reload && sudo systemctl enable --now block-mac-host.service

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
set +x # 등록 토큰을 출력에 남기지 않는다
./config.sh --unattended --url https://github.com/team-pitcrew/gachita --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" --labels gachita --work _work --replace
set -x
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
rm -f /tmp/android-sdk-license
echo "runner-ready $RUNNER_NAME"
