// Regenerate the app icons from build/icon.svg and build/icon-dev.svg:
//   build/icon.png      — packaged / production (electron-builder)
//   build/icon.ico
//   build/icon-dev.png  — unpackaged dev runs only (pnpm dev / pnpm start)
//   build/icon-dev.ico
//
// Run with: pnpm icons
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')

async function writeIcon (name, svgPath) {
  const svg = readFileSync(svgPath)
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng()
  writeFileSync(join(buildDir, `${name}.png`), png)
  const ico = await pngToIco(png)
  writeFileSync(join(buildDir, `${name}.ico`), ico)
  console.log(`${name}.png ${png.length} bytes, ${name}.ico ${ico.length} bytes`)
}

await writeIcon('icon', join(buildDir, 'icon.svg'))
await writeIcon('icon-dev', join(buildDir, 'icon-dev.svg'))
