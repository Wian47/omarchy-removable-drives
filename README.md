# Removable Drives

USB sticks, SD cards, phones, and external drives in the Omarchy bar — mount,
open, and safely eject them without a terminal.

![The panel: two USB drives with their volumes and free space, and a phone offering files and photos](preview.png?v=2)

The icon only exists while a drive does. Plug one in and it appears; pull it out
and the bar goes back to what it was.

## What it does

- **Mount, open, and eject** any removable volume without a password — udisks2
  already lets the logged-in session do it. Ejecting unmounts every volume on
  the drive, re-locks anything encrypted, then powers it down.
- **Knows when the drive is still being written to.** The icon turns urgent
  while the kernel has I/O in flight and the panel shows the live rate, because
  a copy dialog reaching 100% is not the moment a stick is safe to pull. An
  eject asked for mid-copy is held, then fires once the drive goes quiet.
- **Names who is holding a busy mount**, instead of stopping at `target is
  busy`, and offers a lazy unmount as an explicit second choice.
- **Phones and cameras** get their own section — Android over MTP, iPhone over
  AFC and PTP — with their access labelled `Files` or `Photos`.
- **Nicknames stick to the hardware.** They are keyed to the drive's serial,
  not to whichever `/dev/sdb` it landed on today. A drive can also run a
  command of your choosing when it appears.
- **Empties the trash you cannot see** — the `.Trash-1000` that quietly fills a
  stick with files you thought were deleted.
- **Renames the drive itself.** A nickname is private to this shell; the volume
  label is written to the filesystem and travels with the stick to every other
  machine that reads it. Each filesystem has its own ceiling — eleven
  characters on FAT32 and exFAT, sixteen on ext4 — and the field counts down
  against the right one as you type, rather than after a failed write.
- **Checks a filesystem, and repairs it only if you ask twice.** udisks runs
  the fsck; the panel unmounts the volume first and mounts it back afterwards,
  even if the check failed. Repair is the one thing here that rewrites a
  filesystem, so it appears only after a check has actually found something —
  never one stray click from the mount button. When the tool for a filesystem
  is missing, udisks names it and the panel offers to install it.
- **Never offers to eject the disk you booted from.** A USB-booted system disk
  reports itself as removable just like a thumb drive; anything holding `/`,
  `/boot` or `/home` is left out entirely.
- Plus: connect and remove notifications, a warning when a drive is pulled
  while still mounted, encrypted volumes unlocked through a terminal, free
  space bars, eject-all, and optional text beside the bar icon.

## Install

```bash
omarchy plugin add https://github.com/Wian47/omarchy-removable-drives.git --enable
```

Needs Omarchy 4 (Quattro) and `udisks2`, both standard. It calls `lsblk`,
`udevadm`, `udisksctl`, `busctl`, `gio`, `fuser`, `du`, `wl-copy` and Omarchy's
own `omarchy-*` helpers — nothing runs as root.

To remove it:

```bash
omarchy plugin remove wian47.removable-drives
rm ~/.local/state/omarchy/removable-drives.json   # optional: forget nicknames
```

It never writes to `shell.json` or your Hyprland config; the bar entry belongs
to Omarchy's plugin commands and nicknames live in the file above.

### Phones

Omarchy ships `gvfs-mtp`, so **Android works out of the box**. Apple devices
speak AFC and need more:

```bash
sudo pacman -S --needed usbmuxd gvfs-afc gvfs-gphoto2
```

A plugin may not install packages — Omarchy's installer never runs sudo, by
design — so when something is plugged in that gvfs cannot reach, the panel says
which packages are missing and offers to open Omarchy's installer.

A trusted iPhone appears as **two** entries: app documents over AFC, and the
camera roll over PTP. Apple limits both, and with iCloud Photos set to
"Optimize iPhone Storage" the camera roll can read as empty because the
originals are not on the device.

## Using it

| Where | Action |
|---|---|
| Bar icon | left = open · right = rescan · middle = open first mounted volume |
| Volume row | click = mount and open, or open if mounted · middle-click = copy its path |
| Phone row | click = browse (mounting on demand) |
| 󰄠 󰝰 󰄝 | mount · open · unmount that volume |
| 󰓹 󰓙 | rename the volume · check it for errors |
| ⏏ ✏ | eject the drive (or cancel a held eject) · nickname it |
| ⏏ in the header | eject every attached drive |

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
omarchy-shell removable-drives list                          # drives, as JSON
omarchy-shell removable-drives phones                        # phones, as JSON
omarchy-shell removable-drives status                        # {"busy":false,…}
omarchy-shell removable-drives eject /dev/sdb                # or ejectAll
omarchy-shell removable-drives rename /dev/sdb "Work backup" # "" clears it
omarchy-shell removable-drives label /dev/sdb1 "Photos"      # the label on the drive
omarchy-shell removable-drives check /dev/sdb1               # verdict lands in status
```

`status` reports `busy: true` while the kernel still has I/O in flight, so a
backup script can wait for the drive to settle. Both eject calls wait for
pending writes by themselves.

`rename` names the drive for this shell only; `label` writes to the filesystem.
`check` starts an fsck and returns straight away — the verdict arrives in
`status` as `healthy`, which is `true`, `false`, or `null` when the answer
could not be read. Anything other than `ok` back from these is the reason they
did not run, so a script never has to guess whether a refusal happened.

## How it works

`Panel.qml` draws the bar icon and popup, `Service.qml` owns everything that
touches the system, and `Model.js` is pure parsing and formatting with no QML
or processes — which is what makes it testable without a compositor.

Device-supplied strings — labels, vendor names, phone names — are hostile
input: whoever formatted a stick chooses its label. Every `Text` is pinned to
`Text.PlainText` so Qt cannot promote one to rich text and fetch a remote
`<img>`, and strings handed to components whose `Text` this plugin does not own
are stripped of angle brackets first. Paths stay byte-exact, since commands are
built from them.

Renaming a filesystem and running its fsck are the two things udisks exposes
on D-Bus that `udisksctl` has no verb for, so they go over the bus through
`busctl`. Both are `modify-device` in the udisks policy — `allow_active: yes`
for a removable drive, the same no-password path mounting already takes. The
object path is asked for rather than built, because udisks escapes the kernel
name into it and an unlocked LUKS volume ends up at `dm_2d3` rather than
anything the device node hints at. Both operations unmount the filesystem
first and mount it back afterwards, whether or not the middle step worked.

Emptying a drive's trash is the only recursive delete here, so the path is
re-derived from the live mount list and must exactly match a `.Trash-<uid>`
candidate of a mounted removable volume. The tests assert it refuses `/`,
`$HOME`, the mount root, and drives it is not tracking.

```bash
node test/model.test.js       # 116 tests, no compositor required
omarchy plugin validate .     # the same check the shell applies
```

## License

MIT
