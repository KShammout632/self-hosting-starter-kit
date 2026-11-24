# Self-hosting starter kit

One command turns a fresh Ubuntu Server 24.04 machine into a home media and file server. You then manage everything from a web page, so you do not need the terminal again.

You can install any of these apps, and each one is optional:

| App       | What it does                               |
| --------- | ------------------------------------------ |
| Jellyfin  | Streams your movies, shows and home videos |
| Navidrome | Streams your music                         |
| Immich    | Backs up and browses your phone photos     |
| Nextcloud | Syncs your files, calendars and contacts   |

You can reach your apps from anywhere through Tailscale, without opening any ports on your router.

## Who it is for

Someone who can follow a guide to install Ubuntu on an old PC or a mini PC, but is not comfortable with Docker, drive mounting or reverse proxies.

## What you need

- A PC or mini PC with a 64-bit Intel or AMD processor (x86-64). ARM boards such as the Raspberry Pi are not supported.
- Ubuntu Server 24.04 LTS installed on it.
- At least 4 GB of memory and 20 GB free on the system disk. For all four apps, 8 GB or more is recommended.
- An internet connection on the server.
- A free [Tailscale](https://tailscale.com) account if you want to use your apps away from home.

If the machine has Intel integrated graphics, Jellyfin uses it to convert video for slow connections. Other graphics cards are not used.

## Install

On the server, run these three commands. The middle one is optional and lets you read the script first.

```bash
curl -fsSL https://raw.githubusercontent.com/KShammout632/self-hosting-starting-kit/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

When it finishes it prints a web address and a setup code. Open the address in a browser on any device at home and follow the setup guide. The [user guide](docs/user-guide.md) walks through every step.

## Guides

- [User guide](docs/user-guide.md): install, first setup, and using each app
- [Storage](docs/storage.md): drives, library folders and safely unplugging
- [Remote access](docs/remote-access.md): using your apps away from home with Tailscale
- [Updates, uninstall and safety](docs/updates-and-safety.md)
- [Troubleshooting](docs/troubleshooting.md): what to do when something looks wrong
- [Contributing](docs/contributing.md): how the project is built and how to add an app

## What it does not do

The first release keeps things simple on purpose. It has no scheduled backups (only an automatic saved copy before each app update), no public sharing, no single sign-in across apps, no multiple dashboard accounts, and no support for other Linux versions or ARM boards. Read [Updates, uninstall and safety](docs/updates-and-safety.md) before you trust the server with the only copy of anything.

## Licence

GPL. See [LICENSE](LICENSE).
