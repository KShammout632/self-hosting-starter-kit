# Progress

Each session updates this file before opening its pull request. Newest entry first.

## Status

| Milestone | Status | Branch / PR |
| --- | --- | --- |
| M0 Foundations | Done, exit gate passed in CI (`agent-gate`) | `m0-foundations` |
| M1 First slice: installer + Jellyfin | Done, exit gate passed in CI (`install-gate`) | `m1-installer-jellyfin` |
| M2 Dashboard core | Done, exit gate passed in CI (`dashboard-gate`) | `m2-dashboard-core` |
| M3 Storage | Done, exit gate passed (`storage-gate` in CI, and the unplug and reboot test by hand in VirtualBox) | `m3-storage` |
| M4a Navidrome, Immich, Nextcloud | Done, `services-gate` passed in CI and the Nextcloud login was checked by hand in VirtualBox | `m4a-services` |
| M4b Tailscale and remote access | Not started, own session | `m4b-remote-access` |
| M4c Setup wizard | Not started, own session, after M4b | `m4c-wizard` |
| M5 Updates and docs | Not started | |
| M6 Beta to 1.0 | Not started | |

## Next up

M4 is split into three sub-milestones, run in order, each on its own branch and PR (the M4 exit gate, all four apps working on a phone over mobile data, closes after M4c):

- M4a: done.
- M4b (separate session): agent `tailscale.login`, `tailscale.logout` and `tailscale.serve.apply`, MagicDNS and HTTPS readiness checks, remote URLs and QR codes, Remote access page, Nextcloud trusted domains once the tailnet name is known.
- M4c (separate session): multi-step setup wizard (password, Tailscale, drives, services) reusing the setup page and the Storage and Remote access components.

## Later

Ideas and follow-ups found during work that are outside the current milestone.

- Release packaging: `install.sh` downloads `selfhost-kit-<version>-linux-x64.tar.gz` plus a `.sha256` from a GitHub release, but no workflow publishes one yet. `scripts/make-bundle.sh` collects the files; a release workflow should tar them. `KIT_VERSION` in `install.sh` is a placeholder (0.1.0).
- Docker Compose merges stdout and stderr, so every log line is reported as stdout. Following with dockerode per container would keep them apart.
- The installer does not record GPU support anywhere. The agent checks `/dev/dri/renderD128` each time it renders a service. The settings database now exists, so this can move there when the service settings page is built.
- `service.update` re-renders and pulls but takes no snapshot and does not roll back. That is M5.
- Agent audit log still goes to journald only. The dashboard writes its own audit rows (logins, setup, every service action) to SQLite, and nothing shows them yet: the audit log view belongs on the Settings page (M5).
- Settings page (change password, kit and system updates, reboot, audit log) is M5. The M2 dashboard has no change-password screen; `sudo selfhost reset-password` is the only way to change it.
- Install progress shows "Installing..." with a spinner, not an image pull percentage. The agent would need to stream pull progress.
- The Open button links to `http://<address you used>:<port>`. HTTPS remote URLs and QR codes arrive with Tailscale in M4.
- A failed install or start is remembered only in memory, so a dashboard restart clears the red card. The audit log keeps the history.
- The dashboard image is built on the server during install (it runs `npm install` for two native modules). A release workflow could publish a prebuilt image instead, which would also pin it by digest.
- `test/vm/m2-gate-inner.sh` has no Multipass wrapper. The browser part of the gate runs in CI only.
- Setup is a single page (code and password). The multi-step wizard (Tailscale, drives, services) is M4c and should reuse it.
- Nextcloud only reads `NEXTCLOUD_TRUSTED_DOMAINS` on its first start. M4b must add the Tailscale name afterwards with `occ config:system:set trusted_domains`, and the same goes for a LAN address that changes.
- Nextcloud and Immich first-run steps (creating the admin account) are left to the services' own pages, which the getting-started tips point to. Jellyfin's libraries are likewise made by hand.

- Storage: copying files into a new drive (`copyExisting`) uses `rsync` with no progress bar, and the original files stay on the system drive underneath the new mount. Streaming progress and offering to free the old copy are still to do.
- Storage: a drive that was unmounted from the dashboard mounts again at the next boot, because its unit stays enabled. There is no "forget this drive" action yet.
- Storage: services stopped by "Stop apps and unmount" are not started again. Folder changes do restart them.
- Storage: after a drive comes back, a container that was running keeps its old view of the folder until it is restarted. The card says so ("restart this service"), nothing restarts it automatically.
- Storage: `disk.format` is addressed by kernel name (`sdb`), which can change if a drive is replugged between the dialog and the click. The agent re-checks the disk is not mounted and not the system disk, but not that it is the same physical disk. Adding the serial number to the confirmation would close this.
- Storage: no SMART warning is shown on the Home page, only when the owner presses Check health.
- Storage: the filesystem check (`fsck`) for dirty NTFS and exFAT drives is not offered. A drive that will not mount says to check it on Windows.

