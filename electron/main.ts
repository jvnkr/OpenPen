import {
  app, BrowserWindow, ipcMain, screen, globalShortcut,
  desktopCapturer, Tray, Menu, nativeImage, Notification, shell, dialog,
  type Display
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { autoUpdater } from 'electron-updater'

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const IS_DEV = Boolean(DEV_URL)

type Bg = 'none' | 'white' | 'black'
interface ToolState { tool: string; color: string; size: number }
interface AppState { mode: boolean; bg: Bg; hidden: boolean; toolState: ToolState | null }
interface HistoryState { canUndo: boolean; canRedo: boolean }
interface Settings { protectUi: boolean }

// One overlay per display, keyed by display id.
const overlays = new Map<number, BrowserWindow>()
// Display currently frozen for the screen eyedropper (one at a time).
let eyedropDisplayId: number | null = null
let eyedropCapturing = false
// Per-overlay history, keyed by webContents id; aggregated for the toolbar.
const overlayHistory = new Map<number, HistoryState>()
let toolbar: BrowserWindow | null = null
let picker: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
// Last resolved theme the toolbar broadcast, so lazily-created windows (the
// settings dialog) can paint the right background before their JS runs.
let resolvedTheme: 'light' | 'dark' = 'light'
// Desired picker visibility. The window is hidden only after the renderer's
// framer-motion exit animation reports done ('picker-hidden'); this flag lets a
// re-open cancel that pending hide.
let pickerShouldShow = false
let toolbarDrag:
  | { startX: number; startY: number; winX: number; winY: number }
  | null = null
let mouseModeFallback: NodeJS.Timeout | null = null

const PICKER_W = 232
// Tall enough for the color area, the hex input row and the saved-swatches grid.
const PICKER_H = 372
const SETTINGS_W = 640
const SETTINGS_H = 460
// The visible palette is TOOLBAR_PANEL_W wide and sits centred in the window,
// flanked by a transparent gutter on each side. Tooltips (which would otherwise
// be clipped by the window) render into whichever gutter has room on the actual
// screen. The gutters are click-through, so they never block the desktop.
const TOOLBAR_PANEL_W = 48
const TOOLBAR_GUTTER_W = 210
const TOOLBAR_W = TOOLBAR_PANEL_W + TOOLBAR_GUTTER_W * 2
const TOOLBAR_TIP_MIN = 190
const TOOLBAR_H = 720
// Single source of truth for app-wide state, mirrored to the renderers.
const state: AppState = { mode: false, bg: 'none', hidden: false, toolState: null }

// Persisted main-process settings. protectUi excludes the toolbar/picker from
// screen capture (WDA_EXCLUDEFROMCAPTURE) so OBS recordings and screenshots
// show ink but not the UI.
const settings: Settings = { protectUi: !IS_DEV }
const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json')

function loadSettings (): void {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>)
  } catch { /* first run */ }
  if (IS_DEV) settings.protectUi = false
}

function saveSettings (): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings))
  } catch (err) {
    console.error('failed to save settings', err)
  }
}

function applyUiCaptureProtection (): void {
  toolbar?.setContentProtection(!IS_DEV && settings.protectUi)
  picker?.setContentProtection(!IS_DEV && settings.protectUi)
  settingsWin?.setContentProtection(!IS_DEV && settings.protectUi)
}

const send = (win: BrowserWindow | null, ch: string, data?: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
}
const sendOverlays = (ch: string, data?: unknown): void => {
  for (const win of overlays.values()) send(win, ch, data)
}
const broadcast = (ch: string, data?: unknown): void => {
  sendOverlays(ch, data)
  send(toolbar, ch, data)
}

// Raising the overlays (draw-mode entry, text-edit focus) puts them at the
// top of the topmost z-band, which would bury OpenPen's own UI. Re-raise every
// UI window above the overlays so hovering the toolbar, picker or settings hits
// that window and stays interactive instead of drawing on the canvas behind it.
function raiseUiAboveOverlays (): void {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.moveTop()
  if (picker && !picker.isDestroyed() && picker.isVisible()) picker.moveTop()
  if (toolbar && !toolbar.isDestroyed()) toolbar.moveTop()
}

function load (win: BrowserWindow, page: string): void {
  if (DEV_URL) win.loadURL(`${DEV_URL}/${page}.html`)
  else win.loadFile(path.join(__dirname, '..', 'dist', `${page}.html`))
}

function isPoint (p: unknown): p is { x: number; y: number } {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { x?: unknown }).x === 'number' &&
    typeof (p as { y?: unknown }).y === 'number'
  )
}

function displayAtCursor (): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function overlayAtCursor (): BrowserWindow | null {
  return overlays.get(displayAtCursor().id) ?? overlays.values().next().value ?? null
}

