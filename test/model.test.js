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

// Captured verbatim from a Samsung Galaxy over MTP. Note the last line: gvfs
// names the daemon mount after the backend ("mtp"), not after the device, so
// matching mounts to volumes by name alone would miss it.
const GIO_ANDROID = `Volume(0): SAMSUNG Android
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  ids:
   unix-device: '/dev/bus/usb/005/006'
  activation_root=mtp://SAMSUNG_SAMSUNG_Android_R5GL62TXRAT/
  themed icons:  [multimedia-player]
  can_mount=1
  should_automount=1
  Mount(0): SAMSUNG Android -> mtp://SAMSUNG_SAMSUNG_Android_R5GL62TXRAT/
    Type: GProxyShadowMount (GProxyVolumeMonitorMTP)
    is_shadowed=0
Mount(1): mtp -> mtp://SAMSUNG_SAMSUNG_Android_R5GL62TXRAT/
  Type: GDaemonMount`

test("reads an Android phone over MTP", () => {
  const found = api.parseGioMounts(GIO_ANDROID)
  assert.strictEqual(found.length, 1, "the shadow mount and daemon mount are one device")
  assert.strictEqual(found[0].name, "SAMSUNG Android")
  assert.strictEqual(found[0].uri, "mtp://SAMSUNG_SAMSUNG_Android_R5GL62TXRAT/")
  assert.strictEqual(found[0].mounted, true)
  assert.strictEqual(found[0].access, "Files", "MTP reaches more than the camera roll")
  assert.strictEqual(found[0].kind, "phone")
})

test("a mount named after its backend still counts, matched by URI", () => {
  // Only the top-level "Mount(1): mtp -> ..." says this is mounted, and its
  // name is the backend rather than the device.
  const onlyDaemonMount = GIO_ANDROID.split("\n")
    .filter(l => !/Mount\(0\)|GProxyShadowMount|is_shadowed/.test(l))
    .join("\n")
  const found = api.parseGioMounts(onlyDaemonMount)
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].mounted, true, "same URI means the same device")
})

test("a mount for a different device does not mark this one mounted", () => {
  const other = `Volume(0): SAMSUNG Android
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  activation_root=mtp://SAMSUNG_SAMSUNG_Android_R5GL62TXRAT/
Mount(1): mtp -> mtp://SOME_OTHER_PHONE/`
  assert.strictEqual(api.parseGioMounts(other)[0].mounted, false)
})

