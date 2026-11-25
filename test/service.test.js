// Runs the functions inside Service.qml and Panel.qml. Run with:
// node test/service.test.js
//
// model.test.js covers the rules and shell.test.js the scripts. Between them is
// the code that decides when to apply which, and it is plain JavaScript inside a
// QML file. Each test loads those functions from the source with stand-ins for
// the processes and files around them, so nothing runs and nothing is mounted.

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const root = path.join(__dirname, "..")
const read = name => fs.readFileSync(path.join(root, name), "utf8")

const modelSource = read("Model.js").replace(/^\.pragma library\s*$/m, "")
const modelNames = [...modelSource.matchAll(/^(?:function|var) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
const Model = new Function(modelSource + "\nreturn {" + modelNames.join(",") + "}")()

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

// A property's value runs until the next line at its own indent, unless that
// line only closes a bracket the value opened.
function propertiesIn(source) {
  const lines = source.split("\n")
  const found = []
  lines.forEach((line, index) => {
    const match = line.match(/^  (readonly )?property \w+ (\w+)(?::\s*(.*))?$/)
    if (!match) return
    let text = match[3] || ""
    for (let i = index + 1; i < lines.length && /^(?:    |  [\]})])/.test(lines[i]); i++) {
      text += "\n" + lines[i]
    }
    found.push({ name: match[2], readonly: !!match[1], text })
  })
  return found
}

// A stand-in for anything with an id. It records every command it is started
// with, and carries the handlers declared on it in the QML.
function standIn() {
  let running = false
  return {
    command: [], started: [],
    get running() { return running },
    set running(value) {
      if (value && !running) this.started.push(this.command)
      running = value
    },
    restart() {}, reload() {}, forceActiveFocus() {}
  }
}

function load(file, given) {
  const source = read(file)
  const scope = {
    Model,
    Quickshell: { env: () => "/home/x", execDetached: command => scope.detached.push(command) },
    Qt: { LeftButton: 1, RightButton: 2, MiddleButton: 4, callLater() {} },
    detached: [],
    ...given
  }
  scope.root = scope
  const compile = text => new Function("scope", "with (scope) { return (" + text + ") }")(scope)

  for (const match of source.matchAll(/^  \w+ \{\n    id: (\w+)\n([\s\S]*?)^  \}/gm)) {
    if (given && match[1] in given) continue
    const object = scope[match[1]] = standIn()
    for (const handler of match[2].matchAll(/^    (on[A-Z]\w*): (function\([\s\S]*?^    \})/gm)) {
      object[handler[1]] = compile(handler[2])
    }
  }
  for (const match of source.matchAll(/^  function (\w+)\(([^)]*)\) \{\n([\s\S]*?)^  \}/gm)) {
    scope[match[1]] = compile(`function(${match[2]}) {\n${match[3]}}`)
  }
  for (const match of source.matchAll(/^  (on[A-Z]\w*): (\{\n[\s\S]*?^  \})/gm)) {
    scope[match[1]] = compile(`function() ${match[2]}`)
  }
  for (const property of propertiesIn(source)) {
    if (given && property.name in given) continue
    const text = property.text.trim()
    const value = () => text === "" ? undefined
      : compile(text.startsWith("{") ? `(function() ${text})()` : text)
    if (property.readonly) Object.defineProperty(scope, property.name, { get: value, configurable: true })
    else scope[property.name] = value()
  }
  return scope
}

// The lsblk answer for one stick, as the service reads it.
function snapshot(overrides, partOverrides) {
  const part = {
    name: "sdb1", path: "/dev/sdb1", type: "part", size: 1000, fstype: "vfat", label: "STICK",
    uuid: "AAAA-1111", mountpoint: null, ...partOverrides
  }
  const disk = {
    name: "sdb", path: "/dev/sdb", type: "disk", rm: true, hotplug: true, size: 2000, tran: "usb",
    vendor: "V", model: "Stick", serial: "S1", children: [part], ...overrides
  }
  return JSON.stringify({ blockdevices: [disk] })
}

