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

  readonly property var devices: drives.devices
  readonly property var rows: Model.navRows(drives.devices)
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
    else activateVolume(currentVolume())
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

  visible: devices.length > 0 || alwaysShow
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onVisibleChanged: if (!visible && opened) close()
  onRowsChanged: clampCursor()
  onOpenedChanged: {
    drives.watchClosely = opened
    if (opened) {
      cursorActive = false
      cursor = 0
      if (panelFlick) panelFlick.contentY = 0
      drives.refresh()
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
        pendingEject: drives.pendingEjectPath
      })
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.barGlyph(root.devices)
    // The icon turns urgent while the kernel still has I/O in flight. That is
    // the whole warning: if it is lit, the drive is not safe to pull yet.
    tooltipText: drives.anyBusy
      ? (Model.formatRate(drives.totalWriteRate) !== ""
          ? "Writing " + Model.formatRate(drives.totalWriteRate) + " — do not remove"
          : "Busy — do not remove")
      : Model.summary(root.devices)
    active: drives.anyBusy
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) {
        drives.refresh()
      } else if (buttonCode === Qt.MiddleButton) {
        var mounted = Model.mountedVolumes(root.devices)
        if (mounted.length > 0) drives.openVolume(mounted[0])
      } else {
        root.toggle()
      }
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
        if (text === "r" || text === "R") drives.refresh()
        else if (text === "e") root.ejectCurrent()
        else if (text === "E") drives.ejectAll()
        else if (text === "o" || text === "O") drives.openVolume(root.currentVolume())
        else if (text === "t" || text === "T") drives.openTerminal(root.currentVolume())
        else if (text === "m" || text === "M") drives.toggleMount(root.currentVolume(), root.openOnMount)
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
                  onClicked: drives.refresh()
                }
              }
            }
          }

          Text {
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

          Text {
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
    readonly property bool ejectPending: device
      && (drives.pendingEjectPath === device.path || drives.pendingEjectPath === "*")

    hasCursor: selected
    foreground: root.foreground
    implicitHeight: deviceContent.implicitHeight + Style.spacing.rowPaddingX

    onSelectedChanged: if (selected) root.cursorItem = deviceRow

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
          Layout.fillWidth: true
          text: deviceRow.device ? deviceRow.device.title : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
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

    hasCursor: selected
    foreground: root.foreground
    implicitHeight: volumeContent.implicitHeight + Style.spacing.rowPaddingX

    onSelectedChanged: if (selected) root.cursorItem = volumeRow

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: volumeRow.actionable ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setCursor(root.rowIndexOfVolume(volumeRow.deviceIndex, volumeRow.volumeIndex))
      onClicked: root.activateVolume(volumeRow.volume)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(22)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
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
          Layout.fillWidth: true
          text: volumeRow.volume ? volumeRow.volume.title : ""
          color: volumeRow.volume && volumeRow.volume.mounted ? root.foreground : Qt.darker(root.foreground, 1.25)
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: volumeRow.working ? "Working…" : Model.volumeMeta(volumeRow.volume)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
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
