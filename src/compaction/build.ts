/**
 * Deterministic summary construction for OpenCode's compaction hook.
 *
 * The vcc core produces the summary; this module adapts OpenCode's messages,
 * sizes the brief transcript against a token budget, and enforces the safety
 * valve: if the extraction yields nothing useful, we return no result at all
 * so OpenCode falls back to its own summarizer.
 */
import { adaptMessages } from "../adapter/opencode-messages"
import { stripHandoff } from "./handoff"
import { compileRanked } from "../vcc/core/summarize"
import {
  calibrateCharsPerToken,
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokensFromChars,
} from "../vcc/core/token-estimate"
import type { FileOps } from "../vcc/types"

export interface BuildSummaryInput {
  /** The compaction hook's request messages. */
  messages: readonly unknown[]
  /** Session-global index resolver, keyed by OpenCode message id. */
  resolveIndex?: (id: string) => number | undefined
  /**
   * Authoritative file activity for the whole session. OpenCode keeps the
   * newest exchange out of the summarization request (it is retained
   * verbatim), so files touched there are only known from the transcript.
   */
  fileOps?: FileOps
  /** Token budget for the brief transcript. */
  briefTokens: number
  /** Hard cap for the whole summary. */
  maxSummaryTokens: number
  /** Extra note appended to the summary (project conventions, etc.). */
  extraNote?: string
}

export interface BuildSummaryResult {
  summary?: string
  /** Estimated size of the summary, in tokens. */
  tokens?: number
  /** The previous checkpoint's summary, when the request started with one. */
  previousSummary?: string
  /** True when the previous checkpoint was reused because nothing new was in the window. */
  carried?: boolean
  /** Why the summary was rejected, when it was. */
  rejected?: string
}

const SECTION_MARKERS = ["[Session Goal]", "[Files And Changes]", "[Commits]", "[Outstanding Context]"]
const SEPARATOR = "\n\n---\n\n"

/**
 * The vcc core ends every summary with a recall hint naming Pi's `vcc_recall`
 * tool. We keep the vendored core pristine so upstream stays mergeable, and
 * rewrite the hint here to name OpenCode's tool.
 */
const RECALL_TOOL = "blackhole_recall"
const rewriteRecallNote = (summary: string): string => summary.replace(/`vcc_recall`/g, "`" + RECALL_TOOL + "`")

/**
 * Split a compiled summary into three parts: the section headers, the brief
 * transcript and the trailing recall note.
 *
 * The vcc format is `sections --- brief --- note`, and the separator appears
 * once or twice depending on whether there were sections.
 */
const splitSummary = (summary: string): { head: string; brief: string; note: string } => {
  let body = summary
  let note = ""

  const noteIndex = body.lastIndexOf(SEPARATOR)
  if (noteIndex >= 0) {
    const tail = body.slice(noteIndex + SEPARATOR.length)
    if (tail.includes("recall")) {
      note = tail.trim()
      body = body.slice(0, noteIndex).trim()
    }
  }

  const index = body.indexOf(SEPARATOR)
  if (index < 0) {
    const startsWithSection = SECTION_MARKERS.some((marker) => body.trimStart().startsWith(marker))
    return startsWithSection ? { head: body.trim(), brief: "", note } : { head: "", brief: body.trim(), note }
  }
  return {
    head: body.slice(0, index).trim(),
    brief: body.slice(index + SEPARATOR.length).trim(),
    note,
  }
}

/**
 * Trim a section's bullet list to fit a character budget, dropping the
 * oldest lines first (the brief transcript is the only part that can grow
 * without bound).
 */
const trimToChars = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  const lines = text.split("\n")
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (size + line.length + 1 > maxChars) break
    kept.unshift(line)
    size += line.length + 1
  }
  if (kept.length > 0) return kept.join("\n")
  // The last line alone is over budget: cut it instead of dropping it.
  const last = lines[lines.length - 1] ?? ""
  return last.slice(0, Math.max(0, maxChars))
}

/**
 * Trim a summary's header sections to fit a character budget.
 *
 * Section headers are kept (they carry the structure); the bullet lists under
 * them give way first, oldest lines first, so the most recent facts survive.
 */
const trimSections = (head: string, maxChars: number): string => {
  if (head.length <= maxChars) return head
  const lines = head.split("\n")
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    const isHeader = line.startsWith("[")
    const cost = line.length + 1
    if (!isHeader && size + cost > maxChars) continue
    if (isHeader && size + cost > maxChars) break
    kept.push(line)
    size += cost
  }
  return kept.join("\n").trim()
}