// Two sticks, so that one can be busy while the other is not.
function twoSticks(partOverrides) {
  const [first] = JSON.parse(snapshot({}, partOverrides)).blockdevices
  const [second] = JSON.parse(snapshot(
    { name: "sdc", path: "/dev/sdc", serial: "S2" },
    { name: "sdc1", path: "/dev/sdc1", uuid: "BBBB-2222", mountpoint: "/run/media/x/OTHER" })).blockdevices
  return JSON.stringify({ blockdevices: [first, second] })
}

const NOTHING = JSON.stringify({ blockdevices: [] })
const MOUNTED = { mountpoint: "/run/media/x/STICK" }

function service(given) {
  const written = []
  const scope = load("Service.qml", { storeFile: { setText: text => written.push(text) }, ...given })
  scope.written = written
  return scope
}

console.log("saved settings")

const ARCHIVE = '{"version":1,"drives":{"serial:S1":{"readOnly":true}}}'

test("a typo in the settings file does not cost the settings already read", () => {
  const drives = service()
  drives.loadStore(ARCHIVE)
  drives.applySnapshot(snapshot())
  drives.loadStore(ARCHIVE.replace("}}}", "},}}"))

  assert.match(drives.lastError, /not valid JSON/)
  drives.mount(drives.devices[0].volumes[0], false)
  assert.ok(drives.actionProcess.command.includes("ro"), "the archive drive was mounted writable")
})

test("nothing is written over a settings file that cannot be read", () => {
  const drives = service()
  drives.loadStore("{ not json")
  drives.applySnapshot(snapshot())

  assert.match(drives.setNickname(drives.devices[0], "Backup"), /not valid JSON/)
  assert.deepStrictEqual(drives.written, [])
  drives.mount(drives.devices[0].volumes[0], false)
  assert.ok(drives.actionProcess.command.includes("ro"), "mounted writable on a guess")
})

test("fixing the file clears the complaint and saving works again", () => {
  const drives = service()
  drives.loadStore("{ not json")
  drives.loadStore(ARCHIVE)
  assert.strictEqual(drives.lastError, "")

  drives.applySnapshot(snapshot())
  assert.strictEqual(drives.setNickname(drives.devices[0], "Backup"), "ok")
  assert.deepStrictEqual(drives.written.map(text => JSON.parse(text)),
    [{ version: 1, drives: { "serial:S1": { readOnly: true, nickname: "Backup" } } }])
})

test("a saved setting reaches the rows as a different object, and leaves the old one alone", () => {
  const drives = service()
  drives.applySnapshot(snapshot())
  const before = drives.devices[0]
  drives.setNickname(before, "Backup")
  assert.notStrictEqual(drives.devices[0], before)
  assert.strictEqual(drives.devices[0].title, "Backup")
  assert.strictEqual(before.title, "V Stick")
})

console.log("\nconnect hooks")

const HOOKED = '{"drives":{"serial:S1":{"onConnect":"backup"}}}'

// The arguments the user's command was given, for every hook that was started.
function hooksRun(drives) {
  return drives.detached.filter(command => command[2] === drives.hookScript)
    .map(command => ({ device: command[6], mountpoint: command[7] }))
}

function hooked() {
  const drives = service()
  drives.loadStore(HOOKED)
  drives.applySnapshot(NOTHING)
  return drives
}

test("a hook waits for the drive to be mounted, then runs once", () => {
  const drives = hooked()
  drives.applySnapshot(snapshot())
  assert.deepStrictEqual(hooksRun(drives), [], "ran with no mount point")
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.applySnapshot(snapshot({}, MOUNTED))
  assert.deepStrictEqual(hooksRun(drives), [{ device: "/dev/sdb", mountpoint: "/run/media/x/STICK" }])
})

