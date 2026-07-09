import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { Pipette, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Saved colour swatches persist in their own key — the toolbar overwrites the
// shared 'openpen' key wholesale, so storing swatches there would wipe them.
const SWATCH_KEY = 'openpen-swatches'
const DEFAULT_SWATCHES = ['#ffffff', '#000000', '#ffcc00', '#34c759']
const MAX_SWATCHES = 24

function loadSwatches (): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SWATCH_KEY) ?? 'null')
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[]
  } catch { /* first run / bad data */ }
  return [...DEFAULT_SWATCHES]
}

// White→clear (L→R) then black→clear (bottom→top), matching react-colorful's
// stock dual-gradient. Cached as a bitmap so Chromium scales pixels during the
// popover zoom instead of recompositing CSS gradients (which paints a seam).
let saturationOverlayUrl: string | null = null
function saturationOverlay (): string {
  if (saturationOverlayUrl) return saturationOverlayUrl
  const size = 256
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const white = ctx.createLinearGradient(0, 0, size, 0)
  white.addColorStop(0, '#ffffff')
  white.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = white
  ctx.fillRect(0, 0, size, size)
  const black = ctx.createLinearGradient(0, 0, 0, size)
  black.addColorStop(0, 'rgba(0,0,0,0)')
  black.addColorStop(1, '#000000')
  ctx.fillStyle = black
  ctx.fillRect(0, 0, size, size)
  saturationOverlayUrl = c.toDataURL('image/png')
  return saturationOverlayUrl
}

// The color-picker panel that lives inside the toolbar's popover (same surface
// as the brush-size and fade menus). Owns its swatch palette; the current colour
// is lifted to the toolbar via `onChange`. Screen picking goes through OpenPen's
// full-display eyedropper overlay (not Chromium's EyeDropper API, which can only
// sample this app's own surface in Electron).
export function ColorPicker ({
  color,
  onChange,
  onEyedrop,
  hexKey = 0,
}: {
  color: string
  onChange: (c: string) => void
  onEyedrop?: () => void
  // Remount only the hex field after an eyedrop pick (keeps its display in sync
  // without remounting the saturation picker, which would replay the popover zoom).
  hexKey?: number
}): React.JSX.Element {
  const [swatches, setSwatches] = useState<string[]>(loadSwatches)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem(SWATCH_KEY, JSON.stringify(swatches))
  }, [swatches])

  // Before paint: swap the CSS dual-gradient for a pre-rasterised overlay. Hue
  // still comes from react-colorful's inline backgroundColor underneath.
  useLayoutEffect(() => {
    const root = pickerRef.current
    if (!root) return
    root.style.setProperty('--op-sat-overlay', `url("${saturationOverlay()}")`)
    const el = root.querySelector<HTMLElement>('.react-colorful__saturation')
    if (!el) return
    // Override the library's injected dual-gradient with the bitmap.
    el.style.backgroundImage = 'var(--op-sat-overlay)'
    el.style.backgroundSize = '100% 100%'
    el.style.backgroundRepeat = 'no-repeat'
  }, [])

  // Save the current colour to the front of the palette (dedup, capped).
  const saveCurrent = (): void => {
    const c = color.toLowerCase()
    setSwatches(prev => [c, ...prev.filter(s => s.toLowerCase() !== c)].slice(0, MAX_SWATCHES))
  }
  const removeSwatch = (c: string): void => {
    setSwatches(prev => prev.filter(s => s.toLowerCase() !== c.toLowerCase()))
  }

  return (
    <div className="flex flex-col gap-2">
      <div ref={pickerRef} className="h-36">
        <HexColorPicker color={color} onChange={onChange} />
      </div>
      <div className="flex items-center gap-1.5">
        <HexColorInput
          key={hexKey}
          color={color}
          onChange={onChange}
          prefixed
          className="h-7 min-w-0 flex-1 rounded-md border bg-secondary px-2 text-center text-xs uppercase text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {onEyedrop && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Pick a color from the screen"
            aria-label="Pick a color from the screen"
            onClick={onEyedrop}
          >
            <Pipette />
          </Button>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Color presets
          </span>
          <button
            aria-label="Save current color"
            title="Save current color"
            onClick={saveCurrent}
            className="flex size-5 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3" />
          </button>
        </div>
        <div className="grid max-h-[76px] grid-cols-6 gap-1.5 overflow-y-auto pr-0.5">
          {swatches.map((swatch) => (
            <button
              key={swatch}
              aria-label={`Use ${swatch}`}
              title={`${swatch} (right-click to remove)`}
              onClick={() => onChange(swatch)}
              onContextMenu={e => { e.preventDefault(); removeSwatch(swatch) }}
              style={{ background: swatch }}
              className={cn(
                'aspect-square w-full cursor-pointer rounded-sm border border-border transition-[border-color] duration-150 ease-out hover:border-foreground/40',
                color.toLowerCase() === swatch.toLowerCase() && 'ring-2 ring-inset ring-ring',
              )}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
