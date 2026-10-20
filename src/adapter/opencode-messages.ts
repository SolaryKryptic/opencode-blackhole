/**
 * OpenCode → vcc message adapter.
 *
 * OpenCode's model-request messages are AI-SDK style: `{ role, content: Part[] }`
 * where a part is `text`, `reasoning`, `tool-call` or `tool-result`. The vcc
 * core expects Pi's shape: `{ role, content: string | Part[] }` with
 * `toolCall` parts, a `toolResult` role and a `bashExecution` role that
 * carries a command and its output together.
 *
 * This adapter is the only place that knows about OpenCode's message format.
 */
import type { ContentPart, Message, ToolCall } from "../vcc/pi-types"

interface OpenCodePart {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  output?: unknown
  toolCallId?: string
  mimeType?: string
  state?: { status?: string; output?: unknown; content?: unknown }
}

interface OpenCodeMessage {
  id?: string
  role: string
  content?: unknown
}

/** A tool call, kept so a later tool result can be paired with its call. */
export interface ToolCallInfo {
  name: string
  input: Record<string, unknown>
}

export interface AdaptedMessages {
  messages: Message[]
  /**
   * Session-global index per adapted message, parallel to `messages`.
   * `undefined` means the message has no stable index yet.
   */
  sourceIndices: Array<number | undefined>
  /** The previous compaction's summary, when the request starts with a checkpoint. */
  previousSummary?: string
  /** The previous compaction's verbatim tail, when present. */
  previousRecent?: string
  /** The tool calls known after this batch — pass the map in, get it back. */
  calls: Map<string, ToolCallInfo>
}

export interface AdaptOptions {
  /**
   * Tool calls already known for the session.
   *
   * The adapter is called with only the *new* messages of a request, so a
   * tool result whose call was captured in an earlier request needs the call
   * to be supplied from here.
   */
  calls?: Map<string, ToolCallInfo>
  /** Resolve the session-global index of a message id. */
  resolveIndex?: (id: string) => number | undefined
}

/**
 * OpenCode tool names → Pi tool names the vcc core knows about.
 *
 * The core matches on Pi's vocabulary (`bash` for shell execution,
 * `apply_patch` for multi-file edits) to decide what is a file read, a file
 * write, or a shell command worth ranking.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  shell: "bash",
  bash: "bash",
  patch: "apply_patch",
  apply_patch: "apply_patch",
  multiedit: "multiedit",
  write: "write",
  edit: "edit",
  read: "read",
  view: "read",
  glob: "glob",
  grep: "grep",
  list: "list",
  todowrite: "todowrite",
  webfetch: "webfetch",
  websearch: "websearch",
}

const mapToolName = (name: string): string => TOOL_NAME_MAP[name.toLowerCase()] ?? name

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const p = part as OpenCodePart
      if (p?.type === "text" && typeof p.text === "string") return p.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

const partsOf = (message: OpenCodeMessage): OpenCodePart[] => {
  const raw = message.content
  if (typeof raw === "string") return [{ type: "text", text: raw }]
  if (!Array.isArray(raw)) return []
  return raw as OpenCodePart[]
}

/** Tool result payloads arrive as a string or as `{ content, metadata }`. */
const toolResultText = (part: OpenCodePart): string => {
  const output = part.output ?? part.state?.output ?? part.state?.content
  if (typeof output === "string") return output
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") return item
          if (item && typeof item === "object") {
            const text = (item as { text?: unknown }).text
            if (typeof text === "string") return text
          }
          return ""
        })
        .filter(Boolean)
        .join("\n")
    }
    try {
      return JSON.stringify(output)
    } catch {
      return ""
    }
  }
  return textOf(part.output)
}

const exitCodeOf = (part: OpenCodePart): number | undefined => {
  const output = part.output ?? part.state?.output
  if (output && typeof output === "object") {
    const metadata = (output as { metadata?: { exit?: number } }).metadata
    if (typeof metadata?.exit === "number") return metadata.exit
  }
  return undefined
}

