#!/usr/bin/env bash
# Self-hosting starter kit installer for Ubuntu Server 24.04 (x86-64).
# Safe to run again: running it a second time repairs a broken install.
#
#   curl -fsSL https://raw.githubusercontent.com/KShammout632/self-hosting-starter-kit/main/install.sh -o install.sh
#   less install.sh   # optional: read it first
#   sudo bash install.sh
#
# For testing, SELFHOST_BUNDLE_DIR points at a folder that holds the files of a release
# (see scripts/make-bundle.sh) and skips the download. SELFHOST_SKIP_RESOURCE_CHECKS=1 skips the
# RAM and disk checks, because CI machines are smaller than the hardware the kit targets.
set -euo pipefail

KIT_VERSION="0.9.0"
NODE_VERSION="22.23.3"
# Pinned here rather than read from nodejs.org, which also serves the download it would be checking.
NODE_SHA256="df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
# Ed25519 key that signs releases (base64 DER), from scripts/new-release-key.sh. The agent holds the
# same value in apps/agent/src/release-key.ts.
RELEASE_PUBLIC_KEY="MCowBQYDK2VwAyEAMaipbJAreKa3ZSIx9zLx3/N4aE7BNaN0k6Hcb5FmKJY="
REPO="KShammout632/self-hosting-starter-kit"
HELP_URL="https://github.com/${REPO}/blob/v${KIT_VERSION}/docs/troubleshooting.md"
LOG_FILE="/var/log/selfhost-install.log"
STATE_DIR=/var/lib/selfhost

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\nThe installer stopped: %s\nMore help: %s\n' "$*" "$HELP_URL" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "Please run it with sudo: sudo bash install.sh"

# The setup code is printed on the original terminal only (fd 3), so it never lands in the log file.
exec 3>&1
# Created first: tee creates the file in the background, so chmod right after could run before it exists.
touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'printf "\nSomething went wrong. The full log is in %s\n" "$LOG_FILE" >&2' ERR

export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -qq -o DPkg::Lock::Timeout=120 "$@" >/dev/null; }

preflight() {
  say "Checking this machine"

  local os_id os_version
  os_id="$(. /etc/os-release && echo "${ID:-}")"
  os_version="$(. /etc/os-release && echo "${VERSION_ID:-}")"
  [ "$os_id" = "ubuntu" ] && [ "$os_version" = "24.04" ] ||
    die "This kit needs Ubuntu Server 24.04. This machine runs ${os_id:-unknown} ${os_version:-unknown}."

  [ "$(uname -m)" = "x86_64" ] || die "This kit needs a 64-bit Intel or AMD processor (x86-64)."

  if [ "${SELFHOST_SKIP_RESOURCE_CHECKS:-0}" != "1" ]; then
    local mem_kb disk_kb
    mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    # 4 GB machines report a little under 4 GB, so allow for that.
    [ "$mem_kb" -ge 3500000 ] || die "This machine has less than 4 GB of memory, which is the minimum."
    disk_kb="$(df --output=avail -k / | tail -n 1 | tr -d ' ')"
    [ "$disk_kb" -ge $((20 * 1024 * 1024)) ] ||
      die "The system disk needs at least 20 GB free."
  fi

  curl -fsS --max-time 20 -o /dev/null https://download.docker.com/linux/ubuntu/gpg ||
    die "Cannot reach the internet. Check the network cable or Wi-Fi and try again."
  note "Everything looks fine."
}

install_base_packages() {
  say "Installing basic tools and automatic security updates"
  apt-get update -qq
  apt_install ca-certificates curl gnupg jq openssl smartmontools parted rsync unattended-upgrades xz-utils ufw
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
}

install_docker() {
  say "Installing Docker"
  # Ubuntu's own docker.io package conflicts with Docker's official packages.
  for pkg in docker.io docker-doc docker-compose podman-docker; do
    apt-get remove -y -qq "$pkg" >/dev/null 2>&1 || true
  done

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq
  apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
  docker compose version >/dev/null
}

install_tailscale() {
  say "Installing Tailscale (you sign in to it later, from the dashboard)"
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt_install tailscale
  systemctl enable --now tailscaled
}

install_intel_gpu() {
  if [ -e /dev/dri/renderD128 ]; then
    say "Found a graphics chip, installing video acceleration for Jellyfin"
    # Not fatal: without it Jellyfin still works, it just transcodes on the CPU.
    apt_install intel-media-va-driver-non-free vainfo ||
      note "Could not install the video acceleration driver. Jellyfin will use the CPU instead."
  else
    say "No graphics chip found, Jellyfin will transcode on the CPU"
  fi
}

