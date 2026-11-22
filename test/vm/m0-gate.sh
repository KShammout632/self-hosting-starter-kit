#!/usr/bin/env bash
# M0 exit gate: the bundled agent answers status requests on a fresh Ubuntu 24.04 VM.
# Run from the repo root on a machine with Multipass. Build the agent first: pnpm build
set -euo pipefail

VM="${VM_NAME:-selfhost-m0}"
NODE_VERSION="${NODE_VERSION:-22.23.3}"
BUNDLE="apps/agent/dist/agent.cjs"

[ -f "$BUNDLE" ] || { echo "Missing $BUNDLE. Run 'pnpm build' first." >&2; exit 1; }
command -v multipass >/dev/null || { echo "Multipass is required." >&2; exit 1; }

multipass delete --purge "$VM" 2>/dev/null || true
multipass launch 24.04 --name "$VM" --cpus 2 --memory 2G --disk 10G

multipass transfer "$BUNDLE" "$VM:/tmp/agent.cjs"
multipass transfer deploy/selfhost-agent.service "$VM:/tmp/selfhost-agent.service"
multipass transfer test/vm/check-agent.mjs "$VM:/tmp/check-agent.mjs"

multipass exec "$VM" -- sudo bash -euxo pipefail -c "
  # Docker here is only so service.status has a daemon to talk to. The real installer comes in M1.
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io curl

  cd /tmp
  base=https://nodejs.org/dist/v${NODE_VERSION}
  tarball=node-v${NODE_VERSION}-linux-x64.tar.xz
  curl -fsSLO \$base/\$tarball
  curl -fsSLO \$base/SHASUMS256.txt
  grep \" \$tarball\\\$\" SHASUMS256.txt | sha256sum -c -
  mkdir -p /opt/selfhost/agent
  tar -xJf \$tarball --strip-components=2 -C /opt/selfhost/agent node-v${NODE_VERSION}-linux-x64/bin/node
  install -m 0644 /tmp/agent.cjs /opt/selfhost/agent/agent.cjs

  groupadd --force selfhost
  install -m 0644 /tmp/selfhost-agent.service /etc/systemd/system/selfhost-agent.service
  systemctl daemon-reload
  systemctl enable --now selfhost-agent.service
  sleep 2
  systemctl is-active selfhost-agent.service
  stat -c '%a %U:%G' /run/selfhost/agent.sock
  /opt/selfhost/agent/node /tmp/check-agent.mjs /run/selfhost/agent.sock
"

echo "M0 gate passed. Remove the VM with: multipass delete --purge $VM"