test("a locked drive's hook waits for it to be unlocked and mounted", () => {
  const drives = hooked()
  drives.applySnapshot(snapshot({}, { fstype: "crypto_LUKS" }))
  assert.deepStrictEqual(hooksRun(drives), [])
  drives.applySnapshot(snapshot({}, { fstype: "crypto_LUKS", children: [
    { name: "luks-x", path: "/dev/mapper/luks-x", type: "crypt", fstype: "ext4", mountpoint: "/run/media/x/VAULT" }
  ] }))
  assert.deepStrictEqual(hooksRun(drives), [{ device: "/dev/sdb", mountpoint: "/run/media/x/VAULT" }])
})

test("a drive with nothing to mount still gets its hook", () => {
  const drives = hooked()
  drives.applySnapshot(snapshot({}, { fstype: "swap" }))
  assert.deepStrictEqual(hooksRun(drives), [{ device: "/dev/sdb", mountpoint: "" }])
})

test("a hook still waiting when the drive goes does not run for the next one", () => {
  const drives = hooked()
  drives.applySnapshot(snapshot())
  drives.applySnapshot(NOTHING)
  assert.deepStrictEqual(drives._hooksWaiting, {})
})

test("a drive stays busy, and keeps being polled, when the first poll comes too early", () => {
  const drives = hooked()
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.applyHooks("==> serial_S1 0 <==\n")
  assert.strictEqual(drives.isDeviceBusy(drives.devices[0]), true, "eject would not wait for the hook")
  assert.deepStrictEqual(drives.hooksWorthPolling(), ["serial_S1"])

  drives.applyHooks("==> serial_S1 1 <==\npercent=10\n")
  drives.applyHooks("==> serial_S1 0 <==\npercent=10\n")
  assert.strictEqual(drives.isDeviceBusy(drives.devices[0]), false)
})

test("a drive attached before the shell started does not run its hook", () => {
  const drives = service()
  drives.loadStore(HOOKED)
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.applySnapshot(snapshot({}, MOUNTED))
  assert.deepStrictEqual(hooksRun(drives), [])
})

console.log("\nejecting")

const BUSY = { sdb: { busy: true, writeRate: 1, inFlight: 1 } }

// Two quiet samples, which is what a held eject waits for.
function settle(drives) {
  drives.activity = {}
  drives.advancePendingEject()
  drives.advancePendingEject()
}

function holdEject() {
  const drives = service()
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.activity = BUSY
  drives.eject(drives.devices[0])
  assert.strictEqual(drives.pendingEjectPath, "/dev/sdb")
  return drives
}

test("a held eject runs once the drive goes quiet", () => {
  const drives = holdEject()
  drives.advancePendingEject()
  assert.deepStrictEqual(drives.actionProcess.started, [])
  settle(drives)
  assert.strictEqual(drives.actionProcess.started.length, 1)
})

test("a held eject does not outlive its drive", () => {
  for (const pending of ["/dev/sdb", "*"]) {
    const drives = holdEject()
    drives.pendingEjectPath = pending
    drives.applySnapshot(NOTHING)
    assert.strictEqual(drives.pendingEjectPath, "", pending)
    drives.applySnapshot(snapshot({ serial: "S2" }, MOUNTED))
    settle(drives)
    assert.deepStrictEqual(drives.actionProcess.started, [], "the next drive was ejected")
  }
})

test("a held eject waits for another action rather than being dropped", () => {
  const drives = holdEject()
  drives.actionProcess.running = true
  settle(drives)
  assert.strictEqual(drives.pendingEjectPath, "/dev/sdb")
  drives.actionProcess.running = false
  settle(drives)
  assert.strictEqual(drives.actionProcess.started.length, 2, "the eject never ran")
})

