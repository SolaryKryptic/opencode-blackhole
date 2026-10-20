/**
 * The memory ledger.
 *
 * One JSONL file per session holds everything blackhole remembers:
 * observations (facts extracted from the conversation), reflections (durable
 * insights distilled from observations) and the state cursor that says how far
 * the observer has read.
 *
 * Append-only while a session is live — dropping an observation writes a
 * `dropped` marker rather than rewriting history, so `/blackhole-memory full`
 * can still show it. The file is compacted when it grows past a size limit:
 * the live observations, the reflections and the cursor are rewritten, and the
 * dropped markers are folded into a counter.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface Observation {
  id: string
  ts: string
  text: string
  /** Rough token cost, used for the pool budget. */
  tokens: number
}

export interface Reflection {
  id: string
  ts: string
  text: string
  /** Observation ids that support this reflection. */
  evidence: string[]
}

export type LedgerEntry =
  | ({ kind: "observation" } & Observation)
  | ({ kind: "reflection" } & Reflection)
  | { kind: "dropped"; id: string; ts: string }
  | { kind: "cursor"; observedThrough: number; ts: string; dropped?: number }

export interface LedgerState {
  observations: Observation[]
  reflections: Reflection[]
  dropped: Observation[]
  /** How many observations have been dropped over the session's life. */
  droppedCount: number
  /** The transcript index the observer has read up to. */
  observedThrough: number
}

export interface MemoryLedgerOptions {
  /** How many parsed ledgers stay in memory at once. */
  maxCachedSessions?: number
  /** Compact a ledger file when it grows past this size. */
  maxFileBytes?: number
}

/**
 * Where a session's ledger lives.
 *
 * A plain string keeps one directory; a function resolves a directory per
 * session, which is what the global per-project layout needs.
 */
export type LedgerDirResolver = string | ((sessionID: string) => string)

const emptyState = (): LedgerState => ({
  observations: [],
  reflections: [],
  dropped: [],
  droppedCount: 0,
  observedThrough: 0,
})

export class MemoryLedger {
  private readonly dirFor: (sessionID: string) => string
  private readonly maxCachedSessions: number
  private readonly maxFileBytes: number
  /** Insertion order is the LRU order: the first key is the oldest. */
  private readonly cache = new Map<string, LedgerState>()

  constructor(dir: LedgerDirResolver, options: MemoryLedgerOptions = {}) {
    this.dirFor = typeof dir === "function" ? dir : () => dir
    this.maxCachedSessions = Math.max(1, options.maxCachedSessions ?? 8)
    this.maxFileBytes = Math.max(4_096, options.maxFileBytes ?? 65_536)
  }

  private path(sessionID: string) {
    return join(this.dirFor(sessionID), `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`)
  }

  private touch(sessionID: string, state: LedgerState) {
    this.cache.delete(sessionID)
    this.cache.set(sessionID, state)
    while (this.cache.size > this.maxCachedSessions) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  read(sessionID: string): LedgerState {
    const cached = this.cache.get(sessionID)
    if (cached) {
      this.touch(sessionID, cached)
      return cached
    }

    const state = emptyState()
    const path = this.path(sessionID)
    try {
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue
          let entry: LedgerEntry
          try {
            entry = JSON.parse(line)
          } catch {
            continue
          }
          this.apply(state, entry)
        }
      }
    } catch {
      // An unreadable ledger is an empty ledger.
    }

    this.touch(sessionID, state)
    return state
  }

  /** Apply one entry to a state, in order. */
  private apply(state: LedgerState, entry: LedgerEntry) {
    if (entry.kind === "observation") state.observations.push(entry)
    else if (entry.kind === "reflection") state.reflections.push(entry)
    else if (entry.kind === "dropped") {
      const index = state.observations.findIndex((o) => o.id === entry.id)
      if (index >= 0) state.dropped.push(state.observations.splice(index, 1)[0])
      state.droppedCount++
    } else if (entry.kind === "cursor") {
      state.observedThrough = entry.observedThrough
      if (typeof entry.dropped === "number") state.droppedCount = Math.max(state.droppedCount, entry.dropped)
    }
  }

  append(sessionID: string, entries: LedgerEntry[]) {
    if (entries.length === 0) return
    // Read before writing: `read` populates the cache, so the state below is
    // the pre-append state and the entries are applied exactly once.
    const state = this.read(sessionID)
    mkdirSync(this.dirFor(sessionID), { recursive: true })
    appendFileSync(this.path(sessionID), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    for (const entry of entries) {
      this.apply(state, entry)
    }
    this.maybeCompact(sessionID)
  }

  /**
   * Rewrite a ledger file with only what is still live.
   *
   * The dropped markers are the only thing that accumulates without bound, so
   * they are folded into a counter on the cursor entry.
   */
  compact(sessionID: string): boolean {
    const state = this.read(sessionID)
    const path = this.path(sessionID)
    if (!existsSync(path)) return false

    const lines: string[] = []
    for (const observation of state.observations) {
      lines.push(JSON.stringify({ kind: "observation", ...observation } as LedgerEntry))
    }
    for (const reflection of state.reflections) {
      lines.push(JSON.stringify({ kind: "reflection", ...reflection } as LedgerEntry))
    }
    lines.push(
      JSON.stringify({
        kind: "cursor",
        observedThrough: state.observedThrough,
        ts: new Date().toISOString(),
        dropped: state.droppedCount,
      } as LedgerEntry),
    )

    try {
      writeFileSync(path, lines.join("\n") + "\n")
    } catch {
      return false
    }
    return true
  }

  /** Compact the ledger when its file has grown past the size limit. */
  private maybeCompact(sessionID: string) {
    try {
      const stats = statSync(this.path(sessionID))
      if (stats.size <= this.maxFileBytes) return
    } catch {
      return
    }
    this.compact(sessionID)
  }

  /**
   * Delete ledgers that have not been modified for `olderThanMs`.
   *
   * Ledgers are small (the live memory of a session), so the window is
   * generous — they are the thing worth keeping.
   */
  sweep(olderThanMs: number, now = Date.now()): number {
    return MemoryLedger.sweepDir(this.dirFor(""), olderThanMs, now)
  }

  /** Sweep one directory of ledger files. */
  static sweepDir(dir: string, olderThanMs: number, now = Date.now()): number {
    let removed = 0
    let files: string[] = []
    try {
      files = readdirSync(dir)
    } catch {
      return 0
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const path = join(dir, file)
      try {
        const stats = statSync(path)
        if (now - stats.mtimeMs < olderThanMs) continue
        rmSync(path, { force: true })
        removed++
      } catch {
        // A file we cannot stat or remove is left alone.
      }
    }
    return removed
  }
}