function createOverlay (d: Display, index: number): void {
  const b = d.bounds
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // Non-activating (WS_EX_NOACTIVATE): drawing clicks never steal focus from
    // the app behind, so games keep receiving keyboard input while you draw.
    // Focus is granted temporarily for text editing (see 'text-editing' IPC).
    focusable: false,
    type: 'toolbar', // keeps it out of alt-tab on Windows
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(!state.mode, { forward: false })
  win.setMenu(null)
  // Stable title so OBS window-capture users can find the overlay per display.
  const title = index === 0 ? 'OpenPen Overlay' : `OpenPen Overlay ${index + 1}`
  win.on('page-title-updated', ev => ev.preventDefault())
  win.setTitle(title)
  // Windows keeps all always-on-top windows in one z-band, so focusing an
  // overlay raises it above OpenPen's UI — re-raise the UI windows every time.
  win.on('focus', raiseUiAboveOverlays)
  load(win, 'overlay')
  win.once('ready-to-show', () => {
    if (!state.hidden) win.showInactive()
  })
  overlays.set(d.id, win)
}

function createOverlays (): void {
  screen.getAllDisplays().forEach((d, i) => createOverlay(d, i))
}

function destroyOverlay (displayId: number): void {
  const win = overlays.get(displayId)
  overlays.delete(displayId)
  if (win && !win.isDestroyed()) {
    overlayHistory.delete(win.webContents.id)
    win.destroy()
  }
  pushHistory()
}

