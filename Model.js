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
var GLYPH_PHONE = codepoint(0xF011C)     // md-cellphone
var GLYPH_CAMERA = codepoint(0xF0100)    // md-camera
var GLYPH_TRASH = codepoint(0xF0A7A)     // md-trash_can_outline
var GLYPH_PENCIL = codepoint(0xF03EB)    // md-pencil
var GLYPH_TERMINAL = codepoint(0xF018D)  // md-console
var GLYPH_COPY = codepoint(0xF018F)      // md-content_copy

// ------------------------------------------------------------ formatting

// A QML Text defaults to Text.AutoText, which promotes anything that looks
// like markup to rich text — and Qt's rich text fetches <img src="http://...">.
// Drive labels, vendor strings and phone names are all chosen by the device
// rather than by the user, so they are hostile input.
//
// Every Text this plugin owns is pinned to Text.PlainText. This is for the
// strings handed to components whose Text belongs to qs.Ui — the bar button
// and its tooltip — where the format cannot be set from outside. Display only:
// paths and mount points must stay byte-exact for the commands built from them.
function plain(value) {
  return clean(value).replace(/[<>]/g, "")
}

// A mount point contains the filesystem label — /run/media/<user>/<LABEL> —
// so it is device-controlled, and it is concatenated into the shell commands
// that unmount and open it. POSIX single-quoting, with an embedded quote
// closed and reopened, is what keeps a crafted label from breaking out.
function shellQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

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
    uuid: clean(fsNode.uuid) || clean(part.uuid),
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
    serial: clean(node.serial),
    title: deviceTitle(node),
    nickname: "",
    key: "",
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
function navRows(devices, portables) {
  var rows = []
  for (var d = 0; d < (devices || []).length; d++) {
    rows.push({ kind: "device", device: d, volume: -1 })
    for (var v = 0; v < devices[d].volumes.length; v++) {
      rows.push({ kind: "volume", device: d, volume: v })
    }
  }
  for (var p = 0; p < (portables || []).length; p++) {
    rows.push({ kind: "portable", device: -1, volume: -1, portable: p })
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

// ---------------------------------------------------------------- activity
//
// A drive is only safe to pull once the kernel has finished writing to it,
// and the file manager's progress bar reaching 100% is not that moment —
// pages can still be in flight after the copy dialog closes. The kernel
// publishes the truth in /sys/block/<name>/stat, so read it rather than
// guess.

var SECTOR_BYTES = 512

// Parses `head -v -n1 /sys/block/<name>/stat ...`:
//
//   ==> /sys/block/sda/stat <==
//   79 4 7904 89 0 0 0 0 0 60 89
//
// Fields, 1-indexed: 1 read_ios, 2 read_merges, 3 read_sectors, 4 read_ticks,
// 5 write_ios, 6 write_merges, 7 write_sectors, 8 write_ticks, 9 in_flight.
function parseBlockStats(raw) {
  var out = {}
  var lines = String(raw || "").split("\n")
  var name = ""
  for (var i = 0; i < lines.length; i++) {
    var header = lines[i].match(/^==>\s*\/sys\/block\/([^\/]+)\/stat\s*<==/)
    if (header) {
      name = header[1]
      continue
    }
    if (name === "") continue
    var fields = clean(lines[i]).split(" ")
    if (fields.length >= 9) {
      out[name] = {
        readSectors: Number(fields[2]),
        writeSectors: Number(fields[6]),
        inFlight: Number(fields[8])
      }
    }
    name = ""
  }
  return out
}

// Counters restart at zero when a device is unplugged and comes back, so a
// negative delta means "this is a different device now", not "negative
// throughput".
function rateBetween(previousSectors, currentSectors, elapsedMs) {
  if (previousSectors === null || previousSectors === undefined) return 0
  if (!(elapsedMs > 0)) return 0
  var delta = Number(currentSectors) - Number(previousSectors)
  if (!isFinite(delta) || delta <= 0) return 0
  return (delta * SECTOR_BYTES) / (elapsedMs / 1000)
}

function buildActivity(previousSamples, stats, now) {
  var activity = {}
  var samples = {}
  for (var name in stats) {
    var current = stats[name]
    var previous = previousSamples ? previousSamples[name] : null
    var elapsed = previous ? now - previous.at : 0
    var writeRate = rateBetween(previous ? previous.writeSectors : null, current.writeSectors, elapsed)
    var readRate = rateBetween(previous ? previous.readSectors : null, current.readSectors, elapsed)
    activity[name] = {
      writeRate: writeRate,
      readRate: readRate,
      inFlight: current.inFlight,
      writing: writeRate > 0,
      busy: writeRate > 0 || current.inFlight > 0
    }
    samples[name] = { writeSectors: current.writeSectors, readSectors: current.readSectors, at: now }
  }
  return { activity: activity, samples: samples }
}

// Below a kilobyte a second there is nothing worth showing; the number would
// flicker between "0 B/s" and "512 B/s" on an idle drive.
function formatRate(bytesPerSecond) {
  var n = Number(bytesPerSecond)
  if (!isFinite(n) || n < 1024) return ""
  return formatBytes(n) + "/s"
}

function activityLabel(entry) {
  if (!entry) return ""
  var write = formatRate(entry.writeRate)
  if (write !== "") return "Writing " + write
  var read = formatRate(entry.readRate)
  if (read !== "") return "Reading " + read
  if (entry.busy) return "Busy"
  return ""
}

// --------------------------------------------------------------- blockers

// `ps -o pid=,comm= -p <pids>` prints "  4821 nautilus" per line.
function parseBlockers(raw) {
  var out = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = clean(lines[i]).match(/^(\d+)\s+(.+)$/)
    if (match) out.push({ pid: Number(match[1]), name: match[2] })
  }
  return out
}

// Names, not pids, and deduplicated: five nautilus threads holding a mount is
// one thing to close, not five.
function describeBlockers(blockers) {
  if (!blockers || blockers.length === 0) return ""
  var names = []
  for (var i = 0; i < blockers.length; i++) {
    if (names.indexOf(blockers[i].name) === -1) names.push(blockers[i].name)
  }
  if (names.length <= 3) return names.join(", ")
  return names.slice(0, 3).join(", ") + " and " + (names.length - 3) + " more"
}

// ---------------------------------------------------------------- arrivals

function deviceDiff(previous, current) {
  var previousPaths = {}
  var currentPaths = {}
  var added = []
  var removed = []
  var i
  for (i = 0; i < (previous || []).length; i++) previousPaths[previous[i].path] = true
  for (i = 0; i < (current || []).length; i++) currentPaths[current[i].path] = true
  for (i = 0; i < (current || []).length; i++) {
    if (!previousPaths[current[i].path]) added.push(current[i])
  }
  for (i = 0; i < (previous || []).length; i++) {
    if (!currentPaths[previous[i].path]) removed.push(previous[i])
  }
  return { added: added, removed: removed }
}

function connectedSummary(device) {
  if (!device) return ""
  var count = device.volumes.length
  var volumes = count === 1 ? "1 volume" : count + " volumes"
  return device.sizeText + " · " + volumes
}

// The quiet-streak rule behind a deferred eject. Throughput dips to zero
// between bursts of a copy, so a single idle sample does not mean the drive is
// finished; only a run of them does.
function advanceQuiet(stillBusy, quietTicks, requiredTicks) {
  if (stillBusy) return { quietTicks: 0, run: false }
  var next = Number(quietTicks || 0) + 1
  return { quietTicks: next, run: next >= requiredTicks }
}

// -------------------------------------------------------------- bar label

// Optional text beside the bar icon. One drive is the common case, so the
// label describes that one and only counts the rest.
function barLabelText(devices, mode) {
  if (!devices || devices.length === 0) return ""
  if (mode === "count") return String(devices.length)

  var extra = devices.length > 1 ? " +" + (devices.length - 1) : ""
  if (mode === "name") return plain(devices[0].title) + extra
  if (mode === "free") {
    for (var d = 0; d < devices.length; d++) {
      var volumes = devices[d].volumes
      for (var v = 0; v < volumes.length; v++) {
        if (volumes[v].mounted && volumes[v].fsavail > 0) return formatBytes(volumes[v].fsavail) + extra
      }
    }
    return ""
  }
  return ""
}

// ------------------------------------------------------------------ trash
//
// Removable media collects a .Trash-<uid> that nothing surfaces, so a stick
// can be "full" of files the user believes they deleted. Both layouts in the
// freedesktop spec are checked.

function trashCandidates(mountpoint, uid) {
  var mount = clean(mountpoint)
  if (mount === "" || uid === undefined || uid === null) return []
  return [mount + "/.Trash-" + uid, mount + "/.Trash/" + uid]
}

// The guard in front of a recursive delete. A path qualifies only by being
// exactly one of the candidates of a mount point we are currently tracking —
// never by pattern-matching, so a crafted label or a stale path cannot widen
// what gets removed.
function isSafeTrashPath(path, mountpoints, uid) {
  var target = clean(path)
  if (target === "") return false
  for (var i = 0; i < (mountpoints || []).length; i++) {
    var candidates = trashCandidates(mountpoints[i], uid)
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c] === target) return true
    }
  }
  return false
}

