// Tests for Model.js, the parsing layer. Run with: node test/model.test.js
//
// Model.js is a QML JavaScript resource, so it has a `.pragma library` line
// and no module exports. Loading it here as plain source and evaluating it in
// a function scope keeps the shipped file free of a test-only export block
// while still letting the rules that decide "is this safe to eject?" be
// checked without a compositor.

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  .replace(/^\.pragma library\s*$/m, "")

// `new Function` bodies do not export their declarations, so collect every
// top-level name and return them explicitly.
const names = [
  ...source.matchAll(/^function ([A-Za-z_$][\w$]*)/gm),
  ...source.matchAll(/^var ([A-Za-z_$][\w$]*)/gm)
].map(m => m[1])
const api = new Function(source + "\nreturn {" + names.map(n => `${n}: ${n}`).join(",") + "};")()

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log("  ok   " + name)
  } catch (error) {
    failures++
    console.log("  FAIL " + name + "\n       " + error.message)
  }
}

function disk(overrides) {
  return Object.assign({
    name: "sdb", path: "/dev/sdb", type: "disk", rm: true, hotplug: true,
    size: 30784094208, tran: "usb", vendor: "USB", model: "SanDisk 3.2Gen1",
    label: null, fstype: null, mountpoint: null, children: []
  }, overrides)
}

function part(overrides) {
  return Object.assign({
    name: "sdb1", path: "/dev/sdb1", type: "part", rm: true, hotplug: true,
    size: 15728640000, fstype: "vfat", label: "STICK", partlabel: null,
    mountpoint: null, fsavail: null, fssize: null, fsused: null, children: []
  }, overrides)
}

function tree(devices) {
  return JSON.stringify({ blockdevices: devices })
}

console.log("Model.parse")

test("finds a removable USB disk and its partitions", () => {
  const devices = api.parse(tree([disk({ children: [part({})] })]))
  assert.strictEqual(devices.length, 1)
  assert.strictEqual(devices[0].title, "USB SanDisk 3.2Gen1")
  assert.strictEqual(devices[0].volumes.length, 1)
  assert.strictEqual(devices[0].volumes[0].title, "STICK")
})

test("ignores a fixed internal disk", () => {
  const devices = api.parse(tree([disk({ name: "nvme0n1", rm: false, hotplug: false, tran: "nvme" })]))
  assert.strictEqual(devices.length, 0)
})

test("ignores zram, loop, and device-mapper nodes", () => {
  for (const name of ["zram0", "loop0", "dm-0"]) {
    const devices = api.parse(tree([disk({ name, rm: true })]))
    assert.strictEqual(devices.length, 0, name + " should be skipped")
  }
})

test("refuses to offer the disk the system is running from", () => {
  // A USB-booted or Thunderbolt-attached system disk reports itself as
  // removable; ejecting it would take the machine down.
  const devices = api.parse(tree([
    disk({ children: [part({ mountpoint: "/" }), part({ name: "sdb2", path: "/dev/sdb2", mountpoint: "/boot" })] })
  ]))
  assert.strictEqual(devices.length, 0)
})

test("keeps a drive whose mount point merely looks systemish", () => {
  const devices = api.parse(tree([disk({ children: [part({ mountpoint: "/run/media/wian47/BACKUP" })] })]))
  assert.strictEqual(devices.length, 1)
  assert.strictEqual(devices[0].volumes[0].mounted, true)
})

test("treats a disk with no partition table as one volume", () => {
  const devices = api.parse(tree([disk({ fstype: "exfat", label: "RAW", children: [] })]))
  assert.strictEqual(devices[0].volumes.length, 1)
  assert.strictEqual(devices[0].volumes[0].fstypeLabel, "exFAT")
  assert.strictEqual(devices[0].volumes[0].fsPath, "/dev/sdb")
})

test("reports an empty, unformatted disk with no volumes", () => {
  const devices = api.parse(tree([disk({ children: [] })]))
  assert.strictEqual(devices.length, 1)
  assert.strictEqual(devices[0].volumes.length, 0)
})

console.log("\nLUKS")

test("a locked partition is encrypted, not mountable, and not unlocked", () => {
  const devices = api.parse(tree([disk({ children: [part({ fstype: "crypto_LUKS", label: null })] })]))
  const volume = devices[0].volumes[0]
  assert.strictEqual(volume.encrypted, true)
  assert.strictEqual(volume.unlocked, false)
  assert.strictEqual(api.isMountable(volume), false)
  assert.strictEqual(volume.path, "/dev/sdb1")
})

