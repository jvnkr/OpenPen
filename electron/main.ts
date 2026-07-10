import {
  app, BrowserWindow, ipcMain, screen, globalShortcut,
  desktopCapturer, Tray, Menu, nativeImage, Notification, shell, dialog, clipboard,
  type Display
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { autoUpdater } from 'electron-updater'
import { JsonBoardStore, type BoardStore, type StoredBoard, type SerializedDoc } from './boardStore.js'
import { sampleScreenRegion } from './screenSample.js'
import {
  DEFAULT_HOTKEYS, HOTKEY_ACTIONS, mergeHotkeys,
  findHotkeyConflict, isValidAccelerator, isHotkeyBound,
  UNBOUND_HOTKEY,
  type HotkeyAction, type HotkeyMap
} from './hotkeys.js'

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const IS_DEV = Boolean(DEV_URL)

const APP_ID = app.isPackaged ? 'dev.openpen.app' : 'dev.openpen.app.dev'

type Bg = 'none' | 'white' | 'black'
interface ToolState { tool: string; color: string; size: number }
interface AppState { mode: boolean; highlight: boolean; bg: Bg; hidden: boolean; toolState: ToolState | null }
interface HistoryState { canUndo: boolean; canRedo: boolean; clearable: boolean }
// Where Ctrl+Shift+S sends the capture: a PNG file, the clipboard, or both.
// Mirrors ScreenshotDest in src/ipc.ts (main compiles separately).
type ShotDest = 'file' | 'clipboard' | 'both'
const SHOT_DESTS: readonly ShotDest[] = ['file', 'clipboard', 'both']
interface Settings { protectUi: boolean; hotkeys?: Partial<HotkeyMap>; screenshotDir?: string; screenshotDest: ShotDest; restoreInk: boolean }

// One overlay per display, keyed by display id.
const overlays = new Map<number, BrowserWindow>()
// One input-catcher window per display (visible only in draw mode), keyed by
// display id, plus a reverse map from webContents id for routing its pointer
// traffic to the right ink overlay.
const inputs = new Map<number, BrowserWindow>()
const inputDisplayByWc = new Map<number, number>()
// Map an ink overlay's webContents id to its display, so a save-board or
// overlay-ready message can be routed to the right monitor's board.
const overlayDisplayByWc = new Map<number, number>()
// Display whose overlay is currently hosting the live eyedropper loupe.
let eyedropDisplayId: number | null = null
// True while the eyedropper session is active (blocks raiseStack from burying it).
let eyedropActive = false
// UI windows faded out for the session (opacity 0, still shown) so reveal doesn't
// remount / refit and jump. Hide/show was causing a visible scale blink.
let eyedropUiFaded = false
// Waiting for the toolbar to paint the picked colour before opacity returns.
let eyedropRevealTimer: NodeJS.Timeout | null = null
// Per-overlay history, keyed by webContents id; aggregated for the toolbar.
const overlayHistory = new Map<number, HistoryState>()
let toolbar: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
// Last resolved theme the toolbar broadcast, so lazily-created windows (the
// settings dialog) can paint the right background before their JS runs.
let resolvedTheme: 'light' | 'dark' = 'light'
let toolbarDrag:
  | { startX: number; startY: number; winX: number; winY: number }
  | null = null
let mouseModeFallback: NodeJS.Timeout | null = null

const SETTINGS_W = 640
const SETTINGS_H = 520
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
const state: AppState = { mode: false, highlight: false, bg: 'none', hidden: false, toolState: null }

// Persisted main-process settings. protectUi excludes the toolbar from screen
// capture (WDA_EXCLUDEFROMCAPTURE) so screen recordings and screenshots show ink
// but not the UI.
const settings: Settings = { protectUi: !IS_DEV, screenshotDest: 'file', restoreInk: true }
let hotkeys: HotkeyMap = { ...DEFAULT_HOTKEYS }
let hotkeyError: string | null = null
const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json')

function defaultScreenshotDir (): string {
  return path.join(app.getPath('pictures'), 'OpenPen')
}

function getScreenshotDir (): string {
  const dir = settings.screenshotDir?.trim()
  return dir || defaultScreenshotDir()
}

function sanitizeHotkeys (partial?: Partial<HotkeyMap>): Partial<HotkeyMap> {
  if (!partial) return {}
  const out: Partial<HotkeyMap> = {}
  for (const action of HOTKEY_ACTIONS) {
    const accel = partial[action]
    if (typeof accel !== 'string') continue
    if (accel === UNBOUND_HOTKEY || isValidAccelerator(accel)) out[action] = accel
  }
  return out
}

function loadSettings (): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>
    Object.assign(settings, {
      protectUi: raw.protectUi,
      screenshotDir: typeof raw.screenshotDir === 'string' ? raw.screenshotDir.trim() : undefined,
      screenshotDest: SHOT_DESTS.includes(raw.screenshotDest as ShotDest) ? raw.screenshotDest : 'file',
      restoreInk: typeof raw.restoreInk === 'boolean' ? raw.restoreInk : true
    })
    hotkeys = mergeHotkeys(sanitizeHotkeys(raw.hotkeys))
  } catch { /* first run */ }
  if (IS_DEV) settings.protectUi = false
}

function saveSettings (): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({
      protectUi: settings.protectUi,
      hotkeys: hotkeys,
      screenshotDir: settings.screenshotDir,
      screenshotDest: settings.screenshotDest,
      restoreInk: settings.restoreInk
    }))
  } catch (err) {
    console.error('failed to save settings', err)
  }
}

function applyUiCaptureProtection (): void {
  toolbar?.setContentProtection(!IS_DEV && settings.protectUi)
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

// Put an overlay above the Windows taskbar so ink covers the whole screen. The
// taskbar sits in the same always-on-top z-band, and a lone moveTop() can land
// under it; toggling always-on-top off→on re-inserts the window at the very top
// of that band, which reliably clears the taskbar.
function raiseOverlayTopmost (win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setAlwaysOnTop(false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
}

// --- Topmost reflex ----------------------------------------------------------
// The shell promotes the taskbar to the top of the topmost band after every
// activation change (window switches, taskbar clicks, Alt-Tab); there is no OS
// event to react to. The old fix — re-raising every window on a 300ms interval —
// was itself visible: each tick lifted the ink above the toolbar for a moment
// before the UI was raised back, and whenever DWM composed a frame inside that
// gap the ink blinked across the toolbar. So: no polling. Activation changes can
// only follow user input, and the uiohook global hook (already shipped for the
// cursor highlighter) hears all of it. A raise runs shortly after any global
// mouse-down or an Alt/Win key release — coalesced, and skipped while a stroke
// is in progress, since those clicks landed on OUR input catcher and can't have
// activated anything. An idle screen never reorders at all.

// In-flight draw gestures ("displayId:pointerId"), fed by the draw-input router,
// so the reflex can hold its fire until the stroke ends.
const liveGestures = new Set<string>()
let raiseTimers: NodeJS.Timeout[] = []
let raiseSuppressed = false
// True while the pending raise batch follows a click on the taskbar itself —
// the one trigger that reliably promotes the tray, and the case where a bare
// moveTop can lose for good if a window's real WS_EX_TOPMOST bit was stripped
// (Electron's cache still says it's set, so a plain setAlwaysOnTop no-ops).
// Those batches use the full off→on topmost toggle instead.
let raiseStrong = false
// Slow fallback watchdog, used only when the native hook can't load (e.g. no
// prebuild for this CPU). Degraded platforms keep taskbar recovery, with the
// old interval behaviour.
let raiseFallback: NodeJS.Timeout | null = null

// The invisible 1×1 "floor" anchor at the bottom of OpenPen's window stack.
// Raising ink with moveTop() lifts it above the toolbar/settings for the
// sub-millisecond until the UI is re-raised, and whenever DWM composes a frame
// inside that gap the ink visibly flashes THROUGH the UI window. The floor
// removes the crossing: only the floor (which has no pixels) ever moveTop()s;
// every visible window is then inserted directly above the floor, top-down, so
// each one only ever slides UP into a slot that is already below the UI.
// (Verified with a staged Electron experiment: inserting above a 1×1
// transparent anchor lands each window below everything placed earlier.)
let zFloor: BrowserWindow | null = null
function createZFloor (): void {
  zFloor = new BrowserWindow({
    x: 0, y: 0, width: 1, height: 1,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable: false,
    parent: createHiddenOwner()
  })
  zFloor.setAlwaysOnTop(true, 'screen-saver')
  zFloor.setIgnoreMouseEvents(true, { forward: false })
  zFloor.setMenu(null)
  zFloor.on('page-title-updated', ev => ev.preventDefault())
  zFloor.setTitle('OpenPen Anchor')
  zFloor.showInactive()
}

// One repair pass. The floor goes to the top of the band (invisible, so the
// crossing can't glitch), then every window is inserted directly above it in
// top-down order — toolbar, settings, catchers, ink — which yields
// floor < ink < catchers < settings < toolbar without any visible window ever
// passing above the UI. Paused during an eyedrop, which deliberately raises a
// frozen overlay above the UI windows so the whole screen stays sample-able.
function raiseStack (strong = false): void {
  if (eyedropDisplayId !== null || eyedropActive || state.hidden) return
  if (!zFloor || zFloor.isDestroyed()) return
  if (strong) raiseOverlayTopmost(zFloor)
  else zFloor.moveTop()
  const floorId = zFloor.getMediaSourceId()
  const above = (win: BrowserWindow | null): void => {
    // Skip hidden windows: a raise op (moveAbove/moveTop) RE-SHOWS a hidden
    // window on Windows (measured), so raising a hidden toolbar/settings would
    // resurrect it — the click reflex otherwise brings a Ctrl+Shift+T-hidden
    // toolbar back on screen, stuck click-through. Hidden windows have no
    // z-order slot to defend anyway.
    if (!win || win.isDestroyed() || !win.isVisible()) return
    try {
      win.moveAbove(floorId)
    } catch {
      win.moveTop()
    }
  }
  above(toolbar)
  above(settingsWin)
  if (state.mode) {
    for (const win of inputs.values()) {
      if (!win.isDestroyed()) above(win)
    }
  }
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue
    // The strong toggle rebuilds a stripped WS_EX_TOPMOST bit but re-inserts at
    // the top of the band; the immediate moveAbove pulls the ink back under the
    // UI, so the exposure is one adjacent call on taskbar clicks only.
    if (strong) raiseOverlayTopmost(win)
    above(win)
  }
}

// The taskbar promotion lands shortly AFTER the input event that caused it, so
// raise on a short delay, and once more in case the shell was slow. New
// triggers reset the pending batch (a strong trigger keeps the batch strong).
function scheduleRaise (strong = false): void {
  if (state.hidden) return
  raiseStrong = raiseStrong || strong
  for (const t of raiseTimers) clearTimeout(t)
  raiseTimers = [60, 250].map((delay, i) => setTimeout(() => {
    if (liveGestures.size > 0) {
      raiseSuppressed = true
      return
    }
    raiseStack(raiseStrong)
    if (i === 1) raiseStrong = false // batch finished
  }, delay))
}

// A stroke finished: run any raise that was held while it was live.
function gestureEnded (key: string): void {
  liveGestures.delete(key)
  if (liveGestures.size === 0 && raiseSuppressed) {
    raiseSuppressed = false
    raiseStack()
  }
}

// A point inside a display's bounds but outside its work area sits on the
// shell's reserved strip — the taskbar. uiohook reports physical pixels;
// Electron's screen geometry is in DIPs, so convert first (mixed-DPI safe).
function isTaskbarPoint (px: number, py: number): boolean {
  const p = screen.screenToDipPoint({ x: px, y: py })
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds
    if (p.x < b.x || p.x >= b.x + b.width || p.y < b.y || p.y >= b.y + b.height) continue
    const wa = d.workArea
    return p.x < wa.x || p.x >= wa.x + wa.width || p.y < wa.y || p.y >= wa.y + wa.height
  }
  return false
}

