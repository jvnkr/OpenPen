// Single source of truth for customizable global hotkeys. The main process
// mirrors this file in electron/hotkeys.ts (compiled separately).

import { TOOLS, type Tool } from './tools'

export type HotkeyAction =
  | 'toggleDraw'
  | 'mouseMode'
  | 'highlightCursor'
  | 'clear'
  | 'undo'
  | 'redo'
  | 'screenshot'
  | 'whiteboard'
  | 'blackboard'
  | 'toggleHide'
  | 'toggleToolbar'
  | `tool:${Tool}`

export type HotkeyMap = Record<HotkeyAction, string>

/** Empty string means the action has no shortcut assigned. */
export const UNBOUND_HOTKEY = ''

export function isHotkeyBound (accel: string): boolean {
  return accel.length > 0
}

export interface HotkeyRow {
  id: HotkeyAction
  label: string
}

export interface HotkeyGroup {
  label: string
  actions: HotkeyRow[]
}

const toolAction = (tool: Tool): HotkeyAction => `tool:${tool}`

export const DEFAULT_HOTKEYS: HotkeyMap = {
  toggleDraw: 'Ctrl+Shift+D',
  mouseMode: 'Ctrl+Shift+0',
  highlightCursor: 'Ctrl+Shift+L',
  clear: 'Ctrl+Shift+C',
  undo: 'Ctrl+Shift+U',
  redo: 'Ctrl+Shift+Y',
  screenshot: 'Ctrl+Shift+S',
  whiteboard: 'Ctrl+Shift+W',
  blackboard: 'Ctrl+Shift+B',
  toggleHide: 'Ctrl+Shift+H',
  toggleToolbar: 'Ctrl+Shift+T',
  ...Object.fromEntries(
    TOOLS.map(t => [toolAction(t.id), `Ctrl+Shift+${t.accel}`])
  ) as Record<`tool:${Tool}`, string>
}

export const HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    label: 'General',
    actions: [
      { id: 'toggleDraw', label: 'Toggle draw / mouse mode' },
      { id: 'mouseMode', label: 'Mouse mode' },
      { id: 'highlightCursor', label: 'Highlight cursor' },
      { id: 'clear', label: 'Clear screen' },
      { id: 'undo', label: 'Undo' },
      { id: 'redo', label: 'Redo' },
      { id: 'screenshot', label: 'Save screenshot' },
      { id: 'whiteboard', label: 'Whiteboard' },
      { id: 'blackboard', label: 'Blackboard' },
      { id: 'toggleHide', label: 'Hide / show ink' },
      { id: 'toggleToolbar', label: 'Show / hide toolbar' }
    ]
  },
  {
    label: 'Tools',
    actions: TOOLS.map(t => ({ id: toolAction(t.id), label: t.name }))
  }
]

export const HOTKEY_ACTIONS = HOTKEY_GROUPS.flatMap(g => g.actions.map(a => a.id))

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

function normalizeKey (key: string): string | null {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  if (/^F\d{1,2}$/.test(key)) return key
  if (key === 'ArrowUp') return 'Up'
  if (key === 'ArrowDown') return 'Down'
  if (key === 'ArrowLeft') return 'Left'
  if (key === 'ArrowRight') return 'Right'
  if (key === 'Delete') return 'Delete'
  if (key === 'Backspace') return 'Backspace'
  if (key === 'Insert') return 'Insert'
  if (key === 'Home') return 'Home'
  if (key === 'End') return 'End'
  if (key === 'PageUp') return 'PageUp'
  if (key === 'PageDown') return 'PageDown'
  if (key === 'Tab') return 'Tab'
  if (key === 'Enter') return 'Enter'
  if (key === 'Escape') return 'Esc'
  return null
}

/** Prefer physical key codes so Ctrl+Shift+1 registers as 1, not !. */
function keyFromEvent (e: KeyboardEvent): string | null {
  const digit = /^Digit([0-9])$/.exec(e.code)
  if (digit) return digit[1]
  const numpad = /^Numpad([0-9])$/.exec(e.code)
  if (numpad) return numpad[1]
  const letter = /^Key([A-Z])$/.exec(e.code)
  if (letter) return letter[1]
  return normalizeKey(e.key)
}

/** Turn a browser keydown into an Electron accelerator string, or null if invalid. */
export function eventToAccelerator (e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null

  const key = keyFromEvent(e)
  if (!key) return null

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (parts.length === 0) return null

  parts.push(key)
  return parts.join('+')
}

export function parseHotkeyParts (accel: string): string[] {
  return accel
    .replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl')
    .replace(/Control/g, 'Ctrl')
    .split('+')
    .filter(Boolean)
}

export function formatHotkey (accel: string): string {
  return parseHotkeyParts(accel).join(' + ')
}

export function mergeHotkeys (partial?: Partial<HotkeyMap>): HotkeyMap {
  const result = { ...DEFAULT_HOTKEYS }
  if (!partial) return result
  for (const action of HOTKEY_ACTIONS) {
    if (action in partial) result[action] = partial[action]!
  }
  return result
}

export function findHotkeyConflict (
  hotkeys: HotkeyMap,
  action: HotkeyAction,
  accel: string
): HotkeyAction | null {
  if (!isHotkeyBound(accel)) return null
  for (const [id, bound] of Object.entries(hotkeys) as Array<[HotkeyAction, string]>) {
    if (id !== action && bound === accel) return id
  }
  return null
}

export function hotkeyTipKeys (accel: string): string[] | undefined {
  if (!isHotkeyBound(accel)) return undefined
  return parseHotkeyParts(accel)
}

export function hotkeysForAction (map: HotkeyMap, action: HotkeyAction): string[] | undefined {
  return hotkeyTipKeys(map[action])
}

export function allHotkeysAtDefault (map: HotkeyMap): boolean {
  return HOTKEY_ACTIONS.every(action => map[action] === DEFAULT_HOTKEYS[action])
}

export function hotkeyLabel (action: HotkeyAction): string {
  for (const group of HOTKEY_GROUPS) {
    const row = group.actions.find(a => a.id === action)
    if (row) return row.label
  }
  return action
}