function createToolbar (): void {
  const wa = screen.getPrimaryDisplay().workArea
  toolbar = new BrowserWindow({
    width: TOOLBAR_W,
    height: TOOLBAR_H,
    // Dock the panel (centred in the window) 16px from the right edge; the
    // left gutter then sits on-screen and the right gutter runs off-screen.
    x: wa.x + wa.width - 16 - TOOLBAR_PANEL_W - TOOLBAR_GUTTER_W,
    y: wa.y + Math.max(0, Math.round((wa.height - TOOLBAR_H) / 2)),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    show: false,
    maximizable: false,
    fullscreenable: false,
    // Background-app behavior: no taskbar button, and the toolwindow style
    // keeps it out of Alt-Tab / Win+Tab — OpenPen lives in the tray only.
    skipTaskbar: true,
    type: 'toolbar',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  toolbar.setAlwaysOnTop(true, 'screen-saver', 1)
  toolbar.setMenu(null)
  // Start click-through with forwarding so the transparent gutter passes mouse
  // events to the app behind it; the renderer flips this on when the pointer is
  // over the actual palette (see the 'toolbar-interactive' handler).
  toolbar.setIgnoreMouseEvents(true, { forward: true })
  load(toolbar, 'toolbar')
  toolbar.once('ready-to-show', () => toolbar?.show())
  toolbar.on('move', hidePicker)
  toolbar.on('blur', closePickerIfFocusLeft)
  toolbar.on('closed', () => app.quit())
}

// Pick the gutter (left/right) that has room on the panel's current display, so
// tooltips never render off the visible screen. Base UI honours this side and
// won't flip because the chosen gutter always has space inside the window.
function updateTooltipSide (): void {
  if (!toolbar || toolbar.isDestroyed()) return
  const b = toolbar.getBounds()
  const panelLeft = b.x + TOOLBAR_GUTTER_W
  const center = { x: Math.round(panelLeft + TOOLBAR_PANEL_W / 2), y: Math.round(b.y + b.height / 2) }
  const wa = screen.getDisplayNearestPoint(center).workArea
  const roomLeft = panelLeft - wa.x
  const roomRight = wa.x + wa.width - (panelLeft + TOOLBAR_PANEL_W)
  const side = roomLeft >= TOOLBAR_TIP_MIN || roomLeft >= roomRight ? 'left' : 'right'
  send(toolbar, 'tooltip-side', side)
}

function fitToolbarHeight (height: unknown): void {
  if (!toolbar || toolbar.isDestroyed() || typeof height !== 'number') return
  const b = toolbar.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const h = Math.max(80, Math.min(Math.ceil(height), wa.height))
  if (Math.abs(b.height - h) <= 1) return
  toolbar.setResizable(true)
  toolbar.setBounds({ x: b.x, y: b.y, width: TOOLBAR_W, height: h })
  toolbar.setResizable(false)
  hidePicker()
}

function toggleToolbar (): void {
  if (!toolbar || toolbar.isDestroyed()) return
  if (toolbar.isVisible()) {
    hidePicker()
    toolbar.hide()
  } else {
    toolbar.showInactive()
  }
}

// Bring the toolbar back into view (e.g. from the tray). Hiding the toolbar
// makes OpenPen look "closed" — only the tray icon remains — so a tray click
// should just reveal the UI again, never toggle drawing.
function showToolbar (): void {
  if (!toolbar || toolbar.isDestroyed()) return
  if (!toolbar.isVisible()) toolbar.showInactive()
  toolbar.moveTop()
}

function createPicker (): void {
  picker = new BrowserWindow({
    width: PICKER_W,
    height: PICKER_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    type: 'toolbar',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  picker.setAlwaysOnTop(true, 'screen-saver', 2)
  picker.setMenu(null)
  // Popover behavior: close only when focus leaves both the picker and the
  // toolbar, so clicking around the toolbar keeps it open.
  picker.on('blur', closePickerIfFocusLeft)
  load(picker, 'picker')
}

// A conventional framed dialog (unlike the frameless overlay windows): the OS
// title bar gives native move/resize/close. Kept above the overlays so it isn't
// buried, and centred on whichever display holds the toolbar.
function openSettings (): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  const anchor = (toolbar && !toolbar.isDestroyed()) ? toolbar.getBounds() : screen.getPrimaryDisplay().bounds
  const wa = screen.getDisplayMatching(anchor).workArea
  settingsWin = new BrowserWindow({
    width: SETTINGS_W,
    height: SETTINGS_H,
    minWidth: 520,
    minHeight: 380,
    x: Math.round(wa.x + (wa.width - SETTINGS_W) / 2),
    y: Math.round(wa.y + (wa.height - SETTINGS_H) / 2),
    title: 'OpenPen Settings',
    icon: appIconPath(),
    backgroundColor: resolvedTheme === 'dark' ? '#0a0a0a' : '#ffffff',
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  settingsWin.setAlwaysOnTop(true, 'screen-saver', 3)
  settingsWin.setMenu(null)
  settingsWin.setContentProtection(!IS_DEV && settings.protectUi)
  load(settingsWin, 'settings')
  settingsWin.once('ready-to-show', () => { settingsWin?.show(); settingsWin?.focus() })
  settingsWin.on('closed', () => { settingsWin = null })
}

// Focus may still be mid-flight when 'blur' fires; check after it settles.
function closePickerIfFocusLeft (): void {
  if (!pickerShouldShow) return
  setTimeout(() => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused !== picker && focused !== toolbar) hidePicker()
  }, 10)
}

function hidePicker (): void {
  if (!pickerShouldShow) return
  pickerShouldShow = false
  // Play the exit animation in the renderer; the window is actually hidden once
  // it reports back via 'picker-hidden'. Show at full opacity — the panel itself
  // fades via framer-motion, so no stepped main-process opacity ramp is needed.
  send(picker, 'picker-visible', false)
  send(toolbar, 'picker-open', false)
}

function togglePicker (): void {
  if (!picker || picker.isDestroyed() || !toolbar || toolbar.isDestroyed()) return
  if (pickerShouldShow) {
    hidePicker()
    return
  }
  const tb = toolbar.getBounds()
  const wa = screen.getDisplayMatching(tb).workArea
  // The toolbar window is much wider than the visible palette — the panel sits
  // centred with a transparent click-through gutter on each side. Anchor the
  // picker to the panel's real edges, not the window's, so it sits right beside
  // the palette instead of a gutter-width away.
  const panelLeft = tb.x + TOOLBAR_GUTTER_W
  const panelRight = panelLeft + TOOLBAR_PANEL_W
  let x = panelLeft - PICKER_W - 8
  if (x < wa.x) x = panelRight + 8
  const y = Math.max(wa.y, Math.min(tb.y, wa.y + wa.height - PICKER_H))
  picker.setBounds({ x, y, width: PICKER_W, height: PICKER_H })
  pickerShouldShow = true
  // The window is shown empty/transparent (the panel isn't rendered until the
  // renderer sees 'picker-visible'), so there's no opaque first frame to flash.
  picker.showInactive()
  // showInactive maps to SW_SHOWNA, which preserves z-order instead of raising
  // the window. In draw mode the overlays were already moved to the top of the
  // z-band, so without this the picker would appear *under* the drawing canvas
  // and hovering it would draw through. Raise it above the overlays (and keep it
  // there, like the toolbar) so it stays interactive while drawing.
  picker.moveTop()
  send(picker, 'picker-visible', true)
  send(toolbar, 'picker-open', true)
}

function fitOverlays (): void {
  for (const d of screen.getAllDisplays()) {
    const win = overlays.get(d.id)
    if (win && !win.isDestroyed()) win.setBounds(d.bounds)
  }
}

// Windows only repaints the OS cursor on a real mouse event. When the cursor
// image changes while the mouse holds still (leaving draw mode, or resizing the
// brush with the wheel) the stale cursor lingers until the pointer moves.
// Nudging the overlay's web contents with a synthetic mouse move at the current
// position forces Chromium to re-issue the current cursor to the OS at once.
function repaintOverlayCursor (win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  const point = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const inside =
    point.x >= b.x && point.x < b.x + b.width &&
    point.y >= b.y && point.y < b.y + b.height
  if (inside) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x - b.x, y: point.y - b.y })
  }
}

