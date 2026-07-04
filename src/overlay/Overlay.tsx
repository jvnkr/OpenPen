import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Engine, makeCursor, type Point } from './engine'
import EyeDropper, { type EyeDropData } from './EyeDropper'
import type { Bg, ToolState } from '@/types'
import './overlay.css'

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const fontPxFor = (size: number): number => clamp(size * 4, 14, 160)

interface EditState { x: number; y: number; done?: boolean }

export default function Overlay (): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const engRef = useRef<Engine | null>(null)

  const [tool, setTool] = useState<ToolState>({ tool: 'pen', color: '#ff3b30', size: 6 })
  const [mode, setMode] = useState(false)
  const [bg, setBg] = useState<Bg>('none')
  const [edit, setEdit] = useState<EditState | null>(null)
  const [eyedrop, setEyedrop] = useState<EyeDropData | null>(null)

  const latest = useRef({ tool, mode, bg, edit })
  latest.current = { tool, mode, bg, edit }

  const commitEditRef = useRef<(cancel?: boolean) => void>(() => {})
  commitEditRef.current = (cancel = false) => {
    const ed = latest.current.edit
    if (!ed || ed.done) return
    ed.done = true
    const val = taRef.current ? taRef.current.value.replace(/\s+$/, '') : ''
    if (!cancel && val) {
      const t = latest.current.tool
      engRef.current?.addText({
        kind: 'text', color: t.color, fontPx: fontPxFor(t.size),
        x: ed.x, y: ed.y, text: val
      })
    }
    setEdit(null)
  }

  useEffect(() => {
    const eng = new Engine(canvasRef.current!,
      h => window.openpen.send('history', h))
    engRef.current = eng

    const fit = (): void => eng.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)
    fit()
    window.addEventListener('resize', fit)

    const offs = [
      window.openpen.on('tool-state', s => setTool(s)),
      window.openpen.on('mode', m => {
        if (!m) commitEditRef.current(false)
        setMode(m)
      }),
      window.openpen.on('bg', b => setBg(b)),
      window.openpen.on('eyedrop', d => {
        commitEditRef.current(false)
        setEyedrop(d)
      }),
      window.openpen.on('cmd', c => {
        if (c === 'undo') eng.undo()
        else if (c === 'redo') eng.redo()
        else if (c === 'clear') { commitEditRef.current(true); eng.clearInk() }
        else if (c === 'escape') {
          // Arrives via a global shortcut, so it works even when no OpenPen
          // window has focus. Same priority as the local key handler:
          // cancel text editing first, then → mouse mode.
          if (latest.current.edit) commitEditRef.current(true)
          else window.openpen.send('set-mode', false)
        }
      })
    ]

    const onKey = (ev: KeyboardEvent): void => {
      if (latest.current.edit) return // textarea handles its own keys
      if (ev.key === 'Escape') {
        window.openpen.send('set-mode', false)
        return
      }
      if (ev.ctrlKey && !ev.altKey) {
        const k = ev.key.toLowerCase()
        if (k === 'z') { ev.preventDefault(); if (ev.shiftKey) eng.redo(); else eng.undo() }
        else if (k === 'y') { ev.preventDefault(); eng.redo() }
        return
      }
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return
      if (ev.key === '[') window.openpen.send('adjust-size', -2)
      else if (ev.key === ']') window.openpen.send('adjust-size', 2)
      else if (ev.key === 'Delete') eng.clearInk()
    }
    window.addEventListener('keydown', onKey)

    const onCtx = (ev: MouseEvent): void => ev.preventDefault()
    window.addEventListener('contextmenu', onCtx)

    window.openpen.send('overlay-ready')
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onCtx)
      offs.forEach(off => off())
    }
  }, [])

  // The overlay window is non-focusable so drawing never steals focus; the
  // text editor is the exception. Ask main to grant window focus while an
  // edit is open and release it (back to the previous app) when it closes.
  const prevEditing = useRef(false)
  useEffect(() => {
    const editing = edit !== null
    if (editing === prevEditing.current) return
    prevEditing.current = editing
    window.openpen.send('text-editing', editing)
    if (editing) taRef.current?.focus()
  }, [edit])

  // The pen/highlighter cursor is a translucent circle drawn as the native OS
  // cursor (makeCursor). It stays crisp and never blinks, but Windows only
  // repaints the OS cursor on real input — so resizing with the wheel while the
  // mouse holds still would leave a stale ring. After each cursor change in draw
  // mode we ask main to nudge us with a synthetic move, which forces the repaint.
  // Tool cursors are all native or small fixed glyphs; the pen/highlighter size
  // ring is drawn in-canvas by the engine (custom cursor bitmaps flicker on this
  // transparent always-on-top window — Windows flashes the default arrow during
  // movement, regardless of the CSS cursor value).
  const cursor = useMemo(
    () => (mode ? makeCursor(tool.tool) : 'default'),
    [mode, tool.tool],
  )

  useEffect(() => {
    if (canvasRef.current) canvasRef.current.style.cursor = cursor
    document.body.style.cursor = cursor
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.openpen.send('overlay-cursor-ready'))
    })
    return () => { document.body.style.cursor = '' }
  }, [cursor, mode])

  // Keep the engine's size ring in sync with the active tool. The eyedropper
  // freezes the screen over the canvas, so the ring hides while it's up.
  useEffect(() => {
    const eng = engRef.current
    if (!eng) return
    if (mode && !eyedrop && (tool.tool === 'pen' || tool.tool === 'highlighter')) {
      eng.setBrushPreview(tool.tool, tool.color, tool.size)
    } else {
      eng.setBrushPreview(null)
    }
    if (mode && !eyedrop && tool.tool === 'eraser') {
      eng.setEraserHover(true, tool.size)
    } else {
      eng.setEraserHover(false)
    }
    eng.setFadeMode(Boolean(tool.fade), tool.fadeMs ?? 2000)
  }, [mode, tool, eyedrop])

  const onDown = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    if (ev.button !== 0) return
    // Drawing out here can't reach the toolbar's outside-press listener, so tell
    // it to close any open menu (brush/fade/color).
    window.openpen.send('draw-start')
    if (latest.current.edit) { commitEditRef.current(false); return }
    if (tool.tool === 'text') {
      setEdit({ x: ev.clientX, y: ev.clientY })
      return
    }
    ev.currentTarget.setPointerCapture(ev.pointerId)
    if (tool.tool === 'drag') {
      engRef.current?.beginDrag(ev.pointerId, ev.clientX, ev.clientY)
      return
    }
    // Real pressure only from pen/tablet devices; mouse/touch fall back to the
    // velocity-simulated taper. Each pointer id draws its own stroke (multi-touch).
    engRef.current?.begin(
      ev.pointerId, tool.tool, tool.color, tool.size,
      ev.clientX, ev.clientY, ev.shiftKey, ev.pressure, ev.pointerType === 'pen',
    )
  }

  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const eng = engRef.current
    if (!eng) return
    eng.setPointer(ev.clientX, ev.clientY)
    if (!eng.hasGesture(ev.pointerId)) return
    const native = ev.nativeEvent
    const events = typeof native.getCoalescedEvents === 'function'
      ? native.getCoalescedEvents()
      : [native]
    const pts: Point[] = events.length
      ? events.map(e => ({ x: e.clientX, y: e.clientY, pressure: e.pressure }))
      : [{ x: ev.clientX, y: ev.clientY, pressure: ev.pressure }]
    eng.move(ev.pointerId, pts, ev.shiftKey)
  }

  const onUp = (ev: React.PointerEvent<HTMLCanvasElement>): void =>
    engRef.current?.end(ev.pointerId)

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>): void => {
    // Feed the pointer position too: a stationary wheel-resize must draw the
    // ring centred under the cursor even if the mouse never moved.
    engRef.current?.setPointer(ev.clientX, ev.clientY)
    window.openpen.send('adjust-size', ev.deltaY > 0 ? -1 : 1)
  }

  const bgColor = bg === 'white' ? '#ffffff' : bg === 'black' ? '#15161a' : 'transparent'

  return (
    <div className={'root' + (mode ? ' drawing' : '')} style={{ background: bgColor }}>
      <canvas
        ref={canvasRef}
        style={{ cursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerEnter={ev => engRef.current?.setPointer(ev.clientX, ev.clientY)}
        onPointerLeave={() => engRef.current?.setPointer(null)}
        onWheel={onWheel}
      />
      {edit && (
        <textarea
          ref={taRef}
          className="text-editor"
          autoFocus
          spellCheck={false}
          rows={1}
          style={{
            left: edit.x - 3,
            top: edit.y - 3,
            color: tool.color,
            caretColor: tool.color,
            fontSize: fontPxFor(tool.size),
            lineHeight: 1.25
          }}
          onKeyDown={ev => {
            ev.stopPropagation()
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitEditRef.current(false) }
            else if (ev.key === 'Escape') commitEditRef.current(true)
          }}
          onInput={ev => {
            const ta = ev.currentTarget
            const lines = ta.value.split('\n')
            const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
            ta.style.width = `${Math.max(4, longest + 2)}ch`
            ta.style.height = 'auto'
            ta.style.height = `${ta.scrollHeight}px`
          }}
          onBlur={() => commitEditRef.current(false)}
        />
      )}
      {eyedrop && (
        <EyeDropper
          data={eyedrop}
          onPick={hex => window.openpen.send('eyedrop-pick', hex)}
          onCancel={() => window.openpen.send('eyedrop-cancel')}
        />
      )}
    </div>
  )
}
