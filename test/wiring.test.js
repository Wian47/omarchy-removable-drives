// Checks that hold across files, which `model.test.js` cannot see and
// `omarchy plugin validate` does not look at. Run with: node test/wiring.test.js
//
// `model.test.js` proves the rules inside Model.js. `omarchy plugin validate`
// reads the manifest. Between the two sits everything that only breaks when
// one file disagrees with another: a QML file that no longer parses, a call to
// a Model function that was renamed, a scripting verb the README promises and
// the IpcHandler never grew, a setting listed in one of three places. None of
// those fail until the shell loads the plugin on someone else's machine.

const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")

const root = path.join(__dirname, "..")
const read = name => fs.readFileSync(path.join(root, name), "utf8")

const modelSource = read("Model.js")
const serviceSource = read("Service.qml")
const panelSource = read("Panel.qml")
const readme = read("README.md")
const manifest = JSON.parse(read("manifest.json"))

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

// Every name Model.js exposes to QML: `.pragma library` files export their
// top-level declarations and nothing else.
function declaredIn(source) {
  return new Set([
    ...source.matchAll(/^function ([A-Za-z_$][\w$]*)/gm),
    ...source.matchAll(/^var ([A-Za-z_$][\w$]*)/gm)
  ].map(m => m[1]))
}

// A comment naming "Model.js" is not a call. Cut at the first `//` that is not
// inside a string, so a `mtp://` literal survives and a prose mention does not.
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const character = line[i]
    if (quote) {
      if (character === "\\") i++
      else if (character === quote) quote = null
    } else if (character === "\"" || character === "'" || character === "`") {
      quote = character
    } else if (character === "/" && line[i + 1] === "/") {
      return line.slice(0, i)
    }
  }
  return line
}

function referenced(source, prefix) {
  const pattern = new RegExp("\\b" + prefix + "\\.([A-Za-z_$][\\w$]*)", "g")
  const found = new Map()
  const lines = source.split("\n")
  lines.forEach((line, index) => {
    if (/^\s*import\s/.test(line)) return
    for (const match of stripComment(line).matchAll(pattern)) {
      if (!found.has(match[1])) found.set(match[1], index + 1)
    }
  })
  return found
}

// Panel.qml declares functions at the same indent inside and outside the
// handler, so the verbs have to come from the handler's own braces.
function ipcVerbs() {
  const start = panelSource.indexOf("IpcHandler {")
  if (start === -1) throw new Error("Panel.qml has no IpcHandler")
  let depth = 0
  let end = start
  for (let i = panelSource.indexOf("{", start); i < panelSource.length; i++) {
    if (panelSource[i] === "{") depth++
    else if (panelSource[i] === "}" && --depth === 0) { end = i; break }
  }
  const block = panelSource.slice(start, end)
  return [...block.matchAll(/\bfunction ([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
}

// A verb counts as documented when the scripting section shows it being run,
// including the "or ejectAll" shorthand in a trailing comment.
function documentedVerbs() {
  const section = readme.slice(readme.indexOf("## Scripting"))
  const block = section.slice(section.indexOf("```bash"), section.indexOf("```", section.indexOf("```bash") + 7))
  return new Set([...block.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]))
}

const qmlformat = ["qmlformat", "/usr/lib/qt6/bin/qmlformat"].find(candidate => {
  try {
    execFileSync(candidate, ["--help"], { stdio: "ignore" })
    return true
  } catch (error) {
    return false
  }
})

// qmlformat, for the reason the CI workflow gives at length: qmllint resolves
// types, every Quickshell and `qs.*` type here lives in Omarchy's shell, and a
// check that passes only on a machine with the shell installed answers a
// different question everywhere else. qmlformat resolves nothing and parses
// the grammar, so it gives one answer. It reports through its exit code.
check("Panel.qml and Service.qml parse", () => {
  if (!qmlformat) return ["qmlformat not found, install the Qt QML tools to run this check"]
  return ["Panel.qml", "Service.qml"].filter(file => {
    try {
      execFileSync(qmlformat, [file], { cwd: root, stdio: "ignore" })
      return false
    } catch (error) {
      return true
    }
  }).map(file => `${file} is not valid QML, qmlformat could not parse it`)
})

check("every Model function the QML calls exists", () => {
  const declared = declaredIn(modelSource)
  return [["Service.qml", serviceSource], ["Panel.qml", panelSource]].flatMap(([name, source]) =>
    [...referenced(source, "Model")]
      .filter(([called]) => !declared.has(called))
      .map(([called, line]) => `${name}:${line}: Model.${called} is not declared in Model.js`))
})

// Panel.qml reaches the service through `drives`. A property renamed in
// Service.qml leaves an undefined binding here rather than an error.
check("every service member the panel binds to exists", () => {
  const declared = new Set([
    ...serviceSource.matchAll(/^\s*(?:readonly\s+)?property\s+\S+\s+([A-Za-z_$][\w$]*)/gm),
    ...serviceSource.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)/gm),
    ...serviceSource.matchAll(/^\s*signal\s+([A-Za-z_$][\w$]*)/gm)
  ].map(m => m[1]))
  return [...referenced(panelSource, "drives")]
    .filter(([member]) => !declared.has(member))
    .map(([member, line]) => `Panel.qml:${line}: drives.${member} is not declared in Service.qml`)
})

// The plugin's own rule: a path reaches a shell through quote(), because a
// label or a mount point is whatever the person who formatted the stick chose.
// Blank out every quote() argument, then anything path-shaped still sitting on
// a line that runs a command is reaching the shell raw.
const COMMANDS = /\budisksctl\b|\bbusctl\b|\bgio\b|\bfuser\b|\bmkfs|\bwl-copy\b|\bexecDetached\b|\bdu -|\brm -/
const PATHISH = /\.(path|fsPath|mountpoint|mountPoint|device)\b/g

// An argv element is handed to execve whole and never parsed by a shell, so a
// path standing alone between two commas is already safe, and safer than
// quoting it. Only a path joined into a command string needs quote().
function isArgvElement(line, match) {
  let start = match.index
  while (start > 0 && /[\w$.]/.test(line[start - 1])) start--
  const before = line.slice(0, start).trimEnd().slice(-1)
  const after = line.slice(match.index + match[0].length).trimStart().slice(0, 1)
  return (before === "," || before === "[") && (after === "," || after === "]" || after === "")
}

function blankSafeCalls(line) {
  let out = line
  for (;;) {
    const call = out.match(/\b(?:Model\.exact|shellQuote|quote)\s*\(/)
    if (!call) return out
    const start = call.index + call[0].length
    let depth = 1
    let i = start
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === "(") depth++
      else if (out[i] === ")") depth--
    }
    out = out.slice(0, call.index) + "SAFE" + out.slice(i)
  }
}

