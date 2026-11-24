#!/usr/bin/env bash
# Builds the release tarball, its checksum and the checksum's signature from a finished `pnpm build`.
# Usage: SELFHOST_SIGNING_KEY_FILE=<private key> package-release.sh <version, for example 1.2.3> <output dir>
set -euo pipefail

KEY_FILE="${SELFHOST_SIGNING_KEY_FILE:?Set SELFHOST_SIGNING_KEY_FILE to the release signing key.}"
[ -s "$KEY_FILE" ] || {
  echo "The signing key file $KEY_FILE is missing or empty." >&2
  exit 1
}

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
openssl pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$OUT/$name.sha256" | base64 -w0 >"$OUT/$name.sha256.sig"
echo >>"$OUT/$name.sha256.sig"
echo "Wrote $OUT/$name, $OUT/$name.sha256 and $OUT/$name.sha256.sig"
