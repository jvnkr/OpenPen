// Single source of truth for the drawing tools: what exists and how each is
// triggered. The toolbar (icons + tooltips) and the overlay's keyboard handler
// both derive from this list, so adding a tool is one entry here, its icon in
// the toolbar's ICON map, and its drawing behaviour in the engine.
//
// The main process registers the matching Ctrl+Shift+<accel> global shortcuts
// from its own small map (electron/main.ts). That mirror is intentional: main
// and the renderer are compiled separately and can't share a module, so the
// tool *names* and accelerator *numbers* are the shared vocabulary across the
// process seam — keep the two in step.

export type Tool =
  | 'pen' | 'highlighter' | 'eraser' | 'text'
  | 'line' | 'arrow' | 'rect' | 'ellipse' | 'drag'

export interface ToolDef {
  id: Tool
  name: string
  /** Single-key shortcut while drawing (lower-case). */
  key: string
  /** Global accelerator digit: Ctrl+Shift+<accel>. */
  accel: number
}

// Array order is the toolbar's display order, and `accel` matches it: the
// Ctrl+Shift+<n> number lines up with each tool's position in the column, so
// Move/drag (the 2nd button) is Ctrl+Shift+2. Keep the two in step when adding
// a tool, and mirror the numbers in electron/main.ts (TOOL_SHORTCUTS).
export const TOOLS: ToolDef[] = [
  { id: 'pen', name: 'Pen', key: 'p', accel: 1 },
  { id: 'drag', name: 'Drag / move', key: 'd', accel: 2 },
  { id: 'highlighter', name: 'Highlighter', key: 'h', accel: 3 },
  { id: 'eraser', name: 'Eraser', key: 'e', accel: 4 },
  { id: 'text', name: 'Text', key: 't', accel: 5 },
  { id: 'line', name: 'Line', key: 'l', accel: 6 },
  { id: 'arrow', name: 'Arrow', key: 'a', accel: 7 },
  { id: 'rect', name: 'Rectangle', key: 'r', accel: 8 },
  { id: 'ellipse', name: 'Ellipse', key: 'o', accel: 9 }
]

// Draw-mode single-key shortcut → tool id.
export const TOOL_BY_KEY: Record<string, Tool> =
  Object.fromEntries(TOOLS.map(t => [t.key, t.id]))
