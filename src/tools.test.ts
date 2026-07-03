import { describe, it, expect } from 'vitest'
import { TOOLS } from './tools'

describe('tool registry', () => {
  it('has a unique accelerator digit per tool', () => {
    const accels = TOOLS.map(t => t.accel)
    expect(new Set(accels).size).toBe(accels.length)
  })
})