test("an eject that cannot run says why instead of ok", () => {
  const drives = service()
  assert.strictEqual(drives.ejectAll(), "no drives attached")
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.actionProcess.running = true
  for (const answer of [drives.eject(drives.devices[0]), drives.ejectAll()]) {
    assert.strictEqual(answer, "Another action is still running")
  }
  assert.strictEqual(drives.actionProcess.started.length, 1)
  drives.actionProcess.running = false
  assert.strictEqual(drives.eject(drives.devices[0]), "ok")
})

test("an eject that is held is an eject that will run", () => {
  const drives = service()
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.activity = BUSY
  assert.strictEqual(drives.eject(drives.devices[0]), "ok")
  assert.strictEqual(drives.ejectAll(), "ok")
})

const warnings = drives => drives.detached.filter(command => command.includes("Removed while still mounted")).length

test("a drive whose eject failed still warns when it is pulled", () => {
  const drives = service()
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.eject(drives.devices[0])
  drives.actionProcess.running = false
  drives.finishAction(drives.actionProcess, 1)
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.applySnapshot(NOTHING)
  assert.strictEqual(warnings(drives), 1)
})

test("a drive that was ejected goes without a warning, even seen mounted on the way", () => {
  const drives = service()
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.eject(drives.devices[0])
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.actionProcess.running = false
  drives.finishAction(drives.actionProcess, 0)
  drives.applySnapshot(NOTHING)
  assert.strictEqual(warnings(drives), 0)
})

console.log("\nformatting")

const CAPS = { check: {}, repair: {}, format: ["exfat", "ext4"] }

function panel(drives) {
  return load("Panel.qml", { drives, devices: drives.devices, rows: [] })
}

test("a format set up for one stick does not run on the one that replaced it", () => {
  const drives = service({ fsCapabilities: CAPS })
  drives.applySnapshot(snapshot())
  const view = panel(drives)
  view.beginFormat(drives.devices[0].volumes[0])
  assert.strictEqual(view.formattingPath, "/dev/sdb1")

  drives.applySnapshot(snapshot({ serial: "S2" }))
  const result = drives.formatVolume(drives.devices[0].volumes[0], "exfat", "", true, view.formattingIdentity)
  assert.match(result, /different volume/)
  assert.deepStrictEqual(drives.longProcess.started, [])

  view.devices = drives.devices
  view.onRowsChanged()
  assert.strictEqual(view.formattingPath, "", "the editor stayed open over the new stick")
})

test("a format runs on the stick it was set up for", () => {
  const drives = service({ fsCapabilities: CAPS })
  drives.applySnapshot(snapshot())
  const view = panel(drives)
  view.beginFormat(drives.devices[0].volumes[0])
  drives.applySnapshot(snapshot())
  view.devices = drives.devices
  view.onRowsChanged()
  assert.strictEqual(view.formattingPath, "/dev/sdb1")
  assert.strictEqual(
    drives.formatVolume(drives.devices[0].volumes[0], "exfat", "", true, view.formattingIdentity), "ok")
  assert.strictEqual(drives.longProcess.started.length, 1)
})

test("a format asked for by a script names its volume and needs no plan made earlier", () => {
  const drives = service({ fsCapabilities: CAPS })
  drives.applySnapshot(snapshot())
  assert.strictEqual(drives.formatVolume(drives.devices[0].volumes[0], "exfat", "", true), "ok")
})

console.log("\nlong actions")

const CHECKABLE = { check: { vfat: { available: true } }, repair: {}, format: ["exfat"] }
const WAIT = "Another action is still running"

function checking() {
  const drives = service({ fsCapabilities: CHECKABLE })
  drives.applySnapshot(twoSticks(MOUNTED))
  assert.strictEqual(drives.checkVolume(drives.devices[0].volumes[0]), "ok")
  assert.strictEqual(drives.longProcess.started.length, 1)
  return drives
}