test("a device URI reaches gio byte-exact, like any other path", () => {
  // The URI is an argument to `gio mount` and `gio open`, so normalising it
  // would address a different device — the same mistake as the mount points.
  const spaced = `Volume(0): Odd Phone
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  activation_root=mtp://TWO__UNDERSCORES/`
  const found = api.parseGioMounts(spaced)
  assert.strictEqual(found[0].uri, "mtp://TWO__UNDERSCORES/")
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

console.log("\nhostile device names")

// A QML Text defaults to Text.AutoText and promotes markup-looking strings to
// rich text, which Qt renders with working <img> loads. Drive labels, vendor
// strings and phone names come from the device, not the user, so a stick can
// be formatted with a label that phones home the moment it is plugged in.
const BEACON = '<img src="http://attacker.example/beacon.png">'

test("strips what would make Qt treat a label as rich text", () => {
  assert.ok(!api.plain(BEACON).includes("<"), "no opening angle bracket survives")
  assert.ok(!api.plain(BEACON).includes(">"), "no closing angle bracket survives")
  assert.strictEqual(api.plain("<b>Backup</b>"), "bBackup/b")
  assert.strictEqual(api.plain(""), "")
  assert.strictEqual(api.plain(null), "")
})

test("leaves an ordinary label untouched", () => {
  assert.strictEqual(api.plain("Work backup"), "Work backup")
  assert.strictEqual(api.plain("OMARCHY_202608"), "OMARCHY_202608")
  assert.strictEqual(api.plain("Réservé (2024)"), "Réservé (2024)")
})

test("sanitises the bar label, which qs.Ui renders with a Text we cannot pin", () => {
  const devices = api.parse(tree([disk({ model: BEACON, vendor: null, children: [part({})] })]))
  const label = api.barLabelText(devices, "name")
  assert.ok(!label.includes("<") && !label.includes(">"), "got: " + label)
})

test("sanitises what a notification would carry", () => {
  // Omarchy renders a notification body as StyledText and its summary with the
  // default AutoText, and strips <img> from the body only — so the drive name
  // going into the summary has to be clean before it leaves here.
  const devices = api.parse(tree([disk({ model: BEACON, vendor: null, children: [part({})] })]))
  const headline = api.plain(devices[0].title + " connected")
  assert.ok(!headline.includes("<") && !headline.includes(">"), "got: " + headline)
  assert.ok(headline.endsWith(" connected"), "the rest of the sentence survives")
})

test("quotes a hostile mount point so it cannot break out of a shell command", () => {
  // A mount point carries the filesystem label, so a stick can be formatted to
  // put shell metacharacters into the path that unmount and open are built
  // from. The quoting has to survive that, not the sanitiser — the path itself
  // must stay exact.
  const evil = "/run/media/x/a'; touch /tmp/PWNED; #"
  const quoted = api.shellQuote(evil)
  assert.strictEqual(quoted, "'/run/media/x/a'\\''; touch /tmp/PWNED; #'")
  assert.ok(!quoted.includes("; touch /tmp/PWNED; #'" + '"'), "no unquoted tail")

  // Round-trip: what a POSIX shell would parse back out of the quoted form.
  const unquoted = quoted.slice(1, -1).split("'\\''").join("'")
  assert.strictEqual(unquoted, evil, "the shell sees the original path, verbatim")
})

test("quotes the empty and null cases without producing bare quotes", () => {
  assert.strictEqual(api.shellQuote(""), "''")
  assert.strictEqual(api.shellQuote(null), "''")
  assert.strictEqual(api.shellQuote("/run/media/x/PLAIN"), "'/run/media/x/PLAIN'")
})

test("keeps paths byte-exact, since commands are built from them", () => {
  // Sanitising is for display only. A mount point containing an angle bracket
  // is legal on Linux, and mangling it would unmount or open the wrong thing.
  const devices = api.parse(tree([disk({
    children: [part({ label: "odd", mountpoint: "/run/media/x/we<ird" })]
  })]))
  assert.strictEqual(devices[0].volumes[0].mountpoint, "/run/media/x/we<ird")
})

// Reported by @ryanrhughes: clean() collapsed runs of whitespace, and paths
// went through it. A label with two spaces therefore produced a mount point
// the plugin believed in but the filesystem did not — and because the guard
// validated the same normalised string it deleted, it approved recursively
// removing a path belonging to something else.
const DOUBLE_SPACE_MOUNT = "/run/media/wian47/MY  BACKUP"

test("a mount point with repeated whitespace is not normalised", () => {
  const devices = api.parse(tree([disk({
    children: [part({ label: "MY  BACKUP", mountpoint: DOUBLE_SPACE_MOUNT })]
  })]))
  assert.strictEqual(devices[0].volumes[0].mountpoint, DOUBLE_SPACE_MOUNT)
})

test("preserves leading, trailing and tab whitespace in a path", () => {
  for (const mount of ["/run/media/x/trailing ", "/run/media/x/tab\there", "/run/media/x/  two"]) {
    const devices = api.parse(tree([disk({ children: [part({ mountpoint: mount })] })]))
    assert.strictEqual(devices[0].volumes[0].mountpoint, mount, JSON.stringify(mount))
  }
})

test("the trash guard refuses a normalised near-miss of a real mount point", () => {
  const mounts = [DOUBLE_SPACE_MOUNT]
  assert.strictEqual(api.isSafeTrashPath(DOUBLE_SPACE_MOUNT + "/.Trash-1000", mounts, "1000"), true,
    "the real path is still accepted")
  assert.strictEqual(api.isSafeTrashPath("/run/media/wian47/MY BACKUP/.Trash-1000", mounts, "1000"), false,
    "one space instead of two is a different drive and must be refused")
})

test("trash candidates are built from the exact mount point", () => {
  const [first, second] = api.trashCandidates(DOUBLE_SPACE_MOUNT, "1000")
  assert.strictEqual(first, DOUBLE_SPACE_MOUNT + "/.Trash-1000")
  assert.strictEqual(second, DOUBLE_SPACE_MOUNT + "/.Trash/1000")
})

test("du output keys keep whitespace, including a trailing space", () => {
  const raw = "4096\t/run/media/x/MY  BACKUP/.Trash-1000\n512\t/run/media/x/trailing /.Trash-1000\n"
  const sizes = api.parseSizes(raw)
  assert.strictEqual(sizes["/run/media/x/MY  BACKUP/.Trash-1000"], 4096)
  assert.strictEqual(sizes["/run/media/x/trailing /.Trash-1000"], 512)
})

test("a serial with odd spacing still keys the same drive every time", () => {
  const devices = api.parse(tree([disk({ serial: "AB  12", children: [part({})] })]))
  assert.strictEqual(api.driveKey(devices[0]), "serial:AB  12")
})

console.log("\nvolume labels")

// A volume as the panel hands one to these, rather than a whole lsblk tree:
// what they need is the filesystem type and whether it is readable yet.
function volume(overrides) {
  return Object.assign({
    fsPath: "/dev/sdb1", label: "STICK", title: "STICK",
    fstype: "vfat", fstypeLabel: "FAT32",
    mounted: false, encrypted: false, unlocked: false
  }, overrides)
}

test("each filesystem carries its own label ceiling", () => {
  assert.strictEqual(api.labelLimit("vfat"), 11)
  assert.strictEqual(api.labelLimit("exfat"), 11)
  assert.strictEqual(api.labelLimit("ext4"), 16)
  assert.strictEqual(api.labelLimit("xfs"), 12)
  assert.strictEqual(api.labelLimit("ntfs"), 128)
  assert.strictEqual(api.labelLimit("btrfs"), 256)
})

test("a filesystem with no tool to write its label cannot be renamed", () => {
  assert.strictEqual(api.labelLimit("hfsplus"), 0)
  assert.strictEqual(api.canRelabel(volume({ fstype: "hfsplus", fstypeLabel: "HFS+" })), false)
  assert.strictEqual(api.canRelabel(volume({ fstype: "" })), false)
  assert.strictEqual(api.canRelabel(null), false)
})

test("a locked LUKS volume has no filesystem to rename yet", () => {
  assert.strictEqual(api.canRelabel(volume({ fstype: "ext4", encrypted: true, unlocked: false })), false)
  assert.strictEqual(api.canRelabel(volume({ fstype: "ext4", encrypted: true, unlocked: true })), true)
})

test("a name over the limit is refused, and says by how much", () => {
  const result = api.validateLabel(volume({}), "WAYTOOLONGLABEL")
  assert.strictEqual(result.ok, false)
  assert.match(result.message, /FAT32 labels are at most 11 characters/)
  assert.match(result.message, /that is 4 too many/)
})

test("a name exactly at the limit is accepted", () => {
  assert.strictEqual(api.validateLabel(volume({}), "ELEVENCHARS").ok, true)
  assert.strictEqual(api.validateLabel(volume({ fstype: "ext4", fstypeLabel: "EXT4" }), "SIXTEEN CHARSXX").ok, true)
})

test("FAT32 refuses the DOS reserved characters, one at a time", () => {
  for (const bad of ['"', "*", "/", ":", "<", ">", "?", "\\", "|"]) {
    const result = api.validateLabel(volume({}), "MY" + bad + "DISK")
    assert.strictEqual(result.ok, false, "expected " + bad + " to be refused")
    assert.match(result.message, /cannot contain/)
  }
})

test("those characters are only FAT32's problem", () => {
  assert.strictEqual(api.validateLabel(volume({ fstype: "ext4", fstypeLabel: "EXT4" }), "my:disk").ok, true)
})

test("an empty name is a real answer — it clears the label", () => {
  const result = api.validateLabel(volume({}), "   ")
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.label, "")
})

test("a name is trimmed at the ends but keeps its interior spacing", () => {
  const result = api.validateLabel(volume({ fstype: "ext4", fstypeLabel: "EXT4" }), "  MY  DISK  ")
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.label, "MY  DISK",
    "clean() would collapse the double space into a different name than the one on screen")
})

