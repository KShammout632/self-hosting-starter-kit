#!/usr/bin/env bash
# M0 exit gate on a local Multipass VM. CI runs the same checks on a GitHub runner, see
# .github/workflows/ci.yml. Run from the repo root after building: pnpm build
set -euo pipefail

VM="${VM_NAME:-selfhost-m0}"
BUNDLE="apps/agent/dist/agent.cjs"

[ -f "$BUNDLE" ] || { echo "Missing $BUNDLE. Run 'pnpm build' first." >&2; exit 1; }
command -v multipass >/dev/null || { echo "Multipass is required." >&2; exit 1; }

multipass delete --purge "$VM" 2>/dev/null || true
multipass launch 24.04 --name "$VM" --cpus 2 --memory 2G --disk 10G

multipass exec "$VM" -- mkdir -p /tmp/gate
multipass transfer "$BUNDLE" "$VM:/tmp/gate/agent.cjs"
multipass transfer deploy/selfhost-agent.service "$VM:/tmp/gate/selfhost-agent.service"
multipass transfer test/vm/check-agent.mjs "$VM:/tmp/gate/check-agent.mjs"
multipass transfer test/vm/m0-gate-inner.sh "$VM:/tmp/gate/m0-gate-inner.sh"

multipass exec "$VM" -- sudo bash /tmp/gate/m0-gate-inner.sh /tmp/gate

echo "Remove the VM with: multipass delete --purge $VM"
