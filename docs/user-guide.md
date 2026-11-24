# User guide

This guide takes you from an empty PC to a working home server. You only need the terminal once, to run the installer. After that everything is done in a web page.

If something does not look right at any point, see [Troubleshooting](troubleshooting.md).

## 1. Install Ubuntu Server

The kit needs **Ubuntu Server 24.04 LTS** on a 64-bit Intel or AMD machine. Other versions and other Linux systems are not supported.

Ubuntu has its own step-by-step guide: search for "Install Ubuntu Server" on [ubuntu.com/tutorials](https://ubuntu.com/tutorials). While you follow it:

- Choose the normal (not minimal) server install.
- Tick **Install OpenSSH server** if you want to run the installer from another computer. It is optional.
- Use a network cable if you can. It is more reliable than Wi-Fi for a server.
- Make a note of the user name and password you choose. You need them to sign in on the server.

You need at least 4 GB of memory and 20 GB free on the system disk. With all four apps, 8 GB or more is recommended. Immich (photos) and Nextcloud (files) are the hungry ones.

## 2. Run the installer

Sign in on the server (or over SSH) and run:

```bash
curl -fsSL https://raw.githubusercontent.com/KShammout632/self-hosting-starting-kit/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The second command is optional. It lets you read the script first. Press `q` to leave it.

The installer takes several minutes. It checks the machine, installs Docker and Tailscale, sets up folders and a firewall, and starts the dashboard. It is safe to run again if it stops halfway: running it a second time repairs a broken install. A full log is saved at `/var/log/selfhost-install.log`.

At the end it prints two things:

```
http://192.168.1.50:8080
Setup code: ABCD-2345
```

**Write the setup code down now.** It is shown only once and is not saved in the log. If you lose it, run `sudo selfhost reset-password` on the server to get a new one.

Your address will differ. Use the one the installer printed.

## 3. The setup guide

Open the address in a browser on any device at home. Because you are not using Tailscale yet, the address starts with `http://`, and your browser may say the connection is not secure. That is expected on your home network.

The setup guide has five steps. Only the first is required. Every other step has **Next** and **Skip for now**, and **Skip the rest** ends the guide. You can do the skipped steps later from the pages in the top menu.

> **Screenshot to add:** the setup guide's first step, showing the setup code and password fields.

1. **Your password.** Enter the setup code, then choose a password of at least 10 characters. This creates the one dashboard account. Anyone with this password can change the server, so make it a good one. There is only one dashboard account, and it cannot be shared in v1.
2. **Reach your server from anywhere.** Sets up Tailscale, so your apps work away from home. See [Remote access](remote-access.md). You can skip it and do it later.
3. **Where should your files live.** Lists your drives and lets you choose where movies, shows, music and photos are kept. See [Storage](storage.md). If everything stays on the server's main drive, skip it.
4. **Choose your apps.** Tick the apps you want. The guide installs them one at a time. The first install of each app downloads it, which can take several minutes. If your server has less than about 8 GB of memory and you pick three or more apps, the guide warns you that it may run slowly.
5. **Done.** Shows the address of each app and its first-login tips. Press **Go to my dashboard**.

You can run the guide again later from **Home**, under **Your server**, **Show details**, **Run the setup guide again**. This does not change anything by itself.

## 4. Home page

The Home page shows one card for each app, plus a summary of the server (processor load, memory, disk space and temperature).

Each card has a status:

| Status | What it means |
| --- | --- |
| Online | The app is running and answering. |
| Starting up | The app has started and is getting ready. This can take a few minutes, especially the first time. |
| Having problems | Part of the app is not running, or it is running but not answering. |
| Offline | You stopped it, or it is not running. |
| Needs attention | It keeps crashing, an install failed, or a folder it needs is missing. |
| Not installed | Not set up yet. Press **Install**. |

Press **Open** to use the app on your home network. When remote access is on, **Open from anywhere** opens the secure address instead.

Press an app's name for its page, with **Start**, **Stop**, **Restart**, **Remove** and live logs. Under **Show details** you can see the technical side. A count badge shows how many lines in the logs look like errors.

## 5. First login for each app

Each app keeps its own accounts. The dashboard password does not work inside the apps, and there is no single sign-in. The first time you open an app, you create its administrator account yourself (except Nextcloud, see below). Each app's page in the dashboard shows the same tips under **Getting started**.

### Jellyfin (movies and shows)

Address: `http://<server address>:8096`

1. Open Jellyfin and create your admin account.
2. Add your libraries. Jellyfin sees your folders under `/media`:
   - Movies: `/media/movies`
   - Shows: `/media/tv`
   - Home videos: `/media/home-videos`
3. Put files in the matching folders on the server (see the [folders](#where-your-files-go) below).

Phone and TV apps: Jellyfin, Findroid, Swiftfin. If the server has an Intel graphics chip, Jellyfin can use it to convert video for slow connections.

### Navidrome (music)

Address: `http://<server address>:4533`

1. Open Navidrome and create your admin account. The first account you make becomes the admin.
2. Your music is found automatically in `/music`. New files appear within an hour.

Phone apps: any Subsonic app, such as Symfonium, Substreamer or play:Sub. Enter the server address and the account you just made.

### Immich (photos)

Address: `http://<server address>:2283`

1. Open Immich and create your admin account. The first account you make becomes the admin.
2. Install the Immich app on your phone, sign in, and turn on backup.
3. The first scan of a large library can take a long time while the server works through your photos.

Immich needs a lot of memory. Its photo search and face recognition run on the processor, not the graphics chip.

### Nextcloud (files, calendars, contacts)

Address: `http://<server address>:8081`

1. Open the Nextcloud page in the dashboard and press **Show my login**. It shows the admin user name and a password. **The password is shown only once**, so write it down or copy it before you leave the page.
2. Open Nextcloud and sign in with them. The first start takes a few minutes while Nextcloud sets itself up.
3. Install the Nextcloud app on your phone and sign in with the address of the server.

If you lose the Nextcloud admin password, see [Troubleshooting](troubleshooting.md#i-lost-the-nextcloud-admin-password).

Nextcloud only accepts addresses it knew about at its first start (the server's name and network addresses, plus the Tailscale name once remote access is on). If you open it from a new address and it says "untrusted domain", see [Troubleshooting](troubleshooting.md#nextcloud-says-untrusted-domain).

## Where your files go

The apps read from fixed folders on the server. Copy your files into them from your computer, for example with a file manager that supports SFTP (such as FileZilla or WinSCP) over SSH, or from a drive plugged into the server.

The folders belong to the `selfhost` group and are writable by it. To copy files in as your own user, add yourself to the group once, then sign out and back in:

```bash
sudo usermod -aG selfhost $USER
```

Only do this for the account you already use with `sudo`. Members of the `selfhost` group can also give orders to the server's helper program (install and remove apps, erase drives), so never add an account for someone who should not manage the server.

| Folder | Used by |
| --- | --- |
| `/srv/media/movies` | Jellyfin |
| `/srv/media/tv` | Jellyfin |
| `/srv/media/home-videos` | Jellyfin |
| `/srv/media/music` | Navidrome |
| `/srv/photos` | Immich |
| `/srv/nextcloud` | Nextcloud |

Jellyfin and Navidrome only read these folders and never change your files. Immich and Nextcloud also write to theirs.

By default these folders are on the server's main drive. To keep them on a bigger drive, use the Storage page. See [Storage](storage.md).

## Everyday use

- **Start, stop, restart:** on the app's page.
- **Update an app:** when an update is ready, the card says so and the app's page has **Update now**. See [Updates, uninstall and safety](updates-and-safety.md).
- **Logs:** each app's page shows live logs. Press **Show details** for the technical view.
- **Remove an app:** the app's page has **Remove**. By default it keeps the app's settings and accounts, so installing it again brings them back. Tick the box to erase them too, and type the app's name to confirm. Your own files in the library folders are never touched.
- **Change your dashboard password, update the kit, install server updates, restart the server:** the Settings page.

## Useful terminal commands

You rarely need these, but they help when the dashboard is not reachable. Run them on the server with `sudo`.

| Command | What it does |
| --- | --- |
| `sudo selfhost status` | Shows which apps are running |
| `sudo selfhost logs jellyfin` | Shows recent log lines (add `--tail 200` for more) |
| `sudo selfhost restart jellyfin` | Restarts an app |
| `sudo selfhost reset-password` | Prints a new setup code so you can choose a new dashboard password |
| `sudo selfhost version` | Shows the version |

The app names are `jellyfin`, `navidrome`, `immich` and `nextcloud`. Run `sudo selfhost` with no arguments to see the full list of commands.

## Security basics

- **Never forward ports on your router** for the kit or its apps. Remote access is meant to go only through Tailscale.
- Keep the server on a trusted home network.
- Security updates install automatically. The dashboard asks you to restart the server when one needs it.
- Every app needs its own login, even at home.

More on this in [Updates, uninstall and safety](updates-and-safety.md).
