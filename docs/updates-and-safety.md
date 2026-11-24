# Updates, uninstall and safety

## Updates

There are three kinds of update, and you control all of them. Updates only move to versions the kit has tested, so you never get a random newest release from an app's website.

### App updates

When a tested newer version of an app is available, its card on Home says so, and its page shows **An update is available** with **Update now** and **What is new** (a link to the app's release notes).

> **Screenshot to add:** a service page with the "An update is available" card.

When you press **Update now**, the kit:

1. Stops the app and takes a **saved copy** of its settings (and, for Immich and Nextcloud, its database).
2. Downloads the new version and starts it.
3. Waits up to 5 minutes for it to come up and answer.
4. If it does not, **puts the saved copy back automatically** and tells you the update was rolled back. The app stays on its old version, and you can read the logs to see what went wrong.

The app is offline while this runs, including during the download, so pick a quiet moment. Updates for Immich can be big, and a library with a lot of photos may take a long time.

About the saved copies:

- They live in `/opt/selfhost/backups/<app>/` on the server. The newest 3 are kept for each app.
- They contain the app's settings, accounts and library information. They do **not** contain your library folders (your photos and Nextcloud files).
- Only the server can restore one, and the dashboard has no "restore" button yet. If an update goes wrong in a way the automatic check cannot see (for example an app that answers but is broken inside), ask for help. See [Troubleshooting](troubleshooting.md#an-app-looks-broken-after-an-update).

Saved copies are **not backups**. They are stored on the same drive as the app. They are there so a failed update can be undone, nothing more.

### Kit updates

The kit itself (the dashboard, and the helper that runs on the server) has its own updates. The server checks GitHub for a new release once a day. When there is one, every page shows **A new version of the kit is available.**

Go to **Settings**, then **Updates for this kit**, and press **Update now**. **Check for updates** looks for a new version straight away.

- The new version is downloaded and checked before anything changes: it must carry this project's signature, and match its published checksum. A download that fails either check is thrown away.
- The dashboard goes offline for a few minutes while it restarts and rebuilds. Your apps keep running.
- The server needs the internet during this, like the installer does.
- If the new version does not start, the old one is put back automatically. The page tells you whether the update finished or was rolled back.
- The kit only ever moves to a newer version, never back.
- If you signed in more than 15 minutes ago, you are asked for your password first.

### Server updates

Ubuntu installs **security updates automatically**. In **Settings**, **Updates for the server itself** shows how many updates are waiting. Press **Install updates** to install the rest.

Some updates need a restart to finish. When that is the case, every page shows **The server needs a restart to finish installing updates.** Open Settings and press **Restart the server**. Everyone using your apps is disconnected for a minute or two.

Note that updating Docker itself restarts your apps.

## Uninstall

### One app

On the app's page, press **Remove**.

- By default it **keeps** the app's settings and accounts, so installing it again brings everything back.
- Tick the box to erase them too. This cannot be undone, and you must type the app's name to confirm.
- Your own files in the library folders (`/srv/media`, `/srv/photos` and so on) are never touched.

### The whole kit

On the server, run:

```bash
sudo bash /opt/selfhost/uninstall.sh
```

It stops and removes every app, the dashboard and the helper. Then it asks two separate questions, and the default for both is to keep everything:

1. Whether to delete the apps' settings and databases (Jellyfin accounts, watch history and so on), the saved copies and the dashboard's own data.
2. Whether to delete everything in `/srv/media`, `/srv/photos` and `/srv/nextcloud`.

Type `yes` to say yes, anything else keeps it. Docker, Tailscale and the firewall stay as they are, since other things on the machine may use them.

If you moved a library folder to another drive, the files on that drive are **kept** even when you answer yes to the second question. Only files on the server's own drive are deleted, and the script lists the folders it kept.

If you keep the settings, the drives stay connected as they were, so installing the kit again finds them. If you delete the settings, the drives the kit set up are disconnected too. Their files stay on them, and you can add them again from the Storage page after a new install.

## Backups

**The kit does not make backups in v1.** The saved copies before updates are the only copies it makes, and they stay on the server.

If you keep the only copy of your family photos in Immich, one failed drive loses them. Please keep another copy somewhere else. For example, copy `/srv/photos` and `/srv/nextcloud` to an external drive now and then. Scheduled backups are planned for a later release.

## Safety

The kit is built so that a mistake or a stranger on your network cannot easily do harm. A few rules keep it that way.

- **Never forward ports on your router.** Not for the dashboard, not for any app. Remote access goes through Tailscale. The installer's firewall does not cover ports that Docker publishes, so the router is what keeps the apps private.
- **Keep the server on a trusted network.** Anyone on your home Wi-Fi can reach the apps' login pages. Every app and the dashboard need a password, so use strong ones.
- **One dashboard account.** Whoever has its password can change anything on the server. Choose a long password and do not share it.
- **Each app has its own accounts.** The dashboard password does not open the apps, and the apps' passwords do not open the dashboard.
- **Lost the dashboard password?** On the server, run `sudo selfhost reset-password`. It prints a new setup code, then open the dashboard's sign-in page, press **Forgot your password?** and then **I have a new setup code**. This only works with access to the server itself, which is the point. Everyone is signed out when you do it.
- **After 10 wrong passwords** the dashboard locks out further tries for a while.
- **After 15 minutes** of being signed in, risky actions (erasing a drive, removing an app's data, updates, turning off remote access, restarting) ask for your password again.
- **Secrets stay on the server.** Database passwords are generated during install and kept in files only the server can read. The Nextcloud admin password is shown once, in the dashboard.
- **The dashboard cannot run commands on the server by itself.** It talks to a small helper that only does a fixed list of actions. This is why a bug in the web page cannot be turned into control of the server.

### What you see in the audit log

**Settings**, **What happened lately** lists sign-ins, setup, password changes, app actions, updates, restarts and remote access changes. It is there to answer "who did that?". It records what the dashboard did. It does not cover things you did directly in the terminal.