check("no device path reaches a shell command unquoted", () => {
  const problems = []
  serviceSource.split("\n").forEach((line, index) => {
    const code = stripComment(line)
    if (!COMMANDS.test(code)) return
    const safe = blankSafeCalls(code)
    for (const match of safe.matchAll(PATHISH)) {
      if (isArgvElement(safe, match)) continue
      problems.push(`Service.qml:${index + 1}: ${match[0]} reaches a command without quote()`)
    }
  })
  return problems
})

// A verb the README promises and the handler never grew fails only for the
// person who copied the line out of the README.
const IPC_INTERNAL = new Set(["open", "close", "show", "hide", "toggle"])

check("every scripting verb the README documents is handled", () => {
  const handled = new Set(ipcVerbs())
  return [...readme.matchAll(/omarchy-shell removable-drives ([A-Za-z]\w*)/g)]
    .map(m => m[1])
    .filter(verb => !handled.has(verb))
    .map(verb => `README documents "${verb}", which the IpcHandler does not define`)
})

check("every scripting verb the handler defines is documented", () => {
  const documented = documentedVerbs()
  return ipcVerbs()
    .filter(verb => !IPC_INTERNAL.has(verb) && !documented.has(verb))
    .map(verb => `the IpcHandler defines "${verb}", which the README does not document`)
})

// A setting lives in three places: the defaults the widget starts from, the
// schema Setup renders, and the table a person reads. Two of three is a bug.
check("manifest defaults and schema describe the same settings", () => {
  const defaults = Object.keys(manifest.barWidget.defaults)
  const schema = manifest.barWidget.schema.map(entry => entry.key)
  return [
    ...defaults.filter(key => !schema.includes(key))
      .map(key => `"${key}" has a default but no schema entry, so Setup cannot change it`),
    ...schema.filter(key => !defaults.includes(key))
      .map(key => `"${key}" has a schema entry but no default`)
  ]
})

check("every setting is in the README settings table", () => {
  const table = readme.slice(readme.indexOf("## Settings"))
  return Object.keys(manifest.barWidget.defaults)
    .filter(key => !table.includes("`" + key + "`"))
    .map(key => `"${key}" is not in the README settings table`)
})

// A schema default that disagrees with the widget default means Setup shows
// one value and the widget starts with another.
check("schema defaults agree with widget defaults", () => {
  const defaults = manifest.barWidget.defaults
  return manifest.barWidget.schema
    .filter(entry => entry.key in defaults && entry.defaultValue !== defaults[entry.key])
    .map(entry => `"${entry.key}" defaults to ${JSON.stringify(defaults[entry.key])} but its schema says ${JSON.stringify(entry.defaultValue)}`)
})

check("the manifest entry point exists", () => {
  return Object.values(manifest.entryPoints)
    .filter(file => !fs.existsSync(path.join(root, file)))
    .map(file => `entryPoints names ${file}, which is not in the plugin`)
})

console.log(failures === 0 ? "\nAll wiring checks passed." : `\n${failures} wiring check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
