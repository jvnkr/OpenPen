import { getStroke } from 'perfect-freehand'
import type { HistoryState, Tool } from '@/types'

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))

// `pressure` (0..1) comes straight from the pointer event; perfect-freehand
// reads it by that key. It's only honoured when the stroke was drawn with a real
// pressure device (see StrokeOp.realPressure), otherwise pressure is simulated.
export interface Point { x: number; y: number; pressure?: number }

type InkKind = 'pen' | 'highlighter'
type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse'

interface StrokeOp {
  kind: InkKind
  id: number
  color: string
  size: number
  points: Point[]
  // True when a pressure-capable device (pen/tablet) drew this, so the outline
  // uses the recorded pressure instead of the velocity-simulated fallback.
  realPressure?: boolean
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

// A freehand arrow: a pen-like path that ends in an open (two-line) arrowhead
// pointing along the stroke's final direction. Uniform width, so the barbs
// match the line — unlike the pen's velocity-tapered fill.
interface ArrowStrokeOp {
  kind: 'curveArrow'
  id: number
  color: string
  size: number
  points: Point[]
}

export type DrawOp = StrokeOp | ShapeOp | TextOp | ArrowStrokeOp
export type Op = DrawOp | EraseOp | ClearOp | MoveOp
type LiveOp = StrokeOp | ShapeOp | ArrowStrokeOp

// The serializable snapshot of an ink document: the op log plus the id counter,
// under a schema version so the op shapes can evolve with a migration step
// instead of a breaking change. This is the persistence contract carried across
// the renderer↔main seam and stored by the board store — keep it JSON-only
// (every Op already is).
export interface SerializedDoc {
  version: 1
  ops: Op[]
  idSeq: number
}

// Effective stamp width per tool (highlighter/eraser are wider than the slider value)
const toolWidth = (tool: Tool, size: number): number =>
  tool === 'highlighter' ? size * 2 : tool === 'eraser' ? size * 2.5 : size

// perfect-freehand options (the excalidraw/tldraw approach): streamline eats
// input jitter, smoothing rounds the outline, thinning tapers with speed.
const PEN_FREEHAND = { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true, last: true }
// Same pen, but honouring the real pressure recorded from a tablet/pen instead
// of faking it from velocity.
const PEN_REAL = { ...PEN_FREEHAND, simulatePressure: false }
// Highlighter stays a uniform-width marker — no taper, no fake pressure.
const HL_FREEHAND = { thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true }
const ERASER_HOVER_ALPHA = 0.45

// Fading ink: over the chosen total lifetime, stay fully opaque for the first
// quarter, then fade to nothing over the rest.
const FADE_HOLD_FRAC = 0.25
function fadeAlpha (now: number, born: number, dur: number): number {
  const t = now - born
  const hold = dur * FADE_HOLD_FRAC
  if (t <= hold) return 1
  return Math.max(0, 1 - (t - hold) / (dur - hold))
}

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
const ARROW_SPREAD = Math.PI / 6

// The open, two-barb arrowhead shared by the straight and freehand arrows: two
// lines swept back from the tip at ±spread around `ang` (the heading INTO the
// tip). Stroked with the caller's current lineWidth/strokeStyle, so it matches
// the shaft; the round line cap fuses the two barbs cleanly at the tip.
function strokeArrowhead (ctx: CanvasRenderingContext2D, tipX: number, tipY: number, ang: number, head: number): void {
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - head * Math.cos(ang - ARROW_SPREAD), tipY - head * Math.sin(ang - ARROW_SPREAD))
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - head * Math.cos(ang + ARROW_SPREAD), tipY - head * Math.sin(ang + ARROW_SPREAD))
  ctx.stroke()
}

function drawArrow (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, size: number): void {
  const ang = Math.atan2(y1 - y0, x1 - x0)
  const head = Math.min(arrowHeadLen(size), Math.hypot(x1 - x0, y1 - y0))
  // Shaft runs the full length to the tip; the open head strokes on top of it.
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
  strokeArrowhead(ctx, x1, y1, ang, head)
}

