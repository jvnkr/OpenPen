// The typed contract for the renderer↔main message seam. Every channel the
// renderer may use appears here with its payload type, so a typo or a wrong
// payload is a compile error instead of a silently-dropped message (preload's
// `on` returns a no-op unsubscribe for unknown channels — invisible at runtime).
//
// This types the *renderer* half only. The main process is compiled separately
// (it can't import this module), so it mirrors these channel names in its own
// ipcMain handlers — the strings are the shared vocabulary across the seam.

import type { HotkeyAction, HotkeyMap } from './hotkeys'
import type { Bg, HistoryState, ToolState } from './types'
import type { Tool } from './tools'
import type { EyeDropData } from './overlay/EyeDropper'
import type { SerializedDoc } from './overlay/engine'

export type { SerializedDoc }

export type ThemePref = 'system' | 'light' | 'dark'
// Where a screenshot goes: a PNG file in the save folder, the clipboard, or both.
export type ScreenshotDest = 'file' | 'clipboard' | 'both'
// Board export: the file format the user picked, and what the overlay actually
// renders for it (PDF is built in main from the PNG raster, so the overlay only
// ever produces 'png' or 'svg').
export type ExportFormat = 'png' | 'svg' | 'pdf'
export type ExportRenderKind = 'png' | 'svg'
export type ExportResult =
  | { ok: true; kind: ExportRenderKind; data: string; width: number; height: number }
  | { ok: false; error: string }
export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error'
export interface Point2 { x: number; y: number }

// Live eyedropper sample: a tiny RGBA patch around the cursor plus the centre hex.
export interface EyeDropSample {
  rgba: Uint8Array
  width: number
  height: number
  hex: string
}
export interface EyeDropSampleReq {
  // Overlay-local CSS coordinates (clientX/clientY).
  x: number
  y: number
  size: number
}

// Pointer traffic from an input-catcher window to its display's ink overlay.
// Drawing input is captured by a separate nearly-invisible window (so the ink
// window can stay permanently click-through and never pauses the apps behind
// it) and replayed into the overlay's engine via this message.
export interface DrawPoint { x: number; y: number; pressure: number }
export type DrawInput =
  | { t: 'down'; id: number; x: number; y: number; pressure: number; pen: boolean; shift: boolean }
  | { t: 'move'; id: number; pts: DrawPoint[]; shift: boolean }
  | { t: 'up'; id: number }
  | { t: 'enter'; x: number; y: number }
  | { t: 'leave' }
  | { t: 'wheel'; x: number; y: number; dy: number }
export interface SettingsState {
  protectUi: boolean
  hotkeys: HotkeyMap
  hotkeyError: string | null
  screenshotDir: string
  screenshotDirDefault: string
  screenshotDest: ScreenshotDest
  // When on, ink is saved per display and restored on the next launch (and no
  // ink is kept on disk when off).
  restoreInk: boolean
  isDev: boolean
  version: string
  canUpdate: boolean
  updateStatus: UpdateStatus
  updateVersion: string | null
  updateError: string | null
}
export interface UpdateBadgeState { available: boolean }

// Messages the renderer SENDS to the main process. `void` = no payload.
export interface SendMap {
  'overlay-ready': void
  'toolbar-ready': void
  'settings-ready': void
  'input-ready': void
  'overlay-cursor-ready': void
  'draw-input': DrawInput
  'tool-state': ToolState
  'set-mode': boolean
  // Toggle the click-through cursor highlighter (a mouse-mode variant): a halo
  // that follows the pointer and pulses on each click.
  'set-highlight': boolean
  'cmd': string
  'history': HistoryState
  'pick-tool': Tool | 'mouse'
  'adjust-size': number
  'set-bg': Bg
  'theme': string
  'set-theme': ThemePref
  'set-protect-ui': boolean
  'set-hotkey': { action: HotkeyAction; accelerator: string; force?: boolean }
  'reset-hotkeys': void
  'hotkey-capture': boolean
  'pick-screenshot-dir': void
  'reset-screenshot-dir': void
  'open-screenshot-dir': void
  'set-screenshot-dest': ScreenshotDest
  'set-restore-ink': boolean
  // The overlay's current ink document, sent (debounced) whenever it changes so
  // main can persist it for this display.
  'save-board': SerializedDoc
  // The rendered board (PNG data URL or SVG string) replied to an 'export-board'
  // request, or an error.
  'export-result': ExportResult
  'text-editing': boolean
  'draw-start': void
  'toolbar-drag-start': Point2
  'toolbar-drag-move': Point2
  'toolbar-drag-end': void
  'toolbar-fit-height': number
  'toolbar-interactive': boolean
  'toggle-hide': void
  'toggle-toolbar': void
  'open-settings': void
  'screenshot': void
  // Ask main to export this board (annotations only) — opens a save dialog and
  // rounds back through 'export-board'/'export-result'.
  'export': void
  'eyedrop-start': void
  'eyedrop-pick': string
  'eyedrop-cancel': void
  // Toolbar finished applying a set-color while still faded; main can reveal.
  'color-ready': void
  'check-for-updates': void
  'install-update': void
  'quit': void
}

// Request/response channels (ipcRenderer.invoke).
export interface InvokeMap {
  'eyedrop-sample': { req: EyeDropSampleReq; res: EyeDropSample | null }
}

// Messages the renderer RECEIVES from the main process.
export interface RecvMap {
  'tool-state': ToolState
  'mode': boolean
  'bg': Bg
  // Cursor-highlighter state and the main-process feed that drives it. `highlight`
  // is the on/off toggle; `highlight-pointer` streams the real cursor position in
  // the receiving overlay's local coords (null when the pointer left this
  // display); `highlight-press` is the primary button going down (true) / up
  // (false), which pulses the halo.
  'highlight': boolean
  'highlight-pointer': Point2 | null
  'highlight-press': boolean
  // Forwarded pointer traffic arriving at an ink overlay from its display's
  // input-catcher window (routed through main).
  'draw-input': DrawInput
  // Persisted ink for this overlay's display at startup — null when there's
  // nothing to restore (or restore is off).
  'load-board': SerializedDoc | null
  // Render this display's board for export; the overlay replies on
  // 'export-result'. 'png' also serves a PDF export (main wraps the raster).
  'export-board': ExportRenderKind
  'cmd': string
  'history': HistoryState
  'pick-tool': Tool | 'mouse'
  'adjust-size': number
  'hidden': boolean
  'theme': string
  'close-menus': void
  'screenshotting': boolean
  'screenshot-saved': string
  'tooltip-side': 'left' | 'right'
  'set-theme': ThemePref
  'settings-state': SettingsState
  'hotkeys': HotkeyMap
  'update-badge': UpdateBadgeState
  // Realtime eyedropper session: cursor seed while picking, null when done.
  'eyedrop': EyeDropData | null
  // Screen eyedropper result routed back to the toolbar as the active colour.
  'set-color': string
}

// Channels with a `void` payload take no data argument; all others require it.
export type SendArgs<K extends keyof SendMap> = SendMap[K] extends void ? [] : [data: SendMap[K]]
export type InvokeArgs<K extends keyof InvokeMap> = [data: InvokeMap[K]['req']]

export interface OpenPenApi {
  send<K extends keyof SendMap>(channel: K, ...args: SendArgs<K>): void
  on<K extends keyof RecvMap>(channel: K, fn: (data: RecvMap[K]) => void): () => void
  invoke<K extends keyof InvokeMap>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeMap[K]['res']>
  // Synchronous final save (teardown/quit): blocks until main has written the
  // board, so the last change can't be lost to the app exiting.
  flush (doc: SerializedDoc): void
}
