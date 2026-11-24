# Storage

The **Storage** page (and step 3 of the setup guide) lets you use extra drives for your movies, music, photos and files, without touching the terminal.

## How it works

- A **drive** is a physical disk. When you set one up, the kit mounts it at `/mnt/<name>`, for example `/mnt/media1`, and remembers it by its ID, so it keeps working if the order of your USB ports changes.
- A **library folder** is a fixed place an app looks, such as `/srv/media/movies`. You can point each one at a folder on any set-up drive. The apps always see the same path, whichever drive holds the files.

By default every library folder lives on the server's main drive. For a larger collection, use a bigger drive.

> **Screenshot to add:** the Storage page with one set-up drive and the library folder list.

The server's main drive (the one Ubuntu runs from) is never offered for erasing.

## Use a drive that already has files

Use this for a drive you already filled, for example with movies copied from another computer.

1. Plug the drive into the server and open the Storage page. It appears under **Drives**.
2. Press **Set up drive** and choose a short name. Your files on it are not changed. The name can use lowercase letters, numbers and dashes, must start with a letter, and can be up to 16 characters long.
3. The drive is now mounted and shows **Ready to use**.
4. In **Where your libraries are kept**, press **Change** next to a library (for example Movies), choose the drive, and type the folder on that drive that holds those files, such as `Movies`. Press **Use this drive**.

The apps that use that folder stop for a moment and start again.

If the library folder on the server already has files in it, you will see a box to **copy the files already there to the drive**. Leave it ticked unless you do not want them. If you do not copy them, they are hidden while the drive is in use, and they come back if you ever switch the folder back. The copy can take a long time and does not show a progress bar. Please keep the page open and the drive plugged in. Copied files also stay on the main drive, so free the space yourself if you need it.

## Prepare a new, empty drive

1. Plug it in. Press **Erase and prepare as a new drive** on its card.
2. Choose a name, press **Erase and prepare**, and type the drive code shown to confirm (for example `sdb`). If you were signed in more than 15 minutes ago, you are asked for your password again.
3. The kit erases the drive, formats it as ext4 (the best choice for Linux), mounts it and makes the standard folders.

**This destroys everything on the drive.** Check the model, size and serial number shown before you confirm (the serial number is printed on most drives, and is under **Show details** on the card). Double-check you picked the right one.

If drives were unplugged or swapped while the window was open, the kit notices that the drive is no longer the one you chose and erases nothing. Close the window and pick the drive again.

Preparing takes a few minutes. Keep the drive plugged in until it finishes.

## Drives from Windows (NTFS and exFAT)

You can mount an NTFS or exFAT drive and read and write it. This is handy for moving a drive over from a Windows PC.

These formats do not keep Linux file permissions, so everything on them appears owned by the server's own user. That is fine for movies and music. For Immich and Nextcloud, ext4 is the better choice, so prefer it for new drives.

A drive that was not shut down cleanly in Windows may refuse to mount. Plug it into Windows, let it check the drive and eject it properly, then try again.

## Unplug a drive safely

1. On the drive's card, press **Unmount**.
2. If apps are using it, the page offers **Stop apps and unmount**. Those apps are not started again for you, so start them again from Home once you have reconnected a drive.
3. Wait for **Safe to unplug.**, then unplug it.

Drives you unmount from the dashboard mount again by themselves the next time the server starts.

## When a drive goes missing

If a drive that you set up is not connected (it was unplugged, or the cable came loose), the Storage page says "**<name> is not connected**". The apps that use it show **Needs attention**. The kit stops them from writing into the empty folder, which would quietly fill your main drive and hide your files.

To fix it:

1. Plug the drive back in. It is found again after a moment, and the server also copes with a restart while it is unplugged.
2. If it does not come back by itself, press **Mount again** on its card.
3. Restart the apps that use it. A container that was already running keeps its old view of the folder until it is restarted.

## Health and free space

- Press **Check health** on a drive to see its health report (SMART). It warns you of early signs of failure. Some USB drives do not share this information, and the page says so.
- A library whose drive is more than 90 percent full shows **This drive is almost full.**
- The kit does not show health warnings on the Home page. Check now and then if the data matters.

## Not supported

RAID, mergerfs, SnapRAID, ZFS and network shares (SMB or NFS) are not part of the kit. They are possible on Ubuntu for advanced users, but the dashboard does not know about them, so set them up yourself and expect to manage them yourself.

**There are no scheduled backups in v1.** A second drive that you copy files to by hand is a good start. A drive in the server is not a backup, because a fire, a theft or a mistake loses both.