test("an unlocked partition mounts its mapper device, not the partition", () => {
  const devices = api.parse(tree([disk({
    children: [part({
      fstype: "crypto_LUKS", label: null,
      children: [{
        name: "luks-abc", path: "/dev/mapper/luks-abc", type: "crypt",
        fstype: "ext4", label: "VAULT", mountpoint: null,
        fsavail: 1000, fssize: 2000, fsused: 1000, children: []
      }]
    })]
  })]))
  const volume = devices[0].volumes[0]
  assert.strictEqual(volume.unlocked, true)
  assert.strictEqual(volume.title, "VAULT")
  assert.strictEqual(volume.fsPath, "/dev/mapper/luks-abc")
  assert.strictEqual(volume.path, "/dev/sdb1")
  assert.strictEqual(api.isMountable(volume), true)
})

console.log("\nmountability")

test("swap and raid members are never offered as mountable", () => {
  for (const fstype of ["swap", "LVM2_member", "linux_raid_member"]) {
    assert.strictEqual(api.isMountable({ fstype, mounted: false, encrypted: false }), false, fstype)
  }
})

test("an already-mounted volume is not mountable again", () => {
  assert.strictEqual(api.isMountable({ fstype: "ext4", mounted: true, encrypted: false }), false)
})

console.log("\nformatting")

test("formats sizes the way lsblk does", () => {
  assert.strictEqual(api.formatBytes(0), "")
  assert.strictEqual(api.formatBytes(512), "512 B")
  assert.strictEqual(api.formatBytes(1024 * 1024 * 1.5), "1.5 MB")
  assert.strictEqual(api.formatBytes(30784094208), "28.7 GB")
})

test("renames filesystems to what people call them", () => {
  assert.strictEqual(api.formatFsType("vfat"), "FAT32")
  assert.strictEqual(api.formatFsType("exfat"), "exFAT")
  assert.strictEqual(api.formatFsType("ntfs"), "NTFS")
  assert.strictEqual(api.formatFsType("ext4"), "EXT4")
  assert.strictEqual(api.formatFsType(null), "")
})

test("does not repeat the vendor when the model already carries it", () => {
  assert.strictEqual(api.deviceTitle({ vendor: "SanDisk", model: "SanDisk Ultra", name: "sdb" }), "SanDisk Ultra")
  assert.strictEqual(api.deviceTitle({ vendor: "Kingston", model: "DT 100", name: "sdb" }), "Kingston DT 100")
  assert.strictEqual(api.deviceTitle({ vendor: null, model: null, name: "sdb" }), "sdb")
})

test("strips the D-Bus wrapper off a udisks error", () => {
  const raw = "Error unmounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: Target is busy"
  assert.strictEqual(api.formatError(raw), "Target is busy")
  assert.strictEqual(api.formatError(""), "")
})

console.log("\npresentation")

test("summarises what is attached", () => {
  assert.strictEqual(api.summary([]), "No removable drives")
  const devices = api.parse(tree([disk({ children: [part({ mountpoint: "/run/media/x/A" }), part({ name: "sdb2", path: "/dev/sdb2" })] })]))
  assert.strictEqual(api.summary(devices), "1 drive · 1 mounted")
})

test("free space only counts once a volume is mounted", () => {
  const mounted = api.parse(tree([disk({ children: [part({ mountpoint: "/run/media/x/A", fsavail: 5368709120, fssize: 10737418240, fsused: 5368709120 })] })]))
  assert.ok(api.volumeMeta(mounted[0].volumes[0]).includes("5.0 GB free"))
  assert.strictEqual(api.usedFraction(mounted[0].volumes[0]), 0.5)

  const unmounted = api.parse(tree([disk({ children: [part({})] })]))
  assert.ok(api.volumeMeta(unmounted[0].volumes[0]).includes("Not mounted"))
  assert.strictEqual(api.usedFraction(unmounted[0].volumes[0]), 0)
})

test("builds one navigation row per device plus one per volume", () => {
  const devices = api.parse(tree([disk({ children: [part({}), part({ name: "sdb2", path: "/dev/sdb2" })] })]))
  const rows = api.navRows(devices)
  assert.deepStrictEqual(rows.map(r => r.kind), ["device", "volume", "volume"])
  assert.strictEqual(rows[2].volume, 1)
})

test("picks an icon that matches the kind of drive", () => {
  assert.strictEqual(api.deviceGlyph({ name: "sdb", tran: "usb" }), api.GLYPH_USB)
  assert.strictEqual(api.deviceGlyph({ name: "mmcblk0", tran: null }), api.GLYPH_SD)
  assert.strictEqual(api.deviceGlyph({ name: "sdc", tran: "sata" }), api.GLYPH_DISK)
})

