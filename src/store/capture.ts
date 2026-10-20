/**
 * Capture model requests into the session transcript.
 *
 * The plugin sees every request the agent loop makes, which is the cheapest
 * reliable way to see the whole conversation: OpenCode's plugin API only
 * exposes the compacted view of a session.
 *
 * Only the messages we have not seen before are adapted. A request carries
 * the whole conversation, so re-adapting it every turn would re-extract every
 * tool output's text again and again — quadratic in the size of the session.
 * Skipping known ids keeps capture linear in the amount of *new* content.
 */
import { adaptMessages } from "../adapter/opencode-messages"
import type { StoredMessage, TranscriptStore } from "./transcript"

interface RawMessage {
  id?: string
  role: string
  content?: unknown
}

const CHECKPOINT = "<conversation-checkpoint>"

/** A compaction checkpoint is a summary, not conversation — we never store it. */
const isCheckpoint = (message: RawMessage): boolean => {
  if (message.role !== "user") return false
  const content = message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (part) =>
      (part as { type?: string; text?: string })?.type === "text" &&
      typeof (part as { text?: string }).text === "string" &&
      (part as { text: string }).text.includes(CHECKPOINT),
  )
}

export const captureRequest = (
  store: TranscriptStore,
  sessionID: string,
  requestMessages: readonly unknown[],
): number => {
  if (!Array.isArray(requestMessages) || requestMessages.length === 0) return 0

  const transcript = store.read(sessionID)

  // Keep only what we have not seen before. A request carries the whole
  // conversation, so re-adapting it every turn would re-extract every tool
  // output's text again and again — quadratic in the size of the session.
  const fresh: RawMessage[] = []
  for (const message of requestMessages) {
    const raw = message as RawMessage
    if (!raw?.id) continue
    if (typeof raw.role !== "string") continue
    if (transcript.indexById.has(raw.id)) continue
    if (transcript.ignoredIds.has(raw.id)) continue
    if (isCheckpoint(raw)) {
      // Remember it so the next request does not rescan the summary.
      transcript.ignoredIds.add(raw.id)
      continue
    }
    fresh.push(raw)
  }
  if (fresh.length === 0) return 0

  // The call map persists across requests, so a tool result whose call was
  // captured earlier still resolves to its tool name and arguments.
  const adapted = adaptMessages(fresh, { calls: transcript.callsById })

  const entries: StoredMessage[] = []
  let index = transcript.messages.length + 1
  for (const message of adapted.messages) {
    if (!message.id) continue
    if (transcript.indexById.has(message.id)) continue
    const storedIndex = index++
    // The index rides on the message itself: the recall loader reads it there,
    // so the `#N` in a recall result is the same `#N` the summary refers to.
    const stored = { ...store.clipMessage(message), index: storedIndex }
    entries.push({ id: message.id, index: storedIndex, message: stored, tokens: store.estimateTokens(stored) })
  }

  if (entries.length === 0) return 0
  store.append(sessionID, entries)
  return entries.length
}
