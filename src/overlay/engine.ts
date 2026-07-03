import { getStroke } from 'perfect-freehand'
import type { HistoryState, Tool } from '@/types'

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))

export interface Point { x: number; y: number }

type InkKind = 'pen' | 'highlighter'
type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse'

interface StrokeOp {
  kind: InkKind
  id: number
  color: string
  size: number
  points: Point[]
}
interface ShapeOp {
  kind: ShapeKind
  id: number
  color: string
  size: number
  x0: number
  y0: number
  x1: number
  y1: number
  shift: boolean
}
interface TextOp {
  kind: 'text'
  id: number
  color: string
  fontPx: number
  x: number
  y: number
  text: string
}
// Erasing removes whole objects. Rather than mutating the ops list (which would
// break undo), an erase records the ids it hid; replay simply skips those ids,
// so undoing the erase brings the objects back.
interface EraseOp { kind: 'erase'; ids: number[] }
interface ClearOp { kind: 'clear' }
// Moving an object records a delta against its id rather than mutating the op,
// so it composes with undo like erasing does: replay accumulates every move's
// offset per id and shifts the object at draw time; undoing a move drops its
// delta and the object snaps back.
interface MoveOp { kind: 'move'; id: number; dx: number; dy: number }

export type DrawOp = StrokeOp | ShapeOp | TextOp
export type Op = DrawOp | EraseOp | ClearOp | MoveOp
type LiveOp = StrokeOp | ShapeOp

// Effective stamp width per tool (highlighter/eraser are wider than the slider value)
const toolWidth = (tool: Tool, size: number): number =>
  tool === 'highlighter' ? size * 2 : tool === 'eraser' ? size * 2.5 : size

// perfect-freehand options (the excalidraw/tldraw approach): streamline eats
// input jitter, smoothing rounds the outline, thinning tapers with speed.
const PEN_FREEHAND = { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true, last: true }
// Highlighter stays a uniform-width marker — no taper, no fake pressure.
const HL_FREEHAND = { thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true }

// Closed smooth path through a perfect-freehand outline polygon (midpoint
// quadratics, per the library's reference renderer).
function outlinePath (outline: number[][]): Path2D {
  const p = new Path2D()
  p.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i++) {
    const a = outline[i]
    const b = outline[(i + 1) % outline.length]
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  }
  p.closePath()
  return p
}

function fillFreehand (ctx: CanvasRenderingContext2D, pts: Point[], color: string, width: number, opts: typeof PEN_FREEHAND): void {
  ctx.fillStyle = color
  if (pts.length < 2) {
    const p = pts[0]
    ctx.beginPath()
    ctx.arc(p.x, p.y, width / 2, 0, TAU)
    ctx.fill()
    return
  }
  // One fill of one polygon → uniform alpha even where the outline overlaps
  // itself, which keeps the translucent highlighter blotch-free.
  ctx.fill(outlinePath(getStroke(pts, { size: width, ...opts })))
}

function constrainLine (op: ShapeOp): [number, number] {
  if (!op.shift) return [op.x1, op.y1]
  const dx = op.x1 - op.x0
  const dy = op.y1 - op.y0
  const snap = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const len = Math.hypot(dx, dy)
  return [op.x0 + Math.cos(snap) * len, op.y0 + Math.sin(snap) * len]
}

function constrainRect (op: ShapeOp): { x: number; y: number; w: number; h: number } {
  let w = op.x1 - op.x0
  let h = op.y1 - op.y0
  if (op.shift) {
    const m = Math.min(Math.abs(w), Math.abs(h))
    w = Math.sign(w || 1) * m
    h = Math.sign(h || 1) * m
  }
  return { x: Math.min(op.x0, op.x0 + w), y: Math.min(op.y0, op.y0 + h), w: Math.abs(w), h: Math.abs(h) }
}

// Head length scales with the line so thick arrows stay proportioned.
const arrowHeadLen = (size: number): number => Math.max(14, size * 4.5)