// Exiting draw mode leaves a stale crosshair until the mouse moves; repaint the
// (now default) cursor on the overlay under the pointer while it still receives
// events, then flip every overlay back to click-through.
function enterMouseMode (): void {
  for (const win of overlays.values()) repaintOverlayCursor(win)
  // Let Chromium process the synthetic move (and repaint the OS cursor) before
  // the overlay stops receiving events, otherwise the update can be dropped.
  setTimeout(() => {
    for (const win of overlays.values()) {
      if (win.isDestroyed()) continue
      win.setIgnoreMouseEvents(true, { forward: false })
    }
  }, 16)
}

// Bare Ctrl+Z/Y would steal undo from every other app if they were always
// registered, so they're active only while they can actually affect visible
// ink: in draw mode, or in mouse mode while undo/redo history exists. As soon
// as the history is exhausted (or ink is hidden) the shortcuts are released
// back to whatever app is focused. They route through runCmd so they work no
// matter which OpenPen window, if any, currently holds focus.
let editShortcutsOn = false
let escShortcutOn = false
let aggHist: HistoryState = { canUndo: false, canRedo: false }

function updateGlobalEditShortcuts (): void {
  const wantEdit = state.mode || (!state.hidden && (aggHist.canUndo || aggHist.canRedo))
  if (wantEdit !== editShortcutsOn) {
    editShortcutsOn = wantEdit
    if (wantEdit) {
      globalShortcut.register('CommandOrControl+Z', () => runCmd('undo'))
      globalShortcut.register('CommandOrControl+Shift+Z', () => runCmd('redo'))
      globalShortcut.register('CommandOrControl+Y', () => runCmd('redo'))
    } else {
      globalShortcut.unregister('CommandOrControl+Z')
      globalShortcut.unregister('CommandOrControl+Shift+Z')
      globalShortcut.unregister('CommandOrControl+Y')
    }
  }
  // Escape stays gated to draw mode only — hijacking it system-wide in mouse
  // mode would break Escape in every other app. Routed through the overlay
  // (not straight to setDrawMode) so an open text editor can swallow it to
  // cancel editing instead of dropping out of draw mode.
  const wantEsc = state.mode
  if (wantEsc !== escShortcutOn) {
    escShortcutOn = wantEsc
    if (wantEsc) globalShortcut.register('Escape', () => runCmd('escape'))
    else globalShortcut.unregister('Escape')
  }
}

function setDrawMode (on: boolean): void {
  state.mode = on
  if (state.mode && state.hidden) setHidden(false)
  if (mouseModeFallback) {
    clearTimeout(mouseModeFallback)
    mouseModeFallback = null
  }
  broadcast('mode', state.mode)
  updateGlobalEditShortcuts()
  if (state.mode) {
    for (const win of overlays.values()) {
      if (win.isDestroyed()) continue
      win.setIgnoreMouseEvents(false, { forward: false })
      // The Windows taskbar lives in the same topmost z-band and covers us
      // whenever it was raised last (e.g. after the user clicked it). Re-assert
      // topmost on every draw-mode entry so ink can go over the taskbar too.
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    }
    // Deliberately no focus() here: overlays are non-activating so the app the
    // user was in keeps keyboard focus while they draw.
    raiseUiAboveOverlays()
  } else {
    mouseModeFallback = setTimeout(() => {
      enterMouseMode()
      mouseModeFallback = null
    }, 120)
  }
  tray?.setToolTip(`OpenPen: ${state.mode ? 'drawing' : 'mouse'} mode (Ctrl+Shift+D)`)
}

function setHidden (hidden: boolean): void {
  state.hidden = hidden
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue
    if (state.hidden) win.hide()
    else win.showInactive()
  }
  if (state.hidden && state.mode) setDrawMode(false)
  broadcast('hidden', state.hidden)
  updateGlobalEditShortcuts()
}

function toggleBg (c: Bg): void {
  state.bg = state.bg === c ? 'none' : c
  if (state.bg !== 'none' && state.hidden) setHidden(false)
  broadcast('bg', state.bg)
}

function pushHistory (): void {
  let canUndo = false
  let canRedo = false
  for (const h of overlayHistory.values()) {
    canUndo = canUndo || h.canUndo
    canRedo = canRedo || h.canRedo
  }
  aggHist = { canUndo, canRedo }
  send(toolbar, 'history', aggHist)
  updateGlobalEditShortcuts()
}

// clear wipes every display; undo/redo act on the display under the cursor.
function runCmd (name: string): void {
  if (name === 'clear') sendOverlays('cmd', 'clear')
  else send(overlayAtCursor(), 'cmd', name)
}

// Grab a screenshot of one display at its native pixel resolution. The shared
// capture primitive behind the screenshot and eyedropper features; hides the
// resolution math and the per-display source lookup (with fallback). Null when
// the OS returns no usable source.
async function captureDisplay (d: Display): Promise<Electron.NativeImage | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor)
    }
  })
  const src = sources.find(s => s.display_id === String(d.id)) ?? sources[0]
  return src ? src.thumbnail : null
}