test("the length that counts is the trimmed one", () => {
  assert.strictEqual(api.validateLabel(volume({}), "  ELEVENCHARS  ").ok, true)
  assert.strictEqual(api.labelRemaining(volume({}), "  ELEVENCHARS  "), 0)
})

test("the counter goes negative once the name is too long", () => {
  assert.strictEqual(api.labelRemaining(volume({}), ""), 11)
  assert.strictEqual(api.labelRemaining(volume({}), "STICK"), 6)
  assert.strictEqual(api.labelRemaining(volume({}), "WAYTOOLONGLABEL"), -4)
})

test("a filesystem we cannot label is refused rather than validated", () => {
  const result = api.validateLabel(volume({ fstype: "hfsplus", fstypeLabel: "HFS+" }), "NAME")
  assert.strictEqual(result.ok, false)
  assert.match(result.message, /HFS\+ labels cannot be changed/)
})

console.log("\nchecking and repair")

const CAPS = api.parseFsCapabilities([
  'CanCheck vfat (bs) true ""',
  'CanRepair vfat (bs) true ""',
  'CanCheck ntfs (bs) false "ntfsfix"',
  'CanRepair ntfs (bs) false "ntfsfix"',
  "CanCheck nilfs2",
  "CanRepair nilfs2"
].join("\n"))

