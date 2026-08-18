.pragma library

// Pure data layer for the Removable Drives widget. Everything here is a
// function of the `lsblk -J -b` tree — no processes, no QML types — so the
// parsing rules that decide "is this safe to eject?" can be read (and
// changed) in one place, apart from the UI that draws them.

// ---------------------------------------------------------------- glyphs
//
// Every codepoint below was verified against JetBrainsMono Nerd Font's cmap
// and post tables, so the names in the comments are the real glyph names
// rather than a guess at what the codepoint draws. They are written as
// codepoints rather than literals because these live in the Unicode private
// use area, where a stray editor or a copy-paste truncates them silently.
function codepoint(code) {
  if (String.fromCodePoint) return String.fromCodePoint(code)
  var offset = code - 0x10000
  return String.fromCharCode(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF))
}

var GLYPH_USB = codepoint(0xF129E)      // md-usb_flash_drive
var GLYPH_SD = codepoint(0xF0479)       // md-sd
var GLYPH_DISK = codepoint(0xF02CA)     // md-harddisk
var GLYPH_EJECT = codepoint(0xF01EA)    // md-eject
var GLYPH_FOLDER = codepoint(0xF0770)   // md-folder_open
var GLYPH_MOUNT = codepoint(0xF0120)    // md-tray_arrow_down
var GLYPH_UNMOUNT = codepoint(0xF011D)  // md-tray_arrow_up
var GLYPH_LOCKED = codepoint(0xF033E)   // md-lock
var GLYPH_UNLOCKED = codepoint(0xF033F) // md-lock_open
var GLYPH_ALERT = codepoint(0xF0028)    // md-alert_circle
var GLYPH_REFRESH = codepoint(0xF0450)  // md-refresh

// ------------------------------------------------------------ formatting

function clean(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").replace(/^ | $/g, "")
}

// 1024-based with short suffixes, matching what `lsblk` prints in its human
// column so the panel never disagrees with the terminal the user checks it
// against.
function formatBytes(bytes) {
  var n = Number(bytes)
  if (!isFinite(n) || n <= 0) return ""
  var units = ["B", "KB", "MB", "GB", "TB", "PB"]
  var i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  if (i === 0) return Math.round(n) + " B"
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i]
}

function formatFsType(fstype) {
  var fs = clean(fstype)
  if (fs === "") return ""
  if (fs === "vfat") return "FAT32"
  if (fs === "exfat") return "exFAT"
  if (fs === "ntfs" || fs === "ntfs3") return "NTFS"
  if (fs === "crypto_LUKS") return "LUKS"
  if (fs === "hfsplus") return "HFS+"
  if (fs === "apfs") return "APFS"
  return fs.toUpperCase()
}

// --------------------------------------------------------------- parsing

// Filesystem types that exist on a partition but can never be handed to
// `udisksctl mount`. Listing them keeps the row visible (so the partition
// still accounts for the space on the stick) while the mount action stays
// correctly disabled.
var UNMOUNTABLE = ["swap", "LVM2_member", "linux_raid_member", "zfs_member", "ddf_raid_member", "isw_raid_member"]

// Mount points that mean "this disk is running the machine". A USB-booted or
// Thunderbolt-attached system disk reports itself as hotplug/removable just
// like a thumb drive does, and offering to power it off is not a mistake
// worth making, so any disk holding one of these is dropped entirely.
var SYSTEM_MOUNTS = ["/", "/boot", "/boot/efi", "/efi", "/home", "/var", "/usr", "/nix", "/nix/store", "[SWAP]"]

function isVirtual(name) {
  return /^(zram|loop|ram|dm-|md|sr|fd)/.test(String(name || ""))
}

function isCandidateDisk(node) {
  if (!node || node.type !== "disk") return false
  if (isVirtual(node.name)) return false
  return node.rm === true || node.hotplug === true
}

function holdsSystemMount(node) {
  if (!node) return false
  var mp = clean(node.mountpoint)
  if (mp !== "" && SYSTEM_MOUNTS.indexOf(mp) !== -1) return true
  var mounts = node.mountpoints || []
  for (var m = 0; m < mounts.length; m++) {
    if (mounts[m] && SYSTEM_MOUNTS.indexOf(clean(mounts[m])) !== -1) return true
  }
  var kids = node.children || []
  for (var i = 0; i < kids.length; i++) {
    if (holdsSystemMount(kids[i])) return true
  }
  return false
}

function deviceGlyph(device) {
  if (/^mmcblk/.test(String(device.name || ""))) return GLYPH_SD
  if (clean(device.tran) === "usb") return GLYPH_USB
  return GLYPH_DISK
}

// Vendor and model both come padded and often overlapping ("SanDisk" +
// "SanDisk Ultra"), so join them only when the model doesn't already say it.
function deviceTitle(node) {
  var vendor = clean(node.vendor)
  var model = clean(node.model)
  var title = model
  if (vendor !== "" && model.toLowerCase().indexOf(vendor.toLowerCase()) === -1) {
    title = clean(vendor + " " + model)
  }
  if (title === "") title = clean(node.name)
  return title
}

