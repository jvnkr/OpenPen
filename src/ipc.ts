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

export type ThemePref = 'system' | 'light' | 'dark'
export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error'
export interface Point2 { x: number; y: number }
export interface SettingsState {
  protectUi: boolean
  hotkeys: HotkeyMap
  hotkeyError: string | null
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
  'overlay-cursor-ready': void
  'tool-state': ToolState
  'set-mode': boolean
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
  'eyedrop-start': void
  'eyedrop-pick': string
  'eyedrop-cancel': void
  'check-for-updates': void
  'install-update': void
  'quit': void
}

// Messages the renderer RECEIVES from the main process.
export interface RecvMap {
  'tool-state': ToolState
  'mode': boolean
  'bg': Bg
  'cmd': string
  'history': HistoryState
  'pick-tool': Tool | 'mouse'
  'adjust-size': number
  'hidden': boolean
  'theme': string
  'close-menus': void
  'screenshotting': boolean
  'tooltip-side': 'left' | 'right'
  'set-theme': ThemePref
  'settings-state': SettingsState
  'hotkeys': HotkeyMap
  'update-badge': UpdateBadgeState
  'eyedrop': EyeDropData | null
}

// Channels with a `void` payload take no data argument; all others require it.
export type SendArgs<K extends keyof SendMap> = SendMap[K] extends void ? [] : [data: SendMap[K]]

export interface OpenPenApi {
  send<K extends keyof SendMap>(channel: K, ...args: SendArgs<K>): void
  on<K extends keyof RecvMap>(channel: K, fn: (data: RecvMap[K]) => void): () => void
}
