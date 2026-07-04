import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  HOTKEY_GROUPS,
  UNBOUND_HOTKEY,
  eventToAccelerator,
  findHotkeyConflict,
  mergeHotkeys,
  parseHotkeyParts,
  allHotkeysAtDefault
} from './hotkeys'
import { TOOLS } from './tools'

describe('hotkeys', () => {
  it('covers every tool with a default shortcut', () => {
    for (const tool of TOOLS) {
      expect(DEFAULT_HOTKEYS[`tool:${tool.id}`]).toBe(`Ctrl+Shift+${tool.accel}`)
    }
  })

  it('lists every action exactly once in groups', () => {
    const fromGroups = HOTKEY_GROUPS.flatMap(g => g.actions.map(a => a.id))
    expect(fromGroups.sort()).toEqual([...HOTKEY_ACTIONS].sort())
  })

  it('mergeHotkeys fills missing keys from defaults', () => {
    const merged = mergeHotkeys({ toggleDraw: 'Ctrl+Alt+D' })
    expect(merged.toggleDraw).toBe('Ctrl+Alt+D')
    expect(merged.clear).toBe(DEFAULT_HOTKEYS.clear)
  })

  it('mergeHotkeys preserves unbound actions', () => {
    const merged = mergeHotkeys({ clear: UNBOUND_HOTKEY })
    expect(merged.clear).toBe(UNBOUND_HOTKEY)
    expect(merged.toggleDraw).toBe(DEFAULT_HOTKEYS.toggleDraw)
  })

  it('findHotkeyConflict ignores unbound actions', () => {
    const map = { ...DEFAULT_HOTKEYS, clear: UNBOUND_HOTKEY }
    expect(findHotkeyConflict(map, 'undo', DEFAULT_HOTKEYS.clear)).toBeNull()
    expect(findHotkeyConflict(map, 'clear', DEFAULT_HOTKEYS.undo)).toBe('undo')
  })

  it('eventToAccelerator requires a modifier', () => {
    expect(eventToAccelerator({ key: 'D', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent)).toBeNull()
  })

  it('eventToAccelerator builds electron-style accelerators', () => {
    expect(eventToAccelerator({
      key: 'd', code: 'KeyD', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false
    } as KeyboardEvent)).toBe('Ctrl+Shift+D')
  })

  it('eventToAccelerator uses digit key codes when shift produces symbols', () => {
    expect(eventToAccelerator({
      key: '!', code: 'Digit1', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false
    } as KeyboardEvent)).toBe('Ctrl+Shift+1')
    expect(eventToAccelerator({
      key: ')', code: 'Digit0', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false
    } as KeyboardEvent)).toBe('Ctrl+Shift+0')
  })

  it('allHotkeysAtDefault detects custom and unbound hotkeys', () => {
    expect(allHotkeysAtDefault(DEFAULT_HOTKEYS)).toBe(true)
    expect(allHotkeysAtDefault({ ...DEFAULT_HOTKEYS, clear: UNBOUND_HOTKEY })).toBe(false)
    expect(allHotkeysAtDefault({ ...DEFAULT_HOTKEYS, clear: 'Ctrl+Alt+C' })).toBe(false)
  })

  it('parseHotkeyParts splits accelerators into key labels', () => {
    expect(parseHotkeyParts('Ctrl+Shift+D')).toEqual(['Ctrl', 'Shift', 'D'])
    expect(parseHotkeyParts('CommandOrControl+Alt+1')).toEqual(['Ctrl', 'Alt', '1'])
  })
})
