/**
 * The handoff block: the narrative half of a checkpoint.
 *
 * vcc's sections are an inventory - goals, files, commits. OpenCode's own
 * summarizer is asked for something else: decisions and why, what is done,
 * what is blocked, what happens next. That is the half a resumed session
 * misses, and no deterministic extractor can invent it.
 *
 * So compaction spends one model call on exactly that block. The
 * deterministic sections are still built and still win when the call fails:
 * the block is additive, never a dependency. When the model is unreachable,
 * `fallbackHandoff` derives the little that can be derived without one - the
 * work state, and the question the session ended on.
 */
import type { ModelRef } from "../config"

export const HANDOFF_HEADINGS = ["Decisions", "Work State", "Next Move", "Important Context"] as const
export type HandoffHeading = (typeof HANDOFF_HEADINGS)[number]

/** The separator vcc uses between sections, the brief and the recall note. */
const SEPARATOR = "\n\n---\n\n"

export interface HandoffPromptInput {
  /** The checkpoint this window follows, when the request started with one. */
  previousSummary?: string
  /** The deterministic sections already extracted from this window. */
  sections: string
  /** The rendered conversation. */
  window: string
}

/**
 * The prompt.
 *
 * Deliberately close to OpenCode's own summary template: the point is to
 * recover the sections its summarizer produces, not to invent a new shape.
 * The "never invent" and "carry forward" rules matter more than the wording:
 * a handoff that states a decision the session never made is worse than none.
 */
export const HANDOFF_PROMPT = `You are writing the part of a session checkpoint that a deterministic extractor cannot write.

The checkpoint replaces the conversation. A future assistant continues from it and cannot see the transcript, so anything you leave out is lost. Write the working knowledge: what was decided and why, where the work stands, what happens next, and the facts that are expensive to rediscover.

Reply with these sections and nothing else:

[Decisions]
- <what was decided> — <why, in a few words>

[Work State]
- Done: <finished work>
- Active: <work in progress>
- Blocked: <what is blocking, and why>

[Next Move]
1. <the next concrete action>

[Important Context]
- <a fact the next assistant cannot continue without>

Rules:
- Terse, single-line bullets. No prose paragraphs, no nested lists.
- Only what the conversation supports. Never invent a decision, a reason or a result.
- Keep exact file paths, symbols, commands, error strings, URLs and identifiers.
- Carry forward anything unresolved from the previous checkpoint, and keep the user's exact wording for user constraints.
- If a section has nothing, write "(none)".
- At most 6 bullets per section.`

interface Part {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  output?: unknown
  state?: { input?: unknown; output?: unknown; content?: unknown; status?: string }
}

interface Message {
  role?: string
  content?: unknown
}

const partsOf = (message: Message): Part[] => {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }]
  return Array.isArray(message.content) ? (message.content as Part[]) : []
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

const outputText = (part: Part): string => {
  const output = part.output ?? part.state?.output ?? part.state?.content
  if (typeof output === "string") return output
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((item) =>
          typeof item === "string" ? item : typeof (item as { text?: unknown })?.text === "string" ? (item as { text: string }).text : "",
        )
        .filter(Boolean)
        .join("\n")
    }
    try {
      return JSON.stringify(output)
    } catch {
      return ""
    }
  }
  return ""
}

const inputText = (part: Part): string => {
  const input = part.input ?? part.state?.input
  if (typeof input === "string") return clip(input, 200)
  if (input && typeof input === "object") {
    const command = (input as { command?: unknown; cmd?: unknown }).command ?? (input as { cmd?: unknown }).cmd
    if (typeof command === "string") return clip(command, 200)
    try {
      return clip(JSON.stringify(input), 200)
    } catch {
      return ""
    }
  }
  return ""
}

/**
 * Render a conversation for the handoff prompt.
 *
 * Text only, with tool traffic clipped: the model needs to see what was
 * decided, not the contents of every file it read. When the window does not
 * fit, the middle is dropped rather than the end - the opening states the
 * task, the tail states where it stands.
 */
export const renderWindow = (messages: readonly unknown[], maxChars: number): string => {
  const lines: string[] = []
  for (const raw of messages) {
    const message = raw as Message
    if (!message || typeof message !== "object") continue
    const role = message.role ?? "user"
    const rendered: string[] = []
    for (const part of partsOf(message)) {
      const type = part?.type ?? ""
      if (type === "text" && typeof part.text === "string") {
        const text = part.text.trim()
        if (text.length > 0) rendered.push(role === "user" ? `[User]: ${clip(text, 1_200)}` : `[Assistant]: ${clip(text, 800)}`)
        continue
      }
      if (type === "reasoning") continue
      if (type === "tool-call" || type === "toolCall") {
        rendered.push(`[Tool call]: ${part.name ?? "tool"}(${inputText(part)})`)
        continue
      }
      if (type === "tool-result" || type === "toolResult") {
        const text = outputText(part)
        if (text.length > 0) rendered.push(`[Tool result]: ${clip(text, 300)}`)
      }
    }
    if (rendered.length > 0) lines.push(rendered.join("\n"))
  }

  const text = lines.join("\n")
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.35)
  const tail = Math.max(0, maxChars - head)
  return `${text.slice(0, head)}\n[... middle of the conversation omitted ...]\n${text.slice(text.length - tail)}`
}