// Keep OpenPen's own windows out of the *next* frozen capture (the eyedropper
// must not photograph the toolbar). Returns a restore fn. No-op with no settle
// wait when capture protection is already on (the default), so the common path
// pays nothing.
async function hideUiForFreeze (): Promise<() => void> {
  const alreadyProtected = !IS_DEV && settings.protectUi
  if (!alreadyProtected) {
    toolbar?.setContentProtection(true)
    picker?.setContentProtection(true)
    settingsWin?.setContentProtection(true)
    await new Promise(r => setTimeout(r, 50))
  }
  return () => { if (!alreadyProtected) applyUiCaptureProtection() }
}

// Hand a frozen overlay back to normal input: stop capturing mouse events
// (unless still drawing) and repaint the OS cursor when returning to mouse mode.
// The exit tail of an eyedropper session.
function restoreOverlayInput (win: BrowserWindow | undefined): void {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!state.mode, { forward: false })
  if (!state.mode) enterMouseMode()
}

// Captures the display under the cursor. OpenPen's own screenshot includes
// the toolbar/picker so users can capture and share the UI while iterating.
async function shoot (): Promise<void> {
  const d = displayAtCursor()
  const restoreProtection = settings.protectUi
  send(toolbar, 'screenshotting', true)
  try {
    if (restoreProtection) {
      toolbar?.setContentProtection(false)
      picker?.setContentProtection(false)
    }
    await new Promise(r => setTimeout(r, 120)) // let UI cleanup and capture protection settle
    const img = await captureDisplay(d)
    if (!img) return
    const dir = path.join(app.getPath('pictures'), 'OpenPen')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const file = path.join(dir, `openpen-${stamp}.png`)
    fs.writeFileSync(file, img.toPNG())
    const n = new Notification({ title: 'OpenPen', body: `Screenshot saved:\n${file}` })
    n.on('click', () => shell.showItemInFolder(file))
    n.show()
  } catch (err) {
    console.error('screenshot failed', err)
  } finally {
    if (restoreProtection) applyUiCaptureProtection()
    send(toolbar, 'screenshotting', false)
  }
}

// Screen colour picker. The native EyeDropper Web API only samples this app's
// own compositor surface in Electron, so we roll our own: freeze the display
// under the cursor onto its overlay and let the renderer sample a pixel with a
// magnifier loupe. The picker window is left where it is — raising
// the frozen overlay above every UI window means the whole screen (even the
// area under the toolbar/picker) is sample-able, and they reappear on exit.
async function startEyedrop (): Promise<void> {
  if (eyedropDisplayId !== null || eyedropCapturing) return
  if (state.hidden) setHidden(false)
  const d = displayAtCursor()
  const win = overlays.get(d.id)
  if (!win || win.isDestroyed()) return
  eyedropCapturing = true
  const restoreUi = await hideUiForFreeze()
  try {
    const img = await captureDisplay(d)
    if (!img) return
    const cur = screen.getCursorScreenPoint()
    eyedropDisplayId = d.id
    win.setIgnoreMouseEvents(false, { forward: false })
    // PNG (lossless) rather than JPEG — colour accuracy matters more than size
    // for a one-shot pick.
    send(win, 'eyedrop', {
      png: img.toPNG(),
      x: cur.x - d.bounds.x,
      y: cur.y - d.bounds.y
    })
    win.moveTop()
    // Escape cancels; the non-activating overlay can't get key focus, so grab it
    // globally for the duration and hand it back in endEyedrop.
    globalShortcut.register('Escape', endEyedrop)
  } catch (err) {
    console.error('eyedrop capture failed', err)
  } finally {
    restoreUi()
    eyedropCapturing = false
  }
}

function endEyedrop (): void {
  if (eyedropDisplayId === null) return
  const win = overlays.get(eyedropDisplayId)
  eyedropDisplayId = null
  if (win && !win.isDestroyed()) send(win, 'eyedrop', null)
  // Release our Escape grab and let the normal draw-mode gating reclaim it.
  globalShortcut.unregister('Escape')
  escShortcutOn = false
  updateGlobalEditShortcuts()
  // Bring the toolbar/picker back above the (now live) overlays.
  raiseUiAboveOverlays()
  restoreOverlayInput(win)
}

function showRecordingHelp (): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'OpenPen: recording and OBS setup',
    message: 'Recording your annotations (OBS, Zoom, clips)',
    detail: [
      'OpenPen ink is drawn in a normal on-screen window, so any "Display Capture" source records it automatically. This is the recommended OBS setup.',
      '',
      'If you use Window Capture or Game Capture only, add one extra Window Capture source for the window named "OpenPen Overlay" (one per display), place it above your game source, and set its capture method to "Windows 10 (1903 and up)".',
      '',
      '"Hide toolbar from recordings" (in the tray menu, on by default) keeps the toolbar and color picker visible to you but excluded from recordings and OpenPen screenshots.'
    ].join('\n')
  })
}

