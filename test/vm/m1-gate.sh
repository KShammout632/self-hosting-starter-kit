#!/usr/bin/env bash
# M1 exit gate on a local Multipass VM. CI runs the same checks on a GitHub runner, see
# .github/workflows/ci.yml. Run from the repo root after building: pnpm build
set -euo pipefail

VM="${VM_NAME:-selfhost-m1}"
BUNDLE="$(mktemp -d)"

command -v multipass >/dev/null || { echo "Multipass is required." >&2; exit 1; }
bash scripts/make-bundle.sh "$BUNDLE"
cp test/vm/m1-gate-inner.sh "$BUNDLE/m1-gate-inner.sh"

multipass delete --purge "$VM" 2>/dev/null || true
multipass launch 24.04 --name "$VM" --cpus 2 --memory 4G --disk 30G
multipass transfer --recursive "$BUNDLE" "$VM:/tmp/bundle"

multipass exec "$VM" -- sudo bash /tmp/bundle/m1-gate-inner.sh /tmp/bundle

echo "Remove the VM with: multipass delete --purge $VM"