// `du -sb` prints "<bytes>\t<path>" per line, and complains to stderr about
// the candidates that do not exist — which is most of them.
function parseSizes(raw) {
  var out = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^(\d+)\s+(.+)$/)
    if (match) out[match[2].replace(/\s+$/, "")] = Number(match[1])
  }
  return out
}

// ------------------------------------------------------- per-drive memory

// A key that survives replugging, so a nickname sticks to the drive rather
// than to whichever /dev node it lands on. Serial is best; a partition UUID
// is the fallback for drives that report none, and the last resort merely
// distinguishes two different models rather than two identical sticks.
function driveKey(device) {
  if (!device) return ""
  var serial = clean(device.serial)
  if (serial !== "") return "serial:" + serial
  for (var i = 0; i < device.volumes.length; i++) {
    var uuid = clean(device.volumes[i].uuid)
    if (uuid !== "") return "uuid:" + uuid
  }
  return "model:" + clean(device.title) + ":" + device.sizeBytes
}

function driveSettings(store, device) {
  var key = driveKey(device)
  if (key === "" || !store || !store.drives) return {}
  return store.drives[key] || {}
}

// Nicknames are applied after parsing so everything downstream — the panel,
// the bar label, notifications — says the name the user chose without each
// caller having to remember to look it up.
function applyStore(devices, store) {
  for (var i = 0; i < devices.length; i++) {
    var saved = driveSettings(store, devices[i])
    var nickname = clean(saved.nickname)
    devices[i].key = driveKey(devices[i])
    devices[i].nickname = nickname
    devices[i].deviceName = devices[i].title
    if (nickname !== "") devices[i].title = nickname
  }
  return devices
}

