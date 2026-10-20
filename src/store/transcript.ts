/**
 * Per-session transcript store.
 *
 * OpenCode's plugin API exposes the *compacted* view of a session, so the
 * messages that a compaction dropped are not reachable from a plugin. To give
 * recall a real history — and to keep the `#N` references in a summary
 * session-global rather than request-relative — the plugin records every
 * model request it sees into its own append-only store.
 *
 * The store lives next to the project (`.opencode/blackhole/transcripts`) and
 * is a JSONL file per session: one line per message, in first-seen order.
 *
 * Two things keep it from growing without bound:
 *   - the parsed transcripts are cached in memory with an LRU cap, so a long
 *     lived server does not hold every session it has ever seen;
 *   - `sweep()` deletes transcripts that have not been touched for a while.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Message } from "../vcc/pi-types"

export interface StoredMessage {
  /** OpenCode's message id. */
  id: string
  /** The session-global index, 1-based, matching the `#N` refs in summaries. */
  index: number
  /** vcc-shaped message content. */
  message: Message
  /** Rough token cost, computed once when the message is captured. */
  tokens?: number
}

/** A tool call, kept so a later tool result can be paired with its call. */
export interface ToolCallInfo {
  name: string
  input: Record<string, unknown>
}

export interface SessionTranscript {
  messages: StoredMessage[]
  indexById: Map<string, number>
  /** Tool calls seen in this session, by call id. */
  callsById: Map<string, ToolCallInfo>
  /**
   * Ids of messages we deliberately do not store (the compaction checkpoint).
   * They come back with every request, so remembering them keeps us from
   * re-scanning a large summary each turn.
   */
  ignoredIds: Set<string>
  /** Bumped on every append, so callers can cache derived views. */
  version: number
}

export interface TranscriptStoreOptions {
  /** How many parsed sessions stay in memory at once. */
  maxCachedSessions?: number
  /** Hard cap for the content of a single stored message. */
  maxMessageChars?: number
}

/**
 * Where a session's transcript lives.
 *
 * A plain string keeps one directory; a function resolves a directory per
 * session, which is what the global per-project layout needs.
 */
export type DirResolver = string | ((sessionID: string) => string)

const CHARS_PER_TOKEN = 4

/** Collect the tool calls of an assistant message, for later result pairing. */
export const collectToolCalls = (message: Message): Array<ToolCallInfo & { id: string }> => {
  if (!Array.isArray(message.content)) return []
  const calls: Array<ToolCallInfo & { id: string }> = []
  for (const part of message.content) {
    if (part.type !== "toolCall") continue
    const call = part as { id?: string; name?: string; arguments?: Record<string, unknown> }
    if (!call.id) continue
    calls.push({ id: call.id, name: call.name ?? "tool", input: call.arguments ?? {} })
  }
  return calls
}

export class TranscriptStore {
  private readonly dirFor: (sessionID: string) => string
  private readonly maxCachedSessions: number
  private readonly maxMessageChars: number
  /** Insertion order is the LRU order: the first key is the oldest. */
  private readonly cache = new Map<string, SessionTranscript>()

  constructor(dir: DirResolver, options: TranscriptStoreOptions = {}) {
    this.dirFor = typeof dir === "function" ? dir : () => dir
    this.maxCachedSessions = Math.max(1, options.maxCachedSessions ?? 8)
    this.maxMessageChars = Math.max(4_000, options.maxMessageChars ?? 262_144)
  }

  private path(sessionID: string) {
    return join(this.dirFor(sessionID), `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`)
  }