export const buildHandoffPrompt = (input: HandoffPromptInput): string => {
  const parts = [HANDOFF_PROMPT]
  if (input.previousSummary && input.previousSummary.trim().length > 0) {
    parts.push(`PREVIOUS CHECKPOINT\n${input.previousSummary.trim()}`)
  }
  if (input.sections.trim().length > 0) {
    parts.push(`SECTIONS ALREADY EXTRACTED (reuse their facts; do not restate the file list)\n${input.sections.trim()}`)
  }
  parts.push(`CONVERSATION\n${input.window}`)
  return parts.join("\n\n")
}

/**
 * Keep only the four sections, drop the ones the model left empty, and trim
 * to the budget. Returns undefined when nothing usable came back, so the
 * caller can fall back instead of writing an empty block.
 */
export const cleanHandoff = (text: string, maxChars: number): string | undefined => {
  const body = text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "")
  const lines = body.split("\n")

  const sections = new Map<HandoffHeading, string[]>()
  let current: HandoffHeading | undefined
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) {
      const name = HANDOFF_HEADINGS.find((heading) => heading.toLowerCase() === header[1].trim().toLowerCase())
      if (name) {
        current = name
        sections.set(name, [])
      } else if (current) {
        // Some other heading ends the block; do not swallow the rest.
        current = undefined
      }
      continue
    }
    if (!current) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (/^(?:[-*]\s*)?\(none\)$/i.test(trimmed)) continue
    sections.get(current)!.push(trimmed)
  }

  const kept = HANDOFF_HEADINGS.filter((heading) => (sections.get(heading)?.length ?? 0) > 0)
  if (kept.length === 0) return undefined

  const render = (headings: readonly HandoffHeading[]) =>
    headings.map((heading) => `[${heading}]\n${(sections.get(heading) ?? []).join("\n")}`).join("\n\n")

  let selected = [...kept]
  let block = render(selected)
  // Trim from the last section backwards, one bullet at a time.
  while (block.length > maxChars && selected.length > 0) {
    const last = selected[selected.length - 1]
    const bullets = sections.get(last)!
    bullets.pop()
    if (bullets.length === 0) selected = selected.slice(0, -1)
    block = render(selected)
  }
  return block.length > 0 ? block : undefined
}

/** The four headings the handoff block owns. */
const HANDOFF_START = /(?:^|\n)\[(?:Decisions|Work State|Next Move|Important Context)\][ \t]*(?=\n|$)/

/**
 * Remove a handoff block from a checkpoint.
 *
 * The block is not one of the sections the vcc merge knows, and `insertBlock`
 * puts it before the `---`. Without this it is swallowed by whichever section
 * comes last (usually `[User Preferences]`), and the next merge carries that
 * section forward verbatim while a fresh block is appended - one block per
 * compaction, each repeating the one before it.
 */
export const stripHandoff = (summary: string): string => {
  const index = summary.indexOf(SEPARATOR)
  const head = index < 0 ? summary : summary.slice(0, index)
  const rest = index < 0 ? "" : summary.slice(index)
  const match = HANDOFF_START.exec(head)
  if (!match) return summary
  return `${head.slice(0, match.index).trimEnd()}${rest}`
}

/**
 * Put the block at the end of the deterministic sections, before the brief
 * and the recall note, so a reader meets the inventory first and the
 * narrative second.
 *
 * A block left by an earlier checkpoint is replaced, never stacked: the new
 * block is the whole narrative, and the model has the old one as input.
 */
export const insertBlock = (summary: string, block: string): string => {
  if (!block.trim()) return summary
  const base = stripHandoff(summary)
  const index = base.indexOf(SEPARATOR)
  if (index < 0) return `${base}\n\n${block}`
  return `${base.slice(0, index)}\n\n${block}${base.slice(index)}`
}

/**
 * Resolve with the promise, or with undefined once the deadline passes.
 *
 * Compaction blocks the session, so a model that never answers must not hold
 * it hostage: the deterministic summary is always a valid checkpoint.
 */
