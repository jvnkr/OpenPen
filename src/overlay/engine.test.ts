import { describe, it, expect } from 'vitest'
import { InkDoc, tipAngle } from './engine'
import type { Op, Point } from './engine'

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

// The curved-arrow head is two barbs at exactly ±30° around tipAngle's result,
// so "the line enters the head dead-centre" is equivalent to: tipAngle returns
// the line's true heading at the tip. These pin that down, including the noise
// cases that used to tilt the head.
describe('tipAngle', () => {
  const deg = (rad: number): number => (rad * 180) / Math.PI
  // Signed difference between an angle (rad) and a reference (deg), wrapped.
  const angDiff = (a: number, refDeg: number): number => {
    let d = deg(a) - refDeg
    while (d >= 180) d -= 360
    while (d < -180) d += 360
    return d
  }
  // The renderer's window/trim shape for a default-size arrow (head 27px).
  const WINDOW = 13.5
  const TRIM = 6

  const vertical = (wobble: Point[] = []): Point[] => {
    const pts: Point[] = []
    for (let y = 400; y >= 80; y -= 6) pts.push({ x: 100, y })
    return pts.concat(wobble)
  }

  it('is exact on straight lines at any angle', () => {
    expect(deg(tipAngle(vertical(), WINDOW, TRIM))).toBeCloseTo(-90, 5)
    const right: Point[] = []
    for (let x = 0; x <= 300; x += 6) right.push({ x, y: 50 })
    expect(deg(tipAngle(right, WINDOW, TRIM))).toBeCloseTo(0, 5)
    const diag: Point[] = []
    for (let i = 0; i <= 50; i++) diag.push({ x: i * 4, y: i * 4 })
    expect(deg(tipAngle(diag, WINDOW, TRIM))).toBeCloseTo(45, 5)
  })

  it('ignores mouse-release wobble on a straight line', () => {
    // A 4px sideways smear over the last ~5px of path — the classic release
    // hook. The head must stay exactly vertical.
    const pts = vertical([
      { x: 99, y: 77 },
      { x: 97, y: 75 },
      { x: 96, y: 74 }
    ])
    expect(deg(tipAngle(pts, WINDOW, TRIM))).toBeCloseTo(-90, 5)
  })

  it('tracks the final heading of a deliberate hook, not the approach', () => {
    // Travel right, then curve to end heading straight up.
    const pts: Point[] = [{ x: 0, y: 300 }]
    let dir = 0
    let x = 0
    let y = 300
    for (let i = 0; i < 50; i++) {
      if (i >= 35) dir = -(Math.PI / 2) * ((i - 35) / 14) // ease 0° → -90°
      x += Math.cos(dir) * 6
      y += Math.sin(dir) * 6
      pts.push({ x, y })
    }
    const a = tipAngle(pts, WINDOW, TRIM)
    // Close to straight up, and nowhere near the approach direction.
    expect(Math.abs(angDiff(a, -90))).toBeLessThan(15)
    expect(Math.abs(angDiff(a, 0))).toBeGreaterThan(60)
  })

  it('returns a finite angle when the stroke curls tightly at the end', () => {
    const pts: Point[] = []
    for (let x = 0; x <= 120; x += 6) pts.push({ x, y: 100 })
    for (let a = 0; a <= Math.PI * 2; a += 0.3) {
      pts.push({ x: 120 + Math.sin(a) * 4, y: 96 + Math.cos(a) * 4 })
    }
    expect(Number.isFinite(tipAngle(pts, WINDOW, TRIM))).toBe(true)
  })

  it('handles strokes shorter than the trim window', () => {
    const flick: Point[] = [{ x: 0, y: 0 }, { x: 3, y: 0 }]
    expect(deg(tipAngle(flick, WINDOW, TRIM))).toBeCloseTo(0, 5)
  })
})
