// Lints the shell that Service.qml keeps in string arrays, and runs the scripts
// that can lose data. Run with: node test/shell.test.js
//
// Model.js decides whether a format may run; formatScript is what erases the
// drive. That half was the largest unchecked surface in the plugin: shellcheck
// cannot see shell that lives inside a QML property, so none of it had ever
// been read by anything but a person.
//
// The scripts stay where they are. Moving them to .sh files would buy the
// linter a file to open at the cost of FileView, a resolved plugin path, and a
// second thing to ship, so the extraction happens here instead, out of the same
// source text the other checks already parse.

const fs = require("fs")
const os = require("os")
const path = require("path")
const assert = require("assert")
const { execFileSync, spawnSync } = require("child_process")

const root = path.join(__dirname, "..")
const serviceSource = fs.readFileSync(path.join(root, "Service.qml"), "utf8")

let failures = 0
function check(name, fn) {
  let problems
  try {
    problems = fn() || []
  } catch (error) {
    problems = [error.message]
  }
  if (problems.length === 0) {
    console.log("  ok   " + name)
    return
  }
  failures++
  console.log("  FAIL " + name)
  for (const problem of problems) console.log("       " + problem)
}

// Everything below scans the source by absolute offset rather than by building
// a cleaned-up copy, because the first version of this file built one, dropped
// the comment lines between array elements, and reported every finding a dozen
// lines above the shell it was about.

// One lexical unit: a string literal with its escapes, a line comment, or a
// single character. Quoting and commenting are handled here once instead of in
// each of the three scans below, which is what keeps a `//` inside a shell
// string from starting a comment and an apostrophe inside a prose comment from
// opening one.
function step(source, index) {
  const character = source[index]
  if (character === "/" && source[index + 1] === "/") {
    const stop = source.indexOf("\n", index)
    return { end: stop === -1 ? source.length : stop, kind: "comment" }
  }
  if (character === "\"" || character === "'") {
    let cursor = index + 1
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2
        continue
      }
      if (source[cursor] === character) return { end: cursor + 1, kind: "string" }
      cursor++
    }
    throw new Error("unterminated string at offset " + index)
  }
  return { end: index + 1, kind: "char" }
}

// A property value ends at the first newline outside every bracket that is not
// held open by a trailing `+`. That is what separates `].join("\n")` from the
// property after it, and it also ends capsScript, which is concatenation with
// no array around it at all.
function expressionEnd(source, start) {
  let depth = 0
  let index = start
  let last = ""
  while (index < source.length) {
    const { end, kind } = step(source, index)
    if (kind === "string") {
      last = "'"
    } else if (kind === "char") {
      const character = source[index]
      if (character === "[" || character === "(") depth++
      else if (character === "]" || character === ")") depth--
      else if (character === "\n" && depth === 0 && last !== "" && last !== "+") return index
      if (!/\s/.test(character)) last = character
    }
    index = end
  }
  return index
}

// The elements of the value, as offsets into the source. Each one starts at its
// first code character, so an element preceded by four lines of comment is
// still reported against the line its shell was written on.
function elementsOf(source, start, end) {
  let index = start
  while (index < end && /\s/.test(source[index])) index++
  const array = source[index] === "["
  const stop = array ? source.lastIndexOf("]", end) : end
  const elements = []
  let anchor = null
  let depth = 0
  let cursor = array ? index + 1 : index
  const close = at => {
    if (anchor !== null) elements.push({ start: anchor, end: at })
    anchor = null
  }
  while (cursor < stop) {
    const { end: next, kind } = step(source, cursor)
    const character = source[cursor]
    if (kind === "comment" || (kind === "char" && /\s/.test(character))) {
      cursor = next
      continue
    }
    if (kind === "char" && character === "(") depth++
    if (kind === "char" && character === ")") depth--
    if (kind === "char" && character === "," && array && depth === 0) {
      close(cursor)
      cursor = next
      continue
    }
    if (anchor === null) anchor = cursor
    cursor = next
  }
  close(stop)
  return elements
}

// One record per embedded script: the shell it becomes, and the Service.qml
// line each of its lines came from.
function extractScripts() {
  const scripts = []
  const lineOf = offset => serviceSource.slice(0, offset).split("\n").length
  const declaration = /readonly property string (\w+):/g
  let match
  while ((match = declaration.exec(serviceSource))) {
    const start = declaration.lastIndex
    const end = expressionEnd(serviceSource, start)
    declaration.lastIndex = end
    const opener = serviceSource.slice(start, end).match(/\S/)
    if (!opener || !"'\"[".includes(opener[0])) continue

    const lines = []
    const shell = []
    for (const element of elementsOf(serviceSource, start, end)) {
      const value = eval(serviceSource.slice(element.start, element.end))
      if (typeof value !== "string") {
        throw new Error(match[1] + " has an element that is not a string")
      }
      // An element is one shell line today. If one ever carries its own
      // newline, every line it produces still points at the element it came
      // from rather than silently shifting every line after it.
      for (const line of value.split("\n")) {
        shell.push(line)
        lines.push(lineOf(element.start))
      }
    }
    scripts.push({ name: match[1], shell: shell.join("\n"), lines })
  }
  return scripts
}