function onReflexMouse (e: HookMouseEvent): void {
  scheduleRaise(isTaskbarPoint(Number(e.x), Number(e.y)))
}

// Alt/Win releases are the moment Alt-Tab and Win+N switches actually land.
const REFLEX_KEYS = new Set([56, 3640, 3675, 3676]) // uiohook AltL, AltR, MetaL, MetaR
function onReflexKeyUp (e: HookKeyEvent): void {
  if (REFLEX_KEYS.has(Number(e.keycode))) scheduleRaise()
}

// Run the hook whenever ink windows are visible; hidden ink has no z-order to
// defend, so the hook (and any pending raises) stop with it.
function updateRaiseReflex (): void {
  if (!state.hidden) {
    void startMouseHook().then(() => {
      if (!uiohookRunning && !raiseFallback) {
        raiseFallback = setInterval(() => {
          if (liveGestures.size === 0) raiseStack()
        }, 1000)
      }
    })
  } else {
    for (const t of raiseTimers) clearTimeout(t)
    raiseTimers = []
    raiseSuppressed = false
    if (raiseFallback) {
      clearInterval(raiseFallback)
      raiseFallback = null
    }
    stopMouseHook()
  }
}

// The shell re-asserts the taskbar shortly AFTER an activation change, so a
// single synchronous raise can lose the race. Fire a short burst of re-raises
// around the two unavoidable focus transitions (text session start/end) to keep
// any taskbar pop to a frame or two.
function raiseBurst (): void {
  for (const delay of [40, 120, 250]) setTimeout(raiseStack, delay)
}

// The overlay currently holding keyboard focus for the text tool. Focus is held
// across text boxes (each acquire/release flips activation, which makes the
// shell flash the taskbar over fullscreen apps) and released only when the text
// session truly ends: tool change, draw-mode exit, or hiding the ink.
let textFocusWin: BrowserWindow | null = null

function releaseTextFocus (): void {
  const win = textFocusWin
  textFocusWin = null
  if (!win || win.isDestroyed()) return
  win.setFocusable(false)
  if (win.isFocused()) win.blur()
  // The blur is an activation change: the shell promotes the taskbar to topmost
  // in response, and blurring can also drop the transparent overlay's composited
  // ink. Re-assert the stack with the full off→on toggle and force a repaint.
  raiseStack(true)
  win.webContents.invalidate()
  raiseBurst()
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

// Every overlay/catcher window gets its OWN hidden owner window. Ownership keeps
// them out of Alt-Tab without the toolwindow style (which the shell pins the
// taskbar above) — but the owner must not be shared: attaching a second owned
// window to the same owner strips the existing sibling's WS_EX_TOPMOST
// (measured — the ink overlay silently lost its topmost bit the instant the
// input catcher was created, and no later heal works because Electron's cached
// always-on-top state says the flag is still set). One owner per window
// isolates them completely.
function createHiddenOwner (): BrowserWindow {
  return new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false
  })
}

// Destroy a window together with its private hidden owner.
function destroyWithOwner (win: BrowserWindow | undefined): void {
  if (!win || win.isDestroyed()) return
  const owner = win.getParentWindow()
  win.destroy()
  if (owner && !owner.isDestroyed()) owner.destroy()
}

