# Progress

Each session updates this file before opening its pull request. Newest entry first.

## Status

| Milestone | Status | Branch / PR |
| --- | --- | --- |
| M0 Foundations | Done, exit gate passed in CI (`agent-gate`) | `m0-foundations` |
| M1 First slice: installer + Jellyfin | Done, exit gate passed in CI (`install-gate`) | `m1-installer-jellyfin` |
| M2 Dashboard core | Built, waiting for the `dashboard-gate` CI job to pass on the pull request | `m2-dashboard-core` |
| M3 Storage | Not started | |
| M4 All services, wizard, remote access | Not started | |
| M5 Updates and docs | Not started | |
| M6 Beta to 1.0 | Not started | |

## Next up

Get the M2 exit gate (`dashboard-gate` in CI) green, merge, then start M3 (storage).

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
- The "missing mounted folder" Error state needs the storage model from M3.
- A failed install or start is remembered only in memory, so a dashboard restart clears the red card. The audit log keeps the history.
- The dashboard image is built on the server during install (it runs `npm install` for two native modules). A release workflow could publish a prebuilt image instead, which would also pin it by digest.
- `test/vm/m2-gate-inner.sh` has no Multipass wrapper. The browser part of the gate runs in CI only.
- Setup is a single page (code and password). The multi-step wizard (Tailscale, drives, services) is M4 and should reuse it.

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

### 2026-11-22: M2 Dashboard core
- Built: the dashboard API (`apps/api`, Fastify): setup code and one admin account (argon2id), login with a 7 day session cookie, CSRF token on every change, lockout after 10 wrong passwords, password re-entry after 15 minutes for uninstall, an audit table in SQLite, and service endpoints. Install, start, stop, restart, update and uninstall run in the background and the page follows them over Server-Sent Events (`/api/status/stream`). A poller refreshes every 15 seconds and works out Online, Starting, Having problems, Offline, Error or Not installed. Live logs stream over SSE (`/api/services/:name/logs?follow=1`), with a download endpoint. An error detector counts problem lines and maps known ones to plain-English hints (`packages/shared/src/logs.ts`). The web app (`apps/web`, React, Tailwind, shadcn style components, TanStack Query): setup, sign in, Home with server health and service cards, and a service page with actions, getting-started tips, suggestions and a live log viewer. Agent changes: `confirm.issue` (the agent issues and verifies confirm tokens), `logs.stream` with `follow`, container start times and the health URL check in `service.status`, and `system.info` on `systeminformation` (CPU load, disk, temperature). Installer: builds and starts the dashboard container, prints a setup code once, `selfhost reset-password`, and `uninstall.sh` removes the dashboard. 108 unit and integration tests, 14 Playwright UI tests, and the `dashboard-gate` CI job.
- Decisions made (and why): The agent issues confirm tokens (single use, five minutes, bound to one action and target) instead of sharing a secret with the dashboard, so no key file is needed. The agent runs the service health check on the host (`service.status` returns `http`), because a container reaching host ports is blocked by ufw. The setup code is stored as a SHA-256 hash in `/var/lib/selfhost/setup-code` and is printed on the terminal only, never to the install log. `selfhost reset-password` writes a new code file, and the dashboard treats a code file next to an existing admin as a password reset (it signs everyone out). Followed logs use `spawn` with an argument array and no shell instead of `execFile`, because `execFile` keeps all output in memory. better-sqlite3 is pinned to 12.11.1 because 13.x has no Windows prebuilt binary for Node 22 (the dev machine is Windows). The two native modules stay outside the API bundle and are installed in the dashboard image. Mobile layout was checked in a 375 pixel wide test.
- Not tested / needs the owner to check: the `dashboard-gate` job (installer plus a real browser setting up the dashboard and running Jellyfin) has not run yet, since the dev machine is Windows without Docker. The dashboard Dockerfile and compose file, the installer changes and `reset-password` on Linux are covered only by that job. Not covered at all: real hardware, a phone browser, the dashboard behind `tailscale serve`, and a Multipass VM run. Unit and UI tests ran on Windows (named pipes in place of the Unix socket, Edge for Playwright).
- Known issues: none known beyond the Later list.
- Next: get the gate green, then M3.

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
