// Regenerate the app icons from build/icon.svg:
//   build/icon.png  — 256px master (used by docs / non-Windows targets)
//   build/icon.ico  — multi-size Windows icon (electron-builder picks this up)
//
// Run with: pnpm icons
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'icon.svg'))

// Rasterize the SVG at 256px. loadSystemFonts (default) lets the "Segoe UI"
// wordmark resolve from the OS.
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng()
writeFileSync(join(root, 'build', 'icon.png'), png)

// png-to-ico resizes the master into the standard Windows icon sizes.
const ico = await pngToIco(png)
writeFileSync(join(root, 'build', 'icon.ico'), ico)

console.log(`icon.png ${png.length} bytes, icon.ico ${ico.length} bytes`)
