#!/usr/bin/env bash
# M5a gate, the part that runs as root on a fresh Ubuntu 24.04 machine: update a service from an
# older version (data survives), then make an Immich update fail on purpose and check the saved
# copy, including the database, is put back. Used by CI.
# Usage: sudo bash m5a-gate-inner.sh <bundle dir from scripts/make-bundle.sh>
set -euo pipefail

BUNDLE="${1:?Usage: m5a-gate-inner.sh <bundle dir>}"
NAVIDROME=http://127.0.0.1:4533
IMMICH=http://127.0.0.1:2283
OLD_NAVIDROME=0.53.3

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
unblock() { iptables -D OUTPUT -p tcp --dport 2283 -j DROP 2>/dev/null || true; }
trap 'unblock; for s in navidrome immich; do echo "----- $s"; selfhost logs "$s" --tail 40 || true; done; docker ps -a || true' ERR
trap unblock EXIT

call() {
  local node=/opt/selfhost/agent/node
  [ -x "$node" ] || node="$(command -v node)"
  "$node" "$BUNDLE/agent-call.mjs" "$1"
}

wait_for() {
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  fail "timed out waiting for $what"
}

step "Run the installer"
export SELFHOST_BUNDLE_DIR="$BUNDLE" SELFHOST_SKIP_RESOURCE_CHECKS=1
bash "$BUNDLE/install.sh"
apt-get install -y -qq ffmpeg >/dev/null

# Part 1: a real update. Navidrome is moved back to an older release first, as if the server had
# been installed by an earlier version of the kit.
step "Navidrome: install, then move it back to $OLD_NAVIDROME"
selfhost install navidrome
selfhost stop navidrome
compose=/opt/selfhost/services/navidrome/compose.yml
sed -i -E "s#^( *image: )deluan/navidrome:[^ ]+#\1deluan/navidrome:$OLD_NAVIDROME#" "$compose"
grep -q "deluan/navidrome:$OLD_NAVIDROME\$" "$compose" || fail "could not make the compose file old"
echo "$OLD_NAVIDROME" >/opt/selfhost/services/navidrome/version
selfhost start navidrome
nav_ping() { [ "$(curl -fsS "$NAVIDROME/ping")" != "" ]; }
wait_for 120 "old Navidrome to answer" nav_ping
curl -fsS -X POST "$NAVIDROME/auth/createAdmin" -H 'Content-Type: application/json' \
  -d '{"username":"gate","password":"gate-password-1"}' >/dev/null
nav_login() {
  curl -fsS -G "$NAVIDROME/rest/ping" --data-urlencode u=gate --data-urlencode p=gate-password-1 \
    --data-urlencode v=1.16.1 --data-urlencode c=gate --data-urlencode f=json |
    jq -e '.["subsonic-response"].status == "ok"'
}
wait_for 30 "the old version to accept the login" nav_login

step "Navidrome: the old version is reported as updatable"
call '{"action":"service.status","service":"navidrome"}' |
  jq -e ".data.update.available == true and .data.update.installedVersion == \"$OLD_NAVIDROME\"" \
    >/dev/null || fail "no update was offered"

step "Navidrome: update, keeping the account"
call '{"action":"service.update","service":"navidrome"}' | jq -e '.ok == true' >/dev/null ||
  fail "the update failed"
wait_for 60 "Navidrome to answer after the update" nav_ping
wait_for 30 "the account to survive the update" nav_login
call '{"action":"service.status","service":"navidrome"}' |
  jq -e '.data.update.available == false and .data.update.installedVersion == "0.64.2"' \
    >/dev/null || fail "the update was not recorded"
grep -q 'deluan/navidrome:0.64.2@sha256:' "$compose" || fail "the new image is not pinned by digest"

step "Navidrome: a private saved copy was made first"
backups=/opt/selfhost/backups
[ "$(stat -c '%a %U' "$backups")" = "700 root" ] || fail "the backups folder is not private"
snapshot="$(find "$backups/navidrome" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$snapshot" ] || fail "no saved copy was made"
for file in compose.yml config.tar version; do
  [ -s "$snapshot/$file" ] || fail "the saved copy has no $file"
done
grep -q "deluan/navidrome:$OLD_NAVIDROME\$" "$snapshot/compose.yml" ||
  fail "the saved copy is not of the old version"
tar -tf "$snapshot/config.tar" | grep -q 'navidrome.db' || fail "the saved copy has no database"

step "Three more updates keep only the newest three saved copies"
for _ in 1 2 3; do
  call '{"action":"service.update","service":"navidrome"}' | jq -e '.ok == true' >/dev/null ||
    fail "a repeat update failed"
  sleep 1
done
[ "$(find "$backups/navidrome" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 3 ] ||
  fail "old saved copies were not removed"
selfhost uninstall navidrome

# Part 2: an update that does not come up healthy. The block hides Immich from the agent's health
# check only, so the new version looks dead and the agent must put the old one back, database
# included.
step "Immich: install, create the admin account, upload a photo"
photo=/tmp/gate-photo.jpg
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=1:size=640x480:rate=1 -frames:v 1 "$photo"
selfhost install immich
immich_ping() { [ "$(curl -fsS "$IMMICH/api/server/ping" | jq -r .res)" = "pong" ]; }
wait_for 180 "Immich to answer" immich_ping
curl -fsS -X POST "$IMMICH/api/auth/admin-sign-up" -H 'Content-Type: application/json' \
  -d '{"email":"gate@example.com","password":"gate-password-1","name":"Gate"}' >/dev/null
immich_token() {
  curl -fsS -X POST "$IMMICH/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"gate@example.com","password":"gate-password-1"}' | jq -r .accessToken
}
token="$(immich_token)"
[ -n "$token" ] && [ "$token" != "null" ] || fail "could not sign in to Immich"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
curl -fsS -X POST "$IMMICH/api/assets" -H "Authorization: Bearer $token" \
  -F deviceAssetId=gate-1 -F deviceId=gate -F fileCreatedAt="$now" -F fileModifiedAt="$now" \
  -F assetData=@"$photo" >/dev/null
immich_photos() {
  [ "$(curl -fsS "$IMMICH/api/server/statistics" -H "Authorization: Bearer $(immich_token)" | jq .photos)" -ge 1 ]
}
wait_for 60 "Immich to count the photo" immich_photos

step "Immich: an update that never becomes healthy is rolled back (takes about six minutes)"
iptables -I OUTPUT -p tcp --dport 2283 -j DROP
reply="$(call '{"action":"service.update","service":"immich"}')"
unblock
echo "$reply" | jq -e '.ok == false and .error.code == "rolled_back"' >/dev/null ||
  fail "the update was not rolled back: $reply"

step "Immich: after the rollback the account and the photo are still there"
wait_for 180 "Immich to answer after the rollback" immich_ping
token="$(immich_token)"
[ -n "$token" ] && [ "$token" != "null" ] || fail "the Immich account was lost in the rollback"
wait_for 60 "the photo to survive the rollback" immich_photos
call '{"action":"service.status","service":"immich"}' |
  jq -e '.data.state == "running" and .data.http.ok == true' >/dev/null ||
  fail "Immich is not healthy after the rollback"
dump="$(find "$backups/immich" -name database.sql | head -n 1)"
[ -s "$dump" ] || fail "no database copy was saved"
[ "$(stat -c '%a' "$backups/immich")" = "700" ] || fail "the Immich saved copies are not private"

step "Remove Immich, keeping media"
selfhost uninstall immich
[ -n "$(find /srv/photos -type f -name '*.jpg' | head -n 1)" ] || fail "uninstall removed the photo"

echo
echo "M5a gate passed."
