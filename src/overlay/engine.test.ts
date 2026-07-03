import { describe, it, expect } from 'vitest'
import { InkDoc } from './engine'
import type { Op } from './engine'

// A minimal pen op — enough to stand in as a drawable object in the log.
const pen = (id: number): Op => ({ kind: 'pen', id, color: '#000', size: 1, points: [] })

describe('InkDoc history', () => {
  it('starts empty', () => {
    const d = new InkDoc()
    expect(d.canUndo).toBe(false)
    expect(d.canRedo).toBe(false)
    expect(d.clearable).toBe(false)
    expect(d.activeStart()).toBe(0)
    expect(d.all).toHaveLength(0)
  })

  it('hands out increasing ids', () => {
    const d = new InkDoc()
    expect(d.newId()).toBe(1)
    expect(d.newId()).toBe(2)
    expect(d.newId()).toBe(3)
  })

  it('push enables undo and clears the redo stack', () => {
    const d = new InkDoc()
    d.push(pen(1))
    expect(d.canUndo).toBe(true)
    expect(d.all).toHaveLength(1)
    d.undo()
    expect(d.canRedo).toBe(true)
    // A fresh push after an undo drops the redo stack.
    d.push(pen(2))
    expect(d.canRedo).toBe(false)
  })

  it('undo/redo move ops between the two stacks', () => {
    const d = new InkDoc()
    d.push(pen(1))
    expect(d.undo()).toBe(true)
    expect(d.canUndo).toBe(false)
    expect(d.undo()).toBe(false) // nothing left
    expect(d.redo()).toBe(true)
    expect(d.canUndo).toBe(true)
    expect(d.redo()).toBe(false) // nothing left to redo
  })

  it('is clearable only when there is uncleared ink', () => {
    const d = new InkDoc()
    expect(d.clearable).toBe(false)
    d.push(pen(1))
    expect(d.clearable).toBe(true)
    d.push({ kind: 'clear' })
    expect(d.clearable).toBe(false) // already cleared
  })
})

describe('InkDoc.activeStart', () => {
  it('skips everything up to and including the last clear', () => {
    const d = new InkDoc()
    d.push(pen(1))
    d.push({ kind: 'clear' })
    d.push(pen(2))
    expect(d.activeStart()).toBe(2) // index just after the clear
  })
})

describe('InkDoc.hiddenIds', () => {
  it('collects ids from committed erase ops', () => {
    const d = new InkDoc()
    d.push(pen(1))
    d.push(pen(2))
    d.push({ kind: 'erase', ids: [1] })
    expect(d.hiddenIds()).toEqual(new Set([1]))
  })

  it('unions an in-progress erase (pending) set', () => {
    const d = new InkDoc()
    d.push(pen(1))
    d.push({ kind: 'erase', ids: [1] })
    expect(d.hiddenIds(new Set([2]))).toEqual(new Set([1, 2]))
  })

  it('ignores erases before the last clear', () => {
    const d = new InkDoc()
    d.push({ kind: 'erase', ids: [99] })
    d.push({ kind: 'clear' })
    d.push(pen(1))
    expect(d.hiddenIds()).toEqual(new Set())
  })
})

describe('InkDoc.offsets', () => {
  it('accumulates committed move deltas per id', () => {
    const d = new InkDoc()
    d.push(pen(1))
    d.push({ kind: 'move', id: 1, dx: 5, dy: 3 })
    d.push({ kind: 'move', id: 1, dx: 2, dy: -1 })
    expect(d.offsets().get(1)).toEqual({ x: 7, y: 2 })
  })

  it('adds a live drag on top of committed moves', () => {
    const d = new InkDoc()
    d.push(pen(1))
    d.push({ kind: 'move', id: 1, dx: 5, dy: 3 })
    expect(d.offsets({ id: 1, dx: 1, dy: 1 }).get(1)).toEqual({ x: 6, y: 4 })
  })

  it('ignores a zero-distance live drag', () => {
    const d = new InkDoc()
    d.push(pen(1))
    expect(d.offsets({ id: 1, dx: 0, dy: 0 }).has(1)).toBe(false)
  })

  it('ignores moves before the last clear', () => {
    const d = new InkDoc()
    d.push({ kind: 'move', id: 1, dx: 5, dy: 3 })
    d.push({ kind: 'clear' })
    d.push(pen(1))
    expect(d.offsets().has(1)).toBe(false)
  })
})