test("every glyph is a single private-use codepoint", () => {
  for (const name of names.filter(n => n.startsWith("GLYPH_"))) {
    const glyph = api[name]
    assert.strictEqual([...glyph].length, 1, name + " should be one codepoint")
    assert.ok(glyph.codePointAt(0) >= 0xE000, name + " should be in the private use area")
  }
})

console.log("\nactivity")

const STAT_SDA = `==> /sys/block/sda/stat <==
      79        4     7904       89        0        0        0        0        0       60       89
==> /sys/block/sdb/stat <==
     100        0    10000      100      200        0    40000      300        3      500      600`

test("reads the kernel I/O counters for every attached drive", () => {
  const stats = api.parseBlockStats(STAT_SDA)
  assert.deepStrictEqual(Object.keys(stats), ["sda", "sdb"])
  assert.strictEqual(stats.sda.writeSectors, 0)
  assert.strictEqual(stats.sda.inFlight, 0)
  assert.strictEqual(stats.sdb.writeSectors, 40000)
  assert.strictEqual(stats.sdb.inFlight, 3)
})

test("survives a truncated or empty stat read", () => {
  assert.deepStrictEqual(api.parseBlockStats(""), {})
  assert.deepStrictEqual(api.parseBlockStats("==> /sys/block/sda/stat <==\n"), {})
  assert.deepStrictEqual(api.parseBlockStats("garbage"), {})
})

test("turns two samples into a write rate", () => {
  // 2048 sectors of 512 bytes in one second = 1 MB/s.
  assert.strictEqual(api.rateBetween(0, 2048, 1000), 1024 * 1024)
  assert.strictEqual(api.rateBetween(1000, 1000, 1000), 0)
})

test("a counter that went backwards means a new device, not negative speed", () => {
  // Unplug and replug: the kernel restarts the counters at zero.
  assert.strictEqual(api.rateBetween(50000, 12, 1000), 0)
})

test("the first sample of a drive reports no rate, having nothing to compare", () => {
  assert.strictEqual(api.rateBetween(null, 40000, 1000), 0)
  const built = api.buildActivity({}, api.parseBlockStats(STAT_SDA), 1000)
  assert.strictEqual(built.activity.sdb.writeRate, 0)
  assert.strictEqual(built.activity.sdb.writing, false)
})

test("in-flight requests count as busy even at zero throughput", () => {
  // The dangerous moment: the copy dialog has closed, the counters have
  // stopped moving, and the kernel is still draining its queue.
  const built = api.buildActivity({}, api.parseBlockStats(STAT_SDA), 1000)
  assert.strictEqual(built.activity.sdb.busy, true, "3 requests in flight is busy")
  assert.strictEqual(built.activity.sda.busy, false, "an idle drive is not busy")
})

test("a second sample reports the rate between them", () => {
  const first = api.buildActivity({}, api.parseBlockStats(STAT_SDA), 1000)
  const later = STAT_SDA.replace("      200        0    40000", "      200        0    42048")
  const second = api.buildActivity(first.samples, api.parseBlockStats(later), 2000)
  assert.strictEqual(second.activity.sdb.writeRate, 1024 * 1024)
  assert.strictEqual(second.activity.sdb.writing, true)
  assert.strictEqual(api.activityLabel(second.activity.sdb), "Writing 1.0 MB/s")
})

test("hides rates too small to be meaningful", () => {
  assert.strictEqual(api.formatRate(0), "")
  assert.strictEqual(api.formatRate(400), "")
  assert.strictEqual(api.formatRate(1024 * 1024 * 24), "24.0 MB/s")
})

test("labels a busy but idle-looking drive rather than saying nothing", () => {
  assert.strictEqual(api.activityLabel({ writeRate: 0, readRate: 0, inFlight: 2, busy: true }), "Busy")
  assert.strictEqual(api.activityLabel({ writeRate: 0, readRate: 0, inFlight: 0, busy: false }), "")
  assert.strictEqual(api.activityLabel(null), "")
})

test("a deferred eject waits for a run of quiet samples, not just one", () => {
  // A copy in progress dips to zero between bursts; firing on the first idle
  // sample would cut power mid-transfer.
  let ticks = 0
  let step = api.advanceQuiet(true, ticks, 2)
  assert.deepStrictEqual(step, { quietTicks: 0, run: false }, "busy resets the streak")

  step = api.advanceQuiet(false, step.quietTicks, 2)
  assert.deepStrictEqual(step, { quietTicks: 1, run: false }, "one quiet sample is not enough")

  step = api.advanceQuiet(false, step.quietTicks, 2)
  assert.deepStrictEqual(step, { quietTicks: 2, run: true }, "two in a row means finished")
})

