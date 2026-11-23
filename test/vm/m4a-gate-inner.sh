#!/usr/bin/env bash
# M4a gate, the part that runs as root on a fresh Ubuntu 24.04 machine: install the kit, then
# install Navidrome, Immich and Nextcloud and prove each one does real work (music found, photo
# stored, file uploaded). Used by CI.
# Usage: sudo bash m4a-gate-inner.sh <bundle dir from scripts/make-bundle.sh>
set -euo pipefail

BUNDLE="${1:?Usage: m4a-gate-inner.sh <bundle dir>}"
NAVIDROME=http://127.0.0.1:4533
IMMICH=http://127.0.0.1:2283
NEXTCLOUD=http://127.0.0.1:8081

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
trap 'for s in navidrome immich nextcloud; do echo "----- $s"; selfhost logs "$s" --tail 40 || true; done; docker ps -a || true' ERR

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

step "Add a test song and a test photo"
music_dir="/srv/media/music/Gate Artist/Gate Album"
mkdir -p "$music_dir"
ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=3 -c:a libmp3lame \
  -metadata artist="Gate Artist" -metadata album="Gate Album" -metadata title="Gate Song" \
  "$music_dir/01 Gate Song.mp3"
chown -R selfhost:selfhost /srv/media/music
photo=/tmp/gate-photo.jpg
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=1:size=640x480:rate=1 -frames:v 1 "$photo"

step "Navidrome: install, create the admin account, find the song"
selfhost install navidrome
nav_ping() { [ "$(curl -fsS "$NAVIDROME/ping")" != "" ]; }
wait_for 90 "Navidrome to answer" nav_ping
curl -fsS -X POST "$NAVIDROME/auth/createAdmin" -H 'Content-Type: application/json' \
  -d '{"username":"gate","password":"gate-password-1"}' >/dev/null
nav_artists() {
  curl -fsS -G "$NAVIDROME/rest/getArtists" \
    --data-urlencode u=gate --data-urlencode p=gate-password-1 \
    --data-urlencode v=1.16.1 --data-urlencode c=gate --data-urlencode f=json |
    jq -e '[.["subsonic-response"].artists.index[]?.artist[]?] | length >= 1'
}
curl -fsS -G "$NAVIDROME/rest/startScan" --data-urlencode u=gate --data-urlencode p=gate-password-1 \
  --data-urlencode v=1.16.1 --data-urlencode c=gate --data-urlencode f=json >/dev/null
wait_for 120 "Navidrome to find the song" nav_artists
selfhost status navidrome | grep -q "is running" || fail "Navidrome is not running"

step "Immich: install, create the admin account, upload a photo"
selfhost install immich
immich_ping() { [ "$(curl -fsS "$IMMICH/api/server/ping" | jq -r .res)" = "pong" ]; }
wait_for 180 "Immich to answer" immich_ping
curl -fsS -X POST "$IMMICH/api/auth/admin-sign-up" -H 'Content-Type: application/json' \
  -d '{"email":"gate@example.com","password":"gate-password-1","name":"Gate"}' >/dev/null
token="$(curl -fsS -X POST "$IMMICH/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"gate@example.com","password":"gate-password-1"}' | jq -r .accessToken)"
[ -n "$token" ] && [ "$token" != "null" ] || fail "could not sign in to Immich"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
curl -fsS -X POST "$IMMICH/api/assets" -H "Authorization: Bearer $token" \
  -F deviceAssetId=gate-1 -F deviceId=gate -F fileCreatedAt="$now" -F fileModifiedAt="$now" \
  -F assetData=@"$photo" >/dev/null
immich_photos() {
  [ "$(curl -fsS "$IMMICH/api/server/statistics" -H "Authorization: Bearer $token" | jq .photos)" -ge 1 ]
}
wait_for 60 "Immich to count the photo" immich_photos
[ -n "$(find /srv/photos -type f -name '*.jpg' | head -n 1)" ] || fail "the photo is not in /srv/photos"
selfhost status immich | grep -q "is running" || fail "Immich is not running"