export const withTimeout = async <T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> => {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ fallback

export interface FallbackInput {
  /** The deterministic summary, used for its commits and file list. */
  summary: string
  /** The conversation, used for the last command and the closing question. */
  messages: readonly unknown[]
  /** The previous checkpoint. Its decisions are carried, never invented. */
  previousSummary?: string
}

const FALLBACK_SECTION_MAX = 900

const clampSection = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.lastIndexOf("\n", max)
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, max)).trimEnd()
}

const sectionBody = (summary: string, name: string): string => {
  const start = summary.indexOf(`[${name}]`)
  if (start < 0) return ""
  const rest = summary.slice(start + name.length + 2)
  const next = rest.search(/\n\[[A-Z]/)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}

const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "exec_command", "run_command"])

const lastCommand = (messages: readonly unknown[]): { command: string; exit?: number } | undefined => {
  let found: { command: string; exit?: number } | undefined
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as Message
    for (const part of partsOf(message)) {
      if (part?.type !== "tool-call" && part?.type !== "toolCall") continue
      if (!COMMAND_TOOLS.has(String(part.name ?? ""))) continue
      const input = part.input ?? part.state?.input
      const command =
        typeof input === "string"
          ? input
          : typeof (input as { command?: unknown })?.command === "string"
            ? String((input as { command: string }).command)
            : typeof (input as { cmd?: unknown })?.cmd === "string"
              ? String((input as { cmd: string }).cmd)
              : ""
      if (!command) continue
      found = { command: clip(command, 120) }
      // The matching result usually follows in the same or the next message.
      for (let j = i + 1; j < messages.length && j <= i + 3; j++) {
        for (const result of partsOf(messages[j] as Message)) {
          const output = (result.output ?? result.state?.output) as { metadata?: { exit?: number } } | undefined
          const exit = output?.metadata?.exit
          if (typeof exit === "number") found.exit = exit
        }
      }
    }
  }
  return found
}

const closingAsk = (messages: readonly unknown[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Message
    if (message?.role !== "assistant") continue
    const texts = partsOf(message)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
    if (texts.length === 0) continue
    const last = texts[texts.length - 1].split("\n").filter(Boolean).pop() ?? ""
    if (last.length < 8 || last.length > 300) continue
    if (/[?]$/.test(last) || /(want me to|should i|shall i|let me know|next step|say the word)/i.test(last)) {
      return clip(last, 240)
    }
    return undefined
  }
  return undefined
}

/**
 * What can be said about the handoff without a model.
 *
 * Only two things are honest here: the work state, which is already recorded
 * (commits, modified files, the last command), and the question the session
 * ended on. There is no deterministic way to recover a decision or its
 * reason, so this block never claims one.
 */
export const fallbackHandoff = (input: FallbackInput): string | undefined => {
  const parts: string[] = []

  // A decision that was already recorded is not invented by repeating it.
  // Without this a failed model call would drop the whole narrative, because
  // the merge no longer keeps the previous block in the sections.
  const prevHead = (input.previousSummary ?? "").split(SEPARATOR)[0]
  const decisions = clampSection(sectionBody(prevHead, "Decisions"), FALLBACK_SECTION_MAX)
  if (decisions) parts.push(`[Decisions]\n${decisions}`)

  const lines: string[] = []

  const files = sectionBody(input.summary, "Files And Changes")
  const modified = files.split("\n").find((line) => /^-?\s*Modified:/.test(line))
  if (modified) {
    const count = (modified.match(/,\s/g)?.length ?? 0) + 1
    const more = /\+(\d+) more/.exec(modified)
    const total = count + (more ? Number(more[1]) : 0)
    lines.push(`- Modified: ${total} file${total === 1 ? "" : "s"}`)
  }

  const commits = sectionBody(input.summary, "Commits")
    .split("\n")
    .filter((line) => line.trim().startsWith("-"))
    .slice(-2)
  if (commits.length > 0) lines.push(`- Commits: ${commits.map((line) => line.replace(/^\s*-\s*/, "").trim()).join("; ")}`)

  const command = lastCommand(input.messages)
  if (command) {
    lines.push(`- Last command: \`${command.command}\`${typeof command.exit === "number" ? ` (exit ${command.exit})` : ""}`)
  }

  if (lines.length > 0) parts.push(`[Work State]\n${lines.join("\n")}`)

  const ask = closingAsk(input.messages)
  if (ask) parts.push(`[Next Move]\n- ${ask}`)

  const important = clampSection(sectionBody(prevHead, "Important Context"), FALLBACK_SECTION_MAX)
  if (important) parts.push(`[Important Context]\n${important}`)

  return parts.length > 0 ? parts.join("\n\n") : undefined
}
