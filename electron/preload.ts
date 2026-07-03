import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const SEND = new Set([
  'overlay-ready', 'toolbar-ready', 'picker-ready', 'tool-state', 'set-mode',
  'cmd', 'history', 'pick-tool', 'adjust-size', 'set-bg', 'screenshot',
  'toggle-hide', 'toggle-toolbar', 'toggle-picker', 'set-color', 'theme', 'quit',
  'toolbar-drag-start', 'toolbar-drag-move',
  'toolbar-drag-end', 'toolbar-fit-height', 'toolbar-interactive',
  'overlay-cursor-ready', 'text-editing',
  'open-settings', 'settings-ready', 'set-theme', 'set-protect-ui', 'picker-hidden',
  'check-for-updates', 'install-update',
  'eyedrop-start', 'eyedrop-pick', 'eyedrop-cancel'
])
const ON = new Set([
  'tool-state', 'mode', 'bg', 'cmd', 'history',
  'pick-tool', 'adjust-size', 'hidden',
  'color', 'theme', 'picker-open', 'set-color', 'screenshotting',
  'tooltip-side', 'set-theme', 'settings-state', 'picker-visible', 'eyedrop'
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
