# Removable Drives

USB sticks, SD cards, and external drives in the Omarchy bar — mount, open, and
safely eject them without a terminal.

The icon only exists while a drive does. Plug one in and it appears; pull it out
and the bar goes back to what it was.

```
bar:  [󱊞]

popup ──────────────────────────────────
 󱊞  Removable drives
    1 DRIVE · 1 MOUNTED                ⟳

 󱊞  SanDisk Ultra                      ⏏
    28.7 GB · USB

    PHOTOS                          󰝰 󰄝
    exFAT · 21.4 GB free · /run/media/…
    ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░

    ARCHIVE                            󰄠
    NTFS · 2.0 TB · Not mounted
──────────────────────────────────────────
```

## What it does

- **Appears only when it is needed.** No drive attached, no icon in the bar.
- **Mount and unmount** any removable volume, without a password — udisks2
  already allows the logged-in session to do this.
- **Open in your file manager**, either on click or automatically after
  mounting.
- **Eject properly**: unmounts every volume on the drive, re-locks anything
  encrypted, then powers the device down so it is genuinely safe to pull.
- **Free space at a glance**, with a usage bar that turns urgent past 90%.
- **Reacts instantly.** A `udevadm` event stream means the panel updates the
  moment a drive appears, rather than up to a poll interval later.
- **Encrypted volumes** are shown with a lock. Unlocking opens a terminal so
  the passphrase is typed into `udisksctl` rather than into a bar popup.
- **Never offers to eject the disk you booted from.** A USB-booted or
  Thunderbolt-attached system disk reports itself as removable just like a
  thumb drive; any disk holding `/`, `/boot`, `/home`, and friends is left out
  of the list entirely.

## Install

```bash
omarchy plugin add https://github.com/Wian47/omarchy-removable-drives.git --enable
```

Or by hand:

```bash
git clone https://github.com/Wian47/omarchy-removable-drives.git \
  ~/.config/omarchy/plugins/wian47.removable-drives
omarchy-shell shell rescanPlugins
omarchy plugin enable wian47.removable-drives --section right
```

Requires Omarchy 4 (Quattro) and a running `udisks2` — both are standard on
Omarchy.

## Using it

| Where | Action |
|---|---|
| Bar icon | left = open panel · right = rescan · middle = open the first mounted volume |
| Volume row | click = mount (and open), or open if already mounted |
| 󰄠 / 󰄝 | mount / unmount that volume |
| 󰝰 | open that volume in the file manager |
| ⏏ | eject the whole drive |

Keyboard, while the panel is open:

| Key | Action |
|---|---|
| `j` / `k` or ↑ / ↓ | move between drives and volumes |
| `Enter` / `Space` | mount and open a volume, or eject a drive |
| `m` | mount or unmount the selected volume |
| `o` | open the selected volume |
| `e` or `x` | eject the selected drive |
| `r` | rescan |
| `Esc` | close |

## Settings

Set these on the widget's entry in `~/.config/omarchy/shell.json`, or through
Setup > Plugins.

| Key | Default | What it does |
|---|---|---|
| `alwaysShow` | `false` | Keep the icon in the bar even with nothing attached |
| `openOnMount` | `true` | Open the file manager once a volume finishes mounting |
| `fileManager` | `""` | Command used to open a mount point; empty means `xdg-open` |
| `refreshIntervalSec` | `8` | How often free space is re-read *while the panel is open*. Drives are still detected instantly either way. |

```json
{ "id": "wian47.removable-drives", "openOnMount": false, "fileManager": "nautilus" }
```

## Scripting

The widget registers a `removable-drives` IPC target, so a keybind or script
can drive it:

```bash
omarchy-shell removable-drives toggle
omarchy-shell removable-drives list            # every drive and volume, as JSON
omarchy-shell removable-drives eject /dev/sdb  # unmount, lock, power off
omarchy-shell removable-drives refresh
```

## How it works

| File | Role |
|---|---|
| `Panel.qml` | Bar icon and popup: rows, keyboard cursor, actions |
| `Service.qml` | Everything that touches the system: `lsblk`, `udevadm`, `udisksctl` |
| `Model.js` | Pure parsing and formatting — no QML, no processes |
| `test/model.test.js` | Tests for the parsing rules, runnable without a compositor |

Nothing runs as root and nothing is installed system-wide. Mounting a removable
filesystem is `allow_active: yes` in the stock udisks2 policy, which is why no
password is asked for; anything needing more than that is handed to a terminal.

```bash
node test/model.test.js       # 20 tests, no compositor required
omarchy plugin validate .     # manifest check the shell itself would apply
```

## License

MIT