test("a burst mid-wait sends the streak back to zero", () => {
  let step = api.advanceQuiet(false, 0, 2)
  assert.strictEqual(step.quietTicks, 1)
  step = api.advanceQuiet(true, step.quietTicks, 2)
  assert.strictEqual(step.quietTicks, 0, "the drive woke up again")
  assert.strictEqual(step.run, false)
})

console.log("\nblockers")

test("names the processes holding a mount", () => {
  const raw = "   4821 nautilus\n   5102 mpv\n"
  assert.deepStrictEqual(api.parseBlockers(raw), [
    { pid: 4821, name: "nautilus" },
    { pid: 5102, name: "mpv" }
  ])
  assert.strictEqual(api.describeBlockers(api.parseBlockers(raw)), "nautilus, mpv")
})

test("counts one program once, however many threads it holds open with", () => {
  const many = api.parseBlockers("1 nautilus\n2 nautilus\n3 nautilus\n")
  assert.strictEqual(api.describeBlockers(many), "nautilus")
})

test("summarises a long list instead of overflowing the row", () => {
  const many = api.parseBlockers("1 a\n2 b\n3 c\n4 d\n5 e\n")
  assert.strictEqual(api.describeBlockers(many), "a, b, c and 2 more")
  assert.strictEqual(api.describeBlockers([]), "")
})

console.log("\narrivals and removals")

const A = { path: "/dev/sda", title: "SanDisk", mountedCount: 1 }
const B = { path: "/dev/sdb", title: "Kingston", mountedCount: 0 }

test("spots a drive appearing and disappearing", () => {
  assert.deepStrictEqual(api.deviceDiff([A], [A, B]).added.map(d => d.path), ["/dev/sdb"])
  assert.deepStrictEqual(api.deviceDiff([A, B], [A]).removed.map(d => d.path), ["/dev/sdb"])
  const quiet = api.deviceDiff([A, B], [A, B])
  assert.strictEqual(quiet.added.length + quiet.removed.length, 0)
})

test("handles the first snapshot, when there is no previous list", () => {
  assert.deepStrictEqual(api.deviceDiff([], [A]).added.map(d => d.path), ["/dev/sda"])
  assert.deepStrictEqual(api.deviceDiff(undefined, [A]).added.map(d => d.path), ["/dev/sda"])
})

test("keeps the removed device object, so the warning can name it", () => {
  // The removal notification needs to know it was still mounted, which is
  // only knowable from the list we are throwing away.
  const removed = api.deviceDiff([A], []).removed[0]
  assert.strictEqual(removed.title, "SanDisk")
  assert.strictEqual(removed.mountedCount, 1)
})

test("describes a drive the way a notification should read", () => {
  const devices = api.parse(tree([disk({ children: [part({}), part({ name: "sdb2", path: "/dev/sdb2" })] })]))
  assert.strictEqual(api.connectedSummary(devices[0]), "28.7 GB · 2 volumes")
  const single = api.parse(tree([disk({ children: [part({})] })]))
  assert.strictEqual(api.connectedSummary(single[0]), "28.7 GB · 1 volume")
})

console.log("\nbar label")

const LABEL_DEVICES = api.parse(tree([disk({ children: [part({ mountpoint: "/run/media/x/A", fsavail: 21474836480 })] })]))

test("describes the drive rather than the fleet", () => {
  assert.strictEqual(api.barLabelText(LABEL_DEVICES, "name"), "USB SanDisk 3.2Gen1")
  assert.strictEqual(api.barLabelText(LABEL_DEVICES, "free"), "20.0 GB")
  assert.strictEqual(api.barLabelText(LABEL_DEVICES, "count"), "1")
  assert.strictEqual(api.barLabelText(LABEL_DEVICES, "none"), "")
  assert.strictEqual(api.barLabelText([], "name"), "")
})

test("counts the other drives instead of listing them", () => {
  const two = api.parse(tree([
    disk({ children: [part({ mountpoint: "/run/media/x/A", fsavail: 21474836480 })] }),
    disk({ name: "sdc", path: "/dev/sdc", model: "Kingston DT", children: [part({ name: "sdc1", path: "/dev/sdc1" })] })
  ]))
  assert.strictEqual(api.barLabelText(two, "name"), "USB SanDisk 3.2Gen1 +1")
  assert.strictEqual(api.barLabelText(two, "free"), "20.0 GB +1")
  assert.strictEqual(api.barLabelText(two, "count"), "2")
})

test("says nothing when no free figure is knowable", () => {
  // An unmounted drive, or a full read-only ISO, has no free space to report.
  const unmounted = api.parse(tree([disk({ children: [part({})] })]))
  assert.strictEqual(api.barLabelText(unmounted, "free"), "")
})

