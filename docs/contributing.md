# Contributing

Thanks for helping. This page explains how the project is laid out, how to run it on your own computer, and how to add an app.

Read [PLAN.md](PLAN.md) first. It is the source of truth for what the kit does and why. [PROGRESS.md](PROGRESS.md) records what each build session did, the decisions it made and what is still open.

## Layout

| Path | What it is |
| --- | --- |
| `install.sh`, `uninstall.sh` | The bash installer and uninstaller. The installer must stay safe to run twice. |
| `apps/web` | The dashboard pages (React, Vite, shadcn/ui, Tailwind, TanStack Query). |
| `apps/api` | The dashboard backend (Fastify, SQLite). Talks to the agent only. |
| `apps/agent` | The root helper (systemd). The only part that touches Docker, disks and Tailscale. |
| `packages/shared` | Zod schemas and types used by the web app, the API and the agent. |
| `packages/catalog` | One folder per app, with a `manifest.ts` and a `compose.yml.tmpl`. |
| `deploy` | The systemd unit, the dashboard compose file, the `selfhost` command and the kit update script. |
| `scripts` | Release bundle and packaging scripts. |
| `test/vm` | Scripts that run the real installer and check the result. |

It is a pnpm workspace in TypeScript, so the web app, API and agent share types and validation.

## Run it on your computer

You need Node 22 and pnpm 9 (`corepack enable` gives you pnpm).

```bash
pnpm install
pnpm lint
pnpm format:check      # pnpm format fixes it
pnpm typecheck
pnpm test
pnpm build
```

To work on the interface or the agent without a server:

- `pnpm --filter @selfhost/agent dev` runs the agent in dry-run mode on a local socket. Dry-run logs what would happen and does not touch real disks or containers.
- `pnpm --filter @selfhost/web dev` runs the web app with a dev server that proxies `/api` to port 8080.
- `pnpm --filter @selfhost/web e2e` runs the Playwright browser tests with the API mocked. Set `PW_CHANNEL=msedge` or `chrome` to use a browser you already have.

## The agent's security rules

The agent runs as root, so it is deliberately small. These rules are not negotiable and a pull request that breaks one will not be merged.

