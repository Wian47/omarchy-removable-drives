# Removable Drives

USB sticks, SD cards, phones, and external drives in the Omarchy bar: mount,
open, and safely eject them without a terminal.

![The panel: three removable drives with their volumes, free space and per-volume actions, and a phone offering files](preview.png?v=3)

The icon only exists while a drive does. Plug one in and it appears; pull it out
and the bar goes back to what it was.

## What it does

- **Mount, open, and eject** any removable volume without a password, because
  udisks2 already lets the logged-in session do it. Ejecting unmounts every
  volume on the drive, re-locks anything encrypted, then powers it down.
- **Knows when the drive is still being written to.** The icon turns urgent
  while the kernel has I/O in flight and the panel shows the live rate, because
  a copy dialog reaching 100% is not the moment a stick is safe to pull. An
  eject asked for mid-copy is held, then fires once the drive goes quiet.
- **Names who is holding a busy mount**, instead of stopping at `target is
  busy`, and offers a lazy unmount as an explicit second choice.
- **Phones and cameras** get their own section: Android over MTP, iPhone over
  AFC and PTP, with their access labelled `Files` or `Photos`.
- **Unlocks an encrypted volume in place**, mounts it as the container opens,
  and closes it again from the same row without ejecting the drive.
- **Renames the volume label.** It travels with the stick to every machine
  that reads it, unlike a nickname, which never leaves this shell. The field
  counts down against that filesystem's own limit as you type.
- **Checks a filesystem, and repairs it only if you ask twice.** Repair is the
  one thing here that rewrites a filesystem, so it appears only after a check
  has found something, never one stray click from the mount button. A suspect
  drive mounts read-only first, so files come off without a byte going back.
- **Unmounts before the machine sleeps**, optionally, so a drive pulled from a
  sleeping laptop is not left half-written, and says which one refused when
  one does.
- **Nicknames stick to the hardware**, keyed to the drive's serial rather than
  whichever `/dev/sdb` it landed on today. A drive can also run a command of
  your choosing when it appears.
- **Empties the trash you cannot see**: the `.Trash-1000` that quietly fills a
  stick with files you thought were deleted.
- **Never offers to eject the disk you booted from.** A USB-booted system disk
  reports itself as removable just like a thumb drive; anything holding `/`,
  `/boot` or `/home` is left out entirely.
- Plus: connect and remove notifications, a warning when a drive is pulled
  while still mounted, free-space bars, eject-all, and optional text beside the
  bar icon.

## Install

```bash
omarchy plugin add https://github.com/Wian47/omarchy-removable-drives.git --enable
```

Needs Omarchy 4 (Quattro) and `udisks2`, both standard. It calls `lsblk`,
`udevadm`, `udisksctl`, `busctl`, `gio`, `fuser`, `du`, `wl-copy` and Omarchy's
own `omarchy-*` helpers. Nothing runs as root.

To remove it:

```bash
omarchy plugin remove wian47.removable-drives
rm ~/.local/state/omarchy/removable-drives.json   # optional: forget nicknames
```

It never writes to `shell.json` or your Hyprland config; the bar entry belongs
to Omarchy's plugin commands and nicknames live in the file above.

### Phones

Omarchy ships `gvfs-mtp`, so **Android works out of the box**. Apple devices
speak AFC and need three packages Omarchy does not ship: `usbmuxd`, `gvfs-afc`
and `gvfs-gphoto2`.

A plugin may not install packages itself, so when something is plugged in that
gvfs cannot reach, the panel names what is missing and offers to open Omarchy's
own installer.

A trusted iPhone appears as **two** entries: app documents over AFC, and the
camera roll over PTP. With iCloud Photos set to "Optimize iPhone Storage" the
camera roll can read as empty, because the originals are not on the device.

## Using it

| Where | Action |
|---|---|
| Bar icon | left = open · right = rescan · middle = open first mounted volume |
| Volume row | click = mount and open, or open if mounted · middle-click = copy its path |
| Phone row | click = browse (mounting on demand) |
| Mount / open / unmount icons | mount · open · unmount that volume |
| Rename / check icons | rename the volume · check it for errors |
| Read-only / repair icons | after a failed check: mount read-only · repair |
| Lock icon | locked: type the passphrase to unlock · open: lock it again |
| Eject / nickname icons | eject the drive (or cancel a held eject) · nickname it |
| Eject icon in the header | eject every attached drive |

Keyboard, while the panel is open:

