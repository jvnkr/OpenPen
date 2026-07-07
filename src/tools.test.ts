import { describe, it, expect } from 'vitest'
import { TOOLS } from './tools'

describe('tool registry', () => {
  it('has a unique accelerator digit per tool', () => {
    // Tools may ship without a default shortcut (accel null); only the assigned
    // digits must be distinct.
    const accels = TOOLS.map(t => t.accel).filter((a): a is number => a !== null)
    expect(new Set(accels).size).toBe(accels.length)
  })
})
