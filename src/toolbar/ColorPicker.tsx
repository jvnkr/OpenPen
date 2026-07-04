import React, { useEffect, useState } from 'react'
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

// Chromium's native screen colour picker; only offered when the runtime exposes it.
interface EyeDropperResult { sRGBHex: string }
interface EyeDropperCtor { new (): { open: () => Promise<EyeDropperResult> } }
const eyeDropperCtor = (window as { EyeDropper?: EyeDropperCtor }).EyeDropper

// The color-picker panel that lives inside the toolbar's popover (same surface
// as the brush-size and fade menus). Owns its swatch palette; the current colour
// is lifted to the toolbar via `onChange`.
export function ColorPicker ({
  color,
  onChange,
}: {
  color: string
  onChange: (c: string) => void
}): React.JSX.Element {
  const [swatches, setSwatches] = useState<string[]>(loadSwatches)

  useEffect(() => {
    localStorage.setItem(SWATCH_KEY, JSON.stringify(swatches))
  }, [swatches])

  // Save the current colour to the front of the palette (dedup, capped).
  const saveCurrent = (): void => {
    const c = color.toLowerCase()
    setSwatches(prev => [c, ...prev.filter(s => s.toLowerCase() !== c)].slice(0, MAX_SWATCHES))
  }
  const removeSwatch = (c: string): void => {
    setSwatches(prev => prev.filter(s => s.toLowerCase() !== c.toLowerCase()))
  }
  const eyedrop = async (): Promise<void> => {
    if (!eyeDropperCtor) return
    try {
      const result = await new eyeDropperCtor().open()
      onChange(result.sRGBHex)
    } catch { /* user cancelled */ }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="h-36">
        <HexColorPicker color={color} onChange={onChange} />
      </div>
      <div className="flex items-center gap-1.5">
        <HexColorInput
          color={color}
          onChange={onChange}
          prefixed
          className="h-7 min-w-0 flex-1 rounded-md border bg-secondary px-2 text-center text-xs uppercase text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {eyeDropperCtor && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Pick a color from the screen"
            onClick={() => { void eyedrop() }}
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