create_user_and_folders() {
  say "Creating the selfhost user and folders"
  getent group selfhost >/dev/null || groupadd --system selfhost
  id -u selfhost >/dev/null 2>&1 ||
    useradd --system --gid selfhost --no-create-home --shell /usr/sbin/nologin selfhost
  for group in video render; do
    getent group "$group" >/dev/null && usermod -aG "$group" selfhost
  done

  install -d -m 0755 /opt/selfhost /opt/selfhost/agent /opt/selfhost/services \
    /opt/selfhost/config /opt/selfhost/backups
  install -d -m 0750 -o selfhost -g selfhost "$STATE_DIR"
  # Group-writable and setgid, so people in the selfhost group can add media over SSH or Samba later.
  install -d -m 2775 -o selfhost -g selfhost /srv/media /srv/media/movies /srv/media/tv \
    /srv/media/home-videos /srv/media/music /srv/photos /srv/nextcloud
}

# Checks that <dir>/<name>.sha256 is signed by the release key and matches <dir>/<name>.
# The checksum on its own proves nothing: whoever could replace the tarball could replace it too.
verify_release() {
  local dir="$1" name="$2"
  [[ "$RELEASE_PUBLIC_KEY" =~ ^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$ ]] ||
    die "This copy of the installer has no release key, so it cannot check the download."
  printf '%s' "$RELEASE_PUBLIC_KEY" | base64 -d >"$dir/release-key.der"
  base64 -d "$dir/$name.sha256.sig" >"$dir/$name.sha256.sig.bin" 2>/dev/null ||
    die "The download's signature is damaged."
  openssl pkeyutl -verify -pubin -keyform DER -inkey "$dir/release-key.der" -rawin \
    -in "$dir/$name.sha256" -sigfile "$dir/$name.sha256.sig.bin" >/dev/null 2>&1 ||
    die "The download is not signed by this project, so it was not installed."
  local line
  line="$(cat "$dir/$name.sha256")"
  [[ "$line" =~ ^[0-9a-f]{64}\ [\ *]([^[:space:]]+)$ && "${BASH_REMATCH[1]}" = "$name" ]] ||
    die "The checksum file is for a different download."
  (cd "$dir" && sha256sum --check --status "$name.sha256") ||
    die "The download is corrupt or has been tampered with."
}

# Sets BUNDLE to a folder holding agent.cjs, selfhost-agent.service, selfhost-cli.mjs, uninstall.sh and dashboard/.
fetch_bundle() {
  if [ -n "${SELFHOST_BUNDLE_DIR:-}" ]; then
    BUNDLE="$SELFHOST_BUNDLE_DIR"
    return
  fi
  say "Downloading kit version ${KIT_VERSION}"
  local work name base
  work="$(mktemp -d)"
  name="selfhost-kit-${KIT_VERSION}-linux-x64.tar.gz"
  base="https://github.com/${REPO}/releases/download/v${KIT_VERSION}"
  curl -fsSL "$base/$name" -o "$work/$name" || die "Could not download kit version ${KIT_VERSION}."
  curl -fsSL "$base/$name.sha256" -o "$work/$name.sha256" || die "Could not download the checksum."
  curl -fsSL "$base/$name.sha256.sig" -o "$work/$name.sha256.sig" || die "Could not download the signature."
  verify_release "$work" "$name"
  mkdir "$work/bundle"
  tar -xzf "$work/$name" -C "$work/bundle"
  BUNDLE="$work/bundle"
}

install_node() {
  local target=/opt/selfhost/agent/node
  if [ -x "$target" ] && [ "$("$target" --version)" = "v${NODE_VERSION}" ]; then
    note "Node ${NODE_VERSION} is already installed."
    return
  fi
  say "Installing the Node runtime for the agent"
  local work base tarball
  work="$(mktemp -d)"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  tarball="node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL "$base/$tarball" -o "$work/$tarball" || die "Could not download Node ${NODE_VERSION}."
  printf '%s  %s\n' "$NODE_SHA256" "$tarball" | (cd "$work" && sha256sum --check --status) ||
    die "The Node download failed its checksum."
  tar -xJf "$work/$tarball" --strip-components=2 -C "$work" "node-v${NODE_VERSION}-linux-x64/bin/node"
  # Move into place instead of overwriting, which fails while the agent is running.
  install -m 0755 "$work/node" "$target.new"
  mv -f "$target.new" "$target"
  rm -rf "$work"
}

install_agent() {
  say "Installing the selfhost agent"
  install_node
  install -m 0644 "$BUNDLE/agent.cjs" /opt/selfhost/agent/agent.cjs
  install -m 0644 "$BUNDLE/selfhost-cli.mjs" /opt/selfhost/agent/selfhost-cli.mjs
  install -m 0755 "$BUNDLE/uninstall.sh" /opt/selfhost/uninstall.sh
  cat >/usr/local/bin/selfhost <<'EOF'
#!/bin/sh
exec /opt/selfhost/agent/node /opt/selfhost/agent/selfhost-cli.mjs "$@"
EOF
  chmod 0755 /usr/local/bin/selfhost

  install -m 0644 "$BUNDLE/selfhost-agent.service" /etc/systemd/system/selfhost-agent.service
  systemctl daemon-reload
  systemctl enable selfhost-agent.service
  # Restart, not just start, so an install over an older version picks up the new agent.
  systemctl restart selfhost-agent.service

  for _ in $(seq 1 40); do
    [ -S /run/selfhost/agent.sock ] && break
    sleep 0.5
  done
  [ -S /run/selfhost/agent.sock ] || {
    journalctl -u selfhost-agent.service --no-pager -n 30 || true
    die "The agent did not start."
  }
}