step "Nextcloud: install, wait for first-run setup, read the login once, upload a file"
selfhost install nextcloud
nc_ready() { curl -fsS "$NEXTCLOUD/status.php" | jq -e '.installed == true'; }
wait_for 300 "Nextcloud to finish setting itself up" nc_ready

reply="$(call '{"action":"service.credentials","service":"nextcloud"}')"
echo "$reply" | jq -e '.ok == true' >/dev/null || fail "could not read the Nextcloud login"
admin_user="$(echo "$reply" | jq -r '.data.credentials[] | select(.label == "Admin user name") | .value')"
admin_pass="$(echo "$reply" | jq -r '.data.credentials[] | select(.label == "Admin password") | .value')"
[ "$admin_user" = "admin" ] && [ "${#admin_pass}" -ge 32 ] || fail "unexpected Nextcloud login"
call '{"action":"service.credentials","service":"nextcloud"}' |
  jq -e '.ok == false and .error.code == "refused"' >/dev/null || fail "the login was shown twice"
call '{"action":"service.status","service":"nextcloud"}' |
  jq -e '.data.credentialsPending == false' >/dev/null || fail "status still says the login is pending"

curl -fsS -u "admin:$admin_pass" -H 'OCS-APIRequest: true' \
  "$NEXTCLOUD/ocs/v1.php/cloud/user?format=json" | jq -e '.ocs.data.id == "admin"' >/dev/null ||
  fail "the admin login does not work"
echo "hello from the gate" >/tmp/gate-note.txt
code="$(curl -sS -o /dev/null -w '%{http_code}' -u "admin:$admin_pass" -T /tmp/gate-note.txt \
  "$NEXTCLOUD/remote.php/dav/files/admin/gate-note.txt")"
[ "$code" = "201" ] || fail "upload returned HTTP $code"
[ -f /srv/nextcloud/admin/files/gate-note.txt ] || fail "the file is not in /srv/nextcloud"
selfhost status nextcloud | grep -q "is running" || fail "Nextcloud is not running"

step "Every service reports healthy to the agent, with every container up"
for service in navidrome immich nextcloud; do
  reply="$(call "{\"action\":\"service.status\",\"service\":\"$service\"}")"
  echo "$reply" | jq -e '.data.state == "running" and .data.http.ok == true' >/dev/null ||
    fail "$service is not healthy: $reply"
done

step "Secrets are private and never in the compose files"
for service in immich nextcloud; do
  [ "$(stat -c '%a %U' "/opt/selfhost/config/$service/.env")" = "600 root" ] ||
    fail "$service .env permissions are wrong"
done
db_password="$(grep '^DB_PASSWORD=' /opt/selfhost/config/immich/.env | cut -d= -f2)"
! grep -rq "$db_password" /opt/selfhost/services || fail "a password is in a compose file"
! grep -rq "$admin_pass" /opt/selfhost/services || fail "a password is in a compose file"

step "A second install keeps the same secrets"
before="$(sha256sum /opt/selfhost/config/immich/.env /opt/selfhost/config/nextcloud/.env)"
selfhost install immich
after="$(sha256sum /opt/selfhost/config/immich/.env /opt/selfhost/config/nextcloud/.env)"
[ "$before" = "$after" ] || fail "secrets changed on a second install"
wait_for 180 "Immich to answer again" immich_ping

step "Stop and start Nextcloud, then remove all three, keeping media"
selfhost stop nextcloud
selfhost status nextcloud | grep -q "is stopped" || fail "Nextcloud did not stop"
selfhost start nextcloud
wait_for 180 "Nextcloud to answer again" nc_ready
for service in navidrome immich nextcloud; do selfhost uninstall "$service"; done
[ -f "$music_dir/01 Gate Song.mp3" ] || fail "uninstall removed the music"
[ -f /srv/nextcloud/admin/files/gate-note.txt ] || fail "uninstall removed the Nextcloud files"

echo
echo "M4a gate passed."
