#!/usr/bin/env bash
# Moves a running kit to a new release and puts the old one back if the new one does not start.
# The agent starts this as its own systemd unit (selfhost-kit-update), because the agent and the
# dashboard are both restarted while it runs.
# Usage: apply-update.sh <unpacked release folder> <version>
set -uo pipefail

BUNDLE="${1:?Usage: apply-update.sh <release folder> <version>}"
VERSION="${2:?Usage: apply-update.sh <release folder> <version>}"
STATUS_FILE=/var/lib/selfhost/kit-update.json
RELEASES=/opt/selfhost/releases
PREVIOUS="$RELEASES/previous"
DASHBOARD=/opt/selfhost/dashboard
AGENT_DIR=/opt/selfhost/agent
NODE="$AGENT_DIR/node"

write_status() {
  local state="$1" message="$2"
  printf '{"state":"%s","version":"%s","message":"%s","at":"%s"}\n' \
    "$state" "$VERSION" "$message" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS_FILE.tmp"
  chmod 0644 "$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

install_agent_files() {
  local from="$1"
  for file in agent.cjs selfhost-cli.mjs; do
    install -m 0644 "$from/$file" "$AGENT_DIR/$file.new" && mv -f "$AGENT_DIR/$file.new" "$AGENT_DIR/$file"
  done
  install -m 0755 "$from/uninstall.sh" /opt/selfhost/uninstall.sh
  install -m 0644 "$from/selfhost-agent.service" /etc/systemd/system/selfhost-agent.service
}

install_dashboard_files() {
  local from="$1"
  rm -rf "$DASHBOARD/web"
  cp -r "$from/web" "$DASHBOARD/web"
  chmod -R u=rwX,go=rX "$DASHBOARD/web"
  for file in api.js package.json Dockerfile compose.yml; do
    install -m 0644 "$from/$file" "$DASHBOARD/$file"
  done
}

restart_agent_and_wait() {
  local expect="$1"
  systemctl daemon-reload
  systemctl restart selfhost-agent.service || return 1
  for _ in $(seq 1 30); do
    if "$NODE" "$AGENT_DIR/selfhost-cli.mjs" version 2>/dev/null | grep -q "agent $expect"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_dashboard_and_wait() {
  docker compose --project-directory "$DASHBOARD" --file "$DASHBOARD/compose.yml" \
    up --detach --build --remove-orphans || return 1
  for _ in $(seq 1 90); do
    curl -fsS --max-time 3 http://127.0.0.1:8080/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

roll_back() {
  local old_version
  old_version="$(cat "$PREVIOUS/VERSION" 2>/dev/null || true)"
  if [ -z "$old_version" ] || [ ! -f "$PREVIOUS/agent.cjs" ]; then
    write_status failed "The update failed and the old version could not be restored. Run the installer again to repair."
    return
  fi
  install_agent_files "$PREVIOUS"
  install_dashboard_files "$PREVIOUS/dashboard"
  if restart_agent_and_wait "$old_version" && restart_dashboard_and_wait; then
    write_status rolled_back "The new version did not start, so the old one was put back."
  else
    write_status failed "The update failed and the old version could not be restored. Run the installer again to repair."
  fi
}

write_status running "Installing the new version."

rm -rf "$PREVIOUS"
mkdir -p "$PREVIOUS/dashboard"
cp -p "$AGENT_DIR/agent.cjs" "$AGENT_DIR/selfhost-cli.mjs" /opt/selfhost/uninstall.sh \
  /etc/systemd/system/selfhost-agent.service "$PREVIOUS/"
cp -a "$DASHBOARD/." "$PREVIOUS/dashboard/"
"$NODE" "$AGENT_DIR/selfhost-cli.mjs" version 2>/dev/null | sed -n 's/^selfhost agent \([0-9.]*\).*/\1/p' >"$PREVIOUS/VERSION"

install_agent_files "$BUNDLE"
install_dashboard_files "$BUNDLE/dashboard"

if restart_agent_and_wait "$VERSION" && restart_dashboard_and_wait; then
  write_status done "Updated to version $VERSION."
  rm -rf "$RELEASES/$VERSION"
else
  roll_back
fi
