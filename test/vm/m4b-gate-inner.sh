#!/usr/bin/env bash
# M4b gate, the part that runs as root on a fresh Ubuntu 24.04 machine: the Tailscale actions and
# the addresses they publish. Used by CI.
#
# Part 1 needs only internet access. It starts a real sign in with Tailscale and checks that the
# agent hands back the sign-in page and refuses to publish anything while signed out.
# Part 2 runs only when TS_AUTHKEY is set (an ephemeral, reusable auth key from a throwaway
# tailnet that has MagicDNS and HTTPS certificates turned on). It joins the tailnet, publishes
# Jellyfin, Nextcloud and the dashboard, and fetches each address over https.
# Usage: sudo --preserve-env=TS_AUTHKEY bash m4b-gate-inner.sh <bundle dir from scripts/make-bundle.sh>
set -euo pipefail

BUNDLE="${1:?Usage: m4b-gate-inner.sh <bundle dir>}"
NEXTCLOUD=http://127.0.0.1:8081
NODE_NAME="gate-${GITHUB_RUN_ID:-local}-$$"

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}
trap 'echo "----- tailscale"; tailscale status || true; tailscale serve status || true; docker ps -a || true' ERR
trap 'tailscale logout >/dev/null 2>&1 || true' EXIT

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
systemctl is-active --quiet tailscaled || fail "tailscaled is not running"

step "Part 1: signed out"
call '{"action":"tailscale.status"}' |
  jq -e '.ok == true and .data.installed == true and .data.backendState != "Running"' >/dev/null ||
  fail "unexpected status before sign in"
call '{"action":"tailscale.serve.apply"}' |
  jq -e '.ok == false and .error.code == "refused" and (.error.message | test("Sign in"))' >/dev/null ||
  fail "serve.apply did not refuse while signed out"
call '{"action":"tailscale.login","hostname":"bad name; reboot"}' |
  jq -e '.ok == false and .error.code == "invalid_request"' >/dev/null ||
  fail "a bad host name was accepted"

reply="$(call "{\"action\":\"tailscale.login\",\"hostname\":\"$NODE_NAME\"}")"
echo "$reply" | jq -e '.ok == true and (.data.authUrl | startswith("https://"))' >/dev/null ||
  fail "login did not return a sign-in address: $(echo "$reply" | jq -c 'del(.data.authUrl)')"
call '{"action":"tailscale.logout"}' | jq -e '.ok == true' >/dev/null ||
  fail "logout failed while signed out"

if [ -z "${TS_AUTHKEY:-}" ]; then
  echo
  echo "TS_AUTHKEY is not set, so part 2 (a real tailnet) was skipped."
  echo "M4b gate passed (part 1 only)."
  exit 0
fi

step "Part 2: install Jellyfin and Nextcloud first, so Nextcloud starts before it knows the tailnet name"
selfhost install jellyfin
selfhost install nextcloud
nc_ready() { curl -fsS "$NEXTCLOUD/status.php" | jq -e '.installed == true'; }
wait_for 300 "Nextcloud to finish setting itself up" nc_ready

step "Join the tailnet"
tailscale up --authkey="$TS_AUTHKEY" --hostname="$NODE_NAME" --reset --timeout=90s >/dev/null
status="$(call '{"action":"tailscale.status"}')"
echo "$status" | jq -e '.data.backendState == "Running"' >/dev/null || fail "not connected"
echo "$status" | jq -e '.data.magicDnsEnabled == true and .data.httpsEnabled == true' >/dev/null ||
  fail "the test tailnet needs MagicDNS and HTTPS certificates turned on"
dns="$(echo "$status" | jq -r .data.dnsName)"
ip="$(tailscale ip -4)"
echo "Server name on the tailnet: $dns"

step "Publish the addresses"
reply="$(call '{"action":"tailscale.serve.apply"}')"
echo "$reply" | jq -e '.ok == true' >/dev/null || fail "serve.apply failed: $reply"
echo "$reply" | jq -e --arg dns "$dns" '
  [.data.urls[] | "\(.target)=\(.url)"] | sort ==
  ["dashboard=https://\($dns)", "jellyfin=https://\($dns):8920", "nextcloud=https://\($dns):8444"]' \
  >/dev/null || fail "unexpected addresses: $(echo "$reply" | jq -c .data.urls)"

fetch() {
  local port="$1" path="$2"
  shift 2
  curl -fsS --max-time 20 --resolve "$dns:$port:$ip" "$@" "https://$dns:$port$path"
}

step "Fetch each address over https"
dash() { fetch 443 /api/health | jq -e '.ok == true'; }
wait_for 30 "the dashboard on https" dash
jelly() { fetch 8920 /health | grep -q Healthy; }
wait_for 60 "Jellyfin on https" jelly
nc_status() { fetch 8444 /status.php | jq -e '.installed == true'; }
wait_for 60 "Nextcloud on https" nc_status

step "Nextcloud accepts the tailnet name and stays on https"
page="$(fetch 8444 /login -L)"
echo "$page" | grep -qi "untrusted domain" && fail "Nextcloud rejects the tailnet name"
final="$(curl -sS --max-time 20 --resolve "$dns:8444:$ip" -L -o /dev/null -w '%{url_effective}' "https://$dns:8444/")"
case "$final" in https://*) ;; *) fail "Nextcloud redirected away from https to $final" ;; esac
domains="$(docker exec --user www-data selfhost-nextcloud php occ config:system:get trusted_domains)"
[ "$(echo "$domains" | grep -cx "$dns")" = "1" ] || fail "tailnet name is not listed exactly once: $domains"

step "Applying again changes nothing"
call '{"action":"tailscale.serve.apply"}' | jq -e '.ok == true' >/dev/null || fail "second apply failed"
domains="$(docker exec --user www-data selfhost-nextcloud php occ config:system:get trusted_domains)"
[ "$(echo "$domains" | grep -cx "$dns")" = "1" ] || fail "tailnet name was added twice: $domains"

step "Removing Jellyfin removes its address"
selfhost uninstall jellyfin
call '{"action":"tailscale.serve.apply"}' | jq -e '.ok == true' >/dev/null || fail "apply after uninstall failed"
tailscale serve status | grep -q ':8920' && fail "the Jellyfin address is still published"
tailscale serve status | grep -q ':8444' || fail "the Nextcloud address disappeared"

step "Sign out removes every address"
call '{"action":"tailscale.logout"}' | jq -e '.ok == true and .data.backendState != "Running"' >/dev/null ||
  fail "logout failed"
tailscale serve status | grep -q ':8444' && fail "an address is still published after sign out"

selfhost uninstall nextcloud
echo
echo "M4b gate passed."