## Session log

<!--
Template for each entry:

### YYYY-MM-DD: Mx <name>
- Built:
- Decisions made (and why):
- Not tested / needs the owner to check:
- Known issues:
- Next:
-->

### 2026-11-23: M4a Navidrome, Immich, Nextcloud
- Built: catalog entries for Navidrome 0.64.2, Immich v3.4.2 (server, machine learning, Valkey, Postgres with VectorChord) and Nextcloud 35.0.3 (app, cron, Postgres 16, Redis 8), each with a manifest and compose template. New manifest fields: `secrets` (with aliases), `credentials`, `libraryOwnerUid`, `health.expect` and `gpu.imageSuffix`. The agent now generates each service's secrets once into `/opt/selfhost/config/<name>/.env` (root, mode 0600, kept across updates), fills `NEXTCLOUD_TRUSTED_DOMAINS` from the machine's host name and LAN addresses, gives the Nextcloud web user (uid 33) the data folder, checks `"installed":true` in `/status.php`, and uses the OpenVINO machine learning image when the Intel GPU is present. New agent action `service.credentials` returns the Nextcloud admin login once and then refuses; `service.status` reports `credentialsPending`. The API has `POST /api/services/:name/credentials`. The service page shows a "Show my login" card with copy buttons. `test/vm/m4a-gate-inner.sh` and a `services-gate` CI job. 191 unit and integration tests and 32 Playwright tests pass.
- Decisions made (and why): all image pins are the latest stable releases on 2026-11-23 (owner's choice), taken from Immich's v3.4.2 release compose, without digests (digests belong with the release manifest in M5). Immich and Nextcloud database passwords and the Nextcloud admin password are 32 random bytes in hex. The admin password is shown once through the dashboard, as the plan says, and the agent records that in `.credentials-shown` before replying, so a crash can never show it twice. Nextcloud uses `TRUSTED_PROXIES` (the Docker network range) instead of `OVERWRITEPROTOCOL=https`: the plan's setting would break plain http on the LAN, whereas `tailscale serve` sends `X-Forwarded-Proto: https` and Nextcloud honours it from a trusted proxy. Immich containers run as the `selfhost` user (as in Immich's own rootless compose); Postgres and the Nextcloud app keep their image defaults. Template values may now contain spaces (for the trusted domain list), so templates must quote them.
- Not tested / needs the owner to check: the `services-gate` CI job passes on a GitHub Ubuntu 24.04 runner (Navidrome finds a song, Immich stores an uploaded photo, Nextcloud accepts a file, the Nextcloud login is shown once then refused, secrets are mode 0600 and unchanged by a second install). The owner installed Nextcloud on the VirtualBox VM from the dashboard, used "Show my login" once and signed in to Nextcloud with it. Still to run by hand after M4c, together with the phone test over Tailscale: memory use with all four services on small hardware (Immich machine learning is limited to 3 GB and Nextcloud to 2 GB, so 4 GB is tight), the Intel GPU (OpenVINO) image on a real mini PC, Music and Photos mapped to a real drive and the Nextcloud data folder on a mounted drive, opening each service from a second device on the LAN (Nextcloud rejects addresses it did not see at its first start), and removing a service with "keep data" then installing it again. Not covered anywhere: phone apps, and Nextcloud's `TRUSTED_PROXIES` behaviour behind `tailscale serve` (M4b).
- Known issues: the Nextcloud and Immich database containers also receive the other secrets in the shared `.env` (Nextcloud's admin password reaches its Postgres container). A lost Nextcloud admin password needs `occ user:resetpassword` from a terminal; there is no dashboard action for it yet.
- Next: M4b (Tailscale and remote access), in its own session.

### 2026-11-22: M3 Storage
- Built: agent actions `disk.list` (from `lsblk --json`, with the system disk flagged, free space and a 90 percent warning, and set-up drives that are not plugged in reported as missing), `disk.mount` and `disk.unmount` (systemd mount units named by path, by UUID, `nofail`, `WantedBy=multi-user.target`; ext4, NTFS through `ntfs3` and exFAT, with `uid`, `gid` and `umask` options for the two Windows formats), `disk.format` (wipefs, GPT with one partition, `mkfs.ext4`, mount, standard folders), `disk.smart` (`smartctl --json`, with a retry in SAT mode for USB bridges), `folder.assign` (a bind mount unit with `BindsTo` on the drive, optional `rsync` of existing files) and `folder.usage`. `service.status` now returns `missingFolders`, and the dashboard turns that into the Error state for a running service. The API has `GET /api/storage`, mount, unmount, format, SMART and folder endpoints, with format and copy running in the background and reported as a job. The web app has a Storage page: drives with space and health, set up, unmount ("Safe to unplug"), erase and prepare, and the library folder mapping. The installer now also installs `parted` and `rsync`. `test/vm/m3-gate-inner.sh` and a `storage-gate` CI job.
- Decisions made (and why): `disk.format` takes a device name (`sdb`, `nvme0n1`) instead of a filesystem UUID, because a blank disk has none; the schema allows only whole-disk kernel names and the agent checks the name against `lsblk` and refuses the system disk and any mounted disk. The confirm token is bound to the device name, and the dashboard asks the owner to type that name, plus password re-entry after 15 minutes. All disk and folder changes share one agent lock. The agent refuses to change a drive or folder while a service that uses it is running; the dashboard offers "Stop apps and unmount" and stops and restarts services itself. Only mount units carrying a marker comment are ever read or changed, so units the owner wrote by hand are left alone. A folder is never mapped over existing files unless the owner chooses to copy them. New drives are limited to 16 character names because of the ext4 label limit.
- Not tested / needs the owner to check: 171 unit and integration tests and 30 Playwright tests pass. The `storage-gate` CI job passes on a GitHub Ubuntu 24.04 runner using a virtual `scsi_debug` disk: installer, system disk refused, format, mount (`nofail`, enabled for boot), single-use confirm token, mounted disk protected, SMART call, folder mapping written as the `selfhost` user, a folder name with a space, unmount and mount again, a simulated unplug (the folder is reported missing and unmounted, the drive is listed as missing) and replug. It found two things: the runner's `/etc/fstab` has a broken `/mnt` entry (`ephemeral0`) that makes every `/mnt/<name>` mount fail with "Dependency failed" (the gate removes it; a normal server has none), and a fresh drive's UUID link can lag behind `mkfs`, so the agent now checks the mount is active and retries `systemctl start` for up to 10 seconds. The owner then ran the exit gate by hand in a VirtualBox VM (Ubuntu Server, a second blank SATA disk): after powering off and removing the disk, the server booted, the agent and dashboard came up, the movies folder was reported missing and nothing was mounted over it (`after-reboot-missing`); after attaching the disk again and rebooting, the drive and its folder mounted by themselves with the test file in place (`after-reboot-present`). Not covered anywhere: NTFS and exFAT with the `ntfs3` and `exfat` drivers, SMART through a real USB bridge, and real hardware.
- Known issues: see the Storage items under Later.
- Next: M4.

### 2026-11-22: M2 Dashboard core
- Built: the dashboard API (`apps/api`, Fastify): setup code and one admin account (argon2id), login with a 7 day session cookie, CSRF token on every change, lockout after 10 wrong passwords, password re-entry after 15 minutes for uninstall, an audit table in SQLite, and service endpoints. Install, start, stop, restart, update and uninstall run in the background and the page follows them over Server-Sent Events (`/api/status/stream`). A poller refreshes every 15 seconds and works out Online, Starting, Having problems, Offline, Error or Not installed. Live logs stream over SSE (`/api/services/:name/logs?follow=1`), with a download endpoint. An error detector counts problem lines and maps known ones to plain-English hints (`packages/shared/src/logs.ts`). The web app (`apps/web`, React, Tailwind, shadcn style components, TanStack Query): setup, sign in, Home with server health and service cards, and a service page with actions, getting-started tips, suggestions and a live log viewer. Agent changes: `confirm.issue` (the agent issues and verifies confirm tokens), `logs.stream` with `follow`, container start times and the health URL check in `service.status`, and `system.info` on `systeminformation` (CPU load, disk, temperature). Installer: builds and starts the dashboard container, prints a setup code once, `selfhost reset-password`, and `uninstall.sh` removes the dashboard. 108 unit and integration tests, 14 Playwright UI tests, and the `dashboard-gate` CI job.
- Decisions made (and why): The agent issues confirm tokens (single use, five minutes, bound to one action and target) instead of sharing a secret with the dashboard, so no key file is needed. The agent runs the service health check on the host (`service.status` returns `http`), because a container reaching host ports is blocked by ufw. The setup code is stored as a SHA-256 hash in `/var/lib/selfhost/setup-code` and is printed on the terminal only, never to the install log. `selfhost reset-password` writes a new code file, and the dashboard treats a code file next to an existing admin as a password reset (it signs everyone out). Followed logs use `spawn` with an argument array and no shell instead of `execFile`, because `execFile` keeps all output in memory. better-sqlite3 is pinned to 12.11.1 because 13.x has no Windows prebuilt binary for Node 22 (the dev machine is Windows). The two native modules stay outside the API bundle and are installed in the dashboard image. Mobile layout was checked in a 375 pixel wide test.
- Not tested / needs the owner to check: the `dashboard-gate` job passes on a GitHub Ubuntu 24.04 runner (installer run twice, dashboard locked down, a browser sets up the dashboard and installs, stops, starts, restarts and removes Jellyfin, then a restart, `reset-password` and `uninstall.sh`). It found two problems before passing: systemd recreated `/run/selfhost` on every agent restart, which cut the dashboard off from the agent (fixed with `RuntimeDirectoryPreserve=yes`), and a test selector. The owner then ran it by hand in a VirtualBox VM from a Windows-built bundle, which found a bug CI could not: files copied from Windows arrived with root-only directory permissions, so the dashboard could not read its own assets and showed a white page. Fixed in `install.sh`, `scripts/make-bundle.sh` and the Dockerfile, and a missing file now returns a real 404. Not covered: real hardware, a phone browser, the dashboard behind `tailscale serve`, and a Multipass VM run. Unit and UI tests ran on Windows (named pipes in place of the Unix socket, Edge for Playwright).
- Known issues: none known beyond the Later list.
- Next: M3.

### 2026-11-22: M1 First slice: installer + Jellyfin
- Built: `install.sh` (preflight, base packages and automatic security updates, Docker from Docker's apt repo, Tailscale installed but not logged in, Intel video driver, `selfhost` user and folders, bundled Node and agent, systemd unit, ufw, log to `/var/log/selfhost-install.log`) and `uninstall.sh` (keeps settings and media unless asked, separately). Agent actions `service.install`, `start`, `stop`, `restart`, `update`, `uninstall`, `logs.stream` and `logs.download`, using a new `HostFs` layer so dry-run and tests never touch disk. Compose templates are now bundled into `agent.cjs` (tsup text loader, plus a small plugin in `vitest.config.ts`). The `selfhost` command (`deploy/selfhost-cli.mjs`, installed as `/usr/local/bin/selfhost`) is a thin client for the agent. `test/vm/m1-gate-inner.sh` and `m1-gate.sh`, and an `install-gate` CI job.
- Decisions made (and why): Jellyfin pinned to 12.4, the latest stable on 2026-11-22 (the owner chose "latest stable"). Catalog manifests gained `configDirs`, so the agent creates config folders owned by `selfhost`; otherwise Docker creates bind mounts as root and Jellyfin cannot write. The playback check asserts Jellyfin indexes the test video and serves its first bytes with direct play, not a real browser (owner approved). The CLI is `sudo selfhost <command>`, because the socket is `root:selfhost 0660`. The agent dev script now builds with tsup first, since `.tmpl` imports need the loader.
- Not tested / needs the owner to check: the `install-gate` job passes on a GitHub Ubuntu 24.04 runner (installer run twice, Jellyfin 12.4 installed, test video indexed and served, stop/start/logs, both uninstalls). Not covered: real hardware, the Intel GPU path (the runner has no `/dev/dri`), a Tailscale login, a real release download, and playback in a browser. `test/vm/m1-gate.sh` (Multipass) has not been run. The gate had to use the `Authorization: MediaBrowser` header because Jellyfin 12 ignores `X-Emby-Authorization`.
- Known issues: `selfhost status` prints the first non-Docker, non-Tailscale IPv4 address, which may be the wrong one on a machine with several network cards.
- Next: M2.

### 2026-11-22: M0 Foundations
- Built: pnpm workspace (shared, catalog, agent, plus empty web and api placeholders); Zod request schemas for all 28 v1 agent actions with strict argument types; newline-delimited JSON protocol with error codes; catalog manifest schema, template renderer and a Jellyfin entry; agent with socket server, per-service lock, confirm-token presence check, execFile-only runner, `--dry-run`, and working `agent.version`, `system.info`, `service.status` and `tailscale.status`; systemd unit; CI workflow; VM gate script. 39 unit and integration tests.
- Decisions made (and why): TypeScript pinned to 6.x (typescript-eslint does not support 7). The agent bundles to one CommonJS file with ssh2 stubbed out, because dockerode pulls in ssh2's native modules and the agent only uses the local Docker socket. Not-yet-built actions are valid in the schema but return `not_implemented`. Added `tailscale.status` to the M0 handlers at the owner's request.
- Not tested / needs the owner to check: the M0 gate (`test/vm/m0-gate-inner.sh`) passes in the `agent-gate` CI job on an Ubuntu 24.04 runner, which covers the systemd unit, socket permissions and real Docker. `test/vm/m0-gate.sh` (Multipass) has not been run, since Multipass did not work on the dev machine. Real `tailscale status` output is untested because Tailscale is not installed on the runner. Unit tests ran on Windows with a named pipe in place of a Unix socket.
- Known issues: none known.
- Next: M1.

### 2026-11-22: Planning
- Built: `docs/PLAN.md`, `CLAUDE.md`, this file.
- Decisions made: see "Decisions made" in `docs/PLAN.md`.
- Next: start M0.
