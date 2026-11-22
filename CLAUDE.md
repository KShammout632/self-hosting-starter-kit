# CLAUDE.md

Self-hosting starter kit: one command turns a fresh Ubuntu Server 24.04 machine into a home media and file server (Jellyfin, Navidrome, Immich, Nextcloud), managed from a web dashboard by people who are not comfortable with the terminal.

## Read first

- `docs/PLAN.md`: the full plan (architecture, agent actions, services, security, milestones). It is the source of truth for scope.
- `docs/PROGRESS.md`: what earlier sessions built, decisions they made, and what is next. Read it before starting work.

## Key decisions (do not change without asking)

- Target: Ubuntu Server 24.04 LTS on x86-64 only. Intel integrated graphics used when present; no discrete GPU support.
- Remote access: Tailscale only (`tailscale serve`). No port forwarding, no public sharing mode.
- Accounts: exactly one dashboard admin account. Each service keeps its own users. No SSO.
- Services run as Docker Compose stacks, one per service, image versions pinned.
- No scheduled backups in v1; only automatic pre-update snapshots for rollback.
- License: GPL.

## Stack

- pnpm workspaces monorepo, TypeScript everywhere
- `apps/web`: React + Vite, shadcn/ui, Tailwind, TanStack Query
- `apps/api`: Fastify dashboard backend, Server-Sent Events for logs and status, SQLite (better-sqlite3)
- `apps/agent`: root host agent (systemd), dockerode, newline-delimited JSON over `/run/selfhost/agent.sock`
- `packages/shared`: Zod schemas and types shared by web, api and agent
- `packages/catalog`: one folder per service with `manifest.ts` and `compose.yml.tmpl`
- `install.sh`: bash installer; must stay idempotent
- Tests: Vitest (unit, agent), Playwright (UI), VM-based full install tests

## Security rules for the agent (non-negotiable)

- Only actions in the Zod discriminated union in `packages/shared` are accepted; reject everything else.
- Every argument is an enum, UUID, bounded number, or a string matching a strict regex. No free-form paths or commands.
- Run commands with `execFile` and fixed argument arrays. Never `exec`, never a shell, never string-built commands.
- The dashboard never gets the Docker socket or root; it only talks to the agent socket.
- Destructive actions (format, uninstall with data) require a confirm token issued after typed confirmation.
- Keep `--dry-run` working so the agent can be developed without touching real disks or containers.

## Working conventions

- One milestone (or sub-milestone) per session, on its own branch named like `m2-dashboard-core`.
- Start by proposing a task breakdown and wait for approval before writing code.
- Keep changes inside the current milestone's scope; note anything else in `docs/PROGRESS.md` under "Later".
- Before finishing: run lint, type check and tests, check the milestone's exit gate from `docs/PLAN.md`, update `docs/PROGRESS.md`, then open a pull request.
- Install tests need a real Ubuntu VM or hardware, which a cloud session may not have. Say what was not tested so the owner can run it.
- UI text is plain English for non-technical users; hide technical detail behind a "Show details" toggle.
- Writing style in docs, UI copy and comments: no em dashes.

## Commands

Not set up yet. Add the real commands here once M0 creates them (install, dev, lint, typecheck, test).
