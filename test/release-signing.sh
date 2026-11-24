#!/usr/bin/env bash
# Signs a release with a throwaway key and checks that install.sh's verify_release accepts it and
# refuses every kind of tampering. Needs a finished `pnpm build`. Run from the repo root; CI runs it in
# the check job.
set -euo pipefail

fail() {
  echo "SIGNING TEST FAILED: $*" >&2
  exit 1
}

VERSION="$(node -p 'require("./apps/agent/package.json").version')"
NAME="selfhost-kit-$VERSION-linux-x64.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

openssl genpkey -algorithm ed25519 -out "$work/key.pem" 2>/dev/null
openssl genpkey -algorithm ed25519 -out "$work/other.pem" 2>/dev/null
KEY="$(openssl pkey -in "$work/key.pem" -pubout -outform DER | base64 -w0)"
OTHER_KEY="$(openssl pkey -in "$work/other.pem" -pubout -outform DER | base64 -w0)"

SELFHOST_SIGNING_KEY_FILE="$work/key.pem" bash scripts/package-release.sh "$VERSION" "$work/good" >/dev/null

check() { RELEASE_KEY_OVERRIDE="$2" bash scripts/check-release.sh "$1" "$VERSION" >/dev/null 2>&1; }
variant() {
  rm -rf "$work/$1"
  cp -r "$work/good" "$work/$1"
  echo "$work/$1"
}
sign() { openssl pkeyutl -sign -inkey "$1" -rawin -in "$2" | base64 -w0 >"$2.sig"; }

check "$work/good" "$KEY" || fail "a correctly signed release was refused"
echo "ok: a correctly signed release is accepted"

check "$work/good" "$OTHER_KEY" && fail "a release signed by another key was accepted"
echo "ok: a release signed by another key is refused"

check "$work/good" "" && fail "an empty key was accepted"
echo "ok: no key at all is refused"

dir="$(variant tarball)"
printf 'extra' >>"$dir/$NAME"
check "$dir" "$KEY" && fail "a changed tarball was accepted"
echo "ok: a changed tarball is refused"

dir="$(variant checksum)"
(cd "$dir" && sha256sum "$NAME" | sed 's/^./0/' >"$NAME.sha256")
check "$dir" "$KEY" && fail "a changed checksum was accepted"
echo "ok: a changed checksum with the old signature is refused"

dir="$(variant resigned-other)"
printf 'extra' >>"$dir/$NAME"
(cd "$dir" && sha256sum "$NAME" >"$NAME.sha256")
sign "$work/other.pem" "$dir/$NAME.sha256"
check "$dir" "$KEY" && fail "a new tarball signed by another key was accepted"
echo "ok: a replaced tarball and checksum signed by another key are refused"

dir="$(variant other-file)"
(cd "$dir" && printf '%s  other.tar.gz\n' "$(sha256sum "$NAME" | cut -d' ' -f1)" >"$NAME.sha256")
sign "$work/key.pem" "$dir/$NAME.sha256"
check "$dir" "$KEY" && fail "a signed checksum for another file name was accepted"
echo "ok: a signed checksum that names another file is refused"

dir="$(variant two-lines)"
(cd "$dir" && { sha256sum "$NAME"; printf '%s  other.tar.gz\n' "$(printf x | sha256sum | cut -d' ' -f1)"; } >"$NAME.sha256")
sign "$work/key.pem" "$dir/$NAME.sha256"
check "$dir" "$KEY" && fail "a signed checksum file with extra lines was accepted"
echo "ok: a checksum file with extra lines is refused"

dir="$(variant no-signature)"
rm "$dir/$NAME.sha256.sig"
: >"$dir/$NAME.sha256.sig"
check "$dir" "$KEY" && fail "an empty signature was accepted"
echo "ok: an empty signature is refused"

dir="$(variant garbage-signature)"
echo 'not base64 !!!' >"$dir/$NAME.sha256.sig"
check "$dir" "$KEY" && fail "a garbage signature was accepted"
echo "ok: a garbage signature is refused"

cp apps/agent/dist/agent.cjs "$work/agent.cjs.release"
restore_agent() { cp "$work/agent.cjs.release" apps/agent/dist/agent.cjs; }
SELFHOST_TEST_BUILD=1 pnpm --filter @selfhost/agent build >/dev/null 2>&1 || {
  restore_agent
  fail "could not make a test build"
}
if SELFHOST_SIGNING_KEY_FILE="$work/key.pem" bash scripts/package-release.sh "$VERSION" "$work/test-build" >/dev/null 2>&1; then
  restore_agent
  fail "a test build of the agent was packaged as a release"
fi
restore_agent
echo "ok: a test build of the agent cannot be packaged as a release"

echo "SIGNING TEST PASSED"
