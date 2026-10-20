/**
 * Minimal mirror of the `@earendil-works/pi-ai` message shape that the ported
 * vcc core depends on.
 *
 * The vcc core was written against Pi's message model. Rather than rewrite
 * its algorithms, the OpenCode adapter normalizes OpenCode messages into this
 * shape and the core runs unchanged.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (MIT) — Copyright (c) 2026
 * sting8k. See LICENSE.vendor in this package for the full text.
 */

export interface ToolCall {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image"
  mimeType: string
}

export type ContentPart = TextPart | ToolCall | ImagePart

export type MessageRole = "user" | "assistant" | "toolResult" | "bashExecution" | "system"

export interface Message {
  role: MessageRole
  /** OpenCode's message id, when the message came from a session. */
  id?: string
  /** Session-global index, matching the `#N` references in summaries. */
  index?: number
  content?: string | ContentPart[]
  /** Present on tool results. */
  toolName?: string
  /** Present on bash execution entries. */
  command?: string
  output?: string
  exitCode?: number
}

/** Pi persists `{ id, message }` entries; only the inner message is used here. */
export interface SessionMessageEntry {
  id: string
  message: Message
}
