#!/usr/bin/env bash
# M3 exit gate, the part that runs as root on a fresh Ubuntu 24.04 machine. Used by CI and by hand
# in a VirtualBox VM.
#
#   sudo bash m3-gate-inner.sh run <bundle dir>      install the kit, then prepare, mount, map,
#                                                     unmount, "unplug" and reconnect a spare disk
#   sudo bash m3-gate-inner.sh after-reboot-missing   run after rebooting with the disk unplugged
#   sudo bash m3-gate-inner.sh after-reboot-present   run after plugging it back in and rebooting
#
# The spare disk is GATE_DISK (a blank disk, for example sdb, which will be ERASED). Without it the
# script creates a virtual one with the scsi_debug kernel module. Set GATE_KEEP=1 to leave the
# drive set up so the reboot checks can follow, which is what the real unplug and reboot test needs.
set -euo pipefail

MODE="${1:?Usage: m3-gate-inner.sh run <bundle dir> | after-reboot-missing | after-reboot-present}"
BUNDLE="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL=gate1
VIRTUAL=0

step() { printf '\n##### %s\n' "$*"; }
fail() {
  echo "GATE FAILED: $*" >&2
  exit 1
}

call() { node "$HERE/agent-call.mjs" "$1"; }
ok() { jq -e '.ok == true' >/dev/null; }
refused() { jq -e '.ok == false and .error.code == "refused"' >/dev/null; }

unit_name() { systemd-escape --path --suffix=mount "$1"; }

wait_for() {
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "timed out waiting for $what"
}

state_file=/var/lib/selfhost-gate-m3
save_state() { printf 'DEVICE=%s\nUUID=%s\n' "$DEVICE" "$UUID" >"$state_file"; }

cleanup() {
  [ "${GATE_KEEP:-0}" = 1 ] && return 0
  for path in /srv/media/movies /srv/media/home-videos "/mnt/$LABEL"; do
    unit="$(unit_name "$path")"
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload || true
  if [ "$VIRTUAL" = 1 ]; then rmmod scsi_debug >/dev/null 2>&1 || true; fi
}

find_spare_disk() {
  if [ -n "${GATE_DISK:-}" ]; then
    DEVICE="$GATE_DISK"
    return
  fi
  step "No GATE_DISK given, creating a virtual disk with scsi_debug"
  apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null 2>&1 || true
  before="$(lsblk -dn -o NAME | sort)"
  modprobe scsi_debug dev_size_mb=512 || fail "no spare disk: set GATE_DISK, or use a kernel with scsi_debug"
  sleep 2
  DEVICE="$(comm -13 <(echo "$before") <(lsblk -dn -o NAME | sort) | head -n1)"
  [ -n "$DEVICE" ] || fail "scsi_debug did not create a disk"
  VIRTUAL=1
}

volume_missing() { call '{"action":"folder.usage","folder":"movies"}' | jq -e '.data.volumeMissing == true'; }

case "$MODE" in
after-reboot-missing)
  # shellcheck disable=SC1090
  . "$state_file"
  step "The server came back up with the drive unplugged"
  systemctl is-active selfhost-agent.service
  [ "$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health)" = 200 ] \
    || fail "the dashboard is not answering"
  step "The folder is marked as missing and nothing is mounted over the system drive"
  volume_missing || fail "folder.usage does not report the drive as missing"
  mountpoint -q "/mnt/$LABEL" && fail "/mnt/$LABEL is mounted with the drive unplugged"
  mountpoint -q /srv/media/movies && fail "the movies folder is mounted with the drive unplugged"
  call '{"action":"disk.list"}' | jq -e --arg uuid "$UUID" '.data.missing | map(.uuid) | index($uuid) != null' \
    >/dev/null || fail "disk.list does not list the unplugged drive as missing"
  echo "OK: boot finished without the drive and the kit reports it"
  exit 0
  ;;
after-reboot-present)
  # shellcheck disable=SC1090
  . "$state_file"
  step "The drive came back by itself after the reboot"
  wait_for 60 "the drive to mount" mountpoint -q "/mnt/$LABEL"
  wait_for 30 "the movies folder to mount" mountpoint -q /srv/media/movies
  [ -f /srv/media/movies/gate-file ] || fail "the test file is not visible in the movies folder"
  call '{"action":"folder.usage","folder":"movies"}' | jq -e '.data.volumeMissing == false' >/dev/null \
    || fail "the folder is still marked as missing"
  echo "OK: the drive and its folder returned after the reboot"
  exit 0
  ;;
