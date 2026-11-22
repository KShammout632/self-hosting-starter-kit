# Progress

Each session updates this file before opening its pull request. Newest entry first.

## Status

| Milestone | Status | Branch / PR |
| --- | --- | --- |
| M0 Foundations | Done, exit gate passed in CI (`agent-gate`) | `m0-foundations` |
| M1 First slice: installer + Jellyfin | Built, `install-gate` CI job not yet run | `m1-installer-jellyfin` |
| M2 Dashboard core | Not started | |
| M3 Storage | Not started | |
| M4 All services, wizard, remote access | Not started | |
| M5 Updates and docs | Not started | |
| M6 Beta to 1.0 | Not started | |

## Next up

Merge M1 once the `install-gate` CI job passes, then start M2 (dashboard core).

## Later

Ideas and follow-ups found during work that are outside the current milestone.

- Confirm tokens: M0 only checks that a token is present on destructive actions. The agent must verify the token itself (issued by the API after typed confirmation) before M2/M3 rely on it.
- Release packaging: `install.sh` downloads `selfhost-kit-<version>-linux-x64.tar.gz` plus a `.sha256` from a GitHub release, but no workflow publishes one yet. `scripts/make-bundle.sh` collects the files; a release workflow should tar them. `KIT_VERSION` in `install.sh` is a placeholder (0.1.0).
- The `selfhost` CLI mints its own confirm token after a typed service name. When the API arrives (M2) it should issue tokens, and the agent should verify them (see the confirm token item above).
- `logs.stream` returns the last N lines and ends; it does not follow. Live follow arrives with SSE in M2. Docker Compose merges stdout and stderr, so every line is reported as stdout.
- The installer does not record GPU support anywhere. The agent checks `/dev/dri/renderD128` each time it renders a service. Revisit when the settings database exists (M2).
- `service.update` re-renders and pulls but takes no snapshot and does not roll back. That is M5.
- The installer leaves the dashboard container and the setup code out. Both arrive in M2.
- Agent audit log goes to journald only. The SQLite audit table from the plan arrives with the API in M2.
- `system.info` uses Node's `os` module. Switch to `systeminformation` when the dashboard needs disk and temperature data.

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

### 2026-11-22: M1 First slice: installer + Jellyfin
- Built: `install.sh` (preflight, base packages and automatic security updates, Docker from Docker's apt repo, Tailscale installed but not logged in, Intel video driver, `selfhost` user and folders, bundled Node and agent, systemd unit, ufw, log to `/var/log/selfhost-install.log`) and `uninstall.sh` (keeps settings and media unless asked, separately). Agent actions `service.install`, `start`, `stop`, `restart`, `update`, `uninstall`, `logs.stream` and `logs.download`, using a new `HostFs` layer so dry-run and tests never touch disk. Compose templates are now bundled into `agent.cjs` (tsup text loader, plus a small plugin in `vitest.config.ts`). The `selfhost` command (`deploy/selfhost-cli.mjs`, installed as `/usr/local/bin/selfhost`) is a thin client for the agent. `test/vm/m1-gate-inner.sh` and `m1-gate.sh`, and an `install-gate` CI job.
- Decisions made (and why): Jellyfin pinned to 12.4, the latest stable on 2026-11-22 (the owner chose "latest stable"). Catalog manifests gained `configDirs`, so the agent creates config folders owned by `selfhost`; otherwise Docker creates bind mounts as root and Jellyfin cannot write. The playback check asserts Jellyfin indexes the test video and serves its first bytes with direct play, not a real browser (owner approved). The CLI is `sudo selfhost <command>`, because the socket is `root:selfhost 0660`. The agent dev script now builds with tsup first, since `.tmpl` imports need the loader.
- Not tested / needs the owner to check: **the `install-gate` job has not run.** `install.sh`, `uninstall.sh` and the gate scripts were only syntax checked (`bash -n`) on Windows; the gate also assumes Jellyfin 12.4's first-run API (`/Startup/*`, `/Users/AuthenticateByName`, `/Library/VirtualFolders`) matches 10.x. Likely failure points are a conflict with the Docker apt source already on the CI runner, and the firewall step on the runner. Not tested anywhere: the Intel GPU path, Tailscale install, and a real release download. The agent unit tests and the dry-run agent with the CLI do run (Windows named pipe).
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
