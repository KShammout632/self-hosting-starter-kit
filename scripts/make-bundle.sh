#!/usr/bin/env bash
# Collects the files install.sh installs into one folder. Run from the repo root after `pnpm build`.
# The release workflow will tar this folder; the install tests use it directly.
set -euo pipefail

OUT="${1:?Usage: make-bundle.sh <output dir>}"
[ -f apps/agent/dist/agent.cjs ] || { echo "Missing apps/agent/dist/agent.cjs. Run 'pnpm build' first." >&2; exit 1; }

mkdir -p "$OUT"
install -m 0644 apps/agent/dist/agent.cjs "$OUT/agent.cjs"
install -m 0644 deploy/selfhost-agent.service "$OUT/selfhost-agent.service"
install -m 0644 deploy/selfhost-cli.mjs "$OUT/selfhost-cli.mjs"
install -m 0755 install.sh "$OUT/install.sh"
install -m 0755 uninstall.sh "$OUT/uninstall.sh"
echo "Bundle written to $OUT"
