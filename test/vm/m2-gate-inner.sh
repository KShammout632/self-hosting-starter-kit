#!/usr/bin/env bash
# M2 exit gate, the parts that run as root on a fresh Ubuntu 24.04 machine. It has two modes:
#
#   m2-gate-inner.sh install <bundle dir>   Runs the installer twice, checks the dashboard is up and
#                                           locked down, and writes the setup code to $CODE_FILE.
#   m2-gate-inner.sh finish                 Checks the dashboard kept its data across a restart, then
#                                           runs uninstall.sh and checks the dashboard is gone.
#
# CI runs the browser test (apps/web/e2e-gate) between the two. The browser test is where the gate
# "start, stop and read logs from the browser only" is checked.
set -euo pipefail

MODE="${1:?Usage: m2-gate-inner.sh install <bundle dir> | finish}"
DASHBOARD=http://127.0.0.1:8080
CODE_FILE="${CODE_FILE:-/tmp/gate-setup-code}"

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
trap 'docker logs --tail 60 selfhost-dashboard-dashboard-1 || true; journalctl -u selfhost-agent.service --no-pager -n 40 || true' ERR

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

case "$MODE" in
install)
  BUNDLE="${2:?Usage: m2-gate-inner.sh install <bundle dir>}"
  export SELFHOST_BUNDLE_DIR="$BUNDLE" SELFHOST_SKIP_RESOURCE_CHECKS=1

  step "Run the installer and keep what it prints on the terminal"
  bash "$BUNDLE/install.sh" | tee /tmp/install-output.txt
  code="$(sed -n 's/^ *Setup code: *//p' /tmp/install-output.txt | head -n 1)"
  [[ "$code" =~ ^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$ ]] || fail "the installer did not print a setup code"
  grep -q "http://.*:8080" /tmp/install-output.txt || fail "the installer did not print the dashboard address"
  if grep -q "${code//-/}" /var/log/selfhost-install.log; then fail "the setup code was written to the install log"; fi
  [ "$(stat -c %a /var/log/selfhost-install.log)" = "600" ] || fail "install log is readable by other users"

  step "Run the installer again: the dashboard stays up and the first code is still the only one"
  bash "$BUNDLE/install.sh" | tee /tmp/install-output-2.txt
  grep -q "Setup code:" /tmp/install-output-2.txt && fail "a second install printed a different setup code"
  printf '%s\n' "$code" >"$CODE_FILE"

  step "The dashboard answers and refuses strangers"
  [ "$(http_code "$DASHBOARD/api/health")" = "200" ] || fail "health check failed"
  [ "$(curl -fsS "$DASHBOARD/api/session" | jq -r .state)" = "setup_required" ] || fail "expected the setup page"
  [ "$(http_code "$DASHBOARD/api/services")" = "401" ] || fail "services are readable without signing in"
  [ "$(http_code -X POST "$DASHBOARD/api/services/jellyfin/install")" = "401" ] || fail "install works without signing in"
  [ "$(http_code "$DASHBOARD/")" = "200" ] || fail "the web app is not served"
  curl -fsS "$DASHBOARD/" | grep -q '<div id="root">' || fail "the web app is not the dashboard"
  [ "$(http_code "$DASHBOARD/services/jellyfin")" = "200" ] || fail "deep links to the web app do not work"

  step "The dashboard container is locked down"
  container=selfhost-dashboard-dashboard-1
  [ "$(docker exec "$container" id -u)" != "0" ] || fail "the dashboard runs as root"
  docker inspect "$container" --format '{{json .Mounts}}' | grep -q docker.sock && fail "the dashboard can see the Docker socket"
  docker inspect "$container" --format '{{json .Mounts}}' | grep -q '/run/selfhost' || fail "the agent socket is not mounted"
  [ "$(docker inspect "$container" --format '{{.HostConfig.ReadonlyRootfs}}')" = "true" ] || fail "root filesystem is writable"
  echo "Setup code saved for the browser test."
  ;;

finish)
  step "The dashboard keeps its accounts across a restart"
  docker compose --project-directory /opt/selfhost/dashboard --file /opt/selfhost/dashboard/compose.yml restart
  for _ in $(seq 1 60); do
    [ "$(http_code "$DASHBOARD/api/health")" = "200" ] && break
    sleep 1
  done
  [ "$(curl -fsS "$DASHBOARD/api/session" | jq -r .state)" = "logged_out" ] || fail "the admin account was lost on restart"
  [ ! -e /var/lib/selfhost/setup-code ] || fail "the setup code was not removed after setup"

  step "selfhost reset-password makes a new code, and the dashboard offers setup again"
  new_code="$(selfhost reset-password | sed -n 's/^ *\([A-HJ-NP-Z2-9]\{4\}-[A-HJ-NP-Z2-9]\{4\}\) *$/\1/p')"
  [ -n "$new_code" ] || fail "reset-password did not print a code"
  [ "$(curl -fsS "$DASHBOARD/api/session" | jq -r .setupAvailable)" = "true" ] || fail "dashboard does not offer setup after a reset"
  [ "$(http_code -X POST "$DASHBOARD/api/setup" -H 'Content-Type: application/json' \
    -d '{"code":"AAAA-AAAA","password":"another long password"}')" = "401" ] || fail "a wrong code was accepted"
  [ "$(http_code -X POST "$DASHBOARD/api/setup" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$new_code\",\"password\":\"another long password\"}")" = "200" ] || fail "the new code was refused"
  [ ! -e /var/lib/selfhost/setup-code ] || fail "the reset code was not removed after use"

  step "uninstall.sh removes the dashboard and keeps settings by default"
  bash /opt/selfhost/uninstall.sh
  [ ! -d /opt/selfhost/dashboard ] || fail "dashboard files are still there"
  [ -z "$(docker ps -aq --filter name=selfhost-dashboard)" ] || fail "dashboard container is still there"
  [ -f /var/lib/selfhost/selfhost.db ] || fail "uninstall.sh removed the dashboard database"
  echo
  echo "M2 gate passed."
  ;;

*)
  fail "unknown mode $MODE"
  ;;
esac