run) ;;
*) fail "unknown mode $MODE" ;;
esac

[ -n "$BUNDLE" ] || fail "run needs the bundle directory"
trap cleanup EXIT
trap 'journalctl -u selfhost-agent.service --no-pager -n 40 || true' ERR

step "Run the installer"
export SELFHOST_BUNDLE_DIR="$BUNDLE" SELFHOST_SKIP_RESOURCE_CHECKS=1
bash "$BUNDLE/install.sh"
for tool in parted rsync smartctl lsblk mkfs.ext4 wipefs; do command -v "$tool" >/dev/null || fail "$tool was not installed"; done

find_spare_disk
echo "Using /dev/$DEVICE"

step "The disk list shows the spare disk and keeps the system disk out of reach"
list="$(call '{"action":"disk.list"}')"
echo "$list" | ok || fail "disk.list failed: $list"
echo "$list" | jq -e --arg d "$DEVICE" '.data.disks[] | select(.device == $d) | .canFormat == true' >/dev/null \
  || fail "the spare disk is not offered for formatting"
SYSTEM="$(echo "$list" | jq -r '.data.disks[] | select(.isSystem) | .device' | head -n1)"
[ -n "$SYSTEM" ] || fail "no disk is marked as the system disk"
echo "$list" | jq -e --arg d "$SYSTEM" '.data.disks[] | select(.device == $d) | .canFormat == false' >/dev/null \
  || fail "the system disk is offered for formatting"

step "Formatting the system disk is refused, even with a valid confirmation"
token="$(call "{\"action\":\"confirm.issue\",\"kind\":\"disk.format\",\"target\":\"$SYSTEM\"}" | jq -r .data.token)"
call "{\"action\":\"disk.format\",\"device\":\"$SYSTEM\",\"label\":\"oops\",\"confirm\":\"$token\"}" | refused \
  || fail "the system disk was not refused"
call '{"action":"disk.format","device":"'"$SYSTEM"'","label":"oops"}' | jq -e '.error.code == "confirm_required"' >/dev/null \
  || fail "formatting without a token was not refused"

step "Prepare the spare disk: erase, partition, format and mount it"
token="$(call "{\"action\":\"confirm.issue\",\"kind\":\"disk.format\",\"target\":\"$DEVICE\"}" | jq -r .data.token)"
reply="$(call "{\"action\":\"disk.format\",\"device\":\"$DEVICE\",\"label\":\"$LABEL\",\"confirm\":\"$token\"}")"
echo "$reply" | ok || fail "disk.format failed: $reply"
UUID="$(echo "$reply" | jq -r .data.uuid)"
save_state
if ! wait_for 15 "/mnt/$LABEL to be mounted" mountpoint -q "/mnt/$LABEL"; then :; fi
mountpoint -q "/mnt/$LABEL" || {
  systemctl status "$(unit_name "/mnt/$LABEL")" --no-pager || true
  journalctl -u "$(unit_name "/mnt/$LABEL")" --no-pager -n 30 || true
  cat "/etc/systemd/system/$(unit_name "/mnt/$LABEL")" || true
  lsblk -o NAME,TYPE,FSTYPE,UUID,MOUNTPOINTS || true
  findmnt -R /mnt || true
  fail "/mnt/$LABEL is not mounted"
}
[ "$(stat -c %U "/mnt/$LABEL")" = selfhost ] || fail "/mnt/$LABEL is not owned by selfhost"
for folder in Movies TV Music Photos; do [ -d "/mnt/$LABEL/$folder" ] || fail "missing /mnt/$LABEL/$folder"; done
grep -q '^Options=nofail' "/etc/systemd/system/$(unit_name "/mnt/$LABEL")" || fail "the mount unit lacks nofail"
systemctl is-enabled "$(unit_name "/mnt/$LABEL")" >/dev/null || fail "the mount is not enabled for boot"

step "The same token cannot erase anything twice"
call "{\"action\":\"disk.format\",\"device\":\"$DEVICE\",\"label\":\"again\",\"confirm\":\"$token\"}" \
  | jq -e '.error.code == "confirm_required"' >/dev/null || fail "a token was accepted twice"