// A smooth centreline through the points (midpoint-quadratic smoothing — the
// classic signature curve). Stroked with a round cap/join it reads as a clean
// hand-drawn line, without the freehand fill's velocity taper.
function centerlinePath (pts: Point[]): Path2D {
  const p = new Path2D()
  p.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 2) {
    p.lineTo(pts[1].x, pts[1].y)
    return p
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    p.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  p.lineTo(last.x, last.y)
  return p
}

// Total length of the polyline through pts.
function pathLength (pts: Point[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

// Heading (radians) at the stroke's tip: the chord over a `back`-px window of
// path ending `trim` px before the tip. Distances are measured along the path,
// not as the crow flies — a curled ending must not pick a reference on the
// wrong side of the curl. The trim drops the last few pixels the hand smears
// while releasing the button, so that wobble anchors the head (it is the real
// tip) but never steers it; the chord over the window is the length-weighted
// average of the segment directions before the wobble. If the path curls so
// tightly that the chord collapses, keep walking until it's meaningful — a
// degenerate chord would aim the head at a garbage angle.
// Exported for unit tests.
export function tipAngle (pts: Point[], back: number, trim = 0): number {
  const tip = pts[pts.length - 1]
  let ax = tip.x
  let ay = tip.y
  let bx = pts[0].x
  let by = pts[0].y
  let along = 0
  let trimmed = trim <= 0
  for (let i = pts.length - 2; i >= 0; i--) {
    along += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    if (!trimmed) {
      if (along < trim) continue
      trimmed = true
      ax = pts[i].x
      ay = pts[i].y
      along = 0
      continue
    }
    bx = pts[i].x
    by = pts[i].y
    if (along >= back && Math.hypot(ax - bx, ay - by) >= back * 0.3) break
  }
  // A stroke barely longer than the trim can leave the window empty; fall back
  // to the plain tip→start chord rather than a zero vector.
  if (Math.hypot(ax - bx, ay - by) < 0.01) {
    return Math.atan2(tip.y - pts[0].y, tip.x - pts[0].x)
  }
  return Math.atan2(ay - by, ax - bx)
}

// --- SVG export --------------------------------------------------------------
// A vector serialization of the ops that mirrors renderOp's geometry, so an
// exported SVG matches the canvas. It lives in this module to reuse the same
// private geometry (constrainLine/Rect, the freehand outline, the arrow heading)
// — one source of truth for each op's shape.

const svgNum = (n: number): string => String(Math.round(n * 100) / 100)

function escapeXml (s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The freehand outline polygon as an SVG path `d`, with the same
// midpoint-quadratic smoothing outlinePath uses on the canvas.
function outlineToPathD (outline: number[][]): string {
  if (outline.length === 0) return ''
  const d = [`M${svgNum(outline[0][0])} ${svgNum(outline[0][1])}`]
  for (let i = 1; i < outline.length; i++) {
    const a = outline[i]
    const b = outline[(i + 1) % outline.length]
    d.push(`Q${svgNum(a[0])} ${svgNum(a[1])} ${svgNum((a[0] + b[0]) / 2)} ${svgNum((a[1] + b[1]) / 2)}`)
  }
  d.push('Z')
  return d.join(' ')
}

// A pen/highlighter outline as a filled path, or a dot for a single tap — the
// two cases fillFreehand draws.
function freehandSvg (pts: Point[], width: number, color: string, opts: typeof PEN_FREEHAND, opacity: number): string {
  const fo = opacity === 1 ? '' : ` fill-opacity="${opacity}"`
  if (pts.length < 2) {
    const p = pts[0]
    return `<circle cx="${svgNum(p.x)}" cy="${svgNum(p.y)}" r="${svgNum(width / 2)}" fill="${color}"${fo}/>`
  }
  return `<path d="${outlineToPathD(getStroke(pts, { size: width, ...opts }))}" fill="${color}"${fo}/>`
}

// A stroked open path (shaft, curve, shape outline), round-capped like the
// canvas (renderOp sets round join/cap globally).
function strokeSvg (d: string, color: string, width: number): string {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${svgNum(width)}" stroke-linecap="round" stroke-linejoin="round"/>`
}

// The open two-barb arrowhead as extra subpaths — the same barbs strokeArrowhead
// draws (±ARROW_SPREAD around the heading into the tip).
function arrowheadD (tipX: number, tipY: number, ang: number, head: number): string {
  const ax = tipX - head * Math.cos(ang - ARROW_SPREAD)
  const ay = tipY - head * Math.sin(ang - ARROW_SPREAD)
  const bx = tipX - head * Math.cos(ang + ARROW_SPREAD)
  const by = tipY - head * Math.sin(ang + ARROW_SPREAD)
  return ` M${svgNum(tipX)} ${svgNum(tipY)} L${svgNum(ax)} ${svgNum(ay)} M${svgNum(tipX)} ${svgNum(tipY)} L${svgNum(bx)} ${svgNum(by)}`
}

// Centreline `d` for the freehand arrow — the same midpoint-quadratic curve as
// centerlinePath.
function centerlineD (pts: Point[]): string {
  if (pts.length === 0) return ''
  const d = [`M${svgNum(pts[0].x)} ${svgNum(pts[0].y)}`]
  if (pts.length === 2) {
    d.push(`L${svgNum(pts[1].x)} ${svgNum(pts[1].y)}`)
    return d.join(' ')
  }
  for (let i = 1; i < pts.length - 1; i++) {
    d.push(`Q${svgNum(pts[i].x)} ${svgNum(pts[i].y)} ${svgNum((pts[i].x + pts[i + 1].x) / 2)} ${svgNum((pts[i].y + pts[i + 1].y) / 2)}`)
  }
  const last = pts[pts.length - 1]
  d.push(`L${svgNum(last.x)} ${svgNum(last.y)}`)
  return d.join(' ')
}

// One drawable op as SVG markup, mirroring renderOp. Exported for unit tests.
export function opToSvg (op: DrawOp): string {
  switch (op.kind) {
    case 'pen':
      return freehandSvg(op.points, op.size, op.color, op.realPressure ? PEN_REAL : PEN_FREEHAND, 1)
    case 'highlighter':
      return freehandSvg(op.points, toolWidth('highlighter', op.size), op.color, HL_FREEHAND, 0.35)
    case 'line': {
      const [x1, y1] = constrainLine(op)
      return strokeSvg(`M${svgNum(op.x0)} ${svgNum(op.y0)} L${svgNum(x1)} ${svgNum(y1)}`, op.color, op.size)
    }
    case 'arrow': {
      const [x1, y1] = constrainLine(op)
      const ang = Math.atan2(y1 - op.y0, x1 - op.x0)
      const head = Math.min(arrowHeadLen(op.size), Math.hypot(x1 - op.x0, y1 - op.y0))
      const d = `M${svgNum(op.x0)} ${svgNum(op.y0)} L${svgNum(x1)} ${svgNum(y1)}` + arrowheadD(x1, y1, ang, head)
      return strokeSvg(d, op.color, op.size)
    }
    case 'rect': {
      const r = constrainRect(op)
      return `<rect x="${svgNum(r.x)}" y="${svgNum(r.y)}" width="${svgNum(r.w)}" height="${svgNum(r.h)}" fill="none" stroke="${op.color}" stroke-width="${svgNum(op.size)}" stroke-linejoin="round"/>`
    }
    case 'ellipse': {
      const r = constrainRect(op)
      return `<ellipse cx="${svgNum(r.x + r.w / 2)}" cy="${svgNum(r.y + r.h / 2)}" rx="${svgNum(r.w / 2)}" ry="${svgNum(r.h / 2)}" fill="none" stroke="${op.color}" stroke-width="${svgNum(op.size)}"/>`
    }
    case 'curveArrow': {
      const pts = op.points
      if (pts.length < 2) {
        return `<circle cx="${svgNum(pts[0].x)}" cy="${svgNum(pts[0].y)}" r="${svgNum(op.size / 2)}" fill="${op.color}"/>`
      }
      const tip = pts[pts.length - 1]
      const len = pathLength(pts)
      const head = Math.min(arrowHeadLen(op.size), len)
      const ang = tipAngle(pts, clamp(head / 2, Math.max(op.size, 8), head), Math.min(6, len / 4))
      return strokeSvg(centerlineD(pts) + arrowheadD(tip.x, tip.y, ang, head), op.color, op.size)
    }
    case 'text': {
      const tspans = op.text.split('\n').map((line, i) =>
        `<tspan x="${svgNum(op.x)}" y="${svgNum(op.y + i * op.fontPx * 1.25)}">${escapeXml(line)}</tspan>`).join('')
      return `<text fill="${op.color}" font-family="Segoe UI, system-ui, sans-serif" font-weight="600" font-size="${svgNum(op.fontPx)}px" dominant-baseline="text-before-edge" xml:space="preserve">${tspans}</text>`
    }
  }
}

// `alpha` scales the op's opacity (1 = normal). Used for the eraser-hover dim
// and the fading-ink effect, which both need to draw an op more faintly.
function renderOp (ctx: CanvasRenderingContext2D, op: Op, alpha = 1): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.globalAlpha = alpha
  switch (op.kind) {
    case 'pen':
      fillFreehand(ctx, op.points, op.color, op.size, op.realPressure ? PEN_REAL : PEN_FREEHAND)
      break
    case 'highlighter':
      ctx.globalAlpha = 0.35 * alpha
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
    case 'curveArrow': {
      ctx.strokeStyle = op.color
      ctx.fillStyle = op.color
      ctx.lineWidth = op.size
      const pts = op.points
      if (pts.length < 2) {
        // A single tap: just a dot, no head to point anywhere.
        ctx.beginPath()
        ctx.arc(pts[0].x, pts[0].y, op.size / 2, 0, TAU)
        ctx.fill()
        break
      }
      ctx.stroke(centerlinePath(pts))
      // Same open head as the straight arrow. Cap it to the stroke length so a
      // short flick can't grow a head bigger than the line itself.
      const tip = pts[pts.length - 1]
      const len = pathLength(pts)
      const head = Math.min(arrowHeadLen(op.size), len)
      // Aim the head along the line's heading AT the tip — a local window, not
      // the full barb chord (on a curved approach that chord points off the
      // line and the head looks rotated) — and skip the last few pixels of
      // mouse-release wobble so a straight line always gets a dead-centre head.
      const ang = tipAngle(
        pts,
        clamp(head / 2, Math.max(op.size, 8), head),
        Math.min(6, len / 4),
      )
      strokeArrowhead(ctx, tip.x, tip.y, ang, head)
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
    case 'curveArrow': {
      const t = tol + op.size / 2
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

  // Discard the entire log and both stacks — a hard history reset, after which
  // there is nothing to undo or redo.
  reset (): void {
    this.ops = []
    this.redoStack = []
    this.idSeq = 1
  }

  // Snapshot the whole log for persistence. Redo history is intentionally left
  // out — undone work isn't restored across restarts.
  serialize (): SerializedDoc {
    return { version: 1, ops: this.ops.slice(), idSeq: this.idSeq }
  }

  // Replace the log with a persisted snapshot and resume the id counter safely.
  load (data: SerializedDoc): void {
    this.ops = data.ops.slice()
    this.redoStack = []
    // A new id must never collide with a rehydrated one, or a later erase/move
    // would target the wrong object. Resume above both the saved counter and the
    // largest id actually present.
    let max = data.idSeq - 1
    for (const op of this.ops) if ('id' in op && op.id > max) max = op.id
    this.idSeq = max + 1
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
  // In-progress strokes/shapes, keyed by pointer id so several fingers (or a
  // pen plus a finger) can draw at once — multi-touch. Erasing and dragging stay
  // single-gesture; the pointer that started them owns them until release.
  private readonly live = new Map<number, LiveOp>()

  // Everything is presented on ONE visible canvas: committed ink lives on an
  // offscreen buffer, and each frame the screen is repainted as buffer + the
  // in-progress ops (how Excalidraw/tldraw render). Committing on pointer up
  // just moves the op into the buffer and repaints — pixel-identical output on
  // a single surface, so there is no cross-canvas compositor handoff to blink.
  private readonly screenC: HTMLCanvasElement
  private readonly screen: CanvasRenderingContext2D
  private readonly baseC: HTMLCanvasElement
  private readonly base: CanvasRenderingContext2D
  private readonly onHistory: (h: HistoryState) => void
  // Fired whenever the committed document changes (draw, erase, move, undo,
  // redo, clear) so the overlay can autosave. Fading ink never commits, so it
  // never triggers a save. Not fired on load — re-saving what we just read is
  // pointless.
  private readonly onChange?: () => void
  private readonly doc = new InkDoc()
  private dpr = 1
  // CSS pixel size of the board, tracked from resize so an export (and its PDF
  // page) can match the display without re-deriving it from device pixels.
  private cssW = 0
  private cssH = 0
  private erasing = false
  private erasePointer = -1
  private eraseSize = 0
  private pendingErase = new Set<number>()
  // In-progress drag: the owning pointer, picked object's id, and how far it has
  // moved so far.
  private dragging = false
  private dragPointer = -1
  private dragId = -1
  private dragStartX = 0
  private dragStartY = 0
  private dragDx = 0
  private dragDy = 0
  private raf = 0
  private replayRaf = 0
  // Fading ink: when on, finished strokes/shapes aren't
  // committed to the undo document — they go here and fade out on their own, so
  // they're temporary annotations that never need clearing.
  private fadeMode = false
  private fadeDur = 2000
  private fading: Array<{ op: LiveOp; born: number; dur: number }> = []
  private fadeRaf = 0
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
  private eraserHover = false
  private eraserHoverSize = 6
  private hoverEraseId = -1

  constructor (canvas: HTMLCanvasElement, onHistory: (h: HistoryState) => void, onChange?: () => void) {
    this.screenC = canvas
    this.screen = canvas.getContext('2d')!
    this.baseC = document.createElement('canvas')
    this.base = this.baseC.getContext('2d')!
    this.onHistory = onHistory
    this.onChange = onChange
  }

  resize (w: number, h: number, dpr: number): void {
    this.dpr = dpr
    this.cssW = w
    this.cssH = h
    for (const c of [this.screenC, this.baseC]) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    this.screenC.style.width = `${w}px`
    this.screenC.style.height = `${h}px`
    this.replay()
  }

  // True while any pointer interaction is live (drawing, erasing or dragging).
  get active (): boolean {
    return this.live.size > 0 || this.erasing || this.dragging
  }

  // Whether a specific pointer has a live gesture, so the overlay only forwards
  // that pointer's moves while they matter.
  hasGesture (pointerId: number): boolean {
    return this.live.has(pointerId) ||
      (this.erasing && this.erasePointer === pointerId) ||
      (this.dragging && this.dragPointer === pointerId)
  }

  // Wheel-resizing mid-gesture: live ops are re-rendered from their data every
  // repaint, so updating the op's size re-inks the whole in-progress stroke or
  // shape at the new width. An in-progress erase keeps its pick tolerance in
  // step the same way.
  setLiveSize (size: number): void {
    if (this.erasing) this.eraseSize = size
    let changed = false
    for (const op of this.live.values()) {
      if (op.size !== size) {
        op.size = size
        changed = true
      }
    }
    if (changed) this.scheduleRepaint()
  }

  // Toggle fading ink and set how long a stroke lives (ms) before
  // it's fully gone. Turning it off leaves anything already fading to finish.
  setFadeMode (on: boolean, durMs = this.fadeDur): void {
    this.fadeMode = on
    this.fadeDur = durMs
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

  // When the eraser is selected, dim the object under the pointer before click.
  setEraserHover (enabled: boolean, size = 6): void {
    const changed = enabled !== this.eraserHover || (enabled && size !== this.eraserHoverSize)
    this.eraserHover = enabled
    this.eraserHoverSize = size
    if (!enabled) {
      if (this.hoverEraseId >= 0) {
        this.hoverEraseId = -1
        this.replay()
      }
      return
    }
    if (changed) this.syncEraserHover()
  }

  // Track the pointer for the preview ring; null hides it (pointer left).
  setPointer (x: number | null, y = 0): void {
    if (x === null) {
      if (!this.hasPointer) return
      this.hasPointer = false
      if (this.previewTool) this.scheduleRepaint()
      if (this.eraserHover && this.hoverEraseId >= 0) {
        this.hoverEraseId = -1
        this.replay()
      }
      return
    }
    this.hasPointer = true
    this.pointerX = x
    this.pointerY = y
    if (this.previewTool) this.scheduleRepaint()
    if (this.eraserHover && !this.erasing && !this.dragging) this.syncEraserHover()
  }

  begin (
    pointerId: number, tool: Exclude<Tool, 'text'>, color: string, size: number,
    x: number, y: number, shift: boolean, pressure = 0.5, realPressure = false,
  ): void {
    // Dragging is driven through beginDrag, not begin; guard so a stray call
    // can never mint a bogus shape op with kind 'drag'.
    if (tool === 'drag') return
    if (tool === 'eraser') {
      // The eraser deletes whole objects; a drag can clear several at once. Only
      // one erase gesture runs at a time — extra fingers are ignored.
      if (this.erasing) return
      this.erasing = true
      this.erasePointer = pointerId
      this.eraseSize = size
      this.hoverEraseId = -1
      this.pendingErase = new Set()
      this.eraseAt(x, y)
      return
    }
    const op: LiveOp =
      tool === 'pen' || tool === 'highlighter'
        ? { kind: tool, id: this.doc.newId(), color, size, points: [{ x, y, pressure }], realPressure: realPressure && tool === 'pen' }
        : tool === 'curveArrow'
          ? { kind: 'curveArrow', id: this.doc.newId(), color, size, points: [{ x, y }] }
          : { kind: tool, id: this.doc.newId(), color, size, x0: x, y0: y, x1: x, y1: y, shift }
    this.live.set(pointerId, op)
    this.repaint()
  }

  move (pointerId: number, pts: Point[], shift: boolean): void {
    if (this.dragging && this.dragPointer === pointerId) {
      const p = pts[pts.length - 1]
      this.dragDx = p.x - this.dragStartX
      this.dragDy = p.y - this.dragStartY
      this.scheduleReplay()
      return
    }
    if (this.erasing && this.erasePointer === pointerId) {
      for (const p of pts) this.eraseAt(p.x, p.y)
      return
    }
    const c = this.live.get(pointerId)
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

  end (pointerId: number): void {
    if (this.dragging && this.dragPointer === pointerId) {
      this.dragging = false
      this.dragPointer = -1
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
    if (this.erasing && this.erasePointer === pointerId) {
      this.erasing = false
      this.erasePointer = -1
      // Bundle everything this drag removed into one erase op → one undo.
      if (this.pendingErase.size > 0) this.push({ kind: 'erase', ids: [...this.pendingErase] })
      this.pendingErase = new Set()
      if (this.eraserHover && this.hasPointer) this.syncEraserHover()
      return
    }
    const c = this.live.get(pointerId)
    if (!c) return
    this.live.delete(pointerId)
    if (this.fadeMode) {
      // Temporary ink: never touches the undo document, just fades out.
      this.fading.push({ op: c, born: performance.now(), dur: this.fadeDur })
      this.startFade()
      this.repaint()
      return
    }
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
  beginDrag (pointerId: number, x: number, y: number): boolean {
    if (this.dragging) return false
    const id = this.pickAt(x, y)
    if (id < 0) return false
    this.dragging = true
    this.dragPointer = pointerId
    this.dragId = id
    this.dragStartX = x
    this.dragStartY = y
    this.dragDx = 0
    this.dragDy = 0
    return true
  }

  // Drop every in-progress gesture without committing. Needed when draw mode
  // ends (input catchers hide before pointer-up arrives), and before clear /
  // reset so a mid-stroke release can't resurrect ink after the wipe.
  cancelGestures (): void {
    if (!this.active) return
    this.live.clear()
    this.erasing = false
    this.erasePointer = -1
    this.pendingErase = new Set()
    this.dragging = false
    this.dragPointer = -1
    this.dragId = -1
    this.dragDx = 0
    this.dragDy = 0
    this.hoverEraseId = -1
    this.replay()
  }

  clearInk (): void {
    // Clear wipes the screen, including any ink still fading.
    this.cancelGestures()
    const hadFading = this.fading.length > 0
    this.fading = []
    if (!this.doc.clearable) {
      if (hadFading) this.repaint()
      return
    }
    this.push({ kind: 'clear' })
    this.replay()
  }

  // Wipe everything — every op plus the undo/redo stacks — so nothing remains to
  // undo or redo. Unlike clearInk (which keeps history so the clear itself can be
  // undone), this is irreversible; the now-empty doc autosaves, which removes the
  // persisted board file.
  resetHistory (): void {
    this.cancelGestures()
    this.fading = []
    this.pendingErase = new Set()
    this.hoverEraseId = -1
    this.doc.reset()
    this.replay()
    this.notify()
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

  // Rehydrate persisted ink at startup: load the snapshot, repaint, and refresh
  // the toolbar's undo/redo state — without firing onChange (we'd just be
  // re-saving what we loaded).
  load (data: SerializedDoc): void {
    this.doc.load(data)
    this.replay()
    this.onHistory({
      canUndo: this.doc.canUndo,
      canRedo: this.doc.canRedo,
      clearable: this.doc.clearable
    })
  }

  // The current document as a persistable snapshot.
  serialize (): SerializedDoc {
    return this.doc.serialize()
  }

  // --- Export ----------------------------------------------------------------
  // Whether any visible committed ink exists to export (a drawable in the active
  // range that hasn't been erased).
  get exportable (): boolean {
    const ops = this.doc.all
    const start = this.doc.activeStart()
    const hidden = this.doc.hiddenIds()
    for (let i = start; i < ops.length; i++) {
      const op = ops[i]
      if (op.kind === 'erase' || op.kind === 'clear' || op.kind === 'move') continue
      if (!hidden.has(op.id)) return true
    }
    return false
  }

  // The board's CSS pixel size, so the exporter (and the PDF page) can match it.
  get exportSize (): { width: number; height: number } {
    return { width: this.cssW, height: this.cssH }
  }

  // Paint the committed, visible document (no live gesture, no hover dim) onto an
  // arbitrary context — the deterministic basis for a raster export.
  private paintDoc (ctx: CanvasRenderingContext2D): void {
    const ops = this.doc.all
    const start = this.doc.activeStart()
    const hidden = this.doc.hiddenIds()
    const offs = this.doc.offsets()
    for (let i = start; i < ops.length; i++) {
      const op = ops[i]
      if (op.kind === 'erase' || op.kind === 'clear' || op.kind === 'move') continue
      if (hidden.has(op.id)) continue
      const o = offs.get(op.id)
      if (o) {
        ctx.save()
        ctx.translate(o.x, o.y)
        renderOp(ctx, op)
        ctx.restore()
      } else {
        renderOp(ctx, op)
      }
    }
  }

  // The board as a PNG data URL at device resolution. `bg` fills the canvas first
  // (whiteboard/blackboard); null leaves it transparent.
  exportPNG (bg: string | null): string {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(this.cssW * this.dpr))
    c.height = Math.max(1, Math.round(this.cssH * this.dpr))
    const ctx = c.getContext('2d')!
    if (bg) {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, c.width, c.height)
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.paintDoc(ctx)
    return c.toDataURL('image/png')
  }

  // The board as an SVG document (vector). `bg` becomes a full-size backing rect;
  // null leaves the page transparent. Moved objects are wrapped in a translate.
  exportSVG (bg: string | null): string {
    const { width, height } = this.exportSize
    const ops = this.doc.all
    const start = this.doc.activeStart()
    const hidden = this.doc.hiddenIds()
    const offs = this.doc.offsets()
    const body: string[] = []
    for (let i = start; i < ops.length; i++) {
      const op = ops[i]
      if (op.kind === 'erase' || op.kind === 'clear' || op.kind === 'move') continue
      if (hidden.has(op.id)) continue
      const markup = opToSvg(op)
      const o = offs.get(op.id)
      body.push(o ? `<g transform="translate(${svgNum(o.x)} ${svgNum(o.y)})">${markup}</g>` : markup)
    }
    const backing = bg ? `<rect width="${svgNum(width)}" height="${svgNum(height)}" fill="${bg}"/>` : ''
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNum(width)}" height="${svgNum(height)}" viewBox="0 0 ${svgNum(width)} ${svgNum(height)}">` +
      `${backing}${body.join('')}</svg>\n`
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

  // Drive the fading-ink animation: repaint every frame while any temporary
  // stroke is still visible, dropping strokes once fully faded, then stop.
  private startFade (): void {
    if (this.fadeRaf !== 0) return
    this.fadeRaf = requestAnimationFrame(this.tickFade)
  }

  private tickFade = (): void => {
    this.fadeRaf = 0
    const now = performance.now()
    this.fading = this.fading.filter(f => now - f.born < f.dur)
    this.repaint()
    if (this.fading.length > 0) this.startFade()
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
    s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    for (const op of this.live.values()) renderOp(s, op)
    if (this.fading.length > 0) {
      const now = performance.now()
      for (const f of this.fading) {
        const a = fadeAlpha(now, f.born, f.dur)
        if (a > 0) renderOp(s, f.op, a)
      }
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
    this.onHistory({
      canUndo: this.doc.canUndo,
      canRedo: this.doc.canRedo,
      clearable: this.doc.clearable
    })
    this.onChange?.()
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
  private pickAt (x: number, y: number, tol = 8): number {
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

  private syncEraserHover (): void {
    if (!this.hasPointer) return
    const tol = Math.max(toolWidth('eraser', this.eraserHoverSize) / 2, 12)
    const id = this.pickAt(this.pointerX, this.pointerY, tol)
    if (id === this.hoverEraseId) return
    this.hoverEraseId = id
    this.replay()
  }

  private eraseAt (x: number, y: number): void {
    // Erase only the topmost object under the point — the same one the hover
    // highlights (pickAt, same generous tolerance floor so it's easy to land on
    // a stroke). pickAt skips already-pending ids, so dragging the eraser across
    // a stack still peels them off one at a time as each becomes topmost.
    const tol = Math.max(toolWidth('eraser', this.eraseSize) / 2, 12)
    const id = this.pickAt(x, y, tol)
    if (id < 0) return
    this.pendingErase.add(id)
    this.replay()
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
      const alpha = op.id === this.hoverEraseId && !this.erasing ? ERASER_HOVER_ALPHA : 1
      if (o) {
        this.base.save()
        this.base.translate(o.x, o.y)
        renderOp(this.base, op, alpha)
        this.base.restore()
      } else {
        renderOp(this.base, op, alpha)
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
