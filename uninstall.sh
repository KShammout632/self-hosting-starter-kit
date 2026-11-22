#!/usr/bin/env bash
# Removes the self-hosting starter kit: every service container, the agent and the selfhost command.
# It keeps your settings and all media unless you say otherwise, and it asks about each separately.
#
#   sudo bash /opt/selfhost/uninstall.sh
#
# Docker and Tailscale stay installed, since other things on this machine may use them.
#
# For unattended use (tests), set SELFHOST_DELETE_CONFIG=yes and/or SELFHOST_DELETE_MEDIA=yes.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() {
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "Please run it with sudo."

confirm() {
  local variable="$1" question="$2" answer=""
  if [ "${!variable:-}" = "yes" ]; then return 0; fi
  [ -r /dev/tty ] || return 1
  read -r -p "$question [type yes to confirm, anything else keeps it] " answer </dev/tty || return 1
  [ "$answer" = "yes" ]
}

say "Stopping and removing services"
for file in /opt/selfhost/services/*/compose.yml; do
  [ -e "$file" ] || continue
  name="$(basename "$(dirname "$file")")"
  case "$name" in *[!a-z]* | "") continue ;; esac
  docker compose --project-name "selfhost-$name" --file "$file" down --remove-orphans ||
    echo "Could not stop $name cleanly, continuing."
done

say "Removing the dashboard"
if [ -f /opt/selfhost/dashboard/compose.yml ]; then
  docker compose --project-directory /opt/selfhost/dashboard --file /opt/selfhost/dashboard/compose.yml down --remove-orphans ||
    echo "Could not stop the dashboard cleanly, continuing."
fi
docker image rm selfhost/dashboard:local >/dev/null 2>&1 || true
rm -rf /opt/selfhost/dashboard

say "Removing the agent"
systemctl disable --now selfhost-agent.service 2>/dev/null || true
rm -f /etc/systemd/system/selfhost-agent.service /usr/local/bin/selfhost
systemctl daemon-reload
rm -rf /opt/selfhost/agent /opt/selfhost/services

if confirm SELFHOST_DELETE_CONFIG "Also delete service settings and databases (Jellyfin accounts, watch history, and so on)?"; then
  say "Deleting settings"
  rm -rf /opt/selfhost/config /opt/selfhost/backups /var/lib/selfhost
else
  say "Keeping settings in /opt/selfhost/config"
fi

if confirm SELFHOST_DELETE_MEDIA "Also delete everything in /srv/media, /srv/photos and /srv/nextcloud? This cannot be undone."; then
  say "Deleting media"
  rm -rf /srv/media /srv/photos /srv/nextcloud
else
  say "Keeping your media in /srv"
fi

say "Done. Docker, Tailscale and the firewall were left as they are."