console.log("\ntrash")

test("knows both trash layouts in the spec", () => {
  assert.deepStrictEqual(api.trashCandidates("/run/media/x/STICK", "1000"),
    ["/run/media/x/STICK/.Trash-1000", "/run/media/x/STICK/.Trash/1000"])
  assert.deepStrictEqual(api.trashCandidates("", "1000"), [])
})

test("only accepts a trash path belonging to a live mount point", () => {
  const mounts = ["/run/media/x/STICK"]
  assert.strictEqual(api.isSafeTrashPath("/run/media/x/STICK/.Trash-1000", mounts, "1000"), true)
  assert.strictEqual(api.isSafeTrashPath("/run/media/x/STICK/.Trash/1000", mounts, "1000"), true)
})

test("refuses anything that is not exactly a candidate", () => {
  // The guard in front of `rm -rf`: no prefix matching, no globbing, no
  // traversal, and nothing belonging to a mount we are not tracking.
  const mounts = ["/run/media/x/STICK"]
  for (const evil of [
    "/",
    "/home/wian47",
    "/run/media/x/STICK",
    "/run/media/x/STICK/",
    "/run/media/x/STICK/.Trash-1000/..",
    "/run/media/x/STICK/.Trash-1000/../../..",
    "/run/media/x/OTHER/.Trash-1000",
    "/run/media/x/STICK/.Trash-999",
    "/run/media/x/STICK/Documents",
    ""
  ]) {
    assert.strictEqual(api.isSafeTrashPath(evil, mounts, "1000"), false, evil + " must be refused")
  }
  assert.strictEqual(api.isSafeTrashPath("/run/media/x/STICK/.Trash-1000", [], "1000"), false,
    "no mounts means nothing is safe")
})

test("reads du output and ignores its complaints", () => {
  const raw = "4096\t/run/media/x/STICK/.Trash-1000\n12\t/run/media/x/OTHER/.Trash-1000\n"
  assert.deepStrictEqual(api.parseSizes(raw), {
    "/run/media/x/STICK/.Trash-1000": 4096,
    "/run/media/x/OTHER/.Trash-1000": 12
  })
  assert.deepStrictEqual(api.parseSizes("du: cannot access ...: No such file or directory"), {})
  assert.deepStrictEqual(api.parseSizes(""), {})
})

console.log("\nper-drive memory")

test("keys a drive by something that survives replugging", () => {
  const withSerial = api.parse(tree([disk({ serial: "ABC123", children: [part({})] })]))[0]
  assert.strictEqual(api.driveKey(withSerial), "serial:ABC123")

  const noSerial = api.parse(tree([disk({ serial: null, children: [part({ uuid: "DEAD-BEEF" })] })]))[0]
  assert.strictEqual(api.driveKey(noSerial), "uuid:DEAD-BEEF")

  const neither = api.parse(tree([disk({ serial: null, children: [part({ uuid: null })] })]))[0]
  assert.ok(api.driveKey(neither).startsWith("model:"))
})

test("a nickname replaces the title but never loses the real name", () => {
  const devices = api.parse(tree([disk({ serial: "ABC123", children: [part({})] })]))
  const store = { version: 1, drives: { "serial:ABC123": { nickname: "Work backup" } } }
  api.applyStore(devices, store)
  assert.strictEqual(devices[0].title, "Work backup")
  assert.strictEqual(devices[0].nickname, "Work backup")
  assert.strictEqual(devices[0].deviceName, "USB SanDisk 3.2Gen1")
})

test("an unknown drive keeps its hardware name", () => {
  const devices = api.parse(tree([disk({ serial: "OTHER", children: [part({})] })]))
  api.applyStore(devices, { version: 1, drives: { "serial:ABC123": { nickname: "Work backup" } } })
  assert.strictEqual(devices[0].title, "USB SanDisk 3.2Gen1")
  assert.strictEqual(devices[0].nickname, "")
})

test("saving a setting leaves every other drive alone", () => {
  const device = api.parse(tree([disk({ serial: "ABC123", children: [part({})] })]))[0]
  const before = { version: 1, drives: { "serial:OTHER": { nickname: "Photos" } } }
  const after = api.withDriveSetting(before, device, "nickname", "Work backup")
  assert.strictEqual(after.drives["serial:OTHER"].nickname, "Photos")
  assert.strictEqual(after.drives["serial:ABC123"].nickname, "Work backup")
  assert.strictEqual(before.drives["serial:ABC123"], undefined, "the original store is not mutated")
})