// Electron clamps non-resizable windows to the display's WORK AREA (monitor
// minus taskbar) — both at construction and on setBounds — so a full-monitor
// overlay silently ends at the taskbar's top edge and ink "clips" there. The
// same trick fitToolbarHeight uses unclamps it: briefly resizable around the
// setBounds. (Full size is safe here because these windows are never focused and
// never opaque, so the shell's fullscreen-app handling and occlusion throttling
// don't kick in.)
function setBoundsUnclamped (win: BrowserWindow, b: Electron.Rectangle): void {
  win.setResizable(true)
  win.setBounds(b)
  win.setResizable(false)
  // Toggling resizable on Windows silently strips the native always-on-top bit
  // (measured: the input catcher ran with WS_EX_TOPMOST unset, so the taskbar —
  // which the shell promotes to topmost on activation changes — beat it for
  // good). Re-assert with a real off→on toggle; a plain set can no-op because
  // Electron still believes the flag is on.
  win.setAlwaysOnTop(false)
  win.setAlwaysOnTop(true, 'screen-saver')
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
    // Owned (not a toolwindow): out of Alt-Tab via ownership, yet still eligible
    // to sit above the taskbar (the shell pins the taskbar above toolwindows) —
    // see createHiddenOwner for why each window gets its own owner.
    parent: createHiddenOwner(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // The constructor clamped the height to the work area; unclamp to the true
  // monitor bounds so ink can cover the taskbar.
  setBoundsUnclamped(win, b)
  // Permanently click-through: a click-through window is never counted as
  // occluding the apps behind it, so videos/games keep playing under the ink.
  // Pointer input comes from the input-catcher window instead (createInput);
  // the only exceptions are text editing and the eyedropper, which flip this
  // temporarily because their UI lives in this window.
  win.setIgnoreMouseEvents(true, { forward: false })
  // Order matters: flipping click-through after the resizable dance strips the
  // native topmost bit again (measured), so the real raise comes after both.
  raiseOverlayTopmost(win)
  win.setMenu(null)
  // Stable title so window-capture tools can find the overlay per display.
  const title = index === 0 ? 'OpenPen Overlay' : `OpenPen Overlay ${index + 1}`
  win.on('page-title-updated', ev => ev.preventDefault())
  win.setTitle(title)
  // Activating a window makes the Windows shell re-raise the taskbar above the
  // rest of the topmost band, so when the overlay does take focus (text editing —
  // it's otherwise non-activating) immediately re-place the whole stack (all
  // topmost windows share one z-band, so focusing buried the UI).
  win.on('focus', () => raiseStack())
  load(win, 'overlay')
  win.once('ready-to-show', () => {
    if (!state.hidden) win.showInactive()
  })
  overlays.set(d.id, win)
  overlayDisplayByWc.set(win.webContents.id, d.id)
}

// The nearly-invisible input catcher for one display, stacked just above the ink
// overlay while draw mode is on. It takes the real pointer events (the ink
// window is permanently click-through) and forwards them over 'draw-input'. The
// opacity trick is the crux: a plain window at 1/255 alpha still receives every
// click, but Windows classifies it as see-through — the apps behind are never
// occlusion-throttled (background video keeps playing) and the shell never
// applies its fullscreen-app handling to it.
function createInput (d: Display): void {
  const b = d.bounds
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // Non-activating, like the ink overlay: clicks that draw never take keyboard
    // focus away from the app behind.
    focusable: false,
    backgroundColor: '#000000',
    opacity: 1 / 255,
    parent: createHiddenOwner(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Same work-area unclamp as the ink overlay: the catcher must cover the
  // taskbar too, or strokes over it fall through to the real taskbar.
  setBoundsUnclamped(win, b)
  win.setMenu(null)
  win.on('page-title-updated', ev => ev.preventDefault())
  win.setTitle('OpenPen Input')
  load(win, 'input')
  win.once('ready-to-show', () => {
    // A display hot-plugged while drawing should join the active draw session.
    if (state.mode && !state.hidden) {
      win.showInactive()
      raiseStack(true)
    }
  })
  inputs.set(d.id, win)
  inputDisplayByWc.set(win.webContents.id, d.id)
}

function createOverlays (): void {
  screen.getAllDisplays().forEach((d, i) => {
    createOverlay(d, i)
    createInput(d)
  })
}

function destroyOverlay (displayId: number): void {
  const win = overlays.get(displayId)
  overlays.delete(displayId)
  if (win && !win.isDestroyed()) {
    if (textFocusWin === win) textFocusWin = null
    const wcId = win.webContents.id
    overlayHistory.delete(wcId)
    // Persist whatever this overlay had queued before it goes away, then drop
    // its bindings.
    const binding = boardByWc.get(wcId)
    if (binding) flushBoard(binding.id)
    boardByWc.delete(wcId)
    overlayDisplayByWc.delete(wcId)
    destroyWithOwner(win)
  }
  const input = inputs.get(displayId)
  inputs.delete(displayId)
  if (input && !input.isDestroyed()) {
    inputDisplayByWc.delete(input.webContents.id)
    destroyWithOwner(input)
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
  // Toggling resizable on Windows silently strips the native always-on-top bit
  // (measured on the overlays; same trap here). Without this re-assert a later
  // moveTop can't lift the toolbar above topmost ink and it stays buried.
  toolbar.setAlwaysOnTop(false)
  toolbar.setAlwaysOnTop(true, 'screen-saver', 1)
}

// Re-arm the toolbar's click-through baseline. Showing a window doesn't
// re-establish the mouse-event forwarding that lets the renderer detect when the
// pointer is over the palette, so after any show the toolbar could stay
// non-interactive; re-applying it freshly registers forwarding, and the
// renderer flips to interactive on the next hover.
function armToolbarInput (): void {
  toolbar?.setIgnoreMouseEvents(true, { forward: true })
}

function toggleToolbar (): void {
  if (!toolbar || toolbar.isDestroyed()) return
  if (toolbar.isVisible()) {
    toolbar.hide()
  } else {
    toolbar.showInactive()
    armToolbarInput()
  }
}

// Bring the toolbar back into view (e.g. from the tray). Hiding the toolbar
// makes OpenPen look "closed" — only the tray icon remains — so a tray click
// should just reveal the UI again, never toggle drawing.
function showToolbar (): void {
  if (!toolbar || toolbar.isDestroyed()) return
  if (!toolbar.isVisible()) {
    toolbar.showInactive()
    armToolbarInput()
  }
  toolbar.moveTop()
}

// A conventional framed dialog (unlike the frameless overlay windows): the OS
// title bar gives native move and close. Kept above the overlays so it isn't
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
    x: Math.round(wa.x + (wa.width - SETTINGS_W) / 2),
    y: Math.round(wa.y + (wa.height - SETTINGS_H) / 2),
    title: 'OpenPen Settings',
    icon: appIconPath(),
    backgroundColor: resolvedTheme === 'dark' ? '#0a0a0a' : '#ffffff',
    show: false,
    resizable: false,
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
  settingsWin.on('closed', () => {
    setHotkeyCapture(false)
    settingsWin = null
  })
}

function fitOverlays (): void {
  for (const d of screen.getAllDisplays()) {
    const win = overlays.get(d.id)
    if (win && !win.isDestroyed()) setBoundsUnclamped(win, d.bounds)
    const input = inputs.get(d.id)
    if (input && !input.isDestroyed()) setBoundsUnclamped(input, d.bounds)
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
// events, then flip every overlay back to click-through. Drawing may have taken
// focus (the overlay is focusable so ink can cover the taskbar), so hand keyboard
// focus back to the app underneath on the way out.
function enterMouseMode (): void {
  for (const win of overlays.values()) repaintOverlayCursor(win)
  // Let Chromium process the synthetic move (and repaint the OS cursor) before
  // the overlay stops receiving events, otherwise the update can be dropped.
  setTimeout(() => {
    for (const win of overlays.values()) {
      if (win.isDestroyed()) continue
      win.setIgnoreMouseEvents(true, { forward: false })
      if (win.isFocused()) win.blur()
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
let aggHist: HistoryState = { canUndo: false, canRedo: false, clearable: false }

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

// --- Cursor highlighter ------------------------------------------------------
// A click-through presentation aid and a variant of mouse mode: the overlays
// stay pass-through so you keep using the apps underneath, while a halo follows
// the real cursor. On the primary button the halo pulses — it contracts on
// press and swells+fades on release (click feedback) —
// and Ctrl+Shift+wheel resizes it. The halo position is polled from the OS cursor
// (DIP coords, DPI-safe, works even if the native hook is unavailable) and
// forwarded to the overlay under the cursor; the button/wheel input is read from a
// lazily-loaded global hook (uiohook-napi) so it registers while the overlay
// ignores mouse events.
interface HookMouseEvent { button: number; x: number; y: number }
interface HookWheelEvent { rotation: number; ctrlKey: boolean; shiftKey: boolean }
interface HookKeyEvent { keycode: number }
interface Uiohook {
  on (event: 'mousedown' | 'mouseup', cb: (e: HookMouseEvent) => void): void
  on (event: 'wheel', cb: (e: HookWheelEvent) => void): void
  on (event: 'keyup', cb: (e: HookKeyEvent) => void): void
  start (): void
  stop (): void
}
let uiohook: Uiohook | null = null
let uiohookRunning = false
let hookListenerAttached = false
let highlightPoll: NodeJS.Timeout | null = null
let highlightDisplayId: number | null = null

// Only the primary button drives the pulse — libuiohook numbers it 1. Right /
// middle clicks (context menus, paste) shouldn't flash the ring mid-presentation.
// Press/release are broadcast to every overlay so a click-drag that crosses
// displays still resolves cleanly (only the overlay under the cursor paints it).
function onGlobalMouseDown (e: HookMouseEvent): void {
  if (!state.highlight || Number(e.button) !== 1) return
  sendOverlays('highlight-press', true)
}

function onGlobalMouseUp (e: HookMouseEvent): void {
  if (!state.highlight || Number(e.button) !== 1) return
  sendOverlays('highlight-press', false)
}

// Ctrl+Shift+wheel resizes the brush/halo. The modifiers keep plain scrolling
// free to reach the app underneath (the overlay is pass-through here). Routed
// through the toolbar, which owns and clamps the size and rebroadcasts it.
function onGlobalWheel (e: HookWheelEvent): void {
  if (!state.highlight || !e.ctrlKey || !e.shiftKey) return
  // libuiohook reports a negative rotation for scroll-up here; scrolling up grows.
  send(toolbar, 'adjust-size', e.rotation > 0 ? -1 : 1)
}

// Start (once) the global hook that reads clicks and the wheel anywhere on
// screen. It's loaded on first use and guarded: if the native module is missing
// the halo still follows the cursor, only the pulse and wheel-resize are skipped.
async function startMouseHook (): Promise<void> {
  if (uiohookRunning) return
  try {
    if (!uiohook) {
      const mod = await import('uiohook-napi') as unknown as { uIOhook?: Uiohook, default?: { uIOhook?: Uiohook } }
      uiohook = mod.uIOhook ?? mod.default?.uIOhook ?? null
    }
    if (!uiohook) return
    if (!hookListenerAttached) {
      uiohook.on('mousedown', onGlobalMouseDown)
      uiohook.on('mouseup', onGlobalMouseUp)
      uiohook.on('wheel', onGlobalWheel)
      // The topmost reflex shares the hook: any click or Alt/Win release may be
      // the activation change that promotes the taskbar over the ink. Mouse-ups
      // count too — taskbar flyouts open on release.
      uiohook.on('mousedown', onReflexMouse)
      uiohook.on('mouseup', onReflexMouse)
      uiohook.on('keyup', onReflexKeyUp)
      hookListenerAttached = true
    }
    uiohook.start()
    uiohookRunning = true
  } catch (err) {
    console.error('cursor highlighter: global mouse hook unavailable', err)
  }
}

function stopMouseHook (): void {
  if (!uiohookRunning || !uiohook) return
  try {
    uiohook.stop()
  } catch (err) {
    console.error('cursor highlighter: failed to stop mouse hook', err)
  }
  uiohookRunning = false
}

// Forward the live cursor position to the overlay on the display it's over, and
// hide the halo on the display it just left.
function pushHighlightPointer (): void {
  const p = screen.getCursorScreenPoint()
  const d = screen.getDisplayNearestPoint(p)
  if (highlightDisplayId !== d.id) {
    if (highlightDisplayId !== null) {
      const prev = overlays.get(highlightDisplayId)
      if (prev && !prev.isDestroyed()) send(prev, 'highlight-pointer', null)
    }
    highlightDisplayId = d.id
  }
  const win = overlays.get(d.id)
  if (win && !win.isDestroyed()) {
    send(win, 'highlight-pointer', { x: p.x - d.bounds.x, y: p.y - d.bounds.y })
  }
}

function startHighlightTracking (): void {
  if (!highlightPoll) highlightPoll = setInterval(pushHighlightPointer, 8)
  void startMouseHook()
}

function stopHighlightTracking (): void {
  if (highlightPoll) {
    clearInterval(highlightPoll)
    highlightPoll = null
  }
  if (highlightDisplayId !== null) {
    const win = overlays.get(highlightDisplayId)
    if (win && !win.isDestroyed()) send(win, 'highlight-pointer', null)
    highlightDisplayId = null
  }
  // The hook stays up for the topmost reflex; updateRaiseReflex stops it when
  // the ink is hidden (the only time neither consumer needs it).
}

function setHighlight (on: boolean): void {
  // Highlight is a mouse-mode variant, so turning it on drops out of draw mode.
  if (on && state.mode) setDrawMode(false)
  if (state.highlight === on) {
    if (on) startHighlightTracking()
    return
  }
  state.highlight = on
  if (on) {
    if (state.hidden) setHidden(false)
    // Keep the (click-through) overlays above everything — taskbar included — so
    // the halo paints over the whole screen; the strong pass re-asserts topmost
    // bits without the ink crossing OpenPen's own UI.
    raiseStack(true)
    startHighlightTracking()
  } else {
    stopHighlightTracking()
  }
  updateRaiseReflex()
  broadcast('highlight', state.highlight)
}

function setDrawMode (on: boolean): void {
  if (on) setHighlight(false)
  state.mode = on
  if (state.mode && state.hidden) setHidden(false)
  if (mouseModeFallback) {
    clearTimeout(mouseModeFallback)
    mouseModeFallback = null
  }
  broadcast('mode', state.mode)
  updateGlobalEditShortcuts()
  updateRaiseReflex()
  if (state.mode) {
    // The ink overlays stay click-through even while drawing; the input catchers
    // shown just above them take the pointer instead. Nothing gets focused, so
    // the app underneath keeps keyboard input (and keeps playing) as you draw.
    // Show the catchers first (they're at 1/255 alpha, so wherever showInactive
    // drops them is invisible), then one strong stack pass places everything:
    // the toggle re-asserts topmost bits (the taskbar may have been promoted
    // since, and a window missing its bit loses forever) without the ink ever
    // crossing the toolbar or settings window.
    for (const win of inputs.values()) {
      if (!win.isDestroyed()) win.showInactive()
    }
    raiseStack(true)
  } else {
    // Leaving draw mode ends any text session: hand the keyboard back to the
    // app underneath (this commits an open edit via the textarea's blur).
    releaseTextFocus()
    for (const win of inputs.values()) {
      if (!win.isDestroyed()) win.hide()
    }
    // Hidden catchers never deliver their pointer-ups; drop any gestures still
    // marked live so they can't hold the reflex's raises hostage.
    liveGestures.clear()
    if (raiseSuppressed) {
      raiseSuppressed = false
      raiseStack()
    }
    mouseModeFallback = setTimeout(() => {
      enterMouseMode()
      mouseModeFallback = null
    }, 120)
  }
  tray?.setToolTip(`OpenPen: ${state.mode ? 'drawing' : 'mouse'} mode (Ctrl+Shift+D)`)
}

function setHidden (hidden: boolean): void {
  state.hidden = hidden
  if (hidden) releaseTextFocus()
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue
    if (state.hidden) win.hide()
    else win.showInactive()
  }
  if (state.hidden && state.mode) setDrawMode(false)
  // Hiding the ink hides the halo's canvas too, so keeping highlight "on" would
  // just leave the cursor poll + global mouse hook running invisibly.
  if (state.hidden && state.highlight) setHighlight(false)
  broadcast('hidden', state.hidden)
  updateGlobalEditShortcuts()
  updateRaiseReflex()
  // Freshly re-shown windows land wherever the shell left them; the reflex only
  // fires on input, so restack once now — strongly, since anything may have
  // happened to the topmost bits while the windows sat hidden.
  if (!state.hidden) raiseStack(true)
}

function toggleBg (c: Bg): void {
  state.bg = state.bg === c ? 'none' : c
  if (state.bg !== 'none' && state.hidden) setHidden(false)
  broadcast('bg', state.bg)
}

function pushHistory (): void {
  let canUndo = false
  let canRedo = false
  let clearable = false
  for (const h of overlayHistory.values()) {
    canUndo = canUndo || h.canUndo
    canRedo = canRedo || h.canRedo
    clearable = clearable || h.clearable
  }
  aggHist = { canUndo, canRedo, clearable }
  send(toolbar, 'history', aggHist)
  updateGlobalEditShortcuts()
}

// clear and reset-history wipe every display; undo/redo act on the display under
// the cursor.
function runCmd (name: string): void {
  if (name === 'clear' || name === 'reset-history') sendOverlays('cmd', name)
  else send(overlayAtCursor(), 'cmd', name)
}

// Grab a screenshot of one display at its native pixel resolution. Used by the
// screenshot feature; hides the resolution math and the per-display source
// lookup (with fallback). Null when the OS returns no usable source.
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


// Captures the display under the cursor. OpenPen's own screenshot includes the
// toolbar so users can capture and share the UI while iterating.
async function shoot (): Promise<void> {
  const d = displayAtCursor()
  const restoreProtection = settings.protectUi
  send(toolbar, 'screenshotting', true)
  try {
    if (restoreProtection) {
      toolbar?.setContentProtection(false)
    }
    await new Promise(r => setTimeout(r, 120)) // let UI cleanup and capture protection settle
    const img = await captureDisplay(d)
    if (!img) {
      notify('OpenPen', 'Screenshot failed. Try again.')
      return
    }
    const dest = settings.screenshotDest
    // Clipboard gets the native image directly; the file path is the anchor for
    // the "reveal in folder" notification when we also wrote one.
    if (dest === 'clipboard' || dest === 'both') clipboard.writeImage(img)
    let file: string | null = null
    if (dest === 'file' || dest === 'both') {
      const dir = getScreenshotDir()
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      file = path.join(dir, `openpen-${stamp}.png`)
      fs.writeFileSync(file, img.toPNG())
    }
    const body = file
      ? (dest === 'both' ? `Screenshot copied and saved:\n${file}` : `Screenshot saved:\n${file}`)
      : 'Screenshot copied to clipboard'
    const toast = file
      ? (dest === 'both' ? 'Saved and copied' : 'Screenshot saved')
      : 'Copied to clipboard'
    send(toolbar, 'screenshot-saved', toast)
    const n = new Notification({ title: 'OpenPen', body })
    if (file) {
      const saved = file
      n.on('click', () => shell.showItemInFolder(saved))
    }
    n.show()
  } catch (err) {
    console.error('screenshot failed', err)
    notify('OpenPen', 'Screenshot failed. Try again.')
  } finally {
    if (restoreProtection) applyUiCaptureProtection()
    send(toolbar, 'screenshotting', false)
  }
}

// --- Board export ------------------------------------------------------------
// Export just the annotations (the vector ink), not the screen behind them, as a
// shareable PNG/SVG/PDF — distinct from the screenshot, which bakes ink onto a
// capture of the display. The overlay under the cursor renders its board (a PNG
// data URL or an SVG string) and replies on 'export-result'; a PDF wraps the PNG
// via Chromium's own printToPDF, so there's no third-party PDF dependency.
type ExportFormat = 'png' | 'svg' | 'pdf'
let pendingExport: { format: ExportFormat; filePath: string } | null = null

async function exportBoard (): Promise<void> {
  const win = overlays.get(displayAtCursor().id)
  if (!win || win.isDestroyed()) return
  const parent = (settingsWin && !settingsWin.isDestroyed())
    ? settingsWin
    : (toolbar && !toolbar.isDestroyed()) ? toolbar : undefined
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const opts: Electron.SaveDialogOptions = {
    title: 'Export annotations',
    defaultPath: path.join(getScreenshotDir(), `openpen-board-${stamp}.png`),
    filters: [
      { name: 'PNG image', extensions: ['png'] },
      { name: 'SVG vector', extensions: ['svg'] },
      { name: 'PDF document', extensions: ['pdf'] }
    ]
  }
  const result = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return
  const ext = path.extname(result.filePath).toLowerCase()
  const format: ExportFormat = ext === '.svg' ? 'svg' : ext === '.pdf' ? 'pdf' : 'png'
  pendingExport = { format, filePath: result.filePath }
  // SVG needs the vector string; PNG and PDF both start from the raster.
  send(win, 'export-board', format === 'svg' ? 'svg' : 'png')
}

interface ExportOk { ok: true; kind: 'png' | 'svg'; data: string; width: number; height: number }
function isExportOk (p: unknown): p is ExportOk {
  if (typeof p !== 'object' || p === null) return false
  const r = p as { ok?: unknown; data?: unknown; width?: unknown; height?: unknown }
  return r.ok === true && typeof r.data === 'string' && typeof r.width === 'number' && typeof r.height === 'number'
}

function dataUrlToBuffer (dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  return Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64')
}

async function finishExport (payload: unknown): Promise<void> {
  const job = pendingExport
  pendingExport = null
  if (!job) return
  if (!isExportOk(payload)) {
    const empty = typeof payload === 'object' && payload !== null &&
      (payload as { error?: unknown }).error === 'empty'
    notify('OpenPen', empty ? 'Nothing to export — the board is empty.' : 'Could not export the board.')
    return
  }
  try {
    if (job.format === 'svg') {
      fs.writeFileSync(job.filePath, payload.data, 'utf8')
    } else if (job.format === 'png') {
      fs.writeFileSync(job.filePath, dataUrlToBuffer(payload.data))
    } else {
      await writePdfFromImage(payload.data, payload.width, payload.height, job.filePath)
    }
    const saved = job.filePath
    // Reveal the exported file in its folder right away, and leave a clickable
    // notification to re-open it later.
    shell.showItemInFolder(saved)
    notify('OpenPen', `Board exported:\n${saved}`, () => shell.showItemInFolder(saved))
  } catch (err) {
    console.error('board export failed', err)
    notify('OpenPen', 'Could not export the board.')
  }
}

// Wrap a PNG in a single-page PDF the exact size of the board, using Chromium's
// own PDF engine (no PDF dependency). The image and an HTML wrapper go to temp
// files — a multi-MB data URL can exceed loadURL's limits — and preferCSSPageSize
// honours the @page size so the page matches the artwork with no margins.
async function writePdfFromImage (dataUrl: string, width: number, height: number, filePath: string): Promise<void> {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const base = path.join(app.getPath('temp'), `openpen-export-${randomUUID()}`)
  const pngPath = `${base}.png`
  const htmlPath = `${base}.html`
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    fs.writeFileSync(pngPath, dataUrlToBuffer(dataUrl))
    const imgUrl = pathToFileURL(pngPath).href
    fs.writeFileSync(htmlPath,
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      `@page { size: ${w}px ${h}px; margin: 0 }` +
      'html,body { margin: 0; padding: 0 }' +
      `img { display: block; width: ${w}px; height: ${h}px }` +
      `</style></head><body><img src="${imgUrl}"></body></html>`)
    await pdfWin.loadFile(htmlPath)
    const pdf = await pdfWin.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    fs.writeFileSync(filePath, pdf)
  } finally {
    if (!pdfWin.isDestroyed()) pdfWin.destroy()
    fs.rmSync(pngPath, { force: true })
    fs.rmSync(htmlPath, { force: true })
  }
}

// Live screen colour picker. Samples a tiny region under the cursor via Win32
// BitBlt on every move — no full-display freeze. The toolbar stays shown at
// opacity 0 and click-through (not hide/show, not z-raised) so reveal is a
// plain opacity restore with no Windows recompose zoom.
function startEyedrop (): void {
  if (eyedropDisplayId !== null || eyedropActive) return
  if (state.hidden) setHidden(false)
  const d = displayAtCursor()
  const win = overlays.get(d.id)
  if (!win || win.isDestroyed()) return
  if (eyedropRevealTimer) {
    clearTimeout(eyedropRevealTimer)
    eyedropRevealTimer = null
  }
  eyedropActive = true
  eyedropDisplayId = d.id
  // Fade UI out without hide() or raiseStack: hide/show refits height, and
  // moveAbove/topmost toggles recompose as a zoom. Opacity 0 + click-through
  // lets the loupe sit under the (invisible) toolbar and still receive input.
  eyedropUiFaded = true
  if (toolbar && !toolbar.isDestroyed()) {
    toolbar.setContentProtection(true)
    toolbar.setIgnoreMouseEvents(true, { forward: false })
    toolbar.setOpacity(0)
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.setContentProtection(true)
    settingsWin.setIgnoreMouseEvents(true, { forward: false })
    settingsWin.setOpacity(0)
  }
  // Same as text editing: in draw mode the input catchers sit above the ink
  // overlay and would steal every pointer event, freezing the loupe at its
  // seed position. Drop them for the session so the overlay can drive the pick.
  for (const iw of inputs.values()) {
    if (!iw.isDestroyed()) iw.hide()
  }
  // Exclude this overlay from BitBlt so live samples see the desktop underneath
  // the transparent loupe window, not our own pixels.
  win.setContentProtection(true)
  win.setIgnoreMouseEvents(false, { forward: false })
  const cur = screen.getCursorScreenPoint()
  send(win, 'eyedrop', {
    x: cur.x - d.bounds.x,
    y: cur.y - d.bounds.y
  })
  // Escape cancels; the non-activating overlay can't get key focus, so grab it
  // globally for the duration and hand it back in endEyedrop.
  globalShortcut.register('Escape', () => endEyedrop())
}

// Tear down the loupe overlay and Escape grab. Optionally leave the toolbar
// faded so a picked colour can paint before opacity returns.
function endEyedrop (opts?: { keepUiFaded?: boolean }): void {
  if (!eyedropActive && eyedropDisplayId === null && !eyedropUiFaded) return
  const win = eyedropDisplayId !== null ? overlays.get(eyedropDisplayId) : undefined
  eyedropDisplayId = null
  eyedropActive = false
  if (win && !win.isDestroyed()) {
    send(win, 'eyedrop', null)
    win.setContentProtection(false)
    win.setIgnoreMouseEvents(true, { forward: false })
  }
  // Hand the pointer back to the catchers when still drawing (mirrors the
  // text-editing release path). Defer raiseStack to revealEyedropUi so it
  // doesn't recompose the toolbar as a zoom while opacity is still 0.
  if (state.mode && !state.hidden) {
    for (const iw of inputs.values()) {
      if (!iw.isDestroyed()) iw.showInactive()
    }
  }
  // Release our Escape grab and let the normal draw-mode gating reclaim it.
  globalShortcut.unregister('Escape')
  escShortcutOn = false
  updateGlobalEditShortcuts()
  if (!state.mode) enterMouseMode()
  if (opts?.keepUiFaded) return
  revealEyedropUi()
}

function revealEyedropUi (): void {
  if (eyedropRevealTimer) {
    clearTimeout(eyedropRevealTimer)
    eyedropRevealTimer = null
  }
  if (!eyedropUiFaded) return
  eyedropUiFaded = false
  // Opacity only. Any other window API (raiseStack, topmost, contentProtection,
  // ignoreMouseEvents) makes Windows recompose the toolbar as a zoom.
  if (toolbar && !toolbar.isDestroyed()) toolbar.setOpacity(1)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setOpacity(1)
  // Restore input + capture protection on the next tick, after opacity has
  // settled, so those calls can't hitch the reveal frame.
  setTimeout(() => {
    if (toolbar && !toolbar.isDestroyed()) armToolbarInput()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setIgnoreMouseEvents(false)
    applyUiCaptureProtection()
    // Catchers were re-shown in endEyedrop; slot them under the toolbar now
    // that opacity has settled (eyedropActive no longer blocks raiseStack).
    if (state.mode && !state.hidden) raiseStack(true)
  }, 0)
}

// Overlay-local CSS point → physical screen pixels for BitBlt.
function eyedropPhysicalPoint (cssX: number, cssY: number): { x: number; y: number } | null {
  if (eyedropDisplayId === null) return null
  const win = overlays.get(eyedropDisplayId)
  if (!win || win.isDestroyed()) return null
  const b = win.getBounds()
  return screen.dipToScreenPoint({ x: b.x + cssX, y: b.y + cssY })
}

function showCaptureHelp (): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'OpenPen: screen capture setup',
    message: 'Capturing your annotations in recordings, calls, and screenshots',
    detail: [
      'OpenPen ink is drawn in a normal on-screen window, so any full-screen (display) capture source records it automatically. This is the recommended setup.',
      '',
      'If your recorder captures a single window or game only, add a window-capture source for the window named "OpenPen Overlay" (one per display), place it above your game source, and — if the overlay records as black — switch that source to the newer Windows Graphics Capture method.',
      '',
      '"Hide toolbar from capture" (in the tray menu, on by default) keeps the toolbar and color picker visible to you but excluded from recordings, screenshots, and other screen capture.'
    ].join('\n')
  })
}

function iconBaseName (): string {
  return app.isPackaged ? 'icon' : 'icon-dev'
}

function appIconPath (): string {
  // Windows taskbar/title bar reads multi-size assets from .ico; other platforms use .png.
  const base = iconBaseName()
  const file = process.platform === 'win32' ? `${base}.ico` : `${base}.png`
  return path.join(__dirname, '..', 'build', file)
}

function makeTrayIcon (): Electron.NativeImage {
  const iconPath = path.join(__dirname, '..', 'build', `${iconBaseName()}.png`)
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
  hotkeys: HotkeyMap
  hotkeyError: string | null
  screenshotDir: string
  screenshotDirDefault: string
  screenshotDest: ShotDest
  restoreInk: boolean
  isDev: boolean
  version: string
  canUpdate: boolean
  updateStatus: UpdateStatus
  updateVersion: string | null
  updateError: string | null
} {
  return {
    protectUi: settings.protectUi,
    hotkeys,
    hotkeyError,
    screenshotDir: getScreenshotDir(),
    screenshotDirDefault: defaultScreenshotDir(),
    screenshotDest: settings.screenshotDest,
    restoreInk: settings.restoreInk,
    isDev: IS_DEV,
    version: app.getVersion(),
    canUpdate: app.isPackaged,
    updateStatus,
    updateVersion: updateReadyVersion ?? updatePendingVersion,
    updateError
  }
}

function updateAvailable (): boolean {
  return updateStatus === 'downloading' || updateStatus === 'ready'
}

function resetScreenshotDir (): void {
  settings.screenshotDir = undefined
  saveSettings()
  broadcastSettingsState()
}

function openScreenshotDir (): void {
  const dir = getScreenshotDir()
  fs.mkdirSync(dir, { recursive: true })
  void shell.openPath(dir)
}

async function pickScreenshotDir (): Promise<void> {
  const parent = settingsWin && !settingsWin.isDestroyed()
    ? settingsWin
    : toolbar && !toolbar.isDestroyed()
      ? toolbar
      : undefined
  const opts: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: getScreenshotDir(),
    title: 'Choose screenshot save folder'
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || result.filePaths.length === 0) return
  settings.screenshotDir = result.filePaths[0]
  saveSettings()
  broadcastSettingsState()
}

function broadcastHotkeys (): void {
  if (toolbar && !toolbar.isDestroyed()) send(toolbar, 'hotkeys', hotkeys)
}

function broadcastSettingsState (): void {
  const state = buildSettingsState()
  if (settingsWin && !settingsWin.isDestroyed()) send(settingsWin, 'settings-state', state)
  broadcastHotkeys()
  if (toolbar && !toolbar.isDestroyed()) {
    send(toolbar, 'update-badge', { available: updateAvailable() })
  }
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
  })
  autoUpdater.on('update-not-available', () => {
    updateStatus = manualUpdateCheck ? 'uptodate' : 'idle'
    updatePendingVersion = null
    updateError = null
    broadcastSettingsState()
    manualUpdateCheck = false
  })
  autoUpdater.on('update-downloaded', info => {
    const fromManualCheck = manualUpdateCheck
    updateReadyVersion = info.version
    updatePendingVersion = null
    updateStatus = 'ready'
    updateError = null
    manualUpdateCheck = false
    refreshTray()
    broadcastSettingsState()
    if (!fromManualCheck) {
      notify('OpenPen', `Update v${info.version} is ready. Restart to install.`,
        () => autoUpdater.quitAndInstall())
    }
  })
  autoUpdater.on('error', err => {
    console.error('auto-update error', err)
    updateStatus = manualUpdateCheck ? 'error' : 'idle'
    updateError = err instanceof Error ? err.message : String(err)
    broadcastSettingsState()
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
  const hk = hotkeys
  const withAccel = (accel: string, item: Electron.MenuItemConstructorOptions): Electron.MenuItemConstructorOptions =>
    isHotkeyBound(accel) ? { ...item, accelerator: accel } : item
  const template: Electron.MenuItemConstructorOptions[] = [
    withAccel(hk.toggleDraw, { label: 'Toggle drawing', click: () => setDrawMode(!state.mode) }),
    withAccel(hk.clear, { label: 'Clear screens', click: () => runCmd('clear') }),
    withAccel(hk.toggleHide, { label: 'Hide/show ink', click: () => setHidden(!state.hidden) }),
    withAccel(hk.toggleToolbar, { label: 'Show/hide toolbar', click: toggleToolbar }),
    withAccel(hk.screenshot, { label: 'Screenshot', click: () => { void shoot() } }),
    { label: 'Export annotations…', click: () => { void exportBoard() } },
    { type: 'separator' },
    {
      label: IS_DEV ? 'Hide toolbar from capture (disabled in dev)' : 'Hide toolbar from capture',
      type: 'checkbox',
      checked: !IS_DEV && settings.protectUi,
      enabled: !IS_DEV,
      click: item => {
        settings.protectUi = item.checked
        applyUiCaptureProtection()
        saveSettings()
      }
    },
    { label: 'Screen capture setup…', click: showCaptureHelp }
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
  tray.setToolTip(
    isHotkeyBound(hotkeys.toggleDraw)
      ? `OpenPen: mouse mode (${hotkeys.toggleDraw})`
      : 'OpenPen'
  )
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showToolbar)
}

// The tray's "Hide toolbar from capture" checkbox mirrors settings.protectUi;
// rebuild the menu so it stays in sync when changed from the settings window.
function refreshTray (): void {
  tray?.setToolTip(
    isHotkeyBound(hotkeys.toggleDraw)
      ? `OpenPen: mouse mode (${hotkeys.toggleDraw})`
      : 'OpenPen'
  )
  tray?.setContextMenu(buildTrayMenu())
}

type HotkeyHandler = { action: HotkeyAction; accel: string; fn: () => void }

let registeredAccelerators: string[] = []
let hotkeyCaptureActive = false

function setHotkeyCapture (on: boolean): void {
  if (hotkeyCaptureActive === on) return
  hotkeyCaptureActive = on
  if (on) {
    unregisterConfigurableShortcuts()
    globalShortcut.unregister('CommandOrControl+Z')
    globalShortcut.unregister('CommandOrControl+Shift+Z')
    globalShortcut.unregister('CommandOrControl+Y')
    globalShortcut.unregister('Escape')
  } else {
    registerConfigurableShortcuts()
    updateGlobalEditShortcuts()
  }
}

function hotkeyHandlers (map: HotkeyMap): HotkeyHandler[] {
  const handlers: HotkeyHandler[] = [
    { action: 'toggleDraw', accel: map.toggleDraw, fn: () => setDrawMode(!state.mode) },
    { action: 'mouseMode', accel: map.mouseMode, fn: () => { setHighlight(false); setDrawMode(false) } },
    { action: 'highlightCursor', accel: map.highlightCursor, fn: () => setHighlight(!state.highlight) },
    { action: 'clear', accel: map.clear, fn: () => runCmd('clear') },
    { action: 'undo', accel: map.undo, fn: () => runCmd('undo') },
    { action: 'redo', accel: map.redo, fn: () => runCmd('redo') },
    { action: 'screenshot', accel: map.screenshot, fn: () => { void shoot() } },
    { action: 'whiteboard', accel: map.whiteboard, fn: () => toggleBg('white') },
    { action: 'blackboard', accel: map.blackboard, fn: () => toggleBg('black') },
    { action: 'toggleHide', accel: map.toggleHide, fn: () => setHidden(!state.hidden) },
    { action: 'toggleToolbar', accel: map.toggleToolbar, fn: toggleToolbar }
  ]
  for (const action of HOTKEY_ACTIONS) {
    if (!action.startsWith('tool:')) continue
    const tool = action.slice(5)
    handlers.push({
      action,
      accel: map[action],
      fn: () => send(toolbar, 'pick-tool', tool)
    })
  }
  return handlers.filter(h => isHotkeyBound(h.accel))
}

function unregisterConfigurableShortcuts (): void {
  for (const accel of registeredAccelerators) globalShortcut.unregister(accel)
  registeredAccelerators = []
}

// Best-effort: register every bound hotkey and return the accelerators that
// could not be grabbed (typically already taken by another app). One stolen
// shortcut must not cost all the others — at startup the app previously rolled
// back EVERY hotkey when a single register failed, leaving it silently
// shortcut-dead. Failures are logged and reported to the settings UI instead.
function registerConfigurableShortcuts (): string[] {
  unregisterConfigurableShortcuts()
  const failed: string[] = []
  const registered: string[] = []
  for (const { accel, fn } of hotkeyHandlers(hotkeys)) {
    let ok: boolean
    try { ok = globalShortcut.register(accel, fn) } catch { ok = false }
    if (ok) registered.push(accel)
    else failed.push(accel)
  }
  registeredAccelerators = registered
  if (failed.length > 0) console.error('hotkeys not registered:', failed.join(', '))
  return failed
}

function applyHotkeys (): string | null {
  const previous = { ...hotkeys }
  if (registerConfigurableShortcuts().length === 0) {
    hotkeyError = null
    refreshTray()
    return null
  }
  hotkeys = previous
  if (registerConfigurableShortcuts().length > 0) {
    console.error('failed to restore hotkeys after registration error')
  }
  return 'That shortcut could not be registered. It may already be in use by another app.'
}

function setHotkey (action: HotkeyAction, accelerator: string, force = false): void {
  if (accelerator === UNBOUND_HOTKEY) {
    hotkeys = { ...hotkeys, [action]: UNBOUND_HOTKEY }
    hotkeyError = null
    applyHotkeys()
    settings.hotkeys = hotkeys
    saveSettings()
    broadcastSettingsState()
    return
  }
  if (!isValidAccelerator(accelerator)) {
    hotkeyError = 'Use at least one modifier (Ctrl, Alt, or Shift) plus a key.'
    broadcastSettingsState()
    return
  }
  const conflict = findHotkeyConflict(hotkeys, action, accelerator)
  if (conflict && !force) {
    hotkeyError = 'That shortcut is already assigned to another action.'
    broadcastSettingsState()
    return
  }
  const next = conflict && force
    ? { ...hotkeys, [conflict]: UNBOUND_HOTKEY, [action]: accelerator }
    : { ...hotkeys, [action]: accelerator }
  const prev = hotkeys
  hotkeys = next
  const err = applyHotkeys()
  if (err) {
    hotkeyError = err
    hotkeys = prev
    applyHotkeys()
  } else {
    hotkeyError = null
    settings.hotkeys = hotkeys
    saveSettings()
  }
  broadcastSettingsState()
}

function resetHotkeys (): void {
  hotkeys = { ...DEFAULT_HOTKEYS }
  settings.hotkeys = hotkeys
  hotkeyError = null
  applyHotkeys()
  saveSettings()
  broadcastSettingsState()
}

// --- Ink persistence ---------------------------------------------------------
// One saved board per display (auto-resume). boardStore is the swappable storage
// seam (JSON files today; a SQLite impl of the same interface later needs no
// caller changes). Autosaves are debounced here, coalescing a burst of strokes
// into one write, and flushed on display removal and quit.
let boardStore: BoardStore
interface BoardBinding { id: string; displayKey: string | null }
const boardByWc = new Map<number, BoardBinding>()
const pendingBoards = new Map<string, StoredBoard>()
const boardSaveTimers = new Map<string, NodeJS.Timeout>()
const BOARD_SAVE_DEBOUNCE = 500

// A per-display key that stays stable across launches while the monitor layout
// is unchanged (the common fixed-desk case). Position is included so two
// identical monitors never collide onto one board — a same-session correctness
// bug — at the cost of not restoring ink if the displays are later rearranged.
function displaySignature (d: Display): string {
  const b = d.bounds
  return `${b.x},${b.y}_${b.width}x${b.height}@${d.scaleFactor}`
}

// This display's saved board, or a fresh empty one keyed to it.
function boardForDisplay (displayId: number): StoredBoard {
  const d = screen.getAllDisplays().find(x => x.id === displayId)
  const key = d ? displaySignature(d) : `display-${displayId}`
  const meta = boardStore.list().find(m => m.displayKey === key)
  if (meta) {
    const loaded = boardStore.load(meta.id)
    if (loaded) return loaded
  }
  return {
    version: 1, id: randomUUID(), displayKey: key,
    name: 'Display board', updatedAt: Date.now(),
    doc: { version: 1, ops: [], idSeq: 1 }
  }
}

// On overlay boot: bind its webContents to the right board, and if restore is on
// and there's ink, send it down to rehydrate. The binding is set even when empty
// or disabled so later autosaves know their target.
function loadBoardForOverlay (sender: Electron.WebContents, displayId: number): void {
  const board = boardForDisplay(displayId)
  boardByWc.set(sender.id, { id: board.id, displayKey: board.displayKey })
  const restore = settings.restoreInk && board.doc.ops.length > 0
  sender.send('load-board', restore ? board.doc : null)
}

function coerceDoc (payload: unknown): SerializedDoc | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { version?: unknown; ops?: unknown; idSeq?: unknown }
  if (!Array.isArray(p.ops) || typeof p.idSeq !== 'number') return null
  return { version: typeof p.version === 'number' ? p.version : 1, ops: p.ops, idSeq: p.idSeq }
}

// An overlay's ink changed. Ignored entirely when restore is off — that setting
// means "keep no ink on disk". An empty document deletes the board file rather
// than persisting something that renders to nothing.
function saveBoardFromOverlay (wcId: number, payload: unknown): void {
  if (!settings.restoreInk) return
  const binding = boardByWc.get(wcId)
  if (!binding) return
  const doc = coerceDoc(payload)
  if (!doc) return
  scheduleBoardSave({
    version: 1, id: binding.id, displayKey: binding.displayKey,
    name: 'Display board', updatedAt: Date.now(), doc
  })
}

// Immediate, synchronous save from an overlay (used at quit/teardown). The async
// 'save-board' path can arrive after the quit-time flush and be dropped; writing
// straight through here — bypassing the debounce — guarantees the final state
// (e.g. a clear) reaches disk before the app exits.
function saveBoardImmediate (wcId: number, payload: unknown): void {
  if (!settings.restoreInk) return
  const binding = boardByWc.get(wcId)
  if (!binding) return
  const doc = coerceDoc(payload)
  if (!doc) return
  pendingBoards.set(binding.id, {
    version: 1, id: binding.id, displayKey: binding.displayKey,
    name: 'Display board', updatedAt: Date.now(), doc
  })
  flushBoard(binding.id)
}

function scheduleBoardSave (board: StoredBoard): void {
  pendingBoards.set(board.id, board)
  const t = boardSaveTimers.get(board.id)
  if (t) clearTimeout(t)
  boardSaveTimers.set(board.id, setTimeout(() => flushBoard(board.id), BOARD_SAVE_DEBOUNCE))
}

function flushBoard (id: string): void {
  const t = boardSaveTimers.get(id)
  if (t) clearTimeout(t)
  boardSaveTimers.delete(id)
  const board = pendingBoards.get(id)
  if (!board) return
  pendingBoards.delete(id)
  try {
    if (board.doc.ops.length === 0) boardStore.delete(id)
    else boardStore.save(board)
  } catch (err) {
    console.error('failed to save board', err)
  }
}

function flushAllBoards (): void {
  for (const id of [...pendingBoards.keys()]) flushBoard(id)
}

function wireIpc (): void {
  ipcMain.on('overlay-ready', e => {
    if (state.toolState) e.sender.send('tool-state', state.toolState)
    e.sender.send('mode', state.mode)
    e.sender.send('highlight', state.highlight)
    e.sender.send('bg', state.bg)
    const displayId = overlayDisplayByWc.get(e.sender.id)
    if (displayId !== undefined) loadBoardForOverlay(e.sender, displayId)
  })
  ipcMain.on('save-board', (e, payload: unknown) => saveBoardFromOverlay(e.sender.id, payload))
  // Synchronous final save (window teardown / quit). Write, then unblock the
  // renderer — so the disk write completes before the page finishes unloading.
  ipcMain.on('save-board-sync', (e, payload: unknown) => {
    saveBoardImmediate(e.sender.id, payload)
    e.returnValue = null
  })
  ipcMain.on('export-result', (_e, payload: unknown) => { void finishExport(payload) })
  ipcMain.on('overlay-cursor-ready', () => {
    if (state.mode) {
      for (const win of overlays.values()) repaintOverlayCursor(win)
      return
    }
    if (mouseModeFallback) {
      clearTimeout(mouseModeFallback)
      mouseModeFallback = null
    }
    enterMouseMode()
  })
  ipcMain.on('toolbar-ready', () => {
    send(toolbar, 'mode', state.mode)
    send(toolbar, 'highlight', state.highlight)
    send(toolbar, 'bg', state.bg)
    send(toolbar, 'hidden', state.hidden)
    updateTooltipSide()
    pushHistory()
    send(toolbar, 'hotkeys', hotkeys)
    send(toolbar, 'update-badge', { available: updateAvailable() })
  })
  ipcMain.on('tool-state', (_e, s: ToolState) => {
    state.toolState = s
    // Switching away from the text tool ends the held-focus text session (size
    // and colour tweaks keep the tool, so they keep the keyboard too).
    if (s.tool !== 'text') releaseTextFocus()
    sendOverlays('tool-state', s)
    for (const win of inputs.values()) send(win, 'tool-state', s)
    // A tool change swaps the input catcher's cursor, but Windows only repaints
    // the OS cursor on real input — nudge the catcher under the pointer so the
    // new cursor shows without waiting for the mouse to move.
    if (state.mode) repaintOverlayCursor(inputs.get(displayAtCursor().id) ?? null)
  })
  ipcMain.on('input-ready', e => {
    if (state.toolState) e.sender.send('tool-state', state.toolState)
  })
  // Pointer traffic from an input catcher → the ink overlay on the same display.
  ipcMain.on('draw-input', (e, payload: unknown) => {
    const displayId = inputDisplayByWc.get(e.sender.id)
    if (displayId === undefined) return
    send(overlays.get(displayId) ?? null, 'draw-input', payload)
    if (typeof payload !== 'object' || payload === null) return
    const p = payload as { t?: unknown; id?: unknown }
    if (p.t === 'down') {
      // Track the live gesture so the topmost reflex holds its raises until the
      // stroke ends, and close any open toolbar menu, same as the overlay's own
      // draw-start did when it still received the pointer directly.
      liveGestures.add(`${displayId}:${String(p.id)}`)
      send(toolbar, 'close-menus')
    } else if (p.t === 'up') {
      gestureEnded(`${displayId}:${String(p.id)}`)
    }
  })
  // Drawing on a canvas asks the toolbar to close any open menu (its own
  // outside-press can't see clicks that land in another window).
  ipcMain.on('draw-start', () => send(toolbar, 'close-menus'))
  ipcMain.on('set-mode', (_e, on: boolean) => setDrawMode(on))
  ipcMain.on('set-highlight', (_e, on: boolean) => setHighlight(on))
  // Overlays are non-activating so drawing never steals focus; the text editor
  // is the exception. Focus is acquired for the FIRST text box and then held for
  // the whole text-tool session (released on tool change / mode exit / hide, see
  // releaseTextFocus) — every focus flip makes the shell re-assert the taskbar
  // (a visible flash over fullscreen apps), so placing many texts in a row must
  // not acquire/release per box.
  ipcMain.on('text-editing', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (on) {
      // The ink overlay is normally click-through with the input catchers on
      // top; the textarea needs both mouse and keyboard, so drop the catchers
      // out of the way and make the overlay interactive for the edit.
      for (const iw of inputs.values()) {
        if (!iw.isDestroyed()) iw.hide()
      }
      win.setIgnoreMouseEvents(false, { forward: false })
      if (textFocusWin !== win || !win.isFocused()) {
        // A plain focus() is blocked by the Windows foreground lock once
        // OpenPen is in the background, hence show() + moveTop too.
        if (textFocusWin && textFocusWin !== win && !textFocusWin.isDestroyed()) {
          textFocusWin.setFocusable(false)
        }
        win.setFocusable(true)
        win.moveTop()
        win.show()
        win.focus()
        raiseBurst()
      }
      textFocusWin = win
    } else {
      // Keep the keyboard (no blur — that's the other half of the taskbar
      // flash); just hand the pointer back to the catchers, then one strong
      // stack pass re-slots everything without ink crossing the UI.
      win.setIgnoreMouseEvents(true, { forward: false })
      if (state.mode && !state.hidden) {
        for (const iw of inputs.values()) {
          if (!iw.isDestroyed()) iw.showInactive()
        }
      }
      raiseStack(true)
      win.webContents.invalidate()
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
  ipcMain.on('export', () => { void exportBoard() })
  ipcMain.on('theme', (_e, t: string) => {
    resolvedTheme = t === 'dark' ? 'dark' : 'light'
    // Broadcast to every window at once so their theme crossfades start in sync
    // (the toolbar resolves the theme but applies it via this same message).
    send(toolbar, 'theme', t)
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
  ipcMain.on('set-hotkey', (_e, payload: unknown) => {
    if (
      typeof payload !== 'object' || payload === null ||
      typeof (payload as { action?: unknown }).action !== 'string' ||
      typeof (payload as { accelerator?: unknown }).accelerator !== 'string'
    ) return
    const { action, accelerator, force } = payload as {
      action: string
      accelerator: string
      force?: boolean
    }
    if (!(HOTKEY_ACTIONS as string[]).includes(action)) return
    setHotkey(action as HotkeyAction, accelerator, Boolean(force))
  })
  ipcMain.on('reset-hotkeys', resetHotkeys)
  ipcMain.on('pick-screenshot-dir', () => { void pickScreenshotDir() })
  ipcMain.on('reset-screenshot-dir', resetScreenshotDir)
  ipcMain.on('open-screenshot-dir', openScreenshotDir)
  ipcMain.on('set-screenshot-dest', (_e, dest: unknown) => {
    if (!SHOT_DESTS.includes(dest as ShotDest)) return
    settings.screenshotDest = dest as ShotDest
    saveSettings()
    broadcastSettingsState()
  })
  ipcMain.on('set-restore-ink', (_e, on: unknown) => {
    settings.restoreInk = Boolean(on)
    saveSettings()
    broadcastSettingsState()
  })
  ipcMain.on('hotkey-capture', (_e, on: unknown) => setHotkeyCapture(Boolean(on)))
  ipcMain.on('toolbar-drag-start', (_e, p: unknown) => {
    if (!toolbar || toolbar.isDestroyed() || !isPoint(p)) return
    const b = toolbar.getBounds()
    toolbarDrag = { startX: p.x, startY: p.y, winX: b.x, winY: b.y }
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
  ipcMain.on('eyedrop-start', () => { startEyedrop() })
  ipcMain.on('eyedrop-cancel', () => endEyedrop())
  ipcMain.on('eyedrop-pick', (_e, hex: unknown) => {
    if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      // Apply colour while the toolbar is still opacity 0, drop the loupe, then
      // wait for color-ready (toolbar painted) before revealing. Fallback timer
      // so a missed ack can't leave the UI invisible forever.
      send(toolbar, 'set-color', hex.toLowerCase())
      endEyedrop({ keepUiFaded: true })
      if (eyedropRevealTimer) clearTimeout(eyedropRevealTimer)
      eyedropRevealTimer = setTimeout(() => {
        eyedropRevealTimer = null
        revealEyedropUi()
      }, 200)
    } else {
      endEyedrop()
    }
  })
  ipcMain.on('color-ready', () => {
    if (!eyedropUiFaded) return
    revealEyedropUi()
  })
  // Live loupe sample: tiny BitBlt around the cursor, returned as RGBA + hex.
  ipcMain.handle('eyedrop-sample', (_e, raw: unknown) => {
    if (!eyedropActive || eyedropDisplayId === null) return null
    const req = raw as { x?: unknown; y?: unknown; size?: unknown }
    if (typeof req?.x !== 'number' || typeof req?.y !== 'number') return null
    const size = typeof req.size === 'number' && req.size > 0 ? Math.min(64, Math.floor(req.size)) : 15
    const pt = eyedropPhysicalPoint(req.x, req.y)
    if (!pt) return null
    const sample = sampleScreenRegion(pt.x, pt.y, size)
    if (!sample) return null
    return {
      rgba: sample.rgba,
      width: sample.width,
      height: sample.height,
      hex: sample.hex
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
    app.setAppUserModelId(APP_ID)
    loadSettings()
    boardStore = new JsonBoardStore(path.join(app.getPath('userData'), 'boards'))
    createZFloor()
    createOverlays()
    createToolbar()
    applyUiCaptureProtection()
    createTray()
    registerConfigurableShortcuts()
    wireIpc()
    initAutoUpdate()
    // Ink must sit above the taskbar from the start (mouse mode included), so
    // arm the input-driven reflex that re-asserts it after activation changes.
    updateRaiseReflex()
    screen.on('display-metrics-changed', () => { fitOverlays(); updateTooltipSide() })
    screen.on('display-added', (_e, d) => {
      createOverlay(d, overlays.size)
      createInput(d)
      // Fresh windows raise themselves to the top of the band at creation; one
      // stack pass slots them back under the UI.
      raiseStack()
    })
    screen.on('display-removed', (_e, d) => destroyOverlay(d.id))
  })

  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    flushAllBoards()
    globalShortcut.unregisterAll()
    stopHighlightTracking()
    stopMouseHook()
    for (const t of raiseTimers) clearTimeout(t)
    raiseTimers = []
    if (raiseFallback) {
      clearInterval(raiseFallback)
      raiseFallback = null
    }
  })
}