function drawArrow (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, size: number): void {
  const ang = Math.atan2(y1 - y0, x1 - x0)
  const head = Math.min(arrowHeadLen(size), Math.hypot(x1 - x0, y1 - y0))
  const spread = Math.PI / 6
  // Two back corners of the head.
  const lx = x1 - head * Math.cos(ang - spread)
  const ly = y1 - head * Math.sin(ang - spread)
  const rx = x1 - head * Math.cos(ang + spread)
  const ry = y1 - head * Math.sin(ang + spread)
  // Shaft stops at the head's midpoint so a thick line never pokes past the tip.
  const bx = (lx + rx) / 2
  const by = (ly + ry) / 2
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(bx, by)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(lx, ly)
  ctx.lineTo(rx, ry)
  ctx.closePath()
  ctx.fill()
}

function renderOp (ctx: CanvasRenderingContext2D, op: Op): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  switch (op.kind) {
    case 'pen':
      fillFreehand(ctx, op.points, op.color, op.size, PEN_FREEHAND)
      break
    case 'highlighter':
      ctx.globalAlpha = 0.35
      fillFreehand(ctx, op.points, op.color, toolWidth('highlighter', op.size), HL_FREEHAND)
      break
    case 'line':
    case 'arrow': {
      const [x1, y1] = constrainLine(op)
      ctx.strokeStyle = op.color
      ctx.fillStyle = op.color
      ctx.lineWidth = op.size
      if (op.kind === 'arrow') {
        drawArrow(ctx, op.x0, op.y0, x1, y1, op.size)
      } else {
        ctx.beginPath()
        ctx.moveTo(op.x0, op.y0)
        ctx.lineTo(x1, y1)
        ctx.stroke()
      }
      break
    }
    case 'rect': {
      const r = constrainRect(op)
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.size
      ctx.strokeRect(r.x, r.y, r.w, r.h)
      break
    }
    case 'ellipse': {
      const r = constrainRect(op)
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.size
      ctx.beginPath()
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, TAU)
      ctx.stroke()
      break
    }
    case 'text': {
      ctx.fillStyle = op.color
      ctx.font = `600 ${op.fontPx}px "Segoe UI", system-ui, sans-serif`
      ctx.textBaseline = 'top'
      const lines = op.text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], op.x, op.y + i * op.fontPx * 1.25)
      }
      break
    }
    case 'erase':
    case 'clear':
    case 'move':
      break
  }
  ctx.restore()
}

function distToSegment (px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = clamp(t, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// True when the point is within `tol` of the object (its stroke/outline, or the
// box for text). Used by the object eraser to pick what to delete.
function opHit (op: DrawOp, px: number, py: number, tol: number, measure: CanvasRenderingContext2D): boolean {
  switch (op.kind) {
    case 'pen':
    case 'highlighter': {
      const t = tol + toolWidth(op.kind, op.size) / 2
      const pts = op.points
      if (pts.length === 1) return Math.hypot(px - pts[0].x, py - pts[0].y) <= t
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= t) return true
      }
      return false
    }
    case 'line':
    case 'arrow': {
      const [x1, y1] = constrainLine(op)
      return distToSegment(px, py, op.x0, op.y0, x1, y1) <= tol + op.size / 2
    }
    case 'rect': {
      const r = constrainRect(op)
      const t = tol + op.size / 2
      const nearX = px >= r.x - t && px <= r.x + r.w + t
      const nearY = py >= r.y - t && py <= r.y + r.h + t
      const onVert = (Math.abs(px - r.x) <= t || Math.abs(px - (r.x + r.w)) <= t) && nearY
      const onHorz = (Math.abs(py - r.y) <= t || Math.abs(py - (r.y + r.h)) <= t) && nearX
      return onVert || onHorz
    }
    case 'ellipse': {
      const r = constrainRect(op)
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      const rx = r.w / 2
      const ry = r.h / 2
      if (rx < 1 || ry < 1) return distToSegment(px, py, r.x, r.y, r.x + r.w, r.y + r.h) <= tol + op.size / 2
      const ang = Math.atan2((py - cy) / ry, (px - cx) / rx)
      const ex = cx + rx * Math.cos(ang)
      const ey = cy + ry * Math.sin(ang)
      return Math.hypot(px - ex, py - ey) <= tol + op.size / 2
    }
    case 'text': {
      measure.font = `600 ${op.fontPx}px "Segoe UI", system-ui, sans-serif`
      const lines = op.text.split('\n')
      let w = 0
      for (const l of lines) w = Math.max(w, measure.measureText(l).width)
      const h = lines.length * op.fontPx * 1.25
      return px >= op.x - tol && px <= op.x + w + tol && py >= op.y - tol && py <= op.y + h + tol
    }
  }
}

