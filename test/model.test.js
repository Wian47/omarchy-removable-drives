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

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
