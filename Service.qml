import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Owns everything that talks to the system: the lsblk snapshot, the udev
// event stream that makes the snapshot current, and the udisksctl calls that
// mount, unmount, and power off a drive.
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

  // The panel sets this while it is open, so free space stays current while
  // someone is looking at it and costs nothing while they are not.
  property bool watchClosely: false

  // Path of the device or volume an action is running against, so exactly one
  // row can show a spinner instead of the whole panel greying out.
  property string busyPath: ""
  property string busyAction: ""

  property string lastError: ""
  property string actionStatus: ""

  readonly property bool busy: actionProcess.running
  readonly property int deviceCount: devices.length
  readonly property int mountedCount: {
    var total = 0
    for (var i = 0; i < devices.length; i++) total += devices[i].mountedCount
    return total
  }

  property string _successMessage: ""
  property string _stdout: ""
  property string _stderr: ""
  property string _openAfterPath: ""

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

  // ------------------------------------------------------------- reading

  function refresh() {
    if (lsblkProcess.running) return
    refreshing = true
    lsblkProcess.running = true
  }

  function applySnapshot(raw) {
    try {
      devices = Model.parse(raw)
      loaded = true
    } catch (e) {
      lastError = "Could not read the block device list"
    }
    refreshing = false

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

  // ------------------------------------------------------------- actions

  function runAction(command, path, action, successMessage) {
    if (actionProcess.running) return
    lastError = ""
    actionStatus = ""
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

  function unmount(volume) {
    if (!volume || !volume.mounted || busy) return
    _openAfterPath = ""
    runAction(["udisksctl", "unmount", "--no-user-interaction", "-b", volume.fsPath],
              volume.fsPath, "unmount", "Unmounted " + volume.title)
  }

  function toggleMount(volume, openAfter) {
    if (!volume) return
    if (volume.mounted) unmount(volume)
    else if (volume.encrypted && !volume.unlocked) unlock(volume)
    else mount(volume, openAfter)
  }

  // Unlocking needs a passphrase, and a bar popup is the wrong place to
  // collect one — hand it to udisksctl in a terminal, which already knows how
  // to prompt safely, and let the udev watcher pick up the result.
  function unlock(volume) {
    if (!volume || !volume.encrypted || volume.unlocked) return
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
                             "udisksctl unlock -b " + quote(volume.path)])
  }

  // Unmount everything on the device, re-lock anything that was unlocked,
  // then cut power to it. `set -e` stops at the first failure so a busy
  // filesystem surfaces as an error instead of a half-ejected drive, and
  // power-off is allowed to fail on hubs and card readers that don't
  // implement it — by then the drive is already safe to pull.
  function eject(device) {
    if (!device || busy) return
    _openAfterPath = ""
    var script = "set -e\n"
    for (var i = 0; i < device.volumes.length; i++) {
      var volume = device.volumes[i]
      if (volume.mounted) script += "udisksctl unmount --no-user-interaction -b " + quote(volume.fsPath) + "\n"
      if (volume.encrypted && volume.unlocked) script += "udisksctl lock --no-user-interaction -b " + quote(volume.path) + "\n"
    }
    script += "udisksctl power-off --no-user-interaction -b " + quote(device.path) + " || true\n"
    runAction(["bash", "-c", script], device.path, "eject", "Safe to remove " + device.title)
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

  function notify(headline, description, glyph) {
    Quickshell.execDetached(["omarchy-notification-send", "-g", glyph, headline, description])
  }

  // ----------------------------------------------------------- processes

  Process {
    id: lsblkProcess
    command: ["lsblk", "-J", "-b", "-o",
              "NAME,PATH,LABEL,PARTLABEL,FSTYPE,SIZE,FSSIZE,FSAVAIL,FSUSED,MOUNTPOINT,RM,HOTPLUG,TYPE,TRAN,VENDOR,MODEL"]
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
    id: actionProcess
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._stdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root._stderr = text }
    onExited: function(exitCode) {
      var action = root.busyAction
      root.busyPath = ""
      root.busyAction = ""
      if (exitCode === 0) {
        root.actionStatus = root._successMessage
        if (action === "eject") root.notify("Safe to remove", root._successMessage.replace(/^Safe to remove /, ""), Model.GLYPH_EJECT)
      } else {
        root._openAfterPath = ""
        var detail = Model.formatError(root._stderr)
        root.lastError = detail !== "" ? detail : (action + " failed")
        root.notify("Removable drives", root.lastError, Model.GLYPH_ALERT)
      }
      root.refresh()
    }
  }

  // udev tells us the moment a device appears or disappears, which is the
  // difference between a widget that reacts and one that polls. stdbuf keeps
  // udevadm line-buffered — piped, it would otherwise sit on a 4KB buffer and
  // deliver the first event minutes late.
  Process {
    id: monitorProcess
    command: ["stdbuf", "-oL", "udevadm", "monitor", "--udev", "--subsystem-match=block"]
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
    onTriggered: root.refresh()
  }

  Timer {
    id: monitorRestart
    interval: 3000
    onTriggered: if (!monitorProcess.running) monitorProcess.running = true
  }

  // Free space drifts while a copy runs; only worth watching while the panel
  // is on screen.
  Timer {
    interval: Math.max(2, root.intSetting("refreshIntervalSec", 8, 2, 300)) * 1000
    running: root.watchClosely
    repeat: true
    onTriggered: root.refresh()
  }

  // Backstop for a machine where udevadm is unavailable or its stream dies
  // quietly: never more than a minute stale.
  Timer {
    interval: 60000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  Component.onCompleted: refresh()
}
