import React, { useEffect, useRef } from 'react'

// The click-through cursor highlighter's paint layer: a halo that follows the
// real cursor, plus Epic-Pen-style click feedback. On the primary button the
// ring contracts as you hold; the instant you release, a fresh full-size halo is
// already on the cursor while the contracted ring detaches and swells outward as
// it fades. It lives on its own canvas above the ink so it never disturbs the
// drawing engine, and the main process feeds it the cursor position and button
// presses (this overlay's local coords) over IPC while highlight mode is on — the
// overlay window itself stays pass-through, so nothing here ever receives real
// pointer events.

const TAU = Math.PI * 2
// Press feedback timing/shape: a quick contract to PRESSED while held, then the
// released ring swells to EXPAND and fades over RELEASE_MS.
const PRESS_MS = 90
const RELEASE_MS = 420
const PRESSED = 0.62
const EXPAND = 2.4
// How quickly the drawn halo eases toward the true cursor each frame (0..1). A
// touch of lag reads as a soft, weighty spotlight rather than a rigid dot.
const LERP = 0.35
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
// Halo radius in CSS px, tied to the brush size so the size control tunes it.
const radiusFor = (size: number): number => clamp(size * 2.2, 16, 64)
// Base-halo scale while the button is held: 1 → PRESSED over PRESS_MS, eased.
const pressScale = (dt: number): number => {
  const t = clamp(dt / PRESS_MS, 0, 1)
  return 1 + (PRESSED - 1) * (1 - Math.pow(1 - t, 3))
}

interface Pt { x: number; y: number }
// A released ring flying outward from where the click let go.
interface Pulse { x: number; y: number; fromScale: number; startAt: number }

// Accepts the app's #rgb / #rrggbb colours; falls back to the default red so a
// stray value can never blank the halo.
function hexToRgb (hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = Number.parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return [255, 59, 48]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

interface Props {
  active: boolean
  color: string
  size: number
}

export default function CursorHighlighter ({ active, color, size }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({
    active,
    rgb: hexToRgb(color),
    radius: radiusFor(size),
    target: null as Pt | null, // true cursor position, null while off this display
    pos: null as Pt | null, // eased render position
    pressDownAt: null as number | null, // set while the primary button is held
    pulses: [] as Pulse[], // released rings expanding + fading, one per click
    dpr: 1,
    raf: 0,
  })
  // Lets the props effect kick the animation loop without depending on the
  // frame closures defined inside the mount effect.
  const scheduleRef = useRef<() => void>(() => {})

  // Owns the render loop, the IPC feed and the resize handling for the layer's
  // whole lifetime. Everything it needs lives in refs, so it sets up once.
  useEffect(() => {
    const st = stateRef.current
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // The bright colour ring plus a dark contour, so it reads on any background.
    // `alpha` scales the whole thing (used to fade the released ring out).
    const paintRing = (x: number, y: number, radius: number, alpha: number): void => {
      const [r, g, b] = st.rgb
      ctx.lineWidth = 1
      ctx.strokeStyle = `rgba(0,0,0,${0.35 * alpha})`
      ctx.beginPath()
      ctx.arc(x, y, radius + 1, 0, TAU)
      ctx.stroke()
      ctx.lineWidth = 2
      ctx.strokeStyle = `rgba(${r},${g},${b},${0.9 * alpha})`
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, TAU)
      ctx.stroke()
    }

    // The steady halo: a soft translucent disc under the ring.
    const paintHalo = (x: number, y: number, radius: number): void => {
      const [r, g, b] = st.rgb
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
      grad.addColorStop(0, `rgba(${r},${g},${b},0.28)`)
      grad.addColorStop(0.7, `rgba(${r},${g},${b},0.14)`)
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, TAU)
      ctx.fill()
      paintRing(x, y, radius, 1)
    }

    const schedule = (): void => {
      if (st.raf === 0) st.raf = requestAnimationFrame(draw)
    }
    scheduleRef.current = schedule

    function draw (): void {
      st.raf = 0
      const now = performance.now()

      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)
      ctx!.setTransform(st.dpr, 0, 0, st.dpr, 0, 0)

      if (st.target) {
        if (!st.pos) st.pos = { x: st.target.x, y: st.target.y }
        else {
          st.pos.x += (st.target.x - st.pos.x) * LERP
          st.pos.y += (st.target.y - st.pos.y) * LERP
        }
      } else {
        st.pos = null
      }

      // Released rings first, so the steady halo sits on top of them as they pass
      // back through. Each is anchored where its click let go and follows its own
      // clock, so spamming clicks stacks independent rings instead of resetting.
      if (st.pulses.length > 0) {
        st.pulses = st.pulses.filter(p => now - p.startAt < RELEASE_MS)
        for (const pulse of st.pulses) {
          const t = (now - pulse.startAt) / RELEASE_MS
          const e = 1 - Math.pow(1 - t, 3)
          const scale = pulse.fromScale + (EXPAND - pulse.fromScale) * e
          paintRing(pulse.x, pulse.y, st.radius * scale, 1 - t)
        }
      }

      // The steady halo, contracted while the button is held.
      if (st.active && st.pos) {
        const scale = st.pressDownAt !== null ? pressScale(now - st.pressDownAt) : 1
        paintHalo(st.pos.x, st.pos.y, st.radius * scale)
      }

      // Keep animating while there's a halo to track or a pulse still playing;
      // otherwise stop and let the next pointer/press IPC kick the loop again.
      if ((st.active && st.target) || st.pressDownAt !== null || st.pulses.length > 0) schedule()
    }

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      st.dpr = dpr
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      schedule()
    }
    resize()

    // Positions arrive in this overlay's local coords; a null position means the
    // cursor left this display. Presses are broadcast to every overlay, so ignore
    // them unless this one currently has the halo.
    const offs = [
      window.openpen.on('highlight-pointer', p => {
        st.target = p
        if (p) schedule()
      }),
      window.openpen.on('highlight-press', down => {
        const now = performance.now()
        if (down) {
          st.pressDownAt = now
        } else if (st.pressDownAt !== null) {
          // Detach the held ring into an outward pulse at the release point, then
          // let the steady halo snap back to full size on the cursor.
          if (st.pos) {
            st.pulses.push({
              x: st.pos.x,
              y: st.pos.y,
              fromScale: pressScale(now - st.pressDownAt),
              startAt: now,
            })
          }
          st.pressDownAt = null
        }
        schedule()
      }),
    ]
    window.addEventListener('resize', resize)

    return () => {
      offs.forEach(off => off())
      window.removeEventListener('resize', resize)
      if (st.raf !== 0) cancelAnimationFrame(st.raf)
    }
  }, [])

  // Keep the live tool colour, brush size and on/off flag in the render state,
  // and run a frame so turning the layer off clears it immediately.
  useEffect(() => {
    const st = stateRef.current
    st.active = active
    st.rgb = hexToRgb(color)
    st.radius = radiusFor(size)
    if (!active) {
      st.target = null
      st.pressDownAt = null
      st.pulses = []
    }
    scheduleRef.current()
  }, [active, color, size])

  return <canvas ref={canvasRef} className="cursor-highlight" />
}
