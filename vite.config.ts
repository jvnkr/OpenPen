import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// CSP is injected only into production builds — Vite's dev-mode HMR needs
// inline scripts, which a strict CSP would block.
const cspPlugin: Plugin = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml (html: string) {
    return html.replace(
      '<meta charset="utf-8" />',
      '<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:" />'
    )
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cspPlugin],
  base: './',
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, 'overlay.html'),
        toolbar: resolve(__dirname, 'toolbar.html'),
        settings: resolve(__dirname, 'settings.html'),
        input: resolve(__dirname, 'input.html')
      }
    }
  },
  server: { port: 5173, strictPort: true }
})