function appIconPath (): string {
  // Windows taskbar/title bar reads multi-size assets from .ico; other platforms use .png.
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return path.join(__dirname, '..', 'build', file)
}

function makeTrayIcon (): Electron.NativeImage {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
  const img = nativeImage.createFromPath(iconPath)
  if (img.isEmpty()) {
    console.warn('Tray icon missing — run `pnpm icons` to generate build/icon.png')
    return nativeImage.createEmpty()
  }
  return img.resize({ width: 16, height: 16, quality: 'best' })
}

// --- Auto-update (electron-updater) ------------------------------------------
// Only runs in a packaged build. It reads the same GitHub `publish` target
// electron-builder uploads to (see package.json build.publish), so it finds the
// latest.yml the release workflow publishes. Updates download in the background
// and install on quit; the tray exposes a manual check and a restart action once
// an update is ready. NSIS installs support this; the portable build does not.
type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error'
let updateReadyVersion: string | null = null
let updateStatus: UpdateStatus = 'idle'
let updatePendingVersion: string | null = null
let updateError: string | null = null
let manualUpdateCheck = false

function buildSettingsState (): {
  protectUi: boolean
  isDev: boolean
  version: string
  canUpdate: boolean
  updateStatus: UpdateStatus
  updateVersion: string | null
  updateError: string | null
} {
  return {
    protectUi: settings.protectUi,
    isDev: IS_DEV,
    version: app.getVersion(),
    canUpdate: app.isPackaged,
    updateStatus,
    updateVersion: updateReadyVersion ?? updatePendingVersion,
    updateError
  }
}

function broadcastSettingsState (): void {
  if (!settingsWin || settingsWin.isDestroyed()) return
  send(settingsWin, 'settings-state', buildSettingsState())
}

function notify (title: string, body: string, onClick?: () => void): void {
  const n = new Notification({ title, body })
  if (onClick) n.on('click', onClick)
  n.show()
}

function initAutoUpdate (): void {
  if (!app.isPackaged) return // dev / unpacked builds have no update feed
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    updateStatus = 'checking'
    updateError = null
    broadcastSettingsState()
  })
  autoUpdater.on('update-available', info => {
    updatePendingVersion = info.version
    updateStatus = 'downloading'
    broadcastSettingsState()
    if (manualUpdateCheck) notify('OpenPen', `Downloading update v${info.version}…`)
  })
  autoUpdater.on('update-not-available', () => {
    updateStatus = manualUpdateCheck ? 'uptodate' : 'idle'
    updatePendingVersion = null
    updateError = null
    broadcastSettingsState()
    if (manualUpdateCheck) notify('OpenPen', 'You’re on the latest version.')
    manualUpdateCheck = false
  })
  autoUpdater.on('update-downloaded', info => {
    updateReadyVersion = info.version
    updatePendingVersion = null
    updateStatus = 'ready'
    updateError = null
    manualUpdateCheck = false
    refreshTray()
    broadcastSettingsState()
    notify('OpenPen', `Update v${info.version} is ready. Restart to install.`,
      () => autoUpdater.quitAndInstall())
  })
  autoUpdater.on('error', err => {
    console.error('auto-update error', err)
    updateStatus = manualUpdateCheck ? 'error' : 'idle'
    updateError = err instanceof Error ? err.message : String(err)
    broadcastSettingsState()
    if (manualUpdateCheck) notify('OpenPen', 'Update check failed.')
    manualUpdateCheck = false
  })

  void autoUpdater.checkForUpdates()
  // Long-running tray app: re-check every 6 hours.
  setInterval(() => { void autoUpdater.checkForUpdates() }, 6 * 60 * 60 * 1000)
}

function checkForUpdatesManually (): void {
  if (!app.isPackaged) return
  manualUpdateCheck = true
  updateError = null
  updateStatus = 'checking'
  broadcastSettingsState()
  void autoUpdater.checkForUpdates()
}

