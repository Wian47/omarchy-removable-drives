import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Owns everything that talks to the system: the lsblk snapshot, the udev
// event stream that makes the snapshot current, the kernel's own I/O counters
// that say whether a drive is still being written to, and the udisksctl calls
// that mount, unmount, and power off a drive.
//
// Nothing here runs as root. Mounting a removable filesystem is
// `allow_active: yes` in the udisks2 policy, so the logged-in session may do
// it without a prompt; anything that needs more than that (an unlock
// passphrase) is handed to a terminal rather than faked in the panel.
Item {
  id: root

  property var settings: ({})

  // Parsed device list — the single source of truth the panel draws from.
  property var devices: []
  property bool refreshing: false
  property bool loaded: false

  // Per-device I/O, keyed by kernel name ("sda"): write/read rates, requests
  // in flight, and whether the drive is settled enough to pull.
  property var activity: ({})

  // What each drive's onConnect hook is doing, keyed by the name of the file
  // it reports into. A hook is the one kind of work on a drive the kernel
  // counters cannot see: an rsync goes quiet between file batches.
  property var hooks: ({})

  // Health as udisks reports it, keyed by device path. Most drives report
  // none — a USB stick carries neither SMART interface — and that is a normal,
  // quiet answer rather than a fault.
  property var smart: ({})
  property string _smartSignature: ""

  // The panel sets this while it is open, so free space stays current while
  // someone is looking at it and costs nothing while they are not.
  property bool watchClosely: false

  // Path of the device or volume an action is running against, so exactly one
  // row can show a spinner instead of the whole panel greying out.
  property string busyPath: ""
  property string busyAction: ""

  property string lastError: ""
  property string actionStatus: ""

  // An eject asked for while the drive is still being written to. Holds a
  // device path, or "*" for eject-all, and fires once the writes settle.
  property string pendingEjectPath: ""

  // Processes holding an unmount open, discovered only after udisks refuses.
  property var blockers: []
  property string blockedFsPath: ""

  // Phones and cameras, which are not block devices at all — gvfs mounts
  // them over MTP and lsblk never sees them.
  property var portables: []

  // Which gvfs backends exist, and what is plugged in that none of them can
  // reach. Drives the "install this to browse your phone" hint.
  property var support: ({ backends: {}, devices: [] })
  readonly property var supportHint: Model.supportHint(support)

  // Per-drive settings the user has saved, keyed so they survive replugging.
  property var store: ({ version: 1, drives: {} })

  // Mount options per mount point, straight from /proc/mounts — the kernel's
  // own answer to "is this mounted read-only?", which the lsblk tree does not
  // carry.
  property var mountFlags: ({})

  // Bytes sitting in each mounted volume's trash, keyed by trash directory.
  property var trashSizes: ({})
  property string uid: ""

  // What udisks says it can fsck, asked about the filesystem types actually
  // attached. The signature is the sorted list it was last asked about, so a
  // drive going in or out only costs a probe when it brings a new type.
  property var fsCapabilities: ({ check: {}, repair: {} })
  property string _capsSignature: ""

  // The filesystem the last check was about, and what it said: true healthy,
  // false damaged, null unreadable. A repair is only ever offered for this
  // exact path and only while the answer was false, so it cannot be started
  // against a volume nobody has looked at.
  property string checkedFsPath: ""
  property string checkedUuid: ""
  property var checkVerdict: null

  // Whether the repair button may be shown at all. Recomputed from the live
  // device list, so swapping the drive for another that lands on the same
  // /dev node retracts the offer instead of re-pointing it.
  readonly property bool repairOffered: {
    if (checkedFsPath === "" || checkVerdict !== false) return false
    for (var d = 0; d < devices.length; d++) {
      var volumes = devices[d].volumes
      for (var v = 0; v < volumes.length; v++) {
        if (volumes[v].fsPath === checkedFsPath) {
          return Model.repairAuthorised(
            { fsPath: checkedFsPath, uuid: checkedUuid, verdict: checkVerdict }, volumes[v])
        }
      }
    }
    return false
  }

  readonly property bool busy: actionProcess.running
  readonly property int deviceCount: devices.length
  readonly property int mountedCount: {
    var total = 0
    for (var i = 0; i < devices.length; i++) total += devices[i].mountedCount
    return total
  }

  // True while any attached drive still has I/O in flight or is running its
  // connect hook — the state in which pulling the drive is what loses data.
  readonly property bool anyBusy: {
    for (var i = 0; i < devices.length; i++) {
      if (isDeviceBusy(devices[i])) return true
    }
    return false
  }

  readonly property real totalWriteRate: {
    var total = 0
    for (var i = 0; i < devices.length; i++) {
      var entry = activity[devices[i].name]
      if (entry) total += entry.writeRate
    }
    return total
  }

  readonly property bool notificationsEnabled: setting("notifications", true) === true

  // Off by default: unmounting on the way into sleep is the right thing for
  // someone who carries a drive around, and the wrong thing for someone who
  // suspends with a backup half-written and expects it there on resume.
  readonly property bool unmountOnSuspend: setting("unmountOnSuspend", false) === true

  property string _successMessage: ""

  // A LUKS passphrase on its way to a process, held only between building the
  // command and the process starting, and cleared the moment it is written.
  property string _secret: ""
  property string _stdout: ""
  property string _stderr: ""
  property string _openAfterPath: ""
  property var _statSamples: ({})

  // Consecutive samples each device has read busy, so a one-sample blip — the
  // remount every rename and check performs — is not mistaken for a copy.
  property var _busyTicks: ({})
  property var _previousDevices: []
  property var _expectedRemovals: ({})
  property bool _seenFirstSnapshot: false
  property int _quietTicks: 0

  // One quiet sample is not enough to call a copy finished: throughput dips to
  // zero between bursts. Two consecutive quiet seconds is the threshold.
  readonly property int quietTicksBeforeEject: 2

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    return Math.max(min, Math.min(max, n))
  }

  // Lives in Model.js so the escaping is covered by tests.
  function quote(value) {
    return Model.shellQuote(value)
  }

  function deviceByPath(path) {
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].path === path) return devices[i]
    }
    return null
  }

  function activityFor(device) {
    if (!device) return null
    return activity[device.name] || null
  }

  // A running hook counts as busy for the same reason kernel I/O does: pulling
  // the drive while it works is what loses the copy. It goes through here
  // rather than beside it, so the eject hold, the pending-eject wait and the
  // bar icon all pick it up without a second mechanism to keep in step.
  function isDeviceBusy(device) {
    var entry = activityFor(device)
    return !!(entry && entry.busy) || hookActive(device)
  }

  function activityLabelFor(device) {
    return Model.activityLabel(activityFor(device))
  }

  // ------------------------------------------------------------- reading

  function refresh() {
    if (lsblkProcess.running) return
    refreshing = true
    lsblkProcess.running = true
    if (!mountsProcess.running) mountsProcess.running = true
  }

  function readOnlyFor(volume) {
    return Model.isReadOnly(mountFlags, volume)
  }

  function metaFor(volume) {
    return Model.volumeMeta(volume, readOnlyFor(volume))
  }

  // What the rescan button and `r` do. Unlike refresh(), it also forgets what
  // udisks last said it could fsck — so installing a missing tool and pressing
  // rescan is enough to make the check button appear, without a shell restart.
  // Health is forgotten for the same reason: it is the only other answer here
  // that is read once and then kept.
  function rescan() {
    _capsSignature = ""
    _smartSignature = ""
    refresh()
    refreshPortables()
  }

  function applySnapshot(raw) {
    var next = []
    try {
      next = Model.parse(raw)
    } catch (e) {
      lastError = "Could not read the block device list"
      refreshing = false
      return
    }

    Model.applyStore(next, store)
    var diff = Model.deviceDiff(_previousDevices, next)
    devices = next
    _previousDevices = next
    loaded = true
    refreshing = false

    // The first snapshot describes drives that were already attached before
    // the shell started; announcing those would mean a notification storm at
    // every login.
    if (_seenFirstSnapshot) announceChanges(diff)
    _seenFirstSnapshot = true

    if (watchClosely) probeTrash()
    probeCapabilities()
    probeSmart()
    updateSuspendTargets()

    // A mount requested with "open after mounting" only knows where the
    // filesystem landed once the next snapshot comes back with a mount point.
    if (_openAfterPath !== "") {
      var pending = _openAfterPath
      _openAfterPath = ""
      var volume = volumeByPath(pending)
      if (volume && volume.mounted) openVolume(volume)
    }
  }

  function volumeByPath(fsPath) {
    for (var d = 0; d < devices.length; d++) {
      var volumes = devices[d].volumes
      for (var v = 0; v < volumes.length; v++) {
        if (volumes[v].fsPath === fsPath) return volumes[v]
      }
    }
    return null
  }

  // ------------------------------------------------------- arrival/removal

  function announceChanges(diff) {
    var i
    for (i = 0; i < diff.added.length; i++) {
      var added = diff.added[i]
      notify(added.title + " connected", Model.connectedSummary(added), added.glyph)
      runConnectHook(added)
    }
    for (i = 0; i < diff.removed.length; i++) {
      var gone = diff.removed[i]
      // We powered this one off ourselves and already said "safe to remove".
      if (_expectedRemovals[gone.path]) {
        var seen = _expectedRemovals
        delete seen[gone.path]
        _expectedRemovals = seen
        continue
      }
      // Unplugged with a filesystem still mounted: the one case worth
      // interrupting someone over, because it is the case that loses files.
      if (gone.mountedCount > 0) {
        notify("Removed while still mounted",
               gone.title + " was unplugged before it was unmounted. Files may be incomplete.",
               Model.GLYPH_ALERT, "critical")
      } else {
        notify(gone.title + " removed", "", gone.glyph)
      }
    }
  }

  // ------------------------------------------------------------- activity

  function sampleActivity() {
    if (statsProcess.running || devices.length === 0) return
    var command = ["head", "-v", "-n", "1"]
    for (var i = 0; i < devices.length; i++) {
      command.push("/sys/block/" + devices[i].name + "/stat")
    }
    statsProcess.command = command
    statsProcess.running = true
  }

  function applyStats(raw) {
    var built = Model.buildActivity(_statSamples, Model.parseBlockStats(raw), Date.now())
    activity = built.activity
    _statSamples = built.samples

    // Rebuilt from the live device list, so a drive that has gone takes its
    // tally with it rather than lingering as a name nobody looks up.
    var ticks = {}
    for (var i = 0; i < devices.length; i++) {
      var name = devices[i].name
      var entry = built.activity[name]
      ticks[name] = Model.advanceBusy(_busyTicks[name], !!(entry && entry.busy))
    }
    _busyTicks = ticks
    advancePendingEject()
  }

  // An eject deferred for writes runs as soon as the drive has been quiet for
  // two consecutive samples. One quiet sample is not enough: a copy in
  // progress dips to zero between bursts.
  function advancePendingEject() {
    if (pendingEjectPath === "") return

    var targets = pendingEjectTargets()
    if (targets.length === 0) {
      pendingEjectPath = ""
      _quietTicks = 0
      return
    }

    var stillBusy = false
    for (var i = 0; i < targets.length; i++) {
      if (isDeviceBusy(targets[i])) stillBusy = true
    }

    var step = Model.advanceQuiet(stillBusy, _quietTicks, quietTicksBeforeEject)
    _quietTicks = step.quietTicks
    if (!step.run) return

    pendingEjectPath = ""
    _quietTicks = 0
    runEject(targets)
  }

  function pendingEjectTargets() {
    if (pendingEjectPath === "") return []
    if (pendingEjectPath === "*") return devices
    var device = deviceByPath(pendingEjectPath)
    return device ? [device] : []
  }

  function cancelPendingEject() {
    pendingEjectPath = ""
    _quietTicks = 0
    actionStatus = ""
  }

  // ------------------------------------------------------------- actions

  function runAction(command, path, action, successMessage, secret) {
    if (actionProcess.running) return
    _secret = secret === undefined || secret === null ? "" : secret
    lastError = ""
    actionStatus = ""
    blockers = []
    blockedFsPath = ""
    checkedFsPath = ""
    checkedUuid = ""
    checkVerdict = null
    _stdout = ""
    _stderr = ""
    _successMessage = successMessage
    busyPath = path
    busyAction = action
    actionProcess.command = command
    actionProcess.running = true
  }

  function mount(volume, openAfter) {
    if (!volume || !Model.isMountable(volume) || busy) return
    _openAfterPath = openAfter ? volume.fsPath : ""
    runAction(["udisksctl", "mount", "--no-user-interaction", "-b", volume.fsPath],
              volume.fsPath, "mount", "Mounted " + volume.title)
  }

  function unmount(volume, force) {
    if (!volume || !volume.mounted || busy) return
    _openAfterPath = ""
    var command = ["udisksctl", "unmount", "--no-user-interaction", "-b", volume.fsPath]
    if (force) command.push("--force")
    runAction(command, volume.fsPath, "unmount",
              (force ? "Force unmounted " : "Unmounted ") + volume.title)
  }

  // The rescue path out of a failed check. Repair rewrites the filesystem, so
  // the honest first move on a drive that failed is to read what is still
  // there without writing a byte to it — which the panel previously advised
  // ("copy anything you still need off it first") without offering any way to
  // do.
  //
  // A filesystem already mounted read-write has to come off first; there is no
  // remount here, because changing the mount is the whole operation rather
  // than a step on the way to one. If the read-only mount then fails, the
  // drive is left unmounted and the error says so, which beats quietly putting
  // it back writable.
  function mountReadOnly(volume) {
    if (!volume) return "unknown volume"
    if (busy) return refuse("Another action is still running")
    if (volume.encrypted && !volume.unlocked) return refuse("Unlock this volume first")
    if (volume.mounted && readOnlyFor(volume)) {
      actionStatus = volume.title + " is already mounted read-only"
      return "unchanged"
    }
    if (!volume.mounted && !Model.isMountable(volume)) {
      return refuse(describeFs(volume) + " cannot be mounted")
    }
    var blocked = fsActionBlocked(volume)
    if (blocked !== "") return refuse(blocked)

    var script = [
      'set -u',
      'dev=$1',
      'if [ "$2" = 1 ]; then udisksctl unmount --no-user-interaction -b "$dev" >/dev/null || exit 1; fi',
      'udisksctl mount --no-user-interaction -o ro -b "$dev" >/dev/null'
    ].join("\n")
    runAction(["bash", "-c", script, "removable-drives", volume.fsPath, volume.mounted ? "1" : "0"],
              volume.fsPath, "mount-ro", "Mounted " + volume.title + " read-only")
    return "ok"
  }

  function toggleMount(volume, openAfter) {
    if (!volume) return
    if (volume.mounted) unmount(volume, false)
    else if (volume.encrypted && !volume.unlocked) unlock(volume)
    else mount(volume, openAfter)
  }

  function forceUnmountBlocked() {
    var volume = volumeByPath(blockedFsPath)
    if (volume) unmount(volume, true)
  }

  // udisksctl reads a key only from a file, never from stdin, so the
  // passphrase has to land on disk somewhere. XDG_RUNTIME_DIR is tmpfs — it
  // never reaches persistent storage — the file is created under umask 077,
  // and a trap removes it however the script ends.
  //
  // The passphrase reaches the script on stdin rather than as an argument,
  // because /proc/<pid>/cmdline is readable by every other process this user
  // runs, and a passphrase in argv is a passphrase in `ps`.
  //
  // udisks refuses the backing partition for mount and unmount alike, so the
  // mount that follows targets the mapper udisksctl names on its way out.
  readonly property string unlockScript: [
    'set -u',
    'dev=$1',
    'keyfile="${XDG_RUNTIME_DIR:-/dev/shm}/removable-drives.$$.key"',
    "trap 'rm -f \"$keyfile\"' EXIT INT TERM",
    'umask 077',
    'IFS= read -r pass',
    'printf %s "$pass" > "$keyfile"',
    'unset pass',
    'out=$(udisksctl unlock --no-user-interaction -b "$dev" --key-file "$keyfile") || exit 1',
    'printf "%s\\n" "$out"',
    'mapper=${out##* as }',
    'mapper=${mapper%.}',
    'case "$mapper" in',
    '  /dev/*) udisksctl mount --no-user-interaction -b "$mapper" >/dev/null ;;',
    '  *) echo "udisks did not say which device it unlocked" >&2; exit 1 ;;',
    'esac'
  ].join("\n")

  function unlock(volume, passphrase) {
    if (!Model.canUnlock(volume)) return "This volume is not locked"
    if (busy) return refuse("Another action is still running")
    if (String(passphrase || "") === "") return refuse("Enter the passphrase first")
    runAction(["bash", "-c", unlockScript, "removable-drives", volume.path],
              volume.fsPath, "unlock", "Unlocked " + volume.title,
              String(passphrase))
    return "ok"
  }

  // The other half of unlocking. Closing a container means taking the
  // filesystem inside it offline first, so this is one action rather than two
  // the user has to know the order of — and the two steps address different
  // devices: the filesystem lives on the mapper, while only the backing
  // partition can be locked.
  function lock(volume) {
    if (!volume) return "unknown volume"
    if (busy) return refuse("Another action is still running")
    if (!Model.canLock(volume)) return refuse("This volume is not unlocked")
    var blocked = fsActionBlocked(volume)
    if (blocked !== "") return refuse(blocked)
    var script = [
      'set -u',
      'if [ "$2" = 1 ]; then udisksctl unmount --no-user-interaction -b "$1" >/dev/null || exit 1; fi',
      'udisksctl lock --no-user-interaction -b "$3" >/dev/null'
    ].join("\n")
    runAction(["bash", "-c", script, "removable-drives",
               volume.fsPath, volume.mounted ? "1" : "0", volume.path],
              volume.fsPath, "lock", "Locked " + volume.title)
    return "ok"
  }

  // Ejecting a drive the kernel is still writing to is exactly the mistake
  // this widget exists to prevent, so the request is held rather than refused
  // and runs by itself the moment the drive goes quiet.
  function eject(device) {
    if (!device || busy) return
    if (isDeviceBusy(device)) {
      pendingEjectPath = device.path
      _quietTicks = 0
      actionStatus = "Waiting for writes to finish on " + device.title + "…"
      return
    }
    runEject([device])
  }

  function ejectAll() {
    if (busy || devices.length === 0) return
    if (anyBusy) {
      pendingEjectPath = "*"
      _quietTicks = 0
      actionStatus = "Waiting for writes to finish…"
      return
    }
    runEject(devices)
  }

  // Unmount everything, re-lock anything that was unlocked, then cut power.
  // `set -e` stops at the first failure so a busy filesystem surfaces as an
  // error instead of a half-ejected drive, and power-off is allowed to fail
  // on hubs and card readers that don't implement it — by then the drive is
  // already safe to pull.
  function runEject(list) {
    if (!list || list.length === 0 || busy) return
    var script = "set -e\n"
    var titles = []
    for (var d = 0; d < list.length; d++) {
      var device = list[d]
      titles.push(device.title)
      for (var v = 0; v < device.volumes.length; v++) {
        var volume = device.volumes[v]
        if (volume.mounted) script += "udisksctl unmount --no-user-interaction -b " + quote(volume.fsPath) + "\n"
        if (volume.encrypted && volume.unlocked) script += "udisksctl lock --no-user-interaction -b " + quote(volume.path) + "\n"
      }
      script += "udisksctl power-off --no-user-interaction -b " + quote(device.path) + " || true\n"

      // Remember that this one is meant to disappear, so its removal is not
      // reported back to the user as an accident.
      var expected = _expectedRemovals
      expected[device.path] = true
      _expectedRemovals = expected
    }
    runAction(["bash", "-c", script], list.length === 1 ? list[0].path : "*", "eject",
              "Safe to remove " + titles.join(", "))
  }

  function openVolume(volume) {
    if (!volume || !volume.mounted) return
    var command = String(setting("fileManager", "")).replace(/^\s+|\s+$/g, "")
    if (command === "") {
      Quickshell.execDetached(["uwsm-app", "--", "xdg-open", volume.mountpoint])
      return
    }
    Quickshell.execDetached(["bash", "-c", command + " " + quote(volume.mountpoint)])
  }

  function openTerminal(volume) {
    if (!volume || !volume.mounted) return
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
                             "cd " + quote(volume.mountpoint) + " && exec $SHELL"])
  }

  // ------------------------------------------------------- sleep guard
  //
  // Closing the lid with a drive mounted and pulling it out later is the same
  // way of losing files this widget exists to prevent, and nothing else on the
  // system stops it. logind will wait for a delay inhibitor before suspending
  // — up to InhibitDelayMaxSec, fifteen seconds here — which is far longer
  // than unmounting takes.
  //
  // The lock is released as soon as the unmounting is done, so a machine with
  // nothing mounted suspends as promptly as it did before. Re-arming waits for
  // the resume signal rather than happening immediately, so a fresh delay lock
  // can never land in the middle of the suspend it was just told about.

  readonly property string suspendTargetsPath:
    Quickshell.env("HOME") + "/.local/state/omarchy/removable-drives-suspend"

  property string _suspendSignature: ""

  // The guard is a shell loop rather than QML because the unmounting has to
  // finish while the lock is still held; a Process started from here would
  // return long before that, and the lock would be gone.
  readonly property string suspendScript: [
    'set -u',
    'targets=$1',
    'notify=$3',
    'glyph=$4',
    // systemd-inhibit holds the lock as an fd, so logind drops it the moment
    // that process dies — but only if it actually dies. Killing this script
    // leaves it reparented to init, still holding a delay lock that nothing
    // will ever release, and every shell restart leaks another one until
    // suspend waits the full fifteen seconds every time.
    'inhibit_pid=""',
    // A trap covers a polite shutdown. It cannot cover SIGKILL, which is what
    // a shell restart actually delivers — and the inhibitor, reparented to
    // init, then holds a delay lock nothing will release. So the guard also
    // records its inhibitor's pid and reaps the previous one on the way in.
    // /proc is consulted rather than a name pattern, because this script's own
    // command line contains every string a pattern would match.
    'guardfile=$2',
    'reap_stale() {',
    '  [ -r "$guardfile" ] || return 0',
    '  old=$(cat "$guardfile" 2>/dev/null)',
    '  case "$old" in ""|*[!0-9]*) return 0 ;; esac',
    '  case "$(tr -d \'\\000\' < /proc/$old/cmdline 2>/dev/null)" in',
    // The whole group, not just the inhibitor. systemd-inhibit spawns the
    // process that waits for the signal, and killing only the parent leaves
    // that child alive — reparented, still holding a gdbus monitor, blocked
    // on a read that will never return. The lock was freed and nineteen
    // monitors were not.
    '    systemd-inhibit*) kill -- -"$old" 2>/dev/null ;;',
    '  esac',
    '}',
    'reap_stale',
    'cleanup() {',
    '  [ -n "${inhibit_pid:-}" ] && kill -- -"$inhibit_pid" 2>/dev/null',
    '  [ -n "${MONITOR_PID:-}" ] && kill "$MONITOR_PID" 2>/dev/null',
    '  exit 0',
    '}',
    'trap cleanup EXIT INT TERM HUP',
    'wait_for_sleep_signal() {',
    '  coproc MONITOR { gdbus monitor --system --dest org.freedesktop.login1' +
      ' --object-path /org/freedesktop/login1; }',
    '  while IFS= read -r line <&"${MONITOR[0]}"; do',
    '    case "$line" in *"PrepareForSleep ($1,)"*) break ;; esac',
    '  done',
    '  kill "$MONITOR_PID" 2>/dev/null',
    '  wait "$MONITOR_PID" 2>/dev/null',
    '}',
    // A drive that refused to unmount is the whole reason this exists, so it
    // is the one outcome that must not pass in silence. Sleeping while
    // believing your drives were parked is worse than never having been
    // offered the feature: it manufactures the confidence that gets a drive
    // pulled out of a sleeping laptop.
    'unmount_targets() {',
    '  [ -r "$1" ] || return 0',
    '  failed=""',
    '  while IFS= read -r dev; do',
    '    [ -n "$dev" ] || continue',
    '    if udisksctl unmount --no-user-interaction -b "$dev" >/dev/null 2>&1; then',
    '      continue',
    '    fi',
    '    failed="$failed $dev"',
    '  done < "$1"',
    '  [ -n "$failed" ] || return 0',
    '  [ "$2" = 1 ] || return 0',
    '  omarchy-notification-send -u critical -g "$3" "Still mounted going into sleep" \\',
    '    "Could not unmount:$failed — do not unplug until this is sorted" || true',
    '}',
    'export -f wait_for_sleep_signal unmount_targets',
    'while true; do',
    // setsid so the inhibitor leads its own process group: that is what makes
    // the whole tree killable as one, rather than by name — and this script's
    // own command line contains every name a pattern would match.
    '  setsid systemd-inhibit --what=sleep --mode=delay --who="Removable Drives"' +
      ' --why="Unmounting removable drives" \\',
    "    bash -c 'wait_for_sleep_signal true; unmount_targets \"$1\" \"$2\" \"$3\"'" +
      ' removable-drives "$targets" "$notify" "$glyph" &',
    '  inhibit_pid=$!',
    '  printf %s "$inhibit_pid" > "$guardfile"',
    '  wait "$inhibit_pid"',
    '  inhibit_pid=""',
    '  wait_for_sleep_signal false',
    'done'
  ].join("\n")

  // Rewritten only when the mounted set changes, so a drive appearing or going
  // quiet does not cost a write.
  function updateSuspendTargets() {
    if (!unmountOnSuspend) return
    var text = Model.suspendTargets(devices).join("\n")
    if (text === _suspendSignature) return
    _suspendSignature = text
    suspendWriter.command = ["bash", "-c",
                             'mkdir -p "$(dirname "$2")" && printf %s "$1" > "$2"',
                             "removable-drives", text, suspendTargetsPath]
    suspendWriter.running = true
  }

  // -------------------------------------------------- per-drive memory

  readonly property string storePath: Quickshell.env("HOME") + "/.local/state/omarchy/removable-drives.json"

  function saveDriveSetting(device, name, value) {
    if (!device) return
    var next = Model.withDriveSetting(store, device, name, value)
    store = next
    storeWriter.command = ["bash", "-c",
                           'mkdir -p "$(dirname "$2")" && printf %s "$1" > "$2"',
                           "removable-drives", JSON.stringify(next), storePath]
    storeWriter.running = true
    // Re-apply immediately so the panel renames without waiting for lsblk.
    var applied = devices.slice()
    Model.applyStore(applied, next)
    devices = applied
  }

  function setNickname(device, nickname) {
    saveDriveSetting(device, "nickname", String(nickname || "").replace(/^\s+|\s+$/g, ""))
  }

  function driveSetting(device, name, fallback) {
    var saved = Model.driveSettings(store, device)
    var value = saved[name]
    return value === undefined || value === null ? fallback : value
  }

  // ------------------------------------------------------- connect hooks
  //
  // A user-authored command run when a specific drive appears — a backup, a
  // sync, an import. It is never inferred and never suggested; it only runs
  // if someone put it in the state file for that drive themselves.
  //
  // Until it had somewhere to report, the panel drew a drive running an rsync
  // as an idle one, and someone could pull it mid-copy. The busy icon is no
  // substitute: kernel I/O goes quiet between an rsync's file batches.

  // Where a hook writes its progress, and the only file this plugin ever asks
  // one to touch. XDG_RUNTIME_DIR is tmpfs, so it never reaches persistent
  // storage and never outlives the session.
  readonly property string progressDir: {
    var runtime = String(Quickshell.env("XDG_RUNTIME_DIR") || "")
    return (runtime !== "" ? runtime : "/dev/shm") + "/omarchy-removable-drives/progress"
  }

  function progressName(device) {
    return Model.hookProgressName(Model.driveKey(device))
  }

  // The wrapper is what lets the panel tell a hook still working from one that
  // died: it records its own pid beside the progress file, and a trap clears
  // that however the hook ends. A pid file rather than a Process held here,
  // because a hook outlives a shell restart and the panel should find it again
  // when it comes back.
  //
  // The user's command still reaches bash as a positional argument rather than
  // as script text, and gains $3 — the file above — beside the $1 and $2 it
  // already had. Every hook written before this one is unaffected.
  readonly property string hookScript: [
    'set -u',
    'dir=$1',
    'file=$dir/$2',
    'mkdir -p "$dir" || exit 1',
    ': > "$file" || exit 1',
    "trap 'rm -f \"$file.pid\"' EXIT INT TERM HUP",
    'printf %s "$$" > "$file.pid"',
    'bash -c "$5" removable-drives "$3" "$4" "$file"'
  ].join("\n")

  function runConnectHook(device) {
    var command = String(driveSetting(device, "onConnect", "")).replace(/^\s+|\s+$/g, "")
    if (command === "") return
    var name = progressName(device)
    if (name === "") return
    markHookStarted(name)
    Quickshell.execDetached(["bash", "-c", hookScript, "removable-drives",
                             progressDir, name, device.path, mountpointOf(device), command])
  }

  function mountpointOf(device) {
    if (!device) return ""
    for (var i = 0; i < device.volumes.length; i++) {
      if (device.volumes[i].mounted) return device.volumes[i].mountpoint
    }
    return ""
  }

  // One pass over every drive with a hook: whether the process this plugin
  // started is still alive, then whatever it has written. Capped, because a
  // runaway hook writing into its progress file should cost a truncated line
  // rather than the whole panel.
  readonly property string hookPollScript: [
    'set -u',
    'dir=$1',
    'shift',
    'for name; do',
    '  file=$dir/$name',
    '  run=0',
    '  pid=$(cat "$file.pid" 2>/dev/null) || pid=""',
    '  case "$pid" in',
    '    ""|*[!0-9]*) ;;',
    '    *) kill -0 "$pid" 2>/dev/null && run=1 ;;',
    '  esac',
    '  echo "==> $name $run <=="',
    '  if [ -r "$file" ]; then head -c 1024 "$file"; echo; fi',
    'done'
  ].join("\n")

  function hookedDrives() {
    var out = []
    for (var i = 0; i < devices.length; i++) {
      var command = String(driveSetting(devices[i], "onConnect", "")).replace(/^\s+|\s+$/g, "")
      if (command === "") continue
      var name = progressName(devices[i])
      if (name !== "") out.push(name)
    }
    return out
  }

  // Polling stops once every hook has reported itself finished, so a drive
  // whose hook ran an hour ago costs nothing per second. A hook starting marks
  // that drive active again, which is what starts the poll back up.
  function hooksWorthPolling() {
    var names = hookedDrives()
    for (var i = 0; i < names.length; i++) {
      var state = hooks[names[i]]
      if (!state || state.active) return names
    }
    return []
  }

  function sampleHooks() {
    if (hooksProcess.running) return
    var names = hooksWorthPolling()
    if (names.length === 0) return
    var command = ["bash", "-c", hookPollScript, "removable-drives", progressDir]
    for (var i = 0; i < names.length; i++) command.push(names[i])
    hooksProcess.command = command
    hooksProcess.running = true
  }

  // Rebuilt against the drives actually attached, the same way the busy tally
  // is, so a drive that has gone takes its hook state with it.
  function applyHooks(raw) {
    var report = Model.parseHookReport(raw)
    var live = hookedDrives()
    var next = {}
    for (var i = 0; i < live.length; i++) {
      var name = live[i]
      if (report[name] !== undefined) next[name] = report[name]
      else if (hooks[name] !== undefined) next[name] = hooks[name]
    }
    hooks = next
    advancePendingEject()
  }

  // Busy from the instant the hook is launched rather than from the first poll
  // a second later, so an eject clicked in that gap is held rather than cutting
  // power to a copy that had only just started. It is also what puts the drive
  // back in the poll, since the poll stops once every hook has finished.
  function markHookStarted(name) {
    var next = {}
    for (var key in hooks) next[key] = hooks[key]
    next[name] = { active: true, percent: null, status: "", done: false }
    hooks = next
  }

  function hookStateFor(device) {
    if (!device) return null
    var name = progressName(device)
    return name === "" ? null : (hooks[name] || null)
  }

  function hookActive(device) {
    var state = hookStateFor(device)
    return !!(state && state.active)
  }

  function hookLabelFor(device) {
    return Model.hookLabel(hookStateFor(device))
  }

  // What `status` reports, so a backup script polling for a drive to settle
  // sees the same thing the panel does.
  function hookReport() {
    var out = []
    for (var i = 0; i < devices.length; i++) {
      var state = hookStateFor(devices[i])
      if (!state) continue
      out.push({
        device: devices[i].path,
        active: state.active,
        percent: state.percent,
        status: state.status,
        done: state.done
      })
    }
    return out
  }

  // -------------------------------------------------------------- trash

  function mountedMountpoints() {
    var out = []
    for (var d = 0; d < devices.length; d++) {
      for (var v = 0; v < devices[d].volumes.length; v++) {
        if (devices[d].volumes[v].mounted) out.push(devices[d].volumes[v].mountpoint)
      }
    }
    return out
  }

  function probeTrash() {
    if (trashProcess.running || uid === "") return
    var mounts = mountedMountpoints()
    if (mounts.length === 0) {
      trashSizes = ({})
      return
    }
    var command = ["du", "-sb", "--"]
    for (var i = 0; i < mounts.length; i++) {
      var candidates = Model.trashCandidates(mounts[i], uid)
      for (var c = 0; c < candidates.length; c++) command.push(candidates[c])
    }
    trashProcess.command = command
    trashProcess.running = true
  }

  function trashSizeFor(volume) {
    if (!volume || !volume.mounted) return 0
    var candidates = Model.trashCandidates(volume.mountpoint, uid)
    for (var i = 0; i < candidates.length; i++) {
      var size = trashSizes[candidates[i]]
      if (size > 0) return size
    }
    return 0
  }

  function trashPathFor(volume) {
    if (!volume || !volume.mounted) return ""
    var candidates = Model.trashCandidates(volume.mountpoint, uid)
    for (var i = 0; i < candidates.length; i++) {
      if (trashSizes[candidates[i]] > 0) return candidates[i]
    }
    return ""
  }

  // Recursive deletion, so the path is re-derived from the live mount list
  // and matched exactly rather than trusted from the caller.
  function emptyTrash(volume) {
    var path = trashPathFor(volume)
    if (path === "" || busy) return
    if (!Model.isSafeTrashPath(path, mountedMountpoints(), uid)) {
      lastError = "Refusing to empty an unrecognised trash path"
      return
    }
    runAction(["rm", "-rf", "--", path], volume.fsPath, "trash",
              "Emptied trash on " + volume.title)
  }

  // ------------------------------------------- labels and integrity

  // Renaming a filesystem and running its fsck are both on
  // org.freedesktop.UDisks2.Filesystem, and `udisksctl` has a verb for
  // neither — so these three go over the bus directly. Both are
  // `modify-device` in the udisks policy, which is `allow_active: yes` for a
  // removable drive: the same no-password path mounting already takes, and
  // still nothing running as root.

  // One script for all three, because they share a shape: resolve the udisks
  // object for the device, take the filesystem offline, do the one thing, put
  // it back. The mount is restored whether or not the middle step worked — a
  // rename udisks refused should not also leave the drive unmounted.
  //
  // The object path is asked for rather than built. udisks escapes the kernel
  // name into it, so an unlocked LUKS volume at /dev/mapper/backup is
  // .../block_devices/dm_2d3, and a plugin guessing at that encoding would
  // work on every stick and fail on every encrypted one.
  //
  // Everything variable arrives as a positional argument. The label is the one
  // string here a person typed rather than a device supplied, and passing it
  // as "$4" means it never becomes part of the script text.
  readonly property string fsScript: [
    'set -u',
    'dev=$1',
    'remount=$2',
    'method=$3',
    'label=${4-}',
    'raw=$(busctl call org.freedesktop.UDisks2 /org/freedesktop/UDisks2/Manager' +
      ' org.freedesktop.UDisks2.Manager ResolveDevice "a{sv}a{sv}" 1 path s "$dev" 0) || exit 1',
    // The path is the last field and arrives wrapped in quotes. Trimming from
    // the first slash and then dropping one trailing character lifts it out
    // without naming a quote anywhere — a literal one would have to survive
    // both QML's escaping and bash's, and only looks right in one of them.
    'obj=/${raw#*/}',
    'obj=${obj%?}',
    'case "$obj" in',
    '  /org/freedesktop/UDisks2/block_devices/*) ;;',
    '  *) echo "udisks does not recognise $dev" >&2; exit 1 ;;',
    'esac',
    'if [ "$remount" = 1 ]; then udisksctl unmount --no-user-interaction -b "$dev" >/dev/null || exit 1; fi',
    'rc=0',
    'if [ "$method" = SetLabel ]; then',
    '  busctl --timeout=120 call org.freedesktop.UDisks2 "$obj"' +
      ' org.freedesktop.UDisks2.Filesystem SetLabel "sa{sv}" "$label" 0 || rc=$?',
    'else',
    // An fsck has no useful upper bound — a big NTFS volume can take an hour —
    // so the bus timeout is a day rather than busctl's default 25 seconds,
    // which would abandon the call while the tool was still working.
    '  busctl --timeout=86400 call org.freedesktop.UDisks2 "$obj"' +
      ' org.freedesktop.UDisks2.Filesystem "$method" "a{sv}" 0 || rc=$?',
    'fi',
    // Putting the filesystem back can fail on its own — the drive was renamed
    // or repaired and is now sitting unmounted. Swallowing that reported the
    // rename as a plain success while the drive had quietly gone away, so it
    // comes back as its own exit code when nothing else went wrong, and as an
    // extra line on stderr when something did.
    'remount_rc=0',
    'if [ "$remount" = 1 ]; then udisksctl mount --no-user-interaction -b "$dev" >/dev/null || remount_rc=$?; fi',
    'if [ "$remount_rc" != 0 ]; then',
    '  echo "the filesystem could not be mounted again" >&2',
    '  if [ "$rc" = 0 ]; then rc=75; fi',
    'fi',
    'exit $rc'
  ].join("\n")

  // One round trip per filesystem type, and only for the types attached.
  readonly property string capsScript:
    'for fs in "$@"; do for op in CanCheck CanRepair; do' +
    ' out=$(busctl --timeout=10 call org.freedesktop.UDisks2 /org/freedesktop/UDisks2/Manager' +
    ' org.freedesktop.UDisks2.Manager "$op" s "$fs" 2>/dev/null) || out="";' +
    ' echo "$op $fs $out"; done; done'

  function probeCapabilities() {
    if (capsProcess.running) return
    var types = Model.fsTypesPresent(devices)
    var signature = types.join(",")
    if (signature === _capsSignature) return
    _capsSignature = signature
    if (types.length === 0) {
      fsCapabilities = ({ check: {}, repair: {} })
      return
    }
    var command = ["bash", "-c", capsScript, "removable-drives"]
    for (var i = 0; i < types.length; i++) command.push(types[i])
    capsProcess.command = command
    capsProcess.running = true
  }

  function deviceOfVolume(volume) {
    if (!volume) return null
    for (var d = 0; d < devices.length; d++) {
      for (var v = 0; v < devices[d].volumes.length; v++) {
        if (devices[d].volumes[v].fsPath === volume.fsPath) return devices[d]
      }
    }
    return null
  }

  // All three take the filesystem offline, and unmounting a drive mid-copy is
  // the one move this widget exists to prevent. Unlike an eject the request is
  // refused rather than held: an eject that runs two seconds late is still the
  // eject you asked for, while a rename that fires once you have wandered off
  // is a drive silently unmounted behind you.
  function fsActionBlocked(volume) {
    if (!volume) return "No volume selected"
    var device = deviceOfVolume(volume)
    if (device && hookActive(device)) {
      return device.title + " is still running its connect hook — try again once it finishes"
    }
    if (device && Model.sustainedBusy(_busyTicks[device.name])) {
      return device.title + " is still being written to — try again once it settles"
    }
    return ""
  }

  function runFsAction(volume, method, label, action, successMessage) {
    runAction(["bash", "-c", fsScript, "removable-drives",
               volume.fsPath, volume.mounted ? "1" : "0", method, label],
              volume.fsPath, action, successMessage)
  }

  // These three answer with "ok" or with the reason they did not run, so a
  // script calling them over IPC learns what the panel would have shown in its
  // status line. Silence would be worse than a refusal: a rename that was
  // turned away for a drive still settling looks exactly like one that worked.
  function refuse(reason) {
    lastError = reason
    return reason
  }

  // "ISO9660 volumes" rather than "an ISO9660 volume", so the sentence does not
  // have to guess at an article for a name it has never seen.
  function describeFs(volume) {
    var named = volume ? Model.clean(volume.fstypeLabel) : ""
    if (named === "") named = volume ? Model.clean(volume.fstype) : ""
    return named === "" ? "This filesystem" : named + " volumes"
  }

  function setVolumeLabel(volume, label) {
    if (!volume) return "unknown volume"
    if (busy) return refuse("Another action is still running")
    if (!Model.canRelabel(volume)) {
      return refuse(describeFs(volume) + " cannot be renamed from here")
    }
    var checked = Model.validateLabel(volume, label)
    if (!checked.ok) return refuse(checked.message)
    // Enter on a field nobody edited is the common case, and it should close
    // the editor rather than unmount the drive to write the name it already
    // has.
    if (checked.label === Model.normaliseLabel(volume.label)) {
      actionStatus = ""
      return "unchanged"
    }
    var blocked = fsActionBlocked(volume)
    if (blocked !== "") return refuse(blocked)
    runFsAction(volume, "SetLabel", checked.label, "relabel",
                checked.label === "" ? "Cleared the name on " + volume.title
                                     : "Renamed " + volume.title + " to " + checked.label)
    return "ok"
  }

  function checkVolume(volume) {
    if (!volume) return "unknown volume"
    if (busy) return refuse("Another action is still running")
    if (!Model.canCheck(fsCapabilities, volume)) {
      return refuse(describeFs(volume) + " cannot be checked here")
    }
    var blocked = fsActionBlocked(volume)
    if (blocked !== "") return refuse(blocked)
    runFsAction(volume, "Check", "", "check", "")
    return "ok"
  }

  // Reachable only from the button a failed check puts on screen, so a repair
  // — the one operation here that rewrites a filesystem — always follows a
  // deliberate second click on a volume already known to be damaged.
  function repairVolume(volume) {
    if (!volume) return "unknown volume"
    if (busy) return refuse("Another action is still running")
    if (!Model.canRepair(fsCapabilities, volume)) {
      return refuse(describeFs(volume) + " cannot be repaired here")
    }
    if (!Model.repairAuthorised(
          { fsPath: checkedFsPath, uuid: checkedUuid, verdict: checkVerdict }, volume)) {
      return refuse("Check this filesystem before repairing it")
    }
    var blocked = fsActionBlocked(volume)
    if (blocked !== "") return refuse(blocked)
    runFsAction(volume, "Repair", "", "repair", "")
    return "ok"
  }

  // Same bargain as the gvfs hint: a plugin may not install anything, so it
  // names the package udisks went looking for and opens Omarchy's installer.
  function installCheckTools(volume) {
    var hint = Model.checkHint(fsCapabilities, volume)
    if (!hint || hint.packages === "") return
    _capsSignature = ""
    Quickshell.execDetached(["omarchy-install-app", hint.label, hint.packages])
  }

  // Check exits 0 whether or not it liked what it found, so the verdict is on
  // stdout rather than in the exit code, and a filesystem that failed its
  // check is a result to report rather than an error to raise.
  function applyVerdict(action, fsPath) {
    var volume = volumeByPath(fsPath)
    var verdict = Model.parseFsVerdict(_stdout)
    var name = volume ? volume.title : "A drive"

    if (action === "check") {
      checkVerdict = verdict
      checkedFsPath = fsPath
      checkedUuid = volume ? volume.uuid : ""
      actionStatus = Model.describeCheck(volume, verdict)
      if (verdict === false) {
        notify("Filesystem errors found", name + " did not pass its check.",
               Model.GLYPH_ALERT, "normal")
      }
      return
    }

    checkVerdict = null
    checkedFsPath = ""
    checkedUuid = ""
    actionStatus = Model.describeRepair(volume, verdict)
    // Three outcomes, not two: the tool can also finish without saying whether
    // it fixed anything, and reporting that as a failed repair would be as
    // wrong as reporting it as a clean one.
    var repaired = verdict === true
    notify(repaired ? "Repaired" : "Repair did not finish cleanly",
           actionStatus,
           repaired ? Model.GLYPH_HEALTHY : Model.GLYPH_ALERT,
           repaired ? "" : "normal")
  }

  // ------------------------------------------------------- drive health
  //
  // smartctl is the reflex and it is the wrong tool: it wants root for most
  // devices, and smartmontools is not standard on Omarchy, so reaching for it
  // would break both "nothing runs as root" and "no extra packages". udisks
  // already does the privileged read and publishes the answer over the bus on
  // the same allow_active path mounting takes.
  //
  // Most drives will answer with nothing. Only an external SSD or a hard drive
  // behind a SAT-capable bridge reports health at all; a USB thumb drive
  // carries neither interface, and that silence is the normal answer rather
  // than something to explain.

  // Both interfaces are asked of every drive and the absent one simply answers
  // nothing, which costs less than asking udisks which of the two a drive has
  // and then asking again.
  //
  // The object path is resolved rather than built, the same way fsScript does
  // it — and health lives on the drive object rather than the block one, so it
  // takes the second lookup to get there.
  //
  // Reading the properties does not refresh them. udisks hands back whatever
  // its own last poll cached, which measured ten minutes stale here: the bus
  // said 308 K while every hwmon sensor on the same drive said 36.85 °C, a gap
  // of two degrees that is staleness rather than arithmetic. So SmartUpdate is
  // called first. It is `allow_active: yes` in the udisks policy — the same
  // no-password path everything else here takes — under
  // org.freedesktop.udisks2.ata-smart-update and its nvme twin.
  //
  // Best-effort, and deliberately not `|| continue`: a drive that refuses an
  // update is still read, because a stale number beats no number. `nowakeup`
  // goes to ATA, which is the interface that takes it, so a parked external
  // disk is not spun up merely to draw a temperature. An NVMe has no heads to
  // park and takes no such option.
  readonly property string smartScript: [
    'set -u',
    'for dev; do',
    '  echo "==> $dev <=="',
    '  raw=$(busctl --timeout=20 call org.freedesktop.UDisks2 /org/freedesktop/UDisks2/Manager' +
      ' org.freedesktop.UDisks2.Manager ResolveDevice "a{sv}a{sv}" 1 path s "$dev" 0 2>/dev/null) || continue',
    '  obj=/${raw#*/}',
    '  obj=${obj%?}',
    '  case "$obj" in /org/freedesktop/UDisks2/block_devices/*) ;; *) continue ;; esac',
    '  raw=$(busctl --timeout=20 get-property org.freedesktop.UDisks2 "$obj"' +
      ' org.freedesktop.UDisks2.Block Drive 2>/dev/null) || continue',
    '  drive=/${raw#*/}',
    '  drive=${drive%?}',
    '  case "$drive" in /org/freedesktop/UDisks2/drives/*) ;; *) continue ;; esac',
    '  busctl --timeout=30 call org.freedesktop.UDisks2 "$drive"' +
      ' org.freedesktop.UDisks2.Drive.Ata SmartUpdate "a{sv}" 1 nowakeup b true' +
      ' >/dev/null 2>&1 || true',
    '  for p in SmartFailing SmartTemperature SmartPowerOnSeconds SmartNumBadSectors' +
      ' SmartSelftestStatus SmartUpdated; do',
    '    v=$(busctl --timeout=20 get-property org.freedesktop.UDisks2 "$drive"' +
      ' org.freedesktop.UDisks2.Drive.Ata "$p" 2>/dev/null) || continue',
    '    echo "$p $v"',
    '  done',
    '  busctl --timeout=30 call org.freedesktop.UDisks2 "$drive"' +
      ' org.freedesktop.UDisks2.NVMe.Controller SmartUpdate "a{sv}" 0 >/dev/null 2>&1 || true',
    '  for p in SmartCriticalWarning SmartTemperature SmartPowerOnHours' +
      ' SmartSelftestStatus SmartUpdated; do',
    '    v=$(busctl --timeout=20 get-property org.freedesktop.UDisks2 "$drive"' +
      ' org.freedesktop.UDisks2.NVMe.Controller "$p" 2>/dev/null) || continue',
    '    echo "$p $v"',
    '  done',
    'done'
  ].join("\n")

  // Read once when the set of attached drives changes, and on an explicit
  // rescan. Never on the free-space timer: refreshing it is a round trip to
  // the drive itself, and every answer but the temperature changes over hours
  // rather than seconds. The temperature is therefore a snapshot from the last
  // read, which is what the health icon re-reads on a click.
  function probeSmart() {
    if (smartProcess.running) return
    var paths = []
    for (var i = 0; i < devices.length; i++) paths.push(devices[i].path)
    paths.sort()
    var signature = paths.join(",")
    if (signature === _smartSignature) return
    _smartSignature = signature
    if (paths.length === 0) {
      smart = ({})
      return
    }
    var command = ["bash", "-c", smartScript, "removable-drives"]
    for (var p = 0; p < paths.length; p++) command.push(paths[p])
    smartProcess.command = command
    smartProcess.running = true
  }

  function smartFor(device) {
    if (!device) return null
    return smart[device.path] || null
  }

  function smartVerdictFor(device) {
    return Model.smartVerdict(smartFor(device))
  }

  function smartHintFor(device) {
    return Model.smartHint(smartFor(device))
  }

  // Folded into `status` the way a check's verdict is, keyed by device path so
  // a script with two drives attached can tell which one it is reading.
  function healthReport() {
    var out = {}
    for (var i = 0; i < devices.length; i++) {
      out[devices[i].path] = Model.smartVerdict(smartFor(devices[i]))
    }
    return out
  }

  // ------------------------------------------------ phones and cameras

  function refreshPortables() {
    if (gioProcess.running) return
    gioProcess.running = true
    if (!supportProcess.running) supportProcess.running = true
  }

  // A plugin cannot install anything itself, so this opens Omarchy's own
  // installer in a floating terminal and lets the user decide there.
  function installSupport() {
    var hint = supportHint
    if (!hint) return
    Quickshell.execDetached(["omarchy-install-app", hint.label, hint.packages])
    // Installing usbmuxd does not start it: its udev rule fires when an Apple
    // device is plugged in, so a phone that was already connected when the
    // packages landed leaves AFC silently unavailable. The install terminal
    // says "Done" and the panel would otherwise still show nothing, with no
    // hint that the cable is the last step.
    actionStatus = hint.reconnect
      ? "Once the install finishes, unplug the device and plug it back in"
      : "Reconnect the device once the install finishes"
  }

  function mountPortable(entry) {
    if (!entry || entry.uri === "" || busy) return
    runAction(["gio", "mount", entry.uri], entry.uri, "mount-portable", "Mounted " + entry.name)
  }

  function unmountPortable(entry) {
    if (!entry || entry.uri === "" || busy) return
    runAction(["gio", "mount", "-u", entry.uri], entry.uri, "unmount-portable", "Unmounted " + entry.name)
  }

  function togglePortable(entry) {
    if (!entry) return
    if (entry.mounted) unmountPortable(entry)
    else mountPortable(entry)
  }

  // Not xdg-open: nothing registers an x-scheme-handler for gphoto2://,
  // afc:// or mtp://, so xdg-open exits 0 and silently does nothing. gio
  // resolves the URI through GIO itself, which also mounts the device on
  // demand — so browsing works whether or not it is mounted yet.
  function openPortable(entry) {
    if (!entry || entry.uri === "") return
    var command = String(setting("fileManager", "")).replace(/^\s+|\s+$/g, "")
    if (command !== "") {
      Quickshell.execDetached(["bash", "-c", command + " " + quote(entry.uri)])
      return
    }
    Quickshell.execDetached(["gio", "open", entry.uri])
  }

  // ------------------------------------------------------ small actions

  function copyPath(volume) {
    if (!volume || !volume.mounted) return
    Quickshell.execDetached(["bash", "-c", 'printf %s "$1" | wl-copy', "removable-drives", volume.mountpoint])
    actionStatus = "Copied " + volume.mountpoint
  }

  // Device names reach the notification surface too, and that surface is not
  // ours to pin: Omarchy renders the body as Text.StyledText and the summary
  // with the default AutoText, stripping <img> from the body only. A drive
  // label is chosen by whoever formatted the stick, so it is sanitised here —
  // at the one point every notification passes through — rather than trusting
  // whichever daemon draws it.
  function notify(headline, description, glyph, urgency) {
    if (!notificationsEnabled) return
    var command = ["omarchy-notification-send", "-g", glyph]
    if (urgency) command.push("-u", urgency)
    command.push(Model.plain(headline))
    if (description && description !== "") command.push(Model.plain(description))
    Quickshell.execDetached(command)
  }

  // udisks reports a busy filesystem without saying what is holding it. fuser
  // knows, and ps turns its pids into names a person can act on.
  function probeBlockers(mountpoints) {
    if (mountpoints.length === 0 || blockersProcess.running) return
    var script = 'pids=$(fuser -m "$@" 2>/dev/null); [ -n "$pids" ] && ps -o pid=,comm= -p $pids || true'
    var command = ["bash", "-c", script, "removable-drives"]
    for (var i = 0; i < mountpoints.length; i++) command.push(mountpoints[i])
    blockersProcess.command = command
    blockersProcess.running = true
  }

  function mountedPathsFor(path) {
    var out = []
    var list = path === "*" ? devices : (deviceByPath(path) ? [deviceByPath(path)] : [])
    if (list.length === 0) {
      var volume = volumeByPath(path)
      if (volume && volume.mounted) {
        blockedFsPath = volume.fsPath
        return [volume.mountpoint]
      }
      return out
    }
    for (var d = 0; d < list.length; d++) {
      for (var v = 0; v < list[d].volumes.length; v++) {
        if (list[d].volumes[v].mounted) {
          if (blockedFsPath === "") blockedFsPath = list[d].volumes[v].fsPath
          out.push(list[d].volumes[v].mountpoint)
        }
      }
    }
    return out
  }

  // ----------------------------------------------------------- processes

  Process {
    id: lsblkProcess
    command: ["lsblk", "-J", "-b", "-o",
              "NAME,PATH,LABEL,PARTLABEL,FSTYPE,SIZE,FSSIZE,FSAVAIL,FSUSED,MOUNTPOINT,RM,HOTPLUG,TYPE,TRAN,VENDOR,MODEL,UUID,SERIAL"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applySnapshot(text)
    }
    onExited: function(exitCode) {
      root.refreshing = false
      if (exitCode !== 0) root.lastError = "lsblk exited with " + exitCode
    }
  }

  Process {
    id: statsProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyStats(text)
    }
  }

  Process {
    id: hooksProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyHooks(text)
    }
  }

  Process {
    id: smartProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.smart = Model.parseSmartReport(text)
    }
  }

  Process {
    id: blockersProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.blockers = Model.parseBlockers(text)
    }
  }

  Process {
    id: actionProcess
    // Only the unlock script ever reads stdin; for everything else the pipe is
    // opened and never written, which no command here notices.
    stdinEnabled: true
    onStarted: {
      if (root._secret !== "") {
        write(root._secret + "\n")
        root._secret = ""
      }
    }
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._stdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root._stderr = text }
    onExited: function(exitCode) {
      var action = root.busyAction
      var path = root.busyPath
      root.busyPath = ""
      root.busyAction = ""

      // The work itself landed either way; the remount is what separates these.
      // A filesystem that was renamed and then failed to mount back is still
      // renamed, so the verdict and the success message stand — but the drive
      // is gone from the file manager, and that is the part worth shouting.
      if (exitCode === 0 || exitCode === Model.EXIT_REMOUNT_FAILED) {
        root.actionStatus = root._successMessage
        if (action === "eject") {
          root.notify("Safe to remove",
                      root._successMessage.replace(/^Safe to remove /, ""),
                      Model.GLYPH_EJECT)
        }
        if (action === "check" || action === "repair") root.applyVerdict(action, path)
        if (exitCode === Model.EXIT_REMOUNT_FAILED) {
          root.lastError = Model.remountWarning(root.actionStatus)
          root.actionStatus = ""
          root.notify("Left unmounted", root.lastError, Model.GLYPH_ALERT, "normal")
        }
      } else {
        root._openAfterPath = ""
        var detail = Model.formatError(root._stderr)
        root.lastError = detail !== "" ? detail : (action + " failed")
        // "Target is busy" is only half an answer; go find the other half.
        if (/busy/i.test(root.lastError)) {
          root.blockedFsPath = ""
          root.probeBlockers(root.mountedPathsFor(path))
        }
        root.notify("Removable drives", root.lastError, Model.GLYPH_ALERT, "normal")
      }
      root.refresh()
      // A phone mount changes gvfs state, which lsblk knows nothing about.
      if (action === "mount-portable" || action === "unmount-portable") root.refreshPortables()
      if (root.watchClosely) root.probeTrash()
    }
  }

  Process {
    id: gioProcess
    command: ["gio", "mount", "-li"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.portables = Model.parseGioMounts(text)
    }
  }

  // One probe for both questions: which backends gvfs advertises, and what is
  // on the USB bus. Root hubs (1d6b) are skipped; everything else reports its
  // vendor and every interface class it exposes.
  Process {
    id: supportProcess
    command: ["bash", "-c", 'for f in /usr/share/gvfs/mounts/*.mount; do [ -e "$f" ] || continue; n=$(basename "$f" .mount); echo "backend $n"; done; for d in /sys/bus/usb/devices/*/; do [ -r "$d/idVendor" ] || continue; v=$(cat "$d/idVendor" 2>/dev/null); [ "$v" = "1d6b" ] && continue; cls=""; for i in "$d"*:*/bInterfaceClass; do [ -r "$i" ] && cls="$cls,$(cat "$i" 2>/dev/null)"; done; echo "usb $v$cls $(cat "$d/product" 2>/dev/null)"; done']
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.support = Model.parseSupport(text)
    }
  }

  Process {
    id: suspendWriter
  }

  Process {
    id: suspendGuard
    command: ["bash", "-c", root.suspendScript, "removable-drives",
              root.suspendTargetsPath, root.suspendTargetsPath + ".guard",
              root.notificationsEnabled ? "1" : "0", Model.GLYPH_ALERT]
    running: root.unmountOnSuspend
  }

  Process {
    id: mountsProcess
    command: ["cat", "/proc/mounts"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.mountFlags = Model.parseMountFlags(text)
    }
  }

  Process {
    id: capsProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.fsCapabilities = Model.parseFsCapabilities(text)
    }
  }

  Process {
    id: trashProcess
    // Most candidates do not exist; du complains about those on stderr and
    // still reports the ones that do, so a non-zero exit is expected here.
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.trashSizes = Model.parseSizes(text)
    }
  }

  Process {
    id: storeWriter
  }

  Process {
    id: uidProcess
    command: ["id", "-u"]
    running: true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.uid = String(text).replace(/\s+/g, "")
    }
  }

  // The saved nicknames and hooks. Watched rather than read once, so editing
  // the file by hand takes effect without restarting the shell.
  FileView {
    id: storeFile
    path: root.storePath
    watchChanges: true
    printErrors: false
    onLoaded: root.store = Model.parseStore(text())
    onFileChanged: reload()
    onLoadFailed: root.store = ({ version: 1, drives: {} })
  }

  // udev tells us the moment a device appears or disappears, which is the
  // difference between a widget that reacts and one that polls. stdbuf keeps
  // udevadm line-buffered — piped, it would otherwise sit on a 4KB buffer and
  // deliver the first event minutes late.
  Process {
    id: monitorProcess
    command: ["stdbuf", "-oL", "udevadm", "monitor", "--udev", "--subsystem-match=block", "--subsystem-match=usb"]
    running: true
    stdout: SplitParser {
      onRead: function(line) {
        if (/(add|remove|change|bind|unbind)/.test(String(line))) debounce.restart()
      }
    }
    onExited: monitorRestart.restart()
  }

  // A burst of udev lines arrives for every partition on a stick; settle
  // before asking lsblk, so plugging in a 4-partition drive costs one call.
  Timer {
    id: debounce
    interval: 350
    onTriggered: {
      root.refresh()
      root.refreshPortables()
      // gvfs auto-mounts a phone a beat after udev announces it, so the
      // first listing catches it unmounted. Look again once it has settled.
      settleTimer.restart()
    }
  }

  Timer {
    id: settleTimer
    interval: 2500
    onTriggered: root.refreshPortables()
  }

  Timer {
    id: monitorRestart
    interval: 3000
    onTriggered: if (!monitorProcess.running) monitorProcess.running = true
  }

  // I/O counters are only sampled while something removable is attached, so
  // the widget costs nothing on a machine with no drive plugged in. A hook is
  // read on the same tick, and only for a drive that has one still working.
  Timer {
    interval: 1000
    running: root.devices.length > 0
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      root.sampleActivity()
      root.sampleHooks()
    }
  }

  // Free space drifts while a copy runs; only worth watching while the panel
  // is on screen.
  Timer {
    interval: Math.max(2, root.intSetting("refreshIntervalSec", 8, 2, 300)) * 1000
    running: root.watchClosely
    repeat: true
    onTriggered: {
      root.refresh()
      root.refreshPortables()
    }
  }

  // Backstop for a machine where udevadm is unavailable or its stream dies
  // quietly: never more than a minute stale.
  Timer {
    interval: 60000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  onWatchCloselyChanged: if (watchClosely) {
    refreshPortables()
    probeTrash()
  }

  Component.onCompleted: {
    refresh()
    refreshPortables()
  }
}