// The ink document: the immutable-log history model behind the canvas. It owns
// the op list, the redo stack and the id counter, and answers the queries a
// repaint needs — what's visible, what's hidden, how far each object has moved
// — without ever touching a canvas. That keeps the vector-history rules in one
// testable place, separate from the pixel plumbing and the live-gesture state
// machine in Engine (which passes its in-progress erase/drag in as overlays).
export class InkDoc {
  private ops: Op[] = []
  private redoStack: Op[] = []
  private idSeq = 1

  newId (): number { return this.idSeq++ }
  get all (): readonly Op[] { return this.ops }
  get canUndo (): boolean { return this.ops.length > 0 }
  get canRedo (): boolean { return this.redoStack.length > 0 }
  // False when a clear would be redundant (nothing drawn, or already cleared).
  get clearable (): boolean {
    const last = this.ops[this.ops.length - 1]
    return last !== undefined && last.kind !== 'clear'
  }

  push (op: Op): void {
    this.ops.push(op)
    this.redoStack = []
  }

  undo (): boolean {
    const op = this.ops.pop()
    if (!op) return false
    this.redoStack.push(op)
    return true
  }

  redo (): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    this.ops.push(op)
    return true
  }

  // Nothing before the most recent clear can be visible — skip it.
  activeStart (): number {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (this.ops[i].kind === 'clear') return i + 1
    }
    return 0
  }

  // Ids hidden by committed erase ops in the active range, unioned with any the
  // caller's in-progress erase drag has picked up so far.
  hiddenIds (pending?: ReadonlySet<number>): Set<number> {
    const hidden = new Set<number>(pending)
    const start = this.activeStart()
    for (let i = start; i < this.ops.length; i++) {
      const op = this.ops[i]
      if (op.kind === 'erase') for (const id of op.ids) hidden.add(id)
    }
    return hidden
  }

  // Accumulated (dx, dy) per object id from committed move ops in the active
  // range, plus an optional in-progress drag on top. Ids with no move are absent.
  offsets (live?: { id: number; dx: number; dy: number }): Map<number, Point> {
    const m = new Map<number, Point>()
    const start = this.activeStart()
    for (let i = start; i < this.ops.length; i++) {
      const op = this.ops[i]
      if (op.kind !== 'move') continue
      const cur = m.get(op.id) ?? { x: 0, y: 0 }
      m.set(op.id, { x: cur.x + op.dx, y: cur.y + op.dy })
    }
    if (live && (live.dx !== 0 || live.dy !== 0)) {
      const cur = m.get(live.id) ?? { x: 0, y: 0 }
      m.set(live.id, { x: cur.x + live.dx, y: cur.y + live.dy })
    }
    return m
  }
}

export class Engine {
  cur: LiveOp | null = null

  // Everything is presented on ONE visible canvas: committed ink lives on an
  // offscreen buffer, and each frame the screen is repainted as buffer + the
  // in-progress op (how Excalidraw/tldraw render). Committing on pointer up
  // just moves the op into the buffer and repaints — pixel-identical output on
  // a single surface, so there is no cross-canvas compositor handoff to blink.
  private readonly screenC: HTMLCanvasElement
  private readonly screen: CanvasRenderingContext2D
  private readonly baseC: HTMLCanvasElement
  private readonly base: CanvasRenderingContext2D
  private readonly onHistory: (h: HistoryState) => void
  private readonly doc = new InkDoc()
  private dpr = 1
  private erasing = false
  private eraseSize = 0
  private pendingErase = new Set<number>()
  // In-progress drag: the picked object's id and how far it has moved so far.
  private dragging = false
  private dragId = -1
  private dragStartX = 0
  private dragStartY = 0
  private dragDx = 0
  private dragDy = 0
  private raf = 0
  private replayRaf = 0
  // Brush-size preview: a ring drawn on the canvas at the pointer. Custom OS
  // cursors flicker on this transparent always-on-top window (Windows flashes
  // the default arrow during movement), so the size feedback lives in-canvas —
  // composited with the ink, it can never blink — while the OS cursor stays a
  // plain native crosshair.
  private previewTool: InkKind | null = null
  private previewColor = ''
  private previewSize = 0
  private pointerX = 0
  private pointerY = 0
  private hasPointer = false

