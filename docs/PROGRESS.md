# Progress

Each session updates this file before opening its pull request. Newest entry first.

## Status

| Milestone | Status | Branch / PR |
| --- | --- | --- |
| M0 Foundations | Done except the VM gate (owner to run) | `m0-foundations` |
| M1 First slice: installer + Jellyfin | Not started | |
| M2 Dashboard core | Not started | |
| M3 Storage | Not started | |
| M4 All services, wizard, remote access | Not started | |
| M5 Updates and docs | Not started | |
| M6 Beta to 1.0 | Not started | |

## Next up

Run `test/vm/m0-gate.sh` on a machine with Multipass to close the M0 exit gate, then start M1: install.sh (preflight, Docker, Tailscale, folders, systemd agent), agent service actions, and a CLI helper for Jellyfin.

## Later

Ideas and follow-ups found during work that are outside the current milestone.

- Confirm tokens: M0 only checks that a token is present on destructive actions. The agent must verify the token itself (issued by the API after typed confirmation) before M2/M3 rely on it.
- Catalog templates are read from disk next to the source (`loadComposeTemplate`). Decide in M1 how the agent bundle ships them (copy the catalog folder, or embed with an esbuild text loader).
- Jellyfin is pinned to 10.10.7 in its manifest. Check this is the version we want to ship when M1 tests the install.
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

### 2026-11-22: M0 Foundations
- Built: pnpm workspace (shared, catalog, agent, plus empty web and api placeholders); Zod request schemas for all 28 v1 agent actions with strict argument types; newline-delimited JSON protocol with error codes; catalog manifest schema, template renderer and a Jellyfin entry; agent with socket server, per-service lock, confirm-token presence check, execFile-only runner, `--dry-run`, and working `agent.version`, `system.info`, `service.status` and `tailscale.status`; systemd unit; CI workflow; VM gate script. 39 unit and integration tests.
- Decisions made (and why): TypeScript pinned to 6.x (typescript-eslint does not support 7). The agent bundles to one CommonJS file with ssh2 stubbed out, because dockerode pulls in ssh2's native modules and the agent only uses the local Docker socket. Not-yet-built actions are valid in the schema but return `not_implemented`. Added `tailscale.status` to the M0 handlers at the owner's request.
- Not tested / needs the owner to check: `test/vm/m0-gate.sh` has never been run (no VM on the dev machine). Socket mode 0660 and root:selfhost ownership, the systemd unit, real Docker via dockerode, and real `tailscale status` output are untested. Tests ran on Windows with a named pipe in place of a Unix socket. The GitHub Actions workflow has not run yet.
- Known issues: none known.
- Next: run the VM gate, then M1.

### 2026-11-22: Planning
- Built: `docs/PLAN.md`, `CLAUDE.md`, this file.
- Decisions made: see "Decisions made" in `docs/PLAN.md`.
- Next: start M0.
