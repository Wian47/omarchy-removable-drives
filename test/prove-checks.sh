#!/usr/bin/env bash
# Proves wiring.test.js and shell.test.js fail when each invariant they claim
# to guard is broken. A check nobody has watched fail is a check nobody knows
# works, and these are exactly the kind that quietly stop matching the code.
#
# Each case copies the plugin to a scratch directory, breaks one thing, and
# expects a non-zero exit. Run with: bash test/prove-checks.sh
set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
LAB=$(mktemp -d)
trap 'rm -rf "$LAB"' EXIT

pass=0
missed=0

attempt() {
  local name=$1 mutate=$2 suite=${3:-wiring}
  rm -rf "$LAB/repo"
  cp -r "$SRC" "$LAB/repo"
  rm -rf "$LAB/repo/.git"
  ( cd "$LAB/repo" && eval "$mutate" )
  if ( cd "$LAB/repo" && node "test/$suite.test.js" >/dev/null 2>&1 ); then
    echo "  MISSED $name"
    missed=$((missed + 1))
  else
    echo "  caught $name"
    pass=$((pass + 1))
  fi
}

echo "Breaking one invariant at a time:"

attempt "a QML file that no longer parses" \
  "printf '\nItem { property int x: }\n' >> Service.qml"

attempt "a call to a Model function that does not exist" \
  "sed -i 's/Model\.formatBytes(/Model.formatBytesRenamed(/' Panel.qml"

attempt "a panel binding to a service property that does not exist" \
  "sed -i '0,/drives\.devices/s//drives.deviceList/' Panel.qml"

attempt "a device path concatenated into a command instead of quoted" \
  "sed -i 's|\"udisksctl power-off --no-user-interaction -b \" + quote(device.path)|\"udisksctl power-off --no-user-interaction -b \" + device.path|' Service.qml"

attempt "a scripting verb the README promises but nothing handles" \
  "sed -i 's|omarchy-shell removable-drives toggle|omarchy-shell removable-drives defragment|' README.md"

attempt "a scripting verb that works but is undocumented" \
  "sed -i 's|function phones(): string|function undocumentedVerb(): string { return \"\" }\n    function phones(): string|' Panel.qml"

attempt "a setting with a default and no schema entry" \
  "node -e 'const m=require(\"./manifest.json\");m.barWidget.defaults.ghostSetting=1;require(\"fs\").writeFileSync(\"manifest.json\",JSON.stringify(m,null,2))'"

attempt "a setting missing from the README table" \
  "sed -i 's/| \`barLabel\` |/| \`barLabelRenamed\` |/' README.md"

attempt "a schema default that disagrees with the widget default" \
  "node -e 'const m=require(\"./manifest.json\");m.barWidget.defaults.openOnMount=false;require(\"fs\").writeFileSync(\"manifest.json\",JSON.stringify(m,null,2))'"

# Assembled, not spelled, for the reason wiring.test.js gives: this file is
# inside the tree the capability scan reads.
FLAGGED="su""do"
attempt "a documentation line using a word the capability scan flags" \
  "sed -i 's|Nothing runs as root|Nothing runs as root and never through $FLAGGED|' README.md"

attempt "an entry point naming a file that is not there" \
  "node -e 'const m=require(\"./manifest.json\");m.entryPoints.barWidget=\"Missing.qml\";require(\"fs\").writeFileSync(\"manifest.json\",JSON.stringify(m,null,2))'"

attempt "a shell mistake inside an embedded script" \
  "sed -i \"s|'set -u',|'set -u',\\n    'cd /tmp',|\" Service.qml" \
  shell

# The parser in shell.test.js reads `readonly property string`. A script that
# drops the keyword is still a script, and would be linted by nothing at all.
attempt "a script written in a shape the extractor cannot read" \
  "sed -i 's|readonly property string formatScript:|property string formatScript:|' Service.qml" \
  shell

# The only case that breaks a check rather than the code it reads. The map from
# a line of shell back to the line of Service.qml it was written on has no
# source-side mutation that would show it wrong, so the mapping itself is what
# gets moved: to the end of each element instead of the start, which is the same
# line for a one-line element and the wrong one for every element that wraps.
attempt "a line map that points at the wrong source line" \
  "sed -i 's|lineOf(element.start)|lineOf(element.end)|' test/shell.test.js" \
  shell

echo
echo "caught $pass, missed $missed"
[ "$missed" -eq 0 ] || exit 1
