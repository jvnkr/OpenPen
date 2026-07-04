import type { Tool } from './tools'

// The drawing tools live in ./tools (the single source of truth for how each is
// triggered); re-exported here so existing `@/types` importers keep working.
export type { Tool }

export type Bg = 'none' | 'white' | 'black'

export interface ToolState {
  tool: Tool
  color: string
  size: number
  // When true, freehand strokes and shapes fade out and vanish shortly after
  // you draw them (temporary annotations that never need clearing).
  fade?: boolean
  // How long fading ink lives, in milliseconds, before it's fully gone.
  fadeMs?: number
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}

// The renderer↔main message API is fully typed by its channel contract; see
// ./ipc for the channel→payload maps.
import type { OpenPenApi } from './ipc'
export type { OpenPenApi }

declare global {
  interface Window { openpen: OpenPenApi }
}
