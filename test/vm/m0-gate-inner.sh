#!/usr/bin/env bash
# M0 exit gate, the part that runs as root on Ubuntu 24.04: install the bundled agent as a systemd
# service and check that it answers status requests. Used by m0-gate.sh (Multipass) and by CI.
# Usage: sudo bash m0-gate-inner.sh <dir containing agent.cjs, selfhost-agent.service, check-agent.mjs>
set -euo pipefail

SRC="${1:?Usage: m0-gate-inner.sh <dir>}"
NODE_VERSION="${NODE_VERSION:-22.23.3}"
INSTALL_DIR=/opt/selfhost/agent

trap 'journalctl -u selfhost-agent.service --no-pager -n 50 || true' ERR

# Docker is only here so service.status has a daemon to talk to. The real installer comes in M1.
if ! command -v docker >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io curl
fi
systemctl enable --now docker

work="$(mktemp -d)"
cd "$work"
base="https://nodejs.org/dist/v${NODE_VERSION}"
tarball="node-v${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "$base/$tarball"
curl -fsSLO "$base/SHASUMS256.txt"
grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -

mkdir -p "$INSTALL_DIR"
tar -xJf "$tarball" --strip-components=2 -C "$INSTALL_DIR" "node-v${NODE_VERSION}-linux-x64/bin/node"
install -m 0644 "$SRC/agent.cjs" "$INSTALL_DIR/agent.cjs"

groupadd --force selfhost
install -m 0644 "$SRC/selfhost-agent.service" /etc/systemd/system/selfhost-agent.service
systemctl daemon-reload
systemctl enable --now selfhost-agent.service

for _ in $(seq 1 20); do
  [ -S /run/selfhost/agent.sock ] && break
  sleep 0.5
done

systemctl is-active selfhost-agent.service
perms="$(stat -c '%a %U:%G' /run/selfhost/agent.sock)"
echo "Socket permissions: $perms"
[ "$perms" = "660 root:selfhost" ] || { echo "Expected 660 root:selfhost" >&2; exit 1; }

"$INSTALL_DIR/node" "$SRC/check-agent.mjs" /run/selfhost/agent.sock
echo "M0 gate passed."