  constructor (canvas: HTMLCanvasElement, onHistory: (h: HistoryState) => void) {
    this.screenC = canvas
    this.screen = canvas.getContext('2d')!
    this.baseC = document.createElement('canvas')
    this.base = this.baseC.getContext('2d')!
    this.onHistory = onHistory
  }

  resize (w: number, h: number, dpr: number): void {
    this.dpr = dpr
    for (const c of [this.screenC, this.baseC]) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    this.screenC.style.width = `${w}px`
    this.screenC.style.height = `${h}px`
    this.replay()
  }

  // True while a pointer interaction is live (drawing, erasing or dragging), so
  // the overlay knows to keep forwarding move events even when `cur` is null.
  get active (): boolean {
    return this.cur !== null || this.erasing || this.dragging
  }

  // Turn the in-canvas size ring on (pen/highlighter) or off (null). The ring
  // resizes live on wheel-resize even with the mouse held still — a repaint,
  // not an OS cursor update, so no stale-cursor tricks are needed.
  setBrushPreview (tool: InkKind | null, color = '', size = 0): void {
    const changed =
      tool !== this.previewTool ||
      color !== this.previewColor ||
      size !== this.previewSize
    this.previewTool = tool
    this.previewColor = color
    this.previewSize = size
    if (changed) this.scheduleRepaint()
  }

  // Track the pointer for the preview ring; null hides it (pointer left).
  setPointer (x: number | null, y = 0): void {
    if (x === null) {
      if (!this.hasPointer) return
      this.hasPointer = false
      this.scheduleRepaint()
      return
    }
    this.hasPointer = true
    this.pointerX = x
    this.pointerY = y
    if (this.previewTool) this.scheduleRepaint()
  }

  begin (tool: Exclude<Tool, 'text'>, color: string, size: number, x: number, y: number, shift: boolean): void {
    // Dragging is driven through beginDrag, not begin; guard so a stray call
    // can never mint a bogus shape op with kind 'drag'.
    if (tool === 'drag') return
    if (tool === 'eraser') {
      // The eraser deletes whole objects; a drag can clear several at once.
      this.cur = null
      this.erasing = true
      this.eraseSize = size
      this.pendingErase = new Set()
      this.eraseAt(x, y)
      return
    }
    if (tool === 'pen' || tool === 'highlighter') {
      this.cur = { kind: tool, id: this.doc.newId(), color, size, points: [{ x, y }] }
    } else {
      this.cur = { kind: tool, id: this.doc.newId(), color, size, x0: x, y0: y, x1: x, y1: y, shift }
    }
    this.repaint()
  }

  move (pts: Point[], shift: boolean): void {
    if (this.dragging) {
      const p = pts[pts.length - 1]
      this.dragDx = p.x - this.dragStartX
      this.dragDy = p.y - this.dragStartY
      this.scheduleReplay()
      return
    }
    if (this.erasing) {
      for (const p of pts) this.eraseAt(p.x, p.y)
      return
    }
    const c = this.cur
    if (!c) return
    if ('points' in c) {
      for (const p of pts) c.points.push(p)
    } else {
      const p = pts[pts.length - 1]
      c.x1 = p.x
      c.y1 = p.y
      c.shift = shift
    }
    // Input events can outpace the display; coalesce repaints to one per frame.
    this.scheduleRepaint()
  }

  end (): void {
    if (this.dragging) {
      this.dragging = false
      // A no-op drag (a click that never moved) records nothing to undo.
      if (this.dragId >= 0 && (this.dragDx !== 0 || this.dragDy !== 0)) {
        this.push({ kind: 'move', id: this.dragId, dx: this.dragDx, dy: this.dragDy })
      }
      this.dragId = -1
      this.dragDx = 0
      this.dragDy = 0
      this.replay()
      return
    }
    if (this.erasing) {
      this.erasing = false
      // Bundle everything this drag removed into one erase op → one undo.
      if (this.pendingErase.size > 0) this.push({ kind: 'erase', ids: [...this.pendingErase] })
      this.pendingErase = new Set()
      return
    }
    const c = this.cur
    if (!c) return
    this.cur = null
    // The op moves from "in progress" to the committed buffer; the next repaint
    // draws the exact same pixels from the buffer instead, so nothing changes
    // on screen — no flicker, no pop.
    renderOp(this.base, c)
    this.repaint()
    this.push(c)
  }

