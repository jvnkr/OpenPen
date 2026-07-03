import React, { useEffect, useMemo, useRef } from 'react'

// Screen colour picker. The main process freezes the display under the cursor
// (content-protected so OpenPen's own UI is excluded) and sends the PNG here.
// We show it 1:1, sample the exact pixel under the cursor from an offscreen
// canvas at the capture's native resolution, and render a magnifier loupe so
// the user can land on the pixel they want. Click picks, right-click/Esc cancels.

export interface EyeDropData { png: Uint8Array; x: number; y: number }

interface Props {
  data: EyeDropData
  onPick: (hex: string) => void
  onCancel: () => void
}

const LOUPE = 132 // loupe diameter (px)
const ZOOM = 11 // magnification inside the loupe (also the highlighted cell size)
const toHex = (n: number): string => n.toString(16).padStart(2, '0')

export default function EyeDropper ({ data, onPick, onCancel }: Props): React.JSX.Element {
  const W = window.innerWidth
  const H = window.innerHeight
  const imgUrl = useMemo(
    () => URL.createObjectURL(new Blob([data.png as BlobPart], { type: 'image/png' })),
    [data]
  )
  useEffect(() => () => URL.revokeObjectURL(imgUrl), [imgUrl])

  // Offscreen canvas at the capture's native resolution for exact pixel reads.
  const sampleRef = useRef<CanvasRenderingContext2D | null>(null)
  const scaleRef = useRef(1) // native image px per CSS px
  const loupeRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLSpanElement>(null)
  const hexRef = useRef<HTMLSpanElement>(null)
  const currentHex = useRef('#000000')

  const readAt = (cssX: number, cssY: number): string => {
    const ctx = sampleRef.current
    if (!ctx) return currentHex.current
    const s = scaleRef.current
    const px = Math.max(0, Math.min(ctx.canvas.width - 1, Math.round(cssX * s)))
    const py = Math.max(0, Math.min(ctx.canvas.height - 1, Math.round(cssY * s)))
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }

  // Update the loupe + readout by writing straight to the DOM (no re-render).
  const paint = (cssX: number, cssY: number): void => {
    const hex = readAt(cssX, cssY)
    currentHex.current = hex
    const loupe = loupeRef.current
    if (loupe) {
      // Offset the loupe from the cursor, flipping near the right/bottom edges.
      let lx = cssX + 20
      let ly = cssY + 20
      if (lx + LOUPE > W) lx = cssX - LOUPE - 20
      if (ly + LOUPE > H) ly = cssY - LOUPE - 20
      loupe.style.transform = `translate(${lx}px, ${ly}px)`
      loupe.style.backgroundPosition =
        `${LOUPE / 2 - cssX * ZOOM}px ${LOUPE / 2 - cssY * ZOOM}px`
    }
    if (dotRef.current) dotRef.current.style.background = hex
    if (hexRef.current) hexRef.current.textContent = hex.toUpperCase()
  }

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      sampleRef.current = ctx
      scaleRef.current = img.naturalWidth / W
      paint(data.x, data.y)
    }
    img.src = imgUrl
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgUrl])

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => paint(e.clientX, e.clientY)
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    onPick(readAt(e.clientX, e.clientY))
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
      <img src={imgUrl} width={W} height={H} draggable={false} alt="" />
      <div
        ref={loupeRef}
        className="eyedrop-loupe"
        style={{
          width: LOUPE,
          height: LOUPE,
          backgroundImage: `url(${imgUrl})`,
          backgroundSize: `${W * ZOOM}px ${H * ZOOM}px`
        }}
      >
        <div className="eyedrop-cell" style={{ width: ZOOM, height: ZOOM }} />
      </div>
      <div className="eyedrop-badge">
        <span ref={dotRef} className="eyedrop-swatch" />
        <span ref={hexRef}>#000000</span>
        <span className="eyedrop-hint">Click to pick. Right-click or Esc to cancel.</span>
      </div>
    </div>
  )
}