function buildTrayMenu (): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Toggle drawing', accelerator: 'Ctrl+Shift+D', click: () => setDrawMode(!state.mode) },
    { label: 'Clear screens', accelerator: 'Ctrl+Shift+C', click: () => runCmd('clear') },
    { label: 'Hide/show ink', accelerator: 'Ctrl+Shift+H', click: () => setHidden(!state.hidden) },
    { label: 'Show/hide toolbar', accelerator: 'Ctrl+Shift+T', click: toggleToolbar },
    { label: 'Screenshot', accelerator: 'Ctrl+Shift+S', click: () => { void shoot() } },
    { type: 'separator' },
    {
      label: IS_DEV ? 'Hide toolbar from recordings (disabled in dev)' : 'Hide toolbar from recordings',
      type: 'checkbox',
      checked: !IS_DEV && settings.protectUi,
      enabled: !IS_DEV,
      click: item => {
        settings.protectUi = item.checked
        applyUiCaptureProtection()
        saveSettings()
      }
    },
    { label: 'Recording / OBS setup…', click: showRecordingHelp }
  ]
  // Update actions only make sense in an installed build.
  if (app.isPackaged) {
    template.push({ type: 'separator' })
    if (updateReadyVersion) {
      template.push({
        label: `Restart to install v${updateReadyVersion}`,
        click: () => autoUpdater.quitAndInstall()
      })
    }
    template.push({ label: 'Check for updates…', click: checkForUpdatesManually })
  }
  template.push(
    { type: 'separator' },
    { label: 'Quit OpenPen', click: () => app.quit() }
  )
  return Menu.buildFromTemplate(template)
}

function createTray (): void {
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('OpenPen: mouse mode (Ctrl+Shift+D)')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showToolbar)
}

// The tray's "Hide toolbar from recordings" checkbox mirrors settings.protectUi;
// rebuild the menu so it stays in sync when changed from the settings window.
function refreshTray (): void {
  tray?.setContextMenu(buildTrayMenu())
}

// Global tool hotkeys — jump straight to a tool from any app (auto-enters draw
// mode). This mirrors the accel numbers in src/tools.ts: main and the renderer
// are compiled separately and can't share that module, so the tool names and
// accelerator digits are the shared vocabulary across the process seam. Keep
// this in step with the registry's `accel` values.
const TOOL_SHORTCUTS: Record<string, string> = {
  1: 'pen', 2: 'drag', 3: 'highlighter', 4: 'eraser',
  5: 'text', 6: 'line', 7: 'arrow', 8: 'rect', 9: 'ellipse'
}

function registerShortcuts (): void {
  globalShortcut.register('Ctrl+Shift+D', () => setDrawMode(!state.mode))
  globalShortcut.register('Ctrl+Shift+M', () => setDrawMode(false))
  for (const [n, tool] of Object.entries(TOOL_SHORTCUTS)) {
    globalShortcut.register(`Ctrl+Shift+${n}`, () => send(toolbar, 'pick-tool', tool))
  }
  globalShortcut.register('Ctrl+Shift+C', () => runCmd('clear'))
  globalShortcut.register('Ctrl+Shift+U', () => runCmd('undo'))
  globalShortcut.register('Ctrl+Shift+Y', () => runCmd('redo'))
  globalShortcut.register('Ctrl+Shift+S', () => { void shoot() })
  globalShortcut.register('Ctrl+Shift+W', () => toggleBg('white'))
  globalShortcut.register('Ctrl+Shift+B', () => toggleBg('black'))
  globalShortcut.register('Ctrl+Shift+H', () => setHidden(!state.hidden))
  globalShortcut.register('Ctrl+Shift+T', toggleToolbar)
}

