// Mirror of src/hotkeys.ts — keep in step (main and renderer compile separately).

export type HotkeyAction =
  | 'toggleDraw'
  | 'mouseMode'
  | 'clear'
  | 'undo'
  | 'redo'
  | 'screenshot'
  | 'whiteboard'
  | 'blackboard'
  | 'toggleHide'
  | 'toggleToolbar'
  | 'tool:pen'
  | 'tool:highlighter'
  | 'tool:eraser'
  | 'tool:text'
  | 'tool:line'
  | 'tool:arrow'
  | 'tool:rect'
  | 'tool:ellipse'
  | 'tool:drag'

export type HotkeyMap = Record<HotkeyAction, string>

export const UNBOUND_HOTKEY = ''

export function isHotkeyBound (accel: string): boolean {
  return accel.length > 0
}

export const DEFAULT_HOTKEYS: HotkeyMap = {
  toggleDraw: 'Ctrl+Shift+D',
  mouseMode: 'Ctrl+Shift+0',
  clear: 'Ctrl+Shift+C',
  undo: 'Ctrl+Shift+U',
  redo: 'Ctrl+Shift+Y',
  screenshot: 'Ctrl+Shift+S',
  whiteboard: 'Ctrl+Shift+W',
  blackboard: 'Ctrl+Shift+B',
  toggleHide: 'Ctrl+Shift+H',
  toggleToolbar: 'Ctrl+Shift+T',
  'tool:pen': 'Ctrl+Shift+1',
  'tool:drag': 'Ctrl+Shift+2',
  'tool:highlighter': 'Ctrl+Shift+3',
  'tool:eraser': 'Ctrl+Shift+4',
  'tool:text': 'Ctrl+Shift+5',
  'tool:line': 'Ctrl+Shift+6',
  'tool:arrow': 'Ctrl+Shift+7',
  'tool:rect': 'Ctrl+Shift+8',
  'tool:ellipse': 'Ctrl+Shift+9'
}

export const HOTKEY_ACTIONS = Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]

export function mergeHotkeys (partial?: Partial<HotkeyMap>): HotkeyMap {
  const result = { ...DEFAULT_HOTKEYS }
  if (!partial) return result
  for (const action of HOTKEY_ACTIONS) {
    if (action in partial) result[action] = partial[action]!
  }
  return result
}

const VALID_MODIFIERS = new Set(['Ctrl', 'Control', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Shift'])

export function isValidAccelerator (accel: string): boolean {
  const parts = accel.split('+').filter(Boolean)
  if (parts.length < 2) return false
  const key = parts[parts.length - 1]
  if (!key || VALID_MODIFIERS.has(key)) return false
  if (!parts.slice(0, -1).every(m => VALID_MODIFIERS.has(m))) return false
  return /^[A-Z0-9]$|^F\d{1,2}$|^(Up|Down|Left|Right|Space|Delete|Backspace|Insert|Home|End|PageUp|PageDown|Tab|Enter|Esc)$/.test(key)
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
