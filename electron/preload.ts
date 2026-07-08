import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const SEND = new Set([
  'overlay-ready', 'toolbar-ready', 'input-ready', 'tool-state', 'set-mode', 'set-highlight',
  'cmd', 'history', 'pick-tool', 'adjust-size', 'set-bg', 'screenshot', 'export',
  'draw-input',
  'toggle-hide', 'toggle-toolbar', 'theme', 'quit',
  'draw-start', 'toolbar-drag-start', 'toolbar-drag-move',
  'toolbar-drag-end', 'toolbar-fit-height', 'toolbar-interactive',
  'overlay-cursor-ready', 'text-editing',
  'open-settings', 'settings-ready', 'set-theme', 'set-protect-ui',
  'set-hotkey', 'reset-hotkeys', 'hotkey-capture',
  'pick-screenshot-dir', 'reset-screenshot-dir', 'set-screenshot-dest',
  'open-screenshot-dir', 'set-restore-ink', 'save-board', 'export-result',
  'check-for-updates', 'install-update',
  'eyedrop-start', 'eyedrop-pick', 'eyedrop-cancel'
])
const ON = new Set([
  'tool-state', 'mode', 'bg', 'cmd', 'history',
  'highlight', 'highlight-pointer', 'highlight-press', 'draw-input',
  'load-board', 'export-board',
  'pick-tool', 'adjust-size', 'hidden',
  'theme', 'close-menus', 'screenshotting', 'screenshot-saved',
  'tooltip-side', 'set-theme', 'settings-state', 'hotkeys', 'update-badge', 'eyedrop'
])

contextBridge.exposeInMainWorld('openpen', {
  send (channel: string, data?: unknown): void {
    if (SEND.has(channel)) ipcRenderer.send(channel, data)
  },
  on (channel: string, fn: (data: unknown) => void): () => void {
    if (!ON.has(channel)) return () => {}
    const listener = (_e: IpcRendererEvent, data: unknown): void => fn(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
