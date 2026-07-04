// Single source of truth for the drawing tools: what exists and how each is
// triggered. The toolbar (icons + tooltips) derives from this list, so adding a
// tool is one entry here, its icon in the toolbar's ICON map, and its drawing
// behaviour in the engine.
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
  /** Global accelerator digit: Ctrl+Shift+<accel>. */
  accel: number
}

// Array order is the toolbar's display order. The tools take the clean 1..9 run
// (pen on Ctrl+Shift+1); mouse mode is Ctrl+Shift+0 ("back to nothing"). Keep
// this in step and mirror the numbers in electron/main.ts (TOOL_SHORTCUTS).
export const TOOLS: ToolDef[] = [
  { id: 'pen', name: 'Pen', accel: 1 },
  { id: 'drag', name: 'Drag / move', accel: 2 },
  { id: 'highlighter', name: 'Highlighter', accel: 3 },
  { id: 'eraser', name: 'Eraser', accel: 4 },
  { id: 'text', name: 'Text', accel: 5 },
  { id: 'line', name: 'Line', accel: 6 },
  { id: 'arrow', name: 'Arrow', accel: 7 },
  { id: 'rect', name: 'Rectangle', accel: 8 },
  { id: 'ellipse', name: 'Ellipse', accel: 9 }
]