test("clearing a nickname removes the entry rather than storing an empty one", () => {
  const device = api.parse(tree([disk({ serial: "ABC123", children: [part({})] })]))[0]
  const stored = api.withDriveSetting({ version: 1, drives: {} }, device, "nickname", "Work backup")
  const cleared = api.withDriveSetting(stored, device, "nickname", "")
  assert.deepStrictEqual(cleared.drives, {})
})

test("keeps a drive's other settings when one of them changes", () => {
  const device = api.parse(tree([disk({ serial: "ABC123", children: [part({})] })]))[0]
  let store = api.withDriveSetting({ version: 1, drives: {} }, device, "onConnect", "rsync -a /src /dst")
  store = api.withDriveSetting(store, device, "nickname", "Backup")
  assert.strictEqual(store.drives["serial:ABC123"].onConnect, "rsync -a /src /dst")
  assert.strictEqual(store.drives["serial:ABC123"].nickname, "Backup")
})

test("a corrupt or missing state file reads as empty, not as a crash", () => {
  assert.deepStrictEqual(api.parseStore("").drives, {})
  assert.deepStrictEqual(api.parseStore("{ not json").drives, {})
  assert.deepStrictEqual(api.parseStore("null").drives, {})
  assert.deepStrictEqual(api.parseStore('{"drives":{"serial:A":{"nickname":"X"}}}').drives, { "serial:A": { nickname: "X" } })
})

console.log("\nphones and cameras")

// Shape of `gio mount -li` with a phone attached: gvfs reports the same
// device as a Drive and a Volume, and adds a Mount line once it is mounted.
const GIO_PHONE = `Drive(0): WD PC SN5000S
  Type: GProxyDrive (GProxyVolumeMonitorUDisks2)
  is_removable=0
  Volume(0): 755 GB Volume
    Type: GProxyVolume (GProxyVolumeMonitorUDisks2)
    uuid=3E30553F3054FF79
Drive(1): Pixel 7
  Type: GProxyDrive (GProxyVolumeMonitorMTP)
  Volume(0): Pixel 7
    Type: GProxyVolume (GProxyVolumeMonitorMTP)
    activation_root=mtp://Google_Pixel_7_1A2B3C/
    Mount(0): Pixel 7 -> mtp://Google_Pixel_7_1A2B3C/
      Type: GProxyShadowMount (GProxyVolumeMonitorMTP)`

test("finds a phone and ignores the internal disk", () => {
  const found = api.parseGioMounts(GIO_PHONE)
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].name, "Pixel 7")
  assert.strictEqual(found[0].uri, "mtp://Google_Pixel_7_1A2B3C/")
  assert.strictEqual(found[0].mounted, true)
  assert.strictEqual(found[0].kind, "phone")
})

test("reports an attached but unmounted phone", () => {
  const withoutMount = GIO_PHONE.split("\n").filter(l => !/Mount\(0\)|GProxyShadowMount/.test(l)).join("\n")
  const found = api.parseGioMounts(withoutMount)
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].mounted, false)
  assert.strictEqual(found[0].uri, "mtp://Google_Pixel_7_1A2B3C/")
})

test("recognises a camera as a camera", () => {
  const camera = `Drive(0): Canon EOS
  Type: GProxyDrive (GProxyVolumeMonitorGPhoto2)
  Volume(0): Canon EOS
    Type: GProxyVolume (GProxyVolumeMonitorGPhoto2)
    activation_root=gphoto2://usb%3A001%2C012/`
  const found = api.parseGioMounts(camera)
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].kind, "camera")
  assert.strictEqual(api.portableGlyph(found[0]), api.GLYPH_CAMERA)
  assert.strictEqual(api.portableGlyph({ kind: "phone" }), api.GLYPH_PHONE)
})

test("collapses the drive and volume gvfs reports for one phone", () => {
  const found = api.parseGioMounts(GIO_PHONE)
  assert.strictEqual(found.filter(e => e.uri === "mtp://Google_Pixel_7_1A2B3C/").length, 1)
})

test("catches a device by its URI even if the type line is unfamiliar", () => {
  // gvfs backend names have changed before; the mtp:// URI is the sturdier
  // signal, so either one alone is enough.
  const odd = `Volume(0): Some Phone
    Type: GProxyVolume (SomeFutureBackend)
    activation_root=mtp://Some_Phone_9/`
  const found = api.parseGioMounts(odd)
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].name, "Some Phone")
})

test("finds nothing in a listing that has no portable device", () => {
  const onlyDisks = GIO_PHONE.split("Drive(1)")[0]
  assert.deepStrictEqual(api.parseGioMounts(onlyDisks), [])
  assert.deepStrictEqual(api.parseGioMounts(""), [])
  assert.deepStrictEqual(api.parseGioMounts("nonsense"), [])
})

