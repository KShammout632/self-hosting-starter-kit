#!/usr/bin/env bash
# Builds the release tarball and its checksum from a finished `pnpm build`.
# Usage: package-release.sh <version, for example 1.2.3> <output dir>
set -euo pipefail

VERSION="${1:?Usage: package-release.sh <version> <output dir>}"
OUT="${2:?Usage: package-release.sh <version> <output dir>}"
[[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || {
  echo "Version must look like 1.2.3, got: $VERSION" >&2
  exit 1
}

agent_version="$(node -p 'require("./apps/agent/package.json").version')"
script_version="$(sed -n 's/^KIT_VERSION="\(.*\)"$/\1/p' install.sh)"
[ "$agent_version" = "$VERSION" ] || {
  echo "apps/agent/package.json says $agent_version, not $VERSION." >&2
  exit 1
}
[ "$script_version" = "$VERSION" ] || {
  echo "KIT_VERSION in install.sh says $script_version, not $VERSION." >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bash scripts/make-bundle.sh "$work/bundle"

name="selfhost-kit-${VERSION}-linux-x64.tar.gz"
mkdir -p "$OUT"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$OUT/$name" -C "$work/bundle" .
(cd "$OUT" && sha256sum "$name" >"$name.sha256")
echo "Wrote $OUT/$name and $OUT/$name.sha256"