function wireIpc (): void {
  ipcMain.on('overlay-ready', e => {
    if (state.toolState) e.sender.send('tool-state', state.toolState)
    e.sender.send('mode', state.mode)
    e.sender.send('bg', state.bg)
  })
  ipcMain.on('overlay-cursor-ready', () => {
    if (state.mode) return
    if (mouseModeFallback) {
      clearTimeout(mouseModeFallback)
      mouseModeFallback = null
    }
    enterMouseMode()
  })
  ipcMain.on('toolbar-ready', () => {
    send(toolbar, 'mode', state.mode)
    send(toolbar, 'bg', state.bg)
    send(toolbar, 'hidden', state.hidden)
    updateTooltipSide()
    pushHistory()
  })
  ipcMain.on('tool-state', (_e, s: ToolState) => {
    state.toolState = s
    sendOverlays('tool-state', s)
    send(picker, 'color', s.color)
  })
  ipcMain.on('set-mode', (_e, on: boolean) => setDrawMode(on))
  // Overlays are non-activating so drawing never steals focus, but the text
  // editor needs the keyboard: grant focus for the edit's duration only, then
  // hand it back to the window below.
  ipcMain.on('text-editing', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (on) {
      win.setFocusable(true)
      win.focus()
    } else {
      win.setFocusable(false)
      if (win.isFocused()) win.blur()
      // Clearing focusability + blurring knocks the transparent overlay out of
      // the topmost z-band on Windows and drops its composited ink, so the text
      // just typed appears to vanish. Re-assert topmost and force a repaint —
      // the same treatment draw-mode entry gives after its focus changes — then
      // put OpenPen's own UI back above the overlay.
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
      win.webContents.invalidate()
      raiseUiAboveOverlays()
    }
  })
  ipcMain.on('cmd', (_e, name: string) => runCmd(name))
  ipcMain.on('history', (e, h: HistoryState) => {
    overlayHistory.set(e.sender.id, h)
    pushHistory()
  })
  ipcMain.on('pick-tool', (_e, t: string) => send(toolbar, 'pick-tool', t))
  ipcMain.on('adjust-size', (_e, d: number) => send(toolbar, 'adjust-size', d))
  ipcMain.on('set-bg', (_e, b: Bg) => toggleBg(b))
  ipcMain.on('screenshot', () => { void shoot() })
  ipcMain.on('toggle-picker', togglePicker)
  ipcMain.on('set-color', (_e, c: string) => send(toolbar, 'set-color', c))
  ipcMain.on('theme', (_e, t: string) => {
    resolvedTheme = t === 'dark' ? 'dark' : 'light'
    // Broadcast to every window at once so their theme crossfades start in sync
    // (the toolbar resolves the theme but applies it via this same message).
    send(toolbar, 'theme', t)
    send(picker, 'theme', t)
    send(settingsWin, 'theme', t)
  })
  ipcMain.on('open-settings', openSettings)
  ipcMain.on('settings-ready', () => broadcastSettingsState())
  ipcMain.on('check-for-updates', checkForUpdatesManually)
  ipcMain.on('install-update', () => {
    if (updateReadyVersion) autoUpdater.quitAndInstall()
  })
  // The toolbar owns theme resolution/persistence; the settings window just
  // requests a preference change and the toolbar broadcasts the result back.
  ipcMain.on('set-theme', (_e, pref: string) => send(toolbar, 'set-theme', pref))
  ipcMain.on('set-protect-ui', (_e, on: boolean) => {
    settings.protectUi = Boolean(on)
    applyUiCaptureProtection()
    saveSettings()
    refreshTray()
    broadcastSettingsState()
  })
  ipcMain.on('picker-ready', () => {
    if (state.toolState) send(picker, 'color', state.toolState.color)
  })
  // The renderer finished its exit animation; hide the window for real — unless
  // a re-open flipped pickerShouldShow back on in the meantime.
  ipcMain.on('picker-hidden', () => {
    if (!pickerShouldShow && picker && !picker.isDestroyed()) picker.hide()
  })
  ipcMain.on('toolbar-drag-start', (_e, p: unknown) => {
    if (!toolbar || toolbar.isDestroyed() || !isPoint(p)) return
    const b = toolbar.getBounds()
    toolbarDrag = { startX: p.x, startY: p.y, winX: b.x, winY: b.y }
    hidePicker()
  })
  ipcMain.on('toolbar-drag-move', (_e, p: unknown) => {
    if (!toolbar || toolbar.isDestroyed() || !toolbarDrag || !isPoint(p)) return
    toolbar.setPosition(
      Math.round(toolbarDrag.winX + p.x - toolbarDrag.startX),
      Math.round(toolbarDrag.winY + p.y - toolbarDrag.startY),
    )
    // Re-pick the flyout side live: dragging the panel toward a screen edge can
    // push the tooltip/size popover off-screen, so flip it to the roomy side as
    // we go instead of only settling it when the drag ends.
    updateTooltipSide()
  })
  ipcMain.on('toolbar-drag-end', () => {
    toolbarDrag = null
    updateTooltipSide()
  })
  ipcMain.on('toolbar-interactive', (_e, on: boolean) => {
    if (!toolbar || toolbar.isDestroyed()) return
    toolbar.setIgnoreMouseEvents(!on, { forward: true })
  })
  ipcMain.on('toolbar-fit-height', (_e, height: unknown) => fitToolbarHeight(height))
  ipcMain.on('eyedrop-start', () => { void startEyedrop() })
  ipcMain.on('eyedrop-cancel', endEyedrop)
  ipcMain.on('eyedrop-pick', (_e, hex: unknown) => {
    endEyedrop()
    if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      // Route through the toolbar so it becomes the active colour and is
      // rebroadcast to the overlays (and echoed back to the picker).
      send(toolbar, 'set-color', hex.toLowerCase())
    }
  })
  ipcMain.on('toggle-hide', () => setHidden(!state.hidden))
  ipcMain.on('toggle-toolbar', toggleToolbar)
  ipcMain.on('quit', () => app.quit())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { toolbar?.show(); toolbar?.focus() })

  void app.whenReady().then(() => {
    app.setAppUserModelId('dev.openpen.app')
    loadSettings()
    createOverlays()
    createToolbar()
    createPicker()
    applyUiCaptureProtection()
    createTray()
    registerShortcuts()
    wireIpc()
    initAutoUpdate()
    screen.on('display-metrics-changed', () => { fitOverlays(); updateTooltipSide() })
    screen.on('display-added', (_e, d) => createOverlay(d, overlays.size))
    screen.on('display-removed', (_e, d) => destroyOverlay(d.id))
  })

  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => globalShortcut.unregisterAll())
}
