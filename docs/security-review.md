# Security review of the host agent (M6b)

Date: 2026-11-24. Version reviewed: 0.1.0 (the code on `main` after M6a), fixes released in 0.9.0.

## Scope and method

The review covered `apps/agent`, `packages/shared`, `deploy/` (the agent unit, the dashboard container, `apply-update.sh` and the `selfhost` command), `install.sh` and `uninstall.sh`. It checked them against the agent rules in `CLAUDE.md` and the security model in `docs/PLAN.md`, by reading every handler and every place that starts a process or writes a file as root.

The question asked of each part was: what can someone who controls one of these do to the server?

- **The dashboard container.** It runs as the `selfhost` user, owns `/var/lib/selfhost` and can talk to the agent socket. The plan says the agent allowlist protects against a compromised dashboard.
- **An app container** (Jellyfin, Navidrome, Immich, Nextcloud). It can write to its own config folders, and Immich and Nextcloud can write to their library folders, which may be on an external drive.
- **A drive from somewhere else.** It can hold any files, including symlinks and setuid programs.
- **Output of the programs the agent runs.** This covers lsblk, smartctl, docker and tailscale.

Not in scope: the dashboard API and web app (except where they handle what the agent returns), the apps themselves, and Tailscale.

## Summary

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| SR-1 | High | Root wrote files through symlinks in `/var/lib/selfhost`, a folder the dashboard owns | Fixed |
| SR-2 | High | `folder.assign` followed symlinks on a drive, so root could chown, copy into and bind-mount any host folder | Fixed |
| SR-3 | Medium | Drives and library folders were mounted without `nosuid` and `nodev` | Fixed |
| SR-4 | Medium | The `selfhost` group the user guide suggests for copying files also opens the agent socket | Accepted, docs fixed, separate group under Later |
| SR-5 | Low | Anyone who can use the socket can get a confirm token | Accepted |
| SR-6 | Low | Nothing stopped a test build of the agent from being published | Fixed |
| SR-7 | Low | The new partition name from lsblk went to `mkfs.ext4` without a check | Fixed |
| SR-8 | Low | SMART values from the drive were passed on without a type check | Fixed |
| SR-9 | Low | The dashboard can rewrite the kit update status file | Accepted |
| SR-10 | Low | App containers run without `no-new-privileges` or dropped capabilities | Accepted, under Later |
| SR-11 | Info | Action allowlist and argument checks | No issue found |
| SR-12 | Info | How commands run, and files root writes that are later run or read as config | No issue found beyond SR-1 and SR-2 |
| SR-13 | Info | The socket and what each container can reach | No issue found beyond SR-4 |
| SR-14 | Info | Dry-run and test-build switches | No issue found beyond SR-6 |
| SR-15 | Info | Kit updates, signature check, `apply-update.sh` and rollback | No issue found beyond SR-1 |
| SR-16 | Info | Secrets and logs | No issue found |
| SR-17 | Info | Parsing output from other programs | No issue found beyond SR-7 and SR-8 |

## Findings

### SR-1 High: root wrote through symlinks in `/var/lib/selfhost`

**Where:**
- `realFs.writeFile` in `apps/agent/src/host.ts`, used for `/var/lib/selfhost/kit-update.json`.
- `write_status` in `deploy/apply-update.sh`.
- `reset-password` in `deploy/selfhost-cli.mjs`.
- `prepare_setup_code` in `install.sh`.

**Problem:** `/var/lib/selfhost` belongs to the `selfhost` user, and the dashboard container runs as that user with the folder mounted read-write. Four root writers wrote there by name:

- The agent and `apply-update.sh` wrote a fixed `<file>.tmp` name and renamed it. `apply-update.sh` also ran `chmod 0644` on it.
- `selfhost reset-password` and the installer wrote `setup-code` directly, then ran `chown selfhost` on it.

All of these follow symlinks. A compromised dashboard could plant `setup-code -> /etc/passwd` and wait for the owner to run `sudo selfhost reset-password`. That would overwrite `/etc/passwd` and give it to the `selfhost` user, which is root access. The status file writes allowed overwriting any file with JSON during a kit update.

**Fix:**
- The agent writes a temporary file with a random name, opened with `O_EXCL` (`wx`), which never follows a link. It then renames it over the final name, which replaces a link instead of following it.
- The `selfhost` command does the same, and sets the owner and mode through the open file (`fchown`, `fchmod`).
- `install.sh` and `apply-update.sh` build the file in a folder made by `mktemp -d` under `/var/lib`, which only root can use, then `mv` it into place. The installer also treats a symlink at `setup-code` as no setup code, so it is replaced.