test("udisks answering yes is read as yes", () => {
  assert.deepStrictEqual(CAPS.check.vfat, { supported: true, available: true, missing: "" })
  assert.strictEqual(api.canCheck(CAPS, volume({ fstype: "vfat" })), true)
  assert.strictEqual(api.canRepair(CAPS, volume({ fstype: "vfat" })), true)
})

test("udisks answering no also names the tool it went looking for", () => {
  assert.deepStrictEqual(CAPS.check.ntfs, { supported: true, available: false, missing: "ntfsfix" })
  assert.strictEqual(api.canCheck(CAPS, volume({ fstype: "ntfs" })), false)
})

test("a filesystem udisks refuses outright answers with nothing at all", () => {
  assert.deepStrictEqual(CAPS.check.nilfs2, { supported: false, available: false, missing: "" })
  assert.strictEqual(api.canCheck(CAPS, volume({ fstype: "nilfs2" })), false)
})

test("a filesystem never probed is not assumed checkable", () => {
  assert.strictEqual(api.canCheck(CAPS, volume({ fstype: "ext4" })), false)
  assert.strictEqual(api.canCheck({ check: {}, repair: {} }, volume({ fstype: "vfat" })), false)
})

test("a locked LUKS volume is never offered a check", () => {
  const locked = volume({ fstype: "vfat", encrypted: true, unlocked: false })
  assert.strictEqual(api.canCheck(CAPS, locked), false)
  assert.strictEqual(api.canRepair(CAPS, locked), false)
})

test("a missing tool becomes a package to install", () => {
  const hint = api.checkHint(CAPS, volume({ fstype: "ntfs", fstypeLabel: "NTFS" }))
  assert.strictEqual(hint.packages, "ntfs-3g")
  assert.match(hint.text, /Checking NTFS needs ntfsfix/)
})

test("nothing is hinted when the check is already available", () => {
  assert.strictEqual(api.checkHint(CAPS, volume({ fstype: "vfat" })), null)
})

test("a filesystem udisks will never check offers no package to install", () => {
  const hint = api.checkHint(CAPS, volume({ fstype: "nilfs2", fstypeLabel: "NILFS2" }))
  assert.strictEqual(hint.packages, "", "there is nothing to install that would help")
  assert.match(hint.text, /cannot check/)
})

test("only the filesystem types actually attached are probed", () => {
  const devices = api.parse(tree([
    disk({ children: [part({ fstype: "vfat" }), part({ name: "sdb2", path: "/dev/sdb2", fstype: "ext4" })] }),
    disk({ name: "sdc", path: "/dev/sdc", children: [part({ name: "sdc1", path: "/dev/sdc1", fstype: "vfat" })] })
  ]))
  assert.deepStrictEqual(api.fsTypesPresent(devices), ["ext4", "vfat"],
    "sorted and deduplicated, because this list is also the signature that decides whether to probe again")
})

test("a locked LUKS partition contributes no filesystem to probe for", () => {
  const devices = api.parse(tree([disk({ children: [part({ fstype: "crypto_LUKS", label: null })] })]))
  assert.deepStrictEqual(api.fsTypesPresent(devices), [])
})

test("the verdict is read off stdout, because a bad filesystem still exits 0", () => {
  assert.strictEqual(api.parseFsVerdict("b true\n"), true)
  assert.strictEqual(api.parseFsVerdict("b false\n"), false)
})

test("an answer we cannot read is not quietly taken for a healthy one", () => {
  for (const raw of ["", "\n", "true", "b maybe", "Call failed: something"]) {
    assert.strictEqual(api.parseFsVerdict(raw), null, JSON.stringify(raw))
  }
})

test("each verdict is described without overstating it", () => {
  const v = volume({ title: "BACKUP" })
  assert.strictEqual(api.describeCheck(v, true), "No errors found on BACKUP")
  assert.strictEqual(api.describeCheck(v, false), "Errors found on BACKUP")
  assert.match(api.describeCheck(v, null), /Could not tell/)
  assert.strictEqual(api.describeRepair(v, true), "Repaired BACKUP")
  assert.match(api.describeRepair(v, false), /could not be fully repaired/)
})

test("busctl's failures read as sentences, not as call plumbing", () => {
  assert.strictEqual(
    api.formatError("Call failed: Label for VFAT filesystem must be at most 11 characters long."),
    "Label for VFAT filesystem must be at most 11 characters long.")
  assert.strictEqual(
    api.formatError("Call failed: Cannot check filesystem on /dev/sdb1 if mounted"),
    "Cannot check filesystem on /dev/sdb1 if mounted")
})

test("udisksctl's own error shape still survives the extra strip", () => {
  assert.strictEqual(
    api.formatError("Error unmounting: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: Target is busy"),
    "Target is busy")
})

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