function withDriveSetting(store, device, name, value) {
  var next = { version: 1, drives: {} }
  if (store && store.drives) {
    for (var k in store.drives) next.drives[k] = store.drives[k]
  }
  var key = driveKey(device)
  if (key === "") return next
  var entry = {}
  var existing = next.drives[key] || {}
  for (var f in existing) entry[f] = existing[f]
  if (value === null || value === "" || value === undefined) delete entry[name]
  else entry[name] = value
  if (Object.keys(entry).length === 0) delete next.drives[key]
  else next.drives[key] = entry
  return next
}

function parseStore(raw) {
  try {
    var parsed = JSON.parse(String(raw || "").replace(/^\s+|\s+$/g, "") || "{}")
    if (!parsed || typeof parsed !== "object") return { version: 1, drives: {} }
    return { version: 1, drives: parsed.drives || {} }
  } catch (e) {
    return { version: 1, drives: {} }
  }
}

// ------------------------------------------------------- phones & cameras
//
// A phone is not a block device — it speaks MTP, and gvfs is what mounts it.
// `gio mount -li` prints nested Drive/Volume/Mount blocks; the ones that
// matter identify themselves either by their volume-monitor type or by an
// mtp:// / gphoto2:// URI, so either signal is enough to catch one.

var PORTABLE_URI = /^(mtp|gphoto2|afc):\/\//