**Tests:**
- `apps/agent/src/host.test.ts` and `apps/agent/src/cli.test.ts` plant links at the old temporary name, at the final name, and as a dangling link.
- `test/root-writes.sh` runs the real `write_status` and `prepare_setup_code` functions against planted links (CI `check` job).

The symlink cases need Linux, so they are skipped on Windows and run in CI.

### SR-2 High: `folder.assign` followed symlinks on a drive

**Where:** `assignFolder` in `apps/agent/src/storage.ts`.

**Problem:** the subpath regex blocks `..`, but any folder on the drive can itself be a symlink. A drive from another computer can hold one, and so can a library folder that Immich or Nextcloud writes to. If `Nextcloud/evil -> /` existed on the drive and the owner pointed Photos at `Nextcloud/evil`, the agent would do three things as root:

1. `chown` the link target to `selfhost`.
2. `rsync` the old photos into it.
3. Bind-mount it onto `/srv/photos`, which Immich mounts read-write.

That hands `/` to an app container.

**Fix:** before creating anything, the agent resolves the volume and every existing part of the subpath (`realPath`). It refuses with "That folder is a shortcut to somewhere else" if any part resolves elsewhere. After creating the folder it checks the whole path again.

**Tests:** in `apps/agent/src/storage.test.ts`, a link at the folder itself and a link at a folder above it are both refused. The tests also check that no folder was created, nothing was copied, and no unit was written.

**Accepted remainder:** an app could swap a real folder for a link in the moment between the check and the mount. The app would have to know which folder the owner is about to choose and win a race of a few milliseconds. SR-3 limits what a mounted folder could then do.

### SR-3 Medium: drives were mounted without `nosuid` and `nodev`

**Where:** `mountVolume` and `assignFolder` in `apps/agent/src/storage.ts`.