test("describes what the device actually gives you", () => {
  // PTP only ever exposes the camera roll, so saying "Files" would be a lie.
  assert.strictEqual(api.portableMeta({ access: "Photos", mounted: true }), "Photos · mounted")
  assert.strictEqual(api.portableMeta({ access: "Files", mounted: true }), "Files · mounted")
  assert.strictEqual(api.portableMeta({ access: "Photos", mounted: false }), "Photos · not mounted")
  assert.strictEqual(api.portableMeta(null), "")
})

// Captured verbatim from `gio mount -li` with an iPhone 05ac:12a8 attached.
// An iPhone speaks PTP, so gvfs files it under gphoto2 with camera icons —
// this is the case that made the naive "gphoto2 means camera" rule wrong.
const GIO_IPHONE = `Volume(0): iPhone
    Type: GProxyVolume (GProxyVolumeMonitorGPhoto2)
    ids:
     unix-device: '/dev/bus/usb/005/002'
    activation_root=gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/
    themed icons:  [camera-photo]
    symbolic themed icons:  [camera-photo-symbolic]  [camera-symbolic]
    can_mount=1
    should_automount=1
    Mount(0): iPhone -> gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/
      Type: GProxyShadowMount (GProxyVolumeMonitorGPhoto2)
      is_shadowed=0
  Mount(1): iPhone -> gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/
    Type: GDaemonMount`

test("reads a real iPhone the way gvfs actually reports it", () => {
  const found = api.parseGioMounts(GIO_IPHONE)
  assert.strictEqual(found.length, 1, "the shadow mount and daemon mount are one device")
  assert.strictEqual(found[0].name, "iPhone")
  assert.strictEqual(found[0].mounted, true)
  assert.strictEqual(found[0].uri, "gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/")
})

test("an iPhone is a phone, even though gvfs calls it a camera", () => {
  const iphone = api.parseGioMounts(GIO_IPHONE)[0]
  assert.strictEqual(iphone.kind, "phone", "the glyph should not be a camera")
  assert.strictEqual(iphone.access, "Photos", "but PTP still only reaches the camera roll")
  assert.strictEqual(api.portableGlyph(iphone), api.GLYPH_PHONE)
  assert.strictEqual(api.portableMeta(iphone), "Photos · mounted")
})

// A trusted iPhone publishes TWO gvfs volumes — afc for app documents and
// gphoto2 for the camera roll — and gio repeats both as top-level Mount lines
// after every block. Those trailing lines are why a mount must be matched to
// its volume by name: attributing them positionally gave the iPhone the afc
// URI and sent "browse" to the wrong place.
const GIO_IPHONE_TRUSTED = `Drive(0): WD PC SN5000S SDEPNSJ-1T00-1006
  Type: GProxyDrive (GProxyVolumeMonitorUDisks2)
  Volume(0): 755 GB Volume
    Type: GProxyVolume (GProxyVolumeMonitorUDisks2)
Volume(0): Documents on Wian
  Type: GProxyVolume (GProxyVolumeMonitorAfc)
  activation_root=afc://00008140-00086450119B801C:3/
  Mount(0): Documents on Wian -> afc://00008140-00086450119B801C:3/
    Type: GProxyShadowMount (GProxyVolumeMonitorAfc)
Volume(1): iPhone
  Type: GProxyVolume (GProxyVolumeMonitorGPhoto2)
  activation_root=gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/
  Mount(0): iPhone -> gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/
    Type: GProxyShadowMount (GProxyVolumeMonitorGPhoto2)
Mount(2): iPhone -> gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/
Mount(3): Documents on Wian -> afc://00008140-00086450119B801C:3/`

test("keeps a trusted iPhone's two mounts apart", () => {
  const found = api.parseGioMounts(GIO_IPHONE_TRUSTED)
  assert.strictEqual(found.length, 2, "app documents and the camera roll are separate")

  const documents = found.find(e => e.name === "Documents on Wian")
  const camera = found.find(e => e.name === "iPhone")

  assert.strictEqual(documents.uri, "afc://00008140-00086450119B801C:3/")
  assert.strictEqual(documents.access, "Files")
  assert.strictEqual(camera.uri, "gphoto2://Apple_Inc._iPhone_0000814000086450119B801C/",
    "a trailing afc Mount line must not steal the camera roll's URI")
  assert.strictEqual(camera.access, "Photos")
  assert.ok(found.every(e => e.mounted), "both are mounted")
})

