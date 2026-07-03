import type { Tool } from './tools'

// The drawing tools live in ./tools (the single source of truth for how each is
// triggered); re-exported here so existing `@/types` importers keep working.
export type { Tool }

export type Bg = 'none' | 'white' | 'black'

export interface ToolState {
  tool: Tool
  color: string
  size: number
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
