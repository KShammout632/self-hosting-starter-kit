#!/usr/bin/env bash
# Checks that the scripts running as root never write through a symlink planted in /var/lib/selfhost,
# a folder the dashboard's user owns. Runs the real functions from install.sh and apply-update.sh
# against a temporary folder. Run from the repo root on Linux; CI runs it in the check job.
set -euo pipefail

fail() {
  echo "ROOT WRITES TEST FAILED: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/lib" "$work/lib/selfhost"

# chown needs the selfhost user, which this machine does not have. Ownership is not what is tested.
chown() { :; }
die() { fail "the script stopped: $*"; }

eval "$(sed -n '/^write_status() {$/,/^}$/p' deploy/apply-update.sh)"
eval "$(sed -n '/^prepare_setup_code() {$/,/^}$/p' install.sh)"
[ "$(type -t write_status)" = function ] || fail "write_status was not found in apply-update.sh"
[ "$(type -t prepare_setup_code)" = function ] || fail "prepare_setup_code was not found in install.sh"

STATUS_FILE="$work/lib/selfhost/kit-update.json"
VERSION=9.9.9
PRIVATE="$(mktemp -d "$work/lib/selfhost-update.XXXXXX")"
echo untouched >"$work/victim-old"
echo untouched >"$work/victim-final"
ln -s "$work/victim-old" "$STATUS_FILE.tmp"
ln -s "$work/victim-final" "$STATUS_FILE"
write_status running "Installing the new version."
[ "$(cat "$work/victim-old")" = untouched ] || fail "write_status wrote through the old temporary name"
[ "$(cat "$work/victim-final")" = untouched ] || fail "write_status wrote through a link at the status file"
[ -f "$STATUS_FILE" ] && [ ! -L "$STATUS_FILE" ] || fail "the status file is not a plain file"
grep -q '"state":"running"' "$STATUS_FILE" || fail "the status file has the wrong content"
[ "$(stat -c %a "$STATUS_FILE")" = 644 ] || fail "the status file is not readable by the dashboard"
echo "ok: apply-update.sh replaces a planted link instead of writing through it"

STATE_DIR="$work/lib/selfhost"
ln -s "$work/created-by-root" "$STATE_DIR/setup-code"
prepare_setup_code
[ ! -e "$work/created-by-root" ] || fail "prepare_setup_code created the target of a planted link"
[ -f "$STATE_DIR/setup-code" ] && [ ! -L "$STATE_DIR/setup-code" ] || fail "the setup code file is not a plain file"
[ "${#SETUP_CODE}" -eq 8 ] || fail "no setup code was made"
[ "$(cat "$STATE_DIR/setup-code")" = "$(printf '%s' "$SETUP_CODE" | sha256sum | cut -d' ' -f1)" ] ||
  fail "the setup code file does not hold the code's hash"
[ "$(stat -c %a "$STATE_DIR/setup-code")" = 640 ] || fail "the setup code file has the wrong mode"
echo "ok: install.sh replaces a planted link at the setup code file"

prepare_setup_code
[ -z "$SETUP_CODE" ] || fail "a second run made a new setup code"
[ -z "$(find "$work/lib" -maxdepth 1 -name 'selfhost-install.*')" ] || fail "a private folder was left behind"
echo "ok: an existing setup code is kept and nothing is left behind"
