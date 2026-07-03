import React, { useEffect, useRef, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { Pipette, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { applyDarkClass } from '@/lib/theme'
import { cn } from '@/lib/utils'
import '@/styles/globals.css'

interface SavedState { color?: string; theme?: string }

function loadSaved (): SavedState {
  try { return JSON.parse(localStorage.getItem('openpen') ?? '{}') as SavedState } catch { return {} }
}

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

interface EyeDropperResult { sRGBHex: string }
interface EyeDropperCtor { new (): { open(): Promise<EyeDropperResult> } }

const eyeDropperCtor = (window as { EyeDropper?: EyeDropperCtor }).EyeDropper

export default function Picker (): React.JSX.Element {
  const [color, setColor] = useState<string>(() => loadSaved().color ?? '#ff3b30')
  // Main toggles this over IPC; the window is shown empty first, then the panel
  // animates in — so there's no opaque flash on a transparent frameless window.
  const [visible, setVisible] = useState(false)
  const [swatches, setSwatches] = useState<string[]>(loadSwatches)
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    localStorage.setItem(SWATCH_KEY, JSON.stringify(swatches))
  }, [swatches])

  // Drive the transitions-dev menu-dropdown open/close on the panel. The panel
  // stays mounted (at its transparent pre-open rest state) so opening is a pure
  // CSS transition; on close we play the closing animation, then tell main it's
  // safe to actually hide the window — the handshake framer-motion's
  // onExitComplete used to provide.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    if (visible) {
      el.classList.remove('is-closing')
      // Commit the rest state before flipping to open so the transition plays
      // from the pre-open scale even if we were mid-close.
      void el.offsetWidth
      el.classList.add('is-open')
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) return // never opened — nothing to close or report
    wasOpen.current = false
    el.classList.remove('is-open')
    el.classList.add('is-closing')
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')
    ) || 150
    const t = setTimeout(() => {
      el.classList.remove('is-closing')
      window.openpen.send('picker-hidden')
    }, closeMs)
    // A re-open before the close finishes cancels the pending hide.
    return () => clearTimeout(t)
  }, [visible])

  useEffect(() => {
    const saved = loadSaved()
    const dark = saved.theme
      ? saved.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches
    applyDarkClass(dark)

    const offs = [
      window.openpen.on('color', setColor),
      window.openpen.on('theme', t => applyDarkClass(t === 'dark')),
      window.openpen.on('picker-visible', setVisible)
    ]
    window.openpen.send('picker-ready')
    return () => offs.forEach(off => off())
  }, [])

  const change = (c: string): void => {
    setColor(c)
    window.openpen.send('set-color', c)
  }

  // Save the current color to the front of the palette (dedup, capped).
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
      change(result.sRGBHex)
    } catch {
      // user cancelled
    }
  }

  return (
    // The panel grows from its top-right corner (toward the toolbar it belongs
    // to). It stays mounted; open/close is driven by the effect above toggling
    // .is-open / .is-closing — the transitions-dev menu-dropdown transition.
    <div
      ref={panelRef}
      data-origin="top-right"
      className="t-dropdown flex h-full flex-col gap-2 rounded-xl border bg-background p-3 text-foreground"
    >
      <div className="min-h-0 flex-1">
        <HexColorPicker color={color} onChange={change} />
      </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <HexColorInput
              color={color}
              onChange={change}
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
          <div className="shrink-0 space-y-1.5">
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
                  onClick={() => change(swatch)}
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