step "A drive that is mounted cannot be formatted"
token="$(call "{\"action\":\"confirm.issue\",\"kind\":\"disk.format\",\"target\":\"$DEVICE\"}" | jq -r .data.token)"
call "{\"action\":\"disk.format\",\"device\":\"$DEVICE\",\"label\":\"again\",\"confirm\":\"$token\"}" \
  | jq -e '.error.code == "in_use"' >/dev/null || fail "a mounted disk was not protected"

step "Health check answers, supported or not"
call "{\"action\":\"disk.smart\",\"uuid\":\"$UUID\"}" | ok || fail "disk.smart failed"

step "Map the movies folder to the drive and use it as the selfhost user"
call "{\"action\":\"folder.assign\",\"folder\":\"movies\",\"uuid\":\"$UUID\",\"subpath\":\"Movies\"}" | ok \
  || fail "folder.assign failed"
mountpoint -q /srv/media/movies || fail "the movies folder is not a mount"
sudo -u selfhost touch /srv/media/movies/gate-file || fail "selfhost cannot write to the movies folder"
[ -f "/mnt/$LABEL/Movies/gate-file" ] || fail "the file did not land on the drive"
call '{"action":"folder.usage","folder":"movies"}' \
  | jq -e '.data.mapped.mountLabel == "'"$LABEL"'" and .data.volumeMissing == false and .data.totalBytes > 0' >/dev/null \
  || fail "folder.usage does not describe the mapping"

step "A folder name with a space works too"
call "{\"action\":\"folder.assign\",\"folder\":\"home-videos\",\"uuid\":\"$UUID\",\"subpath\":\"Home Videos\"}" | ok \
  || fail "folder.assign with a space in the name failed"
mountpoint -q /srv/media/home-videos || fail "the home videos folder is not a mount"

step "Unmount: the folder and the drive both let go, then mounting again brings the files back"
call "{\"action\":\"disk.unmount\",\"uuid\":\"$UUID\"}" | ok || fail "disk.unmount failed"
mountpoint -q "/mnt/$LABEL" && fail "the drive is still mounted"
mountpoint -q /srv/media/movies && fail "the movies folder is still mounted"
call "{\"action\":\"disk.mount\",\"uuid\":\"$UUID\",\"label\":\"$LABEL\"}" | ok || fail "mounting again failed"
mountpoint -q /srv/media/movies || fail "the movies folder did not come back"
[ -f /srv/media/movies/gate-file ] || fail "the file is gone after mounting again"

step "Unplug the drive while it is in use: the folder is marked missing and nothing writes to the system disk"
if [ "$VIRTUAL" = 1 ] || [ "${GATE_HOTUNPLUG:-0}" = 1 ]; then
  echo 1 >"/sys/block/$DEVICE/device/delete"
  wait_for 30 "the kit to notice the drive is gone" volume_missing
  mountpoint -q /srv/media/movies && fail "the movies folder is still mounted after unplugging"
  call '{"action":"disk.list"}' | jq -e --arg uuid "$UUID" '.data.missing | map(.uuid) | index($uuid) != null' >/dev/null \
    || fail "the unplugged drive is not listed as missing"

  step "Plug it back in and mount it again"
  for host in /sys/class/scsi_host/host*/scan; do echo '- - -' >"$host"; done
  wait_for 30 "the disk to come back" test -b "/dev/$DEVICE"
  sleep 2
  call "{\"action\":\"disk.mount\",\"uuid\":\"$UUID\",\"label\":\"$LABEL\"}" | ok || fail "mounting after replug failed"
  [ -f /srv/media/movies/gate-file ] || fail "the file is gone after replugging"
else
  echo "Skipped: set GATE_HOTUNPLUG=1 to delete the disk from the running system (VirtualBox: this is the hot unplug)."
fi

if [ "${GATE_KEEP:-0}" = 1 ]; then
  cat <<EOF

The drive is left set up. Now do the real test:
  1. Power off the VM, remove the disk, power on, then run:  sudo bash $0 after-reboot-missing
  2. Power off, attach the disk again, power on, then run:   sudo bash $0 after-reboot-present
EOF
fi
echo
echo "M3 storage gate: all checks passed"