**Problem:** a drive holds files from other computers and from app containers that run as root (Nextcloud's container starts as root). A setuid-root program or a device file on the drive worked on the server.

**Fix:** drive mount units now use `Options=nofail,nosuid,nodev` (plus the owner options for NTFS and exFAT). Library folder units use `Options=bind,nosuid,nodev`. Units are rewritten each time a drive is mounted from the dashboard.

**Tests:** `storage.test.ts` checks the unit text. `storage-gate` (`test/vm/m3-gate-inner.sh`) checks the unit and that the real mount is `nosuid`.

### SR-4 Medium: the file-copy group also opens the agent socket

**Where:** the socket is `root:selfhost 0660` (`apps/agent/src/socket.ts`). The user guide (`docs/user-guide.md`) tells the owner to join the `selfhost` group to copy files into `/srv`.

**Problem:** any member of `selfhost` can send any allowed action to the agent. Because of SR-5, that includes erasing drives.

**Decision:** accepted for now. The guide tells the owner to add only their own account, and that account already has `sudo`. The guide now says plainly that the group can manage the server and must not be given to anyone else.

A separate socket group, used only by the dashboard container, is under Later in `docs/PROGRESS.md`. It changes the installer, the dashboard compose file and the update script, so it needs its own change and an upgrade test.

### SR-5 Low: anyone who can use the socket can get a confirm token

**Where:** the `confirm.issue` action (`apps/agent/src/handlers.ts`).

**Problem:** a confirm token proves that a typed confirmation happened in the dashboard or the `selfhost` command, which both ask for one. It does not stop a compromised dashboard, which can ask for a token itself.

**Decision:** accepted. The tokens are there to stop mistakes, double clicks and replayed requests. They do that well:

- They last 5 minutes and are kept in memory only.
- Each is used once, consumed before the action runs, even if it then fails.
- Each is bound to the action kind and the target (service name, kernel disk name, or `server`).

`disk.format` also re-reads lsblk and refuses if the `diskId` the user saw has changed. A `snapshot.restore` token is bound to the service, not to one saved copy; any saved copy of that service is an acceptable target. A dashboard that is fully compromised can already do anything on the allowlist. The allowlist, not the token, is what limits it.

### SR-6 Low: nothing stopped a test build from being published

**Where:** `scripts/package-release.sh`, `.github/workflows/release.yml`.

**Problem:** a test build (`SELFHOST_TEST_BUILD=1`) honours `SELFHOST_RELEASE_BASE` and `SELFHOST_RELEASE_KEY`. A release built that way by mistake would have that switch built in.

**Fix:** the agent has a `--build-info` flag that prints its version and whether it is a test build. `package-release.sh` refuses to package anything but a release build of the version being released.

**Test:** `test/release-signing.sh` makes a test build and checks that it is refused. A unit test covers the flag.

### SR-7 Low: the partition name went to `mkfs.ext4` unchecked

**Where:** `waitForPartition` in `apps/agent/src/storage.ts`.

**Fix:** the name must be the disk's own partition (`sdb1`, `nvme0n1p1`), or nothing is formatted.

**Test:** `storage.test.ts` gives the disk a partition named after another disk and checks that `mkfs.ext4` never runs.

### SR-8 Low: SMART values were passed on without a type check

**Where:** `diskSmart` in `apps/agent/src/storage.ts`.

**Problem:** the values come from the drive's firmware. They were sent to the dashboard as they were, and a non-array attribute table made the action fail.

**Fix:** only numbers and booleans are passed on, and anything else becomes "unknown". The web app shows these values as text, never as HTML.

**Test:** `storage.test.ts`.

### SR-9 Low: the dashboard can rewrite the kit update status file

**Where:** `/var/lib/selfhost/kit-update.json`.

**Decision:** accepted. After SR-1 root never writes through it. The agent reads it only through the Zod schema. The worst a compromised dashboard can do is show itself a wrong message, or block kit updates for 30 minutes by faking a running update. It can already stop itself.

### SR-10 Low: app containers run with default Docker privileges

**Where:** `packages/catalog/*/compose.yml.tmpl`.

**Decision:** accepted for 0.9. The dashboard container drops every capability and uses `no-new-privileges`, but the app containers use their images' defaults. Some images (Nextcloud, Postgres) need to start as root and change user. Tightening each image needs testing on real hardware, so it is under Later.

### SR-11 Info: the action allowlist

`packages/shared/src/actions.ts` is a Zod discriminated union. Every action is `.strict()`, so an unknown field is rejected. A line over 64 KiB is refused before it is parsed. Each argument:

| Argument | Check | Actions |
| --- | --- | --- |
| `id` | `[A-Za-z0-9_-]{1,64}` | all |
| `service` | enum of the four apps | service, logs, snapshot actions |
| `deleteData`, `follow`, `copyExisting`, `refresh` | boolean | as named |
| `tail` | integer 1 to 5000 | `logs.stream` |
| `uuid` | `[A-Za-z0-9-]{4,40}`, then must be a volume lsblk reports | disk actions, `folder.assign` |
| `label` | `[a-z][a-z0-9-]{0,31}`, 16 or fewer for a new drive | `disk.mount`, `disk.format` |
| `device` | `sd*`, `vd*`, `nvme*n*`, `mmcblk*`, then must be a disk lsblk reports | `disk.format` |
| `diskId` | `[a-f0-9]{16}`, compared with lsblk | `disk.format` |
| `folder` | enum of six library folders, mapped to fixed paths | folder actions |
| `subpath` | up to 4 segments, each starting with a letter or digit, then SR-2 | `folder.assign` |
| `hostname` | `[a-z0-9][a-z0-9-]{0,62}` | `tailscale.login` |
| `snapshot` | `\d{8}T\d{6}Z` | `snapshot.restore` |
| `kind`, `target` | enum, and the target re-checked against the kind | `confirm.issue` |
| `confirm` | `[A-Za-z0-9_-]{32,128}`, then looked up | destructive actions |
| `version` | `\d{1,4}.\d{1,4}.\d{1,4}`, must be newer | `kit.update` |

No action takes a free path, URL, command or unit name. Paths and unit names are always built from these values and fixed roots (`/mnt`, `/srv/...`, `/opt/selfhost/...`, `/etc/systemd/system`).

### SR-12 Info: how commands run

**Processes:** every process the agent starts goes through `run` (`execFile` with an argument array) or `streamLines` (`spawn` with `shell: false`), both in `apps/agent/src/exec.ts`. The `selfhost` command only runs `id` with `execFileSync`. No code uses `exec`, a shell, or a command built as a string. `apply-update.sh` is started with `systemd-run /bin/bash <bundle>/apply-update.sh <bundle> <version>`, where the bundle path is fixed and the version is checked.

**Files root writes that are later run or read as config:**

- `compose.yml`, rendered from the catalog. The image pins are fixed. Ports, IDs and paths are numbers or fixed paths. The time zone must match `[A-Za-z0-9_/+-]`, and trusted domain names must match `[A-Za-z0-9.-]`.
- `.env`, which holds 64-character hex secrets only.
- Mount units. They are built from a checked UUID, label and subpath, and none of those can hold a newline or `%`. The bind source is checked for links (SR-2).
- `apply-update.sh`, the agent unit and the dashboard files. They come from a signed release (SR-15).
- `/usr/local/bin/selfhost`, a fixed text in `install.sh`.

**Snapshots:**
- `tar` runs as root on app config folders, but archives symlinks as symlinks.
- GNU tar delays creating absolute and `..` links until the end of an extraction, so a planted link cannot redirect the restore.
- `docker compose cp` copies a link inside the container as a link, into a folder only root can read.

### SR-13 Info: the socket and what each container can reach

**The socket:**
- It is created with a `0117` umask, so it is never more open than `0660`. It is then set to `root:selfhost 0660` in `/run/selfhost`, which is `root 0755`.
- The agent's own unit sets `NoNewPrivileges=yes`.

**The dashboard container:**
- It runs as `selfhost` with `read_only`, `cap_drop: ALL` and `no-new-privileges`.
- It mounts only `/run/selfhost` (it cannot create files there) and `/var/lib/selfhost`.
- It never gets the Docker socket or root.

**The app containers:** none of them mount `/run/selfhost`, the Docker socket, `/opt/selfhost` above their own config subfolders, or `/var/lib/selfhost`.

**Accepted:** the socket has no connection limit. Only root and the `selfhost` group can connect.

### SR-14 Info: dry-run and test-build switches

`SELFHOST_RELEASE_BASE` and `SELFHOST_RELEASE_KEY` are read only from the agent's own environment, never from a request. A test checks that a `url` field in `kit.update` is rejected. They are used only in two cases:

- **A dry run.** The agent then uses a fake runner and file system, so nothing on the machine changes.
- **A test build.** `__TEST_BUILD__` is fixed at build time by tsup's `define`.

Even then, the base must be `http://127.0.0.1:<port>` and the key must be a well-formed Ed25519 key. The agent's environment is set by its systemd unit, which only root can change. Root can already replace the agent, so a production build cannot be made to use the switches by anyone who is not already root. SR-6 makes sure a test build is never published.

### SR-15 Info: kit updates and rollback

**Download:**
- `kit.update` accepts only a newer version.
- It downloads from the fixed GitHub address over HTTPS (`--proto =https`, `--proto-redir =https`, 300 MB and 10 minute limits) into `/opt/selfhost/releases/<version>`, which only root can write.

**Checks before anything unpacks:**
- The checksum file's Ed25519 signature is checked first, against the key built into the agent.
- The checksum file must name the tarball.
- The SHA-256 must match.

**Unpacking:**
- tar runs with `--no-same-owner`.
- The `VERSION` file inside must match, and `apply-update.sh` must be present.

**`apply-update.sh`:**
- It comes from the new, signed release, so it is as trusted as the release.
- It copies the old agent, the `selfhost` command, the unit, `uninstall.sh` and the dashboard to `/opt/selfhost/releases/previous`.
- It installs the new files and waits for the new agent version and the dashboard health check.
- If either fails, it puts the old files back.

`install.sh` runs the same signature check with `openssl` before it unpacks anything. The risk that remains is the signing key itself, which is under Later (one key, no expiry, no safe rotation if it leaks).

### SR-16 Info: secrets and logs

**Secrets:**
- They are 32 random bytes in hex, in `/opt/selfhost/config/<app>/.env`, which is root `0600`.
- They are passed to containers through `env_file`, never on a command line.
- Nextcloud's admin password is returned once by `service.credentials`. A marker written before the reply stops it being shown twice.
- Saved copies are in `/opt/selfhost/backups`, which is root `0700`.

**Logs:**
- The installer log is `0600`. The setup code is printed only to the terminal, never to the log.
- The agent's journald entries hold the action, request id, service, outcome and duration, never other arguments.
- An unexpected error logs the error text. For a failed command that includes the command line, which holds no secrets.
- The dashboard audit log holds the event, target, outcome and an error code.

### SR-17 Info: parsing output from other programs

- **lsblk:** JSON, with each field turned into a number, string or boolean. Disk names must match the device regex, or the disk is skipped. Labels, models and serials are only displayed (as text) or hashed into `diskId`.
- **smartctl:** see SR-8.
- **docker:** dockerode's JSON. Names, states and start times are only displayed.
- **tailscale:** the sign-in address must start with `https://`. The DNS name is checked against `[a-z0-9][a-z0-9.-]*` before it is passed to `occ` or written into a compose file.
- **Status file:** parsed with the shared Zod schema.
- **Mount units:** read only if they carry the kit's marker and point under `/mnt`.
- **App logs:** sent to the dashboard as text. The web app never uses `innerHTML`.

## Not tested here

The symlink tests need Linux and ran only in CI. The full install, storage and kit update gates also ran only in CI, on GitHub's Ubuntu 24.04 runners. No one has tried these attacks on a real server by hand.
