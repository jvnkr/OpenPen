import { makeCursor } from '../overlay/engine'
import type { ToolState } from '../types'
import type { DrawPoint } from '../ipc'

// The input-catcher page: a full-screen, effectively invisible window shown only
// in draw mode. It exists so the ink overlay can stay permanently click-through —
// a click-through window never counts as occluding the apps behind it, so
// background videos and games keep playing under the ink. This window takes the
// real pointer events instead and replays them into its display's overlay engine
// via 'draw-input' (routed through the main process).

const catchEl = document.getElementById('catch') as HTMLDivElement

let tool: ToolState = { tool: 'pen', color: '#ff3b30', size: 6 }

// Same cursors the overlay used when it caught input directly: native glyphs per
// tool, 'none' for pen/highlighter (their size ring is drawn in-canvas by the ink
// window, which tracks the pointer through the forwarded moves).
function applyCursor (): void {
  const c = makeCursor(tool.tool)
  document.body.style.cursor = c
  catchEl.style.cursor = c
}

window.openpen.on('tool-state', s => {
  tool = s
  applyCursor()
})

catchEl.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return
  // Keep receiving moves even if the pointer slips outside the window mid-stroke.
  catchEl.setPointerCapture(ev.pointerId)
  window.openpen.send('draw-input', {
    t: 'down',
    id: ev.pointerId,
    x: ev.clientX,
    y: ev.clientY,
    pressure: ev.pressure,
    pen: ev.pointerType === 'pen',
    shift: ev.shiftKey
  })
})

catchEl.addEventListener('pointermove', ev => {
  // Forward the full coalesced batch so fast strokes keep their fidelity, exactly
  // as the overlay's own handler did.
  const events = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [ev]
  const pts: DrawPoint[] = events.length
    ? events.map(e => ({ x: e.clientX, y: e.clientY, pressure: e.pressure }))
    : [{ x: ev.clientX, y: ev.clientY, pressure: ev.pressure }]
  window.openpen.send('draw-input', { t: 'move', id: ev.pointerId, pts, shift: ev.shiftKey })
})

const end = (ev: PointerEvent): void =>
  window.openpen.send('draw-input', { t: 'up', id: ev.pointerId })
catchEl.addEventListener('pointerup', end)
catchEl.addEventListener('pointercancel', end)

catchEl.addEventListener('pointerenter', ev =>
  window.openpen.send('draw-input', { t: 'enter', x: ev.clientX, y: ev.clientY }))
catchEl.addEventListener('pointerleave', () =>
  window.openpen.send('draw-input', { t: 'leave' }))

catchEl.addEventListener('wheel', ev =>
  window.openpen.send('draw-input', { t: 'wheel', x: ev.clientX, y: ev.clientY, dy: ev.deltaY }))

window.addEventListener('contextmenu', ev => ev.preventDefault())

applyCursor()
window.openpen.send('input-ready')
