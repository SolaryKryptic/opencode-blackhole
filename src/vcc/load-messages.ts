/**
 * In-memory session history loader.
 *
 * Upstream pi-vcc reads the session JSONL file from disk. OpenCode owns its
 * history in the server database and exposes it over the API, so the loader
 * here takes an already-materialized message list instead of a path.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (MIT) — Copyright (c) 2026
 * sting8k. See LICENSE.vendor in this package for the full text.
 */
import type { Message } from "./pi-types"
import { renderMessage, type RenderedEntry } from "./core/render-entries"

export interface LoadedMessages {
  rendered: RenderedEntry[]
  rawMessages: Message[]
}

/**
 * Render every message into the entry shape the summary and recall pipeline
 * consumes. `full` keeps the untruncated text (recall needs it); the summary
 * path uses the clipped variant.
 */
export const loadMessages = (messages: Message[], full = false): LoadedMessages => {
  const rendered: RenderedEntry[] = []
  const rawMessages: Message[] = []
  let messageIndex = 0

  for (const message of messages) {
    // System messages occupy an index but are not conversation content.
    if (message.role !== "system") {
      // A message that already carries a session-global index keeps it, so
      // recall's `#N` refs line up with the ones in a summary.
      const index = message.index ?? messageIndex
      rendered.push(renderMessage(message, index, full))
      rawMessages.push(message)
    }
    messageIndex++
  }

  return { rendered, rawMessages }
}
