import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar icon plus popup for USB sticks, SD cards, and external drives.
//
// The widget hides itself when nothing removable is attached, so the bar only
// grows a drive icon at the moment a drive exists — the same way the update
// indicator only appears when there is an update.
Panel {
  id: root

  moduleName: "wian47.removable-drives"
  ipcTarget: "removable-drives"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool alwaysShow: setting("alwaysShow", false) === true
  readonly property bool openOnMount: setting("openOnMount", true) === true

  // "none" | "free" | "name" | "count". A vertical bar is 28px wide, so a
  // label has nowhere to go there and the icon stands alone regardless.
  // Ui.Panel is not Ui.BarWidget, so bar geometry is read off the host.
  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: bar ? bar.barSize : Style.bar.sizeHorizontal
  readonly property string labelMode: vertical ? "none" : String(setting("barLabel", "none"))
  readonly property string barLabel: Model.barLabelText(devices, labelMode)
  readonly property string barTooltip: drives.anyBusy
    ? (Model.formatRate(drives.totalWriteRate) !== ""
        ? "Writing " + Model.formatRate(drives.totalWriteRate) + " — do not remove"
        : "Busy — do not remove")
    : Model.summary(devices)

  // Key of the drive whose name is being edited inline, "" when none is.
  property string renamingKey: ""

  // fsPath of the volume whose filesystem label is being edited, "" when none
  // is. Separate from renamingKey because they name different things: the
  // nickname above is this shell's private name for the hardware, while the
  // label is written to the filesystem and travels with it to every other
  // machine that reads the drive.
  property string renamingLabelPath: ""

  readonly property var devices: drives.devices
  readonly property var rows: Model.navRows(drives.devices, drives.portables)
  property int cursor: 0
  property bool cursorActive: false
  property Item cursorItem: null

  readonly property var currentRow: rows.length > 0
    ? rows[Math.max(0, Math.min(cursor, rows.length - 1))]
    : null

  function currentDevice() {
    if (!currentRow) return null
    return devices[currentRow.device] || null
  }

  function currentPortable() {
    if (!currentRow || currentRow.kind !== "portable") return null
    return drives.portables[currentRow.portable] || null
  }

  function currentVolume() {
    if (!currentRow || currentRow.kind !== "volume") return null
    var device = devices[currentRow.device]
    return device ? (device.volumes[currentRow.volume] || null) : null
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    if (dy === 0 || rows.length === 0) return
    cursor = Math.max(0, Math.min(rows.length - 1, cursor + dy))
    scrollCursorIntoView()
  }

  function setCursor(index) {
    cursorActive = true
    cursor = Math.max(0, Math.min(Math.max(0, rows.length - 1), index))
  }

  // The cursor addresses a position in a list that changes underneath it —
  // pull a stick and every row below it shifts up. Clamping on every refresh
  // keeps the highlight on a real row instead of past the end.
  function clampCursor() {
    if (rows.length === 0) {
      cursor = 0
      return
    }
    if (cursor > rows.length - 1) cursor = rows.length - 1
  }

  function rowIndexOfDevice(deviceIndex) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind === "device" && rows[i].device === deviceIndex) return i
    }
    return 0
  }

  function rowIndexOfVolume(deviceIndex, volumeIndex) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind === "volume" && rows[i].device === deviceIndex && rows[i].volume === volumeIndex) return i
    }
    return 0
  }

  function activateCursor() {
    if (!currentRow) return
    if (currentRow.kind === "device") drives.eject(currentDevice())
    else if (currentRow.kind === "portable") activatePortable(currentPortable())
    else activateVolume(currentVolume())
  }

  // Opening covers mounting, so a click always lands somewhere useful.
  function activatePortable(entry) {
    if (!entry) return
    drives.openPortable(entry)
  }

  function rowIndexOfPortable(portableIndex) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind === "portable" && rows[i].portable === portableIndex) return i
    }
    return 0
  }

  function handleBarPress(buttonCode) {
    if (buttonCode === Qt.RightButton) {
      drives.refresh()
    } else if (buttonCode === Qt.MiddleButton) {
      var mounted = Model.mountedVolumes(devices)
      if (mounted.length > 0) drives.openVolume(mounted[0])
    } else {
      toggle()
    }
  }

  function beginRename(device) {
    if (!device) return
    renamingKey = device.key
  }

  // Closing the editor has to hand the keyboard back, or the key catcher stays
  // blocked and j/k type into a field that is no longer visible.
  function finishRename() {
    renamingKey = ""
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function beginLabelEdit(volume) {
    if (!volume || !Model.canRelabel(volume)) return
    renamingKey = ""
    renamingLabelPath = volume.fsPath
  }

  function finishLabelEdit() {
    renamingLabelPath = ""
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // One click does the obvious thing: an unmounted volume mounts (and opens,
  // unless the user turned that off), a mounted one opens its folder.
  // Unmounting stays on its own button so it is never a stray click away.
  function activateVolume(volume) {
    if (!volume) return
    if (volume.mounted) drives.openVolume(volume)
    else if (volume.encrypted && !volume.unlocked) drives.unlock(volume)
    else drives.mount(volume, openOnMount)
  }

  function ejectCurrent() {
    var device = currentDevice()
    if (device) drives.eject(device)
  }

  function scrollItemIntoView(item) {
    if (!panelFlick || !item) return
    Qt.callLater(function() {
      if (!item || !panelFlick) return
      var margin = Style.space(6)
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  function scrollCursorIntoView() {
    Qt.callLater(function() { scrollItemIntoView(root.cursorItem) })
  }

  visible: devices.length > 0 || drives.portables.length > 0 || drives.supportHint !== null || alwaysShow
  implicitWidth: button.item ? button.item.implicitWidth : 0
  implicitHeight: button.item ? button.item.implicitHeight : barSize

  onVisibleChanged: if (!visible && opened) close()
  onRowsChanged: {
    clampCursor()
    var i
    if (renamingKey !== "") {
      var stillHere = false
      for (i = 0; i < devices.length; i++) {
        if (devices[i].key === renamingKey) stillHere = true
      }
      if (!stillHere) renamingKey = ""
    }
    // A relabel unmounts and remounts, so the volume this editor belongs to
    // comes and goes underneath it; it is the fsPath that has to still exist,
    // not the mount.
    if (renamingLabelPath !== "") {
      var volumeHere = false
      for (i = 0; i < devices.length; i++) {
        for (var v = 0; v < devices[i].volumes.length; v++) {
          if (devices[i].volumes[v].fsPath === renamingLabelPath) volumeHere = true
        }
      }
      if (!volumeHere) renamingLabelPath = ""
    }
  }
  onOpenedChanged: {
    drives.watchClosely = opened
    renamingKey = ""
    renamingLabelPath = ""
    if (opened) {
      cursorActive = false
      cursor = 0
      if (panelFlick) panelFlick.contentY = 0
      drives.refresh()
      // Phones are not block devices, so nothing about mounting one reaches
      // udev — and udev is the only thing that would otherwise re-list them.
      // A phone mounted or dropped while the panel was shut stayed stale on
      // screen until something unrelated happened to trigger a probe.
      drives.refreshPortables()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    }
  }

  Service {
    id: drives
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { drives.refresh(); return "ok" }
    function list(): string { return JSON.stringify(drives.devices) }

    // Eject by device path ("/dev/sdb") so a keybind or script can safely
    // remove a drive without opening the panel. Both eject calls wait for
    // pending writes to finish before cutting power.
    function eject(path: string): string {
      for (var i = 0; i < drives.devices.length; i++) {
        if (drives.devices[i].path === path) {
          drives.eject(drives.devices[i])
          return "ok"
        }
      }
      return "unknown device: " + path
    }

    // Nickname a drive from a script or keybind. An empty name clears it.
    function rename(path: string, nickname: string): string {
      for (var i = 0; i < drives.devices.length; i++) {
        if (drives.devices[i].path === path) {
          drives.setNickname(drives.devices[i], nickname)
          return "ok"
        }
      }
      return "unknown device: " + path
    }

    // Rename the filesystem itself, addressed by the volume's own node
    // ("/dev/sdb1") rather than the drive's. An empty name clears the label.
    // Unlike `rename`, which only this shell ever sees, this writes to the
    // drive and travels with it.
    function label(path: string, name: string): string {
      var volume = drives.volumeByPath(path)
      if (!volume) return "unknown volume: " + path
      return drives.setVolumeLabel(volume, name)
    }

    // Starts the check and returns "ok"; the verdict lands in `status` a
    // moment later, because an fsck takes as long as it takes. Anything else
    // it returns is the reason it did not start at all.
    function check(path: string): string {
      var volume = drives.volumeByPath(path)
      if (!volume) return "unknown volume: " + path
      return drives.checkVolume(volume)
    }

    function phones(): string { return JSON.stringify(drives.portables) }

    function ejectAll(): string {
      if (drives.devices.length === 0) return "no drives attached"
      drives.ejectAll()
      return "ok"
    }

    // "busy" while the kernel still has I/O in flight — a script can poll
    // this before telling someone it is safe to pull the drive.
    function status(): string {
      return JSON.stringify({
        devices: drives.deviceCount,
        mounted: drives.mountedCount,
        busy: drives.anyBusy,
        writeRate: Math.round(drives.totalWriteRate),
        pendingEject: drives.pendingEjectPath,
        working: drives.busy,
        checked: drives.checkedFsPath,
        healthy: drives.checkVerdict
      })
    }
  }

  // Icon-only is the default and uses BarIconButton, whose optical centring
  // lines the glyph up with the rest of the bar. A label needs a text slot
  // that grows with its content, which is WidgetButton's job — so the two
  // modes are two components rather than one widget bent into both shapes.
  Loader {
    id: button
    anchors.fill: parent
    sourceComponent: root.labelMode !== "none" && root.barLabel !== "" ? labelledButton : iconButton
  }

  Component {
    id: iconButton

    BarIconButton {
      anchors.fill: parent
      bar: root.bar
      text: Model.barGlyph(root.devices)
      // The icon turns urgent while the kernel still has I/O in flight. That
      // is the whole warning: if it is lit, the drive is not safe to pull yet.
      tooltipText: root.barTooltip
      active: drives.anyBusy
      onPressed: function(buttonCode) { root.handleBarPress(buttonCode) }
    }
  }

  Component {
    id: labelledButton

    WidgetButton {
      anchors.fill: parent
      bar: root.bar
      text: Model.barGlyph(root.devices) + "  " + root.barLabel
      tooltipText: root.barTooltip
      active: drives.anyBusy
      onPressed: function(buttonCode) { root.handleBarPress(buttonCode) }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While a nickname or a label is being typed, every keystroke belongs to
      // the text field rather than to the cursor.
      blocked: root.renamingKey !== "" || root.renamingLabelPath !== ""

      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) {
          root.cursorActive = true
          return
        }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onDeleteRequested: root.ejectCurrent()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") drives.rescan()
        else if (text === "e") root.ejectCurrent()
        else if (text === "E") drives.ejectAll()
        else if (text === "o" || text === "O") drives.openVolume(root.currentVolume())
        else if (text === "t" || text === "T") drives.openTerminal(root.currentVolume())
        else if (text === "y" || text === "Y") drives.copyPath(root.currentVolume())
        else if (text === "n" || text === "N") root.beginRename(root.currentDevice())
        else if (text === "l" || text === "L") root.beginLabelEdit(root.currentVolume())
        else if (text === "c" || text === "C") drives.checkVolume(root.currentVolume())
        else if (text === "m" || text === "M") {
          if (root.currentRow && root.currentRow.kind === "portable") drives.togglePortable(root.currentPortable())
          else drives.toggleMount(root.currentVolume(), root.openOnMount)
        }
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            id: hero
            width: parent.width
            title: "Removable drives"
            meta: drives.anyBusy
              ? (Model.formatRate(drives.totalWriteRate) !== ""
                  ? "Writing " + Model.formatRate(drives.totalWriteRate) + " — do not remove"
                  : "Busy — do not remove")
              : Model.summary(root.devices)
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: Model.barGlyph(root.devices)
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            trailingControl: Component {
              Row {
                spacing: Style.space(2)

                PanelActionButton {
                  visible: root.devices.length > 1
                  iconText: Model.GLYPH_EJECT
                  tooltipText: "Eject every drive"
                  foreground: root.foreground
                  hoverColor: root.urgent
                  fontFamily: root.fontFamily
                  enabled: !drives.busy
                  onClicked: drives.ejectAll()
                }

                PanelActionButton {
                  iconText: Model.GLYPH_REFRESH
                  tooltipText: "Rescan"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  enabled: !drives.refreshing
                  onClicked: drives.rescan()
                }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: text !== ""
            width: parent.width
            text: drives.lastError !== "" ? drives.lastError : drives.actionStatus
            color: drives.lastError !== "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // udisks says "Target is busy" and stops there. This says who, and
          // offers the lazy unmount as an explicit second choice rather than
          // doing it silently on the user's behalf.
          RowLayout {
            visible: drives.blockers.length > 0
            width: parent.width
            spacing: Style.space(8)

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: "Held by " + Model.describeBlockers(drives.blockers)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }

            PanelActionButton {
              iconText: Model.GLYPH_UNMOUNT
              tooltipText: "Unmount anyway (lazy unmount)"
              foreground: root.foreground
              hoverColor: root.urgent
              fontFamily: root.fontFamily
              enabled: !drives.busy && drives.blockedFsPath !== ""
              Layout.alignment: Qt.AlignVCenter
              onClicked: drives.forceUnmountBlocked()
            }
          }

          // An eject asked for mid-copy is held, not refused; it fires by
          // itself once the drive settles, and can be called off until then.
          RowLayout {
            visible: drives.pendingEjectPath !== ""
            width: parent.width
            spacing: Style.space(8)

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: "Ejecting once writes finish…"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }

            PanelActionButton {
              iconText: Model.GLYPH_ALERT
              tooltipText: "Cancel"
              foreground: root.foreground
              fontFamily: root.fontFamily
              Layout.alignment: Qt.AlignVCenter
              onClicked: drives.cancelPendingEject()
            }
          }

          // A check that found something says so in the status line above; this
          // is the offer to act on it. Repair is the one operation here that
          // rewrites a filesystem, so it is never a click away from anything
          // else — it exists only after a check has been run and only for the
          // volume that check was about.
          RowLayout {
            visible: drives.checkedFsPath !== "" && drives.checkVerdict === false
            width: parent.width
            spacing: Style.space(8)

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: "Repairing rewrites the filesystem. Copy anything you still need off it first."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            PanelActionButton {
              iconText: Model.GLYPH_WRENCH
              tooltipText: "Repair this filesystem"
              foreground: root.foreground
              hoverColor: root.urgent
              fontFamily: root.fontFamily
              enabled: !drives.busy
                && Model.canRepair(drives.fsCapabilities, drives.volumeByPath(drives.checkedFsPath))
              Layout.alignment: Qt.AlignVCenter
              onClicked: drives.repairVolume(drives.volumeByPath(drives.checkedFsPath))
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: root.devices.length === 0
            width: parent.width
            text: drives.loaded ? "Nothing plugged in." : "Looking for drives…"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          Repeater {
            model: root.devices

            Column {
              id: deviceBlock
              required property var modelData
              required property int index

              width: column.width
              spacing: Style.space(4)

              DeviceRow {
                width: parent.width
                device: deviceBlock.modelData
                deviceIndex: deviceBlock.index
              }

              Repeater {
                model: deviceBlock.modelData.volumes

                VolumeRow {
                  required property var modelData
                  required property int index

                  width: deviceBlock.width
                  volume: modelData
                  deviceIndex: deviceBlock.index
                  volumeIndex: index
                }
              }
            }
          }

          // Phones and cameras speak MTP rather than being block devices, so
          // they get their own section instead of being pushed into a list
          // that talks about partitions and free space.
          Column {
            visible: drives.portables.length > 0 || drives.supportHint !== null
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { foreground: root.foreground }

            PanelSectionHeader {
              text: "PHONES & CAMERAS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            // Something is plugged in that gvfs has no backend for. A plugin
            // cannot install packages — only Omarchy's own installer may —
            // so this explains the gap and opens that installer rather than
            // leaving the section mysteriously empty.
            RowLayout {
              visible: drives.supportHint !== null
              width: parent.width
              spacing: Style.space(8)

              Text {
                textFormat: Text.PlainText
                text: Model.GLYPH_ALERT
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.icon
                Layout.alignment: Qt.AlignVCenter
              }

              ColumnLayout {
                Layout.fillWidth: true
                spacing: Style.space(1)

                Text {
                  textFormat: Text.PlainText
                  Layout.fillWidth: true
                  text: drives.supportHint ? drives.supportHint.text : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }

                Text {
                  textFormat: Text.PlainText
                  Layout.fillWidth: true
                  text: drives.supportHint ? "Installs " + drives.supportHint.detail : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              PanelActionButton {
                iconText: Model.GLYPH_MOUNT
                tooltipText: "Open Omarchy's installer for these packages"
                foreground: root.foreground
                fontFamily: root.fontFamily
                Layout.alignment: Qt.AlignVCenter
                onClicked: drives.installSupport()
              }
            }

            Repeater {
              model: drives.portables

              PortableRow {
                required property var modelData
                required property int index

                width: parent.width
                entry: modelData
                portableIndex: index
              }
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ row types

  component DeviceRow: CursorSurface {
    id: deviceRow

    property var device: null
    property int deviceIndex: 0

    readonly property bool selected: root.cursorActive && root.currentRow
      && root.currentRow.kind === "device" && root.currentRow.device === deviceIndex
    readonly property string activity: device ? drives.activityLabelFor(device) : ""
    readonly property bool renaming: device && device.key !== "" && root.renamingKey === device.key
    readonly property bool ejectPending: device
      && (drives.pendingEjectPath === device.path || drives.pendingEjectPath === "*")

    hasCursor: selected
    foreground: root.foreground
    implicitHeight: deviceContent.implicitHeight + Style.spacing.rowPaddingX

    onSelectedChanged: if (selected) root.cursorItem = deviceRow

    // Both call back to the panel rather than to a sibling function or to
    // keyCatcher directly: inside an inline component those names do not
    // resolve, and the failure is silent enough to leave the editor stuck
    // open with the key catcher still blocked. root.* is proven to resolve
    // from these rows — setCursor is called the same way below.
    function commitRename(value) {
      drives.setNickname(device, value)
      root.finishRename()
    }

    function cancelRename() { root.finishRename() }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.NoButton
      onEntered: root.setCursor(root.rowIndexOfDevice(deviceRow.deviceIndex))
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: deviceRow.device ? deviceRow.device.glyph : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: deviceContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          visible: !deviceRow.renaming
          Layout.fillWidth: true
          text: deviceRow.device ? deviceRow.device.title : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        // Inline rename. Enter saves, Escape leaves the drive as it was, and
        // an empty name clears the nickname rather than storing a blank one.
        TextField {
          id: nameField
          visible: deviceRow.renaming
          Layout.fillWidth: true
          foreground: root.foreground
          verticalPadding: Style.space(2)
          placeholderText: deviceRow.device ? deviceRow.device.deviceName : ""
          onVisibleChanged: if (visible) {
            text = deviceRow.device && deviceRow.device.nickname !== "" ? deviceRow.device.nickname : ""
            Qt.callLater(function() { nameField.forceActiveFocus(); nameField.selectAll() })
          }
          // The handlers call back into the row rather than reaching for the
          // panel directly: `root` does not resolve inside a qs.Ui TextField,
          // whose own definition already binds that name.
          onAccepted: deviceRow.commitRename(text)
          Keys.onEscapePressed: deviceRow.cancelRename()
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: {
            if (!deviceRow.device) return ""
            var base = deviceRow.device.sizeText
              + (deviceRow.device.tran !== "" ? " · " + deviceRow.device.tran.toUpperCase() : "")
            return deviceRow.activity !== "" ? base + " · " + deviceRow.activity : base
          }
          color: deviceRow.activity !== "" ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      PanelActionButton {
        iconText: Model.GLYPH_PENCIL
        tooltipText: "Rename this drive"
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfDevice(deviceRow.deviceIndex)) }
        onClicked: root.beginRename(deviceRow.device)
      }

      PanelActionButton {
        iconText: Model.GLYPH_EJECT
        tooltipText: deviceRow.ejectPending
          ? "Waiting for writes to finish — click to cancel"
          : "Eject — unmount and power off"
        foreground: deviceRow.ejectPending ? root.urgent : root.foreground
        hoverColor: root.urgent
        fontFamily: root.fontFamily
        enabled: !drives.busy
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfDevice(deviceRow.deviceIndex)) }
        onClicked: {
          if (deviceRow.ejectPending) drives.cancelPendingEject()
          else drives.eject(deviceRow.device)
        }
      }
    }
  }

  component PortableRow: CursorSurface {
    id: portableRow

    property var entry: null
    property int portableIndex: 0

    readonly property bool selected: root.cursorActive && root.currentRow
      && root.currentRow.kind === "portable" && root.currentRow.portable === portableIndex

    hasCursor: selected
    foreground: root.foreground
    implicitHeight: portableContent.implicitHeight + Style.spacing.rowPaddingX

    onSelectedChanged: if (selected) root.cursorItem = portableRow

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(root.rowIndexOfPortable(portableRow.portableIndex))
      onClicked: root.activatePortable(portableRow.entry)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: Model.portableGlyph(portableRow.entry)
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: portableContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: portableRow.entry ? portableRow.entry.name : ""
          color: portableRow.entry && portableRow.entry.mounted ? root.foreground : Qt.darker(root.foreground, 1.25)
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: Model.portableMeta(portableRow.entry)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      PanelActionButton {
        // Always offered: gio mounts the device on demand when it opens it.
        visible: portableRow.entry && portableRow.entry.uri !== ""
        iconText: Model.GLYPH_FOLDER
        tooltipText: "Browse this device"
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfPortable(portableRow.portableIndex)) }
        onClicked: drives.openPortable(portableRow.entry)
      }

      PanelActionButton {
        iconText: portableRow.entry && portableRow.entry.mounted ? Model.GLYPH_UNMOUNT : Model.GLYPH_MOUNT
        tooltipText: portableRow.entry && portableRow.entry.mounted ? "Unmount" : "Mount"
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: !drives.busy
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfPortable(portableRow.portableIndex)) }
        onClicked: drives.togglePortable(portableRow.entry)
      }
    }
  }

  component VolumeRow: CursorSurface {
    id: volumeRow

    property var volume: null
    property int deviceIndex: 0
    property int volumeIndex: 0

    readonly property bool selected: root.cursorActive && root.currentRow
      && root.currentRow.kind === "volume"
      && root.currentRow.device === deviceIndex
      && root.currentRow.volume === volumeIndex
    readonly property bool actionable: volume
      && (volume.mounted || Model.isMountable(volume) || (volume.encrypted && !volume.unlocked))
    readonly property bool working: volume && drives.busyPath === volume.fsPath
    readonly property real trashBytes: volume ? drives.trashSizeFor(volume) : 0

    readonly property bool renamingLabel: volume && root.renamingLabelPath === volume.fsPath
    readonly property bool canCheck: volume && Model.canCheck(drives.fsCapabilities, volume)
    readonly property var checkHint: volume ? Model.checkHint(drives.fsCapabilities, volume) : null

    // Live while the field is open, so a name two characters too long says so
    // before Enter rather than after a round trip that unmounted the drive.
    readonly property var labelCheck: renamingLabel && volume
      ? Model.validateLabel(volume, labelField.text)
      : null
    readonly property int labelRoom: renamingLabel && volume
      ? Model.labelRemaining(volume, labelField.text)
      : 0

    // Both call back to the row, which calls the panel, for the same reason
    // the device row does: neither `root` nor a sibling function resolves
    // inside a qs.Ui TextField's own handlers.
    function commitLabel(value) {
      drives.setVolumeLabel(volumeRow.volume, value)
      root.finishLabelEdit()
    }

    function cancelLabel() { root.finishLabelEdit() }

    hasCursor: selected
    foreground: root.foreground
    implicitHeight: volumeContent.implicitHeight + Style.spacing.rowPaddingX

    onSelectedChanged: if (selected) root.cursorItem = volumeRow

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: volumeRow.actionable && !volumeRow.renamingLabel ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setCursor(root.rowIndexOfVolume(volumeRow.deviceIndex, volumeRow.volumeIndex))
      // A click anywhere on the row mounts or opens it, which is the wrong
      // answer for someone reaching past a half-typed name to their cursor.
      onClicked: if (!volumeRow.renamingLabel) root.activateVolume(volumeRow.volume)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(22)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        visible: volumeRow.volume && volumeRow.volume.encrypted
        text: volumeRow.volume && volumeRow.volume.unlocked ? Model.GLYPH_UNLOCKED : Model.GLYPH_LOCKED
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: volumeContent
        Layout.fillWidth: true
        spacing: Style.space(3)

        Text {
          textFormat: Text.PlainText
          visible: !volumeRow.renamingLabel
          Layout.fillWidth: true
          text: volumeRow.volume ? volumeRow.volume.title : ""
          color: volumeRow.volume && volumeRow.volume.mounted ? root.foreground : Qt.darker(root.foreground, 1.25)
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        // Renaming the filesystem itself. Enter writes the new label, Escape
        // leaves the drive as it was, and an empty name clears the label
        // rather than storing a blank one — which is the state a drive ships
        // in before anybody names it.
        RowLayout {
          visible: volumeRow.renamingLabel
          Layout.fillWidth: true
          spacing: Style.space(6)

          TextField {
            id: labelField
            Layout.fillWidth: true
            foreground: root.foreground
            verticalPadding: Style.space(2)
            placeholderText: volumeRow.volume && volumeRow.volume.fstypeLabel !== ""
              ? volumeRow.volume.fstypeLabel + " label"
              : "Volume label"
            onVisibleChanged: if (visible) {
              text = volumeRow.volume ? volumeRow.volume.label : ""
              Qt.callLater(function() { labelField.forceActiveFocus(); labelField.selectAll() })
            }
            onAccepted: volumeRow.commitLabel(text)
            Keys.onEscapePressed: volumeRow.cancelLabel()
          }

          // Every filesystem has its own ceiling — eleven characters on FAT32
          // and exFAT, sixteen on ext4 — and the number is the only way to
          // know which one you are up against before the write is refused.
          Text {
            textFormat: Text.PlainText
            text: volumeRow.labelRoom
            color: volumeRow.labelRoom < 0 ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            Layout.alignment: Qt.AlignVCenter
          }
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: {
            if (volumeRow.renamingLabel) {
              if (volumeRow.labelCheck && !volumeRow.labelCheck.ok) return volumeRow.labelCheck.message
              return "Enter renames the filesystem · Esc cancels"
            }
            return volumeRow.working ? "Working…" : Model.volumeMeta(volumeRow.volume)
          }
          color: volumeRow.renamingLabel && volumeRow.labelCheck && !volumeRow.labelCheck.ok
            ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
          wrapMode: volumeRow.renamingLabel ? Text.WordWrap : Text.NoWrap
        }

        // Usage bar, drawn only for mounted volumes: an unmounted partition
        // has no numbers to draw, and a bar stuck at zero reads as "empty"
        // rather than "unknown".
        Rectangle {
          visible: volumeRow.volume && volumeRow.volume.mounted && volumeRow.volume.fssize > 0
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          implicitHeight: Math.max(2, Style.space(3))
          radius: height / 2
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)

          Rectangle {
            readonly property real fraction: Model.usedFraction(volumeRow.volume)
            width: Math.max(parent.width > 0 && fraction > 0 ? 2 : 0, parent.width * fraction)
            height: parent.height
            radius: parent.radius
            color: fraction > 0.9 ? root.urgent : root.foreground
            opacity: fraction > 0.9 ? 1.0 : 0.65

            Behavior on width {
              NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
            }
          }
        }

        // Deleted files on removable media go to a .Trash-<uid> on the drive
        // itself, where nothing surfaces them — so a stick reads as full of
        // files its owner believes are gone.
        RowLayout {
          visible: volumeRow.trashBytes > 0
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          spacing: Style.space(6)

          Text {
            textFormat: Text.PlainText
            text: Model.GLYPH_TRASH
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: Model.formatBytes(volumeRow.trashBytes) + " in trash on this drive"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          PanelActionButton {
            iconText: Model.GLYPH_TRASH
            tooltipText: "Empty this drive's trash"
            foreground: root.foreground
            hoverColor: root.urgent
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            size: Style.space(18)
            enabled: !drives.busy
            onClicked: drives.emptyTrash(volumeRow.volume)
          }
        }
      }

      // Renaming and checking both take the filesystem offline and put it
      // back, so neither is offered while the drive is being written to —
      // the service refuses and says so rather than unmounting mid-copy.
      PanelActionButton {
        visible: volumeRow.volume && Model.canRelabel(volumeRow.volume) && !volumeRow.renamingLabel
        iconText: Model.GLYPH_TAG
        tooltipText: "Rename this volume — changes the label on the drive itself"
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: !drives.busy
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfVolume(volumeRow.deviceIndex, volumeRow.volumeIndex)) }
        onClicked: root.beginLabelEdit(volumeRow.volume)
      }

      // When udisks cannot run the check it names the tool it went looking
      // for, so the button stays — dimmed, and offering to install it — rather
      // than vanishing and leaving the gap unexplained.
      PanelActionButton {
        visible: volumeRow.canCheck
          || (volumeRow.checkHint !== null && volumeRow.checkHint.packages !== "")
        iconText: Model.GLYPH_STETHOSCOPE
        tooltipText: volumeRow.canCheck
          ? "Check this filesystem for errors — unmounts it and mounts it back"
          : (volumeRow.checkHint ? volumeRow.checkHint.text + " — click to install it" : "")
        foreground: volumeRow.canCheck ? root.foreground : root.dim
        fontFamily: root.fontFamily
        enabled: !drives.busy
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfVolume(volumeRow.deviceIndex, volumeRow.volumeIndex)) }
        onClicked: {
          if (volumeRow.canCheck) drives.checkVolume(volumeRow.volume)
          else drives.installCheckTools(volumeRow.volume)
        }
      }

      PanelActionButton {
        visible: volumeRow.volume && volumeRow.volume.mounted
        iconText: Model.GLYPH_FOLDER
        tooltipText: "Open in file manager"
        foreground: root.foreground
        fontFamily: root.fontFamily
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfVolume(volumeRow.deviceIndex, volumeRow.volumeIndex)) }
        onClicked: drives.openVolume(volumeRow.volume)
      }

      PanelActionButton {
        visible: volumeRow.volume
          && (volumeRow.volume.mounted || Model.isMountable(volumeRow.volume) || volumeRow.volume.encrypted)
        iconText: {
          if (!volumeRow.volume) return ""
          if (volumeRow.volume.mounted) return Model.GLYPH_UNMOUNT
          if (volumeRow.volume.encrypted && !volumeRow.volume.unlocked) return Model.GLYPH_LOCKED
          return Model.GLYPH_MOUNT
        }
        tooltipText: {
          if (!volumeRow.volume) return ""
          if (volumeRow.volume.mounted) return "Unmount"
          if (volumeRow.volume.encrypted && !volumeRow.volume.unlocked) return "Unlock in a terminal"
          return "Mount"
        }
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: !drives.busy
        Layout.alignment: Qt.AlignVCenter
        onHovered: function(on) { if (on) root.setCursor(root.rowIndexOfVolume(volumeRow.deviceIndex, volumeRow.volumeIndex)) }
        onClicked: drives.toggleMount(volumeRow.volume, root.openOnMount)
      }
    }
  }
}