  addText (op: Omit<TextOp, 'id'>): void {
    const full: TextOp = { ...op, id: this.doc.newId() }
    renderOp(this.base, full)
    this.repaint()
    this.push(full)
  }

  // Pick the topmost object under the point and start dragging it. Returns false
  // (and starts nothing) when the point isn't on any object, so a miss is inert.
  beginDrag (x: number, y: number): boolean {
    const id = this.pickAt(x, y)
    if (id < 0) return false
    this.dragging = true
    this.dragId = id
    this.dragStartX = x
    this.dragStartY = y
    this.dragDx = 0
    this.dragDy = 0
    return true
  }

  clearInk (): void {
    if (!this.doc.clearable) return
    this.push({ kind: 'clear' })
    this.replay()
  }

  undo (): void {
    if (!this.doc.undo()) return
    this.replay()
    this.notify()
  }

  redo (): void {
    if (!this.doc.redo()) return
    this.replay()
    this.notify()
  }

  private scheduleRepaint (): void {
    if (this.raf !== 0) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.repaint()
    })
  }

  // A live drag re-renders the whole buffer each frame (the moved object shifts
  // relative to everything else), so coalesce those replays to one per frame.
  private scheduleReplay (): void {
    if (this.replayRaf !== 0) return
    this.replayRaf = requestAnimationFrame(() => {
      this.replayRaf = 0
      this.replay()
    })
  }

  // Full repaint: committed buffer blitted first, then the in-progress op
  // stroked on top with the same renderOp used at commit time, so the live
  // preview and the final ink are always pixel-identical. The brush-size ring
  // paints last so it rides above the ink under the pointer.
  private repaint (): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    const s = this.screen
    s.setTransform(1, 0, 0, 1, 0, 0)
    s.clearRect(0, 0, this.screenC.width, this.screenC.height)
    s.drawImage(this.baseC, 0, 0)
    if (this.cur) {
      s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      renderOp(s, this.cur)
    }
    if (this.previewTool && this.hasPointer) {
      // Same look the old cursor bitmap had: translucent fill of the brush
      // colour, white ring, dark outer ring so it reads on any background.
      const d = clamp(toolWidth(this.previewTool, this.previewSize), 6, 64)
      s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      s.save()
      s.beginPath()
      s.arc(this.pointerX, this.pointerY, d / 2, 0, TAU)
      s.globalAlpha = 0.35
      s.fillStyle = this.previewColor
      s.fill()
      s.globalAlpha = 1
      s.lineWidth = 1.5
      s.strokeStyle = '#fff'
      s.stroke()
      s.beginPath()
      s.arc(this.pointerX, this.pointerY, d / 2 + 1.5, 0, TAU)
      s.lineWidth = 1
      s.strokeStyle = 'rgba(0,0,0,.8)'
      s.stroke()
      s.restore()
    }
  }

  private push (op: Op): void {
    this.doc.push(op)
    this.notify()
  }

  private notify (): void {
    this.onHistory({ canUndo: this.doc.canUndo, canRedo: this.doc.canRedo })
  }

  private clearCtx (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  // The Engine's transient drag, packaged for InkDoc.offsets — undefined unless
  // a drag is actually live.
  private liveDrag (): { id: number; dx: number; dy: number } | undefined {
    return this.dragging && this.dragId >= 0
      ? { id: this.dragId, dx: this.dragDx, dy: this.dragDy }
      : undefined
  }

  // Topmost visible object under the point, accounting for any moves already
  // applied to it (hit-test the query point in the object's own frame). -1 if
  // the point is empty.
  private pickAt (x: number, y: number): number {
    const tol = 8
    const ops = this.doc.all
    const hidden = this.doc.hiddenIds(this.pendingErase)
    const offs = this.doc.offsets(this.liveDrag())
    const start = this.doc.activeStart()
    for (let i = ops.length - 1; i >= start; i--) {
      const op = ops[i]
      if (op.kind === 'erase' || op.kind === 'clear' || op.kind === 'move') continue
      if (hidden.has(op.id)) continue
      const o = offs.get(op.id)
      if (opHit(op, x - (o?.x ?? 0), y - (o?.y ?? 0), tol, this.base)) return op.id
    }
    return -1
  }

  private eraseAt (x: number, y: number): void {
    // Object erasing is a point pick, so keep a generous floor regardless of the
    // eraser size — it's meant to be easy to land on a stroke, not pixel-precise.
    const tol = Math.max(toolWidth('eraser', this.eraseSize) / 2, 12)
    const ops = this.doc.all
    const hidden = this.doc.hiddenIds(this.pendingErase)
    const offs = this.doc.offsets(this.liveDrag())
    const start = this.doc.activeStart()
    let changed = false
    for (let i = ops.length - 1; i >= start; i--) {
      const op = ops[i]
      if (op.kind === 'erase' || op.kind === 'clear' || op.kind === 'move') continue
      if (hidden.has(op.id)) continue
      const o = offs.get(op.id)
      if (opHit(op, x - (o?.x ?? 0), y - (o?.y ?? 0), tol, this.base)) {
        this.pendingErase.add(op.id)
        hidden.add(op.id)
        changed = true
      }
    }
    if (changed) this.replay()
  }

  private replay (): void {
    this.clearCtx(this.base, this.baseC)
    const ops = this.doc.all
    const start = this.doc.activeStart()
    const hidden = this.doc.hiddenIds(this.pendingErase)
    const offs = this.doc.offsets(this.liveDrag())
    for (let i = start; i < ops.length; i++) {
      const op = ops[i]
      if (op.kind === 'erase' || op.kind === 'clear' || op.kind === 'move') continue
      if (hidden.has(op.id)) continue
      const o = offs.get(op.id)
      if (o) {
        this.base.save()
        this.base.translate(o.x, o.y)
        renderOp(this.base, op)
        this.base.restore()
      } else {
        renderOp(this.base, op)
      }
    }
    this.repaint()
  }
}

