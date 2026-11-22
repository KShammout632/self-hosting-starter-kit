#!/usr/bin/env bash
# M1 exit gate, the part that runs as root on a fresh Ubuntu 24.04 machine: run the installer twice,
# install Jellyfin with the selfhost command, add a test video, and check Jellyfin indexes it and
# serves it. Used by m1-gate.sh (Multipass) and by CI.
# Usage: sudo bash m1-gate-inner.sh <bundle dir from scripts/make-bundle.sh>
set -euo pipefail

BUNDLE="${1:?Usage: m1-gate-inner.sh <bundle dir>}"
JELLYFIN=http://127.0.0.1:8096
AUTH='MediaBrowser Client="gate", Device="gate", DeviceId="gate-1", Version="1"'

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
trap 'journalctl -u selfhost-agent.service --no-pager -n 40 || true; selfhost logs jellyfin --tail 60 || true' ERR

wait_for() {
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "timed out waiting for $what"
}

jellyfin_healthy() { [ "$(curl -fsS "$JELLYFIN/health")" = "Healthy" ]; }

step "Run the installer, then run it again to prove it is safe to repeat"
export SELFHOST_BUNDLE_DIR="$BUNDLE" SELFHOST_SKIP_RESOURCE_CHECKS=1
bash "$BUNDLE/install.sh"
bash "$BUNDLE/install.sh"

step "Check what the installer set up"
docker compose version
command -v tailscale >/dev/null || fail "Tailscale is not installed"
id selfhost >/dev/null
for dir in /srv/media/movies /srv/media/tv /srv/media/home-videos /srv/media/music /srv/photos /srv/nextcloud \
  /opt/selfhost/services /opt/selfhost/config /opt/selfhost/backups /var/lib/selfhost; do
  [ -d "$dir" ] || fail "missing folder $dir"
done
systemctl is-active selfhost-agent.service
perms="$(stat -c '%a %U:%G' /run/selfhost/agent.sock)"
[ "$perms" = "660 root:selfhost" ] || fail "agent socket permissions are $perms"
ufw status | grep -q "Status: active" || fail "firewall is not active"
selfhost version

step "Add a short test video to the movies folder"
apt-get install -y -qq ffmpeg >/dev/null
movie_dir="/srv/media/movies/Test Movie (2026)"
mkdir -p "$movie_dir"
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=5:size=320x240:rate=15 \
  -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  "$movie_dir/Test Movie (2026).mp4"
chown -R selfhost:selfhost "$movie_dir"

step "Install Jellyfin with the selfhost command"
selfhost install jellyfin
wait_for 180 "Jellyfin to report healthy" jellyfin_healthy
selfhost status jellyfin | grep -q "is running" || fail "selfhost status does not say Jellyfin is running"

step "Create a Jellyfin admin account and a Movies library, the way a person would in the wizard"
curl -fsS -X POST "$JELLYFIN/Startup/Configuration" -H 'Content-Type: application/json' \
  -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
curl -fsS "$JELLYFIN/Startup/User" >/dev/null
curl -fsS -X POST "$JELLYFIN/Startup/User" -H 'Content-Type: application/json' \
  -d '{"Name":"gate","Password":"gate-password-1"}'
curl -fsS -X POST "$JELLYFIN/Startup/Complete"
token="$(curl -fsS -X POST "$JELLYFIN/Users/AuthenticateByName" \
  -H 'Content-Type: application/json' -H "X-Emby-Authorization: $AUTH" \
  -d '{"Username":"gate","Pw":"gate-password-1"}' | jq -r .AccessToken)"
[ -n "$token" ] && [ "$token" != "null" ] || fail "could not sign in to Jellyfin"
curl -fsS -X POST \
  "$JELLYFIN/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true" \
  -H "X-Emby-Token: $token" -H 'Content-Type: application/json' \
  -d '{"LibraryOptions":{"PathInfos":[{"Path":"/media/movies"}]}}'

step "Jellyfin finds the video"
movie_count() {
  [ "$(curl -fsS "$JELLYFIN/Items?Recursive=true&IncludeItemTypes=Movie" -H "X-Emby-Token: $token" |
    jq .TotalRecordCount)" -ge 1 ]
}
wait_for 180 "Jellyfin to index the test movie" movie_count
item="$(curl -fsS "$JELLYFIN/Items?Recursive=true&IncludeItemTypes=Movie" -H "X-Emby-Token: $token" |
  jq -r '.Items[0].Id')"

step "Jellyfin serves the video (direct play, first kilobyte)"
head_file="$(mktemp)"
code="$(curl -sS -o "$head_file" -w '%{http_code}' -H "X-Emby-Token: $token" -H 'Range: bytes=0-1023' \
  "$JELLYFIN/Videos/$item/stream?static=true&mediaSourceId=$item")"
{ [ "$code" = "206" ] || [ "$code" = "200" ]; } || fail "stream request returned HTTP $code"
[ "$(stat -c %s "$head_file")" -gt 0 ] || fail "stream returned no bytes"
head -c 16 "$head_file" | grep -aq ftyp || fail "stream does not look like the MP4 we added"

step "Stop, start, logs"
selfhost stop jellyfin
selfhost status jellyfin | grep -q "is stopped" || fail "Jellyfin did not stop"
selfhost start jellyfin
wait_for 120 "Jellyfin to come back after a restart" jellyfin_healthy
[ -n "$(selfhost logs jellyfin --tail 20)" ] || fail "no log lines"

step "Uninstall Jellyfin and check media and settings survive"
selfhost uninstall jellyfin
selfhost status jellyfin | grep -q "not installed" || fail "Jellyfin is still installed"
[ -f "$movie_dir/Test Movie (2026).mp4" ] || fail "uninstall removed the media"
[ -d /opt/selfhost/config/jellyfin/config ] || fail "uninstall removed the settings"

step "Run uninstall.sh: removes the agent, keeps media and settings by default"
bash /opt/selfhost/uninstall.sh
[ ! -e /usr/local/bin/selfhost ] || fail "selfhost command still there"
systemctl is-active --quiet selfhost-agent.service && fail "agent still running"
[ -f "$movie_dir/Test Movie (2026).mp4" ] || fail "uninstall.sh removed the media"
[ -d /opt/selfhost/config/jellyfin ] || fail "uninstall.sh removed the settings"

echo
echo "M1 gate passed."
