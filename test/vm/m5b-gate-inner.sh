#!/usr/bin/env bash
# M5b gate, the part that runs as root on a fresh Ubuntu 24.04 machine: install the old kit, update
# it to a newer release served from this machine, and check that services keep running, that a bad
# download is refused, and that a new version which does not start is rolled back. Used by CI.
#
# Both builds must be made with SELFHOST_TEST_BUILD=1, which is the only way the agent accepts a
# release address on this machine and a signing key other than the built-in one.
# Usage: sudo bash m5b-gate-inner.sh <old bundle dir> <serve dir> <new version> <signing key file>
#   <serve dir>/v<new version>/ holds the new release tarball, its .sha256 file and the signature,
#   made by scripts/package-release.sh with <signing key file>.
set -euo pipefail

OLD_BUNDLE="${1:?Usage: m5b-gate-inner.sh <old bundle dir> <serve dir> <new version> <signing key file>}"
SERVE="${2:?}"
NEW="${3:?}"
SIGNING_KEY="${4:?}"
PORT=8099
STATUS=/var/lib/selfhost/kit-update.json
NAVIDROME=http://127.0.0.1:4533

IFS=. read -r MAJOR MINOR PATCH <<<"$NEW"
BAD_CHECKSUM="$MAJOR.$MINOR.$((PATCH + 1))"
BROKEN="$MAJOR.$MINOR.$((PATCH + 2))"
WRONG_INSIDE="$MAJOR.$MINOR.$((PATCH + 3))"
OTHER_SIGNER="$MAJOR.$MINOR.$((PATCH + 4))"
UNSIGNED="$MAJOR.$MINOR.$((PATCH + 5))"
PUBLIC_KEY="$(openssl pkey -in "$SIGNING_KEY" -pubout -outform DER | base64 -w0)"

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
trap 'echo "----- status file"; cat "$STATUS" 2>/dev/null || true; journalctl -u selfhost-kit-update --no-pager -n 60 || true; journalctl -u selfhost-agent --no-pager -n 30 || true; docker ps -a || true' ERR
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true' EXIT

call() { /opt/selfhost/agent/node "$OLD_BUNDLE/agent-call.mjs" "$1"; }
agent_version() { call '{"action":"agent.version"}' | jq -r .data.version; }

wait_for() {
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  fail "timed out waiting for $what"
}
status_is() { [ "$(jq -r .state "$STATUS" 2>/dev/null)" = "$1" ]; }
dashboard_up() { curl -fsS --max-time 3 http://127.0.0.1:8080/api/health; }

step "Install the old kit"
export SELFHOST_BUNDLE_DIR="$OLD_BUNDLE" SELFHOST_SKIP_RESOURCE_CHECKS=1
bash "$OLD_BUNDLE/install.sh"
OLD="$(agent_version)"
[ "$OLD" != "$NEW" ] || fail "the old and new versions are both $OLD"

step "Let the agent download from this machine"
mkdir -p /etc/systemd/system/selfhost-agent.service.d
printf '[Service]\nEnvironment=SELFHOST_RELEASE_BASE=http://127.0.0.1:%s\nEnvironment=SELFHOST_RELEASE_KEY=%s\n' \
  "$PORT" "$PUBLIC_KEY" >/etc/systemd/system/selfhost-agent.service.d/test-release.conf
systemctl daemon-reload
systemctl restart selfhost-agent
agent_is_old() { [ "$(agent_version)" = "$OLD" ]; }
wait_for 20 "the agent" agent_is_old

step "Make the release variants"
NAME="selfhost-kit-$NEW-linux-x64.tar.gz"
[ -f "$SERVE/v$NEW/$NAME" ] || fail "missing $SERVE/v$NEW/$NAME"

mkdir -p "$SERVE/v$BAD_CHECKSUM"
cp "$SERVE/v$NEW/$NAME" "$SERVE/v$BAD_CHECKSUM/selfhost-kit-$BAD_CHECKSUM-linux-x64.tar.gz"
printf '%s  %s\n' "$(printf 'x' | sha256sum | cut -d' ' -f1)" "selfhost-kit-$BAD_CHECKSUM-linux-x64.tar.gz" \
  >"$SERVE/v$BAD_CHECKSUM/selfhost-kit-$BAD_CHECKSUM-linux-x64.tar.gz.sha256"
sign() { openssl pkeyutl -sign -inkey "$1" -rawin -in "$2" | base64 -w0 >"$2.sig"; }
sign "$SIGNING_KEY" "$SERVE/v$BAD_CHECKSUM/selfhost-kit-$BAD_CHECKSUM-linux-x64.tar.gz.sha256"

repack() {
  local version="$1" inner_version="$2" break_agent="$3" signer="${4:-good}"
  local work name
  work="$(mktemp -d)"
  openssl genpkey -algorithm ed25519 -out "$work/other.pem" 2>/dev/null
  name="selfhost-kit-$version-linux-x64.tar.gz"
  mkdir "$work/bundle"
  tar -xzf "$SERVE/v$NEW/$NAME" -C "$work/bundle"
  printf '%s' "$inner_version" >"$work/bundle/VERSION"
  [ "$break_agent" = yes ] && echo 'process.exit(1)' >"$work/bundle/agent.cjs"
  mkdir -p "$SERVE/v$version"
  tar -czf "$SERVE/v$version/$name" -C "$work/bundle" .
  (cd "$SERVE/v$version" && sha256sum "$name" >"$name.sha256")
  case "$signer" in
    good) sign "$SIGNING_KEY" "$SERVE/v$version/$name.sha256" ;;
    other) sign "$work/other.pem" "$SERVE/v$version/$name.sha256" ;;
  esac
  rm -rf "$work"
}
repack "$BROKEN" "$BROKEN" yes
repack "$WRONG_INSIDE" "$NEW" no
repack "$OTHER_SIGNER" "$OTHER_SIGNER" no other
repack "$UNSIGNED" "$UNSIGNED" no none