// Same glyph as the toolbar's lucide Eraser icon, stroked white over a dark
// outline so it stays visible on any background.
function eraserCursor (): string {
  const c = document.createElement('canvas')
  c.width = c.height = 28
  const ctx = c.getContext('2d')!
  ctx.translate(2, 2)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const paths = [
    new Path2D('m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21'),
    new Path2D('M22 21H7'),
    new Path2D('m5 11 9 9')
  ]
  ctx.strokeStyle = 'rgba(0,0,0,.9)'
  ctx.lineWidth = 3.4
  for (const p of paths) ctx.stroke(p)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  for (const p of paths) ctx.stroke(p)
  // Hotspot at the eraser's lower-left rubbing corner.
  return `url(${c.toDataURL()}) 7 21, crosshair`
}

// Four-arrow move glyph (lucide Move), stroked white over a dark outline so the
// drag cursor reads on any background — the same treatment as the eraser.
function moveCursor (): string {
  const c = document.createElement('canvas')
  c.width = c.height = 28
  const ctx = c.getContext('2d')!
  ctx.translate(2, 2)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const paths = [
    new Path2D('M5 9 2 12 5 15'),
    new Path2D('M9 5 12 2 15 5'),
    new Path2D('M15 19 12 22 9 19'),
    new Path2D('M19 9 22 12 19 15'),
    new Path2D('M2 12h20'),
    new Path2D('M12 2v20')
  ]
  ctx.strokeStyle = 'rgba(0,0,0,.9)'
  ctx.lineWidth = 3.4
  for (const p of paths) ctx.stroke(p)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  for (const p of paths) ctx.stroke(p)
  // Hotspot at the glyph's centre (12,12 in its own space, +2 for the inset).
  return `url(${c.toDataURL()}) 14 14, move`
}

export function makeCursor (tool: Tool): string {
  if (tool === 'text') return 'text'
  if (tool === 'drag') return moveCursor()
  if (tool === 'eraser') return eraserCursor()
  // Pen/highlighter show only the in-canvas size ring (setBrushPreview), so hide
  // the OS cursor for them. The shape tools target a point: native crosshair.
  if (tool === 'pen' || tool === 'highlighter') return 'none'
  return 'crosshair'
}
