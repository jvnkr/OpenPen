import fs from 'node:fs'
import path from 'node:path'

// Ink persistence for the main process. The renderer's engine owns the op
// shapes; here they're opaque JSON, so nothing in this file changes when a new
// tool is added. See docs/adr for the "why files, not SQLite" decision — the
// access pattern is whole-document load/save, never query.

const CURRENT_VERSION = 1

// The serialized ink document as it crosses the renderer↔main seam and lands on
// disk. `ops` is opaque to main; only the renderer knows what an op is. Mirrors
// SerializedDoc in src/overlay/engine.ts (renderer compiles separately).
export interface SerializedDoc {
  version: number
  ops: unknown[]
  idSeq: number
}

// A persisted board: one ink document plus the metadata the app indexes it by.
// `displayKey` ties an auto-resumed board to the monitor it belongs to; `name`
// and `updatedAt` are carried now for the future board library / command
// palette, so adding those features needs no format change.
export interface StoredBoard {
  version: number
  id: string
  displayKey: string | null
  name: string
  updatedAt: number
  doc: SerializedDoc
}

export type BoardMeta = Omit<StoredBoard, 'doc'>

// The storage seam. Everything above it (board resolution, autosave) speaks only
// these four methods, so swapping the JSON files for SQLite later is a new
// implementation of this interface plus a one-time migration — no caller
// changes. Kept synchronous: the data is small, better-sqlite3 / node:sqlite are
// both sync, and it matches the existing sync settings I/O.
export interface BoardStore {
  list (): BoardMeta[]
  load (id: string): StoredBoard | null
  save (board: StoredBoard): void
  delete (id: string): void
}

// Write then atomically replace, so a crash mid-write leaves the previous file
// intact rather than a truncated one. rename-over-existing is atomic on NTFS and
// POSIX alike.
function writeAtomic (file: string, data: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function toMeta (b: StoredBoard): BoardMeta {
  return { version: b.version, id: b.id, displayKey: b.displayKey, name: b.name, updatedAt: b.updatedAt }
}

function normalizeDoc (v: unknown): SerializedDoc | null {
  if (typeof v !== 'object' || v === null) return null
  const d = v as { version?: unknown; ops?: unknown; idSeq?: unknown }
  if (!Array.isArray(d.ops) || typeof d.idSeq !== 'number') return null
  return { version: typeof d.version === 'number' ? d.version : CURRENT_VERSION, ops: d.ops, idSeq: d.idSeq }
}

// Tolerant parse of a board file: a corrupt or partially-written file yields
// null (treated as "no board") rather than throwing.
function normalizeBoard (v: unknown): StoredBoard | null {
  if (typeof v !== 'object' || v === null) return null
  const b = v as { version?: unknown; id?: unknown; displayKey?: unknown; name?: unknown; updatedAt?: unknown; doc?: unknown }
  if (typeof b.id !== 'string') return null
  const doc = normalizeDoc(b.doc)
  if (!doc) return null
  return {
    version: typeof b.version === 'number' ? b.version : CURRENT_VERSION,
    id: b.id,
    displayKey: typeof b.displayKey === 'string' ? b.displayKey : null,
    name: typeof b.name === 'string' ? b.name : 'Board',
    updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : Date.now(),
    doc
  }
}

function normalizeMeta (v: unknown): BoardMeta | null {
  if (typeof v !== 'object' || v === null) return null
  const m = v as { version?: unknown; id?: unknown; displayKey?: unknown; name?: unknown; updatedAt?: unknown }
  if (typeof m.id !== 'string') return null
  return {
    version: typeof m.version === 'number' ? m.version : CURRENT_VERSION,
    id: m.id,
    displayKey: typeof m.displayKey === 'string' ? m.displayKey : null,
    name: typeof m.name === 'string' ? m.name : 'Board',
    updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0
  }
}

// JSON-file store: one <id>.json per board plus an index.json of their metadata,
// all under a single directory. The index means list() and the display→board
// lookup don't have to open every board file.
export class JsonBoardStore implements BoardStore {
  private readonly dir: string
  private readonly indexFile: string

  constructor (dir: string) {
    this.dir = dir
    this.indexFile = path.join(dir, 'index.json')
  }

  private ensureDir (): void {
    fs.mkdirSync(this.dir, { recursive: true })
  }

  // ids are uuids (no separators), but basename() guards against a malformed id
  // escaping the boards directory anyway.
  private boardFile (id: string): string {
    return path.join(this.dir, `${path.basename(id)}.json`)
  }

  list (): BoardMeta[] {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.map(normalizeMeta).filter((m): m is BoardMeta => m !== null)
    } catch {
      return []
    }
  }

  load (id: string): StoredBoard | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.boardFile(id), 'utf8'))
      return normalizeBoard(raw)
    } catch {
      return null
    }
  }

  save (board: StoredBoard): void {
    this.ensureDir()
    writeAtomic(this.boardFile(board.id), JSON.stringify(board))
    this.writeIndex(this.list().filter(m => m.id !== board.id).concat(toMeta(board)))
  }

  delete (id: string): void {
    try {
      fs.rmSync(this.boardFile(id), { force: true })
    } catch (err) {
      console.error('failed to delete board file', err)
    }
    const next = this.list().filter(m => m.id !== id)
    this.writeIndex(next)
  }

  private writeIndex (metas: BoardMeta[]): void {
    this.ensureDir()
    writeAtomic(this.indexFile, JSON.stringify(metas))
  }
}