// An iPhone speaks PTP, so gvfs files it under the gphoto2 backend and its
// icon set says "camera". It is still a phone to the person holding it, so the
// name decides what it looks like and the backend decides what it can reach.
var PHONE_NAME = /iphone|ipad|android|phone|pixel|galaxy|oneplus|xiaomi|nexus|redmi/i

function isPortableType(typeLine) {
  return /MTP|GPhoto2|Afc/i.test(String(typeLine || ""))
}

function parseGioMounts(raw) {
  var out = []
  var lines = String(raw || "").split("\n")
  var current = null
  var mountsByName = {}

  function flush() {
    if (!current) return
    var isPortable = isPortableType(current.type) || PORTABLE_URI.test(current.uri)
    if (isPortable && clean(current.name) !== "") {
      var name = clean(current.name)
      var scheme = (clean(current.uri).match(/^([a-z0-9]+):\/\//) || ["", ""])[1]
      var looksLikeCamera = scheme === "gphoto2" || /GPhoto2/i.test(current.type)
      out.push({
        name: name,
        uri: clean(current.uri),
        mounted: current.mounted === true,
        scheme: scheme,
        // PTP only ever exposes the camera roll; MTP and AFC reach further.
        access: looksLikeCamera ? "Photos" : "Files",
        kind: PHONE_NAME.test(name) ? "phone" : (looksLikeCamera ? "camera" : "phone")
      })
    }
    current = null
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    // A new Volume or Drive block ends the previous one. Volumes are what
    // can be mounted, so a Drive block only starts one when no Volume
    // follows it — flushing on both keeps the two cases from merging.
    var volume = line.match(/^\s*Volume\(\d+\):\s*(.+?)\s*$/)
    if (volume) {
      flush()
      current = { name: volume[1], type: "", uri: "", mounted: false }
      continue
    }
    var drive = line.match(/^\s*Drive\(\d+\):\s*(.+?)\s*$/)
    if (drive) {
      flush()
      current = { name: drive[1], type: "", uri: "", mounted: false }
      continue
    }
    if (!current) continue

    var type = line.match(/^\s*Type:\s*(.+?)\s*$/)
    if (type) {
      if (current.type === "") current.type = type[1]
      continue
    }
    var activation = line.match(/^\s*activation_root=(\S+)\s*$/)
    if (activation) {
      if (current.uri === "") current.uri = activation[1]
      continue
    }
    // "Mount(0): Pixel 7 -> mtp://Google_Pixel_7_1234/" — the arrow target is
    // the URI, and the presence of the line is what says it is mounted.
    //
    // gio also prints top-level Mount lines after every Drive and Volume
    // block, so a mount belonging to one device can appear while a different
    // block is still open. Matching on the name is what stops an iPhone's
    // gphoto2 URI being overwritten by the afc mount listed after it.
    var mount = line.match(/^\s*Mount\(\d+\):\s*(.*?)\s*->\s*(\S+)\s*$/)
    if (mount) {
      var mountName = clean(mount[1])
      mountsByName[mountName] = mount[2]
      if (mountName === clean(current.name)) {
        current.mounted = true
        if (current.uri === "") current.uri = mount[2]
      }
      continue
    }
  }
  flush()

  // Mounts listed outside any block still prove their device is mounted —
  // matched by name, or by URI, because gvfs names an MTP daemon mount after
  // the backend ("Mount(1): mtp -> mtp://SAMSUNG_.../") rather than after the
  // device it belongs to.
  for (var m = 0; m < out.length; m++) {
    if (mountsByName[out[m].name] !== undefined) {
      out[m].mounted = true
      if (out[m].uri === "") out[m].uri = mountsByName[out[m].name]
      continue
    }
    if (out[m].uri === "") continue
    for (var mountName in mountsByName) {
      if (mountsByName[mountName] === out[m].uri) {
        out[m].mounted = true
        break
      }
    }
  }

  // gvfs reports one phone as both a Drive and a Volume under the same
  // display name, and only the Volume carries the URI. Merge by name so the
  // pair becomes one row that knows both its URI and whether it is mounted.
  var byName = {}
  var ordered = []
  for (var o = 0; o < out.length; o++) {
    var entry = out[o]
    var seen = byName[entry.name]
    if (seen) {
      if (seen.uri === "" && entry.uri !== "") seen.uri = entry.uri
      if (entry.mounted) seen.mounted = true
      if (seen.scheme === "" && entry.scheme !== "") {
        seen.scheme = entry.scheme
        seen.access = entry.access
      }
      if (entry.kind === "camera" && !PHONE_NAME.test(seen.name)) seen.kind = "camera"
      continue
    }
    byName[entry.name] = entry
    ordered.push(entry)
  }

  // A device with no URI — a phone still locked, so gvfs has published the
  // drive but no volume — offers nothing to mount or open, so it is left out
  // rather than drawn as a row whose buttons do nothing.
  var actionable = []
  for (var a = 0; a < ordered.length; a++) {
    if (ordered[a].uri !== "") actionable.push(ordered[a])
  }
  return actionable
}

function portableGlyph(entry) {
  return entry && entry.kind === "camera" ? GLYPH_CAMERA : GLYPH_PHONE
}

function portableMeta(entry) {
  if (!entry) return ""
  var access = entry.access || "Files"
  if (!entry.mounted) return access + " · not mounted"
  return access + " · mounted"
}

// -------------------------------------------------- backend availability
//
// A phone only appears here if gvfs has a backend that speaks its protocol:
// gvfs-mtp for Android, gvfs-afc (plus the usbmuxd daemon) for an iPhone,
// gvfs-gphoto2 for a camera. Omarchy ships gvfs-mtp, so Android works out of
// the box and Apple does not. A plugin may not install packages — Omarchy's
// plugin installer never runs sudo or install hooks — so the most it can
// honestly do is notice the gap and offer to open an installer.
//
// gvfs advertises what it can mount in /usr/share/gvfs/mounts/<scheme>.mount,
// which makes availability a file check rather than a guess.

var APPLE_VENDOR = "05ac"
var IMAGING_CLASS = "06"

function parseSupport(raw) {
  var backends = {}
  var devices = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = clean(lines[i])
    if (line === "") continue

    var backend = line.match(/^backend\s+(\S+)$/)
    if (backend) {
      backends[backend[1]] = true
      continue
    }
    // "usb 05ac,06,ff iPhone" — vendor first, then every interface class the
    // device exposes, then whatever name it reports.
    var usb = line.match(/^usb\s+(\S+)\s*(.*)$/)
    if (usb) {
      var fields = usb[1].split(",")
      devices.push({
        vendor: fields[0] || "",
        classes: fields.slice(1),
        name: clean(usb[2])
      })
    }
  }
  return { backends: backends, devices: devices }
}

// What to say when something is plugged in that gvfs cannot reach. Silence
// reads as a broken widget, which is the one outcome worth avoiding.
function supportHint(support) {
  if (!support) return null
  var backends = support.backends || {}
  var devices = support.devices || []

  for (var i = 0; i < devices.length; i++) {
    var device = devices[i]
    if (device.vendor === APPLE_VENDOR && !backends.afc) {
      return {
        text: (device.name !== "" ? device.name : "An Apple device") + " is connected, but Linux needs two more packages to browse it",
        detail: "usbmuxd and gvfs-afc",
        packages: "usbmuxd gvfs-afc gvfs-gphoto2",
        label: "iPhone support"
      }
    }
    if (device.classes.indexOf(IMAGING_CLASS) !== -1 && !backends.gphoto2 && !backends.mtp) {
      return {
        text: (device.name !== "" ? device.name : "A camera") + " is connected, but no gvfs backend can read it",
        detail: "gvfs-gphoto2",
        packages: "gvfs-gphoto2",
        label: "Camera support"
      }
    }
  }
  return null
}