(cd "$SERVE" && exec python3 -m http.server "$PORT" --bind 127.0.0.1) >/dev/null 2>&1 &
SERVER_PID=$!
wait_for 15 "the release server" curl -fsS "http://127.0.0.1:$PORT/v$NEW/$NAME.sha256"

step "Install Navidrome so there is something to keep running"
call '{"action":"service.install","service":"navidrome"}' | jq -e '.ok == true' >/dev/null
wait_for 60 "Navidrome" curl -fsS "$NAVIDROME/ping"
echo kept >/opt/selfhost/config/navidrome/gate-marker
echo kept >/var/lib/selfhost/gate-marker
STARTED_BEFORE="$(docker inspect --format '{{.State.StartedAt}}' selfhost-navidrome)"

step "Refuses the same version, an older one, and an address in the request"
call "{\"action\":\"kit.update\",\"version\":\"$OLD\"}" | jq -e '.ok == false and .error.code == "refused"' >/dev/null
call '{"action":"kit.update","version":"0.0.1"}' | jq -e '.ok == false and .error.code == "refused"' >/dev/null
call "{\"action\":\"kit.update\",\"version\":\"$NEW\",\"url\":\"http://127.0.0.1:1\"}" |
  jq -e '.ok == false and .error.code == "invalid_request"' >/dev/null

step "A download that fails its checksum is not installed"
call "{\"action\":\"kit.update\",\"version\":\"$BAD_CHECKSUM\"}" | jq -e '.ok == false and .error.code == "failed"' >/dev/null
[ "$(agent_version)" = "$OLD" ] || fail "the agent changed after a bad checksum"

step "A release signed by another key, or not signed at all, is not installed"
for version in "$OTHER_SIGNER" "$UNSIGNED"; do
  call "{\"action\":\"kit.update\",\"version\":\"$version\"}" | jq -e '.ok == false and .error.code == "failed"' >/dev/null
  [ "$(agent_version)" = "$OLD" ] || fail "the agent changed after a badly signed release ($version)"
  [ ! -e "/opt/selfhost/releases/$version" ] || fail "the badly signed release $version was left on disk"
done

step "A release that is not the version it says is not installed"
call "{\"action\":\"kit.update\",\"version\":\"$WRONG_INSIDE\"}" | jq -e '.ok == false and .error.code == "failed"' >/dev/null
[ "$(agent_version)" = "$OLD" ] || fail "the agent changed after a wrong version"

step "Update to $NEW"
call "{\"action\":\"kit.update\",\"version\":\"$NEW\"}" | jq -e '.ok == true and .data.started == true' >/dev/null
wait_for 150 "the update to finish" status_is done
[ "$(agent_version)" = "$NEW" ] || fail "the agent is not on $NEW"
dashboard_up | jq -e '.ok == true' >/dev/null
[ "$(cat /opt/selfhost/releases/previous/VERSION)" = "$OLD" ] || fail "the old version was not kept"
[ ! -e "/opt/selfhost/releases/$NEW" ] || fail "the downloaded release was not cleaned up"

step "Services, settings and data were not touched"
curl -fsS "$NAVIDROME/ping" >/dev/null
[ "$(docker inspect --format '{{.State.StartedAt}}' selfhost-navidrome)" = "$STARTED_BEFORE" ] ||
  fail "Navidrome was restarted by the kit update"
[ "$(cat /opt/selfhost/config/navidrome/gate-marker)" = kept ] || fail "service data changed"
[ "$(cat /var/lib/selfhost/gate-marker)" = kept ] || fail "dashboard data changed"
[ -f /var/lib/selfhost/selfhost.db ] || fail "the dashboard database is gone"

step "A new version that does not start is rolled back"
call "{\"action\":\"kit.update\",\"version\":\"$BROKEN\"}" | jq -e '.ok == true' >/dev/null
wait_for 150 "the rollback" status_is rolled_back
[ "$(agent_version)" = "$NEW" ] || fail "the agent is not back on $NEW"
dashboard_up | jq -e '.ok == true' >/dev/null
curl -fsS "$NAVIDROME/ping" >/dev/null

step "System updates can be checked, and a restart needs a confirmation"
call '{"action":"system.updates.check","refresh":true}' |
  jq -e '.ok == true and (.data.packages | type == "number") and (.data.rebootRequired | type == "boolean")' >/dev/null
call '{"action":"system.reboot"}' | jq -e '.ok == false and .error.code == "confirm_required"' >/dev/null

printf '\nGATE PASSED: kit %s updated to %s, bad checksums and signatures refused, broken release rolled back\n' "$OLD" "$NEW"