test("a mount listed outside any block still marks its device mounted", () => {
  // The volume declares itself with no nested Mount line; only the trailing
  // top-level one says it is mounted.
  const detached = `Volume(0): Pixel 7
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  activation_root=mtp://Google_Pixel_7_1A2B3C/
Mount(0): Pixel 7 -> mtp://Google_Pixel_7_1A2B3C/`
  const found = api.parseGioMounts(detached)
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].mounted, true)
  assert.strictEqual(found[0].uri, "mtp://Google_Pixel_7_1A2B3C/")
})

test("an actual camera is still a camera", () => {
  const canon = api.parseGioMounts(`Volume(0): Canon EOS
    Type: GProxyVolume (GProxyVolumeMonitorGPhoto2)
    activation_root=gphoto2://Canon_EOS_1234/`)[0]
  assert.strictEqual(canon.kind, "camera")
  assert.strictEqual(canon.access, "Photos")
})

test("gives phones their own navigation rows after the drives", () => {
  const devices = api.parse(tree([disk({ children: [part({})] })]))
  const rows = api.navRows(devices, [{ name: "Pixel 7" }])
  assert.deepStrictEqual(rows.map(r => r.kind), ["device", "volume", "portable"])
  assert.strictEqual(rows[2].portable, 0)
  assert.deepStrictEqual(api.navRows(devices).map(r => r.kind), ["device", "volume"])
  assert.deepStrictEqual(api.navRows([], [{ name: "Pixel 7" }]).map(r => r.kind), ["portable"])
})

console.log("\nbackend availability")

// Real output shape from the probe: gvfs advertises its backends as
// /usr/share/gvfs/mounts/<scheme>.mount, and sysfs reports each USB device's
// vendor plus every interface class it exposes.
const PROBE_NO_AFC = [
  "backend mtp", "backend smb", "backend trash",
  "usb 04f2,0e,0e,0e,0e,fe HP True Vision FHD Camera",
  "usb 0781,08  SanDisk 3.2Gen1"
].join("\n")

test("reads which backends gvfs has and what is on the bus", () => {
  const support = api.parseSupport(PROBE_NO_AFC)
  assert.strictEqual(support.backends.mtp, true)
  assert.strictEqual(support.backends.afc, undefined)
  assert.strictEqual(support.devices.length, 2)
  assert.strictEqual(support.devices[0].vendor, "04f2")
  assert.deepStrictEqual(support.devices[0].classes, ["0e", "0e", "0e", "0e", "fe"])
  assert.strictEqual(support.devices[1].name, "SanDisk 3.2Gen1")
})

test("says nothing when nothing needs saying", () => {
  // A webcam and a USB stick are not phones; neither should raise a hint.
  assert.strictEqual(api.supportHint(api.parseSupport(PROBE_NO_AFC)), null)
  assert.strictEqual(api.supportHint(null), null)
  assert.strictEqual(api.supportHint(api.parseSupport("")), null)
})

test("explains an iPhone that Linux cannot reach yet", () => {
  const probe = PROBE_NO_AFC + "\nusb 05ac,06,ff,ff iPhone"
  const hint = api.supportHint(api.parseSupport(probe))
  assert.ok(hint, "an Apple device with no afc backend should raise a hint")
  assert.ok(hint.text.includes("iPhone"))
  assert.strictEqual(hint.packages, "usbmuxd gvfs-afc gvfs-gphoto2")
})

test("stops explaining once the backend is installed", () => {
  const probe = PROBE_NO_AFC + "\nbackend afc\nusb 05ac,06,ff,ff iPhone"
  assert.strictEqual(api.supportHint(api.parseSupport(probe)), null)
})

test("names an unnamed device generically rather than blankly", () => {
  const hint = api.supportHint(api.parseSupport("backend mtp\nusb 05ac,06 "))
  assert.ok(hint.text.startsWith("An Apple device"))
})

test("flags an imaging device when no backend can read it", () => {
  const camera = "backend smb\nusb 04a9,06 Canon EOS"
  const hint = api.supportHint(api.parseSupport(camera))
  assert.ok(hint.text.includes("Canon EOS"))
  assert.strictEqual(hint.packages, "gvfs-gphoto2")

  // gvfs-mtp can already read many cameras, so its presence is enough.
  assert.strictEqual(api.supportHint(api.parseSupport("backend mtp\nusb 04a9,06 Canon EOS")), null)
})

test("does not mistake a webcam for a camera it should mount", () => {
  // A UVC webcam is interface class 0e, not 06 — mounting it is meaningless.
  assert.strictEqual(api.supportHint(api.parseSupport("backend smb\nusb 04f2,0e Webcam")), null)
})

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
