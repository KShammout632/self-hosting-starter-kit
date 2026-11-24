#!/usr/bin/env bash
# Checks a packaged release the same way install.sh does, using install.sh's own verify_release and
# its built-in public key. The release workflow runs it so a signing secret that does not match the
# public key fails the release instead of every install.
# Usage (from the repo root): check-release.sh <dir> <version>
# RELEASE_KEY_OVERRIDE replaces the key, for test/release-signing.sh only.
set -euo pipefail

DIR="${1:?Usage: check-release.sh <dir> <version>}"
VERSION="${2:?Usage: check-release.sh <dir> <version>}"

die() {
  echo "Release check failed: $*" >&2
  exit 1
}
eval "$(sed -n '/^RELEASE_PUBLIC_KEY=/p; /^verify_release() {$/,/^}$/p' install.sh)"
[ "$(type -t verify_release)" = function ] || die "verify_release was not found in install.sh"
[ -z "${RELEASE_KEY_OVERRIDE+set}" ] || RELEASE_PUBLIC_KEY="$RELEASE_KEY_OVERRIDE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="selfhost-kit-${VERSION}-linux-x64.tar.gz"
cp "$DIR/$name" "$DIR/$name.sha256" "$DIR/$name.sha256.sig" "$work/"
verify_release "$work" "$name"
echo "Release $VERSION is signed and matches its checksum."
