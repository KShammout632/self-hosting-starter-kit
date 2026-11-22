#!/usr/bin/env bash
# Collects the files install.sh installs into one folder. Run from the repo root after `pnpm build`.
# The release workflow will tar this folder; the install tests use it directly.
set -euo pipefail

OUT="${1:?Usage: make-bundle.sh <output dir>}"
for file in apps/agent/dist/agent.cjs apps/api/dist/api.js apps/web/dist/index.html; do
  [ -f "$file" ] || { echo "Missing $file. Run 'pnpm build' first." >&2; exit 1; }
done

mkdir -p "$OUT/dashboard"
install -m 0644 apps/agent/dist/agent.cjs "$OUT/agent.cjs"
install -m 0644 deploy/selfhost-agent.service "$OUT/selfhost-agent.service"
install -m 0644 deploy/selfhost-cli.mjs "$OUT/selfhost-cli.mjs"
install -m 0755 install.sh "$OUT/install.sh"
install -m 0755 uninstall.sh "$OUT/uninstall.sh"

install -m 0644 apps/api/dist/api.js "$OUT/dashboard/api.js"
install -m 0644 deploy/dashboard.Dockerfile "$OUT/dashboard/Dockerfile"
install -m 0644 deploy/dashboard.compose.yml "$OUT/dashboard/compose.yml"
rm -rf "$OUT/dashboard/web"
cp -r apps/web/dist "$OUT/dashboard/web"

# The image installs only the native modules the API bundle leaves out, at the versions the API pins.
node -e '
const api = require("./apps/api/package.json").dependencies;
const pick = (name) => api[name].replace(/^[\^~]/, "");
const pkg = {
  name: "selfhost-dashboard",
  private: true,
  dependencies: { "better-sqlite3": pick("better-sqlite3"), "@node-rs/argon2": pick("@node-rs/argon2") },
};
require("fs").writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2) + "\n");
' "$OUT/dashboard/package.json"

echo "Bundle written to $OUT"
