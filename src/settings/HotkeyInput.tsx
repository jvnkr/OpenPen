import React, { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { eventToAccelerator, isHotkeyBound, parseHotkeyParts } from '@/hotkeys'

interface HotkeyInputProps {
  value: string
  defaultValue: string
  recording: boolean
  onStart: () => void
  onCancel: () => void
  onChange: (accelerator: string) => void
  onUnbind: () => void
}

export function HotkeyInput ({
  value,
  defaultValue,
  recording,
  onStart,
  onCancel,
  onChange,
  onUnbind
}: HotkeyInputProps): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      onCancel()
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onUnbind()
      return
    }
    const accel = eventToAccelerator(e)
    if (accel) onChange(accel)
  }, [onCancel, onChange, onUnbind])

  useEffect(() => {
    if (!recording) return
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, handleKeyDown])

  useEffect(() => {
    if (recording) btnRef.current?.focus()
  }, [recording])

  const isCustom = value !== defaultValue

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => { if (!recording) onStart() }}
      className={cn(
        'inline-flex h-10 w-fit shrink-0 items-center justify-center rounded-md border px-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        recording
          ? 'border-primary bg-accent text-accent-foreground'
          : isCustom
            ? 'border-primary/40 bg-muted/50 text-foreground hover:bg-accent/50'
            : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      {recording
        ? (
          <KbdGroup className="gap-1">
            <Kbd className="h-6 min-w-6 px-1.5 text-xs opacity-60">Ctrl</Kbd>
            <Kbd className="h-6 min-w-6 px-1.5 text-xs opacity-60">Shift</Kbd>
            <Kbd className="h-6 min-w-6 border border-dashed border-current/40 bg-transparent px-1.5 text-xs opacity-80">…</Kbd>
          </KbdGroup>
          )
        : !isHotkeyBound(value)
          ? <span className="px-1 text-xs text-muted-foreground">None</span>
          : (
            <KbdGroup className="gap-1">
              {parseHotkeyParts(value).map(k => (
                <Kbd key={k} className="h-6 min-w-6 px-1.5 text-xs">{k}</Kbd>
              ))}
            </KbdGroup>
            )}
    </button>
  )
}
