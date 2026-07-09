import React, { useEffect, useRef } from 'react'

// Realtime screen colour picker. The overlay stays transparent; on each move we
// ask main for a tiny live BitBlt around the cursor and paint it into the loupe.
// No full-display freeze, no PNG round-trip.

export interface EyeDropData { x: number; y: number }

interface Props {
  data: EyeDropData
  onPick: (hex: string) => void
  onCancel: () => void
}

// Odd sample so the cursor pixel sits dead-centre. Loupe size is an exact
// multiple of the sample so each screen pixel maps to an integer block of
// loupe pixels (no fractional stretch that makes cells look too wide).
const SAMPLE = 11
const PIXEL = 12 // CSS px per screen pixel inside the loupe
const LOUPE = SAMPLE * PIXEL

export default function EyeDropper ({ data, onPick, onCancel }: Props): React.JSX.Element {
  const W = window.innerWidth
  const H = window.innerHeight
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const loupeWrapRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLSpanElement>(null)
  const hexRef = useRef<HTMLSpanElement>(null)
  const currentHex = useRef('#000000')
  const pending = useRef(false)
  const lastCss = useRef({ x: data.x, y: data.y })

  const paintLoupe = (rgba: Uint8Array, width: number, height: number, hex: string): void => {
    currentHex.current = hex
    const canvas = loupeRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        // Put the sample 1:1 into a tiny canvas, then nearest-neighbour scale
        // by an integer factor so each screen pixel is a sharp PIXEL×PIXEL block.
        const tmp = document.createElement('canvas')
        tmp.width = width
        tmp.height = height
        const tctx = tmp.getContext('2d')
        if (tctx) {
          const img = tctx.createImageData(width, height)
          img.data.set(rgba)
          tctx.putImageData(img, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, LOUPE, LOUPE)
          ctx.drawImage(tmp, 0, 0, width, height, 0, 0, LOUPE, LOUPE)
        }
      }
    }
    if (dotRef.current) dotRef.current.style.background = hex
    if (hexRef.current) hexRef.current.textContent = hex.toUpperCase()
  }

  const placeLoupe = (cssX: number, cssY: number): void => {
    const wrap = loupeWrapRef.current
    if (!wrap) return
    let lx = cssX + 20
    let ly = cssY + 20
    if (lx + LOUPE > W) lx = cssX - LOUPE - 20
    if (ly + LOUPE > H) ly = cssY - LOUPE - 20
    wrap.style.transform = `translate(${lx}px, ${ly}px)`
  }

  const sampleAt = (cssX: number, cssY: number): void => {
    lastCss.current = { x: cssX, y: cssY }
    placeLoupe(cssX, cssY)
    if (pending.current) return
    pending.current = true
    void window.openpen.invoke('eyedrop-sample', { x: cssX, y: cssY, size: SAMPLE })
      .then(sample => {
        pending.current = false
        if (!sample) return
        // If the pointer moved while we waited, kick another sample so the
        // loupe catches up without queuing a storm of IPC calls.
        const { x, y } = lastCss.current
        if (x !== cssX || y !== cssY) sampleAt(x, y)
        paintLoupe(sample.rgba, sample.width, sample.height, sample.hex)
      })
      .catch(() => { pending.current = false })
  }

  useEffect(() => {
    sampleAt(data.x, data.y)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => sampleAt(e.clientX, e.clientY)
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // Use the loupe's current hex immediately so the toolbar can unhide with the
    // picked colour already applied (no wait on a final sample round-trip).
    placeLoupe(e.clientX, e.clientY)
    onPick(currentHex.current)
  }
  const onCtx = (e: React.MouseEvent<HTMLDivElement>): void => { e.preventDefault(); onCancel() }

  return (
    <div
      className="eyedrop-root"
      style={{ cursor: 'crosshair' }}
      onPointerMove={onMove}
      onClick={onClick}
      onContextMenu={onCtx}
    >
      <div ref={loupeWrapRef} className="eyedrop-loupe" style={{ width: LOUPE, height: LOUPE }}>
        <canvas ref={loupeRef} width={LOUPE} height={LOUPE} className="eyedrop-loupe-canvas" />
        <div className="eyedrop-cell" style={{ width: PIXEL, height: PIXEL }} />
      </div>
      <div className="eyedrop-badge">
        <span ref={dotRef} className="eyedrop-swatch" />
        <span ref={hexRef}>#000000</span>
        <span className="eyedrop-hint">Click to pick. Right-click or Esc to cancel.</span>
      </div>
    </div>
  )
}
