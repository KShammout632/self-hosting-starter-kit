# Remote access

Remote access lets you reach your apps from your phone or laptop when you are away from home, with no router changes. It uses [Tailscale](https://tailscale.com), a private network (called a **tailnet**) that only your own devices can join.

Nothing is exposed to the public internet. To get in, someone needs your Tailscale identity first, and then each app's own login.

## What you need

- A free Tailscale account. You can sign in with Google, Microsoft, GitHub, Apple or an email address.
- The Tailscale app on every phone or laptop you want to use away from home. Install it from your app store or from tailscale.com, and sign in with the same account.

## Set it up

Open **Remote access** in the menu (or step 2 of the setup guide).

> **Screenshot to add:** the Remote access page, showing step 1 with the sign-in link and QR code.

1. **Connect.** Choose a name for your server (it defaults to the machine's name) and press **Connect to Tailscale**. The name becomes part of your addresses, for example `https://homeserver.<your-tailnet>.ts.net`. You cannot change it from the dashboard later. To pick another name, turn remote access off and on again.
2. **Step 1: Sign in to Tailscale.** The page shows a link and a QR code. Open it on any device, sign in, and approve the server. Press **Open the Tailscale sign-in page** if you are on the same device.
3. **Step 2: Turn on two Tailscale settings.** Your apps need secure (HTTPS) addresses, which Tailscale gives you only after you switch on two settings in its admin page, both on the **DNS** page:
   - **MagicDNS**
   - **HTTPS certificates**

   Press **Open the Tailscale admin page**, switch both on, come back and press **Check again**. The page ticks each one when it sees it. In the admin page you may need to accept a short notice that your server's name will be listed in a public certificate log. That is normal for Tailscale's HTTPS.

> **Screenshot to add:** the Tailscale admin console's DNS page with MagicDNS and HTTPS Certificates highlighted. This one needs a real Tailscale account.

4. **Your addresses.** When both settings are on, the page lists a secure address for the dashboard and for each installed app, each with **Open**, **Copy** and a QR code for your phone. It updates by itself when you install or remove an app.

## The addresses

| What | At home (plain http) | Away from home (https) |
| --- | --- | --- |
| Dashboard | `:8080` | the server's name, with no port |
| Jellyfin | `:8096` | `:8920` |
| Navidrome | `:4533` | `:4534` |
| Immich | `:2283` | `:2284` |
| Nextcloud | `:8081` | `:8444` |

For example, Jellyfin away from home is `https://homeserver.<your-tailnet>.ts.net:8920`.

Add the `https://` address to your phone apps. Immich works on your home Wi-Fi with the same address, as long as the Tailscale app is turned on, so use that address everywhere and the app keeps working wherever you are.

On the Home page, **Open** goes to the home address and **Open from anywhere** goes to the secure address.

## Important: turn off key expiry for the server

Tailscale makes a device sign in again after 180 days unless you switch that off. For a server, an expired key means remote access quietly stops working.

In the Tailscale admin page, open **Machines**, find your server, open its menu and choose **Disable key expiry**.

## Family and friends

Everyone who wants to use your apps remotely needs the Tailscale app, and your server must be reachable from their account. There are two ways:

- **Invite them to your tailnet** as users, from the Tailscale admin page. They see everything you have shared with the tailnet.
- **Share just this server** with them using Tailscale's node sharing. They stay in their own tailnet and see only the server.

Either way, they still need an account in each app (Jellyfin, Immich and so on). You create those inside the apps.

## Turning it off

At the bottom of the Remote access page, under **Show details**, press **Turn off remote access**. This asks for your password if you signed in more than 15 minutes ago. It removes the secure addresses and signs the server out of Tailscale. Your apps keep working at home.

## What is not supported

- **Public sharing** with Tailscale Funnel, Cloudflare Tunnel or similar. It is not supported and not planned.
- **Port forwarding.** Never forward ports on your router for this kit. The apps are not meant to face the internet directly.
- **The sign-in key method.** The only way to connect the server to Tailscale is the browser sign-in described above.

The Remote access page does not show which other devices are on your tailnet. Use the Tailscale admin page for that.

## If it does not work

See [Troubleshooting](troubleshooting.md#remote-access).