function buildVolume(part, index) {
  // An unlocked LUKS partition carries its filesystem on a `crypt` child;
  // everything the user cares about (label, free space, mount point) lives
  // there, while unlock/lock still act on the partition itself.
  var holder = null
  var kids = part.children || []
  for (var i = 0; i < kids.length; i++) {
    if (kids[i] && (kids[i].type === "crypt" || kids[i].type === "lvm")) {
      holder = kids[i]
      break
    }
  }
  var fsNode = holder || part
  var partFs = clean(part.fstype)
  var encrypted = partFs === "crypto_LUKS"
  var fstype = clean(fsNode.fstype)
  var mountpoint = clean(fsNode.mountpoint)
  var label = clean(fsNode.label) || clean(part.label) || clean(part.partlabel)

  return {
    path: clean(part.path),
    fsPath: clean(fsNode.path),
    name: clean(part.name),
    index: index,
    label: label,
    title: label !== "" ? label : clean(part.name),
    fstype: fstype,
    fstypeLabel: formatFsType(fstype),
    sizeBytes: Number(part.size || 0),
    mountpoint: mountpoint,
    mounted: mountpoint !== "",
    encrypted: encrypted,
    unlocked: encrypted && holder !== null,
    fsavail: Number(fsNode.fsavail || 0),
    fssize: Number(fsNode.fssize || 0),
    fsused: Number(fsNode.fsused || 0)
  }
}

function isMountable(volume) {
  if (!volume) return false
  if (volume.mounted) return false
  if (volume.encrypted && !volume.unlocked) return false
  if (volume.fstype === "") return false
  return UNMOUNTABLE.indexOf(volume.fstype) === -1
}

function buildDevice(node) {
  var volumes = []
  var kids = node.children || []
  var parts = []
  for (var i = 0; i < kids.length; i++) {
    if (kids[i] && (kids[i].type === "part" || kids[i].type === "crypt")) parts.push(kids[i])
  }

  if (parts.length === 0) {
    // A stick formatted without a partition table: the disk *is* the volume.
    if (clean(node.fstype) !== "" || clean(node.mountpoint) !== "") volumes.push(buildVolume(node, 1))
  } else {
    for (var p = 0; p < parts.length; p++) volumes.push(buildVolume(parts[p], p + 1))
  }

  var mounted = 0
  for (var v = 0; v < volumes.length; v++) {
    if (volumes[v].mounted) mounted++
  }

  return {
    path: clean(node.path),
    name: clean(node.name),
    title: deviceTitle(node),
    glyph: deviceGlyph(node),
    tran: clean(node.tran),
    sizeBytes: Number(node.size || 0),
    sizeText: formatBytes(node.size),
    volumes: volumes,
    mountedCount: mounted
  }
}

function parse(raw) {
  var devices = []
  var json = JSON.parse(String(raw || "{}"))
  var nodes = json.blockdevices || []
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (!isCandidateDisk(node)) continue
    if (holdsSystemMount(node)) continue
    devices.push(buildDevice(node))
  }
  return devices
}

// ---------------------------------------------------------- presentation

function volumeMeta(volume) {
  if (!volume) return ""
  if (volume.encrypted && !volume.unlocked) return "Encrypted · " + formatBytes(volume.sizeBytes)

  var parts = []
  if (volume.fstypeLabel !== "") parts.push(volume.fstypeLabel)

  if (volume.mounted) {
    if (volume.fsavail > 0) parts.push(formatBytes(volume.fsavail) + " free")
    else parts.push(formatBytes(volume.sizeBytes))
    if (volume.mountpoint !== "") parts.push(volume.mountpoint)
  } else {
    parts.push(formatBytes(volume.sizeBytes))
    if (isMountable(volume)) parts.push("Not mounted")
    else if (volume.fstype !== "") parts.push("Not mountable")
  }
  return parts.join(" · ")
}

function usedFraction(volume) {
  if (!volume || !volume.mounted) return 0
  if (volume.fssize > 0 && volume.fsused >= 0) return Math.max(0, Math.min(1, volume.fsused / volume.fssize))
  return 0
}

function summary(devices) {
  var deviceCount = devices.length
  if (deviceCount === 0) return "No removable drives"
  var mounted = 0
  for (var i = 0; i < devices.length; i++) mounted += devices[i].mountedCount
  var text = deviceCount + (deviceCount === 1 ? " drive" : " drives")
  return text + " · " + mounted + " mounted"
}

function barGlyph(devices) {
  if (devices.length === 0) return GLYPH_USB
  return devices[0].glyph
}

function mountedVolumes(devices) {
  var out = []
  for (var d = 0; d < devices.length; d++) {
    var vols = devices[d].volumes
    for (var v = 0; v < vols.length; v++) {
      if (vols[v].mounted) out.push(vols[v])
    }
  }
  return out
}

// Flat list the panel walks with j/k. Device headers are cursor targets too,
// because ejecting is the one action that belongs to the whole device rather
// than to any single partition on it.
function navRows(devices) {
  var rows = []
  for (var d = 0; d < devices.length; d++) {
    rows.push({ kind: "device", device: d, volume: -1 })
    for (var v = 0; v < devices[d].volumes.length; v++) {
      rows.push({ kind: "volume", device: d, volume: v })
    }
  }
  return rows
}

// udisksctl reports failures as a full D-Bus error name followed by the part
// a person can act on ("target is busy"). Keep the readable tail.
function formatError(text) {
  var t = clean(text)
  var match = t.match(/Error\.[A-Za-z]+:\s*(.*)$/)
  if (match) t = clean(match[1])
  if (t === "") return ""
  return t.length > 160 ? t.substring(0, 157) + "…" : t
}