const scripts = extractScripts()

// The check that keeps the other one honest. A script written in a shape the
// scanner above cannot read would be linted by nothing at all, and the suite
// would still report that every script passed.
check("every embedded script is one the linter can read", () => {
  const declared = [...serviceSource.matchAll(/property string (\w*[Ss]cript)\b/g)].map(m => m[1])
  const extracted = new Set(scripts.map(script => script.name))
  const problems = declared
    .filter(name => !extracted.has(name))
    .map(name => `"${name}" is declared but did not extract, so shellcheck never sees it`)
  if (declared.length === 0) problems.push("no script declarations found in Service.qml")
  return problems
})

// The map is the reason a finding says Service.qml:716 rather than naming a
// scratch file that has already been deleted. The first version of it was wrong
// and said nothing, drifting further the deeper into a script it went, so it is
// asserted rather than trusted. Every line of shell has to be findable on the
// source line it was mapped to.
check("every line of shell is on the source line it is mapped to", () => {
  const sourceLines = serviceSource.split("\n")
  const bare = text => text.replace(/\\/g, "")
  const problems = []
  for (const script of scripts) {
    script.shell.split("\n").forEach((text, index) => {
      const head = text.trim().slice(0, 10)
      if (head === "") return
      const line = script.lines[index]
      if (!bare(sourceLines[line - 1] || "").includes(bare(head))) {
        problems.push(`${script.name} line ${index + 1} maps to Service.qml:${line}, which does not contain ${JSON.stringify(head)}`)
      }
    })
  }
  return problems
})

check("the embedded shell passes shellcheck", () => {
  if (scripts.length === 0) return ["nothing to lint"]

  const lab = fs.mkdtempSync(path.join(os.tmpdir(), "removable-drives-shell-"))
  const byFile = new Map()
  try {
    for (const script of scripts) {
      const file = path.join(lab, script.name + ".sh")
      // No shebang. `--shell` says what this is, and a prepended line would put
      // every finding one line off the map built above.
      fs.writeFileSync(file, script.shell + "\n")
      byFile.set(file, script)
    }

    let report
    try {
      report = execFileSync("shellcheck", ["--shell=bash", "--format=json1", ...byFile.keys()],
                            { encoding: "utf8" })
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("shellcheck is not installed")
      report = error.stdout || ""
      if (report.trim() === "") throw new Error(error.stderr || "shellcheck reported nothing")
    }

    return JSON.parse(report).comments.map(finding => {
      const script = byFile.get(path.resolve(finding.file))
      const line = script ? script.lines[finding.line - 1] : finding.line
      const where = script ? `${script.name}, Service.qml:${line}` : finding.file
      return `${where}: SC${finding.code} ${finding.message}`
    })
  } finally {
    fs.rmSync(lab, { recursive: true, force: true })
  }
})

// Resolved, because a temporary directory behind a symlink would look like the
// very thing the trash check refuses.
function inLab(fn) {
  const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "removable-drives-run-")))
  try {
    return fn(lab)
  } finally {
    fs.rmSync(lab, { recursive: true, force: true })
  }
}

function runScript(name, args, bin) {
  const script = scripts.find(candidate => candidate.name === name)
  if (!script) throw new Error(name + " is not in Service.qml")
  const env = bin ? { ...process.env, PATH: bin + path.delimiter + process.env.PATH } : process.env
  return spawnSync("bash", ["-c", script.shell, "removable-drives", ...args],
                   { encoding: "utf8", timeout: 10000, env })
}