const CHECKPOINT_OPEN = "<conversation-checkpoint>"
const CHECKPOINT_CLOSE = "</conversation-checkpoint>"

/** Parse OpenCode's checkpoint wrapper (a completed compaction message). */
const parseCheckpoint = (text: string): { summary?: string; recent?: string } | undefined => {
  if (!text.includes(CHECKPOINT_OPEN) || !text.includes(CHECKPOINT_CLOSE)) return undefined
  const summary = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(text)?.[1]
  const recent = /<recent-context>\n?([\s\S]*?)\n?<\/recent-context>/.exec(text)?.[1]
  return { summary, recent }
}

/**
 * Convert OpenCode messages into the vcc core's message shape.
 *
 * Shell executions are folded back into Pi's `bashExecution` role so the core's
 * shell-aware ranking, commit extraction and tracked-command extraction all
 * keep working.
 */
export const adaptMessages = (
  messages: readonly OpenCodeMessage[],
  options: AdaptOptions = {},
): AdaptedMessages => {
  const resolveIndex = options.resolveIndex
  // The call map persists across requests, so a result can be paired with a
  // call that was captured earlier in the session.
  const calls = options.calls ?? new Map<string, ToolCallInfo>()

  // Pass 1: index tool calls so results can be paired with their call.
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of partsOf(message)) {
      if (part.type !== "tool-call" || !part.id) continue
      if (calls.has(part.id)) continue
      calls.set(part.id, {
        name: mapToolName(part.name ?? "tool"),
        input:
          part.input && typeof part.input === "object"
            ? (part.input as Record<string, unknown>)
            : {},
      })
    }
  }

  const out: Message[] = []
  const sourceIndices: Array<number | undefined> = []
  let previousSummary: string | undefined
  let previousRecent: string | undefined

  const push = (message: Message, id?: string) => {
    out.push(id ? { ...message, id } : message)
    sourceIndices.push(id && resolveIndex ? resolveIndex(id) : undefined)
  }
  for (const message of messages) {
    const parts = partsOf(message)

    if (message.role === "user") {
      const text = textOf(message.content)
      const checkpoint = parseCheckpoint(text)
      if (checkpoint) {
        previousSummary = checkpoint.summary
        previousRecent = checkpoint.recent
        continue
      }
      const content: ContentPart[] = []
      for (const part of parts) {
        if (part.type === "text" && part.text) content.push({ type: "text", text: part.text })
      }
      if (content.length > 0) push({ role: "user", content }, message.id)
      continue
    }

    if (message.role === "assistant") {
      const content: ContentPart[] = []
      for (const part of parts) {
        if (part.type === "text" && part.text) content.push({ type: "text", text: part.text })
        else if (part.type === "tool-call") {
          const call = calls.get(part.id ?? "")
          content.push({
            type: "toolCall",
            id: part.id ?? "",
            name: call?.name ?? mapToolName(part.name ?? "tool"),
            arguments: call?.input ?? {},
          })
        }
      }
      if (content.length > 0) push({ role: "assistant", content }, message.id)
      continue
    }

    if (message.role === "tool") {
      let seen = 0
      for (const part of parts) {
        if (part.type !== "tool-result") continue
        const call = calls.get(part.toolCallId ?? "")
        const name = call?.name ?? mapToolName(part.name ?? "tool")
        const text = toolResultText(part)
        // One OpenCode tool message can carry several results; keep a stable
        // id per result so the transcript store can index them separately.
        const id = seen === 0 ? message.id : `${message.id}~${part.toolCallId ?? seen}`
        seen++
        if (name === "bash") {
          push(
            {
              role: "bashExecution",
              command: typeof call?.input.command === "string" ? (call.input.command as string) : "",
              output: text,
              exitCode: exitCodeOf(part),
            },
            id,
          )
        } else {
          push({ role: "toolResult", toolName: name, content: text }, id)
        }
      }
      continue
    }
  }

  return { messages: out, sourceIndices, previousSummary, previousRecent, calls }
}
