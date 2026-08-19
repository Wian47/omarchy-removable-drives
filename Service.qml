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

  // Bytes sitting in each mounted volume's trash, keyed by trash directory.
  property var trashSizes: ({})
  property string uid: ""

  readonly property bool busy: actionProcess.running
  readonly property int deviceCount: devices.length
  readonly property int mountedCount: {
    var total = 0
    for (var i = 0; i < devices.length; i++) total += devices[i].mountedCount
    return total
  }

  // True while any attached drive still has I/O in flight — the state in which
  // pulling the drive is what loses data.
  readonly property bool anyBusy: {
    for (var i = 0; i < devices.length; i++) {
      var entry = activity[devices[i].name]
      if (entry && entry.busy) return true
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

  property string _successMessage: ""
  property string _stdout: ""
  property string _stderr: ""
  property string _openAfterPath: ""
  property var _statSamples: ({})
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

  function quote(value) {
    return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
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

  function isDeviceBusy(device) {
    var entry = activityFor(device)
    return !!(entry && entry.busy)
  }

  function activityLabelFor(device) {
    return Model.activityLabel(activityFor(device))
  }

  // ------------------------------------------------------------- reading

  function refresh() {
    if (lsblkProcess.running) return
    refreshing = true
    lsblkProcess.running = true
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

  function runAction(command, path, action, successMessage) {
    if (actionProcess.running) return
    lastError = ""
    actionStatus = ""
    blockers = []
    blockedFsPath = ""
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

  // Unlocking needs a passphrase, and a bar popup is the wrong place to
  // collect one — hand it to udisksctl in a terminal, which already knows how
  // to prompt safely, and let the udev watcher pick up the result.
  function unlock(volume) {
    if (!volume || !volume.encrypted || volume.unlocked) return
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
                             "udisksctl unlock -b " + quote(volume.path)])
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

  // A user-authored command run when a specific drive appears — a backup, a
  // sync, an import. It is never inferred and never suggested; it only runs
  // if someone put it in the state file for that drive themselves.
  function runConnectHook(device) {
    var command = String(driveSetting(device, "onConnect", "")).replace(/^\s+|\s+$/g, "")
    if (command === "") return
    Quickshell.execDetached(["bash", "-c", command, "removable-drives", device.path, mountpointOf(device)])
  }

  function mountpointOf(device) {
    if (!device) return ""
    for (var i = 0; i < device.volumes.length; i++) {
      if (device.volumes[i].mounted) return device.volumes[i].mountpoint
    }
    return ""
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

  function notify(headline, description, glyph, urgency) {
    if (!notificationsEnabled) return
    var command = ["omarchy-notification-send", "-g", glyph]
    if (urgency) command.push("-u", urgency)
    command.push(headline)
    if (description && description !== "") command.push(description)
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
    id: blockersProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.blockers = Model.parseBlockers(text)
    }
  }

  Process {
    id: actionProcess
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._stdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root._stderr = text }
    onExited: function(exitCode) {
      var action = root.busyAction
      var path = root.busyPath
      root.busyPath = ""
      root.busyAction = ""

      if (exitCode === 0) {
        root.actionStatus = root._successMessage
        if (action === "eject") {
          root.notify("Safe to remove",
                      root._successMessage.replace(/^Safe to remove /, ""),
                      Model.GLYPH_EJECT)
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
  // the widget costs nothing on a machine with no drive plugged in.
  Timer {
    interval: 1000
    running: root.devices.length > 0
    repeat: true
    triggeredOnStart: true
    onTriggered: root.sampleActivity()
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