// Replaces commands with one-line stand-ins, so nothing reaches a real drive.
// udisksctl is always one of them, and records what it was asked to do.
function stubCommands(lab, stubs) {
  const bin = path.join(lab, "bin")
  const log = path.join(lab, "calls")
  fs.mkdirSync(bin)
  fs.writeFileSync(log, "")
  const all = { udisksctl: "true", ...stubs }
  all.udisksctl = `printf '%s\\n' "$*" >> '${log}'; ${all.udisksctl}`
  for (const name of Object.keys(all)) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${all[name]}\n`, { mode: 0o755 })
  }
  return {
    bin,
    calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
      .map(line => line.replace(" --no-user-interaction", ""))
  }
}

check("a trash folder reached through a symlink is neither counted nor emptied", () => inLab(lab => {
  const outside = path.join(lab, "outside", "1000")
  const stick = path.join(lab, "stick")
  fs.mkdirSync(outside, { recursive: true })
  fs.mkdirSync(stick)
  fs.writeFileSync(path.join(outside, "keep"), "not on the drive")
  fs.symlinkSync(path.join(lab, "outside"), path.join(stick, ".Trash"))
  fs.symlinkSync(outside, path.join(stick, ".Trash-1000"))

  for (const link of [path.join(stick, ".Trash", "1000"), path.join(stick, ".Trash-1000")]) {
    assert.strictEqual(runScript("trashProbeScript", [link]).stdout, "", link + " was counted")
    assert.notStrictEqual(runScript("trashEmptyScript", [link]).status, 0, link + " was accepted")
  }
  assert.ok(fs.existsSync(path.join(outside, "keep")), "a file outside the drive was deleted")
}))

check("a real trash folder is counted and emptied, whatever the drive is called", () => inLab(lab => {
  const trash = path.join(lab, "MY  STICK's", ".Trash-1000")
  fs.mkdirSync(path.join(trash, "files"), { recursive: true })
  fs.writeFileSync(path.join(trash, "files", "old"), "deleted")

  const missing = path.join(lab, "MY  STICK's", ".Trash", "1000")
  const sizes = runScript("trashProbeScript", [missing, trash]).stdout
  assert.match(sizes, /^[0-9]+\t/)
  assert.ok(sizes.endsWith("\t" + trash + "\n"), "unexpected probe output " + JSON.stringify(sizes))

  const emptied = runScript("trashEmptyScript", [trash])
  assert.strictEqual(emptied.status, 0, emptied.stderr)
  assert.ok(!fs.existsSync(trash), "the trash is still there")
  assert.strictEqual(runScript("trashEmptyScript", [trash]).status, 0,
    "a trash that is already gone is not an error")
}))

check("eject does not report success over a volume that is still mounted", () => inLab(lab => {
  const device = path.join(lab, "sdb")
  fs.writeFileSync(device, "")
  const stub = stubCommands(lab, { lsblk: "printf '\\n/run/media/x/B\\n'" })

  const result = runScript("ejectScript", ["unmount", "/dev/sdb1", "power-off", device], stub.bin)
  assert.notStrictEqual(result.status, 0)
  assert.match(result.stderr, /still has a mounted volume/)
  assert.deepStrictEqual(stub.calls(), ["unmount -b /dev/sdb1"])
}))

check("eject unmounts, locks, then powers off, in that order", () => inLab(lab => {
  const device = path.join(lab, "sd b")
  fs.writeFileSync(device, "")
  const stub = stubCommands(lab, { lsblk: "printf '\\n\\n'" })

  const result = runScript("ejectScript",
    ["unmount", "/dev/mapper/luks-x", "lock", "/dev/sdb1", "power-off", device], stub.bin)
  assert.strictEqual(result.status, 0, result.stderr)
  assert.deepStrictEqual(stub.calls(),
    ["unmount -b /dev/mapper/luks-x", "lock -b /dev/sdb1", "power-off -b " + device])
}))

check("eject survives a reader that cannot power off, and a device already gone", () => inLab(lab => {
  const device = path.join(lab, "sdb")
  fs.writeFileSync(device, "")
  const stub = stubCommands(lab, { lsblk: "echo", udisksctl: "exit 1" })

  const result = runScript("ejectScript",
    ["power-off", device, "power-off", path.join(lab, "sdc")], stub.bin)
  assert.strictEqual(result.status, 0, result.stderr)
}))

check("eject stops at the first unmount that fails", () => inLab(lab => {
  const stub = stubCommands(lab, { udisksctl: "exit 1" })
  const result = runScript("ejectScript", ["unmount", "/dev/sdb1", "power-off", "/dev/sdb"], stub.bin)
  assert.notStrictEqual(result.status, 0)
  assert.deepStrictEqual(stub.calls(), ["unmount -b /dev/sdb1"])
}))

check("eject does not treat an unreadable mount list as nothing mounted", () => inLab(lab => {
  const device = path.join(lab, "sdb")
  fs.writeFileSync(device, "")
  const stub = stubCommands(lab, { lsblk: "exit 1" })
  assert.notStrictEqual(runScript("ejectScript", ["power-off", device], stub.bin).status, 0)
  assert.deepStrictEqual(stub.calls(), [])
}))

console.log("")
if (failures > 0) {
  console.log(failures === 1 ? "1 check failed." : failures + " checks failed.")
  process.exit(1)
}
console.log("All shell checks passed.")
