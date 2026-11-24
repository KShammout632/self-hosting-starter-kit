# Troubleshooting

Find what you see below. Each entry says what is probably happening and what to do. Commands are for the server itself (sit at it, or connect over SSH).

If nothing here helps, see [Asking for help](#asking-for-help) at the bottom.

## Contents

- [I cannot open the dashboard](#i-cannot-open-the-dashboard)
- [I lost the setup code or the dashboard password](#i-lost-the-setup-code-or-the-dashboard-password)
- [The installer stopped](#the-installer-stopped)
- [What the card statuses mean](#what-the-card-statuses-mean)
- [An app will not install or start](#an-app-will-not-install-or-start)
- [An update was rolled back](#an-update-was-rolled-back)
- [An app looks broken after an update](#an-app-looks-broken-after-an-update)
- [Storage and drives](#storage-and-drives)
- [Remote access](#remote-access)
- [Nextcloud](#nextcloud)
- [The server runs slowly or apps keep stopping](#the-server-runs-slowly-or-apps-keep-stopping)
- [Asking for help](#asking-for-help)

## I cannot open the dashboard

The address is `http://<server address>:8080`, with `http` (not `https`) when you are at home.

1. **Check the address.** If you lost it, run `hostname -I` on the server and use the first number, followed by `:8080`.
2. **Check you are on the same network** as the server. A guest Wi-Fi network is often separated from the main one.
3. **Check the server is on.** Can you reach it over SSH?
4. **Check the dashboard is running:**

   ```bash
   sudo docker ps
   ```

   Look for a container whose name contains `dashboard` and a status that starts with `Up`. If it is missing or keeps restarting, see its log:

   ```bash
   sudo docker compose --project-directory /opt/selfhost/dashboard logs --tail 50
   ```

   Running the installer again repairs a broken dashboard, and it keeps your settings: `sudo bash install.sh`.
5. **A white page** after a manual file copy usually means the file permissions are wrong. Run the installer again.

If the dashboard says "The dashboard cannot reach the helper that runs on your server", the helper (called the agent) is stopped. On the server:

```bash
sudo systemctl status selfhost-agent
sudo systemctl restart selfhost-agent
```

## I lost the setup code or the dashboard password

Both are fixed on the server itself:

```bash
sudo selfhost reset-password
```

It prints a new setup code. Open the dashboard, press **Forgot your password?**, then **I have a new setup code**, and choose a new password. Everyone is signed out.

After 10 wrong passwords the dashboard locks you out for a while. Wait and try again.

## The installer stopped

The installer always says why in plain English and ends with "More help". The full log is in `/var/log/selfhost-install.log`.

| Message | What to do |
| --- | --- |
| Needs Ubuntu Server 24.04 | The kit supports only that version. Install it and try again. |
| Needs a 64-bit Intel or AMD processor | ARM boards (such as a Raspberry Pi) are not supported. |
| Less than 4 GB of memory | That is the minimum. Add memory or use another machine. |
| The system disk needs at least 20 GB free | Free space on the main drive. |
| Cannot reach the internet | Check the cable or Wi-Fi and the router, then try again. |
| Please run it with sudo | Start it with `sudo bash install.sh`. |
| The download is corrupt | Try again. If it keeps happening, the download is being altered on your network. |
| The dashboard did not start | The installer printed the dashboard's log just above the message. Read it, or ask for help. |

The installer is safe to run again, and running it a second time repairs most half-finished installs.

## What the card statuses mean

| Status | What it means | What to do |
| --- | --- | --- |
| Online | Running and answering. | Nothing. |
| Starting up | Running, but not answering yet. | Wait a few minutes. Nextcloud and Immich take longest, especially the first time. |
| Having problems | Part of the app is down, or it is not answering after a few minutes. | Open the app's page and read the logs. Try **Restart**. |
| Offline | Stopped, by you or by something else. | Press **Start**. If it will not stay on, read the logs. |
| Needs attention | It keeps crashing, an install failed, or a folder it needs is missing. | See below. |
| Not installed | Not set up. | Press **Install**. |

An app's page shows plain-English **suggestions** when it recognises a problem in the logs. Press **Show details** to see the raw log lines.

| Suggestion | What it means |
| --- | --- |
| A media folder is missing | A drive is not connected, or the folder was moved. See [Storage and drives](#storage-and-drives). |
| The service is not allowed to read or write a folder | A drive was mounted with the wrong permissions. See below. |
| A folder is read-only | The drive is unhealthy or mounted read-only. Check its health on the Storage page. |
| The disk is full | Free space or add a drive. |
| Another program is using this service's port | Restart the server. |
| The server ran out of memory | Stop an app you are not using. See [The server runs slowly](#the-server-runs-slowly-or-apps-keep-stopping). |
| The service could not reach something it depends on | Often only the app starting. Wait a minute and check again. |

## An app will not install or start

- **The install did not finish.** The first install downloads the app, which needs the internet and can take many minutes. Open the app's page, read the message, and press **Install** again. The wizard installs one app at a time, and a failure only stops that app. Later apps carry on, so go back to Home and install the one that failed.
- **Image downloads sometimes fail** because the registry was busy (Immich especially). Trying again usually works.
- **A red "Needs attention" card after a restart.** The dashboard keeps failed installs only in memory, so a restart of the dashboard clears the red card. Check the card's current status.
- **Look at the log from the terminal** if the dashboard does not help:

  ```bash
  sudo selfhost status
  sudo selfhost logs jellyfin --tail 200
  ```

## An update was rolled back

The app page says the update did not work and the saved copy was put back. The app is online on its **old version**, with its old data. That is the safety net doing its job.

Nothing is lost. To find out why, read the logs on the app's page and note the error. Common causes: a very slow download that ran out of time, a full disk, or not enough memory for the new version.

Try again later, once you have fixed the cause. If it keeps rolling back, ask for help and include the logs.

## An app looks broken after an update

The kit checks that the app starts and answers its health address. It cannot see every kind of breakage inside an app (for example, a database change that failed halfway). If an app is online but plainly broken:

1. Look at its logs on its page.
2. Restart the app.
3. Ask for help, and say which version you updated from and to. The saved copies are in `/opt/selfhost/backups/<app>/<date>/`, so **do not delete that folder**. A person helping you can use it to restore. There is no restore button in the dashboard yet.

## Storage and drives

### A drive is "not connected"

Plug it back in, wait a moment, and press **Mount again** on its card. Then restart the apps that use it, because they keep their old view of the folder until they restart. See [Storage](storage.md#when-a-drive-goes-missing).

The kit never lets an app write into the empty folder of a missing drive, so a missing drive shows **Needs attention** and does not quietly fill the main drive.

### The server will not start (boot) without my USB drive

It should. Drives are mounted with `nofail`, so a missing one never blocks start-up. If the server still stops at a menu or message about a drive, take a photo of it and ask for help.

### "Permission denied" for a folder

- Files you copied in as another user may not be writable by the apps. The library folders belong to the `selfhost` group, so add your own user to it (see the [user guide](user-guide.md#where-your-files-go)). Running the installer again resets the owner of the top-level library folders.
- On an **NTFS or exFAT** drive, permissions cannot be set, so the kit mounts it as owned by the server's own user. If an app still cannot write, use an ext4 drive for that library.

### A drive will not mount

- Windows drives that were not ejected properly can refuse to mount. Plug the drive into Windows, let it fix the drive, eject it properly and try again. The kit does not repair drives itself.
- Check **Check health** on the drive's card. A failing drive may refuse to mount.

### The dashboard says a drive is almost full

At 90 percent the kit warns you. Free space or add a drive, then move a library to it. See [Storage](storage.md).

## Remote access

### The sign-in link does not work, or the page says it is not connected

Press **Connect to Tailscale** again to get a fresh link. If it keeps failing, check that the server has internet access.

### "Check again" does not tick MagicDNS or HTTPS

Both must be on in the Tailscale admin page, on the **DNS** page. After you switch them on, press **Check again**. It can take a minute for Tailscale to report the change. If you changed the wrong tailnet, check you are signed in to the same account that the server joined.

### The secure addresses do not open away from home

- Is the Tailscale app turned on, on your phone or laptop? It must be on, and signed in to the same account (or one invited to your tailnet).
- Use the `https://` address and include the port number, for example `:8920` for Jellyfin.
- Check the Remote access page: is the server still connected? If its Tailscale key expired (this happens after 180 days unless you disabled expiry), it drops off your tailnet. Open the Tailscale admin page, find the server under **Machines**, choose **Disable key expiry**, and sign the server in again from the Remote access page.

### I want a different server name

Turn remote access off and on again. You choose a new name when you connect.

### The Remote access page is slow the first time

The first load after Tailscale becomes ready publishes your addresses, which can take a few seconds.

## Nextcloud

### I lost the Nextcloud admin password

The dashboard shows it only once. To set a new one, on the server:

```bash
sudo docker exec --user www-data -it selfhost-nextcloud php occ user:resetpassword admin
```

It asks you to type a new password twice. The password does not show as you type.

### Nextcloud says "untrusted domain"

Nextcloud only accepts the addresses it knew when it first started: the server's name, its network addresses at that time and, once remote access is on, the Tailscale name. If you opened it from an address it has never seen (for example, the server got a new IP address from your router), add it:

```bash
sudo docker exec --user www-data selfhost-nextcloud php occ config:system:set trusted_domains 10 --value="192.168.1.60"
```

Change `192.168.1.60` to the address in your browser. If `10` is already in use, pick a higher number. To avoid this in future, give your server a fixed address in your router's settings.

### Nextcloud takes a long time on first start

That is normal. It sets itself up during the first few minutes. The card shows **Starting up** until it answers.

## The server runs slowly or apps keep stopping

- Immich and Nextcloud need a lot of memory. With 4 GB, running all four apps is tight, and an app that runs out of memory is stopped by the server (the card shows **Having problems**, and the suggestion says the server ran out of memory). Stop an app you are not using, or add memory. 8 GB or more is recommended for all four.
- Immich's first scan of a big photo library keeps the processor busy for hours. This is normal.
- Look at the Home page: the summary under **Your server** shows processor, memory and disk use, plus the temperature.
- A very hot mini PC will slow itself down. Give it room for air.

## Asking for help

When you open an issue on GitHub (the link is in the repository's README), please include:

- The kit version: `sudo selfhost version`
- What you did, and what you expected
- What the card or the page said, word for word
- The relevant log lines: `sudo selfhost logs <app> --tail 200`, and for install problems the end of `/var/log/selfhost-install.log`

**Remove passwords and anything private first.** Do not paste the dashboard setup code, the Nextcloud admin password or the contents of any `.env` file.
