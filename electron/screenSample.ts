// Live screen-pixel sampling via Win32 GDI (BitBlt of a tiny region). Used by
// the realtime eyedropper so we never freeze a full-display capture.

import koffi from 'koffi'

export interface ScreenSample {
  // Row-major RGBA, top-left origin, `width * height * 4` bytes.
  rgba: Buffer
  width: number
  height: number
  // Colour of the centre pixel as #rrggbb.
  hex: string
}

interface Gdi {
  GetDC: (hwnd: null) => unknown
  ReleaseDC: (hwnd: null, hdc: unknown) => number
  CreateCompatibleDC: (hdc: unknown) => unknown
  CreateCompatibleBitmap: (hdc: unknown, w: number, h: number) => unknown
  SelectObject: (hdc: unknown, obj: unknown) => unknown
  BitBlt: (
    dst: unknown, dx: number, dy: number, w: number, h: number,
    src: unknown, sx: number, sy: number, rop: number
  ) => number
  GetDIBits: (
    hdc: unknown, hbmp: unknown, start: number, lines: number,
    bits: Buffer, bmi: Buffer, usage: number
  ) => number
  DeleteObject: (obj: unknown) => number
  DeleteDC: (hdc: unknown) => number
}

const SRCCOPY = 0x00CC0020
const BI_RGB = 0
const DIB_RGB_COLORS = 0

let gdi: Gdi | null = null
let loadError: string | null = null

function loadGdi (): Gdi | null {
  if (gdi) return gdi
  if (loadError) return null
  if (process.platform !== 'win32') {
    loadError = 'Screen sampling is only available on Windows.'
    return null
  }
  try {
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')
    gdi = {
      GetDC: user32.func('void *GetDC(void *hwnd)'),
      ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
      CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
      CreateCompatibleBitmap: gdi32.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)'),
      SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
      BitBlt: gdi32.func('int BitBlt(void *dst, int dx, int dy, int w, int h, void *src, int sx, int sy, uint32_t rop)'),
      GetDIBits: gdi32.func('int GetDIBits(void *hdc, void *hbmp, uint32_t start, uint32_t lines, void *bits, void *bmi, uint32_t usage)'),
      DeleteObject: gdi32.func('int DeleteObject(void *obj)'),
      DeleteDC: gdi32.func('int DeleteDC(void *hdc)')
    }
    return gdi
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load GDI'
    console.error('screen sample: GDI load failed', err)
    return null
  }
}

function toHex (n: number): string {
  return n.toString(16).padStart(2, '0')
}

// Capture a square of `size` physical pixels centred on (cx, cy) in screen
// physical coordinates. Returns null when GDI is unavailable or the blit fails.
export function sampleScreenRegion (cx: number, cy: number, size: number): ScreenSample | null {
  const api = loadGdi()
  if (!api) return null
  const w = Math.max(1, Math.floor(size))
  const h = w
  const sx = Math.round(cx - (w - 1) / 2)
  const sy = Math.round(cy - (h - 1) / 2)

  // BITMAPINFOHEADER (40 bytes) + optional colour table we don't use.
  const bmi = Buffer.alloc(40)
  bmi.writeUInt32LE(40, 0) // biSize
  bmi.writeInt32LE(w, 4) // biWidth
  bmi.writeInt32LE(-h, 8) // biHeight (top-down)
  bmi.writeUInt16LE(1, 12) // biPlanes
  bmi.writeUInt16LE(32, 14) // biBitCount
  bmi.writeUInt32LE(BI_RGB, 16)

  // 32bpp BGRA, tightly packed (stride = w * 4).
  const bgra = Buffer.alloc(w * h * 4)

  const screenDc = api.GetDC(null)
  if (!screenDc) return null
  const memDc = api.CreateCompatibleDC(screenDc)
  const bmp = api.CreateCompatibleBitmap(screenDc, w, h)
  if (!memDc || !bmp) {
    if (bmp) api.DeleteObject(bmp)
    if (memDc) api.DeleteDC(memDc)
    api.ReleaseDC(null, screenDc)
    return null
  }
  const prev = api.SelectObject(memDc, bmp)
  try {
    if (!api.BitBlt(memDc, 0, 0, w, h, screenDc, sx, sy, SRCCOPY)) return null
    if (!api.GetDIBits(memDc, bmp, 0, h, bgra, bmi, DIB_RGB_COLORS)) return null
  } finally {
    api.SelectObject(memDc, prev)
    api.DeleteObject(bmp)
    api.DeleteDC(memDc)
    api.ReleaseDC(null, screenDc)
  }

  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    rgba[o] = bgra[o + 2]! // R
    rgba[o + 1] = bgra[o + 1]! // G
    rgba[o + 2] = bgra[o]! // B
    rgba[o + 3] = 255
  }
  const mid = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4
  const hex = `#${toHex(rgba[mid]!)}${toHex(rgba[mid + 1]!)}${toHex(rgba[mid + 2]!)}`
  return { rgba, width: w, height: h, hex }
}

export function screenSampleAvailable (): boolean {
  return loadGdi() !== null
}