- Only actions in the Zod union in `packages/shared` are accepted. Everything else is rejected.
- Every argument is an enum, a UUID, a bounded number or a string matching a strict pattern. No free-form paths or commands.
- Commands run with `execFile` and a fixed list of arguments. Never `exec`, never a shell, never a command built from strings.
- The dashboard never gets the Docker socket or root. It only talks to the agent socket.
- Destructive actions (erasing a drive, removing an app's data, restoring a saved copy, restarting the server) need a confirm token the agent issues after the user types a confirmation.
- Updates to the kit and the server take a server-wide lock and wait for everything else.
- `--dry-run` must keep working.

## Adding an app

An app is a folder in `packages/catalog`, but a few other places list the apps too. Do all of these:

1. **Manifest.** Make `packages/catalog/<name>/manifest.ts`, modelled on an existing one. It sets the name, ports (LAN and remote), pinned images with digests, library folders, config folders, the health check address and the first-login tips. Image tags must be pinned: `latest` is rejected.
2. **Template.** Make `packages/catalog/<name>/compose.yml.tmpl`. Quote every value you substitute.
3. **Register it.** Add it to `packages/catalog/src/index.ts`, `packages/catalog/src/templates.ts` and the service name list in `packages/shared/src/primitives.ts`, and to the `SERVICES` table in `deploy/selfhost-cli.mjs`.
4. **Ports.** Pick a LAN port and a different remote port, so `tailscale serve` never competes with Docker. Update the port tables in [PLAN.md](PLAN.md) and in [remote-access.md](remote-access.md).
5. **Tests.** Add unit tests (the catalog tests check manifests and rendering), and a check in a VM gate script that the app really starts and answers its health address.
6. **Docs.** Add the app to the [user guide](user-guide.md) (first login and folders) and to the [README](../README.md).

Keep upstream's own compose file as the reference, and move all images of one app together. Immich in particular ships breaking changes often, so only move to versions the kit has tested.

## Tests

| Level | Tool | When |
| --- | --- | --- |
| Unit and agent integration | Vitest (the agent uses its dry-run mode and fake `lsblk` and `systemctl` output) | Every pull request |
| UI | Playwright with the API mocked | Every pull request |
| Full install and upgrade | GitHub Actions on an Ubuntu 24.04 runner, driven by the scripts in `test/vm` | Every pull request, one job per milestone gate |
| Hardware | Manual checklist on a real mini PC | Before a release |

The gate scripts (`m0-gate-inner.sh` and so on) run the real installer and check the result. `m0-gate.sh` and `m1-gate.sh` run the first two in a Multipass VM. CI runs the `*-inner.sh` scripts straight on the runner, in jobs named `agent-gate`, `install-gate`, `dashboard-gate`, `storage-gate`, `services-gate`, `update-gate`, `kit-update-gate` and `tailscale-gate`.

The `tailscale-gate` job's second part needs an ephemeral auth key from a throwaway tailnet in the `TS_AUTHKEY` repository secret. It expires after at most 90 days. When that job fails at "Join the tailnet", make a new key and replace the secret.

## Style

- Plain English in docs, interface text and comments. No em dashes.
- The dashboard is for people who are not comfortable with the terminal. Put technical detail behind a **Show details** toggle.
- Add a code comment only when it explains something the code cannot: why it is done a certain way, a hidden constraint, or a security reason. Do not describe what the code plainly does.

## How work is organised

Work is split into milestones, one branch each, named like `m5c-docs`. A milestone starts with a task breakdown, stays inside its scope, and ends with lint, type check and tests passing, the exit gate from the plan checked, `PROGRESS.md` updated and a pull request opened. Things found along the way that are outside the milestone go under "Later" in `PROGRESS.md`.

## Releasing

1. Change `version` in `apps/agent/package.json` and `KIT_VERSION` in `install.sh` to the same value. A unit test fails if they differ.
2. Merge to `main`.
3. Push a tag named `v<version>`, for example `v0.2.0`.

`.github/workflows/release.yml` then runs the checks, builds the release, signs it and publishes three files on GitHub: the tarball, its `.sha256` checksum and `.sha256.sig`, an Ed25519 signature of the checksum file. Before publishing, it checks the release with `scripts/check-release.sh`, which runs the installer's own check, so a signing key that does not match the public key fails the release instead of every install. The installer and the kit update both download the three files and refuse anything whose signature does not match the public key built into them. Until a release for the installer's version exists, the installer cannot download anything.

### The signing key

The public key is in two places that must match (a unit test checks): `RELEASE_PUBLIC_KEY` in `install.sh` and in `apps/agent/src/release-key.ts`. The private key is the `RELEASE_SIGNING_KEY` repository secret. While the public key is empty, the installer cannot download a release and the kit cannot update itself.

To make a key (once, or to replace a lost or leaked one), run from the repo root on a Linux machine or in Git Bash:

```bash
bash scripts/new-release-key.sh ~/selfhost-release-key.pem
gh secret set RELEASE_SIGNING_KEY < ~/selfhost-release-key.pem
```

The script refuses to write the private key inside the repository. Keep an offline copy of it somewhere safe (a password manager or an encrypted USB stick), then delete the file. Commit the changed public key in `install.sh` and `release-key.ts`.

Replacing the key: servers only trust the key built into the version they run. Release the new public key in a version that is still signed with the old key, so existing servers can update to it, and sign every release after that with the new key. If the old key leaked, people have to run the new installer by hand instead, because an update signed with a leaked key proves nothing.

`test/release-signing.sh` (run in CI) signs a release with a throwaway key and checks that the installer's check accepts it and refuses a changed tarball, a changed checksum, another key, a missing signature and a checksum for another file. The `kit-update-gate` job does the same for the agent, which takes a test key through `SELFHOST_RELEASE_KEY` only in a test build.

## Licence

By contributing you agree your work is released under the GPL, the same licence as the project.
