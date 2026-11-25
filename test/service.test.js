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
    const object = scope[match[1]] = { ...standIn(), ...(given && given[match[1]]) }
    Object.defineProperty(object, "running", Object.getOwnPropertyDescriptor(standIn(), "running"))
    for (const handler of match[2].matchAll(/^    (on[A-Z]\w*): (function\([\s\S]*?^    \})/gm)) {
      object[handler[1]] = compile(handler[2])
    }
  }
  for (const match of source.matchAll(/^  function (\w+)\(([^)]*)\) \{\n([\s\S]*?)^  \}/gm)) {
    scope[match[1]] = compile(`function(${match[2]}) {\n${match[3]}}`)
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

const warnings = drives => drives.detached.filter(command => command.includes("Removed while still mounted")).length

test("a drive whose eject failed still warns when it is pulled", () => {
  const drives = service()
  drives.applySnapshot(snapshot({}, MOUNTED))
  drives.eject(drives.devices[0])
  drives.actionProcess.running = false
  drives.actionProcess.onExited(1)
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
  drives.actionProcess.onExited(0)
  drives.applySnapshot(NOTHING)
  assert.strictEqual(warnings(drives), 0)
})

console.log(failures === 0 ? "\nAll service tests passed." : `\n${failures} service test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