export const buildSummary = (input: BuildSummaryInput): BuildSummaryResult => {
  const { messages, resolveIndex, fileOps, briefTokens, maxSummaryTokens, extraNote } = input
  if (!Array.isArray(messages) || messages.length === 0) return { rejected: "no messages" }

  const adapted = adaptMessages(messages as any[], { resolveIndex })
  // A compaction request can carry the previous checkpoint and nothing else:
  // the window since the last compaction held no new text. That is not an
  // empty conversation - the checkpoint *is* the conversation now. Upstream
  // merges the checkpoint's sections in this case; declining it hands the
  // compaction back to OpenCode's own summarizer, which is the one thing
  // this plugin exists to prevent.
  const previous = adapted.previousSummary?.trim()
  if (adapted.messages.length === 0 && !previous) return { rejected: "no conversation content" }

  // Chars-per-token: heuristic unless the caller can calibrate. OpenCode does
  // not expose the last request's token usage to plugins, so we use the
  // conservative default and let the token cap do the real work.
  const charsPerToken = DEFAULT_CHARS_PER_TOKEN

  // A request that carries only the previous checkpoint has nothing new to
  // summarise. Rebuilding it from its own sections was both wasteful and the
  // source of the stacked handoff blocks: the rebuilt checkpoint looked like
  // "fresh" content, so the hook appended another block every time.
  if (adapted.messages.length === 0 && previous) {
    const carried = rewriteRecallNote(previous)
    return {
      summary: carried,
      tokens: estimateTokensFromChars(carried.length, charsPerToken),
      previousSummary: adapted.previousSummary,
      carried: true,
    }
  }
  // 0 (or less) means no brief at all: do not pay for a floor the caller
  // explicitly turned off.
  const briefChars = briefTokens <= 0 ? 0 : Math.max(400, Math.round(briefTokens * charsPerToken))

  let summary = compileRanked({
    messages: adapted.messages,
    sourceIndices: adapted.sourceIndices,
    // The handoff block is not a section: strip it before merging so a
    // section that has no fresh counterpart cannot carry the whole block
    // forward verbatim. The raw checkpoint still goes to the handoff prompt.
    previousSummary: previous ? stripHandoff(previous) : undefined,
    fileOps,
    ranking: {
      maxBriefChars: briefChars,
      maxBriefCharsCeiling: Math.round(briefChars * 1.5),
      briefCharsPerBlock: Math.round(15 * charsPerToken),
      maxBlocks: 64,
      // Upstream keeps the newest 16 blocks whatever their score
      // (rank.ts: `options.preserveRecentBlocks ?? DEFAULT_RECENT_BLOCKS`).
      // A smaller value lets older, higher-scoring blocks - bug reports and
      // diffs - crowd out the turns the brief exists to preserve.
      preserveRecentBlocks: 16,
    },
  })

  let { head, brief, note } = splitSummary(summary)
  if (briefTokens <= 0) brief = ""

  // Enforce the hard cap: the brief transcript is trimmed first, then the
  // section bullets, and only then is the summary rejected outright.
  const maxChars = Math.max(600, Math.round(maxSummaryTokens * charsPerToken))
  if (brief.length > 0) {
    const room = maxChars - head.length
    if (room <= 200) {
      brief = ""
    } else {
      brief = trimToChars(brief, room)
    }
  }

  const hasSections = SECTION_MARKERS.some((marker) => head.includes(marker))
  if (!hasSections && brief.length === 0) {
    // Nothing new to extract. The previous checkpoint still summarises the
    // conversation, so it is carried forward rather than paying a model to
    // rewrite it.
    if (previous) {
      const carried = rewriteRecallNote(previous)
      return {
        summary: carried,
        tokens: estimateTokensFromChars(carried.length, charsPerToken),
        previousSummary: adapted.previousSummary,
        carried: true,
      }
    }
    return { rejected: "extraction produced no usable content", previousSummary: adapted.previousSummary }
  }

  const assemble = (parts: string[]) => parts.filter((part) => part.length > 0).join(SEPARATOR)
  const withNote = (h: string, b: string) => rewriteRecallNote(assemble([h, b, note]))

  summary = withNote(head, brief)
  if (extraNote && extraNote.trim()) {
    summary = `${summary}\n\n${extraNote.trim()}`
  }

  let tokens = estimateTokensFromChars(summary.length, charsPerToken)
  if (tokens > maxSummaryTokens) {
    // Drop the recall note first, then the brief, then trim the section
    // bullets — the summary is only rejected when nothing usable is left.
    summary = rewriteRecallNote(assemble([head, brief]))
    tokens = estimateTokensFromChars(summary.length, charsPerToken)
    if (tokens > maxSummaryTokens && brief.length > 0) {
      summary = rewriteRecallNote(head)
      tokens = estimateTokensFromChars(summary.length, charsPerToken)
    }
    if (tokens > maxSummaryTokens) {
      const headerOnly = trimSections(head, maxChars)
      const headerTokens = estimateTokensFromChars(headerOnly.length, charsPerToken)
      if (headerTokens > maxSummaryTokens) {
        return { rejected: "summary exceeded the token cap", previousSummary: adapted.previousSummary }
      }
      summary = headerOnly
    }
    if (extraNote && extraNote.trim()) {
      summary = `${summary}\n\n${extraNote.trim()}`
    }
  }

  return {
    summary,
    tokens: estimateTokensFromChars(summary.length, charsPerToken),
    previousSummary: adapted.previousSummary,
  }
}

export { calibrateCharsPerToken }