# Sets SETUP_CODE when this is a first install. The API deletes the code file once the admin account
# exists, so the file being absent next to an existing database means setup is already done.
prepare_setup_code() {
  SETUP_CODE=""
  local code_file="$STATE_DIR/setup-code" private
  if { [ -f "$code_file" ] && [ ! -L "$code_file" ]; } || [ -e "$STATE_DIR/selfhost.db" ]; then return; fi
  SETUP_CODE="$(head -c 2048 /dev/urandom | tr -dc 'A-HJ-NP-Z2-9' | cut -c1-8)"
  [ "${#SETUP_CODE}" -eq 8 ] || die "Could not create a setup code."
  # The dashboard's user owns $STATE_DIR and could plant a symlink there for root to write through.
  # The file is made in a folder only root can use, then renamed over whatever is at the final name.
  private="$(mktemp -d "$(dirname "$STATE_DIR")/selfhost-install.XXXXXX")"
  printf '%s' "$SETUP_CODE" | sha256sum | cut -d' ' -f1 >"$private/setup-code"
  chown selfhost:selfhost "$private/setup-code"
  chmod 0640 "$private/setup-code"
  mv -f "$private/setup-code" "$code_file"
  rmdir "$private"
}

install_dashboard() {
  say "Installing the dashboard"
  local dir=/opt/selfhost/dashboard
  install -d -m 0755 "$dir"
  rm -rf "$dir/web"
  cp -r "$BUNDLE/dashboard/web" "$dir/web"
  # The dashboard runs as an unprivileged user, so never trust the permissions the files arrived with.
  chmod -R u=rwX,go=rX "$dir/web"
  for file in api.js package.json Dockerfile compose.yml; do
    install -m 0644 "$BUNDLE/dashboard/$file" "$dir/$file"
  done
  {
    echo "SELFHOST_UID=$(id -u selfhost)"
    echo "SELFHOST_GID=$(id -g selfhost)"
  } >"$dir/.env"

  prepare_setup_code
  docker compose --project-directory "$dir" --file "$dir/compose.yml" up --detach --build --remove-orphans

  for _ in $(seq 1 60); do
    curl -fsS --max-time 3 http://127.0.0.1:8080/api/health >/dev/null 2>&1 && return
    sleep 1
  done
  docker compose --project-directory "$dir" --file "$dir/compose.yml" logs --tail 40 || true
  die "The dashboard did not start."
}

setup_firewall() {
  say "Turning on the firewall"
  # Never lock out the person installing over SSH, even if SSH uses another port.
  local ports port
  ports="$( (sshd -T 2>/dev/null || true) | awk '$1 == "port" {print $2}')"
  for port in 22 $ports; do
    ufw allow "${port}/tcp" >/dev/null
  done
  ufw allow in on tailscale0 >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  note "Docker publishes service ports itself, so the firewall does not cover them."
  note "Do not forward ports on your router. Remote access goes through Tailscale."
}

finish() {
  local ip
  ip="$(hostname -I | awk '{print $1}')"
  say "Installed"
  {
    echo
    echo "The server is ready. Open the dashboard in a browser on any device at home:"
    echo
    echo "    http://${ip:-your-server-ip}:8080"
    echo
    if [ -n "$SETUP_CODE" ]; then
      echo "The first time, it asks for this setup code:"
      echo
      echo "    Setup code: ${SETUP_CODE:0:4}-${SETUP_CODE:4:4}"
      echo
      echo "Write it down now. It is shown only once and is not saved in the install log."
      echo "If you lose it, run: sudo selfhost reset-password"
    else
      echo "The dashboard is already set up. If you forgot the password or the setup code,"
      echo "run: sudo selfhost reset-password"
    fi
    echo
  } >&3
  cat <<EOF
Put your movies in /srv/media/movies, shows in /srv/media/tv.
The install log is saved at ${LOG_FILE}.
Guides and troubleshooting: ${HELP_URL%/troubleshooting.md}/user-guide.md
To remove everything later: sudo bash /opt/selfhost/uninstall.sh
EOF
}

preflight
install_base_packages
install_docker
install_tailscale
install_intel_gpu
create_user_and_folders
fetch_bundle
install_agent
install_dashboard
setup_firewall
finish
