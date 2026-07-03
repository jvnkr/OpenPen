import { describe, it, expect } from 'vitest'
import { TOOLS, TOOL_BY_KEY } from './tools'

describe('tool registry', () => {
  it('has a unique single-key shortcut per tool', () => {
    const keys = TOOLS.map(t => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has a unique accelerator digit per tool', () => {
    const accels = TOOLS.map(t => t.accel)
    expect(new Set(accels).size).toBe(accels.length)
  })

  it("never collides with the overlay's reserved 'm' (mouse) key", () => {
    expect(TOOLS.some(t => t.key === 'm')).toBe(false)
  })

  it('maps every tool id by its key', () => {
    for (const t of TOOLS) expect(TOOL_BY_KEY[t.key]).toBe(t.id)
    expect(Object.keys(TOOL_BY_KEY)).toHaveLength(TOOLS.length)
  })
})