  /** Mark a session as recently used and evict the oldest when over the cap. */
  private touch(sessionID: string, transcript: SessionTranscript) {
    this.cache.delete(sessionID)
    this.cache.set(sessionID, transcript)
    while (this.cache.size > this.maxCachedSessions) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /**
   * Record the messages of a model request. Messages already known are
   * ignored, so repeated requests do not duplicate history. Returns the
   * transcript after the append.
   */
  append(sessionID: string, entries: StoredMessage[]): SessionTranscript {
    const transcript = this.read(sessionID)
    const fresh = entries.filter((entry) => !transcript.indexById.has(entry.id))
    if (fresh.length === 0) return transcript

    mkdirSync(this.dirFor(sessionID), { recursive: true })
    const lines = fresh
      .map((entry) => JSON.stringify(entry))
      .join("\n")
    appendFileSync(this.path(sessionID), lines + "\n")

    for (const entry of fresh) {
      transcript.messages.push(entry)
      transcript.indexById.set(entry.id, entry.index)
      for (const call of collectToolCalls(entry.message)) {
        if (!transcript.callsById.has(call.id)) transcript.callsById.set(call.id, { name: call.name, input: call.input })
      }
    }
    transcript.version++
    this.touch(sessionID, transcript)
    return transcript
  }

  /** Read a session's transcript from disk (cached in memory). */
  read(sessionID: string): SessionTranscript {
    const cached = this.cache.get(sessionID)
    if (cached) {
      this.touch(sessionID, cached)
      return cached
    }

    const transcript: SessionTranscript = {
      messages: [],
      indexById: new Map(),
      callsById: new Map(),
      ignoredIds: new Set(),
      version: 0,
    }
    const path = this.path(sessionID)
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf8")
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as StoredMessage
            if (!entry?.id) continue
            transcript.messages.push(entry)
            transcript.indexById.set(entry.id, entry.index)
            for (const call of collectToolCalls(entry.message)) {
              if (!transcript.callsById.has(call.id)) {
                transcript.callsById.set(call.id, { name: call.name, input: call.input })
              }
            }
          } catch {
            // Skip a corrupt line rather than losing the whole transcript.
          }
        }
      }
    } catch {
      // An unreadable transcript is an empty transcript.
    }

    this.touch(sessionID, transcript)
    return transcript
  }

  /** The next session-global index for a session. */
  nextIndex(sessionID: string): number {
    const transcript = this.read(sessionID)
    return transcript.messages.length + 1
  }

  /** Rough token cost of a message, used for the memory budgets. */
  estimateTokens(message: Message): number {
    return Math.ceil(JSON.stringify(message.content ?? "").length / CHARS_PER_TOKEN)
  }

  /**
   * Clip a stored message to the per-message size cap.
   *
   * A single tool result can be enormous (`cat` of a large file), and one of
   * those would otherwise dominate the store.
   */
  clipMessage(message: Message): Message {
    const limit = this.maxMessageChars
    const clipText = (text: string) =>
      text.length <= limit ? text : `${text.slice(0, limit)}…[clipped ${text.length - limit} chars]`

    // A shell execution carries its output beside the command.
    if (message.role === "bashExecution") {
      const output = (message as { output?: string }).output ?? ""
      if (output.length <= limit) return message
      return { ...message, output: clipText(output) }
    }

    // A tool result carries its output as the message content.
    if (message.role === "toolResult") {
      const text = (message as { content?: unknown }).content
      if (typeof text !== "string" || text.length <= limit) return message
      return { ...message, content: clipText(text) }
    }

    const content = message.content
    if (typeof content === "string") {
      if (content.length <= limit) return message
      return { ...message, content: clipText(content) }
    }
    if (!Array.isArray(content)) return message
    let size = 0
    let clipped = false
    const parts = content.map((part) => {
      if (clipped) return part
      const text = (part as { text?: unknown }).text
      const length = typeof text === "string" ? text.length : 0
      if (size + length <= limit) {
        size += length
        return part
      }
      clipped = true
      if (length <= 0) return part
      const room = Math.max(0, limit - size)
      return { ...part, text: `${String(text).slice(0, room)}…[clipped ${length - room} chars]` }
    })
    if (!clipped) return message
    return { ...message, content: parts }
  }

  /**
   * Delete transcripts that have not been modified for `olderThanMs`.
   *
   * The transcript duplicates what OpenCode already stores in the session
   * record, so expiring it costs only the searchable index — not the
   * conversation itself.
   */
  sweep(olderThanMs: number, now = Date.now()): number {
    return TranscriptStore.sweepDir(this.dirFor(""), olderThanMs, now)
  }

  /** Sweep one directory of transcript files. */
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