| Key | | Key | |
|---|---|---|---|
| `j` `k` ↑ ↓ | move | `e` `x` | eject the drive |
| `Enter` `Space` | mount and open, or eject | `E` | eject every drive |
| `m` | mount or unmount | `t` | terminal at this volume |
| `o` | open | `y` | copy its path |
| `n` | nickname the drive | `r` `Esc` | rescan · close |
| `l` | rename the volume | `c` | check it for errors |

## Settings

Set on the widget's entry in `~/.config/omarchy/shell.json`, or through
Setup > Plugins.

| Key | Default | What it does |
|---|---|---|
| `alwaysShow` | `false` | Keep the icon in the bar with nothing attached |
| `openOnMount` | `true` | Open the file manager once a volume mounts |
| `notifications` | `true` | Announce drives, warn when one is pulled while mounted |
| `unmountOnSuspend` | `false` | Unmount every removable volume when the machine suspends |
| `fileManager` | `""` | Command used to open a mount point; empty means `xdg-open` |
| `barLabel` | `"none"` | Text beside the icon: `none`, `free`, `name`, `count` |
| `refreshIntervalSec` | `8` | How often free space is re-read while the panel is open |

Per-drive settings live in `~/.local/state/omarchy/removable-drives.json`, keyed
by serial and watched for changes, which is also how you attach a command to a
drive:

```json
{
  "version": 1,
  "drives": {
    "serial:0901f8ef1ed9c144": {
      "nickname": "Work backup",
      "onConnect": "rsync -a ~/Documents/ \"$2\"/documents/"
    }
  }
}
```

`onConnect` runs through `bash -c` when that drive appears, with `$1` as its
device path and `$2` as its first mount point. Nothing writes it for you.

## Scripting

```bash
omarchy-shell removable-drives toggle
omarchy-shell removable-drives refresh                       # re-read what is attached
omarchy-shell removable-drives list                          # drives, as JSON
omarchy-shell removable-drives phones                        # phones, as JSON
omarchy-shell removable-drives status                        # {"busy":false,…}
omarchy-shell removable-drives eject /dev/sdb                # or ejectAll
omarchy-shell removable-drives rename /dev/sdb "Work backup" # "" clears it
omarchy-shell removable-drives label /dev/sdb1 "Photos"      # the label on the drive
omarchy-shell removable-drives check /dev/sdb1               # verdict lands in status
omarchy-shell removable-drives mountReadOnly /dev/sdb1       # rescue without writing
omarchy-shell removable-drives lock /dev/mapper/luks-…       # close an open container
```

`status` reports `busy: true` while the kernel still has I/O in flight, so a
backup script can wait for the drive to settle; both eject calls wait by
themselves. `check` returns straight away and leaves its verdict in `status` as
`healthy`: `true`, `false`, or `null` when the answer could not be read.

Anything other than `ok` back from these is the reason they did not run, so a
script never has to guess whether a refusal happened.

## How it works

`Panel.qml` draws the bar icon and popup, `Service.qml` owns everything that
touches the system, and `Model.js` is pure parsing and formatting with no QML
or processes, which is what makes it testable without a compositor.

Device-supplied strings (labels, vendor names, phone names) are hostile
input: whoever formatted a stick chooses its label. Every `Text` is pinned to
`Text.PlainText` so Qt cannot promote one to rich text and fetch a remote
`<img>`, and strings handed to components whose `Text` this plugin does not own
are stripped of angle brackets first. Paths stay byte-exact, since commands are
built from them.

Renaming a filesystem and running its fsck are things udisks exposes on D-Bus
that `udisksctl` has no verb for, so they go over the bus through `busctl`. It
is still `allow_active: yes`, the same no-password path mounting takes. The
object path is asked for rather than built, since udisks escapes the kernel
name into it and an unlocked LUKS volume lands at `dm_2d3`. Both unmount the
filesystem first and mount it back afterwards, whether or not the middle step
worked.

A LUKS passphrase reaches udisks on stdin, never as an argument, because
`/proc/<pid>/cmdline` is readable by every other process you run. udisksctl
takes a key only from a file, so it is staged under `umask 077` in the
RAM-backed runtime directory and a trap removes it however the unlock ends.

Emptying a drive's trash is the only recursive delete here, so the path is
re-derived from the live mount list and must exactly match a `.Trash-<uid>`
candidate of a mounted removable volume. The tests assert it refuses `/`,
`$HOME`, the mount root, and drives it is not tracking.

```bash
node test/model.test.js       # 152 tests, no compositor required
omarchy plugin validate .     # the same check the shell applies
```

## License

MIT