test("a check on one drive leaves every other drive usable", () => {
  const drives = checking()
  assert.strictEqual(drives.eject(drives.devices[1]), "ok")
  assert.strictEqual(drives.actionProcess.started.length, 1)
  assert.deepStrictEqual(drives.actionProcess.command.slice(4),
    ["unmount", "/dev/sdc1", "power-off", "/dev/sdc"])
})

test("a check holds up the drive it is running on", () => {
  const drives = checking()
  const [device] = drives.devices
  const [volume] = device.volumes
  assert.strictEqual(drives.eject(device), WAIT)
  assert.strictEqual(drives.ejectAll(), WAIT)
  assert.strictEqual(drives.setVolumeLabel(volume, "NEW"), WAIT)
  assert.strictEqual(drives.mountReadOnly(volume), WAIT)
  drives.unmount(volume)
  assert.deepStrictEqual(drives.actionProcess.started, [])
})

test("only one long action runs at a time, and none starts during another action", () => {
  const drives = checking()
  assert.strictEqual(drives.checkVolume(drives.devices[1].volumes[0]), WAIT)
  drives.longProcess.running = false
  drives.actionProcess.running = true
  assert.strictEqual(drives.checkVolume(drives.devices[1].volumes[0]), WAIT)
})

test("each row knows whether it is the one being worked on", () => {
  const drives = checking()
  assert.strictEqual(drives.workingOn("/dev/sdb1"), true)
  assert.strictEqual(drives.workingOn("/dev/sdc1"), false)
  drives.unmount(drives.devices[1].volumes[0])
  assert.strictEqual(drives.workingOn("/dev/sdb1"), true)
  assert.strictEqual(drives.workingOn("/dev/sdc1"), true)
  drives.longProcess.running = false
  assert.strictEqual(drives.workingOn("/dev/sdb1"), false)
})

test("two actions finishing in turn each report their own result", () => {
  const drives = checking()
  drives.unmount(drives.devices[1].volumes[0])
  drives.longProcess.output = "b false\n"
  drives.actionProcess.errors = "Error.Failed: nope"

  drives.actionProcess.running = false
  drives.finishAction(drives.actionProcess, 1)
  assert.strictEqual(drives.lastError, "nope")

  drives.longProcess.running = false
  drives.finishAction(drives.longProcess, 0)
  assert.strictEqual(drives.checkedFsPath, "/dev/sdb1")
  assert.strictEqual(drives.checkVerdict, false)
  assert.strictEqual(drives.actionStatus, "Errors found on STICK")
  assert.strictEqual(drives.lastError, "", "an older failure would hide the verdict")
})

test("a failed check does not cancel the window another drive is about to open", () => {
  const drives = checking()
  drives.unmount(drives.devices[1].volumes[0])
  drives.actionProcess.running = false
  drives.applySnapshot(twoSticks(MOUNTED).replace('"/run/media/x/OTHER"', "null"))
  drives.mount(drives.devices[1].volumes[0], true)
  drives.longProcess.running = false
  drives.finishAction(drives.longProcess, 1)
  assert.strictEqual(drives._openAfterPath, "/dev/sdc1")
})

test("a held eject of another drive does not wait for a long action", () => {
  const drives = checking()
  drives.pendingEjectPath = "/dev/sdc"
  settle(drives)
  assert.strictEqual(drives.actionProcess.started.length, 1)
})

test("the passphrase belongs to the action it was given to", () => {
  const drives = service()
  drives.applySnapshot(snapshot({}, { fstype: "crypto_LUKS" }))
  assert.strictEqual(drives.unlock(drives.devices[0].volumes[0], "hunter2"), "ok")
  assert.strictEqual(drives.actionProcess.secret, "hunter2")
  assert.ok(!drives.actionProcess.command.join(" ").includes("hunter2"), "the passphrase is in argv")
  drives.actionProcess.running = false
  drives.runAction(["true"], "", "mount", "")
  assert.strictEqual(drives.actionProcess.secret, "")
})

console.log(failures === 0 ? "\nAll service tests passed." : `\n${failures} service test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
